# Milestone 5: Source Adapters and Evidence Sync

**Status:** Complete (NGX-287 through NGX-294).
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

## M5 vocabulary

SourceItem, SourceAdapter, source snapshot, reconciliation run, evidence artifact, external update intent, project rollup.

## M5 trust boundary

Momentum records durable update intent rows for read-only sources. Momentum does **not** perform automatic external writes in M5.

## M5 composition with existing contracts

Goal, Iteration, Job, RunnerAdapter, daemon, recovery, handoff, and
MOMENTUM.md surfaces remain wire-stable.

## Planned M5 issue order

NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294.

## M5 non-goals (explicit)

Automatic external tracker writes; Inbound webhooks; Dashboard or UI surface;
Per-source-item worktrees; Background runner supervision; Strong sandboxing;
Cooperative mid-job cancellation / signal handling; Remote git operations.

## M3 and M4 contracts preserved

`daemon start`, `daemon stop`, `daemon status`, `recovery clear`, `fake`,
`trusted-shell`, and `acp` remain compatible.
