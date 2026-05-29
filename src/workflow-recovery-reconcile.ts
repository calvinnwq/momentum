/**
 * Auto-set wiring for the run-scoped manual-recovery flag + artifact
 * (NGX-327, M8-04).
 *
 * The symmetric sibling of {@link ./workflow-run-recovery.ts}'s
 * `clearWorkflowRunManualRecoveryGuarded`: where the guarded clear re-derives
 * the M7 monitor state and *clears* the durable `needs_manual_recovery` flag
 * only when no blocking condition remains, this reconcile re-derives the same
 * monitor state and *sets* the durable flag (and renders the per-run
 * `recovery.md` artifact) when `deriveWorkflowMonitorState` classifies a
 * blocking recovery code (`manual_recovery_lease` / `ghost_active_no_lease` /
 * `stale_running_step` / `failed_required_step`).
 *
 * This is a composition seam, not new policy. The monitor reducer stays the
 * single source of truth for the recovery code, message, and recommended next
 * action; {@link markWorkflowRunNeedsManualRecovery} owns the durable column;
 * and {@link writeWorkflowRecoveryArtifact} owns artifact generation. Two
 * deliberate invariants:
 *
 * - Reconcile only ever *sets*. It never clears, even when the substrate no
 *   longer shows a blocking condition — clearing stays explicit and operator-
 *   driven per the NGX-327 safety contract ("Do not auto-clear recovery from
 *   elapsed time alone"). An already-flagged run with a now-resolved substrate
 *   is reported `no_recovery_required` with the durable flag left untouched.
 * - The advisory-only `monitor_drift_stale` code never triggers a set: it is a
 *   non-blocking drift between a stale snapshot and the substrate, so it must
 *   not raise the operator block. The same `isBlockingWorkflowRecoveryCode`
 *   predicate the guarded clear consults gates the set here.
 *
 * The durable flag is written *before* the filesystem artifact: the flag is the
 * authority that blocks unsafe progression (a deleted `recovery.md` cannot
 * silently re-open transitions), so preferring blocking over guessing means the
 * block lands even if the best-effort artifact write later fails. recovery.md
 * is overwritten on every reconcile so it always reflects the latest
 * classification.
 */

import type { MomentumDb } from "./db.js";
import {
  loadWorkflowRunDetail,
  type WorkflowRunDetail
} from "./workflow-status.js";
import {
  isBlockingWorkflowRecoveryCode,
  markWorkflowRunNeedsManualRecovery
} from "./workflow-run-recovery.js";
import {
  buildWorkflowRecoveryArtifactInput,
  writeWorkflowRecoveryArtifact,
  type WorkflowRecoveryEvidencePointer
} from "./workflow-recovery-artifact.js";
import type { WorkflowMonitorRecoveryCode } from "./workflow-monitor-state.js";

export type ReconcileWorkflowRunManualRecoveryInput = {
  runId: string;
  /**
   * Directory under which the run-scoped `recovery.md` artifact is rendered:
   * `<agentWorkflowsDir>/<runId>/recovery.md`. Required because the artifact is
   * the operator-facing half of the set; a set without a written artifact would
   * leave a blocked run with no rendered explanation.
   */
  agentWorkflowsDir: string;
  now?: number;
  /** Lease-freshness grace window forwarded to the monitor re-derivation. */
  graceMs?: number;
  /** Running-step checkpoint staleness window forwarded to the re-derivation. */
  checkpointStaleMs?: number;
  /**
   * Override the repo path stamped into `recovery.md`. Defaults to the durable
   * run row's repo path. Pass `null` to render it unset explicitly.
   */
  repoPath?: string | null;
};

