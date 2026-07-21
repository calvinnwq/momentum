/** Single-shot lifecycle implementation of the public executor SDK contract. */

import crypto from "node:crypto";

import { MAX_BUILT_IN_PROCESS_TIMEOUT_MS } from "../../../shared/process-limits.js";

import {
  executorRoundReplayAttemptNumber,
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorRoundRecord,
} from "../loop/reducer.js";
import { normalizeRunnerResult } from "../runner/result.js";
import type { RunnerResult } from "../runner/types.js";
import {
  SCRIPT_COMMAND_IDENTITY_PATTERN,
  isPortableScriptCommandIdentity,
} from "../sdk/portable-command.js";
import {
  EXECUTOR_OBSERVATION_PHASES,
  type ExecutorObservationPhase,
  type Executor,
  type ExecutorConfigSchema,
  type ExecutorRoundObservation,
  type ExecutorRoundStart,
  type ExecutorRoundView,
  type ExecutorTickContext,
  type ExecutorTickResult,
} from "../sdk/types.js";
import {
  SINGLE_SHOT_RECOVERY_CODES,
  decideSingleShotAttempt,
  planSingleShotRoundArtifacts,
  planSingleShotRoundCheckpoints,
  planSingleShotRoundPersistence,
  planSingleShotRoundStart,
  planSingleShotRoundStartedCheckpoint,
  resolveSingleShotRoundSelection,
  type PlanSingleShotRoundStartInput,
  type SingleShotDecision,
  type SingleShotExecutorFamily,
  type SingleShotAttemptOutcome,
  type SingleShotRoundArtifacts,
  type SingleShotRoundEvidence,
  type SingleShotRoundSelection,
  type SingleShotRecoveryCode,
} from "./executor.js";

export type AgentExecutorConfig = {
  harness?: string;
  model?: string;
  effort?: string;
};

/**
 * Portable intent accepted by the agent-once / script lifecycle class.
 * Executable paths, cwd, environment, credentials, and repo-lock hooks belong
 * in host bindings captured by the injected runner adapter.
 */
export type SingleShotExecutorConfig = {
  agent?: AgentExecutorConfig;
  timeoutMs?: number;
  policyEnvelope?: string;
  /** Portable script/tool identity; host bindings resolve it to an executable. */
  command?: string;
};

export type ScriptExecutorConfig = SingleShotExecutorConfig & {
  command: string;
  agent?: never;
};

export type AgentOnceExecutorConfig = Omit<
  SingleShotExecutorConfig,
  "command"
> & {
  command?: never;
};

export {
  SCRIPT_COMMAND_IDENTITY_PATTERN,
  isPortableScriptCommandIdentity,
} from "../sdk/portable-command.js";

