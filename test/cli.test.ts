import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { VERSION, runCli } from "../src/cli.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
} from "../src/fake-runner.js";

const GOAL_SPEC = `---
title: CLI Test Goal
runner: fake
verification:
  - true
---

Goal body.
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
    expect(result.stdout).toContain("momentum goal start <goal.md> [--repo <path>] --foreground");
    expect(result.stdout).toContain("momentum status [goal-id] [--json]");
    expect(result.stdout).toContain("momentum handoff <goal-id> [--json]");
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
    const result = await run(["doctor"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Momentum doctor: ok");
    expect(result.stdout).toContain("scope: NGX-237 foreground-iteration");
    expect(result.stderr).toBe("");
  });

  it("runs doctor in json mode", async () => {
    const result = await run(["doctor", "--json"]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "doctor",
      version: VERSION,
      milestone: "NGX-237 foreground-iteration"
    });
    expect(result.stderr).toBe("");
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

  it("requires --foreground for goal start", async () => {
    const result = await run(["goal", "start", "goal.md", "--json"]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required --foreground for Milestone 1 goal start."
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
      schemaVersion: 1
    });
    expect(typeof payload["generatedAt"]).toBe("number");

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
