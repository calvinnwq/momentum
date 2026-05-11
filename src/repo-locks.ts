import crypto from "node:crypto";

import type { MomentumDb } from "./db.js";

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
 * Take an exclusive active lease on `repoRoot`. Returns the existing active
 * lease when one is already held; rely on the partial unique index to keep
 * concurrent callers honest.
 */
export function acquireRepoLock(
  db: MomentumDb,
  input: AcquireRepoLockInput
): AcquireRepoLockResult {
  validateAcquireInput(input);
  const now = input.now ?? Date.now();

  const existing = getActiveRepoLock(db, input.repoRoot);
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

export function updateRepoLockHeartbeat(
  db: MomentumDb,
  input: UpdateRepoLockHeartbeatInput
): { ok: boolean } {
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'active'`
    )
    .run(input.heartbeatAt, input.leaseExpiresAt, input.heartbeatAt, input.lockId);
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
       WHERE id = ? AND state = 'active'`
    )
    .run(now, now, input.recoveryStatus ?? null, input.lockId);
  return { ok: Number(result.changes) > 0 };
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

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Error) {
    return /UNIQUE constraint failed/.test(error.message);
  }
  return false;
}
