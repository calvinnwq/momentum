# Workflow Runs

Use workflow definitions and run state as the source of truth. The public CLI
surfaces emit JSON for agents and text for humans; agents should prefer JSON.

## Read-Only Discovery

```bash
<momentum> workflow status --json
<momentum> workflow status <run-id> --json
<momentum> workflow handoff <run-id> --json
<momentum> workflow run monitor <run-id> --json
<momentum> workflow run events <run-id> --json
<momentum> workflow run logs <run-id> --json
```

Use `workflow run list --json` when filtering by state, repo, issue scope, or
approval boundary.

## Preview

Use the read-only coding preview when the user wants the built-in coding
workflow plan:

```bash
<momentum> workflow run preview-coding \
  --run-id <id> \
  --repo <path> \
  --objective <text> \
  --approval-boundary <boundary> \
  --json
```

Add `--issue-scope`, `--profile`, `--implementation-engine`, `--steps-json`, or
`--definition-version` only when the user or existing run context supplies them.
Do not invent harness, model, effort, or route selections.

## Start

Start generic workflow definitions with:

```bash
<momentum> workflow run start \
  --run-id <id> \
  --repo <path> \
  --objective <text> \
  --definition <key> \
  --json
```

Start the built-in coding workflow only through:

```bash
<momentum> workflow run start-coding \
  --run-id <id> \
  --repo <path> \
  --objective <text> \
  --approval-boundary <boundary> \
  --json
```

If an approval boundary is configured, starting the run does not mean all steps
may execute. Follow the approval and gate envelopes.

## Watch And Events

For one-shot supervisor polling:

```bash
<momentum> workflow run watch <run-id> --once --json
```

For replay or reconnect:

```bash
<momentum> workflow run events <run-id> --since <cursor> --json
```

For streaming clients:

```bash
<momentum> workflow run watch <run-id> --stream --jsonl --since <cursor>
```

Use `emit`, `recommendedAction`, `humanAction`, `nextAction`, and `cursor`
fields directly. Do not infer state from elapsed time alone.
