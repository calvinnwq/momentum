/**
 * Async dispatched-step run path for the `subworkflow` executor family
 * (RC-4, NGX-497).
 *
 * This is the daemon-dispatchable *producer* that makes `subworkflow` runnable by
 * the workflow lane. It is the async sibling of
 * `dispatch/external-apply-run.ts`'s
 * {@link executeAndReconcileDispatchedExternalApplyStep}: same "observe the work
 * -> terminalize the evidence -> let RC-2 finalize" shape and the same
 * single-finalization-owner / idempotent-re-entry discipline, but the work it
 * observes is a *child workflow run* rather than an M6 external write.
 *
 * The parent/child ownership boundary is the heart of RC-4: the parent step owns
 * dispatch evidence; the child workflow run owns its own steps, gates, recovery,
 * and terminal state. This producer never reaches into the child's runtime — it
 * starts or attaches to the child run through the injected
 * {@link DispatchedSubworkflowChildRunner} (the daemon lane owns building that
 * runner from the existing workflow-owned run-start / status seams, so there is no
 * parallel ad hoc child runtime here), observes the child's current
 * {@link WorkflowRunState}, and maps it through the landed pure
 * {@link planSubworkflowChildMirror}:
 *
 *   - a non-terminal child run (`pending` / `approved` / `running`) *defers*: the
 *     producer records NO terminal evidence and leaves the parent step running for
 *     a later tick — the structural guard against finalizing the parent over an
 *     unfinished child;
 *   - a clean child terminal (`succeeded` / `failed`) *mirrors* the child's
 *     classification onto the dispatch scaffold as terminal executor evidence the
 *     RC-2 seam finalizes the parent step from (a child failure is a legitimate
 *     mirrored terminal, NOT a process-level executor failure);
 *   - an ambiguous `canceled` / stuck `blocked` / unexpected child state *fails
 *     closed* to a `manual_recovery_required` terminal RC-2 parks for operator
 *     inspection rather than fabricating a clean parent terminal.
 *
 * Boundary discipline (so RC-2 stays the single finalization owner and a child run
 * is never duplicated):
 *
 *   - It acts only when a `<run>::<step>::dispatch` invocation exists. A step
 *     finalized by an M9 live wrapper (or never dispatched through the M10 lane)
 *     writes no such invocation, so this seam refuses it (`notDispatched`) and
 *     never starts a child run.
 *   - It never calls `finishWorkflowStep`, never writes `executor_invocations` /
 *     `executor_rounds` directly (the terminalize seam owns the scaffold rows),
 *     and never releases the dispatch lease (the RC-2 seam does, on terminal).
 *   - Idempotent on re-entry: once the dispatch invocation is terminal, a prior
 *     execution already mirrored the child terminal and recorded its evidence, so
 *     a re-entered tick NEVER re-starts the child run (no duplicate child run, no
 *     second terminalization). It only re-drives the idempotent RC-2
 *     reconciliation to converge the finalization. While the child is still in
 *     flight the invocation stays `running`, so the runner is consulted again on
 *     the next tick — the start-or-attach idempotency that keeps each re-check
 *     attached to the *same* child run lives in the injected runner, exactly as
 *     the M6 write path's idempotency lives in `executeExternalApply`.
 */

import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../../adapters/db.js";
import { isTerminalExecutorInvocationState } from "../../executors/loop/reducer.js";
import { loadExecutorInvocation } from "../../executors/loop/persist.js";
import { deriveDispatchInvocationId } from "./execute.js";
import { terminalizeDispatchedExecutorInvocation } from "./executor-terminalize.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult
} from "./reconcile-execute.js";
import {
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
  type ExecuteAndReconcileDispatchedStepResult
} from "./executor-run.js";
import {
  planSubworkflowChildMirror,
  type SubworkflowChildMirrorOptions,
  type SubworkflowChildMirrorPlan,
  type SubworkflowMirrorEvidence
} from "./subworkflow.js";
import type { WorkflowRunState } from "../run/reducer.js";
import { getWorkflowStep } from "../step/transitions.js";

