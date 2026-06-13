import { usageError, type CliIo } from "../../renderers/cli-output.js";
import { openDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  getSourceItemById,
  linkGoalToSourceItem,
  listSourceItems,
  unlinkGoalFromSourceItem
} from "../../source-items.js";
import { listSourceReconciliationRuns } from "../../source-reconciliation-runs.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFilters,
  type ReconcileLinearSourceInput,
  type ReconcileLinearSourceResult
} from "../../source-reconciliation.js";
import { buildLinearHttpReconciliationClient } from "../../linear-http-client.js";
import { LINEAR_API_KEY_ENV_VAR } from "../../intent-apply-execute.js";
import {
  emitSourceFailure,
  emitSourceGet,
  emitSourceLink,
  emitSourceList,
  emitSourceReconcileFailure,
  emitSourceReconcileResult,
  emitSourceUnlink
} from "../../renderers/source.js";
import {
  evaluateGoalForSourceSatisfiedIntents
} from "../../update-intent-generator.js";

export type LinearReconciliationClientFactoryInput = {
  apiKey: string | null;
  endpoint: string | null;
  pageSize: number | null;
  env: NodeJS.ProcessEnv;
};

export type CliDeps = {
  buildLinearReconciliationClient?: (
    input: LinearReconciliationClientFactoryInput
  ) => LinearReconciliationClient;
};

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; adapter?: string; project?: string; milestone?: string; linearEndpoint?: string; linearPageSize?: number; maxPages?: number; goal?: string; dryRun: boolean;
};

export function source(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for source. Expected: list, get, link, unlink, reconcile.",
      parsed,
      io
    );
  }
  if (subcommand === "list") {
    return sourceList(parsed, io);
  }
  if (subcommand === "get") {
    return sourceGet(parsed, io);
  }
  if (subcommand === "link") {
    return sourceLink(parsed, io);
  }
  if (subcommand === "unlink") {
    return sourceUnlink(parsed, io);
  }
  if (subcommand === "reconcile") {
    return sourceReconcile(parsed, io, deps);
  }
  return usageError(`Unknown source subcommand: ${subcommand}`, parsed, io);
}

function sourceList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for source list: ${parsed.args[2]}`,
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
    return emitSourceFailure(parsed, io, "source list", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let items: ReturnType<typeof listSourceItems>;
  let lastReconciliation: ReturnType<typeof listSourceReconciliationRuns>[number] | null;
  try {
    items = listSourceItems(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter }
    );
    const runs = listSourceReconciliationRuns(
      db,
      parsed.adapter === undefined ? {} : { adapterKind: parsed.adapter }
    );
    lastReconciliation = runs.length === 0 ? null : runs[runs.length - 1] ?? null;
  } finally {
    db.close();
  }

  return emitSourceList(parsed, io, {
    dataDir,
    adapter: parsed.adapter ?? null,
    items,
    lastReconciliation
  });
}

function sourceGet(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source get.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source get: ${parsed.args[3]}`,
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
    return emitSourceFailure(parsed, io, "source get", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  let item: ReturnType<typeof getSourceItemById>;
  try {
    item = getSourceItemById(db, sourceItemId);
  } finally {
    db.close();
  }

  if (!item) {
    return emitSourceFailure(parsed, io, "source get", {
      code: "source_item_not_found",
      message: `Source item not found: ${sourceItemId}`,
      sourceItemId,
      dataDir
    });
  }

  return emitSourceGet(parsed, io, { dataDir, item });
}

