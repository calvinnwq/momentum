# AGENTS.md

Use this file as the primary agent operating guide for the Momentum repository.

## Project purpose
Momentum is a TypeScript CLI (Node.js) for queued goal execution across verified iterations with local artifacts.

Typical loop:
1. Run a goal iteration.
2. Execute verification.
3. Commit or reset on failure.
4. Emit handoff artifacts for continuity.

## Where docs live
Two trees:

- `docs/` — **public-facing** GitHub Pages content (install, commands, recovery, runners, walkthrough). Do not leak roadmap, milestone, NGX/Linear, or sequencing material into here.
- `internal/` — internal-only planning context: roadmap, per-milestone narratives, cross-milestone contracts, smoke-test coverage map, and deferred-feature exclusions. Treat this as the source of truth for milestone scope and sequencing.

Quick map of `internal/`:

- [`internal/roadmap.md`](internal/roadmap.md) — milestone timeline and current ordering.
- [`internal/milestones/`](internal/milestones/) — `m3-operational-safety.md`, `m4-real-runners.md`, `m5-source-adapters.md`, `m6-external-apply.md`.
- [`internal/contracts/`](internal/contracts/) — `intent-apply.md` (M6 two-phase external apply), `source-adapters.md`.
- [`internal/smoke-tests.md`](internal/smoke-tests.md), [`internal/exclusions.md`](internal/exclusions.md).

## Current milestone
Milestone 6 (Policy-Gated External Apply) is the active milestone. See [`internal/roadmap.md`](internal/roadmap.md) for the full timeline and [`internal/milestones/m6-external-apply.md`](internal/milestones/m6-external-apply.md) for scope and sequencing.

Headline rules (see internal docs for full detail):

- Implementation order is NGX-295, NGX-296, NGX-297, NGX-299, NGX-298, NGX-300, NGX-301, NGX-302.
- NGX-299 audit / operator surfaces must merge **before** NGX-298 external apply.
- `intent apply --external-apply` is two-phase: claim, audit-before-write, external write, finalize.
- External write success followed by audit-finalize failure transitions the intent to a `blocked` non-replay state.
- The per-intent concurrency guard uses CAS and exposes a stable `intent_apply_in_progress` result.
- Comment-only is the default unless target Linear status mutation is explicitly configured.
- Every external write carries a stable idempotency marker; post-apply reconcile is single-issue.
- Tests and smoke must not make real `api.linear.app` calls.
- The `doctor --json` milestone string stays on the M5 closeout marker until NGX-302 flips it.

All M3 daemon / recovery, M4 runner / policy, and M5 source / evidence / intent contracts remain wire-stable through M6.

## Stack and workflow commands
TypeScript on Node.js with Vitest tests, managed by pnpm. See [README.md](README.md)'s `## Development` block for `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `node dist/index.js --help`, `node dist/index.js doctor`.

## Coding discipline
- Follow existing code patterns and naming in `src/` and `test/`.
- Keep edits scoped and minimal to the task.
- Preserve existing local/work-in-progress changes.
- Prefer surgical patches.
- Add focused tests for behavior changes.

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
- `docs/` and `README.md` are public-facing. Do not add NGX/Linear issue IDs, milestone planning, internal sequencing, or M-version language there. Put that detail in `internal/`.
- The `test/public-docs-hygiene.test.ts` guard enforces this on every test run.
