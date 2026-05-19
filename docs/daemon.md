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
loop: the process keeps running and drains queued `goal_iteration` jobs
in-process by composing `runWorkerOnce`, refreshes `daemon_runs.heartbeat_at` /
`active_job_id` / `reconcile_count` per cycle, applies deterministic idle
backoff between empty polls or unexecutable jobs, and exits cleanly when one of
the bounds is reached, `daemon stop` records a stop request, `daemon stop
--now` records an immediate-stop request, or a terminal daemon-run state is
observed. `--poll-interval-ms` only tunes the bounded loop, defaults to 500ms,
accepts non-negative integer millisecond values (`0` allowed), and is rejected
unless `--max-loop-iterations` or `--max-idle-cycles` is also present.

The top-level `ok` field reports loop/process health; `workSucceeded` reports
whether claimed queued jobs succeeded, and managed-loop mode exits non-zero
when either `ok` or `workSucceeded` is false. The opt-in surfaces a `loop`
summary on the response with `exitReason` (`stop_requested` /
`stop_now_requested` / `run_terminated` / `run_missing` /
`max_loop_iterations` / `max_idle_cycles` / `internal_error`),
`terminalState`, `cancelOutcome`, `workSucceeded`, `iterations`, `jobsRun`,
`jobsFailed`, `jobsNotExecuted`, `idleCycles`, `lastObservedState`,
`lastWorkerCode`, `startupRecovery`, and `error`. All loop bounds must be
non-negative integers; a `--max-idle-cycles 0` or `--max-loop-iterations 0`
invocation exits before claiming any work, which is useful as a one-shot
readiness probe.

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
