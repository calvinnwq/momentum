/**
 * Linear tracker reconciliation orchestrator.
 *
 * This module composes:
 *   - the read-only Linear `TrackerAdapter` (normalization boundary), and
 *   - the durable `tracker_items` / `tracker_snapshots` /
 *     `tracker_reconciliation_runs` storage
 *
 * into a deterministic, single-process orchestrator that drains a paginated
 * Linear client into TrackerItem records and records a single
 * `tracker_reconciliation_runs` row that summarizes the whole drain.
 *
 * Design notes:
 *   - The orchestrator accepts an async `LinearReconciliationClient` so that
 *     the real Linear HTTP client can perform network I/O; `node:sqlite`
 *     writes remain synchronous within the orchestrator loop.
 *   - Pages are persisted as they are observed so that partial failures
 *     (auth revoked on page N, transient adapter error) do not lose earlier
 *     successfully observed items.
 *   - Dry-run still records a `tracker_reconciliation_runs` row so operators
 *     have an audit trail of what was planned, but it never writes
 *     `tracker_items` / `tracker_snapshots` and never mutates existing item rows.
 *   - Item classification (created / updated / skipped / errored) is derived
 *     by inspecting the existing row before each upsert; the orchestrator is
 *     single-process and there is no in-orchestrator race to worry about.
 *   - Detailed counts and per-page stop reasons live in
 *     `tracker_reconciliation_runs.metadata_json` to avoid a schema migration
 *     in this slice. The existing `items_seen` / `items_upserted` columns
 *     stay populated for backward compatibility.
 */

import type { MomentumDb } from "../../adapters/db.js";
import {
  normalizeLinearIssue,
  LINEAR_TRACKER_ADAPTER_KIND,
} from "../../adapters/linear-tracker-adapter.js";
import type { LinearTrackerAdapterFilters } from "../../adapters/linear-tracker-adapter.js";
import {
  getTrackerItemByAdapterExternalId,
  recordTrackerSnapshot,
  upsertTrackerItem,
  type TrackerItem,
} from "./items.js";
import {
  finishTrackerReconciliationRun,
  startTrackerReconciliationRun,
  type TrackerReconciliationRun,
  type TrackerReconciliationTerminalState,
} from "./reconciliation-runs.js";
import type { TrackerAdapterErrorCode } from "../../adapters/tracker-adapter.js";

export type LinearReconciliationFilters = LinearTrackerAdapterFilters;

export type LinearReconciliationPage = {
  issues: readonly unknown[];
  nextCursor: string | null;
};

export type LinearReconciliationFetchPageInput = {
  cursor: string | null;
  filters: LinearReconciliationFilters;
};

export type LinearReconciliationFetchPageErrorCode = Extract<
  TrackerAdapterErrorCode,
  | "tracker_auth_unavailable"
  | "tracker_config_invalid"
  | "tracker_adapter_threw"
>;

export type LinearReconciliationFetchPageError = {
  ok: false;
  code: LinearReconciliationFetchPageErrorCode;
  error: string;
};

export type LinearReconciliationFetchPageSuccess = {
  ok: true;
  page: LinearReconciliationPage;
};

export type LinearReconciliationFetchPageResult =
  LinearReconciliationFetchPageSuccess | LinearReconciliationFetchPageError;

export type LinearReconciliationClient = {
  fetchPage: (
    input: LinearReconciliationFetchPageInput,
  ) =>
    | LinearReconciliationFetchPageResult
    | Promise<LinearReconciliationFetchPageResult>;
};

export type ReconcileLinearTrackerInput = {
  client: LinearReconciliationClient;
  filters?: LinearReconciliationFilters;
  dryRun?: boolean;
  maxPages?: number;
};

export type ReconcileLinearTrackerClock = {
  now?: () => number;
};

export type LinearReconciliationItemClassification =
  "created" | "updated" | "skipped" | "error";

export type LinearReconciliationItemOutcome = {
  classification: LinearReconciliationItemClassification;
  externalId: string | null;
  externalKey: string | null;
  pageIndex: number;
  errorCode?: TrackerAdapterErrorCode;
  error?: string;
};

export type LinearReconciliationCounts = {
  pages: number;
  itemsObserved: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsSkipped: number;
  itemsErrored: number;
};

export type LinearReconciliationStopReason =
  | "complete"
  | "max_pages"
  | "auth_unavailable"
  | "config_invalid"
  | "adapter_threw";

export type LinearReconciliationStop = {
  reason: LinearReconciliationStopReason;
  pageIndex: number;
  code?: LinearReconciliationFetchPageErrorCode;
  error?: string;
};

export type ReconcileLinearTrackerResult = {
  run: TrackerReconciliationRun;
  counts: LinearReconciliationCounts;
  items: LinearReconciliationItemOutcome[];
  paginationStopped: LinearReconciliationStop;
};

const DEFAULT_MAX_PAGES = 100;

