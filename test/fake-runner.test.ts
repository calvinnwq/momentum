import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FAKE_RUNNER_FIXTURE_FILENAME,
  runFakeRunner
} from "../src/fake-runner.js";
import { parseRunnerResult } from "../src/runner-result.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-fake-runner-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
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

function makeIterationDir(): string {
  const dir = makeTempDir("momentum-fake-runner-iter-");
  return dir;
}

describe("runFakeRunner", () => {
  it("creates the fixture file and returns fixtureExisted=false on first run", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    expect(out.fixtureExisted).toBe(false);
    expect(out.fixturePath).toBe(
      path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME)
    );
    expect(fs.existsSync(out.fixturePath)).toBe(true);
    expect(fs.readFileSync(out.fixturePath, "utf-8")).toBe(
      "momentum fake runner fixture\niteration: 1\n"
    );
  });

  it("modifies an existing fixture file and returns fixtureExisted=true", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();
    fs.writeFileSync(
      path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME),
      "stale\n",
      "utf-8"
    );

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 2 });

    expect(out.fixtureExisted).toBe(true);
    expect(fs.readFileSync(out.fixturePath, "utf-8")).toBe(
      "momentum fake runner fixture\niteration: 2\n"
    );
  });

  it("writes runner.log with deterministic lines reflecting the action", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    const log = fs.readFileSync(out.runnerLogPath, "utf-8");
    expect(log).toContain("[fake-runner] start");
    expect(log).toContain(`[fake-runner] repo: ${repoPath}`);
    expect(log).toContain("[fake-runner] iteration: 1");
    expect(log).toContain(
      `[fake-runner] action: created ${FAKE_RUNNER_FIXTURE_FILENAME}`
    );
    expect(log).toContain("[fake-runner] result.json written");
    expect(log).toContain("[fake-runner] done");
    expect(log.endsWith("\n")).toBe(true);
  });

  it("logs 'modified' action when fixture pre-exists", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();
    fs.writeFileSync(
      path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME),
      "stale\n",
      "utf-8"
    );

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    const log = fs.readFileSync(out.runnerLogPath, "utf-8");
    expect(log).toContain(
      `[fake-runner] action: modified ${FAKE_RUNNER_FIXTURE_FILENAME}`
    );
  });

  it("writes result.json that round-trips through parseRunnerResult", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    const raw = fs.readFileSync(out.resultJsonPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);

    const parsed = parseRunnerResult(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(out.result);
    }
  });

  it("returns the canonical Milestone 1 fixture result", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();

    const out = runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    expect(out.result).toEqual({
      success: true,
      summary: "Applied fake runner fixture.",
      key_changes_made: ["Created or modified fixture target file."],
      key_learnings: [],
      remaining_work: [],
      goal_complete: false,
      commit: {
        type: "test",
        scope: "milestone-1",
        subject: "prove foreground momentum iteration",
        body: "",
        breaking: false
      }
    });
  });

  it("does not stage or commit and leaves the fixture as a worktree change", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();
    const headBefore = runGit(repoPath, ["rev-parse", "HEAD"]).trim();

    runFakeRunner({ repoPath, iterationDir, iteration: 1 });

    const headAfter = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(headAfter).toBe(headBefore);

    const status = runGit(repoPath, ["status", "--porcelain"]);
    expect(status).toContain(`?? ${FAKE_RUNNER_FIXTURE_FILENAME}`);

    const diffCached = runGit(repoPath, ["diff", "--cached", "--name-only"]);
    expect(diffCached.trim()).toBe("");
  });

  it("rejects empty repoPath", () => {
    const iterationDir = makeIterationDir();
    expect(() =>
      runFakeRunner({ repoPath: "", iterationDir, iteration: 1 })
    ).toThrow(/repoPath is required/);
  });

  it("rejects empty iterationDir", () => {
    const repoPath = initRepo();
    expect(() =>
      runFakeRunner({ repoPath, iterationDir: "", iteration: 1 })
    ).toThrow(/iterationDir is required/);
  });

  it("rejects iteration values that are not positive integers", () => {
    const repoPath = initRepo();
    const iterationDir = makeIterationDir();
    expect(() =>
      runFakeRunner({ repoPath, iterationDir, iteration: 0 })
    ).toThrow(/positive integer/);
    expect(() =>
      runFakeRunner({ repoPath, iterationDir, iteration: 1.5 })
    ).toThrow(/positive integer/);
    expect(() =>
      runFakeRunner({ repoPath, iterationDir, iteration: -1 })
    ).toThrow(/positive integer/);
  });

  it("throws when repoPath does not exist", () => {
    const ghost = path.join(makeTempDir(), "missing");
    const iterationDir = makeIterationDir();
    expect(() =>
      runFakeRunner({ repoPath: ghost, iterationDir, iteration: 1 })
    ).toThrow(/repoPath does not exist/);
  });

  it("throws when iterationDir does not exist", () => {
    const repoPath = initRepo();
    const ghost = path.join(makeTempDir(), "missing");
    expect(() =>
      runFakeRunner({ repoPath, iterationDir: ghost, iteration: 1 })
    ).toThrow(/iterationDir does not exist/);
  });

  it("throws when repoPath is a file, not a directory", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x", "utf-8");
    const iterationDir = makeIterationDir();
    expect(() =>
      runFakeRunner({ repoPath: file, iterationDir, iteration: 1 })
    ).toThrow(/repoPath is not a directory/);
  });

  it("throws when iterationDir is a file, not a directory", () => {
    const repoPath = initRepo();
    const dir = makeTempDir();
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x", "utf-8");
    expect(() =>
      runFakeRunner({ repoPath, iterationDir: file, iteration: 1 })
    ).toThrow(/iterationDir is not a directory/);
  });
});
