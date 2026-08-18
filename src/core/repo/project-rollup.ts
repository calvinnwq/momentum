/**
 * Project rollup.
 *
 * Computes an operator-facing summary of TrackerItem / Goal / evidence /
 * reconciliation state from local durable records only. Never calls tracker
 * adapters or runs external API requests. Filter scope is tracker-centric:
 * goals are included when they are linked to the effective rollup item after
 * Linear external-key dedupe and project / milestone filters.
 *
 * Duplicate Linear rows that share an externalKey collapse to one effective item
 * before project / milestone filters run. UUID-backed rows win over legacy
 * key-only rows, with freshest lastObservedAt used inside the chosen candidate
 * set. Goal links, tracker-item evidence, and tracker-item pending intents from
 * every collapsed row remain in scope for rollup counts, mismatches, evidence,
 * and pending intents.
 *
 * Pending intents are read from local durable state and
 * scoped to the same TrackerItem / Goal set so the rollup never widens past
 * the operator's filter context. Stale pending intents are flagged via a
 * configurable TTL (default 30 days); the rollup never auto-deletes intents.
 */

import type { MomentumDb } from "../../adapters/db.js";
import { listTrackerItems, type TrackerItem } from "../tracker/items.js";
import {
  listTrackerReconciliationRuns,
  type TrackerReconciliationRun,
} from "../tracker/reconciliation-runs.js";
import { listIntents, type Intent } from "../intent/intents.js";
import {
  summarizeIntentApplyAuditsForIntent,
  type IntentApplyAudit,
  type IntentApplyAuditCounts,
  type IntentApplyState,
  type IntentApplyStateCounts,
} from "../intent/apply-audits.js";

export const DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INTENT_STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT = 20;

