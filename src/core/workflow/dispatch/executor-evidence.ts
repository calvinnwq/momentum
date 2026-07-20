/**
 * Dispatched executor-evidence settlement seam.
 *
 * The production dispatch lane (`dispatch/execute.ts`) stops at the phase-1
 * *start scaffold*: it advances a claimed step `approved -> running`, creates the
 * `<run>::<step>::dispatch` executor attempt (`running`) and its first round
 * (`pending`) with every evidence field empty, and holds the dispatch lease. The
 * reconciliation seam (`dispatch/reconcile-execute.ts`) then finalizes the
 * workflow step from that attempt's *terminal* executor state. Nothing in
 * production bridged the two: no code drove the scaffold's attempt/round from
 * `running`/`pending` to a terminal state from a real executor result, so the
 * the reconciliation seam always deferred (the attempt stayed `running`).
 *
 * This module owns that bridge — the "produce real terminal executor evidence"
 * half the reconciliation seam named as its remaining prerequisite. Given a finished
 * {@link WorkflowStepExecutorDispatchResult} from running the dispatched step's
 * live-wrapper executor, it:
 *
 *   1. decides, purely, which terminal executor state that result implies
 *      ({@link planDispatchedExecutorTerminalization}), and
 *   2. records that terminal state durably on the dispatch scaffold's attempt
 *      and round, capturing the result's summary / log evidence
 *      ({@link terminalizeDispatchedExecutorAttempt}).
 *
 * It deliberately never calls `finishWorkflowStep` or releases the dispatch
 * lease: per `executor-loop.md` ("Core Boundary: the daemon, not the executor,
 * decides step progress") and the runtime-consolidation plan's live-wrapper/executor-loop boundary,
 * the executor adapter owns per-round evidence only, and the reconciliation
 * seam stays the *single* owner of the workflow-step finalization. This module
 * produces the evidence; the reconciliation seam consumes it. There is no second finalization owner.
 *
 * Mapping discipline (so an unconfigured wrapper / adapter fails honestly,
 * never as a fake success):
 *
 *   - A clean executor terminal (`succeeded` / `failed`) records a matching clean
 *     terminal attempt the reconciliation seam decider maps to a clean workflow-step terminal.
 *   - A process-level executor failure (`ok: false` — e.g. the honest
 *     `runtime_unavailable` an unconfigured live wrapper returns, a timeout, a
 *     missing result document) records `manual_recovery_required`, so the reconciliation seam parks
 *     the run for operator recovery rather than fabricating a clean terminal.
 *   - An unexpected `skipped` executor terminal (skipping is a pre-dispatch
 *     planning decision, never a dispatched-step outcome) also routes to manual
 *     recovery rather than a fabricated clean terminal.
 *
 * Idempotent on re-entry: once the dispatch attempt is terminal, a second call
 * preserves the immutable evidence and writes nothing, so a re-entered dispatch
 * tick cannot double-record or overwrite the bounded session's outcome.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  isTerminalExecutorAttemptState,
  isTerminalExecutorRoundState,
  type ExecutorRoundRecord,
} from "../../executors/loop/reducer.js";
import {
  listExecutorRoundsForAttempt,
  updateExecutorAttemptState,
  updateExecutorRound,
  loadLatestExecutorAttemptForStep,
} from "../../executors/loop/persist.js";
import type { WorkflowStepExecutorDispatchResult } from "../step/executor.js";

/**
 * The terminal executor evidence a finished {@link WorkflowStepExecutorDispatchResult}
 * implies for a dispatched step's scaffold attempt / round.
 *
 *   - `clean_terminal`: the bounded session reached a clean `succeeded` / `failed`
 *     terminal the reconciliation seam decider maps to a clean workflow-step terminal.
 *   - `manual_recovery`: the session could not produce a clean terminal (a
 *     process-level failure, or an unexpected `skipped`), so the evidence is
 *     recorded `manual_recovery_required` and the reconciliation seam parks the run for recovery.
 */
