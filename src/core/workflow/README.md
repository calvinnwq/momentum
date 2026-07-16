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

| Concern              | Modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition           | `definition/definition.ts`, `definition/persist.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Run lifecycle        | `run/start.ts`, `run/start-persist.ts`, `run/import.ts`, `run/import-persist.ts`, `run/reducer.ts`, `run/recovery.ts`, `run/status.ts`, `run/events.ts`, `run/logs.ts`, `run/handoff.ts`, `run/runtime-state.ts`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Steps                | `step/executor.ts`, `step/executor-real-adapters.ts`, `step/transitions.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gates                | `gate/gate.ts`, `gate/persist.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Leases               | `leases.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Dispatch             | `dispatch/dispatch.ts`, `dispatch/persist.ts`, `dispatch/execute.ts`, `dispatch/retry.ts`, `dispatch/dispatch-status.ts`, `dispatch/executor-context.ts`, `dispatch/executor-evidence.ts`, `dispatch/executor-recovery.ts`, `dispatch/registered-executor.ts`, `dispatch/reconcile.ts`, `dispatch/reconcile-execute.ts`, `dispatch/external-apply.ts`, `dispatch/external-apply-run.ts`, `dispatch/external-apply-dispatch.ts`, `dispatch/linear-refresh-lifecycle.ts`, `dispatch/subworkflow.ts`, `dispatch/subworkflow-run.ts`, `dispatch/subworkflow-dispatch.ts`, `dispatch/dogfood.ts`, `dispatch/scheduler.ts` |
| Routes               | `route/coding.ts`, `route/subworkflow.ts`, `route/subworkflow-child-config.ts`, `route/subworkflow-child-runner.ts`, `route/subworkflow-dispatch-context.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Preflight            | `preflight/structural.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Monitor & watch      | `monitor/state.ts`, `monitor/envelope.ts`, `monitor/progress.ts`, `monitor/watch-advisory.ts`, `monitor/watch-stream.ts`, `monitor/watch-stream-source.ts`, `monitor/action-authority.ts`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Live-wrapper dogfood | `live-wrapper/coding-workflow.ts`, `live-wrapper/merge-cleanup-preflight.ts`, `live-wrapper/merge-cleanup-lifecycle.ts`, `live-wrapper/daemon-profile.ts`, `live-wrapper/daemon-exec-context.ts`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Recovery             | `recovery/artifact.ts`, `recovery/reconcile.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
- **Daemon and supervisor dispatch** (`src/core/daemon/workflow-dispatch.ts`): `dispatch/execute`, `dispatch/registered-executor`, `dispatch/dogfood`, `dispatch/external-apply-dispatch`, `dispatch/linear-refresh-lifecycle`, `dispatch/subworkflow-dispatch`, and `live-wrapper/daemon-profile`; configured profile-backed and third-party executors share the registered SDK tick driver.
- **Dispatched-step reconciliation**: `dispatch/reconcile` /
  `dispatch/reconcile-execute` own the pure/effect seam that finalizes a
  dispatched step from terminal executor evidence.
- **Executor / live-wrapper / daemon runtime**: `run/reducer` (shared run-state
  reduction), `run/runtime-state` (cached run-state / monitor refresh after a
  caller-owned mutation), `step/executor` (registry/dispatch boundary),
  `step/executor-real-adapters` (production registry builder backed by
  live wrappers or honest `runtime_unavailable` adapters),
  `live-wrapper/coding-workflow` (the wrapper-command seam used by the
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
callers. It does **not** choose the reconciliation seam (that lives separately
in `dispatch/reconcile.ts` / `dispatch/reconcile-execute.ts`), delete
the dogfood stand-in, or narrow live-wrapper / executor-loop compatibility paths.

Fake demotion has since landed in this folder: the production
`WorkflowStepExecutor` default no longer fabricates fake successes, while the
deterministic fake registry lives under `test/helpers/` and is injected only by
tests that need substrate smoke coverage.

Registered executor dispatch supersedes the interim live-wrapper composition.
`dispatch/registered-executor.ts` creates the durable scaffold, resolves the
executor by permanent name, drives bounded SDK ticks, and reconciles daemon-owned
classification. Profile-backed built-ins run through
`executors/live-step/sdk-executor.ts`; that executor records its observation and
`mechanism_completed` checkpoint before daemon classification, so reattachment
classifies durable completed work without rerunning the bounded mechanism.
`dispatch/executor-evidence.ts` and `dispatch/executor-recovery.ts` retain neutral
settlement helpers used by external-apply and subworkflow; they are not an
alternate live-wrapper execution lane.

`live-wrapper/daemon-profile.ts` resolves the optional daemon profile source, and
`live-wrapper/daemon-exec-context.ts` maps durable run provenance to host-local
paths. The registered host-binding resolver keeps portable step config separate
from executable paths, environment, repo ownership, verification, and commit-or-
reset policy. Missing host bindings become precise durable recovery evidence
rather than escaping across the scheduler boundary. `dispatch/retry.ts` reopens
the same deterministic invocation with the next attempt. Ordinary live-wrapper
evidence uses `attempt-<n>/` for later attempts, while delegate-supervisor
evidence is first isolated beneath `delegate/<step-id>/`.
The step-scoped `delegate-handoff.json` receipt records no-mistakes launch intent before process start and generic delegate reset or commit intent before repository mutation.
After no-mistakes returns, its receipt also binds the exact bounded result digest used to authorize the selected reset or commit, verified no-change acceptance, and any later failed-finalization retry or prepared-commit recovery.
Correlated no-mistakes launch output cannot recover a launch-only receipt without wrapper-finalization proof.
Generic retry recovery requires a bounded regular result whose exact digest matches the receipt plus exact base, tree, message, and clean-worktree proof; otherwise it preserves the worktree and refuses another external launch.
If a verified commit is staged when the process stops, recovery accepts that otherwise-dirty index only when the `finalizing` receipt matches the current base `HEAD`, staged tree, configured artifact paths, result digest, and successful result, with no unstaged or untracked changes.
Repository ownership and commit evidence are checked again immediately before the recovered commit.
Finalized profile-backed delegate state must match the repository's current full `HEAD`.
After a durable handoff intent or completed handoff exists, an unclassified running, capturing-result, or `mirroring_external_state` round remains scheduler-resumable across stale auto-release dispatch-lease recovery instead of being parked or relaunched.
A completed `continue` poll in `succeeded` or `failed` with a durable handoff in its history is likewise scheduler-resumable.
An invocation classified `waiting_operator` before a crash reuses or recreates its workflow gate from the durable decision selector and unresolved decision when stale dispatch recovery releases the abandoned lease.
An earlier crash after the delegate persisted a mirrored gate checkpoint, gate-eligible decision, and `waiting_operator` observation leaves the unclassified round resumable so the same invocation can finish classification and gate parking.
A scheduler pass that releases a stale dispatch owner can transfer the same invocation's matching active repo lock to the replacement holder before the longer repo lock expires, with full identity compare-and-swap fencing.
A valid non-terminal handoff is reconciled through adapter recovery before reuse across retry attempts.
For profile-backed no-mistakes, a conclusively failed or cancelled prior external run remains evidence but permits one fresh launch on the newer attempt.
A local wrapper-finalization failure first triggers a correlated status read on the newer attempt.
A failed or cancelled run permits one fresh launch; every other status reruns local finalization before the same run is reattached for supervision.
Only the invocation's first completed delegate handoff may receive an immediate second tick in its dispatcher pass; later passes and retry attempts use one tick.

The daemon-dispatchable `external-apply` adapter:
`dispatch/external-apply.ts` maps the external-apply result into executor evidence,
`dispatch/external-apply-run.ts` runs the injected external write path and reconciles
through the reconciliation seam, and `dispatch/external-apply-dispatch.ts` gates the producer by scaffold
family after the base dispatcher creates the durable start rows.
`dispatch/linear-refresh-lifecycle.ts` adds the tail-owned preflight -> apply -> reconcile classifier for the built-in `linear-refresh` step: it proves issue scope, auth, policy, source item, one pending `status_update` intent or deterministic seed evidence for the expected `Done` intent, valid one-of `state` / `stateId` payload, and stable idempotency marker before the external write path can run, and it turns already-applied successful audit evidence into terminal executor evidence without another Linear mutation.
The Linear apply preflight helpers live in `src/core/intent/` so workflow code continues to consume the intent-owned apply path instead of importing policy or auth checks back from workflow modules.

The `subworkflow` adapter mechanism landed first, and a follow-up
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

`live-wrapper/coding-workflow.ts` is an opt-in dogfood helper for
`profiles/coding-workflow-live-wrapper.profile.json`: the daemon live
profile still owns process supervision and result-file placement, while this
helper loads `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the configured
command for `MOMENTUM_STEP_KIND`, and writes normalized `RunnerResult` evidence
so command failures become durable `success: false` results rather than stranded
manual recovery. It is not a default-route switch and does not change CWFP
compatibility.
Before spawning, the helper validates that the run-local config has only a `steps` object and canonical snake_case per-step keys, rejects malformed `env_allow` and unsafe or mismatched `result_file` values as setup failures, and writes no runner evidence for rejected configs.
The no-mistakes step also requires an explicit `runner_profile` with `interface: "axi"`, `stdin: "closed"`, `agent` set to one of `claude`, `codex`, `opencode`, or `rovodev`, `required_env` containing the selected agent's required environment (`HOME` and `PATH`, plus `CODEX_HOME` for Codex), and an absolute executable `agent_path`; missing profile fields, missing filtered environment, `agent=auto`, a missing/non-executable agent path, or a no-mistakes `agent` / `agent_path_override.<agent>` mismatch fail closed before the no-mistakes command is spawned.
The no-mistakes config check reads `HOME/.no-mistakes/config.yaml` with YAML semantics, accepts aliases and reordered top-level keys, and rejects malformed YAML, duplicate keys, non-mapping overrides, nested-only overrides, missing separators, and non-absolute override paths before any no-mistakes child process is spawned.
For current coding definitions, that wrapper invocation is the no-mistakes handoff beneath `delegate-supervisor`; later ticks call the validated no-mistakes executable with `axi status --run <external-run-id>` and normalize the correlated run id, branch, current head commit id, findings, decisions, pull request, and CI state through `src/adapters/no-mistakes-tool-adapter.ts`.
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

