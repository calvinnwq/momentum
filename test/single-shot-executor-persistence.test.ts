import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorInvocation,
  insertExecutorRound,
  loadExecutorRound,
  updateExecutorRound
} from "../src/core/executors/loop/persist.js";
import type { ExecutorInvocationRecord } from "../src/core/executors/loop/reducer.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";
import {
  planSingleShotRoundPersistence,
  planSingleShotRoundStart,
  resolveSingleShotRoundSelection,
  singleShotRoundId,
  type SingleShotExecutorFamily
} from "../src/core/executors/single-shot/executor.js";

// This is the integration twin of the pure projections in
// single-shot-executor.test.ts: it drives a single-shot round's start record and
// the terminal persistence plan through the *real* executor-loop persistence layer
// and round transition graph. It proves the per-round agent/model/input evidence
// frozen at start survives the result/verification/commit evidence written at the
// end (contract Round Schema), and — the family-specific crux — that an exit-code
// based `script` success still legally reaches `succeeded` through a bare capture
// even though it captured no result document (the graph forbids running ->
// succeeded directly).

const SHA = "a".repeat(40);
const ROUND_ID = singleShotRoundId("inv-1");

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-single-shot-persistence-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows.
function openRoundDb(family: SingleShotExecutorFamily): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)"
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`
  ).run();
  const invocation: ExecutorInvocationRecord = {
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: family,
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return db;
}

// `withAgent` resolves a concrete agent/model/effort (the one-shot family); the
// script family resolves the all-null floor.
function startRound(
  db: MomentumDb,
  family: SingleShotExecutorFamily,
  withAgent: boolean
): void {
  const selection = resolveSingleShotRoundSelection(
    withAgent
      ? {
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high"
          }
        }
      : {}
  );
  const record = planSingleShotRoundStart({
    roundId: ROUND_ID,
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    family,
    attempt: 1,
    selection,
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-0",
    logPaths: ["/artifacts/round-0/stdout.log"],
    startedAt: 1_000
  });
  insertExecutorRound(db, record, { now: 1_000 });
}

const ONE_SHOT_RESULT: RunnerResult = {
  success: true,
  summary: "ran the one-shot review pass",
  key_changes_made: ["approved the bounded change"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: true,
  commit: {
    type: "chore",
    scope: "single-shot",
    subject: "one-shot pass",
    body: "",
    breaking: false
  }
};

describe("single-shot round persistence — one-shot success round-trip", () => {
  it("freezes agent/model/input at start and adds result/verification/commit at the end", () => {
    const db = openRoundDb("one-shot");
    startRound(db, "one-shot", true);

    const plan = planSingleShotRoundPersistence({
      outcome: { ok: true },
      result: ONE_SHOT_RESULT,
      resultDigest: "sha256:result",
      evidence: {
        verificationStatus: "passed",
        commitSha: SHA,
        changedFiles: ["src/x.ts"]
      }
    });
    updateExecutorRound(db, ROUND_ID, plan.captureUpdate!, { now: 2_000 });
    const final = updateExecutorRound(db, ROUND_ID, plan.terminalUpdate, {
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
    expect(final.artifactRoot).toBe("/artifacts/round-0");
    expect(final.startedAt).toBe(1_000);

    // Result/verification/commit evidence written at the end.
    expect(final.summary).toBe("ran the one-shot review pass");
    expect(final.keyChanges).toEqual(["approved the bounded change"]);
    expect(final.resultDigest).toBe("sha256:result");
    expect(final.verificationStatus).toBe("passed");
    expect(final.commitSha).toBe(SHA);
    expect(final.changedFiles).toEqual(["src/x.ts"]);
    expect(final.recoveryCode).toBeNull();
    expect(final.humanGate).toBeNull();

    // The durable row matches the returned record.
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(final);
  });
});

describe("single-shot round persistence — script success round-trip", () => {
  it("reaches succeeded through a bare capture though the script captured no result document", () => {
    const db = openRoundDb("script");
    startRound(db, "script", false);

    const plan = planSingleShotRoundPersistence({
      outcome: { ok: true },
      evidence: { verificationStatus: "passed" }
    });
    // The bare capture is what makes the running -> capturing_result -> succeeded
    // path legal; without it the terminal update would attempt an illegal
    // running -> succeeded transition and updateExecutorRound would refuse it.
    expect(plan.captureUpdate).toEqual({ toState: "capturing_result" });
    updateExecutorRound(db, ROUND_ID, plan.captureUpdate!, { now: 2_000 });
    const final = updateExecutorRound(db, ROUND_ID, plan.terminalUpdate, {
      now: 3_000
    });

    expect(final.state).toBe("succeeded");
    expect(final.classification).toBe("complete");
    // The script family resolves no agent/model and captured no result document.
    expect(final.agentProvider).toBeNull();
    expect(final.model).toBeNull();
    expect(final.summary).toBeNull();
    expect(final.resultDigest).toBeNull();
    expect(final.verificationStatus).toBe("passed");

    expect(loadExecutorRound(db, ROUND_ID)).toEqual(final);
  });
});

describe("single-shot round persistence — execution failure round-trip", () => {
  it("routes a command failure from running straight to failed with the recovery code", () => {
    const db = openRoundDb("script");
    startRound(db, "script", false);

    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "command_failed" }
    });
    // A failed invocation captured nothing; the round transitions directly from
    // running to its terminal state.
    expect(plan.captureUpdate).toBeNull();
    const final = updateExecutorRound(db, ROUND_ID, plan.terminalUpdate, {
      now: 2_000
    });

    expect(final.state).toBe("failed");
    expect(final.classification).toBe("failed");
    expect(final.recoveryCode).toBe("command_failed");
    expect(final.humanGate).toBeNull();
    // Evidence frozen at start preserved; nothing was committed or verified.
    expect(final.inputDigest).toBe("sha256:input");
    expect(final.commitSha).toBeNull();
    expect(final.verificationStatus).toBeNull();
  });
});

describe("single-shot round persistence — manual recovery round-trip", () => {
  it("routes an unsafe finalize from running to manual recovery with the gate and code", () => {
    const db = openRoundDb("one-shot");
    startRound(db, "one-shot", true);

    const plan = planSingleShotRoundPersistence({
      outcome: { ok: false, recoveryCode: "head_mismatch" }
    });
    expect(plan.captureUpdate).toBeNull();
    const final = updateExecutorRound(db, ROUND_ID, plan.terminalUpdate, {
      now: 2_000
    });

    expect(final.state).toBe("manual_recovery_required");
    expect(final.classification).toBe("manual_recovery_required");
    expect(final.recoveryCode).toBe("head_mismatch");
    expect(final.humanGate).toBe("manual_recovery_required");
    // The agent/model evidence frozen at start is still preserved on recovery.
    expect(final.agentProvider).toBe("claude");
    expect(final.inputDigest).toBe("sha256:input");
  });
});
