import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorAttempt,
  insertExecutorRound,
  loadExecutorRound,
  updateExecutorRound
} from "../src/core/executors/loop/persist.js";
import type { ExecutorAttemptRecord } from "../src/core/executors/loop/reducer.js";
import {
  planGoalLoopRoundPersistence,
  planGoalLoopRoundStart,
  resolveGoalLoopRoundSelection
} from "../src/core/executors/goal-loop/executor.js";
import type { FinalizeWorkflowStepFromResultFileResult } from "../src/core/executors/shared/step-finalize.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";

// This is the integration twin of the pure projections in
// goal-loop-executor.test.ts: it drives a goal-loop round's start record and the
// terminal persistence plan through the *real* executor-loop persistence layer
// and round transition graph, proving the per-round agent/model/input evidence
// frozen at start survives the result/verification/commit evidence written at the
// end (contract Round Schema), and that the manual-recovery boundary persists.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-goal-loop-persistence-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows.
function openRoundDb(): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)"
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`
  ).run();
  const invocation: ExecutorAttemptRecord = {
    attemptId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null
  };
  insertExecutorAttempt(db, invocation, { now: 1 });
  return db;
}

function startRound(db: MomentumDb): void {
  const selection = resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      maxRounds: 5
    }
  });
  const record = planGoalLoopRoundStart({
    roundId: "round-1",
    attemptId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    attempt: 1,
    roundIndex: 0,
    selection,
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-1",
    logPaths: ["/artifacts/round-1/stdout.log"],
    startedAt: 1_000
  });
  insertExecutorRound(db, record, { now: 1_000 });
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "implemented the bounded round",
    key_changes_made: ["added the round-start projection"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: true,
    commit: {
      type: "feat",
      scope: "goal-loop",
      subject: "project round start",
      body: "",
      breaking: false
    },
    ...overrides
  };
}

const COMMITTED: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "committed",
  verification: {
    ok: true,
    results: [
      {
        command: "pnpm test",
        exit_code: 0,
        signal: null,
        duration_ms: 12,
        timed_out: false,
        succeeded: true
      }
    ]
  },
  commit: {
    ok: true,
    commitSha: SHA_A,
    parentSha: SHA_B,
    message: "feat(goal-loop): project round start"
  },
  head: SHA_A
};

const RESULT_MISSING: FinalizeWorkflowStepFromResultFileResult = {
  outcome: "result_missing",
  resultFilePath: "/tmp/result.json",
  error: "result file not found"
};

describe("goal-loop round persistence — committed completion round-trip", () => {
  it("freezes agent/model/input at start and adds result/verification/commit at the end", () => {
    const db = openRoundDb();
    startRound(db);

    const plan = planGoalLoopRoundPersistence({
      result: runnerResult(),
      finalize: COMMITTED,
      roundIndex: 0,
      maxRounds: 5
    });
    updateExecutorRound(db, "round-1", plan.captureUpdate!, { now: 2_000 });
    const final = updateExecutorRound(db, "round-1", plan.terminalUpdate, {
      now: 3_000
    });

    // Terminal classification and lifecycle.
    expect(final.state).toBe("succeeded");
    expect(final.classification).toBe("complete");

    // Agent/model/input evidence frozen at start survives the terminal updates.
    expect(final.agentProvider).toBe("claude");
    expect(final.model).toBe("claude-opus-4-8");
    expect(final.effort).toBe("high");
    expect(final.inputDigest).toBe("sha256:input");
    expect(final.artifactRoot).toBe("/artifacts/round-1");
    expect(final.startedAt).toBe(1_000);

    // Result/verification/commit evidence written at the end.
    expect(final.summary).toBe("implemented the bounded round");
    expect(final.keyChanges).toEqual(["added the round-start projection"]);
    expect(final.verificationStatus).toBe("passed");
    expect(final.commitSha).toBe(SHA_A);
    expect(final.recoveryCode).toBeNull();
    expect(final.humanGate).toBeNull();

    // The durable row matches the returned record.
    expect(loadExecutorRound(db, "round-1")).toEqual(final);
  });
});

describe("goal-loop round persistence — manual recovery boundary", () => {
  it("routes a missing-result round from running straight to manual recovery", () => {
    const db = openRoundDb();
    startRound(db);

    const plan = planGoalLoopRoundPersistence({
      result: null,
      finalize: RESULT_MISSING,
      roundIndex: 0,
      maxRounds: 5
    });
    // A missing result has nothing to capture; the round transitions directly
    // from running to manual recovery.
    expect(plan.captureUpdate).toBeNull();
    const final = updateExecutorRound(db, "round-1", plan.terminalUpdate, {
      now: 2_000
    });

    expect(final.state).toBe("manual_recovery_required");
    expect(final.classification).toBe("manual_recovery_required");
    expect(final.recoveryCode).toBe("result_missing");
    expect(final.humanGate).toBe("manual_recovery_required");
    // The agent/model evidence frozen at start is still preserved on recovery.
    expect(final.agentProvider).toBe("claude");
    expect(final.inputDigest).toBe("sha256:input");
    // No commit, no verification ran.
    expect(final.commitSha).toBeNull();
    expect(final.verificationStatus).toBeNull();
  });
});
