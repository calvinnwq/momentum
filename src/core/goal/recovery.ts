import type { MomentumDb } from "../../adapters/db.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "../../events.js";
import { releaseRepoLock } from "../repo/locks.js";

/**
 * Mark a goal as needing manual recovery so the queue claim path skips it until
 * an operator explicitly acknowledges. The flag is durable on the goals row so
 * the claim filter does not depend on filesystem state — a deleted recovery.md
 * cannot silently re-open claims, and the in-memory recovery report is not the
 * single source of truth. Idempotent: re-marking with the same reason refreshes
 * the timestamp but leaves the flag set.
 */
export type MarkGoalNeedsManualRecoveryInput = {
  goalId: string;
  reason: string;
  now?: number;
};

export type MarkGoalNeedsManualRecoveryResult =
  | { ok: true; previouslyMarked: boolean }
  | { ok: false; reason: "goal_not_found" };

export function markGoalNeedsManualRecovery(
  db: MomentumDb,
  input: MarkGoalNeedsManualRecoveryInput
): MarkGoalNeedsManualRecoveryResult {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("markGoalNeedsManualRecovery: goalId is required");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("markGoalNeedsManualRecovery: reason is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("markGoalNeedsManualRecovery: now must be finite");
  }

  const before = db
    .prepare("SELECT needs_manual_recovery FROM goals WHERE id = ?")
    .get(input.goalId) as { needs_manual_recovery: number } | undefined;
  if (!before) {
    return { ok: false, reason: "goal_not_found" };
  }

  db.prepare(
    `UPDATE goals
       SET needs_manual_recovery = 1,
           manual_recovery_reason = ?,
           manual_recovery_at = ?,
           updated_at = ?
     WHERE id = ?`
  ).run(input.reason, now, now, input.goalId);

  return { ok: true, previouslyMarked: before.needs_manual_recovery === 1 };
}

export type ClearGoalManualRecoveryInput = {
  goalId: string;
  now?: number;
};

export type ClearGoalManualRecoveryResult =
  | { ok: true; wasMarked: boolean }
  | { ok: false; reason: "goal_not_found" };

/**
 * Clear the manual-recovery flag so the goal becomes claim-eligible again.
 * Used by the operator-facing acknowledgement flow once recovery.md has been
 * inspected and the underlying problem resolved. Does NOT delete recovery.md —
 * the artifact remains as durable audit until manually removed.
 */
export function clearGoalManualRecovery(
  db: MomentumDb,
  input: ClearGoalManualRecoveryInput
): ClearGoalManualRecoveryResult {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("clearGoalManualRecovery: goalId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("clearGoalManualRecovery: now must be finite");
  }

  const before = db
    .prepare("SELECT needs_manual_recovery FROM goals WHERE id = ?")
    .get(input.goalId) as { needs_manual_recovery: number } | undefined;
  if (!before) {
    return { ok: false, reason: "goal_not_found" };
  }

  db.prepare(
    `UPDATE goals
       SET needs_manual_recovery = 0,
           manual_recovery_reason = NULL,
           manual_recovery_at = NULL,
           updated_at = ?
     WHERE id = ?`
  ).run(now, input.goalId);

  return { ok: true, wasMarked: before.needs_manual_recovery === 1 };
}

export type GoalManualRecoveryState = {
  goalId: string;
  needsManualRecovery: boolean;
  reason: string | null;
  markedAt: number | null;
};

/**
 * Operator-facing clear flow: refuses safely when the goal is missing, not
 * flagged, or still has a live `claimed`/`running` job. This guards against
 * accidental clears that would let the queue claim path proceed while another
 * worker still holds the iteration. On success it clears the flag, releases
 * repo locks in `needs_manual_recovery` state, and appends a
 * `goal.recovery_cleared` audit event with the previously-recorded reason and
 * any released lock IDs.
 *
 * recovery.md is left on disk so the durable audit trail survives the clear —
 * operators delete it manually after capturing the context elsewhere.
 */
export type ClearGoalManualRecoveryGuardedInput = {
  goalId: string;
  operatorReason?: string;
  now?: number;
};

