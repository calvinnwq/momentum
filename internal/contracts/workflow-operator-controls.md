# Contract: Workflow Run Operator Controls (M8)

**Status:** M8 contract, in flight (pinned by NGX-323). The M8 implementation slices NGX-324..NGX-329 land against this contract; NGX-330 closes M8 out and is the only slice authorized to flip the `doctor --json` milestone marker forward from the M7 closeout string. The M3 / M4 / M5 / M6 / M7 surfaces this contract composes with remain wire-stable through M8.

This contract is the cross-milestone source of truth for the operator-control CLI envelopes Momentum layers on top of the M7 OpenClaw coding workflow backend substrate. It is the long-lived companion to [`../milestones/m8-workflow-run-operator-controls.md`](../milestones/m8-workflow-run-operator-controls.md); the milestone doc owns the *scope* of M8, this contract owns the *invariants* that survive after M8 closeout.

The underlying substrate contract is [`workflow-runs.md`](workflow-runs.md). That contract is unchanged by M8: the `WorkflowRun` record, the `workflow_steps` / `workflow_approvals` / `workflow_leases` schema, the run / step / lease state vocabulary, the transition reducer, the lease classifier, the executor boundary, and the monitor reducer all stay as M7 shipped them. The M7 closeout regression matrix at [`../regression-matrix.md`](../regression-matrix.md) also stays in force through M8.

The `coding-workflow-pipeline` skill stays the orchestration UX (Discord delivery, monitor cron scheduling, plan composition, batch UX, approval-button rendering, failure classification, recovery procedures, live executor invocation). This contract is the boundary Momentum exposes to that skill for **durable operator control**, nothing more.

## Scope

This contract covers:

- The M8 operator-control CLI envelopes: `workflow run list`, `workflow run approve`, `workflow run update-step`, `workflow run monitor`.
- The per-run recovery artifact (`.agent-workflows/<runId>/recovery.md`) and the durable `WorkflowRun.needs_manual_recovery` flag wiring (NGX-327).
- The additive, backwards-compatible `runId` / `stepId` linkage on the M5 `evidence_records` table (NGX-329).
- The refusal taxonomy, JSON field stability, and compatibility rules that hold across every M8 envelope.
- The ownership boundary between the M8 envelopes and the `coding-workflow-pipeline` skill.

It does **not** cover:

- The M7 substrate primitives themselves. Those stay pinned by [`workflow-runs.md`](workflow-runs.md).
- The M3 daemon / recovery, M4 runner / policy, M5 source / evidence / intent, or M6 external apply contracts. Those remain wire-stable.
- Live executor invocation. Live wrappers around `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh` are explicitly **deferred** to a future milestone. Until a future explicit decision gate changes the boundary, M8 envelopes never spawn an executor process.
- Discord-side approval UX, monitor cron scheduling, or managed-step dispatch. Those stay owned by the skill.
- Plan composition, batch policy, no-mistakes harness/model routing, or failure classification. Those stay owned by the skill.

## M8 envelope contract

Every M8 envelope is read / approve / transition / render over the existing durable substrate. None of them ever:

- Spawn a managed child, executor, or shell.
- Schedule, create, or clean up a cron job.
- Render Discord output or call the Discord API.
- Mutate `.agent-workflows/<runId>/ledger.jsonl`, `plan.json`, or `monitor.json` directly.
- Issue an external write to Linear / GitHub / any tracker. (External writes still go through M6 `intent apply --external-apply` and are operator-mediated by `intent_apply_policy`.)

### `workflow run list` (NGX-324)

Read-only filterable durable-row query. Returns workflow-run summaries from the durable `workflow_runs` table (and joined `workflow_steps` / `workflow_approvals` / `workflow_leases` data as needed).

- Filters cover the existing M7 buckets (`active` / `blocked` / `completed` / `imported`), run state, approval boundary, issue scope, repo path, and updated-time windows where the stored row supports them.
- Output JSON has stable field names and includes enough identifiers (`runId` first, plus optional disambiguators like `repoPath`) to pass into `workflow status` / `workflow handoff` / `workflow run monitor` without re-derivation.
- Text output is bounded and stable; it never embeds chat-transcript content or secrets.
- Invalid filters refuse with `invalid_filter`. Unknown filter values refuse with `invalid_filter` rather than silently falling back. An empty result set is a successful empty list, not a refusal.
- The command never mutates and never contacts external systems.
- Compatible with `workflow status` and `workflow handoff` in both directions: every `workflow run list` row exposes the identifiers the existing single-run envelopes consume, and the existing single-run envelopes continue to satisfy detail-mode queries without depending on `workflow run list`.

