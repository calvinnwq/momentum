/**
 * Goal-loop executor adapter — single-round driver (M10-05, NGX-349).
 *
 * `goal-loop-executor.ts` owns the *pure* projections for one bounded round: the
 * round-start record ({@link planGoalLoopRoundStart}), the daemon classification
 * + two-phase persistence patches ({@link planGoalLoopRoundPersistence}), and the
 * deterministic agent/model selection. This module is the stateful seam that
 * composes those projections with the *real* M10-03 executor-loop persistence
 * layer and round transition graph around the bounded mechanism, exactly the way
 * `live-step-orchestrator.ts` composes the pure `step-finalize.ts`
 * transaction:
 *
 *   insert the round-start row  (running, agent/model/input frozen in)
 *   -> run the bounded mechanism (the M9 goal iteration; injected here)
 *   -> persist the round's evidence artifacts (contract "Required Artifacts")
 *   -> capture the normalized result  (running -> capturing_result)
 *   -> persist the terminal decision  (-> succeeded / failed / manual recovery)
 *   -> persist the round's lifecycle checkpoint stream (contract step 7)
 *
 * {@link runGoalLoopInvocation} is the multi-round loop on top of that single
 * round: it inserts the durable `executor_invocations` row (running) before any
 * round, drives {@link runGoalLoopRound} per round index until a round's decision
 * stops the loop, and advances/terminalizes the invocation via
 * {@link invocationStateForRoundClassification} — succeeded on completion, the
 * durable `waiting_operator` pause on a quota / operator gate, a terminal
 * failure / manual recovery on the repo-safety boundaries. The real
 * bounded-mechanism wiring (the M9 goal iteration plugged into the
 * {@link GoalLoopRoundRunner} seam) and the run-level composition that materializes
 * the invocation/round identity and threads each round's result into the next
 * round's input are layered on top in later M10-05 slices, the same way the
 * run-level caller composes `runLiveWorkflowStep`.
 *
 * The bounded mechanism is injected as a {@link GoalLoopRoundRunner} so the real
 * M9 goal iteration, a no-op, or a deterministic fake can all drive a round
 * through the identical durable lifecycle. The mechanism is *total*: it encodes
 * every failure as a {@link FinalizeWorkflowStepFromResultFileResult} outcome
 * (and a `null` result for a missing/invalid result document) rather than
 * throwing, mirroring `finalizeWorkflowStepFromResultFile`, which never
 * throws. The driver then routes each outcome through the pure decision so the
 * verification-authority and repo-safety boundaries hold end to end:
 *
 *   - The durable round-start row is inserted *before* the mechanism runs
 *     (contract Round Lifecycle step 4), so a lost process leaves a durable
 *     `running` round to reattach to rather than no evidence at all.
 *   - The round's evidence artifacts are persisted below it once the mechanism
 *     returns (contract Round Lifecycle step 7 / "Required Artifacts"): the
 *     frozen `logPaths` become `logs` rows and the mechanism's reported pointers
 *     become the result-document / verification / commit / recovery rows, so the
 *     durable round carries its full per-round evidence, not just the result
 *     fields.
 *   - The round's coarse lifecycle checkpoint stream is persisted once it has
 *     classified (contract Round Lifecycle step 7 "Capture ... checkpoints"):
 *     the stages Momentum drives around the mechanism (started, mechanism
 *     finished, result captured, classified) become durable `executor_checkpoints`
 *     rows, a queryable record of how far the round got for reattach. The
 *     mechanism's own fine-grained checkpoint stream stays the `checkpoint_stream`
 *     artifact file.
 *   - The terminal write stamps `finished_at` / `heartbeat_at` from the daemon
 *     clock. The pure terminal projection has no clock, so without the driver a
 *     round's `finished_at` would stay null forever; closing that is the durable
 *     "Round Schema" `finished_at` requirement.
 *   - A present result captures (running -> capturing_result) before
 *     terminalizing; a `null` result (missing/invalid document) skips capture and
 *     routes straight from running to manual recovery, never inventing a result.
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
import {
  invocationStateForRoundClassification,
  planGoalLoopInvocation,
  planGoalLoopRoundArtifacts,
  planGoalLoopRoundCheckpoints,
  planGoalLoopRoundPersistence,
  planGoalLoopRoundStart,
  planGoalLoopRoundStartForInvocation,
  type GoalLoopFinalizeEvidence,
  type GoalLoopRoundArtifacts,
  type GoalLoopRoundDecision,
  type GoalLoopRoundRuntimeInputs,
  type GoalLoopRoundSelection,
  type PlanGoalLoopRoundStartInput
} from "./executor.js";
import type { FinalizeWorkflowStepFromResultFileResult } from "../shared/step-finalize.js";
import type { RunnerResult } from "../runner/types.js";

/**
 * The output of one bounded mechanism run: the normalized runner result (or
 * `null` when the round produced no valid result document) plus the repo-safety
 * finalize outcome. This is exactly what {@link planGoalLoopRoundPersistence}
 * consumes, so the mechanism stays decoupled from the durable schema.
 */