const TERMINAL_TRACKER_STATUSES = new Set(
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

const TERMINAL_GOAL_STATES = new Set([
  "completed",
  "failed",
  "max_iterations_reached",
]);
const COMPLETED_GOAL_STATE = "completed";

export type ProjectRollupFilters = {
  adapterKind?: string;
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
};

export type ProjectRollupOptions = {
  filters?: ProjectRollupFilters;
  reconciliationStaleThresholdMs?: number;
  intentStaleThresholdMs?: number;
  now?: number;
};

export type ProjectRollupTrackerItemSummary = {
  trackerItemId: string;
  adapterKind: string;
  externalId: string;
  externalKey: string | null;
  title: string;
  url: string | null;
  status: string | null;
  lastObservedAt: number;
  goalId: string | null;
  goalState: string | null;
};

export type ProjectRollupMismatchKind =
  | "tracker_done_goal_not_terminal"
  | "goal_done_tracker_not_done"
  | "evidence_missing_after_completion"
  | "manual_recovery_required";

export type ProjectRollupMismatch = {
  kind: ProjectRollupMismatchKind;
  trackerItemId: string;
  externalKey: string | null;
  title: string;
  goalId: string | null;
  goalState: string | null;
  trackerStatus: string | null;
};

export type ProjectRollupReconciliationWarningReason =
  "never_run" | "stale" | "last_failed";

export type ProjectRollupReconciliationWarning = {
  adapterKind: string;
  lastRunState: "running" | "succeeded" | "failed" | null;
  lastRunFinishedAt: number | null;
  ageMs: number | null;
  reason: ProjectRollupReconciliationWarningReason;
  error: string | null;
};

export type ProjectRollupNextActionKind =
  | "manual_recovery_required"
  | "reconcile_failed"
  | "reconcile_stale_tracker"
  | "address_mismatch"
  | "missing_evidence"
  | "review_pending_intents"
  | "no_action_required";

export type ProjectRollupPendingIntentExternalApply = {
  applyState: IntentApplyState;
  totalAttempts: number;
  counts: IntentApplyAuditCounts;
  latestAttempt: IntentApplyAudit | null;
};

export type ProjectRollupPendingIntentSummary = {
  intentId: string;
  adapterKind: string;
  intentType: string;
  targetExternalId: string | null;
  reason: string;
  goalId: string | null;
  trackerItemId: string | null;
  evidenceRecordId: string | null;
  createdAt: number;
  ageMs: number;
  stale: boolean;
  externalApply: ProjectRollupPendingIntentExternalApply;
};

export type ProjectRollupExternalApply = {
  pendingIntentApplyStateCounts: IntentApplyStateCounts;
  pendingAuditCounts: IntentApplyAuditCounts;
  totalAttempts: number;
  latestAttempt: IntentApplyAudit | null;
};

export type ProjectRollupNextAction = {
  kind: ProjectRollupNextActionKind;
  message: string;
  detail: Record<string, unknown>;
};

export type ProjectRollupCounts = {
  trackerItems: {
    total: number;
    byStatus: Record<string, number>;
    linkedToGoal: number;
    unlinked: number;
  };
  goals: {
    total: number;
    byState: Record<string, number>;
    needingManualRecovery: number;
  };
  evidence: {
    totalRecords: number;
    goalsWithEvidence: number;
    goalsWithoutEvidence: number;
  };
  mismatches: Record<ProjectRollupMismatchKind, number>;
  pendingIntents: number;
  staleIntents: number;
};

export type ProjectRollup = {
  filters: ProjectRollupFilters;
  generatedAt: number;
  reconciliationStaleThresholdMs: number;
  intentStaleThresholdMs: number;
  counts: ProjectRollupCounts;
  trackerItems: ProjectRollupTrackerItemSummary[];
  totalTrackerItemCount: number;
  truncatedTrackerItems: boolean;
  mismatches: ProjectRollupMismatch[];
  totalMismatchCount: number;
  truncatedMismatches: boolean;
  reconciliationWarnings: ProjectRollupReconciliationWarning[];
  pendingIntents: ProjectRollupPendingIntentSummary[];
  totalPendingIntentCount: number;
  truncatedPendingIntents: boolean;
  externalApply: ProjectRollupExternalApply;
  nextAction: ProjectRollupNextAction;
};

type GoalSnapshot = {
  id: string;
  state: string;
  needsManualRecovery: boolean;
};

type RollupTrackerItemGoalLink = {
  trackerItemId: string;
  goalId: string;
};

type RollupTrackerItem = TrackerItem & {
  rollupTrackerItemIds: readonly string[];
  rollupGoalIds: readonly string[];
  rollupTrackerItemGoalLinks: readonly RollupTrackerItemGoalLink[];
};

export function buildProjectRollup(
  db: MomentumDb,
  options: ProjectRollupOptions = {},
): ProjectRollup {
  const filters = options.filters ?? {};
  const reconciliationStaleThresholdMs = resolveStaleThreshold(
    options.reconciliationStaleThresholdMs,
    "reconciliationStaleThresholdMs",
    DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS,
  );
  const intentStaleThresholdMs = resolveStaleThreshold(
    options.intentStaleThresholdMs,
    "intentStaleThresholdMs",
    DEFAULT_INTENT_STALE_THRESHOLD_MS,
  );
  const generatedAt = options.now ?? Date.now();

  const allItems = listTrackerItems(
    db,
    filters.adapterKind === undefined
      ? {}
      : { adapterKind: filters.adapterKind },
  );
  const rollupItems = dedupeLinearTrackerItemsForRollup(allItems).filter(
    (item) => matchesProjectMilestoneFilters(item, filters),
  );

  const linkedGoalIds = collectLinkedGoalIds(rollupItems);
  const goals =
    linkedGoalIds.size === 0
      ? new Map<string, GoalSnapshot>()
      : loadGoalSnapshots(db, linkedGoalIds);
  const goalsWithEvidence =
    goals.size === 0
      ? new Set<string>()
      : loadGoalsWithEvidence(db, goals, rollupItems);
  const evidenceTotal =
    goals.size === 0 ? 0 : countEvidenceRecordsForGoals(db, goals, rollupItems);

  const summaries = buildTrackerItemSummaries(rollupItems, goals);
  const mismatches = buildMismatches(rollupItems, goals, goalsWithEvidence);
  const pendingIntents = buildPendingIntentSummaries(
    db,
    filters,
    rollupItems,
    goals,
    generatedAt,
    intentStaleThresholdMs,
  );
  const counts = computeCounts(
    rollupItems,
    goals,
    goalsWithEvidence,
    mismatches,
    evidenceTotal,
    pendingIntents,
  );
  const reconciliationWarnings = buildReconciliationWarnings(
    db,
    filters.adapterKind,
    filters,
    generatedAt,
    reconciliationStaleThresholdMs,
    rollupItems,
  );
  const nextAction = pickNextAction(
    counts,
    mismatches,
    reconciliationWarnings,
    pendingIntents,
  );

  const truncatedTrackerItems =
    summaries.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;
  const truncatedMismatches =
    mismatches.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;
  const truncatedPendingIntents =
    pendingIntents.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;

  const externalApply = buildExternalApplyRollup(pendingIntents);

  return {
    filters,
    generatedAt,
    reconciliationStaleThresholdMs,
    intentStaleThresholdMs,
    counts,
    trackerItems: summaries.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalTrackerItemCount: summaries.length,
    truncatedTrackerItems,
    mismatches: mismatches.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalMismatchCount: mismatches.length,
    truncatedMismatches,
    reconciliationWarnings,
    pendingIntents: pendingIntents.slice(
      0,
      PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT,
    ),
    totalPendingIntentCount: pendingIntents.length,
    truncatedPendingIntents: truncatedPendingIntents,
    externalApply,
    nextAction,
  };
}

function buildExternalApplyRollup(
  pendingIntents: readonly ProjectRollupPendingIntentSummary[],
): ProjectRollupExternalApply {
  const intentApplyStateCounts: IntentApplyStateCounts = {
    idle: 0,
    in_flight: 0,
    blocked: 0,
  };
  const auditCounts: IntentApplyAuditCounts = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    audit_incomplete: 0,
  };
  let totalAttempts = 0;
  let latestAttempt: IntentApplyAudit | null = null;
  for (const intent of pendingIntents) {
    intentApplyStateCounts[intent.externalApply.applyState] += 1;
    const counts = intent.externalApply.counts;
    auditCounts.claimed += counts.claimed;
    auditCounts.succeeded += counts.succeeded;
    auditCounts.failed += counts.failed;
    auditCounts.blocked += counts.blocked;
    auditCounts.audit_incomplete += counts.audit_incomplete;
    totalAttempts += intent.externalApply.totalAttempts;
    const candidate = intent.externalApply.latestAttempt;
    if (!candidate) continue;
    if (
      !latestAttempt ||
      candidate.requestedAt > latestAttempt.requestedAt ||
      (candidate.requestedAt === latestAttempt.requestedAt &&
        candidate.id > latestAttempt.id)
    ) {
      latestAttempt = candidate;
    }
  }
  return {
    pendingIntentApplyStateCounts: intentApplyStateCounts,
    pendingAuditCounts: auditCounts,
    totalAttempts,
    latestAttempt,
  };
}

