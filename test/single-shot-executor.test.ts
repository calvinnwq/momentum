import { describe, expect, it } from "vitest";

import {
  EXECUTOR_ARTIFACT_CLASSES,
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_INVOCATION_TERMINAL_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  transitionExecutorInvocation,
  type WorkflowExecutorFamily
} from "../src/executor-loop-reducer.js";
import { isWorkflowExecutorFamily } from "../src/workflow-definition.js";
import {
  SINGLE_SHOT_BLOCKED_RECOVERY_CODES,
  SINGLE_SHOT_EXECUTOR_FAMILIES,
  SINGLE_SHOT_FAILED_RECOVERY_CODES,
  SINGLE_SHOT_GLOBAL_DEFAULT_SELECTION,
  SINGLE_SHOT_MANUAL_RECOVERY_CODES,
  SINGLE_SHOT_RECOVERY_CODES,
  decideSingleShotInvocation,
  isSingleShotExecutorFamily,
  planSingleShotInvocation,
  planSingleShotRoundArtifacts,
  planSingleShotRoundCheckpoints,
  planSingleShotRoundPersistence,
  planSingleShotRoundStart,
  planSingleShotRoundStartForInvocation,
  resolveSingleShotRoundSelection,
  singleShotInvocationId,
  singleShotRoundId,
  type SingleShotInvocationOutcome,
  type SingleShotRoundArtifacts,
  type SingleShotRoundSelection
} from "../src/single-shot-executor.js";
import type { RunnerResult } from "../src/runner-result.js";

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

const ONE_SHOT_SELECTION: SingleShotRoundSelection = {
  agentProvider: "claude-code",
  model: "opus",
  effort: "high",
  timeoutMs: 600_000,
  policyEnvelope: "default",
  source: {
    agentProvider: "step_definition",
    model: "step_definition",
    effort: "step_definition",
    timeoutMs: "step_definition",
    policyEnvelope: "step_definition"
  }
};

const SCRIPT_SELECTION: SingleShotRoundSelection = {
  agentProvider: null,
  model: null,
  effort: null,
  timeoutMs: null,
  policyEnvelope: null,
  source: {
    agentProvider: "momentum_global_default",
    model: "momentum_global_default",
    effort: "momentum_global_default",
    timeoutMs: "momentum_global_default",
    policyEnvelope: "momentum_global_default"
  }
};

describe("planSingleShotRoundStart", () => {
  it("projects a running single round at index 0 carrying the chosen family", () => {
    const round = planSingleShotRoundStart({
      roundId: "r0",
      invocationId: "inv0",
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "preflight",
      family: "one-shot",
      attempt: 0,
      selection: ONE_SHOT_SELECTION,
      inputDigest: "sha256:abc",
      artifactRoot: "/tmp/run1/step1",
      logPaths: ["/tmp/run1/step1/exec.log"],
      startedAt: 1000
    });

    expect(round.roundId).toBe("r0");
    expect(round.invocationId).toBe("inv0");
    expect(round.workflowRunId).toBe("run1");
    expect(round.stepRunId).toBe("step1");
    expect(round.stepKey).toBe("preflight");
    expect(round.executorFamily).toBe("one-shot");
    expect(round.attempt).toBe(0);
    // A single shot has exactly one round.
    expect(round.roundIndex).toBe(0);
    expect(round.state).toBe("running");
    expect(round.classification).toBeNull();
    expect(round.startedAt).toBe(1000);
    expect(round.heartbeatAt).toBe(1000);
    expect(round.finishedAt).toBeNull();
    // The resolved agent/model/effort are frozen in before the round starts.
    expect(round.agentProvider).toBe("claude-code");
    expect(round.model).toBe("opus");
    expect(round.effort).toBe("high");
    expect(round.inputDigest).toBe("sha256:abc");
    expect(round.resultDigest).toBeNull();
    expect(round.artifactRoot).toBe("/tmp/run1/step1");
    expect(round.logPaths).toEqual(["/tmp/run1/step1/exec.log"]);
    // Result evidence is empty at start; the terminal projection fills it.
    expect(round.summary).toBeNull();
    expect(round.keyChanges).toEqual([]);
    expect(round.remainingWork).toEqual([]);
    expect(round.changedFiles).toEqual([]);
    expect(round.verificationStatus).toBeNull();
    expect(round.commitSha).toBeNull();
    expect(round.recoveryCode).toBeNull();
    expect(round.humanGate).toBeNull();
  });

  it("carries the script family with its null agent selection and a later attempt", () => {
    const round = planSingleShotRoundStart({
      roundId: "r0",
      invocationId: "inv0",
      workflowRunId: "run9",
      stepRunId: "step9",
      stepKey: "merge-cleanup",
      family: "script",
      attempt: 3,
      selection: SCRIPT_SELECTION,
      inputDigest: null,
      artifactRoot: null,
      startedAt: 5
    });

    expect(round.executorFamily).toBe("script");
    expect(round.attempt).toBe(3);
    expect(round.roundIndex).toBe(0);
    expect(round.agentProvider).toBeNull();
    expect(round.model).toBeNull();
    expect(round.effort).toBeNull();
    expect(round.inputDigest).toBeNull();
    expect(round.artifactRoot).toBeNull();
    // logPaths omitted -> defaults to an empty array, never undefined.
    expect(round.logPaths).toEqual([]);
  });
});

