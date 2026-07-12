# Recovery surfaces

Momentum's operational-safety surfaces ship four operator-facing recovery
contracts that are intentionally separate but composed by the same CLI surfaces:

- **Stale-lease detection and auto-recovery** — what Momentum can prove is
  safe to release, re-pend, or finalize, and the stable skip taxonomy for
  everything it refuses.
- **Manual recovery artifacts and the durable `needs_manual_recovery` flag** —
  what Momentum writes to disk when an auto-recovery refusal would lose audit
  context or risk a non-Momentum commit. Goal-scoped rows and artifacts are
  durable compatibility data from the retired goal-first lane that this page's
  `recovery clear` surface still operates over.
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
| Daemon record (`daemon_runs`) | Active state (`starting` / `running` / `stop_requested`) AND `heartbeat_at` is older than `staleAfterMs` (90s idle / 930s with `active_job_id`) | Finalized to `error` terminal with `recovery_status = 'auto_recovered_idle_stale'` when `active_job_id` and `active_lock_id` are both `NULL`; finalized with `recovery_status = 'auto_recovered_stale_workflow_dispatch'` when the only owner pointer is a synthetic workflow-dispatch `active_job_id`, the matching workflow step is unambiguous, no active lock is present, and no fresh unreleased dispatch lease still proves live ownership. | `self` (caller's own run), `active_job_present` (generic active job, active lock paired with a workflow-dispatch job, or a fresh workflow dispatch lease still proves live ownership), `active_lock_present` (delegates to lock-side recovery), `run_state_changed` (concurrent update race). |
| Workflow lease (`workflow_leases`) | Non-released `monitor`, `managed-step`, or `dispatch` lease with `expires_at < now - graceMs` during an enabled workflow scheduler tick | `auto-release` leases are released in place and the run state is re-derived; emits `auto_released_stale_workflow_lease`. A stale dispatch lease with terminal executor evidence is reconciled first so the owning step finalizes from that evidence before release. | `manual-recovery-required` leases leave the lease as evidence, set the run-scoped `needs_manual_recovery` flag with `stale_workflow_lease_manual_recovery_required`, and render run-scoped `recovery.md` best-effort. A stale dispatch lease over a still-`running` step with no terminal dispatch evidence is parked for run-scoped manual recovery and then released so future work is not suppressed. Concurrent row changes surface as `lease_changed` / `run_not_found`. |

The managed `daemon start` path may run a startup-recovery pass before a new
daemon row is registered when the existing active row is already stale, then the
managed loop runs its one-shot `runStartupRecovery` pass before its first cycle.
Those startup primitives are independently idempotent, share one observed `now`
per pass, and emit structured recovery events (where the events schema's
non-empty `goal_id` constraint allows). Workflow lease recovery is a
per-scheduler-tick lane over `workflow_leases`, also idempotent, and is surfaced
through workflow run state and scheduler-lane telemetry rather than the startup
recovery block. A pre-loop daemon-row recovery is merged into the same
`loop.startupRecovery` summary so the JSON envelope shape stays stable. The CLI
surfaces startup recovery at:

- `daemon start --max-loop-iterations N` JSON response — `loop.startupRecovery`
  with `observedAt`, `graceMs`, recovered counts, and skipped arrays for repo
  locks, claimed jobs, and daemon runs.
- `daemon status --json` / text — current `staleRepoLocks`, `staleClaimedJobs`,
  and `staleRuns` rows, with `staleLeaseGraceMs` (5s default skew tolerance).
- `doctor --json` / text — compact counts: `staleRunCount`,
  `staleRepoLockCount`, `staleClaimedJobCount`.

Manual recovery is the operator-driven path for everything that lands in a skip
taxonomy. Stale-claim skip reasons (`repo_dirty`, `repo_unknown_commit`,
`repo_unavailable`, `job_running`) write a goal-scoped `recovery.md` artifact
and set a durable `needs_manual_recovery` flag on the goal row, as did
iteration-time HEAD movement (`runner_changed_head`, `head_mismatch`) while the
retired goal-execution lane still ran; the flag stays set on the stored goal
row until an operator explicitly clears it via `momentum recovery clear`. Skip
reasons that indicate live ownership (`daemon_active`, `lock_active`,
`job_state_changed`) do not produce an artifact since they resolve on their
own.

## Manual recovery artifacts and flag

When the daemon's startup-recovery pass or manual inspection identifies a stale
claim that cannot be auto-recovered (because the repo is dirty, HEAD is
unresolvable, the repo path is missing, or the stored job is still in a
`running` state), Momentum writes a `recovery.md` artifact to the goal's
artifact directory and sets a durable `needs_manual_recovery` flag on the goal
row. The retired goal-execution lane wrote the same artifact and flag when
iteration execution detected runner/finalization HEAD movement, and those
stored artifacts remain durable evidence. The flag stays set on the stored
goal row until the operator explicitly clears it.

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

Operators can detect flagged goals via:

- `daemon status --json` — `goalsNeedingRecovery` array with `goalId`, `title`,
  `goalState`, `recoveryMdPath`, and `recoveryMdExists`
- `doctor --json` — `goalsNeedingRecoveryCount` compact count

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

On successful clear, the stored goal row is durably unflagged; the clear is an
operator acknowledgement over compatibility data, since the retired
goal-execution lane no longer claims queue work.

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
`unsupported_platform`, `auth_unavailable`, and `executor_threw`.
The workflow scheduler dispatcher also uses this run-scoped surface when a
claimed step cannot be resolved to a known definition step or carries an invalid
executor identity; that path opens a `manual_recovery_required` workflow gate
instead of silently dropping the claim.
A valid but unregistered executor identity instead records an invocation and
round at `manual_recovery_required` with `runtime_unavailable`, then workflow
reconciliation parks the run behind its standard
`manual_recovery_required` step gate.
If the configured module for that identity cannot be imported or validated, the
same refusal preserves the precise registry diagnostic in durable round evidence.
The daemon retries failed discovery after recovery is cleared, so repairing the
module does not require a daemon restart.
The daemon-dispatchable `external-apply` path uses the same surface when issue scope, source evidence, deterministic intent seeding, valid payload, resolved target, credentials, policy, audit, or adapter safety checks refuse the write.
The configured `subworkflow` path uses the same surface when child config is missing, recursion is unsafe, a child definition or attachment cannot be trusted, or child state cannot be mirrored safely.
The configured live-wrapper dispatch lane uses the same surface when the wrapper is
unconfigured for the claimed step kind, the step's repo/run directory cannot be
derived, the run directory cannot be created, a repo-local run directory is not
ignored by git, another live-wrapper dispatch owns the repo lock, the repo base
HEAD cannot be read, a live wrapper returns a process-level failure such as
`unsupported_platform` or `runtime_unavailable`, or post-wrapper finalization cannot safely parse the
result, verify, commit, reset, or retain dispatch-lease ownership.
That includes `merge-cleanup` auth, target, PR readback, head mismatch, or
unsafe-state preflight refusal before the wrapper command is spawned, and live
finalization codes such as `result_missing`, `result_invalid`,
`head_mismatch`, `repo_lock_lost`, `git_failed`, `commit_failed`, and
`reset_failed`.
Manual-recovery gates preserve the precise executor-round recovery code as gate
evidence when it is available.
For `unsupported_platform`, move the workflow to Linux or macOS and confirm from
the executor log and worktree that no supervised process ran and no edits were
made.
Clearing recovery after repairing an unsupported or unavailable runtime prepares
the affected dispatched step for one scheduler retry, regardless of step kind or
registered executor name; the retry uses a new attempt
and round while preserving the refused round as durable evidence.
If the claimed run row has vanished, Momentum cannot write a run-scoped flag or gate without orphaning evidence, so it releases the lingering dispatch lease only.
Stale `manual-recovery-required` workflow leases use the same surface;
stale `auto-release` workflow leases are usually released, but a stale running
dispatch without terminal evidence is parked for manual recovery before release.

The run-scoped flag blocks `workflow run approve` and any
`workflow run update-step` transition that would leave the blocking recovery
condition in place. A resolving `workflow run update-step` transition can land
while the flag remains set so the operator has a safe path to resolve the run
and then clear the flag explicitly.
Marking a run for manual recovery appends a `recovery_required` workflow event when the durable recovery reason changes.
Clearing an active run-scoped recovery flag appends a `recovery_cleared` workflow event with the previous reason and timestamp so reconnecting clients can replay the operator boundary through `workflow run events`.

Operators clear run-scoped recovery with
`momentum workflow run clear-recovery <run-id> [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]`.
The clear re-checks the durable monitor view in the same transaction and
refuses with `recovery_clear_refused` while a monitor-derived blocking condition
remains, or `not_flagged` when the run is not currently flagged and no
evidence-backed external-tail or interrupted no-mistakes reconciliation applies.
The command leaves the run's `recovery.md` artifact on disk as audit evidence.

For live dispatch / finalization recovery, the same flag and artifact may hold
non-monitor classifications. `workflow run clear-recovery` still rechecks and
refuses monitor-derived blockers atomically, but clearing these live recovery
sources is the operator's assertion that the stored reason and `recovery.md`
guidance have been resolved. Scheduler-lane stale `manual-recovery-required`
workflow leases are left outstanding as durable evidence, so the monitor
reducer can still surface `manual_recovery_lease` and guarded clear continues
to refuse until that lease condition is resolved.

An `unsupported_platform` refusal is eligible for this retry preparation on any
dispatched step after the run moves to Linux or macOS.
When a dispatched `no-mistakes` or `merge-cleanup` live-wrapper attempt failed
before clean runner evidence existed because the wrapper/build path was stale or
unavailable, or because `merge-cleanup` refused before apply on auth, target,
PR-state readback, expected-head, cleanup-branch, or mergeability checks,
`workflow run clear-recovery` prepares the step for a scheduler retry after the operator repairs the environment or target state.
The clear output includes `retryPrepared`; the previous failed executor round remains durable, and an already-terminal successful step is only reattached/reconciled, not rerun.
Before the step row is reopened for retry, Momentum preserves the previous `step_started` or `step_failed` transition as a workflow event so cursor replay does not lose the overwritten state.
For `no-mistakes`, the coding-workflow wrapper also parks known external runner
lifecycle failures in this same retryable recovery lane: missing branch-start /
gate state and current run status or outcome evidence showing cancellation
before reliable completion.
These are not trusted as verification failures because the external no-mistakes
runner did not produce reliable pass/fail evidence.
When the no-mistakes mirror sees the same running semantic progress digest for four minutes, it parks the mirror round for manual recovery instead of treating repeated polls as fresh progress.
The raw external-state digest still updates in `inputDigest`; the stall decision uses `resultDigest`.
Clear recovery only after the external no-mistakes run produces fresh progress or terminal evidence.
When no-mistakes instead reports `checks-passed`, or is still monitoring while current pull request evidence is clean and checks are green or explicitly absent, the wrapper writes successful runner evidence instead of entering this recovery lane, unless current output also shows a blocking outcome, active finding, unresolved gate, dirty / draft pull request, or non-successful check state.
If the wrapper process is interrupted before writing evidence but the external no-mistakes run later proves success, operators may reconcile the failed `no-mistakes` step with either legacy `workflow run clear-recovery --evidence-pointer no-mistakes:<run-id>#checks-passed` proof or a readable structured deterministic evidence JSON file.
The structured record uses `schemaVersion: 1` and must carry the current workflow run id, issue scope, branch name and head SHA, pull request identity and check state when present, no-mistakes run id and successful outcome, zero unresolved findings and decisions, and explicit `review`, `tests`, `docs`, `lint`, `format`, `push`, `pr`, and `ci` phase statuses.
Momentum refuses unknown schema versions or extra phases, stale workflow, issue, branch, head, pull request, or no-mistakes identities, unresolved findings or decisions, closed or draft pull requests, pending, failed, or unknown checks, non-success outcomes, and partial phase evidence.
This path is intentionally narrower than generic `update-step`: it only accepts a failed required `no-mistakes` step, stamps operator evidence on that row, updates stale `finished_at` to match the re-derived terminal or non-terminal run state, and re-derives the run so merge cleanup can continue.
Ordinary failed no-mistakes steps still surface as `retry_failed_step` with `recoveryDetail: null` unless the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
`workflow run clear-recovery` may still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.
Ordinary failed implementation/postflight steps still refuse guarded clear and must be retried or investigated.

When the failed required step is an external-side-effect tail step
(`merge-cleanup` or `linear-refresh`), the monitor view classifies it as
`failed_external_side_effect_step` rather than the generic `failed_required_step`,
and the recommended next action is `clear_recovery` instead of
`rerun_failed_step`.
These tail steps can push a branch, merge a pull request, or write the tracker before exiting non-zero.
After the operator verifies the canonical external state for the failed tail step, `workflow run clear-recovery --evidence-pointer <ref>` marks the tail step `succeeded`, records the operator reconciliation, evidence pointer, and optional `--ledger-pointer` on the step row, refreshes the run state and `finished_at` from the re-derived terminal or non-terminal state, and clears the durable manual-recovery flag when it was set.
Without `--evidence-pointer`, clear refuses and leaves the failed step plus any recovery flag intact.
That reconciles from external success evidence rather than re-running the step, which could double-merge the pull request or re-write the tracker.

### Operator checklist: external-side-effect tail step recovery

Before running `workflow run clear-recovery <run-id> --evidence-pointer <ref>` for a `failed_external_side_effect_step` classification, verify the state of each tail step that may have landed side effects.

**`merge-cleanup` (pushes branch, merges pull request)**

1. Confirm the pull request state on the hosting service (GitHub, etc.) first: check whether the PR is merged, closed, or still open.
2. Treat the PR merge or close state as canonical, because a successful merge can legitimately delete the remote branch.
3. If the PR is still open, confirm its current head SHA matches the run's `merge_cleanup.expected_head_sha`; a moved head is stale evidence and must be resolved before retry.
4. If the PR is still open or the host still lists a head branch, confirm the current cleanup branch ref with `git -C <repo> ls-remote --heads origin <merge_cleanup.cleanup_branch>`.
5. If the PR is merged, use a GitHub PR URL as the evidence pointer: `github://pulls/<number>#merged` or the HTTPS URL.
6. If the PR is not merged and no remote branch or PR update exists, the tail step failed cleanly before any external write; treat it like a retryable failure rather than a reconciliation.
7. Do not re-run `merge-cleanup` if the PR is already merged; that would attempt to push and merge again.

**`linear-refresh` (writes Linear tracker)**

1. Open the Linear issue identified by the run's `--issue-scope` identifier.
2. Confirm the durable intent evidence is either one pending Linear `status_update` intent or deterministic issue-scope/source evidence that seeded the expected `Done` status update, with a matching source item, stable idempotency marker, and exactly one valid `state` or `stateId` payload.
3. Confirm whether the issue state and idempotency-marker comment were updated by the step.
4. If the tracker was updated, use the Linear issue URL or a stable audit/snapshot as the evidence pointer.
5. If no Linear update landed, the step failed before any external write; treat it like a retryable failure after fixing the missing auth/policy/issue-scope/source/deterministic-intent/payload cause.
6. Do not re-run `linear-refresh` if the tracker is already consistent and the external-apply audit reconcile succeeded; that would attempt a duplicate write.

**Evidence pointer**

`--evidence-pointer <ref>` is **required** for evidence-backed recovery reconciliation.
For `failed_external_side_effect_step`, its value is a free-form stable reference to the external artifact that proves the side effect landed successfully.
For a failed `merge-cleanup` step, supply the merged pull request URL (e.g. `https://github.com/org/repo/pull/123` or `github://pulls/123#merged`).
For a failed `linear-refresh` step, supply the Linear issue URL (e.g. `https://linear.app/team/issue/KEY-123` or `linear://issues/KEY-123#updated`).
For an interrupted failed `no-mistakes` step whose external no-mistakes run
later proved success, supply either legacy `no-mistakes:<run-id>#checks-passed` proof or a readable local JSON evidence file path.
Structured no-mistakes evidence must be deterministic and current against the durable workflow run, latest no-mistakes checkpoint identity, branch head SHA, pull request identity, unresolved finding counts, check state, and all required phase statuses.
Without `--evidence-pointer`, `clear-recovery` refuses with `recovery_clear_refused` and leaves the failed step and any recovery flag intact.

**Ledger pointer**

`--ledger-pointer <ref>` is optional.
Use it when the local `.agent-workflows/<run-id>/ledger.jsonl` contains the entry that shows where the step's partial execution stopped, for example `.agent-workflows/<run-id>/ledger.jsonl#offset=42`.
The ledger pointer does not affect the reconciliation outcome; it is stored on the step row as durable audit context alongside the evidence pointer.

**Monitor state before and after recovery**

Before clearing external-tail recovery, `workflow run monitor <run-id> --json` reports `disposition: "recover"`, `reportReason: "recovery_required"`, `nextAction.code: "clear_recovery"`, `nextAction.actionClass: "reconcile_external_tail"`, `nextAction.recoveryDetail.kind: "external_tail_reconcile"`, and `recovery.code: "failed_external_side_effect_step"`.
For interrupted no-mistakes reconciliation, monitor/status/watch advertise `nextAction.actionClass: "reconcile_deterministic_evidence"` and `nextAction.recoveryDetail.kind: "no_mistakes_deterministic_evidence"` only when the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
Ordinary failed no-mistakes steps still surface as `retry_failed_step` with `recoveryDetail: null` unless the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.
`workflow run clear-recovery` may still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.
The legacy `no-mistakes:<run-id>#checks-passed` pointer or structured deterministic evidence file narrows `clear-recovery` to that failed required `no-mistakes` row.

After a successful `workflow run clear-recovery --evidence-pointer <ref>`, re-run the monitor command to verify the next durable state.
When the reconciled tail step was the last remaining required work, the monitor reports `disposition: "report"`, `reportReason: "terminal_succeeded"`, `nextAction.code: "no_action"`, `nextAction.actionClass: "stop_monitoring"`, and `recovery: null`.
Its progress tick reports `phase: "terminal"`, `terminal: true`, `cleanup: "release"`, and `blockerReason: null`, so monitor delivery can stop instead of retaining the earlier recovery tick.
When downstream required work remains, such as `linear-refresh` after a reconciled `merge-cleanup` in a full workflow, the monitor reports that pending or approved next step instead of terminal success.

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
- `momentum project status` — `pendingIntentApplyStateCounts.blocked` rolls up
  the count of pending intents currently in `blocked` apply state.
- `momentum doctor` — the `externalApply` audit-ledger aggregate exposes
  blocked counts across the data directory.
