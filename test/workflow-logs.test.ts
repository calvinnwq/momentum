import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound
} from "../src/core/executors/loop/persist.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/core/executors/loop/reducer.js";
import {
  WORKFLOW_RUN_LOGS_SCHEMA_VERSION,
  loadWorkflowRunLogs
} from "../src/core/workflow/run/logs.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openTempDb(): MomentumDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-workflow-logs-"));
  tempRoots.push(dir);
  return openDb(fs.realpathSync(dir));
}

function seedRun(db: MomentumDb, runId: string): void {
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
}

function makeInvocation(
  overrides: Partial<ExecutorInvocationRecord> = {}
): ExecutorInvocationRecord {
  return {
    invocationId: "inv-1",
    workflowRunId: "run-logs-1",
    stepRunId: "implementation",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 10,
    heartbeatAt: 10,
    finishedAt: null,
    ...overrides
  };
}

function makeRound(
  overrides: Partial<ExecutorRoundRecord> = {}
): ExecutorRoundRecord {
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-logs-1",
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
    artifactRoot: "/runs/run-logs-1/round-1",
    logPaths: ["/runs/run-logs-1/round-1/agent.log"],
    summary: "implemented the slice",
    keyChanges: ["added reader"],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: ["src/core/workflow/run/logs.ts"],
    verificationStatus: "passed",
    commitSha: "abc123",
    recoveryCode: null,
    humanGate: null,
    ...overrides
  };
}

function makeArtifact(
  overrides: Partial<ExecutorArtifactRecord> = {}
): ExecutorArtifactRecord {
  return {
    artifactId: "artifact-1",
    roundId: "round-1",
    artifactClass: "verification_output",
    path: "/runs/run-logs-1/round-1/verify.txt",
    digest: "sha256:verify",
    description: "verification output",
    ...overrides
  };
}

function makeCheckpoint(
  overrides: Partial<ExecutorCheckpointRecord> = {}
): ExecutorCheckpointRecord {
  return {
    checkpointId: "checkpoint-1",
    roundId: "round-1",
    sequence: 0,
    stage: "verify",
    detail: "pnpm test passed",
    ...overrides
  };
}

function makeFinding(
  overrides: Partial<ExecutorFindingRecord> = {}
): ExecutorFindingRecord {
  return {
    findingId: "finding-1",
    roundId: "round-1",
    severity: "warning",
    title: "missing evidence",
    detail: "round evidence was not attached",
    selected: true,
    externalRef: "nomistakes:F-1",
    ...overrides
  };
}

function makeDecision(
  overrides: Partial<ExecutorDecisionRecord> = {}
): ExecutorDecisionRecord {
  return {
    decisionId: "decision-1",
    roundId: "round-1",
    summary: "choose recovery path",
    allowedActions: ["retry", "hold"],
    recommendedAction: "retry",
    chosenAction: "retry",
    resolution: "delegated:within-envelope",
    externalRef: "nomistakes:D-1",
    ...overrides
  };
}

describe("loadWorkflowRunLogs", () => {
  it("returns null for an unknown run", () => {
    const db = openTempDb();
    try {
      expect(loadWorkflowRunLogs(db, "missing-run")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("composes run detail with the run's executor rounds and a stable schema", () => {
    const db = openTempDb();
    try {
      seedRun(db, "run-logs-1");
      insertExecutorInvocation(db, makeInvocation(), { now: 1 });
      insertExecutorRound(db, makeRound(), { now: 1 });

      const envelope = loadWorkflowRunLogs(db, "run-logs-1", {
        generatedAt: 999
      });
      expect(envelope).not.toBeNull();
      const value = envelope!;

      expect(value.schemaVersion).toBe(WORKFLOW_RUN_LOGS_SCHEMA_VERSION);
      expect(value.generatedAt).toBe(999);
      // The full run detail is reused verbatim (run / steps / evidence / monitor).
      expect(value.detail.run.runId).toBe("run-logs-1");
      expect(value.detail.steps.map((s) => s.stepId)).toEqual([
        "implementation"
      ]);

      // The genuine new value: per-round executor logs the run-detail loader
      // never carries (logs, summary, verification, commit, changed files).
      expect(value.rounds).toHaveLength(1);
      const round = value.rounds[0]!;
      expect(round.roundId).toBe("round-1");
      expect(round.summary).toBe("implemented the slice");
      expect(round.logPaths).toEqual([
        "/runs/run-logs-1/round-1/agent.log"
      ]);
      expect(round.verificationStatus).toBe("passed");
      expect(round.commitSha).toBe("abc123");
      expect(round.changedFiles).toEqual(["src/core/workflow/run/logs.ts"]);
    } finally {
      db.close();
    }
  });

  it("attaches durable child evidence to each executor round", () => {
    const db = openTempDb();
    try {
      seedRun(db, "run-logs-1");
      insertExecutorInvocation(db, makeInvocation(), { now: 1 });
      insertExecutorRound(db, makeRound(), { now: 1 });
      insertExecutorArtifact(db, makeArtifact(), { now: 5 });
      insertExecutorCheckpoint(db, makeCheckpoint(), { now: 3 });
      insertExecutorFinding(db, makeFinding(), { now: 7 });
      insertExecutorDecision(db, makeDecision(), { now: 9 });

      const envelope = loadWorkflowRunLogs(db, "run-logs-1", {
        generatedAt: 999
      });
      const round = envelope!.rounds[0]! as ExecutorRoundRecord & {
        artifacts?: ExecutorArtifactRecord[];
        checkpoints?: ExecutorCheckpointRecord[];
        findings?: ExecutorFindingRecord[];
        decisions?: ExecutorDecisionRecord[];
      };

      expect(round.artifacts).toEqual([makeArtifact()]);
      expect(round.checkpoints).toEqual([makeCheckpoint()]);
      expect(round.findings).toEqual([makeFinding()]);
      expect(round.decisions).toEqual([makeDecision()]);
    } finally {
      db.close();
    }
  });

  it("orders rounds across invocations by step key then attempt and round index", () => {
    const db = openTempDb();
    try {
      seedRun(db, "run-logs-1");
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
           VALUES ('run-logs-1', 'preflight', 'preflight', 'succeeded', 0, 1, 1, 1)`
      ).run();
      insertExecutorInvocation(db, makeInvocation(), { now: 1 });
      insertExecutorInvocation(
        db,
        makeInvocation({
          invocationId: "inv-2",
          stepRunId: "preflight",
          stepKey: "preflight"
        }),
        { now: 1 }
      );
      insertExecutorRound(db, makeRound({ roundId: "impl-b", roundIndex: 1 }), {
        now: 1
      });
      insertExecutorRound(db, makeRound({ roundId: "impl-a", roundIndex: 0 }), {
        now: 1
      });
      insertExecutorRound(
        db,
        makeRound({
          roundId: "pre-a",
          roundIndex: 0,
          invocationId: "inv-2",
          stepRunId: "preflight",
          stepKey: "preflight"
        }),
        { now: 1 }
      );

      const envelope = loadWorkflowRunLogs(db, "run-logs-1", {
        generatedAt: 1
      });
      expect(envelope!.rounds.map((r) => r.roundId)).toEqual([
        "impl-a",
        "impl-b",
        "pre-a"
      ]);
    } finally {
      db.close();
    }
  });
});
