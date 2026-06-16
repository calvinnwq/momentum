/**
 * Persistence layer for the workflow-first run start surface (M10-02, NGX-346).
 *
 * Takes the pure {@link WorkflowRunStartInput} owned by `workflow-run-start.ts`,
 * materializes it through {@link materializeWorkflowRunStart}, and writes the
 * resulting `WorkflowRun` + `StepRun` plan into the durable `workflow_runs` /
 * `workflow_steps` tables, with a `workflow_approvals` row when the start has an
 * approval boundary. This is the storage twin of the pure materializer:
 * nothing here runs executors, schedules work, or starts a Goal loop. Scheduling
 * is owned separately by `workflow-scheduler.ts`; the landed goal-loop and
 * one-shot / script / no-mistakes mirror adapters attach through executor-loop
 * persistence rather than this start persistence layer. `goal start` stays the
 * compatibility path for old Goal-loop usage and is untouched.
 *
 * Stable contracts this slice locks in:
 *   - A run's durable identity is its `id` (= `runId`); a step's is
 *     `(run_id, step_id)`. The persisted row set mirrors the materialized plan
 *     exactly: one `workflow_steps` row per definition step, in `order`.
 *   - The run records the `(workflow_definition_key, workflow_definition_version)`
 *     link back to the recipe it was started from (the columns added by
 *     `migrations.ts`), so durable state proves which definition produced it.
 *   - Persistence is materialize-gated: an invalid input is rejected by
 *     {@link materializeWorkflowRunStart} and throws an
 *     {@link InvalidWorkflowRunStartError} *before* any row is written, so a bad
 *     start can never leave partial state behind.
 *   - A start creates a *fresh* run: if the `runId` already exists this refuses
 *     with {@link WorkflowRunStartConflictError} and leaves the existing run
 *     untouched, rather than clobbering a live run's step progress. (A durable
 *     run row is the proof of start; re-starting the same id is a double-trigger,
 *     not an idempotent re-ingest like `workflow import`.)
 */

import crypto from "node:crypto";

import { isUniqueViolation, type MomentumDb } from "../../adapters/db.js";
import {
  materializeWorkflowRunStart,
  type WorkflowRunStartError,
  type WorkflowRunStartInput
} from "./run-start.js";
import type {
  WorkflowApprovalBoundary,
  WorkflowRunState
} from "./run-reducer.js";

/**
 * Thrown by {@link persistWorkflowRunStart} when the supplied input does not
 * materialize into a valid run plan. Carries the full typed refusal list so
 * callers can surface a complete diagnostic.
 */
export class InvalidWorkflowRunStartError extends Error {
  readonly errors: readonly WorkflowRunStartError[];

  constructor(errors: readonly WorkflowRunStartError[]) {
    super(
      `Invalid workflow run start: ${errors.map((e) => e.code).join(", ")}`
    );
    this.name = "InvalidWorkflowRunStartError";
    this.errors = errors;
  }
}

/**
 * Thrown by {@link persistWorkflowRunStart} when a run with the requested
 * `runId` already exists. A run start creates a fresh run; the existing run is
 * left untouched.
 */
export class WorkflowRunStartConflictError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow run already exists: ${runId}`);
    this.name = "WorkflowRunStartConflictError";
    this.runId = runId;
  }
}

export type PersistWorkflowRunStartSummary = {
  runId: string;
  source: string;
  state: WorkflowRunState;
  approvalBoundary: WorkflowApprovalBoundary | null;
  definitionKey: string;
  definitionVersion: number;
  stepCount: number;
  inserted: boolean;
};

/**
 * Materialize and durably persist a workflow run start.
 *
 * @throws {InvalidWorkflowRunStartError} if `input` fails to materialize; no
 * rows are written in that case.
 * @throws {WorkflowRunStartConflictError} if a run with the same `runId` already
 * exists; the existing run is left untouched.
 */
export function persistWorkflowRunStart(
  db: MomentumDb,
  input: WorkflowRunStartInput
): PersistWorkflowRunStartSummary {
  const result = materializeWorkflowRunStart(input);
  if (!result.ok) {
    throw new InvalidWorkflowRunStartError(result.errors);
  }
  const { run, steps } = result.plan;

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT id FROM workflow_runs WHERE id = ?")
      .get(run.runId) as { id: string } | undefined;
    if (existing !== undefined) {
      throw new WorkflowRunStartConflictError(run.runId);
    }

    db.prepare(
      `INSERT INTO workflow_runs (
         id, state, source, plan_json,
         repo_path, objective, issue_scope_json, route_json,
         approval_boundary, skill_revision,
         workflow_definition_key, workflow_definition_version,
         started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.runId,
      run.state,
      run.source,
      "{}",
      run.repoPath,
      run.objective,
      JSON.stringify(run.issueScope),
      JSON.stringify(run.route),
      run.approvalBoundary,
      run.skillRevision,
      run.definitionKey,
      run.definitionVersion,
      run.startedAt,
      run.createdAt,
      run.updatedAt
    );

    const stepStmt = db.prepare(
      `INSERT INTO workflow_steps (
         run_id, step_id, kind, state, step_order, required,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const step of steps) {
      stepStmt.run(
        run.runId,
        step.stepId,
        step.kind,
        step.state,
        step.order,
        step.required ? 1 : 0,
        run.createdAt,
        run.updatedAt
      );
    }

    if (run.approvalBoundary !== null) {
      const phrase = `workflow run start --approval-boundary ${run.approvalBoundary}`;
      const artifactPath = `workflow-run-start://${run.runId}/${run.approvalBoundary}`;
      const artifactDigest = crypto
        .createHash("sha256")
        .update(`start:${run.runId}:${run.approvalBoundary}:${phrase}`)
        .digest("hex");

      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.runId,
        run.approvalBoundary,
        run.source,
        phrase,
        artifactPath,
        artifactDigest,
        run.createdAt,
        null,
        run.createdAt,
        run.updatedAt
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    if (isUniqueViolation(error)) {
      throw new WorkflowRunStartConflictError(run.runId);
    }
    throw error;
  }

  return {
    runId: run.runId,
    source: run.source,
    state: run.state,
    approvalBoundary: run.approvalBoundary,
    definitionKey: run.definitionKey,
    definitionVersion: run.definitionVersion,
    stepCount: steps.length,
    inserted: true
  };
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in transaction; nothing to do.
  }
}
