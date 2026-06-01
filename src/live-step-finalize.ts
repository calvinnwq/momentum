/**
 * Live workflow-step verification + commit transaction introduced by NGX-334
 * (M9-03).
 *
 * M9-02 (`live-step-orchestrator.ts`) drives one managed live step end to end
 * through its durable lease + step-state lifecycle and returns the executor's
 * normalized runner result. That orchestrator is deliberately git-agnostic: it
 * persists workflow state, but it never touches the worktree. This module is the
 * seam the M9 contract's "Git And Verification Transaction" section requires —
 * it takes the *output* of a finished live implementation step (its normalized
 * `success` flag and `commit` intent) and runs Momentum's existing
 * verify -> commit / reset transaction around it while preserving the same
 * safety posture the foreground iteration path already enforces:
 *
 *   1. Read HEAD. If the live step left HEAD somewhere other than the expected
 *      base, Momentum refuses to verify, commit, or reset and enters manual
 *      recovery (`head_mismatch`). A live wrapper must not commit; a moved HEAD
 *      means a non-Momentum commit we must not destroy.
 *   2. Otherwise delegate to {@link finalizeIteration}: a failed step resets the
 *      worktree (verification skipped); a successful step runs the configured
 *      verification commands, resets on failure, and commits the normalized
 *      intent on success.
 *   3. Map the finalize outcome into a workflow-oriented result. Any
 *      `head_mismatch` the commit / reset primitives surface (a TOCTOU race
 *      where HEAD moved after the pre-check) is also routed to manual recovery
 *      instead of a destructive reset.
 *
 * This module owns no durable state. It is a pure transaction over git +
 * verification, mirroring how `iteration-finalize.ts` stays a pure transaction
 * the foreground caller composes. The run-level caller (a later M9 slice) takes
 * a `manual_recovery_required` result and sets the durable
 * `needs_manual_recovery` flag plus the per-run `recovery.md` artifact, exactly
 * as the M8 recovery reconcile already does for other blocking codes.
 */

import { execFileSync } from "node:child_process";

import type {
  CommitFailure,
  CommitSuccess,
  ResetFailure,
  ResetSuccess
} from "./git-transaction.js";
import {
  finalizeIteration,
  type FinalizeResetTrigger
} from "./iteration-finalize.js";
import type { CommitIntent } from "./runner-result.js";
import type {
  VerificationFailure,
  VerificationSuccess
} from "./verification.js";

const SHA40_RE = /^[0-9a-f]{40}$/;

export type FinalizeLiveWorkflowStepInput = {
  repoPath: string;
  /** The HEAD the live step started from; finalize commits onto / resets to it. */
  baseHead: string;
  /** The live step's normalized runner-result `success` flag. */
  stepSuccess: boolean;
  /** The live step's normalized runner-result commit intent. */
  commitIntent: CommitIntent;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
};

/**
 * The single recovery code this transaction can raise. A live wrapper failure is
 * classified upstream by the orchestrator / live wrapper; the only new git-level
 * recovery boundary M9-03 introduces is an unexpectedly moved HEAD.
 */
export type LiveWorkflowFinalizeRecoveryCode = "head_mismatch";

/**
 * Which stage detected the moved HEAD: the pre-finalize check, or the commit /
 * reset primitive's own guard during a finalize race.
 */
export type LiveWorkflowFinalizeRecoveryTrigger =
  | "pre_finalize"
  | "commit"
  | "reset";

export type FinalizeLiveWorkflowStepResult =
  | {
      outcome: "committed";
      verification: VerificationSuccess;
      commit: CommitSuccess;
      head: string;
    }
  | {
      outcome: "reset_step_failure";
      reset: ResetSuccess;
    }
  | {
      outcome: "reset_verification_failure";
      verification: VerificationFailure;
      reset: ResetSuccess;
    }
  | {
      outcome: "manual_recovery_required";
      recoveryCode: LiveWorkflowFinalizeRecoveryCode;
      trigger: LiveWorkflowFinalizeRecoveryTrigger;
      expectedHead: string;
      currentHead: string;
      reason: string;
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
      outcome: "git_failed";
      error: string;
    }
  | {
      outcome: "invalid_input";
      error: string;
    };

