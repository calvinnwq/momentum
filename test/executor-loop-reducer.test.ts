import { describe, expect, it } from "vitest";

import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_INVOCATION_STATES,
  EXECUTOR_INVOCATION_TERMINAL_STATES,
  EXECUTOR_ROUND_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  transitionExecutorInvocation,
  transitionExecutorRound,
  type ExecutorDefinitionRecord,
  type ExecutorInvocationRecord,
  type ExecutorInvocationState,
  type ExecutorRoundRecord,
  type ExecutorRoundState
} from "../src/core/executors/loop/reducer.js";

describe("executor-loop-reducer vocabulary", () => {
  it("exposes the invocation states pinned by the executor-loop contract", () => {
    expect([...EXECUTOR_INVOCATION_STATES].sort()).toEqual(
      [
        "pending",
        "preparing",
        "running",
        "pausing",
        "waiting_operator",
        "manual_recovery_required",
        "blocked",
        "failed",
        "succeeded",
        "cancelled"
      ].sort()
    );
  });

  it("exposes the round states pinned by the executor-loop contract", () => {
    expect([...EXECUTOR_ROUND_STATES].sort()).toEqual(
      [
        "pending",
        "running",
        "capturing_result",
        "finalizing",
        "mirroring_external_state",
        "waiting_operator",
        "manual_recovery_required",
        "blocked",
        "failed",
        "succeeded",
        "cancelled"
      ].sort()
    );
  });

  it("flags the same terminal set for invocations and rounds", () => {
    const expected = [
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled"
    ].sort();
    expect([...EXECUTOR_INVOCATION_TERMINAL_STATES].sort()).toEqual(expected);
    expect([...EXECUTOR_ROUND_TERMINAL_STATES].sort()).toEqual(expected);
  });

  it("treats waiting_operator as a durable, non-terminal pause", () => {
    expect(isTerminalExecutorInvocationState("waiting_operator")).toBe(false);
    expect(isTerminalExecutorRoundState("waiting_operator")).toBe(false);
    expect(isTerminalExecutorInvocationState("succeeded")).toBe(true);
    expect(isTerminalExecutorRoundState("blocked")).toBe(true);
  });

  it("exposes the completion classification taxonomy", () => {
    expect([...EXECUTOR_COMPLETION_CLASSIFICATIONS].sort()).toEqual(
      [
        "complete",
        "continue",
        "approval_required",
        "operator_decision_required",
        "manual_recovery_required",
        "blocked",
        "failed",
        "cancelled"
      ].sort()
    );
  });

  it("exposes the human-gate taxonomy", () => {
    const gates = new Set(EXECUTOR_HUMAN_GATE_TYPES);
    for (const gate of [
      "approval_required",
      "operator_decision_required",
      "manual_recovery_required",
      "policy_boundary_exceeded",
      "quota_exhausted",
      "scope_boundary_exceeded",
      "credential_required",
      "external_state_required",
      "destructive_action_requested"
    ]) {
      expect(gates.has(gate as never), `gate ${gate}`).toBe(true);
    }
    expect(EXECUTOR_HUMAN_GATE_TYPES).toHaveLength(9);
  });
});

describe("transitionExecutorInvocation", () => {
  it("accepts the happy path pending -> preparing -> running -> succeeded", () => {
    expect(transitionExecutorInvocation("pending", "preparing").ok).toBe(true);
    expect(transitionExecutorInvocation("preparing", "running").ok).toBe(true);
    const succeed = transitionExecutorInvocation("running", "succeeded");
    expect(succeed.ok).toBe(true);
    if (succeed.ok) expect(succeed.state).toBe("succeeded");
  });

  it("accepts running -> pausing -> waiting_operator then resumes waiting_operator -> running", () => {
    expect(transitionExecutorInvocation("running", "pausing").ok).toBe(true);
    expect(transitionExecutorInvocation("pausing", "waiting_operator").ok).toBe(
      true
    );
    // waiting_operator is a durable pause: it can be resumed, never a terminal.
    expect(transitionExecutorInvocation("waiting_operator", "running").ok).toBe(
      true
    );
  });

  it("accepts an abort to any failure-ish terminal from every active state", () => {
    const active: ExecutorInvocationState[] = [
      "pending",
      "preparing",
      "running",
      "pausing",
      "waiting_operator"
    ];
    const aborts: ExecutorInvocationState[] = [
      "blocked",
      "failed",
      "manual_recovery_required",
      "cancelled"
    ];
    for (const from of active) {
      for (const to of aborts) {
        expect(
          transitionExecutorInvocation(from, to).ok,
          `${from} -> ${to}`
        ).toBe(true);
      }
    }
  });

  it("refuses to reach succeeded without running first", () => {
    for (const from of [
      "pending",
      "preparing",
      "pausing",
      "waiting_operator"
    ] as const) {
      const result = transitionExecutorInvocation(from, "succeeded");
      expect(result.ok, `${from} -> succeeded`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("executor_invocation_invalid_transition");
      }
    }
  });

  it("refuses to skip preparing (pending -> running)", () => {
    const result = transitionExecutorInvocation("pending", "running");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_invocation_invalid_transition");
    }
  });

  it("refuses to transition out of a terminal invocation state", () => {
    for (const from of EXECUTOR_INVOCATION_TERMINAL_STATES) {
      const result = transitionExecutorInvocation(from, "running");
      expect(result.ok, `${from} -> running`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("executor_invocation_terminal");
      }
    }
  });

  it("refuses an unknown state with executor_invocation_unknown_state", () => {
    const result = transitionExecutorInvocation(
      "bogus" as never,
      "running" as never
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_invocation_unknown_state");
    }
  });

  it("allows same-state self transitions as a no-op success", () => {
    const result = transitionExecutorInvocation("running", "running");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("running");
  });
});

