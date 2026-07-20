/**
 * Pure half of the daemon-dispatchable `subworkflow` adapter.
 *
 * the subworkflow seam makes the `subworkflow` executor family daemon-dispatchable by connecting
 * a child workflow run's terminal classification to the workflow dispatch /
 * executor-evidence lane — *without* inventing a parallel ad hoc runtime and
 * without weakening the fail-closed posture recursive runs require. The parent
 * step owns dispatch evidence; the child workflow run owns its own steps, gates,
 * recovery, and terminal state. This module owns the one piece the existing
 * dispatch seams do not: translating the child run's observed
 * {@link WorkflowRunState} into the executor evidence the terminalize bridge
 * consumes (or a "defer" signal when the child is still in flight).
 *
 * The durable dispatch lane already has two reusable seams this composes with:
 *
 *   - `dispatch/executor-evidence.ts` records a finished
 *     {@link WorkflowStepExecutorDispatchResult} as terminal executor evidence on
 *     the dispatch attempt scaffold (succeeded / failed for a clean
 *     terminal; `manual_recovery_required` for any `ok: false` result), and
 *   - `dispatch/reconcile-execute.ts` (the reconciliation seam) finalizes the owning
 *     `workflow_steps` row from that terminal evidence, exactly once.
 *
 * It is pure and total — no SQLite, no file system, no network, no clock — so the
 * mapping contract is exhaustively testable on its own, the same discipline
 * `mapExternalApplyResultToExecutorResult` (the external-apply seam) and
 * `planDispatchedExecutorTerminalization` follow.
 *
 * Mapping discipline (a child run recurses into another run, so the default is
 * fail closed):
 *
 *   - A clean child terminal mirrors the child's classification: `succeeded`
 *     becomes a clean `succeeded` executor result and `failed` becomes a clean
 *     `failed` executor result — both legitimate mirrored terminals the
 *     terminalize decider routes to a clean workflow-step terminal. A child
 *     `failed` is the child running to a failure terminal, NOT a process-level
 *     executor failure, so it stays a clean terminal rather than manual recovery.
 *   - A `canceled` child terminal is ambiguous (the executor-evidence terminal
 *     vocabulary has no clean "canceled" member, and a cancel may or may not mean
 *     the parent should abort) and a `blocked` child run is stuck needing its own
 *     recovery; both map to a fail-closed `manual_recovery_required` executor
 *     result so the parent step parks for operator inspection rather than
 *     fabricating a clean terminal. Any unexpected non-enum child state defaults
 *     to the same fail-closed manual-recovery result.
 *   - A non-terminal child run (`pending` / `approved` / `running`) is still in
 *     flight: the mapper returns a "defer" signal and produces NO terminal
 *     evidence, so the parent step is never prematurely finalized while the child
 *     keeps running.
 */

import type { WorkflowRunState } from "../run/reducer.js";
import type { WorkflowStepExecutorDispatchResult } from "../step/executor.js";

/**
 * The in-flight child run states a dispatched `subworkflow` parent step defers
 * on: the child is still progressing, so producing terminal evidence would
 * prematurely finalize the parent. Every other state mirrors (clean terminal for
 * `succeeded` / `failed`; fail-closed manual recovery for `canceled` / `blocked`
 * / any unexpected state) — a `blocked` child cannot progress on its own and a
 * cancel is ambiguous, so neither defers forever.
 */
const SUBWORKFLOW_DEFERRED_CHILD_RUN_STATES: ReadonlySet<WorkflowRunState> =
  new Set(["pending", "approved", "running"]);

/**
 * The durable evidence paths the mirrored `subworkflow` executor result carries,
 * plus the child run id it mirrors. The daemon lane derives the paths from the
 * parent run's data-dir layout (a log of the attach/mirror attempt and a JSON
 * snapshot of the child run state) and forwards them here so the terminalize
 * bridge can attach them to the round as operator-visible evidence — the same
 * `executorLogPath` / `resultJsonPath` shape a live-wrapper executor result
 * carries.
 */
export type SubworkflowMirrorEvidence = {
  /** The child workflow run id the parent step started or attached to. */
  childRunId: string;
  executorLogPath: string;
  resultJsonPath: string;
};

export type SubworkflowChildMirrorOptions = {
  childNeedsManualRecovery?: boolean;
  childManualRecoveryReason?: string | null;
};

