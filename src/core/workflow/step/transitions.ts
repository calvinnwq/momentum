/**
 * Durable `workflow_steps` live-transition primitives.
 *
 * Iteration 1-3 of live-wrapper added the live execution core (`live-step-wrapper.ts`),
 * the workflow-run executor bridge (`live-step/executor.ts`), and the durable
 * `workflow_leases` lifecycle primitives (`leases.ts`). The remaining
 * caller-side foundation the live-execution contract requires is the step-state
 * half of the lifecycle: "write a start event before spawning" and "persist
 * terminal state before releasing the lease".
 *
 * Before this slice there was no `src` function that performed a *live* (system)
 * `workflow_steps` transition. Two adjacent paths exist but neither fits:
 *
 *   - `persistWorkflowRunImport` (`run/import-persist.ts`) upserts step
 *     state from a *static* imported artifact tree, not from live execution.
 *   - The operator-recovery `workflow run update-step` CLI handler transitions a step but does
 *     so as an *operator override*: it stamps `operator_transition_at` plus the
 *     `operator_reason` / `operator_actor` / `operator_*_pointer` audit columns,
 *     and `persistWorkflowRunImport` treats a non-null `operator_transition_at`
 *     as a freeze gate that protects the row from re-import clobbering.
 *
 * A live executor transition is emphatically *not* an operator override, so
 * these primitives intentionally never write `operator_transition_at` or any
 * `operator_*` column. They move a row `approved -> running` (stamping
 * `started_at`) and then into a terminal state (stamping `finished_at` plus the
 * `error_code` / `error_message` / `result_digest` produced by the run), and
 * they return reducer-compatible state so the result feeds
 * `deriveWorkflowRunState` directly. Mirrors the `leases.ts` primitives
 * in shape and race-guard discipline.
 *
 * The workflow dispatch and reconciliation lanes wire these together with the
 * lease primitives and executor evidence (acquire lease -> start -> execute ->
 * terminalize evidence -> reconcile -> release).
 * These primitives stay the durable step-state building block they compose; the
 * caller remains responsible for run-state re-derivation and run-level recovery
 * reconciliation.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  isTerminalStepState,
  transitionWorkflowStep,
  WORKFLOW_STEP_TERMINAL_STATES,
  type StepTransitionErrorCode,
  type WorkflowStepKind,
  type WorkflowStepState
} from "../run/reducer.js";

/** A terminal step state a live step can be finished into. */
export type WorkflowStepTerminalState =
  (typeof WORKFLOW_STEP_TERMINAL_STATES)[number];

/**
 * The durable `workflow_steps` columns these primitives read and write, mapped
 * into camelCase. Distinct from the reducer's `WorkflowStepRecord` (which only
 * carries the fields needed for run-state derivation): this shape also surfaces
 * the live-execution bookkeeping (`startedAt` / `finishedAt` / `errorCode` /
 * `errorMessage` / `resultDigest`) and the operator-gate column so the
 * orchestrator can reason about both.
 */
export type WorkflowStepDurableRow = {
  runId: string;
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultDigest: string | null;
  operatorTransitionAt: number | null;
};

export type WorkflowStepTransitionOutcome =
  | {
      ok: true;
      state: WorkflowStepState;
      startedAt: number | null;
      finishedAt: number | null;
      idempotent: boolean;
    }
  | { ok: false; reason: "step_not_found" }
  | {
      ok: false;
      reason: "invalid_transition";
      from: WorkflowStepState;
      to: WorkflowStepState;
      errorCode: StepTransitionErrorCode;
      errorMessage: string;
    };

export type StartWorkflowStepInput = {
  runId: string;
  stepId: string;
  now?: number;
};

/**
 * Transition a step `approved -> running` and stamp `started_at`. Refuses with
 * `invalid_transition` for any other source state and `step_not_found` when the
 * row is absent. Never touches operator columns.
 */
export function startWorkflowStep(
  db: MomentumDb,
  input: StartWorkflowStepInput
): WorkflowStepTransitionOutcome {
  const now = input.now ?? Date.now();
  const row = getWorkflowStep(db, input.runId, input.stepId);
  if (!row) return { ok: false, reason: "step_not_found" };

  if (row.state !== "approved") {
    if (isTerminalStepState(row.state)) {
      const terminalTransition = transitionWorkflowStep(row.state, "running");
      if (!terminalTransition.ok) {
        return invalidTransition(
          row.state,
          "running",
          terminalTransition.errorCode,
          terminalTransition.errorMessage
        );
      }
    }
    return invalidTransition(
      row.state,
      "running",
      "workflow_step_invalid_transition",
      `workflow step cannot start from ${row.state}; expected approved`
    );
  }

  const transition = transitionWorkflowStep(row.state, "running");
  if (!transition.ok) {
    return invalidTransition(
      row.state,
      "running",
      transition.errorCode,
      transition.errorMessage
    );
  }

  // Guard the write on the from-state we validated so a cross-process writer
  // that moved the row between the read and this write cannot be clobbered.
  const result = db
    .prepare(
      `UPDATE workflow_steps
         SET state = 'running', started_at = ?, updated_at = ?
       WHERE run_id = ? AND step_id = ? AND state = ?`
    )
    .run(now, now, input.runId, input.stepId, row.state);

  if (Number(result.changes) === 0) {
    return reportPostWriteConflict(db, input.runId, input.stepId, "running");
  }
  return {
    ok: true,
    state: "running",
    startedAt: now,
    finishedAt: row.finishedAt,
    idempotent: false
  };
}

