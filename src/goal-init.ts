import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseGoalSpec, type GoalSpec } from "./goal-spec.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import {
  initGoalArtifacts,
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "./artifacts.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  enqueueGoalIterationJob,
  type QueueJobState
} from "./queue-jobs.js";

export type GoalInitMode = "foreground" | "queued";

export type GoalInitOptions = {
  goalPath: string;
  repoOverride?: string;
  runnerOverride?: string;
  dataDirOptions?: DataDirOptions;
  mode?: GoalInitMode;
};

export type GoalInitError = { ok: false; error: string };
export type GoalInitSuccess = {
  ok: true;
  goalId: string;
  jobId: string;
  jobType: "foreground_iteration" | typeof GOAL_ITERATION_JOB_TYPE;
  jobState: QueueJobState;
  goalState: "initialized" | "queued";
  iteration: number;
  idempotencyKey: string | null;
  spec: GoalSpec;
  dataDir: string;
  artifactPaths: GoalArtifactPaths;
  resumed: boolean;
  enqueueCreated: boolean;
};
export type GoalInitResult = GoalInitError | GoalInitSuccess;

export function buildIterationIdempotencyKey(
  goalId: string,
  iteration: number
): string {
  return `goal:${goalId}:iteration:${iteration}`;
}

export function initGoal(options: GoalInitOptions): GoalInitResult {
  const mode: GoalInitMode = options.mode ?? "foreground";

  let rawContent: string;
  try {
    rawContent = readFileSync(options.goalPath, "utf-8");
  } catch {
    return { ok: false, error: `Cannot read goal file: ${options.goalPath}` };
  }

  const parseResult = parseGoalSpec(
    rawContent,
    options.repoOverride,
    options.runnerOverride
  );
  if (!parseResult.ok) {
    return { ok: false, error: parseResult.error };
  }
  const spec =
    mode === "queued" ? normalizeGoalSpecRepo(parseResult.spec) : parseResult.spec;

  let db: MomentumDb | undefined;

  try {
    const dataDir = resolveDataDir(options.dataDirOptions);
    db = openDb(dataDir);

    const resumeState = mode === "foreground" ? "initialized" : "queued";
    const existingGoal = findResumableGoals(db, spec, resumeState).find((goal) =>
      goalArtifactMatches(goal, rawContent)
    );
    if (existingGoal) {
      const artifactPaths = resolveGoalArtifactPaths(dataDir, existingGoal.id);
      if (mode === "foreground") {
        const jobId = ensureInitialForegroundJob(
          db,
          existingGoal.id,
          artifactPaths.iteration1Dir
        );
        return {
          ok: true,
          goalId: existingGoal.id,
          jobId,
          jobType: "foreground_iteration",
          jobState: "pending",
          goalState: "initialized",
          iteration: 1,
          idempotencyKey: null,
          spec,
          dataDir,
          artifactPaths,
          resumed: true,
          enqueueCreated: false
        };
      }
      const idempotencyKey = buildIterationIdempotencyKey(existingGoal.id, 1);
      const enqueue = enqueueGoalIterationJob(db, {
        goalId: existingGoal.id,
        iteration: 1,
        idempotencyKey,
        artifactPath: artifactPaths.iteration1Dir
      });
      return {
        ok: true,
        goalId: existingGoal.id,
        jobId: enqueue.jobId,
        jobType: GOAL_ITERATION_JOB_TYPE,
        jobState: enqueue.jobState,
        goalState: "queued",
        iteration: 1,
        idempotencyKey,
        spec,
        dataDir,
        artifactPaths,
        resumed: true,
        enqueueCreated: enqueue.created
      };
    }

    const goalId = crypto.randomUUID();
    const now = Date.now();
    const artifactPaths = initGoalArtifacts(dataDir, goalId, rawContent);

    const goalState = mode === "foreground" ? "initialized" : "queued";
    db.prepare(
      `INSERT INTO goals
         (id, title, repo, runner, branch, max_iterations, verification,
          verification_timeout_sec, state, artifact_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      goalId,
      spec.title,
      spec.repo ?? null,
      spec.runner,
      spec.branch,
      spec.max_iterations,
      JSON.stringify(spec.verification),
      spec.verification_timeout_sec,
      goalState,
      artifactPaths.goalDir,
      now,
      now
    );

    if (mode === "foreground") {
      const jobId = createForegroundJob(
        db,
        goalId,
        artifactPaths.iteration1Dir,
        now
      );
      return {
        ok: true,
        goalId,
        jobId,
        jobType: "foreground_iteration",
        jobState: "pending",
        goalState: "initialized",
        iteration: 1,
        idempotencyKey: null,
        spec,
        dataDir,
        artifactPaths,
        resumed: false,
        enqueueCreated: false
      };
    }

    const idempotencyKey = buildIterationIdempotencyKey(goalId, 1);
    const enqueue = enqueueGoalIterationJob(db, {
      goalId,
      iteration: 1,
      idempotencyKey,
      artifactPath: artifactPaths.iteration1Dir,
      now
    });
    return {
      ok: true,
      goalId,
      jobId: enqueue.jobId,
      jobType: GOAL_ITERATION_JOB_TYPE,
      jobState: enqueue.jobState,
      goalState: "queued",
      iteration: 1,
      idempotencyKey,
      spec,
      dataDir,
      artifactPaths,
      resumed: false,
      enqueueCreated: enqueue.created
    };
  } catch (error) {
    return { ok: false, error: formatInitError(error) };
  } finally {
    db?.close();
  }
}

export type GoalRow = {
  id: string;
  title: string;
  repo: string | null;
  runner: string;
  branch: string;
  max_iterations: number;
  verification: string;
  verification_timeout_sec: number;
  state: string;
  artifact_dir: string;
  created_at: number;
  updated_at: number;
};

export function getGoal(db: MomentumDb, goalId: string): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM goals WHERE id = ?")
    .get(goalId) as GoalRow | undefined;
}

type JobRow = {
  id: string;
};

function findResumableGoals(
  db: MomentumDb,
  spec: GoalSpec,
  state: "initialized" | "queued"
): GoalRow[] {
  return db
    .prepare(
      `SELECT * FROM goals
       WHERE title = ?
         AND repo IS ?
         AND branch = ?
         AND runner = ?
         AND max_iterations = ?
         AND verification = ?
         AND verification_timeout_sec = ?
         AND state = ?
       ORDER BY created_at ASC`
    )
    .all(
      spec.title,
      spec.repo ?? null,
      spec.branch,
      spec.runner,
      spec.max_iterations,
      JSON.stringify(spec.verification),
      spec.verification_timeout_sec,
      state
    ) as
    | GoalRow[];
}

function goalArtifactMatches(goal: GoalRow, rawContent: string): boolean {
  try {
    return fs.readFileSync(path.join(goal.artifact_dir, "goal.md"), "utf-8") === rawContent;
  } catch {
    return false;
  }
}

function formatInitError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Failed to initialize goal: ${error.message}`;
  }
  return "Failed to initialize goal.";
}

function normalizeGoalSpecRepo(spec: GoalSpec): GoalSpec {
  if (typeof spec.repo !== "string" || spec.repo.length === 0) {
    return spec;
  }
  return { ...spec, repo: path.resolve(spec.repo) };
}

function ensureInitialForegroundJob(
  db: MomentumDb,
  goalId: string,
  artifactPath: string
): string {
  const existing = db
    .prepare(
      `SELECT id FROM jobs
       WHERE goal_id = ? AND iteration = 1 AND type = 'foreground_iteration'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(goalId) as JobRow | undefined;

  if (existing) {
    return existing.id;
  }

  return createForegroundJob(db, goalId, artifactPath, Date.now());
}

function createForegroundJob(
  db: MomentumDb,
  goalId: string,
  artifactPath: string,
  now: number
): string {
  const jobId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO jobs
       (id, goal_id, type, iteration, state, attempt_count,
        artifact_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId,
    goalId,
    "foreground_iteration",
    1,
    "pending",
    0,
    artifactPath,
    now,
    now
  );

  return jobId;
}
