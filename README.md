# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

This repo is currently implementing Linear issue `NGX-235`: the Milestone 1 scaffold and CLI test harness.

## Milestone 1 Scope

Milestone 1 proves a foreground one-Iteration loop:

```text
Markdown Goal spec -> foreground runner -> Momentum-owned verification -> commit/reset -> ledger/artifacts/status
```

The public CLI shape reserved by this scaffold is:

```text
momentum goal start <goal.md> --repo <path> --foreground [--runner <profile>] [--json]
momentum status [goal-id] [--json]
momentum handoff <goal-id> [--json]
momentum doctor [--json]
```

`doctor`, `help`, and `version` work now. `goal start`, `status`, and `handoff` intentionally return stable `not_implemented` responses until `NGX-236..NGX-239` fill in parser, data, fake runner, transaction, and handoff behavior.

## Local Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
node dist/index.js --help
node dist/index.js doctor
```

## Current Exclusions

Milestone 1 does not include queue/worker behavior, daemon management, stop/cancel, stale lease recovery, GitHub/Linear integration, worktrees, remote fetch/pull/push/rebase, or a dashboard.
