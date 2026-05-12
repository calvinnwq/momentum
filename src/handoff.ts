import fs from "node:fs";

import type { GoalArtifactPaths } from "./artifacts.js";
import type { DataDirOptions } from "./data-dir.js";
import {
  loadGoalStatus,
  type GoalStatusArtifactFiles,
  type GoalStatusError,
  type GoalStatusIterationSummary,
  type GoalStatusJobSummary,
  type GoalStatusSuccess
} from "./goal-status.js";

export const HANDOFF_SCHEMA_VERSION = 1;

export type WriteHandoffInput = {
  goalId?: string;
  dataDirOptions?: DataDirOptions;
  now?: () => number;
};

export type HandoffErrorCode =
  | GoalStatusError["code"]
  | "handoff_write_failed";

export type HandoffError = {
  ok: false;
  code: HandoffErrorCode;
  error: string;
};

export type HandoffRunnerResultSummary = {
  success: boolean | null;
  summary: string | null;
  keyChangesMade: string[];
  keyLearnings: string[];
  remainingWork: string[];
  goalComplete: boolean | null;
};

export type HandoffGoalSummary = {
  id: string;
  title: string;
  state: string;
  repo: string | null;
  branch: string;
  runner: string;
  maxIterations: number;
  verification: string[];
  verificationTimeoutSec: number;
  artifactDir: string;
  dataDir: string;
  createdAt: number;
  updatedAt: number;
};

export type HandoffData = {
  schemaVersion: number;
  generatedAt: number;
  goal: HandoffGoalSummary;
  latestJob: GoalStatusJobSummary | null;
  iteration: GoalStatusIterationSummary | null;
  runnerResult: HandoffRunnerResultSummary | null;
  artifactPaths: GoalArtifactPaths;
  artifactFiles: GoalStatusArtifactFiles;
};

export type HandoffSuccess = {
  ok: true;
  data: HandoffData;
  handoffMdPath: string;
  handoffJsonPath: string;
};

export type HandoffResult = HandoffError | HandoffSuccess;

export function writeHandoff(input: WriteHandoffInput = {}): HandoffResult {
  const statusInput: {
    goalId?: string;
    dataDirOptions?: DataDirOptions;
  } = {};
  if (input.goalId !== undefined) statusInput.goalId = input.goalId;
  if (input.dataDirOptions !== undefined) {
    statusInput.dataDirOptions = input.dataDirOptions;
  }

  const status = loadGoalStatus(statusInput);
  if (!status.ok) {
    return { ok: false, code: status.code, error: status.error };
  }

  const now = input.now ?? (() => Date.now());
  const runnerResult = readRunnerResult(status.artifactPaths.resultJson);
  const data = buildHandoffData(status, runnerResult, now());

  const jsonBody = `${JSON.stringify(toJsonShape(data), null, 2)}\n`;
  const markdownBody = renderHandoffMarkdown(data);

  try {
    fs.writeFileSync(status.artifactPaths.handoffJson, jsonBody, "utf-8");
    fs.writeFileSync(status.artifactPaths.handoffMd, markdownBody, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "handoff_write_failed",
      error: `failed to write handoff artifacts: ${detail}`
    };
  }

  return {
    ok: true,
    data,
    handoffMdPath: status.artifactPaths.handoffMd,
    handoffJsonPath: status.artifactPaths.handoffJson
  };
}

function buildHandoffData(
  status: GoalStatusSuccess,
  runnerResult: HandoffRunnerResultSummary | null,
  generatedAt: number
): HandoffData {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    generatedAt,
    goal: {
      id: status.goalId,
      title: status.title,
      state: status.state,
      repo: status.repo,
      branch: status.branch,
      runner: status.runner,
      maxIterations: status.maxIterations,
      verification: status.verification,
      verificationTimeoutSec: status.verificationTimeoutSec,
      artifactDir: status.artifactDir,
      dataDir: status.dataDir,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt
    },
    latestJob: status.latestJob,
    iteration: status.iteration,
    runnerResult,
    artifactPaths: status.artifactPaths,
    artifactFiles: status.artifactFiles
  };
}

