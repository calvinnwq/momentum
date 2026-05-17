# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is complete. Milestone 2 (Queue and Worker Model) is complete, with NGX-235, NGX-236, NGX-237, NGX-238, NGX-239, NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, and NGX-250 implemented and verified. NGX-249 is M2-05 completion reducer and idempotent chaining (`reduceGoalIteration` classifies terminal `goal_iteration` jobs as `continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`; updates `goals.state` / `current_iteration` / `completion_reason`; enqueues next iterations with stable idempotency keys; emits `goal.reduced` + `goal.completed` / `goal.failed`; surfaces reducer state, next job, and next-action via `status`/`handoff`; and runs after each completed queued job). NGX-250 pins the Milestone 2 CLI contract around queued status/handoff fields, local log inspection, queued smoke coverage, and user-facing docs. Milestone 2 also includes queued-path execution without a long-lived daemon, stable single-shot worker behavior, and explicit artifact pointers on job success/failure.

Milestone 3 (Operational Safety) is complete. NGX-272 landed as the first M3 slice (M3-01 orchestrator state model and daemon CLI contract): durable `daemon_runs` schema, `daemon start` / `daemon stop` / `daemon status` subcommands, and a daemon-readiness block on `doctor --json`. NGX-273 landed as the second M3 slice (M3-02 managed daemon loop for queued jobs): a `runDaemonLoop` primitive that composes `runWorkerOnce` with deterministic idle backoff, heartbeat / active-job / reconciliation updates per cycle, and `stop_requested` shutdown handling; opt-in bounded-loop flags (`--max-loop-iterations`, `--max-idle-cycles`, `--poll-interval-ms`) wire that loop into `momentum daemon start` so a queued goal can be drained without manually invoking `worker run` repeatedly. NGX-274 landed as the third M3 slice (M3-03 graceful daemon stop visibility): `status --json` / text and `handoff` JSON / markdown surface the daemon stop-request state (`daemon.runId`, `daemon.state`, `daemon.isActive`, `daemon.isTerminal`, `daemon.stopRequest`) so operators can see why work is not draining without running `daemon status` separately; a focused daemon-loop test covers stop-before-next-claim with a reducer-enqueued follow-up iteration. NGX-275 landed as the fourth M3 slice (M3-04 immediate daemon stop-now cancellation): `daemon stop --now` records an immediate-stop request, the managed loop exits as `canceled` between cycles, and `status`, `handoff`, and `daemon status` surface stop-now and cancel-outcome details. NGX-276 landed as the fifth M3 slice (M3-05 stale-lease detection and safe auto-recovery): stale repo locks, claimed/running `goal_iteration` jobs, and idle daemon records are detected deterministically and surfaced through `daemon status`, `doctor`, `worker run`, `status --json`, and `handoff`; the managed-loop `daemon start` runs a one-shot `runStartupRecovery` pre-loop pass that auto-releases repo locks whose owning job is already terminal, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale daemon rows, while routing dirty/active states (`job_running`, `daemon_active`, `lock_active`, `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_state_changed`, `active_job_present`, `active_lock_present`, `self`, `run_state_changed`) through a stable skip taxonomy so operators can drive manual recovery without re-classifying. NGX-277 landed as the sixth M3 slice (M3-06 manual recovery artifacts, durable goal-level `needs_manual_recovery` flag, blocked-claim guard, `recovery clear` CLI, and cross-CLI visibility): manual-recovery skip reasons write goal-scoped `recovery.md` evidence and set a durable flag that blocks future claims until an operator acknowledges it with `momentum recovery clear`. NGX-278 landed as the seventh M3 slice (M3-07 milestone closeout): built-CLI smoke coverage for the daemon drain, graceful stop, stop-now/cancel, safe stale recovery, and manual recovery artifact visibility paths; doctor / README / AGENTS marker alignment naming M3 complete; and an explicit list of cross-milestone deferrals so the operational-safety surface is pinned. Future milestones own cooperative mid-job shutdown semantics (signal-based termination, mid-job cancellation handshake), background detachment / supervision (forking, daemonization, restart-on-crash), per-source-item worktrees / parallel same-repo Goals, remote git operations (`fetch` / `pull` / `push` / `rebase`), PR/GitHub/Linear/external-tracker automation, inbound webhooks, a dashboard or UI surface, and strong sandboxing (container / VM / seccomp); these are out of scope until a future milestone explicitly justifies them. Real runner profiles and the runtime `MOMENTUM.md` policy loader shipped in Milestone 4 (NGX-279..NGX-286); see the Milestone 4 Roadmap below. Milestone 5 (Source Adapters and Evidence Sync) is now the active milestone — NGX-287 lands the M5 contract / roadmap / docs setup, with implementation slices NGX-288..NGX-294 to follow; see the Milestone 5 Roadmap below. Momentum's core primitive is a durable `Goal`; external issues/projects are source items that seed context and reconciliation, not the source of truth for completion. Goal completion is determined by the Goal's Markdown acceptance criteria plus runner, verification, and handoff evidence. Tracker writes are adapter-mediated and policy-gated: core records durable facts and external-update intents, while Linear/GitHub/Jira/etc. adapters or approved workflow steps perform external writes. Source adapters are pull/reconcile first in Milestone 5; inbound webhooks are deferred. A Goal uses one shared repo/workspace lease for now; per-source-item worktrees/workspaces are deferred until a future milestone explicitly justifies them.

## CLI Surface

Milestone 1 proves a foreground one-Iteration loop:

```text
Markdown Goal spec -> foreground runner -> Momentum-owned verification -> commit/reset -> ledger/artifacts/status
```

The public CLI shape is:

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]
momentum status [goal-id] [--data-dir <path>] [--json]
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
momentum handoff <goal-id> [--data-dir <path>] [--json]
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
momentum daemon status [--data-dir <path>] [--json]
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

The `daemon` subcommands record orchestrator-run state in SQLite (`daemon_runs`) and expose an inspection contract. They are scoped to the completed Milestone 3 operational-safety slices (NGX-272 through NGX-278): without any loop-bound flags, `daemon start` registers a new orchestrator run and returns immediately (preserving the NGX-272 register-only contract); passing `--max-loop-iterations` or `--max-idle-cycles` opts into the NGX-273 managed loop and drains queued goal iterations in-process until a bound, `stop_requested`, `stop_now_requested`, or a terminal daemon-run state is reached. `--poll-interval-ms` tunes that bounded loop and must be paired with a loop bound. `daemon stop` records a graceful stop request that the managed loop observes between cycles; `daemon stop --now` records an immediate-stop request that causes the loop to finalize the run as `canceled` rather than `stopped`. Neither command kills any external runner, worker, or process. The managed loop runs a one-shot NGX-276 startup-recovery pass before its first cycle, auto-releases stale repo locks whose owning job is terminal, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale `daemon_runs` rows; dirty / active / ambiguous cases are reported on the response under a stable skip taxonomy so operators can drive manual recovery deliberately. Manual-recovery skip reasons (`repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`) and iteration-time HEAD movement (`runner_changed_head`, `head_mismatch`) also write a `recovery.md` artifact for the goal and set a `needs_manual_recovery` flag that blocks future queue claims until an operator explicitly clears it via `momentum recovery clear`. NGX-278 closes M3 by pinning built-CLI smoke coverage for the daemon drain, graceful stop, stop-now, safe stale recovery, and manual-recovery visibility paths plus the public M3-complete markers.

`goal start --foreground` parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events`, `repo_locks` tables), creates the artifact layout, and runs one foreground iteration: it inspects the target repo, captures the pre-iteration HEAD, creates or reuses a Momentum branch, renders the iteration prompt, invokes the configured executing runner profile (`fake`, `trusted-shell`, or `acp`), runs each verification command from the repo root, and either stages and commits the full repo diff as one Momentum commit on verified success or hard-resets the worktree back to the pre-iteration HEAD on runner failure or verification failure when HEAD has not moved. If a runner or finalization step moves HEAD outside Momentum's transaction, Momentum leaves the repo unchanged; the public foreground JSON failure envelope reports only `iteration.code` / `iteration.error`, while durable manual-recovery evidence is written to `recovery.md` and surfaced through `status` and `handoff`. The iteration writes `prompt.md`, `runner.log`, `verification.log`, and a runner result JSON file under `iterations/<n>/` (`result.json` by default). On a verified commit the goal transitions to `iteration_complete` (or `completed` if the runner reports `goal_complete: true`); on runner failure, verification failure, or any pipeline error it transitions to `failed`. `status [goal-id] --json` reads the SQLite/artifact state and emits a stable JSON shape including reducer state, next job, and next-action hints, and `handoff <goal-id> --json` writes `handoff.md` and `handoff.json` (schema v1) into the goal's artifact dir.

Without `--foreground`, `goal start` takes the Milestone 2 default path: it parses the goal spec, initializes (or resumes) durable Goal state in SQLite, prepares the artifact layout, and enqueues a single `goal_iteration` job (state `pending`, iteration `1`) with idempotency key `goal:<goal-id>:iteration:1`. The Goal row is written with state `queued`; `momentum worker run` consumes that queue, executes the job, then runs the completion reducer which can enqueue subsequent iterations (up to `max_iterations`), mark the goal as `completed`, or mark the goal as `max_iterations_reached` or `failed`. Repeated `worker run` invocations drain the goal iteration by iteration. `--foreground` is retained as the Milestone 1 inline debugging path.

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

The `pnpm test` suite includes a built-binary end-to-end smoke (`test/smoke.test.ts`) that builds `dist/` via `pnpm build`, initializes disposable git repos under the OS temp dir, drives core CLI commands through the spawned binary, and asserts: the default queued enqueue path (no runner execution, idempotent re-enqueue, and queued job/event SQLite state); the foreground success path (exactly one Momentum commit on the Momentum branch with the verification log, handoff artifacts, and SQLite database in place); the foreground verification-failure reset path (worktree clean and HEAD back at base after `false` verification); the queued logs inspection path; the queued `worker run` success / verification-failure / runner-failure paths, including reducer event chains and artifact surfaces; the M3 daemon/recovery paths for managed drain, graceful stop, stop-now cancellation, safe stale recovery, and manual recovery artifact visibility via `daemon start`, `daemon stop`, `daemon status`, `status`, `logs`, `handoff`, and `recovery clear`; and the M4 real-runner paths covering the `doctor --json` M4 closeout milestone marker, the `trusted-shell` happy path (`goal start --foreground` runs the configured executable plus argv, commits the verified diff, and surfaces the iteration through `status`, `logs`, and `handoff`), the `trusted-shell` failure-and-reset path (a non-zero command exit produces `command_failed`, resets the worktree to base HEAD, and preserves the stable error code through `status` and `logs`), `MOMENTUM.md` policy precedence (the policy file's `runner` default is overridden by a CLI `--runner` flag while policy notes thread into the iteration prompt), and the `acp` `runtime_unavailable` path when the configured runtime is missing.

## Goal Spec

Goal files are Markdown that begin with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, `verification_timeout_sec`, `trusted_shell`, and `acp` are optional. Defaults are `runner: fake`, `branch: momentum/<title-slug>`, `max_iterations: 1`, `verification: []`, and `verification_timeout_sec: 900`. `max_iterations` and `verification_timeout_sec` must be positive integers. If `branch` is omitted, `title` must contain letters or numbers so Momentum can derive `momentum/<title-slug>`. The `runner` field accepts built-in runner profile names (`fake`, `trusted-shell`, `acp`); unknown names are rejected at init time. `trusted_shell` is required for trusted-shell execution and `acp` is required for ACP execution; both blocks are ignored by the fake runner, and queued initialization can persist either goal before the worker validates missing or malformed config at execution time. The `--runner` CLI flag overrides the frontmatter value, and built-in default resolution precedence is `--runner` CLI flag > goal frontmatter `runner` > `MOMENTUM.md` `runner` > `fake` (the built-in default). See the [Repo policy via MOMENTUM.md](#repo-policy-via-momentummd-ngx-284) section for the full policy precedence. In the default queued path, relative `repo` values are resolved to absolute paths before being persisted or emitted.

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

### Trusted-shell runner example

The `trusted-shell` runner profile (NGX-282) runs an operator-configured executable plus argv in the target repo by default, or in the iteration artifact directory when `trusted_shell.cwd: iteration` is set. Trusted-shell execution requires a `trusted_shell` block in the goal frontmatter; queued `goal start` stores the goal before validating that block, while foreground execution and workers validate it when the adapter runs. The config parser classifies missing/malformed config as `trusted_shell_config_missing` or `trusted_shell_config_invalid`, and the public adapter surface reports those validation failures as `invalid_input` (foreground and queued iteration surfaces map them to `runner_failed` with the parser code in the message).

> **Explicit trust posture.** `trusted-shell` is not sandboxed. The configured command runs with the full privileges of the user who invoked Momentum: no container, no VM, no seccomp, no privilege drop, and no input scrubbing. The operator is responsible for the command and any scripts it invokes. Container/VM/seccomp isolation is explicitly out of scope for M4.

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

Failure modes return stable diagnostic codes through the `RunnerAdapter` boundary: `invalid_input` (missing/malformed config), `runner_threw` (runner log could not be opened), `spawn_failed` (spawn errors such as a missing binary), `command_failed` (non-zero exit), `command_timed_out` (exceeded `timeout_sec`), `result_missing` (no result file written), `result_invalid` (unreadable, malformed, or non-conforming result JSON), and `output_overflow` (stdout/stderr exceeded the 256 MiB capture limit). The foreground and queued iteration surfaces preserve `spawn_failed`, `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, and `output_overflow` verbatim as `iteration.code` / job error codes so operator surfaces keep command / result taxonomy; only `invalid_input`, `unsupported_runner`, and `runner_threw` collapse to the generic `runner_failed`. The adapter diagnostic is always included in the error text and logs. Post-execution adapter failures reset the worktree to base HEAD only when the runner has not moved HEAD; if HEAD changed, Momentum returns `runner_changed_head` and leaves the repo for manual recovery rather than dropping runner-created commits.

