# Runner profiles and repo policy

This page is the source of truth for the runner-specific goal frontmatter and
the runtime `MOMENTUM.md` policy loader.

Built-in runner profile names: `fake`, `trusted-shell`, and `acp`. The `runner`
field on a goal spec must be one of these; unknown names are rejected at init
time. `trusted_shell` is required for trusted-shell execution and `acp` is
required for ACP execution; both blocks are ignored by the fake runner. The
`--runner` CLI flag overrides goal frontmatter, and built-in default resolution
precedence is `--runner` CLI flag > goal frontmatter `runner` > `MOMENTUM.md`
`runner` > `fake` (the built-in default).

## Trusted-shell runner example

The `trusted-shell` runner profile runs an operator-configured executable plus argv in the target repo by default, or in the iteration artifact directory when `trusted_shell.cwd: iteration` is set. Trusted-shell execution requires a `trusted_shell` block in the goal frontmatter; queued `goal start` stores the goal before validating that block, while foreground execution and workers validate it when the adapter runs. The config parser classifies missing/malformed config as `trusted_shell_config_missing` or `trusted_shell_config_invalid`, and the public adapter surface reports those validation failures as `invalid_input` (foreground and queued iteration surfaces map them to `runner_failed` with the parser code in the message).

> **Explicit trust posture.** `trusted-shell` is not sandboxed. The configured command runs with the full privileges of the user who invoked Momentum: no container, no VM, no seccomp, no privilege drop, and no input scrubbing. The operator is responsible for the command and any scripts it invokes. Container/VM/seccomp isolation is explicitly out of scope.

Minimal example:

```markdown
---
title: Trusted-shell example
repo: /path/to/repo
runner: trusted-shell
branch: momentum/trusted-shell-example
max_iterations: 1
verification:
  - pnpm test
trusted_shell:
  command: bash
  args:
    - -lc
    - ./scripts/momentum-iteration.sh
  cwd: repo
  timeout_sec: 900
  env_allow:
    - HOME
  env:
    EXTRA_FLAG: "1"
  result_file: result.json
---

Describe the goal and constraints here.
```

`trusted_shell` keys: `command` (required executable path/name, non-empty string), `args` (argv string/number array stringified before execution, default `[]`), `cwd` (`repo` default or `iteration`), `timeout_sec` (positive integer, default `900`), `env_allow` (string array of env-var names to forward from the parent process; `PATH` is always forwarded), `env` (explicit string/number/boolean key/value pairs merged after the allowlist, with numbers and booleans stringified), and `result_file` (relative file path beneath the iteration artifact directory, default `result.json`; absolute paths, `..` escapes, and paths resolving to the iteration directory itself are rejected). `env` keys must be valid environment variable names (`[A-Za-z_][A-Za-z0-9_]*`); Momentum injects the `MOMENTUM_*` variables after configured `env`, so those names are reserved for Momentum's runtime contract and cannot be overridden by goal frontmatter. Momentum calls `spawnSync(command, args)` without an implicit shell, so shell builtins, globbing, pipes, redirects, and variable expansion are not interpreted unless the configured executable is itself a shell such as `bash -lc`.

The runner injects the following environment variables for the command: `MOMENTUM_GOAL_ID`, `MOMENTUM_ITERATION`, `MOMENTUM_REPO_PATH`, `MOMENTUM_BASE_HEAD`, `MOMENTUM_BRANCH`, `MOMENTUM_PROMPT_PATH`, `MOMENTUM_ITERATION_DIR`, and `MOMENTUM_RESULT_PATH`. The command must write a JSON file at `$MOMENTUM_RESULT_PATH` matching the normalized `RunnerResult` schema:

```json
{
  "success": true,
  "summary": "one-line iteration summary",
  "key_changes_made": ["implemented the requested change"],
  "key_learnings": [],
  "remaining_work": [],
  "goal_complete": false,
  "commit": {
    "type": "feat",
    "scope": "optional-scope",
    "subject": "short imperative subject without trailing period",
    "body": "optional longer message body",
    "breaking": false
  }
}
```

