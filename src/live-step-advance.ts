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
 * into a clean terminal state from a *normalized* dispatch result —
 * `dispatch.ok === true` and the terminal step state was durably persisted
 * (`finish.ok === true`). That gate is the boundary between the two recovery
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
 *     `result_missing`, masking the precise cause, so this seam leaves it to the
 *     run loop and never touches the worktree.
 *
 * Likewise, a step that never settled (a start refusal, or an ambiguous
 * in-flight finish where the lease was intentionally left outstanding) is not
 * finalized: there is no trustworthy terminal state and the repo lock may have
 * been lost, so mutating git would be unsafe. Those outcomes are returned
 * verbatim for the monitor / recovery layer.
 *
 * Durable mutations stay in the composed primitives, except for the final
 * reconciliation that marks a previously successful step failed when the git
 * transaction did not produce an accepted Momentum commit.
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
  persistLiveWorkflowFinalizeRecovery,
  type PersistLiveWorkflowFinalizeRecoveryResult
} from "./live-step-run-recovery.js";
import type { WorkflowLeaseStalePolicy } from "./workflow-run-reducer.js";
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
  /** The durable recovery reconciliation outcome; present iff `finalized`. */
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
    ...(input.now !== undefined ? { now: input.now } : {})
  });

  // The git + verification transaction runs only for a step that settled into a
  // clean terminal state from a normalized dispatch result. A process-level
  // dispatch error already carries a precise live recovery code, and an
  // unsettled finish leaves an ambiguous repo lock — neither is safe to mutate.
  const dispatch = run.dispatch;
  if (dispatch === undefined || !dispatch.ok || run.finish?.ok !== true) {
    return { committed: false, finalized: false, run };
  }

  const repoLockHeartbeat = startAdvanceRepoLockHeartbeat(input);
  if (!repoLockHeartbeat.ok) {
    reconcileFinalizeStepFailure(input.db, {
      runId: input.runId,
      stepId: input.stepId,
      outcome: "repo_lock_lost",
      message: repoLockHeartbeat.error,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    return { committed: false, finalized: false, run };
  }

  let finalize: FinalizeLiveWorkflowStepFromResultFileResult;
  try {
    finalize = finalizeLiveWorkflowStepFromResultFile({
      repoPath: input.executorInput.repoPath,
      baseHead: input.baseHead,
      resultFilePath: dispatch.resultJsonPath,
      verificationCommands: input.verificationCommands,
      verificationTimeoutSec: input.verificationTimeoutSec,
      verificationLogPath: input.verificationLogPath
    });
  } finally {
    repoLockHeartbeat.heartbeat.stop();
  }

  reconcileFinalizeStepState(input.db, {
    runId: input.runId,
    stepId: input.stepId,
    finalize,
    ...(input.now !== undefined ? { now: input.now } : {})
  });

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

  return {
    committed: finalize.outcome === "committed",
    finalized: true,
    run,
    finalize,
    recovery
  };
}

type AdvanceRepoLockHeartbeat =
  | { ok: true; heartbeat: { stop: () => void } }
  | { ok: false; error: string };

type AdvanceRepoLock = {
  id: string;
  repoPath: string;
  holder: string;
  goalId: string;
};

function startAdvanceRepoLockHeartbeat(
  input: AdvanceLiveWorkflowStepInput
): AdvanceRepoLockHeartbeat {
  const startNow = input.now ?? Date.now();
  const repoLock = getAdvanceRepoLock(input.db, {
    repoPath: input.executorInput.repoPath,
    holder: input.holder,
    now: startNow
  });
  if (!repoLock.ok) return repoLock;

  const leaseDurationMs = Math.max(1, input.leaseExpiresAt - startNow);
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

  const dbPath = input.db.location();
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    return {
      ok: false,
      error:
        "advanceLiveWorkflowStep: file-backed database is required to heartbeat repo lock during finalization"
    };
  }

  return {
    ok: true,
    heartbeat: startAdvanceRepoLockHeartbeatWorker({
      dbPath,
      repoLock: repoLock.lock,
      startNow,
      leaseDurationMs
    })
  };
}

function getAdvanceRepoLock(
  db: MomentumDb,
  input: { repoPath: string; holder: string; now: number }
):
  | { ok: true; lock: AdvanceRepoLock }
  | { ok: false; error: string } {
  const row = db
    .prepare(
      `SELECT id, holder, goal_id AS goalId, lease_expires_at AS leaseExpiresAt
         FROM repo_locks
        WHERE repo_root = ?
          AND state = 'active'
        ORDER BY acquired_at DESC, id DESC
        LIMIT 1`
    )
    .get(input.repoPath) as
    | { id: string; holder: string; goalId: string; leaseExpiresAt: number }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      error: `advanceLiveWorkflowStep: workflow finalization requires an active repo lock for "${input.repoPath}"`
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
      goalId: row.goalId
    }
  };
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

function startAdvanceRepoLockHeartbeatWorker(input: {
  dbPath: string;
  repoLock: AdvanceRepoLock;
  startNow: number;
  leaseDurationMs: number;
}): { stop: () => void } {
  const heartbeatIntervalMs = Math.max(1, Math.floor(input.leaseDurationMs / 2));
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const controlView = new Int32Array(control);
  const worker = new Worker(ADVANCE_REPO_LOCK_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath: input.dbPath,
      repoLock: input.repoLock,
      startNow: input.startNow,
      wallClockStartedAt: Date.now(),
      leaseDurationMs: input.leaseDurationMs,
      heartbeatIntervalMs,
      control
    }
  });
  worker.on("error", () => {
    Atomics.store(controlView, 0, 2);
    Atomics.notify(controlView, 0);
  });
  worker.unref();

  return {
    stop: () => {
      if (Atomics.load(controlView, 0) !== 2) {
        Atomics.store(controlView, 0, 1);
        Atomics.notify(controlView, 0);
        Atomics.wait(controlView, 0, 1, 1_000);
      }
    }
  };
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
  let statement;

  function closeDb() {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
      }
      db = undefined;
      statement = undefined;
    }
  }

  function getStatement() {
    if (statement !== undefined) return statement;
    if (db === undefined) db = new DatabaseSync(workerData.dbPath);
    statement = db.prepare(
      \`UPDATE repo_locks
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND repo_root = ?
         AND holder = ?
         AND goal_id = ?
         AND state = 'active'
         AND lease_expires_at >= ?\`
    );
    return statement;
  }

  try {
    function heartbeat() {
      const now =
        workerData.startNow +
        Math.max(0, Date.now() - workerData.wallClockStartedAt);
      try {
        const leaseExpiresAt = now + workerData.leaseDurationMs;
        const result = getStatement().run(
          now,
          leaseExpiresAt,
          now,
          workerData.repoLock.id,
          workerData.repoLock.repoPath,
          workerData.repoLock.holder,
          workerData.repoLock.goalId,
          now
        );
        return Number(result.changes) > 0;
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
