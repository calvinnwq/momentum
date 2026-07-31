import { isDeepStrictEqual } from "node:util";

import {
  LEGACY_ROUTE_TOP_LEVEL_KEYS,
  LEGACY_WORKFLOW_STEP_KIND_ALIASES,
} from "./route-projection.js";
import { RouteStateMigrationError } from "./route-state-errors.js";

const IMPLEMENTATION_ENGINES = new Set([
  "gnhf",
  "native-goal-loop",
  "current-gnhf-cwfp",
]);
const STEP_ROUTE_KEYS = new Set([
  "implementation",
  "postflight",
  "validate",
  "merge-cleanup",
  "tracker-refresh",
  "no-mistakes",
  "linear-refresh",
]);
const AGENT_CONFIG_KEYS = new Set(["harness", "model", "effort"]);
const SUBWORKFLOW_KEYS = new Set(["child", "lineage"]);
const CHILD_KEYS = new Set([
  "childDefinitionKey",
  "childDefinitionVersion",
  "maxDepth",
]);
const LINEAGE_KEYS = new Set([
  "parentRunId",
  "parentStepId",
  "depth",
  "ancestorDefinitionKeys",
]);

export type ValidatedRouteLineage = {
  parentRunId: string;
  parentStepId: string;
  depth: number;
  ancestorDefinitionKeys: string[];
};

export type ValidatedWorkflowRoute = {
  route: Record<string, unknown>;
  implementationEngine: string | null;
  profile: string | null;
  mode: string | null;
  risk: string | null;
  quotaPolicyJson: string | null;
  stepAgentConfigs: ReadonlyMap<string, string>;
  child: Record<string, unknown> | null;
  lineage: ValidatedRouteLineage | null;
};

export function validateWorkflowRoute(input: {
  runId: string;
  source: string;
  route: Record<string, unknown>;
}): ValidatedWorkflowRoute {
  const { runId, source, route } = input;
  validateKnownKeys(runId, "$", route, new Set(LEGACY_ROUTE_TOP_LEVEL_KEYS));
  const implementationEngine = optionalNonBlankString(
    runId,
    "$.implementationEngine",
    route["implementationEngine"],
  );
  if (
    implementationEngine !== null &&
    !IMPLEMENTATION_ENGINES.has(implementationEngine)
  ) {
    invalidValue(
      runId,
      "$.implementationEngine",
      "implementation engine is not a recognized compatibility label",
    );
  }
  const profile = optionalNonBlankString(runId, "$.profile", route["profile"]);
  if (
    profile !== null &&
    ![
      "workflow-definition",
      "momentum-native-coding",
      "agent-workflow",
    ].includes(source)
  ) {
    throw new RouteStateMigrationError({
      runId,
      jsonPath: "$.profile",
      code: "route_state_profile_ambiguous",
      detail:
        "profile cannot be classified without a recognized durable run source",
    });
  }
  const mode = optionalNonBlankString(runId, "$.mode", route["mode"]);
  const risk = optionalNonBlankString(runId, "$.risk", route["risk"]);
  const stepAgentConfigs = validateStepRouteShape(runId, route["steps"]);
  const subworkflow = validateSubworkflowShape(runId, route["subworkflow"]);
  const quotaPolicyJson = planQuotaPolicy(runId, route["quotaPolicy"]);
  const hasNativeMarker =
    implementationEngine !== null || route["steps"] !== undefined;
  const hasImportMarker =
    mode !== null || risk !== null || quotaPolicyJson !== null;
  if (
    (source === "agent-workflow" && hasNativeMarker) ||
    (source !== "agent-workflow" && hasImportMarker)
  ) {
    throw new RouteStateMigrationError({
      runId,
      jsonPath: "$",
      code: "route_state_source_conflict",
      detail:
        "route markers conflict with the durable workflow_runs.source value",
    });
  }
  return {
    route: canonicalizeEmptyStepConfigs(route),
    implementationEngine,
    profile,
    mode,
    risk,
    quotaPolicyJson,
    stepAgentConfigs,
    ...subworkflow,
  };
}

export type CanonicalCodingCompatibilityValues = {
  implementationEngine: string | null;
  selectedProfile: string | null;
};

/**
 * Validate a canonical `workflow_run_coding_compatibility` row on read. The
 * compatibility projection no longer reconstructs these values, so direct
 * readers keep the same absent / malformed / unsupported / valid distinctions
 * the route-shaped validation enforced.
 */
