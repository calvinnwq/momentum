# Workflow commands

Operator-facing CLI envelopes for the `workflow run start`, `workflow run start-coding`, `workflow run preview-coding`, `workflow import`, `workflow status`, `workflow handoff`, `workflow run list`, `workflow run approve`, `workflow run decide`, `workflow run update-step`, `workflow run clear-recovery`, `workflow run monitor`, and `workflow run logs` commands.

- `workflow run start` starts a first-class workflow run from a validated workflow definition: it resolves the definition (a persisted definition, or the built-in `coding-workflow` recipe), loads repo policy, and durably materializes a `workflow_runs` row plus one ordered `workflow_steps` row per definition step, with an approval row when an approval boundary is supplied.
  `goal start` remains the compatibility path for the older Goal loop.
- `workflow run start-coding` is the explicit Momentum-native coding-workflow start door: a thin selector over `workflow run start` that always uses the built-in `coding-workflow` definition, refuses run ids reserved for compatibility imports, and records the run with a Momentum-native source so it is unmistakably Momentum-owned.
  Use it to intentionally choose Momentum orchestration for a new coding workflow; the ordinary definition-sourced start and the imported compatibility runs are unchanged.
- `workflow run preview-coding` is the read-only plan preview for the Momentum-native coding workflow: it runs the same precondition checks and built-in definition resolution as `workflow run start-coding` but stops before any durable write, emitting a frozen plan an operator can inspect before approval or execution.
  It writes nothing and surfaces the run id, repo, objective, issue scope, approval boundary, route/profile, definition key/version, repo policy, and every step with its executor family.
- `workflow import` reads local `.agent-workflows/<run-id>/` directories and persists normalized rows into the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables.
- `workflow status` is a read-only surface that lists workflow runs (with state / filter selectors) or returns the full detail of a single run.
- `workflow handoff` is a read-only surface that emits a machine-readable next-action envelope for one run.
- `workflow run list` is a read-only filterable query surface over the durable `workflow_runs` table, with additional filter dimensions not available in `workflow status` list mode.
- `workflow run approve` records durable explicit approvals for workflow boundaries and persists operator-visible metadata (actor, phrase, artifact provenance) into `workflow_approvals`.
- `workflow run update-step` drives operator-initiated step transitions (`approved` / `succeeded` / `skipped` / `failed` / `blocked` / `canceled`) through the existing state machine, persisting an audit record with operator reason and optional evidence or ledger pointers.
- `workflow run clear-recovery` explicitly clears a run's durable manual-recovery flag after the blocking condition is resolved.
- `workflow run decide` resolves a durable workflow / step / executor gate by routing an operator or delegated-policy decision through the gate brain: an operator may pick any allowed action, while `--mode delegated` may only auto-apply an action inside the gate's policy envelope.
- `workflow run monitor` is a read-only machine envelope that emits one stable JSON shape per run — derived from durable rows and the monitor reducer — so a monitor runner can decide whether to report, wait, or ask an operator to recover without parsing prose or scraping artifacts.
- `workflow run logs` is a read-only run-scoped log and evidence reader that reuses the workflow detail shape and attaches executor rounds plus their child artifacts, checkpoints, findings, and decisions.

`workflow run preview-coding`, `workflow status`, `workflow handoff`, `workflow run list`, `workflow run monitor`, and `workflow run logs` are read-only: they never write SQLite or files.

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
- `--profile <name>` - record the selected runtime/profile on the run's durable `route.profile` so status, handoff, monitor, and logs can report which profile the run was started for.
  This captures the operator's intent in durable state; the daemon still resolves the live-wrapper profile it actually executes from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time.

Behaviour:

- **Definition resolution**: a persisted definition for `--definition` (optionally pinned by `--definition-version`) wins.
  When no matching definition is persisted, the built-in `coding-workflow` recipe is the fallback, so a fresh database can still start the canonical workflow.
  The fallback is persisted into `workflow_definitions` / `step_definitions` before the run is written.
  An unresolved key/version refuses with `definition_not_found`.
