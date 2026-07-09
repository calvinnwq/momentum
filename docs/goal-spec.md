# Goal Spec (stored compatibility format)

The goal-first CLI lane that consumed this format is retired: no current command starts, queues, or executes goals from a `goal.md` file.
This page documents the format as durable compatibility data, because existing data directories still contain `goals/<goal-id>/goal.md` copies that recovery artifacts reference and that `recovery clear <goal-id>`, `daemon status`, and `doctor` still read goal rows for.

See [`docs/data-directory.md`](data-directory.md) for where stored goal artifacts live, [`docs/recovery.md`](recovery.md) for the `recovery clear` surface that operates over stored goal rows, and [`docs/runners.md`](runners.md) for the stored runner-profile blocks (`trusted_shell` / `acp`) and the still-live `MOMENTUM.md` repo-policy loader.

## Frontmatter shape

Stored goal files are Markdown that begin with YAML frontmatter.
`title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, `verification_timeout_sec`, `trusted_shell`, and `acp` are optional.

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

The body following the closing `---` is the free-form goal description that was rendered into iteration prompts by the retired lane.

## Defaults the retired lane applied

When an optional field was omitted, the retired lane applied these built-in defaults, so stored goal rows may carry them:

- `runner: fake`
- `branch: momentum/<title-slug>` (derived from `title`)
- `max_iterations: 1`
- `verification: []`
- `verification_timeout_sec: 900`

## Field types

Stored specs conform to these strict types:

- `max_iterations` — positive integer.
- `verification_timeout_sec` — positive integer.
- `verification` — array of command strings.
- `runner` — one of the built-in profile names (`fake`, `trusted-shell`, `acp`).
  These are the same kinds the frozen `doctor --json` `runners` block still reports; see [`docs/doctor.md`](doctor.md).
- `trusted_shell` / `acp` — runner-specific config blocks documented in [`docs/runners.md`](runners.md); recovery artifacts render their command / args / cwd / timeout / result-file metadata when present.

Relative `repo` values were resolved to absolute paths before being persisted, so stored goal rows carry stable absolute repo paths.

## See also

- [`docs/runners.md`](runners.md) — stored runner-profile blocks, the normalized `RunnerResult` schema (still consumed by workflow executors), and the `MOMENTUM.md` repo-policy loader.
- [`docs/failure-reset.md`](failure-reset.md) — the retired lane's per-iteration transaction model and the failure codes preserved in stored artifacts.
- [`docs/recovery.md`](recovery.md) — manual recovery artifacts, the durable `needs_manual_recovery` flag, and `recovery clear <goal-id>`.
