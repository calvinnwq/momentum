import type {
  LinkGoalToSourceItemErrorCode,
  LinkGoalToSourceItemResult,
  SourceItem,
  UnlinkGoalFromSourceItemErrorCode,
  UnlinkGoalFromSourceItemResult
} from "../core/source/items.js";
import type { SourceReconciliationRun } from "../core/source/reconciliation-runs.js";
import type {
  LinearReconciliationFilters,
  ReconcileLinearSourceResult
} from "../core/source/reconciliation.js";
import type { EvaluateGoalForSourceSatisfiedIntentResult } from "../core/source/update-intent-generator.js";
import { evidenceRecordToJsonShape } from "./evidence.js";
import { updateIntentToJsonShape } from "./intent.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

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

export function emitSourceList(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    adapter: string | null;
    items: SourceItem[];
    lastReconciliation: SourceReconciliationRun | null;
  }
): number {
  const payload = {
    ok: true,
    command: "source list",
    dataDir: data.dataDir,
    adapter: data.adapter,
    count: data.items.length,
    items: data.items.map(sourceItemToJsonShape),
    lastReconciliation: data.lastReconciliation
      ? sourceReconciliationRunToJsonShape(data.lastReconciliation)
      : null
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Source items: ${data.items.length}`,
    `Adapter: ${data.adapter ?? "(all)"}`,
    `Data dir: ${data.dataDir}`,
    ...data.items.map((item) =>
      `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
      `${item.title}${item.status ? ` (${item.status})` : ""}`
    )
  ];
  if (data.lastReconciliation) {
    const paginationStopped = sourceReconciliationPaginationStopped(
      data.lastReconciliation
    );
    const stoppedText = paginationStopped
      ? `, stopped=${paginationStopped.reason}`
      : "";
    lines.push(
      `Last reconciliation: ${data.lastReconciliation.adapterKind} ${data.lastReconciliation.state}` +
        ` (seen=${data.lastReconciliation.itemsSeen}, upserted=${data.lastReconciliation.itemsUpserted}${stoppedText})`
    );
  } else {
    lines.push("Last reconciliation: (none)");
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitSourceGet(
  parsed: JsonFlags,
  io: CliIo,
  data: { dataDir: string; item: SourceItem }
): number {
  const payload = {
    ok: true,
    command: "source get",
    dataDir: data.dataDir,
    item: sourceItemToJsonShape(data.item)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `Source item: ${data.item.id}`,
    `Adapter: ${data.item.adapterKind}`,
    `External id: ${data.item.externalId}`,
    `External key: ${data.item.externalKey ?? "(unset)"}`,
    `URL: ${data.item.url ?? "(unset)"}`,
    `Title: ${data.item.title}`,
    `Status: ${data.item.status ?? "(unset)"}`,
    `Goal: ${data.item.goalId ?? "(unlinked)"}`,
    `Last observed at: ${data.item.lastObservedAt}`,
    `Data dir: ${data.dataDir}`,
    ""
  ].join("\n"));
  return 0;
}

export function emitSourceLink(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    goalId: string;
    result: Extract<LinkGoalToSourceItemResult, { ok: true }>;
    intentEvaluations: EvaluateGoalForSourceSatisfiedIntentResult[];
  }
): number {
  const intentsCreated = data.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_created"
  ).length;
  const intentsReplayed = data.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_replayed"
  ).length;
  const intentWarnings = data.intentEvaluations.filter(
    (entry) => entry.outcome === "evidence_insufficient"
  ).length;

  const payload = {
    ok: true,
    command: "source link",
    dataDir: data.dataDir,
    goalId: data.goalId,
    sourceItemId: data.result.sourceItem.id,
    changed: data.result.changed,
    skippedReason: data.result.skippedReason,
    previousGoalId: data.result.previousGoalId,
    counts: {
      intentsCreated,
      intentsReplayed,
      intentWarnings
    },
    intentEvaluations: data.intentEvaluations.map(intentEvaluationToJsonShape),
    item: sourceItemToJsonShape(data.result.sourceItem)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    data.result.changed
      ? `Linked source item ${data.result.sourceItem.id} to goal ${data.goalId}.`
      : `Source item ${data.result.sourceItem.id} already linked to goal ${data.goalId}; no change.`,
    `Adapter: ${data.result.sourceItem.adapterKind}`,
    `External key: ${data.result.sourceItem.externalKey ?? "(unset)"}`,
    `Title: ${data.result.sourceItem.title}`,
    `Intents created: ${intentsCreated}`,
    `Intents replayed: ${intentsReplayed}`,
    `Intent warnings: ${intentWarnings}`,
    `Data dir: ${data.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitSourceUnlink(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    result: Extract<UnlinkGoalFromSourceItemResult, { ok: true }>;
  }
): number {
  const payload = {
    ok: true,
    command: "source unlink",
    dataDir: data.dataDir,
    sourceItemId: data.result.sourceItem.id,
    changed: data.result.changed,
    previousGoalId: data.result.previousGoalId,
    item: sourceItemToJsonShape(data.result.sourceItem)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    data.result.changed
      ? `Unlinked source item ${data.result.sourceItem.id} (was goal ${data.result.previousGoalId}).`
      : `Source item ${data.result.sourceItem.id} was already unlinked; no change.`,
    `Adapter: ${data.result.sourceItem.adapterKind}`,
    `Title: ${data.result.sourceItem.title}`,
    `Data dir: ${data.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export type SourceReconcileSuccessPayload = {
  dataDir: string;
  adapter: "linear";
  filters: LinearReconciliationFilters;
  dryRun: boolean;
  result: ReconcileLinearSourceResult;
};

export function emitSourceReconcileResult(
  parsed: JsonFlags,
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

export type SourceReconcileFailure = {
  code:
    | "data_dir_failed"
    | "unsupported_source_adapter"
    | "source_config_invalid"
    | "source_adapter_threw";
  message: string;
  dataDir?: string;
  adapter?: string;
};

export function emitSourceReconcileFailure(
  parsed: JsonFlags,
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

export function sourceReconciliationRunToJsonShape(
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

export type SourceFailureCode =
  | "data_dir_failed"
  | "source_item_not_found"
  | LinkGoalToSourceItemErrorCode
  | UnlinkGoalFromSourceItemErrorCode;

export type SourceFailure = {
  code: SourceFailureCode;
  message: string;
  sourceItemId?: string;
  goalId?: string;
  currentGoalId?: string | null;
  dataDir?: string;
};

export function emitSourceFailure(
  parsed: JsonFlags,
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

export function intentEvaluationToJsonShape(
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
