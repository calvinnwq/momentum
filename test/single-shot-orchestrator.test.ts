import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  ExecutorInvocationConflictError,
  insertExecutorCheckpoint,
  insertExecutorInvocation,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  loadExecutorRound,
} from "../src/core/executors/loop/persist.js";
import type { ExecutorInvocationRecord } from "../src/core/executors/loop/reducer.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";
import {
  resolveSingleShotRoundSelection,
  singleShotInvocationId,
  singleShotRoundId,
  type PlanSingleShotRoundStartInput,
  type SingleShotExecutorFamily,
  type SingleShotRoundRuntimeInputs,
} from "../src/core/executors/single-shot/executor.js";
import {
  runSingleShotRound,
  runSingleShotStep,
} from "../src/core/executors/single-shot/orchestrator.js";

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
    path.join(os.tmpdir(), "momentum-single-shot-orch-"),
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows + an
// invocation; the driver itself inserts the round.
function openRoundDb(
  family: SingleShotExecutorFamily = "one-shot",
): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`,
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
    finishedAt: null,
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return db;
}

// Only the parent workflow rows — runSingleShotStep inserts the invocation itself.
function openStepDb(): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`,
  ).run();
  return db;
}

function buildStart(
  family: SingleShotExecutorFamily = "one-shot",
): PlanSingleShotRoundStartInput {
  // one-shot resolves a concrete agent; the exit-code-based script family has no
  // agent, so its selection is naturally all-null.
  const selection =
    family === "one-shot"
      ? resolveSingleShotRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high",
          },
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
    startedAt: 1_000,
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
      breaking: false,
    },
    ...overrides,
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
    logPaths: ["/artifacts/single-shot/stdout.log"],
  };
}

function expectDurableDispatchBinding(db: MomentumDb): void {
  expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([
    {
      checkpointId: "round-1-checkpoint-0",
      roundId: "round-1",
      sequence: 0,
      stage: "round_started",
      detail: expect.stringMatching(/^dispatch binding: sha256:[a-f0-9]{64}$/),
    },
  ]);
}

