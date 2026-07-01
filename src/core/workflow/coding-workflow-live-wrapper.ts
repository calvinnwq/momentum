/**
 * Opt-in NGX-499 coding-workflow live-wrapper command seam.
 *
 * The daemon live-wrapper profile owns process supervision, iteration-directory
 * result placement, and dispatch reconciliation. This module is the command the
 * checked-in NGX-499 profile runs: it reads
 * `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the current
 * `MOMENTUM_STEP_KIND`, executes the configured child command, and writes a
 * normalized `RunnerResult` to `MOMENTUM_RESULT_PATH`. Child commands report by
 * exit status; this seam synthesizes durable success/failure evidence so a
 * command failure is an ordinary failed step result instead of a stranded
 * process-level recovery case, except for explicitly classified no-mistakes
 * lifecycle gaps and terminal-success evidence.
 */
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runProcessGroupSync } from "../../adapters/live-step-wrapper.js";
import { normalizeRunnerResult } from "../executors/runner-result.js";
import type { CommitIntent, CommitType, RunnerResult } from "../executors/types.js";
import { preflightGitHubMergeCleanup } from "./external-adapter-preflight.js";
import {
  WORKFLOW_STEP_KINDS,
  isExternalSideEffectTailStepKind,
  type WorkflowStepKind
} from "./run-reducer.js";

export const CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR =
  "MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG";
export const CODING_WORKFLOW_WRAPPER_RECOVERY_MARKER =
  "MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable";

export const CODING_WORKFLOW_WRAPPER_ENV_VARS = [
  "MOMENTUM_RUN_ID",
  "MOMENTUM_STEP_ID",
  "MOMENTUM_STEP_KIND",
  "MOMENTUM_ATTEMPT",
  "MOMENTUM_AGENT_PROVIDER",
  "MOMENTUM_MODEL",
  "MOMENTUM_EFFORT",
  "MOMENTUM_REPO_PATH",
  "MOMENTUM_ITERATION_DIR",
  "MOMENTUM_PROMPT_PATH",
  "MOMENTUM_RESULT_PATH"
] as const;

export type CodingWorkflowWrapperCwd = "repo" | "iteration";

export type CodingWorkflowWrapperStepConfig = {
  command?: string;
  args: string[];
  cwd: CodingWorkflowWrapperCwd;
  timeoutSec: number;
  envAllow: string[];
  successSummary?: string;
  failureSummary?: string;
  keyChangesMade: string[];
  keyLearnings: string[];
  remainingWork: string[];
  commit: CommitIntent;
};

export type CodingWorkflowWrapperConfig = {
  steps: Partial<Record<WorkflowStepKind, CodingWorkflowWrapperStepConfig>>;
};

export type CodingWorkflowWrapperDeps = {
  env: NodeJS.ProcessEnv;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, contents: string) => void;
  mkdir: (dirPath: string) => void;
  spawn: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeout: number;
      encoding: BufferEncoding;
      maxBuffer: number;
    }
  ) => SpawnSyncReturns<string>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
};

export type CodingWorkflowWrapperOutcome = {
  exitCode: number;
  success: boolean;
  summary: string;
  resultPath?: string;
};

const WORKFLOW_STEP_KIND_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_KINDS);
const DEFAULT_TIMEOUT_SEC = 900;
const OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

export function defaultCodingWorkflowWrapperDeps(): CodingWorkflowWrapperDeps {
  return {
    env: process.env,
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents, "utf8"),
    mkdir: (dirPath) => fs.mkdirSync(dirPath, { recursive: true }),
    spawn: (command, args, options) =>
      runProcessGroupSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeout,
        maxBuffer: options.maxBuffer
      }),
    stdout: (chunk) => {
      fs.writeSync(1, chunk);
    },
    stderr: (chunk) => {
      fs.writeSync(2, chunk);
    }
  };
}

export function runCodingWorkflowLiveWrapper(
  deps: CodingWorkflowWrapperDeps = defaultCodingWorkflowWrapperDeps()
): CodingWorkflowWrapperOutcome {
  const resultPath = readRequiredEnv(deps.env, "MOMENTUM_RESULT_PATH");
  if (resultPath === undefined) {
    deps.stderr("MOMENTUM_RESULT_PATH is required.\n");
    return {
      exitCode: 1,
      success: false,
      summary: "MOMENTUM_RESULT_PATH is required."
    };
  }

  const stepKind = readWorkflowStepKind(deps.env["MOMENTUM_STEP_KIND"]);
  if (stepKind === undefined) {
    return writeFailureResult(deps, resultPath, "Unknown or missing MOMENTUM_STEP_KIND.");
  }

  const configPath = deps.env[CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]?.trim();
  if (configPath === undefined || configPath.length === 0) {
    return processSetupFailure(
      deps,
      `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG is required when the daemon live-wrapper profile uses the coding workflow wrapper for "${stepKind}".`
    );
  }

  const configLoad = loadCodingWorkflowWrapperConfig(deps);
  if (!configLoad.ok) {
    return processSetupFailure(deps, configLoad.error);
  }

  const stepConfig = configLoad.config.steps[stepKind];
  if (stepConfig?.command === undefined) {
    return processSetupFailure(
      deps,
      `No command is configured for workflow step "${stepKind}" in ${CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR}.`
    );
  }

  const cwd = resolveStepCwd(stepConfig.cwd, deps.env);
  if (!cwd.ok) {
    return writeFailureResult(deps, resultPath, cwd.error, stepKind, stepConfig);
  }

  const childEnv = buildChildEnv(deps.env, stepConfig.envAllow);
  if (stepKind === "merge-cleanup") {
    const preflight = preflightGitHubMergeCleanup({ env: childEnv });
    if (!preflight.ok) {
      return writeRunnerResult(deps, resultPath, {
        success: false,
        summary: preflight.message,
        key_changes_made: [],
        key_learnings: stepConfig.keyLearnings,
        remaining_work: [preflight.action],
        goal_complete: false,
        commit: stepConfig.commit
      });
    }
  }
  const result = deps.spawn(stepConfig.command, stepConfig.args, {
    cwd: cwd.path,
    env: childEnv,
    timeout: stepConfig.timeoutSec * 1000,
    encoding: "utf8",
    maxBuffer: OUTPUT_MAX_BYTES
  });

  if (result.stdout.length > 0) deps.stdout(result.stdout);
  if (result.stderr.length > 0) deps.stderr(result.stderr);

  const success =
    result.error === undefined && result.signal === null && result.status === 0;
  const recoverableNoMistakesFailure = classifyRecoverableNoMistakesRunnerFailure(
    stepKind,
    result
  );
  if (!success && recoverableNoMistakesFailure !== null) {
    return processSetupFailure(deps, recoverableNoMistakesFailure);
  }
  const terminalNoMistakesSuccess = classifyTerminalNoMistakesWorkflowSuccess(
    stepKind,
    result
  );
  if (!success && terminalNoMistakesSuccess !== null) {
    return writeRunnerResult(deps, resultPath, {
      success: true,
      summary: terminalNoMistakesSuccess,
      key_changes_made: stepConfig.keyChangesMade,
      key_learnings: stepConfig.keyLearnings,
      remaining_work: stepConfig.remainingWork,
      goal_complete: false,
      commit: stepConfig.commit
    });
  }
  const summary = summarizeCommandResult(stepKind, stepConfig, result, success);
  return writeRunnerResult(deps, resultPath, {
    success,
    summary,
    key_changes_made: success ? stepConfig.keyChangesMade : [],
    key_learnings: stepConfig.keyLearnings,
    remaining_work: success
      ? stepConfig.remainingWork
      : commandFailureRemainingWork(stepKind),
    goal_complete: false,
    commit: stepConfig.commit
  });
}

function commandFailureRemainingWork(kind: WorkflowStepKind): string[] {
  if (!isExternalSideEffectTailStepKind(kind)) {
    return [`Fix ${kind} command failure before advancing the workflow.`];
  }
  return [
    `${kind} may have completed external side effects (such as a pushed branch, a merged pull request, or a tracker write) before failing; verify the remote, pull request, and tracker state before taking further action.`,
    `Do not blindly re-run ${kind}: after confirming external success, use \`momentum workflow run clear-recovery <run-id> --evidence-pointer <ref>\` to reconcile the run from external evidence.`
  ];
}

