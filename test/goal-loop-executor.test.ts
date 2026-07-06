import { describe, expect, it } from "vitest";

import {
  EXECUTOR_ARTIFACT_CLASSES,
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_INVOCATION_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  transitionExecutorRound,
  type ExecutorCompletionClassification
} from "../src/core/executors/loop/reducer.js";
import {
  GOAL_LOOP_GLOBAL_DEFAULT_SELECTION,
  decideGoalLoopRound,
  goalLoopFinalizeEvidenceFromResult,
  goalLoopInvocationId,
  goalLoopRecommendationFromResult,
  goalLoopRoundId,
  invocationStateForRoundClassification,
  planGoalLoopInvocation,
  planGoalLoopRoundArtifacts,
  planGoalLoopRoundCheckpoints,
  planGoalLoopRoundPersistence,
  planGoalLoopRoundStart,
  planGoalLoopRoundStartForInvocation,
  resolveGoalLoopRoundSelection,
  type DecideGoalLoopRoundInput,
  type GoalLoopFinalizeOutcome,
  type GoalLoopRoundArtifacts,
  type GoalLoopRoundSelection,
  type PlanGoalLoopRoundStartInput
} from "../src/core/executors/goal-loop/executor.js";
import type { FinalizeWorkflowStepFromResultFileResult } from "../src/core/executors/shared/step-finalize.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";

const COMPLETION_SET = new Set<string>(EXECUTOR_COMPLETION_CLASSIFICATIONS);
const ROUND_TERMINAL_SET = new Set<string>(EXECUTOR_ROUND_TERMINAL_STATES);
const INVOCATION_STATE_SET = new Set<string>(EXECUTOR_INVOCATION_STATES);

function decide(
  overrides: Partial<DecideGoalLoopRoundInput> = {}
): ReturnType<typeof decideGoalLoopRound> {
  const input: DecideGoalLoopRoundInput = {
    recommendation: { success: true, goalComplete: false },
    finalizeOutcome: "committed",
    roundIndex: 0,
    maxRounds: 5,
    ...overrides
  };
  return decideGoalLoopRound(input);
}

describe("decideGoalLoopRound — committed rounds", () => {
  it("classifies a committed, goal-complete round as complete", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: true },
      finalizeOutcome: "committed"
    });
    expect(decision.classification).toBe("complete");
    expect(decision.roundState).toBe("succeeded");
    expect(decision.recoveryCode).toBeNull();
    expect(decision.humanGate).toBeNull();
    expect(decision.continueLoop).toBe(false);
  });

  it("continues a committed round that made progress with budget remaining", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: false },
      finalizeOutcome: "committed",
      roundIndex: 1,
      maxRounds: 5
    });
    expect(decision.classification).toBe("continue");
    expect(decision.roundState).toBe("succeeded");
    expect(decision.continueLoop).toBe(true);
    expect(decision.humanGate).toBeNull();
  });

  it("raises a quota gate when a committed round exhausts the round budget without completing", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: false },
      finalizeOutcome: "committed",
      roundIndex: 4,
      maxRounds: 5
    });
    expect(decision.classification).toBe("operator_decision_required");
    expect(decision.roundState).toBe("succeeded");
    expect(decision.humanGate).toBe("quota_exhausted");
    expect(decision.continueLoop).toBe(false);
  });
});

describe("decideGoalLoopRound — safe resets (verification authority)", () => {
  it("does NOT complete a reset-on-verification-failure round even if the executor recommended completion", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: true },
      finalizeOutcome: "reset_verification_failure",
      roundIndex: 0,
      maxRounds: 5
    });
    // Verification is authoritative: a reset round produced no commit, so the
    // daemon must not honour the executor's `complete` recommendation.
    expect(decision.classification).toBe("continue");
    expect(decision.roundState).toBe("failed");
    expect(decision.continueLoop).toBe(true);
    expect(decision.recoveryCode).toBeNull();
  });

  it("continues a reset-on-step-failure round when budget remains", () => {
    const decision = decide({
      recommendation: { success: false, goalComplete: false },
      finalizeOutcome: "reset_step_failure",
      roundIndex: 0,
      maxRounds: 3
    });
    expect(decision.classification).toBe("continue");
    expect(decision.roundState).toBe("failed");
    expect(decision.continueLoop).toBe(true);
  });

  it("raises a quota gate when a reset round exhausts the budget", () => {
    const decision = decide({
      recommendation: { success: false, goalComplete: false },
      finalizeOutcome: "reset_step_failure",
      roundIndex: 2,
      maxRounds: 3
    });
    expect(decision.classification).toBe("operator_decision_required");
    expect(decision.roundState).toBe("failed");
    expect(decision.humanGate).toBe("quota_exhausted");
    expect(decision.continueLoop).toBe(false);
  });
});

