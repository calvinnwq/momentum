/**
 * Async dispatched-step run path for the `external-apply` executor family
 *.
 *
 * This is the daemon-dispatchable *producer* that makes `external-apply`
 * runnable by the workflow lane. It is the async sibling of
 * It shares the neutral "run the work -> settle evidence -> reconcile" shape and
 * the same single-finalization-owner / idempotent-re-entry discipline, but the
 * work it runs is the existing external-apply write path
 * (`executeExternalApply`, `src/core/intent/apply-execute.ts`) rather than a
 * synchronous live-wrapper executor.
 *
 * Two facts force a dedicated module rather than reuse of the sync path:
 *
 *   1. `executeExternalApply` is `async` (it performs a real external Linear
 *      write and owns its own claim / audit / finalize transactions), while the
 *      `WorkflowStepExecutorRegistry.execute` boundary the sync path drives is
 *      synchronous. So this producer is `async` and awaits the write outside any
 *      database transaction.
 *   2. The external-apply result is not a {@link WorkflowStepExecutorDispatchResult}; the
 *      landed pure {@link mapExternalApplyResultToExecutorResult} translates it
 *      into the executor-evidence vocabulary the terminalize bridge consumes,
 *      reusing the external-apply write path instead of inventing a second one.
 *
 * The external-apply write path is taken by injection ({@link DispatchedExternalApplyRunner})
 * exactly as the sync path takes the executor registry by injection: the daemon
 * lane owns building the apply input (intent id, operator reason, repo path,
 * env, deps) and wiring `executeExternalApply` with its policy / adapter / audit
 * dependencies; this module stays agnostic to *how* the write is configured and
 * never reaches a real `api.linear.app` endpoint itself. Tests inject a canned
 * runner, so no real network call is possible here.
 *
 * Boundary discipline (so the reconciliation seam stays the single finalization owner and a high-risk
 * external write is never duplicated):
 *
 *   - It acts only when a `<run>::<step>::dispatch` invocation exists. A step
 *     finalized by a live wrapper (or never dispatched through the executor-loop lane)
 *     writes no such invocation, so this seam refuses it (`notDispatched`) and
 *     never runs the external write.
 *   - It never calls `finishWorkflowStep`, never writes `executor_invocations` /
 *     `executor_rounds` directly (the terminalize seam owns the scaffold rows),
 *     and never releases the dispatch lease (the reconciliation seam does, on terminal).
 *   - Idempotent on re-entry: once the dispatch invocation is terminal, a prior
 *     execution already issued the external write and recorded its terminal
 *     evidence, so a re-entered tick NEVER re-runs the write (no second Linear
 *     mutation, no duplicate terminalization). It only re-drives the idempotent
 *     reconciliation to converge the finalization. (The narrow crash window
 *     between a successful write and its terminalization is covered by external-apply's own
 *     idempotency: a re-applied terminal intent fails closed to manual recovery
 *     rather than writing twice.)
 *   - Fail-closed by default: every external-apply refusal (policy denied, auth absent,
 *     unsupported adapter, in-flight, blocked, audit-incomplete, …) maps to a
 *     manual-recovery terminal the reconciliation seam parks for operator inspection,
 *     never a fabricated clean terminal.
 */

import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../../adapters/db.js";
import type { ExecuteExternalApplyResult } from "../../intent/apply-execute.js";
import { isTerminalExecutorInvocationState } from "../../executors/loop/reducer.js";
import { loadExecutorInvocation } from "../../executors/loop/persist.js";
import { deriveDispatchInvocationId } from "./execute.js";
import { terminalizeDispatchedExecutorInvocation } from "./executor-evidence.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult,
} from "./reconcile-execute.js";
import {
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
  type ExecuteAndReconcileDispatchedStepResult,
} from "./executor-recovery.js";
import {
  mapExternalApplyResultToExecutorResult,
  type ExternalApplyExecutorEvidence,
} from "./external-apply.js";
import { getWorkflowStep } from "../step/transitions.js";

/**
 * Runs the external-apply write path for a dispatched step and resolves to its
 * structured result. Injected so the daemon lane owns building the apply input
 * (intent id, operator reason, repo path, env, deps) and wiring
 * `executeExternalApply`; the producer stays agnostic to how the write is
 * configured and never reaches a real Linear endpoint itself. The runner is
 * expected to be total (resolve to a result for every predictable branch, as
 * `executeExternalApply` is) — a rejection propagates so a re-entered tick
 * retries the still-non-terminal scaffold.
 */
export type DispatchedExternalApplyRunner =
  () => Promise<ExecuteExternalApplyResult>;

export type ExecuteAndReconcileDispatchedExternalApplyStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Runs the existing external-apply write path (see {@link DispatchedExternalApplyRunner}). */
  runExternalApply: DispatchedExternalApplyRunner;
  /**
   * Durable evidence paths the daemon lane derives from the run's data-dir
   * layout (a log of the apply attempt and a JSON snapshot of the external-apply result),
   * forwarded onto the mapped executor result so the terminalize bridge records
   * them as operator-visible evidence.
   */
  evidence: ExternalApplyExecutorEvidence;
  now: number;
};