function toJsonShape(data: HandoffData): Record<string, unknown> {
  return {
    schema_version: data.schemaVersion,
    generated_at: data.generatedAt,
    goal: {
      id: data.goal.id,
      title: data.goal.title,
      state: data.goal.state,
      repo: data.goal.repo,
      branch: data.goal.branch,
      runner: data.goal.runner,
      max_iterations: data.goal.maxIterations,
      verification: data.goal.verification,
      verification_timeout_sec: data.goal.verificationTimeoutSec,
      artifact_dir: data.goal.artifactDir,
      data_dir: data.goal.dataDir,
      created_at: data.goal.createdAt,
      updated_at: data.goal.updatedAt
    },
    latest_job: data.latestJob
      ? {
          job_id: data.latestJob.jobId,
          type: data.latestJob.type,
          iteration: data.latestJob.iteration,
          state: data.latestJob.state,
          attempt_count: data.latestJob.attemptCount,
          artifact_path: data.latestJob.artifactPath,
          result_path: data.latestJob.resultPath,
          error_path: data.latestJob.errorPath,
          created_at: data.latestJob.createdAt,
          updated_at: data.latestJob.updatedAt,
          started_at: data.latestJob.startedAt,
          finished_at: data.latestJob.finishedAt,
          error: data.latestJob.error
        }
      : null,
    iteration: data.iteration
      ? {
          iteration: data.iteration.iteration,
          started_at: data.iteration.startedAt,
          finished_at: data.iteration.finishedAt,
          branch: data.iteration.branch,
          branch_created: data.iteration.branchCreated,
          base_head: data.iteration.baseHead,
          post_runner_head: data.iteration.postRunnerHead,
          commit_sha: data.iteration.commitSha,
          commit_message: data.iteration.commitMessage,
          runner_success: data.iteration.runnerSuccess,
          goal_complete: data.iteration.goalComplete,
          failure: data.iteration.failure
            ? {
                code: data.iteration.failure.code,
                error: data.iteration.failure.error
              }
            : null
        }
      : null,
    runner_result: data.runnerResult
      ? {
          success: data.runnerResult.success,
          summary: data.runnerResult.summary,
          key_changes_made: data.runnerResult.keyChangesMade,
          key_learnings: data.runnerResult.keyLearnings,
          remaining_work: data.runnerResult.remainingWork,
          goal_complete: data.runnerResult.goalComplete
        }
      : null,
    artifacts: {
      goal_md: data.artifactPaths.goalMd,
      ledger_md: data.artifactPaths.ledgerMd,
      handoff_md: data.artifactPaths.handoffMd,
      handoff_json: data.artifactPaths.handoffJson,
      prompt_md: data.artifactPaths.promptMd,
      runner_log: data.artifactPaths.runnerLog,
      verification_log: data.artifactPaths.verificationLog,
      result_json: data.artifactPaths.resultJson
    },
    artifact_files: {
      goal_md: data.artifactFiles.goalMd,
      ledger_md: data.artifactFiles.ledgerMd,
      handoff_md: data.artifactFiles.handoffMd,
      handoff_json: data.artifactFiles.handoffJson,
      prompt_md: data.artifactFiles.promptMd,
      runner_log: data.artifactFiles.runnerLog,
      verification_log: data.artifactFiles.verificationLog,
      result_json: data.artifactFiles.resultJson
    }
  };
}

