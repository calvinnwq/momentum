import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  LEGACY_ROUTE_TOP_LEVEL_KEYS,
  LEGACY_WORKFLOW_STEP_KIND_ALIASES,
  projectLegacyWorkflowRunRoute,
  RouteStateProjectionError,
} from "./route-projection.js";

type MomentumDb = DatabaseSync;

const DESTINATION_TABLES = [
  "workflow_run_lineage",
  "workflow_run_coding_compatibility",
  "workflow_run_import_metadata",
] as const;
const DESTINATION_COLUMNS = [
  ["step_definitions", "agent_config_json"],
  ["workflow_steps", "agent_config_json"],
  ["workflow_steps", "executor_config_json"],
] as const;
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

export const ROUTE_STATE_MIGRATION_ERROR_CODES = [
  "route_state_schema_partial",
  "route_state_canonical_conflict",
  "route_state_json_malformed",
  "route_state_not_object",
  "route_state_unknown_key",
  "route_state_value_invalid",
  "route_state_source_conflict",
  "route_state_profile_ambiguous",
  "route_state_step_target_missing",
  "route_state_step_target_ambiguous",
  "route_state_subworkflow_target_missing",
  "route_state_lineage_invalid",
  "route_state_lineage_parent_missing",
  "route_state_projection_mismatch",
  "route_state_foreign_key_invalid",
] as const;
export type RouteStateMigrationErrorCode =
  (typeof ROUTE_STATE_MIGRATION_ERROR_CODES)[number];

export class RouteStateMigrationError extends Error {
  readonly runId: string;
  readonly jsonPath: string;
  readonly code: RouteStateMigrationErrorCode;
  readonly repair: string;

  constructor(input: {
    runId: string;
    jsonPath: string;
    code: RouteStateMigrationErrorCode;
    detail: string;
    repair?: string;
  }) {
    const repair =
      input.repair ??
      "Restore this database from backup or manually repair the named route value before reopening Momentum.";
    super(
      `Route-state migration refused for run '${input.runId}' at ${input.jsonPath} ` +
        `[${input.code}]: ${input.detail} ${repair}`,
    );
    this.name = "RouteStateMigrationError";
    this.runId = input.runId;
    this.jsonPath = input.jsonPath;
    this.code = input.code;
    this.repair = repair;
  }
}

type RunRow = {
  id: string;
  source: string;
  route_json: string | null;
  workflow_definition_key: string | null;
  workflow_definition_version: number | null;
  created_at: number;
  updated_at: number;
};

type CodingCompatibilityPlan = {
  implementationEngine: string | null;
  selectedProfile: string | null;
};

type ImportMetadataPlan = {
  mode: string | null;
  profile: string | null;
  risk: string | null;
  quotaPolicyJson: string | null;
};

type LineagePlan = {
  parentRunId: string;
  parentStepId: string;
  depth: number;
  ancestorDefinitionKeysJson: string;
};

type StepConfigPlan = {
  stepId: string;
  agentConfigJson: string;
  executorConfigJson: string;
};

type RouteRunPlan = {
  run: RunRow;
  parsedRoute: Record<string, unknown>;
  compatibility: CodingCompatibilityPlan | null;
  importMetadata: ImportMetadataPlan | null;
  lineage: LineagePlan | null;
  steps: StepConfigPlan[];
};

export type WorkflowRouteStatePlan = {
  runs: RouteRunPlan[];
};

export function validateWorkflowRouteShape(input: {
  runId: string;
  source: string;
  route: Record<string, unknown>;
}): void {
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
  validateStepRouteShape(runId, route["steps"]);
  validateSubworkflowShape(runId, route["subworkflow"]);
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
}

