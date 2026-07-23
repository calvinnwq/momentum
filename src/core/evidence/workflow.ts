/**
 * Workflow artifact parser for workflow evidence ingestion.
 *
 * Reads `.agent-workflows/<run-id>/` artifacts (plan.json, ledger.jsonl,
 * approval-*.json) and normalizes them into `EvidenceRecordIngestInput`
 * values plus explicit `evidence_format_unknown` / `evidence_format_invalid`
 * diagnostics. This module performs no DB writes, no filesystem mutations,
 * and does not call external services — it is a pure reader so the CLI /
 * persistence slices can compose it without side effects.
 *
 * Stable contracts this slice locks in:
 *   - source = "agent-workflow" on every emitted record
 *   - ingestKey = `agent-workflow:<runId>:<step>:<status>` (or
 *     `agent-workflow:<runId>:plan_created`, `agent-workflow:<runId>:approval:<boundary>`)
 *     so repeat ingestion of the same artifact is idempotent at the DB layer.
 *     When a directory plan uses a retained step id and its ledger uses a known
 *     vocabulary alias, the plan id owns this lifecycle identity.
 *   - formatVersion = 1 on every record so a future artifact format bump
 *     can coexist with historical records.
 *   - runId is set on every emitted record (the owning `.agent-workflows/<runId>/`
 *     run). stepId is set on ledger step events to the durable plan step id when
 *     known, otherwise the bare ledger step name, including numbered postflight
 *     attempts; run-scoped plan / approval records carry null stepId.
 *   - Unknown step / status combinations and unknown sibling files in a
 *     workflow directory are skipped with an `evidence_format_unknown`
 *     diagnostic; malformed JSON / corrupt ledger lines emit
 *     `evidence_format_invalid` so callers can distinguish "we did not
 *     recognize this" from "we recognized this but it was broken".
 */

import fs from "node:fs";
import path from "node:path";

import type { EvidenceRecordIngestInput } from "./records.js";
import {
  canonicalWorkflowStepKind,
  LEGACY_STEP_KIND_ALIASES,
} from "../workflow/definition/legacy.js";

export const WORKFLOW_EVIDENCE_SOURCE = "agent-workflow";
export const WORKFLOW_EVIDENCE_FORMAT_VERSION = 1;

export type WorkflowEvidenceDiagnosticCode =
  "evidence_format_unknown" | "evidence_format_invalid";

export type WorkflowEvidenceDiagnostic = {
  code: WorkflowEvidenceDiagnosticCode;
  path: string;
  reason: string;
  detail?: string;
};

export type WorkflowEvidenceSource = {
  kind: "plan" | "ledger" | "approval" | "directory";
  path: string;
  runId: string | null;
};

export type ParseWorkflowArtifactOptions = {
  goalId?: string | null;
  sourceItemId?: string | null;
};

export type ParseWorkflowArtifactResult = {
  records: EvidenceRecordIngestInput[];
  diagnostics: WorkflowEvidenceDiagnostic[];
  sources: WorkflowEvidenceSource[];
};

type LedgerStatus = "started" | "complete" | "failed";

type NormalizedStep = {
  /** Stable event type for the (step, status) pair. */
  type: string;
  /** Discriminator appended to ingestKey to keep each lifecycle event unique. */
  ingestSuffix: string;
};

type ParsedPlanIdentity = {
  runId: string;
  stepIdsByCanonicalKind: ReadonlyMap<string, string | null>;
};

const KNOWN_STEPS: Record<
  string,
  { started?: string; complete?: string; failed?: string }
> = {
  preflight: { complete: "preflight_complete", failed: "preflight_failed" },
  implementation: {
    started: "implementation_started",
    complete: "implementation_complete",
    failed: "implementation_failed",
  },
  validate: {
    started: "validate_started",
    complete: "validate_complete",
    failed: "validate_failed",
  },
  "tracker-refresh": {
    started: "tracker_refresh_started",
    complete: "tracker_refresh_complete",
    failed: "tracker_refresh_failed",
  },
  "no-mistakes": {
    started: "no_mistakes_started",
    complete: "no_mistakes_complete",
    failed: "no_mistakes_failed",
  },
  "linear-refresh": {
    started: "linear_refresh_started",
    complete: "linear_refresh_complete",
    failed: "linear_refresh_failed",
  },
  "merge-cleanup": {
    started: "merge_cleanup_started",
    complete: "merge_complete",
    failed: "merge_cleanup_failed",
  },
};

