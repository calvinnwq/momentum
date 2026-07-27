import type { DatabaseSync } from "node:sqlite";

type MomentumDb = DatabaseSync;

export const LEGACY_WORKFLOW_STEP_KIND_ALIASES = {
  "no-mistakes": "validate",
  "linear-refresh": "tracker-refresh",
} as const;

export const LEGACY_ROUTE_TOP_LEVEL_KEYS = [
  "implementationEngine",
  "profile",
  "steps",
  "subworkflow",
  "mode",
  "risk",
  "quotaPolicy",
] as const;

export type WorkflowRunRouteProjectionSource = {
  source: string;
  definitionKey: string | null;
  definitionVersion: number | null;
};

export class RouteStateProjectionError extends Error {
  readonly runId: string;
  readonly jsonPath: string;

  constructor(runId: string, jsonPath: string, detail: string) {
    super(
      `Cannot project canonical route state for run '${runId}' at ${jsonPath}: ${detail}`,
    );
    this.name = "RouteStateProjectionError";
    this.runId = runId;
    this.jsonPath = jsonPath;
  }
}

export function projectLegacyWorkflowRunRoute(
  db: MomentumDb,
  runId: string,
  run: WorkflowRunRouteProjectionSource,
): Record<string, unknown> {
  return run.source === "agent-workflow"
    ? projectImportedRoute(db, runId)
    : projectNativeRoute(db, runId, run);
}

function projectNativeRoute(
  db: MomentumDb,
  runId: string,
  run: WorkflowRunRouteProjectionSource,
): Record<string, unknown> {
  const route: Record<string, unknown> = {};
  const compatibility = db
    .prepare(
      `SELECT implementation_engine, selected_profile
         FROM workflow_run_coding_compatibility
        WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        implementation_engine: string | null;
        selected_profile: string | null;
      }
    | undefined;
  if (compatibility?.implementation_engine != null) {
    route["implementationEngine"] = compatibility.implementation_engine;
  }
  if (compatibility?.selected_profile != null) {
    route["profile"] = compatibility.selected_profile;
  }

  const stepRows = db
    .prepare(
      `SELECT step_id, kind, agent_config_json, executor_config_json, step_order
         FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_order, step_id`,
    )
    .all(runId) as Array<{
    step_id: string;
    kind: string;
    agent_config_json: string;
    executor_config_json: string;
    step_order: number;
  }>;
  const steps: Record<string, unknown> = {};
  for (const row of stepRows) {
    const agentConfig = parseObject(
      row.agent_config_json,
      runId,
      `$.steps.${row.kind}`,
    );
    if (Object.keys(agentConfig).length === 0) continue;
    if (Object.hasOwn(steps, row.kind)) {
      throw new RouteStateProjectionError(
        runId,
        `$.steps.${row.kind}`,
        "multiple persisted steps have the same projected route kind",
      );
    }
    steps[row.kind] = agentConfig;
  }
  if (Object.keys(steps).length > 0) route["steps"] = steps;

  const subworkflow = projectSubworkflowNamespace(db, runId, run, stepRows);
  if (subworkflow !== undefined) route["subworkflow"] = subworkflow;
  return route;
}

function projectImportedRoute(
  db: MomentumDb,
  runId: string,
): Record<string, unknown> {
  const row = db
    .prepare(
      `SELECT mode, profile, risk, quota_policy_json
         FROM workflow_run_import_metadata
        WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        mode: string | null;
        profile: string | null;
        risk: string | null;
        quota_policy_json: string | null;
      }
    | undefined;
  if (row === undefined) return {};
  const route: Record<string, unknown> = {};
  if (row.mode !== null) route["mode"] = row.mode;
  if (row.profile !== null) route["profile"] = row.profile;
  if (row.risk !== null) route["risk"] = row.risk;
  if (row.quota_policy_json !== null) {
    route["quotaPolicy"] = parseObject(
      row.quota_policy_json,
      runId,
      "$.quotaPolicy",
    );
  }
  return route;
}

function projectSubworkflowNamespace(
  db: MomentumDb,
  runId: string,
  run: WorkflowRunRouteProjectionSource,
  stepRows: Array<{
    step_id: string;
    executor_config_json: string;
  }>,
): Record<string, unknown> | undefined {
  let child: unknown;
  if (run.definitionKey !== null && run.definitionVersion !== null) {
    const subworkflowStepIds = new Set(
      (
        db
          .prepare(
            `SELECT step_key
               FROM step_definitions
              WHERE definition_key = ?
                AND definition_version = ?
                AND executor = 'subworkflow'
              ORDER BY step_order, step_key`,
          )
          .all(run.definitionKey, run.definitionVersion) as Array<{
          step_key: string;
        }>
      ).map((row) => row.step_key),
    );
    for (const row of stepRows) {
      if (!subworkflowStepIds.has(row.step_id)) continue;
      const config = parseObject(
        row.executor_config_json,
        runId,
        `$.subworkflow.child`,
      );
      if (!Object.hasOwn(config, "child")) continue;
      if (child === undefined) {
        child = config["child"];
      } else if (JSON.stringify(child) !== JSON.stringify(config["child"])) {
        throw new RouteStateProjectionError(
          runId,
          "$.subworkflow.child",
          "subworkflow steps carry conflicting child config",
        );
      }
    }
  }

  const lineage = db
    .prepare(
      `SELECT parent_run_id, parent_step_id, depth,
              ancestor_definition_keys_json
         FROM workflow_run_lineage
        WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        parent_run_id: string;
        parent_step_id: string;
        depth: number;
        ancestor_definition_keys_json: string;
      }
    | undefined;
  if (child === undefined && lineage === undefined) return undefined;
  const namespace: Record<string, unknown> = {};
  if (child !== undefined) namespace["child"] = child;
  if (lineage !== undefined) {
    const ancestors = parseArray(
      lineage.ancestor_definition_keys_json,
      runId,
      "$.subworkflow.lineage.ancestorDefinitionKeys",
    );
    namespace["lineage"] = {
      parentRunId: lineage.parent_run_id,
      parentStepId: lineage.parent_step_id,
      depth: lineage.depth,
      ancestorDefinitionKeys: ancestors,
    };
  }
  return namespace;
}

function parseObject(
  raw: string,
  runId: string,
  jsonPath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RouteStateProjectionError(
      runId,
      jsonPath,
      "persisted JSON is malformed",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteStateProjectionError(
      runId,
      jsonPath,
      "persisted JSON is not an object",
    );
  }
  return parsed as Record<string, unknown>;
}

function parseArray(raw: string, runId: string, jsonPath: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RouteStateProjectionError(
      runId,
      jsonPath,
      "persisted JSON is malformed",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RouteStateProjectionError(
      runId,
      jsonPath,
      "persisted JSON is not an array",
    );
  }
  return parsed;
}
