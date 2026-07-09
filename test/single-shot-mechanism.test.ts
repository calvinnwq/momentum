import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { waitMs } from "./helpers/process-kill-harness.js";
import type { ExecutorRoundRecord } from "../src/core/executors/loop/reducer.js";
import type { LiveWrapperConfig } from "../src/adapters/live-wrapper-registry.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";
import {
  createOneShotLiveWrapperRoundRunner,
  createScriptCommandRoundRunner
} from "../src/core/executors/single-shot/mechanism.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../src/adapters/live-step-wrapper.js");
  vi.doUnmock("../src/core/executors/shared/step-finalize.js");
  vi.resetModules();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-single-shot-mech-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): { repoPath: string; baseHead: string } {
  const repoPath = makeTempDir();
  runGit(repoPath, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repoPath, ["config", "user.email", "single-shot@example.com"]);
  runGit(repoPath, ["config", "user.name", "Single Shot Tester"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "init", "--quiet"]);
  return { repoPath, baseHead: runGit(repoPath, ["rev-parse", "HEAD"]).trim() };
}

function round(overrides: Partial<ExecutorRoundRecord> = {}): ExecutorRoundRecord {
  const artifactRoot = overrides.artifactRoot ?? makeTempDir();
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "preflight",
    executorFamily: "one-shot",
    attempt: 1,
    roundIndex: 0,
    state: "running",
    classification: null,
    startedAt: 1_000,
    heartbeatAt: 1_000,
    finishedAt: null,
    agentProvider: "test",
    model: "test-model",
    effort: null,
    inputDigest: "sha256:input",
    resultDigest: null,
    artifactRoot,
    logPaths: [path.join(artifactRoot, "executor.log")],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null,
    ...overrides
  };
}

