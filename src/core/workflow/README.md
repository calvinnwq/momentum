# core/workflow

Workflow runtime domain. This folder owns the durable workflow runtime:
definitions, run lifecycle, steps, gates, leases, scheduling, dispatch planning,
recovery, monitor state, workflow events, and workflow handoff. It holds business/runtime
behavior only — reducers, state machines, persistence policies, and runtime
decisions. It does not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/workflow-*.ts` root
siblings (ARCH-03) and later split into runtime folders with no behavior change.
Filename prefixes are dropped inside each folder. Command and renderer seams
were left in place; importers still reference the concrete modules below.

## Local structure

| Concern | Modules |
| --- | --- |
| Definition | `definition/definition.ts`, `definition/persist.ts` |
| Run lifecycle | `run/start.ts`, `run/start-persist.ts`, `run/import.ts`, `run/import-persist.ts`, `run/reducer.ts`, `run/recovery.ts`, `run/status.ts`, `run/events.ts`, `run/logs.ts`, `run/handoff.ts`, `run/runtime-state.ts` |
| Steps | `step/executor.ts`, `step/executor-real-adapters.ts`, `step/transitions.ts` |
| Gates | `gate/gate.ts`, `gate/persist.ts` |
| Leases | `leases.ts` |
| Dispatch | `dispatch/dispatch.ts`, `dispatch/persist.ts`, `dispatch/execute.ts`, `dispatch/retry.ts`, `dispatch/executor-run.ts`, `dispatch/executor-terminalize.ts`, `dispatch/reconcile.ts`, `dispatch/reconcile-execute.ts`, `dispatch/external-apply.ts`, `dispatch/external-apply-run.ts`, `dispatch/external-apply-dispatch.ts`, `dispatch/linear-refresh-lifecycle.ts`, `dispatch/subworkflow.ts`, `dispatch/subworkflow-run.ts`, `dispatch/subworkflow-dispatch.ts`, `dispatch/live-wrapper.ts`, `dispatch/dogfood.ts`, `dispatch/scheduler.ts` |
| Routes | `route/coding.ts`, `route/subworkflow.ts`, `route/subworkflow-child-config.ts`, `route/subworkflow-child-runner.ts`, `route/subworkflow-dispatch-context.ts` |
| Preflight | `preflight/structural.ts` |
| Monitor & watch | `monitor/state.ts`, `monitor/envelope.ts`, `monitor/progress.ts`, `monitor/watch-advisory.ts`, `monitor/watch-stream.ts`, `monitor/watch-stream-source.ts`, `monitor/action-authority.ts` |
| Live-wrapper dogfood | `live-wrapper/coding-workflow.ts`, `live-wrapper/merge-cleanup-preflight.ts`, `live-wrapper/merge-cleanup-lifecycle.ts`, `live-wrapper/daemon-profile.ts`, `live-wrapper/daemon-exec-context.ts` |
| Recovery | `recovery/artifact.ts`, `recovery/reconcile.ts` |

`dispatch/dispatch.ts` and `dispatch/persist.ts` are internal helpers behind
`dispatch/execute.ts`; `run/reducer.ts` is the central pure reducer and the most
widely consumed entry point. `run/runtime-state.ts` is the ARCH-08 seam for callers
that already changed durable step / lease rows and need to re-read reducer rows,
derive monitor state, and refresh the cached `workflow_runs` status / monitor
advisory columns without duplicating SQL.

## Public interface for other domains

Other domains reach workflow behavior through these modules:

- **CLI command family** (`src/commands/workflow/`): `definition` /
  `definition/persist`, `gate/gate` / `gate/persist`, `run/start` /
  `run/start-persist`, `run/import` / `run/import-persist`, `run/recovery`,
  `run/reducer`, `run/status`, `run/events`, `monitor/watch-stream` /
  `monitor/watch-stream-source`, `monitor/state` / `monitor/envelope`,
  `run/runtime-state`, `recovery/reconcile`, `run/handoff`, `run/logs`.
- **CLI renderers** (`src/renderers/workflow.ts`): the same run/gate/monitor/
  status/handoff/events/logs shapes, imported **type-only** (renderers format, they
  do not mutate state).
- **Daemon and supervisor dispatch** (`src/core/daemon/workflow-dispatch.ts`): `dispatch/execute`, `dispatch/dogfood`, `dispatch/external-apply-dispatch`, `dispatch/linear-refresh-lifecycle`, `dispatch/subworkflow-dispatch`, `dispatch/live-wrapper`, and `live-wrapper/daemon-profile`; configured `subworkflow` steps compose the child-run producer after the base scaffold while live-wrapper-owned families stay on the live-wrapper lane for bounded daemon cycles and eligible `workflow run watch --once` ticks.
- **Dispatched-step reconciliation**: `dispatch/reconcile` /
  `dispatch/reconcile-execute` own the RC-2 pure/effect seam that finalizes a
  dispatched step from terminal executor evidence.
- **Executor / live-step / daemon runtime**: `run/reducer` (shared run-state
  reduction), `run/runtime-state` (cached run-state / monitor refresh after a
  caller-owned mutation), `step/executor` (registry/dispatch boundary),
  `step/executor-real-adapters` (RC-5 production registry builder backed by
  live wrappers or honest `runtime_unavailable` adapters),
  `live-wrapper/coding-workflow` (the NGX-499 wrapper-command seam used by the
  checked-in dogfood live-wrapper profile), `live-wrapper/merge-cleanup-preflight`
  and `live-wrapper/merge-cleanup-lifecycle` (GitHub auth, target, readback,
  safe-apply, and already-applied reconciliation for the merge-cleanup tail
  step), `step/transitions`,
  `leases`,
  `definition/definition`, `recovery/artifact`, `dispatch/scheduler`.

`workflow run start-coding` records explicit Momentum-native coding runs with `source = "momentum-native-coding"` and the built-in `coding-workflow` definition metadata.
For that source, `dispatch/persist.ts` resolves executor families from the built-in definition recorded on the run by key and version rather than any persisted definition rows with the same key/version, so the native door remains stable even when generic definition starts are using persisted overrides.
If the recorded built-in version is unavailable, dispatch fails closed instead of substituting persisted rows or a later built-in version.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`
  (enforced by `test/cli-import-boundaries.test.ts`).
