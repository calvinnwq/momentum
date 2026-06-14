import { type DataDirOptions } from "../data-dir.js";
import { loadGoalLogs } from "../goal-logs.js";
import { loadGoalStatus } from "../goal-status.js";
import { writeHandoff } from "../handoff.js";
import { usageError, type CliIo } from "../renderers/cli-output.js";
import {
  emitHandoff,
  emitHandoffFailure,
  emitLogs,
  emitLogsFailure,
  emitStatusFailure,
  emitStatus
} from "../renderers/status.js";

type ParsedFlags = {
  args: string[];
  json: boolean;
  dataDir?: string;
  iteration?: number;
};

export function status(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (parsed.args.length > 2) {
    return usageError(`Unexpected argument for status: ${parsed.args[2]}`, parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: { goalId?: string; dataDirOptions: DataDirOptions } = {
    dataDirOptions
  };
  if (goalIdArg !== undefined) input.goalId = goalIdArg;

  const result = loadGoalStatus(input);

  if (!result.ok) {
    return emitStatusFailure(parsed, io, {
      code: result.code,
      message: result.error,
      goalId: goalIdArg ?? null
    });
  }

  return emitStatus(parsed, io, result);
}

export function logs(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for logs.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for logs: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: {
    goalId: string;
    iteration?: number;
    dataDirOptions: DataDirOptions;
  } = { goalId: goalIdArg, dataDirOptions };
  if (parsed.iteration !== undefined) input.iteration = parsed.iteration;

  const result = loadGoalLogs(input);

  if (!result.ok) {
    return emitLogsFailure(parsed, io, {
      code: result.code,
      message: result.error,
      goalId: goalIdArg
    });
  }

  return emitLogs(parsed, io, result);
}

export function handoff(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for handoff.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for handoff: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const result = writeHandoff({ goalId: goalIdArg, dataDirOptions });

  if (!result.ok) {
    return emitHandoffFailure(parsed, io, {
      code: result.code,
      message: result.error,
      goalId: goalIdArg
    });
  }

  return emitHandoff(parsed, io, result);
}
