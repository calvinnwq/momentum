import { usageError, type CliIo } from "../../renderers/cli-output.js";
import { openDb } from "../../adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "../../config/data-dir.js";
import {
  getTrackerItemById,
  linkGoalToTrackerItem,
  listTrackerItems,
  unlinkGoalFromTrackerItem,
} from "../../core/tracker/items.js";
import { listTrackerReconciliationRuns } from "../../core/tracker/reconciliation-runs.js";
import {
  reconcileLinearTracker,
  type LinearReconciliationClient,
  type LinearReconciliationFilters,
  type ReconcileLinearTrackerInput,
  type ReconcileLinearTrackerResult,
} from "../../core/tracker/reconciliation.js";
import { buildLinearHttpReconciliationClient } from "../../adapters/linear-http-client.js";
import { LINEAR_API_KEY_ENV_VAR } from "../../core/intent/apply-execute.js";
import {
  emitTrackerFailure,
  emitTrackerGet,
  emitTrackerLink,
  emitTrackerList,
  emitTrackerReconcileFailure,
  emitTrackerReconcileResult,
  emitTrackerUnlink,
} from "../../renderers/tracker.js";
import { evaluateGoalForTrackerSatisfiedIntents } from "../../core/tracker/intent-generator.js";

export type LinearReconciliationClientFactoryInput = {
  apiKey: string | null;
  endpoint: string | null;
  pageSize: number | null;
  env: NodeJS.ProcessEnv;
};

export type CliDeps = {
  buildLinearReconciliationClient?: (
    input: LinearReconciliationClientFactoryInput,
  ) => LinearReconciliationClient;
};

type ParsedFlags = {
  args: string[];
  json: boolean;
  dataDir?: string;
  adapter?: string;
  project?: string;
  milestone?: string;
  linearEndpoint?: string;
  linearPageSize?: number;
  maxPages?: number;
  goal?: string;
  dryRun: boolean;
};

export function tracker(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps,
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for tracker. Expected: list, get, link, unlink, reconcile.",
      parsed,
      io,
    );
  }
  if (subcommand === "list") {
    return trackerList(parsed, io);
  }
  if (subcommand === "get") {
    return trackerGet(parsed, io);
  }
  if (subcommand === "link") {
    return trackerLink(parsed, io);
  }
  if (subcommand === "unlink") {
    return trackerUnlink(parsed, io);
  }
  if (subcommand === "reconcile") {
    return trackerReconcile(parsed, io, deps);
  }
  return usageError(`Unknown tracker subcommand: ${subcommand}`, parsed, io);
}

function trackerList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for tracker list: ${parsed.args[2]}`,
      parsed,
      io,
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitTrackerFailure(parsed, io, "tracker list", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const db = openDb(dataDir);
  let items: ReturnType<typeof listTrackerItems>;
  let lastReconciliation:
    ReturnType<typeof listTrackerReconciliationRuns>[number] | null;
  try {
    items = listTrackerItems(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter },
    );
    const runs = listTrackerReconciliationRuns(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter },
    );
    lastReconciliation =
      runs.length === 0 ? null : (runs[runs.length - 1] ?? null);
  } finally {
    db.close();
  }

  return emitTrackerList(parsed, io, {
    dataDir,
    adapter: parsed.adapter ?? null,
    items,
    lastReconciliation,
  });
}

function trackerGet(parsed: ParsedFlags, io: CliIo): number {
  const trackerItemId = parsed.args[2];
  if (!trackerItemId) {
    return usageError(
      "Missing required <tracker-item-id> for tracker get.",
      parsed,
      io,
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for tracker get: ${parsed.args[3]}`,
      parsed,
      io,
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitTrackerFailure(parsed, io, "tracker get", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const db = openDb(dataDir);
  let item: ReturnType<typeof getTrackerItemById>;
  try {
    item = getTrackerItemById(db, trackerItemId);
  } finally {
    db.close();
  }

  if (!item) {
    return emitTrackerFailure(parsed, io, "tracker get", {
      code: "tracker_item_not_found",
      message: `Tracker item not found: ${trackerItemId}`,
      trackerItemId,
      dataDir,
    });
  }

  return emitTrackerGet(parsed, io, { dataDir, item });
}

