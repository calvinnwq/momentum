import { loadExecutorInvocation } from "../executors/loop-persist.js";
import { deriveDispatchInvocationId } from "./dispatch-execute.js";
import { recordUnresolvedDispatchedStepContext } from "./dispatch-executor-run.js";
import {
  executeAndReconcileDispatchedExternalApplyStep,
  type DispatchedExternalApplyRunner
} from "./dispatch-external-apply-run.js";
import type { ExternalApplyExecutorEvidence } from "./dispatch-external-apply.js";
import { shouldRunDispatchedExecutor } from "./live-wrapper-dispatch.js";
import type {
  AsyncWorkflowStepDispatch,
  ClaimedWorkflowStep,
  MaybePromise,
  WorkflowStepDispatchContext
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
  context: WorkflowStepDispatchContext
) => MaybePromise<DispatchedExternalApplyContextResolution>;

export type ExternalApplyWorkflowDispatchDeps = {
  deriveExternalApply: DeriveDispatchedExternalApplyContext;
};

export function createExternalApplyWorkflowDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
  deps: ExternalApplyWorkflowDispatchDeps
): AsyncWorkflowStepDispatch {
  return async (claim, context) => {
    const result = await baseDispatch(claim, context);
    if (!shouldRunDispatchedExecutor(result.status)) return result;

    const invocation = loadExecutorInvocation(
      context.db,
      deriveDispatchInvocationId(claim.runId, claim.stepId)
    );
    if (invocation?.executorFamily !== "external-apply") return result;

    const resolved = await deps.deriveExternalApply(claim, context);
    if (resolved.ok) {
      await executeAndReconcileDispatchedExternalApplyStep({
        db: context.db,
        runId: claim.runId,
        stepId: claim.stepId,
        runExternalApply: resolved.runExternalApply,
        evidence: resolved.evidence,
        now: context.now
      });
    } else {
      recordUnresolvedDispatchedStepContext({
        db: context.db,
        runId: claim.runId,
        stepId: claim.stepId,
        reason: resolved.reason,
        now: context.now
      });
    }

    return result;
  };
}
