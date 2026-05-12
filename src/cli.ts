import process from "node:process";
import { openDb, type MomentumDb } from "./db.js";
import { initGoal, type GoalInitOptions, type GoalInitSuccess } from "./goal-init.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import {
  executeIterationJob,
  type ExecuteIterationJobResult
} from "./iteration-job.js";
import {
  loadGoalStatus,
  type GoalStatusSuccess
} from "./goal-status.js";
import { writeHandoff, type HandoffSuccess } from "./handoff.js";
import { runWorkerOnce, type WorkerRunResult } from "./worker-run.js";

export const VERSION = "0.0.0";

type Writer = {
  write(chunk: string): boolean;
};

export type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

type JsonPayload = Record<string, unknown>;

type ParsedFlags = {
  args: string[];
  json: boolean;
  foreground: boolean;
  repo?: string;
  runner?: string;
  workerId?: string;
  dataDir?: string;
  error?: string;
};

const COMMANDS = [
  "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]",
  "momentum status [goal-id] [--data-dir <path>] [--json]",
  "momentum handoff <goal-id> [--data-dir <path>] [--json]",
  "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]",
  "momentum doctor [--json]"
];

const QUEUED_NEXT_ACTION =
  "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job.";

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseFlags(argv);
  if (parsed.error) {
    return usageError(parsed.error, parsed, io);
  }

  const [command, subcommand] = parsed.args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    write(io.stdout, renderHelp());
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    write(io.stdout, `${VERSION}\n`);
    return 0;
  }

  if (command === "doctor") {
    return doctor(parsed, io);
  }

  if (command === "goal" && subcommand === "start") {
    return goalStart(parsed, io);
  }

  if (command === "status") {
    return status(parsed, io);
  }

  if (command === "handoff") {
    return handoff(parsed, io);
  }

  if (command === "worker" && subcommand === "run") {
    return workerRun(parsed, io);
  }

  return usageError(`Unknown command: ${command}`, parsed, io);
}

function workerRun(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(`Unexpected argument for worker run: ${parsed.args[2]}`, parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;
  const dataDir = resolveDataDir(dataDirOptions);

  const workerId = parsed.workerId ?? `worker-${process.pid}`;

  const db = openDb(dataDir);
  try {
    const result = runWorkerOnce({
      db,
      dataDir,
      workerId,
      leaseDurationMs: 30_000
    });
    return emitWorkerRunResult(parsed, io, result);
  } finally {
    db.close();
  }
}

function emitWorkerRunResult(
  parsed: ParsedFlags,
  io: CliIo,
  result: WorkerRunResult
): number {
  if (parsed.json) {
    const base = {
      command: "worker run",
      ...result
    };
    const payload = {
      ok:
        result.code === "ran_job"
          ? result.jobIterationResult.ok
          : true,
      ...base
    } as Record<string, unknown>;

    writeJson(io.stdout, payload);
    return result.code === "no_work" || result.code === "not_executed"
      ? 0
      : result.jobIterationResult.ok
        ? 0
        : 1;
  }

  if (result.code === "no_work") {
    write(io.stdout, `${result.message}\n`);
    return 0;
  }

  if (result.code === "not_executed") {
    write(io.stdout, `${result.message}\n`);
    return 0;
  }

  const iterResult = result.jobIterationResult;
  const status = iterResult.ok ? "succeeded" : "failed";
  write(io.stdout, [
    `Worker ${result.workerId} ${status} goal ${result.goalId} iteration ${result.iteration}`,
    `Job: ${result.jobId}`,
    `Lock: ${result.lockId}`,
    `Repo: ${result.repoRoot}`,
    `Goal state: ${result.goalState}`,
    `Job state: ${result.jobState}`,
    ""
  ].join("\n"));

  return iterResult.ok ? 0 : 1;
}

function doctor(parsed: ParsedFlags, io: CliIo): number {
  const payload = {
    ok: true,
    command: "doctor",
    version: VERSION,
    node: process.version,
    platform: process.platform,
    milestone: "NGX-249 completion-reducer-chaining"
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    "Momentum doctor: ok",
    `version: ${payload.version}`,
    `node: ${payload.node}`,
    `platform: ${payload.platform}`,
    `scope: ${payload.milestone}`,
    ""
  ].join("\n"));
  return 0;
}

