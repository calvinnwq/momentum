# Milestone 9: Live Workflow Execution

**Status:** Draft / candidate. M9 is not active while M8 is in flight. It becomes active only after M8 closeout and an explicit decision to promote this contract.

Milestone 9 is the proposed point where Momentum starts dogfooding real repo work through Momentum-owned live execution rather than using the OpenClaw `coding-workflow-pipeline` skill as the live run loop.

The contract for this milestone lives in [`internal/contracts/live-workflow-execution.md`](../contracts/live-workflow-execution.md). The M7 substrate contract and M8 operator-control contract remain prerequisites.

## Milestone Goal

Land live workflow-step wrappers that let Momentum run a bounded OpenClaw coding workflow through durable state:

- Create or import a `WorkflowRun`.
- Acquire repo and step leases.
- Invoke configured live executors.
- Capture result files, logs, checkpoints, and verification output.
- Commit or recover through Momentum's existing transaction rules.
- Surface status, logs, handoff, monitor, approvals, recovery, and evidence from durable state.

M9 exists so Momentum can replace chat-driven execution for real dogfood trials, starting with low-blast-radius Momentum issues.

## Why This Follows M8

M7 made the backend substrate durable but left operators without first-class controls.

M8 adds those controls: list, approve, update-step, recovery, monitor, and typed evidence linkage.

Live execution before those controls would recreate the exact failure mode Momentum is meant to fix: a long-running process with unclear state and manual artifact surgery when the shell, chat turn, or monitor gets lost.

## Data Ownership Boundary

**Momentum owns in M9:**

- Live wrappers around the canonical workflow step kinds.
- Lease / heartbeat / terminal-state persistence around live steps.
- Command execution through explicit argv specs.
- Result-file parsing and normalization.
- Verification capture and commit / reset transaction safety.
- Run-scoped recovery artifacts and durable recovery flags for live failures.
- A real dogfood run that can be inspected after session loss.

**OpenClaw skills still own:**

- The implementation of the existing engines: GNHF, postflight, no-mistakes, harness delegation, model evidence, project refresh.
- Discord UX.
- Cron delivery UX outside Momentum daemon / worker semantics.
- External writes outside the M6 external-apply contract.

M9 wraps existing engines; it does not rewrite them.

## Planned M9 Slices

The exact issue IDs are intentionally not assigned in this draft. When promoted, each slice should become a concrete Linear issue and leave `main` valid.

1. **M9-00 Contract and decision gate:** promote this draft, choose the live-wrapper architecture, pin non-goals, and update roadmap / doctor-marker policy. No runtime behavior change.
2. **M9-01 Live wrapper config and registry:** add typed config parsing, refusal codes, wrapper resolution, probe support, and deterministic fixture tests.
3. **M9-02 Live implementation step wrapper:** run the `implementation` step through an explicit live wrapper with lease / heartbeat / result-file capture.
4. **M9-03 Verification and commit transaction:** wire live step output into Momentum verification, commit intent, failure reset, and head-mismatch recovery.
5. **M9-04 Postflight and no-mistakes wrappers:** add live wrappers for postflight and no-mistakes with result normalization and recovery taxonomy.
6. **M9-05 Merge cleanup and Linear refresh boundaries:** add wrappers or explicit handoff gates for merge cleanup and Linear refresh without bypassing M6 external apply.
7. **M9-06 Live recovery and resume smoke:** prove stale lease, timeout, missing result, invalid result, failed verification, and head-mismatch recovery.
8. **M9-07 Dogfood run and closeout:** run a real Momentum issue through Momentum-owned live execution, record evidence, extend regression matrix, and flip the doctor marker only after the dogfood gate passes.

## Dogfood Policy

The first live dogfood run should be deliberately boring:

- Local-only Momentum repo change.
- No external tracker writes during the live execution phase.
- No remote git operations.
- No parallel same-repo work.
- Verification limited to the smallest meaningful gate for the issue, then full repo gates before closeout.

The point is to test orchestration, recovery, and handoff under real pressure, not to maximize feature scope in the first run.

## M9 Non-Goals

M9 does not include:

- Replacing the internals of GNHF / postflight / no-mistakes / model-evidence / project-refresh skills.
- Discord approval rendering.
- Public dashboard UI.
- Strong sandboxing.
- Remote git operations.
- Autonomous external writes.
- Parallel same-repo worktrees.
- General-purpose non-coding WorkflowRun orchestration.

## Closeout Marker Policy

The `doctor --json` marker remains pinned to the most recently closed milestone until the final M9 closeout slice. M9 may not flip the marker until the live dogfood gate and regression updates are complete.

