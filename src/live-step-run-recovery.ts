/**
 * Run-level durable recovery for the live verification / commit transaction
 * (NGX-334, M9-03).
 *
 * `live-step-finalize.ts` is a pure transaction over git + verification: it
 * returns a rich in-memory outcome but owns no durable state. This module is the
 * run-level seam the M9 contract's "Recovery" section requires — it takes a
 * {@link FinalizeLiveWorkflowStepFromResultFileResult} and, when that outcome is
 * one of the live run-level recovery conditions M9-03 introduces, durably
 * **enters manual recovery**: it sets the run-scoped `needs_manual_recovery`
 * flag and writes the per-run `recovery.md` artifact "before returning control
 * to the operator". This is the durable counterpart to the finalize module's
 * promise that a moved HEAD or an untrustworthy result document refuses a
 * destructive reset.
 *
 * Finalize and dispatch outcomes map to durable recovery, each carrying a distinct,
 * non-collapsed live recovery code (the contract forbids generic failure text):
 *
 *   - `manual_recovery_required` -> `head_mismatch`: the live step left HEAD off
 *     the recorded base. A non-Momentum commit must be preserved, not reset.
 *   - `result_missing` -> `result_missing`: the step's normalized result
 *     document was never written; the true outcome is unknown.
 *   - `result_invalid` -> `result_invalid`: the result document is malformed;
 *     the outcome cannot be trusted.
 *   - `reset_failed` -> `reset_failed`: reset did not restore the recorded
 *     base, so worktree cleanup is not proven.
 *   - `repo_lock_lost` -> `repo_lock_lost`: Momentum no longer owns the repo
 *     lock required to mutate or clean the worktree.
 *   - `git_failed` / unsafe `commit_failed` / process-level dispatch failures
 *     preserve their specific live recovery classifications.
 *
 * Every other finalize outcome is a clean terminal transaction result —
 * `committed`, or a `reset_step_failure` / `reset_verification_failure` where
 * the worktree was already safely reset.
 *
 * Mirroring {@link ./workflow-recovery-reconcile.ts}, the durable flag is
 * written *first*: it is the authority that blocks unsafe progression, so it
 * must land even if the best-effort `recovery.md` write later fails
 * (`artifact_write_failed`). This module never clears recovery — clearing stays
 * explicit and operator-driven through the M8 guarded clear.
 */

import type { MomentumDb } from "./db.js";
import type { FinalizeLiveWorkflowStepFromResultFileResult } from "./live-step-finalize.js";
import { markWorkflowRunNeedsManualRecovery } from "./workflow-run-recovery.js";
import {
  WORKFLOW_LIVE_RUN_RECOVERY_CODES,
  writeWorkflowRecoveryArtifact,
  writeWorkflowRecoveryArtifactInRunDir,
  type WorkflowLiveRunRecoveryCode,
  type WorkflowRecoveryArtifactInput,
  type WorkflowRecoveryEvidencePointer,
  type WorkflowRecoveryNextAction
} from "./workflow-recovery-artifact.js";

export type PersistLiveWorkflowFinalizeRecoveryInput = {
  runId: string;
  /** The live step the finalize transaction ran for; rendered into recovery.md. */
  stepId: string | null;
  /** The outcome of the live verification / commit transaction. */
  finalize: FinalizeLiveWorkflowStepFromResultFileResult;
  /**
   * Directory under which the run-scoped `recovery.md` is rendered:
   * `<agentWorkflowsDir>/<runId>/recovery.md`. Required because the artifact is
   * the operator-facing half of the recovery enter.
   */
  agentWorkflowsDir: string;
  /** Override the artifact directory; when set, recovery.md is written here. */
  artifactRunDir?: string;
  /** Repo path stamped into recovery.md; defaults to unset. */
  repoPath?: string | null;
  now?: number;
};

