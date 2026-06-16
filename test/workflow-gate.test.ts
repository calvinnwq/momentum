import { describe, expect, it } from "vitest";

import { EXECUTOR_HUMAN_GATE_TYPES } from "../src/core/executors/loop-reducer.js";
import {
  GATE_DECISION_MODES,
  GATE_DECISION_REFUSAL_CODES,
  WORKFLOW_GATE_SCOPES,
  WORKFLOW_GATE_TYPES,
  evaluateGateDecision,
  isWorkflowGateScope,
  isWorkflowGateType,
  type GateDecisionInput,
  type GateDecisionRequest
} from "../src/core/workflow/gate.js";

function gate(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    resolved: false,
    allowedActions: ["fix", "skip", "approve_as_is", "reject", "abort"],
    policyEnvelope: ["fix", "skip"],
    ...overrides
  };
}

function request(
  overrides: Partial<GateDecisionRequest> = {}
): GateDecisionRequest {
  return {
    action: "fix",
    actor: "calvin",
    mode: "operator",
    ...overrides
  };
}

describe("workflow-gate vocabulary", () => {
  it("re-exports the nine durable human-gate types pinned by the contract", () => {
    expect([...WORKFLOW_GATE_TYPES].sort()).toEqual(
      [
        "approval_required",
        "operator_decision_required",
        "manual_recovery_required",
        "policy_boundary_exceeded",
        "quota_exhausted",
        "scope_boundary_exceeded",
        "credential_required",
        "external_state_required",
        "destructive_action_requested"
      ].sort()
    );
  });

  it("shares one source of truth with the executor-loop human-gate types", () => {
    expect([...WORKFLOW_GATE_TYPES]).toEqual([...EXECUTOR_HUMAN_GATE_TYPES]);
  });

  it("exposes the four gate target scopes (workflow -> step -> invocation -> round)", () => {
    expect([...WORKFLOW_GATE_SCOPES]).toEqual([
      "workflow",
      "step",
      "invocation",
      "round"
    ]);
  });

  it("guards gate types", () => {
    expect(isWorkflowGateType("operator_decision_required")).toBe(true);
    expect(isWorkflowGateType("not_a_gate")).toBe(false);
  });

  it("guards gate scopes", () => {
    expect(isWorkflowGateScope("round")).toBe(true);
    expect(isWorkflowGateScope("executor")).toBe(false);
  });

  it("exposes the decision modes and refusal codes", () => {
    expect([...GATE_DECISION_MODES]).toEqual(["operator", "delegated"]);
    expect([...GATE_DECISION_REFUSAL_CODES].sort()).toEqual(
      [
        "action_required",
        "actor_required",
        "gate_already_resolved",
        "action_not_allowed",
        "delegated_action_outside_envelope"
      ].sort()
    );
  });
});

describe("evaluateGateDecision — operator decisions", () => {
  it("resolves the gate when an operator picks an allowed action", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "reject", actor: "calvin", mode: "operator" })
    );
    expect(outcome).toEqual({
      ok: true,
      resolution: {
        chosenAction: "reject",
        resolvedBy: "calvin",
        mode: "operator",
        resolution: null
      }
    });
  });

  it("lets an operator pick an allowed action outside the delegated envelope", () => {
    // `abort` is allowed but not in the policy envelope: delegated policy may
    // not auto-apply it, but an explicit operator can.
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "abort", mode: "operator" })
    );
    expect(outcome.ok).toBe(true);
  });

  it("carries the operator resolution note through to the outcome", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ resolutionNote: "verified locally" })
    );
    expect(outcome).toEqual({
      ok: true,
      resolution: {
        chosenAction: "fix",
        resolvedBy: "calvin",
        mode: "operator",
        resolution: "verified locally"
      }
    });
  });

  it("trims the requested action and actor before recording the resolution", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "  skip  ", actor: "  calvin  " })
    );
    expect(outcome).toEqual({
      ok: true,
      resolution: {
        chosenAction: "skip",
        resolvedBy: "calvin",
        mode: "operator",
        resolution: null
      }
    });
  });
});

describe("evaluateGateDecision — delegated policy", () => {
  it("auto-applies a delegated action inside the policy envelope", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "fix", actor: "agent-recommended-important", mode: "delegated" })
    );
    expect(outcome).toEqual({
      ok: true,
      resolution: {
        chosenAction: "fix",
        resolvedBy: "agent-recommended-important",
        mode: "delegated",
        resolution: null
      }
    });
  });

  it("pauses for an operator when the delegated action is outside the envelope", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "approve_as_is", mode: "delegated" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("delegated_action_outside_envelope");
  });

  it("pauses for an operator when the delegated envelope is empty", () => {
    const outcome = evaluateGateDecision(
      gate({ policyEnvelope: [] }),
      request({ action: "fix", mode: "delegated" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("delegated_action_outside_envelope");
  });
});

describe("evaluateGateDecision — refusals", () => {
  it("refuses an action that is not in the gate's allowed actions", () => {
    const outcome = evaluateGateDecision(
      gate(),
      request({ action: "nuke" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("action_not_allowed");
    expect(outcome.message).toContain("fix");
  });

  it("refuses a decision against an already-resolved gate", () => {
    const outcome = evaluateGateDecision(
      gate({ resolved: true }),
      request()
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("gate_already_resolved");
  });

  it("refuses a blank action", () => {
    const outcome = evaluateGateDecision(gate(), request({ action: "   " }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("action_required");
  });

  it("refuses a blank actor", () => {
    const outcome = evaluateGateDecision(gate(), request({ actor: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("actor_required");
  });

  it("checks request shape before gate state (blank action on a resolved gate)", () => {
    const outcome = evaluateGateDecision(
      gate({ resolved: true }),
      request({ action: "" })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("action_required");
  });

  it("is total: never throws on an out-of-envelope delegated action", () => {
    expect(() =>
      evaluateGateDecision(
        gate({ allowedActions: [], policyEnvelope: [] }),
        request({ action: "fix", mode: "delegated" })
      )
    ).not.toThrow();
  });
});
