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
import type {
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/executor-loop-reducer.js";
import {
  goalLoopInvocationId,
  goalLoopRoundId,
  resolveGoalLoopRoundSelection,
  type GoalLoopRoundRuntimeInputs,
  type PlanGoalLoopRoundStartInput
} from "../src/goal-loop-executor.js";
import {
  runGoalLoopInvocation,
  runGoalLoopRound,
  runGoalLoopStep
} from "../src/goal-loop-orchestrator.js";
import type { FinalizeLiveWorkflowStepFromResultFileResult } from "../src/live-step-finalize.js";
import type { RunnerResult } from "../src/runner-result.js";

// Drives the single-round goal-loop executor step through the *real*
// executor-loop persistence layer and round transition graph around an injected
// bounded mechanism (the real M9 goal iteration plugs into the same seam later).
// Proves the per-round agent/model/input evidence frozen at start composes with
// the result/verification/commit evidence persisted at the end, the terminal
// clock stamps finished_at (which the pure projection cannot), and the
// verification-authority / manual-recovery boundaries hold end to end.

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
    path.join(os.tmpdir(), "momentum-goal-loop-round-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows; the driver
// itself inserts the round.
function openRoundDb(): MomentumDb {
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
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return db;
}

function buildStart(
  overrides: { roundIndex?: number; maxRounds?: number } = {}
): PlanGoalLoopRoundStartInput {
  const selection = resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      maxRounds: overrides.maxRounds ?? 5
    }
  });
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    attempt: 1,
    roundIndex: overrides.roundIndex ?? 0,
    selection,
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-1",
    logPaths: ["/artifacts/round-1/stdout.log"],
    startedAt: 1_000
  };
}

function verifyCmd(succeeded: boolean) {
  return {
    command: "pnpm test",
    exit_code: succeeded ? 0 : 1,
    signal: null,
    duration_ms: 12,
    timed_out: false,
    succeeded
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "implemented the bounded round",
    key_changes_made: ["added the round driver"],
    key_learnings: [],
    remaining_work: ["wire the loop"],
    goal_complete: false,
    commit: {
      type: "feat",
      scope: "goal-loop",
      subject: "drive a bounded round",
      body: "",
      breaking: false
    },
    ...overrides
  };
}

const COMMITTED: FinalizeLiveWorkflowStepFromResultFileResult = {
  outcome: "committed",
  verification: { ok: true, results: [verifyCmd(true)] },
  commit: {
    ok: true,
    commitSha: SHA_A,
    parentSha: SHA_B,
    message: "feat(goal-loop): drive a bounded round"
  },
  head: SHA_A
};

const RESET_VERIFICATION_FAILURE: FinalizeLiveWorkflowStepFromResultFileResult =
  {
    outcome: "reset_verification_failure",
    verification: {
      ok: false,
      code: "command_failed",
      error: "pnpm test failed",
      results: [verifyCmd(false)]
    },
    reset: { ok: true, head: SHA_B }
  };

const RESULT_MISSING: FinalizeLiveWorkflowStepFromResultFileResult = {
  outcome: "result_missing",
  resultFilePath: "/tmp/result.json",
  error: "result file not found"
};

