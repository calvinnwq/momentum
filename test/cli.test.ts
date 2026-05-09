import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { VERSION, runCli } from "../src/cli.js";
import { FAKE_RUNNER_FIXTURE_FILENAME } from "../src/fake-runner.js";

const GOAL_SPEC = `---
title: CLI Test Goal
runner: fake
verification:
  - pnpm test
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

  it("goal start runs a foreground iteration and returns awaiting_verification", async () => {
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
      state: "awaiting_verification",
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

    expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(true);
    expect(fs.existsSync(iter["promptPath"] as string)).toBe(true);
    expect(fs.existsSync(iter["runnerLogPath"] as string)).toBe(true);
    expect(fs.existsSync(iter["resultJsonPath"] as string)).toBe(true);
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
      state: "awaiting_verification",
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
    expect(result.stdout).toContain("Iteration: awaiting verification");
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

  it("reserves status and handoff command shells", async () => {
    const status = await run(["status", "goal-1", "--json"]);
    const handoff = await run(["handoff", "goal-1", "--json"]);

    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "status",
      goalId: "goal-1",
      code: "not_implemented"
    });
    expect(handoff.code).toBe(1);
    expect(JSON.parse(handoff.stdout)).toMatchObject({
      command: "handoff",
      goalId: "goal-1",
      code: "not_implemented"
    });
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
