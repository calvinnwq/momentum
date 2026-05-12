import fs from "node:fs";

import {
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "./artifacts.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import { getGoal, type GoalRow } from "./goal-init.js";
import { GOAL_ITERATION_JOB_TYPE } from "./queue-jobs.js";

export type GoalStatusErrorCode =
  | "invalid_input"
  | "data_dir_failed"
  | "goal_not_found"
  | "no_goals";

export type GoalStatusError = {
  ok: false;
  code: GoalStatusErrorCode;
  error: string;
};

export type GoalStatusJobSummary = {
  jobId: string;
  type: string;
  iteration: number;
  state: string;
  attemptCount: number;
  artifactPath: string;
  resultPath: string | null;
  errorPath: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

export type GoalStatusIterationFailure = {
  code: string;
  error: string;
};

export type GoalStatusIterationSummary = {
  iteration: number;
  startedAt: number | null;
  finishedAt: number | null;
  branch: string | null;
  branchCreated: boolean | null;
  baseHead: string | null;
  postRunnerHead: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  runnerSuccess: boolean | null;
  goalComplete: boolean | null;
  failure: GoalStatusIterationFailure | null;
};

export type GoalStatusArtifactFiles = {
  goalMd: boolean;
  ledgerMd: boolean;
  handoffMd: boolean;
  handoffJson: boolean;
  promptMd: boolean;
  runnerLog: boolean;
  verificationLog: boolean;
  resultJson: boolean;
};

export type GoalStatusReducerNextJob = {
  jobId: string;
  iteration: number;
  idempotencyKey: string;
  artifactPath: string;
};

export type GoalStatusReducerSummary = {
  decision: string;
  jobId: string;
  iteration: number;
  jobState: string | null;
  goalState: string | null;
  completionReason: string | null;
  goalComplete: boolean | null;
  commitSha: string | null;
  maxIterations: number | null;
  recordedAt: number;
  nextJob: GoalStatusReducerNextJob | null;
};

export type GoalStatusSuccess = {
  ok: true;
  dataDir: string;
  goalId: string;
  title: string;
  state: string;
  repo: string | null;
  branch: string;
  runner: string;
  maxIterations: number;
  currentIteration: number;
  completionReason: string | null;
  verification: string[];
  verificationTimeoutSec: number;
  artifactDir: string;
  artifactPaths: GoalArtifactPaths;
  artifactFiles: GoalStatusArtifactFiles;
  createdAt: number;
  updatedAt: number;
  latestJob: GoalStatusJobSummary | null;
  iteration: GoalStatusIterationSummary | null;
  reducer: GoalStatusReducerSummary | null;
  nextJob: GoalStatusJobSummary | null;
  nextAction: string | null;
};

export type GoalStatusResult = GoalStatusError | GoalStatusSuccess;

export type LoadGoalStatusInput = {
  goalId?: string;
  dataDirOptions?: DataDirOptions;
};

type JobRow = {
  id: string;
  goal_id: string;
  type: string;
  iteration: number;
  state: string;
  attempt_count: number;
  artifact_path: string;
  result_path: string | null;
  error_path: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
};

type EventRow = {
  id: number;
  goal_id: string;
  job_id: string | null;
  type: string;
  payload: string;
  created_at: number;
};

export function loadGoalStatus(input: LoadGoalStatusInput = {}): GoalStatusResult {
  if (input.goalId !== undefined && input.goalId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "goalId must be a non-empty string when provided."
    };
  }

  let dataDir: string;
  try {
    dataDir = resolveDataDir(input.dataDirOptions ?? {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "data_dir_failed",
      error: `failed to resolve data directory: ${detail}`
    };
  }

  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);

    const goal = input.goalId !== undefined
      ? getGoal(db, input.goalId)
      : findLatestGoal(db);

    if (!goal) {
      if (input.goalId !== undefined) {
        return {
          ok: false,
          code: "goal_not_found",
          error: `Goal ${input.goalId} was not found in ${dataDir}.`
        };
      }
      return {
        ok: false,
        code: "no_goals",
        error: `No goals found in ${dataDir}.`
      };
    }

    const latestJob = findLatestJob(db, goal.id);
    const iteration = latestJob ? buildIterationSummary(db, goal.id, latestJob) : null;

    const artifactPaths = resolveGoalArtifactPaths(
      dataDir,
      goal.id,
      selectArtifactIteration(goal, latestJob)
    );
    const artifactFiles = computeArtifactFiles(artifactPaths);

    const reducer = findLatestReducerSummary(db, goal.id);
    const nextJob = reducer?.nextJob
      ? findJobById(db, reducer.nextJob.jobId)
      : null;
    const latestJobSummary = latestJob ? toJobSummary(latestJob) : null;
    const nextJobSummary = nextJob ? toJobSummary(nextJob) : null;
    const nextAction = computeNextAction(
      goal,
      latestJobSummary,
      reducer,
      nextJobSummary
    );

    return {
      ok: true,
      dataDir,
      goalId: goal.id,
      title: goal.title,
      state: goal.state,
      repo: goal.repo,
      branch: goal.branch,
      runner: goal.runner,
      maxIterations: goal.max_iterations,
      currentIteration: goal.current_iteration,
      completionReason: goal.completion_reason,
      verification: parseVerification(goal.verification),
      verificationTimeoutSec: goal.verification_timeout_sec,
      artifactDir: goal.artifact_dir,
      artifactPaths,
      artifactFiles,
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      latestJob: latestJobSummary,
      iteration,
      reducer,
      nextJob: nextJobSummary,
      nextAction
    };
  } finally {
    db?.close();
  }
}

