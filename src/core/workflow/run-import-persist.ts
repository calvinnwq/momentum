/**
 * Persistence layer for NGX-314 (M7-02 import current agent-workflow plans).
 *
 * Takes the pure {@link WorkflowRunImport} shape produced by
 * `parseWorkflowRunImport` and writes it into the durable
 * `workflow_runs` / `workflow_steps` / `workflow_approvals` tables pinned by
 * internal/contracts/workflow-runs.md.
 *
 * Stable contracts this slice locks in:
 *   - Upsert is keyed on the durable identity: `workflow_runs.id = runId`,
 *     `(run_id, step_id)` for steps, `(run_id, boundary)` for approvals.
 *     Re-importing the same artifact directory is idempotent — running twice
 *     never produces duplicate rows and never corrupts existing state.
 *   - `monitor.json` stays advisory: the persistence layer stores its snapshot
 *     in `workflow_runs` monitor advisory columns, but never writes a
 *     `workflow_leases` row from monitor snapshots or lets them override
 *     ledger-derived state. Durable leases come from live executors /
 *     managed-step dispatch, not from static import.
 *   - Upserts are additive: a step / approval previously persisted from a
 *     different artifact tree is left alone if the current import doesn't
 *     reference it. This avoids destructive overwrites when a follow-up import
 *     happens to see a subset of the original artifacts (e.g., a re-archive).
 *   - Approval imports merge forward with durable state: existing approval
 *     rows and the stored `workflow_runs.approval_boundary` participate in the
 *     persisted summary, stale approval artifacts cannot overwrite newer rows,
 *     and imported or already-durable boundaries can promote covered pending
 *     steps / runs to `approved`.
 *   - `created_at` is preserved across re-imports; `updated_at` is bumped on
 *     every upsert so downstream tooling can detect re-ingest.
 */

import type { MomentumDb } from "../../adapters/db.js";
import type {
  WorkflowRunImport,
  WorkflowRunImportApproval,
  WorkflowRunImportStep
} from "./run-import.js";
import {
  deriveWorkflowRunState,
  classifyWorkflowLease,
  isTerminalRunState,
  isWorkflowApprovalBoundary,
  workflowApprovalBoundaryRank,
  workflowStepKindsForApprovalBoundary,
  type WorkflowApprovalBoundary,
  type WorkflowLeaseRecord,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord
} from "./run-reducer.js";

export type PersistWorkflowRunImportOptions = {
  now?: number;
};

export type PersistWorkflowRunImportSummary = {
  runId: string;
  source: string;
  state: string;
  approvalBoundary: string | null;
  inserted: boolean;
  stepCount: number;
  approvalCount: number;
};

