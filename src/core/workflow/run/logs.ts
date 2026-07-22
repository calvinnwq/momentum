/**
 * Read-only loader for `workflow run logs`.
 *
 * This surfaces a run's durable logs/evidence for operator inspection without
 * any mutation. It composes {@link loadWorkflowRunDetail} (run / steps /
 * approvals / leases / monitor / evidence / gates) with the per-round executor
 * evidence that the run-detail loader deliberately omits: agent/model identity,
 * log paths, summaries, key changes, changed files, verification status, commit
 * SHA, and recovery codes, plus child artifacts / checkpoints / findings /
 * decisions.
 *
 * No SQLite mutation, no file reads, no external writes.
 */
import type { MomentumDb } from "../../../adapters/db.js";
import {
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  listExecutorAttemptsForRun,
  listExecutorRoundsForRun,
  hasExecutorDefinition,
} from "../../executors/loop/persist.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorAttemptRecord,
  ExecutorRoundRecord,
} from "../../executors/loop/reducer.js";
import {
  loadWorkflowRunDetail,
  type LoadWorkflowRunDetailOptions,
  type WorkflowRunDetail,
} from "./status.js";

/**
 * Version 2 replaced the legacy `invocations` array (mutable reopened rows with
 * an `attempt` counter) with immutable `attempts` (`attemptId` /
 * `attemptNumber`), and re-keyed rounds by `attemptId` / `attemptNumber`.
 */
export const WORKFLOW_RUN_LOGS_SCHEMA_VERSION = 3;

export type LoadWorkflowRunLogsOptions = LoadWorkflowRunDetailOptions & {
  generatedAt?: number;
};

export type WorkflowRunLogRound = ExecutorRoundRecord & {
  executorIdentityDurablyClaimed: boolean;
  artifacts: ExecutorArtifactRecord[];
  checkpoints: ExecutorCheckpointRecord[];
  findings: ExecutorFindingRecord[];
  decisions: ExecutorDecisionRecord[];
};

export type WorkflowRunLogsEnvelope = {
  schemaVersion: number;
  generatedAt: number;
  detail: WorkflowRunDetail;
  attempts: ExecutorAttemptRecord[];
  rounds: WorkflowRunLogRound[];
};

export function loadWorkflowRunLogs(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowRunLogsOptions = {},
): WorkflowRunLogsEnvelope | null {
  const detail = loadWorkflowRunDetail(db, runId, options);
  if (detail === null) return null;
  const generatedAt = options.generatedAt ?? Date.now();
  const attempts = listExecutorAttemptsForRun(db, runId);
  const rounds = listExecutorRoundsForRun(db, runId).map((round) => ({
    ...round,
    executorIdentityDurablyClaimed: hasExecutorDefinition(db, round.executor),
    artifacts: listExecutorArtifactsForRound(db, round.roundId),
    checkpoints: listExecutorCheckpointsForRound(db, round.roundId),
    findings: listExecutorFindingsForRound(db, round.roundId),
    decisions: listExecutorDecisionsForRound(db, round.roundId),
  }));
  return {
    schemaVersion: WORKFLOW_RUN_LOGS_SCHEMA_VERSION,
    generatedAt,
    detail,
    attempts,
    rounds,
  };
}
