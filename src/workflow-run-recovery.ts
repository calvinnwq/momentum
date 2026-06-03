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
 * This module owns the mark/clear/get primitives plus the guarded operator
 * clear ({@link clearWorkflowRunManualRecoveryGuarded}). The guarded clear
 * re-derives M7 monitor blockers before clearing and refuses with
 * `recovery_clear_refused` while one persists. M9 live dispatch / finalization
 * can also mark the same flag with non-monitor classifications, so guarded
 * clear cannot independently prove that recovery work is complete; operators
 * must resolve the stored reason and any rendered artifact or context before
 * clearing. The M10 scheduler lane also marks the flag for stale workflow-lease
 * recovery, but stale `manual-recovery-required` leases remain durable and can
 * still be re-derived as `manual_recovery_lease` blockers until resolved.
 */

import type { MomentumDb } from "./db.js";
import { loadWorkflowRunDetail } from "./workflow-status.js";
import type { WorkflowMonitorRecoveryCode } from "./workflow-monitor-state.js";

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
 * layered on top owns that check. Any rendered recovery.md is intentionally
 * left on disk as durable audit; operators remove it after capturing the
 * context elsewhere.
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

/**
 * The monitor-reducer recovery codes that represent a hard blocking condition:
 * a manual-recovery lease holding the run blocked, a ghost / stale running step
 * with no live evidence, or a failed required step. While any of these is still
 * classified by `deriveWorkflowMonitorState`, clearing the durable flag would
 * re-open transitions that make recovery worse, so the guarded clear refuses.
 *
 * `monitor_drift_stale` is deliberately excluded: it is an advisory drift
 * between a (possibly stale) monitor snapshot and the substrate, not a hard
 * block — the substrate itself shows the run progressing — so it never on its
 * own keeps a run from being cleared once an operator has resolved the cause.
 */
export const BLOCKING_WORKFLOW_RECOVERY_CODES: ReadonlySet<WorkflowMonitorRecoveryCode> =
  new Set<WorkflowMonitorRecoveryCode>([
    "manual_recovery_lease",
    "ghost_active_no_lease",
    "stale_running_step",
    "failed_required_step"
  ]);

export function isBlockingWorkflowRecoveryCode(
  code: WorkflowMonitorRecoveryCode
): boolean {
  return BLOCKING_WORKFLOW_RECOVERY_CODES.has(code);
}

export type ClearWorkflowRunManualRecoveryGuardedInput = {
  runId: string;
  now?: number;
  /** Lease-freshness grace window forwarded to the monitor re-derivation. */
  graceMs?: number;
  /** Running-step checkpoint staleness window forwarded to the re-derivation. */
  checkpointStaleMs?: number;
};

export type ClearWorkflowRunManualRecoveryGuardedFailureReason =
  | "run_not_found"
  | "not_flagged"
  | "recovery_clear_refused";

export type ClearWorkflowRunManualRecoveryGuardedResult =
  | {
      ok: true;
      runId: string;
      previousReason: string | null;
      previousMarkedAt: number | null;
      clearedAt: number;
    }
  | {
      ok: false;
      reason: ClearWorkflowRunManualRecoveryGuardedFailureReason;
      message: string;
      recoveryCode?: WorkflowMonitorRecoveryCode;
      blockingStepId?: string | null;
    };

/**
 * Operator-facing guarded clear: the explicit, auditable path that re-derives
 * the M7 monitor state and only clears the durable manual-recovery flag when no
 * monitor-derived blocking condition remains. Refuses safely when the run is
 * missing (`run_not_found`), not flagged (`not_flagged`), or still classified
 * with a blocking monitor recovery code (`recovery_clear_refused`). Live
 * dispatch / finalization recovery uses the same flag but has no monitor
 * blocker to re-derive here, so clearing those entries is an operator assertion
 * that the captured reason and any rendered artifact or context have been
 * resolved. The check and the clear run inside a single immediate transaction
 * so the condition that is checked is the condition that is cleared.
 *
 * Any rendered recovery.md is intentionally left on disk as durable audit;
 * operators delete it after capturing the context elsewhere, mirroring the M3
 * goal-scoped clear.
 */
export function clearWorkflowRunManualRecoveryGuarded(
  db: MomentumDb,
  input: ClearWorkflowRunManualRecoveryGuardedInput
): ClearWorkflowRunManualRecoveryGuardedResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("clearWorkflowRunManualRecoveryGuarded: runId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("clearWorkflowRunManualRecoveryGuarded: now must be finite");
  }

  const detailOptions: {
    now: number;
    graceMs?: number;
    checkpointStaleMs?: number;
  } = { now };
  if (input.graceMs !== undefined) detailOptions.graceMs = input.graceMs;
  if (input.checkpointStaleMs !== undefined) {
    detailOptions.checkpointStaleMs = input.checkpointStaleMs;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const detail = loadWorkflowRunDetail(db, input.runId, detailOptions);
    if (!detail) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        message: `Workflow run ${input.runId} does not exist.`
      };
    }
    if (!detail.run.needsManualRecovery) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "not_flagged",
        message: `Workflow run ${input.runId} is not flagged for manual recovery; nothing to clear.`
      };
    }

    const recovery = detail.monitor.recovery;
    if (recovery !== null && isBlockingWorkflowRecoveryCode(recovery.code)) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "recovery_clear_refused",
        message:
          `Workflow run ${input.runId} still has a blocking recovery condition ` +
          `(${recovery.code}); resolve it before clearing manual recovery.`,
        recoveryCode: recovery.code,
        blockingStepId: recovery.stepId
      };
    }

    const previousReason = detail.run.manualRecoveryReason;
    const previousMarkedAt = detail.run.manualRecoveryAt;
    const cleared = clearWorkflowRunManualRecovery(db, {
      runId: input.runId,
      now
    });
    if (!cleared.ok) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        message: `Workflow run ${input.runId} disappeared during clear.`
      };
    }
    db.exec("COMMIT");

    return {
      ok: true,
      runId: input.runId,
      previousReason,
      previousMarkedAt,
      clearedAt: now
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so callers see the original write failure.
    }
    throw error;
  }
}