`workflow run start-coding` is the explicit Momentum-native start door.
It reuses `run/start` / `run/start-persist` for durable rows, reserves the historical `cwfp-`, `cwfb-`, and `overnight-` prefixes for compatibility imports, stores any selected profile under `route.profile`, stores the selected implementation path under `route.implementationEngine`, and keeps CWFP/default switching explicit.
The coding doors accept `gnhf`, legacy `native-goal-loop`, and `current-gnhf-cwfp`, default to persisted `gnhf`, and fail closed before implementation dispatch when a persisted current-GNHF/CWFP route is selected because that compatibility lane is not wired into native dispatch yet. The current built-in definition classifies implementation and no-mistakes as `delegate-supervisor` with their tool in portable step config; version 1 remains registered unchanged for recorded runs.

`workflow run preview-coding` is the read-only native plan-preview door.
It shares the `start-coding` preconditions, built-in definition resolution, and configured executor module/schema preflight but writes no Momentum state, materializing a frozen plan via `materializeWorkflowCodingPlanPreview` in `run/start.ts` after those checks pass.
The resulting plan is a pure projection of the version-pinned built-in definition plus inputs, including `route.implementationEngine` and each step's optional portable config, so a later `start-coding` from the same inputs persists a matching run.

`route/coding.ts` is the pure keystone for native per-step coding route/config overrides: it validates, normalizes, reads, writes, and projects operator `harness`/`model`/`effort` selections per configurable coding step (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`) under a byte-stable `route.steps` namespace on the run route, parallel to `route.implementationEngine`, `route.profile`, and `route.subworkflow`.
The `workflow run start-coding` / `workflow run preview-coding` doors accept a `--steps-json` flag that builds overrides via this module and embeds them in the durable run route (or the frozen preview route, which also projects a human-readable per-step selection block); the generic `workflow run start` refuses the flag with `route_config_not_allowed`, and a misconfigured selection fails closed with `route_config_invalid` before any write.
Provider-specific model aliases are normalized during the same pure route pass when enough context is present, so known Claude, Codex, and OpenCode aliases preview, persist, and dispatch the command-ready model string for that harness instead of the bare alias; unknown or non-agent harness/model values remain free-form.
Status, handoff, monitor, and logs expose the selected `route.steps` through durable run detail, dispatcher-created executor rounds freeze the mapped agent/model/effort values, and live-wrapper execution forwards them as `MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT`; a corrupt persisted `route.steps` namespace fails closed to manual recovery instead of silently falling back.

`preflight/structural.ts` is the pure structural preflight seam for workflow setup.
The start and preview doors use it to validate built-in definition lookup, required run shape, approval boundary, issue scope, route profile, route steps, registered executor presence, and portable config against each registered declaration before durable writes.
It emits compact `preflightEvidence` objects with stable fields (`checkId`, `status`, `severity`, `path`, `key`, `message`, `recommendedAction`) so CLI clients can fix setup without parsing prose.
It also exposes wrapper config validation for canonical snake_case keys, env allowlists, timeouts, safe or expected result files, no-mistakes runner-profile shape, no-mistakes runner required-env allowlist coverage, and the merge-cleanup target shape, while GitHub, Linear, no-mistakes external config, and other side-effect checks stay inside the step that owns the side effect.
Native `goal-loop` round evidence is currently consumed by `workflow run logs` from executor invocation / round rows and child evidence.
Status, handoff, monitor, and GUI readers remain future consumers until they are wired to the same executor-round projection instead of runner-authored JSON, terminal scrollback, or runner-local directories.

The GUI-safe supervisor contract sits behind `workflow run watch --once`.
The command builds on the monitor projection, optionally performs one bounded non-tail target-run dispatcher tick, then emits a compact top-level envelope with `emit`, `reason`, `recommendedAction`, `recommendedActionPolicy`, quiet-duration fields, stuck-risk advisory fields, `nextAction.actionClass`, `nextAction.recoveryDetail`, and optional `humanAction`.
Approved `merge-cleanup` and `linear-refresh` tail steps stay human-required and surface as operator-decision actions instead of being started by the supervisor poller.
Plain `workflow run monitor` remains read-only, while `workflow run monitor --advance` and `workflow run watch --once` are the explicit write-limited polling modes that can update advisory baselines for `momentum-native-coding` runs.
`test/fixtures/workflow-gui-contract.json` freezes the watch envelope keys, next-action operator classes, recovery-detail presence, common GUI scenarios, event envelope keys, event keys, and event types so app clients can branch without terminal scraping.

`run/events.ts` is the durable workflow event replay seam behind `workflow run events`.
It projects stable semantic events from workflow rows, combines them with append-only `workflow_events` rows for overwritten transitions and supervisor advisories, and returns opaque replay cursors so reconnecting clients can continue from the previous response cursor without relying on stdout or process state.

`monitor/watch-stream.ts` and `monitor/watch-stream-source.ts` are the read-only JSONL stream seam behind `workflow run watch --stream --jsonl`.
The driver polls the durable event cursor API on its bounded interval, writes each stream record immediately, retains only the cursor and counters between polls, emits `emit: true` records only for semantic events, emits `emit: false` heartbeats for liveness, and exits when the run row is terminal.
The source layer uses incremental event reads plus the durable run row terminal state so a reconnecting stream resumed past the terminal event still observes completion without dispatching work or mutating monitor advisory baselines.
The stream seam does not deliver to OpenClaw or invoke an LLM; clients decide how to consume the durable JSONL records.
