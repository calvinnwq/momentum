import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorDefinitionRecord,
  ExecutorFindingRecord,
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/core/executors/loop-reducer.js";
import {
  ExecutorEvidenceConflictError,
  ExecutorInvocationConflictError,
  ExecutorInvocationNotFoundError,
  ExecutorInvocationTransitionError,
  ExecutorRoundConflictError,
  ExecutorRoundNotFoundError,
  ExecutorRoundTransitionError,
  InvalidExecutorRecordError,
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  listExecutorRoundsForInvocation,
  listExecutorRoundsForRun,
  loadExecutorDefinition,
  loadExecutorInvocation,
  loadExecutorRound,
  persistExecutorDefinition,
  updateExecutorInvocationState,
  updateExecutorRound
} from "../src/core/executors/loop-persist.js";

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

// A seeded db with run-1 / step-1 / inv-1 / round-1 present, ready for the child
// evidence inserts (artifacts / checkpoints / findings / decisions).
function openEvidenceDb(): MomentumDb {
  const db = openRoundDb();
  insertExecutorRound(db, makeRound(), { now: 1 });
  return db;
}

function interceptNextUpdate(
  db: MomentumDb,
  table: string,
  beforeRun: () => void
): MomentumDb {
  let intercepted = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") {
        return Reflect.get(target, prop, receiver);
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!intercepted && sql.includes(`UPDATE ${table}`)) {
          intercepted = true;
          return new Proxy(statement, {
            get(statementTarget, statementProp, statementReceiver) {
              if (statementProp !== "run") {
                return Reflect.get(
                  statementTarget,
                  statementProp,
                  statementReceiver
                );
              }
              return (...args: unknown[]) => {
                beforeRun();
                return (
                  statementTarget.run as (...runArgs: unknown[]) => unknown
                )(...args);
              };
            }
          });
        }
        return statement;
      };
    }
  }) as MomentumDb;
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

function makeArtifact(
  overrides: Partial<ExecutorArtifactRecord> = {}
): ExecutorArtifactRecord {
  return {
    artifactId: "artifact-1",
    roundId: "round-1",
    artifactClass: "result_document",
    path: "/runs/round-1/result.json",
    digest: "sha256:abc",
    description: "normalized result document",
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
    stage: "prepare",
    detail: "resolved agent/model/leases",
    ...overrides
  };
}

