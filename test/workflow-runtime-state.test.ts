import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  loadWorkflowRuntimeStateRows,
  refreshWorkflowRunRuntimeState
} from "../src/core/workflow/runtime-state.js";
import type {
  WorkflowLeaseKind,
  WorkflowLeaseStalePolicy,
  WorkflowStepKind,
  WorkflowStepState
} from "../src/core/workflow/run-reducer.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-runtime-state-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openSeededDb(runId = "runtime-state-run"): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(runId, "workflow-first", 1_700_000_000_000, 1_700_000_000_000);
  return db;
}

function seedStep(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    state: WorkflowStepState;
    order: number;
    kind?: WorkflowStepKind;
    required?: boolean;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.stepId,
    input.kind ?? "implementation",
    input.state,
    input.order,
    (input.required ?? true) ? 1 : 0,
    1_700_000_000_000,
    1_700_000_000_000
  );
}

function seedLease(
  db: MomentumDb,
  input: {
    runId: string;
    leaseKind: WorkflowLeaseKind;
    holder: string;
    acquiredAt: number;
    expiresAt: number;
    heartbeatAt?: number;
    releasedAt?: number | null;
    stalePolicy?: WorkflowLeaseStalePolicy;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_leases (
       run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
       released_at, stale_policy, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.leaseKind,
    input.holder,
    input.acquiredAt,
    input.expiresAt,
    input.heartbeatAt ?? input.acquiredAt,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    input.acquiredAt,
    input.acquiredAt
  );
}

function readRun(
  db: MomentumDb,
  runId: string
): {
  state: string;
  started_at: number | null;
  finished_at: number | null;
  monitor_last_seen_state: string | null;
  monitor_terminal: number | null;
  monitor_step: string | null;
  updated_at: number;
} {
  return db
    .prepare(
      `SELECT state, started_at, finished_at, monitor_last_seen_state,
              monitor_terminal, monitor_step, updated_at
         FROM workflow_runs
        WHERE id = ?`
    )
    .get(runId) as {
    state: string;
    started_at: number | null;
    finished_at: number | null;
    monitor_last_seen_state: string | null;
    monitor_terminal: number | null;
    monitor_step: string | null;
    updated_at: number;
  };
}

describe("workflow runtime-state seam", () => {
  it("loads reducer rows for status and recovery callers from one workflow-owned interface", () => {
    const runId = "runtime-state-load";
    const db = openSeededDb(runId);
    try {
      seedStep(db, { runId, stepId: "preflight", state: "running", order: 1 });
      seedStep(db, { runId, stepId: "implementation", state: "pending", order: 2 });
      seedLease(db, {
        runId,
        leaseKind: "dispatch",
        holder: "worker-1",
        acquiredAt: 5_000,
        expiresAt: 15_000
      });

      const rows = loadWorkflowRuntimeStateRows(db, runId);

      expect(rows.steps.map((step) => [step.stepId, step.state])).toEqual([
        ["preflight", "running"],
        ["implementation", "pending"]
      ]);
      expect(rows.leases).toMatchObject([
        {
          runId,
          leaseKind: "dispatch",
          holder: "worker-1",
          acquiredAt: 5_000,
          expiresAt: 15_000,
          releasedAt: null
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("refreshes run status and monitor advisory after dispatch start while coalescing started_at", () => {
    const runId = "runtime-state-dispatch";
    const db = openSeededDb(runId);
    try {
      seedStep(db, { runId, stepId: "preflight", state: "running", order: 1 });
      seedStep(db, { runId, stepId: "implementation", state: "pending", order: 2 });
      seedLease(db, {
        runId,
        leaseKind: "dispatch",
        holder: "worker-1",
        acquiredAt: 5_000,
        expiresAt: 15_000
      });

      const monitor = refreshWorkflowRunRuntimeState(db, {
        runId,
        now: 6_000,
        startedAt: "coalesce-now"
      });

      expect(monitor.runState).toBe("running");
      expect(monitor.activeStep?.stepId).toBe("preflight");
      expect(readRun(db, runId)).toMatchObject({
        state: "running",
        started_at: 6_000,
        finished_at: null,
        monitor_last_seen_state: "running",
        monitor_terminal: 0,
        monitor_step: "preflight",
        updated_at: 6_000
      });
    } finally {
      db.close();
    }
  });

  it("refreshes terminal run status after step finalization without rewriting started_at", () => {
    const runId = "runtime-state-terminal";
    const db = openSeededDb(runId);
    try {
      db.prepare("UPDATE workflow_runs SET started_at = ? WHERE id = ?").run(
        4_000,
        runId
      );
      seedStep(db, { runId, stepId: "preflight", state: "succeeded", order: 1 });
      seedStep(db, {
        runId,
        stepId: "implementation",
        state: "succeeded",
        order: 2
      });

      const monitor = refreshWorkflowRunRuntimeState(db, {
        runId,
        now: 8_000
      });

      expect(monitor.runState).toBe("succeeded");
      expect(monitor.terminal).toBe(true);
      expect(readRun(db, runId)).toMatchObject({
        state: "succeeded",
        started_at: 4_000,
        finished_at: 8_000,
        monitor_last_seen_state: "succeeded",
        monitor_terminal: 1,
        monitor_step: null,
        updated_at: 8_000
      });
    } finally {
      db.close();
    }
  });
});
