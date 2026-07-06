import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseLiveWrapperProfile } from "../src/adapters/live-wrapper-registry.js";
import { parseRunnerResult } from "../src/core/executors/runner/result.js";
import {
  CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR,
  defaultCodingWorkflowWrapperDeps,
  loadCodingWorkflowWrapperConfig,
  runCodingWorkflowLiveWrapper,
  type CodingWorkflowWrapperDeps
} from "../src/core/workflow/live-wrapper/coding-workflow.js";

const tempRoots: string[] = [];
const MERGE_CLEANUP_HEAD = "a".repeat(40);

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
    stderr: () => {},
    readMergeCleanupPullRequest: ({ target }) => ({
      ok: true,
      pullRequest: {
        id: target.pullRequestId,
        headBranch: target.cleanupBranch,
        headSha: target.expectedHeadSha,
        state: "open",
        draft: false,
        mergeable: "mergeable",
        branchDeleted: false
      }
    })
  };
}

function mergeCleanupTargetConfig(overrides: Record<string, unknown> = {}) {
  return {
    pull_request_id: "42",
    expected_head_sha: MERGE_CLEANUP_HEAD,
    cleanup_branch: "feat/test-branch",
    ...overrides
  };
}

function noMistakesRunnerProfile(overrides: Record<string, unknown> = {}) {
  return {
    interface: "axi",
    stdin: "closed",
    agent: "codex",
    required_env: ["HOME", "CODEX_HOME", "PATH"],
    agent_path: process.execPath,
    ...overrides
  };
}

