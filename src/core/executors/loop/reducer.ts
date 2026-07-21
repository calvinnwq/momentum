/**
 * Pure state model for the executor loop nested below a `StepRun`.
 *
 * This module owns only the canonical vocabulary, the transition reducers, and
 * the record *shapes* for the `ExecutorDefinition` / `ExecutorAttempt` /
 * `ExecutorRound` layer described in SPEC.md. It
 * follows the same discipline as `src/core/workflow/run/reducer.ts` and
 * `src/core/workflow/definition/definition.ts`: no SQLite, no file system, no executor execution.
 * Durable `executor_*` tables and the persistence twin layer on top of these
 * primitives, exactly as workflow persistence layered `src/core/workflow/run/import-persist.ts` on top of
 * `src/core/workflow/run/reducer.ts`.
 *
 * The contract pins this nesting so bounded autonomy never flattens into
 * top-level workflow steps:
 *
 *   StepRun -> ExecutorAttempt -> ExecutorRound[]
 *
 * Scope decisions pinned here, grounded in SPEC.md:
 *
 *   - The attempt/round *state* `blocked` is terminal (contract "Executor
 *     States": "Terminal attempt states are `manual_recovery_required`,
 *     `blocked`, `failed`, `succeeded`, and `cancelled`. Terminal round states
 *     are the same."). This is distinct from the daemon *classification*
 *     `blocked` ("durable non-terminal blockage"): the round/attempt record
 *     is immutable once it ends blocked, while the *workflow* can later
 *     recover by starting a fresh attempt/round once the blocker clears.
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
 *   - An attempt must `preparing` before it can `running` (resolve agent /
 *     model / leases first), mirroring the step reducer's
 *     pending -> approved -> running ordering.
 *   - `executorFamily` reuses the {@link WorkflowExecutorFamily}
 *     vocabulary so executor-loop records stay wire-compatible with
 *     `StepDefinition.executor`.
 */

import type { ExecutorName } from "../../workflow/definition/definition.js";
import type { TransitionResult } from "../../workflow/run/reducer.js";

export type {
  ExecutorName,
  WorkflowExecutorFamily,
} from "../../workflow/definition/definition.js";

/**
 * Executor attempt states (contract "Executor States"). One attempt is one
 * executor go for one step and one executor identity; a retry inserts a new
 * attempt instead of reopening a terminal one.
 */
export const EXECUTOR_ATTEMPT_STATES = [
  "pending",
  "preparing",
  "running",
  "pausing",
  "waiting_operator",
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
] as const;
export type ExecutorAttemptState = (typeof EXECUTOR_ATTEMPT_STATES)[number];

export const EXECUTOR_ATTEMPT_TERMINAL_STATES = [
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
] as const satisfies readonly ExecutorAttemptState[];
export type ExecutorAttemptTerminalState =
  (typeof EXECUTOR_ATTEMPT_TERMINAL_STATES)[number];

