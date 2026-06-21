import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { normalizeRunnerResult } from "../executors/runner-result.js";
import type { CommitIntent, CommitType, RunnerResult } from "../executors/types.js";
import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind
} from "./run-reducer.js";

export const CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR =
  "MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG";

export const CODING_WORKFLOW_WRAPPER_ENV_VARS = [
  "MOMENTUM_RUN_ID",
  "MOMENTUM_STEP_ID",
  "MOMENTUM_STEP_KIND",
  "MOMENTUM_ATTEMPT",
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
    spawn: (command, args, options) => spawnSync(command, args, options),
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

  const configLoad = loadCodingWorkflowWrapperConfig(deps);
  if (!configLoad.ok) {
    return writeFailureResult(deps, resultPath, configLoad.error, stepKind);
  }

  const stepConfig = configLoad.config.steps[stepKind];
  if (stepConfig?.command === undefined) {
    return writeFailureResult(
      deps,
      resultPath,
      `No command is configured for workflow step "${stepKind}".`,
      stepKind
    );
  }

  const cwd = resolveStepCwd(stepConfig.cwd, deps.env);
  if (!cwd.ok) {
    return writeFailureResult(deps, resultPath, cwd.error, stepKind, stepConfig);
  }

  const childEnv = buildChildEnv(deps.env, stepConfig.envAllow);
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
  const summary = summarizeCommandResult(stepKind, stepConfig, result, success);
  return writeRunnerResult(deps, resultPath, {
    success,
    summary,
    key_changes_made: success ? stepConfig.keyChangesMade : [],
    key_learnings: stepConfig.keyLearnings,
    remaining_work: success
      ? stepConfig.remainingWork
      : [`Fix ${stepKind} command failure before advancing the workflow.`],
    goal_complete: false,
    commit: stepConfig.commit
  });
}

type ConfigLoadResult =
  | { ok: true; config: CodingWorkflowWrapperConfig }
  | { ok: false; error: string };

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
