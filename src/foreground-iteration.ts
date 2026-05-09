import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type { GoalArtifactPaths } from "./artifacts.js";
import { ensureMomentumBranch } from "./branch-manager.js";
import { runFakeRunner } from "./fake-runner.js";
import type { GoalSpec } from "./goal-spec.js";
import { renderIterationPrompt } from "./iteration-prompt.js";
import { inspectRepo } from "./repo-guard.js";
import type { RunnerResult } from "./runner-result.js";

export type ForegroundIterationErrorCode =
  | "invalid_input"
  | "missing_repo"
  | "unsupported_runner"
  | "iteration_out_of_range"
  | "repo_guard_failed"
  | "branch_manager_failed"
  | "artifact_write_failed"
  | "runner_failed"
  | "git_failed"
  | "unexpected_error";

export type ForegroundIterationError = {
  ok: false;
  code: ForegroundIterationErrorCode;
  error: string;
};

export type ForegroundIterationSuccess = {
  ok: true;
  goalId: string;
  iteration: number;
  repoPath: string;
  branch: string;
  branchCreated: boolean;
  baseHead: string;
  postRunnerHead: string;
  result: RunnerResult;
  promptPath: string;
  runnerLogPath: string;
  resultJsonPath: string;
};

export type ForegroundIterationResult =
  | ForegroundIterationError
  | ForegroundIterationSuccess;

export type ForegroundIterationInput = {
  goalId: string;
  spec: GoalSpec;
  iteration: number;
  artifactPaths: GoalArtifactPaths;
};

export function runForegroundIteration(
  input: ForegroundIterationInput
): ForegroundIterationResult {
  const { goalId, spec, iteration, artifactPaths } = input;

  if (typeof goalId !== "string" || goalId.trim().length === 0) {
    return { ok: false, code: "invalid_input", error: "goalId is required." };
  }
  if (!Number.isInteger(iteration) || iteration < 1) {
    return {
      ok: false,
      code: "invalid_input",
      error: "iteration must be a positive integer."
    };
  }
  if (iteration !== 1) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Milestone 1 supports iteration 1 only."
    };
  }
  if (iteration > spec.max_iterations) {
    return {
      ok: false,
      code: "iteration_out_of_range",
      error: `iteration ${iteration} exceeds max_iterations ${spec.max_iterations}.`
    };
  }
  if (spec.repo === undefined || spec.repo.trim().length === 0) {
    return {
      ok: false,
      code: "missing_repo",
      error:
        "Goal spec is missing repo path; pass --repo or set repo in goal frontmatter."
    };
  }
  if (spec.runner !== "fake") {
    return {
      ok: false,
      code: "unsupported_runner",
      error: `Runner ${spec.runner} is not supported in Milestone 1; only 'fake' is implemented.`
    };
  }

  const guard = inspectRepo(spec.repo);
  if (!guard.ok) {
    return { ok: false, code: "repo_guard_failed", error: guard.error };
  }

  const branchResult = ensureMomentumBranch({
    repoPath: guard.repoPath,
    branch: spec.branch,
    goalId,
    baseHead: guard.head
  });
  if (!branchResult.ok) {
    return {
      ok: false,
      code: "branch_manager_failed",
      error: branchResult.error
    };
  }

  const baseHead = branchResult.head;

  const promptText = renderIterationPrompt({
    spec,
    goalId,
    iteration,
    repoPath: guard.repoPath,
    baseHead
  });
  try {
    fs.writeFileSync(artifactPaths.promptMd, promptText, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "artifact_write_failed",
      error: `failed to write prompt.md: ${detail}`
    };
  }

  let runnerOut;
  try {
    runnerOut = runFakeRunner({
      repoPath: guard.repoPath,
      iterationDir: artifactPaths.iteration1Dir,
      iteration
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "runner_failed",
      error: `fake runner failed: ${detail}`
    };
  }

  let postRunnerHead: string;
  try {
    postRunnerHead = execFileSync(
      "git",
      ["-C", guard.repoPath, "rev-parse", "HEAD"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "git_failed",
      error: `git rev-parse HEAD failed: ${detail}`
    };
  }

  return {
    ok: true,
    goalId,
    iteration,
    repoPath: guard.repoPath,
    branch: branchResult.branch,
    branchCreated: branchResult.created,
    baseHead,
    postRunnerHead,
    result: runnerOut.result,
    promptPath: artifactPaths.promptMd,
    runnerLogPath: runnerOut.runnerLogPath,
    resultJsonPath: runnerOut.resultJsonPath
  };
}
