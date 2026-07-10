/**
 * Side-effecting twin of the production workflow-lane dispatcher.
 *
 * `dispatch.ts` owns the *pure* dispatch decision and
 * `dispatch/persist.ts` owns the *read-only* resolution that produces
 * it. This module owns the third layer: applying that decision durably as the
 * scheduler's executor-dispatch seam. {@link executeWorkflowStepDispatch} has the
 * exact {@link WorkflowStepDispatch} shape `runWorkflowSchedulerOnce` calls with a
 * claimed step, so the bounded `daemon start` workflow lane can pass it straight
 * through with no test-only injection. It is the storage/effect twin of the
 * dispatch brain, exactly as `gate/persist.ts` is the effect twin of
 * `gate/gate.ts`.
 *
 * The seam contract (`dispatch/scheduler.ts`): "On a normal return the dispatcher
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
 *     the step when the run row still exists, then *release* the dispatch lease.
 *     The run is parked (the scan excludes manual-recovery runs) so it is never
 *     re-dispatched, and the lease is not stranded. If the run vanished between
 *     claim and dispatch, no gate or recovery flag can be written without
 *     orphaning evidence, so the orphaned dispatch lease is still released.
 *
 * Both paths are wrapped in a single `BEGIN IMMEDIATE` transaction so a mid-write
 * failure can never leave a half-dispatched step, an orphaned invocation, or a
 * gate without its recovery flag; on any throw the transaction rolls back and the
 * error propagates to the lane, which then releases the just-acquired lease.
 *
 * Phase-1 boundary (validated by the closeout dogfood and clarified by
 * the runtime consolidation plan): this path stops at the *start
 * scaffold*. It does not run the bounded executor mechanism, drive the round
 * `pending -> running -> terminal`, run verification / commit finalization, or
 * advance the step to a terminal state. The landed `runGoalLoopStep` /
 * `runSingleShotStep` / `runNoMistakesMirrorStep` adapters own nested
 * `executor_invocations` / `executor_rounds` evidence only; the reconciliation seam
 * reconciliation seam (`dispatch/reconcile-execute.ts`) is now the
 * single owner that converts terminal executor evidence into the workflow step's
 * terminal transition. The phase-1 invocation /
 * round ids are deliberately namespaced (`...::dispatch`) so that follow-up owns
 * reconciling the scaffold with the adapters' own reattachable ids rather than
 * silently colliding with them.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  insertExecutorInvocation,
  insertExecutorRound,
  loadExecutorInvocation,
} from "../../executors/loop/persist.js";
import type {
  ExecutorInvocationRecord,
  ExecutorRoundRecord,
  WorkflowExecutorFamily,
} from "../../executors/loop/reducer.js";
import { CODING_WORKFLOW_DEFINITION_KEY } from "../definition/definition.js";
import {
  CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY,
  CURRENT_GNHF_CWFP_IMPLEMENTATION_ENGINE,
  GNHF_IMPLEMENTATION_ENGINE,
  NATIVE_GOAL_LOOP_IMPLEMENTATION_ENGINE,
  isCodingImplementationEngine,
  readCodingStepRouteOverrides,
  resolveCodingStepExecutorSelection,
  type CodingImplementationEngine,
  type CodingStepExecutorSelection,
} from "../route/coding.js";
import { insertWorkflowGate, loadWorkflowGate } from "../gate/persist.js";
import type { WorkflowGateType } from "../gate/gate.js";
import { releaseWorkflowLease } from "../leases.js";
import { markWorkflowRunNeedsManualRecovery } from "../run/recovery.js";
import { resolveWorkflowStepDispatchPlan } from "./persist.js";
import type { WorkflowDispatchFailClosedCode } from "./dispatch.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../run/start.js";
import { reopenRetryableDispatchInvocationForAttempt } from "./retry.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import {
  startWorkflowStep,
  type WorkflowStepTransitionOutcome,
} from "../step/transitions.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult,
} from "./scheduler.js";

/**
 * Stable `WorkflowStepDispatchResult.status` strings this dispatcher echoes into
 * the scheduler tick result for daemon telemetry, tests, and operator surfaces.
 */
export const WORKFLOW_DISPATCH_RESULT_STATUS = {
  /** A phase-1 dispatchable step's executor start scaffold was created. */
  dispatched: "executor_dispatched",
  /** A re-entered dispatch found the existing scaffold and made no change. */
  alreadyDispatched: "executor_already_dispatched",
  /** An unsupported / unresolvable step was parked, or an orphaned lease released. */
  failClosed: "manual_recovery_gated",
  /** The step left `approved` between claim and dispatch; nothing was written. */
  stepNotStartable: "step_not_startable",
} as const;

