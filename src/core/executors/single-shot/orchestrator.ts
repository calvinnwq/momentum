/**
 * Single-shot executor adapter — single-round driver.
 *
 * `single-shot/executor.ts` owns the *pure* projections for one single-shot
 * invocation: the durable invocation/round identity, the deterministic
 * agent/model selection, the round-start record, the daemon classification +
 * two-phase persistence patches, and the artifact / checkpoint projections. This
 * module is the stateful seam that composes those projections with the *real*
 * executor-loop persistence layer and round transition graph around the
 * bounded mechanism, exactly the way `goal-loop/orchestrator.ts` composes the
 * goal-loop projections — but simpler, because a single shot owns exactly one
 * round and never loops:
 *
 *   insert the invocation row     (running, deterministic reattachable id)
 *   -> insert the round-start row (running, agent/model/input frozen in)
 *   -> run the bounded mechanism  (the one-shot agent pass / the script command)
 *   -> persist the round's evidence artifacts (contract "Required Artifacts")
 *   -> run capture/result transition  (running -> capturing_result)
 *   -> persist non-terminal lifecycle checkpoints
 *   -> atomically persist the terminal decision, classification checkpoint,
 *      and invocation settlement (-> succeeded / failed / blocked / manual)
 *
 * {@link runSingleShotStep} is the single entrypoint a daemon / scheduler calls
 * with a `StepRun` identity: it {@link planSingleShotInvocation | materializes}
 * the durable single-shot `executor_invocations` row with a deterministic,
 * reattachable id, then drives the one round through {@link runSingleShotRound}
 * and settles the invocation. There is no invocation loop and no
 * `invocationStateForRoundClassification` indirection: the single-shot decision
 * already carries the invocation state (one round *is* the invocation), and every
 * accepted single-shot invocation state — `succeeded` / `blocked` / `failed` /
 * `manual_recovery_required` — is terminal and receives a stamped `finished_at`.
 * A thrown runner or cleanup boundary can deliberately leave the invocation in
 * flight for recovery instead of manufacturing a terminal classification.
 * A re-run is a fresh `attempt` minting a fresh invocation, never a `continue`.
 *
 * The bounded mechanism is injected as a {@link SingleShotRoundRunner} so the real
 * one-shot mechanism (an agent/review pass producing a normalized result
 * document), the real script mechanism (a deterministic local command, exit-code
 * based), a no-op, or a deterministic fake can all drive the round through the
 * identical durable lifecycle. The two families differ only in what the mechanism
 * returns — `one-shot` captures a {@link RunnerResult} document, `script` is
 * exit-code based with no result document — and the driver stays family-agnostic:
 * it routes the normalized {@link SingleShotInvocationOutcome} through the pure
 * decision so the verification-authority and repo-safety boundaries hold end to
 * end.
 *
 * Ordinary mechanism outcomes encode failures as recovery codes in
 * {@link SingleShotInvocationOutcome} (and a `null` / absent result), mirroring
 * `decideSingleShotInvocation`. Cooperative cancellation propagates the signal
 * reason only after verified process and repository cleanup. Supervisor or
 * cleanup failures throw and preserve the durable in-flight state. Two ordering
 * invariants tie the lifecycle to the contract:
 *
 *   - The durable invocation and round-start rows are inserted *before* the
 *     mechanism runs (contract Round Lifecycle step 4), so a lost process leaves a
 *     durable `running` invocation/round for recovery rather than no evidence.
 *   - A *successful* outcome captures (running -> capturing_result) before
 *     terminalizing — even a `script` success with no result document emits a bare
 *     capture, because the round transition graph forbids `running -> succeeded`
 *     directly. A non-success outcome captures nothing and transitions from
 *     `running` straight to its terminal abort state, never inventing a result.
 *     The `result_captured` checkpoint, by contrast, appears only when a result
 *     *document* was actually captured (one-shot on success), never for a bare
 *     script capture — so the durable checkpoint stream stays honest about whether
 *     a result document exists.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
} from "../loop/persist.js";
import {
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorInvocationRecord,
  type ExecutorRoundRecord,
} from "../loop/reducer.js";
import { createDurableExecutorEnvelope } from "../sdk/envelope.js";
import {
  planSingleShotInvocation,
  planSingleShotRoundStart,
  planSingleShotRoundStartForInvocation,
  type PlanSingleShotRoundStartInput,
  type SingleShotDecision,
  type SingleShotRoundRuntimeInputs,
  type SingleShotRoundSelection,
} from "./executor.js";
import {
  SingleShotExecutor,
  singleShotExecutorConfigError,
  singleShotSdkConfigFromSelection,
  singleShotSelectionFromSdkConfig,
  type AgentOnceExecutorConfig,
  type ScriptExecutorConfig,
  type SingleShotExecutorConfig,
  type SingleShotRoundRunner,
} from "./sdk.js";

export type {
  HybridSingleShotRoundRunner,
  SingleShotRoundMechanismResult,
  SingleShotRoundRunner,
  SynchronousSingleShotRoundRunner,
} from "./sdk.js";

/**
 * Inputs for driving or resuming one single-shot round through the durable SDK
 * envelope.
 */
