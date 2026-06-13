/**
 * Post-apply reconciliation orchestrator (NGX-300 / M6-05).
 *
 * After the two-phase external apply path mutates Linear, this module performs
 * a targeted refresh of just the touched issue, confirms the apply idempotency
 * marker is reflected in Linear, and persists the refreshed payload to local
 * SourceItem state. The reconciliation outcome surface uses a fixed taxonomy
 * so operator surfaces and the audit ledger can record a stable code/message.
 *
 * Invariants the orchestrator must preserve:
 *
 *  - Scope is single-issue. The orchestrator never triggers project- or
 *    milestone-wide reconciliation (`internal/contracts/intent-apply.md`).
 *  - Reconcile is best-effort and never reverts the external apply. The Linear
 *    write is already authoritative — local audit/SourceItem state is the
 *    durable trace.
 *  - The marker check uses the same idempotency marker that the apply preview
 *    embedded in the Linear comment body so a single source of truth governs
 *    "this write actually landed."
 *  - Failures degrade gracefully into specific outcome codes rather than
 *    throwing — the caller relies on the result to decide whether to surface a
 *    warning, mark the audit as deferred, or carry on as success.
 */

import type { MomentumDb } from "./adapters/db.js";
import {
  normalizeLinearIssue,
  LINEAR_SOURCE_ADAPTER_KIND
} from "./adapters/linear-source-adapter.js";
import type {
  LinearIssueRefreshClient,
  LinearIssueRefreshTarget
} from "./linear-issue-refresh.js";
import {
  recordSourceSnapshot,
  upsertSourceItem
} from "./source-items.js";

export const POST_APPLY_RECONCILE_OUTCOME_CODES = Object.freeze([
  "success",
  "stale_source",
  "mismatch_persists",
  "refresh_failed",
  "post_apply_reconcile_failed",
  "targeted_refresh_unsupported"
] as const);

export type PostApplyReconcileOutcomeCode =
  (typeof POST_APPLY_RECONCILE_OUTCOME_CODES)[number];

export type PostApplyReconcileOutcome = {
  code: PostApplyReconcileOutcomeCode;
  detail: string;
  sourceItemId: string | null;
  snapshotId: string | null;
};

export type PostApplyReconcileClient = LinearIssueRefreshClient;

export type PostApplyReconcileInput = {
  db: MomentumDb;
  adapterKind: string;
  externalId: string;
  externalKey?: string | null;
  url?: string | null;
  idempotencyMarker: string;
  client: PostApplyReconcileClient | null;
  now?: () => number;
};

export async function reconcileAfterExternalApply(
  input: PostApplyReconcileInput
): Promise<PostApplyReconcileOutcome> {
  if (input.adapterKind !== LINEAR_SOURCE_ADAPTER_KIND) {
    return outcome(
      "targeted_refresh_unsupported",
      `Adapter "${input.adapterKind}" has no targeted refresh primitive; post-apply reconcile is skipped.`
    );
  }
  if (!input.client) {
    return outcome(
      "targeted_refresh_unsupported",
      `Adapter "${input.adapterKind}" has no refresh client wired; post-apply reconcile is skipped.`
    );
  }
  if (
    typeof input.externalId !== "string" ||
    input.externalId.trim().length === 0
  ) {
    return outcome(
      "post_apply_reconcile_failed",
      "reconcileAfterExternalApply requires a non-empty externalId."
    );
  }
  if (
    typeof input.idempotencyMarker !== "string" ||
    input.idempotencyMarker.length === 0
  ) {
    return outcome(
      "post_apply_reconcile_failed",
      "reconcileAfterExternalApply requires a non-empty idempotencyMarker."
    );
  }

  const target: LinearIssueRefreshTarget = {
    kind: "id",
    value: input.externalId
  };

  let refreshResult: Awaited<ReturnType<PostApplyReconcileClient["refresh"]>>;
  try {
    refreshResult = await input.client.refresh({ target });
  } catch (error) {
    return outcome(
      "post_apply_reconcile_failed",
      `Linear refresh client threw: ${describeError(error)}`
    );
  }

  if (!refreshResult.ok) {
    if (refreshResult.code === "target_missing") {
      return outcome(
        "stale_source",
        `Linear no longer recognizes target ${input.externalId}: ${refreshResult.error}`
      );
    }
    return outcome(
      "refresh_failed",
      `Linear refresh failed (${refreshResult.code}): ${refreshResult.error}`
    );
  }

  const markerPresent = refreshResult.comments.some((comment) =>
    comment.body.includes(input.idempotencyMarker)
  );
  if (!markerPresent) {
    return outcome(
      "mismatch_persists",
      `Linear refresh did not surface idempotency marker ${input.idempotencyMarker}; Linear may not yet reflect the apply.`
    );
  }

  const normalized = normalizeLinearIssue(refreshResult.issue);
  if (!normalized.ok) {
    return outcome(
      "post_apply_reconcile_failed",
      `Linear refresh payload could not be normalized: ${normalized.error}`
    );
  }

  const clock = input.now ? { now: input.now } : {};

  try {
    const item = upsertSourceItem(
      input.db,
      {
        adapterKind: LINEAR_SOURCE_ADAPTER_KIND,
        externalId: normalized.item.externalId,
        externalKey: normalized.item.externalKey ?? null,
        url: normalized.item.url ?? null,
        title: normalized.item.title,
        status: normalized.item.status ?? null,
        metadata: normalized.item.metadata ?? {},
        observedAt: normalized.item.observedAt
      },
      clock
    );
    const snapshot = recordSourceSnapshot(
      input.db,
      {
        sourceItemId: item.id,
        adapterKind: LINEAR_SOURCE_ADAPTER_KIND,
        externalId: normalized.item.externalId,
        observedAt: normalized.item.observedAt,
        snapshot: {
          issue: refreshResult.issue,
          comments: refreshResult.comments
        }
      },
      clock
    );
    return {
      code: "success",
      detail:
        "Linear refresh confirmed the apply idempotency marker; SourceItem snapshot recorded.",
      sourceItemId: item.id,
      snapshotId: snapshot.id
    };
  } catch (error) {
    return outcome(
      "post_apply_reconcile_failed",
      `Linear refresh succeeded but local SourceItem update failed: ${describeError(error)}`
    );
  }
}

function outcome(
  code: PostApplyReconcileOutcomeCode,
  detail: string
): PostApplyReconcileOutcome {
  return { code, detail, sourceItemId: null, snapshotId: null };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
