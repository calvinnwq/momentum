import type { MomentumDb } from "./db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  heartbeatDaemonRun,
  isTerminalDaemonRunState,
  recordDaemonRunReconciliation,
  setDaemonRunActiveJob,
  type DaemonRunState
} from "./daemon-runs.js";
import {
  runWorkerOnce,
  type WorkerRunInput,
  type WorkerRunResult
} from "./worker-run.js";

export const DEFAULT_DAEMON_POLL_INTERVAL_MS = 500;
export const DEFAULT_DAEMON_WORKER_LEASE_MS = 30_000;

export type DaemonLoopNow = () => number;
export type DaemonLoopSleep = (ms: number) => Promise<void>;
export type DaemonLoopRunWorker = (input: WorkerRunInput) => WorkerRunResult;

export type DaemonLoopInput = {
  db: MomentumDb;
  dataDir: string;
  runId: string;
  workerId: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  maxLoopIterations?: number;
  maxIdleCycles?: number;
  now?: DaemonLoopNow;
  sleep?: DaemonLoopSleep;
  runWorker?: DaemonLoopRunWorker;
  onCycleComplete?: (cycle: DaemonLoopCycle) => void;
};

export type DaemonLoopExitReason =
  | "stop_requested"
  | "run_terminated"
  | "run_missing"
  | "max_loop_iterations"
  | "max_idle_cycles"
  | "internal_error";

export type DaemonLoopCycle = {
  cycleIndex: number;
  observedState: DaemonRunState;
  workerResult: WorkerRunResult;
  startedAt: number;
};

export type DaemonLoopResult = {
  ok: boolean;
  runId: string;
  workerId: string;
  exitReason: DaemonLoopExitReason;
  terminalState: Extract<DaemonRunState, "stopped" | "error">;
  iterations: number;
  jobsRun: number;
  jobsFailed: number;
  jobsNotExecuted: number;
  idleCycles: number;
  lastObservedState: DaemonRunState | null;
  lastWorkerCode: WorkerRunResult["code"] | null;
  error?: string;
};

export async function runDaemonLoop(
  input: DaemonLoopInput
): Promise<DaemonLoopResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const runWorker = input.runWorker ?? runWorkerOnce;
  const pollIntervalMs = normalizePositive(
    input.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS,
    "pollIntervalMs"
  );
  const leaseDurationMs = normalizePositive(
    input.leaseDurationMs ?? DEFAULT_DAEMON_WORKER_LEASE_MS,
    "leaseDurationMs"
  );
  const maxLoopIterations = input.maxLoopIterations ?? Infinity;
  const maxIdleCycles = input.maxIdleCycles ?? Infinity;

  let iterations = 0;
  let jobsRun = 0;
  let jobsFailed = 0;
  let jobsNotExecuted = 0;
  let idleCycles = 0;
  let lastObservedState: DaemonRunState | null = null;
  let lastWorkerCode: WorkerRunResult["code"] | null = null;
  let exitReason: DaemonLoopExitReason | null = null;
  let internalError: Error | null = null;

  while (exitReason === null) {
    if (iterations >= maxLoopIterations) {
      exitReason = "max_loop_iterations";
      break;
    }
    if (idleCycles >= maxIdleCycles) {
      exitReason = "max_idle_cycles";
      break;
    }

    const cycleStart = now();
    const run = getDaemonRun(input.db, input.runId);
    if (!run) {
      exitReason = "run_missing";
      break;
    }
    lastObservedState = run.state;
    if (run.state === "stop_requested") {
      exitReason = "stop_requested";
      break;
    }
    if (isTerminalDaemonRunState(run.state)) {
      exitReason = "run_terminated";
      break;
    }

    heartbeatDaemonRun(input.db, { runId: input.runId, now: cycleStart });
    recordDaemonRunReconciliation(input.db, {
      runId: input.runId,
      now: cycleStart
    });

    let workerResult: WorkerRunResult;
    try {
      workerResult = runWorker({
        db: input.db,
        dataDir: input.dataDir,
        workerId: input.workerId,
        leaseDurationMs,
        now,
        hooks: {
          onJobClaimed: (info) => {
            setDaemonRunActiveJob(input.db, {
              runId: input.runId,
              jobId: info.jobId,
              lockId: info.lockId,
              now: info.now
            });
            heartbeatDaemonRun(input.db, {
              runId: input.runId,
              now: info.now
            });
          },
          onJobReleased: (info) => {
            setDaemonRunActiveJob(input.db, {
              runId: input.runId,
              jobId: null,
              lockId: null,
              now: info.now
            });
            heartbeatDaemonRun(input.db, {
              runId: input.runId,
              now: info.now
            });
          }
        }
      });
    } catch (error) {
      internalError = error instanceof Error ? error : new Error(String(error));
      exitReason = "internal_error";
      break;
    }

    iterations += 1;
    lastWorkerCode = workerResult.code;

    if (workerResult.code === "ran_job") {
      if (workerResult.ok) {
        jobsRun += 1;
      } else {
        jobsFailed += 1;
      }
      input.onCycleComplete?.({
        cycleIndex: iterations - 1,
        observedState: run.state,
        workerResult,
        startedAt: cycleStart
      });
      continue;
    }

    if (workerResult.code === "not_executed") {
      jobsNotExecuted += 1;
      input.onCycleComplete?.({
        cycleIndex: iterations - 1,
        observedState: run.state,
        workerResult,
        startedAt: cycleStart
      });
      await sleep(pollIntervalMs);
      continue;
    }

    idleCycles += 1;
    input.onCycleComplete?.({
      cycleIndex: iterations - 1,
      observedState: run.state,
      workerResult,
      startedAt: cycleStart
    });
    await sleep(pollIntervalMs);
  }

  const finishNow = now();
  let terminalState: Extract<DaemonRunState, "stopped" | "error">;
  if (exitReason === "internal_error") {
    terminalState = "error";
    finishDaemonRun(input.db, {
      runId: input.runId,
      terminalState,
      now: finishNow,
      error: internalError?.message ?? "unknown internal error"
    });
  } else if (exitReason === "run_terminated" && lastObservedState === "error") {
    terminalState = "error";
  } else {
    terminalState = "stopped";
    finishDaemonRun(input.db, {
      runId: input.runId,
      terminalState,
      now: finishNow
    });
  }

  const result: DaemonLoopResult = {
    ok: exitReason !== "internal_error",
    runId: input.runId,
    workerId: input.workerId,
    exitReason: exitReason ?? "stop_requested",
    terminalState,
    iterations,
    jobsRun,
    jobsFailed,
    jobsNotExecuted,
    idleCycles,
    lastObservedState,
    lastWorkerCode
  };
  if (internalError !== null) {
    result.error = internalError.message;
  }
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`runDaemonLoop: ${name} must be a non-negative finite number`);
  }
  return value;
}
