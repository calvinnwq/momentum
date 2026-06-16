import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ACP_ENV_VARS, runAcpRunner } from "../src/adapters/acp-runner.js";
import type { GoalSpec } from "../src/core/goal/types.js";
import type { RunnerAdapterInput } from "../src/adapters/runner-adapter.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-acp-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "ACP fixture ran.",
  key_changes_made: ["Edited fixture.txt"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "acp smoke",
    body: "",
    breaking: false
  }
});

const RUNNER_FAILURE_JSON = JSON.stringify({
  success: false,
  summary: "ACP runtime reported failure.",
  key_changes_made: [],
  key_learnings: [],
  remaining_work: ["fix authentication wiring"],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "acp smoke",
    body: "",
    breaking: false
  }
});

type SetupOpts = {
  acp?: unknown;
  iterationDir?: string;
  repoPath?: string;
  baseHead?: string;
  env?: NodeJS.ProcessEnv;
};

function setup(opts: SetupOpts = {}): RunnerAdapterInput {
  const iterationDir = opts.iterationDir ?? makeTempDir("momentum-acp-iter-");
  const repoPath = opts.repoPath ?? makeTempDir("momentum-acp-repo-");
  const spec: GoalSpec = {
    title: "ACP smoke probe",
    repo: repoPath,
    runner: "acp",
    branch: "momentum/acp-smoke",
    max_iterations: 1,
    verification: ["true"],
    verification_timeout_sec: 900,
    body: "",
    ...(opts.acp !== undefined ? { acp: opts.acp } : {})
  };
  const promptPath = path.join(iterationDir, "prompt.md");
  fs.writeFileSync(promptPath, "# fixture prompt\n", "utf-8");

  const input: RunnerAdapterInput = {
    goalId: "11111111-1111-2222-3333-444455556666",
    iteration: 1,
    repoPath,
    baseHead: "0".repeat(40),
    branch: spec.branch,
    promptPath,
    iterationDir,
    resultJsonPath: path.join(iterationDir, "result.json"),
    runnerLogPath: path.join(iterationDir, "runner.log"),
    spec,
    ...(opts.baseHead !== undefined ? { baseHead: opts.baseHead } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {})
  };
  return input;
}

function shellScript(body: string): { command: string; args: string[] } {
  return { command: "/bin/sh", args: ["-c", body] };
}

describe("runAcpRunner — config validation", () => {
  it("returns invalid_input when acp block is missing", () => {
    const input = setup();
    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("acp");
  });

  it("returns invalid_input when acp block is malformed", () => {
    const input = setup({ acp: { args: ["run"] } });
    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("command");
  });
});

