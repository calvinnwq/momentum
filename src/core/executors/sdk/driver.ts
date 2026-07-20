import type { MomentumDb } from "../../../adapters/db.js";
import crypto from "node:crypto";
import { loadExecutorAttempt } from "../loop/persist.js";
import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_ATTEMPT_STATES,
  EXECUTOR_ROUND_STATES,
  executorAttemptStateForClassification,
  isExecutorHumanGateCompatibleWithClassification,
  isExecutorRecoveryCodeCompatibleWithClassification,
  isExecutorRoundStateCompatibleWithClassification,
  isTerminalExecutorAttemptState,
  isTerminalExecutorRoundState,
  selectExecutorDecisionForHumanGate,
  type ExecutorAttemptRecord,
  type ExecutorRoundRecord,
} from "../loop/reducer.js";
import { createDurableExecutorEnvelope } from "./envelope.js";
import {
  EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE,
  type Executor,
  type ExecutorTickResult,
} from "./types.js";

export type DriveExecutorTicksInput = {
  db: MomentumDb;
  attemptId: string;
  executor: Executor;
  config: Readonly<Record<string, unknown>>;
  hostBindings: Readonly<unknown>;
  signal?: AbortSignal;
  /** Maximum bounded turns in this daemon pass. Defaults to one. */
  maxTicks?: number;
  now?: () => number;
  authorizeWrite?: () => void;
};

export type DriveExecutorTicksResult = {
  attempt: ExecutorAttemptRecord;
  ticks: readonly ExecutorTickResult[];
  lastRound: ExecutorRoundRecord | null;
};

/**
 * Drive every registered executor through the same bounded daemon-owned loop.
 * The executor records observations and recommends; this controller alone
 * applies terminal classification and attempt state.
 */
export async function driveExecutorTicks(
  input: DriveExecutorTicksInput,
): Promise<DriveExecutorTicksResult> {
  const maxTicks = input.maxTicks ?? 1;
  if (!Number.isInteger(maxTicks) || maxTicks < 1) {
    throw new Error("driveExecutorTicks: maxTicks must be a positive integer");
  }
  const initial = loadExecutorAttempt(input.db, input.attemptId);
  if (initial === undefined) {
    throw new Error(`Executor attempt not found: ${input.attemptId}`);
  }
  if (initial.executorFamily !== input.executor.name) {
    throw new Error(
      `Registered executor ${input.executor.name} cannot drive attempt for ${initial.executorFamily}.`,
    );
  }
  const envelope = createDurableExecutorEnvelope({
    db: input.db,
    attemptId: input.attemptId,
    now: input.now ?? Date.now,
    ...(input.authorizeWrite !== undefined
      ? { authorizeWrite: input.authorizeWrite }
      : {}),
  });
  const signal = input.signal ?? new AbortController().signal;
  const ticks: ExecutorTickResult[] = [];
  let lastRound: ExecutorRoundRecord | null = null;

  for (let index = 0; index < maxTicks; index += 1) {
    const state = envelope.snapshot();
    if (isTerminalExecutorAttemptState(state.attempt.state)) break;
    signal.throwIfAborted();
    let tick: ExecutorTickResult;
    try {
      const returned = await input.executor.tick({
        state,
        config: input.config,
        hostBindings: input.hostBindings,
        envelope: envelope.facade,
        signal,
      });
      tick = validateExecutorTickResult(returned, envelope.snapshot());
      persistHumanGateDecisionSelector(envelope, tick);
      const applied = envelope.applyDaemonDecision(
        {
          roundId: tick.roundId,
          classification: tick.recommendation,
          executorRecommendation: tick.recommendation,
          roundState: tick.recommendedRoundState,
          attemptState: tick.recommendedAttemptState,
          recoveryCode: tick.recoveryCode,
          humanGate: tick.humanGate,
        },
        {
          allocateClassificationCheckpointIdentity: true,
          classificationCheckpoint: {
            stage: "classified",
            detail: `classification: ${tick.recommendation}; reason: ${tick.reason}`,
          },
        },
      );
      ticks.push(tick);
      lastRound = applied.round;
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      const failure = describeExecutorFailure(error);
      const afterThrow = envelope.snapshot();
      const current = afterThrow.currentRound?.round;
      const round =
        current !== undefined &&
        current.attemptNumber === afterThrow.attempt.attemptNumber &&
        !isTerminalExecutorRoundState(current.state)
          ? current
          : envelope.facade.startRound({
              roundId: `${initial.attemptId}::daemon-recovery-${crypto.randomUUID()}`,
              attemptId: afterThrow.attempt.attemptId,
              workflowRunId: afterThrow.attempt.workflowRunId,
              stepRunId: afterThrow.attempt.stepRunId,
              stepKey: afterThrow.attempt.stepKey,
              executorFamily: afterThrow.attempt.executorFamily,
              attemptNumber: afterThrow.attempt.attemptNumber,
              roundIndex: afterThrow.rounds.length,
              state: "running",
              agentProvider: null,
              model: null,
              effort: null,
              inputDigest: null,
              resultDigest: null,
              artifactRoot: null,
              logPaths: [],
              summary: failure.message,
              keyChanges: [],
              keyLearnings: [],
              remainingWork: [],
              changedFiles: [],
              verificationStatus: null,
              commitSha: null,
            });
      const applied = envelope.applyDaemonDecision(
        {
          roundId: round.roundId,
          classification: "manual_recovery_required",
          executorRecommendation: null,
          roundState: "manual_recovery_required",
          attemptState: "manual_recovery_required",
          recoveryCode: failure.contractInvalid
            ? "executor_contract_invalid"
            : "executor_threw",
          humanGate: "manual_recovery_required",
        },
        {
          allocateClassificationCheckpointIdentity: true,
          classificationCheckpoint: {
            stage: "classified",
            detail: `classification: manual_recovery_required; ${failure.message}`,
          },
        },
      );
      lastRound = applied.round;
      break;
    }
    if (tick.recommendation !== "continue") break;
  }

  const attempt = loadExecutorAttempt(input.db, input.attemptId);
  if (attempt === undefined) {
    throw new Error(`Executor attempt disappeared: ${input.attemptId}`);
  }
  return { attempt, ticks, lastRound };
}

