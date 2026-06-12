import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS } from "../help.js";
import { isUniqueViolation, openDb, type MomentumDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import { loadMomentumPolicy } from "../../momentum-policy.js";
import {
  parseWorkflowRunImport,
  type WorkflowRunImport,
  type WorkflowRunImportDiagnostic,
  type WorkflowRunImportErrorCode
} from "../../workflow-run-import.js";
import {
  persistWorkflowRunImport,
  type PersistWorkflowRunImportSummary
} from "../../workflow-run-import-persist.js";
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
} from "../../workflow-status.js";
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
  type WorkflowStepState
} from "../../workflow-run-reducer.js";
import {
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  loadWorkflowHandoff,
  type WorkflowHandoffEnvelope
} from "../../workflow-handoff.js";
import {
  loadWorkflowMonitorEnvelope,
  type WorkflowMonitorEnvelope
} from "../../workflow-monitor-envelope.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorState
} from "../../workflow-monitor-state.js";
import {
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
  isBlockingWorkflowRecoveryCode,
  type ClearWorkflowRunManualRecoveryGuardedResult,
  type WorkflowRunManualRecoveryState
} from "../../workflow-run-recovery.js";
import {
  reconcileWorkflowRunManualRecovery,
  type ReconcileWorkflowRunManualRecoveryResult
} from "../../workflow-recovery-reconcile.js";
import {
  CODING_WORKFLOW_DEFINITION_KEY,
  getBuiltInWorkflowDefinition,
  type WorkflowDefinition
} from "../../workflow-definition.js";
import {
  loadWorkflowDefinition,
  persistWorkflowDefinition
} from "../../workflow-definition-persist.js";
import type {
  WorkflowRunStartError,
  WorkflowRunStartInput
} from "../../workflow-run-start.js";
import {
  InvalidWorkflowRunStartError,
  WorkflowRunStartConflictError,
  persistWorkflowRunStart,
  type PersistWorkflowRunStartSummary
} from "../../workflow-run-start-persist.js";
import {
  GATE_DECISION_MODES,
  type GateDecisionMode,
  type GateDecisionRefusalCode,
  type GateDecisionRequest
} from "../../workflow-gate.js";
import {
  WorkflowGateDecisionError,
  WorkflowGateNotFoundError,
  resolveWorkflowGate,
  type WorkflowGateRecord
} from "../../workflow-gate-persist.js";
import { executeWorkflowStepDispatch } from "../../workflow-dispatch-execute.js";

type Writer = {
  write(chunk: string): boolean;
};

type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

type JsonPayload = Record<string, unknown>;

