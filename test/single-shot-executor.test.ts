import { describe, expect, it } from "vitest";

import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_INVOCATION_TERMINAL_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  transitionExecutorInvocation
} from "../src/executor-loop-reducer.js";
import { isWorkflowExecutorFamily } from "../src/workflow-definition.js";
import {
  SINGLE_SHOT_BLOCKED_RECOVERY_CODES,
  SINGLE_SHOT_EXECUTOR_FAMILIES,
  SINGLE_SHOT_FAILED_RECOVERY_CODES,
  SINGLE_SHOT_MANUAL_RECOVERY_CODES,
  SINGLE_SHOT_RECOVERY_CODES,
  decideSingleShotInvocation,
  isSingleShotExecutorFamily,
  planSingleShotInvocation,
  singleShotInvocationId,
  singleShotRoundId,
  type SingleShotInvocationOutcome
} from "../src/single-shot-executor.js";

const COMPLETION_SET = new Set<string>(EXECUTOR_COMPLETION_CLASSIFICATIONS);
const ROUND_TERMINAL_SET = new Set<string>(EXECUTOR_ROUND_TERMINAL_STATES);
const INVOCATION_TERMINAL_SET = new Set<string>(
  EXECUTOR_INVOCATION_TERMINAL_STATES
);
const HUMAN_GATE_SET = new Set<string>(EXECUTOR_HUMAN_GATE_TYPES);

describe("single-shot executor families", () => {
  it("serves exactly the one-shot and script executor families", () => {
    expect([...SINGLE_SHOT_EXECUTOR_FAMILIES].sort()).toEqual([
      "one-shot",
      "script"
    ]);
  });

  it("only names real workflow executor families", () => {
    for (const family of SINGLE_SHOT_EXECUTOR_FAMILIES) {
      expect(isWorkflowExecutorFamily(family)).toBe(true);
    }
  });

  it("recognizes the single-shot families and rejects the others", () => {
    expect(isSingleShotExecutorFamily("one-shot")).toBe(true);
    expect(isSingleShotExecutorFamily("script")).toBe(true);
    expect(isSingleShotExecutorFamily("goal-loop")).toBe(false);
    expect(isSingleShotExecutorFamily("no-mistakes")).toBe(false);
    expect(isSingleShotExecutorFamily("external-apply")).toBe(false);
    expect(isSingleShotExecutorFamily("subworkflow")).toBe(false);
  });
});

describe("single-shot recovery taxonomy", () => {
  it("partitions every recovery code into exactly one classification bucket", () => {
    const blocked = new Set<string>(SINGLE_SHOT_BLOCKED_RECOVERY_CODES);
    const failed = new Set<string>(SINGLE_SHOT_FAILED_RECOVERY_CODES);
    const manual = new Set<string>(SINGLE_SHOT_MANUAL_RECOVERY_CODES);

    for (const code of SINGLE_SHOT_RECOVERY_CODES) {
      const memberships = [
        blocked.has(code),
        failed.has(code),
        manual.has(code)
      ].filter(Boolean).length;
      expect(memberships).toBe(1);
    }

    expect(blocked.size + failed.size + manual.size).toBe(
      SINGLE_SHOT_RECOVERY_CODES.length
    );
  });

  it("reuses the live-wrapper execution codes and the unsafe-finalize codes", () => {
    // Execution-time codes mirror the M9 live step wrapper taxonomy.
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("runtime_unavailable");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("auth_unavailable");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("command_failed");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("command_timed_out");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("output_overflow");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("result_missing");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("result_invalid");
    // Unsafe repo-finalization codes mirror the goal-loop recovery vocabulary.
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("head_mismatch");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("repo_lock_lost");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("reset_failed");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("commit_failed");
    expect(SINGLE_SHOT_RECOVERY_CODES).toContain("git_failed");
  });
});

describe("decideSingleShotInvocation — success", () => {
  it("classifies a successful single-shot invocation as complete", () => {
    const decision = decideSingleShotInvocation({ ok: true });
    expect(decision.classification).toBe("complete");
    expect(decision.roundState).toBe("succeeded");
    expect(decision.invocationState).toBe("succeeded");
    expect(decision.recoveryCode).toBeNull();
    expect(decision.humanGate).toBeNull();
    expect(decision.reason).toMatch(/succeeded|complete/i);
  });
});

