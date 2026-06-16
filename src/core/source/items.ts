import { randomUUID } from "node:crypto";

import type { MomentumDb } from "../../adapters/db.js";

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

export type SourceSnapshot = {
  id: string;
  sourceItemId: string;
  adapterKind: string;
  externalId: string;
  observedAt: number;
  snapshot: Record<string, unknown>;
  createdAt: number;
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

export type SourceSnapshotInput = {
  sourceItemId: string;
  adapterKind: string;
  externalId: string;
  observedAt: number;
  snapshot: Record<string, unknown>;
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

type SourceSnapshotRow = {
  id: string;
  source_item_id: string;
  adapter_kind: string;
  external_id: string;
  observed_at: number;
  snapshot_json: string;
  created_at: number;
};

export function upsertSourceItem(
  db: MomentumDb,
  input: SourceItemUpsertInput,
  clock: SourceItemClock = {}
): SourceItem {
  const now = clock.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const hasGoalId = Object.hasOwn(input, "goalId");
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
         goal_id = CASE
           WHEN ? = 1 THEN excluded.goal_id
           ELSE source_items.goal_id
         END,
         updated_at = excluded.updated_at
        WHERE excluded.last_observed_at >= source_items.last_observed_at
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
      now,
      hasGoalId ? 1 : 0
    ) as SourceItemRow;

  return sourceItemFromRow(
    row ??
      getSourceItemRowByAdapterExternalId(db, input.adapterKind, input.externalId)
  );
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

export function getSourceItemByAdapterExternalId(
  db: MomentumDb,
  adapterKind: string,
  externalId: string
): SourceItem | null {
  const row = db
    .prepare(
      "SELECT * FROM source_items WHERE adapter_kind = ? AND external_id = ?"
    )
    .get(adapterKind, externalId) as SourceItemRow | undefined;
  return row ? sourceItemFromRow(row) : null;
}

function getSourceItemRowByAdapterExternalId(
  db: MomentumDb,
  adapterKind: string,
  externalId: string
): SourceItemRow {
  const row = db
    .prepare(
      "SELECT * FROM source_items WHERE adapter_kind = ? AND external_id = ?"
    )
    .get(adapterKind, externalId) as SourceItemRow | undefined;
  if (!row) {
    throw new Error(
      `Source item missing after upsert conflict for adapter "${adapterKind}" and external id "${externalId}".`
    );
  }
  return row;
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

export type LinkGoalToSourceItemErrorCode =
  | "goal_not_found"
  | "source_item_not_found"
  | "linked_to_other_goal"
  | "link_changed";

export type LinkGoalToSourceItemSkippedReason =
  | "already_linked_to_target";

export type LinkGoalToSourceItemResult =
  | {
      ok: true;
      changed: boolean;
      skippedReason: LinkGoalToSourceItemSkippedReason | null;
      sourceItem: SourceItem;
      previousGoalId: string | null;
    }
  | {
      ok: false;
      code: LinkGoalToSourceItemErrorCode;
      message: string;
      currentGoalId?: string | null;
    };

export type UnlinkGoalFromSourceItemErrorCode =
  | "source_item_not_found"
  | "link_changed";

export type UnlinkGoalFromSourceItemResult =
  | {
      ok: true;
      changed: boolean;
      sourceItem: SourceItem;
      previousGoalId: string | null;
    }
  | {
      ok: false;
      code: UnlinkGoalFromSourceItemErrorCode;
      message: string;
      currentGoalId?: string | null;
    };

export function linkGoalToSourceItem(
  db: MomentumDb,
  input: { goalId: string; sourceItemId: string; now?: number }
): LinkGoalToSourceItemResult {
  const goalExists = db
    .prepare("SELECT id FROM goals WHERE id = ?")
    .get(input.goalId) as { id: string } | undefined;
  if (!goalExists) {
    return {
      ok: false,
      code: "goal_not_found",
      message: `Goal not found: ${input.goalId}`
    };
  }

  const existing = getSourceItemById(db, input.sourceItemId);
  if (!existing) {
    return {
      ok: false,
      code: "source_item_not_found",
      message: `Source item not found: ${input.sourceItemId}`
    };
  }

  if (existing.goalId === input.goalId) {
    return {
      ok: true,
      changed: false,
      skippedReason: "already_linked_to_target",
      sourceItem: existing,
      previousGoalId: existing.goalId
    };
  }

  if (existing.goalId !== null && existing.goalId !== input.goalId) {
    return {
      ok: false,
      code: "linked_to_other_goal",
      message: `Source item ${input.sourceItemId} is already linked to goal ${existing.goalId}. Unlink it first.`,
      currentGoalId: existing.goalId
    };
  }

  const now = input.now ?? Date.now();
  const row = db
    .prepare(
      `UPDATE source_items
          SET goal_id = ?, updated_at = ?
        WHERE id = ?
          AND goal_id IS NULL
        RETURNING *`
    )
    .get(input.goalId, now, input.sourceItemId) as SourceItemRow | undefined;
  if (!row) {
    const current = getSourceItemById(db, input.sourceItemId);
    if (!current) {
      return {
        ok: false,
        code: "source_item_not_found",
        message: `Source item not found: ${input.sourceItemId}`
      };
    }
    if (current.goalId === input.goalId) {
      return {
        ok: true,
        changed: false,
        skippedReason: "already_linked_to_target",
        sourceItem: current,
        previousGoalId: current.goalId
      };
    }
    if (current.goalId === null) {
      return {
        ok: false,
        code: "link_changed",
        message: `Source item ${input.sourceItemId} link changed while linking; retry the operation.`,
        currentGoalId: null
      };
    }
    return {
      ok: false,
      code: "linked_to_other_goal",
      message: `Source item ${input.sourceItemId} is already linked to goal ${current.goalId}. Unlink it first.`,
      currentGoalId: current.goalId
    };
  }

  return {
    ok: true,
    changed: true,
    skippedReason: null,
    sourceItem: sourceItemFromRow(row),
    previousGoalId: existing.goalId
  };
}

export function unlinkGoalFromSourceItem(
  db: MomentumDb,
  input: { sourceItemId: string; now?: number }
): UnlinkGoalFromSourceItemResult {
  const existing = getSourceItemById(db, input.sourceItemId);
  if (!existing) {
    return {
      ok: false,
      code: "source_item_not_found",
      message: `Source item not found: ${input.sourceItemId}`
    };
  }

  if (existing.goalId === null) {
    return {
      ok: true,
      changed: false,
      sourceItem: existing,
      previousGoalId: null
    };
  }

  const now = input.now ?? Date.now();
  const row = db
    .prepare(
      `UPDATE source_items
          SET goal_id = NULL, updated_at = ?
        WHERE id = ?
          AND goal_id = ?
        RETURNING *`
    )
    .get(now, input.sourceItemId, existing.goalId) as SourceItemRow | undefined;
  if (!row) {
    const current = getSourceItemById(db, input.sourceItemId);
    if (!current) {
      return {
        ok: false,
        code: "source_item_not_found",
        message: `Source item not found: ${input.sourceItemId}`
      };
    }
    if (current.goalId === null) {
      return {
        ok: true,
        changed: false,
        sourceItem: current,
        previousGoalId: null
      };
    }
    return {
      ok: false,
      code: "link_changed",
      message: `Source item ${input.sourceItemId} link changed to goal ${current.goalId}; retry after confirming the current link.`,
      currentGoalId: current.goalId
    };
  }

  return {
    ok: true,
    changed: true,
    sourceItem: sourceItemFromRow(row),
    previousGoalId: existing.goalId
  };
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

export function recordSourceSnapshot(
  db: MomentumDb,
  input: SourceSnapshotInput,
  clock: SourceItemClock = {}
): SourceSnapshot {
  const now = clock.now?.() ?? Date.now();
  const snapshotJson = JSON.stringify(input.snapshot);
  const row = db
    .prepare(
      `INSERT INTO source_snapshots
         (id, source_item_id, adapter_kind, external_id, observed_at,
          snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      `source_snapshot_${randomUUID()}`,
      input.sourceItemId,
      input.adapterKind,
      input.externalId,
      input.observedAt,
      snapshotJson,
      now
    ) as SourceSnapshotRow;

  return sourceSnapshotFromRow(row);
}

export function listSourceSnapshotsForItem(
  db: MomentumDb,
  sourceItemId: string
): SourceSnapshot[] {
  const rows = db
    .prepare(
      `SELECT *
         FROM source_snapshots
        WHERE source_item_id = ?
        ORDER BY observed_at ASC, created_at ASC, id ASC`
    )
    .all(sourceItemId) as SourceSnapshotRow[];

  return rows.map(sourceSnapshotFromRow);
}

export function getLatestSourceSnapshotForItem(
  db: MomentumDb,
  sourceItemId: string
): SourceSnapshot | null {
  const row = db
    .prepare(
      `SELECT *
         FROM source_snapshots
        WHERE source_item_id = ?
        ORDER BY observed_at DESC, created_at DESC, id DESC
        LIMIT 1`
    )
    .get(sourceItemId) as SourceSnapshotRow | undefined;

  return row ? sourceSnapshotFromRow(row) : null;
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

function sourceSnapshotFromRow(row: SourceSnapshotRow): SourceSnapshot {
  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    adapterKind: row.adapter_kind,
    externalId: row.external_id,
    observedAt: row.observed_at,
    snapshot: parseMetadata(row.snapshot_json),
    createdAt: row.created_at
  };
}

function parseMetadata(metadataJson: string): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
