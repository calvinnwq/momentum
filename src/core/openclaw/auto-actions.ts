import fs from "node:fs";
import path from "node:path";

import type {
  OpenClawSupervisorAutoActionResult,
  OpenClawSupervisorEventType,
  OpenClawSupervisorState,
  OpenClawSupervisorTick
} from "./supervisor.js";
import { buildOpenClawDeliveryIntent } from "./delivery-intent.js";
import type {
  WorkflowActionAuthorityClass,
  WorkflowActionAuthorityPolicy,
  WorkflowActionRiskLevel
} from "../workflow/action-authority.js";

const SUPPORTED_AUTO_ACTIONS = new Set([
  "watch_recheck",
  "monitor_recheck",
  "stale_lease_auto_release",
  "release_monitor"
]);

const CONFIG_DISABLED_PASSTHROUGH_ACTIONS = new Set([
  "watch_recheck",
  "monitor_recheck"
]);

const REPEAT_LIMITED_ACTIONS = new Set(["release_monitor"]);
const AUTO_ACTION_REPEAT_LIMIT = 3;

export type ExecuteOpenClawSupervisorAutoActionInput = {
  dataDir: string;
  priorState: OpenClawSupervisorState | null;
  tick: OpenClawSupervisorTick;
  now: number;
  enabled: boolean;
};

export type ExecuteOpenClawSupervisorAutoActionResult = {
  tick: OpenClawSupervisorTick;
  autoAction: OpenClawSupervisorAutoActionResult | null;
};

export function openClawSupervisorAutoActionsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env["MOMENTUM_OPENCLAW_AUTO_ACTIONS"];
  if (value === undefined) return true;
  return !["0", "false", "off", "no", "disabled"].includes(
    value.trim().toLowerCase()
  );
}

export function executeOpenClawSupervisorAutoAction(
  input: ExecuteOpenClawSupervisorAutoActionInput
): ExecuteOpenClawSupervisorAutoActionResult {
  const policy = input.tick.recommendedActionPolicy;
  if (policy.authority !== "auto_allowed") {
    return { tick: input.tick, autoAction: null };
  }

  const actionType = policy.action;
  if (!SUPPORTED_AUTO_ACTIONS.has(actionType)) {
    const finalTick = failClosedAutoActionTick(input);
    const autoAction = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "skipped",
      error: "Unsupported auto-allowed supervisor action.",
      escalation: "human_required"
    });
    const persisted = appendRequiredAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
    return withRequiredAutoActionAuditResult(input, finalTick, persisted);
  }

  if (!input.enabled) {
    if (CONFIG_DISABLED_PASSTHROUGH_ACTIONS.has(actionType)) {
      return { tick: input.tick, autoAction: null };
    }
    const finalTick = failClosedAutoActionTick(input);
    const autoAction = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "skipped",
      error: "Supervisor auto-actions are disabled by configuration.",
      escalation: "human_required"
    });
    const persisted = appendRequiredAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
    return withRequiredAutoActionAuditResult(input, finalTick, persisted);
  }

  if (actionType === "release_monitor" && input.tick.cleanupAction !== "remove_monitor") {
    const finalTick = failClosedAutoActionTick(input);
    const autoAction = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "skipped",
      error: "Release monitor policy did not match a removable monitor.",
      escalation: "human_required"
    });
    const persisted = appendRequiredAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
    return withRequiredAutoActionAuditResult(input, finalTick, persisted);
  }

  let priorAuditRecords: OpenClawSupervisorAutoActionResult[] = [];
  try {
    priorAuditRecords = loadOpenClawSupervisorAutoActionAudit(
      input.dataDir,
      input.tick.runId
    );
  } catch {
    const finalTick = failClosedAutoActionTick(input);
    const autoAction = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "skipped",
      error: "Auto-action audit evidence is unreadable.",
      escalation: "human_required"
    });
    const persisted = appendRequiredAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
    return withRequiredAutoActionAuditResult(input, finalTick, persisted);
  }

  const repeatLimitHit = repeatLimitExceeded(
    priorAuditRecords,
    actionType,
    input.tick.digest
  );

  if (repeatLimitHit && input.priorState?.disabled === true) {
    return {
      tick: {
        ...input.tick,
        nextState: input.priorState,
        stateChanged: false
      },
      autoAction: null
    };
  }

  if (repeatLimitHit) {
    const finalTick = escalateAutoAction(input.tick);
    const autoAction = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "skipped",
      error: "Auto-action repeat limit exceeded.",
      escalation: "human_required"
    });
    const persisted = appendRequiredAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
    return withRequiredAutoActionAuditResult(input, finalTick, persisted);
  }

  const autoAction = buildAutoActionRecord({
    actionType,
    policy,
    priorState: input.priorState,
    tick: input.tick,
    now: input.now,
    result: "success",
    error: null,
    escalation: null
  });

  try {
    appendOpenClawSupervisorAutoActionAudit(
      input.dataDir,
      input.tick.runId,
      autoAction
    );
  } catch (error) {
    const finalTick = failClosedAutoActionAuditFailureTick(input);
    const failed = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: finalTick,
      now: input.now,
      result: "failed",
      error: error instanceof Error ? error.message : String(error),
      escalation: "human_required"
    });
    return {
      tick: withAutoAction(finalTick, failed),
      autoAction: failed
    };
  }

  const tick = {
    ...input.tick,
    autoAction
  };
  return { tick, autoAction };
}

