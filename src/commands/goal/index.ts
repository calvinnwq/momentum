import { usageError, write, writeJson, type CliIo } from "../../renderers/cli-output.js";
import { openDb, type MomentumDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import { initGoal, type GoalInitOptions, type GoalInitSuccess } from "../../goal-init.js";
import {
  executeIterationJob,
  type ExecuteIterationJobResult
} from "../../iteration-job.js";

type ParsedFlags = {
  args: string[]; json: boolean; foreground: boolean; dataDir?: string; repo?: string; runner?: string; fromSource?: string;
};

const QUEUED_NEXT_ACTION =
  "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job.";

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
    const payload = {
      ok: false,
      command: "goal start",
      code: result.code,
      message: result.error
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  if (!parsed.foreground) {
    return emitGoalStartQueued(parsed, io, result);
  }

  const iteration = runIteration(result);

  return emitGoalStart(parsed, io, result, iteration);
}

function emitGoalStartQueued(
  parsed: ParsedFlags,
  io: CliIo,
  init: GoalInitSuccess
): number {
  const payload = {
    ok: true,
    command: "goal start",
    mode: "queued" as const,
    goalId: init.goalId,
    goalState: init.goalState,
    jobId: init.jobId,
    jobType: init.jobType,
    jobState: init.jobState,
    iteration: init.iteration,
    idempotencyKey: init.idempotencyKey,
    title: init.spec.title,
    repo: init.spec.repo ?? null,
    branch: init.spec.branch,
    baseHead: null,
    runner: init.spec.runner,
    runnerProfile: init.runnerProfile,
    runnerProfileSource: init.runnerProfileSource,
    dataDir: init.dataDir,
    artifactDir: init.artifactPaths.goalDir,
    iterationArtifactDir: init.artifactPaths.iterationDir,
    resumed: init.resumed,
    enqueueCreated: init.enqueueCreated,
    policy: init.policy,
    linkedSourceItem: init.linkedSourceItem,
    nextAction: QUEUED_NEXT_ACTION
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `${init.resumed ? "Goal resumed" : "Goal initialized"}: ${init.goalId}`,
    `Title: ${init.spec.title}`,
    `Artifact dir: ${init.artifactPaths.goalDir}`,
    `Repo: ${init.spec.repo ?? "(unset)"}`,
    `Branch (planned): ${init.spec.branch}`,
    `Goal state: ${init.goalState}`,
    `Job: ${init.jobId} (${init.jobType}, ${init.jobState}, iteration ${init.iteration})`,
    `Next: ${QUEUED_NEXT_ACTION}`,
    ""
  ].join("\n"));
  return 0;
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

function emitGoalStart(
  parsed: ParsedFlags,
  io: CliIo,
  init: GoalInitSuccess,
  iteration: ExecuteIterationJobResult
): number {
  const base = {
    command: "goal start",
    mode: "foreground" as const,
    goalId: init.goalId,
    jobId: init.jobId,
    jobType: init.jobType,
    title: init.spec.title,
    runner: init.spec.runner,
    runnerProfile: init.runnerProfile,
    runnerProfileSource: init.runnerProfileSource,
    dataDir: init.dataDir,
    artifactDir: init.artifactPaths.goalDir,
    resumed: init.resumed,
    policy: init.policy,
    linkedSourceItem: init.linkedSourceItem
  };

  if (iteration.ok && iteration.iteration.ok) {
    const iter = iteration.iteration;
    const payload = {
      ok: true,
      ...base,
      state: iteration.goalState,
      goalState: iteration.goalState,
      jobState: iteration.jobState,
      iteration: {
        ok: true,
        iteration: iter.iteration,
        repoPath: iter.repoPath,
        branch: iter.branch,
        branchCreated: iter.branchCreated,
        baseHead: iter.baseHead,
        postRunnerHead: iter.postRunnerHead,
        commitSha: iter.commitSha,
        commitMessage: iter.commitMessage,
        runnerSuccess: iter.result.success,
        goalComplete: iter.result.goal_complete,
        promptPath: iter.promptPath,
        runnerLogPath: iter.runnerLogPath,
        resultJsonPath: iter.resultJsonPath,
        verificationLogPath: iter.verificationLogPath
      }
    };

    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }

    write(io.stdout, [
      `${init.resumed ? "Goal resumed" : "Goal initialized"}: ${init.goalId}`,
      `Title: ${init.spec.title}`,
      `Artifact dir: ${init.artifactPaths.goalDir}`,
      `Branch: ${iter.branch}${iter.branchCreated ? " (created)" : ""}`,
      `Base HEAD: ${iter.baseHead}`,
      `Commit: ${iter.commitSha}`,
      `State: ${iteration.goalState}`,
      ""
    ].join("\n"));
    return 0;
  }

  const iter = iteration.iteration;
  if (iter.ok) {
    throw new Error("invariant: iteration job failed but inner result reports ok");
  }

  const message = `${iter.code}: ${iter.error}`;
  const payload = {
    ok: false,
    ...base,
    state: iteration.goalState,
    goalState: iteration.goalState,
    jobState: iteration.jobState,
    code: "iteration_failed",
    message,
    iteration: {
      ok: false,
      code: iter.code,
      error: iter.error
    }
  };

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }

  write(io.stderr, `${message}\n`);
  return 1;
}
