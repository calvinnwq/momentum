# Momentum Roadmap

Momentum is built milestone by milestone. Each milestone has a single durable shape that lands in code, in docs, and in the `doctor` readiness marker before the next one starts. The roadmap below is the canonical timeline; deeper detail lives in each milestone doc under `internal/milestones/` and each cross-milestone contract under `internal/contracts/`.

## Timeline

| Milestone | Theme | Status | Detail |
|---|---|---|---|
| Milestone 1 | Foreground Proof Loop | Complete | See [README](../README.md) and milestone bullets in [AGENTS.md](../AGENTS.md) |
| Milestone 2 | Queue and Worker Model | Complete | See [README](../README.md) and milestone bullets in [AGENTS.md](../AGENTS.md) |
| Milestone 3 | Operational Safety | Complete | [m3-operational-safety.md](milestones/m3-operational-safety.md) |
| Milestone 4 | Real Runner Profiles | Complete | [m4-real-runners.md](milestones/m4-real-runners.md) |
| Milestone 5 | Source Adapters and Evidence Sync | Complete | [m5-source-adapters.md](milestones/m5-source-adapters.md) |
| Milestone 6 | Policy-Gated External Apply | Complete | [m6-external-apply.md](milestones/m6-external-apply.md) |
| Milestone 7 | OpenClaw Coding Workflow Backend | Complete | [m7-openclaw-coding-workflow-backend.md](milestones/m7-openclaw-coding-workflow-backend.md) |
| Milestone 8 | Workflow Run Operator Controls | Complete | [m8-workflow-run-operator-controls.md](milestones/m8-workflow-run-operator-controls.md) |
| Milestone 9 | Live Workflow Execution | Foundation in force | [m9-live-workflow-execution.md](milestones/m9-live-workflow-execution.md) |
| Milestone 10 | Workflow-First Runtime | Implementation started | [m10-workflow-first-runtime.md](milestones/m10-workflow-first-runtime.md) |

Accepted planning for the next runtime direction lives in
[internal/contracts/workflow-first-runtime.md](contracts/workflow-first-runtime.md).
It records the workflow-first runtime pivot: `WorkflowDefinition` is the
top-level product recipe, `WorkflowRun` is one execution, `StepDefinition` /
`StepRun` own per-step configuration and state, and executors such as
`goal-loop`, `one-shot`, `no-mistakes`, `script`, `external-apply`, and
`subworkflow` perform the work inside steps. This contract keeps M9 as
foundation work and does not flip the doctor marker by itself.
The executor-loop layer for that pivot is pinned in
[internal/contracts/executor-loop.md](contracts/executor-loop.md), covering
executor states, round schema, artifacts, reattach / heartbeat rules,
completion classification, human gates, and agent / model selection precedence.
The current-to-target planning bridge is pinned in
[internal/contracts/workflow-first-gap-matrix.md](contracts/workflow-first-gap-matrix.md),
including what survives from M7/M8/M9, what changes, and the M10 slice order.
M10 implementation has begun: M10-00 promoted those planning contracts into the
milestone narrative, and M10-01 lands workflow / step definition schema,
validation, and persistence primitives. The M10 milestone narrative is
[internal/milestones/m10-workflow-first-runtime.md](milestones/m10-workflow-first-runtime.md).

The `doctor` readiness marker tracks the **most recently closed** milestone. It currently reads `Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete`. The marker advanced from the M6 closeout string to `Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete` at the M7 closeout slice (NGX-319), stayed pinned to the M7 string through every M8 implementation slice, and advanced to the M8 string at the M8 closeout slice (NGX-330).

## Most recently closed milestone: M8

