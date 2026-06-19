# core/executors

Executor runtime domain. This folder owns the runtime execution *mechanisms*:
the executor-loop reducer/persistence and the goal-loop, single-shot, live-step,
and no-mistakes executor families plus their runner-profile, foreground
iteration, and runner-smoke support. It holds business/runtime behavior only —
reducers, state machines, persistence policies, and execution decisions. It does
not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-04) with no behavior change. Only the two executor-loop files were renamed
(`executor-loop-{reducer,persist}.ts` → `loop-{reducer,persist}.ts`); every other
module kept its name. Command, renderer, and adapter seams were left in place;
importers still reference the concrete modules below.

## Local structure

| Concern | Modules |
| --- | --- |
| Executor loop (M10) | `loop-reducer.ts`, `loop-persist.ts` |
| Goal-loop executor | `goal-loop-executor.ts`, `goal-loop-mechanism.ts`, `goal-loop-orchestrator.ts` |
| Single-shot executor | `single-shot-executor.ts`, `single-shot-mechanism.ts`, `single-shot-orchestrator.ts` |
| Live-step executor (M9) | `live-step-executor.ts`, `live-step-advance.ts`, `live-step-orchestrator.ts`, `live-step-finalize.ts`, `live-step-run-recovery.ts` |
| No-mistakes mechanism | `no-mistakes-mechanism.ts` |
| Runner support | `runner-profile.ts` |
| Foreground iteration | `foreground-iteration.ts` |
| Runner smoke | `real-smoke.ts`, `real-workflow-smoke.ts` |
| Runner result shapes & parsing | `types.ts`, `runner-result.ts` |

`loop-reducer.ts` is the central pure reducer and the most widely consumed entry
point; `loop-persist.ts` wraps it with persistence. The goal-loop and single-shot
families build on `loop-reducer` / `loop-persist`.

### M9 / M10 separation

`live-step-finalize.ts` is consumed both by the M9 live-step path
(`live-step-advance` / `live-step-run-recovery`) and by the M10 executor-loop
families (goal-loop and single-shot). The two paths intentionally stay separate
modules: the M9 direct-finalize path is **not** collapsed into the M10
executor-loop path. Any unification is reconciliation work owned by a later slice
(now landed as RC-2 / NGX-480: `dispatch-reconcile.ts` /
`dispatch-reconcile-execute.ts`), not by this mechanical regrouping.

## Ownership boundary with adapters

`no-mistakes-mechanism.ts` is the runtime decision logic and lives here in core.
The no-mistakes *external integration* — `src/adapters/no-mistakes-executor.ts`
and `src/adapters/no-mistakes-orchestrator.ts` — stays under `src/adapters/`
because it drives the external no-mistakes tool. The
`test/cli-import-boundaries.test.ts` adapter-ownership list pins that split.

Known reverse dependencies (adapter → core runtime), preserved unchanged because
ARCH-04 is a mechanical move with no adapter rewrite:

- `src/adapters/no-mistakes-executor.ts` and `no-mistakes-orchestrator.ts` import
  `loop-reducer` / `loop-persist`.
- `src/adapters/runner-adapter.ts` imports `runner-profile`.
- `src/adapters/real-workflow-probe.ts` imports `real-workflow-smoke`.
- `src/adapters/acp-runner.ts`, `trusted-shell-runner.ts`, and
  `live-step-wrapper.ts` import the `parseRunnerResult` parser from
  `runner-result`; the `RunnerResult` shapes they also consume are type-only
  imports from `types.ts`. This runtime edge moved from the former root
  `src/runner-result.ts` under ARCH-06 / NGX-450.

These edges predate ARCH-04 (and, for the runner-result parser, ARCH-06).
Tightening them (so adapters depend on core types only) is deferred; it would
require an interface decision that the mechanical ARCH slices explicitly decline
to make.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`
  (enforced by `test/cli-import-boundaries.test.ts`).
- No renderer imports these modules.

## Deferred

- Exported executor types stay beside their behavior in their owning module. The
  shared runner-result shapes now live at `src/core/executors/types.ts`
  (`COMMIT_TYPES`, `CommitType`, `CommitIntent`, `RunnerResult`, and the
  `RunnerResult{Error,Success,Parse}` envelopes), with their parser
  (`parseRunnerResult` / `normalizeRunnerResult` / `normalizeCommitIntent`) in
  `src/core/executors/runner-result.ts`. Both were drained from the former root
  `src/runner-result.ts` under the type-placement slice (ARCH-06 / NGX-450).
  `COMMIT_TYPES` is a runtime const, but it backs the `CommitType` union and has
  no behavior, so it is colocated with the type it defines.
- No executor barrel/seam consolidation and no finalizer/reconciliation redesign.
  ARCH-08 only added the workflow-owned `runtime-state.ts` refresh seam after
  caller-owned durable mutations; the cross-path finalization owner has since landed
  as RC-2 (NGX-480: `dispatch-reconcile.ts` /
  `dispatch-reconcile-execute.ts`). Importers keep direct typed module paths.
