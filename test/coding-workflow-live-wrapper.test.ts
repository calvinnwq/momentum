import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseLiveWrapperProfile } from "../src/adapters/live-wrapper-registry.js";
import { parseRunnerResult } from "../src/core/executors/runner-result.js";
import {
  CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR,
  defaultCodingWorkflowWrapperDeps,
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

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

  it("keeps merge-cleanup executable independent of generated dist", () => {
    const profilePath = path.join(
      process.cwd(),
      "profiles/ngx-499-coding-workflow-live-wrapper.profile.json"
    );
    const parsed = parseLiveWrapperProfile(
      JSON.parse(fs.readFileSync(profilePath, "utf8"))
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const wrapper = parsed.profile.wrappers.get("merge-cleanup");
    expect(wrapper).toBeDefined();
    if (wrapper === undefined) return;
    expect(wrapper.args.join(" ")).not.toContain("dist/");

    const dir = makeTempDir();
    const configPath = path.join(dir, "wrapper-config.json");
    const resultPath = path.join(dir, "result.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", "true"],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          success_summary: "merge-cleanup source wrapper passed",
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const spawned = spawnSync(wrapper.command, [...wrapper.args], {
      cwd: process.cwd(),
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: process.cwd(),
        MOMENTUM_ITERATION_DIR: dir,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath
      },
      encoding: "utf8",
      timeout: 30_000
    });

    expect(spawned.stderr).toBe("");
    expect(spawned.status).toBe(0);
    const result = readResult(resultPath);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("merge-cleanup source wrapper passed");
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

  it("forwards selected route fields to the configured child command", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        implementation: {
          command: "/bin/sh",
          args: [
            "-c",
            'test "$MOMENTUM_AGENT_PROVIDER" = codex && test "$MOMENTUM_MODEL" = gpt-5.1 && test "$MOMENTUM_EFFORT" = high'
          ],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: [],
          success_summary: "route selection reached child command",
          commit: { type: "chore", subject: "complete implementation" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "implementation",
        MOMENTUM_AGENT_PROVIDER: "codex",
        MOMENTUM_MODEL: "gpt-5.1",
        MOMENTUM_EFFORT: "high",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath
      })
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      success: true,
      summary: "route selection reached child command"
    });
    expect(readResult(resultPath).success).toBe(true);
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

  it.each(["merge-cleanup", "linear-refresh"] as const)(
    "guides %s failures toward evidence-backed external-state reconciliation",
    (stepKind) => {
      const dir = makeTempDir();
      const repo = path.join(dir, "repo");
      const iteration = path.join(dir, "run");
      const resultPath = path.join(iteration, "result.json");
      fs.mkdirSync(repo);
      const configPath = path.join(dir, "wrapper-config.json");
      writeJson(configPath, {
        steps: {
          [stepKind]: {
            command: "/bin/sh",
            args: ["-c", "exit 1"],
            cwd: "repo",
            timeout_sec: 30,
            env_allow: ["PATH"],
            commit: { type: "chore", subject: `complete ${stepKind}` }
          }
        }
      });

      const outcome = runCodingWorkflowLiveWrapper(
        deps({
          MOMENTUM_STEP_KIND: stepKind,
          MOMENTUM_REPO_PATH: repo,
          MOMENTUM_ITERATION_DIR: iteration,
          MOMENTUM_RESULT_PATH: resultPath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
          PATH: process.env.PATH
        })
      );

      expect(outcome.success).toBe(false);
      const result = readResult(resultPath);
      expect(result.success).toBe(false);
      // A tail step that performs external work (push / merge / tracker write)
      // may have already merged a PR before failing, so the durable guidance must
      // not imply a naive re-run and must point at the safe recovery path.
      expect(result.remaining_work).not.toContain(
        `Fix ${stepKind} command failure before advancing the workflow.`
      );
      const guidance = result.remaining_work.join("\n");
      expect(guidance).toContain(stepKind);
      expect(guidance).toContain("external side effects");
      expect(guidance).toContain("clear-recovery");
      expect(guidance).toContain("--evidence-pointer");
      expect(guidance).not.toContain("retry");
    }
  );

  it("kills the full configured command tree on timeout", () => {
    if (process.platform === "win32") return;

    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "child-survived");
    const childScriptPath = path.join(dir, "child.sh");
    fs.mkdirSync(repo);
    fs.writeFileSync(
      childScriptPath,
      "#!/bin/sh\nsleep 2\ntouch \"$1\"\n",
      "utf8"
    );
    fs.chmodSync(childScriptPath, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: [
            "-c",
            `nohup /bin/sh "${childScriptPath}" "${sentinelPath}" >/dev/null 2>&1 & sleep 10`
          ],
          cwd: "repo",
          timeout_sec: 1,
          env_allow: ["PATH"],
          commit: { type: "test", subject: "verify no mistakes" }
        }
      }
    });

    const productionDeps = {
      ...defaultCodingWorkflowWrapperDeps(),
      env: {
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        PATH: process.env.PATH
      },
      stdout: () => {},
      stderr: () => {}
    };

    const outcome = runCodingWorkflowLiveWrapper(productionDeps);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    waitMs(2500);
    expect(fs.existsSync(sentinelPath)).toBe(false);
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