Milestone 8 layers operator-control CLI envelopes (`workflow run list`, `workflow run approve`, `workflow run update-step`, `workflow run clear-recovery`, `workflow run monitor`) plus the per-run `recovery.md` / `needs_manual_recovery` artifact, additive `workflow_runs` monitor-advisory columns, and typed `runId` / `stepId` evidence linkage on top of the M7 OpenClaw coding-workflow backend substrate. The M7 substrate stays wire-stable; M8 does not rename the M7 `workflow import` / `workflow status` / `workflow handoff` envelopes, and does not move executor invocation, Discord delivery, or monitor cron scheduling out of the `coding-workflow-pipeline` skill.

The M8 milestone narrative and the issue order live in [internal/milestones/m8-workflow-run-operator-controls.md](milestones/m8-workflow-run-operator-controls.md); the cross-milestone operator-control invariants live in [internal/contracts/workflow-operator-controls.md](contracts/workflow-operator-controls.md). The underlying substrate contract stays [internal/contracts/workflow-runs.md](contracts/workflow-runs.md), wire-stable through M8.

### Shipped M8 implementation order

The Linear milestone "Milestone 8: Workflow Run Operator Controls" shipped the work in the following order (all closed). Each ticket left `main` valid:

1. **NGX-323 — M8-00 Contract, roadmap, and docs setup**: pinned the M8 milestone narrative, the operator-control contract, the CLI envelope names, the refusal taxonomy, the compatibility rules, and the M8 non-goals. No runtime behavior changed; the doctor marker stayed on the M7 closeout string.
2. **NGX-324 — M8-01 workflow run list and query surface**: shipped the read-only filterable `workflow run list` envelope. Reuses the M7 storage / query helpers; no mutation, no external refresh, no filesystem directory scan as the source of truth when durable rows are available.
3. **NGX-325 — M8-02 workflow run approve durable approval CLI**: shipped the explicit-approval `workflow run approve` envelope. Validates against the stable boundary phrase set, persists the durable `workflow_approvals` row, verifies the on-disk approval artifact digest where provided, and surfaces through `workflow status` / `workflow handoff` / `workflow run list`.
4. **NGX-326 — M8-03 workflow run update-step transition surface**: shipped the operator-driven `workflow run update-step` envelope. Drives the M7 reducer / state machine for `succeeded` / `skipped` / `failed` / `blocked` transitions with ledger / evidence pointers and an operator-supplied reason. Illegal transitions refuse without partial durable mutation.
5. **NGX-327 — M8-04 run-scoped recovery artifact and durable flag**: persisted `WorkflowRun.needs_manual_recovery`, rendered `.agent-workflows/<runId>/recovery.md` from the M7 monitor reducer's recovery view, blocked claims / non-resolving transitions that would make recovery worse, and added the explicit `workflow run clear-recovery` path.
6. **NGX-328 — M8-05 workflow run monitor machine envelope**: shipped the read-only `workflow run monitor` envelope emitting a stable JSON shape (`schemaVersion`, run identity, current state, next-action code, recovery classification, evidence pointers, reportability / terminal flags).
7. **NGX-329 — M8-06 typed workflow evidence linkage**: added additive, backwards-compatible `runId` / `stepId` linkage on `evidence_records`. Existing M5 evidence ingest semantics stay wire-stable.
8. **NGX-330 — M8-07 M8 closeout smoke, docs, and doctor marker**: closed the milestone. Extended the fake workflow smoke to cover list / approve / update-step / recovery / monitor / evidence linkage composing. Extended the regression matrix with M8 operator-control failure modes. Flipped the `doctor --json` milestone marker forward to the M8 closeout string after M8-00..M8-06 merged and verified.

