import crypto from "node:crypto";

import type { MomentumDb } from "./db.js";

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
    return { jobId: existing.id, created: false };
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
        return { jobId: racing.id, created: false };
      }
    }
    throw error;
  }

  return { jobId, created: true };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
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
