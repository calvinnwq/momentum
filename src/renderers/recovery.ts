import type { ClearGoalManualRecoveryGuardedResult } from "../core/goal/recovery.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export function emitRecoveryClearDataDirFailure(
  parsed: JsonFlags,
  io: CliIo,
  failure: { goalId: string; message: string }
): number {
  const payload = {
    ok: false,
    command: "recovery clear",
    code: "data_dir_failed",
    message: failure.message,
    goalId: failure.goalId
  };
  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${payload.message}\n`);
  return 1;
}

export function emitRecoveryClear(
  parsed: JsonFlags,
  io: CliIo,
  dataDir: string,
  goalId: string,
  result: ClearGoalManualRecoveryGuardedResult
): number {
  if (!result.ok) {
    const payload: Record<string, unknown> = {
      ok: false,
      command: "recovery clear",
      code: result.reason,
      message: result.message,
      goalId,
      dataDir
    };
    if (result.reason === "job_active" && result.activeJobIds) {
      payload["activeJobIds"] = result.activeJobIds;
    }
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.message}\n`);
    return 1;
  }

  const payload = {
    ok: true,
    command: "recovery clear",
    goalId: result.goalId,
    dataDir,
    previousReason: result.previousReason,
    previousMarkedAt: result.previousMarkedAt,
    clearedAt: result.clearedAt,
    eventId: result.eventId
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Manual recovery cleared for goal: ${result.goalId}`,
    `Previous reason: ${result.previousReason ?? "(unset)"}`,
    `Previous marked at: ${result.previousMarkedAt ?? "(unset)"}`,
    `Cleared at: ${result.clearedAt}`,
    `Event id: ${result.eventId}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}
