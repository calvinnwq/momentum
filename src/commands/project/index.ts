import { usageError, type CliIo } from "../../renderers/cli-output.js";
import { openDb } from "../../adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  buildProjectRollup,
  type ProjectRollup,
  type ProjectRollupFilters,
  type ProjectRollupOptions
} from "../../project-rollup.js";
import {
  emitProjectStatusFailure,
  emitProjectStatusSuccess
} from "../../renderers/project.js";

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; source?: string; project?: string; staleThresholdHours?: number; intentStaleThresholdDays?: number; limit?: number; milestone?: string;
};

export function project(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for project. Expected: status.",
      parsed,
      io
    );
  }
  if (subcommand === "status") {
    return projectStatus(parsed, io);
  }
  return usageError(`Unknown project subcommand: ${subcommand}`, parsed, io);
}

function projectStatus(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for project status: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitProjectStatusFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const filters: ProjectRollupFilters = {};
  if (parsed.source !== undefined) filters.adapterKind = parsed.source;
  if (parsed.project !== undefined) {
    filters.projectId = parsed.project;
    filters.projectName = parsed.project;
  }
  if (parsed.milestone !== undefined) {
    filters.milestoneId = parsed.milestone;
    filters.milestoneName = parsed.milestone;
  }

  const options: ProjectRollupOptions = { filters };
  if (parsed.staleThresholdHours !== undefined) {
    options.reconciliationStaleThresholdMs = Math.round(
      parsed.staleThresholdHours * 60 * 60 * 1000
    );
  }
  if (parsed.intentStaleThresholdDays !== undefined) {
    options.intentStaleThresholdMs = Math.round(
      parsed.intentStaleThresholdDays * 24 * 60 * 60 * 1000
    );
  }

  const db = openDb(dataDir);
  let rollup: ProjectRollup;
  try {
    rollup = buildProjectRollup(db, options);
  } finally {
    db.close();
  }

  return emitProjectStatusSuccess(parsed, io, { dataDir, filters, rollup });
}
