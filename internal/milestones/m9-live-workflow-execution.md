# Milestone 9: Live Workflow Execution

**Status:** Foundation in force. Promoted from draft at NGX-331.
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

Milestone 9 wraps existing engines; it does not rewrite or replace them.

## Milestone Goal

Create/import a WorkflowRun, acquire leases, invoke live wrappers, capture
result files/logs/checkpoints, commit/recover safely, and surface status/logs/
handoff/monitor/approvals/recovery/evidence from durable state.

## Chosen Live-Wrapper Architecture (M9-00 decision)

Wrapper registry keyed by WorkflowStepKind: preflight, implementation,
postflight, no-mistakes, merge-cleanup, linear-refresh. Durable configuration
uses command, args, cwd, timeoutSec, envAllow, resultFile, and probe. Wrappers
use explicit argv and durable profile config.

### Run-start surface decision

The original M9 preference reused goal start plus a WorkflowRun link rather
than a new workflow run start verb; M10 later superseded that preference with
first-class workflow run start.

## M9 Implementation Sequence

M9-00 NGX-331; M9-01 NGX-332; M9-02 NGX-333; M9-03 NGX-334; M9-04 NGX-335;
M9-05 NGX-336; M9-06 NGX-337; M9-07 NGX-338.

## Dogfood Policy

Dogfood a real Momentum issue through Momentum-owned live execution.

## M9 Non-Goals

Replacing GNHF, postflight, no-mistakes, model-evidence, or project-refresh; Discord; cron; Dashboard / web UI / UI surface; Strong sandboxing; Remote git operations; Autonomous external writes; Parallel same-repo work.

## Closeout Marker Policy

The marker remains pinned / stays pinned to the M8 closeout string until a later closeout: Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete. NGX-338 is the M9 closeout slice.
