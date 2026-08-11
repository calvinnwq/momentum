import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { projectLegacyWorkflowRunRoute } from "../src/adapters/db/legacy-route-migration.js";
import {
  readWorkflowRunCodingCompatibilities,
  readWorkflowRunCodingCompatibility,
  readWorkflowRunImportMetadata,
  readWorkflowRunImportMetadataForRuns,
  writeCanonicalWorkflowRunRouteState,
} from "../src/adapters/db/route-state.js";
import { RouteStateMigrationError } from "../src/adapters/db/route-state-errors.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { resolveWorkflowStepDispatchRouteSelection } from "../src/core/workflow/dispatch/execute.js";
import { loadWorkflowRunDetail } from "../src/core/workflow/run/status.js";
import { workflowRunToJsonShape } from "../src/renderers/workflow.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";

/**
 * NGX-667 (NAM-03D) — canonical import-metadata and implementation authority.
 *
 * `workflow_run_import_metadata` owns imported `mode` / legacy `profile` /
 * `risk` / `quotaPolicy` and their timestamps, and
 * `workflow_run_coding_compatibility` owns historical engine / selected-profile
 * read-back only. Active readers use the direct typed readers below, and the
 * compatibility route projector no longer emits import, implementation, or
 * profile keys — only the `route.steps` namespace owned by later issues.
 */

const NOW = 1_700_000_000_000;
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openTempDb(): MomentumDb {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-canonical-import-metadata-"),
  );
  tempRoots.push(dir);
  return openDb(dir);
}

function seedNativeCodingRun(db: MomentumDb, runId: string): void {
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Prove canonical import/implementation authority",
    now: NOW,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    route: {
      implementationEngine: "gnhf",
      profile: "operator-profile",
      steps: {
        implementation: {
          harness: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
      },
    },
  });
}

