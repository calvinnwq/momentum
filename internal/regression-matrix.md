# M7 regression matrix: old monitor failure modes

This matrix pins the failure modes that motivated **Milestone 7: OpenClaw
Coding Workflow Backend** and the durable substrate invariants that make each
one unreachable. Each row names the failure mode, the substrate invariant that
eliminates it, the code module that owns the invariant, and the test(s) that
exercise it. It is the closeout gate for NGX-319: if any row's invariant
regresses, M7 has regressed.

The full M7 contract lives in
[`internal/contracts/workflow-runs.md`](contracts/workflow-runs.md); the M7
milestone scope and the full enumeration of old failure modes M7 eliminates
live in
[`internal/milestones/m7-openclaw-coding-workflow-backend.md`](milestones/m7-openclaw-coding-workflow-backend.md);
the smoke coverage referenced below is documented in
[`internal/smoke-tests.md`](smoke-tests.md).

## Matrix

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
- **Owner.** [`src/workflow-monitor-state.ts`](../src/workflow-monitor-state.ts)
  (`deriveWorkflowMonitorState`, recovery code `monitor_drift_stale`).
- **Evidence.**
  - Unit: `test/workflow-monitor-state.test.ts` — "emits monitor_drift_stale
    when a running step has fresh evidence but monitor advisory drifts" and
    "emits monitor_drift_stale when no running step and monitor drifts".
  - Built-CLI smoke: `test/smoke.test.ts` — "treats a stale monitor as
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
- **Owner.** [`src/workflow-run-import.ts`](../src/workflow-run-import.ts) plus
  [`src/workflow-step-executor.ts`](../src/workflow-step-executor.ts) (terminal
  state mapping from the ledger).
- **Evidence.**
  - Built-CLI smoke: `test/smoke.test.ts` — the M7 end-to-end coding-workflow
    happy-path slice drives each step through the deterministic fake executor,
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
  apply audit ledger (`intent apply --external-apply`) continues to be the only
  mechanism that touches an external tracker, so external-side terminal state
  is never overwritten by local drift.
- **Owner.** [`src/workflow-run-reducer.ts`](../src/workflow-run-reducer.ts)
  (`deriveWorkflowRunState`, `isTerminalRunState`) and
  [`src/workflow-monitor-state.ts`](../src/workflow-monitor-state.ts) (terminal
  short-circuit in the monitor reducer).
- **Evidence.**
  - Unit: `test/workflow-run-reducer.test.ts` and
    `test/workflow-monitor-state.test.ts` — terminal run states (`succeeded`,
    `canceled`, `failed`) never accept monitor drift as a recovery code.
  - Built-CLI smoke: `test/smoke.test.ts` — "treats a stale monitor as
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
- **Owner.** [`src/workflow-monitor-state.ts`](../src/workflow-monitor-state.ts)
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
- **Owner.** [`src/workflow-run-reducer.ts`](../src/workflow-run-reducer.ts)
  (failure-path terminal state), [`src/workflow-status.ts`](../src/workflow-status.ts)
  (filter buckets), [`src/workflow-handoff.ts`](../src/workflow-handoff.ts)
  (next-action surface).
- **Evidence.**
  - Built-CLI smoke: `test/smoke.test.ts` — "leaves no ghost active run when a
    required step fails mid-workflow" (the M7 end-to-end coding-workflow
    failure-path slice, NGX-318) drives the implementation step with
    `outcome: fail_retry`, re-imports, and asserts `state: failed`, zero
    leases, empty active / blocked filters, `handoff.nextAction.code:
    rerun_failed_step`, and `monitor.recovery.code: failed_required_step`.

## How to use this matrix

- Treat each row as a closeout gate. A code change that breaks any listed
  invariant must either restore the invariant or open a follow-up milestone
  that explicitly re-scopes it; M7 cannot be re-closed until every row's
  evidence is green.
- The owner module and tests are intentionally specific. When refactoring,
  move the listed test names atomically with the module they pin so this
  matrix stays accurate.
- Adding a new failure mode that motivates a future milestone belongs in that
  milestone's own regression matrix, not here. This document is scoped to M7.
