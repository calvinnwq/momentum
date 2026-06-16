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
Two trees:

- `docs/` — **public-facing** GitHub Pages content (install, commands, recovery, runners, walkthrough). Do not leak roadmap, milestone, NGX/Linear, or sequencing material into here.
- `internal/` — internal-only planning context: roadmap, per-milestone narratives, cross-milestone contracts, smoke-test coverage map, and deferred-feature exclusions. Treat this as the source of truth for milestone scope and sequencing.

Quick map of `internal/`:

- [`internal/roadmap.md`](internal/roadmap.md) — milestone timeline and current ordering.
- [`internal/milestones/`](internal/milestones/) — `m3-operational-safety.md`, `m4-real-runners.md`, `m5-source-adapters.md`, `m6-external-apply.md`, `m7-openclaw-coding-workflow-backend.md`, `m8-workflow-run-operator-controls.md`, `m9-live-workflow-execution.md` (M9 live workflow execution foundation), `m10-workflow-first-runtime.md` (M10 workflow-first runtime, complete).
- [`internal/contracts/`](internal/contracts/) — `intent-apply.md` (M6 two-phase external apply), `source-adapters.md`, `workflow-runs.md` (M7 OpenClaw coding workflow backend substrate), `workflow-operator-controls.md` (M8 workflow run operator controls), `live-workflow-execution.md` (M9 live execution contract), `workflow-first-runtime.md`, `executor-loop.md`, and `workflow-first-gap-matrix.md` (M10 workflow-first runtime contracts), plus `coding-workflow-ownership.md` (post-M10 coding workflow ownership migration) and `runtime-consolidation-plan.md` (post-M11 runtime keep / deprecate-later / defer decisions).
- [`internal/contracts/repo-architecture-standard.md`](internal/contracts/repo-architecture-standard.md) — post-M11 source taxonomy, docs taxonomy, type placement, root `src/*.ts` policy, and ARCH migration sequence.
- [`internal/plans/README.md`](internal/plans/README.md) — accepted future implementation plans, such as RC-1..RC-5, when those plans are written.
- [`internal/smoke-tests.md`](internal/smoke-tests.md), [`internal/exclusions.md`](internal/exclusions.md), [`internal/regression-matrix.md`](internal/regression-matrix.md) (closeout and foundation regression matrix).

Root [`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth for the current
repo architecture contract and import boundaries; it links deeper contracts when
the detail would make the root file too long.

## Current milestone
Milestone 11 (CLI Architecture Refactor) is the most recently closed structure milestone. Its source of truth is [`ARCHITECTURE.md`](ARCHITECTURE.md): `src/cli.ts` remains the stable parser, top-level dispatch surface, and daemon/recovery/worker/doctor compatibility home; command-family orchestration lives under `src/commands/`; shared JSON/text/help/diagnostic output contracts live under `src/renderers/`; infrastructure-facing clients and runtime adapters live under `src/adapters/`. Public command semantics remain frozen while import-boundary guardrails preserve that final shape. The `doctor --json` marker now reports `Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete`. See [`internal/roadmap.md`](internal/roadmap.md) for the full timeline.

Post-M11 runtime/test cleanup planning is recorded in [`internal/runtime-test-audit.md`](internal/runtime-test-audit.md) and [`internal/contracts/runtime-consolidation-plan.md`](internal/contracts/runtime-consolidation-plan.md). NGX-434 authorizes no production deletion by itself; historical runtime paths narrow only after their named prerequisite proof lands.

Post-M11 repo architecture planning is recorded in [`internal/contracts/repo-architecture-standard.md`](internal/contracts/repo-architecture-standard.md). It defines the target `src/commands`, `src/renderers`, `src/adapters`, `src/config`, `src/shared`, and `src/core/<domain>` taxonomy for ARCH-02..ARCH-08. It does not authorize source moves, runtime changes, public CLI behavior changes, or compatibility-path deletion by itself.

Milestone 10 (Workflow-First Runtime) is the previously closed runtime milestone. See [`internal/milestones/m10-workflow-first-runtime.md`](internal/milestones/m10-workflow-first-runtime.md), [`internal/contracts/workflow-first-runtime.md`](internal/contracts/workflow-first-runtime.md), [`internal/contracts/executor-loop.md`](internal/contracts/executor-loop.md), and [`internal/contracts/workflow-first-gap-matrix.md`](internal/contracts/workflow-first-gap-matrix.md).

Milestone 9 (Live Workflow Execution) remains valid foundation work, promoted from draft at the M9-00 decision gate (NGX-331). M9 adds Momentum-side live executor wrappers around the existing OpenClaw engines; it wraps the engines and does not rewrite them. See [`internal/milestones/m9-live-workflow-execution.md`](internal/milestones/m9-live-workflow-execution.md) and [`internal/contracts/live-workflow-execution.md`](internal/contracts/live-workflow-execution.md).

Milestone 8 was previously the most recently closed milestone; it layered operator-control CLI envelopes, per-run recovery artifacts, `needs_manual_recovery`, and typed `runId` / `stepId` evidence linkage on M7. Closeout marker: `Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete`. See [`internal/milestones/m8-workflow-run-operator-controls.md`](internal/milestones/m8-workflow-run-operator-controls.md) and [`internal/contracts/workflow-operator-controls.md`](internal/contracts/workflow-operator-controls.md).

Shipped Milestone 7 substrate stays in force: durable workflow tables, the `WorkflowStepExecutor` registry, monitor recovery taxonomy, and read-only workflow envelopes. Closeout marker: `Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete`. See [`internal/milestones/m7-openclaw-coding-workflow-backend.md`](internal/milestones/m7-openclaw-coding-workflow-backend.md) and [`internal/contracts/workflow-runs.md`](internal/contracts/workflow-runs.md). M7 is **not** a replacement for OpenClaw-owned executors; M3 through M6 contracts remain wire-stable through M11.

Previously closed milestone: Milestone 6 (Policy-Gated External Apply). Shipped M6 capability remains in force; see [`internal/milestones/m6-external-apply.md`](internal/milestones/m6-external-apply.md) for the M6 narrative.

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
