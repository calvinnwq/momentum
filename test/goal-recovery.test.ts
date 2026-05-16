import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  GOAL_ITERATION_JOB_TYPE,
  claimPendingGoalIterationJob,
  enqueueGoalIterationJob,
  getQueueJob
} from "../src/queue-jobs.js";
import {
  clearGoalManualRecovery,
  clearGoalManualRecoveryGuarded,
  getGoalManualRecoveryState,
  markGoalNeedsManualRecovery
} from "../src/goal-recovery.js";
import { QUEUE_EVENT_TYPES } from "../src/events.js";
import {
  acquireRepoLock,
  getBlockingRepoLock,
  markRepoLockNeedsManualRecovery
} from "../src/repo-locks.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-goal-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedGoal(db: MomentumDb, id: string): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "manual recovery goal", "momentum/test", "/tmp/test", 1, 1);
}

describe("markGoalNeedsManualRecovery", () => {
  it("sets needs_manual_recovery, manual_recovery_reason, manual_recovery_at on the goal row", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      const out = markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      expect(out).toEqual({ ok: true, previouslyMarked: false });

      const state = getGoalManualRecoveryState(db, "g1");
      expect(state).toEqual({
        goalId: "g1",
        needsManualRecovery: true,
        reason: "repo_dirty",
        markedAt: 1_700_000_000_000
      });
    } finally {
      db.close();
    }
  });

  it("is idempotent and reports previouslyMarked=true on the second call", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      const second = markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 1_700_000_010_000
      });
      expect(second).toEqual({ ok: true, previouslyMarked: true });
      const state = getGoalManualRecoveryState(db, "g1");
      expect(state?.markedAt).toBe(1_700_000_010_000);
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found when the goal does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = markGoalNeedsManualRecovery(db, {
        goalId: "missing",
        reason: "repo_dirty"
      });
      expect(out).toEqual({ ok: false, reason: "goal_not_found" });
    } finally {
      db.close();
    }
  });

  it("validates required fields", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        markGoalNeedsManualRecovery(db, { goalId: "", reason: "x" })
      ).toThrow(/goalId is required/);
      expect(() =>
        markGoalNeedsManualRecovery(db, { goalId: "g", reason: "" })
      ).toThrow(/reason is required/);
    } finally {
      db.close();
    }
  });
});

describe("clearGoalManualRecovery", () => {
  it("clears needs_manual_recovery + reason + at when the flag was set", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      const out = clearGoalManualRecovery(db, {
        goalId: "g1",
        now: 1_700_000_999_000
      });
      expect(out).toEqual({ ok: true, wasMarked: true });
      const state = getGoalManualRecoveryState(db, "g1");
      expect(state).toEqual({
        goalId: "g1",
        needsManualRecovery: false,
        reason: null,
        markedAt: null
      });
    } finally {
      db.close();
    }
  });

  it("returns wasMarked=false when the goal was not flagged", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      const out = clearGoalManualRecovery(db, { goalId: "g1" });
      expect(out).toEqual({ ok: true, wasMarked: false });
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found when the goal does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = clearGoalManualRecovery(db, { goalId: "missing" });
      expect(out).toEqual({ ok: false, reason: "goal_not_found" });
    } finally {
      db.close();
    }
  });
});

describe("claimPendingGoalIterationJob respects needs_manual_recovery", () => {
  it("skips pending jobs whose goal is flagged for manual recovery", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-blocked");
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "g-blocked",
        iteration: 1,
        idempotencyKey: "g-blocked:1",
        artifactPath: "/tmp/test/g-blocked/iterations/1",
        now: 1
      });
      markGoalNeedsManualRecovery(db, {
        goalId: "g-blocked",
        reason: "repo_dirty",
        now: 2
      });

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 10
      });
      expect(claim.ok).toBe(false);
      if (!claim.ok) {
        expect(claim.reason).toBe("no_pending_jobs");
      }

      const job = getQueueJob(db, enqueued.jobId);
      expect(job?.state).toBe("pending");
      expect(job?.worker_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("claims a pending job from an unblocked goal even when another goal is blocked", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-blocked");
      seedGoal(db, "g-open");
      enqueueGoalIterationJob(db, {
        goalId: "g-blocked",
        iteration: 1,
        idempotencyKey: "g-blocked:1",
        artifactPath: "/tmp/test/g-blocked/iterations/1",
        now: 1
      });
      const openJob = enqueueGoalIterationJob(db, {
        goalId: "g-open",
        iteration: 1,
        idempotencyKey: "g-open:1",
        artifactPath: "/tmp/test/g-open/iterations/1",
        now: 2
      });
      markGoalNeedsManualRecovery(db, {
        goalId: "g-blocked",
        reason: "repo_dirty",
        now: 3
      });

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 10
      });
      expect(claim.ok).toBe(true);
      if (claim.ok) {
        expect(claim.job.id).toBe(openJob.jobId);
        expect(claim.job.goal_id).toBe("g-open");
      }
    } finally {
      db.close();
    }
  });

  it("re-eligibility: clearing the flag allows a previously blocked job to be claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/g1/iterations/1",
        now: 1
      });
      markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 2
      });
      const blocked = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 5
      });
      expect(blocked.ok).toBe(false);

      clearGoalManualRecovery(db, { goalId: "g1", now: 6 });

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 10
      });
      expect(claim.ok).toBe(true);
      if (claim.ok) {
        expect(claim.job.id).toBe(enqueued.jobId);
        expect(claim.job.state).toBe("claimed");
      }
    } finally {
      db.close();
    }
  });

  it("validates GOAL_ITERATION_JOB_TYPE remains the type used in the filtered SELECT", () => {
    // Sanity guard: the type constant is referenced both by enqueue and claim;
    // if it ever drifts, the blocked-claim guard test above would silently pass
    // for the wrong reason.
    expect(GOAL_ITERATION_JOB_TYPE).toBe("goal_iteration");
  });
});

