/**
 * Linear source reconciliation orchestrator (NGX-289 / M5-02 second slice).
 *
 * This module composes:
 *   - the read-only Linear `SourceAdapter` (normalization boundary), and
 *   - the durable `source_items` / `source_reconciliation_runs` storage
 *
 * into a deterministic, single-process orchestrator that drains a paginated
 * Linear client into SourceItem records and records a single
 * `source_reconciliation_runs` row that summarizes the whole drain.
 *
 * Design notes:
 *   - The orchestrator accepts an async `LinearReconciliationClient` so that
 *     the real Linear HTTP client can perform network I/O; `node:sqlite`
 *     writes remain synchronous within the orchestrator loop.
 *   - Pages are persisted as they are observed so that partial failures
 *     (auth revoked on page N, transient adapter error) do not lose earlier
 *     successfully observed items.
 *   - Dry-run still records a `source_reconciliation_runs` row so operators
 *     have an audit trail of what was planned, but it never writes
 *     `source_items` and never mutates existing item rows.
 *   - Item classification (created / updated / skipped / errored) is derived
 *     by inspecting the existing row before each upsert; the orchestrator is
 *     single-process and there is no in-orchestrator race to worry about.
 *   - Detailed counts and per-page stop reasons live in
 *     `source_reconciliation_runs.metadata_json` to avoid a schema migration
 *     in this slice. The existing `items_seen` / `items_upserted` columns
 *     stay populated for backward compatibility.
 */

import type { MomentumDb } from "./db.js";
import { normalizeLinearIssue, LINEAR_SOURCE_ADAPTER_KIND } from "./linear-source-adapter.js";
import type { LinearSourceAdapterFilters } from "./linear-source-adapter.js";
import {
  getSourceItemByAdapterExternalId,
  upsertSourceItem,
  type SourceItem
} from "./source-items.js";
import {
  finishSourceReconciliationRun,
  startSourceReconciliationRun,
  type SourceReconciliationRun,
  type SourceReconciliationTerminalState
} from "./source-reconciliation-runs.js";
import type { SourceAdapterErrorCode } from "./source-adapter.js";

export type LinearReconciliationFilters = LinearSourceAdapterFilters;

export type LinearReconciliationPage = {
  issues: readonly unknown[];
  nextCursor: string | null;
};

export type LinearReconciliationFetchPageInput = {
  cursor: string | null;
  filters: LinearReconciliationFilters;
};

export type LinearReconciliationFetchPageErrorCode = Extract<
  SourceAdapterErrorCode,
  "source_auth_unavailable" | "source_config_invalid" | "source_adapter_threw"
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
  | LinearReconciliationFetchPageSuccess
  | LinearReconciliationFetchPageError;

export type LinearReconciliationClient = {
  fetchPage: (
    input: LinearReconciliationFetchPageInput
  ) => LinearReconciliationFetchPageResult | Promise<LinearReconciliationFetchPageResult>;
};

export type ReconcileLinearSourceInput = {
  client: LinearReconciliationClient;
  filters?: LinearReconciliationFilters;
  dryRun?: boolean;
  maxPages?: number;
};

export type ReconcileLinearSourceClock = {
  now?: () => number;
};

export type LinearReconciliationItemClassification =
  | "created"
  | "updated"
  | "skipped"
  | "error";

