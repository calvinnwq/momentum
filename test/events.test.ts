import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  QUEUE_EVENT_TYPES,
  appendQueueEvent,
  isQueueEventType
} from "../src/events.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-events-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

describe("queue event taxonomy", () => {
  it("exposes the full Milestone 2 event vocabulary", () => {
    expect(Object.values(QUEUE_EVENT_TYPES).sort()).toEqual(
      [
        "goal.completed",
        "goal.failed",
        "goal.reduced",
        "job.claimed",
        "job.enqueued",
        "job.failed",
        "job.heartbeat",
        "job.succeeded"
      ]
    );
  });

  it("isQueueEventType narrows known and rejects unknown types", () => {
    expect(isQueueEventType("job.enqueued")).toBe(true);
    expect(isQueueEventType("goal.completed")).toBe(true);
    expect(isQueueEventType("iteration_started")).toBe(false);
    expect(isQueueEventType("nope")).toBe(false);
  });
});

describe("appendQueueEvent", () => {
  it("inserts a typed event with payload and returns the inserted row", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = appendQueueEvent(db, {
        goalId: "g1",
        jobId: "j1",
        type: QUEUE_EVENT_TYPES.JOB_ENQUEUED,
        payload: { iteration: 1, idempotency_key: "k" },
        createdAt: 1_700_000_000_000
      });
      expect(out.id).toBeGreaterThan(0);
      expect(out.type).toBe("job.enqueued");
      expect(out.jobId).toBe("j1");

      const row = db
        .prepare("SELECT goal_id, job_id, type, payload, created_at FROM events WHERE id = ?")
        .get(out.id) as Record<string, unknown>;
      expect(row["goal_id"]).toBe("g1");
      expect(row["job_id"]).toBe("j1");
      expect(row["type"]).toBe("job.enqueued");
      expect(row["created_at"]).toBe(1_700_000_000_000);
      expect(JSON.parse(row["payload"] as string)).toEqual({
        iteration: 1,
        idempotency_key: "k"
      });
    } finally {
      db.close();
    }
  });

  it("defaults jobId to NULL and payload to an empty object", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = appendQueueEvent(db, {
        goalId: "g1",
        type: QUEUE_EVENT_TYPES.GOAL_REDUCED
      });
      expect(out.jobId).toBeNull();
      const row = db
        .prepare("SELECT job_id, payload FROM events WHERE id = ?")
        .get(out.id) as Record<string, unknown>;
      expect(row["job_id"]).toBeNull();
      expect(JSON.parse(row["payload"] as string)).toEqual({});
    } finally {
      db.close();
    }
  });

  it("rejects unknown event types and missing goalId", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        appendQueueEvent(db, {
          goalId: "g",
          type: "iteration_started" as never
        })
      ).toThrow(/unknown event type/);
      expect(() =>
        appendQueueEvent(db, {
          goalId: "",
          type: QUEUE_EVENT_TYPES.JOB_ENQUEUED
        })
      ).toThrow(/goalId/);
    } finally {
      db.close();
    }
  });

  it("preserves insertion order via auto-incrementing id", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const a = appendQueueEvent(db, {
        goalId: "g",
        type: QUEUE_EVENT_TYPES.JOB_ENQUEUED,
        createdAt: 100
      });
      const b = appendQueueEvent(db, {
        goalId: "g",
        type: QUEUE_EVENT_TYPES.JOB_CLAIMED,
        createdAt: 100
      });
      const c = appendQueueEvent(db, {
        goalId: "g",
        type: QUEUE_EVENT_TYPES.JOB_SUCCEEDED,
        createdAt: 100
      });
      expect(a.id).toBeLessThan(b.id);
      expect(b.id).toBeLessThan(c.id);

      const sequence = (
        db
          .prepare("SELECT type FROM events WHERE goal_id = 'g' ORDER BY id ASC")
          .all() as Array<{ type: string }>
      ).map((row) => row.type);
      expect(sequence).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.succeeded"
      ]);
    } finally {
      db.close();
    }
  });
});
