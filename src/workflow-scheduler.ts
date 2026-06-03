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
 * The *scan* and *recovery* primitives are read-only / recovery-only. The
 * *claim* primitive ({@link claimRunnableWorkflowStep}) takes the next step of
 * the daemon loop — "acquire or refresh daemon / step lease" — by atomically
 * re-verifying a scanned step is still runnable inside a `BEGIN IMMEDIATE`
 * transaction and acquiring its `dispatch` lease (the lease kind the contract
 * reserves for the dispatcher layer). The *tick* primitive
 * ({@link runWorkflowSchedulerOnce}) composes the three into one per-cycle pass
 * — recover stale leases, scan, claim one step, then hand it to an injected
 * executor-dispatch seam — as the workflow-first analogue of `runWorkerOnce`.
 * The real executor and the daemon-loop wiring are still later M10 follow-ups;
 * this lane leaves goal iteration draining (`worker-run.ts`) untouched, because
 * workflow scheduling is a separate lane over separate tables.
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
import path from "node:path";
import {
  acquireWorkflowLeaseInTransaction,
  getWorkflowLease,
  releaseWorkflowLease
} from "./workflow-leases.js";
import {
  writeWorkflowRecoveryArtifact,
  writeWorkflowRecoveryArtifactInRunDir,
  type WorkflowRecoveryArtifactInput
} from "./workflow-recovery-artifact.js";
import { markWorkflowRunNeedsManualRecovery } from "./workflow-run-recovery.js";
import {
  classifyWorkflowLease,
  deriveWorkflowRunState,
  WORKFLOW_RUN_TERMINAL_STATES,
  type WorkflowLeaseKind,
  type WorkflowLeaseRecord,
  type WorkflowLeaseStalePolicy,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "./workflow-run-reducer.js";

/** Run states that can never produce a runnable step or accept a new claim. */
const RUN_TERMINAL_STATE_SET: ReadonlySet<string> = new Set(
  WORKFLOW_RUN_TERMINAL_STATES
);

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
    const signals = collectRunLeaseSignals(leases, input.now, graceMs);
    staleLeases.push(...signals.staleLeases);

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
    if (
      signals.outstandingNonMonitorLease !== undefined ||
      signals.hasStaleManualRecoveryLease
    ) {
      continue;
    }

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

/** Lease-derived signals for one run, shared by the scan and the claim path. */
type RunLeaseSignals = {
  /** Stale (`auto-release` or `manual-recovery-required`) leases for the run. */
  staleLeases: StaleWorkflowLease[];
  /** A non-released `managed-step`/`dispatch` lease (fresh or stale), if any. */
  outstandingNonMonitorLease: WorkflowLeaseRecord | undefined;
  /** A non-released, non-stale `managed-step`/`dispatch` lease, if any. */
  freshNonMonitorLease: WorkflowLeaseRecord | undefined;
  /** Whether a stale `manual-recovery-required` lease is outstanding. */
  hasStaleManualRecoveryLease: boolean;
};

/**
 * Classify a run's leases into the signals the scan and claim both need. Pure
 * with respect to the database (it only reads the supplied records), so the
 * claim path can call it inside its `BEGIN IMMEDIATE` transaction. The first
 * matching lease wins for `outstandingNonMonitorLease` / `freshNonMonitorLease`
 * (the rows arrive ordered by `lease_kind`), and every stale lease is collected
 * in row order so the scan's aggregate list is deterministic.
 */
function collectRunLeaseSignals(
  leases: readonly WorkflowLeaseRecord[],
  now: number,
  graceMs: number
): RunLeaseSignals {
  const staleLeases: StaleWorkflowLease[] = [];
  let outstandingNonMonitorLease: WorkflowLeaseRecord | undefined;
  let freshNonMonitorLease: WorkflowLeaseRecord | undefined;
  let hasStaleManualRecoveryLease = false;

  for (const lease of leases) {
    const classification = classifyWorkflowLease(lease, { now, graceMs });
    if (classification === "released") continue;
    if (NON_MONITOR_LEASE_KINDS.has(lease.leaseKind)) {
      outstandingNonMonitorLease ??= lease;
      if (classification === "fresh") {
        freshNonMonitorLease ??= lease;
      }
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
      hasStaleManualRecoveryLease = true;
    }
  }

  return {
    staleLeases,
    outstandingNonMonitorLease,
    freshNonMonitorLease,
    hasStaleManualRecoveryLease
  };
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
        const reason =
          `${WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS}: ${live.leaseKind} lease ` +
          `held by ${live.holder} expired without a heartbeat`;
        const artifactContext = loadWorkflowManualRecoveryArtifactContext(
          db,
          live.runId
        );
        const marked = markWorkflowRunNeedsManualRecovery(db, {
          runId: live.runId,
          reason,
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
          tryWriteWorkflowManualRecoveryArtifact({
            context: artifactContext,
            reason,
            now
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

type WorkflowManualRecoveryArtifactContext = {
  runId: string;
  repoPath: string | null;
  sourceArtifactPath: string | null;
  stepId: string | null;
};

function loadWorkflowManualRecoveryArtifactContext(
  db: MomentumDb,
  runId: string
): WorkflowManualRecoveryArtifactContext | null {
  const run = db
    .prepare("SELECT id, repo_path, source_artifact_path FROM workflow_runs WHERE id = ?")
    .get(runId) as
    | { id: string; repo_path: string | null; source_artifact_path: string | null }
    | undefined;
  if (run === undefined) return null;
  const steps = loadStepRecords(db, runId);
  const runningOrBlocked = steps.find(
    (step) => step.state === "running" || step.state === "blocked"
  );
  return {
    runId: run.id,
    repoPath: run.repo_path,
    sourceArtifactPath: run.source_artifact_path,
    stepId: runningOrBlocked?.stepId ?? null
  };
}

function tryWriteWorkflowManualRecoveryArtifact(input: {
  context: WorkflowManualRecoveryArtifactContext | null;
  reason: string;
  now: number;
}): void {
  const context = input.context;
  if (context === null) return;

  const artifactInput: WorkflowRecoveryArtifactInput = {
    runId: context.runId,
    stepId: context.stepId,
    classification: "manual_recovery_lease",
    reason: input.reason,
    recommendedNextAction: {
      code: "clear_recovery",
      detail:
        "Run is blocked. Clear the manual recovery once the underlying cause has been resolved.",
      stepId: context.stepId
    },
    evidencePointers: [],
    repoPath: context.repoPath,
    classifiedAt: input.now
  };

  try {
    if (context.sourceArtifactPath !== null) {
      writeWorkflowRecoveryArtifactInRunDir({
        runDir: path.dirname(context.sourceArtifactPath),
        input: artifactInput
      });
    } else if (context.repoPath !== null) {
      writeWorkflowRecoveryArtifact({
        agentWorkflowsDir: path.join(context.repoPath, ".agent-workflows"),
        input: artifactInput
      });
    }
  } catch {
  }
}

/**
 * The lease kind this lane takes when claiming a runnable step for dispatch. The
 * executor-loop contract reserves `dispatch` for the cron / dispatcher layer
 * (the live `managed-step` lease is taken later, around the executor's own
 * execution); the scan treats an outstanding `dispatch` lease as "busy".
 */
export const WORKFLOW_DISPATCH_LEASE_KIND: WorkflowLeaseKind = "dispatch";

export type ClaimRunnableWorkflowStepInput = {
  runId: string;
  stepId: string;
  /** Lease holder identity (the worker / process id). */
  holder: string;
  /** Absolute ms timestamp at which the acquired `dispatch` lease expires. */
  leaseExpiresAt: number;
  /** Absolute ms timestamp used for re-evaluation and lease acquisition. */
  now: number;
  /** Clock-skew tolerance forwarded to lease classification. Defaults to 0. */
  graceMs?: number;
  /** Stale policy stamped on the `dispatch` lease. Defaults to `auto-release`. */
  stalePolicy?: WorkflowLeaseStalePolicy;
};

/** A runnable step whose `dispatch` lease this lane has acquired. */
export type ClaimedWorkflowStep = RunnableWorkflowStep & {
  /** The freshly-acquired `dispatch` lease. */
  lease: WorkflowLeaseRecord;
};

export type ClaimRunnableWorkflowStepResult =
  | { ok: true; claim: ClaimedWorkflowStep }
  /** The run row no longer exists. */
  | { ok: false; reason: "run_not_found" }
  /**
   * The run is no longer offering a runnable step: it is terminal, flagged for
   * manual recovery, blocked, busy with a running step, or withheld behind a
   * stale lease the recovery pass must clear first.
   */
  | { ok: false; reason: "run_not_runnable" }
  /**
   * The run is runnable, but its next runnable step is a different step than the
   * one requested — the run advanced between scan and claim.
   */
  | { ok: false; reason: "step_superseded"; runnableStepId: string }
  /** Another holder took the dispatch / managed-step lease first. */
  | { ok: false; reason: "lease_held"; existing: WorkflowLeaseRecord };

/**
 * Atomically claim the next runnable step of a run by acquiring its `dispatch`
 * lease, taking the daemon loop's "acquire or refresh daemon / step lease" step
 * after {@link selectRunnableWorkflowWork} surfaced the candidate.
 *
 * The scan snapshot is a hint, never proof: this re-reads and re-evaluates the
 * run inside a `BEGIN IMMEDIATE` transaction before acquiring the lease, so a
 * run that went terminal, got flagged for manual recovery, advanced to a
 * different step, or was claimed by another worker between the scan and the
 * claim is refused rather than double-dispatched. SQLite stays the source of
 * truth: no process handle, socket, or event is consulted.
 *
 * A stale lease (auto-release or manual-recovery) withholds the run as
 * `run_not_runnable` instead of being claimed over — the recovery pass
 * ({@link recoverStaleWorkflowLeases}) owns clearing it. A `monitor` lease never
 * blocks a claim. On success the run scans as busy until the lease is released.
 */
export function claimRunnableWorkflowStep(
  db: MomentumDb,
  input: ClaimRunnableWorkflowStepInput
): ClaimRunnableWorkflowStepResult {
  validateClaimInput(input);
  const graceMs = input.graceMs ?? 0;
  const stalePolicy = input.stalePolicy ?? "auto-release";

  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db
      .prepare(
        `SELECT id, state, repo_path, needs_manual_recovery
           FROM workflow_runs
          WHERE id = ?`
      )
      .get(input.runId) as
      | (WorkflowRunScanRow & { needs_manual_recovery: number })
      | undefined;

    if (run === undefined) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "run_not_found" };
    }
    if (
      run.needs_manual_recovery !== 0 ||
      RUN_TERMINAL_STATE_SET.has(run.state)
    ) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "run_not_runnable" };
    }

    const steps = loadStepRecords(db, run.id);
    const leases = loadLeaseRecords(db, run.id);
    const signals = collectRunLeaseSignals(leases, input.now, graceMs);

    // A stale lease (or any manual-recovery lease) withholds the run until the
    // recovery pass handles it; never bypass recovery by claiming over it. A
    // *fresh* non-monitor lease is left to the acquisition below, which reports
    // it as `lease_held`.
    const hasStaleNonMonitorLease =
      signals.outstandingNonMonitorLease !== undefined &&
      signals.freshNonMonitorLease === undefined;
    if (signals.hasStaleManualRecoveryLease || hasStaleNonMonitorLease) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "run_not_runnable" };
    }

    const derivedRunState = deriveWorkflowRunState(steps, {
      leases,
      now: input.now,
      graceMs
    });
    if (derivedRunState !== "approved") {
      db.exec("ROLLBACK");
      return { ok: false, reason: "run_not_runnable" };
    }

    const step = nextRunnableStep(steps);
    if (step === undefined) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "run_not_runnable" };
    }
    if (step.stepId !== input.stepId) {
      db.exec("ROLLBACK");
      return {
        ok: false,
        reason: "step_superseded",
        runnableStepId: step.stepId
      };
    }

    const acquired = acquireWorkflowLeaseInTransaction(
      db,
      {
        runId: input.runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: input.holder,
        expiresAt: input.leaseExpiresAt,
        stalePolicy,
        now: input.now
      },
      input.now,
      stalePolicy
    );
    if (!acquired.ok) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "lease_held", existing: acquired.existing };
    }

    db.exec("COMMIT");
    return {
      ok: true,
      claim: {
        runId: run.id,
        stepId: step.stepId,
        kind: step.kind,
        stepOrder: step.order,
        required: step.required,
        repoPath: run.repo_path,
        runState: derivedRunState,
        lease: acquired.lease
      }
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so callers see the original failure.
    }
    throw error;
  }
}

