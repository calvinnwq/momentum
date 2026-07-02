# Daemon commands

This page is the canonical reference for the `daemon start`, `daemon stop`, and
`daemon status` commands and their JSON envelope shapes.

See also:

- [`docs/recovery.md`](recovery.md) for stale-lease auto-recovery and the
  manual-recovery artifact / `needs_manual_recovery` flag.
- [`docs/walkthrough.md`](walkthrough.md) for the end-to-end managed daemon
  drain narrative.
- [`docs/failure-reset.md`](failure-reset.md) for per-iteration outcome
  semantics that the managed loop composes via `runWorkerOnce`.

## `daemon start`

```text
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
```

Records a new orchestrator run in `daemon_runs` (state `running`) with `pid`,
`host`, `started_at`, and `heartbeat_at` populated from the invoking process.
Refuses to record a second concurrent run while one is still active (states
`starting`, `running`, `stop_requested`) and exits with
`code: "daemon_already_active"` (exit 1); the failure payload surfaces the
existing `runId`, `state`, `pid`, `host`, `startedAt`, `heartbeatAt`,
`heartbeatAgeMs`, and a `stale` flag (90s default heartbeat cutoff, or 930s
default while an active job is recorded) so operators can decide whether to
wait or recover the prior record. In managed-loop mode, a stale existing active
run is first passed through the startup-recovery primitives; if it is an idle
stale daemon row that can be auto-finalized safely, the new start proceeds and
the managed loop still reports its own pre-loop `loop.startupRecovery` summary.
After a terminal record (`stopped` / `canceled` / `error`), a fresh start is
allowed.

### Register-only mode

Without any loop-bound flag, `daemon start` returns immediately after
registering the run.

JSON envelope shape (register-only):

```json
{
  "ok": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "running",
  "startedAt": 1731500000000,
  "heartbeatAt": 1731500000000
}
```

### Managed loop mode

Passing `--max-loop-iterations` or `--max-idle-cycles` opts into the managed
loop: the process keeps running, drains queued `goal_iteration` jobs in-process
by composing `runWorkerOnce`, and runs one workflow scheduler tick per cycle to
recover stale workflow leases, claim one runnable approved workflow step, and
hand it to the production workflow-step dispatcher. The loop refreshes
`daemon_runs.heartbeat_at` / `active_job_id` / `reconcile_count` per cycle,
applies deterministic idle backoff between empty polls or unexecutable jobs,
and exits cleanly when one of the bounds is reached, `daemon stop` records a
stop request, `daemon stop --now` records an immediate-stop request, or a
terminal daemon-run state is observed. `--poll-interval-ms` only tunes the
bounded loop, defaults to 500ms, accepts non-negative integer millisecond values
(`0` allowed), and is rejected unless `--max-loop-iterations` or
`--max-idle-cycles` is also present.

The top-level `ok` field reports loop/process health; `workSucceeded` reports
whether claimed queued jobs succeeded, and managed-loop mode exits non-zero
when either `ok` or `workSucceeded` is false. The opt-in surfaces a `loop`
summary on the response with `exitReason` (`stop_requested` /
`stop_now_requested` / `run_terminated` / `run_missing` /
`max_loop_iterations` / `max_idle_cycles` / `internal_error`),
`terminalState`, `cancelOutcome`, `workSucceeded`, `iterations`, `jobsRun`,
`jobsFailed`, `jobsNotExecuted`, `idleCycles`, `workflowStepsDispatched`,
`lastWorkflowCode`, `lastObservedState`, `lastWorkerCode`, `startupRecovery`,
and `error`. All loop bounds must be
non-negative integers; a `--max-idle-cycles 0` or `--max-loop-iterations 0`
invocation exits before claiming any work, which is useful as a one-shot
readiness probe.

