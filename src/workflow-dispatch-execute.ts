/**
 * Side-effecting twin of the production workflow-lane dispatcher (M10-09a,
 * NGX-367).
 *
 * `workflow-dispatch.ts` owns the *pure* dispatch decision and
 * `workflow-dispatch-persist.ts` owns the *read-only* resolution that produces
 * it. This module owns the third layer: applying that decision durably as the
 * scheduler's executor-dispatch seam. {@link executeWorkflowStepDispatch} has the
 * exact {@link WorkflowStepDispatch} shape `runWorkflowSchedulerOnce` calls with a
 * claimed step, so the bounded `daemon start` workflow lane can pass it straight
 * through with no test-only injection. It is the storage/effect twin of the
 * dispatch brain, exactly as `workflow-gate-persist.ts` is the effect twin of
 * `workflow-gate.ts`.
 *
 * The seam contract (`workflow-scheduler.ts`): "On a normal return the dispatcher
 * owns the dispatch lease's lifecycle (refresh across rounds, release on
 * terminal). If it throws, the lane releases the lease." This module honours both
 * halves and never silently no-ops a claimed step:
 *
 *   - **dispatch** (a phase-1 dispatchable family): atomically advance the step
 *     `approved -> running` (so the lane stops re-offering it) and create the
 *     durable `executor_invocations` + first `executor_rounds` start scaffold —
 *     the contract's Round Lifecycle "create the round row before external work
 *     runs", proof through the production path that a bounded executor session
 *     started. The dispatch lease is *held* (the executor session is in progress,
 *     not terminal), the lane's liveness token aging out under its TTL so a
 *     later stale-lease recovery reclaims it; nothing is stranded.
 *   - **fail_closed** (unresolvable, under-configured, or an unsupported family):
 *     a terminal outcome. Atomically flag the run `needs_manual_recovery` and open
 *     a durable, operator-visible `workflow_gates` manual-recovery row hung from
 *     the step, then *release* the dispatch lease. The run is parked (the scan
 *     excludes manual-recovery runs) so it is never re-dispatched, and the lease
 *     is not stranded.
 *
 * Both paths are wrapped in a single `BEGIN IMMEDIATE` transaction so a mid-write
 * failure can never leave a half-dispatched step, an orphaned invocation, or a
 * gate without its recovery flag; on any throw the transaction rolls back and the
 * error propagates to the lane, which then releases the just-acquired lease.
 *
 * Phase-1 boundary (validated by the NGX-353 closeout dogfood): this path
 * stops at the *start scaffold*. It does not run the bounded executor mechanism,
 * drive the round `pending -> running -> terminal`, run verification / commit
 * finalization, or advance the step to a terminal state — those are owned by the
 * landed `runGoalLoopStep` / `runSingleShotStep` / `runNoMistakesMirrorStep`
 * adapters, wired in behind this seam in the real-adapter follow-up. The phase-1
 * invocation / round ids are deliberately namespaced (`...::dispatch`) so that
 * follow-up owns reconciling the scaffold with the adapters' own reattachable ids
 * rather than silently colliding with them.
 */

import type { MomentumDb } from "./db.js";
import {
  insertExecutorInvocation,
  insertExecutorRound,
  loadExecutorInvocation
} from "./executor-loop-persist.js";
import type {
  ExecutorInvocationRecord,
  ExecutorRoundRecord,
  WorkflowExecutorFamily
} from "./executor-loop-reducer.js";
import {
  insertWorkflowGate,
  loadWorkflowGate
} from "./workflow-gate-persist.js";
import type { WorkflowGateType } from "./workflow-gate.js";
import { releaseWorkflowLease } from "./workflow-leases.js";
import { markWorkflowRunNeedsManualRecovery } from "./workflow-run-recovery.js";
import { resolveWorkflowStepDispatchPlan } from "./workflow-dispatch-persist.js";
import type { WorkflowDispatchFailClosedCode } from "./workflow-dispatch.js";
import { deriveWorkflowMonitorState } from "./workflow-monitor-state.js";
import {
  startWorkflowStep,
  type WorkflowStepTransitionOutcome
} from "./workflow-step-transitions.js";
import {
  type WorkflowLeaseRecord,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "./workflow-run-reducer.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult
} from "./workflow-scheduler.js";

/**
 * Stable `WorkflowStepDispatchResult.status` strings this dispatcher echoes into
 * the scheduler tick result for daemon telemetry, tests, and operator surfaces.
 */
export const WORKFLOW_DISPATCH_RESULT_STATUS = {
  /** A phase-1 dispatchable step's executor start scaffold was created. */
  dispatched: "executor_dispatched",
  /** A re-entered dispatch found the existing scaffold and made no change. */
  alreadyDispatched: "executor_already_dispatched",
  /** An unsupported / unresolvable step was parked to a manual-recovery gate. */
  failClosed: "manual_recovery_gated",
  /** The step left `approved` between claim and dispatch; nothing was written. */
  stepNotStartable: "step_not_startable"
} as const;

