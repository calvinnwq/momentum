import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  finishDaemonRun,
  setDaemonRunActiveJob,
  startDaemonRun
} from "../src/daemon-runs.js";
import { openDb, type MomentumDb } from "../src/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob,
  type QueueJobState
} from "../src/queue-jobs.js";
import { acquireRepoLock, getRepoLock } from "../src/repo-locks.js";
import {
  JOB_RECOVERED_AUTO_REPENDED_STATUS,
  REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
  recoverStaleClaimedGoalIterationJobs,
  recoverStaleRepoLocksForTerminalJobs,
  runStartupRecovery
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

function seedClaimedIteration(
  db: MomentumDb,
  opts: {
    goalId?: string;
    iteration?: number;
    idempotencyKey?: string;
    workerId?: string;
    leaseDurationMs: number;
    enqueueAt?: number;
    claimAt?: number;
  }
): { jobId: string } {
  const goalId = opts.goalId ?? "g1";
  const iteration = opts.iteration ?? 1;
  const idempotencyKey = opts.idempotencyKey ?? `${goalId}:${iteration}`;
  enqueueGoalIterationJob(db, {
    goalId,
    iteration,
    idempotencyKey,
    artifactPath: `/tmp/test/${goalId}/iterations/${iteration}`,
    now: opts.enqueueAt ?? 100
  });
  const claimed = claimPendingGoalIterationJob(db, {
    workerId: opts.workerId ?? "worker-a",
    leaseDurationMs: opts.leaseDurationMs,
    now: opts.claimAt ?? 100
  });
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
  // Ensure the right job was claimed in tests that enqueue multiple goals.
  if (claimed.job.goal_id !== goalId) {
    throw new Error(
      `seedClaimedIteration: unexpected claim ordering (claimed ${claimed.job.goal_id}, wanted ${goalId})`
    );
  }
  return { jobId: claimed.job.id };
}

describe("recoverStaleClaimedGoalIterationJobs", () => {
  it("re-pends a stale claimed job with no daemon and no active lock", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      // Lease expires at 1_000; now=5_000 → stale.
      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toHaveLength(1);
      expect(out.skipped).toEqual([]);

      const entry = out.recovered[0]!;
      expect(entry.jobBefore.id).toBe(jobId);
      expect(entry.jobBefore.state).toBe("claimed");
      expect(entry.jobAfter.state).toBe("pending");
      expect(entry.jobAfter.worker_id).toBeNull();
      expect(entry.jobAfter.lease_acquired_at).toBeNull();
      expect(entry.jobAfter.lease_expires_at).toBeNull();
      expect(entry.jobAfter.heartbeat_at).toBeNull();
      // attempt_count is preserved from the failed claim.
      expect(entry.jobAfter.attempt_count).toBe(1);
      expect(entry.previousWorkerId).toBe("worker-a");
      expect(entry.previousLeaseExpiresAt).toBe(1_000);
      expect(entry.recoveryStatus).toBe(JOB_RECOVERED_AUTO_REPENDED_STATUS);

      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("pending");
      expect(stored?.worker_id).toBeNull();

      const events = db
        .prepare(
          "SELECT goal_id, job_id, type, payload, created_at FROM events WHERE type = 'job.recovered'"
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
        iteration: 1,
        previous_state: "claimed",
        previous_worker_id: "worker-a",
        previous_lease_expires_at: 1_000,
        attempt_count: 1,
        recovered_at: 5_000,
        recovery_status: JOB_RECOVERED_AUTO_REPENDED_STATUS
      });
    } finally {
      db.close();
    }
  });

  it("refuses to recover a stale running job and reports job_running", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      // Promote to running. The repo may have been written to before the
      // worker died, so auto-recovery must refuse.
      setJobState(db, jobId, "running");

      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.job.id).toBe(jobId);
      expect(out.skipped[0]!.reason).toBe("job_running");

      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("running");
      expect(stored?.worker_id).toBe("worker-a");

      const events = db
        .prepare("SELECT count(*) AS c FROM events WHERE type = 'job.recovered'")
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses to recover when an active daemon asserts ownership", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const { runId } = startDaemonRun(db, { now: 100 });
      setDaemonRunActiveJob(db, {
        runId,
        jobId,
        lockId: null,
        now: 100
      });

      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.job.id).toBe(jobId);
      expect(out.skipped[0]!.reason).toBe("daemon_active");
      expect(out.skipped[0]!.blockingDaemonRunId).toBe(runId);

      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("claimed");
    } finally {
      db.close();
    }
  });

  it("recovers when the daemon owning the job is terminal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const { runId } = startDaemonRun(db, { now: 100 });
      setDaemonRunActiveJob(db, { runId, jobId, lockId: null, now: 100 });
      finishDaemonRun(db, {
        runId,
        terminalState: "error",
        now: 200,
        error: "worker crashed"
      });

      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toHaveLength(1);
      expect(out.recovered[0]!.jobBefore.id).toBe(jobId);
      expect(out.skipped).toEqual([]);

      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("refuses to recover when an active repo lock still references the job", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const lock = acquireRepoLock(db, {
        repoRoot: "/tmp/repo-a",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId,
        leaseExpiresAt: 1_000,
        now: 100
      });
      if (!lock.ok) throw new Error("acquire failed");

      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.job.id).toBe(jobId);
      expect(out.skipped[0]!.reason).toBe("lock_active");
      expect(out.skipped[0]!.blockingLockId).toBe(lock.lockId);

      // Job is still claimed; lock is still active.
      const storedJob = getQueueJob(db, jobId);
      expect(storedJob?.state).toBe("claimed");
      const storedLock = getRepoLock(db, lock.lockId);
      expect(storedLock?.state).toBe("active");
    } finally {
      db.close();
    }
  });

  it("returns empty result when no claimed jobs are stale", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      seedClaimedIteration(db, {
        leaseDurationMs: 60_000,
        claimAt: 100
      });
      // Lease expires at 60_100; now=5_000 → still fresh.
      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated invocations", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const first = recoverStaleClaimedGoalIterationJobs(db, { now: 5_000 });
      expect(first.recovered).toHaveLength(1);

      const second = recoverStaleClaimedGoalIterationJobs(db, { now: 6_000 });
      expect(second.recovered).toEqual([]);
      expect(second.skipped).toEqual([]);

      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("pending");

      const events = db
        .prepare("SELECT count(*) AS c FROM events WHERE type = 'job.recovered'")
        .get() as { c: number };
      expect(events.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it("honors graceMs when classifying a job as stale-claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      // Lease expires at 1_000. Within grace window (now=1_500, grace=1_000)
      // → not yet considered stale.
      const inGrace = recoverStaleClaimedGoalIterationJobs(db, {
        now: 1_500,
        graceMs: 1_000
      });
      expect(inGrace.recovered).toEqual([]);
      expect(inGrace.skipped).toEqual([]);
      expect(getQueueJob(db, jobId)?.state).toBe("claimed");

      const past = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        graceMs: 1_000
      });
      expect(past.recovered).toHaveLength(1);
      expect(getQueueJob(db, jobId)?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("orders recovered jobs deterministically by lease_expires_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      // Enqueue both up front so the older-first claim ordering is stable.
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/g1/iterations/1",
        now: 100
      });
      enqueueGoalIterationJob(db, {
        goalId: "g2",
        iteration: 1,
        idempotencyKey: "g2:1",
        artifactPath: "/tmp/test/g2/iterations/1",
        now: 101
      });
      const claimedA = claimPendingGoalIterationJob(db, {
        workerId: "worker-a",
        leaseDurationMs: 1_900,
        now: 100
      });
      if (!claimedA.ok) throw new Error("claim a failed");
      const claimedB = claimPendingGoalIterationJob(db, {
        workerId: "worker-b",
        leaseDurationMs: 900,
        now: 100
      });
      if (!claimedB.ok) throw new Error("claim b failed");
      // claimedA.lease_expires_at = 2_000, claimedB.lease_expires_at = 1_000.

      const out = recoverStaleClaimedGoalIterationJobs(db, { now: 9_000 });
      expect(out.recovered.map((row) => row.jobBefore.id)).toEqual([
        claimedB.job.id,
        claimedA.job.id
      ]);
    } finally {
      db.close();
    }
  });
});