export type LinearReconciliationItemOutcome = {
  classification: LinearReconciliationItemClassification;
  externalId: string | null;
  externalKey: string | null;
  pageIndex: number;
  errorCode?: SourceAdapterErrorCode;
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

export type ReconcileLinearSourceResult = {
  run: SourceReconciliationRun;
  counts: LinearReconciliationCounts;
  items: LinearReconciliationItemOutcome[];
  paginationStopped: LinearReconciliationStop;
};

const DEFAULT_MAX_PAGES = 100;

export async function reconcileLinearSource(
  db: MomentumDb,
  input: ReconcileLinearSourceInput,
  clock: ReconcileLinearSourceClock = {}
): Promise<ReconcileLinearSourceResult> {
  const filters = input.filters ?? {};
  const dryRun = input.dryRun === true;
  const maxPages = resolveMaxPages(input.maxPages);
  const startMetadata = { filters, dryRun };

  const startedRun = startSourceReconciliationRun(
    db,
    { adapterKind: LINEAR_SOURCE_ADAPTER_KIND, metadata: startMetadata },
    clock
  );

  const items: LinearReconciliationItemOutcome[] = [];
  const counts: LinearReconciliationCounts = {
    pages: 0,
    itemsObserved: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    itemsErrored: 0
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
          error: response.error
        };
        break;
      }
      counts.pages += 1;
      processPage(db, response.page.issues, pageIndex, dryRun, items, counts, clock);
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
      code: "source_adapter_threw",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const terminalState: SourceReconciliationTerminalState =
    stop && stop.reason !== "complete" && stop.reason !== "max_pages"
      ? "failed"
      : "succeeded";
  const errorText = buildErrorText(stop);
  const finishMetadata = {
    filters,
    dryRun,
    counts,
    paginationStopped: stop ?? { reason: "complete", pageIndex }
  };

  const finishedRun = finishSourceReconciliationRun(
    db,
    {
      runId: startedRun.id,
      state: terminalState,
      itemsSeen: counts.itemsObserved,
      itemsUpserted: dryRun ? 0 : counts.itemsCreated + counts.itemsUpdated,
      error: errorText,
      metadata: finishMetadata
    },
    clock
  );

  return {
    run: finishedRun ?? startedRun,
    counts,
    items,
    paginationStopped: stop ?? { reason: "complete", pageIndex }
  };
}

function processPage(
  db: MomentumDb,
  rawIssues: readonly unknown[],
  pageIndex: number,
  dryRun: boolean,
  items: LinearReconciliationItemOutcome[],
  counts: LinearReconciliationCounts,
  clock: ReconcileLinearSourceClock
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
        error: normalized.error
      });
      continue;
    }
    const item = normalized.item;
    const existing = findExistingSourceItem(db, item.externalId);
    if (existing && existing.lastObservedAt > item.observedAt) {
      counts.itemsSkipped += 1;
      items.push({
        classification: "skipped",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex
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
          pageIndex
        });
      } else {
        counts.itemsCreated += 1;
        items.push({
          classification: "created",
          externalId: item.externalId,
          externalKey: item.externalKey ?? null,
          pageIndex
        });
      }
      continue;
    }
    upsertSourceItem(
      db,
      {
        adapterKind: LINEAR_SOURCE_ADAPTER_KIND,
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        url: item.url ?? null,
        title: item.title,
        status: item.status ?? null,
        metadata: item.metadata ?? {},
        observedAt: item.observedAt
      },
      clock
    );
    if (existing) {
      counts.itemsUpdated += 1;
      items.push({
        classification: "updated",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex
      });
    } else {
      counts.itemsCreated += 1;
      items.push({
        classification: "created",
        externalId: item.externalId,
        externalKey: item.externalKey ?? null,
        pageIndex
      });
    }
  }
}

function findExistingSourceItem(
  db: MomentumDb,
  externalId: string
): SourceItem | null {
  return getSourceItemByAdapterExternalId(db, LINEAR_SOURCE_ADAPTER_KIND, externalId);
}

function readRawString(raw: unknown, field: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`reconcileLinearSource maxPages must be a positive integer, got ${maxPages}`);
  }
  return maxPages;
}

function stopReasonForCode(
  code: LinearReconciliationFetchPageErrorCode
): LinearReconciliationStopReason {
  switch (code) {
    case "source_auth_unavailable":
      return "auth_unavailable";
    case "source_config_invalid":
      return "config_invalid";
    case "source_adapter_threw":
      return "adapter_threw";
  }
}

function buildErrorText(stop: LinearReconciliationStop | null): string | null {
  if (!stop) return null;
  if (stop.reason === "complete" || stop.reason === "max_pages") return null;
  const code = stop.code ?? "source_adapter_threw";
  return `${code}: ${stop.error ?? "linear pagination halted"}`;
}
