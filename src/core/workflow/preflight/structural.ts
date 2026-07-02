import path from "node:path";

import {
  getBuiltInWorkflowDefinition,
  type WorkflowDefinition
} from "../definition/definition.js";
import {
  CONFIGURABLE_CODING_STEP_KEYS,
  CODING_ROUTE_STEPS_KEY,
  validateCodingStepRouteOverrides,
  type CodingRouteConfigRefusal,
  type CodingStepRouteOverrides
} from "../route/coding.js";
import {
  parseCodingWorkflowWrapperConfig,
  type CodingWorkflowWrapperConfig
} from "../live-wrapper/coding-workflow.js";
import {
  materializeWorkflowRunStart,
  type WorkflowRunStartInput,
  type WorkflowRunStartPlan,
  type WorkflowRunStartError
} from "../run/start.js";

export const STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS = [
  "checkId",
  "status",
  "severity",
  "path",
  "key",
  "message",
  "recommendedAction"
] as const;

export type StructuralPreflightStatus = "passed" | "failed";
export type StructuralPreflightSeverity = "info" | "error";

export type StructuralPreflightEvidence = Record<
  (typeof STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS)[number],
  string
> & {
  status: StructuralPreflightStatus;
  severity: StructuralPreflightSeverity;
};

export type CodingWorkflowRouteStepsPreflightResult =
  | {
      ok: true;
      overrides: CodingStepRouteOverrides;
      evidence: readonly [StructuralPreflightEvidence];
    }
  | {
      ok: false;
      evidence: readonly [StructuralPreflightEvidence];
    };

export type CodingWorkflowRouteProfilePreflightResult =
  | {
      ok: true;
      profile: string;
      evidence: readonly [StructuralPreflightEvidence];
    }
  | {
      ok: false;
      evidence: readonly [StructuralPreflightEvidence];
    };

export type CodingWorkflowWrapperConfigPreflightResult =
  | {
      ok: true;
      config: CodingWorkflowWrapperConfig;
      evidence: readonly [StructuralPreflightEvidence];
    }
  | {
      ok: false;
      evidence: readonly [StructuralPreflightEvidence];
    };

export type CodingWorkflowRunStartInputPreflightResult =
  | {
      ok: true;
      plan: WorkflowRunStartPlan;
      evidence: readonly [StructuralPreflightEvidence];
    }
  | {
      ok: false;
      errors: readonly WorkflowRunStartError[];
      evidence: readonly StructuralPreflightEvidence[];
    };

export type CodingWorkflowBuiltInDefinitionPreflightResult =
  | {
      ok: true;
      definition: WorkflowDefinition;
      evidence: readonly [StructuralPreflightEvidence];
    }
  | {
      ok: false;
      evidence: readonly [StructuralPreflightEvidence];
    };

const WORKFLOW_DEFINITION_CHECK_ID = "workflow.definition";
const RUN_SHAPE_CHECK_ID = "workflow.run_shape";
const ROUTE_STEPS_CHECK_ID = "route.steps";
const ROUTE_PROFILE_CHECK_ID = "route.profile";
const WRAPPER_CONFIG_CHECK_ID = "wrapper.config";
const WRAPPER_CONFIG_CAMEL_CASE_KEYS: Readonly<Record<string, string>> = {
  envAllow: "env_allow",
  resultFile: "result_file",
  timeoutSec: "timeout_sec"
};

export function preflightCodingWorkflowBuiltInDefinition(
  key: string,
  version: number | undefined
): CodingWorkflowBuiltInDefinitionPreflightResult {
  const definition = getBuiltInWorkflowDefinition(key, version);
  if (definition !== undefined) {
    return {
      ok: true,
      definition,
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: WORKFLOW_DEFINITION_CHECK_ID,
          status: "passed",
          severity: "info",
          path: "workflow.definition",
          key: "definition",
          message: "Built-in coding workflow definition resolved.",
          recommendedAction: "No action required."
        })
      ]
    };
  }

  const missingVersion = version !== undefined;
  return {
    ok: false,
    evidence: [
      buildStructuralPreflightEvidence({
        checkId: WORKFLOW_DEFINITION_CHECK_ID,
        status: "failed",
        severity: "error",
        path: missingVersion
          ? "workflow.definition.version"
          : "workflow.definition.key",
        key: missingVersion ? "definitionVersion" : "definition",
        message: missingVersion
          ? "Built-in coding workflow definition version was not found."
          : "Built-in coding workflow definition key was not found.",
        recommendedAction:
          "Use the supported built-in coding workflow definition key and version."
      })
    ]
  };
}

