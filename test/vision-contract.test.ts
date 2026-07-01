import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("Momentum vision contract", () => {
  const vision = readFile("VISION.md");

  it("anchors the product and engineering opinions in a root repo doc", () => {
    expect(vision).toMatch(/^# Momentum Vision/m);
    expect(vision).toContain("Durable rows, compact JSON envelopes, fixtures, and evidence records");
    expect(vision).toContain("Steps Are Resumable Units");
    expect(vision).toContain("Tail Steps Own Their Side-Effect Preconditions");
    expect(vision).toContain("Workflow-Level Preflight Is Structural");
  });

  it("keeps the preflight ownership split explicit", () => {
    expect(vision).toContain("preflight -> apply -> reconcile");
    expect(vision).toContain("Workflow-level structural preflight covers");
    expect(vision).toContain("Workflow-level structural preflight should not own");
    expect(vision).toContain("GitHub merge auth and pull request mergeability");
    expect(vision).toContain("Linear external-apply auth, pending intent claim, or tracker mutation");
  });

  it("is discoverable from agent and runtime contract anchors", () => {
    expect(readFile("AGENTS.md")).toContain("VISION.md");
    expect(readFile("SPEC.md")).toContain("VISION.md");
  });
});