export type DispatchedExecutorTerminalizationPlan =
  | {
      outcome: "clean_terminal";
      attemptState: "succeeded" | "failed";
      roundState: "succeeded" | "failed";
      classification: "complete" | "failed";
    }
  | {
      outcome: "manual_recovery";
      attemptState: "manual_recovery_required";
      roundState: "manual_recovery_required";
      classification: "manual_recovery_required";
      /** The precise executor cause, preserved on the round for recovery. */
      recoveryCode: string;
    };

/**
 * Decide which terminal executor state a finished executor result implies for a
 * dispatched step. Pure and total: never throws, always returns a
 * {@link DispatchedExecutorTerminalizationPlan}. Only a clean `succeeded` /
 * `failed` executor terminal becomes a clean terminal; every other outcome routes
 * to manual recovery so the seam never fabricates a clean finalization over a
 * result that needs operator inspection.
 */
export function planDispatchedExecutorTerminalization(
  result: WorkflowStepExecutorDispatchResult,
): DispatchedExecutorTerminalizationPlan {
  if (!result.ok) {
    // A process-level executor failure — including the honest `runtime_unavailable`
    // an unconfigured live wrapper returns — never produced a clean terminal.
    return manualRecoveryPlan(readExecutorRecoveryCode(result));
  }
  switch (result.result.state) {
    case "succeeded":
      return {
        outcome: "clean_terminal",
        attemptState: "succeeded",
        roundState: "succeeded",
        classification: "complete",
      };
    case "failed":
      return {
        outcome: "clean_terminal",
        attemptState: "failed",
        roundState: "failed",
        classification: "failed",
      };
    case "skipped":
      // A dispatched step is never finalized to `skipped` (skip is a pre-dispatch
      // planning decision). An executor returning `skipped` for a dispatched step
      // is unexpected, so park for inspection rather than fabricate a clean terminal.
      return manualRecoveryPlan("unexpected_skipped_terminal");
  }
}

function manualRecoveryPlan(
  recoveryCode: string,
): DispatchedExecutorTerminalizationPlan {
  return {
    outcome: "manual_recovery",
    attemptState: "manual_recovery_required",
    roundState: "manual_recovery_required",
    classification: "manual_recovery_required",
    recoveryCode,
  };
}

function readExecutorRecoveryCode(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: false }>,
): string {
  const precise = (result as { liveRecoveryCode?: unknown }).liveRecoveryCode;
  return typeof precise === "string" && precise.length > 0
    ? precise
    : result.code;
}

/**
 * Stable `status` strings the terminalization seam returns for daemon telemetry,
 * tests, and operator surfaces. Each is a recorded outcome.
 */
export const WORKFLOW_EXECUTOR_TERMINALIZE_STATUS = {
  /** No `<run>::<step>::dispatch` attempt exists; nothing was written. */
  notDispatched: "terminalize_not_dispatched",
  /** The dispatch attempt + round were recorded to a terminal state. */
  terminalized: "terminalize_recorded",
  /** The dispatch attempt was already terminal; the record was preserved. */
  alreadyTerminal: "terminalize_already_terminal",
} as const;

export type WorkflowExecutorTerminalizeStatus =
  (typeof WORKFLOW_EXECUTOR_TERMINALIZE_STATUS)[keyof typeof WORKFLOW_EXECUTOR_TERMINALIZE_STATUS];

export type TerminalizeDispatchedExecutorInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** The finished result of running the dispatched step's executor. */
  result: WorkflowStepExecutorDispatchResult;
  now: number;
};

export type TerminalizeDispatchedExecutorResult = {
  status: WorkflowExecutorTerminalizeStatus;
  detail?: string;
};

/**
 * Record the dispatched step's executor result as terminal evidence on the
 * `<run>::<step>::dispatch` scaffold — the attempt and its first round — so the
 * reconciliation seam can finalize the workflow step from it. Writes the
 * attempt/round transitions in one `BEGIN IMMEDIATE` transaction so a mid-write
 * failure can never leave a terminal attempt over a non-terminal round (or the
 * reverse). Idempotent: once the attempt is terminal, a re-entry preserves the
 * immutable evidence and writes nothing.
 *
 * Never finalizes the workflow step or touches the dispatch lease: the reconciliation seam
 * remains the single owner of step finalization (`executor-loop.md` Core Boundary).
 */
