# Contract: Executor Loop

**Status:** Accepted planning contract. This contract refines the workflow-first runtime pivot by pinning how step executors run bounded autonomous work or mirror external executor state under a `StepRun`. It does not authorize schema, CLI, daemon, or external integration changes by itself.

The workflow-first runtime contract defines the top-level product shape:

```text
WorkflowDefinition -> StepDefinition[]
WorkflowRun -> StepRun[]
StepRun -> ExecutorInvocation -> ExecutorRound[]
```

This contract defines the executor-loop layer inside that shape.

## Core Boundary

The workflow daemon owns orchestration. Executors own bounded work.

The daemon owns:

- Selecting runnable workflow runs and step runs.
- Enforcing approvals, leases, repo ownership, manual recovery, and workflow policy.
- Starting executor invocations and rounds.
- Persisting authoritative state.
- Classifying executor output.
- Advancing or pausing the workflow.

An executor owns:

- Preparing a bounded unit of work.
- Running the configured mechanism for that unit.
- Writing normalized result output or family-specific outcome evidence such as
  `script` exit-code plus bounded-log evidence.
- Emitting artifacts, checkpoints, findings, and decisions.
- Reporting a recommendation such as `complete`, `continue`, `blocked`, `failed`, or `manual_recovery`.

Executors may recommend progress. The daemon decides progress.

## State Model

Executor state is nested below step state, not flattened into top-level workflow steps.

```text
StepRun: implementation / running
  ExecutorInvocation: goal-loop / running
    ExecutorRound: round 1 / succeeded / continue
    ExecutorRound: round 2 / succeeded / continue
    ExecutorRound: round 3 / succeeded / complete
StepRun: implementation / succeeded
```

Required executor-loop records:

```text
executor_definitions
executor_invocations
executor_rounds
executor_artifacts
executor_findings
executor_decisions
executor_checkpoints
```

`StepRun` records whether the workflow step is approved, running, paused, or terminal. `ExecutorInvocation` records one configured executor session for that step. `ExecutorRound` records each bounded loop attempt or external mirror lane, including inputs, agent/model selection when Momentum owns the runner, output or mirrored state, verification, commit/recovery result, and remaining work.

## Executor States

Executor invocations use these planning states:

```text
pending
preparing
running
pausing
waiting_operator
manual_recovery_required
blocked
failed
succeeded
cancelled
```

Executor rounds use these planning states:

```text
pending
running
capturing_result
finalizing
mirroring_external_state
waiting_operator
manual_recovery_required
blocked
failed
succeeded
cancelled
```

Terminal invocation states are `manual_recovery_required`, `blocked`, `failed`, `succeeded`, and `cancelled`. Terminal round states are the same.

`waiting_operator` is not terminal. It is a durable pause that requires an explicit operator command, API decision, or approved delegated policy before the daemon may continue.

## Round Lifecycle

Each result-bearing round follows the same durable lifecycle, even when the executor family is different:

1. Load `WorkflowRun`, `StepRun`, `StepDefinition`, executor config, prior round summaries, repo policy, and current recovery state.
2. Resolve agent, model, effort, and tool policy from the configured precedence rules.
3. Acquire or refresh the daemon lease, step lease, and repo lock required by the step.
4. Create an `executor_rounds` row before invoking external work.
5. Run the executor with explicit argv/env/config and a daemon-provided artifact directory.
6. Require a normalized result document or mirrored external state snapshot, except deterministic `script` rounds that succeed from exit code plus bounded logs.
7. Capture artifacts, logs, checkpoints, findings, decisions, and verification output.
8. Run finalization when the round may mutate repo state or create a commit.
9. Classify the round result.
10. Persist the daemon's decision to continue, pause, fail, recover, or complete.

An executor cannot silently skip the normalized result step. If the executor cannot produce a valid result or state snapshot, the daemon classifies the round as failed or manual recovery based on the configured recovery taxonomy. The `script` family is the narrow result-bearing exception: a successful script round records the command exit status and bounded logs, emits a bare capture transition, and omits `result_captured` because no normalized result document exists.

The `no-mistakes` family uses the same durable envelope differently: one long-lived mirror round is born in `mirroring_external_state`, each daemon poll reconciles the latest external snapshot into that same round, and the round either heartbeats in place, pauses in `waiting_operator`, or settles terminally. Momentum persists findings and decisions below that mirror round but does not split the external review/fix phases into separate Momentum rounds.