/** The operator actions a phase-1 fail-closed manual-recovery gate offers. */
const FAIL_CLOSED_GATE_ACTIONS: readonly string[] = [
  "clear_recovery",
  "abort_run",
];
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
  context: WorkflowStepDispatchContext,
): WorkflowStepDispatchResult {
  const { db, now } = context;
  const plan = resolveWorkflowStepDispatchPlan(db, {
    runId: claim.runId,
    stepId: claim.stepId,
  });

  if (plan.action === "fail_closed") {
    return failClosedDispatch(db, claim, {
      code: plan.code,
      gateType: plan.gateType,
      reason: plan.reason,
      now,
    });
  }

  const selection = resolveDispatchRoundSelection(db, claim);
  if (!selection.ok) {
    return failClosedDispatch(db, claim, {
      code: "route_config_invalid",
      gateType: "manual_recovery_required",
      reason: selection.reason,
      now,
    });
  }

  return dispatchExecutorScaffold(
    db,
    claim,
    plan.executorFamily,
    now,
    selection.selection,
  );
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
  now: number,
  selection: CodingStepExecutorSelection,
): WorkflowStepDispatchResult {
  const invocationId = deriveDispatchInvocationId(claim.runId, claim.stepId);
  if (loadExecutorInvocation(db, invocationId) !== undefined) {
    const reopened = dispatchRetryScaffold(db, claim, now, selection);
    if (reopened.reopened) {
      return {
        status: WORKFLOW_DISPATCH_RESULT_STATUS.dispatched,
        detail: `${family} ${reopened.invocationId} attempt ${reopened.attempt}`,
      };
    }
    return {
      status: WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
      detail: invocationId,
    };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const started = startWorkflowStep(db, {
      runId: claim.runId,
      stepId: claim.stepId,
      now,
    });
    if (!started.ok) {
      db.exec("ROLLBACK");
      // The step left `approved` under us (another worker, or operator action)
      // between claim and dispatch. Do not write a half scaffold; release our
      // lease so the run is not held busy and re-evaluate on the next tick.
      releaseDispatchLease(db, claim, now);
      return {
        status: WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
        detail: describeStartFailure(started),
      };
    }

    insertExecutorInvocation(
      db,
      buildInvocationScaffold(claim, family, invocationId, now),
      { now },
    );
    insertExecutorRound(
      db,
      buildRoundScaffold(claim, family, invocationId, now, selection),
      { now },
    );
    refreshWorkflowRunStateAfterDispatch(db, claim.runId, now);
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    throw error;
  }

  return {
    status: WORKFLOW_DISPATCH_RESULT_STATUS.dispatched,
    detail: `${family} ${invocationId}`,
  };
}

function dispatchRetryScaffold(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  now: number,
  selection: CodingStepExecutorSelection,
): ReturnType<typeof reopenRetryableDispatchInvocationForAttempt> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const started = startWorkflowStep(db, {
      runId: claim.runId,
      stepId: claim.stepId,
      now,
    });
    if (!started.ok) {
      db.exec("ROLLBACK");
      return { reopened: false };
    }
    const reopened = reopenRetryableDispatchInvocationForAttempt(db, {
      runId: claim.runId,
      stepId: claim.stepId,
      now,
      stepState: "running",
      selection,
    });
    if (!reopened.reopened) {
      db.exec("ROLLBACK");
      return reopened;
    }
    refreshWorkflowRunStateAfterDispatch(db, claim.runId, now);
    db.exec("COMMIT");
    return reopened;
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/**
 * Park a run for manual recovery and open a durable, operator-visible gate when
 * the run row still exists, then release the dispatch lease — the fail-closed
 * terminal outcome. Atomic so the gate and recovery flag can never drift. A
 * vanished run cannot satisfy the gate FK, so that branch releases only.
 * Idempotent on the gate id.
 */
function failClosedDispatch(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  outcome: {
    code: WorkflowDispatchFailClosedCode;
    gateType: WorkflowGateType;
    reason: string;
    now: number;
  },
): WorkflowStepDispatchResult {
  const { code, gateType, reason, now } = outcome;
  db.exec("BEGIN IMMEDIATE");
  try {
    const marked = markWorkflowRunNeedsManualRecovery(db, {
      runId: claim.runId,
      reason,
      now,
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
            recommendedAction: FAIL_CLOSED_RECOMMENDED_ACTION,
          },
          { now },
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
    detail: `${code}: ${reason}`,
  };
}

function buildInvocationScaffold(
  claim: ClaimedWorkflowStep,
  family: WorkflowExecutorFamily,
  invocationId: string,
  now: number,
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
    finishedAt: null,
  };
}

function buildRoundScaffold(
  claim: ClaimedWorkflowStep,
  family: WorkflowExecutorFamily,
  invocationId: string,
  _now: number,
  selection: CodingStepExecutorSelection,
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
    agentProvider: selection.agentProvider,
    model: selection.model,
    effort: selection.effort,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null,
  };
}

type DispatchRouteSelectionResolution =
  | { ok: true; selection: CodingStepExecutorSelection }
  | { ok: false; reason: string };

type DispatchRouteRow = {
  source: string;
  workflow_definition_key: string | null;
  route_json: string | null;
};

const DEFAULT_DISPATCH_SELECTION: CodingStepExecutorSelection = {
  agentProvider: null,
  model: null,
  effort: null,
};

