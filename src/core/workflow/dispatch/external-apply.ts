/**
 * Pure half of the daemon-dispatchable `external-apply` adapter.
 *
 * the external-apply seam makes the `external-apply` executor family daemon-dispatchable by
 * connecting the existing external-apply write path (`executeExternalApply`,
 * `src/core/intent/apply-execute.ts`) to the workflow dispatch/executor-evidence
 * lane — *without* inventing a second external write path and without weakening
 * the external-apply safety contract (policy gating, audit-before-write, comment-only
 * default, idempotency markers, CAS/in-flight refusal, blocked/audit-incomplete
 * behavior).
 *
 * The durable dispatch lane already has two reusable seams:
 *
 *   - `dispatch/executor-evidence.ts` records a finished
 *     {@link WorkflowStepExecutorDispatchResult} as terminal executor evidence on
 *     the dispatch attempt scaffold (succeeded / failed for a clean
 *     terminal; `manual_recovery_required` for any `ok: false` result), and
 *   - `dispatch/reconcile-execute.ts` (the reconciliation seam) finalizes the owning
 *     `workflow_steps` row from that terminal evidence, exactly once.
 *
 * This module owns the one piece those seams do not: translating an external-apply
 * {@link ExecuteExternalApplyResult} into the {@link WorkflowStepExecutorDispatchResult}
 * the terminalize bridge consumes. It is pure and total — no SQLite, no network,
 * no clock — so the mapping contract is exhaustively testable on its own, the
 * same discipline `planDispatchedExecutorTerminalization` follows.
 *
 * Mapping discipline (external writes are high-risk, so the default is fail
 * closed):
 *
 *   - A clean `applied` outcome — including an idempotent already-applied replay,
 *     which the external-apply path reports as a success without re-issuing the external
 *     write — becomes a clean `succeeded` executor result the terminalize decider
 *     routes to a clean workflow-step terminal.
 *   - EVERY external-apply failure (`policy_denied`, `auth_unavailable`, `unsupported_adapter`,
 *     `intent_apply_in_progress`, `intent_blocked`, `audit_incomplete`,
 *     `write_rejected`, …) becomes an `ok: false` executor result the decider
 *     routes to manual recovery rather than a fabricated clean terminal, so an
 *     unconfigured / unsafe / refused apply parks the run for operator inspection
 *     with explicit evidence. The dispatched-step executor-evidence vocabulary
 *     ({@link WorkflowStepExecutorErrorCode}) has no per-external-apply-cause member, so the
 *     mapped result carries the `manual_recovery_required` executor code while the
 *     precise external-apply cause is preserved verbatim in the operator-facing error text
 *     (which the terminalize bridge records as the round summary).
 */

import type {
  ExecuteExternalApplyFailure,
  ExecuteExternalApplyResult,
  ExecuteExternalApplySuccess,
} from "../../intent/apply-execute.js";
import type { WorkflowStepExecutorDispatchResult } from "../step/executor.js";

/**
 * The durable evidence paths the dispatched external-apply executor result
 * carries. The daemon lane derives these from the run's data-dir layout (a log
 * of the apply attempt and a JSON snapshot of the external-apply result) and forwards them
 * here so the terminalize bridge can attach them to the round as operator-visible
 * evidence — the same `executorLogPath` / `resultJsonPath` shape a live-wrapper
 * executor result carries.
 */
export type ExternalApplyExecutorEvidence = {
  executorLogPath: string;
  resultJsonPath: string;
};

/**
 * Translate an external-apply {@link ExecuteExternalApplyResult} into the
 * {@link WorkflowStepExecutorDispatchResult} the terminalize bridge consumes.
 *
 * Pure and total: never throws, always returns a dispatch result. A clean
 * `applied` outcome maps to a `succeeded` executor result; every failure maps to
 * a fail-closed `manual_recovery_required` result (see the module doc).
 */
export function mapExternalApplyResultToExecutorResult(
  result: ExecuteExternalApplyResult,
  evidence: ExternalApplyExecutorEvidence,
): WorkflowStepExecutorDispatchResult {
  if (result.ok) {
    return {
      ok: true,
      result: {
        state: "succeeded",
        summary: buildAppliedSummary(result),
        checkpoints: [],
        artifacts: [
          { kind: "executor-log", path: evidence.executorLogPath },
          { kind: "external-apply-result", path: evidence.resultJsonPath },
        ],
        // The idempotency marker is the stable digest tying this terminal
        // evidence to the durable external write (and to any future replay).
        resultDigest: result.external.idempotencyMarker,
        errorCode: null,
        errorMessage: null,
        retryHint: null,
        recoveryHint: null,
      },
      executorLogPath: evidence.executorLogPath,
      resultJsonPath: evidence.resultJsonPath,
    };
  }
  return {
    ok: false,
    code: "manual_recovery_required",
    error: buildRefusedError(result),
    executorLogPath: evidence.executorLogPath,
    resultJsonPath: evidence.resultJsonPath,
  };
}

function buildAppliedSummary(result: ExecuteExternalApplySuccess): string {
  const { context, external } = result;
  const targetRef =
    external.issueKey ??
    external.issueId ??
    context.target.externalKey ??
    context.target.externalId ??
    "unknown";
  const verb =
    result.resultCode === "already_applied"
      ? "replayed (already applied)"
      : "applied";
  const comment = external.commentUrl ?? external.commentId ?? "n/a";
  return (
    `External apply ${verb} for intent ${context.intentId} on ` +
    `${context.adapterKind} target ${targetRef} (comment ${comment}); ` +
    `audit ${context.auditId ?? "n/a"}, reconcile ${context.reconcile.status ?? "n/a"}.`
  );
}

function buildRefusedError(result: ExecuteExternalApplyFailure): string {
  return `external-apply refused (${result.code}): ${result.message}`;
}
