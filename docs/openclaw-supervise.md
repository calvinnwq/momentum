# OpenClaw supervise

`openclaw supervise` is the cron-safe bridge between Momentum's native workflow watcher and an OpenClaw delivery loop.
It runs one bounded watch tick for a single workflow run, persists the OpenClaw supervisor's local suppression state, and returns a sanitized envelope with a delivery intent plus any local auto-action audit summary that a host can surface safely.

```text
momentum openclaw supervise <run-id> --once [--data-dir <path>] [--json]
```

The command currently requires `--once`. It refuses stream/jsonl mode because
the OpenClaw host is expected to call this command repeatedly from its own loop
or scheduler. State lives under the resolved Momentum data directory, using the
same precedence as other commands: `--data-dir`, then `MOMENTUM_HOME`, then
`~/.momentum`.

Required arguments:

- `<run-id>` - the Momentum-native workflow run to supervise.

Options:

- `--once` - run one bounded scheduler-safe tick. Required.
- `--data-dir <path>` - select the Momentum data directory.
- `--json` - write the success envelope to stdout as JSON and structured failures to stderr.

Environment:

- `MOMENTUM_OPENCLAW_AUTO_ACTIONS=0` disables OpenClaw's local auto-actions while leaving the upstream watch recommendation visible.
  The values `false`, `off`, `no`, and `disabled` also disable them.
  Other values, or an unset variable, keep the local auto-actions enabled.
  A disabled gate leaves benign `watch_recheck` and `monitor_recheck` recommendations unaudited.
  Other supported auto-actions, including `stale_lease_auto_release` and `release_monitor`, fail closed with `autoAction.result: "skipped"` and human escalation.
  For an enabled terminal monitor, that fail-closed release path clears the `remove_monitor` cleanup hint so an operator can review the terminal monitor release.
  A monitor that was already disabled remains disabled and can still repeat the cleanup hint after the escalation audit is saved.

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

The persisted state file is
`<data-dir>/openclaw-supervisor/<encoded-run-id>.json`, where the file name is
`encodeURIComponent(runId)`. It is local delivery state only; the workflow run
state, step state, gates, approvals, and events remain in `momentum.db`.

If the workflow watcher has already returned an emitted advisory but the local
OpenClaw supervisor state cannot be saved, the command still returns the
advisory for delivery. The JSON `state.persisted` and
`debug.statePersistence` fields report that the local state write failed without
including filesystem paths.

When a terminal watch envelope asks for `cleanup: "release"` and its
`recommendedActionPolicy` explicitly allows `release_monitor`, the OpenClaw
envelope reports `monitorEnabled: false` and `cleanupAction: "remove_monitor"`.
Hosts should treat that as the signal to stop polling this run and remove their
external monitor registration.
After that disabled state is saved, later `openclaw supervise` calls do not run
`workflow run watch`; they repeat the local cleanup signal so a host can finish
removing its registration without re-enabling the monitor.

OpenClaw local auto-actions are limited to the explicitly supported `auto_allowed` policy actions: `watch_recheck`, `monitor_recheck`, `stale_lease_auto_release`, and `release_monitor`.
Each attempted auto-action appends an initial audit record under `<data-dir>/openclaw-supervisor/<encoded-run-id>.auto-actions.jsonl` before the local state change is applied.
The record includes the action type, policy action, reason, before and after digest/state snapshots, timestamp, result, and any failure or human escalation.
Successful actions append a second required audit record after state persistence with `statePersistence: "saved"` or `"failed"`.
`release_monitor` is repeat-bounded to three saved successful audit attempts for the same digest; failed or skipped persistence records do not reset that saved count.
A fourth attempt for an enabled monitor keeps polling, clears cleanup, and escalates for human review.
An already disabled monitor stays disabled at the repeat bound, does not append another auto-action audit record, and keeps repeating the cleanup hint so the host can remove its registration.
The action fails closed when prior audit evidence is unreadable, invalid, digest-mismatched, or belongs to another run, when an `auto_allowed` policy is unsupported, or when required audit evidence cannot be written at either point.
Fail-closed output uses a human-required policy, preserves a sanitized delivery text of `Human review required for <run-id>: OpenClaw supervisor auto-action <action> did not complete.`, clears monitor-removal cleanup unless the monitor was already disabled and the escalation audit was saved, and exits nonzero when required audit evidence could not be written.

