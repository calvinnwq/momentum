import fs from "node:fs";
import path from "node:path";

import {
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "../evidence/artifacts.js";
import { type DataDirOptions } from "../../config/data-dir.js";
import { openDb, type MomentumDb } from "../../adapters/db.js";
import { type GoalRow } from "./init.js";
import {
  resolveGoalForReadBack,
  resolveReadBackDataDir,
  toGoalEvidenceSummary,
  validateGoalReadBackInput,
  type GoalEvidenceSummary
} from "./read-back.js";
import { parseRunnerResult } from "../executors/runner/result.js";
import {
  listSourceItemSummariesForGoal,
  type SourceItemSummary
} from "../source/items.js";
import { listLatestEvidenceRecordsForGoal } from "../evidence/records.js";

export const DEFAULT_GOAL_LOGS_EVIDENCE_LIMIT = 5;

export type GoalLogsEvidenceSummary = GoalEvidenceSummary;

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
  readable: boolean;
  bytes: number;
  content: string;
  error?: string;
  parseError?: string;
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
  resultJson: GoalLogFile;
  sourceItems: SourceItemSummary[];
  latestEvidence: GoalLogsEvidenceSummary[];
};

export type GoalLogsResult = GoalLogsError | GoalLogsSuccess;

export type LoadGoalLogsInput = {
  goalId?: string;
  iteration?: number;
  dataDirOptions?: DataDirOptions;
};

export function loadGoalLogs(input: LoadGoalLogsInput = {}): GoalLogsResult {
  const invalidInput = validateGoalReadBackInput(input.goalId);
  if (invalidInput) return invalidInput;

  if (input.iteration !== undefined) {
    if (!Number.isInteger(input.iteration) || input.iteration < 1) {
      return {
        ok: false,
        code: "invalid_input",
        error: "iteration must be a positive integer when provided."
      };
    }
  }

  const dataDirResolution = resolveReadBackDataDir(input.dataDirOptions);
  if (!dataDirResolution.ok) return dataDirResolution;
  const dataDir = dataDirResolution.dataDir;

  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);

    const resolved = resolveGoalForReadBack(db, dataDir, input.goalId);
    if (!resolved.ok) {
      return resolved;
    }
    const goal = resolved.goal;

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
      verificationLog: readLogFile(artifactPaths.verificationLog),
      resultJson: readResultJsonFile(artifactPaths.resultJson),
      sourceItems: listSourceItemSummariesForGoal(db, goal.id),
      latestEvidence: listLatestEvidenceRecordsForGoal(
        db,
        goal.id,
        DEFAULT_GOAL_LOGS_EVIDENCE_LIMIT
      ).map(toGoalEvidenceSummary)
    };
  } finally {
    db?.close();
  }
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
    return { path: filePath, exists: false, readable: false, bytes: 0, content: "" };
  }
  if (!stat.isFile()) {
    return { path: filePath, exists: false, readable: false, bytes: 0, content: "" };
  }
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      path: filePath,
      exists: true,
      readable: false,
      bytes: stat.size,
      content: "",
      error: `failed to read log file: ${detail}`
    };
  }
  return { path: filePath, exists: true, readable: true, bytes: stat.size, content };
}

function readResultJsonFile(filePath: string): GoalLogFile {
  const file = readLogFile(filePath);
  if (!file.exists || !file.readable) {
    return file;
  }
  const trimmed = file.content.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return file;
  }
  const parsed = parseRunnerResult(file.content);
  if (parsed.ok) {
    return file;
  }
  return {
    ...file,
    parseError: parsed.error
  };
}
