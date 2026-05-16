# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is complete. Milestone 2 (Queue and Worker Model) is complete, with NGX-235, NGX-236, NGX-237, NGX-238, NGX-239, NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, and NGX-250 implemented and verified. NGX-249 is M2-05 completion reducer and idempotent chaining (`reduceGoalIteration` classifies terminal `goal_iteration` jobs as `continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`; updates `goals.state` / `current_iteration` / `completion_reason`; enqueues next iterations with stable idempotency keys; emits `goal.reduced` + `goal.completed` / `goal.failed`; surfaces reducer state, next job, and next-action via `status`/`handoff`; and runs after each completed queued job). NGX-250 pins the Milestone 2 CLI contract around queued status/handoff fields, local log inspection, queued smoke coverage, and user-facing docs. Milestone 2 also includes queued-path execution without a long-lived daemon, stable single-shot worker behavior, and explicit artifact pointers on job success/failure.

Milestone 3 (Operational Safety) is complete. NGX-272 landed as the first M3 slice (M3-01 orchestrator state model and daemon CLI contract): durable `daemon_runs` schema, `daemon start` / `daemon stop` / `daemon status` subcommands, and a daemon-readiness block on `doctor --json`. NGX-273 landed as the second M3 slice (M3-02 managed daemon loop for queued jobs): a `runDaemonLoop` primitive that composes `runWorkerOnce` with deterministic idle backoff, heartbeat / active-job / reconciliation updates per cycle, and `stop_requested` shutdown handling; opt-in bounded-loop flags (`--max-loop-iterations`, `--max-idle-cycles`, `--poll-interval-ms`) wire that loop into `momentum daemon start` so a queued goal can be drained without manually invoking `worker run` repeatedly. NGX-274 landed as the third M3 slice (M3-03 graceful daemon stop visibility): `status --json` / text and `handoff` JSON / markdown surface the daemon stop-request state (`daemon.runId`, `daemon.state`, `daemon.isActive`, `daemon.isTerminal`, `daemon.stopRequest`) so operators can see why work is not draining without running `daemon status` separately; a focused daemon-loop test covers stop-before-next-claim with a reducer-enqueued follow-up iteration. NGX-275 landed as the fourth M3 slice (M3-04 immediate daemon stop-now cancellation): `daemon stop --now` records an immediate-stop request, the managed loop exits as `canceled` between cycles, and `status`, `handoff`, and `daemon status` surface stop-now and cancel-outcome details. NGX-276 landed as the fifth M3 slice (M3-05 stale-lease detection and safe auto-recovery): stale repo locks, claimed/running `goal_iteration` jobs, and idle daemon records are detected deterministically and surfaced through `daemon status`, `doctor`, `worker run`, `status --json`, and `handoff`; the managed-loop `daemon start` runs a one-shot `runStartupRecovery` pre-loop pass that auto-releases repo locks whose owning job is already terminal, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale daemon rows, while routing dirty/active states (`job_running`, `daemon_active`, `lock_active`, `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_state_changed`, `active_job_present`, `active_lock_present`, `self`, `run_state_changed`) through a stable skip taxonomy so operators can drive manual recovery without re-classifying. NGX-277 landed as the sixth M3 slice (M3-06 manual recovery artifacts, durable goal-level `needs_manual_recovery` flag, blocked-claim guard, `recovery clear` CLI, and cross-CLI visibility): manual-recovery skip reasons write goal-scoped `recovery.md` evidence and set a durable flag that blocks future claims until an operator acknowledges it with `momentum recovery clear`. NGX-278 landed as the seventh M3 slice (M3-07 milestone closeout): built-CLI smoke coverage for the daemon drain, graceful stop, stop-now/cancel, safe stale recovery, and manual recovery artifact visibility paths; doctor / README / AGENTS marker alignment naming M3 complete; and an explicit list of cross-milestone deferrals so the operational-safety surface is pinned. Future milestones own cooperative mid-job shutdown semantics (signal-based termination, mid-job cancellation handshake), background detachment / supervision (forking, daemonization, restart-on-crash), per-source-item worktrees / parallel same-repo Goals, remote git operations (`fetch` / `pull` / `push` / `rebase`), PR/GitHub/Linear/external-tracker automation, inbound webhooks, a dashboard or UI surface, and strong sandboxing (container / VM / seccomp); these are out of scope until a future milestone explicitly justifies them. Real runner profiles and a runtime `MOMENTUM.md` policy loader are now in M4 scope. Momentum's core primitive is a durable `Goal`; external issues/projects are source items that seed context and reconciliation, not the source of truth for completion. Goal completion is determined by the Goal's Markdown acceptance criteria plus runner, verification, and handoff evidence. Tracker writes are adapter-mediated and policy-gated: core records durable facts and external-update intents, while Linear/GitHub/Jira/etc. adapters or approved workflow steps perform external writes. Source adapters are pull/reconcile first in M3; inbound webhooks are deferred. A Goal uses one shared repo/workspace lease for now; per-source-item worktrees/workspaces are deferred until a future milestone explicitly justifies them.

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
momentum doctor [--data-dir <path>] [--json]
```

The `daemon` subcommands record orchestrator-run state in SQLite (`daemon_runs`) and expose an inspection contract. They are scoped to the completed Milestone 3 operational-safety slices (NGX-272 through NGX-278): without any loop-bound flags, `daemon start` registers a new orchestrator run and returns immediately (preserving the NGX-272 register-only contract); passing `--max-loop-iterations` or `--max-idle-cycles` opts into the NGX-273 managed loop and drains queued goal iterations in-process until a bound, `stop_requested`, `stop_now_requested`, or a terminal daemon-run state is reached. `--poll-interval-ms` tunes that bounded loop and must be paired with a loop bound. `daemon stop` records a graceful stop request that the managed loop observes between cycles; `daemon stop --now` records an immediate-stop request that causes the loop to finalize the run as `canceled` rather than `stopped`. Neither command kills any external runner, worker, or process. The managed loop runs a one-shot NGX-276 startup-recovery pass before its first cycle, auto-releases stale repo locks whose owning job is terminal, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale `daemon_runs` rows; dirty / active / ambiguous cases are reported on the response under a stable skip taxonomy so operators can drive manual recovery deliberately. Manual-recovery skip reasons (`repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`) and iteration-time HEAD movement (`runner_changed_head`, `head_mismatch`) also write a `recovery.md` artifact for the goal and set a `needs_manual_recovery` flag that blocks future queue claims until an operator explicitly clears it via `momentum recovery clear`. NGX-278 closes M3 by pinning built-CLI smoke coverage for the daemon drain, graceful stop, stop-now, safe stale recovery, and manual-recovery visibility paths plus the public M3-complete markers.

`goal start --foreground` parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events`, `repo_locks` tables), creates the artifact layout, and runs one foreground iteration: it inspects the target repo, captures the pre-iteration HEAD, creates or reuses a Momentum branch, renders the iteration prompt, invokes the configured executing runner profile (`fake` or `trusted-shell`), runs each verification command from the repo root, and either stages and commits the full repo diff as one Momentum commit on verified success or hard-resets the worktree back to the pre-iteration HEAD on runner failure or verification failure when HEAD has not moved. If a runner or finalization step moves HEAD outside Momentum's transaction, Momentum leaves the repo unchanged; the public foreground JSON failure envelope reports only `iteration.code` / `iteration.error`, while durable manual-recovery evidence is written to `recovery.md` and surfaced through `status` and `handoff`. The iteration writes `prompt.md`, `runner.log`, `verification.log`, and a runner result JSON file under `iterations/<n>/` (`result.json` by default). On a verified commit the goal transitions to `iteration_complete` (or `completed` if the runner reports `goal_complete: true`); on runner failure, verification failure, or any pipeline error it transitions to `failed`. `status [goal-id] --json` reads the SQLite/artifact state and emits a stable JSON shape including reducer state, next job, and next-action hints, and `handoff <goal-id> --json` writes `handoff.md` and `handoff.json` (schema v1) into the goal's artifact dir.

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

