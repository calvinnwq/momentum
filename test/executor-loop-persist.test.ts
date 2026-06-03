import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import type {
  ExecutorDefinitionRecord,
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/executor-loop-reducer.js";
import {
  ExecutorInvocationConflictError,
  ExecutorInvocationNotFoundError,
  ExecutorInvocationTransitionError,
  ExecutorRoundConflictError,
  ExecutorRoundNotFoundError,
  ExecutorRoundTransitionError,
  InvalidExecutorRecordError,
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorRoundsForInvocation,
  loadExecutorDefinition,
  loadExecutorInvocation,
  loadExecutorRound,
  persistExecutorDefinition,
  updateExecutorInvocationState,
  updateExecutorRound
} from "../src/executor-loop-persist.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-executor-loop-persist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openTempDb(): MomentumDb {
  return openDb(makeTempDir());
}

// Foreign keys are enforced (node:sqlite defaults PRAGMA foreign_keys = ON), so
// an invocation needs a real (workflow_run_id, step_run_id) and a round needs a
// real invocation. Seed the minimal parent rows the fixtures point at.
function seedRunAndStep(
  db: MomentumDb,
  runId = "run-1",
  stepId = "step-1"
): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES (?, 'test', 1, 1)"
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES (?, ?, 'implementation', 0, 1, 1)`
  ).run(runId, stepId);
}

// A seeded db with run-1 / step-1 present, ready for invocation inserts.
function openSeededDb(): MomentumDb {
  const db = openTempDb();
  seedRunAndStep(db);
  return db;
}

// A seeded db with run-1 / step-1 and the inv-1 invocation present, ready for
// round inserts.
function openRoundDb(): MomentumDb {
  const db = openSeededDb();
  insertExecutorInvocation(db, makeInvocation(), { now: 1 });
  return db;
}

function makeDefinition(
  overrides: Partial<ExecutorDefinitionRecord> = {}
): ExecutorDefinitionRecord {
  return {
    executorKey: "coding-goal-loop",
    family: "goal-loop",
    agentProvider: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    timeoutMs: 1_800_000,
    maxRounds: 12,
    policyEnvelope: "delegated:standard",
    ...overrides
  };
}

function makeInvocation(
  overrides: Partial<ExecutorInvocationRecord> = {}
): ExecutorInvocationRecord {
  return {
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "pending",
    attempt: 1,
    startedAt: null,
    heartbeatAt: null,
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
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    attempt: 1,
    roundIndex: 0,
    state: "pending",
    classification: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    agentProvider: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
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

describe("persistExecutorDefinition", () => {
  it("round-trips an executor definition", () => {
    const db = openTempDb();
    try {
      const record = makeDefinition();
      const summary = persistExecutorDefinition(db, record, { now: 1000 });
      expect(summary).toEqual({ executorKey: "coding-goal-loop", inserted: true });
      expect(loadExecutorDefinition(db, "coding-goal-loop")).toEqual(record);
    } finally {
      db.close();
    }
  });

  it("preserves null executor config fields through a round-trip", () => {
    const db = openTempDb();
    try {
      const record = makeDefinition({
        executorKey: "bare",
        agentProvider: null,
        model: null,
        effort: null,
        timeoutMs: null,
        maxRounds: null,
        policyEnvelope: null
      });
      persistExecutorDefinition(db, record, { now: 1000 });
      expect(loadExecutorDefinition(db, "bare")).toEqual(record);
    } finally {
      db.close();
    }
  });

  it("upserts idempotently, preserving created_at and bumping updated_at", () => {
    const db = openTempDb();
    try {
      persistExecutorDefinition(db, makeDefinition(), { now: 1000 });
      const second = persistExecutorDefinition(
        db,
        makeDefinition({ model: "claude-sonnet-4-6" }),
        { now: 2000 }
      );
      expect(second.inserted).toBe(false);

      const rows = db
        .prepare(
          "SELECT count(*) AS c FROM executor_definitions WHERE executor_key = ?"
        )
        .get("coding-goal-loop") as { c: number };
      expect(rows.c).toBe(1);

      const row = db
        .prepare(
          "SELECT created_at, updated_at, model FROM executor_definitions WHERE executor_key = ?"
        )
        .get("coding-goal-loop") as {
        created_at: number;
        updated_at: number;
        model: string;
      };
      expect(row.created_at).toBe(1000);
      expect(row.updated_at).toBe(2000);
      expect(row.model).toBe("claude-sonnet-4-6");
    } finally {
      db.close();
    }
  });

  it("returns undefined for a missing definition", () => {
    const db = openTempDb();
    try {
      expect(loadExecutorDefinition(db, "nope")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects an unknown executor family before writing", () => {
    const db = openTempDb();
    try {
      const bad = makeDefinition({
        family: "not-a-family" as ExecutorDefinitionRecord["family"]
      });
      expect(() => persistExecutorDefinition(db, bad)).toThrow(
        InvalidExecutorRecordError
      );
      expect(loadExecutorDefinition(db, "coding-goal-loop")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("executor invocations", () => {
  it("round-trips an invocation", () => {
    const db = openSeededDb();
    try {
      const record = makeInvocation({
        state: "running",
        startedAt: 500,
        heartbeatAt: 600
      });
      insertExecutorInvocation(db, record, { now: 1000 });
      expect(loadExecutorInvocation(db, "inv-1")).toEqual(record);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate invocation id and leaves the original untouched", () => {
    const db = openSeededDb();
    try {
      insertExecutorInvocation(db, makeInvocation({ state: "preparing" }), {
        now: 1000
      });
      expect(() =>
        insertExecutorInvocation(db, makeInvocation({ state: "running" }), {
          now: 2000
        })
      ).toThrow(ExecutorInvocationConflictError);
      expect(loadExecutorInvocation(db, "inv-1")?.state).toBe("preparing");
    } finally {
      db.close();
    }
  });

  it("rejects an unknown invocation state before writing", () => {
    const db = openSeededDb();
    try {
      const bad = makeInvocation({
        state: "bogus" as ExecutorInvocationRecord["state"]
      });
      expect(() => insertExecutorInvocation(db, bad)).toThrow(
        InvalidExecutorRecordError
      );
      expect(loadExecutorInvocation(db, "inv-1")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("advances state through a valid transition", () => {
    const db = openSeededDb();
    try {
      insertExecutorInvocation(db, makeInvocation(), { now: 1000 });
      updateExecutorInvocationState(db, "inv-1", "preparing", {
        now: 1100,
        heartbeatAt: 1100
      });
      const loaded = loadExecutorInvocation(db, "inv-1");
      expect(loaded?.state).toBe("preparing");
      expect(loaded?.heartbeatAt).toBe(1100);
    } finally {
      db.close();
    }
  });

  it("refuses an invalid transition and leaves state unchanged", () => {
    const db = openSeededDb();
    try {
      insertExecutorInvocation(db, makeInvocation(), { now: 1000 });
      expect(() =>
        updateExecutorInvocationState(db, "inv-1", "succeeded", { now: 1100 })
      ).toThrow(ExecutorInvocationTransitionError);
      expect(loadExecutorInvocation(db, "inv-1")?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("throws when updating a missing invocation", () => {
    const db = openSeededDb();
    try {
      expect(() =>
        updateExecutorInvocationState(db, "ghost", "preparing")
      ).toThrow(ExecutorInvocationNotFoundError);
    } finally {
      db.close();
    }
  });
});

describe("executor rounds", () => {
  it("round-trips a round including JSON array result fields", () => {
    const db = openRoundDb();
    try {
      const record = makeRound({
        state: "succeeded",
        classification: "complete",
        startedAt: 500,
        heartbeatAt: 600,
        finishedAt: 700,
        inputDigest: "in-abc",
        resultDigest: "out-def",
        artifactRoot: "/runs/round-1",
        logPaths: ["/runs/round-1/stdout.log", "/runs/round-1/stderr.log"],
        summary: "Implemented the executor-loop persistence twin.",
        keyChanges: ["added migrations", "added persist module"],
        remainingWork: ["child record tables"],
        changedFiles: ["src/migrations.ts", "src/executor-loop-persist.ts"],
        verificationStatus: "passed",
        commitSha: "deadbeef",
        recoveryCode: null,
        humanGate: null
      });
      insertExecutorRound(db, record, { now: 1000 });
      expect(loadExecutorRound(db, "round-1")).toEqual(record);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate round id", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound(), { now: 1000 });
      expect(() => insertExecutorRound(db, makeRound(), { now: 2000 })).toThrow(
        ExecutorRoundConflictError
      );
    } finally {
      db.close();
    }
  });

  it("refuses two rounds with the same index in one invocation", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound({ roundId: "round-a", roundIndex: 0 }), {
        now: 1000
      });
      expect(() =>
        insertExecutorRound(
          db,
          makeRound({ roundId: "round-b", roundIndex: 0 }),
          { now: 2000 }
        )
      ).toThrow(ExecutorRoundConflictError);
    } finally {
      db.close();
    }
  });

  it("lists rounds for an invocation ordered by round index", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(
        db,
        makeRound({ roundId: "round-2", roundIndex: 2 }),
        { now: 1000 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "round-0", roundIndex: 0 }),
        { now: 1000 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "round-1", roundIndex: 1 }),
        { now: 1000 }
      );
      const rounds = listExecutorRoundsForInvocation(db, "inv-1");
      expect(rounds.map((r) => r.roundId)).toEqual([
        "round-0",
        "round-1",
        "round-2"
      ]);
    } finally {
      db.close();
    }
  });

  it("captures a normalized result while advancing the round state", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound({ state: "running" }), { now: 1000 });
      updateExecutorRound(
        db,
        "round-1",
        {
          toState: "capturing_result",
          summary: "did the work",
          keyChanges: ["a", "b"],
          remainingWork: ["c"],
          changedFiles: ["src/x.ts"],
          verificationStatus: "passed",
          resultDigest: "res-1",
          heartbeatAt: 1200
        },
        { now: 1200 }
      );
      const loaded = loadExecutorRound(db, "round-1");
      expect(loaded?.state).toBe("capturing_result");
      expect(loaded?.summary).toBe("did the work");
      expect(loaded?.keyChanges).toEqual(["a", "b"]);
      expect(loaded?.remainingWork).toEqual(["c"]);
      expect(loaded?.changedFiles).toEqual(["src/x.ts"]);
      expect(loaded?.verificationStatus).toBe("passed");
      expect(loaded?.resultDigest).toBe("res-1");
      expect(loaded?.heartbeatAt).toBe(1200);
    } finally {
      db.close();
    }
  });

  it("refuses to fast-path a round to succeeded without capturing a result", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound({ state: "running" }), { now: 1000 });
      expect(() =>
        updateExecutorRound(db, "round-1", { toState: "succeeded" }, { now: 1200 })
      ).toThrow(ExecutorRoundTransitionError);
      expect(loadExecutorRound(db, "round-1")?.state).toBe("running");
    } finally {
      db.close();
    }
  });

  it("throws when updating a missing round", () => {
    const db = openRoundDb();
    try {
      expect(() =>
        updateExecutorRound(db, "ghost", { toState: "running" })
      ).toThrow(ExecutorRoundNotFoundError);
    } finally {
      db.close();
    }
  });

  it("rejects an unknown classification before writing", () => {
    const db = openRoundDb();
    try {
      const bad = makeRound({
        classification:
          "maybe" as ExecutorRoundRecord["classification"]
      });
      expect(() => insertExecutorRound(db, bad)).toThrow(
        InvalidExecutorRecordError
      );
      expect(loadExecutorRound(db, "round-1")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
