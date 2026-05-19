# Momentum

![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-pre--release-orange)
![License](https://img.shields.io/badge/license-unpublished-lightgrey)

Momentum is a TypeScript CLI targeting Node.js for autonomous repo-work orchestration. It turns a durable Goal into verified Iterations, with local artifacts and handoff state.

## Documentation

The roadmap, milestone scopes, and cross-milestone contracts live under `docs/`:

- [docs/roadmap.md](docs/roadmap.md) — milestone timeline and current ordering.
- [docs/milestones/m3-operational-safety.md](docs/milestones/m3-operational-safety.md) — M3: operational safety (complete). Daemon / orchestrator state, stop-request visibility, stale-lease recovery, and manual-recovery artifacts.
- [docs/milestones/m4-real-runners.md](docs/milestones/m4-real-runners.md) — M4: real runner profiles (complete). `RunnerAdapter` boundary, `fake` / `trusted-shell` / `acp` profiles, and the runtime `MOMENTUM.md` policy loader.
- [docs/milestones/m5-source-adapters.md](docs/milestones/m5-source-adapters.md) — M5: source adapters and evidence sync (complete). Framed as durable intents only; no external apply.
- [docs/milestones/m6-external-apply.md](docs/milestones/m6-external-apply.md) — M6: policy-gated external apply (active).

Cross-cutting contracts:

- [docs/contracts/intent-apply.md](docs/contracts/intent-apply.md) — Two-phase external apply: claim, audit-before-write, external write, finalize, blocked / non-replay state, CAS, comment-only default, idempotency marker, single-issue reconcile, and the test guard against real `api.linear.app` calls.
- [docs/contracts/source-adapters.md](docs/contracts/source-adapters.md) — Source adapter boundary: read-only invariants, snapshot / reconciliation outputs, and how M6's Linear write client layers on top.

Operator references:

- [docs/runners.md](docs/runners.md) — Runner profiles (`trusted-shell`, `acp`) and the runtime `MOMENTUM.md` policy loader (frontmatter shape, `RunnerResult` schema, precedence chain, trust posture).
- [docs/recovery.md](docs/recovery.md) — Stale-lease auto-recovery (NGX-276) and manual recovery artifacts plus the `needs_manual_recovery` flag and `recovery clear` operator flow (NGX-277).
- [docs/failure-reset.md](docs/failure-reset.md) — Per-iteration failure and reset semantics: `baseHead` transaction model, the six iteration outcomes, runner failure code taxonomy, manual-recovery reasons, early-pipeline error codes, and `verification.log` capture.
- [docs/daemon.md](docs/daemon.md) — `daemon start` (register-only and managed-loop), `daemon stop`, and `daemon status` JSON envelope shapes, `loop.exitReason` taxonomy, and `daemon_already_active` / `no_active_daemon` failure surfaces.
- [docs/worker-run.md](docs/worker-run.md) — `worker run` single-job pipeline: claim / lock / heartbeat / `finalizeIteration`, `job.succeeded` / `job.failed` artifact pointers, reducer outcomes (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), CLI result codes, `RunnerAdapter` dispatch, NGX-276 `stalePreCheck`, and local interrupt policy.
- [docs/doctor.md](docs/doctor.md) — `doctor` JSON envelope: daemon-readiness block, runners catalog, `MOMENTUM.md` policy block, sources / evidence aggregates, and policy-load error codes.

Command envelopes:

- [docs/goal-start.md](docs/goal-start.md) — `goal start` queued and foreground JSON envelope shapes, init-time validation taxonomy, the `MOMENTUM.md` policy block, and resume / idempotency semantics.
- [docs/status.md](docs/status.md) — `status` JSON envelope: `runnerProfile`, `goalState`, `artifacts` (including `recoveryMd`), `daemon` / `staleRecovery` / `policy` sub-blocks, linked `sourceItems`, `latestEvidence`, `pendingUpdateIntents`, and the text-output mirror.
- [docs/handoff.md](docs/handoff.md) — `handoff` snake_case JSON envelope (schema v1) + the `handoff.md` markdown mirror, the `runner_result_error` surface, and the `recovery_md` `(present)` / `(missing)` artifact rendering.
- [docs/intent-commands.md](docs/intent-commands.md) — `intent list` / `get` / `apply` / `skip` / `cancel` envelopes, `intent_apply_policy` resolution, `external_apply_unsupported` / `intent_already_terminal` refusal codes.
- [docs/walkthrough.md](docs/walkthrough.md) — End-to-end disposable smoke: queued default path (`goal start` → `worker run` → `status` / `logs` / `handoff`), managed daemon drain (`daemon start --max-idle-cycles`), foreground debug path, and the verification-failure reset behaviour.
- [docs/exclusions.md](docs/exclusions.md) — Current exclusions: deferred surfaces (background runner supervision, cooperative shutdown, manual recovery beyond safe local cases, worktree / remote-git operations, automatic external integrations, dashboard / UI surface, strong sandboxing).

Source, evidence, and project commands:

- [docs/source-commands.md](docs/source-commands.md) — `source list` / `get` / `link` / `unlink` / `reconcile linear` and `project status` envelopes, source-item refusal codes, Linear reconciliation flags, and the stable `mismatches` / `reconciliationWarnings` / `nextAction` taxonomies.
- [docs/evidence-commands.md](docs/evidence-commands.md) — `evidence ingest` / `evidence list` envelopes, the `agent-workflow` artifact shapes, `evidence_format_unknown` / `evidence_format_invalid` diagnostic codes, and idempotent re-ingest semantics.

Milestone status at a glance (see the docs links above and the dedicated sections below for the full contracts):

- Milestone 1 (Foreground Proof Loop) is complete.
- Milestone 2 (Queue and Worker Model) is complete (NGX-235, NGX-236, NGX-237, NGX-238, NGX-239, NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, NGX-250).
- Milestone 3 (Operational Safety) is complete (NGX-272, NGX-273, NGX-274, NGX-275, NGX-276, NGX-277, NGX-278); see [`docs/milestones/m3-operational-safety.md`](docs/milestones/m3-operational-safety.md).
- Milestone 4 (Real Runner Profiles) is complete (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286); see [`docs/milestones/m4-real-runners.md`](docs/milestones/m4-real-runners.md).
- Milestone 5 (Source Adapters and Evidence Sync) is complete (NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294); see [`docs/milestones/m5-source-adapters.md`](docs/milestones/m5-source-adapters.md). `doctor --json` is pinned to the M5 closeout marker.
- Milestone 6 (Policy-Gated External Apply) is the active milestone; see [`docs/milestones/m6-external-apply.md`](docs/milestones/m6-external-apply.md) and [`docs/contracts/intent-apply.md`](docs/contracts/intent-apply.md).

Momentum's core primitive is a durable `Goal`; external issues/projects are source items that seed context and reconciliation, not the source of truth for completion. Tracker writes are adapter-mediated and policy-gated.

## CLI Surface

Milestone 1 proves a foreground one-Iteration loop:

```text
Markdown Goal spec -> foreground runner -> Momentum-owned verification -> commit/reset -> ledger/artifacts/status
```

The public CLI shape is:

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]
momentum status [goal-id] [--data-dir <path>] [--json]
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
momentum handoff <goal-id> [--data-dir <path>] [--json]
momentum source list [--adapter <kind>] [--data-dir <path>] [--json]
momentum source get <source-item-id> [--data-dir <path>] [--json]
momentum source link <source-item-id> --goal <goal-id> [--data-dir <path>] [--json]
momentum source unlink <source-item-id> [--data-dir <path>] [--json]
momentum source reconcile linear [--project <id-or-name>] [--milestone <id-or-name>] [--dry-run] [--max-pages <n>] [--linear-endpoint <url>] [--linear-page-size <n>] [--data-dir <path>] [--json]
momentum project status [--source <adapter>] [--project <id-or-name>] [--milestone <id-or-name>] [--stale-threshold-hours <n>] [--intent-stale-threshold-days <n>] [--data-dir <path>] [--json]
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
momentum daemon status [--data-dir <path>] [--json]
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]
momentum evidence list [--goal <id>] [--source-item <id>] [--source <source>] [--type <type>] [--limit <n>] [--data-dir <path>] [--json]
momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]
momentum intent get <intent-id> [--data-dir <path>] [--json]
momentum intent apply <intent-id> --reason <text> [--repo <path>] [--external-apply] [--data-dir <path>] [--json]
momentum intent skip <intent-id> --reason <text> [--data-dir <path>] [--json]
momentum intent cancel <intent-id> --reason <text> [--data-dir <path>] [--json]
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

