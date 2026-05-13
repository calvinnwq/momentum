import fs from "node:fs";
import path from "node:path";

import {
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "./artifacts.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import { getGoal, type GoalRow } from "./goal-init.js";

export type GoalLogsErrorCode =
  | "invalid_input"
  | "data_dir_failed"
  | "goal_not_found"
  | "no_goals"
  | "iteration_not_found";

export type GoalLogsError = {
  ok: false;
  code: GoalLogsErrorCode;
  error: string;
};

export type GoalLogFile = {
  path: string;
  exists: boolean;
  bytes: number;
  content: string;
};

export type GoalLogsSuccess = {
  ok: true;
  dataDir: string;
  goalId: string;
  iteration: number;
  availableIterations: number[];
  artifactDir: string;
  iterationDir: string;
  artifactPaths: GoalArtifactPaths;
  runnerLog: GoalLogFile;
  verificationLog: GoalLogFile;
};

export type GoalLogsResult = GoalLogsError | GoalLogsSuccess;

export type LoadGoalLogsInput = {
  goalId?: string;
  iteration?: number;
  dataDirOptions?: DataDirOptions;
};

export function loadGoalLogs(input: LoadGoalLogsInput = {}): GoalLogsResult {
  if (input.goalId !== undefined && input.goalId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "goalId must be a non-empty string when provided."
    };
  }
  if (input.iteration !== undefined) {
    if (!Number.isInteger(input.iteration) || input.iteration < 1) {
      return {
        ok: false,
        code: "invalid_input",
        error: "iteration must be a positive integer when provided."
      };
    }
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

    const goalDir = path.join(dataDir, "goals", goal.id);
    const availableIterations = listAvailableIterations(goalDir);

    let iteration: number;
    if (input.iteration !== undefined) {
      if (!availableIterations.includes(input.iteration)) {
        return {
          ok: false,
          code: "iteration_not_found",
          error:
            `Iteration ${input.iteration} has no artifact directory for goal ` +
            `${goal.id}. Available iterations: ` +
            `${availableIterations.length === 0 ? "(none)" : availableIterations.join(", ")}.`
        };
      }
      iteration = input.iteration;
    } else {
      iteration = selectDefaultIteration(goal, availableIterations);
    }

    const artifactPaths = resolveGoalArtifactPaths(dataDir, goal.id, iteration);

    return {
      ok: true,
      dataDir,
      goalId: goal.id,
      iteration,
      availableIterations,
      artifactDir: artifactPaths.goalDir,
      iterationDir: artifactPaths.iterationDir,
      artifactPaths,
      runnerLog: readLogFile(artifactPaths.runnerLog),
      verificationLog: readLogFile(artifactPaths.verificationLog)
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

function listAvailableIterations(goalDir: string): number[] {
  const iterationsRoot = path.join(goalDir, "iterations");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(iterationsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const numbers: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    const value = Number.parseInt(entry.name, 10);
    if (Number.isInteger(value) && value >= 1) {
      numbers.push(value);
    }
  }
  numbers.sort((a, b) => a - b);
  return numbers;
}

function selectDefaultIteration(goal: GoalRow, available: number[]): number {
  if (available.length > 0) {
    return available[available.length - 1] as number;
  }
  return goal.current_iteration > 0 ? goal.current_iteration : 1;
}

function readLogFile(filePath: string): GoalLogFile {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { path: filePath, exists: false, bytes: 0, content: "" };
  }
  if (!stat.isFile()) {
    return { path: filePath, exists: false, bytes: 0, content: "" };
  }
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    content = "";
  }
  return { path: filePath, exists: true, bytes: stat.size, content };
}
