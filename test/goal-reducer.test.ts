import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  REDUCER_DECISIONS,
  reduceGoalIteration
} from "../src/goal-reducer.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  enqueueGoalIterationJob,
  getQueueJob
} from "../src/queue-jobs.js";
import { listUpdateIntents } from "../src/update-intents.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-reducer-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

type GoalSeed = {
  dataDir: string;
  db: ReturnType<typeof openDb>;
  goalId: string;
  jobId: string;
  artifactDir: string;
};

function seedGoal({
  maxIterations = 3,
  iteration = 1
}: { maxIterations?: number; iteration?: number } = {}): GoalSeed {
  const dataDir = makeTempDir();
  const db = openDb(dataDir);
  const goalId = `goal-${iteration}-${maxIterations}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactDir = path.join(dataDir, "goals", goalId);
  fs.mkdirSync(path.join(artifactDir, "iterations", String(iteration)), {
    recursive: true
  });
  db.prepare(
    `INSERT INTO goals
       (id, title, repo, runner, branch, max_iterations, verification,
        verification_timeout_sec, state, artifact_dir,
        current_iteration, completion_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'fake', 'momentum/test', ?, '[]', 900,
             'iteration_complete', ?, 0, NULL, ?, ?)`
  ).run(
    goalId,
    `goal ${goalId}`,
    "/tmp/fake-repo",
    maxIterations,
    artifactDir,
    1_700_000_000_000,
    1_700_000_000_000
  );

  const enqueue = enqueueGoalIterationJob(db, {
    goalId,
    iteration,
    idempotencyKey: `goal:${goalId}:iteration:${iteration}`,
    artifactPath: path.join(artifactDir, "iterations", String(iteration)),
    now: 1_700_000_000_000
  });

  return {
    dataDir,
    db,
    goalId,
    jobId: enqueue.jobId,
    artifactDir
  };
}

function markJobSucceeded(
  db: ReturnType<typeof openDb>,
  jobId: string,
  resultPath = "/tmp/result.json"
): void {
  db.prepare(
    `UPDATE jobs
       SET state = 'succeeded',
           started_at = 1700000000010,
           finished_at = 1700000000020,
           updated_at = 1700000000020,
           attempt_count = 1,
           result_path = ?,
           error = NULL
       WHERE id = ?`
  ).run(resultPath, jobId);
}

function markJobFailed(
  db: ReturnType<typeof openDb>,
  jobId: string,
  errorMessage = "verification_failed: false exited 1",
  errorPath = "/tmp/verification.log"
): void {
  db.prepare(
    `UPDATE jobs
       SET state = 'failed',
           started_at = 1700000000010,
           finished_at = 1700000000020,
           updated_at = 1700000000020,
           attempt_count = 1,
           error_path = ?,
           error = ?
       WHERE id = ?`
  ).run(errorPath, errorMessage, jobId);
}

function insertCompletedEvent(
  db: ReturnType<typeof openDb>,
  goalId: string,
  jobId: string,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO events (goal_id, job_id, type, payload, created_at)
       VALUES (?, ?, 'iteration_completed', ?, ?)`
  ).run(goalId, jobId, JSON.stringify(payload), 1_700_000_000_015);
}

function insertFailedEvent(
  db: ReturnType<typeof openDb>,
  goalId: string,
  jobId: string,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO events (goal_id, job_id, type, payload, created_at)
       VALUES (?, ?, 'iteration_failed', ?, ?)`
  ).run(goalId, jobId, JSON.stringify(payload), 1_700_000_000_015);
}

function insertLinkedSourceItem(
  db: ReturnType<typeof openDb>,
  goalId: string,
  sourceItemId = "si-reducer"
): void {
  db.prepare(
    "INSERT INTO source_items " +
      "(id, adapter_kind, external_id, external_key, url, title, " +
      "status, metadata_json, last_observed_at, goal_id, " +
      "created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    sourceItemId,
    "linear",
    `ext-${sourceItemId}`,
    sourceItemId.toUpperCase(),
    `https://linear.app/example/issue/${sourceItemId}`,
    `Source ${sourceItemId}`,
    "In Progress",
    "{}",
    1_700_000_000_000,
    goalId,
    1_700_000_000_000,
    1_700_000_000_000
  );
}

function insertVerificationEvidence(
  db: ReturnType<typeof openDb>,
  goalId: string,
  evidenceId = "ev-reducer"
): void {
  db.prepare(
    "INSERT INTO evidence_records " +
      "(id, source, type, format_version, artifact_path, external_id, " +
      "occurred_at, summary, metadata_json, goal_id, source_item_id, " +
      "ingest_key, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    evidenceId,
    "agent-workflow",
    "verification_passed",
    1,
    null,
    null,
    1_700_000_000_020,
    "verification passed",
    "{}",
    goalId,
    null,
    `reducer:${evidenceId}`,
    1_700_000_000_020,
    1_700_000_000_020
  );
}

