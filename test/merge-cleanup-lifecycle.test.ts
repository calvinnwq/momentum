import { describe, expect, it } from "vitest";

import {
  planMergeCleanupLifecycle,
  type MergeCleanupPullRequestState,
  type MergeCleanupTargetIdentity
} from "../src/core/workflow/live-wrapper/merge-cleanup-lifecycle.js";

const HEAD_SHA = "b".repeat(40);
const TARGET: MergeCleanupTargetIdentity = {
  pullRequestId: "42",
  expectedHeadSha: HEAD_SHA,
  cleanupBranch: "feat/merge-cleanup"
};

function pr(
  overrides: Partial<MergeCleanupPullRequestState> = {}
): MergeCleanupPullRequestState {
  return {
    id: TARGET.pullRequestId,
    headBranch: TARGET.cleanupBranch,
    headSha: TARGET.expectedHeadSha,
    state: "open",
    draft: false,
    mergeable: "mergeable",
    branchDeleted: false,
    ...overrides
  };
}

describe("merge-cleanup lifecycle planner", () => {
  it("fails closed before mutation when GitHub auth is missing", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: false,
        target: TARGET,
        pullRequest: pr()
      })
    ).toMatchObject({
      phase: "preflight",
      status: "auth_missing",
      action: "fix_setup_config_then_retry",
      safeToMutate: false
    });
  });

  it("requires a durable PR/head/cleanup-branch target", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: null,
        pullRequest: pr()
      })
    ).toMatchObject({
      phase: "preflight",
      status: "target_missing",
      action: "resolve_target_then_retry",
      safeToMutate: false
    });
  });

  it("fails closed when PR state cannot be read back", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: TARGET,
        pullRequestReadError: "gh pr view failed"
      })
    ).toMatchObject({
      phase: "preflight",
      status: "pr_state_unreadable",
      action: "resolve_target_then_retry",
      safeToMutate: false
    });
  });

  it("refuses stale reviewed head evidence", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: TARGET,
        pullRequest: pr({ headSha: "c".repeat(40) })
      })
    ).toMatchObject({
      phase: "preflight",
      status: "head_mismatch",
      action: "stop_unsafe_state",
      safeToMutate: false
    });
  });

  it("enters apply only for an open non-draft mergeable PR at the expected head", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: TARGET,
        pullRequest: pr()
      })
    ).toMatchObject({
      phase: "apply",
      status: "open_safe_merge",
      action: "merge_and_cleanup",
      safeToMutate: true
    });
  });

  it("reconciles already merged and already cleaned up PRs without mutation", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: TARGET,
        pullRequest: pr({ state: "merged", branchDeleted: true })
      })
    ).toMatchObject({
      phase: "reconcile",
      status: "branch_already_deleted",
      action: "reconcile_already_merged",
      safeToMutate: false
    });
  });

  it("fails closed when mergeability is unknown", () => {
    expect(
      planMergeCleanupLifecycle({
        authAvailable: true,
        authSource: "GH_TOKEN",
        target: TARGET,
        pullRequest: pr({ mergeable: "unknown" })
      })
    ).toMatchObject({
      phase: "preflight",
      status: "unsafe_state",
      action: "stop_unsafe_state",
      safeToMutate: false
    });
  });
});
