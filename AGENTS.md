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
- Milestone 1: Foreground proof loop is in progress.
- NGX-235 (scaffold) is done.
- Next issues: NGX-236, NGX-237, NGX-238, NGX-239.

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

## Data and artifact direction
- Momentum state is moving toward:
  - `MOMENTUM_HOME` / `~/.momentum`
  - SQLite-backed state
  - handoff + ledger artifacts
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
