import { describe, expect, it } from "vitest";

import {
  WORKFLOW_STEP_EXECUTOR_ERROR_CODES,
  WORKFLOW_STEP_EXECUTOR_KINDS,
  WORKFLOW_STEP_EXECUTOR_RECOVERY_HINTS,
  WORKFLOW_STEP_EXECUTOR_RETRY_HINTS,
  WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES,
  dispatchWorkflowStepExecutor,
  getWorkflowStepExecutor,
  isWorkflowStepExecutorKind,
  listExecutingWorkflowStepExecutorKinds,
  listWorkflowStepExecutorKinds,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
} from "../src/core/workflow/step/executor.js";
import { buildFakeWorkflowStepExecutorRegistry } from "./helpers/fake-workflow-step-executor.js";
import {
  deriveWorkflowRunState,
  isTerminalStepState,
  transitionWorkflowStep,
  type WorkflowStepRecord,
} from "../src/core/workflow/run/reducer.js";

function makeInput(
  overrides: Partial<WorkflowStepExecutorInput> & {
    kind: WorkflowStepExecutorKind;
  },
): WorkflowStepExecutorInput {
  const { kind, ...rest } = overrides;
  return {
    runId: "cwfp-deadbeef",
    stepId: rest.stepId ?? `${kind}-step`,
    kind,
    attemptNumber: 1,
    repoPath: "/tmp/momentum-repo",
    runDir: "/tmp/momentum-repo/.agent-workflows/cwfp-deadbeef",
    resultJsonPath:
      "/tmp/momentum-repo/.agent-workflows/cwfp-deadbeef/result.json",
    executorLogPath:
      "/tmp/momentum-repo/.agent-workflows/cwfp-deadbeef/executor.log",
    ...rest,
  };
}

/**
 * RC-5 (NGX-485) flipped the production default to real adapters and moved the
 * deterministic fake behind a test-only seam. The boundary contract injects that
 * seam through `dispatchWorkflowStepExecutor`'s `registry` parameter to exercise
 * the fake outcome / config surface, while the production-default cases dispatch
 * with no registry to prove the honest `runtime_unavailable` default.
 */
const FAKE_REGISTRY = buildFakeWorkflowStepExecutorRegistry();

function dispatchFake(
  kind: string,
  input: WorkflowStepExecutorInput,
): ReturnType<typeof dispatchWorkflowStepExecutor> {
  return dispatchWorkflowStepExecutor(kind, input, FAKE_REGISTRY);
}

describe("workflow-step-executor registry", () => {
  it("registers one executor per canonical step kind", () => {
    expect([...listWorkflowStepExecutorKinds()]).toEqual([
      ...WORKFLOW_STEP_EXECUTOR_KINDS,
    ]);
  });

  it("includes preflight, implementation, postflight, no-mistakes, merge-cleanup, linear-refresh", () => {
    for (const kind of [
      "preflight",
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup",
      "linear-refresh",
    ] as const) {
      const adapter = getWorkflowStepExecutor(kind);
      expect(adapter, `expected executor for ${kind}`).toBeDefined();
      expect(adapter?.kind).toBe(kind);
      expect(adapter?.executes).toBe(true);
    }
  });

  it("marks every built-in kind as executing through the real default adapters", () => {
    expect([...listExecutingWorkflowStepExecutorKinds()]).toEqual([
      ...WORKFLOW_STEP_EXECUTOR_KINDS,
    ]);
  });

  it("returns undefined for unknown step kinds", () => {
    expect(getWorkflowStepExecutor("gnhf")).toBeUndefined();
    expect(getWorkflowStepExecutor("")).toBeUndefined();
    expect(isWorkflowStepExecutorKind("gnhf")).toBe(false);
  });

  it("exposes stable error code, retry hint, recovery hint, terminal state vocabularies", () => {
    expect([...WORKFLOW_STEP_EXECUTOR_ERROR_CODES].sort()).toEqual(
      [
        "invalid_input",
        "unsupported_step",
        "executor_threw",
        "result_invalid",
        "result_missing",
        "command_failed",
        "command_timed_out",
        "unsupported_platform",
        "runtime_unavailable",
        "dispatch_lease_unavailable",
        "manual_recovery_required",
      ].sort(),
    );
    expect([...WORKFLOW_STEP_EXECUTOR_RETRY_HINTS]).toEqual([
      "retry_now",
      "retry_after_delay",
      "do_not_retry",
    ]);
    expect([...WORKFLOW_STEP_EXECUTOR_RECOVERY_HINTS]).toEqual([
      "resume",
      "skip_already_complete",
      "repair_required",
      "manual_recovery_required",
    ]);
    expect([...WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES]).toEqual([
      "succeeded",
      "failed",
      "skipped",
    ]);
  });
});

