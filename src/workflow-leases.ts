/**
 * Durable `workflow_leases` lifecycle primitives introduced by NGX-333 (M9-02).
 *
 * M7 added the `workflow_leases` table (PK `(run_id, lease_kind)`) and the pure
 * `classifyWorkflowLease` / `deriveWorkflowRunState` reducers, but no `src`
 * function acquired, heartbeated, or released a row — tests seeded leases with
 * raw SQL and the executor bridge (`live-step-executor.ts`) deferred this to
 * "caller-side" work. The M9 live-execution contract requires each live step to
 * "acquire a workflow lease before spawning the process", "heartbeat while the
 * process is active", and "persist terminal state before releasing the lease",
 * so the live-step orchestrator needs first-class lease primitives.
 *
 * These mirror the M3 `repo-locks.ts` primitives (`acquireRepoLock` /
 * `updateRepoLockHeartbeat` / `releaseRepoLock`) and return the reducer's
 * `WorkflowLeaseRecord` so results feed `classifyWorkflowLease` and
 * `deriveWorkflowRunState` directly.
 *
 * Acquisition takes an exclusive outstanding lease for one `(runId, leaseKind)`:
 *
 *   - An outstanding (unreleased) lease refuses re-acquisition regardless of
 *     expiry. A stale-but-unreleased lease is a recovery decision (the reducer
 *     classifies it as `stale-*` and the run blocks), never a silent takeover.
 *   - Outstanding `managed-step` and `dispatch` leases for the same run are
 *     mutually exclusive; `monitor` leases may coexist with either.
 *   - A previously released lease row is taken over in place (one row per
 *     `(runId, leaseKind)`), preserving the original `created_at`.
 *
 * Lease staleness is not a stored column: a lease "goes stale" by passing its
 * `expires_at` without a heartbeat, and `classifyWorkflowLease` plus the row's
 * `stale_policy` decide the consequence. There is therefore no "mark stale"
 * primitive here.
 */

import type { MomentumDb } from "./adapters/db.js";
import {
  WORKFLOW_LEASE_KINDS,
  WORKFLOW_LEASE_STALE_POLICIES,
  type WorkflowLeaseKind,
  type WorkflowLeaseRecord,
  type WorkflowLeaseStalePolicy
} from "./workflow-run-reducer.js";

const LEASE_KIND_SET: ReadonlySet<string> = new Set(WORKFLOW_LEASE_KINDS);
const STALE_POLICY_SET: ReadonlySet<string> = new Set(
  WORKFLOW_LEASE_STALE_POLICIES
);
const NON_MONITOR_WORKFLOW_LEASE_KINDS: readonly WorkflowLeaseKind[] = [
  "managed-step",
  "dispatch"
];

type LeaseRow = {
  run_id: string;
  lease_kind: string;
  holder: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
  released_at: number | null;
  stale_policy: string;
  created_at: number;
  updated_at: number;
};

export type AcquireWorkflowLeaseInput = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  expiresAt: number;
  stalePolicy?: WorkflowLeaseStalePolicy;
  now?: number;
};

export type AcquireWorkflowLeaseResult =
  | { ok: true; lease: WorkflowLeaseRecord }
  | { ok: false; reason: "already_held"; existing: WorkflowLeaseRecord };

/**
 * Take an exclusive outstanding lease on `(runId, leaseKind)`. Refuses with
 * `already_held` when an unreleased lease already exists (returning the blocking
 * record), including the cross-kind `managed-step` / `dispatch` conflict for the
 * same run; otherwise inserts a new row or takes over a released row in place.
 */
export function acquireWorkflowLease(
  db: MomentumDb,
  input: AcquireWorkflowLeaseInput
): AcquireWorkflowLeaseResult {
  validateAcquireInput(input);
  const now = input.now ?? Date.now();
  const stalePolicy = input.stalePolicy ?? "auto-release";

  db.exec("BEGIN IMMEDIATE");
  try {
    const acquired = acquireWorkflowLeaseInTransaction(
      db,
      input,
      now,
      stalePolicy
    );
    if (!acquired.ok) {
      db.exec("ROLLBACK");
      return acquired;
    }
    db.exec("COMMIT");
    return acquired;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}

export function acquireWorkflowLeaseInTransaction(
  db: MomentumDb,
  input: AcquireWorkflowLeaseInput,
  now = input.now ?? Date.now(),
  stalePolicy = input.stalePolicy ?? "auto-release"
): AcquireWorkflowLeaseResult {
  validateAcquireInput(input);

  const existing = getWorkflowLease(db, input.runId, input.leaseKind);
  if (existing && existing.releasedAt === null) {
    return { ok: false, reason: "already_held", existing };
  }

  const conflicting = getActiveConflictingNonMonitorLease(
    db,
    input.runId,
    input.leaseKind
  );
  if (conflicting !== undefined) {
    return { ok: false, reason: "already_held", existing: conflicting };
  }

  const acquiredAt =
    existing === undefined ? now : Math.max(now, existing.acquiredAt + 1);
  validateAcquireLeaseWindow(input.expiresAt, acquiredAt);

  const result = db
    .prepare(
      `INSERT INTO workflow_leases
         (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
          released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(run_id, lease_kind) DO UPDATE SET
         holder = excluded.holder,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         heartbeat_at = excluded.heartbeat_at,
         released_at = NULL,
         stale_policy = excluded.stale_policy,
         updated_at = excluded.updated_at
       WHERE workflow_leases.released_at IS NOT NULL`
    )
    .run(
      input.runId,
      input.leaseKind,
      input.holder,
      acquiredAt,
      input.expiresAt,
      acquiredAt,
      stalePolicy,
      now,
      acquiredAt
    );

  if (Number(result.changes) === 0) {
    const racing = getWorkflowLease(db, input.runId, input.leaseKind);
    if (racing && racing.releasedAt === null) {
      return { ok: false, reason: "already_held", existing: racing };
    }
    throw new Error(
      "acquireWorkflowLease: upsert affected no rows unexpectedly"
    );
  }

  const lease = getWorkflowLease(db, input.runId, input.leaseKind);
  if (!lease) {
    throw new Error(
      `acquireWorkflowLease: lease ${input.runId}/${input.leaseKind} disappeared after write`
    );
  }
  return { ok: true, lease };
}

export type HeartbeatWorkflowLeaseInput = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
};

