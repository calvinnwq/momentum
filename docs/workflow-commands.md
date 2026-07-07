# Workflow commands

Operator-facing CLI envelopes for the `workflow run start`, `workflow run start-coding`, `workflow run preview-coding`, `workflow import`, `workflow status`, `workflow handoff`, `workflow run list`, `workflow run approve`, `workflow run decide`, `workflow run update-step`, `workflow run clear-recovery`, `workflow run monitor`, `workflow run watch`, `workflow run events`, and `workflow run logs` commands.

- `workflow run start` starts a first-class workflow run from a validated workflow definition: it resolves the definition (a persisted definition, or the built-in `coding-workflow` recipe), loads repo policy, and durably materializes a `workflow_runs` row plus one ordered `workflow_steps` row per definition step, with an approval row when an approval boundary is supplied.
  `goal start` remains the compatibility path for the older Goal loop.
- `workflow run start-coding` is the explicit Momentum-native coding-workflow start door: a thin selector over `workflow run start` that always uses the built-in `coding-workflow` definition, refuses run ids reserved for compatibility imports, and records the run with a Momentum-native source so it is unmistakably Momentum-owned.
  Use it to intentionally choose Momentum orchestration for a new coding workflow; the ordinary definition-sourced start and the imported compatibility runs are unchanged.
- `workflow run preview-coding` is the read-only plan preview for the Momentum-native coding workflow: it runs the same precondition checks and built-in definition resolution as `workflow run start-coding` but stops before any durable write, emitting a frozen plan an operator can inspect before approval or execution.
  It writes nothing and surfaces the run id, repo, objective, issue scope, approval boundary, route/profile, implementation engine, and per-step route selections, definition key/version, repo policy, and every step with its executor family.
- `workflow import` reads local `.agent-workflows/<run-id>/` directories and persists normalized rows into the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables.
- `workflow status` is a read-only surface that lists workflow runs (with state / filter selectors) or returns the full detail of a single run.
- `workflow handoff` is a read-only surface that emits a machine-readable next-action envelope for one run.
- `workflow run list` is a read-only filterable query surface over the durable `workflow_runs` table, with additional filter dimensions not available in `workflow status` list mode.
- `workflow run approve` records durable explicit approvals for workflow boundaries and persists operator-visible metadata (actor, phrase, artifact provenance) into `workflow_approvals`.
- `workflow run update-step` drives operator-initiated step transitions (`approved` / `succeeded` / `skipped` / `failed` / `blocked` / `canceled`) through the existing state machine, persisting an audit record with operator reason and optional evidence or ledger pointers.
- `workflow run clear-recovery` explicitly clears a run's durable manual-recovery flag after the blocking condition is resolved.
- `workflow run decide` resolves a durable workflow / step / executor gate by routing an operator or delegated-policy decision through the gate brain: an operator may pick any allowed action, while `--mode delegated` may only auto-apply an action inside the gate's policy envelope.
- `workflow run monitor` is read-only by default and emits one stable JSON shape per run, derived from durable rows and the monitor reducer, so a monitor runner can decide whether to report, wait, or ask an operator to recover without parsing prose or scraping artifacts.
  Its opt-in `--advance` mode is restricted to Momentum-native coding runs and writes only advisory digest / timestamp baselines for progress suppression.
- `workflow run watch` watches a run two ways.
  `--once` emits a one-shot supervisor envelope for a Momentum-native coding run: it safely runs at most one run-scoped dispatcher tick when the target run has one approved non-tail next step or one active step eligible for recheck, then persists the same advisory suppression baseline as a monitor advance tick and gives external pollers one recommended next action.
  Approved `merge-cleanup` and `linear-refresh` tail steps are surfaced as operator decisions instead of being started by the poller.
  `--stream --jsonl` instead opens a read-only, long-lived JSONL event stream over the durable event cursor API for a TUI, GUI, or sidecar, resumable from a `--since` cursor and bounded in memory.
- `workflow run events` is a read-only replay surface for supervisors and app clients that need semantic run changes after reconnecting.
  It returns ordered event records from durable workflow state and append-only workflow event rows without reading stdout scrollback or running dispatch.
  It is the catch-up substrate for stream mode and discrete pollers, not a replacement for live polling by itself.
- `workflow run logs` is a read-only run-scoped log and evidence reader that reuses the workflow detail shape and attaches executor invocations, executor rounds, and their child artifacts, checkpoints, findings, and decisions.

`workflow run preview-coding`, `workflow status`, `workflow handoff`, `workflow run list`, `workflow run events`, and `workflow run logs` are read-only: they never write SQLite or files.
`workflow run monitor` is also read-only unless `--advance` is passed, in which case supported Momentum-native coding runs persist only `monitor_last_seen_digest` / `monitor_last_seen_at` and `monitor_last_emitted_digest` / `monitor_last_emitted_at` progress baselines.
`workflow run watch --once` is write-limited to the target run's safe dispatcher tick, the same advisory baseline columns, and append-only quiet-heartbeat / stuck-risk event rows for supported Momentum-native coding runs.
That dispatcher tick does not start approved `merge-cleanup` or `linear-refresh` tail steps; those side-effecting steps stay on a human-required operator-decision path.
`workflow run watch --stream` is read-only: it replays durable events and reads the run's terminal state without writing SQLite or files, running dispatch, delivering to OpenClaw, or invoking an LLM.

`workflow run --help` and any nested `workflow run ... --help` or `workflow run ... -h` invocation print the shared top-level CLI help to stdout and exit 0 before selecting or validating a run subcommand.
This help path ignores `--json`, reads no data directory, and performs no durable writes.

## GUI-ready contracts for Momentum orchestration

GUI and sidecar surfaces should treat these endpoints as the stable source of truth.
Read-only calls can render run state without terminal scraping.
State-advancing and mutation calls are explicit and must be opt-in.
The examples below are branching examples; the full `workflow run watch --once` and `workflow run events` envelope key sets remain the command-section contract.

### Read-only surfaces

- `workflow run list`.
  Use this for paged, filterable run discovery.
  The response carries filter echoes and `{ run, counts, monitor }` entries.
  Feed a selected `runId` into `workflow status` or `workflow handoff` for detail.
- `workflow status <run-id>`.
  This is the active run detail surface and includes `run`, `steps`, `approvals`, `leases`, `monitor`, `evidence`, and `gates`.
  It is the durable place to render step state, recovery flags, and open gates before prompting an action.
- `workflow handoff <run-id>`.
  This mirrors status detail and lifts `nextAction` to the top level, including the compact `actionClass` and `recoveryDetail` fields.
  OpenClaw and GUI runners use it for a compact actionable dispatch summary.
- `workflow run monitor`.
  This is the stable progress discriminator for recurring poll loops.
  Plain monitor reads the progress projection without advancing advisory baselines.
- `workflow run watch --stream` and `workflow run events`.
  These share the durable event cursor contract.
  They provide idempotent replay when polling disconnects.
- `workflow run logs`.
  This is the stable evidence view for UI drill-down.
  Render it when a user opens a completed or failed run for review.

### State-advancing poll surface

- `workflow run watch --once`.
  This is the compact supervisor envelope used for regular GUI polling.
  It is write-limited to a safe non-tail run-scoped dispatcher tick, advisory monitor baselines, and append-only supervisor advisory events for supported Momentum-native coding runs.
  If the next approved step is `merge-cleanup` or `linear-refresh`, the tick reports an operator decision rather than starting the side-effecting tail step.
- `workflow run monitor --advance`.
  This is the write-limited monitor mode for supported Momentum-native coding runs.
  It persists only advisory progress-suppression baselines and must be an explicit polling choice, not a read-only status call.

### Mutation actions

- `workflow run approve <run-id>`.
  Resolve approval requirements.
- `workflow run decide <gate-id>`.
  Resolve a gate with an allowed action.
- `workflow run clear-recovery <run-id>`.
  Clear manual-recovery flags once the operator has reconciled the blocking cause.
- `workflow run update-step <run-id>`.
  Make an operator step transition.
  This is a manual repair path and is intentionally explicit.

### Contract examples for GUI states

- Running / progressing state is a `watch` tick with `reason: "in_progress"` and `recommendedAction: "poll"`.
  The command should treat `emit` as the polling signal and use `nextPollSeconds` for backoff.
  ```json
  {
    "emit": true,
    "reason": "in_progress",
    "disposition": "wait",
    "phase": "advancing",
    "recommendedAction": "poll",
    "humanAction": null,
    "nextPollSeconds": 15,
    "quietForSeconds": 0,
    "quietThresholdSeconds": 900,
    "stuckRisk": "low",
    "cleanup": "none"
  }
  ```

- Approval state is a `watch` tick with `reason: "awaiting_approval"`, `recommendedAction: "approve"`, and a `humanAction.code == "approve"` command.
  ```json
  {
    "emit": true,
    "reason": "awaiting_approval",
    "disposition": "report",
    "phase": "awaiting_approval",
    "recommendedAction": "approve",
    "humanAction": {
      "code": "approve",
      "command": "momentum workflow run approve <run-id> --approval-boundary ...",
      "detail": null,
      "gateType": null
    },
    "nextPollSeconds": 30,
    "quietThresholdSeconds": 1800,
    "stuckRisk": "medium",
    "cleanup": "none"
  }
  ```

- Recovery state is a `watch` tick with `reason: "recovery_required"`, `recommendedAction: "recover"` or `"operator_decision"`.
  It must include the relevant recovery metadata and never be treated as terminal.
  ```json
  {
    "emit": true,
    "reason": "recovery_required",
    "disposition": "recover",
    "phase": "blocked",
    "recommendedAction": "recover",
    "humanAction": {
      "code": "clear_recovery",
      "command": "momentum workflow run clear-recovery <run-id>",
      "detail": null,
      "gateType": null
    },
    "nextPollSeconds": 30,
    "quietThresholdSeconds": 3600,
    "stuckRisk": "high",
    "cleanup": "none"
  }
  ```

- Stuck-risk state is `reason: "stuck_risk"`.
  It is non-fatal and may include an inspection command.
  ```json
  {
    "emit": true,
    "reason": "stuck_risk",
    "disposition": "wait",
    "phase": "advancing",
    "recommendedAction": "poll",
    "humanAction": null,
    "inspectionCommand": "momentum workflow run monitor <run-id> --data-dir ... --advance --json",
    "nextPollSeconds": 15,
    "quietForSeconds": 900,
    "quietThresholdSeconds": 900,
    "stuckRisk": "medium",
    "cleanup": "none"
  }
  ```

- Terminal success and terminal canceled states are stop states.
  They use `recommendedAction: "release"` and `cleanup: "release"`.
  ```json
  {
    "emit": true,
    "reason": "terminal_succeeded",
    "disposition": "report",
    "phase": "terminal",
    "recommendedAction": "release",
    "humanAction": null,
    "nextPollSeconds": 0,
    "quietThresholdSeconds": 0,
    "stuckRisk": "low",
    "cleanup": "release"
  }
  ```

- Recoverable failure is a required-step failure that keeps the run actionable.
  It uses `disposition: "recover"`, `reason: "recovery_required"`, and `recommendedAction: "operator_decision"`.
  ```json
  {
    "emit": true,
    "reason": "recovery_required",
    "disposition": "recover",
    "phase": "blocked",
    "recommendedAction": "operator_decision",
    "humanAction": null,
    "nextPollSeconds": 30,
    "quietThresholdSeconds": 3600,
    "stuckRisk": "high",
    "cleanup": "none"
  }
  ```

- Approved side-effecting tail steps are operator-decision states even when the low-level next action is `advance_to_step`.
  The poller must not start `merge-cleanup` or `linear-refresh` from this state.
  ```json
  {
    "emit": true,
    "reason": "in_progress",
    "disposition": "wait",
    "phase": "advancing",
    "nextAction": {
      "code": "advance_to_step",
      "stepId": "merge-cleanup",
      "actionClass": "operator_decision"
    },
    "recommendedAction": "operator_decision",
    "humanAction": null,
    "nextPollSeconds": 15,
    "quietThresholdSeconds": 300,
    "stuckRisk": "low",
    "cleanup": "none"
  }
  ```

### Event-cursor behavior for GUI replay

`workflow run events` returns `ok`, `command`, `dataDir`, `runId`, `since`, `cursor`, `events`, and `counts`.
Each event carries `id`, `cursor`, `timestamp`, `type`, `stepId`, and `payload`.
The response `cursor` is the last returned event cursor.
When no events are newly emitted, `cursor` repeats the supplied `since` value.
Passing the returned `cursor` as next `--since` is idempotent.
Only the `wfcur1.` cursor namespace is accepted.

See also:

- [docs/data-directory.md](data-directory.md) — the workflow, gate, executor invocation / round, and executor child-evidence table schemas.
- [docs/evidence-commands.md](evidence-commands.md) — `evidence ingest` and `evidence list` envelopes for the `evidence_records` table.

## `workflow run start`

```text
momentum workflow run start --run-id <id> --repo <path> --objective <text> [--definition <key>] [--definition-version <n>] [--approval-boundary <boundary>] [--skill-revision <text>] [--issue-scope <identifier>] [--profile <name>] [--data-dir <path>] [--json]
```

Starts a first-class workflow run from a validated workflow definition and emits a stable JSON/text envelope. This is the definition-sourced start surface; `goal start` is left intact as the compatibility path for the older Goal loop.

Required arguments:

- `--run-id <id>` - the new run's identifier. Must be unique; a duplicate refuses with `run_exists` and leaves the existing run untouched.
- `--repo <path>` - the repository the run operates on.
- `--objective <text>` - the run objective recorded on the `workflow_runs` row.

Optional arguments:

- `--definition <key>` - the workflow definition key to start from. Defaults to `coding-workflow`.
- `--definition-version <n>` - pin a specific definition version.
  When omitted, the latest persisted version, or the latest known built-in version when fallback is used, is selected.
