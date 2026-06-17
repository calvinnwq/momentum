# Historical Milestone Narratives

This directory preserves milestone scope, shipped order, closeout markers, and
provenance. It is not the first place to look for current behavior when a newer
contract supersedes or extends a milestone.

For current repo shape, start with [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).
For active runtime contracts, start with
[`../contracts/README.md`](../contracts/README.md).

| Milestone | Status | Provenance |
| --- | --- | --- |
| M3 Operational Safety | Complete | [`m3-operational-safety.md`](m3-operational-safety.md) |
| M4 Real Runner Profiles | Complete | [`m4-real-runners.md`](m4-real-runners.md) |
| M5 Source Adapters and Evidence Sync | Complete | [`m5-source-adapters.md`](m5-source-adapters.md) |
| M6 Policy-Gated External Apply | Complete | [`m6-external-apply.md`](m6-external-apply.md) |
| M7 OpenClaw Coding Workflow Backend | Complete | [`m7-openclaw-coding-workflow-backend.md`](m7-openclaw-coding-workflow-backend.md) |
| M8 Workflow Run Operator Controls | Complete | [`m8-workflow-run-operator-controls.md`](m8-workflow-run-operator-controls.md) |
| M9 Live Workflow Execution | Foundation in force | [`m9-live-workflow-execution.md`](m9-live-workflow-execution.md) |
| M10 Workflow-First Runtime | Complete | [`m10-workflow-first-runtime.md`](m10-workflow-first-runtime.md) |
| M11 CLI Architecture Refactor | Complete | root [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |

When editing a milestone narrative, preserve historical order and issue
provenance. Put current invariants in `internal/contracts/` and public operator
usage in `docs/`.
