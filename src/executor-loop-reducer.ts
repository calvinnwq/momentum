/**
 * Pure state model for the executor loop nested below a `StepRun` (M10-03,
 * NGX-347).
 *
 * This module owns only the canonical vocabulary, the transition reducers, and
 * the record *shapes* for the `ExecutorDefinition` / `ExecutorInvocation` /
 * `ExecutorRound` layer described in internal/contracts/executor-loop.md. It
 * follows the same discipline as `workflow-run-reducer.ts` and
 * `workflow-definition.ts`: no SQLite, no file system, no executor invocation.
 * Durable `executor_*` tables and the persistence twin are layered on top of
 * these primitives in later M10-03 slices, exactly as M7 layered
 * `workflow-run-import-persist.ts` on top of `workflow-run-reducer.ts`.
 *
 * The contract pins this nesting so bounded autonomy never flattens into
 * top-level workflow steps:
 *
 *   StepRun -> ExecutorInvocation -> ExecutorRound[]
 *
 * Scope decisions pinned here, grounded in internal/contracts/executor-loop.md:
 *
 *   - The invocation/round *state* `blocked` is terminal (contract "Executor
 *     States": "Terminal invocation states are `manual_recovery_required`,
 *     `blocked`, `failed`, `succeeded`, and `cancelled`. Terminal round states
 *     are the same."). This is distinct from the daemon *classification*
 *     `blocked` ("durable non-terminal blockage"): the round/invocation record
 *     is an immutable attempt that ends blocked, while the *workflow* can later
 *     recover by starting a fresh invocation/round once the blocker clears.
 *   - `waiting_operator` is the one durable, non-terminal pause: it requires an
 *     explicit operator command / API decision / approved delegated policy
 *     before the daemon may continue, so it can always resume into an active
 *     processing state.
 *   - A round cannot silently skip the capture/state-mirror phase (contract
 *     "Round Lifecycle"): `succeeded` is unreachable straight from `pending` /
 *     `running` and must pass through `capturing_result` /
 *     `mirroring_external_state` (with optional `finalizing`). Result-bearing
 *     families capture a normalized result or mirrored external state there;
 *     the `script` family may use `capturing_result` as a bare transition for
 *     exit-code-plus-log success.
 *   - An invocation must `preparing` before it can `running` (resolve agent /
 *     model / leases first), mirroring the step reducer's
 *     pending -> approved -> running ordering.
 *   - `executorFamily` reuses the M10-01 {@link WorkflowExecutorFamily}
 *     vocabulary so executor-loop records stay wire-compatible with
 *     `StepDefinition.executor`.
 */

import type { WorkflowExecutorFamily } from "./workflow-definition.js";
import type { TransitionResult } from "./workflow-run-reducer.js";

export type { WorkflowExecutorFamily } from "./workflow-definition.js";

/**
 * Executor invocation states (contract "Executor States"). One invocation is a
 * single configured executor session for a step.
 */
export const EXECUTOR_INVOCATION_STATES = [
  "pending",
  "preparing",
  "running",
  "pausing",
  "waiting_operator",
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled"
] as const;
export type ExecutorInvocationState =
  (typeof EXECUTOR_INVOCATION_STATES)[number];

export const EXECUTOR_INVOCATION_TERMINAL_STATES = [
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled"
] as const satisfies readonly ExecutorInvocationState[];
export type ExecutorInvocationTerminalState =
  (typeof EXECUTOR_INVOCATION_TERMINAL_STATES)[number];

/**
 * Executor round states (contract "Executor States"). One round is a single
 * bounded loop attempt under an invocation.
 */
export const EXECUTOR_ROUND_STATES = [
  "pending",
  "running",
  "capturing_result",
  "finalizing",
  "mirroring_external_state",
  "waiting_operator",
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled"
] as const;
export type ExecutorRoundState = (typeof EXECUTOR_ROUND_STATES)[number];

