# Contract: Workflow-First Gap Matrix

**Status:** Accepted active implementation bridge during M10, now closed with M10. M10-00 promoted this matrix into the workflow-first runtime milestone sequence; M10-01 landed the definition schema and persistence slice, M10-02 added workflow run start, M10-03 added executor-loop schema / persistence, M10-04 added the opt-in daemon workflow scheduler lane, M10-05 added the goal-loop executor adapter, M10-06 added the one-shot / script executor adapters, M10-07 added the no-mistakes executor mirror, M10-08 added durable workflow gates and the `workflow run decide` operator path, M10-09a wired the production workflow-lane dispatcher into bounded managed `daemon start`, and NGX-353 closed M10. It still does not authorize Linear remapping or milestone renumbering by itself.

This contract follows:

- [`internal/contracts/workflow-first-runtime.md`](workflow-first-runtime.md)
- [`internal/contracts/executor-loop.md`](executor-loop.md)

The purpose is to keep the M10 implementation concrete without pretending M9 already owns the generic workflow product.

## Decision

Momentum progressed from the Goal-first / imported-coding-workflow substrate into a Workflow-first runtime in Milestone 10 after M9 planning was reviewed.

M9 remains foundation work. It should not be renamed into the generic workflow runtime and it should not be forced to carry a changed product definition mid-stream.

The milestone split is:

```text
M9: Live Workflow Execution foundation
M10: Workflow-First Runtime
```

M10 is the first place for `WorkflowDefinition`, configurable `StepDefinition`, first-class workflow start, executor invocations, executor rounds, and daemon scheduling over workflow runs.

## Current Inventory

Current durable runtime surfaces:

- Goals and goal iterations.
- Daemon queue draining for goal iteration jobs.
- Repo locks and verification / commit transactions.
- M7 `WorkflowRun`, workflow step, approval, and lease substrate for imported OpenClaw coding workflows.
- M8 operator controls for workflow run list, approve, update-step, clear-recovery, and monitor.
- M9 live wrapper config, registry, execution, result capture, finalization, and recovery primitives for fixed canonical coding workflow step kinds.
- M10-01 `WorkflowDefinition` / `StepDefinition` validation, built-in coding workflow definition, and `workflow_definitions` / `step_definitions` persistence helpers.
- M10-02 `workflow run start` materialization from persisted or built-in definitions.
- M10-03 `ExecutorDefinition` / `ExecutorInvocation` / `ExecutorRound` persistence, with executor artifacts, checkpoints, findings, and decisions below rounds.
- M10-04 opt-in daemon workflow scheduler lane (`runWorkflowSchedulerOnce`) composing stale-lease recovery, runnable-step scan, atomic dispatch-lease claim, and an executor-dispatch seam, run each daemon cycle alongside goal iteration draining; M10-09a wires that seam into bounded managed `daemon start` with the production dispatcher.
- M10-05 `goal-loop` executor adapter (`runGoalLoopStep`) that drives bounded autonomous rounds below a step run, reusing the shared `step-finalize.ts` verify / commit / reset finalization seam and the M10-03 round persistence, with per-round agent / model / input / result / verification / commit / artifact / checkpoint evidence.
- M10-06 `one-shot` / `script` executor adapters for bounded single-invocation work, with normalized-result one-shot success and exit-code / bounded-log script success.
- M10-07 no-mistakes executor mirror that records external no-mistakes run state, findings, decisions, PR / CI state, and completion under executor invocations / rounds without reimplementing the no-mistakes pipeline.
- Evidence records with typed workflow linkage.
- Source-item and external-apply contracts.

Current product surface:

- `goal start`
- `goal status`
- `goal logs`
- `goal handoff`
- `daemon start`
- `daemon stop`
- `daemon status`
- `workflow import`
- `workflow status`
- `workflow handoff`
- `workflow run start`
- `workflow run approve`
- `workflow run list`
- `workflow run update-step`
- `workflow run clear-recovery`
- `workflow run monitor`
- `workflow run logs`

