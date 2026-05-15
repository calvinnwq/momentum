import fs from "node:fs";

import {
  resolveGoalArtifactPaths,
  type GoalArtifactPaths
} from "./artifacts.js";
import {
  getActiveDaemonRun,
  getLatestDaemonRun,
  isActiveDaemonRunState,
  isTerminalDaemonRunState,
  type DaemonCancelOutcome,
  type DaemonRunRow,
  type DaemonRunState
} from "./daemon-runs.js";
import { DEFAULT_STALE_LEASE_GRACE_MS } from "./daemon-status.js";
import { resolveDataDir, type DataDirOptions } from "./data-dir.js";
import { openDb, type MomentumDb } from "./db.js";
import { QUEUE_EVENT_TYPES } from "./events.js";
import { getGoal, type GoalRow } from "./goal-init.js";
import { GOAL_ITERATION_JOB_TYPE } from "./queue-jobs.js";
import {
  buildRunnerProfile,
  isBuiltinRunnerKind,
  type RunnerProfile
} from "./runner-profile.js";

export type GoalStatusErrorCode =
  | "invalid_input"
  | "data_dir_failed"
  | "goal_not_found"
  | "no_goals";

export type GoalStatusError = {
  ok: false;
  code: GoalStatusErrorCode;
  error: string;
};

export type GoalStatusJobSummary = {
  jobId: string;
  type: string;
  iteration: number;
  state: string;
  attemptCount: number;
  artifactPath: string;
  resultPath: string | null;
  errorPath: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  idempotencyKey: string | null;
  leaseHolder: string | null;
  leaseAcquiredAt: number | null;
  leaseHeartbeatAt: number | null;
  leaseExpiresAt: number | null;
};

export type GoalStatusIterationFailure = {
  code: string;
  error: string;
};

export type GoalStatusIterationSummary = {
  iteration: number;
  startedAt: number | null;
  finishedAt: number | null;
  branch: string | null;
  branchCreated: boolean | null;
  baseHead: string | null;
  postRunnerHead: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  runnerSuccess: boolean | null;
  goalComplete: boolean | null;
  failure: GoalStatusIterationFailure | null;
};

export type GoalStatusArtifactFiles = {
  goalMd: boolean;
  ledgerMd: boolean;
  handoffMd: boolean;
  handoffJson: boolean;
  recoveryMd: boolean;
  promptMd: boolean;
  runnerLog: boolean;
  verificationLog: boolean;
  resultJson: boolean;
};

export type GoalStatusArtifactEntry = {
  path: string;
  exists: boolean;
};

export type GoalStatusArtifactsView = {
  iteration: number;
  goalDir: string;
  iterationDir: string;
  goalMd: GoalStatusArtifactEntry;
  ledgerMd: GoalStatusArtifactEntry;
  handoffMd: GoalStatusArtifactEntry;
  handoffJson: GoalStatusArtifactEntry;
  recoveryMd: GoalStatusArtifactEntry;
  promptMd: GoalStatusArtifactEntry;
  runnerLog: GoalStatusArtifactEntry;
  verificationLog: GoalStatusArtifactEntry;
  resultJson: GoalStatusArtifactEntry;
};

export type GoalStatusReducerNextJob = {
  jobId: string;
  iteration: number;
  idempotencyKey: string;
  artifactPath: string;
};

export type GoalStatusReducerSummary = {
  decision: string;
  jobId: string;
  iteration: number;
  jobState: string | null;
  goalState: string | null;
  completionReason: string | null;
  goalComplete: boolean | null;
  commitSha: string | null;
  maxIterations: number | null;
  recordedAt: number;
  nextJob: GoalStatusReducerNextJob | null;
};

export type GoalStatusNextActionKind =
  | "manual_recovery_required"
  | "run_worker"
  | "resume_foreground"
  | "goal_complete"
  | "max_iterations_reached"
  | "iteration_failed";

export type GoalStatusNextActionDetail = {
  kind: GoalStatusNextActionKind;
  message: string;
  jobId: string | null;
  iteration: number | null;
};

