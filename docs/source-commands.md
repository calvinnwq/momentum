# Source commands

Operator-facing CLI envelopes for the `source list`, `source get`, `source link`, `source unlink`, `source reconcile linear`, and `project status` commands. These commands inspect, mutate links on, and reconcile durable `source_items` rows produced by source adapters, plus the deterministic project rollup that composes source items, evidence, and pending update intents into operator next-actions.

See also:

- [docs/intent-commands.md](intent-commands.md) — the `intent list` / `get` / `apply` / `skip` / `cancel` envelopes that the project rollup surfaces.
- [docs/status.md](status.md) and [docs/handoff.md](handoff.md) — linked `sourceItems` / `source_items` summaries on the per-goal inspectors.
- [docs/doctor.md](doctor.md) — the aggregate `sources` block (`totalSourceItems`, `linkedSourceItems`, `lastReconciliation`).

## `source list`

```text
momentum source list [--adapter <kind>] [--data-dir <path>] [--json]
```

Lists source items stored in the data directory. When `--adapter` is provided, filters to items from that adapter kind only.

JSON output includes `ok`, `command`, `dataDir`, `adapter`, `count`, an `items` array, and `lastReconciliation`. Each `items` element exposes:

- `id`
- `adapterKind`
- `externalId`
- `externalKey`
- `url`
- `title`
- `status`
- `metadata`
- `lastObservedAt`
- `goalId`
- `createdAt`
- `updatedAt`

`lastReconciliation` is the most recent `source_reconciliation_runs` row for the adapter (or `null` if none exists) with `id`, `adapterKind`, `state`, `itemsSeen`, `itemsUpserted`, `startedAt`, `finishedAt`, `error`, `metadata`, `paginationStopped`, `createdAt`, and `updatedAt`.

Text output lists adapter kind, external key / id, title, and status for each item, followed by a `Last reconciliation:` line showing adapter kind, state, item counts, and stop reason when available.

## `source get`

```text
momentum source get <source-item-id> [--data-dir <path>] [--json]
```

Retrieves a single source item by ID. JSON output includes `ok`, `command`, `dataDir`, and an `item` object with the full source item fields (`id`, `adapterKind`, `externalId`, `externalKey`, `url`, `title`, `status`, `metadata`, `lastObservedAt`, `goalId`, `createdAt`, `updatedAt`).

When the source item does not exist, exits non-zero with `code: "source_item_not_found"` and includes `sourceItemId` in the error payload. Text output shows adapter, external id, external key, URL, title, status, linked goal, and last-observed timestamp.

## `source link`

```text
momentum source link <source-item-id> --goal <goal-id> [--data-dir <path>] [--json]
```

Links a source item to a goal. A source item can be linked to at most one goal; attempting to link a source item already linked to a different goal fails with `code: "linked_to_other_goal"` (the payload includes `currentGoalId`).

Linking to the same goal again is idempotent: `changed` is `false` and `skippedReason` is `"already_linked_to_target"`.

JSON output includes `ok`, `command`, `dataDir`, `goalId`, `sourceItemId`, `changed`, `skippedReason`, `previousGoalId`, and `item` (the updated source item). Text output confirms the link and shows adapter, external key, title, and data dir.

On failure, exits non-zero with `code: "data_dir_failed"`, `"goal_not_found"`, `"source_item_not_found"`, `"linked_to_other_goal"`, or `"link_changed"`.

## `source unlink`

```text
momentum source unlink <source-item-id> [--data-dir <path>] [--json]
```

Unlinks a source item from its goal. Unlinking an already-unlinked source item is idempotent: `changed` is `false` and `previousGoalId` is `null`.

JSON output includes `ok`, `command`, `dataDir`, `sourceItemId`, `changed`, `previousGoalId`, and `item`. Text output confirms the unlink and shows adapter, title, and data dir.

On failure, exits non-zero with `code: "data_dir_failed"`, `"source_item_not_found"`, or `"link_changed"`.

## `source reconcile linear`

```text
momentum source reconcile linear [--project <id-or-name>] [--milestone <id-or-name>] [--dry-run] [--max-pages <n>] [--linear-endpoint <url>] [--linear-page-size <n>] [--data-dir <path>] [--json]
```