`success`, `summary`, `key_changes_made`, `goal_complete`, `commit`, `commit.type`, and `commit.subject` are required. `key_learnings` and `remaining_work` default to empty arrays when omitted. The `commit.type` must be one of `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`, or `chore`; `commit.scope`, `commit.body`, and `commit.breaking` are optional and default to no scope, an empty body, and `false`. Momentum formats the verified git commit message from this commit intent as `type(scope)!: subject` plus the optional body, and surfaces that message as `commitMessage` / `commit_message`. The iteration's `runner.log` records trusted-shell metadata before execution (`command` with argv, `cwd`, `timeout_sec`, and `result_path`), then captures stdout and stderr after the command exits; avoid putting secrets in argv because they are written to local artifacts.

Native workflow `goal-loop` runners consume the same runner-authored `RunnerResult` document before finalization and classification.
For native goal-loop rounds, Momentum renders a deterministic per-round prompt that includes the workflow objective, source context, round identity, repo/base-head context, verification and acceptance requirements, prior round summaries/learnings/remaining work, and the exact result path.
Source context and prior-round evidence are quoted as untrusted JSON context, not as runner instructions.
Momentum clears any stale file at that result path before the runner starts, so the runner must write a fresh result for the current round.
The runner writes only the normalized `RunnerResult` JSON at that configured result path, and Momentum routes missing, malformed, or schema-invalid result files through explicit recovery evidence instead of treating them as progress.
After finalization, `workflow run logs` reads the native round evidence projected from `executor_invocations`, `executor_rounds`, and child evidence rows instead of treating the runner-authored JSON, terminal scrollback, `.gnhf/runs`, or a runner-local directory as authoritative state.
Future workflow status, handoff, monitor, and GUI surfaces must use that same projection once they are wired to executor round evidence.

Failure modes return stable diagnostic codes through the `RunnerAdapter` boundary: `invalid_input` (missing/malformed config), `runner_threw` (runner log could not be opened), `spawn_failed` (spawn errors such as a missing binary), `command_failed` (non-zero exit), `command_timed_out` (exceeded `timeout_sec`), `result_missing` (no result file written), `result_invalid` (unreadable, malformed, or non-conforming result JSON), and `output_overflow` (stdout/stderr exceeded the 256 MiB capture limit). The foreground and queued iteration surfaces preserve `spawn_failed`, `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, and `output_overflow` verbatim as `iteration.code` / job error codes so operator surfaces keep command / result taxonomy; only `invalid_input`, `unsupported_runner`, and `runner_threw` collapse to the generic `runner_failed`. The adapter diagnostic is always included in the error text and logs. Post-execution adapter failures reset the worktree to base HEAD only when the runner has not moved HEAD; if HEAD changed, Momentum returns `runner_changed_head` and leaves the repo for manual recovery rather than dropping runner-created commits.

## ACP runner example

The `acp` runner profile is a smoke harness around the `RunnerAdapter` boundary for ACP/acpx-style external agent runtimes. Like `trusted-shell` it spawns an operator-configured executable plus argv via `spawnSync` with no implicit shell, applies `env_allow` filtering with implicit `PATH` preservation, supports `cwd: repo` (default) or `cwd: iteration`, injects the same `MOMENTUM_*` environment variables, and parses a normalized `RunnerResult` from `acp.result_file` (default `result.json`). It adds two pre-flight detections trusted-shell does not need: an absolute `acp.command` whose binary is missing on disk short-circuits with `runtime_unavailable` before any spawn attempt, and an optional `acp.probe` block runs first so missing auth or runtime is observed before the main command. Missing runtime, missing probe binary, probe non-zero exit, probe timeout, and main spawn ENOENT all return `runtime_unavailable`; non-ENOENT spawn errors return `startup_failed`; these stay distinct from `command_failed` (the runtime ran and exited non-zero) and from verification failures, so missing prerequisites never corrupt Goal state.

> **Explicit trust posture.** The `acp` runtime command runs with the full privileges of the user who invoked Momentum: no container, no VM, no seccomp, no privilege drop, and no input scrubbing. Live ACP/acpx smoke is opt-in — keep it disabled in CI unless the runtime and its auth prerequisites are explicitly provisioned. The operator is responsible for the configured runtime and any scripts it invokes.

Minimal example:

```markdown
---
title: ACP smoke example
repo: /path/to/repo
runner: acp
branch: momentum/acp-smoke
max_iterations: 1
verification:
  - pnpm test