`workflowStepsDispatched` counts workflow scheduler ticks whose top-level code
is `dispatched`. `lastWorkflowCode` is the last scheduler-lane tick code
(`idle`, `claim_contended`, `dispatched`, or `null` when the lane never ran).
For a supported executor family, dispatch advances the step to `running` and
creates durable executor invocation / round scaffold rows with deterministic
dispatcher ids. The built-in `linear-refresh` step uses the `external-apply`
family: bounded `daemon start` matches exactly one pending Linear update intent
for the run's issue scope, reuses the same policy-gated external-apply write path
as `intent apply --external-apply`, including `status_update` payloads that move
the Linear issue to a configured `state` / `stateId`, writes
`external-apply.log` / `external-apply.json` evidence under the run directory,
and reconciles the step from that terminal evidence. Missing issue scope, no
matching pending intent, ambiguous intents, missing credentials, policy denial,
audit-incomplete, blocked, or other unsafe apply outcomes park the step for
manual recovery rather than fabricating success. Configured `subworkflow` steps are also handled by the
managed daemon: the parent run's `route.subworkflow.child` config selects the
child workflow definition, bounded lineage in `route.subworkflow.lineage` prevents
unsafe recursion, and the parent step mirrors terminal child-run evidence only
after the child reaches a terminal state. Missing child config, unsafe recursion,
unresolved child definitions, unsupported child attachments, invalid child state,
or ambiguous child terminals park the parent run for manual recovery. When
`MOMENTUM_LIVE_WRAPPER_PROFILE` points at a valid workflow step wrapper profile,
the managed loop also runs genuinely dispatched live-wrapper-owned step wrappers
in the same tick, records terminal executor evidence on the dispatch scaffold,
and lets the reconciliation seam finalize the step or park it for manual
recovery. When the variable is unset or blank, supported live-wrapper-owned steps
get the durable start scaffold only, while unconfigured wrapper kinds fail
honestly with `runtime_unavailable` if a profile is configured but omits that
step kind. If a claimed step cannot be resolved or uses an executor family the
daemon cannot dispatch yet, the dispatcher parks the run behind a
`manual_recovery_required` workflow gate instead of silently dropping the claim;
if the run row vanished before that gate can be written, it still releases the
dispatch lease so no claim is stranded. Register-only `daemon start` exits before
the managed loop and never runs the workflow scheduler lane, reads
`MOMENTUM_LIVE_WRAPPER_PROFILE`, attempts external apply, or dispatches
subworkflow children.

### Workflow live-wrapper profile

Managed-loop `daemon start` can execute workflow steps through local commands by
setting `MOMENTUM_LIVE_WRAPPER_PROFILE` to a readable JSON file:

```sh
MOMENTUM_LIVE_WRAPPER_PROFILE=/path/to/live-wrapper-profile.json \
  momentum daemon start --max-idle-cycles 1 --json
```

The profile has a non-empty `name` and a `wrappers` object keyed by
non-`external-apply` workflow step kind (`preflight`, `implementation`,
`postflight`, `no-mistakes`, or `merge-cleanup`). The built-in `linear-refresh`
step is handled by the daemon's policy-gated `external-apply` adapter, not a
live-wrapper command. Each wrapper requires:

- `command` — absolute executable path.
- `args` — array of strings or numbers; use `[]` when no arguments are needed.
- `cwd` — `repo` or `iteration`.
- `timeout_sec` — positive integer seconds.
- `env_allow` — environment variable names copied from the daemon process;
  include `PATH` explicitly if the wrapper or its child processes need it.
- `result_file` — relative path inside the workflow run directory where the
  wrapper writes the normalized runner result JSON.
- `probe` — optional `{ "command", "args", "timeout_sec" }` pre-flight check.

Example:

```json
{
  "name": "local-workflow",
  "wrappers": {
    "preflight": {
      "command": "/usr/local/bin/momentum-preflight",
      "args": [],
      "cwd": "repo",
      "timeout_sec": 900,
      "env_allow": ["PATH", "HOME"],
      "result_file": "result.json",
      "probe": {
        "command": "/usr/local/bin/momentum-preflight",
        "args": ["--version"],
        "timeout_sec": 30
      }
    }
  }
}
```

Momentum injects `MOMENTUM_RUN_ID`, `MOMENTUM_STEP_ID`,
`MOMENTUM_STEP_KIND`, `MOMENTUM_ATTEMPT`, `MOMENTUM_REPO_PATH`,
`MOMENTUM_ITERATION_DIR`, `MOMENTUM_PROMPT_PATH` when available, and
`MOMENTUM_RESULT_PATH` for every wrapper.
When a dispatched executor round has selected values, Momentum also injects
`MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT`; for native
coding runs those values come from persisted `route.steps` overrides when the
operator supplied `--steps-json`, otherwise they are omitted.
Provider-aware alias normalization happens before persistence, so a native coding step supplied as `harness=claude` with `model=sonnet` injects `MOMENTUM_MODEL=claude-sonnet-4-6`; a `codex` step supplied as `model=openai/gpt-5.5` injects `MOMENTUM_MODEL=gpt-5.5`; and an `opencode` step supplied as `model=glm-5.2` injects `MOMENTUM_MODEL=opencode-go/glm-5.2`.
Unknown or non-agent harness/model values still pass through unchanged after structural validation.
The wrapper must write the same
normalized runner result JSON documented in [`runners.md`](runners.md) at
`$MOMENTUM_RESULT_PATH`. A valid profile may configure only the
live-wrapper-owned step kinds it can run; a dispatched live-wrapper-owned kind
missing from the profile routes to manual recovery rather than fake success. An
unreadable, invalid JSON, or schema-invalid profile causes `daemon start`
managed-loop mode to fail before registering a daemon run with
`code: "daemon_live_wrapper_profile_invalid"`.

