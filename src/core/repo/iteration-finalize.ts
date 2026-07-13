import fs from "node:fs";

import {
  commitVerifiedChanges,
  resetToBase,
  type CommitFailure,
  type CommitSuccess,
  type ResetFailure,
  type ResetSuccess,
} from "../../adapters/git-transaction.js";
import type { CommitIntent } from "../executors/runner/types.js";
import {
  runVerification,
  type VerificationFailure,
  type VerificationSuccess,
} from "./verification.js";

const SHA40_RE = /^[0-9a-f]{40}$/;

export type FinalizeIterationInput = {
  repoPath: string;
  baseHead: string;
  runnerSuccess: boolean;
  commitIntent: CommitIntent;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  /**
   * Optional ownership proof for callers that hold an external repo/workflow
   * lease. It is called immediately before each commit/reset mutation; failure
   * aborts the transaction with `ownership_lost` before mutating git.
   */
  beforeGitMutation?: (
    mutation: "commit" | "reset",
  ) => { ok: true } | { ok: false; error: string };
  beforeCommit?: (evidence: {
    expectedTree: string;
    message: string;
  }) => { ok: true } | { ok: false; error: string };
};

export type FinalizeResetTrigger = "runner_failure" | "verification_failure";

export type FinalizeIterationResult =
  | {
      outcome: "committed";
      verification: VerificationSuccess;
      commit: CommitSuccess;
    }
  | {
      outcome: "reset_runner_failure";
      reset: ResetSuccess;
    }
  | {
      outcome: "reset_verification_failure";
      verification: VerificationFailure;
      reset: ResetSuccess;
    }
  | {
      outcome: "reset_failed";
      trigger: FinalizeResetTrigger;
      verification: VerificationFailure | null;
      reset: ResetFailure;
    }
  | {
      outcome: "commit_failed";
      verification: VerificationSuccess;
      commit: CommitFailure;
      reset?: ResetSuccess | ResetFailure;
    }
  | {
      /**
       * The optional ownership hook failed before a commit/reset mutation.
       * Callers should preserve the worktree and route this through their
       * recovery path rather than retrying the mutation blindly.
       */
      outcome: "ownership_lost";
      error: string;
    }
  | {
      outcome: "invalid_input";
      error: string;
    };

export function finalizeIteration(
  input: FinalizeIterationInput,
): FinalizeIterationResult {
  const invalid = validateInput(input);
  if (invalid !== null) return invalid;

  const {
    repoPath,
    baseHead,
    runnerSuccess,
    commitIntent,
    verificationCommands,
    verificationTimeoutSec,
    verificationLogPath,
  } = input;

  if (!runnerSuccess) {
    writeVerificationSkipNote(verificationLogPath, "runner reported failure");
    const ownership = checkOwnership(input, "reset");
    if (ownership !== null) return ownership;
    const reset = resetToBase({ repoPath, baseHead });
    if (!reset.ok) {
      return {
        outcome: "reset_failed",
        trigger: "runner_failure",
        verification: null,
        reset,
      };
    }
    return { outcome: "reset_runner_failure", reset };
  }

  const verification = runVerification({
    repoPath,
    commands: verificationCommands,
    timeoutSec: verificationTimeoutSec,
    logPath: verificationLogPath,
  });

  if (!verification.ok) {
    const ownership = checkOwnership(input, "reset");
    if (ownership !== null) return ownership;
    const reset = resetToBase({ repoPath, baseHead });
    if (!reset.ok) {
      return {
        outcome: "reset_failed",
        trigger: "verification_failure",
        verification,
        reset,
      };
    }
    return { outcome: "reset_verification_failure", verification, reset };
  }

  const ownership = checkOwnership(input, "commit");
  if (ownership !== null) return ownership;

  const commit = commitVerifiedChanges({
    repoPath,
    baseHead,
    commit: commitIntent,
    ...(input.beforeCommit !== undefined
      ? { beforeCommit: input.beforeCommit }
      : {}),
  });

  if (!commit.ok) {
    if (shouldResetAfterCommitFailure(commit.code)) {
      const resetOwnership = checkOwnership(input, "reset");
      if (resetOwnership !== null) return resetOwnership;
      const reset = resetToBase({ repoPath, baseHead });
      return { outcome: "commit_failed", verification, commit, reset };
    }
    return { outcome: "commit_failed", verification, commit };
  }

  return { outcome: "committed", verification, commit };
}

function checkOwnership(
  input: FinalizeIterationInput,
  mutation: "commit" | "reset",
): Extract<FinalizeIterationResult, { outcome: "ownership_lost" }> | null {
  if (input.beforeGitMutation === undefined) return null;
  const check = input.beforeGitMutation(mutation);
  if (check.ok) return null;
  return { outcome: "ownership_lost", error: check.error };
}

function shouldResetAfterCommitFailure(code: CommitFailure["code"]): boolean {
  return (
    code !== "nothing_to_commit" &&
    code !== "head_mismatch" &&
    code !== "invalid_input" &&
    code !== "precommit_rejected"
  );
}

function validateInput(
  input: FinalizeIterationInput,
): { outcome: "invalid_input"; error: string } | null {
  if (
    typeof input.repoPath !== "string" ||
    input.repoPath.trim().length === 0
  ) {
    return { outcome: "invalid_input", error: "repoPath is required." };
  }
  if (typeof input.baseHead !== "string" || !SHA40_RE.test(input.baseHead)) {
    return {
      outcome: "invalid_input",
      error: "baseHead must be a 40-character hex SHA.",
    };
  }
  if (typeof input.runnerSuccess !== "boolean") {
    return {
      outcome: "invalid_input",
      error: "runnerSuccess must be a boolean.",
    };
  }
  if (input.commitIntent === null || typeof input.commitIntent !== "object") {
    return { outcome: "invalid_input", error: "commitIntent is required." };
  }
  if (!Array.isArray(input.verificationCommands)) {
    return {
      outcome: "invalid_input",
      error: "verificationCommands must be an array of strings.",
    };
  }
  if (
    !Number.isInteger(input.verificationTimeoutSec) ||
    input.verificationTimeoutSec <= 0
  ) {
    return {
      outcome: "invalid_input",
      error: "verificationTimeoutSec must be a positive integer.",
    };
  }
  if (
    typeof input.verificationLogPath !== "string" ||
    input.verificationLogPath.trim().length === 0
  ) {
    return {
      outcome: "invalid_input",
      error: "verificationLogPath is required.",
    };
  }
  return null;
}

function writeVerificationSkipNote(logPath: string, reason: string): void {
  const body = `[verify] skipped: ${reason}\n[verify] summary: verification skipped (${reason})\n`;
  try {
    fs.writeFileSync(logPath, body, "utf-8");
  } catch {
    // best-effort artifact; do not block reset on log write failures
  }
}