type ParsedFlags = {
  args: string[];
  json: boolean;
  dataDir?: string;
  repo?: string;
  reason?: string;
  path?: string;
  limit?: number;
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

export function workflow(parsed: ParsedFlags, io: CliIo): number {
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
      "Missing required subcommand for workflow run. Expected: start, list, approve, decide, update-step, clear-recovery, monitor.",
      parsed,
      io
    );
  }
  if (subcommand === "start") {
    return workflowRunStart(parsed, io);
  }
  if (subcommand === "list") {
    return workflowRunList(parsed, io);
  }
  if (subcommand === "approve") {
    return workflowRunApprove(parsed, io);
  }
  if (subcommand === "decide") {
    return workflowRunDecide(parsed, io);
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

type WorkflowRunStartFailureCode =
  | "run_id_required"
  | "repo_required"
  | "objective_required"
  | "data_dir_failed"
  | "definition_not_found"
  | "policy_invalid"
  | "invalid_run_start"
  | "run_exists";

type WorkflowRunStartFailure = {
  code: WorkflowRunStartFailureCode;
  message: string;
  dataDir?: string;
  runId?: string;
  errors?: readonly WorkflowRunStartError[];
};

/**
 * `momentum workflow run start` — the first-class workflow-first start surface
 * (M10-02, NGX-346). Resolves a validated {@link WorkflowDefinition} (persisted
 * first, then the built-in coding workflow fallback), loads repo policy, and
 * durably materializes a `WorkflowRun` + `StepRun` plan via
 * {@link persistWorkflowRunStart}. `goal start` stays the compatibility path for
 * the old Goal loop and is untouched by this command.
 */
function workflowRunStart(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length > 0) {
    return usageError(
      `Unexpected argument for workflow run start: ${positional[0]}`,
      parsed,
      io
    );
  }

  const runId = parsed.runId;
  if (runId === undefined || runId.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required --run-id <id> for workflow run start."
    });
  }
  if (parsed.repo === undefined || parsed.repo.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      code: "repo_required",
      message: "Missing required --repo <path> for workflow run start.",
      runId
    });
  }
  if (parsed.objective === undefined || parsed.objective.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      code: "objective_required",
      message: "Missing required --objective <text> for workflow run start.",
      runId
    });
  }
  const repoPath = path.resolve(parsed.repo);
  const objective = parsed.objective;
  const definitionKey = parsed.definition ?? CODING_WORKFLOW_DEFINITION_KEY;
  const now = Date.now();

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunStartFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId
    });
  }

  // Preserve repo policy loading: a present-but-malformed MOMENTUM.md refuses
  // the start (consistent with goal start) rather than being silently ignored.
  const policy = loadMomentumPolicy(repoPath);
  if (!policy.ok) {
    return emitWorkflowRunStartFailure(parsed, io, {
      code: "policy_invalid",
      message: `Repo policy is invalid (${policy.code}): ${policy.error}`,
      dataDir,
      runId
    });
  }

  const db = openDb(dataDir);
  try {
    const definition = resolveWorkflowRunStartDefinition(
      db,
      definitionKey,
      parsed.definitionVersion,
      now
    );
    if (definition === undefined) {
      return emitWorkflowRunStartFailure(parsed, io, {
        code: "definition_not_found",
        message:
          parsed.definitionVersion === undefined
            ? `No workflow definition found for key: ${definitionKey}.`
            : `No workflow definition found for key ${definitionKey} version ${parsed.definitionVersion}.`,
        dataDir,
        runId
      });
    }

    const input: WorkflowRunStartInput = {
      definition,
      runId,
      repoPath,
      objective,
      now
    };
    if (parsed.approvalBoundary !== undefined) {
      input.approvalBoundary = parsed.approvalBoundary;
    }
    if (parsed.skillRevision !== undefined) {
      input.skillRevision = parsed.skillRevision;
    }
    if (parsed.issueScope !== undefined) {
      input.issueScope = { identifier: parsed.issueScope };
    }

    let summary: PersistWorkflowRunStartSummary;
    try {
      summary = persistWorkflowRunStart(db, input);
    } catch (error) {
      if (error instanceof InvalidWorkflowRunStartError) {
        return emitWorkflowRunStartFailure(parsed, io, {
          code: "invalid_run_start",
          message: error.message,
          dataDir,
          runId,
          errors: error.errors
        });
      }
      if (error instanceof WorkflowRunStartConflictError) {
        return emitWorkflowRunStartFailure(parsed, io, {
          code: "run_exists",
          message: `Workflow run already exists: ${runId}.`,
          dataDir,
          runId
        });
      }
      throw error;
    }

    return emitWorkflowRunStartSuccess(parsed, io, {
      dataDir,
      repoPath,
      objective,
      summary,
      policyPresent: policy.present === true,
      policyPath: policy.path
    });
  } finally {
    db.close();
  }
}

/**
 * Resolve the {@link WorkflowDefinition} a run start should materialize from.
 * Persisted definitions win; the built-in coding workflow is the fallback so a
 * fresh database (no seeded definitions) can still start the canonical recipe.
 */
function resolveWorkflowRunStartDefinition(
  db: MomentumDb,
  key: string,
  version: number | undefined,
  now: number
): WorkflowDefinition | undefined {
  const persisted = loadWorkflowDefinition(db, key, version);
  if (persisted !== undefined) {
    return persisted;
  }
  const builtIn = getBuiltInWorkflowDefinition(key);
  if (builtIn === undefined) {
    return undefined;
  }
  if (version !== undefined && builtIn.version !== version) {
    return undefined;
  }
  persistWorkflowDefinition(db, builtIn, { now });
  return builtIn;
}

function emitWorkflowRunStartSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  result: {
    dataDir: string;
    repoPath: string;
    objective: string;
    summary: PersistWorkflowRunStartSummary;
    policyPresent: boolean;
    policyPath: string;
  }
): number {
  const { summary } = result;
  const payload = {
    ok: true,
    command: "workflow run start",
    dataDir: result.dataDir,
    runId: summary.runId,
    source: summary.source,
    state: summary.state,
    approvalBoundary: summary.approvalBoundary,
    definitionKey: summary.definitionKey,
    definitionVersion: summary.definitionVersion,
    repoPath: result.repoPath,
    objective: result.objective,
    counts: { steps: summary.stepCount },
    policy: { present: result.policyPresent, path: result.policyPath }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow run started: ${summary.runId}`,
    `Definition: ${summary.definitionKey} v${summary.definitionVersion}`,
    `State: ${summary.state}`,
    `Approval boundary: ${summary.approvalBoundary ?? "(none)"}`,
    `Steps: ${summary.stepCount}`,
    `Repo: ${result.repoPath}`,
    `Objective: ${result.objective}`,
    `Policy: ${result.policyPresent ? result.policyPath : "(none)"}`,
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitWorkflowRunStartFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunStartFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "workflow run start",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;
  if (failure.errors !== undefined) {
    payload["errors"] = failure.errors.map((error) => ({ ...error }));
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
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
    evidence: detail.evidence.map(workflowEvidenceToJsonShape),
    gates: detail.gates.map(workflowGateToJsonShape)
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

type WorkflowRunDecideFailureCode =
  | "gate_id_required"
  | "invalid_mode"
  | "data_dir_failed"
  | "gate_not_found"
  | GateDecisionRefusalCode;

type WorkflowRunDecideFailure = {
  command: "workflow run decide";
  code: WorkflowRunDecideFailureCode;
  message: string;
  dataDir?: string;
  gateId?: string;
};

function isGateDecisionMode(value: string): value is GateDecisionMode {
  return (GATE_DECISION_MODES as readonly string[]).includes(value);
}

/**
 * `momentum workflow run decide` — the durable operator decision surface for a
 * workflow / step / executor human gate (M10-08, NGX-352). It resolves a single
 * persisted gate by routing the requested action through the same pure
 * {@link resolveWorkflowGate} brain the daemon uses: an operator may pick any
 * allowed action, while `--mode delegated` may only auto-apply an action inside
 * the gate's policy envelope and otherwise pauses for an operator. The brain's
 * refusal codes (action not allowed, out-of-envelope delegated action, already
 * resolved) surface verbatim so a caller can branch on the exact reason, and the
 * durable row is left untouched on any refusal.
 */
function workflowRunDecide(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  const gateId = positional[0]?.trim();
  if (!gateId) {
    return emitWorkflowRunDecideFailure(parsed, io, {
      command: "workflow run decide",
      code: "gate_id_required",
      message: "Missing required <gate-id> for workflow run decide."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run decide: ${positional[1]}`,
      parsed,
      io
    );
  }

  const action = parsed.action?.trim();
  if (!action) {
    return emitWorkflowRunDecideFailure(parsed, io, {
      command: "workflow run decide",
      code: "action_required",
      message: "Missing required --action <action> for workflow run decide.",
      gateId
    });
  }

  const actor = parsed.actor?.trim();
  if (!actor) {
    return emitWorkflowRunDecideFailure(parsed, io, {
      command: "workflow run decide",
      code: "actor_required",
      message: "Missing required --actor <name> for workflow run decide.",
      gateId
    });
  }

  const modeRaw = parsed.mode ?? "operator";
  if (!isGateDecisionMode(modeRaw)) {
    return emitWorkflowRunDecideFailure(parsed, io, {
      command: "workflow run decide",
      code: "invalid_mode",
      message: `Invalid --mode: ${modeRaw}. Expected one of: ${GATE_DECISION_MODES.join(", ")}.`,
      gateId
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunDecideFailure(parsed, io, {
      command: "workflow run decide",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      gateId
    });
  }

  const request: GateDecisionRequest = {
    action,
    actor,
    mode: modeRaw,
    resolutionNote: parsed.note ?? null
  };

  const db = openDb(dataDir);
  try {
    const resolved = resolveWorkflowGate(db, gateId, request);
    const payload = {
      ok: true,
      command: "workflow run decide",
      dataDir,
      gateId: resolved.gateId,
      runId: resolved.workflowRunId,
      targetScope: resolved.targetScope,
      gateType: resolved.gateType,
      chosenAction: resolved.chosenAction,
      resolvedBy: resolved.resolvedBy,
      mode: resolved.resolutionMode,
      resolution: resolved.resolution,
      resolvedAt: resolved.resolvedAt,
      allowedActions: resolved.allowedActions
    };
    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }
    const lines = [
      `Workflow gate resolved: ${resolved.gateId}`,
      `Run: ${resolved.workflowRunId}`,
      `Scope: ${resolved.targetScope} (${resolved.gateType})`,
      `Action: ${resolved.chosenAction}`,
      `Resolved by: ${resolved.resolvedBy} (${resolved.resolutionMode})`,
      `Note: ${resolved.resolution ?? "(none)"}`,
      `Data dir: ${dataDir}`,
      ""
    ];
    write(io.stdout, lines.join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof WorkflowGateNotFoundError) {
      return emitWorkflowRunDecideFailure(parsed, io, {
        command: "workflow run decide",
        code: "gate_not_found",
        message: error.message,
        dataDir,
        gateId
      });
    }
    if (error instanceof WorkflowGateDecisionError) {
      return emitWorkflowRunDecideFailure(parsed, io, {
        command: "workflow run decide",
        code: error.code,
        message: error.message,
        dataDir,
        gateId
      });
    }
    throw error;
  } finally {
    db.close();
  }
}

function emitWorkflowRunDecideFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: WorkflowRunDecideFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.gateId !== undefined) payload["gateId"] = failure.gateId;

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
    gates: envelope.gates.map(workflowGateToJsonShape),
    counts: {
      steps: envelope.counts.steps,
      stepsByState: envelope.counts.stepsByState,
      approvals: envelope.counts.approvals,
      leases: envelope.counts.leases,
      gates: envelope.counts.gates,
      gatesOpen: envelope.counts.gatesOpen
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
  lines.push(
    `Gates: ${envelope.counts.gates} (open: ${envelope.counts.gatesOpen})`
  );
  for (const gate of envelope.gates) {
    if (gate.resolvedAt !== null) continue;
    lines.push(
      `- ${gate.gateId} [${gate.targetScope}/${gate.gateType}] OPEN ` +
        `allowed=${gate.allowedActions.join(",") || "(none)"}` +
        (gate.recommendedAction !== null
          ? ` recommended=${gate.recommendedAction}`
          : "")
    );
  }
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
    gates: envelope.detail.gates.map(workflowGateToJsonShape),
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

function workflowGateToJsonShape(
  gate: WorkflowGateRecord
): Record<string, unknown> {
  return {
    gateId: gate.gateId,
    workflowRunId: gate.workflowRunId,
    stepRunId: gate.stepRunId,
    invocationId: gate.invocationId,
    roundId: gate.roundId,
    targetScope: gate.targetScope,
    gateType: gate.gateType,
    reason: gate.reason,
    evidence: gate.evidence,
    allowedActions: gate.allowedActions,
    recommendedAction: gate.recommendedAction,
    policyEnvelope: gate.policyEnvelope,
    // Derived convenience flag so consumers can filter the run's still-blocking
    // (approval-required / operator-decision / manual-recovery) pauses without
    // re-deriving `resolvedAt === null`.
    open: gate.resolvedAt === null,
    resolvedAt: gate.resolvedAt,
    resolvedBy: gate.resolvedBy,
    resolutionMode: gate.resolutionMode,
    chosenAction: gate.chosenAction,
    resolution: gate.resolution
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

  const openGateCount = detail.gates.filter(
    (gate) => gate.resolvedAt === null
  ).length;
  lines.push(`Gates: ${detail.gates.length} (open: ${openGateCount})`);
  for (const gate of detail.gates) {
    const status =
      gate.resolvedAt === null
        ? `OPEN allowed=${gate.allowedActions.join(",") || "(none)"}` +
          (gate.recommendedAction !== null
            ? ` recommended=${gate.recommendedAction}`
            : "")
        : `resolved by ${gate.resolvedBy ?? "(unknown)"} ` +
          `action=${gate.chosenAction ?? "(none)"} ` +
          `(${gate.resolutionMode ?? "?"})`;
    lines.push(
      `- ${gate.gateId} [${gate.targetScope}/${gate.gateType}] ${status}`
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

function usageError(message: string, parsed: ParsedFlags, io: CliIo): number {
  if (parsed.json) {
    writeJson(io.stderr, {
      ok: false,
      code: "usage_error",
      message,
      commands: COMMANDS
    });
  } else {
    write(io.stderr, `${message}\n\n${renderWorkflowHelp()}\n`);
  }
  return 2;
}

function renderWorkflowHelp(): string {
  return COMMANDS.join("\n");
}

function writeJson(writer: Writer, payload: JsonPayload): void {
  writer.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}
