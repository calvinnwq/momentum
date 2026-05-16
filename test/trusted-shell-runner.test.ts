import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GoalSpec } from "../src/goal-spec.js";
import type { RunnerAdapterInput } from "../src/runner-adapter.js";
import {
  runTrustedShellRunner,
  TRUSTED_SHELL_ENV_VARS
} from "../src/trusted-shell-runner.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-trusted-shell-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "Trusted shell fixture ran.",
  key_changes_made: ["Edited fixture.txt"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted shell smoke",
    body: "",
    breaking: false
  }
});

const RUNNER_FAILURE_JSON = JSON.stringify({
  success: false,
  summary: "Trusted shell reported failure.",
  key_changes_made: [],
  key_learnings: [],
  remaining_work: ["something"],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted shell smoke",
    body: "",
    breaking: false
  }
});

type SetupOpts = {
  trustedShell?: unknown;
  iterationDir?: string;
  repoPath?: string;
  baseHead?: string;
  env?: NodeJS.ProcessEnv;
};

function setup(opts: SetupOpts = {}): RunnerAdapterInput {
  const iterationDir = opts.iterationDir ?? makeTempDir("momentum-trusted-shell-iter-");
  const repoPath = opts.repoPath ?? makeTempDir("momentum-trusted-shell-repo-");
  const spec: GoalSpec = {
    title: "Trusted shell probe",
    repo: repoPath,
    runner: "trusted-shell",
    branch: "momentum/trusted-shell-probe",
    max_iterations: 1,
    verification: ["true"],
    verification_timeout_sec: 900,
    body: "",
    ...(opts.trustedShell !== undefined
      ? { trusted_shell: opts.trustedShell }
      : {})
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

describe("runTrustedShellRunner — config validation", () => {
  it("returns invalid_input when trusted_shell block is missing", () => {
    const input = setup();
    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("trusted_shell");
  });

  it("returns invalid_input when trusted_shell is malformed", () => {
    const input = setup({ trustedShell: { args: ["-c", "true"] } });
    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("command");
  });
});

describe("runTrustedShellRunner — success path", () => {
  it("captures stdout/stderr, reads result.json, returns normalized RunnerResult", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const script = [
      "echo hello-stdout",
      "echo hello-stderr >&2",
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      trustedShell: { ...shellScript(script), timeout_sec: 30 }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("Trusted shell fixture ran.");
    expect(out.result.commit.subject).toBe("trusted shell smoke");

    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] start");
    expect(log).toContain("[trusted-shell] command: /bin/sh -c");
    expect(log).toContain("[trusted-shell] stdout:");
    expect(log).toContain("hello-stdout");
    expect(log).toContain("[trusted-shell] stderr:");
    expect(log).toContain("hello-stderr");
    expect(log).toContain("[trusted-shell] exit_code: 0");
    expect(log).toContain("[trusted-shell] runner_success: true");
    expect(log).toContain("[trusted-shell] done");
    expect(out.resultJsonPath).toBe(resultPath);
  });

  it("uses a custom result_file relative to the iteration directory", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const customResult = path.join(iterationDir, "custom-result.json");
    const script = [
      `cat <<'JSON' > "${customResult}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      trustedShell: {
        ...shellScript(script),
        result_file: "custom-result.json"
      }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resultJsonPath).toBe(customResult);
  });

  it("passes Momentum context to the child via MOMENTUM_* env vars", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const envDump = path.join(iterationDir, "env.txt");
    const script = [
      `: > "${envDump}"`,
      `printf 'GOAL_ID=%s\\n' "$MOMENTUM_GOAL_ID" >> "${envDump}"`,
      `printf 'ITERATION=%s\\n' "$MOMENTUM_ITERATION" >> "${envDump}"`,
      `printf 'REPO=%s\\n' "$MOMENTUM_REPO_PATH" >> "${envDump}"`,
      `printf 'BRANCH=%s\\n' "$MOMENTUM_BRANCH" >> "${envDump}"`,
      `printf 'BASE_HEAD=%s\\n' "$MOMENTUM_BASE_HEAD" >> "${envDump}"`,
      `printf 'PROMPT=%s\\n' "$MOMENTUM_PROMPT_PATH" >> "${envDump}"`,
      `printf 'ITER_DIR=%s\\n' "$MOMENTUM_ITERATION_DIR" >> "${envDump}"`,
      `printf 'RESULT=%s\\n' "$MOMENTUM_RESULT_PATH" >> "${envDump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      trustedShell: shellScript(script)
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const dump = fs.readFileSync(envDump, "utf-8");
    expect(dump).toContain(`GOAL_ID=${input.goalId}`);
    expect(dump).toContain(`ITERATION=${input.iteration}`);
    expect(dump).toContain(`REPO=${input.repoPath}`);
    expect(dump).toContain(`BRANCH=${input.branch}`);
    expect(dump).toContain(`BASE_HEAD=${input.baseHead}`);
    expect(dump).toContain(`PROMPT=${input.promptPath}`);
    expect(dump).toContain(`ITER_DIR=${input.iterationDir}`);
    expect(dump).toContain(`RESULT=${input.resultJsonPath}`);
  });

  it("merges config env block on top of inherited env", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const dump = path.join(iterationDir, "env.txt");
    const script = [
      `printf 'PROMPT=%s\\n' "$PROMPT" > "${dump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      trustedShell: {
        ...shellScript(script),
        env: { PROMPT: "from-config" }
      }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(dump, "utf-8")).toContain("PROMPT=from-config");
  });

  it("restricts env to env_allow when set, keeping PATH for command resolution", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const dump = path.join(iterationDir, "env.txt");
    const script = [
      `printf 'KEEP=%s\\n' "$KEEP_ME" > "${dump}"`,
      `printf 'DROPPED=%s\\n' "$DROP_ME" >> "${dump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      env: { KEEP_ME: "kept", DROP_ME: "dropped", PATH: process.env["PATH"] ?? "" },
      trustedShell: {
        ...shellScript(script),
        env_allow: ["KEEP_ME"]
      }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    const text = fs.readFileSync(dump, "utf-8");
    expect(text).toContain("KEEP=kept");
    expect(text).toContain("DROPPED=\n");
  });

  it("uses cwd=repo by default and cwd=iteration when configured", () => {
    const repoPath = makeTempDir("momentum-trusted-shell-repo-");
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const dump = path.join(iterationDir, "cwd.txt");
    const script = [
      `pwd > "${dump}"`,
      `cat <<'JSON' > "${resultPath}"`,
      VALID_RESULT_JSON,
      "JSON"
    ].join("\n");

    const repoInput = setup({
      iterationDir,
      repoPath,
      trustedShell: shellScript(script)
    });
    let out = runTrustedShellRunner(repoInput);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(dump, "utf-8").trim()).toBe(repoPath);

    const iterInput = setup({
      iterationDir,
      repoPath,
      trustedShell: { ...shellScript(script), cwd: "iteration" }
    });
    out = runTrustedShellRunner(iterInput);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(dump, "utf-8").trim()).toBe(iterationDir);
  });

  it("returns runner-reported failure with success=false (no error code)", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const script = [
      `cat <<'JSON' > "${resultPath}"`,
      RUNNER_FAILURE_JSON,
      "JSON"
    ].join("\n");
    const input = setup({
      iterationDir,
      trustedShell: shellScript(script)
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(false);
    expect(out.result.summary).toBe("Trusted shell reported failure.");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] runner_success: false");
  });
});

