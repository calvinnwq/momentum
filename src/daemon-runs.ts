import crypto from "node:crypto";

import type { MomentumDb } from "./db.js";

export const DAEMON_RUN_STATES = [
  "starting",
  "running",
  "stop_requested",
  "stopped",
  "error"
] as const;

export type DaemonRunState = (typeof DAEMON_RUN_STATES)[number];

const ACTIVE_DAEMON_STATES = new Set<DaemonRunState>([
  "starting",
  "running",
  "stop_requested"
]);

const TERMINAL_DAEMON_STATES = new Set<DaemonRunState>(["stopped", "error"]);

export function isActiveDaemonRunState(state: DaemonRunState): boolean {
  return ACTIVE_DAEMON_STATES.has(state);
}

export function isTerminalDaemonRunState(state: DaemonRunState): boolean {
  return TERMINAL_DAEMON_STATES.has(state);
}

export type DaemonRunRow = {
  id: string;
  pid: number | null;
  host: string | null;
  state: DaemonRunState;
  started_at: number;
  heartbeat_at: number;
  last_state_change_at: number;
  finished_at: number | null;
  active_job_id: string | null;
  active_lock_id: string | null;
  stop_requested_at: number | null;
  stop_reason: string | null;
  reconcile_count: number;
  last_reconciled_at: number | null;
  error: string | null;
  error_at: number | null;
  updated_at: number;
};

export type StartDaemonRunInput = {
  pid?: number | null;
  host?: string | null;
  state?: Extract<DaemonRunState, "starting" | "running">;
  now?: number;
};

export type StartDaemonRunResult = {
  runId: string;
  run: DaemonRunRow;
};

