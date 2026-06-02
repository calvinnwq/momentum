# Current Exclusions

This page lists features and behaviors that are intentionally **out of scope**
after the M9-00 decision gate and the M10 workflow-first implementation start.
The most recently shipped milestone is M8 closeout, Milestone 9 remains
foundation work, and Milestone 10 has started landing implementation slices. It
exists so contributors and
operators can see at a glance what Momentum does *not* do today, what the
current milestone now owns, and what remains explicitly deferred.

Milestone status:

- **Milestone 3 (Operational Safety)** is complete. See
  [`internal/milestones/m3-operational-safety.md`](milestones/m3-operational-safety.md).
- **Milestone 4 (Real Runner Profiles)** is complete and absorbed runner
  profiles plus the runtime `MOMENTUM.md` policy loader. See
  [`internal/milestones/m4-real-runners.md`](milestones/m4-real-runners.md) and
  [`docs/runners.md`](../docs/runners.md).
- **Milestone 5 (Source Adapters and Evidence Sync)** is complete and added
  read-only source reconciliation, local evidence ingestion, project rollups,
  and durable external-update intents. See
  [`internal/milestones/m5-source-adapters.md`](milestones/m5-source-adapters.md).
- **Milestone 6 (Policy-Gated External Apply)** is complete and added the
  two-phase Linear external apply path: durable claim/audit/finalize lifecycle,
  per-intent CAS guard with `intent_apply_in_progress`, comment-only default,
  stable idempotency marker, blocked / audit-incomplete recovery surfaces, and
  single-issue post-apply reconcile. See
  [`internal/milestones/m6-external-apply.md`](milestones/m6-external-apply.md) and
  [`internal/contracts/intent-apply.md`](contracts/intent-apply.md).
- **Milestone 7 (OpenClaw Coding Workflow Backend)** is complete. M7 made
  Momentum the durable run substrate (`WorkflowRun`, step state, approvals,
  leases, evidence pointers) for OpenClaw coding workflows without replacing
  the `coding-workflow-pipeline` skill's executors, Discord delivery, or
  monitor cron. Shipped slices: the `workflow_runs` / `workflow_steps` /
  `workflow_approvals` / `workflow_leases` schema migration, the
  `WorkflowRun` identity columns, the pure run / step state vocabulary plus
  transition reducer, the lease-aware `deriveWorkflowRunState`, and the
  `classifyWorkflowLease` freshness classifier (NGX-313); the
  `workflow import` CLI envelope and its built-CLI smoke coverage (NGX-314);
  the pure `WorkflowStepExecutor` boundary with typed input / result /
  checkpoint / artifact shapes, the registry keyed by `WorkflowStepKind`,
  the stable error code taxonomy, and the deterministic fake executors per
  kind (NGX-315); the pure `deriveWorkflowMonitorState` reducer
  (`src/workflow-monitor-state.ts`) with per-lease freshness view,
  last-checkpoint visibility, monitor-advisory drift classification,
  deterministic machine-readable `nextAction` codes, and the recovery
  taxonomy `stale_running_step` / `ghost_active_no_lease` /
  `manual_recovery_lease` / `monitor_drift_stale` / `failed_required_step`,
  with terminal ledger evidence beating a stale monitor advisory (NGX-316);
  the read-only `workflow status` and `workflow handoff` CLI envelopes
  (`src/workflow-status.ts`, `src/workflow-handoff.ts`) with stable JSON
  field names, refusal taxonomy, and a `schemaVersion: 1` handoff field
  composed on top of the monitor reducer (NGX-317); and the end-to-end
  built-CLI smoke (`test/smoke.test.ts`) driving a fresh
  `.agent-workflows/<runId>/` fixture through the deterministic fake
  executors and re-imported between steps via `workflow import`, covering
  happy-path completion, evidence linkage through `workflow handoff` after
  `evidence ingest`, and a failure path proving no ghost active / blocked
  run (NGX-318). NGX-319 closed the milestone, added the regression matrix
  at [`internal/regression-matrix.md`](regression-matrix.md), aligned the
  contract tests, and flipped the `doctor --json` milestone marker forward
  from the M6 closeout string to the M7 closeout string. See
  [`internal/milestones/m7-openclaw-coding-workflow-backend.md`](milestones/m7-openclaw-coding-workflow-backend.md)
  and [`internal/contracts/workflow-runs.md`](contracts/workflow-runs.md).
