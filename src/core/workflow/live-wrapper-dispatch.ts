/**
 * Live-wrapper daemon dispatch composition (RC-5b, NGX-492).
 *
 * The production dispatch lane is assembled from landed, individually-tested seams:
 *
 *   - `dispatch-execute.ts` (`executeWorkflowStepDispatch`) advances a claimed step
 *     `approved -> running`, creates the `<run>::<step>::dispatch` executor
 *     invocation + first round start scaffold, and holds the dispatch lease.
 *   - `dispatch-executor-run.ts` (`executeAndReconcileDispatchedWorkflowStep`) runs
 *     the dispatched step's executor through an injected registry, records the
 *     result as terminal evidence, and lets the RC-2 reconciliation seam finalize
 *     the step exactly once. It REQUIRES the scaffold to already exist.
 *
 * Nothing in production composed these two in a single daemon tick, so a dispatched
 * step's executor was never run by the daemon: the base dispatch only ever created
 * the scaffold and left the step `running`. This module is that missing composition.
 * It is the production analogue of the test/dogfood `createTerminalizingWorkflowDispatch`
 * (`dogfood-dispatch.ts`): same wrap-the-base-dispatch shape, but it drives the REAL
 * executor registry and finalizes through RC-2 instead of stamping a fake `succeeded`.
 *
 * Boundary discipline (so RC-2 stays the single finalization owner):
 *
 *   - The executor runs only after a dispatch that genuinely started (or re-entered)
 *     a scaffold ({@link shouldRunDispatchedExecutor}). A fail-closed / not-startable
 *     base dispatch already released its lease and either parked the run or wrote
 *     nothing, so this wrapper leaves it untouched and echoes the base result.
 *   - It returns the base dispatch's result verbatim. Step finalization is a durable
 *     side effect layered after the dispatch, exactly as the dogfood wrapper layers
 *     its terminalization — daemon telemetry still reports the dispatch outcome.
 *   - It never releases the dispatch lease or writes step/executor rows itself:
 *     `executeAndReconcileDispatchedWorkflowStep` terminalizes the evidence and the
 *     RC-2 reconcile seam owns the `running -> terminal` finalization + lease release.
 *   - Idempotent on re-entry: a re-entered tick's base dispatch reports
 *     `alreadyDispatched` and the producer recognises the already-terminal invocation,
 *     so the executor is never run a second time.
 *   - A refused context derivation never throws: the deriver returns a total
 *     {@link DispatchedStepExecutorContextResolution}, and an `ok: false` resolution
 *     is routed to manual recovery (`recordUnresolvedDispatchedStepContext`) instead
 *     of running the executor. Throwing inside the dispatch closure — after the base
 *     dispatch advanced the step to `running` and created the scaffold — would make
 *     the scheduler release the dispatch lease and rethrow (its dispatch contract),
 *     stranding a `running` step with no terminal evidence and no recovery gate.
 *
 * It takes the {@link WorkflowStepExecutorRegistry} and the per-step execution-context
 * deriver by injection: daemon callers resolve the daemon-default live-wrapper
 * profile into a registry (`daemon-live-wrapper-profile.ts`) and derive the run-dir
 * / result / log layout (`daemon-dispatch-exec-context.ts`) before handing both to
 * this reusable, registry-agnostic dispatch-lane composition.
 */

import {
  executeAndReconcileDispatchedWorkflowStep,
  recordUnresolvedDispatchedStepContext,
  type DispatchedStepExecutorContext
} from "./dispatch-executor-run.js";
import { WORKFLOW_DISPATCH_RESULT_STATUS } from "./dispatch-execute.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatch,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult
} from "./scheduler.js";
import type { WorkflowStepExecutorRegistry } from "./step-executor.js";

