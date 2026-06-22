import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("workflow-first runtime contract", () => {
  const spec = readDoc("SPEC.md");

  it("records the workflow-first product model", () => {
    for (const term of [
      "WorkflowDefinition",
      "StepDefinition",
      "WorkflowRun",
      "StepRun",
      "ExecutorInvocation",
      "ExecutorRound",
      "Goal",
      "goal-loop",
    ]) {
      expect(spec, `SPEC.md should define ${term}`).toContain(term);
    }

    expect(spec).toMatch(/workflow-first runtime/i);
  });

  it("pins the executor families", () => {
    for (const family of [
      "goal-loop",
      "one-shot",
      "script",
      "no-mistakes",
      "external-apply",
      "subworkflow",
    ]) {
      expect(spec, `SPEC.md should name ${family}`).toContain(family);
    }
  });

  it("keeps public docs free of workflow-first planning vocabulary", () => {
    expect(readDoc("README.md")).not.toMatch(/\bM10\b|Workflow-First Runtime/);
    expect(readDoc("docs/index.md")).not.toMatch(/\bM10\b|Workflow-First Runtime/);
  });
});
