# Momentum

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

Milestone 1 (Foreground Proof Loop) is in progress. NGX-235 (scaffold), NGX-236 (Goal spec parsing, data-dir resolution, SQLite init, artifact layout), NGX-237 (fake runner, foreground iteration transaction), and NGX-238 (Momentum-owned verification, commit/reset transaction, `status` and `handoff` commands) are complete. NGX-239 (Milestone 1 end-to-end smoke and docs) is complete.

## Milestone 1 Scope

Milestone 1 proves a foreground one-Iteration loop:

```text
Markdown Goal spec -> foreground runner -> Momentum-owned verification -> commit/reset -> ledger/artifacts/status
```

The public CLI shape is:

```text
momentum goal start <goal.md> [--repo <path>] --foreground [--runner <profile>] [--data-dir <path>] [--json]
momentum status [goal-id] [--json]
momentum handoff <goal-id> [--json]
momentum doctor [--json]
```

`goal start --foreground` parses the goal spec, resolves the data directory, initializes SQLite (`goals`, `jobs`, `events` tables), creates the artifact layout, and runs one foreground iteration: it inspects the target repo, captures the pre-iteration HEAD, creates or reuses a Momentum branch, renders the iteration prompt, invokes the configured runner (currently `fake` only), runs each verification command from the repo root, and either stages and commits the full repo diff as one Momentum commit on verified success or hard-resets the worktree back to the pre-iteration HEAD on runner failure or verification failure. The iteration writes `prompt.md`, `runner.log`, `verification.log`, and `result.json` under `iterations/1/`. On a verified commit the goal transitions to `iteration_complete` (or `completed` if the runner reports `goal_complete: true`); on runner failure, verification failure, or any pipeline error it transitions to `failed`. `status [goal-id] --json` reads the SQLite/artifact state and emits a stable JSON shape, and `handoff <goal-id> --json` writes `handoff.md` and `handoff.json` (schema v1) into the goal's artifact dir.

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

The `pnpm test` suite includes a built-binary end-to-end smoke (`test/smoke.test.ts`) that builds `dist/` via `pnpm build`, initializes a disposable git repo under the OS temp dir, drives `goal start`, `status`, and `handoff` through the spawned CLI, and asserts both the success path (exactly one Momentum commit on the Momentum branch with the verification log, handoff artifacts, and SQLite database in place) and the verification-failure reset path (worktree clean and HEAD back at base after `false` verification).

## Goal Spec

Goal files are Markdown that begin with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, and `verification_timeout_sec` are optional. Defaults are `runner: fake`, `branch: momentum/<title-slug>`, `max_iterations: 1`, `verification: []`, and `verification_timeout_sec: 900`. `max_iterations` and `verification_timeout_sec` must be positive integers. If `branch` is omitted, `title` must contain letters or numbers so Momentum can derive `momentum/<title-slug>`. `--repo` and `--runner` override frontmatter values.

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
momentum goal start <goal.md> [--repo <path>] --foreground [--runner <profile>] [--data-dir <path>] [--json]
```

Parses the goal spec, initializes (or resumes) goal state under the resolved data directory, then drives a single foreground iteration through the runner and Momentum-owned verification. `--foreground` is required in Milestone 1; queue/worker modes are out of scope. `--runner` currently accepts only `fake`. JSON output emits a stable envelope:

```json
{
  "ok": true,
  "command": "goal start",
  "goalId": "<ulid>",
  "title": "Example Goal",
  "state": "iteration_complete",
  "resumed": false,
  "iteration": {
    "ok": true,
    "iteration": 1,
    "branch": "momentum/example-goal",
    "branchCreated": true,
    "baseHead": "<sha>",
    "commitSha": "<sha>",
    "runnerSuccess": true,
    "goalComplete": false
  }
}
```

Re-running `goal start` with the same goal spec against the same data directory resumes the existing goal instead of creating duplicate state. Text output begins with `Goal resumed`; JSON output sets `resumed: true`.

### `status`

```text
momentum status [goal-id] [--data-dir <path>] [--json]
```

Reads SQLite plus artifact state and reports the goal's current state, configured repo and runner, latest job, and latest iteration summary (including the verified commit SHA when present). Omitting `goal-id` selects the most recently updated goal in the data directory; when no goals exist the command exits non-zero with `code: "no_goals"`.

### `handoff`

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

Renders `handoff.md` and `handoff.json` (schema v1) into the goal's artifact directory from the same state `status` reads. The JSON envelope echoes `goalId`, `title`, `state`, and `schemaVersion: 1`.

### `doctor`

```text
momentum doctor [--json]
```

Reports CLI version, Node.js version, platform, and the current milestone scope label. Useful as a first sanity check after install.

## Data Directory

State is stored under `--data-dir <path>`, then the `MOMENTUM_HOME` environment variable, then `~/.momentum`. Momentum never modifies the data directory outside this resolved path. Each goal lives in its own directory keyed by goal ID, so multiple concurrent goals share the same SQLite database but isolated artifact trees.

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events tables)
  goals/
    <goal-id>/
      goal.md                  # Canonical copy of the goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by `handoff` (empty placeholder until then)
      handoff.json             # Populated by `handoff` (schema v1)
      iterations/
        1/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Runner result envelope
```

