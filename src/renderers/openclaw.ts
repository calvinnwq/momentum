import {
  write,
  writeJson,
  type CliIo
} from "./cli-output.js";
import type { OpenClawDeliveryIntent } from "../core/openclaw/delivery-intent.js";
import type { OpenClawSupervisorTick } from "../core/openclaw/supervisor.js";

const TRUNCATION_SUFFIX = "... [truncated]";

export type OpenClawRendererFailure = {
  code: string;
  message: string;
  runId?: string;
  exitCode?: number;
};

export type OpenClawRendererStatePersistence = "saved" | "failed";

export function emitOpenClawSupervise(
  parsed: { json: boolean },
  io: CliIo,
  tick: OpenClawSupervisorTick,
  options: { statePersistence?: OpenClawRendererStatePersistence } = {}
): number {
  const statePersistence = options.statePersistence ?? "saved";
  const inspectionCommand = sanitizeInspectionCommand(
    tick.inspectionCommand,
    tick.runId
  );
  const deliveryIntent = sanitizeDeliveryIntent(
    tick.deliveryIntent,
    tick.runId
  );
  const payload = {
    ok: true,
    command: "openclaw supervise",
    mode: "once",
    runId: tick.runId,
    emit: tick.emit,
    eventType: tick.eventType,
    reason: tick.reason,
    digest: tick.digest,
    cursor: tick.cursor,
    recommendedAction: tick.recommendedAction,
    recommendedActionPolicy: tick.recommendedActionPolicy,
    nextPollSeconds: tick.nextPollSeconds,
    humanAction: tick.humanAction,
    stuckRisk: tick.stuckRisk,
    inspectionCommand,
    deliveryIntent,
    monitorEnabled: tick.monitorEnabled,
    cleanupAction: tick.cleanupAction,
    state: {
      version: tick.nextState.version,
      lastCursor: tick.nextState.lastCursor,
      lastDigest: tick.nextState.lastDigest,
      lastReason: tick.nextState.lastReason,
      lastHumanUpdateAt: tick.nextState.lastHumanUpdateAt,
      disabled: tick.nextState.disabled,
      updatedAt: tick.nextState.updatedAt,
      persisted: statePersistence === "saved"
    },
    debug: {
      watchEmit: tick.watchEmit,
      suppressedReason: tick.suppressedReason,
      stateChanged: tick.stateChanged,
      statePersistence
    }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderOpenClawSuperviseText(tick, statePersistence));
  return 0;
}

export function emitOpenClawSuperviseFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: OpenClawRendererFailure
): number {
  const payload = {
    ok: false,
    command: "openclaw supervise",
    code: failure.code,
    message: failure.message,
    runId: failure.runId ?? null
  };
  const exitCode = failure.exitCode ?? 1;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return exitCode;
  }

  write(io.stderr, `${failure.message}\n`);
  return exitCode;
}

function renderOpenClawSuperviseText(
  tick: OpenClawSupervisorTick,
  statePersistence: OpenClawRendererStatePersistence
): string {
  const inspectionCommand = sanitizeInspectionCommand(
    tick.inspectionCommand,
    tick.runId
  );
  const lines = [
    `OpenClaw supervise: ${tick.runId}`,
    `Mode: once`,
    `Emit: ${tick.emit}`,
    `Event type: ${tick.eventType ?? "(none)"}`,
    `Reason: ${tick.reason}`,
    `Recommended action: ${tick.recommendedAction}`,
    `Next poll seconds: ${tick.nextPollSeconds}`,
    `Monitor enabled: ${tick.monitorEnabled}`,
    `Cleanup action: ${tick.cleanupAction ?? "(none)"}`,
    `Digest: ${tick.digest}`,
    `Suppressed reason: ${tick.suppressedReason ?? "(none)"}`,
    `State persistence: ${statePersistence}`
  ];
  if (tick.humanAction !== null) {
    lines.push(`Human action: ${tick.humanAction.command}`);
    if (tick.humanAction.detail !== null) {
      lines.push(`Human action detail: ${tick.humanAction.detail}`);
    }
  }
  if (inspectionCommand !== null) {
    lines.push(`Inspection command: ${inspectionCommand}`);
  }
  const deliveryIntent = sanitizeDeliveryIntent(
    tick.deliveryIntent,
    tick.runId
  );
  if (deliveryIntent !== null) {
    lines.push(
      `Delivery intent: ${deliveryIntent.kind} (${deliveryIntent.severity})`,
      `Delivery text: ${deliveryIntent.text}`,
      `Delivery dedupe key: ${deliveryIntent.dedupeKey}`,
      `Delivery retry: ${deliveryIntent.failure.retry}`
    );
    if (deliveryIntent.action !== null) {
      lines.push(`Delivery action: ${deliveryIntent.action.command}`);
    }
    if (deliveryIntent.cleanup !== null) {
      lines.push(`Delivery cleanup: ${deliveryIntent.cleanup.action}`);
    }
  } else {
    lines.push("Delivery intent: (none)");
  }
  lines.push("");
  return lines.join("\n");
}

function sanitizeDeliveryIntent(
  intent: OpenClawDeliveryIntent | null,
  runId: string
): OpenClawDeliveryIntent | null {
  if (intent === null) return null;
  const action =
    intent.action === null
      ? null
      : {
          ...intent.action,
          command: sanitizeDeliveryCommand(
            intent.action.command,
            runId,
            intent.kind
          )
        };
  return {
    ...intent,
    text: sanitizeDeliveryText(intent, action, runId),
    action
  };
}

function sanitizeDeliveryText(
  original: OpenClawDeliveryIntent,
  action: OpenClawDeliveryIntent["action"],
  runId: string
): string {
  let text = original.text;
  if (action !== null) {
    switch (original.kind) {
      case "approval":
        text = `Approval needed for ${runId}. Run: ${action.command}`;
        break;
      case "recovery":
        text = `Recovery evidence needed for ${runId}. Evidence: ${withoutTerminalPeriod(action.evidence ?? "required")}. Safe command: ${action.command}`;
        break;
      case "stuck-risk":
        text = `Stuck risk is ${stuckRiskEvidence(action.evidence)} for ${runId}. Inspect: ${action.command}`;
        break;
      case "progress":
      case "terminal":
        text = original.text;
        break;
    }
  }
  return clampDeliveryText(
    sanitizeCommand(text),
    original.message.maxLength
  );
}

function sanitizeDeliveryCommand(
  command: string,
  runId: string,
  kind: OpenClawDeliveryIntent["kind"]
): string {
  if (kind === "stuck-risk") {
    return sanitizeInspectionCommand(command, runId) ?? command;
  }
  return sanitizeCommand(command);
}

function sanitizeInspectionCommand(
  command: string | null,
  runId: string
): string | null {
  if (command === null) return null;
  if (!/(^|\s)--data-dir(?:=|\s|$)/.test(command)) return command;
  return `momentum workflow run monitor ${shellQuote(runId)} --data-dir <data-dir> --advance --json`;
}

function sanitizeCommand(command: string): string {
  return command.replace(
    /--data-dir(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g,
    "--data-dir <data-dir>"
  );
}

function stuckRiskEvidence(evidence: string | null): string {
  const prefix = "stuckRisk=";
  if (evidence?.startsWith(prefix)) return evidence.slice(prefix.length);
  return "unknown";
}

function withoutTerminalPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function clampDeliveryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
