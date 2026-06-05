/**
 * Persistence layer for the executor-loop spine (M10-03, NGX-347).
 *
 * Takes the pure {@link ExecutorDefinitionRecord} / {@link ExecutorInvocationRecord}
 * / {@link ExecutorRoundRecord} shapes owned by `executor-loop-reducer.ts` and
 * writes them into the durable `executor_definitions` / `executor_invocations` /
 * `executor_rounds` tables added by `migrations.ts`. This is the storage twin of
 * the pure reducer: nothing here runs executors or starts a Goal loop. The
 * M10-04 scheduler lane is owned separately by `workflow-scheduler.ts`; the
 * landed goal-loop and one-shot / script adapters layer on top of this
 * persistence spine, exactly as `workflow-definition-persist.ts` is the storage
 * twin of `workflow-definition.ts`.
 *
 * Stable contracts this slice locks in:
 *   - An executor definition's durable identity is its `executorKey`; re-persisting
 *     the same key is idempotent (it never duplicates rows), preserves `created_at`,
 *     and bumps `updated_at`, mirroring `persistWorkflowDefinition`.
 *   - An invocation's identity is its `invocationId`; a round's is its `roundId`,
 *     and `(invocationId, roundIndex)` is unique so round ordering can never
 *     collide. Inserting a duplicate refuses with a typed conflict error and
 *     leaves the existing row untouched — a durable executor row is the proof a
 *     bounded unit started, not an idempotent re-ingest.
 *   - Persistence is validation-gated: an unknown executor family / state /
 *     classification / human-gate is rejected with {@link InvalidExecutorRecordError}
 *     *before* any row is written, so durable executor state can never carry a
 *     vocabulary string outside the contract.
 *   - State changes are transition-gated through the same
 *     {@link transitionExecutorInvocation} / {@link transitionExecutorRound}
 *     reducers used everywhere else: a round can never fast-path to `succeeded`
 *     without first capturing or mirroring a normalized result, and the refusal
 *     leaves the durable row unchanged.
 *   - The round carries the contract "Round Schema" normalized result fields
 *     (`summary`, `key_changes`, `remaining_work`, `changed_files`,
 *     `verification_status`, `commit_sha`, ...) so workflow status, handoff,
 *     monitor, and recovery surfaces can reattach without understanding executor
 *     internals.
 *   - The `executor_artifacts` / `executor_checkpoints` / `executor_findings` /
 *     `executor_decisions` child evidence tables hang below a round by
 *     `round_id`. They are append-only: an evidence row is durable proof a round
 *     emitted something, so a duplicate id (or a duplicate checkpoint
 *     `(round_id, sequence)`) refuses with {@link ExecutorEvidenceConflictError}
 *     and leaves the existing row untouched, and an artifact carrying an
 *     out-of-contract `artifactClass` is rejected before any write. Their FK to
 *     `executor_rounds` is enforced, so evidence can never orphan itself above a
 *     round.
 */

import { isUniqueViolation, type MomentumDb } from "./db.js";
import {
  EXECUTOR_ARTIFACT_CLASSES,
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_INVOCATION_STATES,
  EXECUTOR_ROUND_STATES,
  transitionExecutorInvocation,
  transitionExecutorRound,
  type ExecutorArtifactClass,
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorCompletionClassification,
  type ExecutorDecisionRecord,
  type ExecutorDefinitionRecord,
  type ExecutorFindingRecord,
  type ExecutorHumanGateType,
  type ExecutorInvocationRecord,
  type ExecutorInvocationState,
  type ExecutorInvocationTransitionErrorCode,
  type ExecutorRoundRecord,
  type ExecutorRoundState,
  type ExecutorRoundTransitionErrorCode,
  type WorkflowExecutorFamily
} from "./executor-loop-reducer.js";
import { isWorkflowExecutorFamily } from "./workflow-definition.js";

const INVOCATION_STATE_SET: ReadonlySet<string> = new Set(
  EXECUTOR_INVOCATION_STATES
);
const ROUND_STATE_SET: ReadonlySet<string> = new Set(EXECUTOR_ROUND_STATES);
const CLASSIFICATION_SET: ReadonlySet<string> = new Set(
  EXECUTOR_COMPLETION_CLASSIFICATIONS
);
const GATE_TYPE_SET: ReadonlySet<string> = new Set(EXECUTOR_HUMAN_GATE_TYPES);
const ARTIFACT_CLASS_SET: ReadonlySet<string> = new Set(
  EXECUTOR_ARTIFACT_CLASSES
);

/** One typed validation problem with an enum field of an executor record. */
export type ExecutorRecordValidationError = {
  code: string;
  message: string;
};

/**
 * Thrown by an insert/persist when a record carries a vocabulary string outside
 * the executor-loop contract. Carries the full typed error list so callers can
 * surface a complete diagnostic. No rows are written when this is thrown.
 */
export class InvalidExecutorRecordError extends Error {
  readonly errors: readonly ExecutorRecordValidationError[];

