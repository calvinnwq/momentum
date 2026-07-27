import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  LEGACY_WORKFLOW_STEP_KIND_ALIASES,
  projectLegacyWorkflowRunRoutes,
  RouteStateProjectionError,
  type WorkflowRunRouteProjectionInput,
  type WorkflowRunRouteProjectionSource,
} from "./route-projection.js";
import { RouteStateMigrationError } from "./route-state-errors.js";
import {
  isPlainObject,
  parseWorkflowRoute,
  validateWorkflowRoute,
  type ValidatedRouteLineage,
} from "./route-state-validation.js";

export {
  ROUTE_STATE_MIGRATION_ERROR_CODES,
  RouteStateMigrationError,
  type RouteStateMigrationErrorCode,
} from "./route-state-errors.js";
export {
  validateWorkflowRouteShape,
  validateWorkflowRouteStepProjection,
} from "./route-state-validation.js";

type MomentumDb = DatabaseSync;

const DESTINATION_COLUMNS = [
  {
    table: "step_definitions",
    column: "agent_config_json",
    definition: "TEXT",
    notNull: 0,
    defaultValue: null,
    primaryKey: 0,
  },
  {
    table: "workflow_steps",
    column: "agent_config_json",
    definition: "TEXT NOT NULL DEFAULT '{}'",
    notNull: 1,
    defaultValue: "'{}'",
    primaryKey: 0,
  },
  {
    table: "workflow_steps",
    column: "executor_config_json",
    definition: "TEXT NOT NULL DEFAULT '{}'",
    notNull: 1,
    defaultValue: "'{}'",
    primaryKey: 0,
  },
] as const;
const DESTINATION_TABLES = [
  {
    name: "workflow_run_lineage",
    definition: `
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
) STRICT`,
  },
  {
    name: "workflow_run_coding_compatibility",
    definition: `
CREATE TABLE IF NOT EXISTS workflow_run_coding_compatibility (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  implementation_engine TEXT,
  -- Historical native profile compatibility, never host-binding authority.
  selected_profile TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (implementation_engine IS NULL OR trim(implementation_engine) <> ''),
  CHECK (selected_profile IS NULL OR trim(selected_profile) <> '')
) STRICT`,
  },
  {
    name: "workflow_run_import_metadata",
    definition: `
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
  CHECK (risk IS NULL OR trim(risk) <> '')
) STRICT`,
  },
] as const;
const VALIDATION_QUERY_CHUNK_SIZE = 500;

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
  ancestorDefinitionKeys: string[];
  ancestorDefinitionKeysJson: string;
};

type LineageFields = ValidatedRouteLineage;

type LineageParentFact = {
  parent_definition_key: string | null;
  parent_definition_version: number | null;
  step_definition_key: string | null;
  step_definition_version: number | null;
  step_executor: string | null;
};

type StepConfigPlan = {
  stepId: string;
  agentConfigJson: string;
  executorConfigJson: string;
};

type RouteRunPlan = {
  run: RunRow;
  validatedRoute: ReturnType<typeof validateWorkflowRoute>;
  parsedRoute: Record<string, unknown>;
  compatibility: CodingCompatibilityPlan | null;
  importMetadata: ImportMetadataPlan | null;
  lineage: LineagePlan | null;
  steps: StepConfigPlan[];
};

export type WorkflowRouteStatePlan = {
  runs: RouteRunPlan[];
  dataVersion?: number;
  deferredUntilBaseComplete?: boolean;
};

