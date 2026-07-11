/**
 * Live workflow-step execution wrapper.
 *
 * Momentum invokes live workflow steps that wrap the existing
 * OpenClaw engines. The typed live-wrapper config plus a
 * `WorkflowStepKind`-keyed registry live in `live-wrapper-registry.ts`. This module
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
 *     (the live-wrapper refinement over the acp runner, which lacked an auth code);
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
 * `runLiveStepWrapper` retains the synchronous compatibility path.
 * `runLiveStepWrapperAsync` is the abort-aware SDK runner path and uses the
 * asynchronous process-group supervisor below.
 *
 * This module stays scoped to process execution and recovery classification.
 * Caller layers resolve registry entries, adapt from `WorkflowStepExecutorInput`,
 * acquire/heartbeat/release durable `workflow_leases`, persist `workflow_steps`
 * start/terminal state, reconcile run-level recovery artifacts, and own
 * verification/commit transactions. Per
 * SPEC.md, distinct failure causes map
 * to distinct stable recovery codes rather than generic failure text.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type {
  LiveWrapperConfig,
  LiveWrapperProbeConfig,
} from "./live-wrapper-registry.js";
import { parseRunnerResult } from "../core/executors/runner/result.js";
import type { RunnerResult } from "../core/executors/runner/types.js";
import type { WorkflowStepKind } from "../core/workflow/run/reducer.js";
import {
  MAX_BUILT_IN_PROCESS_TIMEOUT_MS,
  MAX_BUILT_IN_PROCESS_TIMEOUT_SEC,
} from "../shared/process-limits.js";

/**
 * Stable recovery vocabulary for live-wrapper *execution* failures. This is the
 * process-execution subset of the run-level recovery taxonomy in
 * SPEC.md. Caller layers add durable
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
  "result_invalid",
] as const;

export type LiveStepWrapperRecoveryCode =
  (typeof LIVE_STEP_WRAPPER_RECOVERY_CODES)[number];

/** Default per-stream output ceiling, matching the runner ceiling (256 MiB). */
export const LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export const LIVE_STEP_WRAPPER_RESULT_MAX_BYTES = 1024 * 1024;
const CODING_WORKFLOW_WRAPPER_RUNTIME_UNAVAILABLE_MARKER =
  "MOMENTUM_WRAPPER_RECOVERY_CODE=runtime_unavailable";
const PROCESS_TREE_TOKEN_ENV = "MOMENTUM_PROCESS_TREE_TOKEN";
const PROCESS_TREE_FALLBACK_DELAY_MS = 3_800;
const POSIX_PROCESS_TREE_FALLBACK_TIMEOUT_MS = 1_000;
const WINDOWS_PROCESS_TREE_FALLBACK_TIMEOUT_MS = 3_800;
const PROCESS_TREE_CLEANUP_MARGIN_MS = 200;

/**
 * Workflow-context env vars injected into every live step process. Live
 * wrappers carry the workflow run / step identity plus optional per-step
 * agent/model/effort selections. Present values are injected by Momentum and
 * are not subject to the `env_allow` allowlist.
 */
export const LIVE_STEP_WRAPPER_ENV_VARS = {
  RUN_ID: "MOMENTUM_RUN_ID",
  STEP_ID: "MOMENTUM_STEP_ID",
  STEP_KIND: "MOMENTUM_STEP_KIND",
  ATTEMPT: "MOMENTUM_ATTEMPT",
  AGENT_PROVIDER: "MOMENTUM_AGENT_PROVIDER",
  MODEL: "MOMENTUM_MODEL",
  EFFORT: "MOMENTUM_EFFORT",
  REPO_PATH: "MOMENTUM_REPO_PATH",
  ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
  PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
  RESULT_PATH: "MOMENTUM_RESULT_PATH",
} as const;

export type LiveStepWrapperInput = {
  kind: WorkflowStepKind;
  config: LiveWrapperConfig;
  runId: string;
  stepId: string;
  attempt: number;
  agentProvider?: string | null;
  model?: string | null;
  effort?: string | null;
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
  LiveStepWrapperSuccess | LiveStepWrapperError;

export function runLiveStepWrapper(
  input: LiveStepWrapperInput,
): LiveStepWrapperResult {
  const pathValidation = validateInputPaths(input);
  if (!pathValidation.ok) {
    return wrapperError(
      input.executorLogPath,
      undefined,
      "runtime_unavailable",
      pathValidation.error,
    );
  }

  const config = input.config;
  const outputMaxBytes =
    input.outputMaxBytes ?? LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES;

  const resultJsonPathResult = resolveResultJsonPath(
    input.iterationDir,
    config.resultFile,
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
        `[live-step] result_invalid: ${resultJsonPathResult.error}`,
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        undefined,
        "result_invalid",
        resultJsonPathResult.error,
      );
    }

    const resultJsonPath = resultJsonPathResult.path;
    const resultPathSafety = validateResultPathContainment(
      input.iterationDir,
      resultJsonPath,
    );
    if (!resultPathSafety.ok) {
      writeLine(
        logHandle,
        `[live-step] result_invalid: ${resultPathSafety.error}`,
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        resultPathSafety.error,
      );
    }
    const timeoutValidation = validateRuntimeTimeouts(config);
    if (!timeoutValidation.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${timeoutValidation.error}`,
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        timeoutValidation.error,
      );
    }

    const availability = checkRuntimeAvailability(config.command);
    if (!availability.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${availability.error}`,
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        availability.error,
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
        outputMaxBytes,
      );
      if (!probeResult.ok) {
        return wrapperError(
          executorLogPath,
          resultJsonPath,
          probeResult.code,
          probeResult.error,
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
      input.iterationDir,
    );
    if (!cleared.ok) {
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        cleared.error,
      );
    }

    const start = Date.now();
    let spawn: SpawnSyncReturns<string>;
    try {
      spawn = runProcessGroupSync(config.command, [...config.args], {
        cwd,
        env,
        timeoutMs: config.timeoutSec * 1000,
        maxBuffer: outputMaxBytes,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      writeLine(logHandle, `[live-step] spawn_error: ${detail}`);
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        `live step runtime ${config.command} could not be launched: ${detail}`,
      );
    }
    const durationMs = Date.now() - start;

    return finishLiveStepWrapperProcess({
      input,
      config,
      outputMaxBytes,
      logHandle,
      executorLogPath,
      resultJsonPath,
      cwd,
      spawn,
      durationMs,
    });
  } finally {
    try {
      fs.closeSync(logHandle);
    } catch {
      // ignore close failures
    }
  }
}

