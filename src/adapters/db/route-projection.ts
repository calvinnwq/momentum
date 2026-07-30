import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

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

export type WorkflowRunRouteProjectionInput =
  WorkflowRunRouteProjectionSource & {
    runId: string;
  };

type CompatibilityRow = {
  run_id: string;
  implementation_engine: string | null;
  selected_profile: string | null;
};

type ImportMetadataRow = {
  run_id: string;
  mode: string | null;
  profile: string | null;
  risk: string | null;
  quota_policy_json: string | null;
};

type NativeStepRow = {
  run_id: string;
  step_id: string;
  kind: string;
  agent_config_json: string;
};

const RUN_ID_QUERY_CHUNK_SIZE = 500;

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
  if (run.source === "agent-workflow") {
    const row = db
      .prepare(
        `SELECT mode, profile, risk, quota_policy_json
           FROM workflow_run_import_metadata
          WHERE run_id = ?`,
      )
      .get(runId) as Omit<ImportMetadataRow, "run_id"> | undefined;
    return projectImportedRouteFromRows(runId, row);
  }

  const compatibility = db
    .prepare(
      `SELECT implementation_engine, selected_profile
         FROM workflow_run_coding_compatibility
        WHERE run_id = ?`,
    )
    .get(runId) as Omit<CompatibilityRow, "run_id"> | undefined;
  const stepRows = db
    .prepare(
      `SELECT ws.step_id, ws.kind, ws.agent_config_json
         FROM workflow_steps AS ws
        WHERE ws.run_id = ?
        ORDER BY ws.step_order, ws.step_id`,
    )
    .all(runId) as Array<Omit<NativeStepRow, "run_id">>;
  return projectNativeRouteFromRows(runId, compatibility, stepRows);
}

export function projectLegacyWorkflowRunRoutes(
  db: MomentumDb,
  runs: ReadonlyArray<WorkflowRunRouteProjectionInput>,
): Map<string, Record<string, unknown>> {
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  if (runsById.size === 0) return new Map();
  const runIds = [...runsById.keys()];
  const compatibilityByRunId = new Map(
    queryRunScopedRows<CompatibilityRow>(
      db,
      `SELECT run_id, implementation_engine, selected_profile
         FROM workflow_run_coding_compatibility
        WHERE run_id`,
      runIds,
    ).map((row) => [row.run_id, row]),
  );
  const importMetadataByRunId = new Map(
    queryRunScopedRows<ImportMetadataRow>(
      db,
      `SELECT run_id, mode, profile, risk, quota_policy_json
         FROM workflow_run_import_metadata
        WHERE run_id`,
      runIds,
    ).map((row) => [row.run_id, row]),
  );
  const stepRowsByRunId = groupByRunId(
    queryRunScopedRows<NativeStepRow>(
      db,
      `SELECT ws.run_id, ws.step_id, ws.kind, ws.agent_config_json
         FROM workflow_steps AS ws
        WHERE ws.run_id`,
      runIds,
      " ORDER BY ws.run_id, ws.step_order, ws.step_id",
    ),
  );

  const projected = new Map<string, Record<string, unknown>>();
  for (const run of runsById.values()) {
    if (run.source === "agent-workflow") {
      projected.set(
        run.runId,
        projectImportedRouteFromRows(
          run.runId,
          importMetadataByRunId.get(run.runId),
        ),
      );
      continue;
    }
    projected.set(
      run.runId,
      projectNativeRouteFromRows(
        run.runId,
        compatibilityByRunId.get(run.runId),
        stepRowsByRunId.get(run.runId) ?? [],
      ),
    );
  }
  return projected;
}

function projectNativeRouteFromRows(
  runId: string,
  compatibility:
    Omit<CompatibilityRow, "run_id"> | CompatibilityRow | undefined,
  stepRows: ReadonlyArray<Omit<NativeStepRow, "run_id"> | NativeStepRow>,
): Record<string, unknown> {
  const route: Record<string, unknown> = {};
  if (compatibility?.implementation_engine != null) {
    route["implementationEngine"] = compatibility.implementation_engine;
  }
  if (compatibility?.selected_profile != null) {
    route["profile"] = compatibility.selected_profile;
  }

  const steps: Record<string, unknown> = {};
  for (const row of stepRows) {
    const agentConfig = parseObject(
      row.agent_config_json,
      runId,
      `$.steps.${row.kind}`,
    );
    if (Object.keys(agentConfig).length === 0) continue;
    if (Object.hasOwn(steps, row.kind)) {
      if (isDeepStrictEqual(steps[row.kind], agentConfig)) continue;
      throw new RouteStateProjectionError(
        runId,
        `$.steps.${row.kind}`,
        "multiple persisted steps have the same projected route kind",
      );
    }
    steps[row.kind] = agentConfig;
  }
  if (Object.keys(steps).length > 0) route["steps"] = steps;
  return route;
}

function projectImportedRouteFromRows(
  runId: string,
  row: Omit<ImportMetadataRow, "run_id"> | ImportMetadataRow | undefined,
): Record<string, unknown> {
  const route: Record<string, unknown> = {};
  if (row?.mode != null) route["mode"] = row.mode;
  if (row?.profile != null) route["profile"] = row.profile;
  if (row?.risk != null) route["risk"] = row.risk;
  if (row?.quota_policy_json != null) {
    route["quotaPolicy"] = parseObject(
      row.quota_policy_json,
      runId,
      "$.quotaPolicy",
    );
  }
  return route;
}

function queryRunScopedRows<T>(
  db: MomentumDb,
  query: string,
  runIds: readonly string[],
  orderBy = "",
): T[] {
  const rows: T[] = [];
  for (
    let offset = 0;
    offset < runIds.length;
    offset += RUN_ID_QUERY_CHUNK_SIZE
  ) {
    const chunk = runIds.slice(offset, offset + RUN_ID_QUERY_CHUNK_SIZE);
    rows.push(
      ...(db
        .prepare(`${query} IN (${chunk.map(() => "?").join(", ")})${orderBy}`)
        .all(...chunk) as T[]),
    );
  }
  return rows;
}

function groupByRunId<T extends { run_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.run_id);
    if (current === undefined) grouped.set(row.run_id, [row]);
    else current.push(row);
  }
  return grouped;
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
