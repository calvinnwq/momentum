# Milestone 10: Workflow-First Runtime

**Status:** Planned / next. M10 is the first implementation milestone for the
workflow-first runtime model accepted in PR #70. It is not active until M10-00
lands, and it does not close or rewrite M9 by itself.

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
current-to-target migration shape. M10-00 promotes them into an executable
milestone narrative and issue sequence; later M10 slices implement the runtime.

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
   definitions, validation, and a built-in coding workflow definition while
   keeping existing workflow import and goal surfaces stable.
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
   finalization behavior.
7. **NGX-350 — M10-06 One-shot and script executor adapters.** Support deterministic
   commands and bounded one-shot agent/script invocations with normalized
   results.
8. **NGX-351 — M10-07 no-mistakes executor mirror.** Mirror no-mistakes runs, findings,
   selected finding IDs, decisions, PR / CI state, and completion into Momentum
   executor records.
9. **NGX-352 — M10-08 Workflow gates and decisions CLI.** Add durable operator decision
   commands and delegated-policy application for workflow / step / executor
   gates.
10. **NGX-353 — M10-09 Workflow-first dogfood and closeout.** Run a real Momentum task
    through the workflow-first start surface, update regression coverage, and
    close M10.

NGX-345 through NGX-353 are the assigned Linear issue identifiers for M10-01
through M10-09. The M10 slice labels remain the stable ordering contract.

## Doctor Marker Policy

The `doctor --json` readiness marker tracks the most recently closed
milestone, not the next planned milestone. M10 planning does not flip it.

The marker remains:

```text
Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete
```

M10 may only flip the marker at M10 closeout after M10-00 through M10-08 have
merged, the workflow-first dogfood gate passes, and the regression matrix is
updated.

## Non-Goals

M10-00 is docs/spec/tests only. It does not implement schema, CLI, daemon, or
runtime changes.

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
