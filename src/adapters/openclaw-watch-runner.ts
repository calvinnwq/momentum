import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  policyForWorkflowWatchRecommendedAction,
  WORKFLOW_ACTION_AUTHORITY_CLASSES,
  WORKFLOW_ACTION_RISK_LEVELS,
  fallbackWorkflowActionAuthorityPolicy,
  type WorkflowActionAuthorityPolicy
} from "../core/workflow/monitor/action-authority.js";
import type { OpenClawSupervisorWatchEnvelope } from "../core/openclaw/supervisor.js";

export type OpenClawWatchOnceInput = {
  runId: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
};

export type OpenClawWatchOnce = (
  input: OpenClawWatchOnceInput
) => Promise<OpenClawSupervisorWatchEnvelope>;

export type OpenClawWatchProcessCommand = {
  command: string;
  args: string[];
};

export type BuildOpenClawWatchProcessCommandInput = {
  runId: string;
  dataDir: string;
  nodePath?: string;
  nodeExecArgv?: readonly string[];
  distEntrypoint?: string;
  distExists?: boolean;
  argvEntrypoint?: string | undefined;
  argvEntrypointExists?: boolean;
};

export class OpenClawWatchRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenClawWatchRunnerError";
    this.code = code;
  }
}

export const runOpenClawWorkflowWatchOnce: OpenClawWatchOnce = async (
  input
) => {
  const stdout = await runMomentumWatchProcess(input);
  return parseOpenClawWatchOutput(stdout, input.runId);
};

export function parseOpenClawWatchOutput(
  stdout: string,
  expectedRunId: string
): OpenClawSupervisorWatchEnvelope {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    throw new OpenClawWatchRunnerError(
      "watch_parse_failed",
      "Momentum watch did not return valid JSON."
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new OpenClawWatchRunnerError(
      "watch_parse_failed",
      "Momentum watch returned a non-object JSON payload."
    );
  }
  const record = payload as Record<string, unknown>;
  if (record["ok"] !== true) {
    const failure = parseOpenClawWatchFailureRecord(record);
    throw new OpenClawWatchRunnerError(
      failure?.code ?? "watch_failed",
      failure?.message ?? "Momentum watch returned a failure envelope."
    );
  }
  const runId = stringValue(record["runId"], "runId");
  if (runId !== expectedRunId) {
    throw new OpenClawWatchRunnerError(
      "watch_run_mismatch",
      "Momentum watch returned a different run id."
    );
  }

  const recommendedAction = stringValue(
    record["recommendedAction"],
    "recommendedAction"
  );

  return {
    ok: true,
    command: "workflow run watch",
    mode: "once",
    runId,
    emit: booleanValue(record["emit"], "emit"),
    reason: stringValue(record["reason"], "reason"),
    recommendedAction,
    recommendedActionPolicy: parseRecommendedActionPolicy(
      record["recommendedActionPolicy"],
      recommendedAction,
      record
    ),
    nextPollSeconds: numberValue(record["nextPollSeconds"], "nextPollSeconds"),
    humanAction: parseHumanAction(record["humanAction"]),
    cleanup: stringValue(record["cleanup"], "cleanup"),
    digest: stringValue(record["digest"], "digest"),
    cursor: nullableString(record["cursor"], "cursor"),
    phase: stringValue(record["phase"], "phase"),
    stuckRisk: stringValue(record["stuckRisk"], "stuckRisk"),
    inspectionCommand: nullableString(
      record["inspectionCommand"],
      "inspectionCommand"
    )
  };
}

function parseRecommendedActionPolicy(
  value: unknown,
  recommendedAction: string,
  source: Record<string, unknown>
): WorkflowActionAuthorityPolicy {
  if (typeof value !== "object" || value === null) {
    return fallbackWorkflowActionAuthorityPolicy(recommendedAction);
  }
  const record = value as Record<string, unknown>;
  const evidenceRequired = record["evidenceRequired"];
  const action = record["action"];
  const authority = record["authority"];
  const risk = record["risk"];
  if (
    typeof action !== "string" ||
    !isWorkflowActionAuthorityClass(authority) ||
    !isWorkflowActionRiskLevel(risk) ||
    !Array.isArray(evidenceRequired) ||
    !evidenceRequired.every((item) => typeof item === "string") ||
    typeof record["rollback"] !== "string" ||
    typeof record["rationale"] !== "string"
  ) {
    return fallbackWorkflowActionAuthorityPolicy(recommendedAction);
  }
  const expected = policyForWorkflowWatchRecommendedAction({
    recommendedAction,
    nextActionCode: nestedString(source["nextAction"], "code"),
    nextActionStepId: nestedString(source["nextAction"], "stepId"),
    recoveryCode: null,
    activeStepKind: nestedString(source["activeStep"], "kind")
  });
  if (
    action !== expected.action ||
    authority !== expected.authority ||
    risk !== expected.risk
  ) {
    return fallbackWorkflowActionAuthorityPolicy(recommendedAction);
  }
  return {
    action,
    authority,
    risk,
    evidenceRequired,
    rollback: record["rollback"],
    rationale: record["rationale"]
  };
}

