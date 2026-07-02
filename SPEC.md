# Momentum Spec

This file is the compact repo anchor for current runtime, workflow, and
documentation contracts. Long-form planning history, milestone provenance,
readiness notes, dogfood evidence, and migration rationale live in Obsidian
`/Workspaces/Momentum`.

[`VISION.md`](VISION.md) is the companion product and engineering opinion anchor.
When choosing workflow shape, preflight boundaries, recovery behavior, monitor
contracts, or GUI/operator surfaces, preserve that direction while keeping this
file focused on shipped runtime contracts.

## Runtime Model

Momentum is a workflow-first runtime for durable repo-work orchestration.

- `WorkflowDefinition` and `StepDefinition` define reusable workflow shape.
- `WorkflowRun` and `StepRun` track run and step lifecycle.
- `ExecutorInvocation` and `ExecutorRound` sit below a step and store executor
  attempts, artifacts, result summaries, verification status, commit metadata,
  recovery codes, findings, decisions, and checkpoints.
- `Goal` remains a compatibility surface and `goal-loop` executor family.

Executor families currently include `goal-loop`, `one-shot`, `script`,
`no-mistakes`, `external-apply`, and `subworkflow`.

The daemon owns scheduling, leases, recovery rechecks, gate enforcement, and
bounded progress. Executors own bounded work and may recommend `continue`,
`approval_required`, `operator_decision_required`, `manual_recovery_required`,
`blocked`, `failed`, `cancelled`, or `complete`. The daemon decides state
transitions from durable evidence.

## Native Goal-Loop Contract

The native `goal-loop` is Momentum's autonomous implementation flywheel below a workflow step.
`executor_invocation` is the whole autonomous goal-loop attempt for one workflow step.
`executor_round` is one durable iteration beneath that invocation.
The invocation owns the ordered round sequence, shared lease/checkpoint envelope, accumulated notes and learnings, and final stop condition for the attempt.
A completed round is never replayed, renamed, or overwritten to continue the loop.
A later loop iteration creates the next round under the same invocation, and a retry after terminal recovery creates a new invocation or explicitly reopened attempt according to the step recovery policy.

Goal-loop rounds reuse the repo-native executor state vocabulary rather than introducing a parallel pending/running/succeeded/failed/stale/recovered/canceled enum.
Invocation states are `pending`, `preparing`, `running`, `pausing`, `waiting_operator`, `manual_recovery_required`, `blocked`, `failed`, `succeeded`, and `cancelled`.
Round states are `pending`, `running`, `capturing_result`, `finalizing`, `mirroring_external_state`, `waiting_operator`, `manual_recovery_required`, `blocked`, `failed`, `succeeded`, and `cancelled`.
`manual_recovery_required` carries stale, recovered, invalid, and unsafe-resume cases through recovery codes and durable evidence instead of adding non-repo state names.
Stale in-flight work is detected from Momentum-owned leases and heartbeat/checkpoint age, then converted to durable recovery evidence before any continuation starts.

The runner-authored result document consumed by the shipped goal-loop mechanism remains the normalized `RunnerResult` schema.
Runner-authored results are parsed before finalization and classification, and their required fields are `success`, `summary`, `key_changes_made`, `goal_complete`, and `commit`.
`key_learnings` and `remaining_work` are optional runner-authored arrays that default to empty arrays when omitted.
The `commit` object supplies the commit intent that Momentum uses only after repository safety and verification have passed.
Inside `commit`, `type` and `subject` are required; `scope`, `body`, and `breaking` are optional intent fields.