`goal start` branches on `--foreground`: the default queued path enqueues one `goal_iteration` job for `momentum worker run` to claim and execute (Milestone 2), and `--foreground` drives one inline iteration through the configured runner profile and Momentum-owned verification (Milestone 1 debug path). See [`docs/goal-start.md`](docs/goal-start.md) for the full queued / foreground JSON envelopes, [`docs/worker-run.md`](docs/worker-run.md) for the worker pipeline and reducer outcomes, and [`docs/failure-reset.md`](docs/failure-reset.md) for the per-iteration transaction model (`baseHead` snapshot, hard-reset on failure, `recovery.md` on HEAD movement).

The `daemon` subcommands record orchestrator-run state in `daemon_runs` and are scoped to the completed Milestone 3 operational-safety slices (NGX-272 through NGX-278). Without loop-bound flags, `daemon start` is register-only; with `--max-loop-iterations` or `--max-idle-cycles` it opts into the managed loop that drains queued iterations in-process, runs a one-shot startup-recovery pass, and finalizes on bound, `stop_requested`, `stop_now_requested`, or a terminal state. See [`docs/daemon.md`](docs/daemon.md) for the full envelopes (including the `loop.exitReason` taxonomy and `daemon_already_active` guard) and [`docs/recovery.md`](docs/recovery.md) for the stale-lease skip taxonomy, the `recovery.md` / `needs_manual_recovery` artifact, and the `momentum recovery clear` operator flow.

