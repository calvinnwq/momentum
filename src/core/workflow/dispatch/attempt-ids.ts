/**
 * Deterministic identity helpers for the workflow-lane dispatch attempt spine.
 *
 * Both helpers are recomputable from durable state so dispatch re-entry, retry,
 * reconciliation, and recovery can converge on the same rows without storing
 * extra pointers.
 */

/**
 * The durable id of one dispatch-lane executor attempt. Every attempt is an
 * immutable row: retrying a step derives the next `attemptNumber`'s id and
 * inserts a fresh row, so concurrent retries collide on this primary key (and
 * on the unique `(workflow_run_id, step_run_id, attempt_number)` index) instead
 * of double-dispatching.
 */
export function deriveDispatchAttemptId(
  runId: string,
  stepId: string,
  attemptNumber: number,
): string {
  return `${runId}::${stepId}::attempt-${attemptNumber}`;
}

/**
 * The step-scoped dispatch correlation token shared by every attempt of one
 * dispatched step.
 *
 * This is deliberately the legacy deterministic dispatch id shape
 * (`<run>::<step>::dispatch`): external handoff receipts, externally launched
 * runs, and repo-lock job identity must correlate across retries, and durable
 * SDK-05 evidence already carries this exact value. It is retained as narrowly
 * scoped correlation provenance only — it is never an `executor_attempts` row
 * id in the active hierarchy (migrated legacy attempts may still carry it as
 * their preserved historical id).
 */
export function deriveDispatchCorrelationId(
  runId: string,
  stepId: string,
): string {
  return `${runId}::${stepId}::dispatch`;
}
