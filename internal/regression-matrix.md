# M7 / M8 / M9 / M10 regression matrix: workflow failure modes

This matrix pins the failure modes that motivated **Milestone 7: OpenClaw
Coding Workflow Backend** and **Milestone 8: Workflow Run Operator Controls**,
plus the live-execution failure modes introduced during **Milestone 9: Live
Workflow Execution** and the workflow-first runtime dispatch failure modes now
covered during **Milestone 10: Workflow-First Runtime**. Each row names the
failure mode, the invariant that eliminates it, the code module that owns the
invariant, and the test(s) that
exercise it. The M7 rows are the closeout gate for NGX-319; the M8 rows are the
closeout gate for NGX-330; M9 rows are foundation / opt-in evidence that
M10 built on before the NGX-353 closeout advanced the doctor marker. If any row's
invariant regresses, the owning milestone has regressed.

The full M7 contract lives in
[`internal/contracts/workflow-runs.md`](contracts/workflow-runs.md); the M7
milestone scope and the full enumeration of old failure modes M7 eliminates
live in
[`internal/milestones/m7-openclaw-coding-workflow-backend.md`](milestones/m7-openclaw-coding-workflow-backend.md);
the smoke coverage referenced below is documented in
[`internal/smoke-tests.md`](smoke-tests.md).

The M8 operator-control invariants live in
[`internal/contracts/workflow-operator-controls.md`](contracts/workflow-operator-controls.md);
the M8 milestone scope and the enumeration of operator-control failure modes M8
eliminates live in
[`internal/milestones/m8-workflow-run-operator-controls.md`](milestones/m8-workflow-run-operator-controls.md).
M8 keeps the M7 substrate wire-stable; the M8 rows below pin the *operator-facing*
control surfaces (`workflow run list` / `approve` / `update-step` /
`clear-recovery` / `monitor` plus typed evidence linkage), not new substrate
behavior.

The M9 live-execution contract lives in
[`internal/contracts/live-workflow-execution.md`](contracts/live-workflow-execution.md);
the M9 milestone sequence lives in
[`internal/milestones/m9-live-workflow-execution.md`](milestones/m9-live-workflow-execution.md).
The M9 rows below remain internal-only foundation evidence while live execution
remains opt-in; M10 owned the closeout marker until the M11 closeout advanced
it again.

The M10 workflow-first runtime contracts live in
[`internal/contracts/workflow-first-runtime.md`](contracts/workflow-first-runtime.md),
[`internal/contracts/executor-loop.md`](contracts/executor-loop.md), and
[`internal/contracts/workflow-first-gap-matrix.md`](contracts/workflow-first-gap-matrix.md).
The M10 rows below pin implementation-slice and closeout dogfood evidence after
the NGX-353 marker advance.

## M7 matrix: durable substrate invariants

### 1. Stale monitor state

- **Old failure mode.** The `.agent-workflows/<runId>/monitor.json` snapshot was
  the de-facto run-state source. A monitor tick that observed an out-of-date
  digest could report a workflow as still `running` after the executor had
  already finalized via `ledger.jsonl`, leaving operators chasing a ghost
  active run.
- **M7 invariant.** Terminal substrate evidence (the `workflow_runs` /
  `workflow_steps` rows derived from `ledger.jsonl`) always beats a stale
  `monitor.json` advisory. `deriveWorkflowMonitorState` classifies the
  disagreement as `monitor_drift_stale` (or one of the other recovery codes
  when an additional condition applies) without flipping the substrate state.
- **Owner.** [`src/core/workflow/monitor-state.ts`](../src/core/workflow/monitor-state.ts)
  (`deriveWorkflowMonitorState`, recovery code `monitor_drift_stale`).
- **Evidence.**
  - Unit: `test/workflow-monitor-state.test.ts` — "emits monitor_drift_stale
    when a running step has fresh evidence but monitor advisory drifts" and
    "emits monitor_drift_stale when no running step and monitor drifts".
  - Built-CLI smoke: `test/m7-import-smoke.test.ts` — "treats a stale monitor as
    advisory: terminal ledger wins through the built CLI".

### 2. Lost managed task with completed ledger

- **Old failure mode.** A `node_managed_dispatch.py` detached child could die
  after writing terminal events to `ledger.jsonl` but before notifying any
  in-memory shell session. Because run state lived in the shell, the in-flight
  workflow forgot the step had completed.
- **M7 invariant.** The durable `workflow_steps` row, populated through the
  `workflow import` envelope from `ledger.jsonl`, is the source of truth.
  Terminal ledger entries are imported into the substrate regardless of
  managed-task liveness; lost managed children never re-open a completed step.
