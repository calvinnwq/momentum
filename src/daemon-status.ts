import fs from "node:fs";

import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import {
  getActiveDaemonRun,
  getLatestDaemonRun,
  isActiveDaemonRunState,
  isTerminalDaemonRunState,
  listStaleDaemonRuns,
  type DaemonCancelOutcome,
  type DaemonRunRow,
  type DaemonRunState
} from "./daemon-runs.js";
import {
  listStaleClaimedGoalIterationJobs,
  type QueueJobRow,
  type QueueJobState
} from "./queue-jobs.js";
import { resolveRecoveryArtifactPath } from "./recovery-artifact.js";
import {
  listStaleRepoLocks,
  type RepoLockRow,
  type RepoLockState
} from "./repo-locks.js";

/**
 * Default cutoff between "active" and "stale" for daemon heartbeat surfaces.
 * M3 surfaces stale records without guessing recovery, so this only controls
 * what the read-only inspector flags; it does not transition state.
 */
export const DEFAULT_DAEMON_STALE_AFTER_MS = 90_000;
export const DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS = 930_000;

/**
 * Grace window applied when listing stale repo locks / queue claims. The lease
 * deadline is the contract, so once `lease_expires_at` has passed the holder
 * has lost authority; the grace tolerates small clock skew between the worker
 * that wrote the lease and the inspector reading it back. Surfaces only — no
 * recovery action is taken when a row crosses this threshold.
 */
export const DEFAULT_STALE_LEASE_GRACE_MS = 5_000;

export type DaemonStatusErrorCode = "invalid_input" | "data_dir_failed";

export type DaemonStatusError = {
  ok: false;
  code: DaemonStatusErrorCode;
  error: string;
};

export type DaemonStatusActiveJob = {
  jobId: string | null;
  lockId: string | null;
};

export type DaemonStatusStopRequest = {
  requestedAt: number;
  reason: string;
};

export type DaemonStatusStopNowRequest = {
  requestedAt: number;
  reason: string;
};

export type DaemonStatusCancelOutcome = {
  outcome: DaemonCancelOutcome;
};

export type DaemonStatusErrorDetail = {
  message: string;
  at: number;
};

export type DaemonStatusReconciliation = {
  count: number;
  lastReconciledAt: number | null;
};

export type DaemonStatusRunSummary = {
  runId: string;
  pid: number | null;
  host: string | null;
  state: DaemonRunState;
  isActive: boolean;
  isTerminal: boolean;
  startedAt: number;
  heartbeatAt: number;
  lastStateChangeAt: number;
  finishedAt: number | null;
  ageMs: number;
  heartbeatAgeMs: number;
  stale: boolean;
  staleAfterMs: number;
  activeJobStaleAfterMs: number;
  activeJob: DaemonStatusActiveJob;
  stopRequest: DaemonStatusStopRequest | null;
  stopNowRequest: DaemonStatusStopNowRequest | null;
  cancelOutcome: DaemonStatusCancelOutcome | null;
  reconciliation: DaemonStatusReconciliation;
  error: DaemonStatusErrorDetail | null;
  updatedAt: number;
};

export type DaemonStatusStaleRepoLock = {
  lockId: string;
  repoRoot: string;
  holder: string;
  goalId: string;
  iteration: number;
  jobId: string;
  state: RepoLockState;
  acquiredAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
  leaseExpiredAgeMs: number;
};

export type DaemonStatusStaleClaimedJob = {
  jobId: string;
  goalId: string;
  iteration: number;
  state: QueueJobState;
  attemptCount: number;
  workerId: string | null;
  leaseAcquiredAt: number | null;
  leaseExpiresAt: number;
  heartbeatAt: number | null;
  leaseExpiredAgeMs: number;
};

/**
 * One entry per goal whose durable `needs_manual_recovery` flag is set.
 * `recovery.md` presence is surfaced separately because `recovery clear`
 * intentionally leaves the artifact on disk after clearing the durable block.
 */
export type DaemonStatusGoalRecoveryArtifact = {
  goalId: string;
  title: string;
  goalState: string;
  recoveryMdPath: string;
  recoveryMdExists: boolean;
};

export type DaemonStatusSuccess = {
  ok: true;
  dataDir: string;
  hasRun: boolean;
  daemonRun: DaemonStatusRunSummary | null;
  staleAfterMs: number;
  activeJobStaleAfterMs: number;
  staleLeaseGraceMs: number;
  staleRuns: DaemonStatusRunSummary[];
  staleRepoLocks: DaemonStatusStaleRepoLock[];
  staleClaimedJobs: DaemonStatusStaleClaimedJob[];
  goalsNeedingRecovery: DaemonStatusGoalRecoveryArtifact[];
  observedAt: number;
};