/**
 * The decision a child run's observed {@link WorkflowRunState} implies for a
 * dispatched `subworkflow` parent step.
 *
 *   - `defer`: the child run is non-terminal (`pending` / `approved` /
 *     `running`); no terminal evidence is produced and the parent step is left
 *     running for a later daemon tick to re-check.
 *   - `mirror`: the child reached a classification the parent step can mirror as
 *     durable terminal executor evidence — a clean `succeeded` / `failed` mirror,
 *     or a fail-closed `manual_recovery_required` result for a `canceled` /
 *     `blocked` / unexpected child state.
 */
export type SubworkflowChildMirrorPlan =
  | {
      outcome: "defer";
      childRunId: string;
      childState: WorkflowRunState;
      reason: string;
    }
  | {
      outcome: "mirror";
      childRunId: string;
      childState: WorkflowRunState;
      result: WorkflowStepExecutorDispatchResult;
    };

/**
 * Translate a child workflow run's observed {@link WorkflowRunState} into the
 * {@link SubworkflowChildMirrorPlan} the daemon-dispatchable `subworkflow`
 * producer acts on.
 *
 * Pure and total: never throws, always returns a plan. A clean child terminal
 * mirrors the child's classification; a `canceled` / `blocked` / unexpected child
 * state fails closed to a `manual_recovery_required` mirror; a non-terminal child
 * run defers (see the module doc).
 */
export function planSubworkflowChildMirror(
  childState: WorkflowRunState,
  evidence: SubworkflowMirrorEvidence,
  options: SubworkflowChildMirrorOptions = {},
): SubworkflowChildMirrorPlan {
  if (options.childNeedsManualRecovery === true) {
    const reason = options.childManualRecoveryReason?.trim();
    const error =
      `Subworkflow child run ${evidence.childRunId} is marked for manual recovery ` +
      `while ${childState}; routing the parent step to manual recovery` +
      (reason ? ` (${reason}).` : ".");
    return mirror(childState, evidence, manualRecoveryResult(error, evidence));
  }

  if (SUBWORKFLOW_DEFERRED_CHILD_RUN_STATES.has(childState)) {
    // `pending` / `approved` / `running`: the child run is still in flight.
    // Produce no terminal evidence so the parent step is never prematurely
    // finalized while the child keeps progressing.
    return {
      outcome: "defer",
      childRunId: evidence.childRunId,
      childState,
      reason:
        `Subworkflow child run ${evidence.childRunId} is still ${childState}; ` +
        "deferring parent step finalization until the child reaches a terminal state.",
    };
  }

  if (childState === "succeeded" || childState === "failed") {
    // A clean child terminal mirrors the child's classification: a `failed` child
    // ran to a failure terminal (a legitimate mirrored terminal), NOT a
    // process-level executor failure, so it stays a clean terminal.
    return mirror(childState, evidence, cleanResult(childState, evidence));
  }

  // `canceled` (ambiguous), `blocked` (stuck, needs its own recovery), or any
  // unexpected non-enum state: fail closed to manual recovery rather than
  // fabricating a clean terminal.
  const error =
    childState === "canceled"
      ? `Subworkflow child run ${evidence.childRunId} was canceled; routing the ` +
        "parent step to manual recovery (ambiguous terminal classification)."
      : `Subworkflow child run ${evidence.childRunId} is ${childState} and needs ` +
        "recovery; routing the parent step to manual recovery.";
  return mirror(childState, evidence, manualRecoveryResult(error, evidence));
}

function mirror(
  childState: WorkflowRunState,
  evidence: SubworkflowMirrorEvidence,
  result: WorkflowStepExecutorDispatchResult,
): SubworkflowChildMirrorPlan {
  return {
    outcome: "mirror",
    childRunId: evidence.childRunId,
    childState,
    result,
  };
}

function cleanResult(
  state: "succeeded" | "failed",
  evidence: SubworkflowMirrorEvidence,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state,
      summary: `Subworkflow child run ${evidence.childRunId} ${state}.`,
      checkpoints: [],
      artifacts: [
        { kind: "executor-log", path: evidence.executorLogPath },
        { kind: "subworkflow-child-run", path: evidence.resultJsonPath },
      ],
      // The child run id is the stable digest tying this terminal evidence to the
      // child run it mirrors.
      resultDigest: evidence.childRunId,
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null,
    },
    executorLogPath: evidence.executorLogPath,
    resultJsonPath: evidence.resultJsonPath,
  };
}

function manualRecoveryResult(
  error: string,
  evidence: SubworkflowMirrorEvidence,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: false,
    code: "manual_recovery_required",
    error,
    executorLogPath: evidence.executorLogPath,
    resultJsonPath: evidence.resultJsonPath,
  };
}
