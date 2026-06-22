import { describe, expect, it } from "vitest";

import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition.js";
import {
  WORKFLOW_APPROVAL_BOUNDARIES,
  workflowStepKindsForApprovalBoundary
} from "../src/core/workflow/run-reducer.js";
import { expectSpecSection, readRepoFile } from "./helpers/repo-docs.js";

describe("Momentum-owned coding workflow contract", () => {
  const spec = readRepoFile("SPEC.md");

  it("keeps a compact coding-workflow ownership anchor", () => {
    expectSpecSection(spec, "Coding Workflow Ownership");
    expect(spec).toContain("cwfp-*");
    expect(spec).toContain("NGX-404");
  });

  it("anchors the explicit Momentum-native coding-workflow start door", () => {
    expect(spec).toContain("workflow run start-coding");
    expect(spec).toContain("momentum-native-coding");
  });

  it("pins the built-in coding workflow steps and executor ownership", () => {
    expect(CODING_WORKFLOW_DEFINITION.key).toBe("coding-workflow");
    expect(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => ({
        key: step.key,
        kind: step.kind,
        executor: step.executor,
      }))
    ).toEqual([
      { key: "preflight", kind: "preflight", executor: "one-shot" },
      { key: "implementation", kind: "implementation", executor: "goal-loop" },
      { key: "postflight", kind: "postflight", executor: "one-shot" },
      { key: "no-mistakes", kind: "no-mistakes", executor: "no-mistakes" },
      { key: "merge-cleanup", kind: "merge-cleanup", executor: "script" },
      { key: "linear-refresh", kind: "linear-refresh", executor: "external-apply" },
    ]);
  });

  it("keeps approval boundaries mapped to concrete workflow steps", () => {
    expect([...WORKFLOW_APPROVAL_BOUNDARIES]).toEqual([
      "implementation",
      "through-implementation",
      "no-mistakes",
      "through-no-mistakes",
      "merge-cleanup",
      "through-merge-cleanup",
      "full",
      "plan-only",
      "overnight-safe",
      "through-postflight",
      "through-merge-gates",
      "final-cleanup",
      "full-batch",
    ]);
    expect(workflowStepKindsForApprovalBoundary("plan-only")).toEqual([]);
    expect(workflowStepKindsForApprovalBoundary("through-postflight")).toEqual([
      "preflight",
      "implementation",
      "postflight",
    ]);
    expect(workflowStepKindsForApprovalBoundary("no-mistakes")).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
    ]);
    expect(workflowStepKindsForApprovalBoundary("through-merge-cleanup")).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
    ]);
    expect(workflowStepKindsForApprovalBoundary("full")).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
      "linear-refresh",
    ]);
  });

  it("keeps the contract anchor discoverable from AGENTS.md", () => {
    const agents = readRepoFile("AGENTS.md");
    expect(agents).toContain("SPEC.md");
    expect(agents).toMatch(/coding-workflow ownership/i);
  });
});
