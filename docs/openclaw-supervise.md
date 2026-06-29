# OpenClaw supervise

`openclaw supervise` is the cron-safe bridge between Momentum's native workflow
watcher and an OpenClaw delivery loop. It runs one bounded watch tick for a
single workflow run, persists the OpenClaw supervisor's local suppression state,
and returns a sanitized envelope that a host can decide whether to deliver to
chat.

```text
momentum openclaw supervise <run-id> --once [--data-dir <path>] [--json]
```

The command currently requires `--once`. It refuses stream/jsonl mode because
the OpenClaw host is expected to call this command repeatedly from its own loop
or scheduler. State lives under the resolved Momentum data directory, using the
same precedence as other commands: `--data-dir`, then `MOMENTUM_HOME`, then
`~/.momentum`.

## Behaviour

Each invocation wraps `workflow run watch <run-id> --once --json`. The underlying
watch tick may safely dispatch at most one approved Momentum-native coding step,
or recheck one active running step that the scheduler can revisit. OpenClaw then
classifies the returned watch envelope into a smaller operator event type:
`progress`, `approval`, `recovery`, `stuck-risk`, `terminal`, or `null`.

The command is idempotent for repeated scheduler calls. It stores the last
cursor, digest, reason, and delivery timestamp per run, so unchanged progress
ticks and idle-only quiet heartbeats remain silent. When the workflow watcher
sets `emit: true` for a human-worthy advisory, OpenClaw preserves that decision:
due approval or recovery reminders are delivered even when the digest has not
changed, and repeated `stuck_risk` advisories are delivered when the watcher
says they are due. Suppressed ticks still update local state so a later change or
due advisory can be evaluated correctly.

If the workflow watcher has already returned an emitted advisory but the local
OpenClaw supervisor state cannot be saved, the command still returns the
advisory for delivery. The JSON `state.persisted` and
`debug.statePersistence` fields report that the local state write failed without
including filesystem paths.

When a terminal watch envelope asks for `cleanup: "release"`, the OpenClaw
envelope reports `monitorEnabled: false` and `cleanupAction: "remove_monitor"`.
Hosts should treat that as the signal to stop polling this run and remove their
external monitor registration.

## JSON envelope

With `--json`, successful output is written to stdout:

```json
{
  "ok": true,
  "command": "openclaw supervise",
  "mode": "once",
  "runId": "run-1",
  "emit": true,
  "eventType": "approval",
  "reason": "quiet_heartbeat",
  "digest": "sha256:...",
  "cursor": "wfcur1...",
  "recommendedAction": "approve",
  "nextPollSeconds": 30,
  "humanAction": {
    "code": "approve",
    "command": "momentum workflow run approve run-1 --boundary next",
    "detail": null
  },
  "stuckRisk": "low",
  "inspectionCommand": null,
  "monitorEnabled": true,
  "cleanupAction": null,
  "state": {
    "version": 1,
    "lastCursor": "wfcur1...",
    "lastDigest": "sha256:...",
    "lastReason": "quiet_heartbeat",
    "lastHumanUpdateAt": 1731500000000,
    "disabled": false,
    "updatedAt": 1731500000000,
    "persisted": true
  },
  "debug": {
    "watchEmit": true,
    "suppressedReason": null,
    "stateChanged": true,
    "statePersistence": "saved"
  }
}
```

`emit` is the delivery decision for the OpenClaw host. `eventType` is `null`
when the tick should stay silent. `debug.watchEmit` preserves the upstream watch
decision, while `debug.suppressedReason` explains why OpenClaw suppressed a
watch-emitted or watch-silent tick (`watch_silent`, `heartbeat`,
`duplicate_digest`, `not_human_worthy`, or `monitor_disabled`).
`inspectionCommand`, when present for a stuck-risk advisory, uses a
`<data-dir>` placeholder instead of exposing the resolved local data directory.
`state.persisted: false` and `debug.statePersistence: "failed"` mean the host
should deliver the advisory but treat the supervisor state as not durably saved.

## Failures and refusals

Failures are sanitized and do not include resolved data-directory paths. In
JSON mode they are written to stderr:

```json
{
  "ok": false,
  "command": "openclaw supervise",
  "code": "once_required",
  "message": "openclaw supervise currently requires cron-safe --once mode.",
  "runId": "run-1"
}
```

Common refusal codes include `run_id_required`, `once_required`,
`data_dir_failed`, and the refusal codes propagated from
`workflow run watch --once --json`, such as unsupported source, missing run, or
data-directory failures. Text mode writes the same operational summary or
failure message without exposing local data-directory paths.