/**
 * The parent step's observation of its child workflow run for one daemon tick: the
 * child run id it started or attached to, and that child run's current terminal
 * classification. The injected {@link DispatchedSubworkflowChildRunner} produces
 * it; {@link planSubworkflowChildMirror} maps it to a defer / mirror plan.
 */
export type SubworkflowChildObservation = {
  /** The child workflow run id the parent step started or attached to. */
  childRunId: string;
  /** The child run's current {@link WorkflowRunState} as observed this tick. */
  childState: WorkflowRunState;
  childNeedsManualRecovery?: boolean;
  childManualRecoveryReason?: string | null;
};

/**
 * Starts or attaches to the parent step's child workflow run and observes its
 * current state. Injected so the daemon lane owns building the child run (child
 * definition / run config, recursion-safety check, existing workflow-owned
 * run-start / status seams) and this producer stays agnostic to *how* the child is
 * driven — it never reaches into the child's runtime itself. The runner is
 * expected to be start-or-attach idempotent (re-checking the same child run rather
 * than starting a second one on each tick); a rejection propagates so a re-entered
 * tick retries the still-non-terminal scaffold.
 */
export type DispatchedSubworkflowChildRunner =
  () => Promise<SubworkflowChildObservation>;

/**
 * The durable evidence paths the daemon lane derives from the parent run's
 * data-dir layout (a log of the attach/mirror attempt and a JSON snapshot of the
 * observed child run), forwarded onto the mirrored executor result so the
 * terminalize bridge records them as operator-visible evidence. The child run id
 * is discovered by the runner, so it is not part of these paths.
 */
export type SubworkflowDispatchEvidencePaths = {
  executorLogPath: string;
  resultJsonPath: string;
};

export type ExecuteAndReconcileDispatchedSubworkflowStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Starts or attaches to the child run (see {@link DispatchedSubworkflowChildRunner}). */
  runSubworkflowChild: DispatchedSubworkflowChildRunner;
  /** Durable evidence paths for the attach/mirror attempt (see {@link SubworkflowDispatchEvidencePaths}). */
  evidence: SubworkflowDispatchEvidencePaths;
  now: number;
};

/**
 * Observe a dispatched `subworkflow` step's child run and finalize the parent step
 * through RC-2 when (and only when) the child reaches a terminal classification.
 * The async analogue of {@link executeAndReconcileDispatchedExternalApplyStep}:
 * "observe the child -> map it -> terminalize the mirrored evidence -> reconcile",
 * with a defer branch for a child still in flight; see the module doc for the
 * boundary discipline (single finalization owner, M9-lane refusal, idempotent
 * re-entry that never re-starts the child run, no premature parent finalize).
 */