- Renderers may import from this folder only with `import type`.

## Deferred

A single curated module seam (barrel) is intentionally **not** part of ARCH-08;
importers keep direct typed module paths. ARCH-08 only introduces the
`run/runtime-state.ts` seam around the mechanical finalization / status / monitor
refresh shared by dispatch, reconciliation, dogfood terminalization, and operator/recovery
callers. It does **not** choose the RC-2 reconciliation seam (that landed separately
as NGX-480: `dispatch/reconcile.ts` / `dispatch/reconcile-execute.ts`), delete
the dogfood stand-in, or narrow M9/M10 compatibility paths.

RC-5 fake demotion has since landed in this folder: the production
`WorkflowStepExecutor` default no longer fabricates fake successes, while the
deterministic fake registry lives under `test/helpers/` and is injected only by
tests that need substrate smoke coverage.

RC-5b (NGX-492) has since added the dispatched-step execution path producer:
`dispatch/executor-terminalize.ts` records a finished
`WorkflowStepExecutorDispatchResult` as terminal scaffold evidence, and
`dispatch/executor-run.ts` composes "run the dispatched step's executor (through
an injected real registry) → terminalize → RC-2 reconcile" so a configured
profile finalizes the step exactly once and a configured profile that lacks the
claimed step kind parks the run for manual recovery instead of fabricating
success. `live-wrapper/daemon-profile.ts`
has since added the daemon-default profile **source resolution**: a pure resolver
that turns the `MOMENTUM_LIVE_WRAPPER_PROFILE` env var (a JSON profile file path)
into an absent profile (unchanged default lane), a parsed `LiveWrapperProfile` the
lane can build a real registry from, or an honest invalid outcome — never a
silently fabricated profile. `dispatch/live-wrapper.ts` then composes the base
dispatch with that producer into a `WorkflowStepDispatch`
(`createLiveWrapperWorkflowDispatch`): the production analogue of the dogfood
`createTerminalizingWorkflowDispatch`, it starts the scaffold via the base dispatch
and — only for a genuinely-started dispatch — runs the executor + RC-2 reconcile in
the same tick, taking the registry and the per-step exec-context deriver by
injection and leaving RC-2 the single finalization owner. `dispatch/retry.ts`
keeps the retry path explicit for stale live-wrapper bootstrap failures: after
guarded recovery clear prepares a retryable `no-mistakes` or `merge-cleanup`
step, the next dispatch reopens the same deterministic invocation id with the
next attempt / round while `dispatch/live-wrapper.ts` scopes attempt > 1 evidence
paths under `attempt-<n>/`.
`live-wrapper/daemon-exec-context.ts` has since added that per-step exec-context
**deriver**: a pure resolver (plus its injected run-row loader) that maps a run's
provenance to the bounded session's working directory — a native run runs under
`<repoPath>/.agent-workflows/<runId>/` and an imported run under its source
artifact's run dir — and refuses honestly with `missing_repo_path` (rather than
fabricating a working directory) when the run has no repo, so the lane can fail
closed into manual recovery. `dispatch/live-wrapper.ts` now consumes that refusal
safely: its deriver injection returns a total
`DispatchedStepExecutorContextResolution`, and an `ok: false` resolution is routed
to manual recovery (`recordUnresolvedDispatchedStepContext` in
`dispatch/executor-run.ts`, which terminalizes the same honest
`manual_recovery_required` evidence an unconfigured executor produces and lets RC-2
park the run) instead of throwing — a throw inside the dispatch closure, after the
scaffold exists, would release the lease over a still-`running` step and strand it.
The bounded `daemon start` workflow lane now wires the resolved profile,
registry, and deriver by composing `dispatch/live-wrapper.ts` around the base
workflow dispatcher for configured daemon-default profiles.