### `workflow run approve` (NGX-325)

Durable approval CLI for the existing stable boundary phrase set:

- Single-run boundaries: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`.
- Batch boundaries (mapped to per-item runs through the optional batch grouping fields on `WorkflowRun`): `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch`.

Persists a `workflow_approvals` row keyed by `(runId, boundary)` with `actor`, `phrase`, `boundary`, `artifactPath`, `artifactDigest`, and `recordedAt`. When `--artifact-path` is provided, the path must be readable and the digest must match the file body; an unreadable / missing path or digest mismatch refuses with `approval_digest_mismatch` and writes no row. When `--artifact-path` is omitted, the stored `artifactPath` is `workflow-run-approve://<runId>/<boundary>` with a deterministic synthetic digest; a supplied `--artifact-digest` must match that synthetic digest or refuse with `approval_digest_mismatch`. A duplicate approval for the same `(runId, boundary)` refuses with `duplicate_approval` and must not produce confusing duplicate state.

On success, `workflow run approve` also updates `workflow_runs.approval_boundary` unless the stored boundary has a strictly higher rank, promotes a pending run to `approved`, and marks pending steps covered by the approved boundary as `approved`. Boundary coverage follows the M7 reducer mapping: `implementation` / `through-implementation` cover through implementation; `through-postflight` covers through postflight; `no-mistakes`, `through-no-mistakes`, `overnight-safe`, and `through-merge-gates` cover through no-mistakes; `merge-cleanup` / `through-merge-cleanup` cover through merge-cleanup; `full`, `final-cleanup`, and `full-batch` cover the full required chain; `plan-only` covers no steps. Equal-rank approvals replace the stored `approval_boundary`; lower-rank approvals preserve the higher stored boundary while still persisting their own approval row.

Casual approval phrasing (`"go ahead"`, `"sure"`, etc.) never produces a `workflow_approvals` row. That refusal stays at the boundary edge: the CLI refuses with `invalid_boundary` (the M7-contract refusal that casual phrasing never produces a durable row stays in force).

Approval state surfaces through `workflow status` / `workflow handoff` / `workflow run list` / `workflow run monitor`; none of those existing surfaces change shape.

### `workflow run update-step` (NGX-326)

Operator-driven step transition surface. Drives the existing M7 reducer / state machine for `succeeded` / `skipped` / `failed` / `blocked` transitions with ledger / evidence pointers and an operator-supplied reason.

- Legal step transitions are persisted with evidence or ledger pointers and the operator-supplied reason or context. The required-chain run-state derivation in `deriveWorkflowRunState` stays the authority on run-level state — `workflow run update-step` never bypasses it.
- Illegal transitions refuse with `invalid_transition` and write no partial durable state. An unknown step refuses with `step_not_found`. A finalize-after-finalize refuses with `invalid_transition` (or returns idempotently if the transition is byte-equal to the existing finalize, per the rule that lands at NGX-326).
- The command remains local-only. It never spawns or stops a managed child, never schedules cron, and never issues an external write. If a future caller needs to start or stop a live process, that work belongs in a separately approved milestone slice — the M8 contract refuses to grow this envelope into process management.
- The `needs_manual_recovery` flag (NGX-327) blocks update-step transitions that would make recovery worse until an operator explicitly clears it.

### `workflow run monitor` (NGX-328)

Read-only machine envelope the skill's `monitor_runner.py` consumes. Emits a stable JSON shape derived from the M7 monitor reducer (`deriveWorkflowMonitorState`):

- `schemaVersion` (integer, monotonically incremented; M8 lands version 1 of this envelope).
- Run identity, current run state, current step state, lease summary.
- Machine-readable `nextAction` code from the M7 reducer's stable taxonomy (`no_action` / `advance_to_step` / `await_approval` / `resume_running` / `investigate_stale` / `clear_recovery` / `rerun_failed_step`).
- Recovery classification from the M7 reducer's stable taxonomy (`stale_running_step` / `ghost_active_no_lease` / `manual_recovery_lease` / `monitor_drift_stale` / `failed_required_step`, or null when no recovery applies).
- Evidence pointers (typed through NGX-329), terminal / reportability flags.

Unknown or malformed run ids refuse with `run_not_found` (or `run_id_required` when omitted). The command never mutates run / step / approval / lease state. It never schedules cron, never delivers to Discord, and never spawns a managed child.

## Refusal taxonomy

The M8 envelopes reuse the M7 refusal taxonomy verbatim and extend it only with stable, prefix-style additions:

