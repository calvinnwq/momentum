import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_KEY,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatchContext,
} from "../src/core/workflow/dispatch/scheduler.js";
import { loadWorkflowRunDetail } from "../src/core/workflow/run/status.js";
import {
  deriveDispatchedSubworkflowContext,
  loadClaimedSubworkflowStepConfig,
  loadSubworkflowParentRunRow,
  loadSubworkflowRunLineageRow,
  resolveSubworkflowParentRunFacts,
  type SubworkflowParentRunRow,
} from "../src/core/workflow/route/subworkflow-dispatch-context.js";
import { loadCanonicalWorkflowRunRoute } from "./support/canonical-route-state.js";

/**
 * NGX-666 (NAM-03C) — focused coverage for the daemon-lane context deriver that
 * the subworkflow entry-point factory (`subworkflow-dispatch.ts`) injects as its
 * {@link DeriveDispatchedSubworkflowContext}.
 *
 * The deriver reads canonical durable state directly:
 *
 *   - child intent from the claimed step's own
 *     `workflow_steps.executor_config_json` row (snapshotted at start from the
 *     step definition's portable config);
 *   - parent / depth / ancestry from the run's `workflow_run_lineage` row
 *     (absent = top-level, corrupt = fail closed);
 *   - definition key / objective / repo from the parent `workflow_runs` row.
 *
 * No compatibility route projection is consulted anywhere on this path, and a
 * fresh parent run carries no `route.subworkflow` namespace.
 */

const NOW = 1_700_000_000_000;
const PARENT_RUN_ID = "run-parent-ctx-001";
const STEP_ID = "preflight";
const REPO_PATH = "/repos/momentum";
const CHILD_DEFINITION_KEY = "child-workflow";
const CHILD_RUN_ID = `${PARENT_RUN_ID}::${STEP_ID}::child`;
const WORKER = "worker-ctx";
const DISPATCH_AT = NOW + 1;

/** A minimal, valid child recipe distinct from the parent's coding workflow. */
const CHILD_DEFINITION: WorkflowDefinition = {
  key: CHILD_DEFINITION_KEY,
  title: "Child Workflow",
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

function parentDefinitionWithChildConfig(
  childConfig: unknown,
): WorkflowDefinition {
  return {
    ...CODING_WORKFLOW_DEFINITION,
    steps: CODING_WORKFLOW_DEFINITION.steps.map((step) =>
      step.key === STEP_ID
        ? {
            ...step,
            executor: "subworkflow" as const,
            ...(childConfig === undefined
              ? {}
              : { config: { child: childConfig } }),
          }
        : step,
    ),
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-sub-ctx-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/**
 * A migrated DB with the parent run started from a definition whose subworkflow
 * step carries the supplied portable child config and, unless opted out, the
 * distinct child definition persisted. Start persistence snapshots the child
 * intent into the owning `workflow_steps.executor_config_json` row.
 */
function openSeededDb(
  options: {
    childConfig?: unknown;
    withChildDefinition?: boolean;
  } = {},
): MomentumDb {
  const db = openDb(makeTempDir());
  const parentDefinition = parentDefinitionWithChildConfig(options.childConfig);
  persistWorkflowDefinition(db, parentDefinition, { now: NOW });

  persistWorkflowRunStart(db, {
    definition: parentDefinition,
    runId: PARENT_RUN_ID,
    repoPath: REPO_PATH,
    objective: "Parent run for canonical context deriver coverage",
    now: NOW,
  });

  if (options.withChildDefinition !== false) {
    persistWorkflowDefinition(db, CHILD_DEFINITION, { now: NOW });
  }
  return db;
}

function claim(
  db: MomentumDb,
  runId: string = PARENT_RUN_ID,
  stepId: string = STEP_ID,
): ClaimedWorkflowStep {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
  ).run(runId, stepId);
  const result = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
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
  now: DISPATCH_AT,
});

function countRuns(db: MomentumDb): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }
  ).n;
}