- **Milestone 8 (Workflow Run Operator Controls)** is complete (closed out
  at NGX-330; NGX-323 pinned the M8 contract slice). M8 layers operator-control CLI
  envelopes — `workflow run list` (NGX-324), `workflow run approve` (NGX-325),
  `workflow run update-step` (NGX-326), `workflow run clear-recovery`
  (NGX-327), and `workflow run monitor` (NGX-328) —
  on top of the M7 substrate, adds per-run `.agent-workflows/<runId>/recovery.md`
  rendering plus the `WorkflowRun.needs_manual_recovery` durable flag
  (NGX-327), adds additive `workflow_runs` monitor-advisory columns for
  import / operator-control snapshots (NGX-328), and adds typed `runId` /
  `stepId` evidence linkage to `evidence_records` (NGX-329) without
  renaming or replacing any M3–M7 contract. The
  `doctor --json` milestone marker stayed pinned to the M7 closeout string
  through every M8 implementation slice; NGX-330 (M8-07) flipped it forward
  to the M8 closeout string. See
  [`internal/milestones/m8-workflow-run-operator-controls.md`](milestones/m8-workflow-run-operator-controls.md)
  and [`internal/contracts/workflow-operator-controls.md`](contracts/workflow-operator-controls.md).
- **Milestone 9 (Live Workflow Execution)** remains valid foundation work after
  the M9-00 decision gate (NGX-331). M9 owns the Momentum-side live executor
  wrappers around the existing OpenClaw engines, the live step lease /
  heartbeat / result-file contract, verification and commit transaction wiring,
  live recovery / resume smoke coverage, and the dogfood run. M9 wraps the
  existing engines and does not rewrite them. The start surface is part of the
  M9 design decision, superseded for future workflow-first work by M10: `goal
  start` remains a compatibility path, while first-class workflow run start is a
  later M10 slice. The `doctor --json` marker remains on the M8 closeout string
  until a real milestone closeout slice flips it. See
  [`internal/milestones/m9-live-workflow-execution.md`](milestones/m9-live-workflow-execution.md)
  and [`internal/contracts/live-workflow-execution.md`](contracts/live-workflow-execution.md).
- **Workflow-first runtime pivot** is an accepted planning contract. It
  reframes the future product model around
  `WorkflowDefinition`, `WorkflowRun`, `StepDefinition`, `StepRun`, and
  pluggable executors such as `goal-loop` and `no-mistakes`. M9 remains
  foundation work; M10 has started landing definition schema and persistence
  primitives, while first-class start / execution behavior for general-purpose
  configurable workflows stays deferred until the relevant M10 implementation
  slices land. See
  [`internal/milestones/m10-workflow-first-runtime.md`](milestones/m10-workflow-first-runtime.md),
  [`internal/contracts/workflow-first-runtime.md`](contracts/workflow-first-runtime.md),
  [`internal/contracts/executor-loop.md`](contracts/executor-loop.md), and
  [`internal/contracts/workflow-first-gap-matrix.md`](contracts/workflow-first-gap-matrix.md).

The following surfaces remain deferred outside the M10 definition / persistence
slice so the runner-boundary, policy-loading, and M5 read-first source surfaces
stay scoped.

## Background runner supervision

NGX-272 landed `daemon start` / `daemon stop` / `daemon status` as
orchestrator-state contracts; NGX-273 wired an opt-in managed loop on
`daemon start` that drains queued goal iterations in-process by composing
`runWorkerOnce`. Background detachment / supervision (forking, daemonization,
restart-on-crash) remains out of scope.

## Cooperative shutdown