export const EXECUTOR_ROUND_TERMINAL_STATES = [
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled"
] as const satisfies readonly ExecutorRoundState[];
export type ExecutorRoundTerminalState =
  (typeof EXECUTOR_ROUND_TERMINAL_STATES)[number];

/**
 * Daemon completion classifications (contract "Completion Classification").
 * Executor output is classified into exactly one of these decisions; the
 * executor recommends, the daemon decides.
 */
export const EXECUTOR_COMPLETION_CLASSIFICATIONS = [
  "complete",
  "continue",
  "approval_required",
  "operator_decision_required",
  "manual_recovery_required",
  "blocked",
  "failed",
  "cancelled"
] as const;
export type ExecutorCompletionClassification =
  (typeof EXECUTOR_COMPLETION_CLASSIFICATIONS)[number];

/**
 * Human-gate types (contract "Human Gates"). Gates are durable records, not
 * prompts hidden inside an executor.
 */
export const EXECUTOR_HUMAN_GATE_TYPES = [
  "approval_required",
  "operator_decision_required",
  "manual_recovery_required",
  "policy_boundary_exceeded",
  "quota_exhausted",
  "scope_boundary_exceeded",
  "credential_required",
  "external_state_required",
  "destructive_action_requested"
] as const;
export type ExecutorHumanGateType =
  (typeof EXECUTOR_HUMAN_GATE_TYPES)[number];

/**
 * Artifact classes a round can write or mirror (contract "Required Artifacts").
 * Artifact paths are evidence pointers; SQLite stays the source of truth for
 * state and classification. One entry per contract bullet, in order: the
 * normalized result document when the family emits one (the `script` family does
 * not on success), bounded logs, the checkpoint stream, verification output,
 * commit/reset evidence after repo finalization, and the recovery note when
 * manual recovery is required.
 */
export const EXECUTOR_ARTIFACT_CLASSES = [
  "result_document",
  "logs",
  "checkpoint_stream",
  "verification_output",
  "commit_or_reset_evidence",
  "recovery_note"
] as const;
export type ExecutorArtifactClass =
  (typeof EXECUTOR_ARTIFACT_CLASSES)[number];

const INVOCATION_STATE_SET: ReadonlySet<ExecutorInvocationState> = new Set(
  EXECUTOR_INVOCATION_STATES
);
const INVOCATION_TERMINAL_SET: ReadonlySet<ExecutorInvocationState> = new Set(
  EXECUTOR_INVOCATION_TERMINAL_STATES
);
const ROUND_STATE_SET: ReadonlySet<ExecutorRoundState> = new Set(
  EXECUTOR_ROUND_STATES
);
const ROUND_TERMINAL_SET: ReadonlySet<ExecutorRoundState> = new Set(
  EXECUTOR_ROUND_TERMINAL_STATES
);

// Failure-ish terminals reachable from any active (non-terminal) state. A round
// or invocation can abort to a recovery, blockage, failure, or cancellation at
// any stage; the daemon's recovery taxonomy decides which one applies.
const INVOCATION_ABORTS: readonly ExecutorInvocationState[] = [
  "blocked",
  "failed",
  "manual_recovery_required",
  "cancelled"
];
const ROUND_ABORTS: readonly ExecutorRoundState[] = [
  "blocked",
  "failed",
  "manual_recovery_required",
  "cancelled"
];

const INVOCATION_ALLOWED: Readonly<
  Record<ExecutorInvocationState, readonly ExecutorInvocationState[]>
> = {
  pending: ["preparing", ...INVOCATION_ABORTS],
  preparing: ["running", "waiting_operator", ...INVOCATION_ABORTS],
  running: ["pausing", "waiting_operator", "succeeded", ...INVOCATION_ABORTS],
  pausing: ["waiting_operator", ...INVOCATION_ABORTS],
  // Durable pause: resume into an active state, or settle to a failure-ish
  // terminal. Never straight to `succeeded` — a resumed invocation must run.
  waiting_operator: ["running", "preparing", ...INVOCATION_ABORTS],
  manual_recovery_required: [],
  blocked: [],
  failed: [],
  succeeded: [],
  cancelled: []
};

