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

  it("anchors the product identity and success test in a root repo doc", () => {
    expect(vision).toMatch(/^# Momentum Vision/m);
    expect(vision).toContain(
      "local-first runtime that makes agent-driven repo work durable"
    );
    expect(vision).toContain("Momentum is not an agent and never will be");
    expect(vision).toContain(
      "ten or more external users run Momentum weekly on their own repositories"
    );
  });

  it("codifies the durable model vocabulary", () => {
    expect(vision).toContain("**workflow definition**");
    expect(vision).toContain("**workflow run**");
    expect(vision).toContain("**step run**");
    expect(vision).toContain("**attempt**");
    expect(vision).toContain("**round**");
    expect(vision).toContain("preflight -> apply -> reconcile");
    expect(vision).toContain("Terminal rounds are immutable");
    expect(vision).toContain(
      "a definition is instantiated as a run; a run advances through steps; a step dispatches attempts; an attempt accumulates rounds; every round verifies, then commits or resets, and leaves evidence"
    );
  });

  it("codifies executors as the pluggable execution boundary", () => {
    expect(vision).toContain("Every step names an **executor**");
    for (const executor of [
      "`agent-once`",
      "`agent-loop`",
      "`script`",
      "`delegate-supervisor`",
      "`external-apply`",
      "`subworkflow`"
    ]) {
      expect(vision, `VISION.md should name the ${executor} executor`).toContain(executor);
    }
    expect(vision).toContain("The daemon owns decisions");
    expect(vision).toContain("Purpose and executor are separate axes");
    expect(vision).toContain(
      "the proof of the SDK is that the built-in executors use it themselves"
    );
    expect(vision).toContain(
      'the words "route" and "profile" are retired rather than redefined'
    );
  });

  it("codifies the pre-1.0 stability posture", () => {
    expect(vision).toContain("The changelog is the contract");
    expect(vision).toContain("Interfaces are fluid, evidence is forever");
    expect(vision).toContain(
      "the bias is deletion and consolidation over compatibility"
    );
  });

  it("keeps the reference deployment at the plugin edge", () => {
    expect(vision).toContain("That deployment is proof, not product");
    expect(vision).toContain(
      "Nothing in the core schema, CLI, or envelopes may name the maintainer's tools"
    );
  });

  it("keeps non-goals explicit", () => {
    expect(vision).toContain("**Not an agent.**");
    expect(vision).toContain("**Not a hosted service.**");
    expect(vision).toContain("**Not CI.**");
    expect(vision).toContain("**Not a tracker bot.**");
    expect(vision).toContain("**Not a general workflow platform.**");
  });

  it("is discoverable from agent and runtime contract anchors", () => {
    expect(readFile("AGENTS.md")).toContain("VISION.md");
    expect(readFile("SPEC.md")).toContain("VISION.md");
  });
});