export async function executeAndReconcileDispatchedSubworkflowStep(
  input: ExecuteAndReconcileDispatchedSubworkflowStepInput
): Promise<ExecuteAndReconcileDispatchedStepResult> {
  const { db, runId, stepId, runSubworkflowChild, evidence, now } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: an M9 direct-finalize / never-dispatched
    // step. The seam owns only dispatched scaffolds, so it refuses and never
    // starts a child run — the structural guard against a double finalize.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: invocationId
    };
  }
  if (invocation.executorFamily !== "subworkflow") {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: `${invocationId}: ${invocation.executorFamily}`
    };
  }

  if (isTerminalExecutorInvocationState(invocation.state)) {
    // Idempotent re-entry: a prior execution already mirrored the child terminal
    // and recorded its evidence. NEVER re-start the child run (no duplicate child
    // run / duplicate evidence); just re-drive the idempotent RC-2 reconciliation
    // so a crashed prior finalize still converges the step / lease / run-state.
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
    // unexpected lane state the seam refuses rather than writing over.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotRunning,
      detail: step.state
    };
  }

  // Start or attach to the child run and observe its current state. This is the
  // only step that reaches outside the parent's durable state (through the
  // injected runner), so it runs OUTSIDE any database transaction. Map the
  // observed child state into a defer / mirror plan — reusing the landed pure
  // mapping, never a second classification path.
  const observation = await runSubworkflowChild();
  const mirrorEvidence: SubworkflowMirrorEvidence = {
    childRunId: observation.childRunId,
    executorLogPath: evidence.executorLogPath,
    resultJsonPath: evidence.resultJsonPath
  };
  const mirrorOptions: SubworkflowChildMirrorOptions = {};
  if (observation.childNeedsManualRecovery !== undefined) {
    mirrorOptions.childNeedsManualRecovery = observation.childNeedsManualRecovery;
  }
  if (observation.childManualRecoveryReason !== undefined) {
    mirrorOptions.childManualRecoveryReason =
      observation.childManualRecoveryReason;
  }
  const plan = planSubworkflowChildMirror(
    observation.childState,
    mirrorEvidence,
    mirrorOptions
  );

  // Snapshot the observed child run for the operator before acting on it, so a
  // long-running deferred child and a mirrored terminal both leave a durable
  // trail at the same evidence paths.
  writeSubworkflowEvidence(mirrorEvidence, observation, plan);

  if (plan.outcome === "defer") {
    // The child is still in flight: record NO terminal evidence and leave the
    // parent step running for a later tick to re-check. The dispatch invocation
    // stays `running` and the lease stays held, so no parent finalization happens
    // over an unfinished child.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred,
      detail: plan.reason
    };
  }

  // Mirror: record the child terminal as terminal evidence, then let RC-2 finalize
  // the parent step from it. terminalize and reconcile are each idempotent and own
  // their own transactions.
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: plan.result,
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
      executorResult: plan.result,
      terminalize,
      detail: reconciled.detail
    };
  }

  return {
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    executorResult: plan.result,
    terminalize,
    reconcile: reconciled.reconcile
  };
}

/**
 * Drive the idempotent RC-2 reconciliation, trapping a thrown reconcile so a
 * recorded-but-unreconciled terminal can be retried on a later tick without losing
 * the durable evidence or releasing the held lease. Mirrors the same helper the
 * external-apply / synchronous run paths use.
 */
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

function writeSubworkflowEvidence(
  evidence: SubworkflowMirrorEvidence,
  observation: SubworkflowChildObservation,
  plan: SubworkflowChildMirrorPlan
): void {
  fs.mkdirSync(path.dirname(evidence.executorLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(evidence.resultJsonPath), { recursive: true });
  fs.writeFileSync(
    evidence.executorLogPath,
    subworkflowLog(observation, plan),
    "utf8"
  );
  fs.writeFileSync(
    evidence.resultJsonPath,
    `${JSON.stringify(observation, null, 2)}\n`,
    "utf8"
  );
}

function subworkflowLog(
  observation: SubworkflowChildObservation,
  plan: SubworkflowChildMirrorPlan
): string {
  const outcome =
    plan.outcome === "defer"
      ? "subworkflow child deferred (still in flight)"
      : plan.result.ok
        ? "subworkflow child mirrored (clean terminal)"
        : "subworkflow child mirrored (manual recovery)";
  return [
    outcome,
    `childRun: ${observation.childRunId}`,
    `childState: ${observation.childState}`,
    observation.childNeedsManualRecovery === undefined
      ? undefined
      : `childNeedsManualRecovery: ${observation.childNeedsManualRecovery}`,
    observation.childManualRecoveryReason === undefined ||
    observation.childManualRecoveryReason === null
      ? undefined
      : `childManualRecoveryReason: ${observation.childManualRecoveryReason}`,
    plan.outcome === "defer"
      ? `reason: ${plan.reason}`
      : `result: ${plan.result.ok ? plan.result.result.state : plan.result.code}`,
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
