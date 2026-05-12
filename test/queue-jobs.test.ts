import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  claimPendingGoalIterationJob,
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

      const events = db
        .prepare(
          "SELECT goal_id, job_id, type, payload, created_at FROM events WHERE goal_id = 'g1' ORDER BY id ASC"
        )
        .all() as Array<{
        goal_id: string;
        job_id: string | null;
        type: string;
        payload: string;
        created_at: number;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("job.enqueued");
      expect(events[0]!.job_id).toBe(out.jobId);
      expect(events[0]!.created_at).toBe(1_700_000_000_000);
      expect(JSON.parse(events[0]!.payload)).toEqual({
        iteration: 1,
        idempotency_key: "g1:1",
        artifact_path: "/tmp/test/iterations/1",
        type: GOAL_ITERATION_JOB_TYPE
      });
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

      // Idempotent re-enqueues do not double-emit job.enqueued.
      const enqueueEvents = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE goal_id = 'g1' AND type = 'job.enqueued'"
        )
        .get() as { c: number };
      expect(enqueueEvents.c).toBe(1);
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

describe("claimPendingGoalIterationJob", () => {
  it("transitions the oldest pending job to claimed with lease metadata and emits job.claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const enq = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 1_700_000_000_000
      });

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_001_000
      });

      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.job.id).toBe(enq.jobId);
      expect(claim.job.state).toBe("claimed");
      expect(claim.job.worker_id).toBe("worker-a");
      expect(claim.job.lease_acquired_at).toBe(1_700_000_001_000);
      expect(claim.job.lease_expires_at).toBe(1_700_000_006_000);
      expect(claim.job.heartbeat_at).toBe(1_700_000_001_000);
      expect(claim.job.attempt_count).toBe(1);
      expect(claim.job.updated_at).toBe(1_700_000_001_000);
      expect(claim.job.started_at).toBeNull();
      expect(claim.job.finished_at).toBeNull();

      const row = getQueueJob(db, enq.jobId);
      expect(row?.state).toBe("claimed");
      expect(row?.worker_id).toBe("worker-a");

      const events = db
        .prepare(
          "SELECT job_id, type, payload, created_at FROM events WHERE goal_id = 'g1' ORDER BY id ASC"
        )
        .all() as Array<{
        job_id: string | null;
        type: string;
        payload: string;
        created_at: number;
      }>;
      const claimedEvents = events.filter((e) => e.type === "job.claimed");
      expect(claimedEvents).toHaveLength(1);
      expect(claimedEvents[0]!.job_id).toBe(enq.jobId);
      expect(claimedEvents[0]!.created_at).toBe(1_700_000_001_000);
      expect(JSON.parse(claimedEvents[0]!.payload)).toEqual({
        iteration: 1,
        worker_id: "worker-a",
        lease_acquired_at: 1_700_000_001_000,
        lease_expires_at: 1_700_000_006_000,
        attempt_count: 1
      });
    } finally {
      db.close();
    }
  });

  it("returns no_pending_jobs when nothing is queued", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_000_000
      });
      expect(claim).toEqual({ ok: false, reason: "no_pending_jobs" });

      const events = db
        .prepare("SELECT count(*) AS c FROM events WHERE type = 'job.claimed'")
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("never claims the same pending job twice across workers", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/g1/it/1",
        now: 1_700_000_000_000
      });

      const first = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_000_100
      });
      const second = claimPendingGoalIterationJob(db, {
        workerId: "worker-b",
        leaseDurationMs: 5_000,
        now: 1_700_000_000_200
      });

      expect(first.ok).toBe(true);
      expect(second).toEqual({ ok: false, reason: "no_pending_jobs" });
    } finally {
      db.close();
    }
  });

  it("claims pending goal_iteration jobs in FIFO order by created_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      const older = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/g1/it/1",
        now: 1_700_000_000_000
      });
      const newer = enqueueGoalIterationJob(db, {
        goalId: "g2",
        iteration: 1,
        idempotencyKey: "g2:1",
        artifactPath: "/tmp/g2/it/1",
        now: 1_700_000_005_000
      });

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_010_000
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.job.id).toBe(older.jobId);

      const remaining = getQueueJob(db, newer.jobId);
      expect(remaining?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("ignores non-goal_iteration jobs when picking work", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      db.prepare(
        `INSERT INTO jobs (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, created_at, updated_at)
         VALUES ('foreground-1', 'g1', 'foreground_iteration', 1, 'pending', 0,
                 '/tmp/g1/it/1', ?, ?)`
      ).run(1_700_000_000_000, 1_700_000_000_000);

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_001_000
      });
      expect(claim).toEqual({ ok: false, reason: "no_pending_jobs" });

      const row = getQueueJob(db, "foreground-1");
      expect(row?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("validates required claim inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        claimPendingGoalIterationJob(db, {
          workerId: "",
          leaseDurationMs: 5_000
        })
      ).toThrow(/workerId/);
      expect(() =>
        claimPendingGoalIterationJob(db, {
          workerId: "worker-a",
          leaseDurationMs: 0
        })
      ).toThrow(/leaseDurationMs/);
      expect(() =>
        claimPendingGoalIterationJob(db, {
          workerId: "worker-a",
          leaseDurationMs: -1
        })
      ).toThrow(/leaseDurationMs/);
    } finally {
      db.close();
    }
  });
});
