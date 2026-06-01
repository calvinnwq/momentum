/**
 * Run-level composition for a single live workflow step (NGX-334, M9-03).
 *
 * The M9-03 slice ships three primitives that are deliberately separate so each
 * stays a focused, independently testable unit:
 *
 *   - {@link runLiveWorkflowStep} (`live-step-orchestrator.ts`) drives the
 *     durable lease + step-state lifecycle around an executor. It is
 *     git-agnostic: it never touches the worktree.
 *   - {@link finalizeLiveWorkflowStepFromResultFile} (`live-step-finalize.ts`) is
 *     a pure git + verification transaction over the step's normalized result
 *     document. It owns no durable state.
 *   - {@link persistLiveWorkflowFinalizeRecovery} (`live-step-run-recovery.ts`)
 *     durably enters manual recovery (the `needs_manual_recovery` flag + per-run
 *     `recovery.md`) when the finalize transaction surfaces a recovery condition.
 *
 * This module is the seam that wires those three into the single managed-step
 * "advance" the M9 contract's "Git And Verification Transaction" section
 * describes, holding the caller's repo lock across the verification transaction:
 *
 *   runLiveWorkflowStep            (lease + approved->running->terminal lifecycle)
 *   -> finalizeLiveWorkflowStepFromResultFile  (verify -> commit / reset)
 *   -> persistLiveWorkflowFinalizeRecovery     (durable recovery on head/result)
 *
 * The git + verification transaction runs only when the managed step settled
 * into a terminal state from a *normalized* dispatch result —
 * `dispatch.ok === true`, either deferred while still leased or already durably
 * persisted. That gate is the boundary between the two recovery
 * worlds M9 keeps distinct:
 *
 *   - A normalized dispatch (`ok: true`) means the runner produced a trustworthy
 *     result document: `success: true` commits the verified diff, `success:
 *     false` is the executed-but-failed path that resets. Re-reading that
 *     document at finalize time can still surface `result_missing` /
 *     `result_invalid` (a result lost or corrupted after dispatch) or a moved
 *     HEAD, which route to durable recovery instead of a destructive reset.
 *   - A process-level dispatch error (`ok: false`) already carries a precise
 *     live recovery code (`runtime_unavailable`, `auth_unavailable`,
 *     `command_failed`, `command_timed_out`, `output_overflow`, ...) on
 *     {@link RunLiveWorkflowStepOutcome.liveRecoveryCode}. Running the git
 *     transaction there would only re-classify it as a generic
 *     `result_missing`, masking the precise cause, so this seam persists live
 *     dispatch recovery without touching the worktree.
 *
 * Likewise, a step that never settled (a start refusal, or an ambiguous
 * in-flight finish where the lease was intentionally left outstanding) is not
 * finalized: there is no trustworthy terminal state and the repo lock may have
 * been lost, so mutating git would be unsafe. Those outcomes are returned
 * verbatim for the monitor / recovery layer.
 *
 * Durable mutations stay in the composed primitives, except for the final
 * reconciliation that marks a deferred normalized step terminal after the git
 * transaction produces a committed, reset, or recovery outcome.
 */

import type { MomentumDb } from "./db.js";
import { Worker } from "node:worker_threads";
import {
  finalizeLiveWorkflowStepFromResultFile,
  type FinalizeLiveWorkflowStepFromResultFileResult
} from "./live-step-finalize.js";
import {
  runLiveWorkflowStep,
  type LiveWorkflowStepLeaseKind,
  type RunLiveWorkflowStepOutcome
} from "./live-step-orchestrator.js";
import {
  persistLiveWorkflowDispatchRecovery,
  persistLiveWorkflowFinalizeRecovery,
  type PersistLiveWorkflowFinalizeRecoveryResult
} from "./live-step-run-recovery.js";
import type {
  WorkflowLeaseRecord,
  WorkflowLeaseKind,
  WorkflowLeaseStalePolicy,
  WorkflowStepKind,
  WorkflowStepRecord,
  WorkflowStepState
} from "./workflow-run-reducer.js";
import {
  deriveWorkflowRunState,
  isTerminalRunState
} from "./workflow-run-reducer.js";
import {
  heartbeatWorkflowLease,
  releaseWorkflowLease
} from "./workflow-leases.js";
import {
  finishWorkflowStep,
  type WorkflowStepTransitionOutcome
} from "./workflow-step-transitions.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorInput
} from "./workflow-step-executor.js";

export type AdvanceLiveWorkflowStepInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  /** Lease holder identity (e.g. the worker / process id). */
  holder: string;
  /** Absolute ms timestamp at which the managed-step lease expires. */
  leaseExpiresAt: number;
  /** The executor to run (an M9 live wrapper, or a fake in tests). */
  executor: WorkflowStepExecutor;
  /** The executor input forwarded to the orchestrator after identity validation. */
  executorInput: WorkflowStepExecutorInput;
  /** Lease kind to take; forwarded to the orchestrator's default when unset. */
  leaseKind?: LiveWorkflowStepLeaseKind;
  /** Stale policy for the acquired lease; forwarded to the orchestrator default. */
  stalePolicy?: WorkflowLeaseStalePolicy;
  /** The HEAD the live step started from; finalize commits onto / resets to it. */
  baseHead: string;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  /**
   * Directory under which the run-scoped `recovery.md` is rendered when the
   * finalize transaction enters durable recovery.
   */
  agentWorkflowsDir: string;
  /** Override the recovery artifact directory; forwarded to the recovery seam. */
  artifactRunDir?: string;
  /** Deterministic clock for stamping; defaults to `Date.now()` in each primitive. */
  now?: number;
};

export type AdvanceLiveWorkflowStepResult = {
  /** True only when the step ran, verified, and the diff was committed. */
  committed: boolean;
  /**
   * True when the git + verification transaction ran (the step settled into a
   * clean terminal state from a normalized dispatch result). When false, the
   * orchestrator outcome alone explains why no transaction ran.
   */
  finalized: boolean;
  /** The managed-step orchestration outcome (always present). */
  run: RunLiveWorkflowStepOutcome;
  /** The git + verification transaction outcome; present iff `finalized`. */
  finalize?: FinalizeLiveWorkflowStepFromResultFileResult;
  /** The durable recovery reconciliation outcome when finalization enters recovery. */
  recovery?: PersistLiveWorkflowFinalizeRecoveryResult;
};

/**
 * Advance one managed live workflow step: orchestrate its execution, then run
 * the git + verification transaction and durable recovery for a cleanly
 * dispatched terminal step. See the module doc for the ordered contract and the
 * gate that decides when the git transaction runs.
 */