/**
 * The outcome of deriving a dispatched step's execution context. Total so the
 * deriver never has to throw inside the dispatch closure: a refused derivation
 * (`ok: false`) is routed to manual recovery instead — a throw there would make the
 * scheduler release the dispatch lease over a still-`running` step and strand it.
 * The `reason` is preserved as the parked run's recovery evidence. Kept general
 * (`reason: string`) so the wrapper does not couple to the daemon lane's specific
 * refusal codes; the daemon deriver's narrower resolution is assignable to it.
 */
export type DispatchedStepExecutorContextResolution =
  | { ok: true; exec: DispatchedStepExecutorContext }
  | { ok: false; reason: string };

/**
 * Derive the per-run/per-step execution context a claimed dispatched step's executor
 * needs (repo path, run dir, result / log paths). Injected so the daemon-lane caller
 * owns the run-dir layout decision; the wrapper forwards a resolved context verbatim
 * into the execution-path producer and routes a refused derivation through manual
 * recovery.
 */
export type DeriveDispatchedStepExecutorContext = (
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext
) => DispatchedStepExecutorContextResolution;

/** The injected dependencies the live-wrapper dispatch composition needs. */
export type LiveWrapperWorkflowDispatchDeps = {
  /**
   * The `WorkflowStepExecutor` registry the dispatched step runs through. A
   * configured live-wrapper profile resolves a kind to a real live executor; an
   * unconfigured registry resolves to the honest `runtime_unavailable` adapter so
   * dispatch fails honestly into manual recovery rather than fabricating success.
   */
  registry: WorkflowStepExecutorRegistry;
  /** Derives the executor context for a claimed dispatched step. */
  deriveExec: DeriveDispatchedStepExecutorContext;
};

/**
 * Whether a finished base dispatch is one the live-wrapper lane should run the
 * executor for. Pure: the only input is the dispatcher's own stable status string.
 *
 * Only a dispatch that genuinely started (or re-entered) an executor scaffold has a
 * `running` step, a held lease, and a `<run>::<step>::dispatch` invocation for the
 * producer to execute against and reconcile. A fail-closed dispatch already parked
 * the run for manual recovery and released its lease; a not-startable dispatch wrote
 * nothing and released its lease. Returning `false` for those keeps the wrapper from
 * executing over a parked run or a step that left `approved` under it.
 */
export function shouldRunDispatchedExecutor(status: string): boolean {
  return (
    status === WORKFLOW_DISPATCH_RESULT_STATUS.dispatched ||
    status === WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
  );
}

/**
 * Wrap a base {@link WorkflowStepDispatch} (the production
 * `executeWorkflowStepDispatch`) so a successfully-dispatched step's executor is
 * run and reconciled in the same tick. The base dispatch creates the scaffold; the
 * wrapper then runs `executeAndReconcileDispatchedWorkflowStep` against it, gated on
 * {@link shouldRunDispatchedExecutor}. The base dispatch's result is returned
 * unchanged; finalization is a durable side effect layered after it (see the module
 * doc for the single-finalization-owner / idempotent-re-entry discipline).
 */
export function createLiveWrapperWorkflowDispatch(
  baseDispatch: WorkflowStepDispatch,
  deps: LiveWrapperWorkflowDispatchDeps
): WorkflowStepDispatch {
  return (
    claim: ClaimedWorkflowStep,
    context: WorkflowStepDispatchContext
  ): WorkflowStepDispatchResult => {
    const result = baseDispatch(claim, context);
    if (shouldRunDispatchedExecutor(result.status)) {
      const resolved = deps.deriveExec(claim, context);
      if (resolved.ok) {
        executeAndReconcileDispatchedWorkflowStep({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          registry: deps.registry,
          exec: resolved.exec,
          now: context.now
        });
      } else {
        // The context could not be derived (e.g. the run carries no repo path).
        // Park the run for manual recovery through the same terminalize -> RC-2
        // reconcile path an unconfigured executor takes, rather than throwing —
        // a throw here would release the lease over a still-running step.
        recordUnresolvedDispatchedStepContext({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          reason: resolved.reason,
          now: context.now
        });
      }
    }
    return result;
  };
}
