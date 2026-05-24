import { describe, expect, it } from "vitest";

import {
  WORKFLOW_APPROVAL_BOUNDARIES,
  WORKFLOW_LEASE_KINDS,
  WORKFLOW_LEASE_STALE_POLICIES,
  WORKFLOW_RUN_STATES,
  WORKFLOW_RUN_TERMINAL_STATES,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_STEP_STATES,
  WORKFLOW_STEP_TERMINAL_STATES,
  deriveWorkflowRunState,
  isTerminalRunState,
  isTerminalStepState,
  transitionWorkflowRun,
  transitionWorkflowStep,
  type WorkflowStepRecord
} from "../src/workflow-run-reducer.js";

describe("workflow-run-reducer constants", () => {
  it("exposes canonical step kinds matching the M7 contract", () => {
    expect([...WORKFLOW_STEP_KINDS]).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
      "linear-refresh"
    ]);
  });

  it("exposes canonical step states", () => {
    expect([...WORKFLOW_STEP_STATES].sort()).toEqual(
      [
        "pending",
        "approved",
        "running",
        "succeeded",
        "failed",
        "skipped",
        "blocked",
        "canceled"
      ].sort()
    );
  });

  it("exposes canonical run states", () => {
    expect([...WORKFLOW_RUN_STATES].sort()).toEqual(
      [
        "pending",
        "approved",
        "running",
        "succeeded",
        "failed",
        "blocked",
        "canceled"
      ].sort()
    );
  });

  it("exposes the stable approval boundary set including batch boundaries", () => {
    const boundaries = new Set(WORKFLOW_APPROVAL_BOUNDARIES);
    for (const b of [
      "implementation",
      "through-implementation",
      "no-mistakes",
      "through-no-mistakes",
      "merge-cleanup",
      "through-merge-cleanup",
      "full",
      "plan-only",
      "overnight-safe",
      "through-postflight",
      "through-merge-gates",
      "final-cleanup",
      "full-batch"
    ]) {
      expect(boundaries.has(b as never)).toBe(true);
    }
  });

  it("exposes the lease kinds and stale policies", () => {
    expect([...WORKFLOW_LEASE_KINDS].sort()).toEqual(
      ["dispatch", "managed-step", "monitor"].sort()
    );
    expect([...WORKFLOW_LEASE_STALE_POLICIES].sort()).toEqual(
      ["auto-release", "manual-recovery-required"].sort()
    );
  });

  it("flags terminal states", () => {
    expect([...WORKFLOW_STEP_TERMINAL_STATES].sort()).toEqual(
      ["canceled", "failed", "skipped", "succeeded"].sort()
    );
    expect([...WORKFLOW_RUN_TERMINAL_STATES].sort()).toEqual(
      ["canceled", "failed", "succeeded"].sort()
    );
    expect(isTerminalStepState("succeeded")).toBe(true);
    expect(isTerminalStepState("blocked")).toBe(false);
    expect(isTerminalRunState("canceled")).toBe(true);
    expect(isTerminalRunState("blocked")).toBe(false);
  });
});

describe("transitionWorkflowStep", () => {
  it("accepts pending -> approved", () => {
    const result = transitionWorkflowStep("pending", "approved");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("approved");
  });

  it("accepts approved -> running", () => {
    const result = transitionWorkflowStep("approved", "running");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("running");
  });

  it("accepts running -> succeeded | failed | blocked | canceled", () => {
    for (const to of ["succeeded", "failed", "blocked", "canceled"] as const) {
      const result = transitionWorkflowStep("running", to);
      expect(result.ok, `running -> ${to}`).toBe(true);
    }
  });

  it("accepts blocked -> approved (recovery clear) and blocked -> canceled", () => {
    expect(transitionWorkflowStep("blocked", "approved").ok).toBe(true);
    expect(transitionWorkflowStep("blocked", "canceled").ok).toBe(true);
  });

  it("rejects transitions out of a terminal step state with workflow_step_terminal", () => {
    for (const from of ["succeeded", "failed", "skipped", "canceled"] as const) {
      const result = transitionWorkflowStep(from, "running");
      expect(result.ok, `${from} -> running should fail`).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe("workflow_step_terminal");
    }
  });

  it("rejects unknown from-state with workflow_step_unknown_state", () => {
    const result = transitionWorkflowStep(
      "bogus" as never,
      "running" as never
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errorCode).toBe("workflow_step_unknown_state");
  });

  it("rejects unknown to-state with workflow_step_unknown_state", () => {
    const result = transitionWorkflowStep("pending", "bogus" as never);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errorCode).toBe("workflow_step_unknown_state");
  });

  it("rejects an otherwise unknown transition with workflow_step_invalid_transition", () => {
    const result = transitionWorkflowStep("pending", "succeeded");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errorCode).toBe("workflow_step_invalid_transition");
  });

  it("allows same-state self-transitions as a no-op success", () => {
    const result = transitionWorkflowStep("running", "running");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("running");
  });
});