export type GoalLoopRoundMechanismResult = {
  result: RunnerResult | null;
  finalize: FinalizeWorkflowStepFromResultFileResult;
  /**
   * The content digest of the captured result document (the round-schema
   * `result_digest` reattach fingerprint), or `null` / omitted when the round
   * produced no usable result. The driver stamps it onto the `capturing_result`
   * patch so the durable round carries a fingerprint of its result artifact, not
   * just the parsed fields; it is consistent with {@link result} (a digest only
   * accompanies a non-null result).
   */
  resultDigest?: string | null;
  /**
   * The evidence pointers the round wrote (contract "Required Artifacts"), per
   * artifact class except `logs` (the driver derives those from the round-start
   * record's frozen `logPaths`). Omitted when the mechanism reports no extra
   * artifacts; the driver still records the `logs` rows.
   */
  artifacts?: GoalLoopRoundArtifacts;
  /**
   * The repository-relative paths the round committed (the round-schema
   * `changed_files` field), or omitted / empty for any non-committed outcome.
   * The driver threads it onto the terminal patch so the durable round records
   * the change set it committed alongside the commit SHA; it is consistent with
   * {@link finalize} (a non-empty set only accompanies a `committed` outcome).
   */
  changedFiles?: string[];
};

/**
 * The bounded mechanism a round runs. Receives the durable round-start record
 * (its frozen agent/model/effort, input digest, artifact root, and identity) and
 * returns the round's normalized result + finalize outcome. It must be total —
 * encode failures as finalize outcomes rather than throwing — mirroring
 * `finalizeWorkflowStepFromResultFile`. `goal-loop-mechanism.ts`'s
 * `goalLoopRoundMechanismFromResultFile` is the concrete mechanism that reuses
 * that shared finalize safety over a round's result document; the daemon wiring that
 * runs the agent producing the document then calls it inside this closure. Tests
 * inject a deterministic fake.
 */
export type GoalLoopRoundRunner = (
  round: ExecutorRoundRecord
) => GoalLoopRoundMechanismResult;

export type RunGoalLoopRoundInput = {
  db: MomentumDb;
  /** The round-start projection inputs (identity, resolved selection, input evidence, start clock). */
  start: PlanGoalLoopRoundStartInput;
  /** The bounded mechanism to run for this round. */
  runRound: GoalLoopRoundRunner;
  /** Daemon clock stamped as the round's `finished_at` / terminal `heartbeat_at`. */
  finishedAt: number;
};

/**
 * The durable result of one finished goal-loop round: the persisted terminal
 * round record, the daemon's decision (its `continueLoop` drives the future
 * multi-round loop), and the projected repo-safety evidence.
 */
export type RunGoalLoopRoundResult = {
  round: ExecutorRoundRecord;
  decision: GoalLoopRoundDecision;
  evidence: GoalLoopFinalizeEvidence;
  /** The durable artifact rows persisted below the round, in contract order. */
  artifacts: ExecutorArtifactRecord[];
  /** The durable checkpoint-stream rows persisted below the round, sequenced from 0. */
  checkpoints: ExecutorCheckpointRecord[];
};