## Local Development

Requires Node.js 24 or newer.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
node dist/index.js --help
node dist/index.js doctor
```

The `pnpm test` suite includes a built-binary end-to-end smoke (`test/smoke.test.ts`) that builds `dist/` via `pnpm build`, initializes disposable git repos under the OS temp dir, and drives core CLI commands through the spawned binary across the M1/M2 queued and foreground paths, the M3 daemon/recovery paths, the M4 real-runner paths, and the M5 source/evidence/intent paths. See [`docs/smoke-tests.md`](docs/smoke-tests.md) for the full surface map.

## Goal Spec

Goal files are Markdown with YAML frontmatter. `title` is required; `repo`, `runner`, `branch`, `max_iterations`, `verification`, `verification_timeout_sec`, `trusted_shell`, and `acp` are optional. The `runner` field accepts `fake`, `trusted-shell`, or `acp`; the default-resolution precedence is `--runner` CLI flag > goal frontmatter `runner` > `MOMENTUM.md` `runner` > `fake`. See [`docs/goal-spec.md`](docs/goal-spec.md) for the full frontmatter reference (built-in defaults, strict-type validation rules, title-slug derivation, queued-path relative-repo absolute resolution, and the runner precedence chain).

```markdown
---
title: Example Goal
repo: /path/to/repo
runner: fake
branch: momentum/example-goal
max_iterations: 1
verification:
  - pnpm test
verification_timeout_sec: 900
---

Describe the goal and constraints here.
```

### Runner profiles and repo policy

The `trusted-shell` (NGX-282) and `acp` (NGX-283) runner profiles, the normalized `RunnerResult` schema, the stable runner failure-code taxonomy, the runtime `MOMENTUM.md` policy loader (NGX-284), the CLI > frontmatter > `MOMENTUM.md` > built-in precedence chain, and the explicit (unsandboxed) trust posture live in [`docs/runners.md`](docs/runners.md).

## Commands

### `goal start`

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]
```

Parses the goal spec and initializes (or resumes) goal state under the resolved data directory, then branches on `--foreground`: the default queued path writes the Goal row with state `queued`, enqueues one `goal_iteration` job (idempotency key `goal:<goal-id>:iteration:1`), and returns immediately for `momentum worker run` to claim and execute; `--foreground` drives one inline iteration through the configured runner profile and Momentum-owned verification, returning the iteration outcome on the same invocation. `--from-source <source-item-id>` links the goal to a source item at init time, surfaced as `linkedSourceItem` on the envelope and a `## Source context` block in each iteration prompt. Re-running the same goal spec resumes the existing goal (`resumed: true`). See [docs/goal-start.md](docs/goal-start.md) for the full queued / foreground JSON envelopes, the init-time validation taxonomy, the `MOMENTUM.md` `policy` block, and the resume / idempotency semantics.

### `status`

```text
momentum status [goal-id] [--data-dir <path>] [--json]
```

Read-only inspector for goal state. Reads SQLite plus on-disk artifacts and reports the goal's current state, resolved runner profile, latest iteration summary, reducer decision (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), next queued job, daemon run summary, repo `MOMENTUM.md` policy, linked source items, latest evidence, and pending update intents. Omitting `goal-id` selects the most recently updated goal; exits non-zero with `code: "no_goals"` when none exist. See [`docs/status.md`](docs/status.md) for the full JSON envelope, the `daemon` / `staleRecovery` / `policy` / `sourceItems` / `latestEvidence` / `pendingUpdateIntents` sub-blocks, and the text-output mirror.

