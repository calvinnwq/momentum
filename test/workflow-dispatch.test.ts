import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXECUTOR_FAMILIES,
  type WorkflowExecutorFamily
} from "../src/core/workflow/definition.js";
import {
  PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES,
  WORKFLOW_DISPATCH_FAIL_CLOSED_CODES,
  WORKFLOW_STEP_RESOLUTION_FAILURES,
  isPhase1DispatchableExecutorFamily,
  planWorkflowStepDispatch,
  type WorkflowStepDispatchResolution
} from "../src/core/workflow/dispatch.js";

function resolved(
  executorFamily: WorkflowExecutorFamily
): WorkflowStepDispatchResolution {
  return { ok: true, executorFamily };
}

describe("phase-1 dispatchable executor families", () => {
  it("supports exactly the daemon-dispatchable bounded-adapter families", () => {
    // RC-4b (NGX-498) flipped `subworkflow` in once its configured production lane
    // was proven, so every landed adapter family is now dispatchable.
    expect([...PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES].sort()).toEqual(
      [
        "external-apply",
        "goal-loop",
        "no-mistakes",
        "one-shot",
        "script",
        "subworkflow"
      ].sort()
    );
  });

  it("is a subset of the workflow executor families", () => {
    for (const family of PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES) {
      expect(WORKFLOW_EXECUTOR_FAMILIES).toContain(family);
    }
    // Post-NGX-498 the phase-1 set covers every executor family; it can never
    // exceed the full vocabulary.
    expect(PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES.length).toBeLessThanOrEqual(
      WORKFLOW_EXECUTOR_FAMILIES.length
    );
  });

  it("guards membership", () => {
    expect(isPhase1DispatchableExecutorFamily("goal-loop")).toBe(true);
    expect(isPhase1DispatchableExecutorFamily("one-shot")).toBe(true);
    expect(isPhase1DispatchableExecutorFamily("no-mistakes")).toBe(true);
    expect(isPhase1DispatchableExecutorFamily("script")).toBe(true);
    expect(isPhase1DispatchableExecutorFamily("external-apply")).toBe(true);
    expect(isPhase1DispatchableExecutorFamily("subworkflow")).toBe(true);
  });
});

describe("planWorkflowStepDispatch — supported families", () => {
  for (const family of PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES) {
    it(`routes ${family} to a real dispatch`, () => {
      const plan = planWorkflowStepDispatch(resolved(family));
      expect(plan.action).toBe("dispatch");
      if (plan.action === "dispatch") {
        expect(plan.executorFamily).toBe(family);
      }
    });
  }
});

describe("planWorkflowStepDispatch — every executor family is now dispatchable (NGX-498)", () => {
  it("has no remaining deferred executor family that fails closed", () => {
    // RC-4b flipped the last deferred family (`subworkflow`); every member of the
    // executor-family vocabulary now routes to a real dispatch.
    for (const family of WORKFLOW_EXECUTOR_FAMILIES) {
      expect(isPhase1DispatchableExecutorFamily(family)).toBe(true);
      expect(planWorkflowStepDispatch(resolved(family)).action).toBe("dispatch");
    }
  });

  it("still fails closed defensively for a family outside the phase-1 set", () => {
    // No real WorkflowExecutorFamily is outside the phase-1 set after NGX-498, so
    // this casts a hypothetical not-yet-landed family to confirm the defensive
    // unsupported_executor_family branch remains an operator-visible manual-
    // recovery gate rather than silently dispatching.
    const plan = planWorkflowStepDispatch({
      ok: true,
      executorFamily: "future-unlanded-family" as WorkflowExecutorFamily
    });
    expect(plan.action).toBe("fail_closed");
    if (plan.action === "fail_closed") {
      expect(plan.code).toBe("unsupported_executor_family");
      expect(plan.gateType).toBe("manual_recovery_required");
      expect(plan.reason).toContain("future-unlanded-family");
    }
  });
});

describe("planWorkflowStepDispatch — resolution failures fail closed", () => {
  const cases: Array<{
    failure: (typeof WORKFLOW_STEP_RESOLUTION_FAILURES)[number];
    code: (typeof WORKFLOW_DISPATCH_FAIL_CLOSED_CODES)[number];
  }> = [
    { failure: "run_not_found", code: "workflow_run_not_found" },
    { failure: "definition_unlinked", code: "workflow_definition_unlinked" },
    {
      failure: "step_definition_not_found",
      code: "step_definition_not_found"
    },
    { failure: "unknown_executor_family", code: "unknown_executor_family" }
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
      failure: "unknown_executor_family",
      detail: "legacy-family"
    });
    expect(plan.action).toBe("fail_closed");
    if (plan.action === "fail_closed") {
      expect(plan.reason).toContain("legacy-family");
    }
  });
});

describe("planWorkflowStepDispatch totality", () => {
  it("never throws across every executor family and resolution failure", () => {
    for (const family of WORKFLOW_EXECUTOR_FAMILIES) {
      expect(() => planWorkflowStepDispatch(resolved(family))).not.toThrow();
    }
    for (const failure of WORKFLOW_STEP_RESOLUTION_FAILURES) {
      expect(() =>
        planWorkflowStepDispatch({ ok: false, failure })
      ).not.toThrow();
    }
  });

  it("returns one of the two discriminated actions for every input", () => {
    const plan = planWorkflowStepDispatch(resolved("goal-loop"));
    expect(["dispatch", "fail_closed"]).toContain(plan.action);
  });
});
