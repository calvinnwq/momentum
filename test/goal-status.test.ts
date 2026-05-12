import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
import { loadGoalStatus } from "../src/goal-status.js";
import { reduceGoalIteration } from "../src/goal-reducer.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-status-"): string {
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
  const dir = makeTempDir("momentum-status-repo-");
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
  title: string,
  verificationCommand = "true",
  maxIterations?: number
): string {
  const maxIterLine =
    maxIterations !== undefined ? `max_iterations: ${maxIterations}\n` : "";
  return `---
title: ${title}
repo: ${repoPath}
runner: fake
${maxIterLine}verification:
  - ${verificationCommand}
---
Apply the fixture file deterministically.
`;
}

type GoalSetup = GoalInitSuccess & { dataDir: string };

type SetupOptions = {
  verificationCommand?: string;
  maxIterations?: number;
  mode?: "foreground" | "queued";
};

function setupGoal(
  repo: string,
  title = "Prove status command",
  options: SetupOptions = {}
): GoalSetup {
  const dataDir = makeTempDir("momentum-status-data-");
  return setupGoalInDataDir(repo, dataDir, title, options);
}

function setupGoalInDataDir(
  repo: string,
  dataDir: string,
  title: string,
  options: SetupOptions = {}
): GoalSetup {
  const specDir = makeTempDir("momentum-status-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeSpecContent(
      repo,
      title,
      options.verificationCommand ?? "true",
      options.maxIterations
    ),
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode: options.mode ?? "foreground"
  });
  if (!init.ok) {
    throw new Error(`initGoal failed: ${init.error}`);
  }
  return { ...init, dataDir };
}

