# core/workflow

Workflow runtime domain. This folder owns the durable workflow runtime:
definitions, run lifecycle, steps, gates, leases, scheduling, dispatch planning,
recovery, monitor state, workflow events, and workflow handoff. It holds business/runtime
behavior only — reducers, state machines, persistence policies, and runtime
decisions. It does not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/workflow-*.ts` root
siblings (ARCH-03) with no behavior change. Command and renderer seams were left
in place; importers still reference the concrete modules below.

## Local structure

| Concern | Modules |
| --- | --- |
| Definition | `definition.ts`, `definition-persist.ts` |
| Run lifecycle | `run-start.ts`, `run-start-persist.ts`, `run-import.ts`, `run-import-persist.ts`, `run-reducer.ts`, `run-recovery.ts`, `status.ts`, `events.ts`, `watch-stream.ts`, `watch-stream-source.ts`, `logs.ts` |
| Runtime state refresh | `runtime-state.ts` |
| Steps | `step-executor.ts`, `step-executor-real-adapters.ts`, `step-transitions.ts` |
| Gates | `gate.ts`, `gate-persist.ts` |
| Leases | `leases.ts` |
| Scheduling | `scheduler.ts` |
| Dispatch | `dispatch.ts`, `dispatch-persist.ts`, `dispatch-execute.ts`, `dispatch-retry.ts`, `dispatch-executor-run.ts`, `dispatch-executor-terminalize.ts`, `dispatch-external-apply.ts`, `dispatch-external-apply-run.ts`, `external-apply-dispatch.ts`, `dispatch-subworkflow.ts`, `dispatch-subworkflow-run.ts`, `subworkflow-dispatch.ts`, `subworkflow-child-config.ts`, `subworkflow-route.ts`, `subworkflow-child-runner.ts`, `subworkflow-dispatch-context.ts`, `dispatch-reconcile.ts`, `dispatch-reconcile-execute.ts`, `daemon-live-wrapper-profile.ts`, `daemon-dispatch-exec-context.ts`, `live-wrapper-dispatch.ts`, `dogfood-dispatch.ts` |
| Live-wrapper dogfood | `coding-workflow-live-wrapper.ts` |
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
  `run-reducer`, `status`, `events`, `watch-stream` /
  `watch-stream-source`, `monitor-state` / `monitor-envelope`,
  `runtime-state`, `recovery-reconcile`, `handoff`, `logs`.
- **CLI renderers** (`src/renderers/workflow.ts`): the same run/gate/monitor/
  status/handoff/events/logs shapes, imported **type-only** (renderers format, they
  do not mutate state).
- **Daemon and supervisor dispatch** (`src/core/daemon/workflow-dispatch.ts`): `dispatch-execute`, `dogfood-dispatch`, `external-apply-dispatch`, `subworkflow-dispatch`, `live-wrapper-dispatch`, and `daemon-live-wrapper-profile`; configured `subworkflow` steps compose the child-run producer after the base scaffold while live-wrapper-owned families stay on the live-wrapper lane for both bounded daemon cycles and `workflow run watch --once` ticks.
- **Dispatched-step reconciliation**: `dispatch-reconcile` /
  `dispatch-reconcile-execute` own the RC-2 pure/effect seam that finalizes a
  dispatched step from terminal executor evidence.
- **Executor / live-step / daemon runtime**: `run-reducer` (shared run-state
  reduction), `runtime-state` (cached run-state / monitor refresh after a
  caller-owned mutation), `step-executor` (registry/dispatch boundary),
  `step-executor-real-adapters` (RC-5 production registry builder backed by
  live wrappers or honest `runtime_unavailable` adapters),
  `coding-workflow-live-wrapper` (the NGX-499 wrapper-command seam used by the
  checked-in dogfood live-wrapper profile), `step-transitions`, `leases`,
  `definition`, `recovery-artifact`, `scheduler`.

`workflow run start-coding` records explicit Momentum-native coding runs with `source = "momentum-native-coding"` and the built-in `coding-workflow` definition metadata.
For that source, `dispatch-persist.ts` resolves executor families from the built-in definition recorded on the run by key and version rather than any persisted definition rows with the same key/version, so the native door remains stable even when generic definition starts are using persisted overrides.
If the recorded built-in version is unavailable, dispatch fails closed instead of substituting persisted rows or a later built-in version.

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
profile finalizes the step exactly once and a configured profile that lacks the
claimed step kind parks the run for manual recovery instead of fabricating
success. `daemon-live-wrapper-profile.ts`
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
injection and leaving RC-2 the single finalization owner. `dispatch-retry.ts`
keeps the retry path explicit for stale live-wrapper bootstrap failures: after
guarded recovery clear prepares a retryable `no-mistakes` or `merge-cleanup`
step, the next dispatch reopens the same deterministic invocation id with the
next attempt / round while `live-wrapper-dispatch.ts` scopes attempt > 1 evidence
paths under `attempt-<n>/`.
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

RC-3 (NGX-496) added the daemon-dispatchable `external-apply` adapter:
`dispatch-external-apply.ts` maps the M6 apply result into executor evidence,
`dispatch-external-apply-run.ts` runs the injected M6 write path and reconciles
through RC-2, and `external-apply-dispatch.ts` gates the producer by scaffold
family after the base dispatcher creates the durable start rows.

RC-4 (NGX-497) added the `subworkflow` adapter mechanism, and RC-4b (NGX-498)
flipped the configured production lane: `dispatch-subworkflow.ts` maps a child
workflow run's observed state into defer / mirror evidence,
`dispatch-subworkflow-run.ts` starts or attaches to the child through an injected
runner and reconciles the parent only after terminal child evidence,
`subworkflow-dispatch.ts` provides the daemon-lane entry-point factory, and
`scheduler.ts` can recheck a deferred child run by heartbeating or reacquiring
the parent dispatch lease. The production deriver sources child config and
lineage from `route.subworkflow`, resolves the child definition by key, refuses
unsafe recursion / unsupported attachment, and keeps manual-recovery behavior for
missing or ambiguous child state.

NGX-499 adds `coding-workflow-live-wrapper.ts` as an opt-in dogfood helper for
`profiles/ngx-499-coding-workflow-live-wrapper.profile.json`: the daemon live
profile still owns process supervision and result-file placement, while this
helper loads `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the configured
command for `MOMENTUM_STEP_KIND`, and writes normalized `RunnerResult` evidence
so command failures become durable `success: false` results rather than stranded
manual recovery. It is not a default-route switch and does not change CWFP
compatibility.
For `no-mistakes`, the helper also normalizes upstream terminal-success evidence: `checks-passed`, or a still-monitoring upstream run with current clean pull request evidence and green or explicitly absent checks, becomes successful runner evidence only when current blockers, active findings, unresolved gates, dirty / draft pull request state, and non-successful checks are absent.
If the wrapper is interrupted before writing that evidence but the external no-mistakes run later proves `checks-passed`, guarded `clear-recovery` can reconcile only the failed required `no-mistakes` step with `no-mistakes:<run-id>#checks-passed` evidence and then re-derive the run so downstream work can continue.
The checked-in dogfood profile runs the wrapper CLI from `src/` through the TypeScript source loader/register shims in `src/adapters/`, so cleanup of generated `dist/` files after test or no-mistakes work does not strand `merge-cleanup` or `linear-refresh` tail work.
External-side-effect tail failures (`merge-cleanup` / `linear-refresh`) use the shared step-kind set in `run-reducer.ts`, classify through the monitor as `failed_external_side_effect_step`, and steer operators to evidence-backed `workflow run clear-recovery --evidence-pointer <ref>` reconciliation instead of a blind re-run that could repeat the external write.

