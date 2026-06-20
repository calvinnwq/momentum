/**
 * Goal-loop executor adapter — round mechanism bridge (M10-05, NGX-349).
 *
 * `goal-loop-orchestrator.ts` drives one bounded round through its durable
 * lifecycle around an *injected* {@link GoalLoopRoundRunner} mechanism; every
 * test so far has injected a deterministic fake mechanism. This module is the
 * concrete mechanism that reuses the existing Goal / iteration safety the ticket
 * asks for ("Reuse existing Goal / iteration safety where possible") rather than
 * re-implementing it: given the post-runner inputs (the repo, the base HEAD the
 * round started from, the normalized result document the round wrote, and the
 * verification config), it runs the shared `finalizeWorkflowStepFromResultFile`
 * verify -> commit / reset transaction and projects the outcome into the
 * {@link GoalLoopRoundMechanismResult} the driver consumes.
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
 *     result document (whenever the file exists) and the verification log
 *     (whenever verification actually ran, per the finalize evidence). Both carry
 *     a `sha256:` content digest of their bytes so the durable artifact rows are
 *     self-verifying on reattach and cannot drift from the files they point at.
 *     It never invents a path; the orchestrator still derives the `logs`
 *     artifacts from the round-start record's frozen `logPaths`.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { listCommittedChangedFiles } from "../../adapters/git-transaction.js";
import {
  goalLoopFinalizeEvidenceFromResult,
  type GoalLoopArtifactPointer,
  type GoalLoopRoundArtifacts
} from "./goal-loop-executor.js";
import type { GoalLoopRoundMechanismResult } from "./goal-loop-orchestrator.js";
import {
  finalizeWorkflowStepFromResultFile,
  type FinalizeWorkflowStepFromResultFileInput,
  type FinalizeWorkflowStepFromResultFileResult
} from "./step-finalize.js";
import { parseRunnerResult } from "./runner-result.js";
import type { RunnerResult } from "./types.js";

/**
 * The inputs to {@link goalLoopRoundMechanismFromResultFile}: exactly the
 * {@link FinalizeWorkflowStepFromResultFileInput} the shared finalize seam takes
 * (repo, base HEAD, the result document path, and the verification config). The
 * round's external agent is responsible for having written the result document at
 * `resultFilePath` before this bridge runs.
 */
export type GoalLoopRoundMechanismFromResultFileInput =
  FinalizeWorkflowStepFromResultFileInput;

/**
 * Run the existing shared goal / iteration finalize safety over a finished round's
 * result document and project the outcome into the {@link GoalLoopRoundMechanismResult}
 * the goal-loop driver consumes. See the module doc for the consistency rules.
 */
export function goalLoopRoundMechanismFromResultFile(
  input: GoalLoopRoundMechanismFromResultFileInput
): GoalLoopRoundMechanismResult {
  const finalize = finalizeWorkflowStepFromResultFile(input);
  const captured = documentUnusable(finalize)
    ? { result: null, resultDigest: null }
    : readResultForCapture(input.resultFilePath);
  return {
    result: captured.result,
    resultDigest: captured.resultDigest,
    finalize,
    artifacts: goalLoopMechanismArtifacts(
      input,
      finalize,
      captured.resultDigest
    ),
    changedFiles: committedChangedFiles(input, finalize)
  };
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
  finalize: FinalizeWorkflowStepFromResultFileResult
): string[] {
  if (finalize.outcome !== "committed") return [];
  try {
    return listCommittedChangedFiles(
      input.repoPath,
      finalize.commit.parentSha,
      finalize.commit.commitSha
    );
  } catch {
    return [];
  }
}

/**
 * Whether the finalize seam judged the result document unusable. These are the
 * only outcomes for which the round produced no result to capture; the bridge
 * returns a `null` result so the driver routes straight to manual recovery
 * instead of capturing from a document the finalize seam refused to trust.
 */
function documentUnusable(
  finalize: FinalizeWorkflowStepFromResultFileResult
): boolean {
  return (
    finalize.outcome === "result_missing" ||
    finalize.outcome === "result_invalid"
  );
}

/**
 * The result document the round captured, with its content digest. Both fields
 * are `null` together (an unreadable / unparseable document yields no result and
 * no digest) so the digest can never claim to fingerprint a result the round did
 * not capture.
 */
type CapturedResultDocument = {
  result: RunnerResult | null;
  resultDigest: string | null;
};

/**
 * Re-read the normalized result document into the {@link RunnerResult} the round
 * captures, plus a content digest of its exact bytes (the round-schema
 * `result_digest` reattach fingerprint). Only called when the finalize seam
 * already accepted the document, so this read succeeds in practice; it is
 * defensively total (returns an all-`null` capture on any read / parse failure)
 * so the mechanism never throws.
 */
function readResultForCapture(resultFilePath: string): CapturedResultDocument {
  let raw: string;
  try {
    raw = fs.readFileSync(resultFilePath, "utf-8");
  } catch {
    return { result: null, resultDigest: null };
  }
  const parsed = parseRunnerResult(raw);
  if (!parsed.ok) {
    return { result: null, resultDigest: null };
  }
  return { result: parsed.value, resultDigest: sha256ContentDigest(raw) };
}

/**
 * The self-describing content digest of an artifact's raw bytes. The `sha256:`
 * prefix records the algorithm in the durable record so a later reattach can
 * re-verify the artifact even if the hash family evolves. Used for both the
 * result document and the verification log, so the two bridge-owned file
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
  let raw: string;
  try {
    raw = fs.readFileSync(verificationLogPath, "utf-8");
  } catch {
    return null;
  }
  return sha256ContentDigest(raw);
}

/**
 * Build the round's reported artifact pointers from the files this bridge owns:
 * the result document (whenever it exists — every outcome except a missing file)
 * and the verification log (whenever verification actually ran, per the finalize
 * evidence's verification verdict). The result-document pointer carries the same
 * content digest stamped onto the round's `result_digest` field (whenever the
 * document was usable), so the artifact row is self-verifying and cannot drift
 * from the round field. The orchestrator derives `logs` from the round-start
 * record's frozen `logPaths`, so they are not reported here.
 */
function goalLoopMechanismArtifacts(
  input: GoalLoopRoundMechanismFromResultFileInput,
  finalize: FinalizeWorkflowStepFromResultFileResult,
  resultDigest: string | null
): GoalLoopRoundArtifacts {
  const evidence = goalLoopFinalizeEvidenceFromResult(finalize);
  return {
    ...(finalize.outcome !== "result_missing"
      ? {
          resultDocument: {
            path: input.resultFilePath,
            ...(resultDigest !== null ? { digest: resultDigest } : {})
          }
        }
      : {}),
    ...(evidence.verificationStatus !== null
      ? {
          verificationOutput: verificationOutputPointer(
            input.verificationLogPath
          )
        }
      : {})
  };
}

/**
 * The `verification_output` evidence pointer: the verification log path the
 * finalize seam wrote, plus a content digest of its bytes (omitted only if the
 * log is unexpectedly unreadable) so the durable artifact row is self-verifying
 * and cannot drift from the file it points at.
 */
function verificationOutputPointer(
  verificationLogPath: string
): GoalLoopArtifactPointer {
  const digest = verificationLogDigest(verificationLogPath);
  return {
    path: verificationLogPath,
    ...(digest !== null ? { digest } : {})
  };
}