The `pnpm test` suite includes a built-binary end-to-end smoke (`test/smoke.test.ts`) that builds `dist/` via `pnpm build`, initializes disposable git repos under the OS temp dir, drives core CLI commands through the spawned binary, and asserts: the default queued enqueue path (no runner execution, idempotent re-enqueue, and queued job/event SQLite state); the foreground success path (exactly one Momentum commit on the Momentum branch with the verification log, handoff artifacts, and SQLite database in place); the foreground verification-failure reset path (worktree clean and HEAD back at base after `false` verification); the queued logs inspection path; the queued `worker run` success / verification-failure / runner-failure paths, including reducer event chains and artifact surfaces; and the M3 daemon/recovery paths for managed drain, graceful stop, stop-now cancellation, safe stale recovery, and manual recovery artifact visibility via `daemon start`, `daemon stop`, `daemon status`, `status`, `logs`, `handoff`, and `recovery clear`.

## Goal Spec

Goal files are Markdown that begin with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, `verification_timeout_sec`, and `trusted_shell` are optional. Defaults are `runner: fake`, `branch: momentum/<title-slug>`, `max_iterations: 1`, `verification: []`, and `verification_timeout_sec: 900`. `max_iterations` and `verification_timeout_sec` must be positive integers. If `branch` is omitted, `title` must contain letters or numbers so Momentum can derive `momentum/<title-slug>`. The `runner` field accepts built-in runner profile names (`fake`, `trusted-shell`); unknown names are rejected at init time. `trusted_shell` is required for trusted-shell execution and ignored by the fake runner; queued initialization can persist a trusted-shell goal before the worker validates missing or malformed trusted-shell config at execution time. The `--runner` CLI flag overrides the frontmatter value, and built-in default resolution precedence is `--runner` CLI flag > goal frontmatter `runner` > `fake` (the built-in default). In the default queued path, relative `repo` values are resolved to absolute paths before being persisted or emitted.

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

