# core/workflow

Workflow runtime domain. This folder owns the durable workflow runtime:
definitions, run lifecycle, steps, gates, leases, scheduling, dispatch planning,
recovery, monitor state, and workflow handoff. It holds business/runtime
behavior only — reducers, state machines, persistence policies, and runtime
decisions. It does not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/workflow-*.ts` root
siblings (ARCH-03) with no behavior change. Command and renderer seams were left
in place; importers still reference the concrete modules below.

## Local structure

| Concern | Modules |
| --- | --- |
| Definition | `definition.ts`, `definition-persist.ts` |
| Run lifecycle | `run-start.ts`, `run-start-persist.ts`, `run-import.ts`, `run-import-persist.ts`, `run-reducer.ts`, `run-recovery.ts`, `status.ts`, `logs.ts` |
| Runtime state refresh | `runtime-state.ts` |
| Steps | `step-executor.ts`, `step-executor-real-adapters.ts`, `step-transitions.ts` |
| Gates | `gate.ts`, `gate-persist.ts` |
| Leases | `leases.ts` |
| Scheduling | `scheduler.ts` |
| Dispatch | `dispatch.ts`, `dispatch-persist.ts`, `dispatch-execute.ts`, `dispatch-executor-run.ts`, `dispatch-executor-terminalize.ts`, `dispatch-reconcile.ts`, `dispatch-reconcile-execute.ts`, `daemon-live-wrapper-profile.ts`, `daemon-dispatch-exec-context.ts`, `live-wrapper-dispatch.ts`, `dogfood-dispatch.ts` |
| Recovery & monitor | `recovery-artifact.ts`, `recovery-reconcile.ts`, `monitor-state.ts`, `monitor-envelope.ts` |
| Handoff | `handoff.ts` |

`dispatch.ts` and `dispatch-persist.ts` are internal helpers behind
`dispatch-execute.ts`; `run-reducer.ts` is the central pure reducer and the most
widely consumed entry point. `runtime-state.ts` is the ARCH-08 seam for callers
that already changed durable step / lease rows and need to re-read reducer rows,
derive monitor state, and refresh the cached `workflow_runs` status / monitor
advisory columns without duplicating SQL.

## Public interface for other domains

Other domains reach workflow behavior through these modules:

- **CLI command family** (`src/commands/workflow/`): `definition` /
  `definition-persist`, `gate` / `gate-persist`, `run-start` /
  `run-start-persist`, `run-import` / `run-import-persist`, `run-recovery`,
  `run-reducer`, `status`, `monitor-state` / `monitor-envelope`,
  `runtime-state`, `recovery-reconcile`, `handoff`, `logs`.
- **CLI renderers** (`src/renderers/workflow.ts`): the same run/gate/monitor/
  status/handoff/logs shapes, imported **type-only** (renderers format, they
  do not mutate state).
- **Top-level dispatch** (`src/cli.ts`): `dispatch-execute`, `dogfood-dispatch`.
- **Dispatched-step reconciliation**: `dispatch-reconcile` /
  `dispatch-reconcile-execute` own the RC-2 pure/effect seam that finalizes a
  dispatched step from terminal executor evidence.
- **Executor / live-step / daemon runtime**: `run-reducer` (shared run-state
  reduction), `runtime-state` (cached run-state / monitor refresh after a
  caller-owned mutation), `step-executor` (registry/dispatch boundary),
  `step-executor-real-adapters` (RC-5 production registry builder backed by
  live wrappers or honest `runtime_unavailable` adapters), `step-transitions`,
  `leases`, `definition`, `recovery-artifact`, `scheduler`.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`
  (enforced by `test/cli-import-boundaries.test.ts`).
- Renderers may import from this folder only with `import type`.

## Deferred

A single curated module seam (barrel) is intentionally **not** part of ARCH-08;
importers keep direct typed module paths. ARCH-08 only introduces the
`runtime-state.ts` seam around the mechanical finalization / status / monitor
refresh shared by dispatch, reconciliation, dogfood terminalization, and operator/recovery
callers. It does **not** choose the RC-2 reconciliation seam (that landed separately
as NGX-480: `dispatch-reconcile.ts` / `dispatch-reconcile-execute.ts`), delete
the dogfood stand-in, or narrow M9/M10 compatibility paths.

RC-5 fake demotion has since landed in this folder: the production
`WorkflowStepExecutor` default no longer fabricates fake successes, while the
deterministic fake registry lives under `test/helpers/` and is injected only by
tests that need substrate smoke coverage.

RC-5b (NGX-492) has since added the dispatched-step execution path producer:
`dispatch-executor-terminalize.ts` records a finished
`WorkflowStepExecutorDispatchResult` as terminal scaffold evidence, and
`dispatch-executor-run.ts` composes "run the dispatched step's executor (through
an injected real registry) → terminalize → RC-2 reconcile" so a configured
profile finalizes the step exactly once and an unconfigured profile parks the run
for manual recovery instead of fabricating success. `daemon-live-wrapper-profile.ts`
has since added the daemon-default profile **source resolution**: a pure resolver
that turns the `MOMENTUM_LIVE_WRAPPER_PROFILE` env var (a JSON profile file path)
into an absent profile (unchanged default lane), a parsed `LiveWrapperProfile` the
lane can build a real registry from, or an honest invalid outcome — never a
silently fabricated profile. `live-wrapper-dispatch.ts` then composes the base
dispatch with that producer into a `WorkflowStepDispatch`
(`createLiveWrapperWorkflowDispatch`): the production analogue of the dogfood
`createTerminalizingWorkflowDispatch`, it starts the scaffold via the base dispatch
and — only for a genuinely-started dispatch — runs the executor + RC-2 reconcile in
the same tick, taking the registry and the per-step exec-context deriver by
injection and leaving RC-2 the single finalization owner.
`daemon-dispatch-exec-context.ts` has since added that per-step exec-context
**deriver**: a pure resolver (plus its injected run-row loader) that maps a run's
provenance to the bounded session's working directory — a native run runs under
`<repoPath>/.agent-workflows/<runId>/` and an imported run under its source
artifact's run dir — and refuses honestly with `missing_repo_path` (rather than
fabricating a working directory) when the run has no repo, so the lane can fail
closed into manual recovery. `live-wrapper-dispatch.ts` now consumes that refusal
safely: its deriver injection returns a total
`DispatchedStepExecutorContextResolution`, and an `ok: false` resolution is routed
to manual recovery (`recordUnresolvedDispatchedStepContext` in
`dispatch-executor-run.ts`, which terminalizes the same honest
`manual_recovery_required` evidence an unconfigured executor produces and lets RC-2
park the run) instead of throwing — a throw inside the dispatch closure, after the
scaffold exists, would release the lease over a still-`running` step and strand it.
The bounded `daemon start` workflow lane now wires the resolved profile,
registry, and deriver by composing `live-wrapper-dispatch.ts` around the base
workflow dispatcher for configured daemon-default profiles.