export type DaemonStatusResult = DaemonStatusSuccess | DaemonStatusError;

export type LoadDaemonStatusInput = {
  dataDirOptions: DataDirOptions;
  staleAfterMs?: number;
  activeJobStaleAfterMs?: number;
  staleLeaseGraceMs?: number;
  now?: number;
};

export type StaleLeasePreCheckSnapshot = {
  observedAt: number;
  staleLeaseGraceMs: number;
  staleRepoLocks: DaemonStatusStaleRepoLock[];
  staleClaimedJobs: DaemonStatusStaleClaimedJob[];
};

export type LoadStaleLeasePreCheckInput = {
  db: MomentumDb;
  now?: number;
  staleLeaseGraceMs?: number;
};

/**
 * Read-only stale-lease snapshot over an already-open db. Composes
 * `listStaleRepoLocks` and `listStaleClaimedGoalIterationJobs` against a single
 * observed `now` so callers (worker run pre-check, daemon status, doctor) see a
 * coherent view of orphaned repo locks and stale claimed/running
 * `goal_iteration` jobs.
 *
 * The grace window tolerates small clock skew between the writer that stamped
 * `lease_expires_at` and the reader observing it; it is non-recovering and does
 * not mutate any state. Callers that want recovery must invoke the dedicated
 * primitives in `stale-recovery.ts`.
 */
export function loadStaleLeasePreCheck(
  input: LoadStaleLeasePreCheckInput
): StaleLeasePreCheckSnapshot {
  const staleLeaseGraceMs =
    input.staleLeaseGraceMs ?? DEFAULT_STALE_LEASE_GRACE_MS;
  if (!Number.isFinite(staleLeaseGraceMs) || staleLeaseGraceMs < 0) {
    throw new Error(
      `staleLeaseGraceMs must be a non-negative number, got ${staleLeaseGraceMs}`
    );
  }
  const now = input.now ?? Date.now();
  const staleRepoLocks = listStaleRepoLocks(input.db, {
    now,
    graceMs: staleLeaseGraceMs
  }).map((row) => summarizeStaleRepoLock(row, now));
  const staleClaimedJobs = listStaleClaimedGoalIterationJobs(input.db, {
    now,
    graceMs: staleLeaseGraceMs
  }).map((row) => summarizeStaleClaimedJob(row, now));
  return {
    observedAt: now,
    staleLeaseGraceMs,
    staleRepoLocks,
    staleClaimedJobs
  };
}

/**
 * Read-only inspector for the daemon_runs table. Selects the active record if
 * one exists; otherwise falls back to the most recently started run so
 * operators can see terminal/error state. Returns `hasRun: false` cleanly when
 * no daemon has ever started.
 */
export function loadDaemonStatus(
  input: LoadDaemonStatusInput
): DaemonStatusResult {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_DAEMON_STALE_AFTER_MS;
  const activeJobStaleAfterMs =
    input.activeJobStaleAfterMs ?? DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS;
  const staleLeaseGraceMs =
    input.staleLeaseGraceMs ?? DEFAULT_STALE_LEASE_GRACE_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: `staleAfterMs must be a positive number, got ${staleAfterMs}`
    };
  }
  if (
    !Number.isFinite(activeJobStaleAfterMs) ||
    activeJobStaleAfterMs <= 0
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: `activeJobStaleAfterMs must be a positive number, got ${activeJobStaleAfterMs}`
    };
  }
  if (!Number.isFinite(staleLeaseGraceMs) || staleLeaseGraceMs < 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: `staleLeaseGraceMs must be a non-negative number, got ${staleLeaseGraceMs}`
    };
  }

  let dataDir: string;
  try {
    dataDir = resolveDataDir(input.dataDirOptions);
  } catch (err) {
    return {
      ok: false,
      code: "data_dir_failed",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const now = input.now ?? Date.now();
  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);
    const active = getActiveDaemonRun(db);
    const latest = active ?? getLatestDaemonRun(db);
    const stale = listStaleDaemonRuns(db, {
      now,
      staleAfterMs,
      activeJobStaleAfterMs
    });
    const staleIds = new Set(stale.map((row) => row.id));

    const daemonRun = latest
      ? summarizeRow(latest, {
        now,
        staleAfterMs,
        activeJobStaleAfterMs,
        staleIds
      })
      : null;
    const staleRuns = stale.map((row) =>
      summarizeRow(row, {
        now,
        staleAfterMs,
        activeJobStaleAfterMs,
        staleIds
      })
    );

    const preCheck = loadStaleLeasePreCheck({
      db,
      now,
      staleLeaseGraceMs
    });

    const goalsNeedingRecovery = listGoalsWithRecoveryArtifact(db, dataDir);

    return {
      ok: true,
      dataDir,
      hasRun: latest !== undefined,
      daemonRun,
      staleAfterMs,
      activeJobStaleAfterMs,
      staleLeaseGraceMs,
      staleRuns,
      staleRepoLocks: preCheck.staleRepoLocks,
      staleClaimedJobs: preCheck.staleClaimedJobs,
      goalsNeedingRecovery,
      observedAt: now
    };
  } catch (err) {
    return {
      ok: false,
      code: "data_dir_failed",
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    db?.close();
  }
}

