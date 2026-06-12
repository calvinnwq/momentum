import { COMMANDS } from "../help.js";
import { openDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  getSourceItemById,
  linkGoalToSourceItem,
  listSourceItems,
  unlinkGoalFromSourceItem,
  type LinkGoalToSourceItemErrorCode,
  type SourceItem,
  type UnlinkGoalFromSourceItemErrorCode
} from "../../source-items.js";
import {
  listSourceReconciliationRuns,
  type SourceReconciliationRun
} from "../../source-reconciliation-runs.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFilters,
  type ReconcileLinearSourceInput,
  type ReconcileLinearSourceResult
} from "../../source-reconciliation.js";
import { buildLinearHttpReconciliationClient } from "../../linear-http-client.js";
import { LINEAR_API_KEY_ENV_VAR } from "../../intent-apply-execute.js";
import { type EvidenceRecord } from "../../evidence-records.js";
import { updateIntentToJsonShape } from "../intent/index.js";
import {
  evaluateGoalForSourceSatisfiedIntents,
  type EvaluateGoalForSourceSatisfiedIntentResult
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

type Writer = {
  write(chunk: string): boolean;
};

type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

type JsonPayload = Record<string, unknown>;

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
  let items: SourceItem[];
  let lastReconciliation: SourceReconciliationRun | null;
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

  const payload = {
    ok: true,
    command: "source list",
    dataDir,
    adapter: parsed.adapter ?? null,
    count: items.length,
    items: items.map(sourceItemToJsonShape),
    lastReconciliation: lastReconciliation
      ? sourceReconciliationRunToJsonShape(lastReconciliation)
      : null
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Source items: ${items.length}`,
    `Adapter: ${parsed.adapter ?? "(all)"}`,
    `Data dir: ${dataDir}`,
    ...items.map((item) =>
      `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
      `${item.title}${item.status ? ` (${item.status})` : ""}`
    )
  ];
  if (lastReconciliation) {
    const paginationStopped = sourceReconciliationPaginationStopped(lastReconciliation);
    const stoppedText = paginationStopped ? `, stopped=${paginationStopped.reason}` : "";
    lines.push(
      `Last reconciliation: ${lastReconciliation.adapterKind} ${lastReconciliation.state}` +
        ` (seen=${lastReconciliation.itemsSeen}, upserted=${lastReconciliation.itemsUpserted}${stoppedText})`
    );
  } else {
    lines.push("Last reconciliation: (none)");
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
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
  let item: SourceItem | null;
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

  const payload = {
    ok: true,
    command: "source get",
    dataDir,
    item: sourceItemToJsonShape(item)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `Source item: ${item.id}`,
    `Adapter: ${item.adapterKind}`,
    `External id: ${item.externalId}`,
    `External key: ${item.externalKey ?? "(unset)"}`,
    `URL: ${item.url ?? "(unset)"}`,
    `Title: ${item.title}`,
    `Status: ${item.status ?? "(unset)"}`,
    `Goal: ${item.goalId ?? "(unlinked)"}`,
    `Last observed at: ${item.lastObservedAt}`,
    `Data dir: ${dataDir}`,
    ""
  ].join("\n"));
  return 0;
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
    const intentsCreated = intentEvaluations.filter(
      (entry) => entry.outcome === "intent_created"
    ).length;
    const intentsReplayed = intentEvaluations.filter(
      (entry) => entry.outcome === "intent_replayed"
    ).length;
    const intentWarnings = intentEvaluations.filter(
      (entry) => entry.outcome === "evidence_insufficient"
    ).length;

    const payload = {
      ok: true,
      command: "source link",
      dataDir,
      goalId,
      sourceItemId: result.sourceItem.id,
      changed: result.changed,
      skippedReason: result.skippedReason,
      previousGoalId: result.previousGoalId,
      counts: {
        intentsCreated,
        intentsReplayed,
        intentWarnings
      },
      intentEvaluations: intentEvaluations.map(intentEvaluationToJsonShape),
      item: sourceItemToJsonShape(result.sourceItem)
    };

    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }

    const lines = [
      result.changed
        ? `Linked source item ${result.sourceItem.id} to goal ${goalId}.`
        : `Source item ${result.sourceItem.id} already linked to goal ${goalId}; no change.`,
      `Adapter: ${result.sourceItem.adapterKind}`,
      `External key: ${result.sourceItem.externalKey ?? "(unset)"}`,
      `Title: ${result.sourceItem.title}`,
      `Intents created: ${intentsCreated}`,
      `Intents replayed: ${intentsReplayed}`,
      `Intent warnings: ${intentWarnings}`,
      `Data dir: ${dataDir}`,
      ""
    ];
    write(io.stdout, lines.join("\n"));
    return 0;
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

    const payload = {
      ok: true,
      command: "source unlink",
      dataDir,
      sourceItemId: result.sourceItem.id,
      changed: result.changed,
      previousGoalId: result.previousGoalId,
      item: sourceItemToJsonShape(result.sourceItem)
    };

    if (parsed.json) {
      writeJson(io.stdout, payload);
      return 0;
    }

    const lines = [
      result.changed
        ? `Unlinked source item ${result.sourceItem.id} (was goal ${result.previousGoalId}).`
        : `Source item ${result.sourceItem.id} was already unlinked; no change.`,
      `Adapter: ${result.sourceItem.adapterKind}`,
      `Title: ${result.sourceItem.title}`,
      `Data dir: ${dataDir}`,
      ""
    ];
    write(io.stdout, lines.join("\n"));
    return 0;
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