function resolveStaleThreshold(
  value: number | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative finite number, got ${value}`,
    );
  }
  return value;
}

function matchesProjectMilestoneFilters(
  item: TrackerItem,
  filters: ProjectRollupFilters,
): boolean {
  if (
    filters.projectId === undefined &&
    filters.projectName === undefined &&
    filters.milestoneId === undefined &&
    filters.milestoneName === undefined
  ) {
    return true;
  }
  if (
    !matchesMetadataFilter(
      item.metadata,
      "project",
      filters.projectId,
      filters.projectName,
    )
  ) {
    return false;
  }
  if (
    !matchesMetadataFilter(
      item.metadata,
      "milestone",
      filters.milestoneId,
      filters.milestoneName,
    )
  ) {
    return false;
  }
  return true;
}

function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  key: "project" | "milestone",
  idFilter: string | undefined,
  nameFilter: string | undefined,
): boolean {
  if (idFilter === undefined && nameFilter === undefined) return true;

  const value = metadata[key];
  if (typeof value === "string" && value.length > 0) {
    return value === idFilter || value === nameFilter;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (idFilter !== undefined && readString(record, "id") === idFilter)
    return true;
  if (nameFilter !== undefined && readString(record, "name") === nameFilter) {
    return true;
  }
  return false;
}

function readMetadataValues(
  metadata: Record<string, unknown>,
  key: "project" | "milestone",
): string[] {
  const value = metadata[key];
  if (typeof value === "string") {
    return readCompactStringArray([value]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const objectValue = value as Record<string, unknown>;
  return readCompactStringArray([
    readString(objectValue, "id"),
    readString(objectValue, "name"),
  ]);
}

function readNested(
  metadata: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCompactStringArray(values: Array<string | null>): string[] {
  const compact = values.filter((value): value is string => value !== null);
  return [...new Set(compact)];
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function collectLinkedGoalIds(
  items: readonly RollupTrackerItem[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const goalId of item.rollupGoalIds) {
      ids.add(goalId);
    }
  }
  return ids;
}

type GoalRow = {
  id: string;
  state: string;
  needs_manual_recovery: number;
};

function loadGoalSnapshots(
  db: MomentumDb,
  goalIds: Set<string>,
): Map<string, GoalSnapshot> {
  const ids = [...goalIds];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, state, needs_manual_recovery
         FROM goals
        WHERE id IN (${placeholders})`,
    )
    .all(...ids) as GoalRow[];
  const map = new Map<string, GoalSnapshot>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      state: row.state,
      needsManualRecovery: row.needs_manual_recovery === 1,
    });
  }
  return map;
}

