import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  type QueueJobState
} from "../src/queue-jobs.js";
import { acquireRepoLock, getRepoLock } from "../src/repo-locks.js";
import {
  REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
  recoverStaleRepoLocksForTerminalJobs
} from "../src/stale-recovery.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-stale-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedGoal(db: MomentumDb, id = "g1"): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "test goal", "momentum/test", "/tmp/test", 1, 1);
}

function setJobState(db: MomentumDb, jobId: string, state: QueueJobState): void {
  db.prepare(`UPDATE jobs SET state = ?, updated_at = updated_at WHERE id = ?`).run(
    state,
    jobId
  );
}

type SeedOptions = {
  repoRoot: string;
  goalId?: string;
  idempotencyKey?: string;
  leaseExpiresAt: number;
  enqueueAt?: number;
  acquireAt?: number;
};

function seedQueuedIterationWithLock(
  db: MomentumDb,
  opts: SeedOptions
): { jobId: string; lockId: string } {
  const goalId = opts.goalId ?? "g1";
  const idempotencyKey = opts.idempotencyKey ?? `${goalId}:1`;
  const enq = enqueueGoalIterationJob(db, {
    goalId,
    iteration: 1,
    idempotencyKey,
    artifactPath: `/tmp/test/${goalId}/iterations/1`,
    now: opts.enqueueAt ?? 100
  });
  const acquired = acquireRepoLock(db, {
    repoRoot: opts.repoRoot,
    holder: "worker-a",
    goalId,
    iteration: 1,
    jobId: enq.jobId,
    leaseExpiresAt: opts.leaseExpiresAt,
    now: opts.acquireAt ?? 100
  });
  if (!acquired.ok) {
    throw new Error(`failed to acquire repo lock in test fixture: ${acquired.reason}`);
  }
  return { jobId: enq.jobId, lockId: acquired.lockId };
}