After finalization, Momentum projects the captured runner result plus durable round evidence into the native round evidence view consumed by `workflow run logs`.
Future status, handoff, monitor, and GUI surfaces must use the same projection once they are wired to executor round evidence instead of scraping terminal text or runner-owned directories.
The `momentum.native-goal-loop.round-result.v1` fixture is a post-finalization evidence projection, not a runner-authored input document.
Its required JSON fields are `schema`, `summary`, `keyChanges`, `learnings`, `completionRecommendation`, `verificationResult`, `artifacts`, `checkpoints`, `changedFiles`, `commitSha`, `recoveryReason`, and `remainingWork`.
`completionRecommendation` is the executor's recommendation only: `complete`, `continue`, `approval_required`, `operator_decision_required`, `manual_recovery_required`, `blocked`, `failed`, or `cancelled`.
`verificationResult` records command names, exit codes, timing when available, and an overall status such as `passed`, `failed`, `skipped`, or `not_run`.
Artifacts and checkpoints are durable pointers under the round, not proof by terminal text.
`commitSha` is non-null only after Momentum has verified and recorded the successful commit for that round.
`recoveryReason` is non-null only when the round requires recovery or explains why no safe commit was created.

Successful rounds commit exactly once after verification evidence is captured.
The commit is the durable proof of a coherent unit of progress and is recorded with changed files, verification result, normalized result digest, artifacts, checkpoints, and learnings.
Failed, invalid, stale, unsafe, canceled, or no-op rounds do not create commits.
They still preserve their result document when present, verification or reset evidence, recovery reason, artifacts, checkpoints, and learnings so the next round can avoid repeating the same work.
A reset belongs to the round finalization path that detected unsafe or incomplete work; it must never manufacture a commit to make progress look cleaner.

Momentum resumes from durable executor_invocations, executor_rounds, leases, checkpoints, artifacts, commits, recovery codes, and accumulated learnings.
Resume never depends on terminal scrollback, chat transcript memory, process handles, or a runner-owned run directory.
On resume, terminal rounds remain immutable, in-flight rounds are rechecked against their lease and checkpoint evidence, stale rounds move to manual recovery or a recovered evidence state through repo-native recovery codes, and the next runnable round receives the accumulated notes/learnings from prior rounds.
The loop must preserve no duplicate completed rounds and no duplicate commits by deriving the next round index and commit ownership from durable Momentum rows.
If a round already recorded a commit SHA, resume treats that commit as owned by that round and never commits it again.
If a round never reached a safe commit boundary, resume may start a later round only after preserving the recovery reason and reset/checkpoint evidence for the stale or failed round.

GNHF is source material, a compatibility reference, or an optional runner below `goal-loop`.
GNHF's per-iteration prompt, notes, JSON result, stop condition, and commit-per-successful-iteration behavior may inform the native runner mechanism.
`.gnhf/runs` is not Momentum's durable source of truth.
Momentum's durable source of truth is the workflow run, step, executor invocation, executor round, child evidence, lease, checkpoint, commit, and recovery rows under `<data-dir>/momentum.db` plus their artifact pointers.
`gnhf` must not become a first-class executor family merely to reuse behavior.
A future GNHF-backed runner must report into native `goal-loop` invocation and round records instead of making `.gnhf/runs` authoritative.

## Workflow Safety

Human gates are first-class durable rows. Approval, operator decision, and manual
recovery boundaries must be visible through status, handoff, monitor, watch,
events, recovery, and logs surfaces. Autonomy is allowed only inside the approved envelope.

Every dispatched step must produce normalized result evidence or mirrored
external state before final classification. Process handles, hook events,
sockets, and file watchers are fast-path hints, not authoritative state.

Workflow-level preflight validates structural setup before runtime work begins:
definition resolution, approval boundary, route config, wrapper/profile schema,
canonical config keys, and result/config path shape. Side-effecting tail steps
own their own capability/auth/target/idempotency checks inside the same durable
step lifecycle that applies and reconciles the side effect.
Structural preflight evidence uses a compact stable shape:
`checkId`, `status`, `severity`, `path`, `key`, `message`, and `recommendedAction`.

## External Apply

External tracker writes are policy-gated and two-phase:

1. claim one pending update intent
2. audit before write
3. perform the external write only when repo policy allows it
4. finalize and reconcile the touched issue

