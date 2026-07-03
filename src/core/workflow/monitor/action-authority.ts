import type { WorkflowGateType } from "../gate/gate.js";
import type { WorkflowMonitorEnvelope } from "./envelope.js";
import type {
  WorkflowMonitorNextActionCode,
  WorkflowMonitorRecoveryCode
} from "./state.js";
import type { WorkflowMonitorProgressTick } from "./progress.js";
import type { WorkflowStepKind } from "../run/reducer.js";

export const WORKFLOW_ACTION_AUTHORITY_CLASSES = [
  "auto_allowed",
  "recommend_only",
  "human_required",
  "forbidden"
] as const;
export type WorkflowActionAuthorityClass =
  (typeof WORKFLOW_ACTION_AUTHORITY_CLASSES)[number];

export const WORKFLOW_ACTION_RISK_LEVELS = [
  "none",
  "low",
  "medium",
  "high"
] as const;
export type WorkflowActionRiskLevel =
  (typeof WORKFLOW_ACTION_RISK_LEVELS)[number];

export const WORKFLOW_ACTION_POLICY_KEYS = [
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
] as const;
export type WorkflowActionPolicyKey =
  (typeof WORKFLOW_ACTION_POLICY_KEYS)[number];

export type WorkflowActionAuthorityPolicy = {
  action: string;
  authority: WorkflowActionAuthorityClass;
  risk: WorkflowActionRiskLevel;
  evidenceRequired: readonly string[];
  rollback: string;
  rationale: string;
};

export type WorkflowWatchRecommendedAction =
  | "poll"
  | "approve"
  | "operator_decision"
  | "recover"
  | "release";

export type WorkflowWatchActionRecommendation = {
  recommendedAction: WorkflowWatchRecommendedAction;
  recommendedActionPolicy: WorkflowActionAuthorityPolicy;
};

type WorkflowActionAuthorityPolicyTemplate = Omit<
  WorkflowActionAuthorityPolicy,
  "action"
>;

const ACTION_POLICIES: Record<
  WorkflowActionPolicyKey,
  WorkflowActionAuthorityPolicyTemplate
> = {
  wait: {
    authority: "auto_allowed",
    risk: "none",
    evidenceRequired: ["durable monitor state shows no actionable work"],
    rollback: "Continue polling or stop the supervisor loop.",
    rationale: "Waiting does not mutate workflow, repo, or external state."
  },
  watch_recheck: {
    authority: "auto_allowed",
    risk: "low",
    evidenceRequired: ["fresh watch envelope", "durable workflow rows"],
    rollback: "Stop polling; no external state was changed by the policy.",
    rationale:
      "Supervisor watch rechecks are explicitly allowlisted for local/read-only polling metadata."
  },
  monitor_recheck: {
    authority: "auto_allowed",
    risk: "low",
    evidenceRequired: ["fresh monitor envelope", "durable workflow rows"],
    rollback: "Stop polling; no external state was changed by the policy.",
    rationale:
      "Monitor rechecks are explicitly allowlisted for local/read-only supervisor inspection."
  },
  release_monitor: {
    authority: "auto_allowed",
    risk: "low",
    evidenceRequired: ["terminal run state", "cleanup release signal"],
    rollback: "Re-register or resume the external monitor if more observation is needed.",
    rationale:
      "Releasing a supervisor monitor after terminal evidence only affects local/host polling registration."
  },
  approval_decision: {
    authority: "human_required",
    risk: "medium",
    evidenceRequired: ["open approval gate", "operator approval phrase"],
    rollback: "Clear or supersede the approval through the normal workflow gate path.",
    rationale:
      "Approval changes the authorized execution envelope and must remain operator-gated."
  },
  operator_decision: {
    authority: "human_required",
    risk: "medium",
    evidenceRequired: ["open operator-decision gate", "chosen allowed action"],
    rollback: "Record a new gate decision or recover the run with operator evidence.",
    rationale:
      "Operator decisions select a branch of execution and cannot be inferred by the supervisor."
  },
  clear_recovery: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["recovery reason", "operator evidence pointer or explanation"],
    rollback: "Re-mark manual recovery if the underlying evidence was incomplete.",
    rationale:
      "Clearing recovery unblocks durable workflow state and must be backed by human-reviewed evidence."
  },
  retry_step: {
    authority: "human_required",
    risk: "medium",
    evidenceRequired: ["failed step evidence", "operator retry decision"],
    rollback: "Stop the retry and return the run to manual recovery if evidence is unsafe.",
    rationale:
      "Retrying a failed step may repeat repo or external effects unless an operator narrows the action."
  },
  stale_lease_auto_release: {
    authority: "auto_allowed",
    risk: "low",
    evidenceRequired: ["stale auto-release lease", "no active owner evidence"],
    rollback: "Recreate a lease by dispatching the next valid workflow tick.",
    rationale:
      "The scheduler's stale auto-release path is a local recovery primitive with bounded durable evidence."
  },
  stale_lease_manual_recovery: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["stale manual-recovery lease", "operator recovery evidence"],
    rollback: "Keep the run blocked until the stale owner is understood.",
    rationale:
      "Manual-recovery leases are explicit stop signs for the supervisor and require human inspection."
  },
  merge_cleanup: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["pull request state", "remote branch state", "local repo state"],
    rollback: "Reconcile manually; do not blindly re-run merge cleanup.",
    rationale:
      "Merge cleanup can affect remote git and pull request state, so it is never silently auto-run."
  },
  linear_refresh: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["tracker state", "local update intent/audit evidence"],
    rollback: "Reconcile the tracker manually or leave the intent pending.",
    rationale:
      "Linear refresh can write external tracker state, so it is never silently auto-run."
  },
  external_apply: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["external-apply audit", "idempotency marker", "target state"],
    rollback: "Use the external system's own audit trail and local intent reconciliation.",
    rationale:
      "External apply performs side effects outside Momentum and must stay policy-gated."
  },
  no_mistakes_recovery: {
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["no-mistakes run id", "checks-passed evidence", "clean PR state"],
    rollback: "Return the run to manual recovery if the external no-mistakes evidence is stale.",
    rationale:
      "No-mistakes recovery can reconcile terminal workflow state from external evidence and needs human review."
  },
  default_switch: {
    authority: "forbidden",
    risk: "high",
    evidenceRequired: ["explicit future default-switch issue"],
    rollback: "Blocked: leave the default route unchanged.",
    rationale:
      "Default-switch automation is blocked until a scoped default-switch decision explicitly authorizes it."
  },
  destructive_action: {
    authority: "forbidden",
    risk: "high",
    evidenceRequired: ["explicit operator instruction outside supervisor automation"],
    rollback: "Blocked: preserve current state and surface the refusal.",
    rationale:
      "Destructive actions are blocked from supervisor auto-policy because rollback may be impossible."
  },
  broad_external_action: {
    authority: "forbidden",
    risk: "high",
    evidenceRequired: ["explicit scoped external-write policy"],
    rollback: "Blocked: do not touch external systems.",
    rationale:
      "Broad external actions are blocked unless a narrow policy-gated adapter path authorizes the exact write."
  }
};