Current limitation:

```text
WorkflowRun is durable and can start from definitions, executor records now persist below step runs, the daemon can recover, scan, and claim runnable workflow steps through an opt-in scheduler lane, the goal-loop executor adapter drives bounded autonomous rounds below a step run, the one-shot / script adapters drive bounded single-invocation work, and the no-mistakes executor mirror records external review state into executor rounds. M10-08 attached durable workflow gates and the `workflow run decide` operator path, M10-09a wired the production workflow-lane dispatcher into bounded managed `daemon start`, and NGX-353 dogfooded the workflow-first start / approval / bounded dispatch path through real Momentum state. RC-5b later wired configured daemon-default live-wrapper profiles into that bounded daemon lane so dispatched steps can produce terminal executor evidence and reconcile through RC-2, RC-3 later added daemon-dispatchable `external-apply` through the same terminal-evidence reconciliation lane, and RC-4 later added the `subworkflow` child-run mirror mechanism while leaving the production family fail-closed pending a separate PHASE1 flip.
```

## Target Inventory

Workflow-first runtime target:

- `WorkflowDefinition` is a reusable recipe.
- `StepDefinition` is a configured step inside that recipe.
- `WorkflowRun` is one execution of a workflow definition.
- `StepRun` is the durable execution state for one step in one run.
- `ExecutorDefinition` chooses an executor family and policy.
- `ExecutorInvocation` is one configured executor session under a step run.
- `ExecutorRound` is one bounded unit of autonomous work or one long-lived external mirror lane.
- The daemon schedules workflow runs, step runs, invocations, and rounds.
- Human gates are durable workflow / step / executor records with allowed actions.

Future product surface:

- `workflow definition list`
- `workflow definition show`
- `workflow definition validate`
- `workflow run start`
- `workflow run status`
- `workflow run logs`
- `workflow run handoff`
- `workflow run approve`
- `workflow run decide`
- `workflow run recover`
- `workflow run cancel`
- `workflow run monitor`

`goal start` becomes a compatibility surface or a shorthand for a workflow whose implementation step uses the `goal-loop` executor.

## Gap Matrix

