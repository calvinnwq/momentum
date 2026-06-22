import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M4 provenance anchor", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the M4 issue range without keeping the old internal narrative", () => {
    expect(spec).toContain("M4: NGX-279 through NGX-286");
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("keeps runner profile milestone detail out of public docs", () => {
    expect(readDoc("README.md")).not.toContain("Milestone 4");
    expect(readDoc("README.md")).not.toContain("NGX-279");
    expect(readDoc("docs/index.md")).not.toMatch(/m4-real-runners/i);
  });

  it("keeps current runner docs as operator-facing truth", () => {
    const runners = readDoc("docs/runners.md");
    expect(runners).toContain("fake");
    expect(runners).toContain("trusted-shell");
    expect(runners).toContain("acp");
  });
});
