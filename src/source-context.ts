import type { MomentumDb } from "./adapters/db.js";
import type {
  IterationPromptSourceContext,
  IterationPromptSourceContextItem
} from "./iteration-prompt.js";
import {
  getLatestSourceSnapshotForItem,
  listSourceItemSummariesForGoal,
} from "./source-items.js";

export function buildIterationSourceContext(
  db: MomentumDb,
  goalId: string
): IterationPromptSourceContext | null {
  const summaries = listSourceItemSummariesForGoal(db, goalId);
  if (summaries.length === 0) {
    return null;
  }
  const sourceItems = summaries.map((summary): IterationPromptSourceContextItem => ({
    sourceItem: summary,
    body: extractLatestSnapshotBody(db, summary.id)
  }));
  const first = sourceItems[0]!;
  return {
    sourceItem: first.sourceItem,
    body: first.body ?? null,
    sourceItems
  };
}

function extractLatestSnapshotBody(
  db: MomentumDb,
  sourceItemId: string
): string | null {
  const latest = getLatestSourceSnapshotForItem(db, sourceItemId);
  if (!latest) return null;
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
