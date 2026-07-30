import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatchContext,
} from "../src/core/workflow/dispatch/scheduler.js";
import { deriveDispatchedSubworkflowContext } from "../src/core/workflow/route/subworkflow-dispatch-context.js";
import { loadCanonicalWorkflowRunRoute } from "./support/canonical-route-state.js";

/**
 * NGX-666 (NAM-03C) — nested recursion proof over canonical state only.
 *
 * A -> B -> C with `maxDepth: 2`: every level's child intent comes from the
 * owning step's `workflow_steps.executor_config_json`, every level's ancestry
 * from `workflow_run_lineage`, and no run at any level carries a subworkflow
 * route namespace. B persists depth 1 with ancestors [A]; C persists depth 2
 * with ancestors [A, B]; a third level fails closed on the recursion bound
 * before any child run is created. Restart and concurrent start-or-attach
 * always converge on the same deterministic child.
 */

const NOW = 1_700_000_000_000;
const REPO_PATH = "/repos/momentum";
const STEP_ID = "spawn";
const WORKER = "worker-nested";

function definitionWithChild(
  key: string,
  child: { childDefinitionKey: string; maxDepth: number } | null,
): WorkflowDefinition {
  return {
    key,
    title: `Nested proof ${key}`,
    version: 1,
    steps: [
      child === null
        ? {
            key: STEP_ID,
            kind: "preflight",
            executor: "agent-once",
            order: 0,
            required: true,
          }
        : {
            key: STEP_ID,
            kind: "implementation",
            executor: "subworkflow",
            order: 0,
            required: true,
            config: {
              child: {
                childDefinitionKey: child.childDefinitionKey,
                childDefinitionVersion: 1,
                maxDepth: child.maxDepth,
              },
            },
          },
    ],
  };
}

const DEFINITION_A = definitionWithChild("nested-a", {
  childDefinitionKey: "nested-b",
  maxDepth: 2,
});
const DEFINITION_B = definitionWithChild("nested-b", {
  childDefinitionKey: "nested-c",
  maxDepth: 2,
});
// C also names a child with the same bound, so the third level proves the
// recursion bound fails closed before any child run exists.
const DEFINITION_C = definitionWithChild("nested-c", {
  childDefinitionKey: "nested-d",
  maxDepth: 2,
});
const DEFINITION_D = definitionWithChild("nested-d", null);

const RUN_A = "run-nested-a";
const RUN_B = `${RUN_A}::${STEP_ID}::child`;
const RUN_C = `${RUN_B}::${STEP_ID}::child`;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-sub-nested-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openSeededDb(): MomentumDb {
  const db = openDb(makeTempDir());
  for (const definition of [
    DEFINITION_A,
    DEFINITION_B,
    DEFINITION_C,
    DEFINITION_D,
  ]) {
    persistWorkflowDefinition(db, definition, { now: NOW });
  }
  persistWorkflowRunStart(db, {
    definition: DEFINITION_A,
    runId: RUN_A,
    repoPath: REPO_PATH,
    objective: "Nested subworkflow canonical-state proof",
    now: NOW,
  });
  return db;
}

function claim(db: MomentumDb, runId: string): ClaimedWorkflowStep {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
  ).run(runId, STEP_ID);
  const result = claimRunnableWorkflowStep(db, {
    runId,
    stepId: STEP_ID,
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!result.ok)
    throw new Error(`test setup: claim failed (${result.reason})`);
  return result.claim;
}

const context = (db: MomentumDb): WorkflowStepDispatchContext => ({
  db,
  workerId: WORKER,
  now: NOW + 1,
});

function lineageRow(db: MomentumDb, runId: string): unknown {
  return db
    .prepare(
      `SELECT parent_run_id, parent_step_id, depth,
              ancestor_definition_keys_json
         FROM workflow_run_lineage WHERE run_id = ?`,
    )
    .get(runId);
}

async function launchChild(db: MomentumDb, parentRunId: string): Promise<void> {
  const resolution = deriveDispatchedSubworkflowContext(
    claim(db, parentRunId),
    context(db),
  );
  if (!resolution.ok) throw new Error(resolution.reason);
  await resolution.runSubworkflowChild();
}

