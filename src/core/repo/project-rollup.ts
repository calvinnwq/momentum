/**
 * Project rollup (NGX-292 / M5-05; pending-intent surfaces added in NGX-293 / M5-06).
 *
 * Computes an operator-facing summary of SourceItem / Goal / evidence /
 * reconciliation state from local durable records only. Never calls source
 * adapters or runs external API requests. Filter scope is source-centric:
 * goals are included if they are linked to a SourceItem matching the filters.
 *
 * Pending external update intents are read from local durable state and
 * scoped to the same SourceItem / Goal set so the rollup never widens past
 * the operator's filter context. Stale pending intents are flagged via a
 * configurable TTL (default 30 days); the rollup never auto-deletes intents.
 */

import type { MomentumDb } from "../../adapters/db.js";
import { listSourceItems, type SourceItem } from "../source/items.js";
import {
  listSourceReconciliationRuns,
  type SourceReconciliationRun
} from "../source/reconciliation-runs.js";
import { listUpdateIntents, type UpdateIntent } from "../intent/update-intents.js";
import {
  summarizeIntentApplyAuditsForIntent,
  type IntentApplyAudit,
  type IntentApplyAuditCounts,
  type IntentApplyState,
  type IntentApplyStateCounts
} from "../intent/apply-audits.js";

export const DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INTENT_STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT = 20;

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

