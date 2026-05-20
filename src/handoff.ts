import fs from "node:fs";

import type { GoalArtifactPaths } from "./artifacts.js";
import type { DataDirOptions } from "./data-dir.js";
import type { RunnerProfile } from "./runner-profile.js";
import {
  loadGoalStatus,
  type GoalStatusArtifactFiles,
  type GoalStatusCurrentIterationDetail,
  type GoalStatusDaemonSummary,
  type GoalStatusError,
  type GoalStatusEvidenceSummary,
  type GoalStatusExternalApply,
  type GoalStatusIterationSummary,
  type GoalStatusJobSummary,
  type GoalStatusNextActionDetail,
  type GoalStatusPendingIntentExternalApply,
  type GoalStatusPendingIntentSummary,
  type GoalStatusPolicySummary,
  type GoalStatusReducerSummary,
  type GoalStatusStaleRecoverySummary,
  type GoalStatusSuccess
} from "./goal-status.js";
import type { IntentApplyAudit } from "./intent-apply-audits.js";
import type { SourceItemSummary } from "./source-items.js";

export const HANDOFF_SCHEMA_VERSION = 1;

export type WriteHandoffInput = {
  goalId?: string;
  dataDirOptions?: DataDirOptions;
  now?: () => number;
};

export type HandoffErrorCode =
  | GoalStatusError["code"]
  | "handoff_write_failed";

export type HandoffError = {
  ok: false;
  code: HandoffErrorCode;
  error: string;
};

export type HandoffRunnerResultSummary = {
  success: boolean | null;
  summary: string | null;
  keyChangesMade: string[];
  keyLearnings: string[];
  remainingWork: string[];
  goalComplete: boolean | null;
};

export type HandoffGoalSummary = {
  id: string;
  title: string;
  state: string;
  repo: string | null;
  branch: string;
  runner: string;
  runnerProfile: RunnerProfile | null;
  maxIterations: number;
  currentIteration: number;
  completionReason: string | null;
  verification: string[];
  verificationTimeoutSec: number;
  artifactDir: string;
  dataDir: string;
  createdAt: number;
  updatedAt: number;
};

export type HandoffData = {
  schemaVersion: number;
  generatedAt: number;
  goal: HandoffGoalSummary;
  goalState: string;
  latestJob: GoalStatusJobSummary | null;
  iteration: GoalStatusIterationSummary | null;
  currentIterationDetail: GoalStatusCurrentIterationDetail | null;
  runnerResult: HandoffRunnerResultSummary | null;
  runnerResultError: string | null;
  reducer: GoalStatusReducerSummary | null;
  nextJob: GoalStatusJobSummary | null;
  nextAction: string | null;
  nextActionDetail: GoalStatusNextActionDetail | null;
  latestCommitSha: string | null;
  daemon: GoalStatusDaemonSummary | null;
  staleRecovery: GoalStatusStaleRecoverySummary;
  policy: GoalStatusPolicySummary;
  sourceItems: SourceItemSummary[];
  latestEvidence: GoalStatusEvidenceSummary[];
  pendingUpdateIntents: GoalStatusPendingIntentSummary[];
  totalPendingUpdateIntentCount: number;
  truncatedPendingUpdateIntents: boolean;
  intentStaleThresholdMs: number;
  externalApply: GoalStatusExternalApply;
  artifactPaths: GoalArtifactPaths;
  artifactFiles: GoalStatusArtifactFiles;
};

export type HandoffSuccess = {
  ok: true;
  data: HandoffData;
  handoffMdPath: string;
  handoffJsonPath: string;
};

export type HandoffResult = HandoffError | HandoffSuccess;

