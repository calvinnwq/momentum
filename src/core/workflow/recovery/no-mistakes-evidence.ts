export const NO_MISTAKES_DETERMINISTIC_EVIDENCE_SCHEMA_VERSION = 1;

export const NO_MISTAKES_DETERMINISTIC_PHASES = [
  "review",
  "tests",
  "docs",
  "lint",
  "format",
  "push",
  "pr",
  "ci"
] as const;

export type NoMistakesDeterministicPhase =
  (typeof NO_MISTAKES_DETERMINISTIC_PHASES)[number];

export type NoMistakesEvidencePhaseStatus =
  | "passed"
  | "not_applicable"
  | "failed"
  | "pending"
  | "missing";

export type NoMistakesDeterministicEvidence = {
  schemaVersion: typeof NO_MISTAKES_DETERMINISTIC_EVIDENCE_SCHEMA_VERSION;
  workflowRunId: string;
  issueScope: readonly string[];
  branch: {
    name: string;
    headSha: string;
  };
  pullRequest: {
    id: string;
    headSha: string;
    state: "open" | "merged" | "closed";
    draft: boolean;
    checks: "passed" | "none" | "failed" | "pending" | "unknown";
  } | null;
  noMistakes: {
    runId: string;
    outcome: "checks-passed" | "passed";
    unresolvedFindings: number;
    unresolvedDecisions: number;
  };
  phases: Record<NoMistakesDeterministicPhase, NoMistakesEvidencePhaseStatus>;
};

export type NoMistakesEvidenceExpectedIdentity = {
  workflowRunId: string;
  issueScope?: readonly string[];
  branch?: {
    name?: string;
    headSha?: string;
  };
  pullRequest?: {
    id?: string;
    headSha?: string;
  } | null;
  noMistakesRunId?: string;
};

export type NoMistakesEvidenceClassifiedSuccess = {
  ok: true;
  noMistakesRunId: string;
  evidencePointer: string;
  satisfiedPhases: readonly NoMistakesDeterministicPhase[];
};

export type NoMistakesEvidenceRefusalReason =
  | "malformed"
  | "unknown_schema"
  | "workflow_run_mismatch"
  | "issue_scope_mismatch"
  | "branch_mismatch"
  | "head_mismatch"
  | "pull_request_mismatch"
  | "partial"
  | "review_findings_present"
  | "failed_or_pending_checks"
  | "outcome_not_successful";

export type NoMistakesEvidenceClassifiedRefusal = {
  ok: false;
  reason: NoMistakesEvidenceRefusalReason;
  message: string;
};

export type NoMistakesEvidenceClassifiedResult =
  | NoMistakesEvidenceClassifiedSuccess
  | NoMistakesEvidenceClassifiedRefusal;

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const PHASE_SET: ReadonlySet<string> = new Set(NO_MISTAKES_DETERMINISTIC_PHASES);