describe("decideGoalLoopRound — repo-safety / manual recovery boundaries", () => {
  it("routes a moved-HEAD finalize to manual recovery with the head_mismatch code", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: true },
      finalizeOutcome: "manual_recovery_required",
      roundIndex: 0,
      maxRounds: 5
    });
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.roundState).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("head_mismatch");
    expect(decision.humanGate).toBe("manual_recovery_required");
    expect(decision.continueLoop).toBe(false);
  });

  it.each<[GoalLoopFinalizeOutcome, string]>([
    ["reset_failed", "reset_failed"],
    ["commit_failed", "commit_failed"],
    ["git_failed", "git_failed"],
    ["repo_lock_lost", "repo_lock_lost"],
    ["invalid_input", "invalid_input"],
    ["result_missing", "result_missing"],
    ["result_invalid", "result_invalid"]
  ])(
    "preserves the %s recovery code and routes to manual recovery",
    (finalizeOutcome, expectedCode) => {
      const decision = decide({ finalizeOutcome });
      expect(decision.classification).toBe("manual_recovery_required");
      expect(decision.roundState).toBe("manual_recovery_required");
      expect(decision.recoveryCode).toBe(expectedCode);
      expect(decision.humanGate).toBe("manual_recovery_required");
      expect(decision.continueLoop).toBe(false);
    }
  );

  it("prioritises manual recovery over budget exhaustion on the final round", () => {
    const decision = decide({
      finalizeOutcome: "repo_lock_lost",
      roundIndex: 4,
      maxRounds: 5
    });
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.humanGate).toBe("manual_recovery_required");
  });
});

describe("decideGoalLoopRound — budget semantics", () => {
  it("treats a null maxRounds as unbounded", () => {
    const decision = decide({
      recommendation: { success: true, goalComplete: false },
      finalizeOutcome: "committed",
      roundIndex: 999,
      maxRounds: null
    });
    expect(decision.classification).toBe("continue");
    expect(decision.continueLoop).toBe(true);
    expect(decision.humanGate).toBeNull();
  });

  it("always returns contract-vocabulary classification and round state", () => {
    const decision = decide();
    expect(COMPLETION_SET.has(decision.classification)).toBe(true);
    expect(ROUND_TERMINAL_SET.has(decision.roundState)).toBe(true);
    expect(typeof decision.reason).toBe("string");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("rejects a negative round index", () => {
    expect(() => decide({ roundIndex: -1 })).toThrow();
  });

  it("rejects a non-integer round index", () => {
    expect(() => decide({ roundIndex: 1.5 })).toThrow();
  });

  it("rejects a zero or negative maxRounds", () => {
    expect(() => decide({ maxRounds: 0 })).toThrow();
    expect(() => decide({ maxRounds: -3 })).toThrow();
  });
});

describe("invocationStateForRoundClassification", () => {
  it.each<[ExecutorCompletionClassification, string]>([
    ["complete", "succeeded"],
    ["continue", "running"],
    ["approval_required", "waiting_operator"],
    ["operator_decision_required", "waiting_operator"],
    ["manual_recovery_required", "manual_recovery_required"],
    ["blocked", "blocked"],
    ["failed", "failed"],
    ["cancelled", "cancelled"]
  ])("maps %s to the %s invocation state", (classification, expected) => {
    const state = invocationStateForRoundClassification(classification);
    expect(state).toBe(expected);
    expect(INVOCATION_STATE_SET.has(state)).toBe(true);
  });

  it("maps every completion classification to a known invocation state", () => {
    for (const classification of EXECUTOR_COMPLETION_CLASSIFICATIONS) {
      const state = invocationStateForRoundClassification(classification);
      expect(INVOCATION_STATE_SET.has(state)).toBe(true);
    }
  });
});

describe("goalLoopRecommendationFromResult", () => {
  it("projects success and goal_complete from a normalized runner result", () => {
    const result: RunnerResult = {
      success: true,
      summary: "did work",
      key_changes_made: ["a"],
      key_learnings: [],
      remaining_work: ["b"],
      goal_complete: false,
      commit: {
        type: "feat",
        scope: undefined,
        subject: "do work",
        body: "",
        breaking: false
      }
    };
    expect(goalLoopRecommendationFromResult(result)).toEqual({
      success: true,
      goalComplete: false
    });
  });

  it("reflects a goal-complete result", () => {
    const result: RunnerResult = {
      success: true,
      summary: "finished",
      key_changes_made: [],
      key_learnings: [],
      remaining_work: [],
      goal_complete: true,
      commit: {
        type: "chore",
        scope: undefined,
        subject: "finish",
        body: "",
        breaking: false
      }
    };
    expect(goalLoopRecommendationFromResult(result)).toEqual({
      success: true,
      goalComplete: true
    });
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function verifyCmd(succeeded: boolean) {
  return {
    command: "pnpm test",
    exit_code: succeeded ? 0 : 1,
    signal: null,
    duration_ms: 12,
    timed_out: false,
    succeeded
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "implemented the bounded round",
    key_changes_made: ["added the goal-loop projection"],
    key_learnings: ["learned a thing"],
    remaining_work: ["wire up the orchestrator"],
    goal_complete: false,
    commit: {
      type: "feat",
      scope: "goal-loop",
      subject: "project round evidence",
      body: "",
      breaking: false
    },
    ...overrides
  };
}

const COMMITTED: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "committed",
  verification: { ok: true, results: [verifyCmd(true)] },
  commit: {
    ok: true,
    commitSha: SHA_A,
    parentSha: SHA_B,
    message: "feat(goal-loop): project round evidence"
  },
  head: SHA_A
};

const COMMITTED_NO_VERIFY: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "committed",
  verification: { ok: true, results: [] },
  commit: {
    ok: true,
    commitSha: SHA_A,
    parentSha: SHA_B,
    message: "feat(goal-loop): project round evidence"
  },
  head: SHA_A
};

const RESET_VERIFICATION_FAILURE: FinalizeWorkflowStepFromResultFileResult =
  {
    outcome: "reset_verification_failure",
    verification: {
      ok: false,
      code: "command_failed",
      error: "pnpm test failed",
      results: [verifyCmd(false)]
    },
    reset: { ok: true, head: SHA_B }
  };

const RESET_STEP_FAILURE: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "reset_step_failure",
  reset: { ok: true, head: SHA_B }
};

const COMMIT_FAILED: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "commit_failed",
  verification: { ok: true, results: [verifyCmd(true)] },
  commit: { ok: false, code: "git_failed", error: "git commit failed" }
};

const COMMIT_NOOP: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "commit_failed",
  verification: { ok: true, results: [] },
  commit: {
    ok: false,
    code: "nothing_to_commit",
    error: "No staged changes after runner; nothing to commit."
  }
};

const RESET_FAILED_WITH_VERIFY: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "reset_failed",
  trigger: "verification_failure",
  verification: {
    ok: false,
    code: "command_failed",
    error: "pnpm test failed",
    results: [verifyCmd(false)]
  },
  reset: { ok: false, code: "git_failed", error: "git reset failed" }
};

