# Milestone 9: Live Workflow Execution

**Status:** Foundation in force. Promoted from draft at the M9-00 decision gate (NGX-331) after M8 closeout; M10 completed the workflow-first implementation, and M11 now owns CLI structure work. The companion contract in [`internal/contracts/live-workflow-execution.md`](../contracts/live-workflow-execution.md) remains the accepted foundation for live workflow execution; the M8 operator-control contract stays in force for its own invariants.

Milestone 9 defines the point where Momentum starts dogfooding real repo work through Momentum-owned live execution rather than using the OpenClaw `coding-workflow-pipeline` skill as the live run loop.

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

## Chosen Live-Wrapper Architecture (M9-00 decision)

The M9-00 decision gate pins the following architecture so later slices implement against a fixed shape rather than re-litigating it:

- **Wrapper registry keyed by `WorkflowStepKind`.** Momentum adds a registry of live `WorkflowStepExecutor` wrappers keyed by the existing `WorkflowStepKind` values — `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, and `linear-refresh`. Each wrapper produces the M7 `WorkflowStepExecutor` result shape; the step-state machine and reducer do not change.
- **Durable configuration, not hard-coded paths.** Each wrapper resolves from durable per-profile configuration (`command`, `args`, `cwd`, `timeout_sec`, `env_allow`, `result_file`, optional `probe` with `timeout_sec`). The typed in-memory shape may expose camelCase properties, but durable config keys stay snake_case to match `trusted_shell` / `acp`. Missing or malformed config refuses before mutating any workflow state.
- **Explicit argv, never an implicit shell.** Wrappers spawn an explicit executable plus an argv array with no shell interpolation and capture bounded stdout / stderr artifacts.
- **Pre-flight probe.** An optional probe command detects missing runtime or auth before the main command runs, mapping to the `runtime_unavailable` / `auth_unavailable` recovery codes instead of a generic failure.
- **Wrap, do not reimplement.** The wrappers invoke the existing OpenClaw engines; M9 does not rewrite GNHF, postflight, no-mistakes, model-evidence, or project-refresh internals.

### Run-start surface decision

The M9-00 decision gate originally preferred reusing the existing `goal start` path plus a `WorkflowRun` link over introducing a new `workflow run start` CLI verb. M10 now supersedes that future-facing preference: first-class workflow run start belongs to the workflow-first runtime path on top of persisted workflow definitions. Any M9-compatible start path that uses these live wrappers must still refuse unless the repo lease can be acquired and required approvals already exist, and never infer approval from prose.

## M9 Implementation Sequence

The M9-00 decision gate (NGX-331) pinned the slice order below. These slices remain the source context for the live-wrapper foundation that M10 builds on:

1. **NGX-331 — M9-00 Contract and decision gate:** promote this draft into the active milestone, choose the live-wrapper architecture, pin non-goals, pin this implementation sequence, and update roadmap / doctor-marker policy. No runtime behavior change.
2. **NGX-332 — M9-01 Live wrapper config and registry:** add typed config parsing, refusal codes, wrapper resolution, probe support, and deterministic fixture tests.
3. **NGX-333 — M9-02 Live implementation step wrapper:** run the `implementation` step through an explicit live wrapper with lease / heartbeat / result-file capture.
4. **NGX-334 — M9-03 Verification and commit transaction:** wire live step output into Momentum verification, commit intent, failure reset, result-document recovery, unsafe finalization recovery, dispatch recovery, and finalization lock / lease reconciliation.
5. **NGX-335 — M9-04 Postflight and no-mistakes wrappers:** add live wrappers for postflight and no-mistakes with result normalization and recovery taxonomy.
6. **NGX-336 — M9-05 Merge cleanup and Linear refresh boundaries:** add wrappers or explicit handoff gates for merge cleanup and Linear refresh without bypassing M6 external apply.
7. **NGX-337 — M9-06 Live recovery and resume smoke:** prove stale lease, timeout, failed verification, recovery clear / resume behavior, and the NGX-334 result / head / finalization recovery paths in smoke form.
8. **NGX-338 — M9-07 Dogfood run and closeout:** run a real Momentum issue through Momentum-owned live execution, record evidence, and extend the regression matrix.

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

The `doctor --json` marker stayed pinned to the then-most-recently closed milestone — `Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete` — through M9 foundation work. The M9-00 decision gate (NGX-331) did not flip it; M10 closeout later advanced the marker.
