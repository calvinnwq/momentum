# Agent skill

Momentum ships a public agent-operated skill in `skills/momentum/`.
The skill is for agents that need to resolve the Momentum CLI, inspect workflow runs, approve or decide gates, read evidence, and report durable next actions through public command envelopes.

Momentum is still pre-release and not published to npm.
Install the skill folder from a source checkout with any skill installer that accepts a repository path, or place `skills/momentum/` in the agent host's skills root.
The package payload allowlist includes `skills/momentum/`, so dry-run package checks prove the same skill will ship with package artifacts once publishing is enabled.

## Contents

The skill directory contains:

- `SKILL.md` - the concise agent-facing operating guide.
- `agents/openai.yaml` - OpenAI skill metadata.
- `scripts/resolve-momentum-cli.mjs` - the deterministic CLI resolver.
- `references/cli-discovery.md` - CLI resolution and preflight guidance.
- `references/workflow-runs.md` - preview, start, monitor, watch, events, and logs guidance.
- `references/gates-recovery.md` - approval, decision, recovery, and step repair guidance.
- `references/evidence-logs.md` - evidence, logs, and summary guidance.

Agents should read only the references needed for the current operation after loading `SKILL.md`.

## CLI resolution

Resolve the CLI before running Momentum commands:

```bash
node "$MOMENTUM_SKILL_DIR/scripts/resolve-momentum-cli.mjs" --json
```

Set `MOMENTUM_SKILL_DIR` to the directory containing `SKILL.md` when the agent host does not provide it.
Use `--cwd <dir>` when resolving from a repository other than the current shell directory.

The resolver tries, in order:

1. `MOMENTUM_CLI`
2. `momentum` on `PATH`
3. A built Momentum checkout found from `--cwd`, the current working directory, the installed skill location, or one of their ancestors

The checkout fallback requires `dist/index.js`.
If the resolver returns `dev_checkout_not_built`, run `pnpm build` from that checkout and retry.

Successful JSON returns an `argv` array.
Append Momentum arguments to that array instead of reconstructing the command from prose:

```bash
<resolved argv...> doctor --json
```

## Operating contract

Agents should prefer read-only JSON surfaces before mutating state:

```bash
<momentum> doctor --json
<momentum> workflow run preview-coding --run-id <id> --repo <path> --objective <text> --approval-boundary <boundary> --json
<momentum> workflow status <run-id> --json
<momentum> workflow handoff <run-id> --json
<momentum> workflow run monitor <run-id> --json
<momentum> workflow run events <run-id> --json
<momentum> workflow run logs <run-id> --json
```

Use mutation commands only when the operator intent is explicit and the corresponding JSON envelope names the next action:

```bash
<momentum> workflow run start-coding --run-id <id> --repo <path> --objective <text> --approval-boundary <boundary> --json
<momentum> workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> --actor <name> --json
<momentum> workflow run decide <gate-id> --action <action> --actor <name> --json
<momentum> workflow run clear-recovery <run-id> --evidence-pointer <ref> --json
```

Treat JSON envelopes, durable events, evidence rows, artifact pointers, and refusal codes as authoritative.
Do not infer workflow state from terminal scrollback or hidden host behavior.
