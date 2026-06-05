import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  insertExecutorInvocation,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  loadExecutorRound
} from "../src/executor-loop-persist.js";
import type { ExecutorInvocationRecord } from "../src/executor-loop-reducer.js";
import type { RunnerResult } from "../src/runner-result.js";
import {
  resolveSingleShotRoundSelection,
  singleShotInvocationId,
  singleShotRoundId,
  type PlanSingleShotRoundStartInput,
  type SingleShotExecutorFamily,
  type SingleShotRoundRuntimeInputs
} from "../src/single-shot-executor.js";
import {
  runSingleShotRound,
  runSingleShotStep
} from "../src/single-shot-orchestrator.js";

// Drives the single-shot executor step (one-shot / script families) through the
// *real* executor-loop persistence layer and round transition graph around an
// injected bounded mechanism. Unlike the goal-loop driver there is no loop — a
// single shot owns exactly one round — so the entrypoint inserts the invocation,
// drives the one round, and settles the invocation directly into the round
// decision's terminal state. Proves: the per-round agent/model/input evidence
// frozen at start composes with the result/verification/commit evidence persisted
// at the end; a *script* success reaches `succeeded` through a bare capture (no
// result document) yet omits the `result_captured` checkpoint; and the
// blocked / manual-recovery boundaries hold end to end.