RC-3 (NGX-496) added the daemon-dispatchable `external-apply` adapter:
`dispatch/external-apply.ts` maps the M6 apply result into executor evidence,
`dispatch/external-apply-run.ts` runs the injected M6 write path and reconciles
through RC-2, and `dispatch/external-apply-dispatch.ts` gates the producer by scaffold
family after the base dispatcher creates the durable start rows.
`dispatch/linear-refresh-lifecycle.ts` adds the tail-owned preflight -> apply -> reconcile classifier for the built-in `linear-refresh` step: it proves issue scope, auth, policy, source item, one pending `status_update` intent or deterministic seed evidence for the expected intent, valid one-of `state` / `stateId` payload, and stable idempotency marker before the M6 write path can run, and it turns already-applied successful audit evidence into terminal executor evidence without another Linear mutation.
The Linear apply preflight helpers live in `src/core/intent/` so workflow code continues to consume the intent-owned apply path instead of importing policy or auth checks back from workflow modules.

RC-4 (NGX-497) added the `subworkflow` adapter mechanism, and RC-4b (NGX-498)
flipped the configured production lane: `dispatch/subworkflow.ts` maps a child
workflow run's observed state into defer / mirror evidence,
`dispatch/subworkflow-run.ts` starts or attaches to the child through an injected
runner and reconciles the parent only after terminal child evidence,
`dispatch/subworkflow-dispatch.ts` provides the daemon-lane entry-point factory, and
`dispatch/scheduler.ts` can recheck a deferred child run by heartbeating or reacquiring
the parent dispatch lease. The production deriver sources child config and
lineage from `route.subworkflow`, resolves the child definition by key, refuses
unsafe recursion / unsupported attachment, and keeps manual-recovery behavior for
missing or ambiguous child state.

