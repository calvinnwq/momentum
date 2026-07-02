export type MergeCleanupLifecyclePhase = "preflight" | "apply" | "reconcile";

export type MergeCleanupLifecycleAction =
  | "fix_setup_config_then_retry"
  | "resolve_target_then_retry"
  | "stop_unsafe_state"
  | "merge_and_cleanup"
  | "reconcile_already_merged";

export type MergeCleanupLifecycleStatus =
  | "auth_missing"
  | "target_missing"
  | "pr_missing"
  | "pr_state_unreadable"
  | "head_mismatch"
  | "unsafe_state"
  | "open_safe_merge"
  | "already_merged"
  | "branch_already_deleted";

export type MergeCleanupTargetIdentity = {
  pullRequestId: string;
  expectedHeadSha: string;
  cleanupBranch: string;
};

export type MergeCleanupPullRequestState = {
  id: string;
  headSha: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  mergeable: "mergeable" | "conflicting" | "blocked" | "unknown";
  branchDeleted: boolean;
};

export type MergeCleanupLifecycleInput = {
  authAvailable: boolean;
  authSource?: string | null;
  target?: MergeCleanupTargetIdentity | null;
  pullRequest?: MergeCleanupPullRequestState | null;
  pullRequestReadError?: string | null;
};

export type MergeCleanupLifecyclePlan = {
  phase: MergeCleanupLifecyclePhase;
  status: MergeCleanupLifecycleStatus;
  action: MergeCleanupLifecycleAction;
  safeToMutate: boolean;
  message: string;
  evidence: {
    authSource: string | null;
    pullRequestId: string | null;
    expectedHeadSha: string | null;
    observedHeadSha: string | null;
    cleanupBranch: string | null;
  };
};

const SHA_RE = /^[0-9a-f]{40}$/i;

export function planMergeCleanupLifecycle(
  input: MergeCleanupLifecycleInput
): MergeCleanupLifecyclePlan {
  const authSource = input.authSource?.trim() || null;
  const evidenceBase = {
    authSource,
    pullRequestId: input.target?.pullRequestId ?? null,
    expectedHeadSha: input.target?.expectedHeadSha ?? null,
    observedHeadSha: input.pullRequest?.headSha ?? null,
    cleanupBranch: input.target?.cleanupBranch ?? null
  };

  if (!input.authAvailable || authSource === null) {
    return plan("preflight", "auth_missing", "fix_setup_config_then_retry", false, {
      ...evidenceBase,
      authSource: null
    });
  }
  if (!isValidMergeCleanupTarget(input.target)) {
    return plan("preflight", "target_missing", "resolve_target_then_retry", false, evidenceBase);
  }
  const pullRequestReadError = input.pullRequestReadError?.trim();
  if (pullRequestReadError) {
    return plan("preflight", "pr_state_unreadable", "resolve_target_then_retry", false, evidenceBase);
  }
  if (input.pullRequest === undefined) {
    return plan("preflight", "target_missing", "resolve_target_then_retry", false, evidenceBase);
  }
  if (input.pullRequest === null) {
    return plan("preflight", "pr_missing", "resolve_target_then_retry", false, evidenceBase);
  }
  if (input.pullRequest.id !== input.target.pullRequestId) {
    return plan("preflight", "pr_missing", "resolve_target_then_retry", false, evidenceBase);
  }
  if (input.pullRequest.headSha.toLowerCase() !== input.target.expectedHeadSha.toLowerCase()) {
    return plan("preflight", "head_mismatch", "stop_unsafe_state", false, evidenceBase);
  }
  if (input.pullRequest.state === "merged") {
    return plan(
      "reconcile",
      input.pullRequest.branchDeleted ? "branch_already_deleted" : "already_merged",
      "reconcile_already_merged",
      false,
      evidenceBase
    );
  }
  if (
    input.pullRequest.state !== "open" ||
    input.pullRequest.draft ||
    input.pullRequest.mergeable !== "mergeable"
  ) {
    return plan("preflight", "unsafe_state", "stop_unsafe_state", false, evidenceBase);
  }
  return plan("apply", "open_safe_merge", "merge_and_cleanup", true, evidenceBase);
}

export function isValidMergeCleanupTarget(
  target: MergeCleanupTargetIdentity | null | undefined
): target is MergeCleanupTargetIdentity {
  return (
    target !== null &&
    target !== undefined &&
    target.pullRequestId.trim().length > 0 &&
    SHA_RE.test(target.expectedHeadSha) &&
    target.cleanupBranch.trim().length > 0
  );
}

function plan(
  phase: MergeCleanupLifecyclePhase,
  status: MergeCleanupLifecycleStatus,
  action: MergeCleanupLifecycleAction,
  safeToMutate: boolean,
  evidence: MergeCleanupLifecyclePlan["evidence"]
): MergeCleanupLifecyclePlan {
  return {
    phase,
    status,
    action,
    safeToMutate,
    message: `merge-cleanup ${phase} classified ${status}; action=${action}`,
    evidence
  };
}
