import { afterEach, describe, expect, it } from "vitest";
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
  it("runs a one-shot live wrapper and captures the normalized result document", () => {
    const repoPath = makeTempDir();
    const artifactRoot = makeTempDir();
    const json = resultJson(runnerResult());
    const config: LiveWrapperConfig = {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.env.MOMENTUM_RESULT_PATH, process.env.RESULT_JSON)"
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
      env: { RESULT_JSON: json }
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
  });

  it("runs a script command with bounded logs and no result document", () => {
    const artifactRoot = makeTempDir();
    const logPath = path.join(artifactRoot, "script.log");
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "printf 'script ok'"],
      cwd: artifactRoot,
      timeoutSec: 5
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

    expect(result).toEqual({
      outcome: { ok: true },
      evidence: { verificationStatus: "passed" }
    });
    expect(fs.readFileSync(logPath, "utf-8")).toContain("script ok");
  });

  it("maps non-zero script exits to command_failed", () => {
    const artifactRoot = makeTempDir();
    const mechanism = createScriptCommandRoundRunner({
      command: "/bin/sh",
      args: ["-c", "exit 7"],
      cwd: artifactRoot,
      timeoutSec: 5
    });

    expect(mechanism(round({ artifactRoot, executorFamily: "script" })).outcome).toEqual({
      ok: false,
      recoveryCode: "command_failed"
    });
  });
});