export function validateWorkflowRouteLineage(
  db: MomentumDb,
  input: {
    runId: string;
    source: string;
    route: Record<string, unknown>;
    definitionKey: string | null;
    definitionVersion: number | null;
    createdAt: number;
    updatedAt: number;
  },
): void {
  const validated = validateWorkflowRoute(input);
  if (validated.lineage === null) {
    return;
  }
  const run: RunRow = {
    id: input.runId,
    source: input.source,
    route_json: JSON.stringify(input.route),
    workflow_definition_key: input.definitionKey,
    workflow_definition_version: input.definitionVersion,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
  const lineageRuns = loadLineageValidationRuns(db, run);
  const canonicalLineageByRunId = loadCanonicalLineageFields(db);
  const parentFacts = loadLineageParentFacts(
    db,
    lineageRuns,
    canonicalLineageByRunId,
    new Map([[run.id, validated]]),
  );
  validateLineageChain(
    run,
    "$.subworkflow.lineage",
    validated.lineage,
    lineageRuns,
    parentFacts,
    canonicalLineageByRunId,
  );
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
  const validated = validateWorkflowRoute(input);
  const run: RunRow = {
    id: input.runId,
    source: input.source,
    route_json: JSON.stringify(input.route),
    workflow_definition_key: input.definitionKey,
    workflow_definition_version: input.definitionVersion,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
  const lineageRuns =
    validated.lineage === null ? undefined : loadLineageValidationRuns(db, run);
  const plan = planRun(
    db,
    run,
    input.definitionAgentConfigs,
    input.definitionExecutorConfigs,
    lineageRuns,
    validated,
  );
  if (plan.lineage !== null && lineageRuns !== undefined) {
    validateLineagePlans(db, { runs: [plan] }, lineageRuns);
  }
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

export function projectValidatedLegacyWorkflowRunRoute(
  db: MomentumDb,
  runId: string,
  run: WorkflowRunRouteProjectionSource,
): Record<string, unknown> {
  return (
    projectValidatedLegacyWorkflowRunRoutes(db, [{ runId, ...run }]).get(
      runId,
    ) ?? {}
  );
}

export function projectValidatedLegacyWorkflowRunRoutes(
  db: MomentumDb,
  runs: ReadonlyArray<WorkflowRunRouteProjectionInput>,
): Map<string, Record<string, unknown>> {
  if (runs.length === 0) return new Map();
  const requestedIds = new Set(runs.map((run) => run.runId));
  const rowsById = loadCanonicalValidationRunClosure(db, requestedIds);
  try {
    const projectedByRunId = projectLegacyWorkflowRunRoutes(
      db,
      [...rowsById.values()].map((run) => ({
        runId: run.id,
        source: run.source,
        definitionKey: run.workflow_definition_key,
        definitionVersion: run.workflow_definition_version,
      })),
    );
    validateProjectedCanonicalRoutes(db, rowsById, projectedByRunId);
    return new Map(
      [...requestedIds].map((runId) => [
        runId,
        projectedByRunId.get(runId) ?? {},
      ]),
    );
  } catch (error) {
    throw normalizeRouteStateMigrationError(error);
  }
}

export function routeStateMigrationNeeded(db: MomentumDb): boolean {
  const baseState = routeStateBaseSchemaState(db);
  if (baseState.present === 0) return false;
  if (hasBlockingBaseSchemaMalformation(baseState)) {
    throw routeBaseSchemaError(baseState);
  }
  if (baseState.present < baseState.total) {
    const route = firstNonEmptyBaseRoute(db);
    if (route === undefined) return false;
    throw routeBaseSchemaError(baseState, route.id);
  }
  const state = destinationSchemaState(db);
  if (
    state.malformed.length > 0 ||
    (state.present > 0 && state.present < state.total)
  ) {
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
  const dataVersion = databaseDataVersion(db);
  const baseState = routeStateBaseSchemaState(db);
  if (baseState.present === 0) return { runs: [], dataVersion };
  if (hasBlockingBaseSchemaMalformation(baseState)) {
    throw routeBaseSchemaError(baseState);
  }
  if (baseState.present < baseState.total) {
    const route = firstNonEmptyBaseRoute(db);
    if (route === undefined) {
      return { runs: [], dataVersion, deferredUntilBaseComplete: true };
    }
    throw routeBaseSchemaError(baseState, route.id);
  }
  assertRouteDestinationForeignKeysEmpty(db, ["workflow_steps"]);
  const state = destinationSchemaState(db);
  if (
    state.malformed.length > 0 ||
    (state.present > 0 && state.present < state.total)
  ) {
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
    assertRouteDestinationForeignKeysEmpty(db);
    auditCanonicalRouteState(db);
    return { runs: [], dataVersion };
  }

  const definitionKeySelect = columnExists(
    db,
    "workflow_runs",
    "workflow_definition_key",
  )
    ? "workflow_definition_key"
    : "NULL AS workflow_definition_key";
  const definitionVersionSelect = columnExists(
    db,
    "workflow_runs",
    "workflow_definition_version",
  )
    ? "workflow_definition_version"
    : "NULL AS workflow_definition_version";
  const rows = db
    .prepare(
      `SELECT id, source, route_json, ${definitionKeySelect},
              ${definitionVersionSelect}, created_at, updated_at
         FROM workflow_runs
        ORDER BY id`,
    )
    .all() as RunRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const plan = {
    runs: rows.map((row) => planRun(db, row, undefined, undefined, rowsById)),
    dataVersion,
  };
  validateLineagePlans(db, plan, rowsById);
  return plan;
}

export function assertWorkflowRouteStatePlanCurrent(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
): void {
  if (plan.runs.length === 0) {
    const current = preScanRouteState(db);
    if (current.runs.length === 0) return;
    throw new RouteStateMigrationError({
      runId: "<database>",
      jsonPath: "$",
      code: "route_state_canonical_conflict",
      detail: "database route state changed after route migration preflight",
    });
  }
  if (
    plan.dataVersion !== undefined &&
    databaseDataVersion(db) !== plan.dataVersion
  ) {
    throw new RouteStateMigrationError({
      runId: "<database>",
      jsonPath: "$",
      code: "route_state_canonical_conflict",
      detail: "database state changed after route migration preflight",
    });
  }
}

export function refreshWorkflowRouteStatePlan(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
): void {
  if (plan.runs.length === 0) return;
  const routes = new Map(
    (
      db.prepare("SELECT id, route_json FROM workflow_runs").all() as Array<{
        id: string;
        route_json: string | null;
      }>
    ).map((row) => [row.id, row.route_json]),
  );
  for (const item of plan.runs) {
    const routeJson = routes.get(item.run.id);
    if (routeJson === undefined) continue;
    item.run.route_json = routeJson;
    item.parsedRoute = validateWorkflowRoute({
      runId: item.run.id,
      source: item.run.source,
      route: parseWorkflowRoute(item.run.id, routeJson),
    }).route;
  }
}

export function createRouteStateDestinations(db: MomentumDb): void {
  for (const contract of DESTINATION_COLUMNS) {
    if (!columnExists(db, contract.table, contract.column)) {
      db.exec(
        `ALTER TABLE ${quoteIdentifier(contract.table)} ADD COLUMN ${quoteIdentifier(contract.column)} ${contract.definition}`,
      );
    }
  }
  db.exec(
    DESTINATION_TABLES.map((contract) => contract.definition).join(";\n"),
  );
}

export function applyWorkflowRouteStateMigration(db: MomentumDb): void {
  if (!hasRouteStateBaseTables(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    applyWorkflowRouteStateMigrationInTransaction(db);
    db.exec("COMMIT");
  } catch (error) {
    safeRollback(db);
    throw normalizeRouteStateMigrationError(error);
  }
}

export function applyWorkflowRouteStateMigrationInTransaction(
  db: MomentumDb,
  plan?: WorkflowRouteStatePlan,
): void {
  if (!hasRouteStateBaseTables(db)) return;
  const routeStatePlan = plan ?? preScanRouteState(db);
  try {
    createRouteStateDestinations(db);
    applyRouteStatePlan(db, routeStatePlan);
    assertProjectionEquivalence(db, routeStatePlan);
    clearMigratedRouteJson(db, routeStatePlan);
    assertRouteDestinationForeignKeysEmpty(db);
  } catch (error) {
    throw normalizeRouteStateMigrationError(error);
  }
}

function planRun(
  db: MomentumDb,
  run: RunRow,
  definitionAgentConfigs?: ReadonlyMap<string, Record<string, string>>,
  definitionExecutorConfigs?: ReadonlyMap<string, Record<string, unknown>>,
  lineageRuns?: ReadonlyMap<string, RunRow>,
  validated?: ReturnType<typeof validateWorkflowRoute>,
): RouteRunPlan {
  const route =
    validated ??
    validateWorkflowRoute({
      runId: run.id,
      source: run.source,
      route: parseWorkflowRoute(run.id, run.route_json),
    });
  const steps = planStepAgentConfigs(
    db,
    run,
    route.stepAgentConfigs,
    definitionAgentConfigs,
  );
  const subworkflow = planSubworkflow(db, run, route, lineageRuns);
  const compatibility =
    run.source === "momentum-native-coding" ||
    (run.source !== "agent-workflow" &&
      (route.implementationEngine !== null || route.profile !== null))
      ? {
          implementationEngine: route.implementationEngine,
          selectedProfile: route.profile,
        }
      : null;
  const importMetadata =
    run.source === "agent-workflow"
      ? {
          mode: route.mode,
          profile: route.profile,
          risk: route.risk,
          quotaPolicyJson: route.quotaPolicyJson,
        }
      : null;
  return {
    run,
    validatedRoute: route,
    parsedRoute: route.route,
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

function planStepAgentConfigs(
  db: MomentumDb,
  run: RunRow,
  agentConfigs: ReadonlyMap<string, string>,
  definitionAgentConfigs?: ReadonlyMap<string, Record<string, string>>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [canonicalKind, config] of agentConfigs) {
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
        jsonPath: `$.steps.${canonicalKind}`,
        code: "route_state_step_target_missing",
        detail: `no persisted step has canonical kind '${canonicalKind}'`,
      });
    }
    if (matches.length > 1 && definitionAgentConfigs === undefined) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: `$.steps.${canonicalKind}`,
        code: "route_state_step_target_ambiguous",
        detail: `multiple persisted steps have canonical kind '${canonicalKind}'`,
      });
    }
    for (const match of matches) {
      result.set(match.step_id, config);
    }
  }
  return result;
}

