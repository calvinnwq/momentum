# AGENTS.md

Use this file as the primary agent operating guide for the Momentum repository.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing CLI structure,
adding command modules, or moving code out of `src/cli.ts`.

## Project purpose
Momentum is a TypeScript CLI (Node.js) for durable workflow-run execution across verified steps with local artifacts.

Typical loop:
1. Dispatch a workflow step to its executor.
2. Execute verification.
3. Commit or reset on failure.
4. Persist durable evidence and handoff state for continuity.

## Where docs live
The repo has no `internal/` documentation tree.

- `docs/` is public/operator GitHub Pages content: install, commands, recovery,
  runners, walkthroughs, and stable envelopes.
- [`VISION.md`](VISION.md) is the compact product and engineering opinion
  anchor. Read it before proposing workflow shape, recovery, preflight,
  monitoring, or GUI/operator contract changes.
- [`SPEC.md`](SPEC.md) is the compact repo anchor for current runtime and
  workflow contracts.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) is the compact source architecture
  contract.
- The personal wiki `/Workspaces/Momentum` (the `personal-wiki-private` repo)
  is the canonical internal home for long-form
  plans, contracts, milestone provenance, roadmap sequencing, dogfood evidence,
  readiness notes, and migration rationale.

Historical internal planning docs were externalized to the personal wiki
`/Workspaces/Momentum`. Do not recreate `internal/`; keep repo docs focused on
shipped behavior, operator truth, source architecture anchors, and executable
checks.

There are no standing exceptions for repo-local `internal/` docs.
Any future exception must be explicit, reviewed, and protected by the docs-boundary tests rather than introduced as an ad hoc file.

Root [`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth for the current
repo architecture contract and import boundaries. [`SPEC.md`](SPEC.md) is the
current runtime/spec anchor. [`VISION.md`](VISION.md) is the source of truth for
Momentum's product and engineering opinions.

## Architecture status
The CLI architecture contract is stable.
Its source of truth is [`ARCHITECTURE.md`](ARCHITECTURE.md): `src/cli.ts` remains the stable parser, top-level dispatch surface, and daemon/recovery/doctor compatibility home; the goal-first CLI lane and `worker run` are retired; command-family orchestration lives under `src/commands/`; shared JSON/text/help/diagnostic output contracts live under `src/renderers/`; infrastructure-facing clients and runtime adapters live under `src/adapters/`.
Public command semantics remain frozen while import-boundary guardrails preserve that shape.
The `doctor --json` marker reports `CLI architecture: parser dispatch, command families, renderers, adapters`.
Long-form milestone history lives in the personal wiki `/Workspaces/Momentum`.

Workflow-first runtime, executor-loop, coding-workflow ownership,
external-apply, source-adapter, runtime-consolidation, and adapter-test
coverage contracts are compactly anchored in [`SPEC.md`](SPEC.md). Long-form
contract rationale lives in the personal wiki `/Workspaces/Momentum`.

Momentum's product direction is compactly anchored in [`VISION.md`](VISION.md):
Momentum is a local-first runtime that makes agent-driven repo work durable for
external users. Steps are resumable/idempotent, structured JSON and durable
evidence beat terminal scraping, and side-effecting steps own their own
`preflight -> apply -> reconcile` lifecycle. Every step names an executor (the
schema still says "executor family"; the pre-1.0 nomenclature sweep drops the
suffix and renames the values) that runs inside the same durable envelope; no
single executor is the product identity. Each step dispatches attempts, and
attempts accumulate rounds. Surfaces may break freely before 1.0; durable state
always migrates in place.

## Stack and workflow commands
TypeScript on Node.js with Vitest tests, managed by pnpm. See [README.md](README.md)'s `## Development` block for `pnpm install`, `pnpm test`, `pnpm test:integration`, `pnpm test:full`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm format:check`, `node dist/index.js --help`, `node dist/index.js doctor`.
No-mistakes reads `.no-mistakes.yaml` and runs the configured `pnpm` checks instead of delegating test discovery to an agent.

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
The full public CLI surface lives in [README.md](README.md); per-command JSON envelopes, refusal codes, and idempotency semantics live in `docs/` (linked from [`docs/index.html`](docs/index.html)).
The operational-safety surfaces - `daemon start`, `daemon stop`, `daemon status`, `recovery clear`, and `doctor` - remain wire-stable.

- Preserve stable CLI behavior across both JSON and text outputs.
- When changing user-facing output, update tests and verify callers that rely on stable formatting.

## Data and artifact layout
State (`<data-dir>/momentum.db` SQLite plus per-goal `goals/<goal-id>/` artifact trees) is resolved as `--data-dir` > `MOMENTUM_HOME` > `~/.momentum`. See [docs/data-directory.md](docs/data-directory.md) for the full layout.

- Avoid hard-coded paths tied to a single user.
- Only use explicit local paths when existing documentation in-repo explicitly mandates them.

## Local agent run artifacts
- Use `.agent-runs/<tool>/<timestamp>-<label>/` for temporary local agent evidence.
- `.agent-runs/` is ignored by git and may contain prompts, stdout, stderr, and result JSON.
- `.agent-workflows/` is ignored by git and contains local workflow run artifacts such as plan, ledger, approval, recovery, and executor evidence files.
- Delete stale run directories after the work is merged or captured in durable docs/issues.

## Verification before completion
- Run at least:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
- For CLI changes, run the relevant CLI command and spot-check output shape and stability.
- Do not claim done without evidence from the above checks.

## Public docs hygiene
- `docs/` and `README.md` are public-facing. Do not add NGX/Linear issue IDs, milestone planning, internal sequencing, or M-version language there. Put long-form internal detail in the personal wiki `/Workspaces/Momentum`.
- The `test/public-docs-hygiene.test.ts` guard enforces this on every test run.
- The `test/internal-docs-shape.test.ts` guard enforces that repo `internal/` does not return and that any future exception would require an explicit test change.