type SourceReconcileSuccessPayload = {
  dataDir: string;
  adapter: "linear";
  filters: LinearReconciliationFilters;
  dryRun: boolean;
  result: ReconcileLinearSourceResult;
};

function emitSourceReconcileResult(
  parsed: ParsedFlags,
  io: CliIo,
  data: SourceReconcileSuccessPayload
): number {
  const run = data.result.run;
  const stop = data.result.paginationStopped;
  const counts = data.result.counts;
  const ok = run.state === "succeeded";
  const stopCode = stop.code ?? null;

  const payload: Record<string, unknown> = {
    ok,
    command: "source reconcile linear",
    dataDir: data.dataDir,
    adapter: data.adapter,
    filters: data.filters,
    dryRun: data.dryRun,
    run: sourceReconciliationRunToJsonShape(run),
    counts,
    paginationStopped: {
      reason: stop.reason,
      pageIndex: stop.pageIndex,
      code: stopCode,
      error: stop.error ?? null
    },
    itemsSampled: data.result.items.slice(0, 25).map((item) => ({
      classification: item.classification,
      externalId: item.externalId,
      externalKey: item.externalKey,
      pageIndex: item.pageIndex,
      errorCode: item.errorCode ?? null,
      error: item.error ?? null
    }))
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const headline = data.dryRun
    ? `Source reconcile (dry-run, ${data.adapter}): ${run.state}`
    : `Source reconcile (${data.adapter}): ${run.state}`;
  const lines: string[] = [
    headline,
    `Run id: ${run.id}`,
    `Pages: ${counts.pages}`,
    `Observed: ${counts.itemsObserved}`,
    `Created: ${counts.itemsCreated}`,
    `Updated: ${counts.itemsUpdated}`,
    `Skipped: ${counts.itemsSkipped}`,
    `Errored: ${counts.itemsErrored}`,
    `Stopped: ${stop.reason}${stopCode ? ` (${stopCode})` : ""}`
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(`Data dir: ${data.dataDir}`, "");
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

type SourceReconcileFailure = {
  code:
    | "data_dir_failed"
    | "unsupported_source_adapter"
    | "source_config_invalid"
    | "source_adapter_threw";
  message: string;
  dataDir?: string;
  adapter?: string;
};

function emitSourceReconcileFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: SourceReconcileFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "source reconcile linear",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.adapter !== undefined) payload["adapter"] = failure.adapter;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

export type SourceReconciliationPaginationStoppedJson = {
  reason: string;
  pageIndex: number;
  code: string | null;
  error: string | null;
};

function sourceReconciliationRunToJsonShape(
  run: SourceReconciliationRun
): Record<string, unknown> {
  return {
    id: run.id,
    adapterKind: run.adapterKind,
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    itemsSeen: run.itemsSeen,
    itemsUpserted: run.itemsUpserted,
    metadata: run.metadata,
    paginationStopped: sourceReconciliationPaginationStopped(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

export function sourceReconciliationPaginationStopped(
  run: SourceReconciliationRun
): SourceReconciliationPaginationStoppedJson | null {
  const stop = run.metadata["paginationStopped"];
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) return null;
  const record = stop as Record<string, unknown>;
  if (typeof record["reason"] !== "string") return null;
  const pageIndex = record["pageIndex"];
  if (!Number.isInteger(pageIndex)) return null;
  return {
    reason: record["reason"],
    pageIndex: pageIndex as number,
    code: typeof record["code"] === "string" ? record["code"] : null,
    error: typeof record["error"] === "string" ? record["error"] : null
  };
}

type SourceFailureCode =
  | "data_dir_failed"
  | "source_item_not_found"
  | LinkGoalToSourceItemErrorCode
  | UnlinkGoalFromSourceItemErrorCode;

type SourceFailure = {
  code: SourceFailureCode;
  message: string;
  sourceItemId?: string;
  goalId?: string;
  currentGoalId?: string | null;
  dataDir?: string;
};

function emitSourceFailure(
  parsed: ParsedFlags,
  io: CliIo,
  command: "source list" | "source get" | "source link" | "source unlink",
  failure: SourceFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command,
    code: failure.code,
    message: failure.message
  };
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.goalId !== undefined) {
    payload["goalId"] = failure.goalId;
  }
  if (failure.currentGoalId !== undefined) {
    payload["currentGoalId"] = failure.currentGoalId;
  }
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

export function sourceItemToJsonShape(item: SourceItem): Record<string, unknown> {
  return {
    id: item.id,
    adapterKind: item.adapterKind,
    externalId: item.externalId,
    externalKey: item.externalKey,
    url: item.url,
    title: item.title,
    status: item.status,
    metadata: item.metadata,
    lastObservedAt: item.lastObservedAt,
    goalId: item.goalId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function intentEvaluationToJsonShape(
  result: EvaluateGoalForSourceSatisfiedIntentResult
): Record<string, unknown> {
  if (
    result.outcome === "intent_created" ||
    result.outcome === "intent_replayed"
  ) {
    return {
      outcome: result.outcome,
      intent: updateIntentToJsonShape(result.intent),
      sourceItem: sourceItemToJsonShape(result.sourceItem),
      verificationEvidence: evidenceRecordToJsonShape(
        result.verificationEvidence
      )
    };
  }
  if (result.outcome === "evidence_insufficient") {
    return {
      outcome: result.outcome,
      warning: { ...result.warning }
    };
  }
  if (result.outcome === "source_already_terminal") {
    return {
      outcome: result.outcome,
      sourceItem: sourceItemToJsonShape(result.sourceItem)
    };
  }
  return { ...result };
}

function evidenceRecordToJsonShape(record: EvidenceRecord): Record<string, unknown> {
  return {
    id: record.id,
    source: record.source,
    type: record.type,
    formatVersion: record.formatVersion,
    artifactPath: record.artifactPath,
    externalId: record.externalId,
    occurredAt: record.occurredAt,
    summary: record.summary,
    metadata: record.metadata,
    goalId: record.goalId,
    sourceItemId: record.sourceItemId,
    runId: record.runId,
    stepId: record.stepId,
    ingestKey: record.ingestKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}


function usageError(message: string, parsed: ParsedFlags, io: CliIo): number {
  if (parsed.json) {
    writeJson(io.stderr, {
      ok: false,
      code: "usage_error",
      message,
      commands: COMMANDS
    });
  } else {
    write(io.stderr, `${message}\n\n${COMMANDS.join("\n")}\n`);
  }
  return 2;
}

function writeJson(writer: Writer, payload: JsonPayload): void {
  writer.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}