export function advanceLiveWorkflowStep(
  input: AdvanceLiveWorkflowStepInput
): AdvanceLiveWorkflowStepResult {
  const run = runLiveWorkflowStep({
    db: input.db,
    runId: input.runId,
    stepId: input.stepId,
    holder: input.holder,
    leaseExpiresAt: input.leaseExpiresAt,
    executor: input.executor,
    executorInput: input.executorInput,
    ...(input.leaseKind !== undefined ? { leaseKind: input.leaseKind } : {}),
    ...(input.stalePolicy !== undefined
      ? { stalePolicy: input.stalePolicy }
      : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    deferNormalizedTerminalState: true,
    deferDispatchErrorTerminalState: true
  });

  // The git + verification transaction runs only for a step that settled into a
  // clean terminal state from a normalized dispatch result. A process-level
  // dispatch error already carries a precise live recovery code, and an
  // unsettled finish leaves an ambiguous repo lock — neither is safe to mutate.
  const dispatch = run.dispatch;
  const canFinalize =
    dispatch !== undefined &&
    dispatch.ok &&
    (run.finish?.ok === true || run.deferredTerminalState !== undefined);
  if (!canFinalize) {
    const recovery =
      dispatch !== undefined && !dispatch.ok && run.stage === "execute"
        ? persistLiveWorkflowDispatchRecovery(input.db, {
            runId: input.runId,
            stepId: input.stepId,
            dispatchCode: dispatch.code,
            ...(run.liveRecoveryCode !== undefined
              ? { liveRecoveryCode: run.liveRecoveryCode }
              : {}),
            error: dispatch.error,
            ...(dispatch.executorLogPath !== undefined
              ? { executorLogPath: dispatch.executorLogPath }
              : {}),
            ...(dispatch.resultJsonPath !== undefined
              ? { resultJsonPath: dispatch.resultJsonPath }
              : {}),
            agentWorkflowsDir: input.agentWorkflowsDir,
            ...(input.artifactRunDir !== undefined
              ? { artifactRunDir: input.artifactRunDir }
              : {}),
            repoPath: input.executorInput.repoPath,
            ...(input.now !== undefined ? { now: input.now } : {})
          })
        : undefined;
    const completedDeferredDispatchError =
      dispatch !== undefined &&
      !dispatch.ok &&
      recovery?.ok === true &&
      run.deferredTerminalState !== undefined;
    const settledRun = completedDeferredDispatchError
      ? completeDeferredStep(input, run, {
          outcome: "dispatch_error",
          message: dispatch.error
        })
      : run;
    if (dispatch !== undefined && !completedDeferredDispatchError) {
      refreshWorkflowRunStateAfterLiveStep(input.db, {
        runId: input.runId,
        ...(input.now !== undefined ? { now: input.now } : {})
      });
    }
    return {
      committed: false,
      finalized: false,
      run: settledRun,
      ...(recovery !== undefined ? { recovery } : {})
    };
  }

  const repoLockHeartbeat = startAdvanceRepoLockHeartbeat(
    input,
    run.deferredLease
  );
  if (!repoLockHeartbeat.ok) {
    const finalize: FinalizeLiveWorkflowStepFromResultFileResult = {
      outcome: "repo_lock_lost",
      error: repoLockHeartbeat.error
    };
    const recovery = persistLiveWorkflowFinalizeRecovery(input.db, {
      runId: input.runId,
      stepId: input.stepId,
      finalize,
      agentWorkflowsDir: input.agentWorkflowsDir,
      ...(input.artifactRunDir !== undefined
        ? { artifactRunDir: input.artifactRunDir }
        : {}),
      repoPath: input.executorInput.repoPath,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    const failedRun = completeDeferredStep(input, run, {
      outcome: "repo_lock_lost",
      message: repoLockHeartbeat.error
    });
    reconcileFinalizeStepFailure(input.db, {
      runId: input.runId,
      stepId: input.stepId,
      outcome: "repo_lock_lost",
      message: repoLockHeartbeat.error,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    if (run.deferredTerminalState === undefined) {
      refreshWorkflowRunStateAfterLiveStep(input.db, {
        runId: input.runId,
        ...(input.now !== undefined ? { now: input.now } : {})
      });
    }
    return { committed: false, finalized: false, run: failedRun, recovery };
  }

  let finalize: FinalizeLiveWorkflowStepFromResultFileResult;
  try {
    finalize = finalizeLiveWorkflowStepFromResultFile({
      repoPath: input.executorInput.repoPath,
      baseHead: input.baseHead,
      resultFilePath: dispatch.resultJsonPath,
      verificationCommands: input.verificationCommands,
      verificationTimeoutSec: input.verificationTimeoutSec,
      verificationLogPath: input.verificationLogPath,
      beforeGitMutation: repoLockHeartbeat.heartbeat.assertFresh
    });
  } finally {
    repoLockHeartbeat.heartbeat.stop();
  }

  const recovery = persistLiveWorkflowFinalizeRecovery(input.db, {
    runId: input.runId,
    stepId: input.stepId,
    finalize,
    agentWorkflowsDir: input.agentWorkflowsDir,
    ...(input.artifactRunDir !== undefined
      ? { artifactRunDir: input.artifactRunDir }
      : {}),
    repoPath: input.executorInput.repoPath,
    ...(input.now !== undefined ? { now: input.now } : {})
  });

  const completedRun = completeDeferredStep(input, run, {
    outcome: finalize.outcome,
    message: describeFinalizeFailure(finalize)
  });

  reconcileFinalizeStepState(input.db, {
    runId: input.runId,
    stepId: input.stepId,
    finalize,
    ...(input.now !== undefined ? { now: input.now } : {})
  });
  if (run.deferredTerminalState === undefined) {
    refreshWorkflowRunStateAfterLiveStep(input.db, {
      runId: input.runId,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
  }

  return {
    committed: finalize.outcome === "committed",
    finalized: true,
    run: completedRun,
    finalize,
    recovery
  };
}

type AdvanceRepoLockHeartbeat =
  | {
      ok: true;
      heartbeat: {
        stop: () => { ok: boolean; error?: string };
        assertFresh: () => { ok: true } | { ok: false; error: string };
      };
    }
  | { ok: false; error: string };

type AdvanceRepoLock = {
  id: string;
  repoPath: string;
  holder: string;
  goalId: string;
  leaseExpiresAt: number;
};

function startAdvanceRepoLockHeartbeat(
  input: AdvanceLiveWorkflowStepInput,
  workflowLease: {
    runId: string;
    leaseKind: WorkflowLeaseKind;
    holder: string;
    acquiredAt: number;
  } | undefined
): AdvanceRepoLockHeartbeat {
  const startNow = input.now ?? Date.now();
  const repoLock = getAdvanceRepoLock(input.db, {
    runId: input.runId,
    repoPath: input.executorInput.repoPath,
    holder: input.holder,
    now: startNow
  });
  if (!repoLock.ok) return repoLock;

  const leaseDurationMs = resolveAdvanceLeaseDurationMs(input.db, {
    workflowLease,
    repoLock: repoLock.lock,
    fallbackLeaseExpiresAt: input.leaseExpiresAt,
    now: startNow
  });
  if (
    !refreshAdvanceRepoLock(input.db, {
      repoLock: repoLock.lock,
      heartbeatAt: startNow,
      leaseExpiresAt: startNow + leaseDurationMs
    }).ok
  ) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: repo lock for "${input.executorInput.repoPath}" was lost before finalization`
    };
  }
  if (
    workflowLease !== undefined &&
    !refreshAdvanceWorkflowLease(input.db, {
      workflowLease,
      heartbeatAt: startNow,
      expiresAt: startNow + leaseDurationMs
    }).ok
  ) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: managed-step lease for "${input.runId}" was lost before finalization`
    };
  }

  const dbPath = input.db.location();
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    return {
      ok: false,
      error:
        "advanceLiveWorkflowStep: file-backed database is required to heartbeat repo lock during finalization"
    };
  }

  const wallClockStartedAt = Date.now();
  const workerHeartbeat = startAdvanceRepoLockHeartbeatWorker({
    dbPath,
    repoLock: repoLock.lock,
    workflowLease,
    startNow,
    wallClockStartedAt,
    leaseDurationMs
  });
  const assertFresh = (): { ok: true } | { ok: false; error: string } => {
    const heartbeatAt =
      startNow + Math.max(0, Date.now() - wallClockStartedAt);
    if (
      !refreshAdvanceRepoLockWithRetry(input.db, {
        repoLock: repoLock.lock,
        heartbeatAt,
        leaseExpiresAt: heartbeatAt + leaseDurationMs
      }).ok
    ) {
      return {
        ok: false,
        error: `advanceLiveWorkflowStep: repo lock for "${input.executorInput.repoPath}" was lost during finalization`
      };
    }
    if (
      workflowLease !== undefined &&
      !refreshAdvanceWorkflowLeaseWithRetry(input.db, {
        workflowLease,
        heartbeatAt,
        expiresAt: heartbeatAt + leaseDurationMs
      }).ok
    ) {
      return {
        ok: false,
        error: `advanceLiveWorkflowStep: managed-step lease for "${input.runId}" was lost during finalization`
      };
    }
    return { ok: true };
  };

  return {
    ok: true,
    heartbeat: {
      stop: workerHeartbeat.stop,
      assertFresh
    }
  };
}

function getAdvanceRepoLock(
  db: MomentumDb,
  input: { runId: string; repoPath: string; holder: string; now: number }
):
  | { ok: true; lock: AdvanceRepoLock }
  | { ok: false; error: string } {
  const run = db
    .prepare(
      `SELECT repo_path AS repoPath,
              goal_id AS goalId
         FROM workflow_runs
        WHERE id = ?`
    )
    .get(input.runId) as
    | { repoPath: string | null; goalId: string | null }
    | undefined;
  if (run === undefined) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: workflow run not found "${input.runId}"`
    };
  }
  if (run.repoPath !== input.repoPath) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: executor repo "${input.repoPath}" does not match workflow run repo "${run.repoPath ?? ""}"`
    };
  }
  if (run.goalId === null) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: workflow_runs.goal_id is required for finalization of run "${input.runId}"`
    };
  }
  const row = db
    .prepare(
      `SELECT id, holder, goal_id AS goalId, lease_expires_at AS leaseExpiresAt
         FROM repo_locks
        WHERE repo_root = ?
          AND goal_id = ?
          AND state = 'active'
        ORDER BY acquired_at DESC, id DESC
        LIMIT 1`
    )
    .get(input.repoPath, run.goalId) as
    | { id: string; holder: string; goalId: string; leaseExpiresAt: number }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: workflow finalization requires an active repo lock for "${input.repoPath}" and goal "${run.goalId}"`
    };
  }
  if (row.leaseExpiresAt <= input.now) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: repo lock for "${input.repoPath}" expired before finalization`
    };
  }
  if (row.holder !== input.holder) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: repo lock for "${input.repoPath}" is held by "${row.holder}", not "${input.holder}"`
    };
  }
  return {
    ok: true,
    lock: {
      id: row.id,
      repoPath: input.repoPath,
      holder: row.holder,
      goalId: row.goalId,
      leaseExpiresAt: row.leaseExpiresAt
    }
  };
}

