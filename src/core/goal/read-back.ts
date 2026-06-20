/**
 * Shared goal-first read-back primitives (RC-1c, NGX-495).
 *
 * `loadGoalStatus` (`./status.ts`) and `loadGoalLogs` (`./logs.ts`) are the two
 * goal-first read-back loaders. Before this seam each owned a private, byte-for-byte
 * identical copy of three pieces of read-back logic: the "latest goal" lookup, the
 * "resolve the goal under inspection or refuse" decision (`goal_not_found` /
 * `no_goals`), and the per-record evidence projection. This module is the single
 * home both compose, mirroring how the workflow-first read-back surfaces
 * (`workflow run logs` / `workflow handoff`) compose the one proven
 * `loadWorkflowRunDetail` foundation instead of re-deriving the substrate read.
 *
 * It owns no domain mutation and no db lifecycle: callers still open and close the
 * connection. The goal-resolution refusal messages are reproduced verbatim so the
 * goal-first read-back envelopes stay wire-stable for existing callers.
 *
 * No SQLite mutation, no file reads, no external writes.
 */
import type { MomentumDb } from "../../adapters/db.js";
import type { EvidenceRecord } from "../evidence/records.js";
import { getGoal, type GoalRow } from "./init.js";

/**
 * The most recently created goal, used as the implicit target when a read-back
 * command is invoked without an explicit goal id. Ordering matches the goal-first
 * status/logs default-target contract (newest `created_at`, id as a stable tiebreak).
 */
export function findLatestGoal(db: MomentumDb): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM goals ORDER BY created_at DESC, id ASC LIMIT 1")
    .get() as GoalRow | undefined;
}

export type GoalReadBackResolution =
  | { ok: true; goal: GoalRow }
  | { ok: false; code: "goal_not_found" | "no_goals"; error: string };

/**
 * Resolve the goal a read-back command targets: the explicit `goalId` when given,
 * otherwise the latest goal. Returns a ready-to-return refusal when the lookup
 * misses — `goal_not_found` for an explicit-but-missing id, `no_goals` for an empty
 * store — with the same messages both goal-first loaders previously inlined.
 *
 * The caller owns the open db connection and its lifecycle; this is a pure read.
 */
export function resolveGoalForReadBack(
  db: MomentumDb,
  dataDir: string,
  goalId?: string
): GoalReadBackResolution {
  const goal = goalId !== undefined ? getGoal(db, goalId) : findLatestGoal(db);
  if (!goal) {
    if (goalId !== undefined) {
      return {
        ok: false,
        code: "goal_not_found",
        error: `Goal ${goalId} was not found in ${dataDir}.`
      };
    }
    return {
      ok: false,
      code: "no_goals",
      error: `No goals found in ${dataDir}.`
    };
  }
  return { ok: true, goal };
}

/**
 * The shared per-record evidence projection surfaced by goal-first `status` and
 * `logs`. Both read-back envelopes expose the same evidence-summary shape, so the
 * mapping lives here once rather than in each loader.
 */
export type GoalEvidenceSummary = {
  id: string;
  source: string;
  type: string;
  formatVersion: number;
  occurredAt: number;
  summary: string;
  artifactPath: string | null;
  sourceItemId: string | null;
};

export function toGoalEvidenceSummary(
  record: EvidenceRecord
): GoalEvidenceSummary {
  return {
    id: record.id,
    source: record.source,
    type: record.type,
    formatVersion: record.formatVersion,
    occurredAt: record.occurredAt,
    summary: record.summary,
    artifactPath: record.artifactPath,
    sourceItemId: record.sourceItemId
  };
}
