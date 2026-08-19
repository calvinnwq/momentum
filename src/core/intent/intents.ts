import { randomUUID } from "node:crypto";

import type { MomentumDb } from "../../adapters/db.js";

export const INTENT_STATUSES = [
  "pending",
  "applied",
  "skipped",
  "canceled",
] as const;

export type IntentStatus = (typeof INTENT_STATUSES)[number];

export type Intent = {
  id: string;
  adapterKind: string;
  targetExternalId: string | null;
  intentType: string;
  payload: Record<string, unknown>;
  reason: string;
  goalId: string | null;
  trackerItemId: string | null;
  evidenceRecordId: string | null;
  status: IntentStatus;
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

export type CreateIntentInput = {
  adapterKind: string;
  targetExternalId?: string | null;
  intentType: string;
  payload?: Record<string, unknown>;
  reason: string;
  goalId?: string | null;
  trackerItemId?: string | null;
  evidenceRecordId?: string | null;
  idempotencyKey: string;
};

export type CreateIntentResult = {
  intent: Intent;
  created: boolean;
};

export type IntentClock = {
  now?: () => number;
};

export type IntentDecisionInput = {
  intentId: string;
  decisionReason: string;
  now?: number;
};

export type IntentDecisionErrorCode =
  "intent_not_found" | "intent_already_terminal";

export type IntentDecisionResult =
  | {
      ok: true;
      intent: Intent;
      previousStatus: IntentStatus;
    }
  | {
      ok: false;
      code: IntentDecisionErrorCode;
      message: string;
      currentStatus?: IntentStatus;
    };

export type ListIntentsOptions = {
  status?: IntentStatus;
  goalId?: string | null;
  trackerItemId?: string | null;
  evidenceRecordId?: string | null;
  adapterKind?: string;
  intentType?: string;
  limit?: number;
};

type IntentRow = {
  id: string;
  adapter_kind: string;
  target_external_id: string | null;
  intent_type: string;
  payload_json: string;
  reason: string;
  goal_id: string | null;
  tracker_item_id: string | null;
  evidence_record_id: string | null;
  status: IntentStatus;
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
 * Create a durable intent. Default status is "pending"; no
 * external write is performed. Idempotent on idempotencyKey: repeated calls
 * with the same key return the original record without mutating it, so
 * intent generators can replay safely after re-running reconciliation or
 * evidence ingestion.
 */
export function createIntent(
  db: MomentumDb,
  input: CreateIntentInput,
  clock: IntentClock = {},
): CreateIntentResult {
  validateNonEmpty(input.adapterKind, "adapterKind");
  validateNonEmpty(input.intentType, "intentType");
  validateNonEmpty(input.reason, "reason");
  validateNonEmpty(input.idempotencyKey, "idempotencyKey");

  const now = clock.now?.() ?? Date.now();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const row = db
    .prepare(
      `INSERT INTO intents
         (id, adapter_kind, target_external_id, intent_type, payload_json,
          reason, goal_id, tracker_item_id, evidence_record_id,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING *`,
    )
    .get(
      `intent_${randomUUID()}`,
      input.adapterKind,
      input.targetExternalId ?? null,
      input.intentType,
      payloadJson,
      input.reason,
      input.goalId ?? null,
      input.trackerItemId ?? null,
      input.evidenceRecordId ?? null,
      input.idempotencyKey,
      now,
      now,
    ) as IntentRow | undefined;

  if (row) {
    return { intent: intentFromRow(row), created: true };
  }

  const existing = getIntentRowByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) {
    throw new Error(
      `Intent missing after idempotency conflict for key "${input.idempotencyKey}".`,
    );
  }
  return { intent: intentFromRow(existing), created: false };
}

export function getIntentById(db: MomentumDb, id: string): Intent | null {
  const row = db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as
    IntentRow | undefined;
  return row ? intentFromRow(row) : null;
}

export function getIntentByIdempotencyKey(
  db: MomentumDb,
  idempotencyKey: string,
): Intent | null {
  const row = getIntentRowByIdempotencyKey(db, idempotencyKey);
  return row ? intentFromRow(row) : null;
}

export function listIntents(
  db: MomentumDb,
  options: ListIntentsOptions = {},
): Intent[] {
  const { where, params } = buildIntentsFilter(options);
  const limitClause =
    options.limit !== undefined && options.limit >= 0
      ? `LIMIT ${Math.floor(options.limit)}`
      : "";

  const rows = db
    .prepare(
      `SELECT *
         FROM intents
         ${where}
        ORDER BY created_at ASC, id ASC
        ${limitClause}`,
    )
    .all(...params) as IntentRow[];

  return rows.map(intentFromRow);
}

export type CountIntentsOptions = Omit<ListIntentsOptions, "limit">;

export function countIntents(
  db: MomentumDb,
  options: CountIntentsOptions = {},
): number {
  const { where, params } = buildIntentsFilter(options);
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM intents ${where}`)
    .get(...params) as { c: number } | undefined;
  return row?.c ?? 0;
}

function buildIntentsFilter(options: CountIntentsOptions): {
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
  if (options.trackerItemId !== undefined) {
    if (options.trackerItemId === null) {
      clauses.push("tracker_item_id IS NULL");
    } else {
      clauses.push("tracker_item_id = ?");
      params.push(options.trackerItemId);
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
 * Mark a pending intent as applied with a required operator reason. tracker-adapter code does
 * not perform the external write — this records the operator's manual or
 * out-of-band action. Refuses to transition from a terminal status so prior
 * decisions are not silently overwritten.
 */
export function markIntentApplied(
  db: MomentumDb,
  input: IntentDecisionInput,
): IntentDecisionResult {
  return transitionIntent(db, input, "applied");
}

/**
 * Mark a pending intent as skipped with a required operator reason. Skipping
 * captures "do not apply this intent" without canceling its provenance.
 */
export function markIntentSkipped(
  db: MomentumDb,
  input: IntentDecisionInput,
): IntentDecisionResult {
  return transitionIntent(db, input, "skipped");
}

/**
 * Cancel a pending intent with a required operator reason. Canceling is the
 * explicit "this intent is no longer relevant" decision; the row stays for
 * audit.
 */
export function cancelIntent(
  db: MomentumDb,
  input: IntentDecisionInput,
): IntentDecisionResult {
  return transitionIntent(db, input, "canceled");
}

function transitionIntent(
  db: MomentumDb,
  input: IntentDecisionInput,
  targetStatus: Exclude<IntentStatus, "pending">,
): IntentDecisionResult {
  validateNonEmpty(input.intentId, "intentId");
  validateNonEmpty(input.decisionReason, "decisionReason");
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("intent decision now must be a finite number");
  }

  const existing = getIntentRowById(db, input.intentId);
  if (!existing) {
    return {
      ok: false,
      code: "intent_not_found",
      message: `Intent not found: ${input.intentId}`,
    };
  }
  if (existing.status !== "pending") {
    return {
      ok: false,
      code: "intent_already_terminal",
      message: `Intent ${input.intentId} is already ${existing.status}; refusing to overwrite.`,
      currentStatus: existing.status,
    };
  }

  const appliedAt = targetStatus === "applied" ? now : null;
  const skippedAt = targetStatus === "skipped" ? now : null;
  const canceledAt = targetStatus === "canceled" ? now : null;

  const row = db
    .prepare(
      `UPDATE intents
          SET status = ?,
              decision_reason = ?,
              updated_at = ?,
              applied_at = ?,
              skipped_at = ?,
              canceled_at = ?
        WHERE id = ? AND status = 'pending'
        RETURNING *`,
    )
    .get(
      targetStatus,
      input.decisionReason,
      now,
      appliedAt,
      skippedAt,
      canceledAt,
      input.intentId,
    ) as IntentRow | undefined;

  if (!row) {
    const current = getIntentRowById(db, input.intentId);
    if (!current) {
      return {
        ok: false,
        code: "intent_not_found",
        message: `Intent disappeared during transition: ${input.intentId}`,
      };
    }
    return {
      ok: false,
      code: "intent_already_terminal",
      message: `Intent ${input.intentId} transitioned to ${current.status} concurrently; refusing to overwrite.`,
      currentStatus: current.status,
    };
  }

  return {
    ok: true,
    intent: intentFromRow(row),
    previousStatus: existing.status,
  };
}

function getIntentRowById(db: MomentumDb, id: string): IntentRow | undefined {
  return db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as
    IntentRow | undefined;
}

function getIntentRowByIdempotencyKey(
  db: MomentumDb,
  idempotencyKey: string,
): IntentRow | undefined {
  return db
    .prepare("SELECT * FROM intents WHERE idempotency_key = ?")
    .get(idempotencyKey) as IntentRow | undefined;
}

function intentFromRow(row: IntentRow): Intent {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    targetExternalId: row.target_external_id,
    intentType: row.intent_type,
    payload: parseJsonObject(row.payload_json),
    reason: row.reason,
    goalId: row.goal_id,
    trackerItemId: row.tracker_item_id,
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
    canceledAt: row.canceled_at,
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
    throw new Error(`intent ${name} must be a non-empty string`);
  }
}
