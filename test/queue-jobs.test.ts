import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getJobByIdempotencyKey,
  getQueueJob,
  heartbeatGoalIterationJob,
  listStaleClaimedGoalIterationJobs,
  releaseClaimedGoalIterationJob
} from "../src/queue-jobs.js";
import {
  acquireRepoLock,
  getRepoLock,
  releaseRepoLock
} from "../src/repo-locks.js";

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

describe("heartbeatGoalIterationJob", () => {
  function seedClaimedJob(
    db: ReturnType<typeof openDb>,
    options: {
      goalId?: string;
      workerId?: string;
      claimNow?: number;
      leaseDurationMs?: number;
      repoRoot?: string;
    } = {}
  ): {
    jobId: string;
    lockId: string;
    workerId: string;
    repoRoot: string;
  } {
    const goalId = options.goalId ?? "g1";
    const workerId = options.workerId ?? "worker-a";
    const claimNow = options.claimNow ?? 1_700_000_001_000;
    const leaseDurationMs = options.leaseDurationMs ?? 5_000;
    const repoRoot = options.repoRoot ?? "/tmp/momentum-test-repo";

    seedGoal(db, goalId);
    const enq = enqueueGoalIterationJob(db, {
      goalId,
      iteration: 1,
      idempotencyKey: `${goalId}:1`,
      artifactPath: `/tmp/${goalId}/it/1`,
      now: claimNow - 1_000
    });
    const claim = claimPendingGoalIterationJob(db, {
      workerId,
      leaseDurationMs,
      now: claimNow
    });
    if (!claim.ok) throw new Error("seedClaimedJob: claim failed");
    const lock = acquireRepoLock(db, {
      repoRoot,
      holder: workerId,
      goalId,
      iteration: 1,
      jobId: claim.job.id,
      leaseExpiresAt: claim.job.lease_expires_at!,
      now: claimNow
    });
    if (!lock.ok) throw new Error("seedClaimedJob: lock acquire failed");
    return { jobId: enq.jobId, lockId: lock.lockId, workerId, repoRoot };
  }

  it("refreshes job and lock heartbeat columns and emits job.heartbeat", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, lockId, workerId } = seedClaimedJob(db);

      const beat = heartbeatGoalIterationJob(db, {
        jobId,
        lockId,
        workerId,
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(beat.ok).toBe(true);
      if (!beat.ok) return;
      expect(beat.job.heartbeat_at).toBe(1_700_000_003_000);
      expect(beat.job.lease_expires_at).toBe(1_700_000_008_000);
      expect(beat.job.updated_at).toBe(1_700_000_003_000);
      expect(beat.job.state).toBe("claimed");
      expect(beat.lock.heartbeat_at).toBe(1_700_000_003_000);
      expect(beat.lock.lease_expires_at).toBe(1_700_000_008_000);

      const persistedJob = getQueueJob(db, jobId);
      expect(persistedJob?.heartbeat_at).toBe(1_700_000_003_000);
      expect(persistedJob?.lease_expires_at).toBe(1_700_000_008_000);
      const persistedLock = getRepoLock(db, lockId);
      expect(persistedLock?.heartbeat_at).toBe(1_700_000_003_000);
      expect(persistedLock?.lease_expires_at).toBe(1_700_000_008_000);

      const beats = db
        .prepare(
          `SELECT job_id, type, payload, created_at FROM events
             WHERE goal_id = 'g1' AND type = 'job.heartbeat'
             ORDER BY id ASC`
        )
        .all() as Array<{
        job_id: string | null;
        type: string;
        payload: string;
        created_at: number;
      }>;
      expect(beats).toHaveLength(1);
      expect(beats[0]!.job_id).toBe(jobId);
      expect(beats[0]!.created_at).toBe(1_700_000_003_000);
      expect(JSON.parse(beats[0]!.payload)).toEqual({
        iteration: 1,
        worker_id: workerId,
        lock_id: lockId,
        heartbeat_at: 1_700_000_003_000,
        lease_expires_at: 1_700_000_008_000
      });
    } finally {
      db.close();
    }
  });

  it("also refreshes while the job is in the running state", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, lockId, workerId } = seedClaimedJob(db);
      db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);

      const beat = heartbeatGoalIterationJob(db, {
        jobId,
        lockId,
        workerId,
        leaseDurationMs: 5_000,
        now: 1_700_000_004_000
      });
      expect(beat.ok).toBe(true);
      if (!beat.ok) return;
      expect(beat.job.state).toBe("running");
      expect(beat.job.heartbeat_at).toBe(1_700_000_004_000);
    } finally {
      db.close();
    }
  });

  it("returns job_not_active when the worker_id does not match and emits no event", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, lockId } = seedClaimedJob(db);

      const beat = heartbeatGoalIterationJob(db, {
        jobId,
        lockId,
        workerId: "intruder",
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(beat).toEqual({ ok: false, reason: "job_not_active" });

      const persistedJob = getQueueJob(db, jobId);
      expect(persistedJob?.worker_id).toBe("worker-a");
      expect(persistedJob?.heartbeat_at).toBe(1_700_000_001_000);

      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'job.heartbeat'"
        )
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("returns job_not_active when the job has been finalized", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, lockId, workerId } = seedClaimedJob(db);
      db.prepare("UPDATE jobs SET state = 'succeeded' WHERE id = ?").run(jobId);

      const beat = heartbeatGoalIterationJob(db, {
        jobId,
        lockId,
        workerId,
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(beat).toEqual({ ok: false, reason: "job_not_active" });
    } finally {
      db.close();
    }
  });

  it("returns lock_not_active when the repo lock has been released", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, lockId, workerId } = seedClaimedJob(db);
      releaseRepoLock(db, { lockId, now: 1_700_000_002_000 });

      const beat = heartbeatGoalIterationJob(db, {
        jobId,
        lockId,
        workerId,
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(beat).toEqual({ ok: false, reason: "lock_not_active" });

      // Job lease columns were refreshed but no job.heartbeat event was emitted.
      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'job.heartbeat'"
        )
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("ignores non-goal_iteration jobs even if worker_id matches", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      db.prepare(
        `INSERT INTO jobs (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, worker_id, lease_acquired_at, lease_expires_at,
            heartbeat_at, created_at, updated_at)
         VALUES ('foreground-1', 'g1', 'foreground_iteration', 1, 'running', 1,
                 '/tmp/g1/it/1', 'worker-a', ?, ?, ?, ?, ?)`
      ).run(
        1_700_000_000_000,
        1_700_000_005_000,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000
      );
      const lock = acquireRepoLock(db, {
        repoRoot: "/tmp/momentum-test-repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "foreground-1",
        leaseExpiresAt: 1_700_000_005_000,
        now: 1_700_000_000_000
      });
      if (!lock.ok) throw new Error("expected lock");

      const beat = heartbeatGoalIterationJob(db, {
        jobId: "foreground-1",
        lockId: lock.lockId,
        workerId: "worker-a",
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(beat).toEqual({ ok: false, reason: "job_not_active" });
    } finally {
      db.close();
    }
  });

  it("validates required heartbeat inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const base = {
        jobId: "j",
        lockId: "l",
        workerId: "w",
        leaseDurationMs: 5_000
      };
      expect(() =>
        heartbeatGoalIterationJob(db, { ...base, jobId: "" })
      ).toThrow(/jobId/);
      expect(() =>
        heartbeatGoalIterationJob(db, { ...base, lockId: "" })
      ).toThrow(/lockId/);
      expect(() =>
        heartbeatGoalIterationJob(db, { ...base, workerId: "" })
      ).toThrow(/workerId/);
      expect(() =>
        heartbeatGoalIterationJob(db, { ...base, leaseDurationMs: 0 })
      ).toThrow(/leaseDurationMs/);
      expect(() =>
        heartbeatGoalIterationJob(db, { ...base, leaseDurationMs: -1 })
      ).toThrow(/leaseDurationMs/);
    } finally {
      db.close();
    }
  });
});

