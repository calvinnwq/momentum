import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M8 operator controls contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves M8 provenance and human-gate vocabulary", () => {
    expect(spec).toContain("M8: NGX-323 through NGX-330");
    for (const term of ["approval_required", "operator_decision_required", "manual_recovery_required"]) {
      expect(spec).toContain(term);
    }
  });

  it("keeps operator-control surfaces documented", () => {
    const workflowDocs = readDoc("docs/workflow-commands.md");
    for (const cmd of ["approve", "decide", "update-step", "clear-recovery", "monitor", "logs"]) {
      expect(workflowDocs).toContain(cmd);
    }
  });
});
