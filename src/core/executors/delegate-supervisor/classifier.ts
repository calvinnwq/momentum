import crypto from "node:crypto";

import { isExecutorDecisionEligibleForHumanGate } from "../loop/reducer.js";
import {
  DELEGATE_SUPERVISOR_CI_STATES,
  DELEGATE_SUPERVISOR_EXTERNAL_STATUSES,
  DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID,
  type DelegateSupervisorDecision,
  type DelegateSupervisorExternalDecision,
  type DelegateSupervisorExternalState,
} from "./types.js";

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const STATUS_SET: ReadonlySet<string> = new Set(
  DELEGATE_SUPERVISOR_EXTERNAL_STATUSES,
);
const CI_STATE_SET: ReadonlySet<string> = new Set(
  DELEGATE_SUPERVISOR_CI_STATES,
);

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function manualRecovery(
  recoveryCode: "external_state_unreadable" | "external_state_inconsistent",
  reason: string,
): DelegateSupervisorDecision {
  return {
    classification: "manual_recovery_required",
    roundState: "manual_recovery_required",
    invocationState: "manual_recovery_required",
    humanGate: "manual_recovery_required",
    recoveryCode,
    reason,
  };
}

function findUnreadableReason(
  state: DelegateSupervisorExternalState,
): string | null {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return "state is not an object";
  }
  if (!isNonBlank(state.externalRunId)) return "external run id is missing";
  if (!isNonBlank(state.branch)) return "branch is missing";
  if (!COMMIT_SHA_RE.test(state.headSha)) {
    return "head SHA is not a 7- to 40-character hex commit id";
  }
  if (state.activeStep !== null && !isNonBlank(state.activeStep)) {
    return "active step is blank or not a string";
  }
  if (state.prUrl !== null && !isNonBlank(state.prUrl)) {
    return "pull request URL is blank or not a string";
  }
  if (!STATUS_SET.has(state.stepStatus)) {
    return `unknown external step status ${String(state.stepStatus)}`;
  }
  if (!CI_STATE_SET.has(state.ciState)) {
    return `unknown external CI state ${String(state.ciState)}`;
  }
  if (!Array.isArray(state.findings)) return "findings is not an array";
  if (!Array.isArray(state.selectedFindingIds)) {
    return "selected finding ids is not an array";
  }
  if (!Array.isArray(state.decisions)) return "decisions is not an array";

  const findingIds = new Set<string>();
  for (const finding of state.findings) {
    if (
      finding === null ||
      typeof finding !== "object" ||
      Array.isArray(finding)
    ) {
      return "a finding is not an object";
    }
    if (!isNonBlank(finding.externalId)) {
      return "a finding is missing its external id";
    }
    if (!isNonBlank(finding.title)) {
      return `finding ${finding.externalId} is missing its title`;
    }
    if (
      finding.severity !== undefined &&
      finding.severity !== null &&
      typeof finding.severity !== "string"
    ) {
      return `finding ${finding.externalId} severity is not a string`;
    }
    if (
      finding.detail !== undefined &&
      finding.detail !== null &&
      typeof finding.detail !== "string"
    ) {
      return `finding ${finding.externalId} detail is not a string`;
    }
    if (findingIds.has(finding.externalId)) {
      return `duplicate finding id ${finding.externalId}`;
    }
    findingIds.add(finding.externalId);
  }
  const selectedFindingIds = new Set<string>();
  for (const selectedId of state.selectedFindingIds) {
    if (!isNonBlank(selectedId)) {
      return "a selected finding id is blank or not a string";
    }
    if (!findingIds.has(selectedId)) {
      return `selected finding id ${selectedId} references no surfaced finding`;
    }
    if (selectedFindingIds.has(selectedId)) {
      return `duplicate selected finding id ${selectedId}`;
    }
    selectedFindingIds.add(selectedId);
  }

  const decisionIds = new Set<string>();
  for (const decision of state.decisions) {
    if (
      decision === null ||
      typeof decision !== "object" ||
      Array.isArray(decision)
    ) {
      return "a decision is not an object";
    }
    if (!isNonBlank(decision.externalId)) {
      return "a decision is missing its external id";
    }
    if (
      decision.externalId === DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID
    ) {
      return `decision id ${decision.externalId} is reserved for supervisor-owned approval evidence`;
    }
    if (!isNonBlank(decision.summary)) {
      return `decision ${decision.externalId} is missing its summary`;
    }
    if (!Array.isArray(decision.allowedActions)) {
      return `decision ${decision.externalId} allowed actions is not an array`;
    }
    if (
      decision.allowedActions.length === 0 ||
      decision.allowedActions.some(
        (action: unknown) => !isNonBlank(action) || action.trim() !== action,
      )
    ) {
      return `decision ${decision.externalId} offers no canonical allowed actions`;
    }
    if (
      new Set(decision.allowedActions).size !== decision.allowedActions.length
    ) {
      return `decision ${decision.externalId} offers duplicate allowed actions`;
    }
    if (
      decision.recommendedAction !== undefined &&
      decision.recommendedAction !== null &&
      typeof decision.recommendedAction !== "string"
    ) {
      return `decision ${decision.externalId} recommended action is not a string`;
    }
    if (
      decision.recommendedAction !== undefined &&
      decision.recommendedAction !== null &&
      !decision.allowedActions.includes(decision.recommendedAction)
    ) {
      return `decision ${decision.externalId} recommends an action it does not allow`;
    }
    if (decisionIds.has(decision.externalId)) {
      return `duplicate decision id ${decision.externalId}`;
    }
    for (const [field, value] of [
      ["chosen action", decision.chosenAction],
      ["resolution", decision.resolution],
    ] as const) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        return `decision ${decision.externalId} ${field} is not a string`;
      }
    }
    if (
      decision.chosenAction !== undefined &&
      decision.chosenAction !== null &&
      !decision.allowedActions.includes(decision.chosenAction)
    ) {
      return `decision ${decision.externalId} chose an action it does not allow`;
    }
    decisionIds.add(decision.externalId);
  }
  return null;
}