describe("runAcpRunner — runtime availability detection", () => {
  it("returns runtime_unavailable (distinct from command_failed) when the configured absolute runtime binary is missing", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const input = setup({
      iterationDir,
      acp: {
        command: "/does/not/exist/momentum-acp-binary",
        args: ["run"]
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.code).not.toBe("command_failed");
    expect(out.error).toContain("not installed");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] runtime_unavailable");
    expect(log).toContain("[acp] summary: runtime not available");
    expect(log).not.toContain("[acp] command:");
  });

  it("returns runtime_unavailable when the probe binary is missing (auth/runtime missing)", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const input = setup({
      iterationDir,
      acp: {
        command: "/bin/sh",
        args: ["-c", "true"],
        probe: { command: "/does/not/exist/probe-binary" }
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] probe runtime_unavailable");
  });

  it("returns runtime_unavailable (distinct from command_failed) when the probe exits non-zero", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const successScript = [
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      acp: {
        ...shellScript(successScript),
        probe: {
          command: "/bin/sh",
          args: ["-c", "echo 'auth not configured' >&2; exit 2"]
        }
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runtime_unavailable");
    expect(out.code).not.toBe("command_failed");
    expect(out.error).toContain("probe");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] probe exit_code: 2");
    expect(log).toContain("auth not configured");
    expect(log).toContain("[acp] probe result: nonzero_exit");
    // Main command must not have been spawned after the probe failed.
    expect(log).not.toContain("[acp] command:");
    expect(fs.existsSync(resultPath)).toBe(false);
  });
});

describe("runAcpRunner — successful normalized result", () => {
  it("returns ok with a normalized RunnerResult when the runtime writes a valid result.json", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const script = [
      "echo acp-stdout",
      "echo acp-stderr >&2",
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      acp: { ...shellScript(script), timeout_sec: 30 }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("ACP fixture ran.");
    expect(out.result.commit.subject).toBe("acp smoke");
    expect(out.resultJsonPath).toBe(resultPath);

    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] start");
    expect(log).toContain("[acp] command: /bin/sh -c");
    expect(log).toContain("[acp] stdout:");
    expect(log).toContain("acp-stdout");
    expect(log).toContain("[acp] stderr:");
    expect(log).toContain("acp-stderr");
    expect(log).toContain("[acp] exit_code: 0");
    expect(log).toContain("[acp] runner_success: true");
    expect(log).toContain("[acp] done");
  });

  it("runs the probe before the main command when both are configured", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const orderFile = path.join(iterationDir, "order.txt");
    const probeScript = `echo probe-ran > "${orderFile}"`;
    const mainScript = [
      `echo main-ran >> "${orderFile}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      acp: {
        ...shellScript(mainScript),
        probe: { command: "/bin/sh", args: ["-c", probeScript] }
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(orderFile, "utf-8")).toBe(
      "probe-ran\nmain-ran\n"
    );
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log.indexOf("[acp] probe start")).toBeLessThan(
      log.indexOf("[acp] command:")
    );
  });

  it("passes Momentum context to the child via MOMENTUM_* env vars", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const envDump = path.join(iterationDir, "env.txt");
    const script = [
      `: > "${envDump}"`,
      `printf 'GOAL_ID=%s\\n' "$MOMENTUM_GOAL_ID" >> "${envDump}"`,
      `printf 'ITERATION=%s\\n' "$MOMENTUM_ITERATION" >> "${envDump}"`,
      `printf 'RESULT=%s\\n' "$MOMENTUM_RESULT_PATH" >> "${envDump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      acp: shellScript(script)
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(true);
    const dump = fs.readFileSync(envDump, "utf-8");
    expect(dump).toContain(`GOAL_ID=${input.goalId}`);
    expect(dump).toContain(`ITERATION=${input.iteration}`);
    expect(dump).toContain(`RESULT=${input.resultJsonPath}`);
  });

  it("does not inherit parent env variables without env_allow but keeps PATH", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const dump = path.join(iterationDir, "env.txt");
    const script = [
      `printf 'SECRET=%s\\n' "$SECRET_TOKEN" > "${dump}"`,
      `printf 'PATH_SET=%s\\n' "$([ -n "$PATH" ] && echo yes || echo no)" >> "${dump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      env: { SECRET_TOKEN: "do-not-forward", PATH: process.env["PATH"] ?? "" },
      acp: shellScript(script)
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(true);
    const text = fs.readFileSync(dump, "utf-8");
    expect(text).toContain("SECRET=\n");
    expect(text).toContain("PATH_SET=yes");
  });
});

describe("runAcpRunner — runner-reported failure (distinct from runtime/command failures)", () => {
  it("returns ok with success=false when the runtime ran and the result.json reports failure", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const script = [
      `cat <<'JSON' > "${resultPath}"`,
      RUNNER_FAILURE_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      acp: shellScript(script)
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(false);
    expect(out.result.summary).toBe("ACP runtime reported failure.");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] runner_success: false");
  });
});

describe("runAcpRunner — startup failure (distinct from runtime_unavailable and command_failed)", () => {
  it("returns startup_failed for non-ENOENT spawn errors on the main command", () => {
    if (process.platform === "win32") return;
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const commandPath = path.join(iterationDir, "not-executable.sh");
    fs.writeFileSync(commandPath, "#!/bin/sh\necho should-not-run\n", "utf-8");
    fs.chmodSync(commandPath, 0o644);
    const input = setup({
      iterationDir,
      acp: { command: commandPath, args: [] }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("startup_failed");
    expect(out.code).not.toBe("runtime_unavailable");
    expect(out.code).not.toBe("command_failed");
    expect(out.error).toContain("EACCES");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] spawn_error:");
    expect(log).toContain("[acp] summary: startup failed");
    expect(log).not.toContain("[acp] result: nonzero_exit");
  });

  it("returns startup_failed when the probe binary exists but cannot execute (non-ENOENT spawn error)", () => {
    if (process.platform === "win32") return;
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const probePath = path.join(iterationDir, "probe.sh");
    fs.writeFileSync(probePath, "#!/bin/sh\necho probed\n", "utf-8");
    fs.chmodSync(probePath, 0o644);
    const input = setup({
      iterationDir,
      acp: {
        command: "/bin/sh",
        args: ["-c", "true"],
        probe: { command: probePath, args: [] }
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("startup_failed");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] probe spawn_error:");
  });
});

describe("runAcpRunner — main command failure paths (distinct from runtime_unavailable)", () => {
  it("returns command_failed (not runtime_unavailable) when the runtime ran and exited non-zero", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const input = setup({
      iterationDir,
      acp: shellScript("echo bye-stderr >&2; exit 42")
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    expect(out.code).not.toBe("runtime_unavailable");
    expect(out.error).toContain("42");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] exit_code: 42");
    expect(log).toContain("bye-stderr");
    expect(log).toContain("[acp] result: nonzero_exit");
  });

  it("returns command_timed_out when the command exceeds timeout_sec", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const input = setup({
      iterationDir,
      acp: {
        ...shellScript("sleep 5"),
        timeout_sec: 1
      }
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(out.error).toContain("1s");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] result: timed_out");
  });

  it("returns result_missing when the command exits 0 but never writes result.json", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const input = setup({
      iterationDir,
      acp: shellScript("echo no-result")
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_missing");
    expect(out.error).toContain("result file");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[acp] result_missing:");
  });

  it("returns result_invalid when the result file contains malformed JSON", () => {
    const iterationDir = makeTempDir("momentum-acp-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const input = setup({
      iterationDir,
      acp: shellScript(`printf 'not json' > "${resultPath}"`)
    });

    const out = runAcpRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("invalid");
  });
});

describe("ACP_ENV_VARS", () => {
  it("exposes a stable MOMENTUM_* contract", () => {
    expect(ACP_ENV_VARS).toEqual({
      GOAL_ID: "MOMENTUM_GOAL_ID",
      ITERATION: "MOMENTUM_ITERATION",
      REPO_PATH: "MOMENTUM_REPO_PATH",
      BASE_HEAD: "MOMENTUM_BASE_HEAD",
      BRANCH: "MOMENTUM_BRANCH",
      PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
      ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
      RESULT_PATH: "MOMENTUM_RESULT_PATH"
    });
  });
});
