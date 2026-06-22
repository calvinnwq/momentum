import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M7 workflow substrate contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves M7 provenance and durable workflow ownership terms", () => {
    expect(spec).toContain("M7: NGX-312 through NGX-319");
    for (const term of ["WorkflowRun", "StepRun", "gates", "leases", "evidence", "recovery"]) {
      expect(spec).toContain(term);
    }
  });

  it("keeps OpenClaw compatibility boundary explicit", () => {
    expect(spec).toMatch(/OpenClaw remains the user-facing skill/i);
    expect(spec).toMatch(/Historical `cwfp-\*` runs remain readable\/importable/i);
  });

  it("keeps workflow commands documented for operators", () => {
    const docs = readDoc("docs/workflow-commands.md");
    expect(docs).toContain("workflow import");
    expect(docs).toContain("workflow status");
    expect(docs).toContain("workflow handoff");
  });
});