const RESET_FAILED_NO_VERIFY: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "reset_failed",
  trigger: "runner_failure",
  verification: null,
  reset: { ok: false, code: "git_failed", error: "git reset failed" }
};

const MOVED_HEAD: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "manual_recovery_required",
  recoveryCode: "head_mismatch",
  trigger: "pre_finalize",
  expectedHead: SHA_B,
  currentHead: SHA_A,
  reason: "HEAD moved before finalize"
};

const RESULT_MISSING: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "result_missing",
  resultFilePath: "/tmp/result.json",
  error: "result file not found"
};

describe("goalLoopFinalizeEvidenceFromResult", () => {
  it("projects a committed round's commit SHA and passed verification", () => {
    expect(goalLoopFinalizeEvidenceFromResult(COMMITTED)).toEqual({
      outcome: "committed",
      commitSha: SHA_A,
      verificationStatus: "passed"
    });
  });

  it("marks a committed round with no verification commands as skipped", () => {
    expect(goalLoopFinalizeEvidenceFromResult(COMMITTED_NO_VERIFY)).toEqual({
      outcome: "committed",
      commitSha: SHA_A,
      verificationStatus: "skipped"
    });
  });

  it("projects a verification-failure reset as failed with no commit SHA", () => {
    expect(
      goalLoopFinalizeEvidenceFromResult(RESET_VERIFICATION_FAILURE)
    ).toEqual({
      outcome: "reset_verification_failure",
      commitSha: null,
      verificationStatus: "failed"
    });
  });

  it("leaves verification status unknown when the step failed before verification", () => {
    expect(goalLoopFinalizeEvidenceFromResult(RESET_STEP_FAILURE)).toEqual({
      outcome: "reset_step_failure",
      commitSha: null,
      verificationStatus: null
    });
  });

  it("preserves passed verification even when the commit itself failed", () => {
    expect(goalLoopFinalizeEvidenceFromResult(COMMIT_FAILED)).toEqual({
      outcome: "commit_failed",
      commitSha: null,
      verificationStatus: "passed"
    });
  });

  it("projects a reset_failed carrying a verification failure as failed", () => {
    expect(
      goalLoopFinalizeEvidenceFromResult(RESET_FAILED_WITH_VERIFY)
    ).toEqual({
      outcome: "reset_failed",
      commitSha: null,
      verificationStatus: "failed"
    });
  });

  it("leaves verification unknown for a reset_failed with no verification", () => {
    expect(goalLoopFinalizeEvidenceFromResult(RESET_FAILED_NO_VERIFY)).toEqual({
      outcome: "reset_failed",
      commitSha: null,
      verificationStatus: null
    });
  });

  it("carries no commit SHA or verification for a moved-HEAD recovery", () => {
    expect(goalLoopFinalizeEvidenceFromResult(MOVED_HEAD)).toEqual({
      outcome: "manual_recovery_required",
      commitSha: null,
      verificationStatus: null
    });
  });

  it("carries no commit SHA or verification for a missing result", () => {
    expect(goalLoopFinalizeEvidenceFromResult(RESULT_MISSING)).toEqual({
      outcome: "result_missing",
      commitSha: null,
      verificationStatus: null
    });
  });
});

describe("planGoalLoopRoundPersistence — committed completion", () => {
  it("captures the normalized result then persists a complete terminal patch", () => {
    const result = runnerResult({ goal_complete: true });
    const plan = planGoalLoopRoundPersistence({
      result,
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5
    });

    expect(plan.decision.classification).toBe("complete");
    expect(plan.evidence).toEqual({
      outcome: "committed",
      commitSha: SHA_A,
      verificationStatus: "passed"
    });

    expect(plan.captureUpdate).toEqual({
      toState: "capturing_result",
      summary: result.summary,
      keyChanges: result.key_changes_made,
      keyLearnings: result.key_learnings,
      remainingWork: result.remaining_work
    });

    expect(plan.terminalUpdate).toEqual({
      toState: "succeeded",
      classification: "complete",
      executorRecommendation: "complete",
      verificationStatus: "passed",
      verificationResults: [
        {
          command: "pnpm test",
          exitCode: 0,
          durationMs: 12,
          timedOut: false
        }
      ],
      commitSha: SHA_A,
      recoveryCode: null,
      humanGate: null
    });
  });

  it("produces a transition-legal running -> capture -> terminal sequence", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: true }),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5
    });
    const capture = transitionExecutorRound(
      "running",
      plan.captureUpdate!.toState
    );
    expect(capture.ok).toBe(true);
    const terminal = transitionExecutorRound(
      plan.captureUpdate!.toState,
      plan.terminalUpdate.toState
    );
    expect(terminal.ok).toBe(true);
  });
});