/**
 * Executor round states (contract "Executor States"). One round is either a
 * single bounded loop iteration or a long-lived external mirror lane under an
 * attempt.
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
  "cancelled",
] as const;
export type ExecutorRoundState = (typeof EXECUTOR_ROUND_STATES)[number];

export const EXECUTOR_ROUND_TERMINAL_STATES = [
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
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
  "cancelled",
] as const;
export type ExecutorCompletionClassification =
  (typeof EXECUTOR_COMPLETION_CLASSIFICATIONS)[number];

const ATTEMPT_STATE_BY_CLASSIFICATION: Readonly<
  Record<ExecutorCompletionClassification, ExecutorAttemptState>
> = {
  complete: "succeeded",
  continue: "running",
  approval_required: "waiting_operator",
  operator_decision_required: "waiting_operator",
  manual_recovery_required: "manual_recovery_required",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
};

const ROUND_STATES_BY_CLASSIFICATION: Readonly<
  Record<ExecutorCompletionClassification, readonly ExecutorRoundState[]>
> = {
  complete: ["succeeded"],
  continue: ["succeeded", "failed"],
  approval_required: ["waiting_operator", "succeeded", "failed"],
  operator_decision_required: ["waiting_operator", "succeeded", "failed"],
  manual_recovery_required: ["manual_recovery_required"],
  blocked: ["blocked"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

export function executorAttemptStateForClassification(
  classification: ExecutorCompletionClassification,
): ExecutorAttemptState {
  return ATTEMPT_STATE_BY_CLASSIFICATION[classification];
}

export function isExecutorRoundStateCompatibleWithClassification(
  classification: ExecutorCompletionClassification,
  roundState: ExecutorRoundState,
): boolean {
  return ROUND_STATES_BY_CLASSIFICATION[classification].includes(roundState);
}

export function isExecutorRecoveryCodeCompatibleWithClassification(
  classification: ExecutorCompletionClassification,
  recoveryCode: string | null,
): boolean {
  const requiresRecovery =
    classification === "manual_recovery_required" ||
    classification === "blocked" ||
    classification === "failed";
  return requiresRecovery
    ? typeof recoveryCode === "string" && recoveryCode.trim().length > 0
    : recoveryCode === null;
}

const BLOCKED_HUMAN_GATES: ReadonlySet<ExecutorHumanGateType> = new Set([
  "credential_required",
  "external_state_required",
]);
const APPROVAL_HUMAN_GATES: ReadonlySet<ExecutorHumanGateType> = new Set([
  "approval_required",
  "policy_boundary_exceeded",
  "scope_boundary_exceeded",
  "destructive_action_requested",
]);
const OPERATOR_DECISION_HUMAN_GATES: ReadonlySet<ExecutorHumanGateType> =
  new Set([
    "operator_decision_required",
    "quota_exhausted",
    "policy_boundary_exceeded",
    "scope_boundary_exceeded",
    "credential_required",
    "external_state_required",
    "destructive_action_requested",
  ]);

export function isExecutorHumanGateCompatibleWithClassification(
  classification: ExecutorCompletionClassification,
  humanGate: ExecutorHumanGateType | null,
): boolean {
  switch (classification) {
    case "complete":
    case "continue":
    case "failed":
    case "cancelled":
      return humanGate === null;
    case "manual_recovery_required":
      return humanGate === "manual_recovery_required";
    case "blocked":
      return humanGate === null || BLOCKED_HUMAN_GATES.has(humanGate);
    case "approval_required":
      return humanGate !== null && APPROVAL_HUMAN_GATES.has(humanGate);
    case "operator_decision_required":
      return humanGate !== null && OPERATOR_DECISION_HUMAN_GATES.has(humanGate);
  }
}

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
  "destructive_action_requested",
] as const;
export type ExecutorHumanGateType = (typeof EXECUTOR_HUMAN_GATE_TYPES)[number];

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
  "recovery_note",
] as const;
export type ExecutorArtifactClass = (typeof EXECUTOR_ARTIFACT_CLASSES)[number];

const ATTEMPT_STATE_SET: ReadonlySet<ExecutorAttemptState> = new Set(
  EXECUTOR_ATTEMPT_STATES,
);
const ATTEMPT_TERMINAL_SET: ReadonlySet<ExecutorAttemptState> = new Set(
  EXECUTOR_ATTEMPT_TERMINAL_STATES,
);
const ROUND_STATE_SET: ReadonlySet<ExecutorRoundState> = new Set(
  EXECUTOR_ROUND_STATES,
);
const ROUND_TERMINAL_SET: ReadonlySet<ExecutorRoundState> = new Set(
  EXECUTOR_ROUND_TERMINAL_STATES,
);

// Failure-ish terminals reachable from any active (non-terminal) state. A round
// or attempt can abort to a recovery, blockage, failure, or cancellation at
// any stage; the daemon's recovery taxonomy decides which one applies.
const ATTEMPT_ABORTS: readonly ExecutorAttemptState[] = [
  "blocked",
  "failed",
  "manual_recovery_required",
  "cancelled",
];
const ROUND_ABORTS: readonly ExecutorRoundState[] = [
  "blocked",
  "failed",
  "manual_recovery_required",
  "cancelled",
];

const ATTEMPT_ALLOWED: Readonly<
  Record<ExecutorAttemptState, readonly ExecutorAttemptState[]>
> = {
  pending: ["preparing", ...ATTEMPT_ABORTS],
  preparing: ["running", "waiting_operator", ...ATTEMPT_ABORTS],
  running: ["pausing", "waiting_operator", "succeeded", ...ATTEMPT_ABORTS],
  pausing: ["waiting_operator", ...ATTEMPT_ABORTS],
  // Durable pause: resume into an active state, or settle to a failure-ish
  // terminal. Never straight to `succeeded` — a resumed attempt must run.
  waiting_operator: ["running", "preparing", ...ATTEMPT_ABORTS],
  manual_recovery_required: [],
  blocked: [],
  failed: [],
  succeeded: [],
  cancelled: [],
};

const ROUND_ALLOWED: Readonly<
  Record<ExecutorRoundState, readonly ExecutorRoundState[]>
> = {
  pending: [
    "running",
    "mirroring_external_state",
    "waiting_operator",
    ...ROUND_ABORTS,
  ],
  // No direct `succeeded`: result-bearing families must capture a result or
  // mirror external state first. The script family still passes through the
  // capture state, but as a bare exit-code/log capture with no result document.
  running: [
    "capturing_result",
    "mirroring_external_state",
    "waiting_operator",
    ...ROUND_ABORTS,
  ],
  mirroring_external_state: [
    "capturing_result",
    "finalizing",
    "succeeded",
    "waiting_operator",
    ...ROUND_ABORTS,
  ],
  capturing_result: [
    "finalizing",
    "succeeded",
    "waiting_operator",
    ...ROUND_ABORTS,
  ],
  finalizing: ["succeeded", "waiting_operator", ...ROUND_ABORTS],
  waiting_operator: [
    "running",
    "capturing_result",
    "finalizing",
    "mirroring_external_state",
    ...ROUND_ABORTS,
  ],
  manual_recovery_required: [],
  blocked: [],
  failed: [],
  succeeded: [],
  cancelled: [],
};

export type ExecutorAttemptTransitionErrorCode =
  | "executor_attempt_unknown_state"
  | "executor_attempt_terminal"
  | "executor_attempt_invalid_transition";

export type ExecutorRoundTransitionErrorCode =
  | "executor_round_unknown_state"
  | "executor_round_terminal"
  | "executor_round_invalid_transition";

export function isTerminalExecutorAttemptState(
  state: ExecutorAttemptState,
): boolean {
  return ATTEMPT_TERMINAL_SET.has(state);
}

export function isTerminalExecutorRoundState(
  state: ExecutorRoundState,
): boolean {
  return ROUND_TERMINAL_SET.has(state);
}

/**
 * Validate an executor attempt state transition. Refuses unknown states,
 * transitions out of a terminal state, and any transition not in the allowed
 * graph. A same-state transition is a no-op success.
 */
