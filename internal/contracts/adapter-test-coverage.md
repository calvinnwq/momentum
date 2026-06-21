# Adapter Test Coverage Matrix

**Status:** Active audit. NGX-368 established the matrix and NGX-369 closed the
isolated source-adapter hardening slice. This matrix separates adapter families
from the full end-to-end workflow proof so Momentum can harden adapter
contracts in layers: isolated contract tests first, stubbed integration second,
opt-in real smoke third, and full E2E only after the lower layers are green.
NGX-372 added the third and fourth layers: the opt-in real Linear read smoke and
the CI-safe full adapter E2E proof (`test/full-adapter-e2e.test.ts`) that
composes source read → reconciliation → production dispatch scaffold → one-shot,
goal-loop, no-mistakes-mirror, and M9 live-wrapper managed-step terminal
finalizations with a passing verification gate (or its mirror equivalent: a
corroborated completed external review gate, or — for the M9 live wrapper — a
clean managed-step `succeeded` settle under a `managed-step` lease) →
external-write policy gate held closed. NGX-372 also added the CI-safe decision core for the opt-in
real coding-workflow harness smoke (`src/core/executors/real-workflow-smoke.ts`), the
explicitly-flagged gate for invoking a real preflight / implementation (GNHF) /
postflight / no-mistakes / merge-cleanup / linear-refresh wrapper with the
external-write family held closed by default, and the gated probe-execution
layer (`src/adapters/real-workflow-probe.ts`,
`test/real-workflow-probe-smoke.test.ts`) that actually runs the resolved
wrapper pre-flight probe when an operator opts in.

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
| Linear source adapter | `test/linear-source-adapter.test.ts` covers normalization, filter scoping, injected-client list/get, pagination, and malformed response handling. `test/linear-http-client.test.ts` (hardened by NGX-369) covers no-real-`api.linear.app` guards, full auth/transport/shape/pagination failure taxonomy, credential trimming, filter mapping, page-size validation, and a read-only query-not-mutation proof across 41 focused tests. `test/linear-source-adapter-normalization.test.ts` (NGX-369) covers every partial-data and rejection edge of `normalizeLinearIssue`: required-field rejection per field, non-object payloads, `updatedAt` parsing paths, state/status mapping, project/milestone/label/assignee tri-state and null-collapse, falsy-`0` priority retention, and raw-payload fidelity. `test/source-reconciliation-read-only.test.ts` (NGX-369) proves the negative invariant: a full reconciliation run writes only to `source_*` tables, leaves preexisting Goal/Workflow/executor/external-write rows unchanged, initializes no git repo, writes no artifact files, and exposes only a read-shaped page request to the external client. | Reconciliation/persistence tests plus `test/project-rollup.test.ts` cover durable local read-side summaries and stale reconciliation warnings. `test/stubbed-adapter-integration-smoke.test.ts` (NGX-371) composes a fake Linear read with workflow dispatch evidence in one local persistence smoke. | `test/real-linear-read-smoke.test.ts` (NGX-372) is the opt-in real Linear read smoke: skipped unless `MOMENTUM_REAL_SMOKE_LINEAR=1` and `LINEAR_API_KEY` are both set, so default CI never reaches `api.linear.app`. When opted in it drives a bounded, read-only `issues` reconcile (default one page) through `buildLinearHttpReconciliationClient` into a disposable temp data dir, supports a no-persist `MOMENTUM_REAL_SMOKE_DRY_RUN` mode, asserts the read leaves the repo clean, classifies the result against the documented failure-mode taxonomy via `classifyRealSmokeReadOutcome` (`auth_failure` / `rate_limited` / `network_failure` / `tool_unavailable` / `config_invalid` / `adapter_error`), and records evidence under gitignored `.agent-runs/real-smoke/`. The CI-safe gating decision (`planLinearReadSmoke`) and the failure taxonomy are unit-pinned in `test/real-smoke.test.ts`. | `test/full-adapter-e2e.test.ts` (NGX-372) composes the real Linear read (fake client) → local reconciliation → workflow run start → production dispatch scaffold → terminal one-shot, goal-loop, no-mistakes-mirror, and M9 live-wrapper finalizations, recording composition evidence. | NGX-369 and NGX-371 complete. NGX-372 delivered the opt-in real Linear read smoke, the CI-safe full adapter E2E proof, and the opt-in real coding-workflow harness gate plus probe-execution smoke. |
| External update adapter / Linear write client | `test/external-update-adapter.test.ts`, `test/intent-apply-execute.test.ts`, and `test/intent-apply-audits.test.ts` cover preview, policy denial, idempotency marker shape, audit-before-write, CAS, comment-only default, partial failure, and mocked Linear write behavior. | `test/m6-smoke.test.ts` covers M6 `intent apply --external-apply` with mock endpoints and no real Linear host; `test/workflow-dispatch-external-apply-m6.test.ts` now reuses the same M6 execution path from the workflow daemon adapter through mock Linear clients. | Real external writes remain opt-in only and must require `intent_apply_policy: external_apply_allowed`, an operator reason or daemon workflow reason, matched Linear issue scope, and comment/status mutation policy. | `test/full-adapter-e2e.test.ts` (NGX-372) proved the historical closed write side; NGX-496 adds focused composed proof that the daemon external-apply adapter reaches the real M6 path with mock clients, succeeds cleanly when policy permits, and parks refusals for manual recovery without real network calls. | The source-read-through-apply write proof remains mocked/CI-safe by default; real external writes stay opt-in/manual. |
| RunnerAdapter: fake / trusted-shell / acp | `test/runner-adapter.test.ts` covers registry, execution flags, fake dispatch, trusted-shell config failure/success, thrown adapters, invalid inputs, diagnostics, and stable adapter shape. NGX-370 also pins the `dispatchRunnerAdapter` fail-closed `unsupported_runner` envelope for an unregistered kind: the error reports `undefined` runner-log/result paths (no runner ran — distinct from `runner_threw`, which threads the iteration paths so an operator can inspect partial output) and enumerates the executing runner kinds as operator guidance (tying the message to the `executes === true` filter rather than a hard-coded string). Both checks run hermetically with synthetic paths, so no real git repo is initialized. | Legacy foreground/goal smoke coverage uses the runner boundary with local fake/trusted-shell execution. | ACP and real shell profiles must stay manual/flagged when they depend on external runtimes or local auth. | Covered historically through Goal execution, not yet through workflow-first adapter E2E. | NGX-370 closed the unsupported-runner envelope gap. The `!adapter.executes` guard in `dispatchRunnerAdapter` is unreachable defensive code with the current production adapter set (every registered runner is `executes === true`, `ADAPTERS` is private, and dispatch resolves by kind string), so it is covered observably through the executing-runner enumeration rather than by adding a non-executing production adapter or a test-only injection seam (out of scope per NGX-370). NGX-371 owns stubbed composition. |
| WorkflowStepExecutor fake boundary (real default + fake seam) | `test/workflow-step-executor.test.ts` covers the M7 step executor registry, the RC-5 honest `runtime_unavailable` production default, injected fake executor behavior, result states, retry/recovery hints, and thrown/runtime-unavailable paths; `test/workflow-step-executor-real-adapters.test.ts` covers profile-backed real live-wrapper adapters. `test/workflow-daemon-live-wrapper-profile.test.ts` covers daemon-default profile source resolution from `MOMENTUM_LIVE_WRAPPER_PROFILE`, invalid source/profile taxonomy, and the configured real-executor registry handoff. | `test/m7-import-smoke.test.ts` / `test/m7-e2e-smoke.test.ts` cover workflow import/status/handoff paths driven by injected deterministic fake executor output; daemon-default command execution is now covered through the production dispatch row below rather than the fake seam. | Not required for the fake seam; live-wrapper profile execution is covered by the real-adapter unit test, daemon-default profile resolver tests, daemon dispatch tests, and opt-in workflow smokes. | Existing M7/M8 smokes prove substrate behavior; NGX-372, NGX-485, and NGX-492 add post-M10 adapter-stack, fake-demotion, and daemon-default live-wrapper proofs. | Fake demotion landed in NGX-485 and daemon-default live-wrapper profile wiring landed in NGX-492; keep future RC-5 narrowing focused on any newly discovered hardening gaps, not on re-wiring the default daemon lane. |
| Workflow scheduler and production dispatch | `test/workflow-scheduler.test.ts`, `test/workflow-dispatch.test.ts`, and `test/workflow-dispatch-execute.test.ts` cover runnable selection, leases, supported-family dispatch, executor invocation/round scaffold creation, the full unsupported/under-configured fail-closed resolution taxonomy (NGX-370), and run/monitor state refresh. `test/workflow-scheduler.test.ts` also pins the in-order handoff invariant (NGX-370), stale dispatch recovery for terminal executor evidence, non-terminal dispatch-invocation manual recovery, configured dispatch-lease sizing, and no stranded lease on dispatcher throws. `test/workflow-dispatch-execute.test.ts` also pins the scaffold evidence shape (NGX-370): the stable, recomputable invocation id (`<run>::<step>::dispatch`) and its `::round-1` round id that make idempotent re-entry safe and keep the phase-1 row distinct from a landed adapter's reattachable id, plus a no-fabricated-evidence invariant proving the round created before external work carries only empty evidence/payload pointers (null digests, null artifact root, empty `[]` log/key-change/remaining-work/changed-file arrays, null summary/verification/commit/recovery/human-gate) so a scaffold row is never mistaken for completed adapter work. `test/workflow-dispatch-reconcile.test.ts` and `test/workflow-dispatch-reconcile-execute.test.ts` add RC-2 coverage: the pure decider is total across executor-invocation states, the effect seam finalizes clean terminals, parks unclean terminals for manual recovery, defers non-terminal evidence without writes, releases dispatch leases on terminal outcomes, refreshes run state, and proves the M9 direct-finalize lane and M10 dispatched-step reconciliation cannot both finalize the same step. `test/workflow-live-wrapper-dispatch.test.ts` covers the NGX-492 daemon-default composition: configured success/failure through real live-wrapper commands, unconfigured `runtime_unavailable`, idempotent re-entry, context-derivation refusal, fail-closed dispatch passthrough, and M9 direct-finalize compatibility. `test/coding-workflow-live-wrapper.test.ts` covers the NGX-499 checked-in dogfood profile plus its wrapper-command config parser, synthesized success/failure `RunnerResult` evidence, missing-command failure evidence, and timeout process-tree cleanup. | `test/cli-daemon-workflow-dispatch.test.ts` now covers `workflow run start` -> approval -> bounded `daemon start` with `MOMENTUM_LIVE_WRAPPER_PROFILE` -> live-wrapper execution -> durable terminal executor evidence -> RC-2 reconciliation, plus configured dispatch-lease sizing, injected-env forwarding, run-dir creation failure manual recovery, and no stranded dispatch lease. `test/stubbed-adapter-integration-smoke.test.ts` (NGX-371) combines fake source reconciliation, workflow run start, scheduler claim, dispatch lease, and executor invocation/round rows in one local test state. | Real daemon dogfood and real wrapper profiles remain opt-in/operator-driven; default tests use temp data dirs plus cheap fake/local commands under explicit profiles. | `test/full-adapter-e2e.test.ts` (NGX-372) drives the shipped `executeWorkflowStepDispatch` production seam end to end from a real scheduler claim, asserting the phase-1 start scaffold composes with an upstream source read and a downstream landed-adapter finalization in one proof. RC-2 adds a focused production-seam proof in `test/workflow-dispatch-reconcile-execute.test.ts` for terminal executor evidence -> exactly-one workflow-step finalization; NGX-492 proves the bounded daemon-start default can now produce that evidence through a configured live-wrapper profile; NGX-499 adds a checked-in opt-in coding-workflow profile that exercises the same lane without changing defaults. | NGX-371 complete for fake source + workflow dispatch composition; NGX-372 delivered the CI-safe full adapter E2E proof and the opt-in real read smoke; NGX-480 landed the RC-2 reconciliation seam; NGX-485 landed fake demotion; NGX-492 landed daemon-default live-wrapper profile wiring and focused daemon/profile/recovery tests. |
| Goal-loop executor adapter | `test/goal-loop-executor.test.ts`, `test/goal-loop-executor-persistence.test.ts`, `test/goal-loop-mechanism.test.ts`, and `test/goal-loop-orchestrator.test.ts` cover family recognition, round planning, persistence, finalization, recovery taxonomy, and orchestration decisions. `test/goal-loop-orchestrator.test.ts` also proves single-owner enforcement (NGX-370): a duplicate same-`attempt` `runGoalLoopStep` dispatch fails closed with `ExecutorInvocationConflictError` and leaves the prior invocation byte-for-byte untouched, while a fresh `attempt` mints an independent invocation. | Workflow dispatch tests prove the scheduler can scaffold goal-loop-family rows where supported. | Real autonomous goal-loop work remains operator-approved and bounded. | `test/full-adapter-e2e.test.ts` (NGX-372) composes the goal-loop terminal finalization into the full E2E: the real `implementation` step (the goal-loop family in `CODING_WORKFLOW_DEFINITION`) is driven through `runGoalLoopStep` to a bounded multi-round invocation that terminalizes `succeeded` (round 0 continue, round 1 complete), each round gated by a passing verification finalize, on top of a real source read and workflow run start. | NGX-370 closed isolated edges; NGX-372 composed the goal-loop terminal into the full E2E. |
| One-shot and script executor adapters | `test/single-shot-executor.test.ts` and `test/single-shot-executor-persistence.test.ts` cover one-shot/script family recognition, selection, result-bearing one-shot success, script exit-code/bounded-log success, artifacts, checkpoints, and recovery classifications. `test/single-shot-orchestrator.test.ts` drives the one-shot/script step through the real persistence layer and proves single-owner enforcement (NGX-370): a duplicate same-`attempt` `runSingleShotStep` dispatch fails closed with `ExecutorInvocationConflictError`, while a fresh `attempt` mints an independent invocation. NGX-370 also completes the step-level terminal settle matrix: alongside the existing `succeeded` / `failed` / `blocked` settles, a `head_mismatch` round now settles the durable invocation into `manual_recovery_required` with `finished_at` stamped — the orchestrator-layer guard that the decision's `invocationState` (a field distinct from `roundState`) reaches the invocation row, which the round-level `head_mismatch` test pins only at `roundState` and the pure decision test pins only on the classification. | Workflow dispatch tests prove supported single-shot family scaffolding. | Real command execution must remain bounded and policy-controlled. | `test/full-adapter-e2e.test.ts` (NGX-372) drives a one-shot `runSingleShotStep` to a terminal `succeeded` with a passing verification gate inside the composed E2E; the script family shares this landed adapter. The goal-loop, no-mistakes-mirror, and M9 live-wrapper terminals are also composed in their own rows, so the terminal-composition follow-ups are complete. | NGX-370 owns isolated hardening; NGX-371 owns stubbed composition; NGX-372 composed the one-shot terminal finalization into the full E2E proof. |
| No-mistakes executor mirror | `test/no-mistakes-executor.test.ts`, `test/no-mistakes-executor-persistence.test.ts`, `test/no-mistakes-mechanism.test.ts`, and `test/no-mistakes-orchestrator.test.ts` cover external-state mirroring, waiting-operator gates, findings, decisions, CI state, unreadable/inconsistent external state, and persistence. NGX-370 added single-owner enforcement: a duplicate same-`attempt` `runNoMistakesMirrorStep` dispatch fails closed with `ExecutorInvocationConflictError` (the start savepoint rolls back) and leaves the prior invocation untouched. NGX-370 also completes the step-level terminal settle matrix: alongside the existing `running` / `succeeded` / `waiting_operator` / `failed` / `manual_recovery_required` settles, a `blocked` first poll now settles the durable invocation into `blocked` with `finished_at` stamped — the orchestrator-layer guard that the blocked decision's `invocationState` (distinct from `roundState`) reaches the invocation row, which the round-level `blocked` test pins only at `roundState` and the pure decision test pins only on the classification. | No-mistakes mirror is covered with fake external snapshots, not a live no-mistakes process in CI. | Real no-mistakes review/fix remains opt-in and operator-gated. | `test/full-adapter-e2e.test.ts` (NGX-372) composes the no-mistakes mirror terminal finalization into the full E2E: the real `no-mistakes` step (the no-mistakes family in `CODING_WORKFLOW_DEFINITION`) is driven through `runNoMistakesMirrorStep` so the single long-lived mirror round settles to terminal `succeeded` directly from `mirroring_external_state` on a corroborated `completed` external review gate (`stepStatus: completed` + `ciState: passed`, identity matching the pinned expected identity) — the mirror's equivalent of the result-bearing adapters' passing verification gate — on top of a real source read → reconciliation → workflow run start, asserting the durable invocation/round, the pinned-then-mirrored checkpoint stream, and recording mirror composition evidence. Its deterministic invocation id is distinct from the one-shot scaffold `...::dispatch` id, the one-shot adapter id, and the goal-loop adapter id. | NGX-370 kept mirror coverage isolated; NGX-372 composed the no-mistakes mirror terminal into the full E2E. |
| M9 live coding workflow wrappers: GNHF, postflight, no-mistakes, merge cleanup | `test/live-step-executor.test.ts` covers live wrapper dispatch/finalization boundaries, result-file capture, terminal-state mapping, recovery codes, and lease behavior. `test/live-step-orchestrator.test.ts` pins the fail-closed lease invariant (NGX-370): `runLiveWorkflowStep` acquires the managed-step lease with the `manual-recovery-required` stale policy by default — distinct from the generic `auto-release` lease default — so a live step whose process is lost strands the lease into operator recovery rather than silently auto-releasing, and a caller-supplied `stalePolicy` override is forwarded untouched (the two tests independently pin the full `input.stalePolicy ?? "manual-recovery-required"` default expression). It also pins the repo-lock heartbeat monotonicity guard: finalization must not move a repo lock backward if a worker heartbeat advanced the repo-lock row before the workflow-lease row caught up. `test/live-step-run-recovery.test.ts` pins the dispatch-recovery classification fallback (NGX-370): an out-of-taxonomy `dispatchCode` with no precise wrapper `liveRecoveryCode` is classified into the nearest in-taxonomy code (`command_failed`) and rendered into `recovery.md`, so a coarse process-level failure is never dropped or persisted verbatim. | Coding-workflow pipeline smokes and prior PR evidence prove the wrappers under fake or controlled live lanes, but default Momentum tests should not spawn expensive external agents. | `test/real-workflow-smoke.test.ts` (NGX-372) pins the CI-safe opt-in gate for a real harness smoke: `planWorkflowHarnessSmoke` (`src/core/executors/real-workflow-smoke.ts`) resolves the harness command from the M9 `LiveWrapperProfile` (`resolveLiveWrapper`), stays skipped unless `MOMENTUM_REAL_SMOKE_WORKFLOW` is set, keeps the external-write family (`linear-refresh` -> `external-apply`) closed unless the separate `MOMENTUM_REAL_SMOKE_WORKFLOW_ALLOW_WRITE` gate is also opened, and defaults to a probe-only dry-run (full agent spawn requires `MOMENTUM_REAL_SMOKE_WORKFLOW_FULL`). `classifyWorkflowHarnessOutcome` pins the `tool_unavailable` / `timeout` / `command_failed` / `result_missing` / `result_invalid` / `harness_error` taxonomy. `test/real-workflow-probe-smoke.test.ts` (NGX-372) adds the gated probe-execution layer: its `describe.skipIf` block actually runs the resolved pre-flight probe and records evidence under gitignored `.agent-runs/real-smoke/` only when an operator opts in (`MOMENTUM_REAL_SMOKE_WORKFLOW=1` + `MOMENTUM_REAL_SMOKE_WORKFLOW_KIND` + a `MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE` JSON), while the always-on tests cover the execution helpers (`runHarnessProbe`, `loadRawWorkflowProfileFromEnv` in `src/adapters/real-workflow-probe.ts`) and the pure `classifyProbeSpawnResult` mapping by spawning only a cheap local `process.execPath` child. The planner stays pure (spawns nothing); the gated smoke runs only the cheap availability probe, never the full agent — full execution stays coding-workflow-pipeline controlled and explicitly approved by run id/boundary. | `test/full-adapter-e2e.test.ts` (NGX-372) composes the M9 live-wrapper managed-step terminal finalization: the real `merge-cleanup` step (a live-wrapper family step) is driven through `runLiveWorkflowStep` so the durable `workflow_steps` row transitions approved → running → succeeded under a `managed-step` lease against a real worker-held repo lock, persisting terminal state before releasing the lease — a layer genuinely distinct from the executor-loop adapters (it advances `workflow_steps` directly and mints no `executor_invocations` / `executor_rounds` rows). Historical workflow PRs also prove the lane; NGX-372 delivered the opt-in proof path (the planner above) and the gated pre-flight probe execution after isolated/stubbed gaps closed. | NGX-371 / NGX-372 split stubbed wrapper composition from real harness proof. NGX-372 landed the CI-safe opt-in harness gate and the gated probe-execution smoke; the goal-loop, no-mistakes-mirror, and M9 live-wrapper terminals are now all composed into the full E2E, completing the NGX-372 terminal-composition follow-ups. |
| Unsupported executor families; external-apply / subworkflow dispatch adapters | `test/workflow-dispatch-execute.test.ts` covers the durable fail-closed dispatch taxonomy for resolution failures and the remaining defensive unsupported-family branch; `test/workflow-dispatch.test.ts` pins `external-apply` and `subworkflow` in the dispatchable set. `test/workflow-dispatch-external-apply.test.ts`, `test/workflow-dispatch-external-apply-run.test.ts`, and `test/workflow-dispatch-external-apply-m6.test.ts` cover the M6 mapping, scaffold-family guard, daemon wrapper reachability, idempotent re-entry, and real `executeExternalApply` reuse through mock Linear clients. `test/workflow-dispatch-subworkflow.test.ts`, `test/workflow-dispatch-subworkflow-run.test.ts`, `test/workflow-subworkflow-dispatch.test.ts`, `test/workflow-dispatch-subworkflow-child-run.test.ts`, `test/workflow-subworkflow-child-config.test.ts`, `test/workflow-subworkflow-route.test.ts`, `test/workflow-subworkflow-child-runner.test.ts`, `test/workflow-subworkflow-dispatch-context.test.ts`, and `test/workflow-dispatch-subworkflow-flip.test.ts` cover the RC-4/RC-4b child-run mirror mapping, route-sourced child config / lineage, async producer deferral / terminal mirroring, daemon-lane factory, active scheduler rechecks, real child-run start-or-attach proof, unsupported attachment refusal, and configured bounded daemon dispatch proof. | External-apply tests verify terminal executor evidence and fail-closed M6 refusals; subworkflow tests verify the adapter mechanism and configured production lane behind the parent/child ownership boundary. | Real external writes remain policy-gated and are mocked in CI; no real api.linear.app calls run in tests. Real child workflow coverage uses local Momentum workflow state. | NGX-496 adds focused external-apply adapter wiring coverage; NGX-497 adds focused subworkflow adapter coverage; NGX-498 adds the configured production flip proof. | Keep future work focused on broader recursive orchestration/config decisions, not on re-closing the now-landed configured lane. |