Live executor wrappers (around `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, `project-progress-refresh`) stayed deferred past M8 closeout until the M9-00 decision gate (NGX-331) promoted Milestone 9, which now owns them; M9 wraps those engines without rewriting them.

## M9 foundation work

Milestone 9 remains valid foundation work after the M9-00 decision gate (NGX-331). Its milestone narrative lives in [internal/milestones/m9-live-workflow-execution.md](milestones/m9-live-workflow-execution.md); its contract lives in [internal/contracts/live-workflow-execution.md](contracts/live-workflow-execution.md).

M9 owns the first Momentum-side live executor wrappers around the existing OpenClaw engines, the live step lease / heartbeat / result-file contract, verification and commit transaction wiring, recovery behavior for live failures, and a real dogfood run. M9 wraps the existing engines; it does not rewrite GNHF, postflight, no-mistakes, model-evidence, or project-refresh internals.

The accepted workflow-first runtime pivot does not invalidate this work. It
reframes M9 as foundation: the live wrappers, leases, finalization, and
recovery primitives become building blocks for a future configurable workflow
runtime. The future top-level start surface is expected to be workflow-first;
`goal start` remains the current compatibility path until a workflow-first
start slice lands.

### Pinned M9 implementation sequence

The M9-00 decision gate (NGX-331) pins the slice order; each slice is a concrete Linear issue that must leave `main` valid:

1. **NGX-331 — M9-00 Contract and decision gate** — promote the draft; pin the architecture, non-goals, and this sequence; update this roadmap and the doctor-marker policy. No runtime change.
2. **NGX-332 — M9-01 Live wrapper config and registry.**
3. **NGX-333 — M9-02 Live implementation step wrapper.**
4. **NGX-334 — M9-03 Verification and commit transaction.**
5. **NGX-335 — M9-04 Postflight and no-mistakes wrappers.**
6. **NGX-336 — M9-05 Merge cleanup and Linear refresh boundaries.**
7. **NGX-337 — M9-06 Live recovery and resume smoke.**
8. **NGX-338 — M9-07 Dogfood run and closeout** — flips the `doctor --json` marker to the M9 closeout string only after the dogfood gate and regression updates pass.

The `doctor --json` marker stayed pinned to the M8 closeout string above
through M9 foundation work; M9 did not flip it.

## M10 implementation progress

Milestone 10 is the workflow-first runtime implementation milestone. Its
narrative lives in
[internal/milestones/m10-workflow-first-runtime.md](milestones/m10-workflow-first-runtime.md).
M10 promotes the workflow-first runtime planning contracts into an executable
milestone while keeping M9 as foundation work.

M10's target product shape is:

```text
WorkflowDefinition -> StepDefinition[]
WorkflowRun -> StepRun[]
StepRun -> ExecutorInvocation -> ExecutorRound[]
```

M10 makes workflow definitions and workflow runs the product root; `goal-loop`
becomes an executor family inside a workflow step.

### M10 implementation sequence

1. **NGX-344 — M10-00 Workflow-first contract and milestone setup.** *(done)*
2. **NGX-345 — M10-01 WorkflowDefinition and StepDefinition schema.** *(landed in this slice)*
3. **NGX-346 — M10-02 Workflow run start.**
4. **NGX-347 — M10-03 ExecutorDefinition / Invocation / Round schema.**
5. **NGX-348 — M10-04 Daemon workflow scheduler lane.**
6. **NGX-349 — M10-05 Goal-loop executor adapter.**
7. **NGX-350 — M10-06 One-shot and script executor adapters.**
8. **NGX-351 — M10-07 no-mistakes executor mirror.**
9. **NGX-352 — M10-08 Workflow gates and decisions CLI.**
10. **NGX-353 — M10-09 Workflow-first dogfood and closeout.**

The `doctor --json` marker stays pinned to the M8 closeout string until a real
milestone closeout slice flips it. M10 implementation slices before closeout do
not flip it.

## Previously closed milestone: M7

Milestone 7 shipped the **durable run substrate for OpenClaw coding workflows**. The `coding-workflow-pipeline` skill keeps composing the executors (preflight → GNHF → postflight → no-mistakes → merge cleanup → Linear refresh) and the Discord / monitor cron UX; M7 owns the durable `WorkflowRun` record, step-state lifecycle, approval persistence, lease coordination, and path-based evidence pointer substrate that those engines previously kept in ad-hoc artifacts plus in-memory shell sessions. M8 adds the typed `runId` / `stepId` evidence linkage on top of that substrate.

M7 is **not** a replacement for `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh`. The ownership boundary, the old monitor failure modes M7 eliminates, compatibility with `plan.json` / `ledger.jsonl` / `approval-*.json` / `monitor.json`, and M7 non-goals live in [internal/milestones/m7-openclaw-coding-workflow-backend.md](milestones/m7-openclaw-coding-workflow-backend.md); the cross-milestone invariants live in [internal/contracts/workflow-runs.md](contracts/workflow-runs.md); the closeout regression matrix lives in [internal/regression-matrix.md](regression-matrix.md).

### Shipped M7 implementation order

The Linear milestone "Milestone 7: OpenClaw Coding Workflow Backend" shipped the work in the following order (all closed):

1. **NGX-312 — M7-00 Contract, roadmap, and docs setup**: pinned the M7 contract, ownership boundary, old monitor failure modes, compatibility list, and non-goals.
2. **NGX-313 — M7-01 WorkflowRun substrate schema and state model**: shipped the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration, the `WorkflowRun` identity columns, the pure run / step state vocabulary plus transition reducer, the lease-aware `deriveWorkflowRunState`, and the `classifyWorkflowLease` freshness classifier.
3. **NGX-314 — M7-02 Import current agent-workflow plans**: shipped the `.agent-workflows/<runId>/` normalizer, the SQLite persistence layer for the M7 substrate tables, the `workflow import` CLI envelope, and built-CLI smoke coverage for import edge cases.
4. **NGX-315 — M7-03 Step execution adapter boundary**: shipped the pure `WorkflowStepExecutor` boundary, the typed input / result / checkpoint / artifact / error shapes, the registry / resolver keyed by `WorkflowStepKind`, deterministic fake executors per kind, and focused unit tests pumping a full required-step chain through the state machine.
5. **NGX-316 — M7-04 Momentum-owned monitor and recovery state**: shipped the pure `deriveWorkflowMonitorState` reducer, the per-lease freshness view, monitor-advisory drift classification, deterministic `nextAction` codes, and the recovery taxonomy (`stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`).
6. **NGX-317 — M7-05 Workflow status and handoff CLI surfaces**: shipped the read-only `workflow status` and `workflow handoff` CLI envelopes with stable JSON field names, refusal taxonomy, and text rendering composed on top of the monitor reducer.
7. **NGX-318 — M7-06 End-to-end coding workflow smoke**: shipped the end-to-end built-CLI smoke driving a fresh `.agent-workflows/<runId>/` fixture through the deterministic fake executors, covering happy-path completion, evidence linkage through `workflow handoff`, and a failure path that proves no ghost active / blocked run remains.
8. **NGX-319 — M7-07 Docs, regression matrix, and milestone closeout**: closed the milestone, added [internal/regression-matrix.md](regression-matrix.md), aligned the contract tests, and flipped the `doctor --json` milestone marker to the M7 closeout string.

## Previously closed milestone: M6

Milestone 6 shipped **policy-gated external apply**: a single concrete adapter (Linear) gained a two-phase external write path behind operator-mediated configuration. M5 already recorded durable update intents; M6 lets an operator turn an intent into a real external write while preserving every M3/M4/M5 safety contract.

The full M6 contract — runtime invariants, the two-phase apply flow, audit ordering, and the comment-only default — lives in [internal/contracts/intent-apply.md](contracts/intent-apply.md). The milestone-level scope, shipped sequencing, and post-M6 deferrals live in [internal/milestones/m6-external-apply.md](milestones/m6-external-apply.md).

### Shipped M6 implementation order

The Linear milestone "Milestone 6: Policy-Gated External Apply" shipped the work in the following order (all closed):

1. **NGX-295 — M6-00 M6 contract, roadmap, and docs setup**: reshaped the public docs surface so README is the OSS front door, AGENTS is a compact agent contract, and the M6 invariants live in `internal/`.
2. **NGX-296 — M6-01 ExternalUpdateAdapter boundary and result taxonomy**: added the write-side adapter boundary, registry, input/result types, deterministic dry-run preview shape, idempotency marker helper, and stable adapter/write error taxonomy. No real Linear mutations or CLI external apply integration in this slice.
3. **NGX-297 — M6-02 Linear external update client**: introduced the credential-handling Linear GraphQL mutation client behind the adapter boundary. Tests used mock fetch/endpoints; no real `api.linear.app` calls in tests.
4. **NGX-299 — M6-03 Apply audit ledger and operator surfaces**: landed durable audit/claim storage, the per-intent CAS guard with `intent_apply_in_progress`, blocked/audit-incomplete state representation, and operator-visible surfaces **before** any CLI external write could mutate Linear.
5. **NGX-298 — M6-04 External apply execution**: wired the two-phase external write behind `intent apply --external-apply` gated by `intent_apply_policy: external_apply_allowed`. Comment-only by default; status mutation only when explicitly configured.
6. **NGX-300 — M6-05 Post-apply reconciliation and mismatch resolution**: refreshed/reconciled the touched Linear issue after a successful external write and surfaced stable reconciliation warning/result codes without broad project reconciliation.
7. **NGX-301 — M6-06 External apply safety smoke and failure matrix**: added built-CLI smoke coverage for the complete safe external-apply path, including policy-denied/default-safe behavior, auth failure, concurrency, idempotent replay, blocked/audit-finalize failure, comment-only mode, and mock-Linear guards.
8. **NGX-302 — M6-07 M6 docs, contract tests, and milestone closeout**: closed the milestone, preserved older contracts, and flipped the `doctor` milestone marker to M6 complete.

NGX-299 landed before NGX-298 — audit surfaces shipped first so operators could see what an external apply would write before any real write could happen.

## Post-M8 deferred work

The following remain explicitly deferred until a later milestone justifies them. Live execution itself is no longer deferred: Milestone 9 foundation work owns the Momentum-side live executor wrappers, the live step lease / heartbeat / result-file contract, verification / commit transaction wiring, and the dogfood run. M7 shipped the OpenClaw coding workflow backend substrate and M8 shipped the operator-control surfaces; the items below stay out of scope:

- Inbound webhooks; source adapters stay pull / reconcile first.
- Dashboards or any UI surface; the CLI remains the only interface. Discord delivery for approvals stays inside the `coding-workflow-pipeline` skill, not Momentum.
- Autonomous or background external writes; M6 external apply stays operator-mediated and M8 does not introduce a new external-write path.
- Non-Linear external write adapters (GitHub / Jira / etc.).
- Per-source-item worktrees / parallel same-repo Goals; a `WorkflowRun` continues to use one shared repo lease.
- Background runner supervision (forking, daemonization, restart-on-crash).
- Strong sandboxing (container / VM / seccomp) for runner adapters; `trusted-shell` and `acp` remain explicitly trusted.
- Cooperative mid-job cancellation / signal handling beyond the existing `daemon stop` / `daemon stop --now` semantics.
- Remote git operations (`fetch` / `pull` / `push` / `rebase`) driven from Momentum.
- Replacing the GNHF / postflight / no-mistakes / merge-cleanup engines themselves; M7 is the substrate, M8 is the operator-control surface, and M9 wraps the executors — none of them reimplement the engines.
- Generalizing the `WorkflowRun` substrate beyond OpenClaw coding workflows remains deferred until M10 implementation slices land. The accepted planning contracts for that pivot are [internal/contracts/workflow-first-runtime.md](contracts/workflow-first-runtime.md), [internal/contracts/executor-loop.md](contracts/executor-loop.md), and [internal/contracts/workflow-first-gap-matrix.md](contracts/workflow-first-gap-matrix.md).