function makeNoMistakesHome(
  parentDir: string,
  agentPath = process.execPath,
  agent = "codex"
): string {
  const home = path.join(parentDir, "home");
  const configPath = path.join(home, ".no-mistakes", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      `agent: ${agent}`,
      "agent_path_override:",
      `  ${agent}: ${agentPath}`,
      ""
    ].join("\n"),
    "utf8"
  );
  return home;
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
    expect(parsed.profile.wrappers.get("merge-cleanup")?.envAllow).toEqual(
      expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"])
    );
    expect(parsed.profile.wrappers.get("no-mistakes")?.envAllow).toEqual(
      expect.arrayContaining(["HOME", "CODEX_HOME", "PATH"])
    );
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
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"number":42,"headRefName":"feat/test-branch","headRefOid":"${MERGE_CLEANUP_HEAD}","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
exit 1
`,
      "utf8"
    );
    fs.chmodSync(ghPath, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    const resultPath = path.join(dir, "result.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", "true"],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          merge_cleanup: mergeCleanupTargetConfig(),
          success_summary: "merge-cleanup source wrapper passed",
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const spawned = spawnSync(wrapper.command, [...wrapper.args], {
      cwd: process.cwd(),
      env: {
        HOME: process.env.HOME,
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: process.cwd(),
        MOMENTUM_ITERATION_DIR: dir,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        GH_TOKEN: "test-token",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
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

  it("parks merge-cleanup GitHub auth preflight as setup recovery", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("GitHub merge-cleanup");
    expect(outcome.summary).toContain("no explicit auth");
    expect(outcome.summary).toContain("GH_TOKEN");
    expect(outcome.summary).toContain("GH_CONFIG_DIR");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("does not read merge-cleanup GitHub state before explicit auth is present", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    let stateReadCount = 0;
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME"],
          merge_cleanup: mergeCleanupTargetConfig(),
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper({
      ...deps({
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: process.env.HOME,
        PATH: process.env.PATH
      }),
      readMergeCleanupPullRequest: () => {
        stateReadCount += 1;
        return { ok: false, error: "state read should not run without auth" };
      }
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("no explicit auth");
    expect(stateReadCount).toBe(0);
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("parks merge-cleanup missing target identity before spawning", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        GH_TOKEN: "test-token",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("durable pull request/head/cleanup-branch target");
    expect(outcome.summary).toContain("pull request, expected head SHA, cleanup branch");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("reconciles already-merged merge-cleanup state without spawning", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          merge_cleanup: mergeCleanupTargetConfig(),
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const baseDeps = deps({
      MOMENTUM_STEP_KIND: "merge-cleanup",
      MOMENTUM_REPO_PATH: repo,
      MOMENTUM_ITERATION_DIR: iteration,
      MOMENTUM_RESULT_PATH: resultPath,
      [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
      GH_TOKEN: "test-token",
      PATH: process.env.PATH
    });
    const outcome = runCodingWorkflowLiveWrapper({
      ...baseDeps,
      readMergeCleanupPullRequest: ({ target }) => ({
        ok: true,
        pullRequest: {
          id: target.pullRequestId,
          headBranch: target.cleanupBranch,
          headSha: target.expectedHeadSha,
          state: "merged",
          draft: false,
          mergeable: "mergeable",
          branchDeleted: true
        }
      })
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("already merged");
    expect(outcome.summary).toContain("already deleted");
    expect(outcome.summary).toContain("clear-recovery");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    const result = readResult(resultPath);
    expect(result.success).toBe(false);
    expect(result.remaining_work.join("\n")).toContain("clear-recovery");
  });

  it("detects deleted cleanup branches from gh branch lookup stderr", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(repo);
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"number":42,"headRefName":"feat/test-branch","headRefOid":"${MERGE_CLEANUP_HEAD}","state":"MERGED","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s\n' 'HTTP 404: Not Found' >&2
  exit 1
fi
exit 1
`,
      "utf8"
    );
    fs.chmodSync(ghPath, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          merge_cleanup: mergeCleanupTargetConfig(),
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper({
      ...defaultCodingWorkflowWrapperDeps(),
      env: {
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        GH_TOKEN: "test-token",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
      },
      stdout: () => {},
      stderr: () => {}
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("already merged");
    expect(outcome.summary).toContain("already deleted");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    const result = readResult(resultPath);
    expect(result.remaining_work.join("\n")).toContain("clear-recovery");
  });

  it("refuses merge-cleanup when the PR head branch differs from the cleanup target", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(repo);
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"number":42,"headRefName":"feat/other-branch","headRefOid":"${MERGE_CLEANUP_HEAD}","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
exit 1
`,
      "utf8"
    );
    fs.chmodSync(ghPath, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          merge_cleanup: mergeCleanupTargetConfig(),
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper({
      ...defaultCodingWorkflowWrapperDeps(),
      env: {
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        GH_TOKEN: "test-token",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
      },
      stdout: () => {},
      stderr: () => {}
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("cleanup branch");
    expect(outcome.summary).toContain("feat/other-branch");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("refuses merge-cleanup when GitHub reports an unclean merge state", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "merge-cleanup-ran");
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(repo);
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"number":42,"headRefName":"feat/test-branch","headRefOid":"${MERGE_CLEANUP_HEAD}","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"UNSTABLE"}'
  exit 0
fi
exit 1
`,
      "utf8"
    );
    fs.chmodSync(ghPath, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "merge-cleanup": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "GH_TOKEN"],
          merge_cleanup: mergeCleanupTargetConfig(),
          commit: { type: "chore", subject: "complete merge-cleanup" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper({
      ...defaultCodingWorkflowWrapperDeps(),
      env: {
        MOMENTUM_STEP_KIND: "merge-cleanup",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        GH_TOKEN: "test-token",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
      },
      stdout: () => {},
      stderr: () => {}
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("not an open, non-draft, mergeable target");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("bounds GitHub merge-cleanup preflight subprocesses", () => {
    const sourcePath = path.join(
      process.cwd(),
      "src/core/workflow/live-wrapper/coding-workflow.ts"
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain("const GITHUB_STATE_READ_TIMEOUT_MS");
    expect(source).toContain("timeout: GITHUB_STATE_READ_TIMEOUT_MS");
    expect(source.match(/timeout: GITHUB_STATE_READ_TIMEOUT_MS/g)).toHaveLength(2);
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

  it("rejects unknown top-level wrapper config keys", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            preflight: {
              command: "/bin/sh"
            }
          },
          unsupportedRootKey: {}
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain('"unsupportedRootKey"');
    expect(loaded.error).toContain("supported keys: steps");
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

  it.each([
    {
      name: "envAllow",
      field: "envAllow",
      json: { preflight: { command: "/bin/sh", envAllow: ["PATH"] } },
      expected: "env_allow"
    },
    {
      name: "timeoutSec",
      field: "timeoutSec",
      json: { preflight: { command: "/bin/sh", timeoutSec: 30 } },
      expected: "timeout_sec"
    },
    {
      name: "resultFile",
      field: "resultFile",
      json: {
        preflight: {
          command: "/bin/sh",
          resultFile: "result.json"
        }
      },
      expected: "result_file"
    }
  ])("suggests canonical snake_case for camelCase step keys: $name", ({ field, json, expected }) => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () => JSON.stringify({ steps: json })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain(`"${field}"`);
    expect(loaded.error).toContain(expected);
  });

  it.each(["implementation", "postflight", "no-mistakes", "merge-cleanup"])(
    "accepts validated step config for %s",
    (stepKind) => {
      const loaded = loadCodingWorkflowWrapperConfig({
        env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
        readFile: () =>
          JSON.stringify({
            steps: {
              [stepKind]: {
                command: "/bin/sh",
                args: ["-c", "echo ok"],
                cwd: "repo",
                timeout_sec: 30,
                env_allow: ["PATH"],
                ...(stepKind === "no-mistakes"
                  ? { runner_profile: noMistakesRunnerProfile() }
                  : {}),
                commit: { type: "test", subject: `validate ${stepKind}` }
              }
            }
          })
      });
      expect(loaded.ok, stepKind).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.config.steps[stepKind as keyof typeof loaded.config.steps]).toBeDefined();
    }
  );

  it("requires an explicit no-mistakes runner profile", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME", "CODEX_HOME"]
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("`runner_profile` is required");
  });

  it("requires Codex no-mistakes runner profiles to include CODEX_HOME", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME"],
              runner_profile: noMistakesRunnerProfile({
                required_env: ["PATH", "HOME"]
              })
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("CODEX_HOME");
  });

  it("accepts a non-Codex no-mistakes runner profile without CODEX_HOME", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME"],
              runner_profile: noMistakesRunnerProfile({
                agent: "claude",
                required_env: ["PATH", "HOME"]
              })
            }
          }
        })
    });

    expect(loaded.ok).toBe(true);
  });

  it("rejects auto no-mistakes runner profiles", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME"],
              runner_profile: noMistakesRunnerProfile({
                agent: "auto",
                required_env: ["PATH", "HOME"]
              })
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("must not be \"auto\"");
  });

  it("rejects unsupported no-mistakes runner profile agents", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME"],
              runner_profile: noMistakesRunnerProfile({
                agent: "gemini",
                required_env: ["PATH", "HOME"]
              })
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("claude, codex, opencode, rovodev");
  });

  it("requires no-mistakes runner profiles to use an absolute agent path", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "no-mistakes": {
              command: "/bin/sh",
              env_allow: ["PATH", "HOME", "CODEX_HOME"],
              runner_profile: noMistakesRunnerProfile({
                agent_path: "codex-runner"
              })
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("absolute path");
  });

  it("fails closed before spawning no-mistakes when required runner env is absent", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir),
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("CODEX_HOME");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed before spawning no-mistakes when the agent path is not executable", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile({
            agent_path: path.join(dir, "missing-agent-runner")
          }),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir),
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("agent_path is not an executable file");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed before spawning no-mistakes when the agent path is a directory", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile({
            agent_path: dir
          }),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir, dir),
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("agent_path is not an executable file");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed before spawning no-mistakes when no-mistakes config selects another agent", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir, process.execPath, "claude"),
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("configured agent claude does not match");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed when no-mistakes agent config only appears in nested YAML", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    const home = path.join(dir, "home");
    const noMistakesConfigPath = path.join(home, ".no-mistakes", "config.yaml");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.dirname(noMistakesConfigPath), { recursive: true });
    fs.writeFileSync(
      noMistakesConfigPath,
      [
        "nested:",
        "  agent: codex",
        "  agent_path_override:",
        `    codex: ${process.execPath}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: home,
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("must set an explicit supported agent");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed when no-mistakes agent path override only appears in nested YAML", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    const home = path.join(dir, "home");
    const noMistakesConfigPath = path.join(home, ".no-mistakes", "config.yaml");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.dirname(noMistakesConfigPath), { recursive: true });
    fs.writeFileSync(
      noMistakesConfigPath,
      [
        "agent: codex",
        "nested:",
        "  agent_path_override:",
        `    codex: ${process.execPath}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: home,
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("agent_path_override.codex");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed when no-mistakes agent path override is nested under the top-level section", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    const home = path.join(dir, "home");
    const noMistakesConfigPath = path.join(home, ".no-mistakes", "config.yaml");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.dirname(noMistakesConfigPath), { recursive: true });
    fs.writeFileSync(
      noMistakesConfigPath,
      [
        "agent: codex",
        "agent_path_override:",
        "  nested:",
        `    codex: ${process.execPath}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: home,
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("agent_path_override.codex");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("fails closed before spawning no-mistakes when no-mistakes config points the agent elsewhere", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(dir, "no-mistakes-ran");
    const otherWrapper = path.join(dir, "other-codex-runner");
    fs.mkdirSync(repo);
    fs.writeFileSync(otherWrapper, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(otherWrapper, 0o755);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir, otherWrapper),
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("agent_path_override.codex");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("rejects malformed env_allow values", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            preflight: {
              command: "/bin/sh",
              env_allow: ["PATH", 12]
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("`env_allow` must be an array of strings.");
  });

  it.each(["/tmp/result.json", "../result.json", ".", "nested/..", "C:\\temp\\result.json"])(
    "rejects unsafe result_file values: %s",
    (resultFile) => {
      const loaded = loadCodingWorkflowWrapperConfig({
        env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
        readFile: () =>
          JSON.stringify({
            steps: {
              preflight: {
                command: "/bin/sh",
                result_file: resultFile
              }
            }
          })
      });

      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error).toContain("result_file");
      expect(loaded.error).toContain("relative path inside the iteration artifact directory");
    }
  );

  it("rejects non-string result_file values", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            preflight: {
              command: "/bin/sh",
              result_file: 42
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("`result_file` must be a non-empty string");
  });

  it("loads merge-cleanup target identity from the wrapper config", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "merge-cleanup": {
              command: "/bin/sh",
              args: ["-c", "true"],
              cwd: "repo",
              timeout_sec: 30,
              env_allow: ["PATH", "GH_TOKEN"],
              merge_cleanup: mergeCleanupTargetConfig(),
              commit: { type: "test", subject: "validate merge cleanup" }
            }
          }
        })
    });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.steps["merge-cleanup"]?.mergeCleanup).toEqual({
      pullRequestId: "42",
      expectedHeadSha: MERGE_CLEANUP_HEAD,
      cleanupBranch: "feat/test-branch"
    });
  });

  it("rejects malformed merge-cleanup target identity", () => {
    const loaded = loadCodingWorkflowWrapperConfig({
      env: { [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: "/config.json" },
      readFile: () =>
        JSON.stringify({
          steps: {
            "merge-cleanup": {
              command: "/bin/sh",
              merge_cleanup: mergeCleanupTargetConfig({ expected_head_sha: "abc" })
            }
          }
        })
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("expected_head_sha");
    expect(loaded.error).toContain("40-character hex SHA");
  });

  it("fails camelCase envAllow before spawning and points to the config file and key", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(iteration, "should-not-run");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          envAllow: ["PATH"],
          commit: { type: "test", subject: "camel-case guard" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "preflight",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain(configPath);
    expect(outcome.summary).toContain('"envAllow"');
    expect(outcome.summary).toContain("env_allow");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });
});

describe("runCodingWorkflowLiveWrapper", () => {
  it("runs a non-Codex no-mistakes runner profile with matching no-mistakes config", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", "test \"$HOME\" != \"\" && test \"$PATH\" != \"\""],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME"],
          runner_profile: noMistakesRunnerProfile({
            agent: "claude",
            required_env: ["HOME", "PATH"],
            agent_path: process.execPath
          }),
          success_summary: "non-Codex no-mistakes profile passed",
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir, process.execPath, "claude"),
        PATH: process.env.PATH
      })
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      success: true,
      summary: "non-Codex no-mistakes profile passed"
    });
    expect(readResult(resultPath).success).toBe(true);
  });

  it("accepts no-mistakes config when agent appears after agent_path_override", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const home = path.join(dir, "home");
    const noMistakesConfigPath = path.join(home, ".no-mistakes", "config.yaml");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.dirname(noMistakesConfigPath), { recursive: true });
    fs.writeFileSync(
      noMistakesConfigPath,
      [
        "agent_path_override:",
        `  codex: ${process.execPath}`,
        "agent: codex",
        ""
      ].join("\n"),
      "utf8"
    );
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", "test \"$CODEX_HOME\" != \"\""],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          success_summary: "reordered no-mistakes config passed",
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: home,
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      success: true,
      summary: "reordered no-mistakes config passed"
    });
    expect(readResult(resultPath).success).toBe(true);
  });

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

  it("refuses malformed env_allow in wrapper config before spawning the child command", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(iteration, "should-not-run");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", 100],
          commit: { type: "chore", subject: "invalid env allow test" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "implementation",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("`env_allow` must be an array of strings.");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("refuses result_file mismatches before spawning the child command", () => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    const sentinelPath = path.join(iteration, "should-not-run");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", `touch ${JSON.stringify(sentinelPath)}`],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          result_file: "custom-result.json",
          commit: { type: "chore", subject: "result file guard" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "implementation",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("result_file");
    expect(outcome.summary).toContain("MOMENTUM_RESULT_PATH");
    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(false);
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

  it.each([
    {
      name: "missing external branch-start state",
      stdout:
        'error: "no run started for \\"feat/example\\": no previous run for branch feat/example"',
      expected: "external gate state has no previous run"
    },
    {
      name: "cancelled external no-mistakes run",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: cancelled",
        "outcome: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n"),
      expected: "cancelled before producing a reliable successful result"
    },
    {
      name: "cancelled external no-mistakes run without outcome line",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: cancelled",
        "  review: failed",
        'error: "cancelled: aborted by user"'
      ].join("\n"),
      expected: "cancelled before producing a reliable successful result"
    },
    {
      name: "compact cancelled external no-mistakes run status",
      stdout: [
        "run status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n"),
      expected: "cancelled before producing a reliable successful result"
    },
    {
      name: "JSON cancelled external no-mistakes run status",
      stdout: [
        '{"run":{"id":"01TEST","status":"cancelled"}}',
        'error: "cancelled: aborted by user"'
      ].join("\n"),
      expected: "cancelled before producing a reliable successful result"
    },
    {
      name: "cancelled external no-mistakes run after nested status block",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  ci:",
        "    status: running",
        "  status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n"),
      expected: "cancelled before producing a reliable successful result"
    }
  ])(
    "parks no-mistakes runner lifecycle failure as process setup recovery: $name",
    ({ stdout, expected }) => {
      const dir = makeTempDir();
      const repo = path.join(dir, "repo");
      const iteration = path.join(dir, "run");
      const resultPath = path.join(iteration, "result.json");
      fs.mkdirSync(repo);
      const configPath = path.join(dir, "wrapper-config.json");
      writeJson(configPath, {
        steps: {
          "no-mistakes": {
            command: "/bin/sh",
            args: ["-c", `printf '%s\\n' ${JSON.stringify(stdout)}; exit 1`],
            cwd: "repo",
            timeout_sec: 30,
            env_allow: ["PATH", "HOME", "CODEX_HOME", "GH_TOKEN"],
            runner_profile: noMistakesRunnerProfile(),
            commit: { type: "test", subject: "run no mistakes" }
          }
        }
      });

      const outcome = runCodingWorkflowLiveWrapper(
        deps({
          MOMENTUM_STEP_KIND: "no-mistakes",
          MOMENTUM_REPO_PATH: repo,
          MOMENTUM_ITERATION_DIR: iteration,
          MOMENTUM_RESULT_PATH: resultPath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
          GH_TOKEN: "test-token",
          HOME: makeNoMistakesHome(dir),
          CODEX_HOME: "/tmp/codex-home",
          PATH: process.env.PATH
        })
      );

      expect(outcome.exitCode).toBe(1);
      expect(outcome.success).toBe(false);
      expect(outcome.summary).toContain(expected);
      expect(outcome.summary).toContain("clear recovery to retry");
      expect(fs.existsSync(resultPath)).toBe(false);
    }
  );

  it.each([
    {
      name: "checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "outcome: checks-passed",
        "ci: running"
      ].join("\n"),
      expected: "reached checks-passed"
    },
    {
      name: "compact JSON checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '{"outcome":"checks-passed"}',
        "ci: running"
      ].join("\n"),
      expected: "reached checks-passed"
    },
    {
      name: "equals checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "outcome=checks-passed",
        "ci: running"
      ].join("\n"),
      expected: "reached checks-passed"
    },
    {
      name: "arrow checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "outcome=>checks-passed",
        "ci: running"
      ].join("\n"),
      expected: "reached checks-passed"
    },
    {
      name: "running no-mistakes with a clean green PR",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with resolved decision evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisions[0]: resolved"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with scoped clean PR status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR status: clean",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with resolved JSON decision history",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"status":"resolved"}]}'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with approved JSON decision history",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"resolution":"approved"}]}'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with no checks reported",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "no checks reported"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with passed external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "ciState: passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with no-checks external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "ci_state: none"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with JSON step status and no-checks external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '"stepStatus": "running"',
        "PR #42 mergeStateStatus CLEAN",
        "ciState: none"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with snake case clean merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "merge_state_status: clean",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with snake case clean mergeable state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "mergeable_state: clean",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with clean mergeable state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "mergeable state: clean",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with false required approval flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approvalRequired: false"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with false operator decision flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operatorDecisionRequired: false"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with false decision required label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decision required: false"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with pretty JSON false approval required flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"approvalRequired": false,'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with compact JSON false required flags",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"decisionRequired":false}'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with object external state container",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "externalState: {\"stepStatus\":\"running\",\"ciState\":\"none\"}",
        "PR #42 mergeStateStatus CLEAN"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with pretty external state container",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "externalState:",
        "  stepStatus: running",
        "  ciState: none",
        "PR #42 mergeStateStatus CLEAN"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with pretty object external state container",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "externalState: {",
        "  stepStatus: running",
        "  ciState: none",
        "}",
        "PR #42 mergeStateStatus CLEAN"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with compact object external state container",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '{"externalState":{"stepStatus":"running","ciState":"none"}}',
        "PR #42 mergeStateStatus CLEAN"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with nested identity text containing gate words",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '{"externalState":{"stepStatus":"running","ciState":"none","branch":"feat/approval-required-copy"}}',
        "PR #42 mergeStateStatus CLEAN"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with keyed no-conflict evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "merge conflicts: none",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with keyed resolved conflict evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "merge conflict: resolved",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with not-required approval label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approval: not required"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with not-required operator decision label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operator decision: not-required"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with inactive JSON approval marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"no approval required"}'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with identity text containing gate words",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"branch":"feat/approval-required-copy","prUrl":"https://example.test/pulls/1"}'
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with raw branch identity containing gate words",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "branch: feat/approval-required-copy"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with no approval required label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approval: no approval required"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with no decision required label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operator decision: no decision required"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with historical failed checks before current clean green evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous checks failed",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with current clean PR and history note",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "current PR mergeStateStatus CLEAN (previously dirty)",
        "GitHub checks passed"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with current no-checks CI state and history note",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "current ciState: none (previously pending)"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    },
    {
      name: "running no-mistakes with continue classification",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "classification: continue",
        "PR #42 mergeStateStatus CLEAN",
        "ciState: none"
      ].join("\n"),
      expected: "pull request is clean and checks are green"
    }
  ])(
    "treats no-mistakes $name as terminal success for the workflow",
    ({ stdout, expected }) => {
      const dir = makeTempDir();
      const repo = path.join(dir, "repo");
      const iteration = path.join(dir, "run");
      const resultPath = path.join(iteration, "result.json");
      fs.mkdirSync(repo);
      const configPath = path.join(dir, "wrapper-config.json");
      writeJson(configPath, {
        steps: {
          "no-mistakes": {
            command: "/bin/sh",
            args: ["-c", `printf '%s\\n' ${JSON.stringify(stdout)}; exit 1`],
            cwd: "repo",
            timeout_sec: 30,
            env_allow: ["PATH", "HOME", "CODEX_HOME", "GH_TOKEN"],
            runner_profile: noMistakesRunnerProfile(),
            key_changes_made: ["Verified no-mistakes readiness."],
            key_learnings: ["no-mistakes keeps monitoring open PRs."],
            commit: { type: "test", subject: "run no mistakes" }
          }
        }
      });

      const outcome = runCodingWorkflowLiveWrapper(
        deps({
          MOMENTUM_STEP_KIND: "no-mistakes",
          MOMENTUM_REPO_PATH: repo,
          MOMENTUM_ITERATION_DIR: iteration,
          MOMENTUM_RESULT_PATH: resultPath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
          GH_TOKEN: "test-token",
          HOME: makeNoMistakesHome(dir),
          CODEX_HOME: "/tmp/codex-home",
          PATH: process.env.PATH
        })
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.success).toBe(true);
      expect(outcome.summary).toContain(expected);
      const result = readResult(resultPath);
      expect(result.success).toBe(true);
      expect(result.summary).toContain(expected);
      expect(result.key_changes_made).toEqual([
        "Verified no-mistakes readiness."
      ]);
      expect(result.key_learnings).toEqual([
        "no-mistakes keeps monitoring open PRs."
      ]);
    }
  );

  it.each([
    {
      name: "running output with only historical clean and green evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous PR mergeStateStatus CLEAN",
        "previous GitHub checks passed"
      ].join("\n")
    },
    {
      name: "running output with only prefixed historical clean and green evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "- previous PR mergeStateStatus CLEAN",
        "- previous GitHub checks passed"
      ].join("\n")
    },
    {
      name: "running output with only suffixed historical clean and green evidence",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR mergeStateStatus CLEAN from previous run",
        "GitHub checks passed in previous run"
      ].join("\n")
    },
    {
      name: "stale running output followed by failed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "outcome: failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by blocked status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "status: blocked"
      ].join("\n")
    },
    {
      name: "stale running output followed by awaiting approval status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "status: awaiting_approval"
      ].join("\n")
    },
    {
      name: "stale running output followed by awaiting approval stepStatus",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "stepStatus: awaiting_approval"
      ].join("\n")
    },
    {
      name: "stale running output followed by current failed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current outcome: failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by pending status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "status: pending"
      ].join("\n")
    },
    {
      name: "stale running output followed by failed classification",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "classification: failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON blocked classification",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"classification":"blocked"}'
      ].join("\n")
    },
    {
      name: "stale running output followed by blocked recovery code",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "recoveryCode: external_state_blocked"
      ].join("\n")
    },
    {
      name: "stale running output followed by unknown recovery code",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "recoveryCode: runtime_unavailable"
      ].join("\n")
    },
    {
      name: "stale running output followed by failed recovery code",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "recovery code: external_run_failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON recovery code",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"recoveryCode":"external_state_blocked"}'
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON unknown recovery code",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"recoveryCode":"runtime_unavailable"}'
      ].join("\n")
    },
    {
      name: "stale running output followed by checks failed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "outcome: checks_failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON pending status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"status":"pending"}'
      ].join("\n")
    },
    {
      name: "stale running output followed by null JSON step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"stepStatus":null}'
      ].join("\n")
    },
    {
      name: "stale running output followed by array JSON status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"status":[]}'
      ].join("\n")
    },
    {
      name: "stale running output followed by equals failed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "outcome=failed"
      ].join("\n")
    },
    {
      name: "stale running output followed by arrow awaiting approval step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "stepStatus=>awaiting_approval"
      ].join("\n")
    },
    {
      name: "stale running output followed by current blocked status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current status: blocked"
      ].join("\n")
    },
    {
      name: "stale running output followed by JSON awaiting approval stepStatus",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"stepStatus": "awaiting_approval"'
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON gate state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"stepStatus":"awaiting_approval","decisions":[{}]}'
      ].join("\n")
    },
    {
      name: "stale running output followed by compact JSON running status before blocked step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"status":"running","stepStatus":"awaiting_approval"}'
      ].join("\n")
    },
    {
      name: "stale running output followed by nested JSON awaiting approval status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"status":"running","state":{"stepStatus":"awaiting_approval"}}'
      ].join("\n")
    },
    {
      name: "stale running output followed by comma separated blocked step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "status: running, stepStatus: awaiting_approval"
      ].join("\n")
    },
    {
      name: "stale running output followed by blocked step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "step status: blocked"
      ].join("\n")
    },
    {
      name: "stale running output followed by current blocked step status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current step status: awaiting_approval"
      ].join("\n")
    },
    {
      name: "historical checks-passed outcome with active gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous outcome: checks-passed",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "gate: operator_decision_required"
      ].join("\n")
    },
    {
      name: "historical checks-passed outcome suffix",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "outcome: checks-passed, previous run"
      ].join("\n")
    },
    {
      name: "historical checks-passed outcome parenthetical",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "outcome: checks-passed (previous run)"
      ].join("\n")
    },
    {
      name: "historical nested JSON checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '{"previous":{"outcome":"checks-passed"}}'
      ].join("\n")
    },
    {
      name: "unscoped nested JSON checks-passed message",
      stdout: [
        "run:",
        '  id: "01TEST"',
        '{"message":{"outcome":"checks-passed"}}'
      ].join("\n")
    },
    {
      name: "unscoped prose checks-passed outcome message",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "message: outcome: checks-passed"
      ].join("\n")
    },
    {
      name: "prefixed historical JSON checks-passed outcome",
      stdout: [
        "run:",
        '  id: "01TEST"',
        'previous: {"outcome":"checks-passed"}'
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by dirty PR",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current PR state: dirty"
      ].join("\n")
    },
    {
      name: "stale green evidence followed by copular false clean PR",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "GitHub checks passed",
        "PR clean is false"
      ].join("\n")
    },
    {
      name: "stale green evidence followed by copular no clean PR",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "GitHub checks passed",
        "pull request clean was no"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by unstable merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current mergeStateStatus UNSTABLE"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by behind merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current mergeStateStatus BEHIND"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by unknown merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current mergeStateStatus UNKNOWN"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by draft merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current mergeStateStatus DRAFT"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by draft boolean",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "isDraft: true"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by draft field",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "draft: true"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by JSON draft field",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"draft":true}'
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by draft PR prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "PR is draft"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by false mergeable value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable: false"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by separatorless false mergeable value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable false"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by separatorless no mergeable value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable no"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by conflicting mergeable enum",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable: CONFLICTING"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by non-mergeable prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "PR is not mergeable"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by cannot-merge prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "pull request cannot be merged"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by snake case behind merge state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "merge_state_status: behind"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by snake case dirty mergeable state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable_state: dirty"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by failed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current checks failed"
      ].join("\n")
    },
    {
      name: "stale clean PR followed by copular false passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed is false"
      ].join("\n")
    },
    {
      name: "stale clean PR followed by copular skipped passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci passed was skipped"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by running checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current checks running"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by running CI",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci is running"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by colon running CI status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci status: running"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by equals queued CI status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci status=queued"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by colon waiting CI status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci status: waiting"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by in-progress checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "checks are in progress"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by awaiting checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "awaiting checks"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by checks awaiting",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "checks awaiting"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by blocked checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "checks blocked"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by gated CI",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci gated"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by negated checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "not all checks passed"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by pending checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "pending checks"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by failed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "failed checks"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by red CI",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "red CI"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by merge conflict prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "merge conflicts detected"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by failed external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ciState: failed"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by current failed external CI state with historical note",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current ciState: failed (previously passed)"
      ].join("\n")
    },
    {
      name: "stale historical CI state followed by current failed external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "previous ciState: passed; current ciState: failed"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by failed check conclusion",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "checkConclusion: failure"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by JSON action-required check conclusion",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"conclusion":"action_required"}'
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by pending external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci_state: pending"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by error external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ciState: error"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by cancelled external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ciState: cancelled"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by running external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci_state: running"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by skipped checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "checks skipped"
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by action-required CI status",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci status: action_required"
      ].join("\n")
    },
    {
      name: "clean PR with unknown checks-passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed: unknown"
      ].join("\n")
    },
    {
      name: "clean PR with skipped CI-passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci passed: skipped"
      ].join("\n")
    },
    {
      name: "clean PR with false no-checks value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "no checks reported: false"
      ].join("\n")
    },
    {
      name: "clean PR with transient no-checks value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "no checks reported yet"
      ].join("\n")
    },
    {
      name: "clean PR with pending no-checks value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "no checks reported: pending"
      ].join("\n")
    },
    {
      name: "vague running output",
      stdout: "status: running"
    },
    {
      name: "unclean PR with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "pull request is not clean",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "false PR clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR clean: false",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "JSON false clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"clean": false',
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "no pull request clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "pull request clean: no",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "trailing no pull request clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "pull request clean no",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "trailing false PR clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR clean false",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "comma trailing false PR clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR clean false,",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "unknown PR clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR clean: unknown",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "pending pull request clean value with passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "pull request clean: pending",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "repeated clean field with pending current value and passed checks",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR clean: true, current clean: pending",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "clean PR with not all checks passed",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "not all checks passed"
      ].join("\n")
    },
    {
      name: "clean PR with false checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed: false"
      ].join("\n")
    },
    {
      name: "clean PR with JSON false checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        '"passed": false'
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by JSON false mergeable value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"mergeable": false'
      ].join("\n")
    },
    {
      name: "stale clean green evidence followed by repeated conflicting mergeable value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "mergeable: true, current mergeable: conflicting"
      ].join("\n")
    },
    {
      name: "clean PR with no checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed: no"
      ].join("\n")
    },
    {
      name: "clean PR with trailing no checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed no"
      ].join("\n")
    },
    {
      name: "clean PR with trailing false checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed false"
      ].join("\n")
    },
    {
      name: "clean PR with comma trailing false checks passed value",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "checks passed false,"
      ].join("\n")
    },
    {
      name: "stale green checks followed by separatorless failed external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ciState failed"
      ].join("\n")
    },
    {
      name: "stale green checks followed by separatorless running external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "ci state running"
      ].join("\n")
    },
    {
      name: "stale green checks followed by repeated failed external CI state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ciState: passed, current ciState: failed"
      ].join("\n")
    },
    {
      name: "clean PR with CI not green",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci is not green"
      ].join("\n")
    },
    {
      name: "clean PR with CI contraction not green",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci isn't green"
      ].join("\n")
    },
    {
      name: "clean PR with CI never passed",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci never passed"
      ].join("\n")
    },
    {
      name: "clean PR with CI hasnt passed",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "ci hasn't passed"
      ].join("\n")
    },
    {
      name: "current clean green output with only historical running marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "previous ci/running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "clean PR with GitHub checks havent passed",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "github checks haven't passed"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and active gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "gate: operator_decision_required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and operator decision required prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operator decision is required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and approval required prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approval is required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and awaiting approval prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "awaiting approval"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and waiting for approval prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "waiting for approval"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and requires approval prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "requires approval"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and manual recovery is required prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "manual recovery is required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and external state is required prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "external state is required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and requires manual recovery prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "requires manual recovery"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and requires external state prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "requires external state"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and awaiting operator decision prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "awaiting operator decision"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and finding table",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "findings[0]: security review required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and decision-required marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decision required: choose a reviewer action"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and camel decision required flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisionRequired: true"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and snake decision required flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decision_required: true"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and camel human gate required flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "humanGateRequired: true"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and spaced human gate required prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "human gate required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and compact JSON decision required flag",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisionRequired":true}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and prefixed compact JSON gate state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        'state: {"stepStatus":"awaiting_approval","decisions":[{}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and bullet-prefixed compact JSON gate state",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '- state: {"decisions":[{"action":"approve_or_retry"}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and bullet-prefixed compact JSON findings",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '- {"findings":[{}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus compact JSON gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"humanGate":"operator_decision_required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and human gate label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "humanGate: open"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and same-line status then human gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "status: running, humanGate: open",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and same-line inactive required flag before human gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approvalRequired: false, humanGate: open"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and same-line inactive required flag after human gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "humanGate: open, approvalRequired: false"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and same-line inactive required flag after operator decision prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operator decision is required; approvalRequired: false"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and current human gate label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current human gate: open"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and required operator decision label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "operator decision: required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and required approval label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "approval: required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and required manual recovery label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "manual recovery: required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and compact JSON required operator decision label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"operatorDecision":"required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and pretty JSON human gate label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"humanGate": "open",'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus JSON prose gate marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"requires operator decision"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus JSON operator decision prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"operator decision is required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus JSON approval marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"approval required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and mixed inactive and active gate prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "no approval required; operator decision required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus mixed gate prose",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"no approval required; operator decision required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus JSON snake decision marker",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"message":"decision_required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and inactive required flag plus classification gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"approvalRequired":false,"classification":"operator_decision_required"}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and decision table",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisions[0]: approve or retry"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and not resolved decision",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decision: not resolved"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and missing approval gate",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "gate: no approval received"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and nonempty decisions label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisions: approve or retry"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and scoped findings label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current findings: security review required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and scoped decision label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current decision: approve or retry"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and equals gate label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "gate=open"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and equals decisions label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        'decisions=[{"action":"approve_or_retry"}]'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and arrow decisions label",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        'decisions=>[{"action":"approve_or_retry"}]'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and YAML decisions section",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisions:",
        "  - approve or retry"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and YAML decisions mapping",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "decisions:",
        "  action: approve or retry"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and YAML findings section",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "findings:",
        "  - security review required"
      ].join("\n")
    },
    {
      name: "clean PR with green checks and JSON decisions array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"decisions": [{"action":"approve_or_retry"}]'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and JSON findings array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '"findings": [{"severity":"error"}]'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and compact JSON decisions array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"action":"approve_or_retry"}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and malformed JSON decisions array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[null]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and nested compact JSON decisions array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"state":{"decisions":[{"action":"approve_or_retry"}]}}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and escaped JSON decision details",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"action":"approve_or_retry","details":"line one\\nline two"}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and null JSON decision resolution",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"resolution":null}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and empty JSON decision resolution",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"resolution":""}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and string false resolved JSON decision",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"decisions":[{"resolved":"false"}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and compact JSON findings array",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"findings":[{"severity":"error"}]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and selected finding IDs",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"selectedFindingIds":["F-1"]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and malformed selected finding IDs",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        '{"selectedFindingIds":[null]}'
      ].join("\n")
    },
    {
      name: "clean PR with green checks and current selected finding IDs",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "PR #42 mergeStateStatus CLEAN",
        "GitHub checks passed",
        "current selected finding ids: [F-1]"
      ].join("\n")
    },
    {
      name: "cancelled CI status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "nested cancelled CI status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci:",
        "  status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "historical cancelled no-mistakes status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "historical compact cancelled no-mistakes status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous run status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "annotated historical compact cancelled no-mistakes status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "run status: cancelled (previous run)",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "historical section compact cancelled no-mistakes status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "history:",
        "  run status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "CI section compact cancelled no-mistakes status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "ci:",
        "  run status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "historical section nested cancelled no-mistakes run with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "history:",
        "  run:",
        "    status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    },
    {
      name: "previous section cancelled status with aborted user text",
      stdout: [
        "run:",
        '  id: "01TEST"',
        "  status: running",
        "previous:",
        "  status: cancelled",
        'error: "cancelled: aborted by user"'
      ].join("\n")
    }
  ])("does not treat no-mistakes $name as workflow success", ({ stdout }) => {
    const dir = makeTempDir();
    const repo = path.join(dir, "repo");
    const iteration = path.join(dir, "run");
    const resultPath = path.join(iteration, "result.json");
    fs.mkdirSync(repo);
    const configPath = path.join(dir, "wrapper-config.json");
    writeJson(configPath, {
      steps: {
        "no-mistakes": {
          command: "/bin/sh",
          args: [
            "-c",
            `cat <<'MOMENTUM_TEST_OUTPUT'\n${stdout}\nMOMENTUM_TEST_OUTPUT\nexit 1`
          ],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
          commit: { type: "test", subject: "run no mistakes" }
        }
      }
    });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "no-mistakes",
        MOMENTUM_REPO_PATH: repo,
        MOMENTUM_ITERATION_DIR: iteration,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath,
        HOME: makeNoMistakesHome(dir),
        CODEX_HOME: "/tmp/codex-home",
        PATH: process.env.PATH
      })
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.success).toBe(false);
    const result = readResult(resultPath);
    expect(result.success).toBe(false);
    expect(result.remaining_work).toEqual([
      "Fix no-mistakes command failure before advancing the workflow."
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
            env_allow: ["PATH", "GH_TOKEN"],
            ...(stepKind === "merge-cleanup"
              ? { merge_cleanup: mergeCleanupTargetConfig() }
              : {}),
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
          GH_TOKEN: "test-token",
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
          env_allow: ["PATH", "HOME", "CODEX_HOME"],
          runner_profile: noMistakesRunnerProfile(),
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
        HOME: makeNoMistakesHome(dir),
        CODEX_HOME: "/tmp/codex-home",
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

  it("refuses missing wrapper config as process setup failure", () => {
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

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toContain("MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG");
    expect(fs.existsSync(resultPath)).toBe(false);
  });

  it("refuses a configured wrapper file that omits the current step before writing runner evidence", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "wrapper-config.json");
    const resultPath = path.join(dir, "result.json");
    writeJson(configPath, { steps: {} });

    const outcome = runCodingWorkflowLiveWrapper(
      deps({
        MOMENTUM_STEP_KIND: "implementation",
        MOMENTUM_REPO_PATH: dir,
        MOMENTUM_ITERATION_DIR: dir,
        MOMENTUM_RESULT_PATH: resultPath,
        [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: configPath
      })
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.success).toBe(false);
    expect(outcome.summary).toBe(
      'No command is configured for workflow step "implementation" in MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG.'
    );
    expect(fs.existsSync(resultPath)).toBe(false);
  });
});
