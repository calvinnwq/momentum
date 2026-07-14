# Gates And Recovery

Momentum gates are durable rows, not comments in logs. Resolve them only with
public mutation commands and only when the operator intent is clear.

## Approvals

When a preview, handoff, status, monitor, or watch envelope asks for approval,
use the exact boundary and phrase it reports:

```bash
<momentum> workflow run approve <run-id> \
  --approval-boundary <boundary> \
  --phrase <text> \
  --actor <name> \
  --json
```

Never broaden an approval boundary. If the user approves less than the envelope
requires, stop and report the mismatch.

## Operator Decisions

Open gates are resolved by gate id:

```bash
<momentum> workflow run decide <gate-id> \
  --action <action> \
  --actor <name> \
  --note <text> \
  --json
```

Use delegated mode only when the gate policy explicitly allows it:

```bash
<momentum> workflow run decide <gate-id> \
  --action <action> \
  --actor <name> \
  --mode delegated \
  --json
```

## Manual Recovery

Manual recovery is cleared only after the blocking condition has been reconciled
from durable evidence:

```bash
<momentum> workflow run clear-recovery <run-id> \
  --evidence-pointer <ref> \
  --json
```

For the older goal compatibility surface:

```bash
<momentum> recovery clear <goal-id> --reason <text> --json
```

If evidence is missing or ambiguous, report the recovery reason and the
inspection command instead of clearing recovery.
For `unsupported_platform`, move the workflow to Linux or macOS, confirm from
the executor log and worktree that no process ran and no edits were made, then
clear recovery on that supported host so Momentum can prepare the step's next
attempt.
For `tool_adapter_unavailable`, `delegate_handoff_failed`,
`delegate_handoff_recovery_required`, `external_state_unreadable`, or
`external_state_inconsistent`, inspect the step-scoped handoff receipt, executor
log, mirrored state, and external tool before clearing recovery.
Prove whether a correlated external run already launched, and never relaunch
from missing or ambiguous evidence.
Treat a local wrapper-finalization failure as local evidence only.
Read and reattach the correlated external run when it is still running or complete, and permit a fresh launch only after the same run is conclusively failed or cancelled.
Restore the adapter or reconcile the same external run until the supervisor can
read and classify it safely.
For `external_state_blocked`, clear recovery only after the external blocker is
resolved.

## Manual Step Repair

Use `workflow run update-step` only as an explicit operator repair path:

```bash
<momentum> workflow run update-step <run-id> \
  --step <step-id> \
  --state <approved|succeeded|skipped|failed|blocked|canceled> \
  --reason <text> \
  --json
```

Do not use step repair to hide failed verification, missing evidence, or an
unreconciled side effect.
