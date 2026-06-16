# Milestone 10: Workflow-First Runtime

**Status:** Complete. M10 is the first implementation milestone
for the workflow-first runtime model accepted in PR #70. M10-00 promoted the
planning contracts into this executable sequence. M10-01 landed the
workflow / step definition primitives, M10-02 added workflow
run start, M10-03 added the durable executor-loop schema, M10-04 added the
opt-in daemon workflow scheduler lane, M10-05 adds the goal-loop executor
adapter, M10-06 adds the one-shot / script executor adapters, M10-07 adds
the no-mistakes executor mirror, M10-08 adds the durable workflow gates and
the `workflow run decide` operator decision CLI, and M10-09a wires the
production workflow-lane dispatcher into bounded managed `daemon start` without
closing or rewriting M9 by itself. M10-09 dogfooded that shipped
workflow-first path and closes the milestone.

M10 promotes Momentum from a Goal-first product surface plus imported
OpenClaw-coding-workflow substrate into a configurable workflow runtime:

```text
WorkflowDefinition -> StepDefinition[]
WorkflowRun -> StepRun[]
StepRun -> ExecutorInvocation -> ExecutorRound[]
```

## Source Contracts

M10 is governed by these planning contracts:

- [`internal/contracts/workflow-first-runtime.md`](../contracts/workflow-first-runtime.md)
- [`internal/contracts/executor-loop.md`](../contracts/executor-loop.md)
- [`internal/contracts/workflow-first-gap-matrix.md`](../contracts/workflow-first-gap-matrix.md)

Those contracts pin the product pivot, executor-loop semantics, and
current-to-target migration shape. M10-00 promoted them into an executable
milestone narrative and issue sequence; M10-01 adds the first durable definition
schema, validation, and persistence primitives, M10-02 adds workflow run start,
M10-03 adds executor definition / invocation / round persistence, M10-04 adds
the daemon workflow scheduler lane, M10-05 adds the goal-loop executor adapter,
M10-06 adds the one-shot / script executor adapters, M10-07 adds the
no-mistakes executor mirror, M10-08 adds the durable workflow gates and operator
decision CLI, M10-09a adds production workflow-lane dispatcher wiring for
bounded managed `daemon start`, and M10-09 records the closeout dogfood
evidence.

## Relationship To M9

M9 remains valid foundation work.

M9 owns live execution primitives for the existing OpenClaw coding-workflow
shape:

- live wrapper registry and config
- explicit argv/env/cwd/result-file execution
- managed-step leases and heartbeats
- bounded logs and normalized result capture
- verification / commit / reset finalization
- run-scoped live recovery

M10 reuses those primitives, but M10 does not keep the fixed M9 step-kind model
as the final product shape. The future product root is `WorkflowDefinition` /
`WorkflowRun`; `goal-loop` becomes one executor family inside a workflow step.

M10 also supersedes the earlier future-facing M9 preference for `goal start`
plus a `WorkflowRun` link. `goal start` remains a compatibility path while M10
adds first-class workflow definition and workflow run start surfaces.

## Goal

Make Momentum capable of starting, supervising, inspecting, and recovering a
configurable workflow run whose steps are powered by pluggable executors.

The first workflow-first dogfood should prove:

- a workflow definition can be validated and started
- steps can run from configurable `StepDefinition` records
- executor invocations and rounds persist below `StepRun`
- the daemon can schedule workflow runs and step runs without breaking existing
  goal iteration draining
- `goal-loop` can run implementation-like bounded autonomous rounds
- `one-shot` and `script` can run bounded single-invocation work
- no-mistakes can be mirrored as a specialist executor without reimplementing
  no-mistakes internals
- durable human gates and operator decisions can pause and resume work
- status, logs, handoff, monitor, recovery, and evidence surfaces remain
  inspectable after process or chat loss

## Ownership Boundary

**Momentum owns in M10:**

- `WorkflowDefinition` and `StepDefinition` schema, validation, and built-in
  coding workflow definition.
- `WorkflowRun` start from definitions.
- `ExecutorDefinition`, `ExecutorInvocation`, and `ExecutorRound` records.
- A daemon scheduling lane for workflow runs and step runs.
- A `goal-loop` executor adapter that reuses existing Goal / iteration safety
  where possible.
- `one-shot` and `script` executor adapters for bounded deterministic or
  single-invocation work.
