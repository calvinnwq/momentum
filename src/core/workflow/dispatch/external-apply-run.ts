/**
 * Async dispatched-step run path for the `external-apply` executor family
 * (RC-3, NGX-496).
 *
 * This is the daemon-dispatchable *producer* that makes `external-apply`
 * runnable by the workflow lane. It is the async sibling of
 * `dispatch-executor-run.ts`'s {@link executeAndReconcileDispatchedWorkflowStep}:
 * same "run the work -> terminalize the evidence -> let RC-2 finalize" shape and
 * the same single-finalization-owner / idempotent-re-entry discipline, but the
 * work it runs is the existing M6 external-apply write path
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
 *   2. The M6 result is not a {@link WorkflowStepExecutorDispatchResult}; the
 *      landed pure {@link mapExternalApplyResultToExecutorResult} translates it
 *      into the executor-evidence vocabulary the terminalize bridge consumes,
 *      reusing the M6 write path instead of inventing a second one.
 *
 * The M6 write path is taken by injection ({@link DispatchedExternalApplyRunner})
 * exactly as the sync path takes the executor registry by injection: the daemon
 * lane owns building the apply input (intent id, operator reason, repo path,
 * env, deps) and wiring `executeExternalApply` with its policy / adapter / audit
 * dependencies; this module stays agnostic to *how* the write is configured and
 * never reaches a real `api.linear.app` endpoint itself. Tests inject a canned
 * runner, so no real network call is possible here.
 *
 * Boundary discipline (so RC-2 stays the single finalization owner and a high-risk
 * external write is never duplicated):
 *
 *   - It acts only when a `<run>::<step>::dispatch` invocation exists. A step
 *     finalized by an M9 live wrapper (or never dispatched through the M10 lane)
 *     writes no such invocation, so this seam refuses it (`notDispatched`) and
 *     never runs the external write.
 *   - It never calls `finishWorkflowStep`, never writes `executor_invocations` /
 *     `executor_rounds` directly (the terminalize seam owns the scaffold rows),
 *     and never releases the dispatch lease (the RC-2 seam does, on terminal).
 *   - Idempotent on re-entry: once the dispatch invocation is terminal, a prior
 *     execution already issued the external write and recorded its terminal
 *     evidence, so a re-entered tick NEVER re-runs the write (no second Linear
 *     mutation, no duplicate terminalization). It only re-drives the idempotent
 *     RC-2 reconciliation to converge the finalization. (The narrow crash window
 *     between a successful write and its terminalization is covered by M6's own
 *     idempotency: a re-applied terminal intent fails closed to manual recovery
 *     rather than writing twice.)
 *   - Fail-closed by default: every M6 refusal (policy denied, auth absent,
 *     unsupported adapter, in-flight, blocked, audit-incomplete, …) maps to a
 *     manual-recovery terminal the RC-2 seam parks for operator inspection,
 *     never a fabricated clean terminal.
 */

import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../../adapters/db.js";
import type { ExecuteExternalApplyResult } from "../../intent/apply-execute.js";
import { isTerminalExecutorInvocationState } from "../../executors/loop/reducer.js";
import { loadExecutorInvocation } from "../../executors/loop/persist.js";
import { deriveDispatchInvocationId } from "./execute.js";
import {
  terminalizeDispatchedExecutorInvocation
} from "./executor-terminalize.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult
} from "./reconcile-execute.js";
import {
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
  type ExecuteAndReconcileDispatchedStepResult
} from "./executor-run.js";
import {
  mapExternalApplyResultToExecutorResult,
  type ExternalApplyExecutorEvidence
} from "./external-apply.js";
import { getWorkflowStep } from "../step/transitions.js";

