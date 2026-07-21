import type { MomentumDb } from "../../../adapters/db.js";
import {
  ExecutorAttemptConflictError,
  ExecutorRoundConflictError,
  insertExecutorAttempt,
  insertExecutorRound,
} from "../../executors/loop/persist.js";
import type { ExecutorRoundRecord } from "../../executors/loop/reducer.js";
import { isExecutorName, type ExecutorName } from "../definition/definition.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import { WORKFLOW_STEP_KINDS, type WorkflowStepKind } from "../run/reducer.js";
import { appendWorkflowEvent, buildWorkflowEventId } from "../run/events.js";
import { deriveDispatchAttemptId } from "./attempt-ids.js";

const GENERIC_RETRYABLE_DISPATCH_RECOVERY_CODES: ReadonlySet<string> = new Set([
  "unsupported_platform",
  "runtime_unavailable",
  "executor_threw",
  "executor_contract_invalid",
  "host_binding_mismatch",
]);

const DELEGATE_RETRYABLE_DISPATCH_RECOVERY_CODES: ReadonlySet<string> = new Set(
  [
    "tool_adapter_unavailable",
    "delegate_handoff_failed",
    "delegate_handoff_recovery_required",
    "external_state_unreadable",
    "external_state_inconsistent",
    "external_state_blocked",
  ],
);

type RetryableAttemptState = "manual_recovery_required" | "blocked";

type RetryableStepState = "approved" | "running";

type RetryRoundSelection = {
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
};

const DEFAULT_RETRY_ROUND_SELECTION: RetryRoundSelection = {
  agentProvider: null,
  model: null,
  effort: null,
};

export type RetryableDispatchedStepRecovery = {
  runId: string;
  stepId: string;
  kind: WorkflowStepKind;
  attemptId: string;
  executorFamily: ExecutorName;
  attemptNumber: number;
  latestRoundIndex: number;
  recoveryCode: string;
  stepOrder: number;
  required: boolean;
  startedAt: number | null;
};

type RetryableDispatchRow = {
  run_id: string;
  step_id: string;
  kind: string;
  attempt_id: string;
  executor_family: string;
  attempt_state: string;
  attempt_number: number;
  round_index: number | null;
  recovery_code: string | null;
  step_order: number;
  required: number;
  started_at: number | null;
};

/**
 * Find a claimed-state step whose newest dispatch attempt ended in a retryable
 * terminal. Only the highest-numbered attempt is ever considered: earlier
 * attempts are immutable history and can never be reopened or re-examined for
 * retry eligibility.
 */
