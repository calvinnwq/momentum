# Momentum

![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-pre--release-orange)

Momentum is a TypeScript CLI for durable autonomous repo-work orchestration. It turns an objective into a workflow run of verified steps with local artifacts, handoff state, policy-gated tracker reconciliation, and an operator-mediated Linear apply path.

- **Durable by default** - state lives in SQLite plus per-run artifact evidence.
- **Operator-first** - workflow status, logs, handoff, monitor, watch, doctor, daemon, and recovery commands are all inspectable.
- **External writes stay gated** - tracker updates are durable intents first; the optional Linear apply path runs only through `intent apply --external-apply` or the approved built-in `linear-refresh` workflow step, and `linear-refresh` proves the run issue scope, a matching source item, one pending Linear `status_update` intent or deterministic evidence to seed the expected `Done` intent, a valid one-of `state` / `stateId` payload, a credentialed process environment, repo policy, and a stable idempotency marker before applying or reconciling from already-successful audit evidence without another Linear mutation.

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

The public agent-operated skill ships in `skills/momentum/`. Install that
folder with any skill installer that accepts a repository path, or place it in
your agent's skills root. The skill resolves the CLI via `MOMENTUM_CLI`,
`momentum` on `PATH`, or a built Momentum checkout. See
[`docs/agent-skill.md`](docs/agent-skill.md) for the resolver and operating
contract.

## Quick Start

Start a workflow run and inspect it:

```sh
node dist/index.js workflow run start --run-id demo-1 --repo /path/to/repo --objective "Make the requested change" --json
node dist/index.js workflow status demo-1 --json
node dist/index.js workflow run logs demo-1 --json
node dist/index.js workflow handoff demo-1 --json
```

Let a bounded daemon cycle schedule runnable steps:

```sh
node dist/index.js daemon start --max-idle-cycles 1 --json
```

The full walkthrough, including approvals, monitoring, and recovery, lives in the docs site linked above.

## Commands

Commands:

```text
momentum daemon start|stop|status [options]
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
momentum source list|get|link|unlink|reconcile linear [options]
momentum project status [options]
momentum evidence ingest|list [options]
momentum intent list|get|apply|skip|cancel [options]
momentum workflow import --path <run-dir> [--data-dir <path>] [--json]
momentum workflow status [<run-id>] [options]
momentum workflow handoff <run-id> [--data-dir <path>] [--json]
momentum workflow run start|start-coding|preview-coding|approve|decide|list|update-step|clear-recovery|events|monitor|watch|logs [options]
momentum openclaw supervise <run-id> --once [--data-dir <path>] [--json]
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

See [docs](docs/index.html).

## Development

Requires Node.js 24 or newer.

```sh
pnpm install
pnpm test
pnpm test:integration
pnpm test:full
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
node dist/index.js --help
```

`pnpm test` runs the fast default lane for everyday development.
`pnpm test:integration` runs the heavier repo/git/process and smoke coverage, and `pnpm test:full` runs both lanes.
`pnpm lint` uses the TypeScript test-project check as the current no-extra-dependency lint lane, and `pnpm format:check` runs Git whitespace checks against `HEAD`.
The checked-in `.no-mistakes.yaml` points no-mistakes at the same `pnpm test && pnpm typecheck && pnpm build` and `pnpm lint && pnpm format:check` lanes.
The suite covers workflow runs and executors, daemon/recovery, source/evidence/intent commands, CLI import-boundary and renderer-output contracts, and a public-docs hygiene guard.

Releases are managed by Release Please on pushes to `main` or manual workflow dispatch. It opens or updates the release PR, keeps `CHANGELOG.md` current, and creates the GitHub release when that PR is merged; Momentum is still not published to npm.

## Project Status

Momentum is pre-release. The CLI surface above is stable; expect additional adapters and policy options over time.
