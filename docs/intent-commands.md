# Intent commands

Operator-facing CLI envelopes for the `intent list`, `intent get`, `intent apply`, `intent skip`, and `intent cancel` commands. Intents are durable update-intent rows that source adapters and evidence ingestion record locally; the CLI applies one explicitly selected intent via `intent apply --external-apply` (gated by `MOMENTUM.md` `intent_apply_policy`). Bounded workflow daemon execution reuses that same policy-gated apply path for a built-in `linear-refresh` / `external-apply` step only after proving repo policy, Linear auth, the run issue scope, a matching source item, one pending Linear `status_update` intent or deterministic seed evidence for the expected intent, a valid one-of `state` / `stateId` payload, and a stable idempotency marker, or after matching already-successful audit evidence that can be reconciled without another Linear mutation.

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
- `latestAttempt` — the most recent audit row (or `null`); see [Audit row shape](#audit-row-shape) for the full field list.

When no audit rows exist, `applyState` is `idle`, `totalAttempts` is 0, all lifecycle counts are 0, and `latestAttempt` is `null`.

### Audit row shape

The `latestAttempt` audit row (emitted by `intent list`, `intent get`, `momentum status`, `momentum handoff`, `momentum project status`, and `momentum doctor`) carries:

- `id`
- `adapterKind`
- `provider`
- `target` — `{externalId, externalKey, url, title}` for the resolved external target.
- `requestedAt`
- `finishedAt`
- `operatorReason`
- `operatorActor`
- `intentApplyPolicy`
- `allowStatusMutation`
- `mutationKind`
- `previewSummary`
- `idempotencyMarker`
- `lifecycleState` — one of `claimed`, `succeeded`, `failed`, `blocked`, `audit_incomplete`.
- `resultStatus`
- `resultCode`
- `resultMessage`
- `externalRefs` — `{commentId, commentUrl, stateTransitionId}` for any external writes produced.
- `reconcile` — `{status, warning}` from the post-apply reconcile step. `status` is one of `success`, `stale_source`, `mismatch_persists`, `refresh_failed`, `post_apply_reconcile_failed`, `targeted_refresh_unsupported`, `pending`, `deferred`, or `null`. `warning` is `null` on success; otherwise it carries a human-readable detail string.
- `createdAt`
- `updatedAt`

Rollup surfaces also prepend `intentId` to identify the source intent. `momentum handoff` emits the same fields in snake_case.

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
- `--external-apply` performs a policy-gated external tracker write through the adapter's external update client. It requires a `--repo` context whose `MOMENTUM.md` sets `intent_apply_policy: external_apply_allowed`, a resolved target issue, and the adapter's credential env var (`LINEAR_API_KEY` for the linear adapter). The write is a two-phase audit-before-write flow that is idempotent under replay; `source_satisfied` is comment-only, while Linear `status_update` intents must carry exactly one non-empty payload field, `state` or `stateId`, and perform a comment plus status transition.

Without `--external-apply`, `intent apply` records the operator's manual mark only and does not contact the external tracker.

On success, JSON output includes `previousStatus` and the `intent` object. When `--external-apply` is requested, the response also includes an `applyPolicy` block:

- `effective` — the resolved `intent_apply_policy` value (`create_intents_only` or `external_apply_allowed`).
- `source` — `builtin_default` or `momentum_policy`.
- `externalApplyRequested` — `true` when `--external-apply` was passed.
- `externalApplyPerformed` — `true` whenever the external write reached the tracker, including the partial-apply `audit_incomplete` refusal where the write succeeded but post-write finalization did not; `false` on refusals that never wrote to the tracker.
- `note` — operator-facing explanation of the policy.

When `--external-apply` is requested, JSON output also includes an `externalApply` block with the resolved adapter, target reference, audit id, reconcile status, and (on success) external refs (`issueId`, `issueKey`, `issueUrl`, `commentId`, `commentUrl`, `statusTransitioned`, `nextStateId`, `nextStateName`, `idempotencyMarker`, `alreadyApplied`). The `reconcile.status` field is `success` when the post-apply single-issue refresh confirmed the idempotency marker on Linear and updated the local SourceItem snapshot; `mismatch_persists` when the marker was not found in Linear comments; `stale_source` when Linear no longer recognizes the target; `refresh_failed` on transient refresh errors; `post_apply_reconcile_failed` on unexpected reconcile failures; `targeted_refresh_unsupported` for adapters that do not support targeted refresh; `pending` or `deferred` when reconcile was not attempted (early refusal or audit-incomplete paths); or `null` when no reconcile context applies. Text output prints `Reconcile: <status>` when a reconcile status is present and appends the reconcile warning in parentheses when one exists.

`--external-apply` refusal codes (intent stays pending unless otherwise noted):

- `policy_denied` — no `--repo` context, or the effective `intent_apply_policy` is not `external_apply_allowed`.
- `policy_load_failed` — `--repo`'s `MOMENTUM.md` failed to parse.
- `auth_unavailable` — the adapter's credential env var (e.g. `LINEAR_API_KEY`) is unset in the process that is applying the intent.
- `unsupported_adapter` / `unsupported_intent_type` — the intent's adapter or intent type is not supported by any registered external update adapter.
- `target_missing` — no resolved external target id on the intent or its linked source item.
- `intent_apply_in_progress` — a concurrent apply holds the CAS guard on this intent.
- `intent_blocked` — a prior post-write audit failure left the intent in a non-replay `blocked` apply state. See [docs/recovery.md](recovery.md#intent-apply-blocked-state) for how the blocked state surfaces; no operator surface for clearing it exists yet.
- `preview_failed` / `validation_failed` / `target_missing` — preview or target validation failed before the external write; no audit row is created unless the failure occurs after the audit claim.
- `external_conflict` / `write_rejected` / `write_timeout` / `malformed_response` / `adapter_threw` — the external write client refused or could not complete the mutation; the audit row is finalized as `failed` when one exists, and the intent returns to idle.
- `audit_incomplete` — the audit finalize could not complete after an attempted external write; the intent transitions to `blocked` apply state, which has no clearing surface yet, so the intent stays blocked and operators inspect the audit row to confirm the write's effect. See [docs/recovery.md](recovery.md#intent-apply-blocked-state) for the surfaces that expose the blocked state.

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