- A no-mistakes executor mirror that records findings, decisions, PR / CI
  state, and completion in Momentum.
- Durable workflow gates and decision commands.
- A workflow-first dogfood run and closeout.

**Momentum does not own in M10 unless a slice explicitly says so:**

- Rewriting GNHF.
- Rewriting no-mistakes.
- Remote git operations.
- Public dashboards or UI.
- Inbound webhooks.
- Strong sandboxing.
- Autonomous external writes outside existing policy gates.
- Subworkflow execution beyond the contract placeholder.

## Implementation Sequence

The M10 slice order is:

1. **NGX-344 — M10-00 Workflow-first contract and milestone setup.** Promote
   the merged planning contracts into this milestone narrative, update roadmap
   and exclusions, add contract tests, and pin the executable sequence. No
   runtime behavior change.
2. **NGX-345 — M10-01 WorkflowDefinition and StepDefinition schema.** Add durable
   definitions, validation, persistence, and a built-in coding workflow
   definition while keeping existing workflow import and goal surfaces stable.
3. **NGX-346 — M10-02 Workflow run start.** Add first-class workflow run start from a
   validated definition with approval boundaries, repo policy, and refusal
   taxonomy.
4. **NGX-347 — M10-03 ExecutorDefinition / Invocation / Round schema.** Persist executor
   loop state below step runs, including artifacts, checkpoints, findings, and
   decisions.
5. **NGX-348 — M10-04 Daemon workflow scheduler lane.** Schedule runnable workflow runs
   and step runs without breaking existing goal iteration draining.
6. **NGX-349 — M10-05 Goal-loop executor adapter.** Move implementation-like autonomous
   rounds into the executor-loop model while preserving repo safety and
   finalization behavior. *(done)*
7. **NGX-350 — M10-06 One-shot and script executor adapters.** Support bounded
   one-shot invocations with normalized results and deterministic script
   commands that succeed from exit code plus bounded logs. *(done)*
8. **NGX-351 — M10-07 no-mistakes executor mirror.** Mirror no-mistakes runs, findings,
   selected finding IDs, decisions, PR / CI state, and completion into Momentum
   executor records. *(done)*
9. **NGX-352 — M10-08 Workflow gates and decisions CLI.** Add durable operator decision
   commands and delegated-policy application for workflow / step / executor
   gates. *(landed in this slice)*
10. **NGX-367 — M10-09a Production workflow-lane dispatcher prep.** Wire bounded
    managed `daemon start` to a production dispatcher that resolves claimed
    steps to executor families, creates executor invocation / round start
    scaffolds for supported families, and fail-closes unsupported or
    unresolvable claims to manual-recovery gates when the run row can carry
    one. *(done)*
11. **NGX-353 — M10-09 Workflow-first dogfood and closeout.** Run a real Momentum task
    through the workflow-first start surface, update regression coverage, and
    close M10. *(done)*

NGX-345 through NGX-353 are the assigned Linear issue identifiers for M10-01
through M10-09, with NGX-367 inserted as the M10-09a prep / repair slice before
NGX-353. The M10 slice labels remain the stable ordering contract.

## Closeout Dogfood

The M10 closeout dogfood used the real Momentum data dir and shipped CLI path,
not a test-only injected dispatcher:

```text
workflow run start --run-id ngx353-m10-closeout --definition coding-workflow --issue-scope NGX-353
workflow run approve ngx353-m10-closeout --approval-boundary through-implementation
daemon start --max-loop-iterations 1 --poll-interval-ms 0
workflow run monitor ngx353-m10-closeout
```

The dogfood proved the workflow-first start / approval / bounded daemon dispatch
path creates durable executor rows below a real `WorkflowRun`. It also exposed a
closeout bug: the dispatch path advanced `workflow_steps.preflight` to
`running` and created the executor scaffold, but left the parent
`workflow_runs` state and monitor advisory snapshot stale at `approved`. NGX-353
fixed that bug by refreshing both the canonical run state and advisory monitor
columns in the same transaction that creates the dispatch scaffold.

The final closeout evidence for `ngx353-m10-closeout` is:

- `workflow run monitor` reports `runState: "running"`, `stepState: "running"`,
  `reportReason: "in_progress"`, and `monitorDrift.drifted: false`.
- `workflow_runs` has `state = running`, `monitor_last_seen_state = running`,
  `monitor_terminal = 0`, and `monitor_step = preflight`.
