import crypto from "node:crypto";

import type { MomentumDb } from "./db.js";

export const DAEMON_RUN_STATES = [
  "starting",
  "running",
  "stop_requested",
  "stopped",
  "canceled",
  "error"
] as const;

export type DaemonRunState = (typeof DAEMON_RUN_STATES)[number];

export const DAEMON_CANCEL_OUTCOMES = [
  "idle",
  "active_job_completed",
  "active_job_abandoned"
] as const;

export type DaemonCancelOutcome = (typeof DAEMON_CANCEL_OUTCOMES)[number];

const ACTIVE_DAEMON_STATES = new Set<DaemonRunState>([
  "starting",
  "running",
  "stop_requested"
]);

const TERMINAL_DAEMON_STATES = new Set<DaemonRunState>([
  "stopped",
  "canceled",
  "error"
]);

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
  stop_now_requested_at: number | null;
  cancel_outcome: DaemonCancelOutcome | null;
  reconcile_count: number;
  last_reconciled_at: number | null;
  error: string | null;
  error_at: number | null;
  recovery_status: string | null;
  updated_at: number;
};

/**
 * `recovery_status` stamped on a daemon_runs row when an idle stale record is
 * auto-finalized to `error` by the stale-recovery path. Stable string so
 * downstream surfaces (daemon status / handoff / log inspection) can recognize
 * the cause without matching free-form `error` text.
 */
export const DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS =
  "auto_recovered_idle_stale";

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
 * `state NOT IN ('stopped','canceled','error')` guard keeps stale workers
 * from heartbeating a record that has already terminated. Returns `ok: false` for
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
         AND state NOT IN ('stopped', 'canceled', 'error')`
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
 * recorded shutdown outcome. Idempotent for graceful runs already in
 * `stop_requested`: the reason is refreshed without changing state. Once an
 * immediate stop is recorded, the reason is no longer mutable because it is the
 * audited stop-now reason surfaced by status and handoff.
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
             stop_reason = CASE WHEN stop_now_requested_at IS NULL
               THEN ? ELSE stop_reason END,
             last_state_change_at = CASE WHEN state = 'stop_requested'
               THEN last_state_change_at ELSE ? END,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')`
    )
    .run(now, input.reason, now, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export type RequestDaemonRunImmediateStopInput = {
  runId: string;
  reason: string;
  now?: number;
};

/**
 * Record an operator/automation immediate-stop ("stop --now") request. The
 * graceful `stop_requested_at` and `stop_reason` columns are stamped alongside
 * the dedicated `stop_now_requested_at` marker so the daemon loop can detect
 * the upgrade between cycles, and so consumers can render either form without
 * a separate query. Idempotent for runs already requested-stop or
 * already-stop-now: subsequent calls keep the earliest timestamps. Once a
 * stop-now request has been recorded, its reason is immutable because status
 * and handoff expose the shared stop reason as stop-now audit context.
 */
export function requestDaemonRunImmediateStop(
  db: MomentumDb,
  input: RequestDaemonRunImmediateStopInput
): { ok: boolean } {
  validateRunId(input.runId, "requestDaemonRunImmediateStop");
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("requestDaemonRunImmediateStop: reason is required");
  }
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET state = 'stop_requested',
             stop_requested_at = COALESCE(stop_requested_at, ?),
             stop_now_requested_at = COALESCE(stop_now_requested_at, ?),
             stop_reason = CASE WHEN stop_now_requested_at IS NULL
               THEN ? ELSE stop_reason END,
             last_state_change_at = CASE WHEN state = 'stop_requested'
               THEN last_state_change_at ELSE ? END,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')`
    )
    .run(now, now, input.reason, now, now, input.runId);
  return { ok: Number(result.changes) > 0 };
}

export type FinishDaemonRunInput = {
  runId: string;
  terminalState: Extract<DaemonRunState, "stopped" | "canceled" | "error">;
  now?: number;
  error?: string;
  cancelOutcome?: DaemonCancelOutcome;
};

/**
 * Mark a daemon run terminal. `stopped` is a clean shutdown, `canceled` is an
 * operator stop-now request observed by the loop, and `error` records an
 * unrecoverable failure. The update is guarded so we don't transition out of
 * an existing terminal record. When `error` is set, `error_at` is stamped as
 * well so operators can correlate the failure with the event log. When
 * `canceled` is set, `cancel_outcome` records whether the cancellation
 * occurred while idle or while an iteration was in flight.
 */
