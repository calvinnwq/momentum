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
  loadSubworkflowParentRunRow,
  resolveSubworkflowParentRunFacts,
  type SubworkflowParentRunRow,
} from "../src/core/workflow/route/subworkflow-dispatch-context.js";

/**
 * NGX-498 (RC-4b) — focused coverage for the *daemon-lane context deriver* that
 * the landed RC-4 entry-point factory (`subworkflow-dispatch.ts`) injects as its
 * {@link DeriveDispatchedSubworkflowContext}.
 *
 * Iterations 1-3 landed the pure halves and the IO builder:
 *   - iteration 1: `validateSubworkflowChildConfig` + `planSubworkflowChildLaunch`
 *     (config shape + recursion safety);
 *   - iteration 2: `planSubworkflowChildLaunchFromRoute` (route-sourced config +
 *     durable recursion lineage);
 *   - iteration 3: `buildDispatchedSubworkflowChildRunner` (resolve child
 *     definition by key + start-or-attach runner).
 *
 * {@link deriveDispatchedSubworkflowContext} is the connective IO that reads a
 * dispatched `subworkflow` step's parent run facts (route / definition key /
 * objective / repo) from the durable `workflow_runs` row, composes the iteration-2
 * launch plan with the iteration-3 runner builder, and derives the parent-run-dir
 * evidence paths — producing the {@link DispatchedSubworkflowContextResolution} the
 * factory forwards into the producer or routes to manual recovery on refusal.
 *
 * RC-4b (NGX-498) has since wired this deriver into the daemon lane
 * (`withSubworkflowDispatch` in cli.ts) and flipped `subworkflow` into
 * `PHASE1_DISPATCHABLE_EXECUTORS`; the production-flip proof lives in
 * `test/workflow-dispatch-subworkflow-flip.test.ts`.
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
 * A migrated DB with the parent run started (carrying the supplied
 * `route.subworkflow.child` config / `route.subworkflow.lineage`) and, unless
 * opted out, the distinct child definition persisted.
 */
function openSeededDb(
  options: {
    childConfig?: unknown;
    lineage?: unknown;
    withChildDefinition?: boolean;
  } = {},
): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });

  const subworkflow: Record<string, unknown> = {};
  if (options.childConfig !== undefined)
    subworkflow["child"] = options.childConfig;
  if (options.lineage !== undefined) subworkflow["lineage"] = options.lineage;
  const route =
    Object.keys(subworkflow).length > 0 ? { subworkflow } : undefined;

  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: PARENT_RUN_ID,
    repoPath: REPO_PATH,
    objective: "Parent run for RC-4b context deriver coverage",
    ...(route ? { route } : {}),
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

function childRouteJson(db: MomentumDb): unknown {
  const row = db
    .prepare("SELECT route_json FROM workflow_runs WHERE id = ?")
    .get(CHILD_RUN_ID) as { route_json: string | null } | undefined;
  if (row?.route_json == null) return null;
  return JSON.parse(row.route_json) as unknown;
}

describe("deriveDispatchedSubworkflowContext — resolves a configured subworkflow step", () => {
  it("returns a runner + parent-run-dir evidence and starts the keyed child run on demand", async () => {
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

  it("starts the child run with the propagated recursion lineage in its route", async () => {
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

    expect(childRouteJson(db)).toEqual({
      subworkflow: {
        lineage: {
          parentRunId: PARENT_RUN_ID,
          parentStepId: STEP_ID,
          depth: 1,
          ancestorDefinitionKeys: [CODING_WORKFLOW_DEFINITION_KEY],
        },
      },
    });
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

  it("refuses a present-but-corrupt recursion lineage instead of resetting to top-level", () => {
    const db = openSeededDb({
      childConfig: {
        childDefinitionKey: CHILD_DEFINITION_KEY,
        childDefinitionVersion: CHILD_DEFINITION.version,
      },
      lineage: { parentRunId: 42 },
    });
    const resolution = deriveDispatchedSubworkflowContext(
      claim(db),
      context(db),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/lineage/i);
    expect(countRuns(db)).toBe(1);
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
    routeJson: JSON.stringify({
      subworkflow: {
        child: {
          childDefinitionKey: CHILD_DEFINITION_KEY,
          childDefinitionVersion: CHILD_DEFINITION.version,
        },
      },
    }),
    definitionKey: CODING_WORKFLOW_DEFINITION_KEY,
    objective: "Parent objective",
    repoPath: REPO_PATH,
    sourceArtifactPath: null,
  };

  it("parses route_json and passes through the run facts", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, baseRow);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.facts.definitionKey).toBe(CODING_WORKFLOW_DEFINITION_KEY);
    expect(resolution.facts.objective).toBe("Parent objective");
    expect(resolution.facts.repoPath).toBe(REPO_PATH);
    expect(resolution.facts.route).toEqual({
      subworkflow: {
        child: {
          childDefinitionKey: CHILD_DEFINITION_KEY,
          childDefinitionVersion: CHILD_DEFINITION.version,
        },
      },
    });
  });

  it("treats a null route_json as an empty route", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, {
      ...baseRow,
      routeJson: null,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.facts.route).toEqual({});
  });

  it("fails closed on corrupt route_json instead of throwing", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, {
      ...baseRow,
      routeJson: "{not json",
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/route/i);
  });

  it("fails closed when route_json is a JSON array, not an object", () => {
    const resolution = resolveSubworkflowParentRunFacts(PARENT_RUN_ID, {
      ...baseRow,
      routeJson: "[1,2,3]",
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toMatch(/route/i);
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

describe("loadSubworkflowParentRunRow — durable run-row IO", () => {
  it("loads the parent run's route / definition / objective / repo facts", () => {
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
    expect(JSON.parse(row?.routeJson ?? "null")).toEqual({
      subworkflow: {
        child: {
          childDefinitionKey: CHILD_DEFINITION_KEY,
          childDefinitionVersion: CHILD_DEFINITION.version,
        },
      },
    });
  });

  it("returns undefined for a run that does not exist", () => {
    const db = openSeededDb();
    expect(loadSubworkflowParentRunRow(db, "no-such-run")).toBeUndefined();
  });
});