function planSubworkflow(
  db: MomentumDb,
  run: RunRow,
  route: ReturnType<typeof validateWorkflowRoute>,
  lineageRuns?: ReadonlyMap<string, RunRow>,
): { child: Record<string, unknown> | null; lineage: LineagePlan | null } {
  if (route.child !== null) {
    const at = "$.subworkflow.child";
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
  if (route.lineage === null) {
    return { child: route.child, lineage: null };
  }
  const lineage = route.lineage;
  if (lineageRuns === undefined) {
    const at = "$.subworkflow.lineage";
    const parent = db
      .prepare("SELECT 1 FROM workflow_steps WHERE run_id = ? AND step_id = ?")
      .get(lineage.parentRunId, lineage.parentStepId);
    if (parent === undefined) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: `${at}.parentStepId`,
        code: "route_state_lineage_parent_missing",
        detail: "parent run step does not exist",
      });
    }
  }
  return {
    child: route.child,
    lineage: {
      ...lineage,
      ancestorDefinitionKeysJson: JSON.stringify(
        lineage.ancestorDefinitionKeys,
      ),
    },
  };
}

function validateLineagePlans(
  db: MomentumDb,
  plan: WorkflowRouteStatePlan,
  lineageRuns: ReadonlyMap<string, RunRow>,
): void {
  const validatedRoutes = new Map(
    plan.runs.map((item) => [item.run.id, item.validatedRoute]),
  );
  const canonicalLineageByRunId = loadCanonicalLineageFields(db);
  const parentFacts = loadLineageParentFacts(
    db,
    lineageRuns,
    canonicalLineageByRunId,
    validatedRoutes,
  );
  for (const item of plan.runs) {
    if (item.lineage === null) continue;
    validateLineageChain(
      item.run,
      "$.subworkflow.lineage",
      item.lineage,
      lineageRuns,
      parentFacts,
      canonicalLineageByRunId,
    );
  }
}

