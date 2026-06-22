import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("Momentum-owned coding workflow contract", () => {
  const spec = readDoc("SPEC.md");

  it("pins Momentum as the source of truth for future coding workflow runtime state", () => {
    for (const term of [
      "workflow definitions",
      "workflow runs",
      "step runs",
      "gates",
      "leases",
      "executor state",
      "evidence",
      "recovery",
    ]) {
      expect(spec, `SPEC.md should name ${term}`).toContain(term);
    }

    expect(spec).toMatch(/Momentum owns the future durable coding workflow runtime/i);
  });

  it("keeps OpenClaw as compatibility and fallback layer", () => {
    expect(spec).toMatch(/OpenClaw remains the user-facing skill/i);
    expect(spec).toMatch(/compatibility surface/i);
    expect(spec).toMatch(/fallback route/i);
    expect(spec).toMatch(/Historical `cwfp-\*` runs remain readable\/importable/i);
  });

  it("records dogfood proof without treating it as an automatic default switch", () => {
    expect(spec).toContain("NGX-499");
    expect(spec).toContain("NGX-404");
    expect(spec).toMatch(/default switching remains separate/i);
    expect(spec).toMatch(/must preserve rollback/i);
  });

  it("keeps the contract anchor discoverable from AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");
    expect(agents).toContain("SPEC.md");
    expect(agents).toMatch(/coding-workflow ownership/i);
  });
});