describe("releaseClaimedGoalIterationJob", () => {
  function seedClaimed(
    db: ReturnType<typeof openDb>,
    options: {
      goalId?: string;
      workerId?: string;
      enqueueNow?: number;
      claimNow?: number;
      leaseDurationMs?: number;
    } = {}
  ): { jobId: string; workerId: string; goalId: string } {
    const goalId = options.goalId ?? "g1";
    const workerId = options.workerId ?? "worker-a";
    const enqueueNow = options.enqueueNow ?? 1_700_000_000_000;
    const claimNow = options.claimNow ?? 1_700_000_001_000;
    const leaseDurationMs = options.leaseDurationMs ?? 5_000;

    seedGoal(db, goalId);
    const enq = enqueueGoalIterationJob(db, {
      goalId,
      iteration: 1,
      idempotencyKey: `${goalId}:1`,
      artifactPath: `/tmp/${goalId}/it/1`,
      now: enqueueNow
    });
    const claim = claimPendingGoalIterationJob(db, {
      workerId,
      leaseDurationMs,
      now: claimNow
    });
    if (!claim.ok) throw new Error("seedClaimed: claim failed");
    return { jobId: enq.jobId, workerId, goalId };
  }

  it("reverts the claimed job to pending, clears lease metadata, and emits job.released", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, workerId, goalId } = seedClaimed(db);

      const release = releaseClaimedGoalIterationJob(db, {
        jobId,
        workerId,
        reason: "repo_locked",
        now: 1_700_000_002_000
      });
      expect(release.ok).toBe(true);
      if (!release.ok) return;
      expect(release.job.id).toBe(jobId);
      expect(release.job.state).toBe("pending");
      expect(release.job.worker_id).toBeNull();
      expect(release.job.lease_acquired_at).toBeNull();
      expect(release.job.lease_expires_at).toBeNull();
      expect(release.job.heartbeat_at).toBeNull();
      expect(release.job.attempt_count).toBe(1);
      expect(release.job.updated_at).toBe(1_700_000_002_000);
      expect(release.job.started_at).toBeNull();
      expect(release.job.finished_at).toBeNull();

      const persisted = getQueueJob(db, jobId);
      expect(persisted?.state).toBe("pending");
      expect(persisted?.worker_id).toBeNull();
      expect(persisted?.lease_acquired_at).toBeNull();
      expect(persisted?.lease_expires_at).toBeNull();
      expect(persisted?.heartbeat_at).toBeNull();

      const events = db
        .prepare(
          `SELECT job_id, type, payload, created_at FROM events
             WHERE goal_id = ? AND type = 'job.released'
             ORDER BY id ASC`
        )
        .all(goalId) as Array<{
        job_id: string | null;
        type: string;
        payload: string;
        created_at: number;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0]!.job_id).toBe(jobId);
      expect(events[0]!.created_at).toBe(1_700_000_002_000);
      expect(JSON.parse(events[0]!.payload)).toEqual({
        iteration: 1,
        worker_id: workerId,
        reason: "repo_locked",
        attempt_count: 1
      });
    } finally {
      db.close();
    }
  });

  it("allows a subsequent worker to claim the released job in pending state", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, workerId } = seedClaimed(db);
      const release = releaseClaimedGoalIterationJob(db, {
        jobId,
        workerId,
        reason: "repo_locked",
        now: 1_700_000_002_000
      });
      expect(release.ok).toBe(true);

      const reclaim = claimPendingGoalIterationJob(db, {
        workerId: "worker-b",
        leaseDurationMs: 5_000,
        now: 1_700_000_003_000
      });
      expect(reclaim.ok).toBe(true);
      if (!reclaim.ok) return;
      expect(reclaim.job.id).toBe(jobId);
      expect(reclaim.job.worker_id).toBe("worker-b");
      expect(reclaim.job.state).toBe("claimed");
      // attempt_count keeps climbing across release/reclaim cycles.
      expect(reclaim.job.attempt_count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("returns job_not_claimed when the worker_id does not match and emits no event", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId } = seedClaimed(db);

      const release = releaseClaimedGoalIterationJob(db, {
        jobId,
        workerId: "intruder",
        reason: "repo_locked",
        now: 1_700_000_002_000
      });
      expect(release).toEqual({ ok: false, reason: "job_not_claimed" });

      const persisted = getQueueJob(db, jobId);
      expect(persisted?.state).toBe("claimed");
      expect(persisted?.worker_id).toBe("worker-a");

      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'job.released'"
        )
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses to release a job that has moved past claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { jobId, workerId } = seedClaimed(db);
      db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);

      const release = releaseClaimedGoalIterationJob(db, {
        jobId,
        workerId,
        reason: "voluntary",
        now: 1_700_000_002_000
      });
      expect(release).toEqual({ ok: false, reason: "job_not_claimed" });

      const persisted = getQueueJob(db, jobId);
      expect(persisted?.state).toBe("running");
      expect(persisted?.worker_id).toBe("worker-a");
    } finally {
      db.close();
    }
  });

  it("ignores non-goal_iteration jobs even when worker_id matches", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      db.prepare(
        `INSERT INTO jobs (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, worker_id, lease_acquired_at, lease_expires_at,
            heartbeat_at, created_at, updated_at)
         VALUES ('foreground-1', 'g1', 'foreground_iteration', 1, 'claimed', 1,
                 '/tmp/g1/it/1', 'worker-a', ?, ?, ?, ?, ?)`
      ).run(
        1_700_000_000_000,
        1_700_000_005_000,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000
      );

      const release = releaseClaimedGoalIterationJob(db, {
        jobId: "foreground-1",
        workerId: "worker-a",
        reason: "repo_locked",
        now: 1_700_000_002_000
      });
      expect(release).toEqual({ ok: false, reason: "job_not_claimed" });

      const row = getQueueJob(db, "foreground-1");
      expect(row?.state).toBe("claimed");
      expect(row?.worker_id).toBe("worker-a");
    } finally {
      db.close();
    }
  });

  it("validates required release inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const base = {
        jobId: "j",
        workerId: "w",
        reason: "r"
      };
      expect(() =>
        releaseClaimedGoalIterationJob(db, { ...base, jobId: "" })
      ).toThrow(/jobId/);
      expect(() =>
        releaseClaimedGoalIterationJob(db, { ...base, workerId: "" })
      ).toThrow(/workerId/);
      expect(() =>
        releaseClaimedGoalIterationJob(db, { ...base, reason: "" })
      ).toThrow(/reason/);
    } finally {
      db.close();
    }
  });
});

