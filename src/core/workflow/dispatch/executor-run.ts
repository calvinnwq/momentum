/**
 * Dispatched-step execution path.
 *
 * The production dispatch lane is built from three landed halves that, before
 * this module, were never composed in production:
 *
 *   1. `dispatch/execute.ts` advances a claimed step `approved -> running`,
 *      creates the `<run>::<step>::dispatch` executor invocation (`running`) +
 *      first round (`pending`) start scaffold, and holds the dispatch lease.
 *   2. `dispatch/executor-terminalize.ts` records a finished
 *      {@link WorkflowStepExecutorDispatchResult} as terminal evidence on that
 *      scaffold's invocation / round (succeeded / failed, or manual_recovery for
 *      an unconfigured / process-level failure).
 *   3. `dispatch/reconcile-execute.ts` (the reconciliation seam) finalizes the owning
 *      `workflow_steps` row from that terminal invocation, exactly once.
 *
 * The remaining gap was the *producer* in the middle: nothing in production ran
 * the dispatched step's executor to yield the result step 2 consumes, so a
 * dispatched step stayed `running` forever (or only advanced under the
 * test/dogfood-only `dispatch/dogfood.ts` stand-in). This module owns that
 * producer and the composition:
 *
 *   run the dispatched step's executor (through the injected real registry)
 *     -> terminalize its result as durable evidence
 *     -> let the reconciliation seam finalize the step from that evidence.
 *
 * It deliberately takes the {@link WorkflowStepExecutorRegistry} by injection
 * rather than resolving a daemon-default live-wrapper profile itself: a configured
 * profile resolves a kind to a real live executor that spawns the local command;
 * an unconfigured registry resolves the kind to the honest
 * `runtime_unavailable` adapter so dispatch fails honestly into manual recovery
 * rather than fabricating a clean terminal. The `daemon start` lane owns
 * resolving the daemon-default profile source before calling this reusable,
 * registry-agnostic execution path.
 *
 * Boundary discipline (so the reconciliation seam stays the single finalization owner and the live-wrapper
 * direct-finalize lane is never double-finalized):
 *
 *   - It acts only when a `<run>::<step>::dispatch` invocation exists. A step
 *     finalized by a live wrapper (or never dispatched through the executor-loop lane)
 *     writes no such invocation, so this seam refuses it (`notDispatched`) and
 *     never runs an executor against it.
 *   - It never calls `finishWorkflowStep`, never writes `executor_invocations` /
 *     `executor_rounds` directly (the terminalize seam owns the scaffold rows),
 *     and never releases the dispatch lease (the reconciliation seam does, on terminal).
 *   - Idempotent on re-entry: once the dispatch invocation is terminal, a prior
 *     execution already ran the bounded session, so a re-entered tick NEVER
 *     re-runs the executor (no second process, no duplicate evidence). It only
 *     re-drives the idempotent reconciliation to converge the finalization.
 *
 * Known window (recorded limitation, not a guarantee): re-entry idempotency
 * begins only once the dispatch invocation is TERMINAL. A process death after
 * the wrapper exits — including after finalization committed — but before
 * `terminalizeDispatchedExecutorInvocation` records terminal evidence leaves a
 * non-terminal invocation over a `running` step, so the next tick runs the
 * wrapper again under the same attempt (a second bounded process whose
 * evidence paths overwrite the first). Git safety holds because the daemon
 * lane re-derives the base HEAD per tick, but the bounded work itself is
 * duplicated. Closing the window needs durable round progression persisted
 * around the wrapper run (the executor-SDK dispatch driver owns that); it is
 * deliberately not patched ad hoc here.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import { isTerminalExecutorInvocationState } from "../../executors/loop/reducer.js";
import {
  listExecutorRoundsForInvocation,
  loadExecutorInvocation
} from "../../executors/loop/persist.js";
import {
  finalizeWorkflowStepFromResultFile,
  type FinalizeWorkflowStepFromResultFileResult
} from "../../executors/shared/step-finalize.js";
import {
  WORKFLOW_LIVE_RUN_RECOVERY_CODES,
  writeWorkflowRecoveryArtifactInRunDir,
  type WorkflowLiveRunRecoveryCode,
  type WorkflowRecoveryArtifactInput,
  type WorkflowRecoveryEvidencePointer,
  type WorkflowRecoveryNextAction
} from "../recovery/artifact.js";
import { deriveDispatchInvocationId } from "./execute.js";
import {
  terminalizeDispatchedExecutorInvocation,
  type TerminalizeDispatchedExecutorResult
} from "./executor-terminalize.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult
} from "./reconcile-execute.js";
import { getWorkflowStep } from "../step/transitions.js";
import {
  dispatchWorkflowStepExecutor,
  type WorkflowStepExecutorDispatchResult,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
  type WorkflowStepExecutorRegistry
} from "../step/executor.js";

/**
 * The per-run/per-step execution context the dispatched step's executor needs:
 * the repo it operates on, the bounded session's working directory, and the
 * result / log paths. The caller (the daemon lane) derives these from the durable
 * run row and the data-dir layout; this module forwards them verbatim into the
 * executor input.
 */
