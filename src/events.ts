import type { MomentumDb } from "./db.js";

export const QUEUE_EVENT_TYPES = {
  JOB_ENQUEUED: "job.enqueued",
  JOB_CLAIMED: "job.claimed",
  JOB_HEARTBEAT: "job.heartbeat",
  JOB_RELEASED: "job.released",
  JOB_SUCCEEDED: "job.succeeded",
  JOB_FAILED: "job.failed",
  GOAL_REDUCED: "goal.reduced",
  GOAL_COMPLETED: "goal.completed",
  GOAL_FAILED: "goal.failed"
} as const;

export type QueueEventType =
  (typeof QUEUE_EVENT_TYPES)[keyof typeof QUEUE_EVENT_TYPES];

const ALL_QUEUE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(QUEUE_EVENT_TYPES)
);

export function isQueueEventType(value: string): value is QueueEventType {
  return ALL_QUEUE_EVENT_TYPES.has(value);
}

export type AppendEventInput = {
  goalId: string;
  jobId?: string | null;
  type: QueueEventType;
  payload?: Record<string, unknown>;
  createdAt?: number;
};

export type AppendedEvent = {
  id: number;
  goalId: string;
  jobId: string | null;
  type: QueueEventType;
  payload: Record<string, unknown>;
  createdAt: number;
};

/**
 * Append a typed queue event. Centralizing this prevents downstream M2 callers
 * from inventing one-off event names and keeps the event log machine-readable.
 */
export function appendQueueEvent(
  db: MomentumDb,
  input: AppendEventInput
): AppendedEvent {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("appendQueueEvent: goalId is required");
  }
  if (!isQueueEventType(input.type)) {
    throw new Error(`appendQueueEvent: unknown event type ${input.type}`);
  }
  const jobId = input.jobId ?? null;
  const payload = input.payload ?? {};
  const createdAt = input.createdAt ?? Date.now();
  const payloadJson = JSON.stringify(payload);

  const result = db
    .prepare(
      `INSERT INTO events (goal_id, job_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.goalId, jobId, input.type, payloadJson, createdAt);

  const id = Number(result.lastInsertRowid);

  return {
    id,
    goalId: input.goalId,
    jobId,
    type: input.type,
    payload,
    createdAt
  };
}
