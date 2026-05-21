import { randomUUID } from "node:crypto";

import { isUniqueViolation, type MomentumDb } from "./db.js";
import type { ExternalUpdateMutationKind } from "./external-update-adapter.js";
import type { UpdateIntentApplyPolicy } from "./momentum-policy.js";

export const INTENT_APPLY_LIFECYCLE_STATES = [
  "claimed",
  "succeeded",
  "failed",
  "blocked",
  "audit_incomplete"
] as const;

export type IntentApplyLifecycleState =
  (typeof INTENT_APPLY_LIFECYCLE_STATES)[number];

export type IntentApplyFinalLifecycleState = Exclude<
  IntentApplyLifecycleState,
  "claimed"
>;

export const INTENT_APPLY_STATES = ["idle", "in_flight", "blocked"] as const;

export type IntentApplyState = (typeof INTENT_APPLY_STATES)[number];

export type IntentApplyAuditTarget = {
  externalId: string | null;
  externalKey: string | null;
  url: string | null;
  title: string | null;
};

export type IntentApplyAuditExternalRefs = {
  commentId: string | null;
  commentUrl: string | null;
  stateTransitionId: string | null;
};

export type IntentApplyAuditReconcile = {
  status: string | null;
  warning: string | null;
};

export type IntentApplyAudit = {
  id: string;
  intentId: string;
  adapterKind: string;
  provider: string;
  target: IntentApplyAuditTarget;
  requestedAt: number;
  finishedAt: number | null;
  operatorReason: string;
  operatorActor: string | null;
  intentApplyPolicy: UpdateIntentApplyPolicy;
  allowStatusMutation: boolean;
  mutationKind: ExternalUpdateMutationKind;
  previewSummary: string;
  idempotencyMarker: string;
  lifecycleState: IntentApplyLifecycleState;
  resultStatus: string | null;
  resultCode: string | null;
  resultMessage: string | null;
  externalRefs: IntentApplyAuditExternalRefs;
  reconcile: IntentApplyAuditReconcile;
  createdAt: number;
  updatedAt: number;
};

export type ClaimIntentApplyInput = {
  intentId: string;
  adapterKind: string;
  provider?: string;
  target: IntentApplyAuditTarget;
  operatorReason: string;
  operatorActor?: string | null;
  intentApplyPolicy: UpdateIntentApplyPolicy;
  allowStatusMutation: boolean;
  mutationKind: ExternalUpdateMutationKind;
  previewSummary: string;
  idempotencyMarker: string;
  now?: number;
};

export type ClaimIntentApplyErrorCode =
  | "intent_not_found"
  | "intent_apply_in_progress"
  | "intent_blocked";

export type ClaimIntentApplyResult =
  | { ok: true; audit: IntentApplyAudit }
  | {
      ok: false;
      code: ClaimIntentApplyErrorCode;
      message: string;
      currentApplyState?: IntentApplyState;
      latestAuditId?: string;
    };

export type FinalizeIntentApplyInput = {
  auditId: string;
  lifecycleState: IntentApplyFinalLifecycleState;
  resultStatus?: string | null;
  resultCode?: string | null;
  resultMessage?: string | null;
  externalRefs?: Partial<IntentApplyAuditExternalRefs>;
  reconcile?: Partial<IntentApplyAuditReconcile>;
  now?: number;
};

export type FinalizeIntentApplyErrorCode =
  | "audit_not_found"
  | "audit_already_finalized";

export type FinalizeIntentApplyResult =
  | { ok: true; audit: IntentApplyAudit }
  | {
      ok: false;
      code: FinalizeIntentApplyErrorCode;
      message: string;
      currentLifecycleState?: IntentApplyLifecycleState;
    };

export type MarkIntentApplyAuditIncompleteInput = {
  auditId: string;
  resultCode: string;
  resultMessage: string;
  externalRefs?: Partial<IntentApplyAuditExternalRefs>;
  reconcile?: Partial<IntentApplyAuditReconcile>;
  now?: number;
};

