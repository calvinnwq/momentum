/**
 * Run-level composition for a single live workflow step (NGX-334, M9-03).
 *
 * The M9-03 slice ships three primitives that are deliberately separate so each
 * stays a focused, independently testable unit:
 *
 *   - {@link runLiveWorkflowStep} (`live-step-orchestrator.ts`) drives the
 *     durable lease + step-state lifecycle around an executor. It is
 *     git-agnostic: it never touches the worktree.
 *   - {@link finalizeLiveWorkflowStepFromResultFile} (`live-step-finalize.ts`) is
 *     a pure git + verification transaction over the step's normalized result
 *     document. It owns no durable state.
 *   - {@link persistLiveWorkflowFinalizeRecovery} (`live-step-run-recovery.ts`)
 *     durably enters manual recovery (the `needs_manual_recovery` flag + per-run
 *     `recovery.md`) when the finalize transaction surfaces a recovery condition.
 *
 * This module is the seam that wires those three into the single managed-step
 * "advance" the M9 contract's "Git And Verification Transaction" section
 * describes, holding the caller's repo lock across the verification transaction:
 *
 *   runLiveWorkflowStep            (lease + approved->running->terminal lifecycle)
 *   -> finalizeLiveWorkflowStepFromResultFile  (verify -> commit / reset)
 *   -> persistLiveWorkflowFinalizeRecovery     (durable recovery on head/result)
 *
 * The git + verification transaction runs only when the managed step settled
 * into a clean terminal state from a *normalized* dispatch result —
 * `dispatch.ok === true` and the terminal step state was durably persisted
 * (`finish.ok === true`). That gate is the boundary between the two recovery
 * worlds M9 keeps distinct:
 *
 *   - A normalized dispatch (`ok: true`) means the runner produced a trustworthy
 *     result document: `success: true` commits the verified diff, `success:
 *     false` is the executed-but-failed path that resets. Re-reading that
 *     document at finalize time can still surface `result_missing` /
 *     `result_invalid` (a result lost or corrupted after dispatch) or a moved
 *     HEAD, which route to durable recovery instead of a destructive reset.
 *   - A process-level dispatch error (`ok: false`) already carries a precise
 *     live recovery code (`runtime_unavailable`, `auth_unavailable`,
 *     `command_failed`, `command_timed_out`, `output_overflow`, ...) on
 *     {@link RunLiveWorkflowStepOutcome.liveRecoveryCode}. Running the git
 *     transaction there would only re-classify it as a generic
 *     `result_missing`, masking the precise cause, so this seam leaves it to the
 *     run loop and never touches the worktree.
 *
 * Likewise, a step that never settled (a start refusal, or an ambiguous
 * in-flight finish where the lease was intentionally left outstanding) is not
 * finalized: there is no trustworthy terminal state and the repo lock may have
 * been lost, so mutating git would be unsafe. Those outcomes are returned
 * verbatim for the monitor / recovery layer.
 *
 * This module owns no durable state of its own; it only composes the three
 * primitives. The durable mutations stay inside the orchestrator (step / lease)
 * and the recovery seam (run flag + artifact).
 */

import type { MomentumDb } from "./db.js";
import {
  finalizeLiveWorkflowStepFromResultFile,
  type FinalizeLiveWorkflowStepFromResultFileResult
} from "./live-step-finalize.js";
import {
  runLiveWorkflowStep,
  type LiveWorkflowStepLeaseKind,
  type RunLiveWorkflowStepOutcome
} from "./live-step-orchestrator.js";
import {
  persistLiveWorkflowFinalizeRecovery,
  type PersistLiveWorkflowFinalizeRecoveryResult
} from "./live-step-run-recovery.js";
import type { WorkflowLeaseStalePolicy } from "./workflow-run-reducer.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorInput
} from "./workflow-step-executor.js";

export type AdvanceLiveWorkflowStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Lease holder identity (e.g. the worker / process id). */
  holder: string;
  /** Absolute ms timestamp at which the managed-step lease expires. */
  leaseExpiresAt: number;
  /** The executor to run (an M9 live wrapper, or a fake in tests). */
  executor: WorkflowStepExecutor;
  /** The executor input forwarded to the orchestrator after identity validation. */
  executorInput: WorkflowStepExecutorInput;
  /** Lease kind to take; forwarded to the orchestrator's default when unset. */
  leaseKind?: LiveWorkflowStepLeaseKind;
  /** Stale policy for the acquired lease; forwarded to the orchestrator default. */
  stalePolicy?: WorkflowLeaseStalePolicy;
  /** The HEAD the live step started from; finalize commits onto / resets to it. */
  baseHead: string;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  /**
   * Directory under which the run-scoped `recovery.md` is rendered when the
   * finalize transaction enters durable recovery.
   */
  agentWorkflowsDir: string;
  /** Override the recovery artifact directory; forwarded to the recovery seam. */
  artifactRunDir?: string;
  /** Deterministic clock for stamping; defaults to `Date.now()` in each primitive. */
  now?: number;
};

export type AdvanceLiveWorkflowStepResult = {
  /** True only when the step ran, verified, and the diff was committed. */
  committed: boolean;
  /**
   * True when the git + verification transaction ran (the step settled into a
   * clean terminal state from a normalized dispatch result). When false, the
   * orchestrator outcome alone explains why no transaction ran.
   */
  finalized: boolean;
  /** The managed-step orchestration outcome (always present). */
  run: RunLiveWorkflowStepOutcome;
  /** The git + verification transaction outcome; present iff `finalized`. */
  finalize?: FinalizeLiveWorkflowStepFromResultFileResult;
  /** The durable recovery reconciliation outcome; present iff `finalized`. */
  recovery?: PersistLiveWorkflowFinalizeRecoveryResult;
};

/**
 * Advance one managed live workflow step: orchestrate its execution, then run
 * the git + verification transaction and durable recovery for a cleanly
 * dispatched terminal step. See the module doc for the ordered contract and the
 * gate that decides when the git transaction runs.
 */
export function advanceLiveWorkflowStep(
  input: AdvanceLiveWorkflowStepInput
): AdvanceLiveWorkflowStepResult {
  const run = runLiveWorkflowStep({
    db: input.db,
    runId: input.runId,
    stepId: input.stepId,
    holder: input.holder,
    leaseExpiresAt: input.leaseExpiresAt,
    executor: input.executor,
    executorInput: input.executorInput,
    ...(input.leaseKind !== undefined ? { leaseKind: input.leaseKind } : {}),
    ...(input.stalePolicy !== undefined
      ? { stalePolicy: input.stalePolicy }
      : {}),
    ...(input.now !== undefined ? { now: input.now } : {})
  });

  // The git + verification transaction runs only for a step that settled into a
  // clean terminal state from a normalized dispatch result. A process-level
  // dispatch error already carries a precise live recovery code, and an
  // unsettled finish leaves an ambiguous repo lock — neither is safe to mutate.
  const dispatch = run.dispatch;
  if (dispatch === undefined || !dispatch.ok || run.finish?.ok !== true) {
    return { committed: false, finalized: false, run };
  }

  const finalize = finalizeLiveWorkflowStepFromResultFile({
    repoPath: input.executorInput.repoPath,
    baseHead: input.baseHead,
    resultFilePath: dispatch.resultJsonPath,
    verificationCommands: input.verificationCommands,
    verificationTimeoutSec: input.verificationTimeoutSec,
    verificationLogPath: input.verificationLogPath
  });

  const recovery = persistLiveWorkflowFinalizeRecovery(input.db, {
    runId: input.runId,
    stepId: input.stepId,
    finalize,
    agentWorkflowsDir: input.agentWorkflowsDir,
    ...(input.artifactRunDir !== undefined
      ? { artifactRunDir: input.artifactRunDir }
      : {}),
    repoPath: input.executorInput.repoPath,
    ...(input.now !== undefined ? { now: input.now } : {})
  });

  return {
    committed: finalize.outcome === "committed",
    finalized: true,
    run,
    finalize,
    recovery
  };
}
