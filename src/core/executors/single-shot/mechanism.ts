/**
 * Runtime mechanisms for the single-shot executor families.
 *
 * `one-shot` delegates to the live-step wrapper and therefore requires a
 * normalized `RunnerResult` document on success. `script` runs an absolute
 * deterministic command with explicit argv/env/cwd, bounded stdout/stderr, and
 * succeeds from exit code plus log evidence without writing a result document.
 * Abort-aware runs preserve output captured through cancellation and decode
 * streaming UTF-8 safely before propagating the cancellation reason.
 * Both mechanisms refuse native Windows with `unsupported_platform` before a
 * supervised command is spawned.
 *
 * Both mechanisms enforce repo-safety at the boundary. `read-only` snapshots
 * require a clean repo before and after the command. `finalize` requires the
 * caller's `baseHead` to be a 40-character SHA, match current HEAD, and start
 * from a clean worktree before mapping verification, commit, reset, lock, and
 * git outcomes through the same recovery codes used by live workflow-step
 * finalization. Callers must supply absolute artifact log paths on the round;
 * `script` configs must also use an absolute executable path and absolute cwd.
 */
import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  listCommittedChangedFiles,
  resetToBase,
} from "../../../adapters/git-transaction.js";
import {
  finalizeWorkflowStep,
  type FinalizeWorkflowStepResult,
} from "../shared/step-finalize.js";
import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  processExecutionPlatformError,
  runProcessGroup,
  runLiveStepWrapper,
  runLiveStepWrapperAsync,
  runProcessGroupSync,
  type LiveStepWrapperRecoveryCode,
} from "../../../adapters/live-step-wrapper.js";
import type { LiveWrapperConfig } from "../../../adapters/live-wrapper-registry.js";
import { MAX_BUILT_IN_PROCESS_TIMEOUT_SEC } from "../../../shared/process-limits.js";
import type { ExecutorRoundRecord } from "../loop/reducer.js";
import type { CommitIntent } from "../runner/types.js";
import type {
  SingleShotArtifactPointer,
  SingleShotRoundArtifacts,
  SingleShotRoundEvidence,
  SingleShotVerificationStatus,
} from "./executor.js";
import type { SingleShotRecoveryCode } from "./executor.js";
import type {
  HybridSingleShotRoundRunner,
  SingleShotRoundMechanismResult,
} from "./orchestrator.js";
import {
  isPortableScriptCommandIdentity,
  type AgentExecutorConfig,
  type SingleShotRoundRunnerContext,
} from "./sdk.js";
import type { WorkflowStepKind } from "../../workflow/run/reducer.js";

export type OneShotLiveWrapperRoundRunnerOptions = {
  /** Absolute repository root passed to the live wrapper and safety checks. */
  repoPath: string;
  /** Workflow step kind forwarded to the live-wrapper registry entry. */
  kind: WorkflowStepKind;
  /** Optional prompt artifact forwarded as MOMENTUM_PROMPT_PATH. */
  promptPath?: string;
  /** Base environment filtered by the live-wrapper allowlist. */
  env?: NodeJS.ProcessEnv;
  /** Per-stream output cap for the wrapped process. */
  outputMaxBytes?: number;
  /** Host-resolved agent/policy identity checked against portable SDK intent. */
  hostIdentity?: OneShotLiveWrapperHostIdentity;
  /** Whether the runner must preserve repo state or finalize mutations. */
  repoSafety: OneShotRepoSafetyConfig;
};

export type OneShotLiveWrapperHostIdentity = {
  agent?: Readonly<AgentExecutorConfig>;
  policyEnvelope?: string;
};