export type UpdateIntentApplyAuditReconcileInput = {
  auditId: string;
  reconcile: IntentApplyAuditReconcile;
  now?: number;
};

export type UpdateIntentApplyAuditReconcileResult =
  | { ok: true; audit: IntentApplyAudit }
  | {
      ok: false;
      code: "audit_not_found";
      message: string;
    };

export type ListIntentApplyAuditsOptions = {
  intentId?: string;
  lifecycleState?: IntentApplyLifecycleState;
  limit?: number;
};

export type IntentApplyAuditCounts = Record<IntentApplyLifecycleState, number>;

type IntentApplyAuditRow = {
  id: string;
  intent_id: string;
  adapter_kind: string;
  provider: string;
  external_target_external_id: string | null;
  external_target_external_key: string | null;
  external_target_url: string | null;
  external_target_title: string | null;
  requested_at: number;
  finished_at: number | null;
  operator_reason: string;
  operator_actor: string | null;
  intent_apply_policy: UpdateIntentApplyPolicy;
  allow_status_mutation: number;
  mutation_kind: ExternalUpdateMutationKind;
  preview_summary: string;
  idempotency_marker: string;
  lifecycle_state: IntentApplyLifecycleState;
  result_status: string | null;
  result_code: string | null;
  result_message: string | null;
  external_ref_comment_id: string | null;
  external_ref_comment_url: string | null;
  external_ref_state_transition_id: string | null;
  reconcile_status: string | null;
  reconcile_warning: string | null;
  created_at: number;
  updated_at: number;
};

type UpdateIntentApplyStateRow = {
  id: string;
  apply_state: IntentApplyState;
};

/**
 * Claim the per-intent CAS guard and persist the audit-before-write row.
 *
 * The successful claim transitions the intent's `apply_state` from `idle` to
 * `in_flight` atomically. A concurrent claimant on the same intent receives
 * the stable `intent_apply_in_progress` code and must not call the external
 * adapter. An intent in the `blocked` state returns `intent_blocked` and must
 * be cleared by the operator recovery path before another claim is possible.
 *
 * The audit row is inserted in the same transaction so an external write can
 * never run without a durable audit record; the partial unique index on
 * `(intent_id) WHERE lifecycle_state='claimed'` is a belt-and-suspenders guard
 * if a future bug bypasses the CAS column.
 */