export type ClearGoalManualRecoveryGuardedFailureReason =
  | "goal_not_found"
  | "not_flagged"
  | "job_active";

export type ClearGoalManualRecoveryGuardedResult =
  | {
      ok: true;
      goalId: string;
      previousReason: string | null;
      previousMarkedAt: number | null;
      clearedAt: number;
      eventId: number;
    }
  | {
      ok: false;
      reason: ClearGoalManualRecoveryGuardedFailureReason;
      message: string;
      activeJobIds?: string[];
    };

export function clearGoalManualRecoveryGuarded(
  db: MomentumDb,
  input: ClearGoalManualRecoveryGuardedInput
): ClearGoalManualRecoveryGuardedResult {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("clearGoalManualRecoveryGuarded: goalId is required");
  }
  if (
    input.operatorReason !== undefined &&
    typeof input.operatorReason !== "string"
  ) {
    throw new Error(
      "clearGoalManualRecoveryGuarded: operatorReason must be a string when set"
    );
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("clearGoalManualRecoveryGuarded: now must be finite");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const state = getGoalManualRecoveryState(db, input.goalId);
    if (!state) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "goal_not_found",
        message: `Goal ${input.goalId} does not exist.`
      };
    }
    if (!state.needsManualRecovery) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "not_flagged",
        message: `Goal ${input.goalId} is not flagged for manual recovery; nothing to clear.`
      };
    }

    const activeJobs = db
      .prepare(
        `SELECT id FROM jobs
          WHERE goal_id = ?
            AND type = 'goal_iteration'
            AND state IN ('claimed', 'running')
          ORDER BY created_at ASC, id ASC`
      )
      .all(input.goalId) as Array<{ id: string }>;
    if (activeJobs.length > 0) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "job_active",
        message:
          `Goal ${input.goalId} has ${activeJobs.length} active goal_iteration ` +
          `job(s); release or finalize them before clearing manual recovery.`,
        activeJobIds: activeJobs.map((row) => row.id)
      };
    }

    const cleared = clearGoalManualRecovery(db, { goalId: input.goalId, now });
    if (!cleared.ok) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "goal_not_found",
        message: `Goal ${input.goalId} disappeared during clear.`
      };
    }
    const manualLocks = db
      .prepare(
        `SELECT id FROM repo_locks
          WHERE goal_id = ? AND state = 'needs_manual_recovery'
          ORDER BY acquired_at ASC, id ASC`
      )
      .all(input.goalId) as Array<{ id: string }>;
    for (const lock of manualLocks) {
      releaseRepoLock(db, {
        lockId: lock.id,
        now,
        recoveryStatus: "manual_recovery_cleared"
      });
    }

    const payload: Record<string, unknown> = {
      previousReason: state.reason,
      previousMarkedAt: state.markedAt,
      clearedAt: now
    };
    if (manualLocks.length > 0) {
      payload["releasedRepoLockIds"] = manualLocks.map((lock) => lock.id);
    }
    if (input.operatorReason !== undefined) {
      payload["operatorReason"] = input.operatorReason;
    }
    const event = appendQueueEvent(db, {
      goalId: input.goalId,
      type: QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED,
      payload,
      createdAt: now
    });
    db.exec("COMMIT");

    return {
      ok: true,
      goalId: input.goalId,
      previousReason: state.reason,
      previousMarkedAt: state.markedAt,
      clearedAt: now,
      eventId: event.id
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

export function getGoalManualRecoveryState(
  db: MomentumDb,
  goalId: string
): GoalManualRecoveryState | undefined {
  const row = db
    .prepare(
      `SELECT id, needs_manual_recovery, manual_recovery_reason, manual_recovery_at
       FROM goals WHERE id = ?`
    )
    .get(goalId) as
    | {
        id: string;
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
        manual_recovery_at: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    goalId: row.id,
    needsManualRecovery: row.needs_manual_recovery === 1,
    reason: row.manual_recovery_reason,
    markedAt: row.manual_recovery_at
  };
}