describe("planSingleShotRoundStartForInvocation", () => {
  it("mints the single round id and inherits the invocation identity", () => {
    const invocation = planSingleShotInvocation({
      family: "one-shot",
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "preflight",
      attempt: 0,
      startedAt: 1000
    });

    const start = planSingleShotRoundStartForInvocation({
      invocation,
      selection: ONE_SHOT_SELECTION,
      runtime: {
        inputDigest: "sha256:abc",
        artifactRoot: "/tmp/x",
        logPaths: ["/tmp/x/exec.log"]
      },
      startedAt: 2000
    });

    expect(start.roundId).toBe(singleShotRoundId(invocation.invocationId));
    expect(start.invocationId).toBe(invocation.invocationId);
    expect(start.workflowRunId).toBe("run1");
    expect(start.stepRunId).toBe("step1");
    expect(start.stepKey).toBe("preflight");
    expect(start.family).toBe("one-shot");
    expect(start.attempt).toBe(0);
    expect(start.selection).toEqual(ONE_SHOT_SELECTION);
    expect(start.inputDigest).toBe("sha256:abc");
    expect(start.artifactRoot).toBe("/tmp/x");
    expect(start.logPaths).toEqual(["/tmp/x/exec.log"]);
    expect(start.startedAt).toBe(2000);
  });

  it("feeds planSingleShotRoundStart to a coherent durable round-start record", () => {
    const invocation = planSingleShotInvocation({
      family: "script",
      workflowRunId: "run9",
      stepRunId: "step9",
      stepKey: "merge-cleanup",
      attempt: 1,
      startedAt: 1
    });

    const start = planSingleShotRoundStartForInvocation({
      invocation,
      selection: SCRIPT_SELECTION,
      runtime: { inputDigest: null, artifactRoot: null },
      startedAt: 10
    });
    const round = planSingleShotRoundStart(start);

    expect(round.roundId).toBe(singleShotRoundId(invocation.invocationId));
    expect(round.invocationId).toBe(invocation.invocationId);
    expect(round.executorFamily).toBe("script");
    expect(round.attempt).toBe(1);
    expect(round.roundIndex).toBe(0);
    expect(round.state).toBe("running");
    expect(round.startedAt).toBe(10);
    // logPaths omitted by the runtime -> empty array in the durable record.
    expect(round.logPaths).toEqual([]);
  });

  it("omits logPaths from the start input when the runtime omits them", () => {
    const invocation = planSingleShotInvocation({
      family: "one-shot",
      workflowRunId: "r",
      stepRunId: "s",
      stepKey: "preflight",
      attempt: 0,
      startedAt: 1
    });

    const start = planSingleShotRoundStartForInvocation({
      invocation,
      selection: ONE_SHOT_SELECTION,
      runtime: { inputDigest: null, artifactRoot: null },
      startedAt: 2
    });

    expect("logPaths" in start).toBe(false);
  });

  it("refuses to start a round for an invocation that is not a single-shot family", () => {
    const invocation = {
      ...planSingleShotInvocation({
        family: "one-shot",
        workflowRunId: "run1",
        stepRunId: "step1",
        stepKey: "implementation",
        attempt: 0,
        startedAt: 1
      }),
      executorFamily: "goal-loop" as WorkflowExecutorFamily
    };

    expect(() =>
      planSingleShotRoundStartForInvocation({
        invocation,
        selection: ONE_SHOT_SELECTION,
        runtime: { inputDigest: null, artifactRoot: null },
        startedAt: 2
      })
    ).toThrow(/single-shot/i);
  });
});