The default policy is local intent creation only. The Linear path supports
comment-only `source_satisfied` intents and explicit `status_update` intents
whose payload supplies the target state (`state` or `stateId`), carries a stable
idempotency marker, and must fail closed without losing the M6 refusal reason.
Before a workflow `linear-refresh` external write is attempted, the tail
lifecycle preflight must prove `LINEAR_API_KEY` in the applying process,
`intent_apply_policy: external_apply_allowed`, a workflow issue scope, exactly
one pending Linear `status_update` intent, a matching Linear source item, a valid
payload with exactly one `state` / `stateId`, and the stable idempotency marker.
If durable M6 audit evidence already proves the intended write landed and
post-apply reconcile succeeded, `linear-refresh` reconciles without another
Linear mutation.

## Source And Adapter Boundaries

Source adapters are read-only with respect to external systems. They write only
Momentum source tables, source snapshots, reconciliation runs, evidence, and
local update intents. They must not mutate Goal, Iteration, Job, workflow,
executor, git, or external-write state.

Adapter testing stays layered:

- isolated contract tests
- stubbed integration tests
- opt-in real smoke tests
- full end-to-end composition proofs

Default CI must not call real `api.linear.app`.

## Coding Workflow Ownership

Momentum owns the future durable coding workflow runtime: workflow definitions,
workflow runs, step runs, gates, leases, executor state, evidence, recovery,
status, monitor, handoff, events, and logs.

OpenClaw remains the user-facing skill, Discord delivery layer, renderer,
compatibility surface, and fallback route while replacement behavior is proven.
Historical `cwfp-*` runs remain readable/importable compatibility state. They
must not become the primary source of truth for new Momentum-owned runs.

The NGX-499 opt-in dogfood proved a Momentum-owned coding workflow through
implementation, postflight, no-mistakes, merge cleanup, and Linear refresh.
NGX-404/default switching remains separate and must preserve rollback.

