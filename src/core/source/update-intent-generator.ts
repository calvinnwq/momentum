import type { MomentumDb } from "../../adapters/db.js";
import type { EvidenceRecord } from "../evidence/records.js";
import { getSourceItemById, type SourceItem } from "./items.js";
import {
  createUpdateIntent,
  type UpdateIntent,
  type UpdateIntentClock,
} from "../intent/update-intents.js";

/**
 * Default workflow evidence types that signal a Goal's verification step has
 * completed cleanly. Override per-call via `verificationEvidenceTypes`. Kept
 * narrow on purpose so partial / setup-only artifacts (such as `plan_created`)
 * do not flip a Goal to "satisfied" prematurely.
 */
export const DEFAULT_VERIFICATION_EVIDENCE_TYPES: readonly string[] = [
  "no_mistakes_complete",
  "verification_passed",
  "merge_complete",
] as const;

const TERMINAL_GOAL_STATES = new Set([
  "completed",
  "failed",
  "max_iterations_reached",
]);
const COMPLETED_GOAL_STATE = "completed";

const TERMINAL_SOURCE_STATUSES = new Set(
  [
    "done",
    "completed",
    "closed",
    "canceled",
    "cancelled",
    "duplicate",
    "won't do",
    "wont do",
    "resolved",
    "merged",
  ].map((value) => value.toLowerCase()),
);

export type EvaluateGoalForSourceSatisfiedIntentInput = {
  goalId: string;
  verificationEvidenceTypes?: readonly string[];
};

export type EvidenceInsufficientWarning = {
  goalId: string;
  goalState: string;
  sourceItemId: string;
  sourceExternalId: string;
  adapterKind: string;
  acceptedEvidenceTypes: readonly string[];
  reason: string;
};

export type EvaluateGoalForSourceSatisfiedIntentResult =
  | {
      outcome: "intent_created";
      intent: UpdateIntent;
      sourceItem: SourceItem;
      verificationEvidence: EvidenceRecord;
    }
  | {
      outcome: "intent_replayed";
      intent: UpdateIntent;
      sourceItem: SourceItem;
      verificationEvidence: EvidenceRecord;
    }
  | {
      outcome: "evidence_insufficient";
      warning: EvidenceInsufficientWarning;
    }
  | { outcome: "goal_not_found"; goalId: string }
  | { outcome: "goal_not_terminal"; goalId: string; goalState: string }
  | { outcome: "goal_state_not_completed"; goalId: string; goalState: string }
  | { outcome: "no_source_link"; goalId: string }
  | { outcome: "source_already_terminal"; sourceItem: SourceItem };

type GoalRow = {
  id: string;
  state: string;
};

type EvidenceRow = {
  id: string;
  source: string;
  type: string;
  format_version: number;
  artifact_path: string | null;
  external_id: string | null;
  occurred_at: number;
  summary: string;
  metadata_json: string;
  goal_id: string | null;
  source_item_id: string | null;
  run_id: string | null;
  step_id: string | null;
  ingest_key: string;
  created_at: number;
  updated_at: number;
};

/**
 * Inspect a Goal's terminal state, its linked SourceItems, and the goal/source
 * evidence records, then create (or replay) durable `source_satisfied` update
 * intents for every linked open SourceItem with verification evidence. A
 * completed Goal can have multiple linked open SourceItems and therefore
 * multiple pending intents.
 *
 * Idempotency: the intent's idempotency key is bound to the goal + adapter +
 * source external id, so repeated evaluations after additional evidence
 * ingestion do not duplicate intents.
 *
 * No external write is ever performed; the intent's status stays `pending`.
 */
