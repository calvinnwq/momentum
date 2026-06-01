import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LIVE_STEP_EXECUTOR_ERROR_CODE_BY_RECOVERY_CODE,
  buildLiveStepWrapperInput,
  createLiveWorkflowStepExecutor,
  createLiveWorkflowStepExecutorsFromProfile,
  mapLiveStepWrapperResult
} from "../src/live-step-executor.js";
import {
  LIVE_STEP_WRAPPER_RECOVERY_CODES,
  type LiveStepWrapperError,
  type LiveStepWrapperSuccess
} from "../src/live-step-wrapper.js";
import {
  WORKFLOW_STEP_EXECUTOR_ERROR_CODES,
  type WorkflowStepExecutorInput
} from "../src/workflow-step-executor.js";
import {
  parseLiveWrapperProfile,
  type LiveWrapperConfig
} from "../src/live-wrapper-registry.js";
import type { RunnerResult } from "../src/runner-result.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-live-exec-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const RUNNER_RESULT: RunnerResult = {
  success: true,
  summary: "live implementation step succeeded",
  key_changes_made: ["did the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "chore",
    scope: undefined,
    subject: "do the thing",
    body: "",
    breaking: false
  }
};

function makeWrapperSuccess(
  overrides: Partial<LiveStepWrapperSuccess> = {}
): LiveStepWrapperSuccess {
  return {
    ok: true,
    result: RUNNER_RESULT,
    resultJsonPath: "/iter/result.json",
    executorLogPath: "/run/executor.log",
    diagnostics: {
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: "/iter",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      probed: false
    },
    ...overrides
  };
}

function makeWrapperError(
  overrides: Partial<LiveStepWrapperError> & Pick<LiveStepWrapperError, "code">
): LiveStepWrapperError {
  return {
    ok: false,
    error: `live wrapper failed: ${overrides.code}`,
    resultJsonPath: "/iter/result.json",
    executorLogPath: "/run/executor.log",
    ...overrides
  };
}

function makeExecutorInput(
  overrides: Partial<WorkflowStepExecutorInput> = {}
): WorkflowStepExecutorInput {
  return {
    runId: "wfrun-deadbeef",
    stepId: "implementation-step",
    kind: "implementation",
    attempt: 1,
    repoPath: "/tmp/momentum-repo",
    runDir: "/tmp/momentum-repo/.agent-workflows/wfrun-deadbeef",
    resultJsonPath:
      "/tmp/momentum-repo/.agent-workflows/wfrun-deadbeef/result.json",
    executorLogPath:
      "/tmp/momentum-repo/.agent-workflows/wfrun-deadbeef/executor.log",
    ...overrides
  };
}