describe("runGoalLoopRound — committed completion", () => {
  it("inserts a running round, runs the mechanism, and persists a complete terminal round", () => {
    const db = openRoundDb();
    let observed: ExecutorRoundRecord | undefined;
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: (round) => {
        observed = round;
        return {
          result: runnerResult({ goal_complete: true }),
          finalize: COMMITTED
        };
      }
    });

    // The mechanism saw the durable round-start record (running, frozen selection).
    expect(observed?.state).toBe("running");
    expect(observed?.roundId).toBe("round-1");
    expect(observed?.agentProvider).toBe("claude");
    expect(observed?.model).toBe("claude-opus-4-8");
    expect(observed?.inputDigest).toBe("sha256:input");
    expect(observed?.artifactRoot).toBe("/artifacts/round-1");

    // Terminal classification + projected evidence.
    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.round.classification).toBe("complete");
    expect(outcome.decision.continueLoop).toBe(false);
    expect(outcome.evidence).toEqual({
      outcome: "committed",
      commitSha: SHA_A,
      verificationStatus: "passed"
    });

    // Result + repo-safety evidence persisted at the end.
    expect(outcome.round.summary).toBe("implemented the bounded round");
    expect(outcome.round.keyChanges).toEqual(["added the round driver"]);
    expect(outcome.round.remainingWork).toEqual(["wire the loop"]);
    expect(outcome.round.verificationStatus).toBe("passed");
    expect(outcome.round.commitSha).toBe(SHA_A);
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
    const db = openRoundDb();
    let stateDuringMechanism: string | undefined;
    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => {
        stateDuringMechanism = loadExecutorRound(db, "round-1")?.state;
        return {
          result: runnerResult({ goal_complete: true }),
          finalize: COMMITTED
        };
      }
    });
    expect(stateDuringMechanism).toBe("running");
  });

  it("persists the mechanism's result digest onto the durable round", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        resultDigest: "sha256:round-digest",
        finalize: COMMITTED
      })
    });

    expect(outcome.round.resultDigest).toBe("sha256:round-digest");
    expect(loadExecutorRound(db, "round-1")?.resultDigest).toBe(
      "sha256:round-digest"
    );
  });

  it("leaves the result digest null when the mechanism reports none", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED
      })
    });

    expect(outcome.round.resultDigest).toBeNull();
    expect(loadExecutorRound(db, "round-1")?.resultDigest).toBeNull();
  });

  it("persists the mechanism's committed changed files onto the durable round", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED,
        changedFiles: ["src/x.ts", "src/y.ts"]
      })
    });

    expect(outcome.round.changedFiles).toEqual(["src/x.ts", "src/y.ts"]);
    expect(loadExecutorRound(db, "round-1")?.changedFiles).toEqual([
      "src/x.ts",
      "src/y.ts"
    ]);
  });

  it("leaves changed files empty when the mechanism reports none", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED
      })
    });

    expect(outcome.round.changedFiles).toEqual([]);
    expect(loadExecutorRound(db, "round-1")?.changedFiles).toEqual([]);
  });
});

describe("runGoalLoopRound — continue and quota", () => {
  it("continues a committed-but-incomplete round with budget remaining", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart({ roundIndex: 1, maxRounds: 5 }),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: false }),
        finalize: COMMITTED
      })
    });
    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.round.classification).toBe("continue");
    expect(outcome.decision.continueLoop).toBe(true);
    expect(outcome.round.humanGate).toBeNull();
  });

  it("raises a quota gate when the round budget is exhausted without completing", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart({ roundIndex: 4, maxRounds: 5 }),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: false }),
        finalize: COMMITTED
      })
    });
    expect(outcome.round.classification).toBe("operator_decision_required");
    expect(outcome.round.humanGate).toBe("quota_exhausted");
    expect(outcome.decision.continueLoop).toBe(false);
  });
});

describe("runGoalLoopRound — verification authority", () => {
  it("captures a reset round's result but never completes it", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        // The runner recommended completion, but verification reset the work.
        result: runnerResult({ goal_complete: true }),
        finalize: RESET_VERIFICATION_FAILURE
      })
    });
    expect(outcome.round.state).toBe("failed");
    expect(outcome.round.classification).toBe("continue");
    expect(outcome.round.verificationStatus).toBe("failed");
    expect(outcome.round.commitSha).toBeNull();
    // The reset round's result is still captured for the durable record.
    expect(outcome.round.summary).toBe("implemented the bounded round");
    expect(outcome.round.finishedAt).toBe(3_000);
    expect(loadExecutorRound(db, "round-1")).toEqual(outcome.round);
  });
});

