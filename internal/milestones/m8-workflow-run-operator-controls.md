# Milestone 8: Workflow Run Operator Controls

**Status:** Closed out at NGX-330.
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

M8 layers operator-control CLI envelopes on the M7 durable substrate without
renaming workflow import, workflow status, or workflow handoff.

## Milestone goal

Ship `workflow run list`, `workflow run approve`, `workflow run update-step`,
`workflow run clear-recovery`, `workflow run monitor`, per-run `recovery.md`,
`needs_manual_recovery`, and typed runId / stepId evidence linkage.

## Data ownership boundary

workflow_runs, workflow_steps, workflow_approvals, workflow_leases,
daemon_runs, repo_locks, RunnerAdapter, MOMENTUM.md, source_items,
update_intents, `intent apply --external-apply` remain wire-stable.

coding-workflow-pipeline owns Discord approval UX / render delivery, monitor
cron, and live executor wrappers / executor invocation until later milestones.

## M8 non-goals

live executor wrappers; Discord delivery; cron scheduling; external tracker writes; Dashboard / UI surface; inbound webhooks; remote git operations. deferred live executor wrappers to a later milestone unless a future decision gate changes that boundary.

## Shipped M8 issue order

M8-00 NGX-323; M8-01 NGX-324; M8-02 NGX-325; M8-03 NGX-326; M8-04 NGX-327;
M8-05 NGX-328; M8-06 NGX-329; M8-07 NGX-330.

## Closeout marker policy

Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete.

The M7 regression matrix reference remains `internal/regression-matrix.md`.
