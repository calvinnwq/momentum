# Goal Spec

This page is the source of truth for the common goal frontmatter shape (the
fields shared across every runner profile), the strict-type validation rules,
the runner-name resolution at init time, the title-slug derivation, and the
runner precedence chain. Runner-specific frontmatter blocks (`trusted_shell` /
`acp`) plus the `MOMENTUM.md` repo-policy loader live in
[`docs/runners.md`](runners.md); the queued vs foreground JSON envelopes and
init-time validation taxonomy live in [`docs/goal-start.md`](goal-start.md).

## Frontmatter shape

Goal files are Markdown that begin with YAML frontmatter. `title` is required;
`repo`, `runner`, `branch`, `max_iterations`, `verification`,
`verification_timeout_sec`, `trusted_shell`, and `acp` are optional.

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

The body following the closing `---` is the free-form goal description that is
rendered into the iteration prompt.

## Built-in defaults

When an optional field is omitted, Momentum applies these built-in defaults:

- `runner: fake`
- `branch: momentum/<title-slug>` (derived from `title`)
- `max_iterations: 1`
- `verification: []`
- `verification_timeout_sec: 900`

If `branch` is omitted, `title` must contain at least one letter or digit so
Momentum can derive `momentum/<title-slug>`; a title made only of punctuation
or whitespace is rejected at init time.

## Strict-type validation rules

- `max_iterations` must be a positive integer.
- `verification_timeout_sec` must be a positive integer.
- `verification`, when present, must be an array of command strings.
- `runner` must be one of the built-in profile names (`fake`, `trusted-shell`,
  `acp`); unknown runner names are rejected at init time.
- `trusted_shell` is required for trusted-shell execution and `acp` is required
  for ACP execution; both blocks are ignored by the fake runner. Queued
  initialization can persist either goal before the worker validates missing or
  malformed runner config at execution time, so spec-level malformations
  surface at `worker run` time rather than at `goal start`.

See [`docs/runners.md`](runners.md) for the full `trusted_shell` / `acp`
sub-block keys, validation errors, and runtime semantics.

## Repo paths in the queued path

In the default queued path, relative `repo` values are resolved to absolute
paths before being persisted or emitted on the `goal start` envelope. This
means the queued worker sees a stable absolute repo path regardless of which
working directory `goal start` was invoked from.

## Runner precedence chain

Runner resolution at iteration time follows a deterministic precedence chain: `--runner` CLI flag > goal frontmatter `runner` > `MOMENTUM.md` `runner` > built-in default (`fake`).

1. `--runner` CLI flag
2. Goal frontmatter `runner` field
3. `MOMENTUM.md` `runner` field
4. Built-in default (`fake`)

The `--runner` CLI flag overrides the goal-spec `runner` field at every
invocation; the goal-spec `runner` field overrides any `MOMENTUM.md` default in
the target repo; and an absent `MOMENTUM.md` policy falls through to the
built-in `fake` default. See the
[Repo policy via MOMENTUM.md](runners.md#repo-policy-via-momentummd-ngx-284)
section for the full policy precedence including `verification`,
`verification_timeout_sec`, and `intent_apply_policy`.

## See also

- [`docs/runners.md`](runners.md) — runner profiles, runner-specific
  frontmatter (`trusted_shell`, `acp`), `RunnerResult` schema, runner failure
  code taxonomy, runtime `MOMENTUM.md` policy loader.
- [`docs/goal-start.md`](goal-start.md) — `goal start` queued / foreground JSON
  envelopes, init-time validation taxonomy (`parse_error`,
  `unsupported_runner`, `malformed_profile`), and the `MOMENTUM.md` `policy`
  block on the envelope.
- [`docs/worker-run.md`](worker-run.md) — queued iteration pipeline that
  validates runner-specific config at execution time.
- [`docs/failure-reset.md`](failure-reset.md) — per-iteration transaction
  model and runner failure-code taxonomy.
