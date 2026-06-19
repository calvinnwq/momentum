import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound
} from "../src/core/executors/loop-persist.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/core/executors/loop-reducer.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-cli-workflow-run-logs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });
  return { code, stdout, stderr };
}

function makeInvocation(runId: string): ExecutorInvocationRecord {
  return {
    invocationId: "inv-1",
    workflowRunId: runId,
    stepRunId: "implementation",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 10,
    heartbeatAt: 10,
    finishedAt: null
  };
}

function makeRound(runId: string): ExecutorRoundRecord {
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: runId,
    stepRunId: "implementation",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    attempt: 1,
    roundIndex: 0,
    state: "succeeded",
    classification: "complete",
    startedAt: 20,
    heartbeatAt: 25,
    finishedAt: 30,
    agentProvider: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    inputDigest: "in-1",
    resultDigest: "res-1",
    artifactRoot: `/runs/${runId}/round-1`,
    logPaths: [`/runs/${runId}/round-1/agent.log`],
    summary: "implemented the slice",
    keyChanges: ["added reader"],
    remainingWork: [],
    changedFiles: ["src/core/workflow/logs.ts"],
    verificationStatus: "passed",
    commitSha: "abc123",
    recoveryCode: null,
    humanGate: null
  };
}

function makeArtifact(runId: string): ExecutorArtifactRecord {
  return {
    artifactId: "artifact-1",
    roundId: "round-1",
    artifactClass: "verification_output",
    path: `/runs/${runId}/round-1/verify.txt`,
    digest: "sha256:verify",
    description: "verification output"
  };
}

function makeCheckpoint(): ExecutorCheckpointRecord {
  return {
    checkpointId: "checkpoint-1",
    roundId: "round-1",
    sequence: 0,
    stage: "verify",
    detail: "pnpm test passed"
  };
}

function makeFinding(): ExecutorFindingRecord {
  return {
    findingId: "finding-1",
    roundId: "round-1",
    severity: "warning",
    title: "missing evidence",
    detail: "round evidence was not attached",
    selected: true,
    externalRef: "nomistakes:F-1"
  };
}

function makeDecision(): ExecutorDecisionRecord {
  return {
    decisionId: "decision-1",
    roundId: "round-1",
    summary: "choose recovery path",
    allowedActions: ["retry", "hold"],
    recommendedAction: "retry",
    chosenAction: "retry",
    resolution: "delegated:within-envelope",
    externalRef: "nomistakes:D-1"
  };
}

function seedRunWithRound(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
       VALUES (?, 'running', 'agent-workflow', '{}', 'logs read-back', '{}', '{}', 0, 1, 1)`
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'running', 1, 1, 1, 1)`
  ).run(runId);
  insertExecutorInvocation(db, makeInvocation(runId), { now: 1 });
  insertExecutorRound(db, makeRound(runId), { now: 1 });
  insertExecutorArtifact(db, makeArtifact(runId), { now: 5 });
  insertExecutorCheckpoint(db, makeCheckpoint(), { now: 3 });
  insertExecutorFinding(db, makeFinding(), { now: 7 });
  insertExecutorDecision(db, makeDecision(), { now: 9 });
}

describe("momentum workflow run logs", () => {
  it("advertises the command in top-level help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "momentum workflow run logs <run-id> [--data-dir <path>] [--json]"
    );
    expect(result.stderr).toBe("");
  });

  it("requires <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_id_required"
    });
  });

  it("returns run_not_found for an unknown run-id", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_not_found",
      runId: "cwfp-missing"
    });
  });

  it("rejects an unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-x",
      "extra",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for workflow run logs: extra"
    );
  });

  it("emits a machine-readable logs envelope with run, steps, and executor rounds", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithRound(db, "cwfp-logs01");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-logs01",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      schemaVersion: number;
      generatedAt: number;
      run: { runId: string; state: string };
      steps: Array<{ stepId: string }>;
      rounds: Array<{
        roundId: string;
        summary: string | null;
        verificationStatus: string | null;
        commitSha: string | null;
        logPaths: string[];
        changedFiles: string[];
        artifacts: ExecutorArtifactRecord[];
        checkpoints: ExecutorCheckpointRecord[];
        findings: ExecutorFindingRecord[];
        decisions: ExecutorDecisionRecord[];
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow run logs");
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.generatedAt).toBe("number");
    expect(payload.run.runId).toBe("cwfp-logs01");
    expect(payload.steps.map((s) => s.stepId)).toEqual(["implementation"]);
    expect(payload.rounds).toHaveLength(1);
    const round = payload.rounds[0]!;
    expect(round.roundId).toBe("round-1");
    expect(round.summary).toBe("implemented the slice");
    expect(round.verificationStatus).toBe("passed");
    expect(round.commitSha).toBe("abc123");
    expect(round.logPaths).toEqual(["/runs/cwfp-logs01/round-1/agent.log"]);
    expect(round.changedFiles).toEqual(["src/core/workflow/logs.ts"]);
    expect(round.artifacts).toEqual([makeArtifact("cwfp-logs01")]);
    expect(round.checkpoints).toEqual([makeCheckpoint()]);
    expect(round.findings).toEqual([makeFinding()]);
    expect(round.decisions).toEqual([makeDecision()]);
  });

  it("renders text output with schema version and round log lines", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithRound(db, "cwfp-logs-text");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-logs-text",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workflow run logs: cwfp-logs-text");
    expect(result.stdout).toContain("Schema version: 1");
    expect(result.stdout).toContain("round-1");
    expect(result.stdout).toContain("implemented the slice");
  });
});
