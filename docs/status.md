# `status`

This page is the canonical reference for the `status` command — Momentum's
read-only goal-state inspector. It reads SQLite plus on-disk artifacts and
emits a stable JSON envelope (or human-readable text) that summarizes the
goal's current state, the active runner profile, the most recent iteration,
the reducer decision, the next queued job, the daemon run, the repo's
`MOMENTUM.md` policy state, linked source items, latest evidence, and
pending update intents.

See also:

- [`docs/daemon.md`](daemon.md) for the `daemon` sub-block source
  (`daemon_runs`) and the managed-loop semantics.
- [`docs/recovery.md`](recovery.md) for the `staleRecovery` and
  `needs_manual_recovery` surfaces aggregated here.
- [`docs/runners.md`](runners.md) for the `runnerProfile` catalog and the
  `MOMENTUM.md` policy loader surfaced by the `policy` block.
- [`docs/failure-reset.md`](failure-reset.md) for the per-iteration outcomes
  surfaced via `currentIterationDetail`.

## CLI shape

```text
momentum status [goal-id] [--data-dir <path>] [--json]
```

Omitting `goal-id` selects the most recently updated goal in the data
directory; when no goals exist the command exits non-zero with
`code: "no_goals"`. `--data-dir <path>` selects a non-default Momentum home
(otherwise `MOMENTUM_HOME` env / `~/.momentum` fallback). `--json` switches
between the human-readable text output and the machine-readable JSON
envelope documented below. The command only reads local SQLite and artifact
state; it does not consult live worker state.

## JSON envelope core keys

The JSON output includes the following top-level keys:

- `goalState` — the goal's current state (e.g., `queued`, `running`,
  `iteration_complete`, `completed`, `failed`, `needs_manual_recovery`).
- `runnerProfile` — `{kind, name, description, executes}` for the resolved
  built-in runner profile, or `null` when the stored runner name is not a
  built-in kind.
- `artifacts` — paths to goal-scoped artifacts (`goalMd`, `ledgerMd`,
  `handoffMd`, `handoffJson`, `recoveryMd`); each path entry includes
  `{path, exists}` so operators can see whether the file is present on
  disk. The `recoveryMd` entry is always emitted, regardless of whether
  the `recovery.md` artifact has been written, so callers can rely on the
  field being present.
- `currentIterationDetail` — the most recent iteration summary, including
  the verified commit SHA when present and the iteration outcome.
- `nextActionDetail` — a structured hint describing what the operator
  should do next.
- `latestCommitSha` — the commit SHA recorded for the most recent verified
  iteration.
- `daemon` — the daemon run summary (see below).
- `staleRecovery` — goal-scoped stale-lease counts (see below).
- `policy` — the repo's `MOMENTUM.md` policy summary (see below).

`latestJob` and `nextJob` (when present) include `idempotencyKey`, result
and error artifact paths, and lease timestamps.

## Reducer decision values

`currentIterationDetail` / `nextActionDetail` surface the reducer's stable
decision values:

- `continue` — the goal has more iterations to run.
- `goal_complete` — the runner reported `goal_complete: true` on a verified
  iteration.
- `max_iterations_reached` — the configured iteration cap was hit.
- `iteration_failed` — the most recent iteration failed and the goal moved
  to `failed`.

## Daemon sub-block

The `daemon` field is `null` when no daemon run has ever been recorded for
the selected data directory; otherwise it contains:

```json
{
  "runId": "daemon-...",
  "state": "running",
  "isActive": true,
  "isTerminal": false,
  "startedAt": "...",
  "heartbeatAt": "...",
  "finishedAt": null,
  "activeJob": { "jobId": "...", "lockId": "..." },
  "stopRequest": { "requestedAt": "...", "reason": "..." },
  "stopNowRequest": null,
  "cancelOutcome": null
}
```

`stopRequest`, `stopNowRequest`, and `cancelOutcome` each fall back to
`null` when the corresponding signal has not been recorded. See
[`docs/daemon.md`](daemon.md) for the full `daemon_runs` lifecycle and the
managed-loop semantics that drive these fields.

## staleRecovery sub-block

The `staleRecovery` field is goal-scoped and exposes goal-local
auto-recovery counts plus current pending-recovery counters:

- `recoveredRepoLockCount`, `recoveredJobCount` — counts of historical
  `repo_lock.recovered` and `job.recovered` events recorded for this goal.