describe("nested subworkflow launches over canonical state", () => {
  it("persists B at depth 1 with ancestors [A] and C at depth 2 with ancestors [A, B], with no subworkflow route namespaces", async () => {
    const db = openSeededDb();

    await launchChild(db, RUN_A);
    expect(lineageRow(db, RUN_B)).toEqual({
      parent_run_id: RUN_A,
      parent_step_id: STEP_ID,
      depth: 1,
      ancestor_definition_keys_json: JSON.stringify(["nested-a"]),
    });

    await launchChild(db, RUN_B);
    expect(lineageRow(db, RUN_C)).toEqual({
      parent_run_id: RUN_B,
      parent_step_id: STEP_ID,
      depth: 2,
      ancestor_definition_keys_json: JSON.stringify(["nested-a", "nested-b"]),
    });

    for (const runId of [RUN_A, RUN_B, RUN_C]) {
      expect(loadCanonicalWorkflowRunRoute(db, runId)).toEqual({});
    }
    // A top-level run has no lineage row at all — the empty ancestor case.
    expect(lineageRow(db, RUN_A)).toBeUndefined();
  });

  it("fails the third level closed on maxDepth before any child run is created", async () => {
    const db = openSeededDb();
    await launchChild(db, RUN_A);
    await launchChild(db, RUN_B);

    const resolution = deriveDispatchedSubworkflowContext(
      claim(db, RUN_C),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/maxDepth/);
    expect(
      db
        .prepare("SELECT 1 FROM workflow_runs WHERE id = ?")
        .get(`${RUN_C}::${STEP_ID}::child`),
    ).toBeUndefined();
  });

  it("reattaches to the same deterministic child after a restart-style re-derivation", async () => {
    const db = openSeededDb();
    await launchChild(db, RUN_A);

    // Simulate a daemon restart: the old dispatch lease is gone, a fresh
    // worker claims the same step and re-derives, and the runner attaches to
    // the SAME child instead of creating a duplicate.
    db.prepare("DELETE FROM workflow_leases WHERE run_id = ?").run(RUN_A);
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db, RUN_A),
      context(db),
    );
    if (!resolution.ok) throw new Error(resolution.reason);
    const observation = await resolution.runSubworkflowChild();
    expect(observation.childRunId).toBe(RUN_B);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE id = ?")
          .get(RUN_B) as { n: number }
      ).n,
    ).toBe(1);
  });

  it("creates at most one child under concurrent start-or-attach", async () => {
    const db = openSeededDb();
    const theClaim = claim(db, RUN_A);
    const first = deriveDispatchedSubworkflowContext(theClaim, context(db));
    const second = deriveDispatchedSubworkflowContext(theClaim, context(db));
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);

    const [a, b] = await Promise.all([
      first.runSubworkflowChild(),
      second.runSubworkflowChild(),
    ]);
    expect(a.childRunId).toBe(RUN_B);
    expect(b.childRunId).toBe(RUN_B);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE id = ?")
          .get(RUN_B) as { n: number }
      ).n,
    ).toBe(1);
    expect(lineageRow(db, RUN_B)).toEqual({
      parent_run_id: RUN_A,
      parent_step_id: STEP_ID,
      depth: 1,
      ancestor_definition_keys_json: JSON.stringify(["nested-a"]),
    });
  });
});

describe("no active subworkflow reader uses route state", () => {
  const ROUTE_STATE_ACCESS_PATTERNS = [
    /route\??\.\s*subworkflow/,
    /route\[["']subworkflow["']\]/,
    /subworkflow\?\.\s*(child|lineage)/,
  ];
  // Legacy-input validation and migration planning are the only modules
  // allowed to touch the retired route namespace (they migrate old route_json
  // into canonical destinations); run/start.ts only refuses it at start.
  const ALLOWED_FILES = new Set([
    path.join("adapters", "db", "route-state-validation.ts"),
    path.join("adapters", "db", "route-state.ts"),
    path.join("core", "workflow", "run", "start.ts"),
  ]);

  it("source scan: no src module outside legacy migration touches route.subworkflow", () => {
    const srcRoot = path.join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = path.relative(srcRoot, full);
        if (ALLOWED_FILES.has(relative)) continue;
        const code = fs
          .readFileSync(full, "utf8")
          .split("\n")
          .filter((line) => {
            const trimmed = line.trim();
            return (
              !trimmed.startsWith("//") &&
              !trimmed.startsWith("*") &&
              !trimmed.startsWith("/*")
            );
          })
          .join("\n");
        if (ROUTE_STATE_ACCESS_PATTERNS.some((pattern) => pattern.test(code))) {
          offenders.push(relative);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