describe("decideSingleShotInvocation — blocked outcomes", () => {
  it("treats a missing runtime as a recoverable block, not a failure", () => {
    const decision = decideSingleShotInvocation({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
    expect(decision.classification).toBe("blocked");
    expect(decision.roundState).toBe("blocked");
    expect(decision.invocationState).toBe("blocked");
    expect(decision.recoveryCode).toBe("runtime_unavailable");
    expect(decision.humanGate).toBeNull();
  });

  it("raises a credential gate when auth is unavailable", () => {
    const decision = decideSingleShotInvocation({
      ok: false,
      recoveryCode: "auth_unavailable"
    });
    expect(decision.classification).toBe("blocked");
    expect(decision.roundState).toBe("blocked");
    expect(decision.recoveryCode).toBe("auth_unavailable");
    expect(decision.humanGate).toBe("credential_required");
  });
});

describe("decideSingleShotInvocation — execution failures", () => {
  it.each([
    "command_failed",
    "command_timed_out",
    "output_overflow",
    "result_missing",
    "result_invalid"
  ] as const)("classifies %s as a terminal failure", (recoveryCode) => {
    const decision = decideSingleShotInvocation({ ok: false, recoveryCode });
    expect(decision.classification).toBe("failed");
    expect(decision.roundState).toBe("failed");
    expect(decision.invocationState).toBe("failed");
    expect(decision.recoveryCode).toBe(recoveryCode);
    expect(decision.humanGate).toBeNull();
  });
});

describe("decideSingleShotInvocation — manual recovery", () => {
  it.each([
    "head_mismatch",
    "repo_lock_lost",
    "reset_failed",
    "commit_failed",
    "git_failed",
    "invalid_input"
  ] as const)(
    "routes the unsafe finalize outcome %s to manual recovery",
    (recoveryCode) => {
      const decision = decideSingleShotInvocation({ ok: false, recoveryCode });
      expect(decision.classification).toBe("manual_recovery_required");
      expect(decision.roundState).toBe("manual_recovery_required");
      expect(decision.invocationState).toBe("manual_recovery_required");
      expect(decision.recoveryCode).toBe(recoveryCode);
      expect(decision.humanGate).toBe("manual_recovery_required");
    }
  );
});

describe("decideSingleShotInvocation — totality", () => {
  it("maps every recovery code to a terminal, never-complete decision", () => {
    for (const recoveryCode of SINGLE_SHOT_RECOVERY_CODES) {
      const decision = decideSingleShotInvocation({ ok: false, recoveryCode });
      expect(COMPLETION_SET.has(decision.classification)).toBe(true);
      expect(ROUND_TERMINAL_SET.has(decision.roundState)).toBe(true);
      expect(INVOCATION_TERMINAL_SET.has(decision.invocationState)).toBe(true);
      // A failed invocation can never be classified complete or continue.
      expect(decision.classification).not.toBe("complete");
      expect(decision.classification).not.toBe("continue");
      // The exact code is always preserved for recovery surfaces.
      expect(decision.recoveryCode).toBe(recoveryCode);
      // Any human gate is from the contract vocabulary.
      if (decision.humanGate !== null) {
        expect(HUMAN_GATE_SET.has(decision.humanGate)).toBe(true);
      }
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws on an unknown recovery code rather than guessing a classification", () => {
    const outcome = {
      ok: false,
      recoveryCode: "not_a_real_code"
    } as unknown as SingleShotInvocationOutcome;
    expect(() => decideSingleShotInvocation(outcome)).toThrow(/recovery code/i);
  });
});

describe("singleShotInvocationId / singleShotRoundId", () => {
  it("embeds the step-run identity, family, and attempt", () => {
    expect(singleShotInvocationId("run1", "step1", "one-shot", 0)).toBe(
      "run1::step1::one-shot::0"
    );
    expect(singleShotInvocationId("run1", "step1", "script", 2)).toBe(
      "run1::step1::script::2"
    );
  });

  it("distinguishes families and attempts so re-runs never collide", () => {
    const a = singleShotInvocationId("run1", "step1", "one-shot", 0);
    const b = singleShotInvocationId("run1", "step1", "script", 0);
    const c = singleShotInvocationId("run1", "step1", "one-shot", 1);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("mints a single deterministic round id under an invocation", () => {
    const invocationId = singleShotInvocationId("run1", "step1", "one-shot", 0);
    const roundId = singleShotRoundId(invocationId);
    expect(roundId).toContain(invocationId);
    // Stable: the same invocation always yields the same single round id.
    expect(singleShotRoundId(invocationId)).toBe(roundId);
  });
});

describe("planSingleShotInvocation", () => {
  it("projects a step-run identity into a running invocation record", () => {
    const invocation = planSingleShotInvocation({
      family: "one-shot",
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "preflight",
      attempt: 0,
      startedAt: 1000
    });
    expect(invocation.invocationId).toBe(
      singleShotInvocationId("run1", "step1", "one-shot", 0)
    );
    expect(invocation.workflowRunId).toBe("run1");
    expect(invocation.stepRunId).toBe("step1");
    expect(invocation.stepKey).toBe("preflight");
    expect(invocation.executorFamily).toBe("one-shot");
    expect(invocation.attempt).toBe(0);
    expect(invocation.state).toBe("running");
    expect(invocation.startedAt).toBe(1000);
    expect(invocation.heartbeatAt).toBe(1000);
    expect(invocation.finishedAt).toBeNull();
  });

  it("carries the script family through unchanged", () => {
    const invocation = planSingleShotInvocation({
      family: "script",
      workflowRunId: "run9",
      stepRunId: "step9",
      stepKey: "merge-cleanup",
      attempt: 3,
      startedAt: 50
    });
    expect(invocation.executorFamily).toBe("script");
    expect(invocation.attempt).toBe(3);
    expect(invocation.invocationId).toBe(
      singleShotInvocationId("run9", "step9", "script", 3)
    );
  });

  it("starts an invocation that can legally transition to its terminal state", () => {
    const invocation = planSingleShotInvocation({
      family: "script",
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "merge-cleanup",
      attempt: 0,
      startedAt: 1
    });
    const decision = decideSingleShotInvocation({ ok: true });
    const transition = transitionExecutorInvocation(
      invocation.state,
      decision.invocationState
    );
    expect(transition.ok).toBe(true);
    expect(isTerminalExecutorInvocationState(decision.invocationState)).toBe(
      true
    );
    expect(isTerminalExecutorRoundState(decision.roundState)).toBe(true);
  });
});
