# Data directory layout

Canonical reference for the SQLite database that backs durable state, the workflow runtime tables, and the per-goal artifact tree. The `goals/<goal-id>/` artifact trees are durable compatibility data written by the retired goal-first lane; nothing writes new goal iterations anymore, but `recovery clear`, daemon startup recovery, `daemon status`, and `doctor` keep reading the stored rows and artifacts.

See also:

- [docs/failure-reset.md](failure-reset.md) — the retired lane's per-iteration outcome matrix and `verification.log` capture rules preserved in stored artifacts.
- [docs/recovery.md](recovery.md) — `recovery.md` artifact and the `needs_manual_recovery` flag.
- [docs/runners.md](runners.md) — stored `trusted-shell` / `acp` runner-profile blocks and the per-profile `result_file` override.
- [docs/openclaw-supervise.md](openclaw-supervise.md) — OpenClaw supervisor state and audit files written by `openclaw supervise`.

## Resolution chain

State is stored under (in order):

1. `--data-dir <path>` CLI flag, when supplied.
2. `MOMENTUM_HOME` environment variable, when set.
3. `~/.momentum` (the default).

Momentum never modifies the data directory outside the resolved path. Each stored goal lives in its own directory keyed by goal ID, so multiple goals share the same SQLite database but isolated artifact trees.

## On-disk layout

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events, repo_locks, daemon_runs, source_items, source_snapshots, source_reconciliation_runs, evidence_records, update_intents, intent_apply_audits, workflow_runs, workflow_steps, workflow_approvals, workflow_leases, workflow_events, workflow_definitions, step_definitions, executor_* tables)
  openclaw-supervisor/
    <encoded-run-id>.json      # Per-run OpenClaw supervise cursor/digest suppression state
    <encoded-run-id>.auto-actions.jsonl
                                # Per-run OpenClaw local auto-action audit records
  goals/
    <goal-id>/                 # Durable compatibility data from the retired goal lane
      goal.md                  # Canonical copy of the stored goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by the retired lane's handoff surface
      handoff.json             # Populated by the retired lane's handoff surface (schema v1)
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

- `goals` — durable goal rows from the retired goal-first lane, including `state`, `reducer_decision`, `needs_manual_recovery`, and `linked_source_item_id`; `recovery clear`, daemon recovery surfaces, and `doctor` still read them.
- `jobs` — stored `goal_iteration` job rows from the retired goal-first lane; nothing claims them anymore, but daemon startup recovery and `daemon status` still read and reconcile stale rows.
- `events` — append-only audit stream (`job.succeeded`, `job.failed`, `goal.reduced`, `goal.completed`, `goal.failed`, `goal.recovery_cleared`, etc.).
- `repo_locks` - per-repo exclusion lease held across a goal iteration or a live-wrapper workflow dispatch that may mutate git.
  Workflow dispatch locks are released after a proven-clean commit / reset / reconciliation outcome or, when already parked in `needs_manual_recovery`, by an operator-guarded recovery clear that atomically prepares the matching attempt for retry; stored goal-iteration manual-recovery locks are also released by `recovery clear`.
  A profile-backed dispatch lock covers at least the longest configured wrapper/probe execution window plus the full verification-command budget, so a bounded delegate handoff cannot outlive its repository ownership.
  Workflow dispatch locks reuse the legacy identity columns (`goal_id` = run id, `job_id` = the step-scoped dispatch correlation id `<run-id>::<step-id>::dispatch` shared by every attempt of the step, `iteration` = attempt number) so the active-per-repo-root index remains the exclusion primitive.
  An unresolved delegate intent may take over its matching active lock after lock expiry or after the scheduler proves and releases the same stale dispatch owner.
  A compare-and-swap over the repository, run, job, previous holder, attempt, and deadline prevents displacement of a concurrent or newer owner, then fences later lock writes by the new holder and attempt.
