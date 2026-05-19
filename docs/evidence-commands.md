# Evidence commands

Operator-facing CLI envelopes for the `evidence ingest` and `evidence list` commands. These commands read local `.agent-workflows/<run-id>/` artifacts produced by external agent runs and persist normalized rows into the durable `evidence_records` table introduced by Milestone 5. Records are local-only: ingest neither calls external trackers nor mutates source items beyond opportunistically attaching `goalId` / `sourceItemId` links on the first ingest that supplies them.

See also:

- [docs/source-commands.md](source-commands.md) — `source` and `project status` envelopes; evidence records may optionally link to a `source_items` row.
- [docs/intent-commands.md](intent-commands.md) — `intent list` / `get` / `apply` / `skip` / `cancel` envelopes; the `intent list --evidence-record <id>` filter pivots from an evidence record to its derived intents.
- [docs/status.md](status.md) and [docs/handoff.md](handoff.md) — the per-goal `latestEvidence` / `latest_evidence` summaries.
- [docs/doctor.md](doctor.md) — the aggregate `evidence` block (`totalRecords`, `goalLinkedRecords`, `sourceItemLinkedRecords`, `lastRecord`).

## `evidence ingest`

```text
momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]
```

Reads local `.agent-workflows/<run-id>/` evidence artifacts and stores normalized rows in `evidence_records`. Supported inputs are a workflow directory or individual `plan.json`, `ledger.jsonl`, and `approval-*.json` files. Records are written with `source: "agent-workflow"`, `formatVersion: 1`, and a stable `ingestKey` derived from the artifact identity (so re-ingesting the same artifact maps to the same row).

`--goal` and `--source-item` are optional pre-checks: if either is supplied, ingest fails before parsing with `goal_not_found` or `source_item_not_found` when the referenced row does not exist. When both pre-checks succeed, the resolved `goalId` and `sourceItemId` are attached to newly created records.

Re-ingest is idempotent: records that already exist with the same `ingestKey` are reported as `skipped`. Replaying with a new `--goal` or `--source-item` argument opportunistically attaches the link when the existing record is still unlinked on that side, but never overwrites an already-linked record (the second link is reported as a diagnostic rather than mutated silently).

### JSON envelope

Success output includes:

- `ok`
- `command`
- `dataDir`
- `path`
- `goalId`
- `sourceItemId`
- `counts` — sub-object with `observed`, `created`, `skipped`, `diagnostics`, and `errors`
- `created` — array of newly inserted record summaries
- `skipped` — array of skipped (already-present) record summaries
- `diagnostics` — array of non-fatal format diagnostics
- `errors` — array of fatal per-file errors

Failure cases:

- `goal_not_found` — `--goal` resolved to no row; payload includes `goalId`.
- `source_item_not_found` — `--source-item` resolved to no row; payload includes `sourceItemId`.
- DB ingest failures during the write phase set `ok: false` and exit non-zero; the partial `counts` and any successful `created` rows are still surfaced for operator triage.

### Format diagnostic codes

Per-file diagnostics and errors share a stable code taxonomy:

- `evidence_format_unknown` — file path or step/status shape is not a recognized agent-workflow artifact. Reported as a diagnostic; does not fail the command.
- `evidence_format_invalid` — file is a recognized shape but contents are malformed JSON, unreadable, or fail schema validation. Reported as a diagnostic; does not by itself fail the command unless the DB write also fails.

Diagnostics never make the command exit non-zero on their own; only DB ingest errors and the pre-check refusals above set `ok: false`.

### Text output

When `--json` is omitted, ingest prints the resolved `path`, optional `--goal` / `--source-item` links, the `counts` summary, and the data directory.

## `evidence list`

```text
momentum evidence list [--goal <id>] [--source-item <id>] [--source <source>] [--type <type>] [--limit <n>] [--data-dir <path>] [--json]
```

Lists locally ingested evidence records ordered by `occurredAt` ascending. Filters compose: `--goal`, `--source-item`, `--source`, and `--type` narrow the result set, and `--limit <n>` caps the number of records returned (non-negative integer). Missing `--goal` / `--source-item` filters refuse with `goal_not_found` / `source_item_not_found` before scanning the table.

### JSON envelope

Output includes:

- `ok`
- `command`
- `dataDir`
- `filters` — active filter sub-object (`goalId`, `sourceItemId`, `source`, `type`, `limit`)
- `count` — number of records returned
- `records` — array of full record rows

Each `records` element exposes the full durable shape:

- `id`
- `source`
- `type`
- `formatVersion`
- `artifactPath`
- `externalId`
- `occurredAt`
- `summary`
- `metadata`
- `goalId`
- `sourceItemId`
- `ingestKey`
- `createdAt`
- `updatedAt`

### Text output

When `--json` is omitted, list prints the active filters and one summary line per record (source, type, `occurredAt`, summary preview, and the linked goal / source-item when present).

## Operator notes

- `evidence ingest` and `evidence list` are local-only surfaces. Neither reads from nor writes to external trackers; the `source: "agent-workflow"` records are produced by local agent runs and persisted into the Momentum data directory only.
- The `ingestKey` is the dedupe key for re-ingest idempotency. Operators replaying a workflow directory should expect the same artifacts to land in `skipped` on subsequent runs, with `goalId` / `sourceItemId` attached opportunistically when the existing record was still unlinked.
- For the cross-command surfaces that consume evidence records — `status` / `handoff` `latestEvidence`, `doctor` `evidence` aggregate, `project status` evidence-mismatch detection, and the `intent list --evidence-record <id>` pivot — see the linked operator-reference docs above.
