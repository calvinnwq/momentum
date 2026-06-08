import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("workflow-first runtime pivot contract", () => {
  const contractPath = "internal/contracts/workflow-first-runtime.md";

  it("records the accepted workflow-first product model", () => {
    const contract = readDoc(contractPath);

    for (const term of [
      "WorkflowDefinition",
      "WorkflowRun",
      "StepDefinition",
      "StepRun",
      "Executor",
      "goal-loop",
    ]) {
      expect(contract, `contract should define ${term}`).toContain(term);
    }

    expect(contract).toMatch(/Goal model becomes one executor family/i);
    expect(contract).toMatch(/Workflow-first/i);
  });

  it("keeps M9 as foundation work while superseding goal start for future workflow-first starts", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/M9 remains valid foundation work/i);
    expect(contract).toMatch(/not be stretched into a generic workflow product/i);
    expect(contract).toMatch(/goal start.*superseded[\s\S]*future workflow-first work/i);
    expect(contract).toMatch(/workflow run start surface/i);
  });

  it("pins the daemon and goal-loop executor interface", () => {
    const contract = readDoc(contractPath);

    for (const method of ["prepare", "startRound", "inspect", "cancel", "recover"]) {
      expect(contract, `executor interface should include ${method}`).toContain(method);
    }

    expect(contract).toMatch(/daemon owns scheduling/i);
    expect(contract).toMatch(/one bounded round/i);
    expect(contract).toMatch(/executor may recommend `continue`/i);
  });

  it("requires executor-loop state to be durable in Momentum tables", () => {
    const contract = readDoc(contractPath);

    for (const table of [
      "workflow_definitions",
      "step_definitions",
      "workflow_runs",
      "step_runs",
      "executor_invocations",
      "executor_rounds",
      "executor_findings",
      "executor_decisions",
      "executor_checkpoints",
    ]) {
      expect(contract, `contract should name ${table}`).toContain(table);
    }

    expect(contract).toMatch(/Loops live inside executors, but their rounds belong in Momentum's database/);
  });

  it("copies durable discipline from GNHF and no-mistakes without copying their product boundaries", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/GNHF is an in-process iteration runner/i);
    expect(contract).toMatch(/no-mistakes is the daemon model to copy/i);
    expect(contract).toMatch(/should not copy no-mistakes' fixed pipeline/i);
    expect(contract).toMatch(/should not copy `\.gnhf\/runs` as the primary state store/i);
  });

  it("pins first-class human gates and delegated policy boundaries", () => {
    const contract = readDoc(contractPath);

    for (const state of [
      "approval_required",
      "operator_decision_required",
      "manual_recovery_required",
      "blocked",
      "failed",
    ]) {
      expect(contract, `contract should name ${state}`).toContain(state);
    }

    expect(contract).toMatch(/agent-recommended-important/);
    expect(contract).toMatch(/Autonomy is allowed only inside the approved envelope/);
  });

  it("links the pivot from the roadmap while keeping M9 as foundation", () => {
    const roadmap = readDoc("internal/roadmap.md");

    expect(roadmap).toContain("internal/contracts/workflow-first-runtime.md");
    expect(roadmap).toMatch(/Milestone 9\s*\|\s*Live Workflow Execution\s*\|\s*Foundation in force/);
    expect(roadmap).toMatch(/workflow-first runtime pivot/i);
  });

  it("keeps current exclusions honest after the M10 closeout", () => {
    const exclusions = readDoc("internal/exclusions.md");

    expect(exclusions).toContain("internal/contracts/workflow-first-runtime.md");
    expect(exclusions).toMatch(/accepted planning contract/i);
    expect(exclusions).toMatch(/workflow-first\s+dogfood and M10 closeout marker have landed/i);
    expect(exclusions).toMatch(/external-apply[\s\S]*subworkflow[\s\S]*deferred/i);
  });
});
