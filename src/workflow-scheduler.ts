/**
 * Daemon workflow scheduler lane: durable runnable-work selection (M10-04,
 * NGX-348).
 *
 * The workflow-first runtime daemon contract opens with:
 *
 *   scan runnable workflow_runs / step_runs
 *   for each active step:
 *     acquire or refresh daemon / step lease
 *     ...
 *
 * This module owns the *scan*. It reads only durable SQLite state
 * (`workflow_runs` / `workflow_steps` / `workflow_leases`) — never a process
 * handle, socket, or file watcher — and returns the next runnable step per
 * eligible run plus any stale leases that need recovery. Per the executor-loop
 * contract, "the safe path is authoritative": process/event signals are hints,
 * and a durable row is the proof of what may run next. Selection is pure with
 * respect to the database (read-only), so the daemon lane, startup recovery, and
 * status surfaces can all rely on the same deterministic answer.
 *
 * This slice deliberately does not acquire leases, dispatch executors, or touch
 * the daemon loop — those are later M10-04 follow-ups. It also leaves goal
 * iteration draining (`worker-run.ts`) untouched: workflow scheduling is a
 * separate lane over separate tables.
 *
 * "Runnable" means, for a run that is neither terminal nor flagged for manual
 * recovery, the run's lease-aware derived state is `approved` (an approved step
 * exists with nothing running, blocked, or failed) AND no `managed-step` /
 * `dispatch` lease is outstanding. A fresh non-monitor lease means another
 * worker is mid-dispatch (busy); a stale non-monitor lease must be recovered
 * before re-acquisition can succeed. The chosen step is the lowest-order
 * `approved` step whose predecessors are all `succeeded` or `skipped`, mirroring
 * the single-active-step model the M7 reducer and M9 lease primitives enforce.
 */

import type { MomentumDb } from "./db.js";
import {
  getWorkflowLease,
  releaseWorkflowLease
} from "./workflow-leases.js";
import { markWorkflowRunNeedsManualRecovery } from "./workflow-run-recovery.js";
import {
  classifyWorkflowLease,
  deriveWorkflowRunState,
  type WorkflowLeaseKind,
  type WorkflowLeaseRecord,
  type WorkflowLeaseStalePolicy,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "./workflow-run-reducer.js";

/**
 * Lease kinds that block step dispatch while outstanding. `monitor` leases are
 * intentionally excluded: the M7 contract lets a monitor lease coexist with a
 * managed step, so a live monitor never withholds work.
 */
const NON_MONITOR_LEASE_KINDS: ReadonlySet<WorkflowLeaseKind> = new Set([
  "managed-step",
  "dispatch"
]);

/** A workflow step the scheduler considers safe to dispatch next. */
export type RunnableWorkflowStep = {
  runId: string;
  stepId: string;
  kind: WorkflowStepKind;
  stepOrder: number;
  required: boolean;
  /** The owning run's `repo_path` (may be null for definition-only runs). */
  repoPath: string | null;
  /** The lease-aware derived run state at scan time (always `approved` here). */
  runState: WorkflowRunState;
};

/** An outstanding lease whose expiry has lapsed and needs recovery. */
export type StaleWorkflowLease = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  classification: "stale-auto-release" | "stale-manual-recovery-required";
  stalePolicy: WorkflowLeaseStalePolicy;
  expiresAt: number;
};

export type WorkflowSchedulerScan = {
  /** Next runnable step per eligible run, ordered by run creation then id. */
  runnable: RunnableWorkflowStep[];
  /** Outstanding stale leases discovered across the scanned non-terminal runs. */
  staleLeases: StaleWorkflowLease[];
};

export type SelectRunnableWorkflowWorkInput = {
  /** Absolute ms timestamp used for lease freshness classification. */
  now: number;
  /** Clock-skew tolerance forwarded to `classifyWorkflowLease`. Defaults to 0. */
  graceMs?: number;
};

type WorkflowRunScanRow = {
  id: string;
  state: string;
  repo_path: string | null;
};

/**
 * Scan durable workflow state for the next runnable step per eligible run and
 * any stale leases needing recovery. Read-only: no row is mutated.
 */