export function writeHandoff(input: WriteHandoffInput = {}): HandoffResult {
  const statusInput: {
    goalId?: string;
    dataDirOptions?: DataDirOptions;
  } = {};
  if (input.goalId !== undefined) statusInput.goalId = input.goalId;
  if (input.dataDirOptions !== undefined) {
    statusInput.dataDirOptions = input.dataDirOptions;
  }

  const status = loadGoalStatus(statusInput);
  if (!status.ok) {
    return { ok: false, code: status.code, error: status.error };
  }

  const now = input.now ?? (() => Date.now());
  const runnerResult = readRunnerResult(
    status.latestJob?.resultPath ?? status.artifactPaths.resultJson
  );
  const data = buildHandoffData(status, runnerResult, now());

  const jsonBody = `${JSON.stringify(toJsonShape(data), null, 2)}\n`;
  const markdownBody = renderHandoffMarkdown(data);

  try {
    fs.writeFileSync(status.artifactPaths.handoffJson, jsonBody, "utf-8");
    fs.writeFileSync(status.artifactPaths.handoffMd, markdownBody, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "handoff_write_failed",
      error: `failed to write handoff artifacts: ${detail}`
    };
  }

  return {
    ok: true,
    data,
    handoffMdPath: status.artifactPaths.handoffMd,
    handoffJsonPath: status.artifactPaths.handoffJson
  };
}

function buildHandoffData(
  status: GoalStatusSuccess,
  runnerResult: RunnerResultRead,
  generatedAt: number
): HandoffData {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    generatedAt,
    goal: {
      id: status.goalId,
      title: status.title,
      state: status.state,
      repo: status.repo,
      branch: status.branch,
      runner: status.runner,
      runnerProfile: status.runnerProfile,
      maxIterations: status.maxIterations,
      currentIteration: status.currentIteration,
      completionReason: status.completionReason,
      verification: status.verification,
      verificationTimeoutSec: status.verificationTimeoutSec,
      artifactDir: status.artifactDir,
      dataDir: status.dataDir,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt
    },
    goalState: status.goalState,
    latestJob: status.latestJob,
    iteration: status.iteration,
    currentIterationDetail: status.currentIterationDetail,
    runnerResult: runnerResult.result,
    runnerResultError: runnerResult.error,
    reducer: status.reducer,
    nextJob: status.nextJob,
    nextAction: status.nextAction,
    nextActionDetail: status.nextActionDetail,
    latestCommitSha: status.latestCommitSha,
    daemon: status.daemon,
    staleRecovery: status.staleRecovery,
    policy: status.policy,
    sourceItems: status.sourceItems,
    latestEvidence: status.latestEvidence,
    pendingUpdateIntents: status.pendingUpdateIntents,
    totalPendingUpdateIntentCount: status.totalPendingUpdateIntentCount,
    truncatedPendingUpdateIntents: status.truncatedPendingUpdateIntents,
    intentStaleThresholdMs: status.intentStaleThresholdMs,
    externalApply: status.externalApply,
    artifactPaths: status.artifactPaths,
    artifactFiles: status.artifactFiles
  };
}

