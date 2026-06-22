# Milestone 4: Real Runner Profiles

**Status:** Complete (NGX-279 through NGX-286).
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

## M4 architecture: Momentum core vs runner adapters

Momentum core owns durable orchestration; `RunnerAdapter` owns execution profile
integration.

## M4 runner family

Initial profiles: `fake`, `trusted-shell`, ACP/acpx.

## Planned M4 issue order

NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286.

## M4 non-goals (explicit)

External tracker writes; Inbound webhooks; Worktrees / per-source-item workspaces; Background runner supervision; Dashboard or UI surface; Strong sandboxing; Cooperative mid-job cancellation / signal handling; Remote git operations.

## M3 contracts preserved

`daemon start`, `daemon stop`, `daemon status`, and `recovery clear` stay
wire-stable.
