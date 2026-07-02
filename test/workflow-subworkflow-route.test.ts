import { describe, expect, it } from "vitest";

import {
  SUBWORKFLOW_ROUTE_KEY,
  deriveChildSubworkflowRoute,
  deriveChildSubworkflowRunId,
  planSubworkflowChildLaunchFromRoute,
  readSubworkflowParentLineage,
  type SubworkflowRouteLineage
} from "../src/core/workflow/route/subworkflow.js";
import type { SubworkflowParentLineage } from "../src/core/workflow/route/subworkflow-child-config.js";

/**
 * RC-4b (NGX-498) — the pure policy core of the daemon-lane subworkflow deriver.
 *
 * Iteration 1 landed the config validator + recursion-safety decider but left two
 * connective decisions to "the wiring slice": where a production `subworkflow`
 * step's child config is sourced from, and how the parent run's recursion lineage
 * is encoded durably (there is no first-class depth/lineage column). This module
 * resolves both against the run's free-form `route.subworkflow` namespace, purely:
 *
 *   - {@link readSubworkflowParentLineage} reads the parent's lineage from its
 *     route (absent => top-level; present-but-corrupt => fail closed);
 *   - {@link deriveChildSubworkflowRoute} propagates that lineage one level down so
 *     a grandchild launch can detect a cycle / depth bound;
 *   - {@link planSubworkflowChildLaunchFromRoute} composes config validation +
 *     lineage read + recursion decider into the single decision the IO deriver
 *     forwards (or routes to manual recovery on any refusal).
 *
 * Pure and total — no SQLite, no file system — so the fail-closed contract is
 * exhaustively testable here, the same discipline `subworkflow-child-config.ts`
 * follows.
 */

const PARENT_RUN_ID = "run-parent-001";
const PARENT_STEP_ID = "delegate";
const PARENT_DEF_KEY = "parent-workflow";
const CHILD_DEF_KEY = "child-workflow";
const CHILD_DEF_VERSION = 1;

function routeWithChild(
  child: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { [SUBWORKFLOW_ROUTE_KEY]: { child, ...extra } };
}

