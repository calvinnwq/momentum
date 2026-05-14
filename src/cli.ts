import os from "node:os";
import process from "node:process";
import { isUniqueViolation, openDb, type MomentumDb } from "./db.js";
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
import { loadGoalLogs, type GoalLogsSuccess } from "./goal-logs.js";
import { writeHandoff, type HandoffSuccess } from "./handoff.js";
import { runWorkerOnce, type WorkerRunResult } from "./worker-run.js";
import {
  loadDaemonStatus,
  DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS,
  DEFAULT_DAEMON_STALE_AFTER_MS,
  type DaemonStatusSuccess
} from "./daemon-status.js";
import {
  getActiveDaemonRun,
  getDaemonRun,
  getLatestDaemonRun,
  requestDaemonRunImmediateStop,
  requestDaemonRunStop,
  startDaemonRun
} from "./daemon-runs.js";
import {
  runDaemonLoop,
  DEFAULT_DAEMON_POLL_INTERVAL_MS,
  type DaemonLoopResult
} from "./daemon-loop.js";

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
  now: boolean;
  repo?: string;
  runner?: string;
  workerId?: string;
  dataDir?: string;
  iteration?: number;
  reason?: string;
  maxLoopIterations?: number;
  maxIdleCycles?: number;
  pollIntervalMs?: number;
  error?: string;
};

const COMMANDS = [
  "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]",
  "momentum status [goal-id] [--data-dir <path>] [--json]",
  "momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]",
  "momentum handoff <goal-id> [--data-dir <path>] [--json]",
  "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]",
  "momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]",
  "momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]",
  "momentum daemon status [--data-dir <path>] [--json]",
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

  if (parsed.now && !(command === "daemon" && subcommand === "stop")) {
    return usageError("--now is only supported by `momentum daemon stop`.", parsed, io);
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

  if (command === "logs") {
    return logs(parsed, io);
  }

  if (command === "handoff") {
    return handoff(parsed, io);
  }

  if (command === "worker" && subcommand === "run") {
    return workerRun(parsed, io);
  }

  if (command === "daemon") {
    return daemon(parsed, io);
  }

  return usageError(`Unknown command: ${command}`, parsed, io);
}

function daemon(parsed: ParsedFlags, io: CliIo): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for daemon. Expected: start, stop, status.",
      parsed,
      io
    );
  }
  if (subcommand === "status") {
    return daemonStatus(parsed, io);
  }
  if (subcommand === "start") {
    return daemonStart(parsed, io);
  }
  if (subcommand === "stop") {
    return daemonStop(parsed, io);
  }
  return usageError(`Unknown daemon subcommand: ${subcommand}`, parsed, io);
}

