import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { markWorkflowRunNeedsManualRecovery } from "../src/core/workflow/run/recovery.js";
import { loadWorkflowRunDetail } from "../src/core/workflow/run/status.js";
import { buildDispatchedSubworkflowChildRunner } from "../src/core/workflow/route/subworkflow-child-runner.js";

/**
 * NGX-498 (RC-4b) — focused coverage for the *production* start-or-attach child
 * runner builder.
 *
 * The RC-4 child-run integration proof
 * (`workflow-dispatch-subworkflow-child-run.test.ts`) drove a real child run, but
 * through a *test-only* `realChildRunner` helper that hardcodes
 * `CODING_WORKFLOW_DEFINITION` as the child recipe. The production daemon lane
 * cannot hardcode a child definition: a configured `subworkflow` step names its
 * child by key (`route.subworkflow.child.childDefinitionKey`, validated by
 * iterations 1-2), so the runner the daemon injects must resolve that key against
 * the durable definition store and fail closed when it does not resolve.
 *
 * {@link buildDispatchedSubworkflowChildRunner} is that production builder: it
 * resolves the child {@link WorkflowDefinition} by key, and on success returns a
 * {@link DispatchedSubworkflowChildRunner} that durably starts (or, on a re-check,
 * attaches to) the SAME child workflow run through the run-start seam and observes
 * its real state through the status read-back seam — exactly the
 * start-or-attach idempotency the producer's contract places in the injected
 * runner, but now sourced from production config rather than a test fixture.
 */

const NOW = 1_700_000_000_000;
const PARENT_RUN_ID = "run-parent-001";
const STEP_ID = "preflight";
const CHILD_RUN_ID = `${PARENT_RUN_ID}::${STEP_ID}::child`;
const CHILD_DEFINITION_KEY = "child-workflow";

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

const CHILD_DEFINITION_V2: WorkflowDefinition = {
  ...CHILD_DEFINITION,
  version: 2,
  steps: [
    ...CHILD_DEFINITION.steps,
    {
      key: "implementation",
      kind: "implementation",
      executor: "agent-once",
      order: 1,
      required: true,
    },
  ],
};

const OTHER_DEFINITION: WorkflowDefinition = {
  ...CHILD_DEFINITION,
  key: "other-child-workflow",
  title: "Other Child Workflow",
};

/** A propagated child route, as iteration 2's `deriveChildSubworkflowRoute` builds. */
const CHILD_ROUTE = {
  subworkflow: {
    lineage: {
      parentRunId: PARENT_RUN_ID,
      parentStepId: STEP_ID,
      depth: 1,
      ancestorDefinitionKeys: ["coding-workflow"],
    },
  },
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-sub-runner-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/** A migrated DB with the parent run started and the child definition persisted. */
function openSeededDb(
  options: { withChildDefinition?: boolean } = {},
): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: PARENT_RUN_ID,
    repoPath: "/repos/momentum",
    objective: "Parent run for RC-4b child-runner coverage",
    now: NOW,
  });
  if (options.withChildDefinition !== false) {
    persistWorkflowDefinition(db, CHILD_DEFINITION, { now: NOW });
  }
  return db;
}

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

function buildRunner(
  db: MomentumDb,
  overrides: {
    childDefinitionKey?: string;
    childDefinitionVersion?: number;
    childRunId?: string;
  } = {},
) {
  return buildDispatchedSubworkflowChildRunner({
    db,
    childRunId: overrides.childRunId ?? CHILD_RUN_ID,
    childDefinitionKey: overrides.childDefinitionKey ?? CHILD_DEFINITION_KEY,
    childDefinitionVersion:
      overrides.childDefinitionVersion ?? CHILD_DEFINITION.version,
    childRoute: CHILD_ROUTE,
    repoPath: "/repos/momentum",
    objective: "RC-4b child workflow run",
    now: NOW,
  });
}

