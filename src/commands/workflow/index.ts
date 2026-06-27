import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  emitHelp,
  usageError,
  type CliIo
} from "../../renderers/cli-output.js";
import {
  isUniqueViolation,
  openDb,
  openExistingDbReadOnly,
  type MomentumDb
} from "../../adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "../../config/data-dir.js";
import { loadMomentumPolicy } from "../../core/intent/policy.js";
import {
  isReservedCompatibilityRunId,
  parseWorkflowRunImport
} from "../../core/workflow/run-import.js";
import {
  persistWorkflowRunImport,
  type PersistWorkflowRunImportSummary
} from "../../core/workflow/run-import-persist.js";
import {
  WORKFLOW_STATUS_FILTER_KEYS,
  listWorkflowRunSummaries,
  loadWorkflowRunDetail,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowStatusFilterKey
} from "../../core/workflow/status.js";
import {
  highestWorkflowApprovalBoundary,
  isTerminalStepState,
  isWorkflowApprovalBoundary,
  isTerminalRunState,
  transitionWorkflowStep,
  WORKFLOW_RUN_STATES,
  workflowStepKindsForApprovalBoundary,
  type WorkflowRunState,
  type WorkflowStepState
} from "../../core/workflow/run-reducer.js";
import {
  loadWorkflowHandoff,
  type WorkflowHandoffEnvelope
} from "../../core/workflow/handoff.js";
import {
  loadWorkflowRunLogs,
  type WorkflowRunLogsEnvelope
} from "../../core/workflow/logs.js";
import {
  loadWorkflowMonitorEnvelope,
  type WorkflowMonitorEnvelope
} from "../../core/workflow/monitor-envelope.js";
import { deriveWorkflowMonitorProgress } from "../../core/workflow/monitor-progress.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorState
} from "../../core/workflow/monitor-state.js";
import { executeWorkflowStepDispatch } from "../../core/workflow/dispatch-execute.js";
import {
  resolveDaemonWorkflowStepDispatch,
  type DaemonWorkflowDispatchDeps
} from "../../core/daemon/workflow-dispatch.js";
import {
  runWorkflowSchedulerOnceAsync,
  type RecoverStaleWorkflowLeasesResult
} from "../../core/workflow/scheduler.js";
import {
  loadWorkflowRuntimeStateRows,
  refreshWorkflowRunRuntimeState
} from "../../core/workflow/runtime-state.js";
import {
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
  isBlockingWorkflowRecoveryCode,
  type ClearWorkflowRunManualRecoveryGuardedInput,
  type ClearWorkflowRunManualRecoveryGuardedResult,
  type WorkflowRunManualRecoveryState
} from "../../core/workflow/run-recovery.js";
import {
  reconcileWorkflowRunManualRecovery,
  type ReconcileWorkflowRunManualRecoveryResult
} from "../../core/workflow/recovery-reconcile.js";
import {
  CODING_WORKFLOW_DEFINITION_KEY,
  getBuiltInWorkflowDefinition,
  type WorkflowDefinition
} from "../../core/workflow/definition.js";
import {
  loadWorkflowDefinition,
  persistWorkflowDefinition
} from "../../core/workflow/definition-persist.js";
import {
  MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
  materializeWorkflowCodingPlanPreview,
  type WorkflowRunStartInput
} from "../../core/workflow/run-start.js";
import {
  formatCodingRouteStepSelectionLines,
  resolveCodingRouteStepSelections,
  validateCodingStepRouteOverrides,
  writeCodingStepRouteOverrides,
  type CodingStepRouteOverrides
} from "../../core/workflow/coding-route-config.js";
import {
  InvalidWorkflowRunStartError,
  WorkflowRunStartConflictError,
  persistWorkflowRunStart,
  type PersistWorkflowRunStartSummary
} from "../../core/workflow/run-start-persist.js";
import {
  GATE_DECISION_MODES,
  type GateDecisionMode,
  type GateDecisionRequest
} from "../../core/workflow/gate.js";
import {
  WorkflowGateDecisionError,
  WorkflowGateNotFoundError,
  resolveWorkflowGate
} from "../../core/workflow/gate-persist.js";
import {
  emitWorkflowHandoff,
  emitWorkflowHandoffFailure,
  emitWorkflowRunLogs,
  emitWorkflowRunLogsFailure,
  emitWorkflowImportFailure,
  emitWorkflowImportSuccess,
  emitWorkflowRunApproveFailure,
  emitWorkflowRunApproveSuccess,
  emitWorkflowRunClearRecovery,
  emitWorkflowRunClearRecoveryFailure,
  emitWorkflowRunDecideFailure,
  emitWorkflowRunDecideSuccess,
  emitWorkflowRunList,
  emitWorkflowRunListFailure,
  emitWorkflowRunMonitor,
  emitWorkflowRunMonitorFailure,
  emitWorkflowRunWatch,
  emitWorkflowRunWatchFailure,
  emitWorkflowRunPreviewCodingSuccess,
  emitWorkflowRunStartFailure,
  emitWorkflowRunStartSuccess,
  emitWorkflowRunUpdateStepFailure,
  emitWorkflowRunUpdateStepSuccess,
  emitWorkflowStatusDetail,
  emitWorkflowStatusFailure,
  emitWorkflowStatusList,
  type WorkflowRunStartCommand
} from "../../renderers/workflow.js";

