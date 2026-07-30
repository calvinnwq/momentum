/**
 * Pure workflow run-start materialization for the workflow-first runtime
 *.
 *
 * This module owns the *pure* translation of a validated
 * {@link WorkflowDefinition} graph into the in-memory `WorkflowRun` /
 * `StepRun` shape that a run start persists. It follows the same discipline as
 * `definition/definition.ts` and `run/import.ts`: no SQLite, no file
 * system, no executor attempt, no wall-clock reads. Durable persistence into
 * `workflow_runs` / `workflow_steps` is layered on top in
 * `run/start-persist.ts`, and the CLI `workflow run start` surface
 * calls that persistence layer. Executor records, the opt-in daemon scheduler
 * lane, and executor adapter dispatch are layered separately; this pure
 * materializer does not run the landed agent-loop / agent-once / script /
 * no-mistakes mirror adapters or delegate-supervisor. The coding plan preview
 * in this module enriches
 * the projected steps with definition executor identities, optional portable
 * config, and effective agent config for operator inspection, but it still does
 * not invoke any executor or write durable state.
 *
 * Scope decisions pinned here, grounded in the compact Runtime Model and
 * Workflow Safety anchors in SPEC.md plus the long-form planning contracts
 * externalized to the personal wiki:
 *
 *   - A run's durable step rows mirror the definition graph exactly: one
 *     {@link WorkflowStepRecord} per {@link StepDefinition}, materialized in
 *     `order`. The step's `stepId` is the definition's stable `key`, which is
 *     unique within a definition, so `(runId, stepId)` is a safe durable
 *     identity for `workflow_steps`.
 *   - Approval boundaries are preserved at start: a supplied boundary promotes
 *     every step whose `kind` it covers (per
 *     {@link workflowStepKindsForApprovalBoundary}) from `pending` to
 *     `approved`, exactly mirroring the workflow-run import-persist approval adjustment.
 *     The run state is then derived from those step rows with the existing
 *     reducer, so a fresh run with an approval boundary opens `approved` and an
 *     unapproved run opens `pending`.
 *   - Durable run-start materialization carries only the canonical
 *     `WorkflowStepRecord` fields the substrate persists; the coding preview
 *     separately joins the executor identity, optional portable config, and
 *     effective agent config from the validated definition and native route so the
 *     no-write plan can show how each step would dispatch.
 */

import { isDeepStrictEqual } from "node:util";

import { isSafeWorkflowRunPathSegment } from "../recovery/artifact.js";
import { CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY } from "../route/coding.js";
import {
  BUILT_IN_WORKFLOW_DEFINITIONS,
  validateWorkflowDefinition,
  type ExecutorName,
  type WorkflowDefinition,
} from "../definition/definition.js";
import {
  canonicalWorkflowStepKind,
  effectiveStepExecutor,
  type EffectiveExecutorOptions,
} from "../definition/legacy.js";
import {
  readCodingStepRouteOverrides,
  resolveCodingStepAgentConfigs,
  type CodingStepRouteOverride,
} from "../route/coding.js";
import {
  deriveWorkflowRunState,
  isWorkflowApprovalBoundary,
  workflowStepKindsForApprovalBoundary,
  type WorkflowApprovalBoundary,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState,
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
  "route_invalid",
  "lineage_invalid",
] as const;
export type WorkflowRunStartErrorCode =
  (typeof WORKFLOW_RUN_START_ERROR_CODES)[number];

export type WorkflowRunStartError = {
  code: WorkflowRunStartErrorCode;
  message: string;
  path?: string;
};

/**
 * The explicit canonical lineage a subworkflow child-run start supplies: the
 * parent run + dispatched step that launches the child, the child's nesting
 * depth, and its root-first subworkflow ancestry. Persisted as the child's
 * `workflow_run_lineage` row in the same transaction as the run itself; the
 * retired `route.subworkflow` namespace is no longer accepted at start.
 */