function toJsonShape(data: HandoffData): Record<string, unknown> {
  return {
    schema_version: data.schemaVersion,
    generated_at: data.generatedAt,
    goal: {
      id: data.goal.id,
      title: data.goal.title,
      state: data.goal.state,
      repo: data.goal.repo,
      branch: data.goal.branch,
      runner: data.goal.runner,
      runner_profile: data.goal.runnerProfile
        ? {
            kind: data.goal.runnerProfile.kind,
            name: data.goal.runnerProfile.name,
            description: data.goal.runnerProfile.description,
            executes: data.goal.runnerProfile.executes
          }
        : null,
      max_iterations: data.goal.maxIterations,
      current_iteration: data.goal.currentIteration,
      completion_reason: data.goal.completionReason,
      verification: data.goal.verification,
      verification_timeout_sec: data.goal.verificationTimeoutSec,
      artifact_dir: data.goal.artifactDir,
      data_dir: data.goal.dataDir,
      created_at: data.goal.createdAt,
      updated_at: data.goal.updatedAt
    },
    latest_job: data.latestJob ? jobToJsonShape(data.latestJob) : null,
    iteration: data.iteration
      ? {
          iteration: data.iteration.iteration,
          started_at: data.iteration.startedAt,
          finished_at: data.iteration.finishedAt,
          branch: data.iteration.branch,
          branch_created: data.iteration.branchCreated,
          base_head: data.iteration.baseHead,
          post_runner_head: data.iteration.postRunnerHead,
          commit_sha: data.iteration.commitSha,
          commit_message: data.iteration.commitMessage,
          runner_success: data.iteration.runnerSuccess,
          goal_complete: data.iteration.goalComplete,
          failure: data.iteration.failure
            ? {
                code: data.iteration.failure.code,
                error: data.iteration.failure.error
              }
            : null
        }
      : null,
    runner_result: data.runnerResult
      ? {
          success: data.runnerResult.success,
          summary: data.runnerResult.summary,
          key_changes_made: data.runnerResult.keyChangesMade,
          key_learnings: data.runnerResult.keyLearnings,
          remaining_work: data.runnerResult.remainingWork,
          goal_complete: data.runnerResult.goalComplete
        }
      : null,
    runner_result_error: data.runnerResultError,
    reducer: data.reducer
      ? {
          decision: data.reducer.decision,
          job_id: data.reducer.jobId,
          iteration: data.reducer.iteration,
          job_state: data.reducer.jobState,
          goal_state: data.reducer.goalState,
          completion_reason: data.reducer.completionReason,
          goal_complete: data.reducer.goalComplete,
          commit_sha: data.reducer.commitSha,
          max_iterations: data.reducer.maxIterations,
          recorded_at: data.reducer.recordedAt,
          next_job: data.reducer.nextJob
            ? {
                job_id: data.reducer.nextJob.jobId,
                iteration: data.reducer.nextJob.iteration,
                idempotency_key: data.reducer.nextJob.idempotencyKey,
                artifact_path: data.reducer.nextJob.artifactPath
              }
            : null
        }
      : null,
    next_job: data.nextJob ? jobToJsonShape(data.nextJob) : null,
    current_iteration_detail: data.currentIterationDetail
      ? {
          number: data.currentIterationDetail.number,
          job_id: data.currentIterationDetail.jobId,
          state: data.currentIterationDetail.state,
          queued_at: data.currentIterationDetail.queuedAt,
          started_at: data.currentIterationDetail.startedAt,
          completed_at: data.currentIterationDetail.completedAt
        }
      : null,
    next_action: data.nextAction,
    next_action_detail: data.nextActionDetail
      ? {
          kind: data.nextActionDetail.kind,
          message: data.nextActionDetail.message,
          job_id: data.nextActionDetail.jobId,
          iteration: data.nextActionDetail.iteration
        }
      : null,
    goal_state: data.goalState,
    latest_commit_sha: data.latestCommitSha,
    daemon: data.daemon
      ? {
          run_id: data.daemon.runId,
          state: data.daemon.state,
          is_active: data.daemon.isActive,
          is_terminal: data.daemon.isTerminal,
          started_at: data.daemon.startedAt,
          heartbeat_at: data.daemon.heartbeatAt,
          finished_at: data.daemon.finishedAt,
          active_job: {
            job_id: data.daemon.activeJob.jobId,
            lock_id: data.daemon.activeJob.lockId
          },
          stop_request: data.daemon.stopRequest
            ? {
                requested_at: data.daemon.stopRequest.requestedAt,
                reason: data.daemon.stopRequest.reason
              }
            : null,
          stop_now_request: data.daemon.stopNowRequest
            ? {
                requested_at: data.daemon.stopNowRequest.requestedAt,
                reason: data.daemon.stopNowRequest.reason
              }
            : null,
          cancel_outcome: data.daemon.cancelOutcome
            ? { outcome: data.daemon.cancelOutcome.outcome }
            : null
        }
      : null,
    stale_recovery: {
      recovered_repo_lock_count: data.staleRecovery.recoveredRepoLockCount,
      recovered_job_count: data.staleRecovery.recoveredJobCount,
      latest_recovered_repo_lock_at: data.staleRecovery.latestRecoveredRepoLockAt,
      latest_recovered_job_at: data.staleRecovery.latestRecoveredJobAt,
      stale_repo_lock_count: data.staleRecovery.staleRepoLockCount,
      stale_claimed_job_count: data.staleRecovery.staleClaimedJobCount,
      stale_lease_grace_ms: data.staleRecovery.staleLeaseGraceMs
    },
    policy: {
      configured: data.policy.configured,
      present: data.policy.present,
      path: data.policy.path,
      has_notes: data.policy.hasNotes,
      config: data.policy.config
        ? {
            runner: data.policy.config.runner,
            verification: data.policy.config.verification,
            verification_timeout_sec: data.policy.config.verificationTimeoutSec
          }
        : null,
      error: data.policy.error
        ? { code: data.policy.error.code, message: data.policy.error.message }
        : null
    },
    ...(data.sourceItems.length > 0
      ? {
          source_items: data.sourceItems.map(sourceItemToJsonShape)
        }
      : {}),
    ...(data.latestEvidence.length > 0
      ? {
          latest_evidence: data.latestEvidence.map(evidenceToJsonShape)
        }
      : {}),
    ...(data.pendingUpdateIntents.length > 0
      ? {
          pending_update_intent_count: data.totalPendingUpdateIntentCount,
          pending_update_intents_truncated:
            data.truncatedPendingUpdateIntents,
          pending_update_intents: data.pendingUpdateIntents.map(
            pendingIntentToJsonShape
          ),
          intent_stale_threshold_ms: data.intentStaleThresholdMs
        }
      : {}),
    external_apply: externalApplyToJsonShape(data.externalApply),
    artifacts: {
      goal_md: data.artifactPaths.goalMd,
      ledger_md: data.artifactPaths.ledgerMd,
      handoff_md: data.artifactPaths.handoffMd,
      handoff_json: data.artifactPaths.handoffJson,
      recovery_md: data.artifactPaths.recoveryMd,
      prompt_md: data.artifactPaths.promptMd,
      runner_log: data.artifactPaths.runnerLog,
      verification_log: data.artifactPaths.verificationLog,
      result_json: data.artifactPaths.resultJson
    },
    artifact_files: {
      goal_md: data.artifactFiles.goalMd,
      ledger_md: data.artifactFiles.ledgerMd,
      handoff_md: data.artifactFiles.handoffMd,
      handoff_json: data.artifactFiles.handoffJson,
      recovery_md: data.artifactFiles.recoveryMd,
      prompt_md: data.artifactFiles.promptMd,
      runner_log: data.artifactFiles.runnerLog,
      verification_log: data.artifactFiles.verificationLog,
      result_json: data.artifactFiles.resultJson
    }
  };
}

