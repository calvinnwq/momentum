/**
 * Side-effecting twin of the pure workflow-step reconciliation decider.
 *
 * `dispatch/reconcile.ts` owns the *pure* half — the deterministic decision that
 * maps a dispatched step's terminal executor-invocation state to a finalization
 * outcome. This module owns the durable half: the single production seam the
 * runtime-consolidation plan names the reconciliation seam. It is to `dispatch/reconcile.ts` exactly
 * what `dispatch/execute.ts` is to `dispatch.ts`.
 *
 * The seam reads the deterministic `<run>::<step>::dispatch` invocation the
 * production dispatcher (`dispatch/execute.ts`) created, asks
 * {@link planWorkflowStepReconciliation} what to do, and applies that decision
 * inside a single `BEGIN IMMEDIATE` transaction:
 *
 *   - **finalize** (`succeeded` / `failed` / `cancelled` invocation): move the
 *     owning `workflow_steps` row to the matching clean terminal via
 *     `finishWorkflowStep`, release the held `dispatch` lease (honouring the
 *     scheduler contract's "release on terminal" half), and refresh the cached
 *     run-state / monitor columns through the ARCH-08 `run/runtime-state.ts` seam.
 *   - **manual_recovery** (`blocked` / `manual_recovery_required` invocation): the
 *     bounded attempt ended needing operator inspection, so the seam parks the run
 *     (`needs_manual_recovery`) and opens an operator-visible `manual_recovery_required`
 *     gate hung from the step instead of fabricating a clean terminal, then
 *     releases the lease and refreshes run-state — mirroring the fail-closed half
 *     of the dispatcher.
 *   - **not_terminal**: the bounded executor session is still in progress; the
 *     seam defers (no writes, the dispatch lease stays held).
 *
 * Two structural guarantees from the runtime-consolidation plan ("The live-wrapper / executor-loop
 * step-finalization boundary"):
 *
 *   1. **Single owner, keyed on the dispatch id.** The seam acts only when a
 *      `<run>::<step>::dispatch` invocation exists. A step finalized by an live
 *      wrapper writes no executor invocation, so the seam refuses it
 *      (`not_dispatched`) and writes nothing — there is no path where both live-wrapper
 *      direct-finalize and executor-loop reconciliation finalize the same step.
 *   2. **Idempotent on re-entry.** A second reconciliation of the same terminal
 *      evidence recognises the already-terminal step and makes no second
 *      finalization: the immutable terminal record (state / `finished_at` /
 *      `result_digest`) is preserved and the terminal result semantics never
 *      change, even if the durable invocation reports a different clean terminal.
 *
 * Like the dispatcher, this module never writes `executor_invocations` /
 * `executor_rounds`: the executor adapters own per-round evidence, and the daemon
 * — through this seam — decides step progress (`executor-loop.md` Core Boundary).
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
} from "../../executors/loop/persist.js";
import type { ExecutorName } from "../../executors/loop/reducer.js";
import { deriveDispatchInvocationId } from "./execute.js";
import { planWorkflowStepReconciliation } from "./reconcile.js";
import { insertWorkflowGate, loadWorkflowGate } from "../gate/persist.js";
import { getWorkflowLease, releaseWorkflowLease } from "../leases.js";
import { markWorkflowRunNeedsManualRecovery } from "../run/recovery.js";
import { isTerminalStepState } from "../run/reducer.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import {
  finishWorkflowStep,
  getWorkflowStep,
  type WorkflowStepTerminalState,
  type WorkflowStepTransitionOutcome,
} from "../step/transitions.js";

/**
 * Stable `status` strings the reconciliation seam returns for daemon telemetry,
 * tests, and operator surfaces. Each is a recorded outcome — the seam never
 * returns without explaining what it did to a dispatched step.
 */
export const WORKFLOW_RECONCILE_RESULT_STATUS = {
  /** No `<run>::<step>::dispatch` invocation: not this seam's step (live-wrapper lane). */
  notDispatched: "reconcile_not_dispatched",
  /** The bounded executor session is still in progress; left running. */
  deferred: "reconcile_deferred",
  /** A clean terminal invocation finalized the step this call. */
  finalized: "reconcile_finalized",
  /** The step was already terminal; the immutable record was preserved. */
  alreadyFinalized: "reconcile_already_finalized",
  /** An unclean terminal parked the run for operator recovery. */
  manualRecovery: "reconcile_manual_recovery",
  /** The step row vanished between dispatch and reconciliation. */
  stepNotFound: "reconcile_step_not_found",
  /** The step is non-terminal but not `running`; refused rather than forced. */
  stepNotRunning: "reconcile_step_not_running",
} as const;