export type WorkflowRunStartLineage = {
  parentRunId: string;
  parentStepId: string;
  depth: number;
  ancestorDefinitionKeys: readonly string[];
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
  lineage?: WorkflowRunStartLineage;
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
  lineage: WorkflowRunStartLineage | null;
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
  input: WorkflowRunStartInput,
): WorkflowRunStartResult {
  const errors: WorkflowRunStartError[] = [];

  const allowLegacyStepKinds = isKnownRetainedBuiltInDefinition(
    input.definition,
  );
  const validation = validateWorkflowDefinition(input.definition, {
    allowLegacyStepKinds,
  });
  if (!validation.ok) {
    errors.push({
      code: "definition_invalid",
      message: `Workflow definition is invalid: ${validation.errors
        .map((e) => e.code)
        .join(", ")}.`,
      path: "definition",
    });
  }

  if (!isSafeWorkflowRunPathSegment(input.runId)) {
    errors.push({
      code: "run_id_invalid",
      message: "Run id must be a non-empty, path-safe segment.",
      path: "runId",
    });
  }

  if (!isNonBlankString(input.repoPath)) {
    errors.push({
      code: "repo_path_invalid",
      message: "Repo path must be a non-empty string.",
      path: "repoPath",
    });
  }

  if (!isNonBlankString(input.objective)) {
    errors.push({
      code: "objective_invalid",
      message: "Objective must be a non-empty string.",
      path: "objective",
    });
  }

  const approvalBoundary = input.approvalBoundary ?? null;
  if (
    approvalBoundary !== null &&
    !isWorkflowApprovalBoundary(approvalBoundary)
  ) {
    errors.push({
      code: "approval_boundary_invalid",
      message: "Approval boundary is not a known workflow approval boundary.",
      path: "approvalBoundary",
    });
  }

  if (input.issueScope !== undefined && !isPlainObject(input.issueScope)) {
    errors.push({
      code: "issue_scope_invalid",
      message: "Issue scope must be a plain object.",
      path: "issueScope",
    });
  }

  if (input.route !== undefined && !isPlainObject(input.route)) {
    errors.push({
      code: "route_invalid",
      message: "Route must be a plain object.",
      path: "route",
    });
  } else if (input.route !== undefined && "subworkflow" in input.route) {
    errors.push({
      code: "route_invalid",
      message:
        "The route.subworkflow start namespace is retired; supply child lineage through the explicit lineage input.",
      path: "route.subworkflow",
    });
  }

  errors.push(...validateStartLineage(input.lineage, input.runId));

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
    .map((step) => {
      // Runtime step rows carry only canonical kinds: a retained definition's
      // legacy spelling projects through the shared legacy alias map here.
      const kind =
        canonicalWorkflowStepKind(step.kind) ?? (step.kind as WorkflowStepKind);
      return {
        stepId: step.key,
        kind,
        state: approvedKinds.has(kind) ? "approved" : "pending",
        order: step.order,
        required: step.required,
      };
    });
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
    lineage: input.lineage ?? null,
    approvalBoundary: resolvedBoundary,
    skillRevision: input.skillRevision ?? null,
    definitionKey: definition.key,
    definitionVersion: definition.version,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
  };

  return { ok: true, plan: { run, steps } };
}

const START_LINEAGE_KEYS = new Set([
  "parentRunId",
  "parentStepId",
  "depth",
  "ancestorDefinitionKeys",
]);

function validateStartLineage(
  lineage: unknown,
  runId: string,
): WorkflowRunStartError[] {
  if (lineage === undefined) return [];
  const invalid = (message: string): WorkflowRunStartError[] => [
    { code: "lineage_invalid", message, path: "lineage" },
  ];
  if (!isPlainObject(lineage)) {
    return invalid("Lineage must be a plain object.");
  }
  for (const key of Object.keys(lineage)) {
    if (!START_LINEAGE_KEYS.has(key)) {
      return invalid(`Lineage key '${key}' is not recognized.`);
    }
  }
  if (!isNonBlankString(lineage["parentRunId"])) {
    return invalid("Lineage parentRunId must be a non-blank string.");
  }
  if (!isNonBlankString(lineage["parentStepId"])) {
    return invalid("Lineage parentStepId must be a non-blank string.");
  }
  const depth = lineage["depth"];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0) {
    return invalid("Lineage depth must be a positive integer.");
  }
  const ancestors = lineage["ancestorDefinitionKeys"];
  if (
    !Array.isArray(ancestors) ||
    !ancestors.every((key) => isNonBlankString(key))
  ) {
    return invalid(
      "Lineage ancestorDefinitionKeys must be an array of non-blank strings.",
    );
  }
  if (depth !== ancestors.length) {
    return invalid("Lineage depth must equal ancestorDefinitionKeys.length.");
  }
  if (new Set(ancestors).size !== ancestors.length) {
    return invalid(
      "Lineage ancestorDefinitionKeys must not repeat a definition.",
    );
  }
  if (lineage["parentRunId"] === runId) {
    return invalid("Lineage parentRunId must differ from the run id.");
  }
  return [];
}

