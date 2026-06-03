import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  recoverStaleWorkflowLeases,
  selectRunnableWorkflowWork,
  WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
  WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS
} from "../src/workflow-scheduler.js";
import { getWorkflowLease } from "../src/workflow-leases.js";
import { getWorkflowRunManualRecoveryState } from "../src/workflow-run-recovery.js";
import type {
  WorkflowLeaseKind,
  WorkflowLeaseStalePolicy,
  WorkflowRunState,
  WorkflowStepKind,
  WorkflowStepState
} from "../src/workflow-run-reducer.js";

const NOW = 1_730_000_000_000;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-scheduler-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

type SeedRunInput = {
  runId: string;
  state: WorkflowRunState;
  repoPath?: string | null;
  needsManualRecovery?: boolean;
  createdAt?: number;
};

function seedRun(db: MomentumDb, input: SeedRunInput): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, repo_path, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, 'workflow-run-start', '{}', ?, '{}', '{}', ?, ?, ?)`
  ).run(
    input.runId,
    input.state,
    input.repoPath ?? null,
    input.needsManualRecovery ? 1 : 0,
    input.createdAt ?? NOW,
    input.createdAt ?? NOW
  );
}

type SeedStepInput = {
  runId: string;
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  order: number;
  required?: boolean;
};

function seedStep(db: MomentumDb, input: SeedStepInput): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    input.required === false ? 0 : 1,
    NOW,
    NOW
  );
}

type SeedLeaseInput = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  expiresAt: number;
  holder?: string;
  acquiredAt?: number;
  heartbeatAt?: number;
  releasedAt?: number | null;
  stalePolicy?: WorkflowLeaseStalePolicy;
};

function seedLease(db: MomentumDb, input: SeedLeaseInput): void {
  const acquiredAt = input.acquiredAt ?? NOW - 60_000;
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.leaseKind,
    input.holder ?? "worker-1",
    acquiredAt,
    input.expiresAt,
    input.heartbeatAt ?? acquiredAt,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    acquiredAt,
    acquiredAt
  );
}

describe("selectRunnableWorkflowWork: durable runnable-step scan (NGX-348)", () => {
  it("selects the first approved step of an approved run", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved", repoPath: "/repos/a" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "postflight",
        kind: "postflight",
        state: "pending",
        order: 2
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([
        {
          runId: "run-a",
          stepId: "preflight",
          kind: "preflight",
          stepOrder: 0,
          required: true,
          repoPath: "/repos/a",
          runState: "approved"
        }
      ]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("advances to the next approved step once predecessors are succeeded/skipped", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "skipped",
        order: 0
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "postflight",
        kind: "postflight",
        state: "approved",
        order: 2
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable.map((s) => s.stepId)).toEqual(["postflight"]);
      expect(scan.runnable[0]?.runState).toBe("approved");
    } finally {
      db.close();
    }
  });

  it("treats a run with a running step as busy (no runnable step)", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "running",
        order: 0
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not run a step that is still awaiting approval", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("excludes runs flagged for manual recovery", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, {
        runId: "run-a",
        state: "approved",
        needsManualRecovery: true
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("excludes terminal runs", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-done", state: "succeeded" });
      seedStep(db, {
        runId: "run-done",
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("treats a fresh managed-step lease as busy even when the step is still approved", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW + 10_000
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("flags a stale auto-release lease and withholds the run until it is recovered", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release"
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
      expect(scan.staleLeases).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          classification: "stale-auto-release",
          stalePolicy: "auto-release",
          expiresAt: NOW - 10_000
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("flags a stale manual-recovery lease and blocks the run", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required"
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
      expect(scan.staleLeases).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          classification: "stale-manual-recovery-required",
          stalePolicy: "manual-recovery-required",
          expiresAt: NOW - 10_000
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("ignores released leases entirely", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        releasedAt: NOW - 5_000,
        stalePolicy: "manual-recovery-required"
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable.map((s) => s.stepId)).toEqual(["preflight"]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not let a monitor lease block step scheduling", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "monitor",
        expiresAt: NOW + 10_000
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable.map((s) => s.stepId)).toEqual(["preflight"]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("respects graceMs when classifying a barely-expired lease as fresh", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 1_000
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW, graceMs: 5_000 });

      // Within grace → fresh → busy, not stale.
      expect(scan.runnable).toEqual([]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns one runnable step per eligible run, ordered by run creation", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-late", state: "approved", createdAt: NOW + 100 });
      seedStep(db, {
        runId: "run-late",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedRun(db, { runId: "run-early", state: "approved", createdAt: NOW });
      seedStep(db, {
        runId: "run-early",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW + 200 });

      expect(scan.runnable.map((s) => s.runId)).toEqual([
        "run-early",
        "run-late"
      ]);
    } finally {
      db.close();
    }
  });

  it("validates the now input", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() =>
        selectRunnableWorkflowWork(db, { now: Number.NaN })
      ).toThrow(/now must be a finite number/);
      expect(() =>
        selectRunnableWorkflowWork(db, { now: NOW, graceMs: -1 })
      ).toThrow(/graceMs must be a non-negative finite number/);
    } finally {
      db.close();
    }
  });
});

describe("recoverStaleWorkflowLeases: durable stale-lease recovery (NGX-348)", () => {
  it("releases a stale auto-release lease so the run becomes runnable again", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved", repoPath: "/repos/a" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release"
      });

      // Before recovery the fresh-but-stale lease withholds the run.
      expect(selectRunnableWorkflowWork(db, { now: NOW }).runnable).toEqual([]);

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS
        }
      ]);
      expect(result.skipped).toEqual([]);

      // The lease row is now released, not deleted.
      const lease = getWorkflowLease(db, "run-a", "managed-step");
      expect(lease?.releasedAt).toBe(NOW);

      // And the run is once again schedulable.
      const scan = selectRunnableWorkflowWork(db, { now: NOW });
      expect(scan.runnable.map((s) => s.stepId)).toEqual(["preflight"]);
      expect(scan.staleLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("flags the run for manual recovery on a stale manual-recovery lease and leaves the lease in place", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required"
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          stalePolicy: "manual-recovery-required",
          action: "flagged_manual_recovery",
          recoveryStatus: WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS
        }
      ]);
      expect(result.skipped).toEqual([]);

      const recovery = getWorkflowRunManualRecoveryState(db, "run-a");
      expect(recovery?.needsManualRecovery).toBe(true);
      expect(recovery?.reason).toContain(WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS);
      expect(recovery?.markedAt).toBe(NOW);

      // The lease is preserved as durable evidence (the reducer keeps the run
      // blocked, and the operator must resolve it before clearing recovery).
      const lease = getWorkflowLease(db, "run-a", "managed-step");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("leaves fresh leases untouched", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW + 10_000
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result).toEqual({ recovered: [], skipped: [] });
      const lease = getWorkflowLease(db, "run-a", "managed-step");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("leaves released leases untouched", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        releasedAt: NOW - 5_000,
        stalePolicy: "manual-recovery-required"
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result).toEqual({ recovered: [], skipped: [] });
      const recovery = getWorkflowRunManualRecoveryState(db, "run-a");
      expect(recovery?.needsManualRecovery).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is idempotent for an auto-released lease", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release"
      });

      const first = recoverStaleWorkflowLeases(db, { now: NOW });
      expect(first.recovered).toHaveLength(1);

      const second = recoverStaleWorkflowLeases(db, { now: NOW });
      expect(second).toEqual({ recovered: [], skipped: [] });
    } finally {
      db.close();
    }
  });

  it("is idempotent for a manual-recovery-flagged run", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required"
      });

      const first = recoverStaleWorkflowLeases(db, { now: NOW });
      expect(first.recovered).toHaveLength(1);

      // The run is now excluded from the scan, so a second pass is a no-op.
      const second = recoverStaleWorkflowLeases(db, { now: NOW });
      expect(second).toEqual({ recovered: [], skipped: [] });
    } finally {
      db.close();
    }
  });

  it("recovers stale leases across multiple runs in one pass", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-auto", state: "approved", createdAt: NOW });
      seedStep(db, {
        runId: "run-auto",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-auto",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release"
      });

      seedRun(db, { runId: "run-manual", state: "running", createdAt: NOW + 1 });
      seedStep(db, {
        runId: "run-manual",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-manual",
        leaseKind: "dispatch",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required"
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(
        result.recovered.map((r) => [r.runId, r.action])
      ).toEqual([
        ["run-auto", "released"],
        ["run-manual", "flagged_manual_recovery"]
      ]);
      expect(result.skipped).toEqual([]);
      expect(getWorkflowLease(db, "run-auto", "managed-step")?.releasedAt).toBe(
        NOW
      );
      expect(
        getWorkflowRunManualRecoveryState(db, "run-manual")?.needsManualRecovery
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("respects graceMs when a barely-expired lease is still within tolerance", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 1_000,
        stalePolicy: "auto-release"
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW, graceMs: 5_000 });

      expect(result).toEqual({ recovered: [], skipped: [] });
      expect(getWorkflowLease(db, "run-a", "managed-step")?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("validates the now and graceMs inputs", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() =>
        recoverStaleWorkflowLeases(db, { now: Number.NaN })
      ).toThrow(/now must be a finite number/);
      expect(() =>
        recoverStaleWorkflowLeases(db, { now: NOW, graceMs: -1 })
      ).toThrow(/graceMs must be a non-negative finite number/);
    } finally {
      db.close();
    }
  });
});
