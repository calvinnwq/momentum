# Milestone 7: OpenClaw Coding Workflow Backend

**Status:** Closed out at NGX-319.
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

M7 makes Momentum the durable run substrate for OpenClaw coding workflows; it
does **not** replace gnhf-runner, gnhf-postflight, harness-delegate,
no-mistakes-pipeline, model-evidence, or project-progress-refresh.

## Data ownership boundary

WorkflowRun, workflow_steps, workflow_approvals, workflow_leases, evidence,
needs_manual_recovery, and evidence_records belong to the durable substrate.

Canonical step names: preflight, implementation, postflight, no-mistakes,
merge-cleanup, linear-refresh.

Approval boundaries: through-implementation, through-no-mistakes,
through-merge-cleanup, full.

Compatible artifacts: `.agent-workflows/`, plan.json, ledger.jsonl, approval-,
monitor.json.

## Old monitor failure modes M7 eliminates

in-memory shell session; phase-suffixed cron; lost managed child; monitor lease path; approval reconstruction.

## M7 non-goals

Dashboard or UI surface; Inbound webhooks; Autonomous or background external writes; Replacing the GNHF; Parallel same-repo Goals / Per-source-item worktrees; Strong sandboxing; Remote git operations.

## Shipped M7 issue order

M7-00 NGX-312; NGX-313; NGX-314; NGX-315; NGX-316; NGX-317; NGX-318; M7-07
NGX-319.

## Closeout marker policy

Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete.
