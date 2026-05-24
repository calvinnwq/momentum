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
- [`internal/milestones/`](internal/milestones/) — `m3-operational-safety.md`, `m4-real-runners.md`, `m5-source-adapters.md`, `m6-external-apply.md`, `m7-openclaw-coding-workflow-backend.md`.
- [`internal/contracts/`](internal/contracts/) — `intent-apply.md` (M6 two-phase external apply), `source-adapters.md`, `workflow-runs.md` (M7 OpenClaw coding workflow backend substrate).
- [`internal/smoke-tests.md`](internal/smoke-tests.md), [`internal/exclusions.md`](internal/exclusions.md).

## Current milestone
Milestone 7 (OpenClaw Coding Workflow Backend) is the active planning milestone. See [`internal/roadmap.md`](internal/roadmap.md) for the full timeline. M7 turns Momentum into the durable run substrate for OpenClaw coding workflows; the `coding-workflow-pipeline` skill keeps composing executors (preflight → GNHF → postflight → no-mistakes → merge cleanup → Linear refresh) and the Discord / monitor cron UX. M7 is not yet shipped; the `doctor --json` milestone string remains the M6 closeout marker until an explicit M7 closeout slice flips it forward.

Active M7 planning context (see internal docs for full detail):

- M7 ownership boundary, old monitor failure modes M7 eliminates, compatibility with `plan.json` / `ledger.jsonl` / `approval-*.json` / `monitor.json`, planned M7 issue order, and explicit non-goals live in [`internal/milestones/m7-openclaw-coding-workflow-backend.md`](internal/milestones/m7-openclaw-coding-workflow-backend.md).
- Cross-milestone invariants — durable `WorkflowRun` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema, evidence pointer extension, run-scoped manual recovery, lease and approval semantics, and the coding-workflow-pipeline boundary — live in [`internal/contracts/workflow-runs.md`](internal/contracts/workflow-runs.md).
- M7 is explicitly **not** a replacement for `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh`; those executors stay owned by the OpenClaw skills.
- M3 daemon / recovery, M4 runner / policy, M5 source / evidence / intent, and M6 external apply contracts remain wire-stable through M7.

Most recently closed milestone: Milestone 6 (Policy-Gated External Apply). Shipped M6 capability (still in force, see [`internal/milestones/m6-external-apply.md`](internal/milestones/m6-external-apply.md)):

- Linear-only external apply from durable `update_intents` rows via the `intent apply --external-apply` operator command, gated by `MOMENTUM.md` `intent_apply_policy: external_apply_allowed`.
- Adapter-mediated two-phase write: claim → audit-before-write → external write → finalize, with a per-intent CAS guard exposing the stable `intent_apply_in_progress` result.
- Durable audit ledger and blocked / audit-incomplete state surfaced through `intent get`, `intent list`, `status`, `handoff`, `project status`, and `doctor`.
- Comment-only default unless target Linear status mutation is explicitly configured; every external write carries a stable `momentum-intent:<adapterKind>:<intentId>:<digest>` idempotency marker.
- Single-issue post-apply reconcile with stable warning / result codes; no broad reconciliation side effect.
- Built-CLI smoke covers happy path, `policy_denied`, `auth_unavailable`, `write_rejected`, `refresh_failed`, concurrency, audit visibility, and blocked / audit-finalize failure against a stateful Linear mock; tests and smoke never call real `api.linear.app`.
- The `doctor --json` milestone string is the M6 closeout marker `Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete`.

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