`workflow run start-coding` (NGX-508) is the explicit Momentum-native start
door: a named opt-in selector over `workflow run start` that always materializes
the built-in `coding-workflow` definition, refuses reserved `cwfp-*` / `cwfb-*` /
`overnight-*` run ids, and records the run with the `momentum-native-coding`
source so durable status/handoff/monitor/logs show it as Momentum-owned. It
captures the run's isolation inputs in durable state: repo, objective, issue
scope, approval boundary, skill revision, and the selected runtime/profile
(`route.profile`); the daemon still resolves the executing live-wrapper profile
from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time.
Native coding dispatch resolves executor families from the built-in `coding-workflow` definition for that source, even if a persisted definition with the same key/version exists.
Built-in workflow definitions are resolved by key and version; native runs must keep resolving the built-in version recorded on the run, even after a later built-in recipe becomes current.
If the recorded built-in version is unavailable, native dispatch must fail closed instead of substituting persisted rows or a later built-in version.
`workflow run preview-coding` (NGX-509) is the read-only native plan-preview door: it shares the `start-coding` preconditions and built-in definition resolution but writes nothing, emitting a frozen plan (run id, repo, objective, issue scope, approval boundary, route fields such as `route.profile` and `route.steps`, definition key/version, and every step with its executor family and on-start state) so an operator can inspect the proposed run before approval or execution.
The preview is a pure projection of the version-pinned built-in definition plus inputs, so a later `start-coding` from the same inputs persists a matching run, and the frozen plan can be reconstructed from the run's recorded `(definition key, version)` for approval/dispatch to reference.
Structural preflight is shared by the native coding start and preview doors before durable run writes: missing built-in definition versions, blank required repository paths, invalid approval boundaries, invalid issue-scope identifiers, blank route profiles, and invalid route steps fail closed with `preflightEvidence`.
NGX-510 adds native per-step coding route/config overrides to the coding doors: `workflow run start-coding` / `workflow run preview-coding` accept `--steps-json <json>`, a sparse object keyed by the configurable coding steps (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`) carrying `harness`/`model`/`effort` string fields.
Selections are validated and normalized to a byte-stable `route.steps` namespace on the durable run route, parallel to `route.profile` and `route.subworkflow`; absent steps/fields defer to defaults, and an unsupported step, unknown field, blank value, or malformed JSON fails closed with `route_config_invalid` (and writes nothing), while the generic `workflow run start` refuses the flag with `route_config_not_allowed`.
Provider-specific model aliases are part of that normalization when the same step supplies the matching harness: known Claude aliases persist as pinned Claude Code model strings, known Codex aliases persist as un-namespaced Codex CLI model ids, and known OpenCode aliases persist as provider-qualified OpenCode model ids, while unknown harness/model values remain free-form.
`route.steps` records the operator's per-step selection for durable audit by status/handoff/monitor/logs and for dispatcher-created executor-round selection; it stays distinct from the daemon's `MOMENTUM_LIVE_WRAPPER_PROFILE` execution profile.
NGX-511 adds a native progress-monitor projection to `workflow run monitor` for explicit `momentum-native-coding` runs.
The monitor envelope derives from durable rows, exposes `manualRecoveryReason`, and includes `progress` fields for phase, digest, changed/emit suppression, current step, last event, next action, blocker reason, terminal status, and cleanup.
`nextAction` includes the low-level monitor code plus `actionClass` and `recoveryDetail`, so status, handoff, monitor, and watch consumers can distinguish polling, approval, setup repair, deterministic no-mistakes reconciliation, external-tail reconciliation, gate resolution, ordinary retry, recovery clearing, and monitor release without parsing prose.
Clean terminal progress requires terminal durable state, no recovery object, and `nextAction.code: "no_action"`; a stale durable manual-recovery flag by itself does not keep an operator-reconciled succeeded run in `blocked`, so the monitor releases after `workflow run clear-recovery`.
The deterministic digest excludes volatile timestamps, lease heartbeat / expiry churn, and evidence ordering while including durable manual-recovery reasons and open gate identity so repeated unchanged ticks can be suppressed.
Plain monitor reads do not write.
`--advance` is accepted only for `momentum-native-coding` runs and persists only `monitor_last_seen_digest` / `monitor_last_seen_at` plus `monitor_last_emitted_digest` / `monitor_last_emitted_at` when the tick emits; generic workflow starts, imported `cwfp-*` compatibility runs, and fallback CWFP behavior remain unchanged.
`workflow run watch --once` builds on the same monitor projection, but first runs at most one run-scoped dispatcher tick when the target native run exposes an approved `advance_to_step` action or an active running step is eligible for a scheduler recheck, and has no open gate, recovery, or manual-recovery flag.
The watch tick re-reads durable state after that bounded dispatch, persists the same digest / timestamp advisory baselines as monitor advance, and still never resolves gates, approvals, or recovery decisions by itself.
NGX-549 freezes the `workflow run watch --once --json` supervisor envelope as the wire contract cron, OpenClaw, and a future GUI consume, so downstream adapters never scrape prose or terminal text.
Its top-level field set is fixed, `emit` is the machine-polling signal that suppresses repeated identical ticks below the quiet threshold while still surfacing meaningful changes and throttled quiet advisories, and it adds the watch-derived `recommendedAction`, `recommendedActionPolicy`, `nextPollSeconds`, `quietForSeconds`, `quietThresholdSeconds`, `stuckRisk`, `inspectionCommand`, and `humanAction` fields over the shared monitor projection so a consumer can branch and render a concise human update without a follow-up `workflow status` read.
The envelope shape, enum vocabularies (`reason`, `disposition`, `phase`, `cleanup`, `recommendedAction`, `stuckRisk`, `nextAction.code`, `nextAction.actionClass`, and `humanAction.code`), and common GUI scenarios are frozen by `test/fixtures/workflow-gui-contract.json` and `test/workflow-watch-contract.test.ts`, which fail if a required field disappears, an enum value drifts, or a scenario loses its expected human action, null action, failed-step next action, compact recovery detail, or stuck-risk inspection command.
Supervisor action policy metadata classifies known watch, monitor, recovery, gate, and external-tail actions with `authority` (`auto_allowed`, `recommend_only`, `human_required`, or `forbidden`), `risk`, `evidenceRequired`, `rollback`, and a short rationale. `auto_allowed` is an explicit allowlist for safe wait/release/read-only or local recheck cases only. Approval/operator decisions, clear-recovery, stale manual recovery, no-mistakes recovery, merge cleanup, Linear refresh, and external-apply require human authority. Destructive/default-switch/broad external actions are forbidden and must surface as blocked policy metadata, not silent execution. If policy metadata is absent or invalid, consumers must fail closed by treating every non-wait action as `human_required`.
NGX-550 extends the supervisor envelope with quiet-duration and stuck-risk hints for fast pollers that should stay quiet during healthy unchanged ticks.
The quiet thresholds are centralized in the watch advisory reducer: implementation 15m, postflight 10m, no-mistakes 15m, merge-cleanup 5m, linear-refresh 5m, approval reminders 30m, recovery reminders 60m, and idle 15m.
An unchanged tick remains `emit: false` until its threshold window is reached; threshold emissions use `reason: "quiet_heartbeat"` for approval / recovery / idle reminders or `reason: "stuck_risk"` for active execution, include elapsed `quietForSeconds`, the applied `quietThresholdSeconds`, and an inspection command when active execution may be stuck.
These hints are advisory only: they never mark a run or step failed, never mutate execution lifecycle state, and never trigger LLM diagnosis in the CLI.
NGX-551 adds `workflow run events` as the durable semantic replay API for supervisors and app clients that reconnect after process loss.
It combines reproducible facts from workflow runs, steps, approvals, gates, and terminal run state with append-only `workflow_events` rows for overwritten or advisory transitions, including manual-recovery mark / clear, blocked-step metadata, retry / reconciliation preservation, and throttled quiet or stuck-risk watch advisories.
Returned cursors are opaque replay tokens, not event identities; clients persist the response `cursor` for the next `--since` call and use event `id` only for dedupe.
The GUI event envelope, per-event key set, cursor namespace, and event-type vocabulary are frozen by `test/fixtures/workflow-gui-contract.json` and `test/workflow-events.test.ts`.
The API is replay-only and read-only: it does not hold a connection open, dispatch work, or change monitor/watch delivery semantics.
NGX-552 adds `workflow run watch <run-id> --stream --jsonl` as the long-lived JSONL stream over that durable event cursor API.
The stream is read-only, resumes from `--since`, emits `event` records with `emit: true` only for durable human-worthy semantic events, emits `heartbeat` records with `emit: false` for liveness, retains only the cursor and counters between polls, and exits cleanly once the run row is terminal.
When `--jsonl` is present, stream validation and usage failures use the shared JSON failure envelope instead of prose while usage errors still exit 2.
It never runs the bounded watch dispatcher tick, writes monitor advisory baselines, delivers to OpenClaw, or invokes an LLM; durable events remain the source of truth for disconnected clients.
NGX-553 adds `openclaw supervise <run-id> --once` as the OpenClaw delivery wrapper over `workflow run watch --once --json`.
It keeps the raw watch envelope as the workflow supervisor contract while adding OpenClaw-specific delivery suppression, sanitized inspection commands, terminal monitor cleanup, and per-run local state files under `<data-dir>/openclaw-supervisor/<encoded-run-id>.json`.
The wrapper requires `--once`, refuses stream/jsonl mode, writes success envelopes to stdout and structured failures to stderr in JSON mode, preserves already-emitted watch advisories when local state persistence fails, and disables further watch execution once terminal cleanup has marked the monitor removable through an explicit `auto_allowed` `release_monitor` action policy.
`openclaw supervise --help` and `openclaw supervise -h` print focused supervise usage and operator notes before run-id or `--once` validation, while `openclaw --help` remains shared top-level CLI help.
NGX-554 extends that wrapper with host delivery intents for Discord/OpenClaw: emitted ticks carry a short sanitized message, optional action/evidence, wake/message routing, dedupe and reminder keys, terminal cleanup hints, and retry metadata, while suppressed ticks carry `deliveryIntent: null`.
OpenClaw local auto-actions remain config-gated through `MOMENTUM_OPENCLAW_AUTO_ACTIONS`, execute only explicitly supported `auto_allowed` policies, append per-attempt audit JSONL beside the supervisor state before applying any local state change, append the intended saved status before the state write plus a matching failed status row if that write fails, bound repeated `release_monitor` state-save attempts to three saved records per digest while letting a failed status row cancel only its own attempt, and fail closed to human-required when policy support, repeat bounds, or audit persistence are ambiguous.
The `release_monitor` repeat bound never re-enables an already disabled monitor; once disabled, a monitor at the bound repeats cleanup without appending another auto-action audit record.
When the config gate is disabled, benign `watch_recheck` and `monitor_recheck` recommendations pass through unaudited while other supported auto-actions fail closed for human review.
Fail-closed auto-action escalations preserve sanitized human-review delivery text, suppress monitor-removal cleanup unless a disabled-monitor escalation audit was saved, and treat required pre-state-write audit status failure as a nonzero `openclaw_auto_action_audit_failed` refusal.
Momentum still does not post webhooks, wake external lanes, remove external monitors, or rewind supervisor state when a host delivery attempt fails.
NGX-521 hardens native dogfood tail recovery without changing the default route.
Failed required `merge-cleanup` and `linear-refresh` steps classify as `failed_external_side_effect_step` so operators verify the canonical external state - pull request merge or close state and any surviving remote branch ref for `merge-cleanup`, or tracker state for `linear-refresh` - then reconcile through `workflow run clear-recovery --evidence-pointer <ref>` instead of blindly re-running side-effecting tail work.
Status, handoff, monitor, and watch expose that lane as `nextAction.actionClass: "reconcile_external_tail"` with `recoveryDetail.kind: "external_tail_reconcile"`.
The checked-in live-wrapper dogfood profile executes the wrapper from source through the TypeScript source loader so cleanup of generated `dist/` artifacts does not break `merge-cleanup` or `linear-refresh` tail work.
The wrapper validates `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG` before spawning a child command: the top level is limited to `steps`, per-step keys must use the canonical snake_case schema, malformed `env_allow` and unsafe or mismatched `result_file` values fail closed as setup recovery, and rejected configs write no runner evidence.
The `merge-cleanup` wrapper owns its side-effecting tail lifecycle: preflight proves explicit GitHub auth (`GH_TOKEN`, `GITHUB_TOKEN`, or `GH_CONFIG_DIR`), durable target identity (`merge_cleanup.pull_request_id`, `expected_head_sha`, and `cleanup_branch`), and live PR state/head/mergeability in the same worker before apply can spawn the merge command; already-merged or already-deleted cleanup state routes to reconcile instead of another mutation. This remains tail-local and is not promoted into workflow-level structural preflight.
The `linear-refresh` daemon tail owns the same preflight -> apply -> reconcile shape around the existing M6 external-apply path: missing auth, missing source item, missing/duplicate/stale intent, invalid payload, policy denial, or mismatched audit evidence fails closed before the Linear client is called; already-applied succeeded audit evidence maps to terminal executor evidence instead of generic update-step repair.
For the `no-mistakes` step, the same live-wrapper treats a reported `checks-passed` outcome, or an otherwise-still-monitoring run with current clean pull request evidence and green or explicitly absent checks, as terminal Momentum success only when no current blocking outcome, active finding, unresolved gate, dirty / draft pull request, or non-successful check state is present.
Interrupted no-mistakes success reconciliation is surfaced as `nextAction.actionClass: "reconcile_deterministic_evidence"` with `recoveryDetail.kind: "no_mistakes_deterministic_evidence"` until the operator supplies the evidence pointer.
If the wrapper dies before writing that terminal evidence but the external no-mistakes run later proves success, `workflow run clear-recovery` may reconcile only the failed required `no-mistakes` step from durable rows and then re-derive the run; generic terminal run mutation remains refused.
That reconciliation accepts the legacy `--evidence-pointer no-mistakes:<run-id>#checks-passed` path and a structured deterministic evidence JSON path whose schema records the workflow run id, issue scope, branch and head SHA, pull request identity and checks when present, no-mistakes run id, zero unresolved findings or decisions, and explicit review, test, docs, lint, format, push, PR, and CI phase statuses.
Structured evidence is refused when its schema, identity, findings, check state, outcome, or phase statuses are unknown, stale, ambiguous, partial, mismatched, unresolved, pending, failed, or otherwise non-successful.
CWFP remains the default coding-workflow start and rollback route; the default switch stays NGX-404.

## Runtime Consolidation

Runtime consolidation uses explicit decisions:

- **Keep**: current production paths still required for compatibility or safety.
- **Deprecate-later**: paths that narrow only after their named proof lands.
- **Defer**: paths outside the current issue scope.

No consolidation plan authorizes production deletion by itself. RC-1, RC-1b,
RC-1c, RC-2, RC-3, RC-4, RC-4b, RC-5, and RC-5b have landed. The RC-2
reconciliation seam is the single production owner for finalizing M10-dispatched
workflow steps from durable terminal executor evidence and must prevent
double-finalize and double-write behavior.

## Architecture Contract

The current source layout is:

```text
src/index.ts              process entrypoint only
src/cli.ts                parser, top-level dispatch, compatibility surfaces
src/commands/             command-family modules
src/renderers/            text / JSON envelope rendering helpers
src/adapters/             infrastructure-facing clients and runtime adapters
src/config/               env, path, and default-resolution support
src/shared/               cross-cutting helpers with no narrower domain owner
src/core/<domain>/        workflow, executors, goal, source, intent, daemon, repo, evidence
```

Import direction is fixed:

```text
index -> cli -> commands -> renderers
                   |
                   v
            domain modules -> adapters / persistence
```

Domain modules must not import command modules or renderers. Renderers must not
mutate state. External adapters stay behind domain or command boundaries with
explicit policy checks.

## Milestone Provenance Anchor

The current source architecture baseline is Milestone 11: CLI Architecture
Refactor, closed through NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416,
NGX-417, NGX-418, and NGX-419.

Earlier milestone issue ranges preserved in Obsidian:

- M3: NGX-272 through NGX-278
- M4: NGX-279 through NGX-286
- M5: NGX-287 through NGX-294
- M6: NGX-295 through NGX-302
- M7: NGX-312 through NGX-319
- M8: NGX-323 through NGX-330
- M9: NGX-331 through NGX-338
- M10: NGX-344 through NGX-353, with NGX-367 inserted as M10-09a

M10 issue sequence: NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349,
NGX-350, NGX-351, NGX-352, NGX-367, NGX-353.

Current behavior belongs in source, tests, `README.md`, `ARCHITECTURE.md`,
`AGENTS.md`, `SPEC.md`, and public/operator docs. Historical milestone detail
belongs in Obsidian.

## Documentation Boundary

The repository must not contain an `internal/` documentation tree. Durable
internal docs live in Obsidian `/Workspaces/Momentum`; repo anchors stay short
and live only in `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `SPEC.md`, or
narrowly scoped operator docs under `docs/`.

There are no standing exceptions for repo-local `internal/` docs.
If a future exception is ever needed, it must be explicit, reviewed, and protected by the docs-boundary tests.

If a future note grows into planning, contract narrative, milestone provenance,
readiness evidence, dogfood evidence, or migration rationale, move it to
Obsidian and keep at most a compact repo anchor.
