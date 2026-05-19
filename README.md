# Momentum

![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-pre--release-orange)

Momentum is a TypeScript CLI for durable autonomous repo-work orchestration. It turns a Markdown Goal into verified iterations, local artifacts, handoff state, and policy-gated tracker reconciliation.

- **Durable by default** - state lives in SQLite plus per-goal artifact directories.
- **Runner-flexible** - use the fake runner for tests, trusted shell for local automation, or ACP-backed agents for real work.
- **Operator-first** - status, logs, handoff, doctor, daemon, and recovery commands are all inspectable.
- **External writes stay gated** - tracker updates are intent-based first; M6 adds policy-gated apply instead of silent mutation.

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

Common commands:

```text
momentum goal start <goal.md> [--foreground] [--runner <profile>] [--from-source <id>] [--data-dir <path>] [--json]
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
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

See the [docs site](docs/index.md) for command envelopes, runner policy, data layout, milestone contracts, and recovery details.

## Development

Requires Node.js 24 or newer.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
node dist/index.js --help
```

The test suite includes CLI smoke coverage across foreground goals, queued workers, daemon/recovery paths, runner profiles, source/evidence/intent commands, and M6 contract docs.

## Project Status

Momentum is pre-release. Milestones 1-5 are complete; Milestone 6 is active and focused on policy-gated external apply.

Key references:

- [Documentation home](docs/index.md)
- [Roadmap](docs/roadmap.md)
- [M6 external apply plan](docs/milestones/m6-external-apply.md)
- [Intent apply contract](docs/contracts/intent-apply.md)
