# Momentum Documentation

Momentum is a TypeScript CLI for durable autonomous repo-work orchestration. This site is the user and operator front door — install, run, inspect, recover.

For a quick install / quick-start, see the [README](https://github.com/calvinnwq/momentum#readme).

## Start Here

- [Goal spec](goal-spec.md) — the Markdown goal file and supported frontmatter.
- [Data directory](data-directory.md) — where state and artifacts live, and how `--data-dir` / `MOMENTUM_HOME` / `~/.momentum` resolve.
- [End-to-end walkthrough](walkthrough.md) — a small disposable run exercising the queued, daemon, and foreground paths.

## Commands

- [Goal start](goal-start.md)
- [Status](status.md)
- [Logs](logs.md)
- [Handoff](handoff.md)
- [Worker run](worker-run.md)
- [Daemon](daemon.md)
- [Recovery](recovery.md)
- [Source commands](source-commands.md)
- [Evidence commands](evidence-commands.md)
- [Intent commands](intent-commands.md)
- [Workflow commands](workflow-commands.md)
- [OpenClaw supervise](openclaw-supervise.md)
- [Doctor](doctor.md)

## Concepts

- [Runner profiles and repo policy](runners.md)
- [Failure and reset semantics](failure-reset.md)
