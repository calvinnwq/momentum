import { usageError, type CliIo } from "../../renderers/cli-output.js";
import { openDb, type MomentumDb } from "../../adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  ingestEvidenceRecord,
  listEvidenceRecords,
  type EvidenceRecord,
  type EvidenceRecordIngestInput,
  type ListEvidenceRecordsOptions
} from "../../evidence-records.js";
import { parseWorkflowArtifact } from "../../evidence-workflow.js";
import { getSourceItemById } from "../../source-items.js";
import {
  emitEvidenceIngestFailure,
  emitEvidenceIngestSuccess,
  emitEvidenceList,
  emitEvidenceListFailure
} from "../../renderers/evidence.js";
import {
  evaluateGoalForSourceSatisfiedIntents,
  type EvaluateGoalForSourceSatisfiedIntentResult
} from "../../update-intent-generator.js";

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; goal?: string; path?: string; sourceItem?: string; source?: string; evidenceType?: string; limit?: number;
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

  return emitEvidenceList(parsed, io, { dataDir, filters, records });
}
