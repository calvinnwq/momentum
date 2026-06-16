/**
 * Live workflow-step orchestrator introduced by NGX-333 (M9-02).
 *
 * Iterations 1-4 of M9-02 added the caller-side building blocks: the live
 * execution core (`live-step-wrapper.ts`), the M7 executor bridge
 * (`live-step-executor.ts`), the durable `workflow_leases` lifecycle primitives
 * (`workflow-leases.ts`), and the durable `workflow_steps` transition primitives
 * (`workflow-step-transitions.ts`). This module is the seam that composes them
 * into the single managed-step lifecycle the M9 live-execution contract's "Step
 * Execution" section requires, around any `WorkflowStepExecutor` (the M9 live
 * wrapper in production, a deterministic fake in tests):
 *
 *   acquire the managed-step lease  (before any durable step mutation)
 *   -> start the step               (approved -> running, the start event)
 *   -> executor.execute(input)      (run the live wrapper / executor)
 *   -> finish the step              (-> succeeded / failed, terminal state
 *                                    persisted BEFORE the lease is released,
 *                                    unless the caller explicitly defers it)
 *   -> release the managed-step lease (or return the still-held lease to the
 *                                      caller for finalization/recovery)
 *
 * The lease is released only after the terminal write and final ownership
 * checks succeed, unless a run-level caller opts into a deferral flag so it can
 * perform verification / commit / reset finalization before marking the step
 * terminal. Start refusals and trapped executor throws are finalized and
 * released when possible; terminal-persistence, final-heartbeat, repo-lock,
 * release ownership failures, and explicit deferrals intentionally leave the
 * lease outstanding so monitor/recovery can see the ambiguous in-flight step.
 * Managed-step leases default to the fail-closed `manual-recovery-required`
 * stale policy, unlike the generic workflow-lease default, and repo-lock
 * refreshes are monotonic so a final workflow-lease heartbeat cannot move a
 * separately-heartbeated repo lock backward.
 *
 * The orchestrator stays single-step focused. Run-level concerns are composed by
 * the caller from the returned outcome: run-state re-derivation
 * (`deriveWorkflowRunState` over all of the run's steps), optional terminal
 * deferral via `deferredTerminalState` / `deferredLease`, and run-scoped
 * recovery reconciliation through the live finalize or dispatch recovery seams
 * that write `recovery.md` plus the `needs_manual_recovery` flag. This mirrors
 * how the M7 substrate keeps executors free of durable mutation: the executor
 * performs the work; the orchestrator owns the durable lease + step lifecycle
 * around it and surfaces terminal / live recovery metadata for its caller.
 *
 * A managed live step that started running is finalized from the executor's
 * reported terminal state: successful runner output becomes `succeeded`,
 * runner-reported failure and dispatch errors become `failed`, and an executor
 * `skipped` result is normalized to the allowed `running -> succeeded`
 * transition. Distinct failure causes are never collapsed into generic text —
 * the dispatch/result `errorCode` / `errorMessage` are persisted and the precise
 * live recovery code is surfaced for the recovery layer.
 */

import type { MomentumDb } from "./adapters/db.js";
import { Worker } from "node:worker_threads";
import {
  acquireWorkflowLeaseInTransaction,
  getWorkflowLease,
  heartbeatWorkflowLease,
  releaseWorkflowLease
} from "./core/workflow/leases.js";
import {
  finishWorkflowStep,
  getWorkflowStep,
  startWorkflowStep,
  type FinishWorkflowStepInput,
  type WorkflowStepTerminalState,
  type WorkflowStepTransitionOutcome
} from "./core/workflow/step-transitions.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorDispatchResult,
  WorkflowStepExecutorInput,
  WorkflowStepExecutorTerminalState
} from "./core/workflow/step-executor.js";
import type {
  WorkflowLeaseKind,
  WorkflowLeaseRecord,
  WorkflowLeaseStalePolicy,
  WorkflowStepState,
  WorkflowStepKind,
  WorkflowRunState
} from "./core/workflow/run-reducer.js";
import {
  isTerminalRunState,
  isWorkflowApprovalBoundary,
  workflowStepKindsForApprovalBoundary
} from "./core/workflow/run-reducer.js";

/**
 * The default managed-step lease kind for a live workflow step. The `monitor`
 * and `dispatch` lease kinds are owned by the cron / dispatcher layers; a live
 * managed step takes the `managed-step` lease around its own execution.
 */
