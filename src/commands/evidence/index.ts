import { COMMANDS } from "../help.js";
import { openDb, type MomentumDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  ingestEvidenceRecord,
  listEvidenceRecords,
  summarizeEvidenceRecords,
  type EvidenceRecord,
  type EvidenceRecordIngestInput,
  type EvidenceRecordsSummary,
  type ListEvidenceRecordsOptions
} from "../../evidence-records.js";
import {
  parseWorkflowArtifact,
  type WorkflowEvidenceDiagnostic
} from "../../evidence-workflow.js";
import { getSourceItemById } from "../../source-items.js";
import { sourceItemToJsonShape } from "../source/index.js";
import { updateIntentToJsonShape } from "../intent/index.js";
import {
  evaluateGoalForSourceSatisfiedIntents,
  type EvaluateGoalForSourceSatisfiedIntentResult
} from "../../update-intent-generator.js";
import { type UpdateIntentStatus } from "../../update-intents.js";

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; goal?: string; path?: string; sourceItem?: string; source?: string; evidenceType?: string; limit?: number;
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

type EvidenceIngestFailureCode =
  | "data_dir_failed"
  | "path_required"
  | "goal_not_found"
  | "source_item_not_found";

type EvidenceIngestFailure = {
  code: EvidenceIngestFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  sourceItemId?: string | null;
  path?: string | null;
};



export function evidence(parsed: ParsedFlags, io: CliIo): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for evidence. Expected: ingest, list.",
      parsed,
      io
    );
  }
  if (subcommand === "ingest") {
    return evidenceIngest(parsed, io);
  }
  if (subcommand === "list") {
    return evidenceList(parsed, io);
  }
  return usageError(`Unknown evidence subcommand: ${subcommand}`, parsed, io);
}

