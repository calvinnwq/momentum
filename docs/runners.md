# Runner profiles and repo policy

The goal-first execution lane that ran these runner profiles is retired: no current command executes a `fake`, `trusted-shell`, or `acp` runner against a goal.
This page remains for three reasons:

- **Stored compatibility data.** Existing goal rows and `goals/<goal-id>/goal.md` copies still name runner profiles, and goal-scoped `recovery.md` artifacts render the stored runner / command / args / cwd / timeout / result-file metadata.
- **The frozen `doctor` envelope.** `doctor --json` still reports the built-in runner-profile kinds in its `runners` block (see [`docs/doctor.md`](doctor.md)); that envelope is wire-stable even though nothing executes the profiles anymore.
- **Still-live contracts.** The normalized `RunnerResult` schema below is consumed by the workflow runtime's live wrappers and native goal-loop rounds, and the `MOMENTUM.md` repo-policy loader is used by `doctor --repo`, the `workflow run start` / `start-coding` / `preview-coding` doors, and live-wrapper dispatch finalization.

Built-in runner profile names: `fake`, `trusted-shell`, and `acp`.
The `runner` field on a stored goal spec is one of these.
In the retired lane, resolution precedence was `--runner` CLI flag > goal frontmatter `runner` > `MOMENTUM.md` `runner` > `fake` (the built-in default), so stored goal rows may reflect any of those sources.

## Stored `trusted_shell` block

Stored goal specs that named `runner: trusted-shell` carry a `trusted_shell` frontmatter block:

```markdown
---
title: Trusted-shell example
repo: /path/to/repo
runner: trusted-shell
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
```

`trusted_shell` keys: `command` (executable path/name), `args` (argv array, default `[]`), `cwd` (`repo` or `iteration`), `timeout_sec` (positive integer, default `900`), `env_allow` (env-var names forwarded from the parent process), `env` (explicit key/value pairs), and `result_file` (relative path beneath the iteration artifact directory, default `result.json`).
Recovery artifacts for flagged stored goals render this metadata in their Runner/profile section so operators can understand what the retired lane was configured to run.

## Stored `acp` block

Stored goal specs that named `runner: acp` carry an `acp` frontmatter block with the same keys as `trusted_shell` plus an optional `probe` sub-block (`command`, `args`, `timeout_sec`, default `30`) that the retired lane used as a pre-flight runtime/auth check.

Stored iteration artifacts and job error rows from either profile may carry the retired lane's stable diagnostic codes — `invalid_input`, `runner_threw`, `spawn_failed`, `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, `output_overflow`, `runtime_unavailable`, `startup_failed`, `runner_changed_head`, and `head_mismatch` — which recovery artifacts and stored events preserve verbatim as durable evidence (see [`docs/failure-reset.md`](failure-reset.md)).

## Normalized `RunnerResult` schema

This schema is still live: workflow live wrappers (see [`docs/daemon.md`](daemon.md)) and native workflow `goal-loop` executors write and consume the same normalized result document, and stored iteration `result.json` files from the retired lane use it too.
For live-wrapper-owned dispatched steps, the document is not terminal evidence by itself: after a successful wrapper process, Momentum parses the result, runs repo-safety finalization, verifies, commits or resets, and only then terminalizes the executor round for reconciliation.
The result JSON is written at `$MOMENTUM_RESULT_PATH`:

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

`success`, `summary`, `key_changes_made`, `goal_complete`, `commit`, `commit.type`, and `commit.subject` are required.
`key_learnings` and `remaining_work` default to empty arrays when omitted.
The `commit.type` must be one of `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`, or `chore`; `commit.scope`, `commit.body`, and `commit.breaking` are optional and default to no scope, an empty body, and `false`.
Momentum formats the verified git commit message from this commit intent as `type(scope)!: subject` plus the optional body.