export function selectRunnableWorkflowWork(
  db: MomentumDb,
  input: SelectRunnableWorkflowWorkInput
): WorkflowSchedulerScan {
  if (!Number.isFinite(input.now)) {
    throw new Error("selectRunnableWorkflowWork: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "selectRunnableWorkflowWork: graceMs must be a non-negative finite number"
    );
  }

  // Only non-terminal runs that are not already parked for manual recovery can
  // produce runnable work or relevant stale leases. `pending` runs (no approval
  // yet) are scanned too so a stray lease on them is still surfaced, but they
  // never derive to `approved` and so never produce a runnable step.
  const runs = db
    .prepare(
      `SELECT id, state, repo_path
         FROM workflow_runs
        WHERE needs_manual_recovery = 0
          AND state NOT IN ('succeeded', 'failed', 'canceled')
        ORDER BY created_at ASC, id ASC`
    )
    .all() as WorkflowRunScanRow[];

  const runnable: RunnableWorkflowStep[] = [];
  const staleLeases: StaleWorkflowLease[] = [];

  for (const run of runs) {
    const steps = loadStepRecords(db, run.id);
    const leases = loadLeaseRecords(db, run.id);

    let hasOutstandingNonMonitorLease = false;
    let hasManualRecoveryLease = false;
    for (const lease of leases) {
      const classification = classifyWorkflowLease(lease, {
        now: input.now,
        graceMs
      });
      if (classification === "released") continue;
      if (NON_MONITOR_LEASE_KINDS.has(lease.leaseKind)) {
        hasOutstandingNonMonitorLease = true;
      }
      if (
        classification === "stale-auto-release" ||
        classification === "stale-manual-recovery-required"
      ) {
        staleLeases.push({
          runId: lease.runId,
          leaseKind: lease.leaseKind,
          holder: lease.holder,
          classification,
          stalePolicy: lease.stalePolicy,
          expiresAt: lease.expiresAt
        });
      }
      if (classification === "stale-manual-recovery-required") {
        hasManualRecoveryLease = true;
      }
    }

    const derivedRunState = deriveWorkflowRunState(steps, {
      leases,
      now: input.now,
      graceMs
    });

    // A run is dispatchable only when an approved step is ready (nothing
    // running/blocked/failed) and no non-monitor lease is outstanding. A stale
    // manual-recovery lease additionally forces the reducer to `blocked`; guard
    // explicitly so a future reducer change can't silently re-open it.
    if (derivedRunState !== "approved") continue;
    if (hasOutstandingNonMonitorLease || hasManualRecoveryLease) continue;

    const step = nextRunnableStep(steps);
    if (step === undefined) continue;

    runnable.push({
      runId: run.id,
      stepId: step.stepId,
      kind: step.kind,
      stepOrder: step.order,
      required: step.required,
      repoPath: run.repo_path,
      runState: derivedRunState
    });
  }

  return { runnable, staleLeases };
}

/**
 * The lowest-order `approved` step whose predecessors are all terminal-success
 * (`succeeded` / `skipped`). Returns `undefined` when the first non-terminal
 * step in order is not yet `approved` (still `pending`, `running`, or in a
 * non-success terminal state) — there is no safe step to dispatch past it.
 * `steps` is assumed ordered by `(order, stepId)` as loaded below.
 */
function nextRunnableStep(
  steps: readonly WorkflowStepRecord[]
): WorkflowStepRecord | undefined {
  for (const step of steps) {
    if (step.state === "succeeded" || step.state === "skipped") continue;
    if (step.state === "approved") return step;
    return undefined;
  }
  return undefined;
}

function loadStepRecords(db: MomentumDb, runId: string): WorkflowStepRecord[] {
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

/**
 * `recoveryStatus` recorded when this lane auto-releases a stale lease whose
 * `stale_policy` is `auto-release`. Stable string so daemon-lane telemetry and
 * future status / handoff surfaces can recognise the cause.
 */
export const WORKFLOW_LEASE_AUTO_RELEASED_STATUS =
  "auto_released_stale_workflow_lease";

/**
 * `recoveryStatus` recorded — and the durable `manual_recovery_reason` prefix
 * stamped — when this lane routes a stale `manual-recovery-required` lease to
 * the run's manual-recovery flag instead of releasing it.
 */
export const WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS =
  "stale_workflow_lease_manual_recovery_required";

/** A stale workflow lease this lane recovered, with the action it took. */
export type RecoveredStaleWorkflowLease = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  stalePolicy: WorkflowLeaseStalePolicy;
  action: "released" | "flagged_manual_recovery";
  recoveryStatus:
    | typeof WORKFLOW_LEASE_AUTO_RELEASED_STATUS
    | typeof WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS;
};

/**
 * A stale lease candidate the recovery pass declined to act on because the
 * durable row changed under it between the scan and the guarded write
 * (`lease_changed`) or the owning run vanished (`run_not_found`). These are
 * race classifications — the safe path simply re-scans on the next pass.
 */
export type SkippedStaleWorkflowLease = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  reason: "lease_changed" | "run_not_found";
};