- **Owner.** [`src/core/workflow/run-import.ts`](../src/core/workflow/run-import.ts) plus
  [`src/core/workflow/step-executor.ts`](../src/core/workflow/step-executor.ts) (terminal
  state mapping from the ledger).
- **Evidence.**
  - Built-CLI smoke: `test/m7-e2e-smoke.test.ts` — the M7 end-to-end coding-workflow
    happy-path slice drives each step through the injected deterministic fake executor,
    re-imports between steps via `workflow import`, and asserts the final
    `state: succeeded`, zero leases, and an empty active / blocked bucket
    (NGX-318). The same smoke covers `lost managed-task markers` (siblings
    `managed-*.pid`, `managed-*.log`, `locks/`) being ignored on import without
    diagnostics or forced failure.

### 3. Terminal external evidence winning over local drift

- **Old failure mode.** A workflow could drift locally (out-of-date monitor
  snapshot, stale repo-local advisory) and report progress that contradicted
  the terminal external evidence captured in tracker artifacts. Operators had
  no durable arbiter to prefer the terminal evidence.
- **M7 invariant.** Terminal evidence wins. The lease-aware
  `deriveWorkflowRunState` plus the `deriveWorkflowMonitorState` reducer treat
  terminal `workflow_steps` finalization as authoritative; the monitor advisory
  can never promote a terminal run back into a non-terminal state. The M5
  `evidence_records` ingest path (`evidence ingest --path`) keeps surfacing
  workflow-scoped artifacts that prove the terminal claim, and the M6 external
  apply audit ledger (through `intent apply --external-apply` or the RC-3 daemon
  external-apply adapter that reuses the same execution path) continues to be the
  only mechanism that touches an external tracker, so external-side terminal
  state is never overwritten by local drift.
- **Owner.** [`src/core/workflow/run-reducer.ts`](../src/core/workflow/run-reducer.ts)
  (`deriveWorkflowRunState`, `isTerminalRunState`) and
  [`src/core/workflow/monitor-state.ts`](../src/core/workflow/monitor-state.ts) (terminal
  short-circuit in the monitor reducer).
- **Evidence.**
  - Unit: `test/workflow-run-reducer.test.ts` and
    `test/workflow-monitor-state.test.ts` — terminal run states (`succeeded`,
    `canceled`, `failed`) never accept monitor drift as a recovery code.
  - Built-CLI smoke: `test/m7-import-smoke.test.ts` / `test/m7-e2e-smoke.test.ts`
    — "treats a stale monitor as
    advisory: terminal ledger wins through the built CLI" plus the end-to-end
    coding-workflow happy path (evidence ingest surfaces workflow evidence
    types through `workflow handoff`).

### 4. Blocked stale step

- **Old failure mode.** A `workflow_steps` row could linger in `running` after
  its managed-step lease expired with no recent checkpoint, while the monitor
  cron kept reporting the workflow as healthy. Without a durable freshness
  classifier, "still running" was indistinguishable from "silently stalled".
- **M7 invariant.** A `running` step without a fresh `managed-step` / `dispatch`
  lease and without a recent checkpoint is classified
  `stale_running_step` (or `ghost_active_no_lease` when no non-monitor lease
  has ever been recorded for the run), surfaces `needsRecoveryArtifact = true`,
  and emits a deterministic `nextAction.code: investigate_stale`. When the
  outstanding lease's `stalePolicy` is `manual-recovery-required`, the reducer
  escalates to `manual_recovery_lease` and forces `runState: blocked` with
  `nextAction.code: clear_recovery`, so an operator must explicitly clear the
  run before any further claim is allowed. The reducer refuses to silently
  promote the step back to `succeeded` and refuses to report it as healthy in
  any of these cases.
- **Owner.** [`src/core/workflow/monitor-state.ts`](../src/core/workflow/monitor-state.ts)
  (`deriveWorkflowMonitorState`, recovery codes `stale_running_step`,
  `ghost_active_no_lease`, and `manual_recovery_lease`).
- **Evidence.**
  - Unit: `test/workflow-monitor-state.test.ts` — "flags stale_running_step
    recovery when a step is running, lease is stale, and no recent checkpoint
    exists", "does not flag silent success: stale lease does not promote a
    running step to succeeded", and "flags stale_running_step +
    investigate_stale when all steps succeeded but a non-monitor lease still
    holds the run in running".

### 5. No ghost active run

