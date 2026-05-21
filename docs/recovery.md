# Recovery surfaces

Momentum's operational-safety surfaces ship three operator-facing recovery
contracts that are intentionally separate but composed by the same CLI surfaces:

- **Stale-lease detection and auto-recovery** — what Momentum can prove is
  safe to release, re-pend, or finalize, and the stable skip taxonomy for
  everything it refuses.
- **Manual recovery artifacts and the durable `needs_manual_recovery` flag** —
  what Momentum writes to disk and blocks at the queue when an auto-recovery
  refusal would lose audit context or risk a non-Momentum commit.
- **Intent apply blocked state** — the durable per-intent `apply_state =
  'blocked'` flag set when `intent apply --external-apply` lands a partial
  external write but cannot finalize its audit row.

This page is the canonical reference for all three.

## Stale-lease detection and auto-recovery

Momentum detects stale leases on three durable surfaces and auto-recovers only
those it can prove are safe; everything else is surfaced for explicit manual
recovery.

| Surface | Stale condition | Auto-recovery action | Skip reasons (manual recovery) |
|---|---|---|---|
| Repo lock (`repo_locks`) | `state = 'active'` AND `lease_expires_at < now - staleLeaseGraceMs` | Released when the owning job is terminal (`succeeded` / `failed`); emits `repo_lock.recovered` and stamps `recovery_status = 'auto_released_job_terminal'`. | `job_pending` / `job_claimed` / `job_running` / `job_missing`. |
| Claimed/running `goal_iteration` job (`jobs`) | `state IN ('claimed', 'running')` AND `lease_expires_at < now - staleLeaseGraceMs` | Safe stale `claimed` jobs are re-pended without losing `attempt_count` or idempotency key; emits `job.recovered` with `recovery_status = 'auto_repended_stale_claim'`. `running` jobs are skipped. | `job_running` (in-flight repo writes), `daemon_active` (live owner), `lock_active` (held lock), `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` (repo-state safety refusal), `job_state_changed` (concurrent update race). |
| Daemon record (`daemon_runs`) | Active state (`starting` / `running` / `stop_requested`) AND `heartbeat_at` is older than `staleAfterMs` (90s idle / 930s with `active_job_id`) | Finalized to `error` terminal with `recovery_status = 'auto_recovered_idle_stale'` when `active_job_id` and `active_lock_id` are both `NULL`. | `self` (caller's own run), `active_job_present` (delegates to job-side recovery), `active_lock_present` (delegates to lock-side recovery), `run_state_changed` (concurrent update race). |

The managed `daemon start` loop runs a one-shot `runStartupRecovery` pass before
its first cycle. All three primitives are independently idempotent, share one
observed `now`, and emit structured recovery events (where the events schema's
non-empty `goal_id` constraint allows). The CLI surfaces them at:

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
not cleared by `momentum recovery clear`. A dedicated operator surface for
clearing intent-side `blocked` is not yet shipped — operators inspect the
audit row, confirm the external write's actual effect on the tracker, and
keep the intent blocked until that surface lands.

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