/**
 * Runs the M6 external-apply write path for a dispatched step and resolves to its
 * structured result. Injected so the daemon lane owns building the apply input
 * (intent id, operator reason, repo path, env, deps) and wiring
 * `executeExternalApply`; the producer stays agnostic to how the write is
 * configured and never reaches a real Linear endpoint itself. The runner is
 * expected to be total (resolve to a result for every predictable branch, as
 * `executeExternalApply` is) — a rejection propagates so a re-entered tick
 * retries the still-non-terminal scaffold.
 */
export type DispatchedExternalApplyRunner = () => Promise<ExecuteExternalApplyResult>;

export type ExecuteAndReconcileDispatchedExternalApplyStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Runs the existing M6 external-apply write path (see {@link DispatchedExternalApplyRunner}). */
  runExternalApply: DispatchedExternalApplyRunner;
  /**
   * Durable evidence paths the daemon lane derives from the run's data-dir
   * layout (a log of the apply attempt and a JSON snapshot of the M6 result),
   * forwarded onto the mapped executor result so the terminalize bridge records
   * them as operator-visible evidence.
   */
  evidence: ExternalApplyExecutorEvidence;
  now: number;
};

/**
 * Run a dispatched `external-apply` step's M6 write path and finalize it through
 * RC-2. The async analogue of {@link executeAndReconcileDispatchedWorkflowStep}:
 * "run the external write -> map it to executor evidence -> terminalize ->
 * reconcile"; see the module doc for the boundary discipline (single
 * finalization owner, M9-lane refusal, idempotent re-entry that never re-runs the
 * external write).
 */
export async function executeAndReconcileDispatchedExternalApplyStep(
  input: ExecuteAndReconcileDispatchedExternalApplyStepInput
): Promise<ExecuteAndReconcileDispatchedStepResult> {
  const { db, runId, stepId, runExternalApply, evidence, now } = input;
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation === undefined) {
    // No phase-1 dispatch invocation: an M9 direct-finalize / never-dispatched
    // step. The seam owns only dispatched scaffolds, so it refuses and never runs
    // the external write — the structural guard against a double finalize.
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: invocationId
    };
  }
  if (invocation.executorFamily !== "external-apply") {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched,
      detail: `${invocationId}: ${invocation.executorFamily}`
    };
  }

  if (isTerminalExecutorInvocationState(invocation.state)) {
    // Idempotent re-entry: a prior execution already issued the external write and
    // recorded its terminal evidence. NEVER re-run the write (no second Linear
    // mutation / duplicate evidence); just re-drive the idempotent RC-2
    // reconciliation so a crashed prior finalize still converges the step / lease.
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

  // Run the M6 external-apply write path. This is the only step that performs
  // external work (a real Linear write through the injected runner), so it runs
  // OUTSIDE any database transaction. Map its result into the executor-evidence
  // vocabulary the terminalize bridge consumes — reusing the M6 path, never a
  // second write path.
  const externalApplyResult = await runExternalApply();
  writeExternalApplyEvidence(evidence, externalApplyResult);
  const executorResult = mapExternalApplyResultToExecutorResult(
    externalApplyResult,
    evidence
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

/**
 * Drive the idempotent RC-2 reconciliation, trapping a thrown reconcile so a
 * recorded-but-unreconciled terminal can be retried on a later tick without
 * losing the durable evidence or releasing the held lease. Mirrors the same
 * helper the synchronous run path uses (`dispatch-executor-run.ts`).
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

function writeExternalApplyEvidence(
  evidence: ExternalApplyExecutorEvidence,
  result: ExecuteExternalApplyResult
): void {
  fs.mkdirSync(path.dirname(evidence.executorLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(evidence.resultJsonPath), { recursive: true });
  fs.writeFileSync(evidence.executorLogPath, externalApplyLog(result), "utf8");
  fs.writeFileSync(
    evidence.resultJsonPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
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
      ""
    ].join("\n");
  }
  return [
    "external-apply refused",
    `code: ${result.code}`,
    `message: ${result.message}`,
    `intent: ${result.context.intentId}`,
    `adapter: ${result.context.adapterKind}`,
    ""
  ].join("\n");
}