describe("resolveSingleShotRoundSelection — precedence", () => {
  it("resolves every field from the step config when it provides them", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: {
        agentProvider: "claude",
        model: "claude-opus-4-8",
        effort: "high",
        timeoutMs: 600_000,
        policyEnvelope: "delegated:standard"
      }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.model).toBe("claude-opus-4-8");
    expect(selection.effort).toBe("high");
    expect(selection.timeoutMs).toBe(600_000);
    expect(selection.policyEnvelope).toBe("delegated:standard");
    expect(selection.source).toEqual({
      agentProvider: "step_definition",
      model: "step_definition",
      effort: "step_definition",
      timeoutMs: "step_definition",
      policyEnvelope: "step_definition"
    });
  });

  it("resolves no round budget — a single shot owns exactly one round", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: { agentProvider: "claude" }
    });
    // Unlike the goal-loop selection, there is no maxRounds field at all: a single
    // shot has no loop budget to resolve.
    expect("maxRounds" in selection).toBe(false);
    expect("maxRounds" in selection.source).toBe(false);
  });

  it("falls back to workflow defaults for fields the step config omits", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: { agentProvider: "claude" },
      workflowConfig: { model: "claude-sonnet-4-6", effort: "medium" }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.source.agentProvider).toBe("step_definition");
    expect(selection.model).toBe("claude-sonnet-4-6");
    expect(selection.source.model).toBe("workflow_definition");
    expect(selection.effort).toBe("medium");
    expect(selection.source.effort).toBe("workflow_definition");
  });

  it("falls back to repository policy below the workflow defaults", () => {
    const selection = resolveSingleShotRoundSelection({
      workflowConfig: { agentProvider: "claude" },
      repositoryPolicy: { effort: "medium", timeoutMs: 120_000 }
    });
    expect(selection.effort).toBe("medium");
    expect(selection.source.effort).toBe("repository_policy");
    expect(selection.timeoutMs).toBe(120_000);
    expect(selection.source.timeoutMs).toBe("repository_policy");
  });

  it("falls back to the executor family default below repository policy", () => {
    const selection = resolveSingleShotRoundSelection({
      repositoryPolicy: { agentProvider: "claude" },
      familyDefault: { effort: "high", policyEnvelope: "script:bounded" }
    });
    expect(selection.effort).toBe("high");
    expect(selection.source.effort).toBe("executor_family_default");
    expect(selection.policyEnvelope).toBe("script:bounded");
    expect(selection.source.policyEnvelope).toBe("executor_family_default");
  });

  it("uses the momentum global default as the floor for unspecified fields", () => {
    const selection = resolveSingleShotRoundSelection({});
    expect(selection.agentProvider).toBeNull();
    expect(selection.model).toBeNull();
    expect(selection.effort).toBeNull();
    expect(selection.timeoutMs).toBeNull();
    expect(selection.policyEnvelope).toBeNull();
    for (const source of Object.values(selection.source)) {
      expect(source).toBe("momentum_global_default");
    }
  });

  it("resolves each field independently from a different precedence level", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: { agentProvider: "claude" },
      workflowConfig: { model: "claude-sonnet-4-6" },
      repositoryPolicy: { effort: "medium" },
      familyDefault: { timeoutMs: 300_000 },
      globalDefault: { policyEnvelope: "default" }
    });
    expect(selection.source).toEqual({
      agentProvider: "step_definition",
      model: "workflow_definition",
      effort: "repository_policy",
      timeoutMs: "executor_family_default",
      policyEnvelope: "momentum_global_default"
    });
    expect(selection.timeoutMs).toBe(300_000);
    expect(selection.policyEnvelope).toBe("default");
  });

  it("treats an explicit null at a higher level as a deliberate override", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: { model: null },
      workflowConfig: { model: "claude-sonnet-4-6" }
    });
    expect(selection.model).toBeNull();
    expect(selection.source.model).toBe("step_definition");
  });

  it("lets an explicit global default override the built-in null floor", () => {
    const selection = resolveSingleShotRoundSelection({
      globalDefault: { agentProvider: "claude", timeoutMs: 90_000 }
    });
    expect(selection.agentProvider).toBe("claude");
    expect(selection.source.agentProvider).toBe("momentum_global_default");
    expect(selection.timeoutMs).toBe(90_000);
  });

  it("exposes an all-null built-in global default selection", () => {
    expect(SINGLE_SHOT_GLOBAL_DEFAULT_SELECTION).toEqual({
      agentProvider: null,
      model: null,
      effort: null,
      timeoutMs: null,
      policyEnvelope: null
    });
  });

  it("feeds a resolved selection straight into planSingleShotRoundStart", () => {
    const selection = resolveSingleShotRoundSelection({
      stepConfig: {
        agentProvider: "claude",
        model: "claude-opus-4-8",
        effort: "high"
      }
    });
    const round = planSingleShotRoundStart({
      roundId: "r0",
      invocationId: "inv0",
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "preflight",
      family: "one-shot",
      attempt: 0,
      selection,
      inputDigest: null,
      artifactRoot: null,
      startedAt: 1
    });
    // The resolver's agent/model/effort are the ones frozen into the round-start
    // record; timeout/policy/source ride on the selection for the invocation.
    expect(round.agentProvider).toBe("claude");
    expect(round.model).toBe("claude-opus-4-8");
    expect(round.effort).toBe("high");
  });
});

