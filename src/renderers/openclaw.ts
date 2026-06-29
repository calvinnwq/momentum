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

export function emitOpenClawSupervise(
  parsed: { json: boolean },
  io: CliIo,
  tick: OpenClawSupervisorTick
): number {
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
    inspectionCommand: tick.inspectionCommand,
    monitorEnabled: tick.monitorEnabled,
    cleanupAction: tick.cleanupAction,
    state: {
      version: tick.nextState.version,
      lastCursor: tick.nextState.lastCursor,
      lastDigest: tick.nextState.lastDigest,
      lastReason: tick.nextState.lastReason,
      lastHumanUpdateAt: tick.nextState.lastHumanUpdateAt,
      disabled: tick.nextState.disabled,
      updatedAt: tick.nextState.updatedAt
    },
    debug: {
      watchEmit: tick.watchEmit,
      suppressedReason: tick.suppressedReason,
      stateChanged: tick.stateChanged
    }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderOpenClawSuperviseText(tick));
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

function renderOpenClawSuperviseText(tick: OpenClawSupervisorTick): string {
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
    `Suppressed reason: ${tick.suppressedReason ?? "(none)"}`
  ];
  if (tick.humanAction !== null) {
    lines.push(`Human action: ${tick.humanAction.command}`);
    if (tick.humanAction.detail !== null) {
      lines.push(`Human action detail: ${tick.humanAction.detail}`);
    }
  }
  if (tick.inspectionCommand !== null) {
    lines.push(`Inspection command: ${tick.inspectionCommand}`);
  }
  lines.push("");
  return lines.join("\n");
}
