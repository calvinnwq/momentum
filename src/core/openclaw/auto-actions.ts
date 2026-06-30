import fs from "node:fs";
import path from "node:path";

import type {
  OpenClawSupervisorAutoActionResult,
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
  if (!input.enabled) {
    if (actionType !== "release_monitor") {
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
    return {
      tick: withAutoAction(finalTick, persisted),
      autoAction: persisted
    };
  }

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
    return {
      tick: withAutoAction(finalTick, persisted),
      autoAction: persisted
    };
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
    return {
      tick: withAutoAction(finalTick, persisted),
      autoAction: persisted
    };
  }

  let repeatLimitHit = false;
  try {
    repeatLimitHit = repeatLimitExceeded(
      input.dataDir,
      input.tick.runId,
      actionType,
      input.tick.digest
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
    return {
      tick: withAutoAction(finalTick, persisted),
      autoAction: persisted
    };
  }

  if (repeatLimitHit && input.priorState?.disabled !== true) {
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
    return {
      tick: withAutoAction(finalTick, persisted),
      autoAction: persisted
    };
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
    const failed = buildAutoActionRecord({
      actionType,
      policy,
      priorState: input.priorState,
      tick: input.tick,
      now: input.now,
      result: "failed",
      error: error instanceof Error ? error.message : String(error),
      escalation: "human_required"
    });
    return {
      tick: withAutoAction(failClosedAutoActionTick(input), failed),
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
): void {
  if (record.result !== "success") return;
  appendAutoActionAuditBestEffort(dataDir, runId, {
    ...record,
    statePersistence
  });
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
    .map((line) => JSON.parse(line) as OpenClawSupervisorAutoActionResult);
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

function repeatLimitExceeded(
  dataDir: string,
  runId: string,
  actionType: string,
  digest: string
): boolean {
  if (!REPEAT_LIMITED_ACTIONS.has(actionType)) return false;
  const successes = loadOpenClawSupervisorAutoActionAudit(dataDir, runId).filter(
    (record) =>
      record.actionType === actionType &&
      record.afterDigest === digest &&
      record.result === "success" &&
      record.statePersistence === "saved"
  );
  return successes.length >= AUTO_ACTION_REPEAT_LIMIT;
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
    stateChanged: !statesEqualForAutoAction(tick.nextState, nextState),
    deliveryIntent: null
  };
  return {
    ...suppressed,
    deliveryIntent: buildOpenClawDeliveryIntent(suppressed)
  };
}

function withAutoAction(
  tick: OpenClawSupervisorTick,
  autoAction: OpenClawSupervisorAutoActionResult
): OpenClawSupervisorTick {
  return {
    ...tick,
    autoAction
  };
}

function failClosedAutoActionTick(
  input: ExecuteOpenClawSupervisorAutoActionInput
): OpenClawSupervisorTick {
  return input.priorState?.disabled === true
    ? input.tick
    : escalateAutoAction(input.tick);
}

function escalateAutoAction(tick: OpenClawSupervisorTick): OpenClawSupervisorTick {
  return {
    ...suppressAutoAction(tick),
    recommendedActionPolicy: {
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
    }
  };
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