- **Repo policy loading**: `<repo>/MOMENTUM.md` is loaded and validated. A present-but-malformed policy refuses the start with `policy_invalid` and writes nothing; an absent policy is allowed and reported as `policy.present: false`.
- **Materialization**: on success the command durably writes one `workflow_runs` row plus one ordered `workflow_steps` row per definition step, linking the run to the definition it started from (`workflow_definition_key` / `workflow_definition_version`). The run `source` is `workflow-definition`.
- **Approval boundary**: when `--approval-boundary` is supplied, the pending steps the boundary covers are persisted as `approved`, a `workflow_approvals` row is recorded with synthetic `workflow-run-start://<run-id>/<boundary>` provenance, and the run state is derived as `approved`; otherwise every step is `pending` and the run state is `pending`.
- **Execution**: `workflow run start` only materializes durable run state. Approved steps are claimed by bounded `daemon start --max-*`, which dispatches supported executor families into durable `executor_invocations` / `executor_rounds` scaffold rows with deterministic dispatcher ids and leaves register-only `daemon start` inert. The initial scaffold is ownership evidence only; result, artifact, verification, commit, and recovery fields remain empty until an executor fills them. The `external-apply` family is filled by the daemon itself for the built-in `linear-refresh` step: it matches a single pending Linear update intent for the run issue scope, reuses the policy-gated `intent apply --external-apply` write path, records terminal evidence, and reconciles the step; missing/ambiguous context or any unsafe apply refusal routes to manual recovery. Configured `subworkflow` steps are also filled by the daemon itself: child config comes from the parent run's `route.subworkflow.child`, recursion lineage is bounded through `route.subworkflow.lineage`, the child run starts or attaches by workflow definition key, and terminal child evidence is mirrored back to the parent step; missing config, unsafe recursion, unresolved child definitions, unsupported attachment, invalid child state, or ambiguous child terminals route to manual recovery. When `MOMENTUM_LIVE_WRAPPER_PROFILE` points managed-loop `daemon start` at a valid workflow live-wrapper profile, the daemon runs configured live-wrapper-owned step wrappers after the scaffold is created, records terminal executor evidence, and reconciles the step from that evidence. With no profile, supported live-wrapper-owned steps keep the start scaffold and wait for a later executor path; a configured profile that omits the dispatched kind routes that step to manual recovery rather than reporting fake success.
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
  "repoPath": "/path/to/repo",
  "objective": "Ship the feature",
  "counts": { "steps": 6 },
  "policy": { "present": false, "path": "/path/to/repo/MOMENTUM.md" }
}
```

`state` is `approved` and `approvalBoundary` echoes the supplied boundary when `--approval-boundary` is used; otherwise `state` is `pending` and `approvalBoundary` is `null`. `counts.steps` is the number of materialized step rows. `policy.present` is `true` only when a valid `MOMENTUM.md` was loaded; `policy.path` is always the resolved `MOMENTUM.md` path.

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

`dataDir` and `runId` are included whenever they are known at the point of failure. The `invalid_run_start` refusal additionally carries an `errors` array of `{ code, message, path? }` entries from the run-start materialization taxonomy:

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
  ]
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `--run-id` was not supplied. |
| `repo_required` | `--repo` was not supplied. |
| `objective_required` | `--objective` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `definition_not_found` | No workflow definition matches `--definition` (and `--definition-version`, when supplied), and the built-in fallback did not match either. |
| `policy_invalid` | `<repo>/MOMENTUM.md` is present but malformed; the start is refused and nothing is written. |
| `invalid_run_start` | Run-start materialization rejected the inputs; carries an `errors` array. |
| `run_exists` | A workflow run with `--run-id` already exists; the existing run is left untouched. |
| `route_config_not_allowed` | `--steps-json` was supplied to the generic start; per-step coding route overrides are only accepted on `workflow run start-coding` / `workflow run preview-coding`. |

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

The `Approval boundary` line prints the boundary when one was supplied. The `Policy` line prints the `MOMENTUM.md` path when a valid policy was loaded and `(none)` otherwise.

### Text output (failure)

```text
Workflow run already exists: run-1.
```

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run start-coding`