function loadGoalsWithEvidence(
  db: MomentumDb,
  goals: Map<string, GoalSnapshot>,
  items: readonly RollupTrackerItem[],
): Set<string> {
  if (goals.size === 0) return new Set();
  const goalIds = [...goals.keys()];
  const trackerItemGoalIds = collectLinkedTrackerItemGoalIds(items, goals);
  const trackerItemIds = [...trackerItemGoalIds.keys()];
  const clauses: string[] = [];
  const params: string[] = [];
  if (goalIds.length > 0) {
    clauses.push(`goal_id IN (${goalIds.map(() => "?").join(", ")})`);
    params.push(...goalIds);
  }
  if (trackerItemIds.length > 0) {
    clauses.push(
      `tracker_item_id IN (${trackerItemIds.map(() => "?").join(", ")})`,
    );
    params.push(...trackerItemIds);
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT goal_id AS goal_id, tracker_item_id AS tracker_item_id
         FROM evidence_records
        WHERE ${clauses.join(" OR ")}`,
    )
    .all(...params) as {
    goal_id: string | null;
    tracker_item_id: string | null;
  }[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.goal_id !== null && goals.has(row.goal_id)) ids.add(row.goal_id);
    if (row.tracker_item_id !== null) {
      const linkedGoalIds = trackerItemGoalIds.get(row.tracker_item_id) ?? [];
      for (const linkedGoalId of linkedGoalIds) {
        ids.add(linkedGoalId);
      }
    }
  }
  return ids;
}

function countEvidenceRecordsForGoals(
  db: MomentumDb,
  goals: Map<string, GoalSnapshot>,
  items: readonly RollupTrackerItem[],
): number {
  if (goals.size === 0) return 0;
  const goalIds = [...goals.keys()];
  const trackerItemIds = [
    ...collectLinkedTrackerItemGoalIds(items, goals).keys(),
  ];
  const clauses: string[] = [];
  const params: string[] = [];
  if (goalIds.length > 0) {
    clauses.push(`goal_id IN (${goalIds.map(() => "?").join(", ")})`);
    params.push(...goalIds);
  }
  if (trackerItemIds.length > 0) {
    clauses.push(
      `tracker_item_id IN (${trackerItemIds.map(() => "?").join(", ")})`,
    );
    params.push(...trackerItemIds);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM evidence_records
        WHERE ${clauses.join(" OR ")}`,
    )
    .get(...params) as { total: number } | undefined;
  return row?.total ?? 0;
}

function collectLinkedTrackerItemGoalIds(
  items: readonly RollupTrackerItem[],
  goals: Map<string, GoalSnapshot>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    for (const link of item.rollupTrackerItemGoalLinks) {
      if (!goals.has(link.goalId)) continue;
      const linkedGoalIds = map.get(link.trackerItemId) ?? [];
      if (linkedGoalIds.includes(link.goalId)) continue;
      linkedGoalIds.push(link.goalId);
      map.set(link.trackerItemId, linkedGoalIds);
    }
  }
  return map;
}

function buildTrackerItemSummaries(
  items: readonly RollupTrackerItem[],
  goals: Map<string, GoalSnapshot>,
): ProjectRollupTrackerItemSummary[] {
  return items
    .slice()
    .sort(trackerItemOrder)
    .map((item) => {
      const goal = item.goalId ? (goals.get(item.goalId) ?? null) : null;
      return {
        trackerItemId: item.id,
        adapterKind: item.adapterKind,
        externalId: item.externalId,
        externalKey: item.externalKey,
        title: item.title,
        url: item.url,
        status: item.status,
        lastObservedAt: item.lastObservedAt,
        goalId: item.goalId,
        goalState: goal?.state ?? null,
      };
    });
}

