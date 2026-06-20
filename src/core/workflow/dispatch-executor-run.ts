/**
 * Dispatched-step execution path (RC-5b, NGX-492).
 *
 * The production dispatch lane is built from three landed halves that, before
 * this module, were never composed in production:
 *
 *   1. `dispatch-execute.ts` advances a claimed step `approved -> running`,
 *      creates the `<run>::<step>::dispatch` executor invocation (`running`) +
 *      first round (`pending`) start scaffold, and holds the dispatch lease.
 *   2. `dispatch-executor-terminalize.ts` records a finished
 *      {@link WorkflowStepExecutorDispatchResult} as terminal evidence on that
 *      scaffold's invocation / round (succeeded / failed, or manual_recovery for
 *      an unconfigured / process-level failure).
 *   3. `dispatch-reconcile-execute.ts` (RC-2) finalizes the owning
 *      `workflow_steps` row from that terminal invocation, exactly once.
 *
 * The gap RC-5b closes is the *producer* in the middle: nothing in production ran
 * the dispatched step's executor to yield the result step 2 consumes, so a
 * dispatched step stayed `running` forever (or only advanced under the
 * test/dogfood-only `dogfood-dispatch.ts` stand-in). This module owns that
 * producer and the composition:
 *
 *   run the dispatched step's executor (through the injected real registry)
 *     -> terminalize its result as durable evidence
 *     -> let the RC-2 seam finalize the step from that evidence.
 *
 * It deliberately takes the {@link WorkflowStepExecutorRegistry} by injection
 * rather than resolving a daemon-default live-wrapper profile itself: a configured
 * profile resolves a kind to a real live executor that spawns the local command;
 * an unconfigured registry resolves the kind to the honest
 * `runtime_unavailable` adapter so dispatch fails honestly into manual recovery
 * rather than fabricating a clean terminal. The `daemon start` lane owns
 * resolving the daemon-default profile source before calling this reusable,
 * registry-agnostic execution path.
 *
 * Boundary discipline (so RC-2 stays the single finalization owner and the M9
 * direct-finalize lane is never double-finalized):
 *
 *   - It acts only when a `<run>::<step>::dispatch` invocation exists. A step
 *     finalized by an M9 live wrapper (or never dispatched through the M10 lane)
 *     writes no such invocation, so this seam refuses it (`notDispatched`) and
 *     never runs an executor against it.
 *   - It never calls `finishWorkflowStep`, never writes `executor_invocations` /
 *     `executor_rounds` directly (the terminalize seam owns the scaffold rows),
 *     and never releases the dispatch lease (the RC-2 seam does, on terminal).
 *   - Idempotent on re-entry: once the dispatch invocation is terminal, a prior
 *     execution already ran the bounded session, so a re-entered tick NEVER
 *     re-runs the executor (no second process, no duplicate evidence). It only
 *     re-drives the idempotent RC-2 reconciliation to converge the finalization.
 */

import type { MomentumDb } from "../../adapters/db.js";
import { isTerminalExecutorInvocationState } from "../executors/loop-reducer.js";
import { loadExecutorInvocation } from "../executors/loop-persist.js";
import { deriveDispatchInvocationId } from "./dispatch-execute.js";
import {
  terminalizeDispatchedExecutorInvocation,
  type TerminalizeDispatchedExecutorResult
} from "./dispatch-executor-terminalize.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult
} from "./dispatch-reconcile-execute.js";
import { getWorkflowStep } from "./step-transitions.js";
import {
  dispatchWorkflowStepExecutor,
  type WorkflowStepExecutorDispatchResult,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
  type WorkflowStepExecutorRegistry
} from "./step-executor.js";

/**
 * The per-run/per-step execution context the dispatched step's executor needs:
 * the repo it operates on, the bounded session's working directory, and the
 * result / log paths. The caller (the daemon lane) derives these from the durable
 * run row and the data-dir layout; this module forwards them verbatim into the
 * executor input.
 */
export type DispatchedStepExecutorContext = {
  repoPath: string;
  runDir: string;
  resultJsonPath: string;
  executorLogPath: string;
  /** Bounded-session attempt; defaults to 1 when omitted. */
  attempt?: number;
  promptPath?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
};

/**
 * Build the {@link WorkflowStepExecutorInput} for a dispatched step from its
 * durable `kind` plus the per-run execution context. Optional fields are
 * forwarded only when present so `exactOptionalPropertyTypes` stays honest.
 */