describe("runStartupRecovery", () => {
  it("returns empty result when nothing is stale", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const out = runStartupRecovery(db, { now: 5_000, graceMs: 100 });
      expect(out.observedAt).toBe(5_000);
      expect(out.graceMs).toBe(100);
      expect(out.repoLocks.recovered).toEqual([]);
      expect(out.repoLocks.skipped).toEqual([]);
      expect(out.claimedJobs.recovered).toEqual([]);
      expect(out.claimedJobs.skipped).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("composes both primitives in one pass and surfaces both results", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      // Stale repo lock whose owning job is terminal → recoverable.
      const seededLock = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        goalId: "g1",
        idempotencyKey: "g1:1",
        leaseExpiresAt: 1_000
      });
      setJobState(db, seededLock.jobId, "succeeded");
      // Stale claimed job with no live owner → recoverable.
      const claimed = seedClaimedIteration(db, {
        goalId: "g2",
        leaseDurationMs: 900,
        claimAt: 100
      });

      const out = runStartupRecovery(db, { now: 5_000, graceMs: 0 });
      expect(out.observedAt).toBe(5_000);
      expect(out.graceMs).toBe(0);
      expect(out.repoLocks.recovered).toHaveLength(1);
      expect(out.repoLocks.recovered[0]!.lock.id).toBe(seededLock.lockId);
      expect(out.repoLocks.recovered[0]!.recoveryStatus).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
      );
      expect(out.claimedJobs.recovered).toHaveLength(1);
      expect(out.claimedJobs.recovered[0]!.jobBefore.id).toBe(claimed.jobId);
      expect(out.claimedJobs.recovered[0]!.recoveryStatus).toBe(
        JOB_RECOVERED_AUTO_REPENDED_STATUS
      );

      const releasedLock = getRepoLock(db, seededLock.lockId);
      expect(releasedLock?.state).toBe("released");
      const rependedJob = getQueueJob(db, claimed.jobId);
      expect(rependedJob?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated invocations", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const claimed = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const first = runStartupRecovery(db, { now: 5_000 });
      expect(first.claimedJobs.recovered).toHaveLength(1);

      const second = runStartupRecovery(db, { now: 6_000 });
      expect(second.claimedJobs.recovered).toEqual([]);
      expect(second.claimedJobs.skipped).toEqual([]);
      expect(second.repoLocks.recovered).toEqual([]);
      expect(second.repoLocks.skipped).toEqual([]);

      expect(getQueueJob(db, claimed.jobId)?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("surfaces dirty/unknown stale records via skipped reasons for manual recovery", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      seedGoal(db, "g2");
      // Enqueue the lock-owning job for g1 with a LATER created_at than the
      // claim seed so the subsequent claim picks the g2 row deterministically.
      const seededLock = seedQueuedIterationWithLock(db, {
        repoRoot: "/tmp/repo-a",
        goalId: "g1",
        idempotencyKey: "g1:1",
        leaseExpiresAt: 1_000,
        enqueueAt: 200
      });
      // Stale claimed job (different goal) promoted to running (dirty: repo
      // writes may have happened, refuse auto-recovery).
      const dirtyClaim = seedClaimedIteration(db, {
        goalId: "g2",
        leaseDurationMs: 900,
        enqueueAt: 100,
        claimAt: 100,
        workerId: "worker-b"
      });
      setJobState(db, dirtyClaim.jobId, "running");

      const out = runStartupRecovery(db, { now: 5_000 });
      expect(out.repoLocks.recovered).toEqual([]);
      expect(out.repoLocks.skipped).toHaveLength(1);
      expect(out.repoLocks.skipped[0]!.lock.id).toBe(seededLock.lockId);
      expect(out.repoLocks.skipped[0]!.reason).toBe("job_pending");
      expect(out.claimedJobs.recovered).toEqual([]);
      expect(out.claimedJobs.skipped).toHaveLength(1);
      expect(out.claimedJobs.skipped[0]!.job.id).toBe(dirtyClaim.jobId);
      expect(out.claimedJobs.skipped[0]!.reason).toBe("job_running");
    } finally {
      db.close();
    }
  });
});
