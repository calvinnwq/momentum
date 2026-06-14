import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type { GateDecisionRequest } from "../src/workflow-gate.js";
import {
  InvalidWorkflowGateError,
  WorkflowGateConflictError,
  WorkflowGateDecisionError,
  WorkflowGateNotFoundError,
  insertWorkflowGate,
  listOpenWorkflowGatesForRun,
  listWorkflowGatesForRun,
  loadWorkflowGate,
  resolveWorkflowGate,
  type NewWorkflowGate
} from "../src/workflow-gate-persist.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-gate-persist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Every gate carries a NOT NULL workflow_run_id FK to workflow_runs(id), so seed
// the minimal run (and a step the deeper scopes point at) the fixtures use.
function seedRunAndStep(
  db: MomentumDb,
  runId = "run-1",
  stepId = "step-1"
): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES (?, 'test', 1, 1)"
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES (?, ?, 'implementation', 0, 1, 1)`
  ).run(runId, stepId);
}

function openSeededDb(): MomentumDb {
  const db = openDb(makeTempDir());
  seedRunAndStep(db);
  return db;
}

// A round-scoped gate carrying its full ancestry.
function roundGate(overrides: Partial<NewWorkflowGate> = {}): NewWorkflowGate {
  return {
    gateId: "gate-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    invocationId: "inv-1",
    roundId: "round-1",
    targetScope: "round",
    gateType: "operator_decision_required",
    reason: "round 3 produced a decision point",
    evidence: "goals/run-1/gates/gate-1.json",
    allowedActions: ["fix", "skip", "approve_as_is", "abort"],
    recommendedAction: "fix",
    policyEnvelope: ["fix", "skip"],
    ...overrides
  };
}

// A workflow-scoped gate that hangs from the whole run only.
function workflowGate(
  overrides: Partial<NewWorkflowGate> = {}
): NewWorkflowGate {
  return {
    gateId: "gate-wf",
    workflowRunId: "run-1",
    targetScope: "workflow",
    gateType: "approval_required",
    reason: "workflow boundary needs an approval",
    allowedActions: ["approve", "reject"],
    ...overrides
  };
}

function request(
  overrides: Partial<GateDecisionRequest> = {}
): GateDecisionRequest {
  return { action: "fix", actor: "calvin", mode: "operator", ...overrides };
}

describe("insertWorkflowGate", () => {
  it("inserts an open round-scoped gate that round-trips through loadWorkflowGate", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 5 });

    expect(loadWorkflowGate(db, "gate-1")).toEqual({
      gateId: "gate-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      invocationId: "inv-1",
      roundId: "round-1",
      targetScope: "round",
      gateType: "operator_decision_required",
      reason: "round 3 produced a decision point",
      evidence: "goals/run-1/gates/gate-1.json",
      allowedActions: ["fix", "skip", "approve_as_is", "abort"],
      recommendedAction: "fix",
      policyEnvelope: ["fix", "skip"],
      resolvedAt: null,
      resolvedBy: null,
      resolutionMode: null,
      chosenAction: null,
      resolution: null
    });
  });

  it("inserts a workflow-scoped gate that hangs from the run only", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, workflowGate(), { now: 1 });
    const loaded = loadWorkflowGate(db, "gate-wf");
    expect(loaded?.targetScope).toBe("workflow");
    expect(loaded?.stepRunId).toBeNull();
    expect(loaded?.invocationId).toBeNull();
    expect(loaded?.roundId).toBeNull();
  });

  it("defaults evidence/recommendedAction to null and policyEnvelope to empty", () => {
    const db = openSeededDb();
    // workflowGate() omits evidence / recommendedAction / policyEnvelope.
    insertWorkflowGate(db, workflowGate(), { now: 1 });
    const loaded = loadWorkflowGate(db, "gate-wf");
    expect(loaded?.evidence).toBeNull();
    expect(loaded?.recommendedAction).toBeNull();
    expect(loaded?.policyEnvelope).toEqual([]);
  });

  it("returns undefined when loading an unknown gate id", () => {
    const db = openSeededDb();
    expect(loadWorkflowGate(db, "missing")).toBeUndefined();
  });

  it("refuses a duplicate gate id and leaves the existing row untouched", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate({ reason: "first" }), { now: 1 });
    expect(() =>
      insertWorkflowGate(db, roundGate({ reason: "second" }), { now: 2 })
    ).toThrow(WorkflowGateConflictError);
    expect(loadWorkflowGate(db, "gate-1")?.reason).toBe("first");
  });

  it("refuses an unknown gate type without writing a row", () => {
    const db = openSeededDb();
    expect(() =>
      insertWorkflowGate(
        db,
        roundGate({ gateType: "not_a_gate" as never }),
        { now: 1 }
      )
    ).toThrow(InvalidWorkflowGateError);
    expect(loadWorkflowGate(db, "gate-1")).toBeUndefined();
  });

  it("refuses an unknown target scope without writing a row", () => {
    const db = openSeededDb();
    expect(() =>
      insertWorkflowGate(
        db,
        roundGate({ targetScope: "executor" as never }),
        { now: 1 }
      )
    ).toThrow(InvalidWorkflowGateError);
    expect(loadWorkflowGate(db, "gate-1")).toBeUndefined();
  });

  it("refuses a gate whose scope anchor id is missing", () => {
    const db = openSeededDb();
    // round scope requires a round_id
    expect(() =>
      insertWorkflowGate(db, roundGate({ roundId: null }), { now: 1 })
    ).toThrow(InvalidWorkflowGateError);
  });

  it("refuses a gate carrying an id deeper than its scope", () => {
    const db = openSeededDb();
    // workflow scope must not carry a step/invocation/round id
    expect(() =>
      insertWorkflowGate(
        db,
        workflowGate({ stepRunId: "step-1" }),
        { now: 1 }
      )
    ).toThrow(InvalidWorkflowGateError);
  });

  it("refuses a blank reason", () => {
    const db = openSeededDb();
    expect(() =>
      insertWorkflowGate(db, workflowGate({ reason: "   " }), { now: 1 })
    ).toThrow(InvalidWorkflowGateError);
  });

  it("enforces the workflow_run_id foreign key", () => {
    const db = openDb(makeTempDir()); // no run seeded
    expect(() =>
      insertWorkflowGate(db, workflowGate(), { now: 1 })
    ).toThrow();
  });
});

describe("listWorkflowGatesForRun / listOpenWorkflowGatesForRun", () => {
  it("lists every gate for a run oldest first", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate({ gateId: "gate-a" }), { now: 1 });
    insertWorkflowGate(db, roundGate({ gateId: "gate-b" }), { now: 2 });
    expect(listWorkflowGatesForRun(db, "run-1").map((g) => g.gateId)).toEqual([
      "gate-a",
      "gate-b"
    ]);
  });

  it("lists only unresolved gates as open", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate({ gateId: "gate-open" }), { now: 1 });
    insertWorkflowGate(db, roundGate({ gateId: "gate-done" }), { now: 2 });
    resolveWorkflowGate(db, "gate-done", request(), { now: 3 });
    expect(
      listOpenWorkflowGatesForRun(db, "run-1").map((g) => g.gateId)
    ).toEqual(["gate-open"]);
  });
});

describe("resolveWorkflowGate", () => {
  it("resolves an open gate when an operator picks an allowed action", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    const resolved = resolveWorkflowGate(
      db,
      "gate-1",
      request({ action: "abort", actor: "calvin", mode: "operator" }),
      { now: 9 }
    );
    expect(resolved.resolvedAt).toBe(9);
    expect(resolved.resolvedBy).toBe("calvin");
    expect(resolved.resolutionMode).toBe("operator");
    expect(resolved.chosenAction).toBe("abort");
    expect(resolved.resolution).toBeNull();
    // durable
    expect(loadWorkflowGate(db, "gate-1")?.chosenAction).toBe("abort");
  });

  it("carries the resolution note through to the durable record", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    const resolved = resolveWorkflowGate(
      db,
      "gate-1",
      request({ resolutionNote: "verified locally" }),
      { now: 2 }
    );
    expect(resolved.resolution).toBe("verified locally");
  });

  it("auto-applies a delegated action inside the policy envelope", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    const resolved = resolveWorkflowGate(
      db,
      "gate-1",
      request({ action: "skip", actor: "policy:auto", mode: "delegated" }),
      { now: 2 }
    );
    expect(resolved.resolutionMode).toBe("delegated");
    expect(resolved.chosenAction).toBe("skip");
  });

  it("refuses a delegated action outside the envelope and leaves the gate open", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    try {
      resolveWorkflowGate(
        db,
        "gate-1",
        request({ action: "approve_as_is", mode: "delegated" }),
        { now: 2 }
      );
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGateDecisionError);
      expect((error as WorkflowGateDecisionError).code).toBe(
        "delegated_action_outside_envelope"
      );
    }
    expect(loadWorkflowGate(db, "gate-1")?.resolvedAt).toBeNull();
  });

  it("refuses an action the gate does not allow", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    try {
      resolveWorkflowGate(db, "gate-1", request({ action: "nuke" }), {
        now: 2
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGateDecisionError);
      expect((error as WorkflowGateDecisionError).code).toBe(
        "action_not_allowed"
      );
    }
  });

  it("refuses re-resolving an already-resolved gate", () => {
    const db = openSeededDb();
    insertWorkflowGate(db, roundGate(), { now: 1 });
    resolveWorkflowGate(db, "gate-1", request(), { now: 2 });
    try {
      resolveWorkflowGate(db, "gate-1", request({ action: "skip" }), {
        now: 3
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGateDecisionError);
      expect((error as WorkflowGateDecisionError).code).toBe(
        "gate_already_resolved"
      );
    }
    // the original resolution is untouched
    expect(loadWorkflowGate(db, "gate-1")?.chosenAction).toBe("fix");
  });

  it("throws when resolving an unknown gate", () => {
    const db = openSeededDb();
    expect(() =>
      resolveWorkflowGate(db, "missing", request(), { now: 1 })
    ).toThrow(WorkflowGateNotFoundError);
  });
});