export type DispatchedStepExecutorContext = {
  repoPath: string;
  runDir: string;
  resultJsonPath: string;
  executorLogPath: string;
  repoSafety?: DispatchedStepRepoSafetyContext;
  /** Bounded-session attempt; defaults to 1 when omitted. */
  attempt?: number;
  promptPath?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
};

export type DispatchedStepRepoSafetyContext = {
  baseHead: string;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

type DispatchedStepExecutorSelection = {
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
};

const DEFAULT_DISPATCHED_STEP_EXECUTOR_SELECTION: DispatchedStepExecutorSelection = {
  agentProvider: null,
  model: null,
  effort: null
};

/**
 * Build the {@link WorkflowStepExecutorInput} for a dispatched step from its
 * durable `kind` plus the per-run execution context. Optional fields are
 * forwarded only when present so `exactOptionalPropertyTypes` stays honest.
 */
export function buildDispatchedStepExecutorInput(
  kind: WorkflowStepExecutorKind,
  runId: string,
  stepId: string,
  exec: DispatchedStepExecutorContext,
  selection: DispatchedStepExecutorSelection =
    DEFAULT_DISPATCHED_STEP_EXECUTOR_SELECTION
): WorkflowStepExecutorInput {
  return {
    runId,
    stepId,
    kind,
    attempt: exec.attempt ?? 1,
    agentProvider: selection.agentProvider,
    model: selection.model,
    effort: selection.effort,
    repoPath: exec.repoPath,
    runDir: exec.runDir,
    resultJsonPath: exec.resultJsonPath,
    executorLogPath: exec.executorLogPath,
    ...(exec.promptPath !== undefined ? { promptPath: exec.promptPath } : {}),
    ...(exec.ledgerPath !== undefined ? { ledgerPath: exec.ledgerPath } : {}),
    ...(exec.env !== undefined ? { env: exec.env } : {}),
    ...(exec.config !== undefined ? { config: exec.config } : {})
  };
}

/**
 * Stable `status` strings the execution path returns for daemon telemetry, tests,
 * and operator surfaces. Each is a recorded outcome — the seam never returns
 * without explaining what it did to a dispatched step.
 */
export const WORKFLOW_EXECUTE_RECONCILE_STATUS = {
  /** No `<run>::<step>::dispatch` invocation: not this seam's step (live-wrapper lane). */
  notDispatched: "execute_not_dispatched",
  /** The dispatched step row vanished between dispatch and execution. */
  stepNotFound: "execute_step_not_found",
  /** The dispatch invocation is still running but the step is not `running`. */
  stepNotRunning: "execute_step_not_running",
  /** The executor ran and its terminal evidence was reconciled this call. */
  executedAndReconciled: "execute_reconciled",
  /** Re-entry over an already-terminal invocation: executor not re-run. */
  alreadyExecuted: "execute_already_executed",
  /** Terminal evidence exists, but reconciliation threw and must be retried. */
  reconcileDeferred: "execute_reconcile_deferred",
  /**
   * An async dispatched producer observed its underlying work still in flight
   * (e.g. a `subworkflow` child run that is non-terminal), so it produced NO
   * terminal evidence and left the step running for a later tick to re-check —
   * the structural guard against prematurely finalizing a parent over an
   * unfinished child. See `dispatch/subworkflow-run.ts`.
   */
  childDeferred: "execute_child_deferred",
  /**
   * The dispatched step's execution context could not be derived, so the run was
   * parked for manual recovery WITHOUT running an executor (no clean terminal was
   * fabricated). See {@link recordUnresolvedDispatchedStepContext}.
   */
  contextUnresolved: "execute_context_unresolved",
  executionRejected: "execute_rejected"
} as const;

export type WorkflowExecuteReconcileStatus =
  (typeof WORKFLOW_EXECUTE_RECONCILE_STATUS)[keyof typeof WORKFLOW_EXECUTE_RECONCILE_STATUS];

export type ExecuteAndReconcileDispatchedStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /**
   * The `WorkflowStepExecutor` registry used to run the dispatched step. A
   * configured live-wrapper profile resolves to a real live executor; an
   * unconfigured registry resolves to the honest `runtime_unavailable` adapter.
   */
  registry: WorkflowStepExecutorRegistry;
  exec: DispatchedStepExecutorContext;
  now: number;
};