export type PersistLiveWorkflowDispatchRecoveryInput = {
  runId: string;
  stepId: string | null;
  dispatchCode: string;
  liveRecoveryCode?: string;
  error: string;
  executorLogPath?: string;
  resultJsonPath?: string;
  agentWorkflowsDir: string;
  artifactRunDir?: string;
  repoPath?: string | null;
  now?: number;
};

export type PersistLiveWorkflowFinalizeRecoveryResult =
  | { ok: true; outcome: "no_recovery_required"; runId: string }
  | {
      ok: true;
      outcome: "recovered";
      runId: string;
      recoveryCode: WorkflowLiveRunRecoveryCode;
      reason: string;
      stepId: string | null;
      previouslyMarked: boolean;
      artifactPath: string;
      markedAt: number;
    }
  | {
      ok: true;
      outcome: "artifact_write_failed";
      runId: string;
      recoveryCode: WorkflowLiveRunRecoveryCode;
      reason: string;
      stepId: string | null;
      previouslyMarked: boolean;
      artifactPath: null;
      artifactWriteError: {
        code: "recovery_artifact_write_failed";
        message: string;
      };
      markedAt: number;
    }
  | {
      ok: false;
      reason: "run_not_found";
      message: string;
    };

type LiveFinalizeRecovery = {
  code: WorkflowLiveRunRecoveryCode;
  reason: string;
  evidencePointers: readonly WorkflowRecoveryEvidencePointer[];
  nextAction: WorkflowRecoveryNextAction;
};

/**
 * Durably enter manual recovery from a live verification / commit transaction
 * outcome. See the module doc for the ordered contract.
 */
export function persistLiveWorkflowFinalizeRecovery(
  db: MomentumDb,
  input: PersistLiveWorkflowFinalizeRecoveryInput
): PersistLiveWorkflowFinalizeRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("persistLiveWorkflowFinalizeRecovery: runId is required");
  }
  if (
    typeof input.agentWorkflowsDir !== "string" ||
    input.agentWorkflowsDir.length === 0
  ) {
    throw new Error(
      "persistLiveWorkflowFinalizeRecovery: agentWorkflowsDir is required"
    );
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("persistLiveWorkflowFinalizeRecovery: now must be finite");
  }

  const recovery = classifyFinalizeRecovery(input.finalize, input.stepId);
  if (recovery === null) {
    return { ok: true, outcome: "no_recovery_required", runId: input.runId };
  }

  return persistLiveWorkflowRecovery(db, {
    runId: input.runId,
    stepId: input.stepId,
    recovery,
    agentWorkflowsDir: input.agentWorkflowsDir,
    ...(input.artifactRunDir !== undefined
      ? { artifactRunDir: input.artifactRunDir }
      : {}),
    ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
    now
  });
}

export function persistLiveWorkflowDispatchRecovery(
  db: MomentumDb,
  input: PersistLiveWorkflowDispatchRecoveryInput
): PersistLiveWorkflowFinalizeRecoveryResult {
  return persistLiveWorkflowRecovery(db, {
    runId: input.runId,
    stepId: input.stepId,
    recovery: classifyDispatchRecovery(input),
    agentWorkflowsDir: input.agentWorkflowsDir,
    ...(input.artifactRunDir !== undefined
      ? { artifactRunDir: input.artifactRunDir }
      : {}),
    ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
    ...(input.now !== undefined ? { now: input.now } : {})
  });
}