describe("runGoalLoopRound — manual recovery boundary", () => {
  it("routes a missing-result round straight to manual recovery, preserving start evidence", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({ result: null, finalize: RESULT_MISSING })
    });
    expect(outcome.round.state).toBe("manual_recovery_required");
    expect(outcome.round.classification).toBe("manual_recovery_required");
    expect(outcome.round.recoveryCode).toBe("result_missing");
    expect(outcome.round.humanGate).toBe("manual_recovery_required");
    expect(outcome.decision.continueLoop).toBe(false);
    // No capture happened: no result summary, no commit, no verification.
    expect(outcome.round.summary).toBeNull();
    expect(outcome.round.commitSha).toBeNull();
    expect(outcome.round.verificationStatus).toBeNull();
    // Agent/model/input frozen at start are still preserved on recovery.
    expect(outcome.round.agentProvider).toBe("claude");
    expect(outcome.round.inputDigest).toBe("sha256:input");
    // The terminal clock still stamps finishedAt.
    expect(outcome.round.finishedAt).toBe(3_000);
    expect(loadExecutorRound(db, "round-1")).toEqual(outcome.round);
  });
});

describe("runGoalLoopRound — artifact evidence", () => {
  it("persists the round's reported artifacts plus logs derived from logPaths", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED,
        artifacts: {
          resultDocument: {
            path: "/artifacts/round-1/result.json",
            digest: "sha256:r"
          },
          verificationOutput: { path: "/artifacts/round-1/verify.log" },
          commitOrResetEvidence: { path: "/artifacts/round-1/commit.txt" }
        }
      })
    });

    // The driver's returned artifacts round-trip as the same set of durable rows
    // (the DB read orders by created_at/artifact_id; the driver returns contract
    // order, so compare as sets).
    const persisted = listExecutorArtifactsForRound(db, "round-1");
    const byId = (a: { artifactId: string }, b: { artifactId: string }) =>
      a.artifactId.localeCompare(b.artifactId);
    expect([...outcome.artifacts].sort(byId)).toEqual([...persisted].sort(byId));
    // The driver returns the artifacts in contract artifact-class order.
    expect(outcome.artifacts.map((a) => a.artifactClass)).toEqual([
      "result_document",
      "logs",
      "verification_output",
      "commit_or_reset_evidence"
    ]);
    // logs is derived from the round-start record's frozen logPaths.
    const logs = persisted.find((a) => a.artifactClass === "logs");
    expect(logs?.path).toBe("/artifacts/round-1/stdout.log");
    expect(logs?.roundId).toBe("round-1");
    const resultDoc = persisted.find(
      (a) => a.artifactClass === "result_document"
    );
    expect(resultDoc?.digest).toBe("sha256:r");
  });

  it("persists a recovery_note artifact for a manual-recovery round", () => {
    const db = openRoundDb();
    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: null,
        finalize: RESULT_MISSING,
        artifacts: { recoveryNote: { path: "/artifacts/round-1/recovery.md" } }
      })
    });
    const persisted = listExecutorArtifactsForRound(db, "round-1");
    const recovery = persisted.find((a) => a.artifactClass === "recovery_note");
    expect(recovery?.path).toBe("/artifacts/round-1/recovery.md");
  });

  it("still persists logs when the mechanism reports no artifacts", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED
      })
    });
    expect(outcome.artifacts.map((a) => a.artifactClass)).toEqual(["logs"]);
    expect(listExecutorArtifactsForRound(db, "round-1")).toHaveLength(1);
  });

  it("persists artifacts after the round-start row exists (FK holds)", () => {
    const db = openRoundDb();
    let artifactsDuringMechanism: number | undefined;
    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => {
        // The mechanism runs before artifacts are persisted; none exist yet.
        artifactsDuringMechanism = listExecutorArtifactsForRound(
          db,
          "round-1"
        ).length;
        return {
          result: runnerResult({ goal_complete: true }),
          finalize: COMMITTED,
          artifacts: { resultDocument: { path: "/artifacts/round-1/result.json" } }
        };
      }
    });
    expect(artifactsDuringMechanism).toBe(0);
    expect(listExecutorArtifactsForRound(db, "round-1").length).toBeGreaterThan(
      0
    );
  });
});

