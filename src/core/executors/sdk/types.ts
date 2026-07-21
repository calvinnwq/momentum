/**
 * Public executor SDK contract.
 *
 * Executors receive durable attempt/round snapshots plus a mediated envelope
 * facade. They never receive a database handle. One `tick` performs at most one
 * bounded turn, records observations and evidence through the facade, and
 * returns a recommendation. The daemon remains the only owner of terminal
 * classifications and state-transition decisions.
 */

import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorCompletionClassification,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorHumanGateType,
  ExecutorAttemptRecord,
  ExecutorAttemptState,
  ExecutorRoundRecord,
  ExecutorRoundState,
  ExecutorRoundVerificationResult,
} from "../loop/reducer.js";

/** JSON-Schema-shaped subset supported by executor config declarations. */
export type ExecutorConfigValueSchema =
  | ExecutorConfigStringSchema
  | ExecutorConfigNumberSchema
  | ExecutorConfigBooleanSchema
  | ExecutorConfigArraySchema
  | ExecutorConfigObjectSchema;

export type ExecutorConfigStringSchema = {
  readonly type: "string";
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly pattern?: string;
};

export type ExecutorConfigNumberSchema = {
  readonly type: "integer" | "number";
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly multipleOf?: number;
};

export type ExecutorConfigBooleanSchema = {
  readonly type: "boolean";
  readonly description?: string;
};

export type ExecutorConfigArraySchema = {
  readonly type: "array";
  readonly description?: string;
  readonly items: ExecutorConfigValueSchema;
  readonly minItems?: number;
};

export type ExecutorConfigObjectSchema = {
  readonly type: "object";
  readonly description?: string;
  readonly properties: Readonly<Record<string, ExecutorConfigValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
};

/** Every executor declares the portable step-config object it accepts. */
export type ExecutorConfigSchema = ExecutorConfigObjectSchema;

export type ExecutorRoundView = Omit<
  Readonly<ExecutorRoundRecord>,
  | "logPaths"
  | "keyChanges"
  | "keyLearnings"
  | "remainingWork"
  | "changedFiles"
  | "verificationResults"
> & {
  readonly logPaths: readonly string[];
  readonly keyChanges: readonly string[];
  readonly keyLearnings: readonly string[];
  readonly remainingWork: readonly string[];
  readonly changedFiles: readonly string[];
  readonly verificationResults?:
    readonly Readonly<ExecutorRoundVerificationResult>[] | undefined;
};

export type ExecutorDecisionView = Omit<
  Readonly<ExecutorDecisionRecord>,
  "allowedActions"
> & {
  readonly allowedActions: readonly string[];
};

/** A round plus every durable child-evidence row recorded below it. */
export type ExecutorRoundEnvelopeSnapshot = {
  readonly round: ExecutorRoundView;
  readonly artifacts: readonly Readonly<ExecutorArtifactRecord>[];
  readonly checkpoints: readonly Readonly<ExecutorCheckpointRecord>[];
  readonly findings: readonly Readonly<ExecutorFindingRecord>[];
  readonly decisions: readonly ExecutorDecisionView[];
};

/** Stable, read-only state presented at the start of a tick. */
export type ExecutorEnvelopeSnapshot = {
  readonly attempt: Readonly<ExecutorAttemptRecord>;
  readonly rounds: readonly ExecutorRoundEnvelopeSnapshot[];
  /** Latest round in attempt-number / round-index order, or null before the step has any rounds. */
  readonly currentRound: ExecutorRoundEnvelopeSnapshot | null;
};

export const EXECUTOR_OBSERVATION_PHASES = [
  "pending",
  "running",
  "capturing_result",
  "finalizing",
  "mirroring_external_state",
  "waiting_operator",
] as const satisfies readonly ExecutorRoundState[];

export type ExecutorObservationPhase =
  (typeof EXECUTOR_OBSERVATION_PHASES)[number];

/**
 * Initial record an executor may submit.
 * Decision-owned fields are omitted and filled with null by the durable facade;
 * start and heartbeat timestamps are omitted and stamped from the facade clock.
 */
export type ExecutorRoundStart = Omit<
  ExecutorRoundRecord,
  | "state"
  | "classification"
  | "executorRecommendation"
  | "startedAt"
  | "heartbeatAt"
  | "finishedAt"
  | "recoveryCode"
  | "humanGate"
  | "legacyAttemptNumber"
  | "logPaths"
  | "keyChanges"
  | "keyLearnings"
  | "remainingWork"
  | "changedFiles"
  | "verificationResults"
> & {
  readonly state: ExecutorObservationPhase;
  readonly logPaths: readonly string[];
  readonly keyChanges: readonly string[];
  readonly keyLearnings: readonly string[];
  readonly remainingWork: readonly string[];
  readonly changedFiles: readonly string[];
  readonly verificationResults?:
    readonly Readonly<ExecutorRoundVerificationResult>[] | undefined;
};

/**
 * Evidence-bearing round fields an executor may record during its tick.
 * Classification, terminal state, executor recommendation, human gate, and
 * finished timestamp are deliberately absent: those are daemon decisions.
 */
