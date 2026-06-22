# Contract: WorkflowRun (OpenClaw Coding Workflow Backend)

**Status:** M7 contract (complete at NGX-319). Pinned by NGX-312 (M7-00) and closed out by NGX-319 (M7-07). The durable substrate primitives ship against this contract: the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration, the `WorkflowRun` identity columns (`repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`), the pure run / step state vocabulary and transition reducer, the lease-aware `deriveWorkflowRunState`, and the `classifyWorkflowLease` lease-freshness classifier (NGX-313); the `workflow import` CLI envelope and its built-CLI smoke coverage (NGX-314); the pure `WorkflowStepExecutor` boundary (NGX-315; its original deterministic fakes are now a test-only seam after NGX-485); the pure monitor / recovery reducer (`deriveWorkflowMonitorState`, NGX-316); the read-only `workflow status` and `workflow handoff` CLI envelopes (`src/core/workflow/status.ts`, `src/core/workflow/handoff.ts`) with the `schemaVersion: 1` handoff field (NGX-317); and the end-to-end coding-workflow smoke (`test/m7-e2e-smoke.test.ts`) driving a fresh `.agent-workflows/<runId>/` fixture through the injected deterministic fake executors and the `workflow import` CLI, covering happy-path completion, evidence linkage through `workflow handoff` after `evidence ingest`, and a failure path proving no ghost active / blocked run (NGX-318). NGX-319 added the closeout regression matrix at [../regression-matrix.md](../regression-matrix.md), aligned the contract tests, and flipped the `doctor --json` milestone marker to the M7 closeout string. M8 follow-up slices layer `workflow run list`, `workflow run approve`, `workflow run update-step`, run-scoped recovery (`workflow import` auto-set plus `workflow run clear-recovery`), and the read-only `workflow run monitor` envelope on this substrate. M9 later landed Momentum-side live wrappers on this substrate, while M10 supersedes future run-start semantics with first-class workflow definition and workflow run start surfaces; those follow-ups do not regress this contract. The M3 / M4 / M5 / M6 surfaces this contract composes with remain wire-stable.

This contract is the cross-milestone source of truth for the durable substrate Momentum will provide for OpenClaw coding workflows. It is the long-lived companion to [internal/milestones/m7-openclaw-coding-workflow-backend.md](../milestones/m7-openclaw-coding-workflow-backend.md); the milestone doc owns the *scope* of M7, this contract owns the *invariants* that survive after M7 closeout.

The OpenClaw `coding-workflow-pipeline` skill stays the orchestration UX (Discord delivery, monitor cron, plan composition, batch UX, approval-button rendering, failure classification, recovery procedures). This contract is the boundary Momentum exposes to that skill — nothing more.

## Scope

This contract covers:

- The durable `WorkflowRun` record, the `workflow_steps`, `workflow_approvals`, and `workflow_leases` tables, and the per-run manual-recovery flag.
- The compatibility rules that hold between Momentum's durable substrate and the existing repo-local artifacts the skill scripts already maintain under `.agent-workflows/<runId>/`.
- The ownership boundary between Momentum and `coding-workflow-pipeline`.

It does **not** cover:

- The skill's plan composition, batch policy, approval rendering, Discord envelopes, no-mistakes routing, or recovery classification. Those remain owned by `coding-workflow-pipeline`.
- Goal / Iteration / Job state from M3. A `WorkflowRun` may optionally link to a Goal id, but a coding workflow run is **not** a Goal and does not replace the Goal completion authority.
- External apply. M6's [intent-apply.md](intent-apply.md) remains the only contract covering external writes; M7 does not introduce a new external-write path.

## Run identity and lifecycle

A `WorkflowRun` is identified by `runId`, which matches the existing skill convention `cwfp-<hex>` (the directory id under `.agent-workflows/<runId>/`). The runtime never re-derives `runId` from the plan body; it is taken verbatim from the skill's `workflow_plan.py plan` output and stored as the immutable durable identity.

