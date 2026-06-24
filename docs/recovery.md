# Recovery surfaces

Momentum's operational-safety surfaces ship four operator-facing recovery
contracts that are intentionally separate but composed by the same CLI surfaces:

- **Stale-lease detection and auto-recovery** — what Momentum can prove is
  safe to release, re-pend, or finalize, and the stable skip taxonomy for
  everything it refuses.
- **Manual recovery artifacts and the durable `needs_manual_recovery` flag** —
  what Momentum writes to disk and blocks at the queue when an auto-recovery
  refusal would lose audit context or risk a non-Momentum commit.
- **Run-scoped workflow recovery** — what Momentum writes under
  `.agent-workflows/<run-id>/` when monitor-derived blockers, live workflow
  dispatch / finalization failures, or stale workflow leases require operator
  action.
- **Intent apply blocked state** — the durable per-intent `apply_state =
  'blocked'` flag set when `intent apply --external-apply` lands a partial
  external write but cannot finalize its audit row.

This page is the canonical reference for all four.

## Stale-lease detection and auto-recovery

Momentum detects stale leases on the durable surfaces below and auto-recovers
only those it can prove are safe; everything else is surfaced for explicit
manual recovery. The daemon startup pass covers the first three surfaces; the
workflow scheduler lane handles `workflow_leases` during enabled scheduler
ticks.