export function transitionExecutorAttempt(
  from: ExecutorAttemptState,
  to: ExecutorAttemptState,
): TransitionResult<ExecutorAttemptState, ExecutorAttemptTransitionErrorCode> {
  if (!ATTEMPT_STATE_SET.has(from) || !ATTEMPT_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "executor_attempt_unknown_state",
      errorMessage: `unknown executor attempt state: from=${String(from)} to=${String(to)}`,
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (ATTEMPT_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "executor_attempt_terminal",
      errorMessage: `executor attempt is in terminal state ${from}; cannot transition to ${to}`,
    };
  }
  if (!ATTEMPT_ALLOWED[from].includes(to)) {
    return {
      ok: false,
      errorCode: "executor_attempt_invalid_transition",
      errorMessage: `executor attempt cannot transition from ${from} to ${to}`,
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
  to: ExecutorRoundState,
): TransitionResult<ExecutorRoundState, ExecutorRoundTransitionErrorCode> {
  if (!ROUND_STATE_SET.has(from) || !ROUND_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "executor_round_unknown_state",
      errorMessage: `unknown executor round state: from=${String(from)} to=${String(to)}`,
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (ROUND_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "executor_round_terminal",
      errorMessage: `executor round is in terminal state ${from}; cannot transition to ${to}`,
    };
  }
  if (!ROUND_ALLOWED[from].includes(to)) {
    return {
      ok: false,
      errorCode: "executor_round_invalid_transition",
      errorMessage: `executor round cannot transition from ${from} to ${to}`,
    };
  }
  return { ok: true, state: to };
}

/**
 * The resolved executor configuration the contract calls `ExecutorDefinition`.
 * `StepDefinition.executor` names the permanent executor identity and its
 * optional `config` carries portable recipe intent; this record carries the
 * deterministic agent / model / effort / timeout / policy knobs resolved by the
 * contract's selection precedence ("Agent And Model Selection") and copied into
 * each round before it starts.
 */
export type ExecutorDefinitionRecord = {
  executorKey: string;
  family: ExecutorName;
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  timeoutMs: number | null;
  maxRounds: number | null;
  policyEnvelope: string | null;
};

/**
 * One executor go for one step run and one executor identity (contract "State
 * Model"). An attempt owns its rounds; its identity reattaches to the owning
 * `workflow_runs` / `workflow_steps` rows by `(workflowRunId, stepRunId)`.
 * Attempts are immutable retry boundaries: a retry inserts a fresh attempt with
 * the next `attemptNumber` and never reopens or rewrites an earlier attempt.
 */
export type ExecutorAttemptRecord = {
  attemptId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  executorFamily: ExecutorName;
  state: ExecutorAttemptState;
  attemptNumber: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
};

/**
 * One bounded loop iteration or long-lived external mirror lane under an
 * attempt (contract "Round Schema"). Each round belongs to exactly one attempt.
 * The common identity, execution, and result fields
 * below are what workflow status, handoff, monitor, logs, and recovery
 * surfaces rely on without understanding the executor internals.
 * Executor-specific evidence is layered on durably as
 * separate {@link ExecutorArtifactRecord} / {@link ExecutorCheckpointRecord} /
 * {@link ExecutorFindingRecord} / {@link ExecutorDecisionRecord} child records
 * that hang below a round.
 */
export type ExecutorRoundRecord = {
  // Identity and ordering.
  roundId: string;
  attemptId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  executorFamily: ExecutorName;
  attemptNumber: number;
  legacyAttemptNumber?: number;
  roundIndex: number;
  // Execution.
  state: ExecutorRoundState;
  classification: ExecutorCompletionClassification | null;
  executorRecommendation?: ExecutorCompletionClassification | null;
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
  keyLearnings: string[];
  remainingWork: string[];
  changedFiles: string[];
  verificationStatus: string | null;
  verificationResults?: ExecutorRoundVerificationResult[] | undefined;
  commitSha: string | null;
  recoveryCode: string | null;
  humanGate: ExecutorHumanGateType | null;
};

export function executorRoundReplayAttemptNumber(
  round: Pick<ExecutorRoundRecord, "attemptNumber" | "legacyAttemptNumber">,
): number {
  return round.legacyAttemptNumber ?? round.attemptNumber;
}

/**
 * One verification command result captured by a round.
 * The shape mirrors the native round evidence projection and intentionally omits
 * stdout/stderr, which live in the verification output artifact.
 */
export type ExecutorRoundVerificationResult = {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
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
 * outcome once the decision is settled; `externalRef` mirrors the external
 * decision id / reference when one exists.
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

/**
 * The next round index for a round list, computed as `max(roundIndex) + 1` -
 * never the list length, because migrated SDK-05 data may be 1-based. The
 * dispatch/SDK lane passes the step-spanning list so its indices stay monotone
 * across attempts; direct executor adapters pass per-attempt lists and number
 * each attempt's rounds from zero.
 */
export function nextExecutorRoundIndex(
  rounds: readonly { roundIndex: number }[],
): number {
  return (
    rounds.reduce((highest, round) => Math.max(highest, round.roundIndex), -1) +
    1
  );
}

/** True only when neither durable resolution field has settled the decision. */
export function isExecutorDecisionEligibleForHumanGate(decision: {
  chosenAction?: string | null;
  resolution?: string | null;
}): boolean {
  return (
    (decision.chosenAction === null || decision.chosenAction === undefined) &&
    (decision.resolution === null ||
      decision.resolution === undefined ||
      decision.resolution.trim().length === 0)
  );
}

export function selectExecutorDecisionForHumanGate<
  T extends {
    decisionId: string;
    chosenAction: string | null;
    resolution: string | null;
  },
>(decisions: readonly T[], decisionId: unknown): T | undefined {
  const unresolved = decisions.filter(isExecutorDecisionEligibleForHumanGate);
  if (typeof decisionId === "string") {
    return unresolved.find((candidate) => candidate.decisionId === decisionId);
  }
  return unresolved.at(-1);
}
