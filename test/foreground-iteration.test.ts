import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runForegroundIteration } from "../src/core/executors/foreground-iteration.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
} from "../src/adapters/fake-runner.js";
import { parseRunnerResult } from "../src/runner-result.js";
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
  delete process.env[FAKE_RUNNER_FAIL_ENV];
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
    verification: ["true"],
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
  it("runs the full pipeline, verifies, and commits the runner diff", () => {
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
    expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.commitSha).not.toBe(out.baseHead);
    expect(out.commitMessage).toContain("test(milestone-1):");
    expect(out.finalize.outcome).toBe("committed");
  });

  it("writes prompt.md, runner.log, verification.log, result.json, and the fixture file on success", () => {
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

    const verificationText = fs.readFileSync(out.verificationLogPath, "utf-8");
    expect(verificationText).toContain("[verify] running: true");
    expect(verificationText).toContain("[verify]   result: ok");
    expect(verificationText).toContain(
      "[verify] summary: all 1 verification command(s) passed"
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

  it("leaves a single verified commit on the momentum branch", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();

    const initialLog = runGit(repo, ["log", "--oneline"]).trim().split("\n");
    expect(initialLog).toHaveLength(1);

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    const log = runGit(repo, ["log", "--oneline"]).trim().split("\n");
    expect(log).toHaveLength(2);

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(out.commitSha);

    const subject = runGit(repo, [
      "log",
      "-1",
      "--pretty=%s"
    ]).trim();
    expect(subject).toBe("test(milestone-1): prove foreground momentum iteration");
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

  it("resets to base HEAD when a verification command fails and preserves logs", () => {
    const repo = initRepo();
    const spec = makeSpec(repo, { verification: ["false"] });
    const artifactPaths = setupArtifacts();

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("verification_failed");
    expect(out.finalize?.outcome).toBe("reset_verification_failure");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);

    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );

    expect(fs.readFileSync(artifactPaths.runnerLog, "utf-8")).toContain(
      "[fake-runner] start"
    );
    const verificationText = fs.readFileSync(
      artifactPaths.verificationLog,
      "utf-8"
    );
    expect(verificationText).toContain("[verify] running: false");
    expect(verificationText).toContain(
      "[verify] summary: verification failed on command 1"
    );
  });

  it("resets to base HEAD when the runner reports failure and preserves logs", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();
    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    process.env[FAKE_RUNNER_FAIL_ENV] = "1";

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runner_reported_failure");
    expect(out.finalize?.outcome).toBe("reset_runner_failure");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);

    const status = runGit(repo, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );

    const runnerLog = fs.readFileSync(artifactPaths.runnerLog, "utf-8");
    expect(runnerLog).toContain("[fake-runner] start");
    expect(runnerLog).toContain(`simulated failure via ${FAKE_RUNNER_FAIL_ENV}`);

    const verificationLog = fs.readFileSync(
      artifactPaths.verificationLog,
      "utf-8"
    );
    expect(verificationLog).toContain("[verify] skipped: runner reported failure");
    expect(verificationLog).not.toContain("[verify] running:");

    const parsed = parseRunnerResult(
      fs.readFileSync(artifactPaths.resultJson, "utf-8")
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.success).toBe(false);
    }
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

  it("returns artifact_write_failed when prompt.md cannot be written", () => {
    const repo = initRepo();
    const spec = makeSpec(repo);
    const artifactPaths = setupArtifacts();
    fs.rmSync(artifactPaths.promptMd, { force: true });
    fs.mkdirSync(artifactPaths.promptMd);

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("artifact_write_failed");
    expect(out.error).toContain("prompt.md");
    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
      false
    );
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

  it("returns invalid_input when iteration does not match the artifact paths iteration", () => {
    const repo = initRepo();
    const spec = makeSpec(repo, { max_iterations: 5 });
    // artifactPaths default to iteration 1; passing iteration 2 should mismatch.
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
    expect(out.error).toContain("artifactPaths iteration");
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
    expect(out.verificationLogPath).toBe(expected.verificationLog);
  });

  it("includes MOMENTUM.md policy notes in the rendered iteration prompt", () => {
    const repo = initRepo();
    const policyBody = `---\nrunner: fake\n---\nNGX-284 SENTINEL: prefer focused tests.\n`;
    fs.writeFileSync(path.join(repo, "MOMENTUM.md"), policyBody, "utf-8");
    runGit(repo, ["add", "MOMENTUM.md"]);
    runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);
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

    const prompt = fs.readFileSync(out.promptPath, "utf-8");
    expect(prompt).toContain("## Policy notes (from MOMENTUM.md)");
    expect(prompt).toContain("NGX-284 SENTINEL: prefer focused tests.");
    expect(prompt).toContain(path.join(repo, "MOMENTUM.md"));
  });

  it("omits the policy section when MOMENTUM.md is absent (backwards compatible)", () => {
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

    const prompt = fs.readFileSync(out.promptPath, "utf-8");
    expect(prompt).not.toContain("Policy notes (from MOMENTUM.md)");
  });
});