describe("runSingleShotRound — one-shot success", () => {
  it("inserts a running round, captures the result, and persists a complete terminal round", async () => {
    const db = openRoundDb("one-shot");
    let observedState: string | undefined;
    const outcome = await runSingleShotRound({
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
            commitOrResetEvidence: { path: "/artifacts/round-1/commit.txt" },
          },
          evidence: {
            verificationStatus: "passed",
            commitSha: SHA_A,
            changedFiles: ["src/single-shot-orchestrator.ts"],
          },
        };
      },
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
      "src/single-shot-orchestrator.ts",
    ]);
    expect(outcome.round.recoveryCode).toBeNull();
    expect(outcome.round.humanGate).toBeNull();

    // Agent/model/input frozen at start survive the terminal updates.
    expect(outcome.round.agentProvider).toBe("claude");
    expect(outcome.round.model).toBe("claude-opus-4-8");
    expect(outcome.round.inputDigest).toBe("sha256:input");
    expect(outcome.round.startedAt).toBe(3_000);

    // The terminal clock stamps finishedAt + heartbeatAt (the pure projection cannot).
    expect(outcome.round.finishedAt).toBe(3_000);
    expect(outcome.round.heartbeatAt).toBe(3_000);

    // The durable row equals the returned round.
    expect(loadExecutorRound(db, "round-1")).toEqual(outcome.round);
  });

  it("stamps terminal state after asynchronous bounded work finishes", async () => {
    const db = openRoundDb("one-shot");
    let clock = 1_500;
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      now: () => clock,
      runRound: async () => {
        await Promise.resolve();
        clock = 5_000;
        return { outcome: { ok: true }, result: runnerResult() };
      },
    });

    expect(outcome.round.startedAt).toBe(1_500);
    expect(outcome.round.finishedAt).toBe(5_000);
    expect(outcome.round.heartbeatAt).toBe(5_000);
    expect(outcome.invocation.finishedAt).toBe(5_000);
  });

  it("atomically settles an in-flight aborted runner as cancelled", async () => {
    const db = openRoundDb("one-shot");
    const abort = new AbortController();

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        signal: abort.signal,
        runRound: async () => {
          abort.abort();
          await Promise.resolve();
          throw abort.signal.reason;
        },
      }),
    ).rejects.toThrow(/aborted/i);

    expect(loadExecutorInvocation(db, "inv-1")).toMatchObject({
      state: "cancelled",
      finishedAt: 3_000,
    });
    expect(loadExecutorRound(db, "round-1")).toMatchObject({
      state: "cancelled",
      classification: "cancelled",
      executorRecommendation: null,
      finishedAt: 3_000,
    });
    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([
      {
        checkpointId: "round-1-checkpoint-0",
        roundId: "round-1",
        sequence: 0,
        stage: "round_started",
        detail: expect.stringMatching(
          /^dispatch binding: sha256:[a-f0-9]{64}$/,
        ),
      },
      {
        checkpointId: "round-1-checkpoint-1",
        roundId: "round-1",
        sequence: 1,
        stage: "classified",
        detail: "classification: cancelled",
      },
    ]);
  });

  it("lets normal runner completion win a post-run abort race", async () => {
    const db = openRoundDb("one-shot");
    const abort = new AbortController();

    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      signal: abort.signal,
      runRound: () => {
        abort.abort();
        return { outcome: { ok: true }, result: runnerResult() };
      },
    });

    expect(outcome.invocation.state).toBe("succeeded");
    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.round.classification).toBe("complete");
  });

  it("materializes and settles a pre-aborted direct round as cancelled", async () => {
    const db = openRoundDb("one-shot");
    const abort = new AbortController();
    abort.abort();
    let ran = false;

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        signal: abort.signal,
        runRound: () => {
          ran = true;
          return { outcome: { ok: true }, result: runnerResult() };
        },
      }),
    ).rejects.toThrow(/aborted/i);

    expect(ran).toBe(false);
    expect(loadExecutorInvocation(db, "inv-1")?.state).toBe("cancelled");
    expect(loadExecutorRound(db, "round-1")).toMatchObject({
      state: "cancelled",
      classification: "cancelled",
    });
  });

  it("allocates cancellation classification after existing checkpoints", async () => {
    const db = openRoundDb("one-shot");
    const abort = new AbortController();

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        signal: abort.signal,
        runRound: (round) => {
          insertExecutorCheckpoint(
            db,
            {
              checkpointId: "round-1-cleanup-started",
              roundId: round.roundId,
              sequence: 1,
              stage: "cleanup_started",
              detail: "existing durable progress",
            },
            { now: 2_500 },
          );
          abort.abort();
          throw abort.signal.reason;
        },
      }),
    ).rejects.toThrow(/aborted/i);

    expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([
      {
        checkpointId: "round-1-checkpoint-0",
        roundId: "round-1",
        sequence: 0,
        stage: "round_started",
        detail: expect.stringMatching(
          /^dispatch binding: sha256:[a-f0-9]{64}$/,
        ),
      },
      {
        checkpointId: "round-1-cleanup-started",
        roundId: "round-1",
        sequence: 1,
        stage: "cleanup_started",
        detail: "existing durable progress",
      },
      {
        checkpointId: "round-1-checkpoint-2",
        roundId: "round-1",
        sequence: 2,
        stage: "classified",
        detail: "classification: cancelled",
      },
    ]);
    expect(loadExecutorRound(db, "round-1")).toMatchObject({
      state: "cancelled",
      classification: "cancelled",
    });
  });

  it("does not terminalize cancellation when an aborted runner reports cleanup failure", async () => {
    const db = openRoundDb("one-shot");
    const abort = new AbortController();

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        signal: abort.signal,
        runRound: async () => {
          abort.abort();
          throw new Error("repository cleanup failed");
        },
      }),
    ).rejects.toThrow("repository cleanup failed");

    expect(loadExecutorInvocation(db, "inv-1")).toMatchObject({
      state: "running",
      finishedAt: null,
    });
    expect(loadExecutorRound(db, "round-1")).toMatchObject({
      state: "running",
      classification: null,
      finishedAt: null,
    });
    expectDurableDispatchBinding(db);
  });

  it("persists the round and dispatch binding before the mechanism runs", async () => {
    const db = openRoundDb("one-shot");
    let stateDuringMechanism: string | undefined;
    let checkpointsDuringMechanism: ReturnType<
      typeof listExecutorCheckpointsForRound
    > = [];
    await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => {
        stateDuringMechanism = loadExecutorRound(db, "round-1")?.state;
        checkpointsDuringMechanism = listExecutorCheckpointsForRound(
          db,
          "round-1",
        );
        return { outcome: { ok: true }, result: runnerResult() };
      },
    });
    expect(stateDuringMechanism).toBe("running");
    expect(checkpointsDuringMechanism).toEqual([
      {
        checkpointId: "round-1-checkpoint-0",
        roundId: "round-1",
        sequence: 0,
        stage: "round_started",
        detail: expect.stringMatching(
          /^dispatch binding: sha256:[a-f0-9]{64}$/,
        ),
      },
    ]);
  });

  it("persists the round's logs (from frozen logPaths) + reported artifact pointers", async () => {
    const db = openRoundDb("one-shot");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: true },
        result: runnerResult(),
        artifacts: {
          resultDocument: { path: "/artifacts/round-1/result.json" },
          verificationOutput: { path: "/artifacts/round-1/verify.log" },
        },
      }),
    });

    // The returned artifacts preserve contract order: result_document, the frozen
    // logs, then verification_output.
    expect(outcome.artifacts.map((a) => a.artifactClass)).toEqual([
      "result_document",
      "logs",
      "verification_output",
    ]);
    // The `logs` row is derived from the round-start record's frozen logPaths, not
    // from the mechanism's reported pointers.
    expect(
      outcome.artifacts.find((a) => a.artifactClass === "logs")?.path,
    ).toBe("/artifacts/round-1/stdout.log");

    // All three rows are durable below the round (the DB query orders by id).
    const durable = listExecutorArtifactsForRound(db, "round-1");
    expect(durable).toEqual(
      [...outcome.artifacts].sort((a, b) =>
        a.artifactId.localeCompare(b.artifactId),
      ),
    );
  });

  it("keeps log artifacts aligned with the inserted round when the runner mutates its input", async () => {
    const db = openRoundDb("one-shot");
    await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: (round) => {
        round.logPaths.push("/artifacts/round-1/mutated.log");
        return { outcome: { ok: true }, result: runnerResult() };
      },
    });

    expect(loadExecutorRound(db, "round-1")?.logPaths).toEqual([
      "/artifacts/round-1/stdout.log",
    ]);
    expect(
      listExecutorArtifactsForRound(db, "round-1")
        .filter((a) => a.artifactClass === "logs")
        .map((a) => a.path),
    ).toEqual(["/artifacts/round-1/stdout.log"]);
  });

  it("persists the one-shot lifecycle checkpoint stream including result_captured", async () => {
    const db = openRoundDb("one-shot");
    await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
    });

    const checkpoints = listExecutorCheckpointsForRound(db, "round-1");
    expect(checkpoints.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "result_captured",
      "classified",
    ]);
  });
});