function validateClaimInput(input: ClaimRunnableWorkflowStepInput): void {
  if (!Number.isFinite(input.now)) {
    throw new Error("claimRunnableWorkflowStep: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "claimRunnableWorkflowStep: graceMs must be a non-negative finite number"
    );
  }
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("claimRunnableWorkflowStep: runId is required");
  }
  if (typeof input.stepId !== "string" || input.stepId.length === 0) {
    throw new Error("claimRunnableWorkflowStep: stepId is required");
  }
  if (typeof input.holder !== "string" || input.holder.length === 0) {
    throw new Error("claimRunnableWorkflowStep: holder is required");
  }
  if (!Number.isInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= 0) {
    throw new Error(
      "claimRunnableWorkflowStep: leaseExpiresAt must be a positive integer ms timestamp"
    );
  }
}

/**
 * Default `dispatch` lease TTL the scheduler lane stamps on a claimed step.
 * Mirrors `DEFAULT_DAEMON_WORKER_LEASE_MS` from `daemon-loop` so the workflow
 * lane and the goal-iteration lane age leases on the same cadence.
 */
export const DEFAULT_WORKFLOW_DISPATCH_LEASE_MS = 30_000;

export type WorkflowSchedulerNow = () => number;

/** Context handed to the executor-dispatch seam alongside a claimed step. */
export type WorkflowStepDispatchContext = {
  db: MomentumDb;
  /** The lease holder / worker identity that claimed the step. */
  workerId: string;
  /** The single tick timestamp used for recovery, scan, and the claim. */
  now: number;
};

