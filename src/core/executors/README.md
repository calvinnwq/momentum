# core/executors

Executor runtime domain. This folder owns the executor registration, config
validation, bounded tick driver, and durable execution _mechanisms_: the
executor-loop reducer/persistence, the goal-loop and single-shot executor
families, the production live-step wrapper executor, and the no-mistakes
mechanism, plus their runner-profile, foreground iteration, and runner-smoke
support. It holds business/runtime behavior only —
reducers, state machines, persistence policies, and execution decisions. It does
not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-04) and later split into family folders with no behavior change. Filename
prefixes are dropped inside each folder. Command, renderer, and adapter seams
were left in place; importers still reference the concrete modules below.

## Local structure

| Concern                        | Modules                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Executor SDK                   | `sdk/types.ts`, `sdk/envelope.ts`, `sdk/registry.ts`, `sdk/config-schema.ts`, `sdk/driver.ts`              |
| Executor loop                  | `loop/reducer.ts`, `loop/persist.ts`                                                                       |
| Goal-loop executor             | `goal-loop/executor.ts`, `goal-loop/mechanism.ts`, `goal-loop/orchestrator.ts`, `goal-loop/prompt.ts`      |
| Single-shot executor           | `single-shot/sdk.ts`, `single-shot/executor.ts`, `single-shot/mechanism.ts`, `single-shot/orchestrator.ts` |
| Live-step executor             | `live-step/executor.ts` (production live-wrapper lane)                                                     |
| Shared step finalization       | `shared/step-finalize.ts` (neutral verify -> commit / reset seam)                                          |
| No-mistakes mechanism          | `no-mistakes/mechanism.ts`                                                                                 |
| Runner support                 | `runner/profile.ts`                                                                                        |
| Runner smoke                   | `smoke/linear-read.ts`, `smoke/workflow-harness.ts`                                                        |
| Runner result shapes & parsing | `runner/types.ts`, `runner/result.ts`                                                                      |