/** The operator actions a phase-1 fail-closed manual-recovery gate offers. */
const FAIL_CLOSED_GATE_ACTIONS: readonly string[] = ["clear_recovery", "abort_run"];
const FAIL_CLOSED_RECOMMENDED_ACTION = "clear_recovery";

/**
 * Apply the production workflow-lane dispatch decision for a claimed step. This
 * is the {@link WorkflowStepDispatch} the bounded `daemon start` lane invokes; see
 * the module doc for the dispatch / fail-closed effects and lease lifecycle.
 *
 * Total with respect to the decision: every claimed step either creates a durable
 * executor scaffold or a durable manual-recovery outcome — it never returns
 * without a recorded effect for a resolvable, supported step, and never strands a
 * lease for an unsupported one.
 */
export function executeWorkflowStepDispatch(
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext
): WorkflowStepDispatchResult {
  const { db, now } = context;
  const plan = resolveWorkflowStepDispatchPlan(db, {
    runId: claim.runId,
    stepId: claim.stepId
  });

  if (plan.action === "fail_closed") {
    return failClosedDispatch(db, claim, {
      code: plan.code,
      gateType: plan.gateType,
      reason: plan.reason,
      now
    });
  }

  return dispatchExecutorScaffold(db, claim, plan.executorFamily, now);
}

/**
 * Advance the step and create the executor start scaffold for a dispatchable
 * family, atomically. Idempotent: a re-entry whose invocation already exists
 * returns without duplicating rows.
 */
function dispatchExecutorScaffold(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  family: WorkflowExecutorFamily,
  now: number
): WorkflowStepDispatchResult {
  const invocationId = deriveDispatchInvocationId(claim.runId, claim.stepId);
  if (loadExecutorInvocation(db, invocationId) !== undefined) {
    return {
      status: WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
      detail: invocationId
    };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const started = startWorkflowStep(db, {
      runId: claim.runId,
      stepId: claim.stepId,
      now
    });
    if (!started.ok) {
      db.exec("ROLLBACK");
      // The step left `approved` under us (another worker, or operator action)
      // between claim and dispatch. Do not write a half scaffold; release our
      // lease so the run is not held busy and re-evaluate on the next tick.
      releaseDispatchLease(db, claim, now);
      return {
        status: WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
        detail: describeStartFailure(started)
      };
    }

    insertExecutorInvocation(
      db,
      buildInvocationScaffold(claim, family, invocationId, now),
      { now }
    );
    insertExecutorRound(
      db,
      buildRoundScaffold(claim, family, invocationId, now),
      { now }
    );
    refreshWorkflowRunStateAfterDispatch(db, claim.runId, now);
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    throw error;
  }

  return {
    status: WORKFLOW_DISPATCH_RESULT_STATUS.dispatched,
    detail: `${family} ${invocationId}`
  };
}

/**
 * Park a run for manual recovery and open a durable, operator-visible gate, then
 * release the dispatch lease — the fail-closed terminal outcome. Atomic so the
 * gate and the recovery flag can never drift. Idempotent on the gate id.
 */
function failClosedDispatch(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  outcome: {
    code: WorkflowDispatchFailClosedCode;
    gateType: WorkflowGateType;
    reason: string;
    now: number;
  }
): WorkflowStepDispatchResult {
  const { code, gateType, reason, now } = outcome;
  db.exec("BEGIN IMMEDIATE");
  try {
    const marked = markWorkflowRunNeedsManualRecovery(db, {
      runId: claim.runId,
      reason,
      now
    });
    // A gate has a NOT NULL FK to workflow_runs; only open one when the run still
    // exists. A vanished run (run_not_found) cannot carry a gate, but the lease
    // release below still runs so nothing is stranded.
    if (marked.ok) {
      const gateId = deriveDispatchGateId(claim.runId, claim.stepId, code);
      if (loadWorkflowGate(db, gateId) === undefined) {
        insertWorkflowGate(
          db,
          {
            gateId,
            workflowRunId: claim.runId,
            stepRunId: claim.stepId,
            targetScope: "step",
            gateType,
            reason,
            evidence: code,
            allowedActions: FAIL_CLOSED_GATE_ACTIONS,
            recommendedAction: FAIL_CLOSED_RECOMMENDED_ACTION
          },
          { now }
        );
      }
    }
    releaseDispatchLease(db, claim, now);
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    throw error;
  }

  return {
    status: WORKFLOW_DISPATCH_RESULT_STATUS.failClosed,
    detail: `${code}: ${reason}`
  };
}

