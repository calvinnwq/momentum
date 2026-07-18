/**
 * Goal-loop executor adapter — round mechanism bridge.
 *
 * `goal-loop/orchestrator.ts` drives one bounded round through its durable
 * lifecycle around an *injected* {@link GoalLoopRoundRunner} mechanism; every
 * test so far has injected a deterministic fake mechanism. This module is the
 * concrete mechanism that reuses the existing Goal / iteration safety the ticket
 * asks for ("Reuse existing Goal / iteration safety where possible") rather than
 * re-implementing it: given the repo, the base HEAD the round started from, the
 * normalized result document the round wrote, and the verification config, it
 * runs the shared `finalizeWorkflowStepFromResultFile` verify -> commit / reset
 * transaction and projects the outcome into the
 * {@link GoalLoopRoundMechanismResult} the driver consumes.
 *
 * The prompted-result bridge adds the runner-facing half: it renders the native
 * per-round prompt, clears any stale result file, hands the prompt + configured
 * result path to an injected runner, and then reuses the same result-file
 * finalization bridge. Prompt text is an input artifact only; classification is
 * still driven by the normalized result document and repo-safety evidence.
 *
 * It owns no orchestration and no schema: it is the seam between "the round's
 * external agent finished and wrote a result document" and "the daemon classifies
 * and persists the round". The real daemon wiring runs the agent (producing the
 * result document at the round's artifact root) and then calls this bridge inside
 * its `runRound` closure; the bridge stays free of agent spawning so it is fully
 * testable against a temp git repo + result document.
 *
 * Reusing `finalizeWorkflowStepFromResultFile` keeps every repo-safety
 * boundary intact end to end — a moved HEAD routes to `manual_recovery_required`
 * rather than a destructive reset, a lost repo lock surfaces `repo_lock_lost`, and
 * a missing / invalid result document refuses to mutate git — which is exactly the
 * recovery / finalization behaviour the goal-loop decision (`decideGoalLoopRound`)
 * then turns into a durable classification.
 *
 * Two consistency rules tie the projection together:
 *
 *   - The normalized `result` is `null` exactly when the finalize seam judged the
 *     result document unusable (`result_missing` / `result_invalid`); for every
 *     other outcome the same document is re-read into the `RunnerResult` the round
 *     captures, so a captured result can never disagree with the finalize verdict
 *     on the document. The `resultDigest` (the round-schema `result_digest`
 *     reattach fingerprint) is computed from those same bytes, so it is non-null
 *     exactly when there is a result to capture and always fingerprints the
 *     document that result was parsed from.
 *   - The reported artifact pointers are only the files this bridge owns: the
 *     result document (whenever the file exists), the verification log (whenever
 *     verification actually ran, per the finalize evidence), and a
 *     commit/reset finalization sidecar derived from the verification log path.
 *     They carry `sha256:` content digests of their bytes so durable artifact
 *     rows are self-verifying on reattach and cannot drift from the files they
 *     point at. It never invents a path; the orchestrator still derives the
 *     `logs` artifacts from the round-start record's frozen `logPaths`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { listCommittedChangedFiles } from "../../../adapters/git-transaction.js";
import {
  goalLoopFinalizeEvidenceFromResult,
  type GoalLoopArtifactPointer,
  type GoalLoopRoundArtifacts,
} from "./executor.js";
import type { GoalLoopRoundMechanismResult } from "./orchestrator.js";
import {
  finalizeWorkflowStepFromValidatedResult,
  readNormalizedResultFile,
  type FinalizeWorkflowStepFromResultFileInput,
  type FinalizeWorkflowStepFromResultFileResult,
} from "../shared/step-finalize.js";
import {
  renderGoalLoopRoundPrompt,
  type GoalLoopRoundPromptInput,
} from "./prompt.js";

/**
 * The inputs to {@link goalLoopRoundMechanismFromResultFile}: exactly the
 * {@link FinalizeWorkflowStepFromResultFileInput} the shared finalize seam takes
 * (repo, base HEAD, the result document path, and the verification config). The
 * round's external agent is responsible for having written the result document at
 * `resultFilePath` before this bridge runs.
 */
export type GoalLoopRoundMechanismFromResultFileInput =
  FinalizeWorkflowStepFromResultFileInput & {
    artifactDirectoryIdentity?: ArtifactDirectoryIdentity;
  };