acp:
  command: /usr/local/bin/acpx
  args:
    - run
    - --prompt-file
    - $MOMENTUM_PROMPT_PATH
  cwd: repo
  timeout_sec: 900
  env_allow:
    - HOME
    - ACP_AUTH_TOKEN
  env:
    ACP_LOG_LEVEL: info
  result_file: result.json
  probe:
    command: /usr/local/bin/acpx
    args:
      - --version
    timeout_sec: 30
---

Describe the goal and constraints here.
```

`acp` keys mirror `trusted_shell`: `command` (required executable path/name, non-empty string), `args` (argv string/number array stringified before execution, default `[]`), `cwd` (`repo` default or `iteration`), `timeout_sec` (positive integer, default `900`), `env_allow` (string array of env-var names to forward from the parent process; `PATH` is always forwarded), `env` (explicit string/number/boolean key/value pairs merged after the allowlist, with numbers and booleans stringified), and `result_file` (relative file path beneath the iteration artifact directory, default `result.json`; absolute paths and `..` escapes are rejected). `env` keys must be valid environment variable names (`[A-Za-z_][A-Za-z0-9_]*`); Momentum injects the `MOMENTUM_*` variables after configured `env`, so those names are reserved for Momentum's runtime contract and cannot be overridden by goal frontmatter. The optional `acp.probe` sub-block adds a pre-flight runtime/auth check with its own `command`, `args` (default `[]`), and `timeout_sec` (positive integer, default `30`); the probe runs before the main command and a probe failure (missing binary, non-zero exit, timeout) is mapped to `runtime_unavailable` so the main command is never spawned.

The runner injects the same environment variables as `trusted-shell`: `MOMENTUM_GOAL_ID`, `MOMENTUM_ITERATION`, `MOMENTUM_REPO_PATH`, `MOMENTUM_BASE_HEAD`, `MOMENTUM_BRANCH`, `MOMENTUM_PROMPT_PATH`, `MOMENTUM_ITERATION_DIR`, and `MOMENTUM_RESULT_PATH`. The configured runtime must write a JSON file at `$MOMENTUM_RESULT_PATH` matching the same normalized `RunnerResult` schema documented above for trusted-shell.

The iteration's `runner.log` records `[acp] start`, an optional `[acp] probe …` block when `acp.probe` is configured, then `[acp] command` with argv, `cwd`, `timeout_sec`, and `result_path` before the main spawn, captures stdout and stderr after the command exits, and ends with `[acp] runner_success` / `[acp] goal_complete` / `[acp] done`. Avoid putting secrets in argv because they are written to local artifacts.

Failure modes return stable diagnostic codes through the `RunnerAdapter` boundary. In addition to the codes shared with `trusted-shell` (`invalid_input`, `runner_threw`, `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, `output_overflow`), the `acp` adapter adds `runtime_unavailable` (missing runtime binary, missing probe binary, probe non-zero exit, probe timeout, or main spawn ENOENT) and `startup_failed` (non-ENOENT spawn errors on the main command or the probe) so missing prerequisites stay distinct from runtime errors and from verification failures. The foreground and queued iteration surfaces preserve `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, `output_overflow`, `runtime_unavailable`, and `startup_failed` verbatim as `iteration.code` / job error codes; only `invalid_input`, `unsupported_runner`, and `runner_threw` collapse to the generic `runner_failed`. As with `trusted-shell`, post-execution adapter failures reset the worktree to base HEAD only when the runner has not moved HEAD; HEAD movement returns `runner_changed_head` / `head_mismatch` and leaves the repo for manual recovery.

## Repo policy via MOMENTUM.md

A repo can ship a `MOMENTUM.md` file at its root to provide repo-owned defaults that sit between goal frontmatter and Momentum's built-in defaults. Discovery is **repo-root only**: only `<repo>/MOMENTUM.md` is read, and no parent walk-up is performed. If the file is absent, the loader returns `present: false` and Momentum behaves exactly as before — existing goals without a policy file are unaffected.

The file is YAML frontmatter (optional) followed by a free-form markdown body that is surfaced to the iteration prompt as **context-only policy notes**. Policy notes never override Momentum's safety contracts (no commits, no pushes, no staged changes).

```markdown
---
runner: trusted-shell
verification:
  - pnpm test
  - pnpm typecheck
