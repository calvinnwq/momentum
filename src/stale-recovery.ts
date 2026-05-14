import type { MomentumDb } from "./db.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "./events.js";
import {
  getQueueJob,
  type QueueJobRow,
  type QueueJobState
} from "./queue-jobs.js";
import {
  listStaleRepoLocks,
  releaseRepoLock,
  type RepoLockRow
} from "./repo-locks.js";

/**
 * `recovery_status` written onto repo_locks when this slice auto-releases an
 * orphaned lock because the owning job is already terminal. Stable string so
 * downstream surfaces (status / handoff / events) can recognise the cause.
 */
export const REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS =
  "auto_released_job_terminal";

const TERMINAL_JOB_STATES: ReadonlySet<QueueJobState> = new Set([
  "succeeded",
  "failed"
]);

export type StaleRepoLockSkipReason =
  | "job_pending"
  | "job_claimed"
  | "job_running"
  | "job_missing";

export type StaleRepoLockRecoveryRecovered = {
  lock: RepoLockRow;
  job: QueueJobRow;
  recoveryStatus: typeof REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS;
};

export type StaleRepoLockRecoverySkipped = {
  lock: RepoLockRow;
  job: QueueJobRow | null;
  reason: StaleRepoLockSkipReason;
};

export type RecoverStaleRepoLocksInput = {
  now?: number;
  graceMs?: number;
};

export type RecoverStaleRepoLocksResult = {
  recovered: StaleRepoLockRecoveryRecovered[];
  skipped: StaleRepoLockRecoverySkipped[];
};

/**
 * Auto-release repo locks whose lease has expired AND whose owning job is in a
 * terminal state (succeeded/failed). These locks are definitionally orphaned
 * bookkeeping: the job has finished, no live worker can lose intent, and no
 * active work is being duplicated. Locks whose owning job is still pending /
 * claimed / running / missing are left untouched and reported as `skipped`
 * with a stable reason so a later slice (or a human operator) can route them
 * through manual recovery.
 *
 * Idempotent: a second call finds nothing to release because released locks
 * are filtered out by `listStaleRepoLocks` (state = 'active') and returns
 * `{ recovered: [], skipped: [] }`. Emits one `repo_lock.recovered` event per
 * actual release so handoff / status / log surfaces can observe the recovery.
 */
export function recoverStaleRepoLocksForTerminalJobs(
  db: MomentumDb,
  input: RecoverStaleRepoLocksInput = {}
): RecoverStaleRepoLocksResult {
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? 0;
  const staleLocks = listStaleRepoLocks(db, { now, graceMs });

  const recovered: StaleRepoLockRecoveryRecovered[] = [];
  const skipped: StaleRepoLockRecoverySkipped[] = [];

  for (const lock of staleLocks) {
    const job = getQueueJob(db, lock.job_id);
    if (!job) {
      skipped.push({ lock, job: null, reason: "job_missing" });
      continue;
    }
    if (!TERMINAL_JOB_STATES.has(job.state)) {
      skipped.push({ lock, job, reason: skipReasonForJobState(job.state) });
      continue;
    }
    const released = releaseRepoLock(db, {
      lockId: lock.id,
      now,
      recoveryStatus: REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
    });
    if (!released.ok) {
      // Race: another caller released the lock between listing and update.
      // Don't double-emit; just drop it out of the result.
      continue;
    }
    appendQueueEvent(db, {
      goalId: lock.goal_id,
      jobId: lock.job_id,
      type: QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED,
      payload: {
        lock_id: lock.id,
        repo_root: lock.repo_root,
        holder: lock.holder,
        iteration: lock.iteration,
        lease_expires_at: lock.lease_expires_at,
        recovered_at: now,
        recovery_status: REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
        owning_job_state: job.state
      },
      createdAt: now
    });
    recovered.push({
      lock,
      job,
      recoveryStatus: REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
    });
  }

  return { recovered, skipped };
}

function skipReasonForJobState(state: QueueJobState): StaleRepoLockSkipReason {
  switch (state) {
    case "pending":
      return "job_pending";
    case "claimed":
      return "job_claimed";
    case "running":
      return "job_running";
    case "succeeded":
    case "failed":
      // Should never reach here — caller guards on TERMINAL_JOB_STATES first.
      throw new Error(
        `skipReasonForJobState: terminal state ${state} reached non-terminal branch`
      );
  }
}