function persistHumanGateDecisionSelector(
  envelope: ReturnType<typeof createDurableExecutorEnvelope>,
  tick: ExecutorTickResult,
): void {
  if (
    tick.recommendation !== "approval_required" &&
    tick.recommendation !== "operator_decision_required"
  ) {
    return;
  }
  const state = envelope.snapshot();
  const current = state.currentRound;
  if (current === null || current.round.roundId !== tick.roundId) return;
  const decisionId =
    typeof tick.humanGateDecisionId === "string"
      ? tick.humanGateDecisionId
      : null;
  const detail = JSON.stringify({ decisionId });
  const sequence =
    Math.max(
      -1,
      ...current.checkpoints.map((checkpoint) => checkpoint.sequence),
    ) + 1;
  envelope.facade.recordCheckpoint(tick.roundId, {
    checkpointId: `${tick.roundId}::${EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE}::${sequence}`,
    sequence,
    stage: EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE,
    detail,
  });
}

class ExecutorTickContractError extends Error {}

function validateExecutorTickResult(
  value: unknown,
  state: ReturnType<
    ReturnType<typeof createDurableExecutorEnvelope>["snapshot"]
  >,
): ExecutorTickResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutorTickContractError(
      "Executor tick must return a result object.",
    );
  }
  const record = value as Record<string, unknown>;
  const roundId = record["roundId"];
  const selectedRound =
    typeof roundId === "string"
      ? state.rounds.find((item) => item.round.roundId === roundId)?.round
      : undefined;
  if (
    typeof roundId !== "string" ||
    roundId.length === 0 ||
    selectedRound === undefined ||
    selectedRound.attemptNumber !== state.attempt.attemptNumber ||
    state.currentRound?.round.roundId !== roundId ||
    isTerminalExecutorRoundState(selectedRound.state)
  ) {
    throw new ExecutorTickContractError(
      "Executor tick roundId must name the current non-terminal round for the attempt attempt.",
    );
  }
  if (
    !includes(EXECUTOR_COMPLETION_CLASSIFICATIONS, record["recommendation"])
  ) {
    throw new ExecutorTickContractError(
      "Executor tick recommendation is invalid.",
    );
  }
  if (!includes(EXECUTOR_ROUND_STATES, record["recommendedRoundState"])) {
    throw new ExecutorTickContractError(
      "Executor tick recommendedRoundState is invalid.",
    );
  }
  if (!includes(EXECUTOR_ATTEMPT_STATES, record["recommendedAttemptState"])) {
    throw new ExecutorTickContractError(
      "Executor tick recommendedAttemptState is invalid.",
    );
  }
  const recoveryCode = record["recoveryCode"];
  if (recoveryCode !== null && typeof recoveryCode !== "string") {
    throw new ExecutorTickContractError(
      "Executor tick recoveryCode must be a string or null.",
    );
  }
  const humanGate = record["humanGate"];
  if (humanGate !== null && !includes(EXECUTOR_HUMAN_GATE_TYPES, humanGate)) {
    throw new ExecutorTickContractError("Executor tick humanGate is invalid.");
  }
  const humanGateDecisionId = record["humanGateDecisionId"];
  if (
    humanGateDecisionId !== undefined &&
    humanGateDecisionId !== null &&
    (typeof humanGateDecisionId !== "string" ||
      humanGateDecisionId.length === 0)
  ) {
    throw new ExecutorTickContractError(
      "Executor tick humanGateDecisionId must be a non-empty string, null, or omitted.",
    );
  }
  if (typeof record["reason"] !== "string") {
    throw new ExecutorTickContractError(
      "Executor tick reason must be a string.",
    );
  }
  const recommendation = record["recommendation"];
  const recommendedRoundState = record["recommendedRoundState"];
  const recommendedAttemptState = record["recommendedAttemptState"];
  if (
    recommendedAttemptState !==
      executorAttemptStateForClassification(recommendation) ||
    !isExecutorRoundStateCompatibleWithClassification(
      recommendation,
      recommendedRoundState,
    ) ||
    !isExecutorRecoveryCodeCompatibleWithClassification(
      recommendation,
      recoveryCode,
    ) ||
    !isExecutorHumanGateCompatibleWithClassification(recommendation, humanGate)
  ) {
    throw new ExecutorTickContractError(
      "Executor tick recommendation, states, recovery code, and human gate are inconsistent.",
    );
  }
  if (
    (recommendation === "approval_required" ||
      recommendation === "operator_decision_required") &&
    !hasResolvableCurrentExecutorDecision(state, humanGateDecisionId)
  ) {
    throw new ExecutorTickContractError(
      "Executor gate recommendations require an unresolved durable decision with canonical allowed actions and a valid recommendation.",
    );
  }
  return value as ExecutorTickResult;
}