function loadLineageParentFacts(
  db: MomentumDb,
  lineageRuns: ReadonlyMap<string, RunRow>,
  canonicalLineageByRunId: ReadonlyMap<string, LineageFields>,
  validatedRoutes: ReadonlyMap<
    string,
    ReturnType<typeof validateWorkflowRoute>
  > = new Map(),
): Map<string, LineageParentFact> {
  const parentRunIds = new Set<string>();
  for (const run of lineageRuns.values()) {
    const lineage = readLineageFields(
      run,
      canonicalLineageByRunId,
      validatedRoutes,
    );
    if (lineage !== null) parentRunIds.add(lineage.parentRunId);
  }

  const facts = new Map<string, LineageParentFact>();
  const ids = [...parentRunIds];
  for (
    let offset = 0;
    offset < ids.length;
    offset += VALIDATION_QUERY_CHUNK_SIZE
  ) {
    const chunk = ids.slice(offset, offset + VALIDATION_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT wr.id AS parent_run_id, ws.step_id AS parent_step_id,
                wr.workflow_definition_key AS parent_definition_key,
                wr.workflow_definition_version AS parent_definition_version,
                sd.definition_key AS step_definition_key,
                sd.definition_version AS step_definition_version,
                sd.executor AS step_executor
           FROM workflow_runs AS wr
           JOIN workflow_steps AS ws ON ws.run_id = wr.id
           LEFT JOIN step_definitions AS sd
             ON sd.definition_key = wr.workflow_definition_key
            AND sd.definition_version = wr.workflow_definition_version
            AND sd.step_key = ws.step_id
          WHERE wr.id IN (${placeholders})`,
      )
      .all(...chunk) as Array<
      LineageParentFact & {
        parent_run_id: string;
        parent_step_id: string;
      }
    >;
    for (const row of rows) {
      facts.set(
        lineageParentFactKey(row.parent_run_id, row.parent_step_id),
        row,
      );
    }
  }
  return facts;
}

function validateLineageChain(
  childRun: RunRow,
  path: string,
  lineage: LineageFields,
  lineageRuns: ReadonlyMap<string, RunRow>,
  parentFacts: ReadonlyMap<string, LineageParentFact>,
  canonicalLineageByRunId: ReadonlyMap<string, LineageFields>,
): void {
  let currentRun = childRun;
  let currentLineage = lineage;
  let currentPath = path;
  const visited = new Set([childRun.id]);

  while (true) {
    const parentRun = lineageRuns.get(currentLineage.parentRunId);
    if (parentRun === undefined) {
      throw new RouteStateMigrationError({
        runId: currentRun.id,
        jsonPath: `${currentPath}.parentRunId`,
        code: "route_state_lineage_parent_missing",
        detail: "parent run step does not exist",
      });
    }
    if (visited.has(parentRun.id)) {
      invalidLineage(
        currentRun.id,
        `${currentPath}.parentRunId`,
        "lineage parent chain contains a cycle",
      );
    }
    visited.add(parentRun.id);

    const parent = parentFacts.get(
      lineageParentFactKey(
        currentLineage.parentRunId,
        currentLineage.parentStepId,
      ),
    );
    if (parent === undefined) {
      throw new RouteStateMigrationError({
        runId: currentRun.id,
        jsonPath: `${currentPath}.parentStepId`,
        code: "route_state_lineage_parent_missing",
        detail: "parent run step does not exist",
      });
    }
    if (parent.step_executor !== "subworkflow") {
      invalidLineage(
        currentRun.id,
        `${currentPath}.parentStepId`,
        "parent step is not a subworkflow dispatch",
      );
    }
    if (
      parent.parent_definition_key === null ||
      parent.parent_definition_version === null ||
      parent.step_definition_key !== parent.parent_definition_key ||
      parent.step_definition_version !== parent.parent_definition_version
    ) {
      invalidLineage(
        currentRun.id,
        `${currentPath}.parentStepId`,
        "parent step is not linked to the parent run definition",
      );
    }

    const parentLineage = readLineageFields(parentRun, canonicalLineageByRunId);
    const expectedAncestors =
      parentLineage === null
        ? [parent.parent_definition_key]
        : [
            ...parentLineage.ancestorDefinitionKeys,
            parent.parent_definition_key,
          ];
    if (
      currentLineage.depth !== expectedAncestors.length ||
      !isDeepStrictEqual(
        currentLineage.ancestorDefinitionKeys,
        expectedAncestors,
      )
    ) {
      invalidLineage(
        currentRun.id,
        `${currentPath}.ancestorDefinitionKeys`,
        "ancestorDefinitionKeys does not match the parent lineage chain",
      );
    }
    if (parentLineage === null) return;
    currentRun = parentRun;
    currentLineage = parentLineage;
    currentPath = "$.subworkflow.lineage";
  }
}

function lineageParentFactKey(runId: string, stepId: string): string {
  return JSON.stringify([runId, stepId]);
}

function readLineageFields(
  run: RunRow,
  canonicalLineageByRunId: ReadonlyMap<string, LineageFields>,
  validatedRoutes: ReadonlyMap<
    string,
    ReturnType<typeof validateWorkflowRoute>
  > = new Map(),
): LineageFields | null {
  const validated =
    validatedRoutes.get(run.id) ??
    validateWorkflowRoute({
      runId: run.id,
      source: run.source,
      route: parseWorkflowRoute(run.id, run.route_json),
    });
  return validated.lineage ?? canonicalLineageByRunId.get(run.id) ?? null;
}

function loadLineageValidationRuns(
  db: MomentumDb,
  currentRun: RunRow,
): Map<string, RunRow> {
  const rows = db
    .prepare(
      `SELECT id, source, route_json, workflow_definition_key,
              workflow_definition_version, created_at, updated_at
         FROM workflow_runs`,
    )
    .all() as RunRow[];
  const lineageRuns = new Map(rows.map((row) => [row.id, row]));
  lineageRuns.set(currentRun.id, currentRun);
  return lineageRuns;
}

function loadCanonicalLineageFields(
  db: MomentumDb,
): Map<string, LineageFields> {
  if (!tableExists(db, "workflow_run_lineage")) return new Map();
  const rows = db
    .prepare(
      `SELECT run_id, parent_run_id, parent_step_id, depth,
              ancestor_definition_keys_json
         FROM workflow_run_lineage`,
    )
    .all() as Array<{
    run_id: string;
    parent_run_id: string;
    parent_step_id: string;
    depth: number;
    ancestor_definition_keys_json: string;
  }>;
  return new Map(
    rows.map((row) => {
      let ancestors: unknown;
      try {
        ancestors = JSON.parse(row.ancestor_definition_keys_json);
      } catch {
        invalidLineage(
          row.run_id,
          "$.subworkflow.lineage.ancestorDefinitionKeys",
          "canonical lineage ancestorDefinitionKeys is not valid JSON",
        );
      }
      if (
        !Array.isArray(ancestors) ||
        !ancestors.every(
          (key) => typeof key === "string" && key.trim().length > 0,
        )
      ) {
        invalidLineage(
          row.run_id,
          "$.subworkflow.lineage.ancestorDefinitionKeys",
          "canonical lineage ancestorDefinitionKeys must be an array of non-blank strings",
        );
      }
      if (row.depth !== ancestors.length) {
        invalidLineage(
          row.run_id,
          "$.subworkflow.lineage.depth",
          "canonical lineage depth must equal ancestorDefinitionKeys.length",
        );
      }
      if (new Set(ancestors).size !== ancestors.length) {
        invalidLineage(
          row.run_id,
          "$.subworkflow.lineage.ancestorDefinitionKeys",
          "canonical lineage ancestorDefinitionKeys must not repeat a definition",
        );
      }
      return [
        row.run_id,
        {
          parentRunId: requiredNonBlankString(
            row.run_id,
            "$.subworkflow.lineage.parentRunId",
            row.parent_run_id,
            true,
          ),
          parentStepId: requiredNonBlankString(
            row.run_id,
            "$.subworkflow.lineage.parentStepId",
            row.parent_step_id,
            true,
          ),
          depth: requiredPositiveInteger(
            row.run_id,
            "$.subworkflow.lineage.depth",
            row.depth,
            true,
          ),
          ancestorDefinitionKeys: ancestors as string[],
        },
      ] as const;
    }),
  );
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
  const projectedByRunId = projectLegacyWorkflowRunRoutes(
    db,
    plan.runs.map((item) => ({
      runId: item.run.id,
      source: item.run.source,
      definitionKey: item.run.workflow_definition_key,
      definitionVersion: item.run.workflow_definition_version,
    })),
  );
  for (const item of plan.runs) {
    const projected = projectedByRunId.get(item.run.id);
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

export function auditCanonicalRouteState(db: MomentumDb): void {
  const runs = db
    .prepare(
      `SELECT id, source, route_json, workflow_definition_key,
              workflow_definition_version, created_at, updated_at
         FROM workflow_runs
        ORDER BY id`,
    )
    .all() as RunRow[];
  projectValidatedLegacyWorkflowRunRoutes(
    db,
    runs.map((run) => ({
      runId: run.id,
      source: run.source,
      definitionKey: run.workflow_definition_key,
      definitionVersion: run.workflow_definition_version,
    })),
  );
}

function loadCanonicalValidationRunClosure(
  db: MomentumDb,
  requestedIds: ReadonlySet<string>,
): Map<string, RunRow> {
  const loadedRowsById = new Map<string, RunRow>();
  const parentRunIdsById = new Map<string, string | null>();
  const runIds = [...requestedIds];
  for (
    let offset = 0;
    offset < runIds.length;
    offset += VALIDATION_QUERY_CHUNK_SIZE
  ) {
    const chunk = runIds.slice(offset, offset + VALIDATION_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `WITH RECURSIVE route_run_closure(run_id) AS (
           SELECT id
             FROM workflow_runs
            WHERE id IN (${placeholders})
           UNION
           SELECT lineage.parent_run_id
             FROM workflow_run_lineage AS lineage
             JOIN route_run_closure AS closure
               ON closure.run_id = lineage.run_id
         )
         SELECT wr.id, wr.source, wr.route_json,
                wr.workflow_definition_key,
                wr.workflow_definition_version, wr.created_at, wr.updated_at,
                lineage.parent_run_id
           FROM workflow_runs AS wr
           JOIN route_run_closure AS closure
             ON closure.run_id = wr.id
           LEFT JOIN workflow_run_lineage AS lineage
             ON lineage.run_id = wr.id
          ORDER BY wr.id`,
      )
      .all(...chunk) as Array<RunRow & { parent_run_id: string | null }>;
    for (const row of rows) {
      loadedRowsById.set(row.id, row);
      parentRunIdsById.set(row.id, row.parent_run_id);
    }
  }
  const rowsById = new Map<string, RunRow>();
  const pending = [...requestedIds];
  while (pending.length > 0) {
    const runId = pending.pop()!;
    if (rowsById.has(runId)) continue;
    const run = loadedRowsById.get(runId);
    if (run === undefined) continue;
    rowsById.set(runId, run);
    const parentRunId = parentRunIdsById.get(runId);
    if (parentRunId !== undefined && parentRunId !== null) {
      pending.push(parentRunId);
    }
  }
  return rowsById;
}

function validateProjectedCanonicalRoutes(
  db: MomentumDb,
  rowsById: ReadonlyMap<string, RunRow>,
  projectedByRunId: ReadonlyMap<string, Record<string, unknown>>,
): void {
  assertCanonicalRowsMatchRunSources(db, rowsById);
  const nativeRunIds = new Set(
    [...rowsById.values()]
      .filter((run) => run.source === "momentum-native-coding")
      .map((run) => run.id),
  );
  const compatibilityRunIds = loadCanonicalCompatibilityRunIds(
    db,
    nativeRunIds,
  );
  const projectedRunsById = new Map<string, RunRow>();
  const validatedRoutes = new Map<
    string,
    ReturnType<typeof validateWorkflowRoute>
  >();
  for (const run of rowsById.values()) {
    if (
      run.source === "momentum-native-coding" &&
      !compatibilityRunIds.has(run.id)
    ) {
      throw new RouteStateMigrationError({
        runId: run.id,
        jsonPath: "$canonical.workflow_run_coding_compatibility",
        code: "route_state_canonical_conflict",
        detail: "native coding run is missing its compatibility marker row",
      });
    }
    const projectedRoute = projectedByRunId.get(run.id) ?? {};
    const validated = validateWorkflowRoute({
      runId: run.id,
      source: run.source,
      route: projectedRoute,
    });
    validatedRoutes.set(run.id, validated);
    projectedRunsById.set(run.id, {
      ...run,
      route_json: JSON.stringify(projectedRoute),
    });
  }
  const canonicalLineageByRunId = loadCanonicalLineageFields(db);
  const parentFacts = loadLineageParentFacts(
    db,
    projectedRunsById,
    canonicalLineageByRunId,
    validatedRoutes,
  );
  for (const run of projectedRunsById.values()) {
    const route = validatedRoutes.get(run.id);
    if (route === undefined) continue;
    const subworkflow = planSubworkflow(db, run, route, projectedRunsById);
    if (subworkflow.lineage !== null) {
      validateLineageChain(
        run,
        "$.subworkflow.lineage",
        subworkflow.lineage,
        projectedRunsById,
        parentFacts,
        canonicalLineageByRunId,
      );
    }
  }
}

function assertCanonicalRowsMatchRunSources(
  db: MomentumDb,
  rowsById: ReadonlyMap<string, RunRow>,
): void {
  const ids = [...rowsById.keys()];
  for (
    let offset = 0;
    offset < ids.length;
    offset += VALIDATION_QUERY_CHUNK_SIZE
  ) {
    const chunk = ids.slice(offset, offset + VALIDATION_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const incompatibleCompatibility = db
      .prepare(
        `SELECT cc.run_id
           FROM workflow_run_coding_compatibility AS cc
           JOIN workflow_runs AS wr ON wr.id = cc.run_id
          WHERE cc.run_id IN (${placeholders})
            AND wr.source = 'agent-workflow'
          ORDER BY cc.run_id
          LIMIT 1`,
      )
      .get(...chunk) as { run_id: string } | undefined;
    if (incompatibleCompatibility !== undefined) {
      throw new RouteStateMigrationError({
        runId: incompatibleCompatibility.run_id,
        jsonPath: "$canonical.workflow_run_coding_compatibility",
        code: "route_state_source_conflict",
        detail:
          "coding compatibility state cannot attach to an imported agent-workflow run",
      });
    }
    const incompatibleImport = db
      .prepare(
        `SELECT metadata.run_id
           FROM workflow_run_import_metadata AS metadata
           JOIN workflow_runs AS wr ON wr.id = metadata.run_id
          WHERE metadata.run_id IN (${placeholders})
            AND wr.source <> 'agent-workflow'
          ORDER BY metadata.run_id
          LIMIT 1`,
      )
      .get(...chunk) as { run_id: string } | undefined;
    if (incompatibleImport !== undefined) {
      throw new RouteStateMigrationError({
        runId: incompatibleImport.run_id,
        jsonPath: "$canonical.workflow_run_import_metadata",
        code: "route_state_source_conflict",
        detail:
          "import metadata cannot attach to a run whose source is not agent-workflow",
      });
    }
    const missingImport = db
      .prepare(
        `SELECT wr.id
           FROM workflow_runs AS wr
           LEFT JOIN workflow_run_import_metadata AS metadata
             ON metadata.run_id = wr.id
          WHERE wr.id IN (${placeholders})
            AND wr.source = 'agent-workflow'
            AND wr.source_artifact_path IS NOT NULL
            AND metadata.run_id IS NULL
          ORDER BY wr.id
          LIMIT 1`,
      )
      .get(...chunk) as { id: string } | undefined;
    if (missingImport !== undefined) {
      throw new RouteStateMigrationError({
        runId: missingImport.id,
        jsonPath: "$canonical.workflow_run_import_metadata",
        code: "route_state_canonical_conflict",
        detail: "imported run is missing its canonical metadata marker row",
      });
    }
  }
}

function loadCanonicalCompatibilityRunIds(
  db: MomentumDb,
  runIds: ReadonlySet<string>,
): Set<string> {
  const compatibilityRunIds = new Set<string>();
  const ids = [...runIds];
  for (
    let offset = 0;
    offset < ids.length;
    offset += VALIDATION_QUERY_CHUNK_SIZE
  ) {
    const chunk = ids.slice(offset, offset + VALIDATION_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT run_id
           FROM workflow_run_coding_compatibility
          WHERE run_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ run_id: string }>;
    for (const row of rows) compatibilityRunIds.add(row.run_id);
  }
  return compatibilityRunIds;
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

function assertRouteDestinationForeignKeysEmpty(
  db: MomentumDb,
  tables: readonly string[] = [
    "workflow_steps",
    ...DESTINATION_TABLES.map((contract) => contract.name),
  ],
): void {
  for (const table of tables) {
    if (!tableExists(db, table)) continue;
    const rows = db
      .prepare(`PRAGMA foreign_key_check(${quoteIdentifier(table)})`)
      .all() as Array<{ rowid: number | null }>;
    if (rows.length === 0) continue;
    const first = rows[0]!;
    const row =
      first.rowid === null
        ? undefined
        : (db
            .prepare(
              `SELECT run_id FROM ${quoteIdentifier(table)} WHERE rowid = ?`,
            )
            .get(first.rowid) as { run_id: string } | undefined);
    throw new RouteStateMigrationError({
      runId: row?.run_id ?? "<database>",
      jsonPath: `$canonical.${table}.run_id`,
      code: "route_state_foreign_key_invalid",
      detail: `${table} contains ${rows.length} invalid foreign-key reference(s)`,
    });
  }
}

function destinationSchemaState(db: MomentumDb): {
  present: number;
  total: number;
  missing: string[];
  existing: string[];
  malformed: string[];
} {
  const states = [
    ...DESTINATION_TABLES.map((contract) => ({
      name: contract.name,
      present: tableExists(db, contract.name),
      valid: destinationTableMatchesContract(db, contract),
    })),
    ...DESTINATION_COLUMNS.map((contract) => ({
      name: `${contract.table}.${contract.column}`,
      present: columnExists(db, contract.table, contract.column),
      valid: destinationColumnMatchesContract(db, contract),
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
    malformed: states
      .filter((state) => state.present && !state.valid)
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
      `missing: ${state.missing.join(", ") || "none"}; ` +
      `malformed: ${state.malformed.join(", ") || "none"}`,
  });
}

function destinationTableMatchesContract(
  db: MomentumDb,
  contract: (typeof DESTINATION_TABLES)[number],
): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(contract.name) as { sql: string | null } | undefined;
  return (
    row?.sql !== null &&
    row?.sql !== undefined &&
    normalizeSchemaSql(row.sql) === normalizeSchemaSql(contract.definition)
  );
}

function destinationColumnMatchesContract(
  db: MomentumDb,
  contract: (typeof DESTINATION_COLUMNS)[number],
): boolean {
  if (!tableExists(db, contract.table)) return false;
  const row = (
    db
      .prepare(`PRAGMA table_info(${quoteIdentifier(contract.table)})`)
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>
  ).find((candidate) => candidate.name === contract.column);
  return (
    row !== undefined &&
    row.type.toUpperCase() === "TEXT" &&
    row.notnull === contract.notNull &&
    row.dflt_value === contract.defaultValue &&
    row.pk === contract.primaryKey
  );
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/g, "")
    .replace(/^(\s*CREATE TABLE) IF NOT EXISTS/i, "$1")
    .replaceAll(/\s+/g, " ")
    .trim();
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

function firstNonEmptyBaseRoute(
  db: MomentumDb,
): { id: string; route_json: string | null } | undefined {
  if (!columnExists(db, "workflow_runs", "route_json")) return undefined;
  if (columnExists(db, "workflow_runs", "id")) return firstNonEmptyRoute(db);
  const route = db
    .prepare(
      `SELECT route_json
         FROM workflow_runs
        WHERE route_json IS NOT NULL AND route_json <> '{}'
        LIMIT 1`,
    )
    .get() as { route_json: string | null } | undefined;
  return route === undefined ? undefined : { id: "<schema>", ...route };
}

function databaseDataVersion(db: MomentumDb): number {
  return (db.prepare("PRAGMA data_version").get() as { data_version: number })
    .data_version;
}

function hasRouteStateBaseTables(db: MomentumDb): boolean {
  const state = routeStateBaseSchemaState(db);
  return state.present === state.total;
}

function routeStateBaseSchemaState(db: MomentumDb): {
  present: number;
  total: number;
  existing: string[];
  missing: string[];
  malformed: string[];
} {
  const contracts = [
    {
      name: "workflow_runs",
      columns: ["id", "source", "route_json", "created_at", "updated_at"],
    },
    {
      name: "workflow_steps",
      columns: ["run_id", "step_id", "kind", "step_order"],
    },
    {
      name: "step_definitions",
      columns: ["definition_key", "definition_version", "step_key", "executor"],
    },
  ] as const;
  const existing = contracts
    .filter((contract) => tableExists(db, contract.name))
    .map((contract) => contract.name);
  const malformed = contracts.flatMap((contract) =>
    existing.includes(contract.name)
      ? contract.columns
          .filter((column) => !columnExists(db, contract.name, column))
          .map((column) => `${contract.name}.${column}`)
      : [],
  );
  return {
    present: existing.length,
    total: contracts.length,
    existing,
    missing: contracts
      .map((contract) => contract.name)
      .filter((name) => !existing.includes(name)),
    malformed,
  };
}

function routeBaseSchemaError(
  state: ReturnType<typeof routeStateBaseSchemaState>,
  runId = "<schema>",
): RouteStateMigrationError {
  const details = [
    `existing: ${state.existing.join(", ") || "none"}`,
    `missing: ${state.missing.join(", ") || "none"}`,
    `malformed: ${state.malformed.join(", ") || "none"}`,
  ];
  return new RouteStateMigrationError({
    runId,
    jsonPath: "$schema.routeState",
    code: "route_state_schema_partial",
    detail: `route migration base schema is partial or malformed; ${details.join("; ")}`,
  });
}

function hasBlockingBaseSchemaMalformation(
  state: ReturnType<typeof routeStateBaseSchemaState>,
): boolean {
  return state.malformed.some(
    (column) =>
      state.present === state.total || column !== "workflow_runs.route_json",
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

function normalizeRouteStateMigrationError(
  error: unknown,
): RouteStateMigrationError | unknown {
  if (!(error instanceof RouteStateProjectionError)) return error;
  return new RouteStateMigrationError({
    runId: error.runId,
    jsonPath: error.jsonPath,
    code: "route_state_projection_mismatch",
    detail: error.message,
  });
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No active transaction.
  }
}