type GoalRecoveryRow = {
  id: string;
  title: string;
  state: string;
  needs_manual_recovery: number;
};

/**
 * Scan the durable recovery flag first, then attach the artifact path/presence
 * so a missing artifact does not hide a blocked goal and a cleared goal with a
 * retained recovery.md does not stay listed as blocked.
 */
function listGoalsWithRecoveryArtifact(
  db: MomentumDb,
  dataDir: string
): DaemonStatusGoalRecoveryArtifact[] {
  const rows = db
    .prepare(
      `SELECT id, title, state, needs_manual_recovery
         FROM goals
        ORDER BY created_at ASC, id ASC`
    )
    .all() as GoalRecoveryRow[];
  const out: DaemonStatusGoalRecoveryArtifact[] = [];
  for (const row of rows) {
    if (row.needs_manual_recovery !== 1) continue;
    const recoveryMdPath = resolveRecoveryArtifactPath(dataDir, row.id);
    out.push({
      goalId: row.id,
      title: row.title,
      goalState: row.state,
      recoveryMdPath,
      recoveryMdExists: fs.existsSync(recoveryMdPath)
    });
  }
  return out;
}

function summarizeStaleRepoLock(
  row: RepoLockRow,
  now: number
): DaemonStatusStaleRepoLock {
  return {
    lockId: row.id,
    repoRoot: row.repo_root,
    holder: row.holder,
    goalId: row.goal_id,
    iteration: row.iteration,
    jobId: row.job_id,
    state: row.state,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseExpiredAgeMs: Math.max(0, now - row.lease_expires_at)
  };
}

function summarizeStaleClaimedJob(
  row: QueueJobRow,
  now: number
): DaemonStatusStaleClaimedJob {
  const leaseExpiresAt = row.lease_expires_at ?? 0;
  return {
    jobId: row.id,
    goalId: row.goal_id,
    iteration: row.iteration,
    state: row.state,
    attemptCount: row.attempt_count,
    workerId: row.worker_id,
    leaseAcquiredAt: row.lease_acquired_at,
    leaseExpiresAt,
    heartbeatAt: row.heartbeat_at,
    leaseExpiredAgeMs: Math.max(0, now - leaseExpiresAt)
  };
}

function summarizeRow(
  row: DaemonRunRow,
  ctx: {
    now: number;
    staleAfterMs: number;
    activeJobStaleAfterMs: number;
    staleIds: Set<string>;
  }
): DaemonStatusRunSummary {
  const rowStaleAfterMs =
    row.active_job_id !== null ? ctx.activeJobStaleAfterMs : ctx.staleAfterMs;
  const summary: DaemonStatusRunSummary = {
    runId: row.id,
    pid: row.pid,
    host: row.host,
    state: row.state,
    isActive: isActiveDaemonRunState(row.state),
    isTerminal: isTerminalDaemonRunState(row.state),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    lastStateChangeAt: row.last_state_change_at,
    finishedAt: row.finished_at,
    ageMs: Math.max(0, ctx.now - row.started_at),
    heartbeatAgeMs: Math.max(0, ctx.now - row.heartbeat_at),
    stale: ctx.staleIds.has(row.id),
    staleAfterMs: rowStaleAfterMs,
    activeJobStaleAfterMs: ctx.activeJobStaleAfterMs,
    activeJob: { jobId: row.active_job_id, lockId: row.active_lock_id },
    stopRequest:
      row.stop_requested_at !== null
        ? { requestedAt: row.stop_requested_at, reason: row.stop_reason ?? "" }
        : null,
    stopNowRequest:
      row.stop_now_requested_at !== null
        ? {
            requestedAt: row.stop_now_requested_at,
            reason: row.stop_reason ?? ""
          }
        : null,
    cancelOutcome:
      row.cancel_outcome !== null ? { outcome: row.cancel_outcome } : null,
    reconciliation: {
      count: row.reconcile_count,
      lastReconciledAt: row.last_reconciled_at
    },
    error:
      row.error !== null
        ? { message: row.error, at: row.error_at ?? row.last_state_change_at }
        : null,
    updatedAt: row.updated_at
  };
  return summary;
}
