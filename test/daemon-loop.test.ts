import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  requestDaemonRunImmediateStop,
  requestDaemonRunStop,
  startDaemonRun
} from "../src/daemon-runs.js";
import {
  runDaemonLoop,
  type DaemonLoopInput,
  type DaemonLoopResult
} from "../src/daemon-loop.js";
import {
  acquireRepoLock,
  getRepoLock
} from "../src/repo-locks.js";
import {
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob
} from "../src/queue-jobs.js";
import { JOB_RECOVERED_AUTO_REPENDED_STATUS, REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS } from "../src/stale-recovery.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_GOAL_COMPLETE_ENV,
  FAKE_RUNNER_TRAJECTORY_ENV
} from "../src/fake-runner.js";
import { initGoal } from "../src/goal-init.js";
import type {
  WorkerRunInput,
  WorkerRunResult
} from "../src/worker-run.js";
import {
  WORKFLOW_DISPATCH_LEASE_KIND,
  type ClaimedWorkflowStep,
  type RunWorkflowSchedulerOnceResult,
  type WorkflowStepDispatch,
  type WorkflowStepDispatchContext,
  type WorkflowStepDispatchResult
} from "../src/workflow-scheduler.js";
import { getWorkflowLease } from "../src/workflow-leases.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  delete process.env[FAKE_RUNNER_FAIL_ENV];
  delete process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV];
  delete process.env[FAKE_RUNNER_TRAJECTORY_ENV];
});

function makeTempDir(prefix = "momentum-daemon-loop-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-daemon-loop-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "daemon-loop@example.com"]);
  runGit(dir, ["config", "user.name", "Daemon Loop Tester"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "daemon loop\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function goalSpec(options: { maxIterations?: number } = {}): string {
  const maxIterationsLine =
    options.maxIterations !== undefined
      ? `max_iterations: ${options.maxIterations}\n`
      : "";
  return `---
title: Daemon Loop Test
runner: fake
${maxIterationsLine}verification:
  - "true"
---

Daemon loop coverage goal.
`;
}

function seedQueuedGoal(
  dataDir: string,
  repo: string,
  options: { maxIterations?: number } = {}
): { goalId: string; jobId: string } {
  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, goalSpec(options), "utf-8");
  const result = initGoal({
    goalPath: goalFile,
    repoOverride: repo,
    dataDirOptions: { dataDir },
    mode: "queued"
  });
  if (!result.ok) {
    throw new Error(`seedQueuedGoal: ${result.error}`);
  }
  return { goalId: result.goalId, jobId: result.jobId };
}

function seedDaemonRun(db: MomentumDb): string {
  const { runId } = startDaemonRun(db, {
    pid: 1234,
    host: "daemon-loop-test",
    now: 100_000
  });
  return runId;
}

function makeMonotonicNow(start = 1_700_000_000_000, stepMs = 1_000) {
  let value = start;
  return () => {
    const current = value;
    value += stepMs;
    return current;
  };
}

function makeRecordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    }
  };
}

