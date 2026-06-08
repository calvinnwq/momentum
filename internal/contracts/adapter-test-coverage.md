# Adapter Test Coverage Matrix

**Status:** Active audit. NGX-368 established the matrix and NGX-369 closed the
isolated source-adapter hardening slice. This matrix separates adapter families
from the full end-to-end workflow proof so Momentum can harden adapter
contracts in layers: isolated contract tests first, stubbed integration second,
opt-in real smoke third, and full E2E only after the lower layers are green.

The term **adapter** is intentionally broad here:

- **Source adapters** read / list / get / normalize external system state into
  local Momentum records. The active contract is
  [source-adapters.md](source-adapters.md).
- **Write-side external update adapters** apply already-approved update intents
  through the policy-gated M6 external apply path. The active contract is
  [intent-apply.md](intent-apply.md).
- **Runner adapters** execute legacy Goal iterations behind the M4
  `RunnerAdapter` boundary.
- **Workflow step / executor adapters** drive or mirror work below a
  workflow-first `StepRun`: dispatch, goal-loop, one-shot, script,
  no-mistakes, and the M9 live wrapper surfaces.

## Test layers

- **Isolated contract** means unit-level tests around registry, input parsing,
  dispatch result taxonomy, state transitions, recovery codes, result capture,
  and no-network/no-git invariants.
- **Stubbed integration** means the adapter is wired through real Momentum
  persistence and CLI/runtime code, but every external system is fake, injected,
  or local-only.
- **Opt-in real smoke** means a manual or flagged command may call a real
  runner, tracker, or harness. These checks must stay out of default CI and
  must be explicit about credentials, policy gates, and external writes.
- **Full E2E** means a workflow-level proof that composes multiple adapter
  layers through the intended operator flow. It should never be the first test
  that discovers an adapter contract bug.

## Matrix

