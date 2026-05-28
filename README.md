# Momentum

![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-pre--release-orange)

Momentum is a TypeScript CLI for durable autonomous repo-work orchestration. It turns a Markdown Goal into verified iterations, local artifacts, handoff state, policy-gated tracker reconciliation, and an operator-mediated Linear apply path.

- **Durable by default** - state lives in SQLite plus per-goal artifact directories.
- **Runner-flexible** - use the fake runner for tests, trusted shell for local automation, or ACP-backed agents for real work.
- **Operator-first** - status, logs, handoff, doctor, daemon, and recovery commands are all inspectable.
- **External writes stay gated** - tracker updates are durable intents first; the optional Linear apply path runs only on an explicit operator command, is gated by `MOMENTUM.md` policy, goes through an adapter-mediated two-phase claim/audit/write/finalize lifecycle with a CAS race guard, defaults to comment-only, carries a stable idempotency marker, and reconciles the single touched issue afterwards.

Full documentation: <https://calvinnwq.github.io/momentum/>

## Install

Momentum is pre-release and not published to npm yet.

```sh
git clone git@github.com:calvinnwq/momentum.git
cd momentum
pnpm install
pnpm build
node dist/index.js doctor
```

## Quick Start

Create a goal:

```md
---
title: Example Goal
repo: /path/to/repo
runner: fake
max_iterations: 1
verification:
  - pnpm test
---

Make the requested change and keep the repo valid.
```

Run one foreground iteration:

```sh
node dist/index.js goal start ./goal.md --foreground --json
node dist/index.js status --json
node dist/index.js logs <goal-id> --json
node dist/index.js handoff <goal-id> --json
```

Queue work for the worker or daemon path:

```sh
node dist/index.js goal start ./goal.md --json
node dist/index.js worker run --json
node dist/index.js daemon start --max-idle-cycles 1 --json
```

## Commands

Commands:

```text
momentum goal start <goal.md> [options]
momentum status [goal-id] [--data-dir <path>] [--json]
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
momentum handoff <goal-id> [--data-dir <path>] [--json]
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
momentum daemon start|stop|status [options]
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
momentum source list|get|link|unlink|reconcile linear [options]
momentum project status [options]
momentum evidence ingest|list [options]
momentum intent list|get|apply|skip|cancel [options]
momentum workflow import --path <run-dir> [--data-dir <path>] [--json]
momentum workflow status [<run-id>] [options]
momentum workflow handoff <run-id> [--data-dir <path>] [--json]
momentum workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> [--actor <name>] [--artifact-path <path>] [--artifact-digest <sha256>] [--data-dir <path>] [--json]
momentum workflow run list [--state <state>] [--filter <active|blocked|completed|imported>] [--approval-boundary <boundary>] [--repo <path>] [--issue-scope <identifier>] [--updated-since <ms>] [--updated-until <ms>] [--limit <n>] [--data-dir <path>] [--json]
momentum workflow run update-step <run-id> --step <step-id> --state <approved|succeeded|skipped|failed|blocked|canceled> --reason <text> [--actor <name>] [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

See [docs](docs/index.md).

## Development

Requires Node.js 24 or newer.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
node dist/index.js --help
```

The test suite covers foreground goals, queued workers, daemon/recovery, runner profiles, source/evidence/intent commands, and a public-docs hygiene guard.

Releases are managed by Release Please on pushes to `main` or manual workflow dispatch. It opens or updates the release PR, keeps `CHANGELOG.md` current, and creates the GitHub release when that PR is merged; Momentum is still not published to npm.

## Project Status

Momentum is pre-release. The CLI surface above is stable; expect additional adapters and policy options over time.