Reconciles Linear issues into durable `source_items` records by paginating the Linear GraphQL API. Requires the `LINEAR_API_KEY` environment variable. On success, creates or updates `source_items`, records a `source_snapshots` audit row for each persisted normalized Linear issue, and records a `source_reconciliation_runs` row summarizing the drain.

In non-dry-run mode, pages are persisted as they are observed, so a later auth / config / transport failure can exit non-zero after earlier pages have already updated local `source_items` and snapshots. Dry-run mode (`--dry-run`) records a reconciliation run and reports planned classifications without writing `source_items` or `source_snapshots`.

Pagination stops after 100 pages by default; `--max-pages` caps the drain. `--project` accepts a Linear project UUID or name; `--milestone` accepts a milestone UUID or name. `--linear-endpoint` overrides the default `https://api.linear.app/graphql`; `--linear-page-size` sets the page size (1–250, default 50).

JSON output includes:

- `ok`
- `command` (`source reconcile linear`)
- `dataDir`
- `adapter` (`linear`)
- `filters`
- `dryRun`
- `run` — the reconciliation run row: `id`, `adapterKind`, `state`, `startedAt`, `finishedAt`, `error`, `itemsSeen`, `itemsUpserted`, `metadata`, `paginationStopped`, `createdAt`, `updatedAt`.
- `counts` — `pages`, `itemsObserved`, `itemsCreated`, `itemsUpdated`, `itemsSkipped`, `itemsErrored`.
- `paginationStopped` — `reason`, `pageIndex`, `code`, `error`.
- `itemsSampled` — up to 25 items with `classification`, `externalId`, `externalKey`, `pageIndex`, `errorCode`, `error`.

On failure, exits non-zero with `ok: false` and one of `source_auth_unavailable`, `source_config_invalid`, `unsupported_source_adapter`, `data_dir_failed`, or `source_adapter_threw` in the error payload.

Text output shows the run state, run ID, page count, observed / created / updated / skipped / errored counts, stop reason, and an error line if applicable.

## `project status`

```text
momentum project status [--source <adapter>] [--project <id-or-name>] [--milestone <id-or-name>] [--stale-threshold-hours <n>] [--intent-stale-threshold-days <n>] [--data-dir <path>] [--json]
```

Computes the project rollup from local SQLite state only; it does not call source adapters or external APIs. `--source` filters by adapter kind, while `--project` and `--milestone` match either the `id` or `name` stored in SourceItem metadata.

`--stale-threshold-hours` controls when a last reconciliation run is reported as stale (default 24 hours). `--intent-stale-threshold-days` controls when a pending update intent is flagged as stale (default 30 days).

JSON output includes:

- `counts`
- `sourceItems`
- `mismatches`
- `reconciliationWarnings`
- `pendingUpdateIntents` — each entry includes a `stale` flag computed from the intent stale threshold
- `totalPendingUpdateIntentCount`
- `truncatedPendingUpdateIntents`
- `nextAction`

Source item and mismatch lists are truncated to the first 20 entries with total / truncated flags. Text output prints the active filters, count summaries, reconciliation warnings, top source items, mismatches, pending update intents, and next action.

Pending update intents include `intentId`, `adapterKind`, `intentType`, `targetExternalId`, `reason`, `goalId`, `sourceItemId`, `evidenceRecordId`, `createdAt`, `ageMs`, and `stale`.

### Stable operator-facing taxonomy values

The rollup exposes stable string enums so operators and tests can pattern-match on them:

- `mismatches[].kind` is one of `source_done_goal_not_terminal`, `goal_done_source_not_done`, `evidence_missing_after_completion`, or `manual_recovery_required`.
- `reconciliationWarnings[].reason` is one of `never_run`, `stale`, or `last_failed`.
- `nextAction.kind` is one of `manual_recovery_required`, `reconcile_failed`, `reconcile_stale_source`, `address_mismatch`, `review_pending_intents`, `missing_evidence`, or `no_action_required`.

`nextAction.detail` carries the matching goal IDs, adapter kind, reconciliation reason, error, or mismatch kind when applicable. `review_pending_intents` is ranked below `manual_recovery_required` but above `missing_evidence` and `no_action_required`.
