import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openDb,
  openExistingDbMigratedReadOnly,
  openExistingDbReadOnly,
} from "../src/adapters/db.js";
import {
  LEGACY_ROUTE_TOP_LEVEL_KEYS,
  LEGACY_WORKFLOW_STEP_KIND_ALIASES,
  projectLegacyWorkflowRunRoute,
} from "../src/adapters/db/route-projection.js";
import {
  createRouteStateDestinations,
  RouteStateMigrationError,
} from "../src/adapters/db/route-state.js";
import { canonicalWorkflowStepKind } from "../src/core/workflow/definition/legacy.js";
import {
  CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY,
  CODING_ROUTE_STEPS_KEY,
} from "../src/core/workflow/route/coding.js";
import { SUBWORKFLOW_ROUTE_KEY } from "../src/core/workflow/route/subworkflow.js";
import { resolveWorkflowStepDispatchRouteSelection } from "../src/core/workflow/dispatch/execute.js";
import {
  listWorkflowRunSummaries,
  loadWorkflowRunDetail,
} from "../src/core/workflow/run/status.js";

const tempRoots: string[] = [];
const fixturePath = path.join(__dirname, "fixtures", "v0220-route-state.sql");

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedReleasedFixture(): string {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-v0220-route-migration-"),
  );
  tempRoots.push(dataDir);
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    db.exec(fs.readFileSync(fixturePath, "utf8"));
  } finally {
    db.close();
  }
  return dataDir;
}

function withRawDb(dataDir: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    mutate(db);
  } finally {
    db.close();
  }
}

function databaseHash(dataDir: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(dataDir, "momentum.db")))
    .digest("hex");
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function captureLegacyRoutes(dataDir: string): Map<
  string,
  {
    source: string;
    definitionKey: string | null;
    definitionVersion: number | null;
    route: Record<string, unknown>;
  }