type ArtifactDirectoryIdentity = {
  path: string;
  descriptor: number;
  dev: number;
  ino: number;
};

/**
 * Runner-facing input for a prompted native goal-loop round.
 *
 * The runner reads `promptFilePath` or the in-memory `prompt`, writes exactly one
 * normalized result JSON document at `resultFilePath`, and leaves git commit /
 * reset decisions to Momentum.
 */
export type GoalLoopPromptedRoundRunnerInput = {
  promptFilePath: string;
  resultFilePath: string;
  prompt: string;
};

/**
 * Inputs for the prompted result-file bridge.
 *
 * `promptInput` omits `resultPath` because the bridge derives it from the same
 * `resultFilePath` that finalization will later consume, preventing prompt /
 * result-path drift.
 */
export type GoalLoopRoundMechanismFromPromptedResultFileInput =
  GoalLoopRoundMechanismFromResultFileInput & {
    artifactRoot?: string;
    promptFilePath: string;
    promptInput: Omit<GoalLoopRoundPromptInput, "resultPath">;
    runPromptedRound: (input: GoalLoopPromptedRoundRunnerInput) => void;
  };

/**
 * Run the existing shared goal / iteration finalize safety over a finished round's
 * result document and project the outcome into the {@link GoalLoopRoundMechanismResult}
 * the goal-loop driver consumes. See the module doc for the consistency rules.
 */
export function goalLoopRoundMechanismFromResultFile(
  input: GoalLoopRoundMechanismFromResultFileInput,
): GoalLoopRoundMechanismResult {
  const snapshot = readNormalizedResultFile(input.resultFilePath);
  const finalize: FinalizeWorkflowStepFromResultFileResult = snapshot.ok
    ? finalizeWorkflowStepFromValidatedResult(input, snapshot.result)
    : {
        outcome: snapshot.code,
        resultFilePath: input.resultFilePath,
        error: snapshot.error,
      };
  const captured = snapshot.ok
    ? {
        result: snapshot.result,
        resultDigest: sha256ContentDigest(snapshot.raw),
      }
    : { result: null, resultDigest: null };
  const changedFiles = committedChangedFiles(input, finalize);
  return {
    result: captured.result,
    resultDigest: captured.resultDigest,
    finalize,
    artifacts: goalLoopMechanismArtifacts(
      input,
      finalize,
      captured.resultDigest,
      changedFiles,
    ),
    changedFiles,
  };
}

/**
 * Render the native goal-loop prompt, let a runner author the configured result
 * document, then reuse {@link goalLoopRoundMechanismFromResultFile} for parsing,
 * verification, commit/reset, and recovery classification.
 *
 * The prompt path is a runner input artifact, not a durable classification
 * source. If the runner does not write a usable result file, the existing
 * result-file mechanism still routes to explicit `result_missing` or
 * `result_invalid` recovery evidence.
 */