describe("planGoalLoopRoundPersistence — continue and quota", () => {
  it("captures progress and continues a committed-but-incomplete round", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: false }),
      finalize: COMMITTED,
      roundIndex: 1,
      maxRounds: 5
    });
    expect(plan.decision.classification).toBe("continue");
    expect(plan.terminalUpdate.toState).toBe("succeeded");
    expect(plan.terminalUpdate.classification).toBe("continue");
    expect(plan.terminalUpdate.executorRecommendation).toBe("continue");
    expect(plan.terminalUpdate.humanGate).toBeNull();
  });

  it("raises a quota gate on the terminal patch when the budget is exhausted", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: false }),
      finalize: COMMITTED,
      roundIndex: 4,
      maxRounds: 5
    });
    expect(plan.terminalUpdate.classification).toBe(
      "operator_decision_required"
    );
    expect(plan.terminalUpdate.executorRecommendation).toBe("continue");
    expect(plan.terminalUpdate.humanGate).toBe("quota_exhausted");
  });
});

describe("planGoalLoopRoundPersistence — verification authority", () => {
  it("captures the reset round's result but never completes it", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: true }),
      finalize: RESET_VERIFICATION_FAILURE,
      roundIndex: 0,
      maxRounds: 5
    });
    // The runner recommended completion, but verification reset the work.
    expect(plan.captureUpdate).not.toBeNull();
    expect(plan.terminalUpdate.toState).toBe("failed");
    expect(plan.terminalUpdate.classification).toBe("continue");
    expect(plan.terminalUpdate.verificationStatus).toBe("failed");
    expect(plan.terminalUpdate.commitSha).toBeNull();
  });

  it("keeps the captured result patch transition-legal into a failed terminal", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: RESET_VERIFICATION_FAILURE,
      roundIndex: 0,
      maxRounds: 5
    });
    const terminal = transitionExecutorRound(
      plan.captureUpdate!.toState,
      plan.terminalUpdate.toState
    );
    expect(terminal.ok).toBe(true);
  });
});

describe("planGoalLoopRoundPersistence — manual recovery boundaries", () => {
  it("skips capture and preserves the recovery code when the result is missing", () => {
    const plan = planGoalLoopRoundPersistence({
      result: null,
      finalize: RESULT_MISSING,
      roundIndex: 0,
      maxRounds: 5
    });
    expect(plan.captureUpdate).toBeNull();
    expect(plan.terminalUpdate.toState).toBe("manual_recovery_required");
    expect(plan.terminalUpdate.classification).toBe("manual_recovery_required");
    expect(plan.terminalUpdate.recoveryCode).toBe("result_missing");
    expect(plan.terminalUpdate.humanGate).toBe("manual_recovery_required");
  });

  it("captures a present result yet still routes a commit_failed round to manual recovery", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: COMMIT_FAILED,
      roundIndex: 0,
      maxRounds: 5
    });
    expect(plan.captureUpdate).not.toBeNull();
    expect(plan.terminalUpdate.toState).toBe("manual_recovery_required");
    expect(plan.terminalUpdate.recoveryCode).toBe("commit_failed");
    // Verification passed before the commit failed; the evidence preserves that.
    expect(plan.terminalUpdate.verificationStatus).toBe("passed");
    const running = transitionExecutorRound(
      "running",
      plan.captureUpdate!.toState
    );
    const terminal = transitionExecutorRound(
      plan.captureUpdate!.toState,
      plan.terminalUpdate.toState
    );
    expect(running.ok).toBe(true);
    expect(terminal.ok).toBe(true);
  });

  it("preserves a nothing_to_commit commit failure as a queryable no-op recovery code", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: COMMIT_NOOP,
      roundIndex: 0,
      maxRounds: 5
    });

    expect(plan.terminalUpdate.toState).toBe("manual_recovery_required");
    expect(plan.terminalUpdate.recoveryCode).toBe("nothing_to_commit");
    expect(plan.terminalUpdate.humanGate).toBe("manual_recovery_required");
  });

  it("routes a missing result directly from running to manual recovery", () => {
    const plan = planGoalLoopRoundPersistence({
      result: null,
      finalize: RESULT_MISSING,
      roundIndex: 0,
      maxRounds: 5
    });
    const direct = transitionExecutorRound(
      "running",
      plan.terminalUpdate.toState
    );
    expect(direct.ok).toBe(true);
  });
});

describe("planGoalLoopRoundPersistence — result digest", () => {
  it("stamps a supplied result digest onto the capture patch", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: true }),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5,
      resultDigest: "sha256:deadbeef"
    });
    expect(plan.captureUpdate?.resultDigest).toBe("sha256:deadbeef");
  });

  it("omits the result digest from the capture patch when none is supplied", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5
    });
    // Backward-compatible: an absent digest leaves the field off the patch
    // entirely (coalesce then keeps the round-start record's null), rather than
    // overwriting it with an explicit null.
    expect(plan.captureUpdate).not.toBeNull();
    expect(plan.captureUpdate).not.toHaveProperty("resultDigest");
  });

  it("never carries a digest when there is no result to capture", () => {
    const plan = planGoalLoopRoundPersistence({
      result: null,
      finalize: RESULT_MISSING,
      roundIndex: 0,
      maxRounds: 5,
      resultDigest: "sha256:should-be-ignored"
    });
    expect(plan.captureUpdate).toBeNull();
    expect(plan.terminalUpdate).not.toHaveProperty("resultDigest");
  });
});