The phase-1 workflow dispatcher may create an invocation / first-round scaffold
before a bounded adapter drives the real executor mechanism. That scaffold is
owned by the dispatcher, uses deterministic ids (`<run>::<step>::dispatch` and
`<invocation>::round-1`) so re-entry cannot fork a second owner, and must carry
no fabricated result evidence: no digests, artifact root, logs, summary,
verification, commit, recovery, or human gate until executor work actually
produces it. A configured daemon-default live-wrapper profile may now drive that
scaffold to terminal executor evidence in the same daemon tick; without a
configured wrapper for the dispatched step kind, the scaffold is parked for
manual recovery rather than being treated as a clean terminal.

## Round Schema

Each `executor_rounds` record must preserve enough information to reattach after process, daemon, or chat loss.

Required identity and ordering fields:

- `round_id`
- `invocation_id`
- `workflow_run_id`
- `step_run_id`
- `step_key`
- `executor_family`
- `attempt`
- `round_index`

Required execution fields:

- `state`
- `classification`
- `started_at`
- `heartbeat_at`
- `finished_at`
- `agent_provider`
- `model`
- `effort`
- `input_digest`
- `result_digest`
- `artifact_root`
- `log_paths`

Required result fields:

- `summary`
- `key_changes`
- `remaining_work`
- `changed_files`
- `verification_status`
- `commit_sha`
- `recovery_code`
- `human_gate`

The schema may add executor-specific payload fields, but the common fields above are what workflow status, handoff, monitor, and recovery surfaces can rely on without understanding the executor internals. `workflow run logs` reuses the same fields and attaches the round child-evidence tables for run-scoped read-back.

## Required Artifacts

Every round writes or mirrors the artifact classes that apply to its executor
family:

- Normalized result document for result-bearing families; the `script` family
  omits this on success.
- Bounded stdout/stderr or equivalent external logs.
- Checkpoint stream for major executor stages.
- Verification output when verification is configured.
- Commit or reset evidence when repo finalization runs.
- Recovery note when manual recovery is required.

Artifact paths are evidence pointers. SQLite remains the source of truth for state and classification.

## Completion Classification

Executor output must be classified into one of these daemon decisions:

```text
complete
continue
approval_required
operator_decision_required
manual_recovery_required
blocked
failed
cancelled
```

`complete` means the step can move toward terminal success, subject to final workflow checks.

`continue` means the executor recommends another round, but the daemon must still enforce max rounds, budget, scope, leases, approvals, verification status, and recovery state.

`approval_required` means the workflow boundary requires an approval that does not exist yet.

`operator_decision_required` means the executor produced a durable decision point with allowed actions.

`manual_recovery_required` means Momentum cannot safely proceed without operator inspection and recovery.

`blocked` means the executor reached a durable non-terminal blockage that may be resolved by changing input, policy, credentials, or external state.

`failed` means the step should fail under the current policy.

`cancelled` means an explicit operator or policy cancellation stopped the invocation.

## Human Gates

Human gates are durable records, not prompts hidden inside an executor.

Gate records must include:

- `gate_id`
- `workflow_run_id`
- `step_run_id`
- `invocation_id`
- `round_id`
- `gate_type`
- `reason`
- `evidence`
- `allowed_actions`
- `recommended_action`
- `policy_envelope`
- `created_at`
- `resolved_at`
- `resolved_by`
- `resolution`

Gate types:

```text
approval_required
operator_decision_required
manual_recovery_required
policy_boundary_exceeded
quota_exhausted
scope_boundary_exceeded
credential_required
external_state_required
destructive_action_requested
```

Delegated policy may resolve a gate only when every requested action is inside the configured envelope. Otherwise the daemon pauses with the exact action set and evidence.

## Agent And Model Selection

Agent and model selection is deterministic. The precedence order is:

1. StepDefinition executor config.
2. WorkflowDefinition defaults.
3. Repository policy.
4. Executor family default.
5. Momentum global default.

The selected provider, model, effort, timeout, and policy envelope must be copied into the `executor_rounds` record before the round starts. A later config edit must not rewrite the historical record for an already-started round.

## Heartbeat And Reattach

The daemon must be able to reattach using durable state alone.

Reattach inputs:

- `workflow_runs`
- `step_runs`
- `executor_invocations`
- `executor_rounds`
- `workflow_leases`
- repo locks
- artifact roots
- external executor state snapshots

Process handles, sockets, hook events, and file watchers are fast-path hints. They are not proof of state.

Heartbeat rules:

- Active invocations and rounds must heartbeat while work is running.
- Heartbeat failure does not automatically mean failure; it means the daemon must inspect durable evidence.
- Expired leases classify as stale and route to the recovery policy for that step/executor family.
- Lost repo ownership before git mutation fails or pauses the round before mutation.
- Lost repo ownership after git mutation routes to manual recovery unless the finalizer proves a safe clean state.
- Deterministic invocation ids are single-owner keys. A duplicate same-attempt
  dispatch must fail closed before writing another round and must leave the
  existing invocation untouched; a real retry uses a fresh attempt id.