export function buildDispatchedStepExecutorInput(
  kind: WorkflowStepExecutorKind,
  runId: string,
  stepId: string,
  exec: DispatchedStepExecutorContext
): WorkflowStepExecutorInput {
  return {
    runId,
    stepId,
    kind,
    attempt: exec.attempt ?? 1,
    repoPath: exec.repoPath,
    runDir: exec.runDir,
    resultJsonPath: exec.resultJsonPath,
    executorLogPath: exec.executorLogPath,
    ...(exec.promptPath !== undefined ? { promptPath: exec.promptPath } : {}),
    ...(exec.ledgerPath !== undefined ? { ledgerPath: exec.ledgerPath } : {}),
    ...(exec.env !== undefined ? { env: exec.env } : {}),
    ...(exec.config !== undefined ? { config: exec.config } : {})
  };
}

/**
 * Stable `status` strings the execution path returns for daemon telemetry, tests,
 * and operator surfaces. Each is a recorded outcome — the seam never returns
 * without explaining what it did to a dispatched step.
 */
export const WORKFLOW_EXECUTE_RECONCILE_STATUS = {
  /** No `<run>::<step>::dispatch` invocation: not this seam's step (M9 lane). */
  notDispatched: "execute_not_dispatched",
  /** The dispatched step row vanished between dispatch and execution. */
  stepNotFound: "execute_step_not_found",
  /** The dispatch invocation is still running but the step is not `running`. */
  stepNotRunning: "execute_step_not_running",
  /** The executor ran and its terminal evidence was reconciled this call. */
  executedAndReconciled: "execute_reconciled",
  /** Re-entry over an already-terminal invocation: executor not re-run. */
  alreadyExecuted: "execute_already_executed",
  /** Terminal evidence exists, but RC-2 reconciliation threw and must be retried. */
  reconcileDeferred: "execute_reconcile_deferred",
  /**
   * The dispatched step's execution context could not be derived, so the run was
   * parked for manual recovery WITHOUT running an executor (no clean terminal was
   * fabricated). See {@link recordUnresolvedDispatchedStepContext}.
   */
  contextUnresolved: "execute_context_unresolved",
  executionRejected: "execute_rejected"
} as const;

export type WorkflowExecuteReconcileStatus =
  (typeof WORKFLOW_EXECUTE_RECONCILE_STATUS)[keyof typeof WORKFLOW_EXECUTE_RECONCILE_STATUS];

export type ExecuteAndReconcileDispatchedStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /**
   * The `WorkflowStepExecutor` registry used to run the dispatched step. A
   * configured live-wrapper profile resolves to a real live executor; an
   * unconfigured registry resolves to the honest `runtime_unavailable` adapter.
   */
  registry: WorkflowStepExecutorRegistry;
  exec: DispatchedStepExecutorContext;
  now: number;
};

export type ExecuteAndReconcileDispatchedStepResult = {
  status: WorkflowExecuteReconcileStatus;
  /** The executor result, when the executor was run this call. */
  executorResult?: WorkflowStepExecutorDispatchResult;
  /** The terminalize outcome, when the executor was run this call. */
  terminalize?: TerminalizeDispatchedExecutorResult;
  /** The RC-2 reconciliation outcome, when reconciliation was attempted. */
  reconcile?: WorkflowStepReconciliationResult;
  detail?: string;
};

/**
 * Run a dispatched step's executor and finalize it through RC-2. The production
 * composition of "run executor -> terminalize evidence -> reconcile"; see the
 * module doc for the boundary discipline (single finalization owner, M9-lane
 * refusal, idempotent re-entry that never re-runs the executor).
 */
