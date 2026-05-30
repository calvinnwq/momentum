import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type GoalStatusExternalApply,
  type GoalStatusPendingIntentExternalApply,
  type GoalStatusPendingIntentSummary,
  type GoalStatusSuccess
} from "./goal-status.js";
import { loadGoalLogs, type GoalLogsSuccess } from "./goal-logs.js";
import { writeHandoff, type HandoffSuccess } from "./handoff.js";
import { runWorkerOnce, type WorkerRunResult } from "./worker-run.js";
import {
  loadDaemonStatus,
  loadStaleLeasePreCheck,
  DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS,
  DEFAULT_DAEMON_STALE_AFTER_MS,
  type DaemonStatusSuccess,
  type StaleLeasePreCheckSnapshot
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
  DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS,
  type DaemonLoopResult
} from "./daemon-loop.js";
import {
  runStartupRecovery,
  type StaleClaimedJobRecoverySkipped,
  type StaleDaemonRunRecoverySkipped,
  type StaleRepoLockRecoverySkipped,
  type StartupRecoveryResult
} from "./stale-recovery.js";
import {
  clearGoalManualRecoveryGuarded,
  type ClearGoalManualRecoveryGuardedResult
} from "./goal-recovery.js";
import {
  BUILTIN_RUNNER_KINDS,
  DEFAULT_RUNNER_KIND,
  buildRunnerProfile,
  safeRunnerProfileSummary
} from "./runner-profile.js";
import {
  DEFAULT_INTENT_APPLY_POLICY,
  loadMomentumPolicy,
  resolveIntentApplyPolicy,
  type PolicyEffectiveFieldSource,
  type UpdateIntentApplyPolicy
} from "./momentum-policy.js";
import {
  getSourceItemById,
  linkGoalToSourceItem,
  listSourceItems,
  unlinkGoalFromSourceItem,
  type LinkGoalToSourceItemErrorCode,
  type SourceItem,
  type UnlinkGoalFromSourceItemErrorCode
} from "./source-items.js";
import {
  listSourceReconciliationRuns,
  type SourceReconciliationRun
} from "./source-reconciliation-runs.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFilters,
  type ReconcileLinearSourceInput,
  type ReconcileLinearSourceResult
} from "./source-reconciliation.js";
import { buildLinearHttpReconciliationClient } from "./linear-http-client.js";
import {
  ingestEvidenceRecord,
  listEvidenceRecords,
  summarizeEvidenceRecords,
  type EvidenceRecord,
  type EvidenceRecordIngestInput,
  type EvidenceRecordsSummary,
  type ListEvidenceRecordsOptions
} from "./evidence-records.js";
import {
  parseWorkflowArtifact,
  type WorkflowEvidenceDiagnostic
} from "./evidence-workflow.js";
import {
  parseWorkflowRunImport,
  type WorkflowRunImport,
  type WorkflowRunImportDiagnostic,
  type WorkflowRunImportErrorCode
} from "./workflow-run-import.js";
import {
  persistWorkflowRunImport,
  type PersistWorkflowRunImportSummary
} from "./workflow-run-import-persist.js";
import {
  WORKFLOW_STATUS_FILTER_KEYS,
  listWorkflowRunSummaries,
  loadWorkflowRunDetail,
  type WorkflowApprovalRow,
  type WorkflowEvidenceLink,
  type WorkflowLeaseRow,
  type WorkflowRunDetail,
  type WorkflowRunRow,
  type WorkflowRunSummary,
  type WorkflowStatusFilterKey,
  type WorkflowStepRow
} from "./workflow-status.js";
import {
  deriveWorkflowRunState,
  highestWorkflowApprovalBoundary,
  isTerminalStepState,
  isWorkflowApprovalBoundary,
  isTerminalRunState,
  transitionWorkflowStep,
  WORKFLOW_RUN_STATES,
  workflowStepKindsForApprovalBoundary,
  type WorkflowRunState,
  type WorkflowLeaseRecord,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState,
  type WorkflowApprovalBoundary
} from "./workflow-run-reducer.js";
import {
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  loadWorkflowHandoff,
  type WorkflowHandoffEnvelope
} from "./workflow-handoff.js";
import {
  loadWorkflowMonitorEnvelope,
  type WorkflowMonitorEnvelope
} from "./workflow-monitor-envelope.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorState
} from "./workflow-monitor-state.js";
import {
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
  isBlockingWorkflowRecoveryCode,
  type ClearWorkflowRunManualRecoveryGuardedResult,
  type WorkflowRunManualRecoveryState
} from "./workflow-run-recovery.js";
import {
  reconcileWorkflowRunManualRecovery,
  type ReconcileWorkflowRunManualRecoveryResult
} from "./workflow-recovery-reconcile.js";
import {
  DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS,
  PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT,
  buildProjectRollup,
  type ProjectRollup,
  type ProjectRollupExternalApply,
  type ProjectRollupFilters,
  type ProjectRollupOptions,
  type ProjectRollupPendingIntentExternalApply
} from "./project-rollup.js";
import {
  UPDATE_INTENT_STATUSES,
  cancelUpdateIntent,
  countUpdateIntents,
  getUpdateIntentById,
  listUpdateIntents,
  markUpdateIntentApplied,
  markUpdateIntentSkipped,
  type CountUpdateIntentsOptions,
  type ListUpdateIntentsOptions,
  type UpdateIntent,
  type UpdateIntentDecisionInput,
  type UpdateIntentDecisionResult,
  type UpdateIntentStatus
} from "./update-intents.js";
import {
  evaluateGoalForSourceSatisfiedIntents,
  type EvaluateGoalForSourceSatisfiedIntentResult
} from "./update-intent-generator.js";
import {
  countIntentApplyAuditsByLifecycleState,
  countIntentsByApplyState,
  listIntentApplyAudits,
  summarizeIntentApplyAuditsForIntent,
  type IntentApplyAudit,
  type IntentApplyAuditCounts,
  type IntentApplyAuditSummary,
  type IntentApplyStateCounts
} from "./intent-apply-audits.js";
import {
  defaultBuildLinearRefreshClient,
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
  type ExecuteExternalApplyDeps,
  type ExecuteExternalApplyResult
} from "./intent-apply-execute.js";
import { type LinearExternalUpdateClient } from "./linear-external-update-client.js";
import { type LinearIssueRefreshClient } from "./linear-issue-refresh.js";

export const VERSION = "0.0.0";

type Writer = {
  write(chunk: string): boolean;
};

export type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

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

type JsonPayload = Record<string, unknown>;

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
  evidencePointer?: string;
  ledgerPointer?: string;
  error?: string;
};

const COMMANDS = [
  "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]",
  "momentum status [goal-id] [--data-dir <path>] [--json]",
  "momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]",
  "momentum handoff <goal-id> [--data-dir <path>] [--json]",
  "momentum source list [--adapter <kind>] [--data-dir <path>] [--json]",
  "momentum source get <source-item-id> [--data-dir <path>] [--json]",
  "momentum source link <source-item-id> --goal <goal-id> [--data-dir <path>] [--json]",
  "momentum source unlink <source-item-id> [--data-dir <path>] [--json]",
  "momentum source reconcile linear [--project <id-or-name>] [--milestone <id-or-name>] [--dry-run] [--max-pages <n>] [--linear-endpoint <url>] [--linear-page-size <n>] [--data-dir <path>] [--json]",
  "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]",
  "momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]",
  "momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]",
  "momentum daemon status [--data-dir <path>] [--json]",
  "momentum project status [--source <adapter>] [--project <id-or-name>] [--milestone <id-or-name>] [--stale-threshold-hours <n>] [--intent-stale-threshold-days <n>] [--data-dir <path>] [--json]",
  "momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]",
  "momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]",
  "momentum evidence list [--goal <id>] [--source-item <id>] [--source <source>] [--type <type>] [--limit <n>] [--data-dir <path>] [--json]",
  "momentum workflow import --path <run-dir> [--data-dir <path>] [--json]",
  "momentum workflow status [<run-id>] [--state <state>] [--filter <active|blocked|completed|imported>] [--limit <n>] [--data-dir <path>] [--json]",
  "momentum workflow handoff <run-id> [--data-dir <path>] [--json]",
  "momentum workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> [--actor <name>] [--artifact-path <path>] [--artifact-digest <sha256>] [--data-dir <path>] [--json]",
  "momentum workflow run list [--state <state>] [--filter <active|blocked|completed|imported>] [--approval-boundary <boundary>] [--repo <path>] [--issue-scope <identifier>] [--updated-since <ms>] [--updated-until <ms>] [--limit <n>] [--data-dir <path>] [--json]",
  "momentum workflow run update-step <run-id> --step <step-id> --state <approved|succeeded|skipped|failed|blocked|canceled> --reason <text> [--actor <name>] [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]",
  "momentum workflow run clear-recovery <run-id> [--data-dir <path>] [--json]",
  "momentum workflow run monitor <run-id> [--data-dir <path>] [--json]",
  "momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]",
  "momentum intent get <intent-id> [--data-dir <path>] [--json]",
  "momentum intent apply <intent-id> --reason <text> [--repo <path>] [--external-apply] [--data-dir <path>] [--json]",
  "momentum intent skip <intent-id> --reason <text> [--data-dir <path>] [--json]",
  "momentum intent cancel <intent-id> --reason <text> [--data-dir <path>] [--json]",
  "momentum doctor [--repo <path>] [--data-dir <path>] [--json]"
];

const QUEUED_NEXT_ACTION =
  "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job.";

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

  if (command === "workflow") {
    return workflow(parsed, io);
  }

  if (command === "intent") {
    return intent(parsed, io, deps);
  }

  return usageError(`Unknown command: ${command}`, parsed, io);
}

function source(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for source. Expected: list, get, link, unlink, reconcile.",
      parsed,
      io
    );
  }
  if (subcommand === "list") {
    return sourceList(parsed, io);
  }
  if (subcommand === "get") {
    return sourceGet(parsed, io);
  }
  if (subcommand === "link") {
    return sourceLink(parsed, io);
  }
  if (subcommand === "unlink") {
    return sourceUnlink(parsed, io);
  }
  if (subcommand === "reconcile") {
    return sourceReconcile(parsed, io, deps);
  }
  return usageError(`Unknown source subcommand: ${subcommand}`, parsed, io);
}

function sourceList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for source list: ${parsed.args[2]}`,
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
    return emitSourceFailure(parsed, io, "source list", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let items: SourceItem[];
  let lastReconciliation: SourceReconciliationRun | null;
  try {
    items = listSourceItems(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter }
    );
    const runs = listSourceReconciliationRuns(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter }
    );
    lastReconciliation = runs.length === 0 ? null : runs[runs.length - 1] ?? null;
  } finally {
    db.close();
  }

  const payload = {
    ok: true,
    command: "source list",
    dataDir,
    adapter: parsed.adapter ?? null,
    count: items.length,
    items: items.map(sourceItemToJsonShape),
    lastReconciliation: lastReconciliation
      ? sourceReconciliationRunToJsonShape(lastReconciliation)
      : null
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Source items: ${items.length}`,
    `Adapter: ${parsed.adapter ?? "(all)"}`,
    `Data dir: ${dataDir}`,
    ...items.map((item) =>
      `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
      `${item.title}${item.status ? ` (${item.status})` : ""}`
    )
  ];
  if (lastReconciliation) {
    const paginationStopped = sourceReconciliationPaginationStopped(lastReconciliation);
    const stoppedText = paginationStopped ? `, stopped=${paginationStopped.reason}` : "";
    lines.push(
      `Last reconciliation: ${lastReconciliation.adapterKind} ${lastReconciliation.state}` +
        ` (seen=${lastReconciliation.itemsSeen}, upserted=${lastReconciliation.itemsUpserted}${stoppedText})`
    );
  } else {
    lines.push("Last reconciliation: (none)");
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function sourceGet(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source get.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source get: ${parsed.args[3]}`,
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
    return emitSourceFailure(parsed, io, "source get", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let item: SourceItem | null;
  try {
    item = getSourceItemById(db, sourceItemId);
  } finally {
    db.close();
  }

  if (!item) {
    return emitSourceFailure(parsed, io, "source get", {
      code: "source_item_not_found",
      message: `Source item not found: ${sourceItemId}`,
      sourceItemId,
      dataDir
    });
  }

  const payload = {
    ok: true,
    command: "source get",
    dataDir,
    item: sourceItemToJsonShape(item)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `Source item: ${item.id}`,
    `Adapter: ${item.adapterKind}`,
    `External id: ${item.externalId}`,
    `External key: ${item.externalKey ?? "(unset)"}`,
    `URL: ${item.url ?? "(unset)"}`,
    `Title: ${item.title}`,
    `Status: ${item.status ?? "(unset)"}`,
    `Goal: ${item.goalId ?? "(unlinked)"}`,
    `Last observed at: ${item.lastObservedAt}`,
    `Data dir: ${dataDir}`,
    ""
  ].join("\n"));
  return 0;
}

function sourceLink(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source link.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source link: ${parsed.args[3]}`,
      parsed,
      io
    );
  }
  if (parsed.goal === undefined || parsed.goal.length === 0) {
    return usageError(
      "Missing required --goal <goal-id> for source link.",
      parsed,
      io
    );
  }
  const goalId = parsed.goal;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitSourceFailure(parsed, io, "source link", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  try {
    const result = linkGoalToSourceItem(db, { goalId, sourceItemId });
    if (!result.ok) {
      return emitSourceFailure(parsed, io, "source link", {
        code: result.code,
        message: result.message,
        sourceItemId,
        goalId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir
      });
    }
    const intentEvaluations = evaluateGoalForSourceSatisfiedIntents(db, {
      goalId
    });
    const intentsCreated = intentEvaluations.filter(
      (entry) => entry.outcome === "intent_created"
    ).length;
    const intentsReplayed = intentEvaluations.filter(
      (entry) => entry.outcome === "intent_replayed"
    ).length;
    const intentWarnings = intentEvaluations.filter(
      (entry) => entry.outcome === "evidence_insufficient"
    ).length;

    const payload = {
      ok: true,
      command: "source link",
      dataDir,
      goalId,
      sourceItemId: result.sourceItem.id,
      changed: result.changed,
      skippedReason: result.skippedReason,
      previousGoalId: result.previousGoalId,
      counts: {
        intentsCreated,
        intentsReplayed,
        intentWarnings
      },
      intentEvaluations: intentEvaluations.map(intentEvaluationToJsonShape),
      item: sourceItemToJsonShape(result.sourceItem)
    };

    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }

    const lines = [
      result.changed
        ? `Linked source item ${result.sourceItem.id} to goal ${goalId}.`
        : `Source item ${result.sourceItem.id} already linked to goal ${goalId}; no change.`,
      `Adapter: ${result.sourceItem.adapterKind}`,
      `External key: ${result.sourceItem.externalKey ?? "(unset)"}`,
      `Title: ${result.sourceItem.title}`,
      `Intents created: ${intentsCreated}`,
      `Intents replayed: ${intentsReplayed}`,
      `Intent warnings: ${intentWarnings}`,
      `Data dir: ${dataDir}`,
      ""
    ];
    write(io.stdout, lines.join("\n"));
    return 0;
  } finally {
    db.close();
  }
}

function sourceUnlink(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source unlink.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source unlink: ${parsed.args[3]}`,
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
    return emitSourceFailure(parsed, io, "source unlink", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  try {
    const result = unlinkGoalFromSourceItem(db, { sourceItemId });
    if (!result.ok) {
      return emitSourceFailure(parsed, io, "source unlink", {
        code: result.code,
        message: result.message,
        sourceItemId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir
      });
    }

    const payload = {
      ok: true,
      command: "source unlink",
      dataDir,
      sourceItemId: result.sourceItem.id,
      changed: result.changed,
      previousGoalId: result.previousGoalId,
      item: sourceItemToJsonShape(result.sourceItem)
    };

    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }

    const lines = [
      result.changed
        ? `Unlinked source item ${result.sourceItem.id} (was goal ${result.previousGoalId}).`
        : `Source item ${result.sourceItem.id} was already unlinked; no change.`,
      `Adapter: ${result.sourceItem.adapterKind}`,
      `Title: ${result.sourceItem.title}`,
      `Data dir: ${dataDir}`,
      ""
    ];
    write(io.stdout, lines.join("\n"));
    return 0;
  } finally {
    db.close();
  }
}

const LINEAR_API_KEY_ENV = LINEAR_API_KEY_ENV_VAR;