function persistLiveWorkflowRecovery(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string | null;
    recovery: LiveFinalizeRecovery;
    agentWorkflowsDir: string;
    artifactRunDir?: string;
    repoPath?: string | null;
    now?: number;
  }
): PersistLiveWorkflowFinalizeRecoveryResult {
  const now = input.now ?? Date.now();

  const marked = markWorkflowRunNeedsManualRecovery(db, {
    runId: input.runId,
    reason: input.recovery.reason,
    now
  });
  if (!marked.ok) {
    return {
      ok: false,
      reason: "run_not_found",
      message: `Workflow run ${input.runId} does not exist.`
    };
  }

  const artifactInput: WorkflowRecoveryArtifactInput = {
    runId: input.runId,
    stepId: input.stepId,
    classification: input.recovery.code,
    reason: input.recovery.reason,
    recommendedNextAction: input.recovery.nextAction,
    evidencePointers: input.recovery.evidencePointers,
    repoPath: input.repoPath !== undefined ? input.repoPath : null,
    classifiedAt: now
  };

  let written: { path: string };
  try {
    written =
      input.artifactRunDir === undefined
        ? writeWorkflowRecoveryArtifact({
            agentWorkflowsDir: input.agentWorkflowsDir,
            input: artifactInput
          })
        : writeWorkflowRecoveryArtifactInRunDir({
            runDir: input.artifactRunDir,
            input: artifactInput
          });
  } catch (err) {
    return {
      ok: true,
      outcome: "artifact_write_failed",
      runId: input.runId,
      recoveryCode: input.recovery.code,
      reason: input.recovery.reason,
      stepId: input.stepId,
      previouslyMarked: marked.previouslyMarked,
      artifactPath: null,
      artifactWriteError: {
        code: "recovery_artifact_write_failed",
        message: describeError(err)
      },
      markedAt: now
    };
  }

  return {
    ok: true,
    outcome: "recovered",
    runId: input.runId,
    recoveryCode: input.recovery.code,
    reason: input.recovery.reason,
    stepId: input.stepId,
    previouslyMarked: marked.previouslyMarked,
    artifactPath: written.path,
    markedAt: now
  };
}

/**
 * Map a finalize outcome into the live run-level recovery classification, reason
 * and bounded evidence to persist, or `null` when the outcome is clean and needs
 * no run-level recovery. Only structured, bounded fields (HEAD SHAs, the result
 * file path) flow into evidence — never runner stdout, transcripts, or secrets.
 */
function classifyFinalizeRecovery(
  finalize: FinalizeLiveWorkflowStepFromResultFileResult,
  stepId: string | null
): LiveFinalizeRecovery | null {
  switch (finalize.outcome) {
    case "manual_recovery_required":
      return {
        code: finalize.recoveryCode,
        reason: finalize.reason,
        evidencePointers: [
          { label: "expected-head", ref: finalize.expectedHead },
          { label: "current-head", ref: finalize.currentHead }
        ],
        nextAction: {
          code: "investigate_head_mismatch",
          detail:
            "HEAD moved off the recorded base during the live step. Momentum refused a destructive reset; inspect the unexpected commit and decide manually whether to keep, amend, or roll it back before clearing recovery.",
          stepId
        }
      };
    case "result_missing":
      return {
        code: "result_missing",
        reason: finalize.error,
        evidencePointers: [
          { label: "result-file", ref: finalize.resultFilePath }
        ],
        nextAction: {
          code: "investigate_result_missing",
          detail:
            "The live step's normalized result document was not written, so its true outcome is unknown. Momentum did not commit or reset; inspect the executor log before retrying or canceling.",
          stepId
        }
      };
    case "result_invalid":
      return {
        code: "result_invalid",
        reason: finalize.error,
        evidencePointers: [
          { label: "result-file", ref: finalize.resultFilePath }
        ],
        nextAction: {
          code: "investigate_result_invalid",
          detail:
            "The live step's result document is malformed and cannot be trusted. Momentum did not commit or reset; inspect the executor log before retrying or canceling.",
          stepId
        }
      };
    case "reset_failed":
      return {
        code: "reset_failed",
        reason: finalize.reset.error,
        evidencePointers: [],
        nextAction: {
          code: "investigate_reset_failed",
          detail:
            "The live step finalization could not restore the recorded base. Inspect and clean up the worktree manually before clearing recovery.",
          stepId
        }
      };
    case "repo_lock_lost":
      return {
        code: "repo_lock_lost",
        reason: finalize.error,
        evidencePointers: [],
        nextAction: {
          code: "investigate_repo_lock_lost",
          detail:
            "Momentum lost the active repo lock during live step finalization. Confirm repository ownership and worktree state before clearing recovery.",
          stepId
        }
      };
    case "git_failed":
      return {
        code: "git_failed",
        reason: finalize.error,
        evidencePointers: [],
        nextAction: {
          code: "investigate_git_failed",
          detail:
            "The live step finalization could not inspect or mutate git reliably. Inspect the repository and worktree manually before clearing recovery.",
          stepId
        }
      };
    case "invalid_input":
      return {
        code: "invalid_input",
        reason: finalize.error,
        evidencePointers: [],
        nextAction: {
          code: "investigate_invalid_input",
          detail:
            "The live step finalization refused to commit or reset because its inputs were invalid. Inspect the run directory and worktree manually before clearing recovery.",
          stepId
        }
      };
    case "commit_failed":
      return classifyCommitFailedRecovery(finalize, stepId);
    default:
      return null;
  }
}