const TERMINAL_GOAL_STATES = new Set([
  "completed",
  "failed",
  "max_iterations_reached"
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

export type ProjectRollupSourceItemSummary = {
  sourceItemId: string;
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
  | "source_done_goal_not_terminal"
  | "goal_done_source_not_done"
  | "evidence_missing_after_completion"
  | "manual_recovery_required";

export type ProjectRollupMismatch = {
  kind: ProjectRollupMismatchKind;
  sourceItemId: string;
  externalKey: string | null;
  title: string;
  goalId: string | null;
  goalState: string | null;
  sourceStatus: string | null;
};

export type ProjectRollupReconciliationWarningReason =
  | "never_run"
  | "stale"
  | "last_failed";

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
  | "reconcile_stale_source"
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
  sourceItemId: string | null;
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
  sourceItems: {
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
  pendingUpdateIntents: number;
  staleUpdateIntents: number;
};

export type ProjectRollup = {
  filters: ProjectRollupFilters;
  generatedAt: number;
  reconciliationStaleThresholdMs: number;
  intentStaleThresholdMs: number;
  counts: ProjectRollupCounts;
  sourceItems: ProjectRollupSourceItemSummary[];
  totalSourceItemCount: number;
  truncatedSourceItems: boolean;
  mismatches: ProjectRollupMismatch[];
  totalMismatchCount: number;
  truncatedMismatches: boolean;
  reconciliationWarnings: ProjectRollupReconciliationWarning[];
  pendingUpdateIntents: ProjectRollupPendingIntentSummary[];
  totalPendingUpdateIntentCount: number;
  truncatedPendingUpdateIntents: boolean;
  externalApply: ProjectRollupExternalApply;
  nextAction: ProjectRollupNextAction;
};

type GoalSnapshot = {
  id: string;
  state: string;
  needsManualRecovery: boolean;
};

export function buildProjectRollup(
  db: MomentumDb,
  options: ProjectRollupOptions = {}
): ProjectRollup {
  const filters = options.filters ?? {};
  const reconciliationStaleThresholdMs = resolveStaleThreshold(
    options.reconciliationStaleThresholdMs,
    "reconciliationStaleThresholdMs",
    DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS
  );
  const intentStaleThresholdMs = resolveStaleThreshold(
    options.intentStaleThresholdMs,
    "intentStaleThresholdMs",
    DEFAULT_INTENT_STALE_THRESHOLD_MS
  );
  const generatedAt = options.now ?? Date.now();

  const allItems = listSourceItems(
    db,
    filters.adapterKind === undefined ? {} : { adapterKind: filters.adapterKind }
  );
  const items = allItems.filter((item) => matchesProjectMilestoneFilters(item, filters));

  const linkedGoalIds = collectLinkedGoalIds(items);
  const goals = linkedGoalIds.size === 0 ? new Map<string, GoalSnapshot>() : loadGoalSnapshots(db, linkedGoalIds);
  const goalsWithEvidence = goals.size === 0 ? new Set<string>() : loadGoalsWithEvidence(db, goals, items);
  const evidenceTotal = goals.size === 0 ? 0 : countEvidenceRecordsForGoals(db, goals, items);

  const summaries = buildSourceItemSummaries(items, goals);
  const mismatches = buildMismatches(items, goals, goalsWithEvidence);
  const pendingIntents = buildPendingIntentSummaries(
    db,
    filters,
    items,
    goals,
    generatedAt,
    intentStaleThresholdMs
  );
  const counts = computeCounts(
    items,
    goals,
    goalsWithEvidence,
    mismatches,
    evidenceTotal,
    pendingIntents
  );
  const reconciliationWarnings = buildReconciliationWarnings(
    db,
    filters.adapterKind,
    filters,
    generatedAt,
    reconciliationStaleThresholdMs,
    items
  );
  const nextAction = pickNextAction(
    counts,
    mismatches,
    reconciliationWarnings,
    pendingIntents
  );

  const truncatedSourceItems = summaries.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;
  const truncatedMismatches = mismatches.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;
  const truncatedPendingIntents =
    pendingIntents.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;

  const externalApply = buildExternalApplyRollup(pendingIntents);

  return {
    filters,
    generatedAt,
    reconciliationStaleThresholdMs,
    intentStaleThresholdMs,
    counts,
    sourceItems: summaries.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalSourceItemCount: summaries.length,
    truncatedSourceItems,
    mismatches: mismatches.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalMismatchCount: mismatches.length,
    truncatedMismatches,
    reconciliationWarnings,
    pendingUpdateIntents: pendingIntents.slice(
      0,
      PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT
    ),
    totalPendingUpdateIntentCount: pendingIntents.length,
    truncatedPendingUpdateIntents: truncatedPendingIntents,
    externalApply,
    nextAction
  };
}

function buildExternalApplyRollup(
  pendingIntents: readonly ProjectRollupPendingIntentSummary[]
): ProjectRollupExternalApply {
  const intentApplyStateCounts: IntentApplyStateCounts = {
    idle: 0,
    in_flight: 0,
    blocked: 0
  };
  const auditCounts: IntentApplyAuditCounts = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    audit_incomplete: 0
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
    latestAttempt
  };
}

function resolveStaleThreshold(
  value: number | undefined,
  name: string,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative finite number, got ${value}`
    );
  }
  return value;
}

function matchesProjectMilestoneFilters(
  item: SourceItem,
  filters: ProjectRollupFilters
): boolean {
  if (
    filters.projectId === undefined &&
    filters.projectName === undefined &&
    filters.milestoneId === undefined &&
    filters.milestoneName === undefined
  ) {
    return true;
  }
  const projectValues = readMetadataValues(item.metadata, "project");
  if (!matchesValueFilters(projectValues, filters.projectId, filters.projectName)) {
    return false;
  }
  const milestoneValues = readMetadataValues(item.metadata, "milestone");
  if (
    !matchesValueFilters(milestoneValues, filters.milestoneId, filters.milestoneName)
  ) {
    return false;
  }
  return true;
}

function matchesValueFilters(
  values: readonly string[],
  idFilter: string | undefined,
  nameFilter: string | undefined
): boolean {
  if (idFilter === undefined && nameFilter === undefined) return true;
  if (idFilter !== undefined && values.includes(idFilter)) return true;
  if (nameFilter !== undefined && values.includes(nameFilter)) return true;
  return false;
}

function readMetadataValues(
  metadata: Record<string, unknown>,
  key: "project" | "milestone"
): string[] {
  const value = metadata[key];
  if (typeof value === "string") {
    return readCompactStringArray([value]);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }
  const objectValue = value as Record<string, unknown>;
  return readCompactStringArray([readString(objectValue, "id"), readString(objectValue, "name")]);
}

function readNested(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCompactStringArray(values: Array<string | null>): string[] {
  const compact = values.filter((value): value is string => value !== null);
  return [...new Set(compact)];
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function collectLinkedGoalIds(items: readonly SourceItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.goalId) ids.add(item.goalId);
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
  goalIds: Set<string>
): Map<string, GoalSnapshot> {
  const ids = [...goalIds];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, state, needs_manual_recovery
         FROM goals
        WHERE id IN (${placeholders})`
    )
    .all(...ids) as GoalRow[];
  const map = new Map<string, GoalSnapshot>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      state: row.state,
      needsManualRecovery: row.needs_manual_recovery === 1
    });
  }
  return map;
}