Alongside identity, the durable row captures the run `source` (origin label for the plan), an optional `sourceArtifactPath` pointing back to the on-disk plan artifact, and the `planJson` body itself, so the substrate can reconstruct what was approved without re-reading `.agent-workflows/<runId>/plan.json`. M8 adds additive monitor-advisory columns (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`) on the same row; imports persist the advisory `monitor.json` values and operator mutations refresh the derived snapshot consumed by `workflow status`, `workflow handoff`, `workflow run monitor`, and `workflow run logs`.

The lifecycle states are:

- `pending` — durable row exists, plan + scope captured, no boundary approved yet.
- `approved` — at least one approval boundary recorded; the highest cumulative boundary is the current approval.
- `running` — at least one `workflow_steps` row is in `running` state.
- `succeeded` — every required step in the approved boundary chain finalized in `succeeded` / `skipped`, at least one required step finalized in `succeeded`, and the run has no outstanding leases. A required chain that finalizes entirely in `skipped` (no `succeeded`) resolves to `canceled` instead.
- `failed` — at least one required step finalized in `failed` and no recovery is in flight.
- `blocked` — manual recovery required (see "Recovery" below). A `blocked` run is non-replayable until cleared.
- `canceled` — explicit operator cancellation; mirrors the M3 `daemon stop --now` `canceled` shape but scoped to a run, not the daemon.

Lease-aware promotion / demotion rules layer on top of the step-derived state above:

- Any outstanding lease classified as `stale-manual-recovery-required` forces the run state to `blocked`, even when steps alone would have allowed a different non-terminal state. The exception is when the step-derived state is already a terminal non-success (`failed` / `canceled`) — those terminal states are not "rescued" back into `blocked` by an orphaned recovery lease, though the lease still blocks new claims on the run until an operator clears it.
- A step-derived `succeeded` is demoted to `running` whenever any non-released lease (`fresh`, `stale-auto-release`, or `stale-manual-recovery-required` when steps would otherwise have allowed `succeeded`) is still outstanding. The `succeeded` lifecycle bullet's "no outstanding leases" requirement is enforced through this demotion.
- Released leases (`releasedAt !== null`) never affect the derived state.

Transitions are append-only at the event level (M3 event-log conventions are reused): every state change writes a `workflow_run.<transition>` event to the durable event log. The state machine is intentionally sparse so the skill can drive transitions deterministically from `workflow_plan.py update-step` / `approve` / `status` calls.

## Step identity and state

`workflow_steps` rows are keyed by `(runId, stepId)`. `stepId` is taken verbatim from the plan; `kind` is the canonical step name from the skill:

- `preflight`
- `implementation` (GNHF)
- `postflight`
- `no-mistakes`
- `merge-cleanup`
- `linear-refresh`

Step state values mirror the run state vocabulary at a finer grain: `pending`, `approved`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, `canceled`. A `workflow_steps` row carries an `order` (plan-position ordinal), a `required` flag (whether the step participates in the required-chain closure that gates `succeeded` vs `canceled`), `startedAt`, `finishedAt`, the durable `ledgerOffset` pointer into `.agent-workflows/<runId>/ledger.jsonl`, an optional `resultDigest`, and stable `errorCode` / `errorMessage` fields. Skill-produced `errorCode` values come from `failure_patterns.yaml`; Momentum stores those codes as-is so the classifier remains the source of truth. Live execution also stores Momentum-owned `live_finalize_*` codes (for example `live_finalize_commit_failed`, `live_finalize_repo_lock_lost`, and `live_finalize_result_missing`) for verification / git finalization failures that occur after the executor result is normalized.

A required ordering invariant is that the `workflow_steps` `running` transition is written **before** any managed-step child is dispatched. This is the substrate-level mirror of the M6 "audit-before-write" invariant: Momentum records the intent to run a step durably before the executor mutates anything observable.

## Approvals

`workflow_approvals` rows are keyed by `(runId, boundary)`. The stable boundary set is the skill's existing approval phrase set:

- Single-run: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`.
- Batch: `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch` (mapped to per-item runs through the optional batch grouping fields on `WorkflowRun`).

Each row stores the actor, the approval phrase, artifact provenance, a digest, the `recordedAt` timestamp, and an optional `dischargedAt` set when step progress consumes the boundary. Skill-created rows use the repo-local `approval-<boundary>.json` path and a digest of that file body so the durable row and the on-disk audit artifact agree. M8 `workflow run approve` rows can also be created directly by the CLI; when no artifact file is supplied they store synthetic `workflow-run-approve://<runId>/<boundary>` provenance plus a deterministic synthetic digest. M10 `workflow run start --approval-boundary` can seed an approval row at run creation with synthetic `workflow-run-start://<runId>/<boundary>` provenance plus the same deterministic synthetic digest convention. The approval row is the source of truth for the `workflow status` / `workflow handoff` / monitor envelopes; the JSON artifact on disk remains the canonical audit trail for skill-owned `workflow_plan.py approve` / `approve-button` approvals.

Casual approval phrasing (`"go ahead"`, `"sure"`, etc.) never produces a `workflow_approvals` row. The original M7 skill boundary still rejects casual phrasing before writing skill-owned approval artifacts, and the M8 CLI boundary refuses the same casual or insufficient phrases with `invalid_boundary`; durable rows only exist after an explicit phrase matches the requested boundary set above.

## Leases

`workflow_leases` rows are keyed by `(runId, leaseKind)`. The lease kinds are:

- `monitor` — held by the recurring `coding-workflow-monitor:<runId>` cron job for the lifetime of the run. The lease body records the cron name and TTL so a stale lease is detectable independent of the cron platform.
- `managed-step` — held while a managed step is running, either by `node_managed_dispatch.py` (or the trusted runtime binding) around a detached child or by the live-step orchestrator around a Momentum-supervised foreground wrapper process. The lease is acquired **before** execution is spawned and, for live steps, remains held through verification / git finalization until the terminal or recovery outcome has been durably reconciled.
- `dispatch` — short-lived lease held while a CLI subcommand acquires the run row for a non-idempotent mutation or while the scheduler / dispatcher lane atomically claims a runnable step before handing it to executor dispatch.

Each row stores `holder`, `acquiredAt`, `expiresAt`, `heartbeatAt`, `releasedAt` (nullable), and `stalePolicy` (`auto-release` or `manual-recovery-required`). A non-null `releasedAt` marks the lease as cleanly released and exempts it from any stale-policy promotion regardless of expiry. The stale-lease semantics mirror M3's `daemon_runs` / `repo_locks` taxonomy: the M10 scheduler-lane recovery pass can release stale `auto-release` leases in place, while a stale `manual-recovery-required` lease must surface in `recovery.md` and block further claims on the run until an operator resolves the lease and clears recovery.

Lease acquisition is exclusive for each outstanding `(runId, leaseKind)` row. In addition, an outstanding `managed-step` lease and an outstanding `dispatch` lease for the same run mutually exclude each other, so operator mutations cannot race a live managed step and a managed step cannot start while a dispatch mutation or scheduler claim owns the run. `monitor` leases may coexist with either non-monitor lease kind.

Lease freshness is classified by a pure function over the durable row plus the current clock and an optional grace window. The four classifications are:

- `released` — `releasedAt !== null`. Terminal; recovery never re-touches a released row regardless of expiry or stale policy.
- `fresh` — `releasedAt === null` and `now <= expiresAt + graceMs`. The holder still owns the lease.
- `stale-auto-release` — `releasedAt === null`, `now > expiresAt + graceMs`, and `stalePolicy === 'auto-release'`. Safe for the scheduler-lane recovery pass to release without operator involvement.
- `stale-manual-recovery-required` — `releasedAt === null`, `now > expiresAt + graceMs`, and `stalePolicy === 'manual-recovery-required'`. Must surface in `recovery.md` and block further claims on the run until an operator clears it.

Precedence is strictly `released` > `fresh` > stale (with the row's `stalePolicy` deciding between `stale-auto-release` and `stale-manual-recovery-required`). `heartbeatAt` is informational only: `expiresAt` is the sole owner-of-record for freshness, mirroring M3 `repo_locks` stale-lease semantics. A holder extends the lease by writing both `heartbeatAt` and `expiresAt` only while the stored `expiresAt` is still current; the grace window is read-side stale classification only and a late heartbeat cannot revive an expired outstanding lease.

The lease body never contains credentials or chat content. Like M5 source adapters, all credential material stays in operator-controlled environment variables and never enters durable state.

## Evidence pointers

M5's `evidence_records` table stays the canonical store for normalized artifacts produced by external runs (`plan.json`, `ledger.jsonl`, `approval-*.json`, see [docs/evidence-commands.md](../../docs/evidence-commands.md)). The M8 NGX-329 follow-up adds nullable `run_id` / `step_id` columns plus the `idx_evidence_records_run_step` index so each evidence row can attach to the owning `WorkflowRun` and, for ledger step events, the originating `workflow_steps` row when ingest is run from a coding-workflow context.

The existing evidence ingest CLI shape (`evidence ingest --path <file-or-dir>`, the `evidence_format_unknown` / `evidence_format_invalid` diagnostic codes, the idempotent `ingestKey` semantics, the `goal_not_found` / `source_item_not_found` pre-checks) stays wire-stable. Ingest auto-attaches the run from `.agent-workflows/<runId>/`; ledger step records carry `stepId`, while run-scoped plan / approval records and non-workflow evidence keep null `stepId`.

## Step execution adapter boundary

Step execution is exposed through a typed `WorkflowStepExecutor` boundary (NGX-315). The boundary mirrors the M4 `RunnerAdapter` style — a small registry keyed by `WorkflowStepKind`, a single dispatch entrypoint that validates input and traps thrown executors, and a normalized result that the M7 state machine maps to durable `workflow_steps` transitions without touching tool-specific shapes.

A `WorkflowStepExecutorInput` carries the runId, stepId, kind, attempt counter, repo path, run dir, prompt / log / result paths, optional ledger path, an optional `env` bag (used by live wrappers as the source environment filtered by `env_allow`), and a free-form `config` bag the executor interprets. A `WorkflowStepExecutorResult` reports a terminal state (`succeeded` / `failed` / `skipped`), a summary, an ordered list of checkpoints, a list of artifacts (each with `kind` / `path` / optional `digest`), an optional `resultDigest`, an optional stable `errorCode` / `errorMessage`, and optional `retryHint` (`retry_now` / `retry_after_delay` / `do_not_retry`) plus `recoveryHint` (`resume` / `skip_already_complete` / `repair_required` / `manual_recovery_required`). The recovery hint vocabulary intentionally mirrors `failure_patterns.yaml` so durable rows can carry the classification forward without re-classifying; the skill remains the source of truth for which pattern matched.

The executor boundary error taxonomy is stable: `invalid_input`, `unsupported_step`, `executor_threw`, `result_invalid`, `result_missing`, `command_failed`, `command_timed_out`, `runtime_unavailable`, `dispatch_lease_unavailable`, `manual_recovery_required`. Tool-specific errors (GNHF prompt rejection, postflight harness errors, no-mistakes harness errors, merge-cleanup tooling errors) map to one of these stable codes; the executor never leaks GNHF / postflight / no-mistakes / merge-cleanup implementation details into Momentum core types.

The first M7-03 slice shipped deterministic fake executors only. M9 later added thin Momentum-side wrappers around live local command paths and proved state recovery / lease coordination end-to-end against this same substrate boundary without replacing `coding-workflow-pipeline` internals. RC-5 (NGX-485) has since demoted the deterministic fake out of production `src/`: the default registry now uses real adapters (honest `runtime_unavailable` when no live wrapper is configured), while the old fake behavior lives under `test/helpers/fake-workflow-step-executor.ts` and is injected only by substrate smokes / boundary tests.

## Recovery

Run-scoped recovery follows the M3 / M4 manual-recovery pattern, scoped to `WorkflowRun` instead of `Goal`:

- A `WorkflowRun.needs_manual_recovery` durable flag plus `manual_recovery_reason` / `manual_recovery_at` capture the authoritative manual-recovery reason. The per-run `recovery.md` under `.agent-workflows/<runId>/recovery.md` is operator guidance rendered from that state and may be absent for best-effort live recovery artifact failures.
- The M8 recovery layer sets the flag during `workflow import` when the monitor reducer re-derives a blocking recovery code (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`) and renders the per-run artifact best-effort. M9 live execution uses the same durable flag and stored reason for live dispatch and finalization recovery classifications (`head_mismatch`, `result_missing`, `repo_lock_lost`, `auth_unavailable`, `executor_threw`, etc.) before returning control to the operator. The M10 scheduler lane also uses the flag and artifact when stale `manual-recovery-required` `workflow_leases` expire (`stale_workflow_lease_manual_recovery_required`) while stale `auto-release` leases are released in place; M10-09a production dispatch uses the same flag plus a step-scoped `manual_recovery_required` gate when a claimed step cannot be resolved or has no daemon-dispatchable executor adapter and the run row still exists. If the claimed run row vanished, no flag or gate can be written without orphaning evidence, so the dispatcher releases the lease only. Non-monitor `recovery.md` rendering is best-effort and can fail with `artifact_write_failed` while the durable flag remains authoritative.
- The flag blocks `workflow run approve` and `workflow run update-step` transitions that would leave a blocking recovery condition in place; resolving `update-step` transitions can land so operators can clear explicitly afterward.
- Operators clear the flag with `workflow run clear-recovery`, which re-derives the monitor state in the same transaction and refuses with `recovery_clear_refused` while a monitor-derived blocking condition remains. Live recovery classifications have no monitor blocker to re-prove; clearing them is the operator's assertion that the stored reason and any rendered artifact have been resolved. Retryable dispatched live-wrapper bootstrap failures may also move the same `no-mistakes` or `merge-cleanup` step back to `approved` and report `retryPrepared` so the scheduler can append a new executor round on the existing invocation. Scheduler-lane stale `manual-recovery-required` leases remain outstanding as evidence, so they can still re-derive `manual_recovery_lease` and block clear until the lease condition is resolved.
- The skill's existing failure classes (`resume`, `skip_already_complete`, `repair_required`, `manual_recovery_required` per `failure_patterns.yaml`) keep their meaning; Momentum only persists the durable flag, stored reason, and best-effort artifact for workflow substrate or live-execution recovery cases that need operator intervention.

The M3 `goals.needs_manual_recovery` flag, the `recovery.md` artifact for goals, and `recovery clear <goal-id>` stay unchanged. The M8 run-scoped flag is a sibling surface, not a replacement.

### Monitor / recovery reducer (NGX-316, M7-04)

The pure `deriveWorkflowMonitorState` reducer (`src/core/workflow/monitor-state.ts`) is the substrate-level classifier the M7 CLI envelopes, the M8 `workflow run monitor` machine envelope, and the per-run `recovery.md` renderer compose with. It takes the durable `workflow_steps` / `workflow_leases` rows, an optional `monitor.json` advisory snapshot, an optional last-checkpoint pointer, and the current clock, and returns:

- The lease-aware run state (re-exported from `deriveWorkflowRunState`), the `terminal` / `blocked` booleans, and the picked active step (running > blocked > required-failed > approved > pending).
- A per-lease `WorkflowMonitorLeaseView` carrying the freshness classification, holder, and expiry.
- A `WorkflowMonitorDrift` classification when the monitor advisory disagrees with the substrate (`monitor_says_active_but_terminal`, `monitor_says_terminal_but_running`, `monitor_step_mismatch`); terminal ledger / imported evidence always wins over a stale monitor snapshot.
- A deterministic, machine-readable `WorkflowMonitorNextAction` code (`no_action` / `advance_to_step` / `await_approval` / `resume_running` / `investigate_stale` / `clear_recovery` / `rerun_failed_step`) the operator-facing surface can consume without parsing prose.
- A stable `WorkflowMonitorRecovery` taxonomy (`stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`) and a `needsRecoveryArtifact` flag that the M8 recovery layer uses to drive the per-run `recovery.md` artifact and the `WorkflowRun.needs_manual_recovery` durable flag for blocking recovery codes. `ghost_active_no_lease` vs `stale_running_step` is discriminated on whether any non-monitor (`managed-step` / `dispatch`) lease has ever been recorded for the run — a run whose only lease row is the monitor lease has never dispatched a managed child and is classified as a ghost. `stale_running_step` is also emitted when all steps have finalized but an outstanding non-monitor lease holds the run in `running` (the lease-aware demotion path); the `nextAction` in that case is `investigate_stale` keyed off the orphan lease, not `await_approval`. `monitor_drift_stale` is emitted when the monitor advisory disagrees with the substrate state but no other primary recovery condition applies (the step has fresh evidence and is otherwise healthy); it surfaces through `needsRecoveryArtifact = true` without changing the `nextAction` away from the step's natural progression (`resume_running` / `advance_to_step` / `await_approval`) and does not set the durable block on its own. Terminal runs (`succeeded` / `canceled`) never produce a recovery code even when monitor drift is present; the drift is captured in `monitorDrift` instead.

The reducer is the substrate-level mirror of the M3 manual-recovery contract: a running step is never reported as healthy without a fresh dispatch lease or recent checkpoint (the ghost-run guard), a manual-recovery-required lease always forces `blocked` with a `clear_recovery` next action, and a stale monitor snapshot never overrides terminal step evidence.

## Monitor / cron ownership

The skill keeps owning monitor cron scheduling, the `coding-workflow-monitor:<runId>` cron name, TTL-locked monitor leases, the auto-cleanup of legacy phase-suffixed crons, the `monitor.json` snapshot under `.agent-workflows/<runId>/`, and the `lastSeenDigest` / `lastEmittedDigest` separation.

Momentum's contribution is:

- The durable `workflow_leases` row for the monitor lease, so a missing cron / stuck cron is detectable from SQLite even when the cron platform is unreachable.
- Durable `workflow_runs.updatedAt` and per-step `updatedAt` so a successful cron tick observing unchanged state can compare against the durable digest instead of reconstructing it from the ledger every tick.
- A read-only CLI envelope for the skill's `monitor_runner.py` to consult run / step / approval / lease state without re-reading the artifact tree.

Momentum never schedules cron jobs, never renders Discord, and never decides approval-button visibility. Those rules stay in the skill's `SKILL.md`.

## Composition with existing Momentum contracts

- **M3 daemon / recovery.** `daemon start` / `stop` / `status` / `recovery clear`, the `daemon_runs` / `repo_locks` schema, the stale-lease taxonomy, and the goal-scoped `recovery.md` artifact stay wire-stable. M7 leases are a sibling table to `repo_locks`; they do not collide with the M3 lease model.
- **M4 runners and policy.** `RunnerAdapter`, the `fake` / `trusted-shell` / `acp` profiles, and the `MOMENTUM.md` runtime policy loader stay wire-stable. A coding workflow's `implementation` step typically dispatches into a `trusted-shell` or `acp` runner; M7 does not introduce a new runner kind.
- **M5 source / evidence / intent.** `source_items` / `source_snapshots` / `source_reconciliation_runs` / `evidence_records` / `update_intents` stay wire-stable. M7 uses existing evidence records plus path-based discovery; the M8 NGX-329 additive `run_id` / `step_id` linkage does not rename or reshape the existing evidence CLI semantics.
- **M6 external apply.** `intent apply --external-apply`, the two-phase claim → audit → write → finalize lifecycle, the `intent_apply_policy` precedence, the comment-only default, the idempotency marker shape, the `intent_apply_in_progress` CAS result, and the `blocked` non-replay state stay wire-stable. M7 never bypasses the M6 apply path; if a coding workflow step needs an external write, it goes through `intent apply --external-apply` exactly as today.

## Test boundary

The skill's executors stay tested by their own suites (`tests.test_coding_workflow_pipeline`, etc.). The M7 substrate is tested through Momentum's existing `pnpm test` / smoke pipeline:

- Unit tests pin the `WorkflowRun` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema and CLI envelope shapes.
- The built-CLI smoke (`test/m7-e2e-smoke.test.ts`) gains coverage that drives a coding workflow end-to-end against a minimal `coding-workflow-pipeline` fixture without invoking the real skill scripts. The smoke fixture must not depend on a live Linear / Discord / cron platform.
- Existing public-docs-hygiene guards stay in force: M7 substrate docs live under `internal/`, not `docs/` or `README.md`.

Live integration with the real `coding-workflow-pipeline` skill is opt-in via an explicit env var (mirroring the M6 `api.linear.app` test guard) and stays out of the default test suite.