type ParsedFlags = {
  args: string[];
  json: boolean;
  advance?: boolean;
  once?: boolean;
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
  profile?: string;
  stepsJson?: string;
  error?: string;
};

export type CliDeps = DaemonWorkflowDispatchDeps;

export function workflow(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps = {}
): number | Promise<number> {
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
    return workflowRun(parsed, io, deps);
  }
  return usageError(`Unknown workflow subcommand: ${subcommand}`, parsed, io);
}

function workflowRun(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): number | Promise<number> {
  if (parsed.args.includes("--help") || parsed.args.includes("-h")) {
    return emitHelp(io);
  }

  const subcommand = parsed.args[2];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for workflow run. Expected: start, start-coding, preview-coding, list, approve, decide, update-step, clear-recovery, monitor, watch, logs.",
      parsed,
      io
    );
  }
  if (subcommand === "start") {
    return workflowRunStart(parsed, io);
  }
  if (subcommand === "start-coding") {
    return workflowRunStartCoding(parsed, io);
  }
  if (subcommand === "preview-coding") {
    return workflowRunPreviewCoding(parsed, io);
  }
  if (subcommand === "logs") {
    return workflowRunLogs(parsed, io);
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
  if (subcommand === "watch") {
    return workflowRunWatch(parsed, io, deps);
  }
  return usageError(
    `Unknown workflow run subcommand: ${subcommand}`,
    parsed,
    io
  );
}

/**
 * `momentum workflow run start` — the first-class workflow-first start surface
 * (M10-02, NGX-346). Resolves a validated {@link WorkflowDefinition} (persisted
 * first, then the built-in coding workflow fallback), loads repo policy, and
 * durably materializes a `WorkflowRun` + `StepRun` plan via
 * {@link persistWorkflowRunStart}. `goal start` stays the compatibility path for
 * the old Goal loop and is untouched by this command.
 */
function workflowRunStart(parsed: ParsedFlags, io: CliIo): number {
  return runWorkflowStartCommand(parsed, io, {
    command: "workflow run start",
    coding: false
  });
}

/**
 * `momentum workflow run start-coding` - the explicit Momentum-native coding
 * workflow start door (NGX-508). It is a thin, unmistakable selector over the
 * same durable {@link persistWorkflowRunStart} machinery as `workflow run
 * start`, adding four coding-specific guarantees:
 *
 *   - it always materializes the built-in `coding-workflow` definition (a
 *     conflicting `--definition` is refused with `definition_not_allowed`);
 *   - it refuses run ids reserved for CWFP/overnight compatibility imports
 *     (`reserved_run_id`) so a fresh native run is never confused with imported
 *     `cwfp-*` primary state;
 *   - it records the run with the {@link MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE}
 *     provenance so status / handoff / monitor / logs surface it as
 *     Momentum-owned; and
 *   - it accepts the coding-only `--steps-json` route override and records
 *     validated per-step harness/model/effort selections under `route.steps`,
 *     with provider-aware model aliases normalized before persistence.
 *
 * The ordinary `workflow run start` path and the imported CWFP read/compat paths
 * are left exactly as they were.
 */
function workflowRunStartCoding(parsed: ParsedFlags, io: CliIo): number {
  return runWorkflowStartCommand(parsed, io, {
    command: "workflow run start-coding",
    coding: true
  });
}