function evidenceToJsonShape(
  record: GoalStatusEvidenceSummary
): Record<string, unknown> {
  return {
    id: record.id,
    source: record.source,
    type: record.type,
    format_version: record.formatVersion,
    occurred_at: record.occurredAt,
    summary: record.summary,
    artifact_path: record.artifactPath,
    source_item_id: record.sourceItemId
  };
}

function pendingIntentToJsonShape(
  intent: GoalStatusPendingIntentSummary
): Record<string, unknown> {
  return {
    intent_id: intent.intentId,
    adapter_kind: intent.adapterKind,
    intent_type: intent.intentType,
    target_external_id: intent.targetExternalId,
    reason: intent.reason,
    goal_id: intent.goalId,
    source_item_id: intent.sourceItemId,
    evidence_record_id: intent.evidenceRecordId,
    created_at: intent.createdAt,
    age_ms: intent.ageMs,
    stale: intent.stale,
    external_apply: pendingIntentExternalApplyToJsonShape(intent.externalApply)
  };
}

function pendingIntentExternalApplyToJsonShape(
  external: GoalStatusPendingIntentExternalApply
): Record<string, unknown> {
  return {
    apply_state: external.applyState,
    total_attempts: external.totalAttempts,
    counts: external.counts,
    latest_attempt: external.latestAttempt
      ? intentApplyAuditToJsonShape(external.latestAttempt)
      : null
  };
}

function externalApplyToJsonShape(
  external: GoalStatusExternalApply
): Record<string, unknown> {
  return {
    pending_intent_apply_state_counts: external.pendingIntentApplyStateCounts,
    pending_audit_counts: external.pendingAuditCounts,
    total_attempts: external.totalAttempts,
    latest_attempt: external.latestAttempt
      ? {
          intent_id: external.latestAttempt.intentId,
          ...intentApplyAuditToJsonShape(external.latestAttempt)
        }
      : null
  };
}

