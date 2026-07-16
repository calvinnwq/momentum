import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  finishDaemonRun,
  getDaemonRun,
  requestDaemonRunImmediateStop,
  requestDaemonRunStop,
  startDaemonRun,
} from "../src/core/daemon/runs.js";
import {
  runDaemonLoop,
  type DaemonLoopCycle,
  type DaemonLoopInput,
} from "../src/core/daemon/loop.js";
import { acquireRepoLock, getRepoLock } from "../src/core/repo/locks.js";
import {
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob,
} from "../src/core/daemon/queue-jobs.js";
import {
  JOB_RECOVERED_AUTO_REPENDED_STATUS,
  REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
} from "../src/core/daemon/stale-recovery.js";
import {
  WORKFLOW_DISPATCH_LEASE_KIND,
  type AsyncWorkflowStepDispatch,
  type ClaimedWorkflowStep,
  type RunWorkflowSchedulerOnceResult,
  type WorkflowStepDispatch,
  type WorkflowStepDispatchContext,
  type WorkflowStepDispatchResult,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { WORKFLOW_DISPATCH_RESULT_STATUS } from "../src/core/workflow/dispatch/execute.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-daemon-loop-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedDaemonRun(db: MomentumDb): string {
  const { runId } = startDaemonRun(db, {
    pid: 1234,
    host: "daemon-loop-test",
    now: 100_000,
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
    },
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
      });

      expect(result.exitReason).toBe("max_idle_cycles");
      expect(result.terminalState).toBe("stopped");
      expect(result.workSucceeded).toBe(true);
      expect(result.idleCycles).toBe(3);
      expect(result.iterations).toBe(3);
      expect(result.jobsRun).toBe(0);
      expect(result.jobsFailed).toBe(0);
      expect(result.lastWorkerCode).toBe("no_work");
      expect(calls).toEqual([25, 25, 25]);

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
      expect(row?.reconcile_count).toBe(3);
      expect(row?.active_job_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("pins the retired goal-drain envelope fields to their idle values", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const idleRunId = seedDaemonRun(db);
      const idleResult = await runDaemonLoop({
        db,
        dataDir,
        runId: idleRunId,
        workerId: "daemon-loop-envelope-idle",
        pollIntervalMs: 0,
        maxIdleCycles: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
      });

      expect(idleResult.exitReason).toBe("max_idle_cycles");
      expect(idleResult.jobsRun).toBe(0);
      expect(idleResult.jobsFailed).toBe(0);
      expect(idleResult.jobsNotExecuted).toBe(0);
      expect(idleResult.workSucceeded).toBe(true);
      expect(idleResult.lastWorkerCode).toBe("no_work");
      expect(idleResult.iterations).toBe(1);
      expect(idleResult.idleCycles).toBe(1);

      // A zero-cycle run never stamps the retired lane's per-cycle code.
      const zeroRunId = seedDaemonRun(db);
      const zeroResult = await runDaemonLoop({
        db,
        dataDir,
        runId: zeroRunId,
        workerId: "daemon-loop-envelope-zero",
        pollIntervalMs: 0,
        maxIdleCycles: 0,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
      });

      expect(zeroResult.exitReason).toBe("max_idle_cycles");
      expect(zeroResult.iterations).toBe(0);
      expect(zeroResult.lastWorkerCode).toBeNull();
      expect(zeroResult.jobsRun).toBe(0);
      expect(zeroResult.jobsFailed).toBe(0);
      expect(zeroResult.jobsNotExecuted).toBe(0);
      expect(zeroResult.workSucceeded).toBe(true);
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
        now: 100_500,
      });
      const { calls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop",
        sleep,
        now: makeMonotonicNow(),
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
        onCycleComplete: (cycle) => {
          if (cycle.cycleIndex === 0) {
            requestDaemonRunStop(db, {
              runId,
              reason: "operator stop",
              now: 200_000,
            });
          }
        },
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
        now: 100_500,
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-now-idle",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
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
        now: 100_500,
      });
      finishDaemonRun(db, {
        runId,
        terminalState: "canceled",
        cancelOutcome: "idle",
        now: 100_750,
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal-canceled",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
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

  it("treats stop_now as canceled even when a graceful stop was previously requested", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      requestDaemonRunStop(db, {
        runId,
        reason: "graceful",
        now: 100_100,
      });
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "now-upgrade",
        now: 100_500,
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-stop-now-upgrade",
        sleep: makeRecordingSleep().sleep,
        now: makeMonotonicNow(),
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
        now: 100_500,
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal",
        pollIntervalMs: 0,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
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
        error: "previous daemon failure",
      });

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-terminal-error",
        pollIntervalMs: 0,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
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

  it("invokes onCycleComplete with the cycle payload for each cycle", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const cycles: DaemonLoopCycle[] = [];

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-observer",
        pollIntervalMs: 0,
        maxIdleCycles: 2,
        skipStartupRecovery: true,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        onCycleComplete: (cycle) => {
          cycles.push(cycle);
        },
      });

      expect(cycles).toEqual([
        {
          cycleIndex: 0,
          observedState: "running",
          startedAt: 1_700_000_000_000,
        },
        {
          cycleIndex: 1,
          observedState: "running",
          startedAt: 1_700_000_001_000,
        },
      ]);
      // Without a workflowLane config the tick never runs, so the payload
      // carries no workflowResult key at all.
      expect(cycles.every((cycle) => !("workflowResult" in cycle))).toBe(true);

      // With the lane on, every cycle payload surfaces the tick result even
      // when the tick found nothing runnable.
      const laneRunId = seedDaemonRun(db);
      const laneCycles: DaemonLoopCycle[] = [];
      await runDaemonLoop({
        db,
        dataDir,
        runId: laneRunId,
        workerId: "daemon-loop-observer-lane",
        pollIntervalMs: 0,
        maxIdleCycles: 1,
        skipStartupRecovery: true,
        sleep: async () => undefined,
        now: makeMonotonicNow(),
        onCycleComplete: (cycle) => {
          laneCycles.push(cycle);
        },
        workflowLane: { dispatch: async () => ({ status: "dispatched" }) },
      });

      expect(laneCycles).toHaveLength(1);
      expect(laneCycles[0]?.workflowResult).toBeDefined();
      expect(laneCycles[0]?.workflowResult?.code).toBe("idle");
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
        now: makeMonotonicNow(),
      };
      await expect(runDaemonLoop(input)).rejects.toThrow(/pollIntervalMs/);
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
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "goal-recover",
        "recover",
        "momentum/recover",
        "/tmp/recover",
        1,
        1,
      );
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "goal-recover",
        iteration: 1,
        idempotencyKey: "goal-recover:1",
        artifactPath: "/tmp/recover/iterations/1",
        now: 100,
      });
      const lock = acquireRepoLock(db, {
        repoRoot: "/tmp/recover",
        holder: "previous-worker",
        goalId: "goal-recover",
        iteration: 1,
        jobId: enqueued.jobId,
        leaseExpiresAt: 1_000,
        now: 100,
      });
      if (!lock.ok) throw new Error("acquire failed in test setup");
      db.prepare(
        "UPDATE jobs SET state = 'succeeded', updated_at = updated_at WHERE id = ?",
      ).run(enqueued.jobId);

      // Stale claimed job with no live owner: also re-pendable.
      const enqueued2 = enqueueGoalIterationJob(db, {
        goalId: "goal-recover",
        iteration: 2,
        idempotencyKey: "goal-recover:2",
        artifactPath: "/tmp/recover/iterations/2",
        now: 200,
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "previous-worker",
        leaseDurationMs: 900,
        now: 200,
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
      });

      expect(result.startupRecovery).not.toBeNull();
      const recovery = result.startupRecovery!;
      expect(recovery.graceMs).toBe(0);
      expect(recovery.repoLocks.recovered).toHaveLength(1);
      expect(recovery.repoLocks.recovered[0]!.lock.id).toBe(lock.lockId);
      expect(recovery.repoLocks.recovered[0]!.recoveryStatus).toBe(
        REPO_LOCK_AUTO_RELEASED_TERMINAL_JOB_STATUS,
      );
      expect(recovery.claimedJobs.recovered).toHaveLength(1);
      expect(recovery.claimedJobs.recovered[0]!.jobBefore.id).toBe(
        enqueued2.jobId,
      );
      expect(recovery.claimedJobs.recovered[0]!.recoveryStatus).toBe(
        JOB_RECOVERED_AUTO_REPENDED_STATUS,
      );
      // The loop's own daemon run is skipped via excludeRunId so the startup
      // pass does not finalize the row that just registered itself.
      expect(recovery.daemonRuns.recovered).toEqual([]);
      expect(
        recovery.daemonRuns.skipped.some(
          (entry) => entry.run.id === runId && entry.reason === "self",
        ),
      ).toBe(true);

      // Side effects landed: lock released, claimed job re-pended.
      expect(getRepoLock(db, lock.lockId)?.state).toBe("released");
      expect(getQueueJob(db, enqueued2.jobId)?.state).toBe("pending");

      // Recovery events were emitted.
      const events = db
        .prepare(
          "SELECT type FROM events WHERE type IN ('repo_lock.recovered', 'job.recovered') ORDER BY id",
        )
        .all() as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toEqual([
        "repo_lock.recovered",
        "job.recovered",
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
  input: {
    runId: string;
    state?: string;
    repoPath?: string | null;
    createdAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, repo_path, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, 'workflow-run-start', '{}', ?, '{}', '{}', 0, ?, ?)`,
  ).run(
    input.runId,
    input.state ?? "approved",
    input.repoPath ?? null,
    input.createdAt ?? WF_NOW,
    input.createdAt ?? WF_NOW,
  );
}

function seedWorkflowStep(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    kind: string;
    state: string;
    order: number;
  },
): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    WF_NOW,
    WF_NOW,
  );
}

/**
 * Seed a workflow run whose first step is `approved` and ready to dispatch (no
 * leases, predecessors clear), so the scheduler lane scans it as runnable.
 */
function seedRunnableWorkflow(db: MomentumDb, runId = "wf-run-a"): string {
  seedWorkflowRun(db, {
    runId,
    state: "approved",
    repoPath: `/repos/${runId}`,
  });
  seedWorkflowStep(db, {
    runId,
    stepId: "preflight",
    kind: "preflight",
    state: "approved",
    order: 0,
  });
  seedWorkflowStep(db, {
    runId,
    stepId: "implementation",
    kind: "implementation",
    state: "pending",
    order: 1,
  });
  return runId;
}

type WorkflowDispatchRecorder = {
  dispatch: WorkflowStepDispatch | AsyncWorkflowStepDispatch;
  calls: Array<{
    claim: ClaimedWorkflowStep;
    context: WorkflowStepDispatchContext;
  }>;
};

function recordingWorkflowDispatch(
  result: WorkflowStepDispatchResult = { status: "dispatched" },
): WorkflowDispatchRecorder {
  const calls: WorkflowDispatchRecorder["calls"] = [];
  const dispatch: WorkflowStepDispatch = (claim, context) => {
    calls.push({ claim, context });
    return result;
  };
  return { dispatch, calls };
}

function asyncRecordingWorkflowDispatch(
  result: WorkflowStepDispatchResult = { status: "dispatched" },
): WorkflowDispatchRecorder {
  const calls: WorkflowDispatchRecorder["calls"] = [];
  const dispatch: AsyncWorkflowStepDispatch = async (claim, context) => {
    calls.push({ claim, context });
    await Promise.resolve();
    return result;
  };
  return { dispatch, calls };
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
      });

      expect(result.workflowStepsDispatched).toBe(0);
      expect(result.lastWorkflowCode).toBeNull();
      // The runnable workflow run was never claimed: no dispatch lease exists.
      expect(
        getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND),
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
      const observedCycles: Array<RunWorkflowSchedulerOnceResult | undefined> =
        [];

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
        workflowLane: { dispatch: recorder.dispatch },
      });

      expect(result.workflowStepsDispatched).toBe(1);
      expect(result.lastWorkflowCode).toBe("dispatched");

      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim.runId).toBe(wfRunId);
      expect(recorder.calls[0]?.claim.stepId).toBe("preflight");
      expect(recorder.calls[0]?.context.workerId).toBe(
        "daemon-loop-wf-dispatch",
      );

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

  it("awaits an async workflow dispatch before reporting the cycle", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      const recorder = asyncRecordingWorkflowDispatch({
        status: "async-dispatched",
      });
      const observedCycles: Array<RunWorkflowSchedulerOnceResult | undefined> =
        [];

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-async-dispatch",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        onCycleComplete: (cycle) => observedCycles.push(cycle.workflowResult),
        workflowLane: { dispatch: recorder.dispatch },
      });

      expect(result.workflowStepsDispatched).toBe(1);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim.runId).toBe(wfRunId);
      expect(observedCycles[0]?.code).toBe("dispatched");
      if (observedCycles[0]?.code === "dispatched") {
        expect(observedCycles[0].dispatch.status).toBe("async-dispatched");
      }
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
        workflowLane: { dispatch: recorder.dispatch },
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

  it("observes the poll interval after a continuation-only dispatch", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      seedRunnableWorkflow(db);
      const recorder = recordingWorkflowDispatch({
        status: WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
      });
      const { calls: sleepCalls, sleep } = makeRecordingSleep();

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-continuation",
        pollIntervalMs: 7,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep,
        workflowLane: { dispatch: recorder.dispatch },
      });

      expect(result.workflowStepsDispatched).toBe(1);
      expect(result.idleCycles).toBe(0);
      expect(sleepCalls).toEqual([7]);
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
      let observed: {
        heartbeatAt: number | null | undefined;
        ctxNow: number;
      } | null = null;
      const dispatch: WorkflowStepDispatch = (_claim, context) => {
        observed = {
          heartbeatAt: getDaemonRun(db, runId)?.heartbeat_at,
          ctxNow: context.now,
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
        workflowLane: { dispatch },
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

  it("refreshes the daemon heartbeat after a long async dispatch settles", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      seedRunnableWorkflow(db);
      let dispatchStartedAt = 0;
      let settledHeartbeatAt = 0;
      const dispatch: AsyncWorkflowStepDispatch = async (_claim, context) => {
        dispatchStartedAt = context.now;
        await Promise.resolve();
        return { status: "dispatched" };
      };

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-settled-heartbeat",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(1_700_000_000_000, 60_000),
        sleep: async () => undefined,
        workflowLane: { dispatch, leaseDurationMs: 1_000_000 },
        onCycleComplete: () => {
          settledHeartbeatAt = getDaemonRun(db, runId)?.heartbeat_at ?? 0;
        },
      });

      expect(settledHeartbeatAt).toBeGreaterThan(dispatchStartedAt);
    } finally {
      db.close();
    }
  });

  it("marks workflow dispatch as the active daemon job while the dispatcher runs", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const wfRunId = seedRunnableWorkflow(db);
      let observed: { activeJobId: string | null | undefined } | null = null;
      const dispatch: WorkflowStepDispatch = () => {
        observed = {
          activeJobId: getDaemonRun(db, runId)?.active_job_id,
        };
        return { status: "dispatched" };
      };

      await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-active-job",
        pollIntervalMs: 0,
        maxLoopIterations: 1,
        now: makeMonotonicNow(),
        sleep: async () => undefined,
        workflowLane: { dispatch },
      });

      expect(observed).toEqual({
        activeJobId: `workflow:${wfRunId}:preflight`,
      });
      expect(getDaemonRun(db, runId)?.active_job_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not run the workflow tick on a cycle that observes a stop request", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = seedDaemonRun(db);
      const recorder = recordingWorkflowDispatch();
      const { calls, sleep } = makeRecordingSleep();
      let wfRunId: string | null = null;

      const result = await runDaemonLoop({
        db,
        dataDir,
        runId,
        workerId: "daemon-loop-wf-stop-pre-tick",
        pollIntervalMs: 7,
        maxIdleCycles: 10,
        now: makeMonotonicNow(),
        sleep,
        onCycleComplete: (cycle) => {
          if (cycle.cycleIndex === 0) {
            // Make workflow work runnable only after the stop lands: the next
            // cycle's pre-cycle state check must exit before the tick runs.
            wfRunId = seedRunnableWorkflow(db);
            requestDaemonRunStop(db, {
              runId,
              reason: "operator stop",
              now: 200_000,
            });
          }
        },
        workflowLane: { dispatch: recorder.dispatch },
      });

      expect(result.exitReason).toBe("stop_requested");
      expect(result.iterations).toBe(1);
      expect(result.idleCycles).toBe(1);
      // Cycle 0's tick ran (and idled); the stop-observing cycle never ticked.
      expect(result.lastWorkflowCode).toBe("idle");
      expect(result.workflowStepsDispatched).toBe(0);
      expect(recorder.calls).toHaveLength(0);
      expect(calls).toEqual([7]);
      expect(wfRunId).not.toBeNull();
      expect(
        getWorkflowLease(db, wfRunId!, WORKFLOW_DISPATCH_LEASE_KIND),
      ).toBeUndefined();

      const row = getDaemonRun(db, runId);
      expect(row?.state).toBe("stopped");
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
        workflowLane: { dispatch },
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
        workflowLane: {
          dispatch: recorder.dispatch,
          leaseDurationMs: 12_345,
          stalePolicy: "manual-recovery-required",
        },
      });

      const lease = getWorkflowLease(db, wfRunId, WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.expiresAt).toBe(fixedNow + 12_345);
      expect(lease?.stalePolicy).toBe("manual-recovery-required");
    } finally {
      db.close();
    }
  });
});
