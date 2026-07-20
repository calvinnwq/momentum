import { loadLatestExecutorAttemptForStep } from "../../executors/loop/persist.js";
import {
  recordDispatchedStepManualRecovery,
  recordUnresolvedDispatchedStepContext,
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
} from "./executor-recovery.js";
import {
  executeAndReconcileDispatchedExternalApplyStep,
  reconcileAlreadyTerminalDispatchedExternalApplyStep,
  type DispatchedExternalApplyRunner,
} from "./external-apply-run.js";
import type { ExternalApplyExecutorEvidence } from "./external-apply.js";
import { getWorkflowStep } from "../step/transitions.js";
import { shouldDriveDispatchedExecutor } from "./dispatch-status.js";
import type {
  AsyncWorkflowStepDispatch,
  ClaimedWorkflowStep,
  MaybePromise,
  WorkflowStepDispatchContext,
} from "./scheduler.js";

export type DispatchedExternalApplyContextResolution =
  | {
      ok: true;
      runExternalApply: DispatchedExternalApplyRunner;
      evidence: ExternalApplyExecutorEvidence;
    }
  | { ok: false; reason: string };

export type DeriveDispatchedExternalApplyContext = (
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
) => MaybePromise<DispatchedExternalApplyContextResolution>;

export type ExternalApplyWorkflowDispatchDeps = {
  deriveExternalApply: DeriveDispatchedExternalApplyContext;
};

export function createExternalApplyWorkflowDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
  deps: ExternalApplyWorkflowDispatchDeps,
): AsyncWorkflowStepDispatch {
  return async (claim, context) => {
    const result = await baseDispatch(claim, context);
    if (!shouldDriveDispatchedExecutor(result.status)) return result;

    const attempt = loadLatestExecutorAttemptForStep(
      context.db,
      claim.runId,
      claim.stepId,
    );
    if (attempt?.executorFamily !== "external-apply") return result;

    try {
      const terminalReentry =
        reconcileAlreadyTerminalDispatchedExternalApplyStep({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          now: context.now,
        });
      if (terminalReentry !== null) return result;

      const step = getWorkflowStep(context.db, claim.runId, claim.stepId);
      if (step?.state !== "running") return result;

      const resolved = await deps.deriveExternalApply(claim, context);
      if (resolved.ok) {
        await executeAndReconcileDispatchedExternalApplyStep({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          runExternalApply: resolved.runExternalApply,
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
        error: `external-apply dispatch failed for dispatched step ${claim.runId}/${claim.stepId}: ${detail}`,
        status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executionRejected,
        detail,
        now: context.now,
      });
    }

    return result;
  };
}
