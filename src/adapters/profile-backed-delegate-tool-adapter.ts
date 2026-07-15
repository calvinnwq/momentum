import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { commitVerifiedChanges, resetToBase } from "./git-transaction.js";
import { LIVE_STEP_WRAPPER_RESULT_MAX_BYTES } from "./live-step-wrapper.js";
import {
  commitIdentitiesMatch,
  createNoMistakesToolAdapter,
  parseNoMistakesAxiStatus,
  parseNoMistakesLaunchIdentity,
  settleNoMistakesHandoffState,
} from "./no-mistakes-tool-adapter.js";
import { classifyDelegateSupervisorState } from "../core/executors/delegate-supervisor/classifier.js";
import type {
  DelegateSupervisorExternalIdentity,
  DelegateSupervisorExternalState,
  DelegateSupervisorExternalStateRead,
  DelegateSupervisorHandoff,
  DelegateSupervisorToolAdapter,
} from "../core/executors/delegate-supervisor/types.js";
import {
  finalizeLiveStepResult,
  isProvenClean,
  type LiveStepSdkHostBindings,
} from "../core/executors/live-step/sdk-executor.js";
import { parseRunnerResult } from "../core/executors/runner/result.js";
import type { WorkflowStepExecutorDispatchResult } from "../core/workflow/step/executor.js";

export function resolveDelegateBranch(repoPath: string): string {
  try {
    const branch = execFileSync(
      "git",
      ["-C", repoPath, "branch", "--show-current"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return branch.length > 0 ? branch : "detached-head";
  } catch {
    return "unknown-branch";
  }
}

export type ProfileBackedDelegateToolInput = {
  tool: string;
  invocationId: string;
  attempt: number;
  branch: string;
  headSha: string;
  statePath: string;
  handoffReceiptPath: string;
  resultJsonPath: string;
  executorLogPath: string;
  repoPath: string;
  repoSafety: NonNullable<LiveStepSdkHostBindings["repoSafety"]>;
  run: LiveStepSdkHostBindings["run"];
  statusCommand: string;
  statusArgsPrefix: readonly string[];
  statusEnv: Record<string, string | undefined>;
  legacyPaths: {
    rootDir: string;
    handoffReceiptPath: string;
  };
};

function verifyDelegateCommitOwnership(
  input: Pick<ProfileBackedDelegateToolInput, "repoSafety">,
): { ok: true } | { ok: false; error: string } {
  const ownership = input.repoSafety.beforeGitMutation?.("commit");
  return ownership?.ok === false ? ownership : { ok: true };
}

type DelegateDispatchOutcome =
  | { ok: true; state: "succeeded" | "failed"; summary: string }
  | { ok: false; code: string; error: string };

type LiveWrapperDelegateReceipt = {
  schemaVersion: 1;
  tool: string;
  invocationId: string;
  attempt: number;
  phase: "launched" | "completed" | "resetting" | "finalizing" | "finalized";
  baseHead: string;
  branch: string;
  statePath: string;
  resultJsonPath: string;
  executorLogPath: string;
  verificationLogPath: string;
  preexistingResultDigest: string | null;
  resultDigest?: string | null;
  worktreeTree?: string;
  dispatchOutcome?: DelegateDispatchOutcome;
  expectedTree?: string;
  expectedMessage?: string;
  externalState?: DelegateSupervisorExternalState;
};

type NoMistakesDelegateReceipt = {
  schemaVersion: 1;
  invocationId: string;
  attempt: number;
  phase:
    | "launching"
    | "completed"
    | "resetting"
    | "finalizing"
    | "launched"
    | "failed";
  branch: string;
  headSha: string;
  statePath: string;
  resultJsonPath: string;
  executorLogPath: string;
  externalIdentity?: DelegateSupervisorExternalIdentity;
  dispatchOutcome?: DelegateDispatchOutcome;
  resultDigest?: string | null;
  worktreeTree?: string;
  expectedTree?: string;
  expectedMessage?: string;
  failureSummary?: string;
  terminalProofHeadSha?: string;
};

type DelegateReceiptReadInput = Pick<
  ProfileBackedDelegateToolInput,
  | "tool"
  | "invocationId"
  | "attempt"
  | "repoPath"
  | "handoffReceiptPath"
  | "statePath"
  | "resultJsonPath"
  | "executorLogPath"
  | "legacyPaths"
>;

/**
 * Read a step-scoped finalization receipt into the narrow evidence accepted by
 * repo preflight for recovery of an exactly staged delegate commit.
 */
export function resolvePreparedDelegateCommitEvidence(
  input: DelegateReceiptReadInput,
): {
  baseHead: string;
  expectedTree: string;
  treeSource?: "index" | "worktree";
} | null {
  try {
    const canonicalRepoPath = fs.realpathSync(input.repoPath);
    const requestedRunPath = path.resolve(input.legacyPaths.rootDir);
    const canonicalRunPath = fs.realpathSync(requestedRunPath);
    const canonicalizeRunPath = (candidate: string) => {
      const relative = path.relative(requestedRunPath, path.resolve(candidate));
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          "delegate recovery path escapes the configured run directory",
        );
      }
      return path.resolve(canonicalRunPath, relative);
    };
    const canonicalInput: DelegateReceiptReadInput = {
      ...input,
      repoPath: canonicalRepoPath,
      handoffReceiptPath: canonicalizeRunPath(input.handoffReceiptPath),
      statePath: canonicalizeRunPath(input.statePath),
      resultJsonPath: canonicalizeRunPath(input.resultJsonPath),
      executorLogPath: canonicalizeRunPath(input.executorLogPath),
      legacyPaths: {
        rootDir: canonicalRunPath,
        handoffReceiptPath: canonicalizeRunPath(
          input.legacyPaths.handoffReceiptPath,
        ),
      },
    };
    if (!fs.existsSync(canonicalInput.handoffReceiptPath)) return null;
    if (canonicalInput.tool === "no-mistakes") {
      const receipt = readNoMistakesHandoffReceipt(canonicalInput);
      if (!["completed", "finalizing", "failed"].includes(receipt.phase)) {
        return null;
      }
      if (
        !delegateReceiptPathsMatchConfiguredArtifacts(canonicalInput, receipt)
      ) {
        return null;
      }
      if (
        receipt.phase === "failed" &&
        (typeof receipt.resultDigest !== "string" ||
          typeof receipt.worktreeTree !== "string" ||
          receipt.dispatchOutcome?.ok !== true ||
          receipt.dispatchOutcome.state !== "succeeded")
      ) {
        return null;
      }
      assertNoMistakesResultMatchesReceipt(receipt);
      if (receipt.phase === "completed" || receipt.phase === "failed") {
        return typeof receipt.worktreeTree === "string"
          ? {
              baseHead: receipt.headSha,
              expectedTree: receipt.worktreeTree,
              treeSource: "worktree",
            }
          : null;
      }
      return {
        baseHead: receipt.headSha,
        expectedTree: receipt.expectedTree!,
      };
    }

    const receipt = readLiveWrapperDelegateReceipt(canonicalInput);
    if (
      !["completed", "resetting", "finalizing"].includes(receipt.phase) ||
      !delegateReceiptPathsMatchConfiguredArtifacts(canonicalInput, receipt) ||
      typeof receipt.resultDigest !== "string" ||
      !resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)
    ) {
      return null;
    }
    const recovered = readRecoveredLiveWrapperResult(receipt);
    if (
      receipt.dispatchOutcome === undefined ||
      !receipt.dispatchOutcome.ok ||
      !recovered.ok ||
      (receipt.phase === "finalizing" &&
        recovered.result.state !== "succeeded") ||
      recovered.result.state !== receipt.dispatchOutcome.state ||
      recovered.result.summary !== receipt.dispatchOutcome.summary
    ) {
      return null;
    }
    if (receipt.phase === "completed" || receipt.phase === "resetting") {
      if (typeof receipt.worktreeTree !== "string") return null;
      return {
        baseHead: receipt.baseHead,
        expectedTree: receipt.worktreeTree,
        treeSource: "worktree",
      };
    }
    return {
      baseHead: receipt.baseHead,
      expectedTree: receipt.expectedTree!,
    };
  } catch {
    return null;
  }
}

