import fs from "node:fs";

import {
  commitVerifiedChanges,
  resetToBase,
  type CommitFailure,
  type CommitSuccess,
  type ResetFailure,
  type ResetSuccess
} from "./git-transaction.js";
import type { CommitIntent } from "./runner-result.js";
import {
  runVerification,
  type VerificationFailure,
  type VerificationSuccess
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
    }
  | {
      outcome: "invalid_input";
      error: string;
    };

export function finalizeIteration(
  input: FinalizeIterationInput
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
    verificationLogPath
  } = input;

  if (!runnerSuccess) {
    writeVerificationSkipNote(verificationLogPath, "runner reported failure");
    const reset = resetToBase({ repoPath, baseHead });
    if (!reset.ok) {
      return {
        outcome: "reset_failed",
        trigger: "runner_failure",
        verification: null,
        reset
      };
    }
    return { outcome: "reset_runner_failure", reset };
  }

  const verification = runVerification({
    repoPath,
    commands: verificationCommands,
    timeoutSec: verificationTimeoutSec,
    logPath: verificationLogPath
  });

  if (!verification.ok) {
    const reset = resetToBase({ repoPath, baseHead });
    if (!reset.ok) {
      return {
        outcome: "reset_failed",
        trigger: "verification_failure",
        verification,
        reset
      };
    }
    return { outcome: "reset_verification_failure", verification, reset };
  }

  const commit = commitVerifiedChanges({
    repoPath,
    baseHead,
    commit: commitIntent
  });

  if (!commit.ok) {
    return { outcome: "commit_failed", verification, commit };
  }

  return { outcome: "committed", verification, commit };
}

function validateInput(
  input: FinalizeIterationInput
): { outcome: "invalid_input"; error: string } | null {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return { outcome: "invalid_input", error: "repoPath is required." };
  }
  if (typeof input.baseHead !== "string" || !SHA40_RE.test(input.baseHead)) {
    return {
      outcome: "invalid_input",
      error: "baseHead must be a 40-character hex SHA."
    };
  }
  if (typeof input.runnerSuccess !== "boolean") {
    return {
      outcome: "invalid_input",
      error: "runnerSuccess must be a boolean."
    };
  }
  if (input.commitIntent === null || typeof input.commitIntent !== "object") {
    return { outcome: "invalid_input", error: "commitIntent is required." };
  }
  if (!Array.isArray(input.verificationCommands)) {
    return {
      outcome: "invalid_input",
      error: "verificationCommands must be an array of strings."
    };
  }
  if (
    !Number.isInteger(input.verificationTimeoutSec) ||
    input.verificationTimeoutSec <= 0
  ) {
    return {
      outcome: "invalid_input",
      error: "verificationTimeoutSec must be a positive integer."
    };
  }
  if (
    typeof input.verificationLogPath !== "string" ||
    input.verificationLogPath.trim().length === 0
  ) {
    return { outcome: "invalid_input", error: "verificationLogPath is required." };
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