/**
 * Drive one bounded goal-loop round end to end through its durable round-record
 * lifecycle. See the module doc for the ordered contract.
 *
 * @throws {ExecutorRoundConflictError} if the round id / `(invocation, index)`
 * already exists (a durable round is the proof a bounded unit started, not an
 * idempotent re-ingest).
 * @throws {Error} if the round index / max-rounds budget is out of range (via
 * {@link planGoalLoopRoundPersistence}).
 */
export function runGoalLoopRound(
  input: RunGoalLoopRoundInput
): RunGoalLoopRoundResult {
  const { db, start, runRound, finishedAt } = input;

  // 1. Insert the durable round-start row before any external work runs.
  const startRecord = planGoalLoopRoundStart(start);
  insertExecutorRound(db, startRecord, { now: start.startedAt });

  // 2. Run the bounded mechanism. It is total: failures come back as finalize
  //    outcomes (and a null result), never as a throw.
  const mechanism = runRound(startRecord);

  // 3. Persist the round's evidence artifacts (contract "Required Artifacts").
  //    The round-start row already exists, so each artifact's FK to it holds;
  //    `logs` come from the frozen logPaths, the rest from what the mechanism
  //    reported. This is the round's "artifact evidence" half of its per-round
  //    record, alongside the result/verification/commit fields captured below.
  const artifacts = planGoalLoopRoundArtifacts({
    roundId: start.roundId,
    logPaths: startRecord.logPaths,
    ...(mechanism.artifacts !== undefined
      ? { artifacts: mechanism.artifacts }
      : {})
  });
  for (const artifact of artifacts) {
    insertExecutorArtifact(db, artifact, { now: finishedAt });
  }

  // 4. Project the finished round into its two-phase persistence plan, threading
  //    the mechanism's result-document digest onto the capture patch so the
  //    durable round's `result_digest` fingerprints the artifact it captured, and
  //    its committed change set onto the terminal patch so `changed_files`
  //    records what the round committed alongside the commit SHA.
  const plan = planGoalLoopRoundPersistence({
    result: mechanism.result,
    finalize: mechanism.finalize,
    roundIndex: start.roundIndex,
    maxRounds: start.selection.maxRounds,
    ...(mechanism.resultDigest !== undefined
      ? { resultDigest: mechanism.resultDigest }
      : {}),
    ...(mechanism.changedFiles !== undefined
      ? { changedFiles: mechanism.changedFiles }
      : {})
  });

  // 5. Capture the normalized result (when present) then persist the terminal
  //    decision, stamping the daemon clock the pure projection cannot supply.
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

  // 6. Persist the round's coarse lifecycle checkpoint stream (contract Round
  //    Lifecycle step 7 "Capture ... checkpoints ..."). The round-start row
  //    exists, so each checkpoint's FK to it holds; the stages are derived from
  //    what the round actually did (its finalize outcome, whether a result was
  //    captured, and the daemon classification), so the durable round carries a
  //    queryable record of how far it got, not just its terminal fields.
  const checkpoints = planGoalLoopRoundCheckpoints({
    roundId: start.roundId,
    finalizeOutcome: mechanism.finalize.outcome,
    capturedResult: plan.captureUpdate !== null,
    classification: plan.decision.classification
  });
  for (const checkpoint of checkpoints) {
    insertExecutorCheckpoint(db, checkpoint, { now: finishedAt });
  }

  return {
    round,
    decision: plan.decision,
    evidence: plan.evidence,
    artifacts,
    checkpoints
  };
}

/**
 * The per-round inputs the invocation loop asks its caller to materialize for a
 * given 0-based round index: the round-start projection inputs (identity,
 * resolved selection, input/artifact evidence, start clock) and the daemon clock
 * to stamp as that round's `finished_at`. The loop owns the round *ordering*; the
 * caller owns minting each round's id / input digest / clock — and, in the real
 * wiring, threading the prior round's result into the next round's input.
 */
export type GoalLoopInvocationRoundPlan = {
  start: PlanGoalLoopRoundStartInput;
  finishedAt: number;
};

/**
 * Materialize the {@link GoalLoopInvocationRoundPlan} for one round index. Called
 * once per round, in order (0, 1, 2, ...). The returned `start.roundIndex` must
 * equal the requested index so the loop's round-budget accounting stays honest.
 */
