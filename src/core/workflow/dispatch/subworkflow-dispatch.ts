/**
 * Daemon-lane entry point for the `subworkflow` executor.
 *
 * The async sibling of `dispatch/external-apply-dispatch.ts`'s
 * {@link createExternalApplyWorkflowDispatch}: it wraps the production base
 * dispatch so a successfully-dispatched `subworkflow` step's child run is observed
 * and reconciled in the same tick, through the landed producer
 * {@link executeAndReconcileDispatchedSubworkflowStep}. The base dispatch creates
 * the dispatch attempt scaffold; this wrapper then runs the producer
 * against it, gated on the shared dispatch-status predicate and the dispatched
 * attempt's executor identity.
 *
 * Boundary discipline (mirrors the external-apply lane so the reconciliation seam stays the single
 * finalization owner):
 *
 *   - The producer runs only after a base dispatch that genuinely started (or
 *     re-entered) a scaffold; a fail-closed / not-startable base result already
 *     parked the run and released its lease, so the wrapper echoes it untouched.
 *   - It runs the producer ONLY for a `subworkflow` attempt. The
 *     registered SDK lane and the external-apply lane own the other executors;
 *     routing a non-`subworkflow` attempt here would
 *     run the wrong producer against a foreign scaffold.
 *   - The child-run start/attach is derived by injection
 *     ({@link DeriveDispatchedSubworkflowContext}): the daemon caller owns building
 *     the start-or-attach runner from the existing workflow-owned run-start /
 *     status seams (and the child-definition / recursion-safety resolution), so
 *     this wrapper stays agnostic to *how* the child is driven.
 *   - A refused derivation (`ok: false`) is routed to manual recovery
 *     (`recordUnresolvedDispatchedStepContext`) rather than thrown — a throw inside
 *     the dispatch closure, after the base dispatch advanced the step to `running`,
 *     would make the scheduler release the dispatch lease and strand a `running`
 *     step with no terminal evidence and no recovery gate. A thrown derivation is
 *     trapped into the same manual-recovery park for the same reason.
 *   - It returns the base dispatch's result verbatim; finalization is a durable
 *     side effect layered after the dispatch (daemon telemetry still reports the
 *     dispatch outcome), exactly as the external-apply wrapper layers its run.
 */

import { loadLatestExecutorAttemptForStep } from "../../executors/loop/persist.js";
import {
  recordDispatchedStepManualRecovery,
  recordUnresolvedDispatchedStepContext,
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
} from "./executor-recovery.js";
import {
  executeAndReconcileDispatchedSubworkflowStep,
  type DispatchedSubworkflowChildRunner,
  type SubworkflowDispatchEvidencePaths,
} from "./subworkflow-run.js";
import { shouldDriveDispatchedExecutor } from "./dispatch-status.js";
import type {
  AsyncWorkflowStepDispatch,
  ClaimedWorkflowStep,
  MaybePromise,
  WorkflowStepDispatchContext,
} from "./scheduler.js";

/**
 * The outcome of deriving a dispatched `subworkflow` step's child-run context: the
 * start-or-attach runner and the durable evidence paths, or a typed refusal
 * (`ok: false`) the wrapper routes to manual recovery. Total so the deriver never
 * has to throw inside the dispatch closure (which would strand the lease over a
 * `running` step). The `reason` is preserved as the parked run's recovery
 * evidence — e.g. a missing child definition / run config, an unsafe recursion, or
 * an unsupported attachment.
 */
export type DispatchedSubworkflowContextResolution =
  | {
      ok: true;
      runSubworkflowChild: DispatchedSubworkflowChildRunner;
      evidence: SubworkflowDispatchEvidencePaths;
    }
  | { ok: false; reason: string };

/**
 * Derive the child-run start/attach runner and evidence paths a claimed dispatched
 * `subworkflow` step needs. Injected so the daemon-lane caller owns building the
 * child runner from the existing workflow-owned run-start / status seams; the
 * wrapper forwards a resolved context verbatim into the producer and routes a
 * refused derivation through manual recovery.
 */
export type DeriveDispatchedSubworkflowContext = (
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
) => MaybePromise<DispatchedSubworkflowContextResolution>;

export type SubworkflowWorkflowDispatchDeps = {
  deriveSubworkflow: DeriveDispatchedSubworkflowContext;
};

/**
 * Wrap a base {@link AsyncWorkflowStepDispatch} so a successfully-dispatched
 * `subworkflow` step's child run is observed and reconciled in the same tick. See
 * the module doc for the boundary discipline (single finalization owner,
 * executor-gated producer, fail-closed-on-refusal, verbatim base result).
 */
export function createSubworkflowWorkflowDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
  deps: SubworkflowWorkflowDispatchDeps,
): AsyncWorkflowStepDispatch {
  return async (claim, context) => {
    const result = await baseDispatch(claim, context);
    if (!shouldDriveDispatchedExecutor(result.status)) return result;

    const attempt = loadLatestExecutorAttemptForStep(
      context.db,
      claim.runId,
      claim.stepId,
    );
    if (attempt?.executor !== "subworkflow") return result;

    try {
      const resolved = await deps.deriveSubworkflow(claim, context);
      if (resolved.ok) {
        await executeAndReconcileDispatchedSubworkflowStep({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          runSubworkflowChild: resolved.runSubworkflowChild,
          evidence: resolved.evidence,
          now: context.now,
        });
      } else {
        recordUnresolvedDispatchedStepContext({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          reason: resolved.reason,
          now: context.now,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      recordDispatchedStepManualRecovery({
        db: context.db,
        runId: claim.runId,
        stepId: claim.stepId,
        error: `subworkflow dispatch failed for dispatched step ${claim.runId}/${claim.stepId}: ${detail}`,
        status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executionRejected,
        detail,
        now: context.now,
      });
    }

    return result;
  };
}