describe("planSingleShotRoundArtifacts", () => {
  const ARTIFACT_CLASS_SET = new Set<string>(EXECUTOR_ARTIFACT_CLASSES);

  function fullArtifacts(): SingleShotRoundArtifacts {
    return {
      resultDocument: {
        path: "/artifacts/round-0/result.json",
        digest: "sha256:r"
      },
      checkpointStream: { path: "/artifacts/round-0/checkpoints.ndjson" },
      verificationOutput: {
        path: "/artifacts/round-0/verify.log",
        description: "pnpm test"
      },
      commitOrResetEvidence: { path: "/artifacts/round-0/commit.txt" },
      recoveryNote: { path: "/artifacts/round-0/recovery.md" }
    };
  }

  it("derives one logs artifact per bounded log path, in order", () => {
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: ["/artifacts/round-0/stdout.log", "/artifacts/round-0/stderr.log"]
    });
    expect(records).toEqual([
      {
        artifactId: "round-0-logs-0",
        roundId: "round-0",
        artifactClass: "logs",
        path: "/artifacts/round-0/stdout.log",
        digest: null,
        description: null
      },
      {
        artifactId: "round-0-logs-1",
        roundId: "round-0",
        artifactClass: "logs",
        path: "/artifacts/round-0/stderr.log",
        digest: null,
        description: null
      }
    ]);
  });

  it("maps each reported pointer to its contract artifact class with a deterministic id", () => {
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: [],
      artifacts: fullArtifacts()
    });
    const byClass = new Map(records.map((r) => [r.artifactClass, r]));
    expect(byClass.get("result_document")).toEqual({
      artifactId: "round-0-result_document",
      roundId: "round-0",
      artifactClass: "result_document",
      path: "/artifacts/round-0/result.json",
      digest: "sha256:r",
      description: null
    });
    expect(byClass.get("checkpoint_stream")?.artifactId).toBe(
      "round-0-checkpoint_stream"
    );
    expect(byClass.get("verification_output")?.description).toBe("pnpm test");
    expect(byClass.get("commit_or_reset_evidence")?.path).toBe(
      "/artifacts/round-0/commit.txt"
    );
    expect(byClass.get("recovery_note")?.path).toBe(
      "/artifacts/round-0/recovery.md"
    );
    for (const record of records) {
      expect(ARTIFACT_CLASS_SET.has(record.artifactClass)).toBe(true);
    }
  });

  it("orders artifacts in the contract artifact-class order", () => {
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: ["/artifacts/round-0/stdout.log"],
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
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: [],
      artifacts: {
        resultDocument: { path: "/artifacts/round-0/result.json" },
        recoveryNote: null
      }
    });
    expect(records.map((r) => r.artifactClass)).toEqual(["result_document"]);
  });

  it("records no artifacts when no logs and no pointers are present", () => {
    expect(
      planSingleShotRoundArtifacts({ roundId: "round-0", logPaths: [] })
    ).toEqual([]);
  });

  it("defaults digest and description to null when a pointer omits them", () => {
    const [record] = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: [],
      artifacts: { resultDocument: { path: "/artifacts/round-0/result.json" } }
    });
    expect(record?.digest).toBeNull();
    expect(record?.description).toBeNull();
  });

  it("projects a one-shot round's result-file document as a result_document artifact", () => {
    // The one-shot family produces a normalized result document (a RunnerResult
    // file); it is the durable result-file evidence the round captured.
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: ["/artifacts/round-0/exec.log"],
      artifacts: {
        resultDocument: {
          path: "/artifacts/round-0/result.json",
          digest: "sha256:result"
        },
        verificationOutput: { path: "/artifacts/round-0/verify.log" }
      }
    });
    const result = records.find((r) => r.artifactClass === "result_document");
    expect(result?.path).toBe("/artifacts/round-0/result.json");
    expect(result?.digest).toBe("sha256:result");
    // The bounded log rides alongside the result file.
    expect(records.some((r) => r.artifactClass === "logs")).toBe(true);
  });

  it("projects a script round's bounded logs and commit evidence with no result document", () => {
    // The script family is exit-code based with bounded logs and no required
    // result file, so it records logs + commit/reset evidence and no
    // result_document row.
    const records = planSingleShotRoundArtifacts({
      roundId: "round-0",
      logPaths: ["/artifacts/round-0/stdout.log", "/artifacts/round-0/stderr.log"],
      artifacts: {
        commitOrResetEvidence: { path: "/artifacts/round-0/commit.txt" }
      }
    });
    expect(records.some((r) => r.artifactClass === "result_document")).toBe(
      false
    );
    expect(
      records.filter((r) => r.artifactClass === "logs").map((r) => r.path)
    ).toEqual([
      "/artifacts/round-0/stdout.log",
      "/artifacts/round-0/stderr.log"
    ]);
    expect(
      records.some((r) => r.artifactClass === "commit_or_reset_evidence")
    ).toBe(true);
  });
});