function isKnownRetainedBuiltInDefinition(definition: unknown): boolean {
  return BUILT_IN_WORKFLOW_DEFINITIONS.some(
    (builtIn) =>
      builtIn.steps.some(
        (step) => canonicalWorkflowStepKind(step.kind) !== step.kind,
      ) && isDeepStrictEqual(definition, builtIn),
  );
}

/**
 * One step of a frozen coding-workflow plan preview. It carries the canonical
 * {@link WorkflowStepRecord} fields plus the step's {@link ExecutorName}
 * and optional portable config joined from the definition, plus effective agent
 * config resolved from definition defaults and native route overrides, so an
 * operator can read how each step will dispatch before the run is approved or
 * executed.
 */
export type WorkflowCodingPlanStep = {
  stepId: string;
  kind: WorkflowStepKind;
  executor: ExecutorName;
  config?: Record<string, unknown>;
  agentConfig?: CodingStepRouteOverride;
  order: number;
  required: boolean;
  state: WorkflowStepState;
};

/**
 * A frozen, pre-execution preview of the coding workflow a native start would
 * materialize. It is a pure projection of the version-pinned
 * {@link WorkflowDefinition} plus the run-start parameters: the same definition
 * key/version, repo, objective, issue scope, compatibility route, effective
 * per-step agent config, and approval boundary a `workflow run start-coding`
 * would canonically persist and project.
 * Because the projection is
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
  implementationEngine: string | null;
  approvalBoundary: WorkflowApprovalBoundary | null;
  skillRevision: string | null;
  definitionKey: string;
  definitionVersion: number;
  steps: WorkflowCodingPlanStep[];
};

export type WorkflowCodingPlanPreviewResult =
  | { ok: true; preview: WorkflowCodingPlanPreview }
  | { ok: false; errors: WorkflowRunStartError[] };

function readImplementationEngine(
  route: Record<string, unknown>,
): string | null {
  const value = route[CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}

/**
 * Materialize a {@link WorkflowCodingPlanPreview} from the same
 * {@link WorkflowRunStartInput} a native coding start would use, without touching
 * any durable state. It reuses {@link materializeWorkflowRunStart} for the run /
 * step shape (so the preview matches exactly what a start would persist) and
 * enriches each step with the effective executor identity, optional portable
 * config declared on the definition, and effective agent config. Invalid inputs
 * surface the same refusal taxonomy as a start.
 */
export function materializeWorkflowCodingPlanPreview(
  input: WorkflowRunStartInput,
  executorOptions: EffectiveExecutorOptions = {},
): WorkflowCodingPlanPreviewResult {
  const result = materializeWorkflowRunStart(input);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  // `materializeWorkflowRunStart` succeeded, so `input.definition` is a valid
  // `WorkflowDefinition`; build the executor lookup from it by stable step key.
  const definition = input.definition as WorkflowDefinition;
  const { run } = result.plan;
  const routeOverrides = readCodingStepRouteOverrides(run.route);
  if (!routeOverrides.ok) {
    const error: WorkflowRunStartError = {
      code: "route_invalid",
      message: routeOverrides.reason,
    };
    if (routeOverrides.path !== undefined) error.path = routeOverrides.path;
    return {
      ok: false,
      errors: [error],
    };
  }
  const effectiveAgentConfigs = resolveCodingStepAgentConfigs(
    definition.steps,
    result.plan.steps,
    routeOverrides.overrides,
  );
  const steps: WorkflowCodingPlanStep[] = result.plan.steps.map((step) => {
    const definitionStep = definition.steps.find(
      (candidate) => candidate.key === step.stepId,
    );
    const agentConfig = effectiveAgentConfigs.get(step.stepId) ?? {};
    return {
      stepId: step.stepId,
      kind: step.kind,
      executor: effectiveStepExecutor(
        definitionStep?.executor as ExecutorName,
        executorOptions,
      ),
      ...(definitionStep?.config === undefined
        ? {}
        : { config: { ...definitionStep.config } }),
      ...(Object.keys(agentConfig).length === 0 ? {} : { agentConfig }),
      order: step.order,
      required: step.required,
      state: step.state,
    };
  });

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
      implementationEngine: readImplementationEngine(run.route),
      approvalBoundary: run.approvalBoundary,
      skillRevision: run.skillRevision,
      definitionKey: run.definitionKey,
      definitionVersion: run.definitionVersion,
      steps,
    },
  };
}
