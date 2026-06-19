import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import {
  renderHelp,
  usageError,
  write,
  type CliIo
} from "./renderers/cli-output.js";
import {
  createMomentumCommandRegistry,
  dispatchMomentumCommand
} from "./commands/index.js";
import { handoff, logs, status } from "./commands/status.js";
import { goalStart } from "./commands/goal/index.js";
import { source } from "./commands/source/index.js";
import { project } from "./commands/project/index.js";
import { evidence } from "./commands/evidence/index.js";
import { intent } from "./commands/intent/index.js";
import { workflow } from "./commands/workflow/index.js";
import { intentApplyAuditToJsonShape } from "./renderers/intent.js";
import { sourceReconciliationPaginationStopped } from "./renderers/source.js";
import {
  emitDaemonStartFailure,
  emitDaemonStartLoopResult,
  emitDaemonStartSuccess,
  emitDaemonStatus,
  emitDaemonStatusFailure,
  emitDaemonStopFailure,
  emitDaemonStopSuccess,
  summarizeExistingDaemonRun
} from "./renderers/daemon.js";
import {
  emitRecoveryClear,
  emitRecoveryClearDataDirFailure
} from "./renderers/recovery.js";
import { emitWorkerRunResult } from "./renderers/worker.js";
import {
  emitDoctor,
  type DoctorEvidencePayload,
  type DoctorExternalApplyPayload,
  type DoctorPolicyPayload,
  type DoctorSourcesPayload
} from "./renderers/doctor.js";
import { isUniqueViolation, openDb } from "./adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "./config/data-dir.js";
import { runWorkerOnce } from "./core/daemon/worker-run.js";
import { loadDaemonStatus, loadStaleLeasePreCheck } from "./core/daemon/status.js";
import {
  DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS,
  DEFAULT_DAEMON_STALE_AFTER_MS
} from "./config/daemon-defaults.js";
import {
  getActiveDaemonRun,
  getDaemonRun,
  getLatestDaemonRun,
  requestDaemonRunImmediateStop,
  requestDaemonRunStop,
  startDaemonRun
} from "./core/daemon/runs.js";
import {
  runDaemonLoop,
  DEFAULT_DAEMON_POLL_INTERVAL_MS,
  DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS
} from "./core/daemon/loop.js";
import { runStartupRecovery } from "./core/daemon/stale-recovery.js";
import {
  clearGoalManualRecoveryGuarded,
  type ClearGoalManualRecoveryGuardedResult
} from "./core/goal/recovery.js";
import {
  BUILTIN_RUNNER_KINDS,
  DEFAULT_RUNNER_KIND,
  buildRunnerProfile,
  safeRunnerProfileSummary
} from "./core/executors/runner-profile.js";
import {
  DEFAULT_INTENT_APPLY_POLICY,
  loadMomentumPolicy,
  resolveIntentApplyPolicy
} from "./core/intent/policy.js";
import {
  listSourceReconciliationRuns,
  type SourceReconciliationRun
} from "./core/source/reconciliation-runs.js";
import { type LinearReconciliationClient } from "./core/source/reconciliation.js";
import {
  summarizeEvidenceRecords,
  type EvidenceRecordsSummary
} from "./core/evidence/records.js";
import { executeWorkflowStepDispatch } from "./core/workflow/dispatch-execute.js";
import { resolveDaemonWorkflowDispatch } from "./core/workflow/dogfood-dispatch.js";
import {
  readDaemonLiveWrapperProfileSource,
  resolveDaemonLiveWrapperProfile,
  DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR
} from "./core/workflow/daemon-live-wrapper-profile.js";
import {
  loadDispatchedStepRunProvenance,
  resolveDispatchedStepExecutorContext
} from "./core/workflow/daemon-dispatch-exec-context.js";
import { createLiveWrapperWorkflowDispatch } from "./core/workflow/live-wrapper-dispatch.js";
import { buildRealWorkflowStepExecutorRegistry } from "./core/workflow/step-executor-real-adapters.js";
import type { WorkflowStepDispatch } from "./core/workflow/scheduler.js";
import {
  countIntentApplyAuditsByLifecycleState,
  countIntentsByApplyState,
  listIntentApplyAudits
} from "./core/intent/apply-audits.js";
import { type LinearExternalUpdateClient } from "./adapters/linear-external-update-client.js";
import { type LinearIssueRefreshClient } from "./adapters/linear-issue-refresh.js";