```text
momentum workflow run start-coding --run-id <id> --repo <path> --objective <text> [--approval-boundary <boundary>] [--skill-revision <text>] [--issue-scope <identifier>] [--profile <name>] [--steps-json <json>] [--definition-version <n>] [--data-dir <path>] [--json]
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
  This captures intent only; the executing live-wrapper profile is still resolved by the daemon from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time.
- `--steps-json <json>` - reconfigure the planned per-step harness/model/effort selections before the run starts, recorded on the run's durable `route.steps` so status, handoff, monitor, and logs can audit which selection the run was started with.
  The value is a JSON object keyed by the operationally meaningful coding steps (`implementation`, `postflight`, `no-mistakes`, `merge-cleanup`), each mapping to any of the `harness`, `model`, and `effort` string fields; an omitted step or field keeps the default (inherit at execution time).
  Selections are validated and normalized to a canonical, byte-stable shape before they are recorded; an unsupported step, unknown field, blank value, or malformed JSON fails closed with `route_config_invalid` and writes nothing.
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
- **Shared persistence**: everything else - durable run/step/approval rows, the no-clobber duplicate-run refusal, repo-policy refusal, and the `invalid_run_start` materialization taxonomy - matches `workflow run start`.
  The success and failure envelopes are identical except that `command` is `workflow run start-coding`.

### Error codes

In addition to every [`workflow run start`](#error-codes) refusal code (`run_id_required`, `repo_required`, `objective_required`, `data_dir_failed`, `definition_not_found`, `policy_invalid`, `invalid_run_start`, `run_exists`):

| Code | Meaning |
|------|---------|
| `reserved_run_id` | `--run-id` begins with a reserved compatibility prefix (`cwfp-`, `cwfb-`, `overnight-`); refused so native runs are not confused with imported compatibility state. |
| `definition_not_allowed` | A `--definition` other than `coding-workflow` was supplied; this door always uses the built-in coding workflow. |
| `route_config_invalid` | `--steps-json` is malformed JSON, names an unsupported step, carries an unknown field, or has a blank value; the run is refused and nothing is written. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run preview-coding`

```text
momentum workflow run preview-coding --run-id <id> --repo <path> --objective <text> [--approval-boundary <boundary>] [--skill-revision <text>] [--issue-scope <identifier>] [--profile <name>] [--steps-json <json>] [--definition-version <n>] [--data-dir <path>] [--json]
```

