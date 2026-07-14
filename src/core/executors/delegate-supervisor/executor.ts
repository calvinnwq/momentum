import crypto from "node:crypto";

import type {
  Executor,
  ExecutorConfigSchema,
  ExecutorRoundEnvelopeSnapshot,
  ExecutorTickContext,
  ExecutorTickResult,
} from "../sdk/types.js";
import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_INVOCATION_STATES,
  EXECUTOR_ROUND_STATES,
  executorInvocationStateForClassification,
  isExecutorHumanGateCompatibleWithClassification,
  isExecutorRecoveryCodeCompatibleWithClassification,
  isExecutorRoundStateCompatibleWithClassification,
  isTerminalExecutorRoundState,
} from "../loop/reducer.js";
import {
  classifyDelegateSupervisorInconsistent,
  classifyDelegateSupervisorState,
  classifyDelegateSupervisorUnreadable,
  delegateSupervisorProgressDigest,
} from "./classifier.js";
import {
  DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
  type DelegateSupervisorDecision,
  type DelegateSupervisorExternalIdentity,
  type DelegateSupervisorExternalState,
  type DelegateSupervisorExternalStateRead,
  type DelegateSupervisorHandoff,
  type DelegateSupervisorHostBindings,
  type DelegateSupervisorToolAdapter,
} from "./types.js";

export const DELEGATE_SUPERVISOR_EXECUTOR_NAME = "delegate-supervisor";
/** Maximum unchanged semantic-progress window before manual recovery. */
export const DELEGATE_SUPERVISOR_STALL_AFTER_MS = 4 * 60 * 1000;

export const DELEGATE_SUPERVISOR_HANDOFF_STAGE = "delegate_handoff_completed";
const HANDOFF_INTENT_STAGE = "delegate_handoff_intent";
const LEGACY_COMPLETION_REPLAYED_STAGE = "delegate_legacy_completion_replayed";
const MIRRORED_STAGE = "delegate_external_state_mirrored";

export type DelegateSupervisorConfig = {
  tool: string;
};

/** Strict portable config shared by preflight and daemon registration. */
export const DELEGATE_SUPERVISOR_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", minLength: 1 },
  },
  required: ["tool"],
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

type MirroredCheckpoint = {
  state: DelegateSupervisorExternalState;
  progressDigest: string;
  progressAt: number;
  observedAt: number;
};

type LegacyLiveStepDecision = Pick<
  ExecutorTickResult,
  | "recommendation"
  | "recommendedRoundState"
  | "recommendedInvocationState"
  | "recoveryCode"
  | "humanGate"
  | "reason"
>;

type DurableCheckpointRead<T> =
  | { status: "absent" }
  | {
      status: "valid";
      roundId: string;
      position: DurableCheckpointPosition;
      value: T;
    }
  | {
      status: "invalid";
      roundId: string;
      position: DurableCheckpointPosition;
      reason: string;
    };

type DurableCheckpointPosition = {
  roundIndex: number;
  sequence: number;
};

/** SDK-native executor that composes one bounded handoff with repeated polls. */
export class DelegateSupervisorExecutor implements Executor<
  DelegateSupervisorConfig,
  DelegateSupervisorHostBindings