export const LIVE_STEP_DEFAULT_LEASE_KIND: WorkflowLeaseKind = "managed-step";
export type LiveWorkflowStepLeaseKind = Exclude<WorkflowLeaseKind, "monitor">;

const LIVE_WORKFLOW_RUN_EXECUTABLE_STATES: ReadonlySet<WorkflowRunState> =
  new Set(["approved", "running"]);

export type RunLiveWorkflowStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Lease holder identity (e.g. the worker / process id). */
  holder: string;
  /** Absolute ms timestamp at which the managed-step lease expires. */
  leaseExpiresAt: number;
  /** The executor to run (an M9 live wrapper, or a fake in tests). */
  executor: WorkflowStepExecutor;
  /** The executor input forwarded to `executor.execute` after identity validation. */
  executorInput: WorkflowStepExecutorInput;
  /** Lease kind to take; defaults to {@link LIVE_STEP_DEFAULT_LEASE_KIND}. */
  leaseKind?: LiveWorkflowStepLeaseKind;
  /**
   * Stale policy for the acquired lease; defaults to
   * `manual-recovery-required` so a live step whose process is lost strands the
   * lease into operator recovery rather than auto-releasing silently.
   */
  stalePolicy?: WorkflowLeaseStalePolicy;
  /** Deterministic clock for stamping; defaults to `Date.now()`. */
  now?: number;
  /**
   * When true, a successful executor result is returned as
   * `deferredTerminalState: "succeeded"` with the managed-step lease still
   * held. Run-level callers use this to verify and commit before making success
   * durable.
   */
  deferSuccessfulTerminalState?: boolean;
  /**
   * When true, any normalized executor result (`succeeded`, `failed`, or
   * normalized `skipped`) is returned as a deferred terminal state instead of
   * being persisted. Used by callers that must reconcile terminal state with a
   * later finalize / recovery transaction.
   */
  deferNormalizedTerminalState?: boolean;
  /**
   * When true, dispatch errors are returned with `deferredTerminalState:
   * "failed"` and the lease still held so run-level recovery can persist the
   * manual-recovery flag / artifact before terminalizing or releasing.
   */
  deferDispatchErrorTerminalState?: boolean;
};

export type RunLiveWorkflowStepOutcome = {
  /** True only when the step executed and finalized `succeeded`. */
  ok: boolean;
  /** The furthest stage reached: input refusal, lease refusal, start refusal, or execution. */
  stage: "input" | "lease" | "start" | "execute";
  lease: {
    acquired: boolean;
    released: boolean;
    /** The blocking outstanding lease when acquisition refused. */
    existing?: WorkflowLeaseRecord;
  };
  /** The start transition outcome (present once acquisition succeeded). */
  start?: WorkflowStepTransitionOutcome;
  /** The executor dispatch result (present once the step started). */
  dispatch?: WorkflowStepExecutorDispatchResult;
  /** The finish transition outcome (present once the step started). */
  finish?: WorkflowStepTransitionOutcome;
  /** The terminal state the step was finalized into, or would use if deferred. */
  terminalState?: WorkflowStepTerminalState;
  /**
   * Terminal state intentionally not written yet because a deferral flag asked
   * the caller to complete finalization / recovery reconciliation first.
   */
  deferredTerminalState?: WorkflowStepTerminalState;
  /**
   * The still-held managed-step lease returned with a deferred terminal state;
   * callers remain responsible for the later terminal write and lease release.
   */
  deferredLease?: WorkflowLeaseRecord;
  inputError?: string;
  /**
   * The precise live-wrapper recovery code, when the dispatch error carried one
   * (a `LiveStepExecutorError`). Surfaced for the run-level recovery layer.
   */
  liveRecoveryCode?: string;
};

/**
 * Execute one managed live workflow step end to end through its durable lease +
 * step-state lifecycle. See the module doc for the ordered contract.
 */