export function validateCanonicalCodingCompatibility(
  runId: string,
  row: {
    implementation_engine: string | null;
    selected_profile: string | null;
  },
): CanonicalCodingCompatibilityValues {
  const at = "$canonical.workflow_run_coding_compatibility";
  const implementationEngine = canonicalOptionalNonBlankString(
    runId,
    `${at}.implementation_engine`,
    row.implementation_engine,
  );
  if (
    implementationEngine !== null &&
    !IMPLEMENTATION_ENGINES.has(implementationEngine)
  ) {
    invalidValue(
      runId,
      `${at}.implementation_engine`,
      "implementation engine is not a recognized compatibility label",
    );
  }
  const selectedProfile = canonicalOptionalNonBlankString(
    runId,
    `${at}.selected_profile`,
    row.selected_profile,
  );
  return { implementationEngine, selectedProfile };
}

export type CanonicalImportMetadataValues = {
  mode: string | null;
  profile: string | null;
  risk: string | null;
  quotaPolicy: Record<string, unknown> | null;
  sourceFormat: string | null;
};

/** Validate a canonical `workflow_run_import_metadata` row on read. */
export function validateCanonicalImportMetadata(
  runId: string,
  row: {
    mode: string | null;
    profile: string | null;
    risk: string | null;
    quota_policy_json: string | null;
    source_format: string | null;
  },
): CanonicalImportMetadataValues {
  const at = "$canonical.workflow_run_import_metadata";
  const mode = canonicalOptionalNonBlankString(runId, `${at}.mode`, row.mode);
  const profile = canonicalOptionalNonBlankString(
    runId,
    `${at}.profile`,
    row.profile,
  );
  const risk = canonicalOptionalNonBlankString(runId, `${at}.risk`, row.risk);
  const sourceFormat = canonicalOptionalNonBlankString(
    runId,
    `${at}.source_format`,
    row.source_format,
  );
  let quotaPolicy: Record<string, unknown> | null = null;
  if (row.quota_policy_json !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.quota_policy_json);
    } catch {
      throw new RouteStateMigrationError({
        runId,
        jsonPath: `${at}.quota_policy_json`,
        code: "route_state_json_malformed",
        detail: "persisted quota policy is not valid JSON",
      });
    }
    if (!isPlainObject(parsed)) {
      invalidValue(
        runId,
        `${at}.quota_policy_json`,
        "quotaPolicy must be an object",
      );
    }
    quotaPolicy = parsed;
  }
  return { mode, profile, risk, quotaPolicy, sourceFormat };
}

function canonicalOptionalNonBlankString(
  runId: string,
  jsonPath: string,
  value: string | null,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidValue(runId, jsonPath, "value must be a non-blank string");
  }
  return value;
}

export function validateWorkflowRouteShape(input: {
  runId: string;
  source: string;
  route: Record<string, unknown>;
}): void {
  validateWorkflowRoute(input);
}

export function validateWorkflowRouteStepProjection(input: {
  runId: string;
  route: Record<string, unknown>;
  steps: ReadonlyArray<{
    kind: string;
    agentConfig: Readonly<Record<string, string>> | undefined;
  }>;
}): void {
  const routeSteps = isPlainObject(input.route["steps"])
    ? input.route["steps"]
    : {};
  const routeConfigsByKind = new Map<string, Record<string, unknown>>();
  const routeKindsByCanonicalKind = new Map<string, string>();
  for (const [kind, config] of Object.entries(routeSteps)) {
    const canonicalKind = canonicalStepKind(kind);
    if (isPlainObject(config)) {
      if (routeConfigsByKind.has(canonicalKind)) {
        throw new RouteStateMigrationError({
          runId: input.runId,
          jsonPath: `$.steps.${kind}`,
          code: "route_state_step_target_ambiguous",
          detail: `route defines multiple keys for canonical step kind '${canonicalKind}'`,
        });
      }
      routeConfigsByKind.set(canonicalKind, config);
      routeKindsByCanonicalKind.set(canonicalKind, kind);
    }
  }
  const materializedKinds = new Set<string>(
    input.steps.map((step) => canonicalStepKind(step.kind)),
  );
  for (const [canonicalKind, kind] of routeKindsByCanonicalKind) {
    if (materializedKinds.has(canonicalKind)) continue;
    throw new RouteStateMigrationError({
      runId: input.runId,
      jsonPath: `$.steps.${kind}`,
      code: "route_state_step_target_missing",
      detail: `no materialized step has canonical kind '${canonicalKind}'`,
    });
  }
  const configsByKind = new Map<string, Record<string, string>>();
  for (const step of input.steps) {
    const canonicalKind = canonicalStepKind(step.kind);
    const routeConfig = routeConfigsByKind.get(canonicalKind);
    const projectedConfig = {
      ...step.agentConfig,
      ...routeConfig,
    } as Record<string, string>;
    if (Object.keys(projectedConfig).length === 0) continue;
    const existing = configsByKind.get(canonicalKind);
    if (
      existing !== undefined &&
      !isDeepStrictEqual(existing, projectedConfig)
    ) {
      throw new RouteStateMigrationError({
        runId: input.runId,
        jsonPath: `$.steps.${canonicalKind}`,
        code: "route_state_step_target_ambiguous",
        detail:
          "multiple persisted steps would have the same projected route kind with different agent config",
      });
    }
    configsByKind.set(canonicalKind, projectedConfig);
  }
}

