import { randomUUID } from "node:crypto";

import type { MomentumDb } from "./adapters/db.js";

export type EvidenceRecord = {
  id: string;
  source: string;
  type: string;
  formatVersion: number;
  artifactPath: string | null;
  externalId: string | null;
  occurredAt: number;
  summary: string;
  metadata: Record<string, unknown>;
  goalId: string | null;
  sourceItemId: string | null;
  runId: string | null;
  stepId: string | null;
  ingestKey: string;
  createdAt: number;
  updatedAt: number;
};

export type EvidenceRecordIngestInput = {
  source: string;
  type: string;
  formatVersion?: number;
  artifactPath?: string | null;
  externalId?: string | null;
  occurredAt: number;
  summary: string;
  metadata?: Record<string, unknown>;
  goalId?: string | null;
  sourceItemId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  ingestKey: string;
};

export type EvidenceRecordIngestResult = {
  record: EvidenceRecord;
  created: boolean;
};

export type EvidenceRecordClock = {
  now?: () => number;
};

export type ListEvidenceRecordsOptions = {
  goalId?: string | null;
  sourceItemId?: string | null;
  source?: string;
  type?: string;
  limit?: number;
};

type EvidenceRecordRow = {
  id: string;
  source: string;
  type: string;
  format_version: number;
  artifact_path: string | null;
  external_id: string | null;
  occurred_at: number;
  summary: string;
  metadata_json: string;
  goal_id: string | null;
  source_item_id: string | null;
  run_id: string | null;
  step_id: string | null;
  ingest_key: string;
  created_at: number;
  updated_at: number;
};

export function ingestEvidenceRecord(
  db: MomentumDb,
  input: EvidenceRecordIngestInput,
  clock: EvidenceRecordClock = {}
): EvidenceRecordIngestResult {
  validateNonEmpty(input.source, "source");
  validateNonEmpty(input.type, "type");
  validateNonEmpty(input.ingestKey, "ingestKey");
  validateNonEmpty(input.summary, "summary");
  validateOccurredAt(input.occurredAt);
  const formatVersion = input.formatVersion ?? 1;
  validateFormatVersion(formatVersion);

  const now = clock.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const row = db
    .prepare(
      `INSERT INTO evidence_records
         (id, source, type, format_version, artifact_path, external_id,
          occurred_at, summary, metadata_json, goal_id, source_item_id,
          run_id, step_id, ingest_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ingest_key) DO NOTHING
       RETURNING *`
    )
    .get(
      `evidence_record_${randomUUID()}`,
      input.source,
      input.type,
      formatVersion,
      input.artifactPath ?? null,
      input.externalId ?? null,
      input.occurredAt,
      input.summary,
      metadataJson,
      input.goalId ?? null,
      input.sourceItemId ?? null,
      input.runId ?? null,
      input.stepId ?? null,
      input.ingestKey,
      now,
      now
    ) as EvidenceRecordRow | undefined;

  if (row) {
    return { record: evidenceRecordFromRow(row), created: true };
  }

  const existing = getEvidenceRecordRowByIngestKey(db, input.ingestKey);
  if (!existing) {
    throw new Error(
      `Evidence record missing after ingest conflict for ingest key "${input.ingestKey}".`
    );
  }

  const requestedGoalId = input.goalId ?? null;
  const requestedSourceItemId = input.sourceItemId ?? null;
  const requestedRunId = input.runId ?? null;
  const requestedStepId = input.stepId ?? null;
  const shouldAttachGoal = existing.goal_id === null && requestedGoalId !== null;
  const shouldAttachSourceItem =
    existing.source_item_id === null && requestedSourceItemId !== null;
  const shouldAttachRun = existing.run_id === null && requestedRunId !== null;
  const shouldAttachStep = existing.step_id === null && requestedStepId !== null;

  if (
    shouldAttachGoal ||
    shouldAttachSourceItem ||
    shouldAttachRun ||
    shouldAttachStep
  ) {
    db.prepare(
      `UPDATE evidence_records
          SET goal_id = CASE WHEN goal_id IS NULL THEN ? ELSE goal_id END,
              source_item_id = CASE WHEN source_item_id IS NULL THEN ? ELSE source_item_id END,
              run_id = CASE WHEN run_id IS NULL THEN ? ELSE run_id END,
              step_id = CASE WHEN step_id IS NULL THEN ? ELSE step_id END,
              updated_at = ?
        WHERE ingest_key = ?`
    ).run(
      requestedGoalId,
      requestedSourceItemId,
      requestedRunId,
      requestedStepId,
      now,
      input.ingestKey
    );
    const updated = getEvidenceRecordRowByIngestKey(db, input.ingestKey);
    if (!updated) {
      throw new Error(
        `Evidence record missing after attaching links for ingest key "${input.ingestKey}".`
      );
    }
    return { record: evidenceRecordFromRow(updated), created: false };
  }

  return { record: evidenceRecordFromRow(existing), created: false };
}

