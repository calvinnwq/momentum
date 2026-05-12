import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { acquireRepoLock } from "../src/repo-locks.js";
import { initGoal } from "../src/goal-init.js";
import { openDb } from "../src/db.js";
import {
  getQueueJob,
  claimPendingGoalIterationJob,
} from "../src/queue-jobs.js";
import { runWorkerOnce } from "../src/worker-run.js";

const GOAL_SPEC = `---
title: Worker Run Test
runner: fake
verification:
  - "true"
---

Test goal for worker run loop coverage.
`;

type WorkerGoalSeed = {
  dataDir: string;
  goalId: string;
  jobId: string;
  repo: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-worker-run-"): string {
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

function initRepo(): string {
  const dir = makeTempDir("momentum-worker-run-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "worker-run@example.com"]);
  runGit(dir, ["config", "user.name", "Worker Run Tester"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "worker run\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function seedQueuedGoal(dataDir: string, repo: string): WorkerGoalSeed {
  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

  const result = initGoal({
    goalPath: goalFile,
    repoOverride: repo,
    dataDirOptions: { dataDir },
    mode: "queued"
  });
  if (!result.ok) {
    throw new Error(`seedQueuedGoal: ${result.error}`);
  }
  return {
    dataDir,
    goalId: result.goalId,
    jobId: result.jobId,
    repo
  };
}

describe("runWorkerOnce", () => {
  it("executes one queued goal_iteration job and records queue/job/lock metadata", () => {
    const dataDir = makeTempDir("momentum-worker-run-data-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const db = openDb(seed.dataDir);
    try {
      let now = 1_700_000_000_000;
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-test",
        now: () => {
          const current = now;
          now += 10_000;
          return current;
        }
      });

      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.outcome).toBe("ran_job");
      expect(out.jobIterationResult.ok).toBe(true);
      expect(out.jobIterationResult.jobState).toBe("succeeded");

      const goalRow = db
        .prepare("SELECT state FROM goals WHERE id = ?")
        .get(seed.goalId) as { state: string };
      expect(goalRow.state).toBe("iteration_complete");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("succeeded");
      expect(job?.worker_id).toBe("worker-test");
      expect(job?.goal_id).toBe(seed.goalId);

      const lock = db
        .prepare(
          "SELECT goal_id, job_id, holder, state, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as {
        goal_id: string;
        job_id: string;
        holder: string;
        state: string;
        recovery_status: string | null;
      };
      expect(lock).toMatchObject({
        goal_id: seed.goalId,
        job_id: seed.jobId,
        holder: "worker-test",
        state: "released",
        recovery_status: "iteration_success"
      });

      const events = db
        .prepare(
          "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string }>;
      const eventTypes = events.map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded"
      ]);
    } finally {
      db.close();
    }
  });

  it("returns not_executed when no pending jobs exist", () => {
    const dataDir = makeTempDir("momentum-worker-run-noop-");
    const db = openDb(dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir,
        workerId: "worker-idle"
      });
      expect(out.code).toBe("no_work");
      expect(out.code).toBe("no_work");
      expect(out.message).toContain("No pending goal_iteration jobs were available.");
    } finally {
      db.close();
    }
  });

  it("releases a claimed job when repo lock contention blocks execution", () => {
    const dataDir = makeTempDir("momentum-worker-run-contention-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const db = openDb(seed.dataDir);
    try {
      const holderLock = acquireRepoLock(db, {
        repoRoot: seed.repo,
        holder: "other-worker",
        goalId: seed.goalId,
        iteration: 1,
        jobId: seed.jobId,
        leaseExpiresAt: 1_700_000_020_000,
        now: 1_700_000_010_000
      });
      if (!holderLock.ok) {
        throw new Error("seed contention lock did not acquire");
      }

      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-contended"
      });
      expect(out.code).toBe("not_executed");
      if (out.code !== "not_executed") return;
      expect(out.reason).toBe("repo_lock_already_locked");
      expect(out.lockId).toBe(holderLock.lock.id);
      expect(out.message).toContain("Could not acquire repo lock for");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("pending");
      expect(job?.worker_id).toBeNull();
      expect(job?.lease_acquired_at).toBeNull();
      expect(job?.lease_expires_at).toBeNull();
      expect(job?.heartbeat_at).toBeNull();

      const lock = db
        .prepare("SELECT state, holder FROM repo_locks WHERE id = ?")
        .get(holderLock.lockId) as { state: string; holder: string };
      expect(lock).toMatchObject({ state: "active", holder: "other-worker" });

      const eventTypes = db
        .prepare(
          "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string }>;
      expect(eventTypes.map((row) => row.type)).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.released"
      ]);
    } finally {
      db.close();
    }
  });

  it("returns no_work when another worker already claimed the pending job", () => {
    const dataDir = makeTempDir("momentum-worker-run-contention2-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const db = openDb(seed.dataDir);
    try {
      const claimNow = 1_700_000_040_000;
      const claim = claimPendingGoalIterationJob(db, {
        workerId: "other-worker",
        leaseDurationMs: 30_000,
        now: claimNow
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.job.id).toBe(seed.jobId);
      expect(claim.job.state).toBe("claimed");

      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-blocked"
      });
      expect(out.code).toBe("no_work");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("claimed");
      expect(job?.worker_id).toBe("other-worker");
      expect(job?.lease_expires_at).toBe(claimNow + 30_000);

      const events = db
        .prepare(
          "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string }>;
      expect(events.map((row) => row.type)).toEqual([
        "job.enqueued",
        "job.claimed"
      ]);
    } finally {
      db.close();
    }
  });
});
