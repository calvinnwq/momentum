import {
  CONFIGURABLE_CODING_STEP_KEYS,
  CODING_ROUTE_STEPS_KEY,
  validateCodingStepRouteOverrides,
  type CodingRouteConfigRefusal,
  type CodingStepRouteOverrides
} from "../route/coding.js";

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

const ROUTE_STEPS_CHECK_ID = "route.steps";

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
