# AGENTS.md

Use this file as the primary agent operating guide for the Momentum repository.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing CLI structure,
adding command modules, or moving code out of `src/cli.ts`.

## Project purpose
Momentum is a TypeScript CLI (Node.js) for queued goal execution across verified iterations with local artifacts.

Typical loop:
1. Run a goal iteration.
2. Execute verification.
3. Commit or reset on failure.
4. Emit handoff artifacts for continuity.

## Where docs live
The repo has no `internal/` documentation tree.

- `docs/` is public/operator GitHub Pages content: install, commands, recovery,
  runners, walkthroughs, and stable envelopes.
- [`SPEC.md`](SPEC.md) is the compact repo anchor for current runtime and
  workflow contracts.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) is the compact source architecture
  contract.
- Obsidian `/Workspaces/Momentum` is the canonical internal home for long-form
  plans, contracts, milestone provenance, roadmap sequencing, dogfood evidence,
  readiness notes, and migration rationale.

Historical internal planning docs were externalized to Obsidian
`/Workspaces/Momentum`. Do not recreate `internal/`; keep repo docs focused on
shipped behavior, operator truth, source architecture anchors, and executable
checks.

There are no standing exceptions for repo-local `internal/` docs. Any future
exception must be explicit, reviewed, and protected by the docs-boundary tests
rather than introduced as an ad hoc file.

Root [`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth for the current
repo architecture contract and import boundaries. [`SPEC.md`](SPEC.md) is the
current runtime/spec anchor.

## Current milestone
Milestone 11 (CLI Architecture Refactor) is the most recently closed structure milestone. Its source of truth is [`ARCHITECTURE.md`](ARCHITECTURE.md): `src/cli.ts` remains the stable parser, top-level dispatch surface, and daemon/recovery/worker/doctor compatibility home; command-family orchestration lives under `src/commands/`; shared JSON/text/help/diagnostic output contracts live under `src/renderers/`; infrastructure-facing clients and runtime adapters live under `src/adapters/`. Public command semantics remain frozen while import-boundary guardrails preserve that final shape. The `doctor --json` marker reports `Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete`. Long-form milestone history lives in Obsidian `/Workspaces/Momentum`.

Workflow-first runtime, executor-loop, coding-workflow ownership,
external-apply, source-adapter, runtime-consolidation, and adapter-test
coverage contracts are compactly anchored in [`SPEC.md`](SPEC.md). Long-form
contract rationale lives in Obsidian `/Workspaces/Momentum`.

## Stack and workflow commands
TypeScript on Node.js with Vitest tests, managed by pnpm. See [README.md](README.md)'s `## Development` block for `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `node dist/index.js --help`, `node dist/index.js doctor`.

## Coding discipline
- Follow existing code patterns and naming in `src/` and `test/`.
- Keep edits scoped and minimal to the task.
- Preserve existing local/work-in-progress changes.
- Prefer surgical patches.
- Add focused tests for behavior changes.

## Source and test placement
- Keep process bootstrap in `src/index.ts` and top-level parser /
  compatibility dispatch in `src/cli.ts`.
- Put command-family parsing and orchestration in `src/commands/`; put stable
  JSON/text/help/diagnostic output in `src/renderers/`.
- Put infrastructure-facing clients and runtime adapters in `src/adapters/`,
  env/path/default helpers in `src/config/`, cross-cutting helpers in
  `src/shared/`, and domain runtime behavior in `src/core/<domain>/`.
- Keep CLI/parser/output tests in `test/cli-*`, `test/commands-*`, or
  renderer-specific files; keep source-layout and import-boundary guards in
  the existing architecture tests.

## CLI expectations
The full public CLI surface lives in [README.md](README.md); per-command JSON envelopes, refusal codes, and idempotency semantics live in `docs/` (linked from [`docs/index.md`](docs/index.md)). The operational-safety surfaces — `daemon start`, `daemon stop`, `daemon status`, `recovery clear`, and `doctor` — remain wire-stable.

- Preserve stable CLI behavior across both JSON and text outputs.
- When changing user-facing output, update tests and verify callers that rely on stable formatting.

## Data and artifact layout
State (`<data-dir>/momentum.db` SQLite plus per-goal `goals/<goal-id>/` artifact trees) is resolved as `--data-dir` > `MOMENTUM_HOME` > `~/.momentum`. See [docs/data-directory.md](docs/data-directory.md) for the full layout.

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

## Public docs hygiene
- `docs/` and `README.md` are public-facing. Do not add NGX/Linear issue IDs, milestone planning, internal sequencing, or M-version language there. Put long-form internal detail in Obsidian `/Workspaces/Momentum`.
- The `test/public-docs-hygiene.test.ts` guard enforces this on every test run.
- The `test/internal-docs-shape.test.ts` guard enforces that repo `internal/`
  does not return and that any future exception would require an explicit test
  change.