- `--approval-boundary <boundary>` - promote the steps the boundary covers to `approved` and open the run in `approved` rather than `pending` (same boundary coverage as [`workflow run approve`](#workflow-run-approve)).
- `--skill-revision <text>` - record the skill revision that started the run.
- `--issue-scope <identifier>` - record an issue-scope identifier on the run.
- `--profile <name>` - record the trimmed selected runtime/profile on the run's durable `route.profile` so status, handoff, monitor, and logs can report which profile the run was started for.
  Blank profile values are refused before the run is written.
  This captures the operator's intent in durable state; the daemon still resolves the live-wrapper profile it actually executes from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time.

Behaviour:

- **Definition resolution**: a persisted definition for `--definition` (optionally pinned by `--definition-version`) wins.
  When no matching definition is persisted, the built-in `coding-workflow` recipe is the fallback, so a fresh database can still start the canonical workflow.
  The fallback is persisted into `workflow_definitions` / `step_definitions` before the run is written.
  An unresolved key/version refuses with `definition_not_found`.
- **Repo policy loading**: `<repo>/MOMENTUM.md` is loaded and validated. A present-but-malformed policy refuses the start with `policy_invalid` and writes nothing; an absent policy is allowed and reported as `policy.present: false`.
- **Materialization**: on success the command durably writes one `workflow_runs` row plus one ordered `workflow_steps` row per definition step, linking the run to the definition it started from (`workflow_definition_key` / `workflow_definition_version`). The run `source` is `workflow-definition`.
- **Approval boundary**: when `--approval-boundary` is supplied, the pending steps the boundary covers are persisted as `approved`, a `workflow_approvals` row is recorded with synthetic `workflow-run-start://<run-id>/<boundary>` provenance, and the run state is derived as `approved`; otherwise every step is `pending` and the run state is `pending`.
- **Execution**: `workflow run start` only materializes durable run state.
  Approved steps are claimed by bounded `daemon start --max-*`, which dispatches supported executor families into durable `executor_invocations` / `executor_rounds` scaffold rows with deterministic dispatcher ids and leaves register-only `daemon start` inert.
  The initial scaffold is ownership evidence only; result, artifact, verification, commit, and recovery fields remain empty until an executor fills them.
  Native coding runs with `route.steps` freeze the selected per-step harness/model/effort on the dispatcher-created round as agent/model/effort metadata before execution; a corrupt persisted `route.steps` namespace routes to manual recovery with `route_config_invalid` instead of silently falling back.
  The `external-apply` family is filled by the daemon itself for the built-in `linear-refresh` step: it proves `LINEAR_API_KEY`, repo `intent_apply_policy: external_apply_allowed`, the run issue scope, a matching source item, and either one pending Linear `status_update` intent or enough unique issue-scope/source evidence to seed the expected pending `status_update` intent with a `Done` payload deterministically.
  The resulting intent must have a valid one-of `state` / `stateId` payload and a stable idempotency marker before the daemon reuses the policy-gated `intent apply --external-apply` write path.
  Successful apply records terminal evidence and reconciles the step; already-applied successful audit evidence can be reconciled without another Linear mutation.
  Missing/ambiguous context, missing credentials, policy denial, duplicate/stale or mismatched intent/audit evidence, invalid payload, a missing resolved target, or any other unsafe apply refusal routes to manual recovery before the adapter client is called.
  Configured `subworkflow` steps are also filled by the daemon itself: child config comes from the parent run's `route.subworkflow.child`, recursion lineage is bounded through `route.subworkflow.lineage`, the child run starts or attaches by workflow definition key, and terminal child evidence is mirrored back to the parent step; missing config, unsafe recursion, unresolved child definitions, unsupported attachment, invalid child state, or ambiguous child terminals route to manual recovery.
  When `MOMENTUM_LIVE_WRAPPER_PROFILE` points managed-loop `daemon start` at a valid workflow live-wrapper profile, the daemon runs configured live-wrapper-owned step wrappers after the scaffold is created, records terminal executor evidence, and reconciles the step from that evidence.
  With no profile, supported live-wrapper-owned steps keep the start scaffold and wait for a later executor path; a configured profile that omits the dispatched kind routes that step to manual recovery rather than reporting fake success.
- **No clobber**: a duplicate `--run-id` refuses with `run_exists` and never overwrites the existing run.

### JSON envelope (success)

```json
{
  "ok": true,
  "command": "workflow run start",
  "dataDir": "/path/to/data",
  "runId": "run-1",
  "source": "workflow-definition",
  "state": "pending",
  "approvalBoundary": null,
  "definitionKey": "coding-workflow",
  "definitionVersion": 1,
  "route": {},
  "implementationEngine": null,
  "repoPath": "/path/to/repo",
  "objective": "Ship the feature",
  "counts": { "steps": 6 },
  "policy": { "present": false, "path": "/path/to/repo/MOMENTUM.md" }
}
```

`state` is `approved` and `approvalBoundary` echoes the supplied boundary when `--approval-boundary` is used; otherwise `state` is `pending` and `approvalBoundary` is `null`.
`route` is the durable run route as persisted, and `implementationEngine` is the selected coding implementation path when the route includes one.
`counts.steps` is the number of materialized step rows.
`policy.present` is `true` only when a valid `MOMENTUM.md` was loaded; `policy.path` is always the resolved `MOMENTUM.md` path.

### JSON envelope (failure)

```json
{
  "ok": false,
  "command": "workflow run start",
  "code": "run_exists",
  "message": "Workflow run already exists: run-1.",
  "dataDir": "/path/to/data",
  "runId": "run-1"
}
```

`dataDir` and `runId` are included whenever they are known at the point of failure.
Structural preflight failures may also include `preflightEvidence`, a compact array of `{ checkId, status, severity, path, key, message, recommendedAction }` entries that identify the failed setup check and the corrective action.
The `invalid_run_start` refusal additionally carries an `errors` array of `{ code, message, path? }` entries from the run-start materialization taxonomy:

```json
{
  "ok": false,
  "command": "workflow run start",
  "code": "invalid_run_start",
  "message": "Invalid workflow run start: approval_boundary_invalid",
  "dataDir": "/path/to/data",
  "runId": "run-bad",
  "errors": [
    {
      "code": "approval_boundary_invalid",
      "message": "Approval boundary is not a known workflow approval boundary.",
      "path": "approvalBoundary"
    }
  ],
  "preflightEvidence": [
    {
      "checkId": "workflow.run_shape",
      "status": "failed",
      "severity": "error",
      "path": "approvalBoundary",
      "key": "approvalBoundary",
      "message": "Approval boundary is not a known workflow approval boundary.",
      "recommendedAction": "Set approvalBoundary to a supported workflow approval boundary or omit it for manual approval."
    }
  ]
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `--run-id` was not supplied. |
| `repo_required` | `--repo` was not supplied, or the supplied repository path was blank. |
| `objective_required` | `--objective` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `definition_not_found` | No workflow definition matches `--definition` (and `--definition-version`, when supplied), and the built-in fallback did not match either. |
| `policy_invalid` | `<repo>/MOMENTUM.md` is present but malformed; the start is refused and nothing is written. |
| `invalid_run_start` | Run-start materialization rejected the inputs; carries an `errors` array. |
| `run_exists` | A workflow run with `--run-id` already exists; the existing run is left untouched. |
| `route_config_invalid` | `--profile` was supplied but blank, or a coding door received an unsupported `--implementation-engine`; invalid profile failures carry structural `preflightEvidence` and write nothing. |
| `route_config_not_allowed` | `--implementation-engine` or `--steps-json` was supplied to the generic start; coding route options are only accepted on `workflow run start-coding` / `workflow run preview-coding`. |

The `invalid_run_start` `errors[]` use the run-start materialization taxonomy: `definition_invalid`, `run_id_invalid`, `repo_path_invalid`, `objective_invalid`, `approval_boundary_invalid`, `issue_scope_invalid`, `route_invalid`.

### Text output (success)

```text
Workflow run started: run-1
Definition: coding-workflow v1
State: pending
Approval boundary: (none)
Steps: 6
Repo: /path/to/repo
Objective: Ship the feature
Policy: (none)
Data dir: /path/to/data
```

The `Approval boundary` line prints the boundary when one was supplied.
For coding starts, the `Implementation engine` line prints the durable route path recorded for the run.
The `Policy` line prints the `MOMENTUM.md` path when a valid policy was loaded and `(none)` otherwise.

### Text output (failure)

```text
Workflow run already exists: run-1.
```

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run start-coding`

```text
momentum workflow run start-coding --run-id <id> --repo <path> --objective <text> [--approval-boundary <boundary>] [--skill-revision <text>] [--issue-scope <identifier>] [--profile <name>] [--implementation-engine <engine>] [--steps-json <json>] [--definition-version <n>] [--data-dir <path>] [--json]
```

The explicit Momentum-native coding-workflow start door.
It is a thin selector over [`workflow run start`](#workflow-run-start) that intentionally chooses Momentum orchestration for a new coding workflow, while the ordinary definition-sourced start stays the default and the imported compatibility runs remain readable.
It reuses the same durable materialization, repo-policy loading, approval-boundary promotion, and refusal taxonomy, and adds coding-specific guarantees.

Required arguments:

- `--run-id <id>` - the new run's identifier. Must be unique and must not begin with a reserved compatibility prefix (`cwfp-`, `cwfb-`, `overnight-`).
- `--repo <path>` - the repository the run operates on.
- `--objective <text>` - the run objective recorded on the `workflow_runs` row.

Optional arguments:

- `--approval-boundary <boundary>` - promote the steps the boundary covers to `approved` and open the run `approved` rather than `pending` (same coverage as [`workflow run approve`](#workflow-run-approve)).
- `--skill-revision <text>` - record the skill revision that started the run.
- `--issue-scope <identifier>` - record an issue-scope identifier on the run.
- `--profile <name>` - record the selected runtime/profile on the run's durable `route.profile`, so status, handoff, monitor, and logs can explain which runtime/profile the Momentum-native run was started for from durable state alone.
  The value is trimmed and must be non-blank.
  This captures intent only; the executing live-wrapper profile is still resolved by the daemon from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time.
- `--implementation-engine <engine>` - select the coding implementation engine recorded on the run's durable `route.implementationEngine`.
  Valid values are `native-goal-loop` and `current-gnhf-cwfp`; when omitted, the coding doors keep selecting and persisting `native-goal-loop`.
  The current GNHF/CWFP route and the native goal-loop route share the no-mistakes tail, but the route marker lets operators preview, start, compare, and roll back by selecting the desired implementation path explicitly.
  Until the compatibility implementation is wired into native dispatch, a run that selects `current-gnhf-cwfp` is parked at the implementation step with `route_config_invalid` rather than silently running the native goal-loop implementation.
- `--steps-json <json>` - reconfigure the planned per-step harness/model/effort selections before the run starts, recorded on the run's durable `route.steps` so status, handoff, monitor, and logs can audit which selection the run was started with.
  The value is a JSON object keyed by the operationally meaningful coding steps (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`), each mapping to any of the `harness`, `model`, and `effort` string fields; an omitted step or field keeps the default (inherit at execution time).
  Selections are validated and normalized to a canonical, byte-stable shape before they are recorded; an unsupported step, unknown field, blank value, or malformed JSON fails closed with `route_config_invalid` and writes nothing.
  Provider-specific model aliases are normalized when the step also supplies the matching harness; for example `{"harness":"claude","model":"sonnet"}` records and previews `model=claude-sonnet-4-6`, `{"harness":"codex","model":"openai/gpt-5.5"}` records `model=gpt-5.5`, and `{"harness":"opencode","model":"glm-5.2"}` records `model=opencode-go/glm-5.2`.
  Unknown harness/model values remain free-form after structural validation, so future provider model ids can still be passed through before Momentum learns a shorthand for them.
  During daemon dispatch, the persisted selection is mapped to executor-round `agentProvider`, `model`, and `effort` fields and then forwarded to live wrappers through `MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT` when those values are present.
  `route.steps` (the per-step selection) stays distinct from `route.profile` (the recorded operator profile) and from the daemon's `MOMENTUM_LIVE_WRAPPER_PROFILE` execution profile.
- `--definition-version <n>` - require a specific built-in `coding-workflow` version.
  When omitted, the latest known built-in version is used.
  Existing native runs continue resolving the built-in version recorded on the run after future built-in versions are added.
  Persisted `coding-workflow` definitions never override this door.

Behaviour:

- **Forced definition**: the run always materializes the selected built-in `coding-workflow` recipe, using the latest known built-in version unless `--definition-version` pins one.
  The current built-in version has six ordered steps (`preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`).
  Passing `--definition coding-workflow` is an accepted no-op selector; passing any other `--definition` value refuses with `definition_not_allowed`.
- **Reserved run ids**: a `--run-id` that begins with a reserved compatibility prefix refuses with `reserved_run_id` and writes nothing, so a fresh Momentum-native run can never be confused with an imported `cwfp-*` compatibility run.
- **Native source**: on success the `workflow_runs.source` is `momentum-native-coding` (rather than the generic `workflow-definition`), so status, handoff, monitor, and logs can show the run as Momentum-owned primary state from durable rows alone.
- **Built-in dispatch provenance**: native coding dispatch resolves executor families from the built-in `coding-workflow` definition recorded on the run by key and version, even if a persisted `coding-workflow` definition with the same key/version exists.
  If the recorded built-in version is unavailable, dispatch fails closed with `step_definition_not_found` instead of substituting persisted rows or a later built-in version.
- **Structural preflight**: built-in definition lookup, required repository/objective shape, approval boundary, issue scope, route profile, implementation engine, and per-step route overrides fail closed before durable writes when they are structurally invalid.
  JSON failures from these checks include `preflightEvidence` with the failing check id, path, key, message, severity, and recommended action.
- **Shared persistence**: everything else - durable run/step/approval rows, the no-clobber duplicate-run refusal, repo-policy refusal, and the `invalid_run_start` materialization taxonomy - matches `workflow run start`.
  The success envelope also includes the coding `route` with `implementationEngine` and the top-level `implementationEngine` value; failure envelopes are identical except that `command` is `workflow run start-coding`.

### Error codes

In addition to every [`workflow run start`](#error-codes) refusal code (`run_id_required`, `repo_required`, `objective_required`, `data_dir_failed`, `definition_not_found`, `policy_invalid`, `invalid_run_start`, `run_exists`):

| Code | Meaning |
|------|---------|
| `reserved_run_id` | `--run-id` begins with a reserved compatibility prefix (`cwfp-`, `cwfb-`, `overnight-`); refused so native runs are not confused with imported compatibility state. |
| `definition_not_allowed` | A `--definition` other than `coding-workflow` was supplied; this door always uses the built-in coding workflow. |
| `route_config_invalid` | `--profile` is blank, `--implementation-engine` is unsupported, or `--steps-json` is malformed JSON, names an unsupported step, carries an unknown field, or has a blank value; the run is refused and nothing is written. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run preview-coding`

```text
momentum workflow run preview-coding --run-id <id> --repo <path> --objective <text> [--approval-boundary <boundary>] [--skill-revision <text>] [--issue-scope <identifier>] [--profile <name>] [--implementation-engine <engine>] [--steps-json <json>] [--definition-version <n>] [--data-dir <path>] [--json]
```

The read-only plan preview for the Momentum-native coding workflow.
It runs the exact same precondition checks and built-in definition resolution as [`workflow run start-coding`](#workflow-run-start-coding) - required inputs, the reserved-run-id and conflicting-`--definition` refusals, data-directory resolution, and repo-policy loading - but stops before any durable write.
Instead of persisting a run it emits a frozen plan an operator can inspect before approving or executing it.

It takes the same required and optional arguments as [`workflow run start-coding`](#workflow-run-start-coding), including `--profile <name>` as a trimmed, non-blank read-only route/profile preview, `--implementation-engine <engine>` as a read-only preview of the selected current or native implementation route, `--steps-json <json>` as a read-only preview of the reconfigured per-step `route.steps` selection, and `--approval-boundary <boundary>` as the projected initial approval state.
A `--steps-json` selection is validated and projected into the previewed `route` exactly as `workflow run start-coding` would record it, so an operator can preview the default route, change it, and start the same frozen selection.
Provider-aware model alias normalization is part of that projection, so the preview shows the exact model string the later run would persist and forward to the live wrapper.

Behaviour:

- **No durable write**: the preview never opens the run for a durable write; no `workflow_runs`, `workflow_steps`, or `workflow_approvals` row is created.
  It is read-only apart from reading `<repo>/MOMENTUM.md` to report repo policy.
- **Frozen projection**: the preview is a pure projection of the version-pinned built-in `coding-workflow` definition plus the supplied inputs, so the durable run a later `workflow run start-coding` materializes from the same inputs matches the preview exactly.
  Because the built-in definition is immutable per version, the same plan can be reconstructed from the run's recorded `(definition key, version)` for approval and dispatch to reference later.
- **Stable output**: the envelope carries no wall-clock fields, so repeated previews of the same inputs are byte-stable and safe to show before approval.
- **Step detail**: each step carries its `kind`, executor family, `order`, `required` flag, and on-start `state` (`pending`, or `approved` for the steps an `--approval-boundary` covers).

Success JSON adds a `preview: true` marker, the run header (`runId`, `source`, `state`, `approvalBoundary`, `definitionKey`, `definitionVersion`, `repoPath`, `objective`, `issueScope`, `route`, `implementationEngine`, `skillRevision`), a `steps` array, `counts.steps`, and `policy`:

```json
{
  "ok": true,
  "command": "workflow run preview-coding",
  "preview": true,
  "dataDir": "/path/to/data",
  "runId": "native-coding-1",
  "source": "momentum-native-coding",
  "state": "pending",
  "approvalBoundary": null,
  "definitionKey": "coding-workflow",
  "definitionVersion": 1,
  "repoPath": "/path/to/repo",
  "objective": "Ship the slice",
  "issueScope": {},
  "route": {
    "implementationEngine": "native-goal-loop"
  },
  "implementationEngine": "native-goal-loop",
  "skillRevision": null,
  "steps": [
    { "stepId": "preflight", "kind": "preflight", "executor": "one-shot", "order": 0, "required": true, "state": "pending" },
    { "stepId": "implementation", "kind": "implementation", "executor": "goal-loop", "order": 1, "required": true, "state": "pending" },
    { "stepId": "postflight", "kind": "postflight", "executor": "one-shot", "order": 2, "required": true, "state": "pending" },
    { "stepId": "no-mistakes", "kind": "no-mistakes", "executor": "no-mistakes", "order": 3, "required": true, "state": "pending" },
    { "stepId": "merge-cleanup", "kind": "merge-cleanup", "executor": "script", "order": 4, "required": true, "state": "pending" },
    { "stepId": "linear-refresh", "kind": "linear-refresh", "executor": "external-apply", "order": 5, "required": true, "state": "pending" }
  ],
  "counts": { "steps": 6 },
  "policy": { "present": false, "path": "/path/to/repo/MOMENTUM.md" }
}
```

### Text output (success)

Text output is a human-readable preview of the same frozen plan and includes the command's no-write status, definition key/version, source, projected run state, approval boundary, profile, implementation engine, per-step route selections, repo, objective, policy path or `(none)`, data directory, and every step with order, step id, kind, executor family, required/optional marker, and projected state.
The per-step route block lists every configurable step (implementation, postflight, no-mistakes, merge-cleanup) with its harness/model/effort selection, showing `(default)` where the operator did not override the field, so an operator can audit the default selections and any `--steps-json` changes before approval:

```text
Coding workflow plan preview (not started): native-coding-1
Definition: coding-workflow v1
Source: momentum-native-coding
State on start: pending
Approval boundary: (none)
Profile: (none)
Implementation engine: native-goal-loop
Per-step route:
  implementation: harness=(default), model=(default), effort=(default)
  postflight: harness=(default), model=(default), effort=(default)
  no-mistakes: harness=(default), model=(default), effort=(default)
  merge-cleanup: harness=(default), model=(default), effort=(default)
Repo: /path/to/repo
Objective: Ship the slice
Policy: (none)
Data dir: /path/to/data
Steps (6):
  0. preflight (preflight) -> one-shot [required, pending]
  1. implementation (implementation) -> goal-loop [required, pending]
  2. postflight (postflight) -> one-shot [required, pending]
  3. no-mistakes (no-mistakes) -> no-mistakes [required, pending]
  4. merge-cleanup (merge-cleanup) -> script [required, pending]
  5. linear-refresh (linear-refresh) -> external-apply [required, pending]
```

With provider-specific aliases such as `{"implementation":{"harness":"claude","model":"sonnet","effort":"high"},"postflight":{"harness":"opencode","model":"glm-5.2"},"no-mistakes":{"harness":"codex","model":"openai/gpt-5.5","effort":"high"}}`, the preview prints the normalized command-ready values:

```text
  implementation: harness=claude, model=claude-sonnet-4-6, effort=high
  postflight: harness=opencode, model=opencode-go/glm-5.2, effort=(default)
  no-mistakes: harness=codex, model=gpt-5.5, effort=high
```

### Text output (failure)

Structured refusals render the same message text as `workflow run start-coding`, with `command` set to `workflow run preview-coding` in JSON mode.
Structural preflight failures include the same `preflightEvidence` array described for `workflow run start`.

```text
Workflow run already exists: native-coding-1.
```

### Error codes

The preview shares the [`workflow run start-coding`](#error-codes-1) refusal taxonomy: `run_id_required`, `repo_required`, `objective_required`, `data_dir_failed`, `reserved_run_id`, `definition_not_allowed`, `route_config_invalid`, `definition_not_found`, `policy_invalid`, `invalid_run_start` (with its `errors` array), and `run_exists`.
It checks an existing SQLite store read-only for duplicate run ids and still creates no durable run.

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow import`

```text
momentum workflow import --path <run-dir> [--data-dir <path>] [--json]
```

Reads the `.agent-workflows/<run-id>/` directory at `<run-dir>` and normalizes the `plan.json`, `ledger.jsonl`, `approval-*.json`, and advisory `monitor.json` artifacts into durable `workflow_runs`, `workflow_steps`, and `workflow_approvals` rows.

`--path <run-dir>` is required. The directory basename should match the `cwfp-` / `cwfb-` / `overnight-` run ID convention; alternatively, `plan.json` may supply `runId` when it is a safe path segment. An unsafe `plan.json.runId` emits `evidence_format_invalid` with reason `plan_run_id_invalid` and import falls back to the directory basename.

### Processing rules

- **Idempotent re-import**: running `workflow import` on the same directory twice produces no duplicate rows. `created_at` is preserved on upsert; `updated_at` is bumped.
- **Terminal ledger wins**: `monitor.json` is advisory. Step and run state are derived from `ledger.jsonl` and `plan.json`; a stale monitor does not override completed ledger evidence. Its advisory snapshot is persisted on `workflow_runs` (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`, `monitor_last_seen_at`, `monitor_last_emitted_at`) so status / handoff / monitor / logs drift views can compare durable substrate state against the last imported or operator-refreshed advisory snapshot. Successful `workflow run approve`, `workflow run update-step`, and `workflow run clear-recovery` mutations refresh the same state columns from durable rows and clear the digest / timestamp fields, so later views do not report drift against a stale pre-mutation monitor tick.
- **Lost managed-task markers**: `managed-*.pid`, `managed-*.log`, and `locks/` sibling entries are ignored without diagnostics. They do not force a failed step state.
- **Unknown siblings**: unrecognized files produce `evidence_format_unknown` diagnostics but do not drop the valid records around them. The generated `recovery.md` artifact is a known sibling and is ignored by import.
- **Malformed artifacts**: invalid `plan.json`, `ledger.jsonl` lines, or `approval-*.json` files produce `evidence_format_invalid` diagnostics. Valid siblings are still imported.
- **Durable approvals merge forward**: existing database approvals, the current `approval_boundary`, and imported `approval-*.json` artifacts are merged. The highest boundary is preserved; same-rank boundaries prefer the newer recorded approval. Stale same-boundary artifacts do not overwrite newer durable approval rows. On fresh imports and re-imports, pending steps covered by any preserved approval are persisted as `approved`, and a non-terminal pending run can be persisted as `approved`.
- **Manual-recovery auto-set**: after persisting the rows, import re-derives the run's monitor view.
  When it classifies a blocking recovery condition (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, `failed_required_step`, or `failed_external_side_effect_step`), import sets the durable `needs_manual_recovery` flag and renders `<run-dir>/recovery.md`.
  The flag blocks `workflow run approve` and any `workflow run update-step` transition that would leave a blocking recovery condition in place; a resolving update-step can land so the operator can then clear the flag with `workflow run clear-recovery`.
  For `failed_external_side_effect_step`, `clear-recovery --evidence-pointer <ref>` is the resolving operator action after the canonical external state is verified: the pull request merge or close state and any surviving remote branch ref for `merge-cleanup`, or tracker state for `linear-refresh`.
  For an interrupted failed required `no-mistakes` step, `clear-recovery` is the narrow resolving action after the external no-mistakes run proves success, using either legacy `--evidence-pointer no-mistakes:<run-id>#checks-passed` proof or a readable structured deterministic evidence JSON file.
  The auto-set only ever sets the flag: re-importing a run whose blocking condition is now resolved leaves any existing flag in place, so clearing stays explicit and operator-driven.

### JSON envelope (success)

```json
{
  "ok": true,
  "command": "workflow import",
  "dataDir": "/path/to/data",
  "path": "/path/to/cwfp-abc123",
  "runId": "cwfp-abc123",
  "source": "agent-workflow",
  "state": "succeeded",
  "inserted": true,
  "approvalBoundary": "through-merge-cleanup",
  "counts": {
    "steps": 5,
    "approvals": 1,
    "diagnostics": 0
  },
  "diagnostics": [],
  "monitor": null,
  "needsManualRecovery": false,
  "recovery": null
}
```

`inserted` is `true` on first import and `false` on re-import (upsert). `counts.approvals` counts only `approval-*.json` artifacts present in the current import; preserved durable approvals are reflected in `state` and `approvalBoundary` but do not increase that count. `monitor` carries the advisory monitor snapshot (always `advisory: true`) or `null` when no `monitor.json` is present.

`needsManualRecovery` mirrors the run's durable manual-recovery flag after the import (matching the same field on `workflow status` / `workflow handoff` / `workflow run list` / `workflow run monitor`). `recovery` describes the blocking condition this import freshly flagged, or `null` when this import did not set the flag:

```json
{
  "needsManualRecovery": true,
  "recovery": {
    "code": "failed_required_step",
    "stepId": "implementation",
    "reason": "A required step finalized in failed state. ...",
    "artifactPath": "/path/to/cwfp-abc123/recovery.md",
    "artifactWriteError": null
  }
}
```

If the durable flag is set but rendering `recovery.md` fails, import still
returns a structured success envelope with `needsManualRecovery: true`,
`recovery.artifactPath: null`, and `recovery.artifactWriteError` set to
`{ "code": "recovery_artifact_write_failed", "message": "<render error>" }`.

A run that was already flagged on a prior import but whose blocking condition is now resolved reports `needsManualRecovery: true` with `recovery: null` — the durable flag persists until an operator clears it explicitly.

#### Diagnostic entries

Each `diagnostics` entry has the shape:

```json
{
  "code": "evidence_format_unknown",
  "path": "/path/to/cwfp-abc123/notes.txt",
  "reason": "unrecognized_filename",
  "detail": "optional human-readable detail"
}
```

| Field | Description |
|-------|-------------|
| `code` | `evidence_format_unknown` (sibling Momentum does not recognize) or `evidence_format_invalid` (artifact present but malformed). |
| `path` | Absolute path of the offending entry. |
| `reason` | Stable machine-readable reason (see below). |
| `detail` | Optional free-text detail (e.g., the parse error message). Absent when not applicable. |

`evidence_format_unknown` reasons: `unsupported_subdirectory`, `unsupported_entry_kind`, `unrecognized_filename`.

`evidence_format_invalid` reasons: `directory_unreadable`, `plan_not_object`, `plan_run_id_invalid`, `ledger_unreadable`, `ledger_line_not_json`, `ledger_line_not_object`, `ledger_line_missing_required_fields`, `ledger_run_id_mismatch`, `unknown_step_or_status`, `ledger_line_invalid_timestamp`, `monitor_not_object`, `file_unreadable`, `file_not_json`, `approval_not_object`, `approval_run_id_mismatch`, `approval_missing_boundary`, `approval_invalid_boundary`, `approval_invalid_timestamp`.

### JSON envelope (failure)

```json
{
  "ok": false,
  "command": "workflow import",
  "code": "import_path_unreadable",
  "message": "Cannot read import path: ...",
  "dataDir": "/path/to/data",
  "path": "/path/to/cwfp-abc123",
  "diagnostics": []
}
```

`dataDir` and `path` are emitted whenever they are known at the point of failure. `path_required` is the only code that omits both (no `--path` was supplied and data-dir resolution has not been attempted). `data_dir_failed` omits `dataDir` (resolution itself failed) but includes `path`. All other codes include both.

Error codes:

| Code | Meaning |
|------|---------|
| `path_required` | `--path` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `import_path_unreadable` | `--path` does not exist or is not readable. |
| `import_path_not_directory` | `--path` is not a directory. |
| `import_run_id_missing` | No `runId` in `plan.json` and the directory basename does not match the `cwfp-` / `cwfb-` / `overnight-` pattern. |

### Text output (success)

```text
Workflow import: /path/to/cwfp-abc123
Run: cwfp-abc123 (agent-workflow)
State: succeeded
Inserted: yes
Steps: 5
Approvals: 1
Diagnostics: 0
Manual recovery: not required
Data dir: /path/to/data
```

The `Manual recovery` line reads `required (<code>) -> <recovery.md path>` when this import auto-set the flag, `required (<code>); recovery.md write failed: <message>` when the durable flag was set but rendering the artifact failed, `flagged (clear explicitly once resolved)` when the run has an existing durable flag but this import did not classify a blocking recovery condition, and `not required` otherwise.

### Text output (failure)

```text
Cannot read import path: ...
```

Exit code 1 is returned on failure; exit code 0 on success.

## `workflow run approve`

```text
momentum workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> [--actor <name>] [--artifact-path <path>] [--artifact-digest <sha256>] [--data-dir <path>] [--json]
```

Records an explicit durable approval for one workflow run boundary and emits a stable JSON/text envelope.

Validation rules:

- `--approval-boundary` must be one of: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`, `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch`.
- `--phrase` must be non-empty, affirmative, include `approve`, and include the requested boundary.
- `--artifact-path`, when supplied, must be readable.
- If `--artifact-digest` is supplied with `--artifact-path`, it must match the SHA-256 digest of that file (or the command refuses).

If `--artifact-path` is omitted, Momentum stores the synthetic provenance URI `workflow-run-approve://<run-id>/<boundary>` in `artifactPath` and synthesizes a deterministic provenance digest from `approve:<run-id>:<boundary>:<phrase>`. A supplied `--artifact-digest` without `--artifact-path` must match that synthesized digest.

On success, the command inserts a `workflow_approvals` row, updates `workflow_runs.approval_boundary` to the new boundary unless the stored boundary has a strictly higher rank (same-rank approvals replace the stored boundary), promotes a pending run to `approved`, and marks pending steps covered by the boundary as `approved`.

Boundary coverage:

| Boundary | Pending steps approved |
|----------|------------------------|
| `plan-only` | none |
| `implementation`, `through-implementation` | `preflight`, `implementation` |
| `through-postflight` | `preflight`, `implementation`, `postflight` |
| `no-mistakes`, `through-no-mistakes`, `overnight-safe`, `through-merge-gates` | `preflight`, `implementation`, `postflight`, `no-mistakes` |
| `merge-cleanup`, `through-merge-cleanup` | `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup` |
| `full`, `final-cleanup`, `full-batch` | `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh` |

The command is idempotent by `(run-id, boundary)`; approving the same pair twice returns a stable duplicate refusal instead of creating duplicate rows.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run approve",
  "dataDir": "/path/to/data",
  "runId": "cwfp-abc123",
  "boundary": "through-implementation",
  "phrase": "approve pipeline cwfp-abc123 through implementation",
  "actor": "calvinnwq",
  "artifactPath": "/path/to/approval-implementation.json",
  "artifactDigest": "f2f...a4",
  "recordedAt": 1730000000000
}
```

When `--artifact-path` is omitted, `artifactPath` is `workflow-run-approve://<run-id>/<boundary>` and `artifactDigest` is the synthetic digest described above. When `--actor` is omitted, JSON still emits `"actor": null`.

### Text output

Text output prints a stable human-readable confirmation and omits JSON-only fields such as `artifactDigest` and `recordedAt`:

```text
Workflow run approval recorded for cwfp-abc123
Boundary: through-implementation
Phrase: approve pipeline cwfp-abc123 through implementation
Actor: calvinnwq
Artifact: /path/to/approval-implementation.json
Data dir: /path/to/data
```

When `--actor` is omitted, the `Actor:` line prints `(unset)`. When `--artifact-path` is omitted, the `Artifact:` line prints `(inline/implicit)`.

### Error codes

After the run, boundary, and phrase resolve, duplicate approvals short-circuit mutable validations: an existing `(run-id, boundary)` row returns `duplicate_approval` before terminal-state, manual-recovery, or artifact-digest checks.

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `manual_recovery_required` | The run is blocked by its durable manual-recovery flag and must be cleared before approval. |
| `invalid_state` | The run is already terminal and cannot accept new approvals. |
| `invalid_boundary` | Missing or unsupported boundary value, or phrase is casual, missing, negated, non-affirmative, or insufficient for the requested boundary. |
| `approval_digest_mismatch` | `--artifact-path` is unreadable/missing, or `--artifact-digest` was supplied and does not match the resolved digest. |
| `duplicate_approval` | A durable approval already exists for the same run and boundary. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run update-step`

```text
momentum workflow run update-step <run-id> --step <step-id> --state <approved|succeeded|skipped|failed|blocked|canceled> --reason <text> [--actor <name>] [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]
```

Drives an operator-initiated step transition through the existing state machine and persists a durable audit record.

Required arguments:

- `<run-id>` — the run to update.
- `--step <step-id>` — the step to transition (e.g. `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`).
- `--state <target>` — one of `succeeded`, `skipped`, `failed`, `blocked`.
- `--reason <text>` — operator-supplied rationale, stored in the durable audit record.

Optional arguments:

- `--actor <name>` — operator identity; stored alongside the audit record; defaults to null when omitted.
- `--evidence-pointer <ref>` — free-form reference to an evidence artifact (e.g. `.agent-workflows/<run-id>/ledger.jsonl#offset=42`).
- `--ledger-pointer <ref>` — free-form reference to a ledger entry.

Behaviour:

- Illegal transitions (e.g. finalizing a `pending` step, transitioning from a terminal state to a different terminal state) refuse with `invalid_transition` and write no durable state.
- A byte-equal repeat of an existing finalize (same `--state`, `--reason`, `--actor`, `--evidence-pointer`, and `--ledger-pointer`) returns successfully with `idempotent: true` and does not update the stored audit record.
- A repeat with a different reason, actor, or pointers refuses with `invalid_transition`; the existing audit record is preserved.
- A blocked transition also appends a `step_blocked` semantic event so `workflow run events` can replay the operator metadata even if later transitions overwrite the step row.
- After a successful step transition the run state is re-derived from the full step chain; if the derived state differs from the stored one, `workflow_runs.state` is updated in the same transaction.
- The command is local-only: it never spawns an executor, schedules cron, or issues an external write.
- If the run has `needs_manual_recovery` set, transitions that would leave a blocking recovery condition in place refuse with `manual_recovery_required`; transitions that resolve the blocking condition can land so the flag can be cleared explicitly afterward.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run update-step",
  "dataDir": "/path/to/data",
  "runId": "cwfp-abc123",
  "stepId": "implementation",
  "state": "succeeded",
  "previousState": "running",
  "runState": "succeeded",
  "reason": "managed child finished but durable terminal evidence never landed",
  "actor": "calvinnwq",
  "evidencePointer": ".agent-workflows/cwfp-abc123/ledger.jsonl#offset=42",
  "ledgerPointer": null,
  "idempotent": false
}
```

`actor`, `evidencePointer`, and `ledgerPointer` are always present in JSON output (null when not supplied).

### Text output

```text
Workflow step updated for cwfp-abc123
Step: implementation
State: running -> succeeded
Run state: succeeded
Reason: managed child finished but durable terminal evidence never landed
Actor: calvinnwq
Data dir: /path/to/data
```

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `manual_recovery_required` | The run is blocked by its durable manual-recovery flag and the requested transition would leave a blocking recovery condition in place. |
| `step_not_found` | `--step` was not supplied or does not match any step row for this run. |
| `invalid_state` | `--state` is not one of the allowed target states. |
| `invalid_transition` | The requested transition is not legal from the current step state, `--reason` was omitted, or an existing finalize would be overwritten with a different audit context. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run clear-recovery`

```text
momentum workflow run clear-recovery <run-id> [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]
```

Explicit, auditable clear for a run's durable manual-recovery flag. The flag blocks `workflow run approve` and non-resolving `workflow run update-step` transitions until an operator clears it here.

Required arguments:

- `<run-id>` — the flagged run to clear.

Options:

- `--evidence-pointer <ref>` - required when reconciling `failed_external_side_effect_step` or interrupted no-mistakes success; stores the operator-supplied proof that the external state landed successfully.
  For a failed `merge-cleanup` step, supply the merged pull request URL (e.g. `https://github.com/org/repo/pull/123` or `github://pulls/123#merged`).
  For a failed `linear-refresh` step, supply the Linear issue URL or stable audit/snapshot proving the intended `status_update` landed with the expected idempotency marker (e.g. `https://linear.app/team/issue/KEY-123` or `linear://issues/KEY-123#updated`).
  For an interrupted failed `no-mistakes` step whose external no-mistakes run later proved success, supply either legacy `no-mistakes:<run-id>#checks-passed` proof or a readable local JSON evidence file path.
  Structured no-mistakes evidence uses `schemaVersion: 1` and must include the workflow run id, issue scope identifiers, branch name and head SHA, pull request id, head SHA, state, draft flag, and check state when a pull request exists, the no-mistakes run id, successful no-mistakes outcome, zero unresolved findings and decisions, and explicit `review`, `tests`, `docs`, `lint`, `format`, `push`, `pr`, and `ci` phase statuses.
  Required no-mistakes phases must be current and complete: `review`, `tests`, and `push` must be `passed`, while the remaining phases must be `passed` or `not_applicable`.
  The structured path refuses unknown schema versions or extra phases, stale workflow, issue, branch, head, pull request, or no-mistakes identities, unresolved findings or decisions, closed or draft pull requests, pending, failed, or unknown pull request checks, and partial or non-success phase evidence.
  Without `--evidence-pointer`, the command refuses with `recovery_clear_refused` and leaves the failed step and any recovery flag intact.
- `--ledger-pointer <ref>` - optional ledger or local-artifact pointer stored alongside the evidence pointer when an evidence-backed step is reconciled.
  Use this to reference the specific ledger entry where the tail step's partial execution stopped (e.g. `.agent-workflows/<run-id>/ledger.jsonl#offset=42`).
  The ledger pointer does not affect the reconciliation outcome; it is stored on the step row as durable audit context alongside the evidence pointer.

Behaviour:

- Re-derives the monitor view from the durable substrate inside a single immediate transaction and clears the flag only when no monitor-derived blocking recovery condition remains.
  The check and the clear are atomic: the monitor condition that is checked is the condition that is cleared.
- Refuses with `recovery_clear_refused` while an ordinary monitor-derived blocking recovery classification (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`) still applies; the refusal carries the `recoveryCode` and, when known, the `blockingStepId`, and the flag stays set.
  The only `failed_required_step` exception is a failed required `no-mistakes` step with explicit legacy `no-mistakes:<run-id>#checks-passed` proof or a structured deterministic evidence JSON file, used when the wrapper was interrupted after the external no-mistakes run had already proved current success.
- For `failed_external_side_effect_step`, clear requires `--evidence-pointer <ref>` before reconciling the failed `merge-cleanup` or `linear-refresh` tail step to `succeeded`, stamping operator audit fields, refreshing the run state and `finished_at` from the re-derived terminal or non-terminal state, and clearing the flag.
  Operators should use this only after confirming the canonical external state is consistent: pull request merge or close state and any surviving remote branch ref for `merge-cleanup`, or tracker state for `linear-refresh`.
  Re-running the tail step could repeat those side effects.
  A missing evidence pointer refuses with `recovery_clear_refused`, leaving the flag and failed step intact.
- For live dispatch / finalization recovery, the durable flag and `run.manualRecoveryReason` / `run.manualRecoveryAt` fields are authoritative for non-monitor recovery reasons such as `head_mismatch`, `result_missing`, `repo_lock_lost`, or `auth_unavailable`. The `recovery.md` artifact is best-effort and may be absent after an artifact write failure; resolve the captured reason and any artifact context before clearing. The command still performs the atomic monitor recheck above, but it cannot independently prove that external live-recovery work was completed.
- For retryable live-wrapper setup failures on dispatched `no-mistakes` or `merge-cleanup` steps (for example a stale wrapper/build path, missing no-mistakes branch-start state, current no-mistakes cancellation evidence before clean runner evidence exists, or a `merge-cleanup` auth, target, PR readback, expected-head, cleanup-branch, or mergeability refusal reported as `runtime_unavailable` before clean runner evidence exists), clearing recovery also prepares the same step for one safe scheduler retry.
  The JSON envelope includes `retryPrepared`, and text output prints `Retry prepared: <step> (<code>)`.
  The previous failed executor round remains durable; the retry creates a new round and does not rerun an already-terminal successful step.
  Before the step row is reopened, the prior `step_started` or `step_failed` transition is preserved as a workflow event so cursor replay does not lose the overwritten state.
- For scheduler-lane stale workflow lease recovery, stale `manual-recovery-required` leases are left outstanding as durable evidence with the `stale_workflow_lease_manual_recovery_required` reason prefix. Because the monitor reducer can still classify that lease as `manual_recovery_lease`, guarded clear refuses until the lease condition is resolved.
- Refuses with `not_flagged` when the run is not currently flagged, so a stale clear cannot mutate anything, except for the evidence-backed `failed_external_side_effect_step` and interrupted `no-mistakes` reconciliation paths above.
  In that exception, `clear-recovery --evidence-pointer <ref>` can reconcile the failed external tail step, or a failed `no-mistakes` step with legacy checks-passed proof or structured deterministic evidence, even if the durable manual-recovery flag was never set.
  `workflow run clear-recovery` may still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.
  Ordinary failed no-mistakes steps still surface as `retry_failed_step` with `recoveryDetail: null` unless the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
- Never auto-clears from elapsed time alone, never repairs the underlying run, and never issues an external write. The `recovery.md` artifact is intentionally left on disk as durable audit; remove it after capturing the context elsewhere.
- Before clearing recovery for `failed_external_side_effect_step`, `workflow run monitor <run-id> --json` reports `disposition: "recover"`, `reportReason: "recovery_required"`, `nextAction.code: "clear_recovery"`, `nextAction.actionClass: "reconcile_external_tail"`, `nextAction.recoveryDetail.kind: "external_tail_reconcile"`, and `recovery.code: "failed_external_side_effect_step"`.
  Before interrupted no-mistakes reconciliation, monitor/status/watch advertise `nextAction.actionClass: "reconcile_deterministic_evidence"` and `nextAction.recoveryDetail.kind: "no_mistakes_deterministic_evidence"` only when the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
  Ordinary failed no-mistakes steps still surface as `retry_failed_step` with `recoveryDetail: null` unless the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
  `workflow run clear-recovery` may still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.
  The legacy `no-mistakes:<run-id>#checks-passed` pointer or structured deterministic evidence file narrows the clear to that failed required `no-mistakes` row.
  After a successful reconciliation clear, the same command reports `disposition: "report"`, `reportReason: "terminal_succeeded"`, `nextAction.code: "no_action"`, `nextAction.actionClass: "stop_monitoring"`, and `recovery: null` only when no downstream required work remains.
  Its progress tick then reports `phase: "terminal"`, `terminal: true`, `cleanup: "release"`, and `blockerReason: null` so a delivery wrapper can stop instead of carrying forward the pre-clear recovery phase.
  If a full workflow still has `linear-refresh` pending or approved after a reconciled `merge-cleanup`, monitor surfaces that next step instead of terminal success.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run clear-recovery",
  "runId": "cwfp-abc123",
  "dataDir": "/path/to/data",
  "previousReason": "ghost active step recovered by operator",
  "previousMarkedAt": 1730000000000,
  "clearedAt": 1730000600000,
  "retryPrepared": {
    "stepId": "merge-cleanup",
    "recoveryCode": "runtime_unavailable"
  },
  "reconciledStep": {
    "stepId": "merge-cleanup",
    "recoveryCode": "failed_external_side_effect_step",
    "state": "succeeded",
    "evidencePointer": "github://pulls/123#merged",
    "ledgerPointer": ".agent-workflows/cwfp-abc123/ledger.jsonl#offset=42"
  }
}
```

### Text output

```text
Manual recovery cleared for run: cwfp-abc123
Previous reason: ghost active step recovered by operator
Previous marked at: 1730000000000
Cleared at: 1730000600000
Retry prepared: merge-cleanup (runtime_unavailable)
Reconciled step: merge-cleanup (failed_external_side_effect_step -> succeeded)
Data dir: /path/to/data
```

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `not_flagged` | The run is not currently flagged for manual recovery and no evidence-backed external-tail or interrupted no-mistakes reconciliation applies. |
| `recovery_clear_refused` | A monitor-derived blocking recovery condition still applies; resolve it before clearing. Carries `recoveryCode` and optional `blockingStepId`. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run decide`

```text
momentum workflow run decide <gate-id> --action <action> --actor <name> [--mode <operator|delegated>] [--note <text>] [--data-dir <path>] [--json]
```

Resolves a durable workflow / step / executor gate and emits a stable JSON/text envelope.

Required arguments:

- `<gate-id>` — the gate to resolve.
- `--action <action>` — the action to apply; must be one of the gate's `allowedActions`.
- `--actor <name>` — the operator name or delegated-policy identifier recorded with the resolution.

Optional arguments:

- `--mode <operator|delegated>` — how the decision is being made. Defaults to `operator`. With `operator`, any allowed action resolves the gate. With `delegated`, the action must also be inside the gate's `policyEnvelope`; an action outside the envelope is refused so the gate pauses for a human operator instead of being silently auto-applied.
- `--note <text>` — free-text resolution note recorded with the durable gate row.
- `--data-dir <path>` — override the data directory.
- `--json` — emit structured JSON; success writes to stdout, while structured refusals and usage errors write JSON to stderr.

The resolution is race-safe: the update is guarded by `resolved_at IS NULL`, so a concurrent resolve that closed the gate between load and write is refused as `gate_already_resolved` rather than overwriting the prior decision.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run decide",
  "dataDir": "/path/to/data",
  "gateId": "gate-nm-1",
  "runId": "cwfp-abc123",
  "targetScope": "step",
  "gateType": "operator_decision_required",
  "chosenAction": "fix",
  "resolvedBy": "calvinnwq",
  "mode": "operator",
  "resolution": "Accepted the finding and will fix.",
  "resolvedAt": 1730000600000,
  "allowedActions": ["fix", "skip", "approve_as_is"]
}
```

### Text output

```text
Workflow gate resolved: gate-nm-1
Run: cwfp-abc123
Scope: step (operator_decision_required)
Action: fix
Resolved by: calvinnwq (operator)
Note: Accepted the finding and will fix.
Data dir: /path/to/data
```

When `--note` is omitted, the `Note:` line prints `(none)`.

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `gate_id_required` | `<gate-id>` was not supplied. |
| `action_required` | `--action` was not supplied or is blank. |
| `actor_required` | `--actor` was not supplied or is blank. |
| `invalid_mode` | `--mode` is not one of `operator`, `delegated`. |
| `gate_not_found` | `<gate-id>` does not exist in `workflow_gates`. |
| `gate_already_resolved` | The gate is already resolved; refusing to re-decide. |
| `action_not_allowed` | The requested action is not in the gate's `allowedActions`. |
| `delegated_action_outside_envelope` | `--mode delegated` was used but the action is outside the gate's `policyEnvelope`; an operator decision is required. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow status`

```text
momentum workflow status [<run-id>] [--state <state>] [--filter <active|blocked|completed|imported>] [--limit <n>] [--data-dir <path>] [--json]
```

Two modes share one envelope shape:

- **List mode** (no `<run-id>`): returns workflow runs filtered by state or by a named grouping. Ordered by `updated_at DESC`.
- **Detail mode** (with `<run-id>`): returns the full detail for one run — steps, approvals, leases, monitor reducer view, and evidence linkage.

### Selectors (list mode)

- `--state <state>` filters by literal `workflow_runs.state` value. Allowed: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- `--filter <key>` groups runs into operator-friendly buckets:
  - `active` → `pending`, `approved`, `running`
  - `blocked` → `blocked`
  - `completed` → `succeeded`, `failed`, `canceled`
  - `imported` → only runs whose `source == "agent-workflow"`
- `--limit <n>` caps the number of returned runs (after filtering).

State and filter compose: passing both returns runs whose literal state matches `--state` and falls inside the `--filter` bucket. An empty intersection (e.g., `--state succeeded --filter active`) returns zero runs. The `imported` bucket only constrains `source`, so it composes with `--state` without narrowing states further.

### JSON envelope — list mode

```json
{
  "ok": true,
  "command": "workflow status",
  "dataDir": "/path/to/data",
  "state": null,
  "filter": "active",
  "count": 1,
  "runs": [
    {
      "run": {
        "runId": "cwfp-abc123",
        "state": "running",
        "source": "agent-workflow",
        "approvalBoundary": "through-merge-cleanup",
        "objective": "land workflow status CLI",
        "issueScope": {},
        "route": {},
        "needsManualRecovery": false,
        "startedAt": 1730000000000,
        "finishedAt": null,
        "createdAt": 1730000000000,
        "updatedAt": 1730000600000
      },
      "counts": {
        "steps": 5,
        "stepsByState": {
          "pending": 1,
          "approved": 0,
          "running": 1,
          "succeeded": 3,
          "failed": 0,
          "skipped": 0,
          "blocked": 0,
          "canceled": 0
        },
        "approvals": 1,
        "leases": 1
      },
      "monitor": { "...": "see Monitor envelope below" }
    }
  ]
}
```

### JSON envelope — detail mode

The detail envelope flattens the per-run view at the top level (`run`, `steps`, `approvals`, `leases`, `monitor`, `evidence`):

```json
{
  "ok": true,
  "command": "workflow status",
  "dataDir": "/path/to/data",
  "run": { "runId": "cwfp-abc123", "state": "running", "...": "..." },
  "steps": [
    {
      "runId": "cwfp-abc123",
      "stepId": "implementation",
      "kind": "implementation",
      "state": "running",
      "order": 1,
      "required": true,
      "ledgerOffset": 2,
      "resultDigest": null,
      "errorCode": null,
      "errorMessage": null,
      "startedAt": 1730000100000,
      "finishedAt": null,
      "createdAt": 1730000000000,
      "updatedAt": 1730000100000
    }
  ],
  "approvals": [
    {
      "runId": "cwfp-abc123",
      "boundary": "through-merge-cleanup",
      "actor": "calvinnwq",
      "phrase": "approve",
      "artifactPath": "/path/to/cwfp-abc123/approval-merge.json",
      "artifactDigest": "...",
      "recordedAt": 1730000050000,
      "dischargedAt": null,
      "createdAt": 1730000050000,
      "updatedAt": 1730000050000
    }
  ],
  "leases": [
    {
      "runId": "cwfp-abc123",
      "leaseKind": "managed-step",
      "holder": "openclaw-coding-workflow-pipeline",
      "acquiredAt": 1730000100000,
      "expiresAt": 1730000400000,
      "heartbeatAt": 1730000200000,
      "releasedAt": null,
      "stalePolicy": "auto-release",
      "createdAt": 1730000100000,
      "updatedAt": 1730000200000
    }
  ],
  "monitor": {
    "runId": "cwfp-abc123",
    "runState": "running",
    "terminal": false,
    "blocked": false,
    "activeStep": {
      "stepId": "implementation",
      "kind": "implementation",
      "state": "running",
      "order": 1,
      "required": true
    },
    "leases": [
      {
        "leaseKind": "managed-step",
        "holder": "openclaw-coding-workflow-pipeline",
        "classification": "fresh",
        "expiresAt": 1730000400000,
        "heartbeatAt": 1730000200000,
        "releasedAt": null
      }
    ],
    "lastCheckpoint": {
      "stepId": "implementation",
      "at": 1730000100000,
      "source": "ledger",
      "digest": null
    },
    "monitorDrift": null,
    "nextAction": {
      "code": "resume_running",
      "stepId": "implementation",
      "leaseKind": "managed-step",
      "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.",
      "actionClass": "continue_polling",
      "recoveryDetail": null
    },
    "needsRecoveryArtifact": false,
    "recovery": null
  },
  "evidence": [],
  "gates": []
}
```

`gates` is the list of durable workflow / step / executor gates for the run, oldest first. Each gate includes: `gateId`, `workflowRunId`, `stepRunId`, `invocationId`, `roundId`, `targetScope` (`workflow` / `step` / `invocation` / `round`), `gateType`, `reason`, `evidence`, `allowedActions`, `recommendedAction`, `recommendedActionPolicy`, `policyEnvelope`, `open` (true while unresolved), `resolvedAt`, `resolvedBy`, `resolutionMode`, `chosenAction`, and `resolution`.

`run.source` is one of `agent-workflow`, `workflow-definition`, or `momentum-native-coding`.
`run.route.profile` is present when a run was started with `--profile`; it records the operator-selected runtime/profile for status, handoff, monitor, and logs, but daemon execution still resolves the live-wrapper profile from `MOMENTUM_LIVE_WRAPPER_PROFILE`.
`run.route.implementationEngine` records the selected coding implementation path, either `native-goal-loop` or `current-gnhf-cwfp`.
Native dispatch currently executes `native-goal-loop`; `current-gnhf-cwfp` is treated as an explicit unsupported compatibility selection and fails closed before the implementation executor starts.
`run.route.steps` is present when a coding run was started with `--steps-json`; it records the per-step harness/model/effort selections the run was started with (only the steps and fields the operator overrode), so the selected route can be audited from durable state.
Provider-specific model aliases have already been normalized here when the step supplied a known mapped harness (`claude`, `codex`, or `opencode`), so status, handoff, monitor, logs, and dispatch read the same command-ready model string.
Malformed route JSON is fail-closed.
`workflow run start-coding --implementation-engine`, `workflow run preview-coding --implementation-engine`, `workflow run start-coding --steps-json`, `workflow run preview-coding --steps-json`, and `workflow run monitor` all read the same route namespace.
If the namespace is invalid or unsupported, dispatch routes the run to manual recovery with `route_config_invalid` before execution.
Unknown or non-agent harness/model values remain pass-through values in these read surfaces.

### State / next-action vocabulary

`run.state` and `steps[].state` use the canonical workflow vocabulary:

- Run states: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- Step states: `pending`, `approved`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, `canceled`.

`steps[].errorCode` is nullable. When present, it can be an executor result code
or a Momentum-owned live finalization code with the `live_finalize_*` prefix for
verification / git finalization failures reconciled after the executor result.

`monitor.nextAction.code` is one of:

- `no_action` - terminal run (succeeded / canceled); no follow-up needed.
- `advance_to_step` - an approved step is ready for dispatcher consideration.
  Approved `merge-cleanup` and `linear-refresh` tail steps still use this low-level code, but status, handoff, monitor, and watch expose `actionClass: "operator_decision"` so a poller does not start side effects without operator authority.
- `await_approval` - a pending step needs approval before it can run.
- `resume_running` - a running step has fresh evidence; let it continue.
- `investigate_stale` - a running step is stale (no fresh lease, no recent checkpoint) or an orphan lease is holding a finalized run open.
- `clear_recovery` - the run is blocked (manual-recovery-required lease or blocked step), or a failed external-side-effect tail step (`merge-cleanup` / `linear-refresh`) needs operator reconciliation; verify external state and clear the recovery once the cause is resolved rather than re-running the step.
  For a failed external-side-effect tail step, clearing recovery reconciles that step to `succeeded` before clearing the durable flag.
- `rerun_failed_step` - an ordinary required step failed; decide whether to retry or mark for manual recovery. (A failed external-side-effect tail step routes to `clear_recovery` instead, since a naive re-run could double-merge a pull request or re-write the tracker.)

`monitor.nextAction.actionClass` groups those low-level codes into the stable operator decision classes shared by status, handoff, monitor, and watch: `continue_polling`, `approve_next_gate`, `fix_setup_config_then_retry`, `reconcile_deterministic_evidence`, `reconcile_external_tail`, `clear_recovery`, `operator_decision`, `resolve_gate`, `retry_failed_step`, or `stop_monitoring`.
`monitor.nextAction.recoveryDetail` is `null` unless the action needs evidence-backed recovery; no-mistakes reconciliation reports `kind: "no_mistakes_deterministic_evidence"` only when durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation, and external-tail reconciliation reports `kind: "external_tail_reconcile"`.

`monitor.recovery.code`, when present, is one of: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`, `failed_external_side_effect_step`. `failed_external_side_effect_step` is the subset of `failed_required_step` where the failed required step is an external-side-effect tail step (`merge-cleanup` / `linear-refresh`) that may already have pushed a branch, merged a pull request, or written the tracker before failing.

`run.needsManualRecovery`, `run.manualRecoveryReason`, and `run.manualRecoveryAt` mirror the durable run-scoped recovery flag. Monitor-derived blockers populate `monitor.recovery`; stale scheduler-lane `manual-recovery-required` workflow leases remain outstanding and can populate it as `manual_recovery_lease`. Live dispatch / finalization recovery can set the durable run fields while `monitor.recovery` remains `null`. The stored reason and timestamp are authoritative for those non-monitor classifications; `.agent-workflows/<run-id>/recovery.md` is best-effort operator guidance and may be absent if artifact rendering failed.

Lease classifications surfaced under `monitor.leases[].classification`: `released`, `fresh`, `stale-auto-release`, `stale-manual-recovery-required`.

### Evidence linkage

`detail.evidence` returns `evidence_records` rows linked to the run. Rows ingested via `evidence ingest` against a `.agent-workflows/<runId>/` directory carry a durable typed `runId` / `stepId` on each record; those are the primary join. For rows ingested before typed linkage existed (null `run_id`), the query falls back to `artifact_path` prefix matching under the run's source artifact directory so legacy evidence continues to surface.

Each evidence item exposes: `evidenceRecordId`, `source`, `type`, `artifactPath`, `occurredAt`, `summary`, `runId`, and `stepId`.

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `invalid_state` | `--state` is not one of the canonical workflow run states. |
| `invalid_filter` | `--filter` is not one of `active`, `blocked`, `completed`, `imported`. |
| `invalid_limit` | `--limit` is not a non-negative integer. (Note: the flag parser validates `--limit` before the command runs, so invalid limits produce a usage error / exit code 2 rather than this structured refusal.) |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output (list mode)

```text
Workflow runs: 1
State: (any)
Filter: active
Data dir: /path/to/data
- cwfp-abc123 [running] steps=5 approvals=1 leases=1 next=resume_running
```

### Text output (detail mode)

```text
Workflow run: cwfp-abc123
State: running
Source: agent-workflow
Objective: land workflow status CLI
Repo: /path/to/repo
Approval boundary: through-merge-cleanup
Data dir: /path/to/data

Steps: 5
- preflight [succeeded] kind=preflight order=0 required=yes
- implementation [running] kind=implementation order=1 required=yes
...

Monitor
- Run state: running
- Terminal: no
- Blocked: no
- Active step: implementation (running)
- Last checkpoint: implementation at 1730000100000 (source=ledger)
- Next action: resume_running - Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.

Evidence: 1
- evidence_record_impl [agent-workflow/implementation_complete] implementation finished step=implementation

Gates: 0 (open: 0)
```

Evidence rows include a trailing `step=<stepId>` annotation when the record carries typed step linkage.

Open gates print: `- <gate-id> [<scope>/<type>] OPEN allowed=<actions> [recommended=<action>]`. Resolved gates print: `- <gate-id> [<scope>/<type>] resolved by <actor> action=<action> (<mode>)`.

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow handoff`

```text
momentum workflow handoff <run-id> [--data-dir <path>] [--json]
```

Emits a machine-readable next-action envelope for one workflow run. Wraps the same detail loader as `workflow status <run-id>`, adds `schemaVersion` and `generatedAt`, and surfaces `nextAction` at the top level (mirroring `monitor.nextAction`) so OpenClaw tooling can dispatch without re-reading the monitor block.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow handoff",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "run": { "...": "same shape as workflow status detail" },
  "steps": [ "..." ],
  "approvals": [ "..." ],
  "leases": [ "..." ],
  "monitor": { "...": "same shape as workflow status detail" },
  "evidence": [ "..." ],
  "gates": [ "..." ],
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "leaseKind": "managed-step",
    "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.",
    "actionClass": "continue_polling",
    "recoveryDetail": null
  }
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output

```text
Workflow handoff: cwfp-abc123
Schema version: 1
Generated at (epoch ms): 1730000600000

Workflow run: cwfp-abc123
... (same shape as workflow status detail)
```

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run list`

```text
momentum workflow run list [--state <state>] [--filter <active|blocked|completed|imported>] [--approval-boundary <boundary>] [--repo <path>] [--issue-scope <identifier>] [--updated-since <ms>] [--updated-until <ms>] [--limit <n>] [--data-dir <path>] [--json]
```

Read-only filterable query over the durable `workflow_runs` table. Returns run summaries ordered by `updated_at DESC`. The identifiers in each summary row are sufficient to pass directly into `workflow status <run-id>` or `workflow handoff <run-id>` without re-derivation.

All filters are optional and compose: passing multiple filters narrows the result set by AND. An empty result set (no matching runs) is a successful response, not a refusal.

### Selectors

- `--state <state>` filters by literal `workflow_runs.state`. Allowed values: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- `--filter <key>` groups runs into operator-friendly buckets (same buckets as `workflow status`):
  - `active` → `pending`, `approved`, `running`
  - `blocked` → `blocked`
  - `completed` → `succeeded`, `failed`, `canceled`
  - `imported` → runs whose `source == "agent-workflow"` (composes with `--state` without narrowing states further)
- `--approval-boundary <boundary>` filters by the exact `approval_boundary` value on the run row.
- `--repo <path>` filters by exact `repo_path` match.
- `--issue-scope <identifier>` filters by substring match against `issue_scope_json` (LIKE, case-insensitive for ASCII letters per SQLite default).
- `--updated-since <ms>` filters to runs with `updated_at >= <ms>` (epoch milliseconds).
- `--updated-until <ms>` filters to runs with `updated_at <= <ms>` (epoch milliseconds).
- `--limit <n>` caps the number of returned runs (after filtering).

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run list",
  "dataDir": "/path/to/data",
  "state": null,
  "filter": "active",
  "approvalBoundary": null,
  "repoPath": null,
  "issueScope": null,
  "updatedSince": null,
  "updatedUntil": null,
  "count": 1,
  "runs": [
    {
      "run": {
        "runId": "cwfp-abc123",
        "state": "running",
        "source": "agent-workflow",
        "approvalBoundary": "through-merge-cleanup",
        "repoPath": "/path/to/repo",
        "objective": "land workflow status CLI",
        "issueScope": {},
        "needsManualRecovery": false,
        "startedAt": 1730000000000,
        "finishedAt": null,
        "createdAt": 1730000000000,
        "updatedAt": 1730000600000
      },
      "counts": {
        "steps": 5,
        "stepsByState": {
          "pending": 1,
          "approved": 0,
          "running": 1,
          "succeeded": 3,
          "failed": 0,
          "skipped": 0,
          "blocked": 0,
          "canceled": 0
        },
        "approvals": 1,
        "leases": 1
      },
      "monitor": {
        "runState": "running",
        "terminal": false,
        "blocked": false,
        "nextAction": {
          "code": "resume_running",
          "actionClass": "continue_polling",
          "recoveryDetail": null
        }
      }
    }
  ]
}
```

Top-level filter fields (`state`, `filter`, `approvalBoundary`, `repoPath`, `issueScope`, `updatedSince`, `updatedUntil`) echo the active filters, or `null` when not supplied. `count` is the number of matched runs. Each entry in `runs` uses the same `{ run, counts, monitor }` shape as `workflow status` list mode.

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `invalid_state` | `--state` is not one of the canonical workflow run states. |
| `invalid_filter` | `--filter` is not one of `active`, `blocked`, `completed`, `imported`. |
| `invalid_limit` | `--limit` is not a non-negative integer. (Note: the flag parser validates `--limit` before the command runs, so invalid limits produce a usage error / exit code 2 rather than this structured refusal.) |

### Text output

```text
Workflow runs: 1
State: (any)
Filter: active
Approval boundary: (any)
Repo: (any)
Issue scope: (any)
Updated since: (any)
Updated until: (any)
Data dir: /path/to/data
- cwfp-abc123 [running] repo=/path/to/repo steps=5 approvals=1 leases=1 next=resume_running
```

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run monitor`

```text
momentum workflow run monitor <run-id> [--advance] [--data-dir <path>] [--json]
```

Read-only-by-default machine envelope for a monitor runner.
Wraps the same durable detail loader as `workflow status <run-id>`, runs the monitor reducer, and adds a `disposition` decision view so a caller can act on one stable JSON shape per tick instead of parsing prose or scraping `.agent-workflows/<run-id>/`.
Without `--advance` it never writes SQLite or files, never schedules cron, and never delivers notifications.
The opt-in `--advance` flag is only supported for runs whose source is `momentum-native-coding`.
When supported, it persists only the progress suppression baseline (the `monitor_last_emitted_digest` / `monitor_last_seen_digest` and `monitor_last_emitted_at` / `monitor_last_seen_at` advisory columns); it never touches run, step, lease, or gate state.

Required arguments:

- `<run-id>` — the run to inspect.

Options:

- `--advance` - for `momentum-native-coding` runs only, persist this tick's digest / timestamp advisory baseline so a cron loop polling the command repeatedly suppresses unchanged ticks across invocations.
  See the [progress digest tick](#progress-digest-tick) section.

### Disposition and report reason

`disposition` is the single field a monitor runner branches on:

- `wait` — nothing actionable; the run is progressing (`in_progress`) or has no actionable steps yet (`idle`). `reportable` is `false`.
- `report` — surface the run to the operator, but no recovery action is needed: a terminal outcome (`terminal_succeeded` / `terminal_canceled`), a step `awaiting_approval`, or `monitor_drift` (the run keeps progressing while the advisory snapshot is stale). `reportable` is `true`.
- `recover` — an operator must intervene: the run is `blocked`, carries a durable manual-recovery flag, or the monitor reducer classified a hard recovery condition. `reportReason` is `recovery_required` and `reportable` is `true`.

`reportReason` is one of `terminal_succeeded`, `terminal_canceled`, `recovery_required`, `monitor_drift`, `awaiting_approval`, `in_progress`, `idle`. `reportable` is always `disposition != "wait"`.

The hard recovery classifications (`recovery.code`) are the same monitor-derived taxonomy as `workflow status`: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`, `failed_external_side_effect_step`. A failed required step (including the external-side-effect tail-step variant) and a blocked run both resolve to `disposition: "recover"`; `monitor_drift_stale` on an otherwise-progressing run resolves to `disposition: "report"`.

Live dispatch / finalization recovery can also set the durable manual-recovery flag and drive `needsManualRecovery: true`, `manualRecoveryReason: <reason>`, `disposition: "recover"`, and `reportReason: "recovery_required"` even when `recovery` is null, because `recovery` only carries monitor-derived classifications.
Scheduler-lane stale `manual-recovery-required` workflow leases remain outstanding and can instead surface through `recovery.code = "manual_recovery_lease"`.
The monitor envelope does not include a nested `run` object, but it does carry `manualRecoveryReason` so a progress tick can show and digest durable non-monitor recovery reasons.
Consumers that need full run metadata should call `workflow status` / `workflow handoff` or inspect the durable run record.
`.agent-workflows/<run-id>/recovery.md` is best-effort operator guidance and may be absent if artifact rendering failed.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run monitor",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "runId": "cwfp-abc123",
  "runState": "running",
  "stepState": "running",
  "terminal": false,
  "blocked": false,
  "needsManualRecovery": false,
  "manualRecoveryReason": null,
  "disposition": "wait",
  "reportable": false,
  "reportReason": "in_progress",
  "activeStep": {
    "stepId": "implementation",
    "kind": "implementation",
    "state": "running",
    "order": 1,
    "required": true
  },
  "leases": [{ "...": "same shape as workflow status monitor.leases" }],
  "lastCheckpoint": { "...": "same shape as workflow status monitor.lastCheckpoint" },
  "monitorDrift": null,
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "leaseKind": "managed-step",
    "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.",
    "actionClass": "continue_polling",
    "recoveryDetail": null
  },
  "recovery": null,
  "evidence": [{ "...": "same typed evidence pointers as workflow status detail" }],
  "gates": [{ "...": "same shape as workflow status detail gates" }],
  "counts": {
    "steps": 5,
    "stepsByState": { "...": "per-state step counts" },
    "approvals": 1,
    "leases": 1,
    "gates": 1,
    "gatesOpen": 1
  },
  "progress": {
    "phase": "advancing",
    "changed": true,
    "emit": true,
    "advanced": false,
    "terminal": false,
    "cleanup": "none",
    "currentStep": "implementation",
    "lastEvent": "step:implementation:running",
    "nextAction": "resume_running",
    "blockerReason": null,
    "digest": "sha256:7abb560d717661265f609b02107bd6fce701de831d42a28bd1f7af344aa52ad5"
  }
}
```

`schemaVersion` is `1`. `nextAction`, `recovery`, `monitorDrift`, `leases`, `lastCheckpoint`, `evidence`, and `gates` reuse the same field shapes as `workflow status`. `stepState` is the active step's state (or `null` when there is no active step). `counts.gates` is the total gate count for the run; `counts.gatesOpen` is the count of unresolved gates.

### Progress digest tick

`progress` is a lightweight, deterministic projection of the tick for a cheap cron monitor loop that wants to surface a concise update only when meaningful state changes, without a per-heartbeat agent call:

- `phase` is the coarse progress state: `advancing` (a step is running or progressing), `idle` (no actionable step yet), `awaiting_approval` (a step is paused on an approval boundary), `blocked` (operator recovery is required), or `terminal` (a clean succeeded / canceled outcome).
  A clean terminal phase requires terminal durable state, no recovery object, and `nextAction.code: "no_action"`.
  A stale durable manual-recovery flag by itself does not keep an operator-reconciled succeeded run in `blocked`, so the monitor releases after `clear-recovery`.
  A failed run surfaces as `blocked`, not `terminal`, because it needs recovery.
- `digest` is a stable `sha256:` hash of only the meaningful operator-facing state.
  Volatile fields (`generatedAt`, lease heartbeat / expiry timestamps, evidence ordering) are excluded, so two ticks over identical state hash equal.
  Durable `manualRecoveryReason` is included so a changed non-monitor recovery reason re-emits.
- `changed` / `emit` compare `digest` against the run's last emitted digest (the `monitor_last_emitted_digest` advisory). On a first observation, or whenever the meaningful state changes, both are `true`; a repeated unchanged tick reports both `false` so a caller can suppress a duplicate update. By default `workflow run monitor` reads this baseline without advancing it, so the command stays read-only.
- `advanced` reports whether this tick persisted the suppression baseline.
  It is `false` for a plain read; it is `true` only when `--advance` was passed and the tick actually emitted (a first observation or a meaningful change).
  For a supported `momentum-native-coding` run, passing `--advance` lets a cron loop poll the command repeatedly and suppress unchanged ticks across invocations from durable state alone: the first tick emits and advances the baseline, identical follow-up ticks report `emit: false` / `advanced: false`, and the baseline re-arms automatically on the next meaningful change.
  An unchanged `--advance` tick refreshes only `monitor_last_seen_digest` and `monitor_last_seen_at`; it leaves the emitted baseline untouched.
- `terminal` and `cleanup` make end-of-run handling explicit: a clean terminal outcome reports `cleanup: "release"` (release the monitor lease and stop ticking); every other phase reports `cleanup: "none"`. `cleanup` and `terminal` are reported even on a suppressed (`emit: false`) tick.
- `currentStep`, `lastEvent`, `nextAction` (the next-action code), and `blockerReason` are the snapshot fields an operator reads at a glance; `blockerReason` is `null` unless `phase` is `blocked`.
  For durable manual-recovery-only blocks, `blockerReason` uses `manualRecoveryReason` when present.

### Monitor delivery wrappers

`workflow run monitor` is the durable projection; delivery is intentionally
external. A chat, cron, or supervisor wrapper should call:

```sh
momentum workflow run monitor <run-id> --advance --json
```

Use `workflow run watch <run-id> --once --json` instead when a generic
supervisor should also run one bounded target-run dispatcher tick before reading
the same projection. Use [`openclaw supervise`](openclaw-supervise.md) when the
caller is an OpenClaw delivery loop that also needs per-run delivery suppression
state, sanitized Discord/OpenClaw delivery intents, local auto-action audit
evidence, and terminal monitor cleanup.

Then branch on the JSON instead of scraping text.
For `workflow run monitor --advance --json`, use the nested `progress` projection:

- Suppress the tick when `progress.emit` is `false`, `blocked` is `false`,
  `needsManualRecovery` is `false`, and `terminal` is `false`.
- Send a concise operator update when `progress.emit`, `blocked`,
  `needsManualRecovery`, or `terminal` is `true`.
- Include `runId`, `runState`, `activeStep` / `progress.currentStep`,
  `progress.phase`, `nextAction.code`, `nextAction.actionClass`, succeeded/total
  step counts, and any recovery or open-gate detail.
- Stop and clean up the wrapper only when `progress.cleanup` is `"release"`,
  `runState` is `canceled`, or `nextAction.code` is `no_action`.
- Keep polling recoverable terminal failures only when `progress.cleanup` is `"none"`
  and either `disposition` is `"recover"` or `progress.phase` is `"blocked"`,
  so a later repair, retry, or clear-recovery emits the next meaningful state.

For `workflow run watch --once --json`, use the frozen top-level supervisor envelope described below:

- Suppress the human update when `emit` is `false`; the tick still carries the
  same `reason`, `phase`, and `digest` for machine dedupe.
- Branch on `recommendedAction` (`poll`, `approve`, `operator_decision`,
  `recover`, or `release`) and use `nextAction.actionClass`,
  `nextPollSeconds`, `quietForSeconds`, `quietThresholdSeconds`, `stuckRisk`,
  `inspectionCommand`, and `cleanup` directly.
- Read `recommendedActionPolicy` before turning a recommendation into any
  behavior. `auto_allowed` is only for explicit wait/release/read-only or local
  recheck cases; approvals, operator decisions, recovery clearing, stale manual
  recovery, no-mistakes recovery, merge cleanup, Linear refresh, and
  external-apply require human authority. If policy metadata is missing or
  invalid, treat every non-wait action as `human_required`.
- Render concise human text from `reason`, `activeStep`, `nextAction.detail`,
  `humanAction.command`, `humanAction.detail`, and `humanAction.gateType` when `humanAction` is present.
- Stop and clean up the wrapper when `recommendedAction` is `"release"`,
  `cleanup` is `"release"`, and `recommendedActionPolicy` allows
  `release_monitor`; keep polling recoverable failures while
  `recommendedAction` is `"operator_decision"` or `"recover"`.

The source eligibility check for `workflow run monitor --advance` and
`workflow run watch --once` is the durable run source
`momentum-native-coding`.
A `mwf-*` run id is a useful operator convention for explicit Momentum-native
workflow runs, not the semantic contract.

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `advance_unsupported_source` | `--advance` was requested for a run whose source is not `momentum-native-coding`. |

### Text output

```text
Workflow run monitor: cwfp-abc123
Schema version: 1
Run state: running
Step state: running
Terminal: false
Blocked: false
Needs manual recovery: false
Disposition: wait
Reportable: false
Report reason: in_progress
Next action: resume_running
Active step: implementation [running]
Steps: 5 approvals=1 leases=1
Gates: 1 (open: 1)
- gate-nm-1 [step/operator_decision_required] OPEN allowed=fix,skip,approve_as_is recommended=fix
Progress phase: advancing
Progress changed: true (emit: true)
Progress advanced: false
Last event: step:implementation:running
Cleanup: none
Progress digest: sha256:7abb560d717661265f609b02107bd6fce701de831d42a28bd1f7af344aa52ad5
Data dir: /path/to/data
```

A `Manual recovery reason: <reason>` line is added when the durable run-scoped reason is present.
A `Recovery: <code>` line is added when a recovery classification is present.
Open gates print inline after the `Gates:` count; resolved gates are omitted from text output.
A `Blocker: <reason>` line is added between `Last event` and `Cleanup` when the run is in the `blocked` phase.

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run watch`

```text
momentum workflow run watch <run-id> --once [--data-dir <path>] [--json]
momentum workflow run watch <run-id> --stream --jsonl [--since <cursor>] [--data-dir <path>]
```

`--once` emits a one-shot supervisor tick for a Momentum-native coding workflow run.
The command reads the durable monitor projection, persists this tick's advisory digest / timestamp baseline, and returns a compact next-action envelope for cron, OpenClaw, or GUI pollers.
OpenClaw hosts that need chat-delivery suppression, path-sanitized inspection commands, Discord/OpenClaw delivery intents, and terminal monitor cleanup should call [`openclaw supervise`](openclaw-supervise.md), which wraps this one-shot watch envelope and stores its own local delivery state.
That wrapper also config-gates and audits its own local auto-actions before any local state write, records the intended saved status before that write, and appends a matching failed status row if the write fails; the raw watch command only reports `recommendedActionPolicy` and does not write OpenClaw auto-action audit files.
When the wrapper's local auto-action audit fails closed, it suppresses its own monitor-removal cleanup hint and surfaces a human-required OpenClaw escalation instead of changing the raw watch contract.
It does not resolve approvals, gates, manual recovery, or other operator decisions.
When `--once` is eligible to dispatch a live-wrapper-owned setup step such as
`preflight` or `postflight`, `MOMENTUM_LIVE_WRAPPER_PROFILE` must be configured.
Without that profile, watch refuses before moving the step to `running` so a
chat/supervisor poll cannot strand the workflow without terminal dispatch
evidence.

`--stream --jsonl` opens a long-lived JSONL stream over the same durable event cursor API as `workflow run events`.
It emits one newline-delimited JSON record per durable semantic event, plus machine heartbeats, and exits cleanly once the run is terminal.
The stream is an optimization over durable state, never the source of truth: a disconnected client reconnects with `--since <cursor>` and loses nothing.
See [Stream mode](#stream-mode) below.

Required arguments:

- `<run-id>` - the run to inspect.

Options:

- `--once` - run the one-shot supervisor tick. Mutually exclusive with `--stream`.
- `--stream` - open the long-lived JSONL event stream. Requires `--jsonl`. Mutually exclusive with `--once`.
- `--jsonl` - emit newline-delimited JSON records (stream mode only).
- `--since <cursor>` - resume the stream from a durable cursor returned by a prior record or by `workflow run events` (stream mode only).

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run watch",
  "mode": "once",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "runId": "mwf-abc123",
  "runState": "running",
  "emit": true,
  "reason": "in_progress",
  "disposition": "wait",
  "phase": "advancing",
  "activeStep": {
    "stepId": "implementation",
    "kind": "implementation",
    "state": "running",
    "order": 1,
    "required": true
  },
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "leaseKind": "managed-step",
    "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.",
    "actionClass": "continue_polling",
    "recoveryDetail": null
  },
  "humanAction": null,
  "recommendedAction": "poll",
  "recommendedActionPolicy": {
    "action": "watch_recheck",
    "authority": "auto_allowed",
    "risk": "low",
    "evidenceRequired": ["fresh watch envelope", "durable workflow rows"],
    "rollback": "Stop polling; no external state was changed by the policy.",
    "rationale": "Supervisor watch rechecks are explicitly allowlisted for local/read-only polling metadata."
  },
  "nextPollSeconds": 15,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 900,
  "stuckRisk": "low",
  "inspectionCommand": null,
  "cleanup": "none",
  "digest": "sha256:7abb560d717661265f609b02107bd6fce701de831d42a28bd1f7af344aa52ad5"
}
```

`disposition`, `phase`, `cleanup`, and `digest` are derived from the same monitor progress tick as `workflow run monitor --advance`; plain `workflow run monitor` reads the projection without advancing any baseline.
`emit` and `reason` can also reflect watch-only quiet-heartbeat or stuck-risk advisories when an unchanged tick reaches its quiet threshold.
When a quiet-heartbeat or stuck-risk advisory emits, the command appends a matching workflow event row so disconnected clients can later catch up through `workflow run events`.
Before deriving that tick, `workflow run watch --once` may run one target-run dispatcher tick, either to claim and dispatch one approved non-tail next step or to recheck one active running step that the scheduler can safely revisit.
Approved `merge-cleanup` and `linear-refresh` tail steps are not started by that dispatcher tick; the envelope reports `recommendedAction: "operator_decision"` with a human-required merge-cleanup or Linear-refresh policy instead.
It does not resolve gates, approvals, or recovery decisions by itself, recover stale leases, or scan or claim work from other runs.
`activeStep` is `null` when no step is active.
`humanAction` is `null` when no operator command is required, points to `workflow run approve` for approval waits, points to `workflow run decide` for open gates, and points to `workflow run clear-recovery` only for recovery states that can be cleared directly or with an explicit evidence pointer.
Soft `monitor_drift_stale` reports and ordinary `failed_required_step` failures do not emit a clear-recovery command.

### Field meanings

| Field | Type | Meaning |
|-------|------|---------|
| `ok` | boolean | Always `true` for a rendered tick; failures use the error envelope below. |
| `command` | string | Always `"workflow run watch"`. |
| `mode` | string | `"once"` for the one-shot envelope below. Stream-mode records carry `"stream"` instead; see [Stream mode](#stream-mode). |
| `dataDir` | string | Resolved data directory the tick read. |
| `schemaVersion` | number | Envelope schema version; currently `1`. |
| `generatedAt` | number | Epoch-millisecond time the tick was rendered. |
| `runId` | string | The inspected run id. |
| `runState` | string | Durable run state (`pending`, `running`, `succeeded`, `failed`, `canceled`). |
| `emit` | boolean | Machine-polling signal: `true` when this tick differs from the last emitted digest or a quiet-heartbeat / stuck-risk advisory is due, `false` to suppress a duplicate unchanged update below the quiet threshold. |
| `reason` | enum | Human-facing classification: `terminal_succeeded`, `terminal_canceled`, `recovery_required`, `monitor_drift`, `awaiting_approval`, `in_progress`, `idle`, `quiet_heartbeat`, or `stuck_risk`. |
| `disposition` | enum | Machine action class: `wait`, `report`, or `recover`. |
| `phase` | enum | Progress phase: `advancing`, `idle`, `awaiting_approval`, `blocked`, or `terminal`. |
| `activeStep` | object \| null | The step in flight, or `null` when no step is active. |
| `nextAction` | object | Machine next-step pointer derived from the monitor projection. |
| `humanAction` | object \| null | The single operator command that unblocks the run, or `null` when no operator command is required; when present it carries `code`, `command`, `detail`, and `gateType`. |
| `recommendedAction` | enum | What the poller should do: `poll`, `approve`, `operator_decision`, `recover`, or `release`. |
| `recommendedActionPolicy` | object | Authority metadata for the recommendation: `action`, `authority`, `risk`, `evidenceRequired`, `rollback`, and `rationale`. Consumers must fail closed by treating absent or invalid policy as `human_required` for every non-wait action. |
| `nextPollSeconds` | number | Suggested wait before the next tick: `0` for release, `30` for blocked or approval waits, `15` otherwise. |
| `quietForSeconds` | number | Elapsed seconds since the last surfaced tick for this run. It is `0` on a first observation or meaningful state change, grows across suppressed unchanged polls, and is included on throttled `quiet_heartbeat` / `stuck_risk` emissions. |
| `quietThresholdSeconds` | number | Current quiet advisory threshold for the run phase or active step kind. Defaults: implementation `900`, postflight `600`, no-mistakes `900`, merge-cleanup `300`, linear-refresh `300`, approval reminders `1800`, recovery reminders `3600`, idle `900`. |
| `stuckRisk` | enum | `low` for ordinary progressing work, `medium` for idle or approval waits and active-execution stuck-risk advisories, `high` for blocked or recovery states. |
| `inspectionCommand` | string \| null | Suggested inspection command when `reason` is `stuck_risk`; otherwise `null`. The command includes the resolved `--data-dir` so follow-up inspection reads the same state. The CLI never performs diagnosis itself. |
| `cleanup` | enum | `release` once the wrapper can stop polling, otherwise `none`. |
| `digest` | string | Deterministic `sha256:` progress digest; unchanged across identical ticks so consumers can dedupe. |

`activeStep`, when present, carries `stepId`, `kind`, `state`, `order`, and `required`.
`nextAction` always carries `code`, `stepId`, `leaseKind`, `detail`, `actionClass`, and `recoveryDetail`; `detail` is a ready-to-read sentence for the common path.
`actionClass` is the stable operator decision class for watch/status/monitor/handoff consumers:

- `continue_polling` - keep polling or dispatching the already-approved non-tail local step.
- `approve_next_gate` - use the printed approval command.
- `fix_setup_config_then_retry` - fix runtime/auth/config setup before retrying.
- `reconcile_deterministic_evidence` - provide deterministic no-mistakes evidence before clearing recovery when durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
- `reconcile_external_tail` - verify external state and clear recovery with an evidence pointer.
- `clear_recovery` - clear a non-tail manual recovery after resolving the cause.
- `operator_decision` - an approved side-effecting tail step needs operator authority before dispatch.
- `resolve_gate` - decide an open workflow gate with an allowed action.
- `retry_failed_step` - inspect a normal failed step and decide whether to retry.
- `stop_monitoring` - release or stop the monitor for a terminal run.

`recoveryDetail` is `null` for ordinary states.
Recovery states that require external evidence use a compact object with `kind`, `evidencePointerRequired`, and `refusalReason`.
Current `kind` values are `no_mistakes_deterministic_evidence` and `external_tail_reconcile`.
`recommendedActionPolicy.authority` is `auto_allowed` only for explicit safe wait/release/read-only or local recheck cases, `recommend_only` for informational recommendations that must not execute, `human_required` for approvals, operator decisions, recovery clearing, stale manual recovery, no-mistakes recovery, merge cleanup, Linear refresh, and external-apply, and `forbidden` for destructive/default-switch/broad external actions that must surface as blocked policy metadata.
`humanAction`, when present, carries `code` (`approve`, `resolve_gate`, or `clear_recovery`), `command` (the exact CLI to run), `detail` (the reason or evidence sentence), and `gateType`.
`gateType` is `null` for approval and clear-recovery commands, and carries the durable workflow gate type when `code` is `resolve_gate`.
When an open gate and an approved side-effecting tail step coexist, `humanAction.gateType` makes the gate policy authoritative before any tail-step policy implied by `nextAction.stepId`.

### Stream mode

`workflow run watch <run-id> --stream --jsonl` opens a long-lived stream that turns the durable event cursor API into newline-delimited JSON.
Each record is a single self-contained line, so a consumer can split stdout on `\n` and `JSON.parse` each line independently.
The stream polls durable state once per second while the run is non-terminal, writes every record as it is produced, and retains only the resume cursor between polls, so memory stays flat for the lifetime of even a very long run.
The poll interval is a liveness cadence, not a delivery guarantee; consumers should persist cursors and resume with `--since` after reconnecting.

Two record kinds share a common header (`ok`, `command: "workflow run watch"`, `mode: "stream"`, `runId`, `kind`, `emit`, `cursor`, `terminal`):

- `kind: "event"` carries one durable semantic event under `event` (`id`, `cursor`, `timestamp`, `type`, `stepId`, `payload`) and is always `emit: true`.
  These are the human-worthy records.
- `kind: "heartbeat"` is a synthetic liveness tick emitted when a poll observed no new events, and is always `emit: false`.
  A consumer suppresses heartbeats from any human-facing surface and uses them only to confirm the stream is alive.

`cursor` is the durable resume token after the record; pass the last one you handled back as `--since` to reconnect exactly where you left off.
`terminal` becomes `true` once the run reaches (or is already in) a terminal state.
The stream emits the terminal record and then exits cleanly with status `0`; a client that reconnects past the terminal event still observes `terminal: true` on its next heartbeat because the run row's durable state is read out of band.
`SIGINT` (Ctrl-C) aborts the stream between polls and exits cleanly - the durable event API is always there to reconnect from.

An event record:

```json
{
  "ok": true,
  "command": "workflow run watch",
  "mode": "stream",
  "kind": "event",
  "emit": true,
  "runId": "mwf-abc123",
  "cursor": "wfcur1.eyJ0IjozMDAwMCwiaWRzIjpbXX0",
  "terminal": false,
  "event": {
    "id": "000000030000:monitor_quiet_heartbeat:mwf-abc123",
    "cursor": "wfcur1.eyJ0IjozMDAwMCwiaWRzIjpbXX0",
    "timestamp": 1730000030000,
    "type": "monitor_quiet_heartbeat",
    "stepId": "implementation",
    "payload": {}
  }
}
```

A heartbeat record:

```json
{
  "ok": true,
  "command": "workflow run watch",
  "mode": "stream",
  "kind": "heartbeat",
  "emit": false,
  "runId": "mwf-abc123",
  "cursor": "wfcur1.eyJ0IjozMDAwMCwiaWRzIjpbXX0",
  "generatedAt": 1730000045000,
  "terminal": false
}
```

Stream-mode failures (`--stream` without `--jsonl`, an unknown run, an invalid `--since` cursor, or `--stream` combined with `--once`) are reported on stderr with status `1`, not as stream records.
When `--jsonl` or `--json` is active, failures use the shared workflow JSON error envelope.
Usage errors, such as an extra positional argument or a missing value for `--since`, also serialize as that JSON envelope when `--jsonl` is present, but still exit with status `2`.
See [Error codes](#error-codes).

### Supervisor scenarios

The same envelope shape covers every tick; these are the common contract scenarios a poller branches on.
Only the distinguishing fields are shown.

Progress tick - a step is advancing under a fresh lease, so keep polling quietly:

```json
{
  "emit": true,
  "reason": "in_progress",
  "disposition": "wait",
  "phase": "advancing",
  "activeStep": { "stepId": "implementation", "state": "running" },
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "actionClass": "continue_polling",
    "recoveryDetail": null
  },
  "humanAction": null,
  "recommendedAction": "poll",
  "recommendedActionPolicy": {
    "action": "watch_recheck",
    "authority": "auto_allowed",
    "risk": "low"
  },
  "nextPollSeconds": 15,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 900,
  "stuckRisk": "low",
  "inspectionCommand": null,
  "cleanup": "none"
}
```

Unchanged tick - a repeated identical poll below the quiet threshold suppresses `emit` while `reason` and `digest` hold steady, so a consumer skips a duplicate update:

```json
{
  "emit": false,
  "reason": "in_progress",
  "disposition": "wait",
  "phase": "advancing",
  "recommendedAction": "poll",
  "recommendedActionPolicy": {
    "action": "watch_recheck",
    "authority": "auto_allowed",
    "risk": "low"
  },
  "nextPollSeconds": 15,
  "quietForSeconds": 24,
  "quietThresholdSeconds": 900,
  "stuckRisk": "low",
  "inspectionCommand": null,
  "cleanup": "none",
  "humanAction": null
}
```

Stuck risk - a repeated identical active-execution poll reaches the active step's quiet threshold, so the CLI emits an advisory only and recommends an inspection command:

```json
{
  "emit": true,
  "reason": "stuck_risk",
  "disposition": "wait",
  "phase": "advancing",
  "activeStep": { "stepId": "implementation", "state": "running" },
  "recommendedAction": "poll",
  "recommendedActionPolicy": {
    "action": "watch_recheck",
    "authority": "auto_allowed",
    "risk": "low"
  },
  "nextPollSeconds": 15,
  "quietForSeconds": 900,
  "quietThresholdSeconds": 900,
  "stuckRisk": "medium",
  "inspectionCommand": "momentum workflow run monitor 'mwf-abc123' --data-dir '/path/to/momentum-data' --advance --json",
  "cleanup": "none",
  "humanAction": null
}
```

Approval required - the next step is gated on operator approval:

```json
{
  "emit": true,
  "reason": "awaiting_approval",
  "disposition": "report",
  "phase": "awaiting_approval",
  "recommendedAction": "approve",
  "recommendedActionPolicy": {
    "action": "approval_decision",
    "authority": "human_required",
    "risk": "medium"
  },
  "nextPollSeconds": 30,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 1800,
  "stuckRisk": "medium",
  "inspectionCommand": null,
  "cleanup": "none",
  "humanAction": {
    "code": "approve",
    "command": "momentum workflow run approve mwf-abc123 --approval-boundary through-implementation --phrase \"approve plan mwf-abc123 through-implementation\"",
    "detail": "Step implementation is waiting for approval.",
    "gateType": null
  }
}
```

Recovery required - the run is flagged for manual recovery and can be cleared directly:

```json
{
  "emit": true,
  "reason": "recovery_required",
  "disposition": "recover",
  "phase": "blocked",
  "recommendedAction": "recover",
  "recommendedActionPolicy": {
    "action": "clear_recovery",
    "authority": "human_required",
    "risk": "high"
  },
  "nextPollSeconds": 30,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 3600,
  "stuckRisk": "high",
  "inspectionCommand": null,
  "cleanup": "none",
  "nextAction": {
    "code": "clear_recovery",
    "stepId": "implementation",
    "actionClass": "clear_recovery",
    "recoveryDetail": null
  },
  "humanAction": {
    "code": "clear_recovery",
    "command": "momentum workflow run clear-recovery mwf-abc123",
    "detail": "dispatch lease requires operator recovery",
    "gateType": null
  }
}
```

Idle risk - the run is `running` but exposes no active step, so the tick keeps polling at a raised `stuckRisk`:

```json
{
  "emit": true,
  "reason": "idle",
  "disposition": "wait",
  "phase": "idle",
  "activeStep": null,
  "recommendedAction": "poll",
  "recommendedActionPolicy": {
    "action": "watch_recheck",
    "authority": "auto_allowed",
    "risk": "low"
  },
  "nextPollSeconds": 15,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 900,
  "stuckRisk": "medium",
  "inspectionCommand": null,
  "cleanup": "none",
  "humanAction": null
}
```

Terminal success - the run finished cleanly, so the wrapper reports once and stops polling:

```json
{
  "emit": true,
  "reason": "terminal_succeeded",
  "disposition": "report",
  "phase": "terminal",
  "activeStep": null,
  "nextAction": {
    "code": "no_action",
    "stepId": null,
    "actionClass": "stop_monitoring",
    "recoveryDetail": null
  },
  "humanAction": null,
  "recommendedAction": "release",
  "recommendedActionPolicy": {
    "action": "release_monitor",
    "authority": "auto_allowed",
    "risk": "low"
  },
  "nextPollSeconds": 0,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 0,
  "stuckRisk": "low",
  "inspectionCommand": null,
  "cleanup": "release"
}
```

Recoverable failure - a required step failed, so an operator must inspect and decide; there is no single canned command, so `humanAction` is `null`:

```json
{
  "emit": true,
  "reason": "recovery_required",
  "disposition": "recover",
  "phase": "blocked",
  "nextAction": {
    "code": "rerun_failed_step",
    "stepId": "implementation",
    "actionClass": "retry_failed_step",
    "recoveryDetail": null
  },
  "humanAction": null,
  "recommendedAction": "operator_decision",
  "recommendedActionPolicy": {
    "action": "operator_decision",
    "authority": "human_required",
    "risk": "medium"
  },
  "nextPollSeconds": 30,
  "quietForSeconds": 0,
  "quietThresholdSeconds": 3600,
  "stuckRisk": "high",
  "inspectionCommand": null,
  "cleanup": "none"
}
```

### Consumer branching rules

A cron, OpenClaw, or GUI poller branches on the envelope instead of scraping text:

- Suppress the update when `emit` is `false`.
  A suppressed tick repeats the prior `reason`, `phase`, and `digest`, so no new human update is warranted.
- Treat `reason: "quiet_heartbeat"` and `reason: "stuck_risk"` as throttled advisory updates only. They do not mean the run or step failed; inspect with `inspectionCommand` when present and keep polling unless another field asks for operator action or release.
- Check `recommendedActionPolicy` before executing or suppressing any behavior from `recommendedAction`; absent or invalid policy is fail-closed and makes every non-wait action human-required.
- Otherwise branch on `recommendedAction`:
  - `poll` - work is advancing or idle; wait `nextPollSeconds` and tick again.
  - `approve` - run `humanAction.command` (a `workflow run approve` call) to release the approval gate.
  - `operator_decision` - a required step failed, a gate is open, or an approved `merge-cleanup` / `linear-refresh` tail step needs operator authority before dispatch; an operator inspects and chooses via `workflow run decide`, a rerun, or the appropriate side-effecting tail path, so `humanAction` may be `null`.
  - `recover` - run `humanAction.command` (a `workflow run clear-recovery` call, with `--evidence-pointer` for external-side-effect steps) after resolving the underlying cause.
  - `release` - the run reached a clean terminal state (`cleanup: "release"`, `nextAction.code: "no_action"`); report once and stop polling only when `recommendedActionPolicy` allows `release_monitor`.
- `emit` is the machine-polling signal, `nextAction.actionClass` is the compact operator branch, and `reason` / `humanAction` are the human-facing content.
- Decide whether to speak from `emit`, and what to say from `reason`, `activeStep`, `nextAction.detail`, `nextAction.recoveryDetail`, and `humanAction`.
- The envelope carries enough to render a concise human update for the common path - `reason`, `activeStep`, and `nextAction.detail`, plus `nextAction.recoveryDetail` and `humanAction.command` / `detail` / `gateType` when an action is required - without a follow-up `workflow status` read.

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `once_required` | Neither `--once` nor `--stream` was supplied. |
| `jsonl_required` | `--stream` was supplied without `--jsonl`. |
| `stream_once_conflict` | `--stream` and `--once` were supplied together. |
| `usage_error` | The stream invocation is malformed, such as an extra positional argument or a missing value for `--since`; with `--jsonl`, this still renders as JSON and exits `2`. |
| `invalid_cursor` | The `--since` value is not a valid durable event cursor. |
| `data_dir_failed` | Data directory resolution, SQLite access, the bounded `--once` dispatch tick, or stream polling failed. |
| `daemon_live_wrapper_profile_invalid` | The shared daemon live-wrapper profile was configured but unreadable or invalid when the bounded dispatch tick resolved it. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `watch_unsupported_source` | The run source is not `momentum-native-coding` (`--once` mode only). |

### Text output

```text
Workflow run watch: mwf-abc123
Mode: once
Emit: true
Reason: in_progress
Disposition: wait
Phase: advancing
Next action: resume_running
Recommended action: poll
Recommended action policy: auto_allowed (low)
Next poll seconds: 15
Quiet for seconds: 0
Quiet threshold seconds: 900
Stuck risk: low
Cleanup: none
Digest: sha256:7abb560d717661265f609b02107bd6fce701de831d42a28bd1f7af344aa52ad5
Data dir: /path/to/data
```

A human action line is included when the tick requires an operator command.
An inspection command line is included when a stuck-risk advisory recommends a follow-up monitor inspection.

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run events`

