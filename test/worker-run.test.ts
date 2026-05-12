import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { acquireRepoLock } from "../src/repo-locks.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
} from "../src/fake-runner.js";
import { initGoal } from "../src/goal-init.js";
import { openDb } from "../src/db.js";
import {
  getQueueJob,
  claimPendingGoalIterationJob,
} from "../src/queue-jobs.js";
import { runWorkerOnce } from "../src/worker-run.js";

const GOAL_SPEC = makeGoalSpec("true");

function makeGoalSpec(verificationCommand: string): string {
  return `---
title: Worker Run Test
runner: fake
verification:
  - "${verificationCommand}"
---

Test goal for worker run loop coverage.
`;
}

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
  delete process.env[FAKE_RUNNER_FAIL_ENV];
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

function seedQueuedGoal(
  dataDir: string,
  repo: string,
  spec: string = GOAL_SPEC
): WorkerGoalSeed {
  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, spec, "utf-8");

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
      expect(job?.lease_acquired_at).toBe(1_700_000_000_000);
      expect(job?.lease_expires_at).toBe(1_700_000_050_000);
      expect(job?.heartbeat_at).toBe(1_700_000_020_000);
      expect(job?.started_at).toBe(1_700_000_030_000);
      expect(job?.finished_at).toBe(1_700_000_040_000);
      expect(job?.attempt_count).toBe(1);

      const lock = db
        .prepare(
          "SELECT goal_id, job_id, holder, state, recovery_status, heartbeat_at, lease_expires_at, acquired_at, updated_at FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as {
        goal_id: string;
        job_id: string;
        holder: string;
        state: string;
        recovery_status: string | null;
        heartbeat_at: number;
        lease_expires_at: number;
        acquired_at: number;
        updated_at: number;
      };
      expect(lock).toMatchObject({
        goal_id: seed.goalId,
        job_id: seed.jobId,
        holder: "worker-test",
        state: "released",
        recovery_status: "iteration_success"
      });
      expect(lock.heartbeat_at).toBe(1_700_000_020_000);
      expect(lock.lease_expires_at).toBe(1_700_000_050_000);
      expect(lock.acquired_at).toBe(1_700_000_010_000);
      expect(lock.updated_at).toBe(1_700_000_050_000);

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
      const events = db.prepare("SELECT COUNT(*) AS c FROM events").get() as {
        c: number;
      };
      expect(events.c).toBe(0);
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

  it("records job.failed, resets the repo, and writes artifacts when the runner reports failure", () => {
    const dataDir = makeTempDir("momentum-worker-run-runner-fail-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    process.env[FAKE_RUNNER_FAIL_ENV] = "1";

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-runner-fail"
      });

      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.jobIterationResult.ok).toBe(false);
      expect(out.jobIterationResult.jobState).toBe("failed");
      expect(out.jobIterationResult.goalState).toBe("failed");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("failed");
      expect(job?.error).toContain("runner_reported_failure");
      expect(job?.attempt_count).toBe(1);

      const goalRow = db
        .prepare("SELECT state FROM goals WHERE id = ?")
        .get(seed.goalId) as { state: string };
      expect(goalRow.state).toBe("failed");

      const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
      expect(head).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");

      const lock = db
        .prepare(
          "SELECT state, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as { state: string; recovery_status: string };
      expect(lock).toMatchObject({
        state: "released",
        recovery_status: "iteration_failure"
      });

      const eventRows = db
        .prepare(
          "SELECT type, payload FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string; payload: string }>;
      const eventTypes = eventRows.map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_failed",
        "job.failed"
      ]);

      const jobFailed = JSON.parse(
        eventRows[eventRows.length - 1]!.payload
      ) as Record<string, unknown>;
      expect(jobFailed["worker_id"]).toBe("worker-runner-fail");
      expect(jobFailed["repo_root"]).toBe(repo);
      expect(jobFailed["error"]).toBe("runner_reported_failure");

      const layoutDir = path.join(seed.dataDir, "goals", seed.goalId, "iterations", "1");
      const runnerLog = fs.readFileSync(path.join(layoutDir, "runner.log"), "utf-8");
      expect(runnerLog).toContain(`simulated failure via ${FAKE_RUNNER_FAIL_ENV}`);
      const verificationLog = fs.readFileSync(
        path.join(layoutDir, "verification.log"),
        "utf-8"
      );
      expect(verificationLog).toContain(
        "[verify] skipped: runner reported failure"
      );
    } finally {
      db.close();
    }
  });

  it("records job.failed, resets the repo, and writes artifacts when verification fails", () => {
    const dataDir = makeTempDir("momentum-worker-run-verify-fail-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, makeGoalSpec("false"));
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-verify-fail"
      });

      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.jobIterationResult.ok).toBe(false);
      expect(out.jobIterationResult.jobState).toBe("failed");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("failed");
      expect(job?.error).toContain("verification_failed");

      const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
      expect(head).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");

      const lock = db
        .prepare(
          "SELECT state, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as { state: string; recovery_status: string };
      expect(lock).toMatchObject({
        state: "released",
        recovery_status: "iteration_failure"
      });

      const eventRows = db
        .prepare(
          "SELECT type, payload FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string; payload: string }>;
      const eventTypes = eventRows.map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_failed",
        "job.failed"
      ]);

      const jobFailed = JSON.parse(
        eventRows[eventRows.length - 1]!.payload
      ) as Record<string, unknown>;
      expect(jobFailed["error"]).toBe("verification_failed");

      const verificationLog = fs.readFileSync(
        path.join(seed.dataDir, "goals", seed.goalId, "iterations", "1", "verification.log"),
        "utf-8"
      );
      expect(verificationLog.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("includes commit and artifact pointers in the job.succeeded event and on the job row", () => {
    const dataDir = makeTempDir("momentum-worker-run-success-pointers-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-success-pointers"
      });
      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.jobIterationResult.ok).toBe(true);

      const headAfter = runGit(repo, ["rev-parse", "HEAD"]).trim();
      expect(headAfter).not.toBe(baseHead);

      const layoutDir = path.join(
        seed.dataDir,
        "goals",
        seed.goalId,
        "iterations",
        "1"
      );

      const event = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'job.succeeded' ORDER BY id DESC LIMIT 1"
        )
        .get(seed.goalId) as { payload: string };
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      expect(payload["iteration"]).toBe(1);
      expect(payload["worker_id"]).toBe("worker-success-pointers");
      expect(payload["repo_root"]).toBe(repo);
      expect(payload["goal_state"]).toBe("iteration_complete");
      expect(payload["job_state"]).toBe("succeeded");
      expect(payload["branch"]).toMatch(/^momentum\//);
      expect(payload["branch_created"]).toBe(true);
      expect(payload["base_head"]).toBe(baseHead);
      expect(payload["commit_sha"]).toBe(headAfter);
      expect(typeof payload["commit_message"]).toBe("string");
      expect(payload["goal_complete"]).toBe(false);
      expect(payload["result_path"]).toBe(path.join(layoutDir, "result.json"));
      expect(payload["artifacts"]).toEqual({
        iteration_dir: layoutDir,
        prompt: path.join(layoutDir, "prompt.md"),
        runner_log: path.join(layoutDir, "runner.log"),
        verification_log: path.join(layoutDir, "verification.log"),
        result_json: path.join(layoutDir, "result.json")
      });

      const job = getQueueJob(db, seed.jobId);
      expect(job?.result_path).toBe(path.join(layoutDir, "result.json"));
      expect(job?.error_path).toBeNull();
    } finally {
      db.close();
    }
  });

  it("emits artifact pointers in the job.failed event and on the job row when verification fails", () => {
    const dataDir = makeTempDir("momentum-worker-run-fail-pointers-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, makeGoalSpec("false"));

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-fail-pointers"
      });
      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.jobIterationResult.ok).toBe(false);

      const layoutDir = path.join(
        seed.dataDir,
        "goals",
        seed.goalId,
        "iterations",
        "1"
      );

      const event = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'job.failed' ORDER BY id DESC LIMIT 1"
        )
        .get(seed.goalId) as { payload: string };
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      expect(payload["error"]).toBe("verification_failed");
      expect(payload["artifacts"]).toEqual({
        iteration_dir: layoutDir,
        runner_log: path.join(layoutDir, "runner.log"),
        verification_log: path.join(layoutDir, "verification.log")
      });

      const job = getQueueJob(db, seed.jobId);
      expect(job?.result_path).toBeNull();
      expect(job?.error_path).toBe(path.join(layoutDir, "verification.log"));
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