export type ExecuteAndReconcileDispatchedStepResult = {
  status: WorkflowExecuteReconcileStatus;
  /** The executor result, when the executor was run this call. */
  executorResult?: WorkflowStepExecutorDispatchResult;
  /** The terminalize outcome, when the executor was run this call. */
  terminalize?: TerminalizeDispatchedExecutorResult;
  /** The reconciliation outcome, when reconciliation was attempted. */
  reconcile?: WorkflowStepReconciliationResult;
  detail?: string;
};

/**
 * Run a dispatched step's executor and finalize it through the reconciliation seam. The production
 * composition of "run executor -> terminalize evidence -> reconcile"; see the
 * module doc for the boundary discipline (single finalization owner, live-wrapper-lane
 * refusal, idempotent re-entry that never re-runs the executor).
 */
export function executeAndReconcileDispatchedWorkflowStep(
  input: ExecuteAndReconcileDispatchedStepInput
): ExecuteAndReconcileDispatchedStepResult {
  const { db, runId, stepId, registry, exec, now } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: a live-wrapper direct-finalize / never-dispatched
    // step. The seam owns only dispatched scaffolds, so it refuses and never runs
    // an executor — the structural guard against a double finalize.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: invocationId
    };
  }

  if (isTerminalExecutorInvocationState(invocation.state)) {
    // Idempotent re-entry: a prior execution already ran the bounded session and
    // recorded its terminal evidence. NEVER re-run the executor (a second process
    // / duplicate evidence); just re-drive the idempotent reconciliation so
    // a crashed prior finalize still converges the step / lease / run-state.
    const reconciled = tryReconcileDispatchedWorkflowStep({
      db,
      runId,
      stepId,
      now
    });
    if (!reconciled.ok) {
      return {
        status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
        detail: reconciled.detail
      };
    }
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
      reconcile: reconciled.reconcile,
      detail: invocation.state
    };
  }

  const step = getWorkflowStep(db, runId, stepId);
  if (step === undefined) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotFound,
      detail: stepId
    };
  }
  if (step.state !== "running") {
    // The scaffold invocation is still `running` but the owning step is not, an
    // unexpected lane state the seam refuses rather than executing over.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotRunning,
      detail: step.state
    };
  }

  // Run the dispatched step's executor through the injected registry. This is the
  // only step that performs external work (a live wrapper spawns a process), so
  // it runs OUTSIDE any database transaction.
  const executorInput = buildDispatchedStepExecutorInput(
    step.kind,
    runId,
    stepId,
    exec,
    readDispatchedStepExecutorSelection(db, invocationId)
  );
  const executorResult = dispatchWorkflowStepExecutor(
    step.kind,
    executorInput,
    registry
  );

  const finalized = finalizeSuccessfulExecutorResult(executorResult, exec);

  // Record the result as terminal evidence, then let the reconciliation seam finalize the step from
  // it. terminalize and reconcile are each idempotent and own their own
  // transactions.
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: finalized.result,
    now
  });
  // Write the run-scoped recovery artifact from this tick's evidence BEFORE
  // attempting reconciliation: the artifact depends only on the terminalized
  // evidence, and a deferred reconcile returns early while the terminal
  // re-entry branch never reconstructs artifacts — writing here keeps
  // `recovery.md` from being lost to a transient reconcile failure.
  const recovery =
    finalized.recovery ?? classifyProcessLevelRecovery(finalized.result);
  if (recovery !== null) {
    tryWriteFinalizeRecoveryArtifact({
      runId,
      stepId,
      exec,
      recovery,
      now
    });
  }

  const reconciled = tryReconcileDispatchedWorkflowStep({
    db,
    runId,
    stepId,
    now
  });
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: reconciled.detail
    };
  }

  return {
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    executorResult,
    terminalize,
    reconcile: reconciled.reconcile
  };
}