function goalStart(parsed: ParsedFlags, io: CliIo): number {
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
  initOptions.dataDirOptions = dataDirOptions;
  initOptions.mode = parsed.foreground ? "foreground" : "queued";

  const result = initGoal(initOptions);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "goal start",
      code: "init_error",
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
    dataDir: init.dataDir,
    artifactDir: init.artifactPaths.goalDir,
    iterationArtifactDir: init.artifactPaths.iterationDir,
    resumed: init.resumed,
    enqueueCreated: init.enqueueCreated,
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
    dataDir: init.dataDir,
    artifactDir: init.artifactPaths.goalDir,
    resumed: init.resumed
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

function status(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (parsed.args.length > 2) {
    return usageError(`Unexpected argument for status: ${parsed.args[2]}`, parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: { goalId?: string; dataDirOptions: DataDirOptions } = {
    dataDirOptions
  };
  if (goalIdArg !== undefined) input.goalId = goalIdArg;

  const result = loadGoalStatus(input);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "status",
      code: result.code,
      message: result.error,
      goalId: goalIdArg ?? null
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  return emitStatus(parsed, io, result);
}

function emitStatus(
  parsed: ParsedFlags,
  io: CliIo,
  data: GoalStatusSuccess
): number {
  const payload = {
    ok: true,
    command: "status",
    goalId: data.goalId,
    title: data.title,
    state: data.state,
    repo: data.repo,
    branch: data.branch,
    runner: data.runner,
    maxIterations: data.maxIterations,
    currentIteration: data.currentIteration,
    completionReason: data.completionReason,
    verification: data.verification,
    verificationTimeoutSec: data.verificationTimeoutSec,
    dataDir: data.dataDir,
    artifactDir: data.artifactDir,
    artifactPaths: {
      goalMd: data.artifactPaths.goalMd,
      ledgerMd: data.artifactPaths.ledgerMd,
      handoffMd: data.artifactPaths.handoffMd,
      handoffJson: data.artifactPaths.handoffJson,
      promptMd: data.artifactPaths.promptMd,
      runnerLog: data.artifactPaths.runnerLog,
      verificationLog: data.artifactPaths.verificationLog,
      resultJson: data.artifactPaths.resultJson
    },
    artifactFiles: data.artifactFiles,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    latestJob: data.latestJob,
    iteration: data.iteration,
    reducer: data.reducer,
    nextJob: data.nextJob,
    nextAction: data.nextAction
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Goal: ${data.goalId}`,
    `Title: ${data.title}`,
    `State: ${data.state}`,
    `Repo: ${data.repo ?? "(unset)"}`,
    `Branch: ${data.branch}`,
    `Runner: ${data.runner}`,
    `Artifact dir: ${data.artifactDir}`
  ];

  if (data.latestJob) {
    lines.push(
      `Job: ${data.latestJob.jobId} (${data.latestJob.state}, iteration ${data.latestJob.iteration})`
    );
  }

  if (data.iteration) {
    if (data.iteration.commitSha) {
      lines.push(`Commit: ${data.iteration.commitSha}`);
    }
    if (data.iteration.failure) {
      lines.push(
        `Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
      );
    }
  }

  if (data.reducer) {
    lines.push(
      `Reducer: ${data.reducer.decision} (iteration ${data.reducer.iteration})`
    );
    if (data.reducer.completionReason) {
      lines.push(`Completion reason: ${data.reducer.completionReason}`);
    }
  }

  if (data.nextAction) {
    lines.push(`Next: ${data.nextAction}`);
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function handoff(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for handoff.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for handoff: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const result = writeHandoff({ goalId: goalIdArg, dataDirOptions });

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "handoff",
      code: result.code,
      message: result.error,
      goalId: goalIdArg
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  return emitHandoff(parsed, io, result);
}

function emitHandoff(
  parsed: ParsedFlags,
  io: CliIo,
  result: HandoffSuccess
): number {
  const { data } = result;
  const payload = {
    ok: true,
    command: "handoff",
    goalId: data.goal.id,
    title: data.goal.title,
    state: data.goal.state,
    currentIteration: data.goal.currentIteration,
    completionReason: data.goal.completionReason,
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    handoffMdPath: result.handoffMdPath,
    handoffJsonPath: result.handoffJsonPath,
    dataDir: data.goal.dataDir,
    artifactDir: data.goal.artifactDir,
    iteration: data.iteration,
    runnerResult: data.runnerResult,
    latestJob: data.latestJob,
    reducer: data.reducer,
    nextJob: data.nextJob,
    nextAction: data.nextAction
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Handoff written for goal: ${data.goal.id}`,
    `Title: ${data.goal.title}`,
    `State: ${data.goal.state}`,
    `handoff.md: ${result.handoffMdPath}`,
    `handoff.json: ${result.handoffJsonPath}`
  ];

  if (data.iteration?.commitSha) {
    lines.push(`Commit: ${data.iteration.commitSha}`);
  }
  if (data.iteration?.failure) {
    lines.push(
      `Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
    );
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function usageError(message: string, parsed: ParsedFlags, io: CliIo): number {
  const payload = {
    ok: false,
    code: "usage_error",
    message,
    commands: COMMANDS
  };

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 2;
  }

  write(io.stderr, `${message}\n\n${renderHelp()}`);
  return 2;
}

function parseFlags(argv: string[]): ParsedFlags {
  const args: string[] = [];
  let json = false;
  let foreground = false;
  let repo: string | undefined;
  let runner: string | undefined;
  let workerId: string | undefined;
  let dataDir: string | undefined;
  let error: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--foreground") {
      foreground = true;
      continue;
    }

    if (arg === "--repo") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --repo.";
      } else {
        repo = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--runner") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --runner.";
      } else {
        runner = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--worker-id") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --worker-id.";
      } else {
        workerId = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--data-dir") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --data-dir.";
      } else {
        dataDir = value;
        index += 1;
      }
      continue;
    }

    args.push(arg);
  }

  const parsed: ParsedFlags = { args, json, foreground };
  if (repo !== undefined) parsed.repo = repo;
  if (runner !== undefined) parsed.runner = runner;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  if (workerId !== undefined) parsed.workerId = workerId;
  if (error !== undefined) parsed.error = error;

  return parsed;
}

function readFlagValue(argv: string[], index: number): string | undefined {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }

  return value;
}

function renderHelp(): string {
  return [
    "Momentum",
    "",
    "Usage:",
    ...COMMANDS.map((command) => `  ${command}`),
    "",
    "Default goal start enqueues a goal_iteration job for a future worker; pass --foreground to keep the Milestone 1 inline iteration.",
    ""
  ].join("\n");
}

function writeJson(writer: Writer, payload: JsonPayload): void {
  write(writer, `${JSON.stringify(payload, null, 2)}\n`);
}

function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}

function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}