`goal.md`, `ledger.md`, `handoff.md`, and `handoff.json` are created up-front during goal initialization; `handoff.md` starts empty and `handoff.json` starts as `{}` until the `handoff` command writes the schema-v1 envelope. Iteration artifacts are written by `goal start --foreground`.

## Failure and Reset Semantics

Momentum treats each iteration as a transaction over the target repo. The pre-iteration HEAD on the Momentum branch is captured as `baseHead` before the runner runs. From there, exactly one of these outcomes applies:

| Outcome | Trigger | Repo effect | Goal state | JSON error code |
|---|---|---|---|---|
| `committed` | Runner success and all verification commands exit 0 | One commit on the Momentum branch with the full staged repo diff | `iteration_complete` (or `completed` if the runner sets `goal_complete: true`) | n/a (`ok: true`) |
| `reset_runner_failure` | Runner reports `success: false` | Hard reset to `baseHead`; verification is skipped and a note is written to `verification.log` | `failed` | `runner_reported_failure` |
| `reset_verification_failure` | Any verification command exits non-zero | Hard reset to `baseHead` | `failed` | `verification_failed` |
| `commit_failed` | Verification passed but `git commit` failed | Best-effort hard reset to `baseHead`; if the reset also fails the JSON error code becomes `reset_failed` | `failed` | `commit_failed` (or `reset_failed`) |
| `reset_failed` | The reset itself failed after a runner or verification failure | Repo may still have uncommitted changes; requires manual inspection | `failed` | `reset_failed` |

Other early-pipeline errors surface as their own codes (`invalid_input`, `missing_repo`, `unsupported_runner`, `repo_guard_failed`, `branch_manager_failed`, `artifact_write_failed`, `git_failed`, `unexpected_error`) and do not produce a commit. Verification output is captured to `verification.log` with `[verify]` prefixes; the on-disk buffer is capped so a runaway command cannot fill the data directory.

## End-to-end Walkthrough

Drive a fresh disposable run from anywhere in this repo:

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
runner: fake
verification:
  - "true"
---

End-to-end smoke goal.
EOF

node dist/index.js goal start "$DATA/goal.md" \
  --foreground --repo "$REPO" --data-dir "$DATA" --runner fake --json
node dist/index.js status --data-dir "$DATA" --json
GOAL_ID=$(ls "$DATA/goals" | head -n 1)
node dist/index.js handoff "$GOAL_ID" --data-dir "$DATA" --json
```

Replacing the `verification: ["true"]` line with `verification: ["false"]` exercises the failure-reset path: `goal start` exits non-zero, the worktree is reset to its pre-iteration HEAD, and `verification.log` records the failed command.

## Current Exclusions

Milestone 1 intentionally omits the following; they belong to later milestones or are out of scope for this scaffold:

- Queue/worker execution, persistent job leases, and stale-lease recovery (Milestone 2).
- Daemon lifecycle management, stop/cancel commands, and background runner supervision (Milestone 2/3).
- Real runner profiles beyond `fake`; only the fake runner is wired into the foreground iteration.
- Multi-iteration loops; `max_iterations` is parsed but Milestone 1 executes exactly one iteration per `goal start`.
- Worktree management and remote git operations (`fetch`, `pull`, `push`, `rebase`).
- GitHub, Linear, and other external integrations driven from inside Momentum.
- A dashboard or other UI surfaces beyond the CLI JSON/text outputs.