verification_timeout_sec: 1800
---

Repo policy notes:
- Prefer focused unit tests over snapshot churn.
- Land verification gates with each change.
```

Supported frontmatter keys (all optional, strict types when present):

- `runner` — default runner profile name for this repo. Must be a built-in (`fake`, `trusted-shell`, `acp`).
- `verification` — array of non-empty verification command strings.
- `verification_timeout_sec` — positive integer.
- `intent_apply_policy` - policy for how update intents are applied. Valid values: `create_intents_only` (default, Momentum records intents but does not perform external writes) or `external_apply_allowed` (`intent apply --external-apply`, and the bounded workflow daemon's `linear-refresh` / `external-apply` step after it proves the run issue scope, a matching source item, one pending Linear `status_update` intent or deterministic seed evidence for the expected `Done` intent, a valid one-of `state` / `stateId` payload, `LINEAR_API_KEY`, and a resolved target, may perform a policy-gated external tracker write through the adapter's external update client; the write is two-phase audit-before-write and idempotent under replay, and matching successful audit evidence can be reconciled without another mutation). Without `--external-apply`, `intent apply` always records a manual operator mark regardless of this setting.

A `MOMENTUM.md` with no frontmatter at all is also valid: the entire body becomes policy notes and no config defaults are set.
Parse / schema errors map to stable codes (`policy_path_invalid`, `policy_file_unreadable`, `policy_parse_invalid`, `policy_schema_invalid`) and are surfaced through `goal start --json`, `status --json` / text, `handoff` JSON / markdown, and `doctor --json` / text.
`workflow run start --json`, `workflow run start-coding --json`, and `workflow run preview-coding --json` also load the repo policy and refuse a malformed policy as `policy_invalid`.
The preview door is read-only and never writes a run; the start doors refuse before writing when policy is malformed.

**Precedence (highest first):**

1. CLI overrides (`--runner`, etc.)
2. Goal frontmatter (`runner`, `verification`, `verification_timeout_sec`)
3. `MOMENTUM.md` frontmatter
4. Built-in defaults (`runner: fake`, `verification: []`, `verification_timeout_sec: 900`, `intent_apply_policy: create_intents_only`)

Intent apply policy has a narrower precedence chain: `MOMENTUM.md` > `builtin_default`. Goal frontmatter and CLI overrides do not set `intent_apply_policy`.

`doctor` accepts an optional `--repo <path>` flag (`momentum doctor [--repo <path>] [--data-dir <path>] [--json]`) so operators can inspect a repo's policy file in isolation; without `--repo`, the doctor `policy` block reports `repoConfigured: false`. `status` and `handoff` re-read the policy file from each goal's `repo` path at observation time rather than persisting it to the database, so editing `MOMENTUM.md` between iterations is immediately reflected without a schema migration.