Failure modes return stable diagnostic codes through the `RunnerAdapter` boundary: `invalid_input` (missing/malformed config), `runner_threw` (runner log could not be opened), `spawn_failed` (spawn errors such as a missing binary), `command_failed` (non-zero exit), `command_timed_out` (exceeded `timeout_sec`), `result_missing` (no result file written), `result_invalid` (unreadable, malformed, or non-conforming result JSON), and `output_overflow` (stdout/stderr exceeded the 256 MiB capture limit). The foreground and queued iteration surfaces wrap these adapter failures as `runner_failed` in `iteration.code` / job errors, with the adapter diagnostic included in the error text and logs. Post-execution adapter failures reset the worktree to base HEAD only when the runner has not moved HEAD; if HEAD changed, Momentum returns `runner_changed_head` and leaves the repo for manual recovery rather than dropping runner-created commits.

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
    "nextAction": "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job."
  }
  ```

  Init-time validation rejects unsupported runner profiles before touching the database or repo. The `code` field on failure envelopes is one of `parse_error` (malformed goal spec or unreadable file), `unsupported_runner` (unknown runner name), `malformed_profile` (blank or non-string runner value), or `init_failed` (data directory or database failure).

- **`--foreground` (Milestone 1 inline path):** drives a single foreground iteration through the configured executing runner profile and Momentum-owned verification immediately, returning the iteration outcome on the same invocation. Both `fake` and `trusted-shell` execute through the shared `RunnerAdapter` boundary; unknown or non-executing profiles fail with `unsupported_runner`. The foreground envelope also includes `runner` and `runnerProfile` / `runnerProfileSource` fields. JSON envelope shape:

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
    }
  }
  ```

Re-running `goal start` with the same goal spec against the same data directory resumes the existing goal instead of creating duplicate state in either mode. Text output begins with `Goal resumed`; JSON output sets `resumed: true`.

### `status`

```text
momentum status [goal-id] [--data-dir <path>] [--json]
```

Reads SQLite plus artifact state and reports the goal's current state, configured repo and runner, resolved runner profile, latest job, latest iteration summary (including the verified commit SHA when present), reducer decision (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), the next queued job (if any), a next-action hint, and the daemon run summary. JSON output includes `runnerProfile` (`{kind, name, description, executes}` or `null` when the stored runner name is not a built-in kind), `goalState`, `artifacts`, `currentIterationDetail`, `nextActionDetail`, `latestCommitSha`, `daemon`, and `staleRecovery`; `latestJob` / `nextJob` include `idempotencyKey`, result/error paths, and lease timestamps. The `artifacts` block includes `recoveryMd` (path and exists status) showing whether a `recovery.md` artifact is present for the goal. The `daemon` field is `null` when no daemon run has ever been recorded for the data directory; otherwise it contains `runId`, `state`, `isActive`, `isTerminal`, `startedAt`, `heartbeatAt`, `finishedAt`, `activeJob` (`{jobId, lockId}`), `stopRequest` (`{requestedAt, reason}` or `null`), `stopNowRequest` (`{requestedAt, reason}` or `null`), and `cancelOutcome` (`{outcome}` or `null`). The `staleRecovery` field is goal-scoped and exposes `recoveredRepoLockCount`, `recoveredJobCount`, `latestRecoveredRepoLockAt`, `latestRecoveredJobAt` (counts and most-recent timestamps for `repo_lock.recovered` and `job.recovered` events recorded for this goal), `staleRepoLockCount`, `staleClaimedJobCount` (current goal-scoped records whose lease has expired and may need recovery), and `staleLeaseGraceMs` (5s default skew tolerance). Text output includes `Runner: <name>`, includes `Runner profile: <name> (executes=true|false)` when the stored runner name is a built-in kind, and includes an always-emitted `Recovery: present|missing (<path>)` line for the goal-scoped `recovery.md` artifact, plus a `Daemon:` line with state, active/terminal flags, and run ID; if present, `Daemon stop requested:`, `Daemon stop-now requested:`, and `Daemon cancel outcome:` lines show stop/cancel details, and a `Stale recovery:` line appears when any recovered or pending stale counts are non-zero. Omitting `goal-id` selects the most recently updated goal in the data directory; when no goals exist the command exits non-zero with `code: "no_goals"`.

### `logs`

