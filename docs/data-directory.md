# Data directory layout

Canonical reference for the on-disk artifact tree Momentum writes per goal, the SQLite database that backs durable state, and the per-iteration / per-goal lifecycle of each file.

See also:

- [docs/goal-start.md](goal-start.md) — `goal start` queued / foreground envelopes; iteration 1 artifact bootstrap.
- [docs/worker-run.md](worker-run.md) — `worker run` pipeline that materializes later iteration directories and persists `result_path` / `error_path`.
- [docs/failure-reset.md](failure-reset.md) — per-iteration outcome matrix and `verification.log` capture rules.
- [docs/recovery.md](recovery.md) — `recovery.md` artifact and the `needs_manual_recovery` flag.
- [docs/runners.md](runners.md) — `trusted-shell` / `acp` runner profiles and the per-profile `result_file` override.

## Resolution chain

State is stored under (in order):

1. `--data-dir <path>` CLI flag, when supplied.
2. `MOMENTUM_HOME` environment variable, when set.
3. `~/.momentum` (the default).

Momentum never modifies the data directory outside the resolved path. Each goal lives in its own directory keyed by goal ID, so multiple concurrent goals share the same SQLite database but isolated artifact trees.

## On-disk layout

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events, repo_locks, daemon_runs, source_items, source_snapshots, source_reconciliation_runs, evidence_records, update_intents, intent_apply_audits, workflow_runs, workflow_steps, workflow_approvals, workflow_leases tables)
  goals/
    <goal-id>/
      goal.md                  # Canonical copy of the goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by `handoff` (empty placeholder until then)
      handoff.json             # Populated by `handoff` (schema v1)
      recovery.md              # Populated when a goal is flagged for manual recovery; includes reason, artifact paths, runner/profile metadata, and prompt path when available
      iterations/
        <n>/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner metadata and captured stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Default runner result envelope; trusted-shell / acp may report another in-dir result file
