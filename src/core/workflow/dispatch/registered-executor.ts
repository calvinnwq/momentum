import { Worker } from "node:worker_threads";

import { driveExecutorTicks } from "../../executors/sdk/driver.js";
import { validateExecutorConfig } from "../../executors/sdk/config-schema.js";
import {
  resolveRegisteredExecutor,
  type ExecutorRegistry,
} from "../../executors/sdk/registry.js";
import type {
  Executor,
  ExecutorEnvelopeSnapshot,
  ExecutorTickContext,
  ExecutorTickResult,
} from "../../executors/sdk/types.js";
import { loadExecutorInvocation } from "../../executors/loop/persist.js";
import { isTerminalExecutorInvocationState } from "../../executors/loop/reducer.js";
import { classifyWorkflowLease } from "../run/reducer.js";
import { getWorkflowLease, heartbeatWorkflowLease } from "../leases.js";
import { reconcileDispatchedWorkflowStep } from "./reconcile-execute.js";
import { recordDispatchedStepManualRecovery } from "./executor-recovery.js";
import { deriveDispatchInvocationId } from "./execute.js";
import { shouldDriveDispatchedExecutor } from "./dispatch-status.js";
import { parkRegisteredExecutorAtHumanGate } from "./executor-gate.js";
import {
  resolveClaimedWorkflowStepFamily,
  resolveWorkflowStepExecutorRuntime,
} from "./persist.js";
import type {
  AsyncWorkflowStepDispatch,
  ClaimedWorkflowStep,
  WorkflowStepDispatch,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult,
} from "./scheduler.js";

export type RegisteredExecutorHostBindingsResolver = (input: {
  claim: ClaimedWorkflowStep;
  context: WorkflowStepDispatchContext;
  executor: Executor;
  executorName: string;
  config: Readonly<Record<string, unknown>>;
}) => unknown | Promise<unknown>;

export type RegisteredExecutorWorkflowDispatchOptions = {
  registry: ExecutorRegistry;
  unavailableReasons?: ReadonlyMap<string, string>;
  resolveHostBindings?: RegisteredExecutorHostBindingsResolver;
  maxTicks?: number;
  resolveMaxTicks?: (input: {
    executorName: string;
    invocation: Readonly<{ invocationId: string; attempt: number }>;
    context: WorkflowStepDispatchContext;
  }) => number;
  signal?: AbortSignal;
};

export class RegisteredExecutorHostBindingsError extends Error {
  readonly recoveryCode: string;

  constructor(recoveryCode: string, message: string) {
    super(message);
    this.recoveryCode = recoveryCode;
  }
}

