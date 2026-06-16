import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS,
  finishDaemonRun,
  getDaemonRun,
  heartbeatDaemonRun,
  setDaemonRunActiveJob,
  startDaemonRun
} from "../src/core/daemon/runs.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob,
  type QueueJobState
} from "../src/core/daemon/queue-jobs.js";
import { acquireRepoLock, getRepoLock } from "../src/core/repo/locks.js";
import {
  DAEMON_RUN_AUTO_RECOVERED_STATUS,
  JOB_RECOVERED_AUTO_REPENDED_STATUS,
  REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
  recoverStaleClaimedGoalIterationJobs,
  recoverStaleDaemonRuns,
  recoverStaleRepoLocksForTerminalJobs,
  runStartupRecovery
} from "../src/core/daemon/stale-recovery.js";

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

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): { repo: string; head: string } {
  const repo = makeTempDir("momentum-stale-recovery-repo-");
  runGit(repo, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test User"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "init\n", "utf-8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init", "--quiet"]);
  return { repo, head: runGit(repo, ["rev-parse", "HEAD"]).trim() };
}

function seedGoal(db: MomentumDb, id = "g1"): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "test goal", "momentum/test", "/tmp/test", 1, 1);
}

function seedGoalWithRepo(
  db: MomentumDb,
  id: string,
  repo: string
): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, repo, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, "test goal", repo, "momentum/test", "/tmp/test", 1, 1);
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

  it("refuses to recover when the goal's repo has a dirty worktree", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-a");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const inspectRepoState = (repoRoot: string) => {
        expect(repoRoot).toBe("/tmp/repo-a");
        return {
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "Repo has uncommitted changes: /tmp/repo-a"
        };
      };

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      const skipped = out.skipped[0]!;
      expect(skipped.job.id).toBe(jobId);
      expect(skipped.reason).toBe("repo_dirty");
      expect(skipped.repoRoot).toBe("/tmp/repo-a");
      expect(skipped.repoInspectionError).toBe(
        "Repo has uncommitted changes: /tmp/repo-a"
      );

      // Job stays claimed; no recovery event emitted.
      const stored = getQueueJob(db, jobId);
      expect(stored?.state).toBe("claimed");
      const events = db
        .prepare("SELECT count(*) AS c FROM events WHERE type = 'job.recovered'")
        .get() as { c: number };
      expect(events.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses to recover when the goal's repo HEAD cannot be resolved", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-a");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const inspectRepoState = () => ({
        ok: false as const,
        code: "no_head" as const,
        error: "Repo has no HEAD commit: /tmp/repo-a"
      });

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.reason).toBe("repo_unknown_commit");
      expect(out.skipped[0]!.repoRoot).toBe("/tmp/repo-a");
      expect(getQueueJob(db, jobId)?.state).toBe("claimed");
    } finally {
      db.close();
    }
  });

  it("refuses to recover when the goal's repo path is missing or not a git repo", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-missing");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const inspectRepoState = () => ({
        ok: false as const,
        code: "missing" as const,
        error: "Repo path does not exist: /tmp/repo-missing"
      });

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.reason).toBe("repo_unavailable");
      expect(out.skipped[0]!.repoRoot).toBe("/tmp/repo-missing");
      expect(out.skipped[0]!.repoInspectionError).toBe(
        "Repo path does not exist: /tmp/repo-missing"
      );
      expect(getQueueJob(db, jobId)?.state).toBe("claimed");
    } finally {
      db.close();
    }
  });

  it("recovers when the goal has no configured repo (worker handles fail-fast)", () => {
    // goal.repo is null. The worker fail-fast path handles missing-repo cleanly
    // by releasing the claim, so refusing to re-pend would strand the job.
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db); // repo defaults to null
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      let inspectorCalled = false;
      const inspectRepoState = () => {
        inspectorCalled = true;
        return {
          ok: false as const,
          code: "missing" as const,
          error: "should not be called"
        };
      };

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(inspectorCalled).toBe(false);
      expect(out.recovered).toHaveLength(1);
      expect(out.recovered[0]!.jobBefore.id).toBe(jobId);
      expect(out.skipped).toEqual([]);
      expect(getQueueJob(db, jobId)?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("recovers when the goal's repo inspects clean", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-a");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const inspectRepoState = (repoRoot: string) => ({
        ok: true as const,
        repoPath: repoRoot,
        head: "a".repeat(40)
      });

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(out.recovered).toHaveLength(1);
      expect(out.recovered[0]!.jobBefore.id).toBe(jobId);
      expect(out.skipped).toEqual([]);
      expect(getQueueJob(db, jobId)?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("repo state check runs after state/daemon/lock checks (precedence)", () => {
    // A running job with a dirty repo is reported as job_running, not
    // repo_dirty. Earlier checks are strictly cheaper and take precedence so
    // the inspector is never called for jobs we'd skip anyway.
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-a");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      setJobState(db, jobId, "running");
      let inspectorCalled = false;
      const inspectRepoState = () => {
        inspectorCalled = true;
        return {
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "dirty"
        };
      };

      const out = recoverStaleClaimedGoalIterationJobs(db, {
        now: 5_000,
        inspectRepoState
      });
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.reason).toBe("job_running");
      expect(inspectorCalled).toBe(false);
    } finally {
      db.close();
    }
  });

  describe("recovery.md artifact writes", () => {
    it("writes a recovery.md artifact for a repo_dirty skip when dataDir is provided", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        const { jobId } = seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "Repo has uncommitted changes: /tmp/repo-a"
        });

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });
        expect(out.recovered).toEqual([]);
        expect(out.skipped).toHaveLength(1);
        const skipped = out.skipped[0]!;
        expect(skipped.reason).toBe("repo_dirty");
        expect(skipped.job.id).toBe(jobId);

        const expectedPath = path.join(
          dataDir,
          "goals",
          "g1",
          "recovery.md"
        );
        expect(skipped.recoveryArtifactPath).toBe(expectedPath);
        expect(fs.existsSync(expectedPath)).toBe(true);
        const md = fs.readFileSync(expectedPath, "utf-8");
        expect(md).toContain("# Manual recovery required: test goal");
        expect(md).toContain("- Goal ID: g1");
        expect(md).toContain(`- Job ID: ${jobId}`);
        expect(md).toContain("- Iteration: 1");
        expect(md).toContain("- Repo path: /tmp/repo-a");
        expect(md).toContain("- Code: repo_dirty");
        expect(md).toContain(
          "- Message: Repo has uncommitted changes: /tmp/repo-a"
        );
        expect(md).toContain("- Classified at (epoch ms): 5000");
        expect(md).toContain("## Safe next steps");
        expect(md).toContain("git -C '/tmp/repo-a' status");
        expect(md).toContain("momentum recovery clear <goal-id>");
        expect(md).toContain("Once the manual-recovery flag is cleared");
      } finally {
        db.close();
      }
    });

    it("populates available commit pointers in recovery.md", () => {
      const dataDir = makeTempDir();
      const { repo, head } = initRepo();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", repo);
        const previous = seedClaimedIteration(db, {
          goalId: "g1",
          idempotencyKey: "g1:1",
          leaseDurationMs: 900,
          claimAt: 100,
          workerId: "worker-prev"
        });
        setJobState(db, previous.jobId, "succeeded");
        db.prepare(
          `INSERT INTO events (goal_id, job_id, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          "g1",
          previous.jobId,
          "job.succeeded",
          JSON.stringify({ iteration: 1, commit_sha: head }),
          200
        );
        const current = seedClaimedIteration(db, {
          goalId: "g1",
          idempotencyKey: "g1:2",
          leaseDurationMs: 900,
          claimAt: 300,
          workerId: "worker-current",
          iteration: 2
        });
        fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf-8");
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: `Repo has uncommitted changes: ${repo}`
        });

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });

        expect(out.skipped).toHaveLength(1);
        expect(out.skipped[0]!.job.id).toBe(current.jobId);
        const md = fs.readFileSync(
          out.skipped[0]!.recoveryArtifactPath!,
          "utf-8"
        );
        expect(md).toContain(`- Expected (pre-iteration) commit: ${head}`);
        expect(md).toContain(`- Current commit: ${head}`);
      } finally {
        db.close();
      }
    });

    it("fails the recovery pass when the durable manual-recovery flag cannot be written", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        const { jobId } = seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        setJobState(db, jobId, "running");
        db.prepare(
          `CREATE TRIGGER fail_manual_recovery_flag
             BEFORE UPDATE OF needs_manual_recovery ON goals
             BEGIN
               SELECT RAISE(ABORT, 'manual recovery flag write failed');
             END`
        ).run();

        expect(() =>
          recoverStaleClaimedGoalIterationJobs(db, {
            now: 5_000,
            dataDir
          })
        ).toThrow(/manual recovery flag write failed/);
      } finally {
        db.close();
      }
    });

    it("writes recovery.md for repo_unknown_commit and repo_unavailable skips", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        seedGoalWithRepo(db, "g2", "/tmp/repo-missing");
        const claimA = seedClaimedIteration(db, {
          goalId: "g1",
          idempotencyKey: "g1:1",
          leaseDurationMs: 900,
          claimAt: 100,
          workerId: "worker-a"
        });
        const claimB = seedClaimedIteration(db, {
          goalId: "g2",
          idempotencyKey: "g2:1",
          leaseDurationMs: 900,
          claimAt: 101,
          workerId: "worker-b"
        });

        const inspectRepoState = (repoRoot: string) => {
          if (repoRoot === "/tmp/repo-a") {
            return {
              ok: false as const,
              code: "no_head" as const,
              error: "Repo has no HEAD commit: /tmp/repo-a"
            };
          }
          return {
            ok: false as const,
            code: "missing" as const,
            error: "Repo path does not exist: /tmp/repo-missing"
          };
        };

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });
        expect(out.skipped).toHaveLength(2);
        const byJob = new Map(out.skipped.map((row) => [row.job.id, row]));
        const skippedA = byJob.get(claimA.jobId)!;
        const skippedB = byJob.get(claimB.jobId)!;

        expect(skippedA.reason).toBe("repo_unknown_commit");
        expect(skippedA.recoveryArtifactPath).toBe(
          path.join(dataDir, "goals", "g1", "recovery.md")
        );
        const mdA = fs.readFileSync(skippedA.recoveryArtifactPath!, "utf-8");
        expect(mdA).toContain("- Code: repo_unknown_commit");
        expect(mdA).toContain("- Repo path: /tmp/repo-a");
        expect(mdA).toContain("- Message: Repo has no HEAD commit: /tmp/repo-a");

        expect(skippedB.reason).toBe("repo_unavailable");
        expect(skippedB.recoveryArtifactPath).toBe(
          path.join(dataDir, "goals", "g2", "recovery.md")
        );
        const mdB = fs.readFileSync(skippedB.recoveryArtifactPath!, "utf-8");
        expect(mdB).toContain("- Code: repo_unavailable");
        expect(mdB).toContain("- Repo path: /tmp/repo-missing");
        expect(mdB).toContain(
          "- Message: Repo path does not exist: /tmp/repo-missing"
        );
      } finally {
        db.close();
      }
    });

    it("writes recovery.md for a job_running skip when dataDir is provided", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        const { jobId } = seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        setJobState(db, jobId, "running");

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          dataDir
        });
        expect(out.skipped).toHaveLength(1);
        const skipped = out.skipped[0]!;
        expect(skipped.reason).toBe("job_running");
        const expectedPath = path.join(
          dataDir,
          "goals",
          "g1",
          "recovery.md"
        );
        expect(skipped.recoveryArtifactPath).toBe(expectedPath);
        const md = fs.readFileSync(expectedPath, "utf-8");
        expect(md).toContain("- Code: job_running");
        expect(md).toContain(
          "- Message: Stale claimed job is still in `running` state"
        );
        expect(md).toContain("## Safe next steps");
        expect(md).toContain("git -C '/tmp/repo-a' status");
        expect(md).toContain("recovery clear` refuses active jobs");
        expect(md).toContain("momentum recovery clear <goal-id>");
      } finally {
        db.close();
      }
    });

    it("populates the recovery.md runner profile from goal.md when present", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        const goalDir = path.join(dataDir, "goals", "g1");
        fs.mkdirSync(goalDir, { recursive: true });
        fs.writeFileSync(
          path.join(goalDir, "goal.md"),
          `---
title: test goal
repo: /tmp/repo-a
runner: trusted-shell
trusted_shell:
  command: /usr/bin/env
  args:
    - echo
    - hi
  cwd: repo
  timeout_sec: 120
  result_file: out.json
verification:
  - "true"
---
body
`,
          "utf-8"
        );
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "Repo has uncommitted changes: /tmp/repo-a"
        });

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });
        expect(out.skipped).toHaveLength(1);
        const md = fs.readFileSync(
          out.skipped[0]!.recoveryArtifactPath!,
          "utf-8"
        );
        expect(md).toContain("- Runner: trusted-shell");
        expect(md).toContain("- Command: /usr/bin/env");
        expect(md).toContain("- Args: echo hi");
        expect(md).toContain("- CWD: repo");
        expect(md).toContain("- Timeout (sec): 120");
        expect(md).toContain("- Result file: out.json");
      } finally {
        db.close();
      }
    });

    it("shell-quotes repo paths in recovery.md next-step commands", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const unsafeRepo = "/tmp/repo with spaces/$(touch pwned)'";
        seedGoalWithRepo(db, "g1", unsafeRepo);
        seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: `Repo has uncommitted changes: ${unsafeRepo}`
        });

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });

        expect(out.skipped).toHaveLength(1);
        const md = fs.readFileSync(
          out.skipped[0]!.recoveryArtifactPath!,
          "utf-8"
        );
        expect(md).toContain(
          "git -C '/tmp/repo with spaces/$(touch pwned)'\\''' status"
        );
        expect(md).not.toContain("git -C /tmp/repo with spaces");
      } finally {
        db.close();
      }
    });

    it("does not write recovery.md when dataDir is omitted (backwards compatible)", () => {
      const tempDir = makeTempDir();
      const db = openDb(tempDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        const { jobId } = seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "dirty"
        });

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          inspectRepoState
        });
        expect(out.skipped).toHaveLength(1);
        const skipped = out.skipped[0]!;
        expect(skipped.job.id).toBe(jobId);
        expect(skipped.reason).toBe("repo_dirty");
        expect(skipped.recoveryArtifactPath).toBeUndefined();
        expect(
          fs.existsSync(path.join(tempDir, "goals", "g1", "recovery.md"))
        ).toBe(false);
      } finally {
        db.close();
      }
    });

    it("does not write recovery.md for live-owner skips (daemon_active / lock_active)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoal(db, "g1");
        seedGoal(db, "g2");
        const a = seedClaimedIteration(db, {
          goalId: "g1",
          idempotencyKey: "g1:1",
          leaseDurationMs: 900,
          claimAt: 100,
          workerId: "worker-a"
        });
        const { runId } = startDaemonRun(db, { now: 100 });
        setDaemonRunActiveJob(db, {
          runId,
          jobId: a.jobId,
          lockId: null,
          now: 100
        });

        const b = seedClaimedIteration(db, {
          goalId: "g2",
          idempotencyKey: "g2:1",
          leaseDurationMs: 900,
          claimAt: 101,
          workerId: "worker-b"
        });
        const acquired = acquireRepoLock(db, {
          repoRoot: "/tmp/repo-b",
          holder: "worker-b",
          goalId: "g2",
          iteration: 1,
          jobId: b.jobId,
          leaseExpiresAt: 2_000,
          now: 100
        });
        if (!acquired.ok) throw new Error("acquire failed");

        const out = recoverStaleClaimedGoalIterationJobs(db, {
          now: 5_000,
          dataDir
        });
        expect(out.skipped).toHaveLength(2);
        for (const entry of out.skipped) {
          expect(["daemon_active", "lock_active"]).toContain(entry.reason);
          expect(entry.recoveryArtifactPath).toBeUndefined();
        }
        expect(
          fs.existsSync(path.join(dataDir, "goals", "g1", "recovery.md"))
        ).toBe(false);
        expect(
          fs.existsSync(path.join(dataDir, "goals", "g2", "recovery.md"))
        ).toBe(false);
      } finally {
        db.close();
      }
    });

    it("runStartupRecovery forwards dataDir to the claimed-job recovery pass", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedGoalWithRepo(db, "g1", "/tmp/repo-a");
        const { jobId } = seedClaimedIteration(db, {
          leaseDurationMs: 900,
          claimAt: 100
        });
        const inspectRepoState = () => ({
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "Repo has uncommitted changes: /tmp/repo-a"
        });

        const out = runStartupRecovery(db, {
          now: 5_000,
          inspectRepoState,
          dataDir
        });
        expect(out.claimedJobs.skipped).toHaveLength(1);
        const skipped = out.claimedJobs.skipped[0]!;
        expect(skipped.job.id).toBe(jobId);
        expect(skipped.reason).toBe("repo_dirty");
        const expectedPath = path.join(
          dataDir,
          "goals",
          "g1",
          "recovery.md"
        );
        expect(skipped.recoveryArtifactPath).toBe(expectedPath);
        expect(fs.existsSync(expectedPath)).toBe(true);
      } finally {
        db.close();
      }
    });
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

  it("forwards inspectRepoState through to the claimed-job recovery pass", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoalWithRepo(db, "g1", "/tmp/repo-a");
      const { jobId } = seedClaimedIteration(db, {
        leaseDurationMs: 900,
        claimAt: 100
      });
      const observed: string[] = [];
      const inspectRepoState = (repoRoot: string) => {
        observed.push(repoRoot);
        return {
          ok: false as const,
          code: "dirty_worktree" as const,
          error: "dirty"
        };
      };

      const out = runStartupRecovery(db, { now: 5_000, inspectRepoState });
      expect(observed).toEqual(["/tmp/repo-a"]);
      expect(out.claimedJobs.recovered).toEqual([]);
      expect(out.claimedJobs.skipped).toHaveLength(1);
      expect(out.claimedJobs.skipped[0]!.job.id).toBe(jobId);
      expect(out.claimedJobs.skipped[0]!.reason).toBe("repo_dirty");
      expect(getQueueJob(db, jobId)?.state).toBe("claimed");
    } finally {
      db.close();
    }
  });
});

