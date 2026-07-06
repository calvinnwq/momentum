/**
 * Single-shot executor adapter — single-round driver (M10-06, NGX-350).
 *
 * `single-shot/executor.ts` owns the *pure* projections for one single-shot
 * invocation: the durable invocation/round identity, the deterministic
 * agent/model selection, the round-start record, the daemon classification +
 * two-phase persistence patches, and the artifact / checkpoint projections. This
 * module is the stateful seam that composes those projections with the *real*
 * M10-03 executor-loop persistence layer and round transition graph around the
 * bounded mechanism, exactly the way `goal-loop/orchestrator.ts` composes the
 * goal-loop projections — but simpler, because a single shot owns exactly one
 * round and never loops:
 *
 *   insert the invocation row     (running, deterministic reattachable id)
 *   -> insert the round-start row (running, agent/model/input frozen in)
 *   -> run the bounded mechanism  (the one-shot agent pass / the script command)
 *   -> persist the round's evidence artifacts (contract "Required Artifacts")
 *   -> run capture/result transition  (running -> capturing_result)
 *   -> persist the terminal decision  (-> succeeded / failed / blocked / manual)
 *   -> persist the round's lifecycle checkpoint stream (contract step 7)
 *   -> settle the invocation into the round decision's terminal state
 *
 * {@link runSingleShotStep} is the single entrypoint a daemon / scheduler calls
 * with a `StepRun` identity: it {@link planSingleShotInvocation | materializes}
 * the durable single-shot `executor_invocations` row with a deterministic,
 * reattachable id, then drives the one round through {@link runSingleShotRound}
 * and settles the invocation. There is no invocation loop and no
 * `invocationStateForRoundClassification` indirection: the single-shot decision
 * already carries the invocation state (one round *is* the invocation), and every
 * single-shot invocation state — `succeeded` / `blocked` / `failed` /
 * `manual_recovery_required` — is terminal, so the invocation always settles with
 * a stamped `finished_at`. A re-run is a fresh `attempt` minting a fresh
 * invocation, never a `continue`.
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
 * The mechanism is *total*: it encodes every failure as a recovery code in its
 * {@link SingleShotInvocationOutcome} (and a `null` / absent result) rather than
 * throwing, mirroring `decideSingleShotInvocation`. Two ordering invariants tie
 * the lifecycle to the contract:
 *
 *   - The durable invocation and round-start rows are inserted *before* the
 *     mechanism runs (contract Round Lifecycle step 4), so a lost process leaves a
 *     durable `running` invocation/round to reattach to rather than no evidence.
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
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorInvocation,
  insertExecutorRound,
  updateExecutorInvocationState,
  updateExecutorRound
} from "../loop/persist.js";
import {
  isTerminalExecutorInvocationState,
  type ExecutorArtifactRecord,
  type ExecutorCheckpointRecord,
  type ExecutorInvocationRecord,
  type ExecutorRoundRecord
} from "../loop/reducer.js";
import type { RunnerResult } from "../runner/types.js";
import {
  planSingleShotInvocation,
  planSingleShotRoundArtifacts,
  planSingleShotRoundCheckpoints,
  planSingleShotRoundPersistence,
  planSingleShotRoundStart,
  planSingleShotRoundStartForInvocation,
  type PlanSingleShotRoundStartInput,
  type SingleShotDecision,
  type SingleShotExecutorFamily,
  type SingleShotInvocationOutcome,
  type SingleShotRoundArtifacts,
  type SingleShotRoundEvidence,
  type SingleShotRoundRuntimeInputs,
  type SingleShotRoundSelection
} from "./executor.js";

/**
 * The output of one bounded single-shot mechanism run, normalized for the driver.
 * The {@link outcome} is what {@link planSingleShotRoundPersistence} and
 * {@link planSingleShotRoundCheckpoints} consume, so the mechanism stays decoupled
 * from the durable schema and from how each family produced the outcome (the
 * one-shot family maps an M9 finalize result, the script family maps an exit
 * code).
 */
export type SingleShotRoundMechanismResult = {
  /**
   * The normalized invocation outcome the daemon classifies: `ok` on a successful
   * command/agent/script run (any repo finalization already proven safe), or the
   * precise {@link SingleShotInvocationOutcome} recovery code on failure.
   */
  outcome: SingleShotInvocationOutcome;
  /**
   * The normalized result document a one-shot success captured. Omitted / `null`
   * for the exit-code-based `script` family and for any non-success outcome; the
   * driver then emits a bare capture (script success) or no capture (failure), and
   * the `result_captured` checkpoint appears only when this is non-null.
   */
  result?: RunnerResult | null;
  /**
   * The content digest of the captured result document (the round-schema
   * `result_digest` reattach fingerprint), or omitted / `null` when the round
   * produced no usable result. Consistent with {@link result} by construction.
   */
  resultDigest?: string | null;
  /**
   * The evidence pointers the round wrote (contract "Required Artifacts"), per
   * artifact class except `logs` (the driver derives those from the round-start
   * record's frozen `logPaths`). Omitted when the mechanism reports no extra
   * artifacts; the driver still records the `logs` rows.
   */
  artifacts?: SingleShotRoundArtifacts;
  /**
   * The verification / commit / changed-file evidence the round reports for its
   * terminal patch. Omitted when the round ran no verification and committed
   * nothing (a bare failure), so the round-start record's null / empty fields stay
   * in place.
   */
  evidence?: SingleShotRoundEvidence;
};

