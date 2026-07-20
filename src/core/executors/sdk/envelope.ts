/** Durable implementation of the executor SDK envelope facade. */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorRound,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  listExecutorRoundsForStep,
  loadExecutorAttempt,
  loadExecutorRound,
  updateExecutorAttemptState,
  updateExecutorRound,
  type ExecutorRoundUpdate,
} from "../loop/persist.js";
import {
  EXECUTOR_ARTIFACT_CLASSES,
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
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorDecisionRecord,
  type ExecutorFindingRecord,
  type ExecutorAttemptRecord,
  type ExecutorRoundRecord,
} from "../loop/reducer.js";
import { EXECUTOR_OBSERVATION_PHASES } from "./types.js";
import type {
  ExecutorArtifactInput,
  ExecutorCheckpointInput,
  ExecutorDaemonDecision,
  ExecutorDecisionInput,
  ExecutorEnvelope,
  ExecutorEnvelopeSnapshot,
  ExecutorFindingInput,
  ExecutorRoundEnvelopeSnapshot,
  ExecutorRoundObservation,
  ExecutorRoundProgress,
  ExecutorRoundProgressResult,
  ExecutorRoundStart,
  ExecutorRoundView,
} from "./types.js";

export class ExecutorEnvelopeAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorEnvelopeAccessError";
  }
}

export type CreateDurableExecutorEnvelopeInput = {
  db: MomentumDb;
  attemptId: string;
  now?: () => number;
  /** Optional daemon-owned fencing check run inside every write transaction. */
  authorizeWrite?: () => void;
};

export type ApplyExecutorDaemonDecisionOptions =
  | {
      /** Daemon-authored checkpoint committed atomically with the classification. */
      classificationCheckpoint: ExecutorCheckpointInput;
      allocateClassificationCheckpointIdentity?: false;
    }
  | {
      /** Daemon-authored checkpoint whose identity is allocated inside the decision transaction. */
      classificationCheckpoint: Omit<
        ExecutorCheckpointInput,
        "checkpointId" | "sequence"
      >;
      allocateClassificationCheckpointIdentity: true;
    };

export type AppliedExecutorDaemonDecision = {
  round: ExecutorRoundRecord;
  attempt: ExecutorAttemptRecord;
  classificationCheckpoint: Readonly<ExecutorCheckpointRecord>;
};

/**
 * SQLite-backed controller bound to one attempt. Executor code receives the
 * separate capability-limited {@link facade}; daemon code retains this controller
 * to apply its own decision after the tick returns.
 */
export class DurableExecutorEnvelope {
  readonly #db: MomentumDb;
  readonly #attemptId: string;
  readonly #now: () => number;
  readonly #authorizeWrite: () => void;
  readonly facade: ExecutorEnvelope;

  constructor(input: CreateDurableExecutorEnvelopeInput) {
    this.#db = input.db;
    this.#attemptId = input.attemptId;
    this.#now = input.now ?? Date.now;
    this.#authorizeWrite = input.authorizeWrite ?? (() => undefined);
    this.#loadAttempt();
    const facade: ExecutorEnvelope = {
      snapshot: () => this.snapshot(),
      startRound: (record, initialCheckpoints) =>
        this.startRound(record, initialCheckpoints),
      observeRound: (roundId, observation) =>
        this.observeRound(roundId, observation),
      recordRoundProgress: (roundId, progress) =>
        this.recordRoundProgress(roundId, progress),
      heartbeat: () => this.heartbeat(),
      recordArtifact: (roundId, artifact) =>
        this.recordArtifact(roundId, artifact),
      recordCheckpoint: (roundId, checkpoint) =>
        this.recordCheckpoint(roundId, checkpoint),
      recordFinding: (roundId, finding) => this.recordFinding(roundId, finding),
      recordDecision: (roundId, decision) =>
        this.recordDecision(roundId, decision),
    };
    this.facade = Object.freeze(facade);
  }

  snapshot(): ExecutorEnvelopeSnapshot {
    return withSqliteTransaction(this.#db, "read", () =>
      this.#snapshotUnlocked(),
    );
  }