describe("runDaemonLoop", () => {
  it("idles with deterministic polling and exits on maxIdleCycles", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const { calls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-idle",
        pollIntervalMs: 25,
        maxIdleCycles: 3,
        now: makeMonotonicNow(),
        sleep,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-idle",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.exitReason).toBe("max_idle_cycles");
      expect(result.terminalState).toBe("stopped");
      expect(result.workSucceeded).toBe(true);
      expect(result.idleCycles).toBe(3);
      expect(result.iterations).toBe(3);
      expect(result.jobsRun).toBe(0);
      expect(result.jobsFailed).toBe(0);
      expect(calls).toEqual([25, 25, 25]);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
      expect(row?.reconcile_count).toBe(3);
      expect(row?.active_job_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("exits immediately when the run is already stop_requested", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      requestDaemonRunStop(db, {
        runId,
        reason: "operator stop",
        now: 100_500
      });
      const { calls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop",
        sleep,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error("runWorker should not be called when stop_requested");
        }
      });

      expect(result.exitReason).toBe("stop_requested");
      expect(result.terminalState).toBe("stopped");
      expect(result.iterations).toBe(0);
      expect(result.idleCycles).toBe(0);
      expect(calls).toEqual([]);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("exits after the current cycle when stop is requested mid-loop", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      let cycleCount = 0;
      const { calls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-mid",
        pollIntervalMs: 10,
        now: makeMonotonicNow(),
        sleep,
        maxIdleCycles: 10,
        runWorker: () => {
          cycleCount += 1;
          if (cycleCount === 1) {
            requestDaemonRunStop(db, {
              runId,
              reason: "operator stop",
              now: 200_000
            });
          }
          return {
            code: "no_work",
            workerId: "daemon-loop-stop-mid",
            dataDir,
            outcome: "idle",
            message: "no work"
          };
        }
      });

      expect(result.exitReason).toBe("stop_requested");
      expect(result.iterations).toBe(1);
      expect(result.idleCycles).toBe(1);
      expect(calls).toEqual([10]);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("exits as canceled when stop_now is requested before any work", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "operator-now",
        now: 100_500
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-now-idle",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error(
            "runWorker should not be called when stop_now_requested before any cycle"
          );
        }
      });

      expect(result.exitReason).toBe("stop_now_requested");
      expect(result.terminalState).toBe("canceled");
      expect(result.cancelOutcome).toBe("idle");
      expect(result.iterations).toBe(0);
      expect(result.jobsRun).toBe(0);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("canceled");
      expect(row?.cancel_outcome).toBe("idle");
      expect(row?.stop_now_requested_at).toBe(100_500);
      expect(row?.finished_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("treats an already canceled stop-now run as terminal instead of a new stop-now request", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "operator-now",
        now: 100_500
      });
      finishDaemonRun(db, {
        runId,
        terminalState: "canceled",
        cancelOutcome: "idle",
        now: 100_750
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal-canceled",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error("runWorker should not be called for terminal runs");
        }
      });

      expect(result.exitReason).toBe("run_terminated");
      expect(result.terminalState).toBe("canceled");
      expect(result.cancelOutcome).toBe("idle");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("canceled");
      expect(row?.finished_at).toBe(100_750);
    } finally {
      db.close();
    }
  });

  it("upgrades to canceled mid-loop with active_job_completed when a job ran first", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      let cycleCount = 0;
      const { sleep } = makeRecordingSleep();

      const runWorker = (input: WorkerRunInput): WorkerRunResult => {
        cycleCount += 1;
        if (cycleCount > 1) {
          throw new Error(
            "runWorker should not run after stop_now is observed"
          );
        }
        const claimedAt = input.now ? input.now() : Date.now();
        input.hooks?.onJobClaimed?.({
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          iteration: 1,
          workerId: input.workerId,
          now: claimedAt
        });
        const releasedAt = input.now ? input.now() : Date.now();
        input.hooks?.onJobReleased?.({
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          iteration: 1,
          workerId: input.workerId,
          now: releasedAt,
          outcome: "success"
        });
        requestDaemonRunImmediateStop(db, {
          runId,
          reason: "operator-now",
          now: 200_000
        });
        return {
          code: "ran_job",
          ok: true,
          workerId: input.workerId,
          dataDir,
          outcome: "ran_job",
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          goalState: "completed",
          jobState: "succeeded",
          iteration: 1,
          repoRoot: "/tmp/fake",
          leaseExpiresAt: claimedAt + 1_000,
          heartbeatAt: claimedAt,
          jobIterationResult: { ok: true } as never,
          reducer: null,
          reducerError: null,
          message: "mocked ran_job"
        } as WorkerRunResult;
      };

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-now-mid",
        pollIntervalMs: 5,
        now: makeMonotonicNow(),
        sleep,
        maxIdleCycles: 10,
        runWorker
      });

      expect(result.exitReason).toBe("stop_now_requested");
      expect(result.terminalState).toBe("canceled");
      expect(result.cancelOutcome).toBe("active_job_completed");
      expect(result.iterations).toBe(1);
      expect(result.jobsRun).toBe(1);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("canceled");
      expect(row?.cancel_outcome).toBe("active_job_completed");
    } finally {
      db.close();
    }
  });

  it("treats stop_now as canceled even when a graceful stop was previously requested", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      requestDaemonRunStop(db, {
        runId,
        reason: "graceful",
        now: 100_100
      });
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "now-upgrade",
        now: 100_500
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-now-upgrade",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error(
            "runWorker should not be called once stop_now is observed"
          );
        }
      });

      expect(result.exitReason).toBe("stop_now_requested");
      expect(result.terminalState).toBe("canceled");
      expect(result.cancelOutcome).toBe("idle");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("canceled");
      expect(row?.stop_requested_at).toBe(100_100);
      expect(row?.stop_now_requested_at).toBe(100_500);
    } finally {
      db.close();
    }
  });

  it("records error terminal state when runWorker throws", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-error",
        pollIntervalMs: 5,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => {
          throw new Error("worker boom");
        }
      });

      expect(result.exitReason).toBe("internal_error");
      expect(result.terminalState).toBe("error");
      expect(result.ok).toBe(false);
      expect(result.workSucceeded).toBe(true);
      expect(result.error).toBe("worker boom");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("worker boom");
      expect(row?.error_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("records error terminal state when loop backoff fails", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-sleep-error",
        pollIntervalMs: 5,
        now: makeMonotonicNow(),
        sleep: async () => {
          throw new Error("sleep boom");
        },
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-sleep-error",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.exitReason).toBe("internal_error");
      expect(result.terminalState).toBe("error");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("sleep boom");
      expect(result.iterations).toBe(1);
      expect(result.idleCycles).toBe(1);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("sleep boom");
      expect(row?.active_job_id).toBeNull();
      expect(row?.finished_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("returns internal_error when cycle bookkeeping cannot be persisted", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    const runId = seedDaemonRun(db);
    db.close();

    const result = await runDaemonLoop({
      db,
      dataDir,
      runId,
      workerId: "daemon-loop-db-error",
      pollIntervalMs: 0,
      now: makeMonotonicNow(),
      sleep: async () => undefined,
      runWorker: () => {
        throw new Error("runWorker should not be called");
      }
    });

    expect(result.exitReason).toBe("internal_error");
    expect(result.terminalState).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/database is not open|closed/i);
    expect(result.iterations).toBe(0);
  });

  it("returns run_missing when the daemon run row is deleted before the loop runs", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      db.prepare("DELETE FROM daemon_runs WHERE id = ?").run(runId);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-missing",
        pollIntervalMs: 0,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error("runWorker should not be called when run is missing");
        }
      });

      expect(result.exitReason).toBe("run_missing");
      expect(result.ok).toBe(false);
      expect(result.terminalState).toBe("error");
      expect(result.iterations).toBe(0);
      expect(result.lastObservedState).toBeNull();
    } finally {
      db.close();
    }
  });

  it("treats terminal run rows as run_terminated", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      finishDaemonRun(db, {
        runId,
        terminalState: "stopped",
        now: 100_500
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal",
        pollIntervalMs: 0,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error("runWorker should not be called when run is terminal");
        }
      });

      expect(result.exitReason).toBe("run_terminated");
      expect(result.terminalState).toBe("stopped");
      expect(result.lastObservedState).toBe("stopped");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("preserves an observed terminal error state for run_terminated", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      finishDaemonRun(db, {
        runId,
        terminalState: "error",
        now: 100_500,
        error: "previous daemon failure"
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal-error",
        pollIntervalMs: 0,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        runWorker: () => {
          throw new Error("runWorker should not be called when run is terminal");
        }
      });

      expect(result.exitReason).toBe("run_terminated");
      expect(result.ok).toBe(false);
      expect(result.terminalState).toBe("error");
      expect(result.lastObservedState).toBe("error");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("previous daemon failure");
    } finally {
      db.close();
    }
  });

  it("updates active job/lock and heartbeat during work and clears them between jobs", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const states: Array<{
        phase: string;
        activeJobId: string | null;
        activeLockId: string | null;
        heartbeatAt: number | null;
      }> = [];

      const sampleState = (phase: string): void => {
        const row = getDaemonRun(db, runId);
        states.push({
          phase,
          activeJobId: row?.active_job_id ?? null,
          activeLockId: row?.active_lock_id ?? null,
          heartbeatAt: row?.heartbeat_at ?? null
        });
      };

      const runWorker = (input: WorkerRunInput): WorkerRunResult => {
        // Simulate the worker invoking the hooks like runWorkerOnce does.
        const claimedAt = input.now ? input.now() : Date.now();
        input.hooks?.onJobClaimed?.({
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          iteration: 1,
          workerId: input.workerId,
          now: claimedAt
        });
        sampleState("during");
        const releasedAt = input.now ? input.now() : Date.now();
        input.hooks?.onJobReleased?.({
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          iteration: 1,
          workerId: input.workerId,
          now: releasedAt,
          outcome: "success"
        });
        return {
          code: "ran_job",
          ok: true,
          workerId: input.workerId,
          dataDir,
          outcome: "ran_job",
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          goalState: "completed",
          jobState: "succeeded",
          iteration: 1,
          repoRoot: "/tmp/fake",
          leaseExpiresAt: claimedAt + 1_000,
          heartbeatAt: claimedAt,
          jobIterationResult: {
            ok: true,
            goalState: "completed",
            jobState: "succeeded",
            iteration: {
              ok: true
              // The inner iteration shape is unused for this assertion path.
            } as never
          } as never,
          reducer: null,
          reducerError: null,
          message: "mocked ran_job"
        } as WorkerRunResult;
      };

      sampleState("before");

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-active",
        pollIntervalMs: 5,
        maxLoopIterations: 1,
        skipStartupRecovery: true,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker
      });

      sampleState("after");

      expect(result.exitReason).toBe("max_loop_iterations");
      expect(result.iterations).toBe(1);
      expect(result.jobsRun).toBe(1);
      expect(states).toEqual([
        {
          phase: "before",
          activeJobId: null,
          activeLockId: null,
          heartbeatAt: 100_000
        },
        {
          phase: "during",
          activeJobId: "job-a",
          activeLockId: "lock-a",
          heartbeatAt: 1_700_000_001_000
        },
        {
          phase: "after",
          activeJobId: null,
          activeLockId: null,
          heartbeatAt: 1_700_000_002_000
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("drains a single queued goal end-to-end with the real worker", async () => {
    const dataDir = makeTempDir();
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo);
    process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV] = "1";
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const { calls: sleeps, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-real",
        pollIntervalMs: 10,
        maxIdleCycles: 2,
        sleep,
        now: makeMonotonicNow()
      });

      expect(result.jobsRun).toBe(1);
      expect(result.idleCycles).toBe(2);
      expect(result.exitReason).toBe("max_idle_cycles");
      expect(result.lastWorkerCode).toBe("no_work");
      expect(sleeps).toEqual([10, 10]);

      const goalRow = db
        .prepare("SELECT state, completion_reason FROM goals WHERE id = ?")
        .get(seed.goalId) as {
        state: string;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("completed");
      expect(goalRow.completion_reason).toBe("goal_complete");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
      expect(row?.active_job_id).toBeNull();
      expect(row?.reconcile_count).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it("drains a multi-iteration goal across reducer continuations until goal_complete", async () => {
    const dataDir = makeTempDir();
    const repo = initRepo();
    seedQueuedGoal(dataDir, repo, { maxIterations: 3 });
    process.env[FAKE_RUNNER_TRAJECTORY_ENV] = "ok|ok|complete";
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const { sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-multi",
        pollIntervalMs: 5,
        maxIdleCycles: 1,
        sleep,
        now: makeMonotonicNow()
      });

      expect(result.jobsRun).toBe(3);
      expect(result.jobsFailed).toBe(0);
      expect(result.idleCycles).toBe(1);

      const goalRow = db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals"
        )
        .get() as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("completed");
      expect(goalRow.current_iteration).toBe(3);
      expect(goalRow.completion_reason).toBe("goal_complete");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("stops between jobs without claiming the reducer-enqueued next iteration", async () => {
    const dataDir = makeTempDir();
    const repo = initRepo();
    const seed = seedQueuedGoal(dataDir, repo, { maxIterations: 3 });
    process.env[FAKE_RUNNER_TRAJECTORY_ENV] = "ok|ok|complete";
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const { sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-between",
        pollIntervalMs: 5,
        maxIdleCycles: 5,
        sleep,
        now: makeMonotonicNow(),
        onCycleComplete: (cycle) => {
          if (cycle.workerResult.code === "ran_job") {
            requestDaemonRunStop(db, {
              runId,
              reason: "stop after first job",
              now: 200_000
            });
          }
        }
      });

      expect(result.exitReason).toBe("stop_requested");
      expect(result.jobsRun).toBe(1);
      expect(result.jobsFailed).toBe(0);
      expect(result.terminalState).toBe("stopped");

      const goalRow = db
        .prepare(
          "SELECT state, current_iteration, completion_reason FROM goals WHERE id = ?"
        )
        .get(seed.goalId) as {
        state: string;
        current_iteration: number;
        completion_reason: string | null;
      };
      expect(goalRow.state).toBe("queued");
      expect(goalRow.completion_reason).toBeNull();
      expect(goalRow.current_iteration).toBe(1);

      const pendingJobs = db
        .prepare(
          "SELECT iteration, state FROM jobs WHERE goal_id = ? AND state = 'pending' ORDER BY iteration ASC"
        )
        .all(seed.goalId) as { iteration: number; state: string }[];
      expect(pendingJobs.length).toBe(1);
      expect(pendingJobs[0]?.iteration).toBe(2);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
      expect(row?.stop_reason).toBe("stop after first job");
      expect(row?.active_job_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("backs off after a not_executed cycle and continues idling", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      let cycle = 0;
      const sleeps: number[] = [];

      const result: DaemonLoopResult = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-not-executed",
        pollIntervalMs: 7,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        runWorker: () => {
          cycle += 1;
          if (cycle === 1) {
            return {
              code: "not_executed",
              workerId: "daemon-loop-not-executed",
              dataDir,
              outcome: "not_executed",
              reason: "repo_lock_already_locked",
              goalId: "goal-x",
              jobId: "job-x",
              message: "contention"
            };
          }
          return {
            code: "no_work",
            workerId: "daemon-loop-not-executed",
            dataDir,
            outcome: "idle",
            message: "no work"
          };
        }
      });

      expect(result.jobsNotExecuted).toBe(1);
      expect(result.idleCycles).toBe(1);
      expect(result.iterations).toBe(1);
      expect(sleeps).toEqual([7]);
    } finally {
      db.close();
    }
  });

  it("bounds repeated not_executed cycles with maxIdleCycles", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const sleeps: number[] = [];

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-not-executed-bound",
        pollIntervalMs: 9,
        maxIdleCycles: 2,
        now: makeMonotonicNow(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        runWorker: () => ({
          code: "not_executed",
          workerId: "daemon-loop-not-executed-bound",
          dataDir,
          outcome: "not_executed",
          reason: "repo_lock_already_locked",
          goalId: "goal-x",
          jobId: "job-x",
          message: "contention"
        })
      });

      expect(result.exitReason).toBe("max_idle_cycles");
      expect(result.jobsNotExecuted).toBe(2);
      expect(result.idleCycles).toBe(2);
      expect(result.iterations).toBe(2);
      expect(sleeps).toEqual([9, 9]);
    } finally {
      db.close();
    }
  });

  it("reports loop health separately from queued work success", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-failed-work",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "ran_job",
          ok: false,
          workerId: "daemon-loop-failed-work",
          dataDir,
          outcome: "ran_job",
          goalId: "goal-a",
          jobId: "job-a",
          lockId: "lock-a",
          goalState: "failed",
          jobState: "failed",
          iteration: 1,
          repoRoot: "/tmp/fake",
          leaseExpiresAt: 1,
          heartbeatAt: 1,
          jobIterationResult: {
            ok: false,
            goalState: "failed",
            jobState: "failed",
            iteration: {
              ok: false
            } as never
          } as never,
          reducer: null,
          reducerError: null,
          message: "mocked failed job"
        } as WorkerRunResult)
      });

      expect(result.ok).toBe(true);
      expect(result.workSucceeded).toBe(false);
      expect(result.jobsRun).toBe(1);
      expect(result.jobsFailed).toBe(1);
      expect(result.exitReason).toBe("max_loop_iterations");
    } finally {
      db.close();
    }
  });

  it("invokes onCycleComplete with the worker result for each cycle", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const observed: Array<{ index: number; code: WorkerRunResult["code"] }> =
        [];

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-observer",
        pollIntervalMs: 0,
        maxIdleCycles: 2,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        onCycleComplete: (cycle) => {
          observed.push({
            index: cycle.cycleIndex,
            code: cycle.workerResult.code
          });
        },
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-observer",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(observed).toEqual([
        { index: 0, code: "no_work" },
        { index: 1, code: "no_work" }
      ]);
    } finally {
      db.close();
    }
  });

  it("marks the daemon run as error when onCycleComplete throws", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-observer-error",
        pollIntervalMs: 0,
        maxIdleCycles: 2,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        onCycleComplete: () => {
          throw new Error("observer failed");
        },
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-observer-error",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.ok).toBe(false);
      expect(result.exitReason).toBe("internal_error");
      expect(result.terminalState).toBe("error");
      expect(result.error).toBe("observer failed");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("observer failed");
    } finally {
      db.close();
    }
  });

  it("validates pollIntervalMs", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const input: DaemonLoopInput = {
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-validate",
        pollIntervalMs: -1,
        sleep: async () => undefined,
        now: makeMonotonicNow()
      };
      await expect(runDaemonLoop(input)).rejects.toThrow(
        /pollIntervalMs/
      );
    } finally {
      db.close();
    }
  });

  it("runs startup recovery before the first cycle and surfaces the result", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      // Stale repo lock whose owning job is terminal: previous-daemon residue.
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-recover", "recover", "momentum/recover", "/tmp/recover", 1, 1);
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "goal-recover",
        iteration: 1,
        idempotencyKey: "goal-recover:1",
        artifactPath: "/tmp/recover/iterations/1",
        now: 100
      });
      const lock = acquireRepoLock(db, {
        repoRoot: "/tmp/recover",
        holder: "previous-worker",
        goalId: "goal-recover",
        iteration: 1,
        jobId: enqueued.jobId,
        leaseExpiresAt: 1_000,
        now: 100
      });
      if (!lock.ok) throw new Error("acquire failed in test setup");
      db.prepare(
        "UPDATE jobs SET state = 'succeeded', updated_at = updated_at WHERE id = ?"
      ).run(enqueued.jobId);

      // Stale claimed job with no live owner: also re-pendable.
      const enqueued2 = enqueueGoalIterationJob(db, {
        goalId: "goal-recover",
        iteration: 2,
        idempotencyKey: "goal-recover:2",
        artifactPath: "/tmp/recover/iterations/2",
        now: 200
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "previous-worker",
        leaseDurationMs: 900,
        now: 200
      });
      if (!claimed.ok) throw new Error("claim failed in test setup");

      const runId = seedDaemonRun(db);
      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-recovery",
        pollIntervalMs: 1,
        maxLoopIterations: 1,
        startupRecoveryGraceMs: 0,
        now: makeMonotonicNow(1_000_000, 1),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-recovery",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.startupRecovery).not.toBeNull();
      const recovery = result.startupRecovery!;
      expect(recovery.graceMs).toBe(0);
      expect(recovery.repoLocks.recovered).toHaveLength(1);
      expect(recovery.repoLocks.recovered[0]!.lock.id).toBe(lock.lockId);
      expect(recovery.repoLocks.recovered[0]!.recoveryStatus).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS
      );
      expect(recovery.claimedJobs.recovered).toHaveLength(1);
      expect(recovery.claimedJobs.recovered[0]!.jobBefore.id).toBe(
        enqueued2.jobId
      );
      expect(recovery.claimedJobs.recovered[0]!.recoveryStatus).toBe(
        JOB_RECOVERED_AUTO_REPENDED_STATUS
      );
      // The loop's own daemon run is skipped via excludeRunId so the startup
      // pass does not finalize the row that just registered itself.
      expect(recovery.daemonRuns.recovered).toEqual([]);
      expect(
        recovery.daemonRuns.skipped.some(
          (entry) => entry.run.id === runId && entry.reason === "self"
        )
      ).toBe(true);

      // Side effects landed: lock released, claimed job re-pended.
      expect(getRepoLock(db, lock.lockId)?.state).toBe("released");
      expect(getQueueJob(db, enqueued2.jobId)?.state).toBe("pending");

      // Recovery events were emitted.
      const events = db
        .prepare(
          "SELECT type FROM events WHERE type IN ('repo_lock.recovered', 'job.recovered') ORDER BY id"
        )
        .all() as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toEqual([
        "repo_lock.recovered",
        "job.recovered"
      ]);
    } finally {
      db.close();
    }
  });

  it("returns startupRecovery: null when the pre-loop recovery pass is skipped", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-skip-recovery",
        pollIntervalMs: 1,
        maxIdleCycles: 1,
        skipStartupRecovery: true,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-skip-recovery",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.startupRecovery).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reports an empty startupRecovery payload when nothing is stale", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-empty-recovery",
        pollIntervalMs: 1,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-empty-recovery",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.startupRecovery).not.toBeNull();
      expect(result.startupRecovery!.repoLocks.recovered).toEqual([]);
      expect(result.startupRecovery!.repoLocks.skipped).toEqual([]);
      expect(result.startupRecovery!.claimedJobs.recovered).toEqual([]);
      expect(result.startupRecovery!.claimedJobs.skipped).toEqual([]);
      // The loop's own daemon run is excluded from recovery via excludeRunId.
      expect(result.startupRecovery!.daemonRuns.recovered).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips the caller's own daemon run during startup recovery", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      // seedDaemonRun stamps the daemon at now: 100_000, but the loop's first
      // observed `now` (via makeMonotonicNow's default start) is 1.7e12. The
      // heartbeat age therefore far exceeds any default stale cutoff, so the
      // run would be classified stale and auto-finalized without excludeRunId.
      const runId = seedDaemonRun(db);
      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-self-exclude",
        pollIntervalMs: 1,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-self-exclude",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.startupRecovery).not.toBeNull();
      const recovery = result.startupRecovery!;
      expect(recovery.daemonRuns.recovered).toEqual([]);
      expect(recovery.daemonRuns.skipped).toHaveLength(1);
      expect(recovery.daemonRuns.skipped[0]!.run.id).toBe(runId);
      expect(recovery.daemonRuns.skipped[0]!.reason).toBe("self");

      // Loop exited cleanly via maxIdleCycles, not via run_terminated — i.e.
      // the daemon was not auto-finalized out from under itself.
      expect(result.exitReason).toBe("max_idle_cycles");
      expect(result.terminalState).toBe("stopped");
    } finally {
      db.close();
    }
  });

});

