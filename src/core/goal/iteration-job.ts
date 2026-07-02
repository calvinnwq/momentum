import fs from "node:fs";
import path from "node:path";

import type { GoalArtifactPaths } from "../evidence/artifacts.js";
import type { MomentumDb } from "../../adapters/db.js";
import {
  runForegroundIteration,
  type ForegroundIterationError,
  type ForegroundIterationSuccess
} from "../executors/goal-iteration/foreground.js";
import type { GoalSpec } from "./types.js";
import { markGoalNeedsManualRecovery } from "./recovery.js";
import { parseAcpConfig } from "../../adapters/acp-config.js";
import {
  writeRecoveryArtifact,
  type RecoveryArtifactPathBundle
} from "./recovery-artifact.js";
import { buildIterationSourceContext } from "../source/context.js";
import { parseTrustedShellConfig } from "../../adapters/trusted-shell-config.js";

export type ExecuteIterationJobInput = {
  db: MomentumDb;
  goalId: string;
  jobId: string;
  spec: GoalSpec;
  artifactPaths: GoalArtifactPaths;
  iteration?: number;
  now?: () => number;
};

export type ExecuteIterationJobSuccess = {
  ok: true;
  iteration: ForegroundIterationSuccess;
  goalState: Exclude<GoalIterationState, "failed" | "running">;
  jobState: "succeeded";
};

export type ExecuteIterationJobFailure = {
  ok: false;
  iteration: ForegroundIterationError;
  goalState: "failed";
  jobState: "failed";
};

export type ExecuteIterationJobResult =
  | ExecuteIterationJobSuccess
  | ExecuteIterationJobFailure;

export type GoalIterationState =
  | "running"
  | "completed"
  | "iteration_complete"
  | "failed";
export type JobIterationState = "running" | "succeeded" | "failed";

export function executeIterationJob(
  input: ExecuteIterationJobInput
): ExecuteIterationJobResult {
  const { db, goalId, jobId, spec, artifactPaths } = input;
  const iteration = input.iteration ?? 1;
  const now = input.now ?? (() => Date.now());

  const startTs = now();
  db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
    "running",
    startTs,
    goalId
  );
  db.prepare(
    `UPDATE jobs
       SET state = ?,
           started_at = ?,
           updated_at = ?,
           attempt_count = attempt_count + CASE WHEN state = 'claimed' THEN 0 ELSE 1 END,
           error = NULL,
           finished_at = NULL
       WHERE id = ?`
  ).run("running", startTs, startTs, jobId);
  insertEvent(db, goalId, jobId, "iteration_started", startTs, {
    iteration,
    branch: spec.branch,
    runner: spec.runner
  });

  let result: ForegroundIterationSuccess | ForegroundIterationError;
  try {
    const iterationSourceContext = buildIterationSourceContext(db, goalId);
    result = runForegroundIteration({
      goalId,
      spec,
      iteration,
      artifactPaths,
      ...(iterationSourceContext ? { sourceContext: iterationSourceContext } : {})
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    const synthetic: ForegroundIterationError = {
      ok: false,
      code: "unexpected_error",
      error: `executeIterationJob failed unexpectedly: ${detail}`
    };
    result = synthetic;
  }

  const finishTs = now();

  if (result.ok) {
    const goalState: GoalIterationState = result.result.goal_complete
      ? "completed"
      : "iteration_complete";
    db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
      goalState,
      finishTs,
      goalId
    );
    db.prepare(
      `UPDATE jobs
         SET state = ?,
             finished_at = ?,
             updated_at = ?,
             result_path = ?,
             error_path = NULL,
             error = NULL
         WHERE id = ?`
    ).run("succeeded", finishTs, finishTs, result.resultJsonPath, jobId);
    insertEvent(db, goalId, jobId, "iteration_completed", finishTs, {
      iteration,
      branch: result.branch,
      branch_created: result.branchCreated,
      base_head: result.baseHead,
      post_runner_head: result.postRunnerHead,
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      runner_success: result.result.success,
      goal_complete: result.result.goal_complete
    });
    return {
      ok: true,
      iteration: result,
      goalState,
      jobState: "succeeded"
    };
  }

  const errorText = `${result.code}: ${result.error}`;
  const errorPath = pickErrorArtifactPath(result, artifactPaths);
  db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(
    "failed",
    finishTs,
    goalId
  );
  db.prepare(
    `UPDATE jobs
       SET state = ?,
           finished_at = ?,
           updated_at = ?,
           result_path = NULL,
           error_path = ?,
           error = ?
       WHERE id = ?`
  ).run("failed", finishTs, finishTs, errorPath, errorText, jobId);
  insertEvent(db, goalId, jobId, "iteration_failed", finishTs, {
    iteration,
    code: result.code,
    error: result.error
  });
  recordManualRecoveryIfNeeded({
    db,
    goalId,
    jobId,
    spec,
    artifactPaths,
    iteration,
    result,
    now: finishTs
  });
  return {
    ok: false,
    iteration: result,
    goalState: "failed",
    jobState: "failed"
  };
}