export function claimIntentApply(
  db: MomentumDb,
  input: ClaimIntentApplyInput
): ClaimIntentApplyResult {
  validateNonEmpty(input.intentId, "intentId");
  validateNonEmpty(input.adapterKind, "adapterKind");
  validateNonEmpty(input.operatorReason, "operatorReason");
  validateNonEmpty(input.previewSummary, "previewSummary");
  validateNonEmpty(input.idempotencyMarker, "idempotencyMarker");

  const now = input.now ?? Date.now();
  const provider = input.provider ?? input.adapterKind;
  const auditId = `intent_apply_audit_${randomUUID()}`;

  db.exec("BEGIN");
  try {
    const claim = db
      .prepare(
        `UPDATE update_intents
            SET apply_state = 'in_flight',
                updated_at = ?
          WHERE id = ? AND apply_state = 'idle'
          RETURNING id, apply_state`
      )
      .get(now, input.intentId) as UpdateIntentApplyStateRow | undefined;

    if (!claim) {
      const current = db
        .prepare(
          "SELECT id, apply_state FROM update_intents WHERE id = ?"
        )
        .get(input.intentId) as UpdateIntentApplyStateRow | undefined;
      db.exec("ROLLBACK");
      if (!current) {
        return {
          ok: false,
          code: "intent_not_found",
          message: `Update intent not found: ${input.intentId}`
        };
      }
      if (current.apply_state === "blocked") {
        const latest = getLatestIntentApplyAudit(db, input.intentId);
        const failure: ClaimIntentApplyResult = {
          ok: false,
          code: "intent_blocked",
          message:
            `Update intent ${input.intentId} is blocked from external apply; ` +
            `operator recovery must clear the block before another claim is possible.`,
          currentApplyState: current.apply_state
        };
        if (latest) failure.latestAuditId = latest.id;
        return failure;
      }
      const inFlight = getLatestIntentApplyAudit(db, input.intentId);
      const failure: ClaimIntentApplyResult = {
        ok: false,
        code: "intent_apply_in_progress",
        message: `Another external apply is already in progress for intent ${input.intentId}.`,
        currentApplyState: current.apply_state
      };
      if (inFlight) failure.latestAuditId = inFlight.id;
      return failure;
    }

    let row: IntentApplyAuditRow;
    try {
      row = db
        .prepare(
          `INSERT INTO intent_apply_audits
             (id, intent_id, adapter_kind, provider,
              external_target_external_id, external_target_external_key,
              external_target_url, external_target_title,
              requested_at, finished_at,
              operator_reason, operator_actor,
              intent_apply_policy, allow_status_mutation,
              mutation_kind, preview_summary, idempotency_marker,
              lifecycle_state, result_status, result_code, result_message,
              external_ref_comment_id, external_ref_comment_url,
              external_ref_state_transition_id,
              reconcile_status, reconcile_warning,
              created_at, updated_at)
           VALUES (?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, NULL,
                   ?, ?,
                   ?, ?,
                   ?, ?, ?,
                   'claimed', NULL, NULL, NULL,
                   NULL, NULL,
                   NULL,
                   NULL, NULL,
                   ?, ?)
           RETURNING *`
        )
        .get(
          auditId,
          input.intentId,
          input.adapterKind,
          provider,
          input.target.externalId,
          input.target.externalKey,
          input.target.url,
          input.target.title,
          now,
          input.operatorReason,
          input.operatorActor ?? null,
          input.intentApplyPolicy,
          input.allowStatusMutation ? 1 : 0,
          input.mutationKind,
          input.previewSummary,
          input.idempotencyMarker,
          now,
          now
        ) as IntentApplyAuditRow;
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueViolation(error)) {
        const latest = getLatestIntentApplyAudit(db, input.intentId);
        const failure: ClaimIntentApplyResult = {
          ok: false,
          code: "intent_apply_in_progress",
          message: `Another external apply is already in progress for intent ${input.intentId}.`
        };
        if (latest) failure.latestAuditId = latest.id;
        return failure;
      }
      throw error;
    }

    db.exec("COMMIT");
    return { ok: true, audit: intentApplyAuditFromRow(row) };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/**
 * Finalize an in-flight audit row with a terminal lifecycle state and release
 * (or block) the intent's CAS column accordingly. `succeeded` and `failed`
 * release the intent back to `idle`; `blocked` and `audit_incomplete` move the
 * intent to `blocked`, making any further claim refuse with `intent_blocked`
 * until an operator recovery path clears the block. The audit row records
 * `finished_at`, the result status/code/message, external refs, and any
 * post-apply reconciliation status/warning.
 */
export function finalizeIntentApply(
  db: MomentumDb,
  input: FinalizeIntentApplyInput
): FinalizeIntentApplyResult {
  validateNonEmpty(input.auditId, "auditId");
  const lifecycleAsString = input.lifecycleState as string;
  if (
    !(INTENT_APPLY_LIFECYCLE_STATES as readonly string[]).includes(
      lifecycleAsString
    ) ||
    lifecycleAsString === "claimed"
  ) {
    throw new Error(
      `finalizeIntentApply: lifecycleState must be one of succeeded/failed/blocked/audit_incomplete (got "${lifecycleAsString}").`
    );
  }

  const now = input.now ?? Date.now();
  const externalRefs: IntentApplyAuditExternalRefs = {
    commentId: input.externalRefs?.commentId ?? null,
    commentUrl: input.externalRefs?.commentUrl ?? null,
    stateTransitionId: input.externalRefs?.stateTransitionId ?? null
  };
  const reconcile: IntentApplyAuditReconcile = {
    status: input.reconcile?.status ?? null,
    warning: input.reconcile?.warning ?? null
  };

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT * FROM intent_apply_audits WHERE id = ?")
      .get(input.auditId) as IntentApplyAuditRow | undefined;
    if (!existing) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        code: "audit_not_found",
        message: `Intent apply audit not found: ${input.auditId}`
      };
    }
    if (existing.lifecycle_state !== "claimed") {
      db.exec("ROLLBACK");
      return {
        ok: false,
        code: "audit_already_finalized",
        message:
          `Intent apply audit ${input.auditId} is already ${existing.lifecycle_state}; ` +
          `refusing to overwrite finalized lifecycle state.`,
        currentLifecycleState: existing.lifecycle_state
      };
    }

    const row = db
      .prepare(
        `UPDATE intent_apply_audits
            SET lifecycle_state = ?,
                finished_at = ?,
                updated_at = ?,
                result_status = ?,
                result_code = ?,
                result_message = ?,
                external_ref_comment_id = ?,
                external_ref_comment_url = ?,
                external_ref_state_transition_id = ?,
                reconcile_status = ?,
                reconcile_warning = ?
          WHERE id = ? AND lifecycle_state = 'claimed'
          RETURNING *`
      )
      .get(
        input.lifecycleState,
        now,
        now,
        input.resultStatus ?? input.lifecycleState,
        input.resultCode ?? null,
        input.resultMessage ?? null,
        externalRefs.commentId,
        externalRefs.commentUrl,
        externalRefs.stateTransitionId,
        reconcile.status,
        reconcile.warning,
        input.auditId
      ) as IntentApplyAuditRow | undefined;

    if (!row) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        code: "audit_already_finalized",
        message: `Intent apply audit ${input.auditId} transitioned concurrently; refusing to overwrite.`
      };
    }

    const nextApplyState: IntentApplyState =
      input.lifecycleState === "blocked" ||
      input.lifecycleState === "audit_incomplete"
        ? "blocked"
        : "idle";

    db.prepare(
      `UPDATE update_intents
          SET apply_state = ?,
              updated_at = ?
        WHERE id = ?`
    ).run(nextApplyState, now, existing.intent_id);

    db.exec("COMMIT");
    return { ok: true, audit: intentApplyAuditFromRow(row) };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/**
 * Recovery helper for cases where normal audit finalization cannot leave a
 * replay-safe terminal state. This deliberately rewrites the audit to
 * `audit_incomplete` and blocks the intent from replaying the external write
 * or re-entering an ambiguous apply attempt before operator recovery.
 */