function readDispatchedStepExecutorSelection(
  db: MomentumDb,
  invocationId: string
): DispatchedStepExecutorSelection {
  const rounds = listExecutorRoundsForInvocation(db, invocationId);
  const latest = rounds.at(-1);
  if (latest === undefined) return DEFAULT_DISPATCHED_STEP_EXECUTOR_SELECTION;
  return {
    agentProvider: latest.agentProvider,
    model: latest.model,
    effort: latest.effort
  };
}

function finalizeSuccessfulExecutorResult(
  result: WorkflowStepExecutorDispatchResult,
  exec: DispatchedStepExecutorContext
): {
  result: WorkflowStepExecutorDispatchResult;
  recovery?: LiveFinalizeRecovery;
} {
  if (!result.ok || exec.repoSafety === undefined) return { result };
  if (result.result.state === "skipped") {
    // Skip is a pre-dispatch planning decision, never a dispatched-step
    // terminal: terminalization parks this result as
    // `unexpected_skipped_terminal`, so finalization must not verify, commit,
    // or reset over it first.
    return { result };
  }
  const ownership = exec.repoSafety.beforeGitMutation?.();
  const finalize: FinalizeWorkflowStepFromResultFileResult = ownership?.ok === false
    ? { outcome: "repo_lock_lost", error: ownership.error }
    : finalizeWorkflowStepFromResultFile({
    repoPath: exec.repoPath,
    baseHead: exec.repoSafety.baseHead,
    resultFilePath: result.resultJsonPath,
    verificationCommands: exec.repoSafety.verificationCommands,
    verificationTimeoutSec: exec.repoSafety.verificationTimeoutSec,
    verificationLogPath: exec.repoSafety.verificationLogPath,
    ...(exec.repoSafety.beforeGitMutation !== undefined
      ? { beforeGitMutation: exec.repoSafety.beforeGitMutation }
      : {})
  });
  const recovery = classifyFinalizeRecovery(finalize);
  return {
    result: executorResultFromFinalize(result, finalize, exec.repoSafety),
    ...(recovery !== null ? { recovery } : {})
  };
}

