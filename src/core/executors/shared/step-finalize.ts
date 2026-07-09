/**
 * Shared workflow-step verification + commit / reset finalization transaction.
 *
 * This is the workflow/runtime-owned seam that takes the *output* of a finished
 * workflow-step implementation (its normalized runner-result `success` flag and
 * `commit` intent) and runs Momentum's existing verify -> commit / reset
 * transaction around it, preserving the safety posture the retired foreground
 * iteration path enforced. It owns no durable state: it is a pure transaction
 * over git + verification, composed on `iteration-finalize.ts`, which stays a
 * pure transaction its caller composes.
 *
 * It began as the live-step lane's
 * `live-step/finalize.ts`, then was extracted here so the
 * finalization consumers depend on one shared seam instead of the
 * executor-loop families reaching into a live-step module for it. The consumers:
 *
 *   - the live wrappers - `live-step/advance.ts` and
 *     `live-step/run-recovery.ts`, via the `live-step/finalize.ts` back-compat
 *     alias surface that re-exports these functions under their original
 *     `*LiveWorkflowStep*` names;
 *   - the goal-loop executor family - `goal-loop/mechanism.ts`,
 *     `goal-loop/executor.ts`, and `goal-loop/orchestrator.ts`, imported
 *     directly; and
 *   - the single-shot executor family - `single-shot/mechanism.ts`, which
 *     still reaches the seam through the `live-step/finalize.ts` back-compat
 *     alias until its own migration.
 *
 * The ordered contract this transaction enforces:
 *
 *   1. Read HEAD. If the step left HEAD somewhere other than the expected base,
 *      Momentum refuses to verify, commit, or reset and enters manual recovery
 *      (`head_mismatch`). The finalizer must not commit; a moved HEAD means a
 *      non-Momentum commit we must not destroy.
 *   2. Otherwise delegate to {@link finalizeIteration}: a failed step resets the
 *      worktree (verification skipped); a successful step runs the configured
 *      verification commands, resets on failure, and commits the normalized
 *      intent on success.
 *   3. Before every commit/reset mutation, call the optional ownership hook so
 *      a caller can prove it still owns the repo/workflow lease. Lost ownership
 *      returns `repo_lock_lost` before further git mutation.
 *   4. Map the finalize outcome into a workflow-oriented result. Any
 *      `head_mismatch` the commit / reset primitives surface (a TOCTOU race
 *      where HEAD moved after the pre-check) is also routed to manual recovery
 *      instead of a destructive reset; unsafe finalization failures preserve
 *      their specific `reset_failed`, `commit_failed`, `git_failed`,
 *      `repo_lock_lost`, or `invalid_input` outcomes.
 *
 * {@link finalizeWorkflowStep} takes the already-parsed `success` flag and
 * `commit` intent. Because a step orchestrator's dispatch result and the
 * executor boundary only carry the runner-result *path* (not the parsed
 * `RunnerResult`), {@link finalizeWorkflowStepFromResultFile} is the companion
 * seam the run-level composition actually calls: it re-reads the durable result
 * document, extracts `success` + `commit`, and then runs the transaction —
 * surfacing `result_missing` / `result_invalid` without touching git when that
 * document cannot be trusted.
 *
 * The run-level callers compose this seam: the live path's
 * {@link ../live-step/run-recovery.ts} `persistLiveWorkflowFinalizeRecovery` takes
 * any run-level recovery outcome (`manual_recovery_required`, `result_missing`,
 * `result_invalid`, unsafe finalization failures such as `reset_failed`,
 * `repo_lock_lost`, `git_failed`, `commit_failed`, or `invalid_input`) and sets
 * the durable `needs_manual_recovery` flag plus the per-run `recovery.md`
 * artifact, exactly as recovery reconcile already does for other blocking
 * codes; the goal-loop / single-shot mechanisms project the same outcomes
 * into their durable round classification.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type {
  CommitFailure,
  CommitSuccess,
  ResetFailure,
  ResetSuccess
} from "../../../adapters/git-transaction.js";
import {
  finalizeIteration,
  type FinalizeResetTrigger
} from "../../repo/iteration-finalize.js";
import { LIVE_STEP_WRAPPER_RESULT_MAX_BYTES } from "../../../adapters/live-step-wrapper.js";
import { parseRunnerResult } from "../runner/result.js";
import type { CommitIntent, RunnerResult } from "../runner/types.js";
import type {
  VerificationFailure,
  VerificationSuccess
} from "../../repo/verification.js";

const SHA40_RE = /^[0-9a-f]{40}$/;

export type FinalizeWorkflowStepInput = {
  repoPath: string;
  /** The HEAD the step started from; finalize commits onto / resets to it. */
  baseHead: string;
  /** The step's normalized runner-result `success` flag. */
  stepSuccess: boolean;
  /** The step's normalized runner-result commit intent. */
  commitIntent: CommitIntent;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  /**
   * Ownership proof called immediately before each commit/reset mutation. A
   * failed check returns `repo_lock_lost` so callers can enter recovery instead
   * of mutating after losing the repo/workflow lease.
   */
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