export function classifyRecoverableNoMistakesRunnerFailure(
  kind: WorkflowStepKind,
  result: Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "error" | "signal">
): string | null {
  if (kind !== "no-mistakes") return null;
  if (result.error !== undefined || result.signal !== null) return null;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("no previous run for branch")) {
    return [
      "no-mistakes could not start for this branch because its external gate state has no previous run.",
      "Repair or re-seed the no-mistakes branch/gate state, then clear recovery to retry the no-mistakes step."
    ].join(" ");
  }
  if (
    output.includes("outcome: cancelled") &&
    output.includes("aborted by user")
  ) {
    return [
      "no-mistakes was cancelled before producing a reliable successful result.",
      "Inspect the external no-mistakes run for review/fixer state, repair the blocker, then clear recovery to retry the no-mistakes step."
    ].join(" ");
  }
  return null;
}

/**
 * Classify no-mistakes output that reached PR-ready success while the upstream
 * tool may still be monitoring its own lifecycle.
 *
 * Positive evidence is either a current `checks-passed` outcome or a current
 * running/monitoring state paired with a clean pull request and green or absent
 * required checks.
 * Current blocking outcomes, active gates/findings, contradictory PR state, and
 * non-successful check evidence prevent the classification.
 */
export function classifyTerminalNoMistakesWorkflowSuccess(
  kind: WorkflowStepKind,
  result: Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "error" | "signal">
): string | null {
  if (kind !== "no-mistakes") return null;
  if (result.error !== undefined || result.signal !== null) return null;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const outputLines = toNoMistakesOutputLines(output);
  if (hasActiveNoMistakesGateOrFinding(outputLines)) return null;
  if (hasBlockingNoMistakesStatusOrOutcome(outputLines)) return null;
  if (hasContradictoryNoMistakesSuccessEvidence(outputLines)) return null;

  if (outputLines.some((line) => isChecksPassedOutcomeLine(line))) {
    return [
      "no-mistakes reached checks-passed; treating the PR as terminal success for this workflow while no-mistakes continues any upstream monitoring."
    ].join(" ");
  }

  const stillMonitoring =
    outputLines.some(
      (line) =>
        !isHistoricalNoMistakesEvidenceLine(line) &&
        (isRunningNoMistakesStatusLine(line) ||
          /\bci\/running\b/.test(line) ||
          /\bstill (reports|shows).*running\b/.test(line))
    );
  if (!stillMonitoring) return null;

  const cleanPr = outputLines.some((line) =>
    isCleanPullRequestEvidenceLine(line)
  );
  if (!cleanPr) return null;

  const greenChecks = outputLines.some((line) => isGreenChecksEvidenceLine(line));
  if (!greenChecks) return null;

  return [
    "no-mistakes is still monitoring upstream, but the pull request is clean and checks are green; treating this as terminal success for this workflow."
  ].join(" ");
}

function toNoMistakesOutputLines(output: string): string[] {
  const lines: string[] = [];
  let pendingIndentedGateSection = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (isStructuredNoMistakesOutputLine(trimmed)) {
      lines.push(trimmed);
      const labelValue = parseNoMistakesGateOrFindingLabelLine(trimmed);
      pendingIndentedGateSection = isPendingNoMistakesIndentedGateSection(
        labelValue
      );
      continue;
    }
    for (const expanded of rawLine
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .split("\n")) {
      const expandedTrimmed = expanded.trim();
      const isIndented = /^\s+/.test(expanded);
      const line =
        pendingIndentedGateSection &&
        isIndented &&
        parseNoMistakesYamlListItem(expandedTrimmed) === null
          ? `- ${expandedTrimmed}`
          : expandedTrimmed;
      lines.push(line);
      const labelValue = parseNoMistakesGateOrFindingLabelLine(expandedTrimmed);
      if (isPendingNoMistakesIndentedGateSection(labelValue)) {
        pendingIndentedGateSection = true;
      } else if (expandedTrimmed.length > 0 && !isIndented) {
        pendingIndentedGateSection = false;
      }
    }
  }
  return lines;
}

function isPendingNoMistakesIndentedGateSection(
  labelValue: { label: string; value: string } | null
): boolean {
  return (
    labelValue !== null &&
    labelValue.value.length === 0 &&
    !isNoMistakesExternalStateContainerLabel(labelValue.label)
  );
}

function isStructuredNoMistakesOutputLine(line: string): boolean {
  if (parseNoMistakesJsonObjectLine(line) !== null) return true;
  return parseNoMistakesGateOrFindingLabelLines(line).some(
    (labelValue) => parseNoMistakesJsonValue(labelValue.value).ok
  );
}

type NoMistakesJsonValueParseResult =
  | { ok: true; value: unknown }
  | { ok: false };

function parseNoMistakesJsonValue(
  value: string
): NoMistakesJsonValueParseResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseNoMistakesJsonObjectLine(
  line: string
): Record<string, unknown> | null {
  const trimmed = line.trim();
  const jsonText = extractNoMistakesJsonObjectText(trimmed);
  if (jsonText === null) return null;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractNoMistakesJsonObjectText(line: string): string | null {
  const normalizedLine = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
  if (normalizedLine.startsWith("{") && normalizedLine.endsWith("}")) {
    return normalizedLine;
  }

  const start = normalizedLine.indexOf("{");
  const end = normalizedLine.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  const prefix = normalizedLine.slice(0, start);
  const suffix = normalizedLine.slice(end + 1).trim();
  if (suffix.length > 0 && suffix !== ",") return null;
  if (isHistoricalNoMistakesEvidenceLine(prefix)) return null;
  const prefixLabel = parseNoMistakesJsonObjectPrefixLabel(prefix);
  if (prefixLabel === null) return null;
  if (!isNoMistakesJsonStatusTraversalContainerLabel(prefixLabel)) return null;
  return normalizedLine.slice(start, end + 1);
}

function parseNoMistakesJsonObjectPrefixLabel(prefix: string): string | null {
  const match = /^\s*["']?(?<label>[a-z0-9][a-z0-9 _-]*)["']?\s*(?::|=>|=)\s*$/.exec(
    prefix
  );
  return match?.groups?.label ?? null;
}

function isChecksPassedOutcomeLine(line: string): boolean {
  if (isHistoricalNoMistakesEvidenceLine(line)) return false;
  return parseNoMistakesStatusOrOutcomeLine(line).some(
    ({ label, value }) => label === "outcome" && value === "checks-passed"
  );
}

function hasContradictoryNoMistakesSuccessEvidence(
  lines: readonly string[]
): boolean {
  return lines.some(
    (line) =>
      !isHistoricalNoMistakesEvidenceOnlyLine(line) &&
      (isContradictoryPullRequestEvidenceLine(line) ||
        isContradictoryChecksEvidenceLine(line))
  );
}

function hasBlockingNoMistakesStatusOrOutcome(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const parsed = parseNoMistakesStatusOrOutcomeLine(line);
    return parsed.some(({ label, value }) => {
      if (label === "recovery-code") {
        return isBlockingNoMistakesRecoveryCode(value);
      }
      if (label === "outcome") return isBlockingNoMistakesOutcome(value);
      if (label === "classification") return isBlockingNoMistakesClassification(value);
      return isBlockingNoMistakesStatus(value);
    });
  });
}

function isRunningNoMistakesStatusLine(line: string): boolean {
  const parsed = parseNoMistakesStatusOrOutcomeLine(line);
  return parsed.some(
    ({ label, value }) => label !== "outcome" && value === "running"
  );
}