- Shared (from M7, wire-stable): `unknown_workflow_subcommand`, `invalid_filter`, `invalid_state`, `invalid_limit`, `run_id_required`, `run_not_found`.
- `workflow run approve` (NGX-325 additions): `invalid_boundary`, `approval_digest_mismatch`, `duplicate_approval`; it also consumes `manual_recovery_required` when the run-scoped recovery flag blocks approval.
- `workflow run update-step` (NGX-326 additions): `invalid_transition`, `step_not_found`.
- Run-scoped recovery (NGX-327 additions): `manual_recovery_required`, `recovery_clear_refused`.
- `workflow run monitor` (NGX-328): no new codes beyond the shared set; malformed input refuses with `run_id_required` / `run_not_found` exactly like the M7 read-only envelopes.

Refusal codes are stable strings; existing codes never get renamed, narrowed, or merged. Implementation slices that need a new code add it here first.

## Per-run recovery (NGX-327)

The per-run recovery surface mirrors the M3 goal-scoped contract, scoped to `WorkflowRun` instead of `Goal`:

- A durable `WorkflowRun.needs_manual_recovery` flag (or equivalent typed column / sidecar row) captures the manual-recovery reason. The flag is set automatically when the M7 monitor reducer emits `manual_recovery_lease`, when a managed-step dispatch finalizes with a `manual_recovery_required` classification from `failure_patterns.yaml`, or when a `workflow_steps` finalize observes an irreconcilable mismatch between the durable row and the ledger / artifact tree.
- A per-run `.agent-workflows/<runId>/recovery.md` artifact renders the manual-recovery reason and the safe next steps. The artifact carries run id, step id, recovery classification, evidence pointers, recommended next action, and rollback / safety notes. It never embeds secrets, raw token values, or chat-transcript content.
- The flag blocks future `workflow run update-step` and `workflow run approve` claims that would make recovery worse, until an operator explicitly clears it.
- The clear path is explicit and auditable. It refuses with `recovery_clear_refused` if the underlying blocking state still exists.

The M3 `goals.needs_manual_recovery` flag, the `recovery.md` artifact for goals, and `recovery clear <goal-id>` stay unchanged. The M8 run-scoped flag is a sibling surface, not a replacement.

## Typed evidence linkage (NGX-329)

M8 adds optional `runId` / `stepId` linkage to the existing M5 `evidence_records` table using nullable `run_id` / `step_id` columns plus the partial composite index `idx_evidence_records_run_step` for run-scoped and run+step-scoped lookups.

- The existing M5 evidence ingest CLI (`evidence ingest --path <file-or-dir>`), the `evidence_format_unknown` / `evidence_format_invalid` diagnostic codes, the `ingestKey` idempotency semantics, and the `goal_not_found` / `source_item_not_found` pre-checks all stay wire-stable.
- Migration is additive. Existing evidence rows continue to read with null `runId` / `stepId` linkage. Non-workflow evidence rows continue to carry null linkage.
- Ingest from `.agent-workflows/<runId>/` attaches each artifact to the owning `runId`; ledger step events also attach the originating `stepId`, while run-scoped plan / approval artifacts carry null `stepId`.
- Idempotent replay can attach missing `runId` / `stepId` linkage to an existing unlinked row, but never overwrites non-null linkage.
- Typed pointers surface through `workflow status` / `workflow handoff` / `workflow run list` / `workflow run monitor` without breaking those envelopes' existing JSON field names. Legacy rows with null `run_id` continue to surface through the artifact-path fallback where those envelopes support it.

The M5 source-adapter contract at [`source-adapters.md`](source-adapters.md) is unchanged by this extension. The M6 external apply contract at [`intent-apply.md`](intent-apply.md) is also unchanged — `evidence_records` does not influence the apply lifecycle.

## Stable JSON field contract

Every M8 envelope emits stable JSON field names. The fields land progressively as each implementation slice ships, but once landed they do not get renamed. JSON output additions are additive — consumers can rely on existing field names through M8.

A non-exhaustive seed list of fields the M8 envelopes pin:

- `runId`, `repoPath`, `runState`, `stepState`, `boundary`, `phrase`, `artifactPath`, `artifactDigest`, `recordedAt`, `actor`.
- `nextAction` (object with `code` plus optional `stepId`, `boundary`, or `runId`), `monitor.recovery` (object with `code` plus optional `stepId`).
- `evidence` (array of typed evidence pointers with `path`, optional `digest`, optional `runId`, optional `stepId`).
- `needsManualRecovery` (boolean), `recovery` (object surfacing the classification, recommended next action, and link to `recovery.md`).
- `schemaVersion` (on `workflow run monitor` only; M8 lands version 1).

Field renames are not allowed during M8. Field additions are additive only.