/**
 * The bounded mechanism a single-shot round runs. Receives the durable round-start
 * record (its frozen agent/model/effort, input digest, artifact root, and
 * identity) and returns the round's normalized outcome + optional result /
 * evidence / artifacts. It must be total — encode failures as recovery codes in
 * the outcome rather than throwing — mirroring `decideSingleShotInvocation`. The
 * concrete one-shot and script mechanisms plug in here; the daemon wiring that
 * runs the agent / command then calls them inside this closure. Tests inject a
 * deterministic fake.
 */
export type SingleShotRoundRunner = (
  round: ExecutorRoundRecord
) => SingleShotRoundMechanismResult;

function validateSingleShotMechanismResult(
  family: SingleShotExecutorFamily,
  mechanism: SingleShotRoundMechanismResult
): void {
  if (mechanism.resultDigest != null && mechanism.result == null) {
    throw new Error(
      `Invalid ${family} mechanism output: resultDigest requires a result document.`
    );
  }
  if (family === "script" && mechanism.result != null) {
    throw new Error(
      "Invalid script mechanism output: script rounds must not capture a result document."
    );
  }
  if (family === "script" && mechanism.artifacts?.resultDocument != null) {
    throw new Error(
      "Invalid script mechanism output: script rounds must not report a result document artifact."
    );
  }
  if (!mechanism.outcome.ok) return;
  if (family === "one-shot") {
    if (mechanism.result == null) {
      throw new Error(
        "Invalid one-shot mechanism output: successful rounds require a result document."
      );
    }
    if (mechanism.result.success !== true) {
      throw new Error(
        "Invalid one-shot mechanism output: successful one-shot rounds require a successful result document."
      );
    }
  }
}

export type RunSingleShotRoundInput = {
  db: MomentumDb;
  /** The round-start projection inputs (identity, resolved selection, input evidence, start clock). */
  start: PlanSingleShotRoundStartInput;
  /** The bounded mechanism to run for the round. */
  runRound: SingleShotRoundRunner;
  /** Daemon clock stamped as the round's `finished_at` / terminal `heartbeat_at`. */
  finishedAt: number;
};

/**
 * The durable result of one finished single-shot round: the persisted terminal
 * round record, the daemon's decision (its `invocationState` settles the owning
 * invocation), and the durable evidence rows persisted below the round.
 */
export type RunSingleShotRoundResult = {
  round: ExecutorRoundRecord;
  decision: SingleShotDecision;
  /** The durable artifact rows persisted below the round, in contract order. */
  artifacts: ExecutorArtifactRecord[];
  /** The durable checkpoint-stream rows persisted below the round, sequenced from 0. */
  checkpoints: ExecutorCheckpointRecord[];
};

/**
 * Drive one bounded single-shot round end to end through its durable round-record
 * lifecycle. See the module doc for the ordered contract.
 *
 * @throws {ExecutorRoundConflictError} if the round id / `(invocation, index)`
 * already exists (a durable round is the proof a bounded unit started, not an
 * idempotent re-ingest).
 * @throws {Error} if the outcome carries an unknown recovery code (via
 * {@link planSingleShotRoundPersistence}).
 */