export function runLiveWorkflowStep(
  input: RunLiveWorkflowStepInput
): RunLiveWorkflowStepOutcome {
  const { db, runId, stepId, holder, leaseExpiresAt, executor, executorInput } =
    input;
  const leaseKind = input.leaseKind ?? LIVE_STEP_DEFAULT_LEASE_KIND;
  const stalePolicy = input.stalePolicy ?? "manual-recovery-required";
  const startNow = input.now ?? Date.now();

  const inputError = validateExecutorInputIdentity(input);
  if (inputError !== null) {
    return {
      ok: false,
      stage: "input",
      lease: { acquired: false, released: false },
      inputError
    };
  }
  const claim = claimLiveWorkflowStepStart(db, {
    runId,
    stepId,
    leaseKind,
    holder,
    executorInput,
    expiresAt: leaseExpiresAt,
    stalePolicy,
    now: startNow
  });
  if (!claim.ok) {
    return claim.outcome;
  }
  const { acquired, start, repoLock } = claim;

  // 3. Execute the step. Trap a thrown executor so the lease + step are always
  //    finalized into durable state rather than stranded `running`.
  let dispatch: WorkflowStepExecutorDispatchResult;
  let heartbeat: LiveStepLeaseHeartbeat;
  try {
    heartbeat = startLiveStepLeaseHeartbeat(db, {
      runId,
      leaseKind,
      holder: acquired.lease.holder,
      acquiredAt: acquired.lease.acquiredAt,
      startNow,
      leaseExpiresAt,
      ...(repoLock !== undefined ? { repoLock } : {})
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dispatch = {
      ok: false,
      code: "runtime_unavailable",
      error: `Live workflow step heartbeat failed to start: ${detail}`,
      executorLogPath: executorInput.executorLogPath,
      resultJsonPath: executorInput.resultJsonPath
    };
    const finish = finishLiveWorkflowStep(db, {
      runId,
      stepId,
      state: "failed",
      errorCode: dispatch.code,
      errorMessage: dispatch.error,
      resultDigest: null,
      now: startNow
    });
    const released = finish.ok
      ? releaseWorkflowLease(db, {
          runId,
          leaseKind,
          holder: acquired.lease.holder,
          acquiredAt: acquired.lease.acquiredAt,
          now: startNow
        })
      : { ok: false };
    return {
      ok: false,
      stage: "execute",
      lease: { acquired: true, released: released.ok },
      start,
      dispatch,
      finish,
      terminalState: "failed"
    };
  }
  try {
    dispatch = executor.execute(executorInput);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dispatch = {
      ok: false,
      code: "executor_threw",
      error: `Live workflow step executor threw: ${detail}`,
      executorLogPath: executorInput.executorLogPath,
      resultJsonPath: executorInput.resultJsonPath
    };
  } finally {
    heartbeat.stop();
  }

  // 4. Persist the terminal step state BEFORE releasing the lease (contract:
  //    "Persist terminal state before releasing the lease").
  const finishNow = input.now ?? Date.now();
  const currentHeartbeatAt =
    getWorkflowLease(db, runId, leaseKind)?.heartbeatAt ?? finishNow;
  const finalHeartbeatAt = Math.max(finishNow, currentHeartbeatAt);
  if (
    repoLock !== undefined &&
    !refreshLiveWorkflowRepoLock(db, {
      repoLock,
      heartbeatAt: finalHeartbeatAt,
      leaseExpiresAt: finalHeartbeatAt + heartbeat.leaseDurationMs
    }).ok
  ) {
    const liveRecoveryCode =
      !dispatch.ok && "liveRecoveryCode" in dispatch
        ? (dispatch as { liveRecoveryCode?: unknown }).liveRecoveryCode
        : undefined;
    return {
      ok: false,
      stage: "execute",
      lease: { acquired: true, released: false },
      start,
      dispatch,
      ...(typeof liveRecoveryCode === "string" ? { liveRecoveryCode } : {})
    };
  }
  const finalHeartbeat = heartbeatWorkflowLease(db, {
    runId,
    leaseKind,
    holder: acquired.lease.holder,
    acquiredAt: acquired.lease.acquiredAt,
    heartbeatAt: finalHeartbeatAt,
    expiresAt: finalHeartbeatAt + heartbeat.leaseDurationMs
  });
  if (!finalHeartbeat.ok) {
    const liveRecoveryCode =
      !dispatch.ok && "liveRecoveryCode" in dispatch
        ? (dispatch as { liveRecoveryCode?: unknown }).liveRecoveryCode
        : undefined;
    return {
      ok: false,
      stage: "execute",
      lease: { acquired: true, released: false },
      start,
      dispatch,
      ...(typeof liveRecoveryCode === "string" ? { liveRecoveryCode } : {})
    };
  }
  const terminalState: WorkflowStepTerminalState = dispatch.ok
    ? mapStartedStepTerminalState(dispatch.result.state)
    : "failed";
  const liveRecoveryCode =
    !dispatch.ok && "liveRecoveryCode" in dispatch
      ? (dispatch as { liveRecoveryCode?: unknown }).liveRecoveryCode
      : undefined;
  if (
    (input.deferNormalizedTerminalState === true && dispatch.ok) ||
    (input.deferDispatchErrorTerminalState === true && !dispatch.ok) ||
    (input.deferSuccessfulTerminalState === true && terminalState === "succeeded")
  ) {
    return {
      ok: false,
      stage: "execute",
      lease: { acquired: true, released: false },
      start,
      dispatch,
      terminalState,
      deferredTerminalState: terminalState,
      deferredLease: acquired.lease,
      ...(typeof liveRecoveryCode === "string" ? { liveRecoveryCode } : {})
    };
  }
  const finish = finishLiveWorkflowStep(db, {
    runId,
    stepId,
    state: terminalState,
    errorCode: dispatch.ok ? dispatch.result.errorCode : dispatch.code,
    errorMessage: dispatch.ok ? dispatch.result.errorMessage : dispatch.error,
    resultDigest: dispatch.ok ? dispatch.result.resultDigest : null,
    now: finishNow
  });

  // 5. Release the managed-step lease only once terminal state is durable. If
  //    the finish write refused (for example, a concurrent terminal transition),
  //    keep the lease outstanding so monitor/recovery sees the ambiguity rather
  //    than losing both the running lease and the terminal evidence.
  const released = finish.ok
    ? releaseWorkflowLease(db, {
        runId,
        leaseKind,
        holder: acquired.lease.holder,
        acquiredAt: acquired.lease.acquiredAt,
        now: finishNow
      })
    : { ok: false };

  return {
    ok:
      dispatch.ok &&
      finish.ok &&
      released.ok &&
      terminalState === "succeeded",
    stage: "execute",
    lease: { acquired: true, released: released.ok },
    start,
    dispatch,
    finish,
    terminalState,
    ...(typeof liveRecoveryCode === "string" ? { liveRecoveryCode } : {})
  };
}

type LiveWorkflowStepStartClaim =
  | {
      ok: true;
      acquired: { ok: true; lease: WorkflowLeaseRecord };
      start: WorkflowStepTransitionOutcome;
      repoLock?: LiveWorkflowRepoLock;
    }
  | { ok: false; outcome: RunLiveWorkflowStepOutcome };

type LiveWorkflowRepoLock = {
  id: string;
  repoPath: string;
  holder: string;
  goalId: string;
};

function claimLiveWorkflowStepStart(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    leaseKind: WorkflowLeaseKind;
    holder: string;
    executorInput: WorkflowStepExecutorInput;
    expiresAt: number;
    stalePolicy: WorkflowLeaseStalePolicy;
    now: number;
  }
): LiveWorkflowStepStartClaim {
  db.exec("BEGIN IMMEDIATE");
  try {
    const runGate = validateWorkflowRunExecutionGate(db, input.runId);
    if (!runGate.ok) {
      db.exec("ROLLBACK");
      return inputRefusal(runGate.error);
    }

    const repoPathError = validateExecutorInputRepoPath(
      input.runId,
      input.executorInput.repoPath,
      runGate.repoPath
    );
    if (repoPathError !== null) {
      db.exec("ROLLBACK");
      return inputRefusal(repoPathError);
    }

    const durableStep = getWorkflowStep(db, input.runId, input.stepId);
    if (durableStep === undefined) {
      db.exec("ROLLBACK");
      return inputRefusal(
        `runLiveWorkflowStep: workflow step not found "${input.runId}/${input.stepId}"`
      );
    }
    if (
      durableStep.kind !== input.executorInput.kind
    ) {
      db.exec("ROLLBACK");
      return inputRefusal(
        `runLiveWorkflowStep: workflow_steps.kind "${durableStep.kind}" must match executorInput.kind "${input.executorInput.kind}"`
      );
    }
    const stepStateError = validateWorkflowStepStartState(
      input.runId,
      input.stepId,
      durableStep.state
    );
    if (stepStateError !== null) {
      db.exec("ROLLBACK");
      return inputRefusal(stepStateError);
    }
    const predecessorError = validateWorkflowStepPredecessors(
      db,
      input.runId,
      input.stepId
    );
    if (predecessorError !== null) {
      db.exec("ROLLBACK");
      return inputRefusal(predecessorError);
    }
    const approvalError = validateWorkflowApprovalCoverage(
      db,
      input.runId,
      durableStep.kind
    );
    if (approvalError !== null) {
      db.exec("ROLLBACK");
      return inputRefusal(approvalError);
    }

    const repoLock = validateWorkflowRepoLock(
      db,
      input.runId,
      runGate.repoPath,
      runGate.goalId,
      input.holder,
      input.now
    );
    if (!repoLock.ok) {
      db.exec("ROLLBACK");
      return inputRefusal(repoLock.error);
    }

    const runningStepGateError = validateNoOtherRunningWorkflowStep(
      db,
      input.runId,
      input.stepId
    );
    if (runningStepGateError !== null) {
      db.exec("ROLLBACK");
      return inputRefusal(runningStepGateError);
    }

    const acquired = acquireWorkflowLeaseInTransaction(db, {
      runId: input.runId,
      leaseKind: input.leaseKind,
      holder: input.holder,
      expiresAt: input.expiresAt,
      stalePolicy: input.stalePolicy,
      now: input.now
    });
    if (!acquired.ok) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        outcome: {
          ok: false,
          stage: "lease",
          lease: {
            acquired: false,
            released: false,
            existing: acquired.existing
          }
        }
      };
    }

    if (
      repoLock.lock !== undefined &&
      !refreshLiveWorkflowRepoLock(db, {
        repoLock: repoLock.lock,
        heartbeatAt: input.now,
        leaseExpiresAt: input.expiresAt
      }).ok
    ) {
      db.exec("ROLLBACK");
      return inputRefusal(
        `runLiveWorkflowStep: repo lock for "${repoLock.lock.repoPath}" was lost before live step start`
      );
    }

    const postAcquireRunGate = validateWorkflowRunExecutionGate(
      db,
      input.runId
    );
    if (!postAcquireRunGate.ok) {
      const released = releaseWorkflowLease(db, {
        runId: input.runId,
        leaseKind: input.leaseKind,
        holder: acquired.lease.holder,
        acquiredAt: acquired.lease.acquiredAt,
        now: input.now
      });
      db.exec("COMMIT");
      return {
        ok: false,
        outcome: {
          ok: false,
          stage: "lease",
          lease: { acquired: true, released: released.ok },
          inputError: postAcquireRunGate.error
        }
      };
    }

    const start = startWorkflowStep(db, {
      runId: input.runId,
      stepId: input.stepId,
      now: input.now
    });
    if (!start.ok) {
      const released = releaseWorkflowLease(db, {
        runId: input.runId,
        leaseKind: input.leaseKind,
        holder: acquired.lease.holder,
        acquiredAt: acquired.lease.acquiredAt,
        now: input.now
      });
      db.exec("COMMIT");
      return {
        ok: false,
        outcome: {
          ok: false,
          stage: "start",
          lease: { acquired: true, released: released.ok },
          start
        }
      };
    }

    db.exec("COMMIT");
    return {
      ok: true,
      acquired,
      start,
      ...(repoLock.lock !== undefined ? { repoLock: repoLock.lock } : {})
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}

function inputRefusal(error: string): LiveWorkflowStepStartClaim {
  return {
    ok: false,
    outcome: {
      ok: false,
      stage: "input",
      lease: { acquired: false, released: false },
      inputError: error
    }
  };
}

function finishLiveWorkflowStep(
  db: MomentumDb,
  input: FinishWorkflowStepInput
): WorkflowStepTransitionOutcome {
  const finish = finishWorkflowStep(db, input);
  if (!finish.ok || !finish.idempotent) return finish;

  const row = getWorkflowStep(db, input.runId, input.stepId);
  if (row === undefined) return { ok: false, reason: "step_not_found" };

  const errorCode = input.errorCode ?? null;
  const errorMessage = input.errorMessage ?? null;
  const resultDigest = input.resultDigest ?? null;
  if (
    row.state === input.state &&
    row.errorCode === errorCode &&
    row.errorMessage === errorMessage &&
    row.resultDigest === resultDigest
  ) {
    return finish;
  }

  return liveTerminalConflict(
    input.runId,
    input.stepId,
    row.state,
    input.state
  );
}

function liveTerminalConflict(
  runId: string,
  stepId: string,
  from: WorkflowStepState,
  to: WorkflowStepTerminalState
): WorkflowStepTransitionOutcome {
  return {
    ok: false,
    reason: "invalid_transition",
    from,
    to,
    errorCode: "workflow_step_invalid_transition",
    errorMessage: `workflow step ${runId}/${stepId} was already terminalized into ${from} with different live result metadata; refusing ambiguous ${to} transition`
  };
}

function validateExecutorInputIdentity(
  input: RunLiveWorkflowStepInput
): string | null {
  const requestedLeaseKind = input.leaseKind as WorkflowLeaseKind | undefined;
  if (requestedLeaseKind === "monitor") {
    return `runLiveWorkflowStep: leaseKind "monitor" is reserved for workflow monitors`;
  }
  if (input.executorInput.runId !== input.runId) {
    return `runLiveWorkflowStep: executorInput.runId "${input.executorInput.runId}" must match runId "${input.runId}"`;
  }
  if (input.executorInput.stepId !== input.stepId) {
    return `runLiveWorkflowStep: executorInput.stepId "${input.executorInput.stepId}" must match stepId "${input.stepId}"`;
  }
  if (input.executorInput.kind !== input.executor.kind) {
    return `runLiveWorkflowStep: executorInput.kind "${input.executorInput.kind}" must match executor.kind "${input.executor.kind}"`;
  }
  return null;
}

function validateNoOtherRunningWorkflowStep(
  db: MomentumDb,
  runId: string,
  stepId: string
): string | null {
  const row = db
    .prepare(
      `SELECT step_id
         FROM workflow_steps
        WHERE run_id = ?
          AND state = 'running'
          AND step_id <> ?
        ORDER BY step_order, step_id
        LIMIT 1`
    )
    .get(runId, stepId) as { step_id: string } | undefined;
  if (row === undefined) return null;
  return `runLiveWorkflowStep: workflow run "${runId}" already has running step "${row.step_id}"`;
}

function validateWorkflowStepStartState(
  runId: string,
  stepId: string,
  state: WorkflowStepState
): string | null {
  if (state === "approved") return null;
  return `runLiveWorkflowStep: workflow step "${runId}/${stepId}" cannot start from state ${state}; expected approved`;
}

function validateWorkflowStepPredecessors(
  db: MomentumDb,
  runId: string,
  stepId: string
): string | null {
  const row = db
    .prepare(
      `SELECT predecessor.step_id AS stepId,
              predecessor.state AS state
         FROM workflow_steps AS target
         JOIN workflow_steps AS predecessor
           ON predecessor.run_id = target.run_id
        WHERE target.run_id = ?
          AND target.step_id = ?
          AND predecessor.required = 1
          AND predecessor.step_order < target.step_order
          AND predecessor.state NOT IN ('succeeded', 'skipped')
        ORDER BY predecessor.step_order, predecessor.step_id
        LIMIT 1`
    )
    .get(runId, stepId) as
    | { stepId: string; state: WorkflowStepState }
    | undefined;
  if (row === undefined) return null;
  return [
    `runLiveWorkflowStep: workflow step "${runId}/${stepId}" cannot start`,
    `before required predecessor "${row.stepId}" reaches succeeded or skipped`,
    `(current state ${row.state})`
  ].join(" ");
}

type WorkflowRunExecutionGate =
  | { ok: true; repoPath: string | null; goalId: string | null }
  | { ok: false; error: string };

function validateWorkflowRunExecutionGate(
  db: MomentumDb,
  runId: string
): WorkflowRunExecutionGate {
  const row = db
    .prepare(
      `SELECT state,
              needs_manual_recovery AS needsManualRecovery,
              manual_recovery_reason AS manualRecoveryReason,
              repo_path AS repoPath,
              goal_id AS goalId
         FROM workflow_runs
        WHERE id = ?`
    )
    .get(runId) as
    | {
        state: WorkflowRunState;
        needsManualRecovery: number;
        manualRecoveryReason: string | null;
        repoPath: string | null;
        goalId: string | null;
      }
    | undefined;
  if (row === undefined) {
    return { ok: false, error: `runLiveWorkflowStep: workflow run not found "${runId}"` };
  }
  if (isTerminalRunState(row.state)) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: workflow run "${runId}" is terminal (${row.state})`
    };
  }
  if (row.needsManualRecovery === 1) {
    return {
      ok: false,
      error:
        row.manualRecoveryReason ??
        `runLiveWorkflowStep: workflow run "${runId}" requires manual recovery`
    };
  }
  if (!LIVE_WORKFLOW_RUN_EXECUTABLE_STATES.has(row.state)) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: workflow run "${runId}" is not executable in state ${row.state}`
    };
  }
  return { ok: true, repoPath: row.repoPath, goalId: row.goalId };
}

