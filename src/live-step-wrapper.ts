/**
 * Live workflow-step execution wrapper introduced by NGX-333 (M9-02).
 *
 * Milestone 9 lets Momentum invoke live workflow steps that wrap the existing
 * OpenClaw engines. NGX-332 (M9-01) added the typed live-wrapper config plus a
 * `WorkflowStepKind`-keyed registry (`live-wrapper-registry.ts`). This module
 * adds the next layer: actually running a resolved live wrapper as an explicit
 * local child process and normalizing its outcome.
 *
 * `runLiveStepWrapper` is the live execution core for the `implementation`
 * step (and any later step kind whose engine emits the normalized
 * `RunnerResult` document). Given a resolved `LiveWrapperConfig` plus the
 * step's execution context, it:
 *
 *   - refuses to spawn when an absolute `command` runtime is missing
 *     (`runtime_unavailable`), so a missing runtime never runs the step;
 *   - runs the optional pre-flight `probe`, mapping a missing/timed-out probe
 *     to `runtime_unavailable` and a non-zero probe exit to `auth_unavailable`
 *     (the M9 refinement over the M4 acp runner, which lacked an auth code);
 *   - spawns the configured `command` + explicit argv with no shell
 *     interpolation, a filtered env allowlist, and the chosen cwd;
 *   - captures stdout/stderr into a bounded artifact log, mapping an output
 *     cap breach to `output_overflow`;
 *   - maps a timeout to `command_timed_out` and a non-zero exit to
 *     `command_failed`;
 *   - requires a normalized `RunnerResult` result file for success, mapping a
 *     missing file to `result_missing` and an unreadable/invalid document to
 *     `result_invalid`.
 *
 * The execution model is synchronous (`spawnSync`), mirroring the M4
 * `trusted-shell` / `acp` runners and the synchronous `WorkflowStepExecutor`
 * boundary. Real-time heartbeating is therefore a caller-side concern.
 *
 * This module stays scoped to process execution and recovery classification.
 * Caller layers resolve registry entries, adapt from `WorkflowStepExecutorInput`,
 * acquire/heartbeat/release durable `workflow_leases`, persist `workflow_steps`
 * start/terminal state, reconcile run-level recovery artifacts, and own
 * verification/commit transactions. Per
 * internal/contracts/live-workflow-execution.md, distinct failure causes map
 * to distinct stable recovery codes rather than generic failure text.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  LiveWrapperConfig,
  LiveWrapperProbeConfig
} from "./live-wrapper-registry.js";
import { parseRunnerResult, type RunnerResult } from "./runner-result.js";
import type { WorkflowStepKind } from "./workflow-run-reducer.js";

/**
 * Stable recovery vocabulary for live-wrapper *execution* failures. This is the
 * process-execution subset of the M9 run-level recovery taxonomy in
 * internal/contracts/live-workflow-execution.md. Caller layers add durable
 * run-level classifications for lease, dispatch, verification, git, reset,
 * repo-lock, commit, invalid-input, executor-throw, and manual-recovery
 * outcomes; a single process run only emits the codes below.
 */
export const LIVE_STEP_WRAPPER_RECOVERY_CODES = [
  "runtime_unavailable",
  "auth_unavailable",
  "command_failed",
  "command_timed_out",
  "output_overflow",
  "result_missing",
  "result_invalid"
] as const;

export type LiveStepWrapperRecoveryCode =
  (typeof LIVE_STEP_WRAPPER_RECOVERY_CODES)[number];

/** Default per-stream output ceiling, matching the M4 runners (256 MiB). */
export const LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export const LIVE_STEP_WRAPPER_RESULT_MAX_BYTES = 1024 * 1024;

/**
 * Workflow-context env vars injected into every live step process. Unlike the
 * M4 runners (which carry goal-iteration context), live wrappers carry the
 * workflow run / step identity. These are injected unconditionally and are not
 * subject to the `env_allow` allowlist.
 */
