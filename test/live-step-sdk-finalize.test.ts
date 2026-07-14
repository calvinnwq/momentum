import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { finalizeLiveStepResult } from "../src/core/executors/live-step/sdk-executor.js";
import type { WorkflowStepExecutorDispatchResult } from "../src/core/workflow/step/executor.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): { repoPath: string; baseHead: string } {
  const repoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-live-step-sdk-finalize-"),
  );
  tempDirs.push(repoPath);
  runGit(repoPath, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "--quiet", "-m", "test: initial"]);
  return { repoPath, baseHead: runGit(repoPath, ["rev-parse", "HEAD"]) };
}

describe("finalizeLiveStepResult", () => {
  it("authorizes only the reset selected by a failed result", () => {
    const { repoPath, baseHead } = initRepo();
    const resultJsonPath = path.join(repoPath, "result.json");
    const verificationLogPath = path.join(repoPath, "verification.log");
    fs.writeFileSync(path.join(repoPath, "step-edit.txt"), "changed\n");
    fs.writeFileSync(
      resultJsonPath,
      JSON.stringify({
        success: false,
        summary: "live step failed",
        key_changes_made: [],
        key_learnings: [],
        remaining_work: [],
        goal_complete: false,
        commit: {
          type: "test",
          subject: "failed live step",
          body: "",
          breaking: false,
        },
      }),
    );
    const mutations: Array<"commit" | "reset"> = [];
    const raw = {
      ok: true,
      result: {
        state: "failed",
        summary: "live step failed",
        checkpoints: [],
        artifacts: [],
        resultDigest: null,
        errorCode: "command_failed",
        errorMessage: "live step failed",
        retryHint: null,
        recoveryHint: null,
      },
      executorLogPath: path.join(repoPath, "executor.log"),
      resultJsonPath,
    } satisfies WorkflowStepExecutorDispatchResult;

    const finalized = finalizeLiveStepResult(raw, repoPath, {
      baseHead,
      verificationCommands: [],
      verificationTimeoutSec: 30,
      verificationLogPath,
      beforeGitMutation: (mutation) => {
        mutations.push(mutation);
        return { ok: true };
      },
    });

    expect(finalized.ok).toBe(true);
    expect(mutations).toEqual(["reset"]);
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
  });
});
