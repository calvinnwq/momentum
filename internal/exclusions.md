# Current Exclusions

This page lists features and behaviors that are intentionally **out of scope**
as of the most recently shipped milestone (M6 closeout) and through the
currently active milestone (M7, active / in flight). It exists so contributors and
operators can see at a glance what Momentum does *not* do today, and where
the next durable surface is expected (or explicitly deferred indefinitely).

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
- **Milestone 7 (OpenClaw Coding Workflow Backend)** is active / in flight.
  The first substrate slices have shipped (the `workflow_runs` /
  `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration,
  the `WorkflowRun` identity columns, the run / step state vocabulary plus
  transition reducer, the lease-aware `deriveWorkflowRunState`, and the
  `classifyWorkflowLease` lease-freshness classifier), the first M7 CLI
  envelope `workflow import` (NGX-314) plus its built-CLI smoke coverage have
  landed, the pure `WorkflowStepExecutor` boundary (NGX-315) — typed
  input / result / checkpoint / artifact shapes, registry keyed by
  `WorkflowStepKind`, stable error code taxonomy, and deterministic fake
  executors per kind — has landed, with thin wrappers around live local
  command paths deferred to a follow-up slice, and the first NGX-316 (M7-04)
  slice has landed the pure `deriveWorkflowMonitorState` reducer
  (`src/workflow-monitor-state.ts`): active-step pick, per-lease freshness
  view, last-checkpoint visibility, monitor-advisory drift classification,
  deterministic machine-readable `nextAction` codes, the recovery taxonomy
  (`stale_running_step` / `ghost_active_no_lease` / `manual_recovery_lease` /
  `monitor_drift_stale` / `failed_required_step`), and the contract invariant
  that terminal ledger evidence beats stale monitor snapshots. M7 turns
  Momentum into the durable run substrate (`WorkflowRun`, step state,
  approvals, leases, evidence pointers) for OpenClaw coding workflows
  without replacing the `coding-workflow-pipeline` skill's executors,
  Discord delivery, or monitor cron. M7 is not complete; the per-run
  `recovery.md` renderer, the `WorkflowRun.needs_manual_recovery` durable
  flag persistence, the remaining M7 CLI envelopes
  (`workflow run start|status|list|approve|update-step|monitor`),
  additional built-CLI smoke coverage, and the `doctor --json` milestone
  marker flip remain pending, so the `doctor --json` milestone marker stays
  at the M6 closeout string until M7 closeout flips it forward. See
  [`internal/milestones/m7-openclaw-coding-workflow-backend.md`](milestones/m7-openclaw-coding-workflow-backend.md)
  and [`internal/contracts/workflow-runs.md`](contracts/workflow-runs.md).

The following surfaces remain deferred so the runner-boundary, policy-loading,
and M5 read-first source surfaces stay scoped.

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
