import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LIVE_STEP_WRAPPER_RESULT_MAX_BYTES,
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  LIVE_STEP_WRAPPER_RECOVERY_CODES,
  runLiveStepWrapper,
  type LiveStepWrapperInput
} from "../src/adapters/live-step-wrapper.js";
import type { LiveWrapperConfig } from "../src/adapters/live-wrapper-registry.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-live-step-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function shellScript(body: string): { command: string; args: string[] } {
  return { command: "/bin/sh", args: ["-c", body] };
}

// A full, valid RunnerResult document. parseRunnerResult requires success,
// summary, key_changes_made, goal_complete, and a valid commit intent.
const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "live implementation step succeeded",
  key_changes_made: ["implemented the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: { type: "chore", subject: "do the thing", body: "", breaking: false }
});

// Shell fragment that writes the valid result document to the injected
// MOMENTUM_RESULT_PATH. JSON contains only double quotes, so single-quoting it
// in the shell command is safe.
const WRITE_VALID_RESULT = `printf '%s' '${VALID_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

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

type SetupOverrides = {
  config?: Partial<LiveWrapperConfig>;
  repoPath?: string;
  iterationDir?: string;
  executorLogPath?: string;
  env?: NodeJS.ProcessEnv;
  outputMaxBytes?: number;
  promptPath?: string;
};

function setup(overrides: SetupOverrides = {}): LiveStepWrapperInput {
  const repoPath = overrides.repoPath ?? makeTempDir("momentum-live-step-repo-");
  const iterationDir =
    overrides.iterationDir ?? makeTempDir("momentum-live-step-iter-");
  const runDir = makeTempDir("momentum-live-step-run-");
  return {
    kind: "implementation",
    config: makeConfig(overrides.config),
    runId: "wfrun-deadbeef",
    stepId: "implementation-step",
    attempt: 1,
    repoPath,
    iterationDir,
    executorLogPath:
      overrides.executorLogPath ?? path.join(runDir, "executor.log"),
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
    ...(overrides.outputMaxBytes !== undefined
      ? { outputMaxBytes: overrides.outputMaxBytes }
      : {}),
    ...(overrides.promptPath !== undefined
      ? { promptPath: overrides.promptPath }
      : {})
  };
}

function readLog(input: LiveStepWrapperInput): string {
  return fs.readFileSync(input.executorLogPath, "utf-8");
}

describe("runLiveStepWrapper — success path", () => {
  it("spawns the command, captures bounded logs, and reads the normalized result file", () => {
    const input = setup({
      config: {
        args: [
          "-c",
          [
            "echo live-step-stdout",
            "echo live-step-stderr >&2",
            WRITE_VALID_RESULT
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("live implementation step succeeded");
    expect(out.resultJsonPath).toBe(
      path.join(input.iterationDir, "result.json")
    );

    const log = readLog(input);
    expect(log).toContain("[live-step] start");
    expect(log).toContain("[live-step] kind: implementation");
    expect(log).toContain("[live-step] stdout:");
    expect(log).toContain("live-step-stdout");
    expect(log).toContain("[live-step] stderr:");
    expect(log).toContain("live-step-stderr");
    expect(log).toContain("[live-step] exit_code: 0");
    expect(log).toContain("[live-step] done");
  });

  it("injects MOMENTUM_* workflow context env vars", () => {
    const input = setup({
      config: {
        args: [
          "-c",
          [
            'echo "RUN=$MOMENTUM_RUN_ID|STEP=$MOMENTUM_STEP_ID|KIND=$MOMENTUM_STEP_KIND|ATTEMPT=$MOMENTUM_ATTEMPT"',
            WRITE_VALID_RESULT
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);

    const log = readLog(input);
    expect(log).toContain(
      "RUN=wfrun-deadbeef|STEP=implementation-step|KIND=implementation|ATTEMPT=1"
    );
  });
});

describe("runLiveStepWrapper — env allowlist", () => {
  it("passes only allowlisted env keys plus MOMENTUM_* context", () => {
    const input = setup({
      env: {
        PATH: process.env.PATH,
        ALLOWED_VAR: "allowed-value",
        BLOCKED_VAR: "blocked-value"
      },
      config: {
        envAllow: ["ALLOWED_VAR"],
        args: [
          "-c",
          [
            'echo "ALLOWED=$ALLOWED_VAR|BLOCKED=$BLOCKED_VAR"',
            WRITE_VALID_RESULT
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);

    const log = readLog(input);
    expect(log).toContain("ALLOWED=allowed-value|BLOCKED=");
    expect(log).not.toContain("blocked-value");
  });

  it("does not inherit PATH unless PATH is allowlisted", () => {
    const input = setup({
      env: {
        PATH: "/tmp/untrusted-path",
        ALLOWED_VAR: "allowed-value",
        BLOCKED_VAR: "blocked-value"
      },
      config: {
        command: process.execPath,
        envAllow: ["ALLOWED_VAR"],
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            `const result = ${VALID_RESULT_JSON};`,
            'result.summary = `PATH=${process.env.PATH ?? ""}|ALLOWED=${process.env.ALLOWED_VAR ?? ""}|BLOCKED=${process.env.BLOCKED_VAR ?? ""}`;',
            'fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, JSON.stringify(result));'
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toBe("PATH=|ALLOWED=allowed-value|BLOCKED=");
  });

  it("inherits PATH when PATH is allowlisted", () => {
    const input = setup({
      env: {
        PATH: "/tmp/allowed-path"
      },
      config: {
        command: process.execPath,
        envAllow: ["PATH"],
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            `const result = ${VALID_RESULT_JSON};`,
            'result.summary = `PATH=${process.env.PATH ?? ""}`;',
            'fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, JSON.stringify(result));'
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toBe("PATH=/tmp/allowed-path");
  });
});

describe("runLiveStepWrapper — cwd resolution", () => {
  it("runs in the iteration artifact directory when cwd is 'iteration'", () => {
    const input = setup({
      config: {
        cwd: "iteration",
        args: ["-c", ["pwd", WRITE_VALID_RESULT].join("\n")]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.cwd).toBe(input.iterationDir);
    expect(readLog(input)).toContain(input.iterationDir);
  });

  it("runs in the repo root when cwd is 'repo'", () => {
    const input = setup({
      config: {
        cwd: "repo",
        args: ["-c", ["pwd", WRITE_VALID_RESULT].join("\n")]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.cwd).toBe(input.repoPath);
    expect(readLog(input)).toContain(input.repoPath);
  });

  it("rejects a direct-caller relative iterationDir before spawning", () => {
    const relativeIterationDir = path.relative(
      process.cwd(),
      makeTempDir("momentum-live-step-relative-iter-")
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned"
    );
    const input = setup({
      iterationDir: relativeIterationDir,
      config: {
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("iterationDir");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("rejects a direct-caller relative repoPath before spawning", () => {
    const relativeRepoPath = path.relative(
      process.cwd(),
      makeTempDir("momentum-live-step-relative-repo-")
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned"
    );
    const input = setup({
      repoPath: relativeRepoPath,
      config: {
        cwd: "repo",
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("repoPath");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("rejects a direct-caller relative executorLogPath before creating it", () => {
    const logDir = makeTempDir("momentum-live-step-relative-log-");
    const relativeLogPath = path.relative(
      process.cwd(),
      path.join(logDir, "executor.log")
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned"
    );
    const input = setup({
      executorLogPath: relativeLogPath,
      config: {
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("executorLogPath");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(path.resolve(relativeLogPath))).toBe(false);
  });
});

describe("runLiveStepWrapper — command failure mapping", () => {
  it("returns command_failed on a non-zero exit", () => {
    const input = setup({ config: { args: ["-c", "exit 42"] } });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    expect(out.error).toContain("42");
    expect(readLog(input)).toContain("[live-step] exit_code: 42");
  });

  it("returns command_timed_out when the command exceeds timeout_sec", () => {
    const input = setup({
      config: { timeoutSec: 1, args: ["-c", "sleep 5"] }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(out.error).toContain("1s");
    const log = readLog(input);
    expect(log).toContain("[live-step] result: timed_out");
    expect(log).toContain(
      "[live-step] summary: command timed out after 1s"
    );
  });

  it("enforces command timeout even when the process ignores SIGTERM", () => {
    const input = setup({
      config: { timeoutSec: 1, args: ["-c", 'trap "" TERM; sleep 3'] }
    });

    const start = Date.now();
    const out = runLiveStepWrapper(input);
    const durationMs = Date.now() - start;

    expect(durationMs).toBeLessThan(2_500);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(readLog(input)).toContain("[live-step] result: timed_out");
  });

  it("kills descendant processes when a command times out", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "descendant-survived"
    );
    const input = setup({
      config: {
        timeoutSec: 1,
        args: [
          "-c",
          `(sleep 2; printf survived > ${JSON.stringify(markerPath)}) & sleep 5`
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("kills background descendants when a command exits normally", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "descendant-survived"
    );
    const input = setup({
      config: {
        args: [
          "-c",
          [
            `(sleep 1; printf survived > ${JSON.stringify(markerPath)}) >/dev/null 2>&1 &`,
            WRITE_VALID_RESULT
          ].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);

    expect(out.ok).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("rejects a direct-caller non-positive command timeout before spawning", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned"
    );
    const input = setup({
      config: {
        timeoutSec: 0,
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("timeout_sec");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("returns output_overflow when stdout/stderr exceed the configured byte cap", () => {
    const input = setup({
      outputMaxBytes: 64,
      config: {
        args: [
          "-c",
          'i=0; while [ "$i" -lt 200 ]; do echo 0123456789; i=$((i + 1)); done'
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("output_overflow");
    expect(readLog(input)).toContain("[live-step] output_overflow");
  });
});

describe("runLiveStepWrapper — runtime availability", () => {
  it("rejects a direct-caller relative command without resolving it through PATH", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned"
    );
    const input = setup({
      config: {
        command: "sh",
        args: [
          "-c",
          `touch ${JSON.stringify(markerPath)}; ${WRITE_VALID_RESULT}`
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("returns runtime_unavailable for a missing absolute command without spawning", () => {
    const input = setup({
      config: {
        command: "/does/not/exist/live-step-binary",
        args: [],
        resultFile: "result.json"
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    // Missing runtime must never run the step or produce a result file.
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false
    );
    expect(readLog(input)).toContain("[live-step] runtime_unavailable");
  });

  it("returns runtime_unavailable when the command cannot be executed (EACCES)", () => {
    if (process.platform === "win32") return;
    const iterationDir = makeTempDir("momentum-live-step-iter-");
    const commandPath = path.join(iterationDir, "not-executable.sh");
    fs.writeFileSync(commandPath, "#!/bin/sh\necho should-not-run\n", "utf-8");
    fs.chmodSync(commandPath, 0o644);
    const input = setup({
      iterationDir,
      config: { command: commandPath, args: [] }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("EACCES");
  });
});

describe("runLiveStepWrapper — result file capture", () => {
  it("allows an in-directory result filename that starts with two dots", () => {
    const input = setup({
      config: {
        resultFile: "..result.json",
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resultJsonPath).toBe(
      path.join(input.iterationDir, "..result.json")
    );
  });

  it("rejects a direct-caller result path that escapes the iteration directory before spawning", () => {
    const base = makeTempDir("momentum-live-step-result-base-");
    const iterationDir = path.join(base, "iteration");
    fs.mkdirSync(iterationDir);
    const escapedResult = path.join(base, "escape.json");
    const markerPath = path.join(base, "spawned.marker");
    fs.writeFileSync(escapedResult, "sentinel", "utf-8");
    const input = setup({
      iterationDir,
      config: {
        resultFile: "../escape.json",
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("result_file");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(escapedResult, "utf-8")).toBe("sentinel");
  });

  it("rejects a result path that escapes through a symlinked parent before spawning", () => {
    const base = makeTempDir("momentum-live-step-result-symlink-");
    const iterationDir = path.join(base, "iteration");
    const outsideDir = path.join(base, "outside");
    const markerPath = path.join(base, "spawned.marker");
    fs.mkdirSync(iterationDir);
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(iterationDir, "linked"), "dir");
    const escapedResult = path.join(outsideDir, "result.json");
    fs.writeFileSync(escapedResult, "sentinel", "utf-8");
    const input = setup({
      iterationDir,
      config: {
        resultFile: "linked/result.json",
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join("\n")
        ]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("result_file");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(escapedResult, "utf-8")).toBe("sentinel");
  });

  it("does not reuse a stale result file when the command exits 0 without writing a new one", () => {
    const input = setup({ config: { args: ["-c", "echo no-new-result"] } });
    const resultPath = path.join(input.iterationDir, "result.json");
    fs.writeFileSync(resultPath, VALID_RESULT_JSON, "utf-8");

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_missing");
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("returns result_missing when the command exits 0 but writes no result file", () => {
    const input = setup({ config: { args: ["-c", "echo no-result"] } });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_missing");
    expect(readLog(input)).toContain("[live-step] result_missing");
  });

  it("returns result_invalid when the result file is not valid JSON", () => {
    const input = setup({
      config: { args: ["-c", `printf 'not json' > "$MOMENTUM_RESULT_PATH"`] }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
  });

  it("returns result_invalid when the result JSON does not match the runner result shape", () => {
    const input = setup({
      config: {
        args: ["-c", `printf '%s' '{"foo":1}' > "$MOMENTUM_RESULT_PATH"`]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
  });

  it("returns result_invalid without reading a result file larger than the result cap", () => {
    const input = setup({
      config: {
        args: [
          "-c",
          `dd if=/dev/zero bs=${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES + 1} count=1 of="$MOMENTUM_RESULT_PATH" 2>/dev/null`
        ]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("exceeds");
    expect(readLog(input)).toContain("[live-step] result_too_large");
  });
});

describe("runLiveStepWrapper — pre-flight probe", () => {
  it("rejects a direct-caller relative probe command without resolving it through PATH", () => {
    const input = setup({
      config: {
        probe: { command: "sh", args: ["-c", "exit 0"], timeoutSec: 5 },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false
    );
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("runs the main command when the probe exits 0", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "exit 0"], timeoutSec: 5 },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.probed).toBe(true);
    const log = readLog(input);
    expect(log).toContain("[live-step] probe ok");
    expect(log).toContain("[live-step] done");
  });

  it("maps a missing probe runtime to runtime_unavailable without running the command", () => {
    const input = setup({
      config: {
        probe: {
          command: "/does/not/exist/probe-binary",
          args: [],
          timeoutSec: 5
        },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false
    );
    // The main command must not run after a failed probe.
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("maps a non-zero probe exit to auth_unavailable without running the command", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "exit 7"], timeoutSec: 5 },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("auth_unavailable");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false
    );
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("maps probe output overflow to output_overflow", () => {
    const input = setup({
      outputMaxBytes: 64,
      config: {
        probe: {
          command: "/bin/sh",
          args: [
            "-c",
            'i=0; while [ "$i" -lt 200 ]; do echo 0123456789; i=$((i + 1)); done'
          ],
          timeoutSec: 5
        },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("output_overflow");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false
    );
    const log = readLog(input);
    expect(log).toContain("[live-step] probe output_overflow");
    expect(log).not.toContain("[live-step] command:");
  });

  it("maps a probe timeout to runtime_unavailable", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "sleep 5"], timeoutSec: 1 },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
  });

  it("rejects a direct-caller non-positive probe timeout before probing", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "probed"
    );
    const input = setup({
      config: {
        probe: {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(markerPath)}`],
          timeoutSec: 0
        },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("probe.timeout_sec");
    expect(fs.existsSync(markerPath)).toBe(false);
    const log = readLog(input);
    expect(log).not.toContain("[live-step] probe start");
    expect(log).not.toContain("[live-step] command:");
  });

  it("enforces probe timeout even when the process ignores SIGTERM", () => {
    const input = setup({
      config: {
        probe: {
          command: "/bin/sh",
          args: ["-c", 'trap "" TERM; sleep 3'],
          timeoutSec: 1
        },
        args: ["-c", WRITE_VALID_RESULT]
      }
    });

    const start = Date.now();
    const out = runLiveStepWrapper(input);
    const durationMs = Date.now() - start;

    expect(durationMs).toBeLessThan(2_500);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    const log = readLog(input);
    expect(log).toContain("[live-step] probe result: timed_out after 1s");
    expect(log).not.toContain("[live-step] command:");
  });
});

describe("LIVE_STEP_WRAPPER_RECOVERY_CODES", () => {
  it("pins the stable live-wrapper execution recovery vocabulary", () => {
    expect([...LIVE_STEP_WRAPPER_RECOVERY_CODES]).toEqual([
      "runtime_unavailable",
      "auth_unavailable",
      "command_failed",
      "command_timed_out",
      "output_overflow",
      "result_missing",
      "result_invalid"
    ]);
  });

  it("defaults the output cap to 256 MiB", () => {
    expect(LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});
