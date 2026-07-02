import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_LEASE_KINDS,
  WORKFLOW_RUN_STATES,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_STEP_STATES
} from "../src/core/workflow/run/reducer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M7 workflow substrate contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the compact M7 provenance anchor", () => {
    expect(spec).toContain("M7: NGX-312 through NGX-319");
  });

  it("pins workflow substrate vocabulary in runtime constants", () => {
    expect([...WORKFLOW_STEP_KINDS]).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
      "linear-refresh",
    ]);
    expect([...WORKFLOW_STEP_STATES]).toEqual([
      "pending",
      "approved",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "blocked",
      "canceled",
    ]);
    expect([...WORKFLOW_RUN_STATES]).toEqual([
      "pending",
      "approved",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "canceled",
    ]);
    expect([...WORKFLOW_LEASE_KINDS]).toEqual(["monitor", "managed-step", "dispatch"]);
  });

  it("keeps workflow commands documented for operators", () => {
    const docs = readDoc("docs/workflow-commands.md");
    expect(docs).toContain("workflow import");
    expect(docs).toContain("workflow status");
    expect(docs).toContain("workflow handoff");
  });
});
