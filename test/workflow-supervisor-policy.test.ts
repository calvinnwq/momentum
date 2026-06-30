import { describe, expect, it } from "vitest";

import {
  WORKFLOW_ACTION_AUTHORITY_CLASSES,
  WORKFLOW_ACTION_POLICY_KEYS,
  fallbackWorkflowActionAuthorityPolicy,
  getWorkflowActionAuthorityPolicy,
  policyForWorkflowGateRecommendedAction,
  policyForWorkflowWatchRecommendedAction
} from "../src/core/workflow/action-authority.js";

describe("workflow supervisor action authority policy", () => {
  it("freezes the authority classes and known policy action keys", () => {
    expect([...WORKFLOW_ACTION_AUTHORITY_CLASSES]).toEqual([
      "auto_allowed",
      "recommend_only",
      "human_required",
      "forbidden"
    ]);
    expect([...WORKFLOW_ACTION_POLICY_KEYS]).toEqual([
      "wait",
      "watch_recheck",
      "monitor_recheck",
      "release_monitor",
      "approval_decision",
      "operator_decision",
      "clear_recovery",
      "retry_step",
      "stale_lease_auto_release",
      "stale_lease_manual_recovery",
      "merge_cleanup",
      "linear_refresh",
      "external_apply",
      "no_mistakes_recovery",
      "default_switch",
      "destructive_action",
      "broad_external_action"
    ]);
  });

  it("requires human authority for approvals, operator decisions, and clear-recovery", () => {
    expect(getWorkflowActionAuthorityPolicy("approval_decision")).toMatchObject({
      authority: "human_required",
      risk: "medium"
    });
    expect(getWorkflowActionAuthorityPolicy("operator_decision")).toMatchObject({
      authority: "human_required",
      risk: "medium"
    });
    expect(getWorkflowActionAuthorityPolicy("clear_recovery")).toMatchObject({
      authority: "human_required",
      risk: "high"
    });
  });

  it("allows only explicit safe local/read-only rechecks to be auto-allowed", () => {
    expect(getWorkflowActionAuthorityPolicy("watch_recheck")).toMatchObject({
      authority: "auto_allowed",
      risk: "low"
    });
    expect(getWorkflowActionAuthorityPolicy("monitor_recheck")).toMatchObject({
      authority: "auto_allowed",
      risk: "low"
    });
    expect(getWorkflowActionAuthorityPolicy("stale_lease_auto_release")).toMatchObject({
      authority: "auto_allowed",
      risk: "low"
    });
  });

  it("never silently auto-allows external side-effect tails", () => {
    for (const key of [
      "merge_cleanup",
      "linear_refresh",
      "external_apply"
    ] as const) {
      const policy = getWorkflowActionAuthorityPolicy(key);
      expect(["recommend_only", "human_required"]).toContain(policy.authority);
      expect(policy.authority).not.toBe("auto_allowed");
      expect(policy.evidenceRequired.length).toBeGreaterThan(0);
    }
  });

  it("forbids destructive/default-switch/broad external actions with rationale", () => {
    for (const key of [
      "default_switch",
      "destructive_action",
      "broad_external_action"
    ] as const) {
      expect(getWorkflowActionAuthorityPolicy(key)).toMatchObject({
        authority: "forbidden",
        risk: "high"
      });
      expect(getWorkflowActionAuthorityPolicy(key).rationale).toContain(
        "blocked"
      );
    }
  });

  it("falls back to human-required for unknown non-wait actions", () => {
    expect(fallbackWorkflowActionAuthorityPolicy("future_auto_unblock")).toMatchObject({
      action: "future_auto_unblock",
      authority: "human_required",
      risk: "high"
    });
    expect(fallbackWorkflowActionAuthorityPolicy("wait")).toMatchObject({
      action: "wait",
      authority: "auto_allowed",
      risk: "none"
    });
  });

  it("classifies watch recommended actions with recovery context", () => {
    expect(
      policyForWorkflowWatchRecommendedAction({
        recommendedAction: "approve",
        nextActionCode: "await_approval",
        recoveryCode: null,
        activeStepKind: "implementation"
      })
    ).toMatchObject({ action: "approval_decision", authority: "human_required" });

    expect(
      policyForWorkflowWatchRecommendedAction({
        recommendedAction: "recover",
        nextActionCode: "clear_recovery",
        nextActionStepId: "merge-cleanup",
        recoveryCode: "failed_external_side_effect_step",
        activeStepKind: null
      })
    ).toMatchObject({ action: "merge_cleanup", authority: "human_required" });

    expect(
      policyForWorkflowWatchRecommendedAction({
        recommendedAction: "poll",
        nextActionCode: "resume_running",
        recoveryCode: null,
        activeStepKind: "implementation"
      })
    ).toMatchObject({ action: "watch_recheck", authority: "auto_allowed" });

    expect(
      policyForWorkflowWatchRecommendedAction({
        recommendedAction: "poll",
        nextActionCode: "resume_running",
        recoveryCode: null,
        activeStepKind: "merge-cleanup"
      })
    ).toMatchObject({ action: "watch_recheck", authority: "auto_allowed" });
  });

  it("classifies open gate recommendations without executing them", () => {
    expect(
      policyForWorkflowGateRecommendedAction({
        gateType: "approval_required",
        recommendedAction: "approve"
      })
    ).toMatchObject({ action: "approval_decision", authority: "human_required" });
    expect(
      policyForWorkflowGateRecommendedAction({
        gateType: "operator_decision_required",
        recommendedAction: "retry"
      })
    ).toMatchObject({ action: "operator_decision", authority: "human_required" });
  });
});