export type RunSingleShotRoundInput = {
  db: MomentumDb;
  /** The round-start projection inputs (identity, resolved selection, input evidence, start clock). */
  start: PlanSingleShotRoundStartInput;
  /** The bounded mechanism for a new round; completed reattach skips it. */
  runRound: SingleShotRoundRunner;
  /** Portable SDK config. Required for script command identity. */
  config?: SingleShotExecutorConfig;
  /** Caller-owned cancellation for the bounded turn. */
  signal?: AbortSignal;
  /** Daemon clock read for each durable write, including terminal settlement. */
  now?: () => number;
  /** Fixed compatibility clock for direct callers and deterministic tests. */
  finishedAt?: number;
  /** Host proof that this call atomically materialized the new round with its invocation. */
  roundAlreadyMaterialized?: boolean;
};

/**
 * The durable result of one finished single-shot round: the persisted terminal
 * round record, the daemon's decision (its `invocationState` settles the owning
 * invocation), and the durable evidence rows persisted below the round.
 */
export type RunSingleShotRoundResult = {
  round: ExecutorRoundRecord;
  invocation: ExecutorInvocationRecord;
  decision: SingleShotDecision;
  /** The durable artifact rows persisted below the round, in contract order. */
  artifacts: ExecutorArtifactRecord[];
  /** The durable checkpoint-stream rows persisted below the round, sequenced from 0. */
  checkpoints: ExecutorCheckpointRecord[];
};

/**
 * Drive a new bounded single-shot round, or resume classification for completed
 * durable work, through its round-record lifecycle.
 * See the module doc for the ordered contract.
 *
 * Reattaches a matching non-terminal round only when its durable
 * `mechanism_completed` checkpoint proves the bounded mechanism already
 * finished; it resumes classification without running the mechanism again.
 *
 * @throws {ExecutorRoundConflictError} if first materialization collides with a
 * different durable round id / `(invocation, index)` owner.
 * @throws {Error} if an existing round is terminal, incomplete, or does not
 * match the current dispatch binding.
 * @throws {Error} if the outcome carries an unknown recovery code (via
 * {@link planSingleShotRoundPersistence}).
 */