export const LIVE_STEP_WRAPPER_ENV_VARS = {
  RUN_ID: "MOMENTUM_RUN_ID",
  STEP_ID: "MOMENTUM_STEP_ID",
  STEP_KIND: "MOMENTUM_STEP_KIND",
  ATTEMPT: "MOMENTUM_ATTEMPT",
  REPO_PATH: "MOMENTUM_REPO_PATH",
  ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
  PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
  RESULT_PATH: "MOMENTUM_RESULT_PATH"
} as const;

export type LiveStepWrapperInput = {
  kind: WorkflowStepKind;
  config: LiveWrapperConfig;
  runId: string;
  stepId: string;
  attempt: number;
  /** Absolute repo root; the cwd when `config.cwd` is "repo". */
  repoPath: string;
  /** Absolute iteration artifact directory; the cwd when `config.cwd` is
   * "iteration" and the base the relative `result_file` resolves against. */
  iterationDir: string;
  /** Absolute path for the bounded stdout/stderr artifact log. */
  executorLogPath: string;
  /** Optional prompt path forwarded as MOMENTUM_PROMPT_PATH. */
  promptPath?: string;
  /** Base env to filter through the allowlist; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Per-stream output cap; defaults to LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES. */
  outputMaxBytes?: number;
};

export type LiveStepWrapperDiagnostics = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  probed: boolean;
};

export type LiveStepWrapperSuccess = {
  ok: true;
  result: RunnerResult;
  resultJsonPath: string;
  executorLogPath: string;
  diagnostics: LiveStepWrapperDiagnostics;
};

export type LiveStepWrapperError = {
  ok: false;
  code: LiveStepWrapperRecoveryCode;
  error: string;
  resultJsonPath: string | undefined;
  executorLogPath: string;
};

export type LiveStepWrapperResult =
  | LiveStepWrapperSuccess
  | LiveStepWrapperError;

