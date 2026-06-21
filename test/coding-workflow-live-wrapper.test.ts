import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseLiveWrapperProfile } from "../src/adapters/live-wrapper-registry.js";
import { parseRunnerResult } from "../src/core/executors/runner-result.js";
import {
  CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR,
  loadCodingWorkflowWrapperConfig,
  runCodingWorkflowLiveWrapper,
  type CodingWorkflowWrapperDeps
} from "../src/core/workflow/coding-workflow-live-wrapper.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-coding-wrapper-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deps(env: NodeJS.ProcessEnv): CodingWorkflowWrapperDeps {
  return {
    env,
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents, "utf8"),
    mkdir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true }),
    spawn: (command, args, options) => spawnSync(command, args, options),
    stdout: () => {},
    stderr: () => {}
  };
}

function readResult(resultPath: string) {
  const parsed = parseRunnerResult(fs.readFileSync(resultPath, "utf8"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("NGX-499 coding workflow live wrapper profile", () => {
  it("ships a parseable live-wrapper profile for every live-wrapper-owned coding step", () => {
    const profilePath = path.join(
      process.cwd(),
      "profiles/ngx-499-coding-workflow-live-wrapper.profile.json"
    );
    const parsed = parseLiveWrapperProfile(
      JSON.parse(fs.readFileSync(profilePath, "utf8"))
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profile.name).toBe("ngx-499-coding-workflow-live-wrapper");
    expect(Array.from(parsed.profile.wrappers.keys()).sort()).toEqual([
      "implementation",
      "merge-cleanup",
      "no-mistakes",
      "postflight",
      "preflight"
    ]);
  });
});

describe("loadCodingWorkflowWrapperConfig", () => {
  it("loads per-step command config from MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", "true"],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          key_changes_made: ["checked repo"],
          commit: { type: "test", subject: "verify preflight" }
        }
      }
    });

    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath },
      readFile: (filePath) => fs.readFileSync(filePath, "utf8")
    });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.steps.preflight?.command).toBe("/bin/sh");
    expect(loaded.config.steps.preflight?.commit.subject).toBe(
      "verify preflight"
    );
  });

  it("refuses unsupported step keys", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "unknown-step": { command: "/bin/sh" }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("Unsupported workflow step kind");
  });
});

describe("runCodingWorkflowLiveWrapper", () => {
  it("runs the configured command and writes a successful RunnerResult", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", "test -d \"$MOMENTUM_REPO_PATH\""],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          success_summary: "preflight command passed",
          key_changes_made: ["Verified repo path."],
          commit: { type: "test", subject: "verify preflight" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "preflight",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        PATH: process.env.PATH
      })
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      success: true,
      summary: "preflight command passed"
    });
    const result = readResult(resultPath);
    expect(result.success).toBe(true);
    expect(result.key_changes_made).toEqual(["Verified repo path."]);
  });

  it("records command failures as success=false runner evidence", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        postflight: {
          command: "/bin/sh",
          args: ["-c", "exit 7"],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          commit: { type: "test", subject: "verify postflight" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "postflight",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("postflight command exited with code 7");
    const result = readResult(resultPath);
    expect(result.success).toBe(false);
    expect(result.remaining_work).toEqual([
      "Fix postflight command failure before advancing the workflow."
    ]);
  });

  it("writes failure evidence when no command is configured for the step", () => {
    const dir = makeTempDir();
    const resultPath = path.join(dir, "result.json");

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "implementation",
        MOMENTUM_REPO_PATH: dir,
        MOMENTUM_ITERATION_DIR: dir,
        MOMENTUM_RESULT_PATH: resultPath
      })
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    const result = readResult(resultPath);
    expect(result.summary).toBe(
      'No command is configured for workflow step "implementation".'
    );
  });
});
