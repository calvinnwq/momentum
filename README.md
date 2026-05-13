# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is complete. Milestone 2 (Queue and Worker Model) is in progress, with NGX-235, NGX-236, NGX-237, NGX-238, NGX-239, NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, and NGX-250 implemented and verified in this branch. NGX-249 is M2-05 completion reducer and idempotent chaining (`reduceGoalIteration` classifies terminal `goal_iteration` jobs as `continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`; updates `goals.state` / `current_iteration` / `completion_reason`; enqueues next iterations with stable idempotency keys; emits `goal.reduced` + `goal.completed` / `goal.failed`; surfaces reducer state, next job, and next-action via `status`/`handoff`; and runs after each completed queued job). NGX-250 pins the Milestone 2 CLI contract around queued status/handoff fields, local log inspection, queued smoke coverage, and user-facing docs. Milestone 2 also includes queued-path execution without a long-lived daemon, stable single-shot worker behavior, and explicit artifact pointers on job success/failure.

## Milestone 1 Scope

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
momentum doctor [--json]
```

`goal start --foreground` parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events`, `repo_locks` tables), creates the artifact layout, and runs one foreground iteration: it inspects the target repo, captures the pre-iteration HEAD, creates or reuses a Momentum branch, renders the iteration prompt, invokes the configured runner (currently `fake` only), runs each verification command from the repo root, and either stages and commits the full repo diff as one Momentum commit on verified success or hard-resets the worktree back to the pre-iteration HEAD on runner failure or verification failure. The iteration writes `prompt.md`, `runner.log`, `verification.log`, and `result.json` under `iterations/<n>/`. On a verified commit the goal transitions to `iteration_complete` (or `completed` if the runner reports `goal_complete: true`); on runner failure, verification failure, or any pipeline error it transitions to `failed`. `status [goal-id] --json` reads the SQLite/artifact state and emits a stable JSON shape including reducer state, next job, and next-action hints, and `handoff <goal-id> --json` writes `handoff.md` and `handoff.json` (schema v1) into the goal's artifact dir.

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

The `pnpm test` suite includes a built-binary end-to-end smoke (`test/smoke.test.ts`) that builds `dist/` via `pnpm build`, initializes a disposable git repo under the OS temp dir, drives `goal start`, `worker run`, `status`, `logs`, and `handoff` through the spawned CLI, and asserts: the default queued enqueue path (no runner execution, idempotent re-enqueue, and queued job/event SQLite state); the foreground success path (exactly one Momentum commit on the Momentum branch with the verification log, handoff artifacts, and SQLite database in place); the foreground verification-failure reset path (worktree clean and HEAD back at base after `false` verification); the queued logs inspection path; and the queued `worker run` success / verification-failure / runner-failure paths, which assert the full event chain through the reducer (`job.enqueued` → `job.claimed` → `job.heartbeat` → `iteration_started` → (`iteration_completed` | `iteration_failed`) → (`job.succeeded` | `job.failed`) → `goal.reduced` → (`goal.completed` | `goal.failed`)), the commit + artifact pointers on `job.succeeded`, the `artifacts` block on `job.failed`, the `latestJob.resultPath` / `latestJob.errorPath` surface through `status --json` and `handoff`, and the reducer decision / next-job / next-action fields.

## Goal Spec

Goal files are Markdown that begin with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, and `verification_timeout_sec` are optional. Defaults are `runner: fake`, `branch: momentum/<title-slug>`, `max_iterations: 1`, `verification: []`, and `verification_timeout_sec: 900`. `max_iterations` and `verification_timeout_sec` must be positive integers. If `branch` is omitted, `title` must contain letters or numbers so Momentum can derive `momentum/<title-slug>`. `--repo` and `--runner` override frontmatter values. In the default queued path, relative `repo` values are resolved to absolute paths before being persisted or emitted.

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

## Commands

### `goal start`

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]
```

Parses the goal spec and initializes (or resumes) goal state under the resolved data directory. Behavior then branches on `--foreground`:

- **Default (queued enqueue path, Milestone 2):** writes the Goal row with state `queued` and enqueues a single `goal_iteration` job (state `pending`, iteration `1`) with idempotency key `goal:<goal-id>:iteration:1`. Repo, branch, and base HEAD are not inspected at enqueue time — that is the worker's job. Re-running with the same spec returns the same `goalId` and `jobId`, sets `resumed: true` / `enqueueCreated: false`, and emits exactly one `job.enqueued` event per idempotent first-iteration enqueue. `momentum worker run` consumes that queue and executes a claimed job once.

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
    "dataDir": "/path/to/data-dir",
    "artifactDir": "/path/to/data-dir/goals/<uuid>",
    "iterationArtifactDir": "/path/to/data-dir/goals/<uuid>/iterations/1",
    "resumed": false,
    "enqueueCreated": true,
    "nextAction": "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job."
  }
  ```