export function markIntentApplyAuditIncomplete(
  db: MomentumDb,
  input: MarkIntentApplyAuditIncompleteInput
): FinalizeIntentApplyResult {
  validateNonEmpty(input.auditId, "auditId");
  validateNonEmpty(input.resultCode, "resultCode");
  validateNonEmpty(input.resultMessage, "resultMessage");

  const now = input.now ?? Date.now();
  const externalRefs: IntentApplyAuditExternalRefs = {
    commentId: input.externalRefs?.commentId ?? null,
    commentUrl: input.externalRefs?.commentUrl ?? null,
    stateTransitionId: input.externalRefs?.stateTransitionId ?? null
  };
  const reconcile: IntentApplyAuditReconcile = {
    status: input.reconcile?.status ?? "deferred",
    warning: input.reconcile?.warning ?? null
  };

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT * FROM intent_apply_audits WHERE id = ?")
      .get(input.auditId) as IntentApplyAuditRow | undefined;
    if (!existing) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        code: "audit_not_found",
        message: `Intent apply audit not found: ${input.auditId}`
      };
    }

    const row = db
      .prepare(
        `UPDATE intent_apply_audits
            SET lifecycle_state = 'audit_incomplete',
                finished_at = COALESCE(finished_at, ?),
                updated_at = ?,
                result_status = 'audit_incomplete',
                result_code = ?,
                result_message = ?,
                external_ref_comment_id = ?,
                external_ref_comment_url = ?,
                external_ref_state_transition_id = ?,
                reconcile_status = ?,
                reconcile_warning = ?
          WHERE id = ?
          RETURNING *`
      )
      .get(
        now,
        now,
        input.resultCode,
        input.resultMessage,
        externalRefs.commentId,
        externalRefs.commentUrl,
        externalRefs.stateTransitionId,
        reconcile.status,
        reconcile.warning,
        input.auditId
      ) as IntentApplyAuditRow | undefined;

    if (!row) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        code: "audit_not_found",
        message: `Intent apply audit not found: ${input.auditId}`
      };
    }

    db.prepare(
      `UPDATE update_intents
          SET apply_state = 'blocked',
              updated_at = ?
        WHERE id = ?`
    ).run(now, existing.intent_id);

    db.exec("COMMIT");
    return { ok: true, audit: intentApplyAuditFromRow(row) };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

