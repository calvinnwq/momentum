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

The `doctor` readiness marker tracks the **most recently closed** milestone. It currently reads `Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete`. The marker advanced from the M6 closeout string at the M7 closeout slice (NGX-319).

## Most recently closed milestone: M7

Milestone 7 shipped the **durable run substrate for OpenClaw coding workflows**. The `coding-workflow-pipeline` skill keeps composing the executors (preflight → GNHF → postflight → no-mistakes → merge cleanup → Linear refresh) and the Discord / monitor cron UX; M7 owns the durable `WorkflowRun` record, step-state lifecycle, approval persistence, lease coordination, and evidence pointer schema that those engines previously kept in ad-hoc artifacts plus in-memory shell sessions.

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

## Post-M7 deferred work

The following remain explicitly deferred after M7 closeout and until a later milestone justifies them. M7 shipped the OpenClaw coding workflow backend substrate; it does not change any of the deferrals below:

- Inbound webhooks; source adapters stay pull / reconcile first.
- Dashboards or any UI surface; the CLI remains the only interface. Discord delivery for approvals stays inside the `coding-workflow-pipeline` skill, not Momentum.
- Autonomous or background external writes; M6 external apply stays operator-mediated and M7 does not introduce a new external-write path.
- Non-Linear external write adapters (GitHub / Jira / etc.).
- Per-source-item worktrees / parallel same-repo Goals; a `WorkflowRun` continues to use one shared repo lease.
- Background runner supervision (forking, daemonization, restart-on-crash).
- Strong sandboxing (container / VM / seccomp) for runner adapters; `trusted-shell` and `acp` remain explicitly trusted.
- Cooperative mid-job cancellation / signal handling beyond the existing `daemon stop` / `daemon stop --now` semantics.
- Remote git operations (`fetch` / `pull` / `push` / `rebase`) driven from Momentum.
- Replacing the GNHF / postflight / no-mistakes / merge-cleanup engines themselves; M7 is the substrate, not the executor.
- Generalizing the `WorkflowRun` substrate beyond OpenClaw coding workflows.