export function createProfileBackedDelegateToolAdapter(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorToolAdapter {
  return input.tool === "no-mistakes"
    ? createProfileNoMistakesToolAdapter(input)
    : createLiveWrapperDelegateToolAdapter(input);
}

function createLiveWrapperDelegateToolAdapter(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorToolAdapter {
  const artifactPaths = [
    input.statePath,
    input.handoffReceiptPath,
    input.resultJsonPath,
    input.executorLogPath,
    input.repoSafety.verificationLogPath,
  ];
  return {
    name: input.tool,
    handoff: async () => {
      const launched: LiveWrapperDelegateReceipt = {
        schemaVersion: 1,
        tool: input.tool,
        invocationId: input.invocationId,
        attempt: input.attempt,
        phase: "launched",
        baseHead: input.headSha,
        branch: input.branch,
        statePath: input.statePath,
        resultJsonPath: input.resultJsonPath,
        executorLogPath: input.executorLogPath,
        verificationLogPath: input.repoSafety.verificationLogPath,
        preexistingResultDigest: fileDigest(input.resultJsonPath),
      };
      writeJsonAtomically(input.handoffReceiptPath, launched);
      const raw = await input.run();
      const resultDigest = fileDigest(input.resultJsonPath);
      const worktreeTree = captureWorktreeTree(
        input.repoPath,
        input.headSha,
        path.dirname(input.handoffReceiptPath),
      );
      const completed: LiveWrapperDelegateReceipt = {
        ...launched,
        phase: "completed",
        resultDigest,
        worktreeTree,
        dispatchOutcome: raw.ok
          ? {
              ok: true,
              state: raw.result.state === "succeeded" ? "succeeded" : "failed",
              summary: raw.result.summary,
            }
          : { ok: false, code: raw.code, error: raw.error },
      };
      const correlated = readRecoveredLiveWrapperResult(completed);
      // The dispatch contract intentionally exposes only terminal state and
      // summary. The normalized result file is authoritative for commit intent
      // and all other runner fields, and resultDigest binds that complete file
      // through finalization and recovery.
      if (
        completed.dispatchOutcome === undefined ||
        completed.dispatchOutcome.ok !== correlated.ok ||
        (completed.dispatchOutcome.ok &&
          correlated.ok &&
          (correlated.result.state !== completed.dispatchOutcome.state ||
            correlated.result.summary !== completed.dispatchOutcome.summary))
      ) {
        throw new Error(
          `delegated ${input.tool} result does not match its in-memory dispatch outcome`,
        );
      }
      writeJsonAtomically(input.handoffReceiptPath, completed);
      let preparedReceipt = completed;
      const finalized = finalizeLiveStepResult(raw, input.repoPath, {
        ...input.repoSafety,
        beforeGitMutation: (mutation) => {
          if (!resultDigestMatches(resultDigest, input.resultJsonPath)) {
            return {
              ok: false,
              error:
                "delegated live-wrapper result no longer matches its completed handoff",
            };
          }
          const ownership = input.repoSafety.beforeGitMutation?.(mutation);
          if (ownership?.ok === false) return ownership;
          if (mutation !== "reset") return { ok: true };
          preparedReceipt = {
            ...completed,
            phase: "resetting",
            expectedTree: resolveCommitTree(input.repoPath, input.headSha),
          };
          try {
            writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: `delegated handoff receipt could not be persisted before reset: ${errorMessage(error)}`,
            };
          }
        },
        beforeCommit: ({ expectedTree, message }) => {
          if (!resultDigestMatches(resultDigest, input.resultJsonPath)) {
            return {
              ok: false,
              error:
                "delegated live-wrapper result no longer matches its completed handoff",
            };
          }
          const ownership = verifyDelegateCommitOwnership(input);
          if (!ownership.ok) return ownership;
          preparedReceipt = {
            ...completed,
            phase: "finalizing",
            resultDigest,
            expectedTree,
            expectedMessage: message,
          };
          try {
            writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: `delegated handoff receipt could not be persisted before commit: ${errorMessage(error)}`,
            };
          }
        },
      });
      if (!isProvenClean(finalized) || !finalized.ok) {
        throw new Error(
          finalized.ok
            ? (finalized.result.errorMessage ?? finalized.result.summary)
            : finalized.error,
        );
      }
      const identity = {
        externalRunId: input.invocationId,
        branch: resolveDelegateBranch(input.repoPath),
        headSha: resolveCurrentHead(input.repoPath, input.headSha),
      };
      const externalState: DelegateSupervisorExternalState = {
        ...identity,
        activeStep: null,
        stepStatus:
          finalized.result.state === "succeeded" ? "completed" : "failed",
        findings: [],
        selectedFindingIds: [],
        decisions: [],
        prUrl: null,
        ciState: "none",
      };
      writeJsonAtomically(input.handoffReceiptPath, {
        ...preparedReceipt,
        phase: "finalized",
        externalState,
      } satisfies LiveWrapperDelegateReceipt);
      writeJsonAtomically(input.statePath, externalState);
      const completedArtifacts = [
        ...artifactPaths,
        ...finalized.result.artifacts.map((artifact) => artifact.path),
      ].filter((value, index, values) => values.indexOf(value) === index);
      return {
        externalIdentity: identity,
        summary: finalized.result.summary,
        artifactPaths: completedArtifacts,
      };
    },
    recoverHandoff: () => {
      return recoverLiveWrapperDelegateHandoff(input);
    },
    readExternalState: ({ handoff }) =>
      readRepoBoundPersistedDelegateState(
        input.repoPath,
        handoff.artifactPaths,
        {
          tool: input.tool,
          identity: handoff.externalIdentity,
        },
      ),
  };
}

function recoverLiveWrapperDelegateHandoff(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorHandoff {
  const migrated = migrateLegacyLiveWrapperDelegateHandoff(input);
  if (migrated !== null) return migrated;
  const receipt = readLiveWrapperDelegateReceipt(input);
  if (receipt.phase === "finalized") {
    if (receipt.externalState === undefined) {
      throw new Error(
        "finalized delegated handoff receipt has no external state",
      );
    }
    return persistRecoveredLiveWrapperHandoff(
      input,
      receipt,
      receipt.externalState,
    );
  }

  if (receipt.phase === "launched") {
    throw new Error(
      `interrupted ${input.tool} handoff has no durable wrapper-completion evidence`,
    );
  }

  const recovered = readRecoveredLiveWrapperResult(receipt);
  const digest = fileDigest(receipt.resultJsonPath);
  if (digest === null || digest !== receipt.resultDigest) {
    throw new Error(
      `interrupted ${input.tool} handoff has no correlated completed result`,
    );
  }
  if (
    receipt.dispatchOutcome === undefined ||
    !receipt.dispatchOutcome.ok ||
    !recovered.ok ||
    recovered.result.state !== receipt.dispatchOutcome.state ||
    recovered.result.summary !== receipt.dispatchOutcome.summary
  ) {
    throw new Error(
      `interrupted ${input.tool} handoff wrapper outcome is not safely recoverable`,
    );
  }

  const currentHead = resolveCurrentHead(input.repoPath, "");
  if (currentHead !== receipt.baseHead) {
    if (
      receipt.phase !== "finalizing" ||
      recovered.result.state !== "succeeded" ||
      !isRecoveredDelegateCommit(input.repoPath, currentHead, receipt)
    ) {
      throw new Error(
        `interrupted ${input.tool} handoff repository state does not match its durable finalization receipt`,
      );
    }
    const externalState = liveWrapperDelegateExternalState(
      receipt,
      "completed",
      currentHead,
    );
    return persistRecoveredLiveWrapperHandoff(input, receipt, externalState);
  }

  const currentTree = captureWorktreeTree(
    input.repoPath,
    receipt.baseHead,
    path.dirname(input.handoffReceiptPath),
  );
  if (receipt.phase === "resetting" && currentTree === receipt.expectedTree) {
    const externalState = liveWrapperDelegateExternalState(
      receipt,
      "failed",
      receipt.baseHead,
    );
    return persistRecoveredLiveWrapperHandoff(input, receipt, externalState);
  }
  const expectedTree =
    receipt.phase === "finalizing" || receipt.phase === "resetting"
      ? receipt.phase === "resetting"
        ? receipt.worktreeTree
        : receipt.expectedTree
      : receipt.worktreeTree;
  if (currentTree !== expectedTree) {
    throw new Error(
      `interrupted ${input.tool} handoff worktree does not match its durable completion receipt`,
    );
  }
  if (receipt.phase === "resetting") {
    if (!resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)) {
      throw new Error(
        "delegated recovered result no longer matches its durable reset receipt",
      );
    }
    const ownership = input.repoSafety.beforeGitMutation?.("reset");
    if (ownership?.ok === false) throw new Error(ownership.error);
    const permit = input.repoSafety.beginGitMutation?.("reset");
    if (permit?.ok === false) throw new Error(permit.error);
    const resetPermit = permit ?? { ok: true as const, release: () => {} };
    let reset: ReturnType<typeof resetToBase>;
    try {
      reset = resetToBase({
        repoPath: input.repoPath,
        baseHead: receipt.baseHead,
      });
    } finally {
      resetPermit.release();
    }
    if (!reset.ok) throw new Error(reset.error);
    const externalState = liveWrapperDelegateExternalState(
      receipt,
      "failed",
      receipt.baseHead,
    );
    return persistRecoveredLiveWrapperHandoff(input, receipt, externalState);
  }
  if (receipt.phase === "finalizing") {
    const runnerResult = readRecoveredRunnerResult(receipt.resultJsonPath);
    const commit = commitVerifiedChanges({
      repoPath: input.repoPath,
      baseHead: receipt.baseHead,
      commit: runnerResult.commit,
      beforeCommit: (evidence) => {
        if (
          !resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)
        ) {
          return {
            ok: false,
            error:
              "delegated prepared commit result no longer matches its durable finalization receipt",
          };
        }
        const ownership = verifyDelegateCommitOwnership(input);
        if (!ownership.ok) return ownership;
        return evidence.expectedTree === receipt.expectedTree &&
          evidence.message === receipt.expectedMessage
          ? { ok: true }
          : {
              ok: false,
              error:
                "delegated prepared commit no longer matches its durable finalization receipt",
            };
      },
    });
    if (!commit.ok) throw new Error(commit.error);
    const externalState = liveWrapperDelegateExternalState(
      receipt,
      "completed",
      commit.commitSha,
    );
    return persistRecoveredLiveWrapperHandoff(input, receipt, externalState);
  }

  let preparedReceipt = receipt;
  const finalized = finalizeLiveStepResult(recovered, input.repoPath, {
    ...input.repoSafety,
    baseHead: receipt.baseHead,
    verificationLogPath: receipt.verificationLogPath,
    beforeGitMutation: (mutation) => {
      if (!resultDigestMatches(digest, receipt.resultJsonPath)) {
        return {
          ok: false,
          error:
            "delegated recovered result no longer matches its durable completion receipt",
        };
      }
      const ownership = input.repoSafety.beforeGitMutation?.(mutation);
      if (ownership?.ok === false) return ownership;
      if (mutation !== "reset") return { ok: true };
      preparedReceipt = {
        ...receipt,
        phase: "resetting",
        resultDigest: digest,
        expectedTree: resolveCommitTree(input.repoPath, receipt.baseHead),
      };
      try {
        writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `delegated handoff receipt could not be persisted before reset: ${errorMessage(error)}`,
        };
      }
    },
    beforeCommit: ({ expectedTree, message }) => {
      if (!resultDigestMatches(digest, receipt.resultJsonPath)) {
        return {
          ok: false,
          error:
            "delegated recovered result no longer matches its durable completion receipt",
        };
      }
      const ownership = verifyDelegateCommitOwnership(input);
      if (!ownership.ok) return ownership;
      preparedReceipt = {
        ...receipt,
        phase: "finalizing",
        resultDigest: digest,
        expectedTree,
        expectedMessage: message,
      };
      try {
        writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `delegated handoff receipt could not be persisted before commit: ${errorMessage(error)}`,
        };
      }
    },
  });
  if (!isProvenClean(finalized) || !finalized.ok) {
    throw new Error(
      finalized.ok
        ? (finalized.result.errorMessage ?? finalized.result.summary)
        : finalized.error,
    );
  }
  const externalState = liveWrapperDelegateExternalState(
    preparedReceipt,
    finalized.result.state === "succeeded" ? "completed" : "failed",
    resolveCurrentHead(input.repoPath, receipt.baseHead),
  );
  return persistRecoveredLiveWrapperHandoff(
    input,
    preparedReceipt,
    externalState,
  );
}