```text
momentum workflow run events <run-id> [--since <cursor>] [--data-dir <path>] [--json]
```

Replay one workflow run's durable semantic event projection. This command is for supervisors and app clients that may lose process state and need to catch up from the last event they handled. It is not a streaming API: each invocation reads the current durable database state once, returns the events after `--since`, and exits.

The event stream is built from two durable sources:

- Reproducible workflow rows: step start / terminal states, approvals, gates, and terminal run state.
- Append-only workflow event rows for transitions that would otherwise be overwritten, such as manual-recovery mark / clear, blocked-step metadata, guarded clear retry / reconciliation preservation, and throttled supervisor advisories.

Imported compatibility runs and databases created before `workflow_events` existed still replay the reproducible events available from their durable workflow rows.

Cursor semantics:

- Every event carries a stable `id` and an opaque replay `cursor`.
- The response `cursor` is the highest returned replay cursor, or the supplied `since` cursor when no higher cursor exists.
- Repeating the same `--since` against unchanged durable state is deterministic and idempotent.
- To continue, pass the previous response `cursor` as the next `--since` value.
- A `null` / omitted cursor means "replay from the beginning".
- Cursors are opaque `wfcur1.` replay tokens and may encode all event ids already seen at the current timestamp so later inserted same-timestamp events are still returned. Non-empty `--since` values that are not valid `wfcur1.` replay tokens are rejected with `invalid_cursor`.

