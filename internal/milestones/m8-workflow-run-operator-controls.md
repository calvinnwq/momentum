# Milestone 8: Workflow Run Operator Controls

**Status:** Closed out at NGX-330 (M8-07). All operator-control slices (NGX-323 through NGX-329) shipped, and the closeout slice (NGX-330) flipped the `doctor --json` milestone marker forward to the M8 closeout string (see "Closeout marker policy" below for the exact text).

M8 is closed out. NGX-330 (M8-07) flipped the `doctor --json` milestone marker forward to the M8 closeout string after the M8-00 through M8-06 implementation slices (NGX-323 through NGX-329) landed and the end-to-end operator-control smoke passed. Through every prior M8 slice the marker stayed pinned to the M7 closeout string (see "Closeout marker policy" below for the exact text).

Milestone 8 layers operator-control CLI envelopes on top of the M7 OpenClaw coding-workflow backend substrate. M7 made the run state durable (`workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases`); M8 makes the operator-visible run controls durable. M8 keeps the substrate wire-stable, adding only nullable monitor-advisory columns on `workflow_runs` so imports and operator mutations can persist the snapshot consumed by status / handoff / monitor views; it does not rename the M7 envelopes or take ownership of executor invocation away from the OpenClaw `coding-workflow-pipeline` skill. In particular, M8 defers live executor wrappers (around `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, `project-progress-refresh`) to a later milestone unless a future explicit decision gate changes that boundary.

The M8 contract is the long-lived companion to [`internal/contracts/workflow-operator-controls.md`](../contracts/workflow-operator-controls.md); the milestone doc here owns the *scope* of M8, the contract doc owns the *invariants* that survive after M8 closeout. The underlying substrate contract stays [`internal/contracts/workflow-runs.md`](../contracts/workflow-runs.md), wire-stable through M8.

## Milestone goal

Land the operator-control CLI envelopes that let a human operator (and the `coding-workflow-pipeline` skill's `monitor_runner.py` / `monitor_bridge.py` clients) inspect, approve, transition, and recover a `WorkflowRun` from durable state without parsing prose, scraping artifacts, or hand-editing `.agent-workflows/<runId>/ledger.jsonl`. Concretely:

- `workflow run list` for filterable durable-row queries.
- `workflow run approve` for explicit, durable approval boundaries (mirroring the existing skill phrase set).
- `workflow run update-step` for operator-driven step finalize / skip / fail / block transitions through the existing M7 reducer.
- `workflow run clear-recovery` for explicit run-scoped manual-recovery clears after the blocking condition is resolved.
- `workflow run monitor` for a stable read-only machine envelope the skill's monitor runner consumes.
- Per-run `recovery.md` renderer plus the durable `needs_manual_recovery` flag (sibling to the M3 goal-scoped recovery artifact).
- Typed `runId` / `stepId` evidence linkage so workflow artifacts attach to owning runs and steps without path-only inference.

The M7 read-only `workflow import`, `workflow status`, and `workflow handoff` envelopes remain wire-stable. M8 reuses the M7 monitor reducer (`deriveWorkflowMonitorState`), the run-state reducer (`deriveWorkflowRunState`), the lease classifier (`classifyWorkflowLease`), and the M7 refusal taxonomy (`unknown_workflow_subcommand` / `invalid_filter` / `invalid_state` / `invalid_limit` / `run_id_required` / `run_not_found`) verbatim where they apply.

## Data ownership boundary

The M8 contract draws no new substrate boundary. M7's ownership boundary holds:

**Momentum (M7 + M8) owns:**

- The durable `WorkflowRun` record, `workflow_steps`, `workflow_approvals`, and `workflow_leases` rows (M7).
- The additive monitor-advisory snapshot columns on `workflow_runs` (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`) populated from `monitor.json` on import and refreshed after operator mutations (M8, NGX-328).
- The optional `WorkflowRun.needs_manual_recovery` durable flag wiring and the per-run `.agent-workflows/<runId>/recovery.md` renderer (M8, NGX-327).
- The CLI envelopes: read-only `workflow import` / `workflow status` / `workflow handoff` (M7), plus the M8 operator-control envelopes `workflow run list` / `workflow run approve` / `workflow run update-step` / `workflow run clear-recovery` / `workflow run monitor` (NGX-324 / NGX-325 / NGX-326 / NGX-327 / NGX-328).
- Typed `runId` / `stepId` evidence linkage on `evidence_records` (M8, NGX-329) — additive, never reshaping the existing M5 evidence ingest semantics.

**`coding-workflow-pipeline` (skill) keeps owning:**