export type WorkflowReconcileResultStatus =
  (typeof WORKFLOW_RECONCILE_RESULT_STATUS)[keyof typeof WORKFLOW_RECONCILE_RESULT_STATUS];

export type WorkflowStepReconciliationResult = {
  status: WorkflowReconcileResultStatus;
  detail?: string;
};

export type ReconcileDispatchedWorkflowStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  now: number;
  /** Current fenced lease identity when reconciliation runs inside a dispatch claim. */
  leaseIdentity?: { holder: string; acquiredAt: number };
};

/**
 * `result_digest` prefix stamped on a step this seam finalizes, so durable state
 * carries an unmistakable marker that the production reconciliation seam — not an
 * operator, not the dogfood stand-in, not a live wrapper — closed the step
 * from terminal executor evidence.
 */
export const RECONCILE_RESULT_DIGEST_PREFIX = "rc2-reconcile";

/** The operator actions the reconciliation manual-recovery gate offers. */
const RECONCILE_RECOVERY_GATE_ACTIONS: readonly string[] = [
  "clear_recovery",
  "abort_run",
];
const RECONCILE_RECOVERY_RECOMMENDED_ACTION = "clear_recovery";

/**
 * Reconcile a dispatched workflow step from its terminal executor evidence. The
 * single production owner of the executor-loop dispatch lane's step finalization; see the
 * module doc for the per-action effects, lease lifecycle, and the two structural
 * guarantees (single-owner, idempotent).
 */
export function reconcileDispatchedWorkflowStep(
  input: ReconcileDispatchedWorkflowStepInput,
): WorkflowStepReconciliationResult {
  const { db, runId, stepId, now, leaseIdentity } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: this step was never dispatched through the
    // executor-loop lane (a live-wrapper / imported step, which writes no executor
    // rows). The seam owns only dispatched steps, so it refuses and writes
    // nothing — the structural guard against a double finalize.
    return {
      status: WORKFLOW_RECONCILE_RESULT_STATUS.notDispatched,
      detail: invocationId,
    };
  }

  const plan = planWorkflowStepReconciliation(invocation.state);
  if (plan.action === "not_terminal") {
    return {
      status: WORKFLOW_RECONCILE_RESULT_STATUS.deferred,
      detail: invocation.state,
    };
  }
  if (plan.action === "manual_recovery") {
    const recovery = readDispatchRecoveryEvidence(db, invocationId);
    return parkForManualRecovery(db, {
      runId,
      stepId,
      dispatchStartedAt: invocation.startedAt,
      executorFamily: invocation.executorFamily,
      invocationState: plan.invocationState,
      reason:
        recovery === null
          ? plan.reason
          : `${recovery.code}: ${recovery.summary}`,
      evidence: recovery?.code ?? plan.invocationState,
      ...(leaseIdentity !== undefined ? { leaseIdentity } : {}),
      now,
    });
  }
  return finalizeDispatchedStep(db, {
    runId,
    stepId,
    dispatchStartedAt: invocation.startedAt,
    executorFamily: invocation.executorFamily,
    stepState: plan.stepState,
    ...(leaseIdentity !== undefined ? { leaseIdentity } : {}),
    now,
  });
}

/**
 * Move a dispatched step to its clean terminal, release the dispatch lease, and
 * refresh cached run-state — all in one transaction so a mid-write failure can
 * never leave a finalized step with a held lease or a released lease over a
 * still-running step. Idempotent: an already-terminal step converges the lease /
 * run-state without a second finalization and preserves the terminal record.
 */
