/**
 * Shared goal-first read-back primitives (RC-1c, NGX-495).
 *
 * `loadGoalStatus` (`./status.ts`) and `loadGoalLogs` (`./logs.ts`) are the two
 * goal-first read-back loaders. Before this seam each owned a private, byte-for-byte
 * identical copy of the same read-back logic: the input preamble (validate the
 * optional goal id, then resolve the data directory), the "latest goal" lookup, the
 * "resolve the goal under inspection or refuse" decision (`goal_not_found` /
 * `no_goals`), and the per-record evidence projection. This module is the single
 * home both compose, mirroring how the workflow-first read-back surfaces
 * (`workflow run logs` / `workflow handoff`) compose the one proven
 * `loadWorkflowRunDetail` foundation instead of re-deriving the substrate read.
 *
 * The preamble stays two composable steps rather than one combined helper so each
 * loader keeps its exact refusal precedence — `loadGoalLogs` validates its
 * `iteration` argument *between* the goal-id and data-directory checks, which a
 * single fused preamble could not preserve.
 *
 * It owns no domain mutation and no db lifecycle: callers still open and close the
 * connection. The goal-resolution and input-preamble refusal messages are
 * reproduced verbatim so the goal-first read-back envelopes stay wire-stable for
 * existing callers.
 *
 * No SQLite mutation, no file reads, no external writes.
 */
import type { MomentumDb } from "../../adapters/db.js";
import { resolveDataDir, type DataDirOptions } from "../../config/data-dir.js";
import type { EvidenceRecord } from "../evidence/records.js";
import { getGoal, type GoalRow } from "./init.js";

/**
 * The two refusal codes the goal-first read-back input preamble can emit before a
 * goal is even resolved: a malformed explicit goal id (`invalid_input`) or a data
 * directory that cannot be resolved (`data_dir_failed`). Both codes are a subset
 * of every goal-first read-back error union (`GoalStatusErrorCode` /
 * `GoalLogsErrorCode`), so a refusal of this shape is returnable directly from
 * either loader without widening their error contracts.
 */
export type GoalReadBackInputError = {
  ok: false;
  code: "invalid_input" | "data_dir_failed";
  error: string;
};

/**
 * Validate the optional goal id shared by goal-first read-back commands: an
 * explicitly-provided id must be a non-empty (non-whitespace) string, while an
 * omitted id is accepted and defers to the latest-goal default target. Returns a
 * ready-to-return `invalid_input` refusal on violation, or `undefined` when the
 * id is acceptable. The message is reproduced verbatim from the two loaders so the
 * read-back envelopes stay wire-stable.
 */
export function validateGoalReadBackInput(
  goalId?: string
): GoalReadBackInputError | undefined {
  if (goalId !== undefined && goalId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "goalId must be a non-empty string when provided."
    };
  }
  return undefined;
}

export type GoalReadBackDataDirResolution =
  | { ok: true; dataDir: string }
  | GoalReadBackInputError;

/**
 * Resolve the data directory for a goal-first read-back command, mapping a
 * resolution failure to the shared `data_dir_failed` refusal both loaders return.
 * The mapping is preserved verbatim so the read-back envelopes stay wire-stable;
 * the catch guards only the defensive `resolveDataDir` throw.
 */
export function resolveReadBackDataDir(
  dataDirOptions?: DataDirOptions
): GoalReadBackDataDirResolution {
  try {
    return { ok: true, dataDir: resolveDataDir(dataDirOptions ?? {}) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "data_dir_failed",
      error: `failed to resolve data directory: ${detail}`
    };
  }
}

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
