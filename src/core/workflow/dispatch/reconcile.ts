/**
 * Production workflow-step reconciliation decision domain.
 *
 * This module owns the *pure* half of the single reconciliation seam the
 * runtime-consolidation plan names the reconciliation seam: the deterministic decision that turns a
 * dispatched executor-loop step's terminal executor evidence into a workflow-step
 * finalization outcome. It is the brain; the effect twin reads the
 * newest dispatch attempt, applies the decision durably
 * (`finishWorkflowStep` + dispatch-lease release + run-state refresh), and is
 * idempotent on the deterministic dispatch id so re-entry cannot double-finalize.
 *
 * It follows the same discipline as `dispatch.ts` and the executor-loop reducer:
 * no SQLite, no file system, no daemon, no executor attempt.
 * {@link planWorkflowStepReconciliation} is pure and total — it never throws and
 * always returns a {@link WorkflowStepReconciliationPlan} discriminated union,
 * mirroring the `{ action: ... }` convention used by `planWorkflowStepDispatch`
 * and the reducers.
 *
 * Scope decisions pinned here, grounded in
 * SPEC.md ("The live-wrapper / executor-loop
 * step-finalization boundary") and SPEC.md
 * ("Executor States" / "Core Boundary: the daemon, not the executor, decides
 * step progress"):
 *
 *   - The dispatch attempt's *state* is the canonical "bounded session ended"
 *     rollup. While it is non-terminal (pending / preparing / running / pausing /
 *     waiting_operator) the executor session is still in progress, so the seam
 *     defers: the dispatch scaffold left the step `running` and reconciliation
 *     must not finalize it early.
 *   - A clean terminal attempt maps to the matching terminal `workflow_steps`
 *     state: `succeeded -> succeeded`, `failed -> failed`, `cancelled ->
 *     canceled`. These are the only outcomes that move a dispatched step to a
 *     clean workflow-step terminal.
 *   - A terminal-but-unclean attempt (`blocked` or `manual_recovery_required`)
 *     is *not* a clean step terminal: the bounded attempt ended needing operator
 *     inspection or a later recovery round, so the seam routes to manual recovery
 *     rather than fabricating a `succeeded` / `failed` finalization. The effect
 *     twin parks the run for manual recovery instead of calling
 *     `finishWorkflowStep`, mirroring the fail-closed half of the dispatcher.
 *
 * A dispatched step is never finalized to `skipped`: skipping is an
 * `approved -> skipped` planning decision that happens before dispatch, so it can
 * never be a reconciliation outcome for a step the dispatcher already started.
 */

import {
  isTerminalExecutorAttemptState,
  type ExecutorAttemptState,
} from "../../executors/loop/reducer.js";
import type { WorkflowStepTerminalState } from "../step/transitions.js";

/**
 * The reconciliation decision for a dispatched workflow step, given its dispatch
 * attempt's current state.
 *
 *   - `not_terminal`: the bounded executor session is still in progress; leave
 *     the step `running` and reconcile again once the attempt is terminal.
 *   - `finalize`: the attempt reached a clean terminal; the effect twin moves
 *     the owning step to `stepState` via `finishWorkflowStep`.
 *   - `manual_recovery`: the attempt ended `blocked` / `manual_recovery_required`;
 *     the effect twin parks the run for operator recovery instead of finalizing
 *     the step to a clean terminal.
 */
export type WorkflowStepReconciliationPlan =
  | { action: "not_terminal" }
  | { action: "finalize"; stepState: WorkflowStepTerminalState; reason: string }
  | {
      action: "manual_recovery";
      attemptState: ExecutorAttemptState;
      reason: string;
    };

/**
 * Clean terminal attempt states and the workflow-step terminal each maps to.
 * Only these three move a dispatched step to a clean terminal; every other
 * terminal attempt state (`blocked`, `manual_recovery_required`) routes to
 * manual recovery instead.
 */
const CLEAN_TERMINAL_STEP_STATE: Partial<
  Record<ExecutorAttemptState, WorkflowStepTerminalState>
> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "canceled",
};

const FINALIZE_REASON: Partial<Record<ExecutorAttemptState, string>> = {
  succeeded:
    "Dispatch attempt reached terminal `succeeded`; finalizing the workflow step succeeded.",
  failed:
    "Dispatch attempt reached terminal `failed`; finalizing the workflow step failed.",
  cancelled:
    "Dispatch attempt reached terminal `cancelled`; finalizing the workflow step canceled.",
};

/**
 * Decide how the reconciliation seam should finalize a dispatched workflow step,
 * given its dispatch attempt's current state.
 *
 * Pure and total: never throws, always returns a
 * {@link WorkflowStepReconciliationPlan}. A non-terminal attempt defers; a
 * clean terminal finalizes the step; an unclean terminal (`blocked` /
 * `manual_recovery_required`) routes to manual recovery so the seam never
 * fabricates a clean finalization over an outcome that needs operator inspection.
 */
export function planWorkflowStepReconciliation(
  attemptState: ExecutorAttemptState,
): WorkflowStepReconciliationPlan {
  if (!isTerminalExecutorAttemptState(attemptState)) {
    return { action: "not_terminal" };
  }

  const stepState = CLEAN_TERMINAL_STEP_STATE[attemptState];
  if (stepState !== undefined) {
    return {
      action: "finalize",
      stepState,
      reason:
        FINALIZE_REASON[attemptState] ??
        `Dispatch attempt reached terminal \`${attemptState}\`; finalizing the workflow step.`,
    };
  }

  // `blocked` / `manual_recovery_required`: terminal, but not a clean step
  // terminal — the bounded attempt ended needing operator inspection or a later
  // recovery round.
  return {
    action: "manual_recovery",
    attemptState,
    reason: `Dispatch attempt ended \`${attemptState}\`; routing the dispatched step to manual recovery rather than a clean workflow-step terminal.`,
  };
}
