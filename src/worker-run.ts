import type { MomentumDb } from "./db.js";
import {
  appendQueueEvent,
  QUEUE_EVENT_TYPES
} from "./events.js";
import {
  claimPendingGoalIterationJob,
  heartbeatGoalIterationJob,
  releaseClaimedGoalIterationJob
} from "./queue-jobs.js";
import {
  acquireRepoLock,
  releaseRepoLock
} from "./repo-locks.js";
import { getGoal } from "./goal-init.js";
import {
  ensureIterationArtifactDir,
  resolveGoalArtifactPaths
} from "./artifacts.js";
import { parseGoalSpecFile } from "./goal-spec.js";
import {
  executeIterationJob,
  type GoalIterationState,
  type JobIterationState,
  type ExecuteIterationJobResult
} from "./iteration-job.js";
import {
  reduceGoalIteration,
  type ReducerResult
} from "./goal-reducer.js";

export type WorkerRunNow = () => number;

export type WorkerJobClaimedInfo = {
  goalId: string;
  jobId: string;
  lockId: string;
  iteration: number;
  workerId: string;
  now: number;
};

export type WorkerJobReleasedInfo = WorkerJobClaimedInfo & {
  outcome: "success" | "failure";
};

export type WorkerRunHooks = {
  onJobClaimed?: (info: WorkerJobClaimedInfo) => void;
  onJobReleased?: (info: WorkerJobReleasedInfo) => void;
};

export type WorkerRunInput = {
  db: MomentumDb;
  dataDir: string;
  workerId: string;
  leaseDurationMs?: number;
  now?: WorkerRunNow;
  hooks?: WorkerRunHooks;
};

export type WorkerRunNoWorkResult = {
  code: "no_work";
  workerId: string;
  dataDir: string;
  outcome: "idle";
  message: string;
};

export type WorkerRunNoClaimResult = {
  code: "not_executed";
  workerId: string;
  dataDir: string;
  outcome: "not_executed";
  reason: string;
  goalId: string;
  jobId: string;
  lockId?: string;
  message: string;
  error?: string;
};

export type WorkerRunSuccessResult = {
  code: "ran_job";
  ok: boolean;
  workerId: string;
  dataDir: string;
  outcome: "ran_job";
  goalId: string;
  jobId: string;
  lockId: string;
  goalState: GoalIterationState;
  jobState: JobIterationState;
  iteration: number;
  repoRoot: string;
  leaseExpiresAt: number;
  heartbeatAt: number;
  jobIterationResult: ExecuteIterationJobResult;
  reducer: ReducerResult | null;
  reducerError: string | null;
  message: string;
};

export type WorkerRunResult =
  | WorkerRunNoWorkResult
  | WorkerRunNoClaimResult
  | WorkerRunSuccessResult;

type GoalRow = {
  id: string;
  repo: string | null;
  runner: string;
};

