# Contract: Workflow-First Runtime Pivot

**Status:** Accepted planning contract. This is the target runtime shape for the workflow-first milestone. It does not flip the doctor marker, does not replace the M9 live-wrapper work already landed, and does not authorize runtime behavior changes by itself.

This contract records the product pivot from Goal-first execution to Workflow-first execution.
The bounded executor loop details are pinned separately in
[`internal/contracts/executor-loop.md`](executor-loop.md).
The current-to-target implementation bridge is pinned in
[`internal/contracts/workflow-first-gap-matrix.md`](workflow-first-gap-matrix.md).

The core decision is:

- `WorkflowDefinition` is the reusable recipe.
- `WorkflowRun` is one execution of a workflow definition.
- `StepDefinition` is one configured step inside the recipe.
- `StepRun` is the durable execution state for one step in one run.
- `Executor` is the mechanism a step uses to do work.

The old Goal model becomes one executor family: `goal-loop`. A goal loop can power an implementation step, but it is not the top-level product concept.

## Relationship To M9

M9 remains valid foundation work. It proved live wrapper configuration, managed-step leases, live result capture, verification / commit finalization, and run-scoped recovery against the existing OpenClaw coding workflow shape.

This pivot changes the future product model:

- M9 wraps existing OpenClaw coding workflow engines by fixed step kinds.
- The workflow-first runtime generalizes those ideas into configurable workflow definitions and pluggable step executors.
- M9 primitives should be reused where possible: workflow run state, approvals, leases, live wrapper execution, result-file validation, the shared verification / commit finalization seam extracted from M9, and recovery taxonomy.
- M9 should not be stretched into a generic workflow product retroactively. M10 owns the workflow-first implementation sequence, starting with workflow / step definition primitives.

The earlier M9 run-start preference of `goal start` plus a `WorkflowRun` link is superseded for future workflow-first work. M10-02 has landed the top-level workflow run start surface; it starts `WorkflowRun` rows from definitions rather than from the Goal loop. `goal start` remains a compatibility path for the old Goal loop until it is migrated or deprecated.

## What Momentum Should Copy

Momentum should copy the durable loop discipline from GNHF and no-mistakes, not their product boundaries.

### From GNHF

GNHF is an in-process iteration runner, not a resident daemon. Its useful pattern is a bounded implementation loop:

- Build an iteration prompt.
- Run an agent / harness.
- Write `iteration-<n>.jsonl`.
- Append `notes.md`.
- Commit successful output.
- Stop on max iterations, max tokens, or max consecutive failures.

Momentum should copy this as the behavior of a `goal-loop` executor round. It should not copy `.gnhf/runs` as the primary state store, and it should not let GNHF become the permanent top-level runtime.

### From no-mistakes

no-mistakes is the daemon model to copy. It has a resident daemon, a Unix socket, SQLite as the proof of run state, per-run logs, gate repos, and fixed pipeline step rows.

Useful concepts to reuse:

- Daemon / supervisor owns active work.
- SQLite is the source of truth.
- A push or external event is not proof of run start; a durable run row is proof.
- Step results and internal rounds are separate.
- Findings, selected finding IDs, fix decisions, and manual gates are durable.
- TUI / attach is an interface over durable state, not the source of truth.
- Delegated policy may auto-apply safe decisions, but ambiguous or risky findings pause for an operator.

Momentum should not copy no-mistakes' fixed pipeline, Git-push trigger, or disposable worktrees as the default product boundary.

## Target Runtime Model

The workflow-first runtime stores top-level workflow state separately from executor-loop state.

Workflow-level state:

```text
workflow_definitions
step_definitions
workflow_runs
step_runs
workflow_approvals
workflow_leases
workflow_recovery
```

Executor-level state:

```text
executor_definitions
executor_invocations
executor_rounds
executor_artifacts
executor_findings
executor_decisions
executor_checkpoints
```

The distinction is intentional:

```text
StepRun says: implementation is running.
ExecutorRound says: implementation round 3 used Claude Opus, produced commit abc123, verification passed, and remaining work is empty.
```

Workflow UX should stay readable:

```text
implementation
postflight
no-mistakes
merge-cleanup
```

Inspection should still show the deep loop state under each step:

```text
implementation
  round 1
  round 2
  round 3

no-mistakes
  mirror round 0
    findings
    decisions
```