  #snapshotUnlocked(): ExecutorEnvelopeSnapshot {
    const attempt = cloneAttempt(this.#loadAttempt());
    // The read model deliberately spans every attempt of the step (ordered by
    // attempt number, then round index): retry evidence such as delegate
    // handoffs and prior-round learnings must stay visible to the executor.
    // Writes below stay bound to this envelope's single attempt.
    const rounds = this.#listStepRounds(attempt).map((round) =>
      this.#roundSnapshot(round),
    );
    return {
      attempt,
      rounds,
      currentRound: rounds.at(-1) ?? null,
    };
  }

  #listStepRounds(attempt: ExecutorAttemptRecord) {
    return listExecutorRoundsForStep(
      this.#db,
      attempt.workflowRunId,
      attempt.stepRunId,
    );
  }

  startRound(
    record: ExecutorRoundStart,
    initialCheckpoints: readonly ExecutorCheckpointInput[] = [],
  ): ExecutorRoundView {
    return withSqliteTransaction(this.#db, "write", () => {
      assertRoundStartInput(record);
      initialCheckpoints.forEach(assertCheckpointInput);
      const attempt = this.#loadAttempt();
      assertObservationPhase(record.state, `start round ${record.roundId}`);
      this.#assertRoundIdentity(record, attempt);
      this.#assertExecutorWritable(attempt, `start round ${record.roundId}`);
      const rounds = this.#listStepRounds(attempt);
      const previous = rounds.at(-1);
      if (
        previous !== undefined &&
        previous.attemptNumber === record.attemptNumber &&
        !isTerminalExecutorRoundState(previous.state)
      ) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot start round ${record.roundId}: previous round ${previous.roundId} is still active (${previous.state}).`,
        );
      }
      const expectedIndex = rounds.length;
      if (record.roundIndex !== expectedIndex) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot start round ${record.roundId}: expected roundIndex ${expectedIndex}, got ${record.roundIndex}.`,
        );
      }
      const now = this.#now();
      const durableRecord = roundRecordFromStart(record, now);
      const round = insertExecutorRound(this.#db, durableRecord, { now });
      for (const checkpoint of initialCheckpoints) {
        insertExecutorCheckpoint(
          this.#db,
          { ...checkpoint, roundId: round.roundId },
          { now },
        );
      }
      return cloneRound(round);
    });
  }

  observeRound(
    roundId: string,
    observation: ExecutorRoundObservation,
  ): ExecutorRoundView {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertRoundObservationInput(observation);
      const attempt = this.#loadAttempt();
      this.#assertExecutorWritable(attempt, `observe round ${roundId}`);
      const current = this.#loadOwnedRound(roundId);
      if (isTerminalExecutorRoundState(current.state)) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot observe terminal round ${roundId} (${current.state}).`,
        );
      }
      const phase = observation.phase ?? current.state;
      assertObservationPhase(phase, `observe round ${roundId}`);
      const update: ExecutorRoundUpdate = {
        toState: phase,
        heartbeatAt: this.#now(),
        ...copyObservation(observation),
      };
      return cloneRound(updateExecutorRound(this.#db, roundId, update));
    });
  }

  recordRoundProgress(
    roundId: string,
    progress: ExecutorRoundProgress,
  ): ExecutorRoundProgressResult {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertRecord(progress, "round progress");
      assertRoundObservationInput(progress.observation);
      if (!Array.isArray(progress.checkpoints)) {
        invalidInput("round progress checkpoints must be an array");
      }
      progress.checkpoints.forEach(assertCheckpointInput);
      const round = this.observeRound(roundId, progress.observation);
      const checkpoints = progress.checkpoints.map((checkpoint) =>
        this.recordCheckpoint(roundId, checkpoint),
      );
      return { round, checkpoints };
    });
  }

  heartbeat(): ExecutorEnvelopeSnapshot {
    return withSqliteTransaction(this.#db, "write", () => {
      const now = this.#now();
      const attempt = this.#loadAttempt();
      this.#assertExecutorWritable(attempt, "heartbeat attempt");
      updateExecutorAttemptState(this.#db, this.#attemptId, attempt.state, {
        heartbeatAt: now,
        now,
      });
      const current = this.#listStepRounds(attempt).at(-1);
      if (
        current !== undefined &&
        current.attemptId === this.#attemptId &&
        !isTerminalExecutorRoundState(current.state)
      ) {
        updateExecutorRound(
          this.#db,
          current.roundId,
          { toState: current.state, heartbeatAt: now },
          { now },
        );
      }
      return this.#snapshotUnlocked();
    });
  }

  recordArtifact(
    roundId: string,
    artifact: ExecutorArtifactInput,
  ): Readonly<ExecutorArtifactRecord> {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertArtifactInput(artifact);
      this.#assertEvidenceWritable(roundId);
      return {
        ...insertExecutorArtifact(
          this.#db,
          { ...artifact, roundId },
          { now: this.#now() },
        ),
      };
    });
  }

  recordCheckpoint(
    roundId: string,
    checkpoint: ExecutorCheckpointInput,
  ): Readonly<ExecutorCheckpointRecord> {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertCheckpointInput(checkpoint);
      this.#assertEvidenceWritable(roundId);
      return {
        ...insertExecutorCheckpoint(
          this.#db,
          { ...checkpoint, roundId },
          { now: this.#now() },
        ),
      };
    });
  }

  recordFinding(
    roundId: string,
    finding: ExecutorFindingInput,
  ): Readonly<ExecutorFindingRecord> {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertFindingInput(finding);
      this.#assertEvidenceWritable(roundId);
      return {
        ...insertExecutorFinding(
          this.#db,
          { ...finding, roundId },
          { now: this.#now() },
        ),
      };
    });
  }

  recordDecision(
    roundId: string,
    decision: ExecutorDecisionInput,
  ): Readonly<ExecutorDecisionRecord> {
    return withSqliteTransaction(this.#db, "write", () => {
      assertNonEmptyString(roundId, "round id");
      assertDecisionInput(decision);
      this.#assertEvidenceWritable(roundId);
      return {
        ...insertExecutorDecision(
          this.#db,
          { ...decision, roundId },
          { now: this.#now() },
        ),
      };
    });
  }

  /** Apply a host/daemon decision. This method is never part of {@link facade}. */
  applyDaemonDecision(
    decision: ExecutorDaemonDecision,
    options: ApplyExecutorDaemonDecisionOptions,
  ): AppliedExecutorDaemonDecision {
    return withSqliteTransaction(this.#db, "write", () => {
      this.#authorizeWrite();
      assertDaemonDecisionInput(decision);
      const currentInvocation = this.#loadAttempt();
      this.#assertAttemptUnsettled(
        currentInvocation,
        `classify round ${decision.roundId}`,
      );
      const currentRound = this.#loadOwnedRound(decision.roundId);
      if (isTerminalExecutorRoundState(currentRound.state)) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot reclassify terminal round ${decision.roundId} (${currentRound.state}).`,
        );
      }
      const expectedInvocationState = executorAttemptStateForClassification(
        decision.classification,
      );
      if (decision.attemptState !== expectedInvocationState) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot classify round ${decision.roundId} as ${decision.classification}: expected attempt state ${expectedInvocationState}, got ${decision.attemptState}.`,
        );
      }
      if (
        !isExecutorRoundStateCompatibleWithClassification(
          decision.classification,
          decision.roundState,
        )
      ) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot classify round ${decision.roundId} as ${decision.classification}: incompatible round state ${decision.roundState}.`,
        );
      }
      if (
        !isExecutorRecoveryCodeCompatibleWithClassification(
          decision.classification,
          decision.recoveryCode,
        )
      ) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot classify round ${decision.roundId} as ${decision.classification}: incompatible recovery code ${String(decision.recoveryCode)}.`,
        );
      }
      if (
        !isExecutorHumanGateCompatibleWithClassification(
          decision.classification,
          decision.humanGate,
        )
      ) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot classify round ${decision.roundId} as ${decision.classification}: incompatible human gate ${String(decision.humanGate)}.`,
        );
      }
      const now = this.#now();
      const round = updateExecutorRound(
        this.#db,
        decision.roundId,
        {
          toState: decision.roundState,
          classification: decision.classification,
          executorRecommendation: decision.executorRecommendation,
          recoveryCode: decision.recoveryCode,
          humanGate: decision.humanGate,
          heartbeatAt: now,
          finishedAt: isTerminalExecutorRoundState(decision.roundState)
            ? now
            : null,
        },
        { now },
      );

      const attempt = updateExecutorAttemptState(
        this.#db,
        this.#attemptId,
        decision.attemptState,
        {
          heartbeatAt: now,
          finishedAt: isTerminalExecutorAttemptState(decision.attemptState)
            ? now
            : null,
          now,
        },
      );
      const checkpointIdentity =
        options.allocateClassificationCheckpointIdentity === true
          ? allocateCheckpointIdentity(this.#db, decision.roundId)
          : {
              checkpointId: options.classificationCheckpoint.checkpointId,
              sequence: options.classificationCheckpoint.sequence,
            };
      const checkpoint = {
        ...options.classificationCheckpoint,
        ...checkpointIdentity,
        roundId: decision.roundId,
      };
      assertCheckpointInput(checkpoint);
      const classificationCheckpoint = {
        ...insertExecutorCheckpoint(this.#db, checkpoint, { now }),
      };
      return {
        round: cloneRound(round),
        attempt: cloneAttempt(attempt),
        classificationCheckpoint,
      };
    });
  }

  #loadAttempt(): ExecutorAttemptRecord {
    const attempt = loadExecutorAttempt(this.#db, this.#attemptId);
    if (attempt === undefined) {
      throw new ExecutorEnvelopeAccessError(
        `Executor attempt not found: ${this.#attemptId}`,
      );
    }
    return attempt;
  }

  #loadOwnedRound(roundId: string): ExecutorRoundRecord {
    const round = loadExecutorRound(this.#db, roundId);
    if (round === undefined) {
      throw new ExecutorEnvelopeAccessError(
        `Executor round not found: ${roundId}`,
      );
    }
    if (round.attemptId !== this.#attemptId) {
      throw new ExecutorEnvelopeAccessError(
        `Round ${roundId} belongs to attempt ${round.attemptId}, not ${this.#attemptId}.`,
      );
    }
    return round;
  }

  #assertEvidenceWritable(roundId: string): void {
    const attempt = this.#loadAttempt();
    this.#assertExecutorWritable(
      attempt,
      `append evidence to round ${roundId}`,
    );
    const round = this.#loadOwnedRound(roundId);
    if (isTerminalExecutorRoundState(round.state)) {
      throw new ExecutorEnvelopeAccessError(
        `Cannot append evidence to terminal round ${roundId} (${round.state}).`,
      );
    }
  }

  #assertExecutorWritable(
    attempt: ExecutorAttemptRecord,
    operation: string,
  ): void {
    this.#authorizeWrite();
    if (isTerminalExecutorAttemptState(attempt.state)) {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: attempt ${this.#attemptId} is terminal (${attempt.state}).`,
      );
    }
    if (attempt.state !== "running") {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: attempt ${this.#attemptId} is not executor-writable (${attempt.state}).`,
      );
    }
  }

  #assertAttemptUnsettled(
    attempt: ExecutorAttemptRecord,
    operation: string,
  ): void {
    if (isTerminalExecutorAttemptState(attempt.state)) {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: attempt ${this.#attemptId} is terminal (${attempt.state}).`,
      );
    }
  }

  #assertRoundIdentity(
    round: ExecutorRoundStart,
    attempt: ExecutorAttemptRecord,
  ): void {
    const mismatches: string[] = [];
    if (round.attemptId !== attempt.attemptId) {
      mismatches.push("attemptId");
    }
    if (round.workflowRunId !== attempt.workflowRunId) {
      mismatches.push("workflowRunId");
    }
    if (round.stepRunId !== attempt.stepRunId) mismatches.push("stepRunId");
    if (round.stepKey !== attempt.stepKey) mismatches.push("stepKey");
    if (round.executorFamily !== attempt.executorFamily) {
      mismatches.push("executorFamily");
    }
    if (round.attemptNumber !== attempt.attemptNumber)
      mismatches.push("attemptNumber");
    if (mismatches.length > 0) {
      throw new ExecutorEnvelopeAccessError(
        `Round ${round.roundId} does not match its bound attempt: ${mismatches.join(", ")}.`,
      );
    }
  }

  #roundSnapshot(round: ExecutorRoundRecord): ExecutorRoundEnvelopeSnapshot {
    return {
      round: cloneRound(round),
      artifacts: listExecutorArtifactsForRound(this.#db, round.roundId).map(
        (artifact) => ({ ...artifact }),
      ),
      checkpoints: listExecutorCheckpointsForRound(this.#db, round.roundId).map(
        (checkpoint) => ({ ...checkpoint }),
      ),
      findings: listExecutorFindingsForRound(this.#db, round.roundId).map(
        (finding) => ({ ...finding }),
      ),
      decisions: listExecutorDecisionsForRound(this.#db, round.roundId).map(
        (decision) => ({
          ...decision,
          allowedActions: [...decision.allowedActions],
        }),
      ),
    };
  }
}

