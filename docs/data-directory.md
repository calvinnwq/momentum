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
  momentum.db                  # SQLite (goals, jobs, events, repo_locks, daemon_runs, source_items, source_snapshots, source_reconciliation_runs, evidence_records, update_intents, intent_apply_audits, workflow_runs, workflow_steps, workflow_approvals, workflow_leases, workflow_definitions, step_definitions, executor_* tables)
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
- `workflow_runs` - durable workflow run rows keyed by `runId`, carrying `state`, identity columns (`goal_id`, `repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`, nullable `workflow_definition_key` / `workflow_definition_version` provenance for definition-started runs), the run `source` (`agent-workflow`, `workflow-definition`, or `momentum-native-coding`) plus optional `source_artifact_path`, the captured `plan_json` body, optional batch grouping, monitor advisory columns (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`), the per-run `needs_manual_recovery` flag, run-scoped manual-recovery fields (`manual_recovery_reason`, `manual_recovery_at`) used by live recovery and scheduler-lane stale workflow-lease recovery when `recovery.md` rendering is best-effort or absent, and lifecycle timestamps.
  The digest advisory columns are also the native progress-monitor suppression baseline: `workflow run monitor --advance` can refresh `monitor_last_seen_digest` and, only when a meaningful tick emits, `monitor_last_emitted_digest` for `momentum-native-coding` runs.
  `route_json` is the durable home for `route.profile` when `workflow run start` or `workflow run start-coding` records an operator-selected runtime/profile.
  For configured `subworkflow` steps, `route_json` also stores `route.subworkflow.child` child-definition config on the parent run and `route.subworkflow.lineage` recursion lineage propagated onto child runs.
  For native coding runs started with `--steps-json`, `route_json` also stores the validated per-step `route.steps` overrides (harness/model/effort per configurable coding step); only the steps and fields the operator overrode are recorded, and a corrupt namespace fails closed on read-back.
  When a step supplies a known agent harness, provider-specific model aliases are stored in the command-ready form for that harness (for example Claude `sonnet` becomes `claude-sonnet-4-6`, Codex `openai/gpt-5.5` becomes `gpt-5.5`, and OpenCode `glm-5.2` becomes `opencode-go/glm-5.2`); aliases without matching harness context and unknown values remain free-form after trimming.
  For `momentum-native-coding` runs, `workflow_definition_key` / `workflow_definition_version` identify the built-in workflow definition version used for dispatch; persisted definition rows with the same key/version are not the dispatch source for that run source.
- `workflow_steps` - durable step rows keyed by `(run_id, step_id)` with `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), `state`, ordering, a `ledger_offset` pointer into the run's `ledger.jsonl`, stable `error_code` / `error_message` fields, and operator audit fields for manual transitions or external-tail recovery reconciliation (`operator_reason`, `operator_actor`, `operator_evidence_pointer`, `operator_ledger_pointer`, `operator_transition_at`).
- `workflow_approvals` - durable approval rows keyed by `(run_id, boundary)` from per-run `approval-<boundary>.json` artifacts, `workflow run approve`, or `workflow run start` / `workflow run start-coding` with `--approval-boundary`; stores actor, phrase, artifact path and digest, recorded / discharged timestamps.
  CLI-created rows without an artifact file store synthetic `workflow-run-approve://<run-id>/<boundary>` or `workflow-run-start://<run-id>/<boundary>` provenance plus a deterministic synthetic digest.
