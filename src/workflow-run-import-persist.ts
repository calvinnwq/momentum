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
 *   - `monitor.json` stays advisory: the persistence layer never writes a
 *     `workflow_leases` row from monitor snapshots. Durable leases come from
 *     live executors / managed-step dispatch, not from static import.
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

import type { MomentumDb } from "./db.js";
import type {
  WorkflowRunImport,
  WorkflowRunImportApproval,
  WorkflowRunImportStep
} from "./workflow-run-import.js";
import {
  deriveWorkflowRunState,
  isTerminalRunState,
  isWorkflowApprovalBoundary,
  workflowApprovalBoundaryRank,
  workflowStepKindsForApprovalBoundary,
  type WorkflowApprovalBoundary,
  type WorkflowRunState,
  type WorkflowStepKind
} from "./workflow-run-reducer.js";

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
  const { run, steps, approvals } = result;

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
    const state = hasPersistedApprovals
      ? approvalAdjustedRunState(run.state, persistedSteps)
      : run.state;

    db.prepare(
      `INSERT INTO workflow_runs (
         id, state, source, source_artifact_path, plan_json,
         repo_path, objective, issue_scope_json, route_json,
         approval_boundary, skill_revision,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         updated_at = excluded.updated_at`
    ).run(
      run.runId,
      state,
      run.source,
      run.sourceArtifactPath,
      JSON.stringify(run.planJson ?? {}),
      run.repoPath,
      run.objective,
      JSON.stringify(run.issueScope),
      JSON.stringify(run.route),
      approvalBoundary,
      run.skillRevision,
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
         state = excluded.state,
         step_order = excluded.step_order,
         required = excluded.required,
         ledger_offset = excluded.ledger_offset,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
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
  steps: readonly WorkflowRunImportStep[]
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