export function recordOpenClawSupervisorAutoActionStatePersistence(
  dataDir: string,
  runId: string,
  record: OpenClawSupervisorAutoActionResult,
  statePersistence: "saved" | "failed"
): OpenClawSupervisorAutoActionResult | null {
  if (record.result !== "success") return null;
  return appendRequiredAutoActionAudit(dataDir, runId, {
    ...record,
    statePersistence
  });
}

export function withOpenClawSupervisorAutoActionResult(
  tick: OpenClawSupervisorTick,
  autoAction: OpenClawSupervisorAutoActionResult
): OpenClawSupervisorTick {
  if (autoAction.escalation !== "human_required") {
    return withAutoAction(tick, autoAction);
  }
  const baseTick =
    tick.suppressedReason === "monitor_disabled" &&
    autoAction.result !== "failed"
      ? tick
      : suppressAutoAction(tick);
  const escalationTick = stampAutoActionEscalationHumanUpdate({
    ...baseTick,
    emit: true,
    eventType: autoActionEscalationEventType(tick),
    recommendedActionPolicy: autoActionEscalationPolicy(tick)
  });
  const finalAutoAction =
    statesEqualForAutoAction(autoAction.afterState, escalationTick.nextState)
      ? autoAction
      : { ...autoAction, afterState: escalationTick.nextState };
  return withAutoAction(escalationTick, finalAutoAction);
}

export function loadOpenClawSupervisorAutoActionAudit(
  dataDir: string,
  runId: string
): OpenClawSupervisorAutoActionResult[] {
  const auditPath = openClawSupervisorAutoActionAuditPath(dataDir, runId);
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as unknown;
      if (!isOpenClawSupervisorAutoActionAuditRecord(record, runId)) {
        throw new Error("Invalid OpenClaw supervisor auto-action audit record.");
      }
      return record;
    });
}

function isOpenClawSupervisorAutoActionAuditRecord(
  value: unknown,
  runId: string
): value is OpenClawSupervisorAutoActionResult {
  if (!isObject(value)) return false;
  if (
    !(
      typeof value.actionType === "string" &&
      typeof value.policyAction === "string" &&
      typeof value.reason === "string" &&
      isStringOrNull(value.beforeDigest) &&
      typeof value.afterDigest === "string" &&
      isOpenClawSupervisorStateOrNull(value.beforeState, runId) &&
      isOpenClawSupervisorState(value.afterState, runId) &&
      typeof value.timestamp === "number" &&
      isAutoActionResult(value.result) &&
      isAutoActionStatePersistence(value.statePersistence) &&
      isStringOrNull(value.error) &&
      isAutoActionEscalation(value.escalation)
    )
  ) {
    return false;
  }
  return autoActionRecordDigestsMatchStates(
    value as OpenClawSupervisorAutoActionResult
  );
}

function autoActionRecordDigestsMatchStates(
  value: OpenClawSupervisorAutoActionResult
): boolean {
  return (
    value.beforeDigest === (value.beforeState?.lastDigest ?? null) &&
    value.afterDigest === value.afterState.lastDigest
  );
}

function isOpenClawSupervisorStateOrNull(
  value: unknown,
  runId: string
): value is OpenClawSupervisorState | null {
  return value === null || isOpenClawSupervisorState(value, runId);
}

function isOpenClawSupervisorState(
  value: unknown,
  runId: string
): value is OpenClawSupervisorState {
  if (!isObject(value)) return false;
  return (
    value.version === 1 &&
    value.runId === runId &&
    isStringOrNull(value.lastCursor) &&
    isStringOrNull(value.lastDigest) &&
    isStringOrNull(value.lastReason) &&
    (typeof value.lastHumanUpdateAt === "number" ||
      value.lastHumanUpdateAt === null) &&
    typeof value.disabled === "boolean" &&
    typeof value.updatedAt === "number"
  );
}

function isAutoActionResult(
  value: unknown
): value is OpenClawSupervisorAutoActionResult["result"] {
  return value === "success" || value === "skipped" || value === "failed";
}

