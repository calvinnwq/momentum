/**
 * Runtime mechanisms for the M10-06 single-shot executor families.
 *
 * `one-shot` delegates to the live-step wrapper and therefore requires a
 * normalized `RunnerResult` document on success. `script` runs an absolute
 * deterministic command with explicit argv/env/cwd, bounded stdout/stderr, and
 * succeeds from exit code plus log evidence without writing a result document.
 *
 * Both mechanisms enforce repo-safety at the boundary. `read-only` snapshots
 * require a clean repo before and after the command. `finalize` requires the
 * caller's `baseHead` to match, then maps verification, commit, reset, lock,
 * and git outcomes through the same recovery codes used by live workflow-step
 * finalization. Callers must supply absolute artifact log paths on the round;
 * `script` configs must also use an absolute executable path and absolute cwd.
 */
import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { listCommittedChangedFiles } from "./git-transaction.js";
import {
  finalizeLiveWorkflowStep,
  type FinalizeLiveWorkflowStepResult
} from "./live-step-finalize.js";
import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  runLiveStepWrapper,
  runProcessGroupSync,
  type LiveStepWrapperRecoveryCode
} from "./live-step-wrapper.js";
import type { LiveWrapperConfig } from "./live-wrapper-registry.js";
import type { CommitIntent } from "./runner-result.js";
import type {
  SingleShotArtifactPointer,
  SingleShotRoundArtifacts,
  SingleShotRoundEvidence,
  SingleShotVerificationStatus
} from "./single-shot-executor.js";
import type { SingleShotRecoveryCode } from "./single-shot-executor.js";
import type {
  SingleShotRoundMechanismResult,
  SingleShotRoundRunner
} from "./single-shot-orchestrator.js";
import type { WorkflowStepKind } from "./workflow-run-reducer.js";

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
  /** Whether the runner must preserve repo state or finalize mutations. */
  repoSafety: OneShotRepoSafetyConfig;
};

