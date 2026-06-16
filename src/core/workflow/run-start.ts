/**
 * Pure workflow run-start materialization for the workflow-first runtime
 * (M10-02, NGX-346).
 *
 * This module owns the *pure* translation of a validated
 * {@link WorkflowDefinition} graph into the in-memory `WorkflowRun` /
 * `StepRun` shape that a run start persists. It follows the same discipline as
 * `definition.ts` and `run-import.ts`: no SQLite, no file
 * system, no executor invocation, no wall-clock reads. Durable persistence into
 * `workflow_runs` / `workflow_steps` is layered on top in
 * `run-start-persist.ts`, and the CLI `workflow run start` surface
 * calls that persistence layer. Executor records, the opt-in daemon scheduler
 * lane, and executor adapter dispatch are layered separately; this pure
 * materializer does not run the landed goal-loop / one-shot / script /
 * no-mistakes mirror adapters.
 *
 * Scope decisions pinned here, grounded in the accepted planning contracts
 * (internal/contracts/workflow-first-runtime.md "Run start" gap row and
 * internal/contracts/executor-loop.md):
 *
 *   - A run's durable step rows mirror the definition graph exactly: one
 *     {@link WorkflowStepRecord} per {@link StepDefinition}, materialized in
 *     `order`. The step's `stepId` is the definition's stable `key`, which is
 *     unique within a definition, so `(runId, stepId)` is a safe durable
 *     identity for `workflow_steps`.
 *   - Approval boundaries are preserved at start: a supplied boundary promotes
 *     every step whose `kind` it covers (per
 *     {@link workflowStepKindsForApprovalBoundary}) from `pending` to
 *     `approved`, exactly mirroring the M7 import-persist approval adjustment.
 *     The run state is then derived from those step rows with the existing
 *     reducer, so a fresh run with an approval boundary opens `approved` and an
 *     unapproved run opens `pending`.
 *   - The executor *loop* is out of scope for this slice (NGX-346 non-goal): a
 *     materialized step carries only the canonical `WorkflowStepRecord` fields
 *     the M7 substrate already persists. Per-step executor selection arrives
 *     with `ExecutorDefinition` in M10-03 (NGX-347).
 */

import { isSafeWorkflowRunPathSegment } from "./recovery-artifact.js";
import {
  validateWorkflowDefinition,
  type WorkflowDefinition
} from "./definition.js";
import {
  deriveWorkflowRunState,
  isWorkflowApprovalBoundary,
  workflowStepKindsForApprovalBoundary,
  type WorkflowApprovalBoundary,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord
} from "./run-reducer.js";

/**
 * Default `workflow_runs.source` value for a run started from a workflow
 * definition. Callers (the persistence / CLI slices) may override it to record
 * a narrower provenance (e.g. an operator CLI invocation).
 */
export const WORKFLOW_RUN_START_SOURCE = "workflow-definition" as const;

export const WORKFLOW_RUN_START_ERROR_CODES = [
  "definition_invalid",
  "run_id_invalid",
  "repo_path_invalid",
  "objective_invalid",
  "approval_boundary_invalid",
  "issue_scope_invalid",
  "route_invalid"
] as const;
export type WorkflowRunStartErrorCode =
  (typeof WORKFLOW_RUN_START_ERROR_CODES)[number];

export type WorkflowRunStartError = {
  code: WorkflowRunStartErrorCode;
  message: string;
  path?: string;
};

/**
 * Parameters needed to start a workflow run from a definition. `definition` is
 * accepted as `unknown` and re-validated defensively so an invalid recipe
 * refuses with `definition_invalid` rather than producing a half-formed run.
 */
export type WorkflowRunStartInput = {
  definition: unknown;
  runId: string;
  repoPath: string;
  objective: string;
  now: number;
  issueScope?: Record<string, unknown>;
  route?: Record<string, unknown>;
  approvalBoundary?: string | null;
  skillRevision?: string | null;
  source?: string;
};

/**
 * The materialized `WorkflowRun` row fields. Mirrors the durable
 * `workflow_runs` columns this slice will persist, plus the `(definitionKey,
 * definitionVersion)` link back to the recipe the run was started from.
 */