function intentApplyAuditToJsonShape(
  audit: IntentApplyAudit
): Record<string, unknown> {
  return {
    id: audit.id,
    adapter_kind: audit.adapterKind,
    provider: audit.provider,
    target: {
      external_id: audit.target.externalId,
      external_key: audit.target.externalKey,
      url: audit.target.url,
      title: audit.target.title
    },
    requested_at: audit.requestedAt,
    finished_at: audit.finishedAt,
    operator_reason: audit.operatorReason,
    operator_actor: audit.operatorActor,
    intent_apply_policy: audit.intentApplyPolicy,
    allow_status_mutation: audit.allowStatusMutation,
    mutation_kind: audit.mutationKind,
    preview_summary: audit.previewSummary,
    idempotency_marker: audit.idempotencyMarker,
    lifecycle_state: audit.lifecycleState,
    result_status: audit.resultStatus,
    result_code: audit.resultCode,
    result_message: audit.resultMessage,
    external_refs: {
      comment_id: audit.externalRefs.commentId,
      comment_url: audit.externalRefs.commentUrl,
      state_transition_id: audit.externalRefs.stateTransitionId
    },
    reconcile: {
      status: audit.reconcile.status,
      warning: audit.reconcile.warning
    },
    created_at: audit.createdAt,
    updated_at: audit.updatedAt
  };
}

function sourceItemToJsonShape(item: SourceItemSummary): Record<string, unknown> {
  return {
    id: item.id,
    adapter_kind: item.adapterKind,
    external_id: item.externalId,
    external_key: item.externalKey,
    url: item.url,
    title: item.title,
    status: item.status,
    last_observed_at: item.lastObservedAt
  };
}

function jobToJsonShape(job: GoalStatusJobSummary): Record<string, unknown> {
  return {
    job_id: job.jobId,
    type: job.type,
    iteration: job.iteration,
    state: job.state,
    attempt_count: job.attemptCount,
    artifact_path: job.artifactPath,
    result_path: job.resultPath,
    error_path: job.errorPath,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    error: job.error,
    idempotency_key: job.idempotencyKey,
    lease_holder: job.leaseHolder,
    lease_acquired_at: job.leaseAcquiredAt,
    lease_heartbeat_at: job.leaseHeartbeatAt,
    lease_expires_at: job.leaseExpiresAt
  };
}