export function persistWorkflowRunImport(
  db: MomentumDb,
  result: WorkflowRunImport,
  options: PersistWorkflowRunImportOptions = {}
): PersistWorkflowRunImportSummary {
  const now = options.now ?? Date.now();
  const { run, steps, approvals, monitor } = result;
  const monitorTerminal =
    monitor?.terminal == null ? null : monitor.terminal ? 1 : 0;

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT id, approval_boundary FROM workflow_runs WHERE id = ?")
      .get(run.runId) as
      | { id: string; approval_boundary: string | null }
      | undefined;
    const inserted = existing === undefined;
    const existingApprovalRows = db
      .prepare(
        "SELECT boundary, recorded_at FROM workflow_approvals WHERE run_id = ? ORDER BY recorded_at, boundary"
      )
      .all(run.runId) as Array<{ boundary: string; recorded_at: number }>;
    const approvalBoundaryCandidates = [
      approvalBoundaryCandidate(existing?.approval_boundary ?? null, null),
      ...existingApprovalRows.map((approval) =>
        approvalBoundaryCandidate(approval.boundary, approval.recorded_at)
      ),
      approvalBoundaryCandidate(run.approvalBoundary, null),
      ...approvals.map((approval) =>
        approvalBoundaryCandidate(approval.boundary, approval.recordedAt)
      )
    ];
    const hasPersistedApprovals =
      existingApprovalRows.length > 0 || approvals.length > 0;
    const approvedStepKinds = new Set<WorkflowStepKind>();
    let approvalBoundaryCandidateValue: ApprovalBoundaryCandidate | null = null;
    for (const candidate of approvalBoundaryCandidates) {
      if (candidate !== null) {
        approvalBoundaryCandidateValue = highestApprovalBoundaryCandidate(
          approvalBoundaryCandidateValue,
          candidate
        );
        for (const kind of workflowStepKindsForApprovalBoundary(candidate.boundary)) {
          approvedStepKinds.add(kind);
        }
      }
    }
    const approvalBoundary = approvalBoundaryCandidateValue?.boundary ?? null;

    const persistedSteps = steps.map((step) =>
      approvalAdjustedStep(step, approvedStepKinds)
    );
    const provisionalState = hasPersistedApprovals
      ? approvalAdjustedRunState(run.state, persistedSteps)
      : run.state;

    db.prepare(
      `INSERT INTO workflow_runs (
         id, state, source, source_artifact_path, plan_json,
         repo_path, objective, issue_scope_json, route_json,
         approval_boundary, skill_revision,
         monitor_last_seen_state, monitor_terminal, monitor_step,
         monitor_last_seen_digest, monitor_last_emitted_digest,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         source = excluded.source,
         source_artifact_path = excluded.source_artifact_path,
         plan_json = excluded.plan_json,
         repo_path = excluded.repo_path,
         objective = excluded.objective,
         issue_scope_json = excluded.issue_scope_json,
         route_json = excluded.route_json,
         approval_boundary = excluded.approval_boundary,
         skill_revision = excluded.skill_revision,
         monitor_last_seen_state = excluded.monitor_last_seen_state,
         monitor_terminal = excluded.monitor_terminal,
         monitor_step = excluded.monitor_step,
         monitor_last_seen_digest = excluded.monitor_last_seen_digest,
         monitor_last_emitted_digest = excluded.monitor_last_emitted_digest,
         updated_at = excluded.updated_at`
    ).run(
      run.runId,
      provisionalState,
      run.source,
      run.sourceArtifactPath,
      JSON.stringify(run.planJson ?? {}),
      run.repoPath,
      run.objective,
      JSON.stringify(run.issueScope),
      JSON.stringify(run.route),
      approvalBoundary,
      run.skillRevision,
      monitor?.runState ?? null,
      monitorTerminal,
      monitor?.step ?? null,
      monitor?.lastSeenDigest ?? null,
      monitor?.lastEmittedDigest ?? null,
      now,
      now
    );

    const stepStmt = db.prepare(
      `INSERT INTO workflow_steps (
         run_id, step_id, kind, state, step_order, required,
         ledger_offset, error_code, error_message,
         started_at, finished_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, step_id) DO UPDATE SET
         kind = excluded.kind,
         state = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.state
           ELSE excluded.state
         END,
         step_order = excluded.step_order,
         required = excluded.required,
         ledger_offset = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.ledger_offset
           ELSE excluded.ledger_offset
         END,
         error_code = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.error_code
           ELSE excluded.error_code
         END,
         error_message = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.error_message
           ELSE excluded.error_message
         END,
         started_at = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.started_at
           ELSE excluded.started_at
         END,
         finished_at = CASE
           WHEN workflow_steps.operator_transition_at IS NOT NULL THEN workflow_steps.finished_at
           ELSE excluded.finished_at
         END,
         updated_at = excluded.updated_at`
    );
    for (const step of persistedSteps) {
      runStepUpsert(stepStmt, run.runId, step, now);
    }

    const approvalStmt = db.prepare(
      `INSERT INTO workflow_approvals (
         run_id, boundary, actor, phrase, artifact_path, artifact_digest,
         recorded_at, discharged_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, boundary) DO UPDATE SET
         actor = excluded.actor,
         phrase = excluded.phrase,
         artifact_path = excluded.artifact_path,
         artifact_digest = excluded.artifact_digest,
         recorded_at = excluded.recorded_at,
         discharged_at = excluded.discharged_at,
         updated_at = excluded.updated_at
       WHERE excluded.recorded_at >= workflow_approvals.recorded_at`
    );
    for (const approval of approvals) {
      runApprovalUpsert(approvalStmt, run.runId, approval, now);
    }

    const state = resolvePersistedRunState(
      run.state,
      loadWorkflowStepRecords(db, run.runId),
      loadWorkflowLeaseRecords(db, run.runId),
      hasPersistedApprovals,
      now
    );
    if (state !== provisionalState) {
      db.prepare("UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, run.runId);
    }

    db.exec("COMMIT");
    return {
      runId: run.runId,
      source: run.source,
      state,
      approvalBoundary,
      inserted,
      stepCount: steps.length,
      approvalCount: approvals.length
    };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

function loadWorkflowStepRecords(
  db: MomentumDb,
  runId: string
): WorkflowStepRecord[] {
  const rows = db
    .prepare(
      "SELECT step_id, kind, state, step_order, required FROM workflow_steps WHERE run_id = ? ORDER BY step_order, step_id"
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
    state: row.state as WorkflowStepRecord["state"],
    order: row.step_order,
    required: row.required === 1
  }));
}