function recordManualRecoveryIfNeeded(input: {
  db: MomentumDb;
  goalId: string;
  jobId: string;
  spec: GoalSpec;
  artifactPaths: GoalArtifactPaths;
  iteration: number;
  result: ForegroundIterationError;
  now: number;
}): void {
  const recovery = input.result.manualRecovery;
  if (recovery === undefined) {
    return;
  }

  const dataDir = path.dirname(path.dirname(input.artifactPaths.goalDir));
  const resultJsonPath = recovery.resultJsonPath ?? input.artifactPaths.resultJson;
  const artifactPaths: RecoveryArtifactPathBundle = {
    iterationDir: input.artifactPaths.iterationDir,
    promptPath: fs.existsSync(input.artifactPaths.promptMd)
      ? input.artifactPaths.promptMd
      : null,
    runnerLog: fs.existsSync(input.artifactPaths.runnerLog)
      ? input.artifactPaths.runnerLog
      : null,
    verificationLog: fs.existsSync(input.artifactPaths.verificationLog)
      ? input.artifactPaths.verificationLog
      : null,
    resultJson: fs.existsSync(resultJsonPath) ? resultJsonPath : null
  };

  try {
    writeRecoveryArtifact({
      dataDir,
      input: {
        goalId: input.goalId,
        goalTitle: input.spec.title,
        iteration: input.iteration,
        jobId: input.jobId,
        daemonRunId: null,
        repoPath: input.spec.repo ?? null,
        expectedCommit: recovery.expectedCommit,
        currentCommit: recovery.currentCommit,
        reason: recovery.reason,
        runnerProfile: buildRunnerProfileSummary(input.spec),
        artifactPaths,
        safeNextSteps: recovery.safeNextSteps,
        classifiedAt: input.now
      }
    });
  } catch {
  }

  const marked = markGoalNeedsManualRecovery(input.db, {
    goalId: input.goalId,
    reason: recovery.reason.code,
    now: input.now
  });
  if (!marked.ok) {
    throw new Error(
      `manual recovery flag write failed for goal ${input.goalId}: ${marked.reason}`
    );
  }
}

export function buildRunnerProfileSummary(
  spec: GoalSpec
): {
  runner: string;
  command?: string;
  args?: string[];
  cwd?: "repo" | "iteration";
  timeoutSec?: number;
  resultFile?: string;
  note?: string;
} {
  if (spec.runner === "trusted-shell") {
    const parsed = parseTrustedShellConfig(spec.trusted_shell);
    if (!parsed.ok) {
      return {
        runner: spec.runner,
        note: `runner profile parse error: ${parsed.error}`
      };
    }
    return {
      runner: spec.runner,
      command: parsed.config.command,
      args: [...parsed.config.args],
      cwd: parsed.config.cwd,
      timeoutSec: parsed.config.timeoutSec,
      resultFile: parsed.config.resultFile
    };
  }

  if (spec.runner === "acp") {
    const parsed = parseAcpConfig(spec.acp);
    if (!parsed.ok) {
      return {
        runner: spec.runner,
        note: `runner profile parse error: ${parsed.error}`
      };
    }
    return {
      runner: spec.runner,
      command: parsed.config.command,
      args: [...parsed.config.args],
      cwd: parsed.config.cwd,
      timeoutSec: parsed.config.timeoutSec,
      resultFile: parsed.config.resultFile
    };
  }

  return {
    runner: spec.runner
  };
}

function pickErrorArtifactPath(
  result: ForegroundIterationError,
  artifactPaths: GoalArtifactPaths
): string {
  if (result.code === "verification_failed" || result.code === "runner_reported_failure") {
    return artifactPaths.verificationLog;
  }
  return artifactPaths.runnerLog;
}

function insertEvent(
  db: MomentumDb,
  goalId: string,
  jobId: string,
  type: string,
  createdAt: number,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO events (goal_id, job_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
  ).run(goalId, jobId, type, JSON.stringify(payload), createdAt);
}
