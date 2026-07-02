/**
 * Read-only loader for `workflow run logs` (RC-1 goal-first read-back parity).
 *
 * The workflow-first equivalent of goal-first `logs <goal-id>`: it surfaces a
 * run's durable logs/evidence for operator inspection without any mutation. It
 * composes {@link loadWorkflowRunDetail} (run / steps / approvals / leases /
 * monitor / evidence / gates) with the per-round executor evidence that the
 * run-detail loader deliberately omits — agent/model identity, log paths,
 * summaries, key changes, changed files, verification status, commit SHA, and
 * recovery codes, plus child artifacts / checkpoints / findings / decisions —
 * so an operator migrating off goal `logs` keeps the same "what ran and what it
 * produced" read-back.
 *
 * No SQLite mutation, no file reads, no external writes.
 */
import type { MomentumDb } from "../../../adapters/db.js";
import {
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  listExecutorRoundsForRun
} from "../../executors/loop/persist.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorRoundRecord
} from "../../executors/loop/reducer.js";
import {
  loadWorkflowRunDetail,
  type LoadWorkflowRunDetailOptions,
  type WorkflowRunDetail
} from "./status.js";

export const WORKFLOW_RUN_LOGS_SCHEMA_VERSION = 1;

export type LoadWorkflowRunLogsOptions = LoadWorkflowRunDetailOptions & {
  generatedAt?: number;
};

export type WorkflowRunLogRound = ExecutorRoundRecord & {
  artifacts: ExecutorArtifactRecord[];
  checkpoints: ExecutorCheckpointRecord[];
  findings: ExecutorFindingRecord[];
  decisions: ExecutorDecisionRecord[];
};

export type WorkflowRunLogsEnvelope = {
  schemaVersion: number;
  generatedAt: number;
  detail: WorkflowRunDetail;
  rounds: WorkflowRunLogRound[];
};

export function loadWorkflowRunLogs(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowRunLogsOptions = {}
): WorkflowRunLogsEnvelope | null {
  const detail = loadWorkflowRunDetail(db, runId, options);
  if (detail === null) return null;
  const generatedAt = options.generatedAt ?? Date.now();
  const rounds = listExecutorRoundsForRun(db, runId).map((round) => ({
    ...round,
    artifacts: listExecutorArtifactsForRound(db, round.roundId),
    checkpoints: listExecutorCheckpointsForRound(db, round.roundId),
    findings: listExecutorFindingsForRound(db, round.roundId),
    decisions: listExecutorDecisionsForRound(db, round.roundId)
  }));
  return {
    schemaVersion: WORKFLOW_RUN_LOGS_SCHEMA_VERSION,
    generatedAt,
    detail,
    rounds
  };
}