export function parseWorkflowRoute(
  runId: string,
  routeJson: string | null,
): Record<string, unknown> {
  if (routeJson === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(routeJson);
  } catch {
    throw new RouteStateMigrationError({
      runId,
      jsonPath: "$",
      code: "route_state_json_malformed",
      detail: "route_json is not valid JSON",
    });
  }
  if (!isPlainObject(parsed)) {
    throw new RouteStateMigrationError({
      runId,
      jsonPath: "$",
      code: "route_state_not_object",
      detail: "route_json must contain a JSON object",
    });
  }
  return parsed;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStepRouteShape(
  runId: string,
  raw: unknown,
): Map<string, string> {
  const result = new Map<string, string>();
  const routeKinds = new Map<string, string>();
  if (raw === undefined) return result;
  if (!isPlainObject(raw))
    invalidValue(runId, "$.steps", "steps must be an object");
  for (const [kind, config] of Object.entries(raw)) {
    const at = `$.steps.${kind}`;
    if (!STEP_ROUTE_KEYS.has(kind)) unknownKey(runId, at);
    if (!isPlainObject(config))
      invalidValue(runId, at, "step config must be an object");
    validateKnownKeys(runId, at, config, AGENT_CONFIG_KEYS);
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        invalidValue(
          runId,
          `${at}.${key}`,
          "agent config values must be non-blank strings",
        );
      }
    }
    const canonicalKind = canonicalStepKind(kind);
    const existingRouteKind = routeKinds.get(canonicalKind);
    if (existingRouteKind !== undefined) {
      throw new RouteStateMigrationError({
        runId,
        jsonPath: at,
        code: "route_state_step_target_ambiguous",
        detail:
          `route defines both '${existingRouteKind}' and '${kind}', which map to ` +
          `canonical step kind '${canonicalKind}'`,
      });
    }
    routeKinds.set(canonicalKind, kind);
    result.set(canonicalKind, JSON.stringify(config));
  }
  return result;
}

function validateSubworkflowShape(
  runId: string,
  raw: unknown,
): {
  child: Record<string, unknown> | null;
  lineage: ValidatedRouteLineage | null;
} {
  if (raw === undefined) return { child: null, lineage: null };
  if (!isPlainObject(raw)) {
    invalidValue(runId, "$.subworkflow", "subworkflow must be an object");
  }
  validateKnownKeys(runId, "$.subworkflow", raw, SUBWORKFLOW_KEYS);
  let child: Record<string, unknown> | null = null;
  if (raw["child"] !== undefined) {
    const at = "$.subworkflow.child";
    if (!isPlainObject(raw["child"]))
      invalidValue(runId, at, "child must be an object");
    child = raw["child"];
    validateKnownKeys(runId, at, child, CHILD_KEYS);
    requiredNonBlankString(
      runId,
      `${at}.childDefinitionKey`,
      child["childDefinitionKey"],
    );
    requiredPositiveInteger(
      runId,
      `${at}.childDefinitionVersion`,
      child["childDefinitionVersion"],
    );
    if (child["maxDepth"] !== undefined) {
      requiredPositiveInteger(runId, `${at}.maxDepth`, child["maxDepth"]);
    }
  }

  let lineage: ValidatedRouteLineage | null = null;
  if (raw["lineage"] !== undefined) {
    lineage = validateLineageFields(
      runId,
      "$.subworkflow.lineage",
      raw["lineage"],
    );
  }
  return { child, lineage };
}

/**
 * Validate the explicit run-lineage input a workflow-run start supplies for a
 * subworkflow child run — the same field contract the durable
 * `workflow_run_lineage` row enforces. Throws a fail-closed
 * `route_state_lineage_invalid` on any malformed value.
 */