function executorResultFromFinalize(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  finalize: FinalizeWorkflowStepFromResultFileResult,
  repoSafety: DispatchedStepRepoSafetyContext
): WorkflowStepExecutorDispatchResult {
  switch (finalize.outcome) {
    case "committed":
      return withFinalizationArtifact(result, repoSafety.verificationLogPath);
    case "reset_step_failure":
      return withFinalizedFailure(
        result,
        result.result.errorCode ?? "command_failed",
        result.result.errorMessage ??
          "workflow step reported failure and its worktree changes were reset",
        repoSafety.verificationLogPath
      );
    case "reset_verification_failure":
      return withFinalizedFailure(
        result,
        "command_failed",
        finalize.verification.error,
        repoSafety.verificationLogPath
      );
    case "commit_failed":
      if (
        finalize.commit.code === "nothing_to_commit" ||
        (finalize.reset !== undefined && finalize.reset.ok)
      ) {
        return withFinalizedFailure(
          result,
          "command_failed",
          finalize.commit.error,
          repoSafety.verificationLogPath
        );
      }
      if (finalize.reset !== undefined && !finalize.reset.ok) {
        return finalizedManualRecoveryResult(
          result,
          "reset_failed",
          finalize.reset.error
        );
      }
      return finalizedManualRecoveryResult(
        result,
        "commit_failed",
        finalize.commit.error
      );
    default:
      return finalizedManualRecoveryResult(
        result,
        finalizeExecutorErrorCode(finalize),
        describeFinalizeFailure(finalize)
      );
  }
}

function withFinalizationArtifact(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  verificationLogPath: string
): WorkflowStepExecutorDispatchResult {
  return {
    ...result,
    result: {
      ...result.result,
      artifacts: [
        ...result.result.artifacts,
        { kind: "verification-log", path: verificationLogPath }
      ]
    }
  };
}

function withFinalizedFailure(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  errorCode: NonNullable<
    Extract<WorkflowStepExecutorDispatchResult, { ok: true }>["result"]["errorCode"]
  >,
  errorMessage: string,
  verificationLogPath: string
): WorkflowStepExecutorDispatchResult {
  return {
    ...result,
    result: {
      ...result.result,
      state: "failed",
      artifacts: [
        ...result.result.artifacts,
        { kind: "verification-log", path: verificationLogPath }
      ],
      errorCode,
      errorMessage,
      recoveryHint: null
    }
  };
}

function finalizeExecutorErrorCode(
  finalize: FinalizeWorkflowStepFromResultFileResult
): string {
  switch (finalize.outcome) {
    case "result_missing":
      return "result_missing";
    case "result_invalid":
      return "result_invalid";
    case "manual_recovery_required":
      return finalize.recoveryCode;
    case "reset_failed":
      return "reset_failed";
    case "commit_failed":
      if (finalize.reset !== undefined && !finalize.reset.ok) return "reset_failed";
      if (finalize.commit.code === "nothing_to_commit") return "nothing_to_commit";
      return "commit_failed";
    case "git_failed":
      return "git_failed";
    case "repo_lock_lost":
      return "repo_lock_lost";
    default:
      return "invalid_input";
  }
}

function finalizedManualRecoveryResult(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  recoveryCode: string,
  error: string
): WorkflowStepExecutorDispatchResult {
  const failure = {
    ok: false as const,
    code: (
      recoveryCode === "result_missing" || recoveryCode === "result_invalid"
        ? recoveryCode
        : "manual_recovery_required"
    ) as Extract<WorkflowStepExecutorDispatchResult, { ok: false }>["code"],
    error,
    executorLogPath: result.executorLogPath,
    resultJsonPath: result.resultJsonPath,
    liveRecoveryCode: recoveryCode
  };
  return failure;
}

function describeFinalizeFailure(
  finalize: FinalizeWorkflowStepFromResultFileResult
): string {
  switch (finalize.outcome) {
    case "reset_step_failure":
      return "workflow step reported failure and its worktree changes were reset";
    case "reset_verification_failure":
      return finalize.verification.error;
    case "manual_recovery_required":
      return finalize.reason;
    case "reset_failed":
      return finalize.reset.error;
    case "commit_failed":
      return finalize.commit.error;
    case "git_failed":
    case "repo_lock_lost":
    case "invalid_input":
    case "result_missing":
    case "result_invalid":
      return finalize.error;
    case "committed":
      return "workflow step committed";
  }
}

type LiveFinalizeRecovery = {
  code: WorkflowLiveRunRecoveryCode;
  reason: string;
  evidencePointers: readonly WorkflowRecoveryEvidencePointer[];
  nextAction: WorkflowRecoveryNextAction;
};

