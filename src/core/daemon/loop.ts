import type { MomentumDb } from "../../adapters/db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  heartbeatDaemonRun,
  isTerminalDaemonRunState,
  recordDaemonRunReconciliation,
  setDaemonRunActiveJob,
  type DaemonCancelOutcome,
  type DaemonRunState,
} from "./runs.js";
import {
  runStartupRecovery,
  type StartupRecoveryResult,
} from "./stale-recovery.js";
import {
  runWorkflowSchedulerOnceAsync,
  type RunWorkflowSchedulerOnceAsyncInput,
  type RunWorkflowSchedulerOnceResult,
  type AsyncWorkflowStepDispatch,
} from "../workflow/dispatch/scheduler.js";
import type { WorkflowLeaseStalePolicy } from "../workflow/run/reducer.js";
import { WORKFLOW_DISPATCH_RESULT_STATUS } from "../workflow/dispatch/execute.js";

export const DEFAULT_DAEMON_POLL_INTERVAL_MS = 500;
export const DEFAULT_DAEMON_WORKER_LEASE_MS = 30_000;
/**
 * Grace tolerance applied when the daemon's startup recovery pass scans for
 * stale leases. Mirrors `DEFAULT_STALE_LEASE_GRACE_MS` from `config/daemon-defaults` so
 * a cycle that crosses the lease deadline by a few milliseconds isn't reaped
 * out from under a worker that is still mid-write.
 */
export const DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS = 5_000;

export type DaemonLoopNow = () => number;
export type DaemonLoopSleep = (ms: number) => Promise<void>;

/**
 * Configuration that enables the workflow-first scheduler lane. When supplied,
 * each daemon cycle runs one {@link runWorkflowSchedulerOnce} tick (recover →
 * scan → claim → dispatch). When omitted the lane is entirely inert and the
 * cycle only heartbeats and idles (no workflow tables are read or written).
 * Bounded CLI starts supply the production workflow-step dispatcher;
 * register-only starts still exit before the loop and never enter this lane.
 */
export type DaemonWorkflowLaneConfig = {
  /** Executor-dispatch seam handed each claimed workflow step. */
  dispatch: AsyncWorkflowStepDispatch;
  /**
   * Dispatch-lease TTL stamped on a claimed step. Defaults to the tick's own
   * default ({@link runWorkflowSchedulerOnce} → `DEFAULT_WORKFLOW_DISPATCH_LEASE_MS`).
   */
  leaseDurationMs?: number;
  /** Stale policy stamped on dispatch leases. Defaults to `auto-release`. */
  stalePolicy?: WorkflowLeaseStalePolicy;
};

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
  onCycleComplete?: (cycle: DaemonLoopCycle) => void;
  /**
   * Disable the one-shot stale-lease auto-recovery pass run before the loop
   * enters its first cycle. Defaults to `false` (recovery on). Tests that want
   * to assert raw loop semantics without the recovery side-effect can opt out.
   */
  skipStartupRecovery?: boolean;
  /**
   * Grace tolerance forwarded to `runStartupRecovery`. Defaults to
   * `DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS`.
   */
  startupRecoveryGraceMs?: number;
  /**
   * Startup recovery completed before this daemon run was registered. Managed
   * CLI starts may need that early pass to clear a stale active row before the
   * loop can exist, but the loop result remains the operator-facing envelope.
   */
  preLoopStartupRecovery?: StartupRecoveryResult;
  /**
   * Enables the workflow-first scheduler lane. Omit to leave the lane inert.
   * See {@link DaemonWorkflowLaneConfig}.
   */
  workflowLane?: DaemonWorkflowLaneConfig;
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
  startedAt: number;
  /**
   * The workflow scheduler-lane tick result for this cycle, present only when
   * the workflow lane is enabled (a `workflowLane` config was supplied).
   */
  workflowResult?: RunWorkflowSchedulerOnceResult;
};

/**
 * The retired goal-iteration drain lane's per-cycle code. The daemon no longer
 * claims `goal_iteration` jobs; every cycle reports the idle `"no_work"` value
 * the drain produced when the queue was empty, keeping the wire-stable
 * `daemon start` loop envelope byte-identical for the only reachable case.
 */
export type DaemonLoopWorkerCode = "no_work";

