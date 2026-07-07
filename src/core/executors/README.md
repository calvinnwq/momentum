# core/executors

Executor runtime domain. This folder owns the runtime execution *mechanisms*:
the executor-loop reducer/persistence and the goal-loop, single-shot, live-step,
and no-mistakes executor families plus their runner-profile, foreground
iteration, and runner-smoke support. It holds business/runtime behavior only —
reducers, state machines, persistence policies, and execution decisions. It does
not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-04) and later split into family folders with no behavior change. Filename
prefixes are dropped inside each folder. Command, renderer, and adapter seams
were left in place; importers still reference the concrete modules below.

## Local structure

| Concern | Modules |
| --- | --- |
| Executor loop (M10) | `loop/reducer.ts`, `loop/persist.ts` |
| Goal-loop executor | `goal-loop/executor.ts`, `goal-loop/mechanism.ts`, `goal-loop/orchestrator.ts`, `goal-loop/prompt.ts` |
| Single-shot executor | `single-shot/executor.ts`, `single-shot/mechanism.ts`, `single-shot/orchestrator.ts` |
| Live-step executor (M9) | `live-step/executor.ts`, `live-step/advance.ts`, `live-step/orchestrator.ts`, `live-step/run-recovery.ts`, `live-step/finalize.ts` |
| Shared step finalization | `shared/step-finalize.ts` (neutral verify -> commit / reset seam) |
| No-mistakes mechanism | `no-mistakes/mechanism.ts` |
| Runner support | `runner/profile.ts` |
| Foreground iteration | `goal-iteration/foreground.ts` |
| Runner smoke | `smoke/linear-read.ts`, `smoke/workflow-harness.ts` |
| Runner result shapes & parsing | `runner/types.ts`, `runner/result.ts` |

`loop/reducer.ts` is the central pure reducer and the most widely consumed entry
point; `loop/persist.ts` wraps it with persistence. The goal-loop and single-shot
families build on `loop/reducer` / `loop/persist`.
The native `goal-loop` family renders deterministic per-round prompts through `goal-loop/prompt.ts`, then treats runner-authored `RunnerResult` JSON as input to finalization only.
The prompted-result bridge clears stale result files before handing the prompt and configured result path to the runner, so an old result cannot be finalized as new progress.
After finalization, its authoritative evidence is the `executor_invocations` / `executor_rounds` tree plus child artifacts, checkpoints, findings, and decisions that `workflow run logs` reads today.
The concrete goal-loop mechanism writes `commit_or_reset_evidence` as a digested finalization sidecar at `<verification-log>.finalization.json` when the verification log path is a usable absolute path.
Compatibility mechanisms such as GNHF must sit below `goal-loop`; they must not become workflow executor families or make `.gnhf/runs` authoritative state.

### Shared step finalization (M9 / M10 separation)

The verify -> commit / reset finalization transaction lives in the neutrally-named
`shared/step-finalize.ts` seam (`finalizeWorkflowStep` /
`finalizeWorkflowStepFromResultFile`). It is consumed by both the M9 live-step
path (`live-step/advance` / `live-step/run-recovery`) and the M10 executor-loop
families (goal-loop and single-shot). The goal-loop family imports the neutral
seam directly (NGX-494, RC-1b); the M9 live wrappers and the single-shot family
reach it through `live-step/finalize.ts`, a back-compat alias that re-exports the
seam under the original `*LiveWorkflowStep*` names.

The M9 direct-finalize path and the M10 executor-loop path intentionally stay
separate composition lanes: the M9 path is **not** collapsed into the M10
executor-loop path. Any unification is reconciliation work owned by a later slice
(now landed as RC-2 / NGX-480: `dispatch/reconcile.ts` /
`dispatch/reconcile-execute.ts`), not by this mechanical regrouping.

## Ownership boundary with adapters

`no-mistakes/mechanism.ts` is the runtime decision logic and lives here in core.
The no-mistakes *external integration* — `src/adapters/no-mistakes-executor.ts`
and `src/adapters/no-mistakes-orchestrator.ts` — stays under `src/adapters/`
because it drives the external no-mistakes tool. The
`test/cli-import-boundaries.test.ts` adapter-ownership list pins that split.

Known reverse dependencies (adapter → core runtime), preserved unchanged because
ARCH-04 is a mechanical move with no adapter rewrite:

- `src/adapters/no-mistakes-executor.ts` and `no-mistakes-orchestrator.ts` import
  `loop/reducer` / `loop/persist`.
- `src/adapters/runner-adapter.ts` imports `runner/profile`.
- `src/adapters/real-workflow-probe.ts` imports `smoke/workflow-harness`.
- `src/adapters/acp-runner.ts`, `trusted-shell-runner.ts`, and
  `live-step-wrapper.ts` import the `parseRunnerResult` parser from
  `runner/result`; the `RunnerResult` shapes they also consume are type-only
  imports from `runner/types.ts`. This runtime edge moved from the former root
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
  shared runner-result shapes now live at `src/core/executors/runner/types.ts`
  (`COMMIT_TYPES`, `CommitType`, `CommitIntent`, `RunnerResult`, and the
  `RunnerResult{Error,Success,Parse}` envelopes), with their parser
  (`parseRunnerResult` / `normalizeRunnerResult` / `normalizeCommitIntent`) in
  `src/core/executors/runner/result.ts`. Both were drained from the former root
  `src/runner-result.ts` under the type-placement slice (ARCH-06 / NGX-450).
  `COMMIT_TYPES` is a runtime const, but it backs the `CommitType` union and has
  no behavior, so it is colocated with the type it defines.
- No executor barrel/seam consolidation and no finalizer/reconciliation redesign.
  ARCH-08 only added the workflow-owned `run/runtime-state.ts` refresh seam after
  caller-owned durable mutations; the cross-path finalization owner has since landed
  as RC-2 (NGX-480: `dispatch/reconcile.ts` /
  `dispatch/reconcile-execute.ts`). Importers keep direct typed module paths.