describe("runGoalLoopRound — checkpoint stream", () => {
  it("persists the round's lifecycle checkpoint stream, sequenced from 0", () => {
    const db = openRoundDb();
    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED
      })
    });

    // The driver's returned checkpoints are exactly the durable rows, in
    // sequence order (listExecutorCheckpointsForRound orders by sequence).
    const persisted = listExecutorCheckpointsForRound(db, "round-1");
    expect(persisted).toEqual(outcome.checkpoints);
    expect(persisted.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "result_captured",
      "classified"
    ]);
    expect(persisted.map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
    // The stream records the finalize outcome and the daemon classification.
    expect(persisted[1]?.detail).toBe("finalize outcome: committed");
    expect(persisted[3]?.detail).toBe("classification: complete");
  });

  it("omits result_captured for a missing-result manual-recovery round", () => {
    const db = openRoundDb();
    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => ({ result: null, finalize: RESULT_MISSING })
    });
    const persisted = listExecutorCheckpointsForRound(db, "round-1");
    expect(persisted.map((c) => c.stage)).toEqual([
      "round_started",
      "mechanism_completed",
      "classified"
    ]);
    expect(persisted[1]?.detail).toBe("finalize outcome: result_missing");
    expect(persisted[2]?.detail).toBe(
      "classification: manual_recovery_required"
    );
  });

  it("persists checkpoints after the round-start row exists (FK holds)", () => {
    const db = openRoundDb();
    let checkpointsDuringMechanism: number | undefined;
    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 3_000,
      runRound: () => {
        // The mechanism runs before checkpoints are persisted; none exist yet.
        checkpointsDuringMechanism = listExecutorCheckpointsForRound(
          db,
          "round-1"
        ).length;
        return { result: runnerResult({ goal_complete: true }), finalize: COMMITTED };
      }
    });
    expect(checkpointsDuringMechanism).toBe(0);
    expect(listExecutorCheckpointsForRound(db, "round-1")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// runGoalLoopInvocation — the multi-round invocation loop driver.
// ---------------------------------------------------------------------------
//
// Composes the single-round driver across a bounded budget through the *real*
// executor-loop persistence layer: it inserts the durable executor_invocations
// row (running) before any round, runs runGoalLoopRound per round index until a
// round's decision stops the loop, and advances/terminalizes the invocation via
// invocationStateForRoundClassification — succeeded on completion, the durable
// waiting_operator pause on a quota gate, a terminal recovery/failed on the
// repo-safety boundaries.

// Like openRoundDb, but does NOT pre-seed the invocation: the invocation driver
// inserts it itself. Seeds only the FK parent run/step rows.
function openInvocationDb(): MomentumDb {
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

function buildInvocation(): ExecutorInvocationRecord {
  return {
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 500,
    heartbeatAt: 500,
    finishedAt: null
  };
}

// Per-round start projection for round `roundIndex` under a fixed `maxRounds`
// budget: a fresh roundId/index, the same resolved selection, and a finish clock
// that strictly increases per round (so the invocation's terminal clock can be
// asserted against the last round).
function planRoundFor(
  roundIndex: number,
  maxRounds: number
): { start: PlanGoalLoopRoundStartInput; finishedAt: number } {
  const selection = resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      maxRounds
    }
  });
  return {
    start: {
      roundId: `round-${roundIndex}`,
      invocationId: "inv-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      roundIndex,
      selection,
      inputDigest: `sha256:input-${roundIndex}`,
      artifactRoot: `/artifacts/round-${roundIndex}`,
      logPaths: [`/artifacts/round-${roundIndex}/stdout.log`],
      startedAt: 1_000 + roundIndex * 1_000
    },
    finishedAt: 3_000 + roundIndex * 1_000
  };
}