- `workflow_steps` has `preflight = running`, `implementation = approved`, and
  later steps still pending.
- `executor_invocations` contains
  `ngx353-m10-closeout::preflight::dispatch` for the `one-shot` executor family.
- `executor_rounds` contains
  `ngx353-m10-closeout::preflight::dispatch::round-1` as the phase-1 start
  scaffold.

That is the intended M10 boundary: the shipped daemon path can start and observe
a workflow-first run through durable executor records. Driving the scaffolded
round all the way through the real executor mechanisms, plus generalized
`external-apply` and `subworkflow` dispatch, stays deferred to later runtime
work.

## Post-Closeout Tightening (NGX-391)

NGX-391 (M10-09b) tightens the NGX-353 closeout proof by adding a controlled
terminalize-and-continue fixture that proves a *single* daemon process can
dispatch more than one local step. The NGX-353 dogfood required three separate
`daemon start` invocations plus a manual `workflow run update-step` to advance
past `preflight`; NGX-391 eliminates that limitation with an opt-in dispatch
wrapper.

The fixture (`src/core/workflow/dogfood-dispatch.ts`, enabled via
`MOMENTUM_DOGFOOD_TERMINALIZE_DISPATCH=1`) wraps the production
`executeWorkflowStepDispatch`, terminalizes the step immediately after the real
executor-invocation scaffold is created, and releases its dispatch lease — all
in one `BEGIN IMMEDIATE` transaction. Because the lease is released and the step
is `succeeded`, the scheduler sees the run as scannable again and dispatches the
next approved step in the same loop iteration.

Safety posture: the terminalization is gated on `shouldTerminalizeAfterDispatch`
so a `failClosed` or `stepNotStartable` dispatch (both of which have already
released their lease and written nothing or parked the run) is echoed back
untouched. Terminalizing a parked run to `succeeded` would mask a
manual-recovery condition; the gate exists to prevent exactly that move. The
default `daemon start` path is byte-for-byte unchanged when the env var is unset.

Coverage lives in `test/workflow-dogfood-dispatch.test.ts` (unit safety gates)
and `test/workflow-dogfood-multi-dispatch.test.ts` (single-process multi-dispatch
proof through `runDaemonLoop` and the read-only status / monitor / handoff
surfaces). NGX-391 did not reopen M10 or move the then-current M10 doctor
marker; the later M11 closeout advanced the current marker again.

## Doctor Marker Policy

The `doctor --json` readiness marker tracks the most recently closed
milestone, not in-flight implementation slices. M10 owned the marker after
NGX-353 until the M11 closeout advanced it again.

The M10 marker was:

```text
Milestone 10: workflow-first runtime (NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349, NGX-350, NGX-351, NGX-352, NGX-367, NGX-353) complete
```

M10 flipped the marker at M10 closeout after M10-00 through M10-09a merged, the
workflow-first dogfood gate passed, and the regression matrix was updated. The
current marker is the M11 closeout string recorded in
[`internal/roadmap.md`](../roadmap.md).

## Non-Goals

M10-00 was docs/spec/tests only. M10-01 adds definition schema, validation, and
persistence only; M10-02 adds first-class workflow run start; M10-03 adds
executor-loop schema and persistence only; M10-04 adds the opt-in daemon
workflow scheduler lane only; M10-05 adds the goal-loop executor adapter only;
M10-06 adds the one-shot and script executor adapters only; M10-07 adds the
no-mistakes executor mirror only (brain, external-state reader, and polling
orchestrator); M10-08 adds the durable workflow gates, the `evaluateGateDecision`
brain, gate persistence, and the `workflow run decide` operator decision CLI plus
gate visibility only; M10-09a adds production workflow-lane dispatcher wiring,
executor start scaffolds, fail-closed manual-recovery gates for unsupported or
unresolvable dispatch claims whose run row still exists, and orphaned lease
release for vanished-run claims only; M10-09 adds dogfood closeout evidence and
the marker flip. Generalized runtime behavior remains later work.

Across the milestone, these remain outside scope unless a later contract
explicitly changes them:

- Replacing GNHF or no-mistakes internals.
- Flattening every executor round into a top-level workflow step.
- Treating executor recommendations as authoritative without daemon
  classification.
- Remote git operations.
- Public UI / dashboard surfaces.
- Autonomous external writes outside existing operator-mediated contracts.
- Strong sandboxing.
- Inbound webhooks.