describe("planGoalLoopRoundPersistence — changed files", () => {
  it("stamps the supplied committed changed files onto the terminal patch", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: true }),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5,
      changedFiles: ["src/a.ts", "src/b.ts"]
    });
    // changed_files is commit-derived evidence, so it pairs with commit_sha on
    // the terminal patch rather than the result-document capture patch.
    expect(plan.terminalUpdate.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("omits changed files from the terminal patch when none are supplied", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult({ goal_complete: true }),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5
    });
    // Backward-compatible: an absent list leaves the field off the patch so
    // coalesce keeps the round-start record's empty array.
    expect(plan.terminalUpdate).not.toHaveProperty("changedFiles");
  });

  it("omits changed files when the supplied list is empty", () => {
    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: RESET_VERIFICATION_FAILURE,
      roundIndex: 0,
      maxRounds: 5,
      changedFiles: []
    });
    // A non-committed round committed nothing, so its empty change set is left
    // off the patch (identical to the round-start default) rather than stamped.
    expect(plan.terminalUpdate).not.toHaveProperty("changedFiles");
  });
});

describe("resolveGoalLoopRoundSelection — precedence", () => {
  it("resolves every field from the step config when it provides them", () => {
    const selection = resolveGoalLoopRoundSelection({
      stepConfig: {
        agentProvider: "claude",
        model: "claude-opus-4-8",
        effort: "high",
        timeoutMs: 1_800_000,
        maxRounds: 12,
        policyEnvelope: "delegated:standard"
      }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.model).toBe("claude-opus-4-8");
    expect(selection.effort).toBe("high");
    expect(selection.timeoutMs).toBe(1_800_000);
    expect(selection.maxRounds).toBe(12);
    expect(selection.policyEnvelope).toBe("delegated:standard");
    expect(selection.source).toEqual({
      agentProvider: "step_definition",
      model: "step_definition",
      effort: "step_definition",
      timeoutMs: "step_definition",
      maxRounds: "step_definition",
      policyEnvelope: "step_definition"
    });
  });

  it("falls back to workflow defaults for fields the step config omits", () => {
    const selection = resolveGoalLoopRoundSelection({
      stepConfig: { agentProvider: "claude" },
      workflowConfig: { model: "claude-sonnet-4-6", maxRounds: 8 }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.source.agentProvider).toBe("step_definition");
    expect(selection.model).toBe("claude-sonnet-4-6");
    expect(selection.source.model).toBe("workflow_definition");
    expect(selection.maxRounds).toBe(8);
    expect(selection.source.maxRounds).toBe("workflow_definition");
  });

  it("falls back to repository policy below the workflow defaults", () => {
    const selection = resolveGoalLoopRoundSelection({
      workflowConfig: { agentProvider: "claude" },
      repositoryPolicy: { effort: "medium", maxRounds: 6 }
    });
    expect(selection.effort).toBe("medium");
    expect(selection.source.effort).toBe("repository_policy");
    expect(selection.maxRounds).toBe(6);
    expect(selection.source.maxRounds).toBe("repository_policy");
  });

  it("falls back to the executor family default below repository policy", () => {
    const selection = resolveGoalLoopRoundSelection({
      repositoryPolicy: { agentProvider: "claude" },
      familyDefault: { maxRounds: 10, effort: "high" }
    });
    expect(selection.maxRounds).toBe(10);
    expect(selection.source.maxRounds).toBe("executor_family_default");
    expect(selection.effort).toBe("high");
    expect(selection.source.effort).toBe("executor_family_default");
  });

  it("uses the momentum global default as the floor for unspecified fields", () => {
    const selection = resolveGoalLoopRoundSelection({});
    expect(selection.agentProvider).toBeNull();
    expect(selection.model).toBeNull();
    expect(selection.effort).toBeNull();
    expect(selection.timeoutMs).toBeNull();
    expect(selection.maxRounds).toBeNull();
    expect(selection.policyEnvelope).toBeNull();
    for (const source of Object.values(selection.source)) {
      expect(source).toBe("momentum_global_default");
    }
  });

  it("resolves each field independently from a different precedence level", () => {
    const selection = resolveGoalLoopRoundSelection({
      stepConfig: { agentProvider: "claude" },
      workflowConfig: { model: "claude-sonnet-4-6" },
      repositoryPolicy: { effort: "medium" },
      familyDefault: { maxRounds: 9 },
      globalDefault: { timeoutMs: 600_000 }
    });
    expect(selection.source).toEqual({
      agentProvider: "step_definition",
      model: "workflow_definition",
      effort: "repository_policy",
      maxRounds: "executor_family_default",
      timeoutMs: "momentum_global_default",
      policyEnvelope: "momentum_global_default"
    });
    expect(selection.timeoutMs).toBe(600_000);
    expect(selection.policyEnvelope).toBeNull();
  });

  it("treats an explicit null at a higher level as a deliberate override", () => {
    const selection = resolveGoalLoopRoundSelection({
      stepConfig: { model: null },
      workflowConfig: { model: "claude-sonnet-4-6" }
    });
    expect(selection.model).toBeNull();
    expect(selection.source.model).toBe("step_definition");
  });

  it("lets an explicit global default override the built-in null floor", () => {
    const selection = resolveGoalLoopRoundSelection({
      globalDefault: { agentProvider: "claude", maxRounds: 4 }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.source.agentProvider).toBe("momentum_global_default");
    expect(selection.maxRounds).toBe(4);
  });

  it("exposes an all-null built-in global default selection", () => {
    expect(GOAL_LOOP_GLOBAL_DEFAULT_SELECTION).toEqual({
      agentProvider: null,
      model: null,
      effort: null,
      timeoutMs: null,
      maxRounds: null,
      policyEnvelope: null
    });
  });
});

function startSelection(): GoalLoopRoundSelection {
  return resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      timeoutMs: 1_800_000,
      maxRounds: 12,
      policyEnvelope: "delegated:standard"
    }
  });
}