/**
 * `momentum workflow run preview-coding` - the native plan-preview door
 * (NGX-509). It runs the exact same precondition checks and built-in definition
 * resolution as `workflow run start-coding` but stops before any durable write:
 * instead of persisting a run it materializes a frozen
 * {@link materializeWorkflowCodingPlanPreview} projection and emits it so an
 * operator can inspect the proposed run - run id, repo, objective, issue scope,
 * approval boundary, route/profile and per-step route selections, definition
 * key/version, and every step with its executor family - before approving or
 * executing it. The preview is a pure
 * projection of the version-pinned built-in definition plus inputs, so the
 * durable run a later `start-coding` persists matches it exactly.
 */
function workflowRunPreviewCoding(parsed: ParsedFlags, io: CliIo): number {
  return runWorkflowStartCommand(parsed, io, {
    command: "workflow run preview-coding",
    coding: true,
    preview: true
  });
}

type WorkflowStartCommandOptions = {
  command: WorkflowRunStartCommand;
  coding: boolean;
  preview?: boolean;
};

/**
 * Shared implementation for the three run-start surfaces. `workflow run start`
 * is the generic definition-sourced start; `workflow run start-coding` is the
 * explicit Momentum-native coding door; and `workflow run preview-coding` shares
 * the coding preconditions but returns a read-only plan before the durable
 * persistence point. The `coding` option toggles the coding-specific guards
 * (forced definition, reserved-run-id refusal, native source provenance,
 * `--steps-json` support) while `preview` keeps the materialized plan on the
 * read-only path.
 */