The `--profile <name>` option on `workflow run start` and `workflow run start-coding` only records the trimmed operator-selected profile name in the run's durable `route.profile`; a blank profile is refused before durable writes.
`workflow run preview-coding --profile <name>` reports that same projected `route.profile` in its frozen read-only plan but does not persist a run.
The `--steps-json <json>` option on `workflow run start-coding` records per-step harness/model/effort selections in `route.steps`, and `workflow run preview-coding --steps-json <json>` reports the same selection in its frozen read-only plan without persisting it.
Provider-aware model aliases are normalized in both paths when the step supplies a known mapped harness (`claude`, `codex`, or `opencode`), so the previewed value is the same command-ready value later stored and injected.
The command-line profile selector does not load or select the executable wrapper profile for the daemon.
Managed-loop execution still uses the JSON profile file pointed to by `MOMENTUM_LIVE_WRAPPER_PROFILE`.
`workflow run watch --once` resolves the same profile for its bounded run-scoped dispatcher tick, so an invalid profile can also fail that supervisor command with `daemon_live_wrapper_profile_invalid`.
The checked-in coding-workflow live-wrapper profile runs the shared coding
workflow wrapper for `preflight`, `implementation`, `postflight`,
`no-mistakes`, and `merge-cleanup`. That wrapper also requires
`MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG` to point at the run-local command
configuration. If the profile is present but that run-local config is missing,
unreadable, invalid, or lacks the current step, the wrapper exits as an operator
setup failure without writing normalized runner evidence; the daemon then parks
the dispatched step for recovery instead of finalizing it as an ordinary failed
workflow step.
The config file must use canonical snake_case keys.
The top-level object may only contain `steps`, and each step only accepts `command`, `args`, `cwd`, `timeout_sec`, `env_allow`, `result_file`, `success_summary`, `failure_summary`, `key_changes_made`, `key_learnings`, `remaining_work`, `commit`, and the merge-cleanup-only `merge_cleanup` target block.
Unknown top-level or step keys are setup failures before any child command is spawned.
`env_allow`, `timeout_sec`, and `result_file` use those names when present.
When present, `result_file` must be a safe relative path that resolves to the same file as the live-wrapper profile's `result_file` injected through `MOMENTUM_RESULT_PATH`.
`envAllow`, `timeoutSec`, or `resultFile` are rejected with setup guidance that
points to the config path and key to fix.
For example, this command block is valid:

```json
{
  "steps": {
    "implementation": {
      "command": "/usr/bin/env",
      "args": ["sh", "-c", "echo hello"],
      "cwd": "repo",
      "timeout_sec": 900,
      "env_allow": ["PATH", "HOME"],
      "result_file": "result.json"
    }
  }
}
```

For `merge-cleanup`, include the target block that the wrapper will verify against GitHub before it runs the merge command:

```json
{
  "steps": {
    "merge-cleanup": {
      "command": "/usr/bin/env",
      "args": ["sh", "-c", "merge-and-cleanup"],
      "cwd": "repo",
      "env_allow": ["PATH", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"],
      "merge_cleanup": {
        "pull_request_id": "123",
        "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
        "cleanup_branch": "feat/example"
      }
    }
  }
}
```

If the config has `envAllow`, `timeoutSec`, or `resultFile`, the wrapper returns a
setup failure in the form `Unknown key "..." in steps.<step>; replace with "..."
to use the required snake_case schema`, and no child process is spawned.
External-side-effect tail steps also run a local auth/capability preflight before
contacting their external tools. `merge-cleanup` is a tail-owned preflight ->
apply -> reconcile lifecycle: before spawning the merge command, the same worker
must prove explicit GitHub auth in the live-wrapper environment (`GH_TOKEN`,
`GITHUB_TOKEN`, or `GH_CONFIG_DIR`), a configured `merge_cleanup` block with
`pull_request_id`, `expected_head_sha`, and `cleanup_branch`, and live GitHub PR
state showing the target is open, non-draft, mergeable, and still at the expected
head. If GitHub shows the PR is already merged or the cleanup branch is already
deleted, the wrapper stops before mutation and routes operators to evidence-backed
reconciliation instead of a blind rerun. The built-in `linear-refresh` step
requires the usual policy-gated external-apply setup: a matching pending Linear
intent, `intent_apply_policy: external_apply_allowed`, and `LINEAR_API_KEY` in
the daemon/supervisor process environment. Missing auth or targets fail closed
with operator-actionable recovery evidence; Momentum does not store these
credentials.

