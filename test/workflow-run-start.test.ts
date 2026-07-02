import { describe, expect, it } from "vitest";

import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition
} from "../src/core/workflow/definition/definition.js";
import {
  WORKFLOW_RUN_START_ERROR_CODES,
  WORKFLOW_RUN_START_SOURCE,
  materializeWorkflowRunStart,
  type WorkflowRunStartInput
} from "../src/core/workflow/run/start.js";

const NOW = 1_700_000_000_000;

function twoStepDefinition(): WorkflowDefinition {
  return {
    key: "sample-workflow",
    title: "Sample Workflow",
    version: 3,
    steps: [
      {
        key: "implementation",
        kind: "implementation",
        executor: "goal-loop",
        order: 1,
        required: true
      },
      {
        key: "preflight",
        kind: "preflight",
        executor: "one-shot",
        order: 0,
        required: false
      }
    ]
  };
}

function baseInput(
  overrides: Partial<WorkflowRunStartInput> = {}
): WorkflowRunStartInput {
  return {
    definition: twoStepDefinition(),
    runId: "run-001",
    repoPath: "/repos/momentum",
    objective: "Implement NGX-346",
    now: NOW,
    ...overrides
  };
}

describe("materializeWorkflowRunStart", () => {
  it("materializes a run plus step graph from a validated definition", () => {
    const result = materializeWorkflowRunStart(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.run).toEqual({
      runId: "run-001",
      source: WORKFLOW_RUN_START_SOURCE,
      state: "pending",
      repoPath: "/repos/momentum",
      objective: "Implement NGX-346",
      issueScope: {},
      route: {},
      approvalBoundary: null,
      skillRevision: null,
      definitionKey: "sample-workflow",
      definitionVersion: 3,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: null
    });
  });

  it("orders materialized steps by definition order, not declaration order", () => {
    const result = materializeWorkflowRunStart(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.steps).toEqual([
      {
        stepId: "preflight",
        kind: "preflight",
        state: "pending",
        order: 0,
        required: false
      },
      {
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
        required: true
      }
    ]);
  });

  it("materializes every built-in coding workflow step", () => {
    const result = materializeWorkflowRunStart(
      baseInput({ definition: CODING_WORKFLOW_DEFINITION })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.steps.map((step) => step.kind)).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
      "linear-refresh"
    ]);
    expect(result.plan.run.definitionKey).toBe("coding-workflow");
  });

  it("promotes steps inside the approval boundary to approved", () => {
    const result = materializeWorkflowRunStart(
      baseInput({
        definition: CODING_WORKFLOW_DEFINITION,
        approvalBoundary: "implementation"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byKind = new Map(
      result.plan.steps.map((step) => [step.kind, step.state])
    );
    expect(byKind.get("preflight")).toBe("approved");
    expect(byKind.get("implementation")).toBe("approved");
    expect(byKind.get("postflight")).toBe("pending");
    expect(byKind.get("no-mistakes")).toBe("pending");
    expect(result.plan.run.state).toBe("approved");
    expect(result.plan.run.approvalBoundary).toBe("implementation");
  });

  it("opens approved when a supplied boundary covers no steps", () => {
    const result = materializeWorkflowRunStart(
      baseInput({
        definition: CODING_WORKFLOW_DEFINITION,
        approvalBoundary: "plan-only"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.steps.every((step) => step.state === "pending")).toBe(
      true
    );
    expect(result.plan.run.state).toBe("approved");
    expect(result.plan.run.approvalBoundary).toBe("plan-only");
  });

  it("keeps every step pending when no approval boundary is supplied", () => {
    const result = materializeWorkflowRunStart(
      baseInput({ definition: CODING_WORKFLOW_DEFINITION })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.every((step) => step.state === "pending")).toBe(
      true
    );
    expect(result.plan.run.state).toBe("pending");
  });

  it("honours supplied scope, route, source, and skill revision", () => {
    const result = materializeWorkflowRunStart(
      baseInput({
        issueScope: { issues: ["NGX-346"] },
        route: { channel: "discord" },
        source: "operator-cli",
        skillRevision: "abc123"
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.run.issueScope).toEqual({ issues: ["NGX-346"] });
    expect(result.plan.run.route).toEqual({ channel: "discord" });
    expect(result.plan.run.source).toBe("operator-cli");
    expect(result.plan.run.skillRevision).toBe("abc123");
  });

  it("is deterministic for identical input", () => {
    const a = materializeWorkflowRunStart(baseInput());
    const b = materializeWorkflowRunStart(baseInput());
    expect(a).toEqual(b);
  });

  it("exposes a stable refusal taxonomy", () => {
    expect([...WORKFLOW_RUN_START_ERROR_CODES]).toEqual([
      "definition_invalid",
      "run_id_invalid",
      "repo_path_invalid",
      "objective_invalid",
      "approval_boundary_invalid",
      "issue_scope_invalid",
      "route_invalid"
    ]);
  });

  it("refuses an invalid definition", () => {
    const result = materializeWorkflowRunStart(baseInput({ definition: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("definition_invalid");
  });

  it("refuses an unsafe run id", () => {
    const result = materializeWorkflowRunStart(baseInput({ runId: "../escape" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("run_id_invalid");
  });

  it("refuses blank repo path and objective", () => {
    const result = materializeWorkflowRunStart(
      baseInput({ repoPath: "   ", objective: "" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("repo_path_invalid");
    expect(codes).toContain("objective_invalid");
  });

  it("refuses an unknown approval boundary", () => {
    const result = materializeWorkflowRunStart(
      baseInput({ approvalBoundary: "not-a-boundary" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain(
      "approval_boundary_invalid"
    );
  });

  it("refuses non-object issue scope and route", () => {
    const result = materializeWorkflowRunStart(
      baseInput({
        issueScope: ["NGX-346"] as unknown as Record<string, unknown>,
        route: "discord" as unknown as Record<string, unknown>
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("issue_scope_invalid");
    expect(codes).toContain("route_invalid");
  });

  it("collects every refusal in one pass", () => {
    const result = materializeWorkflowRunStart({
      definition: {},
      runId: "",
      repoPath: "",
      objective: "",
      approvalBoundary: "bogus",
      now: NOW
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code).sort();
    expect(codes).toEqual(
      [
        "approval_boundary_invalid",
        "definition_invalid",
        "objective_invalid",
        "repo_path_invalid",
        "run_id_invalid"
      ].sort()
    );
  });
});
