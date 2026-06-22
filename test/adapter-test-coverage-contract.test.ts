import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("adapter test coverage contract", () => {
  const spec = readDoc("SPEC.md");

  it("keeps adapter coverage layered before full E2E proof", () => {
    for (const layer of [
      "isolated contract tests",
      "stubbed integration tests",
      "opt-in real smoke tests",
      "full end-to-end composition proofs",
    ]) {
      expect(spec, `SPEC.md should define ${layer}`).toContain(layer);
    }
  });

  it("keeps external adapter safety explicit", () => {
    expect(spec).toContain("Default CI must not call real `api.linear.app`");
    expect(spec).toMatch(/Source adapters are read-only/i);
    expect(spec).toMatch(/policy-gated and two-phase/i);
    expect(spec).toMatch(/must fail closed/i);
  });

  it("continues to prove adapter composition with executable tests", () => {
    for (const rel of [
      "test/source-adapter.test.ts",
      "test/linear-source-adapter.test.ts",
      "test/source-reconciliation.test.ts",
      "test/external-update-adapter.test.ts",
      "test/intent-apply-execute.test.ts",
      "test/runner-adapter.test.ts",
      "test/workflow-step-executor.test.ts",
      "test/workflow-dispatch-execute.test.ts",
      "test/full-adapter-e2e.test.ts",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should exist`).toBe(true);
    }
  });
});
