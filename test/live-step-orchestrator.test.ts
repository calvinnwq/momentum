import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { waitMs } from "./helpers/process-kill-harness.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  LIVE_STEP_DEFAULT_LEASE_KIND,
  runLiveWorkflowStep
} from "../src/live-step-orchestrator.js";
import {
  acquireWorkflowLease,
  getWorkflowLease
} from "../src/workflow-leases.js";
import { getWorkflowStep } from "../src/workflow-step-transitions.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorDispatchResult,
  WorkflowStepExecutorKind,
  WorkflowStepExecutorInput
} from "../src/workflow-step-executor.js";
import type {
  WorkflowApprovalBoundary,
  WorkflowLeaseKind,
  WorkflowStepState
} from "../src/workflow-run-reducer.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-live-step-orchestrator-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const SEED_AT = 1_730_000_000_000;

function seedRun(
  db: MomentumDb,
  id: string,
  state: "pending" | "approved" | "running" | "blocked" = "approved",
  repoPath: string | null = null,
  approvalBoundary: WorkflowApprovalBoundary | null = "implementation",
  goalId: string | null = "goal-1"
): void {
  if (goalId !== null) {
    db.prepare(
      `INSERT OR IGNORE INTO goals (
         id, title, repo, runner, branch, max_iterations, verification,
         verification_timeout_sec, state, artifact_dir, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      goalId,
      goalId,
      repoPath,
      "fake",
      "main",
      1,
      "[]",
      900,
      "initialized",
      `/tmp/${goalId}`,
      SEED_AT,
      SEED_AT
    );
  }
  db.prepare(
    `INSERT INTO workflow_runs (
       id, source, state, repo_path, goal_id, approval_boundary, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "agent-workflow",
    state,
    repoPath,
    goalId,
    approvalBoundary,
    SEED_AT,
    SEED_AT
  );
  if (approvalBoundary !== null) {
    seedApproval(db, id, approvalBoundary);
  }
}

function seedApproval(
  db: MomentumDb,
  runId: string,
  boundary: WorkflowApprovalBoundary = "implementation"
): void {
  db.prepare(
    `INSERT INTO workflow_approvals (
       run_id, boundary, actor, phrase, artifact_path, artifact_digest,
       recorded_at, discharged_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    boundary,
    "operator",
    "APPROVE",
    `workflow-run-approve://${runId}/${boundary}`,
    `sha256:${runId}:${boundary}`,
    SEED_AT,
    null,
    SEED_AT,
    SEED_AT
  );
}

function seedRepoLock(
  db: MomentumDb,
  repoRoot: string,
  holder = "worker-1",
  opts: { goalId?: string; leaseExpiresAt?: number } = {}
): void {
  db.prepare(
    `INSERT INTO repo_locks (
       id, repo_root, holder, goal_id, iteration, job_id, state,
       acquired_at, heartbeat_at, lease_expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `lock-${holder}`,
    repoRoot,
    holder,
    opts.goalId ?? "goal-1",
    1,
    "job-1",
    "active",
    SEED_AT,
    SEED_AT,
    opts.leaseExpiresAt ?? SEED_AT + 60_000,
    SEED_AT
  );
}

function seedStep(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: WorkflowStepState,
  kind: WorkflowStepExecutorKind = "implementation",
  order = 1
): void {
  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required,
       result_digest, error_code, error_message, started_at, finished_at,
       operator_transition_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    stepId,
    kind,
    state,
    order,
    1,
    null,
    null,
    null,
    null,
    null,
    null,
    SEED_AT,
    SEED_AT
  );
}

function seedLease(
  db: MomentumDb,
  runId: string,
  leaseKind: WorkflowLeaseKind,
  opts: { releasedAt?: number | null; expiresAt?: number } = {}
): void {
  db.prepare(
    `INSERT INTO workflow_leases (
       run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
       released_at, stale_policy, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    leaseKind,
    "other-holder",
    SEED_AT,
    opts.expiresAt ?? SEED_AT + 60_000,
    SEED_AT,
    opts.releasedAt ?? null,
    "manual-recovery-required",
    SEED_AT,
    SEED_AT
  );
}

function openSeededDb(
  runId = "run-1",
  state: "pending" | "approved" | "running" | "blocked" = "approved",
  repoPath: string | null = "/repo",
  approvalBoundary: WorkflowApprovalBoundary | null = "implementation",
  repoLockHolder: string | null = "worker-1"
): MomentumDb {
  const db = openDb(makeTempDir());
  seedRun(db, runId, state, repoPath, approvalBoundary);
  if (repoPath !== null && repoLockHolder !== null) {
    seedRepoLock(db, repoPath, repoLockHolder);
  }
  return db;
}

const EXEC_INPUT: WorkflowStepExecutorInput = {
  runId: "run-1",
  stepId: "step-impl",
  kind: "implementation",
  attempt: 1,
  repoPath: "/repo",
  runDir: "/run",
  resultJsonPath: "/run/result.json",
  executorLogPath: "/run/executor.log"
};

function fakeExecutor(
  result:
    | WorkflowStepExecutorDispatchResult
    | (() => WorkflowStepExecutorDispatchResult),
  kind: WorkflowStepExecutorKind = "implementation"
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (_input: WorkflowStepExecutorInput) => {
      if (typeof result === "function") return result();
      return result;
    }
  };
}

function successDispatch(
  resultDigest: string | null = null
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "succeeded",
      summary: "did the work",
      checkpoints: [],
      artifacts: [],
      resultDigest,
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: "/run/executor.log",
    resultJsonPath: "/run/result.json"
  };
}

// SQLITE_BUSY primary result code. The live heartbeat worker runs on its own
// thread with its own connection, so a main-thread read/transaction here can
// collide with the worker's in-flight write and throw `SQLITE_BUSY`. These DBs
// are opened without a `busy_timeout`, so the collision surfaces immediately
// rather than being retried inside SQLite. The probe/lock helpers below absorb
// that transient contention instead of letting it escape into an executor
// callback (where the orchestrator would trap it as `executor_threw`).
const SQLITE_BUSY = 5;

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: number }).errcode;
  if (typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY) {
    return true;
  }
  return /\bbusy\b|database is locked|database table is locked/i.test(
    error.message
  );
}

