# Current Exclusions

This page lists features and behaviors that are intentionally **out of scope**
through the active milestone. It exists so contributors and operators can see at
a glance what Momentum does *not* do today, and where the next durable surface
is expected (or explicitly deferred indefinitely).

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
- **Milestone 6 (Policy-Gated External Apply)** is the active milestone. See
  [`internal/milestones/m6-external-apply.md`](milestones/m6-external-apply.md) and
  [`internal/contracts/intent-apply.md`](contracts/intent-apply.md).

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

Automatic PR / GitHub / Linear automation, external tracker writes,
inbound webhooks, and other external integrations driven from inside Momentum are out
of scope through M5. M5 may read configured sources and generate durable update
intents, but it must not apply external writes automatically. M6 introduces
policy-gated external apply through a two-phase claim / audit-before-write /
external write / finalize flow (see
[`internal/contracts/intent-apply.md`](contracts/intent-apply.md)), still scoped to
the touched issue and still gated by `MOMENTUM.md` policy; autonomous /
background external writes and non-Linear adapters remain explicit M6
non-goals.

## Dashboard or UI surface

A dashboard or other UI surface beyond the CLI JSON / text outputs is out of
scope.

## Strong sandboxing

Strong sandboxing (container / VM / seccomp isolation) is out of scope; M4's
`trusted-shell` and `acp` runners are explicitly trusted, not sandboxed.