/**
 * Advance the heartbeat and expiry of an outstanding lease. Returns
 * `{ ok: false }` when no fresh unreleased lease matches `(runId, leaseKind)`.
 */
export function heartbeatWorkflowLease(
  db: MomentumDb,
  input: HeartbeatWorkflowLeaseInput
): { ok: boolean } {
  const result = db
    .prepare(
      `UPDATE workflow_leases
         SET heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE run_id = ?
         AND lease_kind = ?
         AND holder = ?
         AND acquired_at = ?
         AND released_at IS NULL
         AND expires_at >= ?`
    )
    .run(
      input.heartbeatAt,
      input.expiresAt,
      input.heartbeatAt,
      input.runId,
      input.leaseKind,
      input.holder,
      input.acquiredAt,
      input.heartbeatAt
    );
  return { ok: Number(result.changes) > 0 };
}

export type ReleaseWorkflowLeaseInput = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  acquiredAt: number;
  now?: number;
};

/**
 * Release an outstanding lease by stamping `released_at`. Returns
 * `{ ok: false }` when the lease is absent or already released.
 */
export function releaseWorkflowLease(
  db: MomentumDb,
  input: ReleaseWorkflowLeaseInput
): { ok: boolean } {
  const now = input.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE workflow_leases
         SET released_at = ?, updated_at = ?
       WHERE run_id = ?
         AND lease_kind = ?
         AND holder = ?
         AND acquired_at = ?
         AND released_at IS NULL`
    )
    .run(now, now, input.runId, input.leaseKind, input.holder, input.acquiredAt);
  return { ok: Number(result.changes) > 0 };
}

/**
 * Read one lease row mapped into the reducer's `WorkflowLeaseRecord` shape, or
 * `undefined` when no row exists for `(runId, leaseKind)`.
 */
export function getWorkflowLease(
  db: MomentumDb,
  runId: string,
  leaseKind: WorkflowLeaseKind
): WorkflowLeaseRecord | undefined {
  const row = db
    .prepare(
      "SELECT * FROM workflow_leases WHERE run_id = ? AND lease_kind = ?"
    )
    .get(runId, leaseKind) as LeaseRow | undefined;
  return row ? mapLeaseRow(row) : undefined;
}

function mapLeaseRow(row: LeaseRow): WorkflowLeaseRecord {
  return {
    runId: row.run_id,
    leaseKind: row.lease_kind as WorkflowLeaseKind,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseStalePolicy
  };
}

function validateAcquireInput(input: AcquireWorkflowLeaseInput): void {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("acquireWorkflowLease: runId is required");
  }
  if (!LEASE_KIND_SET.has(input.leaseKind)) {
    throw new Error(
      `acquireWorkflowLease: leaseKind must be one of ${WORKFLOW_LEASE_KINDS.join(", ")}`
    );
  }
  if (typeof input.holder !== "string" || input.holder.length === 0) {
    throw new Error("acquireWorkflowLease: holder is required");
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error(
      "acquireWorkflowLease: expiresAt must be a positive integer ms timestamp"
    );
  }
  if (
    input.stalePolicy !== undefined &&
    !STALE_POLICY_SET.has(input.stalePolicy)
  ) {
    throw new Error(
      `acquireWorkflowLease: stalePolicy must be one of ${WORKFLOW_LEASE_STALE_POLICIES.join(", ")}`
    );
  }
}

function validateAcquireLeaseWindow(
  expiresAt: number,
  acquiredAt: number
): void {
  if (expiresAt <= acquiredAt) {
    throw new Error(
      "acquireWorkflowLease: expiresAt must be after the acquisition time"
    );
  }
}

function getActiveConflictingNonMonitorLease(
  db: MomentumDb,
  runId: string,
  leaseKind: WorkflowLeaseKind
): WorkflowLeaseRecord | undefined {
  if (!NON_MONITOR_WORKFLOW_LEASE_KINDS.includes(leaseKind)) {
    return undefined;
  }
  const conflictingKinds = NON_MONITOR_WORKFLOW_LEASE_KINDS.filter(
    (candidate) => candidate !== leaseKind
  );
  const row = db
    .prepare(
      `SELECT *
         FROM workflow_leases
        WHERE run_id = ?
          AND lease_kind IN (${conflictingKinds.map(() => "?").join(", ")})
          AND released_at IS NULL
        ORDER BY lease_kind
        LIMIT 1`
    )
    .get(runId, ...conflictingKinds) as LeaseRow | undefined;
  return row ? mapLeaseRow(row) : undefined;
}