function runWorkflowStartCommand(
  parsed: ParsedFlags,
  io: CliIo,
  options: WorkflowStartCommandOptions
): number {
  const { command } = options;
  const positional = parsed.args.slice(3);
  if (positional.length > 0) {
    return usageError(
      `Unexpected argument for ${command}: ${positional[0]}`,
      parsed,
      io
    );
  }

  const runId = parsed.runId;
  if (runId === undefined || runId.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
      code: "run_id_required",
      message: `Missing required --run-id <id> for ${command}.`
    });
  }
  if (parsed.repo === undefined || parsed.repo.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
      code: "repo_required",
      message: `Missing required --repo <path> for ${command}.`,
      runId
    });
  }
  if (parsed.objective === undefined || parsed.objective.length === 0) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
      code: "objective_required",
      message: `Missing required --objective <text> for ${command}.`,
      runId
    });
  }

  if (
    options.coding &&
    parsed.definition !== undefined &&
    parsed.definition !== CODING_WORKFLOW_DEFINITION_KEY
  ) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
      code: "definition_not_allowed",
      message: `${command} always uses the built-in ${CODING_WORKFLOW_DEFINITION_KEY} definition; drop --definition or use \`workflow run start\` to start a different definition.`,
      runId
    });
  }

  if (options.coding && isReservedCompatibilityRunId(runId)) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
      code: "reserved_run_id",
      message: `Run id "${runId}" is reserved for CWFP/overnight compatibility imports; choose a Momentum-native run id for ${command}.`,
      runId
    });
  }

  // Native per-step coding route reconfiguration (NGX-510): an operator can adjust
  // the planned harness/model/effort selections per step before kickoff via
  // --steps-json. The validated, normalized overrides, including provider-aware
  // model alias rewrites for known harness mappings, are embedded durably under
  // route.steps so status/handoff/logs can audit the selection and so execution
  // can read it (or fail closed). The per-step namespace is coding-door specific,
  // so the generic `workflow run start` refuses it rather than silently dropping
  // a coding-only selection; a malformed or unsupported selection fails closed
  // before any durable write.
  let stepRouteOverrides: CodingStepRouteOverrides = {};
  if (parsed.stepsJson !== undefined) {
    if (!options.coding) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "route_config_not_allowed",
        message: `--steps-json is only supported on the coding doors (\`workflow run start-coding\` / \`workflow run preview-coding\`); the generic \`workflow run start\` does not accept per-step coding route overrides.`,
        runId
      });
    }
    let rawStepRouteConfig: unknown;
    try {
      rawStepRouteConfig = JSON.parse(parsed.stepsJson);
    } catch (parseError) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "route_config_invalid",
        message: `--steps-json is not valid JSON: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`,
        runId
      });
    }
    const validated = validateCodingStepRouteOverrides(rawStepRouteConfig);
    if (!validated.ok) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "route_config_invalid",
        message: `--steps-json is invalid (${validated.refusal}${
          validated.path === undefined ? "" : ` at ${validated.path}`
        }): ${validated.reason}`,
        runId
      });
    }
    stepRouteOverrides = validated.overrides;
  }

  const repoPath = path.resolve(parsed.repo);
  const objective = parsed.objective;
  const definitionKey = options.coding
    ? CODING_WORKFLOW_DEFINITION_KEY
    : parsed.definition ?? CODING_WORKFLOW_DEFINITION_KEY;
  const now = Date.now();

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunStartFailure(parsed, io, {
      command,
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
      command,
      code: "policy_invalid",
      message: `Repo policy is invalid (${policy.code}): ${policy.error}`,
      dataDir,
      runId
    });
  }

  // Preview mode (coding door only) shares every precondition above but stops
  // before any durable write: it resolves the built-in definition, materializes
  // a frozen plan projection, and emits it without opening the database for writes.
  if (options.preview === true) {
    const definition = resolveBuiltInWorkflowRunStartDefinition(
      definitionKey,
      parsed.definitionVersion
    );
    if (definition === undefined) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "definition_not_found",
        message:
          parsed.definitionVersion === undefined
            ? `No workflow definition found for key: ${definitionKey}.`
            : `No workflow definition found for key ${definitionKey} version ${parsed.definitionVersion}.`,
        dataDir,
        runId
      });
    }
    const input = buildWorkflowRunStartInput({
      definition,
      runId,
      repoPath,
      objective,
      now,
      coding: options.coding,
      parsed,
      stepRouteOverrides
    });
    const previewResult = materializeWorkflowCodingPlanPreview(input);
    if (!previewResult.ok) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "invalid_run_start",
        message: `Invalid workflow run start: ${previewResult.errors
          .map((error) => error.code)
          .join(", ")}`,
        dataDir,
        runId,
        errors: previewResult.errors
      });
    }
    if (workflowRunExistsReadOnly(dataDir, runId)) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "run_exists",
        message: `Workflow run already exists: ${runId}.`,
        dataDir,
        runId
      });
    }
    return emitWorkflowRunPreviewCodingSuccess(parsed, io, {
      dataDir,
      preview: previewResult.preview,
      policyPresent: policy.present === true,
      policyPath: policy.path,
      // Humanize the same validated per-step overrides that built the preview
      // route so the default (non-JSON) preview can audit the selection.
      stepRouteLines: formatCodingRouteStepSelectionLines(
        resolveCodingRouteStepSelections(stepRouteOverrides)
      )
    });
  }

  const db = openDb(dataDir);
  try {
    const definition = options.coding
      ? resolveBuiltInWorkflowRunStartDefinition(
          definitionKey,
          parsed.definitionVersion
        )
      : resolveWorkflowRunStartDefinition(
          db,
          definitionKey,
          parsed.definitionVersion,
          now
        );
    if (definition === undefined) {
      return emitWorkflowRunStartFailure(parsed, io, {
        command,
        code: "definition_not_found",
        message:
          parsed.definitionVersion === undefined
            ? `No workflow definition found for key: ${definitionKey}.`
            : `No workflow definition found for key ${definitionKey} version ${parsed.definitionVersion}.`,
        dataDir,
        runId
      });
    }

    const input = buildWorkflowRunStartInput({
      definition,
      runId,
      repoPath,
      objective,
      now,
      coding: options.coding,
      parsed,
      stepRouteOverrides
    });

    let summary: PersistWorkflowRunStartSummary;
    try {
      summary = persistWorkflowRunStart(db, input);
    } catch (error) {
      if (error instanceof InvalidWorkflowRunStartError) {
        return emitWorkflowRunStartFailure(parsed, io, {
          command,
          code: "invalid_run_start",
          message: error.message,
          dataDir,
          runId,
          errors: error.errors
        });
      }
      if (error instanceof WorkflowRunStartConflictError) {
        return emitWorkflowRunStartFailure(parsed, io, {
          command,
          code: "run_exists",
          message: `Workflow run already exists: ${runId}.`,
          dataDir,
          runId
        });
      }
      throw error;
    }

    return emitWorkflowRunStartSuccess(parsed, io, {
      command,
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
 * Persisted definitions win; the latest known built-in coding workflow is the
 * fallback so a fresh database (no seeded definitions) can still start the
 * canonical recipe.
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

/**
 * Resolve the built-in workflow definition for the Momentum-native coding door.
 * Versioned starts require the exact built-in key/version pair; unversioned
 * starts select the latest known built-in version.
 */
function resolveBuiltInWorkflowRunStartDefinition(
  key: string,
  version: number | undefined
): WorkflowDefinition | undefined {
  return getBuiltInWorkflowDefinition(key, version);
}

function workflowRunExistsReadOnly(dataDir: string, runId: string): boolean {
  const db = openExistingDbReadOnly(dataDir);
  if (db === undefined) {
    return false;
  }
  try {
    const hasWorkflowRuns = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'"
      )
      .get();
    if (hasWorkflowRuns === undefined) {
      return false;
    }
    return (
      db
        .prepare("SELECT 1 FROM workflow_runs WHERE id = ? LIMIT 1")
        .get(runId) !== undefined
    );
  } finally {
    db.close();
  }
}

/**
 * Build the {@link WorkflowRunStartInput} shared by the durable start path and
 * the non-durable preview path. Keeping a single builder guarantees a preview
 * reflects exactly the inputs a `workflow run start[-coding]` would persist.
 */
function buildWorkflowRunStartInput(args: {
  definition: WorkflowDefinition;
  runId: string;
  repoPath: string;
  objective: string;
  now: number;
  coding: boolean;
  parsed: ParsedFlags;
  stepRouteOverrides: CodingStepRouteOverrides;
}): WorkflowRunStartInput {
  const {
    definition,
    runId,
    repoPath,
    objective,
    now,
    coding,
    parsed,
    stepRouteOverrides
  } = args;
  const input: WorkflowRunStartInput = {
    definition,
    runId,
    repoPath,
    objective,
    now
  };
  if (coding) {
    input.source = MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE;
  }
  if (parsed.approvalBoundary !== undefined) {
    input.approvalBoundary = parsed.approvalBoundary;
  }
  if (parsed.skillRevision !== undefined) {
    input.skillRevision = parsed.skillRevision;
  }
  if (parsed.issueScope !== undefined) {
    input.issueScope = { identifier: parsed.issueScope };
  }
  // Compose the durable run route from the recorded operator profile (route.profile)
  // and the validated per-step overrides (route.steps). The steps namespace is only
  // embedded when at least one override is present, so a run with neither input keeps
  // an empty route, exactly as before NGX-510.
  let route: Record<string, unknown> = {};
  if (parsed.profile !== undefined) {
    route.profile = parsed.profile;
  }
  route = writeCodingStepRouteOverrides(route, stepRouteOverrides);
  if (Object.keys(route).length > 0) {
    input.route = route;
  }
  return input;
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

  return emitWorkflowRunApproveSuccess(
    parsed,
    io,
    {
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
    },
    artifactPath
  );
}

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
    return emitWorkflowRunDecideSuccess(parsed, io, dataDir, resolved);
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

      const monitorState = refreshWorkflowRunRuntimeState(db, {
        runId,
        now
      });
      const runState = monitorState.runState;

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

  return emitWorkflowRunUpdateStepSuccess(parsed, io, resultPayload, {
    runId,
    stepId,
    targetState,
    reason,
    actor,
    dataDir
  });
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
  const rows = loadWorkflowRuntimeStateRows(db, input.runId);
  const steps = rows.steps.map((step) =>
    step.stepId === input.stepId
      ? { ...step, state: input.targetState }
      : step
  );
  const monitor = deriveWorkflowMonitorState({
    runId: input.runId,
    steps,
    leases: rows.leases,
    monitor: null,
    lastCheckpoint: null,
    now: input.now
  });
  return (
    monitor.recovery === null ||
    !isBlockingWorkflowRecoveryCode(monitor.recovery.code)
  );
}

function refreshWorkflowRunMonitorAdvisory(
  db: MomentumDb,
  runId: string,
  now: number
): WorkflowMonitorState {
  const rows = loadWorkflowRuntimeStateRows(db, runId);
  const monitorState = deriveWorkflowMonitorState({
    runId,
    steps: rows.steps,
    leases: rows.leases,
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
    const clearInput: ClearWorkflowRunManualRecoveryGuardedInput = { runId };
    if (parsed.evidencePointer !== undefined) {
      clearInput.externalSideEffectEvidencePointer = parsed.evidencePointer;
      clearInput.successfulNoMistakesEvidencePointer = parsed.evidencePointer;
    }
    if (parsed.ledgerPointer !== undefined) {
      clearInput.externalSideEffectLedgerPointer = parsed.ledgerPointer;
      clearInput.successfulNoMistakesLedgerPointer = parsed.ledgerPointer;
    }
    result = clearWorkflowRunManualRecoveryGuarded(db, clearInput);
    if (result.ok) {
      refreshWorkflowRunMonitorAdvisory(db, runId, result.clearedAt);
    }
  } finally {
    db.close();
  }

  return emitWorkflowRunClearRecovery(parsed, io, dataDir, runId, result);
}

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
  if (
    parsed.advance &&
    envelope.source !== MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
  ) {
    return emitWorkflowRunMonitorFailure(parsed, io, {
      code: "advance_unsupported_source",
      message:
        "`--advance` is only supported for Momentum-native coding workflow runs.",
      dataDir,
      runId
    });
  }

  // Project the durable envelope into a native progress tick (NGX-511),
  // suppressing against the last emitted digest. The default read stays
  // read-only: the emitted digest is read as the baseline but not advanced.
  const progress = deriveWorkflowMonitorProgress(envelope, {
    priorDigest: envelope.monitorLastEmittedDigest
  });

  // Opt-in activation writer: `--advance` persists this tick's digest as the
  // durable suppression baseline so a cheap cron loop polling `monitor`
  // repeatedly can suppress unchanged ticks across invocations. The emitted
  // baseline only moves when the tick actually emits (first observation or a
  // meaningful state change); the seen digest always records the observation.
  let advanced = false;
  if (parsed.advance) {
    const emittedDigest = progress.emit
      ? progress.digest
      : envelope.monitorLastEmittedDigest;
    let writeDb: MomentumDb | undefined;
    try {
      writeDb = openDb(dataDir);
      writeDb
        .prepare(
          `UPDATE workflow_runs
             SET monitor_last_seen_digest = ?,
                 monitor_last_emitted_digest = ?
           WHERE id = ?`
        )
        .run(progress.digest, emittedDigest, runId);
    } catch (err) {
      return emitWorkflowRunMonitorFailure(parsed, io, {
        code: "data_dir_failed",
        message: err instanceof Error ? err.message : String(err),
        dataDir,
        runId
      });
    } finally {
      writeDb?.close();
    }
    advanced = progress.emit;
  }

  return emitWorkflowRunMonitor(parsed, io, dataDir, envelope, progress, advanced);
}

async function workflowRunWatch(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): Promise<number> {
  const positional = parsed.args.slice(3);
  if (positional.length === 0 || !positional[0]) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run watch."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run watch: ${positional[1]}`,
      parsed,
      io
    );
  }
  if (!parsed.once) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "once_required",
      message: "workflow run watch currently requires --once."
    });
  }
  const runId = positional[0];

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitWorkflowRunWatchFailure(parsed, io, {
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
    if (envelope !== null) {
      const tickFailure = await runWorkflowWatchDispatcherTick(
        db,
        envelope,
        io.env ?? {},
        deps
      );
      if (tickFailure !== null) {
        return emitWorkflowRunWatchFailure(parsed, io, {
          ...tickFailure,
          dataDir,
          runId
        });
      }
      envelope = loadWorkflowMonitorEnvelope(db, runId);
    }
  } catch (err) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      runId
    });
  } finally {
    db?.close();
  }

  if (envelope === null) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "run_not_found",
      message: `Workflow run not found: ${runId}`,
      dataDir,
      runId
    });
  }
  if (envelope.source !== MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "watch_unsupported_source",
      message:
        "`workflow run watch --once` is only supported for Momentum-native coding workflow runs.",
      dataDir,
      runId
    });
  }

  const progress = deriveWorkflowMonitorProgress(envelope, {
    priorDigest: envelope.monitorLastEmittedDigest
  });
  const emittedDigest = progress.emit
    ? progress.digest
    : envelope.monitorLastEmittedDigest;

  let writeDb: MomentumDb | undefined;
  try {
    writeDb = openDb(dataDir);
    writeDb
      .prepare(
        `UPDATE workflow_runs
           SET monitor_last_seen_digest = ?,
               monitor_last_emitted_digest = ?
         WHERE id = ?`
      )
      .run(progress.digest, emittedDigest, runId);
  } catch (err) {
    return emitWorkflowRunWatchFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      runId
    });
  } finally {
    writeDb?.close();
  }

  return emitWorkflowRunWatch(parsed, io, dataDir, envelope, progress);
}