describe("deriveDispatchedSubworkflowContext — resolves a configured subworkflow step from canonical state", () => {
  it("returns a runner + parent-run-dir evidence and starts the keyed child run on demand", async () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    // The fresh parent run carries no subworkflow route namespace.
    expect(loadCanonicalWorkflowRunRoute(db, PARENT_RUN_ID)).toEqual({});

    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const expectedRunDir = path.join(
      REPO_PATH,
      ".agent-workflows",
      PARENT_RUN_ID,
    );
    expect(resolution.evidence.executorLogPath).toBe(
      path.join(expectedRunDir, "subworkflow.log"),
    );
    expect(resolution.evidence.resultJsonPath).toBe(
      path.join(expectedRunDir, "subworkflow.json"),
    );

    // The deriver only builds the runner; no child run exists until it runs.
    expect(countRuns(db)).toBe(1);

    const observation = await resolution.runSubworkflowChild();
    expect(observation.childRunId).toBe(CHILD_RUN_ID);
    expect(observation.childState).toBe("pending");
    expect(countRuns(db)).toBe(2);

    // Child started from the CHILD definition (not the parent's coding workflow).
    const child = loadWorkflowRunDetail(db, CHILD_RUN_ID);
    expect(child?.steps).toHaveLength(CHILD_DEFINITION.steps.length);
  });

  it("starts the child run with its canonical lineage row and no subworkflow route namespace", async () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    if (!resolution.ok) throw new Error(resolution.reason);

    await resolution.runSubworkflowChild();

    expect(
      db
        .prepare(
          `SELECT parent_run_id, parent_step_id, depth,
                  ancestor_definition_keys_json
             FROM workflow_run_lineage WHERE run_id = ?`,
        )
        .get(CHILD_RUN_ID),
    ).toEqual({
      parent_run_id: PARENT_RUN_ID,
      parent_step_id: STEP_ID,
      depth: 1,
      ancestor_definition_keys_json: JSON.stringify([
        CODING_WORKFLOW_DEFINITION_KEY,
      ]),
    });
    expect(loadCanonicalWorkflowRunRoute(db, CHILD_RUN_ID)).toEqual({});
  });

  it("chooses canonical child intent over stale compatibility-shaped route state", async () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    // Stale compatibility-shaped state names a different child B; the active
    // path must behave as if the canonical step-owned intent (A) is the only
    // value that exists.
    db.prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?").run(
      JSON.stringify({
        subworkflow: {
          child: {
            childDefinitionKey: "stale-child-b",
            childDefinitionVersion: 9,
          },
        },
      }),
      PARENT_RUN_ID,
    );

    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const observation = await resolution.runSubworkflowChild();
    expect(observation.childRunId).toBe(CHILD_RUN_ID);
    const child = db
      .prepare("SELECT workflow_definition_key FROM workflow_runs WHERE id = ?")
      .get(CHILD_RUN_ID) as { workflow_definition_key: string };
    expect(child.workflow_definition_key).toBe(CHILD_DEFINITION_KEY);
  });
});