/**
 * Recovery code for the manual-recovery branch this transaction raises when
 * HEAD moved off the expected base. Other unsafe finalization outcomes are
 * represented by their distinct result variants (`reset_failed`,
 * `repo_lock_lost`, `git_failed`, `commit_failed`, `invalid_input`) and mapped
 * to run-level recovery by the consuming lane.
 */
export type WorkflowStepFinalizeRecoveryCode = "head_mismatch";

/**
 * Which stage detected the moved HEAD: the pre-finalize check, or the commit /
 * reset primitive's own guard during a finalize race.
 */
export type WorkflowStepFinalizeRecoveryTrigger =
  | "pre_finalize"
  | "commit"
  | "reset";

export type FinalizeWorkflowStepResult =
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
      recoveryCode: WorkflowStepFinalizeRecoveryCode;
      trigger: WorkflowStepFinalizeRecoveryTrigger;
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
      outcome: "repo_lock_lost";
      error: string;
    }
  | {
      outcome: "invalid_input";
      error: string;
    };

export type FinalizeWorkflowStepFromResultFileInput = {
  repoPath: string;
  /** The HEAD the step started from; finalize commits onto / resets to it. */
  baseHead: string;
  /**
   * Absolute path to the normalized runner-result document the step wrote (the
   * orchestrator's `dispatch.resultJsonPath`). Both the `success` flag and the
   * `commit` intent are read from this durable artifact.
   */
  resultFilePath: string;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  /**
   * Forwarded to {@link finalizeWorkflowStep} to prove ownership before every
   * commit/reset mutation and surface `repo_lock_lost` on failure.
   */
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

/**
 * The result of {@link finalizeWorkflowStepFromResultFile}: every
 * {@link FinalizeWorkflowStepResult} outcome, plus the two result-document
 * recovery codes this seam introduces. A missing or unreadable / malformed
 * result document is ambiguous — the step's true outcome is unknown — so the
 * seam refuses to mutate git and surfaces the recovery code for the run-level
 * recovery layer, mirroring how a moved HEAD routes to manual recovery rather
 * than a destructive reset.
 */
export type FinalizeWorkflowStepFromResultFileResult =
  | FinalizeWorkflowStepResult
  | {
      outcome: "result_missing";
      resultFilePath: string;
      error: string;
    }
  | {
      outcome: "result_invalid";
      resultFilePath: string;
      error: string;
    };

/**
 * Wire a finished workflow step's output into Momentum's verify -> commit /
 * reset transaction. See the module doc for the ordered contract.
 */
export function finalizeWorkflowStep(
  input: FinalizeWorkflowStepInput
): FinalizeWorkflowStepResult {
  const invalid = validateInput(input);
  if (invalid !== null) return invalid;

  const {
    repoPath,
    baseHead,
    stepSuccess,
    commitIntent,
    verificationCommands,
    verificationTimeoutSec,
    verificationLogPath,
    beforeGitMutation
  } = input;

  // 1. Refuse to touch the worktree if the step moved HEAD off the base.
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
    verificationLogPath,
    ...(beforeGitMutation !== undefined ? { beforeGitMutation } : {})
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
    case "ownership_lost":
      return { outcome: "repo_lock_lost", error: finalize.error };
    case "invalid_input":
      return { outcome: "invalid_input", error: finalize.error };
  }
}

