import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

const M10_LINEAR_IDS = [
  "NGX-344",
  "NGX-345",
  "NGX-346",
  "NGX-347",
  "NGX-348",
  "NGX-349",
  "NGX-350",
  "NGX-351",
  "NGX-352",
  "NGX-367",
  "NGX-353",
] as const;

describe("M10 workflow-first runtime provenance", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the M10 issue range and workflow-first product shape", () => {
    for (const issueId of M10_LINEAR_IDS) {
      expect(spec, `SPEC.md should preserve ${issueId}`).toContain(issueId);
    }

    for (const term of [
      "WorkflowDefinition",
      "WorkflowRun",
      "StepDefinition",
      "StepRun",
      "ExecutorInvocation",
      "ExecutorRound",
      "goal-loop",
    ]) {
      expect(spec, `SPEC.md should name ${term}`).toContain(term);
    }
  });

  it("preserves current M10 follow-up state without keeping old internal prose", () => {
    for (const family of ["external-apply", "subworkflow"]) {
      expect(spec).toContain(family);
    }
    expect(spec).toMatch(/RC-3/);
    expect(spec).toMatch(/RC-4b/);
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("keeps public docs free of internal M10 planning vocabulary", () => {
    expect(readDoc("README.md")).not.toMatch(/\bM10\b|Workflow-First Runtime/);
    expect(readDoc("docs/index.md")).not.toMatch(/m10-workflow-first-runtime|workflow-first-gap-matrix/);
  });
});