### ACP runner example

The `acp` runner profile (NGX-283) is a smoke harness around the `RunnerAdapter` boundary for ACP/acpx-style external agent runtimes. Like `trusted-shell` it spawns an operator-configured executable plus argv via `spawnSync` with no implicit shell, applies `env_allow` filtering with implicit `PATH` preservation, supports `cwd: repo` (default) or `cwd: iteration`, injects the same `MOMENTUM_*` environment variables, and parses a normalized `RunnerResult` from `acp.result_file` (default `result.json`). It adds two pre-flight detections trusted-shell does not need: an absolute `acp.command` whose binary is missing on disk short-circuits with `runtime_unavailable` before any spawn attempt, and an optional `acp.probe` block runs first so missing auth or runtime is observed before the main command. Missing runtime, missing probe binary, probe non-zero exit, probe timeout, and main spawn ENOENT all return `runtime_unavailable`; non-ENOENT spawn errors return `startup_failed`; these stay distinct from `command_failed` (the runtime ran and exited non-zero) and from verification failures, so missing prerequisites never corrupt Goal state.

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

### Repo policy via MOMENTUM.md (NGX-284)

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

A `MOMENTUM.md` with no frontmatter at all is also valid: the entire body becomes policy notes and no config defaults are set. Parse / schema errors map to stable codes (`policy_path_invalid`, `policy_file_unreadable`, `policy_parse_invalid`, `policy_schema_invalid`) and are surfaced through `goal start --json`, `status --json` / text, `handoff` JSON / markdown, and `doctor --json` / text.

**Precedence (highest first):**

1. CLI overrides (`--runner`, etc.)
2. Goal frontmatter (`runner`, `verification`, `verification_timeout_sec`)
3. `MOMENTUM.md` frontmatter
4. Built-in defaults (`runner: fake`, `verification: []`, `verification_timeout_sec: 900`)

`doctor` accepts an optional `--repo <path>` flag (`momentum doctor [--repo <path>] [--data-dir <path>] [--json]`) so operators can inspect a repo's policy file in isolation; without `--repo`, the doctor `policy` block reports `repoConfigured: false`. `status` and `handoff` re-read the policy file from each goal's `repo` path at observation time rather than persisting it to the database, so editing `MOMENTUM.md` between iterations is immediately reflected without a schema migration.

## Commands

### `goal start`

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]
```

Parses the goal spec and initializes (or resumes) goal state under the resolved data directory. Behavior then branches on `--foreground`:

- **Default (queued enqueue path, Milestone 2):** writes the Goal row with state `queued` and enqueues a single `goal_iteration` job (state `pending`, iteration `1`) with idempotency key `goal:<goal-id>:iteration:1`. Repo, branch, and base HEAD are not inspected at enqueue time — that is the worker's job. Re-running with the same spec returns the same `goalId` and `jobId`, sets `resumed: true` / `enqueueCreated: false`, and emits exactly one `job.enqueued` event per idempotent first-iteration enqueue. `momentum worker run` consumes that queue and executes a claimed job once. The resolved runner profile and its source are surfaced on the JSON envelope.

  JSON envelope shape:

  ```json
  {
    "ok": true,
    "command": "goal start",
    "mode": "queued",
    "goalId": "<uuid>",
    "goalState": "queued",
    "jobId": "<uuid>",
    "jobType": "goal_iteration",
    "jobState": "pending",
    "iteration": 1,
    "idempotencyKey": "goal:<uuid>:iteration:1",
    "title": "Example Goal",
    "repo": "/path/to/repo",
    "branch": "momentum/example-goal",
    "baseHead": null,
    "runner": "fake",
    "runnerProfile": { "kind": "fake", "name": "fake", "description": "Built-in in-process fake runner; writes a fixture file and reports a normalized result. Dispatches through the RunnerAdapter boundary.", "executes": true },
    "runnerProfileSource": "builtin_default",
    "dataDir": "/path/to/data-dir",
    "artifactDir": "/path/to/data-dir/goals/<uuid>",
    "iterationArtifactDir": "/path/to/data-dir/goals/<uuid>/iterations/1",
    "resumed": false,
    "enqueueCreated": true,
    "policy": {
      "present": false,
      "path": null,
      "policyNotes": "",
      "config": { "runner": null, "verification": null, "verificationTimeoutSec": null },
      "effective": {
        "verification": [],
        "verificationTimeoutSec": 900,
        "source": { "verification": "builtin_default", "verificationTimeoutSec": "builtin_default" }
      }
    },
    "nextAction": "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job."
  }
  ```

  The `policy` block reflects the `MOMENTUM.md` summary loaded from the goal's `repo` (when set): `present`/`path` show whether the file was found, `policyNotes` is the raw notes body surfaced into iteration prompts, `config` echoes the optional frontmatter (`runner` / `verification` / `verificationTimeoutSec`, each `null` when unset), and `effective.{verification,verificationTimeoutSec,source}` records the resolved values applied to the goal after CLI / goal frontmatter / MOMENTUM.md / built-in precedence. When `repo` is not set, the goal-init policy summary is omitted (the field is absent or shows `present: false` with empty effective values).

  Init-time validation rejects unsupported runner profiles before touching the database or repo. The `code` field on failure envelopes is one of `parse_error` (malformed goal spec or unreadable file), `unsupported_runner` (unknown runner name), `malformed_profile` (blank or non-string runner value), or `init_failed` (data directory or database failure).

- **`--foreground` (Milestone 1 inline path):** drives a single foreground iteration through the configured executing runner profile and Momentum-owned verification immediately, returning the iteration outcome on the same invocation. `fake`, `trusted-shell`, and `acp` all execute through the shared `RunnerAdapter` boundary; unknown or non-executing profiles fail with `unsupported_runner`. The foreground envelope also includes `runner` and `runnerProfile` / `runnerProfileSource` fields. JSON envelope shape:

  ```json
  {
    "ok": true,
    "command": "goal start",
    "mode": "foreground",
    "goalId": "<uuid>",
    "jobId": "<uuid>",
    "jobType": "foreground_iteration",
    "title": "Example Goal",
    "runner": "fake",
    "runnerProfile": { "kind": "fake", "name": "fake", "description": "Built-in in-process fake runner; writes a fixture file and reports a normalized result. Dispatches through the RunnerAdapter boundary.", "executes": true },
    "runnerProfileSource": "builtin_default",
    "dataDir": "/path/to/data-dir",
    "artifactDir": "/path/to/data-dir/goals/<uuid>",
    "resumed": false,
    "state": "iteration_complete",
    "goalState": "iteration_complete",
    "jobState": "succeeded",
    "iteration": {
      "ok": true,
      "iteration": 1,
      "repoPath": "/path/to/repo",
      "branch": "momentum/example-goal",
      "branchCreated": true,
      "baseHead": "<sha>",
      "postRunnerHead": "<sha>",
      "commitSha": "<sha>",
      "commitMessage": "feat: short imperative subject without trailing period",
      "runnerSuccess": true,
      "goalComplete": false,
      "promptPath": "/path/to/data-dir/goals/<uuid>/iterations/1/prompt.md",
      "runnerLogPath": "/path/to/data-dir/goals/<uuid>/iterations/1/runner.log",
      "resultJsonPath": "/path/to/data-dir/goals/<uuid>/iterations/1/result.json",
      "verificationLogPath": "/path/to/data-dir/goals/<uuid>/iterations/1/verification.log"
    },
    "policy": {
      "present": false,
      "path": null,
      "policyNotes": "",
      "config": { "runner": null, "verification": null, "verificationTimeoutSec": null },
      "effective": {
        "verification": [],
        "verificationTimeoutSec": 900,
        "source": { "verification": "builtin_default", "verificationTimeoutSec": "builtin_default" }
      }
    }
  }
  ```

  The foreground envelope `policy` block has the same shape as the queued envelope and reflects the `MOMENTUM.md` summary loaded from the goal's `repo`.

Re-running `goal start` with the same goal spec against the same data directory resumes the existing goal instead of creating duplicate state in either mode. Text output begins with `Goal resumed`; JSON output sets `resumed: true`.

### `status`

```text
momentum status [goal-id] [--data-dir <path>] [--json]
```

Reads SQLite plus artifact state and reports the goal's current state, configured repo and runner, resolved runner profile, latest job, latest iteration summary (including the verified commit SHA when present), reducer decision (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), the next queued job (if any), a next-action hint, the daemon run summary, and the repo's `MOMENTUM.md` policy summary. JSON output includes `runnerProfile` (`{kind, name, description, executes}` or `null` when the stored runner name is not a built-in kind), `goalState`, `artifacts`, `currentIterationDetail`, `nextActionDetail`, `latestCommitSha`, `daemon`, `staleRecovery`, and `policy` (`{configured, present, path, hasNotes, config, error}` — see the [Repo policy via MOMENTUM.md](#repo-policy-via-momentummd-ngx-284) section); `latestJob` / `nextJob` include `idempotencyKey`, result/error paths, and lease timestamps. The `artifacts` block includes `recoveryMd` (path and exists status) showing whether a `recovery.md` artifact is present for the goal. The `daemon` field is `null` when no daemon run has ever been recorded for the data directory; otherwise it contains `runId`, `state`, `isActive`, `isTerminal`, `startedAt`, `heartbeatAt`, `finishedAt`, `activeJob` (`{jobId, lockId}`), `stopRequest` (`{requestedAt, reason}` or `null`), `stopNowRequest` (`{requestedAt, reason}` or `null`), and `cancelOutcome` (`{outcome}` or `null`). The `staleRecovery` field is goal-scoped and exposes `recoveredRepoLockCount`, `recoveredJobCount`, `latestRecoveredRepoLockAt`, `latestRecoveredJobAt` (counts and most-recent timestamps for `repo_lock.recovered` and `job.recovered` events recorded for this goal), `staleRepoLockCount`, `staleClaimedJobCount` (current goal-scoped records whose lease has expired and may need recovery), and `staleLeaseGraceMs` (5s default skew tolerance). Text output includes `Runner: <name>`, includes `Runner profile: <name> (executes=true|false)` when the stored runner name is a built-in kind, and includes an always-emitted `Recovery: present|missing (<path>)` line for the goal-scoped `recovery.md` artifact, plus a `Daemon:` line with state, active/terminal flags, and run ID; if present, `Daemon stop requested:`, `Daemon stop-now requested:`, and `Daemon cancel outcome:` lines show stop/cancel details, and a `Stale recovery:` line appears when any recovered or pending stale counts are non-zero. Text output also includes a `Policy (MOMENTUM.md): ...` line describing whether the goal's repo policy is configured, present, missing, or errored. Omitting `goal-id` selects the most recently updated goal in the data directory; when no goals exist the command exits non-zero with `code: "no_goals"`.

### `logs`

```text
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
```

Reads local iteration artifacts for a goal and emits `runner.log`, `verification.log`, and the runner result JSON artifact content. Without `--iteration`, selects the highest-numbered iteration directory under `goals/<goal-id>/iterations/` (or `goals.current_iteration` when present), so a freshly-initialized goal returns iteration `1` with empty logs and a scaffolded empty `result.json`. With `--iteration <n>`, reads that iteration's artifact dir and exits non-zero with `code: "iteration_not_found"` if it doesn't exist. `--iteration` must be a positive integer; non-positive values fail with `code: "usage_error"`. The command only reads on-disk artifacts; it does not consult live worker state. JSON output exposes `availableIterations`, `runnerLog`, `verificationLog`, and `resultJson`; each file block uses `{path, exists, readable, bytes, content, error}`, and `resultJson.parseError` is populated when the file exists but is malformed or fails the normalized `RunnerResult` schema. Empty content and the initialized `{}` scaffold are treated as "not written yet", not parse errors, so operators only see parse diagnostics for real malformed result artifacts. Text output includes a `## result.json` section and prints a parse-error note when applicable.