function buildInvocationScaffold(
  claim: ClaimedWorkflowStep,
  family: WorkflowExecutorFamily,
  invocationId: string,
  now: number
): ExecutorInvocationRecord {
  return {
    invocationId,
    workflowRunId: claim.runId,
    stepRunId: claim.stepId,
    stepKey: claim.stepId,
    executorFamily: family,
    state: "running",
    attempt: 1,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null
  };
}

function buildRoundScaffold(
  claim: ClaimedWorkflowStep,
  family: WorkflowExecutorFamily,
  invocationId: string,
  now: number
): ExecutorRoundRecord {
  return {
    roundId: deriveDispatchRoundId(invocationId),
    invocationId,
    workflowRunId: claim.runId,
    stepRunId: claim.stepId,
    stepKey: claim.stepId,
    executorFamily: family,
    attempt: 1,
    roundIndex: 1,
    // The contract's Round Lifecycle creates the round row before external work
    // runs; the bounded mechanism that drives it `running -> terminal` is the
    // real-adapter follow-up.
    state: "pending",
    classification: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: null,
    keyChanges: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null
  };
}

/**
 * The phase-1 dispatch scaffold's deterministic invocation id. Namespaced with
 * `::dispatch` so it is recomputable from durable state (idempotent re-entry) yet
 * unmistakably the phase-1 dispatcher's row, not a landed adapter's reattachable
 * id (see the module doc's phase-1 boundary note).
 */
function deriveDispatchInvocationId(runId: string, stepId: string): string {
  return `${runId}::${stepId}::dispatch`;
}

function deriveDispatchRoundId(invocationId: string): string {
  return `${invocationId}::round-1`;
}

/** Deterministic, idempotent id for the fail-closed manual-recovery gate. */
function deriveDispatchGateId(
  runId: string,
  stepId: string,
  code: WorkflowDispatchFailClosedCode
): string {
  return `${runId}::${stepId}::dispatch-fail::${code}`;
}

function releaseDispatchLease(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  now: number
): void {
  releaseWorkflowLease(db, {
    runId: claim.lease.runId,
    leaseKind: claim.lease.leaseKind,
    holder: claim.lease.holder,
    acquiredAt: claim.lease.acquiredAt,
    now
  });
}

function refreshWorkflowRunStateAfterDispatch(
  db: MomentumDb,
  runId: string,
  now: number
): void {
  const steps = loadWorkflowStepRecords(db, runId);
  const leases = loadWorkflowLeaseRecords(db, runId);
  const monitorState = deriveWorkflowMonitorState({
    runId,
    steps,
    leases,
    monitor: null,
    lastCheckpoint: null,
    now
  });
  const finishedAt = monitorState.terminal ? now : null;
  db.prepare(
    `UPDATE workflow_runs
       SET state = ?,
           started_at = COALESCE(started_at, ?),
           finished_at = COALESCE(finished_at, ?),
           monitor_last_seen_state = ?,
           monitor_terminal = ?,
           monitor_step = ?,
           monitor_last_seen_digest = NULL,
           monitor_last_emitted_digest = NULL,
           updated_at = ?
     WHERE id = ?`
  ).run(
    monitorState.runState,
    now,
    finishedAt,
    monitorState.runState,
    monitorState.terminal ? 1 : 0,
    monitorState.activeStep?.stepId ?? null,
    now,
    runId
  );
}

function loadWorkflowStepRecords(
  db: MomentumDb,
  runId: string
): WorkflowStepRecord[] {
  const rows = db
    .prepare(
      `SELECT step_id, kind, state, step_order, required
         FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_order, step_id`
    )
    .all(runId) as Array<{
    step_id: string;
    kind: string;
    state: string;
    step_order: number;
    required: number;
  }>;
  return rows.map((row) => ({
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    state: row.state as WorkflowStepState,
    order: row.step_order,
    required: row.required === 1
  }));
}

function loadWorkflowLeaseRecords(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, released_at, stale_policy
         FROM workflow_leases
        WHERE run_id = ?`
    )
    .all(runId) as Array<{
    run_id: string;
    lease_kind: string;
    holder: string;
    acquired_at: number;
    expires_at: number;
    heartbeat_at: number;
    released_at: number | null;
    stale_policy: string;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    leaseKind: row.lease_kind as WorkflowLeaseRecord["leaseKind"],
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseRecord["stalePolicy"]
  }));
}

function describeStartFailure(
  outcome: Exclude<WorkflowStepTransitionOutcome, { ok: true }>
): string {
  if (outcome.reason === "step_not_found") return "step_not_found";
  return `not_approved (was ${outcome.from})`;
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in a transaction; nothing to do.
  }
}