describe("planSingleShotRoundCheckpoints", () => {
  it("records the full lifecycle stage stream for a one-shot round that captured a result", () => {
    const records = planSingleShotRoundCheckpoints({
      roundId: "round-0",
      outcome: { ok: true },
      capturedResult: true,
      classification: "complete"
    });
    expect(records).toEqual([
      {
        checkpointId: "round-0-checkpoint-0",
        roundId: "round-0",
        sequence: 0,
        stage: "round_started",
        detail: null
      },
      {
        checkpointId: "round-0-checkpoint-1",
        roundId: "round-0",
        sequence: 1,
        stage: "mechanism_completed",
        detail: "invocation outcome: ok"
      },
      {
        checkpointId: "round-0-checkpoint-2",
        roundId: "round-0",
        sequence: 2,
        stage: "result_captured",
        detail: null
      },
      {
        checkpointId: "round-0-checkpoint-3",
        roundId: "round-0",
        sequence: 3,
        stage: "classified",
        detail: "classification: complete"
      }
    ]);
  });

  it("omits the result_captured stage for a script round (exit-code based, no result document)", () => {
    // The script family is exit-code based and captures no result document, so a
    // successful script round records no result_captured stage.
    const records = planSingleShotRoundCheckpoints({
      roundId: "round-0",
      outcome: { ok: true },
      capturedResult: false,
      classification: "complete"
    });
    expect(records.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "classified"
    ]);
    expect(records[1]?.detail).toBe("invocation outcome: ok");
    expect(records[2]?.detail).toBe("classification: complete");
  });

  it("carries the recovery code in the mechanism stage for a failed invocation", () => {
    // A failed invocation captured no result, so result_captured is omitted; the
    // mechanism stage names the precise recovery code and the terminal stage the
    // daemon classification, so the coarse stream explains how far the round got.
    const records = planSingleShotRoundCheckpoints({
      roundId: "round-0",
      outcome: { ok: false, recoveryCode: "command_failed" },
      capturedResult: false,
      classification: "failed"
    });
    expect(records.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "classified"
    ]);
    expect(records[1]?.detail).toBe("invocation outcome: command_failed");
    expect(records[2]?.detail).toBe("classification: failed");
  });

  it("numbers sequences from 0 with deterministic, collision-free ids", () => {
    const records = planSingleShotRoundCheckpoints({
      roundId: "round-7",
      outcome: { ok: false, recoveryCode: "head_mismatch" },
      capturedResult: false,
      classification: "manual_recovery_required"
    });
    expect(records.map((c) => c.sequence)).toEqual([0, 1, 2]);
    // (round_id, sequence) is unique per the schema; the ids embed both so a
    // re-projection of the same round yields the same checkpoint ids.
    expect(new Set(records.map((c) => c.sequence)).size).toBe(records.length);
    expect(records.map((c) => c.checkpointId)).toEqual([
      "round-7-checkpoint-0",
      "round-7-checkpoint-1",
      "round-7-checkpoint-2"
    ]);
  });
});

