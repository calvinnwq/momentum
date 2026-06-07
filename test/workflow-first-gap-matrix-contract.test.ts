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
      "M10-03 `ExecutorDefinition`",
    ]) {
      expect(contract, `gap matrix should name current surface ${surface}`).toContain(surface);
    }

    expect(contract).toMatch(/WorkflowRun is durable and can start from definitions/);
    expect(contract).toMatch(/executor records now persist below step runs/);
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

describe("M10-09a production workflow-lane dispatcher boundary (NGX-367)", () => {
  const contractPath = "internal/contracts/workflow-first-gap-matrix.md";

  it("documents the M10-09a phase-1 dispatcher prep slice and its NGX issue", () => {
    const contract = readDoc(contractPath);

    expect(contract).toContain("M10-09a");
    expect(contract).toContain("NGX-367");
    // M10-09a is the small prep/repair slice before the NGX-353 dogfood closeout.
    expect(contract).toMatch(/prep|repair/i);
    expect(contract).toContain("NGX-353");
  });

  it("pins the phase-1 dispatchable executor-family allowlist and the deferred families", () => {
    const contract = readDoc(contractPath);

    for (const family of ["goal-loop", "one-shot", "script", "no-mistakes"]) {
      expect(
        contract,
        `dispatcher boundary should name dispatchable family ${family}`
      ).toContain(family);
    }
    // external-apply and subworkflow have no landed adapter this phase; they fail closed.
    expect(contract).toContain("external-apply");
    expect(contract).toContain("subworkflow");
  });

  it("states the production daemon wiring and the register-only invariant", () => {
    const contract = readDoc(contractPath);

    expect(contract).toContain("workflowLane");
    expect(contract).toContain("runDaemonLoop");
    expect(contract).toMatch(/bounded managed `daemon start`/);
    expect(contract).toMatch(/register-only `daemon start`/i);
    expect(contract).toMatch(/unchanged|inert/i);
  });

  it("states the durable dispatch effects and fail-closed lease safety", () => {
    const contract = readDoc(contractPath);

    expect(contract).toContain("executor_invocations");
    expect(contract).toContain("executor_rounds");
    expect(contract).toContain("manual_recovery_required");
    // The dispatch lease is released/accounted for on fail-closed and never stranded on throw.
    expect(contract).toMatch(/lease/i);
    expect(contract).toMatch(/fail closed|fail-closed/i);
  });

  it("states what remains for the NGX-353 closeout dogfood", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/doctor[\s-]*(marker|--json)/i);
    expect(contract).toMatch(/regression matrix|regression coverage/i);
    expect(contract).toMatch(/dogfood/i);
  });
});
