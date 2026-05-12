import crypto from "node:crypto";

import { isUniqueViolation, type MomentumDb } from "./db.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "./events.js";

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
 * Atomically transition the oldest pending `goal_iteration` job to `claimed`,
 * stamp lease/worker metadata, and emit `job.claimed`. The `state = 'pending'`
 * guard on the UPDATE makes the claim safe under concurrent workers; the loser
 * sees `no_pending_jobs` and can retry on the next tick.
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
      `SELECT id FROM jobs
       WHERE state = 'pending' AND type = ?
       ORDER BY created_at ASC, id ASC
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
       WHERE id = ? AND state = 'pending'
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