function renderHandoffMarkdown(data: HandoffData): string {
  const lines: string[] = [];

  lines.push(`# Momentum handoff: ${data.goal.title}`);
  lines.push("");
  lines.push(`- Goal ID: ${data.goal.id}`);
  lines.push(`- State: ${data.goal.state}`);
  lines.push(`- Repo: ${data.goal.repo ?? "(unset)"}`);
  lines.push(`- Branch: ${data.goal.branch}`);
  lines.push(`- Runner: ${data.goal.runner}`);
  if (data.goal.runnerProfile) {
    lines.push(
      `- Runner profile: ${data.goal.runnerProfile.name} ` +
        `(executes=${data.goal.runnerProfile.executes ? "true" : "false"})`
    );
  }
  lines.push(`- Max iterations: ${data.goal.maxIterations}`);
  lines.push(`- Schema version: ${data.schemaVersion}`);
  lines.push(`- Generated at (epoch ms): ${data.generatedAt}`);
  lines.push("");

  lines.push("## Verification commands");
  if (data.goal.verification.length === 0) {
    lines.push("- (none)");
  } else {
    for (const command of data.goal.verification) {
      lines.push(`- \`${command}\``);
    }
  }
  lines.push(`- Timeout (sec): ${data.goal.verificationTimeoutSec}`);
  lines.push("");

  lines.push("## Iteration");
  if (!data.iteration) {
    lines.push("- No iteration has run yet.");
  } else {
    lines.push(`- Iteration: ${data.iteration.iteration}`);
    lines.push(`- Base HEAD: ${data.iteration.baseHead ?? "(unknown)"}`);
    lines.push(
      `- Post-runner HEAD: ${data.iteration.postRunnerHead ?? "(unknown)"}`
    );
    lines.push(`- Commit SHA: ${data.iteration.commitSha ?? "(none)"}`);
    if (data.iteration.commitMessage) {
      lines.push(`- Commit message: ${oneLine(data.iteration.commitMessage)}`);
    }
    lines.push(
      `- Runner success: ${formatNullableBool(data.iteration.runnerSuccess)}`
    );
    lines.push(
      `- Goal complete: ${formatNullableBool(data.iteration.goalComplete)}`
    );
    if (data.iteration.failure) {
      lines.push(
        `- Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
      );
    }
  }
  lines.push("");

  if (data.latestJob) {
    lines.push("## Latest job");
    lines.push(`- Job ID: ${data.latestJob.jobId}`);
    lines.push(`- Type: ${data.latestJob.type}`);
    lines.push(`- State: ${data.latestJob.state}`);
    lines.push(`- Attempts: ${data.latestJob.attemptCount}`);
    if (data.latestJob.resultPath) {
      lines.push(`- Result path: ${data.latestJob.resultPath}`);
    }
    if (data.latestJob.errorPath) {
      lines.push(`- Error path: ${data.latestJob.errorPath}`);
    }
    if (data.latestJob.error) {
      lines.push(`- Error: ${data.latestJob.error}`);
    }
    lines.push("");
  }

  lines.push("## Reducer");
  if (!data.reducer) {
    lines.push("- No reducer decision recorded yet.");
  } else {
    lines.push(`- Decision: ${data.reducer.decision}`);
    lines.push(`- Iteration: ${data.reducer.iteration}`);
    lines.push(`- Goal state: ${data.reducer.goalState ?? "(unknown)"}`);
    lines.push(
      `- Completion reason: ${data.reducer.completionReason ?? "(none)"}`
    );
    if (data.reducer.commitSha) {
      lines.push(`- Commit SHA: ${data.reducer.commitSha}`);
    }
    if (data.reducer.nextJob) {
      lines.push(
        `- Next job: ${data.reducer.nextJob.jobId} ` +
          `(iteration ${data.reducer.nextJob.iteration}, ` +
          `key ${data.reducer.nextJob.idempotencyKey})`
      );
    }
  }
  lines.push(`- Next action: ${data.nextAction ?? "(none)"}`);
  lines.push("");

  lines.push("## Runner result");
  if (!data.runnerResult) {
    lines.push("- No runner result captured.");
    if (data.runnerResultError) {
      lines.push(`- Runner result read error: ${data.runnerResultError}`);
    }
  } else {
    if (data.runnerResult.summary) {
      lines.push(`- Summary: ${data.runnerResult.summary}`);
    }
    lines.push(
      `- Success: ${formatNullableBool(data.runnerResult.success)}`
    );
    lines.push(
      `- Goal complete: ${formatNullableBool(data.runnerResult.goalComplete)}`
    );
    appendList(lines, "Key changes made", data.runnerResult.keyChangesMade);
    appendList(lines, "Key learnings", data.runnerResult.keyLearnings);
    appendList(lines, "Remaining work", data.runnerResult.remainingWork);
  }
  lines.push("");

  lines.push("## Daemon");
  if (!data.daemon) {
    lines.push("- No daemon run recorded for this data directory.");
  } else {
    lines.push(`- Run ID: ${data.daemon.runId}`);
    const flags: string[] = [];
    if (data.daemon.isActive) flags.push("active");
    if (data.daemon.isTerminal) flags.push("terminal");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`- State: ${data.daemon.state}${flagStr}`);
    if (data.daemon.stopRequest) {
      lines.push(
        `- Stop requested at: ${data.daemon.stopRequest.requestedAt} ` +
          `(reason: ${data.daemon.stopRequest.reason})`
      );
    }
    if (data.daemon.stopNowRequest) {
      lines.push(
        `- Stop-now requested at: ${data.daemon.stopNowRequest.requestedAt} ` +
          `(reason: ${data.daemon.stopNowRequest.reason})`
      );
    }
    if (data.daemon.cancelOutcome) {
      lines.push(
        `- Cancel outcome: ${data.daemon.cancelOutcome.outcome}`
      );
    }
    if (data.daemon.activeJob.jobId) {
      lines.push(`- Active job: ${data.daemon.activeJob.jobId}`);
    }
    if (data.daemon.finishedAt !== null) {
      lines.push(`- Finished at: ${data.daemon.finishedAt}`);
    }
  }
  lines.push("");

  lines.push("## Stale recovery");
  const sr = data.staleRecovery;
  if (
    sr.recoveredRepoLockCount === 0 &&
    sr.recoveredJobCount === 0 &&
    sr.staleRepoLockCount === 0 &&
    sr.staleClaimedJobCount === 0
  ) {
    lines.push("- No stale-lease recovery activity recorded for this goal.");
  } else {
    lines.push(
      `- Recovered repo locks: ${sr.recoveredRepoLockCount}` +
        (sr.latestRecoveredRepoLockAt !== null
          ? ` (latest at ${sr.latestRecoveredRepoLockAt})`
          : "")
    );
    lines.push(
      `- Recovered jobs: ${sr.recoveredJobCount}` +
        (sr.latestRecoveredJobAt !== null
          ? ` (latest at ${sr.latestRecoveredJobAt})`
          : "")
    );
    lines.push(
      `- Stale repo locks pending manual recovery: ${sr.staleRepoLockCount}`
    );
    lines.push(
      `- Stale claimed jobs pending manual recovery: ${sr.staleClaimedJobCount}`
    );
    lines.push(`- Stale lease grace (ms): ${sr.staleLeaseGraceMs}`);
  }
  lines.push("");

  lines.push("## Policy (MOMENTUM.md)");
  if (!data.policy.configured) {
    lines.push("- Repo path is not set; MOMENTUM.md discovery skipped.");
  } else if (data.policy.error) {
    lines.push(
      `- Error (${data.policy.error.code}): ${data.policy.error.message}`
    );
    if (data.policy.path) lines.push(`- Expected at: ${data.policy.path}`);
  } else if (!data.policy.present) {
    lines.push(
      `- Not present at: ${data.policy.path ?? "(unresolved)"} (using built-in / goal defaults)`
    );
  } else {
    lines.push(`- Loaded from: ${data.policy.path}`);
    if (data.policy.config?.runner) {
      lines.push(`- Default runner: ${data.policy.config.runner}`);
    }
    if (data.policy.config?.verification) {
      lines.push(
        `- Default verification: ${data.policy.config.verification.join(", ")}`
      );
    }
    if (data.policy.config?.verificationTimeoutSec !== null && data.policy.config?.verificationTimeoutSec !== undefined) {
      lines.push(
        `- Default verification_timeout_sec: ${data.policy.config.verificationTimeoutSec}`
      );
    }
    if (data.policy.hasNotes) {
      lines.push("- Policy notes: present (surfaced into iteration prompts as context only).");
    }
  }
  if (data.sourceItems.length > 0) {
    lines.push("## Source items");
    for (const item of data.sourceItems) {
      lines.push(
        `- ${item.adapterKind}/${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""} ` +
        `observed ${item.lastObservedAt}`
      );
    }
    lines.push("");
  }

  if (data.latestEvidence.length > 0) {
    lines.push("## Latest evidence");
    for (const record of data.latestEvidence) {
      lines.push(
        `- ${record.occurredAt} [${record.source}/${record.type}] ${record.summary}`
      );
    }
    lines.push("");
  }

  if (data.pendingUpdateIntents.length > 0) {
    const staleCount = data.pendingUpdateIntents.filter(
      (intent) => intent.stale
    ).length;
    const staleSuffix = staleCount > 0 ? ` (${staleCount} stale)` : "";
    const shownCount = data.pendingUpdateIntents.length;
    const totalCount = data.totalPendingUpdateIntentCount;
    const countSuffix = data.truncatedPendingUpdateIntents
      ? ` (showing ${shownCount} of ${totalCount})`
      : "";
    lines.push(`## Pending update intents${countSuffix}${staleSuffix}`);
    for (const intent of data.pendingUpdateIntents) {
      const staleFlag = intent.stale ? " STALE" : "";
      const latestText = intent.externalApply.latestAttempt
        ? ` latest=${intent.externalApply.latestAttempt.lifecycleState}`
        : "";
      lines.push(
        `- ${intent.intentId} [${intent.adapterKind}/${intent.intentType}] ` +
          `target=${intent.targetExternalId ?? "(none)"} ageMs=${intent.ageMs}${staleFlag}` +
          ` apply=${intent.externalApply.applyState}` +
          ` attempts=${intent.externalApply.totalAttempts}${latestText}: ${intent.reason}`
      );
    }
    lines.push(
      `- Stale threshold (ms): ${data.intentStaleThresholdMs}`
    );
    if (data.truncatedPendingUpdateIntents) {
      lines.push(
        `- ${totalCount - shownCount} additional pending update intents are hidden from this handoff.`
      );
    }
    lines.push(
      "- Review with `momentum intent list --status pending` and apply/skip/cancel with a reason."
    );
    lines.push("");
  }

  lines.push("## External apply");
  const externalApply = data.externalApply;
  const applyStateCounts = externalApply.pendingIntentApplyStateCounts;
  const auditCounts = externalApply.pendingAuditCounts;
  lines.push(
    `- Pending intent apply state: idle=${applyStateCounts.idle}, ` +
      `in_flight=${applyStateCounts.in_flight}, ` +
      `blocked=${applyStateCounts.blocked}`
  );
  lines.push(
    `- Pending audits: total=${externalApply.totalAttempts}, ` +
      `succeeded=${auditCounts.succeeded}, ` +
      `failed=${auditCounts.failed}, ` +
      `claimed=${auditCounts.claimed}, ` +
      `blocked=${auditCounts.blocked}, ` +
      `audit_incomplete=${auditCounts.audit_incomplete}`
  );
  const latestExternalApply = externalApply.latestAttempt;
  if (latestExternalApply) {
    lines.push(
      `- Latest attempt: ${latestExternalApply.id} ${latestExternalApply.lifecycleState}` +
        ` intent=${latestExternalApply.intentId}` +
        ` (result=${latestExternalApply.resultStatus ?? "(none)"}` +
        ` code=${latestExternalApply.resultCode ?? "(none)"})`
    );
  } else {
    lines.push("- Latest attempt: (none)");
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push(`- Data dir: ${data.goal.dataDir}`);
  lines.push(`- Artifact dir: ${data.goal.artifactDir}`);
  lines.push(
    `- recovery.md (${existsMark(data.artifactFiles.recoveryMd)}): ${data.artifactPaths.recoveryMd}`
  );
  lines.push(
    `- prompt.md (${existsMark(data.artifactFiles.promptMd)}): ${data.artifactPaths.promptMd}`
  );
  lines.push(
    `- runner.log (${existsMark(data.artifactFiles.runnerLog)}): ${data.artifactPaths.runnerLog}`
  );
  lines.push(
    `- verification.log (${existsMark(data.artifactFiles.verificationLog)}): ${data.artifactPaths.verificationLog}`
  );
  if (
    data.latestJob?.resultPath &&
    data.latestJob.resultPath !== data.artifactPaths.resultJson
  ) {
    lines.push(`- runner result (latest job): ${data.latestJob.resultPath}`);
  }
  lines.push(
    `- result.json (${existsMark(data.artifactFiles.resultJson)}): ${data.artifactPaths.resultJson} (default placeholder)`
  );
  lines.push("");

  return lines.join("\n");
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`- ${label}: (none)`);
    return;
  }
  lines.push(`- ${label}:`);
  for (const value of values) {
    lines.push(`  - ${value}`);
  }
}

function formatNullableBool(value: boolean | null): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function existsMark(present: boolean): string {
  return present ? "present" : "missing";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type RunnerResultRead = {
  result: HandoffRunnerResultSummary | null;
  error: string | null;
};

function readRunnerResult(resultPath: string): RunnerResultRead {
  let raw: string;
  try {
    raw = fs.readFileSync(resultPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { result: null, error: `failed to read runner result file: ${detail}` };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return { result: null, error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { result: null, error: `malformed runner result JSON: ${detail}` };
  }
  if (!isRecord(parsed)) {
    return {
      result: null,
      error: "runner result JSON is not an object"
    };
  }

  return {
    result: {
      success: typeof parsed["success"] === "boolean" ? parsed["success"] : null,
      summary: typeof parsed["summary"] === "string" ? parsed["summary"] : null,
      keyChangesMade: stringArray(parsed["key_changes_made"]),
      keyLearnings: stringArray(parsed["key_learnings"]),
      remainingWork: stringArray(parsed["remaining_work"]),
      goalComplete:
        typeof parsed["goal_complete"] === "boolean"
          ? parsed["goal_complete"]
          : null
    },
    error: null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}