Event records are ordered by event timestamp, lifecycle rank, then deterministic replay cursor. Event ids are stable identities for the durable facts that produced them; clients should store `id` for dedupe and use only `cursor` / response `cursor` with the command's `--since` contract.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run events",
  "dataDir": "/path/to/data",
  "runId": "mwf-abc123",
  "since": "wfcur1.eyJ0IjoxNzMwMDAwNTAwMDAwLCJpZHMiOlsiMDAwMTczMDAwMDUwMDAwMDpzdGVwX3N0YXJ0ZWQ6Li4uIl19",
  "cursor": "wfcur1.eyJ0IjoxNzMwMDAwNjAwMDAwLCJpZHMiOlsiMDAwMTczMDAwMDYwMDAwMDpzdGVwX3N1Y2NlZWRlZDphYmMxMjMiXX0",
  "events": [
    {
      "id": "0001730000600000:step_succeeded:...",
      "cursor": "wfcur1.eyJ0IjoxNzMwMDAwNjAwMDAwLCJpZHMiOlsiMDAwMTczMDAwMDYwMDAwMDpzdGVwX3N1Y2NlZWRlZDphYmMxMjMiXX0",
      "timestamp": 1730000600000,
      "type": "step_succeeded",
      "stepId": "implementation",
      "payload": {
        "kind": "implementation",
        "order": 1,
        "required": true,
        "resultDigest": "sha256:..."
      }
    }
  ],
  "counts": { "events": 1 }
}
```

`type` is one of `step_started`, `step_succeeded`, `step_failed`, `step_skipped`, `step_canceled`, `step_blocked`, `approval_required`, `approval_resolved`, `recovery_required`, `recovery_cleared`, `gate_opened`, `gate_resolved`, `terminal_state`, `monitor_stuck_risk`, or `monitor_quiet_heartbeat`.

`payload` is intentionally concise and type-specific. Step events carry step kind/order/required plus result or error fields when present, and blocked-step events carry the operator reason / actor / evidence / ledger pointers when available. Approval and gate events carry the boundary or gate identity and decision metadata. Recovery events carry the reason or previous recovery reason. Monitor advisory events are throttled semantic advisories, not ordinary heartbeat spam.

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution or SQLite access failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `invalid_cursor` | `--since` was not a valid `wfcur1.` workflow event replay cursor. |

### Text output

```text
Workflow events for run: mwf-abc123
Since: (start)
Cursor: wfcur1.eyJ0IjoxNzMwMDAwNjAwMDAwLCJpZHMiOlsiMDAwMTczMDAwMDYwMDAwMDpzdGVwX3N1Y2NlZWRlZDphYmMxMjMiXX0
Events: 1
  1730000600000 step_succeeded step=implementation cursor=wfcur1.eyJ0IjoxNzMwMDAwNjAwMDAwLCJpZHMiOlsiMDAwMTczMDAwMDYwMDAwMDpzdGVwX3N1Y2NlZWRlZDphYmMxMjMiXX0