export function startDaemonRun(
  db: MomentumDb,
  input: StartDaemonRunInput = {}
): StartDaemonRunResult {
  validatePid(input.pid);
  validateHost(input.host);
  const state: DaemonRunState = input.state ?? "running";
  if (state !== "starting" && state !== "running") {
    throw new Error(
      `startDaemonRun: initial state must be 'starting' or 'running', got ${state}`
    );
  }
  const now = input.now ?? Date.now();
  const runId = crypto.randomUUID();

  db.prepare(
    `INSERT INTO daemon_runs
       (id, pid, host, state,
        started_at, heartbeat_at, last_state_change_at,
        reconcile_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    runId,
    input.pid ?? null,
    input.host ?? null,
    state,
    now,
    now,
    now,
    now
  );

  const run = getDaemonRun(db, runId);
  if (!run) {
    throw new Error(`startDaemonRun: run ${runId} disappeared after insert`);
  }
  return { runId, run };
}

export type HeartbeatDaemonRunInput = {
  runId: string;
  now?: number;
};

/**
 * Refresh `heartbeat_at` (and `updated_at`) for a non-terminal daemon run. The
 * `state NOT IN ('stopped','error')` guard keeps stale workers from heart-
 * beating a record that has already terminated. Returns `ok: false` for
 * unknown ids or terminal records.
 */
export function heartbeatDaemonRun(
  db: MomentumDb,
  input: HeartbeatDaemonRunInput
): { ok: boolean } {
  validateRunId(input.runId, "heartbeatDaemonRun");
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET heartbeat_at = ?, updated_at = ?
       WHERE id = ?
         AND state NOT IN ('stopped', 'error')`
    )
    .run(now, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export type RequestDaemonRunStopInput = {
  runId: string;
  reason: string;
  now?: number;
};

/**
 * Record an operator/automation stop request. The transition is one-way for
 * active states; terminal records are left alone so we never overwrite a
 * recorded shutdown outcome. Idempotent for runs already in `stop_requested`:
 * the reason and timestamp are refreshed without changing state.
 */
export function requestDaemonRunStop(
  db: MomentumDb,
  input: RequestDaemonRunStopInput
): { ok: boolean } {
  validateRunId(input.runId, "requestDaemonRunStop");
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("requestDaemonRunStop: reason is required");
  }
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET state = 'stop_requested',
             stop_requested_at = COALESCE(stop_requested_at, ?),
             stop_reason = ?,
             last_state_change_at = CASE WHEN state = 'stop_requested'
               THEN last_state_change_at ELSE ? END,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')`
    )
    .run(now, input.reason, now, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export type FinishDaemonRunInput = {
  runId: string;
  terminalState: Extract<DaemonRunState, "stopped" | "error">;
  now?: number;
  error?: string;
};

/**
 * Mark a daemon run terminal. `stopped` is a clean shutdown; `error` records
 * an unrecoverable failure. The update is guarded so we don't transition out
 * of an existing terminal record. When `error` is set, `error_at` is stamped
 * as well so operators can correlate the failure with the event log.
 */
export function finishDaemonRun(
  db: MomentumDb,
  input: FinishDaemonRunInput
): { ok: boolean } {
  validateRunId(input.runId, "finishDaemonRun");
  if (input.terminalState !== "stopped" && input.terminalState !== "error") {
    throw new Error(
      `finishDaemonRun: terminalState must be 'stopped' or 'error', got ${input.terminalState}`
    );
  }
  if (input.terminalState === "error") {
    if (typeof input.error !== "string" || input.error.length === 0) {
      throw new Error(
        "finishDaemonRun: error message is required when terminalState is 'error'"
      );
    }
  }
  const now = input.now ?? Date.now();
  const errorMessage = input.error ?? null;
  const errorAt = input.terminalState === "error" ? now : null;

  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET state = ?,
             finished_at = ?,
             last_state_change_at = ?,
             active_job_id = NULL,
             active_lock_id = NULL,
             error = CASE WHEN ? IS NOT NULL THEN ? ELSE error END,
             error_at = CASE WHEN ? IS NOT NULL THEN ? ELSE error_at END,
             updated_at = ?
       WHERE id = ?
         AND state NOT IN ('stopped', 'error')`
    )
    .run(
      input.terminalState,
      now,
      now,
      errorMessage,
      errorMessage,
      errorAt,
      errorAt,
      now,
      input.runId
    );
  return { ok: Number(result.changes) > 0 };
}

export type SetDaemonRunActiveJobInput = {
  runId: string;
  jobId: string | null;
  lockId?: string | null;
  now?: number;
};

/**
 * Link the active job/lock to a running daemon record so `daemon status` can
 * surface what the orchestrator is currently doing. Setting both to `null`
 * clears the linkage when the worker phase completes. Only active records
 * accept updates; terminal records keep their final snapshot.
 */
export function setDaemonRunActiveJob(
  db: MomentumDb,
  input: SetDaemonRunActiveJobInput
): { ok: boolean } {
  validateRunId(input.runId, "setDaemonRunActiveJob");
  const now = input.now ?? Date.now();
  const lockId = input.lockId === undefined ? null : input.lockId;
  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET active_job_id = ?,
             active_lock_id = ?,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')`
    )
    .run(input.jobId, lockId, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export type RecordDaemonRunReconciliationInput = {
  runId: string;
  now?: number;
};

/**
 * Bump `reconcile_count` and stamp `last_reconciled_at`. Used by future
 * reconciliation passes to make orchestrator activity observable without
 * inferring it from the event log. Only active records are updated.
 */
export function recordDaemonRunReconciliation(
  db: MomentumDb,
  input: RecordDaemonRunReconciliationInput
): { ok: boolean } {
  validateRunId(input.runId, "recordDaemonRunReconciliation");
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET reconcile_count = reconcile_count + 1,
             last_reconciled_at = ?,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')`
    )
    .run(now, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export function getDaemonRun(
  db: MomentumDb,
  runId: string
): DaemonRunRow | undefined {
  return db
    .prepare("SELECT * FROM daemon_runs WHERE id = ?")
    .get(runId) as DaemonRunRow | undefined;
}

/**
 * Return the most recently started daemon run still in an active state
 * (`starting`, `running`, or `stop_requested`). M3 represents stale records
 * without guessing recovery, so this may return a row whose heartbeat is far
 * behind wall-clock; pair with `listStaleDaemonRuns` to surface that fact.
 */
export function getActiveDaemonRun(
  db: MomentumDb
): DaemonRunRow | undefined {
  return db
    .prepare(
      `SELECT * FROM daemon_runs
       WHERE state IN ('starting', 'running', 'stop_requested')
       ORDER BY started_at DESC, id ASC
       LIMIT 1`
    )
    .get() as DaemonRunRow | undefined;
}

export function getLatestDaemonRun(
  db: MomentumDb
): DaemonRunRow | undefined {
  return db
    .prepare(
      "SELECT * FROM daemon_runs ORDER BY started_at DESC, id ASC LIMIT 1"
    )
    .get() as DaemonRunRow | undefined;
}

export type ListStaleDaemonRunsInput = {
  now: number;
  staleAfterMs: number;
  activeJobStaleAfterMs?: number;
};

/**
 * Return active daemon records whose `heartbeat_at` is older than the relevant
 * stale cutoff. Runs with an active job can use a longer cutoff so legitimate
 * long-running work does not look stale while the worker is blocked inside a
 * runner or verification command. The list is read-only; M3 surfaces stale
 * records via status/doctor surfaces but does not auto-recover them.
 */
export function listStaleDaemonRuns(
  db: MomentumDb,
  input: ListStaleDaemonRunsInput
): DaemonRunRow[] {
  if (!Number.isFinite(input.now)) {
    throw new Error("listStaleDaemonRuns: now must be a finite number");
  }
  if (!Number.isFinite(input.staleAfterMs) || input.staleAfterMs <= 0) {
    throw new Error(
      "listStaleDaemonRuns: staleAfterMs must be a positive number"
    );
  }
  const activeJobStaleAfterMs =
    input.activeJobStaleAfterMs ?? input.staleAfterMs;
  if (
    !Number.isFinite(activeJobStaleAfterMs) ||
    activeJobStaleAfterMs <= 0
  ) {
    throw new Error(
      "listStaleDaemonRuns: activeJobStaleAfterMs must be a positive number"
    );
  }
  const cutoff = input.now - input.staleAfterMs;
  const activeJobCutoff = input.now - activeJobStaleAfterMs;
  return db
    .prepare(
      `SELECT * FROM daemon_runs
       WHERE state IN ('starting', 'running', 'stop_requested')
         AND heartbeat_at < ?
         AND (
           active_job_id IS NULL
           OR heartbeat_at < ?
         )
       ORDER BY heartbeat_at ASC, id ASC`
    )
    .all(cutoff, activeJobCutoff) as DaemonRunRow[];
}

function validateRunId(runId: unknown, label: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`${label}: runId is required`);
  }
}

function validatePid(pid: number | null | undefined): void {
  if (pid === null || pid === undefined) return;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("startDaemonRun: pid must be a positive integer when set");
  }
}

function validateHost(host: string | null | undefined): void {
  if (host === null || host === undefined) return;
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("startDaemonRun: host must be a non-empty string when set");
  }
}