export function parseWorkflowArtifact(
  artifactPath: string,
  options: ParseWorkflowArtifactOptions = {},
): ParseWorkflowArtifactResult {
  const records: EvidenceRecordIngestInput[] = [];
  const diagnostics: WorkflowEvidenceDiagnostic[] = [];
  const sources: WorkflowEvidenceSource[] = [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(artifactPath);
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: artifactPath,
      reason: "path_not_readable",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { records, diagnostics, sources };
  }

  if (stat.isDirectory()) {
    parseDirectory(artifactPath, options, records, diagnostics, sources);
  } else if (stat.isFile()) {
    parseFile(artifactPath, options, records, diagnostics, sources, stat);
  } else {
    diagnostics.push({
      code: "evidence_format_unknown",
      path: artifactPath,
      reason: "path_not_file_or_directory",
    });
  }

  return { records, diagnostics, sources };
}

function parseDirectory(
  dirPath: string,
  options: ParseWorkflowArtifactOptions,
  records: EvidenceRecordIngestInput[],
  diagnostics: WorkflowEvidenceDiagnostic[],
  sources: WorkflowEvidenceSource[],
): void {
  const runIdFromDir = runIdFromBasename(path.basename(dirPath));
  sources.push({ kind: "directory", path: dirPath, runId: runIdFromDir });

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: dirPath,
      reason: "directory_unreadable",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Order emission deterministically: plan first, then ledger (chronological
  // by `ts`), then approvals sorted by filename. Other entries become
  // diagnostics. This avoids depending on `readdirSync` ordering, which is
  // filesystem-specific.
  const planEntries: string[] = [];
  const ledgerEntries: string[] = [];
  const approvalEntries: string[] = [];

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: full,
        reason: "unsupported_subdirectory",
      });
      continue;
    }
    if (!entry.isFile()) {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: full,
        reason: "unsupported_entry_kind",
      });
      continue;
    }

    if (entry.name === "plan.json") {
      planEntries.push(full);
    } else if (entry.name === "ledger.jsonl") {
      ledgerEntries.push(full);
    } else if (
      entry.name.startsWith("approval-") &&
      entry.name.endsWith(".json")
    ) {
      approvalEntries.push(full);
    } else {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: full,
        reason: "unrecognized_filename",
      });
    }
  }

  const planStepIdsByRunId = new Map<
    string,
    ReadonlyMap<string, string | null>
  >();
  for (const full of planEntries) {
    const parsedPlan = parsePlanFile(
      full,
      options,
      records,
      diagnostics,
      sources,
      safeStat(full),
    );
    if (parsedPlan) {
      planStepIdsByRunId.set(
        parsedPlan.runId,
        parsedPlan.stepIdsByCanonicalKind,
      );
    }
  }
  for (const full of ledgerEntries) {
    parseLedgerFile(
      full,
      options,
      records,
      diagnostics,
      sources,
      planStepIdsByRunId,
    );
  }
  for (const full of approvalEntries.slice().sort()) {
    parseApprovalFile(
      full,
      options,
      records,
      diagnostics,
      sources,
      safeStat(full),
    );
  }
}

function parseFile(
  filePath: string,
  options: ParseWorkflowArtifactOptions,
  records: EvidenceRecordIngestInput[],
  diagnostics: WorkflowEvidenceDiagnostic[],
  sources: WorkflowEvidenceSource[],
  stat: fs.Stats,
): void {
  const base = path.basename(filePath);
  if (base === "plan.json") {
    parsePlanFile(filePath, options, records, diagnostics, sources, stat);
  } else if (base === "ledger.jsonl") {
    parseLedgerFile(filePath, options, records, diagnostics, sources);
  } else if (base.startsWith("approval-") && base.endsWith(".json")) {
    parseApprovalFile(filePath, options, records, diagnostics, sources, stat);
  } else {
    diagnostics.push({
      code: "evidence_format_unknown",
      path: filePath,
      reason: "unrecognized_filename",
    });
  }
}

