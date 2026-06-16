import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  finalizeLiveWorkflowStep,
  finalizeLiveWorkflowStepFromResultFile
} from "../src/core/executors/live-step-finalize.js";
import type { CommitIntent, RunnerResult } from "../src/core/executors/types.js";

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

function makeTempDir(prefix = "momentum-live-finalize-"): string {
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
  const dir = makeTempDir("momentum-live-finalize-log-");
  return path.join(dir, "verification.log");
}

function setupRepoWithStepEdits(): {
  repoPath: string;
  baseHead: string;
  logPath: string;
} {
  const repoPath = initRepo();
  const baseHead = commitInitial(repoPath);
  fs.writeFileSync(
    path.join(repoPath, "step-edit.txt"),
    "from-live-step\n",
    "utf-8"
  );
  return { repoPath, baseHead, logPath: makeLogPath() };
}

function baseIntent(overrides: Partial<CommitIntent> = {}): CommitIntent {
  return {
    type: "feat",
    scope: "live",
    subject: "prove live workflow step finalize",
    body: "",
    breaking: false,
    ...overrides
  };
}

function baseRunnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "live step finished",
    key_changes_made: ["wrote step-edit.txt"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: false,
    commit: baseIntent(),
    ...overrides
  };
}

function writeResultFile(content: string): string {
  const dir = makeTempDir("momentum-live-finalize-result-");
  const resultPath = path.join(dir, "runner-result.json");
  fs.writeFileSync(resultPath, content, "utf-8");
  return resultPath;
}

function writeRunnerResultFile(overrides: Partial<RunnerResult> = {}): string {
  return writeResultFile(JSON.stringify(baseRunnerResult(overrides)));
}

