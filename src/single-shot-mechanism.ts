import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  runLiveStepWrapper,
  type LiveStepWrapperRecoveryCode
} from "./live-step-wrapper.js";
import type { LiveWrapperConfig } from "./live-wrapper-registry.js";
import type {
  SingleShotArtifactPointer,
  SingleShotRoundArtifacts
} from "./single-shot-executor.js";
import type { SingleShotRecoveryCode } from "./single-shot-executor.js";
import type {
  SingleShotRoundMechanismResult,
  SingleShotRoundRunner
} from "./single-shot-orchestrator.js";
import type { WorkflowStepKind } from "./workflow-run-reducer.js";

export type OneShotLiveWrapperRoundRunnerOptions = {
  repoPath: string;
  kind: WorkflowStepKind;
  promptPath?: string;
  env?: NodeJS.ProcessEnv;
  outputMaxBytes?: number;
};

export type ScriptCommandRoundRunnerConfig = {
  command: string;
  args?: readonly string[];
  cwd: string;
  timeoutSec: number;
  env?: NodeJS.ProcessEnv;
  outputMaxBytes?: number;
};

const DEFAULT_SCRIPT_OUTPUT_MAX_BYTES = LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES;

export function createOneShotLiveWrapperRoundRunner(
  config: LiveWrapperConfig,
  options: OneShotLiveWrapperRoundRunnerOptions
): SingleShotRoundRunner {
  return (round) => {
    if (round.executorFamily !== "one-shot") {
      return invalidInput("one-shot live wrapper runner requires one-shot round");
    }
    const logPath = primaryLogPath(round);
    if (round.artifactRoot === null || logPath === null) {
      return invalidInput(
        "one-shot live wrapper rounds require artifactRoot and a log path"
      );
    }

    const result = runLiveStepWrapper({
      kind: options.kind,
      config,
      runId: round.workflowRunId,
      stepId: round.stepRunId,
      attempt: round.attempt,
      repoPath: options.repoPath,
      iterationDir: round.artifactRoot,
      executorLogPath: logPath,
      ...(options.promptPath !== undefined
        ? { promptPath: options.promptPath }
        : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.outputMaxBytes !== undefined
        ? { outputMaxBytes: options.outputMaxBytes }
        : {})
    });

    if (!result.ok) {
      return {
        outcome: {
          ok: false,
          recoveryCode: liveRecoveryCode(result.code)
        },
        artifacts: artifactPointers(result.resultJsonPath, null)
      };
    }

    const digest = digestFile(result.resultJsonPath);
    const artifacts = artifactPointers(result.resultJsonPath, digest);
    if (result.result.success !== true) {
      return {
        outcome: { ok: false, recoveryCode: "command_failed" },
        artifacts
      };
    }

    return {
      outcome: { ok: true },
      result: result.result,
      ...(digest !== null ? { resultDigest: digest } : {}),
      artifacts
    };
  };
}

export function createScriptCommandRoundRunner(
  config: ScriptCommandRoundRunnerConfig
): SingleShotRoundRunner {
  return (round) => {
    if (round.executorFamily !== "script") {
      return invalidInput("script command runner requires script round");
    }
    const validation = validateScriptCommandConfig(config);
    if (!validation.ok) return invalidInput(validation.error);

    const logPath = primaryLogPath(round);
    if (logPath === null) {
      return invalidInput("script rounds require at least one log path");
    }
    const outputMaxBytes =
      config.outputMaxBytes ?? DEFAULT_SCRIPT_OUTPUT_MAX_BYTES;
    let logHandle: number;
    try {
      ensureParentDir(logPath);
      logHandle = fs.openSync(logPath, "w");
    } catch {
      return invalidInput("script command runner could not open log path");
    }

    try {
      writeLine(logHandle, "[single-shot-script] start");
      writeLine(logHandle, `[single-shot-script] command: ${formatCommand(config)}`);
      writeLine(logHandle, `[single-shot-script] cwd: ${config.cwd}`);
      writeLine(logHandle, `[single-shot-script] timeout_sec: ${config.timeoutSec}`);

      const start = Date.now();
      const spawn = runScriptProcess(config, outputMaxBytes);
      const durationMs = Date.now() - start;

      writeLog(logHandle, "stdout", spawn.stdout);
      writeLog(logHandle, "stderr", spawn.stderr);
      writeLine(logHandle, `[single-shot-script] duration_ms: ${durationMs}`);

      if (errnoCode(spawn.error) === "ENOBUFS") {
        writeLine(logHandle, "[single-shot-script] result: output_overflow");
        return { outcome: { ok: false, recoveryCode: "output_overflow" } };
      }
      if (errnoCode(spawn.error) === "ETIMEDOUT") {
        writeLine(logHandle, "[single-shot-script] result: timed_out");
        return { outcome: { ok: false, recoveryCode: "command_timed_out" } };
      }
      if (spawn.error !== undefined) {
        writeLine(
          logHandle,
          `[single-shot-script] runtime_unavailable: ${spawn.error.message}`
        );
        return { outcome: { ok: false, recoveryCode: "runtime_unavailable" } };
      }

      const exitCode = spawn.status;
      const signal = spawn.signal ?? null;
      writeLine(
        logHandle,
        `[single-shot-script] exit_code: ${exitCode === null ? "null" : String(exitCode)}`
      );
      if (signal !== null) {
        writeLine(logHandle, `[single-shot-script] signal: ${signal}`);
      }

      if (exitCode === null || exitCode !== 0) {
        writeLine(logHandle, "[single-shot-script] result: nonzero_exit");
        return { outcome: { ok: false, recoveryCode: "command_failed" } };
      }

      writeLine(logHandle, "[single-shot-script] done");
      return {
        outcome: { ok: true },
        evidence: { verificationStatus: "passed" }
      };
    } finally {
      fs.closeSync(logHandle);
    }
  };
}

