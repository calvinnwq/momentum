import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_EXECUTOR_FAMILIES } from "../src/core/workflow/definition/definition.js";
import { PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES } from "../src/core/workflow/dispatch/dispatch.js";
import { expectSpecSection } from "./helpers/repo-docs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("workflow-first gap matrix anchor", () => {
  const spec = readDoc("SPEC.md");

  it("keeps compact workflow-first and runtime consolidation anchors", () => {
    expectSpecSection(spec, "Runtime Model");
    expectSpecSection(spec, "Runtime Consolidation");
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("pins phase-1 dispatch families in code", () => {
    expect([...WORKFLOW_EXECUTOR_FAMILIES]).toEqual([
      "goal-loop",
      "one-shot",
      "no-mistakes",
      "delegate-supervisor",
      "script",
      "external-apply",
      "subworkflow",
    ]);
    expect([...PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES]).toEqual([
      "goal-loop",
      "one-shot",
      "script",
      "no-mistakes",
      "delegate-supervisor",
      "external-apply",
      "subworkflow",
    ]);
  });
});