export function createDurableExecutorEnvelope(
  input: CreateDurableExecutorEnvelopeInput,
): DurableExecutorEnvelope {
  return new DurableExecutorEnvelope(input);
}

let transactionSequence = 0;

function withSqliteTransaction<T>(
  db: MomentumDb,
  mode: "read" | "write",
  operation: () => T,
): T {
  const nested = db.isTransaction;
  const savepoint = `executor_sdk_${(transactionSequence += 1)}`;
  db.exec(
    nested
      ? `SAVEPOINT ${savepoint}`
      : mode === "write"
        ? "BEGIN IMMEDIATE"
        : "BEGIN",
  );
  try {
    const result = operation();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    rollbackTransaction(db, nested ? savepoint : null);
    throw error;
  }
}

function rollbackTransaction(db: MomentumDb, savepoint: string | null): void {
  try {
    if (savepoint === null) {
      db.exec("ROLLBACK");
      return;
    }
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch {
    // Preserve the original failure when SQLite already closed the transaction.
  }
}

function copyObservation(
  observation: ExecutorRoundObservation,
): Omit<ExecutorRoundUpdate, "toState" | "heartbeatAt"> {
  return {
    ...(observation.agentProvider !== undefined
      ? { agentProvider: observation.agentProvider }
      : {}),
    ...(observation.model !== undefined ? { model: observation.model } : {}),
    ...(observation.effort !== undefined ? { effort: observation.effort } : {}),
    ...(observation.inputDigest !== undefined
      ? { inputDigest: observation.inputDigest }
      : {}),
    ...(observation.resultDigest !== undefined
      ? { resultDigest: observation.resultDigest }
      : {}),
    ...(observation.artifactRoot !== undefined
      ? { artifactRoot: observation.artifactRoot }
      : {}),
    ...(observation.logPaths !== undefined
      ? { logPaths: [...observation.logPaths] }
      : {}),
    ...(observation.summary !== undefined
      ? { summary: observation.summary }
      : {}),
    ...(observation.keyChanges !== undefined
      ? { keyChanges: [...observation.keyChanges] }
      : {}),
    ...(observation.keyLearnings !== undefined
      ? { keyLearnings: [...observation.keyLearnings] }
      : {}),
    ...(observation.remainingWork !== undefined
      ? { remainingWork: [...observation.remainingWork] }
      : {}),
    ...(observation.changedFiles !== undefined
      ? { changedFiles: [...observation.changedFiles] }
      : {}),
    ...(observation.verificationStatus !== undefined
      ? { verificationStatus: observation.verificationStatus }
      : {}),
    ...(observation.verificationResults !== undefined
      ? {
          verificationResults: observation.verificationResults.map(
            (result) => ({ ...result }),
          ),
        }
      : {}),
    ...(observation.commitSha !== undefined
      ? { commitSha: observation.commitSha }
      : {}),
  };
}

const ARTIFACT_CLASSES: ReadonlySet<string> = new Set(
  EXECUTOR_ARTIFACT_CLASSES,
);
const COMPLETION_CLASSIFICATIONS: ReadonlySet<string> = new Set(
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
);
const HUMAN_GATE_TYPES: ReadonlySet<string> = new Set(
  EXECUTOR_HUMAN_GATE_TYPES,
);
const ATTEMPT_STATES: ReadonlySet<string> = new Set(EXECUTOR_ATTEMPT_STATES);
const ROUND_STATES: ReadonlySet<string> = new Set(EXECUTOR_ROUND_STATES);

function invalidInput(message: string): never {
  throw new ExecutorEnvelopeAccessError(
    `Invalid executor envelope input: ${message}.`,
  );
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput(`${label} must be an object`);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput(`${label} must be a non-empty string`);
  }
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    invalidInput(`${label} must be a string or null`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidInput(`${label} must be an array of strings`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalidInput(`${label} must be a non-negative integer`);
  }
}

function assertVerificationResults(value: unknown, label: string): void {
  if (!Array.isArray(value)) invalidInput(`${label} must be an array`);
  for (const [index, candidate] of value.entries()) {
    assertRecord(candidate, `${label}[${index}]`);
    assertNonEmptyString(candidate["command"], `${label}[${index}].command`);
    if (
      candidate["exitCode"] !== null &&
      !Number.isInteger(candidate["exitCode"])
    ) {
      invalidInput(`${label}[${index}].exitCode must be an integer or null`);
    }
    if (
      typeof candidate["durationMs"] !== "number" ||
      !Number.isFinite(candidate["durationMs"]) ||
      candidate["durationMs"] < 0
    ) {
      invalidInput(
        `${label}[${index}].durationMs must be a non-negative number`,
      );
    }
    if (typeof candidate["timedOut"] !== "boolean") {
      invalidInput(`${label}[${index}].timedOut must be a boolean`);
    }
  }
}

function assertRoundStartInput(
  value: unknown,
): asserts value is ExecutorRoundStart {
  assertRecord(value, "round start");
  for (const field of [
    "roundId",
    "attemptId",
    "workflowRunId",
    "stepRunId",
    "stepKey",
    "executorFamily",
  ]) {
    assertNonEmptyString(value[field], `round start ${field}`);
  }
  if (
    !Number.isInteger(value["attemptNumber"]) ||
    (value["attemptNumber"] as number) < 1
  ) {
    invalidInput("round start attemptNumber must be a positive integer");
  }
  assertNonNegativeInteger(value["roundIndex"], "round start roundIndex");
  assertObservationPhase(value["state"], "start round");
  for (const field of [
    "agentProvider",
    "model",
    "effort",
    "inputDigest",
    "resultDigest",
    "artifactRoot",
    "summary",
    "verificationStatus",
    "commitSha",
  ]) {
    assertNullableString(value[field], `round start ${field}`);
  }
  for (const field of [
    "logPaths",
    "keyChanges",
    "keyLearnings",
    "remainingWork",
    "changedFiles",
  ]) {
    assertStringArray(value[field], `round start ${field}`);
  }
  if (value["verificationResults"] !== undefined) {
    assertVerificationResults(
      value["verificationResults"],
      "round start verificationResults",
    );
  }
}

function assertRoundObservationInput(
  value: unknown,
): asserts value is ExecutorRoundObservation {
  assertRecord(value, "round observation");
  if (value["phase"] !== undefined) {
    assertObservationPhase(value["phase"], "observe round");
  }
  for (const field of [
    "agentProvider",
    "model",
    "effort",
    "inputDigest",
    "resultDigest",
    "artifactRoot",
    "summary",
    "verificationStatus",
    "commitSha",
  ]) {
    if (value[field] !== undefined) {
      assertNullableString(value[field], `round observation ${field}`);
    }
  }
  for (const field of [
    "logPaths",
    "keyChanges",
    "keyLearnings",
    "remainingWork",
    "changedFiles",
  ]) {
    if (value[field] !== undefined) {
      assertStringArray(value[field], `round observation ${field}`);
    }
  }
  if (value["verificationResults"] !== undefined) {
    assertVerificationResults(
      value["verificationResults"],
      "round observation verificationResults",
    );
  }
}

function assertArtifactInput(
  value: unknown,
): asserts value is ExecutorArtifactInput {
  assertRecord(value, "artifact");
  assertNonEmptyString(value["artifactId"], "artifact id");
  if (
    typeof value["artifactClass"] !== "string" ||
    !ARTIFACT_CLASSES.has(value["artifactClass"])
  ) {
    invalidInput("artifact class is unknown");
  }
  assertNonEmptyString(value["path"], "artifact path");
  assertNullableString(value["digest"], "artifact digest");
  assertNullableString(value["description"], "artifact description");
}

function assertCheckpointInput(
  value: unknown,
): asserts value is ExecutorCheckpointInput {
  assertRecord(value, "checkpoint");
  assertNonEmptyString(value["checkpointId"], "checkpoint id");
  assertNonNegativeInteger(value["sequence"], "checkpoint sequence");
  assertNonEmptyString(value["stage"], "checkpoint stage");
  assertNullableString(value["detail"], "checkpoint detail");
}

function assertFindingInput(
  value: unknown,
): asserts value is ExecutorFindingInput {
  assertRecord(value, "finding");
  assertNonEmptyString(value["findingId"], "finding id");
  assertNullableString(value["severity"], "finding severity");
  assertNonEmptyString(value["title"], "finding title");
  assertNullableString(value["detail"], "finding detail");
  if (typeof value["selected"] !== "boolean") {
    invalidInput("finding selected must be a boolean");
  }
  assertNullableString(value["externalRef"], "finding externalRef");
}

function assertDecisionInput(
  value: unknown,
): asserts value is ExecutorDecisionInput {
  assertRecord(value, "decision");
  assertNonEmptyString(value["decisionId"], "decision id");
  assertNonEmptyString(value["summary"], "decision summary");
  assertStringArray(value["allowedActions"], "decision allowedActions");
  for (const field of [
    "recommendedAction",
    "chosenAction",
    "resolution",
  ] as const) {
    assertNullableString(value[field], `decision ${field}`);
  }
  if (value["externalRef"] !== undefined) {
    assertNullableString(value["externalRef"], "decision externalRef");
  }
}

function assertDaemonDecisionInput(value: unknown): void {
  assertRecord(value, "daemon decision");
  assertNonEmptyString(value["roundId"], "daemon decision round id");
  if (
    typeof value["classification"] !== "string" ||
    !COMPLETION_CLASSIFICATIONS.has(value["classification"])
  ) {
    invalidInput("daemon decision classification is unknown");
  }
  if (
    value["executorRecommendation"] !== null &&
    (typeof value["executorRecommendation"] !== "string" ||
      !COMPLETION_CLASSIFICATIONS.has(value["executorRecommendation"]))
  ) {
    invalidInput("daemon decision executorRecommendation is unknown");
  }
  if (
    typeof value["roundState"] !== "string" ||
    !ROUND_STATES.has(value["roundState"])
  ) {
    invalidInput("daemon decision roundState is unknown");
  }
  if (
    typeof value["attemptState"] !== "string" ||
    !ATTEMPT_STATES.has(value["attemptState"])
  ) {
    invalidInput("daemon decision attemptState is unknown");
  }
  assertNullableString(value["recoveryCode"], "daemon decision recoveryCode");
  if (
    value["humanGate"] !== null &&
    (typeof value["humanGate"] !== "string" ||
      !HUMAN_GATE_TYPES.has(value["humanGate"]))
  ) {
    invalidInput("daemon decision humanGate is unknown");
  }
}

const OBSERVATION_PHASES: ReadonlySet<string> = new Set(
  EXECUTOR_OBSERVATION_PHASES,
);

function assertObservationPhase(value: unknown, operation: string): void {
  if (typeof value !== "string" || !OBSERVATION_PHASES.has(value)) {
    throw new ExecutorEnvelopeAccessError(
      `Cannot ${operation}: ${String(value)} is not an executor observation phase.`,
    );
  }
}

function allocateCheckpointIdentity(
  db: MomentumDb,
  roundId: string,
): Pick<ExecutorCheckpointInput, "checkpointId" | "sequence"> {
  const checkpoints = listExecutorCheckpointsForRound(db, roundId);
  const sequence =
    Math.max(-1, ...checkpoints.map((checkpoint) => checkpoint.sequence)) + 1;
  const baseId = `${roundId}-checkpoint-${sequence}`;
  let checkpointId = baseId;
  for (let suffix = 1; checkpointIdExists(db, checkpointId); suffix += 1) {
    checkpointId = `${baseId}-${suffix}`;
  }
  return { checkpointId, sequence };
}

function checkpointIdExists(db: MomentumDb, checkpointId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM executor_checkpoints WHERE checkpoint_id = ? LIMIT 1",
      )
      .get(checkpointId) !== undefined
  );
}

