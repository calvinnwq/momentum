import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { acquireRepoLock } from "../src/repo-locks.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV,
  FAKE_RUNNER_TRAJECTORY_ENV
} from "../src/fake-runner.js";
import { buildIterationIdempotencyKey, initGoal } from "../src/goal-init.js";
import { openDb } from "../src/db.js";
import {
  getJobByIdempotencyKey,
  getQueueJob,
  claimPendingGoalIterationJob,
} from "../src/queue-jobs.js";
import { runWorkerOnce } from "../src/worker-run.js";
import * as goalReducerModule from "../src/goal-reducer.js";

const GOAL_SPEC = makeGoalSpec("true");

function makeGoalSpec(
  verificationCommand: string,
  options: { maxIterations?: number } = {}
): string {
  const maxIterationsLine =
    options.maxIterations !== undefined
      ? `max_iterations: ${options.maxIterations}\n`
      : "";
  return `---
title: Worker Run Test
runner: fake
${maxIterationsLine}verification:
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
  delete process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV];
  delete process.env[FAKE_RUNNER_TRAJECTORY_ENV];
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
  spec: string = GOAL_SPEC,
  runnerOverride?: string
): WorkerGoalSeed {
  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, spec, "utf-8");

  const initOptions = {
    goalPath: goalFile,
    repoOverride: repo,
    dataDirOptions: { dataDir },
    mode: "queued" as const
  };
  const result = initGoal(
    runnerOverride === undefined
      ? initOptions
      : { ...initOptions, runnerOverride }
  );
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
      expect(goalRow.state).toBe("max_iterations_reached");

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
        "job.succeeded",
        "goal.reduced",
        "goal.failed"
      ]);
    } finally {
      db.close();
    }
  });

  it("executes queued jobs with the validated DB runner instead of raw artifact runner", () => {
    const dataDir = makeTempDir("momentum-worker-run-db-runner-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, GOAL_SPEC, "trusted-shell");

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-db-runner"
      });

      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.jobIterationResult.ok).toBe(false);
      if (out.jobIterationResult.ok) return;
      expect(out.jobIterationResult.jobState).toBe("failed");
      // The DB-stored runner is trusted-shell, which now executes via its
      // RunnerAdapter (NGX-282); without a trusted_shell config block the
      // adapter fails with invalid_input, which foreground-iteration maps to
      // runner_failed. This still proves the worker honored the DB runner
      // rather than the goal-spec default (fake).
      expect(out.jobIterationResult.iteration.code).toBe("runner_failed");
      expect(out.jobIterationResult.iteration.error).toContain("trusted-shell");
      expect(out.jobIterationResult.iteration.error).toContain("trusted_shell");
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("failed");
      expect(job?.error).toContain("trusted-shell");

      const iterationStarted = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'iteration_started'"
        )
        .get(seed.goalId) as { payload: string };
      expect(JSON.parse(iterationStarted.payload)).toMatchObject({
        runner: "trusted-shell"
      });
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
        "job.failed",
        "goal.reduced",
        "goal.failed"
      ]);

      const jobFailedRow = eventRows.find((row) => row.type === "job.failed");
      const jobFailed = JSON.parse(jobFailedRow!.payload) as Record<
        string,
        unknown
      >;
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
        "job.failed",
        "goal.reduced",
        "goal.failed"
      ]);

      const jobFailedRow = eventRows.find((row) => row.type === "job.failed");
      const jobFailed = JSON.parse(jobFailedRow!.payload) as Record<
        string,
        unknown
      >;
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

  it("releases the repo lock and job claim when the claimed hook throws", () => {
    const dataDir = makeTempDir("momentum-worker-run-hook-fail-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const db = openDb(seed.dataDir);
    try {
      expect(() =>
        runWorkerOnce({
          db,
          dataDir: seed.dataDir,
          workerId: "worker-hook-fail",
          hooks: {
            onJobClaimed: () => {
              throw new Error("claim hook failed");
            }
          }
        })
      ).toThrow("claim hook failed");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("pending");
      expect(job?.worker_id).toBeNull();
      expect(job?.lease_acquired_at).toBeNull();
      expect(job?.lease_expires_at).toBeNull();
      expect(job?.heartbeat_at).toBeNull();

      const lock = db
        .prepare(
          "SELECT state, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as { state: string; recovery_status: string };
      expect(lock).toMatchObject({
        state: "released",
        recovery_status: "job_claim_hook_failed"
      });

      const events = db
        .prepare(
          "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(seed.goalId) as Array<{ type: string }>;
      expect(events.map((row) => row.type)).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "job.released"
      ]);
    } finally {
      db.close();
    }
  });

  it("surfaces released hook errors after durable finalization", () => {
    const dataDir = makeTempDir("momentum-worker-run-release-hook-fail-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const db = openDb(seed.dataDir);
    try {
      expect(() =>
        runWorkerOnce({
          db,
          dataDir: seed.dataDir,
          workerId: "worker-release-hook-fail",
          hooks: {
            onJobReleased: () => {
              throw new Error("release hook failed");
            }
          }
        })
      ).toThrow("release hook failed");

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("succeeded");

      const lock = db
        .prepare(
          "SELECT state, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(seed.jobId) as { state: string; recovery_status: string };
      expect(lock).toMatchObject({
        state: "released",
        recovery_status: "iteration_success"
      });

      const eventTypes = (
        db
          .prepare(
            "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
          )
          .all(seed.goalId) as Array<{ type: string }>
      ).map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded",
        "goal.reduced",
        "goal.failed"
      ]);
    } finally {
      db.close();
    }
  });

  it("enqueues the next iteration with a stable idempotency key when the reducer decides CONTINUE", () => {
    const dataDir = makeTempDir("momentum-worker-run-continue-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, makeGoalSpec("true", { maxIterations: 3 }));

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-continue"
      });
      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;

      expect(out.jobIterationResult.ok).toBe(true);
      expect(out.reducerError).toBeNull();
      expect(out.reducer).not.toBeNull();
      const reducer = out.reducer!;
      expect(reducer.decision).toBe("continue");
      expect(reducer.goalState).toBe("queued");
      expect(reducer.completionReason).toBeNull();
      expect(reducer.reusedExistingDecision).toBe(false);
      expect(reducer.nextJob).not.toBeNull();
      const nextJobInfo = reducer.nextJob!;
      expect(nextJobInfo.iteration).toBe(2);
      expect(nextJobInfo.idempotencyKey).toBe(
        buildIterationIdempotencyKey(seed.goalId, 2)
      );
      expect(nextJobInfo.created).toBe(true);

      const goalRow = db
        .prepare("SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?")
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("queued");
      expect(goalRow.current_iteration).toBe(1);
      expect(goalRow.completion_reason).toBeNull();

      const enqueued = getJobByIdempotencyKey(
        db,
        buildIterationIdempotencyKey(seed.goalId, 2)
      );
      expect(enqueued?.id).toBe(nextJobInfo.jobId);
      expect(enqueued?.state).toBe("pending");
      expect(enqueued?.iteration).toBe(2);

      const eventTypes = (
        db
          .prepare(
            "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
          )
          .all(seed.goalId) as Array<{ type: string }>
      ).map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded",
        "job.enqueued",
        "goal.reduced"
      ]);

      const reducedRow = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.reduced'"
        )
        .get(seed.goalId) as { payload: string };
      const reducedPayload = JSON.parse(reducedRow.payload) as Record<
        string,
        unknown
      >;
      expect(reducedPayload).toMatchObject({
        decision: "continue",
        iteration: 1,
        goal_state: "queued",
        completion_reason: null,
        max_iterations: 3
      });
      const nextJobPayload = reducedPayload["next_job"] as Record<
        string,
        unknown
      >;
      expect(nextJobPayload).toMatchObject({
        job_id: nextJobInfo.jobId,
        iteration: 2,
        idempotency_key: buildIterationIdempotencyKey(seed.goalId, 2),
        created: true
      });

      const goalCompletedCount = (
        db
          .prepare(
            "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type IN ('goal.completed', 'goal.failed')"
          )
          .get(seed.goalId) as { c: number }
      ).c;
      expect(goalCompletedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("marks the goal completed and stops chaining when the runner reports goal_complete=true", () => {
    const dataDir = makeTempDir("momentum-worker-run-goal-complete-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, makeGoalSpec("true", { maxIterations: 3 }));

    process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV] = "1";

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-goal-complete"
      });
      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;

      expect(out.jobIterationResult.ok).toBe(true);
      if (!out.jobIterationResult.ok) return;
      expect(out.jobIterationResult.iteration.result.goal_complete).toBe(true);

      expect(out.reducerError).toBeNull();
      expect(out.reducer).not.toBeNull();
      const reducer = out.reducer!;
      expect(reducer.decision).toBe("goal_complete");
      expect(reducer.goalState).toBe("completed");
      expect(reducer.completionReason).toBe("goal_complete");
      expect(reducer.goalComplete).toBe(true);
      expect(reducer.nextJob).toBeNull();

      const goalRow = db
        .prepare("SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?")
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("completed");
      expect(goalRow.current_iteration).toBe(1);
      expect(goalRow.completion_reason).toBe("goal_complete");

      const eventTypes = (
        db
          .prepare(
            "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
          )
          .all(seed.goalId) as Array<{ type: string }>
      ).map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded",
        "goal.reduced",
        "goal.completed"
      ]);

      const nextJob = getJobByIdempotencyKey(
        db,
        buildIterationIdempotencyKey(seed.goalId, 2)
      );
      expect(nextJob).toBeUndefined();

      const completedRow = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.completed'"
        )
        .get(seed.goalId) as { payload: string };
      const completedPayload = JSON.parse(completedRow.payload) as Record<
        string,
        unknown
      >;
      expect(completedPayload).toMatchObject({
        iteration: 1,
        completion_reason: "goal_complete"
      });
      expect(typeof completedPayload["commit_sha"]).toBe("string");
    } finally {
      db.close();
    }
  });

  it("re-invoking the reducer after a queued CONTINUE worker run does not double-enqueue or duplicate events", async () => {
    const { reduceGoalIteration } = await import("../src/goal-reducer.js");
    const dataDir = makeTempDir("momentum-worker-run-reducer-replay-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, makeGoalSpec("true", { maxIterations: 3 }));

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-replay"
      });
      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.reducerError).toBeNull();
      expect(out.reducer).not.toBeNull();
      const reducer = out.reducer!;
      expect(reducer.decision).toBe("continue");
      const firstNext = reducer.nextJob!;

      const replay = reduceGoalIteration({
        db,
        goalId: seed.goalId,
        jobId: seed.jobId
      });
      expect(replay.decision).toBe("already_reduced");
      expect(replay.reusedExistingDecision).toBe(true);
      expect(replay.nextJob?.jobId).toBe(firstNext.jobId);
      expect(replay.nextJob?.created).toBe(false);

      const iterationTwoJobs = (
        db
          .prepare(
            "SELECT count(*) AS c FROM jobs WHERE goal_id = ? AND iteration = 2"
          )
          .get(seed.goalId) as { c: number }
      ).c;
      expect(iterationTwoJobs).toBe(1);

      const reducedEventCount = (
        db
          .prepare(
            "SELECT count(*) AS c FROM events WHERE goal_id = ? AND job_id = ? AND type = 'goal.reduced'"
          )
          .get(seed.goalId, seed.jobId) as { c: number }
      ).c;
      expect(reducedEventCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("drains a 2-iteration fake-runner goal end-to-end through queued worker execution", () => {
    const dataDir = makeTempDir("momentum-worker-run-2iter-drain-");
    const repo = initRepo();
    const seed = seedQueuedGoal(
      dataDir,
      repo,
      makeGoalSpec("true", { maxIterations: 2 })
    );
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const db = openDb(seed.dataDir);
    try {
      const firstRun = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-drain-1"
      });
      expect(firstRun.code).toBe("ran_job");
      if (firstRun.code !== "ran_job") return;
      expect(firstRun.jobIterationResult.ok).toBe(true);
      if (!firstRun.jobIterationResult.ok) return;
      expect(firstRun.reducerError).toBeNull();
      expect(firstRun.reducer).not.toBeNull();
      const firstReducer = firstRun.reducer!;
      expect(firstReducer.decision).toBe("continue");
      expect(firstReducer.goalState).toBe("queued");
      const iterOneCommitSha = firstRun.jobIterationResult.iteration.commitSha;
      expect(iterOneCommitSha).toMatch(/^[0-9a-f]{40}$/);
      const branch = firstRun.jobIterationResult.iteration.branch;
      expect(branch).toMatch(/^momentum\//);

      const nextJobInfo = firstReducer.nextJob!;
      expect(nextJobInfo.iteration).toBe(2);
      expect(nextJobInfo.idempotencyKey).toBe(
        buildIterationIdempotencyKey(seed.goalId, 2)
      );
      expect(nextJobInfo.created).toBe(true);

      const secondRun = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-drain-2"
      });
      expect(secondRun.code).toBe("ran_job");
      if (secondRun.code !== "ran_job") return;
      expect(secondRun.jobId).toBe(nextJobInfo.jobId);
      expect(secondRun.iteration).toBe(2);
      expect(secondRun.jobIterationResult.ok).toBe(true);
      if (!secondRun.jobIterationResult.ok) return;
      expect(secondRun.reducerError).toBeNull();
      expect(secondRun.reducer).not.toBeNull();
      const secondReducer = secondRun.reducer!;
      expect(secondReducer.decision).toBe("max_iterations_reached");
      expect(secondReducer.goalState).toBe("max_iterations_reached");
      expect(secondReducer.completionReason).toBe("max_iterations_reached:2");
      expect(secondReducer.nextJob).toBeNull();

      const iterTwoCommitSha = secondRun.jobIterationResult.iteration.commitSha;
      expect(iterTwoCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(iterTwoCommitSha).not.toBe(iterOneCommitSha);
      expect(secondRun.jobIterationResult.iteration.baseHead).toBe(
        iterOneCommitSha
      );
      expect(secondRun.jobIterationResult.iteration.branch).toBe(branch);
      expect(secondRun.jobIterationResult.iteration.branchCreated).toBe(false);

      // main is untouched; momentum branch holds both commits stacked on baseHead.
      expect(runGit(repo, ["rev-parse", "main"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["rev-parse", branch]).trim()).toBe(iterTwoCommitSha);
      const stackedCount = Number(
        runGit(repo, ["rev-list", "--count", `${baseHead}..${branch}`]).trim()
      );
      expect(stackedCount).toBe(2);
      const parent = runGit(repo, ["rev-parse", `${branch}^`]).trim();
      expect(parent).toBe(iterOneCommitSha);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");

      // Per-iteration artifact directories exist with the expected files.
      for (const iteration of [1, 2]) {
        const iterDir = path.join(
          seed.dataDir,
          "goals",
          seed.goalId,
          "iterations",
          String(iteration)
        );
        for (const file of ["prompt.md", "runner.log", "verification.log", "result.json"]) {
          expect(
            fs.existsSync(path.join(iterDir, file)),
            `missing artifact for iteration ${iteration}: ${file}`
          ).toBe(true);
        }
      }

      // Goal row reflects the terminal max-iterations state.
      const goalRow = db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow).toMatchObject({
        state: "max_iterations_reached",
        current_iteration: 2,
        completion_reason: "max_iterations_reached:2"
      });

      // Both job rows are succeeded; iteration 2 carries the second jobId.
      const jobRows = db
        .prepare(
          "SELECT id, iteration, state FROM jobs WHERE goal_id = ? ORDER BY iteration ASC"
        )
        .all(seed.goalId) as Array<{
        id: string;
        iteration: number;
        state: string;
      }>;
      expect(jobRows).toEqual([
        { id: seed.jobId, iteration: 1, state: "succeeded" },
        { id: nextJobInfo.jobId, iteration: 2, state: "succeeded" }
      ]);

      // Event tail covers both iterations with the chaining-ON, then terminal-failed reducer outputs.
      const eventTypes = (
        db
          .prepare(
            "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
          )
          .all(seed.goalId) as Array<{ type: string }>
      ).map((row) => row.type);
      expect(eventTypes).toEqual([
        "job.enqueued",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded",
        "job.enqueued",
        "goal.reduced",
        "job.claimed",
        "job.heartbeat",
        "iteration_started",
        "iteration_completed",
        "job.succeeded",
        "goal.reduced",
        "goal.failed"
      ]);

      // No iteration 3 ever enqueued.
      const nonexistent = getJobByIdempotencyKey(
        db,
        buildIterationIdempotencyKey(seed.goalId, 3)
      );
      expect(nonexistent).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("reports reducer exceptions as failed worker runs", () => {
    const dataDir = makeTempDir("momentum-worker-run-reducer-throw-");
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);

    const spy = vi
      .spyOn(goalReducerModule, "reduceGoalIteration")
      .mockImplementation(() => {
        throw new Error("synthetic reducer failure");
      });

    const db = openDb(seed.dataDir);
    try {
      const out = runWorkerOnce({
        db,
        dataDir: seed.dataDir,
        workerId: "worker-reducer-throw"
      });

      expect(out.code).toBe("ran_job");
      if (out.code !== "ran_job") return;
      expect(out.ok).toBe(false);
      expect(out.jobIterationResult.ok).toBe(true);
      expect(out.reducer).toBeNull();
      expect(out.reducerError).toBe("synthetic reducer failure");

      const eventTypes = (
        db
          .prepare("SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC")
          .all(seed.goalId) as Array<{ type: string }>
      ).map((row) => row.type);
      expect(eventTypes).toContain("goal.reduce_failed");
      expect(eventTypes).not.toContain("goal.reduced");

      const reduceFailedRow = db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.reduce_failed' ORDER BY id DESC LIMIT 1"
        )
        .get(seed.goalId) as { payload: string };
      const reduceFailedPayload = JSON.parse(reduceFailedRow.payload) as Record<
        string,
        unknown
      >;
      expect(reduceFailedPayload["worker_id"]).toBe("worker-reducer-throw");
      expect(reduceFailedPayload["error"]).toBe("synthetic reducer failure");
      expect(reduceFailedPayload["iteration"]).toBe(1);

      const job = getQueueJob(db, seed.jobId);
      expect(job?.state).toBe("succeeded");

      const goalRow = db
        .prepare("SELECT state FROM goals WHERE id = ?")
        .get(seed.goalId) as { state: string };
      expect(goalRow.state).toBe("iteration_complete");
    } finally {
      db.close();
      spy.mockRestore();
    }
  });
});