export function findRetryableDispatchedStepRecovery(
  db: MomentumDb,
  input: { runId: string; stepState: RetryableStepState },
): RetryableDispatchedStepRecovery | undefined {
  const rows = db
    .prepare(
      `SELECT s.run_id,
              s.step_id,
              s.kind,
              s.step_order,
              s.required,
              s.started_at,
              a.attempt_id,
              a.executor_family,
              a.state AS attempt_state,
              a.attempt_number,
              (SELECT MAX(step_round.round_index)
                 FROM executor_rounds AS step_round
                WHERE step_round.workflow_run_id = s.run_id
                  AND step_round.step_run_id = s.step_id) AS round_index,
              r.recovery_code
         FROM workflow_steps AS s
         JOIN executor_attempts AS a
           ON a.workflow_run_id = s.run_id
          AND a.step_run_id = s.step_id
          AND a.attempt_number = (
            SELECT MAX(latest.attempt_number)
              FROM executor_attempts AS latest
             WHERE latest.workflow_run_id = s.run_id
               AND latest.step_run_id = s.step_id
          )
         LEFT JOIN executor_rounds AS r
           ON r.attempt_id = a.attempt_id
          AND r.round_index = (
            SELECT MAX(round_index)
              FROM executor_rounds
             WHERE attempt_id = a.attempt_id
          )
        WHERE s.run_id = ? AND s.state = ?
        ORDER BY s.step_order, s.step_id`,
    )
    .all(input.runId, input.stepState) as RetryableDispatchRow[];

  for (const row of rows) {
    const parsed = parseRetryableDispatchRow(row);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

export type PrepareRetryableDispatchedStepForClearResult =
  | { prepared: false }
  | {
      prepared: true;
      runId: string;
      stepId: string;
      attemptId: string;
      attemptNumber: number;
      recoveryCode: string;
    };

export function prepareRetryableDispatchedStepForRecoveryClear(
  db: MomentumDb,
  input: { runId: string; now: number },
): PrepareRetryableDispatchedStepForClearResult {
  const retryable = findRetryableDispatchedStepRecovery(db, {
    runId: input.runId,
    stepState: "running",
  });
  if (retryable === undefined) return { prepared: false };

  appendRetryableStepStartedEventBeforeClear(db, retryable);

  const changed = db
    .prepare(
      `UPDATE workflow_steps
          SET state = 'approved',
              started_at = NULL,
              finished_at = NULL,
              error_code = NULL,
              error_message = NULL,
              result_digest = NULL,
              updated_at = ?
        WHERE run_id = ?
          AND step_id = ?
          AND state = 'running'`,
    )
    .run(input.now, input.runId, retryable.stepId);
  if (Number(changed.changes) === 0) return { prepared: false };
  refreshWorkflowRunRuntimeState(db, { runId: input.runId, now: input.now });
  return {
    prepared: true,
    runId: input.runId,
    stepId: retryable.stepId,
    attemptId: retryable.attemptId,
    attemptNumber: retryable.attemptNumber,
    recoveryCode: retryable.recoveryCode,
  };
}

export type StartRetryableDispatchAttemptResult =
  | { started: false }
  | {
      started: true;
      attemptId: string;
      attemptNumber: number;
      roundIndex: number;
    };

/**
 * Start a fresh durable attempt for a step whose newest attempt ended in a
 * retryable terminal. The prior attempt row and all of its rounds are left
 * untouched: a retry is a new immutable attempt with the next `attemptNumber`,
 * never a reopened or rewritten one. Fresh ids use the canonical derived shape
 * when it is available and a deterministic suffix when preserved legacy data
 * already occupies that unrestricted id. The attempt and its initial round are
 * one savepoint-protected write, and round ids use the same collision-safe
 * allocation. A concurrent retry still loses the unique step-attempt-number
 * insert race and reports `started: false`.
 */
export function startRetryableDispatchAttempt(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    now: number;
    stepState?: RetryableStepState;
    selection?: RetryRoundSelection;
    executorOwnsRounds?: boolean;
  },
): StartRetryableDispatchAttemptResult {
  const retryable = findRetryableDispatchedStepRecovery(db, {
    runId: input.runId,
    stepState: input.stepState ?? "approved",
  });
  if (retryable === undefined || retryable.stepId !== input.stepId) {
    return { started: false };
  }

  const nextAttemptNumber = retryable.attemptNumber + 1;
  const canonicalAttemptId = deriveDispatchAttemptId(
    input.runId,
    input.stepId,
    nextAttemptNumber,
  );
  // Round indices stay monotone across the whole step (attempt after attempt),
  // so cross-attempt round ordering is always (attemptNumber, roundIndex).
  const nextRoundIndex = retryable.latestRoundIndex + 1;

  const savepoint = "start_retryable_dispatch_attempt";
  const rollback = (): void => {
    db.exec(
      `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
    );
  };
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    let nextAttemptId = canonicalAttemptId;
    let allocationSuffix = 0;
    while (true) {
      try {
        insertExecutorAttempt(
          db,
          {
            attemptId: nextAttemptId,
            workflowRunId: retryable.runId,
            stepRunId: retryable.stepId,
            stepKey: retryable.stepId,
            executorFamily: retryable.executorFamily,
            state: "running",
            attemptNumber: nextAttemptNumber,
            startedAt: input.now,
            heartbeatAt: null,
            finishedAt: null,
          },
          { now: input.now },
        );
        break;
      } catch (error) {
        if (!(error instanceof ExecutorAttemptConflictError)) throw error;
        const concurrentRetry = db
          .prepare(
            `SELECT 1
               FROM executor_attempts
              WHERE workflow_run_id = ?
                AND step_run_id = ?
                AND attempt_number = ?`,
          )
          .get(retryable.runId, retryable.stepId, nextAttemptNumber);
        if (concurrentRetry !== undefined) {
          rollback();
          return { started: false };
        }
        allocationSuffix += 1;
        nextAttemptId = `${canonicalAttemptId}::allocated-${allocationSuffix}`;
      }
    }

    if (input.executorOwnsRounds !== true) {
      const canonicalRound = buildRetryRound(
        retryable,
        nextAttemptId,
        nextAttemptNumber,
        nextRoundIndex,
        input.selection ?? DEFAULT_RETRY_ROUND_SELECTION,
      );
      let nextRoundId = canonicalRound.roundId;
      let roundAllocationSuffix = 0;
      while (true) {
        try {
          insertExecutorRound(
            db,
            { ...canonicalRound, roundId: nextRoundId },
            { now: input.now },
          );
          break;
        } catch (error) {
          if (!(error instanceof ExecutorRoundConflictError)) throw error;
          const concurrentRound = db
            .prepare(
              `SELECT 1
                 FROM executor_rounds
                WHERE attempt_id = ? AND round_index = ?`,
            )
            .get(nextAttemptId, nextRoundIndex);
          if (concurrentRound !== undefined) {
            rollback();
            return { started: false };
          }
          roundAllocationSuffix += 1;
          nextRoundId = `${canonicalRound.roundId}::allocated-${roundAllocationSuffix}`;
        }
      }
    }

    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      started: true,
      attemptId: nextAttemptId,
      attemptNumber: nextAttemptNumber,
      roundIndex: nextRoundIndex,
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

function parseRetryableDispatchRow(
  row: RetryableDispatchRow | undefined,
): RetryableDispatchedStepRecovery | undefined {
  if (row === undefined) return undefined;
  if (!isWorkflowStepKind(row.kind)) return undefined;
  if (!isExecutorName(row.executor_family)) return undefined;
  if (
    row.executor_family === "external-apply" ||
    row.executor_family === "subworkflow"
  ) {
    return undefined;
  }
  if (
    row.round_index === null ||
    row.recovery_code === null ||
    !isRetryableAttemptState(row.attempt_state, row.recovery_code) ||
    !isRetryableDispatchRecovery(row.executor_family, row.recovery_code)
  ) {
    return undefined;
  }

  return {
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    attemptId: row.attempt_id,
    executorFamily: row.executor_family,
    attemptNumber: row.attempt_number,
    latestRoundIndex: row.round_index,
    recoveryCode: row.recovery_code,
    stepOrder: row.step_order,
    required: row.required === 1,
    startedAt: row.started_at,
  };
}

function appendRetryableStepStartedEventBeforeClear(
  db: MomentumDb,
  retryable: RetryableDispatchedStepRecovery,
): void {
  if (retryable.startedAt === null) return;
  const payload = {
    kind: retryable.kind,
    order: retryable.stepOrder,
    required: retryable.required,
  };
  appendWorkflowEvent(db, {
    runId: retryable.runId,
    type: "step_started",
    occurredAt: retryable.startedAt,
    stepId: retryable.stepId,
    payload,
    eventId: buildWorkflowEventId({
      runId: retryable.runId,
      type: "step_started",
      timestamp: retryable.startedAt,
      stepId: retryable.stepId,
      payload,
      source: "step",
    }),
  });
}

function buildRetryRound(
  retryable: RetryableDispatchedStepRecovery,
  attemptId: string,
  attemptNumber: number,
  roundIndex: number,
  selection: RetryRoundSelection,
): ExecutorRoundRecord {
  return {
    roundId: `${attemptId}::round-${roundIndex}`,
    attemptId,
    workflowRunId: retryable.runId,
    stepRunId: retryable.stepId,
    stepKey: retryable.stepId,
    executorFamily: retryable.executorFamily,
    attemptNumber,
    roundIndex,
    state: "pending",
    classification: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    agentProvider: selection.agentProvider,
    model: selection.model,
    effort: selection.effort,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null,
  };
}

function isWorkflowStepKind(value: string): value is WorkflowStepKind {
  return WORKFLOW_STEP_KINDS.includes(value as WorkflowStepKind);
}

function isRetryableDispatchRecovery(
  executorFamily: ExecutorName,
  recoveryCode: string,
): boolean {
  if (GENERIC_RETRYABLE_DISPATCH_RECOVERY_CODES.has(recoveryCode)) return true;
  return (
    (executorFamily === "delegate-supervisor" ||
      executorFamily === "no-mistakes") &&
    DELEGATE_RETRYABLE_DISPATCH_RECOVERY_CODES.has(recoveryCode)
  );
}

function isRetryableAttemptState(
  attemptState: string,
  recoveryCode: string,
): attemptState is RetryableAttemptState {
  return (
    attemptState === "manual_recovery_required" ||
    (attemptState === "blocked" && recoveryCode === "external_state_blocked")
  );
}
