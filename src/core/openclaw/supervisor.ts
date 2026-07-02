import fs from "node:fs";
import path from "node:path";

import {
  buildOpenClawDeliveryIntent,
  type OpenClawDeliveryIntent
} from "./delivery-intent.js";
import type { WorkflowActionAuthorityPolicy } from "../workflow/monitor/action-authority.js";

export type OpenClawSupervisorEventType =
  | "progress"
  | "approval"
  | "recovery"
  | "stuck-risk"
  | "terminal";

export type OpenClawSupervisorSuppressedReason =
  | "watch_silent"
  | "heartbeat"
  | "duplicate_digest"
  | "not_human_worthy"
  | "monitor_disabled";

export type OpenClawSupervisorCleanupAction = "remove_monitor" | null;

export type OpenClawSupervisorHumanAction = {
  code: string;
  command: string;
  detail: string | null;
};

export type OpenClawSupervisorWatchEnvelope = {
  ok: true;
  command: "workflow run watch";
  mode: "once";
  runId: string;
  emit: boolean;
  reason: string;
  recommendedAction: string;
  recommendedActionPolicy: WorkflowActionAuthorityPolicy;
  nextPollSeconds: number;
  humanAction: OpenClawSupervisorHumanAction | null;
  cleanup: string;
  digest: string;
  cursor: string | null;
  phase: string;
  stuckRisk: string;
  inspectionCommand: string | null;
};

export type OpenClawSupervisorState = {
  version: 1;
  runId: string;
  lastCursor: string | null;
  lastDigest: string | null;
  lastReason: string | null;
  lastHumanUpdateAt: number | null;
  disabled: boolean;
  updatedAt: number;
};

export type OpenClawSupervisorAutoActionResult = {
  actionType: string;
  policyAction: string;
  reason: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  beforeState: OpenClawSupervisorState | null;
  afterState: OpenClawSupervisorState;
  timestamp: number;
  result: "success" | "skipped" | "failed";
  statePersistence: "pending" | "saved" | "failed" | null;
  error: string | null;
  escalation: "human_required" | null;
};

export type OpenClawSupervisorTick = {
  runId: string;
  emit: boolean;
  eventType: OpenClawSupervisorEventType | null;
  reason: string;
  digest: string;
  cursor: string | null;
  humanAction: OpenClawSupervisorHumanAction | null;
  recommendedAction: string;
  recommendedActionPolicy: WorkflowActionAuthorityPolicy;
  nextPollSeconds: number;
  stuckRisk: string;
  inspectionCommand: string | null;
  cleanupAction: OpenClawSupervisorCleanupAction;
  monitorEnabled: boolean;
  suppressedReason: OpenClawSupervisorSuppressedReason | null;
  nextState: OpenClawSupervisorState;
  stateChanged: boolean;
  watchEmit: boolean;
  deliveryIntent: OpenClawDeliveryIntent | null;
  autoAction: OpenClawSupervisorAutoActionResult | null;
};

export type BuildOpenClawSupervisorTickInput = {
  priorState: OpenClawSupervisorState | null;
  watch: OpenClawSupervisorWatchEnvelope;
  now: number;
};

export function buildOpenClawSupervisorTick(
  input: BuildOpenClawSupervisorTickInput
): OpenClawSupervisorTick {
  const { priorState, watch, now } = input;
  const eventType = classifyOpenClawSupervisorEvent(watch);
  const duplicate =
    priorState !== null &&
    priorState.lastDigest === watch.digest &&
    priorState.lastReason === watch.reason &&
    priorState.lastHumanUpdateAt !== null;
  const suppressedReason = selectSuppressedReason(watch, eventType, duplicate);
  const emit = suppressedReason === null;
  const canReleaseMonitor =
    watch.recommendedActionPolicy.action === "release_monitor" &&
    watch.recommendedActionPolicy.authority === "auto_allowed";
  const cleanupAction: OpenClawSupervisorCleanupAction =
    eventType === "terminal" && watch.cleanup === "release" && canReleaseMonitor
      ? "remove_monitor"
      : null;
  const monitorEnabled = cleanupAction === null;
  const nextState: OpenClawSupervisorState = {
    version: 1,
    runId: watch.runId,
    lastCursor: watch.cursor,
    lastDigest: watch.digest,
    lastReason: watch.reason,
    lastHumanUpdateAt: emit ? now : priorState?.lastHumanUpdateAt ?? null,
    disabled: !monitorEnabled,
    updatedAt: now
  };

  const tickWithoutIntent: Omit<OpenClawSupervisorTick, "deliveryIntent"> = {
    runId: watch.runId,
    emit,
    eventType: emit ? eventType : null,
    reason: watch.reason,
    digest: watch.digest,
    cursor: watch.cursor,
    humanAction: watch.humanAction,
    recommendedAction: watch.recommendedAction,
    recommendedActionPolicy: watch.recommendedActionPolicy,
    nextPollSeconds: watch.nextPollSeconds,
    stuckRisk: watch.stuckRisk,
    inspectionCommand: watch.inspectionCommand,
    cleanupAction,
    monitorEnabled,
    suppressedReason,
    nextState,
    stateChanged: !statesEqual(priorState, nextState),
    watchEmit: watch.emit,
    autoAction: null
  };
  return {
    ...tickWithoutIntent,
    deliveryIntent: buildOpenClawDeliveryIntent(tickWithoutIntent)
  };
}