function classifyCommitFailedRecovery(
  finalize: Extract<
    FinalizeLiveWorkflowStepFromResultFileResult,
    { outcome: "commit_failed" }
  >,
  stepId: string | null
): LiveFinalizeRecovery | null {
  if (finalize.reset !== undefined) {
    if (finalize.reset.ok) return null;
    return {
      code: "reset_failed",
      reason: finalize.reset.error,
      evidencePointers: [],
      nextAction: {
        code: "investigate_reset_failed",
        detail:
          "The live step finalization could not clean up after a commit failure. Inspect and clean up the worktree manually before clearing recovery.",
        stepId
      }
    };
  }
  if (finalize.commit.code === "nothing_to_commit") return null;
  return {
    code: "commit_failed",
    reason: finalize.commit.error,
    evidencePointers: [],
    nextAction: {
      code: "investigate_commit_failed",
      detail:
        "The live step finalization could not create the accepted Momentum commit and did not prove cleanup. Inspect the worktree manually before clearing recovery.",
      stepId
    }
  };
}

const LIVE_RUN_RECOVERY_CODE_SET: ReadonlySet<string> = new Set(
  WORKFLOW_LIVE_RUN_RECOVERY_CODES
);

function classifyDispatchRecovery(
  input: PersistLiveWorkflowDispatchRecoveryInput
): LiveFinalizeRecovery {
  const code = selectDispatchRecoveryCode(input);
  const evidencePointers: WorkflowRecoveryEvidencePointer[] = [];
  if (input.executorLogPath !== undefined) {
    evidencePointers.push({ label: "executor-log", ref: input.executorLogPath });
  }
  if (input.resultJsonPath !== undefined) {
    evidencePointers.push({ label: "result-file", ref: input.resultJsonPath });
  }
  return {
    code,
    reason: input.error,
    evidencePointers,
    nextAction: {
      code: `investigate_${code}`,
      detail:
        "The live step reported a process-level dispatch failure after execution started. Inspect the executor log and worktree before retrying, canceling, or clearing recovery.",
      stepId: input.stepId
    }
  };
}

function selectDispatchRecoveryCode(
  input: PersistLiveWorkflowDispatchRecoveryInput
): WorkflowLiveRunRecoveryCode {
  if (isLiveRunRecoveryCode(input.liveRecoveryCode)) {
    return input.liveRecoveryCode;
  }
  if (isLiveRunRecoveryCode(input.dispatchCode)) {
    return input.dispatchCode;
  }
  return "command_failed";
}

function isLiveRunRecoveryCode(
  value: string | undefined
): value is WorkflowLiveRunRecoveryCode {
  return value !== undefined && LIVE_RUN_RECOVERY_CODE_SET.has(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