export async function runSingleShotRound(
  input: RunSingleShotRoundInput,
): Promise<RunSingleShotRoundResult> {
  const { db, start, runRound } = input;
  const fixedFinishedAt = input.finishedAt;
  const now =
    input.now ??
    (fixedFinishedAt === undefined ? Date.now : () => fixedFinishedAt);
  const derivedConfig = singleShotSdkConfigFromSelection(
    start.family,
    start.selection,
  );
  if (input.config !== undefined) {
    const explicitConfigError = singleShotExecutorConfigError(
      start.family,
      input.config,
    );
    if (explicitConfigError !== null) throw new Error(explicitConfigError);
  }
  const config = mergeSingleShotConfig(derivedConfig, input.config);
  const configError = singleShotExecutorConfigError(start.family, config);
  if (configError !== null) throw new Error(configError);
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId: start.invocationId,
    now,
  });
  const executor = new SingleShotExecutor(start.family, runRound);
  const { selection: _selection, ...sdkStart } = start;

  // The built-in now performs its bounded turn through the exact public SDK
  // contract: durable state + config + host bindings + envelope, never SQLite.
  const signal = input.signal ?? new AbortController().signal;
  let tick: Awaited<ReturnType<SingleShotExecutor["tick"]>>;
  try {
    tick = await executor.tick({
      state: envelope.snapshot(),
      config,
      hostBindings: {
        start: sdkStart,
        ...(input.roundAlreadyMaterialized === true
          ? { roundAlreadyMaterialized: true }
          : {}),
      },
      envelope: envelope.facade,
      signal,
    });
  } catch (error) {
    const snapshot = envelope.snapshot();
    const currentRound = snapshot.currentRound;
    const current = currentRound?.round;
    if (
      signal.aborted &&
      error === signal.reason &&
      current?.roundId === start.roundId &&
      !isTerminalExecutorRoundState(current.state)
    ) {
      envelope.applyDaemonDecision(
        {
          roundId: current.roundId,
          classification: "cancelled",
          executorRecommendation: null,
          roundState: "cancelled",
          invocationState: "cancelled",
          recoveryCode: null,
          humanGate: null,
        },
        {
          allocateClassificationCheckpointIdentity: true,
          classificationCheckpoint: {
            stage: "classified",
            detail: "classification: cancelled",
          },
        },
      );
    }
    throw error;
  }

  // This compatibility driver is the daemon owner for the existing single-shot
  // path. It explicitly accepts the recommendation; the executor-facing facade
  // itself has no terminal-classification method.
  const applied = envelope.applyDaemonDecision(
    {
      roundId: tick.roundId,
      classification: tick.recommendation,
      executorRecommendation: tick.recommendation,
      roundState: tick.recommendedRoundState,
      invocationState: tick.recommendedInvocationState,
      recoveryCode: tick.recoveryCode,
      humanGate: tick.humanGate,
    },
    {
      allocateClassificationCheckpointIdentity: true,
      classificationCheckpoint: {
        stage: tick.classificationCheckpoint.stage,
        detail: tick.classificationCheckpoint.detail,
      },
    },
  );
  return {
    round: applied.round,
    invocation: applied.invocation,
    decision: tick.decision,
    artifacts: [...tick.artifacts],
    checkpoints: [...tick.checkpoints, applied.classificationCheckpoint],
  };
}

function mergeSingleShotConfig(
  derived: SingleShotExecutorConfig,
  explicit: SingleShotExecutorConfig | undefined,
): SingleShotExecutorConfig {
  if (explicit === undefined) return derived;
  const agent =
    derived.agent === undefined && explicit.agent === undefined
      ? undefined
      : { ...derived.agent, ...explicit.agent };
  return {
    ...derived,
    ...explicit,
    ...(agent !== undefined ? { agent } : {}),
  };
}

/**
 * The inputs to {@link runSingleShotStep}: the `StepRun` identity
 * (`workflowRunId` / `stepRunId` / `stepKey` / `attempt`), the single-shot
 * `family`, the resolved {@link SingleShotRoundSelection} the round runs under, the
 * bounded mechanism, a per-round runtime-input resolver, and a clock. The adapter
 * mints the invocation / round identities itself, so the caller supplies a
 * `StepRun`, not pre-built executor-loop records. Unlike the goal-loop step there
 * is no `maxRounds` and the runtime resolver takes no round index — a single shot
 * is always the one round at index 0.
 */