NGX-274 surfaces the daemon stop-request state in `status --json` / text and
`handoff` JSON / markdown so operators can see why work is not draining without
running `daemon status` separately; the daemon loop test suite covers
stop-between-jobs observation. NGX-275 adds `daemon stop --now` as an immediate
stop request observed between daemon-loop cycles, with a `canceled` terminal
state and cancel-outcome visibility. Stop commands still do not signal, kill,
or otherwise terminate any running runner, worker, or external process; mid-job
cancellation and a full cooperative-shutdown handshake are deferred.

## Manual recovery beyond safe local cases

Automatic stale-lease recovery landed in NGX-276: the managed `daemon start`
loop runs a one-shot startup-recovery pass that auto-releases stale repo locks
owned by terminal jobs, re-pends orphaned stale claims whose repo state is
clean, and auto-finalizes idle stale `daemon_runs` rows; dirty / active /
ambiguous cases (`job_running`, `daemon_active`, `lock_active`, `repo_dirty`,
`repo_unknown_commit`, `repo_unavailable`, `job_state_changed`,
`active_job_present`, `active_lock_present`, `self`, `run_state_changed`) are
surfaced through a stable skip taxonomy. NGX-277 adds the manual-recovery path
for blocked stale claims, and M4 also uses it for iteration-time HEAD movement:
`repo_dirty`, `repo_unknown_commit`, `repo_unavailable`, `job_running`,
`runner_changed_head`, and `head_mismatch` write `recovery.md`, set
`needs_manual_recovery`, block future queue claims, and remain visible through
`status`, `handoff`, `daemon status`, and `doctor` until an operator runs
`recovery clear`. See [`docs/recovery.md`](../docs/recovery.md) for the full surface.

## Single-shot worker

`worker run` remains a single-shot consumer that processes one claimed job per
invocation and then exits; the NGX-273 managed loop is the bounded
continuous-draining path on `daemon start`.

## Configurable workflow execution beyond OpenClaw coding workflows

The workflow-first runtime pivot is accepted in
[`internal/contracts/workflow-first-runtime.md`](contracts/workflow-first-runtime.md),
with executor-loop details pinned in
[`internal/contracts/executor-loop.md`](contracts/executor-loop.md) and
current-to-target planning pinned in
[`internal/contracts/workflow-first-gap-matrix.md`](contracts/workflow-first-gap-matrix.md),
with M10 planning pinned in
[`internal/milestones/m10-workflow-first-runtime.md`](milestones/m10-workflow-first-runtime.md),
and M10 has begun landing reusable workflow / step definition schema and
persistence. First-class start, execution, and generalized `WorkflowRun`
behavior remain deferred until the relevant M10 implementation slices land.
Until then, the shipped executable `WorkflowRun` substrate remains scoped to the
OpenClaw coding-workflow backend and the M9 live-wrapper foundation.

## Worktree management and remote git operations

Worktree management, per-source-item worktrees / workspaces, remote git
operations (`fetch`, `pull`, `push`, `rebase`), and parallel same-repo Goals
are all out of scope.

## Automatic external integrations

Automatic PR / GitHub / Linear automation, autonomous tracker writes,
inbound webhooks, and other automation-driven external integrations are out of
scope. M6 shipped policy-gated external apply for Linear via a two-phase
claim / audit-before-write / external write / finalize flow (see
[`internal/contracts/intent-apply.md`](contracts/intent-apply.md)), but every
external write stays operator-mediated through `intent apply --external-apply`,
gated by `MOMENTUM.md` `intent_apply_policy`, scoped to the touched issue, and
comment-only unless target status mutation is explicitly configured.
Background / autonomous external writes, inbound webhooks, and non-Linear
external write adapters remain deferred after M6 closeout.

## Dashboard or UI surface

A dashboard or other UI surface beyond the CLI JSON / text outputs is out of
scope.

## Strong sandboxing

Strong sandboxing (container / VM / seccomp isolation) is out of scope; M4's
`trusted-shell` and `acp` runners are explicitly trusted, not sandboxed.
