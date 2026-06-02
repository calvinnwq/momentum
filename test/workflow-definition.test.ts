import { describe, expect, it } from "vitest";

import {
  BUILT_IN_WORKFLOW_DEFINITIONS,
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_KEY,
  WORKFLOW_EXECUTOR_FAMILIES,
  getBuiltInWorkflowDefinition,
  isWorkflowExecutorFamily,
  listBuiltInWorkflowDefinitionKeys,
  validateWorkflowDefinition,
  type WorkflowDefinition
} from "../src/workflow-definition.js";

function baseValidDefinition(): WorkflowDefinition {
  return {
    key: "sample-workflow",
    title: "Sample Workflow",
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
}

describe("workflow executor families", () => {
  it("enumerates the executor-loop contract families", () => {
    expect([...WORKFLOW_EXECUTOR_FAMILIES]).toEqual([
      "goal-loop",
      "one-shot",
      "no-mistakes",
      "script",
      "external-apply",
      "subworkflow"
    ]);
  });

  it("classifies known and unknown executor families", () => {
    expect(isWorkflowExecutorFamily("goal-loop")).toBe(true);
    expect(isWorkflowExecutorFamily("no-mistakes")).toBe(true);
    expect(isWorkflowExecutorFamily("subworkflow")).toBe(true);
    expect(isWorkflowExecutorFamily("not-a-family")).toBe(false);
    expect(isWorkflowExecutorFamily("")).toBe(false);
  });
});

describe("validateWorkflowDefinition", () => {
  it("accepts a well-formed definition", () => {
    const result = validateWorkflowDefinition(baseValidDefinition());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition).toEqual(baseValidDefinition());
    }
  });

  it("rejects non-object definitions", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      const result = validateWorkflowDefinition(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((e) => e.code)).toContain(
          "definition_not_object"
        );
      }
    }
  });

  it("rejects an invalid definition key", () => {
    const def = { ...baseValidDefinition(), key: "" };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_key_invalid"
      );
    }
  });

  it("rejects a non-slug definition key", () => {
    const def = { ...baseValidDefinition(), key: "Not A Slug" };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_key_invalid"
      );
    }
  });

  it("rejects a missing or empty title", () => {
    const def = { ...baseValidDefinition(), title: "   " };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_title_invalid"
      );
    }
  });

  it("rejects a non-positive-integer version", () => {
    for (const version of [0, -1, 1.5, "1"]) {
      const def = { ...baseValidDefinition(), version };
      const result = validateWorkflowDefinition(def);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((e) => e.code)).toContain(
          "definition_version_invalid"
        );
      }
    }
  });

  it("rejects an empty steps array", () => {
    const def = { ...baseValidDefinition(), steps: [] };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_steps_empty"
      );
    }
  });

  it("rejects a non-array steps field", () => {
    const def = { ...baseValidDefinition(), steps: {} };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_steps_empty"
      );
    }
  });

  it("rejects a step that is not an object", () => {
    const def = baseValidDefinition();
    const steps: unknown[] = [...def.steps, "nope"];
    const result = validateWorkflowDefinition({ ...def, steps });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("step_not_object");
    }
  });

  it("rejects a step with an invalid kind", () => {
    const def = baseValidDefinition();
    def.steps[1]!.kind = "not-a-kind" as never;
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "step_kind_invalid");
      expect(err).toBeDefined();
      expect(err?.path).toBe("steps[1].kind");
    }
  });

  it("rejects a step with an unknown executor family", () => {
    const def = baseValidDefinition();
    def.steps[0]!.executor = "wildcard" as never;
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "step_executor_invalid"
      );
    }
  });

  it("rejects duplicate step keys", () => {
    const def = baseValidDefinition();
    def.steps[1]!.key = def.steps[0]!.key;
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("step_key_duplicate");
    }
  });

  it("rejects duplicate step orders", () => {
    const def = baseValidDefinition();
    def.steps[1]!.order = def.steps[0]!.order;
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "step_order_duplicate"
      );
    }
  });

  it("rejects a non-integer or negative step order", () => {
    for (const order of [-1, 1.5, "0"]) {
      const def = baseValidDefinition();
      (def.steps[0] as { order: unknown }).order = order;
      const result = validateWorkflowDefinition(def);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((e) => e.code)).toContain("step_order_invalid");
      }
    }
  });

  it("rejects a non-boolean required flag", () => {
    const def = baseValidDefinition();
    (def.steps[0] as { required: unknown }).required = "yes";
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "step_required_invalid"
      );
    }
  });

  it("rejects an invalid step key", () => {
    const def = baseValidDefinition();
    def.steps[0]!.key = "Bad Key";
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("step_key_invalid");
    }
  });
});

describe("built-in coding workflow definition", () => {
  it("is keyed 'coding-workflow'", () => {
    expect(CODING_WORKFLOW_DEFINITION_KEY).toBe("coding-workflow");
    expect(CODING_WORKFLOW_DEFINITION.key).toBe("coding-workflow");
  });

  it("encodes the canonical six coding-workflow steps in order", () => {
    expect(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => ({
        kind: step.kind,
        executor: step.executor,
        order: step.order
      }))
    ).toEqual([
      { kind: "preflight", executor: "one-shot", order: 0 },
      { kind: "implementation", executor: "goal-loop", order: 1 },
      { kind: "postflight", executor: "one-shot", order: 2 },
      { kind: "no-mistakes", executor: "no-mistakes", order: 3 },
      { kind: "merge-cleanup", executor: "script", order: 4 },
      { kind: "linear-refresh", executor: "external-apply", order: 5 }
    ]);
  });

  it("marks every canonical step required", () => {
    for (const step of CODING_WORKFLOW_DEFINITION.steps) {
      expect(step.required, `step ${step.key} should be required`).toBe(true);
    }
  });

  it("passes validation", () => {
    const result = validateWorkflowDefinition(CODING_WORKFLOW_DEFINITION);
    expect(result.ok).toBe(true);
  });
});

describe("built-in workflow definition registry", () => {
  it("lists the coding-workflow definition", () => {
    expect(listBuiltInWorkflowDefinitionKeys()).toContain("coding-workflow");
    expect(BUILT_IN_WORKFLOW_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it("looks up a built-in definition by key", () => {
    expect(getBuiltInWorkflowDefinition("coding-workflow")).toEqual(
      CODING_WORKFLOW_DEFINITION
    );
    expect(getBuiltInWorkflowDefinition("missing")).toBeUndefined();
  });

  it("ships only definitions that pass validation", () => {
    for (const def of BUILT_IN_WORKFLOW_DEFINITIONS) {
      const result = validateWorkflowDefinition(def);
      expect(result.ok, `built-in ${def.key} should validate`).toBe(true);
    }
  });
});