describe("readSubworkflowParentLineage", () => {
  it("treats a run with no subworkflow route namespace as top-level (no ancestors)", () => {
    const resolution = readSubworkflowParentLineage({}, PARENT_DEF_KEY);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok");
    expect(resolution.lineage).toEqual<SubworkflowParentLineage>({
      definitionKey: PARENT_DEF_KEY,
      ancestorDefinitionKeys: []
    });
  });

  it("treats a subworkflow namespace without a lineage as top-level", () => {
    const resolution = readSubworkflowParentLineage(
      { [SUBWORKFLOW_ROUTE_KEY]: { child: { childDefinitionKey: CHILD_DEF_KEY } } },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok");
    expect(resolution.lineage.ancestorDefinitionKeys).toEqual([]);
  });

  it("treats a non-object subworkflow namespace as top-level", () => {
    const resolution = readSubworkflowParentLineage(
      { [SUBWORKFLOW_ROUTE_KEY]: "nope" },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok");
    expect(resolution.lineage.ancestorDefinitionKeys).toEqual([]);
  });

  it("reads the ancestor definition keys from a valid lineage", () => {
    const lineage: SubworkflowRouteLineage = {
      parentRunId: "run-grandparent",
      parentStepId: "delegate",
      depth: 1,
      ancestorDefinitionKeys: ["grandparent-workflow"]
    };
    const resolution = readSubworkflowParentLineage(
      { [SUBWORKFLOW_ROUTE_KEY]: { lineage } },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok");
    expect(resolution.lineage).toEqual<SubworkflowParentLineage>({
      definitionKey: PARENT_DEF_KEY,
      ancestorDefinitionKeys: ["grandparent-workflow"]
    });
  });

  it("fails closed when a present lineage is not an object", () => {
    const resolution = readSubworkflowParentLineage(
      { [SUBWORKFLOW_ROUTE_KEY]: { lineage: "corrupt" } },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected refusal");
    expect(resolution.refusal).toBe("lineage_invalid");
  });

  it("fails closed when lineage parentRunId is missing or blank", () => {
    const resolution = readSubworkflowParentLineage(
      {
        [SUBWORKFLOW_ROUTE_KEY]: {
          lineage: {
            parentRunId: "  ",
            parentStepId: "delegate",
            ancestorDefinitionKeys: ["grandparent-workflow"]
          }
        }
      },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected refusal");
    expect(resolution.refusal).toBe("lineage_invalid");
  });

  it("fails closed when ancestorDefinitionKeys is not an array", () => {
    const resolution = readSubworkflowParentLineage(
      {
        [SUBWORKFLOW_ROUTE_KEY]: {
          lineage: {
            parentRunId: "run-grandparent",
            parentStepId: "delegate",
            ancestorDefinitionKeys: "grandparent-workflow"
          }
        }
      },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected refusal");
    expect(resolution.refusal).toBe("lineage_invalid");
  });

  it("fails closed when an ancestor definition key is blank or not a string", () => {
    const resolution = readSubworkflowParentLineage(
      {
        [SUBWORKFLOW_ROUTE_KEY]: {
          lineage: {
            parentRunId: "run-grandparent",
            parentStepId: "delegate",
            ancestorDefinitionKeys: ["grandparent-workflow", ""]
          }
        }
      },
      PARENT_DEF_KEY
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected refusal");
    expect(resolution.refusal).toBe("lineage_invalid");
  });
});

describe("deriveChildSubworkflowRunId", () => {
  it("derives a deterministic child run id from the parent run + step", () => {
    expect(deriveChildSubworkflowRunId(PARENT_RUN_ID, PARENT_STEP_ID)).toBe(
      `${PARENT_RUN_ID}::${PARENT_STEP_ID}::child`
    );
  });
});

describe("deriveChildSubworkflowRoute", () => {
  it("records the parent as the child's sole ancestor for a top-level parent", () => {
    const childRoute = deriveChildSubworkflowRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentDefinitionKey: PARENT_DEF_KEY,
      parentLineage: { definitionKey: PARENT_DEF_KEY, ancestorDefinitionKeys: [] },
      childDepth: 1
    });
    expect(childRoute).toEqual({
      [SUBWORKFLOW_ROUTE_KEY]: {
        lineage: {
          parentRunId: PARENT_RUN_ID,
          parentStepId: PARENT_STEP_ID,
          depth: 1,
          ancestorDefinitionKeys: [PARENT_DEF_KEY]
        }
      }
    });
  });

  it("appends the parent definition key onto an existing ancestry for a nested parent", () => {
    const childRoute = deriveChildSubworkflowRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentDefinitionKey: PARENT_DEF_KEY,
      parentLineage: {
        definitionKey: PARENT_DEF_KEY,
        ancestorDefinitionKeys: ["grandparent-workflow"]
      },
      childDepth: 2
    });
    const lineage = (
      childRoute[SUBWORKFLOW_ROUTE_KEY] as { lineage: SubworkflowRouteLineage }
    ).lineage;
    expect(lineage.depth).toBe(2);
    expect(lineage.ancestorDefinitionKeys).toEqual([
      "grandparent-workflow",
      PARENT_DEF_KEY
    ]);
  });

  it("round-trips: the derived child route reads back as the child's parent lineage", () => {
    const childRoute = deriveChildSubworkflowRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentDefinitionKey: PARENT_DEF_KEY,
      parentLineage: { definitionKey: PARENT_DEF_KEY, ancestorDefinitionKeys: [] },
      childDepth: 1
    });
    const readBack = readSubworkflowParentLineage(childRoute, CHILD_DEF_KEY);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error("expected ok");
    expect(readBack.lineage).toEqual<SubworkflowParentLineage>({
      definitionKey: CHILD_DEF_KEY,
      ancestorDefinitionKeys: [PARENT_DEF_KEY]
    });
  });
});

describe("planSubworkflowChildLaunchFromRoute — fail-closed refusals", () => {
  it("refuses missing child config", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: {},
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("missing_child_config");
    expect(plan.reason).toMatch(/manual recovery/i);
  });

  it("refuses an invalid child definition key", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild({
        childDefinitionKey: "   ",
        childDefinitionVersion: CHILD_DEF_VERSION
      }),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("child_definition_key_invalid");
  });

  it("refuses an invalid max depth", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild({
        childDefinitionKey: CHILD_DEF_KEY,
        childDefinitionVersion: CHILD_DEF_VERSION,
        maxDepth: 0
      }),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("max_depth_invalid");
  });

  it("refuses a missing child definition version", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild({ childDefinitionKey: CHILD_DEF_KEY }),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("child_definition_version_invalid");
  });

  it("refuses a corrupt lineage before planning the launch", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild(
        {
          childDefinitionKey: CHILD_DEF_KEY,
          childDefinitionVersion: CHILD_DEF_VERSION
        },
        { lineage: "corrupt" }
      ),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("lineage_invalid");
  });

  it("refuses a self-referencing child (child is the parent's own definition)", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild({
        childDefinitionKey: PARENT_DEF_KEY,
        childDefinitionVersion: CHILD_DEF_VERSION
      }),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("self_reference");
  });

  it("refuses a child that reappears in the parent's ancestry (cycle)", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild(
        {
          childDefinitionKey: CHILD_DEF_KEY,
          childDefinitionVersion: CHILD_DEF_VERSION,
          maxDepth: 5
        },
        {
          lineage: {
            parentRunId: "run-grandparent",
            parentStepId: "delegate",
            depth: 1,
            ancestorDefinitionKeys: [CHILD_DEF_KEY]
          }
        }
      ),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("ancestry_cycle");
  });

  it("refuses a child that would nest past the configured max depth", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      // Default maxDepth is 1, parent already nested one level deep => child depth 2.
      parentRoute: routeWithChild(
        {
          childDefinitionKey: CHILD_DEF_KEY,
          childDefinitionVersion: CHILD_DEF_VERSION
        },
        {
          lineage: {
            parentRunId: "run-grandparent",
            parentStepId: "delegate",
            depth: 1,
            ancestorDefinitionKeys: ["grandparent-workflow"]
          }
        }
      ),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("max_depth_exceeded");
  });
});