describe("clearGoalManualRecoveryGuarded", () => {
  function readLatestEventOfType(
    db: MomentumDb,
    goalId: string,
    type: string
  ): { id: number; payload: Record<string, unknown> } | undefined {
    const row = db
      .prepare(
        `SELECT id, payload FROM events
          WHERE goal_id = ? AND type = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(goalId, type) as
      | { id: number; payload: string }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, payload: JSON.parse(row.payload) };
  }

  it("clears a flagged goal, returns previous reason metadata, and appends a goal.recovery_cleared event", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g1");
      markGoalNeedsManualRecovery(db, {
        goalId: "g1",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });

      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g1",
        operatorReason: "operator inspected repo",
        now: 1_700_000_999_000
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.goalId).toBe("g1");
        expect(out.previousReason).toBe("repo_dirty");
        expect(out.previousMarkedAt).toBe(1_700_000_000_000);
        expect(out.clearedAt).toBe(1_700_000_999_000);
        expect(out.eventId).toBeGreaterThan(0);
      }

      const state = getGoalManualRecoveryState(db, "g1");
      expect(state?.needsManualRecovery).toBe(false);
      expect(state?.reason).toBeNull();
      expect(state?.markedAt).toBeNull();

      const event = readLatestEventOfType(
        db,
        "g1",
        QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED
      );
      expect(event).toBeDefined();
      expect(event?.payload).toEqual({
        previousReason: "repo_dirty",
        previousMarkedAt: 1_700_000_000_000,
        clearedAt: 1_700_000_999_000,
        operatorReason: "operator inspected repo"
      });
    } finally {
      db.close();
    }
  });

  it("releases repo locks that were blocking on manual recovery for the cleared goal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-lock");
      markGoalNeedsManualRecovery(db, {
        goalId: "g-lock",
        reason: "runner_changed_head",
        now: 1_700_000_000_000
      });
      const lock = acquireRepoLock(db, {
        repoRoot: "/tmp/repo-lock",
        holder: "worker",
        goalId: "g-lock",
        iteration: 1,
        jobId: "j-lock",
        leaseExpiresAt: 1_700_000_100_000,
        now: 1_700_000_010_000
      });
      expect(lock.ok).toBe(true);
      if (!lock.ok) return;
      markRepoLockNeedsManualRecovery(db, {
        lockId: lock.lockId,
        now: 1_700_000_020_000,
        recoveryStatus: "runner_changed_head"
      });

      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-lock",
        operatorReason: "repo fixed",
        now: 1_700_000_999_000
      });

      expect(out.ok).toBe(true);
      expect(getBlockingRepoLock(db, "/tmp/repo-lock")).toBeUndefined();
      const row = db
        .prepare("SELECT state, recovery_status, released_at FROM repo_locks WHERE id = ?")
        .get(lock.lockId) as {
        state: string;
        recovery_status: string | null;
        released_at: number | null;
      };
      expect(row).toEqual({
        state: "released",
        recovery_status: "manual_recovery_cleared",
        released_at: 1_700_000_999_000
      });
      const event = readLatestEventOfType(
        db,
        "g-lock",
        QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED
      );
      expect(event?.payload["releasedRepoLockIds"]).toEqual([lock.lockId]);
    } finally {
      db.close();
    }
  });

  it("rolls back the flag clear if the audit event append fails", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-audit-fails");
      markGoalNeedsManualRecovery(db, {
        goalId: "g-audit-fails",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      db.exec(
        `CREATE TRIGGER fail_recovery_cleared_event
           BEFORE INSERT ON events
           WHEN NEW.type = 'goal.recovery_cleared'
           BEGIN
             SELECT RAISE(ABORT, 'recovery clear audit append failed');
           END`
      );

      expect(() =>
        clearGoalManualRecoveryGuarded(db, {
          goalId: "g-audit-fails",
          now: 1_700_000_999_000
        })
      ).toThrow(/recovery clear audit append failed/);

      const state = getGoalManualRecoveryState(db, "g-audit-fails");
      expect(state?.needsManualRecovery).toBe(true);
      expect(state?.reason).toBe("repo_dirty");
      expect(state?.markedAt).toBe(1_700_000_000_000);
      const event = readLatestEventOfType(
        db,
        "g-audit-fails",
        QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED
      );
      expect(event).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found when the goal does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = clearGoalManualRecoveryGuarded(db, { goalId: "missing" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("goal_not_found");
      }
    } finally {
      db.close();
    }
  });

  it("returns not_flagged when the goal exists but is not currently flagged", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-clean");
      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-clean",
        now: 1
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("not_flagged");
        expect(out.message).toMatch(/not flagged/);
      }
      const event = readLatestEventOfType(
        db,
        "g-clean",
        QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED
      );
      expect(event).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns job_active when a claimed goal_iteration job still holds the goal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-stuck");
      enqueueGoalIterationJob(db, {
        goalId: "g-stuck",
        iteration: 1,
        idempotencyKey: "g-stuck:1",
        artifactPath: "/tmp/test/g-stuck/iterations/1",
        now: 1
      });
      // Manually transition to claimed to simulate an in-flight worker.
      // Flag the goal AFTER the claim so the manual-recovery filter does not
      // block the claim path used by other tests.
      db.prepare(
        `UPDATE jobs SET state = 'claimed', worker_id = 'worker-x' WHERE goal_id = ?`
      ).run("g-stuck");
      markGoalNeedsManualRecovery(db, {
        goalId: "g-stuck",
        reason: "repo_dirty",
        now: 2
      });

      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-stuck",
        now: 3
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("job_active");
        expect(out.activeJobIds).toBeDefined();
        expect(out.activeJobIds?.length).toBe(1);
      }

      const state = getGoalManualRecoveryState(db, "g-stuck");
      expect(state?.needsManualRecovery).toBe(true);
      const event = readLatestEventOfType(
        db,
        "g-stuck",
        QUEUE_EVENT_TYPES.GOAL_RECOVERY_CLEARED
      );
      expect(event).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns job_active when a running goal_iteration job still holds the goal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-running");
      enqueueGoalIterationJob(db, {
        goalId: "g-running",
        iteration: 1,
        idempotencyKey: "g-running:1",
        artifactPath: "/tmp/test/g-running/iterations/1",
        now: 1
      });
      db.prepare(
        `UPDATE jobs SET state = 'running', worker_id = 'worker-x' WHERE goal_id = ?`
      ).run("g-running");
      markGoalNeedsManualRecovery(db, {
        goalId: "g-running",
        reason: "job_running",
        now: 2
      });

      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-running",
        now: 3
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("job_active");
      }
    } finally {
      db.close();
    }
  });

  it("does NOT refuse when only pending/succeeded/failed jobs exist (clears successfully)", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-terminal");
      enqueueGoalIterationJob(db, {
        goalId: "g-terminal",
        iteration: 1,
        idempotencyKey: "g-terminal:1",
        artifactPath: "/tmp/test/g-terminal/iterations/1",
        now: 1
      });
      db.prepare(
        `UPDATE jobs SET state = 'failed' WHERE goal_id = ?`
      ).run("g-terminal");
      markGoalNeedsManualRecovery(db, {
        goalId: "g-terminal",
        reason: "repo_dirty",
        now: 2
      });

      const out = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-terminal",
        now: 3
      });
      expect(out.ok).toBe(true);
      const state = getGoalManualRecoveryState(db, "g-terminal");
      expect(state?.needsManualRecovery).toBe(false);
    } finally {
      db.close();
    }
  });

  it("re-eligibility: clearing via guarded path lets a previously blocked pending job be claimed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedGoal(db, "g-ack");
      const enqueued = enqueueGoalIterationJob(db, {
        goalId: "g-ack",
        iteration: 1,
        idempotencyKey: "g-ack:1",
        artifactPath: "/tmp/test/g-ack/iterations/1",
        now: 1
      });
      markGoalNeedsManualRecovery(db, {
        goalId: "g-ack",
        reason: "repo_dirty",
        now: 2
      });
      const blocked = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 5
      });
      expect(blocked.ok).toBe(false);

      const cleared = clearGoalManualRecoveryGuarded(db, {
        goalId: "g-ack",
        now: 6
      });
      expect(cleared.ok).toBe(true);

      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-x",
        leaseDurationMs: 30_000,
        now: 10
      });
      expect(claim.ok).toBe(true);
      if (claim.ok) {
        expect(claim.job.id).toBe(enqueued.jobId);
      }
    } finally {
      db.close();
    }
  });

  it("validates goalId input", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        clearGoalManualRecoveryGuarded(db, { goalId: "" })
      ).toThrow(/goalId is required/);
    } finally {
      db.close();
    }
  });
});