export function reconcileAlreadyTerminalDispatchedExternalApplyStep(input: {
  db: MomentumDb;
  runId: string;
  stepId: string;
  now: number;
}): ExecuteAndReconcileDispatchedStepResult | null {
  const invocation = loadExecutorInvocation(
    input.db,
    deriveDispatchInvocationId(input.runId, input.stepId),
  );
  if (invocation?.executorFamily !== "external-apply") return null;
  if (!isTerminalExecutorInvocationState(invocation.state)) return null;
  return reconcileTerminalDispatchedExternalApplyInvocation(
    input,
    invocation.state,
  );
}

/**
 * Run a dispatched `external-apply` step's external-apply write path and finalize it through
 * the reconciliation seam. The async analogue of {@link executeAndReconcileDispatchedWorkflowStep}:
 * "run the external write -> map it to executor evidence -> terminalize ->
 * reconcile"; see the module doc for the boundary discipline (single
 * finalization owner, live-wrapper-lane refusal, idempotent re-entry that never re-runs the
 * external write).
 */
export async function executeAndReconcileDispatchedExternalApplyStep(
  input: ExecuteAndReconcileDispatchedExternalApplyStepInput,
): Promise<ExecuteAndReconcileDispatchedStepResult> {
  const { db, runId, stepId, runExternalApply, evidence, now } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: a live-wrapper direct-finalize / never-dispatched
    // step. The seam owns only dispatched scaffolds, so it refuses and never runs
    // the external write — the structural guard against a double finalize.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: invocationId,
    };
  }
  if (invocation.executorFamily !== "external-apply") {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: `${invocationId}: ${invocation.executorFamily}`,
    };
  }

  if (isTerminalExecutorInvocationState(invocation.state)) {
    return reconcileTerminalDispatchedExternalApplyInvocation(
      { db, runId, stepId, now },
      invocation.state,
    );
  }

  const step = getWorkflowStep(db, runId, stepId);
  if (step === undefined) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotFound,
      detail: stepId,
    };
  }
  if (step.state !== "running") {
    // The scaffold invocation is still `running` but the owning step is not, an
    // unexpected lane state the seam refuses rather than writing over.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotRunning,
      detail: step.state,
    };
  }

  // Run the external-apply write path. This is the only step that performs
  // external work (a real Linear write through the injected runner), so it runs
  // OUTSIDE any database transaction. Map its result into the executor-evidence
  // vocabulary the terminalize bridge consumes — reusing the external-apply path, never a
  // second write path.
  const externalApplyResult = await runExternalApply();
  writeExternalApplyEvidence(evidence, externalApplyResult);
  const executorResult = mapExternalApplyResultToExecutorResult(
    externalApplyResult,
    evidence,
  );

  // Record the result as terminal evidence, then let the reconciliation seam finalize the step from
  // it. terminalize and reconcile are each idempotent and own their own
  // transactions.
  const terminalize = terminalizeDispatchedExecutorInvocation({
    db,
    runId,
    stepId,
    result: executorResult,
    now,
  });
  const reconciled = tryReconcileDispatchedWorkflowStep({
    db,
    runId,
    stepId,
    now,
  });
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: reconciled.detail,
    };
  }

  return {
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    executorResult,
    terminalize,
    reconcile: reconciled.reconcile,
  };
}

function reconcileTerminalDispatchedExternalApplyInvocation(
  input: { db: MomentumDb; runId: string; stepId: string; now: number },
  state: string,
): ExecuteAndReconcileDispatchedStepResult {
  const reconciled = tryReconcileDispatchedWorkflowStep(input);
  if (!reconciled.ok) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      detail: reconciled.detail,
    };
  }
  return {
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
    reconcile: reconciled.reconcile,
    detail: state,
  };
}

/**
 * Drive the idempotent reconciliation, trapping a thrown reconcile so a
 * recorded-but-unreconciled terminal can be retried on a later tick without
 * losing the durable evidence or releasing the held lease. Mirrors the same
 * helper the other dispatched producers use.
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
      reconcile: reconcileDispatchedWorkflowStep(input),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeExternalApplyEvidence(
  evidence: ExternalApplyExecutorEvidence,
  result: ExecuteExternalApplyResult,
): void {
  fs.mkdirSync(path.dirname(evidence.executorLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(evidence.resultJsonPath), { recursive: true });
  fs.writeFileSync(evidence.executorLogPath, externalApplyLog(result), "utf8");
  fs.writeFileSync(
    evidence.resultJsonPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

function externalApplyLog(result: ExecuteExternalApplyResult): string {
  if (result.ok) {
    const target =
      result.external.issueKey ??
      result.external.issueId ??
      result.context.target.externalKey ??
      result.context.target.externalId ??
      "unknown";
    return [
      "external-apply applied",
      `intent: ${result.context.intentId}`,
      `adapter: ${result.context.adapterKind}`,
      `target: ${target}`,
      `result: ${result.resultCode}`,
      `alreadyApplied: ${String(result.external.alreadyApplied)}`,
      `idempotencyMarker: ${result.external.idempotencyMarker}`,
      "",
    ].join("\n");
  }
  return [
    "external-apply refused",
    `code: ${result.code}`,
    `message: ${result.message}`,
    `intent: ${result.context.intentId}`,
    `adapter: ${result.context.adapterKind}`,
    "",
  ].join("\n");
}