  constructor(errors: readonly ExecutorRecordValidationError[]) {
    super(`Invalid executor record: ${errors.map((e) => e.code).join(", ")}`);
    this.name = "InvalidExecutorRecordError";
    this.errors = errors;
  }
}

/** Thrown when inserting an invocation whose id already exists. */
export class ExecutorInvocationConflictError extends Error {
  readonly invocationId: string;

  constructor(invocationId: string) {
    super(`Executor invocation already exists: ${invocationId}`);
    this.name = "ExecutorInvocationConflictError";
    this.invocationId = invocationId;
  }
}

/** Thrown when updating an invocation that does not exist. */
export class ExecutorInvocationNotFoundError extends Error {
  readonly invocationId: string;

  constructor(invocationId: string) {
    super(`Executor invocation not found: ${invocationId}`);
    this.name = "ExecutorInvocationNotFoundError";
    this.invocationId = invocationId;
  }
}

/** Thrown when an invocation state change violates the transition graph. */
export class ExecutorInvocationTransitionError extends Error {
  readonly invocationId: string;
  readonly from: ExecutorInvocationState;
  readonly to: ExecutorInvocationState;
  readonly code: ExecutorInvocationTransitionErrorCode;

  constructor(
    invocationId: string,
    from: ExecutorInvocationState,
    to: ExecutorInvocationState,
    code: ExecutorInvocationTransitionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExecutorInvocationTransitionError";
    this.invocationId = invocationId;
    this.from = from;
    this.to = to;
    this.code = code;
  }
}

/** Thrown when inserting a round whose id or `(invocation, index)` collides. */
export class ExecutorRoundConflictError extends Error {
  readonly roundId: string;

  constructor(roundId: string) {
    super(`Executor round already exists: ${roundId}`);
    this.name = "ExecutorRoundConflictError";
    this.roundId = roundId;
  }
}

/** Thrown when updating a round that does not exist. */
export class ExecutorRoundNotFoundError extends Error {
  readonly roundId: string;

  constructor(roundId: string) {
    super(`Executor round not found: ${roundId}`);
    this.name = "ExecutorRoundNotFoundError";
    this.roundId = roundId;
  }
}

/** Thrown when a round state change violates the transition graph. */
export class ExecutorRoundTransitionError extends Error {
  readonly roundId: string;
  readonly from: ExecutorRoundState;
  readonly to: ExecutorRoundState;
  readonly code: ExecutorRoundTransitionErrorCode;

  constructor(
    roundId: string,
    from: ExecutorRoundState,
    to: ExecutorRoundState,
    code: ExecutorRoundTransitionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExecutorRoundTransitionError";
    this.roundId = roundId;
    this.from = from;
    this.to = to;
    this.code = code;
  }
}

/** The four append-only evidence classes that hang below an executor round. */
export type ExecutorEvidenceEntity =
  | "artifact"
  | "checkpoint"
  | "finding"
  | "decision";

/**
 * Thrown when inserting a child evidence row whose id collides (or, for a
 * checkpoint, whose `(round_id, sequence)` collides). Evidence rows are
 * append-only proof a round emitted something, not an idempotent re-ingest, so a
 * duplicate refuses and leaves the existing row untouched. Carries the entity so
 * callers can tell which of the four evidence classes conflicted.
 */
export class ExecutorEvidenceConflictError extends Error {
  readonly entity: ExecutorEvidenceEntity;
  readonly id: string;

  constructor(entity: ExecutorEvidenceEntity, id: string) {
    super(`Executor ${entity} already exists: ${id}`);
    this.name = "ExecutorEvidenceConflictError";
    this.entity = entity;
    this.id = id;
  }
}

export type PersistExecutorDefinitionOptions = {
  now?: number;
};

export type PersistExecutorDefinitionSummary = {
  executorKey: string;
  inserted: boolean;
};

/**
 * Validate and durably upsert an {@link ExecutorDefinitionRecord}. Re-persisting
 * the same `executorKey` is idempotent: `created_at` is preserved and
 * `updated_at` is bumped so callers can detect re-ingest.
 *
 * @throws {InvalidExecutorRecordError} if the record's family is unknown; no
 * rows are written in that case.
 */
