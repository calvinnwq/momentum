import { runOpenClawWorkflowWatchOnce } from "../../adapters/openclaw-watch-runner.js";
import type { OpenClawWatchOnce } from "../../adapters/openclaw-watch-runner.js";
import { resolveDataDir, type DataDirOptions } from "../../config/data-dir.js";
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
    if (priorState?.disabled) {
      const disabledTick = buildOpenClawSupervisorDisabledTick({
        runId,
        state: priorState,
        now: Date.now()
      });
      saveOpenClawSupervisorState(dataDir, disabledTick.nextState);
      return emitOpenClawSupervise(parsed, io, disabledTick);
    }

    const watchOnce = deps.openClawWatchOnce ?? runOpenClawWorkflowWatchOnce;
    const watchInput: Parameters<typeof watchOnce>[0] = {
      runId,
      dataDir
    };
    if (io.env !== undefined) watchInput.env = io.env;
    const watch = await watchOnce(watchInput);
    const tick = buildOpenClawSupervisorTick({
      priorState,
      watch,
      now: Date.now()
    });
    saveOpenClawSupervisorState(dataDir, tick.nextState);
    return emitOpenClawSupervise(parsed, io, tick);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "openclaw_supervisor_failed";
    return emitOpenClawSuperviseFailure(parsed, io, {
      code,
      message: error instanceof Error ? error.message : String(error),
      runId
    });
  }
}