function findLatestGoal(db: MomentumDb): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM goals ORDER BY created_at DESC, id ASC LIMIT 1")
    .get() as GoalRow | undefined;
}

function findLatestJob(db: MomentumDb, goalId: string): JobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE goal_id = ?
       ORDER BY iteration DESC, created_at DESC
       LIMIT 1`
    )
    .get(goalId) as JobRow | undefined;
}

function findJobById(db: MomentumDb, jobId: string): JobRow | undefined {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(jobId) as JobRow | undefined;
}

function selectArtifactIteration(goal: GoalRow, latestJob: JobRow | undefined): number {
  if (latestJob && latestJob.state !== "pending") {
    return latestJob.iteration;
  }
  if (goal.current_iteration > 0) {
    return goal.current_iteration;
  }
  return latestJob?.iteration ?? 1;
}

function findLatestReducerSummary(
  db: MomentumDb,
  goalId: string
): GoalStatusReducerSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM events
         WHERE goal_id = ? AND type = 'goal.reduced'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
    )
    .get(goalId) as EventRow | undefined;
  if (!row || !row.job_id) return null;

  const payload = parsePayload(row.payload);
  if (!payload) return null;

  const iteration =
    typeof payload["iteration"] === "number"
      ? (payload["iteration"] as number)
      : 0;
  const decision = pickString(payload, "decision") ?? "unknown";
  const maxIterRaw = payload["max_iterations"];
  const maxIterations =
    typeof maxIterRaw === "number" ? (maxIterRaw as number) : null;

  return {
    decision,
    jobId: row.job_id,
    iteration,
    jobState: pickString(payload, "job_state"),
    goalState: pickString(payload, "goal_state"),
    completionReason: pickString(payload, "completion_reason"),
    goalComplete: pickBool(payload, "goal_complete"),
    commitSha: pickString(payload, "commit_sha"),
    maxIterations,
    recordedAt: row.created_at,
    nextJob: readReducerNextJob(payload)
  };
}

function readReducerNextJob(
  payload: Record<string, unknown>
): GoalStatusReducerNextJob | null {
  const raw = payload["next_job"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const jobId = pickString(entry, "job_id");
  const idempotencyKey = pickString(entry, "idempotency_key");
  const artifactPath = pickString(entry, "artifact_path");
  const iteration =
    typeof entry["iteration"] === "number"
      ? (entry["iteration"] as number)
      : null;
  if (!jobId || !idempotencyKey || !artifactPath || iteration === null) {
    return null;
  }
  return { jobId, iteration, idempotencyKey, artifactPath };
}

function computeNextAction(
  goal: GoalRow,
  latestJob: GoalStatusJobSummary | null,
  reducer: GoalStatusReducerSummary | null,
  nextJob: GoalStatusJobSummary | null
): string | null {
  if (reducer) {
    if (reducer.decision === "continue" && nextJob) {
      return (
        `Run \`momentum worker run\` to claim queued ${GOAL_ITERATION_JOB_TYPE} ` +
        `job ${nextJob.jobId} (iteration ${nextJob.iteration}).`
      );
    }
    if (reducer.decision === "goal_complete") {
      return "Goal completed; no further iterations will be enqueued.";
    }
    if (reducer.decision === "max_iterations_reached") {
      return (
        `Goal reached max_iterations (${goal.max_iterations}); ` +
        "no further iterations will be enqueued."
      );
    }
    if (reducer.decision === "iteration_failed") {
      return "Goal failed; inspect the latest job error_path before retrying.";
    }
  }

  if (latestJob && latestJob.state === "pending") {
    if (latestJob.type === GOAL_ITERATION_JOB_TYPE) {
      return (
        `Run \`momentum worker run\` to claim queued ${GOAL_ITERATION_JOB_TYPE} ` +
        `job ${latestJob.jobId} (iteration ${latestJob.iteration}).`
      );
    }
    if (latestJob.type === "foreground_iteration") {
      return (
        `Run \`momentum goal start --foreground\` (resume) to execute ` +
        `iteration ${latestJob.iteration} (job ${latestJob.jobId}).`
      );
    }
  }

  return null;
}

