import { describe, expect, it } from "vitest";

import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_ATTEMPT_STATES,
  EXECUTOR_ATTEMPT_TERMINAL_STATES,
  EXECUTOR_ROUND_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  isTerminalExecutorAttemptState,
  isTerminalExecutorRoundState,
  selectExecutorDecisionForHumanGate,
  transitionExecutorAttempt,
  transitionExecutorRound,
  type ExecutorDefinitionRecord,
  type ExecutorAttemptRecord,
  type ExecutorAttemptState,
  type ExecutorRoundRecord,
  type ExecutorRoundState,
} from "../src/core/executors/loop/reducer.js";

describe("executor-loop-reducer vocabulary", () => {
  it("exposes the attempt states pinned by the executor-loop contract", () => {
    expect([...EXECUTOR_ATTEMPT_STATES].sort()).toEqual(
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
        "cancelled",
      ].sort(),
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
        "cancelled",
      ].sort(),
    );
  });

  it("flags the same terminal set for attempts and rounds", () => {
    const expected = [
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ].sort();
    expect([...EXECUTOR_ATTEMPT_TERMINAL_STATES].sort()).toEqual(expected);
    expect([...EXECUTOR_ROUND_TERMINAL_STATES].sort()).toEqual(expected);
  });

  it("treats waiting_operator as a durable, non-terminal pause", () => {
    expect(isTerminalExecutorAttemptState("waiting_operator")).toBe(false);
    expect(isTerminalExecutorRoundState("waiting_operator")).toBe(false);
    expect(isTerminalExecutorAttemptState("succeeded")).toBe(true);
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
        "cancelled",
      ].sort(),
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
      "destructive_action_requested",
    ]) {
      expect(gates.has(gate as never), `gate ${gate}`).toBe(true);
    }
    expect(EXECUTOR_HUMAN_GATE_TYPES).toHaveLength(9);
  });
});

describe("transitionExecutorAttempt", () => {
  it("accepts the happy path pending -> preparing -> running -> succeeded", () => {
    expect(transitionExecutorAttempt("pending", "preparing").ok).toBe(true);
    expect(transitionExecutorAttempt("preparing", "running").ok).toBe(true);
    const succeed = transitionExecutorAttempt("running", "succeeded");
    expect(succeed.ok).toBe(true);
    if (succeed.ok) expect(succeed.state).toBe("succeeded");
  });

  it("accepts running -> pausing -> waiting_operator then resumes waiting_operator -> running", () => {
    expect(transitionExecutorAttempt("running", "pausing").ok).toBe(true);
    expect(transitionExecutorAttempt("pausing", "waiting_operator").ok).toBe(
      true,
    );
    // waiting_operator is a durable pause: it can be resumed, never a terminal.
    expect(transitionExecutorAttempt("waiting_operator", "running").ok).toBe(
      true,
    );
  });

  it("accepts an abort to any failure-ish terminal from every active state", () => {
    const active: ExecutorAttemptState[] = [
      "pending",
      "preparing",
      "running",
      "pausing",
      "waiting_operator",
    ];
    const aborts: ExecutorAttemptState[] = [
      "blocked",
      "failed",
      "manual_recovery_required",
      "cancelled",
    ];
    for (const from of active) {
      for (const to of aborts) {
        expect(
          transitionExecutorAttempt(from, to).ok,
          `${from} -> ${to}`,
        ).toBe(true);
      }
    }
  });

  it("refuses to reach succeeded without running first", () => {
    for (const from of [
      "pending",
      "preparing",
      "pausing",
      "waiting_operator",
    ] as const) {
      const result = transitionExecutorAttempt(from, "succeeded");
      expect(result.ok, `${from} -> succeeded`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("executor_attempt_invalid_transition");
      }
    }
  });

  it("refuses to skip preparing (pending -> running)", () => {
    const result = transitionExecutorAttempt("pending", "running");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_attempt_invalid_transition");
    }
  });

  it("refuses to transition out of a terminal attempt state", () => {
    for (const from of EXECUTOR_ATTEMPT_TERMINAL_STATES) {
      const result = transitionExecutorAttempt(from, "running");
      expect(result.ok, `${from} -> running`).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("executor_attempt_terminal");
      }
    }
  });

  it("refuses an unknown state with executor_attempt_unknown_state", () => {
    const result = transitionExecutorAttempt(
      "bogus" as never,
      "running" as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("executor_attempt_unknown_state");
    }
  });

  it("allows same-state self transitions as a no-op success", () => {
    const result = transitionExecutorAttempt("running", "running");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBe("running");
  });
});

