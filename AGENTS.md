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
Two repo trees plus one external internal-docs home:

- `docs/` — **public-facing** GitHub Pages content (install, commands, recovery, runners, walkthrough). Do not leak roadmap, milestone, NGX/Linear, or sequencing material into here.
- `internal/` — temporary source-level anchors retained during DOCS-02/DOCS-03 for compatibility with existing contract links and tests. Do not add long-form planning, milestone, roadmap, dogfood, readiness, or migration narrative here.
- Obsidian `/Workspaces/Momentum` — canonical internal home for long-form plans, milestone provenance, roadmap sequencing, dogfood evidence, readiness notes, and docs-boundary decisions.

Historical internal planning docs began moving to Obsidian
`/Workspaces/Momentum` during DOCS-02; DOCS-03 continues the contract/internal
cleanup. Do not recreate long-form `internal/` docs; keep repo docs focused on
shipped behavior, operator truth, source architecture anchors, and executable
checks.

Temporary map of `internal/`:

- [`internal/README.md`](internal/README.md) — temporary documentation anchor
  map for current truth, active contracts, historical milestone provenance, and
  accepted future plans.
- [`internal/contracts/README.md`](internal/contracts/README.md) — active
  contract index. Start here for runtime invariants, repo architecture rules,
  and RC-1..RC-5 consolidation scope.
- [`internal/milestones/README.md`](internal/milestones/README.md) —
  temporary historical milestone anchor index. Preserve shipped order and
  provenance from Obsidian; do not treat superseded milestone prose as current
  instructions without the matching active contract. It points to
  `m3-operational-safety.md`,
  `m4-real-runners.md`, `m5-source-adapters.md`, `m6-external-apply.md`,
  `m7-openclaw-coding-workflow-backend.md`,
  `m8-workflow-run-operator-controls.md`,
  `m9-live-workflow-execution.md`, and `m10-workflow-first-runtime.md`.
- [`internal/roadmap.md`](internal/roadmap.md) — temporary milestone timeline
  anchor. Long-form sequencing lives in Obsidian.
- [`internal/contracts/repo-architecture-standard.md`](internal/contracts/repo-architecture-standard.md)
  — post-M11 source taxonomy, docs taxonomy, type placement, root `src/*.ts`
  policy, and ARCH migration sequence.
- [`internal/plans/README.md`](internal/plans/README.md) — temporary accepted
  future plan anchor and RC-1..RC-5 discovery pointer.
- [`internal/smoke-tests.md`](internal/smoke-tests.md),
  [`internal/exclusions.md`](internal/exclusions.md),
  [`internal/regression-matrix.md`](internal/regression-matrix.md), and
  [`internal/runtime-test-audit.md`](internal/runtime-test-audit.md) —
  temporary audit/evidence anchors. Long-form evidence lives in Obsidian.

Root [`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth for the current
repo architecture contract and import boundaries; it links deeper contracts when
the detail would make the root file too long.

## Current milestone
Milestone 11 (CLI Architecture Refactor) is the most recently closed structure milestone. Its source of truth is [`ARCHITECTURE.md`](ARCHITECTURE.md): `src/cli.ts` remains the stable parser, top-level dispatch surface, and daemon/recovery/worker/doctor compatibility home; command-family orchestration lives under `src/commands/`; shared JSON/text/help/diagnostic output contracts live under `src/renderers/`; infrastructure-facing clients and runtime adapters live under `src/adapters/`. Public command semantics remain frozen while import-boundary guardrails preserve that final shape. The `doctor --json` marker now reports `Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete`. See [`internal/roadmap.md`](internal/roadmap.md) for the full timeline.

Post-M11 runtime/test cleanup planning is recorded in [`internal/runtime-test-audit.md`](internal/runtime-test-audit.md) and [`internal/contracts/runtime-consolidation-plan.md`](internal/contracts/runtime-consolidation-plan.md). NGX-434 authorizes no production deletion; historical runtime paths narrow only after their named prerequisite proof lands.

Post-M11 repo architecture planning is recorded in [`internal/contracts/repo-architecture-standard.md`](internal/contracts/repo-architecture-standard.md). It defines the ARCH-02..ARCH-08 order: root guards, core/config/adapters regrouping, final root type-module drainage, docs IA, and the ARCH-08 `src/core/workflow/runtime-state.ts` seam for re-reading step / lease rows and refreshing cached run-state / monitor columns after caller-owned mutations. None authorize runtime behavior changes, public CLI behavior changes, or compatibility-path deletion. RC-1/RC-1c/RC-2/RC-3 have landed, and RC-4's subworkflow adapter mechanism and RC-4b's production flip (NGX-498) have landed, so a configured `subworkflow` step now dispatches through bounded `daemon start`; see [`internal/contracts/runtime-consolidation-plan.md`](internal/contracts/runtime-consolidation-plan.md).

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
- `docs/` and `README.md` are public-facing. Do not add NGX/Linear issue IDs, milestone planning, internal sequencing, or M-version language there. Put that detail in `internal/`.
- The `test/public-docs-hygiene.test.ts` guard enforces this on every test run.