function resolvePersistedRunState(
  importedState: WorkflowRunState,
  steps: readonly WorkflowStepRecord[],
  leases: readonly WorkflowLeaseRecord[],
  hasPersistedApprovals: boolean,
  now: number
): WorkflowRunState {
  const stepState = deriveWorkflowRunState(steps, { leases, now });
  if (stepState !== "pending") return stepState;
  if (isTerminalRunState(importedState)) {
    return constrainRunStateByLeases(importedState, leases, now);
  }
  const state = hasPersistedApprovals
    ? approvalAdjustedRunState(importedState, steps)
    : importedState;
  return constrainRunStateByLeases(state, leases, now);
}

function constrainRunStateByLeases(
  state: WorkflowRunState,
  leases: readonly WorkflowLeaseRecord[],
  now: number
): WorkflowRunState {
  let anyManualRecovery = false;
  let anyOutstanding = false;
  for (const lease of leases) {
    const classification = classifyWorkflowLease(lease, { now });
    if (classification === "released") continue;
    anyOutstanding = true;
    if (classification === "stale-manual-recovery-required") {
      anyManualRecovery = true;
    }
  }
  if (anyManualRecovery && state !== "failed" && state !== "canceled") {
    return "blocked";
  }
  if (state === "succeeded" && anyOutstanding) {
    return "running";
  }
  return state;
}

function loadWorkflowLeaseRecords(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, released_at, stale_policy
         FROM workflow_leases WHERE run_id = ? ORDER BY lease_kind`
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

type PreparedStatement = ReturnType<MomentumDb["prepare"]>;

type ApprovalBoundaryCandidate = {
  boundary: WorkflowApprovalBoundary;
  recordedAt: number | null;
};

function approvalBoundaryCandidate(
  boundary: string | null,
  recordedAt: number | null
): ApprovalBoundaryCandidate | null {
  if (boundary === null || !isWorkflowApprovalBoundary(boundary)) return null;
  return { boundary, recordedAt };
}

function highestApprovalBoundaryCandidate(
  current: ApprovalBoundaryCandidate | null,
  next: ApprovalBoundaryCandidate
): ApprovalBoundaryCandidate {
  if (current === null) return next;
  const currentRank = workflowApprovalBoundaryRank(current.boundary);
  const nextRank = workflowApprovalBoundaryRank(next.boundary);
  if (currentRank !== nextRank) return currentRank > nextRank ? current : next;
  if (current.recordedAt === null) return next;
  if (next.recordedAt === null) return current;
  return current.recordedAt > next.recordedAt ? current : next;
}

function runStepUpsert(
  stmt: PreparedStatement,
  runId: string,
  step: WorkflowRunImportStep,
  now: number
): void {
  stmt.run(
    runId,
    step.stepId,
    step.kind,
    step.state,
    step.order,
    step.required ? 1 : 0,
    step.ledgerOffset,
    step.errorCode,
    step.errorMessage,
    step.startedAt,
    step.finishedAt,
    now,
    now
  );
}

function approvalAdjustedStep(
  step: WorkflowRunImportStep,
  approvedStepKinds: ReadonlySet<WorkflowStepKind>
): WorkflowRunImportStep {
  if (step.state !== "pending" || !approvedStepKinds.has(step.kind)) {
    return step;
  }
  return { ...step, state: "approved" };
}

function approvalAdjustedRunState(
  importedState: WorkflowRunState,
  steps: readonly WorkflowStepRecord[]
): WorkflowRunState {
  if (isTerminalRunState(importedState)) return importedState;
  const state = deriveWorkflowRunState(steps);
  return state === "pending" ? "approved" : state;
}

function runApprovalUpsert(
  stmt: PreparedStatement,
  runId: string,
  approval: WorkflowRunImportApproval,
  now: number
): void {
  stmt.run(
    runId,
    approval.boundary,
    approval.actor,
    approval.phrase,
    approval.artifactPath,
    approval.artifactDigest,
    approval.recordedAt,
    approval.dischargedAt,
    now,
    now
  );
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in transaction; nothing to do.
  }
}
