# Milestone 3: Operational Safety

**Status:** Complete (NGX-272 through NGX-278).
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

## M3 durable primitives

Goal, Source, Source Item, Iteration, Job, RunnerAdapter, Workflow, Workspace,
Event, Handoff.

## M3 locked decisions

`Goal` state is durable; execution stays policy-gated; local `MOMENTUM.md`
policy is authoritative for repo behavior.

## Planned M3 issue order

NGX-272, NGX-273, NGX-274, NGX-275, NGX-276, NGX-277, NGX-278.

## M3 non-goals (explicit)

Background runner supervision; Cooperative mid-job cancellation; Per-source-item worktrees; Inbound webhooks; Dashboard or UI surface; Strong sandboxing; Remote git operations; External tracker writes.

## Symphony to Momentum mapping

Adopt: Single-authority scheduling. Avoid: In-memory-only scheduler state.

## M2 contracts preserved

Queue, worker, verification, commit/reset, and handoff behavior stay intact.