function finalizeDispatchedStep(
  db: MomentumDb,
  args: {
    runId: string;
    stepId: string;
    dispatchStartedAt: number | null;
    executorFamily: ExecutorName;
    stepState: WorkflowStepTerminalState;
    leaseIdentity?: { holder: string; acquiredAt: number };
    now: number;
  },
): WorkflowStepReconciliationResult {
  const {
    runId,
    stepId,
    dispatchStartedAt,
    executorFamily,
    stepState,
    leaseIdentity,
    now,
  } = args;
  db.exec("BEGIN IMMEDIATE");
  try {
    const step = getWorkflowStep(db, runId, stepId);
    if (step === undefined) {
      db.exec("ROLLBACK");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotFound,
        detail: stepId,
      };
    }

    if (isTerminalStepState(step.state)) {
      // Already terminal: a prior reconciliation, or another path, finalized the
      // step. The terminal result is immutable, so never override it — just
      // converge the lease + run-state so a crashed prior finalize cannot strand
      // the dispatch lease or leave cached run-state stale.
      releaseHeldDispatchLease(
        db,
        runId,
        dispatchStartedAt,
        false,
        now,
        leaseIdentity,
      );
      refreshWorkflowRunRuntimeState(db, { runId, now });
      db.exec("COMMIT");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
        detail: step.state,
      };
    }

    if (step.state !== "running") {
      // A dispatched step should be `running` before reconciliation finalizes it.
      // Anything else (approved / pending / blocked) is an unexpected lane state
      // the seam refuses rather than forcing a terminal over.
      db.exec("ROLLBACK");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotRunning,
        detail: step.state,
      };
    }

    const finished = finishWorkflowStep(db, {
      runId,
      stepId,
      state: stepState,
      resultDigest: `${RECONCILE_RESULT_DIGEST_PREFIX}::${stepId}::${stepState}`,
      now,
    });
    if (!finished.ok) {
      const recovered = recoverFinishConflict(
        db,
        finished,
        runId,
        dispatchStartedAt,
        now,
      );
      if (recovered !== undefined) {
        db.exec("COMMIT");
        return recovered;
      }
      db.exec("ROLLBACK");
      return mapFinishRefusal(finished);
    }

    releaseHeldDispatchLease(
      db,
      runId,
      dispatchStartedAt,
      executorFamily === "subworkflow",
      now,
      leaseIdentity,
    );
    refreshWorkflowRunRuntimeState(db, { runId, now });
    db.exec("COMMIT");
    return {
      status: finished.idempotent
        ? WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized
        : WORKFLOW_RECONCILE_RESULT_STATUS.finalized,
      detail: stepState,
    };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/**
 * Park the run for manual recovery and open an operator-visible gate hung from
 * the step, then release the dispatch lease and refresh run-state — the unclean
 * terminal outcome. Atomic so the gate and recovery flag never drift; idempotent
 * on the deterministic gate id so a re-entry opens no duplicate gate. A vanished
 * run cannot carry the gate's NOT NULL FK, so that branch releases the lease only.
 */
function parkForManualRecovery(
  db: MomentumDb,
  args: {
    runId: string;
    stepId: string;
    dispatchStartedAt: number | null;
    executorFamily: ExecutorName;
    invocationState: string;
    reason: string;
    evidence: string;
    leaseIdentity?: { holder: string; acquiredAt: number };
    now: number;
  },
): WorkflowStepReconciliationResult {
  const {
    runId,
    stepId,
    dispatchStartedAt,
    executorFamily,
    invocationState,
    reason,
    evidence,
    leaseIdentity,
    now,
  } = args;
  db.exec("BEGIN IMMEDIATE");
  try {
    const step = getWorkflowStep(db, runId, stepId);
    if (step === undefined) {
      db.exec("ROLLBACK");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotFound,
        detail: stepId,
      };
    }
    if (isTerminalStepState(step.state)) {
      releaseHeldDispatchLease(
        db,
        runId,
        dispatchStartedAt,
        false,
        now,
        leaseIdentity,
      );
      refreshWorkflowRunRuntimeState(db, { runId, now });
      db.exec("COMMIT");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
        detail: step.state,
      };
    }
    if (step.state !== "running") {
      db.exec("ROLLBACK");
      return {
        status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotRunning,
        detail: step.state,
      };
    }

    const marked = markWorkflowRunNeedsManualRecovery(db, {
      runId,
      reason,
      now,
    });
    if (marked.ok) {
      const gateId = deriveReconcileRecoveryGateId(
        runId,
        stepId,
        invocationState,
      );
      if (loadWorkflowGate(db, gateId) === undefined) {
        // A step-scoped gate carries the run + step anchors only; the terminal
        // invocation state is recorded as `evidence` (the gate ancestry model
        // forbids an invocation id on a step-scoped gate).
        insertWorkflowGate(
          db,
          {
            gateId,
            workflowRunId: runId,
            stepRunId: stepId,
            targetScope: "step",
            gateType: "manual_recovery_required",
            reason,
            evidence,
            allowedActions: RECONCILE_RECOVERY_GATE_ACTIONS,
            recommendedAction: RECONCILE_RECOVERY_RECOMMENDED_ACTION,
          },
          { now },
        );
      }
    }
    releaseHeldDispatchLease(
      db,
      runId,
      dispatchStartedAt,
      executorFamily === "subworkflow",
      now,
      leaseIdentity,
    );
    refreshWorkflowRunRuntimeState(db, { runId, now });
    db.exec("COMMIT");
    return {
      status: WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery,
      detail: invocationState,
    };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

