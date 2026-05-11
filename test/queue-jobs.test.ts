import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  enqueueGoalIterationJob,
  getJobByIdempotencyKey,
  getQueueJob
} from "../src/queue-jobs.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-queue-jobs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedGoal(db: ReturnType<typeof openDb>, id = "g1"): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "test goal", "momentum/test", "/tmp/test", 1, 1);
}

describe("enqueueGoalIterationJob", () => {
  it("creates a pending goal_iteration job with idempotency_key set", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const out = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 1_700_000_000_000
      });
      expect(out.created).toBe(true);
      expect(out.jobId).toMatch(/[0-9a-f-]{36}/);

      const row = getQueueJob(db, out.jobId);
      expect(row).toBeDefined();
      expect(row!.type).toBe(GOAL_ITERATION_JOB_TYPE);
      expect(row!.state).toBe("pending");
      expect(row!.iteration).toBe(1);
      expect(row!.idempotency_key).toBe("g1:1");
      expect(row!.attempt_count).toBe(0);
      expect(row!.artifact_path).toBe("/tmp/test/iterations/1");
      expect(row!.created_at).toBe(1_700_000_000_000);
      expect(row!.updated_at).toBe(1_700_000_000_000);
      expect(row!.worker_id).toBeNull();
      expect(row!.lease_acquired_at).toBeNull();
      expect(row!.lease_expires_at).toBeNull();
      expect(row!.heartbeat_at).toBeNull();
      expect(row!.result_path).toBeNull();
      expect(row!.error_path).toBeNull();
    } finally {
      db.close();
    }
  });

  it("returns the existing job id and does not insert when idempotency_key collides", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const first = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1"
      });
      const second = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1-other"
      });
      expect(second.created).toBe(false);
      expect(second.jobId).toBe(first.jobId);

      const count = db
        .prepare("SELECT count(*) AS c FROM jobs WHERE goal_id = 'g1'")
        .get() as { c: number };
      expect(count.c).toBe(1);

      // Original artifact path is preserved.
      const row = getQueueJob(db, first.jobId);
      expect(row!.artifact_path).toBe("/tmp/test/iterations/1");
    } finally {
      db.close();
    }
  });

  it("rejects an idempotency_key reuse across goals", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "shared",
        artifactPath: "/tmp/g1/it/1"
      });
      expect(() =>
        enqueueGoalIterationJob(db, {
          goalId: "g2",
          iteration: 1,
          idempotencyKey: "shared",
          artifactPath: "/tmp/g2/it/1"
        })
      ).toThrow(/already bound to goal g1/);
    } finally {
      db.close();
    }
  });

  it("validates required inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      expect(() =>
        enqueueGoalIterationJob(db, {
          goalId: "",
          iteration: 1,
          idempotencyKey: "k",
          artifactPath: "/tmp/x"
        })
      ).toThrow(/goalId/);
      expect(() =>
        enqueueGoalIterationJob(db, {
          goalId: "g1",
          iteration: 0,
          idempotencyKey: "k",
          artifactPath: "/tmp/x"
        })
      ).toThrow(/iteration/);
      expect(() =>
        enqueueGoalIterationJob(db, {
          goalId: "g1",
          iteration: 1,
          idempotencyKey: "",
          artifactPath: "/tmp/x"
        })
      ).toThrow(/idempotencyKey/);
      expect(() =>
        enqueueGoalIterationJob(db, {
          goalId: "g1",
          iteration: 1,
          idempotencyKey: "k",
          artifactPath: ""
        })
      ).toThrow(/artifactPath/);
    } finally {
      db.close();
    }
  });

  it("getJobByIdempotencyKey returns undefined for unknown keys", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(getJobByIdempotencyKey(db, "missing")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