| Surface | Stale condition | Auto-recovery action | Skip reasons (manual recovery) |
|---|---|---|---|
| Repo lock (`repo_locks`) | `state = 'active'` AND `lease_expires_at < now - staleLeaseGraceMs` | Released when the owning job is terminal (`succeeded` / `failed`); emits `repo_lock.recovered` and stamps `recovery_status = 'auto_released_job_terminal'`. | `job_pending` / `job_claimed` / `job_running` / `job_missing`. |
| Claimed/running `goal_iteration` job (`jobs`) | `state IN ('claimed', 'running')` AND `lease_expires_at < now - staleLeaseGraceMs` | Safe stale `claimed` jobs are re-pended without losing `attempt_count` or idempotency key; emits `job.recovered` with `recovery_status = 'auto_repended_stale_claim'`. `running` jobs are skipped. | `job_running` (in-flight repo writes), `daemon_active` (live owner), `lock_active` (held lock), `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` (repo-state safety refusal), `job_state_changed` (concurrent update race). |
| Daemon record (`daemon_runs`) | Active state (`starting` / `running` / `stop_requested`) AND `heartbeat_at` is older than `staleAfterMs` (90s idle / 930s with `active_job_id`) | Finalized to `error` terminal with `recovery_status = 'auto_recovered_idle_stale'` when `active_job_id` and `active_lock_id` are both `NULL`. | `self` (caller's own run), `active_job_present` (delegates to job-side recovery), `active_lock_present` (delegates to lock-side recovery), `run_state_changed` (concurrent update race). |
| Workflow lease (`workflow_leases`) | Non-released `monitor`, `managed-step`, or `dispatch` lease with `expires_at < now - graceMs` during an enabled workflow scheduler tick | `auto-release` leases are released in place and the run state is re-derived; emits `auto_released_stale_workflow_lease`. A stale dispatch lease with terminal executor evidence is reconciled first so the owning step finalizes from that evidence before release. | `manual-recovery-required` leases leave the lease as evidence, set the run-scoped `needs_manual_recovery` flag with `stale_workflow_lease_manual_recovery_required`, and render run-scoped `recovery.md` best-effort. A stale dispatch lease over a still-`running` step with no terminal dispatch evidence is parked for run-scoped manual recovery and then released so future work is not suppressed. Concurrent row changes surface as `lease_changed` / `run_not_found`. |

The managed `daemon start` loop runs a one-shot `runStartupRecovery` pass before
its first cycle. Those three startup primitives are independently idempotent,
share one observed `now`, and emit structured recovery events (where the events
schema's non-empty `goal_id` constraint allows). Workflow lease recovery is a
per-scheduler-tick lane over `workflow_leases`, also idempotent, and is surfaced
through workflow run state and scheduler-lane telemetry rather than the startup
recovery block. The CLI surfaces startup recovery at:

- `daemon start --max-loop-iterations N` JSON response — `loop.startupRecovery`
  with `observedAt`, `graceMs`, recovered counts, and skipped arrays for repo
  locks, claimed jobs, and daemon runs.
- `daemon status --json` / text — current `staleRepoLocks`, `staleClaimedJobs`,
  and `staleRuns` rows, with `staleLeaseGraceMs` (5s default skew tolerance).
- `doctor --json` / text — compact counts: `staleRunCount`,
  `staleRepoLockCount`, `staleClaimedJobCount`.
- `status --json` / text and `handoff` — goal-scoped `staleRecovery` block with
  `recoveredRepoLockCount`, `recoveredJobCount`, `latestRecoveredRepoLockAt`,
  `latestRecoveredJobAt`, current `staleRepoLockCount`, current
  `staleClaimedJobCount`, and `staleLeaseGraceMs`; markdown handoff includes a
  `## Stale recovery` section.
- `worker run --json` / text — pre-claim `stalePreCheck` snapshot listing stale
  repo locks and claimed/running jobs observed before the worker attempts to
  claim a job.

Manual recovery is the operator-driven path for everything that lands in a skip
taxonomy. Stale-claim skip reasons (`repo_dirty`, `repo_unknown_commit`,
`repo_unavailable`, `job_running`) and iteration-time HEAD movement
(`runner_changed_head`, `head_mismatch`) write a goal-scoped `recovery.md`
artifact and set a durable `needs_manual_recovery` flag on the goal row; the
flag blocks future queue claims until an operator explicitly clears it via
`momentum recovery clear`. Skip reasons that indicate live ownership
(`daemon_active`, `lock_active`, `job_state_changed`) do not produce an
artifact since they resolve on their own.

## Manual recovery artifacts and flag

When the daemon's startup-recovery pass or manual inspection identifies a stale
claim that cannot be auto-recovered (because the repo is dirty, HEAD is
unresolvable, the repo path is missing, or the job is still in a `running`
state), or when iteration execution detects runner/finalization HEAD movement,
Momentum writes a `recovery.md` artifact to the goal's artifact directory and
sets a durable `needs_manual_recovery` flag on the goal row. The flag blocks
`claimPendingGoalIterationJob` from claiming any pending iteration for that
goal until the operator explicitly clears it.

The `recovery.md` artifact contains:

- Schema version, goal ID, job ID, iteration, daemon run ID, repo path
- The reason code and human-readable message (`repo_dirty`,
  `repo_unknown_commit`, `repo_unavailable`, `job_running`,
  `runner_changed_head`, or `head_mismatch`)
- Commit pointers (expected pre-iteration commit vs current commit)
- Paths to relevant iteration artifacts (prompt, runner log, verification log,
  result JSON)
- A Runner/profile section with the configured runner plus command, args, cwd,
  timeout, and result-file metadata when available
- Safe next steps with actionable guidance

The flag is surfaced in the queue claim filter so flagged goals are invisible
to `worker run` and `daemon start` loop claims. Operators can detect flagged
goals via:

- `daemon status --json` — `goalsNeedingRecovery` array with `goalId`, `title`,
  `goalState`, `recoveryMdPath`, and `recoveryMdExists`
- `doctor --json` — `goalsNeedingRecoveryCount` compact count
- `status --json` — `nextActionDetail.kind` = `manual_recovery_required`;
  `artifacts.recoveryMd` and `artifactFiles.recoveryMd` show the evidence file
  path/presence separately
- `handoff.json` — `next_action_detail.kind` = `manual_recovery_required`;
  `artifacts.recovery_md` and `artifact_files.recovery_md` show the evidence
  file path/presence separately

`recovery.md` presence is not equivalent to the durable flag: `recovery clear`
leaves the artifact on disk as evidence after the goal is unblocked.

The operator acknowledgement flow is
`momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]`,
which:

1. Checks that the goal exists and is currently flagged (`not_flagged`
   otherwise).
2. Checks that no claimed/running jobs hold the goal (`job_active` with
   `activeJobIds` otherwise).
3. Clears `needs_manual_recovery`, `manual_recovery_reason`, and
   `manual_recovery_at` on the goal row.
4. Releases repo locks for the goal that are in `needs_manual_recovery` state.
5. Appends a `goal.recovery_cleared` audit event with the previous reason,
   previous marked-at timestamp, cleared-at timestamp, optional
   `operatorReason`, and released lock IDs.
6. Leaves `recovery.md` on disk as durable evidence (operators remove it
   manually after capturing context).

On successful clear, the goal immediately becomes eligible for queue claims
again.

## Run-scoped workflow recovery

Workflow runs have a sibling manual-recovery surface scoped to
`.agent-workflows/<run-id>/`. `workflow import` re-derives the run's monitor
view after persisting rows; when the durable substrate still has a blocking
condition (`manual_recovery_lease`, `ghost_active_no_lease`,
`stale_running_step`, `failed_required_step`, or
`failed_external_side_effect_step`), Momentum sets
`workflow_runs.needs_manual_recovery` and renders
`<run-dir>/recovery.md`. Live workflow execution uses the same durable flag and
artifact when dispatch or finalization cannot safely continue, preserving stable
classifications such as `head_mismatch`, `result_missing`, `repo_lock_lost`,
`auth_unavailable`, and `executor_threw`. The workflow scheduler dispatcher also
uses this run-scoped surface when a claimed step cannot be resolved to a known
definition step or uses an executor family the daemon cannot dispatch yet; that
path opens a `manual_recovery_required` workflow gate instead of silently dropping
the claim. The daemon-dispatchable `external-apply` path uses the same surface
when issue scope, pending-intent matching, credentials, policy, audit, or adapter
safety checks refuse the write. The configured `subworkflow` path uses the same
surface when child config is missing, recursion is unsafe, a child definition or
attachment cannot be trusted, or child state cannot be mirrored safely. The
configured live-wrapper dispatch lane uses the same surface when the wrapper is
unconfigured for the claimed step kind, the step's repo/run directory cannot be
derived, the run directory cannot be created, or a live wrapper returns a
process-level failure such as `runtime_unavailable`. If
the claimed run row has vanished, Momentum cannot write a run-scoped flag or
gate without orphaning evidence, so it releases the lingering dispatch lease
only. Stale `manual-recovery-required` workflow leases use the same surface;
stale `auto-release` workflow leases are usually released, but a stale running
dispatch without terminal evidence is parked for manual recovery before release.

The run-scoped flag blocks `workflow run approve` and any
`workflow run update-step` transition that would leave the blocking recovery
condition in place. A resolving `workflow run update-step` transition can land
while the flag remains set so the operator has a safe path to resolve the run
and then clear the flag explicitly.

Operators clear run-scoped recovery with
`momentum workflow run clear-recovery <run-id> [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]`.
The clear re-checks the durable monitor view in the same transaction and
refuses with `recovery_clear_refused` while a monitor-derived blocking condition
remains, or `not_flagged` when the run is not currently flagged and no
evidence-backed external-tail reconciliation applies.
The command leaves the run's `recovery.md` artifact on disk as audit evidence.

For live dispatch / finalization recovery, the same flag and artifact may hold
non-monitor classifications. `workflow run clear-recovery` still rechecks and
refuses monitor-derived blockers atomically, but clearing these live recovery
sources is the operator's assertion that the stored reason and `recovery.md`
guidance have been resolved. Scheduler-lane stale `manual-recovery-required`
workflow leases are left outstanding as durable evidence, so the monitor
reducer can still surface `manual_recovery_lease` and guarded clear continues
to refuse until that lease condition is resolved.

When a dispatched `no-mistakes` or `merge-cleanup` live-wrapper attempt failed
before clean runner evidence existed because the wrapper/build path was stale or
unavailable, `workflow run clear-recovery` prepares the step for a scheduler
retry after the operator repairs the environment. The clear output includes
`retryPrepared`; the previous failed executor round remains durable, and an
already-terminal successful step is only reattached/reconciled, not rerun.

When the failed required step is an external-side-effect tail step
(`merge-cleanup` or `linear-refresh`), the monitor view classifies it as
`failed_external_side_effect_step` rather than the generic `failed_required_step`,
and the recommended next action is `clear_recovery` instead of
`rerun_failed_step`.
These tail steps can push a branch, merge a pull request, or write the tracker before exiting non-zero.
After the operator verifies the remote, pull request, and tracker state, `workflow run clear-recovery --evidence-pointer <ref>` marks the tail step `succeeded`, records the operator reconciliation, evidence pointer, and optional `--ledger-pointer` on the step row, refreshes the run state, and clears the durable manual-recovery flag when it was set.
Without `--evidence-pointer`, clear refuses and leaves the failed step plus any recovery flag intact.
That reconciles from external success evidence rather than re-running the step, which could double-merge the pull request or re-write the tracker.

The generated run-scoped `recovery.md` artifact is schema-versioned and
includes the run ID, step ID, recovery classification, repo path, classified-at
timestamp, reason, recommended next action, evidence pointers,
classification-specific safe next steps, and safety / rollback notes. Momentum
overwrites the artifact with the latest recovery classification when import,
live execution, or scheduler-lane stale workflow lease recovery flags the run
again, but does not delete it after `workflow run clear-recovery`. For
non-monitor recovery, the durable flag and stored manual-recovery reason are
authoritative; `recovery.md` rendering is best-effort and may fail while the run
remains blocked.

See [docs/workflow-commands.md](workflow-commands.md) for the full
`workflow import` and `workflow run clear-recovery` envelopes.

## `recovery clear` JSON envelopes

The `recovery clear` command emits a stable JSON shape under `--json`. On
success the response includes the previous flag context and the audit event
written for the clear:

```json
{
  "ok": true,
  "command": "recovery clear",
  "goalId": "<uuid>",
  "dataDir": "/path/to/data-dir",
  "previousReason": "repo_dirty",
  "previousMarkedAt": 1731500000000,
  "clearedAt": 1731500060000,
  "eventId": 42,
  "releasedRepoLockIds": []
}
```

`releasedRepoLockIds` is populated with the IDs of repo locks for the goal
that were released as part of the clear (locks in `needs_manual_recovery`
state); it is an empty array when no locks needed release.

On refusal the response stays JSON-stable with a top-level `code` plus
context for the operator. The refusal codes are:

- `goal_not_found` — the goal ID does not exist in the data directory.
- `not_flagged` — the goal is not currently flagged for manual recovery;
  re-running `recovery clear` on a goal that has already been cleared
  returns this code.
- `job_active` — the goal still has a `claimed` or `running` `goal_iteration`
  job. The response includes `activeJobIds` listing those jobs so operators
  can release or finalize them before retrying the clear.

```json
{
  "ok": false,
  "command": "recovery clear",
  "code": "job_active",
  "message": "Goal <uuid> has 1 active goal_iteration job(s); release or finalize them before clearing manual recovery.",
  "goalId": "<uuid>",
  "dataDir": "/path/to/data-dir",
  "activeJobIds": ["<job-uuid>"]
}
```

Text output mirrors the success shape with `Previous reason`, the
previous-marked-at and cleared-at timestamps, the event ID, and a released
repo locks line when non-empty.

## Intent apply blocked state

When `momentum intent apply --external-apply` succeeds at the external write
but cannot finalize its audit row, the orchestrator transitions the intent's
`apply_state` to `blocked` and returns the `audit_incomplete` refusal code
(see [docs/intent-commands.md](intent-commands.md)). The block prevents any
future `intent apply --external-apply` for that intent — which would otherwise
risk replaying the external write — and surfaces a stable `intent_blocked`
refusal on subsequent attempts.

The blocked state is independent of goal-side `needs_manual_recovery`; it is
not cleared by `momentum recovery clear`. No dedicated operator surface
exists for clearing intent-side `blocked` — operators inspect the audit row,
confirm the external write's actual effect on the tracker, and keep the intent
blocked until an unblock command is introduced.

Operators can detect blocked intents via:

- `momentum intent get <intent-id>` / `momentum intent list` — per-intent
  `externalApply.applyState = "blocked"` plus the `latestAttempt` audit row
  with `lifecycleState = "audit_incomplete"`, `resultCode`, `resultMessage`,
  and `externalRefs` for the write that did reach the tracker.
- `momentum status` / `momentum handoff` — the goal-scoped
  `pendingUpdateIntents` / `pending_update_intents` summary carries each
  pending intent's `externalApply` / `external_apply` block with the same
  `applyState` and `latestAttempt` fields.
- `momentum project status` — `pendingIntentApplyStateCounts.blocked` rolls up
  the count of pending intents currently in `blocked` apply state.
- `momentum doctor` — the `externalApply` audit-ledger aggregate exposes
  blocked counts across the data directory.