describe("loadGoalStatus", () => {
  it("returns goal_not_found when the goalId does not exist", () => {
    const dataDir = makeTempDir("momentum-status-data-");
    const result = loadGoalStatus({
      goalId: "missing-goal",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("goal_not_found");
    expect(result.error).toContain("missing-goal");
    expect(result.error).toContain(dataDir);
  });

  it("returns no_goals when omitting goalId on an empty data dir", () => {
    const dataDir = makeTempDir("momentum-status-data-");

    const result = loadGoalStatus({ dataDirOptions: { dataDir } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_goals");
    expect(result.error).toContain(dataDir);
  });

  it("rejects an empty goalId string", () => {
    const result = loadGoalStatus({ goalId: "   " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("reports an initialized goal with no iteration data yet", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status init only");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.goalId).toBe(setup.goalId);
    expect(result.title).toBe("Status init only");
    expect(result.state).toBe("initialized");
    expect(result.repo).toBe(repo);
    expect(result.branch).toBe("momentum/status-init-only");
    expect(result.runner).toBe("fake");
    expect(result.maxIterations).toBe(1);
    expect(result.verification).toEqual(["true"]);
    expect(result.verificationTimeoutSec).toBe(900);
    expect(result.artifactDir).toBe(setup.artifactPaths.goalDir);
    expect(result.dataDir).toBe(setup.dataDir);
    expect(result.iteration).toBeNull();
    expect(result.latestJob).not.toBeNull();
    expect(result.latestJob?.state).toBe("pending");
    expect(result.latestJob?.iteration).toBe(1);
    expect(result.latestJob?.attemptCount).toBe(0);
    expect(result.latestJob?.startedAt).toBeNull();
    expect(result.latestJob?.finishedAt).toBeNull();
    expect(result.latestJob?.error).toBeNull();
    expect(result.artifactFiles.goalMd).toBe(true);
    expect(result.artifactFiles.handoffMd).toBe(true);
    expect(result.artifactFiles.handoffJson).toBe(true);
  });

  it("reports a verified commit with iteration metadata after a successful job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status verified commit");
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      expect(job.ok).toBe(true);
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.state).toBe("iteration_complete");
    expect(status.latestJob?.state).toBe("succeeded");
    expect(status.latestJob?.error).toBeNull();
    expect(status.latestJob?.startedAt).not.toBeNull();
    expect(status.latestJob?.finishedAt).not.toBeNull();
    expect(status.latestJob?.attemptCount).toBe(1);

    expect(status.iteration).not.toBeNull();
    expect(status.iteration?.iteration).toBe(1);
    expect(status.iteration?.branch).toBe("momentum/status-verified-commit");
    expect(status.iteration?.branchCreated).toBe(true);
    expect(status.iteration?.runnerSuccess).toBe(true);
    expect(status.iteration?.goalComplete).toBe(false);
    expect(status.iteration?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(status.iteration?.baseHead).toMatch(/^[0-9a-f]{40}$/);
    expect(status.iteration?.postRunnerHead).toBe(status.iteration?.baseHead);
    expect(status.iteration?.failure).toBeNull();
    expect(typeof status.iteration?.commitMessage).toBe("string");

    expect(status.artifactFiles.promptMd).toBe(true);
    expect(status.artifactFiles.runnerLog).toBe(true);
    expect(status.artifactFiles.verificationLog).toBe(true);
    expect(status.artifactFiles.resultJson).toBe(true);

    expect(status.latestJob?.resultPath).toBe(setup.artifactPaths.resultJson);
    expect(status.latestJob?.errorPath).toBeNull();
  });

  it("reports failure metadata when the iteration fails verification", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status failed verification", {
      verificationCommand: "false"
    });
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      expect(job.ok).toBe(false);
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.state).toBe("failed");
    expect(status.latestJob?.state).toBe("failed");
    expect(status.latestJob?.error).toContain("verification_failed");

    expect(status.iteration).not.toBeNull();
    expect(status.iteration?.failure).not.toBeNull();
    expect(status.iteration?.failure?.code).toBe("verification_failed");
    expect(status.iteration?.failure?.error).toContain("command_failed");
    expect(status.iteration?.commitSha).toBeNull();
    expect(status.iteration?.runnerSuccess).toBeNull();

    expect(status.latestJob?.resultPath).toBeNull();
    expect(status.latestJob?.errorPath).toBe(setup.artifactPaths.verificationLog);
  });

  it("reports null result/error paths for a pending job that has not yet executed", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pending paths");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestJob?.state).toBe("pending");
    expect(result.latestJob?.resultPath).toBeNull();
    expect(result.latestJob?.errorPath).toBeNull();
  });

  it("reports null reducer and a queued next-action hint before the worker runs", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pending action hint");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.currentIteration).toBe(0);
    expect(result.completionReason).toBeNull();
    expect(result.reducer).toBeNull();
    expect(result.nextJob).toBeNull();
    expect(result.nextAction).toContain("foreground");
    expect(result.nextAction).toContain(setup.jobId);
  });

  it("surfaces the reducer max_iterations_reached decision plus null nextJob on a 1-iteration goal", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status reducer max iter", { mode: "queued" });
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state).toBe("max_iterations_reached");
    expect(status.currentIteration).toBe(1);
    expect(status.completionReason).toBe("max_iterations_reached:1");
    expect(status.reducer).not.toBeNull();
    expect(status.reducer?.decision).toBe("max_iterations_reached");
    expect(status.reducer?.iteration).toBe(1);
    expect(status.reducer?.jobId).toBe(setup.jobId);
    expect(status.reducer?.goalState).toBe("max_iterations_reached");
    expect(status.reducer?.completionReason).toBe("max_iterations_reached:1");
    expect(status.reducer?.maxIterations).toBe(1);
    expect(status.reducer?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(status.reducer?.nextJob).toBeNull();
    expect(status.nextJob).toBeNull();
    expect(status.nextAction).toContain("max_iterations");
  });

  it("surfaces the reducer continue decision and the queued next iteration job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status reducer continue", {
      maxIterations: 2,
      mode: "queued"
    });
    expect(setup.spec.max_iterations).toBe(2);

    const db = openDb(setup.dataDir);
    let nextJobId: string;
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("continue");
      expect(reducer.nextJob?.iteration).toBe(2);
      nextJobId = reducer.nextJob!.jobId;
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state).toBe("queued");
    expect(status.currentIteration).toBe(1);
    expect(status.completionReason).toBeNull();
    expect(status.reducer?.decision).toBe("continue");
    expect(status.reducer?.nextJob?.jobId).toBe(nextJobId);
    expect(status.reducer?.nextJob?.iteration).toBe(2);
    expect(status.reducer?.nextJob?.idempotencyKey).toBe(
      `goal:${setup.goalId}:iteration:2`
    );
    expect(status.nextJob).not.toBeNull();
    expect(status.nextJob?.jobId).toBe(nextJobId);
    expect(status.nextJob?.state).toBe("pending");
    expect(status.nextJob?.iteration).toBe(2);
    expect(status.nextAction).toContain("worker run");
    expect(status.nextAction).toContain(nextJobId);
  });

  it("returns the most recently created goal when goalId is omitted", () => {
    const repo = initRepo();
    const dataDir = makeTempDir("momentum-status-data-");
    setupGoalInDataDir(repo, dataDir, "First status goal");
    const second = setupGoalInDataDir(repo, dataDir, "Second status goal");

    const result = loadGoalStatus({ dataDirOptions: { dataDir } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.goalId).toBe(second.goalId);
    expect(result.title).toBe("Second status goal");
  });
});