function makeConfig(overrides: Partial<LiveWrapperConfig> = {}): LiveWrapperConfig {
  return {
    command: "/bin/sh",
    args: [],
    cwd: "iteration",
    timeoutSec: 30,
    envAllow: [],
    resultFile: "result.json",
    probe: undefined,
    ...overrides
  };
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

describe("mapLiveStepWrapperResult — success", () => {
  it("maps a successful wrapper run to a succeeded executor result", () => {
    const out = mapLiveStepWrapperResult(makeWrapperSuccess());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("succeeded");
    expect(out.result.summary).toBe("live implementation step succeeded");
    expect(out.result.errorCode).toBeNull();
    expect(out.result.errorMessage).toBeNull();
    expect(out.executorLogPath).toBe("/run/executor.log");
    expect(out.resultJsonPath).toBe("/iter/result.json");
  });

  it("records the executor log and runner result as artifacts and marks the executor live", () => {
    const out = mapLiveStepWrapperResult(makeWrapperSuccess());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.artifacts).toEqual([
      { kind: "executor-log", path: "/run/executor.log" },
      { kind: "runner-result", path: "/iter/result.json" }
    ]);
    expect(out.diagnostics?.executor).toBe("live");
    expect(out.diagnostics?.command).toBe("/bin/sh");
    expect(out.diagnostics?.runnerSuccess).toBe(true);
    expect(out.diagnostics?.goalComplete).toBe(false);
  });

  it("maps a parsed runner result with success=false to a failed executor result", () => {
    const out = mapLiveStepWrapperResult(
      makeWrapperSuccess({
        result: {
          ...RUNNER_RESULT,
          success: false,
          summary: "runner could not complete implementation"
        }
      })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("failed");
    expect(out.result.errorCode).toBe("command_failed");
    expect(out.result.errorMessage).toContain("success=false");
    expect(out.diagnostics?.runnerSuccess).toBe(false);
  });
});

describe("mapLiveStepWrapperResult — failure recovery-code mapping", () => {
  const cases: ReadonlyArray<{
    live: (typeof LIVE_STEP_WRAPPER_RECOVERY_CODES)[number];
    executor: string;
  }> = [
    { live: "runtime_unavailable", executor: "runtime_unavailable" },
    { live: "auth_unavailable", executor: "runtime_unavailable" },
    { live: "command_failed", executor: "command_failed" },
    { live: "command_timed_out", executor: "command_timed_out" },
    { live: "output_overflow", executor: "command_failed" },
    { live: "result_missing", executor: "result_missing" },
    { live: "result_invalid", executor: "result_invalid" }
  ];

  for (const { live, executor } of cases) {
    it(`maps live ${live} to executor ${executor} while preserving the precise live code`, () => {
      const out = mapLiveStepWrapperResult(makeWrapperError({ code: live }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe(executor);
      expect(out.liveRecoveryCode).toBe(live);
      expect(out.error).toContain(live);
      expect(out.executorLogPath).toBe("/run/executor.log");
    });
  }

  it("only ever emits codes from the stable executor error taxonomy", () => {
    for (const live of LIVE_STEP_WRAPPER_RECOVERY_CODES) {
      const out = mapLiveStepWrapperResult(makeWrapperError({ code: live }));
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(WORKFLOW_STEP_EXECUTOR_ERROR_CODES).toContain(out.code);
    }
  });

  it("covers every live recovery code in the mapping table", () => {
    for (const live of LIVE_STEP_WRAPPER_RECOVERY_CODES) {
      expect(LIVE_STEP_EXECUTOR_ERROR_CODE_BY_RECOVERY_CODE[live]).toBeDefined();
      expect(WORKFLOW_STEP_EXECUTOR_ERROR_CODES).toContain(
        LIVE_STEP_EXECUTOR_ERROR_CODE_BY_RECOVERY_CODE[live]
      );
    }
  });
});

describe("buildLiveStepWrapperInput", () => {
  it("maps the executor runDir to the wrapper iterationDir and forwards identity fields", () => {
    const input = makeExecutorInput();
    const wrapperInput = buildLiveStepWrapperInput(input, makeConfig());
    expect(wrapperInput.iterationDir).toBe(input.runDir);
    expect(wrapperInput.repoPath).toBe(input.repoPath);
    expect(wrapperInput.kind).toBe("implementation");
    expect(wrapperInput.runId).toBe(input.runId);
    expect(wrapperInput.stepId).toBe(input.stepId);
    expect(wrapperInput.attempt).toBe(1);
    expect(wrapperInput.executorLogPath).toBe(input.executorLogPath);
  });

  it("omits optional fields when the executor input does not provide them", () => {
    const wrapperInput = buildLiveStepWrapperInput(
      makeExecutorInput(),
      makeConfig()
    );
    expect("promptPath" in wrapperInput).toBe(false);
    expect("env" in wrapperInput).toBe(false);
    expect("outputMaxBytes" in wrapperInput).toBe(false);
  });

  it("forwards promptPath, env, and an outputMaxBytes override when present", () => {
    const env = { PATH: "/usr/bin", ALLOWED: "x" };
    const wrapperInput = buildLiveStepWrapperInput(
      makeExecutorInput({ promptPath: "/iter/prompt.md", env }),
      makeConfig(),
      { outputMaxBytes: 4096 }
    );
    expect(wrapperInput.promptPath).toBe("/iter/prompt.md");
    expect(wrapperInput.env).toBe(env);
    expect(wrapperInput.outputMaxBytes).toBe(4096);
  });
});

describe("createLiveWorkflowStepExecutor", () => {
  it("exposes the configured kind and reports that it executes", () => {
    const executor = createLiveWorkflowStepExecutor(
      "implementation",
      makeConfig()
    );
    expect(executor.kind).toBe("implementation");
    expect(executor.executes).toBe(true);
  });

  it("runs the live wrapper end to end and returns a succeeded executor result", () => {
    const repoPath = makeTempDir("momentum-live-exec-repo-");
    const runDir = makeTempDir("momentum-live-exec-run-");
    const executor = createLiveWorkflowStepExecutor(
      "implementation",
      makeConfig({ args: ["-c", WRITE_VALID_RESULT] })
    );
    const out = executor.execute(
      makeExecutorInput({
        repoPath,
        runDir,
        executorLogPath: path.join(runDir, "executor.log"),
        resultJsonPath: path.join(runDir, "result.json")
      })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.state).toBe("succeeded");
    expect(out.resultJsonPath).toBe(path.join(runDir, "result.json"));
    expect(fs.existsSync(path.join(runDir, "executor.log"))).toBe(true);
  });

  it("maps a failing live command to an ok:false command_failed dispatch error", () => {
    const repoPath = makeTempDir("momentum-live-exec-repo-");
    const runDir = makeTempDir("momentum-live-exec-run-");
    const executor = createLiveWorkflowStepExecutor(
      "implementation",
      makeConfig({ args: ["-c", "exit 9"] })
    );
    const out = executor.execute(
      makeExecutorInput({
        repoPath,
        runDir,
        executorLogPath: path.join(runDir, "executor.log")
      })
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
  });
});

describe("createLiveWorkflowStepExecutorsFromProfile", () => {
  it("builds one executor per configured step kind and skips unconfigured kinds", () => {
    const parsed = parseLiveWrapperProfile({
      name: "live-default",
      wrappers: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", "true"],
          cwd: "iteration",
          timeout_sec: 30,
          env_allow: [],
          result_file: "result.json"
        }
      }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const executors = createLiveWorkflowStepExecutorsFromProfile(parsed.profile);
    expect([...executors.keys()]).toEqual(["implementation"]);
    expect(executors.get("implementation")?.executes).toBe(true);
    expect(executors.has("postflight")).toBe(false);
  });
});