describe("runGoalLoopInvocation — multi-round completion", () => {
  it("runs rounds until one recommends completion, then terminalizes the invocation succeeded", () => {
    const db = openInvocationDb();
    const result = runGoalLoopInvocation({
      db,
      invocation: buildInvocation(),
      planRound: (roundIndex) => planRoundFor(roundIndex, 3),
      // Rounds 0 and 1 commit but are not complete (continue); round 2 completes.
      runRound: (round) =>
        round.roundIndex < 2
          ? {
              result: runnerResult({ goal_complete: false }),
              finalize: COMMITTED
            }
          : {
              result: runnerResult({ goal_complete: true }),
              finalize: COMMITTED
            }
    });

    // Three rounds ran, in order, each durably persisted with its round index.
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.map((r) => r.round.roundIndex)).toEqual([0, 1, 2]);
    expect(result.rounds.map((r) => r.round.classification)).toEqual([
      "continue",
      "continue",
      "complete"
    ]);
    expect(loadExecutorRound(db, "round-0")?.classification).toBe("continue");
    expect(loadExecutorRound(db, "round-2")?.state).toBe("succeeded");

    // The invocation terminalized succeeded, stamping the last round's clock.
    expect(result.invocation.state).toBe("succeeded");
    expect(result.invocation.finishedAt).toBe(5_000);
    expect(result.invocation.heartbeatAt).toBe(5_000);
    // The start clock the caller seeded is preserved.
    expect(result.invocation.startedAt).toBe(500);
    // The durable invocation row equals the returned record.
    expect(loadExecutorInvocation(db, "inv-1")).toEqual(result.invocation);
  });

  it("inserts the durable running invocation before the first round runs", () => {
    const db = openInvocationDb();
    let stateDuringFirstRound: string | undefined;
    runGoalLoopInvocation({
      db,
      invocation: buildInvocation(),
      planRound: (roundIndex) => planRoundFor(roundIndex, 3),
      runRound: (round) => {
        if (round.roundIndex === 0) {
          stateDuringFirstRound = loadExecutorInvocation(db, "inv-1")?.state;
        }
        return {
          result: runnerResult({ goal_complete: true }),
          finalize: COMMITTED
        };
      }
    });
    expect(stateDuringFirstRound).toBe("running");
  });
});

describe("runGoalLoopInvocation — quota pause", () => {
  it("pauses the invocation at waiting_operator when the round budget exhausts without completion", () => {
    const db = openInvocationDb();
    const result = runGoalLoopInvocation({
      db,
      invocation: buildInvocation(),
      planRound: (roundIndex) => planRoundFor(roundIndex, 2),
      // Every round commits progress but never recommends completion.
      runRound: () => ({
        result: runnerResult({ goal_complete: false }),
        finalize: COMMITTED
      })
    });

    // Round 0 continued; round 1 exhausted the budget and raised the gate.
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.round.classification).toBe("continue");
    expect(result.rounds[1]?.round.classification).toBe(
      "operator_decision_required"
    );
    expect(result.rounds[1]?.round.humanGate).toBe("quota_exhausted");

    // waiting_operator is a durable pause, not terminal: no finished_at stamped.
    expect(result.invocation.state).toBe("waiting_operator");
    expect(result.invocation.finishedAt).toBeNull();
    expect(result.invocation.heartbeatAt).toBe(4_000);
    expect(loadExecutorInvocation(db, "inv-1")).toEqual(result.invocation);
  });
});