export function classifyNoMistakesDeterministicEvidence(
  value: unknown,
  expected: NoMistakesEvidenceExpectedIdentity
): NoMistakesEvidenceClassifiedResult {
  const parsed = parseNoMistakesDeterministicEvidence(value);
  if (!parsed.ok) return parsed;
  const evidence = parsed.evidence;

  if (evidence.workflowRunId !== expected.workflowRunId) {
    return refusal(
      "workflow_run_mismatch",
      `evidence workflow run ${evidence.workflowRunId} does not match ${expected.workflowRunId}`
    );
  }

  if (expected.issueScope !== undefined) {
    const actualScope = normalizeIssueScope(evidence.issueScope);
    const expectedScope = normalizeIssueScope(expected.issueScope);
    if (!sameStringArray(actualScope, expectedScope)) {
      return refusal(
        "issue_scope_mismatch",
        `evidence issue scope ${actualScope.join(",")} does not match ${expectedScope.join(",")}`
      );
    }
  }

  if (
    expected.branch?.name !== undefined &&
    evidence.branch.name !== expected.branch.name
  ) {
    return refusal(
      "branch_mismatch",
      `evidence branch ${evidence.branch.name} does not match ${expected.branch.name}`
    );
  }
  if (
    expected.branch?.headSha !== undefined &&
    evidence.branch.headSha !== expected.branch.headSha
  ) {
    return refusal(
      "head_mismatch",
      "evidence branch head SHA does not match the expected head SHA"
    );
  }
  if (
    expected.pullRequest !== undefined &&
    expected.pullRequest !== null &&
    evidence.pullRequest === null
  ) {
    return refusal("pull_request_mismatch", "evidence is missing pull request identity");
  }
  if (expected.pullRequest !== undefined && expected.pullRequest !== null) {
    if (
      expected.pullRequest.id !== undefined &&
      evidence.pullRequest?.id !== expected.pullRequest.id
    ) {
      return refusal(
        "pull_request_mismatch",
        `evidence pull request ${evidence.pullRequest?.id ?? "(missing)"} does not match ${expected.pullRequest.id}`
      );
    }
    if (
      expected.pullRequest.headSha !== undefined &&
      evidence.pullRequest?.headSha !== expected.pullRequest.headSha
    ) {
      return refusal(
        "pull_request_mismatch",
        "evidence pull request head SHA does not match the expected PR head SHA"
      );
    }
  }
  if (
    expected.noMistakesRunId !== undefined &&
    evidence.noMistakes.runId !== expected.noMistakesRunId
  ) {
    return refusal(
      "pull_request_mismatch",
      `evidence no-mistakes run ${evidence.noMistakes.runId} does not match ${expected.noMistakesRunId}`
    );
  }

  if (evidence.noMistakes.outcome !== "checks-passed" && evidence.noMistakes.outcome !== "passed") {
    return refusal(
      "outcome_not_successful",
      `evidence no-mistakes outcome ${evidence.noMistakes.outcome} is not successful`
    );
  }
  if (
    evidence.noMistakes.unresolvedFindings > 0 ||
    evidence.noMistakes.unresolvedDecisions > 0
  ) {
    return refusal(
      "review_findings_present",
      "evidence still has unresolved findings or decisions"
    );
  }
  if (
    evidence.pullRequest !== null &&
    (evidence.pullRequest.draft ||
      evidence.pullRequest.checks === "failed" ||
      evidence.pullRequest.checks === "pending" ||
      evidence.pullRequest.checks === "unknown")
  ) {
    return refusal(
      "failed_or_pending_checks",
      "evidence pull request is draft or checks are not passed/absent"
    );
  }

  const missing = NO_MISTAKES_DETERMINISTIC_PHASES.filter((phase) => {
    const status = evidence.phases[phase];
    if (phase === "review" || phase === "tests" || phase === "push") {
      return status !== "passed";
    }
    return status !== "passed" && status !== "not_applicable";
  });
  if (missing.length > 0) {
    return refusal(
      "partial",
      `evidence is missing successful required phase(s): ${missing.join(", ")}`
    );
  }

  return {
    ok: true,
    noMistakesRunId: evidence.noMistakes.runId,
    evidencePointer: `no-mistakes:${evidence.noMistakes.runId}#checks-passed`,
    satisfiedPhases: NO_MISTAKES_DETERMINISTIC_PHASES
  };
}