function loadGoalsWithEvidence(
  db: MomentumDb,
  goals: Map<string, GoalSnapshot>,
  items: readonly SourceItem[]
): Set<string> {
  if (goals.size === 0) return new Set();
  const goalIds = [...goals.keys()];
  const sourceItemGoalIds = collectLinkedSourceItemGoalIds(items, goals);
  const sourceItemIds = [...sourceItemGoalIds.keys()];
  const clauses: string[] = [];
  const params: string[] = [];
  if (goalIds.length > 0) {
    clauses.push(`goal_id IN (${goalIds.map(() => "?").join(", ")})`);
    params.push(...goalIds);
  }
  if (sourceItemIds.length > 0) {
    clauses.push(`source_item_id IN (${sourceItemIds.map(() => "?").join(", ")})`);
    params.push(...sourceItemIds);
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT goal_id AS goal_id, source_item_id AS source_item_id
         FROM evidence_records
        WHERE ${clauses.join(" OR ")}`
    )
    .all(...params) as { goal_id: string | null; source_item_id: string | null }[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.goal_id !== null && goals.has(row.goal_id)) ids.add(row.goal_id);
    if (row.source_item_id !== null) {
      const linkedGoalId = sourceItemGoalIds.get(row.source_item_id);
      if (linkedGoalId !== undefined) ids.add(linkedGoalId);
    }
  }
  return ids;
}

function countEvidenceRecordsForGoals(
  db: MomentumDb,
  goals: Map<string, GoalSnapshot>,
  items: readonly SourceItem[]
): number {
  if (goals.size === 0) return 0;
  const goalIds = [...goals.keys()];
  const sourceItemIds = [...collectLinkedSourceItemGoalIds(items, goals).keys()];
  const clauses: string[] = [];
  const params: string[] = [];
  if (goalIds.length > 0) {
    clauses.push(`goal_id IN (${goalIds.map(() => "?").join(", ")})`);
    params.push(...goalIds);
  }
  if (sourceItemIds.length > 0) {
    clauses.push(`source_item_id IN (${sourceItemIds.map(() => "?").join(", ")})`);
    params.push(...sourceItemIds);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM evidence_records
        WHERE ${clauses.join(" OR ")}`
    )
    .get(...params) as { total: number } | undefined;
  return row?.total ?? 0;
}

function collectLinkedSourceItemGoalIds(
  items: readonly SourceItem[],
  goals: Map<string, GoalSnapshot>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.goalId && goals.has(item.goalId)) {
      map.set(item.id, item.goalId);
    }
  }
  return map;
}

function buildSourceItemSummaries(
  items: readonly SourceItem[],
  goals: Map<string, GoalSnapshot>
): ProjectRollupSourceItemSummary[] {
  return items
    .slice()
    .sort(sourceItemOrder)
    .map((item) => {
      const goal = item.goalId ? goals.get(item.goalId) ?? null : null;
      return {
        sourceItemId: item.id,
        adapterKind: item.adapterKind,
        externalId: item.externalId,
        externalKey: item.externalKey,
        title: item.title,
        url: item.url,
        status: item.status,
        lastObservedAt: item.lastObservedAt,
        goalId: item.goalId,
        goalState: goal?.state ?? null
      };
    });
}

function sourceItemOrder(a: SourceItem, b: SourceItem): number {
  if (a.adapterKind !== b.adapterKind) {
    return a.adapterKind < b.adapterKind ? -1 : 1;
  }
  const aKey = a.externalKey ?? a.externalId;
  const bKey = b.externalKey ?? b.externalId;
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return a.externalId < b.externalId ? -1 : 1;
}