function validateExecutorInputRepoPath(
  runId: string,
  executorRepoPath: string,
  durableRepoPath: string | null
): string | null {
  if (durableRepoPath === null) {
    return `runLiveWorkflowStep: workflow_runs.repo_path is required for live execution of run "${runId}"`;
  }
  if (executorRepoPath !== durableRepoPath) {
    return `runLiveWorkflowStep: executorInput.repoPath "${executorRepoPath}" must match workflow_runs.repo_path "${durableRepoPath}" for run "${runId}"`;
  }
  return null;
}

function validateWorkflowApprovalCoverage(
  db: MomentumDb,
  runId: string,
  stepKind: WorkflowStepKind
): string | null {
  const rows = db
    .prepare(
      `SELECT boundary
         FROM workflow_approvals
        WHERE run_id = ?
          AND discharged_at IS NULL
        ORDER BY recorded_at DESC, boundary`
    )
    .all(runId) as Array<{ boundary: string }>;
  for (const row of rows) {
    if (
      isWorkflowApprovalBoundary(row.boundary) &&
      workflowStepKindsForApprovalBoundary(row.boundary).includes(stepKind)
    ) {
      return null;
    }
  }
  return `runLiveWorkflowStep: workflow run "${runId}" lacks durable approval coverage for ${stepKind}`;
}