- `latestRecoveredRepoLockAt`, `latestRecoveredJobAt` — most-recent
  timestamps for the above events (or `null` when none).
- `staleRepoLockCount`, `staleClaimedJobCount` — current goal-scoped
  records whose lease has expired and may need recovery.
- `staleLeaseGraceMs` — 5s default skew tolerance applied before treating a
  lease as stale.

See [`docs/recovery.md`](recovery.md) for the stale-lease auto-recovery
contract and the manual-recovery flag.

## Policy block (`MOMENTUM.md`)

The `policy` block reports the repo's `MOMENTUM.md` policy summary as
`{configured, present, path, hasNotes, config, error}` so operators can
verify that the loaded policy matches what the runner used. The
`Repo policy via MOMENTUM.md` reference lives in
[`docs/runners.md`](runners.md#repo-policy-via-momentummd).

## Source items and latest evidence

When the goal has linked source items, `sourceItems` is a non-empty array
of summaries — each `{id, adapterKind, externalId, externalKey, url,
title, status, lastObservedAt}`. Adapter metadata is intentionally
excluded from this surface; use `momentum source get` for the raw record.
When the goal has evidence records, `latestEvidence` is a newest-first
array of up to five summaries — each `{id, source, type, formatVersion,
occurredAt, summary, artifactPath, sourceItemId}` with no metadata
payload.

## Pending update intents

When the goal has pending update intents, `pendingUpdateIntents` is a
newest-first array of up to ten entries, each with `{intentId,
adapterKind, intentType, targetExternalId, reason, sourceItemId,
evidenceRecordId, createdAt, ageMs, stale}` plus an `externalApply`
block carrying `{applyState, totalAttempts, counts, latestAttempt}`.
`applyState` is `idle`, `in_flight`, or `blocked`; `counts` has
`claimed`, `succeeded`, `failed`, `blocked`, and `audit_incomplete`;
`latestAttempt` is the most recent audit row or `null` (see
[Audit row shape](intent-commands.md#audit-row-shape) for the full field
list). `intentStaleThresholdMs` carries the threshold used to compute the
per-intent `stale` flag (default 30 days). See
[`docs/intent-commands.md`](intent-commands.md) for the intent lifecycle
that consumes these entries.

The top-level `externalApply` block provides a goal-scoped rollup:

- `pendingIntentApplyStateCounts` — `{idle, in_flight, blocked}` counts across pending intents.
- `pendingAuditCounts` — `{claimed, succeeded, failed, blocked, audit_incomplete}` counts across pending intents.
- `totalAttempts` — total audit rows across pending intents.
- `latestAttempt` — the most recent audit row across pending intents (or `null`), prefixed with `intentId` to identify the source intent (see [Audit row shape](intent-commands.md#audit-row-shape) for the full field list).

## Text output

Text output mirrors the JSON envelope:

- `Runner: <name>` and, when the stored runner name is a built-in kind,
  `Runner profile: <name> (executes=true|false)`.
- An always-emitted `Recovery: present|missing (<path>)` line for the
  goal-scoped `recovery.md` artifact.
- A `Daemon:` line with state, active / terminal flags, and run ID; when
  present, `Daemon stop requested:`, `Daemon stop-now requested:`, and
  `Daemon cancel outcome:` lines.
- A `Stale recovery:` line when any recovered or pending stale counts are
  non-zero.
- A `Policy (MOMENTUM.md): ...` line describing whether the goal's repo
  policy is configured, present, missing, or errored.
- A `Source items:` section listing linked source items (adapter kind,
  external key / id, title, and status).
- A `Latest evidence:` section when linked evidence exists.
- A `Pending update intents:` section with a stale count suffix, per-intent
  lines showing ID, adapter/type, target, age, stale flag, apply state,
  attempt count, and latest audit lifecycle, the stale threshold, and a
  review hint.
- An `External apply` section with pending apply-state counts (`idle`,
  `in_flight`, `blocked`), audit lifecycle counts, total attempts, and the
  latest attempt summary (or `(none)`).

## Failure surfaces

- `code: "no_goals"` — exits non-zero when `goal-id` is omitted and no
  goals exist in the selected data directory.
- `code: "goal_not_found"` — exits non-zero when the supplied `goal-id`
  does not match any goal in the data directory.
