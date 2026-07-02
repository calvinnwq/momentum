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
    expect(vision).toContain("Native Goal Loop Is The Core Flywheel");
  });

  it("keeps the preflight ownership split explicit", () => {
    expect(vision).toContain("preflight -> apply -> reconcile");
    expect(vision).toContain("Workflow-level structural preflight covers");
    expect(vision).toContain("Workflow-level structural preflight should not own");
    expect(vision).toContain("GitHub merge auth and pull request mergeability");
    expect(vision).toContain("Linear external-apply auth, pending intent claim, or tracker mutation");
  });

  it("keeps the native goal-loop ownership model explicit", () => {
    expect(vision).toContain("By default, a goal loop has no maximum iteration count and no token cap");
    expect(vision).toContain("read durable state -> run one verifiable round -> verify -> commit or reset -> record evidence -> decide complete or continue");
    expect(vision).toContain("Each successful round should commit its own coherent unit of work");
    expect(vision).toContain("If a process dies halfway through, Momentum should resume from durable");
    expect(vision).toContain("invocation and round state");
    expect(vision).toContain(".gnhf/runs");
    expect(vision).toContain("it must not be");
    expect(vision).toContain("the durable source of truth for Momentum-native workflows");
    expect(vision).toContain("Do not add a first-class `gnhf` executor family merely to reuse that behavior");
  });

  it("is discoverable from agent and runtime contract anchors", () => {
    expect(readFile("AGENTS.md")).toContain("VISION.md");
    expect(readFile("SPEC.md")).toContain("VISION.md");
  });
});