type RepoMutationGuard = {
  /** Ownership proof required immediately before cancellation cleanup mutates git. */
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

export type SingleShotFinalizationConfig = {
  /** Expected 40-character HEAD SHA before the command and finalization. */
  baseHead: string;
  /** Verification commands run by live-step finalization. */
  verificationCommands: string[];
  /** Timeout applied to each verification command. */
  verificationTimeoutSec: number;
  /** Absolute log path for verification output evidence. */
  verificationLogPath: string;
  /** Optional repo-lock hook invoked immediately before git mutation. */
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

/**
 * Repo-safety policy for `one-shot` runners. `read-only` rejects any HEAD or
 * worktree change; `finalize` allows mutations only through the shared
 * verification / commit / reset finalizer.
 */
export type OneShotRepoSafetyConfig =
  | ({ mode: "read-only" } & RepoMutationGuard)
  | ({ mode: "finalize" } & SingleShotFinalizationConfig);

/**
 * Repo-safety policy for deterministic scripts. Finalizing scripts need an
 * explicit commit intent because they do not emit a normalized result document.
 */
export type ScriptRepoSafetyConfig =
  | ({ mode: "read-only" } & RepoMutationGuard)
  | ({
      mode: "finalize";
      commitIntent: CommitIntent;
    } & SingleShotFinalizationConfig);

export type ScriptCommandRoundRunnerConfig = {
  /** Portable command identity resolved to {@link command}; defaults to its basename. */
  commandIdentity?: string;
  /** Absolute executable path; no shell lookup or interpolation is used. */
  command: string;
  /** Explicit argv passed to the executable. */
  args?: readonly string[];
  /** Absolute working directory and repo root for safety/finalization checks. */
  cwd: string;
  /** Positive command timeout in seconds within the built-in supervisor limit. */
  timeoutSec: number;
  /** Host-resolved policy identity checked against portable policy intent. */
  policyEnvelopeIdentity?: string;
  /** Complete child environment for the deterministic command. */
  env?: NodeJS.ProcessEnv;
  /** Per-stream stdout/stderr output cap. */
  outputMaxBytes?: number;
  /** Whether the runner must preserve repo state or finalize mutations. */
  repoSafety: ScriptRepoSafetyConfig;
};

const DEFAULT_SCRIPT_OUTPUT_MAX_BYTES = LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES;
const SHA40_RE = /^[0-9a-f]{40}$/;

/**
 * Build a `one-shot` round runner around a live-wrapper registry entry.
 *
 * The returned runner accepts only `one-shot` rounds with an artifact root and
 * absolute log path. Success requires the wrapped process to emit a valid
 * `RunnerResult`; failures and unsafe repo-finalization outcomes are converted
 * into stable single-shot recovery codes for the orchestrator.
 */
export function createOneShotLiveWrapperRoundRunner(
  config: LiveWrapperConfig,
  options: OneShotLiveWrapperRoundRunnerOptions,
): HybridSingleShotRoundRunner {
  const runner = (
    round: ExecutorRoundRecord,
    context?: SingleShotRoundRunnerContext,
  ) => {
    if (round.executorFamily !== "one-shot") {
      return invalidInput(
        "one-shot live wrapper runner requires one-shot round",
      );
    }
    if (context !== undefined) {
      const portableValidation = validatePortableOneShotConfig(
        context.config,
        config,
        options.hostIdentity,
      );
      if (!portableValidation.ok) return invalidInput(portableValidation.error);
    }
    const logPath = primaryLogPath(round);
    if (round.artifactRoot === null || logPath === null) {
      return invalidInput(
        "one-shot live wrapper rounds require artifactRoot and a log path",
      );
    }
    if (!isUsableAbsolutePath(logPath)) {
      return invalidInput(
        "one-shot live wrapper rounds require an absolute log path",
      );
    }
    const platformError = processExecutionPlatformError();
    if (platformError !== undefined) {
      return unsupportedPlatformRecovery(
        logPath,
        "one-shot",
        platformError.message,
      );
    }
    if (options.repoSafety.mode === "finalize") {
      const recoveryCode = finalizeRepoReadyRecoveryCode(
        options.repoPath,
        options.repoSafety.baseHead,
      );
      if (recoveryCode !== null) return readOnlyRecovery(recoveryCode);
    }
    const readOnlySnapshot = captureReadOnlyRepoSnapshot(options.repoPath, [
      round.artifactRoot,
      logPath,
      ...(options.repoSafety.mode === "finalize"
        ? [options.repoSafety.verificationLogPath]
        : []),
    ]);
    if (!readOnlySnapshot.ok) {
      return readOnlyRecovery(readOnlySnapshot.recoveryCode);
    }

    const wrapperInput = {
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
        : {}),
    };
    if (context !== undefined) {
      context.signal.throwIfAborted();
      return runOneShotLiveWrapperAsync(
        wrapperInput,
        options,
        readOnlySnapshot.snapshot,
        context.signal,
      );
    }

    let result: ReturnType<typeof runLiveStepWrapper>;
    try {
      result = runLiveStepWrapper(wrapperInput);
    } catch {
      return oneShotWrapperThrow(options, readOnlySnapshot.snapshot);
    }
    return finishOneShotWrapperResult(
      result,
      options,
      readOnlySnapshot.snapshot,
    );
  };
  return runner as HybridSingleShotRoundRunner;
}

async function runOneShotLiveWrapperAsync(
  input: Parameters<typeof runLiveStepWrapper>[0],
  options: OneShotLiveWrapperRoundRunnerOptions,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
  signal: AbortSignal,
): Promise<SingleShotRoundMechanismResult> {
  let result: Awaited<ReturnType<typeof runLiveStepWrapperAsync>>;
  try {
    result = await runLiveStepWrapperAsync(input, signal);
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      cleanupOneShotRepoAfterCancellation(options, readOnlySnapshot);
      signal.throwIfAborted();
      throw error;
    }
    if (isProcessSupervisorFailure(error)) throw error;
    const mechanism = oneShotWrapperThrow(
      oneShotOptionsWithCancellationGuard(options, signal),
      readOnlySnapshot,
    );
    throwIfOneShotCancelledAfterFinalization(signal, options, readOnlySnapshot);
    return mechanism;
  }
  const finalizationSignal = finalizationSignalAfterSettledProcess(signal);
  const mechanism = finishOneShotWrapperResult(
    result,
    oneShotOptionsWithCancellationGuard(options, finalizationSignal),
    readOnlySnapshot,
  );
  throwIfOneShotCancelledAfterFinalization(
    finalizationSignal,
    options,
    readOnlySnapshot,
  );
  return mechanism;
}

function oneShotWrapperThrow(
  options: OneShotLiveWrapperRoundRunnerOptions,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): SingleShotRoundMechanismResult {
  const artifacts: SingleShotRoundArtifacts = {};
  if (options.repoSafety.mode === "read-only") {
    const repoRecoveryCode = readOnlyRepoRecoveryCode(
      options.repoPath,
      readOnlySnapshot,
    );
    return {
      outcome: {
        ok: false,
        recoveryCode: repoRecoveryCode ?? "runtime_unavailable",
      },
      artifacts,
    };
  }
  return finalizeOneShotProcessFailure(
    options,
    "runtime_unavailable",
    artifacts,
  );
}

function finishOneShotWrapperResult(
  result: ReturnType<typeof runLiveStepWrapper>,
  options: OneShotLiveWrapperRoundRunnerOptions,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): SingleShotRoundMechanismResult {
  if (!result.ok) {
    const artifacts = artifactPointers(result.resultJsonPath, null);
    const recoveryCode = liveRecoveryCode(result.code);
    if (options.repoSafety.mode === "read-only") {
      const repoRecoveryCode = readOnlyRepoRecoveryCode(
        options.repoPath,
        readOnlySnapshot,
      );
      return {
        outcome: {
          ok: false,
          recoveryCode: repoRecoveryCode ?? recoveryCode,
        },
        summary: result.error,
        artifacts,
      };
    }
    return {
      ...finalizeOneShotProcessFailure(options, recoveryCode, artifacts),
      summary: result.error,
    };
  }

  const digest = digestFile(result.resultJsonPath);
  const artifacts = artifactPointers(result.resultJsonPath, digest);
  if (result.result.success !== true) {
    const finalized = finalizeOneShotResult(
      options,
      result.result,
      false,
      artifacts,
      readOnlySnapshot,
    );
    if (finalized !== null) return finalized;
    return {
      outcome: { ok: false, recoveryCode: "command_failed" },
      artifacts,
    };
  }

  const finalized = finalizeOneShotResult(
    options,
    result.result,
    true,
    artifacts,
    readOnlySnapshot,
    digest,
  );
  if (finalized !== null) {
    return {
      ...finalized,
      result: result.result,
      ...(digest !== null ? { resultDigest: digest } : {}),
    };
  }
  return {
    outcome: { ok: true },
    result: result.result,
    ...(digest !== null ? { resultDigest: digest } : {}),
    artifacts,
  };
}

