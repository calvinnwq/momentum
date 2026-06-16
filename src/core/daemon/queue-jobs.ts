import crypto from "node:crypto";

import { isUniqueViolation, type MomentumDb } from "../../adapters/db.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "../../shared/events.js";
import {
  getRepoLock,
  updateRepoLockHeartbeat,
  type RepoLockRow
} from "../repo/locks.js";

export const GOAL_ITERATION_JOB_TYPE = "goal_iteration";

export type QueueJobState =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed";

export type EnqueueGoalIterationInput = {
  goalId: string;
  iteration: number;
  idempotencyKey: string;
  artifactPath: string;
  now?: number;
};

export type EnqueueGoalIterationResult = {
  jobId: string;
  jobState: QueueJobState;
  created: boolean;
};

export type QueueJobRow = {
  id: string;
  goal_id: string;
  type: string;
  iteration: number;
  state: QueueJobState;
  attempt_count: number;
  artifact_path: string;
  idempotency_key: string | null;
  worker_id: string | null;
  lease_acquired_at: number | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  result_path: string | null;
  error_path: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
};

/**
 * Insert a `goal_iteration` job, or return the existing job for the same
 * idempotency key. Duplicate inserts are deterministic: the existing job id
 * is returned and no new row is written.
 */
export function enqueueGoalIterationJob(
  db: MomentumDb,
  input: EnqueueGoalIterationInput
): EnqueueGoalIterationResult {
  validateEnqueueInput(input);
  const now = input.now ?? Date.now();

  const existing = getJobByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    if (existing.goal_id !== input.goalId) {
      throw new Error(
        `enqueueGoalIterationJob: idempotency_key ${input.idempotencyKey} ` +
          `already bound to goal ${existing.goal_id}`
      );
    }
    return { jobId: existing.id, jobState: existing.state, created: false };
  }

  const jobId = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO jobs
         (id, goal_id, type, iteration, state, attempt_count,
          artifact_path, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
    ).run(
      jobId,
      input.goalId,
      GOAL_ITERATION_JOB_TYPE,
      input.iteration,
      input.artifactPath,
      input.idempotencyKey,
      now,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Concurrent enqueue won the partial unique index race; surface its row.
      const racing = getJobByIdempotencyKey(db, input.idempotencyKey);
      if (racing) {
        if (racing.goal_id !== input.goalId) {
          throw new Error(
            `enqueueGoalIterationJob: idempotency_key ${input.idempotencyKey} ` +
              `already bound to goal ${racing.goal_id}`
          );
        }
        return { jobId: racing.id, jobState: racing.state, created: false };
      }
    }
    throw error;
  }

  appendQueueEvent(db, {
    goalId: input.goalId,
    jobId,
    type: QUEUE_EVENT_TYPES.JOB_ENQUEUED,
    payload: {
      iteration: input.iteration,
      idempotency_key: input.idempotencyKey,
      artifact_path: input.artifactPath,
      type: GOAL_ITERATION_JOB_TYPE
    },
    createdAt: now
  });

  return { jobId, jobState: "pending", created: true };
}

export type ClaimGoalIterationInput = {
  workerId: string;
  leaseDurationMs: number;
  now?: number;
};

export type ClaimGoalIterationResult =
  | { ok: true; job: QueueJobRow }
  | { ok: false; reason: "no_pending_jobs" };

/**
 * Atomically transition the oldest pending, unblocked `goal_iteration` job to
 * `claimed`, stamp lease/worker metadata, and emit `job.claimed`. The UPDATE
 * re-checks both `state = 'pending'` and the goal's manual-recovery flag so a
 * concurrent recovery mark cannot be bypassed between candidate selection and
 * claim.
 */