const WF_NOW = 1_700_000_000_000;

function seedWorkflowRun(
  db: MomentumDb,
  input: { runId: string; state?: string; repoPath?: string | null; createdAt?: number }
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, repo_path, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, 'workflow-run-start', '{}', ?, '{}', '{}', 0, ?, ?)`
  ).run(
    input.runId,
    input.state ?? "approved",
    input.repoPath ?? null,
    input.createdAt ?? WF_NOW,
    input.createdAt ?? WF_NOW
  );
}

function seedWorkflowStep(
  db: MomentumDb,
  input: { runId: string; stepId: string; kind: string; state: string; order: number }
): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(input.runId, input.stepId, input.kind, input.state, input.order, WF_NOW, WF_NOW);
}

/**
 * Seed a workflow run whose first step is `approved` and ready to dispatch (no
 * leases, predecessors clear), so the scheduler lane scans it as runnable.
 */
function seedRunnableWorkflow(db: MomentumDb, runId = "wf-run-a"): string {
  seedWorkflowRun(db, { runId, state: "approved", repoPath: `/repos/${runId}` });
  seedWorkflowStep(db, {
    runId,
    stepId: "preflight",
    kind: "preflight",
    state: "approved",
    order: 0
  });
  seedWorkflowStep(db, {
    runId,
    stepId: "implementation",
    kind: "implementation",
    state: "pending",
    order: 1
  });
  return runId;
}

type WorkflowDispatchRecorder = {
  dispatch: WorkflowStepDispatch;
  calls: Array<{ claim: ClaimedWorkflowStep; context: WorkflowStepDispatchContext }>;
};

function recordingWorkflowDispatch(
  result: WorkflowStepDispatchResult = { status: "dispatched" }
): WorkflowDispatchRecorder {
  const calls: WorkflowDispatchRecorder["calls"] = [];
  const dispatch: WorkflowStepDispatch = (claim, context) => {
    calls.push({ claim, context });
    return result;
  };
  return { dispatch, calls };
}

function mockRanJob(workerId: string, dataDir: string): WorkerRunResult {
  return {
    code: "ran_job",
    ok: true,
    workerId,
    dataDir,
    outcome: "ran_job",
    goalId: "goal-x",
    jobId: "job-x",
    lockId: "lock-x",
    goalState: "completed",
    jobState: "succeeded",
    iteration: 1,
    repoRoot: "/repo/x",
    leaseExpiresAt: 0,
    heartbeatAt: 0,
    jobIterationResult: { ok: true } as never,
    reducer: null,
    reducerError: null,
    message: "mocked ran_job"
  } as WorkerRunResult;
}

describe("runDaemonLoop workflow scheduler lane (NGX-348)", () => {
  it("leaves the workflow lane inert when no workflowLane config is supplied", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-inert",
        pollIntervalMs: 0,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-inert",
          dataDir,
          outcome: "idle",
          message: "no work"
        })
      });

      expect(result.workflowStepsDispatched).toBe(0);
      expect(result.lastWorkflowCode).toBeNull();
      // The runnable workflow run was never claimed: no dispatch lease exists.
      expect(
        getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND)
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("dispatches a runnable workflow step and leaves its dispatch lease held", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch();
      const observedCycles: Array<RunWorkflowSchedulerOnceResult | undefined> = [];

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-dispatch",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        onCycleComplete: (cycle) => observedCycles.push(cycle.workflowResult),
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-dispatch",
          dataDir,
          outcome: "idle",
          message: "no work"
        }),
        workflowLane: { dispatch: recorder.dispatch }
      });

      expect(result.workflowStepsDispatched).toBe(1);
      expect(result.lastWorkflowCode).toBe("dispatched");

      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim.runId).toBe(wfRunId);
      expect(recorder.calls[0]?.claim.stepId).toBe("preflight");
      expect(recorder.calls[0]?.context.workerId).toBe("daemon-loop-wf-dispatch");

      // The dispatch lease is durable and left held for the executor to own.
      const lease = getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.holder).toBe("daemon-loop-wf-dispatch");
      expect(lease?.releasedAt).toBeNull();

      // The scheduler tick result is surfaced to onCycleComplete observers.
      expect(observedCycles).toHaveLength(1);
      expect(observedCycles[0]?.code).toBe("dispatched");
    } finally {
      db.close();
    }
  });

  it("keeps draining goal iterations while the workflow lane dispatches", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch();
      let goalCycles = 0;

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-coexist",
        pollIntervalMs: 0,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: (input): WorkerRunResult => {
          goalCycles += 1;
          if (goalCycles === 1) {
            return mockRanJob(input.workerId, dataDir);
          }
          return {
            code: "no_work",
            workerId: input.workerId,
            dataDir,
            outcome: "idle",
            message: "no work"
          };
        },
        workflowLane: { dispatch: recorder.dispatch }
      });

      // Both lanes advanced: the goal job drained AND a workflow step dispatched.
      expect(result.jobsRun).toBe(1);
      expect(result.workflowStepsDispatched).toBe(1);
      expect(recorder.calls).toHaveLength(1);
      expect(result.exitReason).toBe("max_idle_cycles");
    } finally {
      db.close();
    }
  });

  it("treats a workflow dispatch as an active, non-idle cycle", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch();
      const { calls: sleepCalls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-active",
        pollIntervalMs: 7,
        maxIdleCycles: 2,
        now: makeMonotonicNow(),
        sleep,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-active",
          dataDir,
          outcome: "idle",
          message: "no work"
        }),
        workflowLane: { dispatch: recorder.dispatch }
      });

      // Cycle 0 dispatched (active: no idle, no sleep); only the two later
      // workflow-idle cycles counted as idle and slept.
      expect(result.workflowStepsDispatched).toBe(1);
      expect(result.iterations).toBe(3);
      expect(result.idleCycles).toBe(2);
      expect(sleepCalls).toEqual([7, 7]);
    } finally {
      db.close();
    }
  });

  it("refreshes the daemon heartbeat as it hands a claimed step to the dispatcher", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      seedRunnableWorkflow(db);
      let observed: { heartbeatAt: number | null | undefined; ctxNow: number } | null =
        null;
      const dispatch: WorkflowStepDispatch = (_claim, context) => {
        observed = {
          heartbeatAt: getDaemonRun(db, runId)?.heartbeat_at,
          ctxNow: context.now
        };
        return { status: "dispatched" };
      };

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-heartbeat",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-heartbeat",
          dataDir,
          outcome: "idle",
          message: "no work"
        }),
        workflowLane: { dispatch }
      });

      expect(observed).not.toBeNull();
      // The daemon heartbeated to the tick clock right before dispatch ran, so
      // the row the dispatcher observes is freshly stamped (not the older
      // cycle-start heartbeat).
      expect(observed!.heartbeatAt).toBe(observed!.ctxNow);
    } finally {
      db.close();
    }
  });

  it("does not dispatch workflow work after a stop request during goal work", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch();
      const { calls, sleep } = makeRecordingSleep();
      const observedCycles: Array<RunWorkflowSchedulerOnceResult | undefined> = [];

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-stop-after-goal",
        pollIntervalMs: 7,
        maxIdleCycles: 10,
        now: makeMonotonicNow(),
        sleep,
        onCycleComplete: (cycle) => observedCycles.push(cycle.workflowResult),
        runWorker: () => {
          requestDaemonRunStop(db, {
            runId,
            reason: "operator stop",
            now: 200_000
          });
          return {
            code: "no_work",
            workerId: "daemon-loop-wf-stop-after-goal",
            dataDir,
            outcome: "idle",
            message: "no work"
          };
        },
        workflowLane: { dispatch: recorder.dispatch }
      });

      expect(result.exitReason).toBe("stop_requested");
      expect(result.workflowStepsDispatched).toBe(0);
      expect(result.lastWorkflowCode).toBeNull();
      expect(result.idleCycles).toBe(0);
      expect(recorder.calls).toHaveLength(0);
      expect(calls).toEqual([]);
      expect(observedCycles).toEqual([undefined]);
      expect(
        getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND)
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("marks the daemon run errored and releases the lease when the dispatcher throws", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      const dispatch: WorkflowStepDispatch = () => {
        throw new Error("dispatcher boom");
      };

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-throw",
        pollIntervalMs: 0,
        maxLoopIterations: 3,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-throw",
          dataDir,
          outcome: "idle",
          message: "no work"
        }),
        workflowLane: { dispatch }
      });

      expect(result.exitReason).toBe("internal_error");
      expect(result.terminalState).toBe("error");
      expect(result.error).toBe("dispatcher boom");
      expect(getDaemonRun(db, runId)?.state).toBe("error");

      // The dispatch lease the tick acquired was released, not stranded.
      const lease = getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.releasedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("forwards the configured dispatch-lease duration and stale policy to the tick", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch();
      const fixedNow = WF_NOW;

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-config",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: () => fixedNow,
        sleep: async () => undefined,
        runWorker: () => ({
          code: "no_work",
          workerId: "daemon-loop-wf-config",
          dataDir,
          outcome: "idle",
          message: "no work"
        }),
        workflowLane: {
          dispatch: recorder.dispatch,
          leaseDurationMs: 12_345,
          stalePolicy: "manual-recovery-required"
        }
      });

      const lease = getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.expiresAt).toBe(fixedNow + 12_345);
      expect(lease?.stalePolicy).toBe("manual-recovery-required");
    } finally {
      db.close();
    }
  });
});