function buildMismatches(
  items: readonly SourceItem[],
  goals: Map<string, GoalSnapshot>,
  goalsWithEvidence: Set<string>
): ProjectRollupMismatch[] {
  const mismatches: ProjectRollupMismatch[] = [];
  const reportedManualRecovery = new Set<string>();
  const reportedMissingEvidence = new Set<string>();
  for (const item of items.slice().sort(sourceItemOrder)) {
    const goal = item.goalId ? goals.get(item.goalId) ?? null : null;
    if (!goal) continue;
    const sourceDone = isSourceStatusTerminal(item.status);
    const goalDone = goal.state === COMPLETED_GOAL_STATE;
    const goalTerminal = TERMINAL_GOAL_STATES.has(goal.state);
    if (sourceDone && !goalTerminal) {
      mismatches.push(buildMismatch("source_done_goal_not_terminal", item, goal));
    }
    if (goalDone && !sourceDone) {
      mismatches.push(buildMismatch("goal_done_source_not_done", item, goal));
    }
    if (goalDone && !goalsWithEvidence.has(goal.id) && !reportedMissingEvidence.has(goal.id)) {
      mismatches.push(buildMismatch("evidence_missing_after_completion", item, goal));
      reportedMissingEvidence.add(goal.id);
    }
    if (goal.needsManualRecovery && !reportedManualRecovery.has(goal.id)) {
      mismatches.push(buildMismatch("manual_recovery_required", item, goal));
      reportedManualRecovery.add(goal.id);
    }
  }
  return mismatches;
}

function buildMismatch(
  kind: ProjectRollupMismatchKind,
  item: SourceItem,
  goal: GoalSnapshot
): ProjectRollupMismatch {
  return {
    kind,
    sourceItemId: item.id,
    externalKey: item.externalKey,
    title: item.title,
    goalId: goal.id,
    goalState: goal.state,
    sourceStatus: item.status
  };
}

function isSourceStatusTerminal(status: string | null): boolean {
  if (!status) return false;
  return TERMINAL_SOURCE_STATUSES.has(status.trim().toLowerCase());
}

function computeCounts(
  items: readonly SourceItem[],
  goals: Map<string, GoalSnapshot>,
  goalsWithEvidence: Set<string>,
  mismatches: readonly ProjectRollupMismatch[],
  evidenceTotal: number,
  pendingIntents: readonly ProjectRollupPendingIntentSummary[]
): ProjectRollupCounts {
  const byStatus: Record<string, number> = {};
  let linkedToGoal = 0;
  let unlinked = 0;
  for (const item of items) {
    const key = item.status ?? "(none)";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    if (item.goalId) linkedToGoal += 1;
    else unlinked += 1;
  }
  const byGoalState: Record<string, number> = {};
  let needingManualRecovery = 0;
  for (const goal of goals.values()) {
    byGoalState[goal.state] = (byGoalState[goal.state] ?? 0) + 1;
    if (goal.needsManualRecovery) needingManualRecovery += 1;
  }
  const mismatchCounts: Record<ProjectRollupMismatchKind, number> = {
    source_done_goal_not_terminal: 0,
    goal_done_source_not_done: 0,
    evidence_missing_after_completion: 0,
    manual_recovery_required: 0
  };
  for (const mismatch of mismatches) {
    mismatchCounts[mismatch.kind] += 1;
  }
  const goalsWithoutEvidence = [...goals.values()].filter(
    (goal) => goal.state === COMPLETED_GOAL_STATE && !goalsWithEvidence.has(goal.id)
  ).length;
  const stalePendingIntents = pendingIntents.filter((intent) => intent.stale).length;
  return {
    sourceItems: {
      total: items.length,
      byStatus,
      linkedToGoal,
      unlinked
    },
    goals: {
      total: goals.size,
      byState: byGoalState,
      needingManualRecovery
    },
    evidence: {
      totalRecords: evidenceTotal,
      goalsWithEvidence: goalsWithEvidence.size,
      goalsWithoutEvidence
    },
    mismatches: mismatchCounts,
    pendingUpdateIntents: pendingIntents.length,
    staleUpdateIntents: stalePendingIntents
  };
}

