import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_GATE_TYPES } from "../src/core/workflow/gate.js";
import { WORKFLOW_APPROVAL_BOUNDARIES } from "../src/core/workflow/run-reducer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M8 operator controls contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the compact M8 provenance anchor", () => {
    expect(spec).toContain("M8: NGX-323 through NGX-330");
  });

  it("pins operator gate and approval boundary vocabularies in code", () => {
    expect([...WORKFLOW_GATE_TYPES]).toContain("approval_required");
    expect([...WORKFLOW_GATE_TYPES]).toContain("operator_decision_required");
    expect([...WORKFLOW_GATE_TYPES]).toContain("manual_recovery_required");
    expect([...WORKFLOW_GATE_TYPES]).toContain("destructive_action_requested");
    expect([...WORKFLOW_APPROVAL_BOUNDARIES]).toContain("through-merge-cleanup");
    expect([...WORKFLOW_APPROVAL_BOUNDARIES]).toContain("full");
  });

  it("keeps operator-control surfaces documented", () => {
    const workflowDocs = readDoc("docs/workflow-commands.md");
    for (const cmd of ["approve", "decide", "update-step", "clear-recovery", "monitor", "logs"]) {
      expect(workflowDocs).toContain(cmd);
    }
  });

  it("keeps native monitor delivery cleanup semantics documented", () => {
    const workflowDocs = readDoc("docs/workflow-commands.md");
    expect(workflowDocs).toContain("Monitor delivery wrappers");
    expect(workflowDocs).toContain("progress.emit");
    expect(workflowDocs).toContain("recoverable terminal failures");
    expect(workflowDocs).toContain("source\n`momentum-native-coding`");
    expect(workflowDocs).toContain("mwf-*");
    expect(workflowDocs).toContain("operator convention");
  });
});