/**
 * What the dispatcher reports back to the lane. The lane does not classify this
 * (daemon classification of executor output is a later M10 slice); it echoes
 * the value into the tick result for callers, telemetry, and tests.
 */
export type WorkflowStepDispatchResult = {
  status: string;
  detail?: string;
};

/**
 * The executor-dispatch seam. {@link runWorkflowSchedulerOnce} claims the next
 * runnable step and hands the claim to this callback; a later M10 slice supplies
 * the real executor dispatcher (start an `executor_invocation`, run a round,
 * classify, advance). On a normal return the dispatcher owns the dispatch
 * lease's lifecycle (refresh across rounds, release on terminal). If it throws,
 * the lane releases the lease it just acquired so the claim is not stranded,
 * then rethrows.
 */
export type WorkflowStepDispatch = (
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext
) => WorkflowStepDispatchResult;

/**
 * The lane's durable primitives, overridable for tests (mirrors the dependency
 * injection `runDaemonLoop` uses for `runWorker` / `now` / `sleep`). Production
 * callers leave these unset and get the real, exported functions.
 */
type WorkflowSchedulerDeps = {
  recoverStaleLeases: typeof recoverStaleWorkflowLeases;
  selectRunnableWork: typeof selectRunnableWorkflowWork;
  claimStep: typeof claimRunnableWorkflowStep;
};