The read-only plan preview for the Momentum-native coding workflow.
It runs the exact same precondition checks and built-in definition resolution as [`workflow run start-coding`](#workflow-run-start-coding) - required inputs, the reserved-run-id and conflicting-`--definition` refusals, data-directory resolution, and repo-policy loading - but stops before any durable write.
Instead of persisting a run it emits a frozen plan an operator can inspect before approving or executing it.

It takes the same required and optional arguments as [`workflow run start-coding`](#workflow-run-start-coding), including `--profile <name>` as a read-only route/profile preview, `--steps-json <json>` as a read-only preview of the reconfigured per-step `route.steps` selection, and `--approval-boundary <boundary>` as the projected initial approval state.
A `--steps-json` selection is validated and projected into the previewed `route` exactly as `workflow run start-coding` would record it, so an operator can preview the default route, change it, and start the same frozen selection.

Behaviour:

- **No durable write**: the preview never opens the run for a durable write; no `workflow_runs`, `workflow_steps`, or `workflow_approvals` row is created.
  It is read-only apart from reading `<repo>/MOMENTUM.md` to report repo policy.
- **Frozen projection**: the preview is a pure projection of the version-pinned built-in `coding-workflow` definition plus the supplied inputs, so the durable run a later `workflow run start-coding` materializes from the same inputs matches the preview exactly.
  Because the built-in definition is immutable per version, the same plan can be reconstructed from the run's recorded `(definition key, version)` for approval and dispatch to reference later.
- **Stable output**: the envelope carries no wall-clock fields, so repeated previews of the same inputs are byte-stable and safe to show before approval.
- **Step detail**: each step carries its `kind`, executor family, `order`, `required` flag, and on-start `state` (`pending`, or `approved` for the steps an `--approval-boundary` covers).

Success JSON adds a `preview: true` marker, the run header (`runId`, `source`, `state`, `approvalBoundary`, `definitionKey`, `definitionVersion`, `repoPath`, `objective`, `issueScope`, `route`, `skillRevision`), a `steps` array, `counts.steps`, and `policy`:

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
  "route": {},
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

Text output is a human-readable preview of the same frozen plan and includes the command's no-write status, definition key/version, source, projected run state, approval boundary, profile, per-step route selections, repo, objective, policy path or `(none)`, data directory, and every step with order, step id, kind, executor family, required/optional marker, and projected state.
The per-step route block lists every configurable step (implementation, postflight, no-mistakes, merge-cleanup) with its harness/model/effort selection, showing `(default)` where the operator did not override the field, so an operator can audit the default selections and any `--steps-json` changes before approval:

```text
Coding workflow plan preview (not started): native-coding-1
Definition: coding-workflow v1
Source: momentum-native-coding
State on start: pending
Approval boundary: (none)
Profile: live-wrapper
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

### Text output (failure)

Structured refusals render the same message text as `workflow run start-coding`, with `command` set to `workflow run preview-coding` in JSON mode.

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
- **Terminal ledger wins**: `monitor.json` is advisory. Step and run state are derived from `ledger.jsonl` and `plan.json`; a stale monitor does not override completed ledger evidence. Its advisory snapshot is persisted on `workflow_runs` (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`) so status / handoff / monitor / logs drift views can compare durable substrate state against the last imported or operator-refreshed advisory snapshot. Successful `workflow run approve`, `workflow run update-step`, and `workflow run clear-recovery` mutations refresh the same columns from durable rows and clear the digest fields, so later views do not report drift against a stale pre-mutation monitor tick.
- **Lost managed-task markers**: `managed-*.pid`, `managed-*.log`, and `locks/` sibling entries are ignored without diagnostics. They do not force a failed step state.
- **Unknown siblings**: unrecognized files produce `evidence_format_unknown` diagnostics but do not drop the valid records around them. The generated `recovery.md` artifact is a known sibling and is ignored by import.
- **Malformed artifacts**: invalid `plan.json`, `ledger.jsonl` lines, or `approval-*.json` files produce `evidence_format_invalid` diagnostics. Valid siblings are still imported.
- **Durable approvals merge forward**: existing database approvals, the current `approval_boundary`, and imported `approval-*.json` artifacts are merged. The highest boundary is preserved; same-rank boundaries prefer the newer recorded approval. Stale same-boundary artifacts do not overwrite newer durable approval rows. On fresh imports and re-imports, pending steps covered by any preserved approval are persisted as `approved`, and a non-terminal pending run can be persisted as `approved`.
- **Manual-recovery auto-set**: after persisting the rows, import re-derives the run's monitor view. When it classifies a blocking recovery condition (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`), import sets the durable `needs_manual_recovery` flag and renders `<run-dir>/recovery.md`. The flag blocks `workflow run approve` and any `workflow run update-step` transition that would leave a blocking recovery condition in place; a resolving update-step can land so the operator can then clear the flag with `workflow run clear-recovery`. The auto-set only ever sets the flag: re-importing a run whose blocking condition is now resolved leaves any existing flag in place, so clearing stays explicit and operator-driven.

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
momentum workflow run clear-recovery <run-id> [--data-dir <path>] [--json]
```

Explicit, auditable clear for a run's durable manual-recovery flag. The flag blocks `workflow run approve` and non-resolving `workflow run update-step` transitions until an operator clears it here.

Required arguments:

- `<run-id>` — the flagged run to clear.

Behaviour:

- Re-derives the monitor view from the durable substrate inside a single immediate transaction and clears the flag only when no monitor-derived blocking recovery condition remains. The check and the clear are atomic: the monitor condition that is checked is the condition that is cleared.
- Refuses with `recovery_clear_refused` while a monitor-derived blocking recovery classification (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`) still applies; the refusal carries the `recoveryCode` and, when known, the `blockingStepId`, and the flag stays set.
- For live dispatch / finalization recovery, the durable flag and `run.manualRecoveryReason` / `run.manualRecoveryAt` fields are authoritative for non-monitor recovery reasons such as `head_mismatch`, `result_missing`, `repo_lock_lost`, or `auth_unavailable`. The `recovery.md` artifact is best-effort and may be absent after an artifact write failure; resolve the captured reason and any artifact context before clearing. The command still performs the atomic monitor recheck above, but it cannot independently prove that external live-recovery work was completed.
- For retryable live-wrapper bootstrap failures on dispatched `no-mistakes` or `merge-cleanup` steps (for example a stale wrapper/build path reported as `runtime_unavailable` before clean runner evidence exists), clearing recovery also prepares the same step for one safe scheduler retry. The JSON envelope includes `retryPrepared`, and text output prints `Retry prepared: <step> (<code>)`. The previous failed executor round remains durable; the retry creates a new round and does not rerun an already-terminal successful step.
- For scheduler-lane stale workflow lease recovery, stale `manual-recovery-required` leases are left outstanding as durable evidence with the `stale_workflow_lease_manual_recovery_required` reason prefix. Because the monitor reducer can still classify that lease as `manual_recovery_lease`, guarded clear refuses until the lease condition is resolved.
- Refuses with `not_flagged` when the run is not currently flagged, so a stale clear cannot mutate anything.
- Never auto-clears from elapsed time alone, never repairs the underlying run, and never issues an external write. The `recovery.md` artifact is intentionally left on disk as durable audit; remove it after capturing the context elsewhere.

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
Data dir: /path/to/data
```

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `not_flagged` | The run is not currently flagged for manual recovery; nothing to clear. |
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
      "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue."
    },
    "needsRecoveryArtifact": false,
    "recovery": null
  },
  "evidence": [],
  "gates": []
}
```

