// Agent result shapes shared across the executors and the agents that
// produce them. `COMMIT_TYPES` is the canonical enumeration backing the
// `CommitType` union, so the const and its derived type live together here even
// though the const is a runtime value; the parser in `agent-result/result.ts`
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
  "chore",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export type CommitIntent = {
  type: CommitType;
  scope: string | undefined;
  subject: string;
  body: string;
  breaking: boolean;
};

/**
 * Version identifiers for the raw agent-authored result document.
 *
 * Raw documents carry no `schema` field: the prompt contract only names the
 * completion field, so the version is discriminated by which completion field
 * is present. Exactly one of `objective_complete` (current) or `goal_complete`
 * (legacy) must appear; a document carrying both is rejected as ambiguous even
 * when the values agree.
 */
export const AGENT_RESULT_SCHEMA = "momentum.agent-result.v1";
export const LEGACY_RUNNER_RESULT_SCHEMA = "momentum.runner-result.v1";

export type AgentResultSchema =
  typeof AGENT_RESULT_SCHEMA | typeof LEGACY_RUNNER_RESULT_SCHEMA;

export type AgentResult = {
  success: boolean;
  summary: string;
  key_changes_made: string[];
  key_learnings: string[];
  remaining_work: string[];
  objective_complete: boolean;
  commit: CommitIntent;
};

export type AgentResultError = { ok: false; error: string };
export type AgentResultSuccess = {
  ok: true;
  value: AgentResult;
  schema: AgentResultSchema;
};
export type AgentResultParse = AgentResultError | AgentResultSuccess;