const LIVE_RUN_RECOVERY_CODE_SET: ReadonlySet<string> = new Set(
  WORKFLOW_LIVE_RUN_RECOVERY_CODES
);

function classifyFinalizeRecovery(
  finalize: FinalizeWorkflowStepFromResultFileResult
): LiveFinalizeRecovery | null {
  switch (finalize.outcome) {
    case "manual_recovery_required":
      return {
        code: finalize.recoveryCode,
        reason: finalize.reason,
        evidencePointers: [
          { label: "expected-head", ref: finalize.expectedHead },
          { label: "current-head", ref: finalize.currentHead }
        ],
        nextAction: {
          code: "investigate_head_mismatch",
          detail:
            "HEAD moved off the recorded base during the live step. Momentum refused a destructive reset; inspect the unexpected commit and decide manually whether to keep, amend, or roll it back before clearing recovery.",
          stepId: null
        }
      };
    case "result_missing":
      return resultFileRecovery(
        "result_missing",
        finalize.error,
        finalize.resultFilePath,
        "investigate_result_missing",
        "The live step's normalized result document was not written, so its true outcome is unknown. Momentum did not commit or reset; inspect the executor log before retrying or canceling."
      );
    case "result_invalid":
      return resultFileRecovery(
        "result_invalid",
        finalize.error,
        finalize.resultFilePath,
        "investigate_result_invalid",
        "The live step's result document is malformed and cannot be trusted. Momentum did not commit or reset; inspect the executor log before retrying or canceling."
      );
    case "reset_failed":
      return simpleFinalizeRecovery(
        "reset_failed",
        finalize.reset.error,
        "investigate_reset_failed",
        "The live step finalization could not restore the recorded base. Inspect and clean up the worktree manually before clearing recovery."
      );
    case "repo_lock_lost":
      return simpleFinalizeRecovery(
        "repo_lock_lost",
        finalize.error,
        "investigate_repo_lock_lost",
        "Momentum lost the active repo lock during live step finalization. Confirm repository ownership and worktree state before clearing recovery."
      );
    case "git_failed":
      return simpleFinalizeRecovery(
        "git_failed",
        finalize.error,
        "investigate_git_failed",
        "The live step finalization could not inspect or mutate git reliably. Inspect the repository and worktree manually before clearing recovery."
      );
    case "invalid_input":
      return simpleFinalizeRecovery(
        "invalid_input",
        finalize.error,
        "investigate_invalid_input",
        "The live step finalization refused to commit or reset because its inputs were invalid. Inspect the run directory and worktree manually before clearing recovery."
      );
    case "commit_failed":
      if (finalize.reset !== undefined) {
        if (finalize.reset.ok) return null;
        return simpleFinalizeRecovery(
          "reset_failed",
          finalize.reset.error,
          "investigate_reset_failed",
          "The live step finalization could not clean up after a commit failure. Inspect and clean up the worktree manually before clearing recovery."
        );
      }
      if (finalize.commit.code === "nothing_to_commit") return null;
      return simpleFinalizeRecovery(
        "commit_failed",
        finalize.commit.error,
        "investigate_commit_failed",
        "The live step finalization could not create the accepted Momentum commit and did not prove cleanup. Inspect the worktree manually before clearing recovery."
      );
    default:
      return null;
  }

  function simpleFinalizeRecovery(
    code: WorkflowLiveRunRecoveryCode,
    reason: string,
    nextCode: string,
    detail: string
  ): LiveFinalizeRecovery {
    return {
      code,
      reason,
      evidencePointers: [],
      nextAction: { code: nextCode, detail, stepId: null }
    };
  }

  function resultFileRecovery(
    code: WorkflowLiveRunRecoveryCode,
    reason: string,
    resultFilePath: string,
    nextCode: string,
    detail: string
  ): LiveFinalizeRecovery {
    return {
      code,
      reason,
      evidencePointers: [{ label: "result-file", ref: resultFilePath }],
      nextAction: { code: nextCode, detail, stepId: null }
    };
  }
}