- **`--foreground` (Milestone 1 inline path):** drives a single foreground iteration through the runner and Momentum-owned verification immediately, returning the iteration outcome on the same invocation. `--runner` currently accepts only `fake`. JSON envelope shape:

  ```json
  {
    "ok": true,
    "command": "goal start",
    "mode": "foreground",
    "goalId": "<uuid>",
    "jobId": "<uuid>",
    "jobType": "foreground_iteration",
    "title": "Example Goal",
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
      "commitMessage": "Momentum iteration 1: Example Goal",
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

Reads SQLite plus artifact state and reports the goal's current state, configured repo and runner, latest job, latest iteration summary (including the verified commit SHA when present), reducer decision (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), the next queued job (if any), and a next-action hint. Omitting `goal-id` selects the most recently updated goal in the data directory; when no goals exist the command exits non-zero with `code: "no_goals"`.

### `logs`

```text
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
```

Reads local iteration artifacts for a goal and emits `runner.log` and `verification.log` content. Without `--iteration`, selects the highest-numbered iteration directory under `goals/<goal-id>/iterations/` (or `goals.current_iteration` when present), so a freshly-initialized goal returns iteration `1` with empty logs. With `--iteration <n>`, reads that iteration's artifact dir and exits non-zero with `code: "iteration_not_found"` if it doesn't exist. `--iteration` must be a positive integer; non-positive values fail with `code: "usage_error"`. The command only reads on-disk artifacts; it does not consult live worker state. JSON output exposes per-log `{path, exists, bytes, content}` plus `availableIterations` so downstream tooling can navigate prior iterations.

### `handoff`

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

Renders `handoff.md` and `handoff.json` (schema v1) into the goal's artifact directory from the same state `status` reads. The handoff includes reducer decision and next-job details, plus a next-action hint describing what to do next.

### `worker run`

```text
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
```

Consumes queued `goal_iteration` work in single-job batches:

- Claims the oldest pending `goal_iteration` job and stamps `worker` / `lease` metadata.
- Acquires a repo lock for the goal repo before launching the iteration.
- Refreshes lease metadata with a heartbeat before execution.
- Executes the claimed `goal_iteration` through the same `finalizeIteration` transaction as the foreground path: runner → Momentum-owned verification → commit on verified success or hard reset to `baseHead` on runner/verification/commit failure.
- Persists `jobs.result_path` to `iterations/<n>/result.json` on success and `jobs.error_path` to `iterations/<n>/verification.log` (or `runner.log` for pre-runner failures) on failure.
- Emits `job.succeeded` with commit + artifact pointers (`commit_sha`, `commit_message`, `branch`, `branch_created`, `base_head`, `goal_complete`, `result_path`, and an `artifacts` block with `iteration_dir` / `prompt` / `runner_log` / `verification_log` / `result_json`) or `job.failed` with the matching `artifacts` block on the failure path.
- After the job completes, runs the completion reducer (`reduceGoalIteration`), which classifies the terminal job as `continue` (enqueue next iteration), `goal_complete` (mark goal completed), `max_iterations_reached` (mark goal terminal), or `iteration_failed` (mark goal failed). The reducer is idempotent: re-invoking it on the same job short-circuits to `already_reduced` without duplicating events or enqueueing duplicate work. If the reducer throws, the worker emits a defensive `goal.reduce_failed` event with the error message and surfaces `reducerError` on the `worker run` result so the job's commit/reset is preserved for inspection and manual recovery.
- On `continue`, enqueues one next `goal_iteration` job with idempotency key `goal:<id>:iteration:<n>`, bumps the goal to state `queued`, and emits `goal.reduced`. On `goal_complete`, sets the goal to `completed` and emits `goal.reduced` + `goal.completed`. On `max_iterations_reached` or `iteration_failed`, sets the goal to the corresponding terminal state and emits `goal.reduced` + `goal.failed`.
- Releases the repo lock with the appropriate `recovery_status` and emits a deterministic CLI JSON result (`code: no_work | not_executed | ran_job`) for automation.

`--worker-id` is optional; default is `worker-<pid>`. For queued work, use:

```text
momentum worker run --data-dir <path>
```

Local interrupt policy: `worker run` is a foreground one-shot command. If the process is interrupted mid-run, there is no automatic stale-lease recovery in this milestone; jobs/locks may remain claimed or active until manual intervention or lock expiry. Re-running the command is the supported local recovery path in Milestone 2.

`status --json` and `handoff --json` surface the same `latestJob.resultPath` / `latestJob.errorPath` pointers, plus `reducer` (decision, iteration, goal state, completion reason, commit SHA, next job), `nextJob` (the queued next-iteration job, if any), and `nextAction` (a human-readable hint) so downstream tooling can locate the per-iteration artifacts and decide what to do next without re-reading the event log. The written `handoff.json` artifact keeps snake_case `result_path` / `error_path` fields.

### `doctor`

```text
momentum doctor [--json]
```

Reports CLI version, Node.js version, platform, and the current milestone scope label. Useful as a first sanity check after install.

## Data Directory

State is stored under `--data-dir <path>`, then the `MOMENTUM_HOME` environment variable, then `~/.momentum`. Momentum never modifies the data directory outside this resolved path. Each goal lives in its own directory keyed by goal ID, so multiple concurrent goals share the same SQLite database but isolated artifact trees.

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events, repo_locks tables)
  goals/
    <goal-id>/
      goal.md                  # Canonical copy of the goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by `handoff` (empty placeholder until then)
      handoff.json             # Populated by `handoff` (schema v1)
      iterations/
        <n>/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Runner result envelope
```

`goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, and the first iteration artifact files are created up-front during goal initialization; `handoff.md`, `prompt.md`, `runner.log`, and `verification.log` start empty, while `handoff.json` and `result.json` start as `{}`. `goal start --foreground` populates the iteration artifacts during inline execution. In the queued path, iteration 1 starts with placeholders; later iteration directories and jobs are created by the reducer, and their artifact files are materialized when `momentum worker run` claims and executes that iteration.

## Failure and Reset Semantics

Momentum treats each iteration as a transaction over the target repo. The pre-iteration HEAD on the Momentum branch is captured as `baseHead` before the runner runs. From there, exactly one of these outcomes applies:

| Outcome | Trigger | Repo effect | Goal state (foreground) | Goal state (queued, via reducer) | JSON error code |
|---|---|---|---|---|---|
| `committed` | Runner success and all verification commands exit 0 | One commit on the Momentum branch with the full staged repo diff | `iteration_complete` (or `completed` if runner sets `goal_complete: true`) | `queued` (continue, next iteration enqueued), `completed` (goal_complete), or `max_iterations_reached` | n/a (`ok: true`) |
| `reset_runner_failure` | Runner reports `success: false` | Hard reset to `baseHead`; verification is skipped and a note is written to `verification.log` | `failed` | `failed` (iteration_failed) | `runner_reported_failure` |
| `reset_verification_failure` | Any verification command exits non-zero | Hard reset to `baseHead` | `failed` | `failed` (iteration_failed) | `verification_failed` |
| `commit_failed` | Verification passed but `git commit` failed | Best-effort hard reset to `baseHead`; if the reset also fails the JSON error code becomes `reset_failed` | `failed` | `failed` (iteration_failed) | `commit_failed` (or `reset_failed`) |
| `reset_failed` | The reset itself failed after a runner or verification failure | Repo may still have uncommitted changes; requires manual inspection | `failed` | `failed` | `reset_failed` |

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

### Foreground debug path

`--foreground` is retained as a Milestone 1 inline debugging path. It bypasses the queue and runs one iteration synchronously, useful when iterating on runner profiles or reproducing a single iteration locally without the worker:

```bash
node dist/index.js goal start "$DATA/goal.md" \
  --foreground --repo "$REPO" --data-dir "$DATA" --runner fake --json
```

Day-to-day execution should use the default queued path so the reducer can chain iterations and the queue can be inspected with `status` / `logs` / `handoff`.

## Current Exclusions

Milestone 2 intentionally defers the following to **Milestone 3** so the queued path stays scoped to single-shot worker claims and explicit local recovery:

- Managed `daemon start` / `daemon status` lifecycle and background runner supervision.
- Graceful stop and `stop --now` commands.
- Automatic stale-lease recovery, a `needs_manual_recovery` goal state, and a `recovery.md` artifact. Stale repo-lock handling in Milestone 2 is manual; re-running `worker run` is the supported local recovery path.
- Multi-iteration draining loops inside a single invocation. `worker run` is a single-shot consumer that processes one claimed job per invocation and then exits. The completion reducer enqueues the next iteration when the decision is `continue`, so separate `worker run` invocations drain a multi-iteration goal step by step. A long-running daemon loop that polls and drains continuously is a Milestone 3 concern.
- Worktree management, remote git operations (`fetch`, `pull`, `push`, `rebase`), and parallel same-repo Goals.
- PR/GitHub/Linear automation and any external integrations driven from inside Momentum.
- A dashboard or other UI surface beyond the CLI JSON/text outputs.

Additionally, Milestone 2 only wires the `fake` runner profile; real runner profiles are tracked separately and are not required to close Milestone 2.
