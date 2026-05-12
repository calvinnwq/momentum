import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
import { loadGoalStatus } from "../src/goal-status.js";

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
  verificationCommand = "true"
): string {
  return `---
title: ${title}
repo: ${repoPath}
runner: fake
verification:
  - ${verificationCommand}
---
Apply the fixture file deterministically.
`;
}

type GoalSetup = GoalInitSuccess & { dataDir: string };

function setupGoal(
  repo: string,
  title = "Prove status command",
  verificationCommand = "true"
): GoalSetup {
  const dataDir = makeTempDir("momentum-status-data-");
  return setupGoalInDataDir(repo, dataDir, title, verificationCommand);
}

function setupGoalInDataDir(
  repo: string,
  dataDir: string,
  title: string,
  verificationCommand = "true"
): GoalSetup {
  const specDir = makeTempDir("momentum-status-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeSpecContent(repo, title, verificationCommand),
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir }
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
    const setup = setupGoal(repo, "Status failed verification", "false");
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