- **Old failure mode.** A required step failure mid-workflow could leave a
  phantom entry in the operator-facing "active" view because the failure path
  did not converge to a single durable terminal state and did not flush the
  lease.
- **M7 invariant.** A failed required step deterministically terminates the
  run as `state: failed`, with zero outstanding leases, no entry in the
  `--filter active` or `--filter blocked` bucket, the failed run visible only
  through `--filter completed` / `--state failed`, and `workflow handoff`
  reporting `nextAction.code: rerun_failed_step` with the failed `stepId` plus
  `monitor.recovery: { code: "failed_required_step", stepId: <id> }`.
- **Owner.** [`src/core/workflow/run-reducer.ts`](../src/core/workflow/run-reducer.ts)
  (failure-path terminal state), [`src/core/workflow/status.ts`](../src/core/workflow/status.ts)
  (filter buckets), [`src/core/workflow/handoff.ts`](../src/core/workflow/handoff.ts)
  (next-action surface).
- **Evidence.**
  - Built-CLI smoke: `test/m7-e2e-smoke.test.ts` — "leaves no ghost active run when a
    required step fails mid-workflow" (the M7 end-to-end coding-workflow
    failure-path slice, NGX-318) drives the implementation step with
    `outcome: fail_retry`, re-imports, and asserts `state: failed`, zero
    leases, empty active / blocked filters, `handoff.nextAction.code:
    rerun_failed_step`, and `monitor.recovery.code: failed_required_step`.

## M8 operator-control matrix: durable run-control invariants

The M7 substrate made run state durable, but operators still had to parse
prose, scrape `.agent-workflows/` directories, or hand-edit `ledger.jsonl` for
common control flows. M8 closes those gaps with durable operator-control
envelopes over the same substrate. Each row pins one operator-control failure
mode to the envelope / module that eliminates it and the test that exercises
it. The end-to-end evidence is the built-CLI smoke under
`test/m8-smoke.test.ts` › "Milestone 8 operator-control end-to-end smoke
(NGX-330)".

### 6. Run inventory by directory scan

- **Old failure mode.** An operator listing in-flight runs had to walk
  `.agent-workflows/` and re-derive run identity from directory names; there
  was no durable, filterable inventory surface.
- **M8 invariant.** `workflow run list` reads the durable `workflow_runs` rows
  directly and supports the same buckets the M7 reducer already classifies
  (`active` / `blocked` / `completed` / `imported`) plus state, approval
  boundary, repo, issue scope, and updated-time filters. The durable rows — not
  a directory scan — are the source of truth whenever they exist, and the
  emitted identifiers feed straight into `workflow status` / `workflow handoff`
  without re-derivation.
- **Owner.** [`src/commands/workflow/index.ts`](../src/commands/workflow/index.ts) (`workflowRunList`), reusing the M7
  [`src/core/workflow/status.ts`](../src/core/workflow/status.ts) filter buckets and the
  [`src/core/workflow/run-reducer.ts`](../src/core/workflow/run-reducer.ts) run state.
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — "composes list / approve / monitor
    / typed evidence linkage through the built CLI" asserts the imported run is
    discoverable through `workflow run list` (and `--filter active`) without an
    `.agent-workflows/` directory scan.

### 7. Approval reconstruction from prose

- **Old failure mode.** M7 already refused casual `"go ahead"` phrasing, but an
  explicit operator approval phrase had no first-class CLI; status / handoff /
  monitor could only reflect an approval by re-reading the on-disk approval
  JSON.
- **M8 invariant.** `workflow run approve` persists a durable
  `workflow_approvals` row (actor, phrase, boundary, `artifactPath`,
  `artifactDigest`, `recordedAt`) at a validated boundary; an omitted
  `--artifact-path` stores `workflow-run-approve://<runId>/<boundary>`
  provenance with a deterministic synthetic digest. Casual phrasing
  (`"go ahead"`, `"sure"`) still refuses — the M7 contract that casual phrases
  never produce a durable row stays in force. The durable approval survives
  subsequent `workflow import` (upsert `ON CONFLICT(run_id, boundary)`, never
  deleted) and composes into status / handoff / monitor / logs.
- **Owner.** [`src/commands/workflow/index.ts`](../src/commands/workflow/index.ts) (`workflowRunApprove`) plus
  [`src/core/workflow/run-import.ts`](../src/core/workflow/run-import.ts) (idempotent
  approval upsert).
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — "composes list / approve / monitor
    / typed evidence linkage through the built CLI" persists an operator
    approval at a distinct boundary and asserts it survives a re-import and
    surfaces through `workflow status`.

