import { randomUUID } from "node:crypto";

import type { MomentumDb } from "./db.js";

export const UPDATE_INTENT_STATUSES = [
  "pending",
  "applied",
  "skipped",
  "canceled"
] as const;

export type UpdateIntentStatus = (typeof UPDATE_INTENT_STATUSES)[number];

export type UpdateIntent = {
  id: string;
  adapterKind: string;
  targetExternalId: string | null;
  intentType: string;
  payload: Record<string, unknown>;
  reason: string;
  goalId: string | null;
  sourceItemId: string | null;
  evidenceRecordId: string | null;
  status: UpdateIntentStatus;
  idempotencyKey: string;
  decisionReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
  skippedAt: number | null;
  canceledAt: number | null;
};

export type CreateUpdateIntentInput = {
  adapterKind: string;
  targetExternalId?: string | null;
  intentType: string;
  payload?: Record<string, unknown>;
  reason: string;
  goalId?: string | null;
  sourceItemId?: string | null;
  evidenceRecordId?: string | null;
  idempotencyKey: string;
};

export type CreateUpdateIntentResult = {
  intent: UpdateIntent;
  created: boolean;
};

export type UpdateIntentClock = {
  now?: () => number;
};

export type UpdateIntentDecisionInput = {
  intentId: string;
  decisionReason: string;
  now?: number;
};

export type UpdateIntentDecisionErrorCode =
  | "intent_not_found"
  | "intent_already_terminal";

export type UpdateIntentDecisionResult =
  | {
      ok: true;
      intent: UpdateIntent;
      previousStatus: UpdateIntentStatus;
    }
  | {
      ok: false;
      code: UpdateIntentDecisionErrorCode;
      message: string;
      currentStatus?: UpdateIntentStatus;
    };

export type ListUpdateIntentsOptions = {
  status?: UpdateIntentStatus;
  goalId?: string | null;
  sourceItemId?: string | null;
  evidenceRecordId?: string | null;
  adapterKind?: string;
  intentType?: string;
  limit?: number;
};

type UpdateIntentRow = {
  id: string;
  adapter_kind: string;
  target_external_id: string | null;
  intent_type: string;
  payload_json: string;
  reason: string;
  goal_id: string | null;
  source_item_id: string | null;
  evidence_record_id: string | null;
  status: UpdateIntentStatus;
  idempotency_key: string;
  decision_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
  skipped_at: number | null;
  canceled_at: number | null;
};

/**
 * Create a durable external update intent. Default status is "pending"; no
 * external write is performed. Idempotent on idempotencyKey: repeated calls
 * with the same key return the original record without mutating it, so
 * intent generators can replay safely after re-running reconciliation or
 * evidence ingestion.
 */
export function createUpdateIntent(
  db: MomentumDb,
  input: CreateUpdateIntentInput,
  clock: UpdateIntentClock = {}
): CreateUpdateIntentResult {
  validateNonEmpty(input.adapterKind, "adapterKind");
  validateNonEmpty(input.intentType, "intentType");
  validateNonEmpty(input.reason, "reason");
  validateNonEmpty(input.idempotencyKey, "idempotencyKey");

  const now = clock.now?.() ?? Date.now();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const row = db
    .prepare(
      `INSERT INTO update_intents
         (id, adapter_kind, target_external_id, intent_type, payload_json,
          reason, goal_id, source_item_id, evidence_record_id,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING *`
    )
    .get(
      `update_intent_${randomUUID()}`,
      input.adapterKind,
      input.targetExternalId ?? null,
      input.intentType,
      payloadJson,
      input.reason,
      input.goalId ?? null,
      input.sourceItemId ?? null,
      input.evidenceRecordId ?? null,
      input.idempotencyKey,
      now,
      now
    ) as UpdateIntentRow | undefined;

  if (row) {
    return { intent: updateIntentFromRow(row), created: true };
  }

  const existing = getUpdateIntentRowByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) {
    throw new Error(
      `Update intent missing after idempotency conflict for key "${input.idempotencyKey}".`
    );
  }
  return { intent: updateIntentFromRow(existing), created: false };
}

export function getUpdateIntentById(
  db: MomentumDb,
  id: string
): UpdateIntent | null {
  const row = db
    .prepare("SELECT * FROM update_intents WHERE id = ?")
    .get(id) as UpdateIntentRow | undefined;
  return row ? updateIntentFromRow(row) : null;
}

export function getUpdateIntentByIdempotencyKey(
  db: MomentumDb,
  idempotencyKey: string
): UpdateIntent | null {
  const row = getUpdateIntentRowByIdempotencyKey(db, idempotencyKey);
  return row ? updateIntentFromRow(row) : null;
}

export function listUpdateIntents(
  db: MomentumDb,
  options: ListUpdateIntentsOptions = {}
): UpdateIntent[] {
  const { where, params } = buildUpdateIntentsFilter(options);
  const limitClause =
    options.limit !== undefined && options.limit >= 0
      ? `LIMIT ${Math.floor(options.limit)}`
      : "";

  const rows = db
    .prepare(
      `SELECT *
         FROM update_intents
         ${where}
        ORDER BY created_at ASC, id ASC
        ${limitClause}`
    )
    .all(...params) as UpdateIntentRow[];

  return rows.map(updateIntentFromRow);
}

export type CountUpdateIntentsOptions = Omit<ListUpdateIntentsOptions, "limit">;