function evidenceIngest(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for evidence ingest: ${parsed.args[2]}`,
      parsed,
      io
    );
  }
  if (parsed.path === undefined || parsed.path.length === 0) {
    return emitEvidenceIngestFailure(parsed, io, {
      code: "path_required",
      message: "Missing required --path <file-or-dir> for evidence ingest."
    });
  }
  const artifactPath = parsed.path;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitEvidenceIngestFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      path: artifactPath
    });
  }

  const parseOptions: Parameters<typeof parseWorkflowArtifact>[1] = {};
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    parseOptions.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    parseOptions.sourceItemId = parsed.sourceItem;
  }

  const db = openDb(dataDir);
  try {
    if (parseOptions.goalId !== undefined && parseOptions.goalId !== null) {
      const goalRow = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(parseOptions.goalId) as { id: string } | undefined;
      if (!goalRow) {
        return emitEvidenceIngestFailure(parsed, io, {
          code: "goal_not_found",
          message: `Goal not found: ${parseOptions.goalId}`,
          dataDir,
          goalId: parseOptions.goalId,
          path: artifactPath
        });
      }
    }
    if (
      parseOptions.sourceItemId !== undefined &&
      parseOptions.sourceItemId !== null
    ) {
      const itemRow = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(parseOptions.sourceItemId) as { id: string } | undefined;
      if (!itemRow) {
        return emitEvidenceIngestFailure(parsed, io, {
          code: "source_item_not_found",
          message: `Source item not found: ${parseOptions.sourceItemId}`,
          dataDir,
          sourceItemId: parseOptions.sourceItemId,
          path: artifactPath
        });
      }
    }

    const parseResult = parseWorkflowArtifact(artifactPath, parseOptions);
    const created: EvidenceRecord[] = [];
    const skipped: EvidenceRecord[] = [];
    const errors: Array<{
      ingestKey: string;
      type: string;
      message: string;
    }> = [];

    for (const input of parseResult.records) {
      try {
        const result = ingestEvidenceRecord(db, input as EvidenceRecordIngestInput);
        if (result.created) {
          created.push(result.record);
        } else {
          skipped.push(result.record);
        }
      } catch (err) {
        errors.push({
          ingestKey: input.ingestKey,
          type: input.type,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const intentEvaluations = evaluateIntentsForEvidenceRecords(db, [
      ...created,
      ...skipped
    ]);

    return emitEvidenceIngestSuccess(parsed, io, {
      dataDir,
      artifactPath,
      goalId: parseOptions.goalId ?? null,
      sourceItemId: parseOptions.sourceItemId ?? null,
      observed: parseResult.records.length,
      created,
      skipped,
      intentEvaluations,
      diagnostics: parseResult.diagnostics,
      errors
    });
  } finally {
    db.close();
  }
}

function evaluateIntentsForEvidenceRecords(
  db: MomentumDb,
  records: readonly EvidenceRecord[]
): EvaluateGoalForSourceSatisfiedIntentResult[] {
  const goalIds = new Set<string>();
  for (const record of records) {
    if (record.goalId) {
      goalIds.add(record.goalId);
      continue;
    }
    if (record.sourceItemId) {
      const sourceItem = getSourceItemById(db, record.sourceItemId);
      if (sourceItem?.goalId) goalIds.add(sourceItem.goalId);
    }
  }
  return [...goalIds]
    .sort()
    .flatMap((goalId) =>
      evaluateGoalForSourceSatisfiedIntents(db, { goalId })
    );
}

function emitEvidenceIngestSuccess(
  parsed: ParsedFlags,
  io: CliIo,
  result: {
    dataDir: string;
    artifactPath: string;
    goalId: string | null;
    sourceItemId: string | null;
    observed: number;
    created: EvidenceRecord[];
    skipped: EvidenceRecord[];
    intentEvaluations: EvaluateGoalForSourceSatisfiedIntentResult[];
    diagnostics: WorkflowEvidenceDiagnostic[];
    errors: Array<{ ingestKey: string; type: string; message: string }>;
  }
): number {
  const ok = result.errors.length === 0;
  const createdIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_created"
  );
  const replayedIntents = result.intentEvaluations.filter(
    (entry) => entry.outcome === "intent_replayed"
  );
  const intentWarnings = result.intentEvaluations.filter(
    (entry) => entry.outcome === "evidence_insufficient"
  );
  const payload = {
    ok,
    command: "evidence ingest",
    dataDir: result.dataDir,
    path: result.artifactPath,
    goalId: result.goalId,
    sourceItemId: result.sourceItemId,
    counts: {
      observed: result.observed,
      created: result.created.length,
      skipped: result.skipped.length,
      intentsCreated: createdIntents.length,
      intentsReplayed: replayedIntents.length,
      intentWarnings: intentWarnings.length,
      diagnostics: result.diagnostics.length,
      errors: result.errors.length
    },
    created: result.created.map(evidenceRecordToJsonShape),
    skipped: result.skipped.map(evidenceRecordToJsonShape),
    intentEvaluations: result.intentEvaluations.map(intentEvaluationToJsonShape),
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    errors: result.errors.map((entry) => ({ ...entry }))
  };

  if (parsed.json) {
    writeJson(ok ? io.stdout : io.stderr, payload);
    return ok ? 0 : 1;
  }

  const lines = [
    `Evidence ingest: ${result.artifactPath}`,
    `Goal: ${result.goalId ?? "(unlinked)"}`,
    `Source item: ${result.sourceItemId ?? "(unlinked)"}`,
    `Observed: ${result.observed}`,
    `Created: ${result.created.length}`,
    `Skipped (idempotent): ${result.skipped.length}`,
    `Intents created: ${createdIntents.length}`,
    `Intents replayed: ${replayedIntents.length}`,
    `Intent warnings: ${intentWarnings.length}`,
    `Diagnostics: ${result.diagnostics.length}`,
    `Errors: ${result.errors.length}`,
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(ok ? io.stdout : io.stderr, lines.join("\n"));
  return ok ? 0 : 1;
}

function emitEvidenceIngestFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: EvidenceIngestFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence ingest",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.path !== undefined) payload["path"] = failure.path;

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
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

type EvidenceListFailureCode =
  | "data_dir_failed"
  | "goal_not_found"
  | "source_item_not_found";

type EvidenceListFailure = {
  code: EvidenceListFailureCode;
  message: string;
  dataDir?: string;
  goalId?: string | null;
  sourceItemId?: string | null;
};

function evidenceList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for evidence list: ${parsed.args[2]}`,
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
    return emitEvidenceListFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const filters: ListEvidenceRecordsOptions = {};
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    filters.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    filters.sourceItemId = parsed.sourceItem;
  }
  if (parsed.source !== undefined && parsed.source.length > 0) {
    filters.source = parsed.source;
  }
  if (parsed.evidenceType !== undefined && parsed.evidenceType.length > 0) {
    filters.type = parsed.evidenceType;
  }
  if (parsed.limit !== undefined) {
    filters.limit = parsed.limit;
  }

  const db = openDb(dataDir);
  let records: EvidenceRecord[];
  try {
    if (filters.goalId !== undefined && filters.goalId !== null) {
      const goalRow = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(filters.goalId) as { id: string } | undefined;
      if (!goalRow) {
        return emitEvidenceListFailure(parsed, io, {
          code: "goal_not_found",
          message: `Goal not found: ${filters.goalId}`,
          dataDir,
          goalId: filters.goalId
        });
      }
    }
    if (filters.sourceItemId !== undefined && filters.sourceItemId !== null) {
      const itemRow = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(filters.sourceItemId) as { id: string } | undefined;
      if (!itemRow) {
        return emitEvidenceListFailure(parsed, io, {
          code: "source_item_not_found",
          message: `Source item not found: ${filters.sourceItemId}`,
          dataDir,
          sourceItemId: filters.sourceItemId
        });
      }
    }
    records = listEvidenceRecords(db, filters);
  } finally {
    db.close();
  }

  const payload = {
    ok: true,
    command: "evidence list",
    dataDir,
    goalId: filters.goalId ?? null,
    sourceItemId: filters.sourceItemId ?? null,
    source: filters.source ?? null,
    type: filters.type ?? null,
    limit: filters.limit ?? null,
    count: records.length,
    records: records.map(evidenceRecordToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Evidence records: ${records.length}`,
    `Goal: ${filters.goalId ?? "(any)"}`,
    `Source item: ${filters.sourceItemId ?? "(any)"}`,
    `Source: ${filters.source ?? "(any)"}`,
    `Type: ${filters.type ?? "(any)"}`,
    `Data dir: ${dataDir}`,
    ...records.map(
      (record) =>
        `- ${record.id} [${record.source}/${record.type}] @${record.occurredAt}: ${record.summary}` +
        (record.runId !== null ? ` run=${record.runId}` : "") +
        (record.stepId !== null ? ` step=${record.stepId}` : "")
    ),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function emitEvidenceListFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: EvidenceListFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: "evidence list",
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
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