export function executeAndReconcileDispatchedWorkflowStep(
  input: ExecuteAndReconcileDispatchedStepInput
): ExecuteAndReconcileDispatchedStepResult {
  const { db, runId, stepId, registry, exec, now } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: an M9 direct-finalize / never-dispatched
    // step. The seam owns only dispatched scaffolds, so it refuses and never runs
    // an executor — the structural guard against a double finalize.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: invocationId
    };
  }

  if (isTerminalExecutorInvocationState(invocation.state)) {
    // Idempotent re-entry: a prior execution already ran the bounded session and
    // recorded its terminal evidence. NEVER re-run the executor (a second process
    // / duplicate evidence); just re-drive the idempotent RC-2 reconciliation so
    // a crashed prior finalize still converges the step / lease / run-state.
    const reconciled = tryReconcileDispatchedWorkflowStep({
      db,
      runId,
      stepId,
      now
    });
    if (!reconciled.ok) {
      return {
        status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
        detail: reconciled.detail
      };
    }
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
      reconcile: reconciled.reconcile,
      detail: invocation.state
    };
  }

  const step = getWorkflowStep(db, runId, stepId);
  if (step === undefined) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotFound,
      detail: stepId
    };
  }
  if (step.state !== "running") {
    // The scaffold invocation is still `running` but the owning step is not, an
    // unexpected lane state the seam refuses rather than executing over.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotRunning,
      detail: step.state
    };
  }

  // Run the dispatched step's executor through the injected registry. This is the
  // only step that performs external work (a live wrapper spawns a process), so
  // it runs OUTSIDE any database transaction.
  const executorInput = buildDispatchedStepExecutorInput(
    step.kind,
    runId,
    stepId,
    exec
  );
  const executorResult = dispatchWorkflowStepExecutor(
    step.kind,
    executorInput,
    registry
  );

  // Record the result as terminal evidence, then let RC-2 finalize the step from
  // it. terminalize and reconcile are each idempotent and own their own
  // transactions.
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: executorResult,
    now
  });
  const reconciled = tryReconcileDispatchedWorkflowStep({
    db,
    runId,
    stepId,
    now
  });
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: reconciled.detail
    };
  }

  return {
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    executorResult,
    terminalize,
    reconcile: reconciled.reconcile
  };
}

export type RecordDispatchedStepManualRecoveryInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  error: string;
  now: number;
  status?: WorkflowExecuteReconcileStatus;
  detail?: string;
};

export type RecordUnresolvedDispatchedStepContextInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Why the execution context could not be derived (preserved as evidence). */
  reason: string;
  now: number;
};

export function recordDispatchedStepManualRecovery(
  input: RecordDispatchedStepManualRecoveryInput
): ExecuteAndReconcileDispatchedStepResult {
  const { db, runId, stepId, error, now } = input;
  const executorResult: WorkflowStepExecutorDispatchResult = {
    ok: false,
    code: "runtime_unavailable",
    error,
    executorLogPath: undefined,
    resultJsonPath: undefined
  };
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: executorResult,
    now
  });
  const reconciled = tryReconcileDispatchedWorkflowStep({
    db,
    runId,
    stepId,
    now
  });
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: reconciled.detail
    };
  }
  return {
    status: input.status ?? WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
    executorResult,
    terminalize,
    reconcile: reconciled.reconcile,
    detail: input.detail ?? error
  };
}

/**
 * Record that a dispatched step's executor could not be RUN because its execution
 * context could not be derived (e.g. the run carries no repo path the bounded
 * session could work in), routing the step to manual recovery through the SAME
 * `terminalize -> RC-2 reconcile` path an honest `runtime_unavailable` executor
 * result takes — without running any executor and without fabricating a clean
 * terminal.
 *
 * The daemon lane (`live-wrapper-dispatch.ts`) calls this when its context deriver
 * refuses. Deriving the context happens INSIDE the dispatch closure, *after* the
 * base dispatch advanced the step `approved -> running` and created the
 * `<run>::<step>::dispatch` scaffold. Throwing there would make the scheduler
 * release the dispatch lease and rethrow (its dispatch contract), stranding a
 * `running` step with no terminal evidence and no recovery gate. Recording manual
 * recovery instead parks the run safely — `needs_manual_recovery` + an
 * operator-visible gate, with RC-2 releasing the held lease — the no-stranded-step
 * guarantee.
 *
 * Idempotent on re-entry: `terminalizeDispatchedExecutorInvocation` preserves an
 * already-terminal invocation and `reconcileDispatchedWorkflowStep` re-converges
 * the parked run, so a re-entered tick records no duplicate evidence and opens no
 * duplicate gate. A step with no dispatch invocation (the M9 direct-finalize lane)
 * is left untouched: both seams refuse it and write nothing.
 */

export function recordUnresolvedDispatchedStepContext(
  input: RecordUnresolvedDispatchedStepContextInput
): ExecuteAndReconcileDispatchedStepResult {
  const { runId, stepId, reason } = input;
  return recordDispatchedStepManualRecovery({
    ...input,
    error: `cannot derive execution context for dispatched step ${runId}/${stepId}: ${reason}`,
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
    detail: reason
  });
}

function tryReconcileDispatchedWorkflowStep(input: {
  db: MomentumDb;
  runId: string;
  stepId: string;
  now: number;
}):
  | { ok: true; reconcile: WorkflowStepReconciliationResult }
  | { ok: false; detail: string } {
  try {
    return {
      ok: true,
      reconcile: reconcileDispatchedWorkflowStep(input)
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