```text
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
```

Reads local iteration artifacts for a goal and emits `runner.log` and `verification.log` content. Without `--iteration`, selects the highest-numbered iteration directory under `goals/<goal-id>/iterations/` (or `goals.current_iteration` when present), so a freshly-initialized goal returns iteration `1` with empty logs. With `--iteration <n>`, reads that iteration's artifact dir and exits non-zero with `code: "iteration_not_found"` if it doesn't exist. `--iteration` must be a positive integer; non-positive values fail with `code: "usage_error"`. The command only reads on-disk artifacts; it does not consult live worker state. JSON output exposes `availableIterations` plus per-log `{path, exists, readable, bytes, content, error}` so downstream tooling can navigate prior iterations and distinguish missing logs from unreadable ones.

### `handoff`

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

Renders `handoff.md` and `handoff.json` (schema v1) into the goal's artifact directory from the same state `status` reads. The handoff includes reducer decision and next-job details, a next-action hint describing what to do next, and a daemon run summary. The JSON artifact includes `goal_state`, `goal` (with `runner` and `runner_profile` — `{kind, name, description, executes}` or `null` when the stored runner name is not a built-in kind), `current_iteration_detail`, `next_action_detail`, `latest_commit_sha`, `daemon`, `stale_recovery`, and `latest_job` / `next_job` fields with idempotency keys, result/error paths, and lease timestamps. The `artifacts` block includes `recovery_md` showing the path to the goal-scoped `recovery.md` file, and `artifact_files` includes `recovery_md` as a boolean indicating whether the file exists on disk. The markdown includes `Runner: <name>`, includes `Runner profile: <name> (executes=true|false)` when the stored runner name is a built-in kind, and includes `recovery.md` in the artifact list; when present it shows `(present)`, when absent it shows `(missing)`. The `daemon` field is `null` when no daemon has ever run; otherwise it contains `run_id`, `state`, `is_active`, `is_terminal`, `started_at`, `heartbeat_at`, `finished_at`, `active_job` (`{job_id, lock_id}`), `stop_request` (`{requested_at, reason}` or `null`), `stop_now_request` (`{requested_at, reason}` or `null`), and `cancel_outcome` (`{outcome}` or `null`). The `stale_recovery` field is goal-scoped (`recovered_repo_lock_count`, `recovered_job_count`, `latest_recovered_repo_lock_at`, `latest_recovered_job_at`, `stale_repo_lock_count`, `stale_claimed_job_count`, `stale_lease_grace_ms`) so prior auto-recovery actions and currently stale goal-scoped records are visible alongside the handoff. The markdown includes a `## Daemon` section showing the run ID, state, stop request, stop-now request, cancel outcome, active job, and finished time, plus a `## Stale recovery` section that renders the recovery counts and latest timestamps (or a no-activity sentinel when none).

### `worker run`

```text
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
```

Consumes queued `goal_iteration` work in single-job batches:

- Claims the oldest pending `goal_iteration` job and stamps `worker` / `lease` metadata.
- Acquires a repo lock for the goal repo before launching the iteration.
- Refreshes lease metadata with a heartbeat before execution.
- Executes the claimed `goal_iteration` through the same `finalizeIteration` transaction as the foreground path: runner → Momentum-owned verification → commit on verified success, hard reset to `baseHead` on runner/verification/commit failure when HEAD is still at the expected base, or manual recovery when HEAD moved outside Momentum's transaction.
- Persists `jobs.result_path` to the runner-reported result JSON path on success (`iterations/<n>/result.json` by default; `trusted-shell` may use another `trusted_shell.result_file` inside the iteration directory) and `jobs.error_path` to `iterations/<n>/verification.log` (or `runner.log` for pre-runner failures) on failure.
- Emits `job.succeeded` with commit + artifact pointers (`commit_sha`, `commit_message`, `branch`, `branch_created`, `base_head`, `goal_complete`, `result_path`, and an `artifacts` block with `iteration_dir` / `prompt` / `runner_log` / `verification_log` / `result_json`). On the failure path, `job.failed` emits the summarized error and a narrower `artifacts` block with `iteration_dir` / `runner_log` / `verification_log`.
- After the job completes, runs the completion reducer (`reduceGoalIteration`), which classifies the terminal job as `continue` (enqueue next iteration), `goal_complete` (mark goal completed), `max_iterations_reached` (mark goal terminal), or `iteration_failed` (mark goal failed). The reducer is idempotent: re-invoking it on the same job short-circuits to `already_reduced` without duplicating events or enqueueing duplicate work. If the reducer throws, the worker emits a defensive `goal.reduce_failed` event with the error message and surfaces `reducerError` on the `worker run` result so the job's commit/reset is preserved for inspection and manual recovery.
- On `continue`, enqueues one next `goal_iteration` job with idempotency key `goal:<id>:iteration:<n>`, bumps the goal to state `queued`, and emits `goal.reduced`. On `goal_complete`, sets the goal to `completed` and emits `goal.reduced` + `goal.completed`. On `max_iterations_reached` or `iteration_failed`, sets the goal to the corresponding terminal state and emits `goal.reduced` + `goal.failed`.
- Releases the repo lock with the appropriate `recovery_status` and emits a deterministic CLI JSON result (`code: no_work | not_executed | ran_job`) for automation; if the iteration returns manual-recovery metadata (`runner_changed_head` / `head_mismatch`), the lock is marked `needs_manual_recovery` and continues blocking claims until `recovery clear` releases it.