export function buildOpenClawSupervisorDisabledTick(input: {
  runId: string;
  state: OpenClawSupervisorState;
  now: number;
}): OpenClawSupervisorTick {
  const nextState = { ...input.state, updatedAt: input.now };
  const tickWithoutIntent: Omit<OpenClawSupervisorTick, "deliveryIntent"> = {
    runId: input.runId,
    emit: false,
    eventType: null,
    reason: input.state.lastReason ?? "disabled",
    digest: input.state.lastDigest ?? "",
    cursor: input.state.lastCursor,
    humanAction: null,
    recommendedAction: "release",
    recommendedActionPolicy: {
      action: "release_monitor",
      authority: "auto_allowed",
      risk: "low",
      evidenceRequired: ["disabled OpenClaw supervisor state"],
      rollback: "Re-enable the external monitor if the run still needs polling.",
      rationale:
        "Disabled supervisor cleanup only removes the host monitor registration."
    },
    nextPollSeconds: 0,
    stuckRisk: "low",
    inspectionCommand: null,
    cleanupAction: "remove_monitor",
    monitorEnabled: false,
    suppressedReason: "monitor_disabled",
    nextState,
    stateChanged: !statesEqual(input.state, nextState),
    watchEmit: false,
    autoAction: null
  };
  return {
    ...tickWithoutIntent,
    deliveryIntent: buildOpenClawDeliveryIntent(tickWithoutIntent)
  };
}

export function loadOpenClawSupervisorState(
  dataDir: string,
  runId: string
): OpenClawSupervisorState | null {
  const statePath = openClawSupervisorStatePath(dataDir, runId);
  if (!fs.existsSync(statePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  return parseOpenClawSupervisorState(parsed, runId);
}

export function saveOpenClawSupervisorState(
  dataDir: string,
  state: OpenClawSupervisorState
): void {
  const statePath = openClawSupervisorStatePath(dataDir, state.runId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
}

function selectSuppressedReason(
  watch: OpenClawSupervisorWatchEnvelope,
  eventType: OpenClawSupervisorEventType | null,
  duplicate: boolean
): OpenClawSupervisorSuppressedReason | null {
  if (!watch.emit) return "watch_silent";
  const dueHumanAdvisory = isDueHumanAdvisory(watch, eventType);
  if (watch.reason === "quiet_heartbeat" && !dueHumanAdvisory) {
    return "heartbeat";
  }
  if (duplicate && !dueHumanAdvisory) return "duplicate_digest";
  if (eventType === null) return "not_human_worthy";
  return null;
}

function isDueHumanAdvisory(
  watch: OpenClawSupervisorWatchEnvelope,
  eventType: OpenClawSupervisorEventType | null
): boolean {
  return (
    watch.reason === "stuck_risk" ||
    (watch.reason === "quiet_heartbeat" &&
      (eventType === "approval" || eventType === "recovery"))
  );
}

function classifyOpenClawSupervisorEvent(
  watch: OpenClawSupervisorWatchEnvelope
): OpenClawSupervisorEventType | null {
  if (
    watch.cleanup === "release" ||
    watch.phase === "terminal" ||
    watch.reason === "terminal_succeeded" ||
    watch.reason === "terminal_canceled"
  ) {
    return "terminal";
  }
  if (watch.reason === "stuck_risk") return "stuck-risk";
  if (
    watch.humanAction?.code === "clear_recovery" ||
    watch.recommendedAction === "recover" ||
    watch.reason === "recovery_required" ||
    watch.reason === "monitor_drift"
  ) {
    return "recovery";
  }
  if (
    watch.humanAction?.code === "approve" ||
    watch.humanAction?.code === "resolve_gate" ||
    watch.recommendedAction === "approve" ||
    watch.recommendedAction === "operator_decision" ||
    watch.reason === "awaiting_approval"
  ) {
    return "approval";
  }
  if (watch.reason === "in_progress") return "progress";
  return null;
}

function openClawSupervisorStatePath(dataDir: string, runId: string): string {
  return path.join(
    dataDir,
    "openclaw-supervisor",
    `${encodeURIComponent(runId)}.json`
  );
}

function parseOpenClawSupervisorState(
  value: unknown,
  runId: string
): OpenClawSupervisorState {
  if (typeof value !== "object" || value === null) {
    throw new Error("OpenClaw supervisor state is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || record["runId"] !== runId) {
    throw new Error("OpenClaw supervisor state does not match this run.");
  }
  return {
    version: 1,
    runId,
    lastCursor: nullableString(record["lastCursor"], "lastCursor"),
    lastDigest: nullableString(record["lastDigest"], "lastDigest"),
    lastReason: nullableString(record["lastReason"], "lastReason"),
    lastHumanUpdateAt: nullableNumber(
      record["lastHumanUpdateAt"],
      "lastHumanUpdateAt"
    ),
    disabled: booleanValue(record["disabled"], "disabled"),
    updatedAt: numberValue(record["updatedAt"], "updatedAt")
  };
}

function statesEqual(
  left: OpenClawSupervisorState | null,
  right: OpenClawSupervisorState
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`OpenClaw supervisor state field ${field} is invalid.`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return numberValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`OpenClaw supervisor state field ${field} is invalid.`);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`OpenClaw supervisor state field ${field} is invalid.`);
}