export type WorkflowRunStartRun = {
  runId: string;
  source: string;
  state: WorkflowRunState;
  repoPath: string;
  objective: string;
  issueScope: Record<string, unknown>;
  route: Record<string, unknown>;
  approvalBoundary: WorkflowApprovalBoundary | null;
  skillRevision: string | null;
  definitionKey: string;
  definitionVersion: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
};

export type WorkflowRunStartPlan = {
  run: WorkflowRunStartRun;
  steps: WorkflowStepRecord[];
};

export type WorkflowRunStartResult =
  | { ok: true; plan: WorkflowRunStartPlan }
  | { ok: false; errors: WorkflowRunStartError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Materialize a {@link WorkflowRunStartPlan} from a validated
 * {@link WorkflowDefinition} and run-start parameters. Collects every problem
 * (definition first, then each parameter in declared order) so callers can
 * surface a complete refusal rather than one error at a time, matching
 * {@link validateWorkflowDefinition}.
 */
export function materializeWorkflowRunStart(
  input: WorkflowRunStartInput
): WorkflowRunStartResult {
  const errors: WorkflowRunStartError[] = [];

  const validation = validateWorkflowDefinition(input.definition);
  if (!validation.ok) {
    errors.push({
      code: "definition_invalid",
      message: `Workflow definition is invalid: ${validation.errors
        .map((e) => e.code)
        .join(", ")}.`,
      path: "definition"
    });
  }

  if (!isSafeWorkflowRunPathSegment(input.runId)) {
    errors.push({
      code: "run_id_invalid",
      message: "Run id must be a non-empty, path-safe segment.",
      path: "runId"
    });
  }

  if (!isNonBlankString(input.repoPath)) {
    errors.push({
      code: "repo_path_invalid",
      message: "Repo path must be a non-empty string.",
      path: "repoPath"
    });
  }

  if (!isNonBlankString(input.objective)) {
    errors.push({
      code: "objective_invalid",
      message: "Objective must be a non-empty string.",
      path: "objective"
    });
  }

  const approvalBoundary = input.approvalBoundary ?? null;
  if (approvalBoundary !== null && !isWorkflowApprovalBoundary(approvalBoundary)) {
    errors.push({
      code: "approval_boundary_invalid",
      message: "Approval boundary is not a known workflow approval boundary.",
      path: "approvalBoundary"
    });
  }

  if (input.issueScope !== undefined && !isPlainObject(input.issueScope)) {
    errors.push({
      code: "issue_scope_invalid",
      message: "Issue scope must be a plain object.",
      path: "issueScope"
    });
  }

  if (input.route !== undefined && !isPlainObject(input.route)) {
    errors.push({
      code: "route_invalid",
      message: "Route must be a plain object.",
      path: "route"
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const definition = validation.ok
    ? validation.definition
    : (input.definition as WorkflowDefinition);
  const resolvedBoundary = approvalBoundary as WorkflowApprovalBoundary | null;
  const approvedKinds: ReadonlySet<WorkflowStepKind> =
    resolvedBoundary === null
      ? new Set<WorkflowStepKind>()
      : new Set(workflowStepKindsForApprovalBoundary(resolvedBoundary));

  const steps: WorkflowStepRecord[] = [...definition.steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      stepId: step.key,
      kind: step.kind,
      state: approvedKinds.has(step.kind) ? "approved" : "pending",
      order: step.order,
      required: step.required
    }));
  const derivedRunState = deriveWorkflowRunState(steps);

  const run: WorkflowRunStartRun = {
    runId: input.runId,
    source: input.source ?? WORKFLOW_RUN_START_SOURCE,
    state:
      resolvedBoundary !== null && derivedRunState === "pending"
        ? "approved"
        : derivedRunState,
    repoPath: input.repoPath,
    objective: input.objective,
    issueScope: input.issueScope ?? {},
    route: input.route ?? {},
    approvalBoundary: resolvedBoundary,
    skillRevision: input.skillRevision ?? null,
    definitionKey: definition.key,
    definitionVersion: definition.version,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null
  };

  return { ok: true, plan: { run, steps } };
}