/**
 * Build a deterministic `script` round runner.
 *
 * The runner requires an absolute command, absolute cwd, a positive timeout no
 * greater than the shared built-in process ceiling, and at least one absolute
 * round log path. Invalid host config returns `invalid_input` before either
 * execution path launches the command. A zero exit code is the success signal;
 * stdout/stderr plus the exit metadata are the evidence, so no normalized result
 * document or result digest is produced for script success.
 */
export function createScriptCommandRoundRunner(
  config: ScriptCommandRoundRunnerConfig,
): HybridSingleShotRoundRunner {
  const runner = (
    round: ExecutorRoundRecord,
    context?: SingleShotRoundRunnerContext,
  ) => {
    if (round.executorFamily !== "script") {
      return invalidInput("script command runner requires script round");
    }
    const validation = validateScriptCommandConfig(config);
    if (!validation.ok) return invalidInput(validation.error);
    if (context !== undefined) {
      const portable = validatePortableScriptConfig(context.config, config);
      if (!portable.ok) return invalidInput(portable.error);
      context.signal.throwIfAborted();
    }

    const logPath = primaryLogPath(round);
    if (logPath === null) {
      return invalidInput("script rounds require at least one log path");
    }
    if (!isUsableAbsolutePath(logPath)) {
      return invalidInput("script rounds require an absolute log path");
    }
    const platformError = processExecutionPlatformError();
    if (platformError !== undefined) {
      return unsupportedPlatformRecovery(
        logPath,
        "script",
        platformError.message,
      );
    }
    if (config.repoSafety.mode === "finalize") {
      const recoveryCode = finalizeRepoReadyRecoveryCode(
        config.cwd,
        config.repoSafety.baseHead,
      );
      if (recoveryCode !== null) return readOnlyRecovery(recoveryCode);
    }
    const readOnlySnapshot = captureReadOnlyRepoSnapshot(config.cwd, [
      round.artifactRoot,
      logPath,
      ...(config.repoSafety.mode === "finalize"
        ? [config.repoSafety.verificationLogPath]
        : []),
    ]);
    if (!readOnlySnapshot.ok) {
      return readOnlyRecovery(readOnlySnapshot.recoveryCode);
    }
    const outputMaxBytes =
      config.outputMaxBytes ?? DEFAULT_SCRIPT_OUTPUT_MAX_BYTES;
    return context === undefined
      ? executeScriptCommandSync(
          config,
          logPath,
          outputMaxBytes,
          readOnlySnapshot.snapshot,
        )
      : executeScriptCommandAsync(
          config,
          logPath,
          outputMaxBytes,
          readOnlySnapshot.snapshot,
          context.signal,
        );
  };
  return runner as HybridSingleShotRoundRunner;
}

function executeScriptCommandSync(
  config: ScriptCommandRoundRunnerConfig,
  logPath: string,
  outputMaxBytes: number,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): SingleShotRoundMechanismResult {
  const logHandle = openScriptLog(logPath);
  if (logHandle === null) {
    return invalidInput("script command runner could not open log path");
  }
  try {
    writeScriptStart(logHandle, config);
    const start = Date.now();
    const result = runScriptProcess(config, outputMaxBytes);
    return classifyScriptProcess(
      config,
      logHandle,
      result,
      Date.now() - start,
      readOnlySnapshot,
    );
  } catch (error) {
    writeScriptSpawnError(logHandle, error);
    return finalizeScriptResult(
      config,
      false,
      "runtime_unavailable",
      readOnlySnapshot,
    );
  } finally {
    closeLog(logHandle);
  }
}

async function executeScriptCommandAsync(
  config: ScriptCommandRoundRunnerConfig,
  logPath: string,
  outputMaxBytes: number,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
  signal: AbortSignal,
): Promise<SingleShotRoundMechanismResult> {
  const logHandle = openScriptLog(logPath);
  if (logHandle === null) {
    return invalidInput("script command runner could not open log path");
  }
  let cancellationHandled = false;
  let finalizationSignal: AbortSignal | undefined;
  try {
    writeScriptStart(logHandle, config);
    const start = Date.now();
    const result = await runProcessGroup(
      config.command,
      [...(config.args ?? [])],
      {
        cwd: config.cwd,
        env: scriptEnv(config),
        timeoutMs: config.timeoutSec * 1000,
        maxBuffer: outputMaxBytes,
        signal,
      },
    );
    if (errnoCode(result.error) === "ABORT_ERR") {
      writeLog(logHandle, "stdout", result.stdout);
      writeLog(logHandle, "stderr", result.stderr);
      writeLine(
        logHandle,
        `[single-shot-script] duration_ms: ${Date.now() - start}`,
      );
      writeLine(logHandle, "[single-shot-script] result: cancelled");
      cancellationHandled = true;
      cleanupScriptRepoAfterCancellation(config, readOnlySnapshot);
      throwProcessCancellation(result, signal);
    }
    finalizationSignal = finalizationSignalAfterSettledProcess(signal);
    const mechanism = classifyScriptProcess(
      scriptConfigWithCancellationGuard(config, finalizationSignal),
      logHandle,
      result,
      Date.now() - start,
      readOnlySnapshot,
    );
    if (finalizationSignal.aborted) {
      cancellationHandled = true;
      cleanupScriptRepoAfterCancellation(config, readOnlySnapshot);
      finalizationSignal.throwIfAborted();
    }
    return mechanism;
  } catch (error) {
    const cancellationSignal = finalizationSignal ?? signal;
    if (cancellationSignal.aborted && error === cancellationSignal.reason) {
      if (cancellationHandled) throw error;
      cleanupScriptRepoAfterCancellation(config, readOnlySnapshot);
      cancellationSignal.throwIfAborted();
      throw error;
    }
    if (isProcessSupervisorFailure(error)) {
      writeProcessSupervisorOutput(logHandle, error);
      throw error;
    }
    if (cancellationSignal.aborted) {
      if (cancellationHandled) throw error;
      cleanupScriptRepoAfterCancellation(config, readOnlySnapshot);
      cancellationSignal.throwIfAborted();
      throw error;
    }
    writeScriptSpawnError(logHandle, error);
    return finalizeScriptResult(
      config,
      false,
      "runtime_unavailable",
      readOnlySnapshot,
    );
  } finally {
    closeLog(logHandle);
  }
}

