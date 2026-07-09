# Evidence commands

Operator-facing CLI envelopes for the `evidence ingest` and `evidence list` commands. These commands read local `.agent-workflows/<run-id>/` artifacts produced by external agent runs and persist normalized rows into the durable `evidence_records` table. Records are local-only: ingest neither calls external trackers nor mutates source items beyond opportunistically attaching `goalId` / `sourceItemId` links and typed workflow `runId` / `stepId` links when supplied.

See also:

- [docs/source-commands.md](source-commands.md) — `source` and `project status` envelopes; evidence records may optionally link to a `source_items` row.
- [docs/intent-commands.md](intent-commands.md) — `intent list` / `get` / `apply` / `skip` / `cancel` envelopes; the `intent list --evidence-record <id>` filter pivots from an evidence record to its derived intents.
- [docs/workflow-commands.md](workflow-commands.md) — the `workflow status` / `workflow handoff` / `workflow run logs` surfaces that attach run- and step-linked evidence.
- [docs/doctor.md](doctor.md) — the aggregate `evidence` block (`totalRecords`, `goalLinkedRecords`, `sourceItemLinkedRecords`, `lastRecord`).

## `evidence ingest`

```text
momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]
```

Reads local `.agent-workflows/<run-id>/` evidence artifacts and stores normalized rows in `evidence_records`. Supported inputs are a workflow directory or individual `plan.json`, `ledger.jsonl`, and `approval-*.json` files. Records are written with `source: "agent-workflow"`, `formatVersion: 1`, typed `runId` / `stepId` linkage when the artifact identifies a workflow run, and a stable `ingestKey` derived from the artifact identity (so re-ingesting the same artifact maps to the same row).

`--goal` and `--source-item` are optional pre-checks: if either is supplied, ingest fails before parsing with `goal_not_found` or `source_item_not_found` when the referenced row does not exist. When both pre-checks succeed, the resolved `goalId` and `sourceItemId` are attached to newly created records.

Re-ingest is idempotent: records that already exist with the same `ingestKey` are reported as `skipped`. Replaying with a new `--goal` / `--source-item` argument or workflow artifact linkage opportunistically attaches `goalId`, `sourceItemId`, `runId`, or `stepId` when the existing record is still unlinked on that side, but never overwrites an already-linked record.

### JSON envelope

Success output includes:

- `ok`
- `command`
- `dataDir`
- `path`
- `goalId`
- `sourceItemId`
- `counts` — sub-object with `observed`, `created`, `skipped`, `diagnostics`, and `errors`
- `created` — array of newly inserted record summaries (each entry includes `runId` and `stepId` when the ingested artifact came from a workflow directory)
- `skipped` — array of skipped (already-present) record summaries, including any linkage attached during idempotent replay
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
- `runId` — owning workflow run ID when ingested from a `.agent-workflows/<runId>/` directory; `null` for non-workflow evidence.
- `stepId` — owning step ID for ledger step events; `null` for run-scoped artifacts (plan, approval) and non-workflow evidence.
- `ingestKey`
- `createdAt`
- `updatedAt`

### Text output

When `--json` is omitted, list prints the active filters and one summary line per record (source, type, `occurredAt`, summary preview, the linked goal / source-item when present, and `run=<runId>` / `step=<stepId>` annotations when the record carries typed workflow linkage).

## Operator notes

- `evidence ingest` and `evidence list` are local-only surfaces. Neither reads from nor writes to external trackers; the `source: "agent-workflow"` records are produced by local agent runs and persisted into the Momentum data directory only.
- `.agent-workflows/` is repo-local agent evidence and is ignored by git by default.
- The `ingestKey` is the dedupe key for re-ingest idempotency. Operators replaying a workflow directory should expect the same artifacts to land in `skipped` on subsequent runs, with `goalId` / `sourceItemId` / `runId` / `stepId` attached opportunistically when the existing record was still unlinked.
- For the cross-command surfaces that consume evidence records — `status` / `handoff` `latestEvidence`, `doctor` `evidence` aggregate, `project status` evidence-mismatch detection, and the `intent list --evidence-record <id>` pivot — see the linked operator-reference docs above.