export type GoalStatusCurrentIterationDetail = {
  number: number;
  jobId: string;
  state: string;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type GoalStatusDaemonStopRequest = {
  requestedAt: number;
  reason: string;
};

export type GoalStatusDaemonStopNowRequest = {
  requestedAt: number;
  reason: string;
};

export type GoalStatusDaemonCancelOutcome = {
  outcome: DaemonCancelOutcome;
};

export type GoalStatusDaemonActiveJob = {
  jobId: string | null;
  lockId: string | null;
};

export type GoalStatusDaemonSummary = {
  runId: string;
  state: DaemonRunState;
  isActive: boolean;
  isTerminal: boolean;
  startedAt: number;
  heartbeatAt: number;
  finishedAt: number | null;
  activeJob: GoalStatusDaemonActiveJob;
  stopRequest: GoalStatusDaemonStopRequest | null;
  stopNowRequest: GoalStatusDaemonStopNowRequest | null;
  cancelOutcome: GoalStatusDaemonCancelOutcome | null;
};

/**
 * Goal-scoped view of NGX-276 stale-lease recovery. Surfaces (a) the count and
 * latest timestamp of `repo_lock.recovered` / `job.recovered` events recorded
 * for this goal so prior auto-recovery actions are visible to operators, and
 * (b) the current count of repo locks / claimed or running goal_iteration jobs
 * still asserting ownership for this goal whose lease has already expired.
 * Those currently stale records may require manual recovery, but this read-only
 * summary does not know whether a startup recovery pass has already classified
 * or skipped them.
 *
 * The grace tolerance mirrors `daemon status` so the same rows are classified
 * stale by the read-only inspector and by this surface. Daemon-level recovery
 * is NOT surfaced here because it is not goal-scoped — operators consult
 * `daemon status` / `doctor` for the system-wide daemon picture.
 */
export type GoalStatusStaleRecoverySummary = {
  recoveredRepoLockCount: number;
  recoveredJobCount: number;
  latestRecoveredRepoLockAt: number | null;
  latestRecoveredJobAt: number | null;
  staleRepoLockCount: number;
  staleClaimedJobCount: number;
  staleLeaseGraceMs: number;
};

export type GoalStatusSuccess = {
  ok: true;
  dataDir: string;
  goalId: string;
  title: string;
  state: string;
  goalState: string;
  repo: string | null;
  branch: string;
  runner: string;
  runnerProfile: RunnerProfile | null;
  maxIterations: number;
  currentIteration: number;
  completionReason: string | null;
  verification: string[];
  verificationTimeoutSec: number;
  artifactDir: string;
  artifactPaths: GoalArtifactPaths;
  artifactFiles: GoalStatusArtifactFiles;
  artifacts: GoalStatusArtifactsView;
  createdAt: number;
  updatedAt: number;
  latestJob: GoalStatusJobSummary | null;
  iteration: GoalStatusIterationSummary | null;
  currentIterationDetail: GoalStatusCurrentIterationDetail | null;
  reducer: GoalStatusReducerSummary | null;
  nextJob: GoalStatusJobSummary | null;
  nextAction: string | null;
  nextActionDetail: GoalStatusNextActionDetail | null;
  latestCommitSha: string | null;
  daemon: GoalStatusDaemonSummary | null;
  staleRecovery: GoalStatusStaleRecoverySummary;
};

export type GoalStatusResult = GoalStatusError | GoalStatusSuccess;

export type LoadGoalStatusInput = {
  goalId?: string;
  dataDirOptions?: DataDirOptions;
};

type JobRow = {
  id: string;
  goal_id: string;
  type: string;
  iteration: number;
  state: string;
  attempt_count: number;
  artifact_path: string;
  result_path: string | null;
  error_path: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  idempotency_key: string | null;
  worker_id: string | null;
  lease_acquired_at: number | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
};

type EventRow = {
  id: number;
  goal_id: string;
  job_id: string | null;
  type: string;
  payload: string;
  created_at: number;
};

export function loadGoalStatus(input: LoadGoalStatusInput = {}): GoalStatusResult {
  if (input.goalId !== undefined && input.goalId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "goalId must be a non-empty string when provided."
    };
  }

  let dataDir: string;
  try {
    dataDir = resolveDataDir(input.dataDirOptions ?? {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "data_dir_failed",
      error: `failed to resolve data directory: ${detail}`
    };
  }

  let db: MomentumDb | undefined;
  try {
    db = openDb(dataDir);

    const goal = input.goalId !== undefined
      ? getGoal(db, input.goalId)
      : findLatestGoal(db);

    if (!goal) {
      if (input.goalId !== undefined) {
        return {
          ok: false,
          code: "goal_not_found",
          error: `Goal ${input.goalId} was not found in ${dataDir}.`
        };
      }
      return {
        ok: false,
        code: "no_goals",
        error: `No goals found in ${dataDir}.`
      };
    }

    const latestJob = findLatestJob(db, goal.id);
    const iteration = latestJob ? buildIterationSummary(db, goal.id, latestJob) : null;

    const artifactPaths = resolveGoalArtifactPaths(
      dataDir,
      goal.id,
      selectArtifactIteration(goal, latestJob)
    );
    const artifactFiles = computeArtifactFiles(artifactPaths);
    const artifacts = buildArtifactsView(artifactPaths, artifactFiles);

    const reducer = findLatestReducerSummary(db, goal.id);
    const nextJob = reducer?.nextJob
      ? findJobById(db, reducer.nextJob.jobId)
      : null;
    const latestJobSummary = latestJob ? toJobSummary(latestJob) : null;
    const nextJobSummary = nextJob ? toJobSummary(nextJob) : null;
    const currentIterationDetail = latestJob
      ? toCurrentIterationDetail(latestJob)
      : null;
    const nextActionDetail = computeNextActionDetail(
      goal,
      latestJobSummary,
      reducer,
      nextJobSummary
    );
    const nextAction = nextActionDetail?.message ?? null;

    const latestCommitSha =
      iteration?.commitSha ?? reducer?.commitSha ?? null;

    const daemon = buildDaemonSummary(db);
    const staleRecovery = buildStaleRecoverySummary(db, goal.id);

    return {
      ok: true,
      dataDir,
      goalId: goal.id,
      title: goal.title,
      state: goal.state,
      goalState: goal.state,
      repo: goal.repo,
      branch: goal.branch,
      runner: goal.runner,
      runnerProfile: isBuiltinRunnerKind(goal.runner)
        ? buildRunnerProfile(goal.runner)
        : null,
      maxIterations: goal.max_iterations,
      currentIteration: goal.current_iteration,
      completionReason: goal.completion_reason,
      verification: parseVerification(goal.verification),
      verificationTimeoutSec: goal.verification_timeout_sec,
      artifactDir: goal.artifact_dir,
      artifactPaths,
      artifactFiles,
      artifacts,
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      latestJob: latestJobSummary,
      iteration,
      currentIterationDetail,
      reducer,
      nextJob: nextJobSummary,
      nextAction,
      nextActionDetail,
      latestCommitSha,
      daemon,
      staleRecovery
    };
  } finally {
    db?.close();
  }
}

type RecoveryEventAggregateRow = {
  type: string;
  count: number;
  max_created_at: number | null;
};

type StaleRecoveryCountRow = {
  count: number;
};

function buildStaleRecoverySummary(
  db: MomentumDb,
  goalId: string,
  now: number = Date.now(),
  graceMs: number = DEFAULT_STALE_LEASE_GRACE_MS
): GoalStatusStaleRecoverySummary {
  const cutoff = now - graceMs;

  const recoveryAggregates = db
    .prepare(
      `SELECT type, COUNT(*) AS count, MAX(created_at) AS max_created_at
         FROM events
        WHERE goal_id = ? AND type IN (?, ?)
        GROUP BY type`
    )
    .all(
      goalId,
      QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED,
      QUEUE_EVENT_TYPES.JOB_RECOVERED
    ) as RecoveryEventAggregateRow[];

  let recoveredRepoLockCount = 0;
  let recoveredJobCount = 0;
  let latestRecoveredRepoLockAt: number | null = null;
  let latestRecoveredJobAt: number | null = null;
  for (const row of recoveryAggregates) {
    if (row.type === QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED) {
      recoveredRepoLockCount = row.count;
      latestRecoveredRepoLockAt = row.max_created_at;
    } else if (row.type === QUEUE_EVENT_TYPES.JOB_RECOVERED) {
      recoveredJobCount = row.count;
      latestRecoveredJobAt = row.max_created_at;
    }
  }

  const staleRepoLockRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM repo_locks
        WHERE goal_id = ? AND state = 'active' AND lease_expires_at < ?`
    )
    .get(goalId, cutoff) as StaleRecoveryCountRow;

  const staleClaimedJobRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM jobs
        WHERE goal_id = ?
          AND type = ?
          AND state IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ?`
    )
    .get(goalId, GOAL_ITERATION_JOB_TYPE, cutoff) as StaleRecoveryCountRow;

  return {
    recoveredRepoLockCount,
    recoveredJobCount,
    latestRecoveredRepoLockAt,
    latestRecoveredJobAt,
    staleRepoLockCount: staleRepoLockRow.count,
    staleClaimedJobCount: staleClaimedJobRow.count,
    staleLeaseGraceMs: graceMs
  };
}

