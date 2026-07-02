/**
 * RC-1 logs read-back migration parity.
 *
 * Goal-first `logs <goal-id>` is the legacy compatibility read-back surface; the
 * workflow-first equivalent is `workflow run logs <run-id>` (the per-round
 * executor evidence reader). Before goal-first read-back can ever be narrowed,
 * an operator must be able to migrate to the workflow-first command without
 * losing a read-back category, a refusal code, or the success/failure
 * text-routing contract.
 *
 * These are migration-parity proofs, not surface tests: each one runs *both*
 * commands and asserts the workflow-first surface drops nothing the goal-first
 * surface exposes. Because the two read different durable domains (goal-iteration
 * artifacts vs workflow executor rounds), the parity is contract-equivalent
 * (same observable categories / refusal contract / routing), not byte-equivalent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { initGoal } from "../src/core/goal/init.js";
import { executeIterationJob } from "../src/core/goal/iteration-job.js";
import { ingestEvidenceRecord } from "../src/core/evidence/records.js";
import {
  insertExecutorInvocation,
  insertExecutorRound
} from "../src/core/executors/loop/persist.js";
import type {
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/core/executors/loop/reducer.js";

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

function makeTempDir(prefix = "momentum-rc1-logs-parity-"): string {
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

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-rc1-logs-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
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
    changedFiles: ["src/example.ts"],
    verificationStatus: "passed",
    commitSha: "abc123",
    recoveryCode: null,
    humanGate: null
  };
}

/**
 * Seed, in one data dir, both a completed goal-first iteration and a
 * workflow-first run carrying equivalent durable read-back content, so an
 * operator could read either `logs <goalId>` or `workflow run logs <runId>`.
 */
function seedGoalAndWorkflow(): { dataDir: string; goalId: string; runId: string } {
  const repo = initRepo();
  const dataDir = makeTempDir("momentum-rc1-logs-data-");
  const specDir = makeTempDir("momentum-rc1-logs-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    `---
title: RC-1 logs parity target
repo: ${repo}
runner: fake
verification:
  - true
---
Apply the fixture file deterministically.
`,
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode: "queued"
  });
  if (!init.ok) throw new Error(`initGoal failed: ${init.error}`);

  const runId = "cwfp-logsparity01";
  const db: MomentumDb = openDb(dataDir);
  try {
    // Goal-first read-back content: run a real iteration so runner.log /
    // verification.log / result.json are populated, plus one evidence record.
    const job = executeIterationJob({
      db,
      goalId: init.goalId,
      jobId: init.jobId,
      spec: init.spec,
      artifactPaths: init.artifactPaths
    });
    if (!job.ok) throw new Error(`executeIterationJob failed: ${job.iteration.error}`);
    ingestEvidenceRecord(
      db,
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1700000010000,
        summary: "plan for goal read-back",
        ingestKey: `goal:${init.goalId}:plan`,
        goalId: init.goalId
      },
      { now: () => 1700000010500 }
    );

    // Workflow-first read-back content: a run with one terminal executor round
    // and one run-scoped evidence record.
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
    ingestEvidenceRecord(
      db,
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1700000020000,
        summary: "plan for run read-back",
        ingestKey: `run:${runId}:plan`,
        runId
      },
      { now: () => 1700000020500 }
    );
  } finally {
    db.close();
  }

  return { dataDir, goalId: init.goalId, runId };
}

describe("RC-1 logs read-back migration parity", () => {
  it(
    "workflow-first `run logs` exposes every read-back category goal-first `logs` does",
    async () => {
      const { dataDir, goalId, runId } = seedGoalAndWorkflow();

      const goal = await run(["logs", goalId, "--data-dir", dataDir, "--json"]);
      expect(goal.code).toBe(0);
      const goalPayload = JSON.parse(goal.stdout) as {
        ok: boolean;
        command: string;
        runnerLog: { exists: boolean; readable: boolean };
        verificationLog: { exists: boolean; readable: boolean };
        resultJson: { exists: boolean; parseError?: string };
        latestEvidence?: Array<{ summary: string }>;
      };

      const wf = await run([
        "workflow",
        "run",
        "logs",
        runId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(wf.code).toBe(0);
      const wfPayload = JSON.parse(wf.stdout) as {
        ok: boolean;
        command: string;
        rounds: Array<{
          logPaths: string[];
          verificationStatus: string | null;
          summary: string | null;
          commitSha: string | null;
          changedFiles: string[];
        }>;
        evidence: Array<{ summary: string }>;
      };

      // Both report success as a read-back command.
      expect(goalPayload.ok).toBe(true);
      expect(goalPayload.command).toBe("logs");
      expect(wfPayload.ok).toBe(true);
      expect(wfPayload.command).toBe("workflow run logs");

      const round = wfPayload.rounds[0]!;

      // Category 1 — "what ran": goal exposes a readable runner log; the
      // workflow-first round exposes its agent log path(s).
      expect(goalPayload.runnerLog.exists).toBe(true);
      expect(goalPayload.runnerLog.readable).toBe(true);
      expect(round.logPaths.length).toBeGreaterThan(0);

      // Category 2 — "verification outcome": goal exposes a readable
      // verification log; the workflow-first round exposes a typed verification
      // status.
      expect(goalPayload.verificationLog.exists).toBe(true);
      expect(round.verificationStatus).toBe("passed");

      // Category 3 — "produced result": goal exposes a parseable result.json
      // (summary + commit); the workflow-first round exposes summary + commit SHA
      // + the changed files those commits touched.
      expect(goalPayload.resultJson.exists).toBe(true);
      expect(goalPayload.resultJson.parseError).toBeUndefined();
      expect(round.summary).toBe("implemented the slice");
      expect(round.commitSha).toBe("abc123");
      expect(round.changedFiles).toEqual(["src/example.ts"]);

      // Category 4 — "evidence trail": both surface their linked evidence
      // records.
      expect((goalPayload.latestEvidence ?? []).length).toBeGreaterThan(0);
      expect(wfPayload.evidence.length).toBeGreaterThan(0);
    },
    15_000
  );

  it("both surfaces refuse an unknown id with a typed code on stderr and a non-zero exit", async () => {
    const dataDir = makeTempDir();

    const goal = await run([
      "logs",
      "missing-goal",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goal.code).toBe(1);
    expect(goal.stdout).toBe("");
    const goalErr = JSON.parse(goal.stderr) as Record<string, unknown>;
    expect(goalErr).toMatchObject({
      ok: false,
      command: "logs",
      code: "goal_not_found"
    });

    const wf = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(1);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_not_found"
    });
  });

  it("both surfaces refuse a missing id on stderr with a non-zero exit (no silent success)", async () => {
    const dataDir = makeTempDir();

    const goal = await run(["logs", "--data-dir", dataDir, "--json"]);
    expect(goal.code).not.toBe(0);
    expect(goal.stdout).toBe("");
    expect(goal.stderr.length).toBeGreaterThan(0);

    const wf = await run([
      "workflow",
      "run",
      "logs",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).not.toBe(0);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_id_required"
    });
  });

  it("both surfaces route successful text read-back to stdout", async () => {
    const { dataDir, goalId, runId } = seedGoalAndWorkflow();

    const goal = await run(["logs", goalId, "--data-dir", dataDir]);
    expect(goal.code).toBe(0);
    expect(goal.stdout.length).toBeGreaterThan(0);
    expect(goal.stderr).toBe("");

    const wf = await run([
      "workflow",
      "run",
      "logs",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(wf.code).toBe(0);
    expect(wf.stdout).toContain(`Workflow run logs: ${runId}`);
    expect(wf.stderr).toBe("");
  });
});