> {
  const db = openExistingDbReadOnly(dataDir);
  if (db === undefined) throw new Error("fixture database missing");
  try {
    const rows = db
      .prepare(
        `SELECT id, source, workflow_definition_key,
                workflow_definition_version, route_json
           FROM workflow_runs
          ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      source: string;
      workflow_definition_key: string | null;
      workflow_definition_version: number | null;
      route_json: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.id,
        {
          source: row.source,
          definitionKey: row.workflow_definition_key,
          definitionVersion: row.workflow_definition_version,
          route: JSON.parse(row.route_json) as Record<string, unknown>,
        },
      ]),
    );
  } finally {
    db.close();
  }
}

function expectRouteRefusal(
  dataDir: string,
  expected: {
    runId: string;
    jsonPath: string;
    code: RouteStateMigrationError["code"];
  },
): RouteStateMigrationError {
  const before = databaseHash(dataDir);
  let refusal: RouteStateMigrationError | undefined;
  try {
    openDb(dataDir);
  } catch (error) {
    expect(error).toBeInstanceOf(RouteStateMigrationError);
    refusal = error as RouteStateMigrationError;
  }
  expect(refusal).toMatchObject(expected);
  expect(refusal?.repair).toContain("manually repair");
  expect(refusal?.message).toContain(expected.runId);
  expect(refusal?.message).toContain(expected.jsonPath);
  expect(databaseHash(dataDir)).toBe(before);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    expect(fs.existsSync(path.join(dataDir, `momentum.db${suffix}`))).toBe(
      false,
    );
  }
  return refusal!;
}

describe("workflow route-state migration", () => {
  it("pins released fixture provenance and excludes destination schema", () => {
    const fixture = fs.readFileSync(fixturePath, "utf8");
    expect(fixture).toContain(
      "commit: ebde7a3fe14ab135375b7cf724f383a838949b1c",
    );
    for (const token of [
      "agent_config_json",
      "executor_config_json",
      "workflow_run_lineage",
      "workflow_run_coding_compatibility",
      "workflow_run_import_metadata",
    ]) {
      expect(fixture).not.toContain(token);
    }
    for (const runId of [
      "native-simple",
      "native-full",
      "native-current-cwfp",
      "generic-profile",
      "v1-aliases",
      "subworkflow-parent",
      "subworkflow-child",
      "subworkflow-grandchild",
      "cwfp-imported",
      "empty-route",
    ]) {
      expect(fixture).toContain(`'${runId}'`);
    }
  });

  it("keeps adapter route vocabulary aligned with production readers", () => {
    expect(LEGACY_ROUTE_TOP_LEVEL_KEYS).toEqual([
      CODING_ROUTE_IMPLEMENTATION_ENGINE_KEY,
      "profile",
      CODING_ROUTE_STEPS_KEY,
      SUBWORKFLOW_ROUTE_KEY,
      "mode",
      "risk",
      "quotaPolicy",
    ]);
    for (const [legacy, canonical] of Object.entries(
      LEGACY_WORKFLOW_STEP_KIND_ALIASES,
    )) {
      expect(canonicalWorkflowStepKind(legacy)).toBe(canonical);
    }
  });

  it("migrates the simplest native implementation label", () => {
    const db = openDb(seedReleasedFixture());
    try {
      const row = db
        .prepare(
          `SELECT implementation_engine
             FROM workflow_run_coding_compatibility
            WHERE run_id = 'native-simple'`,
        )
        .get() as { implementation_engine: string } | undefined;
      expect(row?.implementation_engine).toBe("gnhf");
    } finally {
      db.close();
    }
  });

  it("creates identical destination schema on fresh and released databases", () => {
    const freshDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "momentum-route-fresh-"),
    );
    tempRoots.push(freshDir);
    const upgradedDir = seedReleasedFixture();
    const fresh = openDb(freshDir);
    const upgraded = openDb(upgradedDir);
    try {
      for (const table of ["workflow_steps", "step_definitions"]) {
        expect(fresh.prepare(`PRAGMA table_info("${table}")`).all()).toEqual(
          upgraded.prepare(`PRAGMA table_info("${table}")`).all(),
        );
      }
      for (const table of [
        "workflow_run_lineage",
        "workflow_run_coding_compatibility",
        "workflow_run_import_metadata",
      ]) {
        const sql = (db: DatabaseSync) =>
          (
            db
              .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
              )
              .get(table) as { sql: string }
          ).sql;
        expect(sql(fresh)).toBe(sql(upgraded));
      }
      expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      fresh.close();
      upgraded.close();
    }
  });

  it("migrates the complete released inventory to exact destinations", () => {
    const dataDir = seedReleasedFixture();
    const db = openDb(dataDir);
    try {
      expect(
        db
          .prepare(
            `SELECT run_id, implementation_engine, selected_profile
               FROM workflow_run_coding_compatibility
              ORDER BY run_id`,
          )
          .all(),
      ).toEqual([
        {
          run_id: "generic-profile",
          implementation_engine: null,
          selected_profile: "fixture-generic",
        },
        {
          run_id: "native-current-cwfp",
          implementation_engine: "current-gnhf-cwfp",
          selected_profile: null,
        },
        {
          run_id: "native-full",
          implementation_engine: "native-goal-loop",
          selected_profile: "fixture-native",
        },
        {
          run_id: "native-simple",
          implementation_engine: "gnhf",
          selected_profile: null,
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT mode, profile, risk, quota_policy_json
               FROM workflow_run_import_metadata
              WHERE run_id = 'cwfp-imported'`,
          )
          .get(),
      ).toEqual({
        mode: "implementation",
        profile: "fixture-import",
        risk: "medium",
        quota_policy_json: '{"maxTurns":12,"overflow":"refuse"}',
      });
      expect(
        db
          .prepare(
            `SELECT run_id, parent_run_id, parent_step_id, depth,
                    ancestor_definition_keys_json
               FROM workflow_run_lineage
              ORDER BY depth`,
          )
          .all(),
      ).toEqual([
        {
          run_id: "subworkflow-child",
          parent_run_id: "subworkflow-parent",
          parent_step_id: "child-one",
          depth: 1,
          ancestor_definition_keys_json: '["fixture-parent"]',
        },
        {
          run_id: "subworkflow-grandchild",
          parent_run_id: "subworkflow-child",
          parent_step_id: "nested-child",
          depth: 2,
          ancestor_definition_keys_json: '["fixture-parent","fixture-nested"]',
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT step_id, agent_config_json
               FROM workflow_steps
              WHERE run_id = 'v1-aliases'
                AND agent_config_json <> '{}'
              ORDER BY step_id`,
          )
          .all(),
      ).toEqual([
        {
          step_id: "linear-refresh",
          agent_config_json: '{"effort":"medium"}',
        },
        {
          step_id: "no-mistakes",
          agent_config_json: '{"harness":"codex","model":"gpt-5.6"}',
        },
      ]);
      const childConfigs = db
        .prepare(
          `SELECT step_id, executor_config_json
             FROM workflow_steps
            WHERE run_id = 'subworkflow-parent'
            ORDER BY step_id`,
        )
        .all() as Array<{
        step_id: string;
        executor_config_json: string;
      }>;
      expect(childConfigs.map((row) => row.step_id)).toEqual([
        "child-one",
        "child-two",
      ]);
      expect(
        childConfigs.map((row) => JSON.parse(row.executor_config_json)),
      ).toEqual([
        {
          child: {
            childDefinitionKey: "fixture-nested",
            childDefinitionVersion: 1,
            maxDepth: 3,
          },
        },
        {
          child: {
            childDefinitionKey: "fixture-nested",
            childDefinitionVersion: 1,
            maxDepth: 3,
          },
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT DISTINCT route_json FROM workflow_runs ORDER BY route_json",
          )
          .all(),
      ).toEqual([{ route_json: "{}" }]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("projects every migrated route structurally equal to its released value", () => {
    const dataDir = seedReleasedFixture();
    const legacy = captureLegacyRoutes(dataDir);
    const db = openDb(dataDir);
    try {
      for (const [runId, expected] of legacy) {
        expect(
          projectLegacyWorkflowRunRoute(db, runId, expected),
          runId,
        ).toEqual(expected.route);
      }
      const nativeFull = projectLegacyWorkflowRunRoute(
        db,
        "native-full",
        legacy.get("native-full")!,
      );
      expect(Object.keys(nativeFull)).toEqual([
        "implementationEngine",
        "profile",
        "steps",
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves status, list, and dispatch behavior through the projector seam", () => {
    const dataDir = seedReleasedFixture();
    const legacy = captureLegacyRoutes(dataDir);
    const db = openDb(dataDir);
    try {
      expect(loadWorkflowRunDetail(db, "native-full")?.run.route).toEqual(
        legacy.get("native-full")?.route,
      );
      expect(
        listWorkflowRunSummaries(db).find(
          (summary) => summary.run.runId === "cwfp-imported",
        )?.run.route,
      ).toEqual(legacy.get("cwfp-imported")?.route);
      expect(
        resolveWorkflowStepDispatchRouteSelection(db, {
          runId: "native-full",
          stepId: "implementation",
        }),
      ).toEqual({
        ok: true,
        selection: {
          agentProvider: "codex",
          model: "gpt-5.6",
          effort: "medium",
        },
      });
      const current = resolveWorkflowStepDispatchRouteSelection(db, {
        runId: "native-current-cwfp",
        stepId: "implementation",
      });
      expect(current.ok).toBe(false);
      if (!current.ok) {
        expect(current.reason).toContain("current-gnhf-cwfp");
      }
    } finally {
      db.close();
    }
  });

  it("migrates released route state for read-only callers", () => {
    const dataDir = seedReleasedFixture();
    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      expect(loadWorkflowRunDetail(db!, "native-simple")?.run.route).toEqual({
        implementationEngine: "gnhf",
      });
    } finally {
      db?.close();
    }
    const persisted = openExistingDbReadOnly(dataDir)!;
    try {
      expect(tableNames(persisted)).toContain(
        "workflow_run_coding_compatibility",
      );
    } finally {
      persisted.close();
    }
  });

  it("serves a migrated read-only snapshot while the source is write-locked", () => {
    const dataDir = seedReleasedFixture();
    const writer = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      writer.exec("BEGIN IMMEDIATE");
      const snapshot = openExistingDbMigratedReadOnly(dataDir);
      expect(snapshot).toBeDefined();
      try {
        expect(
          loadWorkflowRunDetail(snapshot!, "native-simple")?.run.route,
        ).toEqual({ implementationEngine: "gnhf" });
      } finally {
        snapshot?.close();
      }
      expect(tableNames(writer)).not.toContain(
        "workflow_run_coding_compatibility",
      );
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
    }
  });

  it("is byte-stable and leaves canonical rows unchanged on second open", () => {
    const dataDir = seedReleasedFixture();
    const first = openDb(dataDir);
    const canonicalBefore = {
      compatibility: first
        .prepare(
          "SELECT * FROM workflow_run_coding_compatibility ORDER BY run_id",
        )
        .all(),
      importMetadata: first
        .prepare("SELECT * FROM workflow_run_import_metadata ORDER BY run_id")
        .all(),
      lineage: first
        .prepare("SELECT * FROM workflow_run_lineage ORDER BY run_id")
        .all(),
      steps: first
        .prepare(
          `SELECT run_id, step_id, agent_config_json, executor_config_json
             FROM workflow_steps
            ORDER BY run_id, step_id`,
        )
        .all(),
    };
    first.close();
    const firstHash = databaseHash(dataDir);
    const second = openDb(dataDir);
    second.close();
    expect(databaseHash(dataDir)).toBe(firstHash);
    const readOnly = openExistingDbReadOnly(dataDir)!;
    try {
      expect(
        readOnly
          .prepare(
            "SELECT * FROM workflow_run_coding_compatibility ORDER BY run_id",
          )
          .all(),
      ).toEqual(canonicalBefore.compatibility);
      expect(
        readOnly
          .prepare("SELECT * FROM workflow_run_import_metadata ORDER BY run_id")
          .all(),
      ).toEqual(canonicalBefore.importMetadata);
      expect(
        readOnly
          .prepare("SELECT * FROM workflow_run_lineage ORDER BY run_id")
          .all(),
      ).toEqual(canonicalBefore.lineage);
      expect(
        readOnly
          .prepare(
            `SELECT run_id, step_id, agent_config_json, executor_config_json
               FROM workflow_steps
              ORDER BY run_id, step_id`,
          )
          .all(),
      ).toEqual(canonicalBefore.steps);
    } finally {
      readOnly.close();
    }
  });

  const refusalCases: Array<{
    name: string;
    runId: string;
    jsonPath: string;
    code: RouteStateMigrationError["code"];
    mutate: (db: DatabaseSync) => void;
  }> = [
    {
      name: "unknown top-level key",
      runId: "native-simple",
      jsonPath: "$.unknown",
      code: "route_state_unknown_key",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run('{"unknown":true}', "native-simple"),
    },
    {
      name: "unknown nested key",
      runId: "native-simple",
      jsonPath: "$.steps.implementation.unknown",
      code: "route_state_unknown_key",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"steps":{"implementation":{"unknown":"value"}}}',
            "native-simple",
          ),
    },
    {
      name: "unknown nested key under a legacy step alias",
      runId: "native-simple",
      jsonPath: "$.steps.no-mistakes.unknown",
      code: "route_state_unknown_key",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"steps":{"no-mistakes":{"harness":"codex","unknown":"value"}}}',
            "native-simple",
          ),
    },
    {
      name: "conflicting legacy and canonical step aliases",
      runId: "native-simple",
      jsonPath: "$.steps.validate",
      code: "route_state_step_target_ambiguous",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"steps":{"no-mistakes":{"harness":"claude"},"validate":{"harness":"codex"}}}',
            "native-simple",
          ),
    },
    {
      name: "malformed JSON",
      runId: "native-simple",
      jsonPath: "$",
      code: "route_state_json_malformed",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run("{", "native-simple"),
    },
    {
      name: "non-object route",
      runId: "native-simple",
      jsonPath: "$",
      code: "route_state_not_object",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run("[]", "native-simple"),
    },
    {
      name: "invalid agent value",
      runId: "native-simple",
      jsonPath: "$.steps.implementation.model",
      code: "route_state_value_invalid",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run('{"steps":{"implementation":{"model":" "}}}', "native-simple"),
    },
    {
      name: "native and import marker conflict",
      runId: "native-simple",
      jsonPath: "$",
      code: "route_state_source_conflict",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"implementationEngine":"gnhf","mode":"implementation"}',
            "native-simple",
          ),
    },
    {
      name: "ambiguous profile",
      runId: "generic-profile",
      jsonPath: "$.profile",
      code: "route_state_profile_ambiguous",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET source = ? WHERE id = ?")
          .run("unknown-source", "generic-profile"),
    },
    {
      name: "duplicate canonical step target",
      runId: "native-full",
      jsonPath: "$.steps.implementation",
      code: "route_state_step_target_ambiguous",
      mutate: (db) =>
        db
          .prepare(
            "UPDATE workflow_steps SET kind = 'implementation' WHERE run_id = ? AND step_id = ?",
          )
          .run("native-full", "postflight"),
    },
    {
      name: "unmatched step target",
      runId: "native-simple",
      jsonPath: "$.steps.validate",
      code: "route_state_step_target_missing",
      mutate: (db) => {
        db.prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?").run(
          '{"steps":{"validate":{"harness":"codex"}}}',
          "native-simple",
        );
        db.prepare(
          "DELETE FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        ).run("native-simple", "validate");
      },
    },
    {
      name: "zero subworkflow targets",
      runId: "subworkflow-parent",
      jsonPath: "$.subworkflow.child",
      code: "route_state_subworkflow_target_missing",
      mutate: (db) =>
        db
          .prepare(
            `UPDATE step_definitions
                SET executor = 'script'
              WHERE definition_key = 'fixture-parent'`,
          )
          .run(),
    },
    {
      name: "lineage depth mismatch",
      runId: "subworkflow-child",
      jsonPath: "$.subworkflow.lineage.depth",
      code: "route_state_lineage_invalid",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"subworkflow":{"lineage":{"parentRunId":"subworkflow-parent","parentStepId":"child-one","depth":2,"ancestorDefinitionKeys":["fixture-parent"]}}}',
            "subworkflow-child",
          ),
    },
    {
      name: "orphan lineage parent step",
      runId: "subworkflow-child",
      jsonPath: "$.subworkflow.lineage.parentStepId",
      code: "route_state_lineage_parent_missing",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"subworkflow":{"lineage":{"parentRunId":"subworkflow-parent","parentStepId":"missing","depth":1,"ancestorDefinitionKeys":["fixture-parent"]}}}',
            "subworkflow-child",
          ),
    },
    {
      name: "self-parented lineage",
      runId: "subworkflow-child",
      jsonPath: "$.subworkflow.lineage.parentRunId",
      code: "route_state_lineage_invalid",
      mutate: (db) =>
        db
          .prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?")
          .run(
            '{"subworkflow":{"lineage":{"parentRunId":"subworkflow-child","parentStepId":"nested-child","depth":1,"ancestorDefinitionKeys":["fixture-nested"]}}}',
            "subworkflow-child",
          ),
    },
  ];

  for (const testCase of refusalCases) {
    it(`rolls back byte-equivalently for ${testCase.name}`, () => {
      const dataDir = seedReleasedFixture();
      withRawDb(dataDir, testCase.mutate);
      const readOnly = openExistingDbReadOnly(dataDir)!;
      try {
        expect(
          (
            readOnly.prepare("PRAGMA journal_mode").get() as {
              journal_mode: string;
            }
          ).journal_mode,
        ).toBe("delete");
      } finally {
        readOnly.close();
      }
      expectRouteRefusal(dataDir, {
        runId: testCase.runId,
        jsonPath: testCase.jsonPath,
        code: testCase.code,
      });
      const after = openExistingDbReadOnly(dataDir)!;
      try {
        expect(tableNames(after)).not.toContain("workflow_run_lineage");
        expect(columnNames(after, "workflow_steps")).not.toContain(
          "agent_config_json",
        );
        expect(columnNames(after, "workflow_steps")).not.toContain(
          "executor_config_json",
        );
        expect(columnNames(after, "step_definitions")).not.toContain(
          "agent_config_json",
        );
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        after.close();
      }
    });
  }

  it("refuses partial destination schema before writes even with empty routes", () => {
    const dataDir = seedReleasedFixture();
    withRawDb(dataDir, (db) => {
      db.prepare("UPDATE workflow_runs SET route_json = '{}'").run();
      db.exec(
        "ALTER TABLE workflow_steps ADD COLUMN agent_config_json TEXT NOT NULL DEFAULT '{}'",
      );
    });
    expectRouteRefusal(dataDir, {
      runId: "<schema>",
      jsonPath: "$schema.routeState",
      code: "route_state_schema_partial",
    });
  });

  it("refuses canonical schema coexisting with legacy route state", () => {
    const dataDir = seedReleasedFixture();
    withRawDb(dataDir, (db) => {
      db.exec("BEGIN IMMEDIATE");
      createRouteStateDestinations(db);
      db.prepare(
        `INSERT INTO workflow_run_coding_compatibility
           (run_id, implementation_engine, selected_profile, created_at, updated_at)
         VALUES ('native-simple', 'gnhf', NULL, 1, 1)`,
      ).run();
      db.exec("COMMIT");
    });
    expectRouteRefusal(dataDir, {
      runId: "cwfp-imported",
      jsonPath: "$",
      code: "route_state_canonical_conflict",
    });
  });
});