function invalidInput(error: string): SingleShotRoundMechanismResult {
  void error;
  return { outcome: { ok: false, recoveryCode: "invalid_input" } };
}

function liveRecoveryCode(
  code: LiveStepWrapperRecoveryCode
): SingleShotRecoveryCode {
  return code;
}

function artifactPointers(
  resultJsonPath: string | undefined,
  digest: string | null
): SingleShotRoundArtifacts {
  const resultDocument = resultArtifactPointer(resultJsonPath, digest);
  return resultDocument === undefined ? {} : { resultDocument };
}

function resultArtifactPointer(
  resultJsonPath: string | undefined,
  digest: string | null
): SingleShotArtifactPointer | undefined {
  if (resultJsonPath === undefined || !fs.existsSync(resultJsonPath)) {
    return undefined;
  }
  return {
    path: resultJsonPath,
    ...(digest !== null ? { digest } : {})
  };
}

function digestFile(filePath: string): string | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function primaryLogPath(round: { logPaths: readonly string[] }): string | null {
  return round.logPaths[0] ?? null;
}

function validateScriptCommandConfig(
  config: ScriptCommandRoundRunnerConfig
): { ok: true } | { ok: false; error: string } {
  if (typeof config.command !== "string" || !path.isAbsolute(config.command)) {
    return {
      ok: false,
      error: "script command must be an absolute executable path"
    };
  }
  if (!Array.isArray(config.args ?? [])) {
    return { ok: false, error: "script args must be an array" };
  }
  for (const arg of config.args ?? []) {
    if (typeof arg !== "string") {
      return { ok: false, error: "script args must contain only strings" };
    }
  }
  if (typeof config.cwd !== "string" || !path.isAbsolute(config.cwd)) {
    return { ok: false, error: "script cwd must be an absolute path" };
  }
  if (!Number.isInteger(config.timeoutSec) || config.timeoutSec <= 0) {
    return { ok: false, error: "script timeoutSec must be a positive integer" };
  }
  return { ok: true };
}

function runScriptProcess(
  config: ScriptCommandRoundRunnerConfig,
  outputMaxBytes: number
): SpawnSyncReturns<string> {
  return spawnSync(config.command, [...(config.args ?? [])], {
    cwd: config.cwd,
    env: scriptEnv(config),
    timeout: config.timeoutSec * 1000,
    encoding: "utf-8",
    maxBuffer: outputMaxBytes,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function scriptEnv(config: ScriptCommandRoundRunnerConfig): NodeJS.ProcessEnv {
  return config.env ?? {};
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function errnoCode(error: Error | undefined): string | undefined {
  if (error === undefined) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

function formatCommand(config: ScriptCommandRoundRunnerConfig): string {
  const args = config.args ?? [];
  if (args.length === 0) return config.command;
  return `${config.command} ${args.join(" ")}`;
}

function writeLog(
  handle: number,
  label: "stdout" | "stderr",
  chunk: unknown
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[single-shot-script] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}