describe("recoverStaleRepoLocksForTerminalJobs", () => {
  it("auto-releases a stale lock whose owning job is succeeded", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId, lockId } = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        leaseExpiresAt: 1_000
      });
      setJobState(db, jobId, "succeeded");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(out.recovered).toHaveLength(1);
      expect(out.skipped).toEqual([]);

      const entry = out.recovered[0]!;
      expect(entry.lock.id).toBe(lockId);
      expect(entry.job.id).toBe(jobId);
      expect(entry.job.state).toBe("succeeded");
      expect(entry.recoveryStatus).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
      );

      const after = getRepoLock(db, lockId);
      expect(after?.state).toBe("released");
      expect(after?.released_at).toBe(5_000);
      expect(after?.recovery_status).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
      );

      const events = db
        .prepare(
          "SELECT goal_id, job_id, type, payload, created_at FROM events WHERE type = 'repo_lock.recovered'"
        )
        .all() as Array<{
        goal_id: string;
        job_id: string | null;
        type: string;
        payload: string;
        created_at: number;
      }>;
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.goal_id).toBe("g1");
      expect(event.job_id).toBe(jobId);
      expect(event.created_at).toBe(5_000);
      expect(JSON.parse(event.payload)).toEqual({
        lock_id: lockId,
        repo_root: "/tmp/repo-a",
        holder: "worker-a",
        iteration: 1,
        lease_expires_at: 1_000,
        recovered_at: 5_000,
        recovery_status: REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
        owning_job_state: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  it("auto-releases a stale lock whose owning job is failed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId, lockId } = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        leaseExpiresAt: 1_000
      });
      setJobState(db, jobId, "failed");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(out.recovered).toHaveLength(1);
      expect(out.recovered[0]!.job.state).toBe("failed");
      expect(out.skipped).toEqual([]);

      const after = getRepoLock(db, lockId);
      expect(after?.state).toBe("released");
      expect(after?.recovery_status).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
      );
    } finally {
      db.close();
    }
  });

  it("refuses to auto-release when the owning job is still claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const enq = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/g1/iterations/1",
        now: 100
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 900,
        now: 100
      });
      if (!claimed.ok) throw new Error("claim failed");
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo-a",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: enq.jobId,
        leaseExpiresAt: 1_000,
        now: 100
      });
      if (!acquired.ok) throw new Error("acquire failed");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.lock.id).toBe(acquired.lockId);
      expect(out.skipped[0]!.reason).toBe("job_claimed");
      expect(out.skipped[0]!.job?.state).toBe("claimed");

      // Lock is unchanged.
      const after = getRepoLock(db, acquired.lockId);
      expect(after?.state).toBe("active");
      expect(after?.recovery_status).toBeNull();
      expect(after?.released_at).toBeNull();

      // No recovery event was emitted.
      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'repo_lock.recovered'"
        )
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses when the owning job is pending or running", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      const a = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        goalId: "g1",
        idempotencyKey: "g1:1",
        leaseExpiresAt: 1_000
      });
      const b = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-b",
        goalId: "g2",
        idempotencyKey: "g2:1",
        leaseExpiresAt: 2_000
      });
      // a is left pending; b transitions to running.
      setJobState(db, b.jobId, "running");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 9_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(2);
      const byLockId = new Map(out.skipped.map((row) => [row.lock.id, row]));
      expect(byLockId.get(a.lockId)?.reason).toBe("job_pending");
      expect(byLockId.get(b.lockId)?.reason).toBe("job_running");

      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'repo_lock.recovered'"
        )
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("escalates to job_missing when the owning job row is absent", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      // Insert a lock that references a job id that does not exist. Skip the
      // queue API here because it is not possible to acquire a lock with a
      // dangling job_id through the supported entry points; this test simulates
      // the post-incident orphaned-lock state directly.
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo-a",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "missing-job-id",
        leaseExpiresAt: 1_000,
        now: 100
      });
      if (!acquired.ok) throw new Error("acquire failed");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.reason).toBe("job_missing");
      expect(out.skipped[0]!.job).toBeNull();

      const after = getRepoLock(db, acquired.lockId);
      expect(after?.state).toBe("active");
    } finally {
      db.close();
    }
  });

  it("returns empty result when there are no stale locks", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { lockId } = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        leaseExpiresAt: 10_000
      });
      // Lease still in future relative to now.
      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toEqual([]);
      expect(getRepoLock(db, lockId)?.state).toBe("active");
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated invocations", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId, lockId } = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        leaseExpiresAt: 1_000
      });
      setJobState(db, jobId, "succeeded");

      const first = recoverStaleRepoLocksForTerminalJobs(db, { now: 5_000 });
      expect(first.recovered).toHaveLength(1);
      expect(first.skipped).toEqual([]);

      const second = recoverStaleRepoLocksForTerminalJobs(db, { now: 6_000 });
      expect(second.recovered).toEqual([]);
      expect(second.skipped).toEqual([]);

      // Lock retains the first recovery metadata; not re-stamped at now=6_000.
      const after = getRepoLock(db, lockId);
      expect(after?.state).toBe("released");
      expect(after?.released_at).toBe(5_000);

      // Exactly one repo_lock.recovered event in total.
      const events = db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE type = 'repo_lock.recovered'"
        )
        .get() as { c: number };
      expect(events.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it("honors graceMs when classifying a lock as stale", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId, lockId } = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        leaseExpiresAt: 1_000
      });
      setJobState(db, jobId, "succeeded");

      // Within grace window: not yet stale, no recovery.
      const inGrace = recoverStaleRepoLocksForTerminalJobs(db, {
        now: 1_500,
        graceMs: 1_000
      });
      expect(inGrace.recovered).toEqual([]);
      expect(inGrace.skipped).toEqual([]);
      expect(getRepoLock(db, lockId)?.state).toBe("active");

      // Past grace window: recovered.
      const past = recoverStaleRepoLocksForTerminalJobs(db, {
        now: 3_000,
        graceMs: 1_000
      });
      expect(past.recovered).toHaveLength(1);
      expect(getRepoLock(db, lockId)?.state).toBe("released");
    } finally {
      db.close();
    }
  });

  it("orders recovered locks deterministically by lease_expires_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      const a = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        goalId: "g1",
        idempotencyKey: "g1:1",
        leaseExpiresAt: 2_000
      });
      const b = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-b",
        goalId: "g2",
        idempotencyKey: "g2:1",
        leaseExpiresAt: 1_000
      });
      setJobState(db, a.jobId, "succeeded");
      setJobState(db, b.jobId, "failed");

      const out = recoverStaleRepoLocksForTerminalJobs(db, { now: 9_000 });
      expect(out.recovered.map((row) => row.lock.id)).toEqual([
        b.lockId,
        a.lockId
      ]);
    } finally {
      db.close();
    }
  });
});