### `handoff`

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

Renders `handoff.md` and `handoff.json` (schema v1) into the goal's artifact directory from the same state `status` reads. The handoff includes reducer decision and next-job details, a next-action hint describing what to do next, a daemon run summary, and the repo's `MOMENTUM.md` policy summary. The JSON artifact includes `goal_state`, `goal` (with `runner` and `runner_profile` — `{kind, name, description, executes}` or `null` when the stored runner name is not a built-in kind), `current_iteration_detail`, `next_action_detail`, `latest_commit_sha`, `daemon`, `stale_recovery`, `policy` (`{configured, present, path, has_notes, config, error}` — `config` carries `runner` / `verification` / `verification_timeout_sec` or `null` when absent), and `latest_job` / `next_job` fields with idempotency keys, result/error paths, and lease timestamps. When the latest job points at a runner result artifact that is missing, unreadable, malformed, or schema-invalid, `handoff.json` includes `runner_result_error` with a stable operator-readable message instead of silently returning `null`; the markdown mirrors that with a `Runner result read error` line. Empty content and the initialized `{}` result scaffold remain a non-error null result. The `artifacts` block includes `recovery_md` showing the path to the goal-scoped `recovery.md` file, and `artifact_files` includes `recovery_md` as a boolean indicating whether the file exists on disk. The markdown includes `Runner: <name>`, includes `Runner profile: <name> (executes=true|false)` when the stored runner name is a built-in kind, and includes `recovery.md` in the artifact list; when present it shows `(present)`, when absent it shows `(missing)`. The `daemon` field is `null` when no daemon has ever run; otherwise it contains `run_id`, `state`, `is_active`, `is_terminal`, `started_at`, `heartbeat_at`, `finished_at`, `active_job` (`{job_id, lock_id}`), `stop_request` (`{requested_at, reason}` or `null`), `stop_now_request` (`{requested_at, reason}` or `null`), and `cancel_outcome` (`{outcome}` or `null`). The `stale_recovery` field is goal-scoped (`recovered_repo_lock_count`, `recovered_job_count`, `latest_recovered_repo_lock_at`, `latest_recovered_job_at`, `stale_repo_lock_count`, `stale_claimed_job_count`, `stale_lease_grace_ms`) so prior auto-recovery actions and currently stale goal-scoped records are visible alongside the handoff. The markdown includes a `## Daemon` section showing the run ID, state, stop request, stop-now request, cancel outcome, active job, and finished time, a `## Stale recovery` section that renders the recovery counts and latest timestamps (or a no-activity sentinel when none), and a `## Policy (MOMENTUM.md)` section describing whether the goal's repo policy is configured, present, missing, or errored, with the loaded `runner` / `verification` / `verification_timeout_sec` defaults and a notes-present flag when applicable.

### `worker run`

```text
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
```

Consumes queued `goal_iteration` work in single-job batches:

- Claims the oldest pending `goal_iteration` job and stamps `worker` / `lease` metadata.
- Acquires a repo lock for the goal repo before launching the iteration.
- Refreshes lease metadata with a heartbeat before execution.
- Executes the claimed `goal_iteration` through the same `finalizeIteration` transaction as the foreground path: runner → Momentum-owned verification → commit on verified success, hard reset to `baseHead` on runner/verification/commit failure when HEAD is still at the expected base, or manual recovery when HEAD moved outside Momentum's transaction.
- Persists `jobs.result_path` to the runner-reported result JSON path on success (`iterations/<n>/result.json` by default; `trusted-shell` and `acp` may use another `trusted_shell.result_file` / `acp.result_file` inside the iteration directory) and `jobs.error_path` to `iterations/<n>/verification.log` (or `runner.log` for pre-runner failures) on failure.
- Emits `job.succeeded` with commit + artifact pointers (`commit_sha`, `commit_message`, `branch`, `branch_created`, `base_head`, `goal_complete`, `result_path`, and an `artifacts` block with `iteration_dir` / `prompt` / `runner_log` / `verification_log` / `result_json`). On the failure path, `job.failed` emits the summarized error and a narrower `artifacts` block with `iteration_dir` / `runner_log` / `verification_log`.
- After the job completes, runs the completion reducer (`reduceGoalIteration`), which classifies the terminal job as `continue` (enqueue next iteration), `goal_complete` (mark goal completed), `max_iterations_reached` (mark goal terminal), or `iteration_failed` (mark goal failed). The reducer is idempotent: re-invoking it on the same job short-circuits to `already_reduced` without duplicating events or enqueueing duplicate work. If the reducer throws, the worker emits a defensive `goal.reduce_failed` event with the error message and surfaces `reducerError` on the `worker run` result so the job's commit/reset is preserved for inspection and manual recovery.
- On `continue`, enqueues one next `goal_iteration` job with idempotency key `goal:<id>:iteration:<n>`, bumps the goal to state `queued`, and emits `goal.reduced`. On `goal_complete`, sets the goal to `completed` and emits `goal.reduced` + `goal.completed`. On `max_iterations_reached` or `iteration_failed`, sets the goal to the corresponding terminal state and emits `goal.reduced` + `goal.failed`.
- Releases the repo lock with the appropriate `recovery_status` and emits a deterministic CLI JSON result (`code: no_work | not_executed | ran_job`) for automation; if the iteration returns manual-recovery metadata (`runner_changed_head` / `head_mismatch`), the lock is marked `needs_manual_recovery` and continues blocking claims until `recovery clear` releases it.

Queued jobs execute the runner profile stored on the Goal row. Both foreground and queued paths dispatch through the `RunnerAdapter` boundary (NGX-281); only runners with `executes: true` in the adapter registry can be invoked. After NGX-283, `fake`, `trusted-shell`, and `acp` are all executing runners; `trusted-shell` runs an operator-trusted executable plus argv in the target repo by default (or the iteration artifact directory with `trusted_shell.cwd: iteration`) with no sandbox, and `acp` runs an ACP/acpx-style external agent runtime via the same boundary with an optional pre-flight probe that maps missing runtime/auth to `runtime_unavailable`. Both report a normalized `RunnerResult` via a configured result file.

`--worker-id` is optional; default is `worker-<pid>`. For queued work, use:

```text
momentum worker run --data-dir <path>
```

Local interrupt policy: `worker run` is a foreground one-shot command. If the process is interrupted mid-run, jobs/locks may remain claimed or active until lock expiry; re-running the command is the supported local recovery path. The NGX-276 stale-lease pre-check runs before any claim attempt and surfaces a `stalePreCheck` block on the JSON response (and a one-line notice on text mode) listing any active repo locks and claimed/running `goal_iteration` jobs whose lease has expired beyond `staleLeaseGraceMs` (5s default skew tolerance), so operators see what needs manual recovery before launching another worker. The startup-recovery pass that the managed `daemon start` loop runs is the path that automatically releases known-safe stale leases; `worker run` itself stays read-only on stale records.

`status --json` and `handoff --json` surface the same `latestJob.resultPath` / `latestJob.errorPath` pointers, plus `reducer` (decision, iteration, goal state, completion reason, commit SHA, next job), `nextJob` (the queued next-iteration job, if any), `nextAction` (a human-readable hint), and `daemon` (run ID, state, active/terminal flags, heartbeat, active job, stop request, stop-now request, and cancel outcome) so downstream tooling can locate the per-iteration artifacts, decide what to do next, and observe daemon stop/cancel state without running `daemon status` separately. The written `handoff.json` artifact keeps snake_case `result_path` / `error_path` fields.

### `daemon start`

```text
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
```

Records a new orchestrator run in `daemon_runs` (state `running`) with `pid`, `host`, `started_at`, and `heartbeat_at` populated from the invoking process. Refuses to record a second concurrent run while one is still active (states `starting`, `running`, `stop_requested`) and exits with `code: "daemon_already_active"` (exit 1); the failure payload surfaces the existing `runId`, `state`, `pid`, `host`, `startedAt`, `heartbeatAt`, `heartbeatAgeMs`, and a `stale` flag (90s default heartbeat cutoff, or 930s default while an active job is recorded) so operators can decide whether to wait or recover the prior record. In managed-loop mode, a stale existing active run is first passed through the startup-recovery primitives; if it is an idle stale daemon row that can be auto-finalized safely, the new start proceeds and the managed loop still reports its own pre-loop `loop.startupRecovery` summary. After a terminal record (`stopped` / `canceled` / `error`), a fresh start is allowed.

