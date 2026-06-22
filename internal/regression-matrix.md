# M7 / M8 / M9 / M10 Regression Matrix Anchor

Long-form regression matrix moved to Obsidian during DOCS-02:
`/Workspaces/Momentum/Specs/2026-06-22-runtime-queue-and-dogfood-evidence.md`.

Temporary anchor until DOCS-03/DOCS-04 complete.

## M7 matrix: durable substrate invariants

Stale monitor state; Lost managed task with completed ledger; Terminal external evidence winning over local drift; Blocked stale step; No ghost active run.

Recovery codes: stale_running_step, ghost_active_no_lease, manual_recovery_lease,
monitor_drift_stale, failed_required_step.

Evidence links: milestones/m7-openclaw-coding-workflow-backend.md;
contracts/workflow-runs.md; smoke-tests.md; NGX-318.

Owners/tests: src/core/workflow/monitor-state.ts; src/core/workflow/run-reducer.ts;
src/core/workflow/run-import.ts; src/core/workflow/status.ts;
src/core/workflow/handoff.ts; test/workflow-monitor-state.test.ts;
test/m7-e2e-smoke.test.ts.

## M8 operator-control matrix

Run inventory by directory scan; Approval reconstruction from prose; Ledger hand-edits to finalize a step; Monitor-tick prose parsing; Recovery state invisible to operators; Path-only evidence inference.

Envelopes: workflow run list; workflow run approve; workflow run update-step;
workflow run clear-recovery; workflow run monitor.

Owners/tests: src/cli.ts; src/core/workflow/run-recovery.ts; src/core/workflow/monitor-envelope.ts; src/core/workflow/recovery-artifact.ts; src/core/evidence/workflow.ts; workflow_runs; needs_manual_recovery; recovery.md.

M8 evidence: NGX-330; Milestone 8 operator-control end-to-end smoke; ghost-active run.

Links: milestones/m8-workflow-run-operator-controls.md;
contracts/workflow-operator-controls.md.

## M9 live-execution matrix

Live step commits without verification ownership; Ambiguous live result document
causes destructive reset; Live finalization mutates after ownership is lost.

## M10 workflow-first runtime matrix

Durable workflow run never reaches shipped daemon dispatch; Claimed unsupported
workflow step silently no-ops or strands its lease.

## How to use this matrix

Use executable tests and source owners as current behavioral protection. Use
Obsidian for the historical explanation of why each row exists.
