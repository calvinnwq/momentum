import type { MomentumDb } from "../../src/adapters/db.js";
import { projectLegacyWorkflowRunRoute } from "../../src/adapters/db/route-projection.js";
import {
  readWorkflowRunCodingCompatibility,
  readWorkflowRunImportMetadata,
} from "../../src/adapters/db/route-state.js";

export function seedCanonicalCodingCompatibilityMarker(
  db: MomentumDb,
  runId: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO workflow_run_coding_compatibility
       (run_id, implementation_engine, selected_profile, created_at, updated_at)
     SELECT id, NULL, NULL, ?, ?
       FROM workflow_runs
      WHERE id = ? AND source = 'momentum-native-coding'
     ON CONFLICT(run_id) DO NOTHING`,
  ).run(now, now, runId);
}

/**
 * Reconstruct the run's canonical route facts for test assertions: the
 * compatibility projection now carries only the `steps` namespace, so the
 * historical engine / profile and imported metadata values are read back
 * through the direct typed canonical readers instead.
 */
export function loadCanonicalWorkflowRunRoute(
  db: MomentumDb,
  runId: string,
): Record<string, unknown> | undefined {
  const run = db
    .prepare(
      `SELECT source, workflow_definition_key, workflow_definition_version,
              route_json
         FROM workflow_runs
        WHERE id = ?`,
    )
    .get(runId) as
    | {
        source: string;
        workflow_definition_key: string | null;
        workflow_definition_version: number | null;
        route_json: string | null;
      }
    | undefined;
  if (run === undefined) return undefined;
  if (run.route_json !== "{}") {
    throw new Error(
      `Expected canonical-only route persistence for run '${runId}', got ${String(run.route_json)}`,
    );
  }
  const route = projectLegacyWorkflowRunRoute(db, runId, {
    source: run.source,
    definitionKey: run.workflow_definition_key,
    definitionVersion: run.workflow_definition_version,
  });
  if (run.source === "agent-workflow") {
    const importMetadata = readWorkflowRunImportMetadata(db, runId);
    if (importMetadata !== undefined) {
      if (importMetadata.mode !== null) route["mode"] = importMetadata.mode;
      if (importMetadata.profile !== null) {
        route["profile"] = importMetadata.profile;
      }
      if (importMetadata.risk !== null) route["risk"] = importMetadata.risk;
      if (importMetadata.quotaPolicy !== null) {
        route["quotaPolicy"] = importMetadata.quotaPolicy;
      }
    }
    return route;
  }
  const compatibility = readWorkflowRunCodingCompatibility(db, runId);
  if (compatibility !== undefined) {
    if (compatibility.implementationEngine !== null) {
      route["implementationEngine"] = compatibility.implementationEngine;
    }
    if (compatibility.selectedProfile !== null) {
      route["profile"] = compatibility.selectedProfile;
    }
  }
  return route;
}