export function getEvidenceRecordById(
  db: MomentumDb,
  id: string
): EvidenceRecord | null {
  const row = db
    .prepare("SELECT * FROM evidence_records WHERE id = ?")
    .get(id) as EvidenceRecordRow | undefined;
  return row ? evidenceRecordFromRow(row) : null;
}

export function getEvidenceRecordByIngestKey(
  db: MomentumDb,
  ingestKey: string
): EvidenceRecord | null {
  const row = getEvidenceRecordRowByIngestKey(db, ingestKey);
  return row ? evidenceRecordFromRow(row) : null;
}

export function listEvidenceRecords(
  db: MomentumDb,
  options: ListEvidenceRecordsOptions = {}
): EvidenceRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

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
  if (options.source !== undefined) {
    clauses.push("source = ?");
    params.push(options.source);
  }
  if (options.type !== undefined) {
    clauses.push("type = ?");
    params.push(options.type);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitClause =
    options.limit !== undefined && options.limit >= 0
      ? `LIMIT ${Math.floor(options.limit)}`
      : "";

  const rows = db
    .prepare(
      `SELECT *
         FROM evidence_records
         ${where}
        ORDER BY occurred_at ASC, created_at ASC, id ASC
        ${limitClause}`
    )
    .all(...params) as EvidenceRecordRow[];

  return rows.map(evidenceRecordFromRow);
}

export function listLatestEvidenceRecordsForGoal(
  db: MomentumDb,
  goalId: string,
  limit = 5
): EvidenceRecord[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("listLatestEvidenceRecordsForGoal limit must be a non-negative integer");
  }
  const rows = db
    .prepare(
      `SELECT *
         FROM evidence_records
        WHERE goal_id = ?
        ORDER BY occurred_at DESC, created_at DESC, id DESC
        LIMIT ?`
    )
    .all(goalId, limit) as EvidenceRecordRow[];

  return rows.map(evidenceRecordFromRow);
}

export type EvidenceRecordsSummary = {
  totalRecords: number;
  goalLinkedRecords: number;
  sourceItemLinkedRecords: number;
  lastRecord: EvidenceRecord | null;
};

export function summarizeEvidenceRecords(db: MomentumDb): EvidenceRecordsSummary {
  const counts = db
    .prepare(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN goal_id IS NULL THEN 0 ELSE 1 END) AS goal_linked,
          SUM(CASE WHEN source_item_id IS NULL THEN 0 ELSE 1 END) AS source_item_linked
         FROM evidence_records`
    )
    .get() as
    | { total: number; goal_linked: number | null; source_item_linked: number | null }
    | undefined;

  const totalRecords = counts?.total ?? 0;
  const goalLinkedRecords = counts?.goal_linked ?? 0;
  const sourceItemLinkedRecords = counts?.source_item_linked ?? 0;

  if (totalRecords === 0) {
    return {
      totalRecords,
      goalLinkedRecords,
      sourceItemLinkedRecords,
      lastRecord: null
    };
  }

  const row = db
    .prepare(
      `SELECT *
         FROM evidence_records
        ORDER BY occurred_at DESC, created_at DESC, id DESC
        LIMIT 1`
    )
    .get() as EvidenceRecordRow | undefined;

  return {
    totalRecords,
    goalLinkedRecords,
    sourceItemLinkedRecords,
    lastRecord: row ? evidenceRecordFromRow(row) : null
  };
}

function getEvidenceRecordRowByIngestKey(
  db: MomentumDb,
  ingestKey: string
): EvidenceRecordRow | undefined {
  return db
    .prepare("SELECT * FROM evidence_records WHERE ingest_key = ?")
    .get(ingestKey) as EvidenceRecordRow | undefined;
}

function evidenceRecordFromRow(row: EvidenceRecordRow): EvidenceRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    formatVersion: row.format_version,
    artifactPath: row.artifact_path,
    externalId: row.external_id,
    occurredAt: row.occurred_at,
    summary: row.summary,
    metadata: parseMetadata(row.metadata_json),
    goalId: row.goal_id,
    sourceItemId: row.source_item_id,
    runId: row.run_id,
    stepId: row.step_id,
    ingestKey: row.ingest_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseMetadata(metadataJson: string): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function validateNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`evidence record ${name} must be a non-empty string`);
  }
}

function validateOccurredAt(value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("evidence record occurredAt must be an integer timestamp");
  }
}

function validateFormatVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("evidence record formatVersion must be a positive integer");
  }
}
