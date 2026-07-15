import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  recoverStaleWorkflowLeases,
  runWorkflowSchedulerOnce,
  runWorkflowSchedulerOnceAsync,
  selectRunnableWorkflowWork,
  DEFAULT_WORKFLOW_DISPATCH_LEASE_MS,
  WORKFLOW_DISPATCH_LEASE_KIND,
  WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
  WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatch,
  type WorkflowStepDispatchContext,
  type WorkflowStepDispatchResult,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch,
} from "../src/core/workflow/dispatch/execute.js";
import { terminalizeDispatchedExecutorInvocation } from "../src/core/workflow/dispatch/executor-evidence.js";
import { resolveWorkflowRecoveryArtifactPath } from "../src/core/workflow/recovery/artifact.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import { deriveWorkflowRunState } from "../src/core/workflow/run/reducer.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  insertExecutorInvocation,
  loadExecutorInvocation,
  updateExecutorRound,
} from "../src/core/executors/loop/persist.js";
import { createDurableExecutorEnvelope } from "../src/core/executors/sdk/envelope.js";
import { EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE } from "../src/core/executors/sdk/types.js";
import {
  DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
  DELEGATE_SUPERVISOR_HANDOFF_STAGE,
  DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
  DELEGATE_SUPERVISOR_MIRRORED_STAGE,
} from "../src/core/executors/delegate-supervisor/executor.js";
import type {
  WorkflowLeaseKind,
  WorkflowLeaseRecord,
  WorkflowLeaseStalePolicy,
  WorkflowRunState,
  WorkflowStepKind,
  WorkflowStepState,
} from "../src/core/workflow/run/reducer.js";