Native workflow `goal-loop` executors consume the runner-authored `RunnerResult` document before finalization and classification.
For native goal-loop rounds, Momentum renders a deterministic per-round prompt that includes the workflow objective, source context, round identity, repo/base-head context, verification and acceptance requirements, prior round summaries/learnings/remaining work, and the exact result path.
Source context and prior-round evidence are quoted as untrusted JSON context, not as runner instructions.
Momentum clears any stale file at that result path before the executor starts, so the executor must write a fresh result for the current round.
The executor writes only the normalized `RunnerResult` JSON at that configured result path, and Momentum routes missing, malformed, or schema-invalid result files through explicit recovery evidence instead of treating them as progress.
After finalization, `workflow run logs` reads the native round evidence projected from `executor_invocations`, `executor_rounds`, and child evidence rows instead of treating the runner-authored JSON, terminal scrollback, `.gnhf/runs`, or a runner-local directory as authoritative state.
Native goal-loop finalization writes a digested `commit_or_reset_evidence` sidecar next to the verification log when the verification log path is usable, so operators can inspect commit/reset outcome metadata without relying on terminal output.
Future workflow status, handoff, monitor, and GUI surfaces must use that same projection once they are wired to executor round evidence.

## Repo policy via MOMENTUM.md

A repo can ship a `MOMENTUM.md` file at its root to provide repo-owned defaults. Discovery is **repo-root only**: only `<repo>/MOMENTUM.md` is read, and no parent walk-up is performed. If the file is absent, the loader returns `present: false`.

The file is YAML frontmatter (optional) followed by a free-form markdown body that is surfaced as **context-only policy notes**. Policy notes never override Momentum's safety contracts (no commits, no pushes, no staged changes).

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

- `runner` — a built-in runner profile name (`fake`, `trusted-shell`, `acp`). This was the repo-level default for the retired goal lane; it is still parsed, validated, and reported by `doctor --repo`.
- `verification` — array of non-empty verification command strings.
  Native workflow live-wrapper finalization uses these commands as the repo-policy fallback when the run has no linked goal verification.
- `verification_timeout_sec` — positive integer.
  Native workflow live-wrapper finalization uses this timeout with the same fallback precedence.
- `intent_apply_policy` - policy for how update intents are applied. Valid values: `create_intents_only` (default, Momentum records intents but does not perform external writes) or `external_apply_allowed` (`intent apply --external-apply`, and the bounded workflow daemon's `linear-refresh` / `external-apply` step after it proves the run issue scope, a matching source item, one pending Linear `status_update` intent or deterministic seed evidence for the expected `Done` intent, a valid one-of `state` / `stateId` payload, `LINEAR_API_KEY`, and a resolved target, may perform a policy-gated external tracker write through the adapter's external update client; the write is two-phase audit-before-write and idempotent under replay, and matching successful audit evidence can be reconciled without another mutation). Without `--external-apply`, `intent apply` always records a manual operator mark regardless of this setting.

A `MOMENTUM.md` with no frontmatter at all is also valid: the entire body becomes policy notes and no config defaults are set.
Parse / schema errors map to stable codes (`policy_path_invalid`, `policy_file_unreadable`, `policy_parse_invalid`, `policy_schema_invalid`) and are surfaced through `doctor --json` / text.
`workflow run start --json`, `workflow run start-coding --json`, and `workflow run preview-coding --json` also load the repo policy and refuse a malformed policy as `policy_invalid`.
The preview door is read-only and never writes a run; the start doors refuse before writing when policy is malformed.

Intent apply policy has a narrow precedence chain: `MOMENTUM.md` > `builtin_default`.
In the retired goal lane, the `runner` / `verification` / `verification_timeout_sec` keys sat between goal frontmatter and built-in defaults.
Today `runner` is inspection-only repo metadata surfaced by `doctor --repo`, while `verification` and `verification_timeout_sec` also provide the live-wrapper dispatch finalization fallback after any linked goal verification.

`doctor` accepts an optional `--repo <path>` flag (`momentum doctor [--repo <path>] [--data-dir <path>] [--json]`) so operators can inspect a repo's policy file in isolation; without `--repo`, the doctor `policy` block reports `repoConfigured: false`.