type RunSingleShotStepBase = {
  db: MomentumDb;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  /** Re-run counter; a fresh attempt mints a fresh invocation, never mutating the prior one. */
  attempt: number;
  /** The deterministic selection (from `resolveSingleShotRoundSelection`) frozen into the round. */
  selection: SingleShotRoundSelection;
  /** The bounded mechanism for a new round; completed reattach skips it. */
  runRound: SingleShotRoundRunner;
  /** Caller-owned cancellation for the bounded turn. */
  signal?: AbortSignal;
  /** Resolves the round's input digest / artifact root / log paths the daemon provides. */
  resolveRoundInputs: () => SingleShotRoundRuntimeInputs;
  /** Clock for the invocation + round timestamps; defaults to {@link Date.now}. */
  now?: () => number;
};

export type RunSingleShotStepInput =
  | (RunSingleShotStepBase & {
      /** Agent-once uses the resolved selection when portable config is omitted. */
      family: "one-shot";
      config?: AgentOnceExecutorConfig;
    })
  | (RunSingleShotStepBase & {
      /** Scripts require a portable command identity before durable materialization. */
      family: "script";
      config: ScriptExecutorConfig;
    });

/**
 * The durable result of one finished single-shot step: the persisted terminal
 * invocation record and the single round outcome it drove. There is no round array
 * (a single shot owns exactly one round); the round's decision is what settled the
 * invocation.
 */
export type RunSingleShotStepResult = {
  invocation: ExecutorInvocationRecord;
  round: RunSingleShotRoundResult;
};

/**
 * The single-shot executor adapter "below `StepRun`" (contract "State Model":
 * `StepRun -> ExecutorInvocation -> ExecutorRound[]`, here exactly one round).
 * This is the single entrypoint a daemon / scheduler calls with a step-run
 * identity: it {@link planSingleShotInvocation | materializes} the durable
 * single-shot `executor_invocations` row with a deterministic, reattachable id,
 * drives the one round through {@link runSingleShotRound} (materializing the
 * round's identity via {@link planSingleShotRoundStartForInvocation} so the round
 * inherits the invocation's identity and family and the deterministic
 * {@link singleShotRoundId}), then settles the invocation into the round
 * decision's terminal state.
 *
 * The adapter owns the deterministic id scheme so no caller reinvents it: an
 * invocation reattaches from `(workflowRunId, stepRunId, family, attempt)` and the
 * round from the invocation id alone (a single shot is always round 0), both
 * recomputable from durable state (contract "Heartbeat And Reattach"). The
 * resolved selection is frozen into the round before work runs (contract "Agent
 * And Model Selection") and the round's input digest / artifact root / log paths
 * come from the injected {@link RunSingleShotStepInput.resolveRoundInputs} (the
 * daemon's filesystem concern, never invented here).
 *
 * Invocation settle: the single-shot decision carries the invocation state
 * directly (one round *is* the invocation), so round classification, its
 * checkpoint, and invocation settlement commit in one transaction.
 *
 * Clocks: the invocation start, round start, durable observations, and terminal
 * settlement are stamped from the injected `now`. Any terminal read after new
 * work happens after the awaited mechanism, so asynchronous rounds preserve
 * lifecycle order.
 *
 * A matching non-terminal invocation reattaches only through its durable round
 * dispatch binding; a terminal duplicate remains a conflict, and a genuine
 * re-run must use a fresh `attempt`.
 *
 * @throws {ExecutorInvocationConflictError} if the deterministic invocation id
 * already belongs to a terminal attempt.
 * @throws {ExecutorRoundConflictError} if first round materialization collides
 * with a different durable owner (via {@link runSingleShotRound}).
 * @throws {Error} if a non-terminal invocation has no durable round binding or
 * its existing round does not match the current dispatch inputs.
 */
