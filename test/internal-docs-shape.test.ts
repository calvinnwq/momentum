import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

const REQUIRED_FILES = [
  "internal/roadmap.md",
  "internal/exclusions.md",
  "internal/smoke-tests.md",
  "internal/milestones/m3-operational-safety.md",
  "internal/milestones/m4-real-runners.md",
  "internal/milestones/m5-source-adapters.md",
  "internal/milestones/m6-external-apply.md",
  "internal/contracts/intent-apply.md",
  "internal/contracts/source-adapters.md",
] as const;

describe("internal planning docs shape", () => {
  for (const rel of REQUIRED_FILES) {
    it(`${rel} exists and is non-empty`, () => {
      const p = path.join(repoRoot, rel);
      expect(fs.existsSync(p), `${rel} should exist after the public-docs cleanup`).toBe(true);
      const body = fs.readFileSync(p, "utf8");
      expect(body.trim().length, `${rel} should not be empty`).toBeGreaterThan(0);
    });
  }

  it("internal/roadmap.md still names the M3..M6 milestones", () => {
    const roadmap = readDoc("internal/roadmap.md");
    for (const tag of ["Milestone 3", "Milestone 4", "Milestone 5", "Milestone 6"]) {
      expect(roadmap, `internal/roadmap.md should still reference ${tag}`).toContain(tag);
    }
  });

  it("internal/milestones/m6-external-apply.md still lists the planned M6 NGX order", () => {
    const m6 = readDoc("internal/milestones/m6-external-apply.md");
    for (const id of [
      "NGX-295",
      "NGX-296",
      "NGX-297",
      "NGX-298",
      "NGX-299",
      "NGX-300",
      "NGX-301",
      "NGX-302",
    ]) {
      expect(m6, `internal/milestones/m6-external-apply.md should still reference ${id}`).toContain(id);
    }
  });

  it("internal/contracts/intent-apply.md still names the two-phase external apply invariants", () => {
    const contract = readDoc("internal/contracts/intent-apply.md");
    for (const phrase of [
      "two-phase",
      "intent_apply_in_progress",
      "idempotency",
      "api.linear.app",
    ]) {
      expect(contract, `internal/contracts/intent-apply.md should mention ${phrase}`).toMatch(
        new RegExp(phrase, "i")
      );
    }
  });
});

describe("AGENTS.md points agents at internal/", () => {
  const agents = readDoc("AGENTS.md");

  it("declares the docs/ vs internal/ split", () => {
    expect(agents).toMatch(/Where docs live/i);
    expect(agents).toContain("internal/");
    expect(agents).toContain("docs/");
  });

  it("links to internal/roadmap.md and the per-milestone narratives", () => {
    expect(agents).toMatch(/internal\/roadmap\.md/);
    expect(agents).toMatch(/internal\/milestones\//);
    expect(agents).toMatch(/internal\/contracts\//);
  });

  it("names the active milestone (M6) compactly", () => {
    expect(agents).toMatch(/Milestone 6/);
  });

  it("stays compact (under 200 lines)", () => {
    const lineCount = agents.split("\n").length;
    expect(lineCount, `AGENTS.md should stay compact (was ${lineCount} lines)`).toBeLessThan(200);
  });

  it("references the public-docs hygiene guard", () => {
    expect(agents).toMatch(/test\/public-docs-hygiene\.test\.ts/);
  });
});