```

## SQLite tables under `momentum.db`

A single `momentum.db` per data directory backs durable state across all goals:

- `goals` — durable goal rows, including `state`, `reducer_decision`, `needs_manual_recovery`, and `linked_source_item_id`.
- `jobs` — queued / in-flight `goal_iteration` jobs claimed by `worker run` and the managed daemon loop.
- `events` — append-only audit stream (`job.succeeded`, `job.failed`, `goal.reduced`, `goal.completed`, `goal.failed`, `goal.recovery_cleared`, etc.).
- `repo_locks` — per-repo exclusion lease held across an iteration; released on commit / reset / `recovery clear`.
- `daemon_runs` — orchestrator-run state (register-only or managed-loop), the source of truth for `daemon status` and `doctor`'s daemon-readiness block.
- `source_items` — durable rows for external tracker items (linked or unlinked) seen by source adapters.
- `source_snapshots` — point-in-time JSON snapshots captured during reconciliation.
- `source_reconciliation_runs` — per-run summary (counts, pagination flags, classification breakdown).
- `evidence_records` — normalized agent-workflow rows ingested via `evidence ingest`, including nullable `run_id` / `step_id` workflow linkage columns indexed by `(run_id, step_id)` for run and step evidence lookups.
- `update_intents` — durable external-tracker update intents in `pending` / `applied` / `skipped` / `canceled` states, plus an `apply_state` column tracking the per-intent external-apply CAS state (`idle` / `in_flight` / `blocked`).
- `intent_apply_audits` — append-only audit ledger for external-apply attempts on `update_intents`; one row per claim with lifecycle (`claimed` / `succeeded` / `failed` / `blocked` / `audit_incomplete`), idempotency marker, preview/result fields, and reconcile metadata.
- `workflow_runs` — durable coding-workflow run rows keyed by `runId`, carrying `state`, identity columns (`goal_id`, `repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`), the run `source` plus optional `source_artifact_path`, the captured `plan_json` body, optional batch grouping, monitor advisory columns (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`), the per-run `needs_manual_recovery` flag, authoritative live recovery fields (`manual_recovery_reason`, `manual_recovery_at`) used when `recovery.md` rendering is best-effort or absent, and lifecycle timestamps.
- `workflow_steps` — durable step rows keyed by `(run_id, step_id)` with `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), `state`, ordering, a `ledger_offset` pointer into the run's `ledger.jsonl`, and stable `error_code` / `error_message` fields.
- `workflow_approvals` — durable approval rows keyed by `(run_id, boundary)` from per-run `approval-<boundary>.json` artifacts or `workflow run approve`; stores actor, phrase, artifact path and digest, recorded / discharged timestamps. CLI-created rows without an artifact file store synthetic `workflow-run-approve://<run-id>/<boundary>` provenance plus a deterministic synthetic digest.
- `workflow_leases` — durable monitor / managed-step / dispatch leases keyed by `(run_id, lease_kind)`; stores holder, acquired / expires / heartbeat / released timestamps (a non-null `released_at` marks the lease as cleanly released), and a `stale_policy` of `auto-release` or `manual-recovery-required`.
- `workflow_definitions` — durable reusable workflow definition rows keyed by `(key, version)`, carrying the display `title` and lifecycle timestamps. Re-persisting a `(key, version)` upserts in place and preserves `created_at`, so a definition can evolve across versions without losing prior history.
- `step_definitions` — durable ordered step rows for a workflow definition keyed by `(definition_key, definition_version, step_key)` and referencing `workflow_definitions(key, version)`; each carries the step `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), the `executor` family that powers it (`goal-loop` / `one-shot` / `no-mistakes` / `script` / `external-apply` / `subworkflow`), a `step_order`, and a `required` flag. The persisted step set mirrors its definition exactly: re-persisting drops steps the definition no longer declares.

## Per-goal artifact files

Files at `<data-dir>/goals/<goal-id>/`:

- `goal.md` — canonical copy of the original goal spec; written at init time.
- `ledger.md` — append-only Markdown ledger; one block per iteration outcome.
- `handoff.md` — populated by `momentum handoff`; an empty placeholder file is created at init time.
- `handoff.json` — populated by `momentum handoff` (schema v1); starts as `{}` at init time.
- `recovery.md` — written lazily when a goal transitions to `needs_manual_recovery`. Intentionally left on disk after `recovery clear` as durable evidence.

## Per-iteration artifact files

Files at `<data-dir>/goals/<goal-id>/iterations/<n>/`:

- `prompt.md` — rendered iteration prompt; starts empty in queued goals, populated when the iteration is executed.
- `runner.log` — runner metadata and captured stdout / stderr.
- `verification.log` — tagged verification command output with a capped capture buffer (see `docs/failure-reset.md`).
- `result.json` — default runner result envelope. Built-in `trusted-shell` and `acp` runner profiles may report a different result file in the same iteration directory via `trusted_shell.result_file` / `acp.result_file`; the path is recorded on the iteration row.

## Initialization lifecycle

- `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and the first iteration artifact files are created up-front during goal initialization.
- `handoff.md`, `prompt.md`, `runner.log`, and `verification.log` start empty.
- `handoff.json` and the default `result.json` start as `{}`.
- `goal start --foreground` populates the iteration artifacts during inline execution.
- In the queued path, iteration 1 starts with placeholders; later iteration directories and jobs are created by the reducer, and their artifact files are materialized when `momentum worker run` claims and executes that iteration.

## Operational invariants

- Avoid hard-coded paths tied to a single user — always resolve through `--data-dir` / `MOMENTUM_HOME` / `~/.momentum`.
- Multiple concurrent goals share one `momentum.db` but isolated `goals/<goal-id>/` artifact trees, so cross-goal artifact reads are safe.
- The `recovery.md` artifact is never deleted by Momentum once written; operators may archive it after `recovery clear` if desired.