## External Executor Mirroring

External executors may maintain their own state stores, but Momentum must mirror enough state to decide workflow progress.

For a GNHF-like goal loop, Momentum mirrors:

- External run id.
- Branch and head SHA.
- Round index.
- Prompt/result artifact paths.
- Notes and logs.
- Commit SHA.
- Verification status.
- Completion recommendation.

For no-mistakes, Momentum mirrors:

- External run id.
- Branch and head SHA.
- Active external step.
- Step status.
- Review findings.
- Selected finding IDs.
- Decisions and delegated-policy results.
- PR URL and CI state.

The no-mistakes external-state reader consumes one bounded JSON snapshot file,
not the external daemon's private store directly. The file must be at most
1 MiB, UTF-8 encoded, and a JSON object with these camelCase fields:

- `externalRunId`, `branch`, `headSha`, `stepStatus`, and `ciState`: required strings.
- `activeStep` and `prUrl`: optional / nullable strings (`null` when absent).
- `findings`: required array of objects with string `externalId` and `title`,
  plus optional / nullable string `severity` and `detail`.
- `selectedFindingIds`: required array of strings matching surfaced finding ids.
- `decisions`: required array of objects with string `externalId`, string
  `summary`, string-array `allowedActions`, and optional / nullable string
  `recommendedAction`, `chosenAction`, and `resolution`.

External producers should emit `stepStatus` as one of `running`,
`awaiting_decision`, `awaiting_approval`, `blocked`, `failed`, or `completed`,
and `ciState` as one of `passed`, `failed`, `pending`, or `none`. Unknown enum
strings are structurally readable but classify as unreadable external evidence.

No-mistakes mirrors must pin an external identity anchor — external run id,
branch, and head SHA — before trusting readable external state. The anchor may
come from the caller's expected identity or a durable checkpoint, and subsequent
polls must corroborate the readable snapshot against it. A readable poll with no
pinned identity, or with a changed external run id / branch / head SHA, routes to
`manual_recovery_required` with recovery code `external_state_inconsistent`
instead of mirroring findings or decisions.

External state strings are never enough on their own. Momentum reconciles external state with artifacts, logs, repo state, configured completion requirements, and its own executor records.

## Executor Families

`goal-loop` runs bounded autonomous implementation rounds. It may continue across multiple rounds, but each round must have a normalized result, finalization decision, and daemon classification.

`one-shot` runs a single result-bearing command or agent wrapper. It may retry under policy, but it does not own an open-ended loop, and success requires a normalized result document.

`no-mistakes` mirrors no-mistakes daemon state and turns review findings into durable Momentum gates, findings, and decisions.

`script` runs deterministic local commands with explicit argv/env/cwd and bounded logs; success is exit-code and log based, without a normalized result document.

`external-apply` performs operator-mediated external writes through the existing external-apply safety contract.

`subworkflow` starts or attaches to another workflow run and mirrors its terminal classification back to the parent step.

The phase-1 production workflow dispatcher daemon-dispatches families with
landed bounded adapters: `goal-loop`, `one-shot`, `script`, `no-mistakes`, and
`external-apply`. The `external-apply` family routes through the existing
external-apply safety contract and terminalizes refused/unsafe outcomes into
manual recovery. `subworkflow` remains a valid executor family, but it fails
closed to `manual_recovery_required` until its daemon-dispatchable adapter lands
or the closeout explicitly keeps it deferred.

## Non-Goals

This contract does not implement:

- New migrations.
- New CLI commands.
- Additional workflow run start behavior beyond the M10-02 materialization surface.
- Daemon scheduling changes.
- Linear issue remapping.
- A public UI.
- Replacement of GNHF or no-mistakes internals.
- Remote git operations.

M10 carried these as implementation slices: M10-01 landed definition migrations, M10-02 landed workflow run start, M10-03 landed executor-loop records, M10-04 landed the opt-in daemon workflow scheduler lane, M10-05 landed the goal-loop executor adapter, M10-06 landed the one-shot / script executor adapters, M10-07 landed the no-mistakes executor mirror, M10-08 landed durable workflow gates / decisions, M10-09a wired the phase-1 production dispatcher into bounded managed `daemon start`, and M10-09 dogfooded the workflow-first path. RC-5b later wired configured daemon-default live-wrapper profiles into the bounded daemon lane so dispatch scaffolds can be terminalized by real wrapper results and reconciled through RC-2. RC-3 has since landed generalized `external-apply` dispatch through the same terminal-evidence lane; `subworkflow` dispatch remains later runtime work.
