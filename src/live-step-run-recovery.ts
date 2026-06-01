/**
 * Run-level durable recovery for the live verification / commit transaction
 * (NGX-334, M9-03).
 *
 * `finalize-live-step.ts` is a pure transaction over git + verification: it
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
 * Three finalize outcomes map to durable recovery, each carrying a distinct,
 * non-collapsed live recovery code (the contract forbids generic failure text):
 *
 *   - `manual_recovery_required` -> `head_mismatch`: the live step left HEAD off
 *     the recorded base. A non-Momentum commit must be preserved, not reset.
 *   - `result_missing` -> `result_missing`: the step's normalized result
 *     document was never written; the true outcome is unknown.
 *   - `result_invalid` -> `result_invalid`: the result document is malformed;
 *     the outcome cannot be trusted.
 *
 * Every other finalize outcome is a clean terminal transaction result —
 * `committed`, or a `reset_step_failure` / `reset_verification_failure` where
 * the worktree was already safely reset — and needs no run-level recovery, so
 * this seam reports `no_recovery_required` without touching the durable flag.
 * (Finalize's own programmer-error / git-error outcomes such as `invalid_input`,
 * `git_failed`, `reset_failed`, and `commit_failed` are surfaced to the caller
 * by the finalize layer and are out of scope for this M9-03 recovery seam; they
 * are handled by the broader run loop in a later slice.)
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

  // Durable flag first: it is the authority that blocks unsafe progression, so
  // it must land even if the best-effort artifact write below fails.
  const marked = markWorkflowRunNeedsManualRecovery(db, {
    runId: input.runId,
    reason: recovery.reason,
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
    classification: recovery.code,
    reason: recovery.reason,
    recommendedNextAction: recovery.nextAction,
    evidencePointers: recovery.evidencePointers,
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
      recoveryCode: recovery.code,
      reason: recovery.reason,
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
    recoveryCode: recovery.code,
    reason: recovery.reason,
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
    default:
      return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
