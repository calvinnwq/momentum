# AGENTS.md

Use this file as the primary agent operating guide for the Momentum repository.

## Project purpose
Momentum is a TypeScript CLI (Node.js) for queued goal execution across verified iterations with local artifacts.

Typical loop:
1. Run a goal iteration.
2. Execute verification.
3. Commit or reset on failure.
4. Emit handoff artifacts for continuity.

## Current milestone
- Milestone 1: Foreground proof loop is complete.
- Milestone 2: Queue and worker model is complete.
- Milestone 3: Operational Safety is in active implementation. NGX-272 (M3-01 orchestrator state model and daemon CLI contract), NGX-273 (M3-02 managed daemon loop for queued jobs), NGX-274 (M3-03 graceful daemon stop visibility), NGX-275 (M3-04 immediate daemon stop-now cancellation), and NGX-276 (M3-05 stale-lease detection and safe auto-recovery) have shipped; the remaining slices (cooperative mid-job shutdown semantics, manual recovery artifacts, and smoke/docs closeout) are still planning targets and must preserve the durable Goal/Iteration/Job/Handoff model.
- NGX-235 (scaffold) is done.
- NGX-236 (Goal spec parsing, data-dir resolution, SQLite init, artifact layout) is done.
- NGX-237 (fake runner profile, repo guard, branch manager, iteration prompt renderer, foreground iteration orchestrator, iteration-job DB wrapper, CLI wiring) is done.
- NGX-238 (Momentum-owned verification runner, git transaction commit/reset, finalizeIteration orchestrator, `status` and `handoff` commands, stable CLI JSON shapes) is done.
- NGX-239 (end-to-end Milestone 1 smoke test plus user-facing docs covering local setup, command usage, data directory, artifacts, failure reset semantics, and exclusions) is done.
- NGX-245 (M2-01 queue schema, event taxonomy, idempotent enqueue, repo locks, migration system) is done.
- NGX-246 (M2-02 default enqueue path for `goal start`; `--foreground` retained as the Milestone 1 inline debug path) is done.
- NGX-247 (M2-03 worker execution slice: `momentum worker run` claims one queued `goal_iteration`, acquires the repo lock, refreshes lease/heartbeat metadata, executes the iteration, and releases the lock) is done.
- NGX-248 (M2-04 queued `goal_iteration` handler: queued execution reuses `finalizeIteration` for commit/reset, populates `jobs.result_path` / `jobs.error_path`, emits `job.succeeded` / `job.failed` with commit + artifact pointers, surfaces those pointers through `status --json` and `handoff`, and extends the fake runner with `goal_complete` and per-iteration trajectory envs for NGX-249 chaining) is done.
- NGX-249 (M2-05 completion reducer and idempotent chaining: `reduceGoalIteration` classifies terminal `goal_iteration` jobs as `continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`, updates `goals.state` / `current_iteration` / `completion_reason`, enqueues next iterations with stable idempotency keys, emits `goal.reduced` + `goal.completed` / `goal.failed`, is idempotent via `goal.reduced` event check, and surfaces reducer state / next-job / next-action through `status --json` and `handoff`; the worker calls the reducer after each completed job, enabling multi-iteration chaining without drifting or double-enqueueing; per-iteration artifact directories are generalized beyond iteration 1) is done.
- NGX-250 (M2 CLI contract and local log inspection: `status --json` / `handoff.json` expose artifact, current-iteration, next-action, latest-commit, idempotency, and lease metadata; `logs` reads local runner and verification logs; queued smoke coverage and user-facing docs are updated) is done.
- NGX-272 (M3-01 orchestrator state model and daemon CLI contract: durable `daemon_runs` schema and storage primitives with idempotency and stale-heartbeat detection; `daemon start` records a new orchestrator run and refuses while an active one exists, except bounded managed-loop starts first attempt startup recovery for an idle stale active run before re-checking; `daemon stop` records an idempotent stop request without killing runners; `daemon status` and `doctor --json` surface no-daemon, active, stop-requested, error-terminal, stale, and malformed-CLI states; the active-run contract is hardened so concurrent `daemon start` invocations cannot race) is done.
- NGX-273 (M3-02 managed daemon loop for queued jobs: `runDaemonLoop` primitive composes `runWorkerOnce` via optional onJobClaimed/onJobReleased hooks, applies deterministic idle backoff via `pollIntervalMs`, refreshes `daemon_runs` heartbeat / active_job / reconcile_count per cycle, observes `stop_requested` between cycles, transitions to the `error` terminal state on internal failure, and exits with explicit `exitReason` values (`stop_requested` / `stop_now_requested` / `run_terminated` / `run_missing` / `max_loop_iterations` / `max_idle_cycles` / `internal_error`); `momentum daemon start --max-loop-iterations N` / `--max-idle-cycles N` wires the loop into the CLI as an opt-in bounded managed mode while `--poll-interval-ms N` only tunes an already-bounded loop and the no-flag invocation keeps the NGX-272 register-only contract, so queued goals can be drained end-to-end without manually re-invoking `worker run`; focused tests cover queued drain, multi-iteration drain, idle backoff, active-job tracking, mid-loop stop request, run_missing / run_terminated guards, second-start contention, failed-work exit status, and bound-flag validation) is done.
- NGX-274 (M3-03 graceful daemon stop visibility: `status --json` / text and `handoff` JSON / markdown surface daemon stop-request state via a `daemon` summary field — `runId`, `state`, `isActive`, `isTerminal`, `startedAt`, `heartbeatAt`, `finishedAt`, `activeJob`, and `stopRequest` — so operators can see why work is not draining without running `daemon status` separately; the daemon loop includes a focused stop-between-jobs test asserting that a stop requested after a reducer-enqueued follow-up iteration does not claim it, the daemon run transitions to `stopped`, and the goal stays `queued` with one pending iteration-2 job; `GoalStatusDaemonSummary` and `buildDaemonSummary` reuse `getActiveDaemonRun`/`getLatestDaemonRun` from the existing `daemon-runs` module) is done.
- NGX-275 (M3-04 immediate daemon stop-now cancellation: `momentum daemon stop --now` records an idempotent immediate-stop request via `requestDaemonRunImmediateStop` and a new `stop_now_requested_at` column on `daemon_runs`; the managed daemon loop observes `stop_now_requested_at` between cycles and finalizes the run to a new `canceled` terminal state with a `cancel_outcome` of `idle` or `active_job_completed` depending on whether a job had already run in the loop session; iteration atomicity ensures repo state is left clean on cancellation because `finalizeIteration` commits or resets before each cycle returns; `status --json` / text, `handoff` JSON / markdown, and `daemon status` surface `stopNowRequest`, `cancelOutcome`, and the new `canceled` terminal so operators see what was cancelled and whether manual recovery is needed; focused tests cover the idle cancel path, mid-loop active_job_completed path, graceful-to-stop-now upgrade, stop-now idempotency for repeat calls, refusal when no daemon is active, and the new state/outcome surfaces in status and handoff) is done.
- NGX-276 (M3-05 stale-lease detection and safe auto-recovery: `listStaleRepoLocks` / `listStaleClaimedGoalIterationJobs` and the existing `listStaleDaemonRuns` give deterministic stale-state visibility; `recoverStaleRepoLocksForTerminalJobs`, `recoverStaleClaimedGoalIterationJobs`, and `recoverStaleDaemonRuns` auto-release / re-pend / finalize known-safe cases while refusing dirty / active / ambiguous states with a stable skip taxonomy (`job_pending` / `job_claimed` / `job_running` / `job_missing` for locks; `job_running` / `daemon_active` / `lock_active` / `job_state_changed` / `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` for claims; `active_job_present` / `active_lock_present` / `self` / `run_state_changed` for daemons); `runStartupRecovery` composes the three primitives behind `runDaemonLoop`'s pre-loop pass with `excludeRunId` self-exclusion and a configurable grace window; `repo_lock.recovered` and `job.recovered` queue events plus `recovery_status` columns on `repo_locks` and `daemon_runs` carry the audit trail; `doctor` surfaces compact stale counts, `daemon status` surfaces stale rows, `worker run` surfaces a stale pre-check snapshot, and `status` / `handoff` surface goal-scoped recovery summaries) is done.

## Milestone 3 alignment
Milestone 3 is orchestrator lifecycle / operational safety, not just daemon process plumbing. The canonical alignment note lives in `README.md` under "Milestone 3 Alignment"; read it before starting any M3 implementation slice. The headline rules:

- Momentum's durable primitives are `Goal`, `Source`, `Source Item`, `Iteration`, `Job`, `RunnerAdapter`, `Workflow/Policy`, `Workspace/Repo Lease`, `Event`, and `Handoff`. M3 must not break or rename them.
- `Goal` is the core product primitive; external issues/projects are source items that seed context and reconciliation, not completion authority.
- Goal completion is determined by the Goal Markdown acceptance criteria plus runner, verification, and handoff evidence.
- Tracker writes are adapter-mediated and policy-gated. Core records durable facts and external-update intents; Linear/GitHub/Jira/etc. adapters or approved workflow steps perform external writes.
- Source adapters are pull/reconcile first in M3. Do not add inbound webhook infrastructure in the operational-safety milestone.
- A Goal uses one shared repo/workspace lease for now. Do not add per-source-item worktrees/workspaces until daemon, stop, and recovery behavior are solid.
- `MOMENTUM.md` is the canonical future repo policy file, but M3 documents the contract only. Do not implement parsing/validation/precedence unless a daemon slice explicitly proves it is required.
- Symphony is an orchestration reference, not a blueprint to clone. Adopt: single-authority scheduling, reconciliation, retry/backoff taxonomy, workspace safety invariants, runner event taxonomy, token/rate-limit observability, explicit trust/sandbox posture. Avoid: in-memory-only scheduler state, Codex-only runner assumptions, issue-tracker-only completion semantics, high-trust auto-approval defaults, inbound webhooks in M3, per-issue workspace cleanup that loses audit artifacts, core-owned tracker writes, and a runtime `MOMENTUM.md` loader before a daemon slice proves it.

## Stack and workflow commands
- Runtime: Node.js
- Language: TypeScript
- Tests: Vitest
- Package manager: pnpm

Common commands:
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `node dist/index.js doctor`
- `node dist/index.js --help`

## Coding discipline
- Follow existing code patterns and naming in `src/` and `test/`.
- Keep edits scoped and minimal to the task.
- Preserve existing local/work-in-progress changes.
- Prefer surgical patches (`apply_patch` or focused manual edits).
- Add focused tests for behavior changes.

## CLI expectations
- Public surface currently includes:
  - `goal start`
  - `status`
  - `logs`
  - `handoff`
  - `worker run`
  - `daemon start`
  - `daemon stop`
  - `daemon status`
  - `doctor`
- Preserve stable CLI behavior across both JSON and text outputs.
- When changing user-facing output, update tests and verify callers that rely on stable formatting.
- `logs <goal-id> [--iteration N]` reads on-disk `runner.log` and `verification.log` only; it must not consult live worker state.

## Data and artifact layout
- State uses `MOMENTUM_HOME` env var → `~/.momentum` fallback; override with `--data-dir`.
- SQLite database at `<data-dir>/momentum.db` with `goals`, `jobs`, `events`, `repo_locks`, `daemon_runs` tables.
- Goal artifacts at `<data-dir>/goals/<goal-id>/`: `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, `iterations/<n>/{prompt.md,runner.log,verification.log,result.json}`.
- Avoid hard-coded paths tied to a single user.
- Only use explicit local paths when existing documentation in-repo explicitly mandates them.

## Local agent run artifacts
- Use `.agent-runs/<tool>/<timestamp>-<label>/` for temporary local agent evidence.
- `.agent-runs/` is ignored by git and may contain prompts, stdout, stderr, and result JSON.
- Delete stale run directories after the work is merged or captured in durable docs/issues.

## Verification before completion
- Run at least:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
- For CLI changes, run the relevant CLI command and spot-check output shape and stability.
- Do not claim done without evidence from the above checks.