- `daemon_runs` — orchestrator-run state (register-only or managed-loop), the source of truth for `daemon status` and `doctor`'s daemon-readiness block.
- `source_items` — durable rows for external tracker items (linked or unlinked) seen by source adapters.
- `source_snapshots` — point-in-time JSON snapshots captured during reconciliation.
- `source_reconciliation_runs` — per-run summary (counts, pagination flags, classification breakdown).
- `evidence_records` — normalized agent-workflow rows ingested via `evidence ingest`, including nullable `run_id` / `step_id` workflow linkage columns indexed by `(run_id, step_id)` for run and step evidence lookups.
- `update_intents` — durable external-tracker update intents in `pending` / `applied` / `skipped` / `canceled` states, plus an `apply_state` column tracking the per-intent external-apply CAS state (`idle` / `in_flight` / `blocked`).
- `intent_apply_audits` — append-only audit ledger for external-apply attempts on `update_intents`; one row per claim with lifecycle (`claimed` / `succeeded` / `failed` / `blocked` / `audit_incomplete`), idempotency marker, preview/result fields, and reconcile metadata.
- `workflow_runs` - durable workflow run rows keyed by `runId`, carrying `state`, identity columns (`goal_id`, `repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`, nullable `workflow_definition_key` / `workflow_definition_version` provenance for definition-started runs), the run `source` (`agent-workflow`, `workflow-definition`, or `momentum-native-coding`) plus optional `source_artifact_path`, the captured `plan_json` body, optional batch grouping, monitor advisory columns (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`, `monitor_last_seen_at`, `monitor_last_emitted_at`), the per-run `needs_manual_recovery` flag, run-scoped manual-recovery fields (`manual_recovery_reason`, `manual_recovery_at`) used by live recovery and scheduler-lane stale workflow-lease recovery when `recovery.md` rendering is best-effort or absent, and lifecycle timestamps.
  The digest and timestamp advisory columns are also the native progress-monitor suppression baseline: `workflow run monitor --advance` and `workflow run watch --once` can refresh `monitor_last_seen_digest` / `monitor_last_seen_at` and, only when a meaningful tick or throttled supervisor advisory emits, `monitor_last_emitted_digest` / `monitor_last_emitted_at` for `momentum-native-coding` runs.
  `route_json` is the durable home for `route.profile` when `workflow run start` or `workflow run start-coding` records an operator-selected runtime/profile.
  For native coding runs, `route_json` also stores `route.implementationEngine`; new runs default to `gnhf`, legacy `native-goal-loop` rows remain readable, `current-gnhf-cwfp` remains an explicit unsupported compatibility selection, and unknown persisted values fail closed before dispatch.
  The execution semantics of those values are owned by [Daemon commands](daemon.md#workflow-live-wrapper-profile).
  For configured `subworkflow` steps, `route_json` also stores `route.subworkflow.child` child-definition config on the parent run and `route.subworkflow.lineage` recursion lineage propagated onto child runs.
  For native coding runs started with `--steps-json`, `route_json` also stores the validated per-step `route.steps` overrides (harness/model/effort per configurable coding step); only the steps and fields the operator overrode are recorded, and a corrupt namespace fails closed on read-back.
  When a step supplies a known mapped harness (`claude`, `codex`, or `opencode`), provider-specific model aliases are stored in the command-ready form for that harness (for example Claude `sonnet` becomes `claude-sonnet-4-6`, Codex `openai/gpt-5.5` becomes `gpt-5.5`, and OpenCode `glm-5.2` becomes `opencode-go/glm-5.2`); aliases without matching harness context and unknown values remain free-form after trimming.
  For `momentum-native-coding` runs, `workflow_definition_key` / `workflow_definition_version` identify the built-in workflow definition version used for dispatch; persisted definition rows with the same key/version are not the dispatch source for that run source.
- `workflow_steps` - durable step rows keyed by `(run_id, step_id)` with `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), `state`, ordering, a `ledger_offset` pointer into the run's `ledger.jsonl`, stable `error_code` / `error_message` fields, and operator audit fields for manual transitions, external-tail recovery reconciliation, or interrupted no-mistakes success reconciliation from legacy checks-passed proof or structured deterministic evidence (`operator_reason`, `operator_actor`, `operator_evidence_pointer`, `operator_ledger_pointer`, `operator_transition_at`).
- `workflow_approvals` - durable approval rows keyed by `(run_id, boundary)` from per-run `approval-<boundary>.json` artifacts, `workflow run approve`, or `workflow run start` / `workflow run start-coding` with `--approval-boundary`; stores actor, phrase, artifact path and digest, recorded / discharged timestamps.
  CLI-created rows without an artifact file store synthetic `workflow-run-approve://<run-id>/<boundary>` or `workflow-run-start://<run-id>/<boundary>` provenance plus a deterministic synthetic digest.