function validateWorkflowRepoLock(
  db: MomentumDb,
  runId: string,
  repoPath: string | null,
  goalId: string | null,
  holder: string,
  now: number
): { ok: true; lock?: LiveWorkflowRepoLock } | { ok: false; error: string } {
  if (repoPath === null) return { ok: true };
  if (goalId === null) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: workflow_runs.goal_id is required for live execution of run "${runId}"`
    };
  }
  const row = db
    .prepare(
      `SELECT id, holder, goal_id AS goalId, lease_expires_at AS leaseExpiresAt
         FROM repo_locks
        WHERE repo_root = ?
          AND state = 'active'
        ORDER BY acquired_at DESC, id DESC
        LIMIT 1`
    )
    .get(repoPath) as
    | { id: string; holder: string; goalId: string; leaseExpiresAt: number }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: workflow run "${runId}" requires an active repo lock for "${repoPath}"`
    };
  }
  if (row.leaseExpiresAt <= now) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: repo lock for "${repoPath}" expired before live step start`
    };
  }
  if (row.holder !== holder) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: repo lock for "${repoPath}" is held by "${row.holder}", not "${holder}"`
    };
  }
  if (row.goalId !== goalId) {
    return {
      ok: false,
      error: `runLiveWorkflowStep: repo lock for "${repoPath}" belongs to goal "${row.goalId}", not workflow run goal "${goalId}"`
    };
  }
  return {
    ok: true,
    lock: { id: row.id, repoPath, holder: row.holder, goalId: row.goalId }
  };
}