function parseNoMistakesStatusOrOutcomeLine(
  line: string
): Array<{ label: string; value: string }> {
  const jsonObject = parseNoMistakesJsonObjectLine(line);
  if (jsonObject !== null) {
    const out: Array<{ label: string; value: string }> = [];
    collectNoMistakesStatusOrOutcomeJsonValues(jsonObject, out);
    return out;
  }
  if (hasHistoricalNoMistakesJsonObjectPrefix(line)) return [];
  if (hasDisallowedNoMistakesJsonObjectPrefix(line)) return [];

  const matches = line.matchAll(
    /(?:^|[,{;]\s*)(?:(?<scope>[a-z0-9][a-z0-9 _-]*)\s+)?["']?(?<label>status|outcome|classification|step[_ -]?status|recovery[_ -]?code)["']?\s*(?::|=>|=)\s*["']?(?<value>[a-z0-9][a-z0-9 _-]*)["']?/g
  );
  const out: Array<{ label: string; value: string }> = [];
  for (const match of matches) {
    const scope = normalizeNoMistakesStatusScope(match.groups?.scope ?? "");
    const rawLabel = match.groups?.label ?? "";
    if (!isNoMistakesStatusScope(scope)) continue;
    out.push({
      label: normalizeNoMistakesStatusLabel(
        scope === "step" && rawLabel === "status" ? "step-status" : rawLabel
      ),
      value: normalizeNoMistakesStatusValue(match.groups?.value ?? "")
    });
  }
  return out;
}

function hasHistoricalNoMistakesJsonObjectPrefix(line: string): boolean {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  return isHistoricalNoMistakesEvidenceLine(line.slice(0, start));
}

function hasDisallowedNoMistakesJsonObjectPrefix(line: string): boolean {
  const normalizedLine = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
  const start = normalizedLine.indexOf("{");
  const end = normalizedLine.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  const suffix = normalizedLine.slice(end + 1).trim();
  if (suffix.length > 0 && suffix !== ",") return false;
  const prefixLabel = parseNoMistakesJsonObjectPrefixLabel(
    normalizedLine.slice(0, start)
  );
  if (prefixLabel === null) return false;
  return !isNoMistakesJsonStatusTraversalContainerLabel(prefixLabel);
}

function collectNoMistakesStatusOrOutcomeJsonValues(
  value: unknown,
  out: Array<{ label: string; value: string }>
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNoMistakesStatusOrOutcomeJsonValues(item, out);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const label = normalizeNoMistakesStatusLabel(key);
    if (isNoMistakesStatusOrOutcomeLabel(label)) {
      if (rawValue === null) {
        out.push({
          label,
          value: label === "recovery-code" ? "null" : "__invalid__"
        });
        continue;
      }
      if (
        typeof rawValue === "string" ||
        typeof rawValue === "number" ||
        typeof rawValue === "boolean"
      ) {
        out.push({
          label,
          value: normalizeNoMistakesStatusValue(String(rawValue))
        });
      } else {
        out.push({ label, value: "__invalid__" });
      }
      continue;
    }
    if (
      isHistoricalNoMistakesJsonContainerLabel(key) ||
      isNoMistakesStatusTraversalExcludedLabel(key)
    ) {
      continue;
    }
    if (
      isNoMistakesGateOrFindingLabel(key) &&
      !isNoMistakesExternalStateContainerLabel(key)
    ) {
      continue;
    }
    if (isNoMistakesJsonStatusTraversalContainerLabel(key)) {
      collectNoMistakesStatusOrOutcomeJsonValues(rawValue, out);
    }
  }
}

function isNoMistakesJsonStatusTraversalContainerLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NO_MISTAKES_STATUS_TRAVERSAL_CONTAINER_LABELS.has(normalized);
}

const NO_MISTAKES_STATUS_TRAVERSAL_CONTAINER_LABELS = new Set([
  "state",
  "current",
  "currentstate",
  "run",
  "runstate",
  "step",
  "stepstate",
  "workflow",
  "workflowstate",
  "workflowrun",
  "workflowrunstate",
  "nomistakes",
  "nomistakesstate",
  "externalstate"
]);

function isNoMistakesStatusTraversalExcludedLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NO_MISTAKES_STATUS_TRAVERSAL_EXCLUDED_LABELS.has(normalized);
}

const NO_MISTAKES_STATUS_TRAVERSAL_EXCLUDED_LABELS = new Set([
  "pr",
  "pullrequest",
  "merge",
  "mergestate",
  "mergestatestatus",
  "mergeable",
  "mergeablestate"
]);

function isHistoricalNoMistakesJsonContainerLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NO_MISTAKES_HISTORICAL_JSON_CONTAINER_LABELS.has(normalized);
}

const NO_MISTAKES_HISTORICAL_JSON_CONTAINER_LABELS = new Set([
  "previous",
  "previously",
  "historical",
  "history",
  "stale",
  "prior",
  "past"
]);

function normalizeNoMistakesStatusLabel(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (normalized === "stepstatus") return "step-status";
  if (normalized === "recoverycode") return "recovery-code";
  return normalized;
}

function normalizeNoMistakesStatusScope(value: string): string {
  return value.trim().replace(/[ _]+/g, "-");
}

function isNoMistakesStatusScope(scope: string): boolean {
  if (scope.length === 0) return true;
  if (scope.endsWith("-step")) {
    return ACCEPTED_NO_MISTAKES_STATUS_SCOPES.has(
      scope.slice(0, -"-step".length)
    );
  }
  return ACCEPTED_NO_MISTAKES_STATUS_SCOPES.has(scope);
}

const ACCEPTED_NO_MISTAKES_STATUS_SCOPES = new Set([
  "current",
  "run",
  "step",
  "workflow",
  "workflow-run",
  "no-mistakes",
  "nomistakes"
]);

function isNoMistakesStatusOrOutcomeLabel(value: string): boolean {
  return (
    value === "status" ||
    value === "outcome" ||
    value === "classification" ||
    value === "recovery-code" ||
    value === "step-status"
  );
}

function normalizeNoMistakesStatusValue(value: string): string {
  return value.trim().replace(/[ _]+/g, "-");
}

function isBlockingNoMistakesStatus(value: string): boolean {
  return !ACCEPTED_NO_MISTAKES_STATUS_VALUES.has(value);
}

function isBlockingNoMistakesOutcome(value: string): boolean {
  return !ACCEPTED_NO_MISTAKES_OUTCOME_VALUES.has(value);
}

function isBlockingNoMistakesClassification(value: string): boolean {
  return !ACCEPTED_NO_MISTAKES_CLASSIFICATION_VALUES.has(value);
}

function isBlockingNoMistakesRecoveryCode(value: string): boolean {
  return !ACCEPTED_NO_MISTAKES_RECOVERY_CODES.has(value);
}

const ACCEPTED_NO_MISTAKES_STATUS_VALUES = new Set([
  "running",
  "success",
  "succeeded",
  "passed",
  "complete",
  "completed",
  "checks-passed"
]);

const ACCEPTED_NO_MISTAKES_OUTCOME_VALUES = new Set([
  "checks-passed",
  "success",
  "succeeded",
  "passed",
  "complete",
  "completed"
]);

const ACCEPTED_NO_MISTAKES_CLASSIFICATION_VALUES = new Set([
  "checks-passed",
  "success",
  "succeeded",
  "passed",
  "complete",
  "completed",
  "continue"
]);

const ACCEPTED_NO_MISTAKES_RECOVERY_CODES = new Set(["null", "none"]);

function isContradictoryPullRequestEvidenceLine(line: string): boolean {
  line = stripNoMistakesHistoricalAnnotationSegments(line);
  if (lineHasDraftPullRequestEvidence(line)) return true;
  if (lineHasExplicitNegativeEvidenceValue(line, ["clean"])) return true;
  if (lineHasTrailingEvidenceValue(line, ["clean"], ["false", "no", "0"])) {
    return true;
  }
  if (
    lineHasCopularEvidenceValue(line, ["clean"], [
      "false",
      "no",
      "0",
      "unknown",
      "pending"
    ])
  ) {
    return true;
  }
  if (lineHasExplicitNonPositiveEvidenceValue(line, ["clean"])) return true;
  if (
    lineHasTrailingEvidenceValue(line, ["clean"], [
      "false",
      "no",
      "0",
      "unknown",
      "pending"
    ])
  ) {
    return true;
  }
  if (
    /\bmerge conflicts?\b(?!\s*(?::|=>|=)?\s*(?:free|resolved|none)\b)/.test(
      line
    ) &&
    !/\b(?:no|without|not|zero)\b[^\n]*\bmerge conflicts?\b/.test(line)
  ) {
    return true;
  }
  const mentionsPullRequest =
    /\b(?:pr|pull request|mergestate(?:status)?|merge[_ -]?state(?:[_ -]?status)?|mergeable(?:[_ -]?state)?)\b/.test(
      line
    );
  if (!mentionsPullRequest) return false;
  if (lineHasExplicitNegativeEvidenceValue(line, ["mergeable"])) return true;
  if (lineHasNonMergeableEvidenceValue(line)) return true;
  if (
    /\bmergestate(status)?["'`: =-]*(behind|blocked|dirty|draft|has[_ -]hooks|unknown|unstable)\b/.test(
      line
    ) ||
    /\bmerge[_ -]?state(?:[_ -]?status)?["'`: =-]*(behind|blocked|dirty|draft|has[_ -]hooks|unknown|unstable)\b/.test(
      line
    ) ||
    /\bmergeable[_ -]?state["'`: =-]*(behind|blocked|dirty|draft|has[_ -]hooks|unknown|unstable)\b/.test(
      line
    )
  ) {
    return true;
  }
  if (
    /\b(?:not|isn't|isnt|wasn't|wasnt|can't|cant|cannot|never)\b[^\n]*\bclean\b/.test(
      line
    )
  ) {
    return true;
  }
  if (
    /\b(?:not|isn't|isnt|wasn't|wasnt|can't|cant|cannot|never|no)\b[^\n]*\bmergeable\b/.test(
      line
    ) ||
    /\b(?:not|isn't|isnt|wasn't|wasnt|can't|cant|cannot|never)\b[^\n]*\bmerged?\b/.test(
      line
    )
  ) {
    return true;
  }
  return /\b(?:unclean|dirty|conflicts?|blocked)\b/.test(line);
}

