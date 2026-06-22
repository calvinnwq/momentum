import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("executor loop contract", () => {
  const spec = readDoc("SPEC.md");

  it("keeps executor state below workflow steps", () => {
    for (const term of [
      "ExecutorInvocation",
      "ExecutorRound",
      "artifacts",
      "verification status",
      "commit metadata",
      "recovery codes",
      "findings",
      "decisions",
      "checkpoints",
    ]) {
      expect(spec, `SPEC.md should name ${term}`).toContain(term);
    }
  });

  it("pins daemon-owned progress and executor-owned bounded work", () => {
    expect(spec).toMatch(/The daemon owns scheduling/i);
    expect(spec).toMatch(/Executors own bounded work/i);
    expect(spec).toMatch(/The daemon decides state\s+transitions from durable evidence/i);
  });

  it("requires normalized evidence before classification", () => {
    expect(spec).toMatch(/normalized result evidence or mirrored\s+external state/i);
    expect(spec).toMatch(/fast-path hints, not authoritative state/i);
  });
});