describe("runGoalLoopInvocation — repo-safety boundaries", () => {
  it("terminalizes the invocation manual_recovery_required after a missing-result round", () => {
    const db = openInvocationDb();
    const result = runGoalLoopInvocation({
      db,
      invocation: buildInvocation(),
      planRound: (roundIndex) => planRoundFor(roundIndex, 3),
      runRound: () => ({ result: null, finalize: RESULT_MISSING })
    });

    // The unsafe finalize stops the loop after one round.
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.round.state).toBe("manual_recovery_required");
    expect(result.rounds[0]?.round.recoveryCode).toBe("result_missing");

    // The invocation terminalized into manual recovery with finished_at stamped.
    expect(result.invocation.state).toBe("manual_recovery_required");
    expect(result.invocation.finishedAt).toBe(3_000);
    expect(loadExecutorInvocation(db, "inv-1")).toEqual(result.invocation);
  });

  it("keeps looping after a verification-failure reset while budget remains, then completes", () => {
    const db = openInvocationDb();
    const result = runGoalLoopInvocation({
      db,
      invocation: buildInvocation(),
      planRound: (roundIndex) => planRoundFor(roundIndex, 3),
      // Round 0 is reset by a verification failure (continue, not complete);
      // round 1 commits and recommends completion.
      runRound: (round) =>
        round.roundIndex === 0
          ? {
              result: runnerResult({ goal_complete: true }),
              finalize: RESET_VERIFICATION_FAILURE
            }
          : {
              result: runnerResult({ goal_complete: true }),
              finalize: COMMITTED
            }
    });

    expect(result.rounds).toHaveLength(2);
    // The reset round captured its result but was authoritative-failed, not complete.
    expect(result.rounds[0]?.round.state).toBe("failed");
    expect(result.rounds[0]?.round.classification).toBe("continue");
    expect(result.rounds[0]?.round.verificationStatus).toBe("failed");
    // The next round committed and completed the invocation.
    expect(result.rounds[1]?.round.state).toBe("succeeded");
    expect(result.invocation.state).toBe("succeeded");
    expect(result.invocation.finishedAt).toBe(4_000);
  });
});

describe("runGoalLoopInvocation — planner contract", () => {
  it("throws when the planner returns a round whose index does not match the loop index", () => {
    const db = openInvocationDb();
    expect(() =>
      runGoalLoopInvocation({
        db,
        invocation: buildInvocation(),
        // Always returns the round-0 plan, so the second iteration's index (1)
        // would disagree with the start's roundIndex (0).
        planRound: () => planRoundFor(0, 3),
        runRound: () => ({
          result: runnerResult({ goal_complete: false }),
          finalize: COMMITTED
        })
      })
    ).toThrow(/roundIndex/);
  });
});

// ---------------------------------------------------------------------------
// runGoalLoopStep — the goal-loop executor adapter "below StepRun".
// ---------------------------------------------------------------------------
//
// The single entrypoint a daemon/scheduler calls with a StepRun identity: it
// materializes the durable goal-loop ExecutorInvocation (deterministic id) and
// the per-round ExecutorRound identities from that StepRun + the resolved
// selection, then drives the whole invocation through runGoalLoopInvocation. It
// owns the deterministic, reattachable id scheme so callers never reinvent it.

// A monotonic clock for deterministic timestamps: returns start, start+step, ...
function monotonicClock(start = 1_000, step = 100): () => number {
  let n = start - step;
  return () => (n += step);
}

function stepSelection(maxRounds: number) {
  return resolveGoalLoopRoundSelection({
    stepConfig: {
      agentProvider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      maxRounds
    }
  });
}

function roundInputsFor(roundIndex: number): GoalLoopRoundRuntimeInputs {
  return {
    inputDigest: `sha256:input-${roundIndex}`,
    artifactRoot: `/artifacts/round-${roundIndex}`,
    logPaths: [`/artifacts/round-${roundIndex}/stdout.log`]
  };
}