function isContradictoryChecksEvidenceLine(line: string): boolean {
  line = stripNoMistakesHistoricalAnnotationSegments(line);
  if (lineHasNonSuccessNoMistakesCiStateValue(line)) {
    return true;
  }
  if (lineHasNonSuccessCheckConclusionValue(line)) {
    return true;
  }
  if (
    /\bno checks reported\b/.test(line) &&
    !isNoChecksReportedEvidenceLine(line)
  ) {
    return true;
  }
  if (
    lineHasExplicitNegativeEvidenceValue(line, [
      "passed",
      "successful",
      "succeeded",
      "green"
    ])
  ) {
    return true;
  }
  if (lineHasExplicitNonPositiveCheckSuccessValue(line)) {
    return true;
  }
  if (
    lineHasTrailingEvidenceValue(
      line,
      ["passed", "successful", "succeeded", "green"],
      ["false", "no", "0"]
    )
  ) {
    return true;
  }
  if (
    lineHasCopularEvidenceValue(
      line,
      ["passed", "successful", "succeeded", "green"],
      [
        "false",
        "no",
        "0",
        "unknown",
        "pending",
        "skipped",
        "neutral",
        "action_required",
        "action-required"
      ]
    )
  ) {
    return true;
  }
  if (
    CHECKS_NEGATED_BEFORE_SUBJECT_PATTERN.test(line) ||
    CHECKS_NEGATED_AFTER_SUBJECT_PATTERN.test(line)
  ) {
    return true;
  }
  if (CHECKS_NEGATIVE_BEFORE_SUBJECT_PATTERN.test(line)) {
    return true;
  }
  if (
    /\bchecks?\b[^\n]*\b(?:running|in[ -]?progress|queued|waiting|awaiting|skipped|neutral|unknown|action[_ -]?required)\b/.test(line) ||
    /\bci\s+(?:is|checks?|status)\s*(?::|=>|=|\s+)\s*(?:running|in[ -]?progress|queued|waiting|awaiting|skipped|neutral|unknown|action[_ -]?required)\b/.test(
      line
    ) ||
    /\b(?:checks?|ci)\b[^\n]*\b(?:blocked|gated|skipped|neutral|unknown|action[_ -]?required)\b/.test(
      line
    )
  ) {
    return true;
  }
  return /\b(?:checks?|ci)\b[^\n]*\b(?:not|failed|failure|failing|red|unsuccessful|cancelled|canceled|timed out|timeout|pending|awaiting|skipped|neutral|unknown|action[_ -]?required)\b/.test(
    line
  );
}

function hasActiveNoMistakesGateOrFinding(lines: readonly string[]): boolean {
  let pendingSection = false;
  for (const trimmed of lines) {
    if (trimmed.length === 0) continue;
    if (pendingSection) {
      const listItem = parseNoMistakesYamlListItem(trimmed);
      if (listItem !== null) {
        if (isActiveNoMistakesValue(listItem)) return true;
        continue;
      }
      if (isInactiveNoMistakesStandaloneValue(trimmed)) {
        pendingSection = false;
        continue;
      }
      pendingSection = false;
    }
    const jsonObject = parseNoMistakesJsonObjectLine(trimmed);
    if (jsonObject !== null) {
      if (jsonObjectHasActiveNoMistakesGateOrFinding(jsonObject)) {
        return true;
      }
      if (jsonObjectHasActiveNoMistakesGateMarkerValue(jsonObject)) {
        return true;
      }
      const requiredFlags = classifyNoMistakesJsonRequiredGateFlags(jsonObject);
      if (requiredFlags.some((flag) => flag === "active")) {
        return true;
      }
      continue;
    }
    const requiredFlag = classifyNoMistakesRequiredGateFlagLine(trimmed);
    if (requiredFlag === "active") {
      return true;
    }
    const lineWithoutInactiveRequiredFlags =
      requiredFlag === "inactive"
        ? stripInactiveNoMistakesRequiredGateFlagEvidence(trimmed).trim()
        : trimmed;
    if (requiredFlag === "inactive") {
      if (lineWithoutInactiveRequiredFlags.length === 0) continue;
      if (isInactiveNoMistakesStandaloneValue(lineWithoutInactiveRequiredFlags)) {
        continue;
      }
    }
    if (
      !isNoMistakesIdentityOnlyLabelLine(lineWithoutInactiveRequiredFlags) &&
      hasActiveNoMistakesGateMarkerText(lineWithoutInactiveRequiredFlags)
    ) {
      return true;
    }
    const indexedDecision = /^\bdecisions?\[\d+\]\s*(?::|=>|=)\s*(.*)$/.exec(
      lineWithoutInactiveRequiredFlags
    );
    if (indexedDecision !== null) {
      return isActiveNoMistakesValue(indexedDecision[1] ?? "");
    }
    if (/\bdecisions?\[\d+\]/.test(lineWithoutInactiveRequiredFlags)) {
      return true;
    }
    if (/\bfindings?\[\d+\]/.test(lineWithoutInactiveRequiredFlags)) {
      return true;
    }
    const labelValues = parseNoMistakesGateOrFindingLabelLines(
      lineWithoutInactiveRequiredFlags
    );
    for (const labelValue of labelValues) {
      if (labelValue.value.length === 0) {
        if (!isNoMistakesExternalStateContainerLabel(labelValue.label)) {
          pendingSection = true;
        }
        continue;
      }
      if (
        isNoMistakesExternalStateContainerLabel(labelValue.label) &&
        isNoMistakesOpenContainerValue(labelValue.value)
      ) {
        continue;
      }
      const jsonValue = parseNoMistakesJsonValue(labelValue.value);
      if (jsonValue.ok) {
        if (
          isNoMistakesExternalStateContainerLabel(labelValue.label) &&
          isNoMistakesJsonContainerValue(jsonValue.value)
        ) {
          if (jsonValueHasActiveNoMistakesGateOrFinding(jsonValue.value)) {
            return true;
          }
          continue;
        }
        if (isActiveNoMistakesJsonValue(jsonValue.value)) return true;
        continue;
      }
      if (isActiveNoMistakesValue(labelValue.value)) return true;
    }
  }
  return false;
}

function jsonObjectHasActiveNoMistakesGateOrFinding(
  object: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(object)) {
    if (isNoMistakesGateOrFindingLabel(key)) {
      if (
        isNoMistakesExternalStateContainerLabel(key) &&
        isNoMistakesJsonContainerValue(value)
      ) {
        if (jsonValueHasActiveNoMistakesGateOrFinding(value)) return true;
        continue;
      }
      if (isActiveNoMistakesJsonValue(value)) return true;
      continue;
    }
    if (jsonValueHasActiveNoMistakesGateOrFinding(value)) return true;
  }
  return false;
}

function jsonValueHasActiveNoMistakesGateOrFinding(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonValueHasActiveNoMistakesGateOrFinding(item));
  }
  if (value === null || typeof value !== "object") return false;
  return jsonObjectHasActiveNoMistakesGateOrFinding(
    value as Record<string, unknown>
  );
}

function jsonObjectHasActiveNoMistakesGateMarkerValue(
  object: Record<string, unknown>
): boolean {
  return Object.entries(object).some(([key, value]) => {
    if (isNoMistakesRequiredGateFlagLabel(key)) return false;
    if (isNoMistakesJsonGateMarkerTextLabel(key)) {
      return hasActiveNoMistakesGateMarkerValue(value);
    }
    if (
      isNoMistakesJsonStatusTraversalContainerLabel(key) &&
      isNoMistakesJsonContainerValue(value)
    ) {
      return hasActiveNoMistakesGateMarkerValue(value);
    }
    return false;
  });
}

function isNoMistakesJsonGateMarkerTextLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NO_MISTAKES_JSON_GATE_MARKER_TEXT_LABELS.has(normalized);
}

const NO_MISTAKES_JSON_GATE_MARKER_TEXT_LABELS = new Set([
  "message",
  "messages",
  "reason",
  "reasons",
  "status",
  "stepstatus",
  "classification",
  "gate",
  "gates",
  "humangate",
  "recoverycode"
]);