export function goalLoopRoundMechanismFromPromptedResultFile(
  input: GoalLoopRoundMechanismFromPromptedResultFileInput,
): GoalLoopRoundMechanismResult {
  let directory: ArtifactDirectoryIdentity;
  try {
    directory = openArtifactDirectory(input);
  } catch (error) {
    return promptedRoundRecovery(
      input,
      "result_invalid",
      `goal-loop artifact directory is unsafe: ${errorMessage(error)}`,
    );
  }

  try {
    const securedInput = {
      ...input,
      artifactDirectoryIdentity: directory,
    };
    const clearedResult = clearPromptedResultFile(
      input.resultFilePath,
      directory,
    );
    if (!clearedResult.ok) {
      return promptedRoundRecovery(
        securedInput,
        "result_invalid",
        `goal-loop result path could not be prepared: ${clearedResult.error}`,
      );
    }

    let prompt: string;
    try {
      prompt = renderGoalLoopRoundPrompt({
        ...input.promptInput,
        resultPath: input.resultFilePath,
      });
      writePrivateArtifact(input.promptFilePath, prompt, directory);
    } catch (error) {
      return promptedRoundRecovery(
        securedInput,
        promptedResultRecoveryOutcome(input.resultFilePath),
        `goal-loop round prompt could not be written: ${errorMessage(error)}`,
      );
    }

    try {
      input.runPromptedRound({
        promptFilePath: input.promptFilePath,
        resultFilePath: input.resultFilePath,
        prompt,
      });
      assertArtifactDirectoryIdentity(directory);
    } catch (error) {
      return promptedRoundRecovery(
        securedInput,
        promptedResultRecoveryOutcome(input.resultFilePath),
        `goal-loop prompted runner failed: ${errorMessage(error)}`,
      );
    }

    return goalLoopRoundMechanismFromResultFile(securedInput);
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function clearPromptedResultFile(
  resultFilePath: string,
  directory: ArtifactDirectoryIdentity,
): { ok: true } | { ok: false; error: string } {
  if (
    typeof resultFilePath !== "string" ||
    resultFilePath.trim().length === 0
  ) {
    return { ok: true };
  }
  try {
    assertArtifactDirectoryIdentity(directory);
    fs.rmSync(resultFilePath, { force: true });
    assertArtifactDirectoryIdentity(directory);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function openArtifactDirectory(
  input: GoalLoopRoundMechanismFromPromptedResultFileInput,
): ArtifactDirectoryIdentity {
  const directories = [
    input.promptFilePath,
    input.resultFilePath,
    input.verificationLogPath,
  ].map((filePath) => path.resolve(path.dirname(filePath)));
  const directoryPath = directories[0];
  if (
    directoryPath === undefined ||
    directories.some((candidate) => candidate !== directoryPath)
  ) {
    throw new Error("goal-loop artifacts must share one round directory");
  }
  const pathStat = fs.lstatSync(directoryPath);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("round artifact root is not a directory");
  }
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0),
  );
  const descriptorStat = fs.fstatSync(descriptor);
  if (
    !descriptorStat.isDirectory() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    fs.closeSync(descriptor);
    throw new Error("round artifact root changed while it was opened");
  }
  return {
    path: directoryPath,
    descriptor,
    dev: descriptorStat.dev,
    ino: descriptorStat.ino,
  };
}

function assertArtifactDirectoryIdentity(
  directory: ArtifactDirectoryIdentity,
): void {
  const descriptorStat = fs.fstatSync(directory.descriptor);
  const pathStat = fs.lstatSync(directory.path);
  if (
    !descriptorStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    descriptorStat.dev !== directory.dev ||
    descriptorStat.ino !== directory.ino ||
    pathStat.dev !== directory.dev ||
    pathStat.ino !== directory.ino
  ) {
    throw new Error("round artifact root identity changed");
  }
}

function artifactDirectoryIdentityIsCurrent(
  directory: ArtifactDirectoryIdentity,
): boolean {
  try {
    assertArtifactDirectoryIdentity(directory);
    return true;
  } catch {
    return false;
  }
}

function writePrivateArtifact(
  filePath: string,
  body: string,
  directory: ArtifactDirectoryIdentity,
): void {
  if (path.resolve(path.dirname(filePath)) !== directory.path) {
    throw new Error("artifact path escapes the round directory");
  }
  assertArtifactDirectoryIdentity(directory);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("artifact path is not a private regular file");
    }
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, body, "utf-8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertArtifactDirectoryIdentity(directory);
}

function promptedResultRecoveryOutcome(
  resultFilePath: string,
): "result_missing" | "result_invalid" {
  try {
    fs.lstatSync(resultFilePath);
    return "result_invalid";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "result_missing" : "result_invalid";
  }
}

