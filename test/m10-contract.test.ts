import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_EXECUTOR_FAMILIES } from "../src/core/workflow/definition/definition.js";
import { WORKFLOW_RUN_STATES, WORKFLOW_STEP_STATES } from "../src/core/workflow/run/reducer.js";

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

  it("preserves the compact M10 issue-range anchor", () => {
    for (const issueId of M10_LINEAR_IDS) {
      expect(spec, `SPEC.md should preserve ${issueId}`).toContain(issueId);
    }
  });

  it("pins workflow-first product shape in runtime constants", () => {
    expect([...WORKFLOW_EXECUTOR_FAMILIES]).toEqual([
      "goal-loop",
      "one-shot",
      "no-mistakes",
      "script",
      "external-apply",
      "subworkflow",
    ]);
    expect([...WORKFLOW_RUN_STATES]).toContain("running");
    expect([...WORKFLOW_STEP_STATES]).toContain("approved");
  });

  it("keeps old internal prose out of the repo", () => {
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("keeps public docs free of internal M10 planning vocabulary", () => {
    expect(readDoc("README.md")).not.toMatch(/\bM10\b|Workflow-First Runtime/);
    expect(readDoc("docs/index.html")).not.toMatch(/m10-workflow-first-runtime|workflow-first-gap-matrix/);
  });
});
