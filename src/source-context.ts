import type { MomentumDb } from "./db.js";
import type { IterationPromptSourceContext } from "./iteration-prompt.js";
import {
  listSourceItemSummariesForGoal,
  listSourceSnapshotsForItem
} from "./source-items.js";

export function buildIterationSourceContext(
  db: MomentumDb,
  goalId: string
): IterationPromptSourceContext | null {
  const summaries = listSourceItemSummariesForGoal(db, goalId);
  if (summaries.length === 0) {
    return null;
  }
  const summary = summaries[0]!;
  const body = extractLatestSnapshotBody(db, summary.id);
  return {
    sourceItem: summary,
    body
  };
}

function extractLatestSnapshotBody(
  db: MomentumDb,
  sourceItemId: string
): string | null {
  const snapshots = listSourceSnapshotsForItem(db, sourceItemId);
  if (snapshots.length === 0) {
    return null;
  }
  const latest = snapshots[snapshots.length - 1]!;
  return extractTextBody(latest.snapshot);
}

function extractTextBody(snapshot: Record<string, unknown>): string | null {
  for (const key of ["description", "body", "summary", "text"]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
