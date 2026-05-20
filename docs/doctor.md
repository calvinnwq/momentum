# `doctor`

This page is the canonical reference for the `doctor` command — Momentum's
first-sanity-check, orchestrator-health probe, and policy-file validator.

See also:

- [`docs/daemon.md`](daemon.md) for the daemon-readiness block's source
  (`daemon_runs`) and the managed-loop semantics.
- [`docs/recovery.md`](recovery.md) for the stale-lease and
  `needs_manual_recovery` surfaces aggregated by `doctor`.
- [`docs/runners.md`](runners.md) for the runner profile catalog and the
  `MOMENTUM.md` policy loader surfaced by `doctor --repo`.

## CLI shape

```text
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

Reports CLI version, Node.js version, platform, the current scope label,
and a compact daemon-readiness block. `--data-dir <path>` selects a
non-default Momentum home (otherwise `MOMENTUM_HOME` env / `~/.momentum`
fallback). `--repo <path>` opts the run into loading the repo's
`MOMENTUM.md` policy file for inspection; without `--repo`, the `policy`
block reports `repoConfigured: false` and skips file I/O. `--json` switches
between the human-readable text output and the machine-readable JSON envelope
shape documented below.

Useful as a first sanity check after install, as a quick orchestrator-health
probe before a large queued drain, and as a way to validate a repo's policy
file in isolation.

## Daemon-readiness JSON envelope

The daemon-readiness block is read from `daemon_runs` in the selected data
directory and exposes:

```json
{
  "ok": true,
  "dataDir": "/Users/operator/.momentum",
  "hasRun": true,
  "state": "running",
  "isActive": true,
  "stale": false,
  "staleRunCount": 0,
  "staleRepoLockCount": 0,
  "staleClaimedJobCount": 0,
  "goalsNeedingRecoveryCount": 0,
  "runId": "daemon-..."
}
```

On a failure (e.g., the database is unreadable) the block degrades to
`{ok: false, code, message}` instead of throwing. The stale-lease counts
surface orphaned repo locks and claimed/running jobs whose lease expired
more than `staleLeaseGraceMs` ago. The `goalsNeedingRecoveryCount` surface
shows how many goals currently have the durable `needs_manual_recovery`
flag set in the selected data directory (see [`docs/recovery.md`](recovery.md)
for the manual recovery contract).

## Runners block

The `runners` block in JSON output lists the built-in runner catalog:

- `supported` — current set of built-in runner profile names,
  `["fake", "trusted-shell", "acp"]`.
- `default` — the built-in default runner kind, `"fake"`.
- `profiles` — an array of `{kind, name, description, executes}` objects for
  each built-in runner.

All three profiles now have `executes: true`; `trusted-shell` runs the
operator-configured executable plus argv with no sandbox and no privilege
drop, and `acp` runs the configured ACP/acpx-style external agent runtime
with the same trust posture plus a stable `runtime_unavailable` code so
missing runtime or auth is distinct from command failures.

Text output includes a `runners:` line showing the supported kinds and the
default.

## Policy block (`MOMENTUM.md`)

The `policy` block in JSON output reports the repo's `MOMENTUM.md` state:

```json
{
  "repoConfigured": true,
  "repoPath": "/path/to/repo",
  "present": true,
  "path": "/path/to/repo/MOMENTUM.md",
  "hasNotes": false,
  "config": {
    "runner": { "kind": "trusted-shell", "name": "..." },
    "verification": ["pnpm", "test"],
    "verificationTimeoutSec": 600,
    "intentApplyPolicy": "create_intents_only"
  },
  "error": null,
  "effectiveIntentApply": {
    "intent_apply_policy": "create_intents_only",
    "source": "builtin_default"
  }
}
```

Without `--repo`, the block returns `repoConfigured: false`. With
`--repo <path>`, it loads the policy file from the repo root and surfaces
the parsed `config` (`runner` / `verification` / `verificationTimeoutSec` /
`intentApplyPolicy`) plus a stable `error` code on load failure:

- `policy_path_invalid`
- `policy_file_unreadable`
- `policy_parse_invalid`
- `policy_schema_invalid`

The `effectiveIntentApply` block in the policy payload reports the resolved
`intent_apply_policy` (`create_intents_only` by default, or
`external_apply_allowed` when set in `MOMENTUM.md`) and its `source`
(`builtin_default` or `momentum_policy`). Text output includes a
`policy (MOMENTUM.md):` line summarizing the repo policy load (including
`intent_apply_policy` and its source).

## Sources block

The JSON `sources` block reports SourceItem counts and the most recent
reconciliation run:

```json
{
  "ok": true,
  "totalSourceItems": 0,
  "linkedSourceItems": 0,
  "unlinkedSourceItems": 0,
  "lastReconciliation": {
    "id": "...",
    "adapterKind": "linear",
    "state": "succeeded",
    "startedAt": "...",
    "finishedAt": "...",
    "error": null,
    "itemsSeen": 0,
    "itemsUpserted": 0,
    "paginationStopped": false
  }
}
```

`lastReconciliation` is `null` when no runs exist; on failure the block
surfaces `ok: false` with `code` and `message`. Text output mirrors this
with a `sources:` line showing total / linked / unlinked counts plus the
last reconciliation run's adapter kind, state, items seen/upserted, and
stop reason (or reporting that no reconciliation runs have been recorded
yet).

## Evidence block

The JSON `evidence` block reports evidence-record counts and the latest
record:

```json
{
  "ok": true,
  "totalRecords": 0,
  "goalLinkedRecords": 0,
  "sourceItemLinkedRecords": 0,
  "lastRecord": {
    "id": "...",
    "source": "linear",
    "type": "comment",
    "occurredAt": "...",
    "summary": "...",
    "goalId": "...",
    "sourceItemId": "..."
  }
}
```

`lastRecord` is `null` when no evidence has been ingested. Text output
mirrors this with an `evidence:` count line and a last-record line.

## External apply block

The JSON `externalApply` block reports global audit-ledger state across
all update intents in the data directory:

```json
{
  "ok": true,
  "intentApplyStateCounts": { "idle": 0, "in_flight": 0, "blocked": 0 },
  "auditCounts": { "claimed": 0, "succeeded": 0, "failed": 0, "blocked": 0, "audit_incomplete": 0 },
  "totalAttempts": 0,
  "latestAttempt": null
}
```

- `intentApplyStateCounts` — `{idle, in_flight, blocked}` across all update intents (not just pending).
- `auditCounts` — `{claimed, succeeded, failed, blocked, audit_incomplete}` across all audit rows.
- `totalAttempts` — total audit rows.
- `latestAttempt` — the most recent audit row (or `null`), including `intentId`, `lifecycleState`, `resultStatus`, `resultCode`, `target`, `operatorReason`, `idempotencyMarker`, and `externalRefs`.

On a data-dir failure the block degrades to `{ok: false, code, message}`.
Text output includes `external apply:` lines showing idle/in_flight/blocked
intent counts, audit lifecycle counts, total attempts, and the latest
attempt (or `no attempts recorded yet`).
