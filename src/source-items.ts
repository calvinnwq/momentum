import { randomUUID } from "node:crypto";

import type { MomentumDb } from "./db.js";

export type SourceItem = {
  id: string;
  adapterKind: string;
  externalId: string;
  externalKey: string | null;
  url: string | null;
  title: string;
  status: string | null;
  metadata: Record<string, unknown>;
  lastObservedAt: number;
  goalId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SourceItemSummary = {
  id: string;
  adapterKind: string;
  externalId: string;
  externalKey: string | null;
  url: string | null;
  title: string;
  status: string | null;
  lastObservedAt: number;
};

export type SourceItemUpsertInput = {
  adapterKind: string;
  externalId: string;
  externalKey?: string | null;
  url?: string | null;
  title: string;
  status?: string | null;
  metadata?: Record<string, unknown>;
  observedAt: number;
  goalId?: string | null;
};

export type SourceItemClock = {
  now?: () => number;
};

type SourceItemRow = {
  id: string;
  adapter_kind: string;
  external_id: string;
  external_key: string | null;
  url: string | null;
  title: string;
  status: string | null;
  metadata_json: string;
  last_observed_at: number;
  goal_id: string | null;
  created_at: number;
  updated_at: number;
};

export function upsertSourceItem(
  db: MomentumDb,
  input: SourceItemUpsertInput,
  clock: SourceItemClock = {}
): SourceItem {
  const now = clock.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const row = db
    .prepare(
      `INSERT INTO source_items
         (id, adapter_kind, external_id, external_key, url, title, status,
          metadata_json, last_observed_at, goal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter_kind, external_id) DO UPDATE SET
         external_key = excluded.external_key,
         url = excluded.url,
         title = excluded.title,
         status = excluded.status,
         metadata_json = excluded.metadata_json,
         last_observed_at = excluded.last_observed_at,
         goal_id = excluded.goal_id,
         updated_at = excluded.updated_at
       RETURNING *`
    )
    .get(
      `source_item_${randomUUID()}`,
      input.adapterKind,
      input.externalId,
      input.externalKey ?? null,
      input.url ?? null,
      input.title,
      input.status ?? null,
      metadataJson,
      input.observedAt,
      input.goalId ?? null,
      now,
      now
    ) as SourceItemRow;

  return sourceItemFromRow(row);
}

export function getSourceItemById(
  db: MomentumDb,
  id: string
): SourceItem | null {
  const row = db
    .prepare("SELECT * FROM source_items WHERE id = ?")
    .get(id) as SourceItemRow | undefined;
  return row ? sourceItemFromRow(row) : null;
}

export function listSourceItems(
  db: MomentumDb,
  options: { adapterKind?: string } = {}
): SourceItem[] {
  const rows = options.adapterKind === undefined
    ? (db
        .prepare(
          `SELECT *
             FROM source_items
            ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`
        )
        .all() as SourceItemRow[])
    : (db
        .prepare(
          `SELECT *
             FROM source_items
            WHERE adapter_kind = ?
            ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`
        )
        .all(options.adapterKind) as SourceItemRow[]);

  return rows.map(sourceItemFromRow);
}

export function listSourceItemSummariesForGoal(
  db: MomentumDb,
  goalId: string
): SourceItemSummary[] {
  const rows = db
    .prepare(
      `SELECT id, adapter_kind, external_id, external_key, url, title, status,
              last_observed_at
         FROM source_items
        WHERE goal_id = ?
        ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`
    )
    .all(goalId) as Pick<
    SourceItemRow,
    | "id"
    | "adapter_kind"
    | "external_id"
    | "external_key"
    | "url"
    | "title"
    | "status"
    | "last_observed_at"
  >[];

  return rows.map(sourceItemSummaryFromRow);
}

function sourceItemFromRow(row: SourceItemRow): SourceItem {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    externalId: row.external_id,
    externalKey: row.external_key,
    url: row.url,
    title: row.title,
    status: row.status,
    metadata: parseMetadata(row.metadata_json),
    lastObservedAt: row.last_observed_at,
    goalId: row.goal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sourceItemSummaryFromRow(
  row: Pick<
    SourceItemRow,
    | "id"
    | "adapter_kind"
    | "external_id"
    | "external_key"
    | "url"
    | "title"
    | "status"
    | "last_observed_at"
  >
): SourceItemSummary {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    externalId: row.external_id,
    externalKey: row.external_key,
    url: row.url,
    title: row.title,
    status: row.status,
    lastObservedAt: row.last_observed_at
  };
}

function parseMetadata(metadataJson: string): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