Momentum does not post Discord webhooks, wake OpenClaw lanes, remove external
monitors, or tail verbose logs into chat. It only decides whether a short
delivery intent exists and formats the data a host needs to perform its own
delivery. To disable the integration, make the host ignore `deliveryIntent` (or
stop calling `openclaw supervise`) while leaving `workflow run watch` and the
supervisor CLI available for manual inspection.

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
  "recommendedActionPolicy": {
    "action": "approval_decision",
    "authority": "human_required",
    "risk": "medium",
    "evidenceRequired": ["open approval gate", "operator approval phrase"],
    "rollback": "Clear or supersede the approval through the normal workflow gate path.",
    "rationale": "Approval changes the authorized execution envelope and must remain operator-gated."
  },
  "nextPollSeconds": 30,
  "humanAction": {
    "code": "approve",
    "command": "momentum workflow run approve run-1 --approval-boundary through-implementation --phrase \"approve plan run-1 through-implementation\"",
    "detail": null
  },
  "stuckRisk": "low",
  "inspectionCommand": null,
  "deliveryIntent": {
    "kind": "approval",
    "severity": "action_required",
    "text": "Approval needed for run-1. Run: momentum workflow run approve run-1 --approval-boundary through-implementation --phrase \"approve plan run-1 through-implementation\"",
    "action": {
      "command": "momentum workflow run approve run-1 --approval-boundary through-implementation --phrase \"approve plan run-1 through-implementation\"",
      "evidence": null
    },
    "wake": {
      "target": "openclaw",
      "intent": "wake",
      "reason": "approval"
    },
    "message": {
      "platform": "discord",
      "format": "plain_text",
      "allowedMentions": "none",
      "maxLength": 1800
    },
    "dedupeKey": "openclaw-delivery:run-1:quiet_heartbeat:sha256:...",
    "reminderKey": "openclaw-reminder:run-1:approval",
    "cleanup": null,
    "failure": {
      "retryable": true,
      "logLevel": "warn",
      "stateImpact": "none",
      "retry": "repeat_openclaw_supervise"
    }
  },
  "autoAction": null,
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
    "statePersistence": "saved",
    "autoActionResult": null,
    "autoActionEscalation": null
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
`deliveryIntent` is `null` for suppressed ticks. When present, it contains a
single Discord-safe message, optional operator command and evidence, OpenClaw
wake/message metadata, dedupe and reminder keys, terminal cleanup hints, and
retry/logging metadata for hosts whose delivery attempt fails. Commands and
delivery text are sanitized before rendering: any resolved `--data-dir` value is
replaced with `<data-dir>`, and `text` is capped at `message.maxLength` with a
truncation suffix. Delivery failure handling belongs to the host: Momentum state
is already represented by the supervisor state fields and must not be rewound by
a webhook or wake failure.
`state.persisted: false` and `debug.statePersistence: "failed"` mean the host
should deliver the advisory but treat the supervisor state as not durably saved.
`debug.autoActionResult` and `debug.autoActionEscalation` mirror the
`autoAction` result and escalation for compact host logs.

### Field meanings

