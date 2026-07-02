// Runner result shapes shared across the executor families and the runners that
// produce them. `COMMIT_TYPES` is the canonical enumeration backing the
// `CommitType` union, so the const and its derived type live together here even
// though the const is a runtime value; the parser in `runner/result.ts`
// imports it for validation.
export const COMMIT_TYPES = [
  "build",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "test",
  "chore"
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export type CommitIntent = {
  type: CommitType;
  scope: string | undefined;
  subject: string;
  body: string;
  breaking: boolean;
};

export type RunnerResult = {
  success: boolean;
  summary: string;
  key_changes_made: string[];
  key_learnings: string[];
  remaining_work: string[];
  goal_complete: boolean;
  commit: CommitIntent;
};

export type RunnerResultError = { ok: false; error: string };
export type RunnerResultSuccess = { ok: true; value: RunnerResult };
export type RunnerResultParse = RunnerResultError | RunnerResultSuccess;
