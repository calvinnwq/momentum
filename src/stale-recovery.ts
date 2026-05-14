import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { resolveGoalArtifactPaths } from "./artifacts.js";
import type { MomentumDb } from "./db.js";
import {
  DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS,
  getActiveDaemonRunForJob,
  listStaleDaemonRuns,
  recoverStaleDaemonRun,
  type DaemonRunRow
} from "./daemon-runs.js";
import { QUEUE_EVENT_TYPES, appendQueueEvent } from "./events.js";
import { getGoal, type GoalRow } from "./goal-init.js";
import { markGoalNeedsManualRecovery } from "./goal-recovery.js";
import {
  getQueueJob,
  listStaleClaimedGoalIterationJobs,
  recoverStaleClaimedGoalIterationJob,
  type QueueJobRow,
  type QueueJobState
} from "./queue-jobs.js";
import {
  writeRecoveryArtifact,
  type RecoveryArtifactPathBundle,
  type RecoveryArtifactReason
} from "./recovery-artifact.js";
import { inspectRepo, type RepoGuardResult } from "./repo-guard.js";
import {
  getActiveRepoLockForJob,
  listStaleRepoLocks,
  releaseRepoLock,
  type RepoLockRow
} from "./repo-locks.js";

/**
 * Inspects the working tree at `repoRoot` so the auto-recovery primitive can
 * refuse to re-pend a stale claim when the repo is dirty, has no resolvable
 * HEAD, or otherwise cannot be verified safe. Default implementation is
 * `inspectRepo` from repo-guard; tests inject a stub to avoid touching the
 * filesystem.
 */
export type RepoStateInspector = (repoRoot: string) => RepoGuardResult;

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
  | "repo_dirty"
  | "repo_unknown_commit"
  | "repo_unavailable"
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
  /**
   * For `repo_dirty` / `repo_unknown_commit` / `repo_unavailable`: the
   * configured repo root that failed inspection. Surfaced so manual-recovery
   * operators see where to look without re-querying the goal.
   */
  repoRoot?: string;
  /**
   * For `repo_dirty` / `repo_unknown_commit` / `repo_unavailable`: the
   * inspector's error string verbatim so operators can reproduce the
   * classification without re-running `git status`.
   */
  repoInspectionError?: string;
  /**
   * Goal-scoped path to the `recovery.md` artifact written when this skip is
   * routed to manual recovery (only `repo_dirty` / `repo_unknown_commit` /
   * `repo_unavailable` / `job_running` and only when `dataDir` is provided).
   * Other skip reasons (`daemon_active` / `lock_active` / `job_state_changed`)
   * are live-owner / race classifications that do not need a manual artifact.
   */
  recoveryArtifactPath?: string;
};