export function runSingleShotRound(
  input: RunSingleShotRoundInput
): RunSingleShotRoundResult {
  const { db, start, runRound, finishedAt } = input;

  // 1. Insert the durable round-start row before any external work runs.
  const startRecord = planSingleShotRoundStart(start);
  const frozenLogPaths = [...startRecord.logPaths];
  insertExecutorRound(db, startRecord, { now: start.startedAt });

  // 2. Run the bounded mechanism. It is total: failures come back as a recovery
  //    code in the outcome (and an absent result), never as a throw.
  const mechanism = runRound({
    ...startRecord,
    logPaths: [...frozenLogPaths],
    keyChanges: [...startRecord.keyChanges],
    keyLearnings: [...startRecord.keyLearnings],
    remainingWork: [...startRecord.remainingWork],
    changedFiles: [...startRecord.changedFiles]
  });
  validateSingleShotMechanismResult(start.family, mechanism);

  const plan = planSingleShotRoundPersistence({
    outcome: mechanism.outcome,
    ...(mechanism.result !== undefined ? { result: mechanism.result } : {}),
    ...(mechanism.resultDigest !== undefined
      ? { resultDigest: mechanism.resultDigest }
      : {}),
    ...(mechanism.evidence !== undefined ? { evidence: mechanism.evidence } : {})
  });

  // 3. Persist the round's evidence artifacts (contract "Required Artifacts").
  //    The round-start row already exists, so each artifact's FK to it holds;
  //    `logs` come from the frozen logPaths, the rest from what the mechanism
  //    reported.
  const artifacts = planSingleShotRoundArtifacts({
    roundId: start.roundId,
    logPaths: frozenLogPaths,
    ...(mechanism.artifacts !== undefined
      ? { artifacts: mechanism.artifacts }
      : {})
  });
  for (const artifact of artifacts) {
    insertExecutorArtifact(db, artifact, { now: finishedAt });
  }

  // 4. Run the capture transition (normalized result for one-shot success, bare
  //    transition for script success) then persist the terminal decision,
  //    stamping the daemon clock the pure projection cannot supply.
  if (plan.captureUpdate !== null) {
    updateExecutorRound(db, start.roundId, plan.captureUpdate, {
      now: finishedAt
    });
  }
  const round = updateExecutorRound(
    db,
    start.roundId,
    { ...plan.terminalUpdate, heartbeatAt: finishedAt, finishedAt },
    { now: finishedAt }
  );

  // 5. Persist the round's coarse lifecycle checkpoint stream (contract Round
  //    Lifecycle step 7). `capturedResult` is whether a *result document* was
  //    actually captured (one-shot on success) — not merely whether the capture
  //    transition ran — so a bare script success omits `result_captured`.
  const checkpoints = planSingleShotRoundCheckpoints({
    roundId: start.roundId,
    outcome: mechanism.outcome,
    capturedResult: mechanism.outcome.ok && mechanism.result != null,
    classification: plan.decision.classification
  });
  for (const checkpoint of checkpoints) {
    insertExecutorCheckpoint(db, checkpoint, { now: finishedAt });
  }

  return { round, decision: plan.decision, artifacts, checkpoints };
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
export type RunSingleShotStepInput = {
  db: MomentumDb;
  /** The single-shot executor family (`one-shot` or `script`) the invocation runs. */
  family: SingleShotExecutorFamily;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  /** Re-run counter; a fresh attempt mints a fresh invocation, never mutating the prior one. */
  attempt: number;
  /** The deterministic selection (from `resolveSingleShotRoundSelection`) frozen into the round. */
  selection: SingleShotRoundSelection;
  /** The bounded mechanism the round runs (the real one-shot / script mechanism plugs in here). */
  runRound: SingleShotRoundRunner;
  /** Resolves the round's input digest / artifact root / log paths the daemon provides. */
  resolveRoundInputs: () => SingleShotRoundRuntimeInputs;
  /** Clock for the invocation + round timestamps; defaults to {@link Date.now}. */
  now?: () => number;
};

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
 * directly (one round *is* the invocation), so the invocation settles into
 * `decision.invocationState` with no `invocationStateForRoundClassification`
 * indirection. Every single-shot invocation state is terminal, so `finished_at` is
 * always stamped; the `isTerminalExecutorInvocationState` guard is kept for
 * symmetry with the goal-loop driver and as a forward-safe default.
 *
 * Clocks: the invocation start and the round's start/finish are stamped from the
 * injected `now`. As with the goal-loop driver, the round's finish clock is read
 * when the round is planned; refining it to a wall-clock-accurate post-mechanism
 * stamp is part of the deferred real daemon clock wiring.
 *
 * @throws {ExecutorInvocationConflictError} if the invocation id already exists
 * (a re-run must use a fresh `attempt`).
 * @throws {ExecutorRoundConflictError} if the round id already exists (via
 * {@link runSingleShotRound}).
 */
export function runSingleShotStep(
  input: RunSingleShotStepInput
): RunSingleShotStepResult {
  const now = input.now ?? Date.now;
  const { db } = input;

  // 1. Materialize + insert the durable invocation (running) before any work, so a
  //    lost process leaves a durable invocation to reattach to.
  const invocationStartedAt = now();
  const invocation = planSingleShotInvocation({
    family: input.family,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    attempt: input.attempt,
    startedAt: invocationStartedAt
  });
  insertExecutorInvocation(db, invocation, { now: invocationStartedAt });

  // 2. Materialize the single round's start projection (inheriting the
  //    invocation's identity + family) and drive it through its durable lifecycle.
  const start = planSingleShotRoundStartForInvocation({
    invocation,
    selection: input.selection,
    runtime: input.resolveRoundInputs(),
    startedAt: now()
  });
  const finishedAt = now();
  const round = runSingleShotRound({
    db,
    start,
    runRound: input.runRound,
    finishedAt
  });

  // 3. Settle the invocation into the state the round's decision maps to. Every
  //    single-shot invocation state is terminal, so `finished_at` is stamped.
  const invocationState = round.decision.invocationState;
  const finalInvocation = updateExecutorInvocationState(
    db,
    invocation.invocationId,
    invocationState,
    {
      heartbeatAt: finishedAt,
      finishedAt: isTerminalExecutorInvocationState(invocationState)
        ? finishedAt
        : null,
      now: finishedAt
    }
  );

  return { invocation: finalInvocation, round };
}