export function claimPendingGoalIterationJob(
  db: MomentumDb,
  input: ClaimGoalIterationInput
): ClaimGoalIterationResult {
  validateClaimInput(input);
  const now = input.now ?? Date.now();
  const leaseExpiresAt = now + input.leaseDurationMs;

  const candidate = db
    .prepare(
      `SELECT jobs.id
         FROM jobs
         JOIN goals ON goals.id = jobs.goal_id
        WHERE jobs.state = 'pending'
          AND jobs.type = ?
          AND goals.needs_manual_recovery = 0
        ORDER BY jobs.created_at ASC, jobs.id ASC
        LIMIT 1`
    )
    .get(GOAL_ITERATION_JOB_TYPE) as { id: string } | undefined;

  if (!candidate) {
    return { ok: false, reason: "no_pending_jobs" };
  }

  const claimed = db
    .prepare(
      `UPDATE jobs
         SET state = 'claimed',
             worker_id = ?,
             lease_acquired_at = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             updated_at = ?,
             attempt_count = attempt_count + 1
       WHERE id = ?
         AND state = 'pending'
         AND EXISTS (
           SELECT 1
             FROM goals
            WHERE goals.id = jobs.goal_id
              AND goals.needs_manual_recovery = 0
         )
       RETURNING *`
    )
    .get(
      input.workerId,
      now,
      leaseExpiresAt,
      now,
      now,
      candidate.id
    ) as QueueJobRow | undefined;

  if (!claimed) {
    return { ok: false, reason: "no_pending_jobs" };
  }

  appendQueueEvent(db, {
    goalId: claimed.goal_id,
    jobId: claimed.id,
    type: QUEUE_EVENT_TYPES.JOB_CLAIMED,
    payload: {
      iteration: claimed.iteration,
      worker_id: input.workerId,
      lease_acquired_at: now,
      lease_expires_at: leaseExpiresAt,
      attempt_count: claimed.attempt_count
    },
    createdAt: now
  });

  return { ok: true, job: claimed };
}

export type HeartbeatGoalIterationInput = {
  jobId: string;
  lockId: string;
  workerId: string;
  leaseDurationMs: number;
  now?: number;
};

export type HeartbeatGoalIterationFailureReason =
  | "job_not_active"
  | "lock_not_active";

export type HeartbeatGoalIterationResult =
  | { ok: true; job: QueueJobRow; lock: RepoLockRow }
  | { ok: false; reason: HeartbeatGoalIterationFailureReason };

/**
 * Refresh the lease/heartbeat columns on a claimed `goal_iteration` job and
 * its repo lock, then emit `job.heartbeat`. Both updates are guarded so a
 * worker can't heartbeat a job it no longer owns. The job update is scoped by
 * worker_id and state ∈ (claimed, running) to keep stale workers out; the
 * lock refresh is scoped by `state = 'active'` inside `updateRepoLockHeartbeat`.
 * When either guard fails, no event is emitted and the caller can release.
 */
export function heartbeatGoalIterationJob(
  db: MomentumDb,
  input: HeartbeatGoalIterationInput
): HeartbeatGoalIterationResult {
  validateHeartbeatInput(input);
  const now = input.now ?? Date.now();
  const leaseExpiresAt = now + input.leaseDurationMs;

  const updatedJob = db
    .prepare(
      `UPDATE jobs
         SET heartbeat_at = ?,
             lease_expires_at = ?,
             updated_at = ?
       WHERE id = ?
         AND type = ?
         AND worker_id = ?
         AND state IN ('claimed', 'running')
       RETURNING *`
    )
    .get(
      now,
      leaseExpiresAt,
      now,
      input.jobId,
      GOAL_ITERATION_JOB_TYPE,
      input.workerId
    ) as QueueJobRow | undefined;

  if (!updatedJob) {
    return { ok: false, reason: "job_not_active" };
  }

  const lockUpdate = updateRepoLockHeartbeat(db, {
    lockId: input.lockId,
    heartbeatAt: now,
    leaseExpiresAt
  });
  if (!lockUpdate.ok) {
    return { ok: false, reason: "lock_not_active" };
  }

  const lock = getRepoLock(db, input.lockId);
  if (!lock) {
    return { ok: false, reason: "lock_not_active" };
  }

  appendQueueEvent(db, {
    goalId: updatedJob.goal_id,
    jobId: updatedJob.id,
    type: QUEUE_EVENT_TYPES.JOB_HEARTBEAT,
    payload: {
      iteration: updatedJob.iteration,
      worker_id: input.workerId,
      lock_id: input.lockId,
      heartbeat_at: now,
      lease_expires_at: leaseExpiresAt
    },
    createdAt: now
  });

  return { ok: true, job: updatedJob, lock };
}