function isResolved(decision: DelegateSupervisorExternalDecision): boolean {
  return isNonBlank(decision.resolution);
}

/** Single classification authority for every delegated tool adapter. */
export function classifyDelegateSupervisorState(
  state: DelegateSupervisorExternalState,
  subject = "delegated external",
): DelegateSupervisorDecision {
  const unreadable = findUnreadableReason(state);
  if (unreadable !== null) {
    return classifyDelegateSupervisorUnreadable(
      `${subject} state is unreadable: ${unreadable}`,
    );
  }

  switch (state.stepStatus) {
    case "running":
      return {
        classification: "continue",
        roundState: "mirroring_external_state",
        invocationState: "running",
        humanGate: null,
        recoveryCode: null,
        reason: `${subject} run is still in progress; keep mirroring`,
      };
    case "awaiting_decision": {
      if (state.decisions.length === 0) {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run is awaiting_decision but surfaced no decision`,
        );
      }
      const unresolved = state.decisions.filter(
        isExecutorDecisionEligibleForHumanGate,
      );
      if (unresolved.length === 0) {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run is awaiting_decision but surfaced no gate-eligible unresolved decision`,
        );
      }
      return {
        classification: "operator_decision_required",
        roundState: "waiting_operator",
        invocationState: "waiting_operator",
        humanGate: "operator_decision_required",
        recoveryCode: null,
        reason: `${subject} run surfaced a decision; pausing for an operator decision`,
      };
    }
    case "awaiting_approval":
      return {
        classification: "approval_required",
        roundState: "waiting_operator",
        invocationState: "waiting_operator",
        humanGate: "approval_required",
        recoveryCode: null,
        reason: `${subject} run reached an approval boundary; pausing for approval`,
      };
    case "blocked":
      return {
        classification: "blocked",
        roundState: "blocked",
        invocationState: "blocked",
        humanGate: "external_state_required",
        recoveryCode: "external_state_blocked",
        reason: `${subject} run is blocked on external state; resolve it and re-run`,
      };
    case "failed":
      return {
        classification: "failed",
        roundState: "failed",
        invocationState: "failed",
        humanGate: null,
        recoveryCode: "external_run_failed",
        reason: `${subject} run failed`,
      };
    case "cancelled":
      return manualRecovery(
        "external_state_inconsistent",
        `${subject} run was cancelled before reliable completion; inspect the external run before retrying`,
      );
    case "completed": {
      if (!FULL_COMMIT_SHA_RE.test(state.headSha)) {
        return classifyDelegateSupervisorUnreadable(
          `${subject} completed state requires a full 40-character head SHA`,
        );
      }
      if (state.activeStep !== null) {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run claims completed but step ${state.activeStep} remains active`,
        );
      }
      if (state.findings.length > 0 || state.selectedFindingIds.length > 0) {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run claims completed but active findings remain`,
        );
      }
      if (state.ciState === "failed" || state.ciState === "pending") {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run claims completed but CI is ${state.ciState}`,
        );
      }
      const unresolved = state.decisions.filter(
        (decision) => !isResolved(decision),
      );
      if (unresolved.length > 0) {
        return manualRecovery(
          "external_state_inconsistent",
          `${subject} run claims completed but ${unresolved.length} decision(s) are unresolved`,
        );
      }
      return {
        classification: "complete",
        roundState: "succeeded",
        invocationState: "succeeded",
        humanGate: null,
        recoveryCode: null,
        reason: `${subject} run completed with passing CI and resolved decisions`,
      };
    }
  }
}

export function classifyDelegateSupervisorUnreadable(
  reason: string,
): DelegateSupervisorDecision {
  return manualRecovery("external_state_unreadable", reason);
}

export function classifyDelegateSupervisorInconsistent(
  reason: string,
): DelegateSupervisorDecision {
  return manualRecovery("external_state_inconsistent", reason);
}

/** Stable semantic progress fingerprint; raw response bytes remain inputDigest. */
export function delegateSupervisorProgressDigest(
  state: DelegateSupervisorExternalState,
): string {
  const normalized = {
    externalRunId: state.externalRunId,
    branch: state.branch,
    headSha: state.headSha,
    activeStep: state.activeStep,
    stepStatus: state.stepStatus,
    findings: state.findings
      .map((finding) => ({
        externalId: finding.externalId,
        title: finding.title,
        severity: finding.severity ?? null,
        detail: finding.detail ?? null,
      }))
      .sort((left, right) => compareStrings(left.externalId, right.externalId)),
    selectedFindingIds: [...state.selectedFindingIds].sort(compareStrings),
    decisions: state.decisions
      .map((decision) => ({
        externalId: decision.externalId,
        summary: decision.summary,
        allowedActions: [...decision.allowedActions].sort(compareStrings),
        recommendedAction: decision.recommendedAction ?? null,
        chosenAction: decision.chosenAction ?? null,
        resolution: decision.resolution ?? null,
      }))
      .sort((left, right) => compareStrings(left.externalId, right.externalId)),
    prUrl: state.prUrl,
    ciState: state.ciState,
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
