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

export type GoalInitOptions = {
  goalPath: string;
  repoOverride?: string;
  runnerOverride?: string;
  dataDirOptions?: DataDirOptions;
};

export type GoalInitError = { ok: false; error: string };
export type GoalInitSuccess = {
  ok: true;
  goalId: string;
  jobId: string;
  spec: GoalSpec;
  dataDir: string;
  artifactPaths: GoalArtifactPaths;
  resumed: boolean;
};
export type GoalInitResult = GoalInitError | GoalInitSuccess;

export function initGoal(options: GoalInitOptions): GoalInitResult {
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
  const { spec } = parseResult;

  let db: MomentumDb | undefined;

  try {
    const dataDir = resolveDataDir(options.dataDirOptions);
    db = openDb(dataDir);

    const existingGoal = findInitializedGoals(db, spec).find((goal) =>
      goalArtifactMatches(goal, rawContent)
    );
    if (existingGoal) {
      const artifactPaths = resolveGoalArtifactPaths(dataDir, existingGoal.id);
      const jobId = ensureInitialJob(db, existingGoal.id, artifactPaths.iteration1Dir);
      return {
        ok: true,
        goalId: existingGoal.id,
        jobId,
        spec,
        dataDir,
        artifactPaths,
        resumed: true
      };
    }

    const goalId = crypto.randomUUID();
    const now = Date.now();
    const artifactPaths = initGoalArtifacts(dataDir, goalId, rawContent);

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
      "initialized",
      artifactPaths.goalDir,
      now,
      now
    );

    const jobId = createInitialJob(db, goalId, artifactPaths.iteration1Dir, now);

    return {
      ok: true,
      goalId,
      jobId,
      spec,
      dataDir,
      artifactPaths,
      resumed: false
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

function findInitializedGoals(db: MomentumDb, spec: GoalSpec): GoalRow[] {
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
         AND state = 'initialized'
       ORDER BY created_at ASC`
    )
    .all(
      spec.title,
      spec.repo ?? null,
      spec.branch,
      spec.runner,
      spec.max_iterations,
      JSON.stringify(spec.verification),
      spec.verification_timeout_sec
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

function ensureInitialJob(
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

  return createInitialJob(db, goalId, artifactPath, Date.now());
}

function createInitialJob(
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