describe("runSingleShotRound — script success (bare capture)", () => {
  it("reaches succeeded through a bare capture with no result document and omits result_captured", async () => {
    const db = openRoundDb("script");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("script"),
      config: { command: "test-script" },
      finishedAt: 3_000,
      // The exit-code-based script family succeeds with no result document.
      runRound: () => ({
        outcome: { ok: true },
        evidence: { verificationStatus: "passed", commitSha: SHA_A },
      }),
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
      "classified",
    ]);
  });
});

describe("runSingleShotRound — family output invariants", () => {
  it("rejects a successful one-shot mechanism output without a result document", async () => {
    const db = openRoundDb("one-shot");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        runRound: () => ({ outcome: { ok: true } }),
      }),
    ).rejects.toThrow("one-shot");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });

  it("rejects a successful script mechanism output with a result document", async () => {
    const db = openRoundDb("script");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("script"),
        config: { command: "test-script" },
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          result: runnerResult(),
        }),
      }),
    ).rejects.toThrow("script");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });

  it("rejects a script mechanism output with a result-document artifact", async () => {
    const db = openRoundDb("script");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("script"),
        config: { command: "test-script" },
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          artifacts: {
            resultDocument: { path: "/artifacts/round-1/result.json" },
          },
        }),
      }),
    ).rejects.toThrow("result document artifact");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });

  it("rejects a failed script mechanism output with result evidence", async () => {
    const db = openRoundDb("script");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("script"),
        config: { command: "test-script" },
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: false, recoveryCode: "command_failed" },
          result: runnerResult(),
          artifacts: {
            resultDocument: { path: "/artifacts/round-1/result.json" },
          },
        }),
      }),
    ).rejects.toThrow("script");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });

  it("rejects a successful one-shot mechanism output with a failed runner result", async () => {
    const db = openRoundDb("one-shot");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("one-shot"),
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          result: runnerResult({ success: false }),
        }),
      }),
    ).rejects.toThrow("successful one-shot");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });

  it("validates terminal evidence before writing artifact rows", async () => {
    const db = openRoundDb("script");

    await expect(
      runSingleShotRound({
        db,
        start: buildStart("script"),
        config: { command: "test-script" },
        finishedAt: 3_000,
        runRound: () => ({
          outcome: { ok: true },
          artifacts: {
            verificationOutput: { path: "/artifacts/round-1/verify.log" },
          },
          evidence: { changedFiles: ["src/single-shot-orchestrator.ts"] },
        }),
      }),
    ).rejects.toThrow("changedFiles requires commitSha");

    expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    expectDurableDispatchBinding(db);
  });
});