function promptedRoundRecovery(
  input: GoalLoopRoundMechanismFromResultFileInput,
  outcome: "result_missing" | "result_invalid",
  error: string,
): GoalLoopRoundMechanismResult {
  const finalize: FinalizeWorkflowStepFromResultFileResult = {
    outcome,
    resultFilePath: input.resultFilePath,
    error,
  };
  return {
    result: null,
    resultDigest: null,
    finalize,
    artifacts:
      input.artifactDirectoryIdentity !== undefined &&
      !artifactDirectoryIdentityIsCurrent(input.artifactDirectoryIdentity)
        ? {}
        : goalLoopMechanismArtifacts(input, finalize, null, []),
    changedFiles: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

/**
 * The repository-relative paths this round committed (the round-schema
 * `changed_files` field), derived from the commit the finalize transaction
 * produced. Only a `committed` outcome advanced HEAD, so every other outcome
 * committed nothing and reports the empty change set. Kept total: the commit
 * already succeeded, so a diff-query failure falls back to the empty set rather
 * than turning the mechanism into a throw.
 */
function committedChangedFiles(
  input: GoalLoopRoundMechanismFromResultFileInput,
  finalize: FinalizeWorkflowStepFromResultFileResult,
): string[] {
  if (finalize.outcome !== "committed") return [];
  try {
    return listCommittedChangedFiles(
      input.repoPath,
      finalize.commit.parentSha,
      finalize.commit.commitSha,
    );
  } catch {
    return [];
  }
}

/**
 * The self-describing content digest of an artifact's raw bytes. The `sha256:`
 * prefix records the algorithm in the durable record so a later reattach can
 * re-verify the artifact even if the hash family evolves. Used for the result
 * document, verification log, and finalization sidecar so bridge-owned file
 * artifacts fingerprint identically.
 */
function sha256ContentDigest(raw: string): string {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * The content digest of the verification log the finalize seam wrote, or `null`
 * when the log cannot be read. Only computed when the bridge reports a
 * `verification_output` pointer — verification actually ran, so `runVerification`
 * already opened and wrote the log file — making that artifact row self-verifying
 * on reattach, the same guarantee the result-document digest gives. It matters
 * most on a reset, where the verification log is the primary evidence the round
 * did not commit. Defensively total (returns `null` on any read failure) so the
 * mechanism never throws.
 */
function verificationLogDigest(verificationLogPath: string): string | null {
  let handle: number;
  try {
    handle = fs.openSync(
      verificationLogPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return null;
    return sha256ContentDigest(fs.readFileSync(handle, "utf-8"));
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Build the round's reported artifact pointers from the files this bridge owns:
 * the result document (whenever it exists), the verification log (whenever
 * verification actually ran, per the finalize evidence's verification verdict),
 * and the commit/reset finalization sidecar written next to the verification log
 * when the log path is a usable absolute path. The result-document pointer
 * carries the same content digest stamped onto the round's `result_digest` field
 * (whenever the document was usable), and the sidecar captures commit metadata,
 * changed files, verification status, recovery code, and finalize errors. The
 * artifact rows are self-verifying and cannot drift from their files. The
 * orchestrator derives `logs` from the round-start record's frozen `logPaths`,
 * so they are not reported here.
 */
function goalLoopMechanismArtifacts(
  input: GoalLoopRoundMechanismFromResultFileInput,
  finalize: FinalizeWorkflowStepFromResultFileResult,
  resultDigest: string | null,
  changedFiles: readonly string[],
): GoalLoopRoundArtifacts {
  const evidence = goalLoopFinalizeEvidenceFromResult(finalize);
  const finalizationEvidence = writeFinalizationEvidence(
    input,
    finalize,
    evidence.verificationStatus,
    changedFiles,
  );
  return {
    ...(finalize.outcome !== "result_missing"
      ? {
          resultDocument: {
            path: input.resultFilePath,
            ...(resultDigest !== null ? { digest: resultDigest } : {}),
          },
        }
      : {}),
    ...(evidence.verificationStatus !== null
      ? {
          verificationOutput: verificationOutputPointer(
            input.verificationLogPath,
          ),
        }
      : {}),
    ...(finalizationEvidence !== null
      ? { commitOrResetEvidence: finalizationEvidence }
      : {}),
  };
}

/**
 * The `verification_output` evidence pointer: the verification log path the
 * finalize seam wrote, plus a content digest of its bytes (omitted only if the
 * log is unexpectedly unreadable) so the durable artifact row is self-verifying
 * and cannot drift from the file it points at.
 */
function verificationOutputPointer(
  verificationLogPath: string,
): GoalLoopArtifactPointer {
  const digest = verificationLogDigest(verificationLogPath);
  return {
    path: verificationLogPath,
    ...(digest !== null ? { digest } : {}),
  };
}

/**
 * Write the round-finalization sidecar that backs the
 * `commit_or_reset_evidence` artifact. The file sits next to the verification log
 * (`<verification-log>.finalization.json`), uses the stable
 * `momentum.goal-loop.finalization-evidence.v1` schema, and summarizes the
 * finalize outcome without requiring operators to infer commit/reset ownership
 * from terminal output.
 */
function writeFinalizationEvidence(
  input: GoalLoopRoundMechanismFromResultFileInput,
  finalize: FinalizeWorkflowStepFromResultFileResult,
  verificationStatus: string | null,
  changedFiles: readonly string[],
): GoalLoopArtifactPointer | null {
  const evidencePath = finalizationEvidencePath(input.verificationLogPath);
  if (evidencePath === null) return null;
  const body = `${JSON.stringify(
    {
      schema: "momentum.goal-loop.finalization-evidence.v1",
      outcome: finalize.outcome,
      commitSha:
        finalize.outcome === "committed" ? finalize.commit.commitSha : null,
      commitMessage:
        finalize.outcome === "committed" ? finalize.commit.message : null,
      parentSha:
        finalize.outcome === "committed" ? finalize.commit.parentSha : null,
      changedFiles: [...changedFiles],
      verificationStatus,
      recoveryCode: finalizationRecoveryCode(finalize),
      resultFilePath: input.resultFilePath,
      verificationLogPath: input.verificationLogPath,
      error: finalizationError(finalize),
      commitError: finalizationCommitError(finalize),
      resetError: finalizationResetError(finalize),
    },
    null,
    2,
  )}\n`;
  try {
    if (input.artifactDirectoryIdentity !== undefined) {
      writePrivateArtifact(evidencePath, body, input.artifactDirectoryIdentity);
    } else {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      const descriptor = fs.openSync(
        evidencePath,
        fs.constants.O_CREAT |
          fs.constants.O_WRONLY |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) return null;
        fs.ftruncateSync(descriptor, 0);
        fs.writeFileSync(descriptor, body, "utf-8");
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch {
    return null;
  }
  return { path: evidencePath, digest: sha256ContentDigest(body) };
}

function finalizationEvidencePath(verificationLogPath: string): string | null {
  if (
    typeof verificationLogPath !== "string" ||
    verificationLogPath.trim().length === 0 ||
    verificationLogPath.trim() !== verificationLogPath ||
    !path.isAbsolute(verificationLogPath) ||
    path.basename(verificationLogPath).length === 0
  ) {
    return null;
  }
  return `${verificationLogPath}.finalization.json`;
}

function finalizationRecoveryCode(
  finalize: FinalizeWorkflowStepFromResultFileResult,
): string | null {
  switch (finalize.outcome) {
    case "committed":
    case "reset_step_failure":
    case "reset_verification_failure":
      return null;
    case "manual_recovery_required":
      return finalize.recoveryCode;
    case "reset_failed":
      return finalize.reset.code;
    case "commit_failed":
      return commitFailureResetFailure(finalize)?.code ?? finalize.commit.code;
    case "git_failed":
    case "repo_lock_lost":
    case "invalid_input":
    case "result_missing":
    case "result_invalid":
      return finalize.outcome;
  }
}

function finalizationError(
  finalize: FinalizeWorkflowStepFromResultFileResult,
): string | null {
  switch (finalize.outcome) {
    case "committed":
    case "reset_step_failure":
    case "reset_verification_failure":
      return null;
    case "manual_recovery_required":
      return finalize.reason;
    case "reset_failed":
      return finalize.reset.error;
    case "commit_failed":
      return (
        commitFailureResetFailure(finalize)?.error ?? finalize.commit.error
      );
    case "git_failed":
    case "repo_lock_lost":
    case "invalid_input":
    case "result_missing":
    case "result_invalid":
      return finalize.error;
  }
}

function finalizationCommitError(
  finalize: FinalizeWorkflowStepFromResultFileResult,
): string | null {
  return finalize.outcome === "commit_failed" ? finalize.commit.error : null;
}

function finalizationResetError(
  finalize: FinalizeWorkflowStepFromResultFileResult,
): string | null {
  switch (finalize.outcome) {
    case "reset_failed":
      return finalize.reset.error;
    case "commit_failed":
      return commitFailureResetFailure(finalize)?.error ?? null;
    default:
      return null;
  }
}

function commitFailureResetFailure(
  finalize: Extract<
    FinalizeWorkflowStepFromResultFileResult,
    { outcome: "commit_failed" }
  >,
): Extract<NonNullable<typeof finalize.reset>, { ok: false }> | null {
  if (finalize.reset !== undefined && !finalize.reset.ok) {
    return finalize.reset;
  }
  return null;
}