describe("buildDispatchedSubworkflowChildRunner — start a real child run from a resolved definition", () => {
  it("starts the child workflow run from the key-resolved definition and observes it as non-terminal", async () => {
    const db = openSeededDb();
    const resolution = buildRunner(db);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(countRuns(db)).toBe(1); // only the parent until the runner runs

    const observation = await resolution.run();

    expect(observation.childRunId).toBe(CHILD_RUN_ID);
    expect(observation.childState).toBe("pending");
    expect(observation.childNeedsManualRecovery).toBe(false);
    expect(observation.childManualRecoveryReason).toBeNull();

    // A real child run now exists, started from the CHILD definition (not the
    // parent's coding workflow), with the child definition's steps.
    expect(countRuns(db)).toBe(2);
    const child = loadWorkflowRunDetail(db, CHILD_RUN_ID);
    expect(child?.steps).toHaveLength(CHILD_DEFINITION.steps.length);
  });

  it("starts the child run with the propagated child route", async () => {
    const db = openSeededDb();
    const resolution = buildRunner(db);
    if (!resolution.ok) throw new Error(resolution.reason);

    await resolution.run();

    expect(childRouteJson(db)).toEqual(CHILD_ROUTE);
  });

  it("starts the child workflow run from the configured definition version", async () => {
    const db = openSeededDb();
    persistWorkflowDefinition(db, CHILD_DEFINITION_V2, { now: NOW + 1 });
    const resolution = buildRunner(db, {
      childDefinitionVersion: CHILD_DEFINITION.version,
    });
    if (!resolution.ok) throw new Error(resolution.reason);

    await resolution.run();

    const child = loadWorkflowRunDetail(db, CHILD_RUN_ID);
    expect(child?.steps).toHaveLength(CHILD_DEFINITION.steps.length);
    const row = db
      .prepare(
        "SELECT workflow_definition_version FROM workflow_runs WHERE id = ?",
      )
      .get(CHILD_RUN_ID) as { workflow_definition_version: number | null };
    expect(row.workflow_definition_version).toBe(CHILD_DEFINITION.version);
  });
});

describe("buildDispatchedSubworkflowChildRunner — start-or-attach idempotency", () => {
  it("attaches to the SAME child run on re-check rather than starting a duplicate", async () => {
    const db = openSeededDb();
    const resolution = buildRunner(db);
    if (!resolution.ok) throw new Error(resolution.reason);

    const first = await resolution.run();
    expect(first.childState).toBe("pending");
    expect(countRuns(db)).toBe(2);

    // The child run reaches its own terminal success between ticks.
    db.prepare(
      "UPDATE workflow_runs SET state = 'succeeded', updated_at = ? WHERE id = ?",
    ).run(NOW + 5, CHILD_RUN_ID);

    const second = await resolution.run();

    // No duplicate child run; the re-check observes the SAME run's advanced state.
    expect(countRuns(db)).toBe(2);
    expect(second.childRunId).toBe(CHILD_RUN_ID);
    expect(second.childState).toBe("succeeded");
  });
});

describe("buildDispatchedSubworkflowChildRunner — fail closed on a missing child definition", () => {
  it("refuses at build time when the child definition key does not resolve, starting no child run", () => {
    const db = openSeededDb({ withChildDefinition: false });

    const resolution = buildRunner(db, {
      childDefinitionKey: "no-such-definition",
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("no-such-definition");
    expect(countRuns(db)).toBe(1); // only the parent — no child fabricated
  });
});

describe("buildDispatchedSubworkflowChildRunner — fail closed on unsupported attachment", () => {
  it("refuses to attach when the deterministic child run id already belongs to another definition", () => {
    const db = openSeededDb();
    persistWorkflowDefinition(db, OTHER_DEFINITION, { now: NOW });
    persistWorkflowRunStart(db, {
      definition: OTHER_DEFINITION,
      runId: CHILD_RUN_ID,
      repoPath: "/repos/momentum",
      objective: "Conflicting pre-existing child run",
      now: NOW + 1,
    });

    const resolution = buildRunner(db);

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain(CHILD_RUN_ID);
    expect(resolution.reason).toContain(CHILD_DEFINITION_KEY);
    expect(resolution.reason).toContain(OTHER_DEFINITION.key);
  });

  it("refuses to attach when the deterministic child run id belongs to another version", () => {
    const db = openSeededDb();
    persistWorkflowDefinition(db, CHILD_DEFINITION_V2, { now: NOW + 1 });
    persistWorkflowRunStart(db, {
      definition: CHILD_DEFINITION_V2,
      runId: CHILD_RUN_ID,
      repoPath: "/repos/momentum",
      objective: "Conflicting pre-existing child run",
      now: NOW + 1,
    });

    const resolution = buildRunner(db, {
      childDefinitionVersion: CHILD_DEFINITION.version,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain(CHILD_RUN_ID);
    expect(resolution.reason).toContain(`${CHILD_DEFINITION_KEY}@1`);
    expect(resolution.reason).toContain(`${CHILD_DEFINITION_KEY}@2`);
  });
});

describe("buildDispatchedSubworkflowChildRunner — observation mirrors child manual-recovery flags", () => {
  it("surfaces the child run's needs-manual-recovery flag and reason", async () => {
    const db = openSeededDb();
    const resolution = buildRunner(db);
    if (!resolution.ok) throw new Error(resolution.reason);

    await resolution.run(); // start the child

    const reason = "child run entered recovery while still running";
    const marked = markWorkflowRunNeedsManualRecovery(db, {
      runId: CHILD_RUN_ID,
      reason,
      now: NOW + 25,
    });
    expect(marked.ok).toBe(true);

    const observation = await resolution.run(); // attach + re-observe

    expect(observation.childNeedsManualRecovery).toBe(true);
    expect(observation.childManualRecoveryReason).toBe(reason);
  });
});
