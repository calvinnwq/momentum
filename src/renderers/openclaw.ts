import {
  write,
  writeJson,
  type CliIo
} from "./cli-output.js";
import type { OpenClawSupervisorTick } from "../core/openclaw/supervisor.js";

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
    nextPollSeconds: tick.nextPollSeconds,
    humanAction: tick.humanAction,
    stuckRisk: tick.stuckRisk,
    inspectionCommand,
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
  lines.push("");
  return lines.join("\n");
}

function sanitizeInspectionCommand(
  command: string | null,
  runId: string
): string | null {
  if (command === null) return null;
  if (!/(^|\s)--data-dir(?:=|\s|$)/.test(command)) return command;
  return `momentum workflow run monitor ${shellQuote(runId)} --data-dir <data-dir> --advance --json`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