function buildDaemonSummary(
  db: MomentumDb
): GoalStatusDaemonSummary | null {
  const row = getActiveDaemonRun(db) ?? getLatestDaemonRun(db);
  if (!row) return null;
  return toDaemonSummary(row);
}

function toDaemonSummary(row: DaemonRunRow): GoalStatusDaemonSummary {
  return {
    runId: row.id,
    state: row.state,
    isActive: isActiveDaemonRunState(row.state),
    isTerminal: isTerminalDaemonRunState(row.state),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    activeJob: { jobId: row.active_job_id, lockId: row.active_lock_id },
    stopRequest:
      row.stop_requested_at !== null
        ? {
            requestedAt: row.stop_requested_at,
            reason: row.stop_reason ?? ""
          }
        : null,
    stopNowRequest:
      row.stop_now_requested_at !== null
        ? {
            requestedAt: row.stop_now_requested_at,
            reason: row.stop_reason ?? ""
          }
        : null,
    cancelOutcome:
      row.cancel_outcome !== null ? { outcome: row.cancel_outcome } : null
  };
}

function findLatestGoal(db: MomentumDb): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM goals ORDER BY created_at DESC, id ASC LIMIT 1")
    .get() as GoalRow | undefined;
}

function findLatestJob(db: MomentumDb, goalId: string): JobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE goal_id = ?
       ORDER BY iteration DESC, created_at DESC
       LIMIT 1`
    )
    .get(goalId) as JobRow | undefined;
}

function findJobById(db: MomentumDb, jobId: string): JobRow | undefined {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(jobId) as JobRow | undefined;
}

function selectArtifactIteration(goal: GoalRow, latestJob: JobRow | undefined): number {
  if (latestJob && latestJob.state !== "pending") {
    return latestJob.iteration;
  }
  if (goal.current_iteration > 0) {
    return goal.current_iteration;
  }
  return latestJob?.iteration ?? 1;
}

function findLatestReducerSummary(
  db: MomentumDb,
  goalId: string
): GoalStatusReducerSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM events
         WHERE goal_id = ? AND type = 'goal.reduced'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
    )
    .get(goalId) as EventRow | undefined;
  if (!row || !row.job_id) return null;

  const payload = parsePayload(row.payload);
  if (!payload) return null;

  const iteration =
    typeof payload["iteration"] === "number"
      ? (payload["iteration"] as number)
      : 0;
  const decision = pickString(payload, "decision") ?? "unknown";
  const maxIterRaw = payload["max_iterations"];
  const maxIterations =
    typeof maxIterRaw === "number" ? (maxIterRaw as number) : null;

  return {
    decision,
    jobId: row.job_id,
    iteration,
    jobState: pickString(payload, "job_state"),
    goalState: pickString(payload, "goal_state"),
    completionReason: pickString(payload, "completion_reason"),
    goalComplete: pickBool(payload, "goal_complete"),
    commitSha: pickString(payload, "commit_sha"),
    maxIterations,
    recordedAt: row.created_at,
    nextJob: readReducerNextJob(payload)
  };
}

function readReducerNextJob(
  payload: Record<string, unknown>
): GoalStatusReducerNextJob | null {
  const raw = payload["next_job"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const jobId = pickString(entry, "job_id");
  const idempotencyKey = pickString(entry, "idempotency_key");
  const artifactPath = pickString(entry, "artifact_path");
  const iteration =
    typeof entry["iteration"] === "number"
      ? (entry["iteration"] as number)
      : null;
  if (!jobId || !idempotencyKey || !artifactPath || iteration === null) {
    return null;
  }
  return { jobId, iteration, idempotencyKey, artifactPath };
}

function computeNextActionDetail(
  goal: GoalRow,
  latestJob: GoalStatusJobSummary | null,
  reducer: GoalStatusReducerSummary | null,
  nextJob: GoalStatusJobSummary | null
): GoalStatusNextActionDetail | null {
  if (goal.needs_manual_recovery === 1) {
    const activeJob = [latestJob, nextJob].find(
      (job) => job?.state === "claimed" || job?.state === "running"
    );
    const activeJobMessage = activeJob
      ? " If a stale active job is still listed, first re-run daemon startup recovery " +
        "or otherwise release/finalize that job; `recovery clear` refuses active jobs."
      : "";
    return {
      kind: "manual_recovery_required",
      message:
        "Manual recovery required; inspect recovery.md, resolve the blocked state, " +
        "then run `momentum recovery clear <goal-id>`." +
        activeJobMessage,
      jobId: latestJob?.jobId ?? nextJob?.jobId ?? reducer?.jobId ?? null,
      iteration:
        latestJob?.iteration ?? nextJob?.iteration ?? reducer?.iteration ?? null
    };
  }

  if (reducer) {
    if (reducer.decision === "continue" && nextJob) {
      return {
        kind: "run_worker",
        message:
          `Run \`momentum worker run\` to claim queued ${GOAL_ITERATION_JOB_TYPE} ` +
          `job ${nextJob.jobId} (iteration ${nextJob.iteration}).`,
        jobId: nextJob.jobId,
        iteration: nextJob.iteration
      };
    }
    if (reducer.decision === "goal_complete") {
      return {
        kind: "goal_complete",
        message: "Goal completed; no further iterations will be enqueued.",
        jobId: reducer.jobId,
        iteration: reducer.iteration
      };
    }
    if (reducer.decision === "max_iterations_reached") {
      return {
        kind: "max_iterations_reached",
        message:
          `Goal reached max_iterations (${goal.max_iterations}); ` +
          "no further iterations will be enqueued.",
        jobId: reducer.jobId,
        iteration: reducer.iteration
      };
    }
    if (reducer.decision === "iteration_failed") {
      return {
        kind: "iteration_failed",
        message:
          "Goal failed; inspect the latest job error_path before retrying.",
        jobId: reducer.jobId,
        iteration: reducer.iteration
      };
    }
  }

  if (latestJob && latestJob.state === "pending") {
    if (latestJob.type === GOAL_ITERATION_JOB_TYPE) {
      return {
        kind: "run_worker",
        message:
          `Run \`momentum worker run\` to claim queued ${GOAL_ITERATION_JOB_TYPE} ` +
          `job ${latestJob.jobId} (iteration ${latestJob.iteration}).`,
        jobId: latestJob.jobId,
        iteration: latestJob.iteration
      };
    }
    if (latestJob.type === "foreground_iteration") {
      return {
        kind: "resume_foreground",
        message:
          `Run \`momentum goal start --foreground\` (resume) to execute ` +
          `iteration ${latestJob.iteration} (job ${latestJob.jobId}).`,
        jobId: latestJob.jobId,
        iteration: latestJob.iteration
      };
    }
  }

  return null;
}