/**
 * Wire a finished live workflow step's output into Momentum's verify -> commit /
 * reset transaction. See the module doc for the ordered contract.
 */
export function finalizeLiveWorkflowStep(
  input: FinalizeLiveWorkflowStepInput
): FinalizeLiveWorkflowStepResult {
  const invalid = validateInput(input);
  if (invalid !== null) return invalid;

  const {
    repoPath,
    baseHead,
    stepSuccess,
    commitIntent,
    verificationCommands,
    verificationTimeoutSec,
    verificationLogPath
  } = input;

  // 1. Refuse to touch the worktree if the live step moved HEAD off the base.
  const preHead = readHead(repoPath);
  if (!preHead.ok) {
    return { outcome: "git_failed", error: preHead.error };
  }
  if (preHead.head !== baseHead) {
    return manualRecovery("pre_finalize", baseHead, preHead.head);
  }

  // 2. Run the existing verification + commit / reset transaction.
  const finalize = finalizeIteration({
    repoPath,
    baseHead,
    runnerSuccess: stepSuccess,
    commitIntent,
    verificationCommands,
    verificationTimeoutSec,
    verificationLogPath
  });

  // 3. Translate the finalize outcome, routing any moved-HEAD finding to manual
  //    recovery rather than reporting a destructive-reset failure.
  switch (finalize.outcome) {
    case "committed":
      return {
        outcome: "committed",
        verification: finalize.verification,
        commit: finalize.commit,
        head: finalize.commit.commitSha
      };
    case "reset_runner_failure":
      return { outcome: "reset_step_failure", reset: finalize.reset };
    case "reset_verification_failure":
      return {
        outcome: "reset_verification_failure",
        verification: finalize.verification,
        reset: finalize.reset
      };
    case "reset_failed":
      if (finalize.reset.code === "head_mismatch") {
        return manualRecoveryFromGuard(repoPath, "reset", baseHead);
      }
      return {
        outcome: "reset_failed",
        trigger: finalize.trigger,
        verification: finalize.verification,
        reset: finalize.reset
      };
    case "commit_failed":
      if (finalize.commit.code === "head_mismatch") {
        return manualRecoveryFromGuard(repoPath, "commit", baseHead);
      }
      if (finalize.reset !== undefined && !finalize.reset.ok) {
        if (finalize.reset.code === "head_mismatch") {
          return manualRecoveryFromGuard(repoPath, "reset", baseHead);
        }
      }
      return {
        outcome: "commit_failed",
        verification: finalize.verification,
        commit: finalize.commit,
        ...(finalize.reset !== undefined ? { reset: finalize.reset } : {})
      };
    case "invalid_input":
      return { outcome: "invalid_input", error: finalize.error };
  }
}

function manualRecovery(
  trigger: LiveWorkflowFinalizeRecoveryTrigger,
  expectedHead: string,
  currentHead: string
): FinalizeLiveWorkflowStepResult {
  return {
    outcome: "manual_recovery_required",
    recoveryCode: "head_mismatch",
    trigger,
    expectedHead,
    currentHead,
    reason: `live workflow step left HEAD at ${currentHead} but expected base ${expectedHead}; entering manual recovery instead of a destructive reset`
  };
}

/**
 * Build the manual-recovery result for a head_mismatch surfaced by the commit /
 * reset primitive. The exact HEAD is re-read; if that read fails the moved HEAD
 * is reported as `unknown` rather than guessing.
 */
function manualRecoveryFromGuard(
  repoPath: string,
  trigger: "commit" | "reset",
  expectedHead: string
): FinalizeLiveWorkflowStepResult {
  const head = readHead(repoPath);
  return manualRecovery(trigger, expectedHead, head.ok ? head.head : "unknown");
}

function readHead(
  repoPath: string
): { ok: true; head: string } | { ok: false; error: string } {
  try {
    const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, head };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `git rev-parse HEAD failed: ${detail}` };
  }
}

function validateInput(
  input: FinalizeLiveWorkflowStepInput
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
  if (typeof input.stepSuccess !== "boolean") {
    return { outcome: "invalid_input", error: "stepSuccess must be a boolean." };
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
    return {
      outcome: "invalid_input",
      error: "verificationLogPath is required."
    };
  }
  return null;
}