function reducerEvents(
  db: ReturnType<typeof openDb>,
  goalId: string
): Array<{ type: string; payload: string }> {
  return db
    .prepare(
      `SELECT type, payload FROM events WHERE goal_id = ?
         AND type IN ('goal.reduced', 'goal.completed', 'goal.failed')
       ORDER BY id ASC`
    )
    .all(goalId) as Array<{ type: string; payload: string }>;
}

describe("reduceGoalIteration", () => {
  it("enqueues exactly one next iteration job after a successful continue", () => {
    const seed = seedGoal({ maxIterations: 3, iteration: 1 });
    try {
      markJobSucceeded(seed.db, seed.jobId);
      insertCompletedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        goal_complete: false,
        commit_sha: "abc123"
      });

      const result = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });

      expect(result.decision).toBe(REDUCER_DECISIONS.CONTINUE);
      expect(result.goalState).toBe("queued");
      expect(result.goalComplete).toBe(false);
      expect(result.commitSha).toBe("abc123");
      expect(result.nextJob).not.toBeNull();
      expect(result.nextJob?.iteration).toBe(2);
      expect(result.nextJob?.idempotencyKey).toBe(
        `goal:${seed.goalId}:iteration:2`
      );
      expect(result.nextJob?.created).toBe(true);
      expect(result.nextJob?.artifactPath).toBe(
        path.join(seed.artifactDir, "iterations", "2")
      );

      const nextJob = getQueueJob(seed.db, result.nextJob!.jobId);
      expect(nextJob?.state).toBe("pending");
      expect(nextJob?.iteration).toBe(2);
      expect(nextJob?.type).toBe(GOAL_ITERATION_JOB_TYPE);

      const goalRow = seed.db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("queued");
      expect(goalRow.current_iteration).toBe(1);
      expect(goalRow.completion_reason).toBeNull();

      const events = reducerEvents(seed.db, seed.goalId);
      expect(events.map((row) => row.type)).toEqual(["goal.reduced"]);
      const reduced = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(reduced["decision"]).toBe(REDUCER_DECISIONS.CONTINUE);
      expect(reduced["iteration"]).toBe(1);
      expect(reduced["goal_state"]).toBe("queued");
      expect(reduced["goal_complete"]).toBe(false);
      expect(reduced["commit_sha"]).toBe("abc123");
      const nextJobPayload = reduced["next_job"] as Record<string, unknown>;
      expect(nextJobPayload["iteration"]).toBe(2);
      expect(nextJobPayload["idempotency_key"]).toBe(
        `goal:${seed.goalId}:iteration:2`
      );
      expect(nextJobPayload["created"]).toBe(true);
    } finally {
      seed.db.close();
    }
  });

  it("marks the goal completed and emits goal.completed when goal_complete=true", () => {
    const seed = seedGoal({ maxIterations: 5, iteration: 1 });
    try {
      markJobSucceeded(seed.db, seed.jobId);
      insertCompletedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        goal_complete: true,
        commit_sha: "done-sha"
      });

      const result = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });

      expect(result.decision).toBe(REDUCER_DECISIONS.GOAL_COMPLETE);
      expect(result.goalState).toBe("completed");
      expect(result.completionReason).toBe("goal_complete");
      expect(result.nextJob).toBeNull();

      const goalRow = seed.db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("completed");
      expect(goalRow.current_iteration).toBe(1);
      expect(goalRow.completion_reason).toBe("goal_complete");

      const events = reducerEvents(seed.db, seed.goalId);
      expect(events.map((row) => row.type)).toEqual([
        "goal.reduced",
        "goal.completed"
      ]);
      const completed = JSON.parse(
        events[1]!.payload
      ) as Record<string, unknown>;
      expect(completed["iteration"]).toBe(1);
      expect(completed["completion_reason"]).toBe("goal_complete");
      expect(completed["commit_sha"]).toBe("done-sha");

      const nextJobByKey = seed.db
        .prepare(
          "SELECT id FROM jobs WHERE goal_id = ? AND iteration = 2 AND type = ?"
        )
        .get(seed.goalId, GOAL_ITERATION_JOB_TYPE) as
        | { id: string }
        | undefined;
      expect(nextJobByKey).toBeUndefined();
    } finally {
      seed.db.close();
    }
  });

  it("creates a pending source_satisfied intent when reducing a goal to completed", () => {
    const seed = seedGoal({ maxIterations: 5, iteration: 1 });
    try {
      insertLinkedSourceItem(seed.db, seed.goalId, "si-reducer-complete");
      insertVerificationEvidence(seed.db, seed.goalId, "ev-reducer-complete");
      markJobSucceeded(seed.db, seed.jobId);
      insertCompletedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        goal_complete: true,
        commit_sha: "done-sha"
      });

      const result = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });

      expect(result.decision).toBe(REDUCER_DECISIONS.GOAL_COMPLETE);
      const intents = listUpdateIntents(seed.db, {
        status: "pending",
        goalId: seed.goalId
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.sourceItemId).toBe("si-reducer-complete");
      expect(intents[0]?.evidenceRecordId).toBe("ev-reducer-complete");
    } finally {
      seed.db.close();
    }
  });

  it("marks the goal terminal and emits goal.failed when max_iterations is reached", () => {
    const seed = seedGoal({ maxIterations: 1, iteration: 1 });
    try {
      markJobSucceeded(seed.db, seed.jobId);
      insertCompletedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        goal_complete: false,
        commit_sha: "last-sha"
      });

      const result = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });

      expect(result.decision).toBe(REDUCER_DECISIONS.MAX_ITERATIONS_REACHED);
      expect(result.goalState).toBe("max_iterations_reached");
      expect(result.completionReason).toBe("max_iterations_reached:1");
      expect(result.nextJob).toBeNull();

      const goalRow = seed.db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("max_iterations_reached");
      expect(goalRow.completion_reason).toBe("max_iterations_reached:1");

      const events = reducerEvents(seed.db, seed.goalId);
      expect(events.map((row) => row.type)).toEqual([
        "goal.reduced",
        "goal.failed"
      ]);
      const failed = JSON.parse(events[1]!.payload) as Record<string, unknown>;
      expect(failed["iteration"]).toBe(1);
      expect(failed["completion_reason"]).toBe("max_iterations_reached:1");
    } finally {
      seed.db.close();
    }
  });

  it("marks the goal failed and emits goal.failed when the job failed", () => {
    const seed = seedGoal({ maxIterations: 3, iteration: 1 });
    try {
      markJobFailed(
        seed.db,
        seed.jobId,
        "verification_failed: command 'false' exited 1",
        "/tmp/verification.log"
      );
      insertFailedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        code: "verification_failed",
        error: "command 'false' exited 1"
      });

      const result = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });

      expect(result.decision).toBe(REDUCER_DECISIONS.ITERATION_FAILED);
      expect(result.goalState).toBe("failed");
      expect(result.completionReason).toContain("verification_failed");
      expect(result.commitSha).toBeNull();
      expect(result.goalComplete).toBeNull();
      expect(result.nextJob).toBeNull();

      const goalRow = seed.db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("failed");
      expect(goalRow.completion_reason).toContain("verification_failed");

      const events = reducerEvents(seed.db, seed.goalId);
      expect(events.map((row) => row.type)).toEqual([
        "goal.reduced",
        "goal.failed"
      ]);
      const failedPayload = JSON.parse(
        events[1]!.payload
      ) as Record<string, unknown>;
      expect(failedPayload["error_path"]).toBe("/tmp/verification.log");
      expect(failedPayload["error"]).toContain("verification_failed");
    } finally {
      seed.db.close();
    }
  });

  it("is idempotent across repeated reducer invocations on the same job", () => {
    const seed = seedGoal({ maxIterations: 3, iteration: 1 });
    try {
      markJobSucceeded(seed.db, seed.jobId);
      insertCompletedEvent(seed.db, seed.goalId, seed.jobId, {
        iteration: 1,
        goal_complete: false,
        commit_sha: "abc123"
      });

      const first = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_030
      });
      expect(first.decision).toBe(REDUCER_DECISIONS.CONTINUE);
      expect(first.reusedExistingDecision).toBe(false);
      const firstNextJobId = first.nextJob?.jobId;
      expect(firstNextJobId).toBeDefined();

      const second = reduceGoalIteration({
        db: seed.db,
        goalId: seed.goalId,
        jobId: seed.jobId,
        now: () => 1_700_000_000_040
      });
      expect(second.decision).toBe(REDUCER_DECISIONS.ALREADY_REDUCED);
      expect(second.reusedExistingDecision).toBe(true);
      expect(second.nextJob?.jobId).toBe(firstNextJobId);
      expect(second.nextJob?.created).toBe(false);
      expect(second.goalState).toBe("queued");

      const reducedEventCount = seed.db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'goal.reduced'"
        )
        .get(seed.goalId) as { c: number };
      expect(reducedEventCount.c).toBe(1);

      const nextJobsForIter2 = seed.db
        .prepare(
          "SELECT count(*) AS c FROM jobs WHERE goal_id = ? AND iteration = 2 AND type = ?"
        )
        .get(seed.goalId, GOAL_ITERATION_JOB_TYPE) as { c: number };
      expect(nextJobsForIter2.c).toBe(1);
    } finally {
      seed.db.close();
    }
  });

  it("throws when the referenced job is not terminal", () => {
    const seed = seedGoal({ maxIterations: 3, iteration: 1 });
    try {
      // job is still pending; reducer should refuse
      expect(() =>
        reduceGoalIteration({
          db: seed.db,
          goalId: seed.goalId,
          jobId: seed.jobId
        })
      ).toThrow(/not terminal/);
    } finally {
      seed.db.close();
    }
  });

  it("throws when the goal/job pairing is inconsistent", () => {
    const seed = seedGoal({ maxIterations: 3, iteration: 1 });
    try {
      markJobSucceeded(seed.db, seed.jobId);
      expect(() =>
        reduceGoalIteration({
          db: seed.db,
          goalId: "not-the-right-goal",
          jobId: seed.jobId
        })
      ).toThrow();
    } finally {
      seed.db.close();
    }
  });
});