async function sourceReconcile(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): Promise<number> {
  const adapterKind = parsed.args[2];
  if (!adapterKind) {
    return usageError(
      "Missing required <adapter> for source reconcile. Expected: linear.",
      parsed,
      io
    );
  }
  if (adapterKind !== "linear") {
    return emitSourceReconcileFailure(parsed, io, {
      code: "unsupported_source_adapter",
      message: `Source reconcile only supports the "linear" adapter; got "${adapterKind}".`
    });
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source reconcile linear: ${parsed.args[3]}`,
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
    return emitSourceReconcileFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const env = io.env ?? {};
  const apiKey = (env[LINEAR_API_KEY_ENV] ?? "").trim();
  const factoryInput: LinearReconciliationClientFactoryInput = {
    apiKey: apiKey.length > 0 ? apiKey : null,
    endpoint: parsed.linearEndpoint ?? null,
    pageSize: parsed.linearPageSize ?? null,
    env
  };
  const factory =
    deps.buildLinearReconciliationClient ??
    ((input: LinearReconciliationClientFactoryInput): LinearReconciliationClient => {
      const opts: { apiKey?: string | null; endpoint?: string; pageSize?: number } = {
        apiKey: input.apiKey
      };
      if (input.endpoint !== null) opts.endpoint = input.endpoint;
      if (input.pageSize !== null) opts.pageSize = input.pageSize;
      return buildLinearHttpReconciliationClient(opts);
    });

  let client: LinearReconciliationClient;
  try {
    client = factory(factoryInput);
  } catch (err) {
    return emitSourceReconcileFailure(parsed, io, {
      code: "source_config_invalid",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind
    });
  }

  const filters: LinearReconciliationFilters = {};
  if (parsed.project !== undefined) {
    if (/^[0-9a-f-]{8,}$/i.test(parsed.project) && parsed.project.includes("-")) {
      filters.projectId = parsed.project;
    } else {
      filters.projectName = parsed.project;
    }
  }
  if (parsed.milestone !== undefined) {
    if (
      /^[0-9a-f-]{8,}$/i.test(parsed.milestone) &&
      parsed.milestone.includes("-")
    ) {
      filters.milestoneId = parsed.milestone;
    } else {
      filters.milestoneName = parsed.milestone;
    }
  }

  const reconcileInput: ReconcileLinearSourceInput = {
    client,
    filters,
    dryRun: parsed.dryRun
  };
  if (parsed.maxPages !== undefined) reconcileInput.maxPages = parsed.maxPages;

  const db = openDb(dataDir);
  let result: ReconcileLinearSourceResult;
  try {
    result = await reconcileLinearSource(db, reconcileInput);
  } catch (err) {
    db.close();
    return emitSourceReconcileFailure(parsed, io, {
      code: "source_adapter_threw",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind
    });
  }
  db.close();

  return emitSourceReconcileResult(parsed, io, {
    dataDir,
    adapter: adapterKind,
    filters,
    dryRun: parsed.dryRun,
    result
  });
}

type SourceReconcileSuccessPayload = {
  dataDir: string;
  adapter: "linear";
  filters: LinearReconciliationFilters;
  dryRun: boolean;
  result: ReconcileLinearSourceResult;
};

function emitSourceReconcileResult(
  parsed: ParsedFlags,
  io: CliIo,
  data: SourceReconcileSuccessPayload
): number {
  const run = data.result.run;
  const stop = data.result.paginationStopped;
  const counts = data.result.counts;
  const ok = run.state === "succeeded";
  const stopCode = stop.code ?? null;

  const payload: Record<string, unknown> = {
    ok,
    command: "source reconcile linear",
    dataDir: data.dataDir,
    adapter: data.adapter,
    filters: data.filters,
    dryRun: data.dryRun,
    run: sourceReconciliationRunToJsonShape(run),
    counts,
    paginationStopped: {
      reason: stop.reason,
      pageIndex: stop.pageIndex,
      code: stopCode,
      error: stop.error ?? null
    },
    itemsSampled: data.result.items.slice(0, 25).map((item) => ({
      classification: item.classification,
      externalId: item.externalId,
      externalKey: item.externalKey,
      pageIndex: item.pageIndex,
      errorCode: item.errorCode ?? null,
      error: item.error ?? null
    }))
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const headline = data.dryRun
    ? `Source reconcile (dry-run, ${data.adapter}): ${run.state}`
    : `Source reconcile (${data.adapter}): ${run.state}`;
  const lines: string[] = [
    headline,
    `Run id: ${run.id}`,
    `Pages: ${counts.pages}`,
    `Observed: ${counts.itemsObserved}`,
    `Created: ${counts.itemsCreated}`,
    `Updated: ${counts.itemsUpdated}`,
    `Skipped: ${counts.itemsSkipped}`,
    `Errored: ${counts.itemsErrored}`,
    `Stopped: ${stop.reason}${stopCode ? ` (${stopCode})` : ""}`
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(`Data dir: ${data.dataDir}`, "");
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

type SourceReconcileFailure = {
  code:
    | "data_dir_failed"
    | "unsupported_source_adapter"
    | "source_config_invalid"
    | "source_adapter_threw";
  message: string;
  dataDir?: string;
  adapter?: string;
};

function emitSourceReconcileFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: SourceReconcileFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "source reconcile linear",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.adapter !== undefined) payload["adapter"] = failure.adapter;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type SourceReconciliationPaginationStoppedJson = {
  reason: string;
  pageIndex: number;
  code: string | null;
  error: string | null;
};

function sourceReconciliationRunToJsonShape(
  run: SourceReconciliationRun
): Record<string, unknown> {
  return {
    id: run.id,
    adapterKind: run.adapterKind,
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    itemsSeen: run.itemsSeen,
    itemsUpserted: run.itemsUpserted,
    metadata: run.metadata,
    paginationStopped: sourceReconciliationPaginationStopped(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function sourceReconciliationPaginationStopped(
  run: SourceReconciliationRun
): SourceReconciliationPaginationStoppedJson | null {
  const stop = run.metadata["paginationStopped"];
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) return null;
  const record = stop as Record<string, unknown>;
  if (typeof record["reason"] !== "string") return null;
  const pageIndex = record["pageIndex"];
  if (!Number.isInteger(pageIndex)) return null;
  return {
    reason: record["reason"],
    pageIndex: pageIndex as number,
    code: typeof record["code"] === "string" ? record["code"] : null,
    error: typeof record["error"] === "string" ? record["error"] : null
  };
}

type SourceFailureCode =
  | "data_dir_failed"
  | "source_item_not_found"
  | LinkGoalToSourceItemErrorCode
  | UnlinkGoalFromSourceItemErrorCode;

type SourceFailure = {
  code: SourceFailureCode;
  message: string;
  sourceItemId?: string;
  goalId?: string;
  currentGoalId?: string | null;
  dataDir?: string;
};

function emitSourceFailure(
  parsed: ParsedFlags,
  io: CliIo,
  command: "source list" | "source get" | "source link" | "source unlink",
  failure: SourceFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command,
    code: failure.code,
    message: failure.message
  };
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.goalId !== undefined) {
    payload["goalId"] = failure.goalId;
  }
  if (failure.currentGoalId !== undefined) {
    payload["currentGoalId"] = failure.currentGoalId;
  }
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function sourceItemToJsonShape(item: SourceItem): Record<string, unknown> {
  return {
    id: item.id,
    adapterKind: item.adapterKind,
    externalId: item.externalId,
    externalKey: item.externalKey,
    url: item.url,
    title: item.title,
    status: item.status,
    metadata: item.metadata,
    lastObservedAt: item.lastObservedAt,
    goalId: item.goalId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function project(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for project. Expected: status.",
      parsed,
      io
    );
  }
  if (subcommand === "status") {
    return projectStatus(parsed, io);
  }
  return usageError(`Unknown project subcommand: ${subcommand}`, parsed, io);
}

function projectStatus(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for project status: ${parsed.args[2]}`,
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
    return emitProjectStatusFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const filters: ProjectRollupFilters = {};
  if (parsed.source !== undefined) filters.adapterKind = parsed.source;
  if (parsed.project !== undefined) {
    filters.projectId = parsed.project;
    filters.projectName = parsed.project;
  }
  if (parsed.milestone !== undefined) {
    filters.milestoneId = parsed.milestone;
    filters.milestoneName = parsed.milestone;
  }

  const options: ProjectRollupOptions = { filters };
  if (parsed.staleThresholdHours !== undefined) {
    options.reconciliationStaleThresholdMs = Math.round(
      parsed.staleThresholdHours * 60 * 60 * 1000
    );
  }
  if (parsed.intentStaleThresholdDays !== undefined) {
    options.intentStaleThresholdMs = Math.round(
      parsed.intentStaleThresholdDays * 24 * 60 * 60 * 1000
    );
  }

  const db = openDb(dataDir);
  let rollup: ProjectRollup;
  try {
    rollup = buildProjectRollup(db, options);
  } finally {
    db.close();
  }

  if (parsed.json) {
    const payload = {
      ok: true,
      command: "project status",
      dataDir,
      filters: {
        source: filters.adapterKind ?? null,
        projectId: filters.projectId ?? null,
        projectName: filters.projectName ?? null,
        milestoneId: filters.milestoneId ?? null,
        milestoneName: filters.milestoneName ?? null
      },
      staleThresholdMs: rollup.reconciliationStaleThresholdMs,
      intentStaleThresholdMs: rollup.intentStaleThresholdMs,
      generatedAt: rollup.generatedAt,
      counts: rollup.counts,
      sourceItems: rollup.sourceItems,
      totalSourceItemCount: rollup.totalSourceItemCount,
      truncatedSourceItems: rollup.truncatedSourceItems,
      mismatches: rollup.mismatches,
      totalMismatchCount: rollup.totalMismatchCount,
      truncatedMismatches: rollup.truncatedMismatches,
      reconciliationWarnings: rollup.reconciliationWarnings,
      pendingUpdateIntents: rollup.pendingUpdateIntents.map((intent) => ({
        ...intent,
        externalApply: projectRollupExternalApplyIntentToJsonShape(intent.externalApply)
      })),
      totalPendingUpdateIntentCount: rollup.totalPendingUpdateIntentCount,
      truncatedPendingUpdateIntents: rollup.truncatedPendingUpdateIntents,
      externalApply: projectRollupExternalApplyToJsonShape(rollup.externalApply),
      nextAction: rollup.nextAction
    };
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderProjectStatusText(rollup, filters, dataDir));
  return 0;
}

function projectRollupExternalApplyIntentToJsonShape(
  external: ProjectRollupPendingIntentExternalApply
): {
  applyState: ProjectRollupPendingIntentExternalApply["applyState"];
  totalAttempts: number;
  counts: ProjectRollupPendingIntentExternalApply["counts"];
  latestAttempt: Record<string, unknown> | null;
} {
  return {
    applyState: external.applyState,
    totalAttempts: external.totalAttempts,
    counts: external.counts,
    latestAttempt: external.latestAttempt
      ? intentApplyAuditToJsonShape(external.latestAttempt)
      : null
  };
}

function projectRollupExternalApplyToJsonShape(
  external: ProjectRollupExternalApply
): {
  pendingIntentApplyStateCounts: ProjectRollupExternalApply["pendingIntentApplyStateCounts"];
  pendingAuditCounts: ProjectRollupExternalApply["pendingAuditCounts"];
  totalAttempts: number;
  latestAttempt:
    | ({ intentId: string } & ReturnType<typeof intentApplyAuditToJsonShape>)
    | null;
} {
  return {
    pendingIntentApplyStateCounts: external.pendingIntentApplyStateCounts,
    pendingAuditCounts: external.pendingAuditCounts,
    totalAttempts: external.totalAttempts,
    latestAttempt: external.latestAttempt
      ? {
          intentId: external.latestAttempt.intentId,
          ...intentApplyAuditToJsonShape(external.latestAttempt)
        }
      : null
  };
}

function renderProjectStatusText(
  rollup: ProjectRollup,
  filters: ProjectRollupFilters,
  dataDir: string
): string {
  const lines: string[] = ["Project status"];
  lines.push(
    `Filters: source=${filters.adapterKind ?? "(any)"} project=${
      filters.projectId ?? filters.projectName ?? "(any)"
    } milestone=${filters.milestoneId ?? filters.milestoneName ?? "(any)"}`
  );
  lines.push(`Data dir: ${dataDir}`);
  lines.push(
    `Source items: ${rollup.counts.sourceItems.total} ` +
      `(linked=${rollup.counts.sourceItems.linkedToGoal}, unlinked=${rollup.counts.sourceItems.unlinked})`
  );
  const statusSummary = Object.entries(rollup.counts.sourceItems.byStatus)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  if (statusSummary.length > 0) {
    lines.push(`Source status: ${statusSummary}`);
  }
  const goalSummary = Object.entries(rollup.counts.goals.byState)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([state, count]) => `${state}=${count}`)
    .join(", ");
  lines.push(
    `Goals: total=${rollup.counts.goals.total}` +
      (goalSummary.length > 0 ? ` (${goalSummary})` : "") +
      `, manual_recovery=${rollup.counts.goals.needingManualRecovery}`
  );
  lines.push(
    `Evidence: total=${rollup.counts.evidence.totalRecords}, ` +
      `goals_with_evidence=${rollup.counts.evidence.goalsWithEvidence}, ` +
      `goals_without_evidence=${rollup.counts.evidence.goalsWithoutEvidence}`
  );
  lines.push(
    `Mismatches: source_done_goal_not_terminal=${rollup.counts.mismatches.source_done_goal_not_terminal}, ` +
      `goal_done_source_not_done=${rollup.counts.mismatches.goal_done_source_not_done}, ` +
      `evidence_missing_after_completion=${rollup.counts.mismatches.evidence_missing_after_completion}, ` +
      `manual_recovery_required=${rollup.counts.mismatches.manual_recovery_required}`
  );
  lines.push(
    `Pending external update intents: ${rollup.counts.pendingUpdateIntents} ` +
      `(stale=${rollup.counts.staleUpdateIntents}, ` +
      `stale_threshold_ms=${rollup.intentStaleThresholdMs})`
  );
  const externalApplyStateCounts = rollup.externalApply.pendingIntentApplyStateCounts;
  const externalApplyAuditCounts = rollup.externalApply.pendingAuditCounts;
  lines.push(
    `Pending external apply state: idle=${externalApplyStateCounts.idle}, ` +
      `in_flight=${externalApplyStateCounts.in_flight}, ` +
      `blocked=${externalApplyStateCounts.blocked}`
  );
  lines.push(
    `Pending external apply audits: total=${rollup.externalApply.totalAttempts}, ` +
      `succeeded=${externalApplyAuditCounts.succeeded}, ` +
      `failed=${externalApplyAuditCounts.failed}, ` +
      `claimed=${externalApplyAuditCounts.claimed}, ` +
      `blocked=${externalApplyAuditCounts.blocked}, ` +
      `audit_incomplete=${externalApplyAuditCounts.audit_incomplete}`
  );
  const latestExternalApply = rollup.externalApply.latestAttempt;
  if (latestExternalApply) {
    lines.push(
      `Latest external apply: ${latestExternalApply.id} ${latestExternalApply.lifecycleState}` +
        ` intent=${latestExternalApply.intentId}` +
        ` (result=${latestExternalApply.resultStatus ?? "(none)"}` +
        ` code=${latestExternalApply.resultCode ?? "(none)"})`
    );
  } else {
    lines.push("Latest external apply: (none)");
  }
  if (rollup.reconciliationWarnings.length === 0) {
    lines.push("Reconciliation: ok");
  } else {
    for (const warning of rollup.reconciliationWarnings) {
      const ageText =
        warning.ageMs === null ? "" : ` (age_ms=${warning.ageMs})`;
      const errorText = warning.error ? ` error=${warning.error}` : "";
      lines.push(
        `Reconciliation warning: ${warning.adapterKind} ${warning.reason}${ageText}${errorText}`
      );
    }
  }
  lines.push("");
  lines.push("Top source items:");
  if (rollup.sourceItems.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of rollup.sourceItems) {
      const goalText = item.goalId
        ? `goal=${item.goalId} (${item.goalState ?? "unknown"})`
        : "goal=(none)";
      lines.push(
        `  - [${item.adapterKind}] ${item.externalKey ?? item.externalId} ` +
          `${item.title}${item.status ? ` (${item.status})` : ""} ${goalText}`
      );
    }
    if (rollup.truncatedSourceItems) {
      lines.push(
        `  ... and ${rollup.totalSourceItemCount - rollup.sourceItems.length} more`
      );
    }
  }
  lines.push("");
  lines.push("Mismatches:");
  if (rollup.mismatches.length === 0) {
    lines.push("  (none)");
  } else {
    for (const mismatch of rollup.mismatches) {
      lines.push(
        `  - [${mismatch.kind}] ${mismatch.externalKey ?? mismatch.sourceItemId} ` +
          `source=${mismatch.sourceStatus ?? "(none)"} goal=${mismatch.goalId ?? "(none)"} (${mismatch.goalState ?? "unknown"})`
      );
    }
    if (rollup.truncatedMismatches) {
      lines.push(
        `  ... and ${rollup.totalMismatchCount - rollup.mismatches.length} more`
      );
    }
  }
  lines.push("");
  lines.push("Pending update intents:");
  if (rollup.pendingUpdateIntents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const intent of rollup.pendingUpdateIntents) {
      const staleText = intent.stale ? " STALE" : "";
      const targetText = intent.targetExternalId
        ? ` target=${intent.targetExternalId}`
        : "";
      const goalText = intent.goalId ? ` goal=${intent.goalId}` : "";
      const sourceText = intent.sourceItemId
        ? ` source=${intent.sourceItemId}`
        : "";
      const latestText = intent.externalApply.latestAttempt
        ? ` latest=${intent.externalApply.latestAttempt.lifecycleState}`
        : "";
      lines.push(
        `  - [${intent.adapterKind}/${intent.intentType}] ${intent.intentId}` +
          `${targetText}${goalText}${sourceText} age_ms=${intent.ageMs}${staleText}` +
          ` apply=${intent.externalApply.applyState}` +
          ` attempts=${intent.externalApply.totalAttempts}${latestText}`
      );
    }
    if (rollup.truncatedPendingUpdateIntents) {
      lines.push(
        `  ... and ${rollup.totalPendingUpdateIntentCount - rollup.pendingUpdateIntents.length} more`
      );
    }
  }
  lines.push("");
  lines.push(`Next action: ${rollup.nextAction.kind} — ${rollup.nextAction.message}`);
  lines.push("");
  return lines.join("\n");
}

function emitProjectStatusFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: { code: string; message: string }
): number {
  const payload = {
    ok: false,
    command: "project status",
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
    const payload = {
      ok: false,
      command: "recovery clear",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      goalId
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${payload.message}\n`);
    return 1;
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

function emitRecoveryClear(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  goalId: string,
  result: ClearGoalManualRecoveryGuardedResult
): number {
  if (!result.ok) {
    const payload: Record<string, unknown> = {
      ok: false,
      command: "recovery clear",
      code: result.reason,
      message: result.message,
      goalId,
      dataDir
    };
    if (result.reason === "job_active" && result.activeJobIds) {
      payload["activeJobIds"] = result.activeJobIds;
    }
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.message}\n`);
    return 1;
  }

  const payload = {
    ok: true,
    command: "recovery clear",
    goalId: result.goalId,
    dataDir,
    previousReason: result.previousReason,
    previousMarkedAt: result.previousMarkedAt,
    clearedAt: result.clearedAt,
    eventId: result.eventId
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Manual recovery cleared for goal: ${result.goalId}`,
    `Previous reason: ${result.previousReason ?? "(unset)"}`,
    `Previous marked at: ${result.previousMarkedAt ?? "(unset)"}`,
    `Cleared at: ${result.clearedAt}`,
    `Event id: ${result.eventId}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

type EvidenceIngestFailureCode =
  | "data_dir_failed"
  | "path_required"
  | "goal_not_found"
  | "source_item_not_found";

type EvidenceIngestFailure = {
  code: EvidenceIngestFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  sourceItemId?: string | null;
  path?: string | null;
};

function evidence(parsed: ParsedFlags, io: CliIo): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for evidence. Expected: ingest, list.",
      parsed,
      io
    );
  }
  if (subcommand === "ingest") {
    return evidenceIngest(parsed, io);
  }
  if (subcommand === "list") {
    return evidenceList(parsed, io);
  }
  return usageError(`Unknown evidence subcommand: ${subcommand}`, parsed, io);
}

