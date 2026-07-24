import { describe, expect, it } from "vitest";

import {
  BUILT_IN_WORKFLOW_DEFINITIONS,
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_V1,
  CODING_WORKFLOW_DEFINITION_V2,
  CODING_WORKFLOW_DEFINITION_KEY,
  WORKFLOW_EXECUTORS,
  getBuiltInWorkflowDefinition,
  isWorkflowExecutor,
  listBuiltInWorkflowDefinitionKeys,
  selectBuiltInWorkflowDefinition,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { effectiveWorkflowDefinition } from "../src/core/workflow/definition/legacy.js";

function baseValidDefinition(): WorkflowDefinition {
  return {
    key: "sample-workflow",
    title: "Sample Workflow",
    version: 1,
    steps: [
      {
        key: "preflight",
        kind: "preflight",
        executor: "agent-once",
        order: 0,
        required: true,
      },
      {
        key: "implementation",
        kind: "implementation",
        executor: "agent-loop",
        order: 1,
        required: true,
      },
    ],
  };
}

describe("workflow executors", () => {
  it("enumerates the executor-loop contract executors", () => {
    expect([...WORKFLOW_EXECUTORS]).toEqual([
      "agent-loop",
      "agent-once",
      "delegate-supervisor",
      "script",
      "external-apply",
      "subworkflow",
    ]);
  });

  it("classifies known and unknown executors", () => {
    expect(isWorkflowExecutor("agent-loop")).toBe(true);
    expect(isWorkflowExecutor("agent-once")).toBe(true);
    expect(isWorkflowExecutor("delegate-supervisor")).toBe(true);
    expect(isWorkflowExecutor("subworkflow")).toBe(true);
    // Retired spellings and the legacy mirror identity live in
    // definition/legacy.ts, never in the canonical list.
    expect(isWorkflowExecutor("goal-loop")).toBe(false);
    expect(isWorkflowExecutor("one-shot")).toBe(false);
    expect(isWorkflowExecutor("no-mistakes")).toBe(false);
    expect(isWorkflowExecutor("not-an-executor")).toBe(false);
    expect(isWorkflowExecutor("")).toBe(false);
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
          "definition_not_object",
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
        "definition_key_invalid",
      );
    }
  });

  it("rejects a non-slug definition key", () => {
    const def = { ...baseValidDefinition(), key: "Not A Slug" };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_key_invalid",
      );
    }
  });

  it("rejects a missing or empty title", () => {
    const def = { ...baseValidDefinition(), title: "   " };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_title_invalid",
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
          "definition_version_invalid",
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
        "definition_steps_empty",
      );
    }
  });

  it("rejects a non-array steps field", () => {
    const def = { ...baseValidDefinition(), steps: {} };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "definition_steps_empty",
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

  it("requires explicit opt-in for retired step kinds", () => {
    const def = baseValidDefinition();
    def.steps[0]!.kind = "no-mistakes" as never;

    const rejected = validateWorkflowDefinition(def);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errors.map((e) => e.code)).toContain("step_kind_invalid");

    expect(
      validateWorkflowDefinition(def, { allowLegacyStepKinds: true }).ok,
    ).toBe(true);
  });

  it("accepts registered executor names and rejects malformed identities", () => {
    const def = baseValidDefinition();
    def.steps[0]!.executor = "third-party.executor";
    expect(validateWorkflowDefinition(def).ok).toBe(true);
    def.steps[0]!.executor = "NOT A VALID EXECUTOR";
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "step_executor_invalid",
      );
    }
  });

  it("accepts portable step config and rejects non-JSON config", () => {
    const configured = baseValidDefinition();
    configured.steps[1]!.config = { tool: "gnhf", options: ["durable"] };
    expect(validateWorkflowDefinition(configured).ok).toBe(true);

    const invalid = baseValidDefinition();
    invalid.steps[1]!.config = { tool: undefined };
    const result = validateWorkflowDefinition(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "step_config_invalid",
          path: "steps[1].config",
        }),
      );
    }
  });

  it("rejects config objects that cannot round-trip as JSON objects", () => {
    for (const config of [new Date("2026-01-01T00:00:00Z"), new Map()]) {
      const invalid = baseValidDefinition();
      invalid.steps[1]!.config = config as unknown as Record<string, unknown>;
      const result = validateWorkflowDefinition(invalid);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: "step_config_invalid",
            path: "steps[1].config",
          }),
        );
      }
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
        "step_order_duplicate",
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
        expect(result.errors.map((e) => e.code)).toContain(
          "step_order_invalid",
        );
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
        "step_required_invalid",
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
        order: step.order,
      })),
    ).toEqual([
      { kind: "preflight", executor: "agent-once", order: 0 },
      {
        kind: "implementation",
        executor: "delegate-supervisor",
        order: 1,
      },
      { kind: "postflight", executor: "agent-once", order: 2 },
      {
        kind: "validate",
        executor: "delegate-supervisor",
        order: 3,
      },
      { kind: "merge-cleanup", executor: "script", order: 4 },
      { kind: "tracker-refresh", executor: "external-apply", order: 5 },
    ]);
  });

  it("keeps delegated tools in step config instead of executor names", () => {
    expect(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => [step.key, step.config]),
    ).toEqual([
      ["preflight", undefined],
      ["implementation", { tool: "gnhf" }],
      ["postflight", undefined],
      // The external no-mistakes TOOL identity is unchanged by the rename.
      ["validate", { tool: "no-mistakes" }],
      ["merge-cleanup", { command: "merge-cleanup" }],
      ["tracker-refresh", undefined],
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

describe("retained built-in versions and the effective projection", () => {
  it("retains V1/V2 verbatim in the pre-rename vocabulary", () => {
    // Deliberate legacy assertions: recorded definition versions are frozen
    // byte-for-byte in the retired spellings.
    expect(
      CODING_WORKFLOW_DEFINITION_V1.steps.map((step) => [
        step.kind,
        step.executor,
      ]),
    ).toEqual([
      ["preflight", "one-shot"],
      ["implementation", "goal-loop"],
      ["postflight", "one-shot"],
      ["no-mistakes", "no-mistakes"],
      ["merge-cleanup", "script"],
      ["linear-refresh", "external-apply"],
    ]);
    expect(
      CODING_WORKFLOW_DEFINITION_V2.steps.map((step) => [
        step.kind,
        step.executor,
      ]),
    ).toEqual([
      ["preflight", "one-shot"],
      ["implementation", "delegate-supervisor"],
      ["postflight", "one-shot"],
      ["no-mistakes", "delegate-supervisor"],
      ["merge-cleanup", "script"],
      ["linear-refresh", "external-apply"],
    ]);
  });

  it("projects retained V1/V2 to effective canonical vocabulary without mutating the stored definitions", () => {
    const v1Frozen = JSON.stringify(CODING_WORKFLOW_DEFINITION_V1);
    const v2Frozen = JSON.stringify(CODING_WORKFLOW_DEFINITION_V2);

    const effectiveV1 = effectiveWorkflowDefinition(
      CODING_WORKFLOW_DEFINITION_V1,
    );
    expect(
      effectiveV1.steps.map((step) => [step.key, step.kind, step.executor]),
    ).toEqual([
      ["preflight", "preflight", "agent-once"],
      ["implementation", "implementation", "agent-loop"],
      ["postflight", "postflight", "agent-once"],
      // The legacy no-mistakes executor identity stays dispatchable as-is;
      // only the step kind projects to the canonical spelling.
      ["no-mistakes", "validate", "no-mistakes"],
      ["merge-cleanup", "merge-cleanup", "script"],
      ["linear-refresh", "tracker-refresh", "external-apply"],
    ]);

    const effectiveV2 = effectiveWorkflowDefinition(
      CODING_WORKFLOW_DEFINITION_V2,
    );
    expect(
      effectiveV2.steps.map((step) => [step.key, step.kind, step.executor]),
    ).toEqual([
      ["preflight", "preflight", "agent-once"],
      ["implementation", "implementation", "delegate-supervisor"],
      ["postflight", "postflight", "agent-once"],
      ["no-mistakes", "validate", "delegate-supervisor"],
      ["merge-cleanup", "merge-cleanup", "script"],
      ["linear-refresh", "tracker-refresh", "external-apply"],
    ]);

    // The stored definition rows stay byte-identical after projection.
    expect(JSON.stringify(CODING_WORKFLOW_DEFINITION_V1)).toBe(v1Frozen);
    expect(JSON.stringify(CODING_WORKFLOW_DEFINITION_V2)).toBe(v2Frozen);
  });

  it("returns the latest definition unchanged from the projection", () => {
    expect(effectiveWorkflowDefinition(CODING_WORKFLOW_DEFINITION)).toBe(
      CODING_WORKFLOW_DEFINITION,
    );
  });
});

describe("built-in workflow definition registry", () => {
  it("lists the coding-workflow definition", () => {
    expect(listBuiltInWorkflowDefinitionKeys()).toContain("coding-workflow");
    expect(BUILT_IN_WORKFLOW_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it("looks up a built-in definition by key", () => {
    expect(getBuiltInWorkflowDefinition("coding-workflow")).toEqual(
      CODING_WORKFLOW_DEFINITION,
    );
    expect(getBuiltInWorkflowDefinition("coding-workflow", 1)).toEqual(
      CODING_WORKFLOW_DEFINITION_V1,
    );
    expect(getBuiltInWorkflowDefinition("coding-workflow", 2)).toEqual(
      CODING_WORKFLOW_DEFINITION_V2,
    );
    expect(getBuiltInWorkflowDefinition("coding-workflow", 3)).toEqual(
      CODING_WORKFLOW_DEFINITION,
    );
    expect(getBuiltInWorkflowDefinition("missing")).toBeUndefined();
    expect(
      getBuiltInWorkflowDefinition("coding-workflow", 999),
    ).toBeUndefined();
  });

  it("can select an older built-in version when the latest version changes", () => {
    const v1: WorkflowDefinition = {
      ...CODING_WORKFLOW_DEFINITION,
      version: 1,
      steps: CODING_WORKFLOW_DEFINITION.steps.map((step) => ({ ...step })),
    };
    const v2: WorkflowDefinition = {
      ...CODING_WORKFLOW_DEFINITION,
      version: 2,
      steps: [
        {
          ...CODING_WORKFLOW_DEFINITION.steps[0]!,
          executor: "script",
        },
        ...CODING_WORKFLOW_DEFINITION.steps
          .slice(1)
          .map((step) => ({ ...step })),
      ],
    };

    expect(
      selectBuiltInWorkflowDefinition([v1, v2], "coding-workflow"),
    ).toEqual(v2);
    expect(
      selectBuiltInWorkflowDefinition([v1, v2], "coding-workflow", 1),
    ).toEqual(v1);
    expect(
      selectBuiltInWorkflowDefinition([v1, v2], "coding-workflow", 2),
    ).toEqual(v2);
    expect(
      selectBuiltInWorkflowDefinition([v1, v2], "coding-workflow", 3),
    ).toBeUndefined();
  });

  it("ships only definitions that pass validation", () => {
    for (const def of BUILT_IN_WORKFLOW_DEFINITIONS) {
      const result = validateWorkflowDefinition(def, {
        allowLegacyStepKinds: def.version < CODING_WORKFLOW_DEFINITION.version,
      });
      expect(result.ok, `built-in ${def.key} should validate`).toBe(true);
    }
  });
});
