import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const matrixPath = "internal/contracts/adapter-test-coverage.md";

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("adapter test coverage matrix", () => {
  it("separates adapter test layers before full E2E proof", () => {
    const matrix = readDoc(matrixPath);

    for (const layer of [
      "Isolated contract",
      "Stubbed integration",
      "Opt-in real smoke",
      "Full E2E",
    ]) {
      expect(matrix, `matrix should define ${layer}`).toContain(layer);
    }

    expect(matrix).toMatch(/full end-to-end workflow proof/i);
    expect(matrix).toMatch(/never be the first test/i);
  });

  it("covers source, write-side, runner, and workflow executor adapter families", () => {
    const matrix = readDoc(matrixPath);

    for (const family of [
      "Source adapter registry and local fixture",
      "Linear source adapter",
      "External update adapter / Linear write client",
      "RunnerAdapter: fake / trusted-shell / acp",
      "WorkflowStepExecutor fake boundary",
      "Workflow scheduler and production dispatch",
      "Goal-loop executor adapter",
      "One-shot and script executor adapters",
      "No-mistakes executor mirror",
      "M9 live coding workflow wrappers",
      "Unsupported executor families; external-apply / subworkflow dispatch adapters",
    ]) {
      expect(matrix, `matrix should cover ${family}`).toContain(family);
    }
  });

  it("pins the existing evidence paths that NGX-368 audited", () => {
    const matrix = readDoc(matrixPath);

    for (const testPath of [
      "test/source-adapter.test.ts",
      "test/linear-source-adapter.test.ts",
      "test/source-reconciliation.test.ts",
      "test/external-update-adapter.test.ts",
      "test/intent-apply-execute.test.ts",
      "test/runner-adapter.test.ts",
      "test/workflow-step-executor.test.ts",
      "test/workflow-dispatch-execute.test.ts",
      "test/goal-loop-executor.test.ts",
      "test/single-shot-executor.test.ts",
      "test/no-mistakes-executor.test.ts",
      "test/live-step-executor.test.ts",
    ]) {
      expect(matrix, `matrix should reference ${testPath}`).toContain(testPath);
    }
  });

  it("maps the follow-on Linear issues to their test layer ownership", () => {
    const matrix = readDoc(matrixPath);

    for (const issue of ["NGX-369", "NGX-370", "NGX-371", "NGX-372"]) {
      expect(matrix, `matrix should map ${issue}`).toContain(issue);
    }

    expect(matrix).toMatch(/NGX-369[\s\S]*source adapter/i);
    expect(matrix).toMatch(/NGX-370[\s\S]*coding workflow adapter/i);
    expect(matrix).toMatch(/NGX-371[\s\S]*Stubbed adapter integration/i);
    expect(matrix).toMatch(/NGX-372[\s\S]*real adapter smoke/i);
  });

  it("keeps the safety guardrails explicit", () => {
    const matrix = readDoc(matrixPath);

    expect(matrix).toContain("Default CI must not call real `api.linear.app`");
    expect(matrix).toMatch(/Source adapters remain read-only/i);
    expect(matrix).toMatch(/Unsupported executor families must fail closed/i);
    expect(matrix).toMatch(/audit-before-write lifecycle/i);
  });
});
