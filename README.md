# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is in progress. NGX-235 (scaffold) and NGX-236 (Goal spec parsing, data-dir resolution, SQLite init, artifact layout) are complete.

## Milestone 1 Scope

Milestone 1 proves a foreground one-Iteration loop:

```text
Markdown Goal spec -> foreground runner -> Momentum-owned verification -> commit/reset -> ledger/artifacts/status
```

The public CLI shape is:

```text
momentum goal start <goal.md> [--repo <path>] --foreground [--runner <profile>] [--data-dir <path>] [--json]
momentum status [goal-id] [--json]
momentum handoff <goal-id> [--json]
momentum doctor [--json]
```

`goal start` now parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events` tables), and creates the artifact layout. `status` and `handoff` return `not_implemented` until NGX-237..NGX-239 land.

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