function parsePlanFile(
  filePath: string,
  options: ParseWorkflowArtifactOptions,
  records: EvidenceRecordIngestInput[],
  diagnostics: WorkflowEvidenceDiagnostic[],
  sources: WorkflowEvidenceSource[],
  stat: fs.Stats | null,
): ParsedPlanIdentity | null {
  const parsed = readJsonFile(filePath, diagnostics);
  if (parsed === undefined) return null;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "plan_not_object",
    });
    return null;
  }

  const plan = parsed as Record<string, unknown>;
  const runId =
    stringField(plan, "runId") ??
    runIdFromBasename(path.basename(path.dirname(filePath)));
  if (!runId) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "plan_missing_run_id",
    });
    return null;
  }

  sources.push({ kind: "plan", path: filePath, runId });

  const objective = stringField(plan, "objective");
  const occurredAt = stat ? Math.floor(stat.mtimeMs) : 0;
  const summary = objective
    ? `Plan created: ${objective}`
    : `Plan created (${runId})`;
  const metadata: Record<string, unknown> = {
    runId,
    schemaVersion: numberField(plan, "schemaVersion") ?? null,
  };
  if (objective) metadata.objective = objective;
  const mode = stringField(plan, "mode");
  if (mode) metadata.mode = mode;
  const profile = stringField(plan, "profile");
  if (profile) metadata.profile = profile;
  const issues = extractIssueList(plan);
  if (issues.length > 0) metadata.issues = issues;

  records.push({
    source: WORKFLOW_EVIDENCE_SOURCE,
    type: "plan_created",
    formatVersion: WORKFLOW_EVIDENCE_FORMAT_VERSION,
    artifactPath: filePath,
    externalId: runId,
    occurredAt,
    summary,
    metadata,
    goalId: options.goalId ?? null,
    sourceItemId: options.sourceItemId ?? null,
    runId,
    stepId: null,
    ingestKey: `${WORKFLOW_EVIDENCE_SOURCE}:${runId}:plan_created`,
  });
  return {
    runId,
    stepIdsByCanonicalKind: collectPlanStepIds(plan),
  };
}

function parseLedgerFile(
  filePath: string,
  options: ParseWorkflowArtifactOptions,
  records: EvidenceRecordIngestInput[],
  diagnostics: WorkflowEvidenceDiagnostic[],
  sources: WorkflowEvidenceSource[],
  planStepIdsByRunId: ReadonlyMap<
    string,
    ReadonlyMap<string, string | null>
  > = new Map(),
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "ledger_unreadable",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const lines = content.split(/\r?\n/);
  let runIdFromLedger: string | null = null;
  for (let i = 0; i < lines.length; i++) {
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
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_not_object",
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
        reason: "ledger_line_missing_required_fields",
      });
      continue;
    }
    if (!runIdFromLedger) runIdFromLedger = runId;

    const stepId = resolvePlanStepId(step, planStepIdsByRunId.get(runId));
    const normalized = normalizeStep(stepId, status);
    if (!normalized) {
      diagnostics.push({
        code: "evidence_format_unknown",
        path: `${filePath}:${lineNumber}`,
        reason: "unknown_step_or_status",
        detail: `step=${step} status=${status}`,
      });
      continue;
    }

    const occurredAt = ts ? parseIsoTimestamp(ts) : null;
    if (occurredAt === null) {
      diagnostics.push({
        code: "evidence_format_invalid",
        path: `${filePath}:${lineNumber}`,
        reason: "ledger_line_invalid_timestamp",
        detail: ts ?? "(missing)",
      });
      continue;
    }

    const summary = buildLedgerSummary(normalized.type, entry, runId);
    const metadata = buildLedgerMetadata(entry, step, status);
    const legacyIngestKeys = equivalentStepIngestKeys(runId, stepId, status);

    records.push({
      source: WORKFLOW_EVIDENCE_SOURCE,
      type: normalized.type,
      formatVersion: WORKFLOW_EVIDENCE_FORMAT_VERSION,
      artifactPath: `${filePath}:${lineNumber}`,
      externalId: runId,
      occurredAt,
      summary,
      metadata,
      goalId: options.goalId ?? null,
      sourceItemId: options.sourceItemId ?? null,
      runId,
      stepId,
      ingestKey: `${WORKFLOW_EVIDENCE_SOURCE}:${runId}:${normalized.ingestSuffix}`,
      ...(legacyIngestKeys.length > 0 ? { legacyIngestKeys } : {}),
    });
  }

  sources.push({ kind: "ledger", path: filePath, runId: runIdFromLedger });
}

function collectPlanStepIds(
  plan: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string | null> {
  const result = new Map<string, string | null>();
  const taskFlow = plan["taskFlow"];
  if (!taskFlow || typeof taskFlow !== "object" || Array.isArray(taskFlow)) {
    return result;
  }
  const childTasks = (taskFlow as Record<string, unknown>)["childTasks"];
  if (!Array.isArray(childTasks)) return result;
  for (const child of childTasks) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const stepId = stringField(child as Record<string, unknown>, "stepId");
    if (!stepId) continue;
    const canonicalKind = canonicalWorkflowStepKind(stepId);
    if (canonicalKind === undefined) continue;
    const existing = result.get(canonicalKind);
    result.set(
      canonicalKind,
      existing === undefined || existing === stepId ? stepId : null,
    );
  }
  return result;
}