- `workflow_leases` - durable monitor / managed-step / dispatch leases keyed by `(run_id, lease_kind)`; stores holder, acquired / expires / heartbeat / released timestamps (a non-null `released_at` marks the lease as cleanly released), and a `stale_policy` of `auto-release` or `manual-recovery-required`.
  Stale-lease reconciliation and resume exceptions are owned by [Recovery](recovery.md#stale-lease-detection-and-auto-recovery).
- `workflow_gates` - durable human-gate (pause) rows keyed by `gateId`, each a NOT NULL FK to `workflow_runs(id)` and hanging from exactly one layer of the workflow-first tree named by `target_scope` (`workflow` / `step` / `attempt` / `round`); the scope's anchor id plus its ancestry are stored (the attempt anchor lives in the `attempt_id` column) and any id deeper than the scope stays null. Stores `gate_type`, `reason`, optional `evidence`, JSON `allowed_actions` / `policy_envelope` arrays, an optional `recommended_action`, and the resolution columns (`resolved_at` / `resolved_by` / `resolution_mode` of `operator` or `delegated` / `chosen_action` / `resolution`) stamped when an operator or delegated-policy decision resolves the gate via `workflow run decide`, or when guarded `workflow run clear-recovery` resolves an open `manual_recovery_required` gate that permits `clear_recovery`. Openness is `resolved_at IS NULL`; gates surface in `workflow status` / `workflow handoff` / `workflow run monitor` / `workflow run watch` / `workflow run events` / `workflow run logs`.
  Gate rows recorded before the attempt model keep their historical `invocation` target scope as read-only provenance so re-projected gate event ids stay stable for existing replay cursors; new gates always record `attempt`.
  Read envelopes derive `recommendedActionPolicy` from the gate type and `recommended_action`; the policy metadata is not stored as a separate database column.
- `workflow_events` — append-only semantic event rows keyed by `event_id`, scoped to one `run_id` and optional `step_id`, with `occurred_at`, `type`, and compact JSON payload.
  The `workflow run events` replay surface and `workflow run watch --stream --jsonl` stream combine these rows with events reproducible from workflow runs, steps, approvals, gates, and terminal run state.
  The table stores transitions that would otherwise be overwritten in place, such as recovery mark / clear, blocked-step metadata, failed or started step states preserved before guarded clear rewrites the step row, and throttled supervisor advisory events.
- `workflow_definitions` — durable reusable workflow definition rows keyed by `(key, version)`, carrying the display `title` and lifecycle timestamps. Re-persisting a `(key, version)` upserts in place, preserves `created_at`, and bumps `updated_at`, so a definition can evolve across versions without losing prior history.
- `step_definitions` - durable ordered step rows for a workflow definition keyed by `(definition_key, definition_version, step_key)` and referencing `workflow_definitions(key, version)`; each carries the step `kind` (`preflight` / `implementation` / `postflight` / `no-mistakes` / `merge-cleanup` / `linear-refresh`), the permanent executor identity that powers it, optional portable `config_json`, a `step_order`, a `required` flag, and lifecycle timestamps.
  Executor identities may name a built-in (`goal-loop` / `one-shot` / `no-mistakes` / `delegate-supervisor` / `script` / `external-apply` / `subworkflow`) or a third-party SDK registration.
  Opening an older database adds nullable `config_json` in place and preserves existing step rows with null config.
  The current coding definition stores GNHF and no-mistakes as `tool` config on `delegate-supervisor` steps, while version 1 retains its recorded legacy families.
  The persisted step set mirrors its definition exactly: re-persisting drops steps the definition no longer declares, preserves retained steps' `created_at`, and bumps `updated_at`.
- `executor_definitions` — durable executor recipes keyed by `executor_key`, carrying the executor `family`, display name, optional agent / model / effort policy, and lifecycle timestamps.
- `executor_attempts` - one immutable executor attempt below a workflow step, keyed by `attempt_id` and referencing `(run_id, step_id)`; stores the permanent executor identity in the legacy `executor_family` column, plus state, `attempt_number`, nullable `legacy_invocation_id` / `legacy_provenance` migration-provenance columns, and lifecycle timestamps.
  Each attempt is one executor go for one step and one executor identity; a retry inserts a fresh attempt row with the next `attempt_number` and never reopens or rewrites an earlier attempt.
  Opening an SDK-05 database migrates in place, exactly once: each legacy `executor_invocations` row splits into immutable attempts by round attempt groups, the latest group keeps the legacy invocation id and its live state and timestamps, earlier groups get derived `<invocation-id>::attempt-<n>` ids with state and timestamps reconstructed from their terminal rounds, and every migrated attempt records `legacy_invocation_id` plus a `legacy_provenance` JSON while round ids, indices, and evidence links are preserved.
  When one step has multiple legacy invocation rows whose attempt numbers collide, their groups are ordered deterministically by lifecycle time and renumbered into a monotone step-wide sequence; `legacy_provenance.legacyAttemptNumber` preserves each changed number, and the re-anchored rounds receive the assigned attempt number.
  Bounded `daemon start --max-*` and `workflow run watch --once` create the first attempt scaffold when they dispatch an eligible approved workflow step with a valid executor identity; the workflow dispatcher derives deterministic `<run-id>::<step-id>::attempt-<n>` ids so re-entry finds the same scaffold instead of duplicating work.
  The step-scoped `<run-id>::<step-id>::dispatch` token survives only as narrowly scoped correlation provenance: external delegate handoff receipts and repo-lock job identity still correlate by it across retries, but it is no longer a row id in the active hierarchy.
  When a bounded daemon cycle or watch tick uses a valid live-wrapper profile, an ordinary live-wrapper scaffold is terminalized from the wrapper result after repo-safety, verification, and commit/reset finalization, then reconciled in place.
  A profile-backed delegate-supervisor wrapper result instead becomes durable handoff and terminal-candidate evidence; the attempt and step remain non-terminal until a later external-state read receives a daemon-accepted terminal classification.
  For the built-in `linear-refresh` step's `external-apply` family, the daemon terminalizes it only after issue-scope, policy/auth, matching-source, one pending `status_update` intent or deterministic evidence to seed the expected `Done` intent, valid-payload, and idempotency-marker preflight passes, or from already-applied successful audit evidence.
  Configured `subworkflow` steps use the same scaffold shape to attach child-run evidence before the parent step is reconciled; missing child config, unsafe recursion, unsupported attachment, invalid child state, and ambiguous child terminals route to manual recovery.
  An `unsupported_platform` or `runtime_unavailable` refusal on any dispatched step leaves its attempt as immutable evidence; after `workflow run clear-recovery` prepares the step on a repaired or supported host, the next dispatch inserts a fresh attempt with the next `attempt_number` instead of reopening the earlier attempt or duplicating the session.
  Retryable delegate-supervisor adapter, handoff, unreadable or inconsistent external-state, and cleared external-blocker outcomes use the same incremented-attempt path.
  A valid non-terminal correlated handoff and prior decisions remain durable across that retry, while an unresolved handoff intent must be reconciled before another external launch.
  For profile-backed no-mistakes, a conclusively failed or cancelled prior external run remains evidence but permits one fresh launch on the newer attempt.
  A local wrapper-finalization failure is reconciled by reading the correlated run first; a matching failed or cancelled run permits one fresh launch, while every other status reruns local finalization before the same run is reattached for supervision.
  Retry preparation releases only the matching attempt's `needs_manual_recovery` repo locks in the same transaction as the clear, so a refused clear rolls both changes back.
  If an interrupted native `no-mistakes` wrapper left a failed step but the external no-mistakes run later proves success, guarded `clear-recovery` can instead stamp operator evidence on the failed `no-mistakes` step and re-derive the run without opening generic terminal-run mutation.
  `workflow run watch --once` does not create the first scaffold for an approved `merge-cleanup` or `linear-refresh` tail step; it leaves that side-effecting dispatch on a human-required operator-decision path.
  Registered third-party executors use the same deterministic attempt ids and daemon-owned state transitions; an absent or unloadable registration records a `manual_recovery_required` attempt with `runtime_unavailable` rather than manufacturing success.
  The no-mistakes reconciliation path accepts legacy `no-mistakes:<run-id>#checks-passed` evidence or a readable structured deterministic evidence JSON file that matches the current workflow run, issue scope, branch head, pull request identity, no-mistakes run id, unresolved finding counts, check state, and required phase statuses.
- `executor_rounds` - bounded executor turns or external-supervision reads keyed by `round_id` and referencing `executor_attempts` through `attempt_id` and `attempt_number` (formerly `invocation_id` and `attempt`); stores round ordering, durable round state, execution metadata, executor recommendation, result summaries, key changes, key learnings, log paths, remaining work, verification status, verification command results, commit / recovery fields, and lifecycle timestamps.
  Each round belongs to exactly one attempt, round order is deterministic within an attempt, and cross-attempt ordering is attempt number, then round index.
  Dispatch and registered SDK lifecycles keep round indices monotone across the whole step lineage, so a retry continues from the next step-wide index rather than restarting at zero.
  Legacy dispatch creates a first pending round scaffold (`<attempt-id>::round-1`) before later executor work is driven.
  Registered SDK lifecycles, including native `goal-loop`, `one-shot`, and `script`, materialize their first round at index 0 through the durable envelope after host bindings resolve.
  Either shape freezes agent / model / effort metadata from the selected route when a native coding run has `route.steps`, but carries no terminal evidence until the owning executor or daemon adapter records it.
  Live-wrapper-owned rounds filled by a configured daemon/watch profile can include `verification-log` artifact paths or precise recovery codes from result parsing, moved HEAD, lost dispatch lease, git, commit, or reset failures.
  A `delegate-supervisor` handoff normally completes one durable round, and each normal continuation read completes another; a round reopened after gate resolution resumes in place.
  Only the attempt's first completed handoff may receive an immediate second read in the same dispatcher pass; later passes and retry attempts perform one tick and continuation-only daemon cycles wait the configured poll interval.
  If the process stops after a durable handoff intent or completed handoff exists but before classification, the unclassified running, capturing-result, or `mirroring_external_state` round remains resumable under the same attempt and does not authorize another handoff.
  Native `mechanism_completed` checkpoint reattachment semantics are owned by [Executor SDK](executor-sdk.md#envelope-facade).
  A completed `continue` poll in `succeeded` or `failed` with a durable handoff in its history is likewise scheduler-resumable.
  Each read keeps the raw response digest in `inputDigest`, stores its semantic progress digest in `resultDigest`, refreshes durable liveness, and carries the last semantic-progress time across rounds.
  After four minutes without fresh progress or terminal evidence, the active round and attempt record manual recovery rather than waiting forever on stale external state.
  Retried live-wrapper setup recovery appends the next pending round (`round-2`, `round-3`, and so on) while preserving the failed round as durable evidence and the current selected agent / model / effort metadata; ordinary live-wrapper attempt paths use `attempt-<n>/`, while delegate-supervisor evidence first scopes by step under `delegate/<step-id>/` and then by later attempt.
  A registered executor's `continue` recommendation terminalizes its current round while leaving the attempt running; the next daemon scheduler pass may append the next sequential round for the same attempt.
  A registered executor's approval or operator-decision recommendation pauses its current round at `waiting_operator`, mirrors an unresolved executor decision into a round-scoped workflow gate, and releases the dispatch lease. Resolving that gate records the chosen action, reopens the same round, and makes it eligible for scheduler reattachment.
  When an executor selects a specific decision for that gate, `human_gate_decision_selected` checkpoint evidence preserves the decision id before classification; a null selection retains last-unresolved-decision behavior.
  If a crash occurs after `waiting_operator` classification but before gate parking finishes, stale dispatch recovery reuses or recreates the gate from that selector and unresolved decision, then releases the exact stale lease without changing the selected operator target.
  If the crash occurs before classification after a delegate has persisted a mirrored gate checkpoint, gate-eligible decision, and `waiting_operator` observation, the unclassified round is resumed under the same attempt so classification and gate parking can finish.
  Delegate-supervisor approval uses a reserved synthetic decision identity; only the latest resolved `approve` allows a later completed external state to settle.
  `workflow run logs` reads attempts run-wide in deterministic step / attempt-number / attempt-id order and rounds in deterministic step / attempt-number / attempt-id / round order.
  For native goal-loop, `executor_attempts` own the autonomous attempt and `executor_rounds` own each durable iteration; `.gnhf/runs`, terminal scrollback, and runner-local directories may be mirrored as artifacts but are not authoritative state.
  Successful goal-loop rounds record exactly one commit SHA after verification, while failed, stale, unsafe, canceled, invalid, and no-op rounds preserve recovery evidence without creating misleading commits.
  When a native goal-loop round receives a usable absolute verification log path, its `executor_artifacts` can include `commit_or_reset_evidence` pointing at `<verification-log>.finalization.json` with a digest of the finalization sidecar.
- `executor_artifacts`, `executor_checkpoints`, `executor_findings`, `executor_decisions` — append-only evidence rows below executor rounds for artifacts, checkpoint events, review findings, and durable decisions. Findings and decisions may carry mirrored external references for external review / gate identity. Each table references `executor_rounds` and keeps enough structured payload to reattach after process, daemon, or chat loss.

## Per-goal artifact files

Files at `<data-dir>/goals/<goal-id>/`, written by the retired goal-first lane and kept as durable compatibility data:

- `goal.md` — canonical copy of the original goal spec; written at init time by the retired lane (see [docs/goal-spec.md](goal-spec.md)).
- `ledger.md` — append-only Markdown ledger; one block per iteration outcome.
- `handoff.md` — populated by the retired lane's handoff surface; starts as an empty placeholder.
- `handoff.json` — populated by the retired lane's handoff surface (schema v1); starts as `{}`.
- `recovery.md` — written lazily when a goal transitions to `needs_manual_recovery`; daemon startup recovery still writes it for stored goals it must park. Intentionally left on disk after `recovery clear` as durable evidence.

## Repo-local workflow artifact files

Native workflow runs that execute through a configured live-wrapper profile use `<repo>/.agent-workflows/<run-id>/` as the run directory.
Imported workflow runs use the directory derived from their source artifact path.
The ordinary live-wrapper lane writes `result.json`, `executor.log`, `verification.log`, `recovery.md`, and attempt-specific `attempt-<n>/` subdirectories there as step evidence.
Delegate-supervisor steps write their result, log, verification, and external-state evidence beneath `delegate/<step-id>/`, with later attempts beneath that step directory's `attempt-<n>/` child.
Each delegated step writes its atomic schema-version-1 `delegate-handoff.json` receipt at the step-scoped delegate root so an interrupted or retried attempt reattaches a valid non-terminal correlated run instead of duplicating it.
Recovery routes a prior valid handoff through the adapter before reuse, allowing host-local receipt finalization to be reconciled first.
For profile-backed no-mistakes, a conclusively failed or cancelled prior run remains evidence but permits one fresh launch on the newer attempt.
No-mistakes receipts progress through `launching`, `resetting` or `finalizing`, and `launched` or `failed`; a correlated launch log alone cannot promote a `launching` receipt without wrapper-finalization proof.
After the wrapper returns, a no-mistakes receipt binds the exact bounded result digest used to authorize the selected reset or commit, verified no-change acceptance, and any later failed-finalization retry or prepared-commit recovery.
A retry of a locally failed no-mistakes receipt reads the correlated external state first.
A failed or cancelled run permits one fresh launch; every other status reruns local finalization before the same run is reattached for supervision.
Other profile-backed delegate receipts progress through launch, wrapper completion, reset or commit preparation, and finalization phases, carrying the exact result digest plus repository base/tree/message proof required to recognize an already-completed mutation safely.
An interrupted `finalizing` receipt can also authorize recovery of an exactly staged commit when the current base `HEAD`, index tree, configured artifact paths, result digest, and successful result all match and no unstaged or untracked changes exist.
Receipts, result documents, persisted external-state documents, and no-mistakes launch evidence must be bounded regular files rather than symbolic links, oversized files, or named pipes.
Correlated legacy delegate state or no-mistakes receipts at the run root migrate into this step-scoped layout during recovery only after attempt-correlation and branch checks plus current-head validation for finalized state; a legacy no-mistakes receipt must explicitly record successful handoff finalization.
Their finalized external state carries a full 40-character head SHA and is readable as terminal evidence only while it matches the repository's current `HEAD`.
When that run directory resolves inside the repository, daemon and watch dispatch require it to be ignored by git before the wrapper starts; otherwise the step is parked for manual recovery with `invalid_input` instead of risking evidence files being swept into a Momentum commit.

## OpenClaw supervisor state files

Files at `<data-dir>/openclaw-supervisor/`:

- `<encoded-run-id>.json` — per-run state for `momentum openclaw supervise`, keyed by `encodeURIComponent(runId)`. The file stores the last watch cursor, digest, reason, last delivered human-update timestamp, disabled monitor flag, and update timestamp so repeated scheduler calls can suppress duplicate OpenClaw deliveries while preserving terminal cleanup retries.
- `<encoded-run-id>.auto-actions.jsonl` — append-only audit records for local OpenClaw auto-actions that `momentum openclaw supervise` attempted, skipped, failed, or escalated, keyed by `encodeURIComponent(runId)`.
  Each line records the action, policy action, before/after digest and state snapshots, result, state-persistence status, error, and human escalation when present.
  Successful auto-actions first write a `pending` audit record before the local state change, then write a required `saved` status record before the state file is updated; if that update later fails, they append a matching `failed` status record for the same attempt.
  The `release_monitor` repeat limiter counts saved successful records for a digest only when the same attempt has no matching failed status row, so a failed row cancels its own attempt without reducing other saved attempts.
  Snapshot state fields use the same shape as the supervisor state file, including nullable cursor, digest, reason, and last-human-update fields.

## Per-iteration artifact files

Files at `<data-dir>/goals/<goal-id>/iterations/<n>/`, written per executed iteration by the retired goal-first lane:

- `prompt.md` — rendered iteration prompt; empty in iterations that were never executed.
- `runner.log` — runner metadata and captured stdout / stderr.
- `verification.log` — tagged verification command output with a capped capture buffer (see `docs/failure-reset.md`).
- `result.json` — default runner result envelope. Stored `trusted-shell` and `acp` runner profiles may report a different result file in the same iteration directory via `trusted_shell.result_file` / `acp.result_file`; the path is recorded on the iteration row.

## How the retired lane initialized these files

- `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and the first iteration artifact files were created up-front during goal initialization.
- `handoff.md`, `prompt.md`, `runner.log`, and `verification.log` started empty.
- `handoff.json` and the default `result.json` started as `{}`.
- Executed iterations populated their artifact files inline; stored goals whose later iterations were never claimed retain the empty placeholders.

## Operational invariants

- Avoid hard-coded paths tied to a single user — always resolve through `--data-dir` / `MOMENTUM_HOME` / `~/.momentum`.
- Multiple concurrent goals share one `momentum.db` but isolated `goals/<goal-id>/` artifact trees, so cross-goal artifact reads are safe.
- The `recovery.md` artifact is never deleted by Momentum once written; operators may archive it after `recovery clear` if desired.
