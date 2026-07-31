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
  // Imported runs keep their metadata canonical-only in
  // workflow_run_import_metadata; the compatibility projection emits nothing.
  if (run.source === "agent-workflow") return {};

  const stepRows = db
    .prepare(
      `SELECT ws.step_id, ws.kind, ws.agent_config_json
         FROM workflow_steps AS ws
        WHERE ws.run_id = ?
        ORDER BY ws.step_order, ws.step_id`,
    )
    .all(runId) as Array<Omit<NativeStepRow, "run_id">>;
  return projectNativeRouteFromRows(runId, stepRows);
}

export function projectLegacyWorkflowRunRoutes(
  db: MomentumDb,
  runs: ReadonlyArray<WorkflowRunRouteProjectionInput>,
): Map<string, Record<string, unknown>> {
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  if (runsById.size === 0) return new Map();
  const runIds = [...runsById.keys()];
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
      projected.set(run.runId, {});
      continue;
    }
    projected.set(
      run.runId,
      projectNativeRouteFromRows(
        run.runId,
        stepRowsByRunId.get(run.runId) ?? [],
      ),
    );
  }
  return projected;
}

function projectNativeRouteFromRows(
  runId: string,
  stepRows: ReadonlyArray<Omit<NativeStepRow, "run_id"> | NativeStepRow>,
): Record<string, unknown> {
  // Implementation-engine and profile compatibility values stay canonical-only
  // in workflow_run_coding_compatibility; only the step-selection namespace is
  // still projected for later-issue consumers.
  const route: Record<string, unknown> = {};
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