describe("listStaleClaimedGoalIterationJobs", () => {
  it("returns claimed/running jobs whose lease has expired", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const enq = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 1_000,
        now: 200
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const stale = listStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(stale.map((row) => row.id)).toEqual([enq.jobId]);
      expect(stale[0]?.state).toBe("claimed");
    } finally {
      db.close();
    }
  });

  it("excludes claimed jobs whose lease is still in the future", () => {
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
      claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 10_000,
        now: 200
      });

      expect(
        listStaleClaimedGoalIterationJobs(db, { now: 5_000 })
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("excludes pending, succeeded, and failed jobs even with ancient lease metadata", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      // Pending job — never claimed, no lease metadata.
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      // Insert a synthetic succeeded job with a long-expired lease to confirm
      // the helper only considers in-flight claims, not terminal records.
      db.prepare(
        `INSERT INTO jobs
           (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, idempotency_key,
            worker_id, lease_acquired_at, lease_expires_at, heartbeat_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'succeeded', 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "succeeded-job",
        "g1",
        GOAL_ITERATION_JOB_TYPE,
        2,
        "/tmp/test/iterations/2",
        "g1:2",
        "worker-a",
        50,
        100,
        80,
        50,
        100
      );

      expect(
        listStaleClaimedGoalIterationJobs(db, { now: 1_000_000 })
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("orders multiple stale claims by lease_expires_at ascending", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      // Two synthetic claimed jobs with different lease windows.
      db.prepare(
        `INSERT INTO jobs
           (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, idempotency_key,
            worker_id, lease_acquired_at, lease_expires_at, heartbeat_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "job-a",
        "g1",
        GOAL_ITERATION_JOB_TYPE,
        1,
        "/tmp/test/iterations/1",
        "g1:1",
        "worker-a",
        100,
        2_000,
        150,
        100,
        150
      );
      db.prepare(
        `INSERT INTO jobs
           (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, idempotency_key,
            worker_id, lease_acquired_at, lease_expires_at, heartbeat_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "job-b",
        "g1",
        GOAL_ITERATION_JOB_TYPE,
        2,
        "/tmp/test/iterations/2",
        "g1:2",
        "worker-b",
        100,
        1_000,
        150,
        100,
        150
      );

      const stale = listStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(stale.map((row) => row.id)).toEqual(["job-b", "job-a"]);
    } finally {
      db.close();
    }
  });

  it("supports an optional graceMs to tolerate small clock skew", () => {
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
      claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 1_000,
        now: 200
      });

      // lease_expires_at == 1_200. With graceMs 5_000 and now 2_000, still not stale.
      expect(
        listStaleClaimedGoalIterationJobs(db, {
          now: 2_000,
          graceMs: 5_000
        })
      ).toEqual([]);
      const stale = listStaleClaimedGoalIterationJobs(db, {
        now: 10_000,
        graceMs: 5_000
      });
      expect(stale).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("validates now and graceMs inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        listStaleClaimedGoalIterationJobs(db, { now: Number.NaN })
      ).toThrow(/now/);
      expect(() =>
        listStaleClaimedGoalIterationJobs(db, { now: 100, graceMs: -1 })
      ).toThrow(/graceMs/);
      expect(() =>
        listStaleClaimedGoalIterationJobs(db, {
          now: 100,
          graceMs: Number.NaN
        })
      ).toThrow(/graceMs/);
    } finally {
      db.close();
    }
  });
});