Without any loop-bound flag, `daemon start` returns immediately after registering the run (the NGX-272 register-only contract). Passing `--max-loop-iterations` or `--max-idle-cycles` opts into the NGX-273 managed loop: the process keeps running and drains queued `goal_iteration` jobs in-process by composing `runWorkerOnce`, refreshes `daemon_runs.heartbeat_at` / `active_job_id` / `reconcile_count` per cycle, applies deterministic idle backoff between empty polls or unexecutable jobs, and exits cleanly when one of the bounds is reached, `daemon stop` records a stop request, `daemon stop --now` records an immediate-stop request, or a terminal daemon-run state is observed. `--poll-interval-ms` only tunes the bounded loop, defaults to 500ms, accepts non-negative integer millisecond values (`0` allowed), and is rejected unless `--max-loop-iterations` or `--max-idle-cycles` is also present. The top-level `ok` field reports loop/process health; `workSucceeded` reports whether claimed queued jobs succeeded, and managed-loop mode exits non-zero when either `ok` or `workSucceeded` is false. The opt-in surfaces a `loop` summary on the response with `exitReason` (`stop_requested` / `stop_now_requested` / `run_terminated` / `run_missing` / `max_loop_iterations` / `max_idle_cycles` / `internal_error`), `terminalState`, `cancelOutcome`, `workSucceeded`, `iterations`, `jobsRun`, `jobsFailed`, `jobsNotExecuted`, `idleCycles`, `lastObservedState`, `lastWorkerCode`, `startupRecovery`, and `error`. All loop bounds must be non-negative integers; a `--max-idle-cycles 0` or `--max-loop-iterations 0` invocation exits before claiming any work, which is useful as a one-shot readiness probe.

JSON envelope shape (register-only):

```json
{
  "ok": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "running",
  "startedAt": 1731500000000,
  "heartbeatAt": 1731500000000
}
```

JSON envelope shape (managed loop):

```json
{
  "ok": true,
  "workSucceeded": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "stopped",
  "startedAt": 1731500000000,
  "workerId": "daemon-12345",
  "loop": {
    "exitReason": "max_idle_cycles",
    "terminalState": "stopped",
    "cancelOutcome": null,
    "workSucceeded": true,
    "iterations": 1,
    "jobsRun": 0,
    "jobsFailed": 0,
    "jobsNotExecuted": 1,
    "idleCycles": 1,
    "lastObservedState": "running",
    "lastWorkerCode": "not_executed",
    "startupRecovery": {
      "observedAt": 1731500000000,
      "graceMs": 5000,
      "recoveredRepoLockCount": 0,
      "recoveredClaimedJobCount": 0,
      "recoveredDaemonRunCount": 0,
      "skippedRepoLocks": [],
      "skippedClaimedJobs": [],
      "skippedDaemonRuns": []
    }
  }
}
```

### `daemon stop`

```text
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
```

Records a graceful stop request against the active daemon run (`stop_requested_at` and `stop_reason`); the underlying state transitions to `stop_requested` if it was not already. Default reason is `operator-requested`. Idempotent: re-running on a record that is already `stop_requested` keeps the original `stopRequestedAt`, refreshes `stopReason`, and sets `alreadyStopRequested: true` unless a stop-now request has already been recorded. Passing `--now` records an immediate stop-now request (`stop_now_requested_at`) with default reason `operator-requested-immediate`; repeat stop-now calls keep the original stop-now timestamp/reason and set `alreadyStopNow: true`. After stop-now is recorded, later graceful `daemon stop --reason ...` calls preserve the existing stop-now reason and timestamp. Exits with `code: "no_active_daemon"` (exit 1) when no active record exists; if the latest record is terminal, the failure payload includes a `latest` summary so operators can see what was already stopped, canceled, or failed.

The NGX-273/NGX-275 managed loop observes graceful and immediate stop requests between cycles. Graceful stop exits as `stopped`; stop-now exits as `canceled` and records `cancelOutcome` (`idle` if no job ran in that loop session, `active_job_completed` if an in-flight iteration completed before cancellation was observed). The command does not signal, kill, or otherwise terminate any running runner, worker, or external process; process signaling, forced termination, and mid-job cancellation are deferred to a future milestone (M3 stop semantics are intentionally observation-only).

JSON envelope shape:

```json
{
  "ok": true,
  "command": "daemon stop",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "previousState": "running",
  "state": "stop_requested",
  "pid": 12345,
  "host": "hostname",
  "startedAt": 1731500000000,
  "stopRequestedAt": 1731500010000,
  "stopReason": "operator-requested",
  "alreadyStopRequested": false,
  "immediate": false,
  "alreadyStopNow": false,
  "stopNowRequestedAt": null,
  "heartbeatAt": 1731500000000,
  "heartbeatAgeMs": 10000,
  "stale": false
}
```

### `daemon status`

```text
momentum daemon status [--data-dir <path>] [--json]
```

Read-only inspector for `daemon_runs`. Selects the active record if one exists; otherwise falls back to the most recently started run so operators can see terminal/error state. When no daemon has ever started, exits 0 with `hasRun: false` (text mode: `Daemon: never started`). The summary surfaces `runId`, `pid`, `host`, `state`, `isActive`, `isTerminal`, `startedAt`, `heartbeatAt`, `lastStateChangeAt`, `finishedAt`, `ageMs`, `heartbeatAgeMs`, `stale`, `staleAfterMs` (90s default heartbeat cutoff, or `activeJobStaleAfterMs` while an active job is recorded), `activeJobStaleAfterMs` (930s default), `activeJob` (`{jobId, lockId}`), `stopRequest` (`{requestedAt, reason}` or `null`), `stopNowRequest` (`{requestedAt, reason}` or `null`), `cancelOutcome` (`{outcome}` or `null`), `reconciliation` (`{count, lastReconciledAt}`), `error` (`{message, at}` or `null`), and `updatedAt`. The envelope also lists `staleRepoLocks` (active repo locks whose `lease_expires_at` is in the past) and `staleClaimedJobs` (claimed/running `goal_iteration` jobs whose lease has lapsed), tolerating up to `staleLeaseGraceMs` (5s default) of clock skew, plus `goalsNeedingRecovery` listing goals whose durable `needs_manual_recovery` flag is set (each entry includes `goalId`, `title`, `goalState`, `recoveryMdPath`, and `recoveryMdExists`). `daemon status` itself is read-only — running it triggers no recovery action. Automatic recovery for known-safe stale leases is performed by the NGX-276 startup-recovery pass when a managed `daemon start` boots; rows surfaced by `daemon status` are the current stale snapshot and may still need manual recovery if a startup-recovery pass skips them.

JSON envelope shape (active run with no stop request or error):

```json
{
  "ok": true,
  "command": "daemon status",
  "dataDir": "/path/to/data-dir",
  "hasRun": true,
  "daemonRun": {
    "runId": "<uuid>",
    "pid": 12345,
    "host": "hostname",
    "state": "running",
    "isActive": true,
    "isTerminal": false,
    "startedAt": 1731500000000,
    "heartbeatAt": 1731500000000,
    "lastStateChangeAt": 1731500000000,
    "finishedAt": null,
    "ageMs": 0,
    "heartbeatAgeMs": 0,
    "stale": false,
    "staleAfterMs": 90000,
    "activeJobStaleAfterMs": 930000,
    "activeJob": { "jobId": null, "lockId": null },
    "stopRequest": null,
    "stopNowRequest": null,
    "cancelOutcome": null,
    "reconciliation": { "count": 0, "lastReconciledAt": null },
    "error": null,
    "updatedAt": 1731500000000
  },
  "staleAfterMs": 90000,
  "activeJobStaleAfterMs": 930000,
  "staleLeaseGraceMs": 5000,
  "staleRuns": [],
  "staleRepoLocks": [],
  "staleClaimedJobs": [],
  "goalsNeedingRecovery": [],
  "observedAt": 1731500000000
}
```

### `recovery clear`

```text
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
```

Clears the `needs_manual_recovery` flag on a goal so it becomes eligible for queue claims again. Refuses safely when the goal does not exist (`code: goal_not_found`), is not currently flagged (`code: not_flagged`), or still has an active `claimed`/`running` job (`code: job_active` with `activeJobIds`). On success, releases any repo locks for the goal in `needs_manual_recovery` state and appends a `goal.recovery_cleared` audit event with the previous reason, previous marked-at timestamp, cleared-at timestamp, optional `operatorReason`, and `releasedRepoLockIds` when locks were released. The `recovery.md` artifact is intentionally left on disk as durable evidence — operators should remove it manually after capturing the context elsewhere. Idempotent in the sense that a second clear on the same goal fails with `code: not_flagged`.

JSON envelope shape (success):

```json
{
  "ok": true,
  "command": "recovery clear",
  "goalId": "<uuid>",
  "dataDir": "/path/to/data-dir",
  "previousReason": "repo_dirty",
  "previousMarkedAt": 1731500000000,
  "clearedAt": 1731500060000,
  "eventId": 42
}
```

JSON envelope shape (failure — goal has active jobs):

```json
{
  "ok": false,
  "command": "recovery clear",
  "code": "job_active",
  "message": "Goal <uuid> has 1 active goal_iteration job(s); release or finalize them before clearing manual recovery.",
  "goalId": "<uuid>",
  "dataDir": "/path/to/data-dir",
  "activeJobIds": ["<job-uuid>"]
}
```

Text output includes the goal ID, previous reason, previous marked-at timestamp, cleared-at timestamp, and event ID.

### `doctor`