const POLICY_KEYS = new Set<string>(WORKFLOW_ACTION_POLICY_KEYS);

export function isWorkflowActionPolicyKey(
  value: string
): value is WorkflowActionPolicyKey {
  return POLICY_KEYS.has(value);
}

export function getWorkflowActionAuthorityPolicy(
  action: WorkflowActionPolicyKey
): WorkflowActionAuthorityPolicy {
  return { action, ...ACTION_POLICIES[action] };
}

export function fallbackWorkflowActionAuthorityPolicy(
  action: string | null | undefined
): WorkflowActionAuthorityPolicy {
  const normalized = action?.trim() || "unknown";
  if (normalized === "wait" || normalized === "no_action") {
    return {
      action: normalized === "no_action" ? "wait" : normalized,
      ...ACTION_POLICIES.wait
    };
  }
  return {
    action: normalized,
    authority: "human_required",
    risk: "high",
    evidenceRequired: ["valid supervisor action policy"],
    rollback: "Treat the action as blocked until a valid policy is present.",
    rationale:
      "Policy fallback is fail-closed: absent or invalid policy metadata makes every non-wait action human-required."
  };
}

export function workflowActionAuthorityPolicyOrFallback(
  action: string | null | undefined
): WorkflowActionAuthorityPolicy {
  if (action !== undefined && action !== null && isWorkflowActionPolicyKey(action)) {
    return getWorkflowActionAuthorityPolicy(action);
  }
  return fallbackWorkflowActionAuthorityPolicy(action);
}

export type WorkflowWatchRecommendedActionPolicyInput = {
  recommendedAction: string;
  nextActionCode: WorkflowMonitorNextActionCode | string | null;
  nextActionStepId?: string | null;
  recoveryCode: WorkflowMonitorRecoveryCode | string | null;
  activeStepKind: WorkflowStepKind | string | null;
  openGateType?: WorkflowGateType | string | null;
};

export function policyForWorkflowWatchRecommendedAction(
  input: WorkflowWatchRecommendedActionPolicyInput
): WorkflowActionAuthorityPolicy {
  const policyKey = workflowWatchPolicyKey(input);
  return workflowActionAuthorityPolicyOrFallback(policyKey);
}