function resolveDispatchRoundSelection(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
): DispatchRouteSelectionResolution {
  const row = db
    .prepare(
      `SELECT source, workflow_definition_key, route_json
         FROM workflow_runs
        WHERE id = ?`,
    )
    .get(claim.runId) as DispatchRouteRow | undefined;
  if (row === undefined) {
    return { ok: true, selection: DEFAULT_DISPATCH_SELECTION };
  }
  if (
    row.source !== MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE ||
    row.workflow_definition_key !== CODING_WORKFLOW_DEFINITION_KEY
  ) {
    return { ok: true, selection: DEFAULT_DISPATCH_SELECTION };
  }

  const route = parseRouteJson(claim.runId, row.route_json);
  if (!route.ok) {
    return { ok: false, reason: route.reason };
  }
  const implementationEngine = readCodingImplementationEngine(
    claim.runId,
    route.route,
  );
  if (!implementationEngine.ok) {
    return { ok: false, reason: implementationEngine.reason };
  }
  if (
    claim.stepId === "implementation" &&
    implementationEngine.engine === CURRENT_GNHF_CWFP_IMPLEMENTATION_ENGINE
  ) {
    return {
      ok: false,
      reason: `Native coding run ${claim.runId} selected implementationEngine=${CURRENT_GNHF_CWFP_IMPLEMENTATION_ENGINE}, but that compatibility implementation is not wired to the native dispatch lane yet; select ${GNHF_IMPLEMENTATION_ENGINE} or route through the compatibility import path.`,
    };
  }

  const overrides = readCodingStepRouteOverrides(route.route);
  if (!overrides.ok) {
    return {
      ok: false,
      reason: `Native coding run ${claim.runId} route.steps is invalid (${overrides.refusal}${
        overrides.path === undefined ? "" : ` at ${overrides.path}`
      }): ${overrides.reason}`,
    };
  }
  return {
    ok: true,
    selection: resolveCodingStepExecutorSelection(
      overrides.overrides,
      claim.stepId,
    ),
  };
}

function readCodingImplementationEngine(
  runId: string,
  route: Record<string, unknown>,
):
  | { ok: true; engine: CodingImplementationEngine }
  | { ok: false; reason: string } {
  const value = route[CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY];
  if (value === undefined) {
    return { ok: true, engine: NATIVE_GOAL_LOOP_IMPLEMENTATION_ENGINE };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      reason: `Native coding run ${runId} route.implementationEngine is invalid; routing to manual recovery.`,
    };
  }
  const normalized = value.trim();
  if (!isCodingImplementationEngine(normalized)) {
    return {
      ok: false,
      reason: `Native coding run ${runId} route.implementationEngine is unsupported (${normalized}); routing to manual recovery.`,
    };
  }
  return { ok: true, engine: normalized };
}

function parseRouteJson(
  runId: string,
  routeJson: string | null,
):
  { ok: true; route: Record<string, unknown> } | { ok: false; reason: string } {
  if (routeJson === null) return { ok: true, route: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(routeJson);
  } catch {
    return {
      ok: false,
      reason: `Native coding run ${runId} route is corrupt; routing to manual recovery.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `Native coding run ${runId} route is not an object; routing to manual recovery.`,
    };
  }
  return { ok: true, route: parsed as Record<string, unknown> };
}

/**
 * The phase-1 dispatch scaffold's deterministic invocation id. Namespaced with
 * `::dispatch` so it is recomputable from durable state (idempotent re-entry) yet
 * unmistakably the phase-1 dispatcher's row, not a landed adapter's reattachable
 * id (see the module doc's phase-1 boundary note).
 *
 * Exported as the single source of truth for this id: the reconciliation
 * seam (`dispatch/reconcile-execute.ts`) recomputes the same id to find the
 * dispatched step's terminal executor evidence, so the two halves can never drift
 * apart on the namespacing convention.
 */
export function deriveDispatchInvocationId(
  runId: string,
  stepId: string,
): string {
  return `${runId}::${stepId}::dispatch`;
}

function deriveDispatchRoundId(invocationId: string): string {
  return `${invocationId}::round-1`;
}

/** Deterministic, idempotent id for the fail-closed manual-recovery gate. */
function deriveDispatchGateId(
  runId: string,
  stepId: string,
  code: WorkflowDispatchFailClosedCode,
): string {
  return `${runId}::${stepId}::dispatch-fail::${code}`;
}

function releaseDispatchLease(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  now: number,
): void {
  releaseWorkflowLease(db, {
    runId: claim.lease.runId,
    leaseKind: claim.lease.leaseKind,
    holder: claim.lease.holder,
    acquiredAt: claim.lease.acquiredAt,
    now,
  });
}

function refreshWorkflowRunStateAfterDispatch(
  db: MomentumDb,
  runId: string,
  now: number,
): void {
  refreshWorkflowRunRuntimeState(db, {
    runId,
    now,
    startedAt: "coalesce-now",
  });
}

function describeStartFailure(
  outcome: Exclude<WorkflowStepTransitionOutcome, { ok: true }>,
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
