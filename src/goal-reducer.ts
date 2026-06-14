import path from "node:path";

import type { MomentumDb } from "./adapters/db.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "./events.js";
import {
  buildIterationIdempotencyKey,
  getGoal,
  type GoalRow
} from "./goal-init.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  enqueueGoalIterationJob,
  getJobByIdempotencyKey,
  getQueueJob,
  type QueueJobRow,
  type QueueJobState
} from "./queue-jobs.js";
import { evaluateGoalForSourceSatisfiedIntents } from "./update-intent-generator.js";

export const REDUCER_DECISIONS = {
  CONTINUE: "continue",
  GOAL_COMPLETE: "goal_complete",
  MAX_ITERATIONS_REACHED: "max_iterations_reached",
  ITERATION_FAILED: "iteration_failed",
  ALREADY_REDUCED: "already_reduced"
} as const;

export type ReducerDecisionKind =
  (typeof REDUCER_DECISIONS)[keyof typeof REDUCER_DECISIONS];

export type ReducerGoalState =
  | "queued"
  | "completed"
  | "max_iterations_reached"
  | "failed";

export type ReducerNextJob = {
  jobId: string;
  iteration: number;
  idempotencyKey: string;
  artifactPath: string;
  created: boolean;
};

export type ReducerResult = {
  decision: ReducerDecisionKind;
  iteration: number;
  jobState: QueueJobState;
  goalState: ReducerGoalState | string;
  completionReason: string | null;
  goalComplete: boolean | null;
  commitSha: string | null;
  nextJob: ReducerNextJob | null;
  reusedExistingDecision: boolean;
};

export type ReduceGoalIterationInput = {
  db: MomentumDb;
  goalId: string;
  jobId: string;
  now?: () => number;
};

type DecisionPlan = {
  decision: Exclude<ReducerDecisionKind, "already_reduced">;
  goalState: ReducerGoalState;
  completionReason: string | null;
};

/**
 * Tail reducer for the queued goal_iteration handler. Given a completed job
 * (state in {succeeded, failed}), updates Goal state and decides whether to
 * stop or enqueue the next iteration. Calls are idempotent: if a goal.reduced
 * event already exists for the jobId, returns the recorded decision without
 * re-emitting events or enqueueing duplicate work.
 */