function findLatestEventByType(
  db: MomentumDb,
  goalId: string,
  jobId: string,
  type: string
): EventRow | undefined {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE goal_id = ? AND job_id = ? AND type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(goalId, jobId, type) as EventRow | undefined;
}

function toJobSummary(row: JobRow): GoalStatusJobSummary {
  return {
    jobId: row.id,
    type: row.type,
    iteration: row.iteration,
    state: row.state,
    attemptCount: row.attempt_count,
    artifactPath: row.artifact_path,
    resultPath: row.result_path,
    errorPath: row.error_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error
  };
}

function buildIterationSummary(
  db: MomentumDb,
  goalId: string,
  job: JobRow
): GoalStatusIterationSummary | null {
  const started = findLatestEventByType(db, goalId, job.id, "iteration_started");
  const completed = findLatestEventByType(db, goalId, job.id, "iteration_completed");
  const failed = findLatestEventByType(db, goalId, job.id, "iteration_failed");

  if (!started && !completed && !failed) {
    return null;
  }

  const startedPayload = parsePayload(started?.payload);
  const completedPayload = parsePayload(completed?.payload);
  const failedPayload = parsePayload(failed?.payload);

  return {
    iteration: job.iteration,
    startedAt: started?.created_at ?? job.started_at,
    finishedAt: completed?.created_at ?? failed?.created_at ?? job.finished_at,
    branch: pickString(completedPayload, "branch") ?? pickString(startedPayload, "branch"),
    branchCreated: pickBool(completedPayload, "branch_created"),
    baseHead: pickString(completedPayload, "base_head"),
    postRunnerHead: pickString(completedPayload, "post_runner_head"),
    commitSha: pickString(completedPayload, "commit_sha"),
    commitMessage: pickString(completedPayload, "commit_message"),
    runnerSuccess: pickBool(completedPayload, "runner_success"),
    goalComplete: pickBool(completedPayload, "goal_complete"),
    failure: failedPayload
      ? {
          code: pickString(failedPayload, "code") ?? "unknown",
          error: pickString(failedPayload, "error") ?? job.error ?? ""
        }
      : null
  };
}

function parsePayload(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function pickString(
  payload: Record<string, unknown> | null,
  key: string
): string | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function pickBool(
  payload: Record<string, unknown> | null,
  key: string
): boolean | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function parseVerification(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
}

function computeArtifactFiles(paths: GoalArtifactPaths): GoalStatusArtifactFiles {
  return {
    goalMd: fs.existsSync(paths.goalMd),
    ledgerMd: fs.existsSync(paths.ledgerMd),
    handoffMd: fs.existsSync(paths.handoffMd),
    handoffJson: fs.existsSync(paths.handoffJson),
    promptMd: fs.existsSync(paths.promptMd),
    runnerLog: fs.existsSync(paths.runnerLog),
    verificationLog: fs.existsSync(paths.verificationLog),
    resultJson: fs.existsSync(paths.resultJson)
  };
}
