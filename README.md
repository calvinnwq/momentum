# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is in progress. NGX-235 (scaffold), NGX-236 (Goal spec parsing, data-dir resolution, SQLite init, artifact layout), and NGX-237 (fake runner, foreground iteration transaction) are complete.

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

`goal start --foreground` parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events` tables), creates the artifact layout, and runs one foreground iteration: it inspects the target repo, captures the pre-iteration HEAD, creates or reuses a Momentum branch, renders the iteration prompt, invokes the configured runner (currently `fake` only), and transitions the goal to `awaiting_verification` on success or `failed` on a typed pipeline error. The iteration writes `prompt.md`, `runner.log`, and `result.json` under `iterations/1/`, but does not commit, stage, or reset the worktree. `status` and `handoff` still return `not_implemented` until later Milestone 1 issues land.

Goal files are Markdown that begin with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, and `verification_timeout_sec` are optional. Defaults are `runner: fake`, `branch: momentum/<title-slug>`, `max_iterations: 1`, `verification: []`, and `verification_timeout_sec: 900`. `max_iterations` and `verification_timeout_sec` must be positive integers. If `branch` is omitted, `title` must contain letters or numbers so Momentum can derive `momentum/<title-slug>`. `--repo` and `--runner` override frontmatter values.

```markdown
---
title: Example Goal
repo: /path/to/repo
runner: fake
branch: momentum/example-goal
max_iterations: 1
verification:
  - pnpm test
verification_timeout_sec: 900
---

Describe the goal and constraints here.
```

State is stored under `--data-dir <path>`, then `MOMENTUM_HOME`, then `~/.momentum`. `goal start` creates `<data-dir>/momentum.db` and goal artifacts under `<data-dir>/goals/<goal-id>/`, including `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and `iterations/1/{prompt.md,runner.log,verification.log,result.json}`.

Running `goal start` again with the same initialized goal spec in the same data directory resumes the existing goal instead of creating duplicate state. Text output begins with `Goal resumed`; JSON output sets `resumed: true`.

## Local Development

Requires Node.js 24 or newer.

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
