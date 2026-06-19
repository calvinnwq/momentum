import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRealWorkflowStepExecutorRegistry,
  createUnconfiguredWorkflowStepExecutor
} from "../src/core/workflow/step-executor-real-adapters.js";
import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind
} from "../src/core/workflow/step-executor.js";
import {
  parseLiveWrapperProfile,
  type LiveWrapperProfile
} from "../src/adapters/live-wrapper-registry.js";

/**
 * RC-5 (NGX-485): real `WorkflowStepExecutor` adapters replace the shipped fake
 * `ADAPTERS` map. This suite pins the new production adapter-registry builder in
 * isolation: it reuses the M9 live-wrapper boundary for configured kinds and is
 * honest (`runtime_unavailable`, never a fabricated success) for kinds without a
 * configured live wrapper. The fake remains test-only and is exercised through
 * its own seam, not this registry.
 */

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-real-adapter-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeInput(
  overrides: Partial<WorkflowStepExecutorInput> & {
    kind: WorkflowStepExecutorKind;
  }
): WorkflowStepExecutorInput {
  const { kind, ...rest } = overrides;
  return {
    runId: "wfrun-real-0001",
    stepId: rest.stepId ?? `${kind}-step`,
    kind,
    attempt: 1,
    repoPath: "/tmp/momentum-repo",
    runDir: "/tmp/momentum-repo/.agent-workflows/wfrun-real-0001",
    resultJsonPath:
      "/tmp/momentum-repo/.agent-workflows/wfrun-real-0001/result.json",
    executorLogPath:
      "/tmp/momentum-repo/.agent-workflows/wfrun-real-0001/executor.log",
    ...rest
  };
}

function adapterFor(
  registry: ReadonlyMap<WorkflowStepExecutorKind, WorkflowStepExecutor>,
  kind: WorkflowStepExecutorKind
): WorkflowStepExecutor {
  const adapter = registry.get(kind);
  if (!adapter) throw new Error(`test setup: missing adapter for ${kind}`);
  return adapter;
}

const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "live implementation step succeeded",
  key_changes_made: ["did the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: { type: "chore", subject: "do the thing", body: "", breaking: false }
});
const WRITE_VALID_RESULT = `printf '%s' '${VALID_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

function profileWith(
  kind: WorkflowStepExecutorKind,
  args: string[]
): LiveWrapperProfile {
  const parsed = parseLiveWrapperProfile({
    name: "real-adapter-test",
    wrappers: {
      [kind]: {
        command: "/bin/sh",
        args,
        cwd: "iteration",
        timeout_sec: 30,
        env_allow: [],
        result_file: "result.json"
      }
    }
  });
  if (!parsed.ok) throw new Error(`test setup: bad profile: ${parsed.error}`);
  return parsed.profile;
}

describe("buildRealWorkflowStepExecutorRegistry", () => {
  it("registers a real executor for every canonical workflow step kind", () => {
    const registry = buildRealWorkflowStepExecutorRegistry();
    expect([...registry.keys()]).toEqual([...WORKFLOW_STEP_EXECUTOR_KINDS]);
    for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
      const adapter = adapterFor(registry, kind);
      expect(adapter.kind).toBe(kind);
      expect(adapter.executes).toBe(true);
    }
  });

  it("resolves every kind to an honest runtime_unavailable adapter when no profile is configured", () => {
    const registry = buildRealWorkflowStepExecutorRegistry();
    for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
      const input = makeInput({ kind });
      const out = adapterFor(registry, kind).execute(input);
      expect(out.ok, `expected ${kind} to refuse without a live wrapper`).toBe(
        false
      );
      if (out.ok) continue;
      expect(out.code).toBe("runtime_unavailable");
      expect(out.error).toContain(kind);
      expect(out.executorLogPath).toBe(input.executorLogPath);
      expect(out.resultJsonPath).toBe(input.resultJsonPath);
    }
  });

  it("runs a configured kind through the real live wrapper end to end", () => {
    const repoPath = makeTempDir("momentum-real-adapter-repo-");
    const runDir = makeTempDir("momentum-real-adapter-run-");
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("implementation", ["-c", WRITE_VALID_RESULT])
    });
    const out = adapterFor(registry, "implementation").execute(
      makeInput({
        kind: "implementation",
        repoPath,
        runDir,
        executorLogPath: path.join(runDir, "executor.log"),
        resultJsonPath: path.join(runDir, "result.json")
      })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("succeeded");
    expect(out.diagnostics?.executor).toBe("live");
  });

  it("maps a failing configured command to command_failed via the live wrapper", () => {
    const repoPath = makeTempDir("momentum-real-adapter-repo-");
    const runDir = makeTempDir("momentum-real-adapter-run-");
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("implementation", ["-c", "exit 9"])
    });
    const out = adapterFor(registry, "implementation").execute(
      makeInput({
        kind: "implementation",
        repoPath,
        runDir,
        executorLogPath: path.join(runDir, "executor.log")
      })
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
  });

  it("leaves the other canonical kinds runtime_unavailable when only one is configured", () => {
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("implementation", ["-c", "true"])
    });
    const out = adapterFor(registry, "postflight").execute(
      makeInput({ kind: "postflight" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
  });
});

describe("createUnconfiguredWorkflowStepExecutor", () => {
  it("reports the kind, executes, and refuses with runtime_unavailable carrying the step paths", () => {
    const executor = createUnconfiguredWorkflowStepExecutor("merge-cleanup");
    expect(executor.kind).toBe("merge-cleanup");
    expect(executor.executes).toBe(true);
    const input = makeInput({ kind: "merge-cleanup" });
    const out = executor.execute(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("merge-cleanup");
    expect(out.executorLogPath).toBe(input.executorLogPath);
    expect(out.resultJsonPath).toBe(input.resultJsonPath);
  });
});
