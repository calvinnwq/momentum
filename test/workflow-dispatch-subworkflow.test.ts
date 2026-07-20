import { describe, expect, it } from "vitest";

import { planDispatchedExecutorTerminalization } from "../src/core/workflow/dispatch/executor-evidence.js";
import {
  planSubworkflowChildMirror,
  type SubworkflowMirrorEvidence,
} from "../src/core/workflow/dispatch/subworkflow.js";
import {
  WORKFLOW_RUN_STATES,
  type WorkflowRunState,
} from "../src/core/workflow/run/reducer.js";

/**
 * NGX-497 (RC-4) — the pure half of the daemon-dispatchable `subworkflow`
 * adapter: translate a child workflow run's terminal classification
 * ({@link WorkflowRunState}) into either a "defer" signal (the child is still in
 * flight, so the parent step must NOT finalize) or the
 * `WorkflowStepExecutorDispatchResult` evidence the existing terminalize bridge
 * (`terminalizeDispatchedExecutorInvocation`) consumes, so a dispatched
 * `subworkflow` step can record durable terminal executor evidence the RC-2
 * reconciliation seam finalizes exactly once — reusing the workflow-owned run
 * substrate rather than inventing a parallel runtime.
 *
 * These tests pin the mapping contract:
 *   - a `succeeded` child run mirrors to a clean `succeeded` executor result, and
 *     a `failed` child run mirrors to a clean `failed` executor result, both of
 *     which the terminalize decider routes to a clean workflow-step terminal;
 *   - a `canceled` (ambiguous) or `blocked` (needs-recovery) child run mirrors to
 *     a fail-closed `manual_recovery_required` executor result, never a fabricated
 *     clean terminal — the fail-closed guarantee for recursive runs;
 *   - a non-terminal child run (`pending` / `approved` / `running`) defers without
 *     producing terminal evidence, so the parent step is never prematurely
 *     finalized.
 */

const EVIDENCE: SubworkflowMirrorEvidence = {
  childRunId: "child-run-001",
  executorLogPath: "/tmp/run/subworkflow.log",
  resultJsonPath: "/tmp/run/subworkflow.json",
} as const;

describe("planSubworkflowChildMirror — terminal child runs mirror to executor evidence", () => {
  it("mirrors a succeeded child run to a clean succeeded executor result", () => {
    const plan = planSubworkflowChildMirror("succeeded", EVIDENCE);
    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.childRunId).toBe(EVIDENCE.childRunId);
    expect(plan.childState).toBe("succeeded");
    const { result } = plan;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.result.state).toBe("succeeded");
    expect(result.result.errorCode).toBeNull();
    expect(result.result.errorMessage).toBeNull();
    expect(result.result.retryHint).toBeNull();
    expect(result.result.recoveryHint).toBeNull();
    expect(result.result.checkpoints).toEqual([]);
    expect(result.result.artifacts).toEqual([
      { kind: "executor-log", path: EVIDENCE.executorLogPath },
      { kind: "subworkflow-child-run", path: EVIDENCE.resultJsonPath },
    ]);
    // The child run id is the stable digest tying the parent evidence to the
    // child run it mirrors.
    expect(result.result.resultDigest).toBe(EVIDENCE.childRunId);
    expect(result.result.summary).toContain(EVIDENCE.childRunId);
    expect(result.result.summary).toContain("succeeded");
    expect(result.executorLogPath).toBe(EVIDENCE.executorLogPath);
    expect(result.resultJsonPath).toBe(EVIDENCE.resultJsonPath);
  });

  it("mirrors a failed child run to a clean failed executor result", () => {
    const plan = planSubworkflowChildMirror("failed", EVIDENCE);
    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.childState).toBe("failed");
    const { result } = plan;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    // A child run that ran to a `failed` terminal is a legitimate mirrored
    // outcome, not a process-level executor failure: it is a clean `failed`
    // executor terminal, not `manual_recovery_required`.
    expect(result.result.state).toBe("failed");
    expect(result.result.resultDigest).toBe(EVIDENCE.childRunId);
    expect(result.result.summary).toContain(EVIDENCE.childRunId);
    expect(result.result.summary).toContain("failed");
    expect(result.executorLogPath).toBe(EVIDENCE.executorLogPath);
    expect(result.resultJsonPath).toBe(EVIDENCE.resultJsonPath);
  });
});

