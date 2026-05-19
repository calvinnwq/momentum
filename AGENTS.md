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
Per-milestone narratives and ID-by-ID changelogs live in `docs/` (see [docs/roadmap.md](docs/roadmap.md) and the milestone pages below). Status:

- Milestone 1: Foreground proof loop is complete.
- Milestone 2: Queue and worker model is complete (NGX-235, NGX-236, NGX-237, NGX-238, NGX-239, NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, NGX-250).
- Milestone 3: Operational Safety is complete (NGX-272, NGX-273, NGX-274, NGX-275, NGX-276, NGX-277, NGX-278). See [docs/milestones/m3-operational-safety.md](docs/milestones/m3-operational-safety.md).
- Milestone 4: Real Runner Profiles is complete (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286). See [docs/milestones/m4-real-runners.md](docs/milestones/m4-real-runners.md).
- Milestone 5: Source Adapters and Evidence Sync is complete (NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294). See [docs/milestones/m5-source-adapters.md](docs/milestones/m5-source-adapters.md).
- Milestone 6: Policy-Gated External Apply is the active milestone. See [docs/milestones/m6-external-apply.md](docs/milestones/m6-external-apply.md) and [docs/contracts/intent-apply.md](docs/contracts/intent-apply.md).

## Milestone 6 contract
Milestone 6 (Policy-Gated External Apply) is the active milestone. The canonical M6 contract lives in `docs/`:

- `docs/roadmap.md` — milestone timeline and current ordering.
- `docs/milestones/m6-external-apply.md` — M6 scope, sequencing, and non-goals.
- `docs/contracts/intent-apply.md` — two-phase external apply: claim, audit-before-write, external write, finalize; blocked / non-replay state; CAS / `intent_apply_in_progress`; comment-only default; idempotency marker; single-issue reconcile; no real `api.linear.app` calls in tests.
- `docs/contracts/source-adapters.md` — source adapter boundary and how M6's Linear write client layers on top.

Headline rules:

- Implementation order is NGX-295, NGX-296, NGX-297, NGX-299, NGX-298, NGX-300, NGX-301, NGX-302.
- NGX-299 audit / operator surfaces must merge **before** NGX-298 external apply.
- `intent apply --external-apply` is **two-phase**: claim, audit-before-write, external write, finalize.
- An external write success followed by an audit-finalize failure transitions the intent to a `blocked` non-replay state; retries do not re-issue the external write.
- The per-intent concurrency guard uses CAS and exposes a stable `intent_apply_in_progress` result.
- Comment-only is the default unless target Linear status mutation is explicitly configured.
- Every external write carries a stable idempotency marker used for dedupe and post-apply reconcile.
- Post-apply reconcile is scoped to the single touched Linear issue.
- Tests and smoke must **not** make real `api.linear.app` calls; use the existing mock endpoint pattern.
- The `doctor --json` milestone string stays on the M5 closeout marker until NGX-302 (M6-07) flips it.
- M6 explicit non-goals: dashboards / UI surfaces, inbound webhooks, autonomous / background external writes, non-Linear adapters, broader runner / sandbox changes, per-source-item worktrees / parallel same-repo Goals, background runner supervision, cooperative mid-job cancellation / signal handling, and remote git operations.

All M3 daemon / recovery, M4 runner / policy, and M5 source / evidence / intent contracts remain wire-stable through M6.

## Milestone 5 contract
Milestone 5: Source Adapters and Evidence Sync is complete. The canonical M5 contract lives in `docs/milestones/m5-source-adapters.md`. Headline rules:

- M5 vocabulary: `SourceItem`, `SourceAdapter`, source snapshot, reconciliation run, evidence artifact, external update intent, and project rollup.
- M5 trust boundary is read-first. Source adapters read external systems and write only to Momentum's local durable tables. External tracker writes are represented as durable, policy-gated update intents and Momentum does not auto-apply them in M5.
- Planned M5 issue order (matches the Linear milestone): NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294 (all done).
- M5 composition with existing contracts: Goal / Iteration / Job / RunnerAdapter / daemon / recovery / handoff / `MOMENTUM.md` policy precedence all remain wire-stable. SourceItem / evidence / intent fields are additive on `goal start`, `status`, `logs`, `handoff`, and `doctor`.
- M5 explicit non-goals: automatic external tracker writes, inbound webhooks, dashboards / UI surfaces, per-source-item worktrees / parallel same-repo Goals, background runner supervision, strong sandboxing, cooperative mid-job cancellation / signal handling, and remote git operations.

## Milestone 4 contract
Milestone 4: Real Runner Profiles is complete. The canonical M4 contract lives in `docs/milestones/m4-real-runners.md`. Headline rules:

- Momentum core owns Goal / Iteration / Job state, verification, the git transaction, and the M2 / M3 queue / daemon / recovery surfaces. `RunnerAdapter` implementations execute the iteration prompt and report a normalized `RunnerResult`; adapters do not touch git, do not own verification, and do not perform external tracker writes.
- Built-in runner family: `fake`, `trusted-shell`, and `acp`.
- `MOMENTUM.md` policy precedence: CLI flag > goal frontmatter > `MOMENTUM.md` > built-in default.
- M4 explicit non-goals: external tracker writes, inbound webhooks, per-source-item worktrees / parallel same-repo Goals, background runner supervision, dashboards / UI surfaces, strong sandboxing, cooperative mid-job cancellation / signal handling, and remote git operations.

## Milestone 3 alignment
Milestone 3: Operational Safety is complete. The canonical M3 alignment lives in `docs/milestones/m3-operational-safety.md`. Headline rules:

- Durable primitives: `Goal`, `Source`, `Source Item`, `Iteration`, `Job`, `RunnerAdapter`, `Workflow / Policy`, `Workspace / Repo Lease`, `Event`, and `Handoff`. Do not break or rename them.
- `Goal` is the core product primitive; external issues / projects are source items that seed context and reconciliation, not completion authority.
- Tracker writes are adapter-mediated and policy-gated.
- A Goal uses one shared repo / workspace lease.

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
- `source list`
- `source get`
- `source link`
- `source unlink`
- `source reconcile linear`
- `project status`
- `worker run`
- `daemon start`
- `daemon stop`
- `daemon status`
- `recovery clear`
- `evidence ingest`
- `evidence list`
- `intent list`
- `intent get`
- `intent apply`
- `intent skip`
- `intent cancel`
- `doctor`
- Preserve stable CLI behavior across both JSON and text outputs.
- When changing user-facing output, update tests and verify callers that rely on stable formatting.
- `logs <goal-id> [--iteration N]` reads on-disk `runner.log`, `verification.log`, runner result JSON artifacts, linked source item summaries, and latest evidence summaries from SQLite; it must not consult live worker state. Empty result scaffolds (`{}`) are not parse errors, while malformed/non-conforming result JSON should surface a `parseError`.

## Data and artifact layout
- State uses `MOMENTUM_HOME` env var → `~/.momentum` fallback; override with `--data-dir`.
- SQLite database at `<data-dir>/momentum.db` with `goals`, `jobs`, `events`, `repo_locks`, `daemon_runs`, `source_items`, `source_snapshots`, `source_reconciliation_runs`, `evidence_records`, and `update_intents` tables.
- Goal artifacts at `<data-dir>/goals/<goal-id>/`: `goal.md`, `ledger.md`, `handoff.md`, `handoff.json`, optional `recovery.md` (created lazily when manual recovery is classified), and `iterations/<n>/{prompt.md,runner.log,verification.log,result.json}` by default; runner profiles such as `trusted-shell` and `acp` may report a different result JSON file inside the iteration directory via `trusted_shell.result_file` / `acp.result_file`.
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