describe("transitionWorkflowRun", () => {
  it("accepts pending -> approved -> running -> succeeded", () => {
    expect(transitionWorkflowRun("pending", "approved").ok).toBe(true);
    expect(transitionWorkflowRun("approved", "running").ok).toBe(true);
    expect(transitionWorkflowRun("running", "succeeded").ok).toBe(true);
  });

  it("accepts running -> failed | blocked | canceled", () => {
    for (const to of ["failed", "blocked", "canceled"] as const) {
      expect(transitionWorkflowRun("running", to).ok).toBe(true);
    }
  });

  it("accepts blocked -> approved (recovery clear) and blocked -> canceled", () => {
    expect(transitionWorkflowRun("blocked", "approved").ok).toBe(true);
    expect(transitionWorkflowRun("blocked", "canceled").ok).toBe(true);
  });

  it("rejects transitions out of terminal run states with workflow_run_terminal", () => {
    for (const from of ["succeeded", "failed", "canceled"] as const) {
      const result = transitionWorkflowRun(from, "running");
      expect(result.ok, `${from} -> running`).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe("workflow_run_terminal");
    }
  });

  it("rejects unknown from-state with workflow_run_unknown_state", () => {
    const result = transitionWorkflowRun("bogus" as never, "running" as never);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errorCode).toBe("workflow_run_unknown_state");
  });

  it("rejects an otherwise unknown transition with workflow_run_invalid_transition", () => {
    const result = transitionWorkflowRun("pending", "succeeded");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errorCode).toBe("workflow_run_invalid_transition");
  });
});

function step(
  stepId: string,
  kind: WorkflowStepRecord["kind"],
  state: WorkflowStepRecord["state"],
  order: number,
  required = true
): WorkflowStepRecord {
  return { stepId, kind, state, order, required };
}

describe("deriveWorkflowRunState", () => {
  it("returns pending when no required step has progressed past pending", () => {
    const steps = [
      step("s-1", "preflight", "pending", 0),
      step("s-2", "implementation", "pending", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("pending");
  });

  it("returns approved when at least one step is approved and none running", () => {
    const steps = [
      step("s-1", "preflight", "approved", 0),
      step("s-2", "implementation", "pending", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("approved");
  });

  it("returns running while any step is running", () => {
    const steps = [
      step("s-1", "preflight", "succeeded", 0),
      step("s-2", "implementation", "running", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("running");
  });

  it("returns blocked when any step is blocked and none running", () => {
    const steps = [
      step("s-1", "preflight", "succeeded", 0),
      step("s-2", "implementation", "blocked", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("blocked");
  });

  it("blocked takes precedence over failed when both present and none running", () => {
    const steps = [
      step("s-1", "preflight", "failed", 0),
      step("s-2", "implementation", "blocked", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("blocked");
  });

  it("running takes precedence over blocked", () => {
    const steps = [
      step("s-1", "preflight", "blocked", 0),
      step("s-2", "implementation", "running", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("running");
  });

  it("returns failed when any required step is failed and no blocked/running step exists", () => {
    const steps = [
      step("s-1", "preflight", "failed", 0),
      step("s-2", "implementation", "pending", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("failed");
  });

  it("returns canceled when every step is canceled or skipped (no success at all)", () => {
    const steps = [
      step("s-1", "preflight", "canceled", 0),
      step("s-2", "implementation", "skipped", 1)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("canceled");
  });

  it("returns succeeded only when every required step is succeeded or skipped and at least one succeeded", () => {
    const steps = [
      step("s-1", "preflight", "succeeded", 0),
      step("s-2", "implementation", "succeeded", 1),
      step("s-3", "postflight", "skipped", 2),
      step("s-4", "no-mistakes", "skipped", 3, false)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("succeeded");
  });

  it("ignores non-required step failures when deriving terminal success", () => {
    const steps = [
      step("s-1", "preflight", "succeeded", 0),
      step("s-2", "implementation", "succeeded", 1),
      step("s-3", "linear-refresh", "failed", 2, false)
    ];
    expect(deriveWorkflowRunState(steps)).toBe("succeeded");
  });

  it("returns pending for an empty step list", () => {
    expect(deriveWorkflowRunState([])).toBe("pending");
  });
});