describe("finalizeLiveWorkflowStep", () => {
  it("commits the live step diff when the step succeeded and verification passes", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();

    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") return;
    expect(result.commit.parentSha).toBe(baseHead);
    expect(result.commit.commitSha).not.toBe(baseHead);
    expect(result.head).toBe(result.commit.commitSha);
    expect(result.commit.message).toBe(
      "feat(live): prove live workflow step finalize"
    );

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(result.commit.commitSha);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain(
      "[verify] summary: all 1 verification command(s) passed"
    );
  });

  it("commits when verification commands are empty (vacuous success)", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();

    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("committed");
  });

  it("resets uncommitted changes and skips verification when the step reported failure", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();

    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: false,
      commitIntent: baseIntent(),
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_step_failure");
    if (result.outcome !== "reset_step_failure") return;
    expect(result.reset.head).toBe(baseHead);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("should-not-run");
  });

  it("resets uncommitted changes when verification fails", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();

    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: true,
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
    expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);
  });

  it("enters manual recovery without destructive reset when HEAD moved during the live step", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);

    // Simulate a live step that itself committed: HEAD advances past baseHead.
    fs.writeFileSync(path.join(repoPath, "rogue.txt"), "rogue\n", "utf-8");
    runGit(repoPath, ["add", "rogue.txt"]);
    runGit(repoPath, ["commit", "-m", "rogue live-step commit", "--quiet"]);
    const movedHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(movedHead).not.toBe(baseHead);

    const logPath = makeLogPath();
    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("manual_recovery_required");
    if (result.outcome !== "manual_recovery_required") return;
    expect(result.recoveryCode).toBe("head_mismatch");
    expect(result.trigger).toBe("pre_finalize");
    expect(result.expectedHead).toBe(baseHead);
    expect(result.currentHead).toBe(movedHead);

    // The repo is left untouched: the rogue commit is preserved, not reset.
    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(movedHead);
    expect(fs.existsSync(path.join(repoPath, "rogue.txt"))).toBe(true);

    // Verification must not have run against the unexpected HEAD.
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("returns commit_failed without auto-reset when there is nothing to commit", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const logPath = makeLogPath();

    const result = finalizeLiveWorkflowStep({
      repoPath,
      baseHead,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: ["echo nothing-to-commit"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("commit_failed");
    if (result.outcome !== "commit_failed") return;
    expect(result.commit.code).toBe("nothing_to_commit");

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
  });

  it("rejects a non-SHA baseHead as invalid_input", () => {
    const result = finalizeLiveWorkflowStep({
      repoPath: "/tmp",
      baseHead: "not-a-sha",
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: "/tmp/verification.log"
    });

    expect(result.outcome).toBe("invalid_input");
    if (result.outcome !== "invalid_input") return;
    expect(result.error).toMatch(/baseHead/);
  });

  it("reports git_failed when HEAD cannot be read for the pre-finalize check", () => {
    const dir = makeTempDir();
    const logPath = makeLogPath();

    const result = finalizeLiveWorkflowStep({
      repoPath: dir,
      baseHead: ZERO_SHA,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("git_failed");
  });
});

describe("finalizeLiveWorkflowStepFromResultFile", () => {
  it("commits using the result file's commit intent when it reports success", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const resultFilePath = writeRunnerResultFile({
      commit: baseIntent({ type: "fix", scope: "wf", subject: "live wire-up" })
    });

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") return;
    expect(result.commit.parentSha).toBe(baseHead);
    expect(result.commit.message).toBe("fix(wf): live wire-up");
    expect(result.head).toBe(result.commit.commitSha);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(result.commit.commitSha);
  });

  it("resets the worktree when the result file reports success=false", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const resultFilePath = writeRunnerResultFile({ success: false });

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("reset_step_failure");
    if (result.outcome !== "reset_step_failure") return;
    expect(result.reset.head).toBe(baseHead);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("should-not-run");
  });

  it("returns result_missing without mutating the worktree when the result file is absent", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const missingDir = makeTempDir("momentum-live-finalize-missing-");
    const resultFilePath = path.join(missingDir, "runner-result.json");

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("result_missing");
    if (result.outcome !== "result_missing") return;
    expect(result.resultFilePath).toBe(resultFilePath);

    // The step's uncommitted edits are left intact: a missing durable result is
    // ambiguous, so the transaction refuses to destructively reset.
    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("returns result_invalid without mutating the worktree when the result file is not valid JSON", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const resultFilePath = writeResultFile("{ this is not json");

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("result_invalid");
    if (result.outcome !== "result_invalid") return;
    expect(result.resultFilePath).toBe(resultFilePath);

    const head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
  });

  it("returns result_invalid when the result document is a well-formed JSON but not a RunnerResult", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const resultFilePath = writeResultFile(JSON.stringify({ hello: "world" }));

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("result_invalid");
  });

  it("returns result_invalid when the result file exceeds the 1 MiB ceiling", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const resultFilePath = writeResultFile("x".repeat(1024 * 1024 + 1));

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("result_invalid");
    if (result.outcome !== "result_invalid") return;
    expect(result.error).toMatch(/exceeds|1 ?MiB|byte/i);
  });

  it("returns result_invalid when the result path is a symlink rather than a regular file", () => {
    const { repoPath, baseHead, logPath } = setupRepoWithStepEdits();
    const target = writeRunnerResultFile();
    const linkDir = makeTempDir("momentum-live-finalize-link-");
    const linkPath = path.join(linkDir, "runner-result.json");
    fs.symlinkSync(target, linkPath);

    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath: linkPath,
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: logPath
    });

    expect(result.outcome).toBe("result_invalid");
  });

  it("enters manual recovery without reset when HEAD moved during the live step", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    fs.writeFileSync(path.join(repoPath, "rogue.txt"), "rogue\n", "utf-8");
    runGit(repoPath, ["add", "rogue.txt"]);
    runGit(repoPath, ["commit", "-m", "rogue live-step commit", "--quiet"]);
    const movedHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();

    const resultFilePath = writeRunnerResultFile();
    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath: makeLogPath()
    });

    expect(result.outcome).toBe("manual_recovery_required");
    if (result.outcome !== "manual_recovery_required") return;
    expect(result.recoveryCode).toBe("head_mismatch");
    expect(result.trigger).toBe("pre_finalize");
    expect(result.currentHead).toBe(movedHead);

    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(movedHead);
    expect(fs.existsSync(path.join(repoPath, "rogue.txt"))).toBe(true);
  });

  it("rejects an empty resultFilePath as invalid_input", () => {
    const result = finalizeLiveWorkflowStepFromResultFile({
      repoPath: "/tmp",
      baseHead: ZERO_SHA,
      resultFilePath: "",
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath: "/tmp/verification.log"
    });

    expect(result.outcome).toBe("invalid_input");
    if (result.outcome !== "invalid_input") return;
    expect(result.error).toMatch(/resultFilePath/);
  });
});