```text
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

Reports CLI version, Node.js version, platform, the current milestone scope label, and a compact daemon-readiness block read from `daemon_runs` (`{ok, dataDir, hasRun, state, isActive, stale, staleRunCount, staleRepoLockCount, staleClaimedJobCount, goalsNeedingRecoveryCount, runId}` on success, `{ok: false, code, message}` on failure). The stale-lease counts surface orphaned repo locks and claimed/running jobs whose lease expired more than `staleLeaseGraceMs` ago. The `goalsNeedingRecoveryCount` surface shows how many goals currently have the durable `needs_manual_recovery` flag set in the selected data directory; pass `--data-dir <path>` to inspect a non-default Momentum home. The `runners` block in JSON output lists `supported` (the current set of built-in runner profile names, `["fake", "trusted-shell", "acp"]`), `default` (the built-in default runner kind, `"fake"`), and `profiles` (an array of `{kind, name, description, executes}` objects for each built-in runner). All three profiles now have `executes: true`; `trusted-shell` runs the operator-configured executable plus argv with no sandbox and no privilege drop, and `acp` runs the configured ACP/acpx-style external agent runtime with the same trust posture plus a stable `runtime_unavailable` code so missing runtime or auth is distinct from command failures. The `policy` block in JSON output reports the repo's `MOMENTUM.md` state (`{repoConfigured, repoPath, present, path, hasNotes, config, error}`): without `--repo` it returns `repoConfigured: false`; with `--repo <path>` it loads the policy file from the repo root and surfaces the parsed `config` (`runner` / `verification` / `verificationTimeoutSec`) plus a stable `error` code (`policy_path_invalid` / `policy_file_unreadable` / `policy_parse_invalid` / `policy_schema_invalid`) on load failure. Text output includes a `runners:` line showing the supported kinds and default, plus a `policy (MOMENTUM.md):` line summarizing the repo policy load. Useful as a first sanity check after install, as a quick orchestrator-health probe, and as a way to validate a repo's policy file in isolation.

### Stale-lease detection and auto-recovery (NGX-276)

Momentum detects stale leases on three durable surfaces and auto-recovers only those it can prove are safe; everything else is surfaced for explicit manual recovery.

| Surface | Stale condition | Auto-recovery action | Skip reasons (manual recovery) |
|---|---|---|---|
| Repo lock (`repo_locks`) | `state = 'active'` AND `lease_expires_at < now - staleLeaseGraceMs` | Released when the owning job is terminal (`succeeded` / `failed`); emits `repo_lock.recovered` and stamps `recovery_status = 'auto_released_job_terminal'`. | `job_pending` / `job_claimed` / `job_running` / `job_missing`. |
| Claimed/running `goal_iteration` job (`jobs`) | `state IN ('claimed', 'running')` AND `lease_expires_at < now - staleLeaseGraceMs` | Safe stale `claimed` jobs are re-pended without losing `attempt_count` or idempotency key; emits `job.recovered` with `recovery_status = 'auto_repended_stale_claim'`. `running` jobs are skipped. | `job_running` (in-flight repo writes), `daemon_active` (live owner), `lock_active` (held lock), `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` (repo-state safety refusal), `job_state_changed` (concurrent update race). |
| Daemon record (`daemon_runs`) | Active state (`starting` / `running` / `stop_requested`) AND `heartbeat_at` is older than `staleAfterMs` (90s idle / 930s with `active_job_id`) | Finalized to `error` terminal with `recovery_status = 'auto_recovered_idle_stale'` when `active_job_id` and `active_lock_id` are both `NULL`. | `self` (caller's own run), `active_job_present` (delegates to job-side recovery), `active_lock_present` (delegates to lock-side recovery), `run_state_changed` (concurrent update race). |

The managed `daemon start` loop runs a one-shot `runStartupRecovery` pass before its first cycle. All three primitives are independently idempotent, share one observed `now`, and emit structured recovery events (where the events schema's non-empty `goal_id` constraint allows). The CLI surfaces them at:

- `daemon start --max-loop-iterations N` JSON response — `loop.startupRecovery` with `observedAt`, `graceMs`, recovered counts, and skipped arrays for repo locks, claimed jobs, and daemon runs.
- `daemon status --json` / text — current `staleRepoLocks`, `staleClaimedJobs`, and `staleRuns` rows, with `staleLeaseGraceMs` (5s default skew tolerance).
- `doctor --json` / text — compact counts: `staleRunCount`, `staleRepoLockCount`, `staleClaimedJobCount`.
- `status --json` / text and `handoff` — goal-scoped `staleRecovery` block with `recoveredRepoLockCount`, `recoveredJobCount`, `latestRecoveredRepoLockAt`, `latestRecoveredJobAt`, current `staleRepoLockCount`, current `staleClaimedJobCount`, and `staleLeaseGraceMs`; markdown handoff includes a `## Stale recovery` section.
- `worker run --json` / text — pre-claim `stalePreCheck` snapshot listing stale repo locks and claimed/running jobs observed before the worker attempts to claim a job.

Manual recovery is the operator-driven path for everything that lands in a skip taxonomy. Stale-claim skip reasons (`repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`) and iteration-time HEAD movement (`runner_changed_head`, `head_mismatch`) write a goal-scoped `recovery.md` artifact and set a durable `needs_manual_recovery` flag on the goal row; the flag blocks future queue claims until an operator explicitly clears it via `momentum recovery clear`. Skip reasons that indicate live ownership (`daemon_active`, `lock_active`, `job_state_changed`) do not produce an artifact since they resolve on their own.

### Manual recovery artifacts and flag (NGX-277)

When the daemon's startup-recovery pass or manual inspection identifies a stale claim that cannot be auto-recovered (because the repo is dirty, HEAD is unresolvable, the repo path is missing, or the job is still in a `running` state), or when iteration execution detects runner/finalization HEAD movement, Momentum writes a `recovery.md` artifact to the goal's artifact directory and sets a durable `needs_manual_recovery` flag on the goal row. The flag blocks `claimPendingGoalIterationJob` from claiming any pending iteration for that goal until the operator explicitly clears it.

The `recovery.md` artifact contains:

- Schema version, goal ID, job ID, iteration, daemon run ID, repo path
- The reason code and human-readable message (`repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`, `runner_changed_head`, or `head_mismatch`)
- Commit pointers (expected pre-iteration commit vs current commit)
- Paths to relevant iteration artifacts (prompt, runner log, verification log, result JSON)
- A Runner/profile section with the configured runner plus command, args, cwd, timeout, and result-file metadata when available
- Safe next steps with actionable guidance

The flag is surfaced in the queue claim filter so flagged goals are invisible to `worker run` and `daemon start` loop claims. Operators can detect flagged goals via:

- `daemon status --json` — `goalsNeedingRecovery` array with `goalId`, `title`, `goalState`, `recoveryMdPath`, and `recoveryMdExists`
- `doctor --json` — `goalsNeedingRecoveryCount` compact count
- `status --json` — `nextActionDetail.kind` = `manual_recovery_required`; `artifacts.recoveryMd` and `artifactFiles.recoveryMd` show the evidence file path/presence separately
- `handoff.json` — `next_action_detail.kind` = `manual_recovery_required`; `artifacts.recovery_md` and `artifact_files.recovery_md` show the evidence file path/presence separately

`recovery.md` presence is not equivalent to the durable flag: `recovery clear` leaves the artifact on disk as evidence after the goal is unblocked.

The operator acknowledgement flow is `momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]`, which:

1. Checks that the goal exists and is currently flagged (`not_flagged` otherwise).
2. Checks that no claimed/running jobs hold the goal (`job_active` with `activeJobIds` otherwise).
3. Clears `needs_manual_recovery`, `manual_recovery_reason`, and `manual_recovery_at` on the goal row.
4. Releases repo locks for the goal that are in `needs_manual_recovery` state.
5. Appends a `goal.recovery_cleared` audit event with the previous reason, previous marked-at timestamp, cleared-at timestamp, optional `operatorReason`, and released lock IDs.
6. Leaves `recovery.md` on disk as durable evidence (operators remove it manually after capturing context).

On successful clear, the goal immediately becomes eligible for queue claims again.

## Data Directory

State is stored under `--data-dir <path>`, then the `MOMENTUM_HOME` environment variable, then `~/.momentum`. Momentum never modifies the data directory outside this resolved path. Each goal lives in its own directory keyed by goal ID, so multiple concurrent goals share the same SQLite database but isolated artifact trees.

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events, repo_locks, daemon_runs tables)
  goals/
    <goal-id>/
      goal.md                  # Canonical copy of the goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by `handoff` (empty placeholder until then)
      handoff.json             # Populated by `handoff` (schema v1)
      recovery.md               # Populated when a goal is flagged for manual recovery; includes reason, artifact paths, runner/profile metadata, and prompt path when available
      iterations/
        <n>/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner metadata and captured stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Default runner result envelope; trusted-shell / acp may report another in-dir result file
```

`goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and the first iteration artifact files are created up-front during goal initialization; `handoff.md`, `prompt.md`, `runner.log`, and `verification.log` start empty, while `handoff.json` and the default `result.json` start as `{}`. `goal start --foreground` populates the iteration artifacts during inline execution. In the queued path, iteration 1 starts with placeholders; later iteration directories and jobs are created by the reducer, and their artifact files are materialized when `momentum worker run` claims and executes that iteration.

## Failure and Reset Semantics

Momentum treats each iteration as a transaction over the target repo. The pre-iteration HEAD on the Momentum branch is captured as `baseHead` before the runner runs. From there, exactly one of these outcomes applies:

| Outcome | Trigger | Repo effect | Goal state (foreground) | Goal state (queued, via reducer) | JSON error code |
|---|---|---|---|---|---|
| `committed` | Runner success and all verification commands exit 0 | One commit on the Momentum branch with the full staged repo diff | `iteration_complete` (or `completed` if runner sets `goal_complete: true`) | `queued` (continue, next iteration enqueued), `completed` (goal_complete), or `max_iterations_reached` | n/a (`ok: true`) |
| `reset_runner_failure` | Runner reports `success: false`, exits non-zero, times out, cannot spawn, overflows output capture, or writes a missing/invalid result artifact while HEAD remains at `baseHead` | Hard reset to `baseHead`; verification is skipped and a note is written to `verification.log` | `failed` | `failed` (iteration_failed) | `runner_reported_failure`, `command_failed`, `command_timed_out`, `spawn_failed`, `output_overflow`, `result_missing`, `result_invalid`, `runtime_unavailable`, `startup_failed` |
| `reset_verification_failure` | Any verification command exits non-zero | Hard reset to `baseHead` | `failed` | `failed` (iteration_failed) | `verification_failed` |
| `commit_failed` | Verification passed but `git commit` failed | Best-effort hard reset to `baseHead`; if the reset also fails the JSON error code becomes `reset_failed` | `failed` | `failed` (iteration_failed) | `commit_failed` (or `reset_failed`) |
| `reset_failed` | The reset itself failed after a runner or verification failure | Repo may still have uncommitted changes; requires manual inspection | `failed` | `failed` | `reset_failed` |
| `manual_recovery` | Runner advanced HEAD (`runner_changed_head`) or commit/reset saw HEAD no longer at `baseHead` (`head_mismatch`) | Repo is left unchanged so Momentum does not drop non-Momentum commits; both foreground and queued paths write `recovery.md` and set `needs_manual_recovery`; queued workers also keep the repo lock blocking until `recovery clear` | `failed` | `failed` (claims blocked until cleared) | `runner_changed_head`, or `commit_failed` / `reset_failed` with manual-recovery reason `head_mismatch` |

Other early-pipeline errors surface as their own codes (`invalid_input`, `missing_repo`, `unsupported_runner`, `repo_guard_failed`, `branch_manager_failed`, `artifact_write_failed`, `git_failed`, `unexpected_error`) and do not produce a commit. Real runner adapter failures preserve their command/runtime/result taxonomy through `iteration.code`, `status`, `logs`, `handoff`, and recovery artifacts instead of collapsing into generic `runner_failed`. Verification output is captured to `verification.log` with `[verify]` prefixes; the on-disk buffer is capped so a runaway command cannot fill the data directory.

## End-to-end Walkthrough

Drive a fresh disposable run from anywhere in this repo. The default path is **queued**: `goal start` enqueues a `goal_iteration` job, and `worker run` drains the queue one iteration at a time.

```bash
pnpm build
REPO=$(mktemp -d)
DATA=$(mktemp -d)
git -C "$REPO" init --initial-branch=main --quiet
git -C "$REPO" config user.email you@example.com
git -C "$REPO" config user.name "You"
printf "smoke\n" > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -m init --quiet

cat > "$DATA/goal.md" <<'EOF'
---
title: Smoke Goal
repo: REPO_PLACEHOLDER
runner: fake
verification:
  - "true"
---

End-to-end smoke goal.
EOF
sed -i.bak "s|REPO_PLACEHOLDER|$REPO|" "$DATA/goal.md" && rm "$DATA/goal.md.bak"

# 1. Enqueue the first iteration (queued default path).
node dist/index.js goal start "$DATA/goal.md" --data-dir "$DATA" --json
GOAL_ID=$(ls "$DATA/goals" | head -n 1)

# 2. Drain one queued goal_iteration job.
node dist/index.js worker run --data-dir "$DATA" --json

# 3. Inspect queued lifecycle through status / logs / handoff.
node dist/index.js status "$GOAL_ID" --data-dir "$DATA" --json
node dist/index.js logs "$GOAL_ID" --data-dir "$DATA" --json
node dist/index.js handoff "$GOAL_ID" --data-dir "$DATA" --json
```

Replacing the `verification: ["true"]` line with `verification: ["false"]` exercises the failure-reset path: the queued `goal_iteration` job fails, the worktree is reset to its pre-iteration HEAD, `verification.log` records the failed command, and `status --json` exposes `latestJob.errorPath` plus the `artifacts` block for inspection.

