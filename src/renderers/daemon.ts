import type { DaemonLoopResult } from "../core/daemon/loop.js";
import type { DaemonStatusSuccess } from "../core/daemon/status.js";
import {
  DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS,
  DEFAULT_DAEMON_STALE_AFTER_MS
} from "../config/daemon-defaults.js";
import type { getActiveDaemonRun } from "../core/daemon/runs.js";
import type {
  StaleClaimedJobRecoverySkipped,
  StaleDaemonRunRecoverySkipped,
  StaleRepoLockRecoverySkipped,
  StartupRecoveryResult
} from "../core/daemon/stale-recovery.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export type DaemonStopSuccessPayload = {
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

export type DaemonStopFailurePayload = {
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

export function emitDaemonStopSuccess(
  parsed: JsonFlags,
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

export function emitDaemonStopFailure(
  parsed: JsonFlags,
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

export type DaemonStartSuccessPayload = {
  dataDir: string;
  runId: string;
  pid: number | null;
  host: string | null;
  state: string;
  startedAt: number;
  heartbeatAt: number;
};

export type DaemonStartFailurePayload = {
  code:
    | "daemon_already_active"
    | "data_dir_failed"
    | "daemon_live_wrapper_profile_invalid";
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

export function emitDaemonStartSuccess(
  parsed: JsonFlags,
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

export type DaemonStartLoopPayload = {
  dataDir: string;
  runId: string;
  pid: number | null;
  host: string | null;
  startedAt: number;
  loop: DaemonLoopResult;
};

export function emitDaemonStartLoopResult(
  parsed: JsonFlags,
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
    workflowStepsDispatched: loop.workflowStepsDispatched,
    lastWorkflowCode: loop.lastWorkflowCode,
    lastObservedState: loop.lastObservedState,
    lastWorkerCode: loop.lastWorkerCode,
    startupRecovery: summarizeStartupRecovery(loop.startupRecovery),
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
    `Workflow steps dispatched: ${loop.workflowStepsDispatched}`,
    `Last workflow code: ${loop.lastWorkflowCode ?? "(none)"}`,
    ...formatStartupRecoveryLines(loop.startupRecovery),
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

export type StartupRecoverySummary = {
  observedAt: number;
  graceMs: number;
  recoveredRepoLockCount: number;
  recoveredClaimedJobCount: number;
  recoveredDaemonRunCount: number;
  skippedRepoLocks: StaleRepoLockRecoverySkipped[];
  skippedClaimedJobs: StaleClaimedJobRecoverySkipped[];
  skippedDaemonRuns: StaleDaemonRunRecoverySkipped[];
};

export function summarizeStartupRecovery(
  recovery: StartupRecoveryResult | null
): StartupRecoverySummary | null {
  if (recovery === null) return null;
  return {
    observedAt: recovery.observedAt,
    graceMs: recovery.graceMs,
    recoveredRepoLockCount: recovery.repoLocks.recovered.length,
    recoveredClaimedJobCount: recovery.claimedJobs.recovered.length,
    recoveredDaemonRunCount: recovery.daemonRuns.recovered.length,
    skippedRepoLocks: recovery.repoLocks.skipped,
    skippedClaimedJobs: recovery.claimedJobs.skipped,
    skippedDaemonRuns: recovery.daemonRuns.skipped
  };
}

export function formatStartupRecoveryLines(
  recovery: StartupRecoveryResult | null
): string[] {
  if (recovery === null) return [];
  const recoveredLocks = recovery.repoLocks.recovered.length;
  const recoveredJobs = recovery.claimedJobs.recovered.length;
  const recoveredDaemons = recovery.daemonRuns.recovered.length;
  const skippedLocks = recovery.repoLocks.skipped.length;
  const skippedJobs = recovery.claimedJobs.skipped.length;
  const skippedDaemons = recovery.daemonRuns.skipped.length;
  if (
    recoveredLocks === 0 &&
    recoveredJobs === 0 &&
    recoveredDaemons === 0 &&
    skippedLocks === 0 &&
    skippedJobs === 0 &&
    skippedDaemons === 0
  ) {
    return [];
  }
  return [
    `Startup recovery: locks recovered=${recoveredLocks} skipped=${skippedLocks}; claims recovered=${recoveredJobs} skipped=${skippedJobs}; daemons recovered=${recoveredDaemons} skipped=${skippedDaemons}`
  ];
}

export function emitDaemonStartFailure(
  parsed: JsonFlags,
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

export function emitDaemonStatusFailure(
  parsed: JsonFlags,
  io: CliIo,
  failure: { code: string; message: string }
): number {
  const payload = {
    ok: false,
    command: "daemon status",
    code: failure.code,
    message: failure.message
  };
  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

export function emitDaemonStatus(
  parsed: JsonFlags,
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
    staleLeaseGraceMs: data.staleLeaseGraceMs,
    staleRuns: data.staleRuns,
    staleRepoLocks: data.staleRepoLocks,
    staleClaimedJobs: data.staleClaimedJobs,
    goalsNeedingRecovery: data.goalsNeedingRecovery,
    observedAt: data.observedAt
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  if (!data.daemonRun) {
    const noDaemonLines: string[] = [
      "Daemon: never started",
      `Data dir: ${data.dataDir}`
    ];
    if (data.staleRepoLocks.length > 0) {
      noDaemonLines.push(`Stale repo locks: ${data.staleRepoLocks.length}`);
    }
    if (data.staleClaimedJobs.length > 0) {
      noDaemonLines.push(`Stale claimed jobs: ${data.staleClaimedJobs.length}`);
    }
    if (data.goalsNeedingRecovery.length > 0) {
      noDaemonLines.push(
        `Goals needing manual recovery: ${data.goalsNeedingRecovery.length}`
      );
      for (const entry of data.goalsNeedingRecovery) {
        noDaemonLines.push(
          `  - ${entry.goalId} [${entry.goalState}] ${entry.recoveryMdPath}`
        );
      }
    }
    noDaemonLines.push("");
    write(io.stdout, noDaemonLines.join("\n"));
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
  if (data.staleRepoLocks.length > 0) {
    lines.push(`Stale repo locks: ${data.staleRepoLocks.length}`);
  }
  if (data.staleClaimedJobs.length > 0) {
    lines.push(`Stale claimed jobs: ${data.staleClaimedJobs.length}`);
  }
  if (data.goalsNeedingRecovery.length > 0) {
    lines.push(
      `Goals needing manual recovery: ${data.goalsNeedingRecovery.length}`
    );
    for (const entry of data.goalsNeedingRecovery) {
      lines.push(
        `  - ${entry.goalId} [${entry.goalState}] ${entry.recoveryMdPath}`
      );
    }
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function summarizeExistingDaemonRun(
  run: ReturnType<typeof getActiveDaemonRun> extends infer T ? NonNullable<T> : never,
  now: number
): NonNullable<DaemonStartFailurePayload["existing"]> {
  const heartbeatAgeMs = Math.max(0, now - run.heartbeat_at);
  const staleAfterMs =
    run.active_job_id !== null
      ? DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS
      : DEFAULT_DAEMON_STALE_AFTER_MS;
  return {
    runId: run.id,
    state: run.state,
    pid: run.pid,
    host: run.host,
    startedAt: run.started_at,
    heartbeatAt: run.heartbeat_at,
    heartbeatAgeMs,
    stale: heartbeatAgeMs >= staleAfterMs
  };
}
