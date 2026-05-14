import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { VERSION, runCli } from "../src/cli.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV
} from "../src/fake-runner.js";

const GOAL_SPEC = `---
title: CLI Test Goal
runner: fake
verification:
  - true
---

Goal body.
`;

const FAILING_GOAL_SPEC = `---
title: Failing CLI Goal
runner: fake
verification:
  - false
---

This goal fails verification.
`;

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
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
});

function makeTempDir(prefix = "momentum-cli-"): string {
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
  const dir = makeTempDir("momentum-cli-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function setupGoalAndData(spec = GOAL_SPEC): {
  dataDir: string;
  goalFile: string;
  repo: string;
} {
  const dataDir = makeTempDir("momentum-cli-data-");
  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, spec, "utf-8");
  const repo = initRepo();
  return { dataDir, goalFile, repo };
}

describe("momentum CLI scaffold", () => {
  it("prints help with the Milestone 1 public commands", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain("momentum status [goal-id] [--data-dir <path>] [--json]");
    expect(result.stdout).toContain(
      "momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain("momentum handoff <goal-id> [--data-dir <path>] [--json]");
    expect(result.stdout).toContain(
      "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain(
      "momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain(
      "momentum daemon stop [--reason <text>] [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain(
      "momentum daemon status [--data-dir <path>] [--json]"
    );
    expect(result.stdout).toContain("momentum doctor [--json]");
    expect(result.stderr).toBe("");
  });

  it("prints the scaffold version", async () => {
    const result = await run(["--version"]);

    expect(result).toEqual({
      code: 0,
      stdout: `${VERSION}\n`,
      stderr: ""
    });
  });

  it("runs doctor in text mode", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-");
    const result = await run(["doctor", "--data-dir", dataDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Momentum doctor: ok");
    expect(result.stdout).toContain(
      "scope: Milestone 3: managed daemon loop for queued jobs (NGX-272, NGX-273)"
    );
    expect(result.stdout).toContain("daemon: never started");
    expect(result.stderr).toBe("");
  });

  it("runs doctor in json mode", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-");
    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "doctor",
      version: VERSION,
      milestone:
        "Milestone 3: managed daemon loop for queued jobs (NGX-272, NGX-273)"
    });
    expect(payload["daemon"]).toEqual({
      ok: true,
      dataDir,
      hasRun: false,
      state: null,
      isActive: false,
      stale: false,
      staleRunCount: 0,
      runId: null
    });
    expect(result.stderr).toBe("");
  });

  it("doctor --json surfaces an active daemon run", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-active-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    const db = openDb(dataDir);
    try {
      // Use a fresh `now` so the default stale window does not classify the
      // record as stale by the time `doctor` is invoked.
      startDaemonRun(db, { pid: 4242, host: "node-doctor", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      ok: true,
      hasRun: true,
      state: "running",
      isActive: true,
      stale: false,
      staleRunCount: 0
    });
    expect(typeof daemon["runId"]).toBe("string");
  });

  it("goal start runs a foreground iteration that commits and returns iteration_complete", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "goal start",
      state: "iteration_complete",
      title: "CLI Test Goal",
      resumed: false
    });
    expect(typeof payload["goalId"]).toBe("string");
    expect(typeof payload["jobId"]).toBe("string");

    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({
      ok: true,
      iteration: 1,
      branch: "momentum/cli-test-goal",
      branchCreated: true,
      runnerSuccess: true,
      goalComplete: false
    });
    expect(iter["baseHead"]).toMatch(/^[0-9a-f]{40}$/);
    expect(iter["postRunnerHead"]).toBe(iter["baseHead"]);
    expect(iter["repoPath"]).toBe(repo);
    expect(iter["commitSha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(iter["commitSha"]).not.toBe(iter["baseHead"]);
    expect(typeof iter["commitMessage"]).toBe("string");

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(true);
    expect(fs.existsSync(iter["promptPath"] as string)).toBe(true);
    expect(fs.existsSync(iter["runnerLogPath"] as string)).toBe(true);
    expect(fs.existsSync(iter["resultJsonPath"] as string)).toBe(true);
    expect(fs.existsSync(iter["verificationLogPath"] as string)).toBe(true);
    expect(result.stderr).toBe("");
  });

  it("goal start accepts --foreground before the goal file", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start",
      "--foreground",
      goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "goal start",
      state: "iteration_complete",
      title: "CLI Test Goal"
    });
    expect(result.stderr).toBe("");
  });

  it("goal start surfaces unsupported_runner when --runner overrides to a non-fake profile", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--runner", "custom-runner",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      state: "failed",
      code: "iteration_failed",
      resumed: false
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({
      ok: false,
      code: "unsupported_runner"
    });
    expect(result.stdout).toBe("");
  });

  it("goal start returns init_error when data dir cannot initialize", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-cli-"));
    const goalFile = path.join(dataDir, "goal.md");
    const blockedDataDir = path.join(dataDir, "blocked");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");
    fs.writeFileSync(blockedDataDir, "not a directory", "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--data-dir", blockedDataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      code: "init_error"
    });
    expect(result.stdout).toBe("");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("goal start returns init_error for a missing goal file", async () => {
    const result = await run([
      "goal", "start", "/no/such/goal.md",
      "--foreground",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      code: "init_error"
    });
    expect(result.stdout).toBe("");
  });

  it("goal start text mode prints iteration summary", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Goal initialized:");
    expect(result.stdout).toContain("CLI Test Goal");
    expect(result.stdout).toContain("Branch: momentum/cli-test-goal (created)");
    expect(result.stdout).toContain("State: iteration_complete");
    expect(result.stdout).toMatch(/Commit: [0-9a-f]{40}/);
    expect(result.stderr).toBe("");
  });

  it("goal start (default queued path) creates a queued goal and a pending goal_iteration job without running the runner", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--runner", "fake",
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "goal start",
      mode: "queued",
      goalState: "queued",
      jobType: "goal_iteration",
      jobState: "pending",
      title: "CLI Test Goal",
      repo,
      branch: "momentum/cli-test-goal",
      baseHead: null,
      runner: "fake",
      iteration: 1,
      resumed: false,
      enqueueCreated: true
    });
    expect(typeof payload["goalId"]).toBe("string");
    expect(typeof payload["jobId"]).toBe("string");
    expect(payload["idempotencyKey"]).toBe(
      `goal:${payload["goalId"]}:iteration:1`
    );
    expect(typeof payload["nextAction"]).toBe("string");
    expect(payload["nextAction"] as string).toContain("worker");
    expect(payload["iterationArtifactDir"]).toBe(
      path.join(dataDir, "goals", payload["goalId"] as string, "iterations", "1")
    );

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const goalRow = db
        .prepare("SELECT state FROM goals WHERE id = ?")
        .get(payload["goalId"] as string) as { state: string };
      expect(goalRow.state).toBe("queued");

      const jobs = db
        .prepare("SELECT * FROM jobs WHERE goal_id = ? ORDER BY created_at ASC")
        .all(payload["goalId"] as string) as Array<Record<string, unknown>>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: payload["jobId"],
        type: "goal_iteration",
        state: "pending",
        iteration: 1,
        idempotency_key: payload["idempotencyKey"]
      });

      const events = db
        .prepare("SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC")
        .all(payload["goalId"] as string) as Array<{ type: string }>;
      expect(events.map((row) => row.type)).toEqual(["job.enqueued"]);
    } finally {
      db.close();
    }
  });

  it("goal start (default queued path) persists relative repo paths as absolute", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    const originalCwd = process.cwd();

    try {
      process.chdir(repo);

      const result = await run([
        "goal", "start", goalFile,
        "--repo", ".",
        "--data-dir", dataDir,
        "--json"
      ]);

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload["repo"]).toBe(repo);

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT repo FROM goals WHERE id = ?")
          .get(payload["goalId"] as string) as { repo: string };
        expect(goalRow.repo).toBe(repo);
      } finally {
        db.close();
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("goal start (default queued path) is idempotent for the same goal spec", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const first = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const firstPayload = JSON.parse(first.stdout) as Record<string, unknown>;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.prepare(
        "UPDATE jobs SET state = 'running' WHERE id = ?"
      ).run(firstPayload["jobId"] as string);
    } finally {
      db.close();
    }

    const second = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const secondPayload = JSON.parse(second.stdout) as Record<string, unknown>;

    expect(second.code).toBe(0);
    expect(secondPayload["goalId"]).toBe(firstPayload["goalId"]);
    expect(secondPayload["jobId"]).toBe(firstPayload["jobId"]);
    expect(secondPayload["jobState"]).toBe("running");
    expect(secondPayload["resumed"]).toBe(true);
    expect(secondPayload["enqueueCreated"]).toBe(false);

    const verifyDb = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const jobCount = verifyDb
        .prepare("SELECT count(*) AS c FROM jobs WHERE goal_id = ?")
        .get(firstPayload["goalId"] as string) as { c: number };
      expect(jobCount.c).toBe(1);

      const enqueueEvents = verifyDb
        .prepare(
          "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'job.enqueued'"
        )
        .get(firstPayload["goalId"] as string) as { c: number };
      expect(enqueueEvents.c).toBe(1);
    } finally {
      verifyDb.close();
    }
  });

  it("goal start (default queued path) text mode prints queued summary and next action", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const result = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Goal initialized:");
    expect(result.stdout).toContain("Goal state: queued");
    expect(result.stdout).toContain("goal_iteration, pending, iteration 1");
    expect(result.stdout).toMatch(/Next: Goal queued\. Run `momentum worker run/);
  });

  it("worker run returns no_work in JSON when nothing is queued", async () => {
    const dataDir = makeTempDir("momentum-cli-worker-noop-");

    const result = await run([
      "worker", "run",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "worker run",
      code: "no_work",
      outcome: "idle",
      workerId: `worker-${process.pid}`,
      dataDir
    });
    expect(payload["message"]).toBe(
      "No pending goal_iteration jobs were available."
    );
  });

  it("worker run executes one queued goal_iteration job and records queue/lock artifacts", async () => {
    const dataDir = makeTempDir("momentum-cli-worker-exec-");
    const repo = initRepo();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

    const queued = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const queuedPayload = JSON.parse(queued.stdout) as Record<string, unknown>;
    const goalId = queuedPayload["goalId"] as string;
    const jobId = queuedPayload["jobId"] as string;

    const workerRun = await run([
      "worker", "run",
      "--worker-id", "cli-worker",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(workerRun.code).toBe(0);
    expect(workerRun.stderr).toBe("");
    const payload = JSON.parse(workerRun.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "worker run",
      code: "ran_job",
      outcome: "ran_job",
      workerId: "cli-worker",
      goalId,
      jobId,
      iteration: 1,
      goalState: "iteration_complete",
      jobState: "succeeded",
      repoRoot: repo
    });

    const resultPayload = payload["jobIterationResult"] as Record<string, unknown>;
    expect(resultPayload).toMatchObject({
      ok: true,
      goalState: "iteration_complete",
      jobState: "succeeded"
    });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const job = db
        .prepare("SELECT state, worker_id FROM jobs WHERE id = ?")
        .get(jobId) as { state: string; worker_id: string };
      expect(job.state).toBe("succeeded");
      expect(job.worker_id).toBe("cli-worker");

      const lock = db
        .prepare(
          "SELECT state, holder, recovery_status FROM repo_locks WHERE job_id = ? ORDER BY acquired_at DESC LIMIT 1"
        )
        .get(jobId) as { state: string; holder: string; recovery_status: string };
      expect(lock).toMatchObject({
        state: "released",
        holder: "cli-worker",
        recovery_status: "iteration_success"
      });

      const events = db
        .prepare(
          "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
        )
        .all(goalId) as Array<{ type: string }>;
      expect(events.map((row) => row.type)).toEqual([
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

  it("worker run returns ran_job failure as ok=false and exit 1 when verification fails", async () => {
    const dataDir = makeTempDir("momentum-cli-worker-fail-");
    const repo = initRepo();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, FAILING_GOAL_SPEC, "utf-8");

    const queued = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const queuedPayload = JSON.parse(queued.stdout) as Record<string, unknown>;
    const goalId = queuedPayload["goalId"] as string;
    const jobId = queuedPayload["jobId"] as string;

    const workerRun = await run([
      "worker", "run",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(workerRun.code).toBe(1);
    expect(workerRun.stderr).toBe("");
    const payload = JSON.parse(workerRun.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "worker run",
      code: "ran_job",
      outcome: "ran_job",
      workerId: `worker-${process.pid}`,
      goalId,
      jobId,
      goalState: "failed",
      jobState: "failed",
      repoRoot: repo
    });
    const resultPayload = payload["jobIterationResult"] as Record<string, unknown>;
    expect(resultPayload).toMatchObject({
      ok: false,
      goalState: "failed",
      jobState: "failed"
    });
    const iteration = resultPayload["iteration"] as Record<string, unknown>;
    expect(iteration).toMatchObject({
      ok: false,
      code: "verification_failed"
    });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const job = db
        .prepare("SELECT state, worker_id FROM jobs WHERE id = ?")
        .get(jobId) as { state: string; worker_id: string };
      expect(job.state).toBe("failed");
      expect(job.worker_id).toBe(`worker-${process.pid}`);
    } finally {
      db.close();
    }
  });

  it("worker run returns not_executed with ok=true and exit 0 when repo lock contention blocks claim", async () => {
    const dataDir = makeTempDir("momentum-cli-worker-contended-");
    const repo = initRepo();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

    const queued = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const queuedPayload = JSON.parse(queued.stdout) as Record<string, unknown>;
    const goalId = queuedPayload["goalId"] as string;
    const jobId = queuedPayload["jobId"] as string;

    const { acquireRepoLock } = await import("../src/repo-locks.js");
    const { openDb } = await import("../src/db.js");
    const setupDb = openDb(dataDir);
    let blockingLockId: string;
    try {
      const acquired = acquireRepoLock(setupDb, {
        repoRoot: repo,
        holder: "other-worker",
        goalId,
        iteration: 1,
        jobId,
        leaseExpiresAt: Date.now() + 60_000
      });
      if (!acquired.ok) throw new Error("seed lock did not acquire");
      blockingLockId = acquired.lockId;
    } finally {
      setupDb.close();
    }

    const workerRun = await run([
      "worker", "run",
      "--worker-id", "contended-worker",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(workerRun.code).toBe(0);
    expect(workerRun.stderr).toBe("");
    const payload = JSON.parse(workerRun.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "worker run",
      code: "not_executed",
      outcome: "not_executed",
      workerId: "contended-worker",
      goalId,
      jobId,
      reason: "repo_lock_already_locked",
      lockId: blockingLockId
    });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const job = db
        .prepare("SELECT state, worker_id FROM jobs WHERE id = ?")
        .get(jobId) as { state: string; worker_id: string | null };
      expect(job.state).toBe("pending");
      expect(job.worker_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("rejects --worker-id without a value", async () => {
    const result = await run([
      "worker", "run",
      "--worker-id",
      "--data-dir", "/tmp",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required value for --worker-id."
    });
    expect(result.stdout).toBe("");
  });

  it("rejects --worker-id with an empty value", async () => {
    const result = await run([
      "worker", "run",
      "--worker-id", "",
      "--data-dir", "/tmp",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required value for --worker-id."
    });
    expect(result.stdout).toBe("");
  });

  it("rejects --data-dir without a value", async () => {
    const result = await run([
      "goal", "start", "goal.md",
      "--foreground",
      "--data-dir",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required value for --data-dir."
    });
    expect(result.stdout).toBe("");
  });

  it("rejects extra positional arguments for goal start", async () => {
    const result = await run([
      "goal", "start", "goal.md", "--foreground", "--typo", "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Unexpected argument for goal start: --typo"
    });
    expect(result.stdout).toBe("");
  });

  it("handoff returns goal_not_found in JSON mode when the goalId is missing", async () => {
    const dataDir = makeTempDir("momentum-cli-data-");
    const result = await run([
      "handoff", "no-such-goal", "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "handoff",
      code: "goal_not_found",
      goalId: "no-such-goal"
    });
    expect(result.stdout).toBe("");
  });

  it("handoff usage error when goal-id is missing", async () => {
    const result = await run(["handoff", "--json"]);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required <goal-id> for handoff."
    });
    expect(result.stdout).toBe("");
  });

  it("handoff rejects extra positional arguments", async () => {
    const result = await run(["handoff", "goal-1", "extra", "--json"]);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Unexpected argument for handoff: extra"
    });
    expect(result.stdout).toBe("");
  });

  it("handoff writes artifacts and emits the verified-commit payload after goal start", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const startPayload = JSON.parse(startResult.stdout) as Record<string, unknown>;
    const goalId = startPayload["goalId"] as string;
    const jobId = startPayload["jobId"] as string;

    const result = await run([
      "handoff", goalId, "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "handoff",
      goalId,
      title: "CLI Test Goal",
      state: "iteration_complete",
      goalState: "iteration_complete",
      schemaVersion: 1
    });
    expect(typeof payload["generatedAt"]).toBe("number");
    expect(payload["latestCommitSha"]).toMatch(/^[0-9a-f]{40}$/);
    const currentIterationDetail = payload[
      "currentIterationDetail"
    ] as Record<string, unknown>;
    expect(currentIterationDetail).toMatchObject({
      number: 1,
      jobId,
      state: "succeeded"
    });
    expect(payload["nextActionDetail"]).toBeNull();

    const handoffMdPath = payload["handoffMdPath"] as string;
    const handoffJsonPath = payload["handoffJsonPath"] as string;
    expect(fs.existsSync(handoffMdPath)).toBe(true);
    expect(fs.existsSync(handoffJsonPath)).toBe(true);

    const iteration = payload["iteration"] as Record<string, unknown>;
    expect(iteration["commitSha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(iteration["runnerSuccess"]).toBe(true);

    const runnerResult = payload["runnerResult"] as Record<string, unknown>;
    expect(runnerResult["summary"]).toBe("Applied fake runner fixture.");

    const fileJson = JSON.parse(fs.readFileSync(handoffJsonPath, "utf-8"));
    expect(fileJson).toMatchObject({
      schema_version: 1,
      goal: { id: goalId, title: "CLI Test Goal", state: "iteration_complete" }
    });

    const md = fs.readFileSync(handoffMdPath, "utf-8");
    expect(md).toContain("# Momentum handoff: CLI Test Goal");
    expect(md).toMatch(/Commit SHA: [0-9a-f]{40}/);
    expect(result.stderr).toBe("");
  });

  it("handoff text mode prints the artifact paths", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const startPayload = JSON.parse(startResult.stdout) as Record<string, unknown>;
    const goalId = startPayload["goalId"] as string;

    const result = await run(["handoff", goalId, "--data-dir", dataDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Handoff written for goal: ${goalId}`);
    expect(result.stdout).toContain("Title: CLI Test Goal");
    expect(result.stdout).toContain("State: iteration_complete");
    expect(result.stdout).toMatch(/handoff\.md: .+handoff\.md/);
    expect(result.stdout).toMatch(/handoff\.json: .+handoff\.json/);
    expect(result.stdout).toMatch(/Commit: [0-9a-f]{40}/);
    expect(result.stderr).toBe("");
  });

  it("status returns goal_not_found in JSON mode when goalId is missing in the data dir", async () => {
    const dataDir = makeTempDir("momentum-cli-data-");

    const result = await run([
      "status", "no-such-goal", "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "status",
      code: "goal_not_found",
      goalId: "no-such-goal"
    });
    expect(result.stdout).toBe("");
  });

  it("status returns no_goals when no goalId and the data dir is empty", async () => {
    const dataDir = makeTempDir("momentum-cli-data-");

    const result = await run(["status", "--data-dir", dataDir, "--json"]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "status",
      code: "no_goals",
      goalId: null
    });
  });

  it("status returns the latest goal payload after goal start", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const startPayload = JSON.parse(startResult.stdout) as Record<string, unknown>;
    const goalId = startPayload["goalId"] as string;

    const statusResult = await run([
      "status", goalId, "--data-dir", dataDir, "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    expect(statusPayload).toMatchObject({
      ok: true,
      command: "status",
      goalId,
      title: "CLI Test Goal",
      state: "iteration_complete",
      repo,
      branch: "momentum/cli-test-goal",
      runner: "fake"
    });
    const iter = statusPayload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({
      iteration: 1,
      runnerSuccess: true,
      goalComplete: false,
      branchCreated: true,
      branch: "momentum/cli-test-goal"
    });
    expect(iter["commitSha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(statusResult.stderr).toBe("");
  });

  it("status text mode prints the goal summary", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const startPayload = JSON.parse(startResult.stdout) as Record<string, unknown>;
    const goalId = startPayload["goalId"] as string;

    const result = await run(["status", goalId, "--data-dir", dataDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Goal: ${goalId}`);
    expect(result.stdout).toContain("Title: CLI Test Goal");
    expect(result.stdout).toContain("State: iteration_complete");
    expect(result.stdout).toContain("Branch: momentum/cli-test-goal");
    expect(result.stdout).toMatch(/Commit: [0-9a-f]{40}/);
    expect(result.stderr).toBe("");
  });

  it("status rejects extra positional arguments", async () => {
    const result = await run(["status", "goal-1", "extra", "--json"]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Unexpected argument for status: extra"
    });
    expect(result.stdout).toBe("");
  });

  it("logs usage error when goal-id is missing", async () => {
    const result = await run(["logs", "--json"]);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required <goal-id> for logs."
    });
  });

  it("logs returns goal_not_found in JSON mode for an unknown goalId", async () => {
    const dataDir = makeTempDir("momentum-cli-data-");

    const result = await run([
      "logs",
      "no-such-goal",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "logs",
      code: "goal_not_found",
      goalId: "no-such-goal"
    });
  });

  it("logs --json returns runner.log/verification.log content after a successful goal start", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const startPayload = JSON.parse(startResult.stdout) as Record<string, unknown>;
    const goalId = startPayload["goalId"] as string;

    const logsResult = await run([
      "logs", goalId, "--data-dir", dataDir, "--json"
    ]);

    expect(logsResult.code).toBe(0);
    const payload = JSON.parse(logsResult.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "logs",
      goalId,
      iteration: 1,
      availableIterations: [1]
    });
    const runnerLog = payload["runnerLog"] as Record<string, unknown>;
    expect(runnerLog["exists"]).toBe(true);
    expect(runnerLog["bytes"]).toBeGreaterThan(0);
    expect(typeof runnerLog["content"]).toBe("string");
    expect((runnerLog["content"] as string).length).toBeGreaterThan(0);
    const verificationLog = payload["verificationLog"] as Record<string, unknown>;
    expect(verificationLog["exists"]).toBe(true);
    expect(verificationLog["bytes"]).toBeGreaterThan(0);
    expect(typeof verificationLog["content"]).toBe("string");
    expect(logsResult.stderr).toBe("");
  });

  it("logs --iteration returns iteration_not_found for an unknown iteration", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const goalId = (JSON.parse(startResult.stdout) as Record<string, unknown>)[
      "goalId"
    ] as string;

    const result = await run([
      "logs",
      goalId,
      "--iteration",
      "9",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "logs",
      code: "iteration_not_found",
      goalId
    });
    expect(payload["message"]).toContain("Iteration 9");
  });

  it("logs text mode prints headed sections for runner.log and verification.log", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();

    const startResult = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    const goalId = (JSON.parse(startResult.stdout) as Record<string, unknown>)[
      "goalId"
    ] as string;

    const result = await run(["logs", goalId, "--data-dir", dataDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Goal: ${goalId}`);
    expect(result.stdout).toContain("Iteration: 1");
    expect(result.stdout).toContain("Available iterations: 1");
    expect(result.stdout).toContain("## runner.log");
    expect(result.stdout).toContain("## verification.log");
    expect(result.stderr).toBe("");
  });

  it("logs rejects invalid --iteration values", async () => {
    const result = await run([
      "logs",
      "goal-1",
      "--iteration",
      "0",
      "--json"
    ]);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Invalid value for --iteration: 0"
    });
  });

  it("logs rejects partially numeric --iteration values", async () => {
    const result = await run([
      "logs",
      "goal-1",
      "--iteration",
      "1abc",
      "--json"
    ]);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Invalid value for --iteration: 1abc"
    });
    expect(result.stdout).toBe("");
  });

  it("goal start surfaces repo_guard_failed when the worktree is dirty", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      state: "failed",
      code: "iteration_failed"
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({ ok: false, code: "repo_guard_failed" });
    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(false);
    expect(result.stdout).toBe("");
  });

  it("goal start surfaces branch_manager_failed when the branch exists without metadata", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    runGit(repo, ["checkout", "--quiet", "-b", "momentum/cli-test-goal"]);
    runGit(repo, ["checkout", "--quiet", "main"]);

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      state: "failed",
      code: "iteration_failed"
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({ ok: false, code: "branch_manager_failed" });
    expect(result.stdout).toBe("");
  });

  it("goal start surfaces missing_repo when neither --repo nor frontmatter repo is set", async () => {
    const dataDir = makeTempDir("momentum-cli-data-");
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      state: "failed",
      code: "iteration_failed"
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({ ok: false, code: "missing_repo" });
  });

  it("goal start text mode prints iteration_failed message on failure", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("repo_guard_failed:");
    expect(result.stdout).toBe("");
  });

  it("goal start surfaces runner_reported_failure and resets to base HEAD when the runner fails", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();
    process.env[FAKE_RUNNER_FAIL_ENV] = "1";

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");

    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      state: "failed",
      code: "iteration_failed"
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({ ok: false, code: "runner_reported_failure" });
    expect(typeof iter["error"]).toBe("string");
    expect((iter["error"] as string).length).toBeGreaterThan(0);

    expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );

    const goalId = payload["goalId"] as string;
    const runnerLog = path.join(
      dataDir,
      "goals",
      goalId,
      "iterations",
      "1",
      "runner.log"
    );
    const verificationLog = path.join(
      dataDir,
      "goals",
      goalId,
      "iterations",
      "1",
      "verification.log"
    );
    expect(fs.readFileSync(runnerLog, "utf-8")).toContain(
      `simulated failure via ${FAKE_RUNNER_FAIL_ENV}`
    );
    expect(fs.readFileSync(verificationLog, "utf-8")).toContain(
      "[verify] skipped: runner reported failure"
    );
  });

  it("goal start surfaces verification_failed and resets to base HEAD when a verification command exits non-zero", async () => {
    const failingSpec = `---
title: CLI Test Goal
runner: fake
verification:
  - false
---

Goal body.
`;
    const { dataDir, goalFile, repo } = setupGoalAndData(failingSpec);
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");

    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      state: "failed",
      code: "iteration_failed"
    });
    const iter = payload["iteration"] as Record<string, unknown>;
    expect(iter).toMatchObject({ ok: false, code: "verification_failed" });

    expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );

    const goalId = payload["goalId"] as string;
    const runnerLog = path.join(
      dataDir,
      "goals",
      goalId,
      "iterations",
      "1",
      "runner.log"
    );
    const verificationLog = path.join(
      dataDir,
      "goals",
      goalId,
      "iterations",
      "1",
      "verification.log"
    );
    expect(fs.existsSync(runnerLog)).toBe(true);
    const verificationLogText = fs.readFileSync(verificationLog, "utf-8");
    expect(verificationLogText).toContain("[verify] running: false");
    expect(verificationLogText).toContain("[verify]   exit_code: 1");
    expect(verificationLogText).toContain(
      "[verify] summary: verification failed on command 1: false"
    );
  });

  it("rejects unknown commands with usage", async () => {
    const result = await run(["wat"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).toContain("Usage:");
  });

  it("daemon status (no-daemon) exits 0 with hasRun=false in json mode", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon status",
      dataDir,
      hasRun: false,
      daemonRun: null,
      staleRuns: []
    });
    expect(typeof payload["staleAfterMs"]).toBe("number");
    expect(typeof payload["observedAt"]).toBe("number");
    expect(result.stderr).toBe("");
  });

  it("daemon status (no-daemon) text mode prints 'never started'", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon: never started");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon status surfaces an active running daemon", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 12345,
        host: "node-test",
        now: 1_000
      }));
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: 1_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon status",
      hasRun: true
    });
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      runId,
      pid: 12345,
      host: "node-test",
      state: "running",
      isActive: true,
      isTerminal: false,
      startedAt: 1_000
    });
    expect(run0["activeJob"]).toEqual({ jobId: "job-1", lockId: "lock-1" });
    expect(run0["stopRequest"]).toBeNull();
    expect(run0["error"]).toBeNull();
    expect(result.stderr).toBe("");
  });

  it("daemon status surfaces stop-requested state with reason", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      requestDaemonRunStop(db, {
        runId,
        reason: "operator-shutdown",
        now: 2_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      state: "stop_requested",
      isActive: true,
      isTerminal: false
    });
    expect(run0["stopRequest"]).toEqual({
      requestedAt: 2_000,
      reason: "operator-shutdown"
    });
  });

  it("daemon status surfaces terminal error state with last error", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      finishDaemonRun(db, {
        runId,
        terminalState: "error",
        error: "kaboom",
        now: 2_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ hasRun: true });
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      state: "error",
      isActive: false,
      isTerminal: true,
      finishedAt: 2_000
    });
    expect(run0["error"]).toEqual({ message: "kaboom", at: 2_000 });
  });

  it("daemon status flags stale active records without auto-recovering", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    const db = openDb(dataDir);
    try {
      startDaemonRun(db, { pid: 1, now: 100 });
    } finally {
      db.close();
    }

    // Far enough in the future that the default 90s stale cutoff triggers.
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0["state"]).toBe("running");
    expect(run0["stale"]).toBe(true);
    expect(run0["isActive"]).toBe(true);
    const staleRuns = payload["staleRuns"] as Array<Record<string, unknown>>;
    expect(staleRuns).toHaveLength(1);
    expect(staleRuns[0]).toMatchObject({
      runId: run0["runId"],
      stale: true
    });
  });

  it("daemon status keeps in-flight active work fresh until the active-job cutoff", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, {
        pid: 1,
        now: Date.now() - 100_000
      });
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: Date.now() - 100_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0["stale"]).toBe(false);
    expect(run0["activeJob"]).toEqual({ jobId: "job-1", lockId: "lock-1" });
    expect(payload["staleRuns"]).toEqual([]);
  });

  it("daemon with no subcommand prints a usage error", async () => {
    const result = await run(["daemon", "--json"]);
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error"
    });
    expect((payload["message"] as string).toLowerCase()).toContain("daemon");
    expect(result.stdout).toBe("");
  });

  it("daemon with unknown subcommand prints a usage error", async () => {
    const result = await run(["daemon", "wat"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown daemon subcommand: wat");
    expect(result.stdout).toBe("");
  });

  it("daemon status rejects extra positional arguments", async () => {
    const result = await run(["daemon", "status", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon status");
    expect(result.stdout).toBe("");
  });

  it("daemon start records a new orchestrator run and exits 0 (json)", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const before = Date.now();
    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);
    const after = Date.now();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon start",
      dataDir,
      state: "running"
    });
    expect(typeof payload["runId"]).toBe("string");
    expect((payload["runId"] as string).length).toBeGreaterThan(0);
    expect(payload["pid"]).toBe(process.pid);
    expect(typeof payload["host"]).toBe("string");
    expect((payload["host"] as string).length).toBeGreaterThan(0);
    expect(payload["startedAt"]).toBeGreaterThanOrEqual(before);
    expect(payload["startedAt"]).toBeLessThanOrEqual(after);
    expect(payload["heartbeatAt"]).toBe(payload["startedAt"]);
    expect(result.stderr).toBe("");

    // The new record should also be visible via `daemon status`.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const daemonRun = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(daemonRun["runId"]).toBe(payload["runId"]);
    expect(daemonRun["state"]).toBe("running");
    expect(daemonRun["isActive"]).toBe(true);
  });

  it("daemon start text mode prints the recorded run summary", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon run started:");
    expect(result.stdout).toContain("State: running");
    expect(result.stdout).toContain(`Pid: ${process.pid}`);
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon start refuses to record a second run while one is active", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: existingRunId } = startDaemonRun(db, {
        pid: 77,
        host: "node-existing",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon start",
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain(existingRunId);
    const existing = payload["existing"] as Record<string, unknown>;
    expect(existing).toMatchObject({
      runId: existingRunId,
      state: "running",
      pid: 77,
      host: "node-existing",
      stale: false
    });
  });

  it("daemon start refuses and flags stale heartbeats on the existing active run", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      // Heartbeat far in the past so the default 90s stale cutoff triggers.
      ({ runId: existingRunId } = startDaemonRun(db, { pid: 99, now: 100 }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain("stale heartbeat");
    const existing = payload["existing"] as Record<string, unknown>;
    expect(existing).toMatchObject({
      runId: existingRunId,
      stale: true
    });
    expect(existing["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon start allows a new run once the previous one terminates", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: Date.now() });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon start",
      state: "running"
    });
  });

  it("daemon start rejects extra positional arguments", async () => {
    const result = await run(["daemon", "start", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon start");
    expect(result.stdout).toBe("");
  });

  it("daemon stop records a stop request on the active run (json)", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    let activeRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: activeRunId } = startDaemonRun(db, {
        pid: 4242,
        host: "node-stop",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const before = Date.now();
    const result = await run([
      "daemon", "stop",
      "--reason", "operator-shutdown",
      "--data-dir", dataDir,
      "--json"
    ]);
    const after = Date.now();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon stop",
      dataDir,
      runId: activeRunId,
      previousState: "running",
      state: "stop_requested",
      stopReason: "operator-shutdown",
      alreadyStopRequested: false,
      pid: 4242,
      host: "node-stop",
      stale: false
    });
    expect(payload["stopRequestedAt"]).toBeGreaterThanOrEqual(before);
    expect(payload["stopRequestedAt"]).toBeLessThanOrEqual(after);
    expect(typeof payload["heartbeatAgeMs"]).toBe("number");
    expect(result.stderr).toBe("");

    // Status round-trip should reflect the recorded stop request.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const daemonRun = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(daemonRun["runId"]).toBe(activeRunId);
    expect(daemonRun["state"]).toBe("stop_requested");
    expect(daemonRun["stopRequest"]).toEqual({
      requestedAt: payload["stopRequestedAt"],
      reason: "operator-shutdown"
    });
  });

  it("daemon stop defaults --reason to 'operator-requested' and prints a text summary", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    const db = openDb(dataDir);
    try {
      startDaemonRun(db, { pid: 11, host: "node-default", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon stop requested:");
    expect(result.stdout).toContain("State: stop_requested");
    expect(result.stdout).toContain("Previous state: running");
    expect(result.stdout).toContain("Reason: operator-requested");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon stop is idempotent and refreshes the reason on a stop_requested run", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    let runId: string;
    const firstRequestedAt = Date.now() - 5_000;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, { pid: 22, now: firstRequestedAt }));
      requestDaemonRunStop(db, {
        runId,
        reason: "initial",
        now: firstRequestedAt
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--reason", "second-call",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon stop",
      runId,
      previousState: "stop_requested",
      state: "stop_requested",
      alreadyStopRequested: true,
      stopReason: "second-call"
    });
    // The original stop_requested_at is preserved (COALESCE in the primitive).
    expect(payload["stopRequestedAt"]).toBe(firstRequestedAt);
    expect(result.stdout).not.toContain("Daemon stop requested:");
  });

  it("daemon stop refuses when no daemon has ever started", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon stop",
      code: "no_active_daemon",
      latest: null
    });
    expect((payload["message"] as string).toLowerCase()).toContain(
      "no active daemon"
    );
  });

  it("daemon stop refuses when the latest run is already terminal and surfaces it", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/daemon-runs.js"
    );
    let runId: string;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 33,
        host: "node-old",
        now: Date.now() - 1_000
      }));
      finishDaemonRun(db, {
        runId,
        terminalState: "stopped",
        now: Date.now()
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon stop",
      code: "no_active_daemon"
    });
    const latest = payload["latest"] as Record<string, unknown>;
    expect(latest).toMatchObject({
      runId,
      state: "stopped",
      pid: 33,
      host: "node-old"
    });
    expect((payload["message"] as string).toLowerCase()).toContain("stopped");
  });

  it("daemon stop flags stale heartbeats on the active run but still records the request", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    let runId: string;
    const db = openDb(dataDir);
    try {
      // Started long ago so heartbeat_at is well past the default 90s cutoff.
      ({ runId } = startDaemonRun(db, { pid: 44, now: 100 }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      state: "stop_requested",
      stale: true
    });
    expect(payload["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon stop uses active-job freshness when reporting staleness", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/daemon-runs.js"
    );
    let runId: string;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 45,
        now: Date.now() - 100_000
      }));
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: Date.now() - 100_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      state: "stop_requested",
      stale: false
    });
    expect(payload["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon stop rejects extra positional arguments", async () => {
    const result = await run(["daemon", "stop", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon stop");
    expect(result.stdout).toBe("");
  });

  it("daemon stop rejects --reason without a value", async () => {
    const result = await run(["daemon", "stop", "--reason"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Missing required value for --reason");
    expect(result.stdout).toBe("");
  });

  it("daemon start with --max-idle-cycles 0 registers a run and exits with terminalState=stopped", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      workSucceeded: true,
      command: "daemon start",
      dataDir,
      state: "stopped"
    });
    expect(typeof payload["runId"]).toBe("string");
    const loop = payload["loop"] as Record<string, unknown>;
    expect(loop).toMatchObject({
      exitReason: "max_idle_cycles",
      terminalState: "stopped",
      workSucceeded: true,
      iterations: 0,
      jobsRun: 0,
      jobsFailed: 0,
      jobsNotExecuted: 0,
      idleCycles: 0
    });

    // The recorded run should be terminal in status afterwards.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const run0 = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(run0["state"]).toBe("stopped");
    expect(run0["isActive"]).toBe(false);
  });

  it("daemon start with --max-idle-cycles drains a queued goal end-to-end", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV] = "1";

    const enqueueResult = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(enqueueResult.code).toBe(0);
    const enqueuePayload = JSON.parse(enqueueResult.stdout) as Record<
      string,
      unknown
    >;
    const goalId = enqueuePayload["goalId"] as string;
    expect(goalId.length).toBeGreaterThan(0);

    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "2",
      "--poll-interval-ms", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      workSucceeded: true,
      command: "daemon start",
      dataDir,
      state: "stopped"
    });
    const loop = payload["loop"] as Record<string, unknown>;
    expect(loop["jobsRun"]).toBe(1);
    expect(loop["jobsFailed"]).toBe(0);
    expect(loop["workSucceeded"]).toBe(true);
    expect(loop["exitReason"]).toBe("max_idle_cycles");

    const statusResult = await run([
      "status", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<
      string,
      unknown
    >;
    expect(statusPayload["state"]).toBe("completed");
  });

  it("daemon start rejects --poll-interval-ms without a loop bound", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--poll-interval-ms", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--poll-interval-ms requires --max-loop-iterations or --max-idle-cycles."
    );
  });

  it("daemon start exits non-zero when bounded loop work fails", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData(FAILING_GOAL_SPEC);
    const enqueueResult = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(enqueueResult.code).toBe(0);

    const result = await run([
      "daemon", "start",
      "--max-loop-iterations", "1",
      "--poll-interval-ms", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      workSucceeded: false,
      command: "daemon start",
      dataDir,
      state: "stopped"
    });
    const loop = payload["loop"] as Record<string, unknown>;
    expect(loop).toMatchObject({
      exitReason: "max_loop_iterations",
      terminalState: "stopped",
      workSucceeded: false,
      jobsRun: 1,
      jobsFailed: 1
    });
  });

  it("daemon start refuses to run the loop while another daemon is active", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const { openDb } = await import("../src/db.js");
    const { startDaemonRun } = await import("../src/daemon-runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: existingRunId } = startDaemonRun(db, {
        pid: 4242,
        host: "node-existing-loop",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "1",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon start",
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain(existingRunId);
  });

  it("daemon start text mode prints a loop summary when bounded", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "0",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Daemon run started:");
    expect(result.stdout).toContain("State: stopped");
    expect(result.stdout).toContain("Exit reason: max_idle_cycles");
    expect(result.stdout).toContain("Work succeeded: yes");
    expect(result.stdout).toContain("Jobs run: 0");
  });

  it("daemon start rejects --max-loop-iterations with a non-integer value", async () => {
    const result = await run([
      "daemon", "start",
      "--max-loop-iterations", "abc"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Invalid value for --max-loop-iterations: abc"
    );
    expect(result.stdout).toBe("");
  });

  it("daemon start rejects --max-idle-cycles without a value", async () => {
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Missing required value for --max-idle-cycles");
    expect(result.stdout).toBe("");
  });

  it("status --json surfaces an active daemon stop request alongside the queued goal", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    const enqueueResult = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(enqueueResult.code).toBe(0);
    const enqueuePayload = JSON.parse(enqueueResult.stdout) as Record<
      string,
      unknown
    >;
    const goalId = enqueuePayload["goalId"] as string;

    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 8888,
        host: "cli-status-daemon",
        now: 1_700_000_000_000
      }));
      requestDaemonRunStop(db, {
        runId,
        reason: "ops shutdown",
        now: 1_700_000_005_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "status", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      runId,
      state: "stop_requested",
      isActive: true,
      isTerminal: false,
      stopRequest: {
        requestedAt: 1_700_000_005_000,
        reason: "ops shutdown"
      }
    });
  });

  it("status text surfaces the daemon stop-request when work is queued", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    const enqueueResult = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(enqueueResult.code).toBe(0);
    const enqueuePayload = JSON.parse(enqueueResult.stdout) as Record<
      string,
      unknown
    >;
    const goalId = enqueuePayload["goalId"] as string;

    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 8889,
        now: 1_700_000_000_000
      }));
      requestDaemonRunStop(db, {
        runId,
        reason: "ops",
        now: 1_700_000_005_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "status", goalId,
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Daemon: stop_requested (active) [${runId}]`);
    expect(result.stdout).toContain("Daemon stop requested: 1700000005000 (ops)");
  });

  it("handoff --json captures the daemon stop request so operators see why work is not draining", async () => {
    const { dataDir, goalFile, repo } = setupGoalAndData();
    const enqueueResult = await run([
      "goal", "start", goalFile,
      "--repo", repo,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(enqueueResult.code).toBe(0);
    const enqueuePayload = JSON.parse(enqueueResult.stdout) as Record<
      string,
      unknown
    >;
    const goalId = enqueuePayload["goalId"] as string;

    const { openDb } = await import("../src/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 9999,
        host: "cli-handoff-daemon",
        now: 1_700_000_000_000
      }));
      requestDaemonRunStop(db, {
        runId,
        reason: "drain before deploy",
        now: 1_700_000_004_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "handoff", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      runId,
      state: "stop_requested",
      isActive: true,
      stopRequest: {
        requestedAt: 1_700_000_004_000,
        reason: "drain before deploy"
      }
    });
  });
});

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";

  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });

  return { code, stdout, stderr };
}