function startInput(
  overrides: Partial<PlanGoalLoopRoundStartInput> = {}
): PlanGoalLoopRoundStartInput {
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    attempt: 1,
    roundIndex: 0,
    selection: startSelection(),
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-1",
    logPaths: ["/artifacts/round-1/stdout.log"],
    startedAt: 1_000,
    ...overrides
  };
}

describe("planGoalLoopRoundStart", () => {
  it("builds a running-state goal-loop round-start record", () => {
    const record = planGoalLoopRoundStart(startInput());
    expect(record.executorFamily).toBe("goal-loop");
    expect(record.state).toBe("running");
    expect(record.classification).toBeNull();
    expect(record.roundId).toBe("round-1");
    expect(record.invocationId).toBe("inv-1");
    expect(record.workflowRunId).toBe("run-1");
    expect(record.stepRunId).toBe("step-1");
    expect(record.stepKey).toBe("implementation");
    expect(record.attempt).toBe(1);
    expect(record.roundIndex).toBe(0);
  });

  it("copies the resolved agent, model, and effort into the round", () => {
    const record = planGoalLoopRoundStart(startInput());
    expect(record.agentProvider).toBe("claude");
    expect(record.model).toBe("claude-opus-4-8");
    expect(record.effort).toBe("high");
  });

  it("stamps startedAt and heartbeatAt from the clock, leaving finishedAt null", () => {
    const record = planGoalLoopRoundStart(startInput({ startedAt: 4_242 }));
    expect(record.startedAt).toBe(4_242);
    expect(record.heartbeatAt).toBe(4_242);
    expect(record.finishedAt).toBeNull();
  });

  it("records the input digest, artifact root, and log paths", () => {
    const record = planGoalLoopRoundStart(startInput());
    expect(record.inputDigest).toBe("sha256:input");
    expect(record.artifactRoot).toBe("/artifacts/round-1");
    expect(record.logPaths).toEqual(["/artifacts/round-1/stdout.log"]);
    expect(record.resultDigest).toBeNull();
  });

  it("starts with empty result, verification, commit, and gate evidence", () => {
    const record = planGoalLoopRoundStart(startInput());
    expect(record.summary).toBeNull();
    expect(record.keyChanges).toEqual([]);
    expect(record.remainingWork).toEqual([]);
    expect(record.changedFiles).toEqual([]);
    expect(record.verificationStatus).toBeNull();
    expect(record.commitSha).toBeNull();
    expect(record.recoveryCode).toBeNull();
    expect(record.humanGate).toBeNull();
  });

  it("defaults log paths to an empty array when omitted", () => {
    const record = planGoalLoopRoundStart({
      roundId: "round-1",
      invocationId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      roundIndex: 0,
      selection: startSelection(),
      inputDigest: "sha256:input",
      artifactRoot: "/artifacts/round-1",
      startedAt: 1_000
    });
    expect(record.logPaths).toEqual([]);
  });

  it("produces a record whose start state is transition-legal into capture", () => {
    const record = planGoalLoopRoundStart(startInput());
    const capture = transitionExecutorRound(record.state, "capturing_result");
    expect(capture.ok).toBe(true);
  });
});