describe("runTrustedShellRunner — failure paths", () => {
  it("returns command_failed with stable code on non-zero exit", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const input = setup({
      iterationDir,
      trustedShell: shellScript("echo bye-stderr >&2; exit 42")
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    expect(out.error).toContain("42");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] exit_code: 42");
    expect(log).toContain("bye-stderr");
    expect(log).toContain("nonzero_exit");
  });

  it("returns command_timed_out when the command exceeds timeout_sec", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const input = setup({
      iterationDir,
      trustedShell: {
        ...shellScript("sleep 5"),
        timeout_sec: 1
      }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(out.error).toContain("1s");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] result: timed_out");
  });

  it("returns result_missing when the command exits 0 but never writes result.json", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const input = setup({
      iterationDir,
      trustedShell: shellScript("echo no-result")
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_missing");
    expect(out.error).toContain("result file");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] result_missing:");
  });

  it("returns result_invalid when the result file contains malformed JSON", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const input = setup({
      iterationDir,
      trustedShell: shellScript(`printf 'not json' > "${resultPath}"`)
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("invalid");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] result_invalid:");
  });

  it("returns result_invalid when the JSON is well-formed but does not match the RunnerResult shape", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const input = setup({
      iterationDir,
      trustedShell: shellScript(`printf '{"foo":1}' > "${resultPath}"`)
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
  });

  it("returns spawn_failed when the configured command does not exist", () => {
    const iterationDir = makeTempDir("momentum-trusted-shell-iter-");
    const input = setup({
      iterationDir,
      trustedShell: {
        command: "/does/not/exist/momentum-trusted-shell-binary",
        args: []
      }
    });

    const out = runTrustedShellRunner(input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("spawn_failed");
    const log = fs.readFileSync(input.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] spawn_error:");
  });
});

describe("TRUSTED_SHELL_ENV_VARS", () => {
  it("exposes a stable MOMENTUM_* contract", () => {
    expect(TRUSTED_SHELL_ENV_VARS).toEqual({
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
