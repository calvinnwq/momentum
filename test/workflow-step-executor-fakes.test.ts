import { describe, expect, it } from "vitest";

import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  dispatchWorkflowStepExecutor,
  getWorkflowStepExecutor,
  listExecutingWorkflowStepExecutorKinds,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind
} from "../src/core/workflow/step-executor.js";
import {
  buildFakeWorkflowStepExecutorRegistry,
  createFakeWorkflowStepExecutor
} from "./helpers/fake-workflow-step-executor.js";

function makeInput(kind: WorkflowStepExecutorKind): WorkflowStepExecutorInput {
  return {
    runId: "cwfp-feedface",
    stepId: `${kind}-step`,
    kind,
    attempt: 1,
    repoPath: "/tmp/momentum-repo",
    runDir: "/tmp/momentum-repo/.agent-workflows/cwfp-feedface",
    resultJsonPath:
      "/tmp/momentum-repo/.agent-workflows/cwfp-feedface/result.json",
    executorLogPath:
      "/tmp/momentum-repo/.agent-workflows/cwfp-feedface/executor.log"
  };
}

/**
 * RC-5 (NGX-485) moved the deterministic fake `WorkflowStepExecutor` out of the
 * shipped production default into this test-only seam. These tests pin the seam
 * itself: full canonical coverage, real fake behavior, and — crucially — that
 * the seam is opt-in. Dispatching without the fake registry hits the honest
 * production default (`runtime_unavailable`); only an explicit `registry`
 * injection resolves to the fake.
 */
describe("fake WorkflowStepExecutor seam (test-only)", () => {
  it("builds a fake registry covering every canonical step kind, all executing", () => {
    const registry = buildFakeWorkflowStepExecutorRegistry();
    expect([...registry.keys()].sort()).toEqual(
      [...WORKFLOW_STEP_EXECUTOR_KINDS].sort()
    );
    for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
      const adapter = registry.get(kind);
      expect(adapter, `expected fake adapter for ${kind}`).toBeDefined();
      expect(adapter?.kind).toBe(kind);
      expect(adapter?.executes).toBe(true);
    }
  });

  it("creates a per-kind fake executor that reports a deterministic succeeded result", () => {
    const executor = createFakeWorkflowStepExecutor("implementation");
    const out = executor.execute(makeInput("implementation"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("succeeded");
    expect(out.diagnostics?.executor).toBe("fake");
  });

  it("is opt-in: the same dispatch is a fake success with the registry and runtime_unavailable without it", () => {
    const input = makeInput("preflight");

    const injected = dispatchWorkflowStepExecutor(
      "preflight",
      input,
      buildFakeWorkflowStepExecutorRegistry()
    );
    expect(injected.ok).toBe(true);
    if (injected.ok) {
      expect(injected.result.state).toBe("succeeded");
    }

    const production = dispatchWorkflowStepExecutor("preflight", input);
    expect(production.ok).toBe(false);
    if (!production.ok) {
      expect(production.code).toBe("runtime_unavailable");
    }
  });

  it("keeps listExecutingWorkflowStepExecutorKinds honest for both the default and an injected registry", () => {
    // Default: the real unconfigured adapters all execute (honest refusal at
    // execute time), so every canonical kind is reported.
    expect([...listExecutingWorkflowStepExecutorKinds()]).toEqual([
      ...WORKFLOW_STEP_EXECUTOR_KINDS
    ]);

    // A partial injected registry only reports the kinds it actually wires.
    const partial = new Map([
      ["preflight", createFakeWorkflowStepExecutor("preflight")]
    ] as const);
    expect([...listExecutingWorkflowStepExecutorKinds(partial)]).toEqual([
      "preflight"
    ]);
    expect(getWorkflowStepExecutor("implementation", partial)).toBeUndefined();
  });
});
