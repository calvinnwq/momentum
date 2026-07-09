/**
 * ACP runner.
 *
 * Spawns the configured ACP/acpx-style runtime as an external child process
 * via the shared `RunnerAdapter` boundary. Adds two pre-flight detections
 * the trusted-shell runner does not need:
 *
 *   - **Runtime availability**: an absolute `acp.command` whose binary does
 *     not exist on disk short-circuits with `runtime_unavailable` before any
 *     spawn attempt, so a missing runtime never modifies repo state.
 *   - **Optional auth/availability probe**: when `acp.probe` is configured,
 *     the runner spawns the probe first. Probe spawn ENOENT or any non-zero
 *     probe exit / signal is mapped to `runtime_unavailable`, distinct from
 *     `command_failed` (which the main command emits only if the probe
 *     succeeded).
 *
 * Everything else (env normalization, MOMENTUM_* env vars, stdout/stderr
 * logging, exit-code handling, result.json parsing) mirrors the
 * trusted-shell runner so the artifact contract stays identical. Momentum
 * core still owns the git transaction, verification, and the artifact
 * layout; this module is dispatched from `runner-adapter.ts` and does not
 * touch git or verification.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_ACP_RESULT_FILE,
  parseAcpConfig,
  type AcpConfig,
  type AcpProbeConfig
} from "./acp-config.js";
import type {
  RunnerAdapterError,
  RunnerAdapterErrorCode,
  RunnerAdapterInput,
  RunnerAdapterResult
} from "./runner-adapter.js";
import { parseRunnerResult } from "../core/executors/runner/result.js";

export const ACP_ENV_VARS = {
  GOAL_ID: "MOMENTUM_GOAL_ID",
  ITERATION: "MOMENTUM_ITERATION",
  REPO_PATH: "MOMENTUM_REPO_PATH",
  BASE_HEAD: "MOMENTUM_BASE_HEAD",
  BRANCH: "MOMENTUM_BRANCH",
  PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
  ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
  RESULT_PATH: "MOMENTUM_RESULT_PATH"
} as const;

const ACP_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export type AcpRunnerInput = RunnerAdapterInput;

export function runAcpRunner(input: AcpRunnerInput): RunnerAdapterResult {
  const configParse = parseAcpConfig(input.spec.acp);
  if (!configParse.ok) {
    return adapterError(
      input,
      input.resultJsonPath,
      "invalid_input",
      `acp config invalid (${configParse.code}): ${configParse.error}`
    );
  }
  const config = configParse.config;

  const resultFile = config.resultFile ?? DEFAULT_ACP_RESULT_FILE;
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
      error: `acp could not open runner log ${runnerLogPath}: ${detail}`,
      runnerLogPath,
      resultJsonPath
    };
  }

  try {
    writeLine(logHandle, "[acp] start");

    const availability = checkRuntimeAvailability(config.command);
    if (!availability.ok) {
      writeLine(logHandle, `[acp] runtime_unavailable: ${availability.error}`);
      writeLine(logHandle, "[acp] summary: runtime not available");
      return adapterError(
        input,
        resultJsonPath,
        "runtime_unavailable",
        availability.error
      );
    }

    const cwd = resolveCwd(config, input);
    const env = resolveEnv(config, input, resultJsonPath);

    if (config.probe !== undefined) {
      const probeResult = runProbe(logHandle, config.probe, cwd, env);
      if (!probeResult.ok) {
        return adapterError(
          input,
          resultJsonPath,
          probeResult.code,
          probeResult.error
        );
      }
    }

    writeLine(logHandle, `[acp] command: ${formatCommand(config)}`);
    writeLine(logHandle, `[acp] cwd: ${cwd}`);
    writeLine(logHandle, `[acp] timeout_sec: ${config.timeoutSec}`);
    writeLine(logHandle, `[acp] result_path: ${resultJsonPath}`);

    const start = Date.now();
    let spawn: SpawnSyncReturns<string>;
    try {
      spawn = spawnSync(config.command, [...config.args], {
        cwd,
        env,
        timeout: config.timeoutSec * 1000,
        encoding: "utf-8",
        maxBuffer: ACP_OUTPUT_MAX_BYTES,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      writeLine(logHandle, `[acp] spawn_error: ${detail}`);
      writeLine(logHandle, "[acp] summary: spawn failed");
      return adapterError(
        input,
        resultJsonPath,
        "startup_failed",
        `acp failed to start ${config.command}: ${detail}`
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
        `[acp] output_overflow: stdout/stderr exceeded ${ACP_OUTPUT_MAX_BYTES} bytes`
      );
      writeLine(logHandle, "[acp] summary: output overflow");
      return adapterError(
        input,
        resultJsonPath,
        "output_overflow",
        `acp command produced more than ${ACP_OUTPUT_MAX_BYTES} bytes on stdout or stderr.`
      );
    }

    const timedOut =
      spawn.signal === "SIGTERM" &&
      spawn.error !== undefined &&
      (spawn.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

    if (timedOut) {
      writeLine(logHandle, `[acp] signal: ${spawn.signal}`);
      writeLine(logHandle, `[acp] duration_ms: ${durationMs}`);
      writeLine(logHandle, "[acp] result: timed_out");
      writeLine(
        logHandle,
        `[acp] summary: command timed out after ${config.timeoutSec}s`
      );
      return adapterError(
        input,
        resultJsonPath,
        "command_timed_out",
        `acp command timed out after ${config.timeoutSec}s: ${config.command}`
      );
    }

    if (spawn.error !== undefined) {
      const code = (spawn.error as NodeJS.ErrnoException).code;
      writeLine(logHandle, `[acp] spawn_error: ${spawn.error.message}`);
      if (code === "ENOENT") {
        writeLine(logHandle, "[acp] summary: runtime not available");
        return adapterError(
          input,
          resultJsonPath,
          "runtime_unavailable",
          `acp runtime ${config.command} is not available: ${spawn.error.message}`
        );
      }
      writeLine(logHandle, "[acp] summary: startup failed");
      return adapterError(
        input,
        resultJsonPath,
        "startup_failed",
        `acp failed to start ${config.command}: ${spawn.error.message}`
      );
    }

    const exitCode = spawn.status;
    const signal = spawn.signal ?? null;

    writeLine(
      logHandle,
      `[acp] exit_code: ${exitCode === null ? "null" : String(exitCode)}`
    );
    if (signal !== null) {
      writeLine(logHandle, `[acp] signal: ${signal}`);
    }
    writeLine(logHandle, `[acp] duration_ms: ${durationMs}`);

    if (exitCode === null || exitCode !== 0) {
      writeLine(logHandle, "[acp] result: nonzero_exit");
      writeLine(
        logHandle,
        `[acp] summary: command exited with code ${exitCode === null ? "null" : String(exitCode)}`
      );
      return adapterError(
        input,
        resultJsonPath,
        "command_failed",
        `acp command exited with code ${exitCode === null ? "null" : String(exitCode)}: ${config.command}`
      );
    }

    let rawResult: string;
    try {
      rawResult = fs.readFileSync(resultJsonPath, "utf-8");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      const detail = error instanceof Error ? error.message : "unknown error";
      if (errno.code === "ENOENT") {
        writeLine(logHandle, `[acp] result_missing: ${resultJsonPath}`);
        writeLine(logHandle, "[acp] summary: result file missing");
        return adapterError(
          input,
          resultJsonPath,
          "result_missing",
          `acp result file was not written at ${resultJsonPath}.`
        );
      }
      writeLine(logHandle, `[acp] result_unreadable: ${detail}`);
      writeLine(logHandle, "[acp] summary: result file unreadable");
      return adapterError(
        input,
        resultJsonPath,
        "result_invalid",
        `acp result file at ${resultJsonPath} is unreadable: ${detail}`
      );
    }

    const parsed = parseRunnerResult(rawResult);
    if (!parsed.ok) {
      writeLine(logHandle, `[acp] result_invalid: ${parsed.error}`);
      writeLine(logHandle, "[acp] summary: result JSON invalid");
      return adapterError(
        input,
        resultJsonPath,
        "result_invalid",
        `acp result JSON is invalid: ${parsed.error}`
      );
    }

    writeLine(logHandle, `[acp] runner_success: ${parsed.value.success}`);
    writeLine(logHandle, `[acp] goal_complete: ${parsed.value.goal_complete}`);
    writeLine(logHandle, "[acp] done");

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
        timedOut: false,
        probed: config.probe !== undefined
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

type ProbeOutcome =
  | { ok: true }
  | {
      ok: false;
      code: Extract<RunnerAdapterErrorCode, "runtime_unavailable" | "startup_failed">;
      error: string;
    };

function runProbe(
  logHandle: number,
  probe: AcpProbeConfig,
  cwd: string,
  env: NodeJS.ProcessEnv
): ProbeOutcome {
  writeLine(logHandle, "[acp] probe start");
  writeLine(
    logHandle,
    `[acp] probe command: ${formatProbeCommand(probe)}`
  );
  writeLine(logHandle, `[acp] probe timeout_sec: ${probe.timeoutSec}`);

  const probeAvailability = checkRuntimeAvailability(probe.command);
  if (!probeAvailability.ok) {
    writeLine(
      logHandle,
      `[acp] probe runtime_unavailable: ${probeAvailability.error}`
    );
    writeLine(logHandle, "[acp] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: probeAvailability.error
    };
  }

  let probeSpawn: SpawnSyncReturns<string>;
  try {
    probeSpawn = spawnSync(probe.command, [...probe.args], {
      cwd,
      env,
      timeout: probe.timeoutSec * 1000,
      encoding: "utf-8",
      maxBuffer: ACP_OUTPUT_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    writeLine(logHandle, `[acp] probe spawn_error: ${detail}`);
    writeLine(logHandle, "[acp] summary: probe spawn failed");
    return {
      ok: false,
      code: "startup_failed",
      error: `acp probe failed to start ${probe.command}: ${detail}`
    };
  }

  writeLog(logHandle, "probe stdout", probeSpawn.stdout);
  writeLog(logHandle, "probe stderr", probeSpawn.stderr);

  const timedOut =
    probeSpawn.signal === "SIGTERM" &&
    probeSpawn.error !== undefined &&
    (probeSpawn.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

  if (timedOut) {
    writeLine(
      logHandle,
      `[acp] probe result: timed_out after ${probe.timeoutSec}s`
    );
    writeLine(logHandle, "[acp] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `acp probe ${probe.command} timed out after ${probe.timeoutSec}s; treating runtime as unavailable.`
    };
  }

  if (probeSpawn.error !== undefined) {
    const code = (probeSpawn.error as NodeJS.ErrnoException).code;
    writeLine(logHandle, `[acp] probe spawn_error: ${probeSpawn.error.message}`);
    if (code === "ENOENT") {
      writeLine(logHandle, "[acp] summary: runtime not available");
      return {
        ok: false,
        code: "runtime_unavailable",
        error: `acp probe runtime ${probe.command} is not available: ${probeSpawn.error.message}`
      };
    }
    writeLine(logHandle, "[acp] summary: probe failed to start");
    return {
      ok: false,
      code: "startup_failed",
      error: `acp probe failed to start ${probe.command}: ${probeSpawn.error.message}`
    };
  }

  const exitCode = probeSpawn.status;
  writeLine(
    logHandle,
    `[acp] probe exit_code: ${exitCode === null ? "null" : String(exitCode)}`
  );
  if (probeSpawn.signal !== undefined && probeSpawn.signal !== null) {
    writeLine(logHandle, `[acp] probe signal: ${probeSpawn.signal}`);
  }

  if (exitCode === null || exitCode !== 0) {
    writeLine(logHandle, "[acp] probe result: nonzero_exit");
    writeLine(logHandle, "[acp] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `acp probe ${probe.command} exited with code ${exitCode === null ? "null" : String(exitCode)}; treating runtime as unavailable (often auth or installation missing).`
    };
  }

  writeLine(logHandle, "[acp] probe ok");
  return { ok: true };
}

function checkRuntimeAvailability(
  command: string
): { ok: true } | { ok: false; error: string } {
  if (!path.isAbsolute(command)) {
    // Non-absolute commands rely on PATH lookup; defer detection to spawn,
    // which surfaces ENOENT as runtime_unavailable.
    return { ok: true };
  }
  try {
    const stat = fs.statSync(command);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: `acp runtime ${command} exists but is not a regular file.`
      };
    }
    return { ok: true };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {
        ok: false,
        error: `acp runtime ${command} is not installed at the configured path.`
      };
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `acp runtime ${command} is not accessible: ${detail}`
    };
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
        "acp result_file must resolve inside the iteration artifact directory."
    };
  }
  return { ok: true, path: resolved };
}

function resolveCwd(config: AcpConfig, input: AcpRunnerInput): string {
  return config.cwd === "iteration" ? input.iterationDir : input.repoPath;
}

function resolveEnv(
  config: AcpConfig,
  input: AcpRunnerInput,
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

  env[ACP_ENV_VARS.GOAL_ID] = input.goalId;
  env[ACP_ENV_VARS.ITERATION] = String(input.iteration);
  env[ACP_ENV_VARS.REPO_PATH] = input.repoPath;
  env[ACP_ENV_VARS.BASE_HEAD] = input.baseHead;
  env[ACP_ENV_VARS.BRANCH] = input.branch;
  env[ACP_ENV_VARS.PROMPT_PATH] = input.promptPath;
  env[ACP_ENV_VARS.ITERATION_DIR] = input.iterationDir;
  env[ACP_ENV_VARS.RESULT_PATH] = resultJsonPath;

  return env;
}

function formatCommand(config: AcpConfig): string {
  if (config.args.length === 0) return config.command;
  return `${config.command} ${config.args.join(" ")}`;
}

function formatProbeCommand(probe: AcpProbeConfig): string {
  if (probe.args.length === 0) return probe.command;
  return `${probe.command} ${probe.args.join(" ")}`;
}

function writeLog(
  handle: number,
  label: "stdout" | "stderr" | "probe stdout" | "probe stderr",
  chunk: unknown
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[acp] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}

function adapterError(
  input: AcpRunnerInput,
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