export function countUpdateIntents(
  db: MomentumDb,
  options: CountUpdateIntentsOptions = {}
): number {
  const { where, params } = buildUpdateIntentsFilter(options);
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM update_intents ${where}`)
    .get(...params) as { c: number } | undefined;
  return row?.c ?? 0;
}

function buildUpdateIntentsFilter(options: CountUpdateIntentsOptions): {
  where: string;
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (options.status !== undefined) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.goalId !== undefined) {
    if (options.goalId === null) {
      clauses.push("goal_id IS NULL");
    } else {
      clauses.push("goal_id = ?");
      params.push(options.goalId);
    }
  }
  if (options.sourceItemId !== undefined) {
    if (options.sourceItemId === null) {
      clauses.push("source_item_id IS NULL");
    } else {
      clauses.push("source_item_id = ?");
      params.push(options.sourceItemId);
    }
  }
  if (options.evidenceRecordId !== undefined) {
    if (options.evidenceRecordId === null) {
      clauses.push("evidence_record_id IS NULL");
    } else {
      clauses.push("evidence_record_id = ?");
      params.push(options.evidenceRecordId);
    }
  }
  if (options.adapterKind !== undefined) {
    clauses.push("adapter_kind = ?");
    params.push(options.adapterKind);
  }
  if (options.intentType !== undefined) {
    clauses.push("intent_type = ?");
    params.push(options.intentType);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

/**
 * Mark a pending intent as applied with a required operator reason. M5 does
 * not perform the external write — this records the operator's manual or
 * out-of-band action. Refuses to transition from a terminal status so prior
 * decisions are not silently overwritten.
 */
export function markUpdateIntentApplied(
  db: MomentumDb,
  input: UpdateIntentDecisionInput
): UpdateIntentDecisionResult {
  return transitionUpdateIntent(db, input, "applied");
}

/**
 * Mark a pending intent as skipped with a required operator reason. Skipping
 * captures "do not apply this intent" without canceling its provenance.
 */
export function markUpdateIntentSkipped(
  db: MomentumDb,
  input: UpdateIntentDecisionInput
): UpdateIntentDecisionResult {
  return transitionUpdateIntent(db, input, "skipped");
}

/**
 * Cancel a pending intent with a required operator reason. Canceling is the
 * explicit "this intent is no longer relevant" decision; the row stays for
 * audit.
 */
export function cancelUpdateIntent(
  db: MomentumDb,
  input: UpdateIntentDecisionInput
): UpdateIntentDecisionResult {
  return transitionUpdateIntent(db, input, "canceled");
}

function transitionUpdateIntent(
  db: MomentumDb,
  input: UpdateIntentDecisionInput,
  targetStatus: Exclude<UpdateIntentStatus, "pending">
): UpdateIntentDecisionResult {
  validateNonEmpty(input.intentId, "intentId");
  validateNonEmpty(input.decisionReason, "decisionReason");
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("update intent decision now must be a finite number");
  }

  const existing = getUpdateIntentRowById(db, input.intentId);
  if (!existing) {
    return {
      ok: false,
      code: "intent_not_found",
      message: `Update intent not found: ${input.intentId}`
    };
  }
  if (existing.status !== "pending") {
    return {
      ok: false,
      code: "intent_already_terminal",
      message: `Update intent ${input.intentId} is already ${existing.status}; refusing to overwrite.`,
      currentStatus: existing.status
    };
  }

  const appliedAt = targetStatus === "applied" ? now : null;
  const skippedAt = targetStatus === "skipped" ? now : null;
  const canceledAt = targetStatus === "canceled" ? now : null;

  const row = db
    .prepare(
      `UPDATE update_intents
          SET status = ?,
              decision_reason = ?,
              updated_at = ?,
              applied_at = ?,
              skipped_at = ?,
              canceled_at = ?
        WHERE id = ? AND status = 'pending'
        RETURNING *`
    )
    .get(
      targetStatus,
      input.decisionReason,
      now,
      appliedAt,
      skippedAt,
      canceledAt,
      input.intentId
    ) as UpdateIntentRow | undefined;

  if (!row) {
    const current = getUpdateIntentRowById(db, input.intentId);
    if (!current) {
      return {
        ok: false,
        code: "intent_not_found",
        message: `Update intent disappeared during transition: ${input.intentId}`
      };
    }
    return {
      ok: false,
      code: "intent_already_terminal",
      message: `Update intent ${input.intentId} transitioned to ${current.status} concurrently; refusing to overwrite.`,
      currentStatus: current.status
    };
  }

  return {
    ok: true,
    intent: updateIntentFromRow(row),
    previousStatus: existing.status
  };
}

function getUpdateIntentRowById(
  db: MomentumDb,
  id: string
): UpdateIntentRow | undefined {
  return db
    .prepare("SELECT * FROM update_intents WHERE id = ?")
    .get(id) as UpdateIntentRow | undefined;
}

function getUpdateIntentRowByIdempotencyKey(
  db: MomentumDb,
  idempotencyKey: string
): UpdateIntentRow | undefined {
  return db
    .prepare("SELECT * FROM update_intents WHERE idempotency_key = ?")
    .get(idempotencyKey) as UpdateIntentRow | undefined;
}

function updateIntentFromRow(row: UpdateIntentRow): UpdateIntent {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    targetExternalId: row.target_external_id,
    intentType: row.intent_type,
    payload: parseJsonObject(row.payload_json),
    reason: row.reason,
    goalId: row.goal_id,
    sourceItemId: row.source_item_id,
    evidenceRecordId: row.evidence_record_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    decisionReason: row.decision_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    skippedAt: row.skipped_at,
    canceledAt: row.canceled_at
  };
}

function parseJsonObject(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function validateNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`update intent ${name} must be a non-empty string`);
  }
}
