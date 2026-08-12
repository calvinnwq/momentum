import {
  AGENT_RESULT_SCHEMA,
  COMMIT_TYPES,
  LEGACY_RUNNER_RESULT_SCHEMA,
} from "./types.js";
import type {
  AgentResultError,
  AgentResultParse,
  CommitIntent,
  CommitType,
} from "./types.js";

/**
 * Parse one raw agent-authored result document with version awareness.
 *
 * The document's schema version is discriminated by which completion field is
 * present: `objective_complete` selects the current
 * `momentum.agent-result.v1` schema and `goal_complete` routes to the explicit
 * legacy `momentum.runner-result.v1` reader for historical immutable
 * documents. A document carrying both completion fields fails closed as
 * ambiguous even when the values agree, and both versions normalize to the
 * same internal `AgentResult` completion recommendation.
 */
export function parseAgentResult(raw: string): AgentResultParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Invalid agent result JSON: ${detail}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Agent result must be a JSON object." };
  }
  const ambiguous = rejectAmbiguousCompletionFields(parsed);
  if (ambiguous !== null) return ambiguous;
  if ("goal_complete" in parsed) {
    return normalizeLegacyRunnerResult(parsed);
  }
  return normalizeAgentResult(parsed);
}

/**
 * Normalize one current-schema (`momentum.agent-result.v1`) agent result.
 *
 * New agent result documents accept and emit only `objective_complete`; a
 * legacy `goal_complete` field is rejected here and remains readable only
 * through {@link normalizeLegacyRunnerResult} or the version-aware
 * {@link parseAgentResult}.
 */
export function normalizeAgentResult(value: unknown): AgentResultParse {
  if (!isRecord(value)) {
    return { ok: false, error: "Agent result must be a JSON object." };
  }
  const ambiguous = rejectAmbiguousCompletionFields(value);
  if (ambiguous !== null) return ambiguous;
  if ("goal_complete" in value) {
    return {
      ok: false,
      error:
        "Agent result carries the legacy `goal_complete` field; new documents must use `objective_complete`.",
    };
  }
  return normalizeResultDocument(
    value,
    "objective_complete",
    AGENT_RESULT_SCHEMA,
  );
}

/**
 * Explicit legacy reader for historical immutable
 * `momentum.runner-result.v1` documents whose completion field is
 * `goal_complete`. Historical files are never rewritten; this reader
 * normalizes them to the same internal `AgentResult` shape
 * (`objective_complete`) so legacy and current documents produce the same
 * completion recommendation downstream.
 */
export function normalizeLegacyRunnerResult(value: unknown): AgentResultParse {
  if (!isRecord(value)) {
    return { ok: false, error: "Agent result must be a JSON object." };
  }
  const ambiguous = rejectAmbiguousCompletionFields(value);
  if (ambiguous !== null) return ambiguous;
  if (!("goal_complete" in value)) {
    return {
      ok: false,
      error:
        "Legacy runner result requires the `goal_complete` completion field.",
    };
  }
  return normalizeResultDocument(
    value,
    "goal_complete",
    LEGACY_RUNNER_RESULT_SCHEMA,
  );
}

function rejectAmbiguousCompletionFields(
  value: Record<string, unknown>,
): AgentResultError | null {
  if ("goal_complete" in value && "objective_complete" in value) {
    return {
      ok: false,
      error:
        "Agent result is ambiguous: it carries both `goal_complete` and `objective_complete`; exactly one completion field is allowed.",
    };
  }
  return null;
}