- Plan composition (`workflow_plan.py plan` / `batch-plan` / `update-step`).
- Discord approval UX and delivery (`discord-envelope`, `approve-button`, button-vs-phrase routing).
- Monitor cron scheduling, the `coding-workflow-monitor:<runId>` cron name, TTL-locked monitor lease acquisition through `monitor_runner.py`, and the legacy phase-suffixed cron auto-cleanup.
- Managed-step dispatch (`node_managed_dispatch.py`, `bindings/managed_runner.mjs`, `bindings/tool_entrypoint.mjs`) and the detached child lifecycle.
- Live executor invocation: `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, `project-progress-refresh`.
- Quota route selection, no-mistakes harness/model policy, batch merge-gate policy, skill-hardening / batch digest.
- Failure classification source of truth (`failure_patterns.yaml`) and recovery procedures (`references/recovery.md`).

M8 does not change which side of that boundary anything sits on. The M8 envelopes are pure read / approve / transition / render surfaces over the durable substrate; they never spawn an executor, never render Discord, and never schedule cron.

## M8 CLI envelope contract

The M8 envelopes are pinned by name in this contract so later implementation slices cannot drift the name space. All M8 envelopes share the M7 refusal taxonomy and emit stable JSON field names plus optional text rendering.

- **`workflow run list`** (NGX-324). Read-only filterable durable-row query. Filters cover the existing M7 buckets (`active` / `blocked` / `completed` / `imported`), run state, approval boundary, issue scope, repo, and updated time where the stored row supports it. Output identifiers are sufficient to pass into `workflow status` / `workflow handoff` without re-derivation. The existing `workflow status` and `workflow handoff` envelopes remain wire-stable and continue to satisfy single-run inspection.
- **`workflow run approve`** (NGX-325). Durable approval CLI for the skill's existing approval boundary phrase set (`implementation` / `through-implementation` / `no-mistakes` / `through-no-mistakes` / `merge-cleanup` / `through-merge-cleanup` / `full`, plus the batch boundaries pinned in [`workflow-runs.md`](../contracts/workflow-runs.md)). Persists `workflow_approvals` rows with actor, phrase, boundary, `artifactPath`, `artifactDigest`, and `recordedAt`; omitted `--artifact-path` stores `workflow-run-approve://<runId>/<boundary>` provenance with a deterministic synthetic digest. Casual approval phrasing (`"go ahead"`, `"sure"`) remains refused — the M7 contract that casual phrases never produce a durable row stays in force.
- **`workflow run update-step`** (NGX-326). Operator-driven step transition surface that drives the existing M7 reducer / state machine. Supports `succeeded` / `skipped` / `failed` / `blocked` operator transitions with ledger / evidence pointers and an operator-supplied reason. Illegal transitions refuse with stable diagnostics and no partial durable mutation. The required-chain derivation in `deriveWorkflowRunState` stays the authority on run-level state; M8 never bypasses it.
- **`workflow run clear-recovery`** (NGX-327). Explicit clear path for the run-scoped manual-recovery flag after the durable monitor view no longer reports a blocking recovery condition. Refuses instead of clearing stale or still-blocked runs, leaves `recovery.md` on disk as audit evidence, and never performs repair or process management.
- **`workflow run monitor`** (NGX-328). Read-only machine envelope for the skill's `monitor_runner.py` and any other monitor client. Emits a stable JSON shape derived from `deriveWorkflowMonitorState` (including `schemaVersion`, run identity, current state, next-action code, evidence pointers, reportability / terminal indicators). Read-only by construction — never mutates run / step / approval / lease state, never schedules cron, never delivers to Discord.

Refusal taxonomy reuses the M7 codes verbatim: `unknown_workflow_subcommand`, `invalid_filter`, `invalid_state`, `invalid_limit`, `run_id_required`, `run_not_found`. NGX-325 adds approval-specific codes (e.g. `invalid_boundary`, `approval_digest_mismatch`, `duplicate_approval`) and NGX-326 adds transition-specific codes (e.g. `invalid_transition`, `step_not_found`); both stay within the same stable-code style and land in the contract doc as the implementation slices ship.

## Per-run recovery contract (NGX-327)

M8 lifts the M7-deferred per-run recovery artifact and durable flag into the substrate:

- A `WorkflowRun.needs_manual_recovery` durable flag (or equivalent typed column / sidecar row), set automatically when import re-derives a blocking monitor classification: `manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`.
- A per-run `.agent-workflows/<runId>/recovery.md` artifact rendered from the monitor reducer's recovery view. The artifact carries run id, step id, recovery classification, evidence pointers, recommended next action, and rollback / safety notes. The artifact never embeds secrets, raw token values, or chat-transcript content.
- The flag blocks future `workflow run approve` claims and `workflow run update-step` transitions that would make recovery worse or leave the blocking condition in place until an operator explicitly clears it.
- The `workflow run clear-recovery` path is explicit and auditable; it refuses if the underlying blocking state still exists.

The M3 goal-scoped recovery surfaces (`recovery clear <goal-id>`, `goals.needs_manual_recovery`, the per-goal `recovery.md` under `goals/<goal-id>/`) stay wire-stable. The M8 run-scoped surface is a sibling, not a replacement.

## Typed evidence linkage (NGX-329)

M8 adds optional, additive `runId` / `stepId` linkage to the existing M5 `evidence_records` table through nullable `run_id` / `step_id` columns and the `idx_evidence_records_run_step` lookup index. The M5 evidence ingest CLI (`evidence ingest --path <file-or-dir>`), the `evidence_format_unknown` / `evidence_format_invalid` diagnostic codes, the `ingestKey` idempotency semantics, the `goal_not_found` / `source_item_not_found` pre-checks, and every existing evidence row stay wire-stable. M8 only:

- Attaches workflow artifacts to the owning `runId` when ingest runs against `.agent-workflows/<runId>/`; ledger step events also attach `stepId`, while plan / approval artifacts remain run-scoped with null `stepId`.
- Surfaces typed evidence pointers through `evidence ingest` / `evidence list` record JSON and through `workflow status` / `workflow handoff` detail evidence without requiring path-only inference for newly ingested workflow evidence; `workflow run monitor` reuses the same detail evidence, while `workflow run list` remains summary-only unless a later slice adopts detail evidence.
- Preserves idempotent replay: existing rows can gain missing `runId` / `stepId` linkage but never have non-null linkage overwritten.

The migration is additive and backwards-compatible. Existing and non-workflow evidence rows continue to carry null linkage, and legacy run evidence can still surface through artifact-path fallback where supported.

## Compatibility with existing artifacts and substrates

M8 must not break `coding-workflow-pipeline` runs in flight or any prior milestone surface. Specifically:

- `.agent-workflows/<runId>/plan.json`, `.agent-workflows/<runId>/ledger.jsonl`, `.agent-workflows/<runId>/approval-<boundary>.json`, and `.agent-workflows/<runId>/monitor.json` stay the canonical skill-owned artifacts. M8 reads them through the existing M7 `workflow import` path; it does not introduce a second importer or a parallel artifact tree.
- Step names stay stable: `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`.
- Approval boundary phrases stay stable: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`, plus the batch boundaries `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch`.
- The M5 evidence ingest CLI shape stays wire-stable; M8 only adds optional linkage columns.
- The M6 two-phase external apply contract (`intent apply --external-apply`, `intent_apply_policy`, the `intent_apply_in_progress` CAS result, the comment-only default, the idempotency marker shape) stays wire-stable. M8 never bypasses the M6 apply path; an operator-driven step transition that needs an external write still goes through `intent apply --external-apply`.

The M3 daemon (`daemon start` / `daemon stop` / `daemon status` / `recovery clear`), the `daemon_runs` / `repo_locks` schema, the M4 `RunnerAdapter` boundary (`fake` / `trusted-shell` / `acp` profiles), the runtime `MOMENTUM.md` policy loader, and the M5 `source_items` / `source_snapshots` / `source_reconciliation_runs` / `update_intents` schemas all stay wire-stable through M8.

## Old operator-control failure modes M8 eliminates

The M7 substrate made run state durable but operators still have to parse prose, scrape artifact directories, or hand-edit `ledger.jsonl` for common control flows. M8 closes those gaps:

- **Run inventory by directory scan.** Today an operator listing in-flight runs has to walk `.agent-workflows/` and re-derive run identity from directory names. M8's `workflow run list` reads the durable rows directly and supports the same filters the M7 reducer already classifies.
- **Approval reconstruction from prose.** M7 already refuses casual `"go ahead"` phrasing; M8 closes the inverse — an explicit operator approval phrase now has a first-class CLI envelope that persists the durable row with the artifact digest, so status / handoff / monitor envelopes show the approval without re-reading the JSON file.
- **Ledger hand-edits to finalize a step.** When a managed child dies after the executor finished its work but before durable terminal evidence lands, today's recovery requires hand-appending to `ledger.jsonl` or re-importing a doctored fixture. M8's `workflow run update-step` drives the same M7 reducer transition with an operator-supplied reason and evidence pointer, without touching the on-disk ledger.
- **Monitor-tick prose parsing.** The skill's monitor runner currently constructs its decision view from prose plus best-effort artifact reads. M8's `workflow run monitor` emits a stable JSON envelope with `schemaVersion`, next-action code, recovery classification, and reportability flags so `monitor_runner.py` consumes one shape.
- **Recovery state invisible to operators.** M7 classified the recovery state but the durable flag plus the per-run artifact were deferred. M8 lifts both into the substrate, mirroring the M3 goal-scoped recovery contract.
- **Path-only evidence inference.** M7 attaches evidence by best-effort artifact path prefix. M8 adds typed `runId` / `stepId` linkage so workflow evidence shows up in run / step views without depending on a brittle prefix match.

The M7 closeout regression matrix at [`internal/regression-matrix.md`](../regression-matrix.md) stays pinned through M8; the M8 closeout slice (NGX-330) extends the matrix with the new operator-control failure modes above.

## M8 non-goals (explicit)

The following are explicitly out of scope for M8 and remain deferred unless a future explicit decision gate changes the boundary. They must not creep into any M8-01..M8-07 implementation slice:

- **Live executor wrappers.** Thin Momentum-side wrappers around `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh` stay deferred to a later milestone. The deterministic M7 fake executors continue to satisfy the substrate boundary; M8 does not add live wrappers.
- **Discord delivery / approval UX rendering.** Discord-side approval button rendering, presentation reuse, and channel delivery stay inside the `coding-workflow-pipeline` skill.
- **Monitor cron scheduling.** Cron creation, dedupe, TTL acquisition, and the legacy phase-suffixed cron auto-cleanup stay inside the skill (`monitor_runner.py`, `monitor_bridge.py`).
- **Managed-step dispatch.** Detached child lifecycle (`node_managed_dispatch.py`) stays inside the skill. M8 envelopes never spawn a managed child.
- **Failure classification.** `failure_patterns.yaml` and the skill's recovery classifier stay the source of truth. M8 surfaces the classification result, never re-classifies it.
- **Dashboard or UI surface.** CLI JSON / text remains the only Momentum interface in M8.
- **Inbound webhooks.** Momentum still does not expose an HTTP listener. Tracker reconciliation stays pull / reconcile first.
- **Autonomous or background external writes.** External apply remains operator-mediated through `intent apply --external-apply` and `intent_apply_policy` from M6. M8 does not introduce a code path that performs external writes outside that contract; in particular, `workflow run update-step` is local-only and never triggers an external write as a side effect.
- **Replacing M3 daemon / recovery, M4 runner / policy, M5 source / evidence / intent, M6 external apply, or M7 substrate behavior.** Those contracts remain wire-stable through M8.
- **Per-source-item worktrees or parallel same-repo Goals.** A `WorkflowRun` continues to use one shared repo lease.
- **Strong sandboxing (container / VM / seccomp).** `trusted-shell` and `acp` remain explicitly trusted.
- **Cooperative mid-job cancellation / signal handling.** `daemon stop` and `daemon stop --now` semantics from M3 remain wire-stable; M8 does not add a new in-process cancellation signal.
- **Remote git operations driven from Momentum.** No `fetch` / `pull` / `push` / `rebase`.
- **Generalizing the `WorkflowRun` substrate beyond OpenClaw coding workflows.**

## Shipped M8 issue order

M8 shipped as a docs / contract slice (NGX-323) followed by seven implementation / closeout slices under the "Milestone 8: Workflow Run Operator Controls" project milestone. The order was sequential; each ticket left `main` valid:

1. **NGX-323 — M8-00 Contract, roadmap, and docs setup**: pinned the M8 milestone narrative, the operator-control contract, the CLI envelope names, the refusal taxonomy, the compatibility rules, and the M8 non-goals. No runtime behavior changed at M8-00; the `doctor --json` marker stayed on the M7 closeout string.
2. **NGX-324 — M8-01 workflow run list and query surface**: shipped the read-only filterable `workflow run list` CLI envelope. Reuses the M7 storage / query helpers. No mutation, no external refresh, no filesystem directory scan as the source of truth when durable rows are available.
3. **NGX-325 — M8-02 workflow run approve durable approval CLI**: shipped the explicit-approval `workflow run approve` envelope. Validates against the existing stable boundary phrase set, persists the durable `workflow_approvals` row, verifies the on-disk approval artifact digest where provided, and surfaces through `workflow status` / `workflow handoff` / `workflow run list`. No casual phrase inference, no Discord rendering.
4. **NGX-326 — M8-03 workflow run update-step transition surface**: shipped the operator-driven `workflow run update-step` envelope. Drives the M7 reducer / state machine for `succeeded` / `skipped` / `failed` / `blocked` transitions with ledger / evidence pointers and an operator-supplied reason. Illegal transitions refuse without partial durable mutation. No live executor invocation.
5. **NGX-327 — M8-04 run-scoped recovery artifact and durable flag**: persisted the `WorkflowRun.needs_manual_recovery` flag, rendered `.agent-workflows/<runId>/recovery.md` from the M7 monitor reducer's recovery view, blocked future claims / non-resolving transitions that would make recovery worse, and added the explicit `workflow run clear-recovery` path. No automatic repair, no live process killing.
6. **NGX-328 — M8-05 workflow run monitor machine envelope**: shipped the read-only `workflow run monitor` envelope emitting a stable JSON shape derived from `deriveWorkflowMonitorState`, backed by additive `workflow_runs` monitor-advisory persistence. Covers terminal / stale / drift / blocked / awaiting-approval / running / no-op cases. No cron creation, no Discord, no managed-child dispatch.
7. **NGX-329 — M8-06 typed workflow evidence linkage**: added additive, backwards-compatible `runId` / `stepId` linkage to `evidence_records`. Attached workflow artifacts to owning runs / steps when ingest runs against `.agent-workflows/<runId>/`. Surfaced typed evidence pointers through `evidence ingest` / `evidence list` record JSON and `workflow status` / `workflow handoff` detail evidence without breaking existing M5 evidence ingest shapes; `workflow run monitor` also emits detail evidence through its envelope, while `workflow run list` stays summary-only.
8. **NGX-330 — M8-07 M8 closeout smoke, docs, and doctor marker**: closed the milestone. Extended the end-to-end fake workflow smoke to cover list / approve / update-step / recovery / monitor / evidence linkage composing. Extended the regression matrix with the M8 operator-control failure modes. Flipped the `doctor --json` milestone marker to the M8 closeout string after M8-00..M8-06 merged and verified. Live executor wrappers stay deferred unless a separate approved milestone changes that call.

Each implementation slice wrote failing tests first (TDD), kept refusal codes stable, and refused to broaden the milestone scope. Any future behavior outside the surfaces above still needs an explicit decision gate.

## Closeout marker policy

The `doctor --json` milestone string stayed pinned to the M7 closeout marker `Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete` through the entirety of M8-00 (NGX-323) and every implementation slice through M8-06 (NGX-329). NGX-330 (M8-07) flipped the marker to the M8 closeout string `Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete`; `doctor --json` now reports M8 complete.

## Composition with M3 / M4 / M5 / M6 / M7

M8 composes with every prior milestone contract without renaming or reshaping a surface:

- **M3 daemon / recovery.** `daemon start` / `daemon stop` / `daemon status` / `recovery clear`, the `daemon_runs` / `repo_locks` schema, stale-lease detection, the manual-recovery `recovery.md` artifact + flag, and the M3 ownership of background work all stay wire-stable. The M8 run-scoped recovery surfaces are siblings of the goal-scoped M3 surfaces, not replacements.
- **M4 runners and policy.** `RunnerAdapter`, the `fake` / `trusted-shell` / `acp` profiles, and the `MOMENTUM.md` runtime policy loader stay wire-stable. M8 does not introduce a new runner kind. A coding workflow's `implementation` step continues to dispatch into a `trusted-shell` or `acp` runner through the skill, not through Momentum.
- **M5 source / evidence / intent.** `source_items` / `source_snapshots` / `source_reconciliation_runs` / `evidence_records` / `update_intents` stay wire-stable. M8 only adds optional `runId` / `stepId` evidence linkage; the existing ingest CLI shape and idempotency semantics do not change.
- **M6 external apply.** `intent apply --external-apply`, the two-phase claim → audit → write → finalize lifecycle, the `intent_apply_policy` precedence, the comment-only default, the idempotency marker shape, the `intent_apply_in_progress` CAS result, and the `blocked` non-replay state stay wire-stable. M8 never bypasses the M6 apply path.
- **M7 substrate.** `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases`, `deriveWorkflowRunState`, `deriveWorkflowMonitorState`, `classifyWorkflowLease`, the `WorkflowStepExecutor` boundary, the deterministic fake executors, and the read-only `workflow import` / `workflow status` / `workflow handoff` CLI envelopes all stay wire-stable. M8 reuses them and adds only nullable `workflow_runs` monitor-advisory columns for import / operator-control snapshots; it does not rename or replace the substrate.