function dedupeLinearTrackerItemsForRollup(
  items: readonly TrackerItem[],
): RollupTrackerItem[] {
  if (items.length <= 1) {
    return items
      .map((item) => toRollupTrackerItem(item))
      .sort(trackerItemOrder);
  }

  const groupedByAdapterAndKey = new Map<string, TrackerItem[]>();
  const passthroughItems: TrackerItem[] = [];
  for (const item of items) {
    if (item.adapterKind !== "linear" || item.externalKey === null) {
      passthroughItems.push(item);
      continue;
    }
    const key = `${item.adapterKind}\u0000${item.externalKey}`;
    const bucket = groupedByAdapterAndKey.get(key);
    if (bucket === undefined) {
      groupedByAdapterAndKey.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }

  const deduped: RollupTrackerItem[] = passthroughItems.map((item) =>
    toRollupTrackerItem(item),
  );
  for (const bucket of groupedByAdapterAndKey.values()) {
    if (bucket.length === 1) {
      deduped.push(toRollupTrackerItem(bucket[0]!));
      continue;
    }
    const canonicalCandidates = bucket.filter((item) =>
      isCanonicalLinearUuidRow(item),
    );
    const candidates =
      canonicalCandidates.length > 0 ? canonicalCandidates : bucket;
    deduped.push(
      toRollupTrackerItem(selectPreferredTrackerItem(candidates), bucket),
    );
  }

  return deduped.sort(trackerItemOrder);
}

function toRollupTrackerItem(
  item: TrackerItem,
  bucket: readonly TrackerItem[] = [item],
): RollupTrackerItem {
  const trackerItemGoalLinks = readRollupTrackerItemGoalLinks(bucket);
  const linkedGoalIds = readRollupGoalIds(trackerItemGoalLinks);
  return {
    ...item,
    goalId: item.goalId,
    rollupTrackerItemIds: readRollupTrackerItemIds(bucket),
    rollupGoalIds: linkedGoalIds,
    rollupTrackerItemGoalLinks: trackerItemGoalLinks,
  };
}

function readRollupTrackerItemIds(items: readonly TrackerItem[]): string[] {
  return [...new Set(items.map((item) => item.id))].sort();
}

function readRollupTrackerItemGoalLinks(
  items: readonly TrackerItem[],
): RollupTrackerItemGoalLink[] {
  const links = new Map<string, RollupTrackerItemGoalLink>();
  for (const item of items.slice().sort(trackerItemOrder)) {
    if (item.goalId === null) continue;
    const key = `${item.id}\u0000${item.goalId}`;
    links.set(key, { trackerItemId: item.id, goalId: item.goalId });
  }
  return [...links.values()];
}

function readRollupGoalIds(
  links: readonly RollupTrackerItemGoalLink[],
): string[] {
  return [...new Set(links.map((link) => link.goalId))];
}

const LINEAR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalLinearUuidRow(item: TrackerItem): boolean {
  return (
    item.adapterKind === "linear" &&
    item.externalKey !== null &&
    item.externalId !== item.externalKey &&
    LINEAR_UUID_RE.test(item.externalId)
  );
}

function selectPreferredTrackerItem(
  items: readonly TrackerItem[],
): TrackerItem {
  let best = items[0];
  if (best === undefined) {
    throw new Error(
      "selectPreferredTrackerItem requires at least one tracker item.",
    );
  }

  for (const candidate of items.slice(1)) {
    if (candidate.lastObservedAt !== best.lastObservedAt) {
      best = candidate.lastObservedAt > best.lastObservedAt ? candidate : best;
      continue;
    }
    if (trackerItemOrder(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

function trackerItemOrder(a: TrackerItem, b: TrackerItem): number {
  if (a.adapterKind !== b.adapterKind) {
    return a.adapterKind < b.adapterKind ? -1 : 1;
  }
  const aKey = a.externalKey ?? a.externalId;
  const bKey = b.externalKey ?? b.externalId;
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return a.externalId < b.externalId ? -1 : 1;
}

function buildMismatches(
  items: readonly RollupTrackerItem[],
  goals: Map<string, GoalSnapshot>,
  goalsWithEvidence: Set<string>,
): ProjectRollupMismatch[] {
  const mismatches: ProjectRollupMismatch[] = [];
  const reportedManualRecovery = new Set<string>();
  const reportedMissingEvidence = new Set<string>();
  for (const item of items.slice().sort(trackerItemOrder)) {
    for (const goalId of item.rollupGoalIds) {
      const goal = goals.get(goalId) ?? null;
      if (!goal) continue;
      const trackerDone = isTrackerStatusTerminal(item.status);
      const goalDone = goal.state === COMPLETED_GOAL_STATE;
      const goalTerminal = TERMINAL_GOAL_STATES.has(goal.state);
      if (trackerDone && !goalTerminal) {
        mismatches.push(
          buildMismatch("tracker_done_goal_not_terminal", item, goal),
        );
      }
      if (goalDone && !trackerDone) {
        mismatches.push(
          buildMismatch("goal_done_tracker_not_done", item, goal),
        );
      }
      if (
        goalDone &&
        !goalsWithEvidence.has(goal.id) &&
        !reportedMissingEvidence.has(goal.id)
      ) {
        mismatches.push(
          buildMismatch("evidence_missing_after_completion", item, goal),
        );
        reportedMissingEvidence.add(goal.id);
      }
      if (goal.needsManualRecovery && !reportedManualRecovery.has(goal.id)) {
        mismatches.push(buildMismatch("manual_recovery_required", item, goal));
        reportedManualRecovery.add(goal.id);
      }
    }
  }
  return mismatches;
}

function buildMismatch(
  kind: ProjectRollupMismatchKind,
  item: RollupTrackerItem,
  goal: GoalSnapshot,
): ProjectRollupMismatch {
  return {
    kind,
    trackerItemId: item.id,
    externalKey: item.externalKey,
    title: item.title,
    goalId: goal.id,
    goalState: goal.state,
    trackerStatus: item.status,
  };
}

function isTrackerStatusTerminal(status: string | null): boolean {
  if (!status) return false;
  return TERMINAL_TRACKER_STATUSES.has(status.trim().toLowerCase());
}

function computeCounts(
  items: readonly RollupTrackerItem[],
  goals: Map<string, GoalSnapshot>,
  goalsWithEvidence: Set<string>,
  mismatches: readonly ProjectRollupMismatch[],
  evidenceTotal: number,
  pendingIntents: readonly ProjectRollupPendingIntentSummary[],
): ProjectRollupCounts {
  const byStatus: Record<string, number> = {};
  let linkedToGoal = 0;
  let unlinked = 0;
  for (const item of items) {
    const key = item.status ?? "(none)";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    if (item.rollupGoalIds.length > 0) linkedToGoal += 1;
    else unlinked += 1;
  }
  const byGoalState: Record<string, number> = {};
  let needingManualRecovery = 0;
  for (const goal of goals.values()) {
    byGoalState[goal.state] = (byGoalState[goal.state] ?? 0) + 1;
    if (goal.needsManualRecovery) needingManualRecovery += 1;
  }
  const mismatchCounts: Record<ProjectRollupMismatchKind, number> = {
    tracker_done_goal_not_terminal: 0,
    goal_done_tracker_not_done: 0,
    evidence_missing_after_completion: 0,
    manual_recovery_required: 0,
  };
  for (const mismatch of mismatches) {
    mismatchCounts[mismatch.kind] += 1;
  }
  const goalsWithoutEvidence = [...goals.values()].filter(
    (goal) =>
      goal.state === COMPLETED_GOAL_STATE && !goalsWithEvidence.has(goal.id),
  ).length;
  const stalePendingIntents = pendingIntents.filter(
    (intent) => intent.stale,
  ).length;
  return {
    trackerItems: {
      total: items.length,
      byStatus,
      linkedToGoal,
      unlinked,
    },
    goals: {
      total: goals.size,
      byState: byGoalState,
      needingManualRecovery,
    },
    evidence: {
      totalRecords: evidenceTotal,
      goalsWithEvidence: goalsWithEvidence.size,
      goalsWithoutEvidence,
    },
    mismatches: mismatchCounts,
    pendingIntents: pendingIntents.length,
    staleIntents: stalePendingIntents,
  };
}

function buildReconciliationWarnings(
  db: MomentumDb,
  adapterKind: string | undefined,
  filters: ProjectRollupFilters,
  now: number,
  staleThresholdMs: number,
  items: readonly TrackerItem[],
): ProjectRollupReconciliationWarning[] {
  if (items.length === 0) {
    return [];
  }

  const runs = listTrackerReconciliationRuns(
    db,
    adapterKind === undefined ? {} : { adapterKind },
  );
  if (runs.length === 0) {
    const adapters =
      adapterKind === undefined
        ? [...new Set(items.map((item) => item.adapterKind))].sort()
        : [adapterKind];
    return adapters.map((adapter) => ({
      adapterKind: adapter,
      lastRunState: null,
      lastRunFinishedAt: null,
      ageMs: null,
      reason: "never_run",
      error: null,
    }));
  }
  const byAdapter = new Map<string, ProjectRollupReconciliationWarning>();
  const adapters =
    adapterKind === undefined
      ? new Set(items.map((item) => item.adapterKind))
      : new Set([adapterKind]);
  for (const adapter of adapters) {
    const adapterItems = items.filter((item) => item.adapterKind === adapter);
    const adapterRuns = runs.filter(
      (run) =>
        run.adapterKind === adapter &&
        runCoversFilteredRollup(run, filters, adapterItems),
    );
    if (adapterRuns.length === 0) {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: null,
        lastRunFinishedAt: null,
        ageMs: null,
        reason: "never_run",
        error: null,
      });
      continue;
    }
    const last = selectReconciliationRunForWarning(
      adapterRuns,
      now,
      staleThresholdMs,
    );
    if (last === null) {
      continue;
    }
    if (last === undefined) {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: null,
        lastRunFinishedAt: null,
        ageMs: null,
        reason: "never_run",
        error: null,
      });
      continue;
    }
    const lastTimestamp = last.finishedAt ?? last.startedAt;
    const age = now - lastTimestamp;
    if (last.state === "running") {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: "running",
        lastRunFinishedAt: null,
        ageMs: age,
        reason: "stale",
        error: null,
      });
      continue;
    }
    if (last.state === "failed") {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: "failed",
        lastRunFinishedAt: last.finishedAt,
        ageMs: age,
        reason: "last_failed",
        error: last.error,
      });
      continue;
    }
    if (age > staleThresholdMs) {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: "succeeded",
        lastRunFinishedAt: last.finishedAt,
        ageMs: age,
        reason: "stale",
        error: null,
      });
    }
  }
  return [...byAdapter.values()].sort((a, b) =>
    a.adapterKind < b.adapterKind ? -1 : 1,
  );
}