| Area | Current Shape | Target Shape | Migration Direction |
|---|---|---|---|
| Product root | Goal-first execution plus imported workflow runs | WorkflowDefinition / WorkflowRun | Introduce workflow definitions before deprecating goal-first UX |
| Run start | `goal start`; `workflow import` for external plans; persisted workflow definitions; `workflow run start` materialization with executor records, scheduler-lane eligibility, gates, phase-1 daemon dispatch scaffolds, NGX-353 dogfood evidence, RC-3 external-apply daemon dispatch evidence, and RC-4 child-run mirror proof | `workflow run start` connected to execution scheduling | Keep the first-class start command as the workflow-first entry point; production `subworkflow` attachment still waits on the PHASE1 allowlist flip and child-definition config decision |
| Step model | Fixed coding workflow step kinds | Configurable StepDefinition list | Keep canonical coding workflow as one built-in definition |
| Executor model | Runner profiles, M9 wrapper registry, and landed goal-loop / one-shot / script adapter modules plus the no-mistakes mirror | Per-step ExecutorDefinition and executor config | Wire persisted executor config into dispatch while reusing wrapper config as executor config input |
| Loop state | Goal iteration jobs/artifacts; external GNHF/no-mistakes state | ExecutorInvocation / ExecutorRound records | Goal-loop adapter landed (M10-05), one-shot / script adapters landed (M10-06), and no-mistakes mirror landed (M10-07): bounded rounds and mirrored external state persist common loop evidence in Momentum SQLite |
| Daemon scheduling | Drains goal iteration queue; opt-in lane recovers/scans/claims runnable workflow steps, including rechecks for an active deferred `subworkflow` dispatch | Schedules workflow runs and step runs | Scheduler lane landed (M10-04); goal-loop and one-shot / script adapters now drive bounded rounds below StepRun, and no-mistakes now mirrors external state into one long-lived round; M10-09a wired the production dispatcher into bounded managed `daemon start`, NGX-353 proved the shipped daemon path dispatches approved steps without monitor drift, RC-5b later wired configured daemon-default live-wrapper profiles so the daemon can produce terminal executor evidence through RC-2, RC-3 later wired `external-apply` through the same daemon dispatch/reconcile lane, and RC-4 later added active `subworkflow` child-run rechecks for the landed adapter mechanism |
| Repo safety | Repo locks plus verification / commit transactions | Same safety around executor finalization | Reuse the shared `step-finalize.ts` seam (extracted from M9) and repo-lock heartbeats |
| Approvals | M8 workflow approvals for imported runs | Workflow / step / gate approvals | Keep M8 rows; generalize boundary vocabulary |
| Human gates | Split across approval rows, recovery flag, external TUI/IPC | Durable gates with allowed actions and decisions | Gate records and `workflow run decide` landed (M10-08): durable `workflow_gates` with allowed actions / policy envelope and operator + delegated-policy decisions, surfaced in status / handoff / monitor and reattached by `workflow run logs`; daemon-side gate emission during live execution remains later runtime work |
| Recovery | Goal recovery plus workflow run recovery | Workflow / step / executor recovery taxonomy | Reuse M8/M9 codes, add executor-level recovery records |
| no-mistakes | External daemon pipeline with a landed Momentum mirror | Specialist executor mirrored into Momentum | Keep the mirror boundary: classify external evidence without reimplementing the pipeline |
| GNHF | External/in-process implementation loop | `goal-loop` executor behavior | Copy bounded round pattern, not state store |
| Evidence | Evidence records with optional run/step linkage | Evidence linked to run, step, invocation, and round | Add invocation/round evidence pointers |
| External writes | M6 external-apply | `external-apply` executor | Keep existing safety contract |
| Subworkflows | RC-4 child-run mirror mechanism: pure mapping, async producer, daemon-lane factory, active recheck scheduling, and child-run integration proof; production family still fail-closed | `subworkflow` executor | Keep production dispatch deferred until the PHASE1 allowlist flip and child-definition config decision land |

## What Survives

The following M7 / M8 / M9 primitives should survive into the workflow-first runtime:

- Workflow run state vocabulary where still applicable.
- Approval boundary persistence.
- Lease freshness and stale classification.
- Monitor envelope shape and recovery classifications.
- Run-scoped recovery artifact pattern.
- Live wrapper explicit argv/env/cwd/result-file discipline.
- Bounded logs and normalized result capture.
- Repo lock heartbeat through verification, commit, reset, and recovery.
- Finalization recovery codes such as `head_mismatch`, `result_missing`, `result_invalid`, `reset_failed`, `repo_lock_lost`, `git_failed`, and `commit_failed`.

## What Changes

The following current shapes should change:

- Goal is no longer the product root.
- Goal loop becomes an executor family.
- Fixed canonical step kinds become one built-in workflow definition, not the whole workflow model.
- External executor state becomes mirrored evidence, not Momentum's authoritative workflow state.
- Workflow run start becomes first-class rather than piggybacking on `goal start`.
- Operator decisions move into durable gates instead of ad hoc prompts, TUI-only state, or chat-only approvals.

## Recommended Implementation Slices

The M10 slice order:

1. **M10-00 Workflow-first contract and milestone setup**: promote these planning contracts into an implementation milestone and pin issue order.
2. **M10-01 WorkflowDefinition and StepDefinition schema**: add definitions, validation, durable `workflow_definitions` / `step_definitions` persistence, and the built-in coding workflow definition.
3. **M10-02 Workflow run start**: create runs from definitions with approval boundaries and repo policy.
4. **M10-03 ExecutorDefinition / Invocation / Round schema**: persist executor loop state under step runs. *(done)*
5. **M10-04 Daemon workflow scheduler lane**: schedule runnable workflow runs and step runs without breaking goal iteration draining. *(done)*
6. **M10-05 Goal-loop executor adapter**: migrate existing goal iteration behavior into executor rounds. *(done)*
7. **M10-06 One-shot / script executor adapter**: support deterministic commands and bounded agent/script invocations. *(done)*
8. **M10-07 no-mistakes executor mirror**: mirror no-mistakes runs, findings, decisions, PR/CI state, and completion into Momentum. *(done)*
9. **M10-08 Workflow gates and decisions CLI**: add durable operator decisions and delegated policy application. *(done)*
10. **M10-09 Workflow-first dogfood and closeout**: run a real Momentum task through the workflow-first start surface and close the milestone. **M10-09a (NGX-367)** is the prep/repair slice that wires the production workflow-lane dispatcher into bounded managed `daemon start` before that dogfood; see "M10-09a Production Workflow-Lane Dispatcher Boundary" below. *(done)*

This order is deliberately contract -> schema -> start -> executor state -> scheduler -> adapters -> gates -> dogfood.

## M10-09a Production Workflow-Lane Dispatcher Boundary

`NGX-367 / M10-09a` is the small phase-1 prep/repair slice taken before the
`NGX-353 / M10-09` workflow-first dogfood and closeout. Readiness review found
one blocker: the built CLI already had `workflow run start`, executor / gate
schema, and `runWorkflowSchedulerOnce`, but shipped `daemon start` never passed a
production `workflowLane` into `runDaemonLoop`. The daemon workflow lane was
test-injected only, so a real `workflow run start` could be durable yet never
dispatch through the shipped daemon path. M10-09a wires that harness and proves
it; it does not run the actual dogfood or flip the milestone marker.

### What M10-09a landed