function evidenceIngest(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for evidence ingest: ${parsed.args[2]}`,
      parsed,
      io
    );
  }
  if (parsed.path === undefined || parsed.path.length === 0) {
    return emitEvidenceIngestFailure(parsed, io, {
      code: "path_required",
      message: "Missing required --path <file-or-dir> for evidence ingest."
    });
  }
  const artifactPath = parsed.path;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitEvidenceIngestFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      path: artifactPath
    });
  }

  const parseOptions: Parameters<typeof parseWorkflowArtifact>[1] = {};
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    parseOptions.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    parseOptions.sourceItemId = parsed.sourceItem;
  }

  const db = openDb(dataDir);
  try {
    if (parseOptions.goalId !== undefined && parseOptions.goalId !== null) {
      const goalRow = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(parseOptions.goalId) as { id: string } | undefined;
      if (!goalRow) {
        return emitEvidenceIngestFailure(parsed, io, {
          code: "goal_not_found",
          message: `Goal not found: ${parseOptions.goalId}`,
          dataDir,
          goalId: parseOptions.goalId,
          path: artifactPath
        });
      }
    }
    if (
      parseOptions.sourceItemId !== undefined &&
      parseOptions.sourceItemId !== null
    ) {
      const itemRow = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(parseOptions.sourceItemId) as { id: string } | undefined;
      if (!itemRow) {
        return emitEvidenceIngestFailure(parsed, io, {
          code: "source_item_not_found",
          message: `Source item not found: ${parseOptions.sourceItemId}`,
          dataDir,
          sourceItemId: parseOptions.sourceItemId,
          path: artifactPath
        });
      }
    }

    const parseResult = parseWorkflowArtifact(artifactPath, parseOptions);
    const created: EvidenceRecord[] = [];
    const skipped: EvidenceRecord[] = [];
    const errors: Array<{
      ingestKey: string;
      type: string;
      message: string;
    }> = [];

    for (const input of parseResult.records) {
      try {
        const result = ingestEvidenceRecord(db, input as EvidenceRecordIngestInput);
        if (result.created) {
          created.push(result.record);
        } else {
          skipped.push(result.record);
        }
      } catch (err) {
        errors.push({
          ingestKey: input.ingestKey,
          type: input.type,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const intentEvaluations = evaluateIntentsForEvidenceRecords(db, [
      ...created,
      ...skipped
    ]);

    return emitEvidenceIngestSuccess(parsed, io, {
      dataDir,
      artifactPath,
      goalId: parseOptions.goalId ?? null,
      sourceItemId: parseOptions.sourceItemId ?? null,
      observed: parseResult.records.length,
      created,
      skipped,
      intentEvaluations,
      diagnostics: parseResult.diagnostics,
      errors
    });
  } finally {
    db.close();
  }
}

function evaluateIntentsForEvidenceRecords(
  db: MomentumDb,
  records: readonly EvidenceRecord[]
): EvaluateGoalForSourceSatisfiedIntentResult[] {
  const goalIds = new Set<string>();
  for (const record of records) {
    if (record.goalId) {
      goalIds.add(record.goalId);
      continue;
    }
    if (record.sourceItemId) {
      const sourceItem = getSourceItemById(db, record.sourceItemId);
      if (sourceItem?.goalId) goalIds.add(sourceItem.goalId);
    }
  }
  return [...goalIds]
    .sort()
    .flatMap((goalId) =>
      evaluateGoalForSourceSatisfiedIntents(db, { goalId })
    );
}

function emitEvidenceIngestSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  result: {
    dataDir: string;
    artifactPath: string;
    goalId: string | null;
    sourceItemId: string | null;
    observed: number;
    created: EvidenceRecord[];
    skipped: EvidenceRecord[];
    intentEvaluations: EvaluateGoalForSourceSatisfiedIntentResult[];
    diagnostics: WorkflowEvidenceDiagnostic[];
    errors: Array<{ ingestKey: string; type: string; message: string }>;
  }
): number {
  const ok = result.errors.length === 0;
  const createdIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_created"
  );
  const replayedIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_replayed"
  );
  const intentWarnings = result.intentEvaluations.filter(
    (entry) => entry.outcome === "evidence_insufficient"
  );
  const payload = {
    ok,
    command: "evidence ingest",
    dataDir: result.dataDir,
    path: result.artifactPath,
    goalId: result.goalId,
    sourceItemId: result.sourceItemId,
    counts: {
      observed: result.observed,
      created: result.created.length,
      skipped: result.skipped.length,
      intentsCreated: createdIntents.length,
      intentsReplayed: replayedIntents.length,
      intentWarnings: intentWarnings.length,
      diagnostics: result.diagnostics.length,
      errors: result.errors.length
    },
    created: result.created.map(evidenceRecordToJsonShape),
    skipped: result.skipped.map(evidenceRecordToJsonShape),
    intentEvaluations: result.intentEvaluations.map(intentEvaluationToJsonShape),
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    errors: result.errors.map((entry) => ({ ...entry }))
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const lines = [
    `Evidence ingest: ${result.artifactPath}`,
    `Goal: ${result.goalId ?? "(unlinked)"}`,
    `Source item: ${result.sourceItemId ?? "(unlinked)"}`,
    `Observed: ${result.observed}`,
    `Created: ${result.created.length}`,
    `Skipped (idempotent): ${result.skipped.length}`,
    `Intents created: ${createdIntents.length}`,
    `Intents replayed: ${replayedIntents.length}`,
    `Intent warnings: ${intentWarnings.length}`,
    `Diagnostics: ${result.diagnostics.length}`,
    `Errors: ${result.errors.length}`,
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

function emitEvidenceIngestFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: EvidenceIngestFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence ingest",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.path !== undefined) payload["path"] = failure.path;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function evidenceRecordToJsonShape(record: EvidenceRecord): Record<string, unknown> {
  return {
    id: record.id,
    source: record.source,
    type: record.type,
    formatVersion: record.formatVersion,
    artifactPath: record.artifactPath,
    externalId: record.externalId,
    occurredAt: record.occurredAt,
    summary: record.summary,
    metadata: record.metadata,
    goalId: record.goalId,
    sourceItemId: record.sourceItemId,
    runId: record.runId,
    stepId: record.stepId,
    ingestKey: record.ingestKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function intentEvaluationToJsonShape(
  result: EvaluateGoalForSourceSatisfiedIntentResult
): Record<string, unknown> {
  if (
    result.outcome === "intent_created" ||
    result.outcome === "intent_replayed"
  ) {
    return {
      outcome: result.outcome,
      intent: updateIntentToJsonShape(result.intent),
      sourceItem: sourceItemToJsonShape(result.sourceItem),
      verificationEvidence: evidenceRecordToJsonShape(
        result.verificationEvidence
      )
    };
  }
  if (result.outcome === "evidence_insufficient") {
    return {
      outcome: result.outcome,
      warning: { ...result.warning }
    };
  }
  if (result.outcome === "source_already_terminal") {
    return {
      outcome: result.outcome,
      sourceItem: sourceItemToJsonShape(result.sourceItem)
    };
  }
  return { ...result };
}

type EvidenceListFailureCode =
  | "data_dir_failed"
  | "goal_not_found"
  | "source_item_not_found";

type EvidenceListFailure = {
  code: EvidenceListFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  sourceItemId?: string | null;
};

function evidenceList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for evidence list: ${parsed.args[2]}`,
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
    return emitEvidenceListFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const filters: ListEvidenceRecordsOptions = {};
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    filters.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    filters.sourceItemId = parsed.sourceItem;
  }
  if (parsed.source !== undefined && parsed.source.length > 0) {
    filters.source = parsed.source;
  }
  if (parsed.evidenceType !== undefined && parsed.evidenceType.length > 0) {
    filters.type = parsed.evidenceType;
  }
  if (parsed.limit !== undefined) {
    filters.limit = parsed.limit;
  }

  const db = openDb(dataDir);
  let records: EvidenceRecord[];
  try {
    if (filters.goalId !== undefined && filters.goalId !== null) {
      const goalRow = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(filters.goalId) as { id: string } | undefined;
      if (!goalRow) {
        return emitEvidenceListFailure(parsed, io, {
          code: "goal_not_found",
          message: `Goal not found: ${filters.goalId}`,
          dataDir,
          goalId: filters.goalId
        });
      }
    }
    if (filters.sourceItemId !== undefined && filters.sourceItemId !== null) {
      const itemRow = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(filters.sourceItemId) as { id: string } | undefined;
      if (!itemRow) {
        return emitEvidenceListFailure(parsed, io, {
          code: "source_item_not_found",
          message: `Source item not found: ${filters.sourceItemId}`,
          dataDir,
          sourceItemId: filters.sourceItemId
        });
      }
    }
    records = listEvidenceRecords(db, filters);
  } finally {
    db.close();
  }

  const payload = {
    ok: true,
    command: "evidence list",
    dataDir,
    goalId: filters.goalId ?? null,
    sourceItemId: filters.sourceItemId ?? null,
    source: filters.source ?? null,
    type: filters.type ?? null,
    limit: filters.limit ?? null,
    count: records.length,
    records: records.map(evidenceRecordToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Evidence records: ${records.length}`,
    `Goal: ${filters.goalId ?? "(any)"}`,
    `Source item: ${filters.sourceItemId ?? "(any)"}`,
    `Source: ${filters.source ?? "(any)"}`,
    `Type: ${filters.type ?? "(any)"}`,
    `Data dir: ${dataDir}`,
    ...records.map(
      (record) =>
        `- ${record.id} [${record.source}/${record.type}] @${record.occurredAt}: ${record.summary}` +
        (record.runId !== null ? ` run=${record.runId}` : "") +
        (record.stepId !== null ? ` step=${record.stepId}` : "")
    ),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitEvidenceListFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: EvidenceListFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence list",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type WorkflowImportFailureCode =
  | "path_required"
  | "data_dir_failed"
  | WorkflowRunImportErrorCode;

type WorkflowImportFailure = {
  code: WorkflowImportFailureCode;
  message: string;
  dataDir?: string;
  path?: string;
  diagnostics?: WorkflowRunImportDiagnostic[];
};

function workflow(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for workflow. Expected: import, status, handoff, run.",
      parsed,
      io
    );
  }
  if (subcommand === "import") {
    return workflowImport(parsed, io);
  }
  if (subcommand === "status") {
    return workflowStatus(parsed, io);
  }
  if (subcommand === "handoff") {
    return workflowHandoff(parsed, io);
  }
  if (subcommand === "run") {
    return workflowRun(parsed, io);
  }
  return usageError(`Unknown workflow subcommand: ${subcommand}`, parsed, io);
}

function workflowRun(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[2];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for workflow run. Expected: list, approve, update-step, clear-recovery, monitor.",
      parsed,
      io
    );
  }
  if (subcommand === "list") {
    return workflowRunList(parsed, io);
  }
  if (subcommand === "approve") {
    return workflowRunApprove(parsed, io);
  }
  if (subcommand === "update-step") {
    return workflowRunUpdateStep(parsed, io);
  }
  if (subcommand === "clear-recovery") {
    return workflowRunClearRecovery(parsed, io);
  }
  if (subcommand === "monitor") {
    return workflowRunMonitor(parsed, io);
  }
  return usageError(
    `Unknown workflow run subcommand: ${subcommand}`,
    parsed,
    io
  );
}

function workflowImport(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for workflow import: ${parsed.args[2]}`,
      parsed,
      io
    );
  }
  if (parsed.path === undefined || parsed.path.length === 0) {
    return emitWorkflowImportFailure(parsed, io, {
      code: "path_required",
      message: "Missing required --path <run-dir> for workflow import."
    });
  }
  const artifactPath = parsed.path;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowImportFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      path: artifactPath
    });
  }

  const parseResult = parseWorkflowRunImport(artifactPath);
  if (!parseResult.ok) {
    return emitWorkflowImportFailure(parsed, io, {
      code: parseResult.errorCode,
      message: parseResult.message,
      dataDir,
      path: artifactPath,
      diagnostics: parseResult.diagnostics
    });
  }

  const db = openDb(dataDir);
  let summary: PersistWorkflowRunImportSummary;
  let recovery: ReconcileWorkflowRunManualRecoveryResult;
  let recoveryState: WorkflowRunManualRecoveryState | undefined;
  try {
    summary = persistWorkflowRunImport(db, parseResult.import);
    recovery = reconcileWorkflowRunManualRecovery(db, {
      runId: summary.runId,
      agentWorkflowsDir: path.dirname(artifactPath),
      artifactRunDir: artifactPath
    });
    recoveryState = getWorkflowRunManualRecoveryState(db, summary.runId);
  } finally {
    db.close();
  }

  return emitWorkflowImportSuccess(parsed, io, {
    dataDir,
    artifactPath,
    summary,
    importResult: parseResult.import,
    recovery,
    recoveryState
  });
}

function emitWorkflowImportSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  result: {
    dataDir: string;
    artifactPath: string;
    summary: PersistWorkflowRunImportSummary;
    importResult: WorkflowRunImport;
    recovery: ReconcileWorkflowRunManualRecoveryResult;
    recoveryState: WorkflowRunManualRecoveryState | undefined;
  }
): number {
  const { summary, importResult } = result;
  // `needsManualRecovery` mirrors the durable flag (consistent with the
  // status/handoff/list/monitor envelopes); `recovery` surfaces the classification
  // this import freshly auto-set, when it set one.
  const needsManualRecovery =
    result.recoveryState?.needsManualRecovery ?? false;
  const recoveryOutcome = result.recovery.ok ? result.recovery : null;
  const marked =
    recoveryOutcome !== null &&
    (recoveryOutcome.outcome === "marked" ||
      recoveryOutcome.outcome === "artifact_write_failed")
      ? recoveryOutcome
      : null;
  const payload = {
    ok: true,
    command: "workflow import",
    dataDir: result.dataDir,
    path: result.artifactPath,
    runId: summary.runId,
    source: summary.source,
    state: summary.state,
    inserted: summary.inserted,
    approvalBoundary: summary.approvalBoundary,
    counts: {
      steps: summary.stepCount,
      approvals: summary.approvalCount,
      diagnostics: importResult.diagnostics.length
    },
    diagnostics: importResult.diagnostics.map((diagnostic) => ({
      ...diagnostic
    })),
    monitor: importResult.monitor === null ? null : { ...importResult.monitor },
    needsManualRecovery,
    recovery:
      marked === null
        ? null
        : {
            code: marked.recoveryCode,
            stepId: marked.stepId,
            reason: marked.reason,
            artifactPath: marked.artifactPath,
            artifactWriteError:
              marked.outcome === "artifact_write_failed"
                ? { ...marked.artifactWriteError }
                : null
          }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow import: ${result.artifactPath}`,
    `Run: ${summary.runId} (${summary.source})`,
    `State: ${summary.state}`,
    `Inserted: ${summary.inserted ? "yes" : "no (upsert)"}`,
    `Steps: ${summary.stepCount}`,
    `Approvals: ${summary.approvalCount}`,
    `Diagnostics: ${importResult.diagnostics.length}`,
    marked !== null
      ? marked.outcome === "artifact_write_failed"
        ? `Manual recovery: required (${marked.recoveryCode}); recovery.md write failed: ${marked.artifactWriteError.message}`
        : `Manual recovery: required (${marked.recoveryCode}) -> ${marked.artifactPath}`
      : needsManualRecovery
        ? "Manual recovery: flagged (clear explicitly once resolved)"
        : "Manual recovery: not required",
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitWorkflowImportFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowImportFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "workflow import",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.path !== undefined) payload["path"] = failure.path;
  payload["diagnostics"] =
    failure.diagnostics === undefined
      ? []
      : failure.diagnostics.map((diagnostic) => ({ ...diagnostic }));

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type WorkflowStatusFailureCode =
  | "data_dir_failed"
  | "invalid_state"
  | "invalid_filter"
  | "invalid_limit"
  | "run_not_found";

type WorkflowStatusFailure = {
  command: "workflow status";
  code: WorkflowStatusFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
};

function workflowStatus(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(2);
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow status: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];

  if (
    parsed.state !== undefined &&
    !(WORKFLOW_RUN_STATES as readonly string[]).includes(parsed.state)
  ) {
    return emitWorkflowStatusFailure(parsed, io, {
      command: "workflow status",
      code: "invalid_state",
      message: `Invalid --state: ${parsed.state}. Expected one of: ${WORKFLOW_RUN_STATES.join(", ")}.`
    });
  }
  if (
    parsed.filter !== undefined &&
    !(WORKFLOW_STATUS_FILTER_KEYS as readonly string[]).includes(parsed.filter)
  ) {
    return emitWorkflowStatusFailure(parsed, io, {
      command: "workflow status",
      code: "invalid_filter",
      message: `Invalid --filter: ${parsed.filter}. Expected one of: ${WORKFLOW_STATUS_FILTER_KEYS.join(", ")}.`
    });
  }
  if (
    parsed.limit !== undefined &&
    (parsed.limit < 0 || !Number.isInteger(parsed.limit))
  ) {
    return emitWorkflowStatusFailure(parsed, io, {
      command: "workflow status",
      code: "invalid_limit",
      message: `Invalid --limit: ${parsed.limit}. Must be a non-negative integer.`
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowStatusFailure(parsed, io, {
      command: "workflow status",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  if (runId !== undefined) {
    const db = openDb(dataDir);
    let detail: WorkflowRunDetail | null;
    try {
      detail = loadWorkflowRunDetail(db, runId);
    } finally {
      db.close();
    }
    if (detail === null) {
      return emitWorkflowStatusFailure(parsed, io, {
        command: "workflow status",
        code: "run_not_found",
        message: `Workflow run not found: ${runId}`,
        dataDir,
        runId
      });
    }
    return emitWorkflowStatusDetail(parsed, io, dataDir, detail);
  }

  const db = openDb(dataDir);
  let summaries: WorkflowRunSummary[];
  try {
    const options: Parameters<typeof listWorkflowRunSummaries>[1] = {};
    if (parsed.state !== undefined) {
      options.state = parsed.state as WorkflowRunState;
    }
    if (parsed.filter !== undefined) {
      options.filter = parsed.filter as WorkflowStatusFilterKey;
    }
    if (parsed.limit !== undefined) {
      options.limit = parsed.limit;
    }
    summaries = listWorkflowRunSummaries(db, options);
  } finally {
    db.close();
  }

  return emitWorkflowStatusList(parsed, io, dataDir, summaries);
}

function emitWorkflowStatusList(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  summaries: WorkflowRunSummary[]
): number {
  const payload = {
    ok: true,
    command: "workflow status",
    dataDir,
    state: parsed.state ?? null,
    filter: parsed.filter ?? null,
    count: summaries.length,
    runs: summaries.map(summaryToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Workflow runs: ${summaries.length}`);
  lines.push(`State: ${parsed.state ?? "(any)"}`);
  lines.push(`Filter: ${parsed.filter ?? "(none)"}`);
  lines.push(`Data dir: ${dataDir}`);
  if (summaries.length === 0) {
    lines.push("- (no matching runs)");
  } else {
    for (const summary of summaries) {
      lines.push(
        `- ${summary.run.runId} [${summary.run.state}] steps=${summary.counts.steps}` +
          ` approvals=${summary.counts.approvals} leases=${summary.counts.leases}` +
          ` next=${summary.monitor.nextAction.code}` +
          (summary.monitor.recovery
            ? ` recovery=${summary.monitor.recovery.code}`
            : "")
      );
    }
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitWorkflowStatusDetail(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  detail: WorkflowRunDetail
): number {
  const payload = {
    ok: true,
    command: "workflow status",
    dataDir,
    run: workflowRunToJsonShape(detail.run),
    steps: detail.steps.map(workflowStepToJsonShape),
    approvals: detail.approvals.map(workflowApprovalToJsonShape),
    leases: detail.leases.map(workflowLeaseToJsonShape),
    monitor: workflowMonitorToJsonShape(detail.monitor),
    evidence: detail.evidence.map(workflowEvidenceToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowDetailText(dataDir, detail));
  return 0;
}

function emitWorkflowStatusFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowStatusFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type WorkflowRunListFailureCode =
  | "data_dir_failed"
  | "invalid_state"
  | "invalid_filter"
  | "invalid_limit";

type WorkflowRunListFailure = {
  command: "workflow run list";
  code: WorkflowRunListFailureCode;
  message: string;
  dataDir?: string;
};

function workflowRunList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for workflow run list: ${parsed.args[3]}`,
      parsed,
      io
    );
  }

  if (
    parsed.state !== undefined &&
    !(WORKFLOW_RUN_STATES as readonly string[]).includes(parsed.state)
  ) {
    return emitWorkflowRunListFailure(parsed, io, {
      command: "workflow run list",
      code: "invalid_state",
      message: `Invalid --state: ${parsed.state}. Expected one of: ${WORKFLOW_RUN_STATES.join(", ")}.`
    });
  }
  if (
    parsed.filter !== undefined &&
    !(WORKFLOW_STATUS_FILTER_KEYS as readonly string[]).includes(parsed.filter)
  ) {
    return emitWorkflowRunListFailure(parsed, io, {
      command: "workflow run list",
      code: "invalid_filter",
      message: `Invalid --filter: ${parsed.filter}. Expected one of: ${WORKFLOW_STATUS_FILTER_KEYS.join(", ")}.`
    });
  }
  if (
    parsed.limit !== undefined &&
    (parsed.limit < 0 || !Number.isInteger(parsed.limit))
  ) {
    return emitWorkflowRunListFailure(parsed, io, {
      command: "workflow run list",
      code: "invalid_limit",
      message: `Invalid --limit: ${parsed.limit}. Must be a non-negative integer.`
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunListFailure(parsed, io, {
      command: "workflow run list",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let summaries: WorkflowRunSummary[];
  try {
    const options: Parameters<typeof listWorkflowRunSummaries>[1] = {};
    if (parsed.state !== undefined) {
      options.state = parsed.state as WorkflowRunState;
    }
    if (parsed.filter !== undefined) {
      options.filter = parsed.filter as WorkflowStatusFilterKey;
    }
    if (parsed.limit !== undefined) {
      options.limit = parsed.limit;
    }
    if (parsed.approvalBoundary !== undefined) {
      options.approvalBoundary = parsed.approvalBoundary;
    }
    if (parsed.repo !== undefined) {
      options.repoPath = parsed.repo;
    }
    if (parsed.issueScope !== undefined) {
      options.issueScope = parsed.issueScope;
    }
    if (parsed.updatedSince !== undefined) {
      options.updatedSince = parsed.updatedSince;
    }
    if (parsed.updatedUntil !== undefined) {
      options.updatedUntil = parsed.updatedUntil;
    }
    summaries = listWorkflowRunSummaries(db, options);
  } finally {
    db.close();
  }

  return emitWorkflowRunList(parsed, io, dataDir, summaries);
}

function emitWorkflowRunList(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  summaries: WorkflowRunSummary[]
): number {
  const payload = {
    ok: true,
    command: "workflow run list",
    dataDir,
    state: parsed.state ?? null,
    filter: parsed.filter ?? null,
    approvalBoundary: parsed.approvalBoundary ?? null,
    repoPath: parsed.repo ?? null,
    issueScope: parsed.issueScope ?? null,
    updatedSince: parsed.updatedSince ?? null,
    updatedUntil: parsed.updatedUntil ?? null,
    count: summaries.length,
    runs: summaries.map(summaryToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Workflow runs: ${summaries.length}`);
  lines.push(`State: ${parsed.state ?? "(any)"}`);
  lines.push(`Filter: ${parsed.filter ?? "(any)"}`);
  lines.push(`Approval boundary: ${parsed.approvalBoundary ?? "(any)"}`);
  lines.push(`Repo: ${parsed.repo ?? "(any)"}`);
  lines.push(`Issue scope: ${parsed.issueScope ?? "(any)"}`);
  lines.push(
    `Updated since: ${parsed.updatedSince === undefined ? "(any)" : String(parsed.updatedSince)}`
  );
  lines.push(
    `Updated until: ${parsed.updatedUntil === undefined ? "(any)" : String(parsed.updatedUntil)}`
  );
  lines.push(`Data dir: ${dataDir}`);
  if (summaries.length === 0) {
    lines.push("- (no matching runs)");
  } else {
    for (const summary of summaries) {
      const repoSegment = `repo=${summary.run.repoPath ?? "(none)"}`;
      lines.push(
        `- ${summary.run.runId} [${summary.run.state}] ${repoSegment}` +
          ` steps=${summary.counts.steps}` +
          ` approvals=${summary.counts.approvals} leases=${summary.counts.leases}` +
          ` next=${summary.monitor.nextAction.code}` +
          (summary.monitor.recovery
            ? ` recovery=${summary.monitor.recovery.code}`
            : "")
      );
    }
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitWorkflowRunListFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunListFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type WorkflowRunApproveFailureCode =
  | "data_dir_failed"
  | "run_id_required"
  | "run_not_found"
  | "manual_recovery_required"
  | "invalid_state"
  | "invalid_boundary"
  | "approval_digest_mismatch"
  | "duplicate_approval";

type WorkflowRunApproveFailure = {
  command: "workflow run approve";
  code: WorkflowRunApproveFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
  boundary?: string;
};

function workflowRunApprove(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length === 0) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run approve."
    });
  }
  if (positional[0] === undefined) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run approve."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run approve: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];
  if (!runId) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run approve."
    });
  }
  if (!parsed.approvalBoundary) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "invalid_boundary",
      message: "Missing required --approval-boundary for workflow run approve.",
      runId
    });
  }
  if (!isWorkflowApprovalBoundary(parsed.approvalBoundary)) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "invalid_boundary",
      message: `Invalid --approval-boundary: ${parsed.approvalBoundary}.`,
      runId
    });
  }
  const boundary = parsed.approvalBoundary;
  if (!parsed.phrase || parsed.phrase.trim().length === 0) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "invalid_boundary",
      message: "Missing required --phrase for workflow run approve.",
      runId,
      boundary
    });
  }
  const phrase = parsed.phrase.trim();
  if (!isExplicitBoundaryPhraseForApproval(phrase, boundary)) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "invalid_boundary",
      message: `Invalid phrase for boundary ${boundary}: ${phrase}.`,
      runId,
      boundary
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunApproveFailure(parsed, io, {
      command: "workflow run approve",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId,
      boundary
    });
  }

  const artifactPath = parsed.approvalPath;
  let approvalArtifactDigest = "";
  let recordedAt = 0;

  const db = openDb(dataDir);
  try {
    const existingRun = db
      .prepare(
        "SELECT id FROM workflow_runs WHERE id = ?"
      )
      .get(runId) as
      | {
          id: string;
        }
      | undefined;
    if (!existingRun) {
      return emitWorkflowRunApproveFailure(parsed, io, {
        command: "workflow run approve",
        code: "run_not_found",
        message: `Workflow run not found: ${runId}`,
        dataDir,
        runId,
        boundary
      });
    }

    const duplicate = db
      .prepare(
        "SELECT 1 FROM workflow_approvals WHERE run_id = ? AND boundary = ?"
      )
      .get(runId, boundary);
    if (duplicate) {
      return emitWorkflowRunApproveFailure(parsed, io, {
        command: "workflow run approve",
        code: "duplicate_approval",
        message: `Duplicate approval for runId=${runId}, boundary=${boundary}.`,
        dataDir,
        runId,
        boundary
      });
    }

    const resolvedDigest = resolveApprovalArtifactDigest(
      artifactPath,
      parsed.approvalDigest,
      `approve:${runId}:${boundary}:${phrase}`
    );
    if (resolvedDigest === null) {
      return emitWorkflowRunApproveFailure(parsed, io, {
        command: "workflow run approve",
        code: "approval_digest_mismatch",
        message: artifactPath
          ? `Approval artifact digest mismatch for path: ${artifactPath}.`
          : "Missing approval artifact digest compatibility for durable approval entry.",
        dataDir,
        runId,
        boundary
      });
    }

    approvalArtifactDigest = resolvedDigest.value;
    recordedAt = Date.now();
    const storedPath =
      artifactPath ?? `workflow-run-approve://${runId}/${boundary}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = db
        .prepare(
          "SELECT id, state, approval_boundary, needs_manual_recovery, manual_recovery_reason FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as
        | {
            id: string;
            state: WorkflowRunState;
            approval_boundary: string | null;
            needs_manual_recovery: number;
            manual_recovery_reason: string | null;
          }
        | undefined;
      if (!runRow) {
        db.exec("ROLLBACK");
        return emitWorkflowRunApproveFailure(parsed, io, {
          command: "workflow run approve",
          code: "run_not_found",
          message: `Workflow run not found: ${runId}`,
          dataDir,
          runId,
          boundary
        });
      }

      const duplicateInTransaction = db
        .prepare(
          "SELECT 1 FROM workflow_approvals WHERE run_id = ? AND boundary = ?"
        )
        .get(runId, boundary);
      if (duplicateInTransaction) {
        db.exec("ROLLBACK");
        return emitWorkflowRunApproveFailure(parsed, io, {
          command: "workflow run approve",
          code: "duplicate_approval",
          message: `Duplicate approval for runId=${runId}, boundary=${boundary}.`,
          dataDir,
          runId,
          boundary
        });
      }

      if (isTerminalRunState(runRow.state)) {
        db.exec("ROLLBACK");
        return emitWorkflowRunApproveFailure(parsed, io, {
          command: "workflow run approve",
          code: "invalid_state",
          message: `Workflow run is terminal and cannot be approved: ${runId} (${runRow.state})`,
          dataDir,
          runId,
          boundary
        });
      }
      if (runRow.needs_manual_recovery === 1) {
        db.exec("ROLLBACK");
        return emitWorkflowRunApproveFailure(parsed, io, {
          command: "workflow run approve",
          code: "manual_recovery_required",
          message:
            runRow.manual_recovery_reason ??
            `Workflow run requires manual recovery before approval: ${runId}`,
          dataDir,
          runId,
          boundary
        });
      }

      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path,
           artifact_digest, recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        boundary,
        parsed.actor ?? null,
        phrase,
        storedPath,
        resolvedDigest.value,
        recordedAt,
        null,
        recordedAt,
        recordedAt
      );

      const nextApprovalBoundary = highestWorkflowApprovalBoundary(
        runRow.approval_boundary,
        boundary
      );
      db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run(nextApprovalBoundary, recordedAt, runId);

      const approvedKinds = workflowStepKindsForApprovalBoundary(boundary);
      if (approvedKinds.length > 0) {
        db.prepare(
          `UPDATE workflow_steps
             SET state = 'approved', updated_at = ?
           WHERE run_id = ?
             AND state = 'pending'
             AND kind IN (${approvedKinds.map(() => "?").join(", ")})`
        ).run(recordedAt, runId, ...approvedKinds);
      }

      db.prepare(
        "UPDATE workflow_runs SET state = 'approved', updated_at = ? WHERE id = ? AND state = 'pending'"
      ).run(recordedAt, runId);

      refreshWorkflowRunMonitorAdvisory(db, runId, recordedAt);

      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no-op
      }
      if (isUniqueViolation(error)) {
        return emitWorkflowRunApproveFailure(parsed, io, {
          command: "workflow run approve",
          code: "duplicate_approval",
          message: `Duplicate approval for runId=${runId}, boundary=${boundary}.`,
          dataDir,
          runId,
          boundary
        });
      }
      throw error;
    }
  } finally {
    db.close();
  }

  const payload = {
    ok: true,
    command: "workflow run approve",
    dataDir,
    runId,
    boundary,
    phrase,
    actor: parsed.actor ?? null,
    artifactPath: artifactPath ?? `workflow-run-approve://${runId}/${boundary}`,
    artifactDigest: approvalArtifactDigest,
    recordedAt
  };
  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow run approval recorded for ${runId}`,
    `Boundary: ${boundary}`,
    `Phrase: ${phrase}`,
    `Actor: ${parsed.actor ?? "(unset)"}`,
    `Artifact: ${artifactPath ?? "(inline/implicit)"}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitWorkflowRunApproveFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunApproveFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;
  if (failure.boundary !== undefined) payload["boundary"] = failure.boundary;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

const WORKFLOW_RUN_UPDATE_STEP_TARGET_STATES = [
  "approved",
  "succeeded",
  "skipped",
  "failed",
  "blocked",
  "canceled"
] as const satisfies readonly WorkflowStepState[];

type WorkflowRunUpdateStepTargetState =
  (typeof WORKFLOW_RUN_UPDATE_STEP_TARGET_STATES)[number];

function isWorkflowRunUpdateStepTargetState(
  value: string
): value is WorkflowRunUpdateStepTargetState {
  return (WORKFLOW_RUN_UPDATE_STEP_TARGET_STATES as readonly string[]).includes(
    value
  );
}

type WorkflowRunUpdateStepFailureCode =
  | "data_dir_failed"
  | "run_id_required"
  | "run_not_found"
  | "manual_recovery_required"
  | "step_not_found"
  | "invalid_state"
  | "invalid_transition";

type WorkflowRunUpdateStepFailure = {
  command: "workflow run update-step";
  code: WorkflowRunUpdateStepFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
  stepId?: string;
};

