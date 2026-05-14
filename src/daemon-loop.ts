import type { MomentumDb } from "./db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  heartbeatDaemonRun,
  isTerminalDaemonRunState,
  recordDaemonRunReconciliation,
  setDaemonRunActiveJob,
  type DaemonCancelOutcome,
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
  | "stop_now_requested"
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
  workSucceeded: boolean;
  runId: string;
  workerId: string;
  exitReason: DaemonLoopExitReason;
  terminalState: Extract<DaemonRunState, "stopped" | "canceled" | "error">;
  iterations: number;
  jobsRun: number;
  jobsFailed: number;
  jobsNotExecuted: number;
  idleCycles: number;
  lastObservedState: DaemonRunState | null;
  lastWorkerCode: WorkerRunResult["code"] | null;
  cancelOutcome: DaemonCancelOutcome | null;
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
  let internalErrorMessage: string | null = null;

  const markInternalError = (error: unknown): void => {
    internalErrorMessage = error instanceof Error ? error.message : String(error);
    exitReason = "internal_error";
  };

  const completeCycle = (
    cycleIndex: number,
    observedState: DaemonRunState,
    workerResult: WorkerRunResult,
    startedAt: number
  ): boolean => {
    try {
      input.onCycleComplete?.({
        cycleIndex,
        observedState,
        workerResult,
        startedAt
      });
      return true;
    } catch (error) {
      markInternalError(error);
      return false;
    }
  };

  while (exitReason === null) {
    if (iterations >= maxLoopIterations) {
      exitReason = "max_loop_iterations";
      break;
    }
    if (idleCycles >= maxIdleCycles) {
      exitReason = "max_idle_cycles";
      break;
    }

    try {
      const cycleStart = now();
      const run = getDaemonRun(input.db, input.runId);
      if (!run) {
        exitReason = "run_missing";
        break;
      }
      lastObservedState = run.state;
      if (run.stop_now_requested_at !== null) {
        exitReason = "stop_now_requested";
        break;
      }
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

      const workerResult = runWorker({
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

      iterations += 1;
      lastWorkerCode = workerResult.code;

      if (workerResult.code === "ran_job") {
        jobsRun += 1;
        if (!workerResult.ok) {
          jobsFailed += 1;
        }
        if (!completeCycle(iterations - 1, run.state, workerResult, cycleStart)) {
          break;
        }
        continue;
      }

      if (workerResult.code === "not_executed") {
        jobsNotExecuted += 1;
        idleCycles += 1;
        if (!completeCycle(iterations - 1, run.state, workerResult, cycleStart)) {
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      idleCycles += 1;
      if (!completeCycle(iterations - 1, run.state, workerResult, cycleStart)) {
        break;
      }
      await sleep(pollIntervalMs);
    } catch (error) {
      markInternalError(error);
    }
  }

  let finishNow: number;
  try {
    finishNow = now();
  } catch (error) {
    if (internalErrorMessage === null) {
      markInternalError(error);
    }
    finishNow = Date.now();
  }
  let terminalState: Extract<DaemonRunState, "stopped" | "canceled" | "error">;
  let cancelOutcome: DaemonCancelOutcome | null = null;
  if (internalErrorMessage !== null) {
    terminalState = "error";
    try {
      finishDaemonRun(input.db, {
        runId: input.runId,
        terminalState,
        now: finishNow,
        error: internalErrorMessage
      });
    } catch {
      // Best effort: callers still receive an error result even if persistence
      // failed after the loop had already entered the internal-error path.
    }
  } else if (exitReason === "run_missing") {
    terminalState = "error";
  } else if (exitReason === "run_terminated" && lastObservedState === "canceled") {
    terminalState = "canceled";
  } else if (exitReason === "run_terminated" && lastObservedState === "error") {
    terminalState = "error";
  } else if (exitReason === "stop_now_requested") {
    terminalState = "canceled";
    cancelOutcome = jobsRun > 0 ? "active_job_completed" : "idle";
    try {
      finishDaemonRun(input.db, {
        runId: input.runId,
        terminalState,
        cancelOutcome,
        now: finishNow
      });
    } catch (error) {
      markInternalError(error);
      terminalState = "error";
      cancelOutcome = null;
    }
  } else {
    terminalState = "stopped";
    if (exitReason !== "run_terminated") {
      try {
        finishDaemonRun(input.db, {
          runId: input.runId,
          terminalState,
          now: finishNow
        });
      } catch (error) {
        markInternalError(error);
        terminalState = "error";
      }
    }
  }

  const result: DaemonLoopResult = {
    ok: terminalState !== "error",
    workSucceeded: jobsFailed === 0,
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
    lastWorkerCode,
    cancelOutcome
  };
  if (internalErrorMessage !== null) {
    result.error = internalErrorMessage;
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
