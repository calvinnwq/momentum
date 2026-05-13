import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  requestDaemonRunStop,
  startDaemonRun
} from "../src/daemon-runs.js";
import {
  runDaemonLoop,
  type DaemonLoopInput,
  type DaemonLoopResult
} from "../src/daemon-loop.js";
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
      expect(result.error).toBe("worker boom");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("worker boom");
      expect(row?.error_at).not.toBeNull();
    } finally {
      db.close();
    }
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
      expect(result.terminalState).toBe("stopped");
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
      expect(result.terminalState).toBe("error");
      expect(result.lastObservedState).toBe("error");

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("error");
      expect(row?.error).toBe("previous daemon failure");
    } finally {
      db.close();
    }
  });

  it("updates active job/lock during work and clears them between jobs", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const states: Array<{
        phase: string;
        activeJobId: string | null;
        activeLockId: string | null;
      }> = [];

      const sampleState = (phase: string): void => {
        const row = getDaemonRun(db, runId);
        states.push({
          phase,
          activeJobId: row?.active_job_id ?? null,
          activeLockId: row?.active_lock_id ?? null
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
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        runWorker
      });

      sampleState("after");

      expect(result.exitReason).toBe("max_loop_iterations");
      expect(result.iterations).toBe(1);
      expect(result.jobsRun).toBe(1);
      expect(states).toEqual([
        { phase: "before", activeJobId: null, activeLockId: null },
        { phase: "during", activeJobId: "job-a", activeLockId: "lock-a" },
        { phase: "after", activeJobId: null, activeLockId: null }
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
      expect(result.iterations).toBe(2);
      expect(sleeps).toEqual([7, 7]);
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
});