function classifyScriptProcess(
  config: ScriptCommandRoundRunnerConfig,
  logHandle: number,
  result: SpawnSyncReturns<string>,
  durationMs: number,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): SingleShotRoundMechanismResult {
  writeLog(logHandle, "stdout", result.stdout);
  writeLog(logHandle, "stderr", result.stderr);
  writeLine(logHandle, `[single-shot-script] duration_ms: ${durationMs}`);

  if (errnoCode(result.error) === "ENOBUFS") {
    writeLine(logHandle, "[single-shot-script] result: output_overflow");
    return finalizeScriptResult(
      config,
      false,
      "output_overflow",
      readOnlySnapshot,
    );
  }
  if (errnoCode(result.error) === "ETIMEDOUT") {
    writeLine(logHandle, "[single-shot-script] result: timed_out");
    return finalizeScriptResult(
      config,
      false,
      "command_timed_out",
      readOnlySnapshot,
    );
  }
  if (errnoCode(result.error) === "UNSUPPORTED_PLATFORM") {
    writeLine(
      logHandle,
      `[single-shot-script] unsupported_platform: ${result.error?.message}`,
    );
    return finalizeScriptResult(
      config,
      false,
      "unsupported_platform",
      readOnlySnapshot,
    );
  }
  if (result.error !== undefined) {
    writeLine(
      logHandle,
      `[single-shot-script] runtime_unavailable: ${result.error.message}`,
    );
    return finalizeScriptResult(
      config,
      false,
      "runtime_unavailable",
      readOnlySnapshot,
    );
  }

  const exitCode = result.status;
  const processSignal = result.signal ?? null;
  writeLine(
    logHandle,
    `[single-shot-script] exit_code: ${exitCode === null ? "null" : String(exitCode)}`,
  );
  if (processSignal !== null) {
    writeLine(logHandle, `[single-shot-script] signal: ${processSignal}`);
  }
  if (exitCode === null || exitCode !== 0) {
    writeLine(logHandle, "[single-shot-script] result: nonzero_exit");
    return finalizeScriptResult(
      config,
      false,
      "command_failed",
      readOnlySnapshot,
    );
  }

  writeLine(logHandle, "[single-shot-script] done");
  return finalizeScriptResult(config, true, "command_failed", readOnlySnapshot);
}

function openScriptLog(logPath: string): number | null {
  try {
    ensureParentDir(logPath);
    return fs.openSync(logPath, "w");
  } catch {
    return null;
  }
}

function writeScriptStart(
  logHandle: number,
  config: ScriptCommandRoundRunnerConfig,
): void {
  writeLine(logHandle, "[single-shot-script] start");
  writeLine(
    logHandle,
    `[single-shot-script] command: ${formatCommand(config)}`,
  );
  writeLine(logHandle, `[single-shot-script] cwd: ${config.cwd}`);
  writeLine(
    logHandle,
    `[single-shot-script] timeout_sec: ${config.timeoutSec}`,
  );
}

function writeScriptSpawnError(logHandle: number, error: unknown): void {
  const detail = error instanceof Error ? error.message : "unknown error";
  writeLine(logHandle, `[single-shot-script] spawn_error: ${detail}`);
}

function closeLog(logHandle: number): void {
  try {
    fs.closeSync(logHandle);
  } catch {
    // Best effort after the durable result has been determined.
  }
}

function invalidInput(error: string): SingleShotRoundMechanismResult {
  void error;
  return { outcome: { ok: false, recoveryCode: "invalid_input" } };
}

function readOnlyRecovery(
  recoveryCode: SingleShotRecoveryCode,
): SingleShotRoundMechanismResult {
  return { outcome: { ok: false, recoveryCode } };
}

function unsupportedPlatformRecovery(
  logPath: string,
  family: "one-shot" | "script",
  detail: string,
): SingleShotRoundMechanismResult {
  const logHandle = openScriptLog(logPath);
  if (logHandle === null) {
    return invalidInput(`${family} runner could not open refusal log path`);
  }
  try {
    writeLine(
      logHandle,
      `[single-shot-${family}] unsupported_platform: ${detail}`,
    );
    writeLine(logHandle, `[single-shot-${family}] result: blocked`);
  } finally {
    closeLog(logHandle);
  }
  return readOnlyRecovery("unsupported_platform");
}

function liveRecoveryCode(
  code: LiveStepWrapperRecoveryCode,
): SingleShotRecoveryCode {
  return code;
}

function finalizeOneShotProcessFailure(
  options: OneShotLiveWrapperRoundRunnerOptions,
  failureCode: SingleShotRecoveryCode,
  artifacts: SingleShotRoundArtifacts,
): SingleShotRoundMechanismResult {
  if (options.repoSafety.mode === "read-only") {
    return { outcome: { ok: false, recoveryCode: failureCode }, artifacts };
  }
  return projectFinalizeResult({
    repoPath: options.repoPath,
    finalize: finalizeWorkflowStep({
      repoPath: options.repoPath,
      baseHead: options.repoSafety.baseHead,
      stepSuccess: false,
      commitIntent: fallbackOneShotFailureCommitIntent(),
      verificationCommands: options.repoSafety.verificationCommands,
      verificationTimeoutSec: options.repoSafety.verificationTimeoutSec,
      verificationLogPath: options.repoSafety.verificationLogPath,
      ...(options.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: options.repoSafety.beforeGitMutation }
        : {}),
    }),
    failureCode,
    artifacts,
    verificationLogPath: options.repoSafety.verificationLogPath,
  });
}

function fallbackOneShotFailureCommitIntent(): CommitIntent {
  return {
    type: "chore",
    scope: "single-shot",
    subject: "record one-shot failure",
    body: "",
    breaking: false,
  };
}