export type RecoverStaleWorkflowLeasesResult = {
  recovered: RecoveredStaleWorkflowLease[];
  skipped: SkippedStaleWorkflowLease[];
};

export type RecoverStaleWorkflowLeasesInput = {
  /** Absolute ms timestamp used for lease freshness classification. */
  now: number;
  /** Clock-skew tolerance forwarded to `classifyWorkflowLease`. Defaults to 0. */
  graceMs?: number;
};

/**
 * Recover the stale leases surfaced by {@link selectRunnableWorkflowWork} so the
 * daemon workflow scheduler lane does not strand a run behind a dead worker's
 * lease. Mirrors the M3 `recoverStale*` family in `stale-recovery.ts`:
 *
 *   - `stale-auto-release` → release the lease so the run is schedulable again
 *     on the next scan (the row is released in place, never deleted).
 *   - `stale-manual-recovery-required` → set the run's durable
 *     `needs_manual_recovery` flag and leave the lease outstanding as evidence;
 *     the reducer keeps the run blocked and an operator must resolve it via the
 *     guarded clear before the run is eligible again.
 *
 * Each lease is re-read and re-classified inside a `BEGIN IMMEDIATE`
 * transaction before acting, so a lease another worker heartbeated (extending
 * `expires_at`) or released between the scan and the write classifies as
 * non-stale and is reported as `lease_changed` rather than wrongly recovered.
 * SQLite is the source of truth: no process handle, socket, or event is
 * consulted.
 *
 * Idempotent: a released lease is no longer surfaced as stale, and a
 * manual-recovery-flagged run is excluded from the scan entirely, so a second
 * pass over unchanged state returns `{ recovered: [], skipped: [] }`.
 */
export function recoverStaleWorkflowLeases(
  db: MomentumDb,
  input: RecoverStaleWorkflowLeasesInput
): RecoverStaleWorkflowLeasesResult {
  const now = input.now;
  const graceMs = input.graceMs ?? 0;
  // selectRunnableWorkflowWork validates now/graceMs identically; calling it
  // first keeps a single validation + classification source for the lane.
  const scan = selectRunnableWorkflowWork(db, input);

  const recovered: RecoveredStaleWorkflowLease[] = [];
  const skipped: SkippedStaleWorkflowLease[] = [];

  for (const candidate of scan.staleLeases) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const live = getWorkflowLease(db, candidate.runId, candidate.leaseKind);
      const classification =
        live === undefined
          ? "released"
          : classifyWorkflowLease(live, { now, graceMs });

      if (live !== undefined && classification === "stale-auto-release") {
        const released = releaseWorkflowLease(db, {
          runId: live.runId,
          leaseKind: live.leaseKind,
          holder: live.holder,
          acquiredAt: live.acquiredAt,
          now
        });
        if (released.ok) {
          db.exec("COMMIT");
          recovered.push({
            runId: live.runId,
            leaseKind: live.leaseKind,
            holder: live.holder,
            stalePolicy: live.stalePolicy,
            action: "released",
            recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS
          });
        } else {
          db.exec("ROLLBACK");
          skipped.push({
            runId: candidate.runId,
            leaseKind: candidate.leaseKind,
            reason: "lease_changed"
          });
        }
      } else if (
        live !== undefined &&
        classification === "stale-manual-recovery-required"
      ) {
        const marked = markWorkflowRunNeedsManualRecovery(db, {
          runId: live.runId,
          reason:
            `${WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS}: ${live.leaseKind} lease ` +
            `held by ${live.holder} expired without a heartbeat`,
          now
        });
        if (marked.ok) {
          db.exec("COMMIT");
          recovered.push({
            runId: live.runId,
            leaseKind: live.leaseKind,
            holder: live.holder,
            stalePolicy: live.stalePolicy,
            action: "flagged_manual_recovery",
            recoveryStatus: WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS
          });
        } else {
          db.exec("ROLLBACK");
          skipped.push({
            runId: candidate.runId,
            leaseKind: candidate.leaseKind,
            reason: "run_not_found"
          });
        }
      } else {
        // The row was released or re-freshed (heartbeated) between the scan and
        // this transaction; leave it for the next pass.
        db.exec("ROLLBACK");
        skipped.push({
          runId: candidate.runId,
          leaseKind: candidate.leaseKind,
          reason: "lease_changed"
        });
      }
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors so callers see the original write failure.
      }
      throw error;
    }
  }

  return { recovered, skipped };
}

function loadLeaseRecords(db: MomentumDb, runId: string): WorkflowLeaseRecord[] {
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
    leaseKind: row.lease_kind as WorkflowLeaseKind,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseStalePolicy
  }));
}