- **A dedicated production dispatcher**, not dispatch logic buried in
  `src/cli.ts`. Three modules mirror the established
  brain -> read-only-resolution -> durable-effect slicing: `planWorkflowStepDispatch`
  (`src/core/workflow/dispatch.ts`, the pure total decision over a resolved family),
  `resolveWorkflowStepDispatchPlan` (`src/core/workflow/dispatch-persist.ts`, the
  read-only run -> definition-link -> step-definition -> executor-family
  resolution), and `executeWorkflowStepDispatch`
  (`src/core/workflow/dispatch-execute.ts`, the durable effect twin shaped to the
  scheduler's `WorkflowStepDispatch` seam).
- **A phase-1 dispatchable executor-family allowlist** — at M10-09a, exactly the
  families with a landed bounded adapter: `goal-loop` (M10-05), `one-shot` /
  `script` (M10-06), and `no-mistakes` (M10-07). RC-3 later widened this set to
  include `external-apply` through the M6-safety-gated daemon adapter; RC-4 later
  landed the `subworkflow` adapter mechanism, but `subworkflow` (recurses into
  another run) remains intentionally excluded from the production allowlist until
  its child-definition config decision and PHASE1 dispatch-lane flip land, so it
  fails closed rather than silently no-op.
- **Bounded managed `daemon start` now supplies a production `workflowLane` to
  `runDaemonLoop`**, so the shipped `daemon start --max-*` path claims and
  dispatches approved workflow steps with no test-only dependency injection.
  Register-only `daemon start` (no loop bound) is unchanged: it records a daemon
  run and exits before the scheduler, leaving the workflow lane inert. Goal
  iteration draining is unchanged; with no runnable workflow step the lane
  returns `idle` and performs zero writes, so goal-only daemon behavior and its
  JSON shape stay compatible.
- **Durable dispatch effects through the production path.** On a dispatchable
  family the dispatcher atomically advances the step `approved -> running` and
  creates the `executor_invocations` plus first `executor_rounds` start scaffold,
  observable by `workflow status`, `workflow handoff`, `workflow run monitor`,
  and `workflow run logs` from durable rows after the daemon process exits. The scaffold ids are
  deterministic (`<run>::<step>::dispatch` and `::round-1`) and carry no result
  evidence until a later adapter fills them. The loop summary surfaces
  `workflowStepsDispatched`, `lastWorkflowCode`, and cycle-level `workflowResult`
  evidence already modeled in `runDaemonLoop`.
- **Fail-closed lease safety.** An unresolvable, under-configured, or
  unsupported-family step never silently no-ops after a claim. The dispatcher
  flags `needs_manual_recovery`, opens a step-scoped operator-visible
  `manual_recovery_required` `workflow_gates` row when the run row still exists,
  and releases the dispatch lease. If the run row vanished between claim and
  dispatch, no recovery flag or gate can be written without orphaning evidence,
  so the dispatcher only releases the lingering lease. On a successful
  in-progress dispatch the dispatcher instead holds the lease (the work is now
  owned, not terminal); if the dispatch callback throws before taking ownership,
  `runWorkflowSchedulerOnce` auto-releases the lease so none is stranded and a
  later tick can recover. Every effect path is
  `BEGIN IMMEDIATE` / rollback-wrapped so no half-dispatched state survives a
  throw, and dispatch is idempotent on a deterministic invocation id.

### NGX-353 closeout dogfood result

M10-09a deliberately stopped at the dispatch harness. The `NGX-353 / M10-09`
closeout dogfood then ran the real `ngx353-m10-closeout` workflow through
Momentum-owned state:

- `workflow run start --definition coding-workflow --issue-scope NGX-353`
- `workflow run approve --approval-boundary through-implementation`
- `daemon start --max-loop-iterations 1 --poll-interval-ms 0`
- `workflow run monitor`

The dogfood reached the intended M10 phase-1 boundary: `preflight` running,
`implementation` approved, executor invocation / round scaffold rows persisted,
and `monitorDrift.drifted = false` after the closeout bug fix that refreshes
the parent `workflow_runs` state plus monitor advisory columns during dispatch.
The regression matrix records that invariant, and the `doctor --json` marker
reported the M10 closeout string until the later M11 closeout advanced the
current marker again.

Remaining runtime work after M10 originally included driving scaffolded rounds
through real adapter mechanisms as the default production loop; RC-5b later
landed that path for configured daemon-default live-wrapper profiles, RC-3 later
landed `external-apply` dispatch through the M6-safety-gated daemon adapter, and
RC-4 later landed the `subworkflow` adapter mechanism. The remaining
`subworkflow` production decision is narrower: the family stays fail-closed until
the PHASE1 allowlist flip and child-definition config decision land.

## Risks

The main risks:

- Overfitting M10 to the existing OpenClaw coding workflow instead of making definitions genuinely configurable.
- Rebuilding no-mistakes too early instead of wrapping it.
- Letting executor recommendations become authoritative instead of daemon-classified.
- Flattening every loop iteration into top-level workflow steps and making workflows unreadable.
- Losing repo safety while moving finalization from goal iterations into executor rounds.
- Attaching execution scheduling before executor records, approval / repo policy, and start semantics are wired together.

## Non-Goals

This gap matrix does not implement:

- Migrations.
- CLI commands.
- Daemon behavior.
- Linear changes.
- Remote git operations.
- Public UI.
- Replacement of external engine internals.

It is the implementation bridge between the accepted workflow-first pivot, the landed M10-01 definition persistence, M10-02 run start, M10-03 executor-record, M10-04 scheduler-lane, M10-05 goal-loop-adapter, M10-06 one-shot / script adapter, M10-07 no-mistakes mirror, M10-08 workflow-gates / decide, M10-09a production-dispatcher-wiring, and M10-09 closeout dogfood slices. RC-3 has since landed generalized `external-apply` dispatch; RC-4 has since landed the `subworkflow` adapter mechanism while leaving production `subworkflow` dispatch fail-closed until the separate PHASE1 flip.