- `workflow_leases` — durable monitor / managed-step / dispatch leases keyed by `(run_id, lease_kind)`; stores holder, acquired / expires / heartbeat / released timestamps (a non-null `released_at` marks the lease as cleanly released), and a `stale_policy` of `auto-release` or `manual-recovery-required`. Stale dispatch leases with terminal dispatcher evidence are reconciled before release; stale running dispatches without terminal evidence are parked for run-scoped manual recovery before release.
- `workflow_gates` — durable human-gate (pause) rows keyed by `gateId`, each a NOT NULL FK to `workflow_runs(id)` and hanging from exactly one layer of the workflow-first tree named by `target_scope` (`workflow` / `step` / `invocation` / `round`); the scope's anchor id plus its ancestry are stored and any id deeper than the scope stays null. Stores `gate_type`, `reason`, optional `evidence`, JSON `allowed_actions` / `policy_envelope` arrays, an optional `recommended_action`, and the resolution columns (`resolved_at` / `resolved_by` / `resolution_mode` of `operator` or `delegated` / `chosen_action` / `resolution`) stamped when an operator or delegated-policy decision resolves the gate via `workflow run decide`. Openness is `resolved_at IS NULL`; gates surface in `workflow status` / `workflow handoff` / `workflow run monitor` / `workflow run logs`.
- `workflow_definitions` — durable reusable workflow definition rows keyed by `(key, version)`, carrying the display `title` and lifecycle timestamps. Re-persisting a `(key, version)` upserts in place, preserves `created_at`, and bumps `updated_at`, so a definition can evolve across versions without losing prior history.
- `step_definitions` — durable ordered step rows for a workflow definition keyed by `(definition_key, definition_version, step_key)` and referencing `workflow_definitions(key, version)`; each carries the step `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), the `executor` family that powers it (`goal-loop` / `one-shot` / `no-mistakes` / `script` / `external-apply` / `subworkflow`), a `step_order`, a `required` flag, and lifecycle timestamps. The persisted step set mirrors its definition exactly: re-persisting drops steps the definition no longer declares, preserves retained steps' `created_at`, and bumps `updated_at`.
- `executor_definitions` — durable executor recipes keyed by `executor_key`, carrying the executor `family`, display name, optional agent / model / effort policy, and lifecycle timestamps.
- `executor_invocations` — one configured executor session below a workflow step, keyed by `invocation_id` and referencing `(run_id, step_id)`; stores executor family, state, artifact root, model metadata, summary fields, verification / recovery result fields, and lifecycle timestamps. Bounded `daemon start --max-*` creates the first invocation scaffold when it dispatches an approved workflow step for a supported executor family; the workflow dispatcher uses deterministic `<run-id>::<step-id>::dispatch` ids so re-entry finds the same scaffold instead of duplicating work. When the daemon is started with a valid live-wrapper profile, that same scaffold is terminalized from the wrapper result and reconciled in place; for the `external-apply` family, the daemon terminalizes it from the policy-gated external-apply result evidence. Configured `subworkflow` steps use the same scaffold shape to attach child-run evidence before the parent step is reconciled; missing child config, unsafe recursion, unsupported attachment, invalid child state, and ambiguous child terminals route to manual recovery. A retryable `no-mistakes` / `merge-cleanup` live-wrapper bootstrap failure keeps the same deterministic invocation id; after `workflow run clear-recovery` prepares the step, the next dispatch reopens that invocation with an incremented attempt instead of duplicating the session.
- `executor_rounds` — bounded executor-loop attempts or long-lived external mirror lanes keyed by `round_id` and referencing `executor_invocations`; stores attempt / round ordering, durable round state, execution metadata, result summaries, log paths, remaining work, verification status, commit / recovery fields, and lifecycle timestamps. The dispatcher creates the first pending round scaffold (`<invocation-id>::round-1`) before any later executor work is driven; that scaffold freezes agent / model / effort metadata from the selected route when a native coding run has `route.steps`, but carries no result, artifact, verification, commit, or recovery evidence until an executor, configured daemon live-wrapper profile, the daemon's external-apply adapter, an internal subworkflow mirror, or deliberate test/dogfood terminalizer fills it. Retried live-wrapper bootstrap recovery appends the next pending round (`round-2`, `round-3`, and so on) while preserving the failed round as durable evidence and the current selected agent / model / effort metadata; attempt-specific result and log paths are isolated under `attempt-<n>/` for attempts after the first. `workflow run logs` reads these rows run-wide in deterministic step / attempt / round order.
- `executor_artifacts`, `executor_checkpoints`, `executor_findings`, `executor_decisions` — append-only evidence rows below executor rounds for artifacts, checkpoint events, review findings, and durable decisions. Findings and decisions may carry mirrored external references for external review / gate identity. Each table references `executor_rounds` and keeps enough structured payload to reattach after process, daemon, or chat loss.

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