export type RecoverStaleClaimedGoalIterationJobsInput = {
  now?: number;
  graceMs?: number;
  /**
   * Inspector used to verify the goal's repo is safe to re-pend onto. Defaults
   * to `inspectRepo` from repo-guard. Injectable so tests can simulate dirty /
   * unknown-commit / missing-repo states without a real filesystem.
   */
  inspectRepoState?: RepoStateInspector;
  /**
   * Momentum data dir. When provided, skips that route to manual recovery
   * (`repo_dirty` / `repo_unknown_commit` / `repo_unavailable` / `job_running`)
   * cause a goal-scoped `recovery.md` artifact to be written before the skip
   * is returned, so operators see why the daemon refused to auto-recover.
   * When omitted (e.g. read-only test paths) no artifact is written.
   */
  dataDir?: string;
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
  const inspectRepoState = input.inspectRepoState ?? inspectRepo;
  const dataDir = input.dataDir;
  const staleJobs = listStaleClaimedGoalIterationJobs(db, { now, graceMs });

  const recovered: StaleClaimedJobRecoveryRecovered[] = [];
  const skipped: StaleClaimedJobRecoverySkipped[] = [];

  for (const job of staleJobs) {
    if (job.state === "running") {
      const entry: StaleClaimedJobRecoverySkipped = {
        job,
        reason: "job_running"
      };
      maybeWriteRecoveryArtifact(db, dataDir, job, entry, {
        code: "job_running",
        message:
          "Stale claimed job is still in `running` state; the runner may have left mid-write artifacts in the repo."
      }, now);
      skipped.push(entry);
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

    const repoSkip = classifyRepoStateSkip(db, job, inspectRepoState);
    if (repoSkip) {
      maybeWriteRecoveryArtifact(db, dataDir, job, repoSkip, {
        code: repoSkip.reason,
        message:
          repoSkip.repoInspectionError ??
          `Repo state inspection failed with reason ${repoSkip.reason}.`
      }, now);
      skipped.push(repoSkip);
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

/**
 * `recovery_status` stamped on daemon_runs when this slice auto-finalizes an
 * idle stale daemon record. Re-exported from daemon-runs.ts so callers that
 * already import from stale-recovery have a single recognized status taxonomy.
 */
export const DAEMON_RUN_AUTO_RECOVERED_STATUS =
  DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS;

export type StaleDaemonRunSkipReason =
  | "self"
  | "active_job_present"
  | "active_lock_present"
  | "run_state_changed";

export type StaleDaemonRunRecoveryRecovered = {
  runBefore: DaemonRunRow;
  runAfter: DaemonRunRow;
  recoveryStatus: typeof DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS;
};

export type StaleDaemonRunRecoverySkipped = {
  run: DaemonRunRow;
  reason: StaleDaemonRunSkipReason;
  blockingJobId?: string;
  blockingLockId?: string;
};

export type RecoverStaleDaemonRunsInput = {
  now?: number;
  staleAfterMs: number;
  activeJobStaleAfterMs?: number;
  excludeRunId?: string;
};

export type RecoverStaleDaemonRunsResult = {
  recovered: StaleDaemonRunRecoveryRecovered[];
  skipped: StaleDaemonRunRecoverySkipped[];
};

/**
 * Auto-finalize idle stale daemon records to the `error` terminal state when
 * their heartbeat has crossed the stale cutoff AND they hold no live owner
 * pointer (`active_job_id` / `active_lock_id` both NULL). These records are
 * definitionally orphaned: a daemon process that exited without finalizing
 * leaves the row in `running` / `stop_requested` forever, which blocks fresh
 * `daemon start` invocations via the single-active partial index. Rows with
 * an `active_job_id` or `active_lock_id` are NOT touched here — those are
 * routed through the stale-claim and stale-lock primitives instead, or to
 * manual recovery via the `skipped` taxonomy.
 *
 * Safety guards:
 *   - `excludeRunId` filters out the caller's own active daemon so a startup
 *     pass run from inside a freshly registered daemon does not finalize
 *     itself before the loop starts.
 *   - `active_job_id` and `active_lock_id` must both be NULL on the daemon row
 *     at update time — concurrent writes from `setDaemonRunActiveJob` race-
 *     guard the helper at the SQL level.
 *   - Idempotent: a recovered run transitions to a terminal state and is no
 *     longer returned by `listStaleDaemonRuns`, so a second invocation finds
 *     nothing to recover.
 *
 * No queue event is emitted because the `events` schema requires a non-empty
 * `goal_id` and a daemon row with no active job has no goal pointer. The
 * recovery is recorded directly on the daemon_runs row via the
 * `recovery_status` column and the daemon's terminal state transition.
 */
export function recoverStaleDaemonRuns(
  db: MomentumDb,
  input: RecoverStaleDaemonRunsInput
): RecoverStaleDaemonRunsResult {
  if (
    !Number.isFinite(input.staleAfterMs) ||
    input.staleAfterMs <= 0
  ) {
    throw new Error(
      "recoverStaleDaemonRuns: staleAfterMs must be a positive number"
    );
  }
  const now = input.now ?? Date.now();
  const activeJobStaleAfterMs =
    input.activeJobStaleAfterMs ?? input.staleAfterMs;
  const stale = listStaleDaemonRuns(db, {
    now,
    staleAfterMs: input.staleAfterMs,
    activeJobStaleAfterMs
  });

  const recovered: StaleDaemonRunRecoveryRecovered[] = [];
  const skipped: StaleDaemonRunRecoverySkipped[] = [];

  for (const run of stale) {
    if (input.excludeRunId !== undefined && run.id === input.excludeRunId) {
      skipped.push({ run, reason: "self" });
      continue;
    }
    if (run.active_job_id !== null) {
      skipped.push({
        run,
        reason: "active_job_present",
        blockingJobId: run.active_job_id
      });
      continue;
    }
    if (run.active_lock_id !== null) {
      skipped.push({
        run,
        reason: "active_lock_present",
        blockingLockId: run.active_lock_id
      });
      continue;
    }

    const result = recoverStaleDaemonRun(db, {
      runId: run.id,
      now,
      recoveryStatus: DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
    });
    if (!result.ok) {
      // Race: another caller transitioned the row, or an active_job_id/
      // active_lock_id appeared between listing and update. Surface for
      // manual recovery rather than emitting a fact we no longer observe.
      skipped.push({ run, reason: "run_state_changed" });
      continue;
    }
    recovered.push({
      runBefore: run,
      runAfter: result.run,
      recoveryStatus: DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS
    });
  }

  return { recovered, skipped };
}

/**
 * Default heartbeat-age cutoffs used by `runStartupRecovery` when the caller
 * does not override them. Mirrors `DEFAULT_DAEMON_STALE_AFTER_MS` /
 * `DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS` in `daemon-status` so the startup
 * pass classifies the same rows as stale that the read-only inspector flags;
 * defined locally to avoid module coupling between recovery and inspection.
 */
export const DEFAULT_STARTUP_RECOVERY_DAEMON_STALE_AFTER_MS = 90_000;
export const DEFAULT_STARTUP_RECOVERY_DAEMON_ACTIVE_JOB_STALE_AFTER_MS = 930_000;

export type StartupRecoveryDaemonInput = {
  staleAfterMs?: number;
  activeJobStaleAfterMs?: number;
  excludeRunId?: string;
};

export type StartupRecoveryInput = {
  now?: number;
  graceMs?: number;
  daemonRuns?: StartupRecoveryDaemonInput;
  /**
   * Repo-state inspector forwarded to `recoverStaleClaimedGoalIterationJobs`
   * so dirty / unknown-commit / unavailable repos are refused even from the
   * daemon's startup pass. Defaults to the production `inspectRepo`.
   */
  inspectRepoState?: RepoStateInspector;
  /**
   * Momentum data dir. Forwarded to `recoverStaleClaimedGoalIterationJobs` so
   * manual-recovery skip paths can write a goal-scoped `recovery.md` artifact
   * during the daemon's startup pass. Omit in tests that only assert in-memory
   * shape and do not need the on-disk artifact.
   */
  dataDir?: string;
};

export type StartupRecoveryResult = {
  observedAt: number;
  graceMs: number;
  repoLocks: RecoverStaleRepoLocksResult;
  claimedJobs: RecoverStaleClaimedGoalIterationJobsResult;
  daemonRuns: RecoverStaleDaemonRunsResult;
};

/**
 * Composer that runs the safe stale-lease auto-recovery primitives in the order
 * the daemon startup path should: first release orphaned repo locks whose
 * owning job is terminal (so a re-pended job can be re-claimed without lock
 * contention), next re-pend stale claimed goal_iteration jobs that no live
 * owner asserts, and finally finalize orphaned idle daemon records so the
 * single-active partial index does not block a freshly registered daemon. All
 * three inner primitives are independently idempotent and skip dirty/unknown
 * states with stable reasons; this composer simply returns each result
 * unmodified so callers can surface combined counts and routing information
 * for manual recovery.
 *
 * Exposes one observed `now` and `graceMs` so a single startup pass produces a
 * coherent snapshot. Callers that need a different cadence can pass their own
 * `now`/`graceMs`, or invoke the underlying primitives directly. Daemon
 * recovery uses defaults that match the read-only `daemon status` inspector;
 * callers should pass `daemonRuns.excludeRunId` to skip the caller's own run
 * so a startup pass run from inside a freshly registered daemon does not
 * finalize itself before the loop starts.
 */
export function runStartupRecovery(
  db: MomentumDb,
  input: StartupRecoveryInput = {}
): StartupRecoveryResult {
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? 0;
  const repoLocks = recoverStaleRepoLocksForTerminalJobs(db, { now, graceMs });
  const claimedJobs = recoverStaleClaimedGoalIterationJobs(db, {
    now,
    graceMs,
    ...(input.inspectRepoState !== undefined
      ? { inspectRepoState: input.inspectRepoState }
      : {}),
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {})
  });
  const daemonInput = input.daemonRuns ?? {};
  const daemonRuns = recoverStaleDaemonRuns(db, {
    now,
    staleAfterMs:
      daemonInput.staleAfterMs ??
      DEFAULT_STARTUP_RECOVERY_DAEMON_STALE_AFTER_MS,
    activeJobStaleAfterMs:
      daemonInput.activeJobStaleAfterMs ??
      DEFAULT_STARTUP_RECOVERY_DAEMON_ACTIVE_JOB_STALE_AFTER_MS,
    ...(daemonInput.excludeRunId !== undefined
      ? { excludeRunId: daemonInput.excludeRunId }
      : {})
  });
  return {
    observedAt: now,
    graceMs,
    repoLocks,
    claimedJobs,
    daemonRuns
  };
}

/**
 * Map an `inspectRepo` failure code onto the auto-recovery skip taxonomy.
 * Returns `null` when the inspector reports `ok: true` OR when the goal has no
 * configured repo (the worker handles the no-repo case via fail-fast release,
 * so leaving the claim re-pendable is strictly safer than stranding it).
 *
 * - `dirty_worktree` → `repo_dirty`: previous worker may have left in-progress
 *   writes; re-pending would either lose those writes or have the next worker
 *   bail via repo-guard. Route to manual recovery.
 * - `no_head` → `repo_unknown_commit`: HEAD is unresolvable so we cannot
 *   reason about the baseline state. Route to manual recovery.
 * - `missing` / `not_a_directory` / `not_a_git_repo` / `git_failed` →
 *   `repo_unavailable`: the configured repo cannot be inspected. Route to
 *   manual recovery rather than re-pend onto a path we cannot verify.
 */
function classifyRepoStateSkip(
  db: MomentumDb,
  job: QueueJobRow,
  inspectRepoState: RepoStateInspector
): StaleClaimedJobRecoverySkipped | null {
  const goal = getGoal(db, job.goal_id);
  const repoRoot = goal?.repo;
  if (!repoRoot) return null;
  const inspection = inspectRepoState(repoRoot);
  if (inspection.ok) return null;
  const reason: StaleClaimedJobSkipReason =
    inspection.code === "dirty_worktree"
      ? "repo_dirty"
      : inspection.code === "no_head"
        ? "repo_unknown_commit"
        : "repo_unavailable";
  return {
    job,
    reason,
    repoRoot,
    repoInspectionError: inspection.error
  };
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

/**
 * Per-reason operator hints for the `recovery.md` artifact written when a
 * stale claim is routed to manual recovery. Stable lists so operators get a
 * predictable next-action surface across runs.
 */
function safeNextStepsForSkip(
  reason: StaleClaimedJobSkipReason,
  repoRoot: string | null
): string[] {
  const repoHint = repoRoot ? shellQuote(repoRoot) : "<repo>";
  switch (reason) {
    case "repo_dirty":
      return [
        `Inspect the working tree with \`git -C ${repoHint} status\`.`,
        "Resolve the dirty state (commit, stash, or discard intended changes).",
        "Once the worktree is clean, re-run `momentum daemon start` to retry."
      ];
    case "repo_unknown_commit":
      return [
        `Inspect the repo with \`git -C ${repoHint} status\` and \`git -C ${repoHint} log -1\`.`,
        "Ensure HEAD resolves to a commit (the repo may be empty or detached).",
        "Once HEAD is resolvable, re-run `momentum daemon start` to retry."
      ];
    case "repo_unavailable":
      return [
        `Verify the repo path exists and is a git repository: \`${repoHint}\`.`,
        "Fix the path / permissions, or update the goal spec to point at a valid repo.",
        "Once the repo is reachable, re-run `momentum daemon start` to retry."
      ];
    case "job_running":
      return [
        "Inspect the iteration artifacts to determine whether the runner finished or was killed mid-write.",
        `Inspect repo state with \`git -C ${repoHint} status\` before retrying.`,
        "Resolve any partial writes manually before re-enqueueing the iteration."
      ];
    default:
      return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const MANUAL_RECOVERY_SKIP_REASONS: ReadonlySet<StaleClaimedJobSkipReason> =
  new Set(["repo_dirty", "repo_unknown_commit", "repo_unavailable", "job_running"]);

/**
 * When `dataDir` is provided and the skip reason maps to manual recovery,
 * render and write `recovery.md` for the goal so the operator-facing artifact
 * exists on disk for status/handoff/daemon-status surfaces to point at. The
 * write is best-effort relative to the recovery primitive's contract — if the
 * artifact cannot be written we still surface the skip without the path, so a
 * filesystem failure does not strand the in-memory recovery report.
 */
function maybeWriteRecoveryArtifact(
  db: MomentumDb,
  dataDir: string | undefined,
  job: QueueJobRow,
  skip: StaleClaimedJobRecoverySkipped,
  reason: RecoveryArtifactReason,
  now: number
): void {
  if (dataDir === undefined) return;
  if (!MANUAL_RECOVERY_SKIP_REASONS.has(skip.reason)) return;

  const goal: GoalRow | undefined = getGoal(db, job.goal_id);
  const goalTitle = goal?.title ?? job.goal_id;
  const repoPath = goal?.repo ?? skip.repoRoot ?? null;
  const expectedCommit = readExpectedCommitForJob(db, job);
  const currentCommit = readCurrentCommit(repoPath);

  const paths = resolveGoalArtifactPaths(dataDir, job.goal_id, job.iteration);
  const artifactPaths: RecoveryArtifactPathBundle = {
    iterationDir: paths.iterationDir,
    runnerLog: fs.existsSync(paths.runnerLog) ? paths.runnerLog : null,
    verificationLog: fs.existsSync(paths.verificationLog)
      ? paths.verificationLog
      : null,
    resultJson: fs.existsSync(paths.resultJson) ? paths.resultJson : null
  };

  try {
    const result = writeRecoveryArtifact({
      dataDir,
      input: {
        goalId: job.goal_id,
        goalTitle,
        iteration: job.iteration,
        jobId: job.id,
        daemonRunId: null,
        repoPath,
        expectedCommit,
        currentCommit,
        reason,
        artifactPaths,
        safeNextSteps: safeNextStepsForSkip(skip.reason, repoPath),
        classifiedAt: now
      }
    });
    skip.recoveryArtifactPath = result.path;
  } catch {
    // Filesystem failure should not strand the skip. Leave recoveryArtifactPath
    // unset so callers can detect the missing artifact.
  }

  // Set the durable manual-recovery flag regardless of artifact-write outcome.
  // The flag is what blocks further claims; recovery.md is operator evidence.
  // If this durable write fails, fail the recovery pass rather than returning
  // a skip that looks protected while the goal remains claimable.
  const marked = markGoalNeedsManualRecovery(db, {
    goalId: job.goal_id,
    reason: reason.code,
    now
  });
  if (!marked.ok) {
    throw new Error(
      `manual recovery flag write failed for goal ${job.goal_id}: ${marked.reason}`
    );
  }
}

function readExpectedCommitForJob(
  db: MomentumDb,
  job: QueueJobRow
): string | null {
  const rows = db
    .prepare(
      `SELECT payload
         FROM events
        WHERE goal_id = ?
          AND type IN ('job.succeeded', 'iteration_completed', 'goal.reduced')
        ORDER BY created_at DESC, id DESC`
    )
    .all(job.goal_id) as Array<{ payload: string }>;

  for (const row of rows) {
    const payload = parseEventPayload(row.payload);
    if (!payload) continue;
    const iteration = payload["iteration"];
    if (typeof iteration === "number" && iteration >= job.iteration) continue;
    const commitSha = readPayloadString(payload, "commit_sha");
    if (commitSha) return commitSha;
  }
  return null;
}

function readCurrentCommit(repoPath: string | null): string | null {
  if (!repoPath) return null;
  try {
    const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function parseEventPayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPayloadString(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