function workflowRunUpdateStep(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length === 0 || !positional[0]) {
    return emitWorkflowRunUpdateStepFailure(parsed, io, {
      command: "workflow run update-step",
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run update-step."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run update-step: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];

  const stepId = parsed.step?.trim();
  if (!stepId) {
    return emitWorkflowRunUpdateStepFailure(parsed, io, {
      command: "workflow run update-step",
      code: "step_not_found",
      message:
        "Missing required --step <step-id> for workflow run update-step.",
      runId
    });
  }

  if (!parsed.state || !isWorkflowRunUpdateStepTargetState(parsed.state)) {
    return emitWorkflowRunUpdateStepFailure(parsed, io, {
      command: "workflow run update-step",
      code: "invalid_state",
      message:
        `Invalid --state target for workflow run update-step: ${parsed.state ?? "(unset)"}. ` +
        `Expected one of ${WORKFLOW_RUN_UPDATE_STEP_TARGET_STATES.join(", ")}.`,
      runId,
      stepId
    });
  }
  const targetState = parsed.state;

  const reason = parsed.reason?.trim();
  if (!reason) {
    return emitWorkflowRunUpdateStepFailure(parsed, io, {
      command: "workflow run update-step",
      code: "invalid_transition",
      message: "Missing required --reason <text> for workflow run update-step.",
      runId,
      stepId
    });
  }

  const actor = parsed.actor ?? null;
  const evidencePointer = parsed.evidencePointer ?? null;
  const ledgerPointer = parsed.ledgerPointer ?? null;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunUpdateStepFailure(parsed, io, {
      command: "workflow run update-step",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId,
      stepId
    });
  }

  let resultPayload: Record<string, unknown> | null = null;

  const db = openDb(dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = db
        .prepare(
          "SELECT id, state, needs_manual_recovery, manual_recovery_reason FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as
        | {
            id: string;
            state: WorkflowRunState;
            needs_manual_recovery: number;
            manual_recovery_reason: string | null;
          }
        | undefined;
      if (!runRow) {
        db.exec("ROLLBACK");
        return emitWorkflowRunUpdateStepFailure(parsed, io, {
          command: "workflow run update-step",
          code: "run_not_found",
          message: `Workflow run not found: ${runId}`,
          dataDir,
          runId,
          stepId
        });
      }
      const stepRow = db
        .prepare(
          `SELECT state, operator_reason, operator_actor,
                  operator_evidence_pointer, operator_ledger_pointer,
                  operator_transition_at
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`
        )
        .get(runId, stepId) as
        | {
            state: WorkflowStepState;
            operator_reason: string | null;
            operator_actor: string | null;
            operator_evidence_pointer: string | null;
            operator_ledger_pointer: string | null;
            operator_transition_at: number | null;
          }
        | undefined;
      if (!stepRow) {
        db.exec("ROLLBACK");
        return emitWorkflowRunUpdateStepFailure(parsed, io, {
          command: "workflow run update-step",
          code: "step_not_found",
          message: `Workflow step not found: runId=${runId}, stepId=${stepId}`,
          dataDir,
          runId,
          stepId
        });
      }

      const previousState = stepRow.state;
      const sameAuditContext =
        stepRow.operator_reason === reason &&
        stepRow.operator_actor === actor &&
        stepRow.operator_evidence_pointer === evidencePointer &&
        stepRow.operator_ledger_pointer === ledgerPointer;
      const transition = transitionWorkflowStep(previousState, targetState);
      const now = Date.now();
      if (runRow.needs_manual_recovery === 1) {
        const resolvesManualRecovery =
          transition.ok &&
          workflowRunStepUpdateResolvesManualRecovery(db, {
            runId,
            stepId,
            targetState,
            now
          });
        if (!resolvesManualRecovery) {
          db.exec("ROLLBACK");
          return emitWorkflowRunUpdateStepFailure(parsed, io, {
            command: "workflow run update-step",
            code: "manual_recovery_required",
            message:
              runRow.manual_recovery_reason ??
              `Workflow run requires manual recovery before step updates: ${runId}`,
            dataDir,
            runId,
            stepId
          });
        }
      }
      if (
        isTerminalRunState(runRow.state) &&
        !(previousState === targetState && sameAuditContext)
      ) {
        db.exec("ROLLBACK");
        return emitWorkflowRunUpdateStepFailure(parsed, io, {
          command: "workflow run update-step",
          code: "invalid_transition",
          message: `Workflow run is terminal and cannot be updated: ${runId} (${runRow.state})`,
          dataDir,
          runId,
          stepId
        });
      }
      if (!transition.ok) {
        db.exec("ROLLBACK");
        return emitWorkflowRunUpdateStepFailure(parsed, io, {
          command: "workflow run update-step",
          code: "invalid_transition",
          message: transition.errorMessage,
          dataDir,
          runId,
          stepId
        });
      }

      let idempotent = false;
      if (previousState === targetState) {
        // Step already in the target state: only a byte-equal re-finalize is a
        // safe idempotent no-op; any change to the audit context is refused so
        // a stale repeat cannot silently rewrite the durable operator record.
        if (!sameAuditContext) {
          db.exec("ROLLBACK");
          return emitWorkflowRunUpdateStepFailure(parsed, io, {
            command: "workflow run update-step",
            code: "invalid_transition",
            message: `Workflow step ${stepId} is already ${targetState}; refusing to rewrite operator audit context.`,
            dataDir,
            runId,
            stepId
          });
        }
        idempotent = true;
      } else {
        const finishedAt = isTerminalStepState(targetState) ? now : null;
        db.prepare(
          `UPDATE workflow_steps
             SET state = ?,
                 operator_reason = ?,
                 operator_actor = ?,
                 operator_evidence_pointer = ?,
                 operator_ledger_pointer = ?,
                 operator_transition_at = ?,
                 finished_at = COALESCE(?, finished_at),
                 updated_at = ?
           WHERE run_id = ? AND step_id = ?`
        ).run(
          targetState,
          reason,
          actor,
          evidencePointer,
          ledgerPointer,
          now,
          finishedAt,
          now,
          runId,
          stepId
        );
      }

      const stepRecords = loadWorkflowStepRecords(db, runId);
      const leaseRecords = loadWorkflowLeaseRecords(db, runId);
      const runState = deriveWorkflowRunState(stepRecords, {
        leases: leaseRecords,
        now
      });
      refreshWorkflowRunMonitorAdvisory(db, runId, now);
      const runFinishedAt = isTerminalRunState(runState) ? now : null;
      db.prepare(
        `UPDATE workflow_runs
           SET state = ?,
               finished_at = COALESCE(finished_at, ?),
               updated_at = ?
         WHERE id = ?`
      ).run(
        runState,
        runFinishedAt,
        now,
        runId
      );

      db.exec("COMMIT");

      resultPayload = {
        ok: true,
        command: "workflow run update-step",
        dataDir,
        runId,
        stepId,
        state: targetState,
        previousState,
        runState,
        reason,
        actor,
        evidencePointer,
        ledgerPointer,
        idempotent
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no-op
      }
      throw error;
    }
  } finally {
    db.close();
  }

  if (resultPayload === null) {
    return 1;
  }

  if (parsed.json) {
    writeJson(io.stdout, resultPayload);
    return 0;
  }

  const lines = [
    `Workflow step updated for ${runId}`,
    `Step: ${stepId}`,
    `State: ${String(resultPayload["previousState"])} -> ${targetState}`,
    `Run state: ${String(resultPayload["runState"])}`,
    `Reason: ${reason}`,
    `Actor: ${actor ?? "(unset)"}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function workflowRunStepUpdateResolvesManualRecovery(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    targetState: WorkflowStepState;
    now: number;
  }
): boolean {
  const steps = loadWorkflowStepRecords(db, input.runId).map((step) =>
    step.stepId === input.stepId
      ? { ...step, state: input.targetState }
      : step
  );
  const leases = loadWorkflowLeaseRecords(db, input.runId);
  const monitor = deriveWorkflowMonitorState({
    runId: input.runId,
    steps,
    leases,
    monitor: null,
    lastCheckpoint: null,
    now: input.now
  });
  return (
    monitor.recovery === null ||
    !isBlockingWorkflowRecoveryCode(monitor.recovery.code)
  );
}

function loadWorkflowStepRecords(
  db: MomentumDb,
  runId: string
): WorkflowStepRecord[] {
  const rows = db
    .prepare(
      "SELECT step_id, kind, state, step_order, required FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
    )
    .all(runId) as Array<{
    step_id: string;
    kind: string;
    state: string;
    step_order: number;
    required: number;
  }>;
  return rows.map((row) => ({
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    state: row.state as WorkflowStepState,
    order: row.step_order,
    required: row.required === 1
  }));
}

function loadWorkflowLeaseRecords(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRecord[] {
  const rows = db
    .prepare(
      `SELECT run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, released_at, stale_policy
         FROM workflow_leases WHERE run_id = ? ORDER BY lease_kind`
    )
    .all(runId) as Array<{
    run_id: string;
    lease_kind: string;
    holder: string;
    acquired_at: number;
    expires_at: number;
    heartbeat_at: number;
    released_at: number | null;
    stale_policy: string;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    leaseKind: row.lease_kind as WorkflowLeaseRecord["leaseKind"],
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseRecord["stalePolicy"]
  }));
}

function refreshWorkflowRunMonitorAdvisory(
  db: MomentumDb,
  runId: string,
  now: number
): WorkflowMonitorState {
  const stepRecords = loadWorkflowStepRecords(db, runId);
  const leaseRecords = loadWorkflowLeaseRecords(db, runId);
  const monitorState = deriveWorkflowMonitorState({
    runId,
    steps: stepRecords,
    leases: leaseRecords,
    monitor: null,
    lastCheckpoint: null,
    now
  });
  db.prepare(
    `UPDATE workflow_runs
       SET updated_at = ?,
           monitor_last_seen_state = ?,
           monitor_terminal = ?,
           monitor_step = ?,
           monitor_last_seen_digest = NULL,
           monitor_last_emitted_digest = NULL
     WHERE id = ?`
  ).run(
    now,
    monitorState.runState,
    monitorState.terminal ? 1 : 0,
    monitorState.activeStep?.stepId ?? null,
    runId
  );
  return monitorState;
}

function emitWorkflowRunUpdateStepFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunUpdateStepFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;
  if (failure.stepId !== undefined) payload["stepId"] = failure.stepId;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function workflowRunClearRecovery(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length === 0 || !positional[0]) {
    return emitWorkflowRunClearRecoveryFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run clear-recovery."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run clear-recovery: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunClearRecoveryFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId
    });
  }

  const db = openDb(dataDir);
  let result: ClearWorkflowRunManualRecoveryGuardedResult;
  try {
    result = clearWorkflowRunManualRecoveryGuarded(db, { runId });
    if (result.ok) {
      refreshWorkflowRunMonitorAdvisory(db, runId, result.clearedAt);
    }
  } finally {
    db.close();
  }

  return emitWorkflowRunClearRecovery(parsed, io, dataDir, runId, result);
}

function emitWorkflowRunClearRecovery(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  runId: string,
  result: ClearWorkflowRunManualRecoveryGuardedResult
): number {
  if (!result.ok) {
    const payload: Record<string, unknown> = {
      ok: false,
      command: "workflow run clear-recovery",
      code: result.reason,
      message: result.message,
      runId,
      dataDir
    };
    if (result.recoveryCode !== undefined) {
      payload["recoveryCode"] = result.recoveryCode;
    }
    if (result.blockingStepId !== undefined && result.blockingStepId !== null) {
      payload["blockingStepId"] = result.blockingStepId;
    }
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.message}\n`);
    return 1;
  }

  const payload = {
    ok: true,
    command: "workflow run clear-recovery",
    runId: result.runId,
    dataDir,
    previousReason: result.previousReason,
    previousMarkedAt: result.previousMarkedAt,
    clearedAt: result.clearedAt
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Manual recovery cleared for run: ${result.runId}`,
    `Previous reason: ${result.previousReason ?? "(unset)"}`,
    `Previous marked at: ${result.previousMarkedAt ?? "(unset)"}`,
    `Cleared at: ${result.clearedAt}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

type WorkflowRunClearRecoveryFailureCode =
  | "data_dir_failed"
  | "run_id_required";

function emitWorkflowRunClearRecoveryFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: {
    code: WorkflowRunClearRecoveryFailureCode;
    message: string;
    runId?: string;
  }
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "workflow run clear-recovery",
    code: failure.code,
    message: failure.message
  };
  if (failure.runId !== undefined) payload["runId"] = failure.runId;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

type WorkflowRunMonitorFailureCode =
  | "data_dir_failed"
  | "run_id_required"
  | "run_not_found";

type WorkflowRunMonitorFailure = {
  code: WorkflowRunMonitorFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
};

function workflowRunMonitor(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length === 0 || !positional[0]) {
    return emitWorkflowRunMonitorFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run monitor."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run monitor: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunMonitorFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId
    });
  }

  let envelope: WorkflowMonitorEnvelope | null;
  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);
    envelope = loadWorkflowMonitorEnvelope(db, runId);
  } catch (err) {
    return emitWorkflowRunMonitorFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      runId
    });
  } finally {
    db?.close();
  }

  if (envelope === null) {
    return emitWorkflowRunMonitorFailure(parsed, io, {
      code: "run_not_found",
      message: `Workflow run not found: ${runId}`,
      dataDir,
      runId
    });
  }

  return emitWorkflowRunMonitor(parsed, io, dataDir, envelope);
}

function emitWorkflowRunMonitor(
  parsed: ParsedFlags,
  io: CliIo,
  dataDir: string,
  envelope: WorkflowMonitorEnvelope
): number {
  const payload = {
    ok: true,
    command: "workflow run monitor",
    dataDir,
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    runId: envelope.runId,
    runState: envelope.runState,
    stepState: envelope.stepState,
    terminal: envelope.terminal,
    blocked: envelope.blocked,
    needsManualRecovery: envelope.needsManualRecovery,
    disposition: envelope.disposition,
    reportable: envelope.reportable,
    reportReason: envelope.reportReason,
    activeStep: envelope.activeStep
      ? {
          stepId: envelope.activeStep.stepId,
          kind: envelope.activeStep.kind,
          state: envelope.activeStep.state,
          order: envelope.activeStep.order,
          required: envelope.activeStep.required
        }
      : null,
    leases: envelope.leases.map((lease) => ({
      leaseKind: lease.leaseKind,
      holder: lease.holder,
      classification: lease.classification,
      expiresAt: lease.expiresAt,
      heartbeatAt: lease.heartbeatAt,
      releasedAt: lease.releasedAt
    })),
    lastCheckpoint: envelope.lastCheckpoint
      ? {
          stepId: envelope.lastCheckpoint.stepId,
          at: envelope.lastCheckpoint.at,
          source: envelope.lastCheckpoint.source,
          digest: envelope.lastCheckpoint.digest
        }
      : null,
    monitorDrift: envelope.monitorDrift
      ? {
          advisoryState: envelope.monitorDrift.advisoryState,
          advisoryTerminal: envelope.monitorDrift.advisoryTerminal,
          actualState: envelope.monitorDrift.actualState,
          drifted: envelope.monitorDrift.drifted,
          reason: envelope.monitorDrift.reason
        }
      : null,
    nextAction: {
      code: envelope.nextAction.code,
      stepId: envelope.nextAction.stepId,
      leaseKind: envelope.nextAction.leaseKind,
      detail: envelope.nextAction.detail
    },
    recovery: envelope.recovery
      ? {
          code: envelope.recovery.code,
          message: envelope.recovery.message,
          stepId: envelope.recovery.stepId
        }
      : null,
    evidence: envelope.evidence.map(workflowEvidenceToJsonShape),
    counts: {
      steps: envelope.counts.steps,
      stepsByState: envelope.counts.stepsByState,
      approvals: envelope.counts.approvals,
      leases: envelope.counts.leases
    }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowMonitorText(dataDir, envelope));
  return 0;
}

function renderWorkflowMonitorText(
  dataDir: string,
  envelope: WorkflowMonitorEnvelope
): string {
  const lines: string[] = [];
  lines.push(`Workflow run monitor: ${envelope.runId}`);
  lines.push(`Schema version: ${envelope.schemaVersion}`);
  lines.push(`Run state: ${envelope.runState}`);
  lines.push(`Step state: ${envelope.stepState ?? "(none)"}`);
  lines.push(`Terminal: ${envelope.terminal}`);
  lines.push(`Blocked: ${envelope.blocked}`);
  lines.push(`Needs manual recovery: ${envelope.needsManualRecovery}`);
  lines.push(`Disposition: ${envelope.disposition}`);
  lines.push(`Reportable: ${envelope.reportable}`);
  lines.push(`Report reason: ${envelope.reportReason}`);
  lines.push(`Next action: ${envelope.nextAction.code}`);
  if (envelope.recovery) {
    lines.push(`Recovery: ${envelope.recovery.code}`);
  }
  if (envelope.activeStep) {
    lines.push(
      `Active step: ${envelope.activeStep.stepId} [${envelope.activeStep.state}]`
    );
  }
  lines.push(
    `Steps: ${envelope.counts.steps}` +
      ` approvals=${envelope.counts.approvals} leases=${envelope.counts.leases}`
  );
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");
  return lines.join("\n");
}

function emitWorkflowRunMonitorFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunMonitorFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "workflow run monitor",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function isExplicitBoundaryPhraseForApproval(
  phrase: string,
  boundary: string
): boolean {
  const normalizedPhrase = phrase.trim().toLowerCase();
  const normalizedBoundary = boundary.trim().toLowerCase();

  const casualPhrases = new Set([
    "go ahead",
    "go-ahead",
    "go ahead!",
    "sure",
    "yes",
    "yep",
    "yeah",
    "ok",
    "okay",
    "k"
  ]);
  if (casualPhrases.has(normalizedPhrase)) {
    return false;
  }
  if (normalizedPhrase.length === 0) return false;
  const phraseWords = normalizedPhrase
    .replace(/-/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  const boundaryWords = normalizedBoundary.split("-").filter((word) => word.length > 0);
  if (!phraseWords.includes("approve")) return false;
  if (hasApprovalNegation(phraseWords, boundaryWords)) return false;
  return boundaryWords.every((word) => phraseWords.includes(word));
}

function hasApprovalNegation(
  words: readonly string[],
  boundaryWords: readonly string[]
): boolean {
  const negationWords = new Set(["not", "never", "cannot", "cant", "wont"]);
  if (words.some((word) => negationWords.has(word))) return true;
  if (
    words.some(
      (word, index) =>
        word === "no" &&
        !isWordIndexCoveredByBoundaryPhrase(words, boundaryWords, index)
    )
  ) {
    return true;
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    if (word === "do" && next === "not") return true;
    if (word === "don" && next === "t") return true;
    if (word === "can" && next === "t") return true;
    if (word === "will" && next === "not") return true;
    if (word === "won" && next === "t") return true;
  }
  return false;
}

function isWordIndexCoveredByBoundaryPhrase(
  words: readonly string[],
  boundaryWords: readonly string[],
  wordIndex: number
): boolean {
  if (!boundaryWords.includes("no")) return false;
  for (let start = 0; start <= words.length - boundaryWords.length; start += 1) {
    const end = start + boundaryWords.length;
    if (wordIndex < start || wordIndex >= end) continue;
    if (boundaryWords.every((word, offset) => words[start + offset] === word)) {
      return true;
    }
  }
  return false;
}

function resolveApprovalArtifactDigest(
  artifactPath: string | undefined,
  providedDigest: string | undefined,
  fallbackInput: string
): { value: string } | null {
  if (!artifactPath) {
    const fallbackDigest = crypto
      .createHash("sha256")
      .update(fallbackInput)
      .digest("hex");
    if (providedDigest !== undefined) {
      return providedDigest === fallbackDigest ? { value: fallbackDigest } : null;
    }
    return { value: fallbackDigest };
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(artifactPath);
  } catch {
    return null;
  }
  const actualDigest = crypto.createHash("sha256").update(body).digest("hex");
  if (providedDigest !== undefined && providedDigest !== actualDigest) {
    return null;
  }
  return { value: actualDigest };
}

type WorkflowHandoffFailureCode = "data_dir_failed" | "run_not_found" | "run_id_required";

type WorkflowHandoffFailure = {
  command: "workflow handoff";
  code: WorkflowHandoffFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
};

function workflowHandoff(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(2);
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow handoff: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];
  if (runId === undefined) {
    return emitWorkflowHandoffFailure(parsed, io, {
      command: "workflow handoff",
      code: "run_id_required",
      message: "Missing required <run-id> for workflow handoff."
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowHandoffFailure(parsed, io, {
      command: "workflow handoff",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId
    });
  }

  const db = openDb(dataDir);
  let envelope: WorkflowHandoffEnvelope | null;
  try {
    envelope = loadWorkflowHandoff(db, runId);
  } finally {
    db.close();
  }

  if (envelope === null) {
    return emitWorkflowHandoffFailure(parsed, io, {
      command: "workflow handoff",
      code: "run_not_found",
      message: `Workflow run not found: ${runId}`,
      dataDir,
      runId
    });
  }

  const payload = {
    ok: true,
    command: "workflow handoff",
    dataDir,
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    run: workflowRunToJsonShape(envelope.detail.run),
    steps: envelope.detail.steps.map(workflowStepToJsonShape),
    approvals: envelope.detail.approvals.map(workflowApprovalToJsonShape),
    leases: envelope.detail.leases.map(workflowLeaseToJsonShape),
    monitor: workflowMonitorToJsonShape(envelope.detail.monitor),
    evidence: envelope.detail.evidence.map(workflowEvidenceToJsonShape),
    nextAction: nextActionToJsonShape(envelope.detail.monitor)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowHandoffText(dataDir, envelope));
  return 0;
}

function emitWorkflowHandoffFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowHandoffFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function summaryToJsonShape(
  summary: WorkflowRunSummary
): Record<string, unknown> {
  return {
    run: workflowRunToJsonShape(summary.run),
    counts: {
      steps: summary.counts.steps,
      stepsByState: summary.counts.stepsByState,
      approvals: summary.counts.approvals,
      leases: summary.counts.leases
    },
    monitor: workflowMonitorToJsonShape(summary.monitor)
  };
}

function workflowRunToJsonShape(run: WorkflowRunRow): Record<string, unknown> {
  return {
    runId: run.runId,
    state: run.state,
    source: run.source,
    sourceArtifactPath: run.sourceArtifactPath,
    repoPath: run.repoPath,
    objective: run.objective,
    issueScope: run.issueScope,
    route: run.route,
    approvalBoundary: run.approvalBoundary,
    skillRevision: run.skillRevision,
    goalId: run.goalId,
    batchGroup: run.batchGroup,
    batchRole: run.batchRole,
    needsManualRecovery: run.needsManualRecovery,
    manualRecoveryReason: run.manualRecoveryReason,
    manualRecoveryAt: run.manualRecoveryAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function workflowStepToJsonShape(
  step: WorkflowStepRow
): Record<string, unknown> {
  return {
    runId: step.runId,
    stepId: step.stepId,
    kind: step.kind,
    state: step.state,
    order: step.order,
    required: step.required,
    ledgerOffset: step.ledgerOffset,
    resultDigest: step.resultDigest,
    errorCode: step.errorCode,
    errorMessage: step.errorMessage,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt
  };
}

function workflowApprovalToJsonShape(
  approval: WorkflowApprovalRow
): Record<string, unknown> {
  return {
    runId: approval.runId,
    boundary: approval.boundary,
    actor: approval.actor,
    phrase: approval.phrase,
    artifactPath: approval.artifactPath,
    artifactDigest: approval.artifactDigest,
    recordedAt: approval.recordedAt,
    dischargedAt: approval.dischargedAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt
  };
}

function workflowLeaseToJsonShape(
  lease: WorkflowLeaseRow
): Record<string, unknown> {
  return {
    runId: lease.runId,
    leaseKind: lease.leaseKind,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt,
    releasedAt: lease.releasedAt,
    stalePolicy: lease.stalePolicy,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt
  };
}

function workflowMonitorToJsonShape(
  monitor: WorkflowMonitorState
): Record<string, unknown> {
  return {
    runId: monitor.runId,
    runState: monitor.runState,
    terminal: monitor.terminal,
    blocked: monitor.blocked,
    activeStep: monitor.activeStep
      ? {
          stepId: monitor.activeStep.stepId,
          kind: monitor.activeStep.kind,
          state: monitor.activeStep.state,
          order: monitor.activeStep.order,
          required: monitor.activeStep.required
        }
      : null,
    leases: monitor.leases.map((lease) => ({
      leaseKind: lease.leaseKind,
      holder: lease.holder,
      classification: lease.classification,
      expiresAt: lease.expiresAt,
      heartbeatAt: lease.heartbeatAt,
      releasedAt: lease.releasedAt
    })),
    lastCheckpoint: monitor.lastCheckpoint
      ? {
          stepId: monitor.lastCheckpoint.stepId,
          at: monitor.lastCheckpoint.at,
          source: monitor.lastCheckpoint.source,
          digest: monitor.lastCheckpoint.digest
        }
      : null,
    monitorDrift: monitor.monitorDrift
      ? {
          advisoryState: monitor.monitorDrift.advisoryState,
          advisoryTerminal: monitor.monitorDrift.advisoryTerminal,
          actualState: monitor.monitorDrift.actualState,
          drifted: monitor.monitorDrift.drifted,
          reason: monitor.monitorDrift.reason
        }
      : null,
    nextAction: nextActionToJsonShape(monitor),
    needsRecoveryArtifact: monitor.needsRecoveryArtifact,
    recovery: monitor.recovery
      ? {
          code: monitor.recovery.code,
          message: monitor.recovery.message,
          stepId: monitor.recovery.stepId
        }
      : null
  };
}

function nextActionToJsonShape(
  monitor: WorkflowMonitorState
): Record<string, unknown> {
  return {
    code: monitor.nextAction.code,
    stepId: monitor.nextAction.stepId,
    leaseKind: monitor.nextAction.leaseKind,
    detail: monitor.nextAction.detail
  };
}

function workflowEvidenceToJsonShape(
  evidence: WorkflowEvidenceLink
): Record<string, unknown> {
  return {
    evidenceRecordId: evidence.evidenceRecordId,
    source: evidence.source,
    type: evidence.type,
    artifactPath: evidence.artifactPath,
    occurredAt: evidence.occurredAt,
    summary: evidence.summary,
    runId: evidence.runId,
    stepId: evidence.stepId
  };
}

function renderWorkflowDetailText(
  dataDir: string,
  detail: WorkflowRunDetail
): string {
  const lines: string[] = [];
  lines.push(`Workflow run: ${detail.run.runId}`);
  lines.push(`State: ${detail.run.state}`);
  lines.push(`Source: ${detail.run.source}`);
  if (detail.run.objective !== null) {
    lines.push(`Objective: ${detail.run.objective}`);
  }
  if (detail.run.repoPath !== null) {
    lines.push(`Repo: ${detail.run.repoPath}`);
  }
  if (detail.run.approvalBoundary !== null) {
    lines.push(`Approval boundary: ${detail.run.approvalBoundary}`);
  }
  if (detail.run.sourceArtifactPath !== null) {
    lines.push(`Artifact dir: ${detail.run.sourceArtifactPath}`);
  }
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");

  lines.push(`Steps: ${detail.steps.length}`);
  for (const step of detail.steps) {
    lines.push(
      `- ${step.stepId} [${step.state}] kind=${step.kind} ` +
        `order=${step.order} required=${step.required ? "yes" : "no"}` +
        (step.errorCode ? ` error=${step.errorCode}` : "")
    );
  }
  lines.push("");

  lines.push(`Approvals: ${detail.approvals.length}`);
  for (const approval of detail.approvals) {
    lines.push(
      `- ${approval.boundary} actor=${approval.actor ?? "(unknown)"} ` +
        `recorded=${approval.recordedAt}` +
        (approval.dischargedAt !== null
          ? ` discharged=${approval.dischargedAt}`
          : "")
    );
  }
  lines.push("");

  lines.push(`Leases: ${detail.leases.length}`);
  for (const lease of detail.leases) {
    lines.push(
      `- ${lease.leaseKind} holder=${lease.holder} stale_policy=${lease.stalePolicy} ` +
        `expires=${lease.expiresAt} heartbeat=${lease.heartbeatAt}` +
        (lease.releasedAt !== null ? ` released=${lease.releasedAt}` : "")
    );
  }
  lines.push("");

  lines.push("Monitor");
  lines.push(`- Run state: ${detail.monitor.runState}`);
  lines.push(`- Terminal: ${detail.monitor.terminal ? "yes" : "no"}`);
  lines.push(`- Blocked: ${detail.monitor.blocked ? "yes" : "no"}`);
  if (detail.monitor.activeStep) {
    lines.push(
      `- Active step: ${detail.monitor.activeStep.stepId} (${detail.monitor.activeStep.state})`
    );
  } else {
    lines.push("- Active step: (none)");
  }
  if (detail.monitor.lastCheckpoint) {
    lines.push(
      `- Last checkpoint: ${detail.monitor.lastCheckpoint.stepId} ` +
        `at ${detail.monitor.lastCheckpoint.at} (source=${detail.monitor.lastCheckpoint.source})`
    );
  } else {
    lines.push("- Last checkpoint: (none)");
  }
  lines.push(
    `- Next action: ${detail.monitor.nextAction.code} - ${detail.monitor.nextAction.detail}`
  );
  if (detail.monitor.recovery) {
    lines.push(
      `- Recovery: ${detail.monitor.recovery.code} - ${detail.monitor.recovery.message}`
    );
  }
  if (detail.monitor.monitorDrift?.drifted) {
    lines.push(
      `- Monitor drift: ${detail.monitor.monitorDrift.reason ?? "(unspecified)"}`
    );
  }
  lines.push("");

  lines.push(`Evidence: ${detail.evidence.length}`);
  for (const record of detail.evidence) {
    lines.push(
      `- ${record.evidenceRecordId} [${record.source}/${record.type}] ${record.summary}` +
        (record.stepId !== null ? ` step=${record.stepId}` : "")
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderWorkflowHandoffText(
  dataDir: string,
  envelope: WorkflowHandoffEnvelope
): string {
  const lines: string[] = [];
  lines.push(`Workflow handoff: ${envelope.detail.run.runId}`);
  lines.push(`Schema version: ${envelope.schemaVersion}`);
  lines.push(`Generated at (epoch ms): ${envelope.generatedAt}`);
  lines.push("");
  lines.push(renderWorkflowDetailText(dataDir, envelope.detail));
  return lines.join("\n");
}

type IntentFailureCode =
  | "data_dir_failed"
  | "invalid_status"
  | "goal_not_found"
  | "source_item_not_found"
  | "evidence_record_not_found"
  | "intent_not_found"
  | "reason_required"
  | "intent_already_terminal"
  | "policy_load_failed"
  | "policy_denied"
  | "auth_unavailable"
  | "unsupported_adapter"
  | "unsupported_intent_type"
  | "target_missing"
  | "intent_apply_in_progress"
  | "intent_blocked"
  | "external_conflict"
  | "write_rejected"
  | "write_timeout"
  | "malformed_response"
  | "validation_failed"
  | "adapter_threw"
  | "preview_failed"
  | "audit_incomplete";

type IntentCommand =
  | "intent list"
  | "intent get"
  | "intent apply"
  | "intent skip"
  | "intent cancel";

type IntentExternalApplySummary = {
  adapterKind: string;
  intentType: string;
  target: {
    adapterKind: string;
    externalId: string | null;
    externalKey: string | null;
    url: string | null;
    title: string | null;
  };
  allowStatusMutation: boolean;
  mutationKind: string | null;
  auditId: string | null;
  reconcile: {
    status: string | null;
    warning: string | null;
  };
  external: {
    alreadyApplied: boolean;
    issueId: string | null;
    issueKey: string | null;
    issueUrl: string | null;
    commentId: string | null;
    commentUrl: string | null;
    statusTransitioned: boolean;
    nextStateId: string | null;
    nextStateName: string | null;
    idempotencyMarker: string;
  } | null;
};

type IntentFailure = {
  command: IntentCommand;
  code: IntentFailureCode;
  message: string;
  dataDir?: string;
  intentId?: string;
  goalId?: string;
  sourceItemId?: string;
  evidenceRecordId?: string;
  status?: string;
  currentStatus?: UpdateIntentStatus;
  applyPolicy?: IntentApplyPolicySummary;
  externalApply?: IntentExternalApplySummary;
};

type IntentApplyPolicySummary = {
  effective: UpdateIntentApplyPolicy;
  source: PolicyEffectiveFieldSource;
  externalApplyRequested: boolean;
  externalApplyPerformed: boolean;
  note: string;
};

type IntentApplyPolicyResolution =
  | { ok: true; summary: IntentApplyPolicySummary }
  | { ok: false; code: string; message: string; path?: string | null };

function buildFallbackIntentApplyPolicySummary(
  externalApplyRequested: boolean
): IntentApplyPolicySummary {
  return {
    effective: DEFAULT_INTENT_APPLY_POLICY,
    source: "builtin_default",
    externalApplyRequested,
    externalApplyPerformed: false,
    note:
      "`intent apply` records the operator's manual mark only; " +
      "pass --external-apply with a repo whose MOMENTUM.md sets " +
      "intent_apply_policy: external_apply_allowed to perform an external tracker write."
  };
}

function intent(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for intent. Expected: list, get, apply, skip, cancel.",
      parsed,
      io
    );
  }
  if (subcommand === "list") {
    return intentList(parsed, io);
  }
  if (subcommand === "get") {
    return intentGet(parsed, io);
  }
  if (subcommand === "apply") {
    return intentDecision(parsed, io, "apply", deps);
  }
  if (subcommand === "skip") {
    return intentDecision(parsed, io, "skip", deps);
  }
  if (subcommand === "cancel") {
    return intentDecision(parsed, io, "cancel", deps);
  }
  return usageError(`Unknown intent subcommand: ${subcommand}`, parsed, io);
}

function intentList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for intent list: ${parsed.args[2]}`,
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
    return emitIntentFailure(parsed, io, {
      command: "intent list",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  let statusFilter: UpdateIntentStatus | undefined;
  if (parsed.status !== undefined && parsed.status.length > 0) {
    if (!isUpdateIntentStatus(parsed.status)) {
      return emitIntentFailure(parsed, io, {
        command: "intent list",
        code: "invalid_status",
        message: `Invalid --status value: ${parsed.status}. Expected one of: ${UPDATE_INTENT_STATUSES.join(", ")}.`,
        dataDir,
        status: parsed.status
      });
    }
    statusFilter = parsed.status;
  }

  const filters: ListUpdateIntentsOptions = {};
  if (statusFilter !== undefined) filters.status = statusFilter;
  if (parsed.adapter !== undefined && parsed.adapter.length > 0) {
    filters.adapterKind = parsed.adapter;
  }
  if (parsed.evidenceType !== undefined && parsed.evidenceType.length > 0) {
    filters.intentType = parsed.evidenceType;
  }
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    filters.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    filters.sourceItemId = parsed.sourceItem;
  }
  if (parsed.evidenceRecord !== undefined && parsed.evidenceRecord.length > 0) {
    filters.evidenceRecordId = parsed.evidenceRecord;
  }
  if (parsed.limit !== undefined) {
    filters.limit = parsed.limit;
  }

  const db = openDb(dataDir);
  let intents: UpdateIntent[];
  let totalAvailable: number;
  let auditSummaries: Map<string, IntentApplyAuditSummary | null>;
  try {
    if (filters.goalId !== undefined && filters.goalId !== null) {
      const row = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(filters.goalId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "goal_not_found",
          message: `Goal not found: ${filters.goalId}`,
          dataDir,
          goalId: filters.goalId
        });
      }
    }
    if (filters.sourceItemId !== undefined && filters.sourceItemId !== null) {
      const row = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(filters.sourceItemId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "source_item_not_found",
          message: `Source item not found: ${filters.sourceItemId}`,
          dataDir,
          sourceItemId: filters.sourceItemId
        });
      }
    }
    if (
      filters.evidenceRecordId !== undefined &&
      filters.evidenceRecordId !== null
    ) {
      const row = db
        .prepare("SELECT id FROM evidence_records WHERE id = ?")
        .get(filters.evidenceRecordId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "evidence_record_not_found",
          message: `Evidence record not found: ${filters.evidenceRecordId}`,
          dataDir,
          evidenceRecordId: filters.evidenceRecordId
        });
      }
    }
    intents = listUpdateIntents(db, filters);
    const countOptions: CountUpdateIntentsOptions = {};
    if (filters.status !== undefined) countOptions.status = filters.status;
    if (filters.adapterKind !== undefined)
      countOptions.adapterKind = filters.adapterKind;
    if (filters.intentType !== undefined)
      countOptions.intentType = filters.intentType;
    if (filters.goalId !== undefined) countOptions.goalId = filters.goalId;
    if (filters.sourceItemId !== undefined)
      countOptions.sourceItemId = filters.sourceItemId;
    if (filters.evidenceRecordId !== undefined)
      countOptions.evidenceRecordId = filters.evidenceRecordId;
    totalAvailable =
      filters.limit !== undefined
        ? countUpdateIntents(db, countOptions)
        : intents.length;
    auditSummaries = new Map();
    for (const intent of intents) {
      auditSummaries.set(
        intent.id,
        summarizeIntentApplyAuditsForIntent(db, intent.id)
      );
    }
  } finally {
    db.close();
  }

  const truncated =
    filters.limit !== undefined && totalAvailable > intents.length;

  const payload = {
    ok: true,
    command: "intent list",
    dataDir,
    status: statusFilter ?? null,
    adapter: filters.adapterKind ?? null,
    intentType: filters.intentType ?? null,
    goalId: filters.goalId ?? null,
    sourceItemId: filters.sourceItemId ?? null,
    evidenceRecordId: filters.evidenceRecordId ?? null,
    limit: filters.limit ?? null,
    count: intents.length,
    totalAvailable,
    truncated,
    intents: intents.map((record) => ({
      ...updateIntentToJsonShape(record),
      externalApply: intentApplyAuditSummaryToJsonShape(
        auditSummaries.get(record.id) ?? null
      )
    }))
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intents: ${intents.length}`,
    `Total available: ${totalAvailable}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    `Status: ${statusFilter ?? "(any)"}`,
    `Adapter: ${filters.adapterKind ?? "(any)"}`,
    `Intent type: ${filters.intentType ?? "(any)"}`,
    `Goal: ${filters.goalId ?? "(any)"}`,
    `Source item: ${filters.sourceItemId ?? "(any)"}`,
    `Evidence record: ${filters.evidenceRecordId ?? "(any)"}`,
    `Data dir: ${dataDir}`,
    ...intents.map((record) => {
      const summary = auditSummaries.get(record.id) ?? null;
      const applyState = summary?.applyState ?? "idle";
      const totalAttempts = summary?.totalAttempts ?? 0;
      const latest = summary?.latestAttempt;
      const latestLabel = latest
        ? `${latest.lifecycleState}${latest.resultCode ? `/${latest.resultCode}` : ""}`
        : "(none)";
      return (
        `- ${record.id} [${record.adapterKind}/${record.intentType}] ` +
        `${record.status} target=${record.targetExternalId ?? "(none)"} ` +
        `apply=${applyState} attempts=${totalAttempts} latest=${latestLabel}: ` +
        `${record.reason}`
      );
    }),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function intentGet(parsed: ParsedFlags, io: CliIo): number {
  const intentId = parsed.args[2];
  if (!intentId) {
    return usageError(
      "Missing required <intent-id> for intent get.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for intent get: ${parsed.args[3]}`,
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
    return emitIntentFailure(parsed, io, {
      command: "intent get",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const db = openDb(dataDir);
  let record: UpdateIntent | null;
  let auditSummary: IntentApplyAuditSummary | null;
  try {
    record = getUpdateIntentById(db, intentId);
    auditSummary = record
      ? summarizeIntentApplyAuditsForIntent(db, intentId)
      : null;
  } finally {
    db.close();
  }

  if (!record) {
    return emitIntentFailure(parsed, io, {
      command: "intent get",
      code: "intent_not_found",
      message: `Update intent not found: ${intentId}`,
      dataDir,
      intentId
    });
  }

  const externalApply = intentApplyAuditSummaryToJsonShape(auditSummary);
  const payload = {
    ok: true,
    command: "intent get",
    dataDir,
    intent: updateIntentToJsonShape(record),
    externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intent: ${record.id}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Status: ${record.status}`,
    `Goal: ${record.goalId ?? "(unlinked)"}`,
    `Source item: ${record.sourceItemId ?? "(unlinked)"}`,
    `Evidence record: ${record.evidenceRecordId ?? "(unlinked)"}`,
    `Idempotency key: ${record.idempotencyKey}`,
    `Reason: ${record.reason}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Created at: ${record.createdAt}`,
    `Updated at: ${record.updatedAt}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    ...renderExternalApplyTextLines(externalApply),
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

type IntentDecisionAction = "apply" | "skip" | "cancel";

function intentDecisionCommand(action: IntentDecisionAction): IntentCommand {
  if (action === "apply") return "intent apply";
  if (action === "skip") return "intent skip";
  return "intent cancel";
}

function intentDecision(
  parsed: ParsedFlags,
  io: CliIo,
  action: IntentDecisionAction,
  deps: CliDeps
): number | Promise<number> {
  const command = intentDecisionCommand(action);
  const intentId = parsed.args[2];
  if (!intentId) {
    return usageError(
      `Missing required <intent-id> for ${command}.`,
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for ${command}: ${parsed.args[3]}`,
      parsed,
      io
    );
  }

  const reason = parsed.reason?.trim() ?? "";
  if (reason.length === 0) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "reason_required",
      message: `Missing required --reason for ${command}.`,
      intentId
    });
  }

  if (action === "apply" && parsed.externalApply) {
    return intentExternalApply({
      parsed,
      io,
      deps,
      intentId,
      reason
    });
  }

  const applyPolicyResolution = buildIntentApplyPolicySummary(parsed.repo, false);

  if (!applyPolicyResolution.ok) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "policy_load_failed",
      message: applyPolicyResolution.message,
      intentId
    });
  }
  const applyPolicy = applyPolicyResolution.summary;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const db = openDb(dataDir);
  let result: UpdateIntentDecisionResult;
  try {
    const input: UpdateIntentDecisionInput = {
      intentId,
      decisionReason: reason
    };
    if (action === "apply") {
      result = markUpdateIntentApplied(db, input);
    } else if (action === "skip") {
      result = markUpdateIntentSkipped(db, input);
    } else {
      result = cancelUpdateIntent(db, input);
    }
  } finally {
    db.close();
  }

  if (!result.ok) {
    const failure: IntentFailure = {
      command,
      code: result.code,
      message: result.message,
      dataDir,
      intentId
    };
    if (result.code === "intent_already_terminal" && result.currentStatus) {
      failure.currentStatus = result.currentStatus;
    }
    if (action === "apply") {
      failure.applyPolicy = applyPolicy;
    }
    return emitIntentFailure(parsed, io, failure);
  }

  const payload: JsonPayload = {
    ok: true,
    command,
    dataDir,
    previousStatus: result.previousStatus,
    intent: updateIntentToJsonShape(result.intent)
  };
  if (action === "apply") {
    payload["applyPolicy"] = applyPolicy;
  }

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = result.intent;
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Previous status: ${result.previousStatus}`,
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${dataDir}`
  ];
  if (action === "apply") {
    lines.push(
      `Apply policy: ${applyPolicy.effective} (${applyPolicy.source}); ${applyPolicy.note}`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

async function intentExternalApply(args: {
  parsed: ParsedFlags;
  io: CliIo;
  deps: CliDeps;
  intentId: string;
  reason: string;
}): Promise<number> {
  const { parsed, io, deps, intentId, reason } = args;
  const command: IntentCommand = "intent apply";

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const env = io.env ?? {};
  const db = openDb(dataDir);
  let result: ExecuteExternalApplyResult;
  try {
    const executeDeps: ExecuteExternalApplyDeps = {};
    const factory = deps.buildLinearExternalUpdateClient;
    if (factory) {
      executeDeps.buildLinearClient = (clientEnv) => {
        const apiKeyRaw = clientEnv[LINEAR_API_KEY_ENV] ?? null;
        const apiKey =
          typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0
            ? apiKeyRaw
            : null;
        return factory({ apiKey, env: env as NodeJS.ProcessEnv });
      };
    }
    const refreshFactory =
      deps.buildLinearIssueRefreshClient ??
      ((input: LinearIssueRefreshClientFactoryInput) =>
        defaultBuildLinearRefreshClient(input.env));
    executeDeps.buildLinearRefreshClient = (clientEnv) => {
      const apiKeyRaw = clientEnv[LINEAR_API_KEY_ENV] ?? null;
      const apiKey =
        typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0
          ? apiKeyRaw
          : null;
      return refreshFactory({ apiKey, env: env as NodeJS.ProcessEnv });
    };
    result = await executeExternalApply({
      db,
      intentId,
      operatorReason: reason,
      repoPath: parsed.repo ?? null,
      env,
      statusMutation: null,
      deps: executeDeps
    });
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "adapter_threw",
      message: `External apply orchestration failed unexpectedly: ${
        err instanceof Error ? err.message : String(err)
      }`,
      dataDir,
      intentId
    });
  } finally {
    db.close();
  }

  const applyPolicy = buildExternalApplyPolicySummary(result, true);
  const externalApply = buildIntentExternalApplySummary(result);

  if (!result.ok) {
    const failure: IntentFailure = {
      command,
      code: result.code,
      message: result.message,
      dataDir,
      intentId,
      applyPolicy,
      externalApply
    };
    if (
      result.code === "intent_already_terminal" &&
      result.intent &&
      isUpdateIntentStatus(result.intent.status)
    ) {
      failure.currentStatus = result.intent.status;
    }
    return emitIntentFailure(parsed, io, failure);
  }

  const payload: JsonPayload = {
    ok: true,
    command,
    dataDir,
    previousStatus: "pending",
    intent: updateIntentToJsonShape(result.intent),
    applyPolicy,
    externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = result.intent;
  const target = externalApply.target;
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Previous status: pending`,
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${dataDir}`,
    `Apply policy: ${applyPolicy.effective} (${applyPolicy.source}); ${applyPolicy.note}`,
    `External apply: performed (audit ${externalApply.auditId ?? "(none)"})`,
    `Target: ${target.adapterKind} ${target.externalKey ?? target.externalId ?? "(unknown)"}${target.url ? ` <${target.url}>` : ""}`
  ];
  if (externalApply.external) {
    const ext = externalApply.external;
    lines.push(
      `Comment: ${ext.commentId ?? "(none)"}${ext.commentUrl ? ` <${ext.commentUrl}>` : ""}${ext.alreadyApplied ? " (replay)" : ""}`
    );
    if (ext.statusTransitioned) {
      lines.push(
        `Status transition: ${ext.nextStateName ?? ext.nextStateId ?? "(unknown)"}`
      );
    }
    lines.push(`Idempotency marker: ${ext.idempotencyMarker}`);
  }
  if (externalApply.reconcile.status) {
    lines.push(
      `Reconcile: ${externalApply.reconcile.status}${
        externalApply.reconcile.warning
          ? ` (${externalApply.reconcile.warning})`
          : ""
      }`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function buildExternalApplyPolicySummary(
  result: ExecuteExternalApplyResult,
  externalApplyRequested: boolean
): IntentApplyPolicySummary {
  const base = buildFallbackIntentApplyPolicySummary(externalApplyRequested);
  const resolved = result.context.applyPolicy;
  const source: PolicyEffectiveFieldSource =
    resolved.source === "missing_repo" ? "builtin_default" : resolved.source;
  const performed = externalApplyPerformed(result);
  let note: string;
  if (result.ok) {
    note = "External apply was performed through the configured tracker adapter.";
  } else if (performed) {
    note =
      "External write was performed, but post-write finalization did not complete; inspect externalApply and run operator recovery before retrying.";
  } else if (resolved.value !== "external_apply_allowed") {
    note = base.note;
  } else {
    note =
      "External apply was attempted and refused before marking the intent applied; inspect externalApply for audit and adapter details.";
  }
  return {
    ...base,
    effective: resolved.value,
    source,
    externalApplyPerformed: performed,
    note
  };
}

function externalApplyPerformed(result: ExecuteExternalApplyResult): boolean {
  if (result.ok) return true;
  return Boolean(
    result.external?.commentId ||
      result.external?.statusTransitioned ||
      result.external?.alreadyApplied
  );
}

function buildIntentExternalApplySummary(
  result: ExecuteExternalApplyResult
): IntentExternalApplySummary {
  const ctx = result.context;
  const external = result.external;
  return {
    adapterKind: ctx.adapterKind,
    intentType: ctx.intentType,
    target: {
      adapterKind: ctx.target.adapterKind,
      externalId: ctx.target.externalId,
      externalKey: ctx.target.externalKey,
      url: ctx.target.url,
      title: ctx.target.title
    },
    allowStatusMutation: ctx.allowStatusMutation,
    mutationKind: ctx.mutationKind,
    auditId: ctx.auditId,
    reconcile: {
      status: ctx.reconcile.status,
      warning: ctx.reconcile.warning
    },
    external: external
      ? {
          alreadyApplied: external.alreadyApplied,
          issueId: external.issueId,
          issueKey: external.issueKey,
          issueUrl: external.issueUrl,
          commentId: external.commentId,
          commentUrl: external.commentUrl,
          statusTransitioned: external.statusTransitioned,
          nextStateId: external.nextStateId,
          nextStateName: external.nextStateName,
          idempotencyMarker: external.idempotencyMarker
        }
      : null
  };
}

function buildIntentApplyPolicySummary(
  repoOverride: string | undefined,
  externalApplyRequested: boolean
): IntentApplyPolicyResolution {
  let effective: UpdateIntentApplyPolicy = DEFAULT_INTENT_APPLY_POLICY;
  let source: PolicyEffectiveFieldSource = "builtin_default";
  if (typeof repoOverride === "string" && repoOverride.trim().length > 0) {
    const load = loadMomentumPolicy(repoOverride);
    if (!load.ok) {
      return {
        ok: false,
        code: load.code,
        message: load.error,
        path: load.path
      };
    }
    if (load.ok && load.present) {
      const resolved = resolveIntentApplyPolicy(load.policy.config);
      effective = resolved.value;
      source = resolved.source;
    }
  }
  return {
    ok: true,
    summary: {
      ...buildFallbackIntentApplyPolicySummary(externalApplyRequested),
      effective,
      source
    }
  };
}

function emitIntentFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: IntentFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.intentId !== undefined) payload["intentId"] = failure.intentId;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.evidenceRecordId !== undefined) {
    payload["evidenceRecordId"] = failure.evidenceRecordId;
  }
  if (failure.status !== undefined) payload["status"] = failure.status;
  if (failure.currentStatus !== undefined) {
    payload["currentStatus"] = failure.currentStatus;
  }
  if (failure.applyPolicy !== undefined) {
    payload["applyPolicy"] = failure.applyPolicy;
  }
  if (failure.externalApply !== undefined) {
    payload["externalApply"] = failure.externalApply;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function isUpdateIntentStatus(value: string): value is UpdateIntentStatus {
  return (UPDATE_INTENT_STATUSES as readonly string[]).includes(value);
}

function updateIntentToJsonShape(record: UpdateIntent): Record<string, unknown> {
  return {
    id: record.id,
    adapterKind: record.adapterKind,
    targetExternalId: record.targetExternalId,
    intentType: record.intentType,
    payload: record.payload,
    reason: record.reason,
    goalId: record.goalId,
    sourceItemId: record.sourceItemId,
    evidenceRecordId: record.evidenceRecordId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    decisionReason: record.decisionReason,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt,
    skippedAt: record.skippedAt,
    canceledAt: record.canceledAt
  };
}

type IntentApplyAuditJsonShape = {
  intentId: string;
  applyState: IntentApplyAuditSummary["applyState"];
  totalAttempts: number;
  counts: IntentApplyAuditSummary["counts"];
  latestAttempt: ReturnType<typeof intentApplyAuditToJsonShape> | null;
};

function intentApplyAuditSummaryToJsonShape(
  summary: IntentApplyAuditSummary | null
): IntentApplyAuditJsonShape {
  if (!summary) {
    return {
      intentId: "",
      applyState: "idle",
      totalAttempts: 0,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      latestAttempt: null
    };
  }
  return {
    intentId: summary.intentId,
    applyState: summary.applyState,
    totalAttempts: summary.totalAttempts,
    counts: summary.counts,
    latestAttempt: summary.latestAttempt
      ? intentApplyAuditToJsonShape(summary.latestAttempt)
      : null
  };
}

function intentApplyAuditToJsonShape(
  audit: IntentApplyAudit
): Record<string, unknown> {
  return {
    id: audit.id,
    adapterKind: audit.adapterKind,
    provider: audit.provider,
    target: audit.target,
    requestedAt: audit.requestedAt,
    finishedAt: audit.finishedAt,
    operatorReason: audit.operatorReason,
    operatorActor: audit.operatorActor,
    intentApplyPolicy: audit.intentApplyPolicy,
    allowStatusMutation: audit.allowStatusMutation,
    mutationKind: audit.mutationKind,
    previewSummary: audit.previewSummary,
    idempotencyMarker: audit.idempotencyMarker,
    lifecycleState: audit.lifecycleState,
    resultStatus: audit.resultStatus,
    resultCode: audit.resultCode,
    resultMessage: audit.resultMessage,
    externalRefs: audit.externalRefs,
    reconcile: audit.reconcile,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt
  };
}

function renderExternalApplyTextLines(
  external: IntentApplyAuditJsonShape
): string[] {
  const counts = external.counts;
  const lines: string[] = [
    `External apply state: ${external.applyState}`,
    `External apply attempts: total=${external.totalAttempts} ` +
      `succeeded=${counts.succeeded} failed=${counts.failed} ` +
      `claimed=${counts.claimed} blocked=${counts.blocked} ` +
      `audit_incomplete=${counts.audit_incomplete}`
  ];
  const latest = external.latestAttempt;
  if (!latest) {
    lines.push("External apply latest attempt: (none)");
    return lines;
  }
  lines.push(
    `External apply latest attempt: ${latest.id} ${latest.lifecycleState}` +
      ` (result=${latest.resultStatus ?? "(none)"}` +
      ` code=${latest.resultCode ?? "(none)"})`
  );
  lines.push(
    `External apply latest target: ${latest.adapterKind}/` +
      `${(latest.target as { externalKey: string | null }).externalKey ?? "(none)"}` +
      ` (${(latest.target as { externalId: string | null }).externalId ?? "(none)"})`
  );
  const refs = latest.externalRefs as {
    commentId: string | null;
    commentUrl: string | null;
    stateTransitionId: string | null;
  };
  if (refs.commentId || refs.commentUrl || refs.stateTransitionId) {
    lines.push(
      `External apply refs: comment=${refs.commentId ?? "(none)"}` +
        ` url=${refs.commentUrl ?? "(none)"}` +
        ` transition=${refs.stateTransitionId ?? "(none)"}`
    );
  }
  return lines;
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

type StartupRecoverySummary = {
  observedAt: number;
  graceMs: number;
  recoveredRepoLockCount: number;
  recoveredClaimedJobCount: number;
  recoveredDaemonRunCount: number;
  skippedRepoLocks: StaleRepoLockRecoverySkipped[];
  skippedClaimedJobs: StaleClaimedJobRecoverySkipped[];
  skippedDaemonRuns: StaleDaemonRunRecoverySkipped[];
};

function summarizeStartupRecovery(
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

function formatStartupRecoveryLines(
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

function emitWorkerRunResult(
  parsed: ParsedFlags,
  io: CliIo,
  result: WorkerRunResult,
  stalePreCheck: StaleLeasePreCheckSnapshot
): number {
  const preCheckJson = summarizeStalePreCheckForJson(stalePreCheck);
  if (parsed.json) {
    const base = {
      command: "worker run",
      ...result,
      stalePreCheck: preCheckJson
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

  emitStalePreCheckText(io, stalePreCheck);

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

function summarizeStalePreCheckForJson(
  snapshot: StaleLeasePreCheckSnapshot
): Record<string, unknown> {
  return {
    observedAt: snapshot.observedAt,
    staleLeaseGraceMs: snapshot.staleLeaseGraceMs,
    staleRepoLockCount: snapshot.staleRepoLocks.length,
    staleClaimedJobCount: snapshot.staleClaimedJobs.length,
    staleRepoLocks: snapshot.staleRepoLocks,
    staleClaimedJobs: snapshot.staleClaimedJobs
  };
}

function emitStalePreCheckText(
  io: CliIo,
  snapshot: StaleLeasePreCheckSnapshot
): void {
  const lockCount = snapshot.staleRepoLocks.length;
  const claimCount = snapshot.staleClaimedJobs.length;
  if (lockCount === 0 && claimCount === 0) return;
  write(
    io.stdout,
    `Stale leases observed before claim: ${lockCount} repo lock(s), ${claimCount} claimed job(s) — see \`momentum daemon status\` for details.\n`
  );
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
    milestone:
      "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete",
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
    if (daemonPayload.staleRepoLockCount > 0) {
      lines.push(
        `daemon stale repo locks: ${daemonPayload.staleRepoLockCount}`
      );
    }
    if (daemonPayload.staleClaimedJobCount > 0) {
      lines.push(
        `daemon stale claimed jobs: ${daemonPayload.staleClaimedJobCount}`
      );
    }
    if (daemonPayload.goalsNeedingRecoveryCount > 0) {
      lines.push(
        `goals needing manual recovery: ${daemonPayload.goalsNeedingRecoveryCount}`
      );
    }
  } else {
    lines.push(`daemon: error (${daemonPayload.code})`);
  }
  lines.push(
    `runners: ${BUILTIN_RUNNER_KINDS.join(", ")} (default ${DEFAULT_RUNNER_KIND})`
  );
  if (policyPayload.repoConfigured) {
    if (policyPayload.error) {
      lines.push(
        `policy (MOMENTUM.md): error ${policyPayload.error.code} at ${policyPayload.path ?? "(unresolved)"}`
      );
    } else if (policyPayload.present) {
      const fields = describePolicyFields(policyPayload);
      lines.push(
        `policy (MOMENTUM.md): present at ${policyPayload.path}${fields ? ` (${fields})` : ""}`
      );
    } else {
      lines.push(
        `policy (MOMENTUM.md): not present (expected at ${policyPayload.path ?? "(unresolved)"})`
      );
    }
  } else {
    lines.push("policy (MOMENTUM.md): pass --repo <path> to inspect repo policy");
  }
  lines.push(
    `intent_apply_policy: ${policyPayload.effectiveIntentApply.value} (${policyPayload.effectiveIntentApply.source})`
  );
  if (sourcesPayload.ok) {
    lines.push(
      `sources: total=${sourcesPayload.totalSourceItems} linked=${sourcesPayload.linkedSourceItems} unlinked=${sourcesPayload.unlinkedSourceItems}`
    );
    const last = sourcesPayload.lastReconciliation;
    if (last) {
      const stoppedText = last.paginationStopped
        ? `, stopped=${last.paginationStopped.reason}`
        : "";
      lines.push(
        `sources: last ${last.adapterKind} reconciliation ${last.state} (` +
          `seen=${last.itemsSeen}, upserted=${last.itemsUpserted}${stoppedText}, finished_at=${last.finishedAt ?? "(running)"})`
      );
    } else {
      lines.push("sources: no reconciliation runs recorded yet");
    }
  } else {
    lines.push(`sources: error (${sourcesPayload.code})`);
  }
  if (evidencePayload.ok) {
    lines.push(
      `evidence: total=${evidencePayload.totalRecords} goal_linked=${evidencePayload.goalLinkedRecords} source_item_linked=${evidencePayload.sourceItemLinkedRecords}`
    );
    const last = evidencePayload.lastRecord;
    if (last) {
      lines.push(
        `evidence: last ${last.source}/${last.type} at ${last.occurredAt}` +
          ` (goal=${last.goalId ?? "(none)"}, source_item=${last.sourceItemId ?? "(none)"})`
      );
    } else {
      lines.push("evidence: no records ingested yet");
    }
  } else {
    lines.push(`evidence: error (${evidencePayload.code})`);
  }
  if (externalApplyPayload.ok) {
    const intentCounts = externalApplyPayload.intentApplyStateCounts;
    const auditCounts = externalApplyPayload.auditCounts;
    lines.push(
      `external apply: intents idle=${intentCounts.idle} in_flight=${intentCounts.in_flight} blocked=${intentCounts.blocked}`
    );
    lines.push(
      `external apply: attempts total=${externalApplyPayload.totalAttempts} ` +
        `succeeded=${auditCounts.succeeded} failed=${auditCounts.failed} ` +
        `claimed=${auditCounts.claimed} blocked=${auditCounts.blocked} ` +
        `audit_incomplete=${auditCounts.audit_incomplete}`
    );
    const latest = externalApplyPayload.latestAttempt;
    if (latest) {
      lines.push(
        `external apply: latest ${latest.id} intent=${latest.intentId} ${latest.lifecycleState}` +
          ` (result=${latest.resultStatus ?? "(none)"} code=${latest.resultCode ?? "(none)"})`
      );
    } else {
      lines.push("external apply: no attempts recorded yet");
    }
  } else {
    lines.push(`external apply: error (${externalApplyPayload.code})`);
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

type DoctorEvidencePayload =
  | {
      ok: true;
      totalRecords: number;
      goalLinkedRecords: number;
      sourceItemLinkedRecords: number;
      lastRecord: {
        id: string;
        source: string;
        type: string;
        occurredAt: number;
        summary: string;
        goalId: string | null;
        sourceItemId: string | null;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

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

type DoctorExternalApplyLatestAttempt = {
  intentId: string;
} & ReturnType<typeof intentApplyAuditToJsonShape>;

type DoctorExternalApplyPayload =
  | {
      ok: true;
      intentApplyStateCounts: IntentApplyStateCounts;
      auditCounts: IntentApplyAuditCounts;
      totalAttempts: number;
      latestAttempt: DoctorExternalApplyLatestAttempt | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

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

type DoctorSourcesPayload =
  | {
      ok: true;
      totalSourceItems: number;
      linkedSourceItems: number;
      unlinkedSourceItems: number;
      lastReconciliation: {
        id: string;
        adapterKind: string;
        state: string;
        startedAt: number;
        finishedAt: number | null;
        error: string | null;
        itemsSeen: number;
        itemsUpserted: number;
        paginationStopped: SourceReconciliationPaginationStoppedJson | null;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

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

type DoctorPolicyPayload = {
  repoConfigured: boolean;
  repoPath: string | null;
  present: boolean;
  path: string | null;
  hasNotes: boolean;
  config: {
    runner: string | null;
    verification: readonly string[] | null;
    verificationTimeoutSec: number | null;
    intentApplyPolicy: UpdateIntentApplyPolicy | null;
  } | null;
  effectiveIntentApply: {
    value: UpdateIntentApplyPolicy;
    source: PolicyEffectiveFieldSource;
  };
  error: { code: string; message: string } | null;
};

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

function describePolicyFields(payload: {
  config: {
    runner: string | null;
    verification: readonly string[] | null;
    verificationTimeoutSec: number | null;
    intentApplyPolicy?: UpdateIntentApplyPolicy | null;
  } | null;
  hasNotes: boolean;
}): string {
  if (!payload.config) return "";
  const parts: string[] = [];
  if (payload.config.runner) parts.push(`runner=${payload.config.runner}`);
  if (payload.config.verification) {
    parts.push(`verification=${payload.config.verification.length} cmd(s)`);
  }
  if (payload.config.verificationTimeoutSec !== null) {
    parts.push(`timeout_sec=${payload.config.verificationTimeoutSec}`);
  }
  if (payload.config.intentApplyPolicy) {
    parts.push(`intent_apply=${payload.config.intentApplyPolicy}`);
  }
  if (payload.hasNotes) parts.push("notes");
  return parts.join(", ");
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
    runnerProfile: data.runnerProfile,
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
      recoveryMd: data.artifactPaths.recoveryMd,
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
    daemon: data.daemon,
    staleRecovery: data.staleRecovery,
    policy: data.policy,
    ...(data.sourceItems.length > 0 ? { sourceItems: data.sourceItems } : {}),
    ...(data.latestEvidence.length > 0
      ? { latestEvidence: data.latestEvidence }
      : {}),
    ...(data.pendingUpdateIntents.length > 0
      ? {
          totalPendingUpdateIntentCount: data.totalPendingUpdateIntentCount,
          truncatedPendingUpdateIntents: data.truncatedPendingUpdateIntents,
          pendingUpdateIntents: data.pendingUpdateIntents.map(
            (intent) => goalStatusPendingIntentToJsonShape(intent)
          ),
          intentStaleThresholdMs: data.intentStaleThresholdMs
        }
      : {}),
    externalApply: goalStatusExternalApplyToJsonShape(data.externalApply)
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
    ...(data.runnerProfile
      ? [
          `Runner profile: ${data.runnerProfile.name} (executes=${data.runnerProfile.executes ? "true" : "false"})`
        ]
      : []),
    `Artifact dir: ${data.artifactDir}`,
    `Recovery: ${data.artifactFiles.recoveryMd ? "present" : "missing"} (${data.artifactPaths.recoveryMd})`
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

  const sr = data.staleRecovery;
  if (
    sr.recoveredRepoLockCount > 0 ||
    sr.recoveredJobCount > 0 ||
    sr.staleRepoLockCount > 0 ||
    sr.staleClaimedJobCount > 0
  ) {
    lines.push(
      `Stale recovery: locks recovered=${sr.recoveredRepoLockCount} ` +
        `jobs recovered=${sr.recoveredJobCount} ` +
        `pending locks=${sr.staleRepoLockCount} ` +
        `pending jobs=${sr.staleClaimedJobCount}`
    );
  }

  const policy = data.policy;
  if (!policy.configured) {
    lines.push("Policy (MOMENTUM.md): repo path not set; discovery skipped");
  } else if (policy.error) {
    lines.push(
      `Policy (MOMENTUM.md): error ${policy.error.code} at ${policy.path ?? "(unresolved)"}`
    );
  } else if (policy.present) {
    const fields = describePolicyFields(policy);
    lines.push(
      `Policy (MOMENTUM.md): present at ${policy.path}${fields ? ` (${fields})` : ""}`
    );
  } else {
    lines.push(
      `Policy (MOMENTUM.md): not present (expected at ${policy.path ?? "(unresolved)"})`
    );
  }

  if (data.sourceItems.length > 0) {
    lines.push(`Source items: ${data.sourceItems.length}`);
    for (const item of data.sourceItems) {
      lines.push(
        `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""}`
      );
    }
  }

  if (data.latestEvidence.length > 0) {
    lines.push(`Latest evidence: ${data.latestEvidence.length}`);
    for (const record of data.latestEvidence) {
      lines.push(
        `- ${record.occurredAt} [${record.source}/${record.type}] ${record.summary}`
      );
    }
  }

  if (data.pendingUpdateIntents.length > 0) {
    const staleCount = data.pendingUpdateIntents.filter(
      (intent) => intent.stale
    ).length;
    const staleSuffix = staleCount > 0 ? ` (${staleCount} stale)` : "";
    const shownCount = data.pendingUpdateIntents.length;
    const totalCount = data.totalPendingUpdateIntentCount;
    const countLabel = data.truncatedPendingUpdateIntents
      ? `${shownCount}/${totalCount}`
      : `${shownCount}`;
    lines.push(
      `Pending update intents: ${countLabel}${staleSuffix}`
    );
    for (const intent of data.pendingUpdateIntents) {
      const staleFlag = intent.stale ? " STALE" : "";
      const latestText = intent.externalApply.latestAttempt
        ? ` latest=${intent.externalApply.latestAttempt.lifecycleState}`
        : "";
      lines.push(
        `- ${intent.intentId} [${intent.adapterKind}/${intent.intentType}] ` +
          `target=${intent.targetExternalId ?? "(none)"} ageMs=${intent.ageMs}${staleFlag}` +
          ` apply=${intent.externalApply.applyState}` +
          ` attempts=${intent.externalApply.totalAttempts}${latestText}: ${intent.reason}`
      );
    }
    if (data.truncatedPendingUpdateIntents) {
      lines.push(`... and ${totalCount - shownCount} more`);
    }
  }

  const externalApply = data.externalApply;
  const applyStateCounts = externalApply.pendingIntentApplyStateCounts;
  const auditCounts = externalApply.pendingAuditCounts;
  lines.push(
    `Pending external apply state: idle=${applyStateCounts.idle}, ` +
      `in_flight=${applyStateCounts.in_flight}, ` +
      `blocked=${applyStateCounts.blocked}`
  );
  lines.push(
    `Pending external apply audits: total=${externalApply.totalAttempts}, ` +
      `succeeded=${auditCounts.succeeded}, ` +
      `failed=${auditCounts.failed}, ` +
      `claimed=${auditCounts.claimed}, ` +
      `blocked=${auditCounts.blocked}, ` +
      `audit_incomplete=${auditCounts.audit_incomplete}`
  );
  const latestExternalApply = externalApply.latestAttempt;
  if (latestExternalApply) {
    lines.push(
      `Latest external apply: ${latestExternalApply.id} ${latestExternalApply.lifecycleState}` +
        ` intent=${latestExternalApply.intentId}` +
        ` (result=${latestExternalApply.resultStatus ?? "(none)"}` +
        ` code=${latestExternalApply.resultCode ?? "(none)"})`
    );
  } else {
    lines.push("Latest external apply: (none)");
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function goalStatusPendingIntentToJsonShape(
  intent: GoalStatusPendingIntentSummary
): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    adapterKind: intent.adapterKind,
    intentType: intent.intentType,
    targetExternalId: intent.targetExternalId,
    reason: intent.reason,
    goalId: intent.goalId,
    sourceItemId: intent.sourceItemId,
    evidenceRecordId: intent.evidenceRecordId,
    createdAt: intent.createdAt,
    ageMs: intent.ageMs,
    stale: intent.stale,
    externalApply: goalStatusPendingIntentExternalApplyToJsonShape(
      intent.externalApply
    )
  };
}

function goalStatusPendingIntentExternalApplyToJsonShape(
  external: GoalStatusPendingIntentExternalApply
): {
  applyState: GoalStatusPendingIntentExternalApply["applyState"];
  totalAttempts: number;
  counts: GoalStatusPendingIntentExternalApply["counts"];
  latestAttempt: Record<string, unknown> | null;
} {
  return {
    applyState: external.applyState,
    totalAttempts: external.totalAttempts,
    counts: external.counts,
    latestAttempt: external.latestAttempt
      ? intentApplyAuditToJsonShape(external.latestAttempt)
      : null
  };
}

function goalStatusExternalApplyToJsonShape(
  external: GoalStatusExternalApply
): {
  pendingIntentApplyStateCounts: GoalStatusExternalApply["pendingIntentApplyStateCounts"];
  pendingAuditCounts: GoalStatusExternalApply["pendingAuditCounts"];
  totalAttempts: number;
  latestAttempt:
    | ({ intentId: string } & ReturnType<typeof intentApplyAuditToJsonShape>)
    | null;
} {
  return {
    pendingIntentApplyStateCounts: external.pendingIntentApplyStateCounts,
    pendingAuditCounts: external.pendingAuditCounts,
    totalAttempts: external.totalAttempts,
    latestAttempt: external.latestAttempt
      ? {
          intentId: external.latestAttempt.intentId,
          ...intentApplyAuditToJsonShape(external.latestAttempt)
        }
      : null
  };
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
      },
      resultJson: {
        path: data.resultJson.path,
        exists: data.resultJson.exists,
        readable: data.resultJson.readable,
        bytes: data.resultJson.bytes,
        content: data.resultJson.content,
        error: data.resultJson.error,
        parseError: data.resultJson.parseError
      },
      sourceItems: data.sourceItems,
      ...(data.latestEvidence.length > 0
        ? { latestEvidence: data.latestEvidence }
        : {})
    };
    writeJson(io.stdout, payload);
    return 0;
  }

  const sourceItemsLines: string[] = [];
  if (data.sourceItems.length > 0) {
    sourceItemsLines.push(`Source items: ${data.sourceItems.length}`);
    for (const item of data.sourceItems) {
      sourceItemsLines.push(
        `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""}`
      );
    }
  }

  const evidenceLines: string[] = [];
  if (data.latestEvidence.length > 0) {
    evidenceLines.push(`Latest evidence: ${data.latestEvidence.length}`);
    for (const record of data.latestEvidence) {
      evidenceLines.push(
        `- ${record.occurredAt} [${record.source}/${record.type}] ${record.summary}`
      );
    }
  }

  const lines: string[] = [
    `Goal: ${data.goalId}`,
    `Iteration: ${data.iteration}`,
    `Available iterations: ${data.availableIterations.length === 0 ? "(none)" : data.availableIterations.join(", ")}`,
    `Iteration dir: ${data.iterationDir}`,
    ...sourceItemsLines,
    ...evidenceLines,
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
  lines.push(
    `## result.json (${data.resultJson.exists ? `${data.resultJson.bytes} bytes` : "missing"}): ${data.resultJson.path}`
  );
  if (data.resultJson.error !== undefined) {
    lines.push(`(unreadable: ${data.resultJson.error})`);
  } else if (data.resultJson.parseError !== undefined) {
    lines.push(`(parse error: ${data.resultJson.parseError})`);
  } else if (data.resultJson.exists && data.resultJson.content.length > 0) {
    lines.push(data.resultJson.content.endsWith("\n")
      ? data.resultJson.content.slice(0, -1)
      : data.resultJson.content);
  } else if (data.resultJson.exists) {
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
  const payload: Record<string, unknown> = {
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
    daemon: data.daemon,
    staleRecovery: data.staleRecovery,
    policy: data.policy
  };
  if (data.sourceItems.length > 0) {
    payload["sourceItems"] = data.sourceItems;
  }

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
  let evidencePointerFlag: string | undefined;
  let ledgerPointerFlag: string | undefined;
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
  if (evidencePointerFlag !== undefined) {
    parsed.evidencePointer = evidencePointerFlag;
  }
  if (ledgerPointerFlag !== undefined) parsed.ledgerPointer = ledgerPointerFlag;
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