function findLatestEventByType(
  db: MomentumDb,
  goalId: string,
  jobId: string,
  type: string
): EventRow | undefined {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE goal_id = ? AND job_id = ? AND type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(goalId, jobId, type) as EventRow | undefined;
}

function toCurrentIterationDetail(
  row: JobRow
): GoalStatusCurrentIterationDetail {
  return {
    number: row.iteration,
    jobId: row.id,
    state: row.state,
    queuedAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.finished_at
  };
}

function toJobSummary(row: JobRow): GoalStatusJobSummary {
  return {
    jobId: row.id,
    type: row.type,
    iteration: row.iteration,
    state: row.state,
    attemptCount: row.attempt_count,
    artifactPath: row.artifact_path,
    resultPath: row.result_path,
    errorPath: row.error_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    leaseHolder: row.worker_id,
    leaseAcquiredAt: row.lease_acquired_at,
    leaseHeartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at
  };
}

function buildIterationSummary(
  db: MomentumDb,
  goalId: string,
  job: JobRow
): GoalStatusIterationSummary | null {
  const started = findLatestEventByType(db, goalId, job.id, "iteration_started");
  const completed = findLatestEventByType(db, goalId, job.id, "iteration_completed");
  const failed = findLatestEventByType(db, goalId, job.id, "iteration_failed");

  if (!started && !completed && !failed) {
    return null;
  }

  const startedPayload = parsePayload(started?.payload);
  const completedPayload = parsePayload(completed?.payload);
  const failedPayload = parsePayload(failed?.payload);

  return {
    iteration: job.iteration,
    startedAt: started?.created_at ?? job.started_at,
    finishedAt: completed?.created_at ?? failed?.created_at ?? job.finished_at,
    branch: pickString(completedPayload, "branch") ?? pickString(startedPayload, "branch"),
    branchCreated: pickBool(completedPayload, "branch_created"),
    baseHead: pickString(completedPayload, "base_head"),
    postRunnerHead: pickString(completedPayload, "post_runner_head"),
    commitSha: pickString(completedPayload, "commit_sha"),
    commitMessage: pickString(completedPayload, "commit_message"),
    runnerSuccess: pickBool(completedPayload, "runner_success"),
    goalComplete: pickBool(completedPayload, "goal_complete"),
    failure: failedPayload
      ? {
          code: pickString(failedPayload, "code") ?? "unknown",
          error: pickString(failedPayload, "error") ?? job.error ?? ""
        }
      : null
  };
}