NGX-508 adds the explicit Momentum-native `workflow run start-coding` door.
It reuses `run-start` / `run-start-persist` for durable rows, reserves the historical `cwfp-`, `cwfb-`, and `overnight-` prefixes for compatibility imports, stores any selected profile under `route.profile`, and keeps CWFP/default switching separate.

NGX-509 adds the read-only `workflow run preview-coding` door.
It shares the `start-coding` preconditions and built-in definition resolution but writes nothing, materializing a frozen plan via `materializeWorkflowCodingPlanPreview` in `run-start.ts` - a pure projection of the version-pinned built-in definition plus inputs, so a later `start-coding` from the same inputs persists a matching run.

NGX-510 adds the pure `coding-route-config.ts` keystone for native per-step coding route/config overrides: it validates, normalizes, reads, writes, and projects operator `harness`/`model`/`effort` selections per configurable coding step (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`) under a byte-stable `route.steps` namespace on the run route, parallel to `route.profile` and `route.subworkflow`.
The `workflow run start-coding` / `workflow run preview-coding` doors accept a `--steps-json` flag that builds overrides via this module and embeds them in the durable run route (or the frozen preview route, which also projects a human-readable per-step selection block); the generic `workflow run start` refuses the flag with `route_config_not_allowed`, and a misconfigured selection fails closed with `route_config_invalid` before any write.
Provider-specific model aliases are normalized during the same pure route pass when enough context is present, so known Claude, Codex, and OpenCode aliases preview, persist, and dispatch the command-ready model string for that harness instead of the bare alias; unknown or non-agent harness/model values remain free-form.
Status, handoff, monitor, and logs expose the selected `route.steps` through durable run detail, dispatcher-created executor rounds freeze the mapped agent/model/effort values, and live-wrapper execution forwards them as `MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT`; a corrupt persisted `route.steps` namespace fails closed to manual recovery instead of silently falling back.

NGX-551 adds `events.ts` as the durable workflow event replay seam behind `workflow run events`.
It projects stable semantic events from workflow rows, combines them with append-only `workflow_events` rows for overwritten transitions and supervisor advisories, and returns opaque replay cursors so reconnecting clients can continue from the previous response cursor without relying on stdout or process state.

NGX-552 adds `watch-stream.ts` and `watch-stream-source.ts` as the read-only JSONL stream seam behind `workflow run watch --stream --jsonl`.
The driver polls the durable event cursor API on its bounded interval, writes each stream record immediately, retains only the cursor and counters between polls, emits `emit: true` records only for semantic events, emits `emit: false` heartbeats for liveness, and exits when the run row is terminal.
The source layer uses incremental event reads plus the durable run row terminal state so a reconnecting stream resumed past the terminal event still observes completion without dispatching work or mutating monitor advisory baselines.
The stream seam does not deliver to OpenClaw or invoke an LLM; clients decide how to consume the durable JSONL records.