function isAutoActionStatePersistence(
  value: unknown
): value is OpenClawSupervisorAutoActionResult["statePersistence"] {
  return (
    value === "pending" ||
    value === "saved" ||
    value === "failed" ||
    value === null
  );
}

function isAutoActionEscalation(
  value: unknown
): value is OpenClawSupervisorAutoActionResult["escalation"] {
  return value === "human_required" || value === null;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendOpenClawSupervisorAutoActionAudit(
  dataDir: string,
  runId: string,
  record: OpenClawSupervisorAutoActionResult
): void {
  const auditPath = openClawSupervisorAutoActionAuditPath(dataDir, runId);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, {
    mode: 0o600
  });
}

function appendAutoActionAuditBestEffort(
  dataDir: string,
  runId: string,
  record: OpenClawSupervisorAutoActionResult
): void {
  try {
    appendOpenClawSupervisorAutoActionAudit(dataDir, runId, record);
  } catch {
    // The caller is already escalating; never let evidence-write failure hide it.
  }
}

function appendRequiredAutoActionAudit(
  dataDir: string,
  runId: string,
  record: OpenClawSupervisorAutoActionResult
): OpenClawSupervisorAutoActionResult {
  try {
    appendOpenClawSupervisorAutoActionAudit(dataDir, runId, record);
    return record;
  } catch (error) {
    return {
      ...record,
      result: "failed",
      statePersistence: null,
      error: error instanceof Error ? error.message : String(error),
      escalation: "human_required"
    };
  }
}

function withRequiredAutoActionAuditResult(
  input: ExecuteOpenClawSupervisorAutoActionInput,
  tick: OpenClawSupervisorTick,
  record: OpenClawSupervisorAutoActionResult
): ExecuteOpenClawSupervisorAutoActionResult {
  if (record.result !== "failed") {
    return {
      tick: withAutoAction(tick, record),
      autoAction: record
    };
  }
  const auditFailureTick = failClosedAutoActionAuditFailureTick(input);
  const auditFailureRecord = {
    ...record,
    afterState: auditFailureTick.nextState
  };
  return {
    tick: withAutoAction(auditFailureTick, auditFailureRecord),
    autoAction: auditFailureRecord
  };
}

function repeatLimitExceeded(
  records: OpenClawSupervisorAutoActionResult[],
  actionType: string,
  digest: string
): boolean {
  if (!REPEAT_LIMITED_ACTIONS.has(actionType)) return false;
  const attemptStatuses = new Map<string, { saved: number; failed: number }>();
  for (const record of records) {
    if (
      record.actionType !== actionType ||
      record.afterDigest !== digest ||
      record.result !== "success" ||
      (record.statePersistence !== "saved" &&
        record.statePersistence !== "failed")
    ) {
      continue;
    }
    const key = autoActionAttemptKey(record);
    const status = attemptStatuses.get(key) ?? { saved: 0, failed: 0 };
    status[record.statePersistence] += 1;
    attemptStatuses.set(key, status);
  }
  const successfulStateSaves = [...attemptStatuses.values()].reduce(
    (count, status) => count + Math.max(0, status.saved - status.failed),
    0
  );
  return successfulStateSaves >= AUTO_ACTION_REPEAT_LIMIT;
}

function autoActionAttemptKey(record: OpenClawSupervisorAutoActionResult): string {
  return JSON.stringify({
    timestamp: record.timestamp,
    beforeDigest: record.beforeDigest,
    afterDigest: record.afterDigest,
    beforeUpdatedAt: record.beforeState?.updatedAt ?? null,
    afterUpdatedAt: record.afterState.updatedAt
  });
}

function buildAutoActionRecord(input: {
  actionType: string;
  policy: WorkflowActionAuthorityPolicy;
  priorState: OpenClawSupervisorState | null;
  tick: OpenClawSupervisorTick;
  now: number;
  result: OpenClawSupervisorAutoActionResult["result"];
  error: string | null;
  escalation: OpenClawSupervisorAutoActionResult["escalation"];
}): OpenClawSupervisorAutoActionResult {
  return {
    actionType: input.actionType,
    policyAction: input.policy.action,
    reason: input.tick.reason,
    beforeDigest: input.priorState?.lastDigest ?? null,
    afterDigest: input.tick.digest,
    beforeState: input.priorState,
    afterState: input.tick.nextState,
    timestamp: input.now,
    result: input.result,
    statePersistence: input.result === "success" ? "pending" : null,
    error: input.error,
    escalation: input.escalation
  };
}

