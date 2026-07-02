/**
 * Machine-readable next-action envelope for OpenClaw coding-workflow runs
 * (NGX-317, M7-05).
 *
 * Composes {@link loadWorkflowRunDetail} with the monitor reducer to produce a
 * stable, read-only envelope OpenClaw tooling can consume to decide the next
 * action without re-reading the substrate. No SQLite writes, no file writes —
 * the envelope flows through stdout (or the CLI text renderer).
 */
import type { MomentumDb } from "../../../adapters/db.js";
import {
  loadWorkflowRunDetail,
  type LoadWorkflowRunDetailOptions,
  type WorkflowRunDetail
} from "./status.js";

export const WORKFLOW_HANDOFF_SCHEMA_VERSION = 1;

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
  options: LoadWorkflowHandoffOptions = {}
): WorkflowHandoffEnvelope | null {
  const detail = loadWorkflowRunDetail(db, runId, options);
  if (detail === null) return null;
  const generatedAt = options.generatedAt ?? Date.now();
  return {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    generatedAt,
    detail
  };
}
