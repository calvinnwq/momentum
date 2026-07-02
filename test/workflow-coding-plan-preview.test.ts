import { describe, expect, it } from "vitest";

import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition
} from "../src/core/workflow/definition/definition.js";
import {
  MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
  materializeWorkflowCodingPlanPreview,
  type WorkflowRunStartInput
} from "../src/core/workflow/run/start.js";

function baseInput(
  overrides: Partial<WorkflowRunStartInput> = {}
): WorkflowRunStartInput {
  return {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: "preview-1",
    repoPath: "/tmp/repo",
    objective: "Inspect the plan",
    now: 1_730_000_000_000,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    ...overrides
  };
}

describe("materializeWorkflowCodingPlanPreview", () => {
  it("surfaces every built-in coding step with its executor family and pending state", () => {
    const result = materializeWorkflowCodingPlanPreview(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.steps).toEqual([
      {
        stepId: "preflight",
        kind: "preflight",
        executor: "one-shot",
        order: 0,
        required: true,
        state: "pending"
      },
      {
        stepId: "implementation",
        kind: "implementation",
        executor: "goal-loop",
        order: 1,
        required: true,
        state: "pending"
      },
      {
        stepId: "postflight",
        kind: "postflight",
        executor: "one-shot",
        order: 2,
        required: true,
        state: "pending"
      },
      {
        stepId: "no-mistakes",
        kind: "no-mistakes",
        executor: "no-mistakes",
        order: 3,
        required: true,
        state: "pending"
      },
      {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        executor: "script",
        order: 4,
        required: true,
        state: "pending"
      },
      {
        stepId: "linear-refresh",
        kind: "linear-refresh",
        executor: "external-apply",
        order: 5,
        required: true,
        state: "pending"
      }
    ]);
  });

  it("captures run identity, definition pin, route, and issue scope", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({
        issueScope: { identifier: "NGX-509" },
        route: { profile: "live-wrapper" }
      })
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
      definitionVersion: 1,
      issueScope: { identifier: "NGX-509" },
      route: { profile: "live-wrapper" },
      skillRevision: null
    });
  });

  it("promotes approval-covered steps and opens approved with a boundary", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ approvalBoundary: "through-implementation" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.state).toBe("approved");
    expect(result.preview.approvalBoundary).toBe("through-implementation");
    const stateByStep = Object.fromEntries(
      result.preview.steps.map((step) => [step.stepId, step.state])
    );
    expect(stateByStep).toMatchObject({
      preflight: "approved",
      implementation: "approved",
      postflight: "pending",
      "no-mistakes": "pending"
    });
  });

  it("collects materialization errors for invalid input", () => {
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ objective: "   " })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain(
      "objective_invalid"
    );
  });

  it("joins executor families for a custom multi-step definition", () => {
    const definition: WorkflowDefinition = {
      key: "coding-workflow",
      title: "Custom",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 1,
          required: false
        },
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true
        }
      ]
    };
    const result = materializeWorkflowCodingPlanPreview(
      baseInput({ definition })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Steps are ordered by `order`, and each carries the definition executor.
    expect(
      result.preview.steps.map((step) => [step.stepId, step.executor])
    ).toEqual([
      ["preflight", "one-shot"],
      ["implementation", "goal-loop"]
    ]);
  });
});
