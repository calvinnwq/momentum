import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXECUTORS,
  type ExecutorName,
} from "../src/core/workflow/definition/definition.js";
import {
  PHASE1_DISPATCHABLE_EXECUTORS,
  WORKFLOW_DISPATCH_FAIL_CLOSED_CODES,
  WORKFLOW_STEP_RESOLUTION_FAILURES,
  isPhase1DispatchableExecutor,
  planWorkflowStepDispatch,
  type WorkflowStepDispatchResolution,
} from "../src/core/workflow/dispatch/dispatch.js";

function resolved(executor: ExecutorName): WorkflowStepDispatchResolution {
  return { ok: true, executor };
}

describe("phase-1 dispatchable executors", () => {
  it("supports exactly the daemon-dispatchable bounded adapters", () => {
    // RC-4b (NGX-498) flipped `subworkflow` in once its configured production lane
    // was proven, so every landed executor is now dispatchable.
    expect([...PHASE1_DISPATCHABLE_EXECUTORS].sort()).toEqual(
      [
        "external-apply",
        "delegate-supervisor",
        "agent-loop",
        "no-mistakes",
        "agent-once",
        "script",
        "subworkflow",
      ].sort(),
    );
  });

  it("contains every canonical executor plus the retained legacy mirror", () => {
    for (const executor of WORKFLOW_EXECUTORS) {
      expect(PHASE1_DISPATCHABLE_EXECUTORS).toContain(executor);
    }
    expect(PHASE1_DISPATCHABLE_EXECUTORS).toContain("no-mistakes");
    expect(WORKFLOW_EXECUTORS).not.toContain("no-mistakes");
  });

  it("guards membership", () => {
    expect(isPhase1DispatchableExecutor("agent-loop")).toBe(true);
    expect(isPhase1DispatchableExecutor("agent-once")).toBe(true);
    expect(isPhase1DispatchableExecutor("no-mistakes")).toBe(true);
    expect(isPhase1DispatchableExecutor("delegate-supervisor")).toBe(true);
    expect(isPhase1DispatchableExecutor("script")).toBe(true);
    expect(isPhase1DispatchableExecutor("external-apply")).toBe(true);
    expect(isPhase1DispatchableExecutor("subworkflow")).toBe(true);
  });
});

describe("planWorkflowStepDispatch - supported executors", () => {
  for (const executor of PHASE1_DISPATCHABLE_EXECUTORS) {
    it(`routes ${executor} to a real dispatch`, () => {
      const plan = planWorkflowStepDispatch(resolved(executor));
      expect(plan.action).toBe("dispatch");
      if (plan.action === "dispatch") {
        expect(plan.executor).toBe(executor);
      }
    });
  }
});

describe("planWorkflowStepDispatch - every executor is now dispatchable (NGX-498)", () => {
  it("has no remaining deferred executor that fails closed", () => {
    // RC-4b flipped the last deferred executor (`subworkflow`); every member of
    // the executor vocabulary now routes to a real dispatch.
    for (const executor of WORKFLOW_EXECUTORS) {
      expect(isPhase1DispatchableExecutor(executor)).toBe(true);
      expect(planWorkflowStepDispatch(resolved(executor)).action).toBe(
        "dispatch",
      );
    }
  });

  it("dispatches third-party executor names for registry resolution", () => {
    const plan = planWorkflowStepDispatch({
      ok: true,
      executor: "future-unlanded-executor",
    });
    expect(plan.action).toBe("dispatch");
    if (plan.action === "dispatch") {
      expect(plan.executor).toBe("future-unlanded-executor");
    }
  });
});

describe("planWorkflowStepDispatch - resolution failures fail closed", () => {
  const cases: Array<{
    failure: (typeof WORKFLOW_STEP_RESOLUTION_FAILURES)[number];
    code: (typeof WORKFLOW_DISPATCH_FAIL_CLOSED_CODES)[number];
  }> = [
    { failure: "run_not_found", code: "workflow_run_not_found" },
    { failure: "definition_unlinked", code: "workflow_definition_unlinked" },
    {
      failure: "step_definition_not_found",
      code: "step_definition_not_found",
    },
    { failure: "unknown_executor", code: "unknown_executor" },
  ];

  for (const { failure, code } of cases) {
    it(`maps ${failure} to fail-closed code ${code}`, () => {
      const plan = planWorkflowStepDispatch({ ok: false, failure });
      expect(plan.action).toBe("fail_closed");
      if (plan.action === "fail_closed") {
        expect(plan.code).toBe(code);
        expect(plan.gateType).toBe("manual_recovery_required");
        expect(plan.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it("threads a resolution detail into the fail-closed reason when present", () => {
    const plan = planWorkflowStepDispatch({
      ok: false,
      failure: "unknown_executor",
      detail: "legacy-family",
    });
    expect(plan.action).toBe("fail_closed");
    if (plan.action === "fail_closed") {
      expect(plan.reason).toContain("legacy-family");
    }
  });
});

describe("planWorkflowStepDispatch totality", () => {
  it("never throws across every executor and resolution failure", () => {
    for (const executor of WORKFLOW_EXECUTORS) {
      expect(() => planWorkflowStepDispatch(resolved(executor))).not.toThrow();
    }
    for (const failure of WORKFLOW_STEP_RESOLUTION_FAILURES) {
      expect(() =>
        planWorkflowStepDispatch({ ok: false, failure }),
      ).not.toThrow();
    }
  });

  it("returns one of the two discriminated actions for every input", () => {
    const plan = planWorkflowStepDispatch(resolved("agent-loop"));
    expect(["dispatch", "fail_closed"]).toContain(plan.action);
  });
});
