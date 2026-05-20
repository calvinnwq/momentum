# `handoff`

This page is the canonical reference for the `handoff` command — Momentum's
operator handoff renderer. It reads the same SQLite + on-disk state that
`status` reads and emits two artifacts into the goal's directory:
`handoff.md` (human-readable markdown) and `handoff.json` (schema v1
machine-readable envelope). Both render the reducer decision, next-job
details, daemon run summary, `MOMENTUM.md` policy summary, linked source
items, latest evidence, and pending update intents.

See also:

- [`docs/status.md`](status.md) for the camelCase JSON inspector counterpart
  that reads the same state without writing artifacts.
- [`docs/daemon.md`](daemon.md) for the `daemon` sub-block source
  (`daemon_runs`) and the managed-loop semantics.
- [`docs/recovery.md`](recovery.md) for the `stale_recovery` and
  `needs_manual_recovery` surfaces aggregated here.
- [`docs/runners.md`](runners.md) for the `runner_profile` catalog and the
  `MOMENTUM.md` policy loader surfaced by the `policy` block.
- [`docs/failure-reset.md`](failure-reset.md) for the per-iteration outcomes
  surfaced via `current_iteration_detail`.

## CLI shape

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

`--data-dir <path>` selects a non-default Momentum home (otherwise
`MOMENTUM_HOME` env / `~/.momentum` fallback). `--json` switches between
the markdown-style stdout summary and the machine-readable JSON envelope
documented below. Every invocation writes (or rewrites) `handoff.md` and
`handoff.json` into `<data-dir>/goals/<goal-id>/`.

## JSON envelope (schema v1)

`handoff.json` is rendered as schema v1 and uses snake_case keys (in
contrast with `status`'s camelCase). Top-level keys include:

- `goal_state` — the goal's current state (e.g., `queued`, `running`,
  `iteration_complete`, `completed`, `failed`, `needs_manual_recovery`).
- `goal` — the goal record, plus:
  - `runner` — the stored runner name.
  - `runner_profile` — `{kind, name, description, executes}` for the
    resolved built-in runner profile, or `null` when the stored runner
    name is not a built-in kind.
- `current_iteration_detail` — the most recent iteration summary,
  including the verified commit SHA when present and the iteration
  outcome.
- `next_action_detail` — a structured hint describing what the operator
  should do next.
- `latest_commit_sha` — the commit SHA recorded for the most recent
  verified iteration.
- `daemon` — the daemon run summary (see below).
- `stale_recovery` — goal-scoped stale-lease counts (see below).
- `policy` — the repo's `MOMENTUM.md` policy summary (see below).
- `source_items` — present only when source items are linked to the goal.
- `latest_evidence` — present only when evidence records are linked.
- `pending_update_intents` — present only when the goal has pending
  intents.
- `intent_stale_threshold_ms` — threshold used to compute per-intent
  staleness (default 30 days).
- `latest_job` / `next_job` — when present, include `idempotency_key`,
  result / error artifact paths, and lease timestamps.

## Runner result error surface

When the latest job points at a runner result artifact that is missing,
unreadable, malformed, or fails the normalized `RunnerResult` schema,
`handoff.json` includes `runner_result_error` with a stable
operator-readable message instead of silently returning `null`. The
markdown mirrors this with a `Runner result read error` line. Empty
content and the initialized `{}` result scaffold remain a non-error null
result, so operators only see this diagnostic for real malformed result
artifacts.

## Artifacts block

The `artifacts` block enumerates the goal-scoped artifact paths and
includes `recovery_md` showing the path to the goal-scoped `recovery.md`
file. The `artifact_files` block includes `recovery_md` as a boolean
indicating whether the file exists on disk. The markdown artifact list
shows `recovery.md` with a `(present)` suffix when the file exists and
`(missing)` otherwise, mirroring the boolean in `artifact_files`.

## Daemon sub-block

The `daemon` field is `null` when no daemon run has ever been recorded for
the selected data directory; otherwise it contains:

```json
{
  "run_id": "daemon-...",
  "state": "running",
  "is_active": true,
  "is_terminal": false,
  "started_at": "...",
  "heartbeat_at": "...",
  "finished_at": null,
  "active_job": { "job_id": "...", "lock_id": "..." },
  "stop_request": { "requested_at": "...", "reason": "..." },
  "stop_now_request": null,
  "cancel_outcome": null
}
```

`stop_request`, `stop_now_request`, and `cancel_outcome` each fall back to
`null` when the corresponding signal has not been recorded. See
[`docs/daemon.md`](daemon.md) for the full `daemon_runs` lifecycle and the
managed-loop semantics that drive these fields.