export function persistExecutorDefinition(
  db: MomentumDb,
  record: ExecutorDefinitionRecord,
  options: PersistExecutorDefinitionOptions = {}
): PersistExecutorDefinitionSummary {
  const errors = validateDefinitionRecord(record);
  if (errors.length > 0) {
    throw new InvalidExecutorRecordError(errors);
  }
  const now = options.now ?? Date.now();

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare(
        "SELECT executor_key FROM executor_definitions WHERE executor_key = ?"
      )
      .get(record.executorKey) as { executor_key: string } | undefined;
    const inserted = existing === undefined;

    db.prepare(
      `INSERT INTO executor_definitions (
         executor_key, family, agent_provider, model, effort,
         timeout_ms, max_rounds, policy_envelope, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(executor_key) DO UPDATE SET
         family = excluded.family,
         agent_provider = excluded.agent_provider,
         model = excluded.model,
         effort = excluded.effort,
         timeout_ms = excluded.timeout_ms,
         max_rounds = excluded.max_rounds,
         policy_envelope = excluded.policy_envelope,
         updated_at = excluded.updated_at`
    ).run(
      record.executorKey,
      record.family,
      record.agentProvider,
      record.model,
      record.effort,
      record.timeoutMs,
      record.maxRounds,
      record.policyEnvelope,
      now,
      now
    );

    db.exec("COMMIT");
    return { executorKey: record.executorKey, inserted };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/** Load a persisted executor definition; `undefined` when none matches. */
export function loadExecutorDefinition(
  db: MomentumDb,
  executorKey: string
): ExecutorDefinitionRecord | undefined {
  const row = db
    .prepare(
      `SELECT executor_key, family, agent_provider, model, effort,
              timeout_ms, max_rounds, policy_envelope
         FROM executor_definitions WHERE executor_key = ?`
    )
    .get(executorKey) as ExecutorDefinitionRow | undefined;
  if (row === undefined) return undefined;
  return {
    executorKey: row.executor_key,
    family: row.family as WorkflowExecutorFamily,
    agentProvider: row.agent_provider,
    model: row.model,
    effort: row.effort,
    timeoutMs: row.timeout_ms,
    maxRounds: row.max_rounds,
    policyEnvelope: row.policy_envelope
  };
}

export type InsertExecutorInvocationOptions = {
  now?: number;
};

/**
 * Durably insert a new {@link ExecutorInvocationRecord}.
 *
 * @throws {InvalidExecutorRecordError} if the family/state is unknown.
 * @throws {ExecutorInvocationConflictError} if `invocationId` already exists; the
 * existing row is left untouched.
 */
export function insertExecutorInvocation(
  db: MomentumDb,
  record: ExecutorInvocationRecord,
  options: InsertExecutorInvocationOptions = {}
): ExecutorInvocationRecord {
  const errors = validateInvocationRecord(record);
  if (errors.length > 0) {
    throw new InvalidExecutorRecordError(errors);
  }
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_invocations (
         invocation_id, workflow_run_id, step_run_id, step_key, executor_family,
         state, attempt, started_at, heartbeat_at, finished_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.invocationId,
      record.workflowRunId,
      record.stepRunId,
      record.stepKey,
      record.executorFamily,
      record.state,
      record.attempt,
      record.startedAt,
      record.heartbeatAt,
      record.finishedAt,
      now,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorInvocationConflictError(record.invocationId);
    }
    throw error;
  }
  return record;
}

/** Load a persisted invocation; `undefined` when none matches. */
export function loadExecutorInvocation(
  db: MomentumDb,
  invocationId: string
): ExecutorInvocationRecord | undefined {
  return loadExecutorInvocationSnapshot(db, invocationId)?.record;
}

export type UpdateExecutorInvocationOptions = {
  now?: number;
  startedAt?: number | null;
  heartbeatAt?: number | null;
  finishedAt?: number | null;
};

/**
 * Transition-gate an invocation to `toState`, optionally stamping
 * started/heartbeat/finished timestamps. A same-state update is a heartbeat-only
 * no-op transition.
 *
 * @throws {ExecutorInvocationNotFoundError} if no invocation has `invocationId`.
 * @throws {ExecutorInvocationTransitionError} if the transition is illegal; the
 * durable row is left unchanged.
 */
export function updateExecutorInvocationState(
  db: MomentumDb,
  invocationId: string,
  toState: ExecutorInvocationState,
  options: UpdateExecutorInvocationOptions = {}
): ExecutorInvocationRecord {
  const currentSnapshot = loadExecutorInvocationSnapshot(db, invocationId);
  if (currentSnapshot === undefined) {
    throw new ExecutorInvocationNotFoundError(invocationId);
  }
  const current = currentSnapshot.record;
  const result = transitionExecutorInvocation(current.state, toState);
  if (!result.ok) {
    throw new ExecutorInvocationTransitionError(
      invocationId,
      current.state,
      toState,
      result.errorCode,
      result.errorMessage
    );
  }
  const now = options.now ?? Date.now();
  const next: ExecutorInvocationRecord = {
    ...current,
    state: toState,
    startedAt: coalesce(options.startedAt, current.startedAt),
    heartbeatAt: coalesce(options.heartbeatAt, current.heartbeatAt),
    finishedAt: coalesce(options.finishedAt, current.finishedAt)
  };
  const updateResult = db.prepare(
    `UPDATE executor_invocations
       SET state = ?, started_at = ?, heartbeat_at = ?, finished_at = ?,
           updated_at = ?
     WHERE invocation_id = ? AND state = ? AND updated_at = ?`
  ).run(
    next.state,
    next.startedAt,
    next.heartbeatAt,
    next.finishedAt,
    now,
    invocationId,
    current.state,
    currentSnapshot.updatedAt
  );
  if (Number(updateResult.changes) === 0) {
    return handleInvocationPostWriteConflict(db, invocationId, toState, options);
  }
  return next;
}

export type InsertExecutorRoundOptions = {
  now?: number;
};