export function runLiveStepWrapper(
  input: LiveStepWrapperInput
): LiveStepWrapperResult {
  const pathValidation = validateInputPaths(input);
  if (!pathValidation.ok) {
    return wrapperError(
      input.executorLogPath,
      undefined,
      "runtime_unavailable",
      pathValidation.error
    );
  }

  const config = input.config;
  const outputMaxBytes =
    input.outputMaxBytes ?? LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES;

  const resultJsonPathResult = resolveResultJsonPath(
    input.iterationDir,
    config.resultFile
  );
  const executorLogPath = input.executorLogPath;

  fs.mkdirSync(path.dirname(executorLogPath), { recursive: true });
  const logHandle = fs.openSync(executorLogPath, "w");

  try {
    writeLine(logHandle, "[live-step] start");
    writeLine(logHandle, `[live-step] kind: ${input.kind}`);
    writeLine(logHandle, `[live-step] run_id: ${input.runId}`);
    writeLine(logHandle, `[live-step] step_id: ${input.stepId}`);
    writeLine(logHandle, `[live-step] attempt: ${input.attempt}`);

    if (!resultJsonPathResult.ok) {
      writeLine(
        logHandle,
        `[live-step] result_invalid: ${resultJsonPathResult.error}`
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        undefined,
        "result_invalid",
        resultJsonPathResult.error
      );
    }

    const resultJsonPath = resultJsonPathResult.path;
    const resultPathSafety = validateResultPathContainment(
      input.iterationDir,
      resultJsonPath
    );
    if (!resultPathSafety.ok) {
      writeLine(
        logHandle,
        `[live-step] result_invalid: ${resultPathSafety.error}`
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        resultPathSafety.error
      );
    }
    const timeoutValidation = validateRuntimeTimeouts(config);
    if (!timeoutValidation.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${timeoutValidation.error}`
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        timeoutValidation.error
      );
    }

    const availability = checkRuntimeAvailability(config.command);
    if (!availability.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${availability.error}`
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        availability.error
      );
    }

    const cwd = resolveCwd(config, input);
    const env = resolveEnv(config, input, resultJsonPath);

    if (config.probe !== undefined) {
      const probeResult = runProbe(
        logHandle,
        config.probe,
        cwd,
        env,
        outputMaxBytes
      );
      if (!probeResult.ok) {
        return wrapperError(
          executorLogPath,
          resultJsonPath,
          probeResult.code,
          probeResult.error
        );
      }
    }

    writeLine(logHandle, `[live-step] command: ${formatCommand(config)}`);
    writeLine(logHandle, `[live-step] cwd: ${cwd}`);
    writeLine(logHandle, `[live-step] timeout_sec: ${config.timeoutSec}`);
    writeLine(logHandle, `[live-step] result_path: ${resultJsonPath}`);

    const cleared = clearResultFile(
      logHandle,
      resultJsonPath,
      input.iterationDir
    );
    if (!cleared.ok) {
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        cleared.error
      );
    }

    const start = Date.now();
    let spawn: SpawnSyncReturns<string>;
    try {
      spawn = runProcessGroupSync(config.command, [...config.args], {
        cwd,
        env,
        timeoutMs: config.timeoutSec * 1000,
        maxBuffer: outputMaxBytes
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      writeLine(logHandle, `[live-step] spawn_error: ${detail}`);
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        `live step runtime ${config.command} could not be launched: ${detail}`
      );
    }
    const durationMs = Date.now() - start;

    writeLog(logHandle, "stdout", spawn.stdout);
    writeLog(logHandle, "stderr", spawn.stderr);

    if (errnoCode(spawn.error) === "ENOBUFS") {
      writeLine(
        logHandle,
        `[live-step] output_overflow: stdout/stderr exceeded ${outputMaxBytes} bytes`
      );
      writeLine(logHandle, "[live-step] summary: output overflow");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "output_overflow",
        `live step command produced more than ${outputMaxBytes} bytes on stdout or stderr.`
      );
    }

    const timedOut = errnoCode(spawn.error) === "ETIMEDOUT";

    if (timedOut) {
      writeLine(logHandle, `[live-step] signal: ${spawn.signal}`);
      writeLine(logHandle, `[live-step] duration_ms: ${durationMs}`);
      writeLine(logHandle, "[live-step] result: timed_out");
      writeLine(
        logHandle,
        `[live-step] summary: command timed out after ${config.timeoutSec}s`
      );
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "command_timed_out",
        `live step command timed out after ${config.timeoutSec}s: ${config.command}`
      );
    }

    if (spawn.error !== undefined) {
      // ENOENT, EACCES, or any other launch error: the configured runtime
      // could not be executed.
      writeLine(logHandle, `[live-step] spawn_error: ${spawn.error.message}`);
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        `live step runtime ${config.command} could not be executed: ${spawn.error.message}`
      );
    }

    const exitCode = spawn.status;
    const signal = spawn.signal ?? null;

    writeLine(
      logHandle,
      `[live-step] exit_code: ${exitCode === null ? "null" : String(exitCode)}`
    );
    if (signal !== null) {
      writeLine(logHandle, `[live-step] signal: ${signal}`);
    }
    writeLine(logHandle, `[live-step] duration_ms: ${durationMs}`);

    if (exitCode === null || exitCode !== 0) {
      writeLine(logHandle, "[live-step] result: nonzero_exit");
      writeLine(
        logHandle,
        `[live-step] summary: command exited with code ${exitCode === null ? "null" : String(exitCode)}`
      );
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "command_failed",
        `live step command exited with code ${exitCode === null ? "null" : String(exitCode)}: ${config.command}`
      );
    }

    const read = readResultFile(logHandle, resultJsonPath, input.iterationDir);
    if (!read.ok) {
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        read.code,
        read.error
      );
    }

    const parsed = parseRunnerResult(read.raw);
    if (!parsed.ok) {
      writeLine(logHandle, `[live-step] result_invalid: ${parsed.error}`);
      writeLine(logHandle, "[live-step] summary: result JSON invalid");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        `live step result JSON is invalid: ${parsed.error}`
      );
    }

    writeLine(
      logHandle,
      `[live-step] runner_success: ${parsed.value.success}`
    );
    writeLine(
      logHandle,
      `[live-step] goal_complete: ${parsed.value.goal_complete}`
    );
    writeLine(logHandle, "[live-step] done");

    return {
      ok: true,
      result: parsed.value,
      resultJsonPath,
      executorLogPath,
      diagnostics: {
        command: config.command,
        args: [...config.args],
        cwd,
        exitCode,
        signal,
        durationMs,
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
      code: Extract<
        LiveStepWrapperRecoveryCode,
        "runtime_unavailable" | "auth_unavailable" | "output_overflow"
      >;
      error: string;
    };

function runProbe(
  logHandle: number,
  probe: LiveWrapperProbeConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  outputMaxBytes: number
): ProbeOutcome {
  writeLine(logHandle, "[live-step] probe start");
  writeLine(logHandle, `[live-step] probe command: ${formatProbeCommand(probe)}`);
  writeLine(logHandle, `[live-step] probe timeout_sec: ${probe.timeoutSec}`);

  const availability = checkRuntimeAvailability(probe.command);
  if (!availability.ok) {
    writeLine(
      logHandle,
      `[live-step] probe runtime_unavailable: ${availability.error}`
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return { ok: false, code: "runtime_unavailable", error: availability.error };
  }

  let spawn: SpawnSyncReturns<string>;
  try {
    spawn = runProcessGroupSync(probe.command, [...probe.args], {
      cwd,
      env,
      timeoutMs: probe.timeoutSec * 1000,
      maxBuffer: outputMaxBytes
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    writeLine(logHandle, `[live-step] probe spawn_error: ${detail}`);
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} could not be launched: ${detail}`
    };
  }

  writeLog(logHandle, "probe stdout", spawn.stdout);
  writeLog(logHandle, "probe stderr", spawn.stderr);

  if (errnoCode(spawn.error) === "ENOBUFS") {
    writeLine(
      logHandle,
      `[live-step] probe output_overflow: stdout/stderr exceeded ${outputMaxBytes} bytes`
    );
    writeLine(logHandle, "[live-step] summary: output overflow");
    return {
      ok: false,
      code: "output_overflow",
      error: `live step probe ${probe.command} produced more than ${outputMaxBytes} bytes on stdout or stderr.`
    };
  }

  const timedOut = errnoCode(spawn.error) === "ETIMEDOUT";
  if (timedOut) {
    writeLine(
      logHandle,
      `[live-step] probe result: timed_out after ${probe.timeoutSec}s`
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} timed out after ${probe.timeoutSec}s; treating runtime as unavailable.`
    };
  }

  if (spawn.error !== undefined) {
    writeLine(logHandle, `[live-step] probe spawn_error: ${spawn.error.message}`);
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe runtime ${probe.command} is not available: ${spawn.error.message}`
    };
  }

  const exitCode = spawn.status;
  writeLine(
    logHandle,
    `[live-step] probe exit_code: ${exitCode === null ? "null" : String(exitCode)}`
  );
  if (spawn.signal !== undefined && spawn.signal !== null) {
    writeLine(logHandle, `[live-step] probe signal: ${spawn.signal}`);
  }

  if (exitCode === null) {
    // Killed by a signal (not the timeout handled above): abnormal
    // termination, treat the runtime as unavailable rather than an auth fault.
    writeLine(logHandle, "[live-step] probe result: terminated");
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} terminated abnormally; treating runtime as unavailable.`
    };
  }

  if (exitCode !== 0) {
    // The probe ran to completion and reported failure: the runtime is present
    // but its auth / credential check did not pass.
    writeLine(logHandle, "[live-step] probe result: auth_unavailable");
    writeLine(logHandle, "[live-step] summary: auth not available");
    return {
      ok: false,
      code: "auth_unavailable",
      error: `live step probe ${probe.command} exited with code ${exitCode}; treating auth/credentials as unavailable.`
    };
  }

  writeLine(logHandle, "[live-step] probe ok");
  return { ok: true };
}

function validateRuntimeTimeouts(
  config: LiveWrapperConfig
): { ok: true } | { ok: false; error: string } {
  const timeout = validatePositiveTimeoutSec(
    config.timeoutSec,
    "timeout_sec"
  );
  if (!timeout.ok) return timeout;
  if (config.probe !== undefined) {
    return validatePositiveTimeoutSec(
      config.probe.timeoutSec,
      "probe.timeout_sec"
    );
  }
  return { ok: true };
}

function validateInputPaths(
  input: LiveStepWrapperInput
): { ok: true } | { ok: false; error: string } {
  for (const [field, value] of [
    ["repoPath", input.repoPath],
    ["iterationDir", input.iterationDir],
    ["executorLogPath", input.executorLogPath]
  ] as const) {
    if (!path.isAbsolute(value)) {
      return {
        ok: false,
        error: `live step ${field} must be an absolute path.`
      };
    }
  }
  if (input.promptPath !== undefined && !path.isAbsolute(input.promptPath)) {
    return {
      ok: false,
      error: "live step promptPath must be an absolute path."
    };
  }
  return { ok: true };
}

function validatePositiveTimeoutSec(
  value: number,
  field: "timeout_sec" | "probe.timeout_sec"
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error: `live step ${field} must be a positive integer (seconds).`
    };
  }
  return { ok: true };
}

type ProcessGroupOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
};

type ProcessGroupMeta = {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  errorMessage?: string;
};

function runProcessGroupSync(
  command: string,
  args: string[],
  options: ProcessGroupOptions
): SpawnSyncReturns<string> {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-live-step-spawn-")
  );
  const requestPath = path.join(tempDir, "request.json");
  const metaPath = path.join(tempDir, "meta.json");
  const stdoutPath = path.join(tempDir, "stdout.txt");
  const stderrPath = path.join(tempDir, "stderr.txt");

  try {
    fs.writeFileSync(stdoutPath, "");
    fs.writeFileSync(stderrPath, "");
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        command,
        args,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        maxBuffer: options.maxBuffer
      })
    );

    const helper = spawnSync(
      process.execPath,
      [
        "-e",
        LIVE_STEP_PROCESS_GROUP_HELPER,
        requestPath,
        metaPath,
        stdoutPath,
        stderrPath
      ],
      {
        encoding: "utf-8",
        timeout: options.timeoutMs + 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const stdout = readOptionalFile(stdoutPath);
    const stderr = readOptionalFile(stderrPath);
    const meta = readProcessGroupMeta(metaPath);
    if (meta !== undefined) {
      const metaError =
        meta.errorCode !== undefined
          ? spawnError(meta.errorCode, meta.errorMessage ?? meta.errorCode)
          : undefined;
      return spawnReturn({
        status: meta.status,
        signal: meta.signal,
        stdout,
        stderr,
        ...(meta.pid !== undefined ? { pid: meta.pid } : {}),
        ...(metaError !== undefined ? { error: metaError } : {})
      });
    }

    const helperErrorCode = errnoCode(helper.error);
    if (helperErrorCode === "ETIMEDOUT") {
      return spawnReturn({
        status: null,
        signal: helper.signal ?? null,
        stdout,
        stderr,
        error: spawnError(
          "ETIMEDOUT",
          `live step process supervisor timed out after ${options.timeoutMs}ms`
        )
      });
    }
    if (helper.error !== undefined) {
      return spawnReturn({
        status: null,
        signal: helper.signal ?? null,
        stdout,
        stderr,
        error: helper.error
      });
    }
    return spawnReturn({
      status: helper.status,
      signal: helper.signal ?? null,
      stdout,
      stderr: stderr.length > 0 ? stderr : helper.stderr,
      error: spawnError(
        "SUPERVISOR_FAILED",
        `live step process supervisor exited without metadata: ${helper.stderr}`
      )
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function readProcessGroupMeta(filePath: string): ProcessGroupMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProcessGroupMeta;
  } catch {
    return undefined;
  }
}

function spawnReturn(input: {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}): SpawnSyncReturns<string> {
  return {
    pid: input.pid ?? 0,
    output: [null, input.stdout, input.stderr],
    stdout: input.stdout,
    stderr: input.stderr,
    status: input.status,
    signal: input.signal,
    ...(input.error !== undefined ? { error: input.error } : {})
  };
}

function spawnError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const LIVE_STEP_PROCESS_GROUP_HELPER = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [requestPath, metaPath, stdoutPath, stderrPath] = process.argv.slice(1);
const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
let child;
let finished = false;
const state = {
  stdoutBytes: 0,
  stderrBytes: 0,
  errorCode: undefined,
  errorMessage: undefined
};
function writeMeta(status, signal) {
  fs.writeFileSync(metaPath, JSON.stringify({
    pid: child && child.pid,
    status,
    signal,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage
  }));
}
function killTree() {
  if (!child || child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}
function onData(filePath, field) {
  return (chunk) => {
    if (state.errorCode !== undefined) return;
    state[field] += chunk.length;
    if (state[field] > request.maxBuffer) {
      state.errorCode = "ENOBUFS";
      state.errorMessage = "stdout/stderr exceeded maxBuffer";
      killTree();
      return;
    }
    fs.appendFileSync(filePath, chunk);
  };
}
try {
  child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
} catch (error) {
  state.errorCode = error && error.code ? error.code : "SPAWN_ERROR";
  state.errorMessage = error && error.message ? error.message : String(error);
  writeMeta(null, null);
  process.exit(0);
}
child.stdout.on("data", onData(stdoutPath, "stdoutBytes"));
child.stderr.on("data", onData(stderrPath, "stderrBytes"));
child.on("error", (error) => {
  if (state.errorCode === undefined) {
    state.errorCode = error && error.code ? error.code : "SPAWN_ERROR";
    state.errorMessage = error && error.message ? error.message : String(error);
  }
});
const timer = setTimeout(() => {
  if (state.errorCode === undefined) {
    state.errorCode = "ETIMEDOUT";
    state.errorMessage = "process timed out";
  }
  killTree();
}, request.timeoutMs);
child.on("close", (status, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killTree();
  writeMeta(status, signal);
});
`;

function checkRuntimeAvailability(
  command: string
): { ok: true } | { ok: false; error: string } {
  if (!path.isAbsolute(command)) {
    return {
      ok: false,
      error: `live step runtime ${command} must be an absolute executable path.`
    };
  }
  try {
    const stat = fs.statSync(command);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: `live step runtime ${command} exists but is not a regular file.`
      };
    }
    return { ok: true };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return {
        ok: false,
        error: `live step runtime ${command} is not installed at the configured path.`
      };
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `live step runtime ${command} is not accessible: ${detail}`
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
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.isAbsolute(resultFile) ||
    path.win32.isAbsolute(resultFile)
  ) {
    return {
      ok: false,
      error:
        "live step result_file must resolve inside the iteration artifact directory."
    };
  }
  return { ok: true, path: resolved };
}

function validateResultPathContainment(
  iterationDir: string,
  resultJsonPath: string
): { ok: true } | { ok: false; error: string } {
  let baseReal: string;
  try {
    baseReal = fs.realpathSync(iterationDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `live step result_file base directory is not accessible: ${detail}`
    };
  }

  let existing = path.dirname(resultJsonPath);
  while (true) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(existing);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        const parent = path.dirname(existing);
        if (parent === existing) {
          return {
            ok: false,
            error:
              "live step result_file parent directory does not exist inside " +
              "the iteration artifact directory."
          };
        }
        existing = parent;
        continue;
      }
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        error: `live step result_file parent directory is not accessible: ${detail}`
      };
    }

    if (!stat.isDirectory()) {
      return {
        ok: false,
        error:
          "live step result_file must not traverse a symlink or non-directory parent."
      };
    }

    let existingReal: string;
    try {
      existingReal = fs.realpathSync(existing);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        error: `live step result_file parent directory is not accessible: ${detail}`
      };
    }

    const relative = path.relative(baseReal, existingReal);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return {
        ok: false,
        error:
          "live step result_file must remain inside the iteration artifact directory."
      };
    }
    return { ok: true };
  }
}

function resolveCwd(config: LiveWrapperConfig, input: LiveStepWrapperInput): string {
  return config.cwd === "iteration" ? input.iterationDir : input.repoPath;
}

function resolveEnv(
  config: LiveWrapperConfig,
  input: LiveStepWrapperInput,
  resultJsonPath: string
): NodeJS.ProcessEnv {
  const source = input.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const key of config.envAllow) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  env[LIVE_STEP_WRAPPER_ENV_VARS.RUN_ID] = input.runId;
  env[LIVE_STEP_WRAPPER_ENV_VARS.STEP_ID] = input.stepId;
  env[LIVE_STEP_WRAPPER_ENV_VARS.STEP_KIND] = input.kind;
  env[LIVE_STEP_WRAPPER_ENV_VARS.ATTEMPT] = String(input.attempt);
  env[LIVE_STEP_WRAPPER_ENV_VARS.REPO_PATH] = input.repoPath;
  env[LIVE_STEP_WRAPPER_ENV_VARS.ITERATION_DIR] = input.iterationDir;
  if (input.promptPath !== undefined) {
    env[LIVE_STEP_WRAPPER_ENV_VARS.PROMPT_PATH] = input.promptPath;
  }
  env[LIVE_STEP_WRAPPER_ENV_VARS.RESULT_PATH] = resultJsonPath;

  return env;
}

function formatCommand(config: LiveWrapperConfig): string {
  if (config.args.length === 0) return config.command;
  return `${config.command} ${config.args.join(" ")}`;
}

function formatProbeCommand(probe: LiveWrapperProbeConfig): string {
  if (probe.args.length === 0) return probe.command;
  return `${probe.command} ${probe.args.join(" ")}`;
}

function writeLog(
  handle: number,
  label: "stdout" | "stderr" | "probe stdout" | "probe stderr",
  chunk: unknown
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[live-step] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}

function clearResultFile(
  logHandle: number,
  resultJsonPath: string,
  iterationDir: string
): { ok: true } | { ok: false; error: string } {
  const pathSafety = validateResultPathContainment(
    iterationDir,
    resultJsonPath
  );
  if (!pathSafety.ok) {
    writeLine(
      logHandle,
      `[live-step] result_clear_failed: ${pathSafety.error}`
    );
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return { ok: false, error: pathSafety.error };
  }
  try {
    fs.unlinkSync(resultJsonPath);
    writeLine(logHandle, `[live-step] result_cleared: ${resultJsonPath}`);
    return { ok: true };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { ok: true };
    const detail = error instanceof Error ? error.message : "unknown error";
    writeLine(logHandle, `[live-step] result_clear_failed: ${detail}`);
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return {
      ok: false,
      error: `live step result file at ${resultJsonPath} could not be cleared before execution: ${detail}`
    };
  }
}

function readResultFile(
  logHandle: number,
  resultJsonPath: string,
  iterationDir: string
):
  | { ok: true; raw: string }
  | { ok: false; code: "result_missing" | "result_invalid"; error: string } {
  const pathSafety = validateResultPathContainment(
    iterationDir,
    resultJsonPath
  );
  if (!pathSafety.ok) {
    writeLine(logHandle, `[live-step] result_invalid: ${pathSafety.error}`);
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return {
      ok: false,
      code: "result_invalid",
      error: pathSafety.error
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resultJsonPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    if (errnoCode(error) === "ENOENT") {
      writeLine(logHandle, `[live-step] result_missing: ${resultJsonPath}`);
      writeLine(logHandle, "[live-step] summary: result file missing");
      return {
        ok: false,
        code: "result_missing",
        error: `live step result file was not written at ${resultJsonPath}.`
      };
    }
    writeLine(logHandle, `[live-step] result_unreadable: ${detail}`);
    writeLine(logHandle, "[live-step] summary: result file unreadable");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} is unreadable: ${detail}`
    };
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    writeLine(logHandle, `[live-step] result_not_file: ${resultJsonPath}`);
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} is not a regular file.`
    };
  }

  if (stat.size > LIVE_STEP_WRAPPER_RESULT_MAX_BYTES) {
    writeLine(
      logHandle,
      `[live-step] result_too_large: ${stat.size} bytes exceeds ${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES}`
    );
    writeLine(logHandle, "[live-step] summary: result file too large");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} exceeds ${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES} bytes.`
    };
  }

  try {
    return { ok: true, raw: fs.readFileSync(resultJsonPath, "utf-8") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    writeLine(logHandle, `[live-step] result_unreadable: ${detail}`);
    writeLine(logHandle, "[live-step] summary: result file unreadable");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} is unreadable: ${detail}`
    };
  }
}

function errnoCode(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

function wrapperError(
  executorLogPath: string,
  resultJsonPath: string | undefined,
  code: LiveStepWrapperRecoveryCode,
  error: string
): LiveStepWrapperError {
  return { ok: false, code, error, resultJsonPath, executorLogPath };
}
