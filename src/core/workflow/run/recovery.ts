/**
 * Durable run-scoped manual-recovery flag.
 *
 * The run-scoped sibling of {@link ./goal-recovery.ts}'s goal-scoped flag. It
 * owns the durable `workflow_runs.needs_manual_recovery` /
 * `manual_recovery_reason` / `manual_recovery_at` columns so the operator-control
 * surfaces (`workflow run approve` / `update-step`) keep a single source of
 * truth for "this run is blocked until an operator clears it" that does not
 * depend on the filesystem `recovery.md` artifact — a deleted artifact cannot
 * silently re-open transitions, and the in-memory monitor advisory is not the
 * authority.
 *
 * This module owns the mark/clear/get primitives plus the guarded operator
 * clear ({@link clearWorkflowRunManualRecoveryGuarded}). The guarded clear
 * re-derives workflow-run monitor blockers before clearing and refuses with
 * `recovery_clear_refused` while one persists. live dispatch / finalization
 * can also mark the same flag with non-monitor classifications, so guarded
 * clear cannot independently prove that recovery work is complete; operators
 * must resolve the stored reason and any rendered artifact or context before
 * clearing. The executor-loop scheduler lane also marks the flag for stale workflow-lease
 * recovery, but stale `manual-recovery-required` leases remain durable and can
 * still be re-derived as `manual_recovery_lease` blockers until resolved.
 */

import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../../adapters/db.js";
import { releaseRepoLock } from "../../repo/locks.js";
import { prepareRetryableDispatchedStepForRecoveryClear } from "../dispatch/retry.js";
import { appendWorkflowEvent, buildWorkflowEventId } from "./events.js";
import { loadWorkflowRunDetail } from "./status.js";
import type { WorkflowMonitorRecoveryCode } from "../monitor/state.js";
import { refreshWorkflowRunRuntimeState } from "./runtime-state.js";
import {
  isExternalSideEffectTailStepKind,
  type WorkflowStepKind,
} from "./reducer.js";
import {
  classifyNoMistakesDeterministicEvidence,
  type NoMistakesEvidenceExpectedIdentity,
} from "../recovery/no-mistakes-evidence.js";

export type MarkWorkflowRunNeedsManualRecoveryInput = {
  runId: string;
  reason: string;
  now?: number;
};

export type MarkWorkflowRunNeedsManualRecoveryResult =
  | { ok: true; previouslyMarked: boolean }
  | { ok: false; reason: "run_not_found" };

/**
 * Mark a workflow run as needing manual recovery so operator transitions refuse
 * with `manual_recovery_required` until an explicit clear. Idempotent:
 * re-marking refreshes the reason and timestamp but leaves the flag set and
 * reports `previouslyMarked: true`.
 */
export function markWorkflowRunNeedsManualRecovery(
  db: MomentumDb,
  input: MarkWorkflowRunNeedsManualRecoveryInput,
): MarkWorkflowRunNeedsManualRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("markWorkflowRunNeedsManualRecovery: runId is required");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("markWorkflowRunNeedsManualRecovery: reason is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("markWorkflowRunNeedsManualRecovery: now must be finite");
  }

  const before = db
    .prepare(
      `SELECT needs_manual_recovery, manual_recovery_reason, manual_recovery_at
         FROM workflow_runs WHERE id = ?`,
    )
    .get(input.runId) as
    | {
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
        manual_recovery_at: number | null;
      }
    | undefined;
  if (!before) {
    return { ok: false, reason: "run_not_found" };
  }

  db.prepare(
    `UPDATE workflow_runs
       SET needs_manual_recovery = 1,
           manual_recovery_reason = ?,
           manual_recovery_at = ?,
           updated_at = ?
     WHERE id = ?`,
  ).run(input.reason, now, now, input.runId);

  if (
    before.needs_manual_recovery !== 1 ||
    before.manual_recovery_reason !== input.reason
  ) {
    appendWorkflowEvent(db, {
      runId: input.runId,
      type: "recovery_required",
      occurredAt: now,
      payload: {
        reason: input.reason,
        previousReason: before.manual_recovery_reason,
        previousMarkedAt: before.manual_recovery_at,
      },
    });
  }

  return { ok: true, previouslyMarked: before.needs_manual_recovery === 1 };
}