export function finishDaemonRun(
  db: MomentumDb,
  input: FinishDaemonRunInput
): { ok: boolean } {
  validateRunId(input.runId, "finishDaemonRun");
  if (
    input.terminalState !== "stopped" &&
    input.terminalState !== "canceled" &&
    input.terminalState !== "error"
  ) {
    throw new Error(
      `finishDaemonRun: terminalState must be 'stopped', 'canceled', or 'error', got ${input.terminalState}`
    );
  }
  if (input.terminalState === "error") {
    if (typeof input.error !== "string" || input.error.length === 0) {
      throw new Error(
        "finishDaemonRun: error message is required when terminalState is 'error'"
      );
    }
  }
  if (input.terminalState === "canceled") {
    if (input.cancelOutcome === undefined) {
      throw new Error(
        "finishDaemonRun: cancelOutcome is required when terminalState is 'canceled'"
      );
    }
    if (!DAEMON_CANCEL_OUTCOMES.includes(input.cancelOutcome)) {
      throw new Error(
        `finishDaemonRun: cancelOutcome must be one of ${DAEMON_CANCEL_OUTCOMES.join(", ")}, got ${input.cancelOutcome}`
      );
    }
  }
  const now = input.now ?? Date.now();
  const errorMessage = input.error ?? null;
  const errorAt = input.terminalState === "error" ? now : null;
  const cancelOutcome =
    input.terminalState === "canceled" ? (input.cancelOutcome ?? null) : null;

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
             cancel_outcome = CASE WHEN ? IS NOT NULL THEN ? ELSE cancel_outcome END,
             updated_at = ?
       WHERE id = ?
         AND state NOT IN ('stopped', 'canceled', 'error')`
    )
    .run(
      input.terminalState,
      now,
      now,
      errorMessage,
      errorMessage,
      errorAt,
      errorAt,
      cancelOutcome,
      cancelOutcome,
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

/**
 * Return the active daemon run (`starting`, `running`, or `stop_requested`)
 * whose `active_job_id` matches the given job. Used by stale-claim recovery to
 * refuse re-pending a claim that an active daemon is still asserting ownership
 * of, even if the claim's lease has lapsed. Terminal-state daemons
 * (`stopped` / `canceled` / `error`) are excluded because they no longer hold
 * authority over the claim.
 */
export function getActiveDaemonRunForJob(
  db: MomentumDb,
  jobId: string
): DaemonRunRow | undefined {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new Error("getActiveDaemonRunForJob: jobId is required");
  }
  return db
    .prepare(
      `SELECT * FROM daemon_runs
       WHERE active_job_id = ?
         AND state IN ('starting', 'running', 'stop_requested')
       ORDER BY started_at DESC, id ASC
       LIMIT 1`
    )
    .get(jobId) as DaemonRunRow | undefined;
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
         AND (
           (active_job_id IS NULL AND heartbeat_at < ?)
           OR (active_job_id IS NOT NULL AND heartbeat_at < ?)
         )
       ORDER BY heartbeat_at ASC, id ASC`
    )
    .all(cutoff, activeJobCutoff) as DaemonRunRow[];
}

export type RecoverStaleDaemonRunInput = {
  runId: string;
  now?: number;
  recoveryStatus?: string;
  errorMessage?: string;
};

export type RecoverStaleDaemonRunResult =
  | { ok: true; run: DaemonRunRow }
  | { ok: false };

/**
 * Auto-finalize an idle stale daemon record to the `error` terminal state and
 * stamp `recovery_status` so downstream surfaces can distinguish an
 * orchestrator-driven recovery from a run-internal failure. Guarded so it
 * never disturbs live work:
 *
 *   - Only active records (`starting` / `running` / `stop_requested`) flip.
 *   - `active_job_id` AND `active_lock_id` must both be NULL — a record with
 *     either set may still own a job/lock, and stale-claim / stale-lock
 *     recovery primitives are the right tools for those cases.
 *
 * The caller (orchestrator) is responsible for deciding which rows are
 * eligible based on the listStaleDaemonRuns enumeration; this helper only
 * applies the row-level guards so two concurrent recoveries are safe.
 *
 * Returns `{ ok: false }` when the row was not updated (state changed, an
 * active_job_id/active_lock_id appeared, or the row is gone), so callers can
 * skip event emission for a state they no longer observe.
 */
export function recoverStaleDaemonRun(
  db: MomentumDb,
  input: RecoverStaleDaemonRunInput
): RecoverStaleDaemonRunResult {
  validateRunId(input.runId, "recoverStaleDaemonRun");
  const now = input.now ?? Date.now();
  const recoveryStatus =
    input.recoveryStatus ?? DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS;
  const errorMessage =
    input.errorMessage ?? DAEMON_RUN_AUTO_RECOVERED_IDLE_STATUS;

  const result = db
    .prepare(
      `UPDATE daemon_runs
         SET state = 'error',
             finished_at = ?,
             last_state_change_at = ?,
             active_job_id = NULL,
             active_lock_id = NULL,
             error = COALESCE(error, ?),
             error_at = COALESCE(error_at, ?),
             recovery_status = ?,
             updated_at = ?
       WHERE id = ?
         AND state IN ('starting', 'running', 'stop_requested')
         AND active_job_id IS NULL
         AND active_lock_id IS NULL`
    )
    .run(
      now,
      now,
      errorMessage,
      now,
      recoveryStatus,
      now,
      input.runId
    );
  if (Number(result.changes) === 0) {
    return { ok: false };
  }
  const run = getDaemonRun(db, input.runId);
  if (!run) {
    return { ok: false };
  }
  return { ok: true, run };
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