export function writeCanonicalWorkflowRunRouteState(
  db: MomentumDb,
  input: {
    runId: string;
    source: string;
    route: Record<string, unknown>;
    definitionKey: string | null;
    definitionVersion: number | null;
    createdAt: number;
    updatedAt: number;
    definitionAgentConfigs?: ReadonlyMap<string, Record<string, string>>;
    definitionExecutorConfigs?: ReadonlyMap<string, Record<string, unknown>>;
  },
): void {
  validateWorkflowRouteShape(input);
  const plan = planRun(
    db,
    {
      id: input.runId,
      source: input.source,
      route_json: JSON.stringify(input.route),
      workflow_definition_key: input.definitionKey,
      workflow_definition_version: input.definitionVersion,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    },
    input.definitionAgentConfigs,
    input.definitionExecutorConfigs,
  );
  db.prepare(
    "DELETE FROM workflow_run_coding_compatibility WHERE run_id = ?",
  ).run(input.runId);
  db.prepare("DELETE FROM workflow_run_import_metadata WHERE run_id = ?").run(
    input.runId,
  );
  db.prepare("DELETE FROM workflow_run_lineage WHERE run_id = ?").run(
    input.runId,
  );
  applyRouteStatePlan(db, { runs: [plan] });
}

export function routeStateMigrationNeeded(db: MomentumDb): boolean {
  if (!hasRouteStateBaseTables(db)) return false;
  const state = destinationSchemaState(db);
  if (state.present > 0 && state.present < state.total) {
    throw schemaPartialError(state);
  }
  if (state.present === 0) return true;
  const route = firstNonEmptyRoute(db);
  if (route !== undefined) {
    throw new RouteStateMigrationError({
      runId: route.id,
      jsonPath: "$",
      code: "route_state_canonical_conflict",
      detail:
        "all canonical destination objects already exist while legacy route_json still carries state",
    });
  }
  return false;
}

export function preScanRouteState(db: MomentumDb): WorkflowRouteStatePlan {
  if (!hasRouteStateBaseTables(db)) return { runs: [] };
  const state = destinationSchemaState(db);
  if (state.present > 0 && state.present < state.total) {
    throw schemaPartialError(state);
  }
  if (state.present === state.total) {
    const route = firstNonEmptyRoute(db);
    if (route !== undefined) {
      throw new RouteStateMigrationError({
        runId: route.id,
        jsonPath: "$",
        code: "route_state_canonical_conflict",
        detail:
          "canonical destinations and non-empty legacy route state coexist",
      });
    }
    return { runs: [] };
  }

  const rows = db
    .prepare(
      `SELECT id, source, route_json, workflow_definition_key,
              workflow_definition_version, created_at, updated_at
         FROM workflow_runs
        ORDER BY id`,
    )
    .all() as RunRow[];
  return { runs: rows.map((row) => planRun(db, row)) };
}

