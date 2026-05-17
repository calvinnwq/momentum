import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type { GoalArtifactPaths } from "./artifacts.js";
import { ensureMomentumBranch } from "./branch-manager.js";
import { resetToBase } from "./git-transaction.js";
import type { GoalSpec } from "./goal-spec.js";
import {
  finalizeIteration,
  type FinalizeIterationResult
} from "./iteration-finalize.js";
import {
  renderIterationPrompt,
  type IterationPromptSourceContext
} from "./iteration-prompt.js";
import { loadMomentumPolicy } from "./momentum-policy.js";
import { inspectRepo } from "./repo-guard.js";
import {
  dispatchRunnerAdapter,
  getRunnerAdapter,
  listExecutingRunnerAdapterKinds,
  type RunnerAdapterErrorCode,
  type RunnerAdapterResult
} from "./runner-adapter.js";
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
  | "command_failed"
  | "command_timed_out"
  | "result_missing"
  | "result_invalid"
  | "runtime_unavailable"
  | "startup_failed"
  | "spawn_failed"
  | "output_overflow"
  | "runner_changed_head"
  | "runner_reported_failure"
  | "verification_failed"
  | "commit_failed"
  | "reset_failed"
  | "finalize_invalid_input"
  | "git_failed"
  | "unexpected_error";

export type ForegroundIterationError = {
  ok: false;
  code: ForegroundIterationErrorCode;
  error: string;
  finalize?: FinalizeIterationResult;
  manualRecovery?: {
    expectedCommit: string;
    currentCommit: string;
    reason: {
      code: string;
      message: string;
    };
    safeNextSteps: string[];
    resultJsonPath?: string;
  };
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
  verificationLogPath: string;
  commitSha: string;
  commitMessage: string;
  finalize: FinalizeIterationResult;
};

export type ForegroundIterationResult =
  | ForegroundIterationError
  | ForegroundIterationSuccess;

export type ForegroundIterationInput = {
  goalId: string;
  spec: GoalSpec;
  iteration: number;
  artifactPaths: GoalArtifactPaths;
  sourceContext?: IterationPromptSourceContext | null;
  sourceContextMaxChars?: number;
};