function migrateLegacyLiveWrapperDelegateHandoff(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorHandoff | null {
  if (fs.existsSync(input.handoffReceiptPath)) return null;
  const legacyPaths = legacyDelegateAttemptPaths(input).find((candidate) => {
    if (!fs.existsSync(candidate.statePath)) return false;
    const read = readPersistedDelegateState([candidate.statePath]);
    return (
      read.ok &&
      read.value.externalRunId === input.invocationId &&
      read.value.branch === resolveDelegateBranch(input.repoPath) &&
      read.value.headSha === resolveCurrentHead(input.repoPath, "") &&
      (read.value.stepStatus === "completed" ||
        read.value.stepStatus === "failed")
    );
  });
  if (legacyPaths === undefined) return null;
  const legacy = readPersistedDelegateState([legacyPaths.statePath]);
  if (
    !legacy.ok ||
    legacy.value.externalRunId !== input.invocationId ||
    legacy.value.branch !== resolveDelegateBranch(input.repoPath) ||
    legacy.value.headSha !== resolveCurrentHead(input.repoPath, "") ||
    (legacy.value.stepStatus !== "completed" &&
      legacy.value.stepStatus !== "failed")
  ) {
    return null;
  }
  const receipt: LiveWrapperDelegateReceipt = {
    schemaVersion: 1,
    tool: input.tool,
    invocationId: input.invocationId,
    attempt: input.attempt,
    phase: "finalized",
    baseHead: legacy.value.headSha,
    branch: legacy.value.branch,
    statePath: input.statePath,
    resultJsonPath: input.resultJsonPath,
    executorLogPath: input.executorLogPath,
    verificationLogPath: input.repoSafety.verificationLogPath,
    preexistingResultDigest: null,
    externalState: legacy.value,
  };
  writeJsonAtomically(input.statePath, legacy.value);
  writeJsonAtomically(input.handoffReceiptPath, receipt);
  return {
    externalIdentity: {
      externalRunId: legacy.value.externalRunId,
      branch: legacy.value.branch,
      headSha: legacy.value.headSha,
    },
    summary: `migrated completed ${input.tool} handoff from legacy durable state`,
    artifactPaths: [
      input.statePath,
      input.handoffReceiptPath,
      legacyPaths.statePath,
      legacyPaths.resultJsonPath,
      legacyPaths.executorLogPath,
      legacyPaths.verificationLogPath,
    ].filter((artifactPath) => fs.existsSync(artifactPath)),
  };
}

function legacyDelegateAttemptPaths(
  input: ProfileBackedDelegateToolInput,
): Array<{
  statePath: string;
  resultJsonPath: string;
  executorLogPath: string;
  verificationLogPath: string;
}> {
  const paths = [];
  for (let attempt = input.attempt; attempt >= 1; attempt -= 1) {
    const runDir =
      attempt === 1
        ? input.legacyPaths.rootDir
        : path.join(input.legacyPaths.rootDir, `attempt-${attempt}`);
    paths.push({
      statePath: path.join(runDir, "delegate-external-state.json"),
      resultJsonPath: path.join(runDir, path.basename(input.resultJsonPath)),
      executorLogPath: path.join(runDir, path.basename(input.executorLogPath)),
      verificationLogPath: path.join(
        runDir,
        path.basename(input.repoSafety.verificationLogPath),
      ),
    });
  }
  return paths;
}

function readLiveWrapperDelegateReceipt(
  input: DelegateReceiptReadInput,
): LiveWrapperDelegateReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readBoundedRegularFile(
        input.handoffReceiptPath,
        "delegated handoff receipt",
      ).toString("utf8"),
    );
  } catch (error) {
    throw new Error(
      `interrupted ${input.tool} handoff receipt is unreadable: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`interrupted ${input.tool} handoff receipt is invalid`);
  }
  const receipt = parsed as Partial<LiveWrapperDelegateReceipt>;
  const paths = [
    receipt.statePath,
    receipt.resultJsonPath,
    receipt.executorLogPath,
    receipt.verificationLogPath,
  ];
  const receiptDir = path.dirname(input.handoffReceiptPath);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.tool !== input.tool ||
    receipt.invocationId !== input.invocationId ||
    !Number.isInteger(receipt.attempt) ||
    receipt.attempt! < 1 ||
    receipt.attempt! > input.attempt ||
    !["launched", "completed", "resetting", "finalizing", "finalized"].includes(
      receipt.phase ?? "",
    ) ||
    typeof receipt.baseHead !== "string" ||
    !/^[0-9a-f]{40}$/.test(receipt.baseHead) ||
    typeof receipt.branch !== "string" ||
    (typeof receipt.preexistingResultDigest !== "string" &&
      receipt.preexistingResultDigest !== null) ||
    paths.some(
      (candidate) =>
        typeof candidate !== "string" || !isPathWithin(receiptDir, candidate),
    )
  ) {
    throw new Error(`interrupted ${input.tool} handoff receipt is invalid`);
  }
  const currentBranch = resolveDelegateBranch(input.repoPath);
  if (receipt.branch !== currentBranch) {
    throw new Error(
      `interrupted ${input.tool} handoff branch mismatch: expected ${receipt.branch}, observed ${currentBranch}`,
    );
  }
  if (
    (receipt.phase === "completed" ||
      receipt.phase === "resetting" ||
      receipt.phase === "finalizing") &&
    (receipt.dispatchOutcome === undefined ||
      typeof receipt.dispatchOutcome !== "object" ||
      receipt.dispatchOutcome === null ||
      typeof receipt.dispatchOutcome.ok !== "boolean")
  ) {
    throw new Error(
      `interrupted ${input.tool} handoff completion receipt is incomplete`,
    );
  }
  if (
    (receipt.phase === "completed" || receipt.phase === "resetting") &&
    (typeof receipt.worktreeTree !== "string" ||
      !/^[0-9a-f]{40}$/.test(receipt.worktreeTree))
  ) {
    throw new Error(
      `interrupted ${input.tool} handoff completion receipt has no worktree proof`,
    );
  }
  if (
    receipt.phase === "resetting" &&
    (typeof receipt.resultDigest !== "string" ||
      typeof receipt.expectedTree !== "string" ||
      !/^[0-9a-f]{40}$/.test(receipt.expectedTree))
  ) {
    throw new Error(
      `interrupted ${input.tool} handoff reset receipt is incomplete`,
    );
  }
  if (
    receipt.phase === "finalizing" &&
    (typeof receipt.resultDigest !== "string" ||
      typeof receipt.expectedTree !== "string" ||
      !/^[0-9a-f]{40}$/.test(receipt.expectedTree) ||
      typeof receipt.expectedMessage !== "string")
  ) {
    throw new Error(
      `interrupted ${input.tool} handoff finalization receipt is incomplete`,
    );
  }
  return receipt as LiveWrapperDelegateReceipt;
}

function readRecoveredLiveWrapperResult(
  receipt: Pick<
    LiveWrapperDelegateReceipt,
    "executorLogPath" | "resultJsonPath"
  >,
): WorkflowStepExecutorDispatchResult {
  let raw: string;
  try {
    raw = readBoundedResultFile(receipt.resultJsonPath).toString("utf8");
  } catch (error) {
    return {
      ok: false,
      code: "result_invalid",
      error: `delegated live-wrapper result is unreadable: ${errorMessage(error)}`,
      executorLogPath: receipt.executorLogPath,
      resultJsonPath: receipt.resultJsonPath,
    };
  }
  const parsed = parseRunnerResult(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "result_invalid",
      error: `delegated live-wrapper result is invalid: ${parsed.error}`,
      executorLogPath: receipt.executorLogPath,
      resultJsonPath: receipt.resultJsonPath,
    };
  }
  return {
    ok: true,
    result: {
      state: parsed.value.success ? "succeeded" : "failed",
      summary: parsed.value.summary,
      checkpoints: [],
      artifacts: [
        { kind: "executor-log", path: receipt.executorLogPath },
        { kind: "runner-result", path: receipt.resultJsonPath },
      ],
      resultDigest: null,
      errorCode: parsed.value.success ? null : "command_failed",
      errorMessage: parsed.value.success
        ? null
        : `live step runner reported success=false: ${parsed.value.summary}`,
      retryHint: null,
      recoveryHint: null,
    },
    executorLogPath: receipt.executorLogPath,
    resultJsonPath: receipt.resultJsonPath,
  };
}

function readRecoveredRunnerResult(resultJsonPath: string) {
  const raw = readBoundedResultFile(resultJsonPath).toString("utf8");
  const parsed = parseRunnerResult(raw);
  if (!parsed.ok) {
    throw new Error(
      `delegated live-wrapper result is invalid: ${parsed.error}`,
    );
  }
  return parsed.value;
}

function captureWorktreeTree(
  repoPath: string,
  baseHead: string,
  artifactRoot: string,
): string {
  const indexPath = path.join(
    artifactRoot,
    `.delegate-index-${process.pid}-${crypto.randomUUID()}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    execFileSync("git", ["-C", repoPath, "read-tree", baseHead], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["-C", repoPath, "add", "-A"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const tree = execFileSync("git", ["-C", repoPath, "write-tree"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) {
      throw new Error(
        `delegated worktree snapshot returned invalid tree ${tree}`,
      );
    }
    const indexTree = execFileSync("git", ["-C", repoPath, "write-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (
      indexTree !== resolveCommitTree(repoPath, baseHead) &&
      indexTree !== tree
    ) {
      throw new Error(
        "delegated repository index differs from the captured worktree; refusing to discard staged-only evidence",
      );
    }
    return tree;
  } finally {
    fs.rmSync(indexPath, { force: true });
    fs.rmSync(`${indexPath}.lock`, { force: true });
  }
}

function resolveCommitTree(repoPath: string, commitSha: string): string {
  const tree = execFileSync(
    "git",
    ["-C", repoPath, "rev-parse", `${commitSha}^{tree}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) {
    throw new Error(`delegated reset returned invalid tree ${tree}`);
  }
  return tree;
}

function isRecoveredDelegateCommit(
  repoPath: string,
  currentHead: string,
  receipt: LiveWrapperDelegateReceipt,
): boolean {
  try {
    const parent = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", `${currentHead}^`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const tree = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", `${currentHead}^{tree}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const message = execFileSync(
      "git",
      ["-C", repoPath, "show", "-s", "--format=%B", currentHead],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trimEnd();
    const status = execFileSync(
      "git",
      ["-C", repoPath, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return (
      parent === receipt.baseHead &&
      tree === receipt.expectedTree &&
      message === receipt.expectedMessage &&
      status.length === 0
    );
  } catch {
    return false;
  }
}

function liveWrapperDelegateExternalState(
  receipt: LiveWrapperDelegateReceipt,
  stepStatus: "completed" | "failed",
  headSha: string,
): DelegateSupervisorExternalState {
  return {
    externalRunId: receipt.invocationId,
    branch: receipt.branch,
    headSha,
    activeStep: null,
    stepStatus,
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "none",
  };
}

function persistRecoveredLiveWrapperHandoff(
  input: ProfileBackedDelegateToolInput,
  receipt: LiveWrapperDelegateReceipt,
  externalState: DelegateSupervisorExternalState,
): DelegateSupervisorHandoff {
  if (
    externalState.externalRunId !== receipt.invocationId ||
    externalState.branch !== receipt.branch ||
    externalState.headSha !== resolveCurrentHead(input.repoPath, "")
  ) {
    throw new Error(
      `interrupted ${receipt.tool} handoff external state does not match the current repository identity`,
    );
  }
  writeJsonAtomically(receipt.statePath, externalState);
  writeJsonAtomically(input.handoffReceiptPath, {
    ...receipt,
    phase: "finalized",
    externalState,
  } satisfies LiveWrapperDelegateReceipt);
  return {
    externalIdentity: {
      externalRunId: externalState.externalRunId,
      branch: externalState.branch,
      headSha: externalState.headSha,
    },
    summary: `recovered completed ${receipt.tool} handoff from durable evidence`,
    artifactPaths: [
      receipt.statePath,
      input.handoffReceiptPath,
      receipt.resultJsonPath,
      receipt.executorLogPath,
      receipt.verificationLogPath,
    ],
  };
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(
    canonicalizePathThroughExistingAncestor(parent),
    canonicalizePathThroughExistingAncestor(candidate),
  );
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function canonicalizePathThroughExistingAncestor(candidate: string): string {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function delegateReceiptPathsMatchConfiguredArtifacts(
  input: DelegateReceiptReadInput,
  receipt: Pick<
    LiveWrapperDelegateReceipt | NoMistakesDelegateReceipt,
    "attempt" | "statePath" | "resultJsonPath" | "executorLogPath"
  >,
): boolean {
  const expectedForAttempt = (configured: string) =>
    receipt.attempt === 1
      ? configured
      : path.join(
          path.dirname(configured),
          `attempt-${receipt.attempt}`,
          path.basename(configured),
        );
  return (
    [
      [receipt.statePath, input.statePath],
      [receipt.resultJsonPath, input.resultJsonPath],
      [receipt.executorLogPath, input.executorLogPath],
    ] as const
  ).every(
    ([actual, configured]) =>
      canonicalizePathThroughExistingAncestor(actual) ===
      canonicalizePathThroughExistingAncestor(expectedForAttempt(configured)),
  );
}

function fileDigest(filePath: string): string | null {
  try {
    const raw = readBoundedResultFile(filePath);
    return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  } catch {
    return null;
  }
}

function resultDigestMatches(
  expectedDigest: string | null | undefined,
  resultJsonPath: string,
): expectedDigest is string {
  return (
    typeof expectedDigest === "string" &&
    fileDigest(resultJsonPath) === expectedDigest
  );
}

function assertNoMistakesResultMatchesReceipt(
  receipt: NoMistakesDelegateReceipt,
): void {
  if (!resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)) {
    throw new Error(
      "stored no-mistakes handoff result does not match its durable finalization receipt",
    );
  }
  const recovered = readRecoveredLiveWrapperResult(receipt);
  if (
    receipt.dispatchOutcome === undefined ||
    receipt.dispatchOutcome.ok !== recovered.ok ||
    (receipt.dispatchOutcome.ok &&
      recovered.ok &&
      (receipt.dispatchOutcome.state !== recovered.result.state ||
        receipt.dispatchOutcome.summary !== recovered.result.summary))
  ) {
    throw new Error(
      "stored no-mistakes handoff wrapper outcome is not safely recoverable",
    );
  }
}

function isDelegateDispatchOutcome(
  value: unknown,
): value is DelegateDispatchOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const outcome = value as Record<string, unknown>;
  return outcome["ok"] === true
    ? (outcome["state"] === "succeeded" || outcome["state"] === "failed") &&
        typeof outcome["summary"] === "string"
    : outcome["ok"] === false &&
        typeof outcome["code"] === "string" &&
        typeof outcome["error"] === "string";
}

function noMistakesTerminalProofOptions(
  repoPath: string,
  handoff: DelegateSupervisorHandoff,
): { terminalProofHeadSha?: string } {
  if (handoff.terminalState !== undefined) {
    return { terminalProofHeadSha: handoff.terminalState.value.headSha };
  }
  const receiptPath = handoff.artifactPaths?.find(
    (artifactPath) => path.basename(artifactPath) === "delegate-handoff.json",
  );
  if (receiptPath === undefined) return {};
  try {
    const stored = JSON.parse(
      readBoundedRegularFile(
        receiptPath,
        "no-mistakes handoff receipt",
      ).toString("utf8"),
    ) as {
      schemaVersion?: unknown;
      phase?: unknown;
      branch?: unknown;
      headSha?: unknown;
      terminalProofHeadSha?: unknown;
      externalIdentity?: {
        externalRunId?: unknown;
        branch?: unknown;
        headSha?: unknown;
      };
    };
    const expected = handoff.externalIdentity;
    const identity = stored.externalIdentity;
    if (
      stored.schemaVersion !== 1 ||
      stored.phase !== "launched" ||
      stored.branch !== expected.branch ||
      typeof stored.headSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(stored.headSha) ||
      stored.headSha !== expected.headSha ||
      typeof stored.terminalProofHeadSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(stored.terminalProofHeadSha) ||
      identity === undefined ||
      identity.externalRunId !== expected.externalRunId ||
      identity.branch !== expected.branch ||
      typeof identity.headSha !== "string" ||
      identity.headSha !== expected.headSha ||
      !isGitDescendant(repoPath, expected.headSha, stored.terminalProofHeadSha)
    ) {
      return {};
    }
    return { terminalProofHeadSha: stored.terminalProofHeadSha };
  } catch {
    return {};
  }
}

function readBoundedResultFile(filePath: string): Buffer {
  return readBoundedRegularFile(filePath, "result");
}

function readBoundedRegularFile(filePath: string, description: string): Buffer {
  assertNoSymlinkPathComponents(filePath, description);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ELOOP"
    ) {
      throw new Error(`${description} is not a bounded regular file`);
    }
    throw error;
  }
  try {
    assertNoSymlinkPathComponents(filePath, description);
    const pathStat = fs.lstatSync(filePath);
    const descriptorStat = fs.fstatSync(descriptor);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !descriptorStat.isFile() ||
      pathStat.dev !== descriptorStat.dev ||
      pathStat.ino !== descriptorStat.ino ||
      descriptorStat.size > LIVE_STEP_WRAPPER_RESULT_MAX_BYTES
    ) {
      throw new Error(`${description} is not a bounded regular file`);
    }
    const raw = Buffer.allocUnsafe(LIVE_STEP_WRAPPER_RESULT_MAX_BYTES + 1);
    let offset = 0;
    while (offset < raw.length) {
      const bytesRead = fs.readSync(
        descriptor,
        raw,
        offset,
        raw.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > LIVE_STEP_WRAPPER_RESULT_MAX_BYTES) {
      throw new Error(`${description} is not a bounded regular file`);
    }
    return raw.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertNoSymlinkPathComponents(
  filePath: string,
  description: string,
): void {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep)) {
    if (component.length === 0) continue;
    current = path.join(current, component);
    if (
      fs.lstatSync(current).isSymbolicLink() &&
      !isPlatformFilesystemAlias(current)
    ) {
      throw new Error(
        `${description} is not a bounded regular file: path contains a symbolic link`,
      );
    }
  }
}

function isPlatformFilesystemAlias(candidate: string): boolean {
  return (
    process.platform === "darwin" &&
    new Set(["/etc", "/tmp", "/var"]).has(candidate)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPersistedProfileDelegateToolAdapter(input: {
  tool: string;
  repoPath: string;
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string | undefined>;
}): DelegateSupervisorToolAdapter {
  if (input.tool === "no-mistakes") {
    return createNoMistakesToolAdapter({
      handoff: () => {
        throw new Error("durable no-mistakes handoff must not be repeated");
      },
      statePath: ({ handoff }) => delegateStatePath(handoff.artifactPaths),
      refreshState: ({ handoff }) =>
        refreshNoMistakesState({
          repoPath: input.repoPath,
          command: input.command,
          argsPrefix: input.argsPrefix,
          env: input.env,
          statePath: delegateStatePath(handoff.artifactPaths),
          expected: handoff.externalIdentity,
          ...noMistakesTerminalProofOptions(input.repoPath, handoff),
        }),
    });
  }
  return {
    name: input.tool,
    handoff: () => {
      throw new Error("durable delegated handoff must not be repeated");
    },
    readExternalState: ({ handoff }) =>
      readRepoBoundPersistedDelegateState(
        input.repoPath,
        handoff.artifactPaths,
        {
          tool: input.tool,
          identity: handoff.externalIdentity,
        },
      ),
  };
}

function createProfileNoMistakesToolAdapter(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorToolAdapter {
  const launchHandoff = async () => {
    const launchingReceipt: NoMistakesDelegateReceipt = {
      schemaVersion: 1,
      invocationId: input.invocationId,
      attempt: input.attempt,
      phase: "launching",
      branch: input.branch,
      headSha: input.headSha,
      statePath: input.statePath,
      resultJsonPath: input.resultJsonPath,
      executorLogPath: input.executorLogPath,
    };
    writeJsonAtomically(input.handoffReceiptPath, launchingReceipt);
    const raw = await input.run();
    const launchIdentity = readNoMistakesLaunchIdentity({
      executorLogPath: launchingReceipt.executorLogPath,
      branch: launchingReceipt.branch,
      headSha: launchingReceipt.headSha,
    });
    if (!launchIdentity.ok) throw new Error(launchIdentity.error);
    const resultDigest = fileDigest(input.resultJsonPath);
    let preparedReceipt: NoMistakesDelegateReceipt = {
      ...launchingReceipt,
      phase: "completed",
      externalIdentity: launchIdentity.value,
      dispatchOutcome: raw.ok
        ? {
            ok: true,
            state: raw.result.state === "succeeded" ? "succeeded" : "failed",
            summary: raw.result.summary,
          }
        : { ok: false, code: raw.code, error: raw.error },
      resultDigest,
      worktreeTree: captureWorktreeTree(
        input.repoPath,
        input.headSha,
        path.dirname(input.handoffReceiptPath),
      ),
    };
    writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
    const finalized = finalizeLiveStepResult(
      raw,
      input.repoPath,
      {
        ...input.repoSafety,
        beforeGitMutation: (mutation) => {
          if (!resultDigestMatches(resultDigest, input.resultJsonPath)) {
            return {
              ok: false,
              error:
                "delegated no-mistakes result no longer matches its completed handoff",
            };
          }
          const ownership = input.repoSafety.beforeGitMutation?.(mutation);
          if (ownership?.ok === false) return ownership;
          if (mutation !== "reset") return { ok: true };
          preparedReceipt = {
            ...preparedReceipt,
            phase: "resetting",
            externalIdentity: launchIdentity.value,
          };
          try {
            writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: `delegated handoff receipt could not be persisted before reset: ${errorMessage(error)}`,
            };
          }
        },
        beforeCommit: (evidence) => {
          if (!resultDigestMatches(resultDigest, input.resultJsonPath)) {
            return {
              ok: false,
              error:
                "delegated no-mistakes result no longer matches its completed handoff",
            };
          }
          const ownership = verifyDelegateCommitOwnership(input);
          if (!ownership.ok) return ownership;
          const prepared = input.repoSafety.beforeCommit?.(evidence);
          if (prepared?.ok === false) return prepared;
          preparedReceipt = {
            ...preparedReceipt,
            phase: "finalizing",
            expectedTree: evidence.expectedTree,
            expectedMessage: evidence.message,
          };
          try {
            writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: `delegated handoff receipt could not be persisted before commit: ${errorMessage(error)}`,
            };
          }
        },
      },
      {
        acceptVerifiedNoChanges: true,
      },
    );
    if (
      !isProvenClean(finalized) ||
      !finalized.ok ||
      finalized.result.state !== "succeeded"
    ) {
      const failureSummary = finalized.ok
        ? (finalized.result.errorMessage ?? finalized.result.summary)
        : finalized.error;
      const failedReceipt: NoMistakesDelegateReceipt = {
        ...preparedReceipt,
        phase: "failed",
        externalIdentity: launchIdentity.value,
        failureSummary,
      };
      writeJsonAtomically(input.handoffReceiptPath, failedReceipt);
      writeJsonAtomically(launchingReceipt.statePath, {
        ...launchIdentity.value,
        activeStep: null,
        stepStatus: "failed",
        findings: [],
        selectedFindingIds: [],
        decisions: [],
        prUrl: null,
        ciState: "failed",
      } satisfies DelegateSupervisorExternalState);
      throw new Error(failureSummary);
    }
    const terminalProofHeadSha = resolveTerminalProofHead(
      input.repoPath,
      launchIdentity.value.headSha,
    );
    const launchedReceipt: NoMistakesDelegateReceipt = {
      ...preparedReceipt,
      phase: "launched",
      externalIdentity: launchIdentity.value,
      terminalProofHeadSha,
    };
    writeJsonAtomically(input.handoffReceiptPath, launchedReceipt);
    writeProvisionalNoMistakesState(
      launchingReceipt.statePath,
      launchIdentity.value,
    );
    const status = readNoMistakesStatus({
      repoPath: input.repoPath,
      command: input.statusCommand,
      argsPrefix: input.statusArgsPrefix,
      env: input.statusEnv,
      expected: launchIdentity.value,
    });
    if (!status.ok) throw new Error(status.error);
    const observed = settleNoMistakesHandoffState(
      status,
      terminalProofHeadSha ?? null,
    );
    writeJsonAtomically(launchingReceipt.statePath, observed.value);
    const artifactPaths = [
      launchingReceipt.statePath,
      input.handoffReceiptPath,
      launchingReceipt.resultJsonPath,
      launchingReceipt.executorLogPath,
      ...finalized.result.artifacts.map((artifact) => artifact.path),
    ].filter((value, index, values) => values.indexOf(value) === index);
    return {
      externalIdentity: launchIdentity.value,
      summary: finalized.result.summary,
      artifactPaths,
      ...(classifyDelegateSupervisorState(observed.value).classification ===
        "complete" &&
      delegateStateHeadMatchesRepo(input.repoPath, observed.value.headSha)
        ? {
            terminalState: {
              value: observed.value,
              digest: observed.digest,
              ...(observed.headRelation !== undefined
                ? { headRelation: observed.headRelation }
                : {}),
            },
          }
        : {}),
    };
  };
  const handoff = async () => {
    const recovered = recoverNoMistakesHandoff(input);
    return recovered ?? launchHandoff();
  };
  const recoverHandoff = async () => {
    const recovered = recoverNoMistakesHandoff(input);
    if (recovered !== null) return recovered;
    if (!fs.existsSync(input.handoffReceiptPath)) {
      throw new Error(
        "interrupted no-mistakes handoff has no durable receipt or launch identity; refusing to launch again",
      );
    }
    return launchHandoff();
  };
  return createNoMistakesToolAdapter({
    handoff,
    recoverHandoff,
    statePath: ({ handoff }) => delegateStatePath(handoff.artifactPaths),
    refreshState: ({ handoff }) =>
      refreshNoMistakesState({
        repoPath: input.repoPath,
        command: input.statusCommand,
        argsPrefix: input.statusArgsPrefix,
        env: input.statusEnv,
        statePath: delegateStatePath(handoff.artifactPaths),
        expected: handoff.externalIdentity,
        ...noMistakesTerminalProofOptions(input.repoPath, handoff),
      }),
  });
}

function recoverNoMistakesHandoff(
  input: ProfileBackedDelegateToolInput,
): DelegateSupervisorHandoff | null {
  migrateLegacyNoMistakesReceipt(input);
  if (!fs.existsSync(input.handoffReceiptPath)) return null;
  let receipt = readNoMistakesHandoffReceipt(input);
  if (receipt.phase === "launching") {
    const launchIdentity = readNoMistakesLaunchIdentity({
      executorLogPath: receipt.executorLogPath,
      branch: receipt.branch,
      headSha: receipt.headSha,
    });
    if (!launchIdentity.ok) {
      throw new Error(
        `durable no-mistakes launch evidence cannot be reconciled: ${launchIdentity.error}`,
      );
    }
    assertNoMistakesLaunchingRecoveryHasUnchangedRepo(
      input.repoPath,
      receipt.headSha,
    );
    throw new Error(
      "interrupted no-mistakes launching receipt has correlated launch evidence but no durable wrapper-finalization proof; inspect the external run before clearing recovery",
    );
  }
  const expected = receipt.externalIdentity!;
  const currentBranch = resolveDelegateBranch(input.repoPath);
  if (expected.branch !== currentBranch) {
    throw new Error(
      `stored no-mistakes handoff does not match current repo branch: expected ${currentBranch}, stored ${expected.branch}`,
    );
  }
  if (receipt.phase === "finalizing") {
    receipt = recoverPreparedNoMistakesCommit(input, receipt);
  }
  if (receipt.phase === "completed") {
    receipt = retryFailedNoMistakesFinalization(input, receipt);
  }
  if (receipt.phase === "resetting") {
    throw new Error(
      "stored no-mistakes handoff was interrupted during failure reset; inspect the repository before clearing recovery",
    );
  }
  if (receipt.phase === "failed") {
    if (receipt.attempt >= input.attempt) {
      throw new Error(
        `stored no-mistakes handoff failed finalization: ${receipt.failureSummary}`,
      );
    }
  }
  const artifactPaths = [
    receipt.statePath,
    input.handoffReceiptPath,
    receipt.resultJsonPath,
    receipt.executorLogPath,
  ];
  const locallyFailed = receipt.phase === "failed";
  const persisted = locallyFailed
    ? null
    : readPersistedDelegateState(artifactPaths);
  if (
    persisted?.ok &&
    persisted.value.externalRunId === expected.externalRunId &&
    persisted.value.branch === expected.branch &&
    classifyDelegateSupervisorState(persisted.value).classification ===
      "complete" &&
    delegateStateHeadMatchesRepo(input.repoPath, persisted.value.headSha) &&
    (persisted.value.headSha === expected.headSha ||
      isGitDescendant(
        input.repoPath,
        expected.headSha,
        persisted.value.headSha,
      ))
  ) {
    return {
      externalIdentity: expected,
      summary: "reattached terminal no-mistakes handoff evidence",
      artifactPaths,
      terminalState: {
        value: persisted.value,
        digest: persisted.digest,
        ...(persisted.value.headSha !== expected.headSha
          ? { headRelation: "verified_descendant" as const }
          : {}),
      },
    };
  }
  const previousState = locallyFailed
    ? undefined
    : readPreviousDelegateState(receipt.statePath);
  const status = readNoMistakesStatus({
    repoPath: input.repoPath,
    command: input.statusCommand,
    argsPrefix: input.statusArgsPrefix,
    env: input.statusEnv,
    expected,
    ...(previousState !== undefined ? { previousState } : {}),
  });
  if (!status.ok) throw new Error(status.error);
  let observed = settleNoMistakesHandoffState(
    status,
    locallyFailed ? null : (receipt.terminalProofHeadSha ?? null),
  );
  if (
    receipt.attempt < input.attempt &&
    (observed.value.stepStatus === "failed" ||
      observed.value.stepStatus === "cancelled")
  ) {
    return null;
  }
  if (locallyFailed) {
    receipt = retryFailedNoMistakesFinalization(input, receipt);
    observed = settleNoMistakesHandoffState(
      status,
      receipt.terminalProofHeadSha ?? null,
    );
  }
  writeJsonAtomically(receipt.statePath, observed.value);
  return recoveredNoMistakesHandoff(
    input.repoPath,
    expected,
    artifactPaths,
    observed,
  );
}

function retryFailedNoMistakesFinalization(
  input: ProfileBackedDelegateToolInput,
  receipt: NoMistakesDelegateReceipt,
): NoMistakesDelegateReceipt {
  let preparedReceipt = receipt;
  assertNoMistakesResultMatchesReceipt(receipt);
  const raw = readRecoveredLiveWrapperResult(receipt);
  const finalized = finalizeLiveStepResult(
    raw,
    input.repoPath,
    {
      ...input.repoSafety,
      beforeGitMutation: (mutation) => {
        if (
          !resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)
        ) {
          return {
            ok: false,
            error:
              "stored no-mistakes handoff result no longer matches its durable finalization receipt",
          };
        }
        const ownership = input.repoSafety.beforeGitMutation?.(mutation);
        if (ownership?.ok === false) return ownership;
        if (mutation !== "reset") return { ok: true };
        preparedReceipt = {
          ...preparedReceipt,
          phase: "resetting",
        };
        try {
          writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: `delegated handoff receipt could not be persisted before reset: ${errorMessage(error)}`,
          };
        }
      },
      beforeCommit: (evidence) => {
        if (
          !resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)
        ) {
          return {
            ok: false,
            error:
              "stored no-mistakes handoff result no longer matches its durable finalization receipt",
          };
        }
        const ownership = verifyDelegateCommitOwnership(input);
        if (!ownership.ok) return ownership;
        const prepared = input.repoSafety.beforeCommit?.(evidence);
        if (prepared?.ok === false) return prepared;
        preparedReceipt = {
          ...preparedReceipt,
          phase: "finalizing",
          expectedTree: evidence.expectedTree,
          expectedMessage: evidence.message,
        };
        try {
          writeJsonAtomically(input.handoffReceiptPath, preparedReceipt);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: `delegated handoff receipt could not be persisted before commit: ${errorMessage(error)}`,
          };
        }
      },
    },
    { acceptVerifiedNoChanges: true },
  );
  if (
    !isProvenClean(finalized) ||
    !finalized.ok ||
    finalized.result.state !== "succeeded"
  ) {
    const failureSummary = finalized.ok
      ? (finalized.result.errorMessage ?? finalized.result.summary)
      : finalized.error;
    const failedReceipt: NoMistakesDelegateReceipt = {
      ...preparedReceipt,
      phase: "failed",
      failureSummary,
    };
    writeJsonAtomically(input.handoffReceiptPath, failedReceipt);
    throw new Error(
      `stored no-mistakes handoff failed finalization: ${failureSummary}`,
    );
  }
  const recovered: NoMistakesDelegateReceipt = {
    ...preparedReceipt,
    phase: "launched",
    terminalProofHeadSha: resolveTerminalProofHead(
      input.repoPath,
      receipt.headSha,
    ),
  };
  writeJsonAtomically(input.handoffReceiptPath, recovered);
  return recovered;
}

function recoveredNoMistakesHandoff(
  repoPath: string,
  expected: DelegateSupervisorExternalIdentity,
  artifactPaths: readonly string[],
  observed: Extract<DelegateSupervisorExternalStateRead, { ok: true }>,
): DelegateSupervisorHandoff {
  const terminal =
    classifyDelegateSupervisorState(observed.value).classification ===
      "complete" &&
    delegateStateHeadMatchesRepo(repoPath, observed.value.headSha);
  return {
    externalIdentity: expected,
    summary: "reattached the correlated no-mistakes run",
    artifactPaths,
    ...(terminal
      ? {
          terminalState: {
            value: observed.value,
            digest: observed.digest,
            ...(observed.headRelation !== undefined
              ? { headRelation: observed.headRelation }
              : {}),
          },
        }
      : {}),
  };
}

function assertNoMistakesLaunchingRecoveryHasUnchangedRepo(
  repoPath: string,
  expectedHead: string,
): void {
  let status: string;
  let head: string;
  try {
    status = execFileSync(
      "git",
      ["-C", repoPath, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `interrupted no-mistakes launching receipt repository state cannot be inspected: ${errorMessage(error)}`,
    );
  }
  if (status.length > 0) {
    throw new Error(
      "interrupted no-mistakes launching receipt has unfinalized worktree changes; inspect the repository before clearing recovery",
    );
  }
  if (head !== expectedHead) {
    throw new Error(
      `interrupted no-mistakes launching receipt has unfinalized HEAD ${head}; expected ${expectedHead}; inspect the repository before clearing recovery`,
    );
  }
}

function readNoMistakesHandoffReceipt(
  input: DelegateReceiptReadInput,
): NoMistakesDelegateReceipt {
  try {
    const stored = JSON.parse(
      readBoundedRegularFile(
        input.handoffReceiptPath,
        "no-mistakes handoff receipt",
      ).toString("utf8"),
    ) as Partial<NoMistakesDelegateReceipt>;
    if (
      (stored.schemaVersion !== undefined && stored.schemaVersion !== 1) ||
      typeof stored.attempt !== "number" ||
      !Number.isInteger(stored.attempt) ||
      stored.attempt < 1 ||
      stored.attempt > input.attempt ||
      stored.invocationId !== input.invocationId
    ) {
      throw new Error("stored handoff identity is incomplete");
    }
    const receiptDir = path.dirname(input.handoffReceiptPath);
    const attemptDir =
      stored.attempt === 1
        ? receiptDir
        : path.join(receiptDir, `attempt-${stored.attempt}`);
    const phase = stored.phase ?? "launched";
    const branch = stored.branch ?? stored.externalIdentity?.branch;
    const headSha = stored.headSha ?? stored.externalIdentity?.headSha;
    const receipt: NoMistakesDelegateReceipt = {
      schemaVersion: 1,
      invocationId: stored.invocationId,
      attempt: stored.attempt,
      phase,
      branch: branch ?? "",
      headSha: headSha ?? "",
      statePath:
        stored.statePath ??
        path.join(attemptDir, path.basename(input.statePath)),
      resultJsonPath:
        stored.resultJsonPath ??
        path.join(attemptDir, path.basename(input.resultJsonPath)),
      executorLogPath:
        stored.executorLogPath ??
        path.join(attemptDir, path.basename(input.executorLogPath)),
      ...(stored.externalIdentity !== undefined
        ? { externalIdentity: stored.externalIdentity }
        : {}),
      ...(stored.dispatchOutcome !== undefined
        ? { dispatchOutcome: stored.dispatchOutcome }
        : {}),
      ...(stored.resultDigest !== undefined
        ? { resultDigest: stored.resultDigest }
        : {}),
      ...(stored.worktreeTree !== undefined
        ? { worktreeTree: stored.worktreeTree }
        : {}),
      ...(stored.expectedTree !== undefined
        ? { expectedTree: stored.expectedTree }
        : {}),
      ...(stored.expectedMessage !== undefined
        ? { expectedMessage: stored.expectedMessage }
        : {}),
      ...(stored.failureSummary !== undefined
        ? { failureSummary: stored.failureSummary }
        : {}),
      ...(stored.terminalProofHeadSha !== undefined
        ? { terminalProofHeadSha: stored.terminalProofHeadSha }
        : {}),
    };
    if (
      ![
        "launching",
        "completed",
        "resetting",
        "finalizing",
        "launched",
        "failed",
      ].includes(receipt.phase) ||
      receipt.branch.length === 0 ||
      !/^[0-9a-f]{40}$/.test(receipt.headSha) ||
      [receipt.statePath, receipt.resultJsonPath, receipt.executorLogPath].some(
        (candidate) =>
          !isPathWithin(receiptDir, candidate) &&
          !isPathWithin(input.legacyPaths.rootDir, candidate),
      ) ||
      (receipt.terminalProofHeadSha !== undefined &&
        !/^[0-9a-f]{40}$/.test(receipt.terminalProofHeadSha)) ||
      (receipt.resultDigest !== undefined &&
        receipt.resultDigest !== null &&
        !/^sha256:[0-9a-f]{64}$/.test(receipt.resultDigest)) ||
      (receipt.worktreeTree !== undefined &&
        !/^[0-9a-f]{40}$/.test(receipt.worktreeTree)) ||
      (receipt.dispatchOutcome !== undefined &&
        !isDelegateDispatchOutcome(receipt.dispatchOutcome))
    ) {
      throw new Error("stored handoff receipt is incomplete");
    }
    if (receipt.phase === "finalizing") {
      if (
        typeof receipt.expectedTree !== "string" ||
        !/^[0-9a-f]{40}$/.test(receipt.expectedTree) ||
        typeof receipt.expectedMessage !== "string" ||
        typeof receipt.resultDigest !== "string"
      ) {
        throw new Error("stored handoff finalization receipt is incomplete");
      }
    }
    if (
      receipt.phase === "failed" &&
      (typeof receipt.failureSummary !== "string" ||
        receipt.failureSummary.trim().length === 0)
    ) {
      throw new Error("stored handoff failure evidence is incomplete");
    }
    if (
      receipt.phase === "completed" ||
      receipt.phase === "finalizing" ||
      receipt.phase === "launched" ||
      receipt.phase === "resetting" ||
      receipt.phase === "failed"
    ) {
      const identity = receipt.externalIdentity;
      if (
        identity === undefined ||
        identity.externalRunId.trim().length === 0 ||
        identity.branch !== receipt.branch ||
        !commitIdentitiesMatch(identity.headSha, receipt.headSha) ||
        (receipt.terminalProofHeadSha !== undefined &&
          !isGitDescendant(
            input.repoPath,
            identity.headSha,
            receipt.terminalProofHeadSha,
          ))
      ) {
        throw new Error("stored handoff identity is incomplete");
      }
    }
    if (
      receipt.phase === "completed" &&
      (typeof receipt.resultDigest !== "string" ||
        typeof receipt.worktreeTree !== "string" ||
        receipt.dispatchOutcome === undefined)
    ) {
      // A pre-correlation receipt cannot prove whether a success-shaped result
      // came from a failed wrapper process. Deriving this field would recreate
      // the failure-to-success recovery gap, so legacy evidence fails closed.
      throw new Error("stored handoff completion receipt is incomplete");
    }
    if (
      (receipt.phase === "finalizing" ||
        receipt.phase === "resetting" ||
        (receipt.phase === "failed" &&
          typeof receipt.resultDigest === "string")) &&
      receipt.dispatchOutcome === undefined
    ) {
      throw new Error("stored handoff wrapper outcome is incomplete");
    }
    return receipt;
  } catch (error) {
    throw new Error(
      `stored no-mistakes handoff is unreadable: ${errorMessage(error)}`,
    );
  }
}

function recoverPreparedNoMistakesCommit(
  input: ProfileBackedDelegateToolInput,
  receipt: NoMistakesDelegateReceipt,
): NoMistakesDelegateReceipt {
  assertNoMistakesResultMatchesReceipt(receipt);
  const currentHead = resolveCurrentHead(input.repoPath, "");
  let terminalProofHeadSha: string;
  if (currentHead !== receipt.headSha) {
    if (!isRecoveredNoMistakesCommit(input.repoPath, currentHead, receipt)) {
      throw new Error(
        "interrupted no-mistakes handoff repository state does not match its durable finalization receipt",
      );
    }
    terminalProofHeadSha = currentHead;
  } else {
    assertNoMistakesResultMatchesReceipt(receipt);
    const ownership = verifyDelegateCommitOwnership(input);
    if (!ownership.ok) throw new Error(ownership.error);
    const runnerResult = readRecoveredRunnerResult(receipt.resultJsonPath);
    const commit = commitVerifiedChanges({
      repoPath: input.repoPath,
      baseHead: receipt.headSha,
      commit: runnerResult.commit,
      beforeCommit: (evidence) => {
        if (
          !resultDigestMatches(receipt.resultDigest, receipt.resultJsonPath)
        ) {
          return {
            ok: false,
            error:
              "delegated prepared commit result no longer matches its durable finalization receipt",
          };
        }
        const ownership = verifyDelegateCommitOwnership(input);
        if (!ownership.ok) return ownership;
        return evidence.expectedTree === receipt.expectedTree &&
          evidence.message === receipt.expectedMessage
          ? { ok: true }
          : {
              ok: false,
              error:
                "delegated prepared commit no longer matches its durable finalization receipt",
            };
      },
    });
    if (!commit.ok) throw new Error(commit.error);
    terminalProofHeadSha = commit.commitSha;
  }
  terminalProofHeadSha = resolveTerminalProofHead(
    input.repoPath,
    receipt.headSha,
  );
  const recovered = {
    ...receipt,
    phase: "launched" as const,
    terminalProofHeadSha,
  };
  writeJsonAtomically(input.handoffReceiptPath, recovered);
  return recovered;
}

function isRecoveredNoMistakesCommit(
  repoPath: string,
  currentHead: string,
  receipt: NoMistakesDelegateReceipt,
): boolean {
  if (
    receipt.expectedTree === undefined ||
    receipt.expectedMessage === undefined
  ) {
    return false;
  }
  try {
    const parent = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", `${currentHead}^`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const tree = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", `${currentHead}^{tree}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const message = execFileSync(
      "git",
      ["-C", repoPath, "show", "-s", "--format=%B", currentHead],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trimEnd();
    const status = execFileSync(
      "git",
      ["-C", repoPath, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return (
      parent === receipt.headSha &&
      tree === receipt.expectedTree &&
      message === receipt.expectedMessage &&
      status.length === 0
    );
  } catch {
    return false;
  }
}

function migrateLegacyNoMistakesReceipt(
  input: ProfileBackedDelegateToolInput,
): void {
  if (
    fs.existsSync(input.handoffReceiptPath) ||
    !fs.existsSync(input.legacyPaths.handoffReceiptPath)
  ) {
    return;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(
      readBoundedRegularFile(
        input.legacyPaths.handoffReceiptPath,
        "legacy no-mistakes handoff receipt",
      ).toString("utf8"),
    );
  } catch {
    return;
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return;
  }
  const receipt = stored as {
    invocationId?: unknown;
    attempt?: unknown;
    externalIdentity?: {
      externalRunId?: unknown;
      branch?: unknown;
      headSha?: unknown;
    };
    terminalProofHeadSha?: unknown;
    handoffSucceeded?: unknown;
  };
  const identity = receipt.externalIdentity;
  if (
    typeof receipt.attempt !== "number" ||
    !Number.isInteger(receipt.attempt) ||
    receipt.attempt < 1 ||
    receipt.attempt > input.attempt ||
    receipt.invocationId !== input.invocationId ||
    identity === undefined ||
    typeof identity.externalRunId !== "string" ||
    typeof identity.branch !== "string" ||
    typeof identity.headSha !== "string" ||
    (receipt.terminalProofHeadSha !== undefined &&
      typeof receipt.terminalProofHeadSha !== "string") ||
    (receipt.handoffSucceeded !== undefined &&
      typeof receipt.handoffSucceeded !== "boolean")
  ) {
    return;
  }
  if (receipt.handoffSucceeded !== true) return;
  const legacyRunDir =
    receipt.attempt === 1
      ? input.legacyPaths.rootDir
      : path.join(input.legacyPaths.rootDir, `attempt-${receipt.attempt}`);
  writeJsonAtomically(input.handoffReceiptPath, {
    schemaVersion: 1,
    invocationId: receipt.invocationId,
    attempt: receipt.attempt,
    phase: "launched",
    branch: identity.branch,
    headSha: identity.headSha,
    statePath: path.join(legacyRunDir, path.basename(input.statePath)),
    resultJsonPath: path.join(
      legacyRunDir,
      path.basename(input.resultJsonPath),
    ),
    executorLogPath: path.join(
      legacyRunDir,
      path.basename(input.executorLogPath),
    ),
    externalIdentity: {
      externalRunId: identity.externalRunId,
      branch: identity.branch,
      headSha: identity.headSha,
    },
    ...(typeof receipt.terminalProofHeadSha === "string"
      ? { terminalProofHeadSha: receipt.terminalProofHeadSha }
      : receipt.handoffSucceeded === true
        ? { terminalProofHeadSha: identity.headSha }
        : {}),
  } satisfies NoMistakesDelegateReceipt);
}

function readNoMistakesLaunchIdentity(input: {
  executorLogPath: string;
  branch: string;
  headSha: string;
}): ReturnType<typeof parseNoMistakesLaunchIdentity> {
  try {
    const raw = readBoundedRegularFile(
      input.executorLogPath,
      "no-mistakes launch evidence",
    ).toString("utf8");
    return parseNoMistakesLaunchIdentity(raw, {
      branch: input.branch,
      headSha: input.headSha,
    });
  } catch (error) {
    return {
      ok: false,
      error: `no-mistakes launch evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function writeProvisionalNoMistakesState(
  statePath: string,
  identity: {
    externalRunId: string;
    branch: string;
    headSha: string;
  },
): void {
  const state: DelegateSupervisorExternalState = {
    ...identity,
    activeStep: null,
    stepStatus: "running",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "pending",
  };
  writeJsonAtomically(statePath, state);
}

type AtomicJsonWriteDeps = Pick<
  typeof fs,
  | "closeSync"
  | "fsyncSync"
  | "openSync"
  | "renameSync"
  | "rmSync"
  | "writeFileSync"
>;

export function writeJsonAtomically(
  filePath: string,
  value: unknown,
  injected: Partial<AtomicJsonWriteDeps> = {},
): void {
  const deps: AtomicJsonWriteDeps = { ...fs, ...injected };
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = deps.openSync(temporaryPath, "wx", 0o600);
    deps.writeFileSync(descriptor, JSON.stringify(value), {
      encoding: "utf8",
    });
    deps.fsyncSync(descriptor);
    deps.closeSync(descriptor);
    descriptor = undefined;
    deps.renameSync(temporaryPath, filePath);
    syncDirectory(path.dirname(filePath), deps);
  } finally {
    if (descriptor !== undefined) deps.closeSync(descriptor);
    deps.rmSync(temporaryPath, { force: true });
  }
}

function syncDirectory(directoryPath: string, deps: AtomicJsonWriteDeps): void {
  let descriptor: number | undefined;
  try {
    descriptor = deps.openSync(directoryPath, fs.constants.O_RDONLY);
    deps.fsyncSync(descriptor);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (
      !new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(
        String(code),
      )
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) deps.closeSync(descriptor);
  }
}

function refreshNoMistakesState(input: {
  repoPath: string;
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string | undefined>;
  statePath: string;
  expected: {
    externalRunId: string;
    branch: string;
    headSha: string;
  };
  terminalProofHeadSha?: string;
}): ReturnType<typeof parseNoMistakesAxiStatus> {
  const previousState = readPreviousDelegateState(input.statePath);
  const status = readNoMistakesStatus({
    ...input,
    ...(previousState !== undefined ? { previousState } : {}),
  });
  if (!status.ok) throw new Error(status.error);
  if (
    input.terminalProofHeadSha !== undefined &&
    !/^[0-9a-f]{40}$/.test(input.terminalProofHeadSha)
  ) {
    throw new Error(
      `no-mistakes terminal proof head ${input.terminalProofHeadSha} is not a canonical full commit SHA`,
    );
  }
  const currentTerminalProof =
    input.terminalProofHeadSha !== undefined &&
    delegateStateHeadMatchesRepo(input.repoPath, input.terminalProofHeadSha)
      ? input.terminalProofHeadSha
      : null;
  const observed = settleNoMistakesHandoffState(status, currentTerminalProof);
  writeJsonAtomically(input.statePath, observed.value);
  return observed;
}

function readNoMistakesStatus(input: {
  repoPath: string;
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string | undefined>;
  expected: {
    externalRunId: string;
    branch: string;
    headSha: string;
  };
  previousState?: DelegateSupervisorExternalState;
}): ReturnType<typeof parseNoMistakesAxiStatus> {
  try {
    const raw = execFileSync(
      input.command,
      [
        ...input.argsPrefix,
        "axi",
        "status",
        "--run",
        input.expected.externalRunId,
      ],
      {
        cwd: input.repoPath,
        env: input.env as NodeJS.ProcessEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = parseNoMistakesAxiStatus(raw, input.expected, {
      resolveHeadSha: (abbreviatedHead) =>
        resolveGitCommit(input.repoPath, abbreviatedHead),
      isHeadDescendant: (launchHead, observedHead) =>
        isGitDescendant(input.repoPath, launchHead, observedHead),
      ...(input.previousState !== undefined
        ? { previousState: input.previousState }
        : {}),
    });
    if (
      parsed.ok &&
      classifyDelegateSupervisorState(parsed.value).classification ===
        "complete" &&
      !delegateStateHeadMatchesRepo(input.repoPath, parsed.value.headSha)
    ) {
      return {
        ok: false,
        error: `no-mistakes terminal state head ${parsed.value.headSha} does not match the current repository head`,
      };
    }
    return parsed;
  } catch (error) {
    return {
      ok: false,
      error: `no-mistakes axi status failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function delegateStateHeadMatchesRepo(
  repoPath: string,
  observedHead: string,
): boolean {
  const currentHead = resolveCurrentHead(repoPath, "");
  if (currentHead.length === 0) return false;
  const resolvedObserved =
    observedHead.length === 40
      ? observedHead.toLowerCase()
      : resolveGitCommit(repoPath, observedHead);
  return resolvedObserved === currentHead;
}

function isGitDescendant(
  repoPath: string,
  launchHead: string,
  observedHead: string,
): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "merge-base", "--is-ancestor", launchHead, observedHead],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

function readPreviousDelegateState(
  statePath: string,
): DelegateSupervisorExternalState | undefined {
  try {
    return JSON.parse(
      readBoundedRegularFile(statePath, "delegated external state").toString(
        "utf8",
      ),
    ) as DelegateSupervisorExternalState;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(
      `previous delegated external state is unreadable: ${errorMessage(error)}`,
    );
  }
}

function resolveTerminalProofHead(
  repoPath: string,
  launchHead: string,
): string {
  const currentHead = resolveCurrentHead(repoPath, "");
  if (
    !/^[0-9a-f]{40}$/.test(currentHead) ||
    (currentHead !== launchHead &&
      !isGitDescendant(repoPath, launchHead, currentHead))
  ) {
    throw new Error(
      "successful no-mistakes finalization did not produce a repository head descended from its launch identity",
    );
  }
  return currentHead;
}

function resolveGitCommit(
  repoPath: string,
  abbreviatedHead: string,
): string | null {
  try {
    const resolved = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--verify", `${abbreviatedHead}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return /^[0-9a-f]{40}$/i.test(resolved) ? resolved.toLowerCase() : null;
  } catch {
    return null;
  }
}

function delegateStatePath(
  artifactPaths: readonly string[] | undefined,
): string {
  const statePath = artifactPaths?.find((candidate) =>
    candidate.endsWith("delegate-external-state.json"),
  );
  if (statePath === undefined) {
    throw new Error("delegated handoff has no external-state artifact pointer");
  }
  return statePath;
}

function resolveCurrentHead(repoPath: string, fallback: string): string {
  try {
    const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : fallback;
  } catch {
    return fallback;
  }
}

function readPersistedDelegateState(
  artifactPaths: readonly string[] | undefined,
):
  | { ok: true; value: DelegateSupervisorExternalState; digest: string }
  | { ok: false; error: string } {
  const statePath = artifactPaths?.find((candidate) =>
    candidate.endsWith("delegate-external-state.json"),
  );
  if (statePath === undefined) {
    return {
      ok: false,
      error: "delegated handoff has no external-state artifact pointer",
    };
  }
  try {
    const raw = readBoundedRegularFile(statePath, "delegated external state");
    return {
      ok: true,
      value: JSON.parse(
        raw.toString("utf8"),
      ) as DelegateSupervisorExternalState,
      digest: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `delegated external-state artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readRepoBoundPersistedDelegateState(
  repoPath: string,
  artifactPaths: readonly string[] | undefined,
  expected: {
    tool: string;
    identity: DelegateSupervisorExternalIdentity;
  },
): ReturnType<typeof readPersistedDelegateState> {
  const finalizedReceiptState = readFinalizedGenericDelegateState(
    artifactPaths,
    expected,
  );
  const read =
    finalizedReceiptState ?? readPersistedDelegateState(artifactPaths);
  if (!read.ok || delegateStateHeadMatchesRepo(repoPath, read.value.headSha)) {
    return read;
  }
  return {
    ok: false,
    error: `delegated external state head ${read.value.headSha} does not match the current repository head`,
  };
}

function readFinalizedGenericDelegateState(
  artifactPaths: readonly string[] | undefined,
  expected: {
    tool: string;
    identity: DelegateSupervisorExternalIdentity;
  },
): ReturnType<typeof readPersistedDelegateState> | null {
  const receiptPath = artifactPaths?.find(
    (candidate) => path.basename(candidate) === "delegate-handoff.json",
  );
  if (receiptPath === undefined) return null;
  try {
    const stored = JSON.parse(
      readBoundedRegularFile(receiptPath, "delegated handoff receipt").toString(
        "utf8",
      ),
    ) as {
      schemaVersion?: unknown;
      tool?: unknown;
      phase?: unknown;
      externalState?: unknown;
    };
    if (
      stored.schemaVersion !== 1 ||
      stored.tool !== expected.tool ||
      stored.phase !== "finalized"
    ) {
      return {
        ok: false,
        error: "delegated handoff receipt is not a valid finalized receipt",
      };
    }
    if (
      stored.externalState === null ||
      typeof stored.externalState !== "object" ||
      Array.isArray(stored.externalState)
    ) {
      return {
        ok: false,
        error:
          "finalized delegated handoff receipt has no authoritative external state",
      };
    }
    const value = stored.externalState as DelegateSupervisorExternalState;
    if (
      value.externalRunId !== expected.identity.externalRunId ||
      value.branch !== expected.identity.branch ||
      value.headSha !== expected.identity.headSha
    ) {
      return {
        ok: false,
        error:
          "finalized delegated handoff receipt does not match its durable external identity",
      };
    }
    const raw = Buffer.from(JSON.stringify(value));
    return {
      ok: true,
      value,
      digest: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `delegated handoff receipt is unreadable: ${errorMessage(error)}`,
    };
  }
}
