import type { MomentumDb } from "./db.js";
import {
  getActiveDaemonRunForJob,
  type DaemonRunRow
} from "./daemon-runs.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "./events.js";
import {
  getQueueJob,
  listStaleClaimedGoalIterationJobs,
  recoverStaleClaimedGoalIterationJob,
  type QueueJobRow,
  type QueueJobState
} from "./queue-jobs.js";
import {
  getActiveRepoLockForJob,
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

/**
 * `recovery_status` stamped on the job.recovered event payload when this slice
 * re-pends an orphaned stale claim. Stable string so downstream surfaces
 * (status / handoff / event log) can recognise the cause.
 */
export const JOB_RECOVERED_AUTO_REPENDED_STATUS = "auto_repended_stale_claim";

export type StaleClaimedJobSkipReason =
  | "job_running"
  | "daemon_active"
  | "lock_active"
  | "job_state_changed";

export type StaleClaimedJobRecoveryRecovered = {
  jobBefore: QueueJobRow;
  jobAfter: QueueJobRow;
  previousWorkerId: string | null;
  previousLeaseExpiresAt: number | null;
  recoveryStatus: typeof JOB_RECOVERED_AUTO_REPENDED_STATUS;
};

export type StaleClaimedJobRecoverySkipped = {
  job: QueueJobRow;
  reason: StaleClaimedJobSkipReason;
  blockingDaemonRunId?: string;
  blockingLockId?: string;
};

export type RecoverStaleClaimedGoalIterationJobsInput = {
  now?: number;
  graceMs?: number;
};

export type RecoverStaleClaimedGoalIterationJobsResult = {
  recovered: StaleClaimedJobRecoveryRecovered[];
  skipped: StaleClaimedJobRecoverySkipped[];
};

/**
 * Re-pend stale `claimed` goal_iteration jobs whose lease has expired AND that
 * are not asserted by a live owner. A re-pended job becomes a clean candidate
 * for the next worker without losing intent: `attempt_count` is preserved, the
 * idempotency key is preserved, and the job remains routed to the same goal.
 *
 * Safety guards (any failing → skipped, never re-pended):
 *   - `state = 'running'` → repo writes may have happened; route to manual
 *     recovery via `job_running`. M3-05 keeps dirty/unknown states out of the
 *     auto-recovery path.
 *   - An active daemon record has `active_job_id = job.id` → live owner;
 *     skipped with `daemon_active` (terminal-state daemons do NOT block).
 *   - An active repo lock references `job.id` → releasing the lock is a more
 *     dangerous recovery action handled by lock-side primitives or manual
 *     recovery; skipped with `lock_active`.
 *
 * Idempotent: after a successful recovery the job is `pending` so a second
 * pass over `listStaleClaimedGoalIterationJobs` no longer returns it. Emits
 * one `job.recovered` event per actual re-pend so status / handoff / log
 * surfaces can observe the action.
 */
export function recoverStaleClaimedGoalIterationJobs(
  db: MomentumDb,
  input: RecoverStaleClaimedGoalIterationJobsInput = {}
): RecoverStaleClaimedGoalIterationJobsResult {
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? 0;
  const staleJobs = listStaleClaimedGoalIterationJobs(db, { now, graceMs });

  const recovered: StaleClaimedJobRecoveryRecovered[] = [];
  const skipped: StaleClaimedJobRecoverySkipped[] = [];

  for (const job of staleJobs) {
    if (job.state === "running") {
      skipped.push({ job, reason: "job_running" });
      continue;
    }

    const owningDaemon: DaemonRunRow | undefined = getActiveDaemonRunForJob(
      db,
      job.id
    );
    if (owningDaemon) {
      skipped.push({
        job,
        reason: "daemon_active",
        blockingDaemonRunId: owningDaemon.id
      });
      continue;
    }

    const owningLock = getActiveRepoLockForJob(db, job.id);
    if (owningLock) {
      skipped.push({
        job,
        reason: "lock_active",
        blockingLockId: owningLock.id
      });
      continue;
    }

    const repended = recoverStaleClaimedGoalIterationJob(db, {
      jobId: job.id,
      now
    });
    if (!repended.ok) {
      // Race: another caller transitioned the job between listing and update,
      // or the lease was refreshed concurrently. Drop it from the result so we
      // do not emit a recovery event for a state we no longer observe.
      skipped.push({ job, reason: "job_state_changed" });
      continue;
    }

    appendQueueEvent(db, {
      goalId: job.goal_id,
      jobId: job.id,
      type: QUEUE_EVENT_TYPES.JOB_RECOVERED,
      payload: {
        iteration: job.iteration,
        previous_state: "claimed",
        previous_worker_id: repended.previousWorkerId,
        previous_lease_expires_at: repended.previousLeaseExpiresAt,
        attempt_count: repended.job.attempt_count,
        recovered_at: now,
        recovery_status: JOB_RECOVERED_AUTO_REPENDED_STATUS
      },
      createdAt: now
    });

    recovered.push({
      jobBefore: job,
      jobAfter: repended.job,
      previousWorkerId: repended.previousWorkerId,
      previousLeaseExpiresAt: repended.previousLeaseExpiresAt,
      recoveryStatus: JOB_RECOVERED_AUTO_REPENDED_STATUS
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