export type SingleShotFinalizationConfig = {
  /** Expected HEAD before finalization may mutate git state. */
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
  | { mode: "read-only" }
  | ({ mode: "finalize" } & SingleShotFinalizationConfig);

/**
 * Repo-safety policy for deterministic scripts. Finalizing scripts need an
 * explicit commit intent because they do not emit a normalized result document.
 */
export type ScriptRepoSafetyConfig =
  | { mode: "read-only" }
  | ({ mode: "finalize"; commitIntent: CommitIntent } &
      SingleShotFinalizationConfig);

export type ScriptCommandRoundRunnerConfig = {
  /** Absolute executable path; no shell lookup or interpolation is used. */
  command: string;
  /** Explicit argv passed to the executable. */
  args?: readonly string[];
  /** Absolute working directory and repo root for safety/finalization checks. */
  cwd: string;
  /** Positive command timeout in seconds. */
  timeoutSec: number;
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
    if (!isUsableAbsolutePath(logPath)) {
      return invalidInput(
        "one-shot live wrapper rounds require an absolute log path"
      );
    }
    if (options.repoSafety.mode === "finalize") {
      const recoveryCode = finalizeRepoReadyRecoveryCode(
        options.repoPath,
        options.repoSafety.baseHead
      );
      if (recoveryCode !== null) return readOnlyRecovery(recoveryCode);
    }
    const readOnlySnapshot =
      options.repoSafety.mode === "read-only"
        ? captureReadOnlyRepoSnapshot(options.repoPath)
        : null;
    if (readOnlySnapshot !== null && !readOnlySnapshot.ok) {
      return readOnlyRecovery(readOnlySnapshot.recoveryCode);
    }

    let result: ReturnType<typeof runLiveStepWrapper>;
    try {
      result = runLiveStepWrapper({
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
    } catch {
      const artifacts: SingleShotRoundArtifacts = {};
      if (options.repoSafety.mode === "read-only") {
        const repoRecoveryCode = readOnlyRepoRecoveryCode(
          options.repoPath,
          readOnlySnapshot?.snapshot
        );
        return {
          outcome: {
            ok: false,
            recoveryCode: repoRecoveryCode ?? "runtime_unavailable"
          },
          artifacts
        };
      }
      return finalizeOneShotProcessFailure(
        options,
        "runtime_unavailable",
        artifacts
      );
    }

    if (!result.ok) {
      const artifacts = artifactPointers(result.resultJsonPath, null);
      const recoveryCode = liveRecoveryCode(result.code);
      if (options.repoSafety.mode === "read-only") {
        const repoRecoveryCode = readOnlyRepoRecoveryCode(
          options.repoPath,
          readOnlySnapshot?.snapshot
        );
        return {
          outcome: {
            ok: false,
            recoveryCode: repoRecoveryCode ?? recoveryCode
          },
          artifacts
        };
      }
      return finalizeOneShotProcessFailure(options, recoveryCode, artifacts);
    }

    const digest = digestFile(result.resultJsonPath);
    const artifacts = artifactPointers(result.resultJsonPath, digest);
    if (result.result.success !== true) {
      const finalized = finalizeOneShotResult(
        options,
        result.result,
        false,
        artifacts,
        readOnlySnapshot?.snapshot
      );
      if (finalized !== null) return finalized;
      return {
        outcome: { ok: false, recoveryCode: "command_failed" },
        artifacts
      };
    }

    const finalized = finalizeOneShotResult(
      options,
      result.result,
      true,
      artifacts,
      readOnlySnapshot?.snapshot,
      digest
    );
    if (finalized !== null) {
      return {
        ...finalized,
        result: result.result,
        ...(digest !== null ? { resultDigest: digest } : {})
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

/**
 * Build a deterministic `script` round runner.
 *
 * The runner requires an absolute command, absolute cwd, positive timeout, and
 * at least one absolute round log path. A zero exit code is the success signal;
 * stdout/stderr plus the exit metadata are the evidence, so no normalized result
 * document or result digest is produced for script success.
 */
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
    if (!isUsableAbsolutePath(logPath)) {
      return invalidInput("script rounds require an absolute log path");
    }
    if (config.repoSafety.mode === "finalize") {
      const recoveryCode = finalizeRepoReadyRecoveryCode(
        config.cwd,
        config.repoSafety.baseHead
      );
      if (recoveryCode !== null) return readOnlyRecovery(recoveryCode);
    }
    const readOnlySnapshot =
      config.repoSafety.mode === "read-only"
        ? captureReadOnlyRepoSnapshot(config.cwd)
        : null;
    if (readOnlySnapshot !== null && !readOnlySnapshot.ok) {
      return readOnlyRecovery(readOnlySnapshot.recoveryCode);
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
      let spawn: SpawnSyncReturns<string>;
      try {
        spawn = runScriptProcess(config, outputMaxBytes);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        writeLine(logHandle, `[single-shot-script] spawn_error: ${detail}`);
        return finalizeScriptResult(
          config,
          false,
          "runtime_unavailable",
          readOnlySnapshot?.snapshot
        );
      }
      const durationMs = Date.now() - start;

      writeLog(logHandle, "stdout", spawn.stdout);
      writeLog(logHandle, "stderr", spawn.stderr);
      writeLine(logHandle, `[single-shot-script] duration_ms: ${durationMs}`);

      if (errnoCode(spawn.error) === "ENOBUFS") {
        writeLine(logHandle, "[single-shot-script] result: output_overflow");
        return finalizeScriptResult(
          config,
          false,
          "output_overflow",
          readOnlySnapshot?.snapshot
        );
      }
      if (errnoCode(spawn.error) === "ETIMEDOUT") {
        writeLine(logHandle, "[single-shot-script] result: timed_out");
        return finalizeScriptResult(
          config,
          false,
          "command_timed_out",
          readOnlySnapshot?.snapshot
        );
      }
      if (spawn.error !== undefined) {
        writeLine(
          logHandle,
          `[single-shot-script] runtime_unavailable: ${spawn.error.message}`
        );
        return finalizeScriptResult(
          config,
          false,
          "runtime_unavailable",
          readOnlySnapshot?.snapshot
        );
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
        return finalizeScriptResult(
          config,
          false,
          "command_failed",
          readOnlySnapshot?.snapshot
        );
      }

      writeLine(logHandle, "[single-shot-script] done");
      return finalizeScriptResult(
        config,
        true,
        "command_failed",
        readOnlySnapshot?.snapshot
      );
    } catch {
      return finalizeScriptResult(
        config,
        false,
        "runtime_unavailable",
        readOnlySnapshot?.snapshot
      );
    } finally {
      try {
        fs.closeSync(logHandle);
      } catch {
      }
    }
  };
}

function invalidInput(error: string): SingleShotRoundMechanismResult {
  void error;
  return { outcome: { ok: false, recoveryCode: "invalid_input" } };
}

function readOnlyRecovery(
  recoveryCode: SingleShotRecoveryCode
): SingleShotRoundMechanismResult {
  return { outcome: { ok: false, recoveryCode } };
}

function liveRecoveryCode(
  code: LiveStepWrapperRecoveryCode
): SingleShotRecoveryCode {
  return code;
}

function finalizeOneShotProcessFailure(
  options: OneShotLiveWrapperRoundRunnerOptions,
  failureCode: SingleShotRecoveryCode,
  artifacts: SingleShotRoundArtifacts
): SingleShotRoundMechanismResult {
  if (options.repoSafety.mode === "read-only") {
    return { outcome: { ok: false, recoveryCode: failureCode }, artifacts };
  }
  return projectFinalizeResult({
    repoPath: options.repoPath,
    finalize: finalizeLiveWorkflowStep({
      repoPath: options.repoPath,
      baseHead: options.repoSafety.baseHead,
      stepSuccess: false,
      commitIntent: fallbackOneShotFailureCommitIntent(),
      verificationCommands: options.repoSafety.verificationCommands,
      verificationTimeoutSec: options.repoSafety.verificationTimeoutSec,
      verificationLogPath: options.repoSafety.verificationLogPath,
      ...(options.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: options.repoSafety.beforeGitMutation }
        : {})
    }),
    failureCode,
    artifacts,
    verificationLogPath: options.repoSafety.verificationLogPath
  });
}

function fallbackOneShotFailureCommitIntent(): CommitIntent {
  return {
    type: "chore",
    scope: "single-shot",
    subject: "record one-shot failure",
    body: "",
    breaking: false
  };
}

function finalizeOneShotResult(
  options: OneShotLiveWrapperRoundRunnerOptions,
  result: { commit: CommitIntent },
  stepSuccess: boolean,
  artifacts: SingleShotRoundArtifacts,
  readOnlySnapshot?: ReadOnlyRepoSnapshot,
  resultDigest?: string | null
): SingleShotRoundMechanismResult | null {
  if (options.repoSafety.mode === "read-only") {
    const recoveryCode = readOnlyRepoRecoveryCode(
      options.repoPath,
      readOnlySnapshot
    );
    return recoveryCode === null
      ? null
      : { outcome: { ok: false, recoveryCode }, artifacts };
  }
  return projectFinalizeResult({
    repoPath: options.repoPath,
    finalize: finalizeLiveWorkflowStep({
      repoPath: options.repoPath,
      baseHead: options.repoSafety.baseHead,
      stepSuccess,
      commitIntent: result.commit,
      verificationCommands: options.repoSafety.verificationCommands,
      verificationTimeoutSec: options.repoSafety.verificationTimeoutSec,
      verificationLogPath: options.repoSafety.verificationLogPath,
      ...(options.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: options.repoSafety.beforeGitMutation }
        : {})
    }),
    failureCode: "command_failed",
    artifacts,
    verificationLogPath: options.repoSafety.verificationLogPath,
    ...(resultDigest !== undefined ? { resultDigest } : {})
  });
}

function finalizeScriptResult(
  config: ScriptCommandRoundRunnerConfig,
  stepSuccess: boolean,
  failureCode: SingleShotRecoveryCode,
  readOnlySnapshot?: ReadOnlyRepoSnapshot
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
    finalize: finalizeLiveWorkflowStep({
      repoPath: config.cwd,
      baseHead: config.repoSafety.baseHead,
      stepSuccess,
      commitIntent: config.repoSafety.commitIntent,
      verificationCommands: config.repoSafety.verificationCommands,
      verificationTimeoutSec: config.repoSafety.verificationTimeoutSec,
      verificationLogPath: config.repoSafety.verificationLogPath,
      ...(config.repoSafety.beforeGitMutation !== undefined
        ? { beforeGitMutation: config.repoSafety.beforeGitMutation }
        : {})
    }),
    failureCode,
    artifacts: {},
    verificationLogPath: config.repoSafety.verificationLogPath
  });
}

