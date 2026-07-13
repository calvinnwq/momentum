import type { MomentumDb } from "../../../adapters/db.js";
import { insertExecutorRound } from "../../executors/loop/persist.js";
import type { ExecutorRoundRecord } from "../../executors/loop/reducer.js";
import { isExecutorName, type ExecutorName } from "../definition/definition.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import { WORKFLOW_STEP_KINDS, type WorkflowStepKind } from "../run/reducer.js";
import { appendWorkflowEvent, buildWorkflowEventId } from "../run/events.js";

const RETRYABLE_DISPATCH_RECOVERY_CODES: ReadonlySet<string> = new Set([
  "unsupported_platform",
  "runtime_unavailable",
  "executor_threw",
  "executor_contract_invalid",
  "tool_adapter_unavailable",
  "delegate_handoff_failed",
  "delegate_handoff_recovery_required",
  "external_state_unreadable",
  "external_state_inconsistent",
]);

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
  invocationId: string;
  executorFamily: ExecutorName;
  invocationState: "manual_recovery_required";
  attempt: number;
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
  state: string;
  invocation_id: string;
  executor_family: string;
  invocation_state: string;
  attempt: number;
  round_index: number | null;
  recovery_code: string | null;
  step_order: number;
  required: number;
  started_at: number | null;
};

export function findRetryableDispatchedStepRecovery(
  db: MomentumDb,
  input: { runId: string; stepState: RetryableStepState },
): RetryableDispatchedStepRecovery | undefined {
  const rows = db
    .prepare(
      `SELECT step_id, kind, state
         FROM workflow_steps
        WHERE run_id = ? AND state = ?
        ORDER BY step_order, step_id`,
    )
    .all(input.runId, input.stepState) as Array<{
    step_id: string;
    kind: string;
    state: string;
  }>;

  for (const step of rows) {
    if (!isWorkflowStepKind(step.kind)) continue;
    const invocationId = deriveDispatchRetryInvocationId(
      input.runId,
      step.step_id,
    );
    const row = db
      .prepare(
        `SELECT s.run_id,
                s.step_id,
                s.kind,
                s.state,
                s.step_order,
                s.required,
                s.started_at,
                i.invocation_id,
                i.executor_family,
                i.state AS invocation_state,
                i.attempt,
                r.round_index,
                r.recovery_code
           FROM workflow_steps AS s
           JOIN executor_invocations AS i
             ON i.workflow_run_id = s.run_id
            AND i.step_run_id = s.step_id
            AND i.invocation_id = ?
           LEFT JOIN executor_rounds AS r
             ON r.invocation_id = i.invocation_id
            AND r.round_index = (
              SELECT MAX(round_index)
                FROM executor_rounds
               WHERE invocation_id = i.invocation_id
            )
          WHERE s.run_id = ?
            AND s.step_id = ?
            AND s.state = ?`,
      )
      .get(invocationId, input.runId, step.step_id, input.stepState) as
      RetryableDispatchRow | undefined;
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
    recoveryCode: retryable.recoveryCode,
  };
}

export type ReopenRetryableDispatchInvocationResult =
  | { reopened: false }
  | {
      reopened: true;
      invocationId: string;
      attempt: number;
      roundIndex: number;
    };

export function reopenRetryableDispatchInvocationForAttempt(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    now: number;
    stepState?: RetryableStepState;
    selection?: RetryRoundSelection;
    executorOwnsRounds?: boolean;
  },
): ReopenRetryableDispatchInvocationResult {
  const retryable = findRetryableDispatchedStepRecovery(db, {
    runId: input.runId,
    stepState: input.stepState ?? "approved",
  });
  if (retryable === undefined || retryable.stepId !== input.stepId) {
    return { reopened: false };
  }

  const nextAttempt = retryable.attempt + 1;
  const nextRoundIndex = retryable.latestRoundIndex + 1;

  const updated = db
    .prepare(
      `UPDATE executor_invocations
          SET state = 'running',
              attempt = ?,
              started_at = ?,
              heartbeat_at = NULL,
              finished_at = NULL,
              updated_at = ?
        WHERE invocation_id = ?
          AND state = 'manual_recovery_required'
          AND attempt = ?`,
    )
    .run(
      nextAttempt,
      input.now,
      input.now,
      retryable.invocationId,
      retryable.attempt,
    );
  if (Number(updated.changes) === 0) return { reopened: false };

  if (input.executorOwnsRounds !== true) {
    insertExecutorRound(
      db,
      buildRetryRound(
        retryable,
        nextAttempt,
        nextRoundIndex,
        input.selection ?? DEFAULT_RETRY_ROUND_SELECTION,
      ),
      { now: input.now },
    );
  }

  return {
    reopened: true,
    invocationId: retryable.invocationId,
    attempt: nextAttempt,
    roundIndex: nextRoundIndex,
  };
}

export function deriveDispatchRetryInvocationId(
  runId: string,
  stepId: string,
): string {
  return `${runId}::${stepId}::dispatch`;
}

function parseRetryableDispatchRow(
  row: RetryableDispatchRow | undefined,
): RetryableDispatchedStepRecovery | undefined {
  if (row === undefined) return undefined;
  if (!isWorkflowStepKind(row.kind)) return undefined;
  if (row.invocation_state !== "manual_recovery_required") return undefined;
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
    !isRetryableDispatchRecovery(row.kind, row.recovery_code)
  ) {
    return undefined;
  }

  return {
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    invocationId: row.invocation_id,
    executorFamily: row.executor_family,
    invocationState: "manual_recovery_required",
    attempt: row.attempt,
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
  attempt: number,
  roundIndex: number,
  selection: RetryRoundSelection,
): ExecutorRoundRecord {
  return {
    roundId: `${retryable.invocationId}::round-${roundIndex}`,
    invocationId: retryable.invocationId,
    workflowRunId: retryable.runId,
    stepRunId: retryable.stepId,
    stepKey: retryable.stepId,
    executorFamily: retryable.executorFamily,
    attempt,
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
  _kind: WorkflowStepKind,
  recoveryCode: string,
): boolean {
  return RETRYABLE_DISPATCH_RECOVERY_CODES.has(recoveryCode);
}