On retried dispatch attempts, `MOMENTUM_ATTEMPT` is incremented and attempt
evidence is kept separate: attempt 1 uses the configured run directory paths,
while later attempts write result and executor-log files under `attempt-<n>/`.
If a wrapper command is `node` (or `/usr/bin/env node`) and the configured
script entrypoint itself is missing, the failure is classified as
`runtime_unavailable`; module failures from inside an existing wrapper script
remain ordinary command failures. For retryable `no-mistakes` and
`merge-cleanup` bootstrap failures, `workflow run clear-recovery` can prepare a
new scheduler attempt after the operator repairs the wrapper path.
The coding-workflow wrapper also treats known no-mistakes runner lifecycle
failures as recovery setup failures rather than ordinary failed runner evidence:
missing external branch-start state, cancelled no-mistakes runs before a
reliable result, and similarly concrete no-result runner lifecycle failures.
Those cases leave no normalized runner result, so the daemon parks the step for
operator repair and a guarded retry instead of terminalizing the workflow as if
verification itself failed.
When upstream no-mistakes reports `checks-passed`, or keeps reporting a running monitor state while the pull request evidence is clean and checks are green or explicitly absent, the wrapper writes successful runner evidence for the workflow step and leaves upstream no-mistakes to continue its own PR-lifecycle monitoring.
If the wrapper is interrupted before writing that evidence but the external no-mistakes run later proves success, `workflow run clear-recovery` can reconcile only that failed required `no-mistakes` step and re-derive the run for downstream work from either legacy `--evidence-pointer no-mistakes:<run-id>#checks-passed` proof or a readable structured deterministic evidence JSON file.
Structured no-mistakes recovery evidence must match the current workflow run id, issue scope, branch and head SHA, pull request identity and checks when present, no-mistakes run id, zero unresolved findings or decisions, and explicit review, test, docs, lint, format, push, PR, and CI phase statuses.
Current blocking outcomes, active findings, unresolved gates, dirty / draft pull requests, and failed, pending, skipped, running, or otherwise non-successful checks suppress that successful classification.

JSON envelope shape (managed loop):

```json
{
  "ok": true,
  "workSucceeded": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "stopped",
  "startedAt": 1731500000000,
  "workerId": "daemon-12345",
  "loop": {
    "exitReason": "max_idle_cycles",
    "terminalState": "stopped",
    "cancelOutcome": null,
    "workSucceeded": true,
    "iterations": 1,
    "jobsRun": 0,
    "jobsFailed": 0,
    "jobsNotExecuted": 1,
    "idleCycles": 1,
    "workflowStepsDispatched": 0,
    "lastWorkflowCode": null,
    "lastObservedState": "running",
    "lastWorkerCode": "not_executed",
    "startupRecovery": {
      "observedAt": 1731500000000,
      "graceMs": 5000,
      "recoveredRepoLockCount": 0,
      "recoveredClaimedJobCount": 0,
      "recoveredDaemonRunCount": 0,
      "skippedRepoLocks": [],
      "skippedClaimedJobs": [],
      "skippedDaemonRuns": []
    }
  }
}
```

## `daemon stop`

```text
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
```

Records a graceful stop request against the active daemon run
(`stop_requested_at` and `stop_reason`); the underlying state transitions to
`stop_requested` if it was not already. Default reason is `operator-requested`.
Idempotent: re-running on a record that is already `stop_requested` keeps the
original `stopRequestedAt`, refreshes `stopReason`, and sets
`alreadyStopRequested: true` unless a stop-now request has already been
recorded. Passing `--now` records an immediate stop-now request
(`stop_now_requested_at`) with default reason `operator-requested-immediate`;
repeat stop-now calls keep the original stop-now timestamp/reason and set
`alreadyStopNow: true`. After stop-now is recorded, later graceful
`daemon stop --reason ...` calls preserve the existing stop-now reason and
timestamp. Exits with `code: "no_active_daemon"` (exit 1) when no active record
exists; if the latest record is terminal, the failure payload includes a
`latest` summary so operators can see what was already stopped, canceled, or
failed.