function makeFinding(
  overrides: Partial<ExecutorFindingRecord> = {}
): ExecutorFindingRecord {
  return {
    findingId: "finding-1",
    roundId: "round-1",
    severity: "high",
    title: "missing test coverage",
    detail: "no coverage for the recovery path",
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
    summary: "merge now or hold for review",
    allowedActions: ["merge", "hold"],
    recommendedAction: "hold",
    chosenAction: "hold",
    resolution: "delegated:within-envelope",
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

  it("does not clobber a concurrently changed invocation heartbeat", () => {
    const db = openSeededDb();
    try {
      insertExecutorInvocation(db, makeInvocation({ state: "running" }), {
        now: 1000
      });
      const guardedDb = interceptNextUpdate(
        db,
        "executor_invocations",
        () => {
          db.prepare(
            "UPDATE executor_invocations SET heartbeat_at = 1099, updated_at = 1099 WHERE invocation_id = 'inv-1'"
          ).run();
        }
      );
      expect(() =>
        updateExecutorInvocationState(guardedDb, "inv-1", "running", {
          now: 1100,
          heartbeatAt: 1100
        })
      ).toThrow(ExecutorInvocationTransitionError);
      expect(loadExecutorInvocation(db, "inv-1")?.heartbeatAt).toBe(1099);
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

  it("lists every round for a run across invocations ordered by step key then round index", () => {
    const db = openRoundDb();
    try {
      // A second step + invocation under the same run so the run-scoped reader
      // has to aggregate rounds the invocation-scoped reader would never join.
      db.prepare(
        `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
           VALUES ('run-1', 'step-2', 'preflight', 1, 1, 1)`
      ).run();
      insertExecutorInvocation(
        db,
        makeInvocation({
          invocationId: "inv-2",
          stepRunId: "step-2",
          stepKey: "preflight"
        }),
        { now: 1 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "round-impl-b", roundIndex: 1 }),
        { now: 1000 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "round-impl-a", roundIndex: 0 }),
        { now: 1000 }
      );
      insertExecutorRound(
        db,
        makeRound({
          roundId: "round-pre",
          roundIndex: 0,
          invocationId: "inv-2",
          stepRunId: "step-2",
          stepKey: "preflight"
        }),
        { now: 1000 }
      );

      const rounds = listExecutorRoundsForRun(db, "run-1");
      expect(rounds.map((r) => r.roundId)).toEqual([
        "round-impl-a",
        "round-impl-b",
        "round-pre"
      ]);

      expect(listExecutorRoundsForRun(db, "missing-run")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("lists retry rounds in invocation order before round index", () => {
    const db = openRoundDb();
    try {
      insertExecutorInvocation(
        db,
        makeInvocation({
          invocationId: "inv-2",
          attempt: 2
        }),
        { now: 2000 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "attempt-1-round-0", roundIndex: 0 }),
        { now: 1100 }
      );
      insertExecutorRound(
        db,
        makeRound({ roundId: "attempt-1-round-1", roundIndex: 1 }),
        { now: 1200 }
      );
      insertExecutorRound(
        db,
        makeRound({
          roundId: "attempt-2-round-0",
          invocationId: "inv-2",
          attempt: 2,
          roundIndex: 0
        }),
        { now: 2100 }
      );
      insertExecutorRound(
        db,
        makeRound({
          roundId: "attempt-2-round-1",
          invocationId: "inv-2",
          attempt: 2,
          roundIndex: 1
        }),
        { now: 2200 }
      );

      expect(
        listExecutorRoundsForRun(db, "run-1").map((r) => r.roundId)
      ).toEqual([
        "attempt-1-round-0",
        "attempt-1-round-1",
        "attempt-2-round-0",
        "attempt-2-round-1"
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

  it("does not clobber concurrently changed same-state round fields", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound({ state: "running" }), { now: 1000 });
      const guardedDb = interceptNextUpdate(db, "executor_rounds", () => {
        db.prepare(
          "UPDATE executor_rounds SET summary = 'fresh result', heartbeat_at = 1099, updated_at = 1099 WHERE round_id = 'round-1'"
        ).run();
      });
      expect(() =>
        updateExecutorRound(
          guardedDb,
          "round-1",
          {
            toState: "running",
            summary: "stale result",
            heartbeatAt: 1100
          },
          { now: 1100 }
        )
      ).toThrow(ExecutorRoundTransitionError);
      const loaded = loadExecutorRound(db, "round-1");
      expect(loaded?.summary).toBe("fresh result");
      expect(loaded?.heartbeatAt).toBe(1099);
    } finally {
      db.close();
    }
  });

  it("does not drop a round result patch after a concurrent state match", () => {
    const db = openRoundDb();
    try {
      insertExecutorRound(db, makeRound({ state: "running" }), { now: 1000 });
      const guardedDb = interceptNextUpdate(db, "executor_rounds", () => {
        db.prepare(
          "UPDATE executor_rounds SET state = 'capturing_result', updated_at = 1099 WHERE round_id = 'round-1'"
        ).run();
      });
      expect(() =>
        updateExecutorRound(
          guardedDb,
          "round-1",
          {
            toState: "capturing_result",
            summary: "wanted result",
            resultDigest: "digest-1"
          },
          { now: 1100 }
        )
      ).toThrow(ExecutorRoundTransitionError);
      const loaded = loadExecutorRound(db, "round-1");
      expect(loaded?.state).toBe("capturing_result");
      expect(loaded?.summary).toBeNull();
      expect(loaded?.resultDigest).toBeNull();
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

describe("executor artifacts", () => {
  it("round-trips an artifact below a round", () => {
    const db = openEvidenceDb();
    try {
      const record = makeArtifact();
      insertExecutorArtifact(db, record, { now: 1000 });
      expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("preserves null optional fields through a round-trip", () => {
    const db = openEvidenceDb();
    try {
      const record = makeArtifact({
        artifactId: "artifact-bare",
        artifactClass: "logs",
        path: "/runs/round-1/stdout.log",
        digest: null,
        description: null
      });
      insertExecutorArtifact(db, record, { now: 1000 });
      expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("lists a round's artifacts ordered by created_at", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorArtifact(db, makeArtifact({ artifactId: "a-late" }), {
        now: 3000
      });
      insertExecutorArtifact(db, makeArtifact({ artifactId: "a-early" }), {
        now: 1000
      });
      insertExecutorArtifact(db, makeArtifact({ artifactId: "a-mid" }), {
        now: 2000
      });
      expect(
        listExecutorArtifactsForRound(db, "round-1").map((a) => a.artifactId)
      ).toEqual(["a-early", "a-mid", "a-late"]);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate artifact id and leaves the original untouched", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorArtifact(db, makeArtifact({ path: "/first" }), {
        now: 1000
      });
      expect(() =>
        insertExecutorArtifact(db, makeArtifact({ path: "/second" }), {
          now: 2000
        })
      ).toThrow(ExecutorEvidenceConflictError);
      const rows = listExecutorArtifactsForRound(db, "round-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe("/first");
    } finally {
      db.close();
    }
  });

  it("rejects an unknown artifact class before writing", () => {
    const db = openEvidenceDb();
    try {
      const bad = makeArtifact({
        artifactClass:
          "screenshot" as ExecutorArtifactRecord["artifactClass"]
      });
      expect(() => insertExecutorArtifact(db, bad)).toThrow(
        InvalidExecutorRecordError
      );
      expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refuses to persist an artifact below a missing round", () => {
    // inv-1 exists but round-1 was never inserted, so the FK has nothing to
    // hang below — bounded-autonomy evidence can never orphan itself.
    const db = openRoundDb();
    try {
      expect(() => insertExecutorArtifact(db, makeArtifact())).toThrow();
      expect(listExecutorArtifactsForRound(db, "round-1")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("executor checkpoints", () => {
  it("round-trips a checkpoint below a round", () => {
    const db = openEvidenceDb();
    try {
      const record = makeCheckpoint();
      insertExecutorCheckpoint(db, record, { now: 1000 });
      expect(listExecutorCheckpointsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("lists a round's checkpoints ordered by sequence", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorCheckpoint(
        db,
        makeCheckpoint({ checkpointId: "c-2", sequence: 2, stage: "finalize" }),
        { now: 1000 }
      );
      insertExecutorCheckpoint(
        db,
        makeCheckpoint({ checkpointId: "c-0", sequence: 0, stage: "prepare" }),
        { now: 1000 }
      );
      insertExecutorCheckpoint(
        db,
        makeCheckpoint({ checkpointId: "c-1", sequence: 1, stage: "run" }),
        { now: 1000 }
      );
      expect(
        listExecutorCheckpointsForRound(db, "round-1").map((c) => c.stage)
      ).toEqual(["prepare", "run", "finalize"]);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate checkpoint id", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorCheckpoint(db, makeCheckpoint(), { now: 1000 });
      expect(() =>
        insertExecutorCheckpoint(db, makeCheckpoint(), { now: 2000 })
      ).toThrow(ExecutorEvidenceConflictError);
    } finally {
      db.close();
    }
  });

  it("refuses two checkpoints with the same sequence in one round", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorCheckpoint(db, makeCheckpoint({ checkpointId: "c-a" }), {
        now: 1000
      });
      expect(() =>
        insertExecutorCheckpoint(db, makeCheckpoint({ checkpointId: "c-b" }), {
          now: 2000
        })
      ).toThrow(ExecutorEvidenceConflictError);
    } finally {
      db.close();
    }
  });
});

describe("executor findings", () => {
  it("round-trips a finding including the selected flag", () => {
    const db = openEvidenceDb();
    try {
      const record = makeFinding();
      insertExecutorFinding(db, record, { now: 1000 });
      expect(listExecutorFindingsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("round-trips an unselected finding with null optional fields", () => {
    const db = openEvidenceDb();
    try {
      const record = makeFinding({
        findingId: "finding-bare",
        severity: null,
        detail: null,
        selected: false,
        externalRef: null
      });
      insertExecutorFinding(db, record, { now: 1000 });
      expect(listExecutorFindingsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("lists a round's findings ordered by created_at", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorFinding(db, makeFinding({ findingId: "f-late" }), {
        now: 2000
      });
      insertExecutorFinding(db, makeFinding({ findingId: "f-early" }), {
        now: 1000
      });
      expect(
        listExecutorFindingsForRound(db, "round-1").map((f) => f.findingId)
      ).toEqual(["f-early", "f-late"]);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate finding id", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorFinding(db, makeFinding(), { now: 1000 });
      expect(() =>
        insertExecutorFinding(db, makeFinding(), { now: 2000 })
      ).toThrow(ExecutorEvidenceConflictError);
    } finally {
      db.close();
    }
  });
});

describe("executor decisions", () => {
  it("round-trips a decision including the allowed-actions array", () => {
    const db = openEvidenceDb();
    try {
      const record = makeDecision();
      insertExecutorDecision(db, record, { now: 1000 });
      expect(listExecutorDecisionsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("round-trips a decision external reference when provided", () => {
    const db = openEvidenceDb();
    try {
      const record = makeDecision({ externalRef: "nomistakes:D-1" });
      insertExecutorDecision(db, record, { now: 1000 });
      expect(listExecutorDecisionsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("round-trips an open decision with empty actions and null resolution", () => {
    const db = openEvidenceDb();
    try {
      const record = makeDecision({
        decisionId: "decision-open",
        allowedActions: [],
        recommendedAction: null,
        chosenAction: null,
        resolution: null
      });
      insertExecutorDecision(db, record, { now: 1000 });
      expect(listExecutorDecisionsForRound(db, "round-1")).toEqual([record]);
    } finally {
      db.close();
    }
  });

  it("lists a round's decisions ordered by created_at", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorDecision(db, makeDecision({ decisionId: "d-late" }), {
        now: 2000
      });
      insertExecutorDecision(db, makeDecision({ decisionId: "d-early" }), {
        now: 1000
      });
      expect(
        listExecutorDecisionsForRound(db, "round-1").map((d) => d.decisionId)
      ).toEqual(["d-early", "d-late"]);
    } finally {
      db.close();
    }
  });

  it("refuses a duplicate decision id", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorDecision(db, makeDecision(), { now: 1000 });
      expect(() =>
        insertExecutorDecision(db, makeDecision(), { now: 2000 })
      ).toThrow(ExecutorEvidenceConflictError);
    } finally {
      db.close();
    }
  });
});

describe("executor-loop evidence integration", () => {
  it("hangs all four evidence classes below a single round", () => {
    const db = openEvidenceDb();
    try {
      insertExecutorArtifact(db, makeArtifact(), { now: 1000 });
      insertExecutorCheckpoint(db, makeCheckpoint(), { now: 1000 });
      insertExecutorFinding(db, makeFinding(), { now: 1000 });
      insertExecutorDecision(db, makeDecision(), { now: 1000 });

      expect(listExecutorArtifactsForRound(db, "round-1")).toHaveLength(1);
      expect(listExecutorCheckpointsForRound(db, "round-1")).toHaveLength(1);
      expect(listExecutorFindingsForRound(db, "round-1")).toHaveLength(1);
      expect(listExecutorDecisionsForRound(db, "round-1")).toHaveLength(1);

      // A different round shares none of the first round's evidence.
      insertExecutorRound(db, makeRound({ roundId: "round-2", roundIndex: 1 }), {
        now: 1
      });
      expect(listExecutorArtifactsForRound(db, "round-2")).toEqual([]);
      expect(listExecutorCheckpointsForRound(db, "round-2")).toEqual([]);
      expect(listExecutorFindingsForRound(db, "round-2")).toEqual([]);
      expect(listExecutorDecisionsForRound(db, "round-2")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