export type RunWorkflowSchedulerOnceInput = {
  db: MomentumDb;
  /** Lease holder identity for any dispatch lease this tick acquires. */
  workerId: string;
  /** The executor-dispatch seam invoked with a successfully claimed step. */
  dispatch: WorkflowStepDispatch;
  /** Tick clock. Defaults to `Date.now`. */
  now?: WorkflowSchedulerNow;
  /** Clock-skew tolerance forwarded to recovery / scan / claim. Defaults to 0. */
  graceMs?: number;
  /** Dispatch-lease TTL. Defaults to {@link DEFAULT_WORKFLOW_DISPATCH_LEASE_MS}. */
  leaseDurationMs?: number;
  /** Stale policy stamped on the dispatch lease. Defaults to `auto-release`. */
  stalePolicy?: WorkflowLeaseStalePolicy;
  /** Overridable durable primitives (testing seam). */
  deps?: Partial<WorkflowSchedulerDeps>;
};

export type RunWorkflowSchedulerOnceResult =
  | {
      /** No runnable workflow step after recovery; nothing was dispatched. */
      code: "idle";
      workerId: string;
      recovery: RecoverStaleWorkflowLeasesResult;
    }
  | {
      /**
       * A runnable step was scanned, but the atomic claim lost a race (the run
       * advanced, went terminal, was flagged, or another holder took the lease)
       * between the scan and the claim. The daemon retries on the next tick.
       */
      code: "claim_contended";
      workerId: string;
      recovery: RecoverStaleWorkflowLeasesResult;
      claimResult: Exclude<ClaimRunnableWorkflowStepResult, { ok: true }>;
    }
  | {
      /** A step was claimed and handed to the dispatcher. */
      code: "dispatched";
      workerId: string;
      recovery: RecoverStaleWorkflowLeasesResult;
      claim: ClaimedWorkflowStep;
      dispatch: WorkflowStepDispatchResult;
    };