export type ExecutorRoundObservation = {
  readonly phase?: ExecutorObservationPhase;
  readonly agentProvider?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly inputDigest?: string | null;
  readonly resultDigest?: string | null;
  readonly artifactRoot?: string | null;
  readonly logPaths?: readonly string[];
  readonly summary?: string | null;
  readonly keyChanges?: readonly string[];
  readonly keyLearnings?: readonly string[];
  readonly remainingWork?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly verificationStatus?: string | null;
  readonly verificationResults?:
    readonly Readonly<ExecutorRoundVerificationResult>[] | undefined;
  readonly commitSha?: string | null;
};

export type ExecutorArtifactInput = Omit<ExecutorArtifactRecord, "roundId">;
export type ExecutorCheckpointInput = Omit<ExecutorCheckpointRecord, "roundId">;
export type ExecutorFindingInput = Omit<ExecutorFindingRecord, "roundId">;
export type ExecutorDecisionInput = Omit<ExecutorDecisionRecord, "roundId">;

export type ExecutorRoundProgress = {
  readonly observation: ExecutorRoundObservation;
  readonly checkpoints: readonly ExecutorCheckpointInput[];
};

export type ExecutorRoundProgressResult = {
  readonly round: ExecutorRoundView;
  readonly checkpoints: readonly Readonly<ExecutorCheckpointRecord>[];
};

/**
 * The only durable-state API passed to executor code. Implementations are bound
 * to one attempt and automatically bind child evidence to the named round.
 * Write methods are available only while the attempt state is `running`.
 */
export interface ExecutorEnvelope {
  snapshot(): ExecutorEnvelopeSnapshot;
  /** Atomically starts a round with any initial durable binding checkpoints. */
  startRound(
    record: ExecutorRoundStart,
    initialCheckpoints?: readonly ExecutorCheckpointInput[],
  ): ExecutorRoundView;
  observeRound(
    roundId: string,
    observation: ExecutorRoundObservation,
  ): ExecutorRoundView;
  /** Atomically records one observation and its supporting checkpoint batch. */
  recordRoundProgress(
    roundId: string,
    progress: ExecutorRoundProgress,
  ): ExecutorRoundProgressResult;
  heartbeat(): ExecutorEnvelopeSnapshot;
  recordArtifact(
    roundId: string,
    artifact: ExecutorArtifactInput,
  ): Readonly<ExecutorArtifactRecord>;
  recordCheckpoint(
    roundId: string,
    checkpoint: ExecutorCheckpointInput,
  ): Readonly<ExecutorCheckpointRecord>;
  recordFinding(
    roundId: string,
    finding: ExecutorFindingInput,
  ): Readonly<ExecutorFindingRecord>;
  recordDecision(
    roundId: string,
    decision: ExecutorDecisionInput,
  ): Readonly<ExecutorDecisionRecord>;
}

/** Inputs to one bounded executor turn. */
export type ExecutorTickContext<Config = unknown, HostBindings = unknown> = {
  /** Snapshot captured before this tick starts. */
  readonly state: ExecutorEnvelopeSnapshot;
  /** Machine-portable workflow intent, declared by {@link Executor.configSchema}. */
  readonly config: Readonly<Config>;
  /** Machine-local executable/env/credential resolution, never workflow data. */
  readonly hostBindings: Readonly<HostBindings>;
  /** Durable facade bound to `state.attempt`. */
  readonly envelope: ExecutorEnvelope;
  /** Daemon cancellation signal for the bounded turn. */
  readonly signal: AbortSignal;
};

/**
 * A tick's recommendation. Every state and gate is explicitly recommended;
 * the daemon may accept, refine, or refuse it from durable evidence and policy.
 */
export type ExecutorTickResult = {
  readonly roundId: string;
  readonly recommendation: ExecutorCompletionClassification;
  readonly recommendedRoundState: ExecutorRoundState;
  readonly recommendedAttemptState: ExecutorAttemptState;
  readonly recoveryCode: string | null;
  readonly humanGate: ExecutorHumanGateType | null;
  /**
   * Selects the unresolved durable decision that a human gate must mirror.
   * Omit or set null to select the last unresolved decision.
   */
  readonly humanGateDecisionId?: string | null;
  readonly reason: string;
};

/** Durable checkpoint stage for the decision selector applied to a human gate. */
export const EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE =
  "human_gate_decision_selected";

/**
 * Core executor SDK interface. Registration/discovery decides the durable name;
 * this contract only defines what a registered implementation must expose.
 */
export interface Executor<Config = unknown, HostBindings = unknown> {
  readonly name: string;
  readonly configSchema: ExecutorConfigSchema;
  tick(
    context: ExecutorTickContext<Config, HostBindings>,
  ): ExecutorTickResult | Promise<ExecutorTickResult>;
}

/**
 * Host-side decision applied after inspecting an executor recommendation.
 * The durable controller rejects classification, attempt-state, and
 * round-state combinations that violate the executor-loop classification map.
 */
export type ExecutorDaemonDecision = {
  readonly roundId: string;
  readonly classification: ExecutorCompletionClassification;
  readonly executorRecommendation: ExecutorCompletionClassification | null;
  readonly roundState: ExecutorRoundState;
  readonly attemptState: ExecutorAttemptState;
  readonly recoveryCode: string | null;
  readonly humanGate: ExecutorHumanGateType | null;
};