function resolveAdvanceLeaseDurationMs(
  db: MomentumDb,
  input: {
    workflowLease:
      | {
          runId: string;
          leaseKind: WorkflowLeaseKind;
          holder: string;
          acquiredAt: number;
        }
      | undefined;
    repoLock: AdvanceRepoLock;
    fallbackLeaseExpiresAt: number;
    now: number;
  }
): number {
  const expiresAtCandidates = [
    input.fallbackLeaseExpiresAt,
    input.repoLock.leaseExpiresAt
  ];
  if (input.workflowLease !== undefined) {
    const row = db
      .prepare(
        `SELECT expires_at AS expiresAt
           FROM workflow_leases
          WHERE run_id = ?
            AND lease_kind = ?
            AND holder = ?
            AND acquired_at = ?
            AND released_at IS NULL`
      )
      .get(
        input.workflowLease.runId,
        input.workflowLease.leaseKind,
        input.workflowLease.holder,
        input.workflowLease.acquiredAt
      ) as { expiresAt: number } | undefined;
    if (row !== undefined) expiresAtCandidates.push(row.expiresAt);
  }
  return Math.max(
    1,
    Math.max(...expiresAtCandidates) - input.now
  );
}

function refreshAdvanceWorkflowLease(
  db: MomentumDb,
  input: {
    workflowLease: {
      runId: string;
      leaseKind: WorkflowLeaseKind;
      holder: string;
      acquiredAt: number;
    };
    heartbeatAt: number;
    expiresAt: number;
  }
): { ok: boolean } {
  return heartbeatWorkflowLease(db, {
    runId: input.workflowLease.runId,
    leaseKind: input.workflowLease.leaseKind,
    holder: input.workflowLease.holder,
    acquiredAt: input.workflowLease.acquiredAt,
    heartbeatAt: input.heartbeatAt,
    expiresAt: input.expiresAt
  });
}