function isNoMistakesIdentityOnlyLabelLine(line: string): boolean {
  const fields = splitNoMistakesTopLevelFields(line);
  return (
    fields.length > 0 &&
    fields.every((field) => {
      const match = /^\s*["']?(?<label>[a-z0-9][a-z0-9 _-]*)["']?\s*(?::|=>|=)\s*/.exec(
        field
      );
      return (
        match !== null &&
        isNoMistakesIdentityLabel(match.groups?.label ?? "")
      );
    })
  );
}

function isNoMistakesIdentityLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return NO_MISTAKES_IDENTITY_LABELS.has(normalized);
}

const NO_MISTAKES_IDENTITY_LABELS = new Set([
  "branch",
  "branchname",
  "headref",
  "headrefname",
  "baseref",
  "baserefname",
  "prurl",
  "pullrequesturl",
  "url",
  "htmlurl"
]);

function hasActiveNoMistakesGateMarkerValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasActiveNoMistakesGateMarkerValue(item));
  }
  if (value !== null && typeof value === "object") {
    return jsonObjectHasActiveNoMistakesGateMarkerValue(
      value as Record<string, unknown>
    );
  }
  if (typeof value !== "string") return false;
  return hasActiveNoMistakesGateMarkerText(value);
}

function hasActiveNoMistakesGateMarkerText(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[:=]+/g, " ")
    .replace(
      /\b(?:no|without|not)\s+(?:operator\s+decision|decision|approval|human\s+gate)\s+(?:is\s+)?required\b/g,
      " "
    )
    .replace(
      /\b(?:no|without|not)\s+(?:manual\s+recovery|external\s+state)\s+(?:is\s+)?required\b/g,
      " "
    )
    .replace(
      /\b(?:operator\s+decision|decision|approval|human\s+gate)\s+(?:is\s+)?(?:not|isn't|isnt|wasn't|wasnt)\s+required\b/g,
      " "
    )
    .replace(
      /\b(?:manual\s+recovery|external\s+state)\s+(?:is\s+)?(?:not|isn't|isnt|wasn't|wasnt)\s+required\b/g,
      " "
    )
    .replace(
      /\b(?:not|no|without)\s+awaiting\s+(?:operator\s+)?decision\b/g,
      " "
    )
    .replace(
      /\b(?:not|no|without)\s+(?:awaiting|waiting\s+(?:for|on))\s+approval\b/g,
      " "
    )
    .replace(
      /\b(?:does\s+not|doesn't|doesnt|not|no|never)\s+requires?\s+(?:an?\s+)?approval\b/g,
      " "
    )
    .replace(
      /\b(?:does\s+not|doesn't|doesnt|not|no|never)\s+requires?\s+(?:an?\s+)?(?:manual\s+recovery|external\s+state|human\s+gate)\b/g,
      " "
    );
  return (
    /\boperator[_ -]?decision[_ -]?required\b/.test(normalized) ||
    /\boperator\s+decision\s+(?:is\s+)?required\b/.test(normalized) ||
    /\bmanual[_ -]?recovery[_ -]?required\b/.test(normalized) ||
    /\bmanual\s+recovery\s+(?:is\s+)?required\b/.test(normalized) ||
    /\brequires\s+(?:an?\s+)?manual\s+recovery\b/.test(normalized) ||
    /\bexternal[_ -]?state[_ -]?required\b/.test(normalized) ||
    /\bexternal\s+state\s+(?:is\s+)?required\b/.test(normalized) ||
    /\brequires\s+(?:an?\s+)?external\s+state\b/.test(normalized) ||
    /\bhuman[_ -]?gate[_ -]?required\b/.test(normalized) ||
    /\bhuman\s+gate\s+(?:is\s+)?required\b/.test(normalized) ||
    /\brequires\s+(?:an?\s+)?human\s+gate\b/.test(normalized) ||
    /\bapproval[_ -]?required\b/.test(normalized) ||
    /\bapproval\s+(?:is\s+)?required\b/.test(normalized) ||
    /\brequires\s+(?:an?\s+)?approval\b/.test(normalized) ||
    /\b(?:awaiting|waiting\s+(?:for|on))\s+approval\b/.test(normalized) ||
    /\brequires\s+(?:an?\s+)?(?:operator\s+)?decision\b/.test(normalized) ||
    /\bdecision[_ -]?required\b/.test(normalized) ||
    /\bdecision\s+(?:is\s+)?required\b/.test(normalized) ||
    /\bawaiting[_ -]?(?:operator[_ -]?)?decision\b/.test(normalized) ||
    /\bawaiting\s+(?:operator\s+)?decision\b/.test(normalized)
  );
}

function isNoMistakesGateOrFindingLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[ _-]+/g, "-");
  return (
    normalized === "gate" ||
    normalized === "gates" ||
    normalized === "human-gate" ||
    normalized === "humangate" ||
    normalized === "operator-decision" ||
    normalized === "operatordecision" ||
    normalized === "approval" ||
    normalized === "manual-recovery" ||
    normalized === "manualrecovery" ||
    normalized === "external-state" ||
    normalized === "externalstate" ||
    normalized === "decision" ||
    normalized === "decisions" ||
    normalized === "finding" ||
    normalized === "findings" ||
    normalized === "selected-finding-ids" ||
    normalized === "selectedfindingids"
  );
}

function isNoMistakesExternalStateContainerLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[ _-]+/g, "");
  return normalized === "externalstate";
}

function isNoMistakesJsonContainerValue(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function isNoMistakesOpenContainerValue(value: string): boolean {
  return /^(?:\{|\[)$/.test(value.trim());
}

function parseNoMistakesGateOrFindingLabelLine(
  line: string
): { label: string; value: string } | null {
  const match = /^(?<left>.*?)\s*(?::|=>|=)\s*(?<value>.*?)\s*,?$/.exec(
    line
  );
  if (match === null) return null;
  const left = (match.groups?.left ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  const words = left
    .replace(/[ _-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const labelStart = words.findIndex((_, index) => {
    const scope = normalizeNoMistakesStatusScope(
      words.slice(0, index).join(" ")
    );
    const label = words.slice(index).join(" ");
    return (
      isNoMistakesStatusScope(scope) && isNoMistakesGateOrFindingLabel(label)
    );
  });
  if (labelStart < 0) return null;
  return {
    label: words.slice(labelStart).join(" "),
    value: match.groups?.value ?? ""
  };
}

function parseNoMistakesGateOrFindingLabelLines(
  line: string
): Array<{ label: string; value: string }> {
  const parsedWholeLine = parseNoMistakesGateOrFindingLabelLine(line);
  const parsedFields = splitNoMistakesTopLevelFields(line)
    .map((field) => parseNoMistakesGateOrFindingLabelLine(field))
    .filter((value): value is { label: string; value: string } => value !== null);
  if (parsedWholeLine === null) return parsedFields;
  if (parsedFields.length === 0) return [parsedWholeLine];
  const wholeValueContainsNestedField = parsedFields.some(
    (field) => field.value !== parsedWholeLine.value
  );
  return wholeValueContainsNestedField ? parsedFields : [parsedWholeLine];
}

function splitNoMistakesTopLevelFields(line: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (char === "," || char === ";")) {
      const field = line.slice(start, index).trim();
      if (field.length > 0) fields.push(field);
      start = index + 1;
    }
  }
  const field = line.slice(start).trim();
  if (field.length > 0) fields.push(field);
  return fields;
}

function parseNoMistakesYamlListItem(line: string): string | null {
  const match = /^[-*]\s+(.*)$/.exec(line);
  if (match === null) return null;
  return match[1] ?? "";
}

type NoMistakesRequiredGateFlag = "active" | "inactive";

function classifyNoMistakesJsonRequiredGateFlags(
  object: Record<string, unknown>
): NoMistakesRequiredGateFlag[] {
  const flags: NoMistakesRequiredGateFlag[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (isNoMistakesRequiredGateFlagLabel(key)) {
      flags.push(classifyNoMistakesRequiredGateFlagValue(value));
      continue;
    }
    flags.push(...classifyNoMistakesJsonRequiredGateFlagValues(value));
  }
  return flags;
}

function classifyNoMistakesJsonRequiredGateFlagValues(
  value: unknown
): NoMistakesRequiredGateFlag[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      classifyNoMistakesJsonRequiredGateFlagValues(item)
    );
  }
  if (value === null || typeof value !== "object") return [];
  return classifyNoMistakesJsonRequiredGateFlags(
    value as Record<string, unknown>
  );
}

function classifyNoMistakesRequiredGateFlagLine(
  line: string
): NoMistakesRequiredGateFlag | null {
  const match = /["']?([a-z][a-z0-9 _-]*required)["']?\s*(?::|=>|=|\s+)\s*["']?([a-z0-9_-]+)["']?\s*[,!.}]?$/.exec(
    line
  );
  if (match === null) return null;
  if (!isNoMistakesRequiredGateFlagLabel(match[1] ?? "")) return null;
  return classifyNoMistakesRequiredGateFlagValue(match[2] ?? "");
}

function stripInactiveNoMistakesRequiredGateFlagEvidence(line: string): string {
  return line.replace(
    /(?:^|[;,]\s*)["']?[a-z][a-z0-9 _-]*required["']?\s*(?::|=>|=|\s+)\s*["']?(?:false|no|0|null|none|n\/a|not-required)["']?\s*[,!.}]?/g,
    " "
  );
}

function isNoMistakesRequiredGateFlagLabel(value: string): boolean {
  const normalized = value.trim().replace(/[^a-z0-9]+/g, "");
  return REQUIRED_NO_MISTAKES_GATE_FLAG_LABELS.has(normalized);
}

const REQUIRED_NO_MISTAKES_GATE_FLAG_LABELS = new Set([
  "operatordecisionrequired",
  "approvalrequired",
  "manualrecoveryrequired",
  "externalstaterequired",
  "humangaterequired",
  "decisionrequired"
]);

function classifyNoMistakesRequiredGateFlagValue(
  value: unknown
): NoMistakesRequiredGateFlag {
  if (value === false || value === null || value === 0) return "inactive";
  if (value === true) return "active";
  if (typeof value === "number") return value === 0 ? "inactive" : "active";
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/[ _-]+/g, "-");
    if (/^(?:false|no|0|null|none|n\/a|not-required)$/.test(normalized)) {
      return "inactive";
    }
  }
  return "active";
}

function isActiveNoMistakesJsonValue(value: unknown): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.some((item) => item === null || isActiveNoMistakesJsonValue(item))
    );
  }
  if (typeof value === "string") return isActiveNoMistakesValue(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const resolution = classifyNoMistakesJsonObjectResolution(object);
    if (resolution === "resolved") return false;
    if (resolution === "active") return true;
    const values = Object.values(object);
    return values.length === 0 || values.some((item) => isActiveNoMistakesJsonValue(item));
  }
  return true;
}

