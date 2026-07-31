import crypto from "node:crypto";

import { MAX_BUILT_IN_PROCESS_TIMEOUT_MS } from "../../../shared/process-limits.js";
import {
  executorRoundReplayAttemptNumber,
  nextExecutorRoundIndex,
  type ExecutorRoundRecord,
} from "../loop/reducer.js";
import type { ExecutorRoundUpdate } from "../loop/persist.js";
import type {
  Executor,
  ExecutorConfigSchema,
  ExecutorObservationPhase,
  ExecutorRoundObservation,
  ExecutorRoundStart,
  ExecutorRoundView,
  ExecutorTickContext,
  ExecutorTickResult,
} from "../sdk/types.js";
import {
  goalLoopRoundId,
  attemptStateForRoundClassification,
  planGoalLoopRoundArtifacts,
  planGoalLoopRoundPersistence,
  planGoalLoopRoundStart,
  resolveGoalLoopRoundSelection,
  type GoalLoopRoundDecision,
  type GoalLoopRoundSelection,
  type PlanGoalLoopRoundStartInput,
} from "./executor.js";
import type {
  GoalLoopRoundMechanismResult,
  GoalLoopRoundRunner,
} from "./orchestrator.js";

export type GoalLoopExecutorConfig = {
  agent?: {
    harness?: string;
    model?: string;
    effort?: string;
  };
  timeoutMs?: number;
  maxRounds?: number;
  policyEnvelope?: string;
};

export type GoalLoopExecutorHostBindings = {
  start: Omit<PlanGoalLoopRoundStartInput, "selection">;
  /** Host-resolved identity actually used for execution and durable reattachment. */
  selection?: GoalLoopRoundSelection;
  /** Opaque digest of the resolved host runner, argv, cwd, and environment. */
  hostBindingIdentity?: string;
  /** True only when the host atomically inserted this fresh bound round. */
  roundAlreadyMaterialized?: boolean;
  runRound?: GoalLoopRoundRunner;
  settleRepoOwnership?: (completionDurable: boolean) => void;
};

export const AGENT_LOOP_MECHANISM_SCHEMA =
  "momentum.agent-loop.sdk-mechanism.v1";
export const LEGACY_GOAL_LOOP_MECHANISM_SCHEMA =
  "momentum.goal-loop.sdk-mechanism.v1";

