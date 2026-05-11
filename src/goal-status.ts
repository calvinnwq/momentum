import fs from "node:fs";

import {
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "./artifacts.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import { getGoal, type GoalRow } from "./goal-init.js";

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
  verification: string[];
  verificationTimeoutSec: number;
  artifactDir: string;
  artifactPaths: GoalArtifactPaths;
  artifactFiles: GoalStatusArtifactFiles;
  createdAt: number;
  updatedAt: number;
  latestJob: GoalStatusJobSummary | null;
  iteration: GoalStatusIterationSummary | null;
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

    const artifactPaths = resolveGoalArtifactPaths(dataDir, goal.id);
    const artifactFiles = computeArtifactFiles(artifactPaths);

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
      verification: parseVerification(goal.verification),
      verificationTimeoutSec: goal.verification_timeout_sec,
      artifactDir: goal.artifact_dir,
      artifactPaths,
      artifactFiles,
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      latestJob: latestJob ? toJobSummary(latestJob) : null,
      iteration
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