The managed loop observes graceful and immediate stop requests between
cycles. Graceful stop exits as `stopped`; stop-now exits as `canceled`
and records `cancelOutcome` (`idle` if no job ran in that loop session,
`active_job_completed` if an in-flight iteration completed before cancellation
was observed). The command does not signal, kill, or otherwise terminate any
running runner, worker, or external process; process signaling, forced
termination, and mid-job cancellation are intentionally out of scope — stop
semantics are observation-only.

JSON envelope shape:

```json
{
  "ok": true,
  "command": "daemon stop",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "previousState": "running",
  "state": "stop_requested",
  "pid": 12345,
  "host": "hostname",
  "startedAt": 1731500000000,
  "stopRequestedAt": 1731500010000,
  "stopReason": "operator-requested",
  "alreadyStopRequested": false,
  "immediate": false,
  "alreadyStopNow": false,
  "stopNowRequestedAt": null,
  "heartbeatAt": 1731500000000,
  "heartbeatAgeMs": 10000,
  "stale": false
}
```

## `daemon status`

```text
momentum daemon status [--data-dir <path>] [--json]
```

Read-only inspector for `daemon_runs`. Selects the active record if one exists;
otherwise falls back to the most recently started run so operators can see
terminal/error state. When no daemon has ever started, exits 0 with
`hasRun: false` (text mode: `Daemon: never started`). The summary surfaces
`runId`, `pid`, `host`, `state`, `isActive`, `isTerminal`, `startedAt`,
`heartbeatAt`, `lastStateChangeAt`, `finishedAt`, `ageMs`, `heartbeatAgeMs`,
`stale`, `staleAfterMs` (90s default heartbeat cutoff, or
`activeJobStaleAfterMs` while an active job is recorded),
`activeJobStaleAfterMs` (930s default), `activeJob` (`{jobId, lockId}`),
`stopRequest` (`{requestedAt, reason}` or `null`), `stopNowRequest`
(`{requestedAt, reason}` or `null`), `cancelOutcome` (`{outcome}` or `null`),
`reconciliation` (`{count, lastReconciledAt}`), `error` (`{message, at}` or
`null`), and `updatedAt`. The envelope also lists `staleRepoLocks` (active repo
locks whose `lease_expires_at` is in the past) and `staleClaimedJobs`
(claimed/running `goal_iteration` jobs whose lease has lapsed), tolerating up
to `staleLeaseGraceMs` (5s default) of clock skew, plus `goalsNeedingRecovery`
listing goals whose durable `needs_manual_recovery` flag is set (each entry
includes `goalId`, `title`, `goalState`, `recoveryMdPath`, and
`recoveryMdExists`). `daemon status` itself is read-only — running it triggers
no recovery action. Automatic recovery for known-safe stale leases is performed
by the startup-recovery pass when a managed `daemon start` boots; rows
surfaced by `daemon status` are the current stale snapshot and may still need
manual recovery if a startup-recovery pass skips them.

JSON envelope shape (active run with no stop request or error):

```json
{
  "ok": true,
  "command": "daemon status",
  "dataDir": "/path/to/data-dir",
  "hasRun": true,
  "daemonRun": {
    "runId": "<uuid>",
    "pid": 12345,
    "host": "hostname",
    "state": "running",
    "isActive": true,
    "isTerminal": false,
    "startedAt": 1731500000000,
    "heartbeatAt": 1731500000000,
    "lastStateChangeAt": 1731500000000,
    "finishedAt": null,
    "ageMs": 0,
    "heartbeatAgeMs": 0,
    "stale": false,
    "staleAfterMs": 90000,
    "activeJobStaleAfterMs": 930000,
    "activeJob": { "jobId": null, "lockId": null },
    "stopRequest": null,
    "stopNowRequest": null,
    "cancelOutcome": null,
    "reconciliation": { "count": 0, "lastReconciledAt": null },
    "error": null,
    "updatedAt": 1731500000000
  },
  "staleAfterMs": 90000,
  "activeJobStaleAfterMs": 930000,
  "staleLeaseGraceMs": 5000,
  "staleRuns": [],
  "staleRepoLocks": [],
  "staleClaimedJobs": [],
  "goalsNeedingRecovery": [],
  "observedAt": 1731500000000
}
```
