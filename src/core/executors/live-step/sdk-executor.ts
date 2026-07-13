import type { FinalizeWorkflowStepFromResultFileResult } from "../shared/step-finalize.js";
import { finalizeWorkflowStepFromResultFile } from "../shared/step-finalize.js";
import type {
  Executor,
  ExecutorConfigSchema,
  ExecutorTickContext,
  ExecutorTickResult,
} from "../sdk/types.js";
import { DELEGATE_SUPERVISOR_CONFIG_SCHEMA } from "../delegate-supervisor/executor.js";
import type {
  WorkflowStepExecutorDispatchResult,
  WorkflowStepExecutorErrorCode,
} from "../../workflow/step/executor.js";

export type LiveStepRepoSafetyHostBinding = {
  baseHead: string;
  verificationCommands: readonly string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

export type LiveStepSdkHostBindings = {
  repoPath: string;
  repoSafety?: LiveStepRepoSafetyHostBinding;
  run: () =>
    | WorkflowStepExecutorDispatchResult
    | Promise<WorkflowStepExecutorDispatchResult>;
  settleRepoOwnership?: (provenClean: boolean) => void;
};

type DurableLiveStepDecision = Pick<
  ExecutorTickResult,
  | "recommendation"
  | "recommendedRoundState"
  | "recommendedInvocationState"
  | "recoveryCode"
  | "humanGate"
  | "reason"
>;

const MECHANISM_COMPLETED = "mechanism_completed";

/**
 * Registered SDK executor for the existing configured live-step mechanism.
 * The bounded process and repo finalization finish before an atomic durable
 * observation + mechanism checkpoint. A daemon restart after that checkpoint
 * classifies from durable evidence and never invokes the mechanism again.
 */
export class LiveStepSdkExecutor implements Executor<
  Record<string, unknown>,
  LiveStepSdkHostBindings
> {
  readonly name: string;
  readonly configSchema: ExecutorConfigSchema;

  constructor(name: string, configSchema: ExecutorConfigSchema) {
    this.name = name;
    this.configSchema = configSchema;
  }

  async tick(
    context: ExecutorTickContext<
      Record<string, unknown>,
      LiveStepSdkHostBindings
    >,
  ): Promise<ExecutorTickResult> {
    const invocation = context.state.invocation;
    const existing =
      [...context.state.rounds]
        .reverse()
        .find((snapshot) => snapshot.round.attempt === invocation.attempt) ??
      null;
    if (existing !== null) {
      const completed = [...existing.checkpoints]
        .reverse()
        .find((checkpoint) => checkpoint.stage === MECHANISM_COMPLETED);
      if (completed?.detail === null || completed === undefined) {
        context.hostBindings.settleRepoOwnership?.(false);
        throw new Error(
          `Live-step round ${existing.round.roundId} has no durable mechanism_completed outcome to classify.`,
        );
      }
      const decision = parseDurableDecision(completed.detail);
      context.hostBindings.settleRepoOwnership?.(
        decision.recommendation === "complete" ||
          decision.recommendation === "failed",
      );
      return {
        roundId: existing.round.roundId,
        ...decision,
      };
    }

    const roundId = `${invocation.invocationId}::round-${context.state.rounds.length + 1}`;
    context.envelope.startRound({
      roundId,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: invocation.attempt,
      roundIndex: context.state.rounds.length,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    context.envelope.recordCheckpoint(roundId, {
      checkpointId: `${roundId}-checkpoint-0`,
      sequence: 0,
      stage: "round_started",
      detail: null,
    });
    context.signal.throwIfAborted();

    let finalized: WorkflowStepExecutorDispatchResult | undefined;
    let provenClean = false;
    let completionDurable = false;
    try {
      const raw = await context.hostBindings.run();
      finalized = finalizeLiveStepResult(
        raw,
        context.hostBindings.repoPath,
        context.hostBindings.repoSafety,
      );
      provenClean = isProvenClean(finalized);
      const decision = decisionForResult(finalized);
      const logPaths = evidencePaths(finalized);
      for (const [index, evidencePath] of logPaths.entries()) {
        context.envelope.recordArtifact(roundId, {
          artifactId: `${roundId}-evidence-${index}`,
          artifactClass: artifactClassForPath(evidencePath),
          path: evidencePath,
          digest: null,
          description: null,
        });
      }
      context.envelope.recordRoundProgress(roundId, {
        observation: {
          ...(finalized.ok ? { phase: "capturing_result" as const } : {}),
          summary: finalized.ok ? finalized.result.summary : finalized.error,
          logPaths,
          resultDigest: finalized.ok ? finalized.result.resultDigest : null,
        },
        checkpoints: [
          {
            checkpointId: `${roundId}-checkpoint-1`,
            sequence: 1,
            stage: MECHANISM_COMPLETED,
            detail: JSON.stringify(decision),
          },
        ],
      });
      completionDurable = true;
      return { roundId, ...decision };
    } finally {
      context.hostBindings.settleRepoOwnership?.(
        provenClean && completionDurable,
      );
    }
  }
}

const EMPTY_CONFIG_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

/** Current built-in schemas used by the profile-backed compatibility bridge. */
export function liveStepBuiltInConfigSchema(
  name: string,
): ExecutorConfigSchema {
  return name === "delegate-supervisor"
    ? DELEGATE_SUPERVISOR_CONFIG_SCHEMA
    : EMPTY_CONFIG_SCHEMA;
}

function decisionForResult(
  result: WorkflowStepExecutorDispatchResult,
): DurableLiveStepDecision {
  if (!result.ok) {
    const precise = (result as { liveRecoveryCode?: unknown }).liveRecoveryCode;
    return {
      recommendation: "manual_recovery_required",
      recommendedRoundState: "manual_recovery_required",
      recommendedInvocationState: "manual_recovery_required",
      recoveryCode:
        typeof precise === "string" && precise.length > 0
          ? precise
          : result.code,
      humanGate: "manual_recovery_required",
      reason: result.error,
    };
  }
  if (result.result.state === "succeeded") {
    return {
      recommendation: "complete",
      recommendedRoundState: "succeeded",
      recommendedInvocationState: "succeeded",
      recoveryCode: null,
      humanGate: null,
      reason: result.result.summary,
    };
  }
  if (result.result.state === "failed") {
    return {
      recommendation: "failed",
      recommendedRoundState: "failed",
      recommendedInvocationState: "failed",
      recoveryCode: result.result.errorCode ?? "command_failed",
      humanGate: null,
      reason: result.result.errorMessage ?? result.result.summary,
    };
  }
  return {
    recommendation: "manual_recovery_required",
    recommendedRoundState: "manual_recovery_required",
    recommendedInvocationState: "manual_recovery_required",
    recoveryCode: "unexpected_skipped_terminal",
    humanGate: "manual_recovery_required",
    reason: "A dispatched executor unexpectedly returned skipped.",
  };
}

function parseDurableDecision(detail: string): DurableLiveStepDecision {
  const parsed = JSON.parse(detail) as DurableLiveStepDecision;
  return parsed;
}

export function finalizeLiveStepResult(
  result: WorkflowStepExecutorDispatchResult,
  repoPath: string,
  safety: LiveStepRepoSafetyHostBinding | undefined,
): WorkflowStepExecutorDispatchResult {
  if (!result.ok || safety === undefined || result.result.state === "skipped") {
    return result;
  }
  const ownership = safety.beforeGitMutation?.();
  const finalize: FinalizeWorkflowStepFromResultFileResult =
    ownership?.ok === false
      ? { outcome: "repo_lock_lost", error: ownership.error }
      : finalizeWorkflowStepFromResultFile({
          repoPath,
          baseHead: safety.baseHead,
          resultFilePath: result.resultJsonPath,
          verificationCommands: [...safety.verificationCommands],
          verificationTimeoutSec: safety.verificationTimeoutSec,
          verificationLogPath: safety.verificationLogPath,
          ...(safety.beforeGitMutation !== undefined
            ? { beforeGitMutation: safety.beforeGitMutation }
            : {}),
        });
  switch (finalize.outcome) {
    case "committed":
      return withVerificationArtifact(result, safety.verificationLogPath);
    case "reset_step_failure":
      return withFinalizedFailure(
        result,
        result.result.errorCode ?? "command_failed",
        result.result.errorMessage ??
          "workflow step reported failure and its worktree changes were reset",
        safety.verificationLogPath,
      );
    case "reset_verification_failure":
      return withFinalizedFailure(
        result,
        "command_failed",
        finalize.verification.error,
        safety.verificationLogPath,
      );
    case "commit_failed":
      if (
        finalize.commit.code === "nothing_to_commit" ||
        (finalize.reset !== undefined && finalize.reset.ok)
      ) {
        return withFinalizedFailure(
          result,
          "command_failed",
          finalize.commit.error,
          safety.verificationLogPath,
        );
      }
      return manualRecoveryResult(
        result,
        finalize.reset !== undefined && !finalize.reset.ok
          ? "reset_failed"
          : "commit_failed",
        finalize.reset !== undefined && !finalize.reset.ok
          ? finalize.reset.error
          : finalize.commit.error,
      );
    default:
      return manualRecoveryResult(
        result,
        recoveryCodeForFinalize(finalize),
        describeFinalizeFailure(finalize),
      );
  }
}

function withVerificationArtifact(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  verificationLogPath: string,
): WorkflowStepExecutorDispatchResult {
  return {
    ...result,
    result: {
      ...result.result,
      artifacts: [
        ...result.result.artifacts,
        { kind: "verification-log", path: verificationLogPath },
      ],
    },
  };
}

function withFinalizedFailure(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  errorCode: WorkflowStepExecutorErrorCode,
  errorMessage: string,
  verificationLogPath: string,
): WorkflowStepExecutorDispatchResult {
  return {
    ...result,
    result: {
      ...result.result,
      state: "failed",
      artifacts: [
        ...result.result.artifacts,
        { kind: "verification-log", path: verificationLogPath },
      ],
      errorCode,
      errorMessage,
      recoveryHint: null,
    },
  };
}

function manualRecoveryResult(
  result: Extract<WorkflowStepExecutorDispatchResult, { ok: true }>,
  recoveryCode: string,
  error: string,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: false,
    code: "manual_recovery_required",
    error,
    executorLogPath: result.executorLogPath,
    resultJsonPath: result.resultJsonPath,
    liveRecoveryCode: recoveryCode,
  } as WorkflowStepExecutorDispatchResult;
}

function recoveryCodeForFinalize(
  result: FinalizeWorkflowStepFromResultFileResult,
): string {
  switch (result.outcome) {
    case "manual_recovery_required":
      return result.recoveryCode;
    case "reset_failed":
      return "reset_failed";
    case "result_invalid":
      return "result_invalid";
    case "result_missing":
      return "result_missing";
    case "git_failed":
      return "git_failed";
    case "repo_lock_lost":
      return "repo_lock_lost";
    default:
      return "invalid_input";
  }
}

function describeFinalizeFailure(
  result: FinalizeWorkflowStepFromResultFileResult,
): string {
  switch (result.outcome) {
    case "manual_recovery_required":
      return result.reason;
    case "reset_failed":
      return result.reset.error;
    case "result_invalid":
    case "result_missing":
    case "git_failed":
    case "repo_lock_lost":
    case "invalid_input":
      return result.error;
    case "commit_failed":
      return result.commit.error;
    case "reset_verification_failure":
      return result.verification.error;
    case "reset_step_failure":
      return "workflow step reported failure and its worktree changes were reset";
    case "committed":
      return "workflow step committed";
  }
}

function evidencePaths(result: WorkflowStepExecutorDispatchResult): string[] {
  if (result.ok) {
    return result.result.artifacts.map((artifact) => artifact.path);
  }
  return [result.executorLogPath, result.resultJsonPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function artifactClassForPath(
  evidencePath: string,
): "result_document" | "logs" | "verification_output" {
  if (evidencePath.endsWith("verification.log")) return "verification_output";
  if (evidencePath.endsWith(".log")) return "logs";
  return "result_document";
}

export function isProvenClean(
  result: WorkflowStepExecutorDispatchResult,
): boolean {
  return (
    result.ok &&
    (result.result.state === "succeeded" || result.result.state === "failed")
  );
}