function classifyNoMistakesJsonObjectResolution(
  object: Record<string, unknown>
): "resolved" | "active" | null {
  let hasResolvedMarker = false;
  let hasEmptyResolutionMarker = false;
  for (const [key, value] of Object.entries(object)) {
    const normalizedKey = key.trim().replace(/[ _-]+/g, "-");
    if (normalizedKey === "resolved") {
      if (value === true) {
        hasResolvedMarker = true;
        continue;
      }
      if (value === false) return "active";
      if (value === null) return "active";
      if (typeof value === "string") {
        const normalizedValue = value.trim().replace(/[ _-]+/g, "-");
        if (
          /^(?:true|yes|1|resolved|closed|complete|completed|done|dismissed)$/.test(
            normalizedValue
          )
        ) {
          hasResolvedMarker = true;
          continue;
        }
        return "active";
      }
    }
    if (
      !(
        normalizedKey === "status" ||
        normalizedKey === "state" ||
        normalizedKey === "outcome" ||
        normalizedKey === "resolution" ||
        normalizedKey === "decision-status" ||
        normalizedKey === "finding-status"
      )
    ) {
      continue;
    }
    if (value === null) {
      hasEmptyResolutionMarker = true;
      continue;
    }
    if (typeof value !== "string") continue;
    const normalizedValue = value.trim().replace(/[ _-]+/g, "-");
    if (normalizedKey === "resolution" && normalizedValue.length > 0) {
      hasResolvedMarker = true;
      continue;
    }
    if (/^(?:resolved|closed|complete|completed|done|dismissed)$/.test(normalizedValue)) {
      hasResolvedMarker = true;
      continue;
    }
    if (normalizedValue.length === 0) {
      hasEmptyResolutionMarker = true;
      continue;
    }
    if (!isInactiveNoMistakesStandaloneValue(normalizedValue)) {
      return "active";
    }
  }
  if (hasResolvedMarker) return "resolved";
  if (hasEmptyResolutionMarker) return "active";
  return null;
}