function finalizeOneShotResult(
  options: OneShotLiveWrapperRoundRunnerOptions,
  result: { commit: CommitIntent },
  stepSuccess: boolean,
  artifacts: SingleShotRoundArtifacts,
  readOnlySnapshot?: ReadOnlyRepoSnapshot,
  resultDigest?: string | null,
): SingleShotRoundMechanismResult | null {
  if (options.repoSafety.mode === "read-only") {
    const recoveryCode = readOnlyRepoRecoveryCode(
      options.repoPath,
      readOnlySnapshot,
    );
    return recoveryCode === null
      ? null
      : { outcome: { ok: false, recoveryCode }, artifacts };
  }
  return projectFinalizeResult({
    repoPath: options.repoPath,
    finalize: finalizeWorkflowStep({
      repoPath: options.repoPath,
      baseHead: options.repoSafety.baseHead,
      stepSuccess,
      commitIntent: result.commit,
      verificationCommands: options.repoSafety.verificationCommands,
      verificationTimeoutSec: options.repoSafety.verificationTimeoutSec,
      verificationLogPath: options.repoSafety.verificationLogPath,
      ...(options.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: options.repoSafety.beforeGitMutation }
        : {}),
    }),
    failureCode: "command_failed",
    artifacts,
    verificationLogPath: options.repoSafety.verificationLogPath,
    ...(resultDigest !== undefined ? { resultDigest } : {}),
  });
}

function finalizeScriptResult(
  config: ScriptCommandRoundRunnerConfig,
  stepSuccess: boolean,
  failureCode: SingleShotRecoveryCode,
  readOnlySnapshot?: ReadOnlyRepoSnapshot,
): SingleShotRoundMechanismResult {
  if (config.repoSafety.mode === "read-only") {
    const recoveryCode = readOnlyRepoRecoveryCode(config.cwd, readOnlySnapshot);
    if (recoveryCode !== null) {
      return { outcome: { ok: false, recoveryCode } };
    }
    return stepSuccess
      ? { outcome: { ok: true }, evidence: { verificationStatus: "skipped" } }
      : { outcome: { ok: false, recoveryCode: failureCode } };
  }
  return projectFinalizeResult({
    repoPath: config.cwd,
    finalize: finalizeWorkflowStep({
      repoPath: config.cwd,
      baseHead: config.repoSafety.baseHead,
      stepSuccess,
      commitIntent: config.repoSafety.commitIntent,
      verificationCommands: config.repoSafety.verificationCommands,
      verificationTimeoutSec: config.repoSafety.verificationTimeoutSec,
      verificationLogPath: config.repoSafety.verificationLogPath,
      ...(config.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: config.repoSafety.beforeGitMutation }
        : {}),
    }),
    failureCode,
    artifacts: {},
    verificationLogPath: config.repoSafety.verificationLogPath,
  });
}

type ReadOnlyRepoSnapshot = {
  head: string;
  clean: true;
  ignoredDigest: string;
  ignoredExclusions: readonly string[];
};

type ReadOnlyRepoSnapshotResult =
  | { ok: true; snapshot: ReadOnlyRepoSnapshot }
  | { ok: false; recoveryCode: Extract<SingleShotRecoveryCode, "git_failed"> };

function captureReadOnlyRepoSnapshot(
  repoPath: string,
  hostOwnedPaths: readonly (string | null)[] = [],
): ReadOnlyRepoSnapshotResult {
  const head = readGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, recoveryCode: "git_failed" };
  const status = readGit(repoPath, ["status", "--porcelain"]);
  if (!status.ok || status.value.trim().length > 0) {
    return { ok: false, recoveryCode: "git_failed" };
  }
  const ignoredExclusions = ignoredPathExclusions(repoPath, hostOwnedPaths);
  const ignoredDigest = ignoredWorktreeDigest(repoPath, ignoredExclusions);
  if (ignoredDigest === null) {
    return { ok: false, recoveryCode: "git_failed" };
  }
  return {
    ok: true,
    snapshot: {
      head: head.value.trim(),
      clean: true,
      ignoredDigest,
      ignoredExclusions,
    },
  };
}

function readOnlyRepoRecoveryCode(
  repoPath: string,
  snapshot: ReadOnlyRepoSnapshot | undefined,
): SingleShotRecoveryCode | null {
  if (snapshot === undefined) return "git_failed";
  const head = readGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return "git_failed";
  if (head.value.trim() !== snapshot.head) return "head_mismatch";
  const status = readGit(repoPath, ["status", "--porcelain"]);
  if (!status.ok || status.value.trim().length > 0) return "git_failed";
  if (
    ignoredWorktreeDigest(repoPath, snapshot.ignoredExclusions) !==
    snapshot.ignoredDigest
  ) {
    return "git_failed";
  }
  return null;
}

function finalizeRepoReadyRecoveryCode(
  repoPath: string,
  baseHead: string,
): SingleShotRecoveryCode | null {
  if (!SHA40_RE.test(baseHead)) return "invalid_input";
  const head = readGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return "git_failed";
  if (head.value.trim() !== baseHead) return "head_mismatch";
  const status = readGit(repoPath, ["status", "--porcelain"]);
  if (!status.ok || status.value.trim().length > 0) return "git_failed";
  return null;
}

function readGit(
  repoPath: string,
  args: string[],
): { ok: true; value: string } | { ok: false } {
  try {
    return {
      ok: true,
      value: execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf-8",
        maxBuffer: Number.MAX_SAFE_INTEGER,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch {
    return { ok: false };
  }
}

function ignoredPathExclusions(
  repoPath: string,
  hostOwnedPaths: readonly (string | null)[],
): string[] {
  const repoRoot = path.resolve(repoPath);
  return hostOwnedPaths
    .filter((filePath): filePath is string => filePath !== null)
    .map((filePath) => path.relative(repoRoot, path.resolve(filePath)))
    .filter(
      (relativePath) =>
        relativePath !== "" &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath),
    )
    .map((relativePath) => relativePath.split(path.sep).join("/"))
    .sort();
}

function ignoredWorktreeDigest(
  repoPath: string,
  exclusions: readonly string[] = [],
): string | null {
  const repoRoot = path.resolve(repoPath);
  const ignored = readGit(repoRoot, [
    "status",
    "--ignored",
    "--porcelain=v1",
    "-z",
  ]);
  if (!ignored.ok) return null;
  const roots = collapseIgnoredRoots([
    ...ignored.value
      .split("\0")
      .filter((entry) => entry.startsWith("!! "))
      .map((entry) => entry.slice(3).replace(/\/$/, ""))
      .filter(
        (relativePath) =>
          !exclusions.some(
            (excluded) =>
              relativePath === excluded ||
              relativePath.startsWith(`${excluded}/`),
          ),
      ),
    ...ignoredExclusionAncestors(repoRoot, exclusions),
  ]);
  const digest = crypto.createHash("sha256");
  try {
    for (const relativePath of roots) {
      if (!digestIgnoredPath(repoRoot, relativePath, exclusions, digest)) {
        return null;
      }
    }
  } catch {
    return null;
  }
  return `sha256:${digest.digest("hex")}`;
}

function ignoredExclusionAncestors(
  repoRoot: string,
  exclusions: readonly string[],
): string[] {
  const ancestors = new Set<string>();
  for (const excluded of exclusions) {
    let slash = excluded.indexOf("/");
    while (slash >= 0) {
      const ancestor = excluded.slice(0, slash);
      const ignored = readGit(repoRoot, [
        "check-ignore",
        "--no-index",
        "--quiet",
        "--",
        ancestor,
      ]);
      if (ignored.ok) ancestors.add(ancestor);
      slash = excluded.indexOf("/", slash + 1);
    }
  }
  return [...ancestors];
}

function collapseIgnoredRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  const rootSet = new Set<string>();
  for (const relativePath of [...paths].sort()) {
    if (rootSet.has(relativePath)) continue;
    let slash = relativePath.indexOf("/");
    let nested = false;
    while (slash >= 0) {
      if (rootSet.has(relativePath.slice(0, slash))) {
        nested = true;
        break;
      }
      slash = relativePath.indexOf("/", slash + 1);
    }
    if (nested) continue;
    roots.push(relativePath);
    rootSet.add(relativePath);
  }
  return roots;
}