`gates` is the list of durable workflow / step / executor gates for the run, oldest first. Each gate includes: `gateId`, `workflowRunId`, `stepRunId`, `invocationId`, `roundId`, `targetScope` (`workflow` / `step` / `invocation` / `round`), `gateType`, `reason`, `evidence`, `allowedActions`, `recommendedAction`, `policyEnvelope`, `open` (true while unresolved), `resolvedAt`, `resolvedBy`, `resolutionMode`, `chosenAction`, and `resolution`.

`run.source` is one of `agent-workflow`, `workflow-definition`, or `momentum-native-coding`.
`run.route.profile` is present when a run was started with `--profile`; it records the operator-selected runtime/profile for status, handoff, monitor, and logs, but daemon execution still resolves the live-wrapper profile from `MOMENTUM_LIVE_WRAPPER_PROFILE`.
`run.route.steps` is present when a coding run was started with `--steps-json`; it records the per-step harness/model/effort selections the run was started with (only the steps and fields the operator overrode), so the selected route can be audited from durable state.

### State / next-action vocabulary

`run.state` and `steps[].state` use the canonical workflow vocabulary:

- Run states: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- Step states: `pending`, `approved`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, `canceled`.

`steps[].errorCode` is nullable. When present, it can be an executor result code
or a Momentum-owned live finalization code with the `live_finalize_*` prefix for
verification / git finalization failures reconciled after the executor result.

`monitor.nextAction.code` is one of:

- `no_action` — terminal run (succeeded / canceled); no follow-up needed.
- `advance_to_step` — an approved step is ready to dispatch.
- `await_approval` — a pending step needs approval before it can run.
- `resume_running` — a running step has fresh evidence; let it continue.
- `investigate_stale` — a running step is stale (no fresh lease, no recent checkpoint) or an orphan lease is holding a finalized run open.
- `clear_recovery` — the run is blocked (manual-recovery-required lease or blocked step); clear the recovery once the cause is resolved.
- `rerun_failed_step` — a required step failed; decide whether to retry or mark for manual recovery.

`monitor.recovery.code`, when present, is one of: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`.

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
    "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue."
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
        "nextAction": { "code": "resume_running" }
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
momentum workflow run monitor <run-id> [--data-dir <path>] [--json]
```

Read-only machine envelope for a monitor runner. Wraps the same durable detail loader as `workflow status <run-id>`, runs the monitor reducer, and adds a `disposition` decision view so a caller can act on one stable JSON shape per tick instead of parsing prose or scraping `.agent-workflows/<run-id>/`. It never writes SQLite or files, never schedules cron, and never delivers notifications.

Required arguments:

- `<run-id>` — the run to inspect.

### Disposition and report reason

`disposition` is the single field a monitor runner branches on:

- `wait` — nothing actionable; the run is progressing (`in_progress`) or has no actionable steps yet (`idle`). `reportable` is `false`.
- `report` — surface the run to the operator, but no recovery action is needed: a terminal outcome (`terminal_succeeded` / `terminal_canceled`), a step `awaiting_approval`, or `monitor_drift` (the run keeps progressing while the advisory snapshot is stale). `reportable` is `true`.
- `recover` — an operator must intervene: the run is `blocked`, carries a durable manual-recovery flag, or the monitor reducer classified a hard recovery condition. `reportReason` is `recovery_required` and `reportable` is `true`.

`reportReason` is one of `terminal_succeeded`, `terminal_canceled`, `recovery_required`, `monitor_drift`, `awaiting_approval`, `in_progress`, `idle`. `reportable` is always `disposition != "wait"`.

The hard recovery classifications (`recovery.code`) are the same monitor-derived taxonomy as `workflow status`: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`. A failed required step and a blocked run both resolve to `disposition: "recover"`; `monitor_drift_stale` on an otherwise-progressing run resolves to `disposition: "report"`.

Live dispatch / finalization recovery can also set the durable manual-recovery flag and drive `needsManualRecovery: true`, `disposition: "recover"`, and `reportReason: "recovery_required"` even when `recovery` is null, because `recovery` only carries monitor-derived classifications. Scheduler-lane stale `manual-recovery-required` workflow leases remain outstanding and can instead surface through `recovery.code = "manual_recovery_lease"`. The monitor envelope does not include a nested `run` object or the stored reason fields; consumers that need a non-monitor reason should call `workflow status` / `workflow handoff` or inspect the durable run record. `.agent-workflows/<run-id>/recovery.md` is best-effort operator guidance and may be absent if artifact rendering failed.

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
    "detail": "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue."
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
  }
}
```

`schemaVersion` is `1`. `nextAction`, `recovery`, `monitorDrift`, `leases`, `lastCheckpoint`, `evidence`, and `gates` reuse the same field shapes as `workflow status`. `stepState` is the active step's state (or `null` when there is no active step). `counts.gates` is the total gate count for the run; `counts.gatesOpen` is the count of unresolved gates.

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

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
Data dir: /path/to/data
```

A `Recovery: <code>` line is added when a recovery classification is present. Open gates print inline after the `Gates:` count; resolved gates are omitted from text output.

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run logs`

```text
momentum workflow run logs <run-id> [--data-dir <path>] [--json]
```

Read-back of one workflow run's durable logs and evidence, for operators inspecting what each step actually ran and produced. It is the workflow-first equivalent of goal-first `logs <goal-id>`: it wraps the same detail loader as `workflow status <run-id>` / `workflow handoff` (run, steps, approvals, leases, monitor, evidence, gates) and adds the per-round executor evidence that the detail loader does not carry — executor family / agent / model, log paths, summaries, key changes, changed files, verification status, commit SHA, recovery codes, and the child artifacts / checkpoints / findings / decisions emitted below each round. Read-only: no SQLite mutation, no file reads, no external writes.

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
      "remainingWork": [],
      "changedFiles": ["src/core/workflow/logs.ts"],
      "verificationStatus": "passed",
      "commitSha": "abc123",
      "recoveryCode": null,
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
Steps: 5
Approvals: 1
Leases: 1
Gates: 1 (open: 1)
- gate-nm-1 [step/operator_decision_required] OPEN allowed=fix,skip,approve_as_is recommended=fix
Executor rounds: 1
- cwfp-abc123::implementation::dispatch::round-1 [implementation/succeeded] complete
    summary: implemented the slice
    verification: passed commit: abc123
    logs: /path/to/data/runs/cwfp-abc123/round-1/agent.log
    changed files: src/core/workflow/logs.ts
    child evidence: 2
    artifacts: /path/to/data/runs/cwfp-abc123/round-1/verify.txt
    checkpoints: 0:verify
Evidence records: 0
Data dir: /path/to/data
```

Exit code 0 on success, 1 on failure, 2 on usage error.