Queued jobs execute the runner profile stored on the Goal row. Both foreground and queued paths dispatch through the `RunnerAdapter` boundary (NGX-281); only runners with `executes: true` in the adapter registry can be invoked. After NGX-282, both `fake` and `trusted-shell` are executing runners; `trusted-shell` runs an operator-trusted executable plus argv in the target repo by default (or the iteration artifact directory with `trusted_shell.cwd: iteration`) with no sandbox and reports a normalized `RunnerResult` via a configured result file.

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
momentum doctor [--data-dir <path>] [--json]
```

Reports CLI version, Node.js version, platform, the current milestone scope label, and a compact daemon-readiness block read from `daemon_runs` (`{ok, dataDir, hasRun, state, isActive, stale, staleRunCount, staleRepoLockCount, staleClaimedJobCount, goalsNeedingRecoveryCount, runId}` on success, `{ok: false, code, message}` on failure). The stale-lease counts surface orphaned repo locks and claimed/running jobs whose lease expired more than `staleLeaseGraceMs` ago. The `goalsNeedingRecoveryCount` surface shows how many goals currently have the durable `needs_manual_recovery` flag set in the selected data directory; pass `--data-dir <path>` to inspect a non-default Momentum home. The `runners` block in JSON output lists `supported` (the current set of built-in runner profile names, `["fake", "trusted-shell"]`), `default` (the built-in default runner kind, `"fake"`), and `profiles` (an array of `{kind, name, description, executes}` objects for each built-in runner). Both the `fake` and `trusted-shell` profiles now have `executes: true`; `trusted-shell` runs the operator-configured executable plus argv with no sandbox and no privilege drop. Text output includes a `runners:` line showing the supported kinds and default. Useful as a first sanity check after install and as a quick orchestrator-health probe.

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
- Paths to relevant iteration artifacts (runner log, verification log, result JSON)
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
      recovery.md               # Populated when a goal is flagged for manual recovery
      iterations/
        <n>/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner metadata and captured stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Default runner result envelope; trusted-shell may report another in-dir result file
```

`goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and the first iteration artifact files are created up-front during goal initialization; `handoff.md`, `prompt.md`, `runner.log`, and `verification.log` start empty, while `handoff.json` and the default `result.json` start as `{}`. `goal start --foreground` populates the iteration artifacts during inline execution. In the queued path, iteration 1 starts with placeholders; later iteration directories and jobs are created by the reducer, and their artifact files are materialized when `momentum worker run` claims and executes that iteration.

## Failure and Reset Semantics

Momentum treats each iteration as a transaction over the target repo. The pre-iteration HEAD on the Momentum branch is captured as `baseHead` before the runner runs. From there, exactly one of these outcomes applies:

| Outcome | Trigger | Repo effect | Goal state (foreground) | Goal state (queued, via reducer) | JSON error code |
|---|---|---|---|---|---|
| `committed` | Runner success and all verification commands exit 0 | One commit on the Momentum branch with the full staged repo diff | `iteration_complete` (or `completed` if runner sets `goal_complete: true`) | `queued` (continue, next iteration enqueued), `completed` (goal_complete), or `max_iterations_reached` | n/a (`ok: true`) |
| `reset_runner_failure` | Runner reports `success: false` | Hard reset to `baseHead`; verification is skipped and a note is written to `verification.log` | `failed` | `failed` (iteration_failed) | `runner_reported_failure` |
| `reset_verification_failure` | Any verification command exits non-zero | Hard reset to `baseHead` | `failed` | `failed` (iteration_failed) | `verification_failed` |
| `commit_failed` | Verification passed but `git commit` failed | Best-effort hard reset to `baseHead`; if the reset also fails the JSON error code becomes `reset_failed` | `failed` | `failed` (iteration_failed) | `commit_failed` (or `reset_failed`) |
| `reset_failed` | The reset itself failed after a runner or verification failure | Repo may still have uncommitted changes; requires manual inspection | `failed` | `failed` | `reset_failed` |
| `manual_recovery` | Runner advanced HEAD (`runner_changed_head`) or commit/reset saw HEAD no longer at `baseHead` (`head_mismatch`) | Repo is left unchanged so Momentum does not drop non-Momentum commits; both foreground and queued paths write `recovery.md` and set `needs_manual_recovery`; queued workers also keep the repo lock blocking until `recovery clear` | `failed` | `failed` (claims blocked until cleared) | `runner_changed_head`, or `commit_failed` / `reset_failed` with manual-recovery reason `head_mismatch` |

Other early-pipeline errors surface as their own codes (`invalid_input`, `missing_repo`, `unsupported_runner`, `repo_guard_failed`, `branch_manager_failed`, `artifact_write_failed`, `git_failed`, `unexpected_error`) and do not produce a commit. Verification output is captured to `verification.log` with `[verify]` prefixes; the on-disk buffer is capped so a runaway command cannot fill the data directory.

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
- **RunnerAdapter**: the boundary for invoking an agent runner (currently `fake` and `trusted-shell`; later Codex, Claude, OpenCode, ACP/app-server backends).
- **Workflow / Policy**: repo-owned configuration and prompt contract, the future `MOMENTUM.md`.
- **Workspace / Repo Lease**: the shared per-Goal repo lock that protects the working tree during an iteration.
- **Event**: append-only record on the durable event log (`job.enqueued`, `job.claimed`, `job.heartbeat`, `iteration_*`, `job.succeeded`/`job.failed`, `repo_lock.recovered`, `job.recovered`, `goal.reduced`, `goal.completed`/`goal.failed`, `goal.reduce_failed`, `goal.recovery_cleared`).
- **Handoff**: the `handoff.md` + `handoff.json` artifacts that snapshot state for continuity.

### Locked decisions

- Momentum's core product primitive is `Goal`, not `Issue`. A Goal may be seeded from one or more source items; Linear projects/issues are one source shape, not the source of truth.
- Goal completion is decided by the Goal Markdown acceptance criteria plus runner, verification, and handoff evidence, not by source-item count or external tracker state alone.
- Tracker writes are **adapter-mediated and policy-gated**. Momentum core records durable facts and emits external-update intents; Linear/GitHub/Jira/etc. adapters or approved workflow steps perform the external writes.
- Source adapters are **pull / reconcile first** in M3. No inbound webhook infrastructure in the operational-safety milestone.
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

Milestone 4 (Real Runner Profiles) is the **active milestone** following the operational-safety closeout. It is **not complete**. The headline goal is to put real, observable runner profiles behind the existing Goal/Iteration/verification/handoff contract, then add a runtime `MOMENTUM.md` policy loader, while keeping external tracker automation deferred.

### Milestone goal

Land a `RunnerAdapter` boundary so Momentum can execute Goals through more than the in-process `fake` runner without changing the Goal/Iteration/Job contract or the M3 daemon/recovery surfaces. The first real profile is a `trusted-shell` runner; one live ACP/acpx-style runtime is admitted as the smoke path if available locally. Runtime `MOMENTUM.md` policy loading lands second so repo-owned policy can gate runner choice and verification. External tracker automation (Linear/GitHub/Jira writes, webhooks) remains deferred and is **not** part of M4.

### Architecture decision: core vs runner adapters

- **Momentum core** owns the durable Goal/Iteration/Job state machine, Momentum-owned verification, the git transaction (commit/reset on the Momentum branch), the on-disk artifact layout, and the queue/daemon/recovery surfaces shipped in M2 and M3.
- **`RunnerAdapter` implementations** execute the iteration prompt against an external runtime (shell, agent, ACP backend), capture runner output in the adapter-specific manner and write it to `runner.log`, and report a normalized `RunnerResult` containing `success`, `summary`, change/learning/work arrays, `goal_complete`, and commit intent. Adapters do not touch git, do not own verification, do not own the queue, and do not write to external trackers.
- The boundary stays single-process and trust-explicit for v0; sandbox/isolation hardening is out of scope for M4.

### Initial supported runner family

- `fake`: existing in-process runner (Milestone 1/2 baseline) — kept as the default for tests and smoke coverage.
- `trusted-shell`: operator-trusted executable/argv profile (NGX-282); a goal frontmatter `trusted_shell` block configures the executable `command`, argv `args`, `cwd` (`repo` default or `iteration`), `env_allow` / `env`, `timeout_sec`, and `result_file`. The runner executes `command` with `args` directly (no implicit shell), with no sandbox, records command/cwd/result metadata in `runner.log`, captures stdout/stderr after the command exits, and reads the normalized `RunnerResult` from the configured result file. Stable error codes cover `invalid_input` (missing/malformed config), `runner_threw` (runner log could not be opened), `spawn_failed` (spawn errors such as a missing binary), `command_failed` (non-zero exit), `command_timed_out` (exceeded `timeout_sec`), `result_missing` (no result file written), `result_invalid` (unreadable, malformed, or non-conforming result JSON), and `output_overflow` (stdout/stderr exceeded the 256 MiB capture limit).
- One live ACP/acpx-style runtime smoke path is admitted if a local binary is available; otherwise its smoke is gated behind an opt-in env var so CI stays self-contained.

External writes remain adapter-mediated and policy-gated (Linear/GitHub/Jira adapters or workflow steps). M4 does **not** implement any external tracker writes.

### Planned issue order

The Linear milestone "Milestone 4: Real Runner Profiles" sequences the work as:

1. **NGX-279 — M4-00 M4 contract, roadmap, and docs setup** *(done)*
2. **NGX-280 — M4-01 Runner profile model and resolver** *(done)*: added `src/runner-profile.ts` with the built-in registry (`BUILTIN_RUNNER_KINDS = ["fake", "trusted-shell"]`, `DEFAULT_RUNNER_KIND = "fake"`), `parseRunnerProfile` (validates and normalizes runner names, returning `unsupported_runner` or `malformed_profile` on bad input), `resolveRunnerProfile` (applies precedence: `cli_override > goal_frontmatter > builtin_default`), and `safeRunnerProfileSummary`; wired the resolver into `goal-init.ts` so `goal start` validates the runner profile at init time and persists the resolved name to `goals.runner`; surfaced `runnerProfile` and `runnerProfileSource` on `goal start` JSON, `runnerProfile` on `status` JSON/text and `handoff` JSON/markdown, and a `runners` block on `doctor` JSON/text with `supported`, `default`, and `profiles` arrays; replaced the generic `init_error` code with specific stable codes (`parse_error`, `unsupported_runner`, `malformed_profile`, `init_failed`).
3. **NGX-281 — M4-02 RunnerAdapter boundary and fake-runner migration** *(done)*: added `src/runner-adapter.ts` with `RunnerAdapter`, `RunnerAdapterInput`, `RunnerAdapterResult`, and `RunnerAdapterError` types; an adapter registry (`ADAPTERS`) with `getRunnerAdapter`, `listRunnerAdapterKinds`, `listExecutingRunnerAdapterKinds`; `dispatchRunnerAdapter` validates input, resolves the adapter by kind, checks `executes`, and calls the adapter's `execute` method with a try/catch for `runner_threw`; the `fake` adapter wraps `runFakeRunner` behind the boundary with normalized output and diagnostics, while `trusted-shell` is a placeholder that returns `unsupported_runner`; `foreground-iteration.ts` replaces the direct `runFakeRunner` call and the hard-coded `spec.runner !== "fake"` guard with `dispatchRunnerAdapter`, preserving an early adapter-kind/executes validation before git operations; the queued `worker-run` → `iteration-job` → `foreground-iteration` path uses the same adapter dispatch; the fake runner profile now has `executes: true` and a description reflecting dispatch through the boundary; focused adapter tests cover the registry, dispatch contract, input validation, fake-runner integration, env threading, diagnostics, and error taxonomy.
4. **NGX-282 — M4-03 Trusted-shell runner profile** *(done)*: added `src/trusted-shell-config.ts` (typed `parseTrustedShellConfig` with stable `trusted_shell_config_missing` / `trusted_shell_config_invalid` codes, defaults `cwd=repo`, `timeout_sec=900`, `result_file=result.json`, and refusal of absolute, `..`-escaping, or directory-resolving result paths) and `src/trusted-shell-runner.ts` (spawns the configured executable plus argv via `spawnSync` with no shell, applies `env_allow` filtering with implicit `PATH` preservation, supports `cwd=repo|iteration`, records command/cwd/result metadata in `runner.log`, captures stdout/stderr with section headers after the command exits, and parses the normalized `RunnerResult` from the configured result file); promoted the trusted-shell `RunnerAdapter` from a placeholder to a real adapter with `executes: true`; flipped the `trusted-shell` runner profile to `executes: true` with an explicit-trust description; extended `runForegroundIteration` to reset the worktree to base HEAD when an executing adapter fails after attempting execution without moving HEAD, and to return manual-recovery reasons `runner_changed_head` when the runner advances HEAD or `head_mismatch` when finalization detects unexpected HEAD movement; broadened the `RunnerAdapterErrorCode` taxonomy with `result_missing`, `command_failed`, `command_timed_out`, `spawn_failed`, and `output_overflow`, while `runner_threw` now also covers runner-log open failures and `result_invalid` includes unreadable result files; added focused tests covering config parsing (22 cases), the runner module (16 cases including success, env_allow, cwd modes, timeout, command_failed, result_missing, malformed JSON, spawn ENOENT), the adapter registry / dispatch surface, and end-to-end foreground iteration paths (commit on success, reset on command_failed / timeout / result_missing / result_invalid / runner success=false).
5. **NGX-283 — M4-04 ACP/acpx runtime smoke runner**
6. **NGX-284 — M4-05 Runtime MOMENTUM.md policy loader**
7. **NGX-285 — M4-06 Real-runner status, logs, and recovery hardening**
8. **NGX-286 — M4-07 M4 smoke, docs, and milestone closeout**

The closeout marker for M4 will be pinned by NGX-286 when the smoke and docs alignment lands. Until then, `doctor`'s milestone string intentionally still reads "Milestone 3: operational safety … complete" — the landed M4 setup, profile-model, and RunnerAdapter slices do not flip the readiness marker.

### M4 non-goals (explicit)

The following are **explicitly out of scope** for Milestone 4 and remain deferred regardless of how far M4 advances:

- **External tracker writes** — Linear/GitHub/Jira/etc. issue/PR creation, comments, status changes, label edits driven from Momentum.
- **Inbound webhooks** — adapters stay pull/reconcile first; Momentum does not expose an HTTP listener in M4.
- **Worktrees / per-source-item workspaces** — a Goal still uses one shared repo lease.
- **Background runner supervision** — forking, daemonization, restart-on-crash; the M3 single-process managed loop remains the supervision contract.
- **Dashboard or UI surface** — CLI JSON/text remains the only interface in M4.
- **Strong sandboxing** — `trusted-shell` is exactly that: explicitly trusted. Container/VM/seccomp isolation is not part of M4.
- **Cooperative mid-job cancellation / signal handling** — stop semantics stay observation-only as in M3.
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.

### M3 contracts preserved

M4 must not break or rename any M3 surfaces. Specifically: the `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, the stale-lease detection / startup-recovery pass, the manual-recovery `recovery.md` artifact + flag, and the `status` / `handoff` / `doctor` daemon and recovery fields all remain wire-stable. The M3 closeout marker on `doctor` (and its smoke expectations in `test/cli.test.ts`) stays intact until NGX-286 intentionally updates it as part of M4 closeout.

