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
  EXECUTOR_ATTEMPT_STATES,
  EXECUTOR_ROUND_STATES,
  executorAttemptStateForClassification,
  executorRoundReplayAttemptNumber,
  isExecutorHumanGateCompatibleWithClassification,
  isExecutorRecoveryCodeCompatibleWithClassification,
  isExecutorRoundStateCompatibleWithClassification,
  isTerminalExecutorRoundState,
  isExecutorDecisionEligibleForHumanGate,
  nextExecutorRoundIndex,
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
/** Durable before an adapter launch so interrupted handoff recovery can resume. */
export const DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE =
  "delegate_handoff_intent";
export const DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE =
  "delegate_legacy_completion_replayed";
/** Durable canonical external state, including pre-classification gate evidence. */
export const DELEGATE_SUPERVISOR_MIRRORED_STAGE =
  "delegate_external_state_mirrored";

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
  | "recommendedAttemptState"
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

type DurableDelegateHandoff = {
  adapterName: string;
  handoff: DelegateSupervisorHandoff;
};

type DurableDelegateHandoffIntent = {
  tool: string;
  attemptId: string;
  attempt: number;
};

/** SDK-native executor that composes one active handoff with repeated polls. */
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
      ({ round }) =>
        round.attemptNumber === context.state.attempt.attemptNumber,
    );
    const priorRounds = context.state.rounds.filter(
      ({ round }) => round.attemptNumber < context.state.attempt.attemptNumber,
    );
    const legacyCompletion = findLegacyLiveStepCompletion(context.state.rounds);
    const interruptedLegacyReplay = findDurableCheckpoint(
      attemptRounds.filter(({ round }) => round.classification === null),
      DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
      parseLegacyCompletionReplay,
    );
    if (interruptedLegacyReplay.status !== "absent") {
      if (
        interruptedLegacyReplay.status === "invalid" ||
        legacyCompletion.status !== "valid" ||
        interruptedLegacyReplay.value.sourceRoundId !== legacyCompletion.roundId
      ) {
        return invalidCompletionEvidenceResult(
          context,
          interruptedLegacyReplay.status === "invalid"
            ? interruptedLegacyReplay
            : {
                status: "invalid",
                roundId: interruptedLegacyReplay.roundId,
                position: interruptedLegacyReplay.position,
                reason:
                  "legacy completion replay does not match its durable source round",
              },
        );
      }
      const fromPriorAttempt = !attemptRounds.some(
        ({ round }) => round.roundId === legacyCompletion.roundId,
      );
      return replayLegacyCompletion(
        context,
        legacyCompletion,
        fromPriorAttempt,
        true,
      );
    }
    const latestDelegateEvidence = latestCheckpointPosition(
      context.state.rounds,
      new Set([
        DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
        DELEGATE_SUPERVISOR_HANDOFF_STAGE,
        DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
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
            (checkpoint) =>
              checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
          ) &&
          !checkpoints.some(
            (checkpoint) =>
              checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_STAGE,
          ),
      );
    if (attemptRounds.length === 0 && unresolvedPriorIntent !== undefined) {
      const intent = findHandoffIntent(unresolvedPriorIntent);
      if (intent.status === "invalid") {
        return invalidCompletionEvidenceResult(context, intent);
      }
      if (
        intent.status === "absent" ||
        intent.value.tool !== context.config.tool ||
        !intentMatchesAttemptIdentity(
          intent.value.attemptId,
          unresolvedPriorIntent.round.attemptId,
        ) ||
        !intentMatchesRoundAttempt(
          intent.value.attempt,
          unresolvedPriorIntent.round,
        )
      ) {
        return adapterIdentityMismatchResult(
          context,
          intent.status === "valid" ? intent.value.tool : "unknown",
        );
      }
      return this.handoff(
        context,
        adapter,
        unresolvedPriorIntent.round.attemptNumber,
      );
    }
    if (attemptRounds.length === 0 && priorHandoff.status === "invalid") {
      return invalidCompletionEvidenceResult(context, priorHandoff);
    }
    if (attemptRounds.length === 0 && priorHandoff.status === "valid") {
      if (priorHandoff.value.adapterName !== context.config.tool) {
        return adapterIdentityMismatchResult(
          context,
          priorHandoff.value.adapterName,
        );
      }
      const priorHandoffAttempt = priorRounds.find(
        ({ round }) => round.roundId === priorHandoff.roundId,
      )?.round.attemptNumber;
      if (priorHandoffAttempt === undefined) {
        throw new Error("prior delegate handoff round is missing");
      }
      return this.handoff(context, adapter, priorHandoffAttempt);
    }
    const handoffRecord = findHandoff(attemptRounds);
    if (handoffRecord.status === "invalid") {
      return invalidCompletionEvidenceResult(context, handoffRecord);
    }
    if (handoffRecord.status === "absent") {
      return this.handoff(context, adapter);
    }
    if (handoffRecord.value.adapterName !== context.config.tool) {
      return adapterIdentityMismatchResult(
        context,
        handoffRecord.value.adapterName,
      );
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
        recommendedAttemptState: "running",
        recoveryCode: null,
        humanGate: null,
        reason: handoffRecord.value.handoff.summary,
      };
    }
    return this.supervise(
      context,
      adapter,
      handoffRecord.value.handoff,
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
      active.round.attemptNumber === context.state.attempt.attemptNumber &&
      !isTerminalExecutorRoundState(active.round.state)
        ? active.round.roundId
        : startRound(context, "running", "Handing work to delegated tool.");
    const roundBeforeHandoff = context.envelope
      .snapshot()
      .rounds.find(({ round }) => round.roundId === roundId);
    const hasCurrentHandoffIntent =
      roundBeforeHandoff?.checkpoints.some(
        (checkpoint) =>
          checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
      ) ?? false;
    if (hasCurrentHandoffIntent && roundBeforeHandoff !== undefined) {
      const intent = findHandoffIntent(roundBeforeHandoff);
      if (intent.status === "invalid") {
        return invalidCompletionEvidenceResult(context, intent);
      }
      if (
        intent.status === "absent" ||
        intent.value.tool !== context.config.tool ||
        !intentMatchesAttemptIdentity(
          intent.value.attemptId,
          roundBeforeHandoff.round.attemptId,
        ) ||
        !intentMatchesRoundAttempt(
          intent.value.attempt,
          roundBeforeHandoff.round,
        )
      ) {
        return adapterIdentityMismatchResult(
          context,
          intent.status === "valid" ? intent.value.tool : "unknown",
        );
      }
    }
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
        checkpointId: `${roundId}-${DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE}`,
        sequence,
        stage: DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
        detail: JSON.stringify({
          tool: context.config.tool,
          attemptId: context.state.attempt.attemptId,
          attempt: context.state.attempt.attemptNumber,
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
        attempt: context.state.attempt,
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
      recommendedAttemptState: "running",
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
      active.round.attemptNumber === context.state.attempt.attemptNumber &&
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
        attempt: context.state.attempt,
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
      observeDecision(context, roundId, decision, null, null);
      return tickResult(roundId, decision);
    }
    let read = validatedRead.value;
    if (read.ok) {
      const validation = classifyDelegateSupervisorState(read.value);
      if (validation.recoveryCode === "external_state_unreadable") {
        observeDecision(context, roundId, validation, read.digest, null);
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
      observeDecision(context, roundId, decision, null, null);
      return tickResult(roundId, decision);
    }

    let decision = classifyDelegateSupervisorState(read.value);
    if (decision.recoveryCode === "external_state_unreadable") {
      observeDecision(context, roundId, decision, read.digest, null);
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
    const scopedDecisionHistory = decisionHistoryRoundsForExternalRun(
      decisionHistoryRounds,
      read.value.externalRunId,
    );
    const priorUnresolved = countUnresolvedPriorDecisions(
      scopedDecisionHistory,
      read.value,
    );
    if (decision.classification === "complete" && priorUnresolved > 0) {
      decision = classifyDelegateSupervisorInconsistent(
        `delegated external run claims completed but ${priorUnresolved} previously mirrored decision(s) remain unresolved`,
      );
    }
    const supervisorApproval = blockingSupervisorApprovalDecision(
      scopedDecisionHistory,
    );
    if (decision.classification === "complete" && supervisorApproval !== null) {
      const disposition =
        supervisorApproval.chosenAction === null
          ? "remains unresolved"
          : `was ${supervisorApproval.chosenAction}`;
      decision = classifyDelegateSupervisorInconsistent(
        `delegated external run claims completed but its supervisor approval ${disposition}; only approve permits completion`,
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

    let humanGateDecisionId: string | undefined;
    if (
      identityMismatch === null &&
      decision.recoveryCode !== "external_state_unreadable"
    ) {
      humanGateDecisionId = mirrorEvidence(context, roundId, read.value);
    }
    observeDecision(
      context,
      roundId,
      decision,
      read.digest,
      identityMismatch === null
        ? { state: read.value, progressDigest, progressAt, observedAt }
        : null,
    );
    return tickResult(roundId, decision, humanGateDecisionId);
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
    for (const artifactPath of handoff.artifactPaths ?? []) {
      const artifactId = `${roundId}-handoff-artifact-${stableId(artifactPath)}`;
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
          detail: JSON.stringify({ adapterName, handoff }),
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
  const attempt = context.state.attempt;
  const nextRoundIndex = nextExecutorRoundIndex(
    context.state.rounds.map((snapshot) => snapshot.round),
  );
  const roundId = `${attempt.attemptId}::round-${nextRoundIndex + 1}`;
  const round = context.envelope.startRound({
    roundId,
    attemptId: attempt.attemptId,
    workflowRunId: attempt.workflowRunId,
    stepRunId: attempt.stepRunId,
    stepKey: attempt.stepKey,
    executor: attempt.executor,
    attemptNumber: attempt.attemptNumber,
    roundIndex: nextRoundIndex,
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
  return round.roundId;
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
              checkpointId: `${roundId}-${DELEGATE_SUPERVISOR_MIRRORED_STAGE}-${sequence}`,
              sequence,
              stage: DELEGATE_SUPERVISOR_MIRRORED_STAGE,
              detail: JSON.stringify(mirrored),
            },
          ],
  });
  // A facade write is the durable liveness signal; keep this explicit for a
  // read failure where there may be no checkpoint batch.
  if (mirrored === null) context.envelope.heartbeat();
}

function mirrorEvidence(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  roundId: string,
  state: DelegateSupervisorExternalState,
): string | undefined {
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
  let syntheticApprovalDecisionId = existingDecisions.find(
    (decision) =>
      decision.chosenAction === null &&
      decision.externalRef ===
        DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
  )?.decisionId;
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
    const existingDecision = existingDecisions.find(
      (existing) => decisionProjectionKey(existing) === projectionKey,
    );
    const isSyntheticApproval =
      decision.externalId ===
      DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID;
    if (
      existingDecision !== undefined &&
      (!isSyntheticApproval || existingDecision.chosenAction === null)
    ) {
      if (isSyntheticApproval && existingDecision.chosenAction === null) {
        syntheticApprovalDecisionId = existingDecision.decisionId;
      }
      continue;
    }
    const baseId = `${roundId}-decision-${stableId(decision.externalId)}`;
    const hasPriorVersion = existingDecisions.some(
      (existing) => existing.externalRef === decision.externalId,
    );
    const versionBaseId = `${baseId}-${stableId(projectionKey)}`;
    let decisionId = hasPriorVersion ? versionBaseId : baseId;
    for (
      let version = 2;
      existingDecisions.some((existing) => existing.decisionId === decisionId);
      version += 1
    ) {
      decisionId = `${versionBaseId}-${version}`;
    }
    const recorded = context.envelope.recordDecision(roundId, {
      decisionId,
      ...projection,
    });
    if (isSyntheticApproval) {
      syntheticApprovalDecisionId = recorded.decisionId;
    }
  }
  return syntheticApprovalDecisionId;
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
  humanGateDecisionId?: string,
): ExecutorTickResult {
  return {
    roundId,
    recommendation: decision.classification,
    recommendedRoundState:
      decision.classification === "continue"
        ? "succeeded"
        : decision.roundState,
    recommendedAttemptState: decision.attemptState,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    ...(humanGateDecisionId !== undefined ? { humanGateDecisionId } : {}),
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
    recommendedAttemptState: "manual_recovery_required",
    recoveryCode,
    humanGate: "manual_recovery_required",
    reason,
  };
}

function resolveToolAdapter(
  tools: DelegateSupervisorHostBindings["tools"],
  name: string,
): DelegateSupervisorToolAdapter | undefined {
  let adapter: DelegateSupervisorToolAdapter | undefined;
  if ("get" in tools && typeof tools.get === "function") {
    adapter = tools.get(name);
  } else {
    adapter = (
      tools as Readonly<Record<string, DelegateSupervisorToolAdapter>>
    )[name];
  }
  return adapter?.name === name ? adapter : undefined;
}

function findHandoff(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
): DurableCheckpointRead<DurableDelegateHandoff> {
  for (const snapshot of [...rounds].reverse()) {
    const checkpoint = [...snapshot.checkpoints]
      .reverse()
      .find(
        (candidate) => candidate.stage === DELEGATE_SUPERVISOR_HANDOFF_STAGE,
      );
    if (checkpoint === undefined) continue;
    const position = {
      roundIndex: snapshot.round.roundIndex,
      sequence: checkpoint.sequence,
    };
    if (checkpoint.detail === null) {
      return {
        status: "invalid",
        roundId: snapshot.round.roundId,
        position,
        reason: `${DELEGATE_SUPERVISOR_HANDOFF_STAGE} checkpoint detail is missing`,
      };
    }
    try {
      const parsed: unknown = JSON.parse(checkpoint.detail);
      if (isDurableDelegateHandoff(parsed)) {
        assertHandoff(parsed.handoff);
        return {
          status: "valid",
          roundId: snapshot.round.roundId,
          position,
          value: parsed,
        };
      }
      const legacyHandoff = parsed as DelegateSupervisorHandoff;
      assertHandoff(legacyHandoff);
      return {
        status: "valid",
        roundId: snapshot.round.roundId,
        position,
        value: {
          adapterName: legacyHandoffIntentTool(snapshot),
          handoff: legacyHandoff,
        },
      };
    } catch (error) {
      return {
        status: "invalid",
        roundId: snapshot.round.roundId,
        position,
        reason: errorMessage(error),
      };
    }
  }
  return { status: "absent" };
}

/**
 * An intent checkpoint must identify the attempt that owns its round. Migrated
 * legacy evidence needs one narrow tolerance: intents recorded before the
 * attempt/round migration carry the shared legacy invocation id, while their
 * reconstructed historical attempt rows derive ids as
 * `<legacyInvocationId>::attempt-<n>`.
 */
function intentMatchesAttemptIdentity(
  intentAttemptId: string,
  roundAttemptId: string,
): boolean {
  return (
    roundAttemptId === intentAttemptId ||
    roundAttemptId.startsWith(`${intentAttemptId}::attempt-`)
  );
}

function intentMatchesRoundAttempt(
  intentAttempt: number,
  round: ExecutorRoundEnvelopeSnapshot["round"],
): boolean {
  return (
    intentAttempt === round.attemptNumber ||
    intentAttempt === executorRoundReplayAttemptNumber(round)
  );
}

function findHandoffIntent(
  snapshot: ExecutorRoundEnvelopeSnapshot,
): DurableCheckpointRead<DurableDelegateHandoffIntent> {
  const checkpoint = [...snapshot.checkpoints]
    .reverse()
    .find(
      (candidate) =>
        candidate.stage === DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
    );
  if (checkpoint === undefined) return { status: "absent" };
  const position = {
    roundIndex: snapshot.round.roundIndex,
    sequence: checkpoint.sequence,
  };
  if (checkpoint.detail === null) {
    return {
      status: "invalid",
      roundId: snapshot.round.roundId,
      position,
      reason: `${DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE} checkpoint detail is missing`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(checkpoint.detail);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("durable delegated handoff intent is invalid");
    }
    const record = parsed as Record<string, unknown>;
    // Legacy reader: intents recorded before the attempt/round migration carry
    // the attempt identity under the historical `invocationId` field name.
    const attemptId = record["attemptId"] ?? record["invocationId"];
    if (
      typeof record["tool"] !== "string" ||
      record["tool"].trim().length === 0 ||
      typeof attemptId !== "string" ||
      attemptId.trim().length === 0 ||
      typeof record["attempt"] !== "number" ||
      !Number.isInteger(record["attempt"]) ||
      record["attempt"] < 1
    ) {
      throw new Error("durable delegated handoff intent is invalid");
    }
    const value: DurableDelegateHandoffIntent = {
      tool: record["tool"],
      attemptId,
      attempt: record["attempt"],
    };
    return {
      status: "valid",
      roundId: snapshot.round.roundId,
      position,
      value,
    };
  } catch (error) {
    return {
      status: "invalid",
      roundId: snapshot.round.roundId,
      position,
      reason: errorMessage(error),
    };
  }
}

function isDurableDelegateHandoff(
  value: unknown,
): value is DurableDelegateHandoff {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { adapterName?: unknown }).adapterName === "string" &&
    (value as { adapterName: string }).adapterName.trim().length > 0 &&
    "handoff" in value
  );
}

function legacyHandoffIntentTool(
  snapshot: ExecutorRoundEnvelopeSnapshot,
): string {
  const intent = [...snapshot.checkpoints]
    .reverse()
    .find(
      (checkpoint) =>
        checkpoint.stage === DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE &&
        checkpoint.detail !== null,
    );
  if (intent?.detail === null || intent === undefined) {
    throw new Error(
      "legacy durable delegated handoff has no adapter identity intent",
    );
  }
  const parsed: unknown = JSON.parse(intent.detail);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { tool?: unknown }).tool !== "string" ||
    (parsed as { tool: string }).tool.trim().length === 0
  ) {
    throw new Error(
      "legacy durable delegated handoff adapter identity intent is invalid",
    );
  }
  return (parsed as { tool: string }).tool;
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
  // Legacy reader: completion checkpoints recorded before the attempt/round
  // migration serialized the daemon decision with the historical
  // `recommendedInvocationState` key, and the migration preserves checkpoint
  // payloads verbatim.
  const attemptState =
    record["recommendedAttemptState"] ?? record["recommendedInvocationState"];
  const recoveryCode = record["recoveryCode"];
  const humanGate = record["humanGate"];
  if (!includes(EXECUTOR_COMPLETION_CLASSIFICATIONS, recommendation)) {
    throw new Error("legacy mechanism completion recommendation is invalid");
  }
  if (!includes(EXECUTOR_ROUND_STATES, roundState)) {
    throw new Error("legacy mechanism completion round state is invalid");
  }
  if (!includes(EXECUTOR_ATTEMPT_STATES, attemptState)) {
    throw new Error("legacy mechanism completion attempt state is invalid");
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
    attemptState !== executorAttemptStateForClassification(recommendation) ||
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
  // Return a normalized decision rather than the raw record so pre-migration
  // payloads keyed by `recommendedInvocationState` replay identically.
  return {
    recommendation,
    recommendedRoundState: roundState,
    recommendedAttemptState: attemptState,
    recoveryCode,
    humanGate,
    reason: record["reason"],
  };
}