Loops live inside executors, but their rounds belong in Momentum's database. External no-mistakes review/fix phases remain owned by no-mistakes and are mirrored below one long-lived Momentum round.

## Executor Families

Initial executor families:

- `goal-loop` — bounded autonomous implementation rounds.
- `one-shot` — one command or agent invocation with normalized result output.
- `no-mistakes` — specialist review gate mirroring no-mistakes daemon state.
- `script` — deterministic local command execution with exit-code/log result semantics.
- `external-apply` — operator-mediated external write using the M6 external apply contract.
- `subworkflow` — future nested workflow execution.

The current OpenClaw coding workflow maps naturally:

```text
preflight -> one-shot
implementation -> goal-loop
postflight -> one-shot or goal-loop
no-mistakes -> no-mistakes
merge-cleanup -> external-apply or script
linear-refresh -> external-apply
```

The post-M10 ownership contract for that coding workflow lives in
[`internal/contracts/coding-workflow-ownership.md`](coding-workflow-ownership.md).
It pins the migration rule that Momentum owns future coding workflow runtime
state, while OpenClaw remains the client / rendering / compatibility layer and
the existing `coding-workflow-pipeline` stays the stable production path until
the Momentum-native route proves a full dogfood.

## Daemon Contract

The daemon owns scheduling, leases, durable state transitions, round classification, and whether a step may advance.

The daemon loop should:

```text
scan runnable workflow_runs / step_runs
for each active step:
  acquire or refresh daemon / step lease
  inspect executor state
  mirror new artifacts, rounds, findings, and checkpoints
  classify outcome
  if continue: enqueue the next round or check
  if human gate: persist gate, notify, and pause
  if terminal: finalize step and maybe start the next approved step
```

State checking is hybrid:

- Fast path: child process exit, executor event, socket message, or file watcher indicates state changed.
- Safe path: interval polling of SQLite plus executor artifacts, logs, git state, PR state, and CI state proves the durable state.
- Watchdog path: heartbeat and lease TTLs detect lost or stale work.

The safe path is authoritative. A process handle is an optimization. Reattach after daemon restart must work from SQLite, artifacts, logs, and repo state.

Suggested polling cadence:

```text
local running process: 5-15s heartbeat/check
external long-running executor: 30-60s check
quiet monitor/cron-like step: 2-5m check
stale detection: based on missed heartbeats / expired leases
```

## Goal-Loop Executor Interface

The common executor-loop lifecycle, state vocabulary, round schema, artifact
requirements, reattach rules, human-gate taxonomy, and agent/model precedence
live in [`internal/contracts/executor-loop.md`](executor-loop.md). This section
keeps the workflow-first pivot readable by showing how `goal-loop` fits that
common contract.

The `goal-loop` executor owns one bounded round of work at a time. It does not own workflow scheduling.

Proposed executor interface:

```ts
type Executor = {
  prepare(invocation: ExecutorInvocation): PreparedInvocation;
  startRound(input: ExecutorRoundInput): RunningHandle;
  inspect(target: RunningHandle | ExecutorInvocationId): ExecutorSnapshot;
  cancel(invocationId: ExecutorInvocationId, reason: string): CancelResult;
  recover(invocationId: ExecutorInvocationId): ExecutorSnapshot;
};
```

A goal-loop round input includes:

- Objective.
- Step scope.
- Repo path.
- Step run id.
- Prior round summaries.
- Workflow policy.
- Executor policy.
- Agent / model config.
- Verification config.
- Daemon-provided artifact directory.
- Required result path.

A goal-loop round output includes:

- Normalized result JSON.
- Summary.
- Key changes.
- Remaining work.
- Changed files.
- Optional commit SHA.
- Verification status.
- Recovery hint.
- Logs and artifacts.
- Human-gate recommendation, if any.

The daemon persists the output as `executor_rounds` and classifies it.

The executor may recommend `continue`, but the daemon decides whether another round is allowed based on:

- Max rounds.
- Quota.
- Wall-time budget.
- Verification status.
- Scope boundary.
- Human-gate classes.
- Repo lease.
- Step approval.
- Workflow approval boundary.
- Manual-recovery state.

## Goal-Loop Round Lifecycle

A `goal-loop` step behaves like:

```text
StepRun: implementation / running
  ExecutorInvocation: goal-loop / running
    round 1: plan -> execute -> verify -> commit -> continue
    round 2: execute -> verify -> commit -> continue
    round 3: execute -> verify -> commit -> complete
StepRun: implementation / succeeded
```

Each round should:

1. Load workflow input, step definition, repo policy, prior round summaries, and current repo state.
2. Resolve agent / model from step executor config.
3. Acquire or reuse daemon-approved repo and step ownership.
4. Run the agent / harness with explicit argv / env / result path.
5. Require normalized result JSON.
6. Verify and commit through Momentum's finalization path.
7. Persist artifacts, checkpoints, and round state.
8. Return a classification recommendation: complete, continue, blocked, failed, or manual recovery.

The daemon then performs the authoritative classification and transition.

## Human Gates

Human intervention is first-class durable state. It is not an exception thrown by the daemon and it is not a hidden TUI prompt.

Step or executor state may pause as:

```text
approval_required
operator_decision_required
manual_recovery_required
blocked
failed
```

When a human gate appears, the daemon must:

- Stop advancing that step.
- Persist the gate, allowed actions, evidence, and reason.
- Keep the workflow run inspectable.
- Emit a notification or monitor event.
- Resume only after an explicit operator command / API update.

Examples:

- GNHF max failures maps to executor retry policy ending in `blocked` or `failed`.
- no-mistakes review findings map to `operator_decision_required` with finding IDs and allowed actions such as `fix`, `skip`, `approve_as_is`, `reject`, or `abort`.
- `agent-recommended-important` maps to an auto-decision policy. If every finding is inside the approved envelope, the daemon may apply it and continue. If any finding is outside the envelope, the daemon pauses with a precise decision request.

Autonomy is allowed only inside the approved envelope. Product decisions, destructive actions, dependency installs, secrets / auth uncertainty, privacy uncertainty, public API breaks, irreversible migrations, remote writes, and exhausted retries all pause for the operator unless a workflow definition explicitly grants a narrower safe policy.

## External Executor Mirroring

External executors may keep their own state, but Momentum mirrors enough state to be authoritative for workflow orchestration.

For GNHF-like execution:

- Mirror run id, repo, branch, current round, result artifact paths, logs, commit SHA, and completion classification.
- Treat `.gnhf/runs` artifacts as evidence, not the primary state store.

For no-mistakes:

- Mirror run id, branch, head SHA, active step, step status, findings, selected finding IDs, PR URL, CI status, and gate decisions.
- Read the bounded external JSON state snapshot through `readNoMistakesExternalState` / `parseNoMistakesExternalState` as the integration seam; missing, unreadable, oversized, or malformed snapshots become error evidence instead of daemon throws.
- Treat that JSON snapshot as external evidence, not direct authority: Momentum `step_runs` / `executor_rounds` / `executor_findings` / `executor_decisions` decide whether the workflow step can advance, and completion requires all mirrored decisions to be resolved.

Momentum must not blindly trust a single external status string. It should reconcile external state with artifacts, logs, repo state, and configured completion requirements.

## Gap Matrix

The detailed current-to-target migration matrix and M10 implementation slice
order live in
[`internal/contracts/workflow-first-gap-matrix.md`](workflow-first-gap-matrix.md).
The compact table below preserves the core shape inside this pivot contract.

Current Momentum state:

- Has SQLite-backed goals, jobs, daemon runs, repo locks, and goal iteration queue draining.
- Has `WorkflowRun` / `workflow_steps` / approvals / leases for OpenClaw coding workflow substrate.
- Has M8 operator controls over imported workflow runs.
- Has M9 live wrapper and finalization primitives for fixed canonical step kinds.
- Has M10-01 `WorkflowDefinition` / `StepDefinition` validation, built-in coding workflow definition, and `workflow_definitions` / `step_definitions` persistence.
- Has M10-02 `workflow run start` materialization from persisted or built-in definitions, including definition provenance on `workflow_runs`.
- Has M10-03 `ExecutorDefinition` / `ExecutorInvocation` / `ExecutorRound` schema and persistence below workflow steps, including round artifacts, checkpoints, findings, and decisions.
- Has M10-04 opt-in daemon workflow scheduler lane (recover -> scan -> claim -> dispatch) that schedules runnable workflow steps alongside goal iteration draining, M10-09a production dispatcher wiring for bounded managed `daemon start`, and RC-5b configured daemon-default live-wrapper profile wiring that runs dispatched steps through real commands and feeds terminal executor evidence to the RC-2 reconciliation seam.
- Has M10-05 `goal-loop` executor adapter that drives bounded autonomous rounds below a step run, reusing the shared `step-finalize.ts` verify / commit / reset finalization seam and persisting per-round agent / model / input / result / verification / commit / artifact / checkpoint evidence.
- Has M10-06 `one-shot` / `script` executor adapters for bounded single-invocation work, including result-bearing one-shot success and exit-code / bounded-log script success.
- Has M10-07 no-mistakes executor mirror that records external no-mistakes run state, findings, decisions, PR / CI state, and completion below executor invocations / rounds.
- Has M10-08 durable workflow gates and the `workflow run decide` operator / delegated-policy path.
- Has M10-09a phase-1 workflow-lane dispatch effects: supported executor families create deterministic durable executor invocation / first-round start scaffolds with empty result evidence; unsupported or unresolvable claims fail closed to a manual-recovery gate when the run can carry one, and vanished-run claims release the orphaned dispatch lease without fabricating a gate. With a configured daemon-default live-wrapper profile, the bounded daemon lane now terminalizes those scaffolds from real wrapper results and reconciles the owning step in the same tick.
- Has `goal start`, `daemon`, workflow import / status / handoff controls, workflow run controls, and the RC-1 `workflow run logs` read-back surface.

Required workflow-first gaps:

| Area | Current Shape | Target Shape |
|---|---|---|
| Top-level entity | Goal-first; persisted WorkflowDefinition primitives; WorkflowRun mostly coding-workflow substrate | WorkflowDefinition / WorkflowRun as product core |
| Step configuration | Persisted StepDefinition list for definitions; run execution still fixed canonical step kinds | Configurable StepDefinition list |
| Executor selection | Executor definitions can be persisted; goal-loop / one-shot / script / no-mistakes adapters exist; phase-1 dispatcher resolves per-step executor family but still needs full per-step executor config wiring | Per-step executor definition and agent / model config |
| Daemon scheduling | Drains `goal_iteration` jobs; bounded managed `daemon start` also recovers, scans, claims, dispatches runnable approved workflow steps, and runs configured daemon-default live wrappers through terminal evidence reconciliation | Schedules workflow runs, step runs, executor invocations, and rounds |
| Loop state | Goal iteration artifacts / job rows, plus persisted executor invocations / rounds below workflow steps; phase-1 dispatcher creates deterministic start scaffolds with no fabricated evidence, and a configured daemon-default live-wrapper profile can fill those scaffolds with terminal executor evidence | ExecutorInvocation / ExecutorRound / checkpoints / artifacts driven by the workflow scheduler |
| Goal loop | Product-level Goal | `goal-loop` executor inside a workflow step |
| no-mistakes | External fixed pipeline with a landed Momentum mirror | Specialist executor mirrored into Momentum |
| Human gates | Durable gate records, approvals, recovery flags, and external TUI state | Durable gate records with allowed actions and evidence |
| Run start | `goal start` plus imported workflow controls plus `workflow run start` from definitions | Workflow-first run start connected to executor scheduling |
| Recovery | Goal-scoped and WorkflowRun-scoped surfaces | Unified workflow / step / executor recovery taxonomy |

## Non-Goals For This Planning Contract

This planning contract does not implement:

- Schema migrations.
- CLI commands.
- Daemon behavior changes.
- Linear issue remapping.
- External writes.
- Remote git operations.
- Public UI.
- Replacement of GNHF or no-mistakes internals.

M10 has implemented these as concrete slices: M10-01 landed definition schema / validation / persistence, M10-02 landed CLI run start, M10-03 landed executor state schema / persistence, M10-04 landed the opt-in daemon workflow scheduler lane, M10-05 landed the goal-loop executor adapter, M10-06 landed the one-shot / script executor adapters, M10-07 landed the no-mistakes executor mirror, M10-08 landed durable workflow gates and decisions, M10-09a landed phase-1 production dispatcher wiring, and M10-09 dogfooded the workflow-first start / approval / bounded dispatch path. Generalized `external-apply` / `subworkflow` dispatch and external runtime behavior remain later slices.