`loop/reducer.ts` is the central pure reducer and the most widely consumed entry
point; `loop/persist.ts` wraps it with persistence. The goal-loop and single-shot
families build on `loop/reducer` / `loop/persist`.
`sdk/types.ts` is the dependency-free third-party contract: one bounded `tick`,
a declared portable config schema, a durable snapshot, and an envelope facade
that can record observations/evidence but cannot classify terminal state.
`sdk/registry.ts` discovers configured ESM/CommonJS modules by permanent name,
`sdk/config-schema.ts` validates declared strict schemas and portable config, and
`sdk/driver.ts` applies daemon-owned decisions one bounded tick at a time.
`sdk/envelope.ts` is Momentum's SQLite-backed host implementation; its
daemon-only controller owns a separate frozen facade passed to executor code.
Facade writes are available only while the invocation is `running`; an operator
wait or any other non-running state revokes executor write access.
Classification, its checkpoint, and invocation settlement commit atomically on
the controller after a tick returns.
The controller also rejects classification decisions whose invocation or round
state is inconsistent with the classification before writing any settlement.
`single-shot/sdk.ts` is the first built-in proof: the current `one-shot` and
`script` families implement the same `Executor` interface and accept a runner
adapter as their narrower lifecycle extension point.
`live-step/sdk-executor.ts` registers profile-backed built-ins through the same
guard and records replay-safe mechanism completion before daemon classification.
The built-in runner
mechanisms supervise process groups asynchronously below a crash-surviving
anchor/watchdog, terminate them on tick cancellation or daemon loss, require a
fresh per-run ownership-token proof before signalling POSIX PIDs, require host
repo-ownership proof before resetting mutations, and
only then let the host atomically persist the cancelled classification. Missing
ownership proof or cleanup failure preserves the durable in-flight state for
recovery rather than claiming terminal cancellation.
Native Windows process execution fails closed with `unsupported_platform`
before a supervised command is spawned. When the anchor cannot confirm cleanup
on Linux or macOS, the ownership-checked POSIX fallback receives its own bounded
cleanup budget. A verified fallback preserves
the known timeout, cancellation, or command-exit outcome; only an unverified
fallback changes that outcome to `SUPERVISOR_FAILED`.
The POSIX budget begins after its ownership preflight; an already-exited anchor
must have reported entering cleanup before fallback may preserve the outcome.
The synchronous helper preserves command status only as diagnostics when cleanup
proof fails.
Captured stdout and stderr remain in the executor log through cancellation, and
streaming UTF-8 decoding preserves characters split across pipe chunks.
POSIX supervision is portable userland containment, not a sandbox: it proves
cleanup for the anchored group and sampled descendants that retain the ownership
token. Fallback also requires two consecutive snapshots with no live member of
the retained process group, so a token-stripped same-group descendant cannot be
mistaken for successful cleanup. A hostile descendant that escapes between
ancestry samples and strips the token requires kernel-backed containment outside
this implementation.
Detected escapes or lost cleanup proof fail closed with `SUPERVISOR_FAILED`.
Both read-only and finalizing built-ins require clean tracked/untracked status plus a captured ignored-path baseline before launch.
Ignored-worktree comparison hashes every included entry's path and metadata, including a non-empty directory before recursively hashing its descendants.
Directory-only mode or timestamp mutations therefore remain residue.
The comparison is intentionally strict; large ignored trees and concurrent cache churn remain operational risks, so mutable caches should live outside the supervised worktree when practical.
New single-shot dispatches insert their invocation, initial running round, and
hashed dispatch-binding checkpoint in one transaction after resolving runtime
inputs, so reattach never inherits a new invocation without its complete binding.
Registration/discovery, structural-preflight schema validation, and daemon tick
driving remain separate runtime concerns joined by the same executor identity and
declared config schema.
Before artifact writes, result observations, or completion checkpoints, the lifecycle runtime-normalizes the complete runner-adapter return.
Malformed JavaScript or casted returns leave only the atomically materialized invocation, running round, and dispatch-binding checkpoint for recovery.
Successful `one-shot` turns require a successful normalized `RunnerResult`; exit-code-based `script` turns forbid result-document evidence.
The native `goal-loop` family renders deterministic per-round prompts through `goal-loop/prompt.ts`, then treats runner-authored `RunnerResult` JSON as input to finalization only.
The prompted-result bridge clears stale result files before handing the prompt and configured result path to the runner, so an old result cannot be finalized as new progress.
After finalization, its authoritative evidence is the `executor_invocations` / `executor_rounds` tree plus child artifacts, checkpoints, findings, and decisions that `workflow run logs` reads today.
The concrete goal-loop mechanism writes `commit_or_reset_evidence` as a digested finalization sidecar at `<verification-log>.finalization.json` when the verification log path is a usable absolute path.
The current coding workflow selects GNHF as portable tool config below `delegate-supervisor`, while legacy definitions may still run it beneath `goal-loop`.
In both cases it must report through Momentum invocation and round evidence rather than become an executor family or make `.gnhf/runs` authoritative state.

### Shared step finalization

The verify -> commit / reset finalization transaction lives in the neutrally-named
`shared/step-finalize.ts` seam (`finalizeWorkflowStep` /
`finalizeWorkflowStepFromResultFile`), consumed directly by the goal-loop
and single-shot families.

The retired live-step direct-finalize lane (`live-step/advance.ts`,
`live-step/orchestrator.ts`, `live-step/run-recovery.ts`) and its
`live-step/finalize.ts` back-compat alias were deleted under the
execution-lane decision: the dispatch reconciliation seam
(`dispatch/reconcile.ts` / `dispatch/reconcile-execute.ts`) owns finalizing
dispatched workflow steps from durable terminal executor evidence in
production, while `live-step/sdk-executor.ts` calls this shared verify -> commit /
reset seam before recording durable mechanism completion for daemon
classification.
That superseded the staged live-step composition lane.
The remaining `live-step/executor.ts` is the production live-wrapper step
executor consumed by the real-adapter registry.

