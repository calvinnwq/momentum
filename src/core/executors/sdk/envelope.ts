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
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  loadExecutorRound,
  updateExecutorInvocationState,
  updateExecutorRound,
  type ExecutorRoundUpdate,
} from "../loop/persist.js";
import {
  executorInvocationStateForClassification,
  isExecutorRoundStateCompatibleWithClassification,
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorDecisionRecord,
  type ExecutorFindingRecord,
  type ExecutorInvocationRecord,
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
  invocationId: string;
  now?: () => number;
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
  invocation: ExecutorInvocationRecord;
  classificationCheckpoint: Readonly<ExecutorCheckpointRecord>;
};

/**
 * SQLite-backed controller bound to one invocation. Executor code receives the
 * separate capability-limited {@link facade}; daemon code retains this controller
 * to apply its own decision after the tick returns.
 */
export class DurableExecutorEnvelope {
  readonly #db: MomentumDb;
  readonly #invocationId: string;
  readonly #now: () => number;
  readonly facade: ExecutorEnvelope;

  constructor(input: CreateDurableExecutorEnvelopeInput) {
    this.#db = input.db;
    this.#invocationId = input.invocationId;
    this.#now = input.now ?? Date.now;
    this.#loadInvocation();
    const facade: ExecutorEnvelope = {
      snapshot: () => this.snapshot(),
      startRound: (record) => this.startRound(record),
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
    const invocation = cloneInvocation(this.#loadInvocation());
    const rounds = listExecutorRoundsForInvocation(
      this.#db,
      this.#invocationId,
    ).map((round) => this.#roundSnapshot(round));
    return {
      invocation,
      rounds,
      currentRound: rounds.at(-1) ?? null,
    };
  }

  startRound(record: ExecutorRoundStart): ExecutorRoundView {
    return withSqliteTransaction(this.#db, "write", () => {
      const invocation = this.#loadInvocation();
      assertObservationPhase(record.state, `start round ${record.roundId}`);
      this.#assertRoundIdentity(record, invocation);
      this.#assertExecutorWritable(invocation, `start round ${record.roundId}`);
      const rounds = listExecutorRoundsForInvocation(
        this.#db,
        this.#invocationId,
      );
      const previous = rounds.at(-1);
      if (
        previous !== undefined &&
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
      const durableRecord = roundRecordFromStart(record);
      return cloneRound(
        insertExecutorRound(this.#db, durableRecord, {
          now: record.startedAt ?? this.#now(),
        }),
      );
    });
  }

  observeRound(
    roundId: string,
    observation: ExecutorRoundObservation,
  ): ExecutorRoundView {
    return withSqliteTransaction(this.#db, "write", () => {
      const invocation = this.#loadInvocation();
      this.#assertExecutorWritable(invocation, `observe round ${roundId}`);
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
      const invocation = this.#loadInvocation();
      this.#assertExecutorWritable(invocation, "heartbeat invocation");
      updateExecutorInvocationState(
        this.#db,
        this.#invocationId,
        invocation.state,
        { heartbeatAt: now, now },
      );
      const current = listExecutorRoundsForInvocation(
        this.#db,
        this.#invocationId,
      ).at(-1);
      if (
        current !== undefined &&
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
      const currentInvocation = this.#loadInvocation();
      this.#assertInvocationUnsettled(
        currentInvocation,
        `classify round ${decision.roundId}`,
      );
      const currentRound = this.#loadOwnedRound(decision.roundId);
      if (isTerminalExecutorRoundState(currentRound.state)) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot reclassify terminal round ${decision.roundId} (${currentRound.state}).`,
        );
      }
      const expectedInvocationState = executorInvocationStateForClassification(
        decision.classification,
      );
      if (decision.invocationState !== expectedInvocationState) {
        throw new ExecutorEnvelopeAccessError(
          `Cannot classify round ${decision.roundId} as ${decision.classification}: expected invocation state ${expectedInvocationState}, got ${decision.invocationState}.`,
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

      const invocation = updateExecutorInvocationState(
        this.#db,
        this.#invocationId,
        decision.invocationState,
        {
          heartbeatAt: now,
          finishedAt: isTerminalExecutorInvocationState(
            decision.invocationState,
          )
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
      const classificationCheckpoint = {
        ...insertExecutorCheckpoint(
          this.#db,
          {
            ...options.classificationCheckpoint,
            ...checkpointIdentity,
            roundId: decision.roundId,
          },
          { now },
        ),
      };
      return {
        round: cloneRound(round),
        invocation: cloneInvocation(invocation),
        classificationCheckpoint,
      };
    });
  }

  #loadInvocation(): ExecutorInvocationRecord {
    const invocation = loadExecutorInvocation(this.#db, this.#invocationId);
    if (invocation === undefined) {
      throw new ExecutorEnvelopeAccessError(
        `Executor invocation not found: ${this.#invocationId}`,
      );
    }
    return invocation;
  }

  #loadOwnedRound(roundId: string): ExecutorRoundRecord {
    const round = loadExecutorRound(this.#db, roundId);
    if (round === undefined) {
      throw new ExecutorEnvelopeAccessError(
        `Executor round not found: ${roundId}`,
      );
    }
    if (round.invocationId !== this.#invocationId) {
      throw new ExecutorEnvelopeAccessError(
        `Round ${roundId} belongs to invocation ${round.invocationId}, not ${this.#invocationId}.`,
      );
    }
    return round;
  }

  #assertEvidenceWritable(roundId: string): void {
    const invocation = this.#loadInvocation();
    this.#assertExecutorWritable(
      invocation,
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
    invocation: ExecutorInvocationRecord,
    operation: string,
  ): void {
    if (isTerminalExecutorInvocationState(invocation.state)) {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: invocation ${this.#invocationId} is terminal (${invocation.state}).`,
      );
    }
    if (invocation.state !== "running") {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: invocation ${this.#invocationId} is not executor-writable (${invocation.state}).`,
      );
    }
  }

  #assertInvocationUnsettled(
    invocation: ExecutorInvocationRecord,
    operation: string,
  ): void {
    if (isTerminalExecutorInvocationState(invocation.state)) {
      throw new ExecutorEnvelopeAccessError(
        `Cannot ${operation}: invocation ${this.#invocationId} is terminal (${invocation.state}).`,
      );
    }
  }

  #assertRoundIdentity(
    round: ExecutorRoundStart,
    invocation: ExecutorInvocationRecord,
  ): void {
    const mismatches: string[] = [];
    if (round.invocationId !== invocation.invocationId) {
      mismatches.push("invocationId");
    }
    if (round.workflowRunId !== invocation.workflowRunId) {
      mismatches.push("workflowRunId");
    }
    if (round.stepRunId !== invocation.stepRunId) mismatches.push("stepRunId");
    if (round.stepKey !== invocation.stepKey) mismatches.push("stepKey");
    if (round.executorFamily !== invocation.executorFamily) {
      mismatches.push("executorFamily");
    }
    if (round.attempt !== invocation.attempt) mismatches.push("attempt");
    if (mismatches.length > 0) {
      throw new ExecutorEnvelopeAccessError(
        `Round ${round.roundId} does not match its bound invocation: ${mismatches.join(", ")}.`,
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

function cloneInvocation(
  invocation: ExecutorInvocationRecord,
): ExecutorInvocationRecord {
  return { ...invocation };
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

function roundRecordFromStart(start: ExecutorRoundStart): ExecutorRoundRecord {
  const { verificationResults, ...record } = start;
  return {
    ...record,
    classification: null,
    executorRecommendation: null,
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