function buildReconciliationWarnings(
  db: MomentumDb,
  adapterKind: string | undefined,
  filters: ProjectRollupFilters,
  now: number,
  staleThresholdMs: number,
  items: readonly SourceItem[]
): ProjectRollupReconciliationWarning[] {
  if (items.length === 0) {
    return [];
  }

  const runs = listSourceReconciliationRuns(
    db,
    adapterKind === undefined ? {} : { adapterKind }
  );
  if (runs.length === 0) {
    const adapters = adapterKind === undefined
      ? [...new Set(items.map((item) => item.adapterKind))].sort()
      : [adapterKind];
    return adapters.map((adapter) => ({
      adapterKind: adapter,
      lastRunState: null,
      lastRunFinishedAt: null,
      ageMs: null,
      reason: "never_run",
      error: null
    }));
  }
  const byAdapter = new Map<string, ProjectRollupReconciliationWarning>();
  const adapters = adapterKind === undefined
    ? new Set(items.map((item) => item.adapterKind))
    : new Set([adapterKind]);
  for (const adapter of adapters) {
    const adapterItems = items.filter((item) => item.adapterKind === adapter);
    const adapterRuns = runs.filter(
      (run) =>
        run.adapterKind === adapter &&
        runCoversFilteredRollup(run, filters, adapterItems)
    );
    if (adapterRuns.length === 0) {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: null,
        lastRunFinishedAt: null,
        ageMs: null,
        reason: "never_run",
        error: null
      });
      continue;
    }
    const last = selectReconciliationRunForWarning(adapterRuns, now, staleThresholdMs);
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
        error: null
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
        error: null
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
        error: last.error
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
        error: null
      });
    }
  }
  return [...byAdapter.values()].sort((a, b) => (a.adapterKind < b.adapterKind ? -1 : 1));
}

function selectReconciliationRunForWarning(
  runs: readonly SourceReconciliationRun[],
  now: number,
  staleThresholdMs: number
): SourceReconciliationRun | null | undefined {
  const last = runs.at(-1);
  if (!last) return undefined;
  if (last.state !== "running") return last;
  const age = now - last.startedAt;
  if (age <= staleThresholdMs) return null;
  return runs.slice(0, -1).reverse().find((run) => run.state !== "running") ?? last;
}

