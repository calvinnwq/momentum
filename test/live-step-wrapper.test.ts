import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sigtermImmuneSleep, waitMs } from "./helpers/process-kill-harness.js";
import {
  LIVE_STEP_WRAPPER_RESULT_MAX_BYTES,
  runProcessGroup,
  runProcessGroupSync,
  runLiveStepWrapper,
  runLiveStepWrapperAsync,
  type LiveStepWrapperInput,
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

// A full, valid RunnerResult document. parseRunnerResult requires success,
// summary, key_changes_made, goal_complete, and a valid commit intent.
const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "live implementation step succeeded",
  key_changes_made: ["implemented the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: { type: "chore", subject: "do the thing", body: "", breaking: false },
});

// Shell fragment that writes the valid result document to the injected
// MOMENTUM_RESULT_PATH. JSON contains only double quotes, so single-quoting it
// in the shell command is safe.
const WRITE_VALID_RESULT = `printf '%s' '${VALID_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

function makeConfig(
  overrides: Partial<LiveWrapperConfig> = {},
): LiveWrapperConfig {
  return {
    command: "/bin/sh",
    args: [],
    cwd: "iteration",
    timeoutSec: 30,
    envAllow: [],
    resultFile: "result.json",
    probe: undefined,
    ...overrides,
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
  const repoPath =
    overrides.repoPath ?? makeTempDir("momentum-live-step-repo-");
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
      : {}),
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
            WRITE_VALID_RESULT,
          ].join("\n"),
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("live implementation step succeeded");
    expect(out.resultJsonPath).toBe(
      path.join(input.iterationDir, "result.json"),
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
            WRITE_VALID_RESULT,
          ].join("\n"),
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);

    const log = readLog(input);
    expect(log).toContain(
      "RUN=wfrun-deadbeef|STEP=implementation-step|KIND=implementation|ATTEMPT=1",
    );
  });

  it("classifies a missing Node wrapper module as runtime unavailable before retry", () => {
    const repoPath = makeTempDir("momentum-live-step-repo-");
    const input = setup({
      repoPath,
      env: { PATH: process.env.PATH },
      config: {
        command: "/usr/bin/env",
        args: ["node", "dist/adapters/missing-wrapper.js"],
        cwd: "repo",
        envAllow: ["PATH"],
      },
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("wrapper bootstrap failed");
    const log = readLog(input);
    expect(log).toContain("MODULE_NOT_FOUND");
    expect(log).toContain("[live-step] recovery: runtime_unavailable");
  });

  it("keeps dependency MODULE_NOT_FOUND failures as command_failed", () => {
    const repoPath = makeTempDir("momentum-live-step-repo-");
    const scriptPath = path.join(repoPath, "dist", "adapters", "wrapper.js");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(
      scriptPath,
      "require('missing-project-dependency');\n",
      "utf8",
    );
    const input = setup({
      repoPath,
      env: { PATH: process.env.PATH },
      config: {
        command: "/usr/bin/env",
        args: ["node", "dist/adapters/wrapper.js"],
        cwd: "repo",
        envAllow: ["PATH"],
      },
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    expect(out.error).toContain("command exited with code");
    const log = readLog(input);
    expect(log).toContain("missing-project-dependency");
    expect(log).not.toContain("[live-step] recovery: runtime_unavailable");
  });
});

describe("runLiveStepWrapper — env allowlist", () => {
  it("passes only allowlisted env keys plus MOMENTUM_* context", () => {
    const input = setup({
      env: {
        PATH: process.env.PATH,
        ALLOWED_VAR: "allowed-value",
        BLOCKED_VAR: "blocked-value",
      },
      config: {
        envAllow: ["ALLOWED_VAR"],
        args: [
          "-c",
          [
            'echo "ALLOWED=$ALLOWED_VAR|BLOCKED=$BLOCKED_VAR"',
            WRITE_VALID_RESULT,
          ].join("\n"),
        ],
      },
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
        BLOCKED_VAR: "blocked-value",
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
            "fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, JSON.stringify(result));",
          ].join("\n"),
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toBe("PATH=|ALLOWED=allowed-value|BLOCKED=");
  });

  it("inherits PATH when PATH is allowlisted", () => {
    const input = setup({
      env: {
        PATH: "/tmp/allowed-path",
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
            "fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, JSON.stringify(result));",
          ].join("\n"),
        ],
      },
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
        args: ["-c", ["pwd", WRITE_VALID_RESULT].join("\n")],
      },
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
        args: ["-c", ["pwd", WRITE_VALID_RESULT].join("\n")],
      },
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
      makeTempDir("momentum-live-step-relative-iter-"),
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned",
    );
    const input = setup({
      iterationDir: relativeIterationDir,
      config: {
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
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
      makeTempDir("momentum-live-step-relative-repo-"),
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned",
    );
    const input = setup({
      repoPath: relativeRepoPath,
      config: {
        cwd: "repo",
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
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
      path.join(logDir, "executor.log"),
    );
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned",
    );
    const input = setup({
      executorLogPath: relativeLogPath,
      config: {
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
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

  it("maps the coding workflow recovery marker to runtime_unavailable", () => {
    const input = setup({
      config: {
        args: [
          "-c",
          [
            "printf '%s\\n' 'MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable' >&2",
            "printf '%s\\n' 'no-mistakes could not start for this branch' >&2",
            "exit 1",
          ].join("\n"),
          "coding-workflow-live-wrapper-cli.ts",
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("retryable setup failure");
    const log = readLog(input);
    expect(log).toContain("MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable");
    expect(log).toContain("[live-step] recovery: runtime_unavailable");
  });

  it("does not let a generic live command spoof the coding wrapper recovery marker", () => {
    const input = setup({
      config: {
        args: [
          "-c",
          [
            "printf '%s\\n' 'MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable' >&2",
            "exit 1",
          ].join("\n"),
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    const log = readLog(input);
    expect(log).toContain("MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable");
    expect(log).not.toContain("[live-step] recovery: runtime_unavailable");
  });

  it("returns command_timed_out when the command exceeds timeout_sec", () => {
    const input = setup({
      config: { timeoutSec: 1, args: ["-c", "sleep 5"] },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(out.error).toContain("1s");
    const log = readLog(input);
    expect(log).toContain("[live-step] result: timed_out");
    expect(log).toContain("[live-step] summary: command timed out after 1s");
  });

  it("enforces command timeout even when the process ignores SIGTERM", () => {
    const input = setup({
      config: { timeoutSec: 1, args: ["-c", sigtermImmuneSleep(3)] },
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
      "descendant-survived",
    );
    const input = setup({
      config: {
        timeoutSec: 1,
        args: [
          "-c",
          `(sleep 2; printf survived > ${JSON.stringify(markerPath)}) & sleep 5`,
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    waitMs(2_500);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("kills background descendants when a command exits normally", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "descendant-survived",
    );
    const input = setup({
      config: {
        args: [
          "-c",
          [
            `(sleep 1; printf survived > ${JSON.stringify(markerPath)}) >/dev/null 2>&1 &`,
            WRITE_VALID_RESULT,
          ].join("\n"),
        ],
      },
    });

    const out = runLiveStepWrapper(input);
    waitMs(1_500);

    expect(out.ok).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "kills token-owned descendants that create a new process group synchronously",
    () => {
      const markerPath = path.join(
        makeTempDir("momentum-live-step-marker-"),
        "sync-detached-descendant-survived",
      );
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "survived"), 1000)`;
      const parent = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: "ignore" }).unref()`,
      ].join(";");

      const out = runProcessGroupSync(process.execPath, ["-e", parent], {
        cwd: path.dirname(markerPath),
        env: process.env,
        timeoutMs: 5_000,
        maxBuffer: 1_024,
      });
      waitMs(1_200);

      expect(out.status).toBe(0);
      expect(out.error).toBeUndefined();
      expect(fs.existsSync(markerPath)).toBe(false);
    },
    10_000,
  );

  it("kills background descendants when an async process leader exits normally", async () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "async-descendant-survived",
    );
    const out = await runProcessGroup(
      "/bin/sh",
      ["-c", `(sleep 5; printf survived > ${JSON.stringify(markerPath)}) &`],
      {
        cwd: path.dirname(markerPath),
        env: {},
        timeoutMs: 500,
        maxBuffer: 1024,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5_500));

    expect(out.status).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "kills token-owned commands when the process anchor exits unexpectedly",
    async () => {
      const root = makeTempDir("momentum-live-step-dead-anchor-");
      const markerPath = path.join(root, "command-survived");
      const program = [
        'process.stdout.write("before-anchor-exit\\n")',
        'process.stderr.write("anchor-exit-diagnostic\\n")',
        'process.kill(process.ppid, "SIGKILL")',
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "survived"), 1_000)`,
      ].join(";");
      let failure: unknown;

      try {
        await runProcessGroup(process.execPath, ["-e", program], {
          cwd: root,
          env: process.env,
          timeoutMs: 5_000,
          maxBuffer: 1_024,
        });
      } catch (error) {
        failure = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(failure).toMatchObject({
        code: "SUPERVISOR_FAILED",
        stdout: "before-anchor-exit\n",
        stderr: "anchor-exit-diagnostic\n",
      });
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills commands that clear their token before the process anchor exits",
    async () => {
      const root = makeTempDir("momentum-live-step-cleared-token-");
      const markerPath = path.join(root, "command-survived");
      const program = [
        "delete process.env.MOMENTUM_PROCESS_TREE_TOKEN",
        'process.kill(process.ppid, "SIGKILL")',
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "survived"), 1_000)`,
      ].join(";");

      await expect(
        runProcessGroup(process.execPath, ["-e", program], {
          cwd: root,
          env: process.env,
          timeoutMs: 5_000,
          maxBuffer: 1_024,
        }),
      ).rejects.toMatchObject({ code: "SUPERVISOR_FAILED" });
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(fs.existsSync(markerPath)).toBe(false);
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "persists captured output when async wrapper supervision fails",
    async () => {
      const input = setup({
        config: {
          command: process.execPath,
          args: [
            "-e",
            [
              'process.stdout.write("supervisor-stdout\\n")',
              'process.stderr.write("supervisor-stderr\\n")',
              'process.kill(process.ppid, "SIGKILL")',
              "setTimeout(() => {}, 5_000)",
            ].join(";"),
          ],
        },
      });

      await expect(
        runLiveStepWrapperAsync(input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "SUPERVISOR_FAILED" });

      expect(readLog(input)).toContain(
        "[live-step] stdout:\nsupervisor-stdout",
      );
      expect(readLog(input)).toContain(
        "[live-step] stderr:\nsupervisor-stderr",
      );
    },
    10_000,
  );

  it("returns the command spawn error when no process tree was launched", async () => {
    const root = makeTempDir("momentum-live-step-missing-command-");

    const out = await runProcessGroup(path.join(root, "missing-command"), [], {
      cwd: root,
      env: process.env,
      timeoutMs: 1_000,
      maxBuffer: 1024,
    });

    expect((out.error as NodeJS.ErrnoException | undefined)?.code).toBe(
      "ENOENT",
    );
  });

  it("preserves multibyte UTF-8 split across async pipe chunks", async () => {
    const root = makeTempDir("momentum-live-step-utf8-");
    const program = [
      "process.stdout.write(Buffer.from([0xe2]))",
      "process.stderr.write(Buffer.from([0xf0]))",
      "setTimeout(() => {",
      "  process.stdout.write(Buffer.from([0x82, 0xac]))",
      "  process.stderr.write(Buffer.from([0x9f, 0x98, 0x80]))",
      "}, 40)",
    ].join(";");

    const out = await runProcessGroup(process.execPath, ["-e", program], {
      cwd: root,
      env: process.env,
      timeoutMs: 2_000,
      maxBuffer: 1024,
    });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe("€");
    expect(out.stderr).toBe("😀");
  });

  it.skipIf(process.platform === "win32")(
    "samples POSIX ancestry without continuously scanning ownership",
    async () => {
      const root = makeTempDir("momentum-live-step-ps-count-");
      const countPath = path.join(root, "count");
      const shimDir = path.join(root, "bin");
      const shimPath = path.join(shimDir, "ps");
      const realPs = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
      fs.mkdirSync(shimDir);
      fs.writeFileSync(
        shimPath,
        [
          "#!/bin/sh",
          `printf x >> ${JSON.stringify(countPath)}`,
          `exec ${JSON.stringify(realPs)} "$@"`,
        ].join("\n"),
      );
      fs.chmodSync(shimPath, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;

      try {
        const out = await runProcessGroup(
          process.execPath,
          ["-e", "setTimeout(() => {}, 650)"],
          {
            cwd: root,
            env: process.env,
            timeoutMs: 2_000,
            maxBuffer: 1024,
          },
        );
        expect(out.status).toBe(0);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }

      const scanCount = fs.existsSync(countPath)
        ? fs.readFileSync(countPath, "utf-8").length
        : 0;
      expect(scanCount).toBeGreaterThan(0);
      expect(scanCount).toBeLessThan(10);
    },
  );

  it("tracks and kills a descendant that creates a new POSIX session", async () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "setsid-descendant-survived",
    );
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "survived"), 1500)`;
    const parent = [
      'const { spawn } = require("node:child_process")',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: "ignore" }).unref()`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    const out = await runProcessGroup(process.execPath, ["-e", parent], {
      cwd: path.dirname(markerPath),
      env: process.env,
      timeoutMs: 5_000,
      maxBuffer: 1024,
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect((out.error as NodeJS.ErrnoException | undefined)?.code).toBe(
      "ABORT_ERR",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "accepts verified fallback cleanup when the process anchor is unresponsive",
    async () => {
      const root = makeTempDir("momentum-live-step-fallback-");
      const readyPath = path.join(root, "anchor-stopped");
      const program = [
        'const fs = require("node:fs")',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready")`,
        'process.kill(process.ppid, "SIGSTOP")',
        "setTimeout(() => {}, 10_000)",
      ].join(";");
      const abort = new AbortController();
      const running = runProcessGroup(process.execPath, ["-e", program], {
        cwd: root,
        env: process.env,
        timeoutMs: 10_000,
        maxBuffer: 1_024,
        signal: abort.signal,
      });
      const readyDeadline = Date.now() + 3_000;
      while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(readyPath)).toBe(true);

      abort.abort();

      const out = await running;
      expect((out.error as NodeJS.ErrnoException | undefined)?.code).toBe(
        "ABORT_ERR",
      );
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when an unresponsive anchor leaves a tokenless same-group descendant",
    async () => {
      const root = makeTempDir("momentum-live-step-same-group-");
      const pidPath = path.join(root, "descendant.pid");
      const descendant = "setTimeout(() => {}, 15_000)";
      const program = [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", env: {} })`,
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
        "child.unref()",
        'process.kill(process.ppid, "SIGSTOP")',
        "setTimeout(() => {}, 15_000)",
      ].join(";");
      const abort = new AbortController();
      const running = runProcessGroup(process.execPath, ["-e", program], {
        cwd: root,
        env: process.env,
        timeoutMs: 10_000,
        maxBuffer: 1_024,
        signal: abort.signal,
      });
      const readyDeadline = Date.now() + 3_000;
      while (!fs.existsSync(pidPath) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(pidPath)).toBe(true);
      const descendantPid = Number(fs.readFileSync(pidPath, "utf-8"));

      try {
        abort.abort();
        await expect(running).rejects.toMatchObject({
          code: "SUPERVISOR_FAILED",
        });
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fail-closed descendant may already have exited.
        }
      }
    },
    12_000,
  );

  it.skipIf(process.platform === "win32")(
    "fails closed synchronously when cleanup leaves a tokenless same-group descendant",
    () => {
      const root = makeTempDir("momentum-live-step-sync-same-group-");
      const pidPath = path.join(root, "descendant.pid");
      const descendant = "setTimeout(() => {}, 15_000)";
      const program = [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", env: {} })`,
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
        "child.unref()",
        'process.kill(process.ppid, "SIGSTOP")',
        "setTimeout(() => {}, 15_000)",
      ].join(";");

      const out = runProcessGroupSync(process.execPath, ["-e", program], {
        cwd: root,
        env: process.env,
        timeoutMs: 500,
        maxBuffer: 1_024,
      });
      expect(fs.existsSync(pidPath)).toBe(true);
      const descendantPid = Number(fs.readFileSync(pidPath, "utf-8"));

      try {
        expect((out.error as NodeJS.ErrnoException | undefined)?.code).toBe(
          "SUPERVISOR_FAILED",
        );
      } finally {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fail-closed descendant may already have exited.
        }
      }
    },
    10_000,
  );

  // The delayed `ps eww` responses below exercise the macOS fallback query
  // path. Linux discovers token-owned processes through /proc instead.
  it.skipIf(process.platform !== "darwin")(
    "allows verified fallback cleanup to use its full cleanup budget",
    async () => {
      const root = makeTempDir("momentum-live-step-fallback-budget-");
      const readyPath = path.join(root, "anchor-stopped");
      const shimDir = path.join(root, "bin");
      const shimPath = path.join(shimDir, "ps");
      const shimCountPath = path.join(root, "ps-count");
      const shimSnapshotPath = path.join(root, "ps-snapshot");
      const realPs = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
      fs.mkdirSync(shimDir);
      fs.writeFileSync(
        shimPath,
        [
          "#!/bin/sh",
          `count_path=${JSON.stringify(shimCountPath)}`,
          `snapshot_path=${JSON.stringify(shimSnapshotPath)}`,
          `real_ps=${JSON.stringify(realPs)}`,
          'case "$*" in',
          '  "-eo pid=,ppid=,pgid=") sleep 1.2 ;;',
          '  "eww -axo pid=,state=,command=")',
          '    count=$(test -f "$count_path" && cat "$count_path" || printf 0)',
          "    count=$((count + 1))",
          '    printf %s "$count" > "$count_path"',
          '    if [ "$count" -eq 1 ]; then',
          "      sleep 1.2",
          '      "$real_ps" "$@" > "$snapshot_path"',
          "      status=$?",
          '      cat "$snapshot_path"',
          "      exit $status",
          '    elif [ "$count" -eq 2 ]; then',
          "      sleep 1.2",
          '      cat "$snapshot_path"',
          "      exit 0",
          "    fi",
          "    ;;",
          "esac",
          'exec "$real_ps" "$@"',
        ].join("\n"),
      );
      fs.chmodSync(shimPath, 0o755);
      const program = [
        'const fs = require("node:fs")',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready")`,
        'process.kill(process.ppid, "SIGSTOP")',
        "setTimeout(() => {}, 10_000)",
      ].join(";");
      const abort = new AbortController();
      const originalPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;

      try {
        const running = runProcessGroup(process.execPath, ["-e", program], {
          cwd: root,
          env: process.env,
          timeoutMs: 10_000,
          maxBuffer: 1_024,
          signal: abort.signal,
        });
        const readyDeadline = Date.now() + 3_000;
        while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fs.existsSync(readyPath)).toBe(true);
        abort.abort();

        const out = await running;
        expect((out.error as NodeJS.ErrnoException | undefined)?.code).toBe(
          "ABORT_ERR",
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
    12_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "accepts verified fallback cleanup after a safe anchor cleanup report",
    async () => {
      const root = makeTempDir("momentum-live-step-exited-anchor-");
      const shimDir = path.join(root, "bin");
      const shimPath = path.join(shimDir, "ps");
      const realPs = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
      fs.mkdirSync(shimDir);
      fs.writeFileSync(
        shimPath,
        [
          "#!/bin/sh",
          'if [ -n "$MOMENTUM_PROCESS_TREE_TOKEN" ] && [ "$1" = eww ]; then',
          "  exit 1",
          "fi",
          `exec ${JSON.stringify(realPs)} "$@"`,
        ].join("\n"),
      );
      fs.chmodSync(shimPath, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;

      try {
        const out = await runProcessGroup(process.execPath, ["-e", ""], {
          cwd: root,
          env: process.env,
          timeoutMs: 10_000,
          maxBuffer: 1_024,
        });

        expect(out.status).toBe(0);
        expect(out.error).toBeUndefined();
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
    10_000,
  );

  it("fails closed when a detached descendant discards its ownership token", async () => {
    const root = makeTempDir("momentum-live-step-unowned-");
    const pidPath = path.join(root, "descendant.pid");
    const descendant = "setTimeout(() => {}, 5000)";
    const parent = [
      'const { spawn } = require("node:child_process")',
      'const fs = require("node:fs")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: "ignore", env: {} })`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
      "child.unref()",
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const abort = new AbortController();
    const running = runProcessGroup(process.execPath, ["-e", parent], {
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      maxBuffer: 1024,
      signal: abort.signal,
    });
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(pidPath)).toBe(true);
    const descendantPid = Number(fs.readFileSync(pidPath, "utf-8"));
    abort.abort();

    await expect(running).rejects.toMatchObject({ code: "SUPERVISOR_FAILED" });
    try {
      process.kill(-descendantPid, "SIGKILL");
    } catch {
      // The fail-closed descendant may already have exited.
    }
  });

  it("rejects a direct-caller non-positive command timeout before spawning", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned",
    );
    const input = setup({
      config: {
        timeoutSec: 0,
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("timeout_sec");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("rejects process options that cannot be supervised safely", async () => {
    const root = makeTempDir("momentum-live-step-options-");
    for (const maxBuffer of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5]) {
      const sync = runProcessGroupSync(process.execPath, ["-e", ""], {
        cwd: root,
        env: process.env,
        timeoutMs: 1_000,
        maxBuffer,
      });
      expect((sync.error as NodeJS.ErrnoException | undefined)?.code).toBe(
        "EINVAL",
      );

      const asyncResult = await runProcessGroup(process.execPath, ["-e", ""], {
        cwd: root,
        env: process.env,
        timeoutMs: 1_000,
        maxBuffer,
      });
      expect(
        (asyncResult.error as NodeJS.ErrnoException | undefined)?.code,
      ).toBe("EINVAL");
    }

    const excessiveTimeout = await runProcessGroup(
      process.execPath,
      ["-e", ""],
      {
        cwd: root,
        env: process.env,
        timeoutMs: 2_147_454_000,
        maxBuffer: 1_024,
      },
    );
    expect(
      (excessiveTimeout.error as NodeJS.ErrnoException | undefined)?.code,
    ).toBe("EINVAL");
  });

  it("rejects direct-caller timeouts above the supervisor timer limit", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "spawned",
    );
    const input = setup({
      config: {
        timeoutSec: 2_147_454,
        args: [
          "-c",
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
    });

    const out = runLiveStepWrapper(input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("must not exceed 2147453 seconds");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("returns output_overflow when stdout/stderr exceed the configured byte cap", () => {
    const input = setup({
      outputMaxBytes: 64,
      config: {
        args: [
          "-c",
          'i=0; while [ "$i" -lt 200 ]; do echo 0123456789; i=$((i + 1)); done',
        ],
      },
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
      "spawned",
    );
    const input = setup({
      config: {
        command: "sh",
        args: [
          "-c",
          `touch ${JSON.stringify(markerPath)}; ${WRITE_VALID_RESULT}`,
        ],
      },
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
        resultFile: "result.json",
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    // Missing runtime must never run the step or produce a result file.
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false,
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
      config: { command: commandPath, args: [] },
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
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resultJsonPath).toBe(
      path.join(input.iterationDir, "..result.json"),
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
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
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
          [`touch ${JSON.stringify(markerPath)}`, WRITE_VALID_RESULT].join(
            "\n",
          ),
        ],
      },
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
      config: { args: ["-c", `printf 'not json' > "$MOMENTUM_RESULT_PATH"`] },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
  });

  it("returns result_invalid when the result JSON does not match the runner result shape", () => {
    const input = setup({
      config: {
        args: ["-c", `printf '%s' '{"foo":1}' > "$MOMENTUM_RESULT_PATH"`],
      },
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
          `dd if=/dev/zero bs=${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES + 1} count=1 of="$MOMENTUM_RESULT_PATH" 2>/dev/null`,
        ],
      },
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
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.error).toContain("absolute");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false,
    );
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("runs the main command when the probe exits 0", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "exit 0"], timeoutSec: 5 },
        args: ["-c", WRITE_VALID_RESULT],
      },
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
          timeoutSec: 5,
        },
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false,
    );
    // The main command must not run after a failed probe.
    expect(readLog(input)).not.toContain("[live-step] command:");
  });

  it("maps a non-zero probe exit to auth_unavailable without running the command", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "exit 7"], timeoutSec: 5 },
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("auth_unavailable");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false,
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
            'i=0; while [ "$i" -lt 200 ]; do echo 0123456789; i=$((i + 1)); done',
          ],
          timeoutSec: 5,
        },
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("output_overflow");
    expect(fs.existsSync(path.join(input.iterationDir, "result.json"))).toBe(
      false,
    );
    const log = readLog(input);
    expect(log).toContain("[live-step] probe output_overflow");
    expect(log).not.toContain("[live-step] command:");
  });

  it("maps a probe timeout to runtime_unavailable", () => {
    const input = setup({
      config: {
        probe: { command: "/bin/sh", args: ["-c", "sleep 5"], timeoutSec: 1 },
        args: ["-c", WRITE_VALID_RESULT],
      },
    });

    const out = runLiveStepWrapper(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
  });

  it("rejects a direct-caller non-positive probe timeout before probing", () => {
    const markerPath = path.join(
      makeTempDir("momentum-live-step-marker-"),
      "probed",
    );
    const input = setup({
      config: {
        probe: {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(markerPath)}`],
          timeoutSec: 0,
        },
        args: ["-c", WRITE_VALID_RESULT],
      },
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
          args: ["-c", sigtermImmuneSleep(3)],
          timeoutSec: 1,
        },
        args: ["-c", WRITE_VALID_RESULT],
      },
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
