import type {
  OpenClawSupervisorEventType,
  OpenClawSupervisorTick
} from "./supervisor.js";

const DISCORD_MESSAGE_MAX_LENGTH = 1800;
const TRUNCATION_SUFFIX = "... [truncated]";

export type OpenClawDeliveryIntentKind = Exclude<
  OpenClawSupervisorEventType,
  null
>;

export type OpenClawDeliveryIntentSeverity =
  | "info"
  | "action_required"
  | "warning"
  | "success"
  | "error";

export type OpenClawDeliveryIntentWake = {
  target: "openclaw";
  intent: "message" | "wake";
  reason: OpenClawDeliveryIntentKind;
};

export type OpenClawDeliveryIntentMessage = {
  platform: "discord";
  format: "plain_text";
  allowedMentions: "none";
  maxLength: 1800;
};

export type OpenClawDeliveryIntentAction = {
  command: string;
  evidence: string | null;
};

export type OpenClawDeliveryIntentCleanup = {
  action: "remove_monitor";
  hint: string;
};

export type OpenClawDeliveryIntentFailure = {
  retryable: true;
  logLevel: "warn";
  stateImpact: "none";
  retry: "repeat_openclaw_supervise";
};

export type OpenClawDeliveryIntent = {
  kind: OpenClawDeliveryIntentKind;
  severity: OpenClawDeliveryIntentSeverity;
  text: string;
  action: OpenClawDeliveryIntentAction | null;
  wake: OpenClawDeliveryIntentWake;
  message: OpenClawDeliveryIntentMessage;
  dedupeKey: string;
  reminderKey: string | null;
  cleanup: OpenClawDeliveryIntentCleanup | null;
  failure: OpenClawDeliveryIntentFailure;
};

type OpenClawDeliveryIntentInput = Omit<
  OpenClawSupervisorTick,
  "deliveryIntent"
> & {
  deliveryIntent?: OpenClawDeliveryIntent | null;
};

export function buildOpenClawDeliveryIntent(
  tick: OpenClawDeliveryIntentInput
): OpenClawDeliveryIntent | null {
  if (!tick.emit || tick.eventType === null) return null;

  const kind = tick.eventType;
  const action = deliveryAction(tick, kind);
  const reminder = reminderKey(tick, kind);
  return {
    kind,
    severity: deliverySeverity(tick, kind),
    text: clampDiscordText(deliveryText(tick, kind, action)),
    action,
    wake: {
      target: "openclaw",
      intent: shouldWakeAgentLane(kind) ? "wake" : "message",
      reason: kind
    },
    message: {
      platform: "discord",
      format: "plain_text",
      allowedMentions: "none",
      maxLength: DISCORD_MESSAGE_MAX_LENGTH
    },
    dedupeKey: deliveryDedupeKey(tick, reminder),
    reminderKey: reminder,
    cleanup:
      tick.cleanupAction === "remove_monitor"
        ? {
            action: "remove_monitor",
            hint:
              "Stop polling this run and remove the external monitor registration."
          }
        : null,
    failure: {
      retryable: true,
      logLevel: "warn",
      stateImpact: "none",
      retry: "repeat_openclaw_supervise"
    }
  };
}

function deliverySeverity(
  tick: OpenClawDeliveryIntentInput,
  kind: OpenClawDeliveryIntentKind
): OpenClawDeliveryIntentSeverity {
  if (tick.autoAction?.escalation === "human_required") {
    return "action_required";
  }
  switch (kind) {
    case "progress":
      return "info";
    case "approval":
    case "recovery":
      return "action_required";
    case "stuck-risk":
      return "warning";
    case "terminal":
      return tick.reason === "terminal_succeeded" ? "success" : "error";
  }
}