function runCoversFilteredRollup(
  run: SourceReconciliationRun,
  rollupFilters: ProjectRollupFilters,
  items: readonly SourceItem[]
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

function reconciliationStoppedBeforeComplete(run: SourceReconciliationRun): boolean {
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
  items: readonly SourceItem[]
): boolean {
  const runValues = [
    readString(runFilters, `${dimension}Id`),
    readString(runFilters, `${dimension}Name`)
  ].filter((value): value is string => value !== null);
  if (runValues.length === 0) return true;

  const rollupValues = [
    rollupFilters[`${dimension}Id`],
    rollupFilters[`${dimension}Name`]
  ].filter((value): value is string => value !== undefined);
  if (rollupValues.length === 0) return false;
  if (runValues.some((runValue) => rollupValues.includes(runValue))) return true;

  return items.every((item) => itemDimensionMatchesRunFilter(item, dimension, runValues));
}

function itemDimensionMatchesRunFilter(
  item: SourceItem,
  dimension: "project" | "milestone",
  runValues: readonly string[]
): boolean {
  const itemValues = readMetadataValues(item.metadata, dimension);
  return itemValues.some((itemValue) => runValues.includes(itemValue));
}

function buildPendingIntentSummaries(
  db: MomentumDb,
  filters: ProjectRollupFilters,
  items: readonly SourceItem[],
  goals: Map<string, GoalSnapshot>,
  now: number,
  staleThresholdMs: number
): ProjectRollupPendingIntentSummary[] {
  const filtersScoped = isRollupScoped(filters);
  const itemIds = new Set(items.map((item) => item.id));
  const goalIds = new Set(goals.keys());

  const listOptions: Parameters<typeof listUpdateIntents>[1] = { status: "pending" };
  if (filters.adapterKind !== undefined) listOptions.adapterKind = filters.adapterKind;

  const intents = listUpdateIntents(db, listOptions);
  const scoped = intents.filter((intent) => {
    if (!filtersScoped) return true;
    if (intent.sourceItemId) return itemIds.has(intent.sourceItemId);
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

function pendingIntentOrder(a: UpdateIntent, b: UpdateIntent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : 1;
}

function toPendingIntentSummary(
  db: MomentumDb,
  intent: UpdateIntent,
  now: number,
  staleThresholdMs: number
): ProjectRollupPendingIntentSummary {
  const ageMs = Math.max(0, now - intent.createdAt);
  const summary = summarizeIntentApplyAuditsForIntent(db, intent.id);
  const externalApply: ProjectRollupPendingIntentExternalApply = summary
    ? {
        applyState: summary.applyState,
        totalAttempts: summary.totalAttempts,
        counts: summary.counts,
        latestAttempt: summary.latestAttempt
      }
    : {
        applyState: "idle",
        totalAttempts: 0,
        counts: {
          claimed: 0,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          audit_incomplete: 0
        },
        latestAttempt: null
      };
  return {
    intentId: intent.id,
    adapterKind: intent.adapterKind,
    intentType: intent.intentType,
    targetExternalId: intent.targetExternalId,
    reason: intent.reason,
    goalId: intent.goalId,
    sourceItemId: intent.sourceItemId,
    evidenceRecordId: intent.evidenceRecordId,
    createdAt: intent.createdAt,
    ageMs,
    stale: ageMs > staleThresholdMs,
    externalApply
  };
}

function pickNextAction(
  counts: ProjectRollupCounts,
  mismatches: readonly ProjectRollupMismatch[],
  reconciliationWarnings: readonly ProjectRollupReconciliationWarning[],
  pendingIntents: readonly ProjectRollupPendingIntentSummary[]
): ProjectRollupNextAction {
  if (counts.goals.needingManualRecovery > 0) {
    const goalIds = mismatches
      .filter((m) => m.kind === "manual_recovery_required")
      .map((m) => m.goalId)
      .filter((id): id is string => id !== null);
    return {
      kind: "manual_recovery_required",
      message: `Clear manual recovery on ${counts.goals.needingManualRecovery} goal(s) with \`momentum recovery clear <goal-id>\`.`,
      detail: { goalIds }
    };
  }
  const failedReconciliation = reconciliationWarnings.find(
    (warning) => warning.reason === "last_failed"
  );
  if (failedReconciliation) {
    return {
      kind: "reconcile_failed",
      message: `Last ${failedReconciliation.adapterKind} reconciliation failed; investigate and re-run \`momentum source reconcile ${failedReconciliation.adapterKind}\`.`,
      detail: {
        adapterKind: failedReconciliation.adapterKind,
        error: failedReconciliation.error
      }
    };
  }
  if (counts.mismatches.source_done_goal_not_terminal > 0) {
    return {
      kind: "address_mismatch",
      message: `${counts.mismatches.source_done_goal_not_terminal} source-done/goal-not-terminal mismatch(es); reconcile Goal state or close source.`,
      detail: { mismatchKind: "source_done_goal_not_terminal" }
    };
  }
  if (pendingIntents.length > 0) {
    const stale = pendingIntents.filter((intent) => intent.stale).length;
    const intentIds = pendingIntents.slice(0, 5).map((intent) => intent.intentId);
    const staleSuffix = stale > 0 ? ` (${stale} stale)` : "";
    return {
      kind: "review_pending_intents",
      message:
        `${pendingIntents.length} pending external update intent(s)${staleSuffix}; ` +
        "review with `momentum intent list --status pending` and apply/skip/cancel with a reason.",
      detail: { total: pendingIntents.length, stale, intentIds }
    };
  }
  if (counts.mismatches.goal_done_source_not_done > 0) {
    return {
      kind: "address_mismatch",
      message: `${counts.mismatches.goal_done_source_not_done} goal-done/source-not-done mismatch(es); queue external update intent or update source.`,
      detail: { mismatchKind: "goal_done_source_not_done" }
    };
  }
  if (counts.mismatches.evidence_missing_after_completion > 0) {
    return {
      kind: "missing_evidence",
      message: `${counts.mismatches.evidence_missing_after_completion} completed goal(s) missing evidence; ingest workflow artifacts.`,
      detail: { mismatchKind: "evidence_missing_after_completion" }
    };
  }
  const staleReconciliation = reconciliationWarnings.find(
    (warning) => warning.reason === "stale" || warning.reason === "never_run"
  );
  if (staleReconciliation) {
    return {
      kind: "reconcile_stale_source",
      message: `Reconcile ${staleReconciliation.adapterKind} source (${staleReconciliation.reason}).`,
      detail: {
        adapterKind: staleReconciliation.adapterKind,
        reason: staleReconciliation.reason
      }
    };
  }
  return {
    kind: "no_action_required",
    message: "No project rollup issues detected.",
    detail: {}
  };
}
