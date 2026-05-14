import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadDaemonStatus } from "../src/daemon-status.js";
import { openDb } from "../src/db.js";
import {
  acquireRepoLock,
  releaseRepoLock
} from "../src/repo-locks.js";
import {
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob,
  releaseClaimedGoalIterationJob
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

function makeTempDir(prefix = "momentum-daemon-status-"): string {
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

describe("loadDaemonStatus stale lease detection", () => {
  it("returns empty stale arrays when no leases exist", () => {
    const dataDir = makeTempDir();
    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 5_000
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleRepoLocks).toEqual([]);
    expect(result.staleClaimedJobs).toEqual([]);
    expect(result.staleLeaseGraceMs).toBeGreaterThan(0);
  });

  it("flags an active repo lock whose lease has expired beyond the grace window", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    let lockId: string;
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "job-1",
        leaseExpiresAt: 1_000,
        now: 500
      });
      if (!acquired.ok) throw new Error("seed lock did not acquire");
      lockId = acquired.lockId;
    } finally {
      db.close();
    }

    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 100_000,
      staleLeaseGraceMs: 0
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleRepoLocks).toHaveLength(1);
    const [summary] = result.staleRepoLocks;
    expect(summary).toMatchObject({
      lockId,
      repoRoot: "/tmp/repo",
      holder: "worker-a",
      goalId: "g1",
      iteration: 1,
      jobId: "job-1",
      state: "active",
      acquiredAt: 500,
      heartbeatAt: 500,
      leaseExpiresAt: 1_000,
      leaseExpiredAgeMs: 99_000
    });
  });

  it("respects the configured grace window for repo locks", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      acquireRepoLock(db, {
        repoRoot: "/tmp/repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "job-1",
        leaseExpiresAt: 1_000,
        now: 500
      });
    } finally {
      db.close();
    }

    const stillFresh = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 2_000,
      staleLeaseGraceMs: 5_000
    });
    expect(stillFresh.ok).toBe(true);
    if (stillFresh.ok) {
      expect(stillFresh.staleRepoLocks).toEqual([]);
    }

    const expired = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 10_000,
      staleLeaseGraceMs: 5_000
    });
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(expired.staleRepoLocks).toHaveLength(1);
    }
  });

  it("does not surface released repo locks", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "job-1",
        leaseExpiresAt: 1_000,
        now: 500
      });
      if (!acquired.ok) throw new Error("seed lock did not acquire");
      releaseRepoLock(db, { lockId: acquired.lockId, now: 600 });
    } finally {
      db.close();
    }

    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 100_000,
      staleLeaseGraceMs: 0
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staleRepoLocks).toEqual([]);
    }
  });

  it("flags a claimed goal_iteration job whose lease has expired", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    let jobId: string;
    try {
      seedGoal(db);
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      jobId = enqueued.jobId;
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 1_000,
        now: 200
      });
      expect(claimed.ok).toBe(true);
    } finally {
      db.close();
    }

    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 50_000,
      staleLeaseGraceMs: 0
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staleClaimedJobs).toHaveLength(1);
    const [summary] = result.staleClaimedJobs;
    expect(summary).toMatchObject({
      jobId,
      goalId: "g1",
      iteration: 1,
      state: "claimed",
      attemptCount: 1,
      workerId: "worker-a",
      leaseAcquiredAt: 200,
      leaseExpiresAt: 1_200,
      heartbeatAt: 200,
      leaseExpiredAgeMs: 48_800
    });
  });

  it("does not surface pending or released jobs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 1_000,
        now: 200
      });
      if (!claimed.ok) throw new Error("seed claim failed");
      releaseClaimedGoalIterationJob(db, {
        jobId: claimed.job.id,
        workerId: "worker-a",
        reason: "test-release",
        now: 300
      });
      const released = getQueueJob(db, claimed.job.id);
      expect(released?.state).toBe("pending");
    } finally {
      db.close();
    }

    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      now: 100_000,
      staleLeaseGraceMs: 0
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staleClaimedJobs).toEqual([]);
    }
  });

  it("validates staleLeaseGraceMs as non-negative", () => {
    const dataDir = makeTempDir();
    const result = loadDaemonStatus({
      dataDirOptions: { dataDir },
      staleLeaseGraceMs: -1,
      now: 1_000
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_input");
      expect(result.error).toMatch(/staleLeaseGraceMs/);
    }
  });
});