NGX-499 adds `live-wrapper/coding-workflow.ts` as an opt-in dogfood helper for
`profiles/ngx-499-coding-workflow-live-wrapper.profile.json`: the daemon live
profile still owns process supervision and result-file placement, while this
helper loads `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the configured
command for `MOMENTUM_STEP_KIND`, and writes normalized `RunnerResult` evidence
so command failures become durable `success: false` results rather than stranded
manual recovery. It is not a default-route switch and does not change CWFP
compatibility.
Before spawning, the helper validates that the run-local config has only a `steps` object and canonical snake_case per-step keys, rejects malformed `env_allow` and unsafe or mismatched `result_file` values as setup failures, and writes no runner evidence for rejected configs.
The no-mistakes step also requires an explicit `runner_profile` with `interface: "axi"`, `stdin: "closed"`, `agent` set to one of `claude`, `codex`, `opencode`, or `rovodev`, `required_env` containing the selected agent's required environment (`HOME` and `PATH`, plus `CODEX_HOME` for Codex), and an absolute executable `agent_path`; missing profile fields, missing filtered environment, `agent=auto`, a missing/non-executable agent path, or a no-mistakes `agent` / `agent_path_override.<agent>` mismatch fail closed before the no-mistakes command is spawned.
The no-mistakes config check reads `HOME/.no-mistakes/config.yaml` with YAML semantics, accepts aliases and reordered top-level keys, and rejects malformed YAML, duplicate keys, non-mapping overrides, nested-only overrides, missing separators, and non-absolute override paths before any no-mistakes child process is spawned.
For `no-mistakes`, the helper also normalizes upstream terminal-success evidence: `checks-passed`, or a still-monitoring upstream run with current clean pull request evidence and green or explicitly absent checks, becomes successful runner evidence only when current blockers, active findings, unresolved gates, dirty / draft pull request state, and non-successful checks are absent.
It parks missing branch-start state and current no-mistakes cancellation status or outcome evidence as retryable setup recovery instead of terminal failed verification.
If the wrapper is interrupted before writing that evidence but the external no-mistakes run later proves success, guarded `clear-recovery` can reconcile only the failed required `no-mistakes` step with either legacy `no-mistakes:<run-id>#checks-passed` evidence or a readable structured deterministic evidence JSON file.
The structured record must carry the workflow run id, issue scope, branch/head SHA, pull request id/head/check state when present, no-mistakes run id, successful outcome, zero unresolved findings and decisions, and explicit review/test/docs/lint/format/push/PR/CI phase statuses.
`recovery/no-mistakes-evidence.ts` refuses unknown schemas, stale identity, unresolved findings, partial phase evidence, and pending/failed/unknown checks before the failed step can be marked succeeded.
The checked-in dogfood profile runs the wrapper CLI from `src/` through the TypeScript source loader/register shims in `src/adapters/`, so cleanup of generated `dist/` files after test or no-mistakes work does not strand `merge-cleanup` or `linear-refresh` tail work.
For `merge-cleanup`, `live-wrapper/merge-cleanup-preflight.ts` and `live-wrapper/merge-cleanup-lifecycle.ts` keep preflight -> apply -> reconcile inside the tail step. The wrapper requires explicit GitHub auth in the filtered environment, a run-local `merge_cleanup` target block (PR id, expected head SHA, cleanup branch), and a live `gh pr view` readback proving the PR is open, non-draft, mergeable, and still at the expected head before the command is spawned. Already-merged or already-deleted cleanup state becomes reconcile guidance rather than a second external mutation.
External-side-effect tail failures (`merge-cleanup` / `linear-refresh`) use the shared step-kind set in `run/reducer.ts`, classify through the monitor as `failed_external_side_effect_step`, and steer operators to evidence-backed `workflow run clear-recovery --evidence-pointer <ref>` reconciliation instead of a blind re-run that could repeat the external write.
Renderer next-action shapes expose this as `actionClass: "reconcile_external_tail"` with `recoveryDetail.kind: "external_tail_reconcile"`; interrupted no-mistakes evidence reconciliation exposes `actionClass: "reconcile_deterministic_evidence"` with `recoveryDetail.kind: "no_mistakes_deterministic_evidence"` only when durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
Ordinary failed no-mistakes steps remain `retry_failed_step` with `recoveryDetail: null`, even though guarded `clear-recovery` can still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.

NGX-508 adds the explicit Momentum-native `workflow run start-coding` door.
It reuses `run/start` / `run/start-persist` for durable rows, reserves the historical `cwfp-`, `cwfb-`, and `overnight-` prefixes for compatibility imports, stores any selected profile under `route.profile`, and keeps CWFP/default switching separate.

NGX-509 adds the read-only `workflow run preview-coding` door.
It shares the `start-coding` preconditions and built-in definition resolution but writes nothing, materializing a frozen plan via `materializeWorkflowCodingPlanPreview` in `run/start.ts` - a pure projection of the version-pinned built-in definition plus inputs, so a later `start-coding` from the same inputs persists a matching run.