function trackerLink(parsed: ParsedFlags, io: CliIo): number {
  const trackerItemId = parsed.args[2];
  if (!trackerItemId) {
    return usageError(
      "Missing required <tracker-item-id> for tracker link.",
      parsed,
      io,
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for tracker link: ${parsed.args[3]}`,
      parsed,
      io,
    );
  }
  if (parsed.goal === undefined || parsed.goal.length === 0) {
    return usageError(
      "Missing required --goal <goal-id> for tracker link.",
      parsed,
      io,
    );
  }
  const goalId = parsed.goal;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitTrackerFailure(parsed, io, "tracker link", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const db = openDb(dataDir);
  try {
    const result = linkGoalToTrackerItem(db, { goalId, trackerItemId });
    if (!result.ok) {
      return emitTrackerFailure(parsed, io, "tracker link", {
        code: result.code,
        message: result.message,
        trackerItemId,
        goalId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir,
      });
    }
    const intentEvaluations = evaluateGoalForTrackerSatisfiedIntents(db, {
      goalId,
    });
    return emitTrackerLink(parsed, io, {
      dataDir,
      goalId,
      result,
      intentEvaluations,
    });
  } finally {
    db.close();
  }
}

function trackerUnlink(parsed: ParsedFlags, io: CliIo): number {
  const trackerItemId = parsed.args[2];
  if (!trackerItemId) {
    return usageError(
      "Missing required <tracker-item-id> for tracker unlink.",
      parsed,
      io,
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for tracker unlink: ${parsed.args[3]}`,
      parsed,
      io,
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitTrackerFailure(parsed, io, "tracker unlink", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const db = openDb(dataDir);
  try {
    const result = unlinkGoalFromTrackerItem(db, { trackerItemId });
    if (!result.ok) {
      return emitTrackerFailure(parsed, io, "tracker unlink", {
        code: result.code,
        message: result.message,
        trackerItemId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir,
      });
    }

    return emitTrackerUnlink(parsed, io, {
      dataDir,
      result,
    });
  } finally {
    db.close();
  }
}

const LINEAR_API_KEY_ENV = LINEAR_API_KEY_ENV_VAR;

async function trackerReconcile(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const adapterKind = parsed.args[2];
  if (!adapterKind) {
    return usageError(
      "Missing required <adapter> for tracker reconcile. Expected: linear.",
      parsed,
      io,
    );
  }
  if (adapterKind !== "linear") {
    return emitTrackerReconcileFailure(parsed, io, {
      code: "unsupported_tracker_adapter",
      message: `Tracker reconcile only supports the "linear" adapter; got "${adapterKind}".`,
    });
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for tracker reconcile linear: ${parsed.args[3]}`,
      parsed,
      io,
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitTrackerReconcileFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const env = io.env ?? {};
  const apiKey = (env[LINEAR_API_KEY_ENV] ?? "").trim();
  const factoryInput: LinearReconciliationClientFactoryInput = {
    apiKey: apiKey.length > 0 ? apiKey : null,
    endpoint: parsed.linearEndpoint ?? null,
    pageSize: parsed.linearPageSize ?? null,
    env,
  };
  const factory =
    deps.buildLinearReconciliationClient ??
    ((
      input: LinearReconciliationClientFactoryInput,
    ): LinearReconciliationClient => {
      const opts: {
        apiKey?: string | null;
        endpoint?: string;
        pageSize?: number;
      } = {
        apiKey: input.apiKey,
      };
      if (input.endpoint !== null) opts.endpoint = input.endpoint;
      if (input.pageSize !== null) opts.pageSize = input.pageSize;
      return buildLinearHttpReconciliationClient(opts);
    });

  let client: LinearReconciliationClient;
  try {
    client = factory(factoryInput);
  } catch (err) {
    return emitTrackerReconcileFailure(parsed, io, {
      code: "tracker_config_invalid",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind,
    });
  }

  const filters: LinearReconciliationFilters = {};
  if (parsed.project !== undefined) {
    if (
      /^[0-9a-f-]{8,}$/i.test(parsed.project) &&
      parsed.project.includes("-")
    ) {
      filters.projectId = parsed.project;
    } else {
      filters.projectName = parsed.project;
    }
  }
  if (parsed.milestone !== undefined) {
    if (
      /^[0-9a-f-]{8,}$/i.test(parsed.milestone) &&
      parsed.milestone.includes("-")
    ) {
      filters.milestoneId = parsed.milestone;
    } else {
      filters.milestoneName = parsed.milestone;
    }
  }

  const reconcileInput: ReconcileLinearTrackerInput = {
    client,
    filters,
    dryRun: parsed.dryRun,
  };
  if (parsed.maxPages !== undefined) reconcileInput.maxPages = parsed.maxPages;

  const db = openDb(dataDir);
  let result: ReconcileLinearTrackerResult;
  try {
    result = await reconcileLinearTracker(db, reconcileInput);
  } catch (err) {
    db.close();
    return emitTrackerReconcileFailure(parsed, io, {
      code: "tracker_adapter_threw",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind,
    });
  }
  db.close();

  return emitTrackerReconcileResult(parsed, io, {
    dataDir,
    adapter: adapterKind,
    filters,
    dryRun: parsed.dryRun,
    result,
  });
}