/**
 * Read the normalized runner-result document a finished step wrote and run
 * {@link finalizeWorkflowStep} from it.
 *
 * A step orchestrator (e.g. `live-step/orchestrator.ts`) is git-agnostic and
 * its dispatch result carries the runner-result file *path* rather than the
 * parsed `RunnerResult`; the executor boundary deliberately drops the
 * domain-shaped commit intent. This seam is therefore where the run-level
 * composition re-reads the durable result to obtain the `success` flag and the
 * explicit, normalized `commit` intent the "Git And Verification Transaction"
 * contract requires before any commit:
 *
 *   - A present, valid result drives {@link finalizeWorkflowStep} with its
 *     `success` + `commit`: `success: true` commits (verification-gated);
 *     `success: false` is the executed-but-failed path and resets the worktree.
 *   - A missing result returns `result_missing`; an unreadable, non-regular,
 *     oversized (> 1 MiB), or unparseable document returns `result_invalid`.
 *     Neither mutates git: an ambiguous outcome must not trigger a destructive
 *     reset, so the recovery layer classifies it instead.
 *   - A moved HEAD still routes to `manual_recovery_required` via the inner
 *     transaction's pre-finalize check; ownership loss and unsafe git /
 *     commit / reset / input failures preserve their distinct recovery
 *     outcomes for the run-level recovery layer.
 */
export function finalizeWorkflowStepFromResultFile(
  input: FinalizeWorkflowStepFromResultFileInput
): FinalizeWorkflowStepFromResultFileResult {
  if (
    typeof input.resultFilePath !== "string" ||
    input.resultFilePath.trim().length === 0
  ) {
    return { outcome: "invalid_input", error: "resultFilePath is required." };
  }

  const read = readNormalizedResultFile(input.resultFilePath);
  if (!read.ok) {
    return {
      outcome: read.code,
      resultFilePath: input.resultFilePath,
      error: read.error
    };
  }

  return finalizeWorkflowStep({
    repoPath: input.repoPath,
    baseHead: input.baseHead,
    stepSuccess: read.result.success,
    commitIntent: read.result.commit,
    verificationCommands: input.verificationCommands,
    verificationTimeoutSec: input.verificationTimeoutSec,
    verificationLogPath: input.verificationLogPath,
    ...(input.beforeGitMutation !== undefined
      ? { beforeGitMutation: input.beforeGitMutation }
      : {})
  });
}

type ReadNormalizedResultFile =
  | { ok: true; result: RunnerResult }
  | { ok: false; code: "result_missing" | "result_invalid"; error: string };

/**
 * Read + parse the step's normalized result document. Applies the same
 * regular-file / symlink / 1 MiB-ceiling guards the live wrapper enforces when
 * it first writes the result, so a re-read at finalize time cannot be tricked
 * into ingesting an oversized or non-regular artifact.
 *
 * The `live step ...` wording in these `result_missing` / `result_invalid`
 * errors is the preserved durable contract. It surfaces in workflow status /
 * logs output, `recovery.md` artifacts, and is pinned by the finalize tests, so
 * it is intentionally kept verbatim across the relocation, not updated to match
 * the neutral symbol names.
 */
function readNormalizedResultFile(
  resultFilePath: string
): ReadNormalizedResultFile {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resultFilePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return {
        ok: false,
        code: "result_missing",
        error: `live step result file was not written at ${resultFilePath}.`
      };
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultFilePath} is unreadable: ${detail}`
    };
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultFilePath} is not a regular file.`
    };
  }

  if (stat.size > LIVE_STEP_WRAPPER_RESULT_MAX_BYTES) {
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultFilePath} exceeds ${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES} bytes.`
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resultFilePath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultFilePath} is unreadable: ${detail}`
    };
  }

  const parsed = parseRunnerResult(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result JSON is invalid: ${parsed.error}`
    };
  }

  return { ok: true, result: parsed.value };
}

function errnoCode(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

// The `live workflow step ...` reason wording is the preserved durable contract
// (pinned by the finalize / run-recovery tests and surfaced in recovery
// artifacts); it is kept verbatim across the relocation.
function manualRecovery(
  trigger: WorkflowStepFinalizeRecoveryTrigger,
  expectedHead: string,
  currentHead: string
): FinalizeWorkflowStepResult {
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
): FinalizeWorkflowStepResult {
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
  input: FinalizeWorkflowStepInput
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