export async function runSingleShotStep(
  input: RunSingleShotStepInput,
): Promise<RunSingleShotStepResult> {
  const now = input.now ?? Date.now;
  const { db } = input;
  input.signal?.throwIfAborted();
  if (input.config !== undefined) {
    const explicitConfigError = singleShotExecutorConfigError(
      input.family,
      input.config,
    );
    if (explicitConfigError !== null) throw new Error(explicitConfigError);
  }
  const effectiveConfig = mergeSingleShotConfig(
    singleShotSdkConfigFromSelection(input.family, input.selection),
    input.config,
  );
  const configError = singleShotExecutorConfigError(
    input.family,
    effectiveConfig,
  );
  if (configError !== null) throw new Error(configError);
  const effectiveSelection = singleShotSelectionFromSdkConfig(effectiveConfig);

  // Resolve caller-owned clocks and filesystem inputs before insertion. If one
  // aborts or throws, no invocation exists without a round to carry recovery.
  const invocationStartedAt = now();
  const roundStartedAt = now();
  const runtime = input.resolveRoundInputs();
  input.signal?.throwIfAborted();

  // 1. Plan the durable invocation and its sole round before any external work.
  //    A new dispatch inserts both rows in one transaction, so a crash can leave
  //    either no owner or a complete recovery binding, never an invocation-only
  //    owner that deterministic reattach cannot classify.
  const plannedInvocation = planSingleShotInvocation({
    family: input.family,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    attempt: input.attempt,
    startedAt: invocationStartedAt,
  });
  const existingInvocation = loadExecutorInvocation(
    db,
    plannedInvocation.invocationId,
  );
  let invocation = plannedInvocation;
  let start = planSingleShotRoundStartForInvocation({
    invocation: plannedInvocation,
    selection: effectiveSelection,
    runtime,
    startedAt: roundStartedAt,
  });
  let roundAlreadyMaterialized = false;
  if (
    existingInvocation === undefined ||
    isTerminalExecutorInvocationState(existingInvocation.state)
  ) {
    // A terminal duplicate still conflicts on invocation identity. The
    // transaction rolls back the invocation if round insertion fails.
    materializeSingleShotDispatch(
      db,
      plannedInvocation,
      planSingleShotRoundStart(start),
      invocationStartedAt,
    );
    roundAlreadyMaterialized = true;
  } else {
    assertMatchingSingleShotInvocation(existingInvocation, plannedInvocation);
    if (
      listExecutorRoundsForInvocation(db, existingInvocation.invocationId)
        .length === 0
    ) {
      throw new Error(
        `Cannot reattach executor invocation ${existingInvocation.invocationId}: no durable round dispatch binding exists.`,
      );
    }
    invocation = existingInvocation;
    start = planSingleShotRoundStartForInvocation({
      invocation,
      selection: effectiveSelection,
      runtime,
      startedAt: roundStartedAt,
    });
  }

  // 2. Drive the atomically materialized new round, or reattach the existing
  //    durable round, through its lifecycle.
  const round = await runSingleShotRound({
    db,
    start,
    runRound: input.runRound,
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(roundAlreadyMaterialized ? { roundAlreadyMaterialized: true } : {}),
    now,
  });

  return { invocation: round.invocation, round };
}

let materializationTransactionSequence = 0;

function materializeSingleShotDispatch(
  db: MomentumDb,
  invocation: ExecutorInvocationRecord,
  round: ExecutorRoundRecord,
  now: number,
): void {
  const nested = db.isTransaction;
  const savepoint = `single_shot_materialize_${(materializationTransactionSequence += 1)}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    insertExecutorInvocation(db, invocation, { now });
    insertExecutorRound(db, round, { now });
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
  } catch (error) {
    rollbackMaterialization(db, nested ? savepoint : null);
    throw error;
  }
}

function rollbackMaterialization(
  db: MomentumDb,
  savepoint: string | null,
): void {
  try {
    if (savepoint === null) {
      db.exec("ROLLBACK");
      return;
    }
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch {
    // Preserve the original insertion failure if SQLite closed the transaction.
  }
}

function assertMatchingSingleShotInvocation(
  existing: ExecutorInvocationRecord,
  planned: ExecutorInvocationRecord,
): void {
  const identityFields = [
    "invocationId",
    "workflowRunId",
    "stepRunId",
    "stepKey",
    "executorFamily",
    "attempt",
  ] as const;
  const mismatch = identityFields.find(
    (field) => existing[field] !== planned[field],
  );
  if (mismatch !== undefined) {
    throw new Error(
      `Cannot reattach executor invocation ${planned.invocationId}: durable ${mismatch} does not match this dispatch.`,
    );
  }
}