export type FinishWorkflowStepInput = {
  runId: string;
  stepId: string;
  state: WorkflowStepTerminalState;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultDigest?: string | null;
  now?: number;
};

/**
 * Transition a step into a terminal state, stamping `finished_at` and writing
 * the run-produced `error_code` / `error_message` / `result_digest`. Any valid
 * transition into a terminal state is allowed (e.g. `running -> succeeded`,
 * `running -> failed`, or `approved -> skipped`); the reducer guard decides
 * legality. Idempotent when the step is already in the requested terminal state
 * (the immutable terminal record is preserved and no write occurs). Throws on a
 * non-terminal target (caller misuse). Never touches operator columns.
 */
export function finishWorkflowStep(
  db: MomentumDb,
  input: FinishWorkflowStepInput
): WorkflowStepTransitionOutcome {
  if (!isTerminalStepState(input.state)) {
    throw new Error(
      `finishWorkflowStep: state must be a terminal step state (${WORKFLOW_STEP_TERMINAL_STATES.join(", ")})`
    );
  }
  const now = input.now ?? Date.now();
  const row = getWorkflowStep(db, input.runId, input.stepId);
  if (!row) return { ok: false, reason: "step_not_found" };

  const transition = transitionWorkflowStep(row.state, input.state);
  if (!transition.ok) {
    return invalidTransition(row.state, input.state, transition.errorCode, transition.errorMessage);
  }
  if (row.state === input.state) {
    return {
      ok: true,
      state: row.state,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      idempotent: true
    };
  }

  const errorCode = input.errorCode ?? null;
  const errorMessage = input.errorMessage ?? null;
  const resultDigest = input.resultDigest ?? null;
  const result = db
    .prepare(
      `UPDATE workflow_steps
         SET state = ?, finished_at = ?, error_code = ?, error_message = ?,
             result_digest = ?, updated_at = ?
       WHERE run_id = ? AND step_id = ? AND state = ?`
    )
    .run(
      input.state,
      now,
      errorCode,
      errorMessage,
      resultDigest,
      now,
      input.runId,
      input.stepId,
      row.state
    );

  if (Number(result.changes) === 0) {
    return reportPostWriteConflict(db, input.runId, input.stepId, input.state);
  }
  return {
    ok: true,
    state: input.state,
    startedAt: row.startedAt,
    finishedAt: now,
    idempotent: false
  };
}

type RawStepRow = {
  run_id: string;
  step_id: string;
  kind: string;
  state: string;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  result_digest: string | null;
  operator_transition_at: number | null;
};

/**
 * Read one `workflow_steps` row mapped into {@link WorkflowStepDurableRow}, or
 * `undefined` when no row exists for `(runId, stepId)`.
 */
export function getWorkflowStep(
  db: MomentumDb,
  runId: string,
  stepId: string
): WorkflowStepDurableRow | undefined {
  const row = db
    .prepare(
      `SELECT run_id, step_id, kind, state, started_at, finished_at,
              error_code, error_message, result_digest, operator_transition_at
         FROM workflow_steps WHERE run_id = ? AND step_id = ?`
    )
    .get(runId, stepId) as RawStepRow | undefined;
  return row ? mapStepRow(row) : undefined;
}

function mapStepRow(row: RawStepRow): WorkflowStepDurableRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    state: row.state as WorkflowStepState,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultDigest: row.result_digest,
    operatorTransitionAt: row.operator_transition_at
  };
}

function invalidTransition(
  from: WorkflowStepState,
  to: WorkflowStepState,
  errorCode: StepTransitionErrorCode,
  errorMessage: string
): WorkflowStepTransitionOutcome {
  return { ok: false, reason: "invalid_transition", from, to, errorCode, errorMessage };
}

/**
 * The from-state-guarded UPDATE matched no row: a concurrent writer moved the
 * step between the read and the write. Re-read and report against the current
 * durable state so the caller never sees a silent no-op.
 */
function reportPostWriteConflict(
  db: MomentumDb,
  runId: string,
  stepId: string,
  to: WorkflowStepState
): WorkflowStepTransitionOutcome {
  const current = getWorkflowStep(db, runId, stepId);
  if (!current) return { ok: false, reason: "step_not_found" };
  if (current.state === to) {
    return {
      ok: true,
      state: current.state,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      idempotent: true
    };
  }
  const transition = transitionWorkflowStep(current.state, to);
  if (transition.ok) {
    // The transition is legal again but our guarded write lost the row; surface
    // it as an invalid transition rather than retrying blindly.
    return invalidTransition(
      current.state,
      to,
      "workflow_step_invalid_transition",
      `workflow step ${runId}/${stepId} changed concurrently to ${current.state}; refusing ambiguous ${to} transition`
    );
  }
  return invalidTransition(current.state, to, transition.errorCode, transition.errorMessage);
}