export function runForegroundIteration(
  input: ForegroundIterationInput
): ForegroundIterationResult {
  const { goalId, spec, iteration, artifactPaths, sourceContext, sourceContextMaxChars } =
    input;

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
  if (iteration !== artifactPaths.iteration) {
    return {
      ok: false,
      code: "invalid_input",
      error: `iteration ${iteration} does not match artifactPaths iteration ${artifactPaths.iteration}.`
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

  const preAdapter = getRunnerAdapter(spec.runner);
  if (!preAdapter || !preAdapter.executes) {
    const executing = listExecutingRunnerAdapterKinds();
    return {
      ok: false,
      code: "unsupported_runner",
      error: `Runner "${spec.runner}" is not supported for execution; supported executing runners: ${executing.join(", ") || "<none>"}.`
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

  const policyLoad = loadMomentumPolicy(guard.repoPath);
  const policyNotes =
    policyLoad.ok && policyLoad.present ? policyLoad.policy.notes : "";
  const policyPath = policyLoad.ok && policyLoad.present ? policyLoad.path : undefined;

  const promptText = renderIterationPrompt({
    spec,
    goalId,
    iteration,
    repoPath: guard.repoPath,
    baseHead,
    policyNotes,
    ...(policyPath !== undefined ? { policyPath } : {}),
    ...(sourceContext ? { sourceContext } : {}),
    ...(sourceContextMaxChars !== undefined ? { sourceContextMaxChars } : {})
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

  const dispatch: RunnerAdapterResult = dispatchRunnerAdapter(spec.runner, {
    goalId,
    iteration,
    repoPath: guard.repoPath,
    baseHead,
    branch: branchResult.branch,
    promptPath: artifactPaths.promptMd,
    iterationDir: artifactPaths.iterationDir,
    resultJsonPath: artifactPaths.resultJson,
    runnerLogPath: artifactPaths.runnerLog,
    spec
  });

  if (!dispatch.ok) {
    if (dispatch.code === "unsupported_runner") {
      return {
        ok: false,
        code: "unsupported_runner",
        error: dispatch.error
      };
    }
    if (dispatch.code === "invalid_input") {
      return {
        ok: false,
        code: "runner_failed",
        error: `runner "${spec.runner}" failed: ${dispatch.error}`
      };
    }

    const failureCode = runnerAdapterErrorToIterationCode(dispatch.code);
    const failureMessage = `runner "${spec.runner}" failed (${dispatch.code}): ${dispatch.error}`;

    const currentHead = getCurrentHead(guard.repoPath);
    if (!currentHead.ok) {
      return currentHead;
    }
    if (currentHead.head !== baseHead) {
      return runnerChangedHeadError({
        runner: spec.runner,
        baseHead,
        currentHead: currentHead.head,
        detail: `runner error: ${dispatch.error}`
      });
    }
    const reset = resetToBase({ repoPath: guard.repoPath, baseHead });
    if (!reset.ok) {
      return {
        ok: false,
        code: "reset_failed",
        error: `reset after ${dispatch.code} failed: ${reset.error} (runner error: ${dispatch.error})`
      };
    }
    return {
      ok: false,
      code: failureCode,
      error: failureMessage
    };
  }

  const runnerOut = dispatch;

  const currentHead = getCurrentHead(guard.repoPath);
  if (!currentHead.ok) return currentHead;
  const postRunnerHead = currentHead.head;

  if (postRunnerHead !== baseHead) {
    return runnerChangedHeadError({
      runner: spec.runner,
      baseHead,
      currentHead: postRunnerHead,
      detail: "runner completed before Momentum finalization",
      resultJsonPath: runnerOut.resultJsonPath
    });
  }

  const finalize = finalizeIteration({
    repoPath: guard.repoPath,
    baseHead,
    runnerSuccess: runnerOut.result.success,
    commitIntent: runnerOut.result.commit,
    verificationCommands: spec.verification,
    verificationTimeoutSec: spec.verification_timeout_sec,
    verificationLogPath: artifactPaths.verificationLog
  });

  const baseSuccess = {
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
    resultJsonPath: runnerOut.resultJsonPath,
    verificationLogPath: artifactPaths.verificationLog
  };

  switch (finalize.outcome) {
    case "committed":
      return {
        ok: true,
        ...baseSuccess,
        commitSha: finalize.commit.commitSha,
        commitMessage: finalize.commit.message,
        finalize
      };
    case "reset_runner_failure":
      return {
        ok: false,
        code: "runner_reported_failure",
        error: "Runner reported success=false; uncommitted changes reset to base HEAD.",
        finalize
      };
    case "reset_verification_failure":
      return {
        ok: false,
        code: "verification_failed",
        error: `${finalize.verification.code}: ${finalize.verification.error}`,
        finalize
      };
    case "reset_failed":
      if (finalize.reset.code === "head_mismatch") {
        const currentHead = getCurrentHead(guard.repoPath);
        if (!currentHead.ok) return currentHead;
        return headMismatchManualRecoveryError({
          code: "reset_failed",
          runner: spec.runner,
          baseHead,
          currentHead: currentHead.head,
          detail: `reset after ${finalize.trigger} failed: ${finalize.reset.error}`,
          finalize,
          resultJsonPath: runnerOut.resultJsonPath
        });
      }
      return {
        ok: false,
        code: "reset_failed",
        error: `reset after ${finalize.trigger} failed: ${finalize.reset.error}`,
        finalize
      };
    case "commit_failed":
      if (finalize.commit.code === "head_mismatch") {
        const currentHead = getCurrentHead(guard.repoPath);
        if (!currentHead.ok) return currentHead;
        return headMismatchManualRecoveryError({
          code: "commit_failed",
          runner: spec.runner,
          baseHead,
          currentHead: currentHead.head,
          detail: `commit after verified runner failed: ${finalize.commit.error}`,
          finalize,
          resultJsonPath: runnerOut.resultJsonPath
        });
      }
      if (finalize.reset !== undefined && !finalize.reset.ok) {
        if (finalize.reset.code === "head_mismatch") {
          const currentHead = getCurrentHead(guard.repoPath);
          if (!currentHead.ok) return currentHead;
          return headMismatchManualRecoveryError({
            code: "reset_failed",
            runner: spec.runner,
            baseHead,
            currentHead: currentHead.head,
            detail: `reset after commit_failure failed: ${finalize.reset.error} (commit error: ${finalize.commit.error})`,
            finalize,
            resultJsonPath: runnerOut.resultJsonPath
          });
        }
        return {
          ok: false,
          code: "reset_failed",
          error: `reset after commit_failure failed: ${finalize.reset.error} (commit error: ${finalize.commit.error})`,
          finalize
        };
      }
      return {
        ok: false,
        code: "commit_failed",
        error: `commit after verified runner failed: ${finalize.commit.error}`,
        finalize
      };
    case "invalid_input":
      return {
        ok: false,
        code: "finalize_invalid_input",
        error: finalize.error,
        finalize
      };
  }
}

function runnerChangedHeadError(input: {
  runner: string;
  baseHead: string;
  currentHead: string;
  detail: string;
  resultJsonPath?: string;
}): ForegroundIterationError {
  const message = `runner "${input.runner}" moved HEAD from ${input.baseHead} to ${input.currentHead}; leaving repo unchanged for manual recovery (${input.detail})`;
  return {
    ok: false,
    code: "runner_changed_head",
    error: message,
    manualRecovery: {
      expectedCommit: input.baseHead,
      currentCommit: input.currentHead,
      reason: {
        code: "runner_changed_head",
        message
      },
      safeNextSteps: [
        "Inspect the runner-created commit and repository state.",
        "Decide whether to keep, amend, or reset the runner-created commit.",
        "Run `momentum recovery clear <goal-id>` after the repository is safe for queued work."
      ],
      ...(input.resultJsonPath !== undefined
        ? { resultJsonPath: input.resultJsonPath }
        : {})
    }
  };
}

function headMismatchManualRecoveryError(input: {
  code: "commit_failed" | "reset_failed";
  runner: string;
  baseHead: string;
  currentHead: string;
  detail: string;
  finalize: FinalizeIterationResult;
  resultJsonPath?: string;
}): ForegroundIterationError {
  const message = `finalization for runner "${input.runner}" found HEAD moved from ${input.baseHead} to ${input.currentHead}; leaving repo unchanged for manual recovery (${input.detail})`;
  return {
    ok: false,
    code: input.code,
    error: message,
    finalize: input.finalize,
    manualRecovery: {
      expectedCommit: input.baseHead,
      currentCommit: input.currentHead,
      reason: {
        code: "head_mismatch",
        message
      },
      safeNextSteps: [
        "Inspect the commit that moved HEAD during finalization.",
        "Decide whether to keep, amend, or reset the non-Momentum commit.",
        "Run `momentum recovery clear <goal-id>` after the repository is safe for queued work."
      ],
      ...(input.resultJsonPath !== undefined
        ? { resultJsonPath: input.resultJsonPath }
        : {})
    }
  };
}

function runnerAdapterErrorToIterationCode(
  code: RunnerAdapterErrorCode
): ForegroundIterationErrorCode {
  switch (code) {
    case "command_failed":
      return "command_failed";
    case "command_timed_out":
      return "command_timed_out";
    case "result_missing":
      return "result_missing";
    case "result_invalid":
      return "result_invalid";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "startup_failed":
      return "startup_failed";
    case "spawn_failed":
      return "spawn_failed";
    case "output_overflow":
      return "output_overflow";
    default:
      return "runner_failed";
  }
}

function getCurrentHead(
  repoPath: string
): { ok: true; head: string } | ForegroundIterationError {
  try {
    const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, head };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "git_failed",
      error: `git rev-parse HEAD failed: ${detail}`
    };
  }
}
