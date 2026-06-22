# Momentum Roadmap Anchor

Long-form roadmap sequencing moved to Obsidian during DOCS-02:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

For current source architecture use [ARCHITECTURE.md](../ARCHITECTURE.md).

## Timeline

| Milestone | Theme | Status | Detail |
|---|---|---|---|
| Milestone 3 | Operational Safety | Complete | milestones/m3-operational-safety.md |
| Milestone 4 | Real Runner Profiles | Complete | milestones/m4-real-runners.md |
| Milestone 5 | Source Adapters and Evidence Sync | Complete | milestones/m5-source-adapters.md |
| Milestone 6 | Policy-Gated External Apply | Complete | milestones/m6-external-apply.md |
| Milestone 7 | OpenClaw Coding Workflow Backend | Complete | milestones/m7-openclaw-coding-workflow-backend.md |
| Milestone 8 | Workflow Run Operator Controls | Complete | milestones/m8-workflow-run-operator-controls.md |
| Milestone 9 | Live Workflow Execution | Foundation in force | milestones/m9-live-workflow-execution.md |
| Milestone 10 | Workflow-First Runtime | Complete | milestones/m10-workflow-first-runtime.md |
| Milestone 11 | CLI Architecture Refactor | Complete | ../ARCHITECTURE.md |

Workflow-first runtime pivot contract links: internal/contracts/workflow-first-runtime.md,
internal/contracts/executor-loop.md, internal/contracts/workflow-first-gap-matrix.md,
internal/contracts/coding-workflow-ownership.md, internal/contracts/runtime-consolidation-plan.md,
internal/contracts/repo-architecture-standard.md, contracts/live-workflow-execution.md,
contracts/workflow-runs.md.

M8 issues: NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329,
NGX-330.

M9 sequence: NGX-331, NGX-332, NGX-333, NGX-334, NGX-335, NGX-336, NGX-337,
NGX-338.

M10 sequence: M10-00, M10-01, M10-02, M10-03, M10-04, M10-05, M10-06, M10-07,
M10-08, M10-09a, M10-09; NGX-344, NGX-345, NGX-346, NGX-347, NGX-348,
NGX-349, NGX-350, NGX-351, NGX-352, NGX-367, NGX-353.

M11 sequence: NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417,
NGX-418, NGX-419.

Doctor marker history includes:

- Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete
- Milestone 10: workflow-first runtime (NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349, NGX-350, NGX-351, NGX-352, NGX-367, NGX-353) complete
- Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete

Runtime notes: M9 remains valid foundation work. M10 is complete. external-apply
and subworkflow production flip have landed. RC-5 fake demotion, RC-5b reusable
execution seams, RC-1b finalization disentanglement, RC-1c read-back narrowing,
and RC-3/RC-4 dispatchable adapters have landed.
