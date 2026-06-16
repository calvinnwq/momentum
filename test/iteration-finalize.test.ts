import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { finalizeIteration } from "../src/core/repo/iteration-finalize.js";
import type { CommitIntent } from "../src/runner-result.js";

const ZERO_SHA = "0".repeat(40);
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-iter-finalize-"): string {
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
  return dir;
}

function commitInitial(dir: string): string {
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

function makeLogPath(): string {
  const dir = makeTempDir("momentum-iter-finalize-log-");
  return path.join(dir, "verification.log");
}

function setupRepoWithRunnerEdits(): {
  repoPath: string;
  baseHead: string;
  logPath: string;
} {
  const repoPath = initRepo();
  const baseHead = commitInitial(repoPath);
  fs.writeFileSync(
    path.join(repoPath, "runner-edit.txt"),
    "from-runner\n",
    "utf-8"
  );
  return { repoPath, baseHead, logPath: makeLogPath() };
}

function baseIntent(overrides: Partial<CommitIntent> = {}): CommitIntent {
  return {
    type: "feat",
    scope: "milestone-1",
    subject: "prove foreground momentum iteration",
    body: "",
    breaking: false,
    ...overrides
  };
}

describe("finalizeIteration", () => {
  it("commits the runner diff when runner ok and verification passes", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithRunnerEdits();

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") return;

    expect(result.verification.results).toHaveLength(1);
    expect(result.verification.results[0]?.succeeded).toBe(true);
    expect(result.commit.parentSha).toBe(baseHead);
    expect(result.commit.commitSha).not.toBe(baseHead);
    expect(result.commit.message).toBe(
      "feat(milestone-1): prove foreground momentum iteration"
    );

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(result.commit.commitSha);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify] summary: all 1 verification command(s) passed");
  });

  it("commits when verification commands are empty (vacuous success)", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithRunnerEdits();

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("committed");
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("no verification commands configured");
  });

  it("resets uncommitted changes and skips verification when runner failed", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithRunnerEdits();

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: false,
      commitIntent: baseIntent(),
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_runner_failure");
    if (result.outcome !== "reset_runner_failure") return;
    expect(result.reset.head).toBe(baseHead);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "runner-edit.txt"))).toBe(false);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify] skipped: runner reported failure");
    expect(log).not.toContain("should-not-run");
  });

  it("resets uncommitted changes when verification fails", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithRunnerEdits();

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo ok", "false"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_verification_failure");
    if (result.outcome !== "reset_verification_failure") return;
    expect(result.verification.code).toBe("command_failed");
    expect(result.reset.head).toBe(baseHead);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "runner-edit.txt"))).toBe(false);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify] summary: verification failed on command 2");
  });

  it("returns commit_failed without auto-reset when there is nothing to commit", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const logPath = makeLogPath();

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo nothing-to-commit"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("commit_failed");
    if (result.outcome !== "commit_failed") return;
    expect(result.commit.code).toBe("nothing_to_commit");
    expect(result.verification.results).toHaveLength(1);
    expect(result.reset).toBeUndefined();

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
  });

  it("resets staged runner edits when git commit itself fails", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithRunnerEdits();
    const hooksDir = path.join(repoPath, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommit = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(preCommit, "#!/bin/sh\nexit 1\n", "utf-8");
    fs.chmodSync(preCommit, 0o755);

    const result = finalizeIteration({
      repoPath,
      baseHead,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("commit_failed");
    if (result.outcome !== "commit_failed") return;
    expect(result.commit.code).toBe("git_failed");
    expect(result.reset).toBeDefined();
    expect(result.reset?.ok).toBe(true);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "runner-edit.txt"))).toBe(false);

    const status = runGit(repoPath, ["status", "--porcelain"]).trim();
    expect(status).toBe("");
  });

  it("returns reset_failed when baseHead does not exist and runner failed", () => {
    const repoPath = initRepo();
    commitInitial(repoPath);
    const logPath = makeLogPath();

    const result = finalizeIteration({
      repoPath,
      baseHead: ZERO_SHA,
      runnerSuccess: false,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_failed");
    if (result.outcome !== "reset_failed") return;
    expect(result.trigger).toBe("runner_failure");
    expect(result.reset.code).toBe("missing_base");
    expect(result.verification).toBeNull();
  });

  it("returns reset_failed with verification context when verification fails and reset cannot recover", () => {
    const repoPath = initRepo();
    commitInitial(repoPath);
    const logPath = makeLogPath();
    fs.writeFileSync(path.join(repoPath, "dirty.txt"), "x\n", "utf-8");

    const result = finalizeIteration({
      repoPath,
      baseHead: ZERO_SHA,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["false"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_failed");
    if (result.outcome !== "reset_failed") return;
    expect(result.trigger).toBe("verification_failure");
    expect(result.reset.code).toBe("missing_base");
    expect(result.verification).not.toBeNull();
    expect(result.verification?.code).toBe("command_failed");
  });

  it("rejects empty repoPath as invalid_input", () => {
    const result = finalizeIteration({
      repoPath: "",
      baseHead: ZERO_SHA,
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: "/tmp/verification.log"
    });

    expect(result.outcome).toBe("invalid_input");
    if (result.outcome !== "invalid_input") return;
    expect(result.error).toMatch(/repoPath/);
  });

  it("rejects a non-SHA baseHead as invalid_input", () => {
    const result = finalizeIteration({
      repoPath: "/tmp",
      baseHead: "not-a-sha",
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: "/tmp/verification.log"
    });

    expect(result.outcome).toBe("invalid_input");
    if (result.outcome !== "invalid_input") return;
    expect(result.error).toMatch(/baseHead/);
  });

  it("rejects a non-positive verificationTimeoutSec as invalid_input", () => {
    const result = finalizeIteration({
      repoPath: "/tmp",
      baseHead: "a".repeat(40),
      runnerSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 0,
      verificationLogPath: "/tmp/verification.log"
    });

    expect(result.outcome).toBe("invalid_input");
    if (result.outcome !== "invalid_input") return;
    expect(result.error).toMatch(/verificationTimeoutSec/);
  });
});
