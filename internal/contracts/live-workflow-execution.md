# Contract: Live Workflow Execution (M9)

**Status:** Accepted foundation. Promoted at the M9-00 decision gate (NGX-331) after M8 closeout. This contract remains authoritative for live workflow execution primitives that M10 builds on; the M8 operator-control contract remains in force for its own invariants.

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
- Recovery classification for live dispatch and run-level finalization failures, including process/runtime/auth/result failures, unsafe git / lock / reset / commit outcomes, executor throws, manual recovery requests, and moved HEADs; see the current run-level taxonomy in [Recovery](#recovery).
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

Each durable wrapper config uses the same snake_case field style as the existing runner frontmatter and must include:

- `command`: absolute executable path.
- `args`: explicit argv array, with no shell interpolation.
- `cwd`: `repo` or `iteration`.
- `timeout_sec`: positive integer.
- `env_allow`: allowlist of environment variable names. Only listed names are inherited from the source environment; even `PATH` is forwarded only when explicitly allowed.
- `result_file`: path relative to the iteration artifact directory.
- Optional `probe`: `command` / `args` / `timeout_sec` used to detect missing runtime or auth before the main command; when omitted inside `probe`, `args` defaults to `[]` and `timeout_sec` defaults to `30`.

The typed in-memory config may expose camelCase properties such as `timeoutSec`, `envAllow`, and `resultFile`, but the durable config keys stay snake_case for consistency with `trusted_shell` and `acp`.

Durable live-wrapper profiles must be mappings with a non-empty `name` and a non-empty `wrappers` object. `wrappers` keys must be canonical `WorkflowStepKind` values; each value is one wrapper config. A profile may configure only the step kinds it supports. Resolving a known but unconfigured kind refuses separately from an unknown kind instead of guessing.

Missing or malformed config refuses before mutating workflow state. The live-wrapper config and registry layer uses these stable refusal codes:

- `live_wrapper_config_missing`: a wrapper config value is absent.
- `live_wrapper_config_invalid`: a wrapper config is malformed.
- `live_wrapper_profile_missing`: a live-wrapper profile value is absent.
- `live_wrapper_profile_invalid`: the profile name, wrappers mapping, wrapper key, or nested wrapper config is malformed.
- `live_wrapper_unsupported_kind`: resolution requested a non-`WorkflowStepKind` value.
- `live_wrapper_not_configured`: resolution requested a supported step kind that the profile does not configure.

### Workflow Run Start

At the M9-00 decision gate, this contract preferred reusing the existing `goal start` path plus a `WorkflowRun` link for live workflow runs. M10 now supersedes that future-facing start-surface preference: first-class workflow run start belongs to the workflow-first runtime path on top of persisted workflow definitions. Any M9-compatible start path that uses these live wrappers must still satisfy the same invariants:

- It creates or imports a `WorkflowRun`.
- It records the planned step chain.
- It records the configured live wrapper profile.
- It refuses unless the repo lease can be acquired.
- It refuses unless required approvals already exist or the first unapproved boundary is explicit.
- It never infers approval from casual prose.

### Step Execution

Each live step execution must:

- Acquire a workflow lease before spawning the process.
- Acquire that managed-step lease with `manual-recovery-required` as the default
  stale policy, so a lost live process routes to operator recovery rather than
  silently auto-releasing. A caller may explicitly override the stale policy for
  narrower harnesses.
- Write a start event before spawning.
- Heartbeat while the process is active; if heartbeat cannot be maintained, leave the outstanding lease to become stale by expiry and stale-policy classification.
- Capture stdout / stderr to bounded artifact logs.
- Require a normalized result file for success.
- Persist terminal state before releasing the lease.
- Preserve enough evidence for `workflow status`, `workflow handoff`, `workflow run monitor`, `workflow run logs`, and `evidence ingest`.

If the process exits successfully but the result file is missing or invalid, the step fails with `result_missing` or `result_invalid`. Success without a durable result is not success.

Live wrappers inject workflow-context environment variables outside `env_allow`: `MOMENTUM_RUN_ID`, `MOMENTUM_STEP_ID`, `MOMENTUM_STEP_KIND`, `MOMENTUM_ATTEMPT`, `MOMENTUM_REPO_PATH`, `MOMENTUM_ITERATION_DIR`, optional `MOMENTUM_PROMPT_PATH`, and `MOMENTUM_RESULT_PATH`. The result path is resolved from the wrapper's `result_file` under the iteration artifact directory; runners must write the normalized result document to `MOMENTUM_RESULT_PATH` rather than deriving their own path.

`result_file` is rejected when absolute or escaping the iteration directory. Execution also rejects symlink or non-directory parent escapes, clears any stale result before spawning, and refuses result documents over 1 MiB instead of reading them.

Live wrapper commands run as Momentum-supervised foreground processes. Stdout and stderr are each capped by the 256 MiB default output ceiling. On timeout, output overflow, or after the main command exits, Momentum kills the process group / child process; wrappers must not depend on daemonized or background child work surviving the step command.

A valid normalized runner result with `success: false` is treated as an executed-but-failed step with `command_failed`, not as a missing or invalid result document.

After a live step has started, an executor result of `skipped` is persisted as `succeeded` because the durable live transition path does not allow `running -> skipped`.

### Git And Verification Transaction

Momentum must keep its existing safety posture:

- A step may modify the worktree only while holding the repo lock.
- Verification runs after the implementation-producing step or after the configured final step, according to the live run profile.
- Verification logs are captured in Momentum artifacts.
- Commit intent is explicit and normalized.
- If verification fails and HEAD is still at the expected base, Momentum resets the worktree using the existing failure-reset path.
- If HEAD changed unexpectedly, Momentum enters manual recovery instead of destructive reset.
- The repo lock and managed-step lease stay heartbeated through verification, commit, reset, and post-finalization acceptance; a lost repo lock or workflow lease before any further git mutation routes to `repo_lock_lost` recovery. Repo-lock refreshes are monotonic: finalization must not move `repo_locks.heartbeat_at`, `lease_expires_at`, or `updated_at` backward if a concurrent heartbeat has already advanced that row. Heartbeating stops before the shared recovery flag / `recovery.md` write, but the deferred managed-step lease is released only after terminal or recovery reconciliation is durable.
- Momentum also re-checks repo / workflow ownership after the finalization transaction returns, before accepting terminal success. If ownership is lost after git already advanced HEAD, Momentum rejects the terminal success, enters `repo_lock_lost` recovery, and leaves the operator to inspect the committed state.
- Terminal step state for a cleanly dispatched live step is deferred until the finalization transaction reconciles the commit, reset, or recovery outcome.
- Remote git operations (`fetch`, `pull`, `push`, `rebase`) remain out of scope unless a later contract adds them explicitly.

### Approvals

M9 consumes the M8 durable approval rows. It does not introduce a second approval system.

Starting, advancing, or retrying a live step must check:

- The run state; live execution may start only when the durable run state is `approved` or `running`.
- The current step state; normal live execution only starts from `approved`.
- That no other step in the same run is already `running`.
- That all lower-order required predecessor steps are `succeeded` or `skipped`.
- The approval boundary required for that step.
- The manual-recovery flag.
- Active leases.
- Repo path and repo lock availability; live execution requires `workflow_runs.repo_path` to be present and equal `executorInput.repoPath`. Repo-backed runs must also have a durable `workflow_runs.goal_id` plus an active, unexpired `repo_locks` row for `workflow_runs.repo_path` held by the same holder and matching goal id. Live execution heartbeats that repo lock while the managed step runs and while finalization owns verification / git mutation.

Illegal advance attempts refuse without partial mutation. A step already marked
`running` is a recovery/reattach concern, not an implicit idempotent start.

### Recovery

Live wrapper failures must map to stable recovery codes. M9 can extend the M8 taxonomy, but it cannot collapse distinct failure causes into generic failure text. The M9 live run-level recovery classifications are:

- `head_mismatch`
- `result_missing`
- `result_invalid`
- `reset_failed`
- `repo_lock_lost`
- `git_failed`
- `commit_failed`
- `invalid_input`
- `runtime_unavailable`
- `auth_unavailable`
- `command_failed`
- `command_timed_out`
- `output_overflow`
- `executor_threw`
- `manual_recovery_required`

`stale_live_step` remains reserved for stale live-execution lease recovery; the M9-03 finalization path does not emit it directly.

The live wrapper preserves `auth_unavailable` and `output_overflow` as precise live recovery codes. The M7 executor dispatch taxonomy maps them to `runtime_unavailable` and `command_failed` respectively while retaining the precise live code for recovery handling.

Live finalization maps unsafe git / result outcomes into the same run-level taxonomy: moved HEAD becomes `head_mismatch`; missing or untrusted result documents become `result_missing` / `result_invalid`; failed cleanup becomes `reset_failed`; lost ownership becomes `repo_lock_lost`; git and input failures retain `git_failed` and `invalid_input`. Commit failures enter `commit_failed` recovery only when Momentum cannot prove cleanup; `nothing_to_commit` and commit failures followed by a successful reset remain clean step-failure outcomes without the run-scoped recovery flag. Process-level dispatch failures choose the first valid live run-level recovery code from the wrapper's precise `liveRecoveryCode`, then the executor dispatch code, and otherwise fall back to `command_failed`.

When recovery is required, Momentum sets the durable recovery flag before returning control to the operator. Rendering the per-run `recovery.md` artifact is best-effort after the flag is set; if artifact rendering fails, the flag and stored manual-recovery reason remain authoritative and the recovery result reports `artifact_write_failed`.

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
- Closeout evidence is recorded without flipping `doctor --json`; the marker stayed pinned to the M8 closeout string through M9 foundation work, M10 closeout advanced it to the M10 string, and M11 closeout later advanced the current marker to the M11 string.
