import { describe, expect, it } from "vitest";

import {
  CODING_WORKFLOW_DEFINITION,
  WORKFLOW_EXECUTORS,
  listBuiltInWorkflowDefinitionKeys,
} from "../src/core/workflow/definition/definition.js";
import { readRepoFile, expectSpecSection } from "./helpers/repo-docs.js";

describe("workflow-first runtime contract", () => {
  const spec = readRepoFile("SPEC.md");

  it("keeps a compact runtime-model anchor in SPEC.md", () => {
    expectSpecSection(spec, "Runtime Model");
    expectSpecSection(spec, "Workflow Safety");
    expect(spec).toMatch(/\bworkflow-first runtime\b/i);
  });

  it("pins the executors from runtime constants", () => {
    expect([...WORKFLOW_EXECUTORS]).toEqual([
      "agent-loop",
      "agent-once",
      "delegate-supervisor",
      "script",
      "external-apply",
      "subworkflow",
    ]);
  });

  it("keeps coding-workflow registered as a workflow definition", () => {
    expect(listBuiltInWorkflowDefinitionKeys()).toContain("coding-workflow");
    expect(CODING_WORKFLOW_DEFINITION.steps.map((step) => step.key)).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "validate",
      "merge-cleanup",
      "tracker-refresh",
    ]);
    expect(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => step.executor),
    ).toEqual([
      "agent-once",
      "delegate-supervisor",
      "agent-once",
      "delegate-supervisor",
      "script",
      "external-apply",
    ]);
  });

  it("keeps public docs free of workflow-first planning vocabulary", () => {
    expect(readRepoFile("README.md")).not.toMatch(
      /\bM10\b|Workflow-First Runtime/,
    );
    expect(readRepoFile("docs/index.html")).not.toMatch(
      /\bM10\b|Workflow-First Runtime/,
    );
  });
});