function resolvePlanStepId(
  ledgerStep: string,
  planStepIdsByCanonicalKind: ReadonlyMap<string, string | null> | undefined,
): string {
  const canonicalKind = canonicalWorkflowStepKind(ledgerStep);
  if (canonicalKind === undefined) return ledgerStep;
  return planStepIdsByCanonicalKind?.get(canonicalKind) ?? ledgerStep;
}

function equivalentStepIngestKeys(
  runId: string,
  stepId: string,
  status: string,
): string[] {
  const canonicalKind = canonicalWorkflowStepKind(stepId);
  if (canonicalKind === undefined) return [];
  const spellings = [
    canonicalKind,
    ...Object.entries(LEGACY_STEP_KIND_ALIASES)
      .filter(([, replacement]) => replacement === canonicalKind)
      .map(([legacy]) => legacy),
  ];
  const keys: string[] = [];
  for (const spelling of spellings) {
    if (spelling === stepId) continue;
    const normalized = normalizeStep(spelling, status);
    if (normalized) {
      keys.push(
        `${WORKFLOW_EVIDENCE_SOURCE}:${runId}:${normalized.ingestSuffix}`,
      );
    }
  }
  return keys;
}

function parseApprovalFile(
  filePath: string,
  options: ParseWorkflowArtifactOptions,
  records: EvidenceRecordIngestInput[],
  diagnostics: WorkflowEvidenceDiagnostic[],
  sources: WorkflowEvidenceSource[],
  stat: fs.Stats | null,
): void {
  const parsed = readJsonFile(filePath, diagnostics);
  if (parsed === undefined) return;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_not_object",
    });
    return;
  }
  const approval = parsed as Record<string, unknown>;
  const runId =
    stringField(approval, "runId") ??
    runIdFromBasename(path.basename(path.dirname(filePath)));
  if (!runId) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_missing_run_id",
    });
    return;
  }

  const boundary =
    stringField(approval, "boundary") ?? deriveBoundaryFromFilename(filePath);
  if (!boundary) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_missing_boundary",
    });
    return;
  }

  const approvedAt = stringField(approval, "approvedAt");
  const occurredAt = approvedAt ? parseIsoTimestamp(approvedAt) : null;
  if (approvedAt && occurredAt === null) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "approval_invalid_timestamp",
      detail: approvedAt,
    });
    return;
  }
  const effectiveOccurredAt =
    occurredAt ?? (stat ? Math.floor(stat.mtimeMs) : 0);

  sources.push({ kind: "approval", path: filePath, runId });

  const allowed = approval.allowedSteps;
  const metadata: Record<string, unknown> = { runId, boundary };
  if (Array.isArray(allowed)) {
    metadata.allowedSteps = allowed.filter(
      (step): step is string => typeof step === "string",
    );
  }
  const approvalContract = stringField(approval, "approvalContract");
  if (approvalContract) metadata.approvalContract = approvalContract;

  records.push({
    source: WORKFLOW_EVIDENCE_SOURCE,
    type: "step_approved",
    formatVersion: WORKFLOW_EVIDENCE_FORMAT_VERSION,
    artifactPath: filePath,
    externalId: runId,
    occurredAt: effectiveOccurredAt,
    summary: `Approval recorded: ${boundary} (${runId})`,
    metadata,
    goalId: options.goalId ?? null,
    sourceItemId: options.sourceItemId ?? null,
    runId,
    stepId: null,
    ingestKey: `${WORKFLOW_EVIDENCE_SOURCE}:${runId}:approval:${boundary}`,
  });
}

function normalizeStep(step: string, status: string): NormalizedStep | null {
  if (status !== "started" && status !== "complete" && status !== "failed") {
    return null;
  }
  const ledgerStatus = status as LedgerStatus;

  // Bare known step (preflight, implementation, validate, merge-cleanup).
  const entry = KNOWN_STEPS[step];
  if (entry) {
    const type = entry[ledgerStatus];
    if (!type) return null;
    return { type, ingestSuffix: `${step}:${status}` };
  }

  // Numbered postflight steps such as "postflight:1", "postflight:2".
  const postflight = /^postflight:(\d+)$/.exec(step);
  if (postflight) {
    const attempt = postflight[1];
    let type = "postflight_failed";
    if (status === "started") type = "postflight_started";
    if (status === "complete") type = "postflight_complete";
    return {
      type,
      ingestSuffix: `postflight:${attempt}:${status}`,
    };
  }

  return null;
}

