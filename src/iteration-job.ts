import type { GoalArtifactPaths } from "./artifacts.js";
import type { MomentumDb } from "./db.js";
import {
  runForegroundIteration,
  type ForegroundIterationError,
  type ForegroundIterationResult
} from "./foreground-iteration.js";
import type { GoalSpec } from "./goal-spec.js";

export type ExecuteIterationJobInput = {
  db: MomentumDb;
  goalId: string;
  jobId: string;
  spec: GoalSpec;
  artifactPaths: GoalArtifactPaths;
  iteration?: number;
  now?: () => number;
};

export type ExecuteIterationJobResult = {
  ok: boolean;
  iteration: ForegroundIterationResult;
  goalState: GoalIterationState;
  jobState: JobIterationState;
};

export type GoalIterationState =
  | "running"
  | "completed"
  | "iteration_complete"
  | "failed";
export type JobIterationState = "running" | "succeeded" | "failed";

export function executeIterationJob(
  input: ExecuteIterationJobInput
): ExecuteIterationJobResult {
  const { db, goalId, jobId, spec, artifactPaths } = input;
  const iteration = input.iteration ?? 1;
  const now = input.now ?? (() => Date.now());

  const startTs = now();
  db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
    "running",
    startTs,
    goalId
  );
  db.prepare(
    `UPDATE jobs
       SET state = ?,
           started_at = ?,
           updated_at = ?,
           attempt_count = attempt_count + CASE WHEN state = 'claimed' THEN 0 ELSE 1 END,
           error = NULL,
           finished_at = NULL
       WHERE id = ?`
  ).run("running", startTs, startTs, jobId);
  insertEvent(db, goalId, jobId, "iteration_started", startTs, {
    iteration,
    branch: spec.branch,
    runner: spec.runner
  });

  let result: ForegroundIterationResult;
  try {
    result = runForegroundIteration({
      goalId,
      spec,
      iteration,
      artifactPaths
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    const synthetic: ForegroundIterationError = {
      ok: false,
      code: "unexpected_error",
      error: `runForegroundIteration threw unexpectedly: ${detail}`
    };
    result = synthetic;
  }

  const finishTs = now();

  if (result.ok) {
    const goalState: GoalIterationState = result.result.goal_complete
      ? "completed"
      : "iteration_complete";
    db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
      goalState,
      finishTs,
      goalId
    );
    db.prepare(
      `UPDATE jobs
         SET state = ?,
             finished_at = ?,
             updated_at = ?,
             error = NULL
         WHERE id = ?`
    ).run("succeeded", finishTs, finishTs, jobId);
    insertEvent(db, goalId, jobId, "iteration_completed", finishTs, {
      iteration,
      branch: result.branch,
      branch_created: result.branchCreated,
      base_head: result.baseHead,
      post_runner_head: result.postRunnerHead,
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      runner_success: result.result.success,
      goal_complete: result.result.goal_complete
    });
    return {
      ok: true,
      iteration: result,
      goalState,
      jobState: "succeeded"
    };
  }

  const errorText = `${result.code}: ${result.error}`;
  db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
    "failed",
    finishTs,
    goalId
  );
  db.prepare(
    `UPDATE jobs
       SET state = ?,
           finished_at = ?,
           updated_at = ?,
           error = ?
       WHERE id = ?`
  ).run("failed", finishTs, finishTs, errorText, jobId);
  insertEvent(db, goalId, jobId, "iteration_failed", finishTs, {
    iteration,
    code: result.code,
    error: result.error
  });
  return {
    ok: false,
    iteration: result,
    goalState: "failed",
    jobState: "failed"
  };
}

function insertEvent(
  db: MomentumDb,
  goalId: string,
  jobId: string,
  type: string,
  createdAt: number,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO events (goal_id, job_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
  ).run(goalId, jobId, type, JSON.stringify(payload), createdAt);
}