type ReadOnlyRepoSnapshot = {
  head: string;
};

type ReadOnlyRepoSnapshotResult =
  | { ok: true; snapshot: ReadOnlyRepoSnapshot }
  | { ok: false; recoveryCode: Extract<SingleShotRecoveryCode, "git_failed"> };

function captureReadOnlyRepoSnapshot(repoPath: string): ReadOnlyRepoSnapshotResult {
  const head = readGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, recoveryCode: "git_failed" };
  const status = readGit(repoPath, ["status", "--porcelain"]);
  if (!status.ok || status.value.trim().length > 0) {
    return { ok: false, recoveryCode: "git_failed" };
  }
  return { ok: true, snapshot: { head: head.value.trim() } };
}

function readOnlyRepoRecoveryCode(
  repoPath: string,
  snapshot: ReadOnlyRepoSnapshot | undefined
): SingleShotRecoveryCode | null {
  if (snapshot === undefined) return "git_failed";
  const head = readGit(repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok) return "git_failed";
  if (head.value.trim() !== snapshot.head) return "head_mismatch";
  const status = readGit(repoPath, ["status", "--porcelain"]);
  if (!status.ok || status.value.trim().length > 0) return "git_failed";
  return null;
}

function finalizeRepoReadyRecoveryCode(
  repoPath: string,
  baseHead: string
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
  args: string[]
): { ok: true; value: string } | { ok: false } {
  try {
    return {
      ok: true,
      value: execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch {
    return { ok: false };
  }
}

function projectFinalizeResult(input: {
  repoPath: string;
  finalize: FinalizeLiveWorkflowStepResult;
  failureCode: SingleShotRecoveryCode;
  artifacts: SingleShotRoundArtifacts;
  verificationLogPath: string;
  resultDigest?: string | null;
}): SingleShotRoundMechanismResult {
  const artifacts = withFinalizeArtifacts(
    input.artifacts,
    input.finalize,
    input.verificationLogPath
  );
  switch (input.finalize.outcome) {
    case "committed":
      return {
        outcome: { ok: true },
        artifacts,
        evidence: {
          verificationStatus: verificationStatusFromFinalize(input.finalize),
          commitSha: input.finalize.commit.commitSha,
          changedFiles: changedFilesForCommit(input.repoPath, input.finalize)
        },
        ...(input.resultDigest !== undefined
          ? { resultDigest: input.resultDigest }
          : {})
      };
    case "reset_step_failure":
      return {
        outcome: { ok: false, recoveryCode: input.failureCode },
        artifacts
      };
    case "reset_verification_failure":
      return {
        outcome: { ok: false, recoveryCode: "command_failed" },
        artifacts,
        evidence: { verificationStatus: "failed" }
      };
    case "manual_recovery_required":
      return {
        outcome: {
          ok: false,
          recoveryCode: input.finalize.recoveryCode
        },
        artifacts
      };
    case "reset_failed":
      {
        const evidence = evidenceFromMaybeVerification(input.finalize);
        return {
          outcome: { ok: false, recoveryCode: "reset_failed" },
          artifacts,
          ...(evidence !== undefined ? { evidence } : {})
        };
      }
    case "commit_failed":
      {
        const evidence = {
          verificationStatus: verificationStatusFromFinalize(input.finalize)
        };
        if (input.finalize.reset !== undefined) {
          return {
            outcome: {
              ok: false,
              recoveryCode: input.finalize.reset.ok
                ? input.failureCode
                : "reset_failed"
            },
            artifacts,
            evidence
          };
        }
        if (input.finalize.commit.code === "nothing_to_commit") {
          return {
            outcome: { ok: false, recoveryCode: input.failureCode },
            artifacts,
            evidence
          };
        }
        return {
          outcome: { ok: false, recoveryCode: "commit_failed" },
          artifacts,
          evidence
        };
      }
    case "git_failed":
      return { outcome: { ok: false, recoveryCode: "git_failed" }, artifacts };
    case "repo_lock_lost":
      return {
        outcome: { ok: false, recoveryCode: "repo_lock_lost" },
        artifacts
      };
    case "invalid_input":
      return {
        outcome: { ok: false, recoveryCode: "invalid_input" },
        artifacts
      };
  }
}

function withFinalizeArtifacts(
  artifacts: SingleShotRoundArtifacts,
  finalize: FinalizeLiveWorkflowStepResult,
  verificationLogPath: string
): SingleShotRoundArtifacts {
  const verificationStatus = verificationStatusFromMaybeFinalize(finalize);
  if (verificationStatus === null) return artifacts;
  return {
    ...artifacts,
    verificationOutput: verificationOutputPointer(verificationLogPath)
  };
}

function evidenceFromMaybeVerification(
  finalize: Extract<FinalizeLiveWorkflowStepResult, { outcome: "reset_failed" }>
): SingleShotRoundEvidence | undefined {
  if (finalize.verification === null) return undefined;
  return {
    verificationStatus: verificationStatusFromVerification(finalize.verification)
  };
}

function verificationStatusFromMaybeFinalize(
  finalize: FinalizeLiveWorkflowStepResult
): SingleShotVerificationStatus | null {
  if (!("verification" in finalize)) return null;
  if (finalize.verification === null) return null;
  return verificationStatusFromVerification(finalize.verification);
}

function verificationStatusFromFinalize(
  finalize: Extract<
    FinalizeLiveWorkflowStepResult,
    { outcome: "committed" | "reset_verification_failure" | "commit_failed" }
  >
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
  finalize: Extract<FinalizeLiveWorkflowStepResult, { outcome: "committed" }>
): string[] {
  try {
    return listCommittedChangedFiles(
      repoPath,
      finalize.commit.parentSha,
      finalize.commit.commitSha
    );
  } catch {
    return [];
  }
}

function verificationOutputPointer(
  verificationLogPath: string
): SingleShotArtifactPointer {
  const digest = digestFile(verificationLogPath);
  return {
    path: verificationLogPath,
    ...(digest !== null ? { digest } : {})
  };
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

function isUsableAbsolutePath(filePath: string): boolean {
  return filePath.trim().length > 0 && path.isAbsolute(filePath);
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
  return runProcessGroupSync(config.command, [...(config.args ?? [])], {
    cwd: config.cwd,
    env: scriptEnv(config),
    timeoutMs: config.timeoutSec * 1000,
    maxBuffer: outputMaxBytes
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