## Follow-on issue split

- **NGX-369 — Isolated source adapter contract tests.** Complete. Owns source
  adapter and Linear read-side hardening, especially no-network guards,
  pagination, response shape failures, read-only invariants, and durable
  reconciliation summaries.
- **NGX-370 — Isolated coding workflow adapter contract tests.** Owns runner,
  workflow-step, scheduler/dispatch, goal-loop, one-shot/script, no-mistakes,
  and live-wrapper contract hardening without real external systems.
- **NGX-371 — Stubbed adapter integration smoke.** Complete. Owns
  `test/stubbed-adapter-integration-smoke.test.ts`, a fake/local composition
  proof through Momentum persistence that exercises source adapter reads plus
  workflow/executor dispatch evidence without real external hosts.
- **NGX-372 — Opt-in real adapter smoke and full E2E proof.** Owns the manual
  or flagged real-smoke path and the final E2E proof after NGX-369..NGX-371 are
  green. Delivered:
  - The opt-in real **read-only** Linear source smoke: `src/core/executors/real-smoke.ts`
    (`planLinearReadSmoke` gating + `classifyRealSmokeReadOutcome` failure
    taxonomy), unit-pinned in `test/real-smoke.test.ts`, and the gated
    `test/real-linear-read-smoke.test.ts` that skips out of CI unless the
    operator opts in with a credential.
  - The CI-safe **full adapter E2E proof**, `test/full-adapter-e2e.test.ts`,
    composing source read → local reconciliation/persistence → workflow run start
    → production dispatch scaffold (`executeWorkflowStepDispatch` from a real
    scheduler claim) → landed one-shot adapter terminal finalization with a
    passing verification gate (`runSingleShotStep`) → historical external-write
    (`external-apply`) family closed proof, superseded by NGX-496's focused
    daemon external-apply adapter coverage with mocked Linear clients (durable
    evidence when `MOMENTUM_E2E_EVIDENCE_DIR` is set).
  - The CI-safe decision core for the opt-in real **coding-workflow harness**
    smoke: `src/core/executors/real-workflow-smoke.ts` (`planWorkflowHarnessSmoke` gating over
    the M9 `LiveWrapperProfile` + `classifyWorkflowHarnessOutcome` failure
    taxonomy), unit-pinned in `test/real-workflow-smoke.test.ts`. It is the
    explicitly-flagged opt-in gate for invoking a real preflight /
    implementation (GNHF) / postflight / no-mistakes / merge-cleanup /
    linear-refresh wrapper: skipped unless
    `MOMENTUM_REAL_SMOKE_WORKFLOW` is set, keeps the external-write family
    (`linear-refresh`) closed behind the separate
    `MOMENTUM_REAL_SMOKE_WORKFLOW_ALLOW_WRITE` gate, and defaults to a
    probe-only dry-run. Live full-agent execution itself stays
    coding-workflow-pipeline owned (the planner is the gate, not the runner).
  - The gated **probe-execution** smoke, `test/real-workflow-probe-smoke.test.ts`,
    plus its execution helpers in `src/adapters/real-workflow-probe.ts`
    (`runHarnessProbe`, a bounded `spawnSync` over the resolved pre-flight probe;
    `loadRawWorkflowProfileFromEnv`, the fail-closed profile-JSON loader) and the
    pure `classifyProbeSpawnResult` mapping in `src/core/executors/real-workflow-smoke.ts`. The
    `describe.skipIf` block actually runs the resolved probe and records evidence
    under gitignored `.agent-runs/real-smoke/` only when the operator opts in
    (`MOMENTUM_REAL_SMOKE_WORKFLOW=1` + `MOMENTUM_REAL_SMOKE_WORKFLOW_KIND` +
    `MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE`); the always-on tests cover the helpers
    by spawning only a cheap local `process.execPath` child (clean exit, non-zero
    exit, missing binary, timeout). It runs the cheap availability probe only,
    never the full agent.
  - The **goal-loop terminal finalization** composed into the full E2E proof: a
    new case in `test/full-adapter-e2e.test.ts` drives the real `implementation`
    step (the goal-loop family in `CODING_WORKFLOW_DEFINITION`) through
    `runGoalLoopStep` to a bounded multi-round invocation that terminalizes
    `succeeded` (round 0 continue, round 1 complete), each round gated by a
    passing verification finalize, on top of a real source read → reconciliation
    → workflow run start, recording goal-loop composition evidence. Its
    invocation id is deterministic/reattachable and distinct from the one-shot
    scaffold's `...::dispatch` id and the one-shot adapter id, so the scaffold +
    one-shot terminal + goal-loop terminal compose without minting two owners for
    one step.
  - The **no-mistakes mirror terminal finalization** composed into the full E2E
    proof: a new case in `test/full-adapter-e2e.test.ts` drives the real
    `no-mistakes` step (the no-mistakes family in `CODING_WORKFLOW_DEFINITION`)
    through `runNoMistakesMirrorStep` so the single long-lived mirror round
    settles to terminal `succeeded` directly from `mirroring_external_state` on a
    corroborated `completed` external review gate (`stepStatus: completed` +
    `ciState: passed`, identity matching the pinned expected identity) — the
    mirror's equivalent of the result-bearing adapters' passing verification gate
    — on top of a real source read → reconciliation → workflow run start. It
    asserts the durable invocation/round, the pinned-then-mirrored checkpoint
    stream (`expected_external_identity` → `external_state_mirrored`), and records
    mirror composition evidence. Its deterministic invocation id is distinct from
    the one-shot scaffold's `...::dispatch` id, the one-shot adapter id, and the
    goal-loop adapter id, so a fourth terminal family composes without minting two
    owners for one step.
  - The **M9 live-wrapper managed-step terminal finalization** composed into the
    full E2E proof: a new case in `test/full-adapter-e2e.test.ts` drives the real
    `merge-cleanup` step (a live-wrapper family step) through `runLiveWorkflowStep`
    so the durable `workflow_steps` row transitions approved → running → succeeded
    under a `managed-step` lease against a real worker-held repo lock, persisting
    terminal state before releasing the lease, on top of a real source read →
    reconciliation → workflow run start (opened `approved` through `merge-cleanup`
    via the real approval-boundary persistence path). This is the managed-step
    layer the executor-loop adapters never touch: it advances `workflow_steps`
    directly and mints no `executor_invocations` / `executor_rounds` rows, so the
    proof asserts the terminal step state, the start/finish stamps, the live result
    digest, and the lease released exactly at finalization, and records live-wrapper
    composition evidence.

  NGX-372 terminal-composition follow-ups complete: the one-shot, goal-loop,
  no-mistakes-mirror, and M9 live-wrapper terminals are all composed into
  `test/full-adapter-e2e.test.ts`, alongside the production dispatch scaffold and
  the held-closed external-write policy gate.

## Guardrails

- Default CI must not call real `api.linear.app`, real ACP, real GNHF,
  real no-mistakes, or any external write path.
- Real external writes require the M6 policy gate, an operator reason, and the
  audit-before-write lifecycle.
- Source adapters remain read-only even when the broader E2E path later applies
  an update intent through the separate write-side adapter.
- Unsupported executor families must fail closed with operator-visible recovery
  until a dedicated adapter implementation lands.
