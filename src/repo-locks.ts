import crypto from "node:crypto";

import { isUniqueViolation, type MomentumDb } from "./adapters/db.js";

export type RepoLockState = "active" | "released" | "needs_manual_recovery";

export type RepoLockRow = {
  id: string;
  repo_root: string;
  holder: string;
  goal_id: string;
  iteration: number;
  job_id: string;
  state: RepoLockState;
  recovery_status: string | null;
  acquired_at: number;
  heartbeat_at: number;
  lease_expires_at: number;
  released_at: number | null;
  updated_at: number;
};

export type AcquireRepoLockInput = {
  repoRoot: string;
  holder: string;
  goalId: string;
  iteration: number;
  jobId: string;
  leaseExpiresAt: number;
  now?: number;
};

export type AcquireRepoLockResult =
  | { ok: true; lockId: string; lock: RepoLockRow }
  | {
      ok: false;
      reason: "already_locked";
      existing: RepoLockRow;
    };

/**
 * Take an exclusive active lease on `repoRoot`. Returns an existing blocking
 * lock (`active` or `needs_manual_recovery`) when one is already held; rely on
 * the partial unique index to keep concurrent active callers honest.
 */
export function acquireRepoLock(
  db: MomentumDb,
  input: AcquireRepoLockInput
): AcquireRepoLockResult {
  validateAcquireInput(input);
  const now = input.now ?? Date.now();

  const existing = getBlockingRepoLock(db, input.repoRoot);
  if (existing) {
    return { ok: false, reason: "already_locked", existing };
  }

  const lockId = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO repo_locks
         (id, repo_root, holder, goal_id, iteration, job_id,
          state, acquired_at, heartbeat_at, lease_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(
      lockId,
      input.repoRoot,
      input.holder,
      input.goalId,
      input.iteration,
      input.jobId,
      now,
      now,
      input.leaseExpiresAt,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const racing = getActiveRepoLock(db, input.repoRoot);
      if (racing) {
        return { ok: false, reason: "already_locked", existing: racing };
      }
    }
    throw error;
  }

  const lock = getRepoLock(db, lockId);
  if (!lock) {
    throw new Error(`acquireRepoLock: lock ${lockId} disappeared after insert`);
  }
  return { ok: true, lockId, lock };
}

export type UpdateRepoLockHeartbeatInput = {
  lockId: string;
  heartbeatAt: number;
  leaseExpiresAt: number;
};

/**
 * Refresh an active repo lock only while its current lease is still fresh. A
 * heartbeat after the stored deadline returns `ok: false` instead of
 * reviving a stale active lock.
 */
export function updateRepoLockHeartbeat(
  db: MomentumDb,
  input: UpdateRepoLockHeartbeatInput
): { ok: boolean } {
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'active' AND lease_expires_at >= ?`
    )
    .run(
      input.heartbeatAt,
      input.leaseExpiresAt,
      input.heartbeatAt,
      input.lockId,
      input.heartbeatAt
    );
  return { ok: Number(result.changes) > 0 };
}

export type ReleaseRepoLockInput = {
  lockId: string;
  now?: number;
  recoveryStatus?: string;
};

export function releaseRepoLock(
  db: MomentumDb,
  input: ReleaseRepoLockInput
): { ok: boolean } {
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET state = 'released',
             released_at = ?,
             updated_at = ?,
             recovery_status = COALESCE(?, recovery_status)
       WHERE id = ? AND state IN ('active', 'needs_manual_recovery')`
    )
    .run(now, now, input.recoveryStatus ?? null, input.lockId);
  return { ok: Number(result.changes) > 0 };
}

export type MarkRepoLockNeedsManualRecoveryInput = {
  lockId: string;
  now?: number;
  recoveryStatus?: string;
};