describe("planGoalLoopRoundArtifacts", () => {
  const ARTIFACT_CLASS_SET = new Set<string>(EXECUTOR_ARTIFACT_CLASSES);

  function fullArtifacts(): GoalLoopRoundArtifacts {
    return {
      resultDocument: { path: "/artifacts/round-1/result.json", digest: "sha256:r" },
      checkpointStream: { path: "/artifacts/round-1/checkpoints.ndjson" },
      verificationOutput: {
        path: "/artifacts/round-1/verify.log",
        description: "pnpm test"
      },
      commitOrResetEvidence: { path: "/artifacts/round-1/commit.txt" },
      recoveryNote: { path: "/artifacts/round-1/recovery.md" }
    };
  }

  it("derives one logs artifact per frozen log path, in order", () => {
    const records = planGoalLoopRoundArtifacts({
      roundId: "round-1",
      logPaths: ["/artifacts/round-1/stdout.log", "/artifacts/round-1/stderr.log"]
    });
    expect(records).toEqual([
      {
        artifactId: "round-1-logs-0",
        roundId: "round-1",
        artifactClass: "logs",
        path: "/artifacts/round-1/stdout.log",
        digest: null,
        description: null
      },
      {
        artifactId: "round-1-logs-1",
        roundId: "round-1",
        artifactClass: "logs",
        path: "/artifacts/round-1/stderr.log",
        digest: null,
        description: null
      }
    ]);
  });

  it("maps each reported pointer to its contract artifact class with a deterministic id", () => {
    const records = planGoalLoopRoundArtifacts({
      roundId: "round-1",
      logPaths: [],
      artifacts: fullArtifacts()
    });
    const byClass = new Map(records.map((r) => [r.artifactClass, r]));
    expect(byClass.get("result_document")).toEqual({
      artifactId: "round-1-result_document",
      roundId: "round-1",
      artifactClass: "result_document",
      path: "/artifacts/round-1/result.json",
      digest: "sha256:r",
      description: null
    });
    expect(byClass.get("checkpoint_stream")?.artifactId).toBe(
      "round-1-checkpoint_stream"
    );
    expect(byClass.get("verification_output")?.description).toBe("pnpm test");
    expect(byClass.get("commit_or_reset_evidence")?.path).toBe(
      "/artifacts/round-1/commit.txt"
    );
    expect(byClass.get("recovery_note")?.path).toBe(
      "/artifacts/round-1/recovery.md"
    );
    // Every artifact class is a contract-known class.
    for (const record of records) {
      expect(ARTIFACT_CLASS_SET.has(record.artifactClass)).toBe(true);
    }
  });

  it("orders artifacts in the contract artifact-class order", () => {
    const records = planGoalLoopRoundArtifacts({
      roundId: "round-1",
      logPaths: ["/artifacts/round-1/stdout.log"],
      artifacts: fullArtifacts()
    });
    expect(records.map((r) => r.artifactClass)).toEqual([
      "result_document",
      "logs",
      "checkpoint_stream",
      "verification_output",
      "commit_or_reset_evidence",
      "recovery_note"
    ]);
  });

  it("omits a class whose pointer is absent or explicitly null", () => {
    const records = planGoalLoopRoundArtifacts({
      roundId: "round-1",
      logPaths: [],
      artifacts: {
        resultDocument: { path: "/artifacts/round-1/result.json" },
        recoveryNote: null
      }
    });
    expect(records.map((r) => r.artifactClass)).toEqual(["result_document"]);
  });

  it("records no artifacts when no logs and no pointers are present", () => {
    expect(
      planGoalLoopRoundArtifacts({ roundId: "round-1", logPaths: [] })
    ).toEqual([]);
  });

  it("defaults digest and description to null when a pointer omits them", () => {
    const [record] = planGoalLoopRoundArtifacts({
      roundId: "round-1",
      logPaths: [],
      artifacts: { resultDocument: { path: "/artifacts/round-1/result.json" } }
    });
    expect(record?.digest).toBeNull();
    expect(record?.description).toBeNull();
  });
});

describe("planGoalLoopRoundCheckpoints", () => {
  it("records the full lifecycle stage stream for a round that captured a result", () => {
    const records = planGoalLoopRoundCheckpoints({
      roundId: "round-1",
      finalizeOutcome: "committed",
      capturedResult: true,
      classification: "complete"
    });
    expect(records).toEqual([
      {
        checkpointId: "round-1-checkpoint-0",
        roundId: "round-1",
        sequence: 0,
        stage: "round_started",
        detail: null
      },
      {
        checkpointId: "round-1-checkpoint-1",
        roundId: "round-1",
        sequence: 1,
        stage: "mechanism_completed",
        detail: "finalize outcome: committed"
      },
      {
        checkpointId: "round-1-checkpoint-2",
        roundId: "round-1",
        sequence: 2,
        stage: "result_captured",
        detail: null
      },
      {
        checkpointId: "round-1-checkpoint-3",
        roundId: "round-1",
        sequence: 3,
        stage: "classified",
        detail: "classification: complete"
      }
    ]);
  });

  it("omits the result_captured stage for a round that produced no result", () => {
    const records = planGoalLoopRoundCheckpoints({
      roundId: "round-1",
      finalizeOutcome: "result_missing",
      capturedResult: false,
      classification: "manual_recovery_required"
    });
    expect(records.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "classified"
    ]);
    // The mechanism stage records the precise unsafe finalize outcome, and the
    // terminal stage the daemon classification, so the coarse stream explains
    // how far a recovery round got without re-deriving from the round fields.
    expect(records[1]?.detail).toBe("finalize outcome: result_missing");
    expect(records[2]?.detail).toBe("classification: manual_recovery_required");
  });

  it("numbers sequences from 0 with deterministic, collision-free ids", () => {
    const records = planGoalLoopRoundCheckpoints({
      roundId: "round-7",
      finalizeOutcome: "reset_verification_failure",
      capturedResult: true,
      classification: "continue"
    });
    expect(records.map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
    // (round_id, sequence) is unique per the schema; the ids embed both so a
    // re-projection of the same round yields the same checkpoint ids.
    expect(new Set(records.map((c) => c.sequence)).size).toBe(records.length);
    expect(records.map((c) => c.checkpointId)).toEqual([
      "round-7-checkpoint-0",
      "round-7-checkpoint-1",
      "round-7-checkpoint-2",
      "round-7-checkpoint-3"
    ]);
  });
});