function nestedString(
  value: unknown,
  key: string
): string | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : null;
}

function isWorkflowActionAuthorityClass(
  value: unknown
): value is WorkflowActionAuthorityPolicy["authority"] {
  return (
    typeof value === "string" &&
    (WORKFLOW_ACTION_AUTHORITY_CLASSES as readonly string[]).includes(value)
  );
}

function isWorkflowActionRiskLevel(
  value: unknown
): value is WorkflowActionAuthorityPolicy["risk"] {
  return (
    typeof value === "string" &&
    (WORKFLOW_ACTION_RISK_LEVELS as readonly string[]).includes(value)
  );
}

async function runMomentumWatchProcess(
  input: OpenClawWatchOnceInput
): Promise<string> {
  const command = buildOpenClawWatchProcessCommand(input);

  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new OpenClawWatchRunnerError(
          "watch_spawn_failed",
          `Unable to start Momentum watch: ${error.message}`
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const failure = parseOpenClawWatchFailureOutput(stderr);
      if (failure !== null) {
        reject(new OpenClawWatchRunnerError(failure.code, failure.message));
        return;
      }
      const detail = stderr.trim().length > 0 ? " with diagnostics" : "";
      reject(
        new OpenClawWatchRunnerError(
          "watch_failed",
          `Momentum watch exited with code ${code ?? "unknown"}${detail}.`
        )
      );
    });
  });
}

export function buildOpenClawWatchProcessCommand(
  input: BuildOpenClawWatchProcessCommandInput
): OpenClawWatchProcessCommand {
  const entrypoint = resolveMomentumEntrypoint(input);
  const args = [
    ...entrypoint.nodeExecArgv,
    entrypoint.file,
    "workflow",
    "run",
    "watch",
    input.runId,
    "--once",
    "--data-dir",
    input.dataDir,
    "--json"
  ];
  return {
    command: input.nodePath ?? process.execPath,
    args
  };
}

export function parseOpenClawWatchFailureOutput(
  stderr: string
): { code: string; message: string } | null {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  return parseOpenClawWatchFailureRecord(payload as Record<string, unknown>);
}

function resolveMomentumEntrypoint(input: {
  nodeExecArgv?: readonly string[];
  distEntrypoint?: string;
  distExists?: boolean;
  argvEntrypoint?: string | undefined;
  argvEntrypointExists?: boolean;
}): { file: string; nodeExecArgv: readonly string[] } {
  const adapterFile = fileURLToPath(import.meta.url);
  const distIndex =
    input.distEntrypoint ??
    path.resolve(path.dirname(adapterFile), "..", "index.js");
  const distExists = input.distExists ?? fs.existsSync(distIndex);
  if (distExists) return { file: distIndex, nodeExecArgv: [] };

  const argvEntrypoint = input.argvEntrypoint ?? process.argv[1];
  const argvEntrypointExists =
    input.argvEntrypointExists ??
    (argvEntrypoint !== undefined && fs.existsSync(argvEntrypoint));
  if (argvEntrypoint && argvEntrypointExists) {
    return {
      file: argvEntrypoint,
      nodeExecArgv: input.nodeExecArgv ?? process.execArgv
    };
  }
  return { file: distIndex, nodeExecArgv: [] };
}

function parseHumanAction(
  value: unknown
): OpenClawSupervisorWatchEnvelope["humanAction"] {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) {
    throw new OpenClawWatchRunnerError(
      "watch_parse_failed",
      "Momentum watch humanAction is invalid."
    );
  }
  const record = value as Record<string, unknown>;
  return {
    code: stringValue(record["code"], "humanAction.code"),
    command: stringValue(record["command"], "humanAction.command"),
    detail: nullableString(record["detail"], "humanAction.detail")
  };
}

function parseOpenClawWatchFailureRecord(
  record: Record<string, unknown>
): { code: string; message: string } | null {
  if (record["ok"] !== false) return null;
  const code = record["code"];
  const message = record["message"];
  if (typeof code !== "string" || code.length === 0) return null;
  if (typeof message !== "string" || message.length === 0) return null;
  return { code, message };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new OpenClawWatchRunnerError(
    "watch_parse_failed",
    `Momentum watch field ${field} is invalid.`
  );
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new OpenClawWatchRunnerError(
    "watch_parse_failed",
    `Momentum watch field ${field} is invalid.`
  );
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new OpenClawWatchRunnerError(
    "watch_parse_failed",
    `Momentum watch field ${field} is invalid.`
  );
}