### 8. Ledger hand-edits to finalize a step

- **Old failure mode.** When a managed child died after the executor finished
  its work but before durable terminal evidence landed, recovery required
  hand-appending to `ledger.jsonl` or re-importing a doctored fixture.
- **M8 invariant.** `workflow run update-step` drives the same M7 reducer
  transition (`succeeded` / `skipped` / `failed` / `blocked`) with an
  operator-supplied reason and evidence pointer, without touching the on-disk
  ledger. Illegal transitions refuse (`invalid_transition`) with no partial
  durable mutation, and a terminal run refuses re-finalize except a byte-equal
  idempotent replay. The required-chain derivation in `deriveWorkflowRunState`
  stays the authority on run-level state; M8 never bypasses it.
- **Owner.** [`src/commands/workflow/index.ts`](../src/commands/workflow/index.ts) (`workflowRunUpdateStep`) plus
  [`src/core/workflow/run-reducer.ts`](../src/core/workflow/run-reducer.ts)
  (`deriveWorkflowRunState`).
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — "recovers a ghost-active run: flag,
    monitor recover, clear-recovery refusal, update-step resolution, then a
    clean clear" resolves the ghost step through `workflow run update-step`
    without editing `ledger.jsonl`.

### 9. Monitor-tick prose parsing

- **Old failure mode.** The skill's monitor runner constructed its decision
  view from prose plus best-effort artifact reads, so two monitor clients could
  disagree on run health.
- **M8 invariant.** `workflow run monitor` emits a stable JSON envelope
  (`schemaVersion`, run identity, current state, next-action code, recovery
  classification, evidence pointers, reportability / terminal flags) derived
  from `deriveWorkflowMonitorState`. It is read-only by construction. Terminal
  ledger evidence still beats a stale monitor advisory, and whenever
  `needs_manual_recovery` is set the envelope forces disposition `recover` even
  over a terminally-succeeded substrate.