// ---------------------------------------------------------------------------
// goal-loop executor adapter "below StepRun": deterministic invocation / round
// identity materialization. These pure helpers turn a StepRun identity into the
// durable ExecutorInvocation + per-round ExecutorRound identities, so every
// caller mints reattachable ids the same way (contract "Heartbeat And Reattach":
// "The daemon must be able to reattach using durable state alone.").
// ---------------------------------------------------------------------------

const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";

function selection(maxRounds = 5): GoalLoopRoundSelection {
  return resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      maxRounds
    }
  });
}

describe("goalLoopInvocationId", () => {
  it("is deterministic for the same StepRun identity and attempt", () => {
    expect(goalLoopInvocationId(RUN_A, "implementation", 1)).toBe(
      goalLoopInvocationId(RUN_A, "implementation", 1)
    );
  });

  it("embeds the run, step, family, and attempt so it is globally unique and reattachable", () => {
    const id = goalLoopInvocationId(RUN_A, "implementation", 2);
    expect(id).toContain(RUN_A);
    expect(id).toContain("implementation");
    expect(id).toContain("goal-loop");
    expect(id).toContain("2");
  });

  it("distinguishes different attempts, steps, and runs", () => {
    const ids = new Set([
      goalLoopInvocationId(RUN_A, "implementation", 1),
      goalLoopInvocationId(RUN_A, "implementation", 2),
      goalLoopInvocationId(RUN_A, "review", 1),
      goalLoopInvocationId(RUN_B, "implementation", 1)
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("goalLoopRoundId", () => {
  it("is deterministic and embeds the invocation id and round index", () => {
    const invocationId = goalLoopInvocationId(RUN_A, "implementation", 1);
    expect(goalLoopRoundId(invocationId, 0)).toBe(
      goalLoopRoundId(invocationId, 0)
    );
    expect(goalLoopRoundId(invocationId, 0)).toContain(invocationId);
  });

  it("distinguishes round indices under the same invocation", () => {
    const invocationId = goalLoopInvocationId(RUN_A, "implementation", 1);
    expect(goalLoopRoundId(invocationId, 0)).not.toBe(
      goalLoopRoundId(invocationId, 1)
    );
  });
});

describe("planGoalLoopInvocation", () => {
  it("projects a StepRun identity into a running goal-loop invocation record", () => {
    const invocation = planGoalLoopInvocation({
      workflowRunId: RUN_A,
      stepRunId: "implementation",
      stepKey: "implementation",
      attempt: 1,
      startedAt: 1_000
    });
    expect(invocation).toEqual({
      invocationId: goalLoopInvocationId(RUN_A, "implementation", 1),
      workflowRunId: RUN_A,
      stepRunId: "implementation",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      state: "running",
      attempt: 1,
      startedAt: 1_000,
      heartbeatAt: 1_000,
      finishedAt: null
    });
  });
});

describe("planGoalLoopRoundStartForInvocation", () => {
  it("inherits the invocation identity and mints a deterministic round id", () => {
    const invocation = planGoalLoopInvocation({
      workflowRunId: RUN_A,
      stepRunId: "implementation",
      stepKey: "implementation",
      attempt: 1,
      startedAt: 1_000
    });
    const start = planGoalLoopRoundStartForInvocation({
      invocation,
      selection: selection(),
      roundIndex: 0,
      runtime: {
        inputDigest: "sha256:input-0",
        artifactRoot: "/artifacts/round-0",
        logPaths: ["/artifacts/round-0/stdout.log"]
      },
      startedAt: 1_100
    });
    expect(start.roundId).toBe(
      goalLoopRoundId(invocation.invocationId, 0)
    );
    expect(start.invocationId).toBe(invocation.invocationId);
    expect(start.workflowRunId).toBe(RUN_A);
    expect(start.stepRunId).toBe("implementation");
    expect(start.stepKey).toBe("implementation");
    expect(start.attempt).toBe(1);
    expect(start.roundIndex).toBe(0);
    expect(start.inputDigest).toBe("sha256:input-0");
    expect(start.artifactRoot).toBe("/artifacts/round-0");
    expect(start.logPaths).toEqual(["/artifacts/round-0/stdout.log"]);
    expect(start.startedAt).toBe(1_100);
    expect(start.selection).toEqual(selection());
  });

  it("composes into a valid running round record that freezes the resolved selection", () => {
    const invocation = planGoalLoopInvocation({
      workflowRunId: RUN_A,
      stepRunId: "implementation",
      stepKey: "implementation",
      attempt: 1,
      startedAt: 1_000
    });
    const start = planGoalLoopRoundStartForInvocation({
      invocation,
      selection: selection(),
      roundIndex: 2,
      runtime: { inputDigest: "sha256:input-2", artifactRoot: "/artifacts/round-2" },
      startedAt: 1_200
    });
    const round = planGoalLoopRoundStart(start);
    expect(round.state).toBe("running");
    expect(round.executorFamily).toBe("goal-loop");
    expect(round.roundId).toBe(goalLoopRoundId(invocation.invocationId, 2));
    expect(round.invocationId).toBe(invocation.invocationId);
    expect(round.roundIndex).toBe(2);
    // The resolved selection is frozen into the round before any work runs.
    expect(round.agentProvider).toBe("claude");
    expect(round.model).toBe("claude-opus-4-8");
    expect(round.effort).toBe("high");
    // No logPaths supplied -> empty, never undefined.
    expect(round.logPaths).toEqual([]);
  });
});
