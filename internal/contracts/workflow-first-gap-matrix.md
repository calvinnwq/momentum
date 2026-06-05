# Contract: Workflow-First Gap Matrix

**Status:** Accepted implementation bridge. M10-00 promoted this matrix into the workflow-first runtime milestone sequence; M10-01 has landed the definition schema and persistence slice, M10-02 adds workflow run start, M10-03 adds executor-loop schema / persistence, M10-04 adds the opt-in daemon workflow scheduler lane, M10-05 adds the goal-loop executor adapter, M10-06 adds the one-shot / script executor adapters, and M10-07 adds the no-mistakes executor mirror. It still does not authorize Linear remapping or milestone renumbering by itself.

This contract follows:

- [`internal/contracts/workflow-first-runtime.md`](workflow-first-runtime.md)
- [`internal/contracts/executor-loop.md`](executor-loop.md)

The purpose is to keep the active M10 implementation concrete without pretending M9 already owns the generic workflow product.

## Decision

Momentum is progressing from the current Goal-first / imported-coding-workflow substrate into a Workflow-first runtime in Milestone 10 after M9 planning was reviewed.

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
- M10-04 opt-in daemon workflow scheduler lane (`runWorkflowSchedulerOnce`) composing stale-lease recovery, runnable-step scan, atomic dispatch-lease claim, and an executor-dispatch seam, run each daemon cycle alongside goal iteration draining.
- M10-05 `goal-loop` executor adapter (`runGoalLoopStep`) that drives bounded autonomous rounds below a step run, reusing the M9 verify / commit / reset finalization and the M10-03 round persistence, with per-round agent / model / input / result / verification / commit / artifact / checkpoint evidence.
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

Current limitation:

```text
WorkflowRun is durable and can start from definitions, executor records now persist below step runs, the daemon can recover, scan, and claim runnable workflow steps through an opt-in scheduler lane, the goal-loop executor adapter drives bounded autonomous rounds below a step run, the one-shot / script adapters drive bounded single-invocation work, and the no-mistakes executor mirror records external review state into executor rounds. Later slices still attach gates and remaining runtime behavior that fulfil the dispatch seam.
```

## Target Inventory

Workflow-first runtime target:

- `WorkflowDefinition` is a reusable recipe.
- `StepDefinition` is a configured step inside that recipe.
- `WorkflowRun` is one execution of a workflow definition.
- `StepRun` is the durable execution state for one step in one run.
- `ExecutorDefinition` chooses an executor family and policy.
- `ExecutorInvocation` is one configured executor session under a step run.
- `ExecutorRound` is one bounded unit of autonomous or external work.
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
| Run start | `goal start`; `workflow import` for external plans; persisted workflow definitions; `workflow run start` materialization with executor records and scheduler-lane eligibility | `workflow run start` connected to execution scheduling | Keep the first-class start command as the workflow-first entry point; remaining attachments are gates and later runtime / dispatch behavior |
| Step model | Fixed coding workflow step kinds | Configurable StepDefinition list | Keep canonical coding workflow as one built-in definition |
| Executor model | Runner profiles, M9 wrapper registry, and landed goal-loop / one-shot / script adapter modules | Per-step ExecutorDefinition and executor config | Wire persisted executor config into dispatch while reusing wrapper config as executor config input |
| Loop state | Goal iteration jobs/artifacts; external GNHF/no-mistakes state | ExecutorInvocation / ExecutorRound records | Goal-loop adapter landed (M10-05), one-shot / script adapters landed (M10-06), and no-mistakes mirror landed (M10-07): bounded rounds and mirrored external state persist common loop evidence in Momentum SQLite |
| Daemon scheduling | Drains goal iteration queue; opt-in lane recovers/scans/claims runnable workflow steps | Schedules workflow runs and step runs | Scheduler lane landed (M10-04); goal-loop and one-shot / script adapters now drive and persist bounded rounds below StepRun, while direct dispatcher wiring remains later runtime work |
| Repo safety | Repo locks plus verification / commit transactions | Same safety around executor finalization | Reuse M9 finalization and repo-lock heartbeats |
| Approvals | M8 workflow approvals for imported runs | Workflow / step / gate approvals | Keep M8 rows; generalize boundary vocabulary |
| Human gates | Split across approval rows, recovery flag, external TUI/IPC | Durable gates with allowed actions and decisions | Add gate records and `workflow run decide` |
| Recovery | Goal recovery plus workflow run recovery | Workflow / step / executor recovery taxonomy | Reuse M8/M9 codes, add executor-level recovery records |
| no-mistakes | External daemon pipeline with a landed Momentum mirror | Specialist executor mirrored into Momentum | Keep the mirror boundary: classify external evidence without reimplementing the pipeline |
| GNHF | External/in-process implementation loop | `goal-loop` executor behavior | Copy bounded round pattern, not state store |
| Evidence | Evidence records with optional run/step linkage | Evidence linked to run, step, invocation, and round | Add invocation/round evidence pointers |
| External writes | M6 external-apply | `external-apply` executor | Keep existing safety contract |
| Subworkflows | Not present | `subworkflow` executor | Defer until first-class workflow start is stable |

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
8. **M10-07 no-mistakes executor mirror**: mirror no-mistakes runs, findings, decisions, PR/CI state, and completion into Momentum. *(landed in this slice)*
9. **M10-08 Workflow gates and decisions CLI**: add durable operator decisions and delegated policy application.
10. **M10-09 Workflow-first dogfood and closeout**: run a real Momentum task through the workflow-first start surface and close the milestone.

This order is deliberately contract -> schema -> start -> executor state -> scheduler -> adapters -> gates -> dogfood.

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

It is the active implementation bridge between the accepted workflow-first pivot, the landed M10-01 definition persistence, M10-02 run start, M10-03 executor-record, M10-04 scheduler-lane, M10-05 goal-loop-adapter, M10-06 one-shot / script adapter, and M10-07 no-mistakes mirror slices, and the remaining workflow-first runtime slices.