### Managed daemon drain (M3 alternative)

`worker run` is the single-shot consumer (step 2 above): one invocation drains one claimed job. The M3 managed loop on `daemon start` is the bounded continuous-draining equivalent — composes `runWorkerOnce` in-process, runs the NGX-276 startup-recovery pre-pass, and exits cleanly when a bound, `daemon stop`, `daemon stop --now`, or terminal daemon-run state is observed:

```bash
# Drain queued goal_iteration jobs until idle (alternative to repeated `worker run`).
node dist/index.js daemon start --data-dir "$DATA" --max-idle-cycles 2 --poll-interval-ms 0 --json
node dist/index.js daemon status --data-dir "$DATA" --json
```

Pick `worker run` when you want a one-shot iteration claim with no orchestrator-run record; pick `daemon start --max-*` when you want to drain multiple chained iterations under a single `daemon_runs` row that `daemon status`, `status --json`, and `handoff` can surface. Both paths share the same queue and produce the same artifacts.

### Foreground debug path

`--foreground` is retained as a Milestone 1 inline debugging path. It bypasses the queue and runs one iteration synchronously, useful when iterating on runner profiles or reproducing a single iteration locally without the worker:

```bash
node dist/index.js goal start "$DATA/goal.md" \
  --foreground --repo "$REPO" --data-dir "$DATA" --runner fake --json
```

Day-to-day execution should use the default queued path so the reducer can chain iterations and the queue can be inspected with `status` / `logs` / `handoff`.

## Milestone 3 Alignment

Milestone 3 is **orchestrator lifecycle / operational safety**, not merely daemon process plumbing. It completed daemon/orchestrator state, stop-request visibility, stale-lease recovery, manual recovery artifacts, and closeout smoke/docs while preserving Momentum's durable Goal/Iteration/Job/Handoff model and SQLite-backed queue. The work is informed by OpenAI Symphony's orchestration model ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)) but Momentum is a durable local-first engine, not an issue-tracker poller / Codex app-server clone.

### Durable primitives

Momentum's product model is centered on these durable concepts; M3 must not break or rename them:

- **Goal**: the core product primitive. A Markdown spec plus acceptance criteria, durably tracked in SQLite with its own state machine.
- **Source**: an external system that can seed Goals or reconcile context (Linear, GitHub, Jira, etc.).
- **Source Item**: a durable intake record under a Goal, drawn from a Source. Not the completion authority.
- **Iteration**: one verified attempt at the Goal, with prompt, runner log, verification log, and result artifacts.
- **Job**: a queued unit of work (today: `goal_iteration`) with idempotency key, lease, and result/error pointers.
- **RunnerAdapter**: the boundary for invoking an agent runner (currently `fake`, `trusted-shell`, and `acp`; later Codex, Claude, OpenCode, and other ACP/app-server backends through the same boundary).
- **Workflow / Policy**: repo-owned configuration and prompt contract, `MOMENTUM.md` (runtime loader shipped in M4 via NGX-284; M3 documented the contract only).
- **Workspace / Repo Lease**: the shared per-Goal repo lock that protects the working tree during an iteration.
- **Event**: append-only record on the durable event log (`job.enqueued`, `job.claimed`, `job.heartbeat`, `iteration_*`, `job.succeeded`/`job.failed`, `repo_lock.recovered`, `job.recovered`, `goal.reduced`, `goal.completed`/`goal.failed`, `goal.reduce_failed`, `goal.recovery_cleared`).
- **Handoff**: the `handoff.md` + `handoff.json` artifacts that snapshot state for continuity.

### Locked decisions

- Momentum's core product primitive is `Goal`, not `Issue`. A Goal may be seeded from one or more source items; Linear projects/issues are one source shape, not the source of truth.
- Goal completion is decided by the Goal Markdown acceptance criteria plus runner, verification, and handoff evidence, not by source-item count or external tracker state alone.
- Tracker writes are **adapter-mediated and policy-gated**. Momentum core records durable facts and emits external-update intents; Linear/GitHub/Jira/etc. adapters or approved workflow steps perform the external writes.
- Source adapters were scoped as **pull / reconcile first** in M3 alignment; active source-adapter implementation now belongs to M5. No inbound webhook infrastructure in the operational-safety milestone.
- A Goal uses **one shared repo / workspace lease** for now. Per-source-item worktrees or workspaces are deferred until daemon, stop, and recovery behavior are solid.
- `MOMENTUM.md` is the canonical future repo policy file. M3 documents it as a contract but does **not** add a runtime loader, parser, or precedence rules unless a future milestone explicitly proves it is required.

### Symphony to Momentum domain mapping

| Symphony concept | Momentum equivalent |
|---|---|
| `WORKFLOW.md` | Future `MOMENTUM.md` repo policy contract (doc-only in M3). |
| Issue | Source item / intake record under a Momentum Goal. |
| Orchestrator state (in-memory) | Momentum daemon/orchestrator state plus durable queue/job records in SQLite. |
| Per-issue workspace | Current Goal repo-lease boundary; future worktree support deferred. |
| Agent runner | Momentum `RunnerAdapter` boundary (Codex, Claude, OpenCode, ACP/app-server backends). |
| Status / log snapshots | Momentum events, `status --json`, `logs`, and `handoff` artifacts. |

### Adopt from Symphony

- Repo-owned workflow config and prompt contract (future `MOMENTUM.md`), with typed config loading and dynamic reload semantics added later only when justified.
- Single-authority scheduling and explicit reconciliation passes.
- Retry / backoff taxonomy on jobs and runner calls.
- Workspace safety invariants (clean tree, captured base HEAD, deterministic reset).
- A runner event taxonomy that makes runner progress observable without coupling to one vendor.
- Token / rate-limit observability and an explicit trust / sandbox posture for runners.

### Avoid from Symphony

- In-memory-only scheduler state; Momentum's queue stays durable in SQLite.
- A Codex-only runner protocol; keep the `RunnerAdapter` boundary multi-backend.
- An issue-tracker-only product model; Goal remains the durable primitive.
- High-trust auto-approval as an implicit default; every external/destructive action must be policy-gated.
- Inbound webhooks in M3; adapters stay pull / reconcile first.
- Per-issue workspace cleanup that risks losing audit artifacts.
- Core-owned tracker writes; adapters or approved workflow steps own external writes.
- A runtime `MOMENTUM.md` loader before a future milestone proves it is needed.

## Milestone 4 Roadmap

Milestone 4 (Real Runner Profiles) is complete. NGX-279..NGX-286 are all shipped: the `RunnerAdapter` boundary executes goals through real runner profiles (`fake`, `trusted-shell`, `acp`) without changing the Goal/Iteration/Job contract or the M3 daemon/recovery surfaces, the runtime `MOMENTUM.md` policy loader lands repo-owned defaults between goal frontmatter and built-in defaults, real-runner status/logs/recovery surfaces preserve the full command/runtime/result taxonomy, and NGX-286 pinned the M4 closeout with built-CLI smoke coverage for the trusted-shell happy and failure paths plus `MOMENTUM.md` precedence, marked the milestone complete in `doctor`, README, and AGENTS, and re-stated the explicit M5/post-M4 deferral set. External tracker automation (Linear/GitHub/Jira writes, webhooks) remains deferred and is **not** part of M4.

### Milestone goal

Land a `RunnerAdapter` boundary so Momentum can execute Goals through more than the in-process `fake` runner without changing the Goal/Iteration/Job contract or the M3 daemon/recovery surfaces. The first real profile is a `trusted-shell` runner; an `acp` ACP/acpx-style runtime smoke profile has also landed alongside it. Runtime `MOMENTUM.md` policy loading lands second so repo-owned policy can gate runner choice and verification. External tracker automation (Linear/GitHub/Jira writes, webhooks) remains deferred and is **not** part of M4.

### Architecture decision: core vs runner adapters

- **Momentum core** owns the durable Goal/Iteration/Job state machine, Momentum-owned verification, the git transaction (commit/reset on the Momentum branch), the on-disk artifact layout, and the queue/daemon/recovery surfaces shipped in M2 and M3.
- **`RunnerAdapter` implementations** execute the iteration prompt against an external runtime (shell, agent, ACP backend), capture runner output in the adapter-specific manner and write it to `runner.log`, and report a normalized `RunnerResult` containing `success`, `summary`, change/learning/work arrays, `goal_complete`, and commit intent. Adapters do not touch git, do not own verification, do not own the queue, and do not write to external trackers.
- The boundary stays single-process and trust-explicit for v0; sandbox/isolation hardening is out of scope for M4.

### Initial supported runner family