function refreshAdvanceWorkflowLeaseWithRetry(
  db: MomentumDb,
  input: {
    workflowLease: {
      runId: string;
      leaseKind: WorkflowLeaseKind;
      holder: string;
      acquiredAt: number;
    };
    heartbeatAt: number;
    expiresAt: number;
  }
): { ok: boolean } {
  const retryUntil = Date.now() + 1_000;
  for (;;) {
    try {
      return refreshAdvanceWorkflowLease(db, input);
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= retryUntil) return { ok: false };
      sleepMs(10);
    }
  }
}

function refreshAdvanceRepoLock(
  db: MomentumDb,
  input: {
    repoLock: AdvanceRepoLock;
    heartbeatAt: number;
    leaseExpiresAt: number;
  }
): { ok: boolean } {
  const result = db
    .prepare(
      `UPDATE repo_locks
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
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

function refreshAdvanceRepoLockWithRetry(
  db: MomentumDb,
  input: {
    repoLock: AdvanceRepoLock;
    heartbeatAt: number;
    leaseExpiresAt: number;
  }
): { ok: boolean } {
  const retryUntil = Date.now() + 1_000;
  for (;;) {
    try {
      return refreshAdvanceRepoLock(db, input);
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= retryUntil) return { ok: false };
      sleepMs(10);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  return error instanceof Error && /database is locked/i.test(error.message);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startAdvanceRepoLockHeartbeatWorker(input: {
  dbPath: string;
  repoLock: AdvanceRepoLock;
  workflowLease: {
    runId: string;
    leaseKind: WorkflowLeaseKind;
    holder: string;
    acquiredAt: number;
  } | undefined;
  startNow: number;
  wallClockStartedAt: number;
  leaseDurationMs: number;
}): {
  stop: () => { ok: boolean; error?: string };
} {
  const heartbeatIntervalMs = Math.max(
    1,
    Math.floor(input.leaseDurationMs / 2)
  );
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const controlView = new Int32Array(control);
  const worker = new Worker(ADVANCE_REPO_LOCK_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath: input.dbPath,
      repoLock: input.repoLock,
      workflowLease: input.workflowLease ?? null,
      startNow: input.startNow,
      wallClockStartedAt: input.wallClockStartedAt,
      leaseDurationMs: input.leaseDurationMs,
      heartbeatIntervalMs,
      control
    }
  });
  worker.on("error", () => {
    Atomics.store(controlView, 0, 3);
    Atomics.notify(controlView, 0);
  });
  worker.unref();
  const failed = (): { ok: false; error: string } => ({
    ok: false,
    error: `advanceLiveWorkflowStep: repo lock heartbeat failed for "${input.repoLock.repoPath}"`
  });

  return {
    stop: () => {
      if (Atomics.load(controlView, 0) === 3) return failed();
      if (Atomics.load(controlView, 0) !== 2) {
        Atomics.store(controlView, 0, 1);
        Atomics.notify(controlView, 0);
        Atomics.wait(controlView, 0, 1, 1_000);
      }
      if (Atomics.load(controlView, 0) === 3) return failed();
      return { ok: true };
    }
  };
}

function completeDeferredStep(
  input: AdvanceLiveWorkflowStepInput,
  run: RunLiveWorkflowStepOutcome,
  failure: { outcome: string; message: string }
): RunLiveWorkflowStepOutcome {
  if (run.deferredTerminalState === undefined) return run;

  return runInImmediateTransaction(input.db, () => {
    const state =
      run.deferredTerminalState === "succeeded" && failure.outcome === "committed"
        ? "succeeded"
        : "failed";
    const useDispatchFailure =
      failure.outcome === "reset_step_failure" &&
      run.dispatch?.ok === true &&
      run.deferredTerminalState === "failed";
    const useDispatchError =
      failure.outcome === "dispatch_error" && run.dispatch?.ok === false;
    const finish: WorkflowStepTransitionOutcome = finishWorkflowStep(input.db, {
      runId: input.runId,
      stepId: input.stepId,
      state,
      errorCode:
        state === "succeeded"
          ? null
          : useDispatchFailure && run.dispatch?.ok === true
            ? run.dispatch.result.errorCode
            : useDispatchError && run.dispatch?.ok === false
              ? run.dispatch.code
              : `live_finalize_${failure.outcome}`,
      errorMessage:
        state === "succeeded"
          ? null
          : useDispatchFailure && run.dispatch?.ok === true
            ? run.dispatch.result.errorMessage
            : useDispatchError && run.dispatch?.ok === false
              ? run.dispatch.error
              : failure.message,
      resultDigest:
        (state === "succeeded" || useDispatchFailure) && run.dispatch?.ok === true
          ? run.dispatch.result.resultDigest
          : null,
      ...(input.now !== undefined ? { now: input.now } : {})
    });

    const lease = run.deferredLease;
    const released =
      finish.ok && lease !== undefined && lease.releasedAt === null
        ? releaseWorkflowLease(input.db, {
            runId: input.runId,
            leaseKind: lease.leaseKind,
            holder: lease.holder,
            acquiredAt: lease.acquiredAt,
            ...(input.now !== undefined ? { now: input.now } : {})
          })
        : { ok: false };
    refreshWorkflowRunStateAfterLiveStep(input.db, {
      runId: input.runId,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    const {
      deferredTerminalState: _deferred,
      deferredLease: _deferredLease,
      ...settledRun
    } = run;

    return {
      ...settledRun,
      ok: state === "succeeded" && finish.ok && released.ok,
      lease: { ...run.lease, released: released.ok },
      finish,
      terminalState: state
    };
  });
}

function reconcileFinalizeStepState(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    finalize: FinalizeLiveWorkflowStepFromResultFileResult;
    now?: number;
  }
): void {
  if (input.finalize.outcome === "committed") return;
  reconcileFinalizeStepFailure(db, {
    runId: input.runId,
    stepId: input.stepId,
    outcome: input.finalize.outcome,
    message: describeFinalizeFailure(input.finalize),
    ...(input.now !== undefined ? { now: input.now } : {})
  });
}

function reconcileFinalizeStepFailure(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    outcome: string;
    message: string;
    now?: number;
  }
): void {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE workflow_steps
       SET state = 'failed',
           error_code = ?,
           error_message = ?,
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
     WHERE run_id = ?
       AND step_id = ?
       AND state = 'succeeded'`
  ).run(
    `live_finalize_${input.outcome}`,
    input.message,
    now,
    now,
    input.runId,
    input.stepId
  );
}