> {
  readonly name = DELEGATE_SUPERVISOR_EXECUTOR_NAME;
  readonly configSchema = DELEGATE_SUPERVISOR_CONFIG_SCHEMA;

  async tick(
    context: ExecutorTickContext<
      DelegateSupervisorConfig,
      DelegateSupervisorHostBindings
    >,
  ): Promise<ExecutorTickResult> {
    const adapter = resolveToolAdapter(
      context.hostBindings.tools,
      context.config.tool,
    );
    const attemptRounds = context.state.rounds.filter(
      ({ round }) => round.attempt === context.state.invocation.attempt,
    );
    const priorRounds = context.state.rounds.filter(
      ({ round }) => round.attempt < context.state.invocation.attempt,
    );
    const legacyCompletion = findLegacyLiveStepCompletion(context.state.rounds);
    const latestDelegateEvidence = latestCheckpointPosition(
      context.state.rounds,
      new Set([
        HANDOFF_INTENT_STAGE,
        DELEGATE_SUPERVISOR_HANDOFF_STAGE,
        LEGACY_COMPLETION_REPLAYED_STAGE,
      ]),
    );
    if (
      legacyCompletion.status !== "absent" &&
      (latestDelegateEvidence === null ||
        !isCheckpointAfter(latestDelegateEvidence, legacyCompletion.position))
    ) {
      if (legacyCompletion.status === "invalid") {
        return invalidCompletionEvidenceResult(context, legacyCompletion);
      }
      const fromPriorAttempt = !attemptRounds.some(
        ({ round }) => round.roundId === legacyCompletion.roundId,
      );
      return replayLegacyCompletion(
        context,
        legacyCompletion,
        fromPriorAttempt,
      );
    }
    const priorHandoff = findHandoff(priorRounds);
    const latestPriorHandoffRoundIndex = [...priorRounds]
      .reverse()
      .find(({ checkpoints }) =>
        checkpoints.some(
          (checkpoint) =>
            checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_STAGE,
        ),
      )?.round.roundIndex;
    const unresolvedPriorIntent = [...priorRounds]
      .reverse()
      .find(
        ({ round, checkpoints }) =>
          round.roundIndex > (latestPriorHandoffRoundIndex ?? -1) &&
          checkpoints.some(
            (checkpoint) => checkpoint.stage === HANDOFF_INTENT_STAGE,
          ) &&
          !checkpoints.some(
            (checkpoint) =>
              checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_STAGE,
          ),
      );
    if (attemptRounds.length === 0 && unresolvedPriorIntent !== undefined) {
      return this.handoff(
        context,
        adapter,
        unresolvedPriorIntent.round.attempt,
      );
    }
    if (attemptRounds.length === 0 && priorHandoff.status === "invalid") {
      return invalidCompletionEvidenceResult(context, priorHandoff);
    }
    if (attemptRounds.length === 0 && priorHandoff.status === "valid") {
      return this.supervise(
        context,
        adapter,
        priorHandoff.value,
        context.state.rounds,
        attemptRounds,
        true,
      );
    }
    const handoffRecord = findHandoff(attemptRounds);
    if (handoffRecord.status === "invalid") {
      return invalidCompletionEvidenceResult(context, handoffRecord);
    }
    if (handoffRecord.status === "absent") {
      return this.handoff(context, adapter);
    }
    if (
      context.state.currentRound?.round.roundId === handoffRecord.roundId &&
      !isTerminalExecutorRoundState(context.state.currentRound.round.state)
    ) {
      context.hostBindings.settleHandoff?.(true);
      return {
        roundId: handoffRecord.roundId,
        recommendation: "continue",
        recommendedRoundState: "succeeded",
        recommendedInvocationState: "running",
        recoveryCode: null,
        humanGate: null,
        reason: handoffRecord.value.summary,
      };
    }
    return this.supervise(
      context,
      adapter,
      handoffRecord.value,
      context.state.rounds,
      attemptRounds,
    );
  }

  private async handoff(
    context: ExecutorTickContext<
      DelegateSupervisorConfig,
      DelegateSupervisorHostBindings
    >,
    adapter: DelegateSupervisorToolAdapter | undefined,
    recoveringAttempt?: number,
  ): Promise<ExecutorTickResult> {
    const active = context.state.currentRound;
    const roundId =
      active !== null &&
      active.round.attempt === context.state.invocation.attempt &&
      !isTerminalExecutorRoundState(active.round.state)
        ? active.round.roundId
        : startRound(context, "running", "Handing work to delegated tool.");
    const roundBeforeHandoff = context.envelope
      .snapshot()
      .rounds.find(({ round }) => round.roundId === roundId);
    const hasCurrentHandoffIntent =
      roundBeforeHandoff?.checkpoints.some(
        (checkpoint) => checkpoint.stage === HANDOFF_INTENT_STAGE,
      ) ?? false;
    const recoveringInterruptedHandoff =
      recoveringAttempt !== undefined || hasCurrentHandoffIntent;
    if (adapter === undefined) {
      context.hostBindings.settleHandoff?.(false);
      return recoveryResult(
        roundId,
        "tool_adapter_unavailable",
        `No delegate-supervisor tool adapter is registered for ${JSON.stringify(context.config.tool)}.`,
      );
    }
    if (!hasCurrentHandoffIntent) {
      const sequence = roundBeforeHandoff?.checkpoints.length ?? 0;
      context.envelope.recordCheckpoint(roundId, {
        checkpointId: `${roundId}-${HANDOFF_INTENT_STAGE}`,
        sequence,
        stage: HANDOFF_INTENT_STAGE,
        detail: JSON.stringify({
          tool: context.config.tool,
          invocationId: context.state.invocation.invocationId,
          attempt: context.state.invocation.attempt,
          ...(recoveringAttempt !== undefined ? { recoveringAttempt } : {}),
        }),
      });
    }
    let handoff: DelegateSupervisorHandoff;
    try {
      context.signal.throwIfAborted();
      const handoffOperation = recoveringInterruptedHandoff
        ? adapter.recoverHandoff
        : adapter.handoff;
      if (handoffOperation === undefined) {
        throw new Error(
          `tool adapter ${adapter.name} cannot safely recover an interrupted handoff`,
        );
      }
      handoff = await handoffOperation.call(adapter, {
        invocation: context.state.invocation,
        config: context.config,
        signal: context.signal,
      });
      assertHandoff(handoff);
    } catch (error) {
      context.hostBindings.settleHandoff?.(false);
      if (context.signal.aborted && error === context.signal.reason)
        throw error;
      return recoveryResult(
        roundId,
        "delegate_handoff_failed",
        `Delegated tool handoff failed: ${errorMessage(error)}`,
      );
    }
    try {
      this.recordHandoffEvidence(context, adapter.name, roundId, handoff, true);
      context.hostBindings.settleHandoff?.(true);
    } catch (error) {
      context.hostBindings.settleHandoff?.(false);
      throw error;
    }
    return {
      roundId,
      recommendation: "continue",
      recommendedRoundState: "succeeded",
      recommendedInvocationState: "running",
      recoveryCode: null,
      humanGate: null,
      reason: handoff.summary,
    };
  }

  private async supervise(
    context: ExecutorTickContext<
      DelegateSupervisorConfig,
      DelegateSupervisorHostBindings
    >,
    adapter: DelegateSupervisorToolAdapter | undefined,
    handoff: DelegateSupervisorHandoff,
    decisionHistoryRounds: readonly ExecutorRoundEnvelopeSnapshot[],
    progressRounds: readonly ExecutorRoundEnvelopeSnapshot[],
    reattachingPriorHandoff = false,
  ): Promise<ExecutorTickResult> {
    const active = context.state.currentRound;
    const roundId =
      active !== null &&
      active.round.attempt === context.state.invocation.attempt &&
      !isTerminalExecutorRoundState(active.round.state)
        ? active.round.roundId
        : startRound(
            context,
            "mirroring_external_state",
            "Reading delegated external state.",
          );
    if (reattachingPriorHandoff) {
      this.recordHandoffEvidence(
        context,
        adapter?.name ?? context.config.tool,
        roundId,
        handoff,
        false,
      );
      context.hostBindings.settleHandoff?.(true);
    }
    if (adapter === undefined) {
      return recoveryResult(
        roundId,
        "tool_adapter_unavailable",
        `No delegate-supervisor tool adapter is registered for ${JSON.stringify(context.config.tool)}.`,
      );
    }

    context.signal.throwIfAborted();
    const observedAt = context.hostBindings.now?.() ?? Date.now();
    let rawRead: unknown;
    try {
      rawRead = await adapter.readExternalState({
        invocation: context.state.invocation,
        config: context.config,
        signal: context.signal,
        handoff,
      });
    } catch (error) {
      if (context.signal.aborted && error === context.signal.reason)
        throw error;
      rawRead = {
        ok: false as const,
        error: `Delegated external-state read failed: ${errorMessage(error)}`,
      };
    }
    const validatedRead = validateExternalStateRead(rawRead);
    if (!validatedRead.ok) {
      const decision = classifyDelegateSupervisorUnreadable(
        `Delegated external-state read response is unreadable: ${validatedRead.error}`,
      );
      observeDecision(context, roundId, decision, null, null, observedAt);
      return tickResult(roundId, decision);
    }
    let read = validatedRead.value;
    if (read.ok) {
      const validation = classifyDelegateSupervisorState(read.value);
      if (validation.recoveryCode === "external_state_unreadable") {
        observeDecision(
          context,
          roundId,
          validation,
          read.digest,
          null,
          observedAt,
        );
        return tickResult(roundId, validation);
      }
      if (
        handoff.terminalState !== undefined &&
        isLaggingTerminalCorroboration(read.value, handoff.terminalState.value)
      ) {
        read = {
          ok: true as const,
          ...handoff.terminalState,
          digest: `sha256:${crypto
            .createHash("sha256")
            .update(
              JSON.stringify({
                terminalDigest: handoff.terminalState.digest,
                corroborationDigest: read.digest,
                value: handoff.terminalState.value,
              }),
            )
            .digest("hex")}`,
        };
      }
    }

    if (!read.ok) {
      const decision = classifyDelegateSupervisorUnreadable(read.error);
      observeDecision(context, roundId, decision, null, null, observedAt);
      return tickResult(roundId, decision);
    }

    let decision = classifyDelegateSupervisorState(read.value);
    if (decision.recoveryCode === "external_state_unreadable") {
      observeDecision(
        context,
        roundId,
        decision,
        read.digest,
        null,
        observedAt,
      );
      return tickResult(roundId, decision);
    }
    const progressDigest = delegateSupervisorProgressDigest(read.value);
    const identityMismatch = compareIdentity(
      handoff.externalIdentity,
      read.value,
      read.headRelation,
    );
    if (identityMismatch !== null) {
      decision = classifyDelegateSupervisorInconsistent(identityMismatch);
    }
    const priorUnresolved = countUnresolvedPriorDecisions(
      decisionHistoryRounds,
      read.value,
    );
    if (decision.classification === "complete" && priorUnresolved > 0) {
      decision = classifyDelegateSupervisorInconsistent(
        `delegated external run claims completed but ${priorUnresolved} previously mirrored decision(s) remain unresolved`,
      );
    }

    const previous = latestMirroredCheckpoint(progressRounds);
    const progressAt =
      previous !== null && previous.progressDigest === progressDigest
        ? previous.progressAt
        : observedAt;
    if (
      decision.classification === "continue" &&
      observedAt - progressAt >= DELEGATE_SUPERVISOR_STALL_AFTER_MS
    ) {
      decision = classifyDelegateSupervisorInconsistent(
        `delegated external state for step ${read.value.activeStep ?? "unknown"} has not changed for ${observedAt - progressAt}ms; inspect the external run before clearing recovery`,
      );
    }

    if (
      identityMismatch === null &&
      decision.recoveryCode !== "external_state_unreadable"
    ) {
      mirrorEvidence(context, roundId, read.value);
    }
    observeDecision(
      context,
      roundId,
      decision,
      read.digest,
      identityMismatch === null
        ? { state: read.value, progressDigest, progressAt, observedAt }
        : null,
      observedAt,
    );
    return tickResult(roundId, decision);
  }

  private recordHandoffEvidence(
    context: ExecutorTickContext<
      DelegateSupervisorConfig,
      DelegateSupervisorHostBindings
    >,
    adapterName: string,
    roundId: string,
    handoff: DelegateSupervisorHandoff,
    capturingResult: boolean,
  ): void {
    const beforeEvidence = context.envelope
      .snapshot()
      .rounds.find(({ round }) => round.roundId === roundId);
    const existingArtifactIds = new Set(
      beforeEvidence?.artifacts.map((artifact) => artifact.artifactId) ?? [],
    );
    const existingArtifactPaths = new Set(
      beforeEvidence?.artifacts.map((artifact) => artifact.path) ?? [],
    );
    for (const [index, artifactPath] of (
      handoff.artifactPaths ?? []
    ).entries()) {
      const artifactId = `${roundId}-handoff-artifact-${index}`;
      if (
        existingArtifactIds.has(artifactId) ||
        existingArtifactPaths.has(artifactPath)
      ) {
        continue;
      }
      context.envelope.recordArtifact(roundId, {
        artifactId,
        artifactClass: "logs",
        path: artifactPath,
        digest: null,
        description: `Delegated ${adapterName} handoff evidence.`,
      });
    }
    context.envelope.recordRoundProgress(roundId, {
      observation: {
        ...(capturingResult ? { phase: "capturing_result" as const } : {}),
        summary: handoff.summary,
      },
      checkpoints: [
        {
          checkpointId: `${roundId}-${DELEGATE_SUPERVISOR_HANDOFF_STAGE}`,
          sequence: beforeEvidence?.checkpoints.length ?? 0,
          stage: DELEGATE_SUPERVISOR_HANDOFF_STAGE,
          detail: JSON.stringify(handoff),
        },
      ],
    });
  }
}