describe("transitionExecutorRound", () => {
  it("accepts the local happy path pending -> running -> capturing_result -> finalizing -> succeeded", () => {
    expect(transitionExecutorRound("pending", "running").ok).toBe(true);
    expect(transitionExecutorRound("running", "capturing_result").ok).toBe(
      true,
    );
    expect(transitionExecutorRound("capturing_result", "finalizing").ok).toBe(
      true,
    );
    const succeed = transitionExecutorRound("finalizing", "succeeded");
    expect(succeed.ok).toBe(true);
    if (succeed.ok) expect(succeed.state).toBe("succeeded");
  });

  it("accepts the external-mirror path pending -> mirroring_external_state -> succeeded", () => {
    expect(
      transitionExecutorRound("pending", "mirroring_external_state").ok,
    ).toBe(true);
    expect(
      transitionExecutorRound("mirroring_external_state", "succeeded").ok,
    ).toBe(true);
  });

  it("accepts succeeding straight from capturing_result when no finalization is needed", () => {
    expect(transitionExecutorRound("capturing_result", "succeeded").ok).toBe(
      true,
    );
  });

  it("resumes a paused round from waiting_operator back into any active processing state", () => {
    for (const to of [
      "running",
      "capturing_result",
      "finalizing",
      "mirroring_external_state",
    ] as const) {
      expect(
        transitionExecutorRound("waiting_operator", to).ok,
        `waiting_operator -> ${to}`,
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
      "waiting_operator",
    ];
    const aborts: ExecutorRoundState[] = [
      "blocked",
      "failed",
      "manual_recovery_required",
      "cancelled",
    ];
    for (const from of active) {
      for (const to of aborts) {
        expect(transitionExecutorRound(from, to).ok, `${from} -> ${to}`).toBe(
          true,
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
      "capturing_result",
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
      policyEnvelope: "overnight-safe",
    };
    expect(def.family).toBe("goal-loop");
    expect(def.maxRounds).toBe(8);
  });

  it("models an ExecutorAttempt nested below a StepRun", () => {
    const attempt: ExecutorAttemptRecord = {
      attemptId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-impl",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      state: "running",
      attemptNumber: 1,
      startedAt: 1_000,
      heartbeatAt: 1_500,
      finishedAt: null,
    };
    expect(attempt.state).toBe("running");
    expect(attempt.executorFamily).toBe("goal-loop");
  });

  it("models an ExecutorRound carrying the common result schema fields", () => {
    const round: ExecutorRoundRecord = {
      roundId: "round-1",
      attemptId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-impl",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      attemptNumber: 1,
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
      keyLearnings: [],
      remainingWork: [],
      changedFiles: ["src/executor-loop-reducer.ts"],
      verificationStatus: "passed",
      commitSha: "abc123",
      recoveryCode: null,
      humanGate: null,
    };
    expect(round.classification).toBe("complete");
    expect(round.state).toBe("succeeded");
    expect(round.logPaths).toHaveLength(1);
    expect(round.remainingWork).toEqual([]);
  });
});

describe("selectExecutorDecisionForHumanGate", () => {
  it("skips decisions resolved without a chosen action", () => {
    const decisions = [
      {
        decisionId: "resolved",
        chosenAction: null,
        resolution: "delegated:within-envelope",
      },
      {
        decisionId: "current",
        chosenAction: null,
        resolution: null,
      },
    ];

    expect(selectExecutorDecisionForHumanGate(decisions, undefined)).toBe(
      decisions[1],
    );
    expect(selectExecutorDecisionForHumanGate(decisions, "resolved")).toBe(
      undefined,
    );
  });

  it("skips decisions with a chosen action but no resolution", () => {
    const decisions = [
      {
        decisionId: "partially-resolved",
        chosenAction: "approve",
        resolution: null,
      },
    ];

    expect(selectExecutorDecisionForHumanGate(decisions, undefined)).toBe(
      undefined,
    );
    expect(
      selectExecutorDecisionForHumanGate(decisions, "partially-resolved"),
    ).toBe(undefined);
  });
});
