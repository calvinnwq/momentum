import { randomUUID } from "node:crypto";

import type { MomentumDb } from "../../adapters/db.js";

export type TrackerItem = {
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

export type TrackerItemSummary = {
  id: string;
  adapterKind: string;
  externalId: string;
  externalKey: string | null;
  url: string | null;
  title: string;
  status: string | null;
  lastObservedAt: number;
};

export type TrackerSnapshot = {
  id: string;
  trackerItemId: string;
  adapterKind: string;
  externalId: string;
  observedAt: number;
  snapshot: Record<string, unknown>;
  createdAt: number;
};

export type TrackerItemUpsertInput = {
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

export type TrackerSnapshotInput = {
  trackerItemId: string;
  adapterKind: string;
  externalId: string;
  observedAt: number;
  snapshot: Record<string, unknown>;
};

export type TrackerItemClock = {
  now?: () => number;
};

type TrackerItemRow = {
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

type TrackerSnapshotRow = {
  id: string;
  tracker_item_id: string;
  adapter_kind: string;
  external_id: string;
  observed_at: number;
  snapshot_json: string;
  created_at: number;
};

export function upsertTrackerItem(
  db: MomentumDb,
  input: TrackerItemUpsertInput,
  clock: TrackerItemClock = {},
): TrackerItem {
  const now = clock.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const hasGoalId = Object.hasOwn(input, "goalId");
  const row = db
    .prepare(
      `INSERT INTO tracker_items
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
           ELSE tracker_items.goal_id
         END,
         updated_at = excluded.updated_at
        WHERE excluded.last_observed_at >= tracker_items.last_observed_at
       RETURNING *`,
    )
    .get(
      `tracker_item_${randomUUID()}`,
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
      hasGoalId ? 1 : 0,
    ) as TrackerItemRow;

  return trackerItemFromRow(
    row ??
      getTrackerItemRowByAdapterExternalId(
        db,
        input.adapterKind,
        input.externalId,
      ),
  );
}

export function getTrackerItemById(
  db: MomentumDb,
  id: string,
): TrackerItem | null {
  const row = db.prepare("SELECT * FROM tracker_items WHERE id = ?").get(id) as
    TrackerItemRow | undefined;
  return row ? trackerItemFromRow(row) : null;
}

export function getTrackerItemByAdapterExternalId(
  db: MomentumDb,
  adapterKind: string,
  externalId: string,
): TrackerItem | null {
  const row = db
    .prepare(
      "SELECT * FROM tracker_items WHERE adapter_kind = ? AND external_id = ?",
    )
    .get(adapterKind, externalId) as TrackerItemRow | undefined;
  return row ? trackerItemFromRow(row) : null;
}

function getTrackerItemRowByAdapterExternalId(
  db: MomentumDb,
  adapterKind: string,
  externalId: string,
): TrackerItemRow {
  const row = db
    .prepare(
      "SELECT * FROM tracker_items WHERE adapter_kind = ? AND external_id = ?",
    )
    .get(adapterKind, externalId) as TrackerItemRow | undefined;
  if (!row) {
    throw new Error(
      `Tracker item missing after upsert conflict for adapter "${adapterKind}" and external id "${externalId}".`,
    );
  }
  return row;
}

export function listTrackerItems(
  db: MomentumDb,
  options: { adapterKind?: string } = {},
): TrackerItem[] {
  const rows =
    options.adapterKind === undefined
      ? (db
          .prepare(
            `SELECT *
             FROM tracker_items
            ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`,
          )
          .all() as TrackerItemRow[])
      : (db
          .prepare(
            `SELECT *
             FROM tracker_items
            WHERE adapter_kind = ?
            ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`,
          )
          .all(options.adapterKind) as TrackerItemRow[]);

  return rows.map(trackerItemFromRow);
}

export type LinkGoalToTrackerItemErrorCode =
  | "goal_not_found"
  | "tracker_item_not_found"
  | "linked_to_other_goal"
  | "link_changed";

export type LinkGoalToTrackerItemSkippedReason = "already_linked_to_target";

export type LinkGoalToTrackerItemResult =
  | {
      ok: true;
      changed: boolean;
      skippedReason: LinkGoalToTrackerItemSkippedReason | null;
      trackerItem: TrackerItem;
      previousGoalId: string | null;
    }
  | {
      ok: false;
      code: LinkGoalToTrackerItemErrorCode;
      message: string;
      currentGoalId?: string | null;
    };

export type UnlinkGoalFromTrackerItemErrorCode =
  "tracker_item_not_found" | "link_changed";

export type UnlinkGoalFromTrackerItemResult =
  | {
      ok: true;
      changed: boolean;
      trackerItem: TrackerItem;
      previousGoalId: string | null;
    }
  | {
      ok: false;
      code: UnlinkGoalFromTrackerItemErrorCode;
      message: string;
      currentGoalId?: string | null;
    };

export function linkGoalToTrackerItem(
  db: MomentumDb,
  input: { goalId: string; trackerItemId: string; now?: number },
): LinkGoalToTrackerItemResult {
  const goalExists = db
    .prepare("SELECT id FROM goals WHERE id = ?")
    .get(input.goalId) as { id: string } | undefined;
  if (!goalExists) {
    return {
      ok: false,
      code: "goal_not_found",
      message: `Goal not found: ${input.goalId}`,
    };
  }

  const existing = getTrackerItemById(db, input.trackerItemId);
  if (!existing) {
    return {
      ok: false,
      code: "tracker_item_not_found",
      message: `Tracker item not found: ${input.trackerItemId}`,
    };
  }

  if (existing.goalId === input.goalId) {
    return {
      ok: true,
      changed: false,
      skippedReason: "already_linked_to_target",
      trackerItem: existing,
      previousGoalId: existing.goalId,
    };
  }

  if (existing.goalId !== null && existing.goalId !== input.goalId) {
    return {
      ok: false,
      code: "linked_to_other_goal",
      message: `Tracker item ${input.trackerItemId} is already linked to goal ${existing.goalId}. Unlink it first.`,
      currentGoalId: existing.goalId,
    };
  }

  const now = input.now ?? Date.now();
  const row = db
    .prepare(
      `UPDATE tracker_items
          SET goal_id = ?, updated_at = ?
        WHERE id = ?
          AND goal_id IS NULL
        RETURNING *`,
    )
    .get(input.goalId, now, input.trackerItemId) as TrackerItemRow | undefined;
  if (!row) {
    const current = getTrackerItemById(db, input.trackerItemId);
    if (!current) {
      return {
        ok: false,
        code: "tracker_item_not_found",
        message: `Tracker item not found: ${input.trackerItemId}`,
      };
    }
    if (current.goalId === input.goalId) {
      return {
        ok: true,
        changed: false,
        skippedReason: "already_linked_to_target",
        trackerItem: current,
        previousGoalId: current.goalId,
      };
    }
    if (current.goalId === null) {
      return {
        ok: false,
        code: "link_changed",
        message: `Tracker item ${input.trackerItemId} link changed while linking; retry the operation.`,
        currentGoalId: null,
      };
    }
    return {
      ok: false,
      code: "linked_to_other_goal",
      message: `Tracker item ${input.trackerItemId} is already linked to goal ${current.goalId}. Unlink it first.`,
      currentGoalId: current.goalId,
    };
  }

  return {
    ok: true,
    changed: true,
    skippedReason: null,
    trackerItem: trackerItemFromRow(row),
    previousGoalId: existing.goalId,
  };
}

export function unlinkGoalFromTrackerItem(
  db: MomentumDb,
  input: { trackerItemId: string; now?: number },
): UnlinkGoalFromTrackerItemResult {
  const existing = getTrackerItemById(db, input.trackerItemId);
  if (!existing) {
    return {
      ok: false,
      code: "tracker_item_not_found",
      message: `Tracker item not found: ${input.trackerItemId}`,
    };
  }

  if (existing.goalId === null) {
    return {
      ok: true,
      changed: false,
      trackerItem: existing,
      previousGoalId: null,
    };
  }

  const now = input.now ?? Date.now();
  const row = db
    .prepare(
      `UPDATE tracker_items
          SET goal_id = NULL, updated_at = ?
        WHERE id = ?
          AND goal_id = ?
        RETURNING *`,
    )
    .get(now, input.trackerItemId, existing.goalId) as
    TrackerItemRow | undefined;
  if (!row) {
    const current = getTrackerItemById(db, input.trackerItemId);
    if (!current) {
      return {
        ok: false,
        code: "tracker_item_not_found",
        message: `Tracker item not found: ${input.trackerItemId}`,
      };
    }
    if (current.goalId === null) {
      return {
        ok: true,
        changed: false,
        trackerItem: current,
        previousGoalId: null,
      };
    }
    return {
      ok: false,
      code: "link_changed",
      message: `Tracker item ${input.trackerItemId} link changed to goal ${current.goalId}; retry after confirming the current link.`,
      currentGoalId: current.goalId,
    };
  }

  return {
    ok: true,
    changed: true,
    trackerItem: trackerItemFromRow(row),
    previousGoalId: existing.goalId,
  };
}

export function listTrackerItemSummariesForGoal(
  db: MomentumDb,
  goalId: string,
): TrackerItemSummary[] {
  const rows = db
    .prepare(
      `SELECT id, adapter_kind, external_id, external_key, url, title, status,
              last_observed_at
         FROM tracker_items
        WHERE goal_id = ?
        ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`,
    )
    .all(goalId) as Pick<
    TrackerItemRow,
    | "id"
    | "adapter_kind"
    | "external_id"
    | "external_key"
    | "url"
    | "title"
    | "status"
    | "last_observed_at"
  >[];

  return rows.map(trackerItemSummaryFromRow);
}

export function recordTrackerSnapshot(
  db: MomentumDb,
  input: TrackerSnapshotInput,
  clock: TrackerItemClock = {},
): TrackerSnapshot {
  const now = clock.now?.() ?? Date.now();
  const snapshotJson = JSON.stringify(input.snapshot);
  const row = db
    .prepare(
      `INSERT INTO tracker_snapshots
         (id, tracker_item_id, adapter_kind, external_id, observed_at,
          snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      `tracker_snapshot_${randomUUID()}`,
      input.trackerItemId,
      input.adapterKind,
      input.externalId,
      input.observedAt,
      snapshotJson,
      now,
    ) as TrackerSnapshotRow;

  return trackerSnapshotFromRow(row);
}

export function listTrackerSnapshotsForItem(
  db: MomentumDb,
  trackerItemId: string,
): TrackerSnapshot[] {
  const rows = db
    .prepare(
      `SELECT *
         FROM tracker_snapshots
        WHERE tracker_item_id = ?
        ORDER BY observed_at ASC, created_at ASC, id ASC`,
    )
    .all(trackerItemId) as TrackerSnapshotRow[];

  return rows.map(trackerSnapshotFromRow);
}

export function getLatestTrackerSnapshotForItem(
  db: MomentumDb,
  trackerItemId: string,
): TrackerSnapshot | null {
  const row = db
    .prepare(
      `SELECT *
         FROM tracker_snapshots
        WHERE tracker_item_id = ?
        ORDER BY observed_at DESC, created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(trackerItemId) as TrackerSnapshotRow | undefined;

  return row ? trackerSnapshotFromRow(row) : null;
}

function trackerItemFromRow(row: TrackerItemRow): TrackerItem {
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
    updatedAt: row.updated_at,
  };
}

function trackerItemSummaryFromRow(
  row: Pick<
    TrackerItemRow,
    | "id"
    | "adapter_kind"
    | "external_id"
    | "external_key"
    | "url"
    | "title"
    | "status"
    | "last_observed_at"
  >,
): TrackerItemSummary {
  return {
    id: row.id,
    adapterKind: row.adapter_kind,
    externalId: row.external_id,
    externalKey: row.external_key,
    url: row.url,
    title: row.title,
    status: row.status,
    lastObservedAt: row.last_observed_at,
  };
}

function trackerSnapshotFromRow(row: TrackerSnapshotRow): TrackerSnapshot {
  return {
    id: row.id,
    trackerItemId: row.tracker_item_id,
    adapterKind: row.adapter_kind,
    externalId: row.external_id,
    observedAt: row.observed_at,
    snapshot: parseMetadata(row.snapshot_json),
    createdAt: row.created_at,
  };
}

function parseMetadata(metadataJson: string): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