describe("planSingleShotRoundPersistence", () => {
  const oneShotResult: RunnerResult = {
    success: true,
    summary: "ran the one-shot review pass",
    key_changes_made: ["approved the bounded change"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: true,
    commit: {
      type: "chore",
      scope: "single-shot",
      subject: "one-shot pass",
      body: "",
      breaking: false
    }
  };

  it("captures the normalized result then settles a one-shot success", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: true },
      result: oneShotResult,
      resultDigest: "sha256:result",
      evidence: {
        verificationStatus: "passed",
        commitSha: "a".repeat(40),
        changedFiles: ["src/x.ts"]
      }
    });
    expect(plan.captureUpdate).toEqual({
      toState: "capturing_result",
      summary: "ran the one-shot review pass",
      keyChanges: ["approved the bounded change"],
      remainingWork: [],
      resultDigest: "sha256:result"
    });
    expect(plan.terminalUpdate).toEqual({
      toState: "succeeded",
      classification: "complete",
      recoveryCode: null,
      humanGate: null,
      verificationStatus: "passed",
      commitSha: "a".repeat(40),
      changedFiles: ["src/x.ts"]
    });
    // The plan composes decideSingleShotInvocation; the decision can never disagree
    // with the patches because both derive from the one outcome.
    expect(plan.decision).toEqual(decideSingleShotInvocation({ ok: true }));
  });

  it("emits a bare capture for a script success so it can still reach succeeded", () => {
    // The script family is exit-code based and captures no result document, but the
    // round transition graph forbids running -> succeeded directly, so a successful
    // script round still emits a (bare) capturing_result patch — the structural
    // difference from goal-loop, which keys the capture on a non-null result.
    const plan = planSingleShotRoundPersistence({ outcome: { ok: true } });
    expect(plan.captureUpdate).toEqual({ toState: "capturing_result" });
    expect(plan.terminalUpdate).toEqual({
      toState: "succeeded",
      classification: "complete",
      recoveryCode: null,
      humanGate: null
    });
  });

  it("rejects a successful captured result marked failed", () => {
    expect(() =>
      planSingleShotRoundPersistence({
        outcome: { ok: true },
        result: { ...oneShotResult, success: false }
      })
    ).toThrow("successful result document");
  });

  it("does not stamp a result digest when no result document was captured", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: true },
      resultDigest: "sha256:result"
    });
    expect(plan.captureUpdate).toEqual({ toState: "capturing_result" });
  });

  it("routes an execution failure from running straight to failed with no capture", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "command_failed" }
    });
    expect(plan.captureUpdate).toBeNull();
    expect(plan.terminalUpdate).toEqual({
      toState: "failed",
      classification: "failed",
      recoveryCode: "command_failed",
      humanGate: null
    });
  });

  it("blocks on a missing credential and raises the credential gate", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "auth_unavailable" }
    });
    expect(plan.captureUpdate).toBeNull();
    expect(plan.terminalUpdate).toEqual({
      toState: "blocked",
      classification: "blocked",
      recoveryCode: "auth_unavailable",
      humanGate: "credential_required"
    });
  });

  it("routes an unsafe finalize outcome to manual recovery and preserves the code", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "head_mismatch" }
    });
    expect(plan.captureUpdate).toBeNull();
    expect(plan.terminalUpdate).toEqual({
      toState: "manual_recovery_required",
      classification: "manual_recovery_required",
      recoveryCode: "head_mismatch",
      humanGate: "manual_recovery_required"
    });
  });

  it("does not stamp commit evidence on non-success outcomes", () => {
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "head_mismatch" },
      evidence: {
        verificationStatus: "failed",
        commitSha: "a".repeat(40),
        changedFiles: ["src/x.ts"]
      }
    });
    expect(plan.terminalUpdate).toEqual({
      toState: "manual_recovery_required",
      classification: "manual_recovery_required",
      recoveryCode: "head_mismatch",
      humanGate: "manual_recovery_required",
      verificationStatus: "failed"
    });
  });

  it("rejects changed files without a commit sha", () => {
    expect(() =>
      planSingleShotRoundPersistence({
        outcome: { ok: true },
        evidence: { changedFiles: ["src/x.ts"] }
      })
    ).toThrow("changedFiles requires commitSha");
  });

  it("rejects invalid commit shas on successful outcomes", () => {
    for (const commitSha of ["", "not-a-sha", "a".repeat(39), "g".repeat(40)]) {
      expect(() =>
        planSingleShotRoundPersistence({
          outcome: { ok: true },
          evidence: { commitSha }
        })
      ).toThrow("commitSha must be a 40-character hex SHA");
    }
  });

  it("rejects unknown verification statuses", () => {
    expect(() =>
      planSingleShotRoundPersistence({
        outcome: { ok: false, recoveryCode: "command_failed" },
        evidence: { verificationStatus: "oops" as never }
      })
    ).toThrow("verificationStatus");
  });

  it("rejects failed verification evidence on successful outcomes", () => {
    expect(() =>
      planSingleShotRoundPersistence({
        outcome: { ok: true },
        evidence: { verificationStatus: "failed" }
      })
    ).toThrow("successful outcomes");
  });

  it("stamps terminal evidence only when provided so a bare failure keeps round-start nulls", () => {
    // No evidence: the terminal patch carries no verification / commit / changed-file
    // keys, so `coalesce` keeps the round-start record's nulls / empties in place.
    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "command_timed_out" }
    });
    expect(plan.terminalUpdate).not.toHaveProperty("verificationStatus");
    expect(plan.terminalUpdate).not.toHaveProperty("commitSha");
    expect(plan.terminalUpdate).not.toHaveProperty("changedFiles");
  });
});