function selectReconciliationRunForWarning(
  runs: readonly TrackerReconciliationRun[],
  now: number,
  staleThresholdMs: number,
): TrackerReconciliationRun | null | undefined {
  const last = runs.at(-1);
  if (!last) return undefined;
  if (last.state !== "running") return last;
  const age = now - last.startedAt;
  if (age <= staleThresholdMs) return null;
  return (
    runs
      .slice(0, -1)
      .reverse()
      .find((run) => run.state !== "running") ?? last
  );
}

function runCoversFilteredRollup(
  run: TrackerReconciliationRun,
  rollupFilters: ProjectRollupFilters,
  items: readonly TrackerItem[],
): boolean {
  if (run.metadata["dryRun"] === true) return false;
  if (reconciliationStoppedBeforeComplete(run)) return false;
  const filters = readNested(run.metadata, "filters");
  if (filters === null || !filtersHaveScope(filters)) return true;
  return (
    runDimensionCoversRollup(filters, rollupFilters, "project", items) &&
    runDimensionCoversRollup(filters, rollupFilters, "milestone", items)
  );
}

function reconciliationStoppedBeforeComplete(
  run: TrackerReconciliationRun,
): boolean {
  const stop = readNested(run.metadata, "paginationStopped");
  return readString(stop, "reason") === "max_pages";
}