function hasResolvableCurrentExecutorDecision(
  state: ReturnType<
    ReturnType<typeof createDurableExecutorEnvelope>["snapshot"]
  >,
  decisionId: unknown,
): boolean {
  const decision = selectExecutorDecisionForHumanGate(
    state.currentRound?.decisions ?? [],
    decisionId,
  );
  if (decision === undefined || decision.allowedActions.length === 0) {
    return false;
  }
  const canonicalActions = decision.allowedActions.every(
    (action) => action.length > 0 && action.trim() === action,
  );
  if (
    !canonicalActions ||
    new Set(decision.allowedActions).size !== decision.allowedActions.length
  ) {
    return false;
  }
  return (
    decision.recommendedAction === null ||
    decision.allowedActions.includes(decision.recommendedAction)
  );
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function describeExecutorFailure(error: unknown): {
  contractInvalid: boolean;
  message: string;
} {
  let contractInvalid = false;
  try {
    contractInvalid = error instanceof ExecutorTickContractError;
  } catch {
    // Hostile proxies may throw while JavaScript walks their prototype chain.
  }
  let detail: string;
  try {
    detail =
      error instanceof Error && typeof error.message === "string"
        ? error.message
        : String(error);
  } catch {
    detail = "uninspectable thrown value";
  }
  return {
    contractInvalid,
    message: `${contractInvalid ? "Executor contract invalid" : "Executor threw"}: ${detail}`,
  };
}
