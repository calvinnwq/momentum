/**
 * Persistence layer for the workflow-first run start surface.
 *
 * Takes the pure {@link WorkflowRunStartInput} owned by `run/start.ts`,
 * materializes it through {@link materializeWorkflowRunStart}, and writes the
 * resulting `WorkflowRun` + `StepRun` plan into the durable `workflow_runs` /
 * `workflow_steps` tables, with a `workflow_approvals` row when the start has an
 * approval boundary, and persists route state through the adapter-owned canonical
 * destinations; `workflow_runs` carries no route column at all.
 * This is the storage twin of the pure materializer:
 * nothing here runs executors, schedules work, or starts a Goal loop. Scheduling
 * is owned separately by `dispatch/scheduler.ts`; the native agent-loop,
 * agent-once / script SDK paths and the legacy no-mistakes mirror /
 * delegate-supervisor binding-backed paths attach through executor-loop
 * persistence rather than this start persistence layer. The retired goal-first
 * lane no longer starts work;
 * durable Goal rows remain readable state.
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

import { isUniqueViolation, type MomentumDb } from "../../../adapters/db.js";
import {
  RouteStateMigrationError,
  validateWorkflowRouteLineage,
  validateWorkflowRouteShape,
  validateWorkflowRouteStepProjection,
  writeCanonicalWorkflowRunRouteState,
} from "../../../adapters/db/route-state.js";
import {
  readCodingStepRouteOverrides,
  resolveCodingStepAgentConfigs,
} from "../route/coding.js";
import {
  materializeWorkflowRunStart,
  MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
  type WorkflowRunStartError,
  type WorkflowRunStartInput,
} from "./start.js";
import type { WorkflowApprovalBoundary, WorkflowRunState } from "./reducer.js";
import {
  CODING_WORKFLOW_DEFINITION_KEY,
  type WorkflowDefinition,
} from "../definition/definition.js";

/**
 * Thrown by {@link persistWorkflowRunStart} when the supplied input does not
 * materialize into a valid run plan. Carries the full typed refusal list so
 * callers can surface a complete diagnostic.
 */
export class InvalidWorkflowRunStartError extends Error {
  readonly errors: readonly WorkflowRunStartError[];

  constructor(errors: readonly WorkflowRunStartError[]) {
    super(
      `Invalid workflow run start: ${errors.map((e) => e.code).join(", ")}`,
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
  input: WorkflowRunStartInput,
): PersistWorkflowRunStartSummary {
  const result = materializeWorkflowRunStart(input);
  if (!result.ok) {
    throw new InvalidWorkflowRunStartError(result.errors);
  }
  const { run, steps } = result.plan;
  const definition = input.definition as WorkflowDefinition;
  const isNativeCodingRun =
    run.source === MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE &&
    run.definitionKey === CODING_WORKFLOW_DEFINITION_KEY;
  const definitionAgentConfigs = new Map(
    definition.steps.flatMap((step) =>
      step.agentConfig === undefined
        ? []
        : [[step.key, step.agentConfig] as const],
    ),
  );
  const routeOverrides = isNativeCodingRun
    ? readCodingStepRouteOverrides(run.route)
    : { ok: true as const, overrides: {} };
  if (!routeOverrides.ok) {
    throw new InvalidWorkflowRunStartError([
      {
        code: "route_invalid",
        message: routeOverrides.reason,
        ...(routeOverrides.path === undefined
          ? {}
          : { path: routeOverrides.path }),
      },
    ]);
  }
  const canonicalAgentConfigs = isNativeCodingRun
    ? resolveCodingStepAgentConfigs(
        definition.steps,
        steps,
        routeOverrides.overrides,
      )
    : undefined;
  try {
    validateWorkflowRouteShape({
      runId: run.runId,
      source: run.source,
      route: run.route,
    });
    validateWorkflowRouteStepProjection({
      runId: run.runId,
      route: run.route,
      steps: steps.map((step) => ({
        kind: step.kind,
        agentConfig: definitionAgentConfigs?.get(step.stepId),
      })),
    });
    validateWorkflowRouteLineage(db, {
      runId: run.runId,
      source: run.source,
      route: run.route,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.lineage === null ? {} : { lineage: run.lineage }),
    });
  } catch (error) {
    throw invalidStartFromRouteStateError(error);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    validateWorkflowRouteLineage(db, {
      runId: run.runId,
      source: run.source,
      route: run.route,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.lineage === null ? {} : { lineage: run.lineage }),
    });
    const existing = db
      .prepare("SELECT id FROM workflow_runs WHERE id = ?")
      .get(run.runId) as { id: string } | undefined;
    if (existing !== undefined) {
      throw new WorkflowRunStartConflictError(run.runId);
    }

    db.prepare(
      `INSERT INTO workflow_runs (
         id, state, source, plan_json,
         repo_path, objective, issue_scope_json,
         approval_boundary, skill_revision,
         workflow_definition_key, workflow_definition_version,
         started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.runId,
      run.state,
      run.source,
      "{}",
      run.repoPath,
      run.objective,
      JSON.stringify(run.issueScope),
      run.approvalBoundary,
      run.skillRevision,
      run.definitionKey,
      run.definitionVersion,
      run.startedAt,
      run.createdAt,
      run.updatedAt,
    );

    const stepStmt = db.prepare(
      `INSERT INTO workflow_steps (
         run_id, step_id, kind, state, step_order, required,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.updatedAt,
      );
    }

    writeCanonicalWorkflowRunRouteState(db, {
      runId: run.runId,
      source: run.source,
      route: run.route,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.lineage === null ? {} : { lineage: run.lineage }),
      ...(definitionAgentConfigs === undefined
        ? {}
        : { definitionAgentConfigs }),
      ...(canonicalAgentConfigs === undefined ? {} : { canonicalAgentConfigs }),
      definitionExecutorConfigs: new Map(
        definition.steps.flatMap((step) =>
          step.config === undefined ? [] : [[step.key, step.config] as const],
        ),
      ),
    });

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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.updatedAt,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    if (isUniqueViolation(error)) {
      throw new WorkflowRunStartConflictError(run.runId);
    }
    if (error instanceof RouteStateMigrationError) {
      throw invalidStartFromRouteStateError(error);
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
    inserted: true,
  };
}

/**
 * Map an adapter route-state refusal onto the start refusal taxonomy: lineage
 * validation failures surface as `lineage_invalid` (the explicit start input
 * they now guard), everything else stays `route_invalid`. Non-route-state
 * errors pass through unchanged.
 */
function invalidStartFromRouteStateError(error: unknown): unknown {
  if (!(error instanceof RouteStateMigrationError)) return error;
  const lineageCodes = new Set([
    "route_state_lineage_invalid",
    "route_state_lineage_parent_missing",
  ]);
  return new InvalidWorkflowRunStartError([
    {
      code: lineageCodes.has(error.code) ? "lineage_invalid" : "route_invalid",
      message: error.message,
      path: error.jsonPath,
    },
  ]);
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in transaction; nothing to do.
  }
}
