import type {
  LinkGoalToTrackerItemErrorCode,
  LinkGoalToTrackerItemResult,
  TrackerItem,
  UnlinkGoalFromTrackerItemErrorCode,
  UnlinkGoalFromTrackerItemResult,
} from "../core/tracker/items.js";
import type { TrackerReconciliationRun } from "../core/tracker/reconciliation-runs.js";
import type {
  LinearReconciliationFilters,
  ReconcileLinearTrackerResult,
} from "../core/tracker/reconciliation.js";
import type { EvaluateGoalForTrackerSatisfiedIntentResult } from "../core/tracker/update-intent-generator.js";
import { evidenceRecordToJsonShape } from "./evidence.js";
import { updateIntentToJsonShape } from "./intent.js";
import {
  TRACKER_CONTRACT_SCHEMA_VERSION,
  write,
  writeJson,
  type CliIo,
} from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export function trackerItemToJsonShape(
  item: TrackerItem,
): Record<string, unknown> {
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
    updatedAt: item.updatedAt,
  };
}

export function emitTrackerList(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    adapter: string | null;
    items: TrackerItem[];
    lastReconciliation: TrackerReconciliationRun | null;
  },
): number {
  const payload = {
    ok: true,
    command: "tracker list",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    adapter: data.adapter,
    count: data.items.length,
    items: data.items.map(trackerItemToJsonShape),
    lastReconciliation: data.lastReconciliation
      ? trackerReconciliationRunToJsonShape(data.lastReconciliation)
      : null,
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Tracker items: ${data.items.length}`,
    `Adapter: ${data.adapter ?? "(all)"}`,
    `Data dir: ${data.dataDir}`,
    ...data.items.map(
      (item) =>
        `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""}`,
    ),
  ];
  if (data.lastReconciliation) {
    const paginationStopped = trackerReconciliationPaginationStopped(
      data.lastReconciliation,
    );
    const stoppedText = paginationStopped
      ? `, stopped=${paginationStopped.reason}`
      : "";
    lines.push(
      `Last reconciliation: ${data.lastReconciliation.adapterKind} ${data.lastReconciliation.state}` +
        ` (seen=${data.lastReconciliation.itemsSeen}, upserted=${data.lastReconciliation.itemsUpserted}${stoppedText})`,
    );
  } else {
    lines.push("Last reconciliation: (none)");
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitTrackerGet(
  parsed: JsonFlags,
  io: CliIo,
  data: { dataDir: string; item: TrackerItem },
): number {
  const payload = {
    ok: true,
    command: "tracker get",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    item: trackerItemToJsonShape(data.item),
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(
    io.stdout,
    [
      `Tracker item: ${data.item.id}`,
      `Adapter: ${data.item.adapterKind}`,
      `External id: ${data.item.externalId}`,
      `External key: ${data.item.externalKey ?? "(unset)"}`,
      `URL: ${data.item.url ?? "(unset)"}`,
      `Title: ${data.item.title}`,
      `Status: ${data.item.status ?? "(unset)"}`,
      `Goal: ${data.item.goalId ?? "(unlinked)"}`,
      `Last observed at: ${data.item.lastObservedAt}`,
      `Data dir: ${data.dataDir}`,
      "",
    ].join("\n"),
  );
  return 0;
}

export function emitTrackerLink(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    goalId: string;
    result: Extract<LinkGoalToTrackerItemResult, { ok: true }>;
    intentEvaluations: EvaluateGoalForTrackerSatisfiedIntentResult[];
  },
): number {
  const intentsCreated = data.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_created",
  ).length;
  const intentsReplayed = data.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_replayed",
  ).length;
  const intentWarnings = data.intentEvaluations.filter(
    (entry) => entry.outcome === "evidence_insufficient",
  ).length;

  const payload = {
    ok: true,
    command: "tracker link",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    goalId: data.goalId,
    trackerItemId: data.result.trackerItem.id,
    changed: data.result.changed,
    skippedReason: data.result.skippedReason,
    previousGoalId: data.result.previousGoalId,
    counts: {
      intentsCreated,
      intentsReplayed,
      intentWarnings,
    },
    intentEvaluations: data.intentEvaluations.map(intentEvaluationToJsonShape),
    item: trackerItemToJsonShape(data.result.trackerItem),
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    data.result.changed
      ? `Linked tracker item ${data.result.trackerItem.id} to goal ${data.goalId}.`
      : `Tracker item ${data.result.trackerItem.id} already linked to goal ${data.goalId}; no change.`,
    `Adapter: ${data.result.trackerItem.adapterKind}`,
    `External key: ${data.result.trackerItem.externalKey ?? "(unset)"}`,
    `Title: ${data.result.trackerItem.title}`,
    `Intents created: ${intentsCreated}`,
    `Intents replayed: ${intentsReplayed}`,
    `Intent warnings: ${intentWarnings}`,
    `Data dir: ${data.dataDir}`,
    "",
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitTrackerUnlink(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    result: Extract<UnlinkGoalFromTrackerItemResult, { ok: true }>;
  },
): number {
  const payload = {
    ok: true,
    command: "tracker unlink",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    trackerItemId: data.result.trackerItem.id,
    changed: data.result.changed,
    previousGoalId: data.result.previousGoalId,
    item: trackerItemToJsonShape(data.result.trackerItem),
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    data.result.changed
      ? `Unlinked tracker item ${data.result.trackerItem.id} (was goal ${data.result.previousGoalId}).`
      : `Tracker item ${data.result.trackerItem.id} was already unlinked; no change.`,
    `Adapter: ${data.result.trackerItem.adapterKind}`,
    `Title: ${data.result.trackerItem.title}`,
    `Data dir: ${data.dataDir}`,
    "",
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export type TrackerReconcileSuccessPayload = {
  dataDir: string;
  adapter: "linear";
  filters: LinearReconciliationFilters;
  dryRun: boolean;
  result: ReconcileLinearTrackerResult;
};

export function emitTrackerReconcileResult(
  parsed: JsonFlags,
  io: CliIo,
  data: TrackerReconcileSuccessPayload,
): number {
  const run = data.result.run;
  const stop = data.result.paginationStopped;
  const counts = data.result.counts;
  const ok = run.state === "succeeded";
  const stopCode = stop.code ?? null;

  const payload: Record<string, unknown> = {
    ok,
    command: "tracker reconcile linear",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    adapter: data.adapter,
    filters: data.filters,
    dryRun: data.dryRun,
    run: trackerReconciliationRunToJsonShape(run),
    counts,
    paginationStopped: {
      reason: stop.reason,
      pageIndex: stop.pageIndex,
      code: stopCode,
      error: stop.error ?? null,
    },
    itemsSampled: data.result.items.slice(0, 25).map((item) => ({
      classification: item.classification,
      externalId: item.externalId,
      externalKey: item.externalKey,
      pageIndex: item.pageIndex,
      errorCode: item.errorCode ?? null,
      error: item.error ?? null,
    })),
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const headline = data.dryRun
    ? `Tracker reconcile (dry-run, ${data.adapter}): ${run.state}`
    : `Tracker reconcile (${data.adapter}): ${run.state}`;
  const lines: string[] = [
    headline,
    `Run id: ${run.id}`,
    `Pages: ${counts.pages}`,
    `Observed: ${counts.itemsObserved}`,
    `Created: ${counts.itemsCreated}`,
    `Updated: ${counts.itemsUpdated}`,
    `Skipped: ${counts.itemsSkipped}`,
    `Errored: ${counts.itemsErrored}`,
    `Stopped: ${stop.reason}${stopCode ? ` (${stopCode})` : ""}`,
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(`Data dir: ${data.dataDir}`, "");
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

export type TrackerReconcileFailure = {
  code:
    | "data_dir_failed"
    | "unsupported_tracker_adapter"
    | "tracker_config_invalid"
    | "tracker_adapter_threw";
  message: string;
  dataDir?: string;
  adapter?: string;
};

export function emitTrackerReconcileFailure(
  parsed: JsonFlags,
  io: CliIo,
  failure: TrackerReconcileFailure,
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "tracker reconcile linear",
    code: failure.code,
    message: failure.message,
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

export type TrackerReconciliationPaginationStoppedJson = {
  reason: string;
  pageIndex: number;
  code: string | null;
  error: string | null;
};

export function trackerReconciliationRunToJsonShape(
  run: TrackerReconciliationRun,
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
    paginationStopped: trackerReconciliationPaginationStopped(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function trackerReconciliationPaginationStopped(
  run: TrackerReconciliationRun,
): TrackerReconciliationPaginationStoppedJson | null {
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
    error: typeof record["error"] === "string" ? record["error"] : null,
  };
}

export type TrackerFailureCode =
  | "data_dir_failed"
  | "tracker_item_not_found"
  | LinkGoalToTrackerItemErrorCode
  | UnlinkGoalFromTrackerItemErrorCode;

export type TrackerFailure = {
  code: TrackerFailureCode;
  message: string;
  trackerItemId?: string;
  goalId?: string;
  currentGoalId?: string | null;
  dataDir?: string;
};

export function emitTrackerFailure(
  parsed: JsonFlags,
  io: CliIo,
  command: "tracker list" | "tracker get" | "tracker link" | "tracker unlink",
  failure: TrackerFailure,
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    code: failure.code,
    message: failure.message,
  };
  if (failure.trackerItemId !== undefined) {
    payload["trackerItemId"] = failure.trackerItemId;
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
  result: EvaluateGoalForTrackerSatisfiedIntentResult,
): Record<string, unknown> {
  if (
    result.outcome === "intent_created" ||
    result.outcome === "intent_replayed"
  ) {
    return {
      outcome: result.outcome,
      intent: updateIntentToJsonShape(result.intent),
      trackerItem: trackerItemToJsonShape(result.trackerItem),
      verificationEvidence: evidenceRecordToJsonShape(
        result.verificationEvidence,
      ),
    };
  }
  if (result.outcome === "evidence_insufficient") {
    return {
      outcome: result.outcome,
      warning: { ...result.warning },
    };
  }
  if (result.outcome === "tracker_already_terminal") {
    return {
      outcome: result.outcome,
      trackerItem: trackerItemToJsonShape(result.trackerItem),
    };
  }
  return { ...result };
}