## stale_recovery sub-block

The `stale_recovery` field is goal-scoped and exposes goal-local
auto-recovery counts plus current pending-recovery counters:

- `recovered_repo_lock_count`, `recovered_job_count` — counts of
  historical `repo_lock.recovered` and `job.recovered` events recorded for
  this goal.
- `latest_recovered_repo_lock_at`, `latest_recovered_job_at` —
  most-recent timestamps for the above events (or `null` when none).
- `stale_repo_lock_count`, `stale_claimed_job_count` — current
  goal-scoped records whose lease has expired and may need recovery.
- `stale_lease_grace_ms` — 5s default skew tolerance applied before
  treating a lease as stale.

See [`docs/recovery.md`](recovery.md) for the stale-lease auto-recovery
contract and the manual-recovery flag.

## Policy block (`MOMENTUM.md`)

The `policy` block reports the repo's `MOMENTUM.md` policy summary as
`{configured, present, path, has_notes, config, error}`. The `config`
field carries `runner` / `verification` / `verification_timeout_sec` (or
`null` when absent). The markdown renders a `## Policy (MOMENTUM.md)`
section describing whether the goal's repo policy is configured, present,
missing, or errored, with the loaded `runner` / `verification` /
`verification_timeout_sec` defaults and a notes-present flag when
applicable. The `Repo policy via MOMENTUM.md` reference lives in
[`docs/runners.md`](runners.md#repo-policy-via-momentummd).

## Source items and latest evidence

When source items are linked to the goal, `source_items` is a non-empty
array of summaries — each `{id, adapter_kind, external_id, external_key,
url, title, status, last_observed_at}`. Adapter metadata is intentionally
excluded; use `momentum source get` for the raw record. The markdown
includes a `## Source items` section listing adapter kind, external key /
id, title, status, and observation timestamp for each linked item.

When evidence is linked, `latest_evidence` is a newest-first array with
`{id, source, type, format_version, occurred_at, summary, artifact_path,
source_item_id}` for each record. The markdown includes a `## Latest
evidence` section listing timestamp, source/type, and summary.

## Pending update intents

When the goal has pending update intents, `pending_update_intents` is an
array of entries with `{intent_id, adapter_kind, intent_type,
target_external_id, reason, source_item_id, evidence_record_id,
created_at, age_ms, stale, external_apply}`. Each `external_apply`
block contains `{apply_state, total_attempts, counts, latest_attempt}`;
`apply_state` is `idle`, `in_flight`, or `blocked`; `counts` has
`claimed`, `succeeded`, `failed`, `blocked`, and `audit_incomplete`;
`latest_attempt` is the most recent audit row or `null`.
`intent_stale_threshold_ms` carries the threshold used to compute the
per-intent `stale` flag (default 30 days).
The markdown includes a `## Pending update intents` section with a stale
count suffix, per-intent lines showing ID, adapter/type, target, age,
stale flag, apply state, attempt count, and latest audit lifecycle,
the stale threshold, and a review hint recommending
`momentum intent list --status pending`. See
[`docs/intent-commands.md`](intent-commands.md) for the intent lifecycle
that consumes these entries.

The top-level `external_apply` block provides a goal-scoped rollup:

- `pending_intent_apply_state_counts` — `{idle, in_flight, blocked}` counts across pending intents.
- `pending_audit_counts` — `{claimed, succeeded, failed, blocked, audit_incomplete}` counts across pending intents.
- `total_attempts` — total audit rows across pending intents.
- `latest_attempt` — the most recent audit row across pending intents (or `null`), including `intent_id`.

The markdown includes a `## External apply` section rendering these rollup
counts and the latest attempt summary (or `(none)`).

## Markdown output

The markdown artifact mirrors the JSON envelope:

- `Runner: <name>` and, when the stored runner name is a built-in kind,
  `Runner profile: <name> (executes=true|false)`.
- An artifact list including `recovery.md` with a `(present)` or
  `(missing)` suffix.
- A `## Daemon` section showing the run ID, state, stop request, stop-now
  request, cancel outcome, active job, and finished time.
- A `## Stale recovery` section that renders the recovery counts and
  latest timestamps (or a no-activity sentinel when none).
- A `## Policy (MOMENTUM.md)` section describing the repo policy state.
- A `## Source items` section when source items are linked.
- A `## Latest evidence` section when evidence is linked.
- A `## Pending update intents` section when the goal has pending intents.