const SHA_A = "a".repeat(40);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-single-shot-orch-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows + an
// invocation; the driver itself inserts the round.
function openRoundDb(family: SingleShotExecutorFamily = "one-shot"): MomentumDb {
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

// Only the parent workflow rows — runSingleShotStep inserts the invocation itself.
function openStepDb(): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)"
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`
  ).run();
  return db;
}

function buildStart(
  family: SingleShotExecutorFamily = "one-shot"
): PlanSingleShotRoundStartInput {
  // one-shot resolves a concrete agent; the exit-code-based script family has no
  // agent, so its selection is naturally all-null.
  const selection =
    family === "one-shot"
      ? resolveSingleShotRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high"
          }
        })
      : resolveSingleShotRoundSelection({});
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    family,
    attempt: 1,
    selection,
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-1",
    logPaths: ["/artifacts/round-1/stdout.log"],
    startedAt: 1_000
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "ran the single shot",
    key_changes_made: ["added the single-shot driver"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: true,
    commit: {
      type: "feat",
      scope: "single-shot",
      subject: "drive the single shot",
      body: "",
      breaking: false
    },
    ...overrides
  };
}

// A monotonic clock for deterministic timestamps: returns start, start+step, ...
function monotonicClock(start = 1_000, step = 100): () => number {
  let n = start - step;
  return () => (n += step);
}

function roundInputs(): SingleShotRoundRuntimeInputs {
  return {
    inputDigest: "sha256:input-0",
    artifactRoot: "/artifacts/single-shot",
    logPaths: ["/artifacts/single-shot/stdout.log"]
  };
}

describe("runSingleShotRound — one-shot success", () => {
  it("inserts a running round, captures the result, and persists a complete terminal round", () => {
    const db = openRoundDb("one-shot");
    let observedState: string | undefined;
    const outcome = runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: (round) => {
        observedState = round.state;
        return {
          outcome: { ok: true },
          result: runnerResult(),
          resultDigest: "sha256:result",
          artifacts: {
            resultDocument: { path: "/artifacts/round-1/result.json" },
            verificationOutput: { path: "/artifacts/round-1/verify.log" },
            commitOrResetEvidence: { path: "/artifacts/round-1/commit.txt" }
          },
          evidence: {
            verificationStatus: "passed",
            commitSha: SHA_A,
            changedFiles: ["src/single-shot-orchestrator.ts"]
          }
        };
      }
    });

    // The mechanism saw the durable round-start row (running, frozen selection).
    expect(observedState).toBe("running");

    // Terminal classification + persisted result / repo-safety evidence.
    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.round.classification).toBe("complete");
    expect(outcome.decision.invocationState).toBe("succeeded");
    expect(outcome.round.summary).toBe("ran the single shot");
    expect(outcome.round.keyChanges).toEqual(["added the single-shot driver"]);
    expect(outcome.round.resultDigest).toBe("sha256:result");
    expect(outcome.round.verificationStatus).toBe("passed");
    expect(outcome.round.commitSha).toBe(SHA_A);
    expect(outcome.round.changedFiles).toEqual([
      "src/single-shot-orchestrator.ts"
    ]);
    expect(outcome.round.recoveryCode).toBeNull();
    expect(outcome.round.humanGate).toBeNull();

    // Agent/model/input frozen at start survive the terminal updates.
    expect(outcome.round.agentProvider).toBe("claude");
    expect(outcome.round.model).toBe("claude-opus-4-8");
    expect(outcome.round.inputDigest).toBe("sha256:input");
    expect(outcome.round.startedAt).toBe(1_000);

    // The terminal clock stamps finishedAt + heartbeatAt (the pure projection cannot).
    expect(outcome.round.finishedAt).toBe(3_000);
    expect(outcome.round.heartbeatAt).toBe(3_000);

    // The durable row equals the returned round.
    expect(loadExecutorRound(db, "round-1")).toEqual(outcome.round);
  });

  it("inserts the round before the mechanism runs", () => {
    const db = openRoundDb("one-shot");
    let stateDuringMechanism: string | undefined;
    runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => {
        stateDuringMechanism = loadExecutorRound(db, "round-1")?.state;
        return { outcome: { ok: true }, result: runnerResult() };
      }
    });
    expect(stateDuringMechanism).toBe("running");
  });

  it("persists the round's logs (from frozen logPaths) + reported artifact pointers", () => {
    const db = openRoundDb("one-shot");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: true },
        result: runnerResult(),
        artifacts: {
          resultDocument: { path: "/artifacts/round-1/result.json" },
          verificationOutput: { path: "/artifacts/round-1/verify.log" }
        }
      })
    });

    // The returned artifacts preserve contract order: result_document, the frozen
    // logs, then verification_output.
    expect(outcome.artifacts.map((a) => a.artifactClass)).toEqual([
      "result_document",
      "logs",
      "verification_output"
    ]);
    // The `logs` row is derived from the round-start record's frozen logPaths, not
    // from the mechanism's reported pointers.
    expect(outcome.artifacts.find((a) => a.artifactClass === "logs")?.path).toBe(
      "/artifacts/round-1/stdout.log"
    );

    // All three rows are durable below the round (the DB query orders by id).
    const durable = listExecutorArtifactsForRound(db, "round-1");
    expect(durable).toEqual(
      [...outcome.artifacts].sort((a, b) =>
        a.artifactId.localeCompare(b.artifactId)
      )
    );
  });

  it("keeps log artifacts aligned with the inserted round when the runner mutates its input", () => {
    const db = openRoundDb("one-shot");
    runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: (round) => {
        round.logPaths.push("/artifacts/round-1/mutated.log");
        return { outcome: { ok: true }, result: runnerResult() };
      }
    });

    expect(loadExecutorRound(db, "round-1")?.logPaths).toEqual([
      "/artifacts/round-1/stdout.log"
    ]);
    expect(
      listExecutorArtifactsForRound(db, "round-1")
        .filter((a) => a.artifactClass === "logs")
        .map((a) => a.path)
    ).toEqual(["/artifacts/round-1/stdout.log"]);
  });

  it("persists the one-shot lifecycle checkpoint stream including result_captured", () => {
    const db = openRoundDb("one-shot");
    runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() })
    });

    const checkpoints = listExecutorCheckpointsForRound(db, "round-1");
    expect(checkpoints.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "result_captured",
      "classified"
    ]);
  });
});

describe("runSingleShotRound — script success (bare capture)", () => {
  it("reaches succeeded through a bare capture with no result document and omits result_captured", () => {
    const db = openRoundDb("script");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("script"),
      finishedAt: 3_000,
      // The exit-code-based script family succeeds with no result document.
      runRound: () => ({
        outcome: { ok: true },
        evidence: { verificationStatus: "passed", commitSha: SHA_A }
      })
    });

    // running -> succeeded is illegal directly; a bare capture is what makes the
    // script success legal, so it still terminalizes succeeded.
    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.round.classification).toBe("complete");
    // No result document was captured, so the normalized result fields stay null.
    expect(outcome.round.summary).toBeNull();
    expect(outcome.round.resultDigest).toBeNull();
    // The commit evidence the script reported is still persisted.
    expect(outcome.round.commitSha).toBe(SHA_A);
    expect(outcome.round.verificationStatus).toBe("passed");

    // The checkpoint stream omits result_captured (no result document).
    const checkpoints = listExecutorCheckpointsForRound(db, "round-1");
    expect(checkpoints.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "classified"
    ]);
  });
});

describe("runSingleShotRound — family output invariants", () => {
  it("rejects a successful one-shot mechanism output without a result document", () => {
    const db = openRoundDb("one-shot");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        runRound: () => ({ outcome: { ok: true } })
      })
    ).toThrow("one-shot");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });

  it("rejects a successful script mechanism output with a result document", () => {
    const db = openRoundDb("script");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("script"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          result: runnerResult()
        })
      })
    ).toThrow("script");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });

  it("rejects a script mechanism output with a result-document artifact", () => {
    const db = openRoundDb("script");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("script"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          artifacts: {
            resultDocument: { path: "/artifacts/round-1/result.json" }
          }
        })
      })
    ).toThrow("result document artifact");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });

  it("rejects a failed script mechanism output with result evidence", () => {
    const db = openRoundDb("script");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("script"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: false, recoveryCode: "command_failed" },
          result: runnerResult(),
          artifacts: {
            resultDocument: { path: "/artifacts/round-1/result.json" }
          }
        })
      })
    ).toThrow("script");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });

  it("rejects a successful one-shot mechanism output with a failed runner result", () => {
    const db = openRoundDb("one-shot");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          result: runnerResult({ success: false })
        })
      })
    ).toThrow("successful one-shot");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });

  it("validates terminal evidence before writing artifact rows", () => {
    const db = openRoundDb("script");

    expect(() =>
      runSingleShotRound({
        db,
        start: buildStart("script"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          artifacts: {
            verificationOutput: { path: "/artifacts/round-1/verify.log" }
          },
          evidence: { changedFiles: ["src/single-shot-orchestrator.ts"] }
        })
      })
    ).toThrow("changedFiles requires commitSha");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([]);
  });
});

describe("runSingleShotRound — failure / blocked / manual recovery", () => {
  it("routes a command_failed outcome to a failed terminal with no capture", () => {
    const db = openRoundDb("script");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("script"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" }
      })
    });

    expect(outcome.round.state).toBe("failed");
    expect(outcome.round.classification).toBe("failed");
    expect(outcome.round.recoveryCode).toBe("command_failed");
    expect(outcome.round.summary).toBeNull();
    expect(outcome.round.humanGate).toBeNull();
    // A failed round captured no result, so result_captured is omitted.
    expect(
      listExecutorCheckpointsForRound(db, "round-1").map((c) => c.stage)
    ).toEqual(["round_started", "mechanism_completed", "classified"]);
  });

  it("does not checkpoint result capture when a failed mechanism reports a result", () => {
    const db = openRoundDb("one-shot");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" },
        result: runnerResult()
      })
    });

    expect(outcome.round.state).toBe("failed");
    expect(outcome.round.summary).toBeNull();
    expect(
      listExecutorCheckpointsForRound(db, "round-1").map((c) => c.stage)
    ).toEqual(["round_started", "mechanism_completed", "classified"]);
  });

  it("routes an auth_unavailable outcome to a blocked terminal with a credential gate", () => {
    const db = openRoundDb("one-shot");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "auth_unavailable" }
      })
    });

    expect(outcome.round.state).toBe("blocked");
    expect(outcome.round.classification).toBe("blocked");
    expect(outcome.round.recoveryCode).toBe("auth_unavailable");
    expect(outcome.round.humanGate).toBe("credential_required");
  });

  it("routes a head_mismatch finalize outcome to manual recovery", () => {
    const db = openRoundDb("one-shot");
    const outcome = runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "head_mismatch" }
      })
    });

    expect(outcome.round.state).toBe("manual_recovery_required");
    expect(outcome.round.classification).toBe("manual_recovery_required");
    expect(outcome.round.recoveryCode).toBe("head_mismatch");
    expect(outcome.round.humanGate).toBe("manual_recovery_required");
  });
});

describe("runSingleShotStep — invocation/round materialization", () => {
  it("materializes a one-shot invocation + single round and drives to a terminal success", () => {
    const db = openStepDb();
    const result = runSingleShotStep({
      db,
      family: "one-shot",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({
        stepConfig: {
          agentProvider: "claude",
          model: "claude-opus-4-8",
          effort: "high"
        }
      }),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() })
    });

    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1
    );
    expect(result.invocation.invocationId).toBe(invocationId);
    expect(result.invocation.executorFamily).toBe("one-shot");
    expect(result.invocation.state).toBe("succeeded");
    expect(result.invocation.finishedAt).not.toBeNull();
    expect(loadExecutorInvocation(db, invocationId)).toEqual(result.invocation);

    // The single round is materialized below the invocation with the deterministic id.
    expect(result.round.round.roundId).toBe(singleShotRoundId(invocationId));
    expect(result.round.round.roundIndex).toBe(0);
    const durableRounds = listExecutorRoundsForInvocation(db, invocationId);
    expect(durableRounds.map((r) => r.roundId)).toEqual([
      singleShotRoundId(invocationId)
    ]);

    // Selection frozen + runtime inputs threaded + clock stamped.
    expect(result.round.round.agentProvider).toBe("claude");
    expect(result.round.round.inputDigest).toBe("sha256:input-0");
    expect(result.round.round.artifactRoot).toBe("/artifacts/single-shot");
    expect(result.invocation.startedAt).toBe(1_000);
    expect(result.round.round.startedAt).toBe(1_100);
    expect(result.round.round.finishedAt).toBe(1_200);
  });

  it("materializes a script invocation and reaches a terminal success", () => {
    const db = openStepDb();
    const result = runSingleShotStep({
      db,
      family: "script",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({ outcome: { ok: true } })
    });

    const invocationId = singleShotInvocationId("run-1", "step-1", "script", 1);
    expect(result.invocation.invocationId).toBe(invocationId);
    expect(result.invocation.executorFamily).toBe("script");
    expect(result.invocation.state).toBe("succeeded");
    expect(result.round.round.executorFamily).toBe("script");
  });

  it("inserts the materialized invocation before the round runs", () => {
    const db = openStepDb();
    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1
    );
    let stateDuringRound: string | undefined;
    runSingleShotStep({
      db,
      family: "one-shot",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => {
        stateDuringRound = loadExecutorInvocation(db, invocationId)?.state;
        return { outcome: { ok: true }, result: runnerResult() };
      }
    });
    expect(stateDuringRound).toBe("running");
  });

  it("routes a failing round to a terminal failed invocation", () => {
    const db = openStepDb();
    const result = runSingleShotStep({
      db,
      family: "script",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" }
      })
    });

    expect(result.round.round.state).toBe("failed");
    expect(result.invocation.state).toBe("failed");
    expect(result.invocation.finishedAt).not.toBeNull();
  });

  it("settles an auth_unavailable round into a terminal blocked invocation", () => {
    const db = openStepDb();
    const result = runSingleShotStep({
      db,
      family: "one-shot",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "auth_unavailable" }
      })
    });

    expect(result.round.round.state).toBe("blocked");
    expect(result.invocation.state).toBe("blocked");
    // `blocked` is a terminal invocation state, so finished_at is stamped.
    expect(result.invocation.finishedAt).not.toBeNull();
  });
});
