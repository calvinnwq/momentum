import { describe, expect, it } from "vitest";

import {
  EXECUTOR_ATTEMPT_STATES,
  type ExecutorAttemptState
} from "../src/core/executors/loop/reducer.js";
import { planWorkflowStepReconciliation } from "../src/core/workflow/dispatch/reconcile.js";

/**
 * RC-2 (NGX-480) pure reconciliation decider.
 *
 * The decider is the brain of the single reconciliation seam that finalizes an
 * M10 dispatched workflow step from its `<run>::<step>::dispatch` invocation's
 * terminal executor evidence. It mirrors `planWorkflowStepDispatch`: pure, total,
 * never throws, always returns a discriminated-union plan. It does not touch
 * SQLite, leases, or step rows — the effect twin applies the plan idempotently.
 */
describe("planWorkflowStepReconciliation (RC-2 pure decider)", () => {
  const NON_TERMINAL_STATES: ExecutorAttemptState[] = [
    "pending",
    "preparing",
    "running",
    "pausing",
    "waiting_operator"
  ];

  it("defers finalization while the bounded executor session is non-terminal", () => {
    for (const state of NON_TERMINAL_STATES) {
      const plan = planWorkflowStepReconciliation(state);
      expect(plan.action).toBe("not_terminal");
    }
  });

  it("finalizes the step succeeded when the invocation succeeded", () => {
    const plan = planWorkflowStepReconciliation("succeeded");
    expect(plan).toMatchObject({ action: "finalize", stepState: "succeeded" });
  });

  it("finalizes the step failed when the invocation failed", () => {
    const plan = planWorkflowStepReconciliation("failed");
    expect(plan).toMatchObject({ action: "finalize", stepState: "failed" });
  });

  it("finalizes the step canceled when the invocation was cancelled", () => {
    const plan = planWorkflowStepReconciliation("cancelled");
    expect(plan).toMatchObject({ action: "finalize", stepState: "canceled" });
  });

  it("routes a blocked invocation to manual recovery rather than a clean step terminal", () => {
    const plan = planWorkflowStepReconciliation("blocked");
    expect(plan).toMatchObject({
      action: "manual_recovery",
      attemptState: "blocked"
    });
  });

  it("routes a manual_recovery_required invocation to manual recovery", () => {
    const plan = planWorkflowStepReconciliation("manual_recovery_required");
    expect(plan).toMatchObject({
      action: "manual_recovery",
      attemptState: "manual_recovery_required"
    });
  });

  it("is total: every executor invocation state yields exactly one known action", () => {
    for (const state of EXECUTOR_ATTEMPT_STATES) {
      const plan = planWorkflowStepReconciliation(state);
      expect(["not_terminal", "finalize", "manual_recovery"]).toContain(
        plan.action
      );
    }
  });

  it("only ever finalizes into a terminal workflow-step state", () => {
    const terminalStepStates = new Set(["succeeded", "failed", "skipped", "canceled"]);
    for (const state of EXECUTOR_ATTEMPT_STATES) {
      const plan = planWorkflowStepReconciliation(state);
      if (plan.action === "finalize") {
        expect(terminalStepStates.has(plan.stepState)).toBe(true);
      }
    }
  });
});
