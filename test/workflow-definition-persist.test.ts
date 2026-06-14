import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition
} from "../src/workflow-definition.js";
import {
  InvalidWorkflowDefinitionError,
  listWorkflowDefinitionKeys,
  loadWorkflowDefinition,
  persistWorkflowDefinition,
  seedBuiltInWorkflowDefinitions
} from "../src/workflow-definition-persist.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-def-persist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openTempDb(): MomentumDb {
  return openDb(makeTempDir());
}

function countDefinitionRows(db: MomentumDb, key: string): number {
  const row = db
    .prepare(
      "SELECT count(*) AS c FROM workflow_definitions WHERE key = ?"
    )
    .get(key) as { c: number };
  return row.c;
}

function countStepRows(db: MomentumDb, key: string, version: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c FROM step_definitions
         WHERE definition_key = ? AND definition_version = ?`
    )
    .get(key, version) as { c: number };
  return row.c;
}

describe("persistWorkflowDefinition", () => {
  it("round-trips the built-in coding workflow definition", () => {
    const db = openTempDb();
    try {
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 1000 });
      const loaded = loadWorkflowDefinition(
        db,
        CODING_WORKFLOW_DEFINITION.key
      );
      expect(loaded).toEqual(CODING_WORKFLOW_DEFINITION);
    } finally {
      db.close();
    }
  });

  it("reports inserted=true on first persist and inserted=false on re-persist", () => {
    const db = openTempDb();
    try {
      const first = persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, {
        now: 1000
      });
      expect(first.inserted).toBe(true);
      expect(first.key).toBe(CODING_WORKFLOW_DEFINITION.key);
      expect(first.version).toBe(CODING_WORKFLOW_DEFINITION.version);
      expect(first.stepCount).toBe(CODING_WORKFLOW_DEFINITION.steps.length);

      const second = persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, {
        now: 2000
      });
      expect(second.inserted).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is idempotent: re-persisting never duplicates definition or step rows", () => {
    const db = openTempDb();
    try {
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 1000 });
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 2000 });
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 3000 });

      expect(countDefinitionRows(db, CODING_WORKFLOW_DEFINITION.key)).toBe(1);
      expect(
        countStepRows(
          db,
          CODING_WORKFLOW_DEFINITION.key,
          CODING_WORKFLOW_DEFINITION.version
        )
      ).toBe(CODING_WORKFLOW_DEFINITION.steps.length);
      expect(loadWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION.key)).toEqual(
        CODING_WORKFLOW_DEFINITION
      );
    } finally {
      db.close();
    }
  });

  it("preserves created_at and bumps updated_at across re-persist", () => {
    const db = openTempDb();
    try {
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 1000 });
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: 2000 });

      const def = db
        .prepare(
          "SELECT created_at, updated_at FROM workflow_definitions WHERE key = ? AND version = ?"
        )
        .get(
          CODING_WORKFLOW_DEFINITION.key,
          CODING_WORKFLOW_DEFINITION.version
        ) as { created_at: number; updated_at: number };
      expect(def.created_at).toBe(1000);
      expect(def.updated_at).toBe(2000);

      const step = db
        .prepare(
          `SELECT created_at, updated_at FROM step_definitions
             WHERE definition_key = ? AND definition_version = ? AND step_key = 'preflight'`
        )
        .get(
          CODING_WORKFLOW_DEFINITION.key,
          CODING_WORKFLOW_DEFINITION.version
        ) as { created_at: number; updated_at: number };
      expect(step.created_at).toBe(1000);
      expect(step.updated_at).toBe(2000);
    } finally {
      db.close();
    }
  });

  it("throws InvalidWorkflowDefinitionError and writes nothing for an invalid definition", () => {
    const db = openTempDb();
    try {
      const invalid = {
        key: "broken-workflow",
        title: "Broken",
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: "bogus-family",
            order: 0,
            required: true
          }
        ]
      };

      let thrown: unknown;
      try {
        persistWorkflowDefinition(db, invalid, { now: 1000 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidWorkflowDefinitionError);
      expect(
        (thrown as InvalidWorkflowDefinitionError).errors.map((e) => e.code)
      ).toContain("step_executor_invalid");

      expect(countDefinitionRows(db, "broken-workflow")).toBe(0);
      expect(loadWorkflowDefinition(db, "broken-workflow")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("stores distinct versions of the same key and loads the latest by default", () => {
    const db = openTempDb();
    try {
      const v1: WorkflowDefinition = {
        key: "demo",
        title: "Demo v1",
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: "one-shot",
            order: 0,
            required: true
          }
        ]
      };
      const v2: WorkflowDefinition = {
        ...v1,
        title: "Demo v2",
        version: 2
      };
      persistWorkflowDefinition(db, v1, { now: 1000 });
      persistWorkflowDefinition(db, v2, { now: 2000 });

      expect(loadWorkflowDefinition(db, "demo")).toEqual(v2);
      expect(loadWorkflowDefinition(db, "demo", 1)).toEqual(v1);
    } finally {
      db.close();
    }
  });

  it("deletes orphaned steps when a step is removed from a re-persisted version", () => {
    const db = openTempDb();
    try {
      const twoStep: WorkflowDefinition = {
        key: "demo",
        title: "Demo",
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: "one-shot",
            order: 0,
            required: true
          },
          {
            key: "implementation",
            kind: "implementation",
            executor: "goal-loop",
            order: 1,
            required: true
          }
        ]
      };
      const oneStep: WorkflowDefinition = {
        ...twoStep,
        steps: [twoStep.steps[0]!]
      };
      persistWorkflowDefinition(db, twoStep, { now: 1000 });
      persistWorkflowDefinition(db, oneStep, { now: 2000 });

      expect(countStepRows(db, "demo", 1)).toBe(1);
      expect(loadWorkflowDefinition(db, "demo")).toEqual(oneStep);
    } finally {
      db.close();
    }
  });

  it("returns undefined when loading an unknown key", () => {
    const db = openTempDb();
    try {
      expect(loadWorkflowDefinition(db, "no-such-key")).toBeUndefined();
      expect(loadWorkflowDefinition(db, "no-such-key", 7)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("seedBuiltInWorkflowDefinitions", () => {
  it("persists every built-in definition and is idempotent", () => {
    const db = openTempDb();
    try {
      const first = seedBuiltInWorkflowDefinitions(db, { now: 1000 });
      expect(first.map((s) => s.key)).toContain(CODING_WORKFLOW_DEFINITION.key);
      expect(first.every((s) => s.inserted)).toBe(true);

      const second = seedBuiltInWorkflowDefinitions(db, { now: 2000 });
      expect(second.every((s) => s.inserted)).toBe(false);

      expect(countDefinitionRows(db, CODING_WORKFLOW_DEFINITION.key)).toBe(1);
      expect(loadWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION.key)).toEqual(
        CODING_WORKFLOW_DEFINITION
      );
    } finally {
      db.close();
    }
  });
});

describe("listWorkflowDefinitionKeys", () => {
  it("returns the distinct persisted definition keys in order", () => {
    const db = openTempDb();
    try {
      expect(listWorkflowDefinitionKeys(db)).toEqual([]);

      seedBuiltInWorkflowDefinitions(db, { now: 1000 });
      persistWorkflowDefinition(
        db,
        {
          key: "demo",
          title: "Demo",
          version: 1,
          steps: [
            {
              key: "preflight",
              kind: "preflight",
              executor: "one-shot",
              order: 0,
              required: true
            }
          ]
        },
        { now: 1000 }
      );
      persistWorkflowDefinition(
        db,
        {
          key: "demo",
          title: "Demo",
          version: 2,
          steps: [
            {
              key: "preflight",
              kind: "preflight",
              executor: "one-shot",
              order: 0,
              required: true
            }
          ]
        },
        { now: 2000 }
      );

      expect(listWorkflowDefinitionKeys(db)).toEqual([
        CODING_WORKFLOW_DEFINITION.key,
        "demo"
      ]);
    } finally {
      db.close();
    }
  });
});