export function markRepoLockNeedsManualRecovery(
  db: MomentumDb,
  input: MarkRepoLockNeedsManualRecoveryInput
): { ok: boolean } {
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET state = 'needs_manual_recovery',
             updated_at = ?,
             recovery_status = COALESCE(?, recovery_status)
       WHERE id = ? AND state = 'active'`
    )
    .run(now, input.recoveryStatus ?? null, input.lockId);
  return { ok: Number(result.changes) > 0 };
}

export type ListStaleRepoLocksInput = {
  now: number;
  graceMs?: number;
};

/**
 * Return active repo locks whose `lease_expires_at` is older than `now` (minus
 * an optional `graceMs` tolerance for small clock skew). The lease deadline is
 * the contract between worker and lock; once it has passed, the holder no
 * longer owns the lock and the row is a candidate for stale-lease recovery.
 * This helper is read-only — M3-05 surfaces stale locks deterministically but
 * leaves recovery decisions to higher-level orchestrator slices that can
 * verify repo state, holder liveness, and metadata invariants first.
 */
export function listStaleRepoLocks(
  db: MomentumDb,
  input: ListStaleRepoLocksInput
): RepoLockRow[] {
  if (!Number.isFinite(input.now)) {
    throw new Error("listStaleRepoLocks: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "listStaleRepoLocks: graceMs must be a non-negative finite number"
    );
  }
  const cutoff = input.now - graceMs;
  return db
    .prepare(
      `SELECT * FROM repo_locks
       WHERE state = 'active'
         AND lease_expires_at < ?
       ORDER BY lease_expires_at ASC, id ASC`
    )
    .all(cutoff) as RepoLockRow[];
}

/**
 * Return an active repo lock whose `job_id` matches. Used by stale-claim
 * recovery to refuse re-pending a claim that still has an associated active
 * repo lock — releasing that lock is a separate (more dangerous) recovery
 * action that must be handled by the lock-side primitives or manual recovery.
 */
export function getActiveRepoLockForJob(
  db: MomentumDb,
  jobId: string
): RepoLockRow | undefined {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new Error("getActiveRepoLockForJob: jobId is required");
  }
  return db
    .prepare(
      `SELECT * FROM repo_locks
       WHERE job_id = ? AND state = 'active'
       ORDER BY acquired_at DESC LIMIT 1`
    )
    .get(jobId) as RepoLockRow | undefined;
}

export function getActiveRepoLock(
  db: MomentumDb,
  repoRoot: string
): RepoLockRow | undefined {
  return db
    .prepare(
      `SELECT * FROM repo_locks WHERE repo_root = ? AND state = 'active'
       ORDER BY acquired_at DESC LIMIT 1`
    )
    .get(repoRoot) as RepoLockRow | undefined;
}

export function getBlockingRepoLock(
  db: MomentumDb,
  repoRoot: string
): RepoLockRow | undefined {
  return db
    .prepare(
      `SELECT * FROM repo_locks
       WHERE repo_root = ? AND state IN ('active', 'needs_manual_recovery')
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, acquired_at DESC
       LIMIT 1`
    )
    .get(repoRoot) as RepoLockRow | undefined;
}

export function getRepoLock(
  db: MomentumDb,
  lockId: string
): RepoLockRow | undefined {
  return db
    .prepare("SELECT * FROM repo_locks WHERE id = ?")
    .get(lockId) as RepoLockRow | undefined;
}

function validateAcquireInput(input: AcquireRepoLockInput): void {
  if (typeof input.repoRoot !== "string" || input.repoRoot.length === 0) {
    throw new Error("acquireRepoLock: repoRoot is required");
  }
  if (typeof input.holder !== "string" || input.holder.length === 0) {
    throw new Error("acquireRepoLock: holder is required");
  }
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("acquireRepoLock: goalId is required");
  }
  if (!Number.isInteger(input.iteration) || input.iteration < 1) {
    throw new Error("acquireRepoLock: iteration must be a positive integer");
  }
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("acquireRepoLock: jobId is required");
  }
  if (
    !Number.isInteger(input.leaseExpiresAt) ||
    input.leaseExpiresAt <= 0
  ) {
    throw new Error(
      "acquireRepoLock: leaseExpiresAt must be a positive integer ms timestamp"
    );
  }
}