function runnerResult(): RunnerResult {
  return {
    success: true,
    summary: "single shot completed",
    key_changes_made: ["wrote result"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: true,
    commit: {
      type: "chore",
      scope: "single-shot",
      subject: "complete one shot",
      body: "",
      breaking: false
    }
  };
}

function resultJson(value: RunnerResult): string {
  return `${JSON.stringify(value)}\n`;
}

describe("single-shot concrete mechanisms", () => {
  it("runs a one-shot live wrapper, finalizes the repo, and captures the normalized result document", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const json = resultJson(runnerResult());
    const verificationLogPath = path.join(artifactRoot, "verify.log");
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, process.env.RESULT_JSON);fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/one-shot.txt', 'changed\\n')"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: ["RESULT_JSON"],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      env: { RESULT_JSON: json },
      repoSafety: {
        mode: "finalize",
        baseHead,
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath
      }
    });
    const result = mechanism(round({ artifactRoot }));

    expect(result.outcome).toEqual({ ok: true });
    expect(result.result).toEqual(runnerResult());
    expect(result.resultDigest).toBe(
      `sha256:${crypto.createHash("sha256").update(json).digest("hex")}`
    );
    expect(result.artifacts?.resultDocument?.path).toBe(
      path.join(artifactRoot, "result.json")
    );
    expect(result.artifacts?.resultDocument?.digest).toBe(result.resultDigest);
    expect(result.evidence?.verificationStatus).toBe("skipped");
    expect(result.evidence?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.evidence?.changedFiles).toEqual(["one-shot.txt"]);
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(
      result.evidence?.commitSha
    );
    expect(result.artifacts?.verificationOutput?.path).toBe(verificationLogPath);
  });

  it("resets finalize one-shot command failures that dirty the repo", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const verificationLogPath = path.join(artifactRoot, "verify.log");
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/dirty-failure.txt', 'dirty\n');process.exit(7)"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: [],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      repoSafety: {
        mode: "finalize",
        baseHead,
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath
      }
    });

    const result = mechanism(round({ artifactRoot }));

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "command_failed"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("rejects finalize one-shot rounds when the repo is dirty before launch", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const json = resultJson(runnerResult());
    fs.writeFileSync(path.join(repoPath, "preexisting.txt"), "dirty\n");
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, process.env.RESULT_JSON);fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/launched-one-shot.txt', 'launched\\n')"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: ["RESULT_JSON"],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      env: { RESULT_JSON: json },
      repoSafety: {
        mode: "finalize",
        baseHead,
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(round({ artifactRoot }));

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "git_failed"
    });
    expect(fs.existsSync(path.join(repoPath, "launched-one-shot.txt"))).toBe(
      false
    );
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"])).toContain(
      "preexisting.txt"
    );
  });

  it("rejects relative one-shot log paths before launching the wrapper", () => {
    const { repoPath } = initRepo();
    const artifactRoot = makeTempDir();
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/launched-one-shot.txt', 'launched\n')"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: [],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({ artifactRoot, logPaths: ["relative-one-shot.log"] })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "invalid_input"
    });
    expect(fs.existsSync(path.join(repoPath, "launched-one-shot.txt"))).toBe(
      false
    );
  });

  it("returns runtime_unavailable when one-shot wrapper setup throws", () => {
    const { repoPath } = initRepo();
    const artifactRoot = makeTempDir();
    const blockedParent = path.join(artifactRoot, "blocked-parent");
    fs.writeFileSync(blockedParent, "not a directory\n");
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: [],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({
        artifactRoot,
        logPaths: [path.join(blockedParent, "executor.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
  });

  it("resets finalize one-shot wrapper exceptions after the child dirties the repo", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const marker = "THROW_AFTER_CHILD";
    const json = resultJson(runnerResult());
    const originalWriteSync = fs.writeSync;
    let thrown = false;
    vi.spyOn(fs, "writeSync").mockImplementation(
      ((fd: number, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
        if (!thrown && typeof data === "string" && data.includes(marker)) {
          thrown = true;
          throw new Error("log write failed after child mutation");
        }
        return (originalWriteSync as (...input: unknown[]) => number)(
          fd,
          data,
          ...args
        );
      }) as typeof fs.writeSync
    );
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/dirty-throw.txt', 'dirty\\n');fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, process.env.RESULT_JSON);process.stdout.write(process.env.THROW_MARKER)"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: ["RESULT_JSON", "THROW_MARKER"],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      env: { RESULT_JSON: json, THROW_MARKER: marker },
      repoSafety: {
        mode: "finalize",
        baseHead,
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(round({ artifactRoot }));

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("runs a script command, finalizes the repo, and records commit evidence", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const logPath = path.join(artifactRoot, "script.log");
    const verificationLogPath = path.join(artifactRoot, "verify.log");
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'script ok'; printf 'changed\n' > script.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        agentProvider: null,
        model: null,
        logPaths: [logPath]
      })
    );

    expect(result.outcome).toEqual({ ok: true });
    expect(result.result).toBeUndefined();
    expect(result.evidence?.verificationStatus).toBe("skipped");
    expect(result.evidence?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.evidence?.changedFiles).toEqual(["script.txt"]);
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(
      result.evidence?.commitSha
    );
    expect(result.artifacts?.verificationOutput?.path).toBe(verificationLogPath);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("script ok");
  });

  it("maps non-zero script exits to command_failed after reset", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'dirty\n' > dirty.txt; exit 7"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    expect(
      mechanism(round({ artifactRoot, executorFamily: "script" })).outcome
    ).toEqual({
      ok: false,
      recoveryCode: "command_failed"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("rejects finalize script rounds when HEAD moved before launch", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    fs.writeFileSync(path.join(repoPath, "outside.txt"), "outside\n");
    runGit(repoPath, ["add", "outside.txt"]);
    runGit(repoPath, ["commit", "-m", "outside", "--quiet"]);
    const movedHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'launched\n' > launched-script.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "head_mismatch"
    });
    expect(fs.existsSync(path.join(repoPath, "launched-script.txt"))).toBe(
      false
    );
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(movedHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("kills a timed-out script command process group", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const sentinelPath = path.join(artifactRoot, "child-survived");
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: [
        "-c",
        `nohup /bin/sh -c 'sleep 2; touch ${sentinelPath}' >/dev/null 2>&1 & sleep 10`
      ],
      cwd: repoPath,
      timeoutSec: 1,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );
    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "command_timed_out"
    });

    waitMs(2_500);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it("rejects relative script log paths before launching the command", () => {
    const { repoPath } = initRepo();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'should not run' > launched.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({
        executorFamily: "script",
        logPaths: ["relative-script.log"]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "invalid_input"
    });
    expect(fs.existsSync(path.join(repoPath, "launched.txt"))).toBe(false);
  });

  it("returns runtime_unavailable when script process setup throws", () => {
    const { repoPath } = initRepo();
    const artifactRoot = makeTempDir();
    const logPath = path.join(artifactRoot, "script.log");
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'should not run'"],
      cwd: repoPath,
      timeoutSec: 5,
      env: { BAD_ENV: 1n } as unknown as NodeJS.ProcessEnv,
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [logPath]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
    expect(fs.readFileSync(logPath, "utf-8")).toContain("spawn_error");
  });

  it("preserves the script outcome when closing the log fails", () => {
    const { repoPath } = initRepo();
    const artifactRoot = makeTempDir();
    const originalCloseSync = fs.closeSync;
    vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      originalCloseSync(fd);
      throw new Error("close failed");
    }) as typeof fs.closeSync);
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'script ok'"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({ ok: true });
    expect(result.evidence?.verificationStatus).toBe("skipped");
  });

  it("finalizes script repo safety when post-process log writes fail", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const marker = "SCRIPT_LOG_WRITE_FAILURE";
    const originalWriteSync = fs.writeSync;
    let thrown = false;
    vi.spyOn(fs, "writeSync").mockImplementation(
      ((fd: number, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
        if (!thrown && typeof data === "string" && data.includes(marker)) {
          thrown = true;
          throw new Error("script log write failed");
        }
        return (originalWriteSync as (...input: unknown[]) => number)(
          fd,
          data,
          ...args
        );
      }) as typeof fs.writeSync
    );
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'dirty\\n' > dirty-log.txt; printf \"$THROW_MARKER\""],
      cwd: repoPath,
      timeoutSec: 5,
      env: { THROW_MARKER: marker },
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("finalizes script repo safety for supervisor spawn errors", async () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    vi.resetModules();
    vi.doMock("../src/adapters/live-step-wrapper.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/adapters/live-step-wrapper.js")>();
      return {
        ...actual,
        runProcessGroupSync: () => {
          fs.writeFileSync(path.join(repoPath, "dirty-supervisor.txt"), "dirty\n");
          const error = new Error("supervisor failed") as NodeJS.ErrnoException;
          error.code = "SUPERVISOR_FAILED";
          return {
            pid: 123,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: null,
            signal: null,
            error
          };
        }
      };
    });
    const { createScriptCommandRoundRunner: createMockedScriptCommandRoundRunner } =
      await import("../src/core/executors/single-shot/mechanism.js");
    const mechanism = createMockedScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'unused'"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "runtime_unavailable"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("treats finalize commit no-ops as safe script failures", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'no changes'"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "command_failed"
    });
    expect(result.evidence?.verificationStatus).toBe("skipped");
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("treats commit failures with successful reset as safe script failures", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const hooksDir = path.join(repoPath, ".git", "test-hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommitHook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(preCommitHook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(preCommitHook, 0o755);
    runGit(repoPath, ["config", "core.hooksPath", hooksDir]);
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'dirty\n' > hook-failure.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "command_failed"
    });
    expect(result.evidence?.verificationStatus).toBe("skipped");
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("preserves reset_failed when commit-failure cleanup fails", async () => {
    const artifactRoot = makeTempDir();
    vi.resetModules();
    vi.doMock("../src/core/executors/shared/step-finalize.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/core/executors/shared/step-finalize.js")>();
      return {
        ...actual,
        finalizeWorkflowStep: () => ({
          outcome: "commit_failed",
          verification: { ok: true, results: [] },
          commit: {
            ok: false,
            code: "git_failed",
            error: "git commit failed"
          },
          reset: {
            ok: false,
            code: "git_failed",
            error: "git reset failed after commit failure"
          }
        })
      };
    });
    const { createScriptCommandRoundRunner: createMockedScriptCommandRoundRunner } =
      await import("../src/core/executors/single-shot/mechanism.js");
    const { repoPath, baseHead } = initRepo();
    const mechanism = createMockedScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'dirty\n' > ignored.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: {
        mode: "finalize",
        baseHead,
        commitIntent: {
          type: "chore",
          scope: "script",
          subject: "run script",
          body: "",
          breaking: false
        },
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(artifactRoot, "verify.log")
      }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "reset_failed"
    });
    expect(result.evidence?.verificationStatus).toBe("skipped");
  });

  it("rejects read-only script success that dirties the repo", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'dirty\n' > dirty.txt"],
      cwd: repoPath,
      timeoutSec: 5,
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(
      round({
        artifactRoot,
        executorFamily: "script",
        logPaths: [path.join(artifactRoot, "script.log")]
      })
    );

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "git_failed"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toContain(
      "dirty.txt"
    );
  });

  it("rejects read-only one-shot success that dirties the repo", () => {
    const { repoPath, baseHead } = initRepo();
    const artifactRoot = makeTempDir();
    const json = resultJson(runnerResult());
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.env.MOMENTUM_RESULT_PATH, process.env.RESULT_JSON);fs.writeFileSync(process.env.MOMENTUM_REPO_PATH+'/dirty-one-shot.txt', 'dirty\\n')"
      ],
      cwd: "iteration",
      timeoutSec: 5,
      envAllow: ["RESULT_JSON"],
      resultFile: "result.json",
      probe: undefined
    };

    const mechanism = createOneShotLiveWrapperRoundRunner(config, {
      repoPath,
      kind: "preflight",
      env: { RESULT_JSON: json },
      repoSafety: { mode: "read-only" }
    });

    const result = mechanism(round({ artifactRoot }));

    expect(result.outcome).toEqual({
      ok: false,
      recoveryCode: "git_failed"
    });
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
    expect(runGit(repoPath, ["status", "--porcelain"]).trim()).toContain(
      "dirty-one-shot.txt"
    );
  });
});
