import { usageError, type CliIo } from "../../renderers/cli-output.js";
import { openDb, type MomentumDb } from "../../adapters/db.js";
import { type DataDirOptions } from "../../config/data-dir.js";
import { initGoal, type GoalInitOptions, type GoalInitSuccess } from "../../core/goal/init.js";
import {
  executeIterationJob,
  type ExecuteIterationJobResult
} from "../../core/goal/iteration-job.js";
import {
  emitGoalStart,
  emitGoalStartFailure,
  emitGoalStartQueued
} from "../../renderers/goal.js";

type ParsedFlags = {
  args: string[]; json: boolean; foreground: boolean; dataDir?: string; repo?: string; runner?: string; fromSource?: string;
};

export function goalStart(parsed: ParsedFlags, io: CliIo): number {
  const goalPath = parsed.args[2];

  if (!goalPath) {
    return usageError("Missing required <goal.md> for goal start.", parsed, io);
  }

  if (parsed.args.length > 3) {
    return usageError(`Unexpected argument for goal start: ${parsed.args[3]}`, parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const initOptions: GoalInitOptions = { goalPath };
  if (parsed.repo !== undefined) initOptions.repoOverride = parsed.repo;
  if (parsed.runner !== undefined) initOptions.runnerOverride = parsed.runner;
  if (parsed.fromSource !== undefined) initOptions.linkSourceItemId = parsed.fromSource;
  initOptions.dataDirOptions = dataDirOptions;
  initOptions.mode = parsed.foreground ? "foreground" : "queued";

  const result = initGoal(initOptions);

  if (!result.ok) {
    return emitGoalStartFailure(parsed, io, {
      code: result.code,
      message: result.error
    });
  }

  if (!parsed.foreground) {
    return emitGoalStartQueued(parsed, io, result);
  }

  const iteration = runIteration(result);

  return emitGoalStart(parsed, io, result, iteration);
}

function runIteration(init: GoalInitSuccess): ExecuteIterationJobResult {
  let db: MomentumDb | undefined;
  try {
    db = openDb(init.dataDir);
    return executeIterationJob({
      db,
      goalId: init.goalId,
      jobId: init.jobId,
      spec: init.spec,
      artifactPaths: init.artifactPaths
    });
  } finally {
    db?.close();
  }
}
