/**
 * Pure structural preflight for Momentum-native workflow setup.
 *
 * This module validates setup shape before runtime work or external side effects begin.
 * It deliberately stays pure: no SQLite writes, no filesystem mutation, no child process spawn, no network calls, and no clock reads except values supplied by callers.
 * The CLI start and preview doors use it to fail closed before durable run materialization when the built-in definition, route profile, route steps, run-start shape, or required inputs are structurally invalid.
 * The coding workflow wrapper config validator uses the same evidence shape for field-level setup failures, including canonical snake_case guidance, result-file path checks, and no-mistakes runner-profile shape / env-allowlist checks.
 *
 * Preflight evidence is compact and stable for machine clients.
 * Every evidence object carries the same ordered fields: check id, status, severity, offending path, offending key, message, and recommended action.
 * Side-effect capability checks still belong to the step that owns the side effect, such as GitHub merge cleanup or Linear refresh.
 */
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
import { WORKFLOW_STEP_KINDS } from "../run/reducer.js";

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

export type CodingWorkflowRouteStepsJsonPreflightResult =
  CodingWorkflowRouteStepsPreflightResult;

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

export type CodingWorkflowWrapperConfigPreflightOptions = {
  expectedResultFile?: string;
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
const WRAPPER_CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["steps"]);
const WRAPPER_CONFIG_STEP_KIND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_KINDS
);
const WRAPPER_CONFIG_CAMEL_CASE_KEYS: Readonly<Record<string, string>> = {
  envAllow: "env_allow",
  resultFile: "result_file",
  timeoutSec: "timeout_sec",
  runnerProfile: "runner_profile"
};
const NO_MISTAKES_RUNNER_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "interface",
  "stdin",
  "agent",
  "required_env",
  "agent_path"
]);
const NO_MISTAKES_RUNNER_AGENTS = new Set([
  "claude",
  "codex",
  "opencode",
  "rovodev"
]);

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
  const issueScopeIdentifierError =
    validateCodingWorkflowIssueScopeIdentifier(input);
  if (materialized.ok && issueScopeIdentifierError === undefined) {
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

  const errors = materialized.ok
    ? []
    : [...materialized.errors];
  if (issueScopeIdentifierError !== undefined) {
    errors.push(issueScopeIdentifierError);
  }

  return {
    ok: false,
    errors,
    evidence: errors.map((error) =>
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

function validateCodingWorkflowIssueScopeIdentifier(
  input: WorkflowRunStartInput
): WorkflowRunStartError | undefined {
  const issueScope = input.issueScope;
  if (!isRecord(issueScope)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(issueScope, "identifier")) {
    return undefined;
  }
  if (isNonBlankString(issueScope["identifier"])) return undefined;
  return {
    code: "issue_scope_invalid",
    message: "Issue scope identifier must be a non-empty string when provided.",
    path: "issueScope.identifier"
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

export function preflightCodingWorkflowRouteStepsJson(
  value: string
): CodingWorkflowRouteStepsJsonPreflightResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      ok: false,
      evidence: [
        buildStructuralPreflightEvidence({
          checkId: ROUTE_STEPS_CHECK_ID,
          status: "failed",
          severity: "error",
          path: "route.steps",
          key: CODING_ROUTE_STEPS_KEY,
          message: "Coding route steps must be valid JSON.",
          recommendedAction:
            "Pass --steps-json as a JSON object keyed by configurable coding steps, or remove it to use the default route."
        })
      ]
    };
  }

  return preflightCodingWorkflowRouteSteps(parsed);
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
  source?: string,
  options: CodingWorkflowWrapperConfigPreflightOptions = {}
): CodingWorkflowWrapperConfigPreflightResult {
  const parsed = parseCodingWorkflowWrapperConfig(value, source);
  if (parsed.ok) {
    const resultFileMismatch = locateWrapperConfigExpectedResultFileMismatch(
      parsed.config,
      options.expectedResultFile
    );
    if (resultFileMismatch !== undefined) {
      return {
        ok: false,
        evidence: [
          buildStructuralPreflightEvidence({
            checkId: WRAPPER_CONFIG_CHECK_ID,
            status: "failed",
            severity: "error",
            path: resultFileMismatch.path,
            key: resultFileMismatch.key,
            message: resultFileMismatch.message,
            recommendedAction: resultFileMismatch.recommendedAction
          })
        ]
      };
    }
    const runnerEnvAllowMismatch =
      locateWrapperConfigRunnerProfileEnvAllowMismatch(parsed.config);
    if (runnerEnvAllowMismatch !== undefined) {
      return {
        ok: false,
        evidence: [
          buildStructuralPreflightEvidence({
            checkId: WRAPPER_CONFIG_CHECK_ID,
            status: "failed",
            severity: "error",
            path: runnerEnvAllowMismatch.path,
            key: runnerEnvAllowMismatch.key,
            message: runnerEnvAllowMismatch.message,
            recommendedAction: runnerEnvAllowMismatch.recommendedAction
          })
        ]
      };
    }

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
      if (error.path === "issueScope.identifier") {
        return "Set issueScope.identifier to the target issue identifier, or omit issueScope.";
      }
      return 'Set issueScope to a plain object such as { identifier: "ABC-123" }, or omit it.';
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
  const topLevelFailure = locateWrapperConfigTopLevelFailure(value);
  if (topLevelFailure !== undefined) return topLevelFailure;
  const stepKeyFailure = locateWrapperConfigStepKeyFailure(value);
  if (stepKeyFailure !== undefined) return stepKeyFailure;
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

function locateWrapperConfigExpectedResultFileMismatch(
  config: CodingWorkflowWrapperConfig,
  expectedResultFile: string | undefined
): (WrapperConfigFailureLocation & { message: string }) | undefined {
  if (expectedResultFile === undefined) return undefined;
  const expected = expectedResultFile.trim();
  if (expected.length === 0) return undefined;

  for (const [stepKind, stepConfig] of Object.entries(config.steps)) {
    if (stepConfig?.resultFile === undefined) continue;
    if (stepConfig.resultFile === expected) continue;
    const basePath = `wrapper.config.steps.${stepKind}`;
    return {
      path: `${basePath}.result_file`,
      key: "result_file",
      message: `Wrapper config \`result_file\` must match the expected live-wrapper result file "${expected}".`,
      recommendedAction: `Set ${basePath}.result_file to "${expected}", or remove the override.`
    };
  }

  return undefined;
}

function locateWrapperConfigRunnerProfileEnvAllowMismatch(
  config: CodingWorkflowWrapperConfig
): (WrapperConfigFailureLocation & { message: string }) | undefined {
  for (const [stepKind, stepConfig] of Object.entries(config.steps)) {
    const profile = stepConfig?.noMistakesRunnerProfile;
    if (profile === undefined) continue;
    const allowed = new Set(stepConfig.envAllow);
    const missing = profile.requiredEnv.filter((key) => !allowed.has(key));
    if (missing.length === 0) continue;
    const formattedMissing = missing.join(", ");
    const quotedMissing = missing.map((key) => `"${key}"`).join(", ");
    const basePath = `wrapper.config.steps.${stepKind}`;
    return {
      path: `${basePath}.env_allow`,
      key: "env_allow",
      message: `Wrapper config \`env_allow\` must include runner_profile.required_env entries: ${formattedMissing}.`,
      recommendedAction: `Add ${quotedMissing} to ${basePath}.env_allow so the runner profile environment can reach no-mistakes.`
    };
  }

  return undefined;
}

function locateWrapperConfigTopLevelFailure(
  value: unknown
): WrapperConfigFailureLocation | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of Object.keys(value)) {
    if (WRAPPER_CONFIG_TOP_LEVEL_KEYS.has(key)) continue;
    return {
      path: `wrapper.config.${key}`,
      key,
      recommendedAction: `Remove wrapper.config.${key} or replace it with supported key "steps".`
    };
  }
  return undefined;
}

function locateWrapperConfigStepKeyFailure(
  value: unknown
): WrapperConfigFailureLocation | undefined {
  if (!isRecord(value)) return undefined;
  const steps = value["steps"];
  if (!isRecord(steps)) return undefined;

  for (const stepKind of Object.keys(steps)) {
    if (WRAPPER_CONFIG_STEP_KIND_SET.has(stepKind)) continue;
    return {
      path: `wrapper.config.steps.${stepKind}`,
      key: stepKind,
      recommendedAction: `Use wrapper config steps only for supported workflow step kinds, or remove wrapper.config.steps.${stepKind}.`
    };
  }
  return undefined;
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

    if (stepKind === "no-mistakes") {
      const rawProfile = rawStep["runner_profile"];
      if (rawProfile === undefined) {
        return {
          path: `${basePath}.runner_profile`,
          key: "runner_profile",
          recommendedAction:
            "Add a no-mistakes runner_profile with interface=\"axi\", stdin=\"closed\", agent, required_env, and agent_path."
        };
      }
      if (!isRecord(rawProfile)) {
        return {
          path: `${basePath}.runner_profile`,
          key: "runner_profile",
          recommendedAction: `Set ${basePath}.runner_profile to an object.`
        };
      }
      for (const key of Object.keys(rawProfile)) {
        if (NO_MISTAKES_RUNNER_PROFILE_KEYS.has(key)) continue;
        return {
          path: `${basePath}.runner_profile.${key}`,
          key,
          recommendedAction: `Remove ${basePath}.runner_profile.${key} or replace it with one of: ${[
            ...NO_MISTAKES_RUNNER_PROFILE_KEYS
          ].join(", ")}.`
        };
      }
      if (rawProfile["interface"] !== "axi") {
        return {
          path: `${basePath}.runner_profile.interface`,
          key: "interface",
          recommendedAction: `Set ${basePath}.runner_profile.interface to "axi".`
        };
      }
      if (rawProfile["stdin"] !== "closed") {
        return {
          path: `${basePath}.runner_profile.stdin`,
          key: "stdin",
          recommendedAction: `Set ${basePath}.runner_profile.stdin to "closed".`
        };
      }
      if (
        !isNonBlankString(rawProfile["agent"]) ||
        !NO_MISTAKES_RUNNER_AGENTS.has(rawProfile["agent"])
      ) {
        return {
          path: `${basePath}.runner_profile.agent`,
          key: "agent",
          recommendedAction: `Set ${basePath}.runner_profile.agent to one of claude, codex, opencode, or rovodev.`
        };
      }
      if (!isStringArray(rawProfile["required_env"])) {
        return {
          path: `${basePath}.runner_profile.required_env`,
          key: "required_env",
          recommendedAction: `Set ${basePath}.runner_profile.required_env to an array including HOME and PATH, plus selected-agent environment such as CODEX_HOME for Codex.`
        };
      }
      const requiredEnv = rawProfile["required_env"];
      const requiredRunnerEnv =
        rawProfile["agent"] === "codex"
          ? ["HOME", "PATH", "CODEX_HOME"]
          : ["HOME", "PATH"];
      for (const required of requiredRunnerEnv) {
        if (requiredEnv.includes(required)) continue;
        return {
          path: `${basePath}.runner_profile.required_env`,
          key: "required_env",
          recommendedAction: `Add "${required}" to ${basePath}.runner_profile.required_env.`
        };
      }
      if (!isNonBlankString(rawProfile["agent_path"])) {
        return {
          path: `${basePath}.runner_profile.agent_path`,
          key: "agent_path",
          recommendedAction: `Set ${basePath}.runner_profile.agent_path to the configured absolute agent executable path.`
        };
      }
      if (!path.isAbsolute(rawProfile["agent_path"])) {
        return {
          path: `${basePath}.runner_profile.agent_path`,
          key: "agent_path",
          recommendedAction: `Set ${basePath}.runner_profile.agent_path to an absolute executable path.`
        };
      }
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

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
