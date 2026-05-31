# Contract: Live Workflow Execution (M9)

**Status:** Active. Promoted at the M9-00 decision gate (NGX-331) after M8 closeout. This contract is now authoritative for live workflow execution while Milestone 9 is in flight; the M8 operator-control contract remains in force for its own invariants.

This contract defines the boundary for moving Momentum from a durable coding-workflow substrate plus operator-control surface into a live dogfooding orchestrator for OpenClaw coding workflows.

M7 made workflow state durable. M8 makes operator control durable. M9 is the first milestone allowed to make Momentum invoke live workflow steps.

## Goal

Make Momentum capable of running a bounded OpenClaw coding workflow end to end through live executors while preserving the safety properties that made M7 and M8 useful:

- The repo state is protected by the existing Goal / Job / repo-lock / verification transaction model.
- Each workflow step writes durable state before and after execution.
- Live process failures become explicit run recovery states, not lost chat turns.
- Verification gates are configured on the Goal / WorkflowRun and captured as artifacts.
- A human operator can inspect status, logs, handoff, recovery, approvals, and evidence without parsing chat.

The dogfood target is a real Momentum issue implemented through Momentum-owned live execution rather than the `coding-workflow-pipeline` skill owning the live run loop.

## Ownership Boundary

**Momentum owns in M9:**

- Live `WorkflowStepExecutor` wrappers for the canonical workflow step kinds: `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, and `linear-refresh`.
- Step claim / lease / heartbeat / terminal-state persistence around those wrappers.
- Process invocation through explicit local command specs, never implicit shells.
- Runner result normalization into the M7 `WorkflowStepExecutor` result shape.
- Verification capture through existing Momentum verification logs and result artifacts.
- Recovery classification for wrapper-level failures: runtime missing, auth unavailable, command failed, timeout, result missing, result invalid, output overflow, stale lease, and head mismatch.
- A dogfood smoke path that runs at least one real repo task with live wrappers enabled behind an explicit opt-in flag or profile.

**OpenClaw skills continue to own until a later milestone explicitly moves them:**

- The internal implementation of `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, and `project-progress-refresh`.
- Harness/model policy details that are not represented as explicit Momentum configuration.
- Discord delivery and approval-button presentation.
- Cron scheduling and notification cadence outside Momentum's own daemon / worker model.
- External tracker writes outside the M6 `intent apply --external-apply` contract.

M9 wraps existing executors. It does not rewrite them.

## Required Surfaces

### Live Step Wrapper Registry

Momentum adds a registry of live wrappers keyed by the existing `WorkflowStepKind` values. Each wrapper resolves from durable configuration, not hard-coded local paths.

Each wrapper config must include:

- `command`: absolute executable path.
- `args`: explicit argv array, with no shell interpolation.
- `cwd`: `repo` or `iteration`.
- `timeoutSec`: positive integer.
- `envAllow`: allowlist of environment variable names.
- `resultFile`: path relative to the iteration artifact directory.
- Optional `probe`: command / args / timeout used to detect missing runtime or auth before the main command.

Missing or malformed config refuses before mutating workflow state.

### Workflow Run Start

M9 prefers reusing the existing `goal start` path plus a `WorkflowRun` link for live workflow runs. A dedicated `workflow run start` verb is added only if a later M9 slice proves the simpler path cannot preserve the M7 / M8 state model. Either start path must satisfy the same invariants:

- It creates or imports a `WorkflowRun`.
- It records the planned step chain.
- It records the configured live wrapper profile.
- It refuses unless the repo lease can be acquired.
- It refuses unless required approvals already exist or the first unapproved boundary is explicit.
- It never infers approval from casual prose.

### Step Execution

Each live step execution must:

- Acquire a workflow lease before spawning the process.
- Write a start event before spawning.
- Heartbeat while the process is active or mark the lease stale if heartbeat cannot be maintained.
- Capture stdout / stderr to bounded artifact logs.
- Require a normalized result file for success.
- Persist terminal state before releasing the lease.
- Preserve enough evidence for `workflow status`, `workflow handoff`, `workflow run monitor`, and `evidence ingest`.