/**
 * Run a one-shot DB operation that must succeed, retrying only on transient
 * `SQLITE_BUSY` contention from the concurrent heartbeat worker until it
 * commits or the timeout elapses. Any non-busy error propagates immediately.
 */
function withBusyRetry<T>(op: () => T, timeoutMs = 5_000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return op();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      waitMs(5);
    }
  }
}

function waitForHeartbeatAfter(
  db: MomentumDb,
  runId: string,
  leaseKind: WorkflowLeaseKind,
  after: number,
  timeoutMs: number
): number | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const heartbeatAt = getWorkflowLease(db, runId, leaseKind)?.heartbeatAt;
      if (heartbeatAt !== undefined && heartbeatAt > after) {
        return heartbeatAt;
      }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      // Worker held the write lock during the probe; re-poll after a backoff.
    }
    waitMs(10);
  }
  return null;
}

function waitForRepoLockHeartbeatAfter(
  db: MomentumDb,
  repoRoot: string,
  after: number,
  timeoutMs: number
): number | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const row = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt
             FROM repo_locks
            WHERE repo_root = ? AND state = 'active'
            ORDER BY acquired_at DESC, id DESC
            LIMIT 1`
        )
        .get(repoRoot) as { heartbeatAt: number } | undefined;
      if (row !== undefined && row.heartbeatAt > after) {
        return row.heartbeatAt;
      }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      // Worker held the write lock during the probe; re-poll after a backoff.
    }
    waitMs(10);
  }
  return null;
}

describe("runLiveWorkflowStep", () => {
  it("acquires the managed-step lease, runs approved->running->succeeded, then releases the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(successDispatch("sha256:ok")),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_000
      });

      expect(out.ok).toBe(true);
      expect(out.stage).toBe("execute");
      expect(out.terminalState).toBe("succeeded");
      expect(out.lease.acquired).toBe(true);
      expect(out.lease.released).toBe(true);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("succeeded");
      expect(step?.startedAt).toBe(SEED_AT + 1_000);
      expect(step?.finishedAt).toBe(SEED_AT + 1_000);
      expect(step?.resultDigest).toBe("sha256:ok");
      // Live transitions never engage the M8 operator override gate.
      expect(step?.operatorTransitionAt).toBeNull();

      const lease = getWorkflowLease(db, "run-1", LIVE_STEP_DEFAULT_LEASE_KIND);
      expect(lease?.holder).toBe("worker-1");
      expect(lease?.releasedAt).toBe(SEED_AT + 1_000);
    } finally {
      db.close();
    }
  });

  it("acquires the managed-step lease with the fail-closed manual-recovery-required stale policy by default", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(successDispatch("sha256:ok")),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_000
      });

      expect(out.ok).toBe(true);
      expect(out.lease.acquired).toBe(true);

      // Fail-closed default: a live step whose process is lost strands the
      // managed-step lease into operator recovery rather than silently
      // auto-releasing, even though the generic lease default is "auto-release".
      // The released row keeps its stale_policy, so the acquisition policy is
      // still observable after a successful release.
      const lease = getWorkflowLease(db, "run-1", LIVE_STEP_DEFAULT_LEASE_KIND);
      expect(lease?.stalePolicy).toBe("manual-recovery-required");
    } finally {
      db.close();
    }
  });

  it("honors an explicit stalePolicy override when acquiring the managed-step lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        stalePolicy: "auto-release",
        executor: fakeExecutor(successDispatch("sha256:ok")),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_000
      });

      expect(out.ok).toBe(true);
      expect(out.lease.acquired).toBe(true);

      // An explicit caller-supplied stale policy is forwarded to the lease and
      // is not overwritten by the fail-closed default.
      const lease = getWorkflowLease(db, "run-1", LIVE_STEP_DEFAULT_LEASE_KIND);
      expect(lease?.stalePolicy).toBe("auto-release");
    } finally {
      db.close();
    }
  });

  it("heartbeats the managed-step lease while the executor is still active", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let heartbeatDuringExecute: number | null = null;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 200,
        executor: fakeExecutor(() => {
          // Capture a heartbeat the live worker writes while the executor is
          // still running. The shared probe tolerates transient SQLITE_BUSY
          // contention from the worker's own write lock instead of letting it
          // escape the executor as an `executor_threw` dispatch failure.
          heartbeatDuringExecute = waitForHeartbeatAfter(
            db,
            "run-1",
            "managed-step",
            SEED_AT,
            500
          );
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT
      });

      expect(out.ok).toBe(true);
      expect(heartbeatDuringExecute).not.toBeNull();
      expect(heartbeatDuringExecute).toBeGreaterThan(SEED_AT);
      expect(
        getWorkflowLease(db, "run-1", "managed-step")?.releasedAt
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("continues heartbeating after a transient SQLite busy error", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let heartbeatBeforeBusy: number | null = null;
      let heartbeatAfterBusy: number | null = null;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 2_000,
        executor: fakeExecutor(() => {
          heartbeatBeforeBusy = waitForHeartbeatAfter(
            db,
            "run-1",
            "managed-step",
            SEED_AT,
            3_000
          );
          expect(heartbeatBeforeBusy).not.toBeNull();

          // Hold an exclusive transaction so the worker's next beat hits a busy
          // error and must recover. Acquiring it can itself momentarily lose the
          // race to the worker's in-flight write, so retry past that transient
          // contention rather than letting the simulation's own setup flake.
          withBusyRetry(() => db.exec("BEGIN EXCLUSIVE"));
          try {
            waitMs(80);
          } finally {
            db.exec("COMMIT");
          }

          heartbeatAfterBusy = waitForHeartbeatAfter(
            db,
            "run-1",
            "managed-step",
            heartbeatBeforeBusy ?? SEED_AT,
            5_000
          );
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT
      });

      expect(out.ok).toBe(true);
      expect(heartbeatAfterBusy).not.toBeNull();
      expect(heartbeatAfterBusy).toBeGreaterThan(heartbeatBeforeBusy ?? 0);
    } finally {
      db.close();
    }
  });

  it("refuses mismatched executor input identity before acquiring the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: { ...EXEC_INPUT, stepId: "other-step" },
        now: SEED_AT + 1_500
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a mismatched executor input kind before acquiring the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: { ...EXEC_INPUT, kind: "postflight" },
        now: SEED_AT + 1_600
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("executorInput.kind");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a mismatched executor kind before acquiring the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }, "postflight"),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_650
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("executor.kind");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a durable step kind mismatch before acquiring the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved", "postflight");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_700
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("workflow_steps.kind");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a running target step before mutating leases or repo locks", () => {
    const db = openSeededDb("run-1", "running");
    try {
      seedStep(db, "run-1", "step-impl", "running");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_710
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("state running");
      expect(out.inputError).toContain("expected approved");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "running"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();

      const row = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt
             FROM repo_locks
            WHERE repo_root = ? AND state = 'active'`
        )
        .get("/repo") as { heartbeatAt: number; leaseExpiresAt: number };
      expect(row.heartbeatAt).toBe(SEED_AT);
      expect(row.leaseExpiresAt).toBe(SEED_AT + 60_000);
    } finally {
      db.close();
    }
  });

  it("refuses a pending target step before mutating leases or repo locks", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "pending");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_715
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("state pending");
      expect(out.inputError).toContain("expected approved");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "pending"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();

      const row = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt
             FROM repo_locks
            WHERE repo_root = ? AND state = 'active'`
        )
        .get("/repo") as { heartbeatAt: number; leaseExpiresAt: number };
      expect(row.heartbeatAt).toBe(SEED_AT);
      expect(row.leaseExpiresAt).toBe(SEED_AT + 60_000);
    } finally {
      db.close();
    }
  });

  it("refuses a mismatched executor repo path before acquiring the lease", () => {
    const db = openSeededDb("run-1", "approved", "/repo-a");
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: { ...EXEC_INPUT, repoPath: "/repo-b" },
        now: SEED_AT + 1_720
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("executorInput.repoPath");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a repo-less workflow run before acquiring the lease", () => {
    const db = openSeededDb("run-1", "approved", null);
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_725
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("workflow_runs.repo_path");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution when approval coverage for the durable step kind is missing", () => {
    const db = openSeededDb("run-1", "approved", "/repo", null);
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_730
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("approval");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution for a repo-backed run without an active repo lock", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_740
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("repo lock");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution when the active repo lock is owned by another holder", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-2");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_745
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("repo lock");
      expect(out.inputError).toContain("worker-2");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to start a later approved step before required predecessors complete", () => {
    const db = openSeededDb("run-1", "approved");
    try {
      seedStep(db, "run-1", "step-preflight", "approved", "preflight", 1);
      seedStep(db, "run-1", "step-impl", "approved", "implementation", 2);

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_755
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("predecessor");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-preflight")?.state).toBe(
        "approved"
      );
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("runs a repo-backed step when the caller owns the active repo lock", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-1");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(successDispatch("sha256:ok")),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_748
      });

      expect(out.ok).toBe(true);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "succeeded"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 1_748
      );
    } finally {
      db.close();
    }
  });

  it("refuses a repo-backed run without a durable goal id", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, "run-1", "approved", "/repo", "implementation", null);
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-1");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_749
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("workflow_runs.goal_id");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("heartbeats the repo lock while the executor is still active", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-1", {
        leaseExpiresAt: SEED_AT + 2_750
      });

      let repoHeartbeatDuringExecute: number | null = null;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 2_750,
        executor: fakeExecutor(() => {
          repoHeartbeatDuringExecute = waitForRepoLockHeartbeatAfter(
            db,
            "/repo",
            SEED_AT + 1_750,
            3_000
          );
          expect(repoHeartbeatDuringExecute).not.toBeNull();
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_750
      });

      const repoLock = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt
             FROM repo_locks
            WHERE repo_root = ?`
        )
        .get("/repo") as
        | { heartbeatAt: number; leaseExpiresAt: number }
        | undefined;
      expect(out.ok).toBe(true);
      expect(repoHeartbeatDuringExecute).not.toBeNull();
      expect(repoLock?.heartbeatAt).toBeGreaterThan(SEED_AT + 1_750);
      expect(repoLock?.leaseExpiresAt).toBeGreaterThan(
        repoHeartbeatDuringExecute ?? 0
      );
    } finally {
      db.close();
    }
  });

  it("does not move the repo lock heartbeat backward when it advanced ahead of the workflow lease", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-1", {
        leaseExpiresAt: SEED_AT + 2_750
      });

      const partialHeartbeatAt = SEED_AT + 1_760;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 2_750,
        executor: fakeExecutor(() => {
          // The live heartbeat worker advances the repo-lock row with a plain
          // (non-monotonic) `startNow + elapsedWallClock` assignment. Acquiring
          // the lease already stamped the repo-lock heartbeat to exactly
          // `startNow` (SEED_AT + 1_750), so we must wait for a value strictly
          // greater than that — only the worker's first real beat clears it.
          // Injecting the simulated advance before that beat lands would let the
          // worker's plain assignment clobber our write with a lower wall-clock
          // value (the historical flake). With a 1s lease the heartbeat interval
          // is 500ms, so exactly one worker beat fires in this window; once it is
          // observed the worker sleeps until `heartbeat.stop()`, leaving our
          // injection as the deterministic last writer.
          const workerBeatAt = waitForRepoLockHeartbeatAfter(
            db,
            "/repo",
            SEED_AT + 1_750,
            3_000
          );
          expect(workerBeatAt).not.toBeNull();

          // Simulate the heartbeat worker's two-row update being observed after
          // the repo-lock row advanced but before the workflow-lease row caught
          // up. Finalization must not use the older workflow lease heartbeat to
          // move the repo lock backward. The observed beat only proves the
          // repo-lock row was written; the worker may still be mid-beat writing
          // the workflow-lease row, so guard the injection against that residual
          // write-lock contention.
          withBusyRetry(() =>
            db
              .prepare(
                `UPDATE repo_locks
                    SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                  WHERE repo_root = ?`
              )
              .run(
                partialHeartbeatAt,
                partialHeartbeatAt + 1_000,
                partialHeartbeatAt,
                "/repo"
              )
          );
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_750
      });

      expect(out.ok).toBe(true);
      const repoLock = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt
             FROM repo_locks
            WHERE repo_root = ?`
        )
        .get("/repo") as { heartbeatAt: number; leaseExpiresAt: number };
      expect(repoLock.heartbeatAt).toBeGreaterThanOrEqual(partialHeartbeatAt);
      expect(repoLock.leaseExpiresAt).toBeGreaterThanOrEqual(
        partialHeartbeatAt + 1_000
      );
    } finally {
      db.close();
    }
  });

  it("does not finish the step when the repo lock is lost during execution", () => {
    const db = openSeededDb(
      "run-1",
      "approved",
      "/repo",
      "implementation",
      null
    );
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedRepoLock(db, "/repo", "worker-1");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          db.prepare(
            `UPDATE repo_locks
                SET state = 'released',
                    released_at = ?,
                    updated_at = ?
              WHERE repo_root = ?`
          ).run(SEED_AT + 1_760, SEED_AT + 1_760, "/repo");
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_760
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.finish).toBeUndefined();
      expect(out.lease.acquired).toBe(true);
      expect(out.lease.released).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe("running");
      expect(
        getWorkflowLease(db, "run-1", "managed-step")?.releasedAt
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not spawn when the run enters manual recovery during the start claim", () => {
    const db = openSeededDb("run-1", "approved");
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      db.exec(
        `CREATE TRIGGER force_live_step_run_recovery
           AFTER INSERT ON workflow_leases
           WHEN NEW.run_id = 'run-1'
            AND NEW.lease_kind = 'managed-step'
         BEGIN
           UPDATE workflow_runs
              SET needs_manual_recovery = 1,
                  manual_recovery_reason = 'operator stopped run',
                  updated_at = ${SEED_AT + 1_749}
            WHERE id = 'run-1';
         END`
      );

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_749
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("lease");
      expect(out.inputError).toBe("operator stopped run");
      expect(out.lease.acquired).toBe(true);
      expect(out.lease.released).toBe(true);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 1_749
      );
    } finally {
      db.close();
    }
  });

  it("refuses execution when the workflow run requires manual recovery", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      db.prepare(
        `UPDATE workflow_runs
           SET needs_manual_recovery = 1,
               manual_recovery_reason = 'operator recovery required',
               updated_at = ?
         WHERE id = ?`
      ).run(SEED_AT + 1_800, "run-1");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_900
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toBe("operator recovery required");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution when the workflow run is terminal", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      db.prepare(
        `UPDATE workflow_runs SET state = 'failed', finished_at = ?, updated_at = ? WHERE id = ?`
      ).run(SEED_AT + 1_800, SEED_AT + 1_800, "run-1");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_950
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("terminal");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution when the workflow run is pending", () => {
    const db = openSeededDb("run-1", "pending");
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_960
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("state pending");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses execution when the workflow run is blocked", () => {
    const db = openSeededDb("run-1", "blocked");
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_970
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("state blocked");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to start a different step while another step is already running", () => {
    const db = openSeededDb("run-1", "running");
    try {
      seedStep(db, "run-1", "step-preflight", "running", "preflight");
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_980
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("already has running step");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-preflight")?.state).toBe(
        "running"
      );
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses an absent workflow step before mutating leases or repo locks", () => {
    const db = openSeededDb();
    try {
      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "missing-step",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: { ...EXEC_INPUT, stepId: "missing-step" },
        now: SEED_AT + 1_990
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.inputError).toContain("workflow step not found");
      expect(out.lease.acquired).toBe(false);
      expect(called).toBe(false);
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();

      const row = db
        .prepare(
          `SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt
             FROM repo_locks
            WHERE repo_root = ? AND state = 'active'`
        )
        .get("/repo") as { heartbeatAt: number; leaseExpiresAt: number };
      expect(row.heartbeatAt).toBe(SEED_AT);
      expect(row.leaseExpiresAt).toBe(SEED_AT + 60_000);
    } finally {
      db.close();
    }
  });

  it("maps a skipped executor result to succeeded after the live step has started", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      const skippedResult = successDispatch("sha256:skip");
      if (skippedResult.ok) {
        skippedResult.result.state = "skipped";
        skippedResult.result.recoveryHint = "skip_already_complete";
      }

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(skippedResult),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 1_750
      });

      expect(out.ok).toBe(true);
      expect(out.terminalState).toBe("succeeded");
      expect(out.lease.released).toBe(true);
      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("succeeded");
      expect(step?.resultDigest).toBe("sha256:skip");
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 1_750
      );
    } finally {
      db.close();
    }
  });

  it("finishes the step as failed with the dispatch error persisted and still releases the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor({
          ok: false,
          code: "command_failed",
          error: "exit 2",
          executorLogPath: "/run/executor.log",
          resultJsonPath: "/run/result.json"
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 2_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.terminalState).toBe("failed");
      expect(out.lease.released).toBe(true);
      expect(out.liveRecoveryCode).toBeUndefined();

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("command_failed");
      expect(step?.errorMessage).toBe("exit 2");
      expect(step?.finishedAt).toBe(SEED_AT + 2_000);

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.releasedAt).toBe(SEED_AT + 2_000);
    } finally {
      db.close();
    }
  });

  it("does not report ok when a succeeded step cannot release its lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      db.exec(
        `CREATE TRIGGER force_live_step_release_failure
           AFTER UPDATE OF state ON workflow_steps
           WHEN NEW.run_id = 'run-1'
            AND NEW.step_id = 'step-impl'
            AND NEW.state = 'succeeded'
         BEGIN
           UPDATE workflow_leases
              SET holder = 'other-holder', updated_at = ${SEED_AT + 2_100}
            WHERE run_id = 'run-1'
              AND lease_kind = 'managed-step'
              AND released_at IS NULL;
         END`
      );

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(successDispatch("sha256:ok")),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 2_100
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.finish?.ok).toBe(true);
      expect(out.terminalState).toBe("succeeded");
      expect(out.lease.released).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("succeeded");
      expect(step?.resultDigest).toBe("sha256:ok");

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("other-holder");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("respects an ok executor result whose terminal state is failed", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const failedResult = successDispatch("sha256:failed");
      if (failedResult.ok) {
        failedResult.result.state = "failed";
        failedResult.result.errorCode = "command_failed";
        failedResult.result.errorMessage = "runner reported success=false";
      }

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(failedResult),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 2_500
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.terminalState).toBe("failed");
      expect(out.lease.released).toBe(true);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("command_failed");
      expect(step?.errorMessage).toBe("runner reported success=false");
      expect(step?.resultDigest).toBe("sha256:failed");
    } finally {
      db.close();
    }
  });

  it("surfaces the precise live recovery code from a live-wrapper dispatch error", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const dispatch: WorkflowStepExecutorDispatchResult & {
        liveRecoveryCode: string;
      } = {
        ok: false,
        code: "runtime_unavailable",
        error: "auth/credentials unavailable",
        executorLogPath: "/run/executor.log",
        resultJsonPath: "/run/result.json",
        liveRecoveryCode: "auth_unavailable"
      };

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(dispatch),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 3_000
      });

      expect(out.ok).toBe(false);
      expect(out.liveRecoveryCode).toBe("auth_unavailable");

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("runtime_unavailable");
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 3_000
      );
    } finally {
      db.close();
    }
  });

  it("traps a thrown executor, finishes the step as failed with executor_threw, and releases the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          throw new Error("boom");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.terminalState).toBe("failed");
      expect(out.lease.released).toBe(true);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("executor_threw");
      expect(step?.errorMessage).toContain("boom");

      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 4_000
      );
    } finally {
      db.close();
    }
  });

  it("fails and releases safely when heartbeat startup throws", () => {
    const realDb = openSeededDb();
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "location") {
          return () => {
            throw new Error("location unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as MomentumDb;
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_200
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.dispatch?.ok).toBe(false);
      expect(out.terminalState).toBe("failed");
      expect(out.lease.released).toBe(true);
      expect(called).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("runtime_unavailable");
      expect(step?.errorMessage).toContain("heartbeat");
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 4_200
      );
    } finally {
      realDb.close();
    }
  });

  it("keeps the lease held when terminal-state persistence fails after execution", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          db.prepare(
            `UPDATE workflow_steps
               SET state = 'canceled', finished_at = ?, updated_at = ?
             WHERE run_id = ? AND step_id = ?`
          ).run(SEED_AT + 4_500, SEED_AT + 4_500, "run-1", "step-impl");
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.finish?.ok).toBe(false);
      expect(out.lease.released).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("canceled");
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("keeps the lease held when the step was terminalized concurrently into the same state", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          db.prepare(
            `UPDATE workflow_steps
               SET state = 'succeeded',
                   finished_at = ?,
                   result_digest = ?,
                   updated_at = ?
             WHERE run_id = ? AND step_id = ?`
          ).run(
            SEED_AT + 4_550,
            "sha256:concurrent",
            SEED_AT + 4_550,
            "run-1",
            "step-impl"
          );
          return successDispatch("sha256:live");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_100
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.finish?.ok).toBe(false);
      expect(out.lease.released).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("succeeded");
      expect(step?.resultDigest).toBe("sha256:concurrent");
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not finish or release when another holder owns the lease after execution", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          db.prepare(
            `UPDATE workflow_leases
               SET released_at = ?, updated_at = ?
             WHERE run_id = ? AND lease_kind = ? AND released_at IS NULL`
          ).run(SEED_AT + 4_500, SEED_AT + 4_500, "run-1", "managed-step");
          const reacquired = acquireWorkflowLease(db, {
            runId: "run-1",
            leaseKind: "managed-step",
            holder: "worker-2",
            expiresAt: SEED_AT + 70_000,
            stalePolicy: "manual-recovery-required",
            now: SEED_AT + 4_600
          });
          expect(reacquired.ok).toBe(true);
          return successDispatch("sha256:late-success");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.dispatch?.ok).toBe(true);
      expect(out.finish).toBeUndefined();
      expect(out.lease.released).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("running");
      expect(step?.finishedAt).toBeNull();
      expect(step?.resultDigest).toBeNull();

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("worker-2");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not finish or release when the lease expired before final heartbeat", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          db.prepare(
            `UPDATE workflow_leases
               SET expires_at = ?, updated_at = ?
             WHERE run_id = ? AND lease_kind = ? AND released_at IS NULL`
          ).run(SEED_AT + 3_999, SEED_AT + 4_000, "run-1", "managed-step");
          return successDispatch("sha256:late-success");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("execute");
      expect(out.dispatch?.ok).toBe(true);
      expect(out.finish).toBeUndefined();
      expect(out.lease.released).toBe(false);

      const step = getWorkflowStep(db, "run-1", "step-impl");
      expect(step?.state).toBe("running");
      expect(step?.finishedAt).toBeNull();
      expect(step?.resultDigest).toBeNull();

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("worker-1");
      expect(lease?.expiresAt).toBe(SEED_AT + 3_999);
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("refuses when an active dispatch lease already holds the run", () => {
    const db = openSeededDb("run-1", "approved");
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedLease(db, "run-1", "dispatch");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_800
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("lease");
      expect(out.lease.acquired).toBe(false);
      expect(out.lease.existing?.leaseKind).toBe("dispatch");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses monitor leases for live step execution before acquiring the lease", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedLease(db, "run-1", "dispatch");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        leaseKind: "monitor" as never,
        executor: fakeExecutor(() => {
          called = true;
          return successDispatch("sha256:ok");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 4_900
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("input");
      expect(out.lease.acquired).toBe(false);
      expect(out.inputError).toContain("leaseKind");
      expect(called).toBe(false);
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe(
        "approved"
      );
      expect(getWorkflowLease(db, "run-1", "monitor")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses with stage 'lease' when the managed-step lease is already held and does not mutate the step", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      seedLease(db, "run-1", "managed-step");

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          throw new Error("executor must not run when the lease is held");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 5_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("lease");
      expect(out.lease.acquired).toBe(false);
      expect(out.lease.existing?.holder).toBe("other-holder");
      expect(called).toBe(false);

      // The step is left untouched.
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe("approved");
    } finally {
      db.close();
    }
  });

  it("releases the lease and refuses with stage 'start' when the step changes before start", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");
      db.exec(
        `CREATE TRIGGER force_live_step_start_conflict
           AFTER INSERT ON workflow_leases
           WHEN NEW.run_id = 'run-1'
            AND NEW.lease_kind = 'managed-step'
         BEGIN
           UPDATE workflow_steps
              SET state = 'pending',
                  updated_at = ${SEED_AT + 6_000}
            WHERE run_id = 'run-1'
              AND step_id = 'step-impl';
         END`
      );

      let called = false;
      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        executor: fakeExecutor(() => {
          called = true;
          throw new Error("executor must not run when start refuses");
        }),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 6_000
      });

      expect(out.ok).toBe(false);
      expect(out.stage).toBe("start");
      expect(out.lease.acquired).toBe(true);
      expect(out.lease.released).toBe(true);
      expect(out.start?.ok).toBe(false);
      expect(called).toBe(false);

      // The step is left in its pre-start state and the lease is released.
      expect(getWorkflowStep(db, "run-1", "step-impl")?.state).toBe("pending");
      expect(getWorkflowLease(db, "run-1", "managed-step")?.releasedAt).toBe(
        SEED_AT + 6_000
      );
    } finally {
      db.close();
    }
  });

  it("honors a custom lease kind and leaves the default managed-step lease untouched", () => {
    const db = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = runLiveWorkflowStep({
        db,
        runId: "run-1",
        stepId: "step-impl",
        holder: "worker-1",
        leaseExpiresAt: SEED_AT + 60_000,
        leaseKind: "dispatch",
        executor: fakeExecutor(successDispatch()),
        executorInput: EXEC_INPUT,
        now: SEED_AT + 7_000
      });

      expect(out.ok).toBe(true);
      expect(getWorkflowLease(db, "run-1", "dispatch")?.releasedAt).toBe(
        SEED_AT + 7_000
      );
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