export type GoalLoopInvocationRoundPlanner = (
  roundIndex: number
) => GoalLoopInvocationRoundPlan;

export type RunGoalLoopInvocationInput = {
  db: MomentumDb;
  /**
   * The invocation row to insert before any round runs. It is inserted at its
   * own `state` (the daemon resolves agent/model/leases in `preparing` and hands
   * this driver a `running` invocation); the loop never re-derives it.
   */
  invocation: ExecutorInvocationRecord;
  /** Materializes each round's start projection + finish clock, by round index. */
  planRound: GoalLoopInvocationRoundPlanner;
  /** The bounded mechanism each round runs (the same injected runner across rounds). */
  runRound: GoalLoopRoundRunner;
};

/**
 * The durable result of one finished goal-loop invocation: the persisted terminal
 * (or `waiting_operator`-paused) invocation record and every round outcome it
 * drove, in order. The last round's decision is what settled the invocation.
 */
export type RunGoalLoopInvocationResult = {
  invocation: ExecutorInvocationRecord;
  rounds: RunGoalLoopRoundResult[];
};

/**
 * Drive a bounded goal-loop invocation across its rounds. See the module doc for
 * the ordered contract. The loop inserts the durable invocation before any round,
 * runs {@link runGoalLoopRound} per round index, and — after each round — either
 * heartbeats the still-running invocation and loops (when the daemon decision
 * recommends another round) or settles the invocation into the state its
 * classification maps to and returns.
 *
 * Termination: the loop ends when a round's decision sets `continueLoop` false —
 * on completion, a quota / operator gate, or a repo-safety manual-recovery /
 * failure. With a bounded `maxRounds` in the resolved selection,
 * {@link decideGoalLoopRound} guarantees that happens once the budget is reached;
 * an unbounded (`null`) `maxRounds` relies on the injected mechanism eventually
 * recommending completion or routing to recovery, exactly as the real M9 goal
 * iteration does.
 *
 * @throws {ExecutorInvocationConflictError} if the invocation id already exists.
 * @throws {Error} if the planner returns a round whose `roundIndex` disagrees with
 * the loop index (which would corrupt the round-budget accounting).
 * @throws {ExecutorRoundConflictError} if a round id / `(invocation, index)` already
 * exists (via {@link runGoalLoopRound}).
 */
export function runGoalLoopInvocation(
  input: RunGoalLoopInvocationInput
): RunGoalLoopInvocationResult {
  const { db, invocation, planRound, runRound } = input;

  // 1. Insert the durable invocation row before any round runs, so a lost process
  //    leaves a durable invocation to reattach to. Stamp created_at from the
  //    invocation's own start clock when present (never an explicit undefined,
  //    which exactOptionalPropertyTypes forbids).
  const insertNow = invocation.startedAt ?? invocation.heartbeatAt;
  insertExecutorInvocation(
    db,
    invocation,
    insertNow !== null ? { now: insertNow } : {}
  );

  const rounds: RunGoalLoopRoundResult[] = [];
  for (let roundIndex = 0; ; roundIndex++) {
    const plan = planRound(roundIndex);
    if (plan.start.roundIndex !== roundIndex) {
      throw new Error(
        `runGoalLoopInvocation: planner returned roundIndex ${String(plan.start.roundIndex)} for loop index ${roundIndex}; the round-start index must match the loop index so the round-budget accounting stays honest`
      );
    }

    const roundOutcome = runGoalLoopRound({
      db,
      start: plan.start,
      runRound,
      finishedAt: plan.finishedAt
    });
    rounds.push(roundOutcome);

    // The daemon recommends another round: heartbeat the still-running invocation
    // (running -> running is a no-op transition) and loop.
    if (roundOutcome.decision.continueLoop) {
      updateExecutorInvocationState(db, invocation.invocationId, "running", {
        heartbeatAt: plan.finishedAt,
        now: plan.finishedAt
      });
      continue;
    }

    // The round stopped the loop. Settle the invocation into the state its
    // classification maps to: a terminal success/failure/recovery, or the durable
    // `waiting_operator` pause (a quota / operator gate is not terminal, so it
    // leaves `finished_at` null for a later operator decision to resume).
    const invocationState = invocationStateForRoundClassification(
      roundOutcome.decision.classification
    );
    const finalInvocation = updateExecutorInvocationState(
      db,
      invocation.invocationId,
      invocationState,
      {
        heartbeatAt: plan.finishedAt,
        finishedAt: isTerminalExecutorInvocationState(invocationState)
          ? plan.finishedAt
          : null,
        now: plan.finishedAt
      }
    );
    return { invocation: finalInvocation, rounds };
  }
}