export function preflightCodingWorkflowRunStartInput(
  input: WorkflowRunStartInput
): CodingWorkflowRunStartInputPreflightResult {
  const materialized = materializeWorkflowRunStart(input);
  if (materialized.ok) {
    return {
      ok: true,
      plan: materialized.plan,
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: RUN_SHAPE_CHECK_ID,
          status: "passed",
          severity: "info",
          path: "workflow.run",
          key: "run",
          message: "Coding workflow run shape is structurally valid.",
          recommendedAction: "No action required."
        })
      ]
    };
  }

  return {
    ok: false,
    errors: materialized.errors,
    evidence: materialized.errors.map((error) =>
      buildStructuralPreflightEvidence({
        checkId: RUN_SHAPE_CHECK_ID,
        status: "failed",
        severity: "error",
        path: error.path ?? "workflow.run",
        key: error.path ?? "run",
        message: error.message,
        recommendedAction: recommendedActionForRunStartError(error)
      })
    )
  };
}

export function preflightCodingWorkflowRouteSteps(
  value: unknown
): CodingWorkflowRouteStepsPreflightResult {
  const validated = validateCodingStepRouteOverrides(value);
  if (validated.ok) {
    return {
      ok: true,
      overrides: validated.overrides,
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: ROUTE_STEPS_CHECK_ID,
          status: "passed",
          severity: "info",
          path: "route.steps",
          key: CODING_ROUTE_STEPS_KEY,
          message: "Coding route steps are structurally valid.",
          recommendedAction: "No action required."
        })
      ]
    };
  }

  return {
    ok: false,
    evidence: [
      buildStructuralPreflightEvidence({
        checkId: ROUTE_STEPS_CHECK_ID,
        status: "failed",
        severity: "error",
        path: normalizeRouteStepsPath(validated.path),
        key: routeStepsEvidenceKey(validated.path),
        message: validated.reason,
        recommendedAction: recommendedActionForRouteStepsRefusal(validated.refusal)
      })
    ]
  };
}

export function preflightCodingWorkflowRouteProfile(
  value: unknown
): CodingWorkflowRouteProfilePreflightResult {
  if (typeof value === "string" && value.trim().length > 0) {
    return {
      ok: true,
      profile: value.trim(),
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: ROUTE_PROFILE_CHECK_ID,
          status: "passed",
          severity: "info",
          path: "route.profile",
          key: "profile",
          message: "Coding route profile is structurally valid.",
          recommendedAction: "No action required."
        })
      ]
    };
  }

  return {
    ok: false,
    evidence: [
      buildStructuralPreflightEvidence({
        checkId: ROUTE_PROFILE_CHECK_ID,
        status: "failed",
        severity: "error",
        path: "route.profile",
        key: "profile",
        message: "Coding route profile must be a non-empty string when provided.",
        recommendedAction:
          "Set route.profile to a non-empty runtime/profile name, or remove --profile to use the default route."
      })
    ]
  };
}

export function preflightCodingWorkflowWrapperConfig(
  value: unknown,
  source?: string
): CodingWorkflowWrapperConfigPreflightResult {
  const parsed = parseCodingWorkflowWrapperConfig(value, source);
  if (parsed.ok) {
    return {
      ok: true,
      config: parsed.config,
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: WRAPPER_CONFIG_CHECK_ID,
          status: "passed",
          severity: "info",
          path: "wrapper.config",
          key: "steps",
          message: "Coding workflow wrapper config is structurally valid.",
          recommendedAction: "No action required."
        })
      ]
    };
  }

  const location = locateWrapperConfigFailure(value);
  return {
    ok: false,
    evidence: [
      buildStructuralPreflightEvidence({
        checkId: WRAPPER_CONFIG_CHECK_ID,
        status: "failed",
        severity: "error",
        path: location.path,
        key: location.key,
        message: parsed.error,
        recommendedAction: location.recommendedAction
      })
    ]
  };
}

function recommendedActionForRunStartError(
  error: WorkflowRunStartError
): string {
  switch (error.code) {
    case "definition_invalid":
      return "Use the supported built-in coding workflow definition key and version.";
    case "run_id_invalid":
      return "Set runId to a non-empty path-safe workflow run id.";
    case "repo_path_invalid":
      return "Set repoPath to a non-empty repository path before starting the run.";
    case "objective_invalid":
      return "Set objective to a non-empty objective before starting the run.";
    case "approval_boundary_invalid":
      return "Set approvalBoundary to a supported workflow approval boundary or omit it for manual approval.";
    case "issue_scope_invalid":
      return 'Set issueScope to a plain object such as { identifier: "NGX-123" }, or omit it.';
    case "route_invalid":
      return "Set route to a plain object containing only validated coding workflow route fields.";
  }
}