export type ReconcileWorkflowRunManualRecoveryResult =
  | {
      ok: true;
      outcome: "no_recovery_required";
      runId: string;
    }
  | {
      ok: true;
      outcome: "marked";
      runId: string;
      recoveryCode: WorkflowMonitorRecoveryCode;
      stepId: string | null;
      reason: string;
      previouslyMarked: boolean;
      artifactPath: string;
      markedAt: number;
    }
  | {
      ok: true;
      outcome: "artifact_write_failed";
      runId: string;
      recoveryCode: WorkflowMonitorRecoveryCode;
      stepId: string | null;
      reason: string;
      previouslyMarked: boolean;
      artifactPath: string | null;
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

/**
 * Re-derive the M7 monitor state for a run and, when it classifies a blocking
 * recovery code, set the durable `needs_manual_recovery` flag (reason sourced
 * from the monitor recovery message) and render the run-scoped `recovery.md`.
 * Returns `no_recovery_required` when no blocking condition is present —
 * without clearing any existing flag — and `run_not_found` when the run is
 * missing.
 */
export function reconcileWorkflowRunManualRecovery(
  db: MomentumDb,
  input: ReconcileWorkflowRunManualRecoveryInput
): ReconcileWorkflowRunManualRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("reconcileWorkflowRunManualRecovery: runId is required");
  }
  if (
    typeof input.agentWorkflowsDir !== "string" ||
    input.agentWorkflowsDir.length === 0
  ) {
    throw new Error(
      "reconcileWorkflowRunManualRecovery: agentWorkflowsDir is required"
    );
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("reconcileWorkflowRunManualRecovery: now must be finite");
  }

  const detailOptions: {
    now: number;
    graceMs?: number;
    checkpointStaleMs?: number;
  } = { now };
  if (input.graceMs !== undefined) detailOptions.graceMs = input.graceMs;
  if (input.checkpointStaleMs !== undefined) {
    detailOptions.checkpointStaleMs = input.checkpointStaleMs;
  }

  const detail = loadWorkflowRunDetail(db, input.runId, detailOptions);
  if (!detail) {
    return {
      ok: false,
      reason: "run_not_found",
      message: `Workflow run ${input.runId} does not exist.`
    };
  }

  const recovery = detail.monitor.recovery;
  if (recovery === null || !isBlockingWorkflowRecoveryCode(recovery.code)) {
    return { ok: true, outcome: "no_recovery_required", runId: input.runId };
  }

  // Durable flag first: it is the authority that blocks unsafe progression, so
  // it must land even if the best-effort artifact write below fails.
  const marked = markWorkflowRunNeedsManualRecovery(db, {
    runId: input.runId,
    reason: recovery.message,
    now
  });
  if (!marked.ok) {
    return {
      ok: false,
      reason: "run_not_found",
      message: `Workflow run ${input.runId} disappeared during reconcile.`
    };
  }

  const artifactInput = buildWorkflowRecoveryArtifactInput({
    runId: input.runId,
    repoPath:
      input.repoPath !== undefined ? input.repoPath : detail.run.repoPath,
    recovery,
    nextAction: detail.monitor.nextAction,
    evidencePointers: evidencePointersFromDetail(detail),
    classifiedAt: now
  });
  let written: { path: string };
  try {
    written = writeWorkflowRecoveryArtifact({
      agentWorkflowsDir: input.agentWorkflowsDir,
      input: artifactInput
    });
  } catch (err) {
    return {
      ok: true,
      outcome: "artifact_write_failed",
      runId: input.runId,
      recoveryCode: recovery.code,
      stepId: recovery.stepId,
      reason: recovery.message,
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
    outcome: "marked",
    runId: input.runId,
    recoveryCode: recovery.code,
    stepId: recovery.stepId,
    reason: recovery.message,
    previouslyMarked: marked.previouslyMarked,
    artifactPath: written.path,
    markedAt: now
  };
}

/**
 * Map the run's best-effort evidence links into bounded artifact pointers. Only
 * source, type, and an artifact-path / record-id reference flow through — never
 * raw summaries, transcripts, or secrets — keeping the rendered artifact within
 * the NGX-327 no-secrets contract.
 */
function evidencePointersFromDetail(
  detail: WorkflowRunDetail
): WorkflowRecoveryEvidencePointer[] {
  return detail.evidence.map((link) => ({
    label: `${link.source}/${link.type}`,
    ref: link.artifactPath ?? link.evidenceRecordId
  }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