function renderHandoffMarkdown(data: HandoffData): string {
  const lines: string[] = [];

  lines.push(`# Momentum handoff: ${data.goal.title}`);
  lines.push("");
  lines.push(`- Goal ID: ${data.goal.id}`);
  lines.push(`- State: ${data.goal.state}`);
  lines.push(`- Repo: ${data.goal.repo ?? "(unset)"}`);
  lines.push(`- Branch: ${data.goal.branch}`);
  lines.push(`- Runner: ${data.goal.runner}`);
  lines.push(`- Max iterations: ${data.goal.maxIterations}`);
  lines.push(`- Schema version: ${data.schemaVersion}`);
  lines.push(`- Generated at (epoch ms): ${data.generatedAt}`);
  lines.push("");

  lines.push("## Verification commands");
  if (data.goal.verification.length === 0) {
    lines.push("- (none)");
  } else {
    for (const command of data.goal.verification) {
      lines.push(`- \`${command}\``);
    }
  }
  lines.push(`- Timeout (sec): ${data.goal.verificationTimeoutSec}`);
  lines.push("");

  lines.push("## Iteration");
  if (!data.iteration) {
    lines.push("- No iteration has run yet.");
  } else {
    lines.push(`- Iteration: ${data.iteration.iteration}`);
    lines.push(`- Base HEAD: ${data.iteration.baseHead ?? "(unknown)"}`);
    lines.push(
      `- Post-runner HEAD: ${data.iteration.postRunnerHead ?? "(unknown)"}`
    );
    lines.push(`- Commit SHA: ${data.iteration.commitSha ?? "(none)"}`);
    if (data.iteration.commitMessage) {
      lines.push(`- Commit message: ${oneLine(data.iteration.commitMessage)}`);
    }
    lines.push(
      `- Runner success: ${formatNullableBool(data.iteration.runnerSuccess)}`
    );
    lines.push(
      `- Goal complete: ${formatNullableBool(data.iteration.goalComplete)}`
    );
    if (data.iteration.failure) {
      lines.push(
        `- Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
      );
    }
  }
  lines.push("");

  if (data.latestJob) {
    lines.push("## Latest job");
    lines.push(`- Job ID: ${data.latestJob.jobId}`);
    lines.push(`- Type: ${data.latestJob.type}`);
    lines.push(`- State: ${data.latestJob.state}`);
    lines.push(`- Attempts: ${data.latestJob.attemptCount}`);
    if (data.latestJob.resultPath) {
      lines.push(`- Result path: ${data.latestJob.resultPath}`);
    }
    if (data.latestJob.errorPath) {
      lines.push(`- Error path: ${data.latestJob.errorPath}`);
    }
    if (data.latestJob.error) {
      lines.push(`- Error: ${data.latestJob.error}`);
    }
    lines.push("");
  }

  lines.push("## Runner result");
  if (!data.runnerResult) {
    lines.push("- No runner result captured.");
  } else {
    if (data.runnerResult.summary) {
      lines.push(`- Summary: ${data.runnerResult.summary}`);
    }
    lines.push(
      `- Success: ${formatNullableBool(data.runnerResult.success)}`
    );
    lines.push(
      `- Goal complete: ${formatNullableBool(data.runnerResult.goalComplete)}`
    );
    appendList(lines, "Key changes made", data.runnerResult.keyChangesMade);
    appendList(lines, "Key learnings", data.runnerResult.keyLearnings);
    appendList(lines, "Remaining work", data.runnerResult.remainingWork);
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push(`- Data dir: ${data.goal.dataDir}`);
  lines.push(`- Artifact dir: ${data.goal.artifactDir}`);
  lines.push(
    `- prompt.md (${existsMark(data.artifactFiles.promptMd)}): ${data.artifactPaths.promptMd}`
  );
  lines.push(
    `- runner.log (${existsMark(data.artifactFiles.runnerLog)}): ${data.artifactPaths.runnerLog}`
  );
  lines.push(
    `- verification.log (${existsMark(data.artifactFiles.verificationLog)}): ${data.artifactPaths.verificationLog}`
  );
  lines.push(
    `- result.json (${existsMark(data.artifactFiles.resultJson)}): ${data.artifactPaths.resultJson}`
  );
  lines.push("");

  return lines.join("\n");
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`- ${label}: (none)`);
    return;
  }
  lines.push(`- ${label}:`);
  for (const value of values) {
    lines.push(`  - ${value}`);
  }
}

function formatNullableBool(value: boolean | null): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function existsMark(present: boolean): string {
  return present ? "present" : "missing";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readRunnerResult(resultPath: string): HandoffRunnerResultSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(resultPath, "utf-8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "{}") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  return {
    success: typeof parsed["success"] === "boolean" ? parsed["success"] : null,
    summary: typeof parsed["summary"] === "string" ? parsed["summary"] : null,
    keyChangesMade: stringArray(parsed["key_changes_made"]),
    keyLearnings: stringArray(parsed["key_learnings"]),
    remainingWork: stringArray(parsed["remaining_work"]),
    goalComplete:
      typeof parsed["goal_complete"] === "boolean"
        ? parsed["goal_complete"]
        : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}
