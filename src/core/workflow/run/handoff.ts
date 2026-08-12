/**
 * Machine-readable next-action envelope for OpenClaw coding-workflow runs
 *.
 *
 * Composes {@link loadWorkflowRunDetail} with the monitor reducer to produce a
 * stable, read-only envelope OpenClaw tooling can consume to decide the next
 * action without re-reading the substrate. No SQLite writes, no file writes —
 * the envelope flows through stdout (or the CLI text renderer).
 */
import type { MomentumDb } from "../../../adapters/db.js";
import {
  WORKFLOW_RUN_SURFACE_SCHEMA_VERSION,
  loadWorkflowRunDetail,
  type LoadWorkflowRunDetailOptions,
  type WorkflowRunDetail,
} from "./status.js";

/**
 * Version 2 renamed the embedded gate anchor `invocationId` to `attemptId`
 * alongside the attempt/round model migration.
 */
export const WORKFLOW_HANDOFF_SCHEMA_VERSION =
  WORKFLOW_RUN_SURFACE_SCHEMA_VERSION;

export type LoadWorkflowHandoffOptions = LoadWorkflowRunDetailOptions & {
  generatedAt?: number;
};

export type WorkflowHandoffEnvelope = {
  schemaVersion: number;
  generatedAt: number;
  detail: WorkflowRunDetail;
};

export function loadWorkflowHandoff(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowHandoffOptions = {},
): WorkflowHandoffEnvelope | null {
  const detail = loadWorkflowRunDetail(db, runId, options);
  if (detail === null) return null;
  const generatedAt = options.generatedAt ?? Date.now();
  return {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    generatedAt,
    detail,
  };
}