| Field | Type | Meaning |
|------|------|---------|
| `ok` | boolean | Always `true` for a rendered tick; failures use the error envelope below. |
| `command` | string | Always `"openclaw supervise"`. |
| `mode` | string | Always `"once"`. |
| `runId` | string | The supervised workflow run id. |
| `emit` | boolean | OpenClaw delivery decision. `false` means the host should stay silent. |
| `eventType` | enum \| null | `progress`, `approval`, `recovery`, `stuck-risk`, `terminal`, or `null` when suppressed. |
| `reason` | string | Upstream watch reason for this tick. |
| `digest` | string | Upstream watch progress digest used for duplicate suppression. |
| `cursor` | string \| null | Upstream watch cursor, when present. |
| `recommendedAction` | string | Upstream watch recommendation (`poll`, `approve`, `operator_decision`, `recover`, or `release`). |
| `recommendedActionPolicy` | object | Upstream action-authority metadata: `action`, `authority`, `risk`, `evidenceRequired`, `rollback`, and `rationale`. Hosts should fail closed by treating absent or invalid policy as human-required for non-wait actions. |
| `nextPollSeconds` | number | Suggested delay before the host calls `openclaw supervise` again. |
| `humanAction` | object \| null | Operator command from the watch envelope, or `null` when no operator command is required. |
| `stuckRisk` | string | Upstream watch stuck-risk value. |
| `inspectionCommand` | string \| null | Sanitized stuck-risk inspection command with `<data-dir>` replacing the resolved path. |
| `deliveryIntent` | object \| null | Short host-delivery contract for Discord/OpenClaw. `null` means stay silent. |
| `autoAction` | object \| null | Local auto-action audit summary when an `auto_allowed` action was attempted, skipped, failed, or escalated. `null` means no audit-recorded local auto-action ran, such as human-required recommendations or disabled benign recheck pass-through. |
| `monitorEnabled` | boolean | `false` after terminal cleanup disables further polling for this run. |
| `cleanupAction` | enum \| null | `remove_monitor` when the host should remove its external monitor registration. This is emitted after terminal cleanup disables the monitor, and may repeat for an already disabled monitor even when a later local auto-action escalation requires human review. |
| `state` | object | Next local OpenClaw supervisor state, plus `persisted` to report whether it was saved. |
| `debug` | object | Watch/suppression diagnostics for host logs. |

### Delivery intent fields

| Field | Type | Meaning |
|------|------|---------|
| `kind` | enum | Delivery class: `progress`, `approval`, `recovery`, `stuck-risk`, or `terminal`. Mirrors `eventType` when present. |
| `severity` | enum | Host display severity: `info`, `action_required`, `warning`, `success`, or `error`. |
| `text` | string | Single plain-text Discord-safe message, sanitized and capped to `message.maxLength`. |
| `action` | object \| null | Operator or inspection command to surface with the message. `evidence` carries recovery detail or stuck-risk evidence when available. |
| `wake` | object | OpenClaw routing hint. Approval, recovery, and stuck-risk intents use `intent: "wake"`; progress and terminal intents use `intent: "message"`. |
| `message` | object | Delivery formatting contract: Discord plain text, no allowed mentions, and the maximum text length. |
| `dedupeKey` | string | Host idempotency key for a delivery attempt. Repeated due reminders include the latest supervisor timestamp so intentional repeats can be delivered. |
| `reminderKey` | string \| null | Stable reminder group for approval, recovery, and stuck-risk reminders; otherwise `null`. |
| `cleanup` | object \| null | Terminal cleanup hint. `remove_monitor` means the host should stop polling this run and remove the external monitor registration; it is present after terminal cleanup disables the monitor and may repeat while an already disabled monitor is escalated for human review. |
| `failure` | object | Host retry policy for failed webhook or wake attempts. Failures are retryable, should be logged at warn, have no Momentum state impact, and can be retried by repeating `openclaw supervise`. |

When `autoAction.escalation` is `human_required`, the delivery text is replaced with a sanitized human-review message and the delivery dedupe key includes the auto-action type, result, and escalation.
When fail-closed handling suppresses monitor removal, both `deliveryIntent.cleanup` and `cleanupAction` are `null` and `monitorEnabled` remains `true`.

