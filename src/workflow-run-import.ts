/**
 * WorkflowRun import normalizer for NGX-314 (M7-02 import current
 * agent-workflow plans).
 *
 * Reads a `.agent-workflows/<run-id>/` directory and normalizes the durable
 * artifacts (`plan.json`, `ledger.jsonl`, `approval-*.json`, advisory
 * `monitor.json`) into the M7 `WorkflowRun` / `workflow_steps` /
 * `workflow_approvals` / `workflow_leases` shape pinned by
 * internal/contracts/workflow-runs.md.
 *
 * This module is pure: it does not touch SQLite, does not mutate the source
 * directory, and does not call external services. Persistence and the CLI
 * surface that consumes this normalizer live in follow-up M7 slices.
 *
 * Stable contracts this slice locks in:
 *   - `monitor.json` is treated strictly as advisory: terminal ledger /
 *     external evidence wins over stale monitor state.
 *   - Lost managed-task markers (`managed-*.pid` / `managed-*.log` siblings,
 *     `locks/` subdirectory) coexist with completed ledger evidence and do
 *     not emit diagnostics or force a failed step state.
 *   - Two invocations on the same directory return equal results (the import
 *     does not encode wall-clock time), so the persistence slice can rely on
 *     a stable ingest key.
 *   - Unknown sibling filenames, ledger lines missing required fields, and
 *     approval files with malformed boundaries surface as diagnostics
 *     without dropping the valid records around them.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  WORKFLOW_APPROVAL_BOUNDARIES,
  WORKFLOW_STEP_KINDS,
  type WorkflowApprovalBoundary,
  type WorkflowLeaseStalePolicy,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepState
} from "./workflow-run-reducer.js";

export const WORKFLOW_RUN_IMPORT_SOURCE = "agent-workflow" as const;

export type WorkflowRunImportSource = typeof WORKFLOW_RUN_IMPORT_SOURCE;

export type WorkflowRunImportDiagnosticCode =
  | "evidence_format_unknown"
  | "evidence_format_invalid";

export type WorkflowRunImportDiagnostic = {
  code: WorkflowRunImportDiagnosticCode;
  path: string;
  reason: string;
  detail?: string;
};

export type WorkflowRunImportRun = {
  runId: string;
  source: WorkflowRunImportSource;
  sourceArtifactPath: string | null;
  planJson: Record<string, unknown> | null;
  repoPath: string | null;
  objective: string | null;
  issueScope: Record<string, unknown>;
  route: Record<string, unknown>;
  approvalBoundary: string | null;
  skillRevision: string | null;
  state: WorkflowRunState;
};

export type WorkflowRunImportStep = {
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  order: number;
  required: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  ledgerOffset: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type WorkflowRunImportApproval = {
  boundary: WorkflowApprovalBoundary;
  actor: string | null;
  phrase: string;
  artifactPath: string;
  artifactDigest: string;
  recordedAt: number;
  dischargedAt: number | null;
};

export type WorkflowRunImportLease = {
  leaseKind: "monitor";
  holder: string;
  acquiredAt: number;
  expiresAt: number;
  heartbeatAt: number;
  releasedAt: number | null;
  stalePolicy: WorkflowLeaseStalePolicy;
  advisory: true;
};

export type WorkflowRunImportMonitor = {
  advisory: true;
  runState: string | null;
  terminal: boolean | null;
  step: string | null;
  lastSeenDigest: string | null;
  lastEmittedDigest: string | null;
};

export type WorkflowRunImport = {
  run: WorkflowRunImportRun;
  steps: WorkflowRunImportStep[];
  approvals: WorkflowRunImportApproval[];
  leases: WorkflowRunImportLease[];
  monitor: WorkflowRunImportMonitor | null;
  diagnostics: WorkflowRunImportDiagnostic[];
};

export type WorkflowRunImportErrorCode =
  | "import_path_unreadable"
  | "import_path_not_directory"
  | "import_run_id_missing";

export type WorkflowRunImportResult =
  | { ok: true; import: WorkflowRunImport }
  | {
      ok: false;
      errorCode: WorkflowRunImportErrorCode;
      message: string;
      diagnostics: WorkflowRunImportDiagnostic[];
    };

const APPROVAL_BOUNDARY_SET: ReadonlySet<string> = new Set(
  WORKFLOW_APPROVAL_BOUNDARIES
);

const STEP_KIND_BY_BARE_NAME: ReadonlyMap<string, WorkflowStepKind> = new Map(
  WORKFLOW_STEP_KINDS.map((kind) => [kind, kind])
);

const RUN_ID_PATTERN = /^(cwfp|cwfb|overnight)-[A-Za-z0-9]+$/;

const KNOWN_SIBLING_FILES: ReadonlySet<string> = new Set([
  "plan.json",
  "ledger.jsonl",
  "monitor.json"
]);

const KNOWN_SIBLING_DIRECTORIES: ReadonlySet<string> = new Set(["locks"]);

export function parseWorkflowRunImport(
  artifactPath: string
): WorkflowRunImportResult {
  const diagnostics: WorkflowRunImportDiagnostic[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(artifactPath);
  } catch (err) {
    return {
      ok: false,
      errorCode: "import_path_unreadable",
      message: `Cannot read import path: ${err instanceof Error ? err.message : String(err)}`,
      diagnostics
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      errorCode: "import_path_not_directory",
      message: `Import path must be a directory: ${artifactPath}`,
      diagnostics
    };
  }

  const entries = readDirectorySorted(artifactPath, diagnostics);
  if (entries === null) {
    return {
      ok: false,
      errorCode: "import_path_unreadable",
      message: `Cannot read import directory: ${artifactPath}`,
      diagnostics
    };
  }

  const planEntry = entries.find((e) => e.name === "plan.json" && e.isFile);
  const ledgerEntry = entries.find((e) => e.name === "ledger.jsonl" && e.isFile);
  const monitorEntry = entries.find((e) => e.name === "monitor.json" && e.isFile);
  const approvalEntries = entries.filter(
    (e) => e.isFile && /^approval-.+\.json$/.test(e.name)
  );

  reportUnknownEntries(entries, approvalEntries, diagnostics);

  const planResult = planEntry
    ? readPlanFile(path.join(artifactPath, planEntry.name), diagnostics)
    : null;

  const runIdFromPlan =
    planResult?.plan && stringField(planResult.plan, "runId");
  const runIdFromBasename = runIdFromBasenameValue(path.basename(artifactPath));
  const runId = runIdFromPlan ?? runIdFromBasename;
  if (!runId) {
    return {
      ok: false,
      errorCode: "import_run_id_missing",
      message: `Cannot determine runId for ${artifactPath}: no plan.json runId and directory basename does not look like a run id (e.g. cwfp-...).`,
      diagnostics
    };
  }

  const plan = planResult?.plan ?? null;
  const planPath = planEntry ? path.join(artifactPath, planEntry.name) : null;
  const monitorPath = monitorEntry
    ? path.join(artifactPath, monitorEntry.name)
    : null;

  const ledgerEvents = ledgerEntry
    ? readLedgerFile(path.join(artifactPath, ledgerEntry.name), runId, diagnostics)
    : [];

  const monitor = monitorPath ? readMonitorFile(monitorPath, diagnostics) : null;

  const approvalsRequired = plan ? extractApprovalsRequired(plan) : new Set<string>();
  const stepsFromPlan = plan ? extractStepsFromPlan(plan, approvalsRequired) : [];
  const steps = mergeLedgerIntoSteps(stepsFromPlan, ledgerEvents, approvalsRequired);

  const approvals = approvalEntries
    .map((entry) =>
      readApprovalFile(path.join(artifactPath, entry.name), runId, diagnostics)
    )
    .filter((row): row is WorkflowRunImportApproval => row !== null)
    .sort((a, b) => a.boundary.localeCompare(b.boundary));

  const leases: WorkflowRunImportLease[] = [];

  const issueScope = plan ? extractIssueScope(plan) : {};
  const route = plan ? extractRoute(plan) : {};
  const skillRevision = plan ? extractSkillRevisionDigest(plan) : null;
  const approvalBoundary = approvals.length > 0
    ? approvals[approvals.length - 1]!.boundary
    : null;

  const run: WorkflowRunImportRun = {
    runId,
    source: WORKFLOW_RUN_IMPORT_SOURCE,
    sourceArtifactPath: planPath,
    planJson: plan,
    repoPath: plan ? stringField(plan, "repo") : null,
    objective: plan ? stringField(plan, "objective") : null,
    issueScope,
    route,
    approvalBoundary,
    skillRevision,
    state: deriveRunStateFromSteps(steps)
  };

  return {
    ok: true,
    import: {
      run,
      steps,
      approvals,
      leases,
      monitor,
      diagnostics
    }
  };
}

type DirEntry = { name: string; isFile: boolean; isDirectory: boolean };

function readDirectorySorted(
  dirPath: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): DirEntry[] | null {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: dirPath,
      reason: "directory_unreadable",
      detail: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  return dirents
    .map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function reportUnknownEntries(
  entries: DirEntry[],
  approvalEntries: DirEntry[],
  diagnostics: WorkflowRunImportDiagnostic[]
): void {
  const approvalNames = new Set(approvalEntries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (KNOWN_SIBLING_DIRECTORIES.has(entry.name)) continue;
      diagnostics.push({
        code: "evidence_format_unknown",
        path: entry.name,
        reason: "unsupported_subdirectory"
      });
      continue;
    }
    if (!entry.isFile) {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: entry.name,
        reason: "unsupported_entry_kind"
      });
      continue;
    }
    if (KNOWN_SIBLING_FILES.has(entry.name)) continue;
    if (approvalNames.has(entry.name)) continue;
    if (isAdvisorySibling(entry.name)) continue;
    diagnostics.push({
      code: "evidence_format_unknown",
      path: entry.name,
      reason: "unrecognized_filename"
    });
  }
}

function isAdvisorySibling(name: string): boolean {
  if (name.startsWith("managed-") && (name.endsWith(".pid") || name.endsWith(".log"))) {
    return true;
  }
  if (name.includes(".backup-")) return true;
  return false;
}

type ReadPlanResult = { plan: Record<string, unknown> | null };

function readPlanFile(
  filePath: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): ReadPlanResult {
  const parsed = readJsonFile(filePath, diagnostics);
  if (parsed === undefined) return { plan: null };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "plan_not_object"
    });
    return { plan: null };
  }
  return { plan: parsed as Record<string, unknown> };
}

type LedgerEvent = {
  runId: string;
  step: string;
  status: "started" | "complete" | "failed";
  ts: number;
  ledgerOffset: number;
  errorCode: string | null;
  errorMessage: string | null;
};

function readLedgerFile(
  filePath: string,
  expectedRunId: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): LedgerEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "ledger_unreadable",
      detail: err instanceof Error ? err.message : String(err)
    });
    return [];
  }

  const events: LedgerEvent[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.trim().length === 0) continue;
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_not_json",
        detail: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_not_object"
      });
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    const runId = stringField(entry, "runId");
    const step = stringField(entry, "step");
    const status = stringField(entry, "status");
    const ts = stringField(entry, "ts");
    if (!runId || !step || !status) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_missing_required_fields"
      });
      continue;
    }
    if (runId !== expectedRunId) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_run_id_mismatch",
        detail: `event runId=${runId}, expected ${expectedRunId}`
      });
      continue;
    }
    if (status !== "started" && status !== "complete" && status !== "failed") {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: `${filePath}:${lineNumber}`,
        reason: "unknown_step_or_status",
        detail: `step=${step} status=${status}`
      });
      continue;
    }
    const occurredAt = ts ? Date.parse(ts) : Number.NaN;
    if (!Number.isFinite(occurredAt)) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_invalid_timestamp",
        detail: ts ?? "(missing)"
      });
      continue;
    }
    const errorCode = stringField(entry, "errorCode");
    const errorMessage = stringField(entry, "errorMessage") ?? stringField(entry, "error");
    events.push({
      runId,
      step,
      status,
      ts: occurredAt,
      ledgerOffset: lineNumber,
      errorCode,
      errorMessage
    });
  }
  return events;
}

function readMonitorFile(
  filePath: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): WorkflowRunImportMonitor | null {
  const parsed = readJsonFile(filePath, diagnostics);
  if (parsed === undefined) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "monitor_not_object"
    });
    return null;
  }
  const monitor = parsed as Record<string, unknown>;
  const terminalRaw = monitor["terminal"];
  return {
    advisory: true,
    runState: stringField(monitor, "lastSeenState"),
    terminal: typeof terminalRaw === "boolean" ? terminalRaw : null,
    step: stringField(monitor, "step"),
    lastSeenDigest: stringField(monitor, "lastSeenDigest"),
    lastEmittedDigest: stringField(monitor, "lastEmittedDigest")
  };
}

function readApprovalFile(
  filePath: string,
  expectedRunId: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): WorkflowRunImportApproval | null {
  const buf = safeReadFile(filePath, diagnostics);
  if (buf === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "file_not_json",
      detail: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_not_object"
    });
    return null;
  }
  const approval = parsed as Record<string, unknown>;
  const runId = stringField(approval, "runId");
  if (runId && runId !== expectedRunId) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_run_id_mismatch",
      detail: `approval runId=${runId}, expected ${expectedRunId}`
    });
    return null;
  }
  const boundary =
    stringField(approval, "boundary") ?? deriveBoundaryFromFilename(filePath);
  if (!boundary) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_missing_boundary"
    });
    return null;
  }
  if (!APPROVAL_BOUNDARY_SET.has(boundary)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_invalid_boundary",
      detail: boundary
    });
    return null;
  }
  const approvedAt = stringField(approval, "approvedAt");
  const recordedAt = approvedAt ? Date.parse(approvedAt) : Number.NaN;
  if (approvedAt && !Number.isFinite(recordedAt)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_invalid_timestamp",
      detail: approvedAt
    });
    return null;
  }
  const effectiveRecordedAt = Number.isFinite(recordedAt) ? recordedAt : 0;
  const digest = crypto.createHash("sha256").update(buf).digest("hex");
  const actor = stringField(approval, "actor");
  const phrase = stringField(approval, "phrase") ?? (boundary as string);

  return {
    boundary: boundary as WorkflowApprovalBoundary,
    actor,
    phrase,
    artifactPath: filePath,
    artifactDigest: digest,
    recordedAt: effectiveRecordedAt,
    dischargedAt: null
  };
}

function deriveBoundaryFromFilename(filePath: string): string | null {
  const match = /^approval-(.+)\.json$/.exec(path.basename(filePath));
  return match ? match[1] ?? null : null;
}

function extractApprovalsRequired(
  plan: Record<string, unknown>
): Set<string> {
  const raw = plan["approvalsRequired"];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((value): value is string => typeof value === "string"));
}

function extractStepsFromPlan(
  plan: Record<string, unknown>,
  approvalsRequired: Set<string>
): WorkflowRunImportStep[] {
  const taskFlow = plan["taskFlow"];
  if (!taskFlow || typeof taskFlow !== "object" || Array.isArray(taskFlow)) {
    return [];
  }
  const childTasks = (taskFlow as Record<string, unknown>)["childTasks"];
  if (!Array.isArray(childTasks)) return [];
  const steps: WorkflowRunImportStep[] = [];
  let order = 0;
  for (const child of childTasks) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const stepId = stringField(child as Record<string, unknown>, "stepId");
    if (!stepId) continue;
    const kind = classifyStepKind(stepId);
    if (!kind) continue;
    steps.push({
      stepId,
      kind,
      state: "pending",
      order,
      required: approvalsRequired.has(stepId),
      startedAt: null,
      finishedAt: null,
      ledgerOffset: null,
      errorCode: null,
      errorMessage: null
    });
    order += 1;
  }
  return steps;
}

function classifyStepKind(stepId: string): WorkflowStepKind | null {
  const bare = STEP_KIND_BY_BARE_NAME.get(stepId);
  if (bare) return bare;
  if (/^postflight:\d+$/.test(stepId)) return "postflight";
  return null;
}

function mergeLedgerIntoSteps(
  planSteps: WorkflowRunImportStep[],
  events: LedgerEvent[],
  approvalsRequired: Set<string>
): WorkflowRunImportStep[] {
  const byStepId = new Map<string, WorkflowRunImportStep>();
  for (const step of planSteps) byStepId.set(step.stepId, { ...step });

  let nextOrder = planSteps.length;
  for (const event of events) {
    let step = byStepId.get(event.step);
    if (!step) {
      const kind = classifyStepKind(event.step);
      if (!kind) continue;
      step = {
        stepId: event.step,
        kind,
        state: "pending",
        order: nextOrder,
        required: approvalsRequired.has(event.step),
        startedAt: null,
        finishedAt: null,
        ledgerOffset: null,
        errorCode: null,
        errorMessage: null
      };
      nextOrder += 1;
      byStepId.set(event.step, step);
    }
    applyLedgerEvent(step, event);
  }
  return Array.from(byStepId.values()).sort((a, b) => a.order - b.order);
}

function applyLedgerEvent(step: WorkflowRunImportStep, event: LedgerEvent): void {
  // Latest event wins: terminal evidence (complete / failed) overrides any
  // earlier `started` event; a later `started` event after a terminal one
  // (e.g., a retry that has not yet finished) re-promotes to `running`.
  if (event.status === "started") {
    if (step.startedAt === null || event.ts < step.startedAt) {
      step.startedAt = event.ts;
    }
    if (step.state === "pending" || step.state === "approved") {
      step.state = "running";
    } else if (event.ledgerOffset !== null && step.ledgerOffset !== null) {
      if (event.ledgerOffset > step.ledgerOffset) {
        step.state = "running";
        step.finishedAt = null;
        step.errorCode = null;
        step.errorMessage = null;
      }
    }
  } else if (event.status === "complete") {
    if (step.startedAt === null) step.startedAt = event.ts;
    step.finishedAt = event.ts;
    step.state = "succeeded";
    step.errorCode = null;
    step.errorMessage = null;
  } else if (event.status === "failed") {
    if (step.startedAt === null) step.startedAt = event.ts;
    step.finishedAt = event.ts;
    step.state = "failed";
    if (event.errorCode) step.errorCode = event.errorCode;
    if (event.errorMessage) step.errorMessage = event.errorMessage;
  }
  step.ledgerOffset = event.ledgerOffset;
}

function deriveRunStateFromSteps(steps: WorkflowRunImportStep[]): WorkflowRunState {
  if (steps.length === 0) return "pending";
  let anyRunning = false;
  let anyRequiredFailed = false;
  let anyNonRequiredFailed = false;
  let anySucceeded = false;
  let hasRequired = false;
  let allRequiredFinalSuccessOrSkip = true;
  let allStepsFinalSuccessOrSkip = true;
  for (const step of steps) {
    if (step.required) hasRequired = true;
    switch (step.state) {
      case "running":
        anyRunning = true;
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allStepsFinalSuccessOrSkip = false;
        break;
      case "failed":
        if (step.required) {
          anyRequiredFailed = true;
          allRequiredFinalSuccessOrSkip = false;
        } else {
          anyNonRequiredFailed = true;
        }
        allStepsFinalSuccessOrSkip = false;
        break;
      case "succeeded":
        anySucceeded = true;
        break;
      case "skipped":
        break;
      case "pending":
      case "approved":
      case "blocked":
      case "canceled":
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allStepsFinalSuccessOrSkip = false;
        break;
    }
  }
  if (anyRunning) return "running";
  if (anyRequiredFailed) return "failed";
  if (hasRequired && allRequiredFinalSuccessOrSkip && anySucceeded) {
    return "succeeded";
  }
  // No plan-declared required steps: fall back to "all observed steps are
  // terminal-success-or-skip and at least one succeeded" — used when the run
  // directory has no plan.json and we are inferring purely from ledger events.
  if (!hasRequired && allStepsFinalSuccessOrSkip && anySucceeded && !anyNonRequiredFailed) {
    return "succeeded";
  }
  return "pending";
}

function extractIssueScope(plan: Record<string, unknown>): Record<string, unknown> {
  const scope = plan["resolvedScope"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return {};
  }
  return scope as Record<string, unknown>;
}

function extractRoute(plan: Record<string, unknown>): Record<string, unknown> {
  const route: Record<string, unknown> = {};
  const passthrough = ["mode", "profile", "risk"];
  for (const key of passthrough) {
    const value = plan[key];
    if (typeof value === "string" && value.length > 0) {
      route[key] = value;
    }
  }
  const quotaPolicy = plan["quotaPolicy"];
  if (quotaPolicy && typeof quotaPolicy === "object" && !Array.isArray(quotaPolicy)) {
    route["quotaPolicy"] = quotaPolicy;
  }
  return route;
}

function extractSkillRevisionDigest(plan: Record<string, unknown>): string | null {
  const skill = plan["skillRevision"];
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
  return stringField(skill as Record<string, unknown>, "digest");
}

function runIdFromBasenameValue(basename: string): string | null {
  return RUN_ID_PATTERN.test(basename) ? basename : null;
}

function readJsonFile(
  filePath: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): unknown | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "file_unreadable",
      detail: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "file_not_json",
      detail: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
}

function safeReadFile(
  filePath: string,
  diagnostics: WorkflowRunImportDiagnostic[]
): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "file_unreadable",
      detail: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