describe("runSingleShotRound — failure / blocked / manual recovery", () => {
  it("routes a command_failed outcome to a failed terminal with no capture", async () => {
    const db = openRoundDb("script");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("script"),
      config: { command: "test-script" },
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" },
      }),
    });

    expect(outcome.round.state).toBe("failed");
    expect(outcome.round.classification).toBe("failed");
    expect(outcome.round.recoveryCode).toBe("command_failed");
    expect(outcome.round.summary).toBeNull();
    expect(outcome.round.humanGate).toBeNull();
    // A failed round captured no result, so result_captured is omitted.
    expect(
      listExecutorCheckpointsForRound(db, "round-1").map((c) => c.stage),
    ).toEqual(["round_started", "mechanism_completed", "classified"]);
  });

  it("does not checkpoint result capture when a failed mechanism reports a result", async () => {
    const db = openRoundDb("one-shot");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" },
        result: runnerResult(),
      }),
    });

    expect(outcome.round.state).toBe("failed");
    expect(outcome.round.summary).toBeNull();
    expect(
      listExecutorCheckpointsForRound(db, "round-1").map((c) => c.stage),
    ).toEqual(["round_started", "mechanism_completed", "classified"]);
  });

  it("routes an auth_unavailable outcome to a blocked terminal with a credential gate", async () => {
    const db = openRoundDb("one-shot");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "auth_unavailable" },
      }),
    });

    expect(outcome.round.state).toBe("blocked");
    expect(outcome.round.classification).toBe("blocked");
    expect(outcome.round.recoveryCode).toBe("auth_unavailable");
    expect(outcome.round.humanGate).toBe("credential_required");
  });

  it("routes a head_mismatch finalize outcome to manual recovery", async () => {
    const db = openRoundDb("one-shot");
    const outcome = await runSingleShotRound({
      db,
      start: buildStart("one-shot"),
      finishedAt: 3_000,
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "head_mismatch" },
      }),
    });

    expect(outcome.round.state).toBe("manual_recovery_required");
    expect(outcome.round.classification).toBe("manual_recovery_required");
    expect(outcome.round.recoveryCode).toBe("head_mismatch");
    expect(outcome.round.humanGate).toBe("manual_recovery_required");
  });
});

