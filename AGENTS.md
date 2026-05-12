# AGENTS.md

Use this file as the primary agent operating guide for the Momentum repository.

## Project purpose
Momentum is a TypeScript CLI (Node.js) for one-iteration goal execution with local verification artifacts.

Typical loop:
1. Run a goal iteration.
2. Execute verification.
3. Commit or reset on failure.
4. Emit handoff artifacts for continuity.

## Current milestone
- Milestone 1: Foreground proof loop is complete.
- Milestone 2: Queue and worker model is in progress.
- NGX-235 (scaffold) is done.
- NGX-236 (Goal spec parsing, data-dir resolution, SQLite init, artifact layout) is done.
- NGX-237 (fake runner profile, repo guard, branch manager, iteration prompt renderer, foreground iteration orchestrator, iteration-job DB wrapper, CLI wiring) is done.
- NGX-238 (Momentum-owned verification runner, git transaction commit/reset, finalizeIteration orchestrator, `status` and `handoff` commands, stable CLI JSON shapes) is done.
- NGX-239 (end-to-end Milestone 1 smoke test plus user-facing docs covering local setup, command usage, data directory, artifacts, failure reset semantics, and exclusions) is done.
- NGX-245 (M2-01 queue schema, event taxonomy, idempotent enqueue, repo locks, migration system) is done.
- NGX-246 (M2-02 default enqueue path for `goal start`; `--foreground` retained as the Milestone 1 inline debug path) is done; the `goal_iteration` worker loop is the next M2 increment.

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
  - `handoff`
  - `doctor`
- Preserve stable CLI behavior across both JSON and text outputs.
- When changing user-facing output, update tests and verify callers that rely on stable formatting.

## Data and artifact layout
- State uses `MOMENTUM_HOME` env var → `~/.momentum` fallback; override with `--data-dir`.
- SQLite database at `<data-dir>/momentum.db` with `goals`, `jobs`, `events`, `repo_locks` tables.
- Goal artifacts at `<data-dir>/goals/<goal-id>/`: `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, `iterations/1/{prompt.md,runner.log,verification.log,result.json}`.
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