export type ReleaseClaimedGoalIterationInput = {
  jobId: string;
  workerId: string;
  reason: string;
  now?: number;
};

export type ReleaseClaimedGoalIterationFailureReason = "job_not_claimed";

export type ReleaseClaimedGoalIterationResult =
  | { ok: true; job: QueueJobRow }
  | { ok: false; reason: ReleaseClaimedGoalIterationFailureReason };

/**
 * Revert a claimed `goal_iteration` job to `pending`, clearing worker/lease
 * metadata, and emit `job.released`. The worker loop uses this to surrender a
 * claim it cannot honor (e.g. the repo lock is already held by another
 * holder). The UPDATE is guarded by worker_id, type, and `state = 'claimed'`
 * so a worker can only release its own pre-execution claim. `attempt_count`
 * is preserved to keep contention visible to future backoff/recovery logic.
 */
export function releaseClaimedGoalIterationJob(
  db: MomentumDb,
  input: ReleaseClaimedGoalIterationInput
): ReleaseClaimedGoalIterationResult {
  validateReleaseInput(input);
  const now = input.now ?? Date.now();

  const released = db
    .prepare(
      `UPDATE jobs
         SET state = 'pending',
             worker_id = NULL,
             lease_acquired_at = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             updated_at = ?
       WHERE id = ?
         AND type = ?
         AND worker_id = ?
         AND state = 'claimed'
       RETURNING *`
    )
    .get(now, input.jobId, GOAL_ITERATION_JOB_TYPE, input.workerId) as
    | QueueJobRow
    | undefined;

  if (!released) {
    return { ok: false, reason: "job_not_claimed" };
  }

  appendQueueEvent(db, {
    goalId: released.goal_id,
    jobId: released.id,
    type: QUEUE_EVENT_TYPES.JOB_RELEASED,
    payload: {
      iteration: released.iteration,
      worker_id: input.workerId,
      reason: input.reason,
      attempt_count: released.attempt_count
    },
    createdAt: now
  });

  return { ok: true, job: released };
}

export type ListStaleClaimedGoalIterationJobsInput = {
  now: number;
  graceMs?: number;
};

/**
 * Return `goal_iteration` jobs in `claimed` or `running` state whose
 * `lease_expires_at` is older than `now` (minus an optional `graceMs`
 * tolerance for clock skew). The lease is the worker's contract; once it
 * lapses, the claim is a candidate for stale-lease recovery. M3-05 keeps
 * detection read-only here so higher-level orchestrator slices can decide
 * whether a stale claim is safe to requeue (e.g. repo is clean, no other
 * worker is heartbeating, metadata invariants hold).
 */
