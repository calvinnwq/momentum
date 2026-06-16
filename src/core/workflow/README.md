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
| Run lifecycle | `run-start.ts`, `run-start-persist.ts`, `run-import.ts`, `run-import-persist.ts`, `run-reducer.ts`, `run-recovery.ts`, `status.ts` |
| Steps | `step-executor.ts`, `step-transitions.ts` |
| Gates | `gate.ts`, `gate-persist.ts` |
| Leases | `leases.ts` |
| Scheduling | `scheduler.ts` |
| Dispatch | `dispatch.ts`, `dispatch-persist.ts`, `dispatch-execute.ts`, `dogfood-dispatch.ts` |
| Recovery & monitor | `recovery-artifact.ts`, `recovery-reconcile.ts`, `monitor-state.ts`, `monitor-envelope.ts` |
| Handoff | `handoff.ts` |

`dispatch.ts` and `dispatch-persist.ts` are internal helpers behind
`dispatch-execute.ts`; `run-reducer.ts` is the central pure reducer and the most
widely consumed entry point.

## Public interface for other domains

Other domains reach workflow behavior through these modules:

- **CLI command family** (`src/commands/workflow/`): `definition` /
  `definition-persist`, `gate` / `gate-persist`, `run-start` /
  `run-start-persist`, `run-import` / `run-import-persist`, `run-recovery`,
  `run-reducer`, `status`, `monitor-state` / `monitor-envelope`,
  `recovery-reconcile`, `handoff`.
- **CLI renderers** (`src/renderers/workflow.ts`): the same run/gate/monitor/
  status/handoff shapes, imported **type-only** (renderers format, they do not
  mutate state).
- **Top-level dispatch** (`src/cli.ts`): `dispatch-execute`, `dogfood-dispatch`.
- **Executor / live-step / daemon runtime**: `run-reducer` (shared run-state
  reduction), `step-executor`, `step-transitions`, `leases`, `definition`,
  `recovery-artifact`, `scheduler`.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`
  (enforced by `test/cli-import-boundaries.test.ts`).
- Renderers may import from this folder only with `import type`.

## Deferred

A single curated module seam (barrel) and any consolidation of the
finalization / status / recovery coordination is intentionally **not** part of
the mechanical regrouping. That seam-deepening is owned by the workflow runtime
deepening slice (ARCH-08); until then, importers keep direct typed module paths.
