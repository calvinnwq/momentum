# Contract: WorkflowRun (OpenClaw Coding Workflow Backend)

**Status:** M7 contract (active). Pinned by NGX-312 (M7-00). The durable substrate primitives have begun shipping against this contract: the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration, the `WorkflowRun` identity columns (`repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`), the pure run / step state vocabulary and transition reducer, the lease-aware `deriveWorkflowRunState`, and the `classifyWorkflowLease` lease-freshness classifier. The M7 CLI envelopes, built-CLI smoke coverage, and the `doctor --json` closeout marker flip remain pending in follow-up slices. The M3 / M4 / M5 / M6 surfaces this contract composes with remain wire-stable.

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

Alongside identity, the durable row captures the run `source` (origin label for the plan), an optional `sourceArtifactPath` pointing back to the on-disk plan artifact, and the `planJson` body itself, so the substrate can reconstruct what was approved without re-reading `.agent-workflows/<runId>/plan.json`.

The lifecycle states are:

- `pending` — durable row exists, plan + scope captured, no boundary approved yet.
- `approved` — at least one approval boundary recorded; the highest cumulative boundary is the current approval.
- `running` — at least one `workflow_steps` row is in `running` state.
- `succeeded` — every required step in the approved boundary chain finalized in `succeeded` / `skipped`, at least one required step finalized in `succeeded`, and the run has no outstanding leases. A required chain that finalizes entirely in `skipped` (no `succeeded`) resolves to `canceled` instead.
- `failed` — at least one required step finalized in `failed` and no recovery is in flight.
- `blocked` — manual recovery required (see "Recovery" below). A `blocked` run is non-replayable until cleared.
- `canceled` — explicit operator cancellation; mirrors the M3 `daemon stop --now` `canceled` shape but scoped to a run, not the daemon.

Transitions are append-only at the event level (M3 event-log conventions are reused): every state change writes a `workflow_run.<transition>` event to the durable event log. The state machine is intentionally sparse so the skill can drive transitions deterministically from `workflow_plan.py update-step` / `approve` / `status` calls.

## Step identity and state

`workflow_steps` rows are keyed by `(runId, stepId)`. `stepId` is taken verbatim from the plan; `kind` is the canonical step name from the skill:

- `preflight`
- `implementation` (GNHF)
- `postflight`
- `no-mistakes`
- `merge-cleanup`
- `linear-refresh`

Step state values mirror the run state vocabulary at a finer grain: `pending`, `approved`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, `canceled`. A `workflow_steps` row carries `startedAt`, `finishedAt`, the durable `ledgerOffset` pointer into `.agent-workflows/<runId>/ledger.jsonl`, an optional `resultDigest`, and stable `errorCode` / `errorMessage` fields. The taxonomy for `errorCode` is owned by `failure_patterns.yaml` in the skill; Momentum stores the code as-is so the classifier remains the source of truth.

A required ordering invariant is that the `workflow_steps` `running` transition is written **before** any managed-step child is dispatched. This is the substrate-level mirror of the M6 "audit-before-write" invariant: Momentum records the intent to run a step durably before the executor mutates anything observable.

## Approvals

`workflow_approvals` rows are keyed by `(runId, boundary)`. The stable boundary set is the skill's existing approval phrase set:

- Single-run: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`.
- Batch: `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch` (mapped to per-item runs through the optional batch grouping fields on `WorkflowRun`).

Each row stores the actor, the approval phrase, the repo-local `approval-<boundary>.json` path the skill wrote, a digest of that file body, the `recordedAt` timestamp, and an optional `dischargedAt` set when step progress consumes the boundary. The approval row is the source of truth for `workflow run status` / monitor envelopes; the JSON artifact on disk is the canonical audit trail consumed by `workflow_plan.py approve` / `approve-button`.

Casual approval phrasing (`"go ahead"`, `"sure"`, etc.) never produces a `workflow_approvals` row. That refusal stays inside the skill (`workflow_plan.py approve` rejects it), and the durable row only exists once the skill emits a phrase that matches the boundary set above.

## Leases

`workflow_leases` rows are keyed by `(runId, leaseKind)`. The lease kinds are:

- `monitor` — held by the recurring `coding-workflow-monitor:<runId>` cron job for the lifetime of the run. The lease body records the cron name and TTL so a stale lease is detectable independent of the cron platform.
- `managed-step` — held by `node_managed_dispatch.py` (or the trusted runtime binding) while a managed step's detached child is running. The lease is acquired **before** the child is spawned and released on finalize.
- `dispatch` — short-lived lease held while a CLI subcommand acquires the run row for a non-idempotent mutation.

Each row stores `holder`, `acquiredAt`, `expiresAt`, `heartbeatAt`, and `stalePolicy` (`auto-release` or `manual-recovery-required`). The stale-lease semantics mirror M3's `daemon_runs` / `repo_locks` taxonomy: an `auto-release` lease whose holder is terminal can be auto-released by a future startup-recovery pass; a `manual-recovery-required` lease must surface in `recovery.md` and block further claims on the run until an operator clears it.

The lease body never contains credentials or chat content. Like M5 source adapters, all credential material stays in operator-controlled environment variables and never enters durable state.

## Evidence pointers

M5's `evidence_records` table stays the canonical store for normalized artifacts produced by external runs (`plan.json`, `ledger.jsonl`, `approval-*.json`, see [docs/evidence-commands.md](../../docs/evidence-commands.md)). M7 adds optional `runId` / `stepId` linkage so each evidence row attaches to the owning `WorkflowRun` and `workflow_steps` row when ingest is run from a coding-workflow context.

The exact schema for the `runId` / `stepId` extension lands in a follow-up M7 implementation slice. The contract here is only that the existing evidence ingest CLI shape (`evidence ingest --path <file-or-dir>`, the `evidence_format_unknown` / `evidence_format_invalid` diagnostic codes, the idempotent `ingestKey` semantics, the `goal_not_found` / `source_item_not_found` pre-checks) stays wire-stable. Adding a `--workflow-run` flag and/or auto-attaching the run/step from the artifact path is allowed; renaming or removing the existing flags is not.

## Recovery

Run-scoped recovery follows the M3 / M4 manual-recovery pattern, scoped to `WorkflowRun` instead of `Goal`:

- A `WorkflowRun.needs_manual_recovery` durable flag plus a per-run `recovery.md` under `.agent-workflows/<runId>/recovery.md` capture the manual-recovery reason and the safe next steps.
- The flag is set automatically when a `manual-recovery-required` lease goes stale, when a managed-step dispatch returns `manual_recovery_required` per the skill's classifier, or when a `workflow_steps` finalize observes an irreconcilable mismatch between the durable row and the ledger / artifact tree.
- The flag blocks future `workflow_steps` `running` transitions on that run until an operator runs the M7 equivalent of `recovery clear`.
- The skill's existing failure classes (`resume`, `skip_already_complete`, `repair_required`, `manual_recovery_required` per `failure_patterns.yaml`) keep their meaning; Momentum only persists the durable flag + artifact for the `manual_recovery_required` case.

The M3 `goals.needs_manual_recovery` flag, the `recovery.md` artifact for goals, and `recovery clear <goal-id>` stay unchanged. The M7 run-scoped flag is a sibling surface, not a replacement.

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
- **M5 source / evidence / intent.** `source_items` / `source_snapshots` / `source_reconciliation_runs` / `evidence_records` / `update_intents` stay wire-stable. M7 extends `evidence_records` linkage; it does not rename or reshape the existing tables.
- **M6 external apply.** `intent apply --external-apply`, the two-phase claim → audit → write → finalize lifecycle, the `intent_apply_policy` precedence, the comment-only default, the idempotency marker shape, the `intent_apply_in_progress` CAS result, and the `blocked` non-replay state stay wire-stable. M7 never bypasses the M6 apply path; if a coding workflow step needs an external write, it goes through `intent apply --external-apply` exactly as today.

## Test boundary

The skill's executors stay tested by their own suites (`tests.test_coding_workflow_pipeline`, etc.). The M7 substrate is tested through Momentum's existing `pnpm test` / smoke pipeline:

- Unit tests pin the `WorkflowRun` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema and CLI envelope shapes.
- The built-CLI smoke (`test/smoke.test.ts`) gains coverage that drives a coding workflow end-to-end against a minimal `coding-workflow-pipeline` fixture without invoking the real skill scripts. The smoke fixture must not depend on a live Linear / Discord / cron platform.
- Existing public-docs-hygiene guards stay in force: M7 substrate docs live under `internal/`, not `docs/` or `README.md`.

Live integration with the real `coding-workflow-pipeline` skill is opt-in via an explicit env var (mirroring the M6 `api.linear.app` test guard) and stays out of the default test suite.
