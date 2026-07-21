# Evidence And Logs

Momentum evidence is the durable record. Prefer evidence pointers, logs, events,
verification results, and recovery codes over terminal output or process state.

## Inspect A Run

```bash
<momentum> workflow run logs <run-id> --json
<momentum> workflow status <run-id> --json
<momentum> workflow handoff <run-id> --json
```

Use logs for executor attempts, rounds, artifacts, checkpoints, findings, and
decisions. Use status or handoff for the current next action.

## Inspect Events

```bash
<momentum> workflow run events <run-id> --json
<momentum> workflow run events <run-id> --since <cursor> --json
```

Persist the returned response cursor when polling repeatedly. Event ids are for
dedupe; cursors are for replay.

## Ingest Or List Evidence

```bash
<momentum> evidence ingest --path <file-or-dir> --json
<momentum> evidence list --goal <id> --json
<momentum> evidence list --source-item <id> --json
```

When adding evidence to support recovery or an operator decision, keep the
pointer stable and include it in the mutation command when the CLI supports it.

## Summaries

Summaries should include:

- run id or goal id
- terminal or current state
- recommended next action
- verification status when present
- commit SHA when present
- relevant evidence or artifact pointers
- unresolved recovery reason or gate id when present

Do not summarize a run as successful unless durable state and evidence say it is
terminally successful.