/**
 * Durably insert a new {@link ExecutorRoundRecord}. The contract's Round
 * Lifecycle creates this row before external work runs; the result fields may be
 * empty at that point and captured later via {@link updateExecutorRound}.
 *
 * @throws {InvalidExecutorRecordError} if family/state/classification/human-gate
 * is unknown.
 * @throws {ExecutorRoundConflictError} if `roundId` or `(invocationId, roundIndex)`
 * already exists; the existing row is left untouched.
 */
export function insertExecutorRound(
  db: MomentumDb,
  record: ExecutorRoundRecord,
  options: InsertExecutorRoundOptions = {}
): ExecutorRoundRecord {
  const errors = validateRoundRecord(record);
  if (errors.length > 0) {
    throw new InvalidExecutorRecordError(errors);
  }
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_rounds (
         round_id, invocation_id, workflow_run_id, step_run_id, step_key,
         executor_family, attempt, round_index, state, classification,
         started_at, heartbeat_at, finished_at, agent_provider, model, effort,
         input_digest, result_digest, artifact_root, log_paths,
         summary, key_changes, remaining_work, changed_files,
         verification_status, commit_sha, recovery_code, human_gate,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`
    ).run(
      record.roundId,
      record.invocationId,
      record.workflowRunId,
      record.stepRunId,
      record.stepKey,
      record.executorFamily,
      record.attempt,
      record.roundIndex,
      record.state,
      record.classification,
      record.startedAt,
      record.heartbeatAt,
      record.finishedAt,
      record.agentProvider,
      record.model,
      record.effort,
      record.inputDigest,
      record.resultDigest,
      record.artifactRoot,
      JSON.stringify(record.logPaths),
      record.summary,
      JSON.stringify(record.keyChanges),
      JSON.stringify(record.remainingWork),
      JSON.stringify(record.changedFiles),
      record.verificationStatus,
      record.commitSha,
      record.recoveryCode,
      record.humanGate,
      now,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorRoundConflictError(record.roundId);
    }
    throw error;
  }
  return record;
}

/** Load a persisted round; `undefined` when none matches. */
export function loadExecutorRound(
  db: MomentumDb,
  roundId: string
): ExecutorRoundRecord | undefined {
  return loadExecutorRoundSnapshot(db, roundId)?.record;
}

/** List an invocation's rounds, ordered by `round_index`. */
export function listExecutorRoundsForInvocation(
  db: MomentumDb,
  invocationId: string
): ExecutorRoundRecord[] {
  const rows = db
    .prepare(`${ROUND_SELECT} WHERE invocation_id = ? ORDER BY round_index`)
    .all(invocationId) as ExecutorRoundRow[];
  return rows.map(rowToRound);
}

/**
 * The patch applied by {@link updateExecutorRound}. `toState` is required and
 * transition-gated; every other field overwrites only when provided (an explicit
 * `null` clears a column, `undefined` leaves it as-is).
 */
export type ExecutorRoundUpdate = {
  toState: ExecutorRoundState;
  classification?: ExecutorCompletionClassification | null;
  startedAt?: number | null;
  heartbeatAt?: number | null;
  finishedAt?: number | null;
  agentProvider?: string | null;
  model?: string | null;
  effort?: string | null;
  inputDigest?: string | null;
  resultDigest?: string | null;
  artifactRoot?: string | null;
  logPaths?: string[];
  summary?: string | null;
  keyChanges?: string[];
  remainingWork?: string[];
  changedFiles?: string[];
  verificationStatus?: string | null;
  commitSha?: string | null;
  recoveryCode?: string | null;
  humanGate?: ExecutorHumanGateType | null;
};

export type UpdateExecutorRoundOptions = {
  now?: number;
};

/**
 * Transition-gate a round to `update.toState` while capturing any provided
 * normalized-result fields. A round can never reach `succeeded` without first
 * passing through `capturing_result` / `mirroring_external_state`; the refusal
 * leaves the durable row unchanged.
 *
 * @throws {ExecutorRoundNotFoundError} if no round has `roundId`.
 * @throws {ExecutorRoundTransitionError} if the transition is illegal.
 * @throws {InvalidExecutorRecordError} if the merged record carries an unknown
 * classification / human-gate.
 */
export function updateExecutorRound(
  db: MomentumDb,
  roundId: string,
  update: ExecutorRoundUpdate,
  options: UpdateExecutorRoundOptions = {}
): ExecutorRoundRecord {
  const currentSnapshot = loadExecutorRoundSnapshot(db, roundId);
  if (currentSnapshot === undefined) {
    throw new ExecutorRoundNotFoundError(roundId);
  }
  const current = currentSnapshot.record;
  const result = transitionExecutorRound(current.state, update.toState);
  if (!result.ok) {
    throw new ExecutorRoundTransitionError(
      roundId,
      current.state,
      update.toState,
      result.errorCode,
      result.errorMessage
    );
  }
  const next: ExecutorRoundRecord = {
    ...current,
    state: update.toState,
    classification: coalesce(update.classification, current.classification),
    startedAt: coalesce(update.startedAt, current.startedAt),
    heartbeatAt: coalesce(update.heartbeatAt, current.heartbeatAt),
    finishedAt: coalesce(update.finishedAt, current.finishedAt),
    agentProvider: coalesce(update.agentProvider, current.agentProvider),
    model: coalesce(update.model, current.model),
    effort: coalesce(update.effort, current.effort),
    inputDigest: coalesce(update.inputDigest, current.inputDigest),
    resultDigest: coalesce(update.resultDigest, current.resultDigest),
    artifactRoot: coalesce(update.artifactRoot, current.artifactRoot),
    logPaths: coalesce(update.logPaths, current.logPaths),
    summary: coalesce(update.summary, current.summary),
    keyChanges: coalesce(update.keyChanges, current.keyChanges),
    remainingWork: coalesce(update.remainingWork, current.remainingWork),
    changedFiles: coalesce(update.changedFiles, current.changedFiles),
    verificationStatus: coalesce(
      update.verificationStatus,
      current.verificationStatus
    ),
    commitSha: coalesce(update.commitSha, current.commitSha),
    recoveryCode: coalesce(update.recoveryCode, current.recoveryCode),
    humanGate: coalesce(update.humanGate, current.humanGate)
  };
  const errors = validateRoundRecord(next);
  if (errors.length > 0) {
    throw new InvalidExecutorRecordError(errors);
  }
  const now = options.now ?? Date.now();
  const updateResult = db.prepare(
    `UPDATE executor_rounds SET
       state = ?, classification = ?, started_at = ?, heartbeat_at = ?,
       finished_at = ?, agent_provider = ?, model = ?, effort = ?,
       input_digest = ?, result_digest = ?, artifact_root = ?, log_paths = ?,
       summary = ?, key_changes = ?, remaining_work = ?, changed_files = ?,
       verification_status = ?, commit_sha = ?, recovery_code = ?, human_gate = ?,
       updated_at = ?
     WHERE round_id = ? AND state = ? AND updated_at = ?`
  ).run(
    next.state,
    next.classification,
    next.startedAt,
    next.heartbeatAt,
    next.finishedAt,
    next.agentProvider,
    next.model,
    next.effort,
    next.inputDigest,
    next.resultDigest,
    next.artifactRoot,
    JSON.stringify(next.logPaths),
    next.summary,
    JSON.stringify(next.keyChanges),
    JSON.stringify(next.remainingWork),
    JSON.stringify(next.changedFiles),
    next.verificationStatus,
    next.commitSha,
    next.recoveryCode,
    next.humanGate,
    now,
    roundId,
    current.state,
    currentSnapshot.updatedAt
  );
  if (Number(updateResult.changes) === 0) {
    return handleRoundPostWriteConflict(db, roundId, update);
  }
  return next;
}

/** Options shared by the append-only child-evidence inserts. */
export type InsertExecutorEvidenceOptions = {
  now?: number;
};

/**
 * Append an evidence artifact below a round (contract "Required Artifacts"). The
 * `path` is an evidence pointer; the durable row is the proof it exists.
 *
 * @throws {InvalidExecutorRecordError} if `artifactClass` is unknown; no row is
 * written.
 * @throws {ExecutorEvidenceConflictError} if `artifactId` already exists.
 */
export function insertExecutorArtifact(
  db: MomentumDb,
  record: ExecutorArtifactRecord,
  options: InsertExecutorEvidenceOptions = {}
): ExecutorArtifactRecord {
  const errors = validateArtifactRecord(record);
  if (errors.length > 0) {
    throw new InvalidExecutorRecordError(errors);
  }
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_artifacts (
         artifact_id, round_id, artifact_class, path, digest, description,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.artifactId,
      record.roundId,
      record.artifactClass,
      record.path,
      record.digest,
      record.description,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorEvidenceConflictError("artifact", record.artifactId);
    }
    throw error;
  }
  return record;
}

/** List a round's artifacts, oldest first. */
export function listExecutorArtifactsForRound(
  db: MomentumDb,
  roundId: string
): ExecutorArtifactRecord[] {
  const rows = db
    .prepare(
      `SELECT artifact_id, round_id, artifact_class, path, digest, description
         FROM executor_artifacts
        WHERE round_id = ?
        ORDER BY created_at, artifact_id`
    )
    .all(roundId) as ExecutorArtifactRow[];
  return rows.map(rowToArtifact);
}

/**
 * Append a checkpoint to a round's stage stream (contract "Round Lifecycle").
 *
 * @throws {ExecutorEvidenceConflictError} if `checkpointId` already exists or the
 * `(roundId, sequence)` pair collides.
 */
export function insertExecutorCheckpoint(
  db: MomentumDb,
  record: ExecutorCheckpointRecord,
  options: InsertExecutorEvidenceOptions = {}
): ExecutorCheckpointRecord {
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_checkpoints (
         checkpoint_id, round_id, sequence, stage, detail, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      record.checkpointId,
      record.roundId,
      record.sequence,
      record.stage,
      record.detail,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorEvidenceConflictError(
        "checkpoint",
        record.checkpointId
      );
    }
    throw error;
  }
  return record;
}

/** List a round's checkpoints in stage-stream (`sequence`) order. */
export function listExecutorCheckpointsForRound(
  db: MomentumDb,
  roundId: string
): ExecutorCheckpointRecord[] {
  const rows = db
    .prepare(
      `SELECT checkpoint_id, round_id, sequence, stage, detail
         FROM executor_checkpoints
        WHERE round_id = ?
        ORDER BY sequence`
    )
    .all(roundId) as ExecutorCheckpointRow[];
  return rows.map(rowToCheckpoint);
}

/**
 * Append a finding a round surfaced (no-mistakes mirror "Review findings").
 *
 * @throws {ExecutorEvidenceConflictError} if `findingId` already exists.
 */
export function insertExecutorFinding(
  db: MomentumDb,
  record: ExecutorFindingRecord,
  options: InsertExecutorEvidenceOptions = {}
): ExecutorFindingRecord {
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_findings (
         finding_id, round_id, severity, title, detail, selected, external_ref,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.findingId,
      record.roundId,
      record.severity,
      record.title,
      record.detail,
      record.selected ? 1 : 0,
      record.externalRef,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorEvidenceConflictError("finding", record.findingId);
    }
    throw error;
  }
  return record;
}

/** List a round's findings, oldest first. */
export function listExecutorFindingsForRound(
  db: MomentumDb,
  roundId: string
): ExecutorFindingRecord[] {
  const rows = db
    .prepare(
      `SELECT finding_id, round_id, severity, title, detail, selected,
              external_ref
         FROM executor_findings
        WHERE round_id = ?
        ORDER BY created_at, finding_id`
    )
    .all(roundId) as ExecutorFindingRow[];
  return rows.map(rowToFinding);
}

/**
 * Append a durable decision point a round produced (no-mistakes mirror
 * "Decisions and delegated-policy results").
 *
 * @throws {ExecutorEvidenceConflictError} if `decisionId` already exists.
 */
export function insertExecutorDecision(
  db: MomentumDb,
  record: ExecutorDecisionRecord,
  options: InsertExecutorEvidenceOptions = {}
): ExecutorDecisionRecord {
  const now = options.now ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO executor_decisions (
         decision_id, round_id, summary, allowed_actions, recommended_action,
         chosen_action, resolution, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.decisionId,
      record.roundId,
      record.summary,
      JSON.stringify(record.allowedActions),
      record.recommendedAction,
      record.chosenAction,
      record.resolution,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ExecutorEvidenceConflictError("decision", record.decisionId);
    }
    throw error;
  }
  return record;
}

/** List a round's decisions, oldest first. */
export function listExecutorDecisionsForRound(
  db: MomentumDb,
  roundId: string
): ExecutorDecisionRecord[] {
  const rows = db
    .prepare(
      `SELECT decision_id, round_id, summary, allowed_actions, recommended_action,
              chosen_action, resolution
         FROM executor_decisions
        WHERE round_id = ?
        ORDER BY created_at, decision_id`
    )
    .all(roundId) as ExecutorDecisionRow[];
  return rows.map(rowToDecision);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ExecutorDefinitionRow = {
  executor_key: string;
  family: string;
  agent_provider: string | null;
  model: string | null;
  effort: string | null;
  timeout_ms: number | null;
  max_rounds: number | null;
  policy_envelope: string | null;
};

type ExecutorInvocationRow = {
  invocation_id: string;
  workflow_run_id: string;
  step_run_id: string;
  step_key: string;
  executor_family: string;
  state: string;
  attempt: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type ExecutorRoundRow = {
  round_id: string;
  invocation_id: string;
  workflow_run_id: string;
  step_run_id: string;
  step_key: string;
  executor_family: string;
  attempt: number;
  round_index: number;
  state: string;
  classification: string | null;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  agent_provider: string | null;
  model: string | null;
  effort: string | null;
  input_digest: string | null;
  result_digest: string | null;
  artifact_root: string | null;
  log_paths: string;
  summary: string | null;
  key_changes: string;
  remaining_work: string;
  changed_files: string;
  verification_status: string | null;
  commit_sha: string | null;
  recovery_code: string | null;
  human_gate: string | null;
  updated_at: number;
};

type ExecutorInvocationSnapshot = {
  record: ExecutorInvocationRecord;
  updatedAt: number;
};

type ExecutorRoundSnapshot = {
  record: ExecutorRoundRecord;
  updatedAt: number;
};

type ExecutorArtifactRow = {
  artifact_id: string;
  round_id: string;
  artifact_class: string;
  path: string;
  digest: string | null;
  description: string | null;
};

type ExecutorCheckpointRow = {
  checkpoint_id: string;
  round_id: string;
  sequence: number;
  stage: string;
  detail: string | null;
};

type ExecutorFindingRow = {
  finding_id: string;
  round_id: string;
  severity: string | null;
  title: string;
  detail: string | null;
  selected: number;
  external_ref: string | null;
};

type ExecutorDecisionRow = {
  decision_id: string;
  round_id: string;
  summary: string;
  allowed_actions: string;
  recommended_action: string | null;
  chosen_action: string | null;
  resolution: string | null;
};

const ROUND_SELECT = `
  SELECT round_id, invocation_id, workflow_run_id, step_run_id, step_key,
         executor_family, attempt, round_index, state, classification,
         started_at, heartbeat_at, finished_at, agent_provider, model, effort,
         input_digest, result_digest, artifact_root, log_paths,
         summary, key_changes, remaining_work, changed_files,
         verification_status, commit_sha, recovery_code, human_gate,
         updated_at
    FROM executor_rounds`;

function loadExecutorInvocationSnapshot(
  db: MomentumDb,
  invocationId: string
): ExecutorInvocationSnapshot | undefined {
  const row = db
    .prepare(
      `SELECT invocation_id, workflow_run_id, step_run_id, step_key,
              executor_family, state, attempt, started_at, heartbeat_at,
              finished_at, updated_at
         FROM executor_invocations WHERE invocation_id = ?`
    )
    .get(invocationId) as ExecutorInvocationRow | undefined;
  if (row === undefined) return undefined;
  return { record: rowToInvocation(row), updatedAt: row.updated_at };
}

function loadExecutorRoundSnapshot(
  db: MomentumDb,
  roundId: string
): ExecutorRoundSnapshot | undefined {
  const row = db
    .prepare(`${ROUND_SELECT} WHERE round_id = ?`)
    .get(roundId) as ExecutorRoundRow | undefined;
  if (row === undefined) return undefined;
  return { record: rowToRound(row), updatedAt: row.updated_at };
}

function rowToInvocation(row: ExecutorInvocationRow): ExecutorInvocationRecord {
  return {
    invocationId: row.invocation_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    stepKey: row.step_key,
    executorFamily: row.executor_family as WorkflowExecutorFamily,
    state: row.state as ExecutorInvocationState,
    attempt: row.attempt,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at
  };
}

function rowToRound(row: ExecutorRoundRow): ExecutorRoundRecord {
  return {
    roundId: row.round_id,
    invocationId: row.invocation_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    stepKey: row.step_key,
    executorFamily: row.executor_family as WorkflowExecutorFamily,
    attempt: row.attempt,
    roundIndex: row.round_index,
    state: row.state as ExecutorRoundState,
    classification:
      row.classification as ExecutorCompletionClassification | null,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    agentProvider: row.agent_provider,
    model: row.model,
    effort: row.effort,
    inputDigest: row.input_digest,
    resultDigest: row.result_digest,
    artifactRoot: row.artifact_root,
    logPaths: parseStringArray(row.log_paths),
    summary: row.summary,
    keyChanges: parseStringArray(row.key_changes),
    remainingWork: parseStringArray(row.remaining_work),
    changedFiles: parseStringArray(row.changed_files),
    verificationStatus: row.verification_status,
    commitSha: row.commit_sha,
    recoveryCode: row.recovery_code,
    humanGate: row.human_gate as ExecutorHumanGateType | null
  };
}

function rowToArtifact(row: ExecutorArtifactRow): ExecutorArtifactRecord {
  return {
    artifactId: row.artifact_id,
    roundId: row.round_id,
    artifactClass: row.artifact_class as ExecutorArtifactClass,
    path: row.path,
    digest: row.digest,
    description: row.description
  };
}

function rowToCheckpoint(
  row: ExecutorCheckpointRow
): ExecutorCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    roundId: row.round_id,
    sequence: row.sequence,
    stage: row.stage,
    detail: row.detail
  };
}

function rowToFinding(row: ExecutorFindingRow): ExecutorFindingRecord {
  return {
    findingId: row.finding_id,
    roundId: row.round_id,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    selected: row.selected !== 0,
    externalRef: row.external_ref
  };
}

function rowToDecision(row: ExecutorDecisionRow): ExecutorDecisionRecord {
  return {
    decisionId: row.decision_id,
    roundId: row.round_id,
    summary: row.summary,
    allowedActions: parseStringArray(row.allowed_actions),
    recommendedAction: row.recommended_action,
    chosenAction: row.chosen_action,
    resolution: row.resolution
  };
}

function validateDefinitionRecord(
  record: ExecutorDefinitionRecord
): ExecutorRecordValidationError[] {
  const errors: ExecutorRecordValidationError[] = [];
  if (!isWorkflowExecutorFamily(record.family)) {
    errors.push({
      code: "executor_definition_unknown_family",
      message: `unknown executor family: ${String(record.family)}`
    });
  }
  return errors;
}

function validateInvocationRecord(
  record: ExecutorInvocationRecord
): ExecutorRecordValidationError[] {
  const errors: ExecutorRecordValidationError[] = [];
  if (!isWorkflowExecutorFamily(record.executorFamily)) {
    errors.push({
      code: "executor_invocation_unknown_family",
      message: `unknown executor family: ${String(record.executorFamily)}`
    });
  }
  if (!INVOCATION_STATE_SET.has(record.state)) {
    errors.push({
      code: "executor_invocation_unknown_state",
      message: `unknown executor invocation state: ${String(record.state)}`
    });
  }
  return errors;
}

function validateRoundRecord(
  record: ExecutorRoundRecord
): ExecutorRecordValidationError[] {
  const errors: ExecutorRecordValidationError[] = [];
  if (!isWorkflowExecutorFamily(record.executorFamily)) {
    errors.push({
      code: "executor_round_unknown_family",
      message: `unknown executor family: ${String(record.executorFamily)}`
    });
  }
  if (!ROUND_STATE_SET.has(record.state)) {
    errors.push({
      code: "executor_round_unknown_state",
      message: `unknown executor round state: ${String(record.state)}`
    });
  }
  if (record.classification !== null && !CLASSIFICATION_SET.has(record.classification)) {
    errors.push({
      code: "executor_round_unknown_classification",
      message: `unknown completion classification: ${String(record.classification)}`
    });
  }
  if (record.humanGate !== null && !GATE_TYPE_SET.has(record.humanGate)) {
    errors.push({
      code: "executor_round_unknown_human_gate",
      message: `unknown human gate type: ${String(record.humanGate)}`
    });
  }
  return errors;
}

function validateArtifactRecord(
  record: ExecutorArtifactRecord
): ExecutorRecordValidationError[] {
  const errors: ExecutorRecordValidationError[] = [];
  if (!ARTIFACT_CLASS_SET.has(record.artifactClass)) {
    errors.push({
      code: "executor_artifact_unknown_class",
      message: `unknown artifact class: ${String(record.artifactClass)}`
    });
  }
  return errors;
}

function handleInvocationPostWriteConflict(
  db: MomentumDb,
  invocationId: string,
  toState: ExecutorInvocationState,
  options: UpdateExecutorInvocationOptions
): ExecutorInvocationRecord {
  const current = loadExecutorInvocation(db, invocationId);
  if (current === undefined) {
    throw new ExecutorInvocationNotFoundError(invocationId);
  }
  if (current.state === toState && invocationPatchMatches(current, options)) {
    return current;
  }
  throw new ExecutorInvocationTransitionError(
    invocationId,
    current.state,
    toState,
    "executor_invocation_invalid_transition",
    `executor invocation ${invocationId} changed concurrently; refusing ambiguous ${toState} update`
  );
}

function handleRoundPostWriteConflict(
  db: MomentumDb,
  roundId: string,
  update: ExecutorRoundUpdate
): ExecutorRoundRecord {
  const current = loadExecutorRound(db, roundId);
  if (current === undefined) {
    throw new ExecutorRoundNotFoundError(roundId);
  }
  if (current.state === update.toState && roundPatchMatches(current, update)) {
    return current;
  }
  throw new ExecutorRoundTransitionError(
    roundId,
    current.state,
    update.toState,
    "executor_round_invalid_transition",
    `executor round ${roundId} changed concurrently; refusing ambiguous ${update.toState} update`
  );
}

function invocationPatchMatches(
  current: ExecutorInvocationRecord,
  options: UpdateExecutorInvocationOptions
): boolean {
  return (
    fieldMatches(current.startedAt, options.startedAt) &&
    fieldMatches(current.heartbeatAt, options.heartbeatAt) &&
    fieldMatches(current.finishedAt, options.finishedAt)
  );
}

function roundPatchMatches(
  current: ExecutorRoundRecord,
  update: ExecutorRoundUpdate
): boolean {
  return (
    fieldMatches(current.classification, update.classification) &&
    fieldMatches(current.startedAt, update.startedAt) &&
    fieldMatches(current.heartbeatAt, update.heartbeatAt) &&
    fieldMatches(current.finishedAt, update.finishedAt) &&
    fieldMatches(current.agentProvider, update.agentProvider) &&
    fieldMatches(current.model, update.model) &&
    fieldMatches(current.effort, update.effort) &&
    fieldMatches(current.inputDigest, update.inputDigest) &&
    fieldMatches(current.resultDigest, update.resultDigest) &&
    fieldMatches(current.artifactRoot, update.artifactRoot) &&
    arrayFieldMatches(current.logPaths, update.logPaths) &&
    fieldMatches(current.summary, update.summary) &&
    arrayFieldMatches(current.keyChanges, update.keyChanges) &&
    arrayFieldMatches(current.remainingWork, update.remainingWork) &&
    arrayFieldMatches(current.changedFiles, update.changedFiles) &&
    fieldMatches(current.verificationStatus, update.verificationStatus) &&
    fieldMatches(current.commitSha, update.commitSha) &&
    fieldMatches(current.recoveryCode, update.recoveryCode) &&
    fieldMatches(current.humanGate, update.humanGate)
  );
}

function fieldMatches<T>(current: T, update: T | undefined): boolean {
  return update === undefined || current === update;
}

function arrayFieldMatches(
  current: readonly string[],
  update: readonly string[] | undefined
): boolean {
  return (
    update === undefined ||
    (current.length === update.length &&
      current.every((value, index) => value === update[index]))
  );
}

function parseStringArray(text: string): string[] {
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
}

function coalesce<T>(next: T | undefined, previous: T): T {
  return next !== undefined ? next : previous;
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in transaction; nothing to do.
  }
}