function classifyProcessLevelRecovery(
  result: WorkflowStepExecutorDispatchResult
): LiveFinalizeRecovery | null {
  if (result.ok) return null;
  const code = readLiveRecoveryCode(result);
  if (!isLiveRunRecoveryCode(code)) return null;
  return {
    code,
    reason: result.error,
    evidencePointers: processLevelEvidencePointers(result),
    nextAction: {
      code: `investigate_${code}`,
      detail: processLevelRecoveryDetail(code),
      stepId: null
    }
  };
}

function readLiveRecoveryCode(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: false }>
): string {
  const precise = (result as { liveRecoveryCode?: unknown }).liveRecoveryCode;
  return typeof precise === "string" && precise.length > 0
    ? precise
    : result.code;
}

function isLiveRunRecoveryCode(
  code: string
): code is WorkflowLiveRunRecoveryCode {
  return LIVE_RUN_RECOVERY_CODE_SET.has(code);
}

function processLevelEvidencePointers(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: false }>
): WorkflowRecoveryEvidencePointer[] {
  const pointers: WorkflowRecoveryEvidencePointer[] = [];
  if (result.executorLogPath !== undefined && result.executorLogPath.length > 0) {
    pointers.push({ label: "executor-log", ref: result.executorLogPath });
  }
  if (result.resultJsonPath !== undefined && result.resultJsonPath.length > 0) {
    pointers.push({ label: "result-file", ref: result.resultJsonPath });
  }
  return pointers;
}

function processLevelRecoveryDetail(code: WorkflowLiveRunRecoveryCode): string {
  switch (code) {
    case "runtime_unavailable":
      return "The live wrapper runtime was unavailable before a trusted terminal result could be produced. Inspect the executor log and runtime configuration before retrying.";
    case "auth_unavailable":
      return "The live wrapper could not authenticate before a trusted terminal result could be produced. Inspect the executor log and credentials before retrying.";
    case "command_failed":
      return "The live wrapper command failed before a trusted terminal result could be produced. Inspect the executor log and worktree before retrying.";
    case "command_timed_out":
      return "The live wrapper command timed out before a trusted terminal result could be produced. Confirm the process is no longer running, then inspect the executor log and worktree.";
    case "output_overflow":
      return "The live wrapper exceeded the output cap before a trusted terminal result could be produced. Inspect the executor log and worktree before retrying.";
    case "executor_threw":
      return "The workflow-step executor threw before a trusted terminal result could be produced. Inspect the executor error and run directory before retrying.";
    case "result_missing":
      return "The live wrapper exited without writing a trusted result document. Inspect the executor log and result path before retrying.";
    case "result_invalid":
      return "The live wrapper wrote a malformed result document. Inspect the executor log and result file before retrying.";
    case "manual_recovery_required":
      return "The live wrapper requested manual recovery before a trusted terminal result could be produced. Inspect the executor log and run directory before clearing recovery.";
    default:
      return "The live wrapper failed before a trusted terminal result could be produced. Inspect the run directory and worktree before clearing recovery.";
  }
}

function tryWriteFinalizeRecoveryArtifact(input: {
  runId: string;
  stepId: string;
  exec: DispatchedStepExecutorContext;
  recovery: LiveFinalizeRecovery;
  now: number;
}): void {
  if (!LIVE_RUN_RECOVERY_CODE_SET.has(input.recovery.code)) return;
  const artifactInput: WorkflowRecoveryArtifactInput = {
    runId: input.runId,
    stepId: input.stepId,
    classification: input.recovery.code,
    reason: input.recovery.reason,
    recommendedNextAction: {
      ...input.recovery.nextAction,
      stepId: input.stepId
    },
    evidencePointers: input.recovery.evidencePointers,
    repoPath: input.exec.repoPath,
    classifiedAt: input.now
  };
  try {
    writeWorkflowRecoveryArtifactInRunDir({
      runDir: input.exec.runDir,
      input: artifactInput
    });
  } catch {
  }
}

export type RecordDispatchedStepManualRecoveryInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  error: string;
  now: number;
  status?: WorkflowExecuteReconcileStatus;
  detail?: string;
  /**
   * Precise recovery classification for the failure, preserved on the round as
   * `liveRecoveryCode` (a `WorkflowLiveRunRecoveryCode`). Without it the
   * fabricated failure classifies as `runtime_unavailable`, which the retry
   * lane treats as a retryable setup failure — wrong for config/git-safety
   * problems that need operator or config repair, not a retry.
   */
  recoveryCode?: string;
};

export type RecordUnresolvedDispatchedStepContextInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Why the execution context could not be derived (preserved as evidence). */
  reason: string;
  now: number;
  /** Precise recovery classification; see {@link RecordDispatchedStepManualRecoveryInput}. */
  recoveryCode?: string;
};

export function recordDispatchedStepManualRecovery(
  input: RecordDispatchedStepManualRecoveryInput
): ExecuteAndReconcileDispatchedStepResult {
  const { db, runId, stepId, error, now } = input;
  const failure = {
    ok: false as const,
    code: "runtime_unavailable" as const,
    error,
    executorLogPath: undefined,
    resultJsonPath: undefined,
    ...(input.recoveryCode !== undefined
      ? { liveRecoveryCode: input.recoveryCode }
      : {})
  };
  const executorResult: WorkflowStepExecutorDispatchResult = failure;
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: executorResult,
    now
  });
  const reconciled = tryReconcileDispatchedWorkflowStep({
    db,
    runId,
    stepId,
    now
  });
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: reconciled.detail
    };
  }
  return {
    status: input.status ?? WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
    executorResult,
    terminalize,
    reconcile: reconciled.reconcile,
    detail: input.detail ?? error
  };
}

/**
 * Record that a dispatched step's executor could not be RUN because its execution
 * context could not be derived (e.g. the run carries no repo path the bounded
 * session could work in), routing the step to manual recovery through the SAME
 * `terminalize -> the reconciliation seam reconcile` path an honest `runtime_unavailable` executor
 * result takes — without running any executor and without fabricating a clean
 * terminal.
 *
 * The daemon lane (`dispatch/live-wrapper.ts`) calls this when its context deriver
 * refuses. Deriving the context happens INSIDE the dispatch closure, *after* the
 * base dispatch advanced the step `approved -> running` and created the
 * `<run>::<step>::dispatch` scaffold. Throwing there would make the scheduler
 * release the dispatch lease and rethrow (its dispatch contract), stranding a
 * `running` step with no terminal evidence and no recovery gate. Recording manual
 * recovery instead parks the run safely — `needs_manual_recovery` + an
 * operator-visible gate, with the reconciliation seam releasing the held lease — the no-stranded-step
 * guarantee.
 *
 * Idempotent on re-entry: `terminalizeDispatchedExecutorInvocation` preserves an
 * already-terminal invocation and `reconcileDispatchedWorkflowStep` re-converges
 * the parked run, so a re-entered tick records no duplicate evidence and opens no
 * duplicate gate. A step with no dispatch invocation (the live-wrapper direct-finalize lane)
 * is left untouched: both seams refuse it and write nothing.
 */

export function recordUnresolvedDispatchedStepContext(
  input: RecordUnresolvedDispatchedStepContextInput
): ExecuteAndReconcileDispatchedStepResult {
  const { runId, stepId, reason } = input;
  return recordDispatchedStepManualRecovery({
    ...input,
    error: `cannot derive execution context for dispatched step ${runId}/${stepId}: ${reason}`,
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
    detail: reason
  });
}

function tryReconcileDispatchedWorkflowStep(input: {
  db: MomentumDb;
  runId: string;
  stepId: string;
  now: number;
}):
  | { ok: true; reconcile: WorkflowStepReconciliationResult }
  | { ok: false; detail: string } {
  try {
    return {
      ok: true,
      reconcile: reconcileDispatchedWorkflowStep(input)
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