function seedImportedRun(
  db: MomentumDb,
  runId: string,
  route: Record<string, unknown>,
  importSourceFormat: string | null = null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, state, source, plan_json, issue_scope_json,
       created_at, updated_at
     ) VALUES (?, 'succeeded', 'agent-workflow', '{}', '{}', ?, ?)`,
  ).run(runId, NOW, NOW);
  writeCanonicalWorkflowRunRouteState(db, {
    runId,
    source: "agent-workflow",
    route,
    definitionKey: null,
    definitionVersion: null,
    createdAt: NOW,
    updatedAt: NOW,
    importSourceFormat,
  });
}

describe("compatibility projector retires import / implementation / profile keys", () => {
  it("projects only route.steps for a native coding run", () => {
    const db = openTempDb();
    try {
      seedNativeCodingRun(db, "native-projector-trim");
      expect(
        projectLegacyWorkflowRunRoute(db, "native-projector-trim", {
          source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
          definitionKey: CODING_WORKFLOW_DEFINITION.key,
          definitionVersion: CODING_WORKFLOW_DEFINITION.version,
        }),
      ).toEqual({
        steps: {
          implementation: {
            harness: "codex",
            model: "gpt-5.6-codex",
            effort: "high",
          },
        },
      });
      // The historical values stay canonical, not projected.
      expect(
        readWorkflowRunCodingCompatibility(db, "native-projector-trim"),
      ).toEqual({
        implementationEngine: "gnhf",
        selectedProfile: "operator-profile",
      });
    } finally {
      db.close();
    }
  });

  it("projects an empty route for an imported run with full import metadata", () => {
    const db = openTempDb();
    try {
      seedImportedRun(db, "cwfp-projector-trim", {
        mode: "execute-ready",
        profile: "imported-profile",
        risk: "medium",
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
      });
      expect(
        projectLegacyWorkflowRunRoute(db, "cwfp-projector-trim", {
          source: "agent-workflow",
          definitionKey: null,
          definitionVersion: null,
        }),
      ).toEqual({});
    } finally {
      db.close();
    }
  });
});

describe("readWorkflowRunImportMetadata — direct typed import read-back", () => {
  const fieldCases: Array<{
    name: string;
    route: Record<string, unknown>;
    expected: {
      mode: string | null;
      profile: string | null;
      risk: string | null;
      quotaPolicy: Record<string, unknown> | null;
    };
  }> = [
    {
      name: "imported mode only",
      route: { mode: "execute-ready" },
      expected: {
        mode: "execute-ready",
        profile: null,
        risk: null,
        quotaPolicy: null,
      },
    },
    {
      name: "imported profile only",
      route: { profile: "imported-profile" },
      expected: {
        mode: null,
        profile: "imported-profile",
        risk: null,
        quotaPolicy: null,
      },
    },
    {
      name: "imported risk only",
      route: { risk: "medium" },
      expected: {
        mode: null,
        profile: null,
        risk: "medium",
        quotaPolicy: null,
      },
    },
    {
      name: "imported quotaPolicy only",
      route: { quotaPolicy: { maxTurns: 12, overflow: "refuse" } },
      expected: {
        mode: null,
        profile: null,
        risk: null,
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
      },
    },
    {
      name: "all imported fields together",
      route: {
        mode: "execute-ready",
        profile: "imported-profile",
        risk: "medium",
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
      },
      expected: {
        mode: "execute-ready",
        profile: "imported-profile",
        risk: "medium",
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
      },
    },
  ];

  for (const testCase of fieldCases) {
    it(`round-trips ${testCase.name}`, () => {
      const db = openTempDb();
      try {
        seedImportedRun(db, "cwfp-roundtrip", testCase.route);
        expect(readWorkflowRunImportMetadata(db, "cwfp-roundtrip")).toEqual({
          ...testCase.expected,
          sourceFormat: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
      } finally {
        db.close();
      }
    });
  }

  it("distinguishes an absent row from an empty metadata marker", () => {
    const db = openTempDb();
    try {
      expect(readWorkflowRunImportMetadata(db, "missing-run")).toBeUndefined();
      seedImportedRun(db, "cwfp-empty-marker", {});
      expect(readWorkflowRunImportMetadata(db, "cwfp-empty-marker")).toEqual({
        mode: null,
        profile: null,
        risk: null,
        quotaPolicy: null,
        sourceFormat: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    } finally {
      db.close();
    }
  });

  it("round-trips the imported source format alongside route-carried metadata", () => {
    const db = openTempDb();
    try {
      seedImportedRun(
        db,
        "cwfp-source-format",
        { mode: "execute-ready" },
        "agent-workflow-plan@v1",
      );
      expect(readWorkflowRunImportMetadata(db, "cwfp-source-format")).toEqual({
        mode: "execute-ready",
        profile: null,
        risk: null,
        quotaPolicy: null,
        sourceFormat: "agent-workflow-plan@v1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(
        readWorkflowRunImportMetadataForRuns(db, ["cwfp-source-format"]).get(
          "cwfp-source-format",
        ),
      ).toMatchObject({ sourceFormat: "agent-workflow-plan@v1" });
    } finally {
      db.close();
    }
  });

  it("fails closed on malformed persisted quota policy JSON", () => {
    const db = openTempDb();
    try {
      seedImportedRun(db, "cwfp-malformed-quota", {
        quotaPolicy: { maxTurns: 12 },
      });
      db.prepare(
        "UPDATE workflow_run_import_metadata SET quota_policy_json = '{' WHERE run_id = ?",
      ).run("cwfp-malformed-quota");
      expect(() =>
        readWorkflowRunImportMetadata(db, "cwfp-malformed-quota"),
      ).toThrow(RouteStateMigrationError);
    } finally {
      db.close();
    }
  });
});

describe("readWorkflowRunCodingCompatibility — historical read-back only", () => {
  it("distinguishes an absent marker from a marker with null values", () => {
    const db = openTempDb();
    try {
      expect(
        readWorkflowRunCodingCompatibility(db, "missing-run"),
      ).toBeUndefined();
      seedNativeCodingRun(db, "native-null-compat");
      db.prepare(
        `UPDATE workflow_run_coding_compatibility
            SET implementation_engine = NULL, selected_profile = NULL
          WHERE run_id = ?`,
      ).run("native-null-compat");
      expect(
        readWorkflowRunCodingCompatibility(db, "native-null-compat"),
      ).toEqual({ implementationEngine: null, selectedProfile: null });
    } finally {
      db.close();
    }
  });
});

describe("operator read-back reads canonical state through direct typed readers", () => {
  it("exposes the historical implementation engine on run detail without route keys", () => {
    const db = openTempDb();
    try {
      seedNativeCodingRun(db, "native-detail-readback");
      const detail = loadWorkflowRunDetail(db, "native-detail-readback");
      expect(detail?.run.compatibility).toEqual({
        coding: {
          implementationEngine: "gnhf",
          selectedProfile: "operator-profile",
        },
      });
      expect(detail?.run).not.toHaveProperty("route");
    } finally {
      db.close();
    }
  });

  it("keeps imported run detail readable without any route projection", () => {
    const db = openTempDb();
    try {
      seedImportedRun(db, "cwfp-detail-readback", {
        mode: "execute-ready",
        profile: "imported-profile",
      });
      const detail = loadWorkflowRunDetail(db, "cwfp-detail-readback");
      expect(detail?.run).not.toHaveProperty("route");
      expect(detail?.run.compatibility).toBeNull();
      expect(
        readWorkflowRunImportMetadata(db, "cwfp-detail-readback"),
      ).toMatchObject({
        mode: "execute-ready",
        profile: "imported-profile",
      });
    } finally {
      db.close();
    }
  });
});

describe("batched canonical readers match the single-run typed readers", () => {
  it("reads compatibility and import metadata for many runs in bulk", () => {
    const db = openTempDb();
    try {
      seedNativeCodingRun(db, "native-batch-a");
      seedImportedRun(db, "cwfp-batch-b", {
        mode: "execute-ready",
        risk: "medium",
      });
      const runIds = ["native-batch-a", "cwfp-batch-b", "missing-run"];

      const compatibilities = readWorkflowRunCodingCompatibilities(db, runIds);
      expect(compatibilities.get("native-batch-a")).toEqual(
        readWorkflowRunCodingCompatibility(db, "native-batch-a"),
      );
      expect(compatibilities.has("cwfp-batch-b")).toBe(false);
      expect(compatibilities.has("missing-run")).toBe(false);

      const importMetadata = readWorkflowRunImportMetadataForRuns(db, runIds);
      expect(importMetadata.get("cwfp-batch-b")).toEqual(
        readWorkflowRunImportMetadata(db, "cwfp-batch-b"),
      );
      expect(importMetadata.has("native-batch-a")).toBe(false);
      expect(importMetadata.has("missing-run")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("fails closed on malformed persisted values in bulk reads", () => {
    const db = openTempDb();
    try {
      seedImportedRun(db, "cwfp-batch-malformed", {
        quotaPolicy: { maxTurns: 12 },
      });
      db.prepare(
        "UPDATE workflow_run_import_metadata SET quota_policy_json = '{' WHERE run_id = ?",
      ).run("cwfp-batch-malformed");
      expect(() =>
        readWorkflowRunImportMetadataForRuns(db, ["cwfp-batch-malformed"]),
      ).toThrow(RouteStateMigrationError);
    } finally {
      db.close();
    }
  });
});

describe("run JSON read-back exposes canonical metadata through typed fields", () => {
  it("carries the historical engine on the native run JSON shape", () => {
    const db = openTempDb();
    try {
      seedNativeCodingRun(db, "native-json-readback");
      const detail = loadWorkflowRunDetail(db, "native-json-readback");
      const shape = workflowRunToJsonShape(detail!.run);
      expect(shape["compatibility"]).toEqual({
        coding: {
          implementationEngine: "gnhf",
          selectedProfile: "operator-profile",
        },
      });
      expect(shape["importMetadata"]).toBeNull();
      expect(shape).not.toHaveProperty("route");
      expect(shape).not.toHaveProperty("implementationEngine");
      expect(shape).not.toHaveProperty("selectedProfile");
    } finally {
      db.close();
    }
  });

  it("carries imported metadata on the imported run JSON shape", () => {
    const db = openTempDb();
    try {
      seedImportedRun(
        db,
        "cwfp-json-readback",
        {
          mode: "execute-ready",
          profile: "imported-profile",
          risk: "medium",
          quotaPolicy: { maxTurns: 12, overflow: "refuse" },
        },
        "agent-workflow-plan@v1",
      );
      const detail = loadWorkflowRunDetail(db, "cwfp-json-readback");
      const shape = workflowRunToJsonShape(detail!.run);
      expect(shape).not.toHaveProperty("route");
      expect(shape["compatibility"]).toBeNull();
      expect(shape["importMetadata"]).toEqual({
        mode: "execute-ready",
        profile: "imported-profile",
        risk: "medium",
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
        sourceFormat: "agent-workflow-plan@v1",
        createdAt: NOW,
        updatedAt: NOW,
      });
    } finally {
      db.close();
    }
  });
});

describe("imported profile is historical metadata only", () => {
  it("never influences dispatch selection, even when it conflicts with local host configuration", () => {
    const db = openTempDb();
    try {
      // The imported profile deliberately disagrees with any plausible local
      // live-wrapper profile the host would resolve from its own environment.
      seedImportedRun(db, "cwfp-profile-conflict", {
        profile: "imported-live-wrapper-profile",
        mode: "execute-ready",
      });
      db.prepare(
        `INSERT INTO workflow_steps (
           run_id, step_id, kind, state, step_order, required,
           created_at, updated_at
         ) VALUES ('cwfp-profile-conflict', 'implementation',
                   'implementation', 'approved', 0, 1, ?, ?)`,
      ).run(NOW, NOW);

      expect(
        resolveWorkflowStepDispatchRouteSelection(db, {
          runId: "cwfp-profile-conflict",
          stepId: "implementation",
        }),
      ).toEqual({
        ok: true,
        selection: { agentProvider: null, model: null, effort: null },
      });
    } finally {
      db.close();
    }
  });
});

describe("active readers do not use route state for import / implementation authority", () => {
  const forbidden: Array<{ file: string; token: string }> = [
    {
      file: "src/core/daemon/workflow-dispatch.ts",
      token: "resolveLegacyWorkflowStepDispatchRouteSelection",
    },
    {
      file: "src/core/workflow/dispatch/execute.ts",
      token: "resolveLegacyWorkflowStepDispatchRouteSelection",
    },
    {
      file: "src/renderers/workflow.ts",
      token: 'route["implementationEngine"]',
    },
    // The runtime read surfaces must not import the migration-only legacy
    // route module or the retired projector wrapper at all.
    {
      file: "src/core/workflow/run/status.ts",
      token: "legacy-route-migration",
    },
    {
      file: "src/core/workflow/run/status.ts",
      token: "projectValidatedLegacyWorkflowRunRoute",
    },
    {
      file: "src/core/workflow/dispatch/execute.ts",
      token: "projectValidatedLegacyWorkflowRunRoute",
    },
    {
      file: "src/renderers/workflow.ts",
      token: "legacy-route-migration",
    },
    {
      file: "src/adapters/db/legacy-route-migration.ts",
      token: 'route["implementationEngine"]',
    },
    {
      file: "src/adapters/db/legacy-route-migration.ts",
      token: 'route["mode"]',
    },
    {
      file: "src/adapters/db/legacy-route-migration.ts",
      token: 'route["risk"]',
    },
    {
      file: "src/adapters/db/legacy-route-migration.ts",
      token: 'route["quotaPolicy"]',
    },
    {
      file: "src/adapters/db/legacy-route-migration.ts",
      token: 'route["profile"]',
    },
  ];

  for (const { file, token } of forbidden) {
    it(`${file} does not reference ${JSON.stringify(token)}`, () => {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source).not.toContain(token);
    });
  }
});
