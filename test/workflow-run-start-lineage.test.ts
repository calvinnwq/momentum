import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import {
  InvalidWorkflowRunStartError,
  persistWorkflowRunStart,
} from "../src/core/workflow/run/start-persist.js";
import { loadCanonicalWorkflowRunRoute } from "./support/canonical-route-state.js";

/**
 * NGX-666 (NAM-03C) — the explicit child-lineage input at the start-persistence
 * seam.
 *
 * A subworkflow child run is persisted with an explicit `lineage` input rather
 * than a `route.subworkflow` namespace: the run row, its step-owned config, and
 * its `workflow_run_lineage` row insert atomically, the fresh run carries no
 * subworkflow route namespace, and invalid or unsafe lineage fails closed
 * before any row is written. The retired `route.subworkflow` start namespace is
 * refused outright.
 */

const NOW = 1_700_000_000_000;
const REPO_PATH = "/repos/momentum";
const PARENT_RUN_ID = "run-start-lineage-parent";
const PARENT_STEP_ID = "launch-child";
const CHILD_RUN_ID = `${PARENT_RUN_ID}::${PARENT_STEP_ID}::child`;

const CHILD_DEFINITION: WorkflowDefinition = {
  key: "start-lineage-child",
  title: "Start lineage child",
  version: 1,
  steps: [
    {
      key: "preflight",
      kind: "preflight",
      executor: "agent-once",
      order: 0,
      required: true,
    },
  ],
};

const PARENT_DEFINITION: WorkflowDefinition = {
  key: "start-lineage-parent",
  title: "Start lineage parent",
  version: 1,
  steps: [
    {
      key: PARENT_STEP_ID,
      kind: "implementation",
      executor: "subworkflow",
      order: 0,
      required: true,
      config: {
        child: {
          childDefinitionKey: CHILD_DEFINITION.key,
          childDefinitionVersion: CHILD_DEFINITION.version,
        },
      },
    },
  ],
};

const VALID_LINEAGE = {
  parentRunId: PARENT_RUN_ID,
  parentStepId: PARENT_STEP_ID,
  depth: 1,
  ancestorDefinitionKeys: [PARENT_DEFINITION.key],
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-start-lineage-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openSeededDb(): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, PARENT_DEFINITION, { now: NOW });
  persistWorkflowDefinition(db, CHILD_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: PARENT_DEFINITION,
    runId: PARENT_RUN_ID,
    repoPath: REPO_PATH,
    objective: "Parent run for explicit start lineage coverage",
    now: NOW,
  });
  return db;
}

function startChild(
  db: MomentumDb,
  overrides: Record<string, unknown> = {},
): void {
  persistWorkflowRunStart(db, {
    definition: CHILD_DEFINITION,
    runId: CHILD_RUN_ID,
    repoPath: REPO_PATH,
    objective: "Child run with explicit lineage",
    lineage: VALID_LINEAGE,
    now: NOW,
    ...overrides,
  });
}

function lineageRow(db: MomentumDb, runId: string): unknown {
  return db
    .prepare(
      `SELECT parent_run_id, parent_step_id, depth,
              ancestor_definition_keys_json
         FROM workflow_run_lineage WHERE run_id = ?`,
    )
    .get(runId);
}

describe("persistWorkflowRunStart — explicit child lineage", () => {
  it("inserts the child run and its canonical lineage row atomically, with no subworkflow route namespace", () => {
    const db = openSeededDb();
    startChild(db);

    expect(lineageRow(db, CHILD_RUN_ID)).toEqual({
      parent_run_id: PARENT_RUN_ID,
      parent_step_id: PARENT_STEP_ID,
      depth: 1,
      ancestor_definition_keys_json: JSON.stringify([PARENT_DEFINITION.key]),
    });
    // The child run's compatibility projection carries no subworkflow keys.
    expect(loadCanonicalWorkflowRunRoute(db, CHILD_RUN_ID)).toEqual({});
  });

  it("refuses the retired route.subworkflow start namespace", () => {
    const db = openSeededDb();
    expect(() =>
      startChild(db, {
        lineage: undefined,
        route: {
          subworkflow: { lineage: VALID_LINEAGE },
        },
      }),
    ).toThrow(InvalidWorkflowRunStartError);
    expect(lineageRow(db, CHILD_RUN_ID)).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?").get(CHILD_RUN_ID),
    ).toBeUndefined();
  });

  it.each([
    ["blank parentRunId", { ...VALID_LINEAGE, parentRunId: "  " }],
    ["non-integer depth", { ...VALID_LINEAGE, depth: 1.5 }],
    ["depth / ancestry mismatch", { ...VALID_LINEAGE, depth: 2 }],
    [
      "repeated ancestors",
      {
        ...VALID_LINEAGE,
        depth: 2,
        ancestorDefinitionKeys: ["a", "a"],
      },
    ],
    ["unknown keys", { ...VALID_LINEAGE, extra: true }],
    ["non-object lineage", "not-an-object"],
  ])(
    "fails closed before any write on invalid lineage: %s",
    (_label, lineage) => {
      const db = openSeededDb();
      expect(() => startChild(db, { lineage })).toThrow(
        InvalidWorkflowRunStartError,
      );
      expect(
        db
          .prepare("SELECT 1 FROM workflow_runs WHERE id = ?")
          .get(CHILD_RUN_ID),
      ).toBeUndefined();
      expect(lineageRow(db, CHILD_RUN_ID)).toBeUndefined();
    },
  );

  it("fails closed when the lineage parent step does not exist", () => {
    const db = openSeededDb();
    expect(() =>
      startChild(db, {
        lineage: { ...VALID_LINEAGE, parentStepId: "no-such-step" },
      }),
    ).toThrow(InvalidWorkflowRunStartError);
    expect(
      db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?").get(CHILD_RUN_ID),
    ).toBeUndefined();
  });

  it("fails closed when the lineage parent step is not a subworkflow dispatch", () => {
    const db = openSeededDb();
    persistWorkflowDefinition(
      db,
      {
        ...PARENT_DEFINITION,
        key: "start-lineage-plain-parent",
        steps: [
          {
            key: PARENT_STEP_ID,
            kind: "implementation",
            executor: "agent-once",
            order: 0,
            required: true,
          },
        ],
      },
      { now: NOW },
    );
    persistWorkflowRunStart(db, {
      definition: {
        ...PARENT_DEFINITION,
        key: "start-lineage-plain-parent",
        steps: [
          {
            key: PARENT_STEP_ID,
            kind: "implementation",
            executor: "agent-once",
            order: 0,
            required: true,
          },
        ],
      },
      runId: "run-start-lineage-plain-parent",
      repoPath: REPO_PATH,
      objective: "Plain parent run",
      now: NOW,
    });
    expect(() =>
      startChild(db, {
        lineage: {
          ...VALID_LINEAGE,
          parentRunId: "run-start-lineage-plain-parent",
          ancestorDefinitionKeys: ["start-lineage-plain-parent"],
        },
      }),
    ).toThrow(InvalidWorkflowRunStartError);
    expect(
      db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?").get(CHILD_RUN_ID),
    ).toBeUndefined();
  });

  it("fails closed when the ancestry does not match the parent chain", () => {
    const db = openSeededDb();
    expect(() =>
      startChild(db, {
        lineage: {
          ...VALID_LINEAGE,
          ancestorDefinitionKeys: ["some-other-definition"],
        },
      }),
    ).toThrow(InvalidWorkflowRunStartError);
    expect(
      db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?").get(CHILD_RUN_ID),
    ).toBeUndefined();
  });
});