| Adapter family | Current isolated contract coverage | Current stubbed integration coverage | Opt-in real smoke | Full E2E status | Gap / next issue |
| --- | --- | --- | --- | --- | --- |
| Source adapter registry and local fixture | `test/source-adapter.test.ts` covers registry, list/get/normalize, unsupported kinds, malformed items, and thrown adapters. | `test/source-reconciliation.test.ts`, `test/source-items.test.ts`, and `test/source-reconciliation-runs.test.ts` cover local persistence paths. | Not needed for local fixture. | Covered indirectly by M5/M6 source and intent smokes; NGX-368 added the adapter-only matrix assertion. | Baseline remains covered after NGX-369. |
| Linear source adapter | `test/linear-source-adapter.test.ts` covers normalization, filter scoping, injected-client list/get, pagination, and malformed response handling. `test/linear-http-client.test.ts` (hardened by NGX-369) covers no-real-`api.linear.app` guards, full auth/transport/shape/pagination failure taxonomy, credential trimming, filter mapping, page-size validation, and a read-only query-not-mutation proof across 41 focused tests. `test/linear-source-adapter-normalization.test.ts` (NGX-369) covers every partial-data and rejection edge of `normalizeLinearIssue`: required-field rejection per field, non-object payloads, `updatedAt` parsing paths, state/status mapping, project/milestone/label/assignee tri-state and null-collapse, falsy-`0` priority retention, and raw-payload fidelity. `test/source-reconciliation-read-only.test.ts` (NGX-369) proves the negative invariant: a full reconciliation run writes only to `source_*` tables, leaves preexisting Goal/Workflow/executor/external-write rows unchanged, initializes no git repo, writes no artifact files, and exposes only a read-shaped page request to the external client. | Reconciliation/persistence tests plus `test/project-rollup.test.ts` cover durable local read-side summaries and stale reconciliation warnings. | No default real Linear read smoke should run in CI. A future manual smoke can use operator-provided credentials and read-only filters only. | Pending final adapter E2E proof. | NGX-369 complete. Remaining: NGX-372 owns opt-in real-smoke and final E2E proof. |
| External update adapter / Linear write client | `test/external-update-adapter.test.ts`, `test/intent-apply-execute.test.ts`, and `test/intent-apply-audits.test.ts` cover preview, policy denial, idempotency marker shape, audit-before-write, CAS, comment-only default, partial failure, and mocked Linear write behavior. | `test/smoke.test.ts` covers M6 `intent apply --external-apply` with mock endpoints and no real Linear host. | Real external writes remain opt-in only and must require `intent_apply_policy: external_apply_allowed`, explicit operator reason, and comment/status mutation policy. | Pending final source-read-through-apply E2E after isolated and stubbed adapter gaps are closed. | NGX-372 owns real-smoke / full-E2E proof. |
| RunnerAdapter: fake / trusted-shell / acp | `test/runner-adapter.test.ts` covers registry, execution flags, fake dispatch, trusted-shell config failure/success, thrown adapters, invalid inputs, diagnostics, and stable adapter shape. | Legacy foreground/goal smoke coverage uses the runner boundary with local fake/trusted-shell execution. | ACP and real shell profiles must stay manual/flagged when they depend on external runtimes or local auth. | Covered historically through Goal execution, not yet through workflow-first adapter E2E. | NGX-370 should pin any missing runner-adapter invariants needed by workflow executor tests. |
| WorkflowStepExecutor fake boundary | `test/workflow-step-executor.test.ts` covers the M7 step executor registry, fake executor behavior, result states, retry/recovery hints, and thrown/runtime-unavailable paths. | `test/smoke.test.ts` covers workflow import/status/handoff paths driven by deterministic fake executor output. | Not required for fake executor. | Existing M7/M8 smokes prove substrate behavior, but not the post-M10 adapter stack as a single E2E. | NGX-371 should reuse this as the stubbed workflow adapter baseline. |
| Workflow scheduler and production dispatch | `test/workflow-scheduler.test.ts`, `test/workflow-dispatch.test.ts`, and `test/workflow-dispatch-execute.test.ts` cover runnable selection, leases, supported-family dispatch, executor invocation/round scaffold creation, unsupported-family fail-closed behavior, and run/monitor state refresh. | `test/cli-daemon-workflow-dispatch.test.ts` and NGX-353 dogfood evidence cover `workflow run start` -> approval -> bounded `daemon start` -> executor rows. | Real daemon dogfood is opt-in/operator-driven; default tests use temp data dirs and fake/local dispatch paths. | M10 closeout proved phase-1 dispatch scaffold, not full adapter E2E completion. | NGX-371 should compose source + workflow dispatch with fake dependencies. |
| Goal-loop executor adapter | `test/goal-loop-executor.test.ts`, `test/goal-loop-executor-persistence.test.ts`, `test/goal-loop-mechanism.test.ts`, and `test/goal-loop-orchestrator.test.ts` cover family recognition, round planning, persistence, finalization, recovery taxonomy, and orchestration decisions. `test/goal-loop-orchestrator.test.ts` also proves single-owner enforcement (NGX-370): a duplicate same-`attempt` `runGoalLoopStep` dispatch fails closed with `ExecutorInvocationConflictError` and leaves the prior invocation byte-for-byte untouched, while a fresh `attempt` mints an independent invocation. | Workflow dispatch tests prove the scheduler can scaffold goal-loop-family rows where supported. | Real autonomous goal-loop work remains operator-approved and bounded. | Pending workflow-first full E2E beyond scaffold. | NGX-370 should check any missing adapter-contract edges before E2E. |
| One-shot and script executor adapters | `test/single-shot-executor.test.ts` and `test/single-shot-executor-persistence.test.ts` cover one-shot/script family recognition, selection, result-bearing one-shot success, script exit-code/bounded-log success, artifacts, checkpoints, and recovery classifications. `test/single-shot-orchestrator.test.ts` drives the one-shot/script step through the real persistence layer and proves single-owner enforcement (NGX-370): a duplicate same-`attempt` `runSingleShotStep` dispatch fails closed with `ExecutorInvocationConflictError`, while a fresh `attempt` mints an independent invocation. | Workflow dispatch tests prove supported single-shot family scaffolding. | Real command execution must remain bounded and policy-controlled. | Pending workflow-first full E2E beyond scaffold. | NGX-370 owns isolated hardening; NGX-371 owns stubbed composition. |
| No-mistakes executor mirror | `test/no-mistakes-executor.test.ts`, `test/no-mistakes-executor-persistence.test.ts`, `test/no-mistakes-mechanism.test.ts`, and `test/no-mistakes-orchestrator.test.ts` cover external-state mirroring, waiting-operator gates, findings, decisions, CI state, unreadable/inconsistent external state, and persistence. NGX-370 added single-owner enforcement: a duplicate same-`attempt` `runNoMistakesMirrorStep` dispatch fails closed with `ExecutorInvocationConflictError` (the start savepoint rolls back) and leaves the prior invocation untouched. | No-mistakes mirror is covered with fake external snapshots, not a live no-mistakes process in CI. | Real no-mistakes review/fix remains opt-in and operator-gated. | Pending final adapter E2E proof. | NGX-370 should keep mirror coverage isolated; NGX-372 owns real-smoke instructions. |
| M9 live coding workflow wrappers: GNHF, postflight, no-mistakes, merge cleanup | `test/live-step-executor.test.ts` covers live wrapper dispatch/finalization boundaries, result-file capture, terminal-state mapping, recovery codes, and lease behavior. | Coding-workflow pipeline smokes and prior PR evidence prove the wrappers under fake or controlled live lanes, but default Momentum tests should not spawn expensive external agents. | Real GNHF/postflight/no-mistakes/merge cleanup remains coding-workflow-pipeline controlled and explicitly approved by run id/boundary. | Historical workflow PRs prove the lane, but NGX-372 should document the current opt-in proof path after isolated/stubbed gaps close. | NGX-371 / NGX-372 split stubbed wrapper composition from real harness proof. |
| Unsupported executor families: external-apply and subworkflow | `test/workflow-dispatch-execute.test.ts` covers fail-closed behavior for families without daemon-dispatchable adapters. | Stubbed dispatch verifies no executor rows are created and manual recovery is surfaced. | No real smoke until adapters land. | Out of scope for current full E2E. | Keep fail-closed until a future implementation slice lands. |

## Follow-on issue split

- **NGX-369 — Isolated source adapter contract tests.** Complete. Owns source
  adapter and Linear read-side hardening, especially no-network guards,
  pagination, response shape failures, read-only invariants, and durable
  reconciliation summaries.
- **NGX-370 — Isolated coding workflow adapter contract tests.** Owns runner,
  workflow-step, scheduler/dispatch, goal-loop, one-shot/script, no-mistakes,
  and live-wrapper contract hardening without real external systems.
- **NGX-371 — Stubbed adapter integration smoke.** Owns a fake/local
  composition proof through Momentum persistence that exercises source adapter
  reads plus workflow/executor dispatch evidence without real external hosts.
- **NGX-372 — Opt-in real adapter smoke and full E2E proof.** Owns the manual
  or flagged real-smoke path and the final E2E proof after NGX-369..NGX-371 are
  green.

## Guardrails

- Default CI must not call real `api.linear.app`, real ACP, real GNHF,
  real no-mistakes, or any external write path.
- Real external writes require the M6 policy gate, an operator reason, and the
  audit-before-write lifecycle.
- Source adapters remain read-only even when the broader E2E path later applies
  an update intent through the separate write-side adapter.
- Unsupported executor families must fail closed with operator-visible recovery
  until a dedicated adapter implementation lands.