export function listStaleClaimedGoalIterationJobs(
  db: MomentumDb,
  input: ListStaleClaimedGoalIterationJobsInput
): QueueJobRow[] {
  if (!Number.isFinite(input.now)) {
    throw new Error("listStaleClaimedGoalIterationJobs: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "listStaleClaimedGoalIterationJobs: graceMs must be a non-negative finite number"
    );
  }
  const cutoff = input.now - graceMs;
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE type = ?
         AND state IN ('claimed', 'running')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
       ORDER BY lease_expires_at ASC, id ASC`
    )
    .all(GOAL_ITERATION_JOB_TYPE, cutoff) as QueueJobRow[];
}

export type RependStaleClaimedGoalIterationInput = {
  jobId: string;
  now?: number;
};

export type RependStaleClaimedGoalIterationResult =
  | { ok: true; job: QueueJobRow; previousWorkerId: string | null; previousLeaseExpiresAt: number | null }
  | { ok: false; reason: "job_not_stale_claimed" };

/**
 * Re-pend a stale `claimed` goal_iteration job back to `pending` without an
 * owner check. Unlike `releaseClaimedGoalIterationJob`, this does NOT require a
 * `worker_id` match because the orchestrator is recovering an orphaned claim
 * whose worker is presumed dead. The UPDATE is guarded by
 * `state = 'claimed' AND lease_expires_at < now` so an in-flight claim with a
 * fresh lease is never demoted. Does not emit an event; the caller composes
 * with `appendQueueEvent` so the recovery action is observed atomically with
 * any other recovery bookkeeping (lock release, status surfaces).
 *
 * `attempt_count` is preserved: the failed attempt is durable history and the
 * next worker that claims the row will see the incremented count from the
 * dead worker's claim.
 */
export function recoverStaleClaimedGoalIterationJob(
  db: MomentumDb,
  input: RependStaleClaimedGoalIterationInput
): RependStaleClaimedGoalIterationResult {
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("recoverStaleClaimedGoalIterationJob: jobId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("recoverStaleClaimedGoalIterationJob: now must be finite");
  }

  const before = getQueueJob(db, input.jobId);
  if (!before || before.state !== "claimed") {
    return { ok: false, reason: "job_not_stale_claimed" };
  }
  const previousWorkerId = before.worker_id;
  const previousLeaseExpiresAt = before.lease_expires_at;

  const updated = db
    .prepare(
      `UPDATE jobs
         SET state = 'pending',
             worker_id = NULL,
             lease_acquired_at = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             updated_at = ?
       WHERE id = ?
         AND type = ?
         AND state = 'claimed'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
       RETURNING *`
    )
    .get(now, input.jobId, GOAL_ITERATION_JOB_TYPE, now) as
    | QueueJobRow
    | undefined;

  if (!updated) {
    return { ok: false, reason: "job_not_stale_claimed" };
  }

  return { ok: true, job: updated, previousWorkerId, previousLeaseExpiresAt };
}

export function getQueueJob(
  db: MomentumDb,
  jobId: string
): QueueJobRow | undefined {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(jobId) as QueueJobRow | undefined;
}

export function getJobByIdempotencyKey(
  db: MomentumDb,
  idempotencyKey: string
): QueueJobRow | undefined {
  return db
    .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
    .get(idempotencyKey) as QueueJobRow | undefined;
}

function validateClaimInput(input: ClaimGoalIterationInput): void {
  if (typeof input.workerId !== "string" || input.workerId.length === 0) {
    throw new Error("claimPendingGoalIterationJob: workerId is required");
  }
  if (
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    throw new Error(
      "claimPendingGoalIterationJob: leaseDurationMs must be a positive number"
    );
  }
}

function validateReleaseInput(input: ReleaseClaimedGoalIterationInput): void {
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("releaseClaimedGoalIterationJob: jobId is required");
  }
  if (typeof input.workerId !== "string" || input.workerId.length === 0) {
    throw new Error("releaseClaimedGoalIterationJob: workerId is required");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("releaseClaimedGoalIterationJob: reason is required");
  }
}

function validateHeartbeatInput(input: HeartbeatGoalIterationInput): void {
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("heartbeatGoalIterationJob: jobId is required");
  }
  if (typeof input.lockId !== "string" || input.lockId.length === 0) {
    throw new Error("heartbeatGoalIterationJob: lockId is required");
  }
  if (typeof input.workerId !== "string" || input.workerId.length === 0) {
    throw new Error("heartbeatGoalIterationJob: workerId is required");
  }
  if (
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  ) {
    throw new Error(
      "heartbeatGoalIterationJob: leaseDurationMs must be a positive number"
    );
  }
}

function validateEnqueueInput(input: EnqueueGoalIterationInput): void {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("enqueueGoalIterationJob: goalId is required");
  }
  if (!Number.isInteger(input.iteration) || input.iteration < 1) {
    throw new Error(
      "enqueueGoalIterationJob: iteration must be a positive integer"
    );
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0
  ) {
    throw new Error("enqueueGoalIterationJob: idempotencyKey is required");
  }
  if (typeof input.artifactPath !== "string" || input.artifactPath.length === 0) {
    throw new Error("enqueueGoalIterationJob: artifactPath is required");
  }
}