export type ClearWorkflowRunManualRecoveryInput = {
  runId: string;
  now?: number;
};

export type ClearWorkflowRunManualRecoveryResult =
  { ok: true; wasMarked: boolean } | { ok: false; reason: "run_not_found" };

/**
 * Clear the durable manual-recovery flag so operator transitions are eligible
 * again. This is the low-level primitive: it does NOT re-derive monitor state
 * or guard against a persisting blocking condition — the guarded operator clear
 * layered on top owns that check. Any rendered recovery.md is intentionally
 * left on disk as durable audit; operators remove it after capturing the
 * context elsewhere.
 */
export function clearWorkflowRunManualRecovery(
  db: MomentumDb,
  input: ClearWorkflowRunManualRecoveryInput,
): ClearWorkflowRunManualRecoveryResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("clearWorkflowRunManualRecovery: runId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("clearWorkflowRunManualRecovery: now must be finite");
  }

  const before = db
    .prepare(
      `SELECT needs_manual_recovery, manual_recovery_reason, manual_recovery_at
         FROM workflow_runs WHERE id = ?`,
    )
    .get(input.runId) as
    | {
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
        manual_recovery_at: number | null;
      }
    | undefined;
  if (!before) {
    return { ok: false, reason: "run_not_found" };
  }

  db.prepare(
    `UPDATE workflow_runs
       SET needs_manual_recovery = 0,
           manual_recovery_reason = NULL,
           manual_recovery_at = NULL,
           updated_at = ?
     WHERE id = ?`,
  ).run(now, input.runId);

  if (before.needs_manual_recovery === 1) {
    appendWorkflowEvent(db, {
      runId: input.runId,
      type: "recovery_cleared",
      occurredAt: now,
      payload: {
        previousReason: before.manual_recovery_reason,
        previousMarkedAt: before.manual_recovery_at,
      },
    });
  }

  return { ok: true, wasMarked: before.needs_manual_recovery === 1 };
}

export type WorkflowRunManualRecoveryState = {
  runId: string;
  needsManualRecovery: boolean;
  reason: string | null;
  markedAt: number | null;
};

/**
 * Read the durable run-scoped recovery state, or `undefined` when the run does
 * not exist. The single source of truth the CLI surfaces and the guarded clear
 * consult before deciding whether a run is blocked.
 */