export type DaemonLoopResult = {
  ok: boolean;
  workSucceeded: boolean;
  runId: string;
  workerId: string;
  exitReason: DaemonLoopExitReason;
  terminalState: Extract<DaemonRunState, "stopped" | "canceled" | "error">;
  iterations: number;
  /** Retired goal-drain counters, pinned to their idle values (envelope-stable). */
  jobsRun: number;
  jobsFailed: number;
  jobsNotExecuted: number;
  idleCycles: number;
  /** Workflow steps dispatched by the scheduler lane across the run (0 if disabled). */
  workflowStepsDispatched: number;
  lastObservedState: DaemonRunState | null;
  lastWorkerCode: DaemonLoopWorkerCode | null;
  /** The last workflow scheduler-lane tick code, or null if the lane never ran. */
  lastWorkflowCode: RunWorkflowSchedulerOnceResult["code"] | null;
  cancelOutcome: DaemonCancelOutcome | null;
  startupRecovery: StartupRecoveryResult | null;
  error?: string;
};

export async function runDaemonLoop(
  input: DaemonLoopInput,
): Promise<DaemonLoopResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const pollIntervalMs = normalizePositive(
    input.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS,
    "pollIntervalMs",
  );
  normalizePositive(
    input.leaseDurationMs ?? DEFAULT_DAEMON_WORKER_LEASE_MS,
    "leaseDurationMs",
  );
  const maxLoopIterations = input.maxLoopIterations ?? Infinity;
  const maxIdleCycles = input.maxIdleCycles ?? Infinity;

  let iterations = 0;
  let idleCycles = 0;
  let workflowStepsDispatched = 0;
  let lastObservedState: DaemonRunState | null = null;
  let lastWorkerCode: DaemonLoopWorkerCode | null = null;
  let lastWorkflowCode: RunWorkflowSchedulerOnceResult["code"] | null = null;
  let exitReason: DaemonLoopExitReason | null = null;
  let internalErrorMessage: string | null = null;
  let startupRecovery: StartupRecoveryResult | null = null;

  // The workflow scheduler lane is opt-in: present only when a workflowLane
  // config is supplied. The dispatch is wrapped so the daemon refreshes its own
  // heartbeat as it hands a claimed step to the executor seam — a long
  // synchronous dispatch must not make the daemon run look stale.
  const workflowLane = input.workflowLane;
  const dispatchWithHeartbeat: AsyncWorkflowStepDispatch | undefined =
    workflowLane === undefined
      ? undefined
      : async (claim, context) => {
          setDaemonRunActiveJob(input.db, {
            runId: input.runId,
            jobId: `workflow:${claim.runId}:${claim.stepId}`,
            lockId: null,
            now: context.now,
          });
          heartbeatDaemonRun(input.db, {
            runId: input.runId,
            now: context.now,
          });
          try {
            return await workflowLane.dispatch(claim, context);
          } finally {
            const settledAt = now();
            setDaemonRunActiveJob(input.db, {
              runId: input.runId,
              jobId: null,
              lockId: null,
              now: settledAt,
            });
            heartbeatDaemonRun(input.db, {
              runId: input.runId,
              now: settledAt,
            });
          }
        };

  const markInternalError = (error: unknown): void => {
    internalErrorMessage =
      error instanceof Error ? error.message : String(error);
    exitReason = "internal_error";
  };

  if (input.skipStartupRecovery !== true) {
    try {
      const recoveryGraceMs =
        input.startupRecoveryGraceMs ??
        DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS;
      startupRecovery = mergeStartupRecoveryResults(
        input.preLoopStartupRecovery ?? null,
        runStartupRecovery(input.db, {
          now: now(),
          graceMs: recoveryGraceMs,
          dataDir: input.dataDir,
          daemonRuns: { excludeRunId: input.runId },
        }),
      );
    } catch (error) {
      markInternalError(error);
    }
  } else {
    startupRecovery = input.preLoopStartupRecovery ?? null;
  }

  const completeCycle = (
    cycleIndex: number,
    observedState: DaemonRunState,
    startedAt: number,
    workflowResult?: RunWorkflowSchedulerOnceResult,
  ): boolean => {
    try {
      input.onCycleComplete?.({
        cycleIndex,
        observedState,
        startedAt,
        ...(workflowResult !== undefined ? { workflowResult } : {}),
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
      if (isTerminalDaemonRunState(run.state)) {
        exitReason = "run_terminated";
        break;
      }
      if (run.stop_now_requested_at !== null) {
        exitReason = "stop_now_requested";
        break;
      }
      if (run.state === "stop_requested") {
        exitReason = "stop_requested";
        break;
      }

      heartbeatDaemonRun(input.db, { runId: input.runId, now: cycleStart });
      recordDaemonRunReconciliation(input.db, {
        runId: input.runId,
        now: cycleStart,
      });

      // The retired goal-iteration drain used to claim a queued job here.
      // Nothing claims goal jobs anymore; the cycle reports the drain's idle
      // code so the daemon start loop envelope keeps its stable value.
      iterations += 1;
      lastWorkerCode = "no_work";

      // Workflow scheduler lane: a separate lane over separate tables, run each
      // cycle. Inert unless enabled.
      let workflowResult: RunWorkflowSchedulerOnceResult | undefined;
      if (workflowLane !== undefined && dispatchWithHeartbeat !== undefined) {
        const schedulerInput: RunWorkflowSchedulerOnceAsyncInput = {
          db: input.db,
          workerId: input.workerId,
          dispatch: dispatchWithHeartbeat,
          now,
          continuationPollIntervalMs: Math.max(1, pollIntervalMs),
        };
        if (workflowLane.leaseDurationMs !== undefined) {
          schedulerInput.leaseDurationMs = workflowLane.leaseDurationMs;
        }
        if (workflowLane.stalePolicy !== undefined) {
          schedulerInput.stalePolicy = workflowLane.stalePolicy;
        }
        workflowResult = await runWorkflowSchedulerOnceAsync(schedulerInput);
        lastWorkflowCode = workflowResult.code;
        if (workflowResult.code === "dispatched") {
          workflowStepsDispatched += 1;
        }
      }

      // A cycle is active (no idle increment, no poll sleep) only when the
      // workflow lane starts or retries an invocation. A continuation-only SDK
      // tick has already done its bounded poll, so it observes the configured
      // interval before the next external-state read.
      const cycleDidUsefulWork =
        workflowResult?.code === "dispatched" ||
        (workflowResult?.code === "idle" &&
          workflowResult.continuationPending === true);
      const shouldSleep =
        workflowResult?.code !== "dispatched" ||
        workflowResult.dispatch.status ===
          WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched;
      if (!shouldSleep) {
        if (
          !completeCycle(iterations - 1, run.state, cycleStart, workflowResult)
        ) {
          break;
        }
        continue;
      }

      if (!cycleDidUsefulWork) idleCycles += 1;
      if (
        !completeCycle(iterations - 1, run.state, cycleStart, workflowResult)
      ) {
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
        error: internalErrorMessage,
      });
    } catch {
      // Best effort: callers still receive an error result even if persistence
      // failed after the loop had already entered the internal-error path.
    }
  } else if (exitReason === "run_missing") {
    terminalState = "error";
  } else if (
    exitReason === "run_terminated" &&
    lastObservedState === "canceled"
  ) {
    terminalState = "canceled";
    cancelOutcome = getDaemonRun(input.db, input.runId)?.cancel_outcome ?? null;
  } else if (exitReason === "run_terminated" && lastObservedState === "error") {
    terminalState = "error";
  } else if (exitReason === "stop_now_requested") {
    terminalState = "canceled";
    // The retired goal drain was the only lane that could report a completed
    // active job at stop-now time; without it every immediate stop is idle.
    cancelOutcome = "idle";
    try {
      finishDaemonRun(input.db, {
        runId: input.runId,
        terminalState,
        cancelOutcome,
        now: finishNow,
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
          now: finishNow,
        });
      } catch (error) {
        markInternalError(error);
        terminalState = "error";
      }
    }
  }

  const result: DaemonLoopResult = {
    ok: terminalState !== "error",
    workSucceeded: true,
    runId: input.runId,
    workerId: input.workerId,
    exitReason: exitReason ?? "stop_requested",
    terminalState,
    iterations,
    jobsRun: 0,
    jobsFailed: 0,
    jobsNotExecuted: 0,
    idleCycles,
    workflowStepsDispatched,
    lastObservedState,
    lastWorkerCode,
    lastWorkflowCode,
    cancelOutcome,
    startupRecovery,
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

function mergeStartupRecoveryResults(
  first: StartupRecoveryResult | null,
  second: StartupRecoveryResult | null,
): StartupRecoveryResult | null {
  if (first === null) return second;
  if (second === null) return first;
  return {
    observedAt: second.observedAt,
    graceMs: second.graceMs,
    repoLocks: {
      recovered: [...first.repoLocks.recovered, ...second.repoLocks.recovered],
      skipped: [...first.repoLocks.skipped, ...second.repoLocks.skipped],
    },
    claimedJobs: {
      recovered: [
        ...first.claimedJobs.recovered,
        ...second.claimedJobs.recovered,
      ],
      skipped: [...first.claimedJobs.skipped, ...second.claimedJobs.skipped],
    },
    daemonRuns: {
      recovered: [
        ...first.daemonRuns.recovered,
        ...second.daemonRuns.recovered,
      ],
      skipped: [...first.daemonRuns.skipped, ...second.daemonRuns.skipped],
    },
  };
}

function normalizePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `runDaemonLoop: ${name} must be a non-negative finite number`,
    );
  }
  return value;
}