describe("deriveDispatchedSubworkflowContext — fail closed", () => {
  it("refuses when the subworkflow step carries no child config", () => {
    const db = openSeededDb();
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/child/i);
    expect(countRuns(db)).toBe(1);
  });

  it("refuses corrupt step executor config instead of dispatching", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const theClaim = claim(db);
    db.prepare(
      "UPDATE workflow_steps SET executor_config_json = '{not json' WHERE run_id = ? AND step_id = ?",
    ).run(PARENT_RUN_ID, STEP_ID);
    const resolution = deriveDispatchedSubworkflowContext(
      theClaim,
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/executor config/i);
    expect(countRuns(db)).toBe(1);
  });

  it("refuses an unsafe self-referential child (child key === parent definition)", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CODING_WORKFLOW_DEFINITION_KEY,
        childDefinitionVersion: CODING_WORKFLOW_DEFINITION.version,
      },
    });
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/self-reference/i);
    expect(countRuns(db)).toBe(1);
  });

  it("refuses a present-but-corrupt canonical lineage instead of resetting to top-level", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    persistWorkflowRunStart(db, {
      definition: parentDefinitionWithChildConfig({
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      }),
      runId: "run-grandparent-ctx-001",
      repoPath: REPO_PATH,
      objective: "Grandparent run for corrupt lineage coverage",
      now: NOW,
    });
    db.prepare(
      `INSERT INTO workflow_run_lineage (
         run_id, parent_run_id, parent_step_id, depth,
         ancestor_definition_keys_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PARENT_RUN_ID,
      "run-grandparent-ctx-001",
      STEP_ID,
      1,
      JSON.stringify([
        CODING_WORKFLOW_DEFINITION_KEY,
        CODING_WORKFLOW_DEFINITION_KEY,
      ]),
      NOW,
      NOW,
    );
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/lineage/i);
    expect(countRuns(db)).toBe(2);
  });

  it("refuses relationally invalid canonical lineage before planning", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    persistWorkflowRunStart(db, {
      definition: parentDefinitionWithChildConfig({
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      }),
      runId: "run-parent-ctx-invalid-lineage",
      repoPath: REPO_PATH,
      objective: "Parent run for invalid lineage coverage",
      now: NOW,
    });
    db.prepare(
      `INSERT INTO workflow_run_lineage (
         run_id, parent_run_id, parent_step_id, depth,
         ancestor_definition_keys_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PARENT_RUN_ID,
      "run-parent-ctx-invalid-lineage",
      "implementation",
      1,
      JSON.stringify([CODING_WORKFLOW_DEFINITION_KEY]),
      NOW,
      NOW,
    );

    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/subworkflow dispatch|lineage/i);
    expect(countRuns(db)).toBe(2);
  });

  it("uses canonical ancestor lineage when a stale route projection is present", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
        maxDepth: 2,
      },
    });
    const grandparentRunId = "run-grandparent-ctx-stale-route";
    persistWorkflowRunStart(db, {
      definition: parentDefinitionWithChildConfig({
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      }),
      runId: grandparentRunId,
      repoPath: REPO_PATH,
      objective: "Grandparent run with stale compatibility lineage",
      now: NOW,
    });
    db.prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?").run(
      JSON.stringify({
        subworkflow: {
          lineage: {
            parentRunId: "stale-route-parent",
            parentStepId: STEP_ID,
            depth: 1,
            ancestorDefinitionKeys: ["stale-route-ancestor"],
          },
        },
      }),
      grandparentRunId,
    );
    db.prepare(
      `INSERT INTO workflow_run_lineage (
         run_id, parent_run_id, parent_step_id, depth,
         ancestor_definition_keys_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PARENT_RUN_ID,
      grandparentRunId,
      STEP_ID,
      1,
      JSON.stringify([CODING_WORKFLOW_DEFINITION_KEY]),
      NOW,
      NOW,
    );

    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(true);
    expect(countRuns(db)).toBe(2);
  });

  it("refuses at build time when the configured child definition key does not resolve", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: "no-such-definition",
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
      withChildDefinition: false,
    });
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("no-such-definition");
    expect(countRuns(db)).toBe(1);
  });

  it("refuses when the parent run row does not exist", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const ghostClaim: ClaimedWorkflowStep = {
      ...claim(db),
      runId: "ghost-run-xyz",
    };
    const resolution = deriveDispatchedSubworkflowContext(
      ghostClaim,
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("ghost-run-xyz");
  });

  it("refuses when the parent run has no repo path to host a child", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const theClaim = claim(db);
    db.prepare("UPDATE workflow_runs SET repo_path = NULL WHERE id = ?").run(
      PARENT_RUN_ID,
    );
    const resolution = deriveDispatchedSubworkflowContext(
      theClaim,
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/repo/i);
    expect(countRuns(db)).toBe(1);
  });
});

describe("resolveSubworkflowParentRunFacts — pure parent-fact validation", () => {
  const baseRow: SubworkflowParentRunRow = {
    definitionKey: CODING_WORKFLOW_DEFINITION_KEY,
    objective: "Parent objective",
    repoPath: REPO_PATH,
    sourceArtifactPath: null,
  };

  it("passes through the validated run facts", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, baseRow);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.facts.definitionKey).toBe(CODING_WORKFLOW_DEFINITION_KEY);
    expect(resolution.facts.objective).toBe("Parent objective");
    expect(resolution.facts.repoPath).toBe(REPO_PATH);
  });

  it("fails closed when the run is not linked to a definition key", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, {
      ...baseRow,
      definitionKey: null,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/definition/i);
  });

  it("fails closed when the run has no objective to inherit", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, {
      ...baseRow,
      objective: "   ",
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/objective/i);
  });
});

describe("canonical durable IO readers", () => {
  it("loads the parent run's definition / objective / repo facts", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const row = loadSubworkflowParentRunRow(db, PARENT_RUN_ID);
    expect(row).toBeDefined();
    expect(row?.definitionKey).toBe(CODING_WORKFLOW_DEFINITION_KEY);
    expect(row?.objective).toContain("Parent run");
    expect(row?.repoPath).toBe(REPO_PATH);
  });

  it("returns undefined for a run that does not exist", () => {
    const db = openSeededDb();
    expect(loadSubworkflowParentRunRow(db, "no-such-run")).toBeUndefined();
  });

  it("reads the claimed step's snapshotted child intent directly from the step row", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
    const resolution = loadClaimedSubworkflowStepConfig(
      db,
      PARENT_RUN_ID,
      STEP_ID,
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.config).toEqual({
      child: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
    });
  });

  it("fails closed when the claimed step row does not exist", () => {
    const db = openSeededDb();
    const resolution = loadClaimedSubworkflowStepConfig(
      db,
      PARENT_RUN_ID,
      "no-such-step",
    );
    expect(resolution.ok).toBe(false);
  });

  it("treats an absent lineage row as a legitimate top-level run", () => {
    const db = openSeededDb();
    expect(loadSubworkflowRunLineageRow(db, PARENT_RUN_ID)).toEqual({
      ok: true,
      lineage: null,
    });
  });
});