Data dir: /path/to/data
```

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

### Boundary with stream mode

`workflow run events` is replay-only. It does not hold a connection open, emit JSONL, or watch for filesystem/database changes after the read. A caller that wants a live connection should use `workflow run watch <run-id> --stream --jsonl`, which holds the connection open and emits JSONL records over the same durable event cursor API; a caller that prefers discrete reads should poll `workflow run events` with the last returned cursor.

## Native goal-loop evidence contract

Native goal-loop log readers treat Momentum executor rows and child evidence as the source of truth.
`workflow run logs` is the shipped consumer of this projection today.
Future status, handoff, monitor, and GUI readers must use the same projection once they are wired to executor round evidence.
The implementation step's `goal-loop` executor records one `executor_invocation` for the autonomous attempt and one ordered `executor_round` per durable iteration.
Before each round's runner starts, Momentum renders a deterministic prompt from objective, source context, round identity, repo/base-head context, acceptance and verification requirements, prior round evidence, and the configured result path.
Source context and prior-round evidence are quoted as untrusted JSON context, and stale result files are cleared before the runner is asked to write the fresh normalized result JSON.
Readers must derive attempt state plus summaries, key changes, learnings, remaining work, verification status, changed files, commit SHA, recovery reason, artifacts, checkpoints, findings, and decisions from those rows and artifact pointers.
Post-finalization native round evidence exposes the executor's `completionRecommendation` as `complete`, `continue`, `approval_required`, `operator_decision_required`, `manual_recovery_required`, `blocked`, `failed`, or `cancelled`.
It exposes Momentum's post-policy daemon decision separately as `daemonClassification`, so quota, recovery, and operator gates do not overwrite what the executor recommended.
For `goal-loop` rounds, `workflow run logs --json` includes the schema-aligned `nativeRoundEvidence` projection next to the raw durable round and child evidence fields.
For non-`goal-loop` executor rows, `nativeRoundEvidence` is `null`.
They must not scrape terminal scrollback or treat `.gnhf/runs` as authoritative.
A GNHF-backed mechanism may run beneath `goal-loop`, but `gnhf` is not a workflow executor family and cannot replace the native invocation/round contract.
Successful rounds show the single commit SHA Momentum recorded for that round.
Failed, invalid, stale, unsafe, canceled, or no-op rounds show their recovery and checkpoint evidence without inventing a commit.

## `workflow run logs`

```text
momentum workflow run logs <run-id> [--data-dir <path>] [--json]
```

Read-back of one workflow run's durable logs and evidence, for operators inspecting what each step actually ran and produced.
It is the workflow-first equivalent of goal-first `logs <goal-id>`: it wraps the same detail loader as `workflow status <run-id>` / `workflow handoff` (run, steps, approvals, leases, monitor, evidence, gates) and adds executor invocation read-back plus the per-round executor evidence that the detail loader does not carry - executor family / agent / model / effort, input and result digests, log paths, summaries, key changes, learnings, remaining work, executor recommendation, outcome, changed files, verification status and command details, native round evidence, commit SHA, recovery codes, and the child artifacts / checkpoints / findings / decisions emitted below each round.
Read-only: no SQLite mutation, no file reads, no external writes.

Invocations are returned across the run in step key, attempt, invocation id order.
Rounds are returned across every invocation in the run, ordered by step key, then invocation attempt, then invocation id, then round index, then round id.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run logs",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "run": { "...": "same shape as workflow status detail" },
  "steps": [ "..." ],
  "approvals": [ "..." ],
  "leases": [ "..." ],
  "monitor": { "...": "same shape as workflow status detail" },
  "evidence": [ "..." ],
  "gates": [ "..." ],
  "invocations": [
    {
      "invocationId": "cwfp-abc123::implementation::dispatch",
      "workflowRunId": "cwfp-abc123",
      "stepRunId": "implementation",
      "stepKey": "implementation",
      "executorFamily": "goal-loop",
      "state": "running",
      "attempt": 1,
      "startedAt": 1730000500000,
      "heartbeatAt": 1730000550000,
      "finishedAt": null
    }
  ],
  "rounds": [
    {
      "roundId": "cwfp-abc123::implementation::dispatch::round-1",
      "invocationId": "cwfp-abc123::implementation::dispatch",
      "stepRunId": "implementation",
      "stepKey": "implementation",
      "executorFamily": "goal-loop",
      "attempt": 1,
      "roundIndex": 0,
      "state": "succeeded",
      "classification": "complete",
      "executorRecommendation": "complete",
      "outcome": "successful",
      "startedAt": 1730000500000,
      "heartbeatAt": 1730000550000,
      "finishedAt": 1730000600000,
      "agentProvider": "claude",
      "model": "claude-opus-4-8",
      "effort": "high",
      "inputDigest": "sha256:...",
      "resultDigest": "sha256:...",
      "artifactRoot": "/path/to/data/runs/cwfp-abc123/round-1",
      "logPaths": ["/path/to/data/runs/cwfp-abc123/round-1/agent.log"],
      "summary": "implemented the slice",
      "keyChanges": ["added reader"],
      "keyLearnings": ["use durable round state for follow-up input"],
      "learnings": ["use durable round state for follow-up input"],
      "nativeRoundEvidence": {
        "schema": "momentum.native-goal-loop.round-result.v1",
        "summary": "implemented the slice",
        "keyChanges": ["added reader"],
        "learnings": ["use durable round state for follow-up input"],
        "completionRecommendation": "complete",
        "daemonClassification": "complete",
        "verificationResult": {
          "status": "passed",
          "commands": [
            {
              "command": "pnpm test",
              "exitCode": 0,
              "durationMs": 1200,
              "timedOut": false
            }
          ]
        },
        "artifacts": [
          {
            "class": "verification_output",
            "path": "/path/to/data/runs/cwfp-abc123/round-1/verify.txt",
            "digest": "sha256:..."
          }
        ],
        "checkpoints": [
          {
            "stage": "verify",
            "detail": "verification completed"
          }
        ],
        "changedFiles": ["src/core/workflow/run/logs.ts"],
        "commitSha": "abc123",
        "recoveryReason": null,
        "remainingWork": []
      },
      "remainingWork": [],
      "changedFiles": ["src/core/workflow/run/logs.ts"],
      "verificationStatus": "passed",
      "commitSha": "abc123",
      "recoveryCode": null,
      "recoveryReason": null,
      "humanGate": null,
      "artifacts": [
        {
          "artifactId": "artifact-1",
          "roundId": "cwfp-abc123::implementation::dispatch::round-1",
          "artifactClass": "verification_output",
          "path": "/path/to/data/runs/cwfp-abc123/round-1/verify.txt",
          "digest": "sha256:...",
          "description": "verification output"
        }
      ],
      "checkpoints": [
        {
          "checkpointId": "checkpoint-1",
          "roundId": "cwfp-abc123::implementation::dispatch::round-1",
          "sequence": 0,
          "stage": "verify",
          "detail": "verification completed"
        }
      ],
      "findings": [],
      "decisions": []
    }
  ],
  "nextAction": { "...": "same shape as workflow status detail monitor.nextAction" }
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution, open, or read failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output

```text
Workflow run logs: cwfp-abc123
Schema version: 1
Generated at (epoch ms): 1730000600000
Run state: running
Implementation engine: native-goal-loop
Steps: 5
Approvals: 1
Leases: 1
Gates: 1 (open: 1)
- gate-nm-1 [step/operator_decision_required] OPEN allowed=fix,skip,approve_as_is recommended=fix
Executor invocations: 1
- cwfp-abc123::implementation::dispatch [implementation/running] attempt=1 executor=goal-loop
Executor rounds: 1
- cwfp-abc123::implementation::dispatch::round-1 [implementation/succeeded] complete outcome=successful
    summary: implemented the slice
    key changes: added reader
    learnings: use durable round state for follow-up input
    remaining work: wire additional consumers
    input digest: sha256:...
    result digest: sha256:...
    verification: passed commit: abc123
    verification commands: pnpm test (exit=0, duration=1200ms, timedOut=false)
    logs: /path/to/data/runs/cwfp-abc123/round-1/agent.log
    changed files: src/core/workflow/run/logs.ts
    child evidence: 2
    artifacts: /path/to/data/runs/cwfp-abc123/round-1/verify.txt
    checkpoints: 0:verify
Evidence records: 0
Data dir: /path/to/data
```

Exit code 0 on success, 1 on failure, 2 on usage error.