export function terminalizeDispatchedExecutorAttempt(
  input: TerminalizeDispatchedExecutorInput,
): TerminalizeDispatchedExecutorResult {
  const { db, runId, stepId, result, now } = input;
  const plan = planDispatchedExecutorTerminalization(result);
  const evidence = extractEvidence(result);

  db.exec("BEGIN IMMEDIATE");
  try {
    const attempt = loadLatestExecutorAttemptForStep(db, runId, stepId);
    if (attempt === undefined) {
      // No phase-1 dispatch attempt: this step was never dispatched through the
      // executor-loop lane. The seam owns only dispatched scaffolds, so it writes nothing.
      db.exec("COMMIT");
      return {
        status: WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.notDispatched,
        detail: `${runId}::${stepId}`,
      };
    }
    if (isTerminalExecutorAttemptState(attempt.state)) {
      // Re-read under the write lock so concurrent settlement cannot overwrite
      // immutable terminal evidence with a stale pre-transaction snapshot.
      db.exec("COMMIT");
      return {
        status: WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.alreadyTerminal,
        detail: attempt.state,
      };
    }

    const rounds = listExecutorRoundsForAttempt(db, attempt.attemptId);
    const round =
      rounds.find(
        (candidate) => !isTerminalExecutorRoundState(candidate.state),
      ) ?? rounds[0];
    if (round !== undefined) {
      terminalizeRound(db, round, plan, evidence, now);
    }
    updateExecutorAttemptState(db, attempt.attemptId, plan.attemptState, {
      now,
      finishedAt: now,
    });
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    throw error;
  }

  return {
    status: WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.terminalized,
    detail: plan.attemptState,
  };
}

type TerminalizeEvidence = {
  summary: string;
  logPaths: string[];
  resultDigest: string | null;
};

function extractEvidence(
  result: WorkflowStepExecutorDispatchResult,
): TerminalizeEvidence {
  if (result.ok) {
    return {
      summary: result.result.summary,
      logPaths: result.result.artifacts.map((artifact) => artifact.path),
      resultDigest: result.result.resultDigest,
    };
  }
  const logPaths = [result.executorLogPath, result.resultJsonPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return { summary: result.error, logPaths, resultDigest: null };
}

/**
 * Walk the scaffold round to its terminal state, capturing the result evidence.
 * A clean terminal passes through the contract's capture phase
 * (`pending -> running -> capturing_result -> terminal`) so the round carries the
 * normalized summary / logs; a manual-recovery outcome aborts straight to
 * `manual_recovery_required` with the precise executor cause. A round that is
 * already terminal (a partial re-entry) is left untouched.
 */
function terminalizeRound(
  db: MomentumDb,
  round: ExecutorRoundRecord,
  plan: DispatchedExecutorTerminalizationPlan,
  evidence: TerminalizeEvidence,
  now: number,
): void {
  if (isTerminalExecutorRoundState(round.state)) return;
  const roundId = round.roundId;

  if (plan.outcome === "manual_recovery") {
    updateExecutorRound(
      db,
      roundId,
      {
        toState: "manual_recovery_required",
        classification: plan.classification,
        recoveryCode: plan.recoveryCode,
        summary: evidence.summary,
        logPaths: evidence.logPaths,
        startedAt: now,
        finishedAt: now,
      },
      { now },
    );
    return;
  }

  updateExecutorRound(
    db,
    roundId,
    { toState: "running", startedAt: now },
    { now },
  );
  updateExecutorRound(db, roundId, { toState: "capturing_result" }, { now });
  updateExecutorRound(
    db,
    roundId,
    {
      toState: plan.roundState,
      classification: plan.classification,
      summary: evidence.summary,
      logPaths: evidence.logPaths,
      resultDigest: evidence.resultDigest,
      finishedAt: now,
    },
    { now },
  );
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in a transaction; nothing to do.
  }
}
