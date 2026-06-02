import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("workflow-first gap matrix planning contract", () => {
  const contractPath = "internal/contracts/workflow-first-gap-matrix.md";

  it("keeps M9 as foundation and names M10 as the active workflow-first bridge", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/M9 remains foundation work/i);
    expect(contract).toMatch(/M10: Workflow-First Runtime/i);
    expect(contract).toMatch(/active implementation bridge/i);
  });

  it("captures current Momentum inventory before target design", () => {
    const contract = readDoc(contractPath);

    for (const surface of [
      "goal start",
      "daemon start",
      "workflow import",
      "workflow run approve",
      "workflow run monitor",
      "M7 `WorkflowRun`",
      "M8 operator controls",
      "M9 live wrapper",
    ]) {
      expect(contract, `gap matrix should name current surface ${surface}`).toContain(surface);
    }

    expect(contract).toMatch(/WorkflowRun is durable, but not yet the top-level configurable product start surface/);
  });

  it("pins the workflow-first target inventory and future CLI shape", () => {
    const contract = readDoc(contractPath);

    for (const target of [
      "WorkflowDefinition",
      "StepDefinition",
      "WorkflowRun",
      "StepRun",
      "ExecutorDefinition",
      "ExecutorInvocation",
      "ExecutorRound",
      "workflow run start",
      "workflow run decide",
      "workflow run recover",
    ]) {
      expect(contract, `gap matrix should name target ${target}`).toContain(target);
    }
  });

  it("maps current areas to target shapes and migration directions", () => {
    const contract = readDoc(contractPath);

    for (const area of [
      "Product root",
      "Run start",
      "Step model",
      "Executor model",
      "Loop state",
      "Daemon scheduling",
      "Human gates",
      "no-mistakes",
      "GNHF",
      "Evidence",
    ]) {
      expect(contract, `gap matrix should include area ${area}`).toContain(area);
    }

    expect(contract).toMatch(/Introduce workflow definitions before deprecating goal-first UX/);
    expect(contract).toMatch(/Keep canonical coding workflow as one built-in definition/);
  });

  it("states what survives from M7, M8, and M9", () => {
    const contract = readDoc(contractPath);

    for (const primitive of [
      "Workflow run state vocabulary",
      "Approval boundary persistence",
      "Lease freshness",
      "Monitor envelope",
      "Run-scoped recovery artifact",
      "Live wrapper explicit argv/env/cwd/result-file discipline",
      "Repo lock heartbeat",
      "head_mismatch",
      "repo_lock_lost",
    ]) {
      expect(contract, `survival list should include ${primitive}`).toContain(primitive);
    }
  });

  it("states what changes in the product model", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/Goal is no longer the product root/);
    expect(contract).toMatch(/Goal loop becomes an executor family/);
    expect(contract).toMatch(/Workflow run start becomes first-class/);
    expect(contract).toMatch(/Operator decisions move into durable gates/);
  });

  it("pins a likely contract-to-dogfood implementation slice order", () => {
    const contract = readDoc(contractPath);

    for (const slice of [
      "M10-00",
      "M10-01",
      "M10-02",
      "M10-03",
      "M10-04",
      "M10-05",
      "M10-06",
      "M10-07",
      "M10-08",
      "M10-09",
    ]) {
      expect(contract, `gap matrix should include ${slice}`).toContain(slice);
    }

    expect(contract).toMatch(/contract -> schema -> start -> executor state -> scheduler -> adapters -> gates -> dogfood/);
  });

  it("links from the pivot contract, roadmap, and exclusions", () => {
    const pivot = readDoc("internal/contracts/workflow-first-runtime.md");
    const roadmap = readDoc("internal/roadmap.md");
    const exclusions = readDoc("internal/exclusions.md");

    expect(pivot).toContain("internal/contracts/workflow-first-gap-matrix.md");
    expect(roadmap).toContain("internal/contracts/workflow-first-gap-matrix.md");
    expect(exclusions).toContain("internal/contracts/workflow-first-gap-matrix.md");
  });
});
