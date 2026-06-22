import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M5 provenance anchor", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the M5 issue range and source-adapter boundary", () => {
    expect(spec).toContain("M5: NGX-287 through NGX-294");
    expect(spec).toMatch(/Source adapters are read-only/i);
    expect(spec).toMatch(/local update intents/i);
  });

  it("keeps source adapter planning detail out of public docs", () => {
    expect(readDoc("README.md")).not.toContain("Milestone 5");
    expect(readDoc("README.md")).not.toContain("NGX-287");
    expect(readDoc("docs/index.md")).not.toMatch(/source-adapters/i);
  });

  it("keeps current source commands documented for operators", () => {
    const docs = readDoc("docs/source-commands.md");
    expect(docs).toContain("source list");
    expect(docs).toContain("source reconcile");
  });
});