export const VERSION = "0.0.0";
export const DOCTOR_MILESTONE =
  "Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete";

export type LinearReconciliationClientFactoryInput = {
  apiKey: string | null;
  endpoint: string | null;
  pageSize: number | null;
  env: NodeJS.ProcessEnv;
};

export type LinearExternalUpdateClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type LinearIssueRefreshClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type CliDeps = {
  buildLinearReconciliationClient?: (
    input: LinearReconciliationClientFactoryInput
  ) => LinearReconciliationClient;
  buildLinearExternalUpdateClient?: (
    input: LinearExternalUpdateClientFactoryInput
  ) => LinearExternalUpdateClient;
  buildLinearIssueRefreshClient?: (
    input: LinearIssueRefreshClientFactoryInput
  ) => LinearIssueRefreshClient | null;
};

type ParsedFlags = {
  args: string[];
  json: boolean;
  foreground: boolean;
  now: boolean;
  dryRun: boolean;
  externalApply: boolean;
  repo?: string;
  runner?: string;
  workerId?: string;
  dataDir?: string;
  iteration?: number;
  reason?: string;
  maxLoopIterations?: number;
  maxIdleCycles?: number;
  pollIntervalMs?: number;
  adapter?: string;
  project?: string;
  milestone?: string;
  linearEndpoint?: string;
  linearPageSize?: number;
  maxPages?: number;
  goal?: string;
  fromSource?: string;
  path?: string;
  sourceItem?: string;
  source?: string;
  evidenceType?: string;
  limit?: number;
  staleThresholdHours?: number;
  intentStaleThresholdDays?: number;
  status?: string;
  evidenceRecord?: string;
  state?: string;
  filter?: string;
  approvalBoundary?: string;
  issueScope?: string;
  updatedSince?: number;
  updatedUntil?: number;
  phrase?: string;
  actor?: string;
  approvalPath?: string;
  approvalDigest?: string;
  step?: string;
  action?: string;
  mode?: string;
  note?: string;
  evidencePointer?: string;
  ledgerPointer?: string;
  definition?: string;
  definitionVersion?: number;
  objective?: string;
  runId?: string;
  skillRevision?: string;
  error?: string;
};

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
  deps: CliDeps = {}
): Promise<number> {
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

  if (parsed.externalApply && !(command === "intent" && subcommand === "apply")) {
    return usageError(
      "--external-apply is only supported by `momentum intent apply`.",
      parsed,
      io
    );
  }

  const commandRegistry = createMomentumCommandRegistry<ParsedFlags, CliIo, CliDeps>({
    doctor,
    status,
    logs,
    handoff,
    extraRoutes: [{ command: "workflow", run: workflow }]
  });
  const routedCommand = await dispatchMomentumCommand(commandRegistry, {
    parsed,
    io,
    deps
  });
  if (routedCommand.handled) {
    return routedCommand.code;
  }

  if (command === "goal" && subcommand === "start") {
    return goalStart(parsed, io);
  }

  if (command === "source") {
    return source(parsed, io, deps);
  }

  if (command === "worker" && subcommand === "run") {
    return workerRun(parsed, io);
  }

  if (command === "daemon") {
    return daemon(parsed, io);
  }

  if (command === "recovery") {
    return recovery(parsed, io);
  }

  if (command === "project") {
    return project(parsed, io);
  }

  if (command === "evidence") {
    return evidence(parsed, io);
  }


  if (command === "intent") {
    return intent(parsed, io, deps);
  }

  return usageError(`Unknown command: ${command}`, parsed, io);
}



function recovery(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for recovery. Expected: clear.",
      parsed,
      io
    );
  }
  if (subcommand === "clear") {
    return recoveryClear(parsed, io);
  }
  return usageError(`Unknown recovery subcommand: ${subcommand}`, parsed, io);
}