/** Abort-aware counterpart used by SDK runner adapters. */
export async function runLiveStepWrapperAsync(
  input: LiveStepWrapperInput,
  signal: AbortSignal,
): Promise<LiveStepWrapperResult> {
  signal.throwIfAborted();
  const pathValidation = validateInputPaths(input);
  if (!pathValidation.ok) {
    return wrapperError(
      input.executorLogPath,
      undefined,
      "runtime_unavailable",
      pathValidation.error,
    );
  }

  const config = input.config;
  const outputMaxBytes =
    input.outputMaxBytes ?? LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES;
  const resultJsonPathResult = resolveResultJsonPath(
    input.iterationDir,
    config.resultFile,
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
        `[live-step] result_invalid: ${resultJsonPathResult.error}`,
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        undefined,
        "result_invalid",
        resultJsonPathResult.error,
      );
    }

    const resultJsonPath = resultJsonPathResult.path;
    const resultPathSafety = validateResultPathContainment(
      input.iterationDir,
      resultJsonPath,
    );
    if (!resultPathSafety.ok) {
      writeLine(
        logHandle,
        `[live-step] result_invalid: ${resultPathSafety.error}`,
      );
      writeLine(logHandle, "[live-step] summary: result file invalid");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        resultPathSafety.error,
      );
    }
    const timeoutValidation = validateRuntimeTimeouts(config);
    if (!timeoutValidation.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${timeoutValidation.error}`,
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        timeoutValidation.error,
      );
    }
    const availability = checkRuntimeAvailability(config.command);
    if (!availability.ok) {
      writeLine(
        logHandle,
        `[live-step] runtime_unavailable: ${availability.error}`,
      );
      writeLine(logHandle, "[live-step] summary: runtime not available");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        availability.error,
      );
    }

    const cwd = resolveCwd(config, input);
    const env = resolveEnv(config, input, resultJsonPath);
    if (config.probe !== undefined) {
      const probeResult = await runProbeAsync(
        logHandle,
        config.probe,
        cwd,
        env,
        outputMaxBytes,
        signal,
      );
      if (!probeResult.ok) {
        return wrapperError(
          executorLogPath,
          resultJsonPath,
          probeResult.code,
          probeResult.error,
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
      input.iterationDir,
    );
    if (!cleared.ok) {
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "result_invalid",
        cleared.error,
      );
    }

    const start = Date.now();
    let processResult: SpawnSyncReturns<string>;
    try {
      processResult = await runProcessGroup(config.command, [...config.args], {
        cwd,
        env,
        timeoutMs: config.timeoutSec * 1000,
        maxBuffer: outputMaxBytes,
        signal,
      });
    } catch (error) {
      writeSupervisorFailureOutput(logHandle, error, "stdout", "stderr");
      throw error;
    }
    if (errnoCode(processResult.error) === "ABORT_ERR") {
      writeLog(logHandle, "stdout", processResult.stdout);
      writeLog(logHandle, "stderr", processResult.stderr);
      throwProcessCancellation(processResult, signal);
    }
    return finishLiveStepWrapperProcess({
      input,
      config,
      outputMaxBytes,
      logHandle,
      executorLogPath,
      resultJsonPath,
      cwd,
      spawn: processResult,
      durationMs: Date.now() - start,
    });
  } finally {
    try {
      fs.closeSync(logHandle);
    } catch {
      // ignore close failures
    }
  }
}

function finishLiveStepWrapperProcess(input: {
  input: LiveStepWrapperInput;
  config: LiveWrapperConfig;
  outputMaxBytes: number;
  logHandle: number;
  executorLogPath: string;
  resultJsonPath: string;
  cwd: string;
  spawn: SpawnSyncReturns<string>;
  durationMs: number;
}): LiveStepWrapperResult {
  const {
    config,
    outputMaxBytes,
    logHandle,
    executorLogPath,
    resultJsonPath,
    cwd,
    spawn: processResult,
    durationMs,
  } = input;
  writeLog(logHandle, "stdout", processResult.stdout);
  writeLog(logHandle, "stderr", processResult.stderr);

  if (errnoCode(processResult.error) === "ENOBUFS") {
    writeLine(
      logHandle,
      `[live-step] output_overflow: stdout/stderr exceeded ${outputMaxBytes} bytes`,
    );
    writeLine(logHandle, "[live-step] summary: output overflow");
    return wrapperError(
      executorLogPath,
      resultJsonPath,
      "output_overflow",
      `live step command produced more than ${outputMaxBytes} bytes on stdout or stderr.`,
    );
  }

  if (errnoCode(processResult.error) === "ETIMEDOUT") {
    writeLine(logHandle, `[live-step] signal: ${processResult.signal}`);
    writeLine(logHandle, `[live-step] duration_ms: ${durationMs}`);
    writeLine(logHandle, "[live-step] result: timed_out");
    writeLine(
      logHandle,
      `[live-step] summary: command timed out after ${config.timeoutSec}s`,
    );
    return wrapperError(
      executorLogPath,
      resultJsonPath,
      "command_timed_out",
      `live step command timed out after ${config.timeoutSec}s: ${config.command}`,
    );
  }

  if (processResult.error !== undefined) {
    writeLine(
      logHandle,
      `[live-step] spawn_error: ${processResult.error.message}`,
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return wrapperError(
      executorLogPath,
      resultJsonPath,
      "runtime_unavailable",
      `live step runtime ${config.command} could not be executed: ${processResult.error.message}`,
    );
  }

  const exitCode = processResult.status;
  const signal = processResult.signal ?? null;
  writeLine(
    logHandle,
    `[live-step] exit_code: ${exitCode === null ? "null" : String(exitCode)}`,
  );
  if (signal !== null) writeLine(logHandle, `[live-step] signal: ${signal}`);
  writeLine(logHandle, `[live-step] duration_ms: ${durationMs}`);

  if (exitCode === null || exitCode !== 0) {
    writeLine(logHandle, "[live-step] result: nonzero_exit");
    writeLine(
      logHandle,
      `[live-step] summary: command exited with code ${exitCode === null ? "null" : String(exitCode)}`,
    );
    if (isNodeBootstrapModuleFailure(processResult.stderr, config, cwd)) {
      writeLine(logHandle, "[live-step] recovery: runtime_unavailable");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        `live step wrapper bootstrap failed before runner evidence was produced: ${config.command}`,
      );
    }
    if (
      isCodingWorkflowWrapperInvocation(config) &&
      processResult.stderr.includes(
        CODING_WORKFLOW_WRAPPER_RUNTIME_UNAVAILABLE_MARKER,
      )
    ) {
      writeLine(logHandle, "[live-step] recovery: runtime_unavailable");
      return wrapperError(
        executorLogPath,
        resultJsonPath,
        "runtime_unavailable",
        `live step wrapper reported a retryable setup failure before runner evidence was produced: ${config.command}`,
      );
    }
    return wrapperError(
      executorLogPath,
      resultJsonPath,
      "command_failed",
      `live step command exited with code ${exitCode === null ? "null" : String(exitCode)}: ${config.command}`,
    );
  }

  const read = readResultFile(
    logHandle,
    resultJsonPath,
    input.input.iterationDir,
  );
  if (!read.ok) {
    return wrapperError(executorLogPath, resultJsonPath, read.code, read.error);
  }
  const parsed = parseRunnerResult(read.raw);
  if (!parsed.ok) {
    writeLine(logHandle, `[live-step] result_invalid: ${parsed.error}`);
    writeLine(logHandle, "[live-step] summary: result JSON invalid");
    return wrapperError(
      executorLogPath,
      resultJsonPath,
      "result_invalid",
      `live step result JSON is invalid: ${parsed.error}`,
    );
  }

  writeLine(logHandle, `[live-step] runner_success: ${parsed.value.success}`);
  writeLine(
    logHandle,
    `[live-step] goal_complete: ${parsed.value.goal_complete}`,
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
      probed: config.probe !== undefined,
    },
  };
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
  outputMaxBytes: number,
): ProbeOutcome {
  writeLine(logHandle, "[live-step] probe start");
  writeLine(
    logHandle,
    `[live-step] probe command: ${formatProbeCommand(probe)}`,
  );
  writeLine(logHandle, `[live-step] probe timeout_sec: ${probe.timeoutSec}`);

  const availability = checkRuntimeAvailability(probe.command);
  if (!availability.ok) {
    writeLine(
      logHandle,
      `[live-step] probe runtime_unavailable: ${availability.error}`,
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: availability.error,
    };
  }

  let spawn: SpawnSyncReturns<string>;
  try {
    spawn = runProcessGroupSync(probe.command, [...probe.args], {
      cwd,
      env,
      timeoutMs: probe.timeoutSec * 1000,
      maxBuffer: outputMaxBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    writeLine(logHandle, `[live-step] probe spawn_error: ${detail}`);
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} could not be launched: ${detail}`,
    };
  }

  return finishProbe(logHandle, probe, spawn, outputMaxBytes);
}

async function runProbeAsync(
  logHandle: number,
  probe: LiveWrapperProbeConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  outputMaxBytes: number,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  writeLine(logHandle, "[live-step] probe start");
  writeLine(
    logHandle,
    `[live-step] probe command: ${formatProbeCommand(probe)}`,
  );
  writeLine(logHandle, `[live-step] probe timeout_sec: ${probe.timeoutSec}`);
  const availability = checkRuntimeAvailability(probe.command);
  if (!availability.ok) {
    writeLine(
      logHandle,
      `[live-step] probe runtime_unavailable: ${availability.error}`,
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: availability.error,
    };
  }

  let result: SpawnSyncReturns<string>;
  try {
    result = await runProcessGroup(probe.command, [...probe.args], {
      cwd,
      env,
      timeoutMs: probe.timeoutSec * 1000,
      maxBuffer: outputMaxBytes,
      signal,
    });
  } catch (error) {
    writeSupervisorFailureOutput(
      logHandle,
      error,
      "probe stdout",
      "probe stderr",
    );
    throw error;
  }
  if (errnoCode(result.error) === "ABORT_ERR") {
    writeLog(logHandle, "probe stdout", result.stdout);
    writeLog(logHandle, "probe stderr", result.stderr);
    throwProcessCancellation(result, signal);
  }
  return finishProbe(logHandle, probe, result, outputMaxBytes);
}

function finishProbe(
  logHandle: number,
  probe: LiveWrapperProbeConfig,
  result: SpawnSyncReturns<string>,
  outputMaxBytes: number,
): ProbeOutcome {
  writeLog(logHandle, "probe stdout", result.stdout);
  writeLog(logHandle, "probe stderr", result.stderr);

  if (errnoCode(result.error) === "ENOBUFS") {
    writeLine(
      logHandle,
      `[live-step] probe output_overflow: stdout/stderr exceeded ${outputMaxBytes} bytes`,
    );
    writeLine(logHandle, "[live-step] summary: output overflow");
    return {
      ok: false,
      code: "output_overflow",
      error: `live step probe ${probe.command} produced more than ${outputMaxBytes} bytes on stdout or stderr.`,
    };
  }
  if (errnoCode(result.error) === "ETIMEDOUT") {
    writeLine(
      logHandle,
      `[live-step] probe result: timed_out after ${probe.timeoutSec}s`,
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} timed out after ${probe.timeoutSec}s; treating runtime as unavailable.`,
    };
  }
  if (result.error !== undefined) {
    writeLine(
      logHandle,
      `[live-step] probe spawn_error: ${result.error.message}`,
    );
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe runtime ${probe.command} is not available: ${result.error.message}`,
    };
  }

  const exitCode = result.status;
  writeLine(
    logHandle,
    `[live-step] probe exit_code: ${exitCode === null ? "null" : String(exitCode)}`,
  );
  if (result.signal !== undefined && result.signal !== null) {
    writeLine(logHandle, `[live-step] probe signal: ${result.signal}`);
  }
  if (exitCode === null) {
    writeLine(logHandle, "[live-step] probe result: terminated");
    writeLine(logHandle, "[live-step] summary: runtime not available");
    return {
      ok: false,
      code: "runtime_unavailable",
      error: `live step probe ${probe.command} terminated abnormally; treating runtime as unavailable.`,
    };
  }
  if (exitCode !== 0) {
    writeLine(logHandle, "[live-step] probe result: auth_unavailable");
    writeLine(logHandle, "[live-step] summary: auth not available");
    return {
      ok: false,
      code: "auth_unavailable",
      error: `live step probe ${probe.command} exited with code ${exitCode}; treating auth/credentials as unavailable.`,
    };
  }
  writeLine(logHandle, "[live-step] probe ok");
  return { ok: true };
}