export async function reconcileLinearTracker(
  db: MomentumDb,
  input: ReconcileLinearTrackerInput,
  clock: ReconcileLinearTrackerClock = {},
): Promise<ReconcileLinearTrackerResult> {
  const filters = input.filters ?? {};
  const dryRun = input.dryRun === true;
  const maxPages = resolveMaxPages(input.maxPages);
  const startMetadata = { filters, dryRun };

  const startedRun = startTrackerReconciliationRun(
    db,
    { adapterKind: LINEAR_TRACKER_ADAPTER_KIND, metadata: startMetadata },
    clock,
  );

  const items: LinearReconciliationItemOutcome[] = [];
  const counts: LinearReconciliationCounts = {
    pages: 0,
    itemsObserved: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    itemsErrored: 0,
  };

  let cursor: string | null = null;
  let pageIndex = 0;
  let stop: LinearReconciliationStop | null = null;

  try {
    while (true) {
      if (counts.pages >= maxPages) {
        stop = { reason: "max_pages", pageIndex };
        break;
      }
      pageIndex += 1;
      const response = await input.client.fetchPage({ cursor, filters });
      if (!response.ok) {
        stop = {
          reason: stopReasonForCode(response.code),
          pageIndex,
          code: response.code,
          error: response.error,
        };
        break;
      }
      counts.pages += 1;
      processPage(
        db,
        response.page.issues,
        pageIndex,
        dryRun,
        items,
        counts,
        clock,
      );
      if (response.page.nextCursor === null) {
        stop = { reason: "complete", pageIndex };
        break;
      }
      cursor = response.page.nextCursor;
    }
  } catch (err) {
    stop = {
      reason: "adapter_threw",
      pageIndex,
      code: "tracker_adapter_threw",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const terminalState: TrackerReconciliationTerminalState =
    stop && stop.reason !== "complete" && stop.reason !== "max_pages"
      ? "failed"
      : "succeeded";
  const errorText = buildErrorText(stop);
  const finishMetadata = {
    filters,
    dryRun,
    counts,
    paginationStopped: stop ?? { reason: "complete", pageIndex },
  };

  const finishedRun = finishTrackerReconciliationRun(
    db,
    {
      runId: startedRun.id,
      state: terminalState,
      itemsSeen: counts.itemsObserved,
      itemsUpserted: dryRun ? 0 : counts.itemsCreated + counts.itemsUpdated,
      error: errorText,
      metadata: finishMetadata,
    },
    clock,
  );

  return {
    run: finishedRun ?? startedRun,
    counts,
    items,
    paginationStopped: stop ?? { reason: "complete", pageIndex },
  };
}

function processPage(
  db: MomentumDb,
  rawIssues: readonly unknown[],
  pageIndex: number,
  dryRun: boolean,
  items: LinearReconciliationItemOutcome[],
  counts: LinearReconciliationCounts,
  clock: ReconcileLinearTrackerClock,
): void {
  for (const raw of rawIssues) {
    counts.itemsObserved += 1;
    const normalized = normalizeLinearIssue(raw);
    if (!normalized.ok) {
      counts.itemsErrored += 1;
      items.push({
        classification: "error",
        externalId: readRawString(raw, "id"),
        externalKey: readRawString(raw, "identifier"),
        pageIndex,
        errorCode: normalized.code,
        error: normalized.error,
      });
      continue;
    }
    const item = normalized.item;
    const existing = findExistingTrackerItem(db, item.externalId);
    if (existing && existing.lastObservedAt > item.observedAt) {
      counts.itemsSkipped += 1;
      items.push({
        classification: "skipped",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex,
      });
      continue;
    }
    if (dryRun) {
      if (existing) {
        counts.itemsUpdated += 1;
        items.push({
          classification: "updated",
          externalId: item.externalId,
          externalKey: item.externalKey ?? null,
          pageIndex,
        });
      } else {
        counts.itemsCreated += 1;
        items.push({
          classification: "created",
          externalId: item.externalId,
          externalKey: item.externalKey ?? null,
          pageIndex,
        });
      }
      continue;
    }
    const persistedItem = upsertTrackerItem(
      db,
      {
        adapterKind: LINEAR_TRACKER_ADAPTER_KIND,
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        url: item.url ?? null,
        title: item.title,
        status: item.status ?? null,
        metadata: item.metadata ?? {},
        observedAt: item.observedAt,
      },
      clock,
    );
    recordTrackerSnapshot(
      db,
      {
        trackerItemId: persistedItem.id,
        adapterKind: LINEAR_TRACKER_ADAPTER_KIND,
        externalId: item.externalId,
        observedAt: item.observedAt,
        snapshot: snapshotPayloadForItem(item.metadata ?? {}),
      },
      clock,
    );
    if (existing) {
      counts.itemsUpdated += 1;
      items.push({
        classification: "updated",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex,
      });
    } else {
      counts.itemsCreated += 1;
      items.push({
        classification: "created",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex,
      });
    }
  }
}

function findExistingTrackerItem(
  db: MomentumDb,
  externalId: string,
): TrackerItem | null {
  return getTrackerItemByAdapterExternalId(
    db,
    LINEAR_TRACKER_ADAPTER_KIND,
    externalId,
  );
}

function readRawString(raw: unknown, field: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(
      `reconcileLinearTracker maxPages must be a positive integer, got ${maxPages}`,
    );
  }
  return maxPages;
}

function stopReasonForCode(
  code: LinearReconciliationFetchPageErrorCode,
): LinearReconciliationStopReason {
  switch (code) {
    case "tracker_auth_unavailable":
      return "auth_unavailable";
    case "tracker_config_invalid":
      return "config_invalid";
    case "tracker_adapter_threw":
      return "adapter_threw";
  }
}

function buildErrorText(stop: LinearReconciliationStop | null): string | null {
  if (!stop) return null;
  if (stop.reason === "complete" || stop.reason === "max_pages") return null;
  const code = stop.code ?? "tracker_adapter_threw";
  return `${code}: ${stop.error ?? "linear pagination halted"}`;
}

function snapshotPayloadForItem(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const raw = metadata["raw"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return metadata;
}