function isActiveNoMistakesValue(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/,$/, "")
    .replace(/^["']|["']$/g, "");
  if (isInactiveNoMistakesStandaloneValue(trimmed)) {
    return false;
  }
  if (/^(?:no|zero) (?:active )?(?:gates?|findings?|decisions?)$/.test(trimmed)) {
    return false;
  }
  return !/^(?:empty array|all resolved|resolved decisions?)$/.test(trimmed);
}

function isInactiveNoMistakesStandaloneValue(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/,$/, "")
    .replace(/^["']|["']$/g, "");
  return (
    trimmed.length === 0 ||
    /^(?:\[\s*\]|\{\s*\}|none|null|false|0|no|not|not[ _-]required|empty|n\/a|resolved)$/.test(
      trimmed
    ) ||
    /^(?:no|not|without)\s+(?:operator[ _-]?decision|decision|approval|human[ _-]?gate|manual[ _-]?recovery|external[ _-]?state)\s+(?:is\s+)?required$/.test(
      trimmed
    )
  );
}

function isCleanPullRequestEvidenceLine(line: string): boolean {
  if (isHistoricalNoMistakesEvidenceLine(line)) return false;
  line = stripNoMistakesHistoricalAnnotationSegments(line);
  if (lineHasExplicitNegativeEvidenceValue(line, ["clean"])) return false;
  if (lineHasTrailingEvidenceValue(line, ["clean"], ["false", "no", "0"])) {
    return false;
  }
  if (
    lineHasCopularEvidenceValue(line, ["clean"], [
      "false",
      "no",
      "0",
      "unknown",
      "pending"
    ])
  ) {
    return false;
  }
  if (lineHasExplicitNonPositiveEvidenceValue(line, ["clean"])) return false;
  if (
    lineHasTrailingEvidenceValue(line, ["clean"], [
      "false",
      "no",
      "0",
      "unknown",
      "pending"
    ])
  ) {
    return false;
  }
  if (
    /\b(?:not|isn't|isnt|wasn't|wasnt|can't|cant|cannot|never)\b[^\n]*\bclean\b/.test(
      line
    )
  ) {
    return false;
  }
  if (/\b(?:unclean|dirty|conflicts?|blocked)\b/.test(line)) {
    return false;
  }
  return (
    /\bmergestate(status)?["'`: =-]*clean\b/.test(line) ||
    /\bmerge[_ -]?state(?:[_ -]?status)?["'`: =-]*clean\b/.test(line) ||
    /\bmergeable[_ -]?state["'`: =-]*clean\b/.test(line) ||
    /\bmergeable\/clean\b/.test(line) ||
    (/\b(pr|pull request)\b/.test(line) && /\bclean\b/.test(line))
  );
}

const CHECKS_NEGATION_TOKENS =
  "not|isn't|isnt|wasn't|wasnt|hasn't|hasnt|haven't|havent|can't|cant|cannot|never|no";
const CHECKS_POSITIVE_TOKENS = "passed|successful|succeeded|green";
const CHECKS_NEGATIVE_STATE_TOKENS =
  "failed|failure|failing|red|unsuccessful|cancelled|canceled|timed out|timeout|pending|running|in[ -]?progress|queued|waiting|awaiting|blocked|gated|skipped|neutral|unknown|action[_ -]?required";
const CHECKS_NEGATED_BEFORE_SUBJECT_PATTERN = new RegExp(
  `\\b(?:${CHECKS_NEGATION_TOKENS})\\b[^\\n]*\\b(?:checks?|ci)\\b[^\\n]*\\b(?:${CHECKS_POSITIVE_TOKENS})\\b`
);
const CHECKS_NEGATED_AFTER_SUBJECT_PATTERN = new RegExp(
  `\\b(?:checks?|ci)\\b[^\\n]*\\b(?:${CHECKS_NEGATION_TOKENS})\\b[^\\n]*\\b(?:${CHECKS_POSITIVE_TOKENS})\\b`
);
const CHECKS_NEGATIVE_BEFORE_SUBJECT_PATTERN = new RegExp(
  `\\b(?:${CHECKS_NEGATIVE_STATE_TOKENS})\\b[^\\n]*\\b(?:checks?|ci)\\b`
);

function isGreenChecksEvidenceLine(line: string): boolean {
  if (isHistoricalNoMistakesEvidenceLine(line)) return false;
  line = stripNoMistakesHistoricalAnnotationSegments(line);
  if (
    lineHasExplicitNegativeEvidenceValue(line, [
      "passed",
      "successful",
      "succeeded",
      "green",
      "reported"
    ])
  ) {
    return false;
  }
  if (lineHasExplicitNonPositiveCheckSuccessValue(line)) {
    return false;
  }
  if (
    lineHasTrailingEvidenceValue(
      line,
      ["passed", "successful", "succeeded", "green", "reported"],
      ["false", "no", "0"]
    )
  ) {
    return false;
  }
  if (
    lineHasCopularEvidenceValue(
      line,
      ["passed", "successful", "succeeded", "green", "reported"],
      [
        "false",
        "no",
        "0",
        "unknown",
        "pending",
        "skipped",
        "neutral",
        "action_required",
        "action-required"
      ]
    )
  ) {
    return false;
  }
  if (
    CHECKS_NEGATED_BEFORE_SUBJECT_PATTERN.test(line) ||
    CHECKS_NEGATED_AFTER_SUBJECT_PATTERN.test(line)
  ) {
    return false;
  }
  if (
    /\b(?:checks?|ci)\b[^\n]*\b(?:not|failed|failure|failing|red|unsuccessful|cancelled|canceled|timed out|timeout|pending|running|awaiting|skipped|neutral|unknown|action[_ -]?required)\b/.test(
      line
    )
  ) {
    return false;
  }
  return (
    isNoChecksReportedEvidenceLine(line) ||
    lineHasNoMistakesCiStateValue(line, ["passed", "none"]) ||
    /\bchecks?\s+(passed|successful|succeeded|green)\b/.test(line) ||
    /\b(all|github|ci)\b[^\n]*\bchecks?\b[^\n]*\b(passed|successful|succeeded|green)\b/.test(
      line
    ) ||
    /\bci\b[^\n]*\b(passed|successful|succeeded|green)\b/.test(line)
  );
}

function isNoChecksReportedEvidenceLine(line: string): boolean {
  return /\bno checks reported\s*(?:(?::|=>|=)\s*["']?(?:true|yes|1)["']?)?\s*[.!]?$/.test(
    line
  );
}

function isHistoricalNoMistakesEvidenceLine(line: string): boolean {
  const normalized = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
  if (/^(?:current|now|latest|live)\b/.test(normalized)) return false;
  return /\b(?:previous|previously|historical|stale|prior|past)\b/.test(line);
}

function isHistoricalNoMistakesEvidenceOnlyLine(line: string): boolean {
  const normalized = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
  return (
    /^(?:previous|previously|historical|stale|prior|past)\b/.test(normalized) &&
    !/\b(?:current|now|latest|live)\b/.test(normalized)
  );
}

function stripNoMistakesHistoricalAnnotationSegments(line: string): string {
  return line.replace(
    /\s*[\[(][^\])]*(?:previous|previously|historical|stale|prior|past)[^\])]*[\])]/g,
    ""
  );
}

function lineHasNoMistakesCiStateValue(
  line: string,
  values: readonly string[]
): boolean {
  return new RegExp(
    `\\bci[_ -]?state\\b["']?\\s*(?::|=>|=)?\\s*["']?(?:${values.join("|")})\\b`
  ).test(line);
}

function lineHasNonSuccessNoMistakesCiStateValue(line: string): boolean {
  const matches = line.matchAll(
    /\bci[_ -]?state\b["']?\s*(?:(?::|=>|=)\s*)?["']?([a-z0-9_-]+)\b/g
  );
  return Array.from(matches).some(
    (match) => !/^(?:passed|none)$/.test(match[1] ?? "")
  );
}

function lineHasNonSuccessCheckConclusionValue(line: string): boolean {
  const matches = line.matchAll(
    /(?:^|[,{;]\s*)(?:(?:current|latest|run|state)\s+)?["']?(?:check[_ -]?conclusion|conclusion)["']?\s*(?::|=>|=)\s*["']?([a-z0-9_-]+)\b/g
  );
  return Array.from(matches).some(
    (match) =>
      !/^(?:success|successful|passed|passing|green)$/.test(match[1] ?? "")
  );
}

function lineHasExplicitNonPositiveCheckSuccessValue(line: string): boolean {
  if (!/\b(?:checks?|ci)\b/.test(line)) return false;
  const matches = line.matchAll(
    /\b(?:passed|successful|succeeded|green)\b["']?\s*(?::|=>|=)\s*["']?([a-z0-9_-]+)\b/g
  );
  return Array.from(matches).some(
    (match) =>
      !/^(?:true|yes|1|passed|successful|succeeded|green|success)$/.test(
        match[1] ?? ""
      )
  );
}

function lineHasExplicitNegativeEvidenceValue(
  line: string,
  evidenceTerms: readonly string[]
): boolean {
  return new RegExp(
    `\\b(?:${evidenceTerms.join("|")})\\b["']?\\s*(?::|=>|=)\\s*["']?(?:false|no|0)\\b`
  ).test(line);
}

function lineHasExplicitNonPositiveEvidenceValue(
  line: string,
  evidenceTerms: readonly string[]
): boolean {
  const matches = line.matchAll(
    new RegExp(
      `\\b(?:${evidenceTerms.join("|")})\\b["']?\\s*(?::|=>|=)\\s*["']?([a-z0-9_-]+)\\b`,
      "g"
    )
  );
  return Array.from(matches).some(
    (match) => !/^(?:true|yes|1|clean)$/.test(match[1] ?? "")
  );
}

function lineHasTrailingEvidenceValue(
  line: string,
  evidenceTerms: readonly string[],
  values: readonly string[]
): boolean {
  return new RegExp(
    `\\b(?:${evidenceTerms.join("|")})\\b\\s+["']?(?:${values.join("|")})["']?\\s*[,!.]?$`
  ).test(line);
}

function lineHasCopularEvidenceValue(
  line: string,
  evidenceTerms: readonly string[],
  values: readonly string[]
): boolean {
  return new RegExp(
    `\\b(?:${evidenceTerms.join("|")})\\b\\s+(?:is|are|was|were)\\s+["']?(?:${values.join("|")})["']?\\s*[,!.]?$`
  ).test(line);
}

function lineHasDraftPullRequestEvidence(line: string): boolean {
  if (
    /\bis[_ -]?draft\b["']?\s*(?::|=>|=|\s+)\s*["']?(?:true|yes|1|draft)\b/.test(
      line
    )
  ) {
    return true;
  }
  if (
    /(?:^|[,{;]\s*)(?:(?:current|latest|pr|pull request)\s+)?["']?draft["']?\s*(?::|=>|=)\s*["']?(?:true|yes|1)\b/.test(
      line
    )
  ) {
    return true;
  }
  if (!/\b(?:pr|pull request)\b/.test(line)) return false;
  if (
    /\bdraft\b\s*(?::|=>|=)\s*["']?(?:true|yes|1)\b/.test(line)
  ) {
    return true;
  }
  if (/\b(?:not|isn't|isnt|wasn't|wasnt|no|non)\b[^\n]*\bdraft\b/.test(line)) {
    return false;
  }
  if (
    /\bdraft\b[^\n]*(?::|=>|=|\bis\b|\bwas\b)\s*["']?(?:false|no|0)\b/.test(
      line
    )
  ) {
    return false;
  }
  return /\bdraft\b/.test(line);
}

function lineHasNonMergeableEvidenceValue(line: string): boolean {
  const matches = line.matchAll(
    /\bmergeable\b(?![_ -]?state\b)["']?\s*(?:(?::|=>|=)\s*|\s+)["']?([a-z0-9_-]+)\b/g
  );
  return Array.from(matches).some(
    (match) => !/^(?:true|yes|1|mergeable|clean)$/.test(match[1] ?? "")
  );
}

type ConfigLoadResult =
  | { ok: true; config: CodingWorkflowWrapperConfig }
  | { ok: false; error: string };

function processSetupFailure(
  deps: Pick<CodingWorkflowWrapperDeps, "stderr">,
  summary: string
): CodingWorkflowWrapperOutcome {
  deps.stderr(`${CODING_WORKFLOW_WRAPPER_RECOVERY_MARKER}\n`);
  deps.stderr(`${summary}\n`);
  return {
    exitCode: 1,
    success: false,
    summary
  };
}

export function loadCodingWorkflowWrapperConfig(
  deps: Pick<CodingWorkflowWrapperDeps, "env" | "readFile">
): ConfigLoadResult {
  const configPath = deps.env[CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]?.trim();
  if (configPath === undefined || configPath.length === 0) {
    return { ok: true, config: { steps: {} } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFile(configPath));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not read coding workflow wrapper config ${configPath}: ${detail}`
    };
  }

  return parseCodingWorkflowWrapperConfig(parsed);
}

export function parseCodingWorkflowWrapperConfig(
  value: unknown
): ConfigLoadResult {
  if (!isRecord(value)) {
    return { ok: false, error: "Coding workflow wrapper config must be an object." };
  }

  const rawSteps = value["steps"];
  if (rawSteps !== undefined && !isRecord(rawSteps)) {
    return { ok: false, error: "Coding workflow wrapper config `steps` must be an object." };
  }

  const steps: Partial<Record<WorkflowStepKind, CodingWorkflowWrapperStepConfig>> = {};
  if (isRecord(rawSteps)) {
    for (const [kind, rawStep] of Object.entries(rawSteps)) {
      if (!WORKFLOW_STEP_KIND_SET.has(kind)) {
        return {
          ok: false,
          error: `Unsupported workflow step kind in wrapper config: ${kind}`
        };
      }
      const parsedStep = parseStepConfig(kind as WorkflowStepKind, rawStep);
      if (!parsedStep.ok) return parsedStep;
      steps[kind as WorkflowStepKind] = parsedStep.config;
    }
  }

  return { ok: true, config: { steps } };
}

type StepConfigParse =
  | { ok: true; config: CodingWorkflowWrapperStepConfig }
  | { ok: false; error: string };

function parseStepConfig(
  kind: WorkflowStepKind,
  value: unknown
): StepConfigParse {
  if (!isRecord(value)) {
    return { ok: false, error: `Wrapper config for ${kind} must be an object.` };
  }

  const command = readOptionalString(value["command"]);
  const args = readOptionalStringArray(value["args"], "args");
  if (!args.ok) return args;
  const cwd = readCwd(value["cwd"]);
  if (!cwd.ok) return cwd;
  const timeoutSec = readPositiveInteger(value["timeout_sec"], DEFAULT_TIMEOUT_SEC);
  if (!timeoutSec.ok) return timeoutSec;
  const envAllow = readOptionalStringArray(value["env_allow"], "env_allow");
  if (!envAllow.ok) return envAllow;
  const commit = readCommit(value["commit"], kind);
  if (!commit.ok) return commit;

  const keyChangesMade = readOptionalStringArray(
    value["key_changes_made"],
    "key_changes_made"
  );
  if (!keyChangesMade.ok) return keyChangesMade;
  const keyLearnings = readOptionalStringArray(
    value["key_learnings"],
    "key_learnings"
  );
  if (!keyLearnings.ok) return keyLearnings;
  const remainingWork = readOptionalStringArray(
    value["remaining_work"],
    "remaining_work"
  );
  if (!remainingWork.ok) return remainingWork;
  const successSummary = readOptionalString(value["success_summary"]);
  const failureSummary = readOptionalString(value["failure_summary"]);

  return {
    ok: true,
    config: {
      ...(command !== undefined ? { command } : {}),
      args: args.value,
      cwd: cwd.value,
      timeoutSec: timeoutSec.value,
      envAllow: envAllow.value,
      ...(successSummary !== undefined ? { successSummary } : {}),
      ...(failureSummary !== undefined ? { failureSummary } : {}),
      keyChangesMade: keyChangesMade.value,
      keyLearnings: keyLearnings.value,
      remainingWork: remainingWork.value,
      commit: commit.value
    }
  };
}

function writeFailureResult(
  deps: CodingWorkflowWrapperDeps,
  resultPath: string,
  summary: string,
  kind: WorkflowStepKind = "preflight",
  config?: CodingWorkflowWrapperStepConfig
): CodingWorkflowWrapperOutcome {
  return writeRunnerResult(deps, resultPath, {
    success: false,
    summary,
    key_changes_made: [],
    key_learnings: [],
    remaining_work: [summary],
    goal_complete: false,
    commit: config?.commit ?? defaultCommit(kind)
  });
}

function writeRunnerResult(
  deps: Pick<CodingWorkflowWrapperDeps, "mkdir" | "writeFile">,
  resultPath: string,
  result: RunnerResult
): CodingWorkflowWrapperOutcome {
  const normalized = normalizeRunnerResult(result);
  if (!normalized.ok) {
    return {
      exitCode: 1,
      success: false,
      summary: normalized.error,
      resultPath
    };
  }

  deps.mkdir(path.dirname(resultPath));
  deps.writeFile(resultPath, `${JSON.stringify(normalized.value, null, 2)}\n`);
  return {
    exitCode: 0,
    success: normalized.value.success,
    summary: normalized.value.summary,
    resultPath
  };
}

function summarizeCommandResult(
  kind: WorkflowStepKind,
  config: CodingWorkflowWrapperStepConfig,
  result: SpawnSyncReturns<string>,
  success: boolean
): string {
  if (success) {
    return config.successSummary ?? `${kind} command completed successfully.`;
  }
  if (config.failureSummary !== undefined) return config.failureSummary;
  if (result.error !== undefined) {
    return `${kind} command could not run: ${result.error.message}`;
  }
  if (result.signal !== null) {
    return `${kind} command terminated by signal ${result.signal}.`;
  }
  return `${kind} command exited with code ${result.status ?? "unknown"}.`;
}

function resolveStepCwd(
  cwd: CodingWorkflowWrapperCwd,
  env: NodeJS.ProcessEnv
): { ok: true; path: string } | { ok: false; error: string } {
  if (cwd === "repo") {
    const repoPath = readRequiredEnv(env, "MOMENTUM_REPO_PATH");
    if (repoPath === undefined) {
      return { ok: false, error: "MOMENTUM_REPO_PATH is required for cwd=repo." };
    }
    return { ok: true, path: repoPath };
  }
  const iterationDir = readRequiredEnv(env, "MOMENTUM_ITERATION_DIR");
  if (iterationDir === undefined) {
    return {
      ok: false,
      error: "MOMENTUM_ITERATION_DIR is required for cwd=iteration."
    };
  }
  return { ok: true, path: iterationDir };
}

function buildChildEnv(
  env: NodeJS.ProcessEnv,
  envAllow: readonly string[]
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of envAllow) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const key of CODING_WORKFLOW_WRAPPER_ENV_VARS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

function readWorkflowStepKind(value: string | undefined): WorkflowStepKind | undefined {
  if (value === undefined || !WORKFLOW_STEP_KIND_SET.has(value)) return undefined;
  return value as WorkflowStepKind;
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type StringArrayParse =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

function readOptionalStringArray(value: unknown, field: string): StringArrayParse {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: `Wrapper config \`${field}\` must be an array.` };
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `Wrapper config \`${field}\` must contain only strings.`
      };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function readCwd(
  value: unknown
): { ok: true; value: CodingWorkflowWrapperCwd } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: "repo" };
  if (value === "repo" || value === "iteration") return { ok: true, value };
  return {
    ok: false,
    error: "Wrapper config `cwd` must be either `repo` or `iteration`."
  };
}

function readPositiveInteger(
  value: unknown,
  fallback: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    return { ok: true, value };
  }
  return { ok: false, error: "Wrapper config `timeout_sec` must be a positive integer." };
}

type CommitParse =
  | { ok: true; value: CommitIntent }
  | { ok: false; error: string };

function readCommit(value: unknown, kind: WorkflowStepKind): CommitParse {
  if (value === undefined || value === null) {
    return { ok: true, value: defaultCommit(kind) };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Wrapper config `commit` must be an object." };
  }
  const commit = {
    type: readOptionalString(value["type"]) ?? defaultCommit(kind).type,
    scope: readOptionalString(value["scope"]),
    subject: readOptionalString(value["subject"]) ?? defaultCommit(kind).subject,
    body: readOptionalString(value["body"]) ?? "",
    breaking: typeof value["breaking"] === "boolean" ? value["breaking"] : false
  };
  const normalized = normalizeRunnerResult({
    success: true,
    summary: "commit validation",
    key_changes_made: [],
    key_learnings: [],
    remaining_work: [],
    goal_complete: false,
    commit
  });
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return { ok: true, value: normalized.value.commit };
}

function defaultCommit(kind: WorkflowStepKind): CommitIntent {
  return {
    type: defaultCommitType(kind),
    scope: undefined,
    subject: `complete ${kind}`,
    body: "",
    breaking: false
  };
}

function defaultCommitType(kind: WorkflowStepKind): CommitType {
  switch (kind) {
    case "preflight":
    case "postflight":
    case "no-mistakes":
      return "test";
    case "implementation":
      return "chore";
    case "merge-cleanup":
    case "linear-refresh":
      return "chore";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