describe("dispatchWorkflowStepExecutor production default (honest, no fake)", () => {
  it("refuses with runtime_unavailable for the unconfigured default and surfaces the log/result paths", () => {
    const input = makeInput({ kind: "preflight" });
    const out = dispatchWorkflowStepExecutor("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("preflight");
    expect(out.executorLogPath).toBe(input.executorLogPath);
    expect(out.resultJsonPath).toBe(input.resultJsonPath);
  });

  it("never fabricates a terminal success for any canonical kind by default", () => {
    for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
      const out = dispatchWorkflowStepExecutor(kind, makeInput({ kind }));
      expect(out.ok, `expected ${kind} default to refuse`).toBe(false);
      if (out.ok) continue;
      expect(out.code).toBe("runtime_unavailable");
    }
  });
});

describe("dispatchWorkflowStepExecutor through the injected fake seam", () => {
  it("returns a succeeded fake result for the default outcome and surfaces the log/result paths", () => {
    const input = makeInput({ kind: "preflight" });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("succeeded");
    expect(out.result.errorCode).toBeNull();
    expect(out.result.retryHint).toBeNull();
    expect(out.result.recoveryHint).toBeNull();
    expect(out.result.checkpoints.length).toBeGreaterThan(0);
    expect(out.executorLogPath).toBe(input.executorLogPath);
    expect(out.resultJsonPath).toBe(input.resultJsonPath);
    expect(out.diagnostics?.executor).toBe("fake");
  });

  it("propagates configured artifacts and digest on success without leaking tool-specific fields", () => {
    const input = makeInput({
      kind: "implementation",
      config: {
        artifacts: [
          { kind: "plan", path: "plan.json", digest: "sha256:abc" },
          { kind: "ledger", path: "ledger.jsonl" },
        ],
        resultDigest: "sha256:result",
      },
    });
    const out = dispatchFake("implementation", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.artifacts).toEqual([
      { kind: "plan", path: "plan.json", digest: "sha256:abc" },
      { kind: "ledger", path: "ledger.jsonl" },
    ]);
    expect(out.result.resultDigest).toBe("sha256:result");
    expect(out.result).not.toHaveProperty("gnhf");
    expect(out.result).not.toHaveProperty("noMistakes");
  });

  it("maps a fail_retry outcome to a failed result with retry/recovery hints", () => {
    const input = makeInput({
      kind: "no-mistakes",
      config: { outcome: "fail_retry", errorMessage: "patch conflict" },
    });
    const out = dispatchFake("no-mistakes", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("failed");
    expect(out.result.errorCode).toBe("command_failed");
    expect(out.result.retryHint).toBe("retry_after_delay");
    expect(out.result.recoveryHint).toBe("resume");
    expect(out.result.errorMessage).toBe("patch conflict");
  });

  it("maps a fail_manual_recovery outcome to a manual_recovery_required recovery hint", () => {
    const input = makeInput({
      kind: "merge-cleanup",
      config: { outcome: "fail_manual_recovery" },
    });
    const out = dispatchFake("merge-cleanup", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("failed");
    expect(out.result.errorCode).toBe("manual_recovery_required");
    expect(out.result.retryHint).toBe("do_not_retry");
    expect(out.result.recoveryHint).toBe("manual_recovery_required");
  });

  it("maps a skip outcome to skipped with the skip_already_complete recovery hint", () => {
    const input = makeInput({
      kind: "postflight",
      config: { outcome: "skip" },
    });
    const out = dispatchFake("postflight", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("skipped");
    expect(out.result.recoveryHint).toBe("skip_already_complete");
    expect(out.result.errorCode).toBeNull();
  });

  it("traps a thrown executor as executor_threw and surfaces the configured paths", () => {
    const input = makeInput({
      kind: "implementation",
      config: { outcome: "throw", errorMessage: "boom" },
    });
    const out = dispatchFake("implementation", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("executor_threw");
    expect(out.error).toContain("boom");
    expect(out.executorLogPath).toBe(input.executorLogPath);
    expect(out.resultJsonPath).toBe(input.resultJsonPath);
  });

  it("surfaces runtime_unavailable when the executor reports missing prerequisites", () => {
    const input = makeInput({
      kind: "linear-refresh",
      config: {
        outcome: "runtime_unavailable",
        errorMessage: "linear cli not installed",
      },
    });
    const out = dispatchFake("linear-refresh", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("linear cli not installed");
  });

  it("propagates a taxonomy errorCode override on fail_retry results", () => {
    const input = makeInput({
      kind: "preflight",
      config: {
        outcome: "fail_retry",
        errorCode: "command_timed_out",
      },
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("failed");
    expect(out.result.errorCode).toBe("command_timed_out");
  });
});

describe("dispatchWorkflowStepExecutor input validation (registry-agnostic boundary)", () => {
  it("surfaces invalid_input for dispatch kind when input.kind does not match", () => {
    const base = makeInput({ kind: "preflight" });
    const out = dispatchWorkflowStepExecutor("gnhf", base);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
  });

  it("returns invalid_input when input.kind does not match dispatch kind", () => {
    const input = makeInput({ kind: "preflight" });
    const out = dispatchWorkflowStepExecutor("implementation", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("dispatch kind");
  });

  it("rejects missing required input fields before invoking the executor", () => {
    const base = makeInput({ kind: "preflight" });
    for (const field of [
      "runId",
      "stepId",
      "repoPath",
      "runDir",
      "executorLogPath",
      "resultJsonPath",
    ] as const) {
      const broken = { ...base, [field]: "" } as WorkflowStepExecutorInput;
      const out = dispatchWorkflowStepExecutor("preflight", broken);
      expect(out.ok, `expected invalid_input when ${field} is empty`).toBe(
        false,
      );
      if (out.ok) continue;
      expect(out.code).toBe("invalid_input");
      expect(out.error).toContain(field);
    }
  });

  it("rejects attempt < 1 with invalid_input", () => {
    const input = makeInput({ kind: "preflight", attemptNumber: 0 });
    const out = dispatchWorkflowStepExecutor("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("attempt");
  });
});

describe("fake seam config validation (test-only config schema)", () => {
  it("rejects malformed config with invalid_input", () => {
    const input = makeInput({
      kind: "preflight",
      config: { outcome: "explode" } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("outcome");
  });

  it("rejects config as array with invalid_input", () => {
    const input = makeInput({
      kind: "preflight",
      config: [] as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("plain object");
  });

  it("rejects non-string errorCode in config", () => {
    const input = makeInput({
      kind: "preflight",
      config: { errorCode: 42 } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("errorCode");
  });

  it("rejects errorCode strings outside the stable taxonomy", () => {
    const input = makeInput({
      kind: "preflight",
      config: {
        outcome: "fail_retry",
        errorCode: "gnhf_prompt_rejected",
      } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("errorCode");
    expect(out.error).toContain("command_failed");
  });

  it("rejects non-string errorMessage in config", () => {
    const input = makeInput({
      kind: "preflight",
      config: { errorMessage: false } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("errorMessage");
  });

  it("rejects non-string resultDigest in config", () => {
    const input = makeInput({
      kind: "preflight",
      config: { resultDigest: 99 } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("resultDigest");
  });

  it("rejects config.artifacts entries missing kind or path", () => {
    const input = makeInput({
      kind: "preflight",
      config: {
        artifacts: [{ kind: 5, path: "x" }] as unknown as Record<
          string,
          unknown
        >[],
      },
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("kind");
  });

  it("rejects non-string digest in config.artifacts entries", () => {
    const input = makeInput({
      kind: "preflight",
      config: {
        artifacts: [
          { kind: "plan", path: "p.json", digest: 3 } as unknown as Record<
            string,
            unknown
          >,
        ],
      },
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("digest");
  });

  it("rejects non-string checkpointMessages entries in config", () => {
    const input = makeInput({
      kind: "preflight",
      config: {
        checkpointMessages: [1, 2] as unknown as string[],
      },
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("strings");
  });

  it("rejects non-array config.artifacts", () => {
    const input = makeInput({
      kind: "preflight",
      config: { artifacts: "not-array" } as unknown as Record<string, unknown>,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("array");
  });

  it("rejects non-array config.checkpointMessages", () => {
    const input = makeInput({
      kind: "preflight",
      config: { checkpointMessages: "not-array" } as unknown as Record<
        string,
        unknown
      >,
    });
    const out = dispatchFake("preflight", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("strings");
  });
});

describe("fake executors driving the workflow state machine", () => {
  it("drives a full required-step chain to succeeded through transitionWorkflowStep + deriveWorkflowRunState", () => {
    const plan: ReadonlyArray<{
      stepId: string;
      kind: WorkflowStepExecutorKind;
      order: number;
      required: boolean;
    }> = [
      { stepId: "s1", kind: "preflight", order: 1, required: true },
      { stepId: "s2", kind: "implementation", order: 2, required: true },
      { stepId: "s3", kind: "postflight", order: 3, required: true },
      { stepId: "s4", kind: "no-mistakes", order: 4, required: true },
      { stepId: "s5", kind: "merge-cleanup", order: 5, required: true },
    ];

    const steps: WorkflowStepRecord[] = plan.map((p) => ({
      stepId: p.stepId,
      kind: p.kind,
      state: "approved",
      order: p.order,
      required: p.required,
    }));

    expect(deriveWorkflowRunState(steps)).toBe("approved");

    for (let i = 0; i < plan.length; i += 1) {
      const entry = plan[i];
      const step = steps[i];
      if (!entry || !step) {
        throw new Error("plan/step pair missing");
      }
      const runningTransition = transitionWorkflowStep(step.state, "running");
      expect(runningTransition.ok).toBe(true);
      if (!runningTransition.ok) return;
      step.state = runningTransition.state;
      expect(deriveWorkflowRunState(steps)).toBe("running");

      const input = makeInput({
        kind: entry.kind,
        stepId: entry.stepId,
      });
      const out = dispatchFake(entry.kind, input);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const nextState = out.result.state;
      const finalize = transitionWorkflowStep(step.state, nextState);
      expect(finalize.ok).toBe(true);
      if (!finalize.ok) return;
      step.state = finalize.state;
      expect(isTerminalStepState(step.state)).toBe(true);
    }

    expect(deriveWorkflowRunState(steps)).toBe("succeeded");
  });

  it("flips a required step into failed and surfaces the failed run state", () => {
    const steps: WorkflowStepRecord[] = [
      {
        stepId: "s1",
        kind: "preflight",
        state: "running",
        order: 1,
        required: true,
      },
    ];
    const out = dispatchFake(
      "preflight",
      makeInput({
        kind: "preflight",
        stepId: "s1",
        config: { outcome: "fail_retry" },
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finalize = transitionWorkflowStep("running", out.result.state);
    expect(finalize.ok).toBe(true);
    if (!finalize.ok) return;
    const step = steps[0];
    if (!step) throw new Error("step missing");
    step.state = finalize.state;
    expect(deriveWorkflowRunState(steps)).toBe("failed");
  });
});
