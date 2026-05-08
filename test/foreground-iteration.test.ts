import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runForegroundIteration } from "../src/foreground-iteration.js";
import { FAKE_RUNNER_FIXTURE_FILENAME } from "../src/fake-runner.js";
import {
  initGoalArtifacts,
  resolveGoalArtifactPaths
} from "../src/artifacts.js";
import type { GoalSpec } from "../src/goal-spec.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-foreground-iter-"): string {
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
  const dir = makeTempDir();
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function makeSpec(repoPath: string, overrides: Partial<GoalSpec> = {}): GoalSpec {
  return {
    title: "Prove foreground iteration",
    repo: repoPath,
    runner: "fake",
    branch: "momentum/prove-foreground-iteration",
    max_iterations: 1,
    verification: ["pnpm test"],
    verification_timeout_sec: 900,
    body: "Apply the fixture and write a runner result.",
    ...overrides
  };
}

const GOAL_ID = "8e3a0c7a-1111-2222-3333-444455556666";

function setupArtifacts(goalId = GOAL_ID, specContent = "# fixture spec\n") {
  const dataDir = makeTempDir("momentum-foreground-iter-data-");
  return initGoalArtifacts(dataDir, goalId, specContent);
}

describe("runForegroundIteration", () => {
  it("runs the full pipeline and returns success on a clean repo", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.goalId).toBe(GOAL_ID);
    expect(out.iteration).toBe(1);
    expect(out.repoPath).toBe(repo);
    expect(out.branch).toBe(spec.branch);
    expect(out.branchCreated).toBe(true);
    expect(out.baseHead).toMatch(/^[0-9a-f]{40}$/);
    expect(out.postRunnerHead).toBe(out.baseHead);
    expect(out.result.success).toBe(true);
    expect(out.result.commit.type).toBe("test");
    expect(out.result.commit.scope).toBe("milestone-1");
  });

  it("writes prompt.md, runner.log, result.json, and the fixture file on success", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const promptText = fs.readFileSync(out.promptPath, "utf-8");
    expect(promptText).toContain(`goal_id: ${GOAL_ID}`);
    expect(promptText).toContain(`branch: ${spec.branch}`);
    expect(promptText).toContain(`pre_iteration_head: ${out.baseHead}`);

    expect(fs.existsSync(out.runnerLogPath)).toBe(true);
    expect(fs.readFileSync(out.runnerLogPath, "utf-8")).toContain(
      "[fake-runner] start"
    );

    const resultRaw = fs.readFileSync(out.resultJsonPath, "utf-8");
    const parsedResult = JSON.parse(resultRaw);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.commit.subject).toBe(
      "prove foreground momentum iteration"
    );

    const fixturePath = path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME);
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.readFileSync(fixturePath, "utf-8")).toContain("iteration: 1");
  });

  it("checks out the new momentum branch in the repo", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    const current = runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(current).toBe(spec.branch);
  });

  it("refuses a dirty worktree before invoking the runner", () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");

    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("repo_guard_failed");

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );
    expect(fs.readFileSync(artifactPaths.promptMd, "utf-8")).toBe("");
    expect(fs.readFileSync(artifactPaths.runnerLog, "utf-8")).toBe("");
  });

  it("refuses when the target branch exists with no Momentum metadata", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    runGit(repo, ["checkout", "--quiet", "-b", spec.branch]);
    runGit(repo, ["checkout", "--quiet", "main"]);

    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("branch_manager_failed");

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );
    expect(fs.readFileSync(artifactPaths.promptMd, "utf-8")).toBe("");
  });

  it("returns missing_repo when spec.repo is undefined", () => {
    const spec = makeSpec("/unused", { repo: undefined });
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("missing_repo");
  });

  it("returns unsupported_runner for non-fake runners", () => {
    const repo = initRepo();
    const spec = makeSpec(repo, { runner: "real" });
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_runner");
  });

  it("returns invalid_input for iteration values other than 1", () => {
    const repo = initRepo();
    const spec = makeSpec(repo, { max_iterations: 5 });
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 2,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
  });

  it("returns iteration_out_of_range when iteration exceeds max_iterations", () => {
    const repo = initRepo();
    const spec = makeSpec(repo, { max_iterations: 0 as unknown as number });
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("iteration_out_of_range");
  });

  it("returns invalid_input for empty goalId or non-positive iteration", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const emptyGoal = runForegroundIteration({
      goalId: "",
      spec,
      iteration: 1,
      artifactPaths
    });
    expect(emptyGoal.ok).toBe(false);
    if (!emptyGoal.ok) expect(emptyGoal.code).toBe("invalid_input");

    const zeroIter = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 0,
      artifactPaths
    });
    expect(zeroIter.ok).toBe(false);
    if (!zeroIter.ok) expect(zeroIter.code).toBe("invalid_input");
  });

  it("does not commit or stage anything in the repo", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toContain(FAKE_RUNNER_FIXTURE_FILENAME);
    expect(status).toMatch(/^\?\?/);

    const log = runGit(repo, ["log", "--oneline"]).trim().split("\n");
    expect(log).toHaveLength(1);
  });

  it("uses resolveGoalArtifactPaths layout for prompt and result outputs", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const dataDir = makeTempDir("momentum-foreground-iter-data-");
    const artifactPaths = initGoalArtifacts(dataDir, GOAL_ID, "# spec\n");

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const expected = resolveGoalArtifactPaths(dataDir, GOAL_ID);
    expect(out.promptPath).toBe(expected.promptMd);
    expect(out.runnerLogPath).toBe(expected.runnerLog);
    expect(out.resultJsonPath).toBe(expected.resultJson);
  });
});