describe("planSubworkflowChildMirror — ambiguous / blocked child runs fail closed", () => {
  it("routes a canceled child run to a fail-closed manual-recovery executor result", () => {
    const plan = planSubworkflowChildMirror("canceled", EVIDENCE);
    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.childState).toBe("canceled");
    const { result } = plan;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.code).toBe("manual_recovery_required");
    expect(result.error).toContain(EVIDENCE.childRunId);
    expect(result.error).toContain("canceled");
    expect(result.executorLogPath).toBe(EVIDENCE.executorLogPath);
    expect(result.resultJsonPath).toBe(EVIDENCE.resultJsonPath);
  });

  it("routes a blocked child run to a fail-closed manual-recovery executor result", () => {
    const plan = planSubworkflowChildMirror("blocked", EVIDENCE);
    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.childState).toBe("blocked");
    const { result } = plan;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.code).toBe("manual_recovery_required");
    expect(result.error).toContain(EVIDENCE.childRunId);
    expect(result.error).toContain("blocked");
  });
});

describe("planSubworkflowChildMirror — non-terminal child runs defer", () => {
  for (const childState of ["pending", "approved", "running"] as const) {
    it(`defers a ${childState} child run without producing terminal evidence`, () => {
      const plan = planSubworkflowChildMirror(childState, EVIDENCE);
      expect(plan.outcome).toBe("defer");
      if (plan.outcome !== "defer") throw new Error("expected defer outcome");
      expect(plan.childRunId).toBe(EVIDENCE.childRunId);
      expect(plan.childState).toBe(childState);
      expect(plan.reason).toContain(EVIDENCE.childRunId);
      expect(plan.reason).toContain(childState);
    });
  }

  it("routes an in-flight child already marked for manual recovery to fail-closed evidence", () => {
    const plan = planSubworkflowChildMirror("running", EVIDENCE, {
      childNeedsManualRecovery: true,
      childManualRecoveryReason: "child step requires operator recovery",
    });

    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.childState).toBe("running");
    expect(plan.result.ok).toBe(false);
    if (plan.result.ok) throw new Error("expected error result");
    expect(plan.result.code).toBe("manual_recovery_required");
    expect(plan.result.error).toContain(EVIDENCE.childRunId);
    expect(plan.result.error).toContain("manual recovery");
    expect(plan.result.error).toContain(
      "child step requires operator recovery",
    );
  });
});

describe("planSubworkflowChildMirror — composes with the terminalize bridge", () => {
  it("produces evidence the terminalize decider routes to a clean succeeded terminal", () => {
    const plan = planSubworkflowChildMirror("succeeded", EVIDENCE);
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(planDispatchedExecutorTerminalization(plan.result)).toEqual({
      outcome: "clean_terminal",
      attemptState: "succeeded",
      roundState: "succeeded",
      classification: "complete",
    });
  });

  it("produces evidence the terminalize decider routes to a clean failed terminal", () => {
    const plan = planSubworkflowChildMirror("failed", EVIDENCE);
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(planDispatchedExecutorTerminalization(plan.result)).toEqual({
      outcome: "clean_terminal",
      attemptState: "failed",
      roundState: "failed",
      classification: "failed",
    });
  });

  it("produces evidence the terminalize decider routes to manual recovery for a canceled child", () => {
    const plan = planSubworkflowChildMirror("canceled", EVIDENCE);
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    const terminalize = planDispatchedExecutorTerminalization(plan.result);
    expect(terminalize.outcome).toBe("manual_recovery");
    expect(terminalize.attemptState).toBe("manual_recovery_required");
  });

  it("produces evidence the terminalize decider routes to manual recovery for a blocked child", () => {
    const plan = planSubworkflowChildMirror("blocked", EVIDENCE);
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    const terminalize = planDispatchedExecutorTerminalization(plan.result);
    expect(terminalize.outcome).toBe("manual_recovery");
    expect(terminalize.attemptState).toBe("manual_recovery_required");
  });
});

describe("planSubworkflowChildMirror — totality", () => {
  it("never throws across every workflow run state", () => {
    for (const state of WORKFLOW_RUN_STATES) {
      expect(() => planSubworkflowChildMirror(state, EVIDENCE)).not.toThrow();
    }
  });

  it("returns one of the two discriminated outcomes for every run state", () => {
    for (const state of WORKFLOW_RUN_STATES) {
      const plan = planSubworkflowChildMirror(state, EVIDENCE);
      expect(["defer", "mirror"]).toContain(plan.outcome);
    }
  });

  it("treats an unexpected non-enum child state as fail-closed manual recovery", () => {
    // Defensive: durable substrate could carry an unexpected string the typed
    // union does not cover. The mapper must still fail closed, never throw or
    // fabricate a clean terminal.
    const plan = planSubworkflowChildMirror(
      "imploded" as WorkflowRunState,
      EVIDENCE,
    );
    expect(plan.outcome).toBe("mirror");
    if (plan.outcome !== "mirror") throw new Error("expected mirror outcome");
    expect(plan.result.ok).toBe(false);
    if (plan.result.ok) throw new Error("expected error result");
    expect(plan.result.code).toBe("manual_recovery_required");
  });
});