### `logs`

```text
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
```

Reads local iteration artifacts for a goal and emits `runner.log`, `verification.log`, and the runner result JSON artifact content. Without `--iteration`, selects the highest-numbered iteration directory (so a freshly-initialized goal returns iteration `1` with empty logs); with `--iteration <n>`, refuses with `iteration_not_found` when the directory is missing or `usage_error` for a non-positive value. The command only reads local artifacts plus SQLite linked-source and evidence summaries; it does not consult live worker state. See [`docs/logs.md`](docs/logs.md) for the full JSON envelope (`availableIterations`, `runnerLog`, `verificationLog`, `resultJson`, `sourceItems`, `latestEvidence`), the per-file block shape, the `resultJson.parseError` semantics (empty / `{}` scaffold is not a parse error), and the text-output mirror.

### `handoff`

```text
momentum handoff <goal-id> [--data-dir <path>] [--json]
```

Renders `handoff.md` and `handoff.json` (schema v1) into the goal's artifact directory from the same state `status` reads, with snake_case JSON keys. The envelope covers reducer decision, next-action hints, the `daemon` and `stale_recovery` sub-blocks, the `MOMENTUM.md` `policy` block, linked `source_items`, `latest_evidence`, and `pending_update_intents` (plus `intent_stale_threshold_ms`); malformed runner result artifacts surface a stable `runner_result_error` instead of a silent `null`. See [docs/handoff.md](docs/handoff.md) for the full envelope spec, the markdown mirror, and the `recovery.md` `(present)` / `(missing)` artifact rendering.

### `source list`, `source get`, `source link`, `source unlink`, `source reconcile linear`, `project status`

```text
momentum source list [--adapter <kind>] [--data-dir <path>] [--json]
momentum source get <source-item-id> [--data-dir <path>] [--json]
momentum source link <source-item-id> --goal <goal-id> [--data-dir <path>] [--json]
momentum source unlink <source-item-id> [--data-dir <path>] [--json]
momentum source reconcile linear [--project <id-or-name>] [--milestone <id-or-name>] [--dry-run] [--max-pages <n>] [--linear-endpoint <url>] [--linear-page-size <n>] [--data-dir <path>] [--json]
momentum project status [--source <adapter>] [--project <id-or-name>] [--milestone <id-or-name>] [--stale-threshold-hours <n>] [--intent-stale-threshold-days <n>] [--data-dir <path>] [--json]
```

`source list` / `get` inspect durable `source_items` rows; `source link` / `unlink` move a source item's `goalId` link (single-goal invariant, idempotent on the same target, refuses with `linked_to_other_goal` / `link_changed`); `source reconcile linear` paginates Linear via `LINEAR_API_KEY` into `source_items` / `source_snapshots` / `source_reconciliation_runs` (supports `--dry-run`, `--max-pages`, `--linear-endpoint`, `--linear-page-size`); `project status` computes the local rollup with stable `mismatches[].kind`, `reconciliationWarnings[].reason`, and `nextAction.kind` taxonomies. See [docs/source-commands.md](docs/source-commands.md) for the full JSON envelope shapes, refusal-code taxonomies, and the `pendingUpdateIntents` stale-flag semantics.

### `evidence ingest`, `evidence list`

```text
momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]
momentum evidence list [--goal <id>] [--source-item <id>] [--source <source>] [--type <type>] [--limit <n>] [--data-dir <path>] [--json]
```

`evidence ingest` reads local `.agent-workflows/<run-id>/` artifacts (`plan.json`, `ledger.jsonl`, `approval-*.json`) and stores normalized rows in `evidence_records` with `source: "agent-workflow"`, `formatVersion: 1`, and a stable `ingestKey`; re-ingest is idempotent. `evidence list` returns records ordered by `occurredAt` ascending and composes `--goal`, `--source-item`, `--source`, `--type`, and `--limit` filters. Pre-checks on `--goal` / `--source-item` refuse with `goal_not_found` / `source_item_not_found`; per-file format diagnostics use the stable `evidence_format_unknown` / `evidence_format_invalid` codes. See [docs/evidence-commands.md](docs/evidence-commands.md) for the full JSON envelope shapes, refusal taxonomy, and idempotency semantics.

### `intent list`, `intent get`, `intent apply`, `intent skip`, `intent cancel`