export function deriveWorkflowWatchActionRecommendation(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick
): WorkflowWatchActionRecommendation {
  const recommendedAction = recommendWorkflowWatchAction(envelope, progress);
  const openGate = envelope.gates.find((gate) => gate.resolvedAt === null);
  return {
    recommendedAction,
    recommendedActionPolicy: policyForWorkflowWatchRecommendedAction({
      recommendedAction,
      nextActionCode: envelope.nextAction.code,
      nextActionStepId: envelope.nextAction.stepId,
      recoveryCode: envelope.recovery?.code ?? null,
      activeStepKind: envelope.activeStep?.kind ?? null,
      openGateType: openGate?.gateType ?? null
    })
  };
}

export type WorkflowGateRecommendedActionPolicyInput = {
  gateType: WorkflowGateType | string;
  recommendedAction: string | null;
};

export function policyForWorkflowGateRecommendedAction(
  input: WorkflowGateRecommendedActionPolicyInput
): WorkflowActionAuthorityPolicy {
  if (input.gateType === "approval_required") {
    return getWorkflowActionAuthorityPolicy("approval_decision");
  }
  if (input.gateType === "operator_decision_required") {
    return getWorkflowActionAuthorityPolicy("operator_decision");
  }
  if (input.gateType === "manual_recovery_required") {
    return getWorkflowActionAuthorityPolicy("clear_recovery");
  }
  return fallbackWorkflowActionAuthorityPolicy(input.recommendedAction);
}

function workflowWatchPolicyKey(
  input: WorkflowWatchRecommendedActionPolicyInput
): WorkflowActionPolicyKey | string {
  const isExternalTailRecovery =
    input.recommendedAction === "recover" &&
    (input.recoveryCode === "failed_external_side_effect_step" ||
      input.nextActionCode === "clear_recovery") &&
    (input.activeStepKind === "merge-cleanup" ||
      input.activeStepKind === "linear-refresh" ||
      input.nextActionStepId === "merge-cleanup" ||
      input.nextActionStepId === "linear-refresh");
  if (isExternalTailRecovery) {
    return input.activeStepKind === "linear-refresh" ||
      input.nextActionStepId === "linear-refresh"
      ? "linear_refresh"
      : "merge_cleanup";
  }
  if (
    input.recommendedAction === "operator_decision" &&
    input.openGateType !== undefined &&
    input.openGateType !== null
  ) {
    return policyKeyForOpenWorkflowGate(input.openGateType);
  }
  if (
    input.recommendedAction === "operator_decision" &&
    input.nextActionCode === "advance_to_step" &&
    (input.nextActionStepId === "merge-cleanup" ||
      input.nextActionStepId === "linear-refresh")
  ) {
    return input.nextActionStepId === "linear-refresh"
      ? "linear_refresh"
      : "merge_cleanup";
  }
  if (
    input.activeStepKind === "no-mistakes" &&
    input.nextActionCode === "clear_recovery"
  ) {
    return "no_mistakes_recovery";
  }
  switch (input.recommendedAction) {
    case "poll":
      return "watch_recheck";
    case "approve":
      return "approval_decision";
    case "operator_decision":
      return "operator_decision";
    case "recover":
      return input.nextActionCode === "rerun_failed_step"
        ? "retry_step"
        : "clear_recovery";
    case "release":
      return "release_monitor";
    default:
      return input.recommendedAction;
  }
}

function policyKeyForOpenWorkflowGate(
  gateType: WorkflowGateType | string
): WorkflowActionPolicyKey | string {
  if (gateType === "approval_required") {
    return "approval_decision";
  }
  if (gateType === "operator_decision_required") {
    return "operator_decision";
  }
  if (gateType === "manual_recovery_required") {
    return "clear_recovery";
  }
  return "operator_decision";
}

function recommendWorkflowWatchAction(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick
): WorkflowWatchRecommendedAction {
  if (progress.cleanup === "release") return "release";
  if (envelope.recovery?.code === "failed_required_step") {
    return "operator_decision";
  }
  if (
    envelope.recovery?.code === "monitor_drift_stale" &&
    !envelope.needsManualRecovery
  ) {
    return envelope.gates.some((gate) => gate.resolvedAt === null)
      ? "operator_decision"
      : "poll";
  }
  if (envelope.needsManualRecovery || envelope.recovery !== null) {
    return "recover";
  }
  if (envelope.gates.some((gate) => gate.resolvedAt === null)) {
    return "operator_decision";
  }
  if (
    envelope.nextAction.code === "advance_to_step" &&
    (envelope.nextAction.stepId === "merge-cleanup" ||
      envelope.nextAction.stepId === "linear-refresh")
  ) {
    return "operator_decision";
  }
  if (
    progress.phase === "awaiting_approval" &&
    envelope.nextAction.code === "await_approval" &&
    envelope.activeStep !== null
  ) {
    return "approve";
  }
  return "poll";
}