function refreshLiveWorkflowRepoLock(
  db: MomentumDb,
  input: {
    repoLock: LiveWorkflowRepoLock;
    heartbeatAt: number;
    leaseExpiresAt: number;
  }
): { ok: boolean } {
  // A heartbeat worker can advance repo_locks just before this final refresh
  // observes the older workflow lease. Preserve the furthest-known timestamps.
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET heartbeat_at = max(heartbeat_at, ?),
             lease_expires_at = max(lease_expires_at, ?),
             updated_at = max(updated_at, ?)
       WHERE id = ?
         AND repo_root = ?
         AND holder = ?
         AND goal_id = ?
         AND state = 'active'
         AND lease_expires_at >= ?`
    )
    .run(
      input.heartbeatAt,
      input.leaseExpiresAt,
      input.heartbeatAt,
      input.repoLock.id,
      input.repoLock.repoPath,
      input.repoLock.holder,
      input.repoLock.goalId,
      input.heartbeatAt
    );
  return { ok: Number(result.changes) > 0 };
}

function mapStartedStepTerminalState(
  state: WorkflowStepExecutorTerminalState
): WorkflowStepTerminalState {
  return state === "skipped" ? "succeeded" : state;
}

type LiveStepLeaseHeartbeat = {
  stop: () => void;
  leaseDurationMs: number;
};

function startLiveStepLeaseHeartbeat(
  db: MomentumDb,
  input: {
    runId: string;
    leaseKind: WorkflowLeaseKind;
    holder: string;
    acquiredAt: number;
    startNow: number;
    leaseExpiresAt: number;
    repoLock?: LiveWorkflowRepoLock;
  }
): LiveStepLeaseHeartbeat {
  const leaseDurationMs = Math.max(1, input.leaseExpiresAt - input.startNow);
  const heartbeatIntervalMs = Math.max(1, Math.floor(leaseDurationMs / 2));
  const dbPath = db.location();
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    return { stop: () => undefined, leaseDurationMs };
  }

  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const controlView = new Int32Array(control);
  const worker = new Worker(LIVE_STEP_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath,
      runId: input.runId,
      leaseKind: input.leaseKind,
      holder: input.holder,
      acquiredAt: input.acquiredAt,
      startNow: input.startNow,
      wallClockStartedAt: Date.now(),
      leaseDurationMs,
      heartbeatIntervalMs,
      repoLock: input.repoLock ?? null,
      control
    }
  });
  worker.on("error", () => {
    Atomics.store(controlView, 0, 2);
    Atomics.notify(controlView, 0);
  });
  worker.unref();

  return {
    leaseDurationMs,
    stop: () => {
      if (Atomics.load(controlView, 0) !== 2) {
        Atomics.store(controlView, 0, 1);
        Atomics.notify(controlView, 0);
        Atomics.wait(controlView, 0, 1, 1_000);
      }
    }
  };
}

const LIVE_STEP_HEARTBEAT_WORKER_SOURCE = `
const { DatabaseSync } = require("node:sqlite");
const { workerData } = require("node:worker_threads");

const control = new Int32Array(workerData.control);

try {
  let db;
  let workflowStatement;
  let repoLockStatement;

  function closeDb() {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
      }
      db = undefined;
      workflowStatement = undefined;
      repoLockStatement = undefined;
    }
  }

  function getWorkflowStatement() {
    if (workflowStatement !== undefined) return workflowStatement;
    if (db === undefined) db = new DatabaseSync(workerData.dbPath);
    workflowStatement = db.prepare(
      \`UPDATE workflow_leases
       SET heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE run_id = ?
         AND lease_kind = ?
         AND holder = ?
         AND acquired_at = ?
         AND released_at IS NULL
         AND expires_at >= ?\`
    );
    return workflowStatement;
  }

  function getRepoLockStatement() {
    if (repoLockStatement !== undefined) return repoLockStatement;
    if (db === undefined) db = new DatabaseSync(workerData.dbPath);
    repoLockStatement = db.prepare(
      \`UPDATE repo_locks
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND repo_root = ?
         AND holder = ?
         AND goal_id = ?
         AND state = 'active'
         AND lease_expires_at >= ?\`
    );
    return repoLockStatement;
  }

  try {
    function heartbeat() {
      const now =
        workerData.startNow +
        Math.max(0, Date.now() - workerData.wallClockStartedAt);
      try {
        const leaseExpiresAt = now + workerData.leaseDurationMs;
        if (workerData.repoLock !== null) {
          const repoResult = getRepoLockStatement().run(
            now,
            leaseExpiresAt,
            now,
            workerData.repoLock.id,
            workerData.repoLock.repoPath,
            workerData.repoLock.holder,
            workerData.repoLock.goalId,
            now
          );
          if (Number(repoResult.changes) === 0) return false;
        }
        const workflowResult = getWorkflowStatement().run(
          now,
          leaseExpiresAt,
          now,
          workerData.runId,
          workerData.leaseKind,
          workerData.holder,
          workerData.acquiredAt,
          now
        );
        if (Number(workflowResult.changes) === 0) return false;
        return true;
      } catch {
        closeDb();
        return false;
      }
    }

    let lastHeartbeatOk = heartbeat();
    while (Atomics.load(control, 0) === 0) {
      Atomics.wait(
        control,
        0,
        0,
        lastHeartbeatOk ? workerData.heartbeatIntervalMs : 10
      );
      if (Atomics.load(control, 0) === 0) {
        lastHeartbeatOk = heartbeat();
      }
    }
  } finally {
    closeDb();
  }
} finally {
  Atomics.store(control, 0, 2);
  Atomics.notify(control, 0);
}
`;