function deliveryAction(
  tick: OpenClawDeliveryIntentInput,
  kind: OpenClawDeliveryIntentKind
): OpenClawDeliveryIntentAction | null {
  if (kind === "approval" || kind === "recovery") {
    if (tick.humanAction === null) return null;
    return {
      command: tick.humanAction.command,
      evidence: tick.humanAction.detail
    };
  }
  if (kind === "stuck-risk" && tick.inspectionCommand !== null) {
    return {
      command: tick.inspectionCommand,
      evidence: `stuckRisk=${tick.stuckRisk}`
    };
  }
  return null;
}

function deliveryText(
  tick: OpenClawDeliveryIntentInput,
  kind: OpenClawDeliveryIntentKind,
  action: OpenClawDeliveryIntentAction | null
): string {
  if (tick.autoAction?.escalation === "human_required") {
    return oneLine(
      `Human review required for ${tick.runId}: OpenClaw supervisor auto-action ${tick.autoAction.actionType} did not complete.`
    );
  }
  switch (kind) {
    case "progress":
      return oneLine(
        `${tick.runId} is progressing. Next check in ${tick.nextPollSeconds}s.`
      );
    case "approval":
      return oneLine(
        action === null
          ? `Approval needed for ${tick.runId}.`
          : `Approval needed for ${tick.runId}. Run: ${action.command}`
      );
    case "recovery":
      return oneLine(
        action === null
          ? `Recovery evidence needed for ${tick.runId}.`
          : `Recovery evidence needed for ${tick.runId}. Evidence: ${withoutTerminalPeriod(action.evidence ?? "required")}. Safe command: ${action.command}`
      );
    case "stuck-risk":
      return oneLine(
        action === null
          ? `Stuck risk is ${tick.stuckRisk} for ${tick.runId}.`
          : `Stuck risk is ${tick.stuckRisk} for ${tick.runId}. Inspect: ${action.command}`
      );
    case "terminal":
      return oneLine(
        tick.reason === "terminal_succeeded"
          ? `${tick.runId} finished successfully.${terminalCleanupText(tick)}`
          : `${tick.runId} finished with terminal status ${tick.reason}.${terminalCleanupText(tick)}`
      );
  }
}

function terminalCleanupText(tick: OpenClawDeliveryIntentInput): string {
  return tick.cleanupAction === "remove_monitor"
    ? " Remove the OpenClaw monitor."
    : "";
}

function shouldWakeAgentLane(kind: OpenClawDeliveryIntentKind): boolean {
  return kind === "approval" || kind === "recovery" || kind === "stuck-risk";
}

function reminderKey(
  tick: OpenClawDeliveryIntentInput,
  kind: OpenClawDeliveryIntentKind
): string | null {
  if (
    kind !== "approval" &&
    kind !== "recovery" &&
    kind !== "stuck-risk"
  ) {
    return null;
  }
  if (tick.reason !== "quiet_heartbeat" && tick.reason !== "stuck_risk") {
    return kind === "recovery"
      ? `openclaw-reminder:${tick.runId}:recovery`
      : null;
  }
  return `openclaw-reminder:${tick.runId}:${kind}`;
}

function deliveryDedupeKey(
  tick: OpenClawDeliveryIntentInput,
  reminder: string | null
): string {
  const base = `openclaw-delivery:${tick.runId}:${tick.reason}:${tick.digest}`;
  if (reminder === null || !isRepeatableReminderReason(tick.reason)) {
    return base;
  }
  return `${base}:${tick.nextState.lastHumanUpdateAt ?? tick.nextState.updatedAt}`;
}

function isRepeatableReminderReason(reason: string): boolean {
  return reason === "quiet_heartbeat" || reason === "stuck_risk";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function withoutTerminalPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function clampDiscordText(value: string): string {
  if (value.length <= DISCORD_MESSAGE_MAX_LENGTH) return value;
  return `${value.slice(
    0,
    DISCORD_MESSAGE_MAX_LENGTH - TRUNCATION_SUFFIX.length
  )}${TRUNCATION_SUFFIX}`;
}