function parseLegacyCompletionReplay(detail: string): {
  sourceRoundId: string;
} {
  const parsed: unknown = JSON.parse(detail);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { sourceRoundId?: unknown }).sourceRoundId !== "string" ||
    (parsed as { sourceRoundId: string }).sourceRoundId.trim().length === 0
  ) {
    throw new Error("legacy completion replay source round is invalid");
  }
  return parsed as { sourceRoundId: string };
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
  replayCheckpointAlreadyRecorded = false,
): ExecutorTickResult {
  context.hostBindings.settleHandoff?.(
    completion.value.recommendation === "complete" ||
      completion.value.recommendation === "failed",
  );
  const active = context.state.currentRound;
  const reusableActiveRound =
    fromPriorAttempt &&
    active !== null &&
    active.round.attemptNumber === context.state.attempt.attemptNumber &&
    (active.round.state === "running" ||
      active.round.state === "capturing_result")
      ? active.round
      : null;
  if (
    fromPriorAttempt &&
    active !== null &&
    active.round.attemptNumber === context.state.attempt.attemptNumber &&
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
  const shouldRecordReplayCheckpoint =
    !replayCheckpointAlreadyRecorded &&
    (fromPriorAttempt || completion.value.recommendation === "continue");
  if (fromPriorAttempt && shouldRecordReplayCheckpoint) {
    const replayRound = context.envelope
      .snapshot()
      .rounds.find(({ round }) => round.roundId === roundId);
    const sequence =
      Math.max(
        -1,
        ...(replayRound?.checkpoints.map((checkpoint) => checkpoint.sequence) ??
          []),
      ) + 1;
    context.envelope.recordRoundProgress(roundId, {
      observation: {
        phase: "capturing_result",
        summary: completion.value.reason,
      },
      checkpoints: [
        {
          checkpointId: `${roundId}-${DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE}`,
          sequence,
          stage: DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
          detail: JSON.stringify({ sourceRoundId: completion.roundId }),
        },
      ],
    });
  } else {
    if (fromPriorAttempt && reusableActiveRound?.state !== "capturing_result") {
      context.envelope.observeRound(roundId, {
        phase: "capturing_result",
        summary: completion.value.reason,
      });
    }
    if (shouldRecordReplayCheckpoint) {
      const replayRound = context.envelope
        .snapshot()
        .rounds.find(({ round }) => round.roundId === roundId);
      const sequence =
        Math.max(
          -1,
          ...(replayRound?.checkpoints.map(
            (checkpoint) => checkpoint.sequence,
          ) ?? []),
        ) + 1;
      context.envelope.recordCheckpoint(roundId, {
        checkpointId: `${roundId}-${DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE}`,
        sequence,
        stage: DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
        detail: JSON.stringify({ sourceRoundId: completion.roundId }),
      });
    }
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

function adapterIdentityMismatchResult(
  context: ExecutorTickContext<
    DelegateSupervisorConfig,
    DelegateSupervisorHostBindings
  >,
  durableAdapterName: string,
): ExecutorTickResult {
  context.hostBindings.settleHandoff?.(false);
  const active = context.state.currentRound;
  const roundId =
    active !== null && !isTerminalExecutorRoundState(active.round.state)
      ? active.round.roundId
      : startRound(
          context,
          "running",
          "Validating durable delegated adapter identity.",
        );
  return recoveryResult(
    roundId,
    "delegate_adapter_identity_mismatch",
    `Durable delegated handoff belongs to adapter ${JSON.stringify(durableAdapterName)}, not configured adapter ${JSON.stringify(context.config.tool)}.`,
  );
}

function latestMirroredCheckpoint(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
): MirroredCheckpoint | null {
  for (const { checkpoints } of [...rounds].reverse()) {
    for (const checkpoint of [...checkpoints].reverse()) {
      if (
        checkpoint.stage !== DELEGATE_SUPERVISOR_MIRRORED_STAGE ||
        checkpoint.detail === null
      ) {
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
      .filter((decision) => !isExecutorDecisionEligibleForHumanGate(decision))
      .map((decision) => decision.externalId),
  );
  const latest = new Map<
    string,
    { chosenAction: string | null; resolution: string | null }
  >();
  for (const { decisions } of rounds) {
    for (const decision of decisions) {
      if (decision.externalRef !== null && decision.externalRef !== undefined) {
        latest.set(decision.externalRef, {
          chosenAction: decision.chosenAction,
          resolution: decision.resolution,
        });
      }
    }
  }
  return [...latest.entries()].filter(
    ([externalRef, decision]) =>
      externalRef !== DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID &&
      isExecutorDecisionEligibleForHumanGate(decision) &&
      !resolvedNow.has(externalRef),
  ).length;
}

function decisionHistoryRoundsForExternalRun(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
  externalRunId: string,
): readonly ExecutorRoundEnvelopeSnapshot[] {
  return rounds.filter(
    (round) =>
      latestMirroredCheckpoint([round])?.state.externalRunId === externalRunId,
  );
}

function blockingSupervisorApprovalDecision(
  rounds: readonly ExecutorRoundEnvelopeSnapshot[],
) {
  for (const { decisions } of [...rounds].reverse()) {
    const decision = [...decisions]
      .reverse()
      .find(
        ({ externalRef }) =>
          externalRef === DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
      );
    if (decision !== undefined) {
      return decision.chosenAction === "approve" ? null : decision;
    }
  }
  return null;
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
    observed.activeStep === null &&
    observed.stepStatus === "running" &&
    (observed.ciState === "passed" || observed.ciState === "none") &&
    observed.findings.length === 0 &&
    observed.selectedFindingIds.length === 0 &&
    observed.decisions.every(
      (decision) => !isExecutorDecisionEligibleForHumanGate(decision),
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
  if (!/^[0-9a-f]{40}$/.test(value.externalIdentity.headSha)) {
    throw new Error(
      "tool adapter handoff externalIdentity.headSha must be a canonical full 40-character commit SHA",
    );
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
