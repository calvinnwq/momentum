# Intent commands

Operator-facing CLI envelopes for the `intent list`, `intent get`, `intent apply`, `intent skip`, and `intent cancel` commands. Intents are durable update-intent rows that source adapters and evidence ingestion record locally; today they never trigger automatic external tracker writes.

See also:

- [docs/source-commands.md](source-commands.md) — source-adapter commands that produce update intents.
- [docs/status.md](status.md) and [docs/handoff.md](handoff.md) — the `pendingUpdateIntents` / `pending_update_intents` summaries on the inspector commands, including the `externalApply` / `external_apply` rollup.
- [docs/doctor.md](doctor.md) — the `effectiveIntentApply` block (built-in default `create_intents_only` vs `external_apply_allowed` from `MOMENTUM.md`) and the `externalApply` audit-ledger aggregate.

## `intent list`

```text
momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]
```

Lists update intents stored in the data directory.

Filters:

- `--status` filters by intent status (`pending`, `applied`, `skipped`, or `canceled`).
- `--adapter` filters by adapter kind.
- `--type` filters by intent type (e.g. `source_satisfied`).
- `--goal`, `--source-item`, and `--evidence-record` filter by their respective linked IDs; at least one of goal, source-item, or evidence-record must exist.
- `--limit` caps the number of results.

JSON output includes `ok`, `command`, `dataDir`, active filter values, `count`, `totalAvailable`, `truncated`, and an `intents` array with full intent fields:

- `id`
- `adapterKind`
- `targetExternalId`
- `intentType`
- `payload`
- `reason`
- `goalId`
- `sourceItemId`
- `evidenceRecordId`
- `status`
- `idempotencyKey`
- `decisionReason`
- `errorCode`
- `errorMessage`
- `createdAt`
- `updatedAt`
- `appliedAt`
- `skippedAt`
- `canceledAt`

Each intent also carries an `externalApply` block:

- `intentId` — the intent this summary belongs to.
- `applyState` — the intent's current apply state: `idle`, `in_flight`, or `blocked`.
- `totalAttempts` — number of audit rows for this intent.
- `counts` — lifecycle counts: `claimed`, `succeeded`, `failed`, `blocked`, `audit_incomplete`.
- `latestAttempt` — the most recent audit row (or `null`), including `id`, `lifecycleState`, `resultStatus`, `resultCode`, `resultMessage`, `operatorReason`, `idempotencyMarker`, `target`, and `externalRefs`.

When no audit rows exist, `applyState` is `idle`, `totalAttempts` is 0, all lifecycle counts are 0, and `latestAttempt` is `null`.

`totalAvailable` is the total matching intent count regardless of `--limit`; `truncated` is `true` when results were capped.

Text output prints the active filters, total/truncation counts, and a summary line per intent including `apply=<state>`, `attempts=<n>`, and `latest=<lifecycle>`.

## `intent get`

```text
momentum intent get <intent-id> [--data-dir <path>] [--json]
```

Retrieves a single update intent by ID.

JSON output includes `ok`, `command`, `dataDir`, an `intent` object with all intent fields, and an `externalApply` block with the same shape as the per-intent `externalApply` in `intent list` — `intentId`, `applyState`, `totalAttempts`, `counts`, and `latestAttempt`. When the intent does not exist, exits non-zero with `code: "intent_not_found"` and includes `intentId` in the error payload. Text output shows the intent ID, adapter kind, target external ID, type, status, reason, linked goal/source-item/evidence-record IDs, timestamps, and the external apply state, attempt counts, and latest attempt details.

## `intent apply`

```text
momentum intent apply <intent-id> --reason <text> [--repo <path>] [--external-apply] [--data-dir <path>] [--json]
```

Marks a pending update intent as applied with the required `--reason`. The transition is idempotent: applying an already-applied intent returns `intent_already_terminal` with the current status.

Policy resolution:

- `--repo <path>` loads the repo's `MOMENTUM.md` policy file to resolve the effective `intent_apply_policy`.
- When `--repo` is not provided, the effective policy falls back to the built-in default (`create_intents_only`).
- `--external-apply` is **not currently supported** and always refuses with `code: "external_apply_unsupported"` regardless of the effective policy; Momentum does not perform automatic external tracker writes.

On success, JSON output includes `previousStatus` and the `intent` object. When `--external-apply` is requested, the response also includes an `applyPolicy` block:

- `effective` — the resolved `intent_apply_policy` value (`create_intents_only` or `external_apply_allowed`).
- `source` — `builtin_default` or `momentum_policy`.
- `externalApplyRequested` — `true` when `--external-apply` was passed.
- `externalApplyPerformed` — always `false` today.
- `note` — operator-facing explanation of the refusal.

On terminal refusal, JSON output includes `currentStatus` and `applyPolicy`.

## `intent skip`

```text
momentum intent skip <intent-id> --reason <text> [--data-dir <path>] [--json]
```

Marks a pending update intent as skipped with the required `--reason`. Refuses if the intent is already in a terminal state with `code: "intent_already_terminal"` and includes `currentStatus`. JSON output on success includes `previousStatus` and the `intent` object. Text output confirms the transition.

## `intent cancel`

```text
momentum intent cancel <intent-id> --reason <text> [--data-dir <path>] [--json]
```

Marks a pending update intent as canceled with the required `--reason`. Refuses if the intent is already in a terminal state with `code: "intent_already_terminal"` and includes `currentStatus`. JSON output on success includes `previousStatus` and the `intent` object. Text output confirms the transition.