type WorkflowWatchDispatchFailure = {
  code: string;
  message: string;
};

class WorkflowWatchDispatchConfigError extends Error {
  readonly failure: WorkflowWatchDispatchFailure;

  constructor(failure: WorkflowWatchDispatchFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

async function runWorkflowWatchDispatcherTick(
  db: MomentumDb,
  envelope: WorkflowMonitorEnvelope,
  env: Record<string, string | undefined>,
  deps: CliDeps
): Promise<WorkflowWatchDispatchFailure | null> {
  const stepId = envelope.nextAction.stepId;
  const canDispatchNextStep =
    envelope.nextAction.code === "advance_to_step" && stepId !== null;
  const canRecheckActiveStep = envelope.activeStep?.state === "running";
  if (
    envelope.source !== MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE ||
    envelope.needsManualRecovery ||
    envelope.recovery !== null ||
    envelope.gates.some((gate) => gate.resolvedAt === null) ||
    (!canDispatchNextStep && !canRecheckActiveStep)
  ) {
    return null;
  }

  const now = Date.now();
  const workerId = `workflow-watch:${envelope.runId}`;
  let dispatchResolution: ReturnType<
    typeof resolveDaemonWorkflowStepDispatch
  > | null = null;
  if (canDispatchNextStep) {
    dispatchResolution = resolveDaemonWorkflowStepDispatch(
      env,
      executeWorkflowStepDispatch,
      deps
    );
    if (!dispatchResolution.ok) {
      return {
        code: "daemon_live_wrapper_profile_invalid",
        message: dispatchResolution.message
      };
    }
  }
  const recovery: RecoverStaleWorkflowLeasesResult = {
    recovered: [],
    skipped: []
  };
  try {
    await runWorkflowSchedulerOnceAsync({
      db,
      runId: envelope.runId,
      workerId,
      dispatch: (claim, context) => {
        dispatchResolution ??= resolveDaemonWorkflowStepDispatch(
          env,
          executeWorkflowStepDispatch,
          deps
        );
        if (!dispatchResolution.ok) {
          throw new WorkflowWatchDispatchConfigError({
            code: "daemon_live_wrapper_profile_invalid",
            message: dispatchResolution.message
          });
        }
        return dispatchResolution.dispatch(claim, context);
      },
      now: () => now,
      ...(dispatchResolution?.ok &&
      dispatchResolution.leaseDurationMs !== undefined
        ? { leaseDurationMs: dispatchResolution.leaseDurationMs }
        : {}),
      deps: {
        recoverStaleLeases: () => recovery
      }
    });
  } catch (error) {
    if (error instanceof WorkflowWatchDispatchConfigError) {
      return error.failure;
    }
    throw error;
  }
  return null;
}

function workflowRunLogs(parsed: ParsedFlags, io: CliIo): number {
  const positional = parsed.args.slice(3);
  if (positional.length === 0 || !positional[0]) {
    return emitWorkflowRunLogsFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required <run-id> for workflow run logs."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for workflow run logs: ${positional[1]}`,
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
    return emitWorkflowRunLogsFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      runId
    });
  }

  let envelope: WorkflowRunLogsEnvelope | null;
  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);
    envelope = loadWorkflowRunLogs(db, runId);
  } catch (err) {
    return emitWorkflowRunLogsFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      runId
    });
  } finally {
    db?.close();
  }

  if (envelope === null) {
    return emitWorkflowRunLogsFailure(parsed, io, {
      code: "run_not_found",
      message: `Workflow run not found: ${runId}`,
      dataDir,
      runId
    });
  }

  return emitWorkflowRunLogs(parsed, io, dataDir, envelope);
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

  return emitWorkflowHandoff(parsed, io, dataDir, envelope);
}
