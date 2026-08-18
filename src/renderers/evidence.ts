import type { EvidenceRecord } from "../core/evidence/records.js";
import type { WorkflowEvidenceDiagnostic } from "../core/evidence/workflow.js";
import type { EvaluateGoalForTrackerSatisfiedIntentResult } from "../core/tracker/intent-generator.js";
import { intentEvaluationToJsonShape } from "./tracker.js";
import {
  TRACKER_CONTRACT_SCHEMA_VERSION,
  write,
  writeJson,
  type CliIo,
} from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export function evidenceRecordToJsonShape(
  record: EvidenceRecord,
): Record<string, unknown> {
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
    trackerItemId: record.trackerItemId,
    runId: record.runId,
    stepId: record.stepId,
    ingestKey: record.ingestKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export type EvidenceIngestFailureCode =
  | "data_dir_failed"
  | "path_required"
  | "goal_not_found"
  | "tracker_item_not_found";

export type EvidenceIngestFailure = {
  code: EvidenceIngestFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  trackerItemId?: string | null;
  path?: string | null;
};

export function emitEvidenceIngestSuccess(
  parsed: JsonFlags,
  io: CliIo,
  result: {
    dataDir: string;
    artifactPath: string;
    goalId: string | null;
    trackerItemId: string | null;
    observed: number;
    created: EvidenceRecord[];
    skipped: EvidenceRecord[];
    intentEvaluations: EvaluateGoalForTrackerSatisfiedIntentResult[];
    diagnostics: WorkflowEvidenceDiagnostic[];
    errors: Array<{ ingestKey: string; type: string; message: string }>;
  },
): number {
  const ok = result.errors.length === 0;
  const createdIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_created",
  );
  const replayedIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_replayed",
  );
  const intentWarnings = result.intentEvaluations.filter(
    (entry) => entry.outcome === "evidence_insufficient",
  );
  const payload = {
    ok,
    command: "evidence ingest",
    dataDir: result.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    path: result.artifactPath,
    goalId: result.goalId,
    trackerItemId: result.trackerItemId,
    counts: {
      observed: result.observed,
      created: result.created.length,
      skipped: result.skipped.length,
      intentsCreated: createdIntents.length,
      intentsReplayed: replayedIntents.length,
      intentWarnings: intentWarnings.length,
      diagnostics: result.diagnostics.length,
      errors: result.errors.length,
    },
    created: result.created.map(evidenceRecordToJsonShape),
    skipped: result.skipped.map(evidenceRecordToJsonShape),
    intentEvaluations: result.intentEvaluations.map(
      intentEvaluationToJsonShape,
    ),
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    errors: result.errors.map((entry) => ({ ...entry })),
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const lines = [
    `Evidence ingest: ${result.artifactPath}`,
    `Goal: ${result.goalId ?? "(unlinked)"}`,
    `Tracker item: ${result.trackerItemId ?? "(unlinked)"}`,
    `Observed: ${result.observed}`,
    `Created: ${result.created.length}`,
    `Skipped (idempotent): ${result.skipped.length}`,
    `Intents created: ${createdIntents.length}`,
    `Intents replayed: ${replayedIntents.length}`,
    `Intent warnings: ${intentWarnings.length}`,
    `Diagnostics: ${result.diagnostics.length}`,
    `Errors: ${result.errors.length}`,
    `Data dir: ${result.dataDir}`,
    "",
  ];
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

export function emitEvidenceIngestFailure(
  parsed: JsonFlags,
  io: CliIo,
  failure: EvidenceIngestFailure,
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence ingest",
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    code: failure.code,
    message: failure.message,
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.trackerItemId !== undefined) {
    payload["trackerItemId"] = failure.trackerItemId;
  }
  if (failure.path !== undefined) payload["path"] = failure.path;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

export function emitEvidenceList(
  parsed: JsonFlags,
  io: CliIo,
  data: {
    dataDir: string;
    filters: {
      goalId?: string | null;
      trackerItemId?: string | null;
      source?: string;
      type?: string;
      limit?: number;
    };
    records: EvidenceRecord[];
  },
): number {
  const payload = {
    ok: true,
    command: "evidence list",
    dataDir: data.dataDir,
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    goalId: data.filters.goalId ?? null,
    trackerItemId: data.filters.trackerItemId ?? null,
    source: data.filters.source ?? null,
    type: data.filters.type ?? null,
    limit: data.filters.limit ?? null,
    count: data.records.length,
    records: data.records.map(evidenceRecordToJsonShape),
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Evidence records: ${data.records.length}`,
    `Goal: ${data.filters.goalId ?? "(any)"}`,
    `Tracker item: ${data.filters.trackerItemId ?? "(any)"}`,
    `Source: ${data.filters.source ?? "(any)"}`,
    `Type: ${data.filters.type ?? "(any)"}`,
    `Data dir: ${data.dataDir}`,
    ...data.records.map(
      (record) =>
        `- ${record.id} [${record.source}/${record.type}] @${record.occurredAt}: ${record.summary}` +
        (record.runId !== null ? ` run=${record.runId}` : "") +
        (record.stepId !== null ? ` step=${record.stepId}` : ""),
    ),
    "",
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export type EvidenceListFailureCode =
  "data_dir_failed" | "goal_not_found" | "tracker_item_not_found";

export type EvidenceListFailure = {
  code: EvidenceListFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  trackerItemId?: string | null;
};

export function emitEvidenceListFailure(
  parsed: JsonFlags,
  io: CliIo,
  failure: EvidenceListFailure,
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence list",
    schemaVersion: TRACKER_CONTRACT_SCHEMA_VERSION,
    code: failure.code,
    message: failure.message,
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.trackerItemId !== undefined) {
    payload["trackerItemId"] = failure.trackerItemId;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}