function suppressAutoAction(tick: OpenClawSupervisorTick): OpenClawSupervisorTick {
  const nextState = {
    ...tick.nextState,
    disabled: false
  };
  const suppressed = {
    ...tick,
    cleanupAction: null,
    monitorEnabled: true,
    nextPollSeconds: tick.nextPollSeconds > 0 ? tick.nextPollSeconds : 30,
    nextState,
    stateChanged:
      tick.stateChanged || !statesEqualForAutoAction(tick.nextState, nextState),
    deliveryIntent: null
  };
  return {
    ...suppressed,
    deliveryIntent: buildOpenClawDeliveryIntent(suppressed)
  };
}

function stampAutoActionEscalationHumanUpdate(
  tick: OpenClawSupervisorTick
): OpenClawSupervisorTick {
  const nextState = {
    ...tick.nextState,
    lastHumanUpdateAt: tick.nextState.updatedAt
  };
  return {
    ...tick,
    nextState,
    stateChanged:
      tick.stateChanged || !statesEqualForAutoAction(tick.nextState, nextState)
  };
}

function withAutoAction(
  tick: OpenClawSupervisorTick,
  autoAction: OpenClawSupervisorAutoActionResult
): OpenClawSupervisorTick {
  const tickWithAutoAction = {
    ...tick,
    autoAction
  };
  return {
    ...tickWithAutoAction,
    deliveryIntent: buildOpenClawDeliveryIntent(tickWithAutoAction)
  };
}

function failClosedAutoActionTick(
  input: ExecuteOpenClawSupervisorAutoActionInput
): OpenClawSupervisorTick {
  return input.priorState?.disabled === true
    ? escalateDisabledAutoAction(input.tick)
    : escalateAutoAction(input.tick);
}

function failClosedAutoActionAuditFailureTick(
  input: ExecuteOpenClawSupervisorAutoActionInput
): OpenClawSupervisorTick {
  return escalateAutoAction(input.tick);
}

function escalateAutoAction(tick: OpenClawSupervisorTick): OpenClawSupervisorTick {
  const suppressed = suppressAutoAction(tick);
  const escalated = stampAutoActionEscalationHumanUpdate({
    ...suppressed,
    emit: true,
    eventType: autoActionEscalationEventType(tick),
    recommendedActionPolicy: autoActionEscalationPolicy(tick)
  });
  return {
    ...escalated,
    deliveryIntent: buildOpenClawDeliveryIntent(escalated)
  };
}

function escalateDisabledAutoAction(
  tick: OpenClawSupervisorTick
): OpenClawSupervisorTick {
  const escalated = stampAutoActionEscalationHumanUpdate({
    ...tick,
    emit: true,
    eventType: autoActionEscalationEventType(tick),
    recommendedActionPolicy: autoActionEscalationPolicy(tick)
  });
  return {
    ...escalated,
    deliveryIntent: buildOpenClawDeliveryIntent(escalated)
  };
}

function autoActionEscalationPolicy(
  tick: OpenClawSupervisorTick
): WorkflowActionAuthorityPolicy {
  return {
    ...tick.recommendedActionPolicy,
    authority: "human_required" as WorkflowActionAuthorityClass,
    risk: "high" as WorkflowActionRiskLevel,
    evidenceRequired: [
      ...tick.recommendedActionPolicy.evidenceRequired,
      "supported supervisor auto-action"
    ],
    rollback: "Keep the supervisor monitor registered until a human reviews the action.",
    rationale:
      "Supervisor auto-actions fail closed when local policy support is missing or ambiguous."
  };
}

function autoActionEscalationEventType(
  tick: OpenClawSupervisorTick
): OpenClawSupervisorEventType {
  if (tick.eventType !== null) return tick.eventType;
  if (
    tick.cleanupAction === "remove_monitor" ||
    tick.reason === "terminal_succeeded" ||
    tick.reason === "terminal_canceled"
  ) {
    return "terminal";
  }
  if (tick.reason === "stuck_risk") return "stuck-risk";
  if (
    tick.humanAction?.code === "clear_recovery" ||
    tick.recommendedAction === "recover" ||
    tick.reason === "recovery_required" ||
    tick.reason === "monitor_drift"
  ) {
    return "recovery";
  }
  if (
    tick.humanAction?.code === "approve" ||
    tick.humanAction?.code === "resolve_gate" ||
    tick.recommendedAction === "approve" ||
    tick.recommendedAction === "operator_decision" ||
    tick.reason === "awaiting_approval"
  ) {
    return "approval";
  }
  return "stuck-risk";
}

function statesEqualForAutoAction(
  left: OpenClawSupervisorState,
  right: OpenClawSupervisorState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function openClawSupervisorAutoActionAuditPath(
  dataDir: string,
  runId: string
): string {
  return path.join(
    dataDir,
    "openclaw-supervisor",
    `${encodeURIComponent(runId)}.auto-actions.jsonl`
  );
}
