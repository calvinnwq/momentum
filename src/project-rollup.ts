/**
 * Project rollup (NGX-292 / M5-05).
 *
 * Computes an operator-facing summary of SourceItem / Goal / evidence /
 * reconciliation state from local durable records only. Never calls source
 * adapters or runs external API requests. Filter scope is source-centric:
 * goals are included if they are linked to a SourceItem matching the filters.
 *
 * External update intents (NGX-293) are not implemented yet, so the
 * pendingUpdateIntents list/count are stable empty / zero placeholders.
 */

import type { MomentumDb } from "./db.js";
import { listSourceItems, type SourceItem } from "./source-items.js";
import { listSourceReconciliationRuns } from "./source-reconciliation-runs.js";

export const DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
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
  lastRunState: "succeeded" | "failed" | null;
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
  | "no_action_required";

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
};

export type ProjectRollup = {
  filters: ProjectRollupFilters;
  generatedAt: number;
  reconciliationStaleThresholdMs: number;
  counts: ProjectRollupCounts;
  sourceItems: ProjectRollupSourceItemSummary[];
  totalSourceItemCount: number;
  truncatedSourceItems: boolean;
  mismatches: ProjectRollupMismatch[];
  totalMismatchCount: number;
  truncatedMismatches: boolean;
  reconciliationWarnings: ProjectRollupReconciliationWarning[];
  pendingUpdateIntents: never[];
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
    options.reconciliationStaleThresholdMs
  );
  const generatedAt = options.now ?? Date.now();

  const allItems = listSourceItems(
    db,
    filters.adapterKind === undefined ? {} : { adapterKind: filters.adapterKind }
  );
  const items = allItems.filter((item) => matchesProjectMilestoneFilters(item, filters));

  const linkedGoalIds = collectLinkedGoalIds(items);
  const goals = linkedGoalIds.size === 0 ? new Map<string, GoalSnapshot>() : loadGoalSnapshots(db, linkedGoalIds);
  const goalsWithEvidence = goals.size === 0 ? new Set<string>() : loadGoalsWithEvidence(db, goals);
  const evidenceTotal = goals.size === 0 ? 0 : countEvidenceRecordsForGoals(db, goals);

  const summaries = buildSourceItemSummaries(items, goals);
  const mismatches = buildMismatches(items, goals, goalsWithEvidence);
  const counts = computeCounts(items, goals, goalsWithEvidence, mismatches, evidenceTotal);
  const reconciliationWarnings = buildReconciliationWarnings(
    db,
    filters.adapterKind,
    generatedAt,
    reconciliationStaleThresholdMs,
    items
  );
  const nextAction = pickNextAction(counts, mismatches, reconciliationWarnings);

  const truncatedSourceItems = summaries.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;
  const truncatedMismatches = mismatches.length > PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT;

  return {
    filters,
    generatedAt,
    reconciliationStaleThresholdMs,
    counts,
    sourceItems: summaries.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalSourceItemCount: summaries.length,
    truncatedSourceItems,
    mismatches: mismatches.slice(0, PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT),
    totalMismatchCount: mismatches.length,
    truncatedMismatches,
    reconciliationWarnings,
    pendingUpdateIntents: [],
    nextAction
  };
}

function resolveStaleThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `reconciliationStaleThresholdMs must be a non-negative finite number, got ${value}`
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
  const project = readNested(item.metadata, "project");
  const milestone = readNested(item.metadata, "milestone");
  if (filters.projectId !== undefined && readString(project, "id") !== filters.projectId) {
    return false;
  }
  if (filters.projectName !== undefined && readString(project, "name") !== filters.projectName) {
    return false;
  }
  if (filters.milestoneId !== undefined && readString(milestone, "id") !== filters.milestoneId) {
    return false;
  }
  if (filters.milestoneName !== undefined && readString(milestone, "name") !== filters.milestoneName) {
    return false;
  }
  return true;
}

function readNested(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
  goals: Map<string, GoalSnapshot>
): Set<string> {
  if (goals.size === 0) return new Set();
  const ids = [...goals.keys()];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT goal_id AS goal_id
         FROM evidence_records
        WHERE goal_id IN (${placeholders})`
    )
    .all(...ids) as { goal_id: string }[];
  return new Set(rows.map((row) => row.goal_id));
}

function countEvidenceRecordsForGoals(
  db: MomentumDb,
  goals: Map<string, GoalSnapshot>
): number {
  if (goals.size === 0) return 0;
  const ids = [...goals.keys()];
  const placeholders = ids.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM evidence_records
        WHERE goal_id IN (${placeholders})`
    )
    .get(...ids) as { total: number } | undefined;
  return row?.total ?? 0;
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
  evidenceTotal: number
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
    pendingUpdateIntents: 0
  };
}

function buildReconciliationWarnings(
  db: MomentumDb,
  adapterKind: string | undefined,
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
    const adapterRuns = runs.filter((run) => run.adapterKind === adapter);
    const last = adapterRuns[adapterRuns.length - 1];
    if (!last) {
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
    if (last.state === "running") continue;
    const lastTimestamp = last.finishedAt ?? last.startedAt;
    if (last.state === "failed") {
      byAdapter.set(adapter, {
        adapterKind: adapter,
        lastRunState: "failed",
        lastRunFinishedAt: last.finishedAt,
        ageMs: now - lastTimestamp,
        reason: "last_failed",
        error: last.error
      });
      continue;
    }
    const age = now - lastTimestamp;
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

function pickNextAction(
  counts: ProjectRollupCounts,
  mismatches: readonly ProjectRollupMismatch[],
  reconciliationWarnings: readonly ProjectRollupReconciliationWarning[]
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
