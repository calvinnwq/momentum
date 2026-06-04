import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExecutorRoundRecord } from "../src/executor-loop-reducer.js";
import type { LiveWrapperConfig } from "../src/live-wrapper-registry.js";
import type { RunnerResult } from "../src/runner-result.js";
import {
  createOneShotLiveWrapperRoundRunner,
  createScriptCommandRoundRunner
} from "../src/single-shot-mechanism.js";

const tempRoots: string[] = [];

afterEach(() => {
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

  it("kills a timed-out script command process group", async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 2_500));
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