export function validateExplicitRunLineage(
  runId: string,
  raw: unknown,
): ValidatedRouteLineage {
  return validateLineageFields(runId, "$lineage", raw);
}

function validateLineageFields(
  runId: string,
  at: string,
  value: unknown,
): ValidatedRouteLineage {
  if (!isPlainObject(value))
    invalidLineage(runId, at, "lineage must be an object");
  validateKnownKeys(runId, at, value, LINEAGE_KEYS);
  const parentRunId = requiredNonBlankString(
    runId,
    `${at}.parentRunId`,
    value["parentRunId"],
    true,
  );
  const parentStepId = requiredNonBlankString(
    runId,
    `${at}.parentStepId`,
    value["parentStepId"],
    true,
  );
  const depth = requiredPositiveInteger(
    runId,
    `${at}.depth`,
    value["depth"],
    true,
  );
  const ancestors = value["ancestorDefinitionKeys"];
  if (
    !Array.isArray(ancestors) ||
    !ancestors.every((key) => typeof key === "string" && key.trim().length > 0)
  ) {
    invalidLineage(
      runId,
      `${at}.ancestorDefinitionKeys`,
      "ancestorDefinitionKeys must be an array of non-blank strings",
    );
  }
  if (depth !== ancestors.length) {
    invalidLineage(
      runId,
      `${at}.depth`,
      "depth must equal ancestorDefinitionKeys.length",
    );
  }
  if (new Set(ancestors).size !== ancestors.length) {
    invalidLineage(
      runId,
      `${at}.ancestorDefinitionKeys`,
      "ancestorDefinitionKeys must not repeat a definition",
    );
  }
  if (parentRunId === runId) {
    invalidLineage(
      runId,
      `${at}.parentRunId`,
      "parentRunId must differ from the child run id",
    );
  }
  return {
    parentRunId,
    parentStepId,
    depth,
    ancestorDefinitionKeys: ancestors,
  };
}

function planQuotaPolicy(runId: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    invalidValue(runId, "$.quotaPolicy", "quotaPolicy must be an object");
  }
  return JSON.stringify(raw);
}

function canonicalizeEmptyStepConfigs(
  route: Record<string, unknown>,
): Record<string, unknown> {
  const rawSteps = route["steps"];
  if (!isPlainObject(rawSteps)) return route;
  const steps = Object.fromEntries(
    Object.entries(rawSteps).filter(
      ([, config]) => isPlainObject(config) && Object.keys(config).length > 0,
    ),
  );
  const canonical = { ...route };
  if (Object.keys(steps).length === 0) {
    delete canonical["steps"];
  } else {
    canonical["steps"] = steps;
  }
  return canonical;
}

function canonicalStepKind(kind: string): string {
  return (
    LEGACY_WORKFLOW_STEP_KIND_ALIASES[
      kind as keyof typeof LEGACY_WORKFLOW_STEP_KIND_ALIASES
    ] ?? kind
  );
}

function validateKnownKeys(
  runId: string,
  jsonPath: string,
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) unknownKey(runId, `${jsonPath}.${key}`);
  }
}

function optionalNonBlankString(
  runId: string,
  jsonPath: string,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  return requiredNonBlankString(runId, jsonPath, value);
}

function requiredNonBlankString(
  runId: string,
  jsonPath: string,
  value: unknown,
  lineage = false,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (lineage)
      invalidLineage(runId, jsonPath, "value must be a non-blank string");
    invalidValue(runId, jsonPath, "value must be a non-blank string");
  }
  return value;
}

function requiredPositiveInteger(
  runId: string,
  jsonPath: string,
  value: unknown,
  lineage = false,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    if (lineage)
      invalidLineage(runId, jsonPath, "value must be a positive integer");
    invalidValue(runId, jsonPath, "value must be a positive integer");
  }
  return value;
}

function unknownKey(runId: string, jsonPath: string): never {
  throw new RouteStateMigrationError({
    runId,
    jsonPath,
    code: "route_state_unknown_key",
    detail: "route key is not recognized",
  });
}

function invalidValue(runId: string, jsonPath: string, detail: string): never {
  throw new RouteStateMigrationError({
    runId,
    jsonPath,
    code: "route_state_value_invalid",
    detail,
  });
}

function invalidLineage(
  runId: string,
  jsonPath: string,
  detail: string,
): never {
  throw new RouteStateMigrationError({
    runId,
    jsonPath,
    code: "route_state_lineage_invalid",
    detail,
  });
}