NGX-510 adds the pure `route/coding.ts` keystone for native per-step coding route/config overrides: it validates, normalizes, reads, writes, and projects operator `harness`/`model`/`effort` selections per configurable coding step (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`) under a byte-stable `route.steps` namespace on the run route, parallel to `route.profile` and `route.subworkflow`.
The `workflow run start-coding` / `workflow run preview-coding` doors accept a `--steps-json` flag that builds overrides via this module and embeds them in the durable run route (or the frozen preview route, which also projects a human-readable per-step selection block); the generic `workflow run start` refuses the flag with `route_config_not_allowed`, and a misconfigured selection fails closed with `route_config_invalid` before any write.
Provider-specific model aliases are normalized during the same pure route pass when enough context is present, so known Claude, Codex, and OpenCode aliases preview, persist, and dispatch the command-ready model string for that harness instead of the bare alias; unknown or non-agent harness/model values remain free-form.
Status, handoff, monitor, and logs expose the selected `route.steps` through durable run detail, dispatcher-created executor rounds freeze the mapped agent/model/effort values, and live-wrapper execution forwards them as `MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT`; a corrupt persisted `route.steps` namespace fails closed to manual recovery instead of silently falling back.

`preflight/structural.ts` is the pure structural preflight seam for native coding workflow setup.
The start and preview doors use it to validate built-in definition lookup, required run shape, approval boundary, issue scope, route profile, and route steps before durable writes.
It emits compact `preflightEvidence` objects with stable fields (`checkId`, `status`, `severity`, `path`, `key`, `message`, `recommendedAction`) so CLI clients can fix setup without parsing prose.
It also exposes wrapper config validation for canonical snake_case keys, env allowlists, timeouts, safe or expected result files, no-mistakes runner-profile shape, no-mistakes runner required-env allowlist coverage, and the merge-cleanup target shape, while GitHub, Linear, no-mistakes external config, and other side-effect checks stay inside the step that owns the side effect.
Native `goal-loop` round evidence is currently consumed by `workflow run logs` from executor invocation / round rows and child evidence.
Status, handoff, monitor, and GUI readers remain future consumers until they are wired to the same executor-round projection instead of runner-authored JSON, terminal scrollback, or runner-local directories.

NGX-549 and NGX-550 add the GUI-safe supervisor contract for `workflow run watch --once`.
The command builds on the monitor projection, optionally performs one bounded non-tail target-run dispatcher tick, then emits a compact top-level envelope with `emit`, `reason`, `recommendedAction`, `recommendedActionPolicy`, quiet-duration fields, stuck-risk advisory fields, `nextAction.actionClass`, `nextAction.recoveryDetail`, and optional `humanAction`.
Approved `merge-cleanup` and `linear-refresh` tail steps stay human-required and surface as operator-decision actions instead of being started by the supervisor poller.
Plain `workflow run monitor` remains read-only, while `workflow run monitor --advance` and `workflow run watch --once` are the explicit write-limited polling modes that can update advisory baselines for `momentum-native-coding` runs.
`test/fixtures/workflow-gui-contract.json` freezes the watch envelope keys, next-action operator classes, recovery-detail presence, common GUI scenarios, event envelope keys, event keys, and event types so app clients can branch without terminal scraping.

NGX-551 adds `run/events.ts` as the durable workflow event replay seam behind `workflow run events`.
It projects stable semantic events from workflow rows, combines them with append-only `workflow_events` rows for overwritten transitions and supervisor advisories, and returns opaque replay cursors so reconnecting clients can continue from the previous response cursor without relying on stdout or process state.

NGX-552 adds `monitor/watch-stream.ts` and `monitor/watch-stream-source.ts` as the read-only JSONL stream seam behind `workflow run watch --stream --jsonl`.
The driver polls the durable event cursor API on its bounded interval, writes each stream record immediately, retains only the cursor and counters between polls, emits `emit: true` records only for semantic events, emits `emit: false` heartbeats for liveness, and exits when the run row is terminal.
The source layer uses incremental event reads plus the durable run row terminal state so a reconnecting stream resumed past the terminal event still observes completion without dispatching work or mutating monitor advisory baselines.
The stream seam does not deliver to OpenClaw or invoke an LLM; clients decide how to consume the durable JSONL records.