/** Production dispatch wrapper for every registered SDK executor. */
export function createRegisteredExecutorWorkflowDispatch(
  baseDispatch: WorkflowStepDispatch,
  options: RegisteredExecutorWorkflowDispatchOptions,
): AsyncWorkflowStepDispatch {
  return async (
    claim: ClaimedWorkflowStep,
    context: WorkflowStepDispatchContext,
  ): Promise<WorkflowStepDispatchResult> => {
    const logicalClockOffsetMs = context.now - Date.now();
    const logicalNow = () => Date.now() + logicalClockOffsetMs;
    const resolvedRuntime = resolveWorkflowStepExecutorRuntime(
      context.db,
      claim,
    );
    let runtime: {
      executorName: string;
      config: Readonly<Record<string, unknown>>;
    };
    if (resolvedRuntime.ok) {
      runtime = resolvedRuntime;
    } else {
      const durableIdentity = resolveClaimedWorkflowStepFamily(
        context.db,
        claim,
      );
      if (!durableIdentity.ok) return baseDispatch(claim, context);
      runtime = {
        executorName: durableIdentity.executorFamily,
        config: {},
      };
    }

    const registered = resolveRegisteredExecutor(
      options.registry,
      runtime.executorName,
    );
    let executor: Executor;
    let config: Readonly<Record<string, unknown>> = runtime.config;
    if (!resolvedRuntime.ok) {
      executor = createRuntimeUnavailableExecutor(
        runtime.executorName,
        `Executor runtime config could not be resolved: ${resolvedRuntime.reason}.`,
      );
      config = {};
    } else if (registered === undefined) {
      executor = createRuntimeUnavailableExecutor(
        runtime.executorName,
        options.unavailableReasons?.get(runtime.executorName) ??
          `Executor ${runtime.executorName} is not registered.`,
      );
      config = {};
    } else if (options.unavailableReasons?.has(runtime.executorName)) {
      executor = createRuntimeUnavailableExecutor(
        runtime.executorName,
        options.unavailableReasons.get(runtime.executorName)!,
      );
      config = {};
    } else {
      const validated = validateExecutorConfig(
        runtime.config,
        registered.configSchema,
      );
      if (!validated.ok) {
        const detail = validated.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ");
        executor = createRuntimeUnavailableExecutor(
          runtime.executorName,
          `Executor config is invalid: ${detail}`,
        );
        config = {};
      } else {
        executor = registered;
      }
    }

    const result = baseDispatch(claim, {
      ...context,
      executorOwnsRounds: true,
    });
    if (!shouldDriveDispatchedExecutor(result.status)) return result;

    const invocationId = deriveDispatchInvocationId(claim.runId, claim.stepId);
    const before = loadExecutorInvocation(context.db, invocationId);
    if (before === undefined) return result;
    if (!isTerminalExecutorInvocationState(before.state)) {
      let hostBindings: Readonly<unknown> = {};
      try {
        const leaseGuard = createDispatchLeaseGuard(claim, context);
        try {
          await leaseGuard.ready;
          try {
            hostBindings = ((await options.resolveHostBindings?.({
              claim,
              context,
              executor,
              executorName: runtime.executorName,
              config,
            })) ?? {}) as Readonly<unknown>;
          } catch (error) {
            executor = createHostBindingsUnavailableExecutor(
              runtime.executorName,
              error,
            );
            config = {};
          }
          const signal =
            options.signal === undefined
              ? leaseGuard.signal
              : AbortSignal.any([options.signal, leaseGuard.signal]);
          await driveExecutorTicks({
            db: context.db,
            invocationId,
            executor,
            config,
            hostBindings,
            maxTicks:
              options.resolveMaxTicks?.({
                executorName: runtime.executorName,
                invocation: before,
                context,
              }) ??
              options.maxTicks ??
              1,
            now: logicalNow,
            signal,
            authorizeWrite: leaseGuard.authorize,
          });
        } finally {
          await leaseGuard.stop();
        }
      } catch (error) {
        const settlementError = settleHostBindingsAfterFailure(hostBindings);
        const failureDetail =
          error instanceof Error ? error.message : String(error);
        if (renewDispatchLeaseForRecovery(claim, context, logicalNow)) {
          recordDispatchedStepManualRecovery({
            db: context.db,
            runId: claim.runId,
            stepId: claim.stepId,
            error: `Registered executor dispatch failed: ${failureDetail}${
              settlementError === null
                ? ""
                : `; repository ownership settlement also failed: ${settlementError}`
            }`,
            recoveryCode: "executor_threw",
            leaseIdentity: {
              holder: claim.lease.holder,
              acquiredAt: claim.lease.acquiredAt,
            },
            now: logicalNow(),
          });
        }
        return result;
      }
    }
    const after = loadExecutorInvocation(context.db, invocationId);
    if (after !== undefined && isTerminalExecutorInvocationState(after.state)) {
      reconcileDispatchedWorkflowStep({
        db: context.db,
        runId: claim.runId,
        stepId: claim.stepId,
        leaseIdentity: {
          holder: claim.lease.holder,
          acquiredAt: claim.lease.acquiredAt,
        },
        now: logicalNow(),
      });
    } else if (after?.state === "waiting_operator") {
      parkRegisteredExecutorAtHumanGate({
        db: context.db,
        claim,
        invocationId,
        now: logicalNow(),
      });
    }
    return result;
  };
}

function settleHostBindingsAfterFailure(
  hostBindings: Readonly<unknown>,
): string | null {
  if (hostBindings === null || typeof hostBindings !== "object") return null;
  const bindings = hostBindings as {
    settleRepoOwnership?: unknown;
    settleHandoff?: unknown;
  };
  const settle = bindings.settleRepoOwnership ?? bindings.settleHandoff;
  if (typeof settle === "function") {
    try {
      settle(false);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

function renewDispatchLeaseForRecovery(
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
  now: () => number,
): boolean {
  const ttlMs = Math.max(1, claim.lease.expiresAt - claim.lease.heartbeatAt);
  const heartbeatAt = now();
  return heartbeatWorkflowLease(context.db, {
    runId: claim.lease.runId,
    leaseKind: claim.lease.leaseKind,
    holder: claim.lease.holder,
    acquiredAt: claim.lease.acquiredAt,
    heartbeatAt,
    expiresAt: heartbeatAt + ttlMs,
  }).ok;
}

function createDispatchLeaseGuard(
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
): {
  signal: AbortSignal;
  ready: Promise<void>;
  authorize: () => void;
  stop: () => Promise<void>;
} {
  const controller = new AbortController();
  const ttlMs = Math.max(1, claim.lease.expiresAt - claim.lease.heartbeatAt);
  const offsetMs = context.now - Date.now();
  const now = () => Date.now() + offsetMs;
  const authorize = () => {
    const live = getWorkflowLease(
      context.db,
      claim.lease.runId,
      claim.lease.leaseKind,
    );
    if (
      live === undefined ||
      live.releasedAt !== null ||
      live.holder !== claim.lease.holder ||
      live.acquiredAt !== claim.lease.acquiredAt ||
      classifyWorkflowLease(live, { now: now() }) !== "fresh"
    ) {
      throw new Error(
        `Dispatch lease ownership was lost for ${claim.runId}/${claim.stepId}.`,
      );
    }
  };
  authorize();
  const database = context.db
    .prepare("PRAGMA database_list")
    .all()
    .find(
      (entry) =>
        (entry as { name?: unknown }).name === "main" &&
        typeof (entry as { file?: unknown }).file === "string",
    ) as { file: string } | undefined;
  if (database === undefined || database.file.length === 0) {
    throw new Error(
      "Dispatch lease heartbeat requires a file-backed database.",
    );
  }
  const worker = new Worker(DISPATCH_LEASE_HEARTBEAT_WORKER, {
    eval: true,
    workerData: {
      dbPath: database.file,
      runId: claim.lease.runId,
      leaseKind: claim.lease.leaseKind,
      holder: claim.lease.holder,
      acquiredAt: claim.lease.acquiredAt,
      ttlMs,
      offsetMs,
      intervalMs: Math.max(25, Math.floor(ttlMs / 3)),
    },
  });
  worker.unref();
  let stopped = false;
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "ready"
      ) {
        resolve();
      }
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "lost"
      ) {
        const detail = (message as { error?: unknown }).error;
        const error = new Error(
          typeof detail === "string"
            ? detail
            : `Dispatch lease heartbeat was refused for ${claim.runId}/${claim.stepId}.`,
        );
        controller.abort(error);
        reject(error);
      }
    });
  });
  return {
    signal: controller.signal,
    ready,
    authorize,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await ready;
      } catch {
        // The caller observes loss through authorize/signal; still stop the worker.
      }
      // Keep short-lived CLI processes alive until worker shutdown completes.
      worker.ref();
      const exited = new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
      worker.postMessage("stop");
      await exited;
    },
  };
}