const ROUND_ALLOWED: Readonly<
  Record<ExecutorRoundState, readonly ExecutorRoundState[]>
> = {
  pending: ["running", "mirroring_external_state", "waiting_operator", ...ROUND_ABORTS],
  // No direct `succeeded`: result-bearing families must capture a result or
  // mirror external state first. The script family still passes through the
  // capture state, but as a bare exit-code/log capture with no result document.
  running: [
    "capturing_result",
    "mirroring_external_state",
    "waiting_operator",
    ...ROUND_ABORTS
  ],
  mirroring_external_state: [
    "capturing_result",
    "finalizing",
    "succeeded",
    "waiting_operator",
    ...ROUND_ABORTS
  ],
  capturing_result: ["finalizing", "succeeded", "waiting_operator", ...ROUND_ABORTS],
  finalizing: ["succeeded", "waiting_operator", ...ROUND_ABORTS],
  waiting_operator: [
    "running",
    "capturing_result",
    "finalizing",
    "mirroring_external_state",
    ...ROUND_ABORTS
  ],
  manual_recovery_required: [],
  blocked: [],
  failed: [],
  succeeded: [],
  cancelled: []
};

export type ExecutorInvocationTransitionErrorCode =
  | "executor_invocation_unknown_state"
  | "executor_invocation_terminal"
  | "executor_invocation_invalid_transition";

export type ExecutorRoundTransitionErrorCode =
  | "executor_round_unknown_state"
  | "executor_round_terminal"
  | "executor_round_invalid_transition";

export function isTerminalExecutorInvocationState(
  state: ExecutorInvocationState
): boolean {
  return INVOCATION_TERMINAL_SET.has(state);
}

export function isTerminalExecutorRoundState(
  state: ExecutorRoundState
): boolean {
  return ROUND_TERMINAL_SET.has(state);
}

/**
 * Validate an executor invocation state transition. Refuses unknown states,
 * transitions out of a terminal state, and any transition not in the allowed
 * graph. A same-state transition is a no-op success.
 */
export function transitionExecutorInvocation(
  from: ExecutorInvocationState,
  to: ExecutorInvocationState
): TransitionResult<
  ExecutorInvocationState,
  ExecutorInvocationTransitionErrorCode
> {
  if (!INVOCATION_STATE_SET.has(from) || !INVOCATION_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "executor_invocation_unknown_state",
      errorMessage: `unknown executor invocation state: from=${String(from)} to=${String(to)}`
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (INVOCATION_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "executor_invocation_terminal",
      errorMessage: `executor invocation is in terminal state ${from}; cannot transition to ${to}`
    };
  }
  if (!INVOCATION_ALLOWED[from].includes(to)) {
    return {
      ok: false,
      errorCode: "executor_invocation_invalid_transition",
      errorMessage: `executor invocation cannot transition from ${from} to ${to}`
    };
  }
  return { ok: true, state: to };
}

/**
 * Validate an executor round state transition. Refuses unknown states,
 * transitions out of a terminal state, and any transition not in the allowed
 * graph — including fast-pathing to `succeeded` without first entering the
 * capture or mirror phase. A same-state transition is a no-op success.
 */
export function transitionExecutorRound(
  from: ExecutorRoundState,
  to: ExecutorRoundState
): TransitionResult<ExecutorRoundState, ExecutorRoundTransitionErrorCode> {
  if (!ROUND_STATE_SET.has(from) || !ROUND_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "executor_round_unknown_state",
      errorMessage: `unknown executor round state: from=${String(from)} to=${String(to)}`
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (ROUND_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "executor_round_terminal",
      errorMessage: `executor round is in terminal state ${from}; cannot transition to ${to}`
    };
  }
  if (!ROUND_ALLOWED[from].includes(to)) {
    return {
      ok: false,
      errorCode: "executor_round_invalid_transition",
      errorMessage: `executor round cannot transition from ${from} to ${to}`
    };
  }
  return { ok: true, state: to };
}