## Current Exclusions

Milestone 3 is complete. Milestone 4 has absorbed runner profiles and runtime `MOMENTUM.md` policy loading (see the Milestone 4 Roadmap above). The following remain deferred beyond M4 so the runner-boundary and policy-loading surface stays scoped:

- **Background runner supervision.** NGX-272 landed `daemon start` / `daemon stop` / `daemon status` as orchestrator-state contracts; NGX-273 wired an opt-in managed loop on `daemon start` that drains queued goal iterations in-process by composing `runWorkerOnce`. Background detachment / supervision (forking, daemonization, restart-on-crash) remains out of scope.
- **Cooperative shutdown.** NGX-274 surfaces the daemon stop-request state in `status --json` / text and `handoff` JSON / markdown so operators can see why work is not draining without running `daemon status` separately; the daemon loop test suite covers stop-between-jobs observation. NGX-275 adds `daemon stop --now` as an immediate stop request observed between daemon-loop cycles, with a `canceled` terminal state and cancel-outcome visibility. Stop commands still do not signal, kill, or otherwise terminate any running runner, worker, or external process; mid-job cancellation and a full cooperative-shutdown handshake are deferred.
- **Manual recovery beyond safe local cases.** Automatic stale-lease recovery landed in NGX-276: the managed `daemon start` loop runs a one-shot startup-recovery pass that auto-releases stale repo locks owned by terminal jobs, re-pends orphaned stale claims whose repo state is clean, and auto-finalizes idle stale `daemon_runs` rows; dirty / active / ambiguous cases (`job_running`, `daemon_active`, `lock_active`, `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_state_changed`, `active_job_present`, `active_lock_present`, `self`, `run_state_changed`) are surfaced through a stable skip taxonomy. NGX-277 adds the manual-recovery path for blocked stale claims, and M4 also uses it for iteration-time HEAD movement: `repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`, `runner_changed_head`, and `head_mismatch` write `recovery.md`, set `needs_manual_recovery`, block future queue claims, and remain visible through `status`, `handoff`, `daemon status`, and `doctor` until an operator runs `recovery clear`.
- `worker run` remains a single-shot consumer that processes one claimed job per invocation and then exits; the NGX-273 managed loop is the bounded continuous-draining path on `daemon start`.
- Worktree management, per-source-item worktrees/workspaces, remote git operations (`fetch`, `pull`, `push`, `rebase`), and parallel same-repo Goals.
- PR/GitHub/Linear automation, external tracker writes, inbound webhooks, and other external integrations driven from inside Momentum.
- A dashboard or other UI surface beyond the CLI JSON/text outputs.
- **Strong sandboxing** (container / VM / seccomp isolation); M4's `trusted-shell` is explicitly trusted, not sandboxed.