function filtersHaveScope(filters: Record<string, unknown>): boolean {
  return (
    readString(filters, "projectId") !== null ||
    readString(filters, "projectName") !== null ||
    readString(filters, "milestoneId") !== null ||
    readString(filters, "milestoneName") !== null
  );
}

function runDimensionCoversRollup(
  runFilters: Record<string, unknown>,
  rollupFilters: ProjectRollupFilters,
  dimension: "project" | "milestone",
  items: readonly TrackerItem[],
): boolean {
  const runValues = [
    readString(runFilters, `${dimension}Id`),
    readString(runFilters, `${dimension}Name`),
  ].filter((value): value is string => value !== null);
  if (runValues.length === 0) return true;

  const rollupValues = [
    rollupFilters[`${dimension}Id`],
    rollupFilters[`${dimension}Name`],
  ].filter((value): value is string => value !== undefined);
  if (rollupValues.length === 0) return false;
  if (runValues.some((runValue) => rollupValues.includes(runValue)))
    return true;

  return items.every((item) =>
    itemDimensionMatchesRunFilter(item, dimension, runValues),
  );
}

function itemDimensionMatchesRunFilter(
  item: TrackerItem,
  dimension: "project" | "milestone",
  runValues: readonly string[],
): boolean {
  const itemValues = readMetadataValues(item.metadata, dimension);
  return itemValues.some((itemValue) => runValues.includes(itemValue));
}

function buildPendingIntentSummaries(
  db: MomentumDb,
  filters: ProjectRollupFilters,
  items: readonly RollupTrackerItem[],
  goals: Map<string, GoalSnapshot>,
  now: number,
  staleThresholdMs: number,
): ProjectRollupPendingIntentSummary[] {
  const filtersScoped = isRollupScoped(filters);
  const itemIds = new Set(items.flatMap((item) => item.rollupTrackerItemIds));
  const goalIds = new Set(goals.keys());

  const listOptions: Parameters<typeof listIntents>[1] = {
    status: "pending",
  };
  if (filters.adapterKind !== undefined)
    listOptions.adapterKind = filters.adapterKind;

  const intents = listIntents(db, listOptions);
  const scoped = intents.filter((intent) => {
    if (!filtersScoped) return true;
    if (intent.trackerItemId) return itemIds.has(intent.trackerItemId);
    if (intent.goalId && goalIds.has(intent.goalId)) return true;
    return false;
  });

  return scoped
    .slice()
    .sort(pendingIntentOrder)
    .map((intent) => toPendingIntentSummary(db, intent, now, staleThresholdMs));
}

function isRollupScoped(filters: ProjectRollupFilters): boolean {
  return (
    filters.projectId !== undefined ||
    filters.projectName !== undefined ||
    filters.milestoneId !== undefined ||
    filters.milestoneName !== undefined
  );
}

function pendingIntentOrder(a: Intent, b: Intent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : 1;
}