If the process exits successfully but the result file is missing or invalid, the step fails with `result_missing` or `result_invalid`. Success without a durable result is not success.

### Git And Verification Transaction

Momentum must keep its existing safety posture:

- A step may modify the worktree only while holding the repo lock.
- Verification runs after the implementation-producing step or after the configured final step, according to the live run profile.
- Verification logs are captured in Momentum artifacts.
- Commit intent is explicit and normalized.
- If verification fails and HEAD is still at the expected base, Momentum resets the worktree using the existing failure-reset path.
- If HEAD changed unexpectedly, Momentum enters manual recovery instead of destructive reset.
- Remote git operations (`fetch`, `pull`, `push`, `rebase`) remain out of scope unless a later contract adds them explicitly.

### Approvals

M9 consumes the M8 durable approval rows. It does not introduce a second approval system.

Starting, advancing, or retrying a live step must check:

- The run state.
- The current step state.
- The approval boundary required for that step.
- The manual-recovery flag.
- Active leases.
- Repo lock availability.

Illegal advance attempts refuse without partial mutation.

### Recovery

Live wrapper failures must map to stable recovery codes. M9 can extend the M8 taxonomy, but it cannot collapse distinct failure causes into generic failure text.

At minimum:

- `runtime_unavailable`
- `auth_unavailable`
- `command_failed`
- `command_timed_out`
- `result_missing`
- `result_invalid`
- `output_overflow`
- `stale_live_step`
- `head_mismatch`
- `manual_recovery_required`

When recovery is required, Momentum writes the per-run `recovery.md` artifact and sets the durable recovery flag before returning control to the operator.

## Dogfood Gate

M9 is not complete until a real Momentum issue has been run through Momentum-owned live execution.

The dogfood run must prove:

- A live implementation step can modify the repo.
- Verification runs and is captured.
- A commit is created through Momentum's transaction path.
- Status / logs / handoff / monitor surfaces show the run without chat reconstruction.
- Recovery behavior is demonstrated by an isolated failure fixture or a controlled failing live wrapper.
- The run can be inspected after process or session loss using only durable state.

The first dogfood target should be a low-blast-radius Momentum issue with local-only changes and no external writes.

## Non-Goals

M9 does not include:

- Rewriting GNHF, postflight, no-mistakes, model-evidence, or project-progress-refresh internals.
- Discord approval rendering or channel delivery.
- Cron scheduling outside Momentum daemon / worker semantics.
- Dashboards or web UI.
- Strong sandboxing with containers, VMs, or seccomp.
- Parallel same-repo worktrees.
- Remote git operations.
- Autonomous external writes outside the M6 apply contract.
- Generalizing WorkflowRun beyond OpenClaw coding workflows.

## Compatibility

M9 must preserve:

- M3 daemon / recovery surfaces.
- M4 `RunnerAdapter` profiles: `fake`, `trusted-shell`, `acp`.
- M5 source / evidence / intent surfaces.
- M6 external apply.
- M7 WorkflowRun substrate.
- M8 operator-control envelopes.

Existing fake-executor smokes remain the default CI-safe path. Live-wrapper tests must be opt-in unless they use deterministic local fixture commands.

## Acceptance Criteria

M9 can close only when:

- The live wrapper registry exists with stable config parsing and refusal codes.
- At least the implementation and verification-producing path can run through Momentum-owned execution.
- Postflight / no-mistakes / merge-cleanup / linear-refresh wrappers are either implemented or explicitly split into follow-up slices with a documented dogfood limitation.
- A live dogfood run is recorded in internal docs with command evidence, artifacts, and rollback notes.
- The regression matrix is extended with live-wrapper failure modes.
- `doctor --json` flips to an M9 closeout marker only after the above gates pass.