function parsePayload(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function pickString(
  payload: Record<string, unknown> | null,
  key: string
): string | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function pickBool(
  payload: Record<string, unknown> | null,
  key: string
): boolean | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function parseVerification(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
}

function computeArtifactFiles(paths: GoalArtifactPaths): GoalStatusArtifactFiles {
  return {
    goalMd: fs.existsSync(paths.goalMd),
    ledgerMd: fs.existsSync(paths.ledgerMd),
    handoffMd: fs.existsSync(paths.handoffMd),
    handoffJson: fs.existsSync(paths.handoffJson),
    recoveryMd: fs.existsSync(paths.recoveryMd),
    promptMd: fs.existsSync(paths.promptMd),
    runnerLog: fs.existsSync(paths.runnerLog),
    verificationLog: fs.existsSync(paths.verificationLog),
    resultJson: fs.existsSync(paths.resultJson)
  };
}

function buildArtifactsView(
  paths: GoalArtifactPaths,
  files: GoalStatusArtifactFiles
): GoalStatusArtifactsView {
  return {
    iteration: paths.iteration,
    goalDir: paths.goalDir,
    iterationDir: paths.iterationDir,
    goalMd: { path: paths.goalMd, exists: files.goalMd },
    ledgerMd: { path: paths.ledgerMd, exists: files.ledgerMd },
    handoffMd: { path: paths.handoffMd, exists: files.handoffMd },
    handoffJson: { path: paths.handoffJson, exists: files.handoffJson },
    recoveryMd: { path: paths.recoveryMd, exists: files.recoveryMd },
    promptMd: { path: paths.promptMd, exists: files.promptMd },
    runnerLog: { path: paths.runnerLog, exists: files.runnerLog },
    verificationLog: {
      path: paths.verificationLog,
      exists: files.verificationLog
    },
    resultJson: { path: paths.resultJson, exists: files.resultJson }
  };
}