function toPendingIntentSummary(
  db: MomentumDb,
  intent: Intent,
  now: number,
  staleThresholdMs: number,
): ProjectRollupPendingIntentSummary {
  const ageMs = Math.max(0, now - intent.createdAt);
  const summary = summarizeIntentApplyAuditsForIntent(db, intent.id);
  const externalApply: ProjectRollupPendingIntentExternalApply = summary
    ? {
        applyState: summary.applyState,
        totalAttempts: summary.totalAttempts,
        counts: summary.counts,
        latestAttempt: summary.latestAttempt,
      }
    : {
        applyState: "idle",
        totalAttempts: 0,
        counts: {
          claimed: 0,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          audit_incomplete: 0,
        },
        latestAttempt: null,
      };
  return {
    intentId: intent.id,
    adapterKind: intent.adapterKind,
    intentType: intent.intentType,
    targetExternalId: intent.targetExternalId,
    reason: intent.reason,
    goalId: intent.goalId,
    trackerItemId: intent.trackerItemId,
    evidenceRecordId: intent.evidenceRecordId,
    createdAt: intent.createdAt,
    ageMs,
    stale: ageMs > staleThresholdMs,
    externalApply,
  };
}

function pickNextAction(
  counts: ProjectRollupCounts,
  mismatches: readonly ProjectRollupMismatch[],
  reconciliationWarnings: readonly ProjectRollupReconciliationWarning[],
  pendingIntents: readonly ProjectRollupPendingIntentSummary[],
): ProjectRollupNextAction {
  if (counts.goals.needingManualRecovery > 0) {
    const goalIds = mismatches
      .filter((m) => m.kind === "manual_recovery_required")
      .map((m) => m.goalId)
      .filter((id): id is string => id !== null);
    return {
      kind: "manual_recovery_required",
      message: `Clear manual recovery on ${counts.goals.needingManualRecovery} goal(s) with \`momentum recovery clear <goal-id>\`.`,
      detail: { goalIds },
    };
  }
  const failedReconciliation = reconciliationWarnings.find(
    (warning) => warning.reason === "last_failed",
  );
  if (failedReconciliation) {
    return {
      kind: "reconcile_failed",
      message: `Last ${failedReconciliation.adapterKind} reconciliation failed; investigate and re-run \`momentum tracker reconcile ${failedReconciliation.adapterKind}\`.`,
      detail: {
        adapterKind: failedReconciliation.adapterKind,
        error: failedReconciliation.error,
      },
    };
  }
  if (counts.mismatches.tracker_done_goal_not_terminal > 0) {
    return {
      kind: "address_mismatch",
      message: `${counts.mismatches.tracker_done_goal_not_terminal} tracker-done/goal-not-terminal mismatch(es); reconcile Goal state or close the tracker item.`,
      detail: { mismatchKind: "tracker_done_goal_not_terminal" },
    };
  }
  if (pendingIntents.length > 0) {
    const stale = pendingIntents.filter((intent) => intent.stale).length;
    const intentIds = pendingIntents
      .slice(0, 5)
      .map((intent) => intent.intentId);
    const staleSuffix = stale > 0 ? ` (${stale} stale)` : "";
    return {
      kind: "review_pending_intents",
      message:
        `${pendingIntents.length} pending intent(s)${staleSuffix}; ` +
        "review with `momentum intent list --status pending` and apply/skip/cancel with a reason.",
      detail: { total: pendingIntents.length, stale, intentIds },
    };
  }
  if (counts.mismatches.goal_done_tracker_not_done > 0) {
    return {
      kind: "address_mismatch",
      message: `${counts.mismatches.goal_done_tracker_not_done} goal-done/tracker-not-done mismatch(es); queue an intent or update the tracker item.`,
      detail: { mismatchKind: "goal_done_tracker_not_done" },
    };
  }
  if (counts.mismatches.evidence_missing_after_completion > 0) {
    return {
      kind: "missing_evidence",
      message: `${counts.mismatches.evidence_missing_after_completion} completed goal(s) missing evidence; ingest workflow artifacts.`,
      detail: { mismatchKind: "evidence_missing_after_completion" },
    };
  }
  const staleReconciliation = reconciliationWarnings.find(
    (warning) => warning.reason === "stale" || warning.reason === "never_run",
  );
  if (staleReconciliation) {
    return {
      kind: "reconcile_stale_tracker",
      message: `Reconcile ${staleReconciliation.adapterKind} tracker (${staleReconciliation.reason}).`,
      detail: {
        adapterKind: staleReconciliation.adapterKind,
        reason: staleReconciliation.reason,
      },
    };
  }
  return {
    kind: "no_action_required",
    message: "No project rollup issues detected.",
    detail: {},
  };
}