function digestIgnoredPath(
  repoRoot: string,
  relativePath: string,
  exclusions: readonly string[],
  digest: crypto.Hash,
): boolean {
  if (
    exclusions.some(
      (excluded) =>
        relativePath === excluded || relativePath.startsWith(`${excluded}/`),
    )
  ) {
    return true;
  }
  const absolutePath = path.resolve(
    repoRoot,
    relativePath.split("/").join(path.sep),
  );
  const containedPath = path.relative(repoRoot, absolutePath);
  if (
    containedPath === ".." ||
    containedPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(containedPath)
  ) {
    return false;
  }
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  const containsExcludedDescendant =
    stat.isDirectory() &&
    exclusions.some((excluded) => excluded.startsWith(`${relativePath}/`));
  const entries = stat.isDirectory()
    ? fs.readdirSync(absolutePath).sort()
    : undefined;
  digest.update(relativePath);
  digest.update("\0");
  digest.update(
    (containsExcludedDescendant
      ? [stat.mode, stat.ino]
      : [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino]
    ).join(":"),
  );
  if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(absolutePath));
  digest.update("\0");
  if (entries !== undefined) {
    for (const entry of entries) {
      if (
        !digestIgnoredPath(
          repoRoot,
          `${relativePath}/${entry}`,
          exclusions,
          digest,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

function projectFinalizeResult(input: {
  repoPath: string;
  finalize: FinalizeWorkflowStepResult;
  failureCode: SingleShotRecoveryCode;
  artifacts: SingleShotRoundArtifacts;
  verificationLogPath: string;
  resultDigest?: string | null;
}): SingleShotRoundMechanismResult {
  const artifacts = withFinalizeArtifacts(
    input.artifacts,
    input.finalize,
    input.verificationLogPath,
  );
  switch (input.finalize.outcome) {
    case "committed":
      return {
        outcome: { ok: true },
        artifacts,
        evidence: {
          verificationStatus: verificationStatusFromFinalize(input.finalize),
          commitSha: input.finalize.commit.commitSha,
          changedFiles: changedFilesForCommit(input.repoPath, input.finalize),
        },
        ...(input.resultDigest !== undefined
          ? { resultDigest: input.resultDigest }
          : {}),
      };
    case "reset_step_failure":
      return {
        outcome: { ok: false, recoveryCode: input.failureCode },
        artifacts,
      };
    case "reset_verification_failure":
      return {
        outcome: { ok: false, recoveryCode: "command_failed" },
        artifacts,
        evidence: { verificationStatus: "failed" },
      };
    case "manual_recovery_required":
      return {
        outcome: {
          ok: false,
          recoveryCode: input.finalize.recoveryCode,
        },
        artifacts,
      };
    case "reset_failed": {
      const evidence = evidenceFromMaybeVerification(input.finalize);
      return {
        outcome: { ok: false, recoveryCode: "reset_failed" },
        artifacts,
        ...(evidence !== undefined ? { evidence } : {}),
      };
    }
    case "commit_failed": {
      const evidence = {
        verificationStatus: verificationStatusFromFinalize(input.finalize),
      };
      if (input.finalize.reset !== undefined) {
        return {
          outcome: {
            ok: false,
            recoveryCode: input.finalize.reset.ok
              ? input.failureCode
              : "reset_failed",
          },
          artifacts,
          evidence,
        };
      }
      if (input.finalize.commit.code === "nothing_to_commit") {
        return {
          outcome: { ok: false, recoveryCode: input.failureCode },
          artifacts,
          evidence,
        };
      }
      return {
        outcome: { ok: false, recoveryCode: "commit_failed" },
        artifacts,
        evidence,
      };
    }
    case "git_failed":
      return { outcome: { ok: false, recoveryCode: "git_failed" }, artifacts };
    case "repo_lock_lost":
      return {
        outcome: { ok: false, recoveryCode: "repo_lock_lost" },
        artifacts,
      };
    case "invalid_input":
      return {
        outcome: { ok: false, recoveryCode: "invalid_input" },
        artifacts,
      };
  }
}

function withFinalizeArtifacts(
  artifacts: SingleShotRoundArtifacts,
  finalize: FinalizeWorkflowStepResult,
  verificationLogPath: string,
): SingleShotRoundArtifacts {
  const verificationStatus = verificationStatusFromMaybeFinalize(finalize);
  if (verificationStatus === null) return artifacts;
  return {
    ...artifacts,
    verificationOutput: verificationOutputPointer(verificationLogPath),
  };
}

function evidenceFromMaybeVerification(
  finalize: Extract<FinalizeWorkflowStepResult, { outcome: "reset_failed" }>,
): SingleShotRoundEvidence | undefined {
  if (finalize.verification === null) return undefined;
  return {
    verificationStatus: verificationStatusFromVerification(
      finalize.verification,
    ),
  };
}

function verificationStatusFromMaybeFinalize(
  finalize: FinalizeWorkflowStepResult,
): SingleShotVerificationStatus | null {
  if (!("verification" in finalize)) return null;
  if (finalize.verification === null) return null;
  return verificationStatusFromVerification(finalize.verification);
}

function verificationStatusFromFinalize(
  finalize: Extract<
    FinalizeWorkflowStepResult,
    { outcome: "committed" | "reset_verification_failure" | "commit_failed" }
  >,
): SingleShotVerificationStatus {
  return verificationStatusFromVerification(finalize.verification);
}

function verificationStatusFromVerification(input: {
  ok: boolean;
  results: readonly unknown[];
}): SingleShotVerificationStatus {
  if (!input.ok) return "failed";
  return input.results.length === 0 ? "skipped" : "passed";
}

function changedFilesForCommit(
  repoPath: string,
  finalize: Extract<FinalizeWorkflowStepResult, { outcome: "committed" }>,
): string[] {
  try {
    return listCommittedChangedFiles(
      repoPath,
      finalize.commit.parentSha,
      finalize.commit.commitSha,
    );
  } catch {
    return [];
  }
}

function verificationOutputPointer(
  verificationLogPath: string,
): SingleShotArtifactPointer {
  const digest = digestFile(verificationLogPath);
  return {
    path: verificationLogPath,
    ...(digest !== null ? { digest } : {}),
  };
}

function artifactPointers(
  resultJsonPath: string | undefined,
  digest: string | null,
): SingleShotRoundArtifacts {
  const resultDocument = resultArtifactPointer(resultJsonPath, digest);
  return resultDocument === undefined ? {} : { resultDocument };
}

function resultArtifactPointer(
  resultJsonPath: string | undefined,
  digest: string | null,
): SingleShotArtifactPointer | undefined {
  if (resultJsonPath === undefined || !fs.existsSync(resultJsonPath)) {
    return undefined;
  }
  return {
    path: resultJsonPath,
    ...(digest !== null ? { digest } : {}),
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

function isUsableAbsolutePath(filePath: string): boolean {
  return filePath.trim().length > 0 && path.isAbsolute(filePath);
}

function primaryLogPath(round: { logPaths: readonly string[] }): string | null {
  return round.logPaths[0] ?? null;
}

function validateScriptCommandConfig(
  config: ScriptCommandRoundRunnerConfig,
): { ok: true } | { ok: false; error: string } {
  if (typeof config.command !== "string" || !path.isAbsolute(config.command)) {
    return {
      ok: false,
      error: "script command must be an absolute executable path",
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
  if (config.timeoutSec > MAX_BUILT_IN_PROCESS_TIMEOUT_SEC) {
    return {
      ok: false,
      error: `script timeoutSec must not exceed ${MAX_BUILT_IN_PROCESS_TIMEOUT_SEC} seconds`,
    };
  }
  return { ok: true };
}

function validatePortableScriptConfig(
  portable: Readonly<import("./sdk.js").SingleShotExecutorConfig>,
  resolved: ScriptCommandRoundRunnerConfig,
): { ok: true } | { ok: false; error: string } {
  const command = portable.command;
  const expectedIdentity =
    resolved.commandIdentity ?? path.basename(resolved.command);
  if (
    !isPortableScriptCommandIdentity(command) ||
    command !== expectedIdentity
  ) {
    return {
      ok: false,
      error: `portable script command ${String(command)} does not match resolved host identity ${expectedIdentity}`,
    };
  }
  const portableArgs = portable.args ?? [];
  const resolvedArgs = resolved.args ?? [];
  if (
    portableArgs.length !== resolvedArgs.length ||
    portableArgs.some((arg, index) => arg !== resolvedArgs[index])
  ) {
    return {
      ok: false,
      error: "portable script args do not match resolved host argv",
    };
  }
  if (
    portable.timeoutMs !== undefined &&
    portable.timeoutMs !== resolved.timeoutSec * 1000
  ) {
    return {
      ok: false,
      error: "portable script timeoutMs does not match resolved host timeout",
    };
  }
  if (
    portable.policyEnvelope !== undefined &&
    portable.policyEnvelope !== resolved.policyEnvelopeIdentity
  ) {
    return {
      ok: false,
      error:
        "portable script policyEnvelope does not match resolved host policy",
    };
  }
  return { ok: true };
}

function validatePortableOneShotConfig(
  portable: Readonly<import("./sdk.js").SingleShotExecutorConfig>,
  resolved: LiveWrapperConfig,
  hostIdentity: OneShotLiveWrapperHostIdentity | undefined,
): { ok: true } | { ok: false; error: string } {
  if (
    portable.timeoutMs !== undefined &&
    portable.timeoutMs !== resolved.timeoutSec * 1000
  ) {
    return {
      ok: false,
      error: "portable one-shot timeoutMs does not match resolved host timeout",
    };
  }
  for (const field of ["harness", "model", "effort"] as const) {
    const expected = portable.agent?.[field];
    if (expected !== undefined && expected !== hostIdentity?.agent?.[field]) {
      return {
        ok: false,
        error: `portable one-shot agent.${field} does not match resolved host identity`,
      };
    }
  }
  if (
    portable.policyEnvelope !== undefined &&
    portable.policyEnvelope !== hostIdentity?.policyEnvelope
  ) {
    return {
      ok: false,
      error:
        "portable one-shot policyEnvelope does not match resolved host identity",
    };
  }
  return { ok: true };
}

function oneShotOptionsWithCancellationGuard(
  options: OneShotLiveWrapperRoundRunnerOptions,
  signal: AbortSignal,
): OneShotLiveWrapperRoundRunnerOptions {
  if (options.repoSafety.mode === "read-only") return options;
  return {
    ...options,
    repoSafety: {
      ...options.repoSafety,
      beforeGitMutation: cancellationAwareMutationGuard(
        options.repoSafety.beforeGitMutation,
        signal,
      ),
    },
  };
}

function scriptConfigWithCancellationGuard(
  config: ScriptCommandRoundRunnerConfig,
  signal: AbortSignal,
): ScriptCommandRoundRunnerConfig {
  if (config.repoSafety.mode === "read-only") return config;
  return {
    ...config,
    repoSafety: {
      ...config.repoSafety,
      beforeGitMutation: cancellationAwareMutationGuard(
        config.repoSafety.beforeGitMutation,
        signal,
      ),
    },
  };
}

function cancellationAwareMutationGuard(
  ownershipGuard: RepoMutationGuard["beforeGitMutation"],
  signal: AbortSignal,
): NonNullable<RepoMutationGuard["beforeGitMutation"]> {
  return () => {
    const ownership = ownershipGuard?.();
    if (ownership?.ok === false) return ownership;
    if (signal.aborted) {
      return { ok: false, error: "bounded turn was cancelled" };
    }
    return { ok: true };
  };
}

function finalizationSignalAfterSettledProcess(
  signal: AbortSignal,
): AbortSignal {
  return signal.aborted ? new AbortController().signal : signal;
}

function throwIfOneShotCancelledAfterFinalization(
  signal: AbortSignal,
  options: OneShotLiveWrapperRoundRunnerOptions,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): void {
  if (!signal.aborted) return;
  cleanupOneShotRepoAfterCancellation(options, readOnlySnapshot);
  signal.throwIfAborted();
}

function cleanupOneShotRepoAfterCancellation(
  options: OneShotLiveWrapperRoundRunnerOptions,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): void {
  if (options.repoSafety.mode === "read-only") {
    cleanupReadOnlyRepoAfterCancellation(
      options.repoPath,
      readOnlySnapshot,
      options.repoSafety.beforeGitMutation,
    );
    return;
  }
  cleanupFinalizingRepoAfterCancellation(
    options.repoPath,
    options.repoSafety,
    fallbackOneShotFailureCommitIntent(),
    readOnlySnapshot,
  );
}

function cleanupScriptRepoAfterCancellation(
  config: ScriptCommandRoundRunnerConfig,
  readOnlySnapshot: ReadOnlyRepoSnapshot | undefined,
): void {
  if (config.repoSafety.mode === "read-only") {
    cleanupReadOnlyRepoAfterCancellation(
      config.cwd,
      readOnlySnapshot,
      config.repoSafety.beforeGitMutation,
    );
    return;
  }
  cleanupFinalizingRepoAfterCancellation(
    config.cwd,
    config.repoSafety,
    config.repoSafety.commitIntent,
    readOnlySnapshot,
  );
}

function cleanupReadOnlyRepoAfterCancellation(
  repoPath: string,
  snapshot: ReadOnlyRepoSnapshot | undefined,
  beforeGitMutation: RepoMutationGuard["beforeGitMutation"],
): void {
  if (snapshot === undefined) {
    throw new Error(
      "cannot clean cancelled read-only work without a base HEAD",
    );
  }
  if (snapshot.clean !== true) {
    throw new Error(
      "cannot clean cancelled read-only work from a dirty baseline",
    );
  }
  if (beforeGitMutation === undefined) {
    throw new Error(
      "cannot clean cancelled read-only work without repo ownership proof",
    );
  }
  const ownership = beforeGitMutation();
  if (!ownership.ok) {
    throw new Error(
      `cancelled work cleanup lost repo ownership: ${ownership.error}`,
    );
  }
  const reset = resetToBase({ repoPath, baseHead: snapshot.head });
  if (!reset.ok) {
    throw new Error(
      `cancelled work cleanup failed: ${reset.code}: ${reset.error}`,
    );
  }
  const residue = readOnlyRepoRecoveryCode(repoPath, snapshot);
  if (residue !== null) {
    throw new Error(
      `cancelled work cleanup left repository residue: ${residue}`,
    );
  }
}

function cleanupFinalizingRepoAfterCancellation(
  repoPath: string,
  config: SingleShotFinalizationConfig,
  commitIntent: CommitIntent,
  baseline: ReadOnlyRepoSnapshot | undefined,
): void {
  if (baseline === undefined) {
    throw new Error(
      "cannot clean cancelled finalizing work without a repository baseline",
    );
  }
  if (config.beforeGitMutation === undefined) {
    throw new Error(
      "cannot clean cancelled finalizing work without repo ownership proof",
    );
  }
  const finalized = finalizeWorkflowStep({
    repoPath,
    baseHead: config.baseHead,
    stepSuccess: false,
    commitIntent,
    verificationCommands: config.verificationCommands,
    verificationTimeoutSec: config.verificationTimeoutSec,
    verificationLogPath: config.verificationLogPath,
    beforeGitMutation: config.beforeGitMutation,
  });
  if (finalized.outcome !== "reset_step_failure") {
    throw new Error(
      `cancelled work cleanup did not reset the repository: ${finalized.outcome}`,
    );
  }
  const residue = readOnlyRepoRecoveryCode(repoPath, baseline);
  if (residue !== null) {
    throw new Error(
      `cancelled work cleanup left repository residue: ${residue}`,
    );
  }
}

function runScriptProcess(
  config: ScriptCommandRoundRunnerConfig,
  outputMaxBytes: number,
): SpawnSyncReturns<string> {
  return runProcessGroupSync(config.command, [...(config.args ?? [])], {
    cwd: config.cwd,
    env: scriptEnv(config),
    timeoutMs: config.timeoutSec * 1000,
    maxBuffer: outputMaxBytes,
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

function throwProcessCancellation(
  result: SpawnSyncReturns<string>,
  signal: AbortSignal,
): never {
  if (signal.aborted) signal.throwIfAborted();
  throw result.error ?? new Error("process cancelled");
}

function isProcessSupervisorFailure(error: unknown): boolean {
  return error instanceof Error && errnoCode(error) === "SUPERVISOR_FAILED";
}

function formatCommand(config: ScriptCommandRoundRunnerConfig): string {
  const args = config.args ?? [];
  if (args.length === 0) return config.command;
  return `${config.command} ${args.join(" ")}`;
}

function writeLog(
  handle: number,
  label: "stdout" | "stderr",
  chunk: unknown,
): void {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  writeLine(handle, `[single-shot-script] ${label}:`);
  fs.writeSync(handle, chunk);
  if (!chunk.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function writeProcessSupervisorOutput(handle: number, error: unknown): void {
  if (typeof error !== "object" || error === null) return;
  const output = error as { stdout?: unknown; stderr?: unknown };
  writeLog(handle, "stdout", output.stdout);
  writeLog(handle, "stderr", output.stderr);
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}