describe("runSingleShotStep — invocation/round materialization", () => {
  it("materializes a one-shot invocation + single round and drives to a terminal success", async () => {
    const db = openStepDb();
    const result = await runSingleShotStep({
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
          effort: "high",
        },
      }),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
    });

    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1,
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
      singleShotRoundId(invocationId),
    ]);

    // Selection frozen + runtime inputs threaded + clock stamped.
    expect(result.round.round.agentProvider).toBe("claude");
    expect(result.round.round.inputDigest).toBe("sha256:input-0");
    expect(result.round.round.artifactRoot).toBe("/artifacts/single-shot");
    expect(result.invocation.startedAt).toBe(1_000);
    expect(result.round.round.startedAt).toBe(1_100);
    expect(result.round.round.finishedAt).toBeGreaterThan(
      result.round.round.startedAt ?? -1,
    );
  });

  it("materializes the effective portable selection when explicit config overrides resolution", async () => {
    const db = openStepDb();
    const result = await runSingleShotStep({
      db,
      family: "one-shot",
      config: { agent: { harness: "codex", model: "gpt-5" } },
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
    });

    expect(result.round.round).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5",
    });
  });

  it("materializes a script invocation and reaches a terminal success", async () => {
    const db = openStepDb();
    let observedCommand: string | undefined;
    const result = await runSingleShotStep({
      db,
      family: "script",
      config: { command: "test-script" },
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: (_round, context) => {
        observedCommand = context.config.command;
        return { outcome: { ok: true } };
      },
    });

    const invocationId = singleShotInvocationId("run-1", "step-1", "script", 1);
    expect(result.invocation.invocationId).toBe(invocationId);
    expect(result.invocation.executorFamily).toBe("script");
    expect(result.invocation.state).toBe("succeeded");
    expect(result.round.round.executorFamily).toBe("script");
    expect(observedCommand).toBe("test-script");
  });

  it("rejects missing or path-like script config before durable materialization", async () => {
    for (const config of [
      undefined,
      { command: "/usr/local/bin/tool" },
      { command: "C:tool" },
      { command: "c:" },
      { command: null },
      { command: 123 },
    ]) {
      const db = openStepDb();
      const input = {
        db,
        family: "script",
        ...(config !== undefined ? { config } : {}),
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true } }),
      } as unknown as Parameters<typeof runSingleShotStep>[0];

      await expect(runSingleShotStep(input)).rejects.toThrow(
        "portable config.command identity",
      );
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
        .get() as { count: number };
      expect(count.count).toBe(0);
    }
  });

  it("does not insert an invocation when round-input resolution aborts", async () => {
    const db = openStepDb();
    const abort = new AbortController();

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        signal: abort.signal,
        resolveRoundInputs: () => {
          abort.abort();
          throw abort.signal.reason;
        },
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      }),
    ).rejects.toThrow(/aborted/i);

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("rejects family-forbidden config before durable materialization", async () => {
    const cases = [
      {
        family: "script",
        config: { command: "test-script", agent: { model: "forbidden" } },
        message: "does not allow property agent",
      },
      {
        family: "one-shot",
        config: { command: "test-script" },
        message: "does not allow property command",
      },
      {
        family: "script",
        config: { command: "test-script", args: "--bad" },
        message: "config.args must contain only strings",
      },
      {
        family: "one-shot",
        config: { agent: null },
        message: "config.agent must be an object",
      },
      {
        family: "one-shot",
        config: { agent: [] },
        message: "config.agent must be an object",
      },
      {
        family: "one-shot",
        config: { agent: 1 },
        message: "config.agent must be an object",
      },
      {
        family: "one-shot",
        config: { timeoutMs: 1_500 },
        message: "timeoutMs must be a whole number of seconds",
      },
      {
        family: "one-shot",
        config: { timeoutMs: 2_147_454_000 },
        message: "timeoutMs must not exceed 2147453000",
      },
    ] as const;

    for (const testCase of cases) {
      const db = openStepDb();
      const input = {
        db,
        family: testCase.family,
        config: testCase.config,
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      } as unknown as Parameters<typeof runSingleShotStep>[0];

      await expect(runSingleShotStep(input)).rejects.toThrow(testCase.message);
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
        .get() as { count: number };
      expect(count.count).toBe(0);
    }
  });

  it("rejects invalid selection-derived config before durable materialization", async () => {
    const db = openStepDb();

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({
          stepConfig: { timeoutMs: 0 },
        }),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
      .get() as { count: number };
    expect(count.count).toBe(0);

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 2,
        selection: resolveSingleShotRoundSelection({
          stepConfig: { timeoutMs: 1_500 },
        }),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      }),
    ).rejects.toThrow("timeoutMs must be a whole number of seconds");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  it("inserts the materialized invocation before the round runs", async () => {
    const db = openStepDb();
    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1,
    );
    let durableStateDuringRound:
      { invocation: string | undefined; round: string | undefined } | undefined;
    await runSingleShotStep({
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
        durableStateDuringRound = {
          invocation: loadExecutorInvocation(db, invocationId)?.state,
          round: listExecutorRoundsForInvocation(db, invocationId)[0]?.state,
        };
        return { outcome: { ok: true }, result: runnerResult() };
      },
    });
    expect(durableStateDuringRound).toEqual({
      invocation: "running",
      round: "running",
    });
  });

  it("rolls back the invocation when initial round materialization fails", async () => {
    const db = openStepDb();
    db.exec(`
      CREATE TRIGGER reject_initial_single_shot_round
      BEFORE INSERT ON executor_rounds
      BEGIN
        SELECT RAISE(ABORT, 'simulated initial round insertion failure');
      END
    `);

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      }),
    ).rejects.toThrow("simulated initial round insertion failure");

    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM executor_rounds").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("rolls back the invocation and round when dispatch binding materialization fails", async () => {
    const db = openStepDb();
    db.exec(`
      CREATE TRIGGER reject_initial_dispatch_binding
      BEFORE INSERT ON executor_checkpoints
      WHEN NEW.stage = 'round_started'
      BEGIN
        SELECT RAISE(ABORT, 'simulated dispatch binding insertion failure');
      END
    `);

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        resolveRoundInputs: roundInputs,
        runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
      }),
    ).rejects.toThrow("simulated dispatch binding insertion failure");

    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM executor_invocations")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM executor_rounds").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM executor_checkpoints")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  it("routes a failing round to a terminal failed invocation", async () => {
    const db = openStepDb();
    const result = await runSingleShotStep({
      db,
      family: "script",
      config: { command: "test-script" },
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: resolveSingleShotRoundSelection({}),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({
        outcome: { ok: false, recoveryCode: "command_failed" },
      }),
    });

    expect(result.round.round.state).toBe("failed");
    expect(result.invocation.state).toBe("failed");
    expect(result.invocation.finishedAt).not.toBeNull();
  });

  it("settles an auth_unavailable round into a terminal blocked invocation", async () => {
    const db = openStepDb();
    const result = await runSingleShotStep({
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
        outcome: { ok: false, recoveryCode: "auth_unavailable" },
      }),
    });

    expect(result.round.round.state).toBe("blocked");
    expect(result.invocation.state).toBe("blocked");
    // `blocked` is a terminal invocation state, so finished_at is stamped.
    expect(result.invocation.finishedAt).not.toBeNull();
  });

  it("settles a head_mismatch round into a terminal manual_recovery_required invocation", async () => {
    const db = openStepDb();
    const result = await runSingleShotStep({
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
        outcome: { ok: false, recoveryCode: "head_mismatch" },
      }),
    });

    // The manual-recovery branch carries an `invocationState` distinct from
    // `roundState` in the decision; the step settles the durable invocation into
    // that state, not the `failed` / `blocked` the other abort terminals take. No
    // prior step test exercised this fourth terminal, so a regression of the
    // manual-recovery `invocationState` would otherwise reach the durable row
    // unobserved (the round-level head_mismatch test pins only `roundState`).
    expect(result.round.round.state).toBe("manual_recovery_required");
    expect(result.round.decision.invocationState).toBe(
      "manual_recovery_required",
    );
    expect(result.invocation.state).toBe("manual_recovery_required");
    // `manual_recovery_required` is a terminal invocation state, so finished_at
    // is stamped.
    expect(result.invocation.finishedAt).not.toBeNull();
    // The durable invocation row matches the settled return value.
    expect(loadExecutorInvocation(db, result.invocation.invocationId)).toEqual(
      result.invocation,
    );
  });
});