describe("runStartupRecovery daemon recovery wiring", () => {
  it("finalizes an idle stale daemon record alongside repo/claim recovery", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      // Orphan daemon: started long ago, heartbeat never refreshed, no
      // active job/lock pointer.
      const { runId } = startDaemonRun(db, { now: 1_000 });

      const out = runStartupRecovery(db, {
        now: 1_000_000,
        daemonRuns: { staleAfterMs: 30_000 }
      });
      expect(out.daemonRuns.recovered).toHaveLength(1);
      expect(out.daemonRuns.recovered[0]!.runAfter.id).toBe(runId);
      expect(out.daemonRuns.recovered[0]!.runAfter.state).toBe("error");
      expect(out.daemonRuns.recovered[0]!.recoveryStatus).toBe(
        DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
      );
      expect(out.daemonRuns.skipped).toEqual([]);

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("error");
      expect(stored?.recovery_status).toBe(
        DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
      );
    } finally {
      db.close();
    }
  });

  it("skips the caller's own run when daemonRuns.excludeRunId is provided", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });

      const out = runStartupRecovery(db, {
        now: 1_000_000,
        daemonRuns: {
          staleAfterMs: 30_000,
          excludeRunId: runId
        }
      });
      expect(out.daemonRuns.recovered).toEqual([]);
      expect(out.daemonRuns.skipped).toHaveLength(1);
      expect(out.daemonRuns.skipped[0]!.run.id).toBe(runId);
      expect(out.daemonRuns.skipped[0]!.reason).toBe("self");

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("running");
      expect(stored?.recovery_status).toBeNull();
    } finally {
      db.close();
    }
  });

  it("returns an empty daemonRuns result when no daemon records exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db);
      const out = runStartupRecovery(db, { now: 5_000 });
      expect(out.daemonRuns.recovered).toEqual([]);
      expect(out.daemonRuns.skipped).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("recoverStaleDaemonRuns", () => {
  it("auto-finalizes an idle stale daemon run to error and stamps recovery_status", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      // Started long ago, heartbeat never refreshed.
      const { runId } = startDaemonRun(db, { now: 1_000 });

      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 30_000
      });
      expect(out.recovered).toHaveLength(1);
      expect(out.skipped).toEqual([]);
      const entry = out.recovered[0]!;
      expect(entry.runBefore.id).toBe(runId);
      expect(entry.runBefore.state).toBe("running");
      expect(entry.runAfter.id).toBe(runId);
      expect(entry.runAfter.state).toBe("error");
      expect(entry.runAfter.recovery_status).toBe(
        DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
      );
      expect(entry.runAfter.finished_at).toBe(100_000);
      expect(entry.recoveryStatus).toBe(DAEMON_RUN_AUTO_RECOVERED_STATUS);

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("error");
      expect(stored?.recovery_status).toBe(
        DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
      );
    } finally {
      db.close();
    }
  });

  it("returns empty when nothing is stale", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      heartbeatDaemonRun(db, { runId, now: 9_000 });

      const out = recoverStaleDaemonRuns(db, {
        now: 10_000,
        staleAfterMs: 5_000
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips a stale daemon with an active_job_id and surfaces blockingJobId", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: null,
        now: 1_000
      });

      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000,
        activeJobStaleAfterMs: 5_000
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.run.id).toBe(runId);
      expect(out.skipped[0]!.reason).toBe("active_job_present");
      expect(out.skipped[0]!.blockingJobId).toBe("job-1");

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("running");
      expect(stored?.active_job_id).toBe("job-1");
      expect(stored?.recovery_status).toBeNull();
    } finally {
      db.close();
    }
  });

  it("skips a stale daemon with an active_lock_id and surfaces blockingLockId", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      setDaemonRunActiveJob(db, {
        runId,
        jobId: null,
        lockId: "lock-1",
        now: 1_000
      });

      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000,
        activeJobStaleAfterMs: 5_000
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.run.id).toBe(runId);
      expect(out.skipped[0]!.reason).toBe("active_lock_present");
      expect(out.skipped[0]!.blockingLockId).toBe("lock-1");
    } finally {
      db.close();
    }
  });

  it("skips the caller's own run via excludeRunId", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });

      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000,
        excludeRunId: runId
      });
      expect(out.recovered).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.run.id).toBe(runId);
      expect(out.skipped[0]!.reason).toBe("self");

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("running");
      expect(stored?.recovery_status).toBeNull();
    } finally {
      db.close();
    }
  });

  it("excludes terminal daemons even when heartbeat is ancient", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      finishDaemonRun(db, {
        runId,
        terminalState: "stopped",
        now: 2_000
      });

      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 1_000
      });
      // listStaleDaemonRuns filters terminal records, so they never appear.
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
      const { runId } = startDaemonRun(db, { now: 1_000 });
      const first = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000
      });
      expect(first.recovered).toHaveLength(1);

      const second = recoverStaleDaemonRuns(db, {
        now: 200_000,
        staleAfterMs: 5_000
      });
      expect(second.recovered).toEqual([]);
      expect(second.skipped).toEqual([]);

      const stored = getDaemonRun(db, runId);
      expect(stored?.state).toBe("error");
      expect(stored?.recovery_status).toBe(
        DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
      );
      // recovery_status / finished_at were set on the first pass and not
      // overwritten by the second invocation (no row matches state guard).
      expect(stored?.finished_at).toBe(100_000);
    } finally {
      db.close();
    }
  });

  it("orders the result deterministically by heartbeat_at then id", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const oldest = startDaemonRun(db, { now: 1_000 });
      finishDaemonRun(db, {
        runId: oldest.runId,
        terminalState: "stopped",
        now: 1_500
      });
      // Two concurrently-started stale runs with distinct heartbeats. The DB
      // partial unique index forbids two ACTIVE records at once, so we finish
      // one before starting the next to simulate sequential overlap.
      const middle = startDaemonRun(db, { now: 2_000 });
      finishDaemonRun(db, {
        runId: middle.runId,
        terminalState: "stopped",
        now: 2_500
      });
      const newest = startDaemonRun(db, { now: 3_000 });

      // Only the newest is still active and stale (terminal rows are excluded).
      const out = recoverStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000
      });
      expect(out.recovered).toHaveLength(1);
      expect(out.recovered[0]!.runBefore.id).toBe(newest.runId);
    } finally {
      db.close();
    }
  });

  it("validates staleAfterMs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        recoverStaleDaemonRuns(db, { now: 100, staleAfterMs: 0 })
      ).toThrow(/staleAfterMs/);
      expect(() =>
        recoverStaleDaemonRuns(db, { now: 100, staleAfterMs: -1 })
      ).toThrow(/staleAfterMs/);
    } finally {
      db.close();
    }
  });
});