export function reduceGoalIteration(
  input: ReduceGoalIterationInput
): ReducerResult {
  validateInput(input);
  const { db, goalId, jobId } = input;
  const nowFn = input.now ?? (() => Date.now());

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = findReducedDecision(db, goalId, jobId);
    if (existing) {
      db.exec("ROLLBACK");
      return existing;
    }

    const goal = getGoal(db, goalId);
    if (!goal) {
      throw new Error(`reduceGoalIteration: goal ${goalId} not found`);
    }
    const job = getQueueJob(db, jobId);
    if (!job) {
      throw new Error(`reduceGoalIteration: job ${jobId} not found`);
    }
    if (job.goal_id !== goalId) {
      throw new Error(
        `reduceGoalIteration: job ${jobId} belongs to goal ${job.goal_id}, not ${goalId}`
      );
    }
    if (job.type !== GOAL_ITERATION_JOB_TYPE) {
      throw new Error(
        `reduceGoalIteration: job ${jobId} has type ${job.type}; expected ${GOAL_ITERATION_JOB_TYPE}`
      );
    }
    if (job.state !== "succeeded" && job.state !== "failed") {
      throw new Error(
        `reduceGoalIteration: job ${jobId} is in state ${job.state}, not terminal`
      );
    }

    const completion =
      job.state === "succeeded"
        ? readIterationCompletedSummary(db, goalId, jobId)
        : { goalComplete: null, commitSha: null };
    const goalComplete = completion.goalComplete;
    const commitSha = completion.commitSha;
    const plan = decidePlan(job, goal, goalComplete);
    const at = nowFn();

    db.prepare(
      `UPDATE goals
         SET state = ?,
             current_iteration = ?,
             completion_reason = ?,
             updated_at = ?
       WHERE id = ?`
    ).run(plan.goalState, job.iteration, plan.completionReason, at, goalId);

    let nextJob: ReducerNextJob | null = null;
    if (plan.decision === REDUCER_DECISIONS.CONTINUE) {
      const nextIteration = job.iteration + 1;
      const idempotencyKey = buildIterationIdempotencyKey(goalId, nextIteration);
      const artifactPath = path.join(
        goal.artifact_dir,
        "iterations",
        String(nextIteration)
      );
      const enqueue = enqueueGoalIterationJob(db, {
        goalId,
        iteration: nextIteration,
        idempotencyKey,
        artifactPath,
        now: at
      });
      nextJob = {
        jobId: enqueue.jobId,
        iteration: nextIteration,
        idempotencyKey,
        artifactPath,
        created: enqueue.created
      };
    }

    const reducedPayload: Record<string, unknown> = {
      decision: plan.decision,
      iteration: job.iteration,
      job_state: job.state,
      goal_state: plan.goalState,
      completion_reason: plan.completionReason,
      goal_complete: goalComplete,
      commit_sha: commitSha,
      max_iterations: goal.max_iterations,
      next_job: nextJob
        ? {
            job_id: nextJob.jobId,
            iteration: nextJob.iteration,
            idempotency_key: nextJob.idempotencyKey,
            artifact_path: nextJob.artifactPath,
            created: nextJob.created
          }
        : null
    };
    appendQueueEvent(db, {
      goalId,
      jobId,
      type: QUEUE_EVENT_TYPES.GOAL_REDUCED,
      payload: reducedPayload,
      createdAt: at
    });

    if (plan.decision === REDUCER_DECISIONS.GOAL_COMPLETE) {
      evaluateGoalForSourceSatisfiedIntents(db, { goalId });
      appendQueueEvent(db, {
        goalId,
        jobId,
        type: QUEUE_EVENT_TYPES.GOAL_COMPLETED,
        payload: {
          iteration: job.iteration,
          completion_reason: plan.completionReason,
          commit_sha: commitSha
        },
        createdAt: at
      });
    } else if (
      plan.decision === REDUCER_DECISIONS.ITERATION_FAILED ||
      plan.decision === REDUCER_DECISIONS.MAX_ITERATIONS_REACHED
    ) {
      appendQueueEvent(db, {
        goalId,
        jobId,
        type: QUEUE_EVENT_TYPES.GOAL_FAILED,
        payload: {
          iteration: job.iteration,
          completion_reason: plan.completionReason,
          error: job.error,
          error_path: job.error_path
        },
        createdAt: at
      });
    }

    db.exec("COMMIT");

    return {
      decision: plan.decision,
      iteration: job.iteration,
      jobState: job.state,
      goalState: plan.goalState,
      completionReason: plan.completionReason,
      goalComplete,
      commitSha,
      nextJob,
      reusedExistingDecision: false
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function decidePlan(
  job: QueueJobRow,
  goal: GoalRow,
  goalComplete: boolean | null
): DecisionPlan {
  if (job.state === "failed") {
    return {
      decision: REDUCER_DECISIONS.ITERATION_FAILED,
      goalState: "failed",
      completionReason: job.error ?? "iteration_failed"
    };
  }
  if (goalComplete === true) {
    return {
      decision: REDUCER_DECISIONS.GOAL_COMPLETE,
      goalState: "completed",
      completionReason: "goal_complete"
    };
  }
  if (job.iteration >= goal.max_iterations) {
    return {
      decision: REDUCER_DECISIONS.MAX_ITERATIONS_REACHED,
      goalState: "max_iterations_reached",
      completionReason: `max_iterations_reached:${goal.max_iterations}`
    };
  }
  return {
    decision: REDUCER_DECISIONS.CONTINUE,
    goalState: "queued",
    completionReason: null
  };
}

function findReducedDecision(
  db: MomentumDb,
  goalId: string,
  jobId: string
): ReducerResult | null {
  const row = db
    .prepare(
      `SELECT payload FROM events
         WHERE goal_id = ? AND job_id = ? AND type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
    )
    .get(goalId, jobId, QUEUE_EVENT_TYPES.GOAL_REDUCED) as
    | { payload: string }
    | undefined;
  if (!row) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const job = getQueueJob(db, jobId);
  const goal = getGoal(db, goalId);

  const nextJobPayload = readNextJob(payload);
  let nextJob: ReducerNextJob | null = null;
  if (nextJobPayload) {
    nextJob = nextJobPayload;
  } else {
    const guessedKey =
      job && job.state === "succeeded"
        ? buildIterationIdempotencyKey(goalId, job.iteration + 1)
        : null;
    if (guessedKey) {
      const existing = getJobByIdempotencyKey(db, guessedKey);
      if (existing) {
        nextJob = {
          jobId: existing.id,
          iteration: existing.iteration,
          idempotencyKey: guessedKey,
          artifactPath: existing.artifact_path,
          created: false
        };
      }
    }
  }

  return {
    decision: REDUCER_DECISIONS.ALREADY_REDUCED,
    iteration:
      typeof payload["iteration"] === "number"
        ? (payload["iteration"] as number)
        : (job?.iteration ?? 0),
    jobState:
      (job?.state as QueueJobState | undefined) ??
      (typeof payload["job_state"] === "string"
        ? (payload["job_state"] as QueueJobState)
        : "pending"),
    goalState: goal?.state ?? readString(payload, "goal_state") ?? "",
    completionReason:
      goal?.completion_reason ?? readString(payload, "completion_reason"),
    goalComplete: readBool(payload, "goal_complete"),
    commitSha: readString(payload, "commit_sha"),
    nextJob,
    reusedExistingDecision: true
  };
}

function readIterationCompletedSummary(
  db: MomentumDb,
  goalId: string,
  jobId: string
): { goalComplete: boolean | null; commitSha: string | null } {
  const row = db
    .prepare(
      `SELECT payload FROM events
         WHERE goal_id = ? AND job_id = ? AND type = 'iteration_completed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
    )
    .get(goalId, jobId) as { payload: string } | undefined;
  if (!row) return { goalComplete: null, commitSha: null };
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const goalComplete =
      typeof payload["goal_complete"] === "boolean"
        ? (payload["goal_complete"] as boolean)
        : null;
    const commitSha =
      typeof payload["commit_sha"] === "string"
        ? (payload["commit_sha"] as string)
        : null;
    return { goalComplete, commitSha };
  } catch {
    return { goalComplete: null, commitSha: null };
  }
}

function readNextJob(payload: Record<string, unknown>): ReducerNextJob | null {
  const raw = payload["next_job"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const jobId = readString(entry, "job_id");
  const iteration =
    typeof entry["iteration"] === "number"
      ? (entry["iteration"] as number)
      : null;
  const idempotencyKey = readString(entry, "idempotency_key");
  const artifactPath = readString(entry, "artifact_path");
  if (!jobId || iteration === null || !idempotencyKey || !artifactPath) {
    return null;
  }
  return {
    jobId,
    iteration,
    idempotencyKey,
    artifactPath,
    created: false
  };
}

function readString(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function readBool(
  payload: Record<string, unknown>,
  key: string
): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function validateInput(input: ReduceGoalIterationInput): void {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("reduceGoalIteration: goalId is required");
  }
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("reduceGoalIteration: jobId is required");
  }
}
