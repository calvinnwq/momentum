import {
  OpenClawWatchRunnerError,
  runOpenClawWorkflowWatchOnce
} from "../../adapters/openclaw-watch-runner.js";
import type { OpenClawWatchOnce } from "../../adapters/openclaw-watch-runner.js";
import { resolveDataDir, type DataDirOptions } from "../../config/data-dir.js";
import {
  executeOpenClawSupervisorAutoAction,
  openClawSupervisorAutoActionsEnabled,
  recordOpenClawSupervisorAutoActionStatePersistence
} from "../../core/openclaw/auto-actions.js";
import {
  buildOpenClawSupervisorDisabledTick,
  buildOpenClawSupervisorTick,
  loadOpenClawSupervisorState,
  saveOpenClawSupervisorState
} from "../../core/openclaw/supervisor.js";
import {
  emitOpenClawSupervise,
  emitOpenClawSuperviseFailure
} from "../../renderers/openclaw.js";
import {
  emitHelp,
  usageError,
  type CliIo
} from "../../renderers/cli-output.js";

type ParsedFlags = {
  args: string[];
  json: boolean;
  once?: boolean;
  stream?: boolean;
  jsonl?: boolean;
  dataDir?: string;
};

export type OpenClawCommandDeps = {
  openClawWatchOnce?: OpenClawWatchOnce;
};

export function openclaw(
  parsed: ParsedFlags,
  io: CliIo,
  deps: OpenClawCommandDeps = {}
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (parsed.args.includes("--help") || parsed.args.includes("-h")) {
    return emitHelp(io);
  }
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for openclaw. Expected: supervise.",
      parsed,
      io
    );
  }
  if (subcommand === "supervise") {
    return openClawSupervise(parsed, io, deps);
  }
  return usageError(`Unknown openclaw subcommand: ${subcommand}`, parsed, io);
}

async function openClawSupervise(
  parsed: ParsedFlags,
  io: CliIo,
  deps: OpenClawCommandDeps
): Promise<number> {
  const positional = parsed.args.slice(2);
  if (positional.length === 0 || !positional[0]) {
    return emitOpenClawSuperviseFailure(parsed, io, {
      code: "run_id_required",
      message: "Missing required <run-id> for openclaw supervise."
    });
  }
  if (positional.length > 1) {
    return usageError(
      `Unexpected argument for openclaw supervise: ${positional[1]}`,
      parsed,
      io
    );
  }
  const runId = positional[0];
  if (parsed.stream || parsed.jsonl || !parsed.once) {
    return emitOpenClawSuperviseFailure(parsed, io, {
      code: "once_required",
      message:
        "openclaw supervise currently requires cron-safe --once mode.",
      runId
    });
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (error) {
    return emitOpenClawSuperviseFailure(parsed, io, {
      code: "data_dir_failed",
      message: error instanceof Error ? error.message : String(error),
      runId
    });
  }

  try {
    const priorState = loadOpenClawSupervisorState(dataDir, runId);
    const autoActionsEnabled = openClawSupervisorAutoActionsEnabled(io.env);
    if (priorState?.disabled) {
      const now = Date.now();
      const disabledTick = buildOpenClawSupervisorDisabledTick({
        runId,
        state: priorState,
        now
      });
      const autoActionResult = executeOpenClawSupervisorAutoAction({
        dataDir,
        priorState,
        tick: disabledTick,
        now,
        enabled: autoActionsEnabled
      });
      if (autoActionResult.autoAction?.result === "failed") {
        return emitOpenClawSupervise(parsed, io, autoActionResult.tick, {
          statePersistence: "failed"
        });
      }
      try {
        saveOpenClawSupervisorState(dataDir, autoActionResult.tick.nextState);
        if (autoActionResult.autoAction !== null) {
          recordOpenClawSupervisorAutoActionStatePersistence(
            dataDir,
            runId,
            autoActionResult.autoAction,
            "saved"
          );
        }
        return emitOpenClawSupervise(parsed, io, autoActionResult.tick);
      } catch {
        if (autoActionResult.autoAction !== null) {
          recordOpenClawSupervisorAutoActionStatePersistence(
            dataDir,
            runId,
            autoActionResult.autoAction,
            "failed"
          );
        }
        return emitOpenClawSupervise(parsed, io, autoActionResult.tick, {
          statePersistence: "failed"
        });
      }
    }

    const watchOnce = deps.openClawWatchOnce ?? runOpenClawWorkflowWatchOnce;
    const watchInput: Parameters<typeof watchOnce>[0] = {
      runId,
      dataDir
    };
    if (io.env !== undefined) watchInput.env = io.env;
    const watch = await watchOnce(watchInput);
    const now = Date.now();
    const tick = buildOpenClawSupervisorTick({
      priorState,
      watch,
      now
    });
    const autoActionResult = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState,
      tick,
      now,
      enabled: autoActionsEnabled
    });
    if (autoActionResult.autoAction?.result === "failed") {
      return emitOpenClawSupervise(parsed, io, autoActionResult.tick, {
        statePersistence: "failed"
      });
    }
    try {
      saveOpenClawSupervisorState(dataDir, autoActionResult.tick.nextState);
      if (autoActionResult.autoAction !== null) {
        recordOpenClawSupervisorAutoActionStatePersistence(
          dataDir,
          runId,
          autoActionResult.autoAction,
          "saved"
        );
      }
      return emitOpenClawSupervise(parsed, io, autoActionResult.tick);
    } catch (saveError) {
      if (autoActionResult.autoAction !== null) {
        recordOpenClawSupervisorAutoActionStatePersistence(
          dataDir,
          runId,
          autoActionResult.autoAction,
          "failed"
        );
      }
      if (
        autoActionResult.tick.emit ||
        autoActionResult.tick.cleanupAction === "remove_monitor" ||
        autoActionResult.autoAction?.escalation !== null
      ) {
        return emitOpenClawSupervise(parsed, io, autoActionResult.tick, {
          statePersistence: "failed"
        });
      }
      throw saveError;
    }
  } catch (error) {
    const code = openClawFailureCode(error);
    return emitOpenClawSuperviseFailure(parsed, io, {
      code,
      message: openClawFailureMessage(error, code, dataDir),
      runId
    });
  }
}

function openClawFailureCode(error: unknown): string {
  if (error instanceof OpenClawWatchRunnerError) return error.code;
  return "openclaw_supervisor_failed";
}

function openClawFailureMessage(
  error: unknown,
  code: string,
  dataDir: string
): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (containsUnsafePath(raw, dataDir)) {
    return genericOpenClawFailureMessage(code);
  }
  return raw;
}

function containsUnsafePath(message: string, dataDir: string): boolean {
  if (dataDir.length > 0 && message.includes(dataDir)) return true;
  const normalized = message.replaceAll("\\", "/");
  return /(^|[\s'"])(\/(?!\/)[^\s'"]+)/.test(normalized) ||
    /[A-Za-z]:\//.test(normalized);
}

function genericOpenClawFailureMessage(code: string): string {
  switch (code) {
    case "data_dir_failed":
      return "Momentum data directory is unavailable.";
    case "watch_parse_failed":
      return "Momentum watch returned an invalid response.";
    case "watch_spawn_failed":
      return "Momentum watch could not be started.";
    case "watch_failed":
      return "Momentum watch failed.";
    case "run_not_found":
      return "Workflow run was not found.";
    case "watch_unsupported_source":
      return "Workflow watch is not supported for this run source.";
    default:
      return "OpenClaw supervisor failed while processing the run.";
  }
}
