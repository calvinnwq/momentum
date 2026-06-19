/**
 * ARCH-08 workflow runtime-state seam.
 *
 * This module owns the mechanical read/derive/write loop that follows a caller-
 * owned durable runtime mutation: re-read reducer-compatible step / lease rows,
 * derive the monitor view, and refresh the cached `workflow_runs` status plus
 * monitor advisory columns. It deliberately does not own step finalization
 * policy: callers still decide whether they are dispatch-starting, reconciling
 * terminal executor evidence, terminalizing a dogfood step, or applying an
 * operator transition before calling this seam.
 */

import type { MomentumDb } from "../../adapters/db.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorCheckpoint,
  type WorkflowMonitorState
} from "./monitor-state.js";
import type {
  WorkflowLeaseRecord,
  WorkflowStepKind,
  WorkflowStepRecord,
  WorkflowStepState
} from "./run-reducer.js";

export type WorkflowRuntimeStateRows = {
  steps: WorkflowStepRecord[];
  leases: WorkflowLeaseRecord[];
};

export type RefreshWorkflowRunRuntimeStateInput = {
  runId: string;
  now: number;
  /**
   * Use after dispatch starts a step so the run-level `started_at` marker is
   * filled exactly once. Finalization / recovery callers leave it preserved.
   */
  startedAt?: "preserve" | "coalesce-now";
  /**
   * Optional freshness knobs forwarded to the monitor reducer. Defaults mirror
   * read-only status loaders.
   */
  graceMs?: number;
  checkpointStaleMs?: number;
  /**
   * Most runtime refreshes derive from the durable step / lease substrate alone.
   * A caller that has a fresh checkpoint may supply it without duplicating the
   * run-row update SQL.
   */
  lastCheckpoint?: WorkflowMonitorCheckpoint | null;
};

/**
 * Load the workflow rows that the reducer / monitor state need. Keeping this in
 * one workflow-owned module lets dispatch, reconciliation, dogfood
 * terminalization, and operator/recovery callers share the same mapping instead
 * of exporting incidental helpers from whichever caller first needed them.
 */
export function loadWorkflowRuntimeStateRows(
  db: MomentumDb,
  runId: string
): WorkflowRuntimeStateRows {
  return {
    steps: loadWorkflowRuntimeStepRecords(db, runId),
    leases: loadWorkflowRuntimeLeaseRecords(db, runId)
  };
}

/**
 * Re-derive the run state / monitor advisory from durable rows and refresh the
 * cached `workflow_runs` columns. `finished_at` is coalesced only when the
 * derived run is terminal; non-terminal refreshes preserve it.
 */
export function refreshWorkflowRunRuntimeState(
  db: MomentumDb,
  input: RefreshWorkflowRunRuntimeStateInput
): WorkflowMonitorState {
  const rows = loadWorkflowRuntimeStateRows(db, input.runId);
  const monitorState = deriveWorkflowMonitorState({
    runId: input.runId,
    steps: rows.steps,
    leases: rows.leases,
    monitor: null,
    lastCheckpoint: input.lastCheckpoint ?? null,
    now: input.now,
    ...(input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    ...(input.checkpointStaleMs !== undefined
      ? { checkpointStaleMs: input.checkpointStaleMs }
      : {})
  });
  const finishedAt = monitorState.terminal ? input.now : null;

  if (input.startedAt === "coalesce-now") {
    db.prepare(
      `UPDATE workflow_runs
         SET state = ?,
             started_at = COALESCE(started_at, ?),
             finished_at = COALESCE(finished_at, ?),
             monitor_last_seen_state = ?,
             monitor_terminal = ?,
             monitor_step = ?,
             monitor_last_seen_digest = NULL,
             monitor_last_emitted_digest = NULL,
             updated_at = ?
       WHERE id = ?`
    ).run(
      monitorState.runState,
      input.now,
      finishedAt,
      monitorState.runState,
      monitorState.terminal ? 1 : 0,
      monitorState.activeStep?.stepId ?? null,
      input.now,
      input.runId
    );
    return monitorState;
  }

  db.prepare(
    `UPDATE workflow_runs
       SET state = ?,
           finished_at = COALESCE(finished_at, ?),
           monitor_last_seen_state = ?,
           monitor_terminal = ?,
           monitor_step = ?,
           monitor_last_seen_digest = NULL,
           monitor_last_emitted_digest = NULL,
           updated_at = ?
     WHERE id = ?`
  ).run(
    monitorState.runState,
    finishedAt,
    monitorState.runState,
    monitorState.terminal ? 1 : 0,
    monitorState.activeStep?.stepId ?? null,
    input.now,
    input.runId
  );

  return monitorState;
}

function loadWorkflowRuntimeStepRecords(
  db: MomentumDb,
  runId: string
): WorkflowStepRecord[] {
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

function loadWorkflowRuntimeLeaseRecords(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRecord[] {
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
    leaseKind: row.lease_kind as WorkflowLeaseRecord["leaseKind"],
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseRecord["stalePolicy"]
  }));
}
