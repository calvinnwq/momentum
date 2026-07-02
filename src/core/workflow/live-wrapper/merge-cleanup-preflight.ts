import {
  isValidMergeCleanupTarget,
  planMergeCleanupLifecycle,
  type MergeCleanupPullRequestState,
  type MergeCleanupTargetIdentity
} from "./merge-cleanup-lifecycle.js";

export type MergeCleanupPreflightStatus =
  | "ready"
  | "auth_missing"
  | "target_missing"
  | "pr_missing"
  | "pr_state_unreadable"
  | "head_mismatch"
  | "already_merged"
  | "branch_already_deleted"
  | "unsafe_state"
  | "unsupported"
  | "unknown";

export type MergeCleanupPreflightResult =
  | {
      ok: true;
      status: "ready";
      message: string;
    }
  | {
      ok: false;
      status: Exclude<MergeCleanupPreflightStatus, "ready">;
      message: string;
      action: string;
    };

export type MergeCleanupSetupPreflightResult =
  | {
      ok: true;
      status: "ready";
      message: string;
      target: MergeCleanupTargetIdentity;
    }
  | Extract<MergeCleanupPreflightResult, { ok: false }>;

const GITHUB_AUTH_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_CONFIG_DIR"
] as const;

type EnvSnapshot = Record<string, string | undefined>;

export function preflightGitHubMergeCleanupSetup(input: {
  env: EnvSnapshot;
  target?: MergeCleanupTargetIdentity | null;
}): MergeCleanupSetupPreflightResult {
  const presentAuth = findGitHubAuthSource(input.env);
  if (presentAuth === undefined) {
    const plan = planMergeCleanupLifecycle({
      authAvailable: false,
      ...(input.target !== undefined ? { target: input.target } : {})
    });
    return {
      ok: false,
      status: plan.status === "open_safe_merge" ? "unknown" : plan.status,
      message: messageForPlan(plan),
      action: actionForPlan(plan)
    };
  }

  if (!isValidMergeCleanupTarget(input.target)) {
    const plan = planMergeCleanupLifecycle({
      authAvailable: true,
      authSource: presentAuth,
      ...(input.target !== undefined ? { target: input.target } : {})
    });
    return {
      ok: false,
      status: plan.status === "open_safe_merge" ? "unknown" : plan.status,
      message: messageForPlan(plan),
      action: actionForPlan(plan)
    };
  }

  return {
    ok: true,
    status: "ready",
    message: `GitHub merge-cleanup setup preflight passed using ${presentAuth}.`,
    target: input.target
  };
}

export function preflightGitHubMergeCleanup(input: {
  env: EnvSnapshot;
  target?: MergeCleanupTargetIdentity | null;
  pullRequest?: MergeCleanupPullRequestState | null;
  pullRequestReadError?: string | null;
}): MergeCleanupPreflightResult {
  const presentAuth = findGitHubAuthSource(input.env);

  const plan = planMergeCleanupLifecycle({
    authAvailable: presentAuth !== undefined,
    ...(presentAuth !== undefined ? { authSource: presentAuth } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.pullRequest !== undefined ? { pullRequest: input.pullRequest } : {}),
    ...(input.pullRequestReadError !== undefined
      ? { pullRequestReadError: input.pullRequestReadError }
      : {})
  });
  if (plan.safeToMutate) {
    return {
      ok: true,
      status: "ready",
      message: `GitHub merge-cleanup preflight passed using ${plan.evidence.authSource}; PR ${plan.evidence.pullRequestId} head ${plan.evidence.observedHeadSha} matches target ${plan.evidence.expectedHeadSha}.`
    };
  }

  return {
    ok: false,
    status: plan.status === "open_safe_merge" ? "unknown" : plan.status,
    message: messageForPlan(plan),
    action: actionForPlan(plan)
  };
}

type MergeCleanupPlan = ReturnType<typeof planMergeCleanupLifecycle>;

function findGitHubAuthSource(env: EnvSnapshot): string | undefined {
  return GITHUB_AUTH_ENV_VARS.find((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function messageForPlan(plan: MergeCleanupPlan): string {
  switch (plan.status) {
    case "auth_missing":
      return "GitHub merge-cleanup has no explicit auth in the workflow process environment.";
    case "target_missing":
      return "GitHub merge-cleanup has no durable pull request/head/cleanup-branch target.";
    case "pr_state_unreadable":
      return "GitHub merge-cleanup could not read the current pull request state before mutation.";
    case "pr_missing":
      return `GitHub merge-cleanup could not verify pull request ${plan.evidence.pullRequestId ?? "(unknown)"}.`;
    case "head_mismatch":
      return `GitHub merge-cleanup refused PR ${plan.evidence.pullRequestId}: observed head ${plan.evidence.observedHeadSha ?? "(unknown)"} does not match expected head ${plan.evidence.expectedHeadSha ?? "(unknown)"}.`;
    case "already_merged":
      return `GitHub merge-cleanup found PR ${plan.evidence.pullRequestId} already merged; reconcile the tail lifecycle instead of re-running mutation.`;
    case "branch_already_deleted":
      return `GitHub merge-cleanup found PR ${plan.evidence.pullRequestId} already merged and cleanup branch ${plan.evidence.cleanupBranch ?? "(unknown)"} already deleted; reconcile the tail lifecycle instead of re-running mutation.`;
    case "unsafe_state":
      return `GitHub merge-cleanup refused PR ${plan.evidence.pullRequestId ?? "(unknown)"} because it is not an open, non-draft, mergeable target.`;
    case "open_safe_merge":
      return plan.message;
  }
}

function actionForPlan(plan: MergeCleanupPlan): string {
  switch (plan.action) {
    case "fix_setup_config_then_retry":
      return "Provide GH_TOKEN, GITHUB_TOKEN, or GH_CONFIG_DIR to the live-wrapper environment before running merge-cleanup.";
    case "resolve_target_then_retry":
      return "Resolve the pull request, expected head SHA, cleanup branch, and GitHub state before running merge-cleanup.";
    case "reconcile_already_merged":
      return "Use workflow run clear-recovery with evidence for the already-applied merge-cleanup side effect; do not blindly re-run merge-cleanup.";
    case "stop_unsafe_state":
      return "Stop monitoring and resolve the pull request state/head mismatch before merge-cleanup can mutate GitHub.";
    case "merge_and_cleanup":
      return "Run merge-cleanup apply.";
  }
}
