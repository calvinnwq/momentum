import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("workflow-first gap matrix anchor", () => {
  const spec = readDoc("SPEC.md");

  it("states the model shift without preserving the old matrix prose in repo", () => {
    expect(spec).toMatch(/Goal` remains a compatibility surface/i);
    expect(spec).toMatch(/workflow-first runtime/i);
    expect(spec).toContain("WorkflowDefinition");
    expect(spec).toContain("workflow runs");
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("pins phase-1 dispatch families and fail-closed posture", () => {
    for (const family of [
      "goal-loop",
      "one-shot",
      "script",
      "no-mistakes",
      "external-apply",
      "subworkflow",
    ]) {
      expect(spec, `SPEC.md should name dispatch family ${family}`).toContain(family);
    }

    expect(spec).toMatch(/must fail closed/i);
  });

  it("keeps M10 issue provenance in the compact milestone anchor", () => {
    for (const id of ["NGX-344", "NGX-345", "NGX-346", "NGX-347", "NGX-348", "NGX-349", "NGX-350", "NGX-351", "NGX-352", "NGX-367", "NGX-353"]) {
      expect(spec, `SPEC.md should preserve ${id}`).toContain(id);
    }
  });
});
