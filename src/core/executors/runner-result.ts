import { COMMIT_TYPES } from "./types.js";
import type {
  CommitIntent,
  CommitType,
  RunnerResultError,
  RunnerResultParse
} from "./types.js";

export function parseRunnerResult(raw: string): RunnerResultParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Invalid runner result JSON: ${detail}` };
  }
  return normalizeRunnerResult(parsed);
}

export function normalizeRunnerResult(value: unknown): RunnerResultParse {
  if (!isRecord(value)) {
    return { ok: false, error: "Runner result must be a JSON object." };
  }

  if (typeof value["success"] !== "boolean") {
    return { ok: false, error: "Runner result `success` must be a boolean." };
  }
  const success = value["success"];

  const summary = readNonEmptyString(value["summary"]);
  if (summary === undefined) {
    return { ok: false, error: "Runner result `summary` must be a non-empty string." };
  }

  const key_changes_made = readStringArray(value["key_changes_made"], "key_changes_made");
  if (!key_changes_made.ok) return key_changes_made;

  const key_learnings = readOptionalStringArray(value["key_learnings"], "key_learnings");
  if (!key_learnings.ok) return key_learnings;

  const remaining_work = readOptionalStringArray(value["remaining_work"], "remaining_work");
  if (!remaining_work.ok) return remaining_work;

  if (typeof value["goal_complete"] !== "boolean") {
    return {
      ok: false,
      error: "Runner result `goal_complete` must be a boolean."
    };
  }
  const goal_complete = value["goal_complete"];

  const commitRaw = value["commit"];
  if (commitRaw === undefined) {
    return { ok: false, error: "Runner result `commit` is required." };
  }
  const commit = normalizeCommitIntent(commitRaw);
  if (!commit.ok) return commit;

  return {
    ok: true,
    value: {
      success,
      summary,
      key_changes_made: key_changes_made.value,
      key_learnings: key_learnings.value,
      remaining_work: remaining_work.value,
      goal_complete,
      commit: commit.value
    }
  };
}

type CommitIntentParse =
  | RunnerResultError
  | { ok: true; value: CommitIntent };

export function normalizeCommitIntent(value: unknown): CommitIntentParse {
  if (!isRecord(value)) {
    return { ok: false, error: "Runner result `commit` must be an object." };
  }

  const rawType = value["type"];
  if (typeof rawType !== "string" || !isCommitType(rawType)) {
    return {
      ok: false,
      error: `Runner result \`commit.type\` must be one of: ${COMMIT_TYPES.join(", ")}.`
    };
  }

  const subject = readNonEmptyString(value["subject"]);
  if (subject === undefined) {
    return {
      ok: false,
      error: "Runner result `commit.subject` must be a non-empty string."
    };
  }
  const trimmedSubject = stripTrailingPeriod(subject);

  let scope: string | undefined;
  const rawScope = value["scope"];
  if (rawScope !== undefined && rawScope !== null) {
    if (typeof rawScope !== "string") {
      return { ok: false, error: "Runner result `commit.scope` must be a string." };
    }
    const trimmed = rawScope.trim();
    scope = trimmed.length === 0 ? undefined : trimmed;
  }

  let body = "";
  const rawBody = value["body"];
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody !== "string") {
      return { ok: false, error: "Runner result `commit.body` must be a string." };
    }
    body = rawBody.trim();
  }

  let breaking = false;
  const rawBreaking = value["breaking"];
  if (rawBreaking !== undefined) {
    if (typeof rawBreaking !== "boolean") {
      return {
        ok: false,
        error: "Runner result `commit.breaking` must be a boolean."
      };
    }
    breaking = rawBreaking;
  }

  return {
    ok: true,
    value: { type: rawType, scope, subject: trimmedSubject, body, breaking }
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

type StringArrayParse =
  | RunnerResultError
  | { ok: true; value: string[] };

function readStringArray(value: unknown, field: string): StringArrayParse {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: `Runner result \`${field}\` must be an array of strings.`
    };
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `Runner result \`${field}[${i}]\` must be a string.`
      };
    }
    out.push(entry.trim());
  }
  return { ok: true, value: out };
}

function readOptionalStringArray(
  value: unknown,
  field: string
): StringArrayParse {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  return readStringArray(value, field);
}

function stripTrailingPeriod(subject: string): string {
  return subject.endsWith(".") ? subject.slice(0, -1).trimEnd() : subject;
}
