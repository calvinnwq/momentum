import { describe, expect, it } from "vitest";

import {
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_V1,
  CODING_WORKFLOW_DEFINITION_V2,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import {
  MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
  materializeWorkflowCodingPlanPreview,
  type WorkflowRunStartInput,
} from "../src/core/workflow/run/start.js";

function baseInput(
  overrides: Partial<WorkflowRunStartInput> = {},
): WorkflowRunStartInput {
  return {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: "preview-1",
    repoPath: "/tmp/repo",
    objective: "Inspect the plan",
    now: 1_730_000_000_000,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    ...overrides,
  };
}

describe("materializeWorkflowCodingPlanPreview", () => {
  it("surfaces every built-in coding step with its executor and pending state", () => {
    const result = materializeWorkflowCodingPlanPreview(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.steps).toEqual([
      {
        stepId: "preflight",
        kind: "preflight",
        executor: "agent-once",
        order: 0,
        required: true,
        state: "pending",
      },
      {
        stepId: "implementation",
        kind: "implementation",
        executor: "delegate-supervisor",
        config: { tool: "gnhf" },
        order: 1,
        required: true,
        state: "pending",
      },
      {
        stepId: "postflight",
        kind: "postflight",
        executor: "agent-once",
        order: 2,
        required: true,
        state: "pending",
      },
      {
        stepId: "validate",
        kind: "validate",
        executor: "delegate-supervisor",
        config: { tool: "no-mistakes" },
        order: 3,
        required: true,
        state: "pending",
      },
      {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        executor: "script",
        config: { command: "merge-cleanup" },
        order: 4,
        required: true,
        state: "pending",
      },
      {
        stepId: "tracker-refresh",
        kind: "tracker-refresh",
        executor: "external-apply",
        order: 5,
        required: true,
        state: "pending",
      },
    ]);
  });

  it("captures run identity, definition pin, route, engine, and issue scope", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({
        issueScope: { identifier: "NGX-509" },
        route: {
          profile: "live-wrapper",
          implementationEngine: "native-goal-loop",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview).toMatchObject({
      runId: "preview-1",
      source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      state: "pending",
      repoPath: "/tmp/repo",
      objective: "Inspect the plan",
      approvalBoundary: null,
      definitionKey: "coding-workflow",
      definitionVersion: 3,
      issueScope: { identifier: "NGX-509" },
      route: {
        profile: "live-wrapper",
        implementationEngine: "native-goal-loop",
      },
      implementationEngine: "native-goal-loop",
      skillRevision: null,
    });
  });

  it("promotes approval-covered steps and opens approved with a boundary", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ approvalBoundary: "through-implementation" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.state).toBe("approved");
    expect(result.preview.approvalBoundary).toBe("through-implementation");
    const stateByStep = Object.fromEntries(
      result.preview.steps.map((step) => [step.stepId, step.state]),
    );
    expect(stateByStep).toMatchObject({
      preflight: "approved",
      implementation: "approved",
      postflight: "pending",
      validate: "pending",
    });
  });

  it("collects materialization errors for invalid input", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ objective: "   " }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain(
      "objective_invalid",
    );
  });

  it("joins executors for a custom multi-step definition", () => {
    const definition: WorkflowDefinition = {
      key: "coding-workflow",
      title: "Custom",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "agent-loop",
          order: 1,
          required: false,
        },
        {
          key: "preflight",
          kind: "preflight",
          executor: "agent-once",
          order: 0,
          required: true,
        },
      ],
    };
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ definition }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Steps are ordered by `order`, and each carries the definition executor.
    expect(
      result.preview.steps.map((step) => [step.stepId, step.executor]),
    ).toEqual([
      ["preflight", "agent-once"],
      ["implementation", "agent-loop"],
    ]);
  });

  it.each([
    [CODING_WORKFLOW_DEFINITION_V1, "agent-loop", "no-mistakes"],
    [
      CODING_WORKFLOW_DEFINITION_V2,
      "delegate-supervisor",
      "delegate-supervisor",
    ],
  ] as const)(
    "previews retained definition version $version through the effective projection",
    (definition, implementationExecutor, validateExecutor) => {
      // Deliberate legacy seeds: V1/V2 are frozen with retired executor values and
      // step-kind spellings; the preview projects executors and kinds to the
      // effective vocabulary while step ids keep the recorded step keys.
      const frozen = JSON.stringify(definition);
      const result = materializeWorkflowCodingPlanPreview(
        baseInput({ definition }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.preview.steps.map((step) => [
          step.stepId,
          step.kind,
          step.executor,
        ]),
      ).toEqual([
        ["preflight", "preflight", "agent-once"],
        ["implementation", "implementation", implementationExecutor],
        ["postflight", "postflight", "agent-once"],
        // The legacy no-mistakes executor identity stays dispatchable as-is.
        ["no-mistakes", "validate", validateExecutor],
        ["merge-cleanup", "merge-cleanup", "script"],
        ["linear-refresh", "tracker-refresh", "external-apply"],
      ]);
      expect(result.preview.definitionVersion).toBe(definition.version);
      // The stored definition stays byte-identical after the projection.
      expect(JSON.stringify(definition)).toBe(frozen);
    },
  );

  it("preserves retained executor identities claimed by the registry", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ definition: CODING_WORKFLOW_DEFINITION_V1 }),
      {
        isRegistered: (executor) =>
          executor === "goal-loop" || executor === "one-shot",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.preview.steps
        .filter(
          (step) =>
            step.stepId === "implementation" || step.stepId === "preflight",
        )
        .map((step) => [step.stepId, step.executor]),
    ).toEqual([
      ["preflight", "one-shot"],
      ["implementation", "goal-loop"],
    ]);
  });
});