```text
momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]
momentum intent get <intent-id> [--data-dir <path>] [--json]
momentum intent apply <intent-id> --reason <text> [--repo <path>] [--external-apply] [--data-dir <path>] [--json]
momentum intent skip <intent-id> --reason <text> [--data-dir <path>] [--json]
momentum intent cancel <intent-id> --reason <text> [--data-dir <path>] [--json]
```

The five intent commands list, inspect, and transition update-intent rows. `intent list` filters by `--status` (`pending` / `applied` / `skipped` / `canceled`), adapter, type, goal, source-item, or evidence-record. `intent apply` / `skip` / `cancel` all require `--reason`, are idempotent on already-terminal intents (refusing with `intent_already_terminal` and surfacing `currentStatus`), and `intent apply --external-apply` is refused in Milestone 5 with `external_apply_unsupported` since Momentum does not perform automatic external tracker writes. See [docs/intent-commands.md](docs/intent-commands.md) for the full JSON envelope fields, the `intent_apply_policy` resolution (`create_intents_only` by default, `--repo` loads `MOMENTUM.md`), and the `applyPolicy` block surfaced on `--external-apply`. The two-phase external apply contract that layers on top in Milestone 6 lives in [docs/contracts/intent-apply.md](docs/contracts/intent-apply.md).

### `worker run`

```text
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
```

Claims one pending `goal_iteration` job, finalizes the iteration through the same transaction as the foreground path (runner → verification → commit on verified success or hard reset to `baseHead` on failure), persists `result_path` / `error_path` artifact pointers, emits `job.succeeded` / `job.failed`, runs the idempotent completion reducer (`continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), and releases the repo lock with the appropriate `recovery_status`. CLI exits with a deterministic `code: no_work | not_executed | ran_job` JSON result. The NGX-276 `stalePreCheck` runs before every claim and surfaces stale leases without auto-releasing them; manual-recovery metadata leaves the goal blocked behind `momentum recovery clear`. See [`docs/worker-run.md`](docs/worker-run.md) for the full pipeline, event surfaces, reducer outcomes, `RunnerAdapter` dispatch, and interrupt policy.

### `daemon start`, `daemon stop`, `daemon status`

```text
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
momentum daemon status [--data-dir <path>] [--json]
```

`daemon start` records a new orchestrator run in `daemon_runs` — register-only by default (NGX-272), or opting into the NGX-273 managed loop with `--max-loop-iterations` / `--max-idle-cycles` to drain queued jobs in-process until a bound, stop request, stop-now, or terminal state; the concurrency guard surfaces `daemon_already_active`. `daemon stop` records a graceful `stop_requested` or an immediate `--now` stop (managed loop exits as `canceled` instead of `stopped`), is idempotent on repeat (`alreadyStopRequested` / `alreadyStopNow`), refuses with `no_active_daemon` when nothing is running, and never kills an external process. `daemon status` is a read-only inspector that surfaces the active or most-recent terminal run plus `staleAfterMs` / `staleLeaseGraceMs`, `staleRepoLocks`, `staleClaimedJobs`, and `goalsNeedingRecovery`; auto-recovery happens on managed `daemon start`, not here. See [`docs/daemon.md`](docs/daemon.md) for the full register-only / managed-loop JSON envelopes, the `loop.exitReason` taxonomy, the `loop.startupRecovery` summary, and the `daemon status` field reference.

### `recovery clear`

```text
momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]
```

Clears the `needs_manual_recovery` flag on a goal so it becomes eligible for queue claims again. Refuses safely with `goal_not_found`, `not_flagged`, or `job_active` (the last includes `activeJobIds`). On success, releases any repo locks for the goal in `needs_manual_recovery` state and appends a `goal.recovery_cleared` audit event; the `recovery.md` artifact is intentionally left on disk as durable evidence. See [`docs/recovery.md`](docs/recovery.md) for the full success / refusal JSON envelopes and the refusal-code taxonomy.

### `doctor`

```text
momentum doctor [--repo <path>] [--data-dir <path>] [--json]
```

Reports CLI version, Node.js version, platform, the current milestone scope label, a compact daemon-readiness block read from `daemon_runs`, the built-in runner catalog, the repo's `MOMENTUM.md` policy state (when `--repo` is supplied), and aggregate `sources` / `evidence` counts for the selected data directory. Useful as a first sanity check after install, as a quick orchestrator-health probe, and as a way to validate a repo's policy file in isolation. See [`docs/doctor.md`](docs/doctor.md) for the full JSON envelope, the runners / policy / effective-intent-apply / sources / evidence sub-blocks, and the stable error-code taxonomy for policy-file load failures.

### Recovery surfaces (NGX-276, NGX-277)

The stale-lease auto-recovery contract (NGX-276), the manual recovery artifacts and `needs_manual_recovery` flag (NGX-277), the CLI surfaces (`daemon start` `loop.startupRecovery`, `daemon status`, `doctor`, `status`, `handoff`, `worker run` `stalePreCheck`), and the `momentum recovery clear` flow live in [`docs/recovery.md`](docs/recovery.md).

## Data Directory

State is resolved as `--data-dir <path>` > `MOMENTUM_HOME` > `~/.momentum`. Each goal lives in its own `goals/<goal-id>/` artifact tree alongside a shared `momentum.db` SQLite database. See [`docs/data-directory.md`](docs/data-directory.md) for the full layout (SQLite tables, per-goal and per-iteration artifact files, initialization lifecycle, and operational invariants).

```text
<data-dir>/
  momentum.db                  # SQLite (goals, jobs, events, repo_locks, daemon_runs, source_items, source_snapshots, source_reconciliation_runs, evidence_records, update_intents tables)
  goals/
    <goal-id>/
      goal.md                  # Canonical copy of the goal spec
      ledger.md                # Append-only iteration ledger
      handoff.md               # Populated by `handoff` (empty placeholder until then)
      handoff.json             # Populated by `handoff` (schema v1)
      recovery.md              # Populated when a goal is flagged for manual recovery
      iterations/
        <n>/
          prompt.md            # Rendered iteration prompt
          runner.log           # Runner metadata and captured stdout/stderr
          verification.log     # Tagged verification command output, capped buffer
          result.json          # Default runner result envelope; trusted-shell / acp may report another in-dir result file