function parseNoMistakesDeterministicEvidence(
  value: unknown
):
  | { ok: true; evidence: NoMistakesDeterministicEvidence }
  | NoMistakesEvidenceClassifiedRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refusal("malformed", "evidence must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !==
    NO_MISTAKES_DETERMINISTIC_EVIDENCE_SCHEMA_VERSION
  ) {
    return refusal("unknown_schema", "evidence schemaVersion is not supported");
  }
  const workflowRunId = readNonBlank(record, "workflowRunId");
  const issueScope = readStringArray(record, "issueScope");
  const branch = readObject(record, "branch");
  const pullRequestRaw = record["pullRequest"];
  const noMistakes = readObject(record, "noMistakes");
  const phases = readObject(record, "phases");
  if (
    !workflowRunId.ok ||
    !issueScope.ok ||
    !branch.ok ||
    !noMistakes.ok ||
    !phases.ok
  ) {
    return refusal("malformed", "evidence is missing required identity fields");
  }

  const branchName = readNonBlank(branch.value, "name");
  const branchHeadSha = readSha(branch.value, "headSha");
  const noMistakesRunId = readNonBlank(noMistakes.value, "runId");
  const outcome = readEnum(noMistakes.value, "outcome", ["checks-passed", "passed"]);
  const unresolvedFindings = readNonNegativeInteger(
    noMistakes.value,
    "unresolvedFindings"
  );
  const unresolvedDecisions = readNonNegativeInteger(
    noMistakes.value,
    "unresolvedDecisions"
  );
  if (
    !branchName.ok ||
    !branchHeadSha.ok ||
    !noMistakesRunId.ok ||
    !outcome.ok ||
    !unresolvedFindings.ok ||
    !unresolvedDecisions.ok
  ) {
    return refusal("malformed", "evidence contains malformed branch or no-mistakes identity");
  }

  let pullRequest: NoMistakesDeterministicEvidence["pullRequest"] = null;
  if (pullRequestRaw !== null && pullRequestRaw !== undefined) {
    if (
      typeof pullRequestRaw !== "object" ||
      Array.isArray(pullRequestRaw)
    ) {
      return refusal("malformed", "evidence pullRequest must be an object or null");
    }
    const pr = pullRequestRaw as Record<string, unknown>;
    const id = readNonBlank(pr, "id");
    const headSha = readSha(pr, "headSha");
    const state = readEnum(pr, "state", ["open", "merged", "closed"]);
    const draft = readBoolean(pr, "draft");
    const checks = readEnum(pr, "checks", [
      "passed",
      "none",
      "failed",
      "pending",
      "unknown"
    ]);
    if (!id.ok || !headSha.ok || !state.ok || !draft.ok || !checks.ok) {
      return refusal("malformed", "evidence contains malformed pull request identity");
    }
    pullRequest = {
      id: id.value,
      headSha: headSha.value,
      state: state.value,
      draft: draft.value,
      checks: checks.value
    };
  }

  const parsedPhases: Partial<
    Record<NoMistakesDeterministicPhase, NoMistakesEvidencePhaseStatus>
  > = {};
  for (const key of Object.keys(phases.value)) {
    if (!PHASE_SET.has(key)) {
      return refusal("unknown_schema", `evidence contains unknown phase ${key}`);
    }
  }
  for (const phase of NO_MISTAKES_DETERMINISTIC_PHASES) {
    const status = readEnum(phases.value, phase, [
      "passed",
      "not_applicable",
      "failed",
      "pending",
      "missing"
    ]);
    if (!status.ok) {
      return refusal("malformed", `evidence phase ${phase} is missing or invalid`);
    }
    parsedPhases[phase] = status.value;
  }

  return {
    ok: true,
    evidence: {
      schemaVersion: NO_MISTAKES_DETERMINISTIC_EVIDENCE_SCHEMA_VERSION,
      workflowRunId: workflowRunId.value,
      issueScope: issueScope.value,
      branch: {
        name: branchName.value,
        headSha: branchHeadSha.value.toLowerCase()
      },
      pullRequest,
      noMistakes: {
        runId: noMistakesRunId.value,
        outcome: outcome.value,
        unresolvedFindings: unresolvedFindings.value,
        unresolvedDecisions: unresolvedDecisions.value
      },
      phases: parsedPhases as Record<
        NoMistakesDeterministicPhase,
        NoMistakesEvidencePhaseStatus
      >
    }
  };
}

function refusal(
  reason: NoMistakesEvidenceRefusalReason,
  message: string
): NoMistakesEvidenceClassifiedRefusal {
  return { ok: false, reason, message };
}

function normalizeIssueScope(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readObject(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function readNonBlank(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: string } | { ok: false } {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false };
  }
  return { ok: true, value: value.trim() };
}

function readStringArray(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: string[] } | { ok: false } {
  const value = record[key];
  if (!Array.isArray(value)) return { ok: false };
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { ok: false };
    }
    out.push(item.trim());
  }
  return { ok: true, value: out };
}

function readSha(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: string } | { ok: false } {
  const value = readNonBlank(record, key);
  if (!value.ok || !COMMIT_SHA_RE.test(value.value)) return { ok: false };
  return { ok: true, value: value.value.toLowerCase() };
}

function readBoolean(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: boolean } | { ok: false } {
  const value = record[key];
  return typeof value === "boolean" ? { ok: true, value } : { ok: false };
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: number } | { ok: false } {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T
): { ok: true; value: T[number] } | { ok: false } {
  const value = record[key];
  if (typeof value !== "string") return { ok: false };
  return (values as readonly string[]).includes(value)
    ? { ok: true, value: value as T[number] }
    : { ok: false };
}
