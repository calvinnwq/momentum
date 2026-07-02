/**
 * Pure workflow run-start materialization for the workflow-first runtime
 * (M10-02, NGX-346).
 *
 * This module owns the *pure* translation of a validated
 * {@link WorkflowDefinition} graph into the in-memory `WorkflowRun` /
 * `StepRun` shape that a run start persists. It follows the same discipline as
 * `definition/definition.ts` and `run/import.ts`: no SQLite, no file
 * system, no executor invocation, no wall-clock reads. Durable persistence into
 * `workflow_runs` / `workflow_steps` is layered on top in
 * `run/start-persist.ts`, and the CLI `workflow run start` surface
 * calls that persistence layer. Executor records, the opt-in daemon scheduler
 * lane, and executor adapter dispatch are layered separately; this pure
 * materializer does not run the landed goal-loop / one-shot / script /
 * no-mistakes mirror adapters. The coding plan preview in this module enriches
 * the projected steps with definition executor families for operator inspection,
 * but it still does not invoke any executor or write durable state.
 *
 * Scope decisions pinned here, grounded in the compact Runtime Model and
 * Workflow Safety anchors in SPEC.md plus the long-form planning contracts
 * externalized to Obsidian:
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
 *   - Durable run-start materialization carries only the canonical
 *     `WorkflowStepRecord` fields the substrate persists; the coding preview
 *     separately joins the executor family from the validated definition so the
 *     no-write plan can show how each step would dispatch.
 */

import { isSafeWorkflowRunPathSegment } from "../recovery/artifact.js";
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowExecutorFamily
} from "../definition/definition.js";
import {
  deriveWorkflowRunState,
  isWorkflowApprovalBoundary,
  workflowStepKindsForApprovalBoundary,
  type WorkflowApprovalBoundary,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "./reducer.js";

/**
 * Default `workflow_runs.source` value for a run started from a workflow
 * definition. Callers (the persistence / CLI slices) may override it to record
 * a narrower provenance (e.g. an operator CLI invocation).
 */
export const WORKFLOW_RUN_START_SOURCE = "workflow-definition" as const;

/**
 * `workflow_runs.source` value for a run started through the explicit
 * Momentum-native coding-workflow door (`workflow run start-coding`), and the
 * matching source marker shown by the read-only `workflow run preview-coding`
 * plan. It marks durable native runs as unmistakably Momentum-owned primary
 * state, so status / handoff / monitor / logs can distinguish them from both the
 * generic definition-sourced start (`workflow-definition`) and imported CWFP
 * compatibility runs (`agent-workflow`).
 */
export const MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE =
  "momentum-native-coding" as const;

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

/**
 * One step of a frozen coding-workflow plan preview. It carries the canonical
 * {@link WorkflowStepRecord} fields plus the step's {@link WorkflowExecutorFamily}
 * joined from the definition, so an operator can read which executor family will
 * power each step before the run is approved or executed.
 */
export type WorkflowCodingPlanStep = {
  stepId: string;
  kind: WorkflowStepKind;
  executor: WorkflowExecutorFamily;
  order: number;
  required: boolean;
  state: WorkflowStepState;
};

/**
 * A frozen, pre-execution preview of the coding workflow a native start would
 * materialize. It is a pure projection of the version-pinned
 * {@link WorkflowDefinition} plus the run-start parameters: the same definition
 * key/version, repo, objective, issue scope, route, and approval boundary a
 * `workflow run start-coding` would durably persist. Because the projection is
 * deterministic and the built-in definition is immutable per version, the same
 * preview can be reconstructed from the durable run later for approval/dispatch
 * to reference - the preview never carries wall-clock fields, so it is stable
 * enough to show before approval.
 */
export type WorkflowCodingPlanPreview = {
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
  steps: WorkflowCodingPlanStep[];
};

export type WorkflowCodingPlanPreviewResult =
  | { ok: true; preview: WorkflowCodingPlanPreview }
  | { ok: false; errors: WorkflowRunStartError[] };

/**
 * Materialize a {@link WorkflowCodingPlanPreview} from the same
 * {@link WorkflowRunStartInput} a native coding start would use, without touching
 * any durable state. It reuses {@link materializeWorkflowRunStart} for the run /
 * step shape (so the preview matches exactly what a start would persist) and
 * enriches each step with the executor family declared on the definition. Invalid
 * inputs surface the same refusal taxonomy as a start.
 */
export function materializeWorkflowCodingPlanPreview(
  input: WorkflowRunStartInput
): WorkflowCodingPlanPreviewResult {
  const result = materializeWorkflowRunStart(input);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  // `materializeWorkflowRunStart` succeeded, so `input.definition` is a valid
  // `WorkflowDefinition`; build the executor lookup from it by stable step key.
  const definition = input.definition as WorkflowDefinition;
  const executorByStepKey = new Map<string, WorkflowExecutorFamily>(
    definition.steps.map((step) => [step.key, step.executor])
  );

  const { run } = result.plan;
  const steps: WorkflowCodingPlanStep[] = result.plan.steps.map((step) => ({
    stepId: step.stepId,
    kind: step.kind,
    executor: executorByStepKey.get(step.stepId) as WorkflowExecutorFamily,
    order: step.order,
    required: step.required,
    state: step.state
  }));

  return {
    ok: true,
    preview: {
      runId: run.runId,
      source: run.source,
      state: run.state,
      repoPath: run.repoPath,
      objective: run.objective,
      issueScope: run.issueScope,
      route: run.route,
      approvalBoundary: run.approvalBoundary,
      skillRevision: run.skillRevision,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      steps
    }
  };
}