## Ownership boundary with adapters

`delegate-supervisor/` owns the SDK executor, canonical external-state
classification, semantic-progress heartbeat / stall logic, and evidence
projection. `src/adapters/no-mistakes-tool-adapter.ts` is the narrow external
edge: it hands off to no-mistakes and reads normalized state without owning
durable lifecycle decisions. The older no-mistakes mirror entrypoints remain as
compatibility callers of the same core classification authority while existing
recorded `no-mistakes` invocations remain readable.

Every current adapter → executor-core edge has an explicit SDK disposition:

| Adapter edge                                                                                        | Disposition                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-step-wrapper.ts` → `runner/result.ts` and `runner/types.ts`                                   | Resolved: the pure `RunnerResult` schema, parser, and normalizers are official SDK runtime surface.                                                                                                        |
| `git-transaction.ts` → `runner/types.ts`                                                            | Resolved: type-only use of the SDK `CommitIntent` shape.                                                                                                                                                   |
| `no-mistakes-executor.ts` → `delegate-supervisor/classifier.ts`                                     | Resolved compatibility edge: recorded legacy mirror entrypoints delegate to the official supervision classification authority instead of carrying a second classifier.                                     |
| `no-mistakes-executor.ts` / `no-mistakes-orchestrator.ts` → `loop/*` and `no-mistakes/mechanism.ts` | Temporary, explicitly re-justified: the current mirror predates the SDK. It dissolves when supervision moves into the core `delegate-supervisor` lifecycle and the adapter shrinks to a tool adapter.      |
| `no-mistakes-tool-adapter.ts` → `delegate-supervisor/types.ts` and `no-mistakes/mechanism.ts`       | Resolved: the adapter implements the official delegated-tool lifecycle interface and reuses the tool-owned external-state reader / normalizer; it imports no executor persistence or controller internals. |
| `real-workflow-probe.ts` → `smoke/workflow-harness.ts`                                              | Temporary, explicitly re-justified: this is gated smoke/test support and will move behind a test-support boundary rather than become SDK runtime.                                                          |
| `runner/profile.ts`                                                                                 | Compatibility support only; machine-local runner resolution folds into host bindings and is not portable step config or a third-party executor API.                                                        |

`test/executor-sdk-import-boundaries.test.ts` pins this exact allowlist so no
new adapter reverse dependency can appear without a named disposition. The end
state is adapters importing only SDK contract modules/types or lifecycle
adapter interfaces, never executor persistence.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`
  (enforced by `test/cli-import-boundaries.test.ts`).
- No renderer imports these modules.

## Deferred

- Exported family-specific executor types stay beside their behavior in their owning module. The
  shared runner-result shapes now live at `src/core/executors/runner/types.ts`
  (`COMMIT_TYPES`, `CommitType`, `CommitIntent`, `RunnerResult`, and the
  `RunnerResult{Error,Success,Parse}` envelopes), with their parser
  (`parseRunnerResult` / `normalizeRunnerResult` / `normalizeCommitIntent`) in
  `src/core/executors/runner/result.ts`. Both were drained from the former root
  `src/runner-result.ts` under the type-placement slice.
  `COMMIT_TYPES` is a runtime const, but it backs the `CommitType` union and has
  no behavior, so it is colocated with the type it defines.
- No executor barrel/seam consolidation and no finalizer/reconciliation redesign.
  ARCH-08 only added the workflow-owned `run/runtime-state.ts` refresh seam after
  caller-owned durable mutations; the cross-path finalization owner is now
  `dispatch/reconcile.ts` / `dispatch/reconcile-execute.ts`. Importers keep
  direct typed module paths.