function normalizeResultDocument(
  value: Record<string, unknown>,
  completionField: "objective_complete" | "goal_complete",
  schema: typeof AGENT_RESULT_SCHEMA | typeof LEGACY_RUNNER_RESULT_SCHEMA,
): AgentResultParse {
  if (typeof value["success"] !== "boolean") {
    return { ok: false, error: "Agent result `success` must be a boolean." };
  }
  const success = value["success"];

  const summary = readNonEmptyString(value["summary"]);
  if (summary === undefined) {
    return {
      ok: false,
      error: "Agent result `summary` must be a non-empty string.",
    };
  }

  const key_changes_made = readStringArray(
    value["key_changes_made"],
    "key_changes_made",
  );
  if (!key_changes_made.ok) return key_changes_made;

  const key_learnings = readOptionalStringArray(
    value["key_learnings"],
    "key_learnings",
  );
  if (!key_learnings.ok) return key_learnings;

  const remaining_work = readOptionalStringArray(
    value["remaining_work"],
    "remaining_work",
  );
  if (!remaining_work.ok) return remaining_work;

  if (typeof value[completionField] !== "boolean") {
    return {
      ok: false,
      error: `Agent result \`${completionField}\` must be a boolean.`,
    };
  }
  const objective_complete = value[completionField];

  const commitRaw = value["commit"];
  if (commitRaw === undefined) {
    return { ok: false, error: "Agent result `commit` is required." };
  }
  const commit = normalizeCommitIntent(commitRaw);
  if (!commit.ok) return commit;

  return {
    ok: true,
    schema,
    value: {
      success,
      summary,
      key_changes_made: key_changes_made.value,
      key_learnings: key_learnings.value,
      remaining_work: remaining_work.value,
      objective_complete,
      commit: commit.value,
    },
  };
}

type CommitIntentParse = AgentResultError | { ok: true; value: CommitIntent };

export function normalizeCommitIntent(value: unknown): CommitIntentParse {
  if (!isRecord(value)) {
    return { ok: false, error: "Agent result `commit` must be an object." };
  }

  const rawType = value["type"];
  if (typeof rawType !== "string" || !isCommitType(rawType)) {
    return {
      ok: false,
      error: `Agent result \`commit.type\` must be one of: ${COMMIT_TYPES.join(", ")}.`,
    };
  }

  const subject = readNonEmptyString(value["subject"]);
  if (subject === undefined) {
    return {
      ok: false,
      error: "Agent result `commit.subject` must be a non-empty string.",
    };
  }
  const trimmedSubject = stripTrailingPeriod(subject);

  let scope: string | undefined;
  const rawScope = value["scope"];
  if (rawScope !== undefined && rawScope !== null) {
    if (typeof rawScope !== "string") {
      return {
        ok: false,
        error: "Agent result `commit.scope` must be a string.",
      };
    }
    const trimmed = rawScope.trim();
    scope = trimmed.length === 0 ? undefined : trimmed;
  }

  let body = "";
  const rawBody = value["body"];
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody !== "string") {
      return {
        ok: false,
        error: "Agent result `commit.body` must be a string.",
      };
    }
    body = rawBody.trim();
  }

  let breaking = false;
  const rawBreaking = value["breaking"];
  if (rawBreaking !== undefined) {
    if (typeof rawBreaking !== "boolean") {
      return {
        ok: false,
        error: "Agent result `commit.breaking` must be a boolean.",
      };
    }
    breaking = rawBreaking;
  }

  return {
    ok: true,
    value: { type: rawType, scope, subject: trimmedSubject, body, breaking },
  };
}

function isCommitType(value: string): value is CommitType {
  return (COMMIT_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

type StringArrayParse = AgentResultError | { ok: true; value: string[] };

function readStringArray(value: unknown, field: string): StringArrayParse {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: `Agent result \`${field}\` must be an array of strings.`,
    };
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `Agent result \`${field}[${i}]\` must be a string.`,
      };
    }
    out.push(entry.trim());
  }
  return { ok: true, value: out };
}

function readOptionalStringArray(
  value: unknown,
  field: string,
): StringArrayParse {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  return readStringArray(value, field);
}

function stripTrailingPeriod(subject: string): string {
  return subject.endsWith(".") ? subject.slice(0, -1).trimEnd() : subject;
}
