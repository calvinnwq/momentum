import { describe, expect, it } from "vitest";

import {
  WORKFLOW_APPROVAL_BOUNDARIES,
  WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS,
  WORKFLOW_LEASE_KINDS,
  WORKFLOW_LEASE_STALE_POLICIES,
  WORKFLOW_RUN_STATES,
  WORKFLOW_RUN_TERMINAL_STATES,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_STEP_STATES,
  WORKFLOW_STEP_TERMINAL_STATES,
  classifyWorkflowLease,
  deriveWorkflowRunState,
  isTerminalRunState,
  isTerminalStepState,
  transitionWorkflowRun,
  transitionWorkflowStep,
  type WorkflowLeaseRecord,
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

function lease(overrides: Partial<WorkflowLeaseRecord> = {}): WorkflowLeaseRecord {
  return {
    runId: "cwfp-deadbeef",
    leaseKind: "monitor",
    holder: "coding-workflow-monitor:cwfp-deadbeef",
    acquiredAt: 1_000,
    expiresAt: 5_000,
    heartbeatAt: 1_000,
    releasedAt: null,
    stalePolicy: "auto-release",
    ...overrides
  };
}

describe("classifyWorkflowLease", () => {
  it("exposes the canonical freshness classification set", () => {
    expect([...WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS].sort()).toEqual(
      [
        "released",
        "fresh",
        "stale-auto-release",
        "stale-manual-recovery-required"
      ].sort()
    );
  });

  it("classifies a lease as released when releasedAt is set, regardless of expiry", () => {
    const expired = lease({ expiresAt: 100, releasedAt: 200 });
    expect(classifyWorkflowLease(expired, { now: 10_000 })).toBe("released");

    const fresh = lease({ expiresAt: 10_000, releasedAt: 200 });
    expect(classifyWorkflowLease(fresh, { now: 1_000 })).toBe("released");
  });

  it("classifies a lease as fresh when now <= expiresAt", () => {
    const l = lease({ expiresAt: 5_000 });
    expect(classifyWorkflowLease(l, { now: 4_999 })).toBe("fresh");
    expect(classifyWorkflowLease(l, { now: 5_000 })).toBe("fresh");
  });

  it("classifies an expired auto-release lease as stale-auto-release", () => {
    const l = lease({ expiresAt: 5_000, stalePolicy: "auto-release" });
    expect(classifyWorkflowLease(l, { now: 5_001 })).toBe("stale-auto-release");
  });

  it("classifies an expired manual-recovery-required lease as stale-manual-recovery-required", () => {
    const l = lease({
      expiresAt: 5_000,
      stalePolicy: "manual-recovery-required"
    });
    expect(classifyWorkflowLease(l, { now: 5_001 })).toBe(
      "stale-manual-recovery-required"
    );
  });

  it("honours graceMs so a lease just past expiry is still fresh within the grace window", () => {
    const l = lease({ expiresAt: 5_000, stalePolicy: "auto-release" });
    expect(classifyWorkflowLease(l, { now: 5_500, graceMs: 1_000 })).toBe(
      "fresh"
    );
    expect(classifyWorkflowLease(l, { now: 6_001, graceMs: 1_000 })).toBe(
      "stale-auto-release"
    );
  });

  it("does not promote a stale lease to fresh based on heartbeatAt alone", () => {
    // heartbeatAt may have advanced past expiresAt due to a half-finished
    // heartbeat write; classification follows expiresAt only (mirrors M3
    // repo_locks stale-lease semantics).
    const l = lease({
      expiresAt: 5_000,
      heartbeatAt: 9_000,
      stalePolicy: "auto-release"
    });
    expect(classifyWorkflowLease(l, { now: 6_000 })).toBe("stale-auto-release");
  });

  it("rejects non-finite now / negative graceMs at the boundary", () => {
    const l = lease();
    expect(() =>
      classifyWorkflowLease(l, { now: Number.NaN })
    ).toThrowError(/now/);
    expect(() =>
      classifyWorkflowLease(l, { now: 1_000, graceMs: -1 })
    ).toThrowError(/graceMs/);
    expect(() =>
      classifyWorkflowLease(l, { now: 1_000, graceMs: Number.NaN })
    ).toThrowError(/graceMs/);
  });

  it("uses every lease kind and both stale policies in the same shape", () => {
    for (const leaseKind of WORKFLOW_LEASE_KINDS) {
      for (const stalePolicy of WORKFLOW_LEASE_STALE_POLICIES) {
        const l = lease({ leaseKind, stalePolicy, expiresAt: 5_000 });
        // fresh
        expect(classifyWorkflowLease(l, { now: 4_999 })).toBe("fresh");
        // stale follows policy
        expect(classifyWorkflowLease(l, { now: 5_001 })).toBe(
          stalePolicy === "auto-release"
            ? "stale-auto-release"
            : "stale-manual-recovery-required"
        );
      }
    }
  });
});
