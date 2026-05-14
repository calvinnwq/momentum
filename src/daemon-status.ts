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

/**
 * Default cutoff between "active" and "stale" for daemon heartbeat surfaces.
 * M3 surfaces stale records without guessing recovery, so this only controls
 * what the read-only inspector flags; it does not transition state.
 */
export const DEFAULT_DAEMON_STALE_AFTER_MS = 90_000;
export const DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS = 930_000;

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

export type DaemonStatusSuccess = {
  ok: true;
  dataDir: string;
  hasRun: boolean;
  daemonRun: DaemonStatusRunSummary | null;
  staleAfterMs: number;
  activeJobStaleAfterMs: number;
  staleRuns: DaemonStatusRunSummary[];
  observedAt: number;
};

export type DaemonStatusResult = DaemonStatusSuccess | DaemonStatusError;

export type LoadDaemonStatusInput = {
  dataDirOptions: DataDirOptions;
  staleAfterMs?: number;
  activeJobStaleAfterMs?: number;
  now?: number;
};

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

    return {
      ok: true,
      dataDir,
      hasRun: latest !== undefined,
      daemonRun,
      staleAfterMs,
      activeJobStaleAfterMs,
      staleRuns,
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