/**
 * Run one workflow scheduler-lane tick: recover stale leases, scan for the next
 * runnable step, atomically claim it, and hand it to the executor-dispatch seam.
 * This is the workflow-first analogue of `runWorkerOnce` (the goal-iteration
 * drain) and is what the daemon loop will call each cycle alongside — never
 * instead of — goal iteration draining. Goal-iteration tables are untouched here:
 * workflow scheduling is a separate lane over separate tables.
 *
 * Ordering matters and is deliberate:
 *
 *   1. Recover stale leases first, so a dead worker's `auto-release` lease is
 *      freed before the scan and its run becomes schedulable this same tick;
 *      a stale `manual-recovery-required` lease parks its run instead.
 *   2. Scan the post-recovery durable state for the next runnable step (one per
 *      eligible run, oldest run first).
 *   3. Claim the first candidate atomically. The scan is only a hint — the claim
 *      re-verifies under `BEGIN IMMEDIATE`, so a run that advanced or was taken
 *      by another worker between scan and claim yields `claim_contended` rather
 *      than a double dispatch.
 *   4. Dispatch the claimed step. On success the dispatcher owns the dispatch
 *      lease; if it throws, the lane releases the lease and rethrows.
 *
 * Exactly one step is claimed per tick (mirroring `runWorkerOnce`); the daemon
 * loop drives throughput across runs over successive ticks. SQLite stays the
 * source of truth: no process handle, socket, or event is consulted.
 */
export function runWorkflowSchedulerOnce(
  input: RunWorkflowSchedulerOnceInput
): RunWorkflowSchedulerOnceResult {
  const { db, workerId } = input;
  if (typeof workerId !== "string" || workerId.length === 0) {
    throw new Error("runWorkflowSchedulerOnce: workerId is required");
  }
  if (typeof input.dispatch !== "function") {
    throw new Error("runWorkflowSchedulerOnce: dispatch is required");
  }
  const leaseDurationMs =
    input.leaseDurationMs ?? DEFAULT_WORKFLOW_DISPATCH_LEASE_MS;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error(
      "runWorkflowSchedulerOnce: leaseDurationMs must be a positive finite number"
    );
  }

  const now = input.now ?? (() => Date.now());
  const graceMs = input.graceMs ?? 0;
  const stalePolicy = input.stalePolicy ?? "auto-release";
  const recoverStaleLeases =
    input.deps?.recoverStaleLeases ?? recoverStaleWorkflowLeases;
  const selectRunnableWork =
    input.deps?.selectRunnableWork ?? selectRunnableWorkflowWork;
  const claimStep = input.deps?.claimStep ?? claimRunnableWorkflowStep;

  // A single tick timestamp keeps recovery, scan, and claim classifying lease
  // freshness against one consistent clock. (recover / scan validate now/graceMs.)
  const tickNow = now();

  const recovery = recoverStaleLeases(db, { now: tickNow, graceMs });

  const scan = selectRunnableWork(db, { now: tickNow, graceMs });
  const candidate = scan.runnable[0];
  if (candidate === undefined) {
    return { code: "idle", workerId, recovery };
  }

  const claimResult = claimStep(db, {
    runId: candidate.runId,
    stepId: candidate.stepId,
    holder: workerId,
    leaseExpiresAt: tickNow + leaseDurationMs,
    now: tickNow,
    graceMs,
    stalePolicy
  });
  if (!claimResult.ok) {
    return { code: "claim_contended", workerId, recovery, claimResult };
  }

  const claim = claimResult.claim;
  let dispatchResult: WorkflowStepDispatchResult;
  try {
    dispatchResult = input.dispatch(claim, { db, workerId, now: tickNow });
  } catch (error) {
    try {
      releaseWorkflowLease(db, {
        runId: claim.lease.runId,
        leaseKind: claim.lease.leaseKind,
        holder: claim.lease.holder,
        acquiredAt: claim.lease.acquiredAt,
        now: tickNow
      });
    } catch {
      // Best-effort release: surface the original dispatcher failure, not a
      // secondary release error.
    }
    throw error;
  }

  return {
    code: "dispatched",
    workerId,
    recovery,
    claim,
    dispatch: dispatchResult
  };
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