export function createRouteStateDestinations(db: MomentumDb): void {
  if (!columnExists(db, "step_definitions", "agent_config_json")) {
    db.exec("ALTER TABLE step_definitions ADD COLUMN agent_config_json TEXT");
  }
  if (!columnExists(db, "workflow_steps", "agent_config_json")) {
    db.exec(
      "ALTER TABLE workflow_steps ADD COLUMN agent_config_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  if (!columnExists(db, "workflow_steps", "executor_config_json")) {
    db.exec(
      "ALTER TABLE workflow_steps ADD COLUMN executor_config_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS workflow_run_lineage (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  parent_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  parent_step_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  ancestor_definition_keys_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_run_id, parent_step_id)
    REFERENCES workflow_steps(run_id, step_id),
  CHECK (depth > 0),
  CHECK (run_id <> parent_run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_run_coding_compatibility (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  implementation_engine TEXT,
  -- Historical native profile compatibility, never host-binding authority.
  selected_profile TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (implementation_engine IS NULL OR trim(implementation_engine) <> ''),
  CHECK (selected_profile IS NULL OR trim(selected_profile) <> ''),
  CHECK (implementation_engine IS NOT NULL OR selected_profile IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_run_import_metadata (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  mode TEXT,
  profile TEXT,
  risk TEXT,
  quota_policy_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (mode IS NULL OR trim(mode) <> ''),
  CHECK (profile IS NULL OR trim(profile) <> ''),
  CHECK (risk IS NULL OR trim(risk) <> ''),
  CHECK (COALESCE(mode, profile, risk, quota_policy_json) IS NOT NULL)
) STRICT;
`);
}

export function applyWorkflowRouteStateMigration(db: MomentumDb): void {
  if (!routeStateMigrationNeeded(db)) return;
  const plan = preScanRouteState(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    createRouteStateDestinations(db);
    applyRouteStatePlan(db, plan);
    assertProjectionEquivalence(db, plan);
    clearMigratedRouteJson(db, plan);
    assertForeignKeyCheckEmpty(db);
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    if (error instanceof RouteStateMigrationError) throw error;
    if (error instanceof RouteStateProjectionError) {
      throw new RouteStateMigrationError({
        runId: error.runId,
        jsonPath: error.jsonPath,
        code: "route_state_projection_mismatch",
        detail: error.message,
      });
    }
    throw error;
  }
}

function planRun(
  db: MomentumDb,
  run: RunRow,
  definitionAgentConfigs?: ReadonlyMap<string, Record<string, string>>,
  definitionExecutorConfigs?: ReadonlyMap<string, Record<string, unknown>>,
): RouteRunPlan {
  const parsedRoute = parseRoute(run);
  validateKnownKeys(
    run.id,
    "$",
    parsedRoute,
    new Set(LEGACY_ROUTE_TOP_LEVEL_KEYS),
  );
  const implementationEngine = optionalNonBlankString(
    run.id,
    "$.implementationEngine",
    parsedRoute["implementationEngine"],
  );
  if (
    implementationEngine !== null &&
    !IMPLEMENTATION_ENGINES.has(implementationEngine)
  ) {
    invalidValue(
      run.id,
      "$.implementationEngine",
      "implementation engine is not a recognized compatibility label",
    );
  }
  const profile = optionalNonBlankString(
    run.id,
    "$.profile",
    parsedRoute["profile"],
  );
  if (
    profile !== null &&
    ![
      "workflow-definition",
      "momentum-native-coding",
      "agent-workflow",
    ].includes(run.source)
  ) {
    throw new RouteStateMigrationError({
      runId: run.id,
      jsonPath: "$.profile",
      code: "route_state_profile_ambiguous",
      detail:
        "profile cannot be classified without a recognized durable run source",
    });
  }
  const mode = optionalNonBlankString(run.id, "$.mode", parsedRoute["mode"]);
  const risk = optionalNonBlankString(run.id, "$.risk", parsedRoute["risk"]);
  const steps = planStepAgentConfigs(db, run, parsedRoute["steps"]);
  const subworkflow = planSubworkflow(db, run, parsedRoute["subworkflow"]);
  const quotaPolicyJson = planQuotaPolicy(run.id, parsedRoute["quotaPolicy"]);

  const hasNativeMarker =
    implementationEngine !== null || parsedRoute["steps"] !== undefined;
  const hasImportMarker =
    mode !== null || risk !== null || quotaPolicyJson !== null;
  if (
    (run.source === "agent-workflow" && hasNativeMarker) ||
    (run.source !== "agent-workflow" && hasImportMarker)
  ) {
    throw new RouteStateMigrationError({
      runId: run.id,
      jsonPath: "$",
      code: "route_state_source_conflict",
      detail:
        "route markers conflict with the durable workflow_runs.source value",
    });
  }

  const compatibility =
    run.source !== "agent-workflow" &&
    (implementationEngine !== null || profile !== null)
      ? { implementationEngine, selectedProfile: profile }
      : null;
  const importMetadata =
    run.source === "agent-workflow" &&
    (mode !== null ||
      profile !== null ||
      risk !== null ||
      quotaPolicyJson !== null)
      ? { mode, profile, risk, quotaPolicyJson }
      : null;
  return {
    run,
    parsedRoute,
    compatibility,
    importMetadata,
    lineage: subworkflow.lineage,
    steps: mergeStepPlans(
      db,
      run,
      steps,
      subworkflow.child,
      definitionAgentConfigs,
      definitionExecutorConfigs,
    ),
  };
}

function parseRoute(run: RunRow): Record<string, unknown> {
  if (run.route_json === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.route_json);
  } catch {
    throw new RouteStateMigrationError({
      runId: run.id,
      jsonPath: "$",
      code: "route_state_json_malformed",
      detail: "route_json is not valid JSON",
    });
  }
  if (!isPlainObject(parsed)) {
    throw new RouteStateMigrationError({
      runId: run.id,
      jsonPath: "$",
      code: "route_state_not_object",
      detail: "route_json must contain a JSON object",
    });
  }
  return parsed;
}

function planStepAgentConfigs(
  db: MomentumDb,
  run: RunRow,
  raw: unknown,
): Map<string, string> {
  const result = new Map<string, string>();
  const routeKinds = new Map<string, string>();
  if (raw === undefined) return result;
  if (!isPlainObject(raw))
    invalidValue(run.id, "$.steps", "steps must be an object");
  for (const [kind, config] of Object.entries(raw)) {
    const at = `$.steps.${kind}`;
    if (!STEP_ROUTE_KEYS.has(kind)) unknownKey(run.id, at);
    if (!isPlainObject(config))
      invalidValue(run.id, at, "step config must be an object");
    validateKnownKeys(run.id, at, config, AGENT_CONFIG_KEYS);
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        invalidValue(
          run.id,
          `${at}.${key}`,
          "agent config values must be non-blank strings",
        );
      }
    }
    const canonicalKind =
      LEGACY_WORKFLOW_STEP_KIND_ALIASES[
        kind as keyof typeof LEGACY_WORKFLOW_STEP_KIND_ALIASES
      ] ?? kind;
    const existingRouteKind = routeKinds.get(canonicalKind);
    if (existingRouteKind !== undefined) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: at,
        code: "route_state_step_target_ambiguous",
        detail:
          `route defines both '${existingRouteKind}' and '${kind}', which map to ` +
          `canonical step kind '${canonicalKind}'`,
      });
    }
    routeKinds.set(canonicalKind, kind);
    const matches = (
      db
        .prepare(
          `SELECT step_id, kind
           FROM workflow_steps
          WHERE run_id = ?
          ORDER BY step_id`,
        )
        .all(run.id) as Array<{ step_id: string; kind: string }>
    ).filter(
      (row) =>
        (LEGACY_WORKFLOW_STEP_KIND_ALIASES[
          row.kind as keyof typeof LEGACY_WORKFLOW_STEP_KIND_ALIASES
        ] ?? row.kind) === canonicalKind,
    );
    if (matches.length === 0) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: at,
        code: "route_state_step_target_missing",
        detail: `no persisted step has canonical kind '${canonicalKind}'`,
      });
    }
    if (matches.length > 1) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: at,
        code: "route_state_step_target_ambiguous",
        detail: `multiple persisted steps have canonical kind '${canonicalKind}'`,
      });
    }
    result.set(matches[0]!.step_id, JSON.stringify(config));
  }
  return result;
}

function validateStepRouteShape(runId: string, raw: unknown): void {
  if (raw === undefined) return;
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
  }
}

function planSubworkflow(
  db: MomentumDb,
  run: RunRow,
  raw: unknown,
): { child: Record<string, unknown> | null; lineage: LineagePlan | null } {
  if (raw === undefined) return { child: null, lineage: null };
  if (!isPlainObject(raw)) {
    invalidValue(run.id, "$.subworkflow", "subworkflow must be an object");
  }
  validateKnownKeys(run.id, "$.subworkflow", raw, SUBWORKFLOW_KEYS);
  let child: Record<string, unknown> | null = null;
  if (raw["child"] !== undefined) {
    const at = "$.subworkflow.child";
    if (!isPlainObject(raw["child"]))
      invalidValue(run.id, at, "child must be an object");
    child = raw["child"];
    validateKnownKeys(run.id, at, child, CHILD_KEYS);
    requiredNonBlankString(
      run.id,
      `${at}.childDefinitionKey`,
      child["childDefinitionKey"],
    );
    requiredPositiveInteger(
      run.id,
      `${at}.childDefinitionVersion`,
      child["childDefinitionVersion"],
    );
    if (child["maxDepth"] !== undefined) {
      requiredPositiveInteger(run.id, `${at}.maxDepth`, child["maxDepth"]);
    }
    if (
      run.workflow_definition_key === null ||
      run.workflow_definition_version === null
    ) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: at,
        code: "route_state_subworkflow_target_missing",
        detail: "run is not linked to a workflow definition",
      });
    }
    const targets = subworkflowTargets(db, run);
    if (targets.length === 0) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: at,
        code: "route_state_subworkflow_target_missing",
        detail: "run has no persisted subworkflow steps",
      });
    }
  }

  let lineage: LineagePlan | null = null;
  if (raw["lineage"] !== undefined) {
    const at = "$.subworkflow.lineage";
    const value = raw["lineage"];
    if (!isPlainObject(value))
      invalidLineage(run.id, at, "lineage must be an object");
    validateKnownKeys(run.id, at, value, LINEAGE_KEYS);
    const parentRunId = requiredNonBlankString(
      run.id,
      `${at}.parentRunId`,
      value["parentRunId"],
      true,
    );
    const parentStepId = requiredNonBlankString(
      run.id,
      `${at}.parentStepId`,
      value["parentStepId"],
      true,
    );
    if (parentRunId === run.id) {
      invalidLineage(
        run.id,
        `${at}.parentRunId`,
        "parentRunId must differ from the child run id",
      );
    }
    const depth = requiredPositiveInteger(
      run.id,
      `${at}.depth`,
      value["depth"],
      true,
    );
    const ancestors = value["ancestorDefinitionKeys"];
    if (
      !Array.isArray(ancestors) ||
      !ancestors.every(
        (key) => typeof key === "string" && key.trim().length > 0,
      )
    ) {
      invalidLineage(
        run.id,
        `${at}.ancestorDefinitionKeys`,
        "ancestorDefinitionKeys must be an array of non-blank strings",
      );
    }
    if (depth !== ancestors.length) {
      invalidLineage(
        run.id,
        `${at}.depth`,
        "depth must equal ancestorDefinitionKeys.length",
      );
    }
    const parent = db
      .prepare("SELECT 1 FROM workflow_steps WHERE run_id = ? AND step_id = ?")
      .get(parentRunId, parentStepId);
    if (parent === undefined) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: `${at}.parentStepId`,
        code: "route_state_lineage_parent_missing",
        detail: "parent run step does not exist",
      });
    }
    lineage = {
      parentRunId,
      parentStepId,
      depth,
      ancestorDefinitionKeysJson: JSON.stringify(ancestors),
    };
  }
  return { child, lineage };
}

function validateSubworkflowShape(runId: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    invalidValue(runId, "$.subworkflow", "subworkflow must be an object");
  }
  validateKnownKeys(runId, "$.subworkflow", raw, SUBWORKFLOW_KEYS);
  if (raw["child"] !== undefined) {
    const at = "$.subworkflow.child";
    const child = raw["child"];
    if (!isPlainObject(child))
      invalidValue(runId, at, "child must be an object");
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
  if (raw["lineage"] !== undefined) {
    const at = "$.subworkflow.lineage";
    const lineage = raw["lineage"];
    if (!isPlainObject(lineage))
      invalidLineage(runId, at, "lineage must be an object");
    validateKnownKeys(runId, at, lineage, LINEAGE_KEYS);
    requiredNonBlankString(
      runId,
      `${at}.parentRunId`,
      lineage["parentRunId"],
      true,
    );
    requiredNonBlankString(
      runId,
      `${at}.parentStepId`,
      lineage["parentStepId"],
      true,
    );
    const depth = requiredPositiveInteger(
      runId,
      `${at}.depth`,
      lineage["depth"],
      true,
    );
    const ancestors = lineage["ancestorDefinitionKeys"];
    if (
      !Array.isArray(ancestors) ||
      !ancestors.every(
        (key) => typeof key === "string" && key.trim().length > 0,
      )
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
  }
}

function planQuotaPolicy(runId: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    invalidValue(runId, "$.quotaPolicy", "quotaPolicy must be an object");
  }
  return JSON.stringify(raw);
}

function mergeStepPlans(
  db: MomentumDb,
  run: RunRow,
  agentConfigs: Map<string, string>,
  child: Record<string, unknown> | null,
  definitionAgentConfigs?: ReadonlyMap<string, Record<string, string>>,
  definitionExecutorConfigs?: ReadonlyMap<string, Record<string, unknown>>,
): StepConfigPlan[] {
  const rows = db
    .prepare(
      `SELECT ws.step_id, sd.config_json, sd.executor
         FROM workflow_steps ws
         LEFT JOIN step_definitions sd
           ON sd.definition_key = ?
          AND sd.definition_version = ?
          AND sd.step_key = ws.step_id
        WHERE ws.run_id = ?
        ORDER BY ws.step_order, ws.step_id`,
    )
    .all(
      run.workflow_definition_key,
      run.workflow_definition_version,
      run.id,
    ) as Array<{
    step_id: string;
    config_json: string | null;
    executor: string | null;
  }>;
  return rows.map((row) => {
    const definitionAgentConfig =
      definitionAgentConfigs?.get(row.step_id) ?? {};
    const routeAgentConfig = parseOptionalConfig(
      run.id,
      `$.steps.${row.step_id}.agentConfig`,
      agentConfigs.get(row.step_id) ?? null,
    );
    const base =
      definitionExecutorConfigs?.get(row.step_id) ??
      parseOptionalConfig(
        run.id,
        `$.steps.${row.step_id}.executorConfig`,
        row.config_json,
      );
    const executorConfig =
      child !== null && row.executor === "subworkflow"
        ? { ...base, child }
        : base;
    return {
      stepId: row.step_id,
      agentConfigJson: JSON.stringify({
        ...definitionAgentConfig,
        ...routeAgentConfig,
      }),
      executorConfigJson: JSON.stringify(executorConfig),
    };
  });
}

function subworkflowTargets(db: MomentumDb, run: RunRow): string[] {
  return (
    db
      .prepare(
        `SELECT ws.step_id
           FROM workflow_steps ws
           JOIN step_definitions sd
             ON sd.definition_key = ?
            AND sd.definition_version = ?
            AND sd.step_key = ws.step_id
          WHERE ws.run_id = ? AND sd.executor = 'subworkflow'
          ORDER BY ws.step_order, ws.step_id`,
      )
      .all(
        run.workflow_definition_key,
        run.workflow_definition_version,
        run.id,
      ) as Array<{ step_id: string }>
  ).map((row) => row.step_id);
}

function applyRouteStatePlan(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
): void {
  const updateStep = db.prepare(
    `UPDATE workflow_steps
        SET agent_config_json = ?, executor_config_json = ?
      WHERE run_id = ? AND step_id = ?`,
  );
  const insertCompatibility = db.prepare(
    `INSERT INTO workflow_run_coding_compatibility
       (run_id, implementation_engine, selected_profile, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertImport = db.prepare(
    `INSERT INTO workflow_run_import_metadata
       (run_id, mode, profile, risk, quota_policy_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLineage = db.prepare(
    `INSERT INTO workflow_run_lineage
       (run_id, parent_run_id, parent_step_id, depth,
        ancestor_definition_keys_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of plan.runs) {
    for (const step of item.steps) {
      updateStep.run(
        step.agentConfigJson,
        step.executorConfigJson,
        item.run.id,
        step.stepId,
      );
    }
    if (item.compatibility !== null) {
      insertCompatibility.run(
        item.run.id,
        item.compatibility.implementationEngine,
        item.compatibility.selectedProfile,
        item.run.created_at,
        item.run.updated_at,
      );
    }
    if (item.importMetadata !== null) {
      insertImport.run(
        item.run.id,
        item.importMetadata.mode,
        item.importMetadata.profile,
        item.importMetadata.risk,
        item.importMetadata.quotaPolicyJson,
        item.run.created_at,
        item.run.updated_at,
      );
    }
    if (item.lineage !== null) {
      insertLineage.run(
        item.run.id,
        item.lineage.parentRunId,
        item.lineage.parentStepId,
        item.lineage.depth,
        item.lineage.ancestorDefinitionKeysJson,
        item.run.created_at,
        item.run.updated_at,
      );
    }
  }
}

function assertProjectionEquivalence(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
): void {
  for (const item of plan.runs) {
    const projected = projectLegacyWorkflowRunRoute(db, item.run.id, {
      source: item.run.source,
      definitionKey: item.run.workflow_definition_key,
      definitionVersion: item.run.workflow_definition_version,
    });
    if (!isDeepStrictEqual(projected, item.parsedRoute)) {
      throw new RouteStateMigrationError({
        runId: item.run.id,
        jsonPath: "$",
        code: "route_state_projection_mismatch",
        detail: "canonical destinations do not reconstruct the legacy route",
      });
    }
  }
}

function clearMigratedRouteJson(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
): void {
  const clear = db.prepare(
    "UPDATE workflow_runs SET route_json = '{}' WHERE id = ?",
  );
  for (const item of plan.runs) clear.run(item.run.id);
}

function assertForeignKeyCheckEmpty(db: MomentumDb): void {
  const rows = db.prepare("PRAGMA foreign_key_check").all();
  if (rows.length > 0) {
    throw new RouteStateMigrationError({
      runId: "<database>",
      jsonPath: "$schema.foreignKeys",
      code: "route_state_foreign_key_invalid",
      detail: `PRAGMA foreign_key_check returned ${rows.length} row(s)`,
    });
  }
}

function destinationSchemaState(db: MomentumDb): {
  present: number;
  total: number;
  missing: string[];
  existing: string[];
} {
  const states = [
    ...DESTINATION_TABLES.map((table) => ({
      name: table,
      present: tableExists(db, table),
    })),
    ...DESTINATION_COLUMNS.map(([table, column]) => ({
      name: `${table}.${column}`,
      present: columnExists(db, table, column),
    })),
  ];
  return {
    present: states.filter((state) => state.present).length,
    total: states.length,
    missing: states
      .filter((state) => !state.present)
      .map((state) => state.name),
    existing: states
      .filter((state) => state.present)
      .map((state) => state.name),
  };
}

function schemaPartialError(
  state: ReturnType<typeof destinationSchemaState>,
): RouteStateMigrationError {
  return new RouteStateMigrationError({
    runId: "<schema>",
    jsonPath: "$schema.routeState",
    code: "route_state_schema_partial",
    detail:
      `destination schema is partial; existing: ${state.existing.join(", ") || "none"}; ` +
      `missing: ${state.missing.join(", ") || "none"}`,
  });
}

function firstNonEmptyRoute(
  db: MomentumDb,
): { id: string; route_json: string | null } | undefined {
  return db
    .prepare(
      `SELECT id, route_json
         FROM workflow_runs
        WHERE route_json IS NOT NULL AND route_json <> '{}'
        ORDER BY id
        LIMIT 1`,
    )
    .get() as { id: string; route_json: string | null } | undefined;
}

function hasRouteStateBaseTables(db: MomentumDb): boolean {
  return (
    tableExists(db, "workflow_runs") &&
    tableExists(db, "workflow_steps") &&
    tableExists(db, "step_definitions")
  );
}

function tableExists(db: MomentumDb, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function columnExists(db: MomentumDb, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
      name: string;
    }>
  ).some((row) => row.name === column);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseOptionalConfig(
  runId: string,
  jsonPath: string,
  raw: string | null,
): Record<string, unknown> {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidValue(runId, jsonPath, "definition config JSON is malformed");
  }
  if (!isPlainObject(value)) {
    invalidValue(runId, jsonPath, "definition config JSON must be an object");
  }
  return value;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No active transaction.
  }
}