function readDispatchRecoveryEvidence(
  db: MomentumDb,
  invocationId: string,
): { code: string; summary: string } | null {
  const latest = listExecutorRoundsForInvocation(db, invocationId).at(-1);
  if (
    latest?.recoveryCode === null ||
    latest?.recoveryCode === undefined ||
    latest.summary === null ||
    latest.summary.length === 0
  ) {
    return null;
  }
  return { code: latest.recoveryCode, summary: latest.summary };
}

/**
 * A `finishWorkflowStep` refusal can mean the step moved to a terminal under us
 * between the read and the guarded write (a concurrent operator / worker). If the
 * step is now terminal, treat it as an idempotent already-finalized outcome and
 * converge the lease / run-state inside the open transaction; otherwise return
 * `undefined` so the caller rolls back and surfaces the refusal.
 */
function recoverFinishConflict(
  db: MomentumDb,
  outcome: Exclude<WorkflowStepTransitionOutcome, { ok: true }>,
  runId: string,
  dispatchStartedAt: number | null,
  now: number,
): WorkflowStepReconciliationResult | undefined {
  if (
    outcome.reason === "invalid_transition" &&
    isTerminalStepState(outcome.from)
  ) {
    releaseHeldDispatchLease(db, runId, dispatchStartedAt, false, now);
    refreshWorkflowRunRuntimeState(db, { runId, now });
    return {
      status: WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
      detail: outcome.from,
    };
  }
  return undefined;
}

function mapFinishRefusal(
  outcome: Exclude<WorkflowStepTransitionOutcome, { ok: true }>,
): WorkflowStepReconciliationResult {
  if (outcome.reason === "step_not_found") {
    return { status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotFound };
  }
  return {
    status: WORKFLOW_RECONCILE_RESULT_STATUS.stepNotRunning,
    detail: outcome.from,
  };
}

/**
 * Release the run's outstanding `dispatch` lease by its stored identity. A no-op
 * when no dispatch lease exists or it is already released. Newer leases are
 * protected unless the caller is finalizing an active subworkflow recheck.
 */
function releaseHeldDispatchLease(
  db: MomentumDb,
  runId: string,
  dispatchStartedAt: number | null,
  releaseReacquiredLease: boolean,
  now: number,
  expectedLease?: { holder: string; acquiredAt: number },
): void {
  if (dispatchStartedAt === null) return;
  const lease = getWorkflowLease(db, runId, "dispatch");
  if (lease === undefined || lease.releasedAt !== null) return;
  if (
    expectedLease !== undefined &&
    (lease.holder !== expectedLease.holder ||
      lease.acquiredAt !== expectedLease.acquiredAt)
  ) {
    return;
  }
  if (
    expectedLease === undefined &&
    lease.acquiredAt > dispatchStartedAt &&
    !releaseReacquiredLease
  )
    return;
  releaseWorkflowLease(db, {
    runId: lease.runId,
    leaseKind: lease.leaseKind,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    now,
  });
}

/** Deterministic, idempotent id for the reconciliation manual-recovery gate. */
function deriveReconcileRecoveryGateId(
  runId: string,
  stepId: string,
  invocationState: string,
): string {
  return `${runId}::${stepId}::reconcile-recovery::${invocationState}`;
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in a transaction; nothing to do.
  }
}