const DISPATCH_LEASE_HEARTBEAT_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 1000");
const statement = db.prepare(
  "UPDATE workflow_leases SET heartbeat_at = ?, expires_at = ?, updated_at = ? " +
  "WHERE run_id = ? AND lease_kind = ? AND holder = ? AND acquired_at = ? " +
  "AND released_at IS NULL AND expires_at >= ?"
);
let timer;
let closed = false;
function close() {
  if (closed) return;
  closed = true;
  if (timer !== undefined) clearInterval(timer);
  db.close();
}
function heartbeat() {
  try {
    const heartbeatAt = Date.now() + workerData.offsetMs;
    const result = statement.run(
      heartbeatAt,
      heartbeatAt + workerData.ttlMs,
      heartbeatAt,
      workerData.runId,
      workerData.leaseKind,
      workerData.holder,
      workerData.acquiredAt,
      heartbeatAt
    );
    if (Number(result.changes) === 0) {
      parentPort.postMessage({ type: "lost", error: "Dispatch lease heartbeat was refused." });
      close();
      return false;
    }
    return true;
  } catch (error) {
    parentPort.postMessage({
      type: "lost",
      error: error instanceof Error ? error.message : String(error)
    });
    close();
    return false;
  }
}
parentPort.on("message", (message) => {
  if (message === "stop") {
    close();
    process.exit(0);
  }
});
if (heartbeat()) {
  parentPort.postMessage({ type: "ready" });
  timer = setInterval(heartbeat, workerData.intervalMs);
  timer.unref();
}
`;

function createRuntimeUnavailableExecutor(
  name: string,
  reason: string,
): Executor<Record<string, never>, Record<string, never>> {
  return {
    name,
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    tick(context) {
      return runtimeUnavailableTick(context, reason);
    },
  };
}

function createHostBindingsUnavailableExecutor(
  name: string,
  error: unknown,
): Executor<Record<string, never>, Record<string, never>> {
  const reason = error instanceof Error ? error.message : String(error);
  const recoveryCode =
    error instanceof RegisteredExecutorHostBindingsError
      ? error.recoveryCode
      : "runtime_unavailable";
  return {
    name,
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    tick(context) {
      const round = startGenericRound(context.state, context);
      context.envelope.observeRound(round.roundId, { summary: reason });
      return {
        roundId: round.roundId,
        recommendation: "manual_recovery_required",
        recommendedRoundState: "manual_recovery_required",
        recommendedInvocationState: "manual_recovery_required",
        recoveryCode,
        humanGate: "manual_recovery_required",
        reason,
      };
    },
  };
}

function runtimeUnavailableTick(
  context: ExecutorTickContext<Record<string, never>, Record<string, never>>,
  reason: string,
): ExecutorTickResult {
  const round = startGenericRound(context.state, context);
  context.envelope.observeRound(round.roundId, { summary: reason });
  return {
    roundId: round.roundId,
    recommendation: "manual_recovery_required",
    recommendedRoundState: "manual_recovery_required",
    recommendedInvocationState: "manual_recovery_required",
    recoveryCode: "runtime_unavailable",
    humanGate: "manual_recovery_required",
    reason,
  };
}

function startGenericRound(
  state: ExecutorEnvelopeSnapshot,
  context: ExecutorTickContext<Record<string, never>, Record<string, never>>,
) {
  const invocation = state.invocation;
  return context.envelope.startRound({
    roundId: `${invocation.invocationId}::round-${state.rounds.length + 1}`,
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: invocation.executorFamily,
    attempt: invocation.attempt,
    roundIndex: state.rounds.length,
    state: "running",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
}