function buildLedgerSummary(
  type: string,
  entry: Record<string, unknown>,
  runId: string,
): string {
  switch (type) {
    case "merge_complete": {
      const pr = stringField(entry, "pr");
      const mergeCommit = stringField(entry, "mergeCommit");
      const linearIssue = stringField(entry, "linearIssue");
      const parts = ["Merge complete"];
      if (linearIssue) parts.push(`(${linearIssue})`);
      if (pr) parts.push(`pr=${pr}`);
      if (mergeCommit) parts.push(`merge=${mergeCommit.slice(0, 12)}`);
      return parts.join(" ");
    }
    case "validate_complete": {
      const pr = stringField(entry, "pr") ?? stringField(entry, "prUrl");
      return pr
        ? `Validate complete (pr=${pr})`
        : `Validate complete (${runId})`;
    }
    case "tracker_refresh_complete":
      return `Tracker refresh complete (${runId})`;
    case "no_mistakes_complete": {
      const pr = stringField(entry, "pr") ?? stringField(entry, "prUrl");
      return pr
        ? `No-mistakes complete (pr=${pr})`
        : `No-mistakes complete (${runId})`;
    }
    case "implementation_complete":
      return `Implementation complete (${runId})`;
    case "implementation_failed":
      return `Implementation failed (${runId})`;
    case "implementation_started":
      return `Implementation started (${runId})`;
    case "preflight_complete":
      return `Preflight complete (${runId})`;
    case "preflight_failed":
      return `Preflight failed (${runId})`;
    case "postflight_started":
      return `Postflight started (${runId})`;
    case "postflight_complete":
      return `Postflight complete (${runId})`;
    case "postflight_failed":
      return `Postflight failed (${runId})`;
    case "validate_started":
      return `Validate started (${runId})`;
    case "validate_failed":
      return `Validate failed (${runId})`;
    case "tracker_refresh_started":
      return `Tracker refresh started (${runId})`;
    case "tracker_refresh_failed":
      return `Tracker refresh failed (${runId})`;
    case "no_mistakes_started":
      return `No-mistakes started (${runId})`;
    case "no_mistakes_failed":
      return `No-mistakes failed (${runId})`;
    case "linear_refresh_started":
      return `Linear refresh started (${runId})`;
    case "linear_refresh_complete":
      return `Linear refresh complete (${runId})`;
    case "linear_refresh_failed":
      return `Linear refresh failed (${runId})`;
    case "merge_cleanup_started":
      return `Merge cleanup started (${runId})`;
    case "merge_cleanup_failed":
      return `Merge cleanup failed (${runId})`;
    default:
      return `${type} (${runId})`;
  }
}

function buildLedgerMetadata(
  entry: Record<string, unknown>,
  step: string,
  status: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { step, status };
  const passthrough = [
    "pr",
    "prUrl",
    "mergeCommit",
    "cleanupCommit",
    "branch",
    "linearIssue",
    "linearState",
    "source",
    "gnhfRunId",
    "gnhfRunDir",
    "toolRunId",
    "head",
    "harness",
    "model",
  ] as const;
  for (const key of passthrough) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      metadata[key] = value;
    }
  }
  const verification = entry.verification;
  if (Array.isArray(verification)) {
    const filtered = verification.filter(
      (item): item is string => typeof item === "string",
    );
    if (filtered.length > 0) metadata.verification = filtered;
  }
  const artifacts = entry.artifacts;
  if (Array.isArray(artifacts)) {
    const filtered = artifacts.filter(
      (item): item is string => typeof item === "string",
    );
    if (filtered.length > 0) metadata.artifacts = filtered;
  }
  return metadata;
}

function readJsonFile(
  filePath: string,
  diagnostics: WorkflowEvidenceDiagnostic[],
): unknown | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    diagnostics.push({
      code: "evidence_format_invalid",
      path: filePath,
      reason: "file_unreadable",
      detail: err instanceof Error ? err.message : String(err),
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
      detail: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractIssueList(plan: Record<string, unknown>): string[] {
  const scope = plan.resolvedScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  const issues = (scope as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((value): value is string => typeof value === "string");
}

function parseIsoTimestamp(ts: string): number | null {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return ms;
}

function runIdFromBasename(basename: string): string | null {
  return /^(cwfp|cwfb|overnight)-[A-Za-z0-9]+$/.test(basename)
    ? basename
    : null;
}

function deriveBoundaryFromFilename(filePath: string): string | null {
  const match = /^approval-(.+)\.json$/.exec(path.basename(filePath));
  return match ? (match[1] ?? null) : null;
}
