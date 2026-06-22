import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M6 external-apply contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves M6 provenance and two-phase external-apply invariants", () => {
    expect(spec).toContain("M6: NGX-295 through NGX-302");
    for (const phrase of ["claim one pending update intent", "audit before write", "idempotency marker", "fail closed"]) {
      expect(spec, `SPEC.md should mention ${phrase}`).toContain(phrase);
    }
  });

  it("keeps external-apply documented as an operator-facing command", () => {
    const intentDocs = readDoc("docs/intent-commands.md");
    expect(intentDocs).toContain("--external-apply");
    expect(intentDocs).toContain("applyPolicy");
    expect(intentDocs).toContain("externalApply");
  });

  it("keeps internal M6 planning detail out of public docs", () => {
    expect(readDoc("README.md")).not.toContain("Milestone 6");
    expect(readDoc("README.md")).not.toContain("NGX-295");
    expect(readDoc("docs/index.md")).not.toMatch(/m6-external-apply/i);
  });
});
