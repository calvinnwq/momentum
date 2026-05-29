/**
 * Durable run-scoped manual-recovery flag (NGX-327, M8-04).
 *
 * The run-scoped sibling of {@link ./goal-recovery.ts}'s goal-scoped flag. It
 * owns the durable `workflow_runs.needs_manual_recovery` /
 * `manual_recovery_reason` / `manual_recovery_at` columns so the operator-control
 * surfaces (`workflow run approve` / `update-step`) keep a single source of
 * truth for "this run is blocked until an operator clears it" that does not
 * depend on the filesystem `recovery.md` artifact — a deleted artifact cannot
 * silently re-open transitions, and the in-memory monitor advisory is not the
 * authority.
 *
 * This module is the pure mark/clear/get foundation. The guarded clear that
 * re-derives monitor state before clearing, and the CLI wiring, are layered on
 * in follow-up M8-04 slices.
 */

import type { MomentumDb } from "./db.js";

export type MarkWorkflowRunNeedsManualRecoveryInput = {
  runId: string;
  reason: string;
  now?: number;
};

export type MarkWorkflowRunNeedsManualRecoveryResult =
  | { ok: true; previouslyMarked: boolean }
  | { ok: false; reason: "run_not_found" };

/**
 * Mark a workflow run as needing manual recovery so operator transitions refuse
 * with `manual_recovery_required` until an explicit clear. Idempotent:
 * re-marking refreshes the reason and timestamp but leaves the flag set and
 * reports `previouslyMarked: true`.
 */
export function markWorkflowRunNeedsManualRecovery(
  db: MomentumDb,
  input: MarkWorkflowRunNeedsManualRecoveryInput
): MarkWorkflowRunNeedsManualRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("markWorkflowRunNeedsManualRecovery: runId is required");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("markWorkflowRunNeedsManualRecovery: reason is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("markWorkflowRunNeedsManualRecovery: now must be finite");
  }

  const before = db
    .prepare("SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?")
    .get(input.runId) as { needs_manual_recovery: number } | undefined;
  if (!before) {
    return { ok: false, reason: "run_not_found" };
  }

  db.prepare(
    `UPDATE workflow_runs
       SET needs_manual_recovery = 1,
           manual_recovery_reason = ?,
           manual_recovery_at = ?,
           updated_at = ?
     WHERE id = ?`
  ).run(input.reason, now, now, input.runId);

  return { ok: true, previouslyMarked: before.needs_manual_recovery === 1 };
}

export type ClearWorkflowRunManualRecoveryInput = {
  runId: string;
  now?: number;
};

export type ClearWorkflowRunManualRecoveryResult =
  | { ok: true; wasMarked: boolean }
  | { ok: false; reason: "run_not_found" };

/**
 * Clear the durable manual-recovery flag so operator transitions are eligible
 * again. This is the low-level primitive: it does NOT re-derive monitor state
 * or guard against a persisting blocking condition — the guarded operator clear
 * layered on top owns that check. recovery.md is intentionally left on disk as
 * durable audit; operators remove it after capturing the context elsewhere.
 */
export function clearWorkflowRunManualRecovery(
  db: MomentumDb,
  input: ClearWorkflowRunManualRecoveryInput
): ClearWorkflowRunManualRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("clearWorkflowRunManualRecovery: runId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("clearWorkflowRunManualRecovery: now must be finite");
  }

  const before = db
    .prepare("SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?")
    .get(input.runId) as { needs_manual_recovery: number } | undefined;
  if (!before) {
    return { ok: false, reason: "run_not_found" };
  }

  db.prepare(
    `UPDATE workflow_runs
       SET needs_manual_recovery = 0,
           manual_recovery_reason = NULL,
           manual_recovery_at = NULL,
           updated_at = ?
     WHERE id = ?`
  ).run(now, input.runId);

  return { ok: true, wasMarked: before.needs_manual_recovery === 1 };
}

export type WorkflowRunManualRecoveryState = {
  runId: string;
  needsManualRecovery: boolean;
  reason: string | null;
  markedAt: number | null;
};

/**
 * Read the durable run-scoped recovery state, or `undefined` when the run does
 * not exist. The single source of truth the CLI surfaces and the guarded clear
 * consult before deciding whether a run is blocked.
 */
export function getWorkflowRunManualRecoveryState(
  db: MomentumDb,
  runId: string
): WorkflowRunManualRecoveryState | undefined {
  const row = db
    .prepare(
      `SELECT id, needs_manual_recovery, manual_recovery_reason, manual_recovery_at
         FROM workflow_runs WHERE id = ?`
    )
    .get(runId) as
    | {
        id: string;
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
        manual_recovery_at: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    runId: row.id,
    needsManualRecovery: row.needs_manual_recovery === 1,
    reason: row.manual_recovery_reason,
    markedAt: row.manual_recovery_at
  };
}