/**
 * The rich per-step executor configuration the contract calls
 * `ExecutorDefinition`. `StepDefinition.executor` names only the executor
 * *family*; this record carries the deterministic agent / model / effort /
 * timeout / policy knobs resolved by the contract's selection precedence
 * ("Agent And Model Selection") and copied into each round before it starts.
 */
export type ExecutorDefinitionRecord = {
  executorKey: string;
  family: WorkflowExecutorFamily;
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  timeoutMs: number | null;
  maxRounds: number | null;
  policyEnvelope: string | null;
};

/**
 * One configured executor session for a step run (contract "State Model"). An
 * invocation owns its rounds; its identity reattaches to the owning
 * `workflow_runs` / `workflow_steps` rows by `(workflowRunId, stepRunId)`.
 */
export type ExecutorInvocationRecord = {
  invocationId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  executorFamily: WorkflowExecutorFamily;
  state: ExecutorInvocationState;
  attempt: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
};

/**
 * One bounded loop attempt under an invocation (contract "Round Schema"). The
 * common identity, execution, and result fields below are what workflow status,
 * handoff, monitor, and recovery surfaces rely on without understanding the
 * executor internals. Executor-specific evidence is layered on durably as
 * separate {@link ExecutorArtifactRecord} / {@link ExecutorCheckpointRecord} /
 * {@link ExecutorFindingRecord} / {@link ExecutorDecisionRecord} child records
 * that hang below a round.
 */
export type ExecutorRoundRecord = {
  // Identity and ordering.
  roundId: string;
  invocationId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  executorFamily: WorkflowExecutorFamily;
  attempt: number;
  roundIndex: number;
  // Execution.
  state: ExecutorRoundState;
  classification: ExecutorCompletionClassification | null;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  inputDigest: string | null;
  resultDigest: string | null;
  artifactRoot: string | null;
  logPaths: string[];
  // Result.
  summary: string | null;
  keyChanges: string[];
  remainingWork: string[];
  changedFiles: string[];
  verificationStatus: string | null;
  commitSha: string | null;
  recoveryCode: string | null;
  humanGate: ExecutorHumanGateType | null;
};

/**
 * One evidence artifact a round wrote or mirrored (contract "Required
 * Artifacts"). `path` is an evidence pointer; the durable row, not the file, is
 * the source of truth that the artifact exists for this round.
 */
export type ExecutorArtifactRecord = {
  artifactId: string;
  roundId: string;
  artifactClass: ExecutorArtifactClass;
  path: string;
  digest: string | null;
  description: string | null;
};

/**
 * One entry in a round's checkpoint stream for a major executor stage (contract
 * "Round Lifecycle" / "Required Artifacts"). `sequence` orders the stream within
 * a round and is unique per round.
 */
export type ExecutorCheckpointRecord = {
  checkpointId: string;
  roundId: string;
  sequence: number;
  stage: string;
  detail: string | null;
};

/**
 * One finding a round surfaced (contract "Round Lifecycle"; the no-mistakes
 * mirror's "Review findings" / "Selected finding IDs"). `selected` marks a
 * finding the daemon or operator chose to act on; `externalRef` mirrors an
 * external reviewer's finding id when one exists.
 */
export type ExecutorFindingRecord = {
  findingId: string;
  roundId: string;
  severity: string | null;
  title: string;
  detail: string | null;
  selected: boolean;
  externalRef: string | null;
};

/**
 * One durable decision point a round produced (contract "Completion
 * Classification" `operator_decision_required`; the no-mistakes mirror's
 * "Decisions and delegated-policy results"). `allowedActions` is the action set
 * the decision offers; `resolution` records the delegated-policy or operator
 * outcome once the decision is settled.
 */
export type ExecutorDecisionRecord = {
  decisionId: string;
  roundId: string;
  summary: string;
  allowedActions: string[];
  recommendedAction: string | null;
  chosenAction: string | null;
  resolution: string | null;
  externalRef?: string | null;
};
