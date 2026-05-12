import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGoalArtifactPaths } from "../src/artifacts.js";
import { openDb } from "../src/db.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
} from "../src/fake-runner.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";

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

function makeTempDir(prefix = "momentum-iter-job-"): string {
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
  const dir = makeTempDir("momentum-iter-job-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function makeSpecContent(
  repoPath: string,
  verificationCommand = "true"
): string {
  return `---
title: Prove foreground iteration
repo: ${repoPath}
runner: fake
branch: momentum/prove-foreground-iteration
verification:
  - ${verificationCommand}
---
Apply the fixture file deterministically.
`;
}

type GoalSetup = GoalInitSuccess & { dataDir: string };

function setupGoal(
  repo: string,
  verificationCommand = "true"
): GoalSetup {
  const dataDir = makeTempDir("momentum-iter-job-data-");
  const specDir = makeTempDir("momentum-iter-job-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(goalFile, makeSpecContent(repo, verificationCommand), "utf-8");
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir }
  });
  if (!init.ok) {
    throw new Error(`initGoal failed: ${init.error}`);
  }
  return { ...init, dataDir };
}

describe("executeIterationJob", () => {
  it("transitions goal to iteration_complete and job to succeeded after a verified commit", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(true);
    expect(out.goalState).toBe("iteration_complete");
    expect(out.jobState).toBe("succeeded");

    const goalRow = db
      .prepare("SELECT state FROM goals WHERE id = ?")
      .get(setup.goalId) as Record<string, unknown>;
    const jobRow = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;

    expect(goalRow["state"]).toBe("iteration_complete");
    expect(jobRow["state"]).toBe("succeeded");
    expect(jobRow["error"]).toBeNull();
    expect(jobRow["started_at"]).not.toBeNull();
    expect(jobRow["finished_at"]).not.toBeNull();
    expect(jobRow["attempt_count"]).toBe(1);

    db.close();
  });

  it("writes jobs.result_path to the iteration result.json on success and clears error_path", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(true);

    const jobRow = db
      .prepare("SELECT result_path, error_path FROM jobs WHERE id = ?")
      .get(setup.jobId) as { result_path: string | null; error_path: string | null };
    expect(jobRow.result_path).toBe(setup.artifactPaths.resultJson);
    expect(jobRow.error_path).toBeNull();
    expect(fs.existsSync(jobRow.result_path!)).toBe(true);

    db.close();
  });

  it("writes jobs.error_path to the verification log on verification failure and clears result_path", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "false");
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);

    const jobRow = db
      .prepare("SELECT result_path, error_path FROM jobs WHERE id = ?")
      .get(setup.jobId) as { result_path: string | null; error_path: string | null };
    expect(jobRow.result_path).toBeNull();
    expect(jobRow.error_path).toBe(setup.artifactPaths.verificationLog);
    expect(fs.existsSync(jobRow.error_path!)).toBe(true);

    db.close();
  });

  it("writes jobs.error_path to the verification log on runner failure (reset path)", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    process.env[FAKE_RUNNER_FAIL_ENV] = "1";
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);

    const jobRow = db
      .prepare("SELECT result_path, error_path, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as {
      result_path: string | null;
      error_path: string | null;
      error: string | null;
    };
    expect(jobRow.error).toContain("runner_reported_failure");
    expect(jobRow.result_path).toBeNull();
    expect(jobRow.error_path).toBe(setup.artifactPaths.verificationLog);

    db.close();
  });

  it("writes jobs.error_path to the runner log when failure happens before the runner produces output", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);

    const jobRow = db
      .prepare("SELECT result_path, error_path, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as {
      result_path: string | null;
      error_path: string | null;
      error: string | null;
    };
    expect(jobRow.error).toContain("repo_guard_failed");
    expect(jobRow.result_path).toBeNull();
    expect(jobRow.error_path).toBe(setup.artifactPaths.runnerLog);

    db.close();
  });

  it("invokes the orchestrator and produces the canonical iteration artifacts", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.iteration.ok).toBe(true);
    if (!out.iteration.ok) return;

    expect(fs.readFileSync(out.iteration.promptPath, "utf-8")).toContain(
      `goal_id: ${setup.goalId}`
    );
    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      true
    );
    const layout = resolveGoalArtifactPaths(setup.dataDir, setup.goalId);
    expect(out.iteration.runnerLogPath).toBe(layout.runnerLog);
    expect(out.iteration.resultJsonPath).toBe(layout.resultJson);
    expect(out.iteration.verificationLogPath).toBe(layout.verificationLog);
    expect(out.iteration.commitSha).toMatch(/^[0-9a-f]{40}$/);

    db.close();
  });

  it("writes iteration_started then iteration_completed events with commit metadata on success", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    const events = db
      .prepare(
        "SELECT type, payload, job_id FROM events WHERE goal_id = ? ORDER BY id ASC"
      )
      .all(setup.goalId) as Array<{
      type: string;
      payload: string;
      job_id: string;
    }>;

    expect(events.map((event) => event.type)).toEqual([
      "iteration_started",
      "iteration_completed"
    ]);
    expect(events.every((event) => event.job_id === setup.jobId)).toBe(true);

    const started = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(started["iteration"]).toBe(1);
    expect(started["branch"]).toBe(setup.spec.branch);
    expect(started["runner"]).toBe("fake");

    const completed = JSON.parse(events[1]!.payload) as Record<string, unknown>;
    expect(completed["iteration"]).toBe(1);
    expect(completed["branch"]).toBe(setup.spec.branch);
    expect(completed["branch_created"]).toBe(true);
    expect(typeof completed["base_head"]).toBe("string");
    expect(typeof completed["post_runner_head"]).toBe("string");
    expect(typeof completed["commit_sha"]).toBe("string");
    expect(typeof completed["commit_message"]).toBe("string");
    expect(completed["runner_success"]).toBe(true);
    expect(completed["goal_complete"]).toBe(false);

    db.close();
  });

  it("marks goal/job failed and emits iteration_failed when verification fails after reset", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "false");
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);
    expect(out.goalState).toBe("failed");
    expect(out.jobState).toBe("failed");

    const jobRow = db
      .prepare("SELECT state, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["state"]).toBe("failed");
    expect(jobRow["error"]).toContain("verification_failed");

    const events = db
      .prepare("SELECT type, payload FROM events WHERE goal_id = ? ORDER BY id ASC")
      .all(setup.goalId) as Array<{ type: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "iteration_started",
      "iteration_failed"
    ]);
    const failed = JSON.parse(events[1]!.payload) as Record<string, unknown>;
    expect(failed["code"]).toBe("verification_failed");

    expect(
      fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
    ).toBe(false);
    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    db.close();
  });

  it("marks goal/job failed and emits iteration_failed when runner reports failure after reset", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    process.env[FAKE_RUNNER_FAIL_ENV] = "1";

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);
    expect(out.goalState).toBe("failed");
    expect(out.jobState).toBe("failed");

    const jobRow = db
      .prepare("SELECT state, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["state"]).toBe("failed");
    expect(jobRow["error"]).toContain("runner_reported_failure");

    const events = db
      .prepare("SELECT type, payload FROM events WHERE goal_id = ? ORDER BY id ASC")
      .all(setup.goalId) as Array<{ type: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "iteration_started",
      "iteration_failed"
    ]);
    const failed = JSON.parse(events[1]!.payload) as Record<string, unknown>;
    expect(failed["code"]).toBe("runner_reported_failure");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);

    expect(
      fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
    ).toBe(false);
    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    const runnerLog = fs.readFileSync(setup.artifactPaths.runnerLog, "utf-8");
    expect(runnerLog).toContain("[fake-runner] start");
    expect(runnerLog).toContain(`simulated failure via ${FAKE_RUNNER_FAIL_ENV}`);

    const verificationLog = fs.readFileSync(
      setup.artifactPaths.verificationLog,
      "utf-8"
    );
    expect(verificationLog).toContain("[verify] skipped: runner reported failure");

    db.close();
  });

  it("marks job failed and writes iteration_failed event on dirty worktree", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);
    expect(out.jobState).toBe("failed");
    expect(out.goalState).toBe("failed");

    const goalRow = db
      .prepare("SELECT state FROM goals WHERE id = ?")
      .get(setup.goalId) as Record<string, unknown>;
    expect(goalRow["state"]).toBe("failed");

    const jobRow = db
      .prepare("SELECT state, error, finished_at FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["state"]).toBe("failed");
    expect(typeof jobRow["error"]).toBe("string");
    expect(jobRow["error"]).toContain("repo_guard_failed");
    expect(jobRow["finished_at"]).not.toBeNull();

    const events = db
      .prepare("SELECT type, payload FROM events WHERE goal_id = ? ORDER BY id ASC")
      .all(setup.goalId) as Array<{ type: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "iteration_started",
      "iteration_failed"
    ]);
    const failed = JSON.parse(events[1]!.payload) as Record<string, unknown>;
    expect(failed["code"]).toBe("repo_guard_failed");
    expect(typeof failed["error"]).toBe("string");

    db.close();
  });

  it("marks job failed when the target branch already exists without Momentum metadata", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    runGit(repo, ["checkout", "--quiet", "-b", setup.spec.branch]);
    runGit(repo, ["checkout", "--quiet", "main"]);

    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });

    expect(out.ok).toBe(false);
    expect(out.goalState).toBe("failed");
    expect(out.jobState).toBe("failed");

    const jobRow = db
      .prepare("SELECT state, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["state"]).toBe("failed");
    expect(jobRow["error"]).toContain("branch_manager_failed");

    db.close();
  });

  it("uses injected now() for deterministic started_at and finished_at", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    let counter = 1_700_000_000_000;
    const now = () => {
      const value = counter;
      counter += 1;
      return value;
    };

    executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths,
      now
    });

    const jobRow = db
      .prepare("SELECT started_at, finished_at, updated_at FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["started_at"]).toBe(1_700_000_000_000);
    expect(jobRow["finished_at"]).toBe(1_700_000_000_001);
    expect(jobRow["updated_at"]).toBe(1_700_000_000_001);

    db.close();
  });

  it("increments attempt_count and overwrites finished_at on a second invocation", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);

    let counter = 1_700_000_000_000;
    const now = () => {
      const value = counter;
      counter += 1;
      return value;
    };

    const db = openDb(setup.dataDir);
    const first = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths,
      now
    });
    expect(first.ok).toBe(true);

    // The fake runner regenerates the same fixture content on the second pass,
    // so verification still passes but the commit step finds no diff. Asserting
    // that bookkeeping (attempt_count, finished_at) still updates is the point
    // of this test.
    const second = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths,
      now
    });

    expect(second.ok).toBe(false);
    if (second.iteration.ok) return;
    expect(second.iteration.code).toBe("commit_failed");

    const jobRow = db
      .prepare(
        "SELECT attempt_count, started_at, finished_at, state FROM jobs WHERE id = ?"
      )
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["attempt_count"]).toBe(2);
    expect(jobRow["started_at"]).toBe(1_700_000_000_002);
    expect(jobRow["finished_at"]).toBe(1_700_000_000_003);
    expect(jobRow["state"]).toBe("failed");

    const eventTypes = db
      .prepare("SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC")
      .all(setup.goalId) as Array<{ type: string }>;
    expect(eventTypes.map((event) => event.type)).toEqual([
      "iteration_started",
      "iteration_completed",
      "iteration_started",
      "iteration_failed"
    ]);

    db.close();
  });

  it("returns invalid_input from the orchestrator and stamps job error", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths,
      iteration: 0
    });

    expect(out.ok).toBe(false);
    expect(out.jobState).toBe("failed");
    if (out.iteration.ok) return;
    expect(out.iteration.code).toBe("invalid_input");

    const jobRow = db
      .prepare("SELECT state, error FROM jobs WHERE id = ?")
      .get(setup.jobId) as Record<string, unknown>;
    expect(jobRow["state"]).toBe("failed");
    expect(jobRow["error"]).toContain("invalid_input");

    db.close();
  });

  it("commits exactly one verified momentum commit on the underlying branch", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    const before = runGit(repo, ["log", "--oneline"]).trim().split("\n").length;
    const out = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });
    db.close();

    expect(out.ok).toBe(true);
    const after = runGit(repo, ["log", "--oneline"]).trim().split("\n").length;
    expect(after).toBe(before + 1);

    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    const subject = runGit(repo, ["log", "-1", "--pretty=%s"]).trim();
    expect(subject).toContain("milestone-1");
  });

  it("records updated_at on the goal row reflecting the finish timestamp", () => {
    const repo = initRepo();
    const setup = setupGoal(repo);
    const db = openDb(setup.dataDir);

    let counter = 1_700_000_000_000;
    const now = () => {
      const value = counter;
      counter += 1;
      return value;
    };

    executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths,
      now
    });

    const goalRow = db
      .prepare("SELECT updated_at FROM goals WHERE id = ?")
      .get(setup.goalId) as Record<string, unknown>;
    expect(goalRow["updated_at"]).toBe(1_700_000_000_001);

    db.close();
  });
});