describe("planSubworkflowChildLaunchFromRoute — launchable child", () => {
  it("plans a launchable top-level child with a child run id and propagated lineage", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild({
        childDefinitionKey: CHILD_DEF_KEY,
        childDefinitionVersion: CHILD_DEF_VERSION
      }),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.childDefinitionKey).toBe(CHILD_DEF_KEY);
    expect(plan.childDefinitionVersion).toBe(CHILD_DEF_VERSION);
    expect(plan.childRunId).toBe(`${PARENT_RUN_ID}::${PARENT_STEP_ID}::child`);
    expect(plan.childDepth).toBe(1);
    expect(plan.maxDepth).toBe(1);
    const readBack = readSubworkflowParentLineage(plan.childRoute, CHILD_DEF_KEY);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error("expected ok");
    expect(readBack.lineage.ancestorDefinitionKeys).toEqual([PARENT_DEF_KEY]);
  });

  it("plans a launchable nested child when the configured max depth allows it", () => {
    const plan = planSubworkflowChildLaunchFromRoute({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      parentRoute: routeWithChild(
        {
          childDefinitionKey: CHILD_DEF_KEY,
          childDefinitionVersion: CHILD_DEF_VERSION,
          maxDepth: 2
        },
        {
          lineage: {
            parentRunId: "run-grandparent",
            parentStepId: "delegate",
            depth: 1,
            ancestorDefinitionKeys: ["grandparent-workflow"]
          }
        }
      ),
      parentDefinitionKey: PARENT_DEF_KEY
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.childDepth).toBe(2);
    expect(plan.maxDepth).toBe(2);
    const readBack = readSubworkflowParentLineage(plan.childRoute, CHILD_DEF_KEY);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error("expected ok");
    expect(readBack.lineage.ancestorDefinitionKeys).toEqual([
      "grandparent-workflow",
      PARENT_DEF_KEY
    ]);
  });
});