### Auto-action fields

| Field | Type | Meaning |
|------|------|---------|
| `actionType` | string | Local action considered by the supervisor. |
| `policyAction` | string | Upstream `recommendedActionPolicy.action` that authorized or requested the action. |
| `reason` | string | Upstream watch reason for the tick. |
| `beforeDigest` | string \| null | Prior local supervisor digest, when a prior state file existed. |
| `afterDigest` | string | Digest from the current tick. |
| `beforeState` | object \| null | Prior local supervisor state snapshot. |
| `afterState` | object | Local supervisor state snapshot the action leaves for persistence. |
| `timestamp` | number | Epoch-millisecond time the auto-action record was produced. |
| `result` | enum | `success`, `skipped`, or `failed`. |
| `statePersistence` | enum \| null | `saved` or `failed` for rendered successful auto-actions. Audit records use `pending` before state persistence is attempted. Skipped and failed actions use `null`. |
| `error` | string \| null | Sanitized failure or skip reason, if any. |
| `escalation` | enum \| null | `human_required` when the supervisor failed closed and the host/operator should review the action. |

`beforeState` and `afterState` use the same supervisor state shape as `state`.
The cursor, digest, reason, and last-human-update fields in those snapshots may be `null`.

## Text output

Without `--json`, successful output is written to stdout in a stable summary:

```text
OpenClaw supervise: run-1
Mode: once
Emit: true
Event type: approval
Reason: quiet_heartbeat
Recommended action: approve
Next poll seconds: 30
Monitor enabled: true
Cleanup action: (none)
Digest: sha256:...
Suppressed reason: (none)
State persistence: saved
Human action: momentum workflow run approve run-1 --approval-boundary through-implementation --phrase "approve plan run-1 through-implementation"
Delivery intent: approval (action_required)
Delivery text: Approval needed for run-1. Run: momentum workflow run approve run-1 --approval-boundary through-implementation --phrase "approve plan run-1 through-implementation"
Delivery dedupe key: openclaw-delivery:run-1:quiet_heartbeat:sha256:...
Delivery retry: repeat_openclaw_supervise
Delivery action: momentum workflow run approve run-1 --approval-boundary through-implementation --phrase "approve plan run-1 through-implementation"
```

When `autoAction` is present, text output also includes `Auto action: <actionType> (<result>)` and `Auto action audit: <escalation|recorded>`.

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
`data_dir_failed`, `openclaw_auto_action_audit_failed`, and the refusal codes
propagated from `workflow run watch --once --json`, such as unsupported source,
missing run, or data-directory failures. Auto-action audit failures include the
sanitized tick details in the JSON failure envelope so a host can surface the
human-required escalation without reading local files. Text mode writes the same
operational summary or failure message without exposing local data-directory
paths.

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `once_required` | `--once` was omitted, or stream/jsonl mode was requested. |
| `data_dir_failed` | Data directory resolution failed. |
| `watch_spawn_failed` | The wrapped `workflow run watch --once --json` process could not be started. |
| `watch_parse_failed` | The wrapped watch command returned invalid or unexpected JSON. |
| `watch_run_mismatch` | The wrapped watch command returned a different run id. |
| `watch_failed` | The wrapped watch command exited unsuccessfully without a structured refusal code. |
| `openclaw_auto_action_audit_failed` | Required auto-action audit evidence could not be written, so the local action failed closed and was escalated for human review. |
| `openclaw_supervisor_failed` | Local OpenClaw supervisor state processing failed. |
| `run_not_found` | Propagated from `workflow run watch`; the run does not exist. |
| `watch_unsupported_source` | Propagated from `workflow run watch`; the run source is not supported for one-shot watch supervision. |

Other structured refusal codes from `workflow run watch --once --json` may pass
through unchanged.

Exit code 0 on success, 1 on structured refusal, 2 on usage error.