describe("transitionExecutorRound", () => {
  it("accepts the local happy path pending -> running -> capturing_result -> finalizing -> succeeded", () => {
    expect(transitionExecutorRound("pending", "running").ok).toBe(true);
    expect(transitionExecutorRound("running", "capturing_result").ok).toBe(true);
    expect(transitionExecutorRound("capturing_result", "finalizing").ok).toBe(
      true
    );
    const succeed = transitionExecutorRound("finalizing", "succeeded");
    expect(succeed.ok).toBe(true);
    if (succeed.ok) expect(succeed.state).toBe("succeeded");
  });

  it("accepts the external-mirror path pending -> mirroring_external_state -> succeeded", () => {
    expect(transitionExecutorRound("pending", "mirroring_external_state").ok).toBe(
      true
    );
    expect(
      transitionExecutorRound("mirroring_external_state", "succeeded").ok
    ).toBe(true);
  });

  it("accepts succeeding straight from capturing_result when no finalization is needed", () => {
    expect(transitionExecutorRound("capturing_result", "succeeded").ok).toBe(
      true
    );
  });

  it("resumes a paused round from waiting_operator back into any active processing state", () => {
    for (const to of [
      "running",
      "capturing_result",
      "finalizing",
      "mirroring_external_state"
    ] as const) {
      expect(
        transitionExecutorRound("waiting_operator", to).ok,
        `waiting_operator -> ${to}`
      ).toBe(true);
    }
  });

  it("accepts an abort to any failure-ish terminal from every active state", () => {
    const active: ExecutorRoundState[] = [
      "pending",
      "running",
      "capturing_result",
      "finalizing",
      "mirroring_external_state",
      "waiting_operator"
    ];
    const aborts: ExecutorRoundState[] = [
      "blocked",
      "failed",
      "manual_recovery_required",
      "cancelled"
    ];
    for (const from of active) {
      for (const to of aborts) {
        expect(transitionExecutorRound(from, to).ok, `${from} -> ${to}`).toBe(
          true
        );
      }
    }
  });

  it("refuses to skip the normalized result step (running -> succeeded)", () => {
    const result = transitionExecutorRound("running", "succeeded");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_round_invalid_transition");
    }
  });

  it("refuses to reach succeeded straight from pending", () => {
    const result = transitionExecutorRound("pending", "succeeded");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_round_invalid_transition");
    }
  });

  it("refuses to transition out of a terminal round state", () => {
    for (const from of EXECUTOR_ROUND_TERMINAL_STATES) {
      const result = transitionExecutorRound(from, "running");
      expect(result.ok, `${from} -> running`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("executor_round_terminal");
      }
    }
  });

  it("refuses an unknown state with executor_round_unknown_state", () => {
    const result = transitionExecutorRound("pending", "bogus" as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_round_unknown_state");
    }
  });

  it("allows same-state self transitions as a no-op success", () => {
    const result = transitionExecutorRound(
      "capturing_result",
      "capturing_result"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("capturing_result");
  });
});

describe("executor-loop record shapes", () => {
  it("models an ExecutorDefinition as the rich per-step executor config", () => {
    const def: ExecutorDefinitionRecord = {
      executorKey: "implementation-goal-loop",
      family: "goal-loop",
      agentProvider: "claude-code",
      model: "claude-opus-4-8",
      effort: "high",
      timeoutMs: 3_600_000,
      maxRounds: 8,
      policyEnvelope: "overnight-safe"
    };
    expect(def.family).toBe("goal-loop");
    expect(def.maxRounds).toBe(8);
  });

  it("models an ExecutorInvocation nested below a StepRun", () => {
    const invocation: ExecutorInvocationRecord = {
      invocationId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-impl",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      state: "running",
      attempt: 1,
      startedAt: 1_000,
      heartbeatAt: 1_500,
      finishedAt: null
    };
    expect(invocation.state).toBe("running");
    expect(invocation.executorFamily).toBe("goal-loop");
  });

  it("models an ExecutorRound carrying the common result schema fields", () => {
    const round: ExecutorRoundRecord = {
      roundId: "round-1",
      invocationId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-impl",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      attempt: 1,
      roundIndex: 0,
      state: "succeeded",
      classification: "complete",
      startedAt: 1_000,
      heartbeatAt: 1_500,
      finishedAt: 2_000,
      agentProvider: "claude-code",
      model: "claude-opus-4-8",
      effort: "high",
      inputDigest: "sha256:in",
      resultDigest: "sha256:out",
      artifactRoot: "goals/g-1/rounds/round-1",
      logPaths: ["goals/g-1/rounds/round-1/stdout.log"],
      summary: "Implemented the schema.",
      keyChanges: ["Added executor-loop-reducer.ts"],
      remainingWork: [],
      changedFiles: ["src/executor-loop-reducer.ts"],
      verificationStatus: "passed",
      commitSha: "abc123",
      recoveryCode: null,
      humanGate: null
    };
    expect(round.classification).toBe("complete");
    expect(round.state).toBe("succeeded");
    expect(round.logPaths).toHaveLength(1);
    expect(round.remainingWork).toEqual([]);
  });
});