export function evaluateGoalForSourceSatisfiedIntents(
  db: MomentumDb,
  input: EvaluateGoalForSourceSatisfiedIntentInput,
  clock: UpdateIntentClock = {},
): EvaluateGoalForSourceSatisfiedIntentResult[] {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error(
      "evaluateGoalForSourceSatisfiedIntent goalId must be a non-empty string",
    );
  }

  const acceptedTypes = resolveAcceptedEvidenceTypes(
    input.verificationEvidenceTypes,
  );

  const goal = db
    .prepare("SELECT id, state FROM goals WHERE id = ?")
    .get(input.goalId) as GoalRow | undefined;
  if (!goal) {
    return [{ outcome: "goal_not_found", goalId: input.goalId }];
  }
  if (!TERMINAL_GOAL_STATES.has(goal.state)) {
    return [
      {
        outcome: "goal_not_terminal",
        goalId: goal.id,
        goalState: goal.state,
      },
    ];
  }
  if (goal.state !== COMPLETED_GOAL_STATE) {
    return [
      {
        outcome: "goal_state_not_completed",
        goalId: goal.id,
        goalState: goal.state,
      },
    ];
  }

  const sourceItems = findLinkedSourceItems(db, goal.id);
  if (sourceItems.length === 0) {
    return [{ outcome: "no_source_link", goalId: goal.id }];
  }
  const openSourceItems = sourceItems.filter(
    (sourceItem) => !isSourceStatusTerminal(sourceItem.status),
  );
  if (openSourceItems.length === 0) {
    return [
      { outcome: "source_already_terminal", sourceItem: sourceItems[0]! },
    ];
  }

  const evidenceWarnings: EvidenceInsufficientWarning[] = [];
  const results: Extract<
    EvaluateGoalForSourceSatisfiedIntentResult,
    { outcome: "intent_created" | "intent_replayed" }
  >[] = [];

  for (const sourceItem of openSourceItems) {
    const evidence = findEarliestVerificationEvidence(
      db,
      goal.id,
      sourceItem.id,
      acceptedTypes,
    );
    if (!evidence) {
      const warning: EvidenceInsufficientWarning = {
        goalId: goal.id,
        goalState: goal.state,
        sourceItemId: sourceItem.id,
        sourceExternalId: sourceItem.externalId,
        adapterKind: sourceItem.adapterKind,
        acceptedEvidenceTypes: acceptedTypes,
        reason: `Goal ${goal.id} is completed but has no verification evidence for source item ${sourceItem.externalKey ?? sourceItem.externalId} (accepted types: ${acceptedTypes.join(", ")}).`,
      };
      evidenceWarnings.push(warning);
      continue;
    }

    const idempotencyKey = `${sourceItem.adapterKind}:${sourceItem.externalId}:source_satisfied:${goal.id}`;
    const reason = `Goal completed with verification evidence (${evidence.type}); source item ${sourceItem.externalKey ?? sourceItem.externalId} appears satisfied.`;
    const payload: Record<string, unknown> = {
      goalState: goal.state,
      evidenceType: evidence.type,
      evidenceSource: evidence.source,
      evidenceOccurredAt: evidence.occurredAt,
      sourceItemId: sourceItem.id,
      sourceExternalId: sourceItem.externalId,
      sourceExternalKey: sourceItem.externalKey,
      sourceCurrentStatus: sourceItem.status,
    };

    const created = createUpdateIntent(
      db,
      {
        adapterKind: sourceItem.adapterKind,
        targetExternalId: sourceItem.externalId,
        intentType: "source_satisfied",
        payload,
        reason,
        goalId: goal.id,
        sourceItemId: sourceItem.id,
        evidenceRecordId: evidence.id,
        idempotencyKey,
      },
      clock,
    );

    results.push({
      outcome: created.created ? "intent_created" : "intent_replayed",
      intent: created.intent,
      sourceItem,
      verificationEvidence: evidence,
    });
  }

  const warningResults: EvaluateGoalForSourceSatisfiedIntentResult[] =
    evidenceWarnings.map((warning) => ({
      outcome: "evidence_insufficient",
      warning,
    }));
  if (results.length > 0) return [...results, ...warningResults];
  return warningResults;
}

function resolveAcceptedEvidenceTypes(
  override: readonly string[] | undefined,
): readonly string[] {
  if (override === undefined) return DEFAULT_VERIFICATION_EVIDENCE_TYPES;
  if (!Array.isArray(override) || override.length === 0) {
    throw new Error(
      "evaluateGoalForSourceSatisfiedIntent verificationEvidenceTypes must be a non-empty array of strings",
    );
  }
  for (const value of override) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "evaluateGoalForSourceSatisfiedIntent verificationEvidenceTypes entries must be non-empty strings",
      );
    }
  }
  return override;
}

function findLinkedSourceItems(db: MomentumDb, goalId: string): SourceItem[] {
  const rows = db
    .prepare(
      `SELECT id
         FROM source_items
        WHERE goal_id = ?
        ORDER BY adapter_kind ASC, external_key ASC, external_id ASC`,
    )
    .all(goalId) as { id: string }[];
  return rows
    .map((row) => getSourceItemById(db, row.id))
    .filter((sourceItem): sourceItem is SourceItem => sourceItem !== null);
}

function findEarliestVerificationEvidence(
  db: MomentumDb,
  goalId: string,
  sourceItemId: string,
  acceptedTypes: readonly string[],
): EvidenceRecord | null {
  const placeholders = acceptedTypes.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT *
         FROM evidence_records
        WHERE (goal_id = ? OR source_item_id = ?)
          AND type IN (${placeholders})
        ORDER BY occurred_at ASC, created_at ASC, id ASC
        LIMIT 1`,
    )
    .get(goalId, sourceItemId, ...acceptedTypes) as EvidenceRow | undefined;
  if (!row) return null;
  return evidenceRecordFromRow(row);
}

function evidenceRecordFromRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    formatVersion: row.format_version,
    artifactPath: row.artifact_path,
    externalId: row.external_id,
    occurredAt: row.occurred_at,
    summary: row.summary,
    metadata: parseJsonObject(row.metadata_json),
    goalId: row.goal_id,
    sourceItemId: row.source_item_id,
    runId: row.run_id,
    stepId: row.step_id,
    ingestKey: row.ingest_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function isSourceStatusTerminal(status: string | null): boolean {
  if (!status) return false;
  return TERMINAL_SOURCE_STATUSES.has(status.trim().toLowerCase());
}