const AGENT_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    harness: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    effort: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export const GOAL_LOOP_EXECUTOR_CONFIG_SCHEMA = {
  type: "object",
  description: "Portable configuration for bounded native agent-loop rounds.",
  properties: {
    agent: AGENT_CONFIG_SCHEMA,
    timeoutMs: {
      type: "integer",
      minimum: 1_000,
      maximum: MAX_BUILT_IN_PROCESS_TIMEOUT_MS,
      multipleOf: 1_000,
    },
    maxRounds: { type: "integer", minimum: 1 },
    policyEnvelope: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

export class GoalLoopSdkExecutor implements Executor<
  GoalLoopExecutorConfig,
  GoalLoopExecutorHostBindings
> {
  readonly name = "agent-loop";
  readonly configSchema = GOAL_LOOP_EXECUTOR_CONFIG_SCHEMA;

  tick(
    context: ExecutorTickContext<
      GoalLoopExecutorConfig,
      GoalLoopExecutorHostBindings
    >,
  ): ExecutorTickResult {
    if (context.state.attempt.executor !== this.name) {
      throw new Error(
        `GoalLoopSdkExecutor cannot run attempt ${context.state.attempt.attemptId} for ${context.state.attempt.executor}.`,
      );
    }
    const selection =
      context.hostBindings.selection ?? selectionFromConfig(context.config);
    const current = context.state.currentRound;
    const reusingMaterializedRound =
      current !== null &&
      current.round.attemptNumber === context.state.attempt.attemptNumber &&
      current.round.classification === null &&
      context.hostBindings.roundAlreadyMaterialized === true &&
      !current.checkpoints.some(
        (checkpoint) => checkpoint.stage === "mechanism_completed",
      );
    if (
      current !== null &&
      current.round.attemptNumber === context.state.attempt.attemptNumber &&
      current.round.classification === null &&
      !reusingMaterializedRound
    ) {
      try {
        assertGoalLoopRoundMatchesHost(
          current.round,
          current.checkpoints,
          context.hostBindings,
          selection,
        );
        const resumed = resumeCompletedRound(
          current.round,
          current.checkpoints,
        );
        context.hostBindings.settleRepoOwnership?.(true);
        return resumed;
      } catch (error) {
        context.hostBindings.settleRepoOwnership?.(false);
        throw error;
      }
    }

    const expectedRoundIndex = reusingMaterializedRound
      ? current.round.roundIndex
      : nextExecutorRoundIndex(
          context.state.rounds.map((snapshot) => snapshot.round),
        );
    const expectedRoundId = reusingMaterializedRound
      ? current.round.roundId
      : goalLoopRoundId(context.state.attempt.attemptId, expectedRoundIndex);
    const hostStart = context.hostBindings.start;
    if (
      hostStart.attemptId !== context.state.attempt.attemptId ||
      hostStart.attemptNumber !== context.state.attempt.attemptNumber ||
      hostStart.roundIndex !== expectedRoundIndex ||
      hostStart.roundId !== expectedRoundId
    ) {
      throw new Error(
        "Native agent-loop host round binding is stale or invalid.",
      );
    }
    const start = planGoalLoopRoundStart({ ...hostStart, selection });
    let durableRound: ExecutorRoundView;
    if (reusingMaterializedRound) {
      assertGoalLoopRoundMatchesHost(
        current.round,
        current.checkpoints,
        context.hostBindings,
        selection,
      );
      durableRound = current.round;
    } else {
      durableRound = context.envelope.startRound(roundStartForSdk(start), [
        {
          checkpointId: `${start.roundId}-checkpoint-0`,
          sequence: 0,
          stage: "round_started",
          detail: goalLoopDispatchBindingDetail(
            context.hostBindings,
            selection,
          ),
        },
      ]);
    }

    const roundId = durableRound.roundId;
    let completionDurable = false;
    try {
      context.signal.throwIfAborted();
      const runner = context.hostBindings.runRound;
      if (runner === undefined) {
        throw new Error("Native agent-loop runner binding is unavailable.");
      }
      const mechanism = runner(cloneRound(durableRound));
      const plan = planGoalLoopRoundPersistence({
        result: mechanism.result,
        finalize: mechanism.finalize,
        roundIndex: start.roundIndex,
        maxRounds: selection.maxRounds,
        ...(mechanism.resultDigest !== undefined
          ? { resultDigest: mechanism.resultDigest }
          : {}),
        ...(mechanism.changedFiles !== undefined
          ? { changedFiles: mechanism.changedFiles }
          : {}),
      });
      const artifacts = planGoalLoopRoundArtifacts({
        roundId,
        logPaths: durableRound.logPaths,
        ...(mechanism.artifacts !== undefined
          ? { artifacts: mechanism.artifacts }
          : {}),
      });
      for (const artifact of artifacts) {
        context.envelope.recordArtifact(roundId, withoutRoundId(artifact));
      }
      const checkpoints = [
        {
          checkpointId: `${roundId}-checkpoint-1`,
          sequence: 1,
          stage: "mechanism_completed",
          detail: durableDecisionDetail(plan.decision, mechanism),
        },
        ...(plan.captureUpdate === null
          ? []
          : [
              {
                checkpointId: `${roundId}-checkpoint-2`,
                sequence: 2,
                stage: "result_captured",
                detail: null,
              },
            ]),
      ];
      context.envelope.recordRoundProgress(roundId, {
        observation: observationFromPersistencePlan(
          plan.captureUpdate,
          plan.terminalUpdate,
        ),
        checkpoints,
      });
      completionDurable = true;
      return tickResult(roundId, plan.decision);
    } finally {
      context.hostBindings.settleRepoOwnership?.(completionDurable);
    }
  }
}

function assertGoalLoopRoundMatchesHost(
  round: ExecutorRoundView,
  checkpoints: readonly Readonly<{ stage: string; detail: string | null }>[],
  hostBindings: Readonly<GoalLoopExecutorHostBindings>,
  selection: GoalLoopRoundSelection,
): void {
  const mismatches: string[] = [];
  const expected = {
    agentProvider: selection.agentProvider,
    model: selection.model,
    effort: selection.effort,
  } as const;
  for (const [field, value] of Object.entries(expected)) {
    if (round[field as keyof ExecutorRoundView] !== value) {
      mismatches.push(field);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Goal-loop round ${round.roundId} cannot reattach with changed dispatch inputs: ${mismatches.join(", ")}.`,
    );
  }
  const binding = checkpoints.find(
    (checkpoint) => checkpoint.stage === "round_started",
  );
  const expectedBinding = goalLoopDispatchBindingDetail(
    hostBindings,
    selection,
  );
  const replayBinding = goalLoopDispatchBindingDetailForAttempt(
    hostBindings,
    selection,
    executorRoundReplayAttemptNumber(round),
  );
  if (
    binding?.detail !== expectedBinding &&
    binding?.detail !== replayBinding
  ) {
    // Rounds written before the versioned binding shipped carried a null
    // checkpoint detail. That legacy evidence is sufficient only to classify
    // an already-completed mechanism. Relaunching incomplete work requires the
    // full host and portable dispatch envelope because the original authority
    // cannot otherwise be proven.
    const mechanismCompleted = checkpoints.some(
      (checkpoint) => checkpoint.stage === "mechanism_completed",
    );
    if (binding?.detail !== null || !mechanismCompleted) {
      throw new Error(
        `Goal-loop round ${round.roundId} cannot reattach with changed portable config or host inputs.`,
      );
    }
  }
}

export function goalLoopDispatchBindingDetail(
  hostBindings: Readonly<GoalLoopExecutorHostBindings>,
  selection: Readonly<GoalLoopRoundSelection>,
): string {
  return goalLoopDispatchBindingDetailForAttempt(
    hostBindings,
    selection,
    hostBindings.start.attemptNumber,
  );
}

function goalLoopDispatchBindingDetailForAttempt(
  hostBindings: Readonly<GoalLoopExecutorHostBindings>,
  selection: Readonly<GoalLoopRoundSelection>,
  attemptNumber: number,
): string {
  const start = hostBindings.start;
  const payload = canonicalJson({
    version: 2,
    selection,
    hostBindingIdentity: hostBindings.hostBindingIdentity ?? null,
    start: {
      // Frozen digest schema: the payload keys keep their pre-attempt-model
      // wire names so binding digests recorded before the migration keep
      // verifying. The keys never leave this hash.
      roundId: start.roundId,
      invocationId: start.attemptId,
      workflowRunId: start.workflowRunId,
      stepRunId: start.stepRunId,
      stepKey: start.stepKey,
      attempt: attemptNumber,
      roundIndex: start.roundIndex,
      inputDigest: start.inputDigest,
      artifactRoot: start.artifactRoot,
      logPaths: start.logPaths ?? [],
    },
  });
  return `dispatch binding v2: sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function selectionFromConfig(
  config: Readonly<GoalLoopExecutorConfig>,
): GoalLoopRoundSelection {
  return resolveGoalLoopRoundSelection({
    stepConfig: {
      ...(config.agent?.harness !== undefined
        ? { agentProvider: config.agent.harness }
        : {}),
      ...(config.agent?.model !== undefined
        ? { model: config.agent.model }
        : {}),
      ...(config.agent?.effort !== undefined
        ? { effort: config.agent.effort }
        : {}),
      ...(config.timeoutMs !== undefined
        ? { timeoutMs: config.timeoutMs }
        : {}),
      ...(config.maxRounds !== undefined
        ? { maxRounds: config.maxRounds }
        : {}),
      ...(config.policyEnvelope !== undefined
        ? { policyEnvelope: config.policyEnvelope }
        : {}),
    },
  });
}

function roundStartForSdk(round: ExecutorRoundRecord): ExecutorRoundStart {
  return {
    roundId: round.roundId,
    attemptId: round.attemptId,
    workflowRunId: round.workflowRunId,
    stepRunId: round.stepRunId,
    stepKey: round.stepKey,
    executor: round.executor,
    attemptNumber: round.attemptNumber,
    roundIndex: round.roundIndex,
    state: "running",
    agentProvider: round.agentProvider,
    model: round.model,
    effort: round.effort,
    inputDigest: round.inputDigest,
    resultDigest: round.resultDigest,
    artifactRoot: round.artifactRoot,
    logPaths: round.logPaths,
    summary: round.summary,
    keyChanges: round.keyChanges,
    keyLearnings: round.keyLearnings,
    remainingWork: round.remainingWork,
    changedFiles: round.changedFiles,
    verificationStatus: round.verificationStatus,
    commitSha: round.commitSha,
  };
}

function cloneRound(round: ExecutorRoundView): ExecutorRoundRecord {
  const { verificationResults, ...rest } = round;
  return {
    ...rest,
    logPaths: [...round.logPaths],
    keyChanges: [...round.keyChanges],
    keyLearnings: [...round.keyLearnings],
    remainingWork: [...round.remainingWork],
    changedFiles: [...round.changedFiles],
    ...(verificationResults !== undefined
      ? {
          verificationResults: verificationResults.map((item) => ({ ...item })),
        }
      : {}),
  };
}

function durableDecisionDetail(
  decision: GoalLoopRoundDecision,
  mechanism: GoalLoopRoundMechanismResult,
): string {
  return JSON.stringify({
    schema: AGENT_LOOP_MECHANISM_SCHEMA,
    finalizeOutcome: mechanism.finalize.outcome,
    decision,
  });
}

function resumeCompletedRound(
  round: ExecutorRoundView,
  checkpoints: readonly Readonly<{ stage: string; detail: string | null }>[],
): ExecutorTickResult {
  const checkpoint = [...checkpoints]
    .reverse()
    .find((item) => item.stage === "mechanism_completed");
  if (checkpoint?.detail === null || checkpoint === undefined) {
    throw new Error(
      `Goal-loop round ${round.roundId} has no durable mechanism_completed outcome to classify.`,
    );
  }
  const parsed = JSON.parse(checkpoint.detail) as {
    schema?: unknown;
    decision?: unknown;
  };
  if (
    (parsed.schema !== AGENT_LOOP_MECHANISM_SCHEMA &&
      parsed.schema !== LEGACY_GOAL_LOOP_MECHANISM_SCHEMA) ||
    parsed.decision === null ||
    typeof parsed.decision !== "object"
  ) {
    throw new Error(
      `Goal-loop round ${round.roundId} has invalid durable mechanism evidence.`,
    );
  }
  return tickResult(round.roundId, parsed.decision as GoalLoopRoundDecision);
}

function tickResult(
  roundId: string,
  decision: GoalLoopRoundDecision,
): ExecutorTickResult {
  return {
    roundId,
    recommendation: decision.classification,
    recommendedRoundState: decision.roundState,
    recommendedAttemptState: attemptStateForRoundClassification(
      decision.classification,
    ),
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    reason: decision.reason,
  };
}

function observationFromPersistencePlan(
  capture: ExecutorRoundUpdate | null,
  terminal: ExecutorRoundUpdate,
): ExecutorRoundObservation {
  const phase =
    capture === null ? undefined : observationPhase(capture.toState);
  return {
    ...(capture !== null ? observationFields(capture) : {}),
    ...observationFields(terminal),
    ...(phase !== undefined ? { phase } : {}),
  };
}

function observationPhase(
  state: ExecutorRoundUpdate["toState"],
): ExecutorObservationPhase {
  if (state !== "capturing_result") {
    throw new Error(
      `Goal-loop capture requested invalid observation phase ${state}.`,
    );
  }
  return state;
}

function observationFields(
  update: ExecutorRoundUpdate,
): ExecutorRoundObservation {
  return {
    ...(update.resultDigest !== undefined
      ? { resultDigest: update.resultDigest }
      : {}),
    ...(update.summary !== undefined ? { summary: update.summary } : {}),
    ...(update.keyChanges !== undefined
      ? { keyChanges: [...update.keyChanges] }
      : {}),
    ...(update.keyLearnings !== undefined
      ? { keyLearnings: [...update.keyLearnings] }
      : {}),
    ...(update.remainingWork !== undefined
      ? { remainingWork: [...update.remainingWork] }
      : {}),
    ...(update.changedFiles !== undefined
      ? { changedFiles: [...update.changedFiles] }
      : {}),
    ...(update.verificationStatus !== undefined
      ? { verificationStatus: update.verificationStatus }
      : {}),
    ...(update.verificationResults !== undefined
      ? {
          verificationResults: update.verificationResults.map((item) => ({
            ...item,
          })),
        }
      : {}),
    ...(update.commitSha !== undefined ? { commitSha: update.commitSha } : {}),
  };
}

function withoutRoundId<T extends { roundId: string }>(
  value: T,
): Omit<T, "roundId"> {
  const { roundId: _roundId, ...rest } = value;
  return rest;
}