function recoveryClear(parsed: ParsedFlags, io: CliIo): number {
  const goalId = parsed.args[2];
  if (!goalId) {
    return usageError(
      "Missing required <goal-id> for recovery clear.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for recovery clear: ${parsed.args[3]}`,
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
    return emitRecoveryClearDataDirFailure(parsed, io, {
      goalId,
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let result: ClearGoalManualRecoveryGuardedResult;
  try {
    const input: Parameters<typeof clearGoalManualRecoveryGuarded>[1] = {
      goalId
    };
    if (parsed.reason !== undefined && parsed.reason.length > 0) {
      input.operatorReason = parsed.reason;
    }
    result = clearGoalManualRecoveryGuarded(db, input);
  } finally {
    db.close();
  }

  return emitRecoveryClear(parsed, io, dataDir, goalId, result);
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
    return emitDaemonStatusFailure(parsed, io, {
      code: result.code,
      message: result.error
    });
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
    let existing = getActiveDaemonRun(db);
    if (existing && loopRequested && isExistingDaemonRunStale(existing, now)) {
      runStartupRecovery(db, {
        now,
        graceMs: DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS,
        dataDir
      });
      existing = getActiveDaemonRun(db);
    }
    if (existing) {
      const existingSummary = summarizeExistingDaemonRun(existing, now);
      return emitDaemonStartFailure(parsed, io, {
        code: "daemon_already_active",
        message: existingSummary.stale
          ? `An active daemon run already exists (${existing.id}, state ${existing.state}, stale heartbeat). Resolve it before starting another.`
          : `An active daemon run already exists (${existing.id}, state ${existing.state}). Stop it before starting another.`,
        existing: existingSummary
      });
    }

    let workflowDispatchResolution: DaemonStartWorkflowDispatchResolution = {
      ok: true,
      dispatch: executeWorkflowStepDispatch
    };
    if (loopRequested) {
      workflowDispatchResolution = resolveDaemonStartWorkflowDispatch(
        io.env ?? {},
        executeWorkflowStepDispatch
      );
      if (!workflowDispatchResolution.ok) {
        return emitDaemonStartFailure(parsed, io, {
          code: "daemon_live_wrapper_profile_invalid",
          message: workflowDispatchResolution.message
        });
      }
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
        parsed.pollIntervalMs ?? DEFAULT_DAEMON_POLL_INTERVAL_MS,
      // Production workflow-first dispatch (M10-09a, NGX-367): bounded loops
      // drive the workflow scheduler lane alongside goal-iteration draining.
      // Register-only `daemon start` returns above and never reaches here, so it
      // stays inert. The lane is harmlessly idle when no workflow run has a
      // runnable step. Without a live-wrapper profile, the dogfood resolver keeps
      // the default dispatch unchanged unless its explicit fixture opt-in is set.
      workflowLane: {
        dispatch: workflowDispatchResolution.dispatch
      }
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

type DaemonStartWorkflowDispatchResolution =
  | { ok: true; dispatch: WorkflowStepDispatch }
  | { ok: false; message: string };

function resolveDaemonStartWorkflowDispatch(
  env: Record<string, string | undefined>,
  baseDispatch: WorkflowStepDispatch
): DaemonStartWorkflowDispatchResolution {
  const profile = resolveDaemonLiveWrapperProfile(env, {
    loadSource: readDaemonLiveWrapperProfileSource
  });

  if (profile.status === "invalid") {
    return {
      ok: false,
      message: `Invalid ${DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR} (${profile.source}): ${profile.code}: ${profile.error}`
    };
  }

  if (profile.status === "not_configured") {
    return {
      ok: true,
      dispatch: resolveDaemonWorkflowDispatch(env, baseDispatch)
    };
  }

  const registry = buildRealWorkflowStepExecutorRegistry({
    profile: profile.profile
  });
  return {
    ok: true,
    dispatch: createLiveWrapperWorkflowDispatch(baseDispatch, {
      registry,
      deriveExec: (claim, context) => {
        const provenance = loadDispatchedStepRunProvenance(
          context.db,
          claim.runId
        );
        if (provenance === undefined) {
          return { ok: false, reason: "run_not_found" };
        }
        const resolved = resolveDispatchedStepExecutorContext(
          claim.runId,
          provenance
        );
        if (resolved.ok) {
          fs.mkdirSync(resolved.exec.runDir, { recursive: true });
        }
        return resolved;
      }
    })
  };
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
    const stalePreCheck = loadStaleLeasePreCheck({ db });
    const result = runWorkerOnce({
      db,
      dataDir,
      workerId,
      leaseDurationMs: 30_000
    });
    return emitWorkerRunResult(parsed, io, result, stalePreCheck);
  } finally {
    db.close();
  }
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
        staleRepoLockCount: daemonStatus.staleRepoLocks.length,
        staleClaimedJobCount: daemonStatus.staleClaimedJobs.length,
        goalsNeedingRecoveryCount: daemonStatus.goalsNeedingRecovery.length,
        runId: daemonStatus.daemonRun?.runId ?? null
      }
    : {
        ok: false as const,
        code: daemonStatus.code,
        message: daemonStatus.error
      };

  const policyPayload = buildDoctorPolicyPayload(parsed.repo);
  const sourcesPayload = buildDoctorSourcesPayload(dataDirOptions);
  const evidencePayload = buildDoctorEvidencePayload(dataDirOptions);
  const externalApplyPayload = buildDoctorExternalApplyPayload(dataDirOptions);

  const payload = {
    ok: true,
    command: "doctor",
    version: VERSION,
    node: process.version,
    platform: process.platform,
    milestone: DOCTOR_MILESTONE,
    daemon: daemonPayload,
    runners: {
      supported: [...BUILTIN_RUNNER_KINDS],
      default: DEFAULT_RUNNER_KIND,
      profiles: BUILTIN_RUNNER_KINDS.map((kind) =>
        safeRunnerProfileSummary(buildRunnerProfile(kind))
      )
    },
    policy: policyPayload,
    sources: sourcesPayload,
    evidence: evidencePayload,
    externalApply: externalApplyPayload
  } as const;

  return emitDoctor(parsed, io, payload);
}

function buildDoctorEvidencePayload(
  dataDirOptions: DataDirOptions
): DoctorEvidencePayload {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return {
      ok: false,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
  const db = openDb(dataDir);
  try {
    const summary: EvidenceRecordsSummary = summarizeEvidenceRecords(db);
    if (!summary.lastRecord) {
      return {
        ok: true,
        totalRecords: summary.totalRecords,
        goalLinkedRecords: summary.goalLinkedRecords,
        sourceItemLinkedRecords: summary.sourceItemLinkedRecords,
        lastRecord: null
      };
    }
    return {
      ok: true,
      totalRecords: summary.totalRecords,
      goalLinkedRecords: summary.goalLinkedRecords,
      sourceItemLinkedRecords: summary.sourceItemLinkedRecords,
      lastRecord: {
        id: summary.lastRecord.id,
        source: summary.lastRecord.source,
        type: summary.lastRecord.type,
        occurredAt: summary.lastRecord.occurredAt,
        summary: summary.lastRecord.summary,
        goalId: summary.lastRecord.goalId,
        sourceItemId: summary.lastRecord.sourceItemId
      }
    };
  } finally {
    db.close();
  }
}

function buildDoctorExternalApplyPayload(
  dataDirOptions: DataDirOptions
): DoctorExternalApplyPayload {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return {
      ok: false,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
  const db = openDb(dataDir);
  try {
    const intentApplyStateCounts = countIntentsByApplyState(db);
    const auditCounts = countIntentApplyAuditsByLifecycleState(db);
    const totalAttempts =
      auditCounts.claimed +
      auditCounts.succeeded +
      auditCounts.failed +
      auditCounts.blocked +
      auditCounts.audit_incomplete;
    const latestList = listIntentApplyAudits(db, { limit: 1 });
    const latest = latestList[0] ?? null;
    return {
      ok: true,
      intentApplyStateCounts,
      auditCounts,
      totalAttempts,
      latestAttempt: latest
        ? { intentId: latest.intentId, ...intentApplyAuditToJsonShape(latest) }
        : null
    };
  } finally {
    db.close();
  }
}

function buildDoctorSourcesPayload(
  dataDirOptions: DataDirOptions
): DoctorSourcesPayload {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return {
      ok: false,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }
  const db = openDb(dataDir);
  try {
    const counts = db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN goal_id IS NULL THEN 0 ELSE 1 END) AS linked
           FROM source_items`
      )
      .get() as { total: number; linked: number | null } | undefined;
    const totalSourceItems = counts?.total ?? 0;
    const linkedSourceItems = counts?.linked ?? 0;
    const unlinkedSourceItems = totalSourceItems - linkedSourceItems;

    const runs = listSourceReconciliationRuns(db);
    if (runs.length === 0) {
      return {
        ok: true,
        totalSourceItems,
        linkedSourceItems,
        unlinkedSourceItems,
        lastReconciliation: null
      };
    }
    const last = runs[runs.length - 1] as SourceReconciliationRun;
    return {
      ok: true,
      totalSourceItems,
      linkedSourceItems,
      unlinkedSourceItems,
      lastReconciliation: {
        id: last.id,
        adapterKind: last.adapterKind,
        state: last.state,
        startedAt: last.startedAt,
        finishedAt: last.finishedAt,
        error: last.error,
        itemsSeen: last.itemsSeen,
        itemsUpserted: last.itemsUpserted,
        paginationStopped: sourceReconciliationPaginationStopped(last)
      }
    };
  } finally {
    db.close();
  }
}

function buildDoctorPolicyPayload(repoOverride?: string): DoctorPolicyPayload {
  const defaultEffective = {
    value: DEFAULT_INTENT_APPLY_POLICY,
    source: "builtin_default" as const
  };
  if (typeof repoOverride !== "string" || repoOverride.trim().length === 0) {
    return {
      repoConfigured: false,
      repoPath: null,
      present: false,
      path: null,
      hasNotes: false,
      config: null,
      effectiveIntentApply: defaultEffective,
      error: null
    };
  }
  const repoPath = repoOverride;
  const load = loadMomentumPolicy(repoPath);
  if (!load.ok) {
    return {
      repoConfigured: true,
      repoPath,
      present: false,
      path: load.path,
      hasNotes: false,
      config: null,
      effectiveIntentApply: defaultEffective,
      error: { code: load.code, message: load.error }
    };
  }
  if (!load.present) {
    return {
      repoConfigured: true,
      repoPath,
      present: false,
      path: load.path,
      hasNotes: false,
      config: null,
      effectiveIntentApply: defaultEffective,
      error: null
    };
  }
  return {
    repoConfigured: true,
    repoPath,
    present: true,
    path: load.path,
    hasNotes: load.policy.notes.length > 0,
    config: {
      runner: load.policy.config.runner ?? null,
      verification:
        load.policy.config.verification === undefined
          ? null
          : [...load.policy.config.verification],
      verificationTimeoutSec: load.policy.config.verificationTimeoutSec ?? null,
      intentApplyPolicy: load.policy.config.intentApplyPolicy ?? null
    },
    effectiveIntentApply: resolveIntentApplyPolicy(load.policy.config),
    error: null
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

function parseFlags(argv: string[]): ParsedFlags {
  const args: string[] = [];
  let json = false;
  let foreground = false;
  let now = false;
  let dryRun = false;
  let externalApply = false;
  let repo: string | undefined;
  let runner: string | undefined;
  let workerId: string | undefined;
  let dataDir: string | undefined;
  let iteration: number | undefined;
  let reason: string | undefined;
  let maxLoopIterations: number | undefined;
  let maxIdleCycles: number | undefined;
  let pollIntervalMs: number | undefined;
  let adapter: string | undefined;
  let project: string | undefined;
  let milestone: string | undefined;
  let linearEndpoint: string | undefined;
  let linearPageSize: number | undefined;
  let maxPages: number | undefined;
  let goal: string | undefined;
  let fromSource: string | undefined;
  let pathFlag: string | undefined;
  let sourceItem: string | undefined;
  let source: string | undefined;
  let evidenceType: string | undefined;
  let limit: number | undefined;
  let staleThresholdHours: number | undefined;
  let intentStaleThresholdDays: number | undefined;
  let status: string | undefined;
  let evidenceRecord: string | undefined;
  let stateFlag: string | undefined;
  let filterFlag: string | undefined;
  let approvalBoundaryFlag: string | undefined;
  let issueScopeFlag: string | undefined;
  let updatedSinceFlag: number | undefined;
  let updatedUntilFlag: number | undefined;
  let actorFlag: string | undefined;
  let approvalPathFlag: string | undefined;
  let approvalDigestFlag: string | undefined;
  let phraseFlag: string | undefined;
  let stepFlag: string | undefined;
  let actionFlag: string | undefined;
  let modeFlag: string | undefined;
  let noteFlag: string | undefined;
  let evidencePointerFlag: string | undefined;
  let ledgerPointerFlag: string | undefined;
  let definitionFlag: string | undefined;
  let definitionVersionFlag: number | undefined;
  let objectiveFlag: string | undefined;
  let runIdFlag: string | undefined;
  let skillRevisionFlag: string | undefined;
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

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--external-apply") {
      externalApply = true;
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

    if (arg === "--adapter") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --adapter.";
      } else {
        adapter = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--project") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --project.";
      } else {
        project = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--milestone") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --milestone.";
      } else {
        milestone = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--linear-endpoint") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --linear-endpoint.";
      } else {
        linearEndpoint = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--linear-page-size") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --linear-page-size.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 1) {
          error ??= `Invalid value for --linear-page-size: ${value}`;
        } else {
          linearPageSize = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--max-pages") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --max-pages.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 1) {
          error ??= `Invalid value for --max-pages: ${value}`;
        } else {
          maxPages = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--goal") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --goal.";
      } else {
        goal = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--from-source") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --from-source.";
      } else {
        fromSource = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--path") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --path.";
      } else {
        pathFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--source-item") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --source-item.";
      } else {
        sourceItem = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--source") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --source.";
      } else {
        source = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--type") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --type.";
      } else {
        evidenceType = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--limit") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --limit.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --limit: ${value}`;
        } else {
          limit = parsedValue;
        }
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

    if (arg === "--status") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --status.";
      } else {
        status = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--evidence-record") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --evidence-record.";
      } else {
        evidenceRecord = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--state") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --state.";
      } else {
        stateFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--filter") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --filter.";
      } else {
        filterFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--approval-boundary") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --approval-boundary.";
      } else {
        approvalBoundaryFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--actor") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --actor.";
      } else {
        actorFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--phrase") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --phrase.";
      } else {
        phraseFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--artifact-path") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --artifact-path.";
      } else {
        approvalPathFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--artifact-digest") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --artifact-digest.";
      } else {
        approvalDigestFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--step") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --step.";
      } else {
        stepFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--action") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --action.";
      } else {
        actionFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--mode") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --mode.";
      } else {
        modeFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--note") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --note.";
      } else {
        noteFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--evidence-pointer") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --evidence-pointer.";
      } else {
        evidencePointerFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--ledger-pointer") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --ledger-pointer.";
      } else {
        ledgerPointerFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--issue-scope") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --issue-scope.";
      } else {
        issueScopeFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--definition") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --definition.";
      } else {
        definitionFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--definition-version") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --definition-version.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 1) {
          error ??= `Invalid value for --definition-version: ${value}`;
        } else {
          definitionVersionFlag = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--objective") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --objective.";
      } else {
        objectiveFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--run-id") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --run-id.";
      } else {
        runIdFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--skill-revision") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --skill-revision.";
      } else {
        skillRevisionFlag = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--updated-since") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --updated-since.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --updated-since: ${value}`;
        } else {
          updatedSinceFlag = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--updated-until") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --updated-until.";
      } else {
        const parsedValue = /^\d+$/.test(value)
          ? Number.parseInt(value, 10)
          : NaN;
        if (!Number.isInteger(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --updated-until: ${value}`;
        } else {
          updatedUntilFlag = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--stale-threshold-hours") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --stale-threshold-hours.";
      } else {
        const parsedValue = /^\d+(?:\.\d+)?$/.test(value)
          ? Number.parseFloat(value)
          : NaN;
        if (!Number.isFinite(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --stale-threshold-hours: ${value}`;
        } else {
          staleThresholdHours = parsedValue;
        }
        index += 1;
      }
      continue;
    }

    if (arg === "--intent-stale-threshold-days") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --intent-stale-threshold-days.";
      } else {
        const parsedValue = /^\d+(?:\.\d+)?$/.test(value)
          ? Number.parseFloat(value)
          : NaN;
        if (!Number.isFinite(parsedValue) || parsedValue < 0) {
          error ??= `Invalid value for --intent-stale-threshold-days: ${value}`;
        } else {
          intentStaleThresholdDays = parsedValue;
        }
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

  const parsed: ParsedFlags = { args, json, foreground, now, dryRun, externalApply };
  if (repo !== undefined) parsed.repo = repo;
  if (runner !== undefined) parsed.runner = runner;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  if (workerId !== undefined) parsed.workerId = workerId;
  if (iteration !== undefined) parsed.iteration = iteration;
  if (reason !== undefined) parsed.reason = reason;
  if (maxLoopIterations !== undefined) parsed.maxLoopIterations = maxLoopIterations;
  if (maxIdleCycles !== undefined) parsed.maxIdleCycles = maxIdleCycles;
  if (pollIntervalMs !== undefined) parsed.pollIntervalMs = pollIntervalMs;
  if (adapter !== undefined) parsed.adapter = adapter;
  if (project !== undefined) parsed.project = project;
  if (milestone !== undefined) parsed.milestone = milestone;
  if (linearEndpoint !== undefined) parsed.linearEndpoint = linearEndpoint;
  if (linearPageSize !== undefined) parsed.linearPageSize = linearPageSize;
  if (maxPages !== undefined) parsed.maxPages = maxPages;
  if (goal !== undefined) parsed.goal = goal;
  if (fromSource !== undefined) parsed.fromSource = fromSource;
  if (pathFlag !== undefined) parsed.path = pathFlag;
  if (sourceItem !== undefined) parsed.sourceItem = sourceItem;
  if (source !== undefined) parsed.source = source;
  if (evidenceType !== undefined) parsed.evidenceType = evidenceType;
  if (limit !== undefined) parsed.limit = limit;
  if (staleThresholdHours !== undefined) {
    parsed.staleThresholdHours = staleThresholdHours;
  }
  if (intentStaleThresholdDays !== undefined) {
    parsed.intentStaleThresholdDays = intentStaleThresholdDays;
  }
  if (status !== undefined) parsed.status = status;
  if (evidenceRecord !== undefined) parsed.evidenceRecord = evidenceRecord;
  if (stateFlag !== undefined) parsed.state = stateFlag;
  if (filterFlag !== undefined) parsed.filter = filterFlag;
  if (approvalBoundaryFlag !== undefined) {
    parsed.approvalBoundary = approvalBoundaryFlag;
  }
  if (issueScopeFlag !== undefined) parsed.issueScope = issueScopeFlag;
  if (updatedSinceFlag !== undefined) parsed.updatedSince = updatedSinceFlag;
  if (updatedUntilFlag !== undefined) parsed.updatedUntil = updatedUntilFlag;
  if (actorFlag !== undefined) parsed.actor = actorFlag;
  if (approvalPathFlag !== undefined) parsed.approvalPath = approvalPathFlag;
  if (approvalDigestFlag !== undefined) parsed.approvalDigest = approvalDigestFlag;
  if (phraseFlag !== undefined) parsed.phrase = phraseFlag;
  if (stepFlag !== undefined) parsed.step = stepFlag;
  if (actionFlag !== undefined) parsed.action = actionFlag;
  if (modeFlag !== undefined) parsed.mode = modeFlag;
  if (noteFlag !== undefined) parsed.note = noteFlag;
  if (evidencePointerFlag !== undefined) {
    parsed.evidencePointer = evidencePointerFlag;
  }
  if (ledgerPointerFlag !== undefined) parsed.ledgerPointer = ledgerPointerFlag;
  if (definitionFlag !== undefined) parsed.definition = definitionFlag;
  if (definitionVersionFlag !== undefined) {
    parsed.definitionVersion = definitionVersionFlag;
  }
  if (objectiveFlag !== undefined) parsed.objective = objectiveFlag;
  if (runIdFlag !== undefined) parsed.runId = runIdFlag;
  if (skillRevisionFlag !== undefined) parsed.skillRevision = skillRevisionFlag;
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

function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}
