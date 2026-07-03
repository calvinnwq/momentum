import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M3 provenance anchor", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the M3 issue range without keeping the old internal narrative", () => {
    expect(spec).toContain("M3: NGX-272 through NGX-278");
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("keeps M3 planning detail out of public docs", () => {
    const readme = readDoc("README.md");
    expect(readme).not.toContain("Milestone 3");
    expect(readme).not.toContain("NGX-272");
    expect(readDoc("docs/index.html")).not.toMatch(/m3-operational-safety/i);
  });

  it("preserves the operational CLI surface", () => {
    const readme = readDoc("README.md");
    for (const cmd of ["momentum daemon start", "stop", "status", "momentum recovery clear", "momentum doctor"]) {
      expect(readme).toContain(cmd);
    }
  });
});