function startRound(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  state: "running" | "mirroring_external_state",
  summary: string,
): string {
  const invocation = context.state.invocation;
  const roundId = `${invocation.invocationId}::round-${context.state.rounds.length + 1}`;
  context.envelope.startRound({
    roundId,
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: invocation.executorFamily,
    attempt: invocation.attempt,
    roundIndex: context.state.rounds.length,
    state,
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
  return roundId;
}

function observeDecision(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  roundId: string,
  decision: DelegateSupervisorDecision,
  inputDigest: string | null,
  mirrored: MirroredCheckpoint | null,
  observedAt: number,
): void {
  const snapshot = context.envelope.snapshot();
  const current = snapshot.rounds.find(
    ({ round }) => round.roundId === roundId,
  );
  const sequence = current?.checkpoints.length ?? 0;
  context.envelope.recordRoundProgress(roundId, {
    observation: {
      phase:
        decision.classification === "operator_decision_required" ||
        decision.classification === "approval_required"
          ? "waiting_operator"
          : "mirroring_external_state",
      inputDigest,
      resultDigest: mirrored?.progressDigest ?? null,
      commitSha: mirrored?.state.headSha ?? null,
      summary: decision.reason,
    },
    checkpoints:
      mirrored === null
        ? []
        : [
            {
              checkpointId: `${roundId}-${MIRRORED_STAGE}-${sequence}`,
              sequence,
              stage: MIRRORED_STAGE,
              detail: JSON.stringify(mirrored),
            },
          ],
  });
  // A facade write is the durable liveness signal; keep this explicit for a
  // read failure where there may be no checkpoint batch.
  if (mirrored === null) context.envelope.heartbeat();
  void observedAt;
}

function mirrorEvidence(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  roundId: string,
  state: DelegateSupervisorExternalState,
): void {
  const selected = new Set(state.selectedFindingIds);
  const mirroredRound = context.envelope
    .snapshot()
    .rounds.find(({ round }) => round.roundId === roundId);
  const existingFindings = mirroredRound?.findings ?? [];
  for (const finding of state.findings) {
    const projection = {
      severity: finding.severity ?? null,
      title: finding.title,
      detail: finding.detail ?? null,
      selected: selected.has(finding.externalId),
      externalRef: finding.externalId,
    };
    const projectionKey = findingProjectionKey(projection);
    if (
      existingFindings.some(
        (existing) => findingProjectionKey(existing) === projectionKey,
      )
    ) {
      continue;
    }
    const baseId = `${roundId}-finding-${stableId(finding.externalId)}`;
    const hasPriorVersion = existingFindings.some(
      (existing) => existing.externalRef === finding.externalId,
    );
    context.envelope.recordFinding(roundId, {
      findingId: hasPriorVersion
        ? `${baseId}-${stableId(projectionKey)}`
        : baseId,
      ...projection,
    });
  }
  const decisions =
    state.stepStatus === "awaiting_approval"
      ? [
          ...state.decisions.filter(
            (decision) =>
              decision.externalId !==
              DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
          ),
          {
            externalId: DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
            summary: "Approve the delegated tool boundary.",
            allowedActions: ["approve", "reject"] as const,
            recommendedAction: "approve",
            chosenAction: null,
            resolution: null,
          },
        ]
      : state.decisions;
  const existingDecisions = mirroredRound?.decisions ?? [];
  for (const decision of decisions) {
    const projection = {
      summary: decision.summary,
      allowedActions: [...decision.allowedActions],
      recommendedAction: decision.recommendedAction ?? null,
      chosenAction: decision.chosenAction ?? null,
      resolution: decision.resolution ?? null,
      externalRef: decision.externalId,
    };
    const projectionKey = decisionProjectionKey(projection);
    if (
      existingDecisions.some(
        (existing) => decisionProjectionKey(existing) === projectionKey,
      )
    ) {
      continue;
    }
    const baseId = `${roundId}-decision-${stableId(decision.externalId)}`;
    const hasPriorVersion = existingDecisions.some(
      (existing) => existing.externalRef === decision.externalId,
    );
    context.envelope.recordDecision(roundId, {
      decisionId: hasPriorVersion
        ? `${baseId}-${stableId(projectionKey)}`
        : baseId,
      ...projection,
    });
  }
}

function findingProjectionKey(value: {
  severity: string | null;
  title: string;
  detail: string | null;
  selected: boolean;
  externalRef: string | null;
}): string {
  return JSON.stringify([
    value.externalRef,
    value.severity,
    value.title,
    value.detail,
    value.selected,
  ]);
}

function decisionProjectionKey(value: {
  summary: string;
  allowedActions: readonly string[];
  recommendedAction: string | null;
  chosenAction: string | null;
  resolution: string | null;
  externalRef?: string | null;
}): string {
  return JSON.stringify([
    value.externalRef ?? null,
    value.summary,
    value.allowedActions,
    value.recommendedAction,
    value.chosenAction,
    value.resolution,
  ]);
}

function tickResult(
  roundId: string,
  decision: DelegateSupervisorDecision,
): ExecutorTickResult {
  return {
    roundId,
    recommendation: decision.classification,
    recommendedRoundState:
      decision.classification === "continue"
        ? "succeeded"
        : decision.roundState,
    recommendedInvocationState: decision.invocationState,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    reason: decision.reason,
  };
}

function recoveryResult(
  roundId: string,
  recoveryCode: string,
  reason: string,
): ExecutorTickResult {
  return {
    roundId,
    recommendation: "manual_recovery_required",
    recommendedRoundState: "manual_recovery_required",
    recommendedInvocationState: "manual_recovery_required",
    recoveryCode,
    humanGate: "manual_recovery_required",
    reason,
  };
}

function resolveToolAdapter(
  tools: DelegateSupervisorHostBindings["tools"],
  name: string,
): DelegateSupervisorToolAdapter | undefined {
  if ("get" in tools && typeof tools.get === "function") {
    return tools.get(name);
  }
  return (tools as Readonly<Record<string, DelegateSupervisorToolAdapter>>)[
    name
  ];
}

function findHandoff(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
): DurableCheckpointRead<DelegateSupervisorHandoff> {
  return findDurableCheckpoint(
    rounds,
    DELEGATE_SUPERVISOR_HANDOFF_STAGE,
    (detail) => {
      const parsed = JSON.parse(detail) as DelegateSupervisorHandoff;
      assertHandoff(parsed);
      return parsed;
    },
  );
}

function findLegacyLiveStepCompletion(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
): DurableCheckpointRead<LegacyLiveStepDecision> {
  return findDurableCheckpoint(
    rounds,
    "mechanism_completed",
    parseLegacyLiveStepDecision,
  );
}

function parseLegacyLiveStepDecision(detail: string): LegacyLiveStepDecision {
  const parsed: unknown = JSON.parse(detail);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy mechanism completion is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const recommendation = record["recommendation"];
  const roundState = record["recommendedRoundState"];
  const invocationState = record["recommendedInvocationState"];
  const recoveryCode = record["recoveryCode"];
  const humanGate = record["humanGate"];
  if (!includes(EXECUTOR_COMPLETION_CLASSIFICATIONS, recommendation)) {
    throw new Error("legacy mechanism completion recommendation is invalid");
  }
  if (!includes(EXECUTOR_ROUND_STATES, roundState)) {
    throw new Error("legacy mechanism completion round state is invalid");
  }
  if (!includes(EXECUTOR_INVOCATION_STATES, invocationState)) {
    throw new Error("legacy mechanism completion invocation state is invalid");
  }
  if (recoveryCode !== null && typeof recoveryCode !== "string") {
    throw new Error("legacy mechanism completion recovery code is invalid");
  }
  if (humanGate !== null && !includes(EXECUTOR_HUMAN_GATE_TYPES, humanGate)) {
    throw new Error("legacy mechanism completion human gate is invalid");
  }
  if (typeof record["reason"] !== "string") {
    throw new Error("legacy mechanism completion reason is invalid");
  }
  if (
    invocationState !==
      executorInvocationStateForClassification(recommendation) ||
    !isExecutorRoundStateCompatibleWithClassification(
      recommendation,
      roundState,
    ) ||
    !isExecutorRecoveryCodeCompatibleWithClassification(
      recommendation,
      recoveryCode,
    ) ||
    !isExecutorHumanGateCompatibleWithClassification(recommendation, humanGate)
  ) {
    throw new Error("legacy mechanism completion fields are inconsistent");
  }
  return parsed as LegacyLiveStepDecision;
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

function findDurableCheckpoint<T>(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
  stage: string,
  parse: (detail: string) => T,
): DurableCheckpointRead<T> {
  for (const snapshot of [...rounds].reverse()) {
    const checkpoint = [...snapshot.checkpoints]
      .reverse()
      .find((candidate) => candidate.stage === stage);
    if (checkpoint === undefined) continue;
    if (checkpoint.detail === null) {
      return {
        status: "invalid",
        roundId: snapshot.round.roundId,
        position: {
          roundIndex: snapshot.round.roundIndex,
          sequence: checkpoint.sequence,
        },
        reason: `${stage} checkpoint detail is missing`,
      };
    }
    try {
      return {
        status: "valid",
        roundId: snapshot.round.roundId,
        position: {
          roundIndex: snapshot.round.roundIndex,
          sequence: checkpoint.sequence,
        },
        value: parse(checkpoint.detail),
      };
    } catch (error) {
      return {
        status: "invalid",
        roundId: snapshot.round.roundId,
        position: {
          roundIndex: snapshot.round.roundIndex,
          sequence: checkpoint.sequence,
        },
        reason: errorMessage(error),
      };
    }
  }
  return { status: "absent" };
}

function latestCheckpointPosition(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
  stages: ReadonlySet<string>,
): DurableCheckpointPosition | null {
  let latest: DurableCheckpointPosition | null = null;
  for (const snapshot of rounds) {
    for (const checkpoint of snapshot.checkpoints) {
      if (!stages.has(checkpoint.stage)) continue;
      const candidate = {
        roundIndex: snapshot.round.roundIndex,
        sequence: checkpoint.sequence,
      };
      if (latest === null || isCheckpointAfter(candidate, latest)) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function isCheckpointAfter(
  candidate: DurableCheckpointPosition,
  reference: DurableCheckpointPosition,
): boolean {
  return (
    candidate.roundIndex > reference.roundIndex ||
    (candidate.roundIndex === reference.roundIndex &&
      candidate.sequence > reference.sequence)
  );
}

function replayLegacyCompletion(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  completion: Extract<
    DurableCheckpointRead<LegacyLiveStepDecision>,
    { status: "valid" }
  >,
  fromPriorAttempt: boolean,
): ExecutorTickResult {
  context.hostBindings.settleHandoff?.(
    completion.value.recommendation === "complete" ||
      completion.value.recommendation === "failed",
  );
  const active = context.state.currentRound;
  const reusableActiveRound =
    fromPriorAttempt &&
    active !== null &&
    active.round.attempt === context.state.invocation.attempt &&
    (active.round.state === "running" ||
      active.round.state === "capturing_result")
      ? active.round
      : null;
  if (
    fromPriorAttempt &&
    active !== null &&
    active.round.attempt === context.state.invocation.attempt &&
    !isTerminalExecutorRoundState(active.round.state) &&
    reusableActiveRound === null
  ) {
    throw new Error(
      `legacy completion cannot replay into active ${active.round.state} round ${active.round.roundId}`,
    );
  }
  const roundId =
    reusableActiveRound !== null
      ? reusableActiveRound.roundId
      : fromPriorAttempt
        ? startRound(context, "running", completion.value.reason)
        : completion.roundId;
  if (fromPriorAttempt) {
    if (reusableActiveRound?.state !== "capturing_result") {
      context.envelope.observeRound(roundId, {
        phase: "capturing_result",
        summary: completion.value.reason,
      });
    }
  }
  if (completion.value.recommendation === "continue") {
    const replayRound = context.envelope
      .snapshot()
      .rounds.find(({ round }) => round.roundId === roundId);
    const sequence =
      Math.max(
        -1,
        ...(replayRound?.checkpoints.map((checkpoint) => checkpoint.sequence) ??
          []),
      ) + 1;
    context.envelope.recordCheckpoint(roundId, {
      checkpointId: `${roundId}-${LEGACY_COMPLETION_REPLAYED_STAGE}`,
      sequence,
      stage: LEGACY_COMPLETION_REPLAYED_STAGE,
      detail: JSON.stringify({ sourceRoundId: completion.roundId }),
    });
  }
  return { roundId, ...completion.value };
}

function invalidCompletionEvidenceResult(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  evidence: Extract<DurableCheckpointRead<unknown>, { status: "invalid" }>,
): ExecutorTickResult {
  context.hostBindings.settleHandoff?.(false);
  const active = context.state.currentRound;
  const roundId =
    active !== null && !isTerminalExecutorRoundState(active.round.state)
      ? active.round.roundId
      : startRound(
          context,
          "running",
          "Inspecting unreadable delegated completion evidence.",
        );
  return recoveryResult(
    roundId,
    "delegate_handoff_recovery_required",
    `Durable delegated completion evidence in round ${evidence.roundId} is unreadable: ${evidence.reason}; refusing to repeat delegated external work.`,
  );
}

function latestMirroredCheckpoint(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
): MirroredCheckpoint | null {
  for (const { checkpoints } of [...rounds].reverse()) {
    for (const checkpoint of [...checkpoints].reverse()) {
      if (checkpoint.stage !== MIRRORED_STAGE || checkpoint.detail === null) {
        continue;
      }
      try {
        const parsed = JSON.parse(checkpoint.detail) as MirroredCheckpoint;
        if (
          typeof parsed.progressDigest === "string" &&
          Number.isFinite(parsed.progressAt) &&
          Number.isFinite(parsed.observedAt)
        ) {
          return parsed;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function countUnresolvedPriorDecisions(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
  current: DelegateSupervisorExternalState,
): number {
  const resolvedNow = new Set(
    current.decisions
      .filter((decision) =>
        typeof decision.resolution === "string"
          ? decision.resolution.trim().length > 0
          : false,
      )
      .map((decision) => decision.externalId),
  );
  const latest = new Map<string, string | null>();
  for (const { decisions } of rounds) {
    for (const decision of decisions) {
      if (decision.externalRef !== null && decision.externalRef !== undefined) {
        latest.set(decision.externalRef, decision.resolution);
      }
    }
  }
  return [...latest.entries()].filter(
    ([externalRef, resolution]) =>
      externalRef !== DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID &&
      (resolution === null || resolution.trim().length === 0) &&
      !resolvedNow.has(externalRef),
  ).length;
}

function compareIdentity(
  expected: DelegateSupervisorExternalIdentity,
  actual: DelegateSupervisorExternalIdentity,
  headRelation?: string,
): string | null {
  for (const key of ["externalRunId", "branch"] as const) {
    if (expected[key] !== actual[key]) {
      return `delegated external identity mismatch for ${key}: expected ${expected[key]}, observed ${actual[key]}`;
    }
  }
  if (
    expected.headSha !== actual.headSha &&
    headRelation !== "verified_descendant"
  ) {
    return `delegated external identity mismatch for headSha: expected ${expected.headSha}, observed unverified ${actual.headSha}`;
  }
  return null;
}

function isLaggingTerminalCorroboration(
  observed: DelegateSupervisorExternalState,
  terminal: DelegateSupervisorExternalState,
): boolean {
  return (
    /^[0-9a-f]{40}$/.test(observed.headSha) &&
    observed.externalRunId === terminal.externalRunId &&
    observed.branch === terminal.branch &&
    observed.headSha === terminal.headSha &&
    observed.stepStatus === "running" &&
    (observed.ciState === "passed" || observed.ciState === "none") &&
    observed.findings.length === 0 &&
    observed.selectedFindingIds.length === 0 &&
    observed.decisions.every(
      (decision) =>
        typeof decision.resolution === "string" &&
        decision.resolution.trim().length > 0,
    )
  );
}

function validateExternalStateRead(
  value: unknown,
):
  | { ok: true; value: DelegateSupervisorExternalStateRead }
  | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "response is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record["ok"] !== "boolean") {
    return { ok: false, error: "response ok discriminator is not a boolean" };
  }
  if (record["ok"] === false) {
    if (
      typeof record["error"] !== "string" ||
      record["error"].trim().length === 0
    ) {
      return { ok: false, error: "failed response error is missing" };
    }
    return {
      ok: true,
      value: { ok: false, error: record["error"] },
    };
  }
  if (
    typeof record["digest"] !== "string" ||
    record["digest"].trim().length === 0
  ) {
    return { ok: false, error: "successful response digest is missing" };
  }
  if (
    record["headRelation"] !== undefined &&
    record["headRelation"] !== "verified_descendant"
  ) {
    return { ok: false, error: "successful response head relation is unknown" };
  }
  return {
    ok: true,
    value: {
      ok: true,
      value: record["value"] as DelegateSupervisorExternalState,
      digest: record["digest"],
      ...(record["headRelation"] === "verified_descendant"
        ? { headRelation: record["headRelation"] }
        : {}),
    },
  };
}

function assertHandoff(value: DelegateSupervisorHandoff): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.summary !== "string" ||
    typeof value.externalIdentity !== "object" ||
    value.externalIdentity === null
  ) {
    throw new Error("tool adapter returned an invalid handoff envelope");
  }
  if (value.terminalState !== undefined) {
    if (
      typeof value.terminalState !== "object" ||
      value.terminalState === null ||
      typeof value.terminalState.digest !== "string" ||
      value.terminalState.digest.trim().length === 0 ||
      classifyDelegateSupervisorState(value.terminalState.value)
        .classification !== "complete" ||
      compareIdentity(
        value.externalIdentity,
        value.terminalState.value,
        value.terminalState.headRelation,
      ) !== null
    ) {
      throw new Error(
        "tool adapter returned invalid terminal handoff evidence",
      );
    }
  }
  for (const key of ["externalRunId", "branch", "headSha"] as const) {
    if (
      typeof value.externalIdentity[key] !== "string" ||
      value.externalIdentity[key].trim().length === 0
    ) {
      throw new Error(
        `tool adapter handoff is missing externalIdentity.${key}`,
      );
    }
  }
  if (
    value.artifactPaths !== undefined &&
    (!Array.isArray(value.artifactPaths) ||
      value.artifactPaths.some(
        (item) => typeof item !== "string" || item.length === 0,
      ))
  ) {
    throw new Error(
      "tool adapter handoff artifactPaths must be non-empty strings",
    );
  }
}

function stableId(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