export function runWorkerOnce(input: WorkerRunInput): WorkerRunResult {
  const now = input.now ?? (() => Date.now());
  const leaseDurationMs = input.leaseDurationMs ?? 30_000;
  const workerId = input.workerId;
  const baseData = { workerId, dataDir: input.dataDir };

  const claimNow = now();
  const claim = claimPendingGoalIterationJob(input.db, {
    workerId,
    leaseDurationMs,
    now: claimNow
  });

  if (!claim.ok) {
    return {
      code: "no_work",
      ...baseData,
      outcome: "idle",
      message: "No pending goal_iteration jobs were available."
    };
  }

  const claimedJob = claim.job;
  const goal = getGoalRow(input.db, claimedJob.goal_id);
  if (!goal) {
    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: "goal_not_found"
    });
    const message = released.ok
      ? `Released claim on job ${claimedJob.id} after missing goal metadata.`
      : `Could not release claim on job ${claimedJob.id}; it was reclaimed.`;
    return notExecutedFailure({
      ...baseData,
      goalId: claimedJob.goal_id,
      jobId: claimedJob.id,
      reason: "goal_not_found",
      message
    });
  }

  if (!goal.repo) {
    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: "goal_missing_repo"
    });
    const message = released.ok
      ? `Released claim on job ${claimedJob.id}; goal ${claimedJob.goal_id} has no repo path.`
      : `Could not release claim on job ${claimedJob.id}; it was reclaimed.`;
    return notExecutedFailure({
      ...baseData,
      goalId: claimedJob.goal_id,
      jobId: claimedJob.id,
      reason: "goal_missing_repo",
      message
    });
  }

  const goalArtifactPaths = resolveGoalArtifactPaths(input.dataDir, goal.id);
  const specResult = parseGoalSpecFile(goalArtifactPaths.goalMd);
  if (!specResult.ok) {
    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: "invalid_goal_spec"
    });
    const message = released.ok
      ? `Released claim on job ${claimedJob.id}; failed to parse queued goal artifact.`
      : `Could not release claim on job ${claimedJob.id}; it was reclaimed.`;
    return notExecutedFailure({
      ...baseData,
      goalId: claimedJob.goal_id,
      jobId: claimedJob.id,
      reason: "invalid_goal_spec",
      message,
      error: specResult.error
    });
  }

  const spec = {
    ...specResult.spec,
    repo: goal.repo,
    runner: goal.runner
  };
  if (spec.repo.trim().length === 0) {
    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: "missing_repo_in_goal"
    });
    const message = released.ok
      ? `Released claim on job ${claimedJob.id}; no repo path available for execution.`
      : `Could not release claim on job ${claimedJob.id}; it was reclaimed.`;
    return notExecutedFailure({
      ...baseData,
      goalId: claimedJob.goal_id,
      jobId: claimedJob.id,
      reason: "missing_repo_in_goal",
      message,
      error: "Goal repo path unavailable."
    });
  }

  const lockNow = now();
  const lockLeaseExpiresAt = claimNow + leaseDurationMs;
  const lockResult = acquireRepoLock(input.db, {
    repoRoot: goal.repo,
    holder: workerId,
    goalId: goal.id,
    iteration: claimedJob.iteration,
    jobId: claimedJob.id,
    leaseExpiresAt: lockLeaseExpiresAt,
    now: lockNow
  });

  if (!lockResult.ok) {
    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: `repo_lock_${lockResult.reason}`
    });
    return notExecutedFailure({
      ...baseData,
      goalId: goal.id,
      jobId: claimedJob.id,
      reason: released.ok
        ? `repo_lock_${lockResult.reason}`
        : "repo_lock_release_failed",
      lockId: lockResult.existing.id,
      message: released.ok
        ? `Could not acquire repo lock for ${goal.repo}; lock already held by ${lockResult.existing.holder}.`
        : `Could not acquire repo lock for ${goal.repo}; lock already held by ${lockResult.existing.holder}. Claim release also failed.`
    });
  }

  const lock = lockResult.lock;
  const heartbeatNow = now();
  const heartbeat = heartbeatGoalIterationJob(input.db, {
    jobId: claimedJob.id,
    lockId: lock.id,
    workerId,
    leaseDurationMs,
    now: heartbeatNow
  });

  if (!heartbeat.ok) {
    releaseRepoLock(input.db, {
      lockId: lock.id,
      now: now(),
      recoveryStatus: "heartbeat_rejected_before_run"
    });

    const released = releaseClaimedGoalIterationJob(input.db, {
      jobId: claimedJob.id,
      workerId,
      reason: "heartbeat_rejected"
    });

    return notExecutedFailure({
      ...baseData,
      goalId: goal.id,
      jobId: claimedJob.id,
      reason: released.ok ? "heartbeat_rejected" : "heartbeat_rejected_release_failed",
      lockId: lock.id,
      message: released.ok
        ? "Job heartbeat could not be refreshed before execution; claim was released."
        : "Job heartbeat could not be refreshed before execution; claim release also failed."
    });
  }

  const runningJob = heartbeat.job;
  const iterationArtifactPaths = ensureIterationArtifactDir(
    input.dataDir,
    goal.id,
    runningJob.iteration
  );

  try {
    input.hooks?.onJobClaimed?.({
      goalId: goal.id,
      jobId: runningJob.id,
      lockId: lock.id,
      iteration: runningJob.iteration,
      workerId,
      now: heartbeatNow
    });
  } catch (error) {
    releaseRepoLock(input.db, {
      lockId: lock.id,
      now: now(),
      recoveryStatus: "job_claim_hook_failed"
    });
    releaseClaimedGoalIterationJob(input.db, {
      jobId: runningJob.id,
      workerId,
      reason: "job_claim_hook_failed"
    });
    throw error;
  }

  const iterationResult = executeIterationJob({
    db: input.db,
    goalId: goal.id,
    jobId: runningJob.id,
    spec,
    artifactPaths: iterationArtifactPaths,
    iteration: runningJob.iteration,
    now
  });

  const releaseNow = now();
  releaseRepoLock(input.db, {
    lockId: lock.id,
    now: releaseNow,
    recoveryStatus: iterationResult.ok ? "iteration_success" : "iteration_failure"
  });

  let releaseHookError: Error | null = null;
  try {
    input.hooks?.onJobReleased?.({
      goalId: goal.id,
      jobId: runningJob.id,
      lockId: lock.id,
      iteration: runningJob.iteration,
      workerId,
      now: releaseNow,
      outcome: iterationResult.ok ? "success" : "failure"
    });
  } catch (error) {
    releaseHookError = error instanceof Error ? error : new Error(String(error));
  }

  if (iterationResult.ok) {
    const iter = iterationResult.iteration;
    appendQueueEvent(input.db, {
      goalId: goal.id,
      jobId: runningJob.id,
      type: QUEUE_EVENT_TYPES.JOB_SUCCEEDED,
      payload: {
        iteration: runningJob.iteration,
        worker_id: workerId,
        repo_root: goal.repo,
        lock_id: lock.id,
        goal_state: iterationResult.goalState,
        job_state: iterationResult.jobState,
        heartbeat_at: runningJob.heartbeat_at,
        lease_expires_at: runningJob.lease_expires_at,
        branch: iter.branch,
        branch_created: iter.branchCreated,
        base_head: iter.baseHead,
        commit_sha: iter.commitSha,
        commit_message: iter.commitMessage,
        goal_complete: iter.result.goal_complete,
        result_path: iter.resultJsonPath,
        artifacts: {
          iteration_dir: iterationArtifactPaths.iterationDir,
          prompt: iter.promptPath,
          runner_log: iter.runnerLogPath,
          verification_log: iter.verificationLogPath,
          result_json: iter.resultJsonPath
        }
      },
      createdAt: now()
    });
  } else {
    appendQueueEvent(input.db, {
      goalId: goal.id,
      jobId: runningJob.id,
      type: QUEUE_EVENT_TYPES.JOB_FAILED,
      payload: {
        iteration: runningJob.iteration,
        worker_id: workerId,
        repo_root: goal.repo,
        lock_id: lock.id,
        error: summarizeIterationFailure(iterationResult.iteration),
        artifacts: {
          iteration_dir: iterationArtifactPaths.iterationDir,
          runner_log: iterationArtifactPaths.runnerLog,
          verification_log: iterationArtifactPaths.verificationLog
        }
      },
      createdAt: now()
    });
  }

  let reducer: ReducerResult | null = null;
  let reducerError: string | null = null;
  try {
    reducer = reduceGoalIteration({
      db: input.db,
      goalId: goal.id,
      jobId: runningJob.id,
      now
    });
  } catch (error) {
    reducerError =
      error instanceof Error ? error.message : String(error);
    try {
      appendQueueEvent(input.db, {
        goalId: goal.id,
        jobId: runningJob.id,
        type: QUEUE_EVENT_TYPES.GOAL_REDUCE_FAILED,
        payload: {
          iteration: runningJob.iteration,
          worker_id: workerId,
          job_state: iterationResult.jobState,
          error: reducerError
        },
        createdAt: now()
      });
    } catch {
      reducerError = `${reducerError}; goal.reduce_failed event write also failed`;
    }
  }

  if (releaseHookError !== null) {
    throw releaseHookError;
  }

  return {
    code: "ran_job",
    ok: iterationResult.ok && reducerError === null,
    ...baseData,
    outcome: "ran_job",
    goalId: goal.id,
    jobId: runningJob.id,
    lockId: lock.id,
    goalState: iterationResult.goalState,
    jobState: iterationResult.jobState,
    iteration: runningJob.iteration,
    repoRoot: goal.repo,
    leaseExpiresAt: heartbeatNow + leaseDurationMs,
    heartbeatAt: heartbeatNow,
    jobIterationResult: iterationResult,
    reducer,
    reducerError,
    message: reducerError !== null
      ? `Ran goal ${goal.id} iteration ${runningJob.iteration}, but reducer failed: ${reducerError}`
      : iterationResult.ok
      ? `Ran goal ${goal.id} iteration ${runningJob.iteration} as claimed job ${runningJob.id}.`
      : `Ran goal ${goal.id} iteration ${runningJob.iteration} with runner outcome ${summarizeIterationFailure(
        iterationResult.iteration
      )}.`
  };
}

function getGoalRow(db: MomentumDb, goalId: string): GoalRow | undefined {
  const goal = getGoal(db, goalId);
  if (!goal) return undefined;
  return { id: goal.id, repo: goal.repo, runner: goal.runner };
}

function summarizeIterationFailure(result: ExecuteIterationJobResult["iteration"]): string {
  if (result.ok) {
    return "ok";
  }
  return result.code;
}

function notExecutedFailure(input: {
  workerId: string;
  dataDir: string;
  goalId: string;
  jobId: string;
  reason: string;
  message: string;
  lockId?: string;
  error?: string;
}): WorkerRunNoClaimResult {
  const payload: WorkerRunNoClaimResult = {
    code: "not_executed",
    workerId: input.workerId,
    dataDir: input.dataDir,
    outcome: "not_executed",
    goalId: input.goalId,
    jobId: input.jobId,
    reason: input.reason,
    message: input.message
  };
  if (input.lockId !== undefined) {
    payload.lockId = input.lockId;
  }
  if (input.error !== undefined) {
    payload.error = input.error;
  }
  return payload;
}