- **Owner.** [`src/core/workflow/monitor-envelope.ts`](../src/core/workflow/monitor-envelope.ts)
  (`buildWorkflowMonitorEnvelope`) over
  [`src/core/workflow/monitor-state.ts`](../src/core/workflow/monitor-state.ts).
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — the happy path ("composes list /
    approve / monitor / typed evidence linkage through the built CLI") asserts a
    terminal monitor report; the recovery path ("recovers a ghost-active
    run: …") asserts `workflow run monitor` returns disposition `recover` while
    the run is flagged.

### 10. Recovery state invisible to operators

- **Old failure mode.** M7 classified the recovery state but the durable flag
  and the per-run artifact were deferred, so an operator could not see or clear
  a blocking recovery condition from the substrate.
- **M8 invariant.** Import sets the durable `WorkflowRun.needs_manual_recovery`
  flag on a blocking monitor classification (`manual_recovery_lease` /
  `ghost_active_no_lease` / `stale_running_step` / `failed_required_step`) and
  renders `.agent-workflows/<runId>/recovery.md` (run id, step id,
  classification, evidence pointers, recommended next action, and safety notes;
  never secrets or transcript content). The flag blocks future
  `workflow run approve` claims and non-resolving `workflow run update-step`
  transitions until an explicit `workflow run clear-recovery`, which refuses
  while the blocking condition persists and leaves `recovery.md` on disk as
  audit evidence. The run-scoped surface is a sibling of the M3 goal-scoped
  recovery contract, not a replacement.
- **Owner.** [`src/core/workflow/run-recovery.ts`](../src/core/workflow/run-recovery.ts)
  (`markWorkflowRunNeedsManualRecovery`,
  `clearWorkflowRunManualRecoveryGuarded`),
  [`src/core/workflow/recovery-artifact.ts`](../src/core/workflow/recovery-artifact.ts)
  (the `recovery.md` renderer), and
  [`src/commands/workflow/index.ts`](../src/commands/workflow/index.ts) (`workflowRunClearRecovery`).
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — "recovers a ghost-active run: …"
    asserts import sets `needs_manual_recovery` + `ghost_active_no_lease` and
    renders `recovery.md`; `workflow run clear-recovery` refuses while blocked,
    then succeeds only after `workflow run update-step` resolves the ghost step,
    and the flag persists until that explicit clear.

### 11. Path-only evidence inference

- **Old failure mode.** M7 attached evidence by best-effort artifact-path
  prefix, so workflow evidence only surfaced in run / step views when the
  brittle prefix matched.
- **M8 invariant.** Typed `runId` / `stepId` linkage on `evidence_records`
  (nullable `run_id` / `step_id` columns plus the
  `idx_evidence_records_run_step` index). Ingest against
  `.agent-workflows/<runId>/` attaches the owning `runId`; ledger step events
  also attach `stepId`, while plan / approval artifacts stay run-scoped with
  null `stepId`. Idempotent replay can fill missing linkage but never
  overwrites non-null linkage, and the existing M5 ingest shape, diagnostic
  codes, and idempotency stay wire-stable. Typed pointers surface identically
  through `workflow status` / `workflow handoff` / `workflow run monitor` / `workflow run logs`.
- **Owner.** [`src/core/evidence/workflow.ts`](../src/core/evidence/workflow.ts)
  (workflow artifact parsing and typed `runId` / `stepId` linkage).
- **Evidence.**
  - Built-CLI smoke: `test/m8-smoke.test.ts` — "composes list / approve / monitor
    / typed evidence linkage through the built CLI" runs `evidence ingest`
    against the run directory and asserts the typed `runId` / `stepId` linkage
    surfaces through `workflow run monitor` and `workflow status`.

## M9 live-execution matrix: verification / commit transaction invariants

The M9-03 slice (NGX-334) wires a cleanly dispatched live implementation step
into Momentum's existing verification, commit, failure-reset, and manual
recovery transaction. These rows pin the slice-level behavior before the later
M9 dogfood and live-resume slices add built-CLI smoke coverage.

### 12. Live step commits without verification ownership

- **Failure mode.** A live wrapper could modify the worktree and report success,
  but Momentum could either trust that result without running verification or
  let the wrapper's own commit become the durable outcome.
- **M9 invariant.** `advanceLiveWorkflowStep` finalizes only a normalized,
  durably-finished dispatch. The `finalizeLiveWorkflowStepFromResultFile` alias
  re-reads the runner-result document through the shared `step-finalize.ts` seam
  for the explicit commit intent, runs the configured verification commands, and
  creates the Momentum commit only while HEAD still equals the recorded base. A
  live wrapper-created commit is classified as `head_mismatch` and routed to
  manual recovery instead of being reset or accepted silently.
- **Owner.** [`src/core/executors/live-step-advance.ts`](../src/core/executors/live-step-advance.ts),
  [`src/core/executors/step-finalize.ts`](../src/core/executors/step-finalize.ts), and
  [`src/core/executors/live-step-finalize.ts`](../src/core/executors/live-step-finalize.ts)
  as the M9 back-compat alias.
- **Evidence.**
  - Unit: `test/live-step-finalize.test.ts` — commits the live-step diff only
    after verification passes; resets when verification fails; preserves a
    wrapper-created commit as `manual_recovery_required` / `head_mismatch`.
  - Unit: `test/live-step-advance.test.ts` — composes live-step execution,
    finalization, and durable recovery for the success, verification-failure,
    runner-failure, and moved-HEAD paths.

### 13. Ambiguous live result document causes destructive reset

- **Failure mode.** If the normalized result document is lost, malformed,
  oversized, unreadable, or replaced with a symlink after dispatch, Momentum
  could guess the live step outcome and reset or commit untrusted work.
- **M9 invariant.** The finalize seam treats a missing result as
  `result_missing` and an untrusted result as `result_invalid`; neither outcome
  mutates git. The run-level recovery seam sets `needs_manual_recovery` before
  attempting the per-run `recovery.md` artifact, so the durable flag and reason
  remain authoritative even if best-effort artifact rendering fails.
- **Owner.** [`src/core/executors/step-finalize.ts`](../src/core/executors/step-finalize.ts),
  [`src/core/executors/live-step-finalize.ts`](../src/core/executors/live-step-finalize.ts)
  as the M9 back-compat alias,
  [`src/core/executors/live-step-run-recovery.ts`](../src/core/executors/live-step-run-recovery.ts), and
  [`src/core/workflow/recovery-artifact.ts`](../src/core/workflow/recovery-artifact.ts).
- **Evidence.**
  - Unit: `test/live-step-finalize.test.ts` — missing, invalid JSON,
    non-RunnerResult, oversized, and symlink result documents return
    `result_missing` / `result_invalid` without mutating the worktree.
  - Unit: `test/live-step-run-recovery.test.ts` and
    `test/workflow-recovery-artifact.test.ts` — live recovery codes render into
    `recovery.md` with bounded evidence, set the durable recovery flag, and
    return `artifact_write_failed` without clearing the flag when rendering
    fails.

### 14. Live finalization mutates after ownership is lost

- **Failure mode.** A live step could finish execution, then verification /
  commit / reset finalization could continue after the repo lock or
  managed-step lease was no longer owned, or the managed-step lease could be
  released before recovery was durable.
- **M9 invariant.** `advanceLiveWorkflowStep` heartbeats and re-checks the repo
  lock plus managed-step lease through verification, commit, reset, and
  post-finalization acceptance. Lost ownership routes to `repo_lock_lost`
  recovery before further git mutation; if ownership is lost after git commits
  but before Momentum accepts the result, the terminal success is rejected and
  recovery is flagged for operator inspection. Live managed-step leases default
  to `manual-recovery-required`, and repo-lock refresh is monotonic so a final
  workflow-lease heartbeat cannot move an already-advanced repo-lock heartbeat
  or expiry backward. Heartbeating stops before the recovery flag / artifact
  write, but the deferred managed-step lease is released only after terminal or
  recovery reconciliation has been persisted.
- **Owner.** [`src/core/executors/live-step-advance.ts`](../src/core/executors/live-step-advance.ts) and
  [`src/core/executors/live-step-orchestrator.ts`](../src/core/executors/live-step-orchestrator.ts).
- **Evidence.**
  - Unit: `test/live-step-advance.test.ts` — keeps repo-lock and managed-step
    leases fresh during finalization; rejects lost repo-lock ownership before
    commit and after git has advanced HEAD; leaves conflicting deferred leases
    outstanding; and sets finalize or dispatch recovery before releasing the
    deferred managed-step lease.
  - Unit: `test/live-step-orchestrator.test.ts` — pins the
    `manual-recovery-required` managed-step stale-policy default, explicit stale
    policy override, and monotonic repo-lock heartbeat refresh.

## M10 workflow-first runtime matrix: production dispatch invariants

The M10-09a slice (NGX-367) wires the production workflow-lane dispatcher into
bounded managed `daemon start`, and the M10-09 closeout slice (NGX-353) dogfoods
that shipped workflow-first path.

### 15. Durable workflow run never reaches shipped daemon dispatch

- **Failure mode.** `workflow run start` and `workflow run approve` can create an
  approved durable workflow run, but the shipped `daemon start --max-*` path
  never supplies a production `workflowLane` to `runDaemonLoop`. The run is
  durable and runnable, yet the built CLI is inert unless a test injects a
  dispatcher.
- **M10 invariant.** Bounded managed `daemon start` passes
  `executeWorkflowStepDispatch` into `runDaemonLoop`. The scheduler lane recovers
  stale workflow leases, scans, claims one approved step, resolves its executor
  family through the run's workflow definition link, advances supported-family
  steps `approved -> running`, refreshes the parent `workflow_runs` state and
  monitor advisory snapshot to the same derived state, and creates durable
  `executor_invocations` plus first `executor_rounds` scaffold rows.
  Register-only `daemon start` exits before the loop and remains inert.
- **Owner.** [`src/cli.ts`](../src/cli.ts) (`daemonStart` wiring and loop summary
  envelope), [`src/core/workflow/dispatch.ts`](../src/core/workflow/dispatch.ts),
  [`src/core/workflow/dispatch-persist.ts`](../src/core/workflow/dispatch-persist.ts), and
  [`src/core/workflow/dispatch-execute.ts`](../src/core/workflow/dispatch-execute.ts).
  RC-2 terminal reconciliation is owned by
  [`src/core/workflow/dispatch-reconcile.ts`](../src/core/workflow/dispatch-reconcile.ts)
  and
  [`src/core/workflow/dispatch-reconcile-execute.ts`](../src/core/workflow/dispatch-reconcile-execute.ts).
  NGX-492 daemon-default live-wrapper execution is owned by
  [`src/core/workflow/daemon-live-wrapper-profile.ts`](../src/core/workflow/daemon-live-wrapper-profile.ts),
  [`src/core/workflow/live-wrapper-dispatch.ts`](../src/core/workflow/live-wrapper-dispatch.ts),
  [`src/core/workflow/dispatch-executor-run.ts`](../src/core/workflow/dispatch-executor-run.ts),
  [`src/core/workflow/dispatch-executor-terminalize.ts`](../src/core/workflow/dispatch-executor-terminalize.ts), and
  [`src/core/workflow/daemon-dispatch-exec-context.ts`](../src/core/workflow/daemon-dispatch-exec-context.ts).
  NGX-496 RC-3 daemon-dispatchable `external-apply` is owned by
  [`src/core/workflow/dispatch-external-apply.ts`](../src/core/workflow/dispatch-external-apply.ts)
  (pure M6 → executor-evidence mapping) and
  [`src/core/workflow/dispatch-external-apply-run.ts`](../src/core/workflow/dispatch-external-apply-run.ts)
  (async run-path producer) plus production daemon dispatch wiring in
  [`src/core/workflow/external-apply-dispatch.ts`](../src/core/workflow/external-apply-dispatch.ts)
  and [`src/cli.ts`](../src/cli.ts).
  NGX-497 RC-4 daemon-dispatchable `subworkflow` is owned by
  [`src/core/workflow/dispatch-subworkflow.ts`](../src/core/workflow/dispatch-subworkflow.ts)
  (pure child-run → executor-evidence mapping),
  [`src/core/workflow/dispatch-subworkflow-run.ts`](../src/core/workflow/dispatch-subworkflow-run.ts)
  (async run-path producer), and
  [`src/core/workflow/subworkflow-dispatch.ts`](../src/core/workflow/subworkflow-dispatch.ts)
  (daemon-lane entry-point factory). NGX-498 RC-4b flipped configured
  production dispatch through
  [`src/core/workflow/subworkflow-child-config.ts`](../src/core/workflow/subworkflow-child-config.ts),
  [`src/core/workflow/subworkflow-route.ts`](../src/core/workflow/subworkflow-route.ts),
  [`src/core/workflow/subworkflow-child-runner.ts`](../src/core/workflow/subworkflow-child-runner.ts),
  [`src/core/workflow/subworkflow-dispatch-context.ts`](../src/core/workflow/subworkflow-dispatch-context.ts),
  [`src/core/workflow/dispatch.ts`](../src/core/workflow/dispatch.ts), and
  [`src/cli.ts`](../src/cli.ts).
- **Evidence.**
  - Unit / CLI: `test/workflow-dispatch.test.ts`,
    `test/workflow-dispatch-persist.test.ts`,
    `test/workflow-dispatch-execute.test.ts`, and
    `test/cli-daemon-workflow-dispatch.test.ts` pin the phase-1 allowlist,
    durable resolution, dispatch / fail-closed effects, parent-state/advisory
    refresh, loop summary fields, and register-only invariant.
  - Built-CLI smoke: `test/m10-smoke.test.ts` — "drives workflow run start ->
    approve -> daemon start --max-* -> durable executor rows ->
    status/handoff/monitor through the built CLI" proves the shipped binary path
    persists executor rows and remains observable after the daemon exits.
  - RC-2 unit/effect proof: `test/workflow-dispatch-reconcile.test.ts` and
    `test/workflow-dispatch-reconcile-execute.test.ts` prove terminal executor
    evidence finalizes a dispatched step exactly once, unclean terminal evidence
    parks the run for manual recovery, non-terminal evidence defers, and M9
    direct-finalize plus M10 reconciliation cannot both close the same step.
  - RC-5b unit / CLI proof: `test/workflow-daemon-live-wrapper-profile.test.ts`,
    `test/workflow-daemon-dispatch-exec-context.test.ts`,
    `test/workflow-dispatch-executor-terminalize.test.ts`,
    `test/workflow-dispatch-executor-run.test.ts`,
    `test/workflow-live-wrapper-dispatch.test.ts`, and
    `test/cli-daemon-workflow-dispatch.test.ts` prove configured daemon profiles
    run real wrapper commands, terminalize evidence, reconcile through RC-2,
    fail unconfigured / unresolved contexts into manual recovery, preserve
    idempotent re-entry, and avoid stranded dispatch leases.
  - RC-3 unit / integration proof: `test/workflow-dispatch-external-apply.test.ts`
    pins the pure M6 → executor-evidence mapping (every `applied` → `succeeded`,
    every M6 failure → `manual_recovery_required`, idempotency marker preserved,
    composition with `planDispatchedExecutorTerminalization`);
    `test/workflow-dispatch-external-apply-run.test.ts` proves the async producer
    runs the injected M6 write once, records succeeded evidence, RC-2 finalizes
    the step, fail-closed on every M6 refusal, idempotent re-entry never re-runs
    the write, reconcile deferral keeps the lease held, and the M9 lane boundary
    refuses without running the write; `test/workflow-dispatch-external-apply-m6.test.ts`
    binds the producer to the real `executeExternalApply` through a mock Linear
    client (applied → succeeded + RC-2 finalize, idempotent re-entry never
    re-writes, real `policy_denied` refusal → manual recovery with no write
    attempted). `external-apply` is now in the dispatchable family set and wired through daemon dispatch composition; `subworkflow` followed in RC-4/RC-4b.
  - RC-4 unit / integration proof: `test/workflow-dispatch-subworkflow.test.ts`
    pins the pure child-run → executor-evidence mapping (non-terminal child
    defers, `succeeded` / `failed` mirror to clean terminals, `canceled` /
    `blocked` / unexpected fail closed, terminalize composition);
    `test/workflow-dispatch-subworkflow-run.test.ts` proves the async producer
    defers a non-terminal child without finalizing, mirrors a terminal child onto
    the dispatch scaffold for RC-2 to finalize once, fails closed on ambiguous
    terminals, never re-starts the child on idempotent re-entry, and refuses the
    M9 lane; `test/workflow-subworkflow-dispatch.test.ts` proves the daemon-lane
    entry-point factory runs the producer only for a `subworkflow` invocation and
    parks a refused / thrown child-context derivation in manual recovery;
    `test/workflow-dispatch-subworkflow-child-run.test.ts` binds the producer to a
    real child workflow run through the existing run-start / status seams (no
    duplicate child run, parent finalized only from durable terminal child
    evidence, fail-closed on an ambiguous canceled child). RC-4b adds
    `test/workflow-subworkflow-child-config.test.ts`,
    `test/workflow-subworkflow-route.test.ts`,
    `test/workflow-subworkflow-child-runner.test.ts`,
    `test/workflow-subworkflow-dispatch-context.test.ts`, and
    `test/workflow-dispatch-subworkflow-flip.test.ts` for route-sourced child
    config, bounded recursion, key-resolved child-run attachment, and bounded
    daemon dispatch.
  - Real closeout dogfood: `ngx353-m10-closeout` in `/Users/ngxcalvin/.momentum`
    reached `preflight = running` with executor invocation / round scaffold rows
    and `workflow run monitor` reported `monitorDrift.drifted = false`.

### 16. Claimed unsupported workflow step silently no-ops or strands its lease

- **Failure mode.** A runnable step whose definition resolves to an unsupported
  executor family, or whose durable definition link is missing/corrupt, can be
  claimed by the scheduler and then silently ignored. That leaves operators with
  no durable reason, or leaves a dispatch lease that suppresses future work.
- **M10 invariant.** The production dispatcher fails closed for every
  unresolvable or unsupported-family claim. When the run row still exists, it
  flags the workflow run for manual recovery, opens a step-scoped
  `manual_recovery_required` gate with stable evidence
  (`workflow_definition_unlinked`, `step_definition_not_found`,
  `unknown_executor_family`, or `unsupported_executor_family`), releases the
  dispatch lease, and creates no executor rows. If the run row vanished
  (`workflow_run_not_found`), it cannot write a run-scoped flag or gate without
  orphaning evidence, so it releases the lease and creates no executor rows. The
  phase-1 dispatchable set is exactly `goal-loop`, `one-shot`, `script`,
  `no-mistakes`, `external-apply`, and `subworkflow`; RC-4/RC-4b landed the
  configured `subworkflow` adapter lane, while the generic unsupported-family
  branch remains defensive for future families.
- **Owner.** [`src/core/workflow/dispatch.ts`](../src/core/workflow/dispatch.ts) and
  [`src/core/workflow/dispatch-execute.ts`](../src/core/workflow/dispatch-execute.ts).
- **Evidence.**
  - Unit: `test/workflow-dispatch.test.ts` pins the supportability decision and
    resolution-failure code mapping.
  - Unit: `test/workflow-dispatch-execute.test.ts` proves unsupported and
    unresolvable claims create manual-recovery gates where possible, set the
    durable recovery flag where possible, release the lease, avoid executor
    scaffolds, and handle the vanished-run branch without a dangling gate.

## How to use this matrix

- Treat each row as a closeout gate. A code change that breaks any listed
  invariant must either restore the invariant or open a follow-up milestone
  that explicitly re-scopes it; the owning milestone (M7 for rows 1–5, M8 for
  rows 6–11, M9 for rows 12–14, M10 for rows 15+) cannot be re-closed until
  every row's evidence is green.
- The owner module and tests are intentionally specific. When refactoring,
  move the listed test names atomically with the module they pin so this
  matrix stays accurate.
- Adding a new failure mode that belongs to a later milestone belongs in that
  milestone's own section or matrix. This document is scoped to the M7 durable
  substrate, the M8 operator-control surfaces built on top of it, the M9
  live-execution slices that have landed, and the M10 workflow-first runtime
  dispatch slices that have landed.