export function singleShotExecutorConfigError(
  family: SingleShotExecutorFamily,
  value: unknown,
): string | null {
  if (!isRecord(value)) {
    return family === "script"
      ? "Script config requires a portable config.command identity."
      : "One-shot config must be an object.";
  }
  const allowed =
    family === "script"
      ? new Set(["command", "timeoutMs", "policyEnvelope"])
      : new Set(["agent", "timeoutMs", "policyEnvelope"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    return `${family} config does not allow property ${unknown}.`;
  }
  if (
    value["timeoutMs"] !== undefined &&
    (!Number.isInteger(value["timeoutMs"]) ||
      (value["timeoutMs"] as number) < 1)
  ) {
    return `${family} config.timeoutMs must be a positive integer.`;
  }
  if (
    value["timeoutMs"] !== undefined &&
    (value["timeoutMs"] as number) % 1_000 !== 0
  ) {
    return `${family} config.timeoutMs must be a whole number of seconds (a multiple of 1000).`;
  }
  if (
    value["timeoutMs"] !== undefined &&
    (value["timeoutMs"] as number) > MAX_BUILT_IN_PROCESS_TIMEOUT_MS
  ) {
    return `${family} config.timeoutMs must not exceed ${MAX_BUILT_IN_PROCESS_TIMEOUT_MS}.`;
  }
  if (
    value["policyEnvelope"] !== undefined &&
    (typeof value["policyEnvelope"] !== "string" ||
      value["policyEnvelope"].length === 0)
  ) {
    return `${family} config.policyEnvelope must be a non-empty string.`;
  }
  if (family === "script") {
    if (!isPortableScriptCommandIdentity(value["command"])) {
      return "Script config requires a portable config.command identity.";
    }
    return null;
  }
  if (value["agent"] === undefined) return null;
  if (!isRecord(value["agent"])) {
    return "One-shot config.agent must be an object.";
  }
  const unknownAgent = Object.keys(value["agent"]).find(
    (key) => !["harness", "model", "effort"].includes(key),
  );
  if (unknownAgent !== undefined) {
    return `One-shot config.agent does not allow property ${unknownAgent}.`;
  }
  for (const field of ["harness", "model", "effort"] as const) {
    const fieldValue = value["agent"][field];
    if (
      fieldValue !== undefined &&
      (typeof fieldValue !== "string" || fieldValue.length === 0)
    ) {
      return `One-shot config.agent.${field} must be a non-empty string.`;
    }
  }
  return null;
}

/** Host-owned round identity/runtime context. No database handle crosses here. */
export type SingleShotExecutorHostBindings = {
  start: Omit<PlanSingleShotRoundStartInput, "selection">;
  /** Host-resolved identity actually used for execution and durable reattachment. */
  selection?: SingleShotRoundSelection;
  /** Opaque digest of the resolved host command, argv, cwd, and environment. */
  hostBindingIdentity?: string;
  /** True only for the host call that atomically inserted this new round. */
  roundAlreadyMaterialized?: boolean;
  /** Host-resolved native runner for production registered dispatch. */
  runRound?: SingleShotRoundRunner;
  /** Release or retain repository ownership after durable mechanism evidence. */
  settleRepoOwnership?: (completionDurable: boolean) => void;
};

/** Normalized output of one bounded runner-adapter call. */
export type SingleShotRoundMechanismResult = {
  readonly outcome: SingleShotAttemptOutcome;
  readonly summary?: string;
  readonly result?: RunnerResult | null;
  readonly resultDigest?: string | null;
  readonly artifacts?: SingleShotRoundArtifacts;
  readonly evidence?: SingleShotRoundEvidence;
};

/**
 * Narrow extension point used by the agent-once and script lifecycle class.
 * The lifecycle runtime-normalizes the complete return before persisting any
 * adapter-produced artifacts, observations, or completion checkpoints.
 */
export type SingleShotRoundRunnerContext = {
  readonly config: Readonly<SingleShotExecutorConfig>;
  readonly hostBindings: Readonly<SingleShotExecutorHostBindings>;
  readonly signal: AbortSignal;
};

export type SingleShotRoundRunner = (
  round: ExecutorRoundRecord,
  context: SingleShotRoundRunnerContext,
) => SingleShotRoundMechanismResult | Promise<SingleShotRoundMechanismResult>;

/** Synchronous built-in mechanism shape; assignable to the public runner adapter. */
export type SynchronousSingleShotRoundRunner = (
  round: ExecutorRoundRecord,
  context?: SingleShotRoundRunnerContext,
) => SingleShotRoundMechanismResult;

/** Built-ins stay directly testable synchronously while using async supervision through the SDK. */
export interface HybridSingleShotRoundRunner {
  (round: ExecutorRoundRecord): SingleShotRoundMechanismResult;
  (
    round: ExecutorRoundRecord,
    context: SingleShotRoundRunnerContext,
  ): SingleShotRoundMechanismResult | Promise<SingleShotRoundMechanismResult>;
}

const AGENT_CONFIG_SCHEMA = {
  type: "object",
  description:
    "Portable agent selection; executable and credentials are host bindings.",
  properties: {
    harness: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    effort: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export const AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA = {
  type: "object",
  description: "Portable configuration for one bounded agent turn.",
  properties: {
    agent: AGENT_CONFIG_SCHEMA,
    timeoutMs: {
      type: "integer",
      minimum: 1_000,
      maximum: MAX_BUILT_IN_PROCESS_TIMEOUT_MS,
      multipleOf: 1_000,
    },
    policyEnvelope: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

export const SCRIPT_EXECUTOR_CONFIG_SCHEMA = {
  type: "object",
  description: "Portable configuration for one deterministic script turn.",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      pattern: SCRIPT_COMMAND_IDENTITY_PATTERN,
      description:
        "Portable command identity; the host resolves the executable path.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1_000,
      maximum: MAX_BUILT_IN_PROCESS_TIMEOUT_MS,
      multipleOf: 1_000,
    },
    policyEnvelope: { type: "string", minLength: 1 },
  },
  required: ["command"],
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

export type SingleShotExecutorTickResult = ExecutorTickResult & {
  readonly decision: SingleShotDecision;
  readonly artifacts: readonly ExecutorArtifactRecord[];
  /** Checkpoints recorded during the executor tick, before daemon classification. */
  readonly checkpoints: readonly ExecutorCheckpointRecord[];
  /** Host commits this atomically with its classification decision. */
  readonly classificationCheckpoint: ExecutorCheckpointRecord;
};

/**
 * Extensible lifecycle class for the built-in `one-shot` and `script` families.
 * Supplying a {@link SingleShotRoundRunner} is the narrower runner-adapter
 * extension point; implementing {@link Executor} directly remains the full SDK.
 */
export class SingleShotExecutor implements Executor<
  SingleShotExecutorConfig,
  SingleShotExecutorHostBindings
> {
  readonly name: SingleShotExecutorFamily;
  readonly configSchema: ExecutorConfigSchema;
  readonly #runRound: SingleShotRoundRunner;

  constructor(
    family: SingleShotExecutorFamily,
    runRound: SingleShotRoundRunner,
  ) {
    this.name = family;
    this.configSchema =
      family === "one-shot"
        ? AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA
        : SCRIPT_EXECUTOR_CONFIG_SCHEMA;
    this.#runRound = runRound;
  }

  async tick(
    context: ExecutorTickContext<
      SingleShotExecutorConfig,
      SingleShotExecutorHostBindings
    >,
  ): Promise<SingleShotExecutorTickResult> {
    const attempt = context.state.attempt;
    if (attempt.executorFamily !== this.name) {
      throw new Error(
        `SingleShotExecutor ${this.name} cannot run attempt ${attempt.attemptId} for ${attempt.executorFamily}.`,
      );
    }
    const configError = singleShotExecutorConfigError(
      this.name,
      context.config,
    );
    if (configError !== null) throw new Error(configError);
    const config = immutableSingleShotConfig(context.config);
    const hostBindings = immutableSingleShotHostBindings(context.hostBindings);
    const currentAttemptRounds = context.state.rounds.filter(
      (snapshot) =>
        snapshot.round.attemptNumber === context.state.attempt.attemptNumber,
    );
    if (
      currentAttemptRounds.length > 0 &&
      hostBindings.roundAlreadyMaterialized !== true
    ) {
      try {
        const resumed = resumeCompletedSingleShotRound(this.name, {
          ...context,
          config,
          hostBindings,
        });
        hostBindings.settleRepoOwnership?.(true);
        return resumed;
      } catch (error) {
        hostBindings.settleRepoOwnership?.(false);
        throw error;
      }
    }

    const selection =
      hostBindings.selection ?? singleShotSelectionFromSdkConfig(config);
    const start = planSingleShotRoundStart({
      ...hostBindings.start,
      family: this.name,
      selection,
    });
    const frozenLogPaths = [...start.logPaths];
    const dispatchBinding = singleShotDispatchBindingDetail(
      this.name,
      config,
      hostBindings.start,
      selection,
      hostBindings.hostBindingIdentity,
    );
    const materialized =
      hostBindings.roundAlreadyMaterialized === true
        ? loadMaterializedSingleShotRound(this.name, dispatchBinding, {
            ...context,
            config,
            hostBindings,
          })
        : undefined;
    const durableStart =
      materialized?.round ??
      context.envelope.startRound(roundStartForSdk(start));
    const roundId = durableStart.roundId;
    const roundStartedCheckpoint =
      materialized?.checkpoint ??
      context.envelope.recordCheckpoint(
        roundId,
        withoutRoundId(
          planSingleShotRoundStartedCheckpoint(roundId, dispatchBinding),
        ),
      );
    let completionDurable = false;
    try {
      context.signal.throwIfAborted();

      const mechanism = normalizeSingleShotMechanismResult(
        this.name,
        await this.#runRound(cloneRoundForRunner(durableStart), {
          config,
          hostBindings,
          signal: context.signal,
        }),
      );

      // Validate the complete persistence plan before appending artifacts. This
      // preserves the existing all-or-nothing guard for malformed terminal
      // evidence even though classification is now host-owned.
      const plan = planSingleShotRoundPersistence({
        outcome: mechanism.outcome,
        ...(mechanism.result !== undefined ? { result: mechanism.result } : {}),
        ...(mechanism.resultDigest !== undefined
          ? { resultDigest: mechanism.resultDigest }
          : {}),
        ...(mechanism.evidence !== undefined
          ? { evidence: mechanism.evidence }
          : {}),
      });

      const artifacts = planSingleShotRoundArtifacts({
        roundId,
        logPaths: frozenLogPaths,
        ...(mechanism.artifacts !== undefined
          ? { artifacts: mechanism.artifacts }
          : {}),
      }).map((artifact) =>
        context.envelope.recordArtifact(roundId, withoutRoundId(artifact)),
      );

      const checkpointPlan = planSingleShotRoundCheckpoints({
        roundId,
        outcome: mechanism.outcome,
        capturedResult: mechanism.outcome.ok && mechanism.result != null,
        classification: plan.decision.classification,
      });
      const classificationCheckpoint = checkpointPlan.at(-1);
      if (classificationCheckpoint === undefined) {
        throw new Error(
          "Single-shot checkpoint plan omitted daemon classification.",
        );
      }
      const progress = context.envelope.recordRoundProgress(roundId, {
        // Capture result and repo-safety evidence, but deliberately omit terminal
        // state, classification, recovery gate, and recommendation. Those fields
        // are available only to the daemon controller after this tick returns.
        observation: {
          ...observationFromPersistencePlan(
            plan.captureUpdate,
            plan.terminalUpdate,
          ),
          ...(mechanism.summary !== undefined
            ? { summary: mechanism.summary }
            : {}),
        },
        // The mechanism-completed proof and any result-capture checkpoint commit
        // with that observation. A restart can therefore either classify the
        // completed turn or see no completion proof; it never sees a torn pair.
        checkpoints: checkpointPlan
          .slice(1, -1)
          .map((checkpoint) => withoutRoundId(checkpoint)),
      });
      const checkpoints = [roundStartedCheckpoint, ...progress.checkpoints];
      completionDurable = true;

      return {
        roundId,
        recommendation: plan.decision.classification,
        recommendedRoundState: plan.decision.roundState,
        recommendedAttemptState: plan.decision.attemptState,
        recoveryCode: plan.decision.recoveryCode,
        humanGate: plan.decision.humanGate,
        reason: plan.decision.reason,
        decision: plan.decision,
        artifacts,
        checkpoints,
        classificationCheckpoint,
      };
    } finally {
      hostBindings.settleRepoOwnership?.(completionDurable);
    }
  }
}

function loadMaterializedSingleShotRound(
  family: SingleShotExecutorFamily,
  dispatchBinding: string,
  context: ExecutorTickContext<
    SingleShotExecutorConfig,
    SingleShotExecutorHostBindings
  >,
): { round: ExecutorRoundView; checkpoint: ExecutorCheckpointRecord } {
  const currentAttemptRounds = context.state.rounds.filter(
    (snapshot) =>
      snapshot.round.attemptNumber === context.state.attempt.attemptNumber,
  );
  if (currentAttemptRounds.length !== 1) {
    throw new Error(
      `SingleShotExecutor ${family} expected exactly one atomically materialized round.`,
    );
  }
  const snapshot = currentAttemptRounds[0];
  if (snapshot === undefined) {
    throw new Error("Single-shot materialized round snapshot is missing.");
  }
  if (
    snapshot.artifacts.length > 0 ||
    snapshot.checkpoints.length !== 1 ||
    snapshot.findings.length > 0 ||
    snapshot.decisions.length > 0
  ) {
    throw new Error(
      `Single-shot round ${snapshot.round.roundId} does not contain exactly its atomically materialized dispatch binding.`,
    );
  }
  if (
    snapshot.round.state !== "running" ||
    snapshot.round.classification !== null
  ) {
    throw new Error(
      `Single-shot round ${snapshot.round.roundId} is not a fresh running round.`,
    );
  }
  assertSingleShotRoundMatchesHost(family, context, snapshot.round);
  const expectedCheckpoint = planSingleShotRoundStartedCheckpoint(
    snapshot.round.roundId,
    dispatchBinding,
  );
  const checkpoint = snapshot.checkpoints[0];
  if (
    checkpoint === undefined ||
    !isAllocatedCheckpointIdentity(
      checkpoint.checkpointId,
      expectedCheckpoint.checkpointId,
    ) ||
    checkpoint.sequence !== expectedCheckpoint.sequence ||
    checkpoint.stage !== expectedCheckpoint.stage ||
    checkpoint.detail !== expectedCheckpoint.detail
  ) {
    throw new Error(
      `Single-shot round ${snapshot.round.roundId} has an invalid atomically materialized dispatch binding.`,
    );
  }
  return { round: snapshot.round, checkpoint };
}

function isAllocatedCheckpointIdentity(
  checkpointId: string,
  canonicalCheckpointId: string,
): boolean {
  if (checkpointId === canonicalCheckpointId) return true;
  const allocatedPrefix = `${canonicalCheckpointId}::allocated-`;
  return (
    checkpointId.startsWith(allocatedPrefix) &&
    /^[1-9]\d*$/.test(checkpointId.slice(allocatedPrefix.length))
  );
}

const SINGLE_SHOT_RECOVERY_CODE_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_RECOVERY_CODES,
);

function resumeCompletedSingleShotRound(
  family: SingleShotExecutorFamily,
  context: ExecutorTickContext<
    SingleShotExecutorConfig,
    SingleShotExecutorHostBindings
  >,
): SingleShotExecutorTickResult {
  const currentAttemptRounds = context.state.rounds.filter(
    (snapshot) =>
      snapshot.round.attemptNumber === context.state.attempt.attemptNumber,
  );
  if (currentAttemptRounds.length !== 1) {
    throw new Error(
      `SingleShotExecutor ${family} attempt ${context.state.attempt.attemptId} must own exactly one resumable round.`,
    );
  }
  const snapshot = currentAttemptRounds[0];
  if (snapshot === undefined) {
    throw new Error("Single-shot resumable round snapshot is missing.");
  }
  const round = snapshot.round;
  if (round.roundId !== context.hostBindings.start.roundId) {
    throw new Error(
      `Single-shot resumable round ${round.roundId} does not match host round ${context.hostBindings.start.roundId}.`,
    );
  }
  assertSingleShotRoundMatchesHost(family, context, round);
  assertResumableDispatchBinding(family, context, round, snapshot.checkpoints);
  if (round.classification !== null || isTerminalRoundState(round.state)) {
    throw new Error(
      `Single-shot round ${round.roundId} is already terminal and cannot resume classification.`,
    );
  }
  const mechanismCheckpoint = [...snapshot.checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.stage === "mechanism_completed");
  if (
    mechanismCheckpoint?.detail === null ||
    mechanismCheckpoint === undefined
  ) {
    throw new Error(
      `Single-shot round ${round.roundId} has no durable mechanism_completed outcome to classify.`,
    );
  }
  const outcome = singleShotOutcomeFromCheckpoint(mechanismCheckpoint.detail);
  if (outcome.ok && round.state !== "capturing_result") {
    throw new Error(
      `Single-shot successful round ${round.roundId} has not durably captured its result.`,
    );
  }
  const decision = decideSingleShotAttempt(outcome);
  const sequence =
    Math.max(-1, ...snapshot.checkpoints.map((item) => item.sequence)) + 1;
  return {
    roundId: round.roundId,
    recommendation: decision.classification,
    recommendedRoundState: decision.roundState,
    recommendedAttemptState: decision.attemptState,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    reason: decision.reason,
    decision,
    artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
    checkpoints: snapshot.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    classificationCheckpoint: {
      checkpointId: `${round.roundId}-checkpoint-${sequence}`,
      roundId: round.roundId,
      sequence,
      stage: "classified",
      detail: `classification: ${decision.classification}`,
    },
  };
}

function assertSingleShotRoundMatchesHost(
  family: SingleShotExecutorFamily,
  context: ExecutorTickContext<
    SingleShotExecutorConfig,
    SingleShotExecutorHostBindings
  >,
  round: ExecutorRoundView,
): void {
  const host = context.hostBindings.start;
  const mismatches: string[] = [];
  const expected = {
    attemptId: host.attemptId,
    workflowRunId: host.workflowRunId,
    stepRunId: host.stepRunId,
    stepKey: host.stepKey,
    executorFamily: family,
    attemptNumber: host.attemptNumber,
    inputDigest: host.inputDigest,
    artifactRoot: host.artifactRoot,
  } as const;
  for (const [field, value] of Object.entries(expected)) {
    if (round[field as keyof typeof round] !== value) mismatches.push(field);
  }
  if (!sameStringArray(round.logPaths, host.logPaths ?? [])) {
    mismatches.push("logPaths");
  }
  const selection =
    context.hostBindings.selection ??
    singleShotSelectionFromSdkConfig(context.config);
  if (round.agentProvider !== selection.agentProvider)
    mismatches.push("agentProvider");
  if (round.model !== selection.model) mismatches.push("model");
  if (round.effort !== selection.effort) mismatches.push("effort");
  if (mismatches.length > 0) {
    throw new Error(
      `Single-shot round ${round.roundId} cannot reattach with changed dispatch inputs: ${mismatches.join(", ")}.`,
    );
  }
}

function assertResumableDispatchBinding(
  family: SingleShotExecutorFamily,
  context: ExecutorTickContext<
    SingleShotExecutorConfig,
    SingleShotExecutorHostBindings
  >,
  round: ExecutorRoundView,
  checkpoints: readonly Readonly<ExecutorCheckpointRecord>[],
): void {
  const host = context.hostBindings.start;
  const bindingCheckpoint = checkpoints.find(
    (checkpoint) => checkpoint.stage === "round_started",
  );
  const expectedBinding = singleShotDispatchBindingDetail(
    family,
    context.config,
    host,
    context.hostBindings.selection,
    context.hostBindings.hostBindingIdentity,
  );
  const legacyBinding = legacySingleShotDispatchBindingDetail(
    family,
    context.config,
    host,
  );
  const replayAttemptNumber = executorRoundReplayAttemptNumber(round);
  const replayBinding = singleShotDispatchBindingDetailForAttempt(
    family,
    context.config,
    host,
    context.hostBindings.selection,
    context.hostBindings.hostBindingIdentity,
    replayAttemptNumber,
  );
  const legacyReplayBinding = legacySingleShotDispatchBindingDetailForAttempt(
    family,
    context.config,
    host,
    replayAttemptNumber,
  );
  if (
    bindingCheckpoint?.detail !== expectedBinding &&
    bindingCheckpoint?.detail !== legacyBinding &&
    bindingCheckpoint?.detail !== replayBinding &&
    bindingCheckpoint?.detail !== legacyReplayBinding
  ) {
    throw new Error(
      `Single-shot round ${round.roundId} cannot reattach with changed portable config or host inputs.`,
    );
  }
}

export function singleShotDispatchBindingDetail(
  family: SingleShotExecutorFamily,
  config: Readonly<SingleShotExecutorConfig>,
  start: SingleShotExecutorHostBindings["start"],
  selection?: Readonly<SingleShotRoundSelection>,
  hostBindingIdentity?: string,
): string {
  return singleShotDispatchBindingDetailForAttempt(
    family,
    config,
    start,
    selection,
    hostBindingIdentity,
    start.attemptNumber,
  );
}

function singleShotDispatchBindingDetailForAttempt(
  family: SingleShotExecutorFamily,
  config: Readonly<SingleShotExecutorConfig>,
  start: SingleShotExecutorHostBindings["start"],
  selection: Readonly<SingleShotRoundSelection> | undefined,
  hostBindingIdentity: string | undefined,
  attemptNumber: number,
): string {
  const payload = canonicalJson({
    version: 2,
    family,
    config,
    selection: selection ?? singleShotSelectionFromSdkConfig(config),
    hostBindingIdentity: hostBindingIdentity ?? null,
    start: {
      // Frozen digest schema: the payload keys keep their pre-attempt-model
      // wire names so binding digests recorded before the migration keep
      // verifying. The keys never leave this hash.
      roundId: start.roundId,
      invocationId: start.attemptId,
      workflowRunId: start.workflowRunId,
      stepRunId: start.stepRunId,
      stepKey: start.stepKey,
      family: start.family,
      attempt: attemptNumber,
      inputDigest: start.inputDigest,
      artifactRoot: start.artifactRoot,
      logPaths: start.logPaths ?? [],
    },
  });
  return `dispatch binding v2: sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

function legacySingleShotDispatchBindingDetail(
  family: SingleShotExecutorFamily,
  config: Readonly<SingleShotExecutorConfig>,
  start: SingleShotExecutorHostBindings["start"],
): string {
  return legacySingleShotDispatchBindingDetailForAttempt(
    family,
    config,
    start,
    start.attemptNumber,
  );
}

function legacySingleShotDispatchBindingDetailForAttempt(
  family: SingleShotExecutorFamily,
  config: Readonly<SingleShotExecutorConfig>,
  start: SingleShotExecutorHostBindings["start"],
  attemptNumber: number,
): string {
  const payload = canonicalJson({
    family,
    config,
    start: {
      // Frozen digest schema: the payload keys keep their pre-attempt-model
      // wire names so binding digests recorded before the migration keep
      // verifying. The keys never leave this hash.
      roundId: start.roundId,
      invocationId: start.attemptId,
      workflowRunId: start.workflowRunId,
      stepRunId: start.stepRunId,
      stepKey: start.stepKey,
      family: start.family,
      attempt: attemptNumber,
      inputDigest: start.inputDigest,
      artifactRoot: start.artifactRoot,
      logPaths: start.logPaths ?? [],
    },
  });
  return `dispatch binding: sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function immutableSingleShotConfig(
  config: Readonly<SingleShotExecutorConfig>,
): Readonly<SingleShotExecutorConfig> {
  const agent = config.agent === undefined ? undefined : { ...config.agent };
  if (agent !== undefined) Object.freeze(agent);
  return Object.freeze({
    ...config,
    ...(agent !== undefined ? { agent } : {}),
  });
}

function immutableSingleShotHostBindings(
  hostBindings: Readonly<SingleShotExecutorHostBindings>,
): Readonly<SingleShotExecutorHostBindings> {
  const logPaths =
    hostBindings.start.logPaths === undefined
      ? undefined
      : [...hostBindings.start.logPaths];
  if (logPaths !== undefined) Object.freeze(logPaths);
  const start = {
    ...hostBindings.start,
    ...(logPaths !== undefined ? { logPaths } : {}),
  };
  const selection =
    hostBindings.selection === undefined
      ? undefined
      : {
          ...hostBindings.selection,
          source: { ...hostBindings.selection.source },
        };
  Object.freeze(start);
  if (selection !== undefined) {
    Object.freeze(selection.source);
    Object.freeze(selection);
  }
  return Object.freeze({
    ...hostBindings,
    start,
    ...(selection !== undefined ? { selection } : {}),
  });
}

function singleShotOutcomeFromCheckpoint(
  detail: string,
): SingleShotAttemptOutcome {
  const prefix = "attempt outcome: ";
  // Legacy reader: `mechanism_completed` checkpoints recorded before the
  // attempt/round migration carry the historical prefix, and the migration
  // preserves checkpoint details verbatim. New checkpoints emit only the
  // attempt-vocabulary prefix.
  const legacyPrefix = "invocation outcome: ";
  const matchedPrefix = detail.startsWith(prefix)
    ? prefix
    : detail.startsWith(legacyPrefix)
      ? legacyPrefix
      : undefined;
  if (matchedPrefix === undefined) {
    throw new Error(`Invalid mechanism_completed checkpoint detail: ${detail}`);
  }
  const value = detail.slice(matchedPrefix.length);
  if (value === "ok") return { ok: true };
  if (!SINGLE_SHOT_RECOVERY_CODE_SET.has(value)) {
    throw new Error(`Unknown durable single-shot recovery code: ${value}`);
  }
  return { ok: false, recoveryCode: value as SingleShotRecoveryCode };
}

function isTerminalRoundState(state: ExecutorRoundRecord["state"]): boolean {
  return !EXECUTOR_OBSERVATION_PHASES.includes(
    state as (typeof EXECUTOR_OBSERVATION_PHASES)[number],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Map the existing resolved selection into portable SDK config for the built-in. */
export function singleShotSdkConfigFromSelection(
  family: SingleShotExecutorFamily,
  selection: SingleShotRoundSelection,
): SingleShotExecutorConfig {
  const config: SingleShotExecutorConfig = {};
  if (family === "one-shot") {
    const agent: AgentExecutorConfig = {};
    if (selection.agentProvider !== null)
      agent.harness = selection.agentProvider;
    if (selection.model !== null) agent.model = selection.model;
    if (selection.effort !== null) agent.effort = selection.effort;
    if (Object.keys(agent).length > 0) config.agent = agent;
  }
  if (selection.timeoutMs !== null) config.timeoutMs = selection.timeoutMs;
  if (selection.policyEnvelope !== null) {
    config.policyEnvelope = selection.policyEnvelope;
  }
  return config;
}

export function singleShotSelectionFromSdkConfig(
  config: Readonly<SingleShotExecutorConfig>,
): SingleShotRoundSelection {
  const stepConfig = {
    ...(config.agent?.harness !== undefined
      ? { agentProvider: config.agent.harness }
      : {}),
    ...(config.agent?.model !== undefined ? { model: config.agent.model } : {}),
    ...(config.agent?.effort !== undefined
      ? { effort: config.agent.effort }
      : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.policyEnvelope !== undefined
      ? { policyEnvelope: config.policyEnvelope }
      : {}),
  };
  return resolveSingleShotRoundSelection({ stepConfig });
}

function normalizeSingleShotMechanismResult(
  family: SingleShotExecutorFamily,
  mechanism: unknown,
): SingleShotRoundMechanismResult {
  if (!isRecord(mechanism)) {
    throw new Error(`Invalid ${family} mechanism output: expected an object.`);
  }
  const outcome = mechanism["outcome"];
  if (!isRecord(outcome) || typeof outcome["ok"] !== "boolean") {
    throw new Error(
      `Invalid ${family} mechanism output: outcome.ok must be a boolean.`,
    );
  }
  if (
    outcome["ok"] === false &&
    (typeof outcome["recoveryCode"] !== "string" ||
      !SINGLE_SHOT_RECOVERY_CODE_SET.has(outcome["recoveryCode"]))
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: failed outcomes require a known recoveryCode.`,
    );
  }
  if (outcome["ok"] === true && outcome["recoveryCode"] !== undefined) {
    throw new Error(
      `Invalid ${family} mechanism output: successful outcomes must not carry recoveryCode.`,
    );
  }
  const normalizedOutcome: SingleShotAttemptOutcome =
    outcome["ok"] === true
      ? { ok: true }
      : {
          ok: false,
          recoveryCode: outcome["recoveryCode"] as SingleShotRecoveryCode,
        };
  const result = mechanism["result"];
  const resultDigest = mechanism["resultDigest"];
  const summary = mechanism["summary"];
  if (
    summary !== undefined &&
    (typeof summary !== "string" || summary.trim().length === 0)
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: summary must be a non-empty string.`,
    );
  }
  if (
    resultDigest !== undefined &&
    resultDigest !== null &&
    (typeof resultDigest !== "string" || resultDigest.length === 0)
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: resultDigest must be a non-empty string or null.`,
    );
  }
  const artifacts = normalizeSingleShotArtifacts(
    family,
    mechanism["artifacts"],
  );
  const evidence = normalizeSingleShotEvidence(family, mechanism["evidence"]);
  if (mechanism.resultDigest != null && mechanism.result == null) {
    throw new Error(
      `Invalid ${family} mechanism output: resultDigest requires a result document.`,
    );
  }
  if (family === "script" && result != null) {
    throw new Error(
      "Invalid script mechanism output: script rounds must not capture a result document.",
    );
  }
  if (family === "script" && artifacts?.resultDocument != null) {
    throw new Error(
      "Invalid script mechanism output: script rounds must not report a result document artifact.",
    );
  }
  let normalizedResult: RunnerResult | null | undefined;
  if (result === null) normalizedResult = null;
  if (family === "one-shot" && result !== undefined && result !== null) {
    const normalized = normalizeRunnerResult(result);
    if (!normalized.ok) {
      throw new Error(`Invalid one-shot mechanism output: ${normalized.error}`);
    }
    normalizedResult = normalized.value;
  }
  const normalizedMechanism: SingleShotRoundMechanismResult = {
    outcome: normalizedOutcome,
    ...(summary !== undefined ? { summary: summary as string } : {}),
    ...(normalizedResult !== undefined ? { result: normalizedResult } : {}),
    ...(resultDigest !== undefined
      ? { resultDigest: resultDigest as string | null }
      : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
  if (!normalizedOutcome.ok) return normalizedMechanism;
  if (family === "one-shot") {
    if (result == null) {
      throw new Error(
        "Invalid one-shot mechanism output: successful rounds require a result document.",
      );
    }
    if (normalizedResult?.success !== true) {
      throw new Error(
        "Invalid one-shot mechanism output: successful one-shot rounds require a successful result document.",
      );
    }
    return normalizedMechanism;
  }
  return normalizedMechanism;
}

function normalizeSingleShotArtifacts(
  family: SingleShotExecutorFamily,
  value: unknown,
): SingleShotRoundArtifacts | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(
      `Invalid ${family} mechanism output: artifacts must be an object.`,
    );
  }
  const normalized: SingleShotRoundArtifacts = {};
  for (const field of [
    "resultDocument",
    "checkpointStream",
    "verificationOutput",
    "commitOrResetEvidence",
    "recoveryNote",
  ] as const) {
    const pointer = value[field];
    if (pointer === undefined || pointer === null) continue;
    if (
      !isRecord(pointer) ||
      typeof pointer["path"] !== "string" ||
      pointer["path"].trim().length === 0
    ) {
      throw new Error(
        `Invalid ${family} mechanism output: artifacts.${field}.path must be a non-empty string.`,
      );
    }
    for (const optional of ["digest", "description"] as const) {
      if (
        pointer[optional] !== undefined &&
        pointer[optional] !== null &&
        typeof pointer[optional] !== "string"
      ) {
        throw new Error(
          `Invalid ${family} mechanism output: artifacts.${field}.${optional} must be a string or null.`,
        );
      }
    }
    normalized[field] = {
      path: pointer["path"],
      ...(pointer["digest"] !== undefined
        ? { digest: pointer["digest"] as string | null }
        : {}),
      ...(pointer["description"] !== undefined
        ? { description: pointer["description"] as string | null }
        : {}),
    };
  }
  return normalized;
}

function normalizeSingleShotEvidence(
  family: SingleShotExecutorFamily,
  value: unknown,
): SingleShotRoundEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(
      `Invalid ${family} mechanism output: evidence must be an object.`,
    );
  }
  const verificationStatus = value["verificationStatus"];
  if (
    verificationStatus !== undefined &&
    verificationStatus !== null &&
    !["passed", "failed", "skipped"].includes(verificationStatus as string)
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: evidence.verificationStatus is invalid.`,
    );
  }
  const commitSha = value["commitSha"];
  if (
    commitSha !== undefined &&
    commitSha !== null &&
    typeof commitSha !== "string"
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: evidence.commitSha must be a string or null.`,
    );
  }
  const changedFiles = value["changedFiles"];
  if (
    changedFiles !== undefined &&
    (!Array.isArray(changedFiles) ||
      changedFiles.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(
      `Invalid ${family} mechanism output: evidence.changedFiles must be an array of strings.`,
    );
  }
  return {
    ...(verificationStatus !== undefined
      ? {
          verificationStatus: verificationStatus as
            "passed" | "failed" | "skipped" | null,
        }
      : {}),
    ...(commitSha !== undefined
      ? { commitSha: commitSha as string | null }
      : {}),
    ...(changedFiles !== undefined ? { changedFiles: [...changedFiles] } : {}),
  };
}

function observationFromPersistencePlan(
  capture: import("../loop/persist.js").ExecutorRoundUpdate | null,
  terminal: import("../loop/persist.js").ExecutorRoundUpdate,
): ExecutorRoundObservation {
  const phase =
    capture === null ? undefined : observationPhase(capture.toState);
  const observation: ExecutorRoundObservation = {
    ...(capture !== null ? observationFields(capture) : {}),
    ...observationFields(terminal),
    ...(phase !== undefined ? { phase } : {}),
  };
  return observation;
}

function observationPhase(
  state: import("../loop/reducer.js").ExecutorRoundState,
): ExecutorObservationPhase {
  if (!(EXECUTOR_OBSERVATION_PHASES as readonly string[]).includes(state)) {
    throw new Error(
      `Single-shot capture requested terminal observation phase ${state}.`,
    );
  }
  return state as ExecutorObservationPhase;
}

function observationFields(
  update: import("../loop/persist.js").ExecutorRoundUpdate,
): ExecutorRoundObservation {
  return {
    ...(update.agentProvider !== undefined
      ? { agentProvider: update.agentProvider }
      : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.effort !== undefined ? { effort: update.effort } : {}),
    ...(update.inputDigest !== undefined
      ? { inputDigest: update.inputDigest }
      : {}),
    ...(update.resultDigest !== undefined
      ? { resultDigest: update.resultDigest }
      : {}),
    ...(update.artifactRoot !== undefined
      ? { artifactRoot: update.artifactRoot }
      : {}),
    ...(update.logPaths !== undefined
      ? { logPaths: [...update.logPaths] }
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
          verificationResults: update.verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
    ...(update.commitSha !== undefined ? { commitSha: update.commitSha } : {}),
  };
}

function withoutRoundId<T extends { roundId: string }>(
  record: T,
): Omit<T, "roundId"> {
  const { roundId: _roundId, ...rest } = record;
  return rest;
}

function cloneRoundForRunner(round: ExecutorRoundView): ExecutorRoundRecord {
  const { verificationResults, ...record } = round;
  return {
    ...record,
    logPaths: [...round.logPaths],
    keyChanges: [...round.keyChanges],
    keyLearnings: [...round.keyLearnings],
    remainingWork: [...round.remainingWork],
    changedFiles: [...round.changedFiles],
    ...(verificationResults !== undefined
      ? {
          verificationResults: verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
  };
}

function roundStartForSdk(round: ExecutorRoundRecord): ExecutorRoundStart {
  const {
    classification: _classification,
    executorRecommendation: _executorRecommendation,
    startedAt: _startedAt,
    heartbeatAt: _heartbeatAt,
    finishedAt: _finishedAt,
    recoveryCode: _recoveryCode,
    humanGate: _humanGate,
    verificationResults,
    ...start
  } = round;
  return {
    ...start,
    state: observationPhase(start.state),
    ...(verificationResults !== undefined
      ? {
          verificationResults: verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
  };
}
