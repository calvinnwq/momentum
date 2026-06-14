import { randomUUID } from "node:crypto";

import type { MomentumDb } from "./adapters/db.js";

export const SOURCE_RECONCILIATION_RUN_STATES = [
  "running",
  "succeeded",
  "failed"
] as const;

export type SourceReconciliationRunState =
  (typeof SOURCE_RECONCILIATION_RUN_STATES)[number];

export type SourceReconciliationTerminalState = Extract<
  SourceReconciliationRunState,
  "succeeded" | "failed"
>;

export type SourceReconciliationRun = {
  id: string;
  adapterKind: string;
  state: SourceReconciliationRunState;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  itemsSeen: number;
  itemsUpserted: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type StartSourceReconciliationRunInput = {
  adapterKind: string;
  metadata?: Record<string, unknown>;
};

export type FinishSourceReconciliationRunInput = {
  runId: string;
  state: SourceReconciliationTerminalState;
  itemsSeen: number;
  itemsUpserted: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

export type ListSourceReconciliationRunsOptions = {
  adapterKind?: string;
};

export type SourceReconciliationRunClock = {
  now?: () => number;
};

type SourceReconciliationRunRow = {
  id: string;
  adapter_kind: string;
  state: SourceReconciliationRunState;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  items_seen: number;
  items_upserted: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

export function startSourceReconciliationRun(
  db: MomentumDb,
  input: StartSourceReconciliationRunInput,
  clock: SourceReconciliationRunClock = {}
): SourceReconciliationRun {
  validateAdapterKind(input.adapterKind);
  const now = clock.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const row = db
    .prepare(
      `INSERT INTO source_reconciliation_runs
         (id, adapter_kind, state, started_at, finished_at, error,
          items_seen, items_upserted, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'running', ?, NULL, NULL, 0, 0, ?, ?, ?)
       RETURNING *`
    )
    .get(
      `source_reconciliation_run_${randomUUID()}`,
      input.adapterKind,
      now,
      metadataJson,
      now,
      now
    ) as SourceReconciliationRunRow;

  return sourceReconciliationRunFromRow(row);
}

export function finishSourceReconciliationRun(
  db: MomentumDb,
  input: FinishSourceReconciliationRunInput,
  clock: SourceReconciliationRunClock = {}
): SourceReconciliationRun | null {
  validateRunId(input.runId);
  validateTerminalState(input.state);
  validateCount(input.itemsSeen, "itemsSeen");
  validateCount(input.itemsUpserted, "itemsUpserted");
  const now = clock.now?.() ?? Date.now();
  const existing = getSourceReconciliationRun(db, input.runId);
  if (!existing) return null;
  const metadataJson = JSON.stringify(input.metadata ?? existing.metadata);

  const row = db
    .prepare(
      `UPDATE source_reconciliation_runs
          SET state = ?,
              finished_at = ?,
              error = ?,
              items_seen = ?,
              items_upserted = ?,
              metadata_json = ?,
              updated_at = ?
        WHERE id = ? AND state = 'running'
        RETURNING *`
    )
    .get(
      input.state,
      now,
      input.error ?? null,
      input.itemsSeen,
      input.itemsUpserted,
      metadataJson,
      now,
      input.runId
    ) as SourceReconciliationRunRow | undefined;

  return row
    ? sourceReconciliationRunFromRow(row)
    : getSourceReconciliationRun(db, input.runId);
}

export function getSourceReconciliationRun(
  db: MomentumDb,
  runId: string
): SourceReconciliationRun | null {
  validateRunId(runId);
  const row = db
    .prepare("SELECT * FROM source_reconciliation_runs WHERE id = ?")
    .get(runId) as SourceReconciliationRunRow | undefined;
  return row ? sourceReconciliationRunFromRow(row) : null;
}

export function listSourceReconciliationRuns(
  db: MomentumDb,
  options: ListSourceReconciliationRunsOptions = {}
): SourceReconciliationRun[] {
  const rows = options.adapterKind === undefined
    ? (db
        .prepare(
          `SELECT *
             FROM source_reconciliation_runs
            ORDER BY started_at ASC, created_at ASC, id ASC`
        )
        .all() as SourceReconciliationRunRow[])
    : (db
        .prepare(
          `SELECT *
             FROM source_reconciliation_runs
            WHERE adapter_kind = ?
            ORDER BY started_at ASC, created_at ASC, id ASC`
        )
        .all(options.adapterKind) as SourceReconciliationRunRow[]);

  return rows.map(sourceReconciliationRunFromRow);
}

function sourceReconciliationRunFromRow(
  row: SourceReconciliationRunRow
): SourceReconciliationRun {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    itemsSeen: row.items_seen,
    itemsUpserted: row.items_upserted,
    metadata: parseMetadata(row.metadata_json),
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

function validateAdapterKind(adapterKind: string): void {
  if (adapterKind.length === 0) {
    throw new Error("source reconciliation adapterKind must be non-empty");
  }
}

function validateRunId(runId: string): void {
  if (runId.length === 0) {
    throw new Error("source reconciliation runId must be non-empty");
  }
}

function validateTerminalState(state: SourceReconciliationTerminalState): void {
  if (state !== "succeeded" && state !== "failed") {
    throw new Error(
      `source reconciliation terminal state must be 'succeeded' or 'failed', got ${state}`
    );
  }
}

function validateCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`source reconciliation ${name} must be a non-negative integer`);
  }
}
