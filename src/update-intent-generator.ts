import type { MomentumDb } from "./db.js";
import type { EvidenceRecord } from "./evidence-records.js";
import { getSourceItemById, type SourceItem } from "./source-items.js";
import {
  createUpdateIntent,
  type UpdateIntent,
  type UpdateIntentClock
} from "./update-intents.js";

/**
 * Default workflow evidence types that signal a Goal's verification step has
 * completed cleanly. Override per-call via `verificationEvidenceTypes`. Kept
 * narrow on purpose so partial / setup-only artifacts (such as `plan_created`)
 * do not flip a Goal to "satisfied" prematurely.
 */
export const DEFAULT_VERIFICATION_EVIDENCE_TYPES: readonly string[] = [
  "no_mistakes_complete",
  "verification_passed",
  "merge_complete"
] as const;

const TERMINAL_GOAL_STATES = new Set([
  "completed",
  "failed",
  "max_iterations_reached"
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
    "merged"
  ].map((value) => value.toLowerCase())
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
  ingest_key: string;
  created_at: number;
  updated_at: number;
};

/**
 * Inspect a Goal's terminal state, its linked SourceItem, and the goal's
 * evidence records, then either create (or replay) a single durable
 * `source_satisfied` update intent or emit an `evidence_insufficient` warning.
 *
 * Idempotency: the intent's idempotency key is bound to the goal + adapter +
 * source external id, so repeated evaluations after additional evidence
 * ingestion do not duplicate intents.
 *
 * No external write is ever performed; the intent's status stays `pending`.
 */
export function evaluateGoalForSourceSatisfiedIntent(
  db: MomentumDb,
  input: EvaluateGoalForSourceSatisfiedIntentInput,
  clock: UpdateIntentClock = {}
): EvaluateGoalForSourceSatisfiedIntentResult {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("evaluateGoalForSourceSatisfiedIntent goalId must be a non-empty string");
  }

  const acceptedTypes = resolveAcceptedEvidenceTypes(
    input.verificationEvidenceTypes
  );

  const goal = db
    .prepare("SELECT id, state FROM goals WHERE id = ?")
    .get(input.goalId) as GoalRow | undefined;
  if (!goal) {
    return { outcome: "goal_not_found", goalId: input.goalId };
  }
  if (!TERMINAL_GOAL_STATES.has(goal.state)) {
    return {
      outcome: "goal_not_terminal",
      goalId: goal.id,
      goalState: goal.state
    };
  }
  if (goal.state !== COMPLETED_GOAL_STATE) {
    return {
      outcome: "goal_state_not_completed",
      goalId: goal.id,
      goalState: goal.state
    };
  }

  const sourceItem = findLinkedSourceItem(db, goal.id);
  if (!sourceItem) {
    return { outcome: "no_source_link", goalId: goal.id };
  }
  if (isSourceStatusTerminal(sourceItem.status)) {
    return { outcome: "source_already_terminal", sourceItem };
  }

  const evidence = findEarliestVerificationEvidence(db, goal.id, acceptedTypes);
  if (!evidence) {
    return {
      outcome: "evidence_insufficient",
      warning: {
        goalId: goal.id,
        goalState: goal.state,
        sourceItemId: sourceItem.id,
        sourceExternalId: sourceItem.externalId,
        adapterKind: sourceItem.adapterKind,
        acceptedEvidenceTypes: acceptedTypes,
        reason: `Goal ${goal.id} is completed but has no verification evidence (accepted types: ${acceptedTypes.join(", ")}).`
      }
    };
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
    sourceCurrentStatus: sourceItem.status
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
      idempotencyKey
    },
    clock
  );

  return {
    outcome: created.created ? "intent_created" : "intent_replayed",
    intent: created.intent,
    sourceItem,
    verificationEvidence: evidence
  };
}

function resolveAcceptedEvidenceTypes(
  override: readonly string[] | undefined
): readonly string[] {
  if (override === undefined) return DEFAULT_VERIFICATION_EVIDENCE_TYPES;
  if (!Array.isArray(override) || override.length === 0) {
    throw new Error(
      "evaluateGoalForSourceSatisfiedIntent verificationEvidenceTypes must be a non-empty array of strings"
    );
  }
  for (const value of override) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "evaluateGoalForSourceSatisfiedIntent verificationEvidenceTypes entries must be non-empty strings"
      );
    }
  }
  return override;
}

function findLinkedSourceItem(db: MomentumDb, goalId: string): SourceItem | null {
  const row = db
    .prepare(
      `SELECT id
         FROM source_items
        WHERE goal_id = ?
        ORDER BY adapter_kind ASC, external_key ASC, external_id ASC
        LIMIT 1`
    )
    .get(goalId) as { id: string } | undefined;
  if (!row) return null;
  return getSourceItemById(db, row.id);
}

function findEarliestVerificationEvidence(
  db: MomentumDb,
  goalId: string,
  acceptedTypes: readonly string[]
): EvidenceRecord | null {
  const placeholders = acceptedTypes.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT *
         FROM evidence_records
        WHERE goal_id = ?
          AND type IN (${placeholders})
        ORDER BY occurred_at ASC, created_at ASC, id ASC
        LIMIT 1`
    )
    .get(goalId, ...acceptedTypes) as EvidenceRow | undefined;
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
    ingestKey: row.ingest_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