```

## Failure and Reset Semantics

Momentum treats each iteration as a transaction over the target repo with a `baseHead` snapshot captured before the runner runs. The per-iteration outcome matrix (`committed`, `reset_runner_failure`, `reset_verification_failure`, `commit_failed`, `reset_failed`, `manual_recovery`), runner failure-code taxonomy, manual-recovery reasons, early-pipeline error codes, and `verification.log` capture rules live in [docs/failure-reset.md](docs/failure-reset.md).

## End-to-end Walkthrough

A copy-paste-runnable smoke that drives a fresh disposable run through the queued default path (`goal start` → `worker run` → `status` / `logs` / `handoff`), the M3 managed daemon drain alternative (`daemon start --max-idle-cycles`), and the Milestone 1 foreground debug path (`--foreground`) lives at [docs/walkthrough.md](docs/walkthrough.md). It also documents the failure-reset path (flip `verification` to `["false"]`) and the `verification.log` / `errorPath` artifacts.

## Milestone 3 Alignment

Milestone 3 (Operational Safety) is complete. See [`docs/milestones/m3-operational-safety.md`](docs/milestones/m3-operational-safety.md) for the full M3 contract (durable primitives, locked decisions, planned issue order, explicit non-goals, and the Symphony adopt / avoid mapping).

## Milestone 4 Roadmap

Real runner profiles and the runtime `MOMENTUM.md` policy loader shipped in Milestone 4 (NGX-279..NGX-286). Milestone 4 (Real Runner Profiles) is complete. See [`docs/milestones/m4-real-runners.md`](docs/milestones/m4-real-runners.md) for the full M4 contract (runner architecture, runner family, planned issue order, explicit non-goals, and the M3 contracts preserved through M4).

## Milestone 5 Roadmap

Milestone 5 (Source Adapters and Evidence Sync) is complete. See [`docs/milestones/m5-source-adapters.md`](docs/milestones/m5-source-adapters.md) for the full M5 contract (vocabulary, trust boundary, composition with M3 / M4 surfaces, planned issue order, and explicit non-goals).

## Current Exclusions

The full list of deferred surfaces — background runner supervision,
cooperative mid-job shutdown, manual recovery beyond safe local cases,
worktree / remote-git operations, automatic external integrations, dashboard /
UI surface, and strong sandboxing — lives in
[`docs/exclusions.md`](docs/exclusions.md). M6 (Policy-Gated External Apply)
introduces gated external writes through the two-phase apply contract in
[`docs/contracts/intent-apply.md`](docs/contracts/intent-apply.md); autonomous /
background external writes and non-Linear adapters remain explicit non-goals.