function cloneAttempt(attempt: ExecutorAttemptRecord): ExecutorAttemptRecord {
  return { ...attempt };
}

function cloneRound(round: ExecutorRoundRecord): ExecutorRoundRecord {
  return {
    ...round,
    logPaths: [...round.logPaths],
    keyChanges: [...round.keyChanges],
    keyLearnings: [...round.keyLearnings],
    remainingWork: [...round.remainingWork],
    changedFiles: [...round.changedFiles],
    ...(round.verificationResults !== undefined
      ? {
          verificationResults: round.verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
  };
}

function roundRecordFromStart(
  start: ExecutorRoundStart,
  now: number,
): ExecutorRoundRecord {
  const {
    verificationResults,
    startedAt: _startedAt,
    heartbeatAt: _heartbeatAt,
    ...record
  } = start as ExecutorRoundStart & {
    startedAt?: unknown;
    heartbeatAt?: unknown;
  };
  return {
    ...record,
    classification: null,
    executorRecommendation: null,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
    recoveryCode: null,
    humanGate: null,
    logPaths: [...start.logPaths],
    keyChanges: [...start.keyChanges],
    keyLearnings: [...start.keyLearnings],
    remainingWork: [...start.remainingWork],
    changedFiles: [...start.changedFiles],
    ...(verificationResults !== undefined
      ? {
          verificationResults: verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
  };
}