describe("runGoalLoopStep — invocation/round materialization", () => {
  it("materializes the invocation + rounds from a StepRun identity and drives to completion", () => {
    const db = openInvocationDb();
    const result = runGoalLoopStep({
      db,
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: stepSelection(3),
      resolveRoundInputs: roundInputsFor,
      now: monotonicClock(),
      // Rounds 0 and 1 commit but are incomplete; round 2 completes.
      runRound: (round) =>
        round.roundIndex < 2
          ? { result: runnerResult({ goal_complete: false }), finalize: COMMITTED }
          : { result: runnerResult({ goal_complete: true }), finalize: COMMITTED }
    });

    const invocationId = goalLoopInvocationId("run-1", "step-1", 1);

    // The invocation is materialized below the step run, terminalized succeeded.
    expect(result.invocation.invocationId).toBe(invocationId);
    expect(result.invocation.workflowRunId).toBe("run-1");
    expect(result.invocation.stepRunId).toBe("step-1");
    expect(result.invocation.executorFamily).toBe("goal-loop");
    expect(result.invocation.state).toBe("succeeded");
    expect(loadExecutorInvocation(db, invocationId)).toEqual(result.invocation);

    // Three rounds ran in order under the materialized invocation, all durable.
    expect(result.rounds.map((r) => r.round.roundIndex)).toEqual([0, 1, 2]);
    expect(result.rounds.map((r) => r.round.classification)).toEqual([
      "continue",
      "continue",
      "complete"
    ]);
    const durableRounds = listExecutorRoundsForInvocation(db, invocationId);
    expect(durableRounds.map((r) => r.roundId)).toEqual([
      goalLoopRoundId(invocationId, 0),
      goalLoopRoundId(invocationId, 1),
      goalLoopRoundId(invocationId, 2)
    ]);
    expect(durableRounds.every((r) => r.invocationId === invocationId)).toBe(
      true
    );
  });

  it("mints deterministic, reattachable invocation and round ids and freezes the resolved selection + runtime inputs", () => {
    const db = openInvocationDb();
    const result = runGoalLoopStep({
      db,
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: stepSelection(3),
      resolveRoundInputs: roundInputsFor,
      now: monotonicClock(),
      runRound: () => ({
        result: runnerResult({ goal_complete: true }),
        finalize: COMMITTED
      })
    });

    const invocationId = goalLoopInvocationId("run-1", "step-1", 1);
    const round0 = result.rounds[0]?.round;
    expect(round0?.roundId).toBe(goalLoopRoundId(invocationId, 0));
    // Selection frozen into the round before work ran.
    expect(round0?.agentProvider).toBe("claude");
    expect(round0?.model).toBe("claude-opus-4-8");
    expect(round0?.effort).toBe("high");
    // Per-round runtime inputs threaded in from resolveRoundInputs.
    expect(round0?.inputDigest).toBe("sha256:input-0");
    expect(round0?.artifactRoot).toBe("/artifacts/round-0");
    expect(round0?.logPaths).toEqual(["/artifacts/round-0/stdout.log"]);
    // The injected clock stamps the invocation start and the round start/finish.
    expect(result.invocation.startedAt).toBe(1_000);
    expect(round0?.startedAt).toBe(1_100);
    expect(round0?.finishedAt).toBe(1_200);
  });

  it("inserts the materialized invocation before the first round runs", () => {
    const db = openInvocationDb();
    const invocationId = goalLoopInvocationId("run-1", "step-1", 1);
    let stateDuringFirstRound: string | undefined;
    runGoalLoopStep({
      db,
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: stepSelection(3),
      resolveRoundInputs: roundInputsFor,
      now: monotonicClock(),
      runRound: (round) => {
        if (round.roundIndex === 0) {
          stateDuringFirstRound = loadExecutorInvocation(db, invocationId)?.state;
        }
        return {
          result: runnerResult({ goal_complete: true }),
          finalize: COMMITTED
        };
      }
    });
    expect(stateDuringFirstRound).toBe("running");
  });

  it("routes a missing-result round straight to manual recovery and terminalizes the invocation", () => {
    const db = openInvocationDb();
    const result = runGoalLoopStep({
      db,
      workflowRunId: "run-1",
      stepRunId: "step-1",
      stepKey: "implementation",
      attempt: 1,
      selection: stepSelection(3),
      resolveRoundInputs: roundInputsFor,
      now: monotonicClock(),
      runRound: () => ({ result: null, finalize: RESULT_MISSING })
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.round.state).toBe("manual_recovery_required");
    expect(result.rounds[0]?.round.recoveryCode).toBe("result_missing");
    expect(result.invocation.state).toBe("manual_recovery_required");
    expect(result.invocation.finishedAt).not.toBeNull();
  });
});