function buildStructuralPreflightEvidence(
  evidence: StructuralPreflightEvidence
): StructuralPreflightEvidence {
  return {
    checkId: evidence.checkId,
    status: evidence.status,
    severity: evidence.severity,
    path: evidence.path,
    key: evidence.key,
    message: evidence.message,
    recommendedAction: evidence.recommendedAction
  };
}

type WrapperConfigFailureLocation = {
  path: string;
  key: string;
  recommendedAction: string;
};

function locateWrapperConfigFailure(value: unknown): WrapperConfigFailureLocation {
  const casingDrift = locateWrapperConfigCasingDrift(value);
  if (casingDrift !== undefined) return casingDrift;
  const fieldFailure = locateWrapperConfigFieldFailure(value);
  if (fieldFailure !== undefined) return fieldFailure;
  return {
    path: "wrapper.config",
    key: "config",
    recommendedAction:
      "Update the coding workflow wrapper config to match the supported structural schema."
  };
}

function locateWrapperConfigCasingDrift(
  value: unknown
): WrapperConfigFailureLocation | undefined {
  if (!isRecord(value)) return undefined;
  const steps = value["steps"];
  if (!isRecord(steps)) return undefined;

  for (const [stepKind, rawStep] of Object.entries(steps)) {
    if (!isRecord(rawStep)) continue;
    for (const [actual, expected] of Object.entries(WRAPPER_CONFIG_CAMEL_CASE_KEYS)) {
      if (Object.prototype.hasOwnProperty.call(rawStep, actual)) {
        return {
          path: `wrapper.config.steps.${stepKind}.${actual}`,
          key: actual,
          recommendedAction: `Replace "${actual}" with "${expected}".`
        };
      }
    }
  }
  return undefined;
}

function locateWrapperConfigFieldFailure(
  value: unknown
): WrapperConfigFailureLocation | undefined {
  if (!isRecord(value)) return undefined;
  const steps = value["steps"];
  if (!isRecord(steps)) return undefined;

  for (const [stepKind, rawStep] of Object.entries(steps)) {
    if (!isRecord(rawStep)) continue;
    const basePath = `wrapper.config.steps.${stepKind}`;

    if (
      Object.prototype.hasOwnProperty.call(rawStep, "env_allow") &&
      !isStringArray(rawStep["env_allow"])
    ) {
      return {
        path: `${basePath}.env_allow`,
        key: "env_allow",
        recommendedAction: `Set ${basePath}.env_allow to an array of environment variable names.`
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(rawStep, "result_file") &&
      !isSafeWrapperResultFile(rawStep["result_file"])
    ) {
      return {
        path: `${basePath}.result_file`,
        key: "result_file",
        recommendedAction: `Set ${basePath}.result_file to a safe relative path inside the iteration artifact directory.`
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(rawStep, "timeout_sec") &&
      !isPositiveInteger(rawStep["timeout_sec"])
    ) {
      return {
        path: `${basePath}.timeout_sec`,
        key: "timeout_sec",
        recommendedAction: `Set ${basePath}.timeout_sec to a positive integer number of seconds.`
      };
    }
  }

  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSafeWrapperResultFile(value: unknown): value is string {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const trimmed = value.trim();
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  return (
    !path.isAbsolute(trimmed) &&
    !path.win32.isAbsolute(trimmed) &&
    !trimmed.split(/[\\/]+/u).includes("..") &&
    normalized !== "." &&
    normalized !== "./"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRouteStepsPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) return "route.steps";
  return `route.${path}`;
}

function routeStepsEvidenceKey(path: string | undefined): string {
  if (path === undefined || path.length === 0) return CODING_ROUTE_STEPS_KEY;
  const parts = path.split(".").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? CODING_ROUTE_STEPS_KEY;
}

function recommendedActionForRouteStepsRefusal(
  refusal: CodingRouteConfigRefusal
): string {
  switch (refusal) {
    case "step_unsupported":
      return `Use route.steps only for ${formatSupportedCodingStepKeys()}, or remove the unsupported step key.`;
    case "field_unsupported":
      return "Use only harness, model, and effort fields for each route.steps entry.";
    case "step_config_invalid":
      return "Set each route.steps entry to an object of harness, model, and effort fields.";
    case "value_invalid":
      return "Set each route.steps field value to a non-empty string.";
    case "overrides_invalid":
      return "Set route.steps to an object keyed by configurable coding workflow step.";
  }
}

function formatSupportedCodingStepKeys(): string {
  const keys = [...CONFIGURABLE_CODING_STEP_KEYS];
  if (keys.length <= 1) return keys.join("");
  return `${keys.slice(0, -1).join(", ")}, or ${keys[keys.length - 1]}`;
}