## Compatibility with existing artifacts and substrates

M8 must not break `coding-workflow-pipeline` runs in flight or any prior milestone surface. Specifically:

- `.agent-workflows/<runId>/plan.json`, `.agent-workflows/<runId>/ledger.jsonl`, `.agent-workflows/<runId>/approval-<boundary>.json`, and `.agent-workflows/<runId>/monitor.json` stay the canonical skill-owned artifacts. M8 reads them through the existing M7 `workflow import` path; it does not introduce a second importer or a parallel artifact tree.
- Step names stay stable: `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`.
- Approval boundary phrases stay stable across both single-run and batch boundaries (full list in [`workflow-runs.md`](workflow-runs.md) and above).
- The M5 evidence ingest CLI shape stays wire-stable; M8 only adds optional linkage columns.
- The M6 two-phase external apply contract stays wire-stable. M8 never bypasses `intent apply --external-apply`; an operator step transition that needs an external write still goes through M6.

The M3 daemon (`daemon start` / `daemon stop` / `daemon status` / `recovery clear`), the `daemon_runs` / `repo_locks` schema, the M4 `RunnerAdapter` boundary (`fake` / `trusted-shell` / `acp` profiles), the runtime `MOMENTUM.md` policy loader, and the M5 `source_items` / `source_snapshots` / `source_reconciliation_runs` / `update_intents` schemas all stay wire-stable through M8.

## Composition with prior contracts

- **M3 daemon / recovery.** Unchanged. M8 run-scoped recovery is a sibling surface to M3 goal-scoped recovery, not a replacement.
- **M4 runners and policy.** Unchanged. M8 envelopes never spawn a managed child or a runner; live executor invocation stays inside the skill.
- **M5 source / evidence / intent.** Unchanged at the schema and CLI shape level. M8 only adds optional `runId` / `stepId` linkage on `evidence_records`.
- **M6 external apply.** Unchanged. `intent apply --external-apply`, `intent_apply_policy`, the `intent_apply_in_progress` CAS result, the comment-only default, the idempotency marker shape, and the `blocked` non-replay state stay wire-stable. M8 envelopes never issue an external write directly.
- **M7 substrate.** Unchanged. `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases`, `deriveWorkflowRunState`, `deriveWorkflowMonitorState`, `classifyWorkflowLease`, the `WorkflowStepExecutor` boundary, the deterministic fake executors, and the read-only `workflow import` / `workflow status` / `workflow handoff` envelopes all stay wire-stable. M8 reuses them; it does not reshape them.

The M7 closeout regression matrix at [`../regression-matrix.md`](../regression-matrix.md) and the M7 milestone narrative at [`../milestones/m7-openclaw-coding-workflow-backend.md`](../milestones/m7-openclaw-coding-workflow-backend.md) stay the source of truth for the substrate guard. NGX-330 (M8-07) extends the matrix with the new operator-control failure modes M8 closes.

## Live wrapper deferral

Live executor wrappers around `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh` are explicitly **deferred** past M8 closeout. The deterministic M7 fake executors continue to satisfy the substrate boundary through M8. Momentum never schedules cron, never renders Discord, never spawns a managed child, and never invokes a live executor as part of an M8 envelope. Any future milestone that wants to change that boundary must land an explicit decision gate first.

If an M8 implementation slice discovers that its acceptance criteria require live process management, the slice stops and asks for a separately approved decision gate. M8 will not be re-scoped silently.

## Closeout marker policy

The `doctor --json` milestone string remains the M7 closeout marker through every M8 implementation slice (NGX-324..NGX-329). NGX-330 (M8-07) is the only slice authorized to flip the marker; until then, `doctor --json` continues to report `Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete`.

## Test boundary

M8 surfaces are tested through Momentum's existing `pnpm test` pipeline:

- Unit / reducer tests pin filter logic, transition legality, approval boundary validation, recovery classification, and evidence linkage helpers.
- Built-CLI smoke (`test/smoke.test.ts`) gains M8 coverage at NGX-330: list / approve / update-step / recovery / monitor / evidence linkage composing end-to-end against the deterministic fake executors, with no live OpenClaw pipeline, Discord, GitHub, Linear, or external tracker writes.
- Contract tests pin the envelope names, refusal taxonomy, JSON field stability, and the preserved M3-M7 surfaces.
- Public-docs hygiene stays in force: M8 planning lives under `internal/`, not under `docs/` or `README.md`.

Live integration with the real `coding-workflow-pipeline` skill stays out of the default test suite; if it ever runs, it gates behind the same explicit env-var pattern M6 uses for `api.linear.app`.