export function getIntentApplyAuditById(
  db: MomentumDb,
  id: string
): IntentApplyAudit | null {
  const row = db
    .prepare("SELECT * FROM intent_apply_audits WHERE id = ?")
    .get(id) as IntentApplyAuditRow | undefined;
  return row ? intentApplyAuditFromRow(row) : null;
}

export function getLatestIntentApplyAudit(
  db: MomentumDb,
  intentId: string
): IntentApplyAudit | null {
  const row = db
    .prepare(
      `SELECT *
         FROM intent_apply_audits
        WHERE intent_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .get(intentId) as IntentApplyAuditRow | undefined;
  return row ? intentApplyAuditFromRow(row) : null;
}

export function updateIntentApplyAuditReconcile(
  db: MomentumDb,
  input: UpdateIntentApplyAuditReconcileInput
): UpdateIntentApplyAuditReconcileResult {
  validateNonEmpty(input.auditId, "auditId");
  const now = input.now ?? Date.now();
  const row = db
    .prepare(
      `UPDATE intent_apply_audits
          SET reconcile_status = ?,
              reconcile_warning = ?,
              updated_at = ?
        WHERE id = ?
        RETURNING *`
    )
    .get(
      input.reconcile.status ?? null,
      input.reconcile.warning ?? null,
      now,
      input.auditId
    ) as IntentApplyAuditRow | undefined;
  if (!row) {
    return {
      ok: false,
      code: "audit_not_found",
      message: `Intent apply audit not found: ${input.auditId}`
    };
  }
  return { ok: true, audit: intentApplyAuditFromRow(row) };
}

export function listIntentApplyAudits(
  db: MomentumDb,
  options: ListIntentApplyAuditsOptions = {}
): IntentApplyAudit[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.intentId !== undefined) {
    clauses.push("intent_id = ?");
    params.push(options.intentId);
  }
  if (options.lifecycleState !== undefined) {
    clauses.push("lifecycle_state = ?");
    params.push(options.lifecycleState);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitClause =
    options.limit !== undefined && options.limit >= 0
      ? `LIMIT ${Math.floor(options.limit)}`
      : "";
  const rows = db
    .prepare(
      `SELECT *
         FROM intent_apply_audits
         ${where}
        ORDER BY created_at DESC, id DESC
        ${limitClause}`
    )
    .all(...params) as IntentApplyAuditRow[];
  return rows.map(intentApplyAuditFromRow);
}

export function countIntentApplyAuditsByLifecycleState(
  db: MomentumDb,
  options: { intentId?: string } = {}
): IntentApplyAuditCounts {
  const params: string[] = [];
  let where = "";
  if (options.intentId !== undefined) {
    where = "WHERE intent_id = ?";
    params.push(options.intentId);
  }
  const rows = db
    .prepare(
      `SELECT lifecycle_state AS state, COUNT(*) AS c
         FROM intent_apply_audits
         ${where}
        GROUP BY lifecycle_state`
    )
    .all(...params) as Array<{ state: IntentApplyLifecycleState; c: number }>;
  const counts: IntentApplyAuditCounts = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    audit_incomplete: 0
  };
  for (const row of rows) {
    counts[row.state] = row.c;
  }
  return counts;
}

export type IntentApplyAuditSummary = {
  intentId: string;
  applyState: IntentApplyState;
  totalAttempts: number;
  counts: IntentApplyAuditCounts;
  latestAttempt: IntentApplyAudit | null;
};

/**
 * Per-intent audit summary used by CLI/operator surfaces. Returns null when
 * the intent does not exist. The `applyState` reflects the current CAS column
 * on `update_intents` so callers can render `idle | in_flight | blocked`
 * alongside the latest attempt and lifecycle-state counts.
 */
export function summarizeIntentApplyAuditsForIntent(
  db: MomentumDb,
  intentId: string
): IntentApplyAuditSummary | null {
  validateNonEmpty(intentId, "intentId");
  const intent = db
    .prepare("SELECT id, apply_state FROM update_intents WHERE id = ?")
    .get(intentId) as UpdateIntentApplyStateRow | undefined;
  if (!intent) return null;

  const counts = countIntentApplyAuditsByLifecycleState(db, { intentId });
  const totalAttempts =
    counts.claimed +
    counts.succeeded +
    counts.failed +
    counts.blocked +
    counts.audit_incomplete;
  const latestAttempt = getLatestIntentApplyAudit(db, intentId);

  return {
    intentId,
    applyState: intent.apply_state,
    totalAttempts,
    counts,
    latestAttempt
  };
}

export function countBlockedIntents(db: MomentumDb): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM update_intents WHERE apply_state = 'blocked'"
    )
    .get() as { c: number };
  return row.c;
}

export type IntentApplyStateCounts = Record<IntentApplyState, number>;

export function countIntentsByApplyState(
  db: MomentumDb
): IntentApplyStateCounts {
  const rows = db
    .prepare(
      `SELECT apply_state AS state, COUNT(*) AS c
         FROM update_intents
        GROUP BY apply_state`
    )
    .all() as Array<{ state: IntentApplyState; c: number }>;
  const counts: IntentApplyStateCounts = {
    idle: 0,
    in_flight: 0,
    blocked: 0
  };
  for (const row of rows) {
    counts[row.state] = row.c;
  }
  return counts;
}

function intentApplyAuditFromRow(row: IntentApplyAuditRow): IntentApplyAudit {
  return {
    id: row.id,
    intentId: row.intent_id,
    adapterKind: row.adapter_kind,
    provider: row.provider,
    target: {
      externalId: row.external_target_external_id,
      externalKey: row.external_target_external_key,
      url: row.external_target_url,
      title: row.external_target_title
    },
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    operatorReason: row.operator_reason,
    operatorActor: row.operator_actor,
    intentApplyPolicy: row.intent_apply_policy,
    allowStatusMutation: row.allow_status_mutation !== 0,
    mutationKind: row.mutation_kind,
    previewSummary: row.preview_summary,
    idempotencyMarker: row.idempotency_marker,
    lifecycleState: row.lifecycle_state,
    resultStatus: row.result_status,
    resultCode: row.result_code,
    resultMessage: row.result_message,
    externalRefs: {
      commentId: row.external_ref_comment_id,
      commentUrl: row.external_ref_comment_url,
      stateTransitionId: row.external_ref_state_transition_id
    },
    reconcile: {
      status: row.reconcile_status,
      warning: row.reconcile_warning
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore — transaction may already be closed by the inner failure path
  }
}

function validateNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`intent apply audit ${name} must be a non-empty string`);
  }
}