function runInImmediateTransaction<T>(db: MomentumDb, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function refreshWorkflowRunStateAfterLiveStep(
  db: MomentumDb,
  input: { runId: string; now?: number }
): void {
  const now = input.now ?? Date.now();
  const stepRecords = loadWorkflowStepRecords(db, input.runId);
  const leaseRecords = loadWorkflowLeaseRecords(db, input.runId);
  const runState = deriveWorkflowRunState(stepRecords, {
    leases: leaseRecords,
    now
  });
  const finishedAt = isTerminalRunState(runState) ? now : null;
  db.prepare(
    `UPDATE workflow_runs
       SET state = ?,
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
     WHERE id = ?`
  ).run(runState, finishedAt, now, input.runId);
}

function loadWorkflowStepRecords(
  db: MomentumDb,
  runId: string
): WorkflowStepRecord[] {
  const rows = db
    .prepare(
      `SELECT step_id, kind, state, step_order, required
         FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_order, step_id`
    )
    .all(runId) as Array<{
    step_id: string;
    kind: string;
    state: string;
    step_order: number;
    required: number;
  }>;
  return rows.map((row) => ({
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    state: row.state as WorkflowStepState,
    order: row.step_order,
    required: row.required === 1
  }));
}

function loadWorkflowLeaseRecords(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, released_at, stale_policy
         FROM workflow_leases
        WHERE run_id = ?
        ORDER BY lease_kind`
    )
    .all(runId) as Array<{
    run_id: string;
    lease_kind: string;
    holder: string;
    acquired_at: number;
    expires_at: number;
    heartbeat_at: number;
    released_at: number | null;
    stale_policy: string;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    leaseKind: row.lease_kind as WorkflowLeaseRecord["leaseKind"],
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseRecord["stalePolicy"]
  }));
}

function describeFinalizeFailure(
  finalize: FinalizeLiveWorkflowStepFromResultFileResult
): string {
  switch (finalize.outcome) {
    case "reset_step_failure":
      return "live workflow step reported failure and its worktree changes were reset";
    case "reset_verification_failure":
      return finalize.verification.error;
    case "manual_recovery_required":
      return finalize.reason;
    case "reset_failed":
      return finalize.reset.error;
    case "commit_failed":
      return finalize.commit.error;
    case "git_failed":
      return finalize.error;
    case "repo_lock_lost":
      return finalize.error;
    case "invalid_input":
      return finalize.error;
    case "result_missing":
      return finalize.error;
    case "result_invalid":
      return finalize.error;
    case "committed":
      return "live workflow step committed";
  }
}

const ADVANCE_REPO_LOCK_HEARTBEAT_WORKER_SOURCE = `
const { DatabaseSync } = require("node:sqlite");
const { workerData } = require("node:worker_threads");

const control = new Int32Array(workerData.control);

try {
  let db;
  let repoLockStatement;
  let workflowLeaseStatement;

  function closeDb() {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
      }
      db = undefined;
      repoLockStatement = undefined;
      workflowLeaseStatement = undefined;
    }
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

  function getWorkflowLeaseStatement() {
    if (workflowLeaseStatement !== undefined) return workflowLeaseStatement;
    if (db === undefined) db = new DatabaseSync(workerData.dbPath);
    workflowLeaseStatement = db.prepare(
      \`UPDATE workflow_leases
         SET heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE run_id = ?
         AND lease_kind = ?
         AND holder = ?
         AND acquired_at = ?
         AND released_at IS NULL
         AND expires_at >= ?\`
    );
    return workflowLeaseStatement;
  }

  try {
    function heartbeat() {
      const now =
        workerData.startNow +
        Math.max(0, Date.now() - workerData.wallClockStartedAt);
      try {
        const leaseExpiresAt = now + workerData.leaseDurationMs;
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
        if (workerData.workflowLease !== null) {
          const workflowResult = getWorkflowLeaseStatement().run(
            now,
            leaseExpiresAt,
            now,
            workerData.workflowLease.runId,
            workerData.workflowLease.leaseKind,
            workerData.workflowLease.holder,
            workerData.workflowLease.acquiredAt,
            now
          );
          if (Number(workflowResult.changes) === 0) return false;
        }
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
  if (Atomics.load(control, 0) !== 3) {
    Atomics.store(control, 0, 2);
  }
  Atomics.notify(control, 0);
}
`;