function sourceLink(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source link.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source link: ${parsed.args[3]}`,
      parsed,
      io
    );
  }
  if (parsed.goal === undefined || parsed.goal.length === 0) {
    return usageError(
      "Missing required --goal <goal-id> for source link.",
      parsed,
      io
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
    return emitSourceFailure(parsed, io, "source link", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  try {
    const result = linkGoalToSourceItem(db, { goalId, sourceItemId });
    if (!result.ok) {
      return emitSourceFailure(parsed, io, "source link", {
        code: result.code,
        message: result.message,
        sourceItemId,
        goalId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir
      });
    }
    const intentEvaluations = evaluateGoalForSourceSatisfiedIntents(db, {
      goalId
    });
    return emitSourceLink(parsed, io, {
      dataDir,
      goalId,
      result,
      intentEvaluations
    });
  } finally {
    db.close();
  }
}

function sourceUnlink(parsed: ParsedFlags, io: CliIo): number {
  const sourceItemId = parsed.args[2];
  if (!sourceItemId) {
    return usageError(
      "Missing required <source-item-id> for source unlink.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source unlink: ${parsed.args[3]}`,
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
    return emitSourceFailure(parsed, io, "source unlink", {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const db = openDb(dataDir);
  try {
    const result = unlinkGoalFromSourceItem(db, { sourceItemId });
    if (!result.ok) {
      return emitSourceFailure(parsed, io, "source unlink", {
        code: result.code,
        message: result.message,
        sourceItemId,
        currentGoalId: result.currentGoalId ?? null,
        dataDir
      });
    }

    return emitSourceUnlink(parsed, io, {
      dataDir,
      result
    });
  } finally {
    db.close();
  }
}

const LINEAR_API_KEY_ENV = LINEAR_API_KEY_ENV_VAR;

async function sourceReconcile(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): Promise<number> {
  const adapterKind = parsed.args[2];
  if (!adapterKind) {
    return usageError(
      "Missing required <adapter> for source reconcile. Expected: linear.",
      parsed,
      io
    );
  }
  if (adapterKind !== "linear") {
    return emitSourceReconcileFailure(parsed, io, {
      code: "unsupported_source_adapter",
      message: `Source reconcile only supports the "linear" adapter; got "${adapterKind}".`
    });
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for source reconcile linear: ${parsed.args[3]}`,
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
    return emitSourceReconcileFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const env = io.env ?? {};
  const apiKey = (env[LINEAR_API_KEY_ENV] ?? "").trim();
  const factoryInput: LinearReconciliationClientFactoryInput = {
    apiKey: apiKey.length > 0 ? apiKey : null,
    endpoint: parsed.linearEndpoint ?? null,
    pageSize: parsed.linearPageSize ?? null,
    env
  };
  const factory =
    deps.buildLinearReconciliationClient ??
    ((input: LinearReconciliationClientFactoryInput): LinearReconciliationClient => {
      const opts: { apiKey?: string | null; endpoint?: string; pageSize?: number } = {
        apiKey: input.apiKey
      };
      if (input.endpoint !== null) opts.endpoint = input.endpoint;
      if (input.pageSize !== null) opts.pageSize = input.pageSize;
      return buildLinearHttpReconciliationClient(opts);
    });

  let client: LinearReconciliationClient;
  try {
    client = factory(factoryInput);
  } catch (err) {
    return emitSourceReconcileFailure(parsed, io, {
      code: "source_config_invalid",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind
    });
  }

  const filters: LinearReconciliationFilters = {};
  if (parsed.project !== undefined) {
    if (/^[0-9a-f-]{8,}$/i.test(parsed.project) && parsed.project.includes("-")) {
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

  const reconcileInput: ReconcileLinearSourceInput = {
    client,
    filters,
    dryRun: parsed.dryRun
  };
  if (parsed.maxPages !== undefined) reconcileInput.maxPages = parsed.maxPages;

  const db = openDb(dataDir);
  let result: ReconcileLinearSourceResult;
  try {
    result = await reconcileLinearSource(db, reconcileInput);
  } catch (err) {
    db.close();
    return emitSourceReconcileFailure(parsed, io, {
      code: "source_adapter_threw",
      message: err instanceof Error ? err.message : String(err),
      dataDir,
      adapter: adapterKind
    });
  }
  db.close();

  return emitSourceReconcileResult(parsed, io, {
    dataDir,
    adapter: adapterKind,
    filters,
    dryRun: parsed.dryRun,
    result
  });
}
