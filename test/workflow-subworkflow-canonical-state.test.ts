import { describe, expect, it } from "vitest";

import {
  deriveChildSubworkflowRunId,
  planSubworkflowChildLaunchFromStep,
  readSubworkflowCanonicalLineage,
  type SubworkflowCanonicalLineage,
} from "../src/core/workflow/route/subworkflow.js";

/**
 * NGX-666 (NAM-03C) — pure canonical-state deciders for the `subworkflow`
 * executor.
 *
 * The owning step's `workflow_steps.executor_config_json` is the only active
 * source of subworkflow child intent, and the run's `workflow_run_lineage` row
 * is the only active source of parent / depth / ancestry facts. These tests pin
 * the pure composition the daemon-lane deriver forwards: validate the step-owned
 * `child` config, read the canonical lineage row (absent = top-level), apply the
 * existing recursion-safety planner, and derive the deterministic child id plus
 * the explicit child lineage the start-persistence seam inserts.
 */

const PARENT_RUN_ID = "run-parent-001";
const PARENT_STEP_ID = "launch-child";
const PARENT_DEFINITION_KEY = "parent-workflow";

const CHILD_CONFIG = {
  childDefinitionKey: "child-workflow",
  childDefinitionVersion: 1,
  maxDepth: 2,
};

function plan(overrides: {
  stepExecutorConfig?: Record<string, unknown>;
  parentLineage?: SubworkflowCanonicalLineage | null;
  parentDefinitionKey?: string;
}) {
  return planSubworkflowChildLaunchFromStep({
    parentRunId: PARENT_RUN_ID,
    parentStepId: PARENT_STEP_ID,
    parentDefinitionKey: overrides.parentDefinitionKey ?? PARENT_DEFINITION_KEY,
    stepExecutorConfig: overrides.stepExecutorConfig ?? {
      child: CHILD_CONFIG,
    },
    parentLineage: overrides.parentLineage ?? null,
  });
}

describe("planSubworkflowChildLaunchFromStep — step-owned canonical child intent", () => {
  it("plans a top-level launch: absent lineage means an empty ancestor list", () => {
    const result = plan({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.childDefinitionKey).toBe("child-workflow");
    expect(result.childDefinitionVersion).toBe(1);
    expect(result.childDepth).toBe(1);
    expect(result.maxDepth).toBe(2);
    expect(result.childRunId).toBe(
      deriveChildSubworkflowRunId(PARENT_RUN_ID, PARENT_STEP_ID),
    );
    expect(result.childLineage).toEqual({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      depth: 1,
      ancestorDefinitionKeys: [PARENT_DEFINITION_KEY],
    });
  });

  it("plans a nested launch from the canonical parent lineage row", () => {
    const result = plan({
      parentLineage: {
        parentRunId: "run-grandparent-001",
        parentStepId: "spawn",
        depth: 1,
        ancestorDefinitionKeys: ["root-workflow"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.childDepth).toBe(2);
    expect(result.childLineage).toEqual({
      parentRunId: PARENT_RUN_ID,
      parentStepId: PARENT_STEP_ID,
      depth: 2,
      ancestorDefinitionKeys: ["root-workflow", PARENT_DEFINITION_KEY],
    });
  });

  it("fails closed when the step config carries no child intent", () => {
    const result = plan({ stepExecutorConfig: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("missing_child_config");
  });

  it("fails closed on a malformed child intent", () => {
    const result = plan({
      stepExecutorConfig: { child: { childDefinitionKey: "  " } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("child_definition_key_invalid");
  });

  it("fails closed on self-reference", () => {
    const result = plan({
      stepExecutorConfig: {
        child: { ...CHILD_CONFIG, childDefinitionKey: PARENT_DEFINITION_KEY },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("self_reference");
  });

  it("fails closed on an ancestry cycle", () => {
    const result = plan({
      parentLineage: {
        parentRunId: "run-grandparent-001",
        parentStepId: "spawn",
        depth: 1,
        ancestorDefinitionKeys: ["child-workflow"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("ancestry_cycle");
  });

  it("fails closed past the configured maxDepth", () => {
    const result = plan({
      stepExecutorConfig: { child: { ...CHILD_CONFIG, maxDepth: 1 } },
      parentLineage: {
        parentRunId: "run-grandparent-001",
        parentStepId: "spawn",
        depth: 1,
        ancestorDefinitionKeys: ["root-workflow"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("max_depth_exceeded");
  });
});

describe("readSubworkflowCanonicalLineage — canonical lineage row validation", () => {
  const ROW = {
    parentRunId: "run-grandparent-001",
    parentStepId: "spawn",
    depth: 1,
    ancestorDefinitionKeysJson: JSON.stringify(["root-workflow"]),
  };

  it("reads a well-formed canonical lineage row", () => {
    const result = readSubworkflowCanonicalLineage(PARENT_RUN_ID, ROW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineage).toEqual({
      parentRunId: "run-grandparent-001",
      parentStepId: "spawn",
      depth: 1,
      ancestorDefinitionKeys: ["root-workflow"],
    });
  });

  it.each([
    ["blank parentRunId", { ...ROW, parentRunId: "  " }],
    ["blank parentStepId", { ...ROW, parentStepId: "" }],
    ["non-positive depth", { ...ROW, depth: 0 }],
    ["non-integer depth", { ...ROW, depth: 1.5 }],
    [
      "malformed ancestor JSON",
      { ...ROW, ancestorDefinitionKeysJson: "{not json" },
    ],
    [
      "non-array ancestors",
      { ...ROW, ancestorDefinitionKeysJson: JSON.stringify({}) },
    ],
    [
      "blank ancestor entries",
      { ...ROW, ancestorDefinitionKeysJson: JSON.stringify(["ok", "  "]) },
    ],
    ["depth / ancestry mismatch", { ...ROW, depth: 2 }],
    [
      "repeated ancestors",
      {
        ...ROW,
        depth: 2,
        ancestorDefinitionKeysJson: JSON.stringify(["a", "a"]),
      },
    ],
  ])("fails closed on a corrupt lineage row: %s", (_label, row) => {
    const result = readSubworkflowCanonicalLineage(PARENT_RUN_ID, row);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("lineage_invalid");
  });
});