const NOW = 1_730_000_000_000;

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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
     VALUES (?, ?, 'workflow-run-start', '{}', ?, '{}', '{}', ?, ?, ?)`,
  ).run(
    input.runId,
    input.state,
    input.repoPath ?? null,
    input.needsManualRecovery ? 1 : 0,
    input.createdAt ?? NOW,
    input.createdAt ?? NOW,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    input.required === false ? 0 : 1,
    NOW,
    NOW,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    acquiredAt,
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
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "postflight",
        kind: "postflight",
        state: "pending",
        order: 2,
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
          runState: "approved",
        },
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
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "postflight",
        kind: "postflight",
        state: "approved",
        order: 2,
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
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
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
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      expect(scan.runnable).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("withholds an approved step queued behind a still-pending predecessor", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      // Predecessor still awaiting approval; the later step is already
      // approved. Unlike the succeeded+pending case (which derives to
      // `pending` and is dropped by the run-state guard), an approved step with
      // nothing running/blocked/failed derives the whole run to `approved`, so
      // it clears the scan's `derivedRunState !== "approved"` short-circuit.
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "pending",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });

      // Precondition: the run is genuinely dispatchable per run-state, so the
      // empty scan below proves the in-order rule (nextRunnableStep) withheld
      // the approved step rather than the run-state guard dropping the run.
      expect(
        deriveWorkflowRunState(
          [
            {
              stepId: "preflight",
              kind: "preflight",
              state: "pending",
              order: 0,
              required: true,
            },
            {
              stepId: "implementation",
              kind: "implementation",
              state: "approved",
              order: 1,
              required: true,
            },
          ],
          { leases: [], now: NOW },
        ),
      ).toBe("approved");

      const scan = selectRunnableWorkflowWork(db, { now: NOW });

      // The approved step is never dispatched past its pending predecessor.
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
        needsManualRecovery: true,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
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
        order: 0,
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW + 10_000,
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
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
          expiresAt: NOW - 10_000,
        },
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
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
          expiresAt: NOW - 10_000,
        },
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        releasedAt: NOW - 5_000,
        stalePolicy: "manual-recovery-required",
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "monitor",
        expiresAt: NOW + 10_000,
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 1_000,
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
      seedRun(db, {
        runId: "run-late",
        state: "approved",
        createdAt: NOW + 100,
      });
      seedStep(db, {
        runId: "run-late",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedRun(db, { runId: "run-early", state: "approved", createdAt: NOW });
      seedStep(db, {
        runId: "run-early",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });

      const scan = selectRunnableWorkflowWork(db, { now: NOW + 200 });

      expect(scan.runnable.map((s) => s.runId)).toEqual([
        "run-early",
        "run-late",
      ]);
    } finally {
      db.close();
    }
  });

  it("validates the now input", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() => selectRunnableWorkflowWork(db, { now: Number.NaN })).toThrow(
        /now must be a finite number/,
      );
      expect(() =>
        selectRunnableWorkflowWork(db, { now: NOW, graceMs: -1 }),
      ).toThrow(/graceMs must be a non-negative finite number/);
    } finally {
      db.close();
    }
  });
});

describe("recoverStaleWorkflowLeases: durable stale-lease recovery (NGX-348)", () => {
  it("reconciles terminal dispatch evidence before recovering a stale dispatch lease", () => {
    const db = openDb(makeTempDir());
    try {
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId: "run-a",
        repoPath: "/repos/a",
        objective: "Recover terminal dispatch evidence",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
      ).run("run-a", "preflight");
      const claim = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
        stalePolicy: "auto-release",
      });
      if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
      executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: "worker-1",
        now: NOW + 1,
      });
      db.prepare(
        `UPDATE workflow_leases
            SET acquired_at = ?, heartbeat_at = ?, expires_at = ?, updated_at = ?
          WHERE run_id = ? AND lease_kind = 'dispatch'`,
      ).run(NOW - 60_000, NOW - 60_000, NOW - 10_000, NOW - 60_000, "run-a");
      terminalizeDispatchedExecutorInvocation({
        db,
        runId: "run-a",
        stepId: "preflight",
        now: NOW + 2,
        result: {
          ok: true,
          result: {
            state: "succeeded",
            summary: "terminal evidence committed",
            checkpoints: [],
            artifacts: [],
            resultDigest: "sha256:terminal-evidence",
            errorCode: null,
            errorMessage: null,
            retryHint: null,
            recoveryHint: null,
          },
          executorLogPath: "/repos/a/.agent-workflows/run-a/executor.log",
          resultJsonPath: "/repos/a/.agent-workflows/run-a/result.json",
        },
      });

      expect(getWorkflowStep(db, "run-a", "preflight")?.state).toBe("running");
      expect(
        loadExecutorInvocation(
          db,
          deriveDispatchInvocationId("run-a", "preflight"),
        )?.state,
      ).toBe("succeeded");

      const result = recoverStaleWorkflowLeases(db, { now: NOW + 100 });

      expect(result.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "dispatch",
          holder: "worker-1",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(result.skipped).toEqual([]);
      expect(getWorkflowStep(db, "run-a", "preflight")?.state).toBe(
        "succeeded",
      );
      expect(getWorkflowLease(db, "run-a", "dispatch")?.releasedAt).toBe(
        NOW + 100,
      );
      expect(selectRunnableWorkflowWork(db, { now: NOW + 100 })).toEqual({
        runnable: [],
        staleLeases: [],
      });
    } finally {
      db.close();
    }
  });

  it("parks a stale nonterminal dispatch invocation and releases its lease", () => {
    const db = openDb(makeTempDir());
    try {
      persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId: "run-a",
        repoPath: "/repos/a",
        objective: "Recover nonterminal dispatch evidence",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
      ).run("run-a", "preflight");
      const claim = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
        stalePolicy: "auto-release",
      });
      if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
      executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: "worker-1",
        now: NOW + 1,
      });
      db.prepare(
        `UPDATE workflow_leases
            SET acquired_at = ?, heartbeat_at = ?, expires_at = ?, updated_at = ?
          WHERE run_id = ? AND lease_kind = 'dispatch'`,
      ).run(NOW - 60_000, NOW - 60_000, NOW - 10_000, NOW - 60_000, "run-a");

      expect(getWorkflowStep(db, "run-a", "preflight")?.state).toBe("running");
      expect(
        loadExecutorInvocation(
          db,
          deriveDispatchInvocationId("run-a", "preflight"),
        )?.state,
      ).toBe("running");

      const result = recoverStaleWorkflowLeases(db, { now: NOW + 100 });

      expect(result.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "dispatch",
          holder: "worker-1",
          stalePolicy: "auto-release",
          action: "flagged_manual_recovery",
          recoveryStatus: WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS,
        },
      ]);
      expect(result.skipped).toEqual([]);
      expect(getWorkflowStep(db, "run-a", "preflight")?.state).toBe("running");
      const recovery = getWorkflowRunManualRecoveryState(db, "run-a");
      expect(recovery?.needsManualRecovery).toBe(true);
      expect(recovery?.reason).toContain("dispatch lease");
      expect(getWorkflowLease(db, "run-a", "dispatch")?.releasedAt).toBe(
        NOW + 100,
      );
      expect(selectRunnableWorkflowWork(db, { now: NOW + 100 })).toEqual({
        runnable: [],
        staleLeases: [],
      });
    } finally {
      db.close();
    }
  });

  it("releases a stale auto-release lease so the run becomes runnable again", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved", repoPath: "/repos/a" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
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
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
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

  it("refreshes run state after auto-releasing the last outstanding lease", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, {
        runId: "run-a",
        state: "running",
        createdAt: NOW - 60_000,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered).toHaveLength(1);
      const row = db
        .prepare(
          "SELECT state, finished_at, updated_at FROM workflow_runs WHERE id = ?",
        )
        .get("run-a") as
        | { state: string; finished_at: number | null; updated_at: number }
        | undefined;
      expect(row).toEqual({
        state: "succeeded",
        finished_at: NOW,
        updated_at: NOW,
      });
      expect(selectRunnableWorkflowWork(db, { now: NOW })).toEqual({
        runnable: [],
        staleLeases: [],
      });
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          stalePolicy: "manual-recovery-required",
          action: "flagged_manual_recovery",
          recoveryStatus: WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS,
        },
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

  it("renders recovery.md when a stale manual-recovery lease parks a run", () => {
    const repoPath = makeTempDir("momentum-workflow-scheduler-repo-");
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running", repoPath });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "running",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered).toHaveLength(1);
      const artifactPath = resolveWorkflowRecoveryArtifactPath(
        path.join(repoPath, ".agent-workflows"),
        "run-a",
      );
      expect(fs.existsSync(artifactPath)).toBe(true);
      const body = fs.readFileSync(artifactPath, "utf-8");
      expect(body).toContain("Recovery classification: manual_recovery_lease");
      expect(body).toContain(`Classified at (epoch ms): ${NOW}`);
      expect(body).toContain(WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS);
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW + 10_000,
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        releasedAt: NOW - 5_000,
        stalePolicy: "manual-recovery-required",
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-auto",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
      });

      seedRun(db, {
        runId: "run-manual",
        state: "running",
        createdAt: NOW + 1,
      });
      seedStep(db, {
        runId: "run-manual",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-manual",
        leaseKind: "dispatch",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
      });

      const result = recoverStaleWorkflowLeases(db, { now: NOW });

      expect(result.recovered.map((r) => [r.runId, r.action])).toEqual([
        ["run-auto", "released"],
        ["run-manual", "flagged_manual_recovery"],
      ]);
      expect(result.skipped).toEqual([]);
      expect(getWorkflowLease(db, "run-auto", "managed-step")?.releasedAt).toBe(
        NOW,
      );
      expect(
        getWorkflowRunManualRecoveryState(db, "run-manual")
          ?.needsManualRecovery,
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
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 1_000,
        stalePolicy: "auto-release",
      });

      const result = recoverStaleWorkflowLeases(db, {
        now: NOW,
        graceMs: 5_000,
      });

      expect(result).toEqual({ recovered: [], skipped: [] });
      expect(
        getWorkflowLease(db, "run-a", "managed-step")?.releasedAt,
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("validates the now and graceMs inputs", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() => recoverStaleWorkflowLeases(db, { now: Number.NaN })).toThrow(
        /now must be a finite number/,
      );
      expect(() =>
        recoverStaleWorkflowLeases(db, { now: NOW, graceMs: -1 }),
      ).toThrow(/graceMs must be a non-negative finite number/);
    } finally {
      db.close();
    }
  });
});

describe("claimRunnableWorkflowStep: atomic dispatch-lease claim (NGX-348)", () => {
  const LEASE_EXPIRES_AT = NOW + 30_000;

  it("claims a runnable step by acquiring a fresh dispatch lease", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved", repoPath: "/repos/a" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected claim to succeed");
      expect(result.claim).toMatchObject({
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        stepOrder: 0,
        required: true,
        repoPath: "/repos/a",
        runState: "approved",
      });
      expect(result.claim.lease).toMatchObject({
        runId: "run-a",
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "worker-1",
        expiresAt: LEASE_EXPIRES_AT,
        releasedAt: null,
        stalePolicy: "auto-release",
      });

      // The dispatch lease is durable, and the run now scans as busy.
      const lease = getWorkflowLease(db, "run-a", "dispatch");
      expect(lease?.releasedAt).toBeNull();
      expect(lease?.holder).toBe("worker-1");
      expect(selectRunnableWorkflowWork(db, { now: NOW }).runnable).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refuses to claim a step that is not the next runnable step (superseded)", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "implementation",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({
        ok: false,
        reason: "step_superseded",
        runnableStepId: "preflight",
      });
      expect(getWorkflowLease(db, "run-a", "dispatch")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to claim an approved step withheld behind a pending predecessor", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "pending",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "implementation",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      // A *pending* predecessor (vs. the superseded case's approved one) means
      // no step is runnable at all, so the claim fails closed with
      // run_not_runnable and reports no alternative runnable step.
      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });

      // Fail-closed: no dispatch lease was acquired and neither step moved.
      expect(getWorkflowLease(db, "run-a", "dispatch")).toBeUndefined();
      const states = db
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order",
        )
        .all("run-a") as Array<{ step_id: string; state: string }>;
      expect(states).toEqual([
        { step_id: "preflight", state: "pending" },
        { step_id: "implementation", state: "approved" },
      ]);
    } finally {
      db.close();
    }
  });

  it("returns run_not_found for a missing run", () => {
    const db = openDb(makeTempDir());
    try {
      const result = claimRunnableWorkflowStep(db, {
        runId: "ghost",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_found" });
    } finally {
      db.close();
    }
  });

  it("refuses to claim a step on a terminal run", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-done", state: "succeeded" });
      seedStep(db, {
        runId: "run-done",
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-done",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });
    } finally {
      db.close();
    }
  });

  it("refuses to claim a step on a run flagged for manual recovery", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, {
        runId: "run-a",
        state: "approved",
        needsManualRecovery: true,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });
      expect(getWorkflowLease(db, "run-a", "dispatch")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to claim while a running step keeps the run busy", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "running",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "implementation",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });
    } finally {
      db.close();
    }
  });

  it("reports lease_held when another worker holds a fresh managed-step lease", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        holder: "worker-2",
        expiresAt: NOW + 10_000,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected claim to fail");
      expect(result.reason).toBe("lease_held");
      if (result.reason !== "lease_held") throw new Error("unreachable");
      expect(result.existing).toMatchObject({
        leaseKind: "managed-step",
        holder: "worker-2",
      });
      // No dispatch lease is created when the claim loses.
      expect(getWorkflowLease(db, "run-a", "dispatch")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to claim while a stale lease still withholds the run pending recovery", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });
      // The stale lease is left untouched for the recovery pass to handle.
      expect(
        getWorkflowLease(db, "run-a", "managed-step")?.releasedAt,
      ).toBeNull();
      expect(getWorkflowLease(db, "run-a", "dispatch")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to claim a run blocked by a stale manual-recovery lease", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result).toEqual({ ok: false, reason: "run_not_runnable" });
    } finally {
      db.close();
    }
  });

  it("does not let a monitor lease block a claim", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "monitor",
        expiresAt: NOW + 10_000,
      });

      const result = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });

      expect(result.ok).toBe(true);
      expect(getWorkflowLease(db, "run-a", "dispatch")?.holder).toBe(
        "worker-1",
      );
    } finally {
      db.close();
    }
  });

  it("is exclusive: a second claim for the same step loses to the first", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });

      const first = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      });
      expect(first.ok).toBe(true);

      const second = claimRunnableWorkflowStep(db, {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-2",
        leaseExpiresAt: LEASE_EXPIRES_AT + 5_000,
        now: NOW + 1_000,
      });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected the second claim to fail");
      expect(second.reason).toBe("lease_held");
      if (second.reason !== "lease_held") throw new Error("unreachable");
      expect(second.existing.holder).toBe("worker-1");
    } finally {
      db.close();
    }
  });

  it("validates inputs", () => {
    const db = openDb(makeTempDir());
    try {
      const base = {
        runId: "run-a",
        stepId: "preflight",
        holder: "worker-1",
        leaseExpiresAt: LEASE_EXPIRES_AT,
        now: NOW,
      };
      expect(() =>
        claimRunnableWorkflowStep(db, { ...base, now: Number.NaN }),
      ).toThrow(/now must be a finite number/);
      expect(() =>
        claimRunnableWorkflowStep(db, { ...base, graceMs: -1 }),
      ).toThrow(/graceMs must be a non-negative finite number/);
      expect(() =>
        claimRunnableWorkflowStep(db, { ...base, holder: "" }),
      ).toThrow(/holder is required/);
      expect(() =>
        claimRunnableWorkflowStep(db, { ...base, stepId: "" }),
      ).toThrow(/stepId is required/);
      expect(() =>
        claimRunnableWorkflowStep(db, { ...base, leaseExpiresAt: 0 }),
      ).toThrow(/leaseExpiresAt must be a positive integer/);
    } finally {
      db.close();
    }
  });
});

type DispatchRecorder = {
  dispatch: WorkflowStepDispatch;
  calls: Array<{
    claim: ClaimedWorkflowStep;
    context: WorkflowStepDispatchContext;
  }>;
};

function recordingDispatch(
  result: WorkflowStepDispatchResult = { status: "dispatched" },
): DispatchRecorder {
  const calls: DispatchRecorder["calls"] = [];
  const dispatch: WorkflowStepDispatch = (claim, context) => {
    calls.push({ claim, context });
    return result;
  };
  return { dispatch, calls };
}

function seedCheckpointedDelegateHandoff(
  db: MomentumDb,
  runId: string,
  stepId: string,
  stage: string = DELEGATE_SUPERVISOR_HANDOFF_STAGE,
) {
  seedRun(db, { runId, state: "running", repoPath: "/repos/fixture" });
  seedStep(db, {
    runId,
    stepId,
    kind: "implementation",
    state: "running",
    order: 0,
  });
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  insertExecutorInvocation(
    db,
    {
      invocationId,
      workflowRunId: runId,
      stepRunId: stepId,
      stepKey: stepId,
      executorFamily: "delegate-supervisor",
      state: "running",
      attempt: 1,
      startedAt: NOW,
      heartbeatAt: NOW,
      finishedAt: null,
    },
    { now: NOW },
  );
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId,
    now: () => NOW,
  });
  const roundId = `${invocationId}::round-1`;
  envelope.facade.startRound({
    roundId,
    invocationId,
    workflowRunId: runId,
    stepRunId: stepId,
    stepKey: stepId,
    executorFamily: "delegate-supervisor",
    attempt: 1,
    roundIndex: 0,
    state: "capturing_result",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: "handoff evidence persisted",
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
  envelope.facade.recordCheckpoint(roundId, {
    checkpointId: `${roundId}-${stage}`,
    sequence: 0,
    stage,
    detail: JSON.stringify(
      stage === DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE
        ? {
            tool: "no-mistakes",
            invocationId,
            attempt: 1,
          }
        : {
            externalIdentity: {
              externalRunId: "external-run-1",
              branch: "feature/delegate-supervisor",
              headSha: "a".repeat(40),
            },
            summary: "handoff evidence persisted",
          },
    ),
  });
  return { envelope, invocationId, roundId };
}

function seedDelegateBeforeCurrentAttemptRound(
  db: MomentumDb,
  runId: string,
  stepId: string,
  attempt: 1 | 2,
): void {
  seedRun(db, { runId, state: "running", repoPath: "/repos/fixture" });
  seedStep(db, {
    runId,
    stepId,
    kind: "implementation",
    state: "running",
    order: 0,
  });
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  insertExecutorInvocation(
    db,
    {
      invocationId,
      workflowRunId: runId,
      stepRunId: stepId,
      stepKey: stepId,
      executorFamily: "delegate-supervisor",
      state: "running",
      attempt: 1,
      startedAt: NOW,
      heartbeatAt: NOW,
      finishedAt: null,
    },
    { now: NOW },
  );
  if (attempt === 1) return;
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId,
    now: () => NOW,
  });
  const roundId = `${invocationId}::round-1`;
  envelope.facade.startRound({
    roundId,
    invocationId,
    workflowRunId: runId,
    stepRunId: stepId,
    stepKey: stepId,
    executorFamily: "delegate-supervisor",
    attempt: 1,
    roundIndex: 0,
    state: "running",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: "prior attempt",
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
  updateExecutorRound(db, roundId, {
    toState: "manual_recovery_required",
    classification: "manual_recovery_required",
    executorRecommendation: "manual_recovery_required",
    recoveryCode: "delegate_handoff_failed",
    humanGate: "manual_recovery_required",
    finishedAt: NOW,
  });
  db.prepare(
    `UPDATE executor_invocations
        SET attempt = 2, state = 'running', finished_at = NULL
      WHERE invocation_id = ?`,
  ).run(invocationId);
}

function seedRegisteredSdkContinuation(
  db: MomentumDb,
  runId: string,
  stepId: string,
) {
  seedRun(db, { runId, state: "running", repoPath: "/repos/fixture" });
  seedStep(db, {
    runId,
    stepId,
    kind: "implementation",
    state: "running",
    order: 0,
  });
  const invocationId = deriveDispatchInvocationId(runId, stepId);
  insertExecutorInvocation(
    db,
    {
      invocationId,
      workflowRunId: runId,
      stepRunId: stepId,
      stepKey: stepId,
      executorFamily: "fixture-executor",
      state: "running",
      attempt: 1,
      startedAt: NOW,
      heartbeatAt: NOW,
      finishedAt: null,
    },
    { now: NOW },
  );
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId,
    now: () => NOW,
  });
  const roundId = `${invocationId}::round-1`;
  envelope.facade.startRound({
    roundId,
    invocationId,
    workflowRunId: runId,
    stepRunId: stepId,
    stepKey: stepId,
    executorFamily: "fixture-executor",
    attempt: 1,
    roundIndex: 0,
    state: "running",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: "fixture continuation",
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
  updateExecutorRound(db, roundId, {
    toState: "capturing_result",
  });
  envelope.applyDaemonDecision(
    {
      roundId,
      classification: "continue",
      executorRecommendation: "continue",
      roundState: "succeeded",
      invocationState: "running",
      recoveryCode: null,
      humanGate: null,
    },
    {
      allocateClassificationCheckpointIdentity: true,
      classificationCheckpoint: {
        stage: "classified",
        detail: "classification: continue",
      },
    },
  );
  return { invocationId, roundId };
}

describe("runWorkflowSchedulerOnce: scheduler-lane tick (NGX-348)", () => {
  it("lets runnable work proceed between persisted delegate poll deadlines", () => {
    const db = openDb(makeTempDir());
    try {
      seedCheckpointedDelegateHandoff(db, "run-continuation", "implementation");
      seedLease(db, {
        runId: "run-continuation",
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "scheduler-1",
        acquiredAt: NOW,
        heartbeatAt: NOW,
        expiresAt: NOW + DEFAULT_WORKFLOW_DISPATCH_LEASE_MS,
      });
      seedRun(db, { runId: "run-runnable", state: "approved" });
      seedStep(db, {
        runId: "run-runnable",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.claim.runId).toBe("run-runnable");
    } finally {
      db.close();
    }
  });

  it("alternates overdue continuations with runnable work independently of lease duration", () => {
    const db = openDb(makeTempDir());
    try {
      seedCheckpointedDelegateHandoff(db, "run-continuation", "implementation");
      seedLease(db, {
        runId: "run-continuation",
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "scheduler-1",
        acquiredAt: NOW,
        heartbeatAt: NOW,
        expiresAt: NOW + 7_235_000,
      });
      seedRun(db, { runId: "run-runnable", state: "approved" });
      seedStep(db, {
        runId: "run-runnable",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const recorder = recordingDispatch();

      const runnable = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 7_235_000,
        continuationPollIntervalMs: 15_000,
        dispatch: recorder.dispatch,
        now: () => NOW + 20_000,
      });
      expect(runnable).toMatchObject({
        code: "dispatched",
        claim: { runId: "run-runnable" },
      });

      const continuation = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 7_235_000,
        continuationPollIntervalMs: 15_000,
        dispatch: recorder.dispatch,
        now: () => NOW + 31_000,
      });
      expect(continuation).toMatchObject({
        code: "dispatched",
        claim: { runId: "run-continuation" },
      });
    } finally {
      db.close();
    }
  });

  it("polls multiple active SDK continuations in least-recently-polled order", () => {
    const db = openDb(makeTempDir());
    try {
      for (const runId of ["run-a", "run-b"]) {
        seedRegisteredSdkContinuation(db, runId, "implementation");
        seedLease(db, {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "scheduler-1",
          acquiredAt: NOW,
          heartbeatAt: NOW,
          expiresAt: NOW + 60_000,
        });
      }
      const recorder = recordingDispatch();
      const first = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        continuationPollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
        dispatch: recorder.dispatch,
        now: () => NOW + 2_000,
      });
      const second = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        continuationPollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
        dispatch: recorder.dispatch,
        now: () => NOW + 4_000,
      });
      expect(first).toMatchObject({
        code: "dispatched",
        claim: { runId: "run-a" },
      });
      expect(second).toMatchObject({
        code: "dispatched",
        claim: { runId: "run-b" },
      });
    } finally {
      db.close();
    }
  });

  it("reports a persisted continuation wait separately from true idle", () => {
    const db = openDb(makeTempDir());
    try {
      seedCheckpointedDelegateHandoff(db, "run-continuation", "implementation");
      seedLease(db, {
        runId: "run-continuation",
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "scheduler-1",
        acquiredAt: NOW,
        heartbeatAt: NOW,
        expiresAt: NOW + DEFAULT_WORKFLOW_DISPATCH_LEASE_MS,
      });

      expect(
        runWorkflowSchedulerOnce({
          db,
          workerId: "scheduler-1",
          dispatch: recordingDispatch().dispatch,
          now: () => NOW + 1,
        }),
      ).toMatchObject({ code: "idle", continuationPending: true });
    } finally {
      db.close();
    }
  });

  it("heartbeats the dispatch lease for the complete async dispatch", async () => {
    vi.useFakeTimers();
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-async", state: "approved" });
      seedStep(db, {
        runId: "run-async",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      let now = NOW;
      let finishDispatch!: (result: WorkflowStepDispatchResult) => void;
      const pending = runWorkflowSchedulerOnceAsync({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 90,
        now: () => now,
        dispatch: () =>
          new Promise((resolve) => {
            finishDispatch = resolve;
          }),
      });

      now = NOW + 31;
      await vi.advanceTimersByTimeAsync(31);
      expect(
        getWorkflowLease(db, "run-async", WORKFLOW_DISPATCH_LEASE_KIND)
          ?.heartbeatAt,
      ).toBe(NOW + 31);
      finishDispatch({ status: "dispatched" });
      await expect(pending).resolves.toMatchObject({ code: "dispatched" });
    } finally {
      db.close();
    }
  });

  it("accepts a completed async dispatch after its lease row is reused", async () => {
    vi.useFakeTimers();
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-async-reused", state: "approved" });
      seedStep(db, {
        runId: "run-async-reused",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      let now = NOW;
      let finishDispatch!: (result: WorkflowStepDispatchResult) => void;
      const pending = runWorkflowSchedulerOnceAsync({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 90,
        now: () => now,
        dispatch: () => {
          db.prepare(
            "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_id = ?",
          ).run("run-async-reused", "preflight");
          db.prepare(
            "UPDATE workflow_leases SET holder = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, released_at = NULL WHERE run_id = ? AND lease_kind = ?",
          ).run(
            "scheduler-2",
            NOW + 1,
            NOW + 1,
            NOW + 91,
            "run-async-reused",
            WORKFLOW_DISPATCH_LEASE_KIND,
          );
          return new Promise((resolve) => {
            finishDispatch = resolve;
          });
        },
      });

      now = NOW + 31;
      await vi.advanceTimersByTimeAsync(31);
      finishDispatch({ status: "dispatched" });
      await expect(pending).resolves.toMatchObject({ code: "dispatched" });
    } finally {
      db.close();
    }
  });

  it("rejects a retryable async dispatch after its lease row is reused", async () => {
    vi.useFakeTimers();
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-async-retryable", state: "approved" });
      seedStep(db, {
        runId: "run-async-retryable",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      let now = NOW;
      let finishDispatch!: (result: WorkflowStepDispatchResult) => void;
      const pending = runWorkflowSchedulerOnceAsync({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 90,
        now: () => now,
        dispatch: () => {
          db.prepare(
            "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
          ).run("run-async-retryable", "preflight");
          db.prepare(
            "UPDATE workflow_leases SET holder = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, released_at = NULL WHERE run_id = ? AND lease_kind = ?",
          ).run(
            "scheduler-2",
            NOW + 1,
            NOW + 1,
            NOW + 91,
            "run-async-retryable",
            WORKFLOW_DISPATCH_LEASE_KIND,
          );
          return new Promise((resolve) => {
            finishDispatch = resolve;
          });
        },
      });

      now = NOW + 31;
      await vi.advanceTimersByTimeAsync(31);
      finishDispatch({ status: "dispatched" });
      await expect(pending).rejects.toThrow(/lease.*was lost/);
    } finally {
      db.close();
    }
  });

  it("revalidates an async dispatch lease before accepting its result", async () => {
    vi.useFakeTimers();
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-async-final-check", state: "approved" });
      seedStep(db, {
        runId: "run-async-final-check",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      let now = NOW;
      let finishDispatch!: (result: WorkflowStepDispatchResult) => void;
      const pending = runWorkflowSchedulerOnceAsync({
        db,
        workerId: "scheduler-1",
        leaseDurationMs: 90,
        now: () => now,
        dispatch: () =>
          new Promise((resolve) => {
            finishDispatch = resolve;
          }),
      });

      now = NOW + 100;
      db.prepare(
        "UPDATE workflow_leases SET holder = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE run_id = ? AND lease_kind = ?",
      ).run(
        "scheduler-2",
        now,
        now,
        now + 90,
        "run-async-final-check",
        WORKFLOW_DISPATCH_LEASE_KIND,
      );
      finishDispatch({ status: "dispatched" });

      await expect(pending).rejects.toThrow(/lease.*was lost/);
    } finally {
      db.close();
    }
  });

  it("is idle and does not dispatch when no workflow work is runnable", () => {
    const db = openDb(makeTempDir());
    try {
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
      });

      expect(result).toEqual({
        code: "idle",
        workerId: "scheduler-1",
        recovery: { recovered: [], skipped: [] },
      });
      expect(recorder.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("claims the first runnable step and hands it to the dispatcher", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved", repoPath: "/repos/a" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedStep(db, {
        runId: "run-a",
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.claim).toMatchObject({
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        stepOrder: 0,
        required: true,
        repoPath: "/repos/a",
        runState: "approved",
      });
      expect(result.dispatch).toEqual({ status: "dispatched" });
      expect(result.recovery).toEqual({ recovered: [], skipped: [] });

      // The dispatcher saw the claim and the tick context.
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim.stepId).toBe("preflight");
      expect(recorder.calls[0]?.context).toEqual({
        db,
        workerId: "scheduler-1",
        now: NOW,
      });

      // The dispatch lease is durable and left held for the dispatcher to own.
      const lease = getWorkflowLease(db, "run-a", WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.holder).toBe("scheduler-1");
      expect(lease?.releasedAt).toBeNull();
      expect(lease?.expiresAt).toBe(NOW + DEFAULT_WORKFLOW_DISPATCH_LEASE_MS);
    } finally {
      db.close();
    }
  });

  it("resumes an unclassified delegate handoff after its checkpoint is durable", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "checkpointed-delegate-handoff";
      const stepId = "implementation";
      seedCheckpointedDelegateHandoff(db, runId, stepId);
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.recovery.recovered).toEqual([
        {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
      expect(result.claim.lease.holder).toBe("scheduler-1");
    } finally {
      db.close();
    }
  });

  it.each([1, 2] as const)(
    "resumes delegate attempt %s after a crash before its first round",
    (attempt) => {
      const db = openDb(makeTempDir());
      try {
        const runId = `delegate-before-round-attempt-${attempt}`;
        const stepId = "implementation";
        seedDelegateBeforeCurrentAttemptRound(db, runId, stepId, attempt);
        seedLease(db, {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          expiresAt: NOW,
        });
        const recorder = recordingDispatch();

        const result = runWorkflowSchedulerOnce({
          db,
          workerId: "scheduler-1",
          dispatch: recorder.dispatch,
          now: () => NOW + 1,
        });

        expect(result).toMatchObject({
          code: "dispatched",
          claim: { runId, stepId },
        });
        expect(recorder.calls).toHaveLength(1);
        expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
          needsManualRecovery: false,
        });
      } finally {
        db.close();
      }
    },
  );

  it("does not treat an empty legacy retry attempt as an SDK continuation", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "legacy-delegate-before-retry-round";
      const stepId = "implementation";
      seedDelegateBeforeCurrentAttemptRound(db, runId, stepId, 2);
      db.prepare(
        "UPDATE executor_rounds SET round_index = 1 WHERE workflow_run_id = ?",
      ).run(runId);
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("idle");
      expect(recorder.calls).toHaveLength(0);
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: true,
      });
    } finally {
      db.close();
    }
  });

  it("resumes an interrupted durable legacy-completion replay", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "interrupted-legacy-completion-replay";
      const stepId = "implementation";
      seedRun(db, { runId, state: "running", repoPath: "/repos/fixture" });
      seedStep(db, {
        runId,
        stepId,
        kind: "implementation",
        state: "running",
        order: 0,
      });
      const invocationId = deriveDispatchInvocationId(runId, stepId);
      insertExecutorInvocation(
        db,
        {
          invocationId,
          workflowRunId: runId,
          stepRunId: stepId,
          stepKey: stepId,
          executorFamily: "delegate-supervisor",
          state: "running",
          attempt: 1,
          startedAt: NOW,
          heartbeatAt: NOW,
          finishedAt: null,
        },
        { now: NOW },
      );
      const envelope = createDurableExecutorEnvelope({
        db,
        invocationId,
        now: () => NOW,
      });
      const sourceRoundId = `${invocationId}::round-1`;
      envelope.facade.startRound({
        roundId: sourceRoundId,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 1,
        roundIndex: 0,
        state: "running",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "legacy completion",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      envelope.facade.recordCheckpoint(sourceRoundId, {
        checkpointId: `${sourceRoundId}-mechanism-completed`,
        sequence: 0,
        stage: "mechanism_completed",
        detail: JSON.stringify({
          recommendation: "complete",
          recommendedRoundState: "succeeded",
          recommendedInvocationState: "succeeded",
          recoveryCode: null,
          humanGate: null,
          reason: "legacy wrapper completed cleanly",
        }),
      });
      updateExecutorRound(db, sourceRoundId, {
        toState: "capturing_result",
      });
      updateExecutorRound(db, sourceRoundId, {
        toState: "succeeded",
        classification: "complete",
        executorRecommendation: "complete",
        recoveryCode: null,
        humanGate: null,
        finishedAt: NOW,
      });
      db.prepare(
        `UPDATE executor_invocations
            SET attempt = 2, state = 'running', finished_at = NULL
          WHERE invocation_id = ?`,
      ).run(invocationId);
      const replayRoundId = `${invocationId}::round-2`;
      envelope.facade.startRound({
        roundId: replayRoundId,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 2,
        roundIndex: 1,
        state: "capturing_result",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "replaying legacy completion",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      envelope.facade.recordCheckpoint(replayRoundId, {
        checkpointId: `${replayRoundId}-legacy-completion-replayed`,
        sequence: 0,
        stage: DELEGATE_SUPERVISOR_LEGACY_COMPLETION_REPLAYED_STAGE,
        detail: JSON.stringify({ sourceRoundId }),
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result).toMatchObject({
        code: "dispatched",
        claim: { runId, stepId },
      });
      expect(recorder.calls).toHaveLength(1);
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: false,
      });
    } finally {
      db.close();
    }
  });

  it("does not reuse delegate handoff evidence from an earlier attempt", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "delegate-prior-attempt-handoff";
      const stepId = "implementation";
      const { envelope, invocationId, roundId } =
        seedCheckpointedDelegateHandoff(
          db,
          runId,
          stepId,
          DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
        );
      updateExecutorRound(db, roundId, {
        toState: "succeeded",
        classification: "complete",
        executorRecommendation: "complete",
        recoveryCode: null,
        humanGate: null,
        finishedAt: NOW,
      });
      db.prepare(
        `UPDATE executor_invocations
            SET attempt = 2, state = 'running', finished_at = NULL
          WHERE invocation_id = ?`,
      ).run(invocationId);
      envelope.facade.startRound({
        roundId: `${invocationId}::round-2`,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 2,
        roundIndex: 1,
        state: "capturing_result",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "current attempt has no durable handoff",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("idle");
      expect(recorder.calls).toHaveLength(0);
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: true,
      });
    } finally {
      db.close();
    }
  });

  it("resumes a stale generic registered SDK continuation", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "stale-generic-sdk-continuation";
      const stepId = "implementation";
      seedRegisteredSdkContinuation(db, runId, stepId);
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        acquiredAt: NOW - 1_000,
        heartbeatAt: NOW - 1_000,
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result).toMatchObject({
        code: "dispatched",
        claim: { runId, stepId },
      });
      expect(recorder.calls).toHaveLength(1);
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: false,
      });
    } finally {
      db.close();
    }
  });

  it("resumes an unclassified delegate gate observation", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "unclassified-delegate-gate";
      const stepId = "implementation";
      const { envelope, invocationId, roundId } =
        seedCheckpointedDelegateHandoff(db, runId, stepId);
      envelope.applyDaemonDecision(
        {
          roundId,
          classification: "continue",
          executorRecommendation: "continue",
          roundState: "succeeded",
          invocationState: "running",
          recoveryCode: null,
          humanGate: null,
        },
        {
          allocateClassificationCheckpointIdentity: true,
          classificationCheckpoint: {
            stage: "classified",
            detail: "classification: continue",
          },
        },
      );
      const gateRoundId = `${invocationId}::round-2`;
      envelope.facade.startRound({
        roundId: gateRoundId,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 1,
        roundIndex: 1,
        state: "mirroring_external_state",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "Mirrored delegated gate evidence",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      envelope.facade.recordDecision(gateRoundId, {
        decisionId: `${gateRoundId}::decision`,
        summary: "Approve delegated completion",
        allowedActions: ["approve", "reject"],
        recommendedAction: "approve",
        chosenAction: null,
        resolution: null,
        externalRef: null,
      });
      envelope.facade.recordCheckpoint(gateRoundId, {
        checkpointId: `${gateRoundId}::mirrored`,
        sequence: 0,
        stage: DELEGATE_SUPERVISOR_MIRRORED_STAGE,
        detail: "{}",
      });
      envelope.facade.observeRound(gateRoundId, {
        phase: "waiting_operator",
        summary: "Delegated completion requires approval",
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: false,
      });
    } finally {
      db.close();
    }
  });

  it("resumes an interrupted delegate handoff after its intent is durable", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "checkpointed-delegate-intent";
      const stepId = "implementation";
      seedCheckpointedDelegateHandoff(
        db,
        runId,
        stepId,
        DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
      );
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.recovery.recovered).toEqual([
        {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
      expect(recorder.calls[0]?.context.staleDispatchTakeover).toEqual({
        previousHolder: "daemon-old",
        previousAcquiredAt: NOW - 60_000,
        previousExpiresAt: NOW,
      });
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: false,
      });
    } finally {
      db.close();
    }
  });

  it("propagates stale takeover proof when the lease holder string is reused", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "same-holder-delegate-takeover";
      const stepId = "implementation";
      seedCheckpointedDelegateHandoff(
        db,
        runId,
        stepId,
        DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
      );
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "scheduler-1",
        acquiredAt: NOW - 60_000,
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      expect(recorder.calls[0]?.context.staleDispatchTakeover).toEqual({
        previousHolder: "scheduler-1",
        previousAcquiredAt: NOW - 60_000,
        previousExpiresAt: NOW,
      });
    } finally {
      db.close();
    }
  });

  it("propagates stale takeover proof after recovery and redispatch occur in separate scheduler ticks", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "restart-boundary-delegate-takeover";
      seedCheckpointedDelegateHandoff(
        db,
        runId,
        "implementation",
        DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
      );
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        acquiredAt: NOW - 60_000,
        expiresAt: NOW,
      });

      expect(recoverStaleWorkflowLeases(db, { now: NOW + 1 })).toMatchObject({
        recovered: [{ runId, action: "released" }],
      });

      const recorder = recordingDispatch();
      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-after-restart",
        dispatch: recorder.dispatch,
        now: () => NOW + 2,
      });

      expect(result).toMatchObject({ code: "dispatched", claim: { runId } });
      expect(recorder.calls[0]?.context.staleDispatchTakeover).toEqual({
        previousHolder: "daemon-old",
        previousAcquiredAt: NOW - 60_000,
        previousExpiresAt: NOW,
      });
    } finally {
      db.close();
    }
  });

  it("recreates a durable SDK gate after a stale dispatch crash", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "waiting-operator-gate-recovery";
      const stepId = "implementation";
      const { envelope, invocationId, roundId } =
        seedCheckpointedDelegateHandoff(db, runId, stepId);
      const decisionId = `${roundId}::decision`;
      envelope.facade.recordDecision(roundId, {
        decisionId,
        summary: "Approve delegated completion",
        allowedActions: ["approve", "reject"],
        recommendedAction: "approve",
        chosenAction: null,
        resolution: null,
        externalRef: null,
      });
      envelope.facade.recordCheckpoint(roundId, {
        checkpointId: `${roundId}::gate-selector`,
        sequence: 1,
        stage: EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE,
        detail: JSON.stringify({ decisionId }),
      });
      envelope.applyDaemonDecision(
        {
          roundId,
          classification: "approval_required",
          executorRecommendation: "approval_required",
          roundState: "waiting_operator",
          invocationState: "waiting_operator",
          recoveryCode: null,
          humanGate: "approval_required",
        },
        {
          allocateClassificationCheckpointIdentity: true,
          classificationCheckpoint: {
            stage: "classified",
            detail: "classification: approval_required",
          },
        },
      );
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });

      const recovery = recoverStaleWorkflowLeases(db, { now: NOW + 1 });

      expect(recovery.recovered).toEqual([
        {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT invocation_id, round_id, evidence, resolved_at FROM workflow_gates WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({
        invocation_id: invocationId,
        round_id: roundId,
        evidence: decisionId,
        resolved_at: null,
      });
      expect(
        getWorkflowLease(db, runId, WORKFLOW_DISPATCH_LEASE_KIND),
      ).toMatchObject({ releasedAt: NOW + 1 });
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: false,
      });
    } finally {
      db.close();
    }
  });

  it("resumes an interrupted delegate poll from a prior durable handoff", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "interrupted-delegate-poll";
      const stepId = "implementation";
      const { envelope, invocationId, roundId } =
        seedCheckpointedDelegateHandoff(db, runId, stepId);
      updateExecutorRound(db, roundId, {
        toState: "succeeded",
        classification: "continue",
        executorRecommendation: "continue",
        finishedAt: NOW,
      });
      envelope.facade.startRound({
        roundId: `${invocationId}::round-2`,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 1,
        roundIndex: 1,
        state: "mirroring_external_state",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "Reading delegated external state.",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.recovery.recovered).toEqual([
        {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
      expect(result.claim.lease.holder).toBe("scheduler-1");
    } finally {
      db.close();
    }
  });

  it("resumes a completed delegate handoff", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "completed-delegate-handoff";
      const stepId = "implementation";
      const { roundId } = seedCheckpointedDelegateHandoff(db, runId, stepId);
      updateExecutorRound(db, roundId, {
        toState: "succeeded",
        classification: "continue",
        executorRecommendation: "continue",
        finishedAt: NOW,
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
    } finally {
      db.close();
    }
  });

  it("resumes a completed delegate poll from a prior durable handoff", () => {
    const db = openDb(makeTempDir());
    try {
      const runId = "completed-delegate-poll";
      const stepId = "implementation";
      const { envelope, invocationId, roundId } =
        seedCheckpointedDelegateHandoff(db, runId, stepId);
      updateExecutorRound(db, roundId, {
        toState: "succeeded",
        classification: "continue",
        executorRecommendation: "continue",
        finishedAt: NOW,
      });
      const pollRoundId = `${invocationId}::round-2`;
      envelope.facade.startRound({
        roundId: pollRoundId,
        invocationId,
        workflowRunId: runId,
        stepRunId: stepId,
        stepKey: stepId,
        executorFamily: "delegate-supervisor",
        attempt: 1,
        roundIndex: 1,
        state: "mirroring_external_state",
        agentProvider: null,
        model: null,
        effort: null,
        inputDigest: null,
        resultDigest: null,
        artifactRoot: null,
        logPaths: [],
        summary: "Reading delegated external state.",
        keyChanges: [],
        keyLearnings: [],
        remainingWork: [],
        changedFiles: [],
        verificationStatus: null,
        commitSha: null,
      });
      updateExecutorRound(db, pollRoundId, {
        toState: "succeeded",
        classification: "continue",
        executorRecommendation: "continue",
        finishedAt: NOW,
      });
      seedLease(db, {
        runId,
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        holder: "daemon-old",
        expiresAt: NOW,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 1,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.recovery.recovered).toEqual([
        {
          runId,
          leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
          holder: "daemon-old",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]?.claim).toMatchObject({ runId, stepId });
      expect(result.claim.lease.holder).toBe("scheduler-1");
    } finally {
      db.close();
    }
  });

  it("recovers a stale auto-release lease and then dispatches the freed step in the same tick", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      // A dead worker's stale auto-release lease withholds the run until it is
      // recovered; the tick must recover before it scans.
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "auto-release",
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.recovery.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          stalePolicy: "auto-release",
          action: "released",
          recoveryStatus: WORKFLOW_LEASE_AUTO_RELEASED_STATUS,
        },
      ]);
      expect(result.claim.stepId).toBe("preflight");
      expect(recorder.calls).toHaveLength(1);

      // The stale lease was released and a fresh dispatch lease was taken.
      expect(getWorkflowLease(db, "run-a", "managed-step")?.releasedAt).toBe(
        NOW,
      );
      expect(
        getWorkflowLease(db, "run-a", WORKFLOW_DISPATCH_LEASE_KIND)?.holder,
      ).toBe("scheduler-1");
    } finally {
      db.close();
    }
  });

  it("flags a stale manual-recovery lease and stays idle without dispatching", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "running" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedLease(db, {
        runId: "run-a",
        leaseKind: "managed-step",
        expiresAt: NOW - 10_000,
        stalePolicy: "manual-recovery-required",
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
      });

      expect(result.code).toBe("idle");
      if (result.code !== "idle") throw new Error("expected idle");
      expect(result.recovery.recovered).toEqual([
        {
          runId: "run-a",
          leaseKind: "managed-step",
          holder: "worker-1",
          stalePolicy: "manual-recovery-required",
          action: "flagged_manual_recovery",
          recoveryStatus: WORKFLOW_LEASE_MANUAL_RECOVERY_STATUS,
        },
      ]);
      expect(recorder.calls).toHaveLength(0);

      // The run is parked for manual recovery and its lease left as evidence.
      expect(
        getWorkflowRunManualRecoveryState(db, "run-a")?.needsManualRecovery,
      ).toBe(true);
      expect(
        getWorkflowLease(db, "run-a", "managed-step")?.releasedAt,
      ).toBeNull();
      expect(
        getWorkflowLease(db, "run-a", WORKFLOW_DISPATCH_LEASE_KIND),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("dispatches the oldest eligible run first", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, {
        runId: "run-late",
        state: "approved",
        createdAt: NOW + 100,
      });
      seedStep(db, {
        runId: "run-late",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      seedRun(db, { runId: "run-early", state: "approved", createdAt: NOW });
      seedStep(db, {
        runId: "run-early",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW + 200,
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.claim.runId).toBe("run-early");
      // Only one step is claimed per tick; the late run waits for a later tick.
      expect(recorder.calls).toHaveLength(1);
      expect(
        getWorkflowLease(db, "run-late", WORKFLOW_DISPATCH_LEASE_KIND),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("returns claim_contended and does not dispatch when the claim loses a race", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const recorder = recordingDispatch();
      const existing: WorkflowLeaseRecord = {
        runId: "run-a",
        leaseKind: "managed-step",
        holder: "worker-2",
        acquiredAt: NOW - 1_000,
        expiresAt: NOW + 10_000,
        heartbeatAt: NOW - 1_000,
        releasedAt: null,
        stalePolicy: "auto-release",
      };

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
        deps: {
          // Simulate another worker winning the lease between scan and claim.
          claimStep: () => ({ ok: false, reason: "lease_held", existing }),
        },
      });

      expect(result).toEqual({
        code: "claim_contended",
        workerId: "scheduler-1",
        recovery: { recovered: [], skipped: [] },
        claimResult: { ok: false, reason: "lease_held", existing },
      });
      expect(recorder.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("releases the acquired dispatch lease and rethrows when the dispatcher throws", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const boom = new Error("dispatcher exploded");
      const dispatch: WorkflowStepDispatch = () => {
        throw boom;
      };

      expect(() =>
        runWorkflowSchedulerOnce({
          db,
          workerId: "scheduler-1",
          dispatch,
          now: () => NOW,
        }),
      ).toThrow(boom);

      // The claim is not stranded: the dispatch lease this tick acquired is
      // released so the next pass can re-claim it.
      const lease = getWorkflowLease(db, "run-a", WORKFLOW_DISPATCH_LEASE_KIND);
      expect(lease?.releasedAt).toBe(NOW);
    } finally {
      db.close();
    }
  });

  it("acquires the dispatch lease with the configured duration and stale policy", () => {
    const db = openDb(makeTempDir());
    try {
      seedRun(db, { runId: "run-a", state: "approved" });
      seedStep(db, {
        runId: "run-a",
        stepId: "preflight",
        kind: "preflight",
        state: "approved",
        order: 0,
      });
      const recorder = recordingDispatch();

      const result = runWorkflowSchedulerOnce({
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
        leaseDurationMs: 45_000,
        stalePolicy: "manual-recovery-required",
      });

      expect(result.code).toBe("dispatched");
      if (result.code !== "dispatched") throw new Error("expected dispatch");
      expect(result.claim.lease).toMatchObject({
        leaseKind: WORKFLOW_DISPATCH_LEASE_KIND,
        expiresAt: NOW + 45_000,
        stalePolicy: "manual-recovery-required",
      });
      expect(
        getWorkflowLease(db, "run-a", WORKFLOW_DISPATCH_LEASE_KIND)
          ?.stalePolicy,
      ).toBe("manual-recovery-required");
    } finally {
      db.close();
    }
  });

  it("validates its inputs", () => {
    const db = openDb(makeTempDir());
    try {
      const recorder = recordingDispatch();
      const base = {
        db,
        workerId: "scheduler-1",
        dispatch: recorder.dispatch,
        now: () => NOW,
      };
      expect(() => runWorkflowSchedulerOnce({ ...base, workerId: "" })).toThrow(
        /workerId is required/,
      );
      expect(() =>
        runWorkflowSchedulerOnce({ ...base, leaseDurationMs: 0 }),
      ).toThrow(/leaseDurationMs must be a positive finite number/);
      expect(() =>
        runWorkflowSchedulerOnce({ ...base, leaseDurationMs: -5 }),
      ).toThrow(/leaseDurationMs must be a positive finite number/);
      expect(() =>
        runWorkflowSchedulerOnce({
          ...base,
          dispatch: undefined as unknown as WorkflowStepDispatch,
        }),
      ).toThrow(/dispatch is required/);
    } finally {
      db.close();
    }
  });
});
