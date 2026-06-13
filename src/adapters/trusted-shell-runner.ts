/**
 * Trusted-shell runner introduced by NGX-282 (M4-03).
 *
 * Runs the configured `trusted_shell.command` (with `args`) as an explicitly
 * trusted child process: there is no sandbox, no privilege drop, and the
 * command runs with the privileges of the Momentum invoker. The runner
 * records command/cwd/result metadata in `runner.log`, captures
 * stdout/stderr after the command exits, then reads and parses the
 * normalized `RunnerResult` from the configured result file (relative to the
 * iteration artifact directory).
 *
 * Momentum core still owns the git transaction, verification, and the
 * artifact layout; this module is dispatched from `runner-adapter.ts` and
 * does not touch git or verification.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  RunnerAdapterError,
  RunnerAdapterErrorCode,
  RunnerAdapterInput,
  RunnerAdapterResult
} from "./runner-adapter.js";
import { parseRunnerResult } from "../runner-result.js";
import {
  DEFAULT_TRUSTED_SHELL_RESULT_FILE,
  parseTrustedShellConfig,
  type TrustedShellConfig
} from "../trusted-shell-config.js";

export const TRUSTED_SHELL_ENV_VARS = {
  GOAL_ID: "MOMENTUM_GOAL_ID",
  ITERATION: "MOMENTUM_ITERATION",
  REPO_PATH: "MOMENTUM_REPO_PATH",
  BASE_HEAD: "MOMENTUM_BASE_HEAD",
  BRANCH: "MOMENTUM_BRANCH",
  PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
  ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
  RESULT_PATH: "MOMENTUM_RESULT_PATH"
} as const;

const TRUSTED_SHELL_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export type TrustedShellRunnerInput = RunnerAdapterInput;

export function runTrustedShellRunner(
  input: TrustedShellRunnerInput
): RunnerAdapterResult {
  const configParse = parseTrustedShellConfig(input.spec.trusted_shell);
  if (!configParse.ok) {
    return adapterError(
      input,
      input.resultJsonPath,
      "invalid_input",
      `trusted-shell config invalid (${configParse.code}): ${configParse.error}`
    );
  }
  const config = configParse.config;

  const resultFile = config.resultFile ?? DEFAULT_TRUSTED_SHELL_RESULT_FILE;
  const resultJsonPathResult = resolveResultJsonPath(
    input.iterationDir,
    resultFile
  );
  if (!resultJsonPathResult.ok) {
    return adapterError(
      input,
      input.resultJsonPath,
      "invalid_input",
      resultJsonPathResult.error
    );
  }
  const resultJsonPath = resultJsonPathResult.path;

  const runnerLogPath = input.runnerLogPath;
  let logHandle: number;
  try {
    logHandle = fs.openSync(runnerLogPath, "w");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "runner_threw",
      error: `trusted-shell could not open runner log ${runnerLogPath}: ${detail}`,
      runnerLogPath,
      resultJsonPath
    };
  }

  try {
    const cwd = resolveCwd(config, input);
    const env = resolveEnv(config, input, resultJsonPath);

    writeLine(logHandle, "[trusted-shell] start");
    writeLine(logHandle, `[trusted-shell] command: ${formatCommand(config)}`);
    writeLine(logHandle, `[trusted-shell] cwd: ${cwd}`);
    writeLine(logHandle, `[trusted-shell] timeout_sec: ${config.timeoutSec}`);
    writeLine(logHandle, `[trusted-shell] result_path: ${resultJsonPath}`);

    const start = Date.now();
    let spawn: SpawnSyncReturns<string>;
    try {
      spawn = spawnSync(config.command, [...config.args], {
        cwd,
        env,
        timeout: config.timeoutSec * 1000,
        encoding: "utf-8",
        maxBuffer: TRUSTED_SHELL_OUTPUT_MAX_BYTES,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      writeLine(logHandle, `[trusted-shell] spawn_error: ${detail}`);
      writeLine(logHandle, "[trusted-shell] summary: spawn failed");
      return adapterError(
        input,
        resultJsonPath,
        "spawn_failed",
        `trusted-shell failed to spawn ${config.command}: ${detail}`
      );
    }
    const durationMs = Date.now() - start;

    writeLog(logHandle, "stdout", spawn.stdout);
    writeLog(logHandle, "stderr", spawn.stderr);

    if (
      spawn.error !== undefined &&
      (spawn.error as NodeJS.ErrnoException).code === "ENOBUFS"
    ) {
      writeLine(
        logHandle,
        `[trusted-shell] output_overflow: stdout/stderr exceeded ${TRUSTED_SHELL_OUTPUT_MAX_BYTES} bytes`
      );
      writeLine(logHandle, "[trusted-shell] summary: output overflow");
      return adapterError(
        input,
        resultJsonPath,
        "output_overflow",
        `trusted-shell command produced more than ${TRUSTED_SHELL_OUTPUT_MAX_BYTES} bytes on stdout or stderr.`
      );
    }

    const timedOut =
      spawn.signal === "SIGTERM" &&
      spawn.error !== undefined &&
      (spawn.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

    if (timedOut) {
      writeLine(logHandle, `[trusted-shell] signal: ${spawn.signal}`);
      writeLine(logHandle, `[trusted-shell] duration_ms: ${durationMs}`);
      writeLine(logHandle, "[trusted-shell] result: timed_out");
      writeLine(
        logHandle,
        `[trusted-shell] summary: command timed out after ${config.timeoutSec}s`
      );
      return adapterError(
        input,
        resultJsonPath,
        "command_timed_out",
        `trusted-shell command timed out after ${config.timeoutSec}s: ${config.command}`
      );
    }

    if (spawn.error !== undefined) {
      writeLine(logHandle, `[trusted-shell] spawn_error: ${spawn.error.message}`);
      writeLine(logHandle, "[trusted-shell] summary: spawn failed");
      return adapterError(
        input,
        resultJsonPath,
        "spawn_failed",
        `trusted-shell failed to spawn ${config.command}: ${spawn.error.message}`
      );
    }

    const exitCode = spawn.status;
    const signal = spawn.signal ?? null;

    writeLine(
      logHandle,
      `[trusted-shell] exit_code: ${exitCode === null ? "null" : String(exitCode)}`
    );
    if (signal !== null) {
      writeLine(logHandle, `[trusted-shell] signal: ${signal}`);
    }
    writeLine(logHandle, `[trusted-shell] duration_ms: ${durationMs}`);

    if (exitCode === null || exitCode !== 0) {
      writeLine(logHandle, "[trusted-shell] result: nonzero_exit");
      writeLine(
        logHandle,
        `[trusted-shell] summary: command exited with code ${exitCode === null ? "null" : String(exitCode)}`
      );
      return adapterError(
        input,
        resultJsonPath,
        "command_failed",
        `trusted-shell command exited with code ${exitCode === null ? "null" : String(exitCode)}: ${config.command}`
      );
    }

    let rawResult: string;
    try {
      rawResult = fs.readFileSync(resultJsonPath, "utf-8");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      const detail = error instanceof Error ? error.message : "unknown error";
      if (errno.code === "ENOENT") {
        writeLine(
          logHandle,
          `[trusted-shell] result_missing: ${resultJsonPath}`
        );
        writeLine(logHandle, "[trusted-shell] summary: result file missing");
        return adapterError(
          input,
          resultJsonPath,
          "result_missing",
          `trusted-shell result file was not written at ${resultJsonPath}.`
        );
      }
      writeLine(logHandle, `[trusted-shell] result_unreadable: ${detail}`);
      writeLine(logHandle, "[trusted-shell] summary: result file unreadable");
      return adapterError(
        input,
        resultJsonPath,
        "result_invalid",
        `trusted-shell result file at ${resultJsonPath} is unreadable: ${detail}`
      );
    }

    const parsed = parseRunnerResult(rawResult);
    if (!parsed.ok) {
      writeLine(logHandle, `[trusted-shell] result_invalid: ${parsed.error}`);
      writeLine(logHandle, "[trusted-shell] summary: result JSON invalid");
      return adapterError(
        input,
        resultJsonPath,
        "result_invalid",
        `trusted-shell result JSON is invalid: ${parsed.error}`
      );
    }

    writeLine(
      logHandle,
      `[trusted-shell] runner_success: ${parsed.value.success}`
    );
    writeLine(
      logHandle,
      `[trusted-shell] goal_complete: ${parsed.value.goal_complete}`
    );
    writeLine(logHandle, "[trusted-shell] done");

    return {
      ok: true,
      result: parsed.value,
      runnerLogPath,
      resultJsonPath,
      diagnostics: {
        command: config.command,
        args: [...config.args],
        cwd,
        exitCode,
        signal,
        durationMs,
        timedOut: false
      }
    };
  } finally {
    try {
      fs.closeSync(logHandle);
    } catch {
      // ignore close failures
    }
  }
}

function resolveResultJsonPath(
  iterationDir: string,
  resultFile: string
): { ok: true; path: string } | { ok: false; error: string } {
  const base = path.resolve(iterationDir);
  const resolved = path.resolve(base, resultFile);
  const relative = path.relative(base, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return {
      ok: false,
      error:
        "trusted-shell result_file must resolve inside the iteration artifact directory."
    };
  }
  return { ok: true, path: resolved };
}

function resolveCwd(
  config: TrustedShellConfig,
  input: TrustedShellRunnerInput
): string {
  return config.cwd === "iteration" ? input.iterationDir : input.repoPath;
}

function resolveEnv(
  config: TrustedShellConfig,
  input: TrustedShellRunnerInput,
  resultJsonPath: string
): NodeJS.ProcessEnv {
  const source = input.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const key of config.envAllow) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (env["PATH"] === undefined && source["PATH"] !== undefined) {
    env["PATH"] = source["PATH"];
  }

  for (const [key, value] of Object.entries(config.env)) {
    env[key] = value;
  }

  env[TRUSTED_SHELL_ENV_VARS.GOAL_ID] = input.goalId;
  env[TRUSTED_SHELL_ENV_VARS.ITERATION] = String(input.iteration);
  env[TRUSTED_SHELL_ENV_VARS.REPO_PATH] = input.repoPath;
  env[TRUSTED_SHELL_ENV_VARS.BASE_HEAD] = input.baseHead;
  env[TRUSTED_SHELL_ENV_VARS.BRANCH] = input.branch;
  env[TRUSTED_SHELL_ENV_VARS.PROMPT_PATH] = input.promptPath;
  env[TRUSTED_SHELL_ENV_VARS.ITERATION_DIR] = input.iterationDir;
  env[TRUSTED_SHELL_ENV_VARS.RESULT_PATH] = resultJsonPath;

  return env;
}

function formatCommand(config: TrustedShellConfig): string {
  if (config.args.length === 0) return config.command;
  return `${config.command} ${config.args.join(" ")}`;
}

function writeLog(
  handle: number,
  label: "stdout" | "stderr",
  chunk: unknown
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[trusted-shell] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}

function adapterError(
  input: TrustedShellRunnerInput,
  resultJsonPath: string,
  code: RunnerAdapterErrorCode,
  error: string
): RunnerAdapterError {
  return {
    ok: false,
    code,
    error,
    runnerLogPath: input.runnerLogPath,
    resultJsonPath
  };
}