- `fake`: existing in-process runner (Milestone 1/2 baseline) — kept as the default for tests and smoke coverage.
- `trusted-shell`: operator-trusted executable/argv profile (NGX-282); a goal frontmatter `trusted_shell` block configures the executable `command`, argv `args`, `cwd` (`repo` default or `iteration`), `env_allow` / `env`, `timeout_sec`, and `result_file`. The runner executes `command` with `args` directly (no implicit shell), with no sandbox, records command/cwd/result metadata in `runner.log`, captures stdout/stderr after the command exits, and reads the normalized `RunnerResult` from the configured result file. Stable error codes cover `invalid_input` (missing/malformed config), `runner_threw` (runner log could not be opened), `spawn_failed` (spawn errors such as a missing binary), `command_failed` (non-zero exit), `command_timed_out` (exceeded `timeout_sec`), `result_missing` (no result file written), `result_invalid` (unreadable, malformed, or non-conforming result JSON), and `output_overflow` (stdout/stderr exceeded the 256 MiB capture limit).
- `acp`: ACP/acpx-style runtime smoke profile (NGX-283); a goal frontmatter `acp` block configures the executable `command`, argv `args`, `cwd` (`repo` default or `iteration`), `env_allow` / `env`, `timeout_sec`, `result_file`, and an optional `probe` sub-block with its own `command` / `args` / `timeout_sec` (default `30`). The runner performs a pre-flight availability check on absolute `acp.command` paths, runs the probe (if configured) before the main command so missing runtime or auth is caught early, then spawns the configured command via `spawnSync` with no implicit shell and reads the normalized `RunnerResult` from `acp.result_file`. Failure codes inherit the `trusted-shell` taxonomy (`invalid_input`, `runner_threw`, `command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, `output_overflow`) and add `runtime_unavailable` (missing runtime binary, missing probe binary, probe non-zero exit, probe timeout, or main spawn ENOENT) and `startup_failed` (non-ENOENT spawn errors on the main command or the probe), keeping missing prerequisites distinct from `command_failed` and from verification failures. Live ACP/acpx smoke is opt-in: when the configured runtime or its auth is missing, the runner returns `runtime_unavailable` without modifying repo state instead of corrupting the Goal.

External writes remain adapter-mediated and policy-gated (Linear/GitHub/Jira adapters or workflow steps). M4 does **not** implement any external tracker writes.

### Planned issue order

The Linear milestone "Milestone 4: Real Runner Profiles" sequences the work as:

1. **NGX-279 — M4-00 M4 contract, roadmap, and docs setup** *(done)*
2. **NGX-280 — M4-01 Runner profile model and resolver** *(done)*: added `src/runner-profile.ts` with the built-in registry (`BUILTIN_RUNNER_KINDS = ["fake", "trusted-shell"]`, `DEFAULT_RUNNER_KIND = "fake"`), `parseRunnerProfile` (validates and normalizes runner names, returning `unsupported_runner` or `malformed_profile` on bad input), `resolveRunnerProfile` (applies precedence: `cli_override > goal_frontmatter > builtin_default`), and `safeRunnerProfileSummary`; wired the resolver into `goal-init.ts` so `goal start` validates the runner profile at init time and persists the resolved name to `goals.runner`; surfaced `runnerProfile` and `runnerProfileSource` on `goal start` JSON, `runnerProfile` on `status` JSON/text and `handoff` JSON/markdown, and a `runners` block on `doctor` JSON/text with `supported`, `default`, and `profiles` arrays; replaced the generic `init_error` code with specific stable codes (`parse_error`, `unsupported_runner`, `malformed_profile`, `init_failed`).
3. **NGX-281 — M4-02 RunnerAdapter boundary and fake-runner migration** *(done)*: added `src/runner-adapter.ts` with `RunnerAdapter`, `RunnerAdapterInput`, `RunnerAdapterResult`, and `RunnerAdapterError` types; an adapter registry (`ADAPTERS`) with `getRunnerAdapter`, `listRunnerAdapterKinds`, `listExecutingRunnerAdapterKinds`; `dispatchRunnerAdapter` validates input, resolves the adapter by kind, checks `executes`, and calls the adapter's `execute` method with a try/catch for `runner_threw`; the `fake` adapter wraps `runFakeRunner` behind the boundary with normalized output and diagnostics, while `trusted-shell` is a placeholder that returns `unsupported_runner`; `foreground-iteration.ts` replaces the direct `runFakeRunner` call and the hard-coded `spec.runner !== "fake"` guard with `dispatchRunnerAdapter`, preserving an early adapter-kind/executes validation before git operations; the queued `worker-run` → `iteration-job` → `foreground-iteration` path uses the same adapter dispatch; the fake runner profile now has `executes: true` and a description reflecting dispatch through the boundary; focused adapter tests cover the registry, dispatch contract, input validation, fake-runner integration, env threading, diagnostics, and error taxonomy.
4. **NGX-282 — M4-03 Trusted-shell runner profile** *(done)*: added `src/trusted-shell-config.ts` (typed `parseTrustedShellConfig` with stable `trusted_shell_config_missing` / `trusted_shell_config_invalid` codes, defaults `cwd=repo`, `timeout_sec=900`, `result_file=result.json`, and refusal of absolute, `..`-escaping, or directory-resolving result paths) and `src/trusted-shell-runner.ts` (spawns the configured executable plus argv via `spawnSync` with no shell, applies `env_allow` filtering with implicit `PATH` preservation, supports `cwd=repo|iteration`, records command/cwd/result metadata in `runner.log`, captures stdout/stderr with section headers after the command exits, and parses the normalized `RunnerResult` from the configured result file); promoted the trusted-shell `RunnerAdapter` from a placeholder to a real adapter with `executes: true`; flipped the `trusted-shell` runner profile to `executes: true` with an explicit-trust description; extended `runForegroundIteration` to reset the worktree to base HEAD when an executing adapter fails after attempting execution without moving HEAD, and to return manual-recovery reasons `runner_changed_head` when the runner advances HEAD or `head_mismatch` when finalization detects unexpected HEAD movement; broadened the `RunnerAdapterErrorCode` taxonomy with `result_missing`, `command_failed`, `command_timed_out`, `spawn_failed`, and `output_overflow`, while `runner_threw` now also covers runner-log open failures and `result_invalid` includes unreadable result files; added focused tests covering config parsing (22 cases), the runner module (16 cases including success, env_allow, cwd modes, timeout, command_failed, result_missing, malformed JSON, spawn ENOENT), the adapter registry / dispatch surface, and end-to-end foreground iteration paths (commit on success, reset on command_failed / timeout / result_missing / result_invalid / runner success=false).
5. **NGX-283 — M4-04 ACP/acpx runtime smoke runner** *(done)*: added `src/acp-config.ts` (typed `parseAcpConfig` with stable `acp_config_missing` / `acp_config_invalid` codes, defaults `cwd=repo`, `timeout_sec=900`, `result_file=result.json`, optional `probe` block with `command` / `args` / `timeout_sec` defaulting to 30s, and refusal of absolute or `..`-escaping result paths) and `src/acp-runner.ts` (pre-flight runtime-availability check on absolute `acp.command` paths, optional probe spawn run before the main command, shared `spawnSync` execution with no implicit shell, `env_allow` filtering with implicit `PATH` preservation, `cwd=repo|iteration`, MOMENTUM_* env vars, stdout/stderr capture after command exit, and normalized `RunnerResult` parsing from the configured result file); registered the `acp` adapter with `executes: true` in the `RunnerAdapter` registry alongside `fake` and `trusted-shell`; promoted the `acp` runner profile to `executes: true` with a description that calls out the `runtime_unavailable` taxonomy; threaded an optional `acp` block through `GoalSpec` and `rawFrontmatter`; broadened `RunnerAdapterErrorCode` with stable `runtime_unavailable` (runtime binary missing, probe binary missing, probe non-zero exit, probe timeout, or main spawn ENOENT) and `startup_failed` (main or probe non-ENOENT spawn errors) so missing prerequisites stay distinct from `command_failed` and from verification failures; added focused tests covering acp config parsing (29 cases) and the acp runner module (success, runner-reported failure, runtime_unavailable for missing binary / missing probe / non-zero probe exit, startup_failed for non-ENOENT spawn errors on both main and probe, command_failed, command_timed_out, result_missing, result_invalid, MOMENTUM_* env contract, env isolation, and probe-before-main ordering); preserved the M3 closeout marker on `doctor`.
6. **NGX-284 — M4-05 Runtime MOMENTUM.md policy loader** *(done)*: added `src/momentum-policy.ts` (typed `loadMomentumPolicy` / `parseMomentumPolicy` / `resolvePolicyEffectiveValues` with stable `policy_path_invalid` / `policy_file_unreadable` / `policy_parse_invalid` / `policy_schema_invalid` codes, a minimal schema of `runner`, `verification`, `verification_timeout_sec`, and a free-form notes body; a body-only file with no frontmatter is treated as notes with empty config); discovery is repo-root only — `MOMENTUM.md` at the resolved repo root is the only path the loader inspects (no parent traversal, no walk-up); missing files return `{ ok: true, present: false }` so existing goals without a policy file behave exactly as before. Precedence is CLI overrides > goal frontmatter > MOMENTUM.md > built-in defaults: `resolveRunnerProfile` now accepts a `policyValue` between goal frontmatter and the built-in default, and `resolvePolicyEffectiveValues` applies the same ordering to `verification` and `verification_timeout_sec`. `goal-init.ts` loads the policy whenever `spec.repo` is set and surfaces a `policy` summary on `GoalInitSuccess`. The iteration prompt renderer accepts optional `policyNotes` + `policyPath` and emits a `## Policy notes (from MOMENTUM.md)` section before the Rules section with an explicit reminder that "Policy notes are context, not executable overrides. Momentum safety contracts (no commits, no pushes, no staged changes) always win." `runForegroundIteration` loads policy from the verified `repoPath` and threads notes into the prompt. `goal start --json`, `status --json` / text, `handoff` JSON / markdown, and `doctor --json` / text all surface a `policy` block (`configured`, `present`, `path`, `hasNotes`, `config`, `error`); `doctor` accepts a new `--repo <path>` flag to inspect a repo's policy file in isolation. Focused tests cover loader behavior (missing / present / invalid frontmatter / invalid schema / repo-root-only discovery / inline-array verification), precedence resolution, prompt inclusion, goal-init integration (policy beats default; goal frontmatter beats policy; CLI override beats both; malformed policy surfaces `policy_schema_invalid`), `doctor --repo` policy surface, status/handoff policy surface, and a foreground-iteration sanity test that asserts the rendered prompt contains policy notes when the file is present and omits the section when absent.
7. **NGX-285 — M4-06 Real-runner status, logs, and recovery hardening** *(done)*: mapped real-runner adapter error codes to stable `ForegroundIterationErrorCode` values (`command_failed`, `command_timed_out`, `result_missing`, `result_invalid`, `runtime_unavailable`, `startup_failed`, `spawn_failed`, `output_overflow`) so `status` and other operator surfaces preserve command/runtime/result taxonomy instead of collapsing to a generic `runner_failed`; added `runnerResultError` and `parseError` to `handoff` JSON/markdown and `logs` output so malformed or missing runner result artifacts surface explicit operator-visible errors instead of silently returning null; added `resultJson` as a `GoalLogFile` with parse diagnostics to `logs --json` and text output; hardened `recovery.md` artifacts with a Runner/profile summary section (runner, command, args, cwd, timeout, result file) and prompt path; updated `stale-recovery.ts` `maybeWriteRecoveryArtifact` to include runner and prompt-path context; extended `ForegroundIterationErrorCode`, `RecoveryArtifactPathBundle`, `RecoveryArtifactInput`, `RecoveryArtifactRunnerProfile`, `GoalLogFile`, and `HandoffData` types; added focused tests covering every new error code through `status`, `logs`, `handoff`, `doctor`, CLI, worker-run, and recovery-artifact surfaces for both `trusted-shell` and `acp` adapter failures.
8. **NGX-286 — M4-07 M4 smoke, docs, and milestone closeout** *(done)*: added built-CLI smoke coverage for the trusted-shell happy path (`goal start --foreground` runs the configured command, commits the verified diff, and surfaces the iteration through `status`, `logs`, and `handoff`), the trusted-shell failure path (`command_failed` from a non-zero exit resets the worktree and preserves the stable error code through `status` and `logs`), and `MOMENTUM.md` precedence (the policy file's `runner` default loses to a CLI override and the policy notes thread into iteration prompts); flipped the `doctor` milestone string from the M3 closeout marker to `"Milestone 4: real runner profiles (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286) complete"`; updated README, AGENTS, and the M4 contract docs test to name Milestone 4 complete; and re-stated the post-M4 deferral set (external tracker writes, inbound webhooks, per-source-item worktrees, background runner supervision, dashboards/UI, strong sandboxing, cooperative mid-job cancellation, remote git operations).

The closeout marker for M4 is now `Milestone 4: real runner profiles (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286) complete` on `doctor --json` / text and is asserted by `test/cli.test.ts` and `test/m4-contract.test.ts`.

### M4 non-goals (explicit)

The following are **explicitly out of scope** for Milestone 4 and remain deferred regardless of how far M4 advances:

- **External tracker writes** — Linear/GitHub/Jira/etc. issue/PR creation, comments, status changes, label edits driven from Momentum.
- **Inbound webhooks** — adapters stay pull/reconcile first; Momentum does not expose an HTTP listener in M4.
- **Worktrees / per-source-item workspaces** — a Goal still uses one shared repo lease.
- **Background runner supervision** — forking, daemonization, restart-on-crash; the M3 single-process managed loop remains the supervision contract.
- **Dashboard or UI surface** — CLI JSON/text remains the only interface in M4.
- **Strong sandboxing** — `trusted-shell` and `acp` are exactly that: explicitly trusted. Container/VM/seccomp isolation is not part of M4.
- **Cooperative mid-job cancellation / signal handling** — stop semantics stay observation-only as in M3.
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.

### M3 contracts preserved

M4 did not break or rename any M3 surfaces. Specifically: the `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, the stale-lease detection / startup-recovery pass, the manual-recovery `recovery.md` artifact + flag, and the `status` / `handoff` / `doctor` daemon and recovery fields all remain wire-stable. The Milestone 3 daemon drain, graceful stop, stop-now, stale recovery, and manual recovery smoke coverage in `test/smoke.test.ts` continues to pass alongside the M4 smoke additions. NGX-286 intentionally flipped the `doctor` milestone string from the M3 closeout marker to the M4 closeout marker as part of M4 closeout; `test/cli.test.ts` and `test/m4-contract.test.ts` now assert the M4 marker.

## Milestone 5 Roadmap

Milestone 5 (Source Adapters and Evidence Sync) is the active milestone. M5 makes Momentum source-and-evidence aware while preserving the M4 runner contract and the M3 operational-safety surface. The first slice (NGX-287) is this contract/roadmap/docs setup; implementation slices follow it. M5 is **not** complete and the `doctor --json` milestone string remains the M4 closeout marker until M5-07 (NGX-294) intentionally flips it as part of M5 closeout.

### Milestone goal

Add the durable bridge between Goals and external work items: a `SourceAdapter` boundary, durable `SourceItem` records, reconciliation runs, evidence artifact ingestion, project rollups computed from local state, and policy-gated external update intents — all without performing automatic writes to external trackers. Read-only Linear reconciliation is the first real source adapter. External tracker writes are represented as durable intents only; applying them stays manual / operator-mediated in M5.

### M5 vocabulary

Durable concepts introduced or formalized by M5; none of them rename or replace the M3/M4 primitives:

- **SourceItem** — a normalized record drawn from an external system (Linear issue, GitHub PR/issue, Jira ticket) with stable identity fields (adapter kind, external id, external key, URL, title, status, metadata JSON, last observed timestamp, optional linked Goal id). A SourceItem is **context**, not the completion authority for any Goal.
- **SourceAdapter** — the read/list/get/normalize boundary for a source system, analogous to `RunnerAdapter`. Adapters do not own Goal/Iteration/Job state, do not perform external writes in M5, and do not touch git.
- **source snapshot** — the durable raw state captured for a SourceItem at a point in time. Snapshots feed reconciliation and provide an audit trail for drift detection.
- **reconciliation run** — a single invocation of a source adapter that records started/finished timestamps, adapter kind, input filters, and observed / created / updated / skipped / error counts plus per-item error metadata.
- **evidence artifact** — a normalized record of execution evidence (plan files, ledgers, no-mistakes outputs, PR links, merge evidence, verification summaries) attached to Goals and/or SourceItems with stable identity, type, path/URL, source, timestamp, summary, and metadata JSON. Ingestion is idempotent.
- **external update intent** — a durable, auditable record of a desired external write (state change, comment, label edit, project update) targeting a specific adapter and external id. Intents include payload JSON, reason, linked Goal / SourceItem / evidence ids, status, created / applied / skipped timestamps, and error metadata. **M5 does not apply intents automatically.**
- **project rollup** — a deterministic local computation grouping SourceItems by observed state, linked Goal state, evidence freshness, reconciliation freshness, and pending update intents, with explicit drift / mismatch surfacing.

### M5 trust boundary

M5 keeps Momentum's existing trust posture and tightens the source/intent surface:

- Source adapters are **read-only** in M5. They read external state and write only to Momentum's local durable tables (snapshots, SourceItems, reconciliation runs).
- External writes are represented as durable, policy-gated **external update intents**. Generating an intent is **not** the same as applying it; Momentum does **not** perform automatic external writes in M5. Applying an intent is operator-mediated through CLI or an explicitly approved workflow step.
- Credentials never enter Momentum durable state or docs. Source adapters accept credential paths / env vars through operator-controlled config only.
- Evidence ingestion reads local artifacts under operator-controlled paths (such as `.agent-workflows/`); Momentum does not scrape chat or external systems for evidence.
- Iteration prompts may carry source / evidence context, but policy notes from `MOMENTUM.md` and source context are **context-only**: they cannot override Momentum safety contracts (no commits, no pushes, no staged changes, runner / verification / git transaction boundaries).

### M5 composition with existing contracts

M5 composes with the M1–M4 surfaces without breaking them:

- **Goal / Iteration / Job** remain the durable execution units. SourceItems link **into** Goals (optional linkage); the Goal is still the completion authority.
- **RunnerAdapter** and the existing runner profiles (`fake`, `trusted-shell`, `acp`) keep their M4 contract; source / evidence context is threaded through prompt rendering only, not the adapter input shape.
- **daemon** start / stop / status, the managed loop, stop / stop-now semantics, and stale-lease recovery from M3 remain wire-stable. Reconciliation runs and evidence ingestion are explicit CLI operations, not daemon-loop side effects.
- **recovery** flags, `recovery.md`, and `recovery clear` from M3/M4 stay unchanged; M5 does not auto-clear manual recovery and does not generate new recovery codes from source / evidence ingestion.
- **handoff** JSON / markdown grows new optional fields for linked source context, recent reconciliation summary, evidence summaries, and pending update intents. Existing M2–M4 fields are preserved.
- **MOMENTUM.md** stays the canonical repo policy file. M5 may add optional `source` / `evidence` / `intents` policy keys but defaults remain conservative (read-only sources, intent-create-only, no auto-apply).

### Planned M5 issue order

The Linear milestone "Milestone 5: Source Adapters And Evidence Sync" sequences the work as:

1. **NGX-287 — M5-00 M5 contract, roadmap, and docs setup** *(this slice)*: define vocabulary, trust boundary, planned issue order, non-goals, and how M5 composes with M3/M4 contracts; do not modify execution surfaces.
2. **NGX-288 — M5-01 SourceItem state model and adapter boundary**: durable SourceItem / snapshot / reconciliation-run schema, `SourceAdapter` interface and registry, a built-in `local-fixture` adapter for tests, and SourceItem visibility in Goal status / handoff JSON where data exists.
3. **NGX-289 — M5-02 Linear source adapter read and reconciliation**: first real source adapter — read-only Linear reconciliation for configured project / milestone / issues, normalized SourceItem records, a `source reconcile linear` CLI, and durable reconciliation-run summaries.
4. **NGX-290 — M5-03 Goal/source linkage and planning context**: CLI to link / initialize Goals from SourceItems, threading source context into iteration prompt rendering as context-only input, and linked-source visibility through `goal start --json`, `status`, `logs`, `handoff`, and `doctor` where relevant.
5. **NGX-291 — M5-04 Workflow evidence artifact ingestion**: durable evidence schema, idempotent ingestion CLI (`evidence ingest`), and evidence visibility through `status` / `handoff` / `logs` / `doctor`.
6. **NGX-292 — M5-05 Project rollup and status surfaces**: deterministic local rollup logic, a `project status` CLI, and explicit drift / mismatch surfacing computed from local state only.
7. **NGX-293 — M5-06 Policy-gated external update intents**: durable update-intent schema, intent generation from local reconciliation / evidence outcomes, CLI to list / inspect / approve / mark-applied / skip / cancel intents, and `MOMENTUM.md`-gated policy with intent-create-only default.
8. **NGX-294 — M5-07 M5 smoke, docs, and milestone closeout**: built-CLI smoke coverage for reconciliation, linkage, evidence ingestion, project rollup, and update intents; README / AGENTS marker alignment; flip the `doctor --json` milestone string to the M5 closeout marker; restate the explicit M6 / post-M5 deferral set.

### M5 non-goals (explicit)

The following are **explicitly out of scope** for Milestone 5 and remain deferred regardless of how far M5 advances:

- **Automatic external tracker writes** — Linear / GitHub / Jira / etc. issue / PR creation, comments, status changes, label edits driven automatically from Momentum. M5 generates durable intents only.
- **Inbound webhooks** — source adapters stay pull / reconcile first; Momentum does not expose an HTTP listener in M5.
- **Dashboard or UI surface** — CLI JSON / text remains the only interface in M5.
- **Per-source-item worktrees** / parallel same-repo Goals — a Goal still uses one shared repo lease.
- **Background runner supervision** — forking, daemonization, restart-on-crash; the M3 single-process managed loop remains the supervision contract.
- **Strong sandboxing** — `trusted-shell` and `acp` remain explicitly trusted; container / VM / seccomp isolation is not part of M5.
- **Cooperative mid-job cancellation / signal handling** — stop semantics stay observation-only as in M3.
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.

### M3 and M4 contracts preserved

M5 must not break or rename any M3 or M4 surfaces. Specifically: the `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, stale-lease detection and startup-recovery, the manual-recovery `recovery.md` artifact + flag, the `RunnerAdapter` boundary and the `fake` / `trusted-shell` / `acp` runner profiles, the runtime `MOMENTUM.md` policy loader and its precedence rules, and the `status` / `handoff` / `doctor` daemon, recovery, runner, and policy fields all remain wire-stable. The `doctor` milestone string stays at the M4 closeout marker until NGX-294 (M5-07) intentionally flips it.

## Current Exclusions

Milestone 3 is complete. Milestone 4 has absorbed runner profiles and runtime `MOMENTUM.md` policy loading (see the Milestone 4 Roadmap above). Milestone 5 adds read-only source reconciliation, local evidence ingestion, project rollups, and durable external-update intents. The following remain deferred so the runner-boundary, policy-loading, and M5 read-first source surfaces stay scoped:

- **Background runner supervision.** NGX-272 landed `daemon start` / `daemon stop` / `daemon status` as orchestrator-state contracts; NGX-273 wired an opt-in managed loop on `daemon start` that drains queued goal iterations in-process by composing `runWorkerOnce`. Background detachment / supervision (forking, daemonization, restart-on-crash) remains out of scope.
- **Cooperative shutdown.** NGX-274 surfaces the daemon stop-request state in `status --json` / text and `handoff` JSON / markdown so operators can see why work is not draining without running `daemon status` separately; the daemon loop test suite covers stop-between-jobs observation. NGX-275 adds `daemon stop --now` as an immediate stop request observed between daemon-loop cycles, with a `canceled` terminal state and cancel-outcome visibility. Stop commands still do not signal, kill, or otherwise terminate any running runner, worker, or external process; mid-job cancellation and a full cooperative-shutdown handshake are deferred.
- **Manual recovery beyond safe local cases.** Automatic stale-lease recovery landed in NGX-276: the managed `daemon start` loop runs a one-shot startup-recovery pass that auto-releases stale repo locks owned by terminal jobs, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale `daemon_runs` rows; dirty / active / ambiguous cases (`job_running`, `daemon_active`, `lock_active`, `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_state_changed`, `active_job_present`, `active_lock_present`, `self`, `run_state_changed`) are surfaced through a stable skip taxonomy. NGX-277 adds the manual-recovery path for blocked stale claims, and M4 also uses it for iteration-time HEAD movement: `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`, `runner_changed_head`, and `head_mismatch` write `recovery.md`, set `needs_manual_recovery`, block future queue claims, and remain visible through `status`, `handoff`, `daemon status`, and `doctor` until an operator runs `recovery clear`.
- `worker run` remains a single-shot consumer that processes one claimed job per invocation and then exits; the NGX-273 managed loop is the bounded continuous-draining path on `daemon start`.
- Worktree management, per-source-item worktrees/workspaces, remote git operations (`fetch`, `pull`, `push`, `rebase`), and parallel same-repo Goals.
- Automatic PR/GitHub/Linear automation, external tracker writes, inbound webhooks, and other external integrations driven from inside Momentum. M5 may read configured sources and generate durable update intents, but it must not apply external writes automatically.
- A dashboard or other UI surface beyond the CLI JSON/text outputs.
- **Strong sandboxing** (container / VM / seccomp isolation); M4's `trusted-shell` and `acp` runners are explicitly trusted, not sandboxed.