/**
 * The inputs to {@link runGoalLoopStep}: the `StepRun` identity
 * (`workflowRunId` / `stepRunId` / `stepKey` / `attempt`), the resolved
 * {@link GoalLoopRoundSelection} every round runs under, the bounded mechanism,
 * a per-round runtime-input resolver, and a clock. The adapter mints the
 * invocation / round identities itself, so the caller supplies a `StepRun`, not
 * pre-built executor-loop records.
 */
export type RunGoalLoopStepInput = {
  db: MomentumDb;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  /** Re-run counter; a fresh attempt mints a fresh invocation, never mutating the prior one. */
  attempt: number;
  /** The deterministic selection (from `resolveGoalLoopRoundSelection`) frozen into each round. */
  selection: GoalLoopRoundSelection;
  /** The bounded mechanism each round runs (the real M9 goal iteration plugs in here). */
  runRound: GoalLoopRoundRunner;
  /** Resolves the per-round input digest / artifact root / log paths the daemon provides. */
  resolveRoundInputs: (roundIndex: number) => GoalLoopRoundRuntimeInputs;
  /** Clock for the invocation + round timestamps; defaults to {@link Date.now}. */
  now?: () => number;
};

/**
 * The goal-loop executor adapter "below `StepRun`" (contract "State Model":
 * `StepRun -> ExecutorInvocation -> ExecutorRound[]`). This is the single
 * entrypoint a daemon / scheduler calls with a step-run identity: it
 * {@link planGoalLoopInvocation | materializes} the durable goal-loop
 * `executor_invocations` row with a deterministic, reattachable id, then drives
 * the whole invocation through {@link runGoalLoopInvocation}, materializing each
 * round's identity via {@link planGoalLoopRoundStartForInvocation} so every round
 * inherits the invocation's identity and a deterministic {@link goalLoopRoundId}.
 *
 * The adapter owns the deterministic id scheme so no caller reinvents it: an
 * invocation reattaches from `(workflowRunId, stepRunId, attempt)` and a round
 * from `(invocationId, roundIndex)`, both recomputable from durable state alone
 * (contract "Heartbeat And Reattach"). The resolved selection is frozen into each
 * round before work runs (contract "Agent And Model Selection") and the per-round
 * input digest / artifact root / log paths come from the injected
 * {@link RunGoalLoopStepInput.resolveRoundInputs} (the daemon's filesystem /
 * threading concern, never invented here).
 *
 * Clocks: the invocation start and each round's start/finish are stamped from the
 * injected `now`. As with {@link runGoalLoopInvocation}, a round's finish clock is
 * read when the round is planned; refining it to a wall-clock-accurate
 * post-mechanism stamp is part of the deferred real daemon clock wiring, the same
 * way `live-step-orchestrator.ts` owns its own lease/heartbeat clock.
 *
 * @throws {ExecutorInvocationConflictError} if the invocation id already exists
 * (a re-run must use a fresh `attempt`).
 * @throws {ExecutorRoundConflictError} if a round id already exists (via
 * {@link runGoalLoopInvocation}).
 */
export function runGoalLoopStep(
  input: RunGoalLoopStepInput
): RunGoalLoopInvocationResult {
  const now = input.now ?? Date.now;
  const invocation = planGoalLoopInvocation({
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    attempt: input.attempt,
    startedAt: now()
  });
  return runGoalLoopInvocation({
    db: input.db,
    invocation,
    runRound: input.runRound,
    planRound: (roundIndex) => {
      const start = planGoalLoopRoundStartForInvocation({
        invocation,
        selection: input.selection,
        roundIndex,
        runtime: input.resolveRoundInputs(roundIndex),
        startedAt: now()
      });
      return { start, finishedAt: now() };
    }
  });
}
