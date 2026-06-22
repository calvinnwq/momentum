# Milestone 10: Workflow-First Runtime

**Status:** Complete.
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

M10-00 promoted the workflow-first contracts; M10-01 landed definitions; M10-09 dogfooded and closed the milestone.

## Source Contracts

internal/contracts/workflow-first-runtime.md;
internal/contracts/executor-loop.md;
internal/contracts/workflow-first-gap-matrix.md.

## Goal

Pin the workflow-first product shape: WorkflowDefinition, WorkflowRun,
StepDefinition, StepRun, ExecutorInvocation, ExecutorRound, and goal-loop.

## Relationship To M9

M9 remains valid foundation work. M10 reuses the live wrapper registry and verification / commit / reset finalization primitives. M10 reuses those primitives.

## Implementation Sequence

M10-00 NGX-344; M10-01 NGX-345; M10-02 NGX-346; M10-03 NGX-347; M10-04
NGX-348; M10-05 NGX-349; M10-06 NGX-350; M10-07 NGX-351; M10-08 NGX-352;
M10-09a NGX-367; M10-09 NGX-353. NGX-345 through NGX-353 are the assigned Linear issue identifiers. NGX-367 inserted as the M10-09a dispatch slice.

## Closeout Dogfood

Evidence included ngx353-m10-closeout, workflow run start,
daemon start --max-loop-iterations 1, monitorDrift.drifted: false, and the
phase-1 start scaffold.

## Doctor Marker Policy

M10 flipped the marker at M10 closeout:
Milestone 10: workflow-first runtime (NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349, NGX-350, NGX-351, NGX-352, NGX-367, NGX-353) complete.

## Non-Goals

Replacing GNHF; Replacing no-mistakes; Remote git operations; Public UI /
dashboard; Autonomous external writes; Strong sandboxing; Inbound webhooks.