// ---------------------------------------------------------------------------
// runSingleShotStep — single-owner enforcement.
// ---------------------------------------------------------------------------
//
// The deterministic invocation id `(workflowRunId, stepRunId, family, attempt)`
// is the adapter's single-owner key. A non-terminal owner can reattach for crash
// recovery; a settled duplicate cannot mint a second owner. A genuine re-run
// uses a fresh `attempt`, minting an independent invocation.

describe("runSingleShotStep — single-owner enforcement", () => {
  function dispatch(db: MomentumDb, attempt: number) {
    return runSingleShotStep({
      db,
      family: "one-shot",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt,
      selection: resolveSingleShotRoundSelection({
        stepConfig: {
          agentProvider: "claude",
          model: "claude-opus-4-8",
          effort: "high",
        },
      }),
      resolveRoundInputs: roundInputs,
      now: monotonicClock(),
      runRound: () => ({ outcome: { ok: true }, result: runnerResult() }),
    });
  }

  it("refuses a duplicate dispatch of the same attempt and leaves the durable owner untouched", async () => {
    const db = openStepDb();
    const first = await dispatch(db, 1);
    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1,
    );

    // Snapshot the durable owner + round the first dispatch settled.
    const ownerBefore = loadExecutorInvocation(db, invocationId);
    const roundsBefore = listExecutorRoundsForInvocation(db, invocationId);
    expect(ownerBefore).toEqual(first.invocation);

    // A second dispatch under the same identity collides on the invocation id and
    // fails closed before any work — never a silent second owner.
    await expect(dispatch(db, 1)).rejects.toThrow(
      ExecutorInvocationConflictError,
    );

    // The durable owner + its round are byte-for-byte unchanged.
    expect(loadExecutorInvocation(db, invocationId)).toEqual(ownerBefore);
    expect(listExecutorRoundsForInvocation(db, invocationId)).toEqual(
      roundsBefore,
    );
  });

  it("refuses invocation-only reattach without a durable dispatch binding", async () => {
    const db = openStepDb();
    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1,
    );
    insertExecutorInvocation(
      db,
      {
        invocationId,
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        executorFamily: "one-shot",
        state: "running",
        attempt: 1,
        startedAt: 1,
        heartbeatAt: 1,
        finishedAt: null,
      },
      { now: 1 },
    );

    await expect(dispatch(db, 1)).rejects.toThrow(
      "no durable round dispatch binding",
    );
    expect(listExecutorRoundsForInvocation(db, invocationId)).toEqual([]);
  });

  it("reattaches a non-terminal invocation and classifies completed durable work", async () => {
    const db = openStepDb();
    let mechanismRuns = 0;
    db.exec(`
      CREATE TRIGGER reject_single_shot_classification
      BEFORE INSERT ON executor_checkpoints
      WHEN NEW.stage = 'classified'
      BEGIN
        SELECT RAISE(ABORT, 'simulated daemon crash before classification');
      END
    `);

    await expect(
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
          mechanismRuns += 1;
          return { outcome: { ok: true }, result: runnerResult() };
        },
      }),
    ).rejects.toThrow("simulated daemon crash");

    const invocationId = singleShotInvocationId(
      "run-1",
      "step-1",
      "one-shot",
      1,
    );
    expect(loadExecutorInvocation(db, invocationId)?.state).toBe("running");
    expect(
      loadExecutorRound(db, singleShotRoundId(invocationId)),
    ).toMatchObject({ state: "capturing_result", classification: null });
    db.exec("DROP TRIGGER reject_single_shot_classification");

    await expect(
      runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({}),
        resolveRoundInputs: () => ({
          ...roundInputs(),
          inputDigest: "sha256:changed-input",
        }),
        now: monotonicClock(),
        runRound: () => {
          mechanismRuns += 1;
          throw new Error("changed dispatch must not rerun");
        },
      }),
    ).rejects.toThrow("changed dispatch inputs");

    const resumed = await runSingleShotStep({
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
        mechanismRuns += 1;
        throw new Error("completed mechanism must not rerun");
      },
    });

    expect(mechanismRuns).toBe(1);
    expect(resumed.invocation.state).toBe("succeeded");
    expect(resumed.round.round.classification).toBe("complete");
  });

  it("mints a distinct, independent invocation for a fresh re-run attempt", async () => {
    const db = openStepDb();
    const first = await dispatch(db, 1);
    const second = await dispatch(db, 2);

    expect(first.invocation.invocationId).toBe(
      singleShotInvocationId("run-1", "step-1", "one-shot", 1),
    );
    expect(second.invocation.invocationId).toBe(
      singleShotInvocationId("run-1", "step-1", "one-shot", 2),
    );
    expect(first.invocation.invocationId).not.toBe(
      second.invocation.invocationId,
    );

    // Both owners coexist durably; the re-run did not overwrite the prior attempt.
    expect(loadExecutorInvocation(db, first.invocation.invocationId)).toEqual(
      first.invocation,
    );
    expect(loadExecutorInvocation(db, second.invocation.invocationId)).toEqual(
      second.invocation,
    );
  });
});
