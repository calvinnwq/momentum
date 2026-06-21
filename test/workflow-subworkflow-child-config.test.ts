import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBWORKFLOW_MAX_DEPTH,
  planSubworkflowChildLaunch,
  validateSubworkflowChildConfig,
  type SubworkflowChildDefinitionConfig,
  type SubworkflowParentLineage
} from "../src/core/workflow/subworkflow-child-config.js";

/**
 * NGX-498 (RC-4b) — the keystone "open decision" the production `subworkflow`
 * flip was deferred on: the child-definition config shape a production
 * `subworkflow` step carries, and the pure recursion / self-reference safety
 * decider that decides whether starting that child is safe given the parent
 * run's subworkflow lineage.
 *
 * Both halves are pure and total (no SQLite, no file system, no clock), the same
 * discipline `planSubworkflowChildMirror` (RC-4) and `planWorkflowStepDispatch`
 * follow, so the fail-closed contract for missing child config and unsafe
 * recursion is exhaustively testable on its own — before any production allowlist
 * flip or daemon wiring lands. This slice does NOT add `subworkflow` to
 * `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`; production `subworkflow` stays
 * fail-closed.
 *
 * These tests pin:
 *   - validation: a well-formed config resolves a concrete `maxDepth` (defaulting
 *     conservatively); absent / non-object / malformed config fails closed with a
 *     typed refusal (the "missing child config" fail-closed case);
 *   - launch safety: a distinct child within the depth bound is launchable; a
 *     self-reference, an ancestry cycle, or a child that would exceed the bound
 *     fails closed (the "unsafe recursion" fail-closed case).
 */

describe("validateSubworkflowChildConfig — child-definition config shape", () => {
  it("accepts a minimal config and defaults maxDepth conservatively", () => {
    const result = validateSubworkflowChildConfig({
      childDefinitionKey: "coding-workflow"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok config");
    expect(result.config.childDefinitionKey).toBe("coding-workflow");
    expect(result.config.maxDepth).toBe(DEFAULT_SUBWORKFLOW_MAX_DEPTH);
  });

  it("preserves an explicit positive-integer maxDepth", () => {
    const result = validateSubworkflowChildConfig({
      childDefinitionKey: "coding-workflow",
      maxDepth: 3
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok config");
    expect(result.config.maxDepth).toBe(3);
  });

  it("fails closed with missing_child_config for undefined", () => {
    const result = validateSubworkflowChildConfig(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("missing_child_config");
  });

  it("fails closed with missing_child_config for null", () => {
    const result = validateSubworkflowChildConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("missing_child_config");
  });

  it("fails closed with missing_child_config for a non-object", () => {
    const result = validateSubworkflowChildConfig("coding-workflow");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("missing_child_config");
  });

  it("fails closed with child_definition_key_invalid for an empty key", () => {
    const result = validateSubworkflowChildConfig({ childDefinitionKey: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("child_definition_key_invalid");
  });

  it("fails closed with child_definition_key_invalid for a non-string key", () => {
    const result = validateSubworkflowChildConfig({ childDefinitionKey: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("child_definition_key_invalid");
  });

  it("fails closed with max_depth_invalid for a non-positive maxDepth", () => {
    const result = validateSubworkflowChildConfig({
      childDefinitionKey: "coding-workflow",
      maxDepth: 0
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("max_depth_invalid");
  });

  it("fails closed with max_depth_invalid for a non-integer maxDepth", () => {
    const result = validateSubworkflowChildConfig({
      childDefinitionKey: "coding-workflow",
      maxDepth: 2.5
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("max_depth_invalid");
  });
});

describe("planSubworkflowChildLaunch — recursion / self-reference safety", () => {
  const config: SubworkflowChildDefinitionConfig = {
    childDefinitionKey: "child-workflow",
    maxDepth: DEFAULT_SUBWORKFLOW_MAX_DEPTH
  };

  it("launches a distinct child from a top-level parent at depth 1", () => {
    const lineage: SubworkflowParentLineage = {
      definitionKey: "coding-workflow",
      ancestorDefinitionKeys: []
    };
    const plan = planSubworkflowChildLaunch(config, lineage);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected launchable plan");
    expect(plan.childDefinitionKey).toBe("child-workflow");
    expect(plan.childDepth).toBe(1);
    expect(plan.maxDepth).toBe(DEFAULT_SUBWORKFLOW_MAX_DEPTH);
  });

  it("fails closed with self_reference when the child is the parent's own definition", () => {
    const lineage: SubworkflowParentLineage = {
      definitionKey: "child-workflow",
      ancestorDefinitionKeys: []
    };
    const plan = planSubworkflowChildLaunch(config, lineage);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("self_reference");
    expect(plan.reason).toContain("child-workflow");
  });

  it("fails closed with ancestry_cycle when the child appears among ancestors", () => {
    const lineage: SubworkflowParentLineage = {
      definitionKey: "middle-workflow",
      ancestorDefinitionKeys: ["child-workflow"]
    };
    const plan = planSubworkflowChildLaunch(
      { childDefinitionKey: "child-workflow", maxDepth: 5 },
      lineage
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("ancestry_cycle");
    expect(plan.reason).toContain("child-workflow");
  });

  it("fails closed with max_depth_exceeded when the child would nest too deep", () => {
    const lineage: SubworkflowParentLineage = {
      definitionKey: "middle-workflow",
      ancestorDefinitionKeys: ["root-workflow"]
    };
    // Parent already has one ancestor, so the child would be at depth 2 > 1.
    const plan = planSubworkflowChildLaunch(config, lineage);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("expected refusal");
    expect(plan.refusal).toBe("max_depth_exceeded");
    expect(plan.reason).toContain("2");
  });

  it("launches a nested child when maxDepth permits the deeper nesting", () => {
    const lineage: SubworkflowParentLineage = {
      definitionKey: "middle-workflow",
      ancestorDefinitionKeys: ["root-workflow"]
    };
    const plan = planSubworkflowChildLaunch(
      { childDefinitionKey: "child-workflow", maxDepth: 2 },
      lineage
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected launchable plan");
    expect(plan.childDepth).toBe(2);
  });
});