function validateRuntimeTimeouts(
  config: LiveWrapperConfig,
): { ok: true } | { ok: false; error: string } {
  const timeout = validatePositiveTimeoutSec(config.timeoutSec, "timeout_sec");
  if (!timeout.ok) return timeout;
  if (config.probe !== undefined) {
    return validatePositiveTimeoutSec(
      config.probe.timeoutSec,
      "probe.timeout_sec",
    );
  }
  return { ok: true };
}

function isNodeBootstrapModuleFailure(
  stderr: string,
  config: LiveWrapperConfig,
  cwd: string,
): boolean {
  if (
    !/\b(?:ERR_)?MODULE_NOT_FOUND\b/.test(stderr) &&
    !/Cannot find module/.test(stderr)
  ) {
    return false;
  }
  const entrypoint = configuredNodeEntrypoint(config);
  if (entrypoint === null) return false;
  const expectedPath = path.isAbsolute(entrypoint)
    ? path.normalize(entrypoint)
    : path.normalize(path.resolve(cwd, entrypoint));
  const normalizedStderr = path.normalize(stderr);
  return (
    normalizedStderr.includes(`Cannot find module '${expectedPath}'`) ||
    normalizedStderr.includes(`Cannot find module "${expectedPath}"`) ||
    normalizedStderr.includes(`Cannot find module ${expectedPath}`) ||
    normalizedStderr.includes(`Cannot find module '${entrypoint}'`) ||
    normalizedStderr.includes(`Cannot find module "${entrypoint}"`)
  );
}

function configuredNodeEntrypoint(config: LiveWrapperConfig): string | null {
  const commandBase = path.basename(config.command);
  if (commandBase === "node") {
    return firstNodeScriptArg(config.args);
  }
  if (commandBase === "env" && config.args[0] === "node") {
    return firstNodeScriptArg(config.args.slice(1));
  }
  return null;
}

function firstNodeScriptArg(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") {
      return null;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function validateInputPaths(
  input: LiveStepWrapperInput,
): { ok: true } | { ok: false; error: string } {
  for (const [field, value] of [
    ["repoPath", input.repoPath],
    ["iterationDir", input.iterationDir],
    ["executorLogPath", input.executorLogPath],
  ] as const) {
    if (!path.isAbsolute(value)) {
      return {
        ok: false,
        error: `live step ${field} must be an absolute path.`,
      };
    }
  }
  if (input.promptPath !== undefined && !path.isAbsolute(input.promptPath)) {
    return {
      ok: false,
      error: "live step promptPath must be an absolute path.",
    };
  }
  return { ok: true };
}

function validatePositiveTimeoutSec(
  value: number,
  field: "timeout_sec" | "probe.timeout_sec",
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error: `live step ${field} must be a positive integer (seconds).`,
    };
  }
  if (value > MAX_BUILT_IN_PROCESS_TIMEOUT_SEC) {
    return {
      ok: false,
      error: `live step ${field} must not exceed ${MAX_BUILT_IN_PROCESS_TIMEOUT_SEC} seconds.`,
    };
  }
  return { ok: true };
}

export type ProcessGroupOptions = {
  /** Absolute working directory for the supervised process. */
  cwd: string;
  /** Complete environment passed to the child process. */
  env: NodeJS.ProcessEnv;
  /** Child timeout in milliseconds before the whole process group is killed. */
  timeoutMs: number;
  /** Per-stream stdout/stderr byte cap before the process group is killed. */
  maxBuffer: number;
};

export type AsyncProcessGroupOptions = ProcessGroupOptions & {
  /** Cooperative cancellation that requests verified owned-tree cleanup. */
  signal?: AbortSignal;
};

type ProcessGroupMeta = {
  pid?: number;
  commandCreationTicks?: string;
  commandStartedAtMs?: number;
  commandExitedAtMs?: number;
  commandExited?: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  errorMessage?: string;
  unsafeDetachedDescendant?: boolean;
  cleanupOnly?: boolean;
  cleanupSucceeded?: boolean;
};

/**
 * Synchronously run a command under a tiny supervisor that owns process-group
 * cleanup. The child receives explicit argv/env/cwd, stdout and stderr are
 * bounded separately by `maxBuffer`, and timeout or overflow kills the whole
 * process group before returning a `SpawnSyncReturns`-shaped result.
 */