function daemonStatus(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for daemon status: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const result = loadDaemonStatus({ dataDirOptions });
  if (!result.ok) {
    const payload = {
      ok: false,
      command: "daemon status",
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

  return emitDaemonStatus(parsed, io, result);
}

async function daemonStart(
  parsed: ParsedFlags,
  io: CliIo
): Promise<number> {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for daemon start: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitDaemonStartFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const loopRequested =
    parsed.maxLoopIterations !== undefined ||
    parsed.maxIdleCycles !== undefined ||
    parsed.pollIntervalMs !== undefined;
  const loopBoundRequested =
    parsed.maxLoopIterations !== undefined ||
    parsed.maxIdleCycles !== undefined;
  if (parsed.pollIntervalMs !== undefined && !loopBoundRequested) {
    return usageError(
      "--poll-interval-ms requires --max-loop-iterations or --max-idle-cycles.",
      parsed,
      io
    );
  }

  const now = Date.now();
  const pid = process.pid;
  const host = os.hostname() || null;

  const db = openDb(dataDir);
  try {
    const existing = getActiveDaemonRun(db);
    if (existing) {
      const heartbeatAgeMs = Math.max(0, now - existing.heartbeat_at);
      const stale = isExistingDaemonRunStale(existing, now);
      return emitDaemonStartFailure(parsed, io, {
        code: "daemon_already_active",
        message: stale
          ? `An active daemon run already exists (${existing.id}, state ${existing.state}, stale heartbeat). Resolve it before starting another.`
          : `An active daemon run already exists (${existing.id}, state ${existing.state}). Stop it before starting another.`,
        existing: {
          runId: existing.id,
          state: existing.state,
          pid: existing.pid,
          host: existing.host,
          startedAt: existing.started_at,
          heartbeatAt: existing.heartbeat_at,
          heartbeatAgeMs,
          stale
        }
      });
    }

    let runId: string;
    let run: ReturnType<typeof startDaemonRun>["run"];
    try {
      ({ runId, run } = startDaemonRun(db, { pid, host, now }));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = getActiveDaemonRun(db);
      const existingSummary = existing
        ? summarizeExistingDaemonRun(existing, now)
        : undefined;
      return emitDaemonStartFailure(parsed, io, {
        code: "daemon_already_active",
        message: existing
          ? `An active daemon run already exists (${existing.id}, state ${existing.state}). Stop it before starting another.`
          : "An active daemon run already exists. Stop it before starting another.",
        ...(existingSummary ? { existing: existingSummary } : {})
      });
    }

    if (!loopRequested) {
      return emitDaemonStartSuccess(parsed, io, {
        dataDir,
        runId,
        pid: run.pid,
        host: run.host,
        state: run.state,
        startedAt: run.started_at,
        heartbeatAt: run.heartbeat_at
      });
    }

    const loopResult = await runDaemonLoop({
      db,
      dataDir,
      runId,
      workerId: `daemon-${pid}`,
      ...(parsed.maxLoopIterations !== undefined
        ? { maxLoopIterations: parsed.maxLoopIterations }
        : {}),
      ...(parsed.maxIdleCycles !== undefined
        ? { maxIdleCycles: parsed.maxIdleCycles }
        : {}),
      pollIntervalMs:
        parsed.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS
    });

    return emitDaemonStartLoopResult(parsed, io, {
      dataDir,
      runId,
      pid: run.pid,
      host: run.host,
      startedAt: run.started_at,
      loop: loopResult
    });
  } finally {
    db.close();
  }
}

const DEFAULT_DAEMON_STOP_REASON = "operator-requested";
const DEFAULT_DAEMON_STOP_NOW_REASON = "operator-requested-immediate";

function daemonStop(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for daemon stop: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const immediate = parsed.now;
  const reason =
    parsed.reason !== undefined && parsed.reason.length > 0
      ? parsed.reason
      : immediate
        ? DEFAULT_DAEMON_STOP_NOW_REASON
        : DEFAULT_DAEMON_STOP_REASON;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitDaemonStopFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const now = Date.now();
  const db = openDb(dataDir);
  try {
    const active = getActiveDaemonRun(db);
    if (!active) {
      const latest = getLatestDaemonRun(db);
      return emitDaemonStopFailure(parsed, io, {
        code: "no_active_daemon",
        message: latest
          ? `No active daemon run to stop (latest ${latest.id} is ${latest.state}).`
          : "No active daemon run to stop. Run `momentum daemon start` first.",
        latest: latest
          ? {
              runId: latest.id,
              state: latest.state,
              pid: latest.pid,
              host: latest.host,
              startedAt: latest.started_at,
              finishedAt: latest.finished_at
            }
          : null
      });
    }

    const previousState = active.state;
    const alreadyStopRequested = previousState === "stop_requested";
    const alreadyStopNow = active.stop_now_requested_at !== null;
    const result = immediate
      ? requestDaemonRunImmediateStop(db, {
          runId: active.id,
          reason,
          now
        })
      : requestDaemonRunStop(db, {
          runId: active.id,
          reason,
          now
        });
    if (!result.ok) {
      // The active record disappeared (or transitioned terminal) between
      // selection and update. Treat as no active daemon and surface clearly.
      return emitDaemonStopFailure(parsed, io, {
        code: "no_active_daemon",
        message: `Active daemon run ${active.id} could not be transitioned to stop_requested (state may have just changed).`,
        latest: {
          runId: active.id,
          state: active.state,
          pid: active.pid,
          host: active.host,
          startedAt: active.started_at,
          finishedAt: active.finished_at
        }
      });
    }

    const updated = getDaemonRun(db, active.id);
    if (!updated) {
      throw new Error(
        `daemon stop: run ${active.id} disappeared after stop request`
      );
    }

    const heartbeatAgeMs = Math.max(0, now - updated.heartbeat_at);
    const stale = isExistingDaemonRunStale(updated, now);
    return emitDaemonStopSuccess(parsed, io, {
      dataDir,
      runId: updated.id,
      previousState,
      state: updated.state,
      pid: updated.pid,
      host: updated.host,
      startedAt: updated.started_at,
      stopRequestedAt: updated.stop_requested_at ?? now,
      stopReason: updated.stop_reason ?? reason,
      alreadyStopRequested,
      immediate,
      alreadyStopNow,
      stopNowRequestedAt: updated.stop_now_requested_at,
      heartbeatAt: updated.heartbeat_at,
      heartbeatAgeMs,
      stale
    });
  } finally {
    db.close();
  }
}

type DaemonStopSuccessPayload = {
  dataDir: string;
  runId: string;
  previousState: string;
  state: string;
  pid: number | null;
  host: string | null;
  startedAt: number;
  stopRequestedAt: number;
  stopReason: string;
  alreadyStopRequested: boolean;
  immediate: boolean;
  alreadyStopNow: boolean;
  stopNowRequestedAt: number | null;
  heartbeatAt: number;
  heartbeatAgeMs: number;
  stale: boolean;
};

type DaemonStopFailurePayload = {
  code: "no_active_daemon" | "data_dir_failed";
  message: string;
  latest?: {
    runId: string;
    state: string;
    pid: number | null;
    host: string | null;
    startedAt: number;
    finishedAt: number | null;
  } | null;
};

function emitDaemonStopSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  data: DaemonStopSuccessPayload
): number {
  const payload = {
    ok: true,
    command: "daemon stop",
    dataDir: data.dataDir,
    runId: data.runId,
    previousState: data.previousState,
    state: data.state,
    pid: data.pid,
    host: data.host,
    startedAt: data.startedAt,
    stopRequestedAt: data.stopRequestedAt,
    stopReason: data.stopReason,
    alreadyStopRequested: data.alreadyStopRequested,
    immediate: data.immediate,
    alreadyStopNow: data.alreadyStopNow,
    stopNowRequestedAt: data.stopNowRequestedAt,
    heartbeatAt: data.heartbeatAt,
    heartbeatAgeMs: data.heartbeatAgeMs,
    stale: data.stale
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const headline = data.immediate
    ? data.alreadyStopNow
      ? `Daemon stop-now request refreshed: ${data.runId}`
      : `Daemon stop-now requested: ${data.runId}`
    : data.alreadyStopRequested
      ? `Daemon stop request refreshed: ${data.runId}`
      : `Daemon stop requested: ${data.runId}`;
  const lines: string[] = [
    headline,
    `State: ${data.state}${data.stale ? " [stale]" : ""}`,
    `Previous state: ${data.previousState}`,
    `Reason: ${data.stopReason}`,
    `Requested at: ${data.stopRequestedAt}`,
    ...(data.immediate
      ? [
          `Stop-now requested at: ${data.stopNowRequestedAt ?? data.stopRequestedAt}`
        ]
      : []),
    `Pid: ${data.pid ?? "(unset)"}`,
    `Host: ${data.host ?? "(unset)"}`,
    `Data dir: ${data.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitDaemonStopFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: DaemonStopFailurePayload
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "daemon stop",
    code: failure.code,
    message: failure.message
  };
  if (failure.latest !== undefined) payload["latest"] = failure.latest;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type DaemonStartSuccessPayload = {
  dataDir: string;
  runId: string;
  pid: number | null;
  host: string | null;
  state: string;
  startedAt: number;
  heartbeatAt: number;
};

type DaemonStartFailurePayload = {
  code: "daemon_already_active" | "data_dir_failed";
  message: string;
  existing?: {
    runId: string;
    state: string;
    pid: number | null;
    host: string | null;
    startedAt: number;
    heartbeatAt: number;
    heartbeatAgeMs: number;
    stale: boolean;
  };
};

function emitDaemonStartSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  data: DaemonStartSuccessPayload
): number {
  const payload = {
    ok: true,
    command: "daemon start",
    dataDir: data.dataDir,
    runId: data.runId,
    pid: data.pid,
    host: data.host,
    state: data.state,
    startedAt: data.startedAt,
    heartbeatAt: data.heartbeatAt
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `Daemon run started: ${data.runId}`,
    `State: ${data.state}`,
    `Pid: ${data.pid ?? "(unset)"}`,
    `Host: ${data.host ?? "(unset)"}`,
    `Started at: ${data.startedAt}`,
    `Data dir: ${data.dataDir}`,
    ""
  ].join("\n"));
  return 0;
}

type DaemonStartLoopPayload = {
  dataDir: string;
  runId: string;
  pid: number | null;
  host: string | null;
  startedAt: number;
  loop: DaemonLoopResult;
};

function emitDaemonStartLoopResult(
  parsed: ParsedFlags,
  io: CliIo,
  data: DaemonStartLoopPayload
): number {
  const loop = data.loop;
  const loopSummary = {
    exitReason: loop.exitReason,
    terminalState: loop.terminalState,
    cancelOutcome: loop.cancelOutcome,
    workSucceeded: loop.workSucceeded,
    iterations: loop.iterations,
    jobsRun: loop.jobsRun,
    jobsFailed: loop.jobsFailed,
    jobsNotExecuted: loop.jobsNotExecuted,
    idleCycles: loop.idleCycles,
    lastObservedState: loop.lastObservedState,
    lastWorkerCode: loop.lastWorkerCode,
    ...(loop.error !== undefined ? { error: loop.error } : {})
  };

  const payload: Record<string, unknown> = {
    ok: loop.ok,
    workSucceeded: loop.workSucceeded,
    command: "daemon start",
    dataDir: data.dataDir,
    runId: data.runId,
    pid: data.pid,
    host: data.host,
    startedAt: data.startedAt,
    state: loop.terminalState,
    workerId: loop.workerId,
    loop: loopSummary
  };

  const exitCode = loop.ok && loop.workSucceeded ? 0 : 1;
  const output = loop.ok ? io.stdout : io.stderr;

  if (parsed.json) {
    writeJson(output, payload);
    return exitCode;
  }

  const lines: string[] = [
    `Daemon run started: ${data.runId}`,
    `State: ${loop.terminalState}`,
    `Exit reason: ${loop.exitReason}`,
    ...(loop.cancelOutcome !== null
      ? [`Cancel outcome: ${loop.cancelOutcome}`]
      : []),
    `Work succeeded: ${loop.workSucceeded ? "yes" : "no"}`,
    `Iterations: ${loop.iterations}`,
    `Jobs run: ${loop.jobsRun}`,
    `Jobs failed: ${loop.jobsFailed}`,
    `Jobs not executed: ${loop.jobsNotExecuted}`,
    `Idle cycles: ${loop.idleCycles}`,
    `Pid: ${data.pid ?? "(unset)"}`,
    `Host: ${data.host ?? "(unset)"}`,
    `Started at: ${data.startedAt}`,
    `Data dir: ${data.dataDir}`
  ];
  if (loop.error !== undefined) {
    lines.push(`Error: ${loop.error}`);
  }
  lines.push("");
  write(output, lines.join("\n"));
  return exitCode;
}

function emitDaemonStartFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: DaemonStartFailurePayload
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "daemon start",
    code: failure.code,
    message: failure.message
  };
  if (failure.existing) payload["existing"] = failure.existing;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function emitDaemonStatus(
  parsed: ParsedFlags,
  io: CliIo,
  data: DaemonStatusSuccess
): number {
  const payload = {
    ok: true,
    command: "daemon status",
    dataDir: data.dataDir,
    hasRun: data.hasRun,
    daemonRun: data.daemonRun,
    staleAfterMs: data.staleAfterMs,
    activeJobStaleAfterMs: data.activeJobStaleAfterMs,
    staleRuns: data.staleRuns,
    observedAt: data.observedAt
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  if (!data.daemonRun) {
    write(io.stdout, [
      "Daemon: never started",
      `Data dir: ${data.dataDir}`,
      ""
    ].join("\n"));
    return 0;
  }

  const run = data.daemonRun;
  const lines: string[] = [
    `Daemon run: ${run.runId}`,
    `State: ${run.state}${run.isActive ? " (active)" : " (terminal)"}${run.stale ? " [stale]" : ""}`,
    `Pid: ${run.pid ?? "(unset)"}`,
    `Host: ${run.host ?? "(unset)"}`,
    `Started at: ${run.startedAt}`,
    `Heartbeat at: ${run.heartbeatAt} (age ${run.heartbeatAgeMs}ms)`,
    `Active job: ${run.activeJob.jobId ?? "(none)"}`,
    `Active lock: ${run.activeJob.lockId ?? "(none)"}`,
    `Reconcile count: ${run.reconciliation.count}`
  ];
  if (run.stopRequest) {
    lines.push(
      `Stop requested at: ${run.stopRequest.requestedAt} (reason: ${run.stopRequest.reason})`
    );
  }
  if (run.stopNowRequest) {
    lines.push(
      `Stop-now requested at: ${run.stopNowRequest.requestedAt} (reason: ${run.stopNowRequest.reason})`
    );
  }
  if (run.cancelOutcome) {
    lines.push(`Cancel outcome: ${run.cancelOutcome.outcome}`);
  }
  if (run.finishedAt !== null) {
    lines.push(`Finished at: ${run.finishedAt}`);
  }
  if (run.error) {
    lines.push(`Error: ${run.error.message}`);
  }
  if (data.staleRuns.length > 0) {
    lines.push(`Stale runs: ${data.staleRuns.length}`);
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
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
      ok: result.code === "ran_job" ? result.ok : true,
      ...base
    } as Record<string, unknown>;

    writeJson(io.stdout, payload);
    return result.code === "no_work" || result.code === "not_executed"
      ? 0
      : result.ok
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
  const status = result.ok ? "succeeded" : "failed";
  write(io.stdout, [
    `Worker ${result.workerId} ${status} goal ${result.goalId} iteration ${result.iteration}`,
    `Job: ${result.jobId}`,
    `Lock: ${result.lockId}`,
    `Repo: ${result.repoRoot}`,
    `Goal state: ${result.goalState}`,
    `Job state: ${result.jobState}`,
    ""
  ].join("\n"));

  return result.ok ? 0 : 1;
}

function doctor(parsed: ParsedFlags, io: CliIo): number {
  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const daemonStatus = loadDaemonStatus({ dataDirOptions });
  const daemonPayload = daemonStatus.ok
    ? {
        ok: true as const,
        dataDir: daemonStatus.dataDir,
        hasRun: daemonStatus.hasRun,
        state: daemonStatus.daemonRun?.state ?? null,
        isActive: daemonStatus.daemonRun?.isActive ?? false,
        stale: daemonStatus.daemonRun?.stale ?? false,
        staleRunCount: daemonStatus.staleRuns.length,
        runId: daemonStatus.daemonRun?.runId ?? null
      }
    : {
        ok: false as const,
        code: daemonStatus.code,
        message: daemonStatus.error
      };

  const payload = {
    ok: true,
    command: "doctor",
    version: VERSION,
    node: process.version,
    platform: process.platform,
    milestone:
      "Milestone 3: managed daemon loop for queued jobs (NGX-272, NGX-273)",
    daemon: daemonPayload
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    "Momentum doctor: ok",
    `version: ${payload.version}`,
    `node: ${payload.node}`,
    `platform: ${payload.platform}`,
    `scope: ${payload.milestone}`
  ];
  if (daemonPayload.ok) {
    if (!daemonPayload.hasRun) {
      lines.push("daemon: never started");
    } else {
      const flags: string[] = [];
      if (daemonPayload.isActive) flags.push("active");
      if (daemonPayload.stale) flags.push("stale");
      const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      lines.push(`daemon: ${daemonPayload.state}${flagStr}`);
    }
    if (daemonPayload.staleRunCount > 0) {
      lines.push(`daemon stale runs: ${daemonPayload.staleRunCount}`);
    }
  } else {
    lines.push(`daemon: error (${daemonPayload.code})`);
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function summarizeExistingDaemonRun(
  run: ReturnType<typeof getActiveDaemonRun> extends infer T ? NonNullable<T> : never,
  now: number
): NonNullable<DaemonStartFailurePayload["existing"]> {
  const heartbeatAgeMs = Math.max(0, now - run.heartbeat_at);
  return {
    runId: run.id,
    state: run.state,
    pid: run.pid,
    host: run.host,
    startedAt: run.started_at,
    heartbeatAt: run.heartbeat_at,
    heartbeatAgeMs,
    stale: isExistingDaemonRunStale(run, now)
  };
}

function isExistingDaemonRunStale(
  run: ReturnType<typeof getActiveDaemonRun> extends infer T ? NonNullable<T> : never,
  now: number
): boolean {
  const heartbeatAgeMs = Math.max(0, now - run.heartbeat_at);
  const staleAfterMs =
    run.active_job_id !== null
      ? DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS
      : DEFAULT_DAEMON_STALE_AFTER_MS;
  return heartbeatAgeMs >= staleAfterMs;
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
    goalState: data.goalState,
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
    artifacts: data.artifacts,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    latestJob: data.latestJob,
    iteration: data.iteration,
    currentIterationDetail: data.currentIterationDetail,
    reducer: data.reducer,
    nextJob: data.nextJob,
    nextAction: data.nextAction,
    nextActionDetail: data.nextActionDetail,
    latestCommitSha: data.latestCommitSha,
    daemon: data.daemon
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

  if (data.daemon) {
    const flags: string[] = [];
    if (data.daemon.isActive) flags.push("active");
    if (data.daemon.isTerminal) flags.push("terminal");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`Daemon: ${data.daemon.state}${flagStr} [${data.daemon.runId}]`);
    if (data.daemon.stopRequest) {
      lines.push(
        `Daemon stop requested: ${data.daemon.stopRequest.requestedAt} ` +
          `(${data.daemon.stopRequest.reason})`
      );
    }
    if (data.daemon.stopNowRequest) {
      lines.push(
        `Daemon stop-now requested: ${data.daemon.stopNowRequest.requestedAt} ` +
          `(${data.daemon.stopNowRequest.reason})`
      );
    }
    if (data.daemon.cancelOutcome) {
      lines.push(`Daemon cancel outcome: ${data.daemon.cancelOutcome.outcome}`);
    }
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function logs(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for logs.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for logs: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: {
    goalId: string;
    iteration?: number;
    dataDirOptions: DataDirOptions;
  } = { goalId: goalIdArg, dataDirOptions };
  if (parsed.iteration !== undefined) input.iteration = parsed.iteration;

  const result = loadGoalLogs(input);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "logs",
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

  return emitLogs(parsed, io, result);
}

function emitLogs(
  parsed: ParsedFlags,
  io: CliIo,
  data: GoalLogsSuccess
): number {
  if (parsed.json) {
    const payload = {
      ok: true,
      command: "logs",
      goalId: data.goalId,
      iteration: data.iteration,
      availableIterations: data.availableIterations,
      dataDir: data.dataDir,
      artifactDir: data.artifactDir,
      iterationDir: data.iterationDir,
      runnerLog: {
        path: data.runnerLog.path,
        exists: data.runnerLog.exists,
        readable: data.runnerLog.readable,
        bytes: data.runnerLog.bytes,
        content: data.runnerLog.content,
        error: data.runnerLog.error
      },
      verificationLog: {
        path: data.verificationLog.path,
        exists: data.verificationLog.exists,
        readable: data.verificationLog.readable,
        bytes: data.verificationLog.bytes,
        content: data.verificationLog.content,
        error: data.verificationLog.error
      }
    };
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Goal: ${data.goalId}`,
    `Iteration: ${data.iteration}`,
    `Available iterations: ${data.availableIterations.length === 0 ? "(none)" : data.availableIterations.join(", ")}`,
    `Iteration dir: ${data.iterationDir}`,
    "",
    `## runner.log (${data.runnerLog.exists ? `${data.runnerLog.bytes} bytes` : "missing"}): ${data.runnerLog.path}`
  ];
  if (data.runnerLog.error !== undefined) {
    lines.push(`(unreadable: ${data.runnerLog.error})`);
  } else if (data.runnerLog.exists && data.runnerLog.content.length > 0) {
    lines.push(data.runnerLog.content.endsWith("\n")
      ? data.runnerLog.content.slice(0, -1)
      : data.runnerLog.content);
  } else if (data.runnerLog.exists) {
    lines.push("(empty)");
  }
  lines.push("");
  lines.push(
    `## verification.log (${data.verificationLog.exists ? `${data.verificationLog.bytes} bytes` : "missing"}): ${data.verificationLog.path}`
  );
  if (data.verificationLog.error !== undefined) {
    lines.push(`(unreadable: ${data.verificationLog.error})`);
  } else if (data.verificationLog.exists && data.verificationLog.content.length > 0) {
    lines.push(data.verificationLog.content.endsWith("\n")
      ? data.verificationLog.content.slice(0, -1)
      : data.verificationLog.content);
  } else if (data.verificationLog.exists) {
    lines.push("(empty)");
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
    nextAction: data.nextAction,
    goalState: data.goalState,
    currentIterationDetail: data.currentIterationDetail,
    nextActionDetail: data.nextActionDetail,
    latestCommitSha: data.latestCommitSha,
    daemon: data.daemon
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
  let now = false;
  let repo: string | undefined;
  let runner: string | undefined;
  let workerId: string | undefined;
  let dataDir: string | undefined;
  let iteration: number | undefined;
  let reason: string | undefined;
  let maxLoopIterations: number | undefined;
  let maxIdleCycles: number | undefined;
  let pollIntervalMs: number | undefined;
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

    if (arg === "--now") {
      now = true;
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

    if (arg === "--reason") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --reason.";
      } else {
        reason = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--iteration") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --iteration.";
      } else {
        const parsedIteration = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedIteration) || parsedIteration < 1) {
          error ??= `Invalid value for --iteration: ${value}`;
        } else {
          iteration = parsedIteration;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--max-loop-iterations") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --max-loop-iterations.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --max-loop-iterations: ${value}`;
        } else {
          maxLoopIterations = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--max-idle-cycles") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --max-idle-cycles.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --max-idle-cycles: ${value}`;
        } else {
          maxIdleCycles = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--poll-interval-ms") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --poll-interval-ms.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --poll-interval-ms: ${value}`;
        } else {
          pollIntervalMs = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    args.push(arg);
  }

  const parsed: ParsedFlags = { args, json, foreground, now };
  if (repo !== undefined) parsed.repo = repo;
  if (runner !== undefined) parsed.runner = runner;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  if (workerId !== undefined) parsed.workerId = workerId;
  if (iteration !== undefined) parsed.iteration = iteration;
  if (reason !== undefined) parsed.reason = reason;
  if (maxLoopIterations !== undefined) parsed.maxLoopIterations = maxLoopIterations;
  if (maxIdleCycles !== undefined) parsed.maxIdleCycles = maxIdleCycles;
  if (pollIntervalMs !== undefined) parsed.pollIntervalMs = pollIntervalMs;
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