export function getWorkflowRunManualRecoveryState(
  db: MomentumDb,
  runId: string,
): WorkflowRunManualRecoveryState | undefined {
  const row = db
    .prepare(
      `SELECT id, needs_manual_recovery, manual_recovery_reason, manual_recovery_at
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
        manual_recovery_at: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    runId: row.id,
    needsManualRecovery: row.needs_manual_recovery === 1,
    reason: row.manual_recovery_reason,
    markedAt: row.manual_recovery_at,
  };
}

/**
 * The monitor-reducer recovery codes that represent a hard blocking condition:
 * a manual-recovery lease holding the run blocked, a ghost / stale running step
 * with no live evidence, or a failed required step (including the external-side-
 * effect tail-step variant that still needs operator reconciliation before the
 * run can be cleared). While any of these is still classified by
 * `deriveWorkflowMonitorState`, clearing the durable flag would re-open
 * transitions that make recovery worse, so the guarded clear refuses.
 *
 * `monitor_drift_stale` is deliberately excluded: it is an advisory drift
 * between a (possibly stale) monitor snapshot and the substrate, not a hard
 * block — the substrate itself shows the run progressing — so it never on its
 * own keeps a run from being cleared once an operator has resolved the cause.
 */
export const BLOCKING_WORKFLOW_RECOVERY_CODES: ReadonlySet<WorkflowMonitorRecoveryCode> =
  new Set<WorkflowMonitorRecoveryCode>([
    "manual_recovery_lease",
    "ghost_active_no_lease",
    "stale_running_step",
    "failed_required_step",
    "failed_external_side_effect_step",
  ]);

export function isBlockingWorkflowRecoveryCode(
  code: WorkflowMonitorRecoveryCode,
): boolean {
  return BLOCKING_WORKFLOW_RECOVERY_CODES.has(code);
}

export type ClearWorkflowRunManualRecoveryGuardedInput = {
  runId: string;
  now?: number;
  /** Evidence that a failed external-side-effect tail step landed externally. */
  externalSideEffectEvidencePointer?: string;
  /** Optional ledger pointer stored with external-side-effect reconciliation. */
  externalSideEffectLedgerPointer?: string;
  /** Legacy checks-passed proof or readable deterministic evidence pointer. */
  successfulNoMistakesEvidencePointer?: string;
  /** Parsed deterministic no-mistakes evidence, usually loaded from a pointer. */
  successfulNoMistakesEvidence?: unknown;
  /** Optional ledger pointer stored with interrupted no-mistakes reconciliation. */
  successfulNoMistakesLedgerPointer?: string;
  /** Lease-freshness grace window forwarded to the monitor re-derivation. */
  graceMs?: number;
  /** Running-step checkpoint staleness window forwarded to the re-derivation. */
  checkpointStaleMs?: number;
};

export type ClearWorkflowRunManualRecoveryGuardedFailureReason =
  "run_not_found" | "not_flagged" | "recovery_clear_refused";

export type ClearWorkflowRunManualRecoveryGuardedResult =
  | {
      ok: true;
      runId: string;
      previousReason: string | null;
      previousMarkedAt: number | null;
      clearedAt: number;
      retryPrepared?: {
        stepId: string;
        recoveryCode: string;
      };
      reconciledStep?: {
        stepId: string;
        recoveryCode:
          | "failed_external_side_effect_step"
          | "interrupted_no_mistakes_checks_passed";
        state: "succeeded";
        evidencePointer: string;
        ledgerPointer: string | null;
      };
    }
  | {
      ok: false;
      reason: ClearWorkflowRunManualRecoveryGuardedFailureReason;
      message: string;
      recoveryCode?: WorkflowMonitorRecoveryCode;
      blockingStepId?: string | null;
    };

/**
 * Operator-facing guarded clear: the explicit, auditable path that re-derives
 * the workflow-run monitor state and only clears the durable manual-recovery flag when no
 * monitor-derived blocking condition remains. Refuses safely when the run is
 * missing (`run_not_found`), unflagged without evidence-backed external-tail
 * or interrupted no-mistakes reconciliation (`not_flagged`), or still
 * classified with a blocking monitor recovery code (`recovery_clear_refused`).
 * Live dispatch / finalization recovery uses the same flag but has no monitor
 * blocker to re-derive here, so clearing those entries is an operator assertion
 * that the captured reason and any rendered artifact or context have been
 * resolved. Scheduler-lane `manual-recovery-required` lease recovery also uses
 * the same flag, but leaves the stale lease durable as evidence; that lease can
 * still re-derive `manual_recovery_lease` and refuse guarded clear until the
 * lease condition is resolved. The check and the clear run inside a single
 * immediate transaction so the condition that is checked is the condition that
 * is cleared.
 *
 * Any rendered recovery.md is intentionally left on disk as durable audit;
 * operators delete it after capturing the context elsewhere, mirroring the stale-recovery
 * goal-scoped clear.
 */
export function clearWorkflowRunManualRecoveryGuarded(
  db: MomentumDb,
  input: ClearWorkflowRunManualRecoveryGuardedInput,
): ClearWorkflowRunManualRecoveryGuardedResult {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("clearWorkflowRunManualRecoveryGuarded: runId is required");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error(
      "clearWorkflowRunManualRecoveryGuarded: now must be finite",
    );
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

  db.exec("BEGIN IMMEDIATE");
  try {
    const detail = loadWorkflowRunDetail(db, input.runId, detailOptions);
    if (!detail) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        message: `Workflow run ${input.runId} does not exist.`,
      };
    }
    const wasMarked = detail.run.needsManualRecovery;

    const preparedRetry = wasMarked
      ? prepareRetryableDispatchedStepForRecoveryClear(db, {
          runId: input.runId,
          now,
        })
      : { prepared: false as const };
    let recoveryDetail =
      preparedRetry.prepared || !wasMarked
        ? loadWorkflowRunDetail(db, input.runId, detailOptions)
        : detail;
    if (!recoveryDetail) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        message: `Workflow run ${input.runId} disappeared during retry preparation.`,
      };
    }

    let reconciledStep:
      | {
          stepId: string;
          recoveryCode:
            | "failed_external_side_effect_step"
            | "interrupted_no_mistakes_checks_passed";
          state: "succeeded";
          evidencePointer: string;
          ledgerPointer: string | null;
        }
      | undefined;
    const recoveryBeforeClear = recoveryDetail.monitor.recovery;
    if (
      recoveryBeforeClear?.code === "failed_external_side_effect_step" &&
      recoveryBeforeClear.stepId !== null
    ) {
      const evidencePointer = input.externalSideEffectEvidencePointer?.trim();
      if (!evidencePointer) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason: "recovery_clear_refused",
          message:
            `Workflow run ${input.runId} still has a failed external-side-effect tail step ` +
            `(${recoveryBeforeClear.stepId}); pass --evidence-pointer after verifying external state before clearing manual recovery.`,
          recoveryCode: recoveryBeforeClear.code,
          blockingStepId: recoveryBeforeClear.stepId,
        };
      }
      reconciledStep = reconcileExternalSideEffectTailStepForRecoveryClear(db, {
        runId: input.runId,
        stepId: recoveryBeforeClear.stepId,
        now,
        evidencePointer,
        ledgerPointer: input.externalSideEffectLedgerPointer ?? null,
      });
      recoveryDetail = loadWorkflowRunDetail(db, input.runId, detailOptions);
      if (!recoveryDetail) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason: "run_not_found",
          message: `Workflow run ${input.runId} disappeared during external-side-effect reconciliation.`,
        };
      }
    }

    if (
      recoveryBeforeClear?.code === "failed_required_step" &&
      recoveryBeforeClear.stepId !== null
    ) {
      const evidencePointer = input.successfulNoMistakesEvidencePointer?.trim();
      if (evidencePointer !== undefined && evidencePointer.length > 0) {
        reconciledStep = reconcileInterruptedNoMistakesStepForRecoveryClear(
          db,
          {
            runId: input.runId,
            stepId: recoveryBeforeClear.stepId,
            now,
            evidencePointer,
            successfulNoMistakesEvidence: input.successfulNoMistakesEvidence,
            ledgerPointer: input.successfulNoMistakesLedgerPointer ?? null,
          },
        );
        if (reconciledStep === undefined) {
          db.exec("ROLLBACK");
          return {
            ok: false,
            reason: "recovery_clear_refused",
            message:
              `Workflow run ${input.runId} cannot reconcile failed step ` +
              `${recoveryBeforeClear.stepId} from no-mistakes evidence. The step must be a failed required no-mistakes step and the evidence pointer must prove checks-passed.`,
            recoveryCode: recoveryBeforeClear.code,
            blockingStepId: recoveryBeforeClear.stepId,
          };
        }
        recoveryDetail = loadWorkflowRunDetail(db, input.runId, detailOptions);
        if (!recoveryDetail) {
          db.exec("ROLLBACK");
          return {
            ok: false,
            reason: "run_not_found",
            message: `Workflow run ${input.runId} disappeared during no-mistakes reconciliation.`,
          };
        }
      }
    }

    if (!wasMarked && reconciledStep === undefined) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "not_flagged",
        message: `Workflow run ${input.runId} is not flagged for manual recovery; nothing to clear.`,
      };
    }

    const recovery = recoveryDetail.monitor.recovery;
    if (recovery !== null && isBlockingWorkflowRecoveryCode(recovery.code)) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "recovery_clear_refused",
        message:
          `Workflow run ${input.runId} still has a blocking recovery condition ` +
          `(${recovery.code}); resolve it before clearing manual recovery.`,
        recoveryCode: recovery.code,
        blockingStepId: recovery.stepId,
      };
    }

    if (preparedRetry.prepared) {
      const manualLocks = db
        .prepare(
          `SELECT id FROM repo_locks
            WHERE goal_id = ?
              AND job_id = ?
              AND iteration = ?
              AND state = 'needs_manual_recovery'
            ORDER BY acquired_at, id`,
        )
        .all(
          input.runId,
          preparedRetry.invocationId,
          preparedRetry.attempt,
        ) as Array<{ id: string }>;
      for (const lock of manualLocks) {
        releaseRepoLock(db, {
          lockId: lock.id,
          now,
          recoveryStatus: "workflow_manual_recovery_cleared",
        });
      }
    }

    const previousReason = detail.run.manualRecoveryReason;
    const previousMarkedAt = detail.run.manualRecoveryAt;
    const cleared = clearWorkflowRunManualRecovery(db, {
      runId: input.runId,
      now,
    });
    if (!cleared.ok) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        message: `Workflow run ${input.runId} disappeared during clear.`,
      };
    }
    db.exec("COMMIT");

    return {
      ok: true,
      runId: input.runId,
      previousReason,
      previousMarkedAt,
      clearedAt: now,
      ...(preparedRetry.prepared
        ? {
            retryPrepared: {
              stepId: preparedRetry.stepId,
              recoveryCode: preparedRetry.recoveryCode,
            },
          }
        : {}),
      ...(reconciledStep !== undefined ? { reconciledStep } : {}),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so callers see the original write failure.
    }
    throw error;
  }
}

function reconcileInterruptedNoMistakesStepForRecoveryClear(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    now: number;
    evidencePointer: string;
    successfulNoMistakesEvidence?: unknown;
    ledgerPointer: string | null;
  },
):
  | {
      stepId: string;
      recoveryCode: "interrupted_no_mistakes_checks_passed";
      state: "succeeded";
      evidencePointer: string;
      ledgerPointer: string | null;
    }
  | undefined {
  if (!isNoMistakesChecksPassedEvidencePointer(input.evidencePointer)) {
    const deterministicEvidence =
      input.successfulNoMistakesEvidence ??
      readNoMistakesDeterministicEvidenceFromPointer(
        input.evidencePointer,
        input.ledgerPointer,
      );
    if (deterministicEvidence === undefined) return undefined;
    const expected = loadNoMistakesEvidenceExpectedIdentity(db, {
      runId: input.runId,
      stepId: input.stepId,
    });
    if (expected === undefined) return undefined;
    const classified = classifyNoMistakesDeterministicEvidence(
      deterministicEvidence,
      expected,
    );
    if (!classified.ok) return undefined;
  }

  const row = db
    .prepare(
      `SELECT kind, state, required, step_order, result_digest, error_code,
              error_message, finished_at, updated_at
         FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
    )
    .get(input.runId, input.stepId) as FailedStepBeforeReconcileRow | undefined;
  if (
    row === undefined ||
    row.kind !== "no-mistakes" ||
    row.state !== "failed" ||
    row.required !== 1
  ) {
    return undefined;
  }

  appendFailedStepEventBeforeReconcile(db, {
    runId: input.runId,
    stepId: input.stepId,
    row,
  });

  const updated = db
    .prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded',
              error_code = NULL,
              error_message = NULL,
              result_digest = NULL,
              operator_reason = 'interrupted_no_mistakes_checks_passed',
              operator_actor = 'workflow run clear-recovery',
              operator_evidence_pointer = ?,
              operator_ledger_pointer = ?,
              operator_transition_at = ?,
              finished_at = ?,
              updated_at = ?
        WHERE run_id = ?
          AND step_id = ?
          AND kind = 'no-mistakes'
          AND state = 'failed'`,
    )
    .run(
      input.evidencePointer,
      input.ledgerPointer,
      input.now,
      input.now,
      input.now,
      input.runId,
      input.stepId,
    );
  if (Number(updated.changes) === 0) return undefined;

  const monitorState = refreshWorkflowRunRuntimeState(db, {
    runId: input.runId,
    now: input.now,
  });
  db.prepare(
    "UPDATE workflow_runs SET finished_at = ?, updated_at = ? WHERE id = ?",
  ).run(monitorState.terminal ? input.now : null, input.now, input.runId);

  return {
    stepId: input.stepId,
    recoveryCode: "interrupted_no_mistakes_checks_passed",
    state: "succeeded",
    evidencePointer: input.evidencePointer,
    ledgerPointer: input.ledgerPointer,
  };
}

function isNoMistakesChecksPassedEvidencePointer(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^no-mistakes:[^#\s]+#checks-passed$/.test(normalized);
}

function readNoMistakesDeterministicEvidenceFromPointer(
  evidencePointer: string,
  ledgerPointer: string | null,
): unknown | undefined {
  for (const pointer of [evidencePointer, ledgerPointer]) {
    if (pointer === null) continue;
    const filePath = pointerToReadableEvidencePath(pointer);
    if (filePath === null) continue;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pointerToReadableEvidencePath(pointer: string): string | null {
  const withoutFragment = pointer.trim().split("#", 1)[0] ?? "";
  if (withoutFragment.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutFragment)) return null;
  const candidate = path.resolve(withoutFragment);
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function loadNoMistakesEvidenceExpectedIdentity(
  db: MomentumDb,
  input: { runId: string; stepId: string },
): NoMistakesEvidenceExpectedIdentity | undefined {
  const row = db
    .prepare("SELECT issue_scope_json FROM workflow_runs WHERE id = ?")
    .get(input.runId) as { issue_scope_json: string | null } | undefined;
  if (row === undefined) return undefined;
  const checkpoint = loadCurrentNoMistakesCheckpointIdentity(db, input);
  if (checkpoint === null) return undefined;
  const issueScope = parseIssueScopeIdentifiers(row.issue_scope_json);
  return {
    workflowRunId: input.runId,
    ...(issueScope.length > 0 ? { issueScope } : {}),
    branch: {
      name: checkpoint.branch,
      headSha: checkpoint.headSha,
    },
    ...(checkpoint.pullRequestId !== undefined
      ? {
          pullRequest: {
            id: checkpoint.pullRequestId,
            headSha: checkpoint.headSha,
          },
        }
      : {}),
    noMistakesRunId: checkpoint.noMistakesRunId,
  };
}

type NoMistakesCheckpointIdentity = {
  noMistakesRunId: string;
  branch: string;
  headSha: string;
  pullRequestId?: string;
};

const NO_MISTAKES_CHECKPOINT_SHA_RE = /^[0-9a-f]{40}$/i;

function loadCurrentNoMistakesCheckpointIdentity(
  db: MomentumDb,
  input: { runId: string; stepId: string },
): NoMistakesCheckpointIdentity | null {
  const rows = db
    .prepare(
      `SELECT r.attempt AS attempt, r.round_index AS roundIndex,
              c.stage AS stage, c.detail AS detail, c.sequence AS sequence
         FROM executor_rounds AS r
         JOIN executor_invocations AS i ON i.invocation_id = r.invocation_id
         JOIN executor_checkpoints AS c ON c.round_id = r.round_id
        WHERE r.workflow_run_id = ?
          AND r.step_run_id = ?
          AND r.attempt = i.attempt
          AND r.executor_family IN ('no-mistakes', 'delegate-supervisor')
          AND (
            r.executor_family = 'no-mistakes'
            OR EXISTS (
              SELECT 1
                FROM executor_rounds AS intent_round
                JOIN executor_checkpoints AS intent
                  ON intent.round_id = intent_round.round_id
               WHERE intent_round.invocation_id = r.invocation_id
                 AND intent_round.attempt = r.attempt
                 AND intent.stage = 'delegate_handoff_intent'
                 AND json_extract(
                   CASE WHEN json_valid(intent.detail) THEN intent.detail ELSE '{}'
                   END,
                   '$.tool'
                 ) = 'no-mistakes'
            )
          )
          AND c.stage IN (
            'delegate_external_state_mirrored',
            'delegate_handoff_completed',
            'external_state_mirrored',
            'expected_external_identity'
          )
        ORDER BY r.attempt DESC, r.round_index DESC,
                 CASE c.stage
                   WHEN 'delegate_external_state_mirrored' THEN 0
                   WHEN 'external_state_mirrored' THEN 1
                   WHEN 'delegate_handoff_completed' THEN 2
                   ELSE 3
                 END,
                 c.sequence DESC`,
    )
    .all(input.runId, input.stepId) as {
    attempt: number;
    roundIndex: number;
    stage: string;
    detail: string | null;
    sequence: number;
  }[];
  const current = rows.filter(
    (row) =>
      row.attempt === rows[0]?.attempt &&
      row.roundIndex === rows[0]?.roundIndex,
  );
  const identities = current.flatMap((row) => {
    const identity = parseNoMistakesCheckpointIdentity(row.detail);
    return identity === null ? [] : [identity];
  });
  return (
    identities.find((identity) => identity.pullRequestId !== undefined) ??
    identities[0] ??
    null
  );
}

function parseNoMistakesCheckpointIdentity(
  detail: string | null,
): NoMistakesCheckpointIdentity | null {
  if (detail === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const state = readCheckpointRecord(record, "state");
  const terminalState = readCheckpointRecord(record, "terminalState");
  const terminalValue =
    terminalState === null
      ? null
      : readCheckpointRecord(terminalState, "value");
  const externalIdentity = readCheckpointRecord(record, "externalIdentity");
  const identity = state ?? terminalValue ?? externalIdentity ?? record;
  const noMistakesRunId = readNonBlankCheckpointString(
    identity,
    "externalRunId",
  );
  const branch = readNonBlankCheckpointString(identity, "branch");
  const headSha = readCheckpointSha(identity, "headSha");
  if (noMistakesRunId === null || branch === null || headSha === null) {
    return null;
  }
  const explicitPullRequestId = readNonBlankCheckpointString(
    state ?? terminalValue ?? record,
    "pullRequestId",
  );
  const pullRequestId =
    explicitPullRequestId ??
    pullRequestIdFromCheckpointUrl((state ?? terminalValue ?? record)["prUrl"]);
  return {
    noMistakesRunId,
    branch,
    headSha,
    ...(pullRequestId !== null ? { pullRequestId } : {}),
  };
}

function readCheckpointRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonBlankCheckpointString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function readCheckpointSha(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = readNonBlankCheckpointString(record, key);
  if (value === null || !NO_MISTAKES_CHECKPOINT_SHA_RE.test(value)) return null;
  return value.toLowerCase();
}

function pullRequestIdFromCheckpointUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  try {
    const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
    const pullIndex = parts.indexOf("pull");
    return pullIndex >= 0 ? parts[pullIndex + 1]?.trim() || null : null;
  } catch {
    const match = /(?:^|\/)pull\/([^/#?]+)/.exec(trimmed);
    return match?.[1]?.trim() || null;
  }
}

function parseIssueScopeIdentifiers(value: string | null): string[] {
  if (value === null || value.trim().length === 0) return [];
  try {
    return collectIssueScopeIdentifiers(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function collectIssueScopeIdentifiers(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectIssueScopeIdentifiers(item));
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = ["identifier", "id", "issue", "issueId", "key"].flatMap(
    (key) => (typeof record[key] === "string" ? [record[key] as string] : []),
  );
  return [
    ...direct,
    ...["issues", "identifiers", "issueScope", "scope"].flatMap((key) =>
      collectIssueScopeIdentifiers(record[key]),
    ),
  ];
}

function reconcileExternalSideEffectTailStepForRecoveryClear(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    now: number;
    evidencePointer: string;
    ledgerPointer: string | null;
  },
):
  | {
      stepId: string;
      recoveryCode: "failed_external_side_effect_step";
      state: "succeeded";
      evidencePointer: string;
      ledgerPointer: string | null;
    }
  | undefined {
  const row = db
    .prepare(
      `SELECT kind, state, required, step_order, result_digest, error_code,
              error_message, finished_at, updated_at
         FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
    )
    .get(input.runId, input.stepId) as FailedStepBeforeReconcileRow | undefined;
  if (
    row === undefined ||
    row.state !== "failed" ||
    row.required !== 1 ||
    !isExternalSideEffectTailStepKind(row.kind as WorkflowStepKind)
  ) {
    return undefined;
  }

  appendFailedStepEventBeforeReconcile(db, {
    runId: input.runId,
    stepId: input.stepId,
    row,
  });

  const updated = db
    .prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded',
              error_code = NULL,
              error_message = NULL,
              result_digest = NULL,
              operator_reason = 'failed_external_side_effect_step',
              operator_actor = 'workflow run clear-recovery',
              operator_evidence_pointer = ?,
              operator_ledger_pointer = ?,
              operator_transition_at = ?,
              finished_at = ?,
              updated_at = ?
        WHERE run_id = ?
          AND step_id = ?
          AND state = 'failed'`,
    )
    .run(
      input.evidencePointer,
      input.ledgerPointer,
      input.now,
      input.now,
      input.now,
      input.runId,
      input.stepId,
    );
  if (Number(updated.changes) === 0) return undefined;

  const monitorState = refreshWorkflowRunRuntimeState(db, {
    runId: input.runId,
    now: input.now,
  });
  db.prepare(
    "UPDATE workflow_runs SET finished_at = ?, updated_at = ? WHERE id = ?",
  ).run(monitorState.terminal ? input.now : null, input.now, input.runId);
  return {
    stepId: input.stepId,
    recoveryCode: "failed_external_side_effect_step",
    state: "succeeded",
    evidencePointer: input.evidencePointer,
    ledgerPointer: input.ledgerPointer,
  };
}

type FailedStepBeforeReconcileRow = {
  kind: string;
  state: string;
  required: number;
  step_order: number;
  result_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: number | null;
  updated_at: number;
};

function appendFailedStepEventBeforeReconcile(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    row: FailedStepBeforeReconcileRow;
  },
): void {
  const occurredAt = input.row.finished_at ?? input.row.updated_at;
  const payload = compactWorkflowEventPayload({
    kind: input.row.kind,
    order: input.row.step_order,
    required: input.row.required === 1,
    resultDigest: input.row.result_digest,
    errorCode: input.row.error_code,
    errorMessage: input.row.error_message,
  });
  appendWorkflowEvent(db, {
    runId: input.runId,
    type: "step_failed",
    occurredAt,
    stepId: input.stepId,
    payload,
    eventId: buildWorkflowEventId({
      runId: input.runId,
      type: "step_failed",
      timestamp: occurredAt,
      stepId: input.stepId,
      payload,
      source: "step",
    }),
  });
}

function compactWorkflowEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== null),
  );
}