export function runProcessGroupSync(
  command: string,
  args: string[],
  options: ProcessGroupOptions,
): SpawnSyncReturns<string> {
  const optionsError = processGroupOptionsError(options);
  if (optionsError !== undefined) {
    return spawnReturn({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: optionsError,
    });
  }
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-live-step-spawn-"),
  );
  const requestPath = path.join(tempDir, "request.json");
  const metaPath = path.join(tempDir, "meta.json");
  const stdoutPath = path.join(tempDir, "stdout.txt");
  const stderrPath = path.join(tempDir, "stderr.txt");
  const processTreeToken = crypto.randomUUID();

  try {
    fs.writeFileSync(stdoutPath, "");
    fs.writeFileSync(stderrPath, "");
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        command,
        args,
        cwd: options.cwd,
        env: { ...options.env, [PROCESS_TREE_TOKEN_ENV]: processTreeToken },
        timeoutMs: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      }),
    );

    const helper = spawnSync(
      process.execPath,
      [
        "-e",
        LIVE_STEP_PROCESS_GROUP_HELPER,
        requestPath,
        metaPath,
        stdoutPath,
        stderrPath,
      ],
      {
        encoding: "utf-8",
        timeout: options.timeoutMs + 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
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
        ...(metaError !== undefined ? { error: metaError } : {}),
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
          `live step process supervisor timed out after ${options.timeoutMs}ms`,
        ),
      });
    }
    if (helper.error !== undefined) {
      return spawnReturn({
        status: null,
        signal: helper.signal ?? null,
        stdout,
        stderr,
        error: helper.error,
      });
    }
    return spawnReturn({
      status: helper.status,
      signal: helper.signal ?? null,
      stdout,
      stderr: stderr.length > 0 ? stderr : helper.stderr,
      error: spawnError(
        "SUPERVISOR_FAILED",
        `live step process supervisor exited without metadata: ${helper.stderr}`,
      ),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Asynchronously run a bounded process below a detached anchor. Timeout, output
 * overflow, normal leader exit, and caller cancellation all trigger cleanup of
 * the anchored group and every discovered token-owned descendant before the
 * promise settles. Captured stdout/stderr remain available through cleanup, and
 * streaming decoders preserve UTF-8 characters split across pipe chunks.
 *
 * POSIX cleanup is portable userland containment, not a sandbox. A hostile
 * descendant that escapes between ancestry samples and strips its ownership
 * token requires kernel-backed containment; detected escapes or any lost cleanup
 * proof reject with `SUPERVISOR_FAILED` rather than claiming success.
 * If the anchor cannot confirm cleanup, a verified ownership-checked fallback
 * preserves the known timeout, cancellation, or command-exit outcome. POSIX
 * starts the fallback deadline after ownership preflight and, once the anchor
 * exits, requires its prior cleanup-attempt report. Windows retains bounded
 * anchor and command start/exit identities. Any fallback that cannot prove
 * cleanup replaces the known outcome with `SUPERVISOR_FAILED`.
 */
export function runProcessGroup(
  command: string,
  args: string[],
  options: AsyncProcessGroupOptions,
): Promise<SpawnSyncReturns<string>> {
  const optionsError = processGroupOptionsError(options);
  if (optionsError !== undefined) {
    return Promise.resolve(
      spawnReturn({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: optionsError,
      }),
    );
  }
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      resolve(
        spawnReturn({
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          error: spawnError("ABORT_ERR", "process cancelled before launch"),
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputFlushed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: Error | undefined;
    let commandPid: number | undefined;
    let commandCreationTicks: string | undefined;
    let commandStartedAtMs: number | undefined;
    let commandExitedAtMs: number | undefined;
    let commandExited = false;
    let commandStatus: number | null | undefined;
    let commandSignal: NodeJS.Signals | null | undefined;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    let executionTimeout: ReturnType<typeof setTimeout> | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let treeTermination: Promise<boolean> | undefined;
    let anchorCleanupSucceeded = false;
    let anchorCleanupReported = false;
    let terminationStatus: number | null = null;
    let terminationSignal: NodeJS.Signals | null = null;
    const processTreeToken = crypto.randomUUID();

    const armCloseDeadline = (delayMs: number): void => {
      if (closeDeadline !== undefined) clearTimeout(closeDeadline);
      closeDeadline = setTimeout(() => {
        terminalError = spawnError(
          "SUPERVISOR_FAILED",
          "process tree did not terminate within the cleanup deadline",
        );
        void killTree();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(terminationStatus, terminationSignal);
      }, delayMs);
    };

    const killTree = (): Promise<boolean> => {
      if (treeTermination !== undefined) return treeTermination;
      if (child.pid !== undefined) {
        const groupLeaderPid = child.pid;
        treeTermination = new Promise((resolveTermination) => {
          let finished = false;
          let fallbackStarted = false;
          const finish = (success: boolean): void => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            resolveTermination(success);
          };
          const runFallback = (): void => {
            if (fallbackStarted) return;
            fallbackStarted = true;
            let fallback: Promise<boolean>;
            if (process.platform === "win32") {
              if (commandPid !== undefined) {
                fallback =
                  commandStartedAtMs === undefined
                    ? Promise.resolve(false)
                    : killWindowsProcessTree(groupLeaderPid, processTreeToken, {
                        pid: commandPid,
                        ...(commandCreationTicks !== undefined
                          ? { creationTicks: commandCreationTicks }
                          : {}),
                        startedAtMs: commandStartedAtMs,
                        ...(commandExitedAtMs !== undefined
                          ? { exitedAtMs: commandExitedAtMs }
                          : {}),
                        exited: commandExited,
                      });
              } else {
                fallback = killWindowsProcessTree(
                  groupLeaderPid,
                  processTreeToken,
                );
              }
              armCloseDeadline(
                WINDOWS_PROCESS_TREE_FALLBACK_TIMEOUT_MS +
                  PROCESS_TREE_CLEANUP_MARGIN_MS,
              );
            } else {
              if (closeDeadline !== undefined) clearTimeout(closeDeadline);
              closeDeadline = undefined;
              fallback = terminateOwnedPosixTree(
                groupLeaderPid,
                child,
                processTreeToken,
                POSIX_PROCESS_TREE_FALLBACK_TIMEOUT_MS,
                () => anchorCleanupReported,
                () =>
                  armCloseDeadline(
                    POSIX_PROCESS_TREE_FALLBACK_TIMEOUT_MS +
                      PROCESS_TREE_CLEANUP_MARGIN_MS,
                  ),
              );
            }
            void fallback.then(finish);
          };
          const controlEnded = (): void => {
            if (anchorCleanupSucceeded && !fallbackStarted) finish(true);
            else runFallback();
          };
          const controlStream = child.stdio[3] as Readable | null | undefined;
          if (controlStream !== null && controlStream !== undefined) {
            if (controlStream.readableEnded || controlStream.destroyed) {
              controlEnded();
            } else {
              controlStream.once("end", controlEnded);
            }
          } else {
            child.once("exit", controlEnded);
          }
          const deadline = setTimeout(
            runFallback,
            PROCESS_TREE_FALLBACK_DELAY_MS,
          );
          try {
            child.stdin?.write("kill\n", (error) => {
              if (error !== null && error !== undefined) runFallback();
            });
          } catch {
            runFallback();
          }
        });
        return treeTermination;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited.
      }
      treeTermination ??= Promise.resolve(true);
      return treeTermination;
    };

    const settle = (
      status: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      if (!outputFlushed) {
        outputFlushed = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      if (executionTimeout !== undefined) clearTimeout(executionTimeout);
      if (closeDeadline !== undefined) clearTimeout(closeDeadline);
      options.signal?.removeEventListener("abort", abort);
      if (errnoCode(terminalError) === "SUPERVISOR_FAILED") {
        reject(attachProcessOutput(terminalError, stdout, stderr));
        return;
      }
      resolve(
        spawnReturn({
          ...(commandPid !== undefined
            ? { pid: commandPid }
            : child.pid !== undefined
              ? { pid: child.pid }
              : {}),
          status,
          signal,
          stdout,
          stderr,
          ...(terminalError !== undefined ? { error: terminalError } : {}),
        }),
      );
    };

    const requestTermination = (
      status: number | null = null,
      signal: NodeJS.Signals | null = null,
    ): void => {
      if (closeDeadline === undefined) {
        terminationStatus = status;
        terminationSignal = signal;
        armCloseDeadline(
          PROCESS_TREE_FALLBACK_DELAY_MS +
            (process.platform === "win32"
              ? WINDOWS_PROCESS_TREE_FALLBACK_TIMEOUT_MS
              : POSIX_PROCESS_TREE_FALLBACK_TIMEOUT_MS) +
            PROCESS_TREE_CLEANUP_MARGIN_MS,
        );
      }
      const termination = killTree();
      void termination.then((terminated) => {
        if (terminated || settled) return;
        terminalError = spawnError(
          "SUPERVISOR_FAILED",
          "process-tree cleanup helpers failed",
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(status, signal);
      });
    };

    const abort = (): void => {
      terminalError ??= spawnError("ABORT_ERR", "process cancelled");
      requestTermination();
    };

    let serializedRequest: string;
    try {
      serializedRequest = JSON.stringify({
        command,
        args,
        cwd: options.cwd,
        env: { ...options.env, [PROCESS_TREE_TOKEN_ENV]: processTreeToken },
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      resolve(
        spawnReturn({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      return;
    }

    try {
      child = spawn(
        process.execPath,
        ["-e", LIVE_STEP_ASYNC_GROUP_ANCHOR, processTreeToken],
        {
          cwd: options.cwd,
          env: processAnchorEnvironment(processTreeToken),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      resolve(
        spawnReturn({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      return;
    }
    child.stdin?.on("error", (error) => {
      if (treeTermination !== undefined || settled) return;
      terminalError ??= error;
      requestTermination();
    });
    child.stdin?.write(`${serializedRequest}\n`);
    executionTimeout = setTimeout(() => {
      terminalError ??= spawnError(
        "SUPERVISOR_FAILED",
        "process-group anchor did not report before its cleanup deadline",
      );
      requestTermination();
    }, options.timeoutMs + 4_000);

    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxBuffer) {
          terminalError = spawnError("ENOBUFS", "stdout exceeded maxBuffer");
          requestTermination();
          return;
        }
        stdout += stdoutDecoder.write(chunk);
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxBuffer) {
        terminalError = spawnError("ENOBUFS", "stderr exceeded maxBuffer");
        requestTermination();
        return;
      }
      stderr += stderrDecoder.write(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    let controlOutput = "";
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      controlOutput += chunk.toString("utf-8");
      let newline = controlOutput.indexOf("\n");
      while (newline >= 0) {
        const line = controlOutput.slice(0, newline);
        controlOutput = controlOutput.slice(newline + 1);
        let meta: ProcessGroupMeta;
        try {
          meta = JSON.parse(line) as ProcessGroupMeta;
        } catch {
          terminalError = spawnError(
            "SUPERVISOR_FAILED",
            "process-group anchor emitted invalid lifecycle metadata",
          );
          requestTermination();
          return;
        }
        if (meta.cleanupOnly !== true) {
          commandPid =
            Number.isInteger(meta.pid) && (meta.pid ?? 0) > 0
              ? meta.pid
              : undefined;
          commandCreationTicks =
            commandPid !== undefined &&
            typeof meta.commandCreationTicks === "string" &&
            /^\d+$/.test(meta.commandCreationTicks)
              ? meta.commandCreationTicks
              : undefined;
          commandStartedAtMs =
            commandPid !== undefined &&
            Number.isInteger(meta.commandStartedAtMs) &&
            (meta.commandStartedAtMs ?? 0) > 0
              ? meta.commandStartedAtMs
              : undefined;
          commandExitedAtMs =
            commandPid !== undefined &&
            Number.isInteger(meta.commandExitedAtMs) &&
            (meta.commandExitedAtMs ?? 0) >= (commandStartedAtMs ?? 0)
              ? meta.commandExitedAtMs
              : undefined;
          commandExited = meta.commandExited === true;
          commandStatus = meta.status;
          commandSignal = meta.signal;
        }
        if (meta.cleanupSucceeded === true) {
          anchorCleanupSucceeded = true;
        }
        if (meta.cleanupOnly === true) anchorCleanupReported = true;
        if (meta.unsafeDetachedDescendant === true) {
          terminalError = spawnError(
            "SUPERVISOR_FAILED",
            "process tree created an unowned detached descendant",
          );
        }
        if (meta.errorCode !== undefined) {
          terminalError ??= spawnError(
            meta.errorCode,
            meta.errorMessage ?? meta.errorCode,
          );
        }
        if (executionTimeout !== undefined) clearTimeout(executionTimeout);
        requestTermination(meta.status, meta.signal);
        newline = controlOutput.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      terminalError ??= error;
    });
    child.on("exit", (status, signal) => {
      if (executionTimeout !== undefined) clearTimeout(executionTimeout);
      requestTermination(
        commandStatus === undefined ? status : commandStatus,
        commandSignal === undefined ? signal : commandSignal,
      );
    });
    child.on("close", (status, signal) => {
      const settledStatus =
        commandStatus === undefined ? status : commandStatus;
      const settledSignal =
        commandSignal === undefined ? signal : commandSignal;
      const termination = treeTermination;
      if (termination === undefined) {
        settle(settledStatus, settledSignal);
        return;
      }
      void termination.then((terminated) => {
        if (!terminated) {
          terminalError = spawnError(
            "SUPERVISOR_FAILED",
            "process-tree cleanup helpers failed",
          );
        }
        settle(settledStatus, settledSignal);
      });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (abortRequested(options.signal)) abort();
  });
}

function processGroupOptionsError(
  options: ProcessGroupOptions,
): Error | undefined {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_BUILT_IN_PROCESS_TIMEOUT_MS
  ) {
    return spawnError(
      "EINVAL",
      `process timeoutMs must be a positive safe integer not exceeding ${MAX_BUILT_IN_PROCESS_TIMEOUT_MS}`,
    );
  }
  if (!Number.isSafeInteger(options.maxBuffer) || options.maxBuffer <= 0) {
    return spawnError(
      "EINVAL",
      "process maxBuffer must be a positive safe integer",
    );
  }
  return undefined;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function processAnchorEnvironment(ownershipToken: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    [PROCESS_TREE_TOKEN_ENV]: ownershipToken,
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "ComSpec",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function terminateOwnedPosixTree(
  groupLeaderPid: number,
  child: ReturnType<typeof spawn>,
  ownershipToken: string,
  timeoutMs: number,
  anchorCleanupReported: () => boolean,
  onInitialized: () => void,
): Promise<boolean> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  let anchorExited = child.exitCode !== null || child.signalCode !== null;
  let safe = !anchorExited || anchorCleanupReported();
  if (hasUnownedEscapedDescendant(groupLeaderPid, ownershipToken)) {
    const owned = listOwnedPosixProcesses(ownershipToken);
    if (owned.ok) {
      for (const pid of owned.pids) {
        if (pid !== groupLeaderPid) signalPosixTarget(pid, "SIGKILL");
      }
    }
    killOwnedPosixGroup(groupLeaderPid, child);
    return false;
  }
  const initial = listOwnedPosixProcesses(ownershipToken);
  if (!initial.ok) {
    killOwnedPosixGroup(groupLeaderPid, child);
    return false;
  }

  for (const pid of initial.pids) {
    if (pid === groupLeaderPid) continue;
    const ownership = posixProcessOwnership(pid, ownershipToken);
    if (ownership === "unknown") {
      safe = false;
      continue;
    }
    if (ownership === "owned") {
      safe = signalPosixTarget(pid, "SIGKILL") && safe;
    }
  }
  if (!anchorExited) {
    const groupKilled = killOwnedPosixGroup(groupLeaderPid, child);
    if (!groupKilled) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      anchorExited = child.exitCode !== null || child.signalCode !== null;
      safe = anchorExited && anchorCleanupReported() && safe;
    }
  }
  onInitialized();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = listOwnedPosixProcesses(ownershipToken);
    if (!remaining.ok) return false;
    if (remaining.pids.length === 0) return safe;
    for (const pid of remaining.pids) {
      const ownership = posixProcessOwnership(pid, ownershipToken);
      if (ownership === "unknown") return false;
      if (ownership === "owned") signalPosixTarget(pid, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function hasUnownedEscapedDescendant(
  groupLeaderPid: number,
  ownershipToken: string,
): boolean {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid="], {
    encoding: "utf-8",
    timeout: 1_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0) return true;
  const processes = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (entry): entry is [number, number, number] =>
        entry.length >= 3 && entry.every(Number.isInteger),
    )
    .map(([pid, ppid, processGroupId]) => ({ pid, ppid, processGroupId }));
  const known = new Set([groupLeaderPid]);
  let added: boolean;
  do {
    added = false;
    for (const processRecord of processes) {
      if (known.has(processRecord.ppid) && !known.has(processRecord.pid)) {
        known.add(processRecord.pid);
        added = true;
      }
    }
  } while (added);
  return processes.some(
    (processRecord) =>
      known.has(processRecord.pid) &&
      processRecord.processGroupId !== groupLeaderPid &&
      posixProcessOwnership(processRecord.pid, ownershipToken) !== "owned",
  );
}

type PosixOwnership = "owned" | "not_owned" | "unknown";

function posixProcessOwnership(
  pid: number,
  ownershipToken: string,
): PosixOwnership {
  const marker = `${PROCESS_TREE_TOKEN_ENV}=${ownershipToken}`;
  if (process.platform === "linux") {
    try {
      const environment = fs.readFileSync(`/proc/${pid}/environ`);
      return environment.toString("utf-8").split("\0").includes(marker)
        ? "owned"
        : "not_owned";
    } catch (error) {
      return errnoCode(error) === "ENOENT" ? "not_owned" : "unknown";
    }
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf-8",
    timeout: 500,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined) return "unknown";
  if (result.status !== 0) return "not_owned";
  return result.stdout.includes(marker) ? "owned" : "not_owned";
}

type OwnedPosixProcesses = { ok: true; pids: number[] } | { ok: false };

function listOwnedPosixProcesses(ownershipToken: string): OwnedPosixProcesses {
  const marker = `${PROCESS_TREE_TOKEN_ENV}=${ownershipToken}`;
  if (process.platform === "linux") {
    try {
      const pids = fs
        .readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .filter(
          (pid) => posixProcessOwnership(pid, ownershipToken) === "owned",
        );
      return { ok: true, pids };
    } catch {
      return { ok: false };
    }
  }
  const result = spawnSync("ps", ["eww", "-axo", "pid=,state=,command="], {
    encoding: "utf-8",
    timeout: 1_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false };
  }
  const pids = result.stdout
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line))
    .filter((match) => match !== null && !match[2]?.startsWith("Z"))
    .map((match) => Number(match?.[1]))
    .filter((pid) => Number.isInteger(pid));
  return { ok: true, pids };
}

function killOwnedPosixGroup(
  groupLeaderPid: number,
  child: ReturnType<typeof spawn>,
): boolean {
  let safe = signalPosixTarget(-groupLeaderPid, "SIGKILL");
  if (child.exitCode !== null || child.signalCode !== null) return safe;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") safe = false;
  }
  return safe;
}

function signalPosixTarget(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

/**
 * Discover descendants from retained ParentProcessId values, so cleanup does
 * not depend on the leader still being alive when its `exit` event fires.
 */
function killWindowsProcessTree(
  rootPid: number,
  ownershipToken: string,
  commandIdentity?: {
    pid: number;
    creationTicks?: string;
    startedAtMs: number;
    exitedAtMs?: number;
    exited: boolean;
  },
): Promise<boolean> {
  const hasCommandIdentity =
    commandIdentity !== undefined &&
    Number.isInteger(commandIdentity.pid) &&
    commandIdentity.pid > 0 &&
    typeof commandIdentity.creationTicks === "string" &&
    /^\d+$/.test(commandIdentity.creationTicks) &&
    Number.isInteger(commandIdentity.startedAtMs) &&
    commandIdentity.startedAtMs > 0 &&
    (!commandIdentity.exited ||
      (Number.isInteger(commandIdentity.exitedAtMs) &&
        (commandIdentity.exitedAtMs ?? 0) >= commandIdentity.startedAtMs));
  if (commandIdentity !== undefined && !hasCommandIdentity) {
    return Promise.resolve(false);
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$selfPid = $PID",
    `$rootPid = ${rootPid}`,
    `$ownershipToken = ${JSON.stringify(ownershipToken)}`,
    '$root = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $rootPid)',
    "$identities = [System.Collections.Generic.Dictionary[int,long]]::new()",
    ...(hasCommandIdentity
      ? [
          "if ($null -ne $root -and $root.CommandLine -notlike ('*' + $ownershipToken + '*')) { exit 1 }",
          "if ($null -ne $root) { $identities[$rootPid] = [long]$root.CreationDate.ToUniversalTime().Ticks }",
        ]
      : [
          "if ($null -eq $root -or $root.CommandLine -notlike ('*' + $ownershipToken + '*')) { exit 1 }",
          "$identities[$rootPid] = [long]$root.CreationDate.ToUniversalTime().Ticks",
        ]),
    ...(hasCommandIdentity
      ? [
          `$commandPid = ${commandIdentity.pid}`,
          `$commandCreationTicks = [long]${commandIdentity.creationTicks}`,
          `$commandExited = $${commandIdentity.exited}`,
          `$commandStartedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(${commandIdentity.startedAtMs}).UtcDateTime.Ticks`,
          "$commandExitedAtTicks = 0",
          ...(commandIdentity.exitedAtMs !== undefined
            ? [
                `$commandExitedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(${commandIdentity.exitedAtMs}).UtcDateTime.Ticks`,
              ]
            : []),
          "$identities[$commandPid] = $commandCreationTicks",
        ]
      : []),
    "$stablePasses = 0",
    "$observedRootChild = $false",
    "$watch = [System.Diagnostics.Stopwatch]::StartNew()",
    "while ($watch.ElapsedMilliseconds -lt 3500) {",
    "  $processes = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationTicks = [long]$_.CreationDate.ToUniversalTime().Ticks } })",
    "  $byPid = @{}",
    "  foreach ($item in $processes) { $byPid[$item.ProcessId] = $item }",
    "  foreach ($knownPid in @($identities.Keys)) {",
    "    $current = $byPid[$knownPid]",
    ...(hasCommandIdentity && commandIdentity?.exited !== true
      ? [
          "    if ($knownPid -eq $commandPid -and $null -eq $current) { exit 1 }",
        ]
      : []),
    "    if ($null -eq $current) { continue }",
    "    $expected = [long]$identities[$knownPid]",
    "    if ($expected -gt 0 -and $current.CreationTicks -ne $expected) { exit 1 }",
    "  }",
    "  $added = $false",
    "  do {",
    "    $passAdded = $false",
    "    foreach ($item in $processes) {",
    "      if ($item.ParentProcessId -eq $rootPid) { $observedRootChild = $true }",
    "      if ($item.ProcessId -eq $selfPid -or -not $identities.ContainsKey($item.ParentProcessId)) { continue }",
    ...(hasCommandIdentity && commandIdentity?.exited === true
      ? [
          "      if ($item.ParentProcessId -eq $commandPid -and $commandExited -and $item.CreationTicks -gt $commandExitedAtTicks) { continue }",
        ]
      : []),
    "      $parentIdentity = [Math]::Abs([long]$identities[$item.ParentProcessId])",
    "      if ($item.CreationTicks -lt $parentIdentity) { continue }",
    "      if ($identities.ContainsKey($item.ProcessId)) {",
    "        if ([long]$identities[$item.ProcessId] -ne $item.CreationTicks) { exit 1 }",
    "      } else {",
    "        $identities[$item.ProcessId] = $item.CreationTicks",
    "        $passAdded = $true",
    "        $added = $true",
    "      }",
    "    }",
    "  } while ($passAdded)",
    "  $targets = @($identities.Keys | Where-Object { $_ -ne $selfPid -and $byPid.ContainsKey($_) -and [long]$identities[$_] -eq [long]$byPid[$_].CreationTicks })",
    "  [array]::Reverse($targets)",
    "  $targets | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Milliseconds 50",
    "  $alive = @($identities.Keys | Where-Object { $_ -ne $selfPid -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })",
    "  if ($alive.Count -eq 0 -and -not $added) { $stablePasses += 1 } else { $stablePasses = 0 }",
    `  if ($stablePasses -ge 2 -and ($${hasCommandIdentity} -or $observedRootChild)) { exit 0 }`,
    "}",
    "exit 1",
  ].join("\n");
  return launchWindowsTreeKiller("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
}

function launchWindowsTreeKiller(
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let finished = false;
    const finish = (success: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      resolve(success);
    };
    const deadline = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        // The helper may already have exited.
      }
    }, WINDOWS_PROCESS_TREE_FALLBACK_TIMEOUT_MS);
    killer.once("exit", (code) => finish(code === 0));
    killer.once("error", () => finish(false));
    killer.unref();
  });
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
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

function spawnError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function attachProcessOutput(
  error: Error | undefined,
  stdout: string,
  stderr: string,
): Error {
  return Object.assign(
    error ?? spawnError("SUPERVISOR_FAILED", "process supervisor failed"),
    { stdout, stderr },
  );
}

const LIVE_STEP_ASYNC_GROUP_ANCHOR = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
let command;
let finished = false;
let reported = false;
let input = "";
let executionTimer;
let fallbackTimer;
let ancestryTracker;
let commandStartedAtMs = 0;
let commandExitedAtMs = 0;
let commandCreationTicks;
let commandLaunchFailed = false;
let unsafeDetachedDescendant = false;
const retainedEscapedPids = new Set();
const ownershipMarker = "MOMENTUM_PROCESS_TREE_TOKEN=" + process.env.MOMENTUM_PROCESS_TREE_TOKEN;

function readWindowsCreationTicks(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid)) return undefined;
  const script = "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId = " + pid + "\"); if ($null -eq $p) { exit 1 }; [Console]::Out.Write([long]$p.CreationDate.ToUniversalTime().Ticks)";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const value = result.stdout && result.stdout.trim();
  return !result.error && result.status === 0 && /^\d+$/.test(value) ? value : undefined;
}

function ownedPosixPids() {
  if (process.platform === "linux") {
    try {
      return fs.readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .filter((pid) => {
          try {
            return fs.readFileSync("/proc/" + pid + "/environ", "utf-8")
              .split("\0").includes(ownershipMarker);
          } catch { return false; }
        });
    } catch { return undefined; }
  }
  const result = spawnSync("ps", ["eww", "-axo", "pid=,state=,command="], {
    encoding: "utf-8",
    timeout: 1000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split("\n")
    .filter((line) => line.includes(ownershipMarker))
    .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line))
    .filter((match) => match !== null && !match[2]?.startsWith("Z"))
    .map((match) => Number(match?.[1]))
    .filter((pid) => Number.isInteger(pid))
    .filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
}

function refreshDetachedDescendants() {
  if (process.platform === "win32") return;
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid="], {
    encoding: "utf-8",
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) {
    unsafeDetachedDescendant = true;
    return;
  }
  const processes = result.stdout.split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((entry) => entry.length >= 3 && entry.every(Number.isInteger))
    .map(([pid, ppid, processGroupId]) => ({ pid, ppid, processGroupId }));
  const known = new Set([process.pid]);
  let added;
  do {
    added = false;
    for (const entry of processes) {
      if (known.has(entry.ppid) && !known.has(entry.pid)) {
        known.add(entry.pid);
        added = true;
      }
    }
  } while (added);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const pid of retainedEscapedPids) {
    if (!byPid.has(pid)) {
      retainedEscapedPids.delete(pid);
    }
  }
  for (const entry of processes) {
    if (known.has(entry.pid) && entry.processGroupId !== process.pid) {
      retainedEscapedPids.add(entry.pid);
    }
  }
  if (retainedEscapedPids.size === 0) return;
  const ownedPids = ownedPosixPids();
  if (!ownedPids) {
    unsafeDetachedDescendant = true;
    return;
  }
  const owned = new Set(ownedPids);
  for (const pid of retainedEscapedPids) {
    if (!owned.has(pid)) unsafeDetachedDescendant = true;
  }
}

function emitMeta(meta) {
  try { fs.writeSync(3, JSON.stringify(meta) + "\n"); } catch {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killOwnedTree() {
  if (finished) return;
  refreshDetachedDescendants();
  emitMeta({
    status: null,
    signal: null,
    unsafeDetachedDescendant,
    cleanupOnly: true
  });
  finished = true;
  if (executionTimer) clearTimeout(executionTimer);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  if (ancestryTracker) clearInterval(ancestryTracker);
  if (process.platform === "win32") {
    const commandPid = command && command.pid;
    if (commandLaunchFailed && !Number.isInteger(commandPid)) {
      if (!unsafeDetachedDescendant) {
        emitMeta({
          status: null,
          signal: null,
          cleanupOnly: true,
          cleanupSucceeded: true
        });
      }
      process.exit(unsafeDetachedDescendant ? 1 : 0);
    }
    const commandExited = command.exitCode !== null || command.signalCode !== null;
    if (!Number.isInteger(commandPid) || commandPid <= 0 || !/^\d+$/.test(commandCreationTicks || "") || commandStartedAtMs <= 0 || (commandExited && commandExitedAtMs < commandStartedAtMs)) {
      process.exit(1);
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$selfPid = $PID",
      "$rootPid = " + process.pid,
      "$commandPid = " + commandPid,
      "$commandCreationTicks = [long]" + commandCreationTicks,
      "$commandExited = $" + commandExited,
      "$commandStartedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(" + commandStartedAtMs + ").UtcDateTime.Ticks",
      "$commandExitedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(" + commandExitedAtMs + ").UtcDateTime.Ticks",
      "$identities = [System.Collections.Generic.Dictionary[int,long]]::new()",
      "$root = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $rootPid)",
      "if ($null -eq $root) { exit 1 }",
      "$identities[$rootPid] = [long]$root.CreationDate.ToUniversalTime().Ticks",
      "$identities[$commandPid] = $commandCreationTicks",
      "$stablePasses = 0",
      "$watch = [System.Diagnostics.Stopwatch]::StartNew()",
      "while ($watch.ElapsedMilliseconds -lt 2500 -and $stablePasses -lt 2) {",
      "  $processes = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationTicks = [long]$_.CreationDate.ToUniversalTime().Ticks } })",
      "  $byPid = @{}",
      "  foreach ($item in $processes) { $byPid[$item.ProcessId] = $item }",
      "  foreach ($knownPid in @($identities.Keys)) {",
      "    $current = $byPid[$knownPid]",
      "    if ($knownPid -eq $commandPid -and -not $commandExited -and $null -eq $current) { exit 1 }",
      "    if ($null -eq $current) { continue }",
      "    $expected = [long]$identities[$knownPid]",
      "    if ($expected -gt 0 -and $current.CreationTicks -ne $expected) { exit 1 }",
      "  }",
      "  $added = $false",
      "  do {",
      "    $passAdded = $false",
      "    foreach ($item in $processes) {",
      "      if ($item.ProcessId -eq $selfPid -or -not $identities.ContainsKey($item.ParentProcessId)) { continue }",
      "      if ($item.ParentProcessId -eq $commandPid -and $commandExited -and $item.CreationTicks -gt $commandExitedAtTicks) { continue }",
      "      $parentIdentity = [Math]::Abs([long]$identities[$item.ParentProcessId])",
      "      if ($item.CreationTicks -lt $parentIdentity) { continue }",
      "      if ($identities.ContainsKey($item.ProcessId)) {",
      "        $expected = [long]$identities[$item.ProcessId]",
      "        if ($expected -gt 0 -and $item.CreationTicks -ne $expected) { exit 1 }",
      "      } else {",
      "        $identities[$item.ProcessId] = $item.CreationTicks",
      "        $passAdded = $true",
      "        $added = $true",
      "      }",
      "    }",
      "  } while ($passAdded)",
      "  $targets = @($identities.Keys | Where-Object { $_ -ne $rootPid -and $_ -ne $selfPid -and $byPid.ContainsKey($_) -and [long]$identities[$_] -eq [long]$byPid[$_].CreationTicks })",
      "  [array]::Reverse($targets)",
      "  $targets | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      "  Start-Sleep -Milliseconds 50",
      "  $alive = @($identities.Keys | Where-Object { $_ -ne $rootPid -and $_ -ne $selfPid -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })",
      "  if ($alive.Count -eq 0 -and -not $added) { $stablePasses += 1 } else { $stablePasses = 0 }",
      "  }",
      "if ($stablePasses -ge 2) { exit 0 } else { exit 1 }"
    ].join("\n");
    const cleanup = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 3000,
      stdio: "ignore"
    });
    const cleanupSucceeded = cleanup.status === 0 && !cleanup.error && !unsafeDetachedDescendant;
    if (cleanupSucceeded) {
      emitMeta({
        status: null,
        signal: null,
        cleanupOnly: true,
        cleanupSucceeded: true
      });
    }
    process.exit(cleanupSucceeded ? 0 : 1);
  }
  let stablePasses = 0;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && stablePasses < 2) {
    const owned = ownedPosixPids();
    if (!owned) {
      stablePasses = 0;
      sleep(50);
      continue;
    }
    const targets = owned.filter((pid) => pid !== process.pid);
    for (const pid of targets) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    stablePasses = targets.length === 0 ? stablePasses + 1 : 0;
    sleep(50);
  }
  if (stablePasses >= 2 && !unsafeDetachedDescendant) {
    emitMeta({
      status: null,
      signal: null,
      cleanupOnly: true,
      cleanupSucceeded: true
    });
  }
  try { process.kill(-process.pid, "SIGKILL"); } catch {}
  process.exit(1);
}

function reportThenAwaitCleanup(meta) {
  if (finished || reported) return;
  reported = true;
  refreshDetachedDescendants();
  emitMeta({
    ...meta,
    commandStartedAtMs,
    commandCreationTicks,
    commandExitedAtMs: commandExitedAtMs > 0 ? commandExitedAtMs : undefined,
    commandExited:
      meta.commandExited === true ||
      (command && (command.exitCode !== null || command.signalCode !== null)),
    unsafeDetachedDescendant
  });
  fallbackTimer = setTimeout(killOwnedTree, 5000);
}

function launch(request) {
  try {
    commandStartedAtMs = Date.now();
    command = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      detached: false,
      stdio: ["ignore", "inherit", "inherit"]
    });
    commandCreationTicks = readWindowsCreationTicks(command.pid);
  } catch (error) {
    commandLaunchFailed = true;
    reportThenAwaitCleanup({
      status: null,
      signal: null,
      errorCode: error && error.code ? error.code : "SPAWN_ERROR",
      errorMessage: error && error.message ? error.message : String(error)
    });
    return;
  }
  executionTimer = setTimeout(() => {
    reportThenAwaitCleanup({
      pid: command.pid,
      status: null,
      signal: null,
      errorCode: "ETIMEDOUT",
      errorMessage: "process timed out after " + request.timeoutMs + "ms"
    });
  }, request.timeoutMs);
  command.once("error", (error) => {
    if (!Number.isInteger(command.pid)) commandLaunchFailed = true;
    reportThenAwaitCleanup({
      pid: command.pid,
      status: null,
      signal: null,
      errorCode: error && error.code ? error.code : "SPAWN_ERROR",
      errorMessage: error && error.message ? error.message : String(error)
    });
  });
  command.once("exit", (status, signal) => {
    commandExitedAtMs = Date.now();
    if (executionTimer) clearTimeout(executionTimer);
    reportThenAwaitCleanup({
      pid: command.pid,
      status,
      signal,
      commandExited: true
    });
  });
  if (process.platform !== "win32") {
    refreshDetachedDescendants();
    ancestryTracker = setInterval(refreshDetachedDescendants, 250);
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (command !== undefined) {
      if (line === "kill") killOwnedTree();
    } else {
      try {
        launch(JSON.parse(line));
      } catch (error) {
        reportThenAwaitCleanup({
          status: null,
          signal: null,
          errorCode: "SUPERVISOR_FAILED",
          errorMessage: error && error.message ? error.message : String(error)
        });
      }
    }
    newline = input.indexOf("\n");
  }
});
process.stdin.on("end", killOwnedTree);
process.stdin.on("error", killOwnedTree);
process.stdin.resume();
`;

const LIVE_STEP_PROCESS_GROUP_HELPER = String.raw`
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const [requestPath, metaPath, stdoutPath, stderrPath] = process.argv.slice(1);
const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
let child;
let finished = false;
let cleanupResult;
let commandStartedAtMs = 0;
let commandExitedAtMs = 0;
let commandCreationTicks;
const state = {
  stdoutBytes: 0,
  stderrBytes: 0,
  errorCode: undefined,
  errorMessage: undefined
};
const ownershipMarker = "MOMENTUM_PROCESS_TREE_TOKEN=" + request.env.MOMENTUM_PROCESS_TREE_TOKEN;
function ownedPosixPids() {
  if (process.platform === "linux") {
    try {
      return fs.readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .filter((pid) => {
          try {
            const state = fs.readFileSync("/proc/" + pid + "/stat", "utf-8").split(" ")[2];
            if (state === "Z") return false;
            return fs.readFileSync("/proc/" + pid + "/environ", "utf-8").split("\0").includes(ownershipMarker);
          } catch { return false; }
        });
    } catch { return undefined; }
  }
  const result = spawnSync("ps", ["eww", "-axo", "pid=,state=,command="], {
    encoding: "utf-8",
    timeout: 1000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split("\n")
    .filter((line) => line.includes(ownershipMarker))
    .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line))
    .filter((match) => match !== null && !match[2]?.startsWith("Z"))
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isInteger(pid));
}
function readWindowsCreationTicks(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid)) return undefined;
  const script = "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId = " + pid + "\"); if ($null -eq $p) { exit 1 }; [Console]::Out.Write([long]$p.CreationDate.ToUniversalTime().Ticks)";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const value = result.stdout && result.stdout.trim();
  return !result.error && result.status === 0 && /^\d+$/.test(value) ? value : undefined;
}
function writeMeta(status, signal) {
  fs.writeFileSync(metaPath, JSON.stringify({
    pid: child && child.pid,
    status,
    signal,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage
  }));
}
function killTree(commandExited = false, commandStatus = null, commandSignal = null) {
  if (cleanupResult !== undefined) return cleanupResult;
  if (!child || child.pid === undefined) {
    cleanupResult = true;
    return cleanupResult;
  }
  if (process.platform !== "win32") {
    let stablePasses = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && stablePasses < 2) {
      const owned = ownedPosixPids();
      if (!owned) break;
      for (const pid of owned) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      stablePasses = owned.length === 0 ? stablePasses + 1 : 0;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    cleanupResult = stablePasses >= 2;
    if (!cleanupResult) {
      state.errorCode = "SUPERVISOR_FAILED";
      state.errorMessage = "ownership-checked POSIX process-tree cleanup failed";
      writeMeta(commandStatus, commandSignal);
    }
    return cleanupResult;
  }
  if (!/^\d+$/.test(commandCreationTicks || "") || (commandExited && commandExitedAtMs < commandStartedAtMs)) {
    cleanupResult = false;
    state.errorCode = "SUPERVISOR_FAILED";
    state.errorMessage = "ownership-checked Windows process-tree cleanup failed";
    writeMeta(commandStatus, commandSignal);
    return cleanupResult;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$selfPid = $PID",
    "$rootPid = " + process.pid,
    "$commandPid = " + child.pid,
    "$commandCreationTicks = [long]" + commandCreationTicks,
    "$commandExited = $" + commandExited,
    "$commandStartedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(" + commandStartedAtMs + ").UtcDateTime.Ticks",
    "$commandExitedAtTicks = [DateTimeOffset]::FromUnixTimeMilliseconds(" + commandExitedAtMs + ").UtcDateTime.Ticks",
    "$identities = [System.Collections.Generic.Dictionary[int,long]]::new()",
    "$root = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $rootPid)",
    "if ($null -eq $root) { exit 1 }",
    "$identities[$rootPid] = [long]$root.CreationDate.ToUniversalTime().Ticks",
    "$identities[$commandPid] = $commandCreationTicks",
    "$stablePasses = 0",
    "$watch = [System.Diagnostics.Stopwatch]::StartNew()",
    "while ($watch.ElapsedMilliseconds -lt 2500 -and $stablePasses -lt 2) {",
    "  $processes = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreationTicks = [long]$_.CreationDate.ToUniversalTime().Ticks } })",
    "  $byPid = @{}",
    "  foreach ($item in $processes) { $byPid[$item.ProcessId] = $item }",
    "  foreach ($knownPid in @($identities.Keys)) {",
    "    $current = $byPid[$knownPid]",
    "    if ($knownPid -eq $commandPid -and -not $commandExited -and $null -eq $current) { exit 1 }",
    "    if ($null -eq $current) { continue }",
    "    $expected = [long]$identities[$knownPid]",
    "    if ($expected -gt 0 -and $current.CreationTicks -ne $expected) { exit 1 }",
    "  }",
    "  $added = $false",
    "  do {",
    "    $passAdded = $false",
    "    foreach ($item in $processes) {",
    "      if ($item.ProcessId -eq $selfPid -or -not $identities.ContainsKey($item.ParentProcessId)) { continue }",
    "      if ($item.ParentProcessId -eq $commandPid -and $commandExited -and $item.CreationTicks -gt $commandExitedAtTicks) { continue }",
    "      $parentIdentity = [Math]::Abs([long]$identities[$item.ParentProcessId])",
    "      if ($item.CreationTicks -lt $parentIdentity) { continue }",
    "      if ($identities.ContainsKey($item.ProcessId)) {",
    "        $expected = [long]$identities[$item.ProcessId]",
    "        if ($expected -gt 0 -and $item.CreationTicks -ne $expected) { exit 1 }",
    "      } else {",
    "        $identities[$item.ProcessId] = $item.CreationTicks",
    "        $passAdded = $true",
    "        $added = $true",
    "      }",
    "    }",
    "  } while ($passAdded)",
    "  $targets = @($identities.Keys | Where-Object { $_ -ne $rootPid -and $_ -ne $selfPid -and $byPid.ContainsKey($_) -and [long]$identities[$_] -eq [long]$byPid[$_].CreationTicks })",
    "  [array]::Reverse($targets)",
    "  $targets | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Milliseconds 50",
    "  $alive = @($identities.Keys | Where-Object { $_ -ne $rootPid -and $_ -ne $selfPid -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })",
    "  if ($alive.Count -eq 0 -and -not $added) { $stablePasses += 1 } else { $stablePasses = 0 }",
    "}",
    "if ($stablePasses -ge 2) { exit 0 } else { exit 1 }"
  ].join("\n");
  const cleanup = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 3000,
    stdio: "ignore"
  });
  cleanupResult = cleanup.status === 0 && !cleanup.error;
  if (!cleanupResult) {
    // Cleanup proof is a safety precondition for settlement, even when the
    // command exited successfully. Retain its outcome for diagnostics without
    // converting an unverified tree into a successful step.
    state.errorCode = "SUPERVISOR_FAILED";
    state.errorMessage = "ownership-checked Windows process-tree cleanup failed";
    writeMeta(commandStatus, commandSignal);
    process.exit(0);
  }
  return cleanupResult;
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
  commandStartedAtMs = Date.now();
  child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  commandCreationTicks = readWindowsCreationTicks(child.pid);
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
child.on("exit", (status, signal) => {
  commandExitedAtMs = Date.now();
  killTree(true, status, signal);
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
  killTree(true, status, signal);
  writeMeta(status, signal);
});
`;

function checkRuntimeAvailability(
  command: string,
): { ok: true } | { ok: false; error: string } {
  if (!path.isAbsolute(command)) {
    return {
      ok: false,
      error: `live step runtime ${command} must be an absolute executable path.`,
    };
  }
  try {
    const stat = fs.statSync(command);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: `live step runtime ${command} exists but is not a regular file.`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return {
        ok: false,
        error: `live step runtime ${command} is not installed at the configured path.`,
      };
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `live step runtime ${command} is not accessible: ${detail}`,
    };
  }
}

function resolveResultJsonPath(
  iterationDir: string,
  resultFile: string,
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
        "live step result_file must resolve inside the iteration artifact directory.",
    };
  }
  return { ok: true, path: resolved };
}

function validateResultPathContainment(
  iterationDir: string,
  resultJsonPath: string,
): { ok: true } | { ok: false; error: string } {
  let baseReal: string;
  try {
    baseReal = fs.realpathSync(iterationDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `live step result_file base directory is not accessible: ${detail}`,
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
              "the iteration artifact directory.",
          };
        }
        existing = parent;
        continue;
      }
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        error: `live step result_file parent directory is not accessible: ${detail}`,
      };
    }

    if (!stat.isDirectory()) {
      return {
        ok: false,
        error:
          "live step result_file must not traverse a symlink or non-directory parent.",
      };
    }

    let existingReal: string;
    try {
      existingReal = fs.realpathSync(existing);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        ok: false,
        error: `live step result_file parent directory is not accessible: ${detail}`,
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
          "live step result_file must remain inside the iteration artifact directory.",
      };
    }
    return { ok: true };
  }
}

function resolveCwd(
  config: LiveWrapperConfig,
  input: LiveStepWrapperInput,
): string {
  return config.cwd === "iteration" ? input.iterationDir : input.repoPath;
}

function resolveEnv(
  config: LiveWrapperConfig,
  input: LiveStepWrapperInput,
  resultJsonPath: string,
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
  if (input.agentProvider !== undefined && input.agentProvider !== null) {
    env[LIVE_STEP_WRAPPER_ENV_VARS.AGENT_PROVIDER] = input.agentProvider;
  }
  if (input.model !== undefined && input.model !== null) {
    env[LIVE_STEP_WRAPPER_ENV_VARS.MODEL] = input.model;
  }
  if (input.effort !== undefined && input.effort !== null) {
    env[LIVE_STEP_WRAPPER_ENV_VARS.EFFORT] = input.effort;
  }
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
  chunk: unknown,
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[live-step] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeSupervisorFailureOutput(
  handle: number,
  error: unknown,
  stdoutLabel: "stdout" | "probe stdout",
  stderrLabel: "stderr" | "probe stderr",
): void {
  if (typeof error !== "object" || error === null) return;
  const output = error as { stdout?: unknown; stderr?: unknown };
  writeLog(handle, stdoutLabel, output.stdout);
  writeLog(handle, stderrLabel, output.stderr);
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}

function clearResultFile(
  logHandle: number,
  resultJsonPath: string,
  iterationDir: string,
): { ok: true } | { ok: false; error: string } {
  const pathSafety = validateResultPathContainment(
    iterationDir,
    resultJsonPath,
  );
  if (!pathSafety.ok) {
    writeLine(
      logHandle,
      `[live-step] result_clear_failed: ${pathSafety.error}`,
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
      error: `live step result file at ${resultJsonPath} could not be cleared before execution: ${detail}`,
    };
  }
}

function readResultFile(
  logHandle: number,
  resultJsonPath: string,
  iterationDir: string,
):
  | { ok: true; raw: string }
  | { ok: false; code: "result_missing" | "result_invalid"; error: string } {
  const pathSafety = validateResultPathContainment(
    iterationDir,
    resultJsonPath,
  );
  if (!pathSafety.ok) {
    writeLine(logHandle, `[live-step] result_invalid: ${pathSafety.error}`);
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return {
      ok: false,
      code: "result_invalid",
      error: pathSafety.error,
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
        error: `live step result file was not written at ${resultJsonPath}.`,
      };
    }
    writeLine(logHandle, `[live-step] result_unreadable: ${detail}`);
    writeLine(logHandle, "[live-step] summary: result file unreadable");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} is unreadable: ${detail}`,
    };
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    writeLine(logHandle, `[live-step] result_not_file: ${resultJsonPath}`);
    writeLine(logHandle, "[live-step] summary: result file invalid");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} is not a regular file.`,
    };
  }

  if (stat.size > LIVE_STEP_WRAPPER_RESULT_MAX_BYTES) {
    writeLine(
      logHandle,
      `[live-step] result_too_large: ${stat.size} bytes exceeds ${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES}`,
    );
    writeLine(logHandle, "[live-step] summary: result file too large");
    return {
      ok: false,
      code: "result_invalid",
      error: `live step result file at ${resultJsonPath} exceeds ${LIVE_STEP_WRAPPER_RESULT_MAX_BYTES} bytes.`,
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
      error: `live step result file at ${resultJsonPath} is unreadable: ${detail}`,
    };
  }
}

function errnoCode(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

function throwProcessCancellation(
  result: SpawnSyncReturns<string>,
  signal: AbortSignal,
): never {
  if (signal.aborted) signal.throwIfAborted();
  throw result.error ?? spawnError("ABORT_ERR", "process cancelled");
}

function wrapperError(
  executorLogPath: string,
  resultJsonPath: string | undefined,
  code: LiveStepWrapperRecoveryCode,
  error: string,
): LiveStepWrapperError {
  return { ok: false, code, error, resultJsonPath, executorLogPath };
}

function isCodingWorkflowWrapperInvocation(config: LiveWrapperConfig): boolean {
  return config.args.some((arg) =>
    arg.includes("coding-workflow-live-wrapper-cli"),
  );
}
