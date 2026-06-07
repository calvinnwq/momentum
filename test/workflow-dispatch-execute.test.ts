import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/workflow-definition.js";
import { persistWorkflowDefinition } from "../src/workflow-definition-persist.js";
import { persistWorkflowRunStart } from "../src/workflow-run-start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatch
} from "../src/workflow-scheduler.js";
import { getWorkflowLease } from "../src/workflow-leases.js";
import { listWorkflowGatesForRun } from "../src/workflow-gate-persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/workflow-run-recovery.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS
} from "../src/workflow-dispatch-execute.js";

const NOW = 1_700_000_000_000;
const RUN_ID = "run-dispatch-exec-001";
const WORKER = "worker-1";

// Compile-time guard: the dispatcher must satisfy the scheduler's executor seam
// so the bounded `daemon start` lane can pass it straight through (no injection).
const _seamCheck: WorkflowStepDispatch = executeWorkflowStepDispatch;
void _seamCheck;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-dispatch-exec-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/** Open a migrated DB seeded exactly as the CLI `workflow run start` leaves it. */
function openSeededDb(runId: string = RUN_ID): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-367",
    now: NOW
  });
  return db;
}

/**
 * Approve the target step (the operator-approval boundary is exercised
 * elsewhere) and claim it through the real scheduler claim path, so the
 * dispatcher receives a genuine {@link ClaimedWorkflowStep} holding a real
 * `dispatch` lease.
 */
function approveAndClaim(
  db: MomentumDb,
  stepId: string,
  runId: string = RUN_ID
): ClaimedWorkflowStep {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?"
  ).run(runId, stepId);
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW
  });
  if (!claim.ok) {
    throw new Error(`test setup: claim failed (${claim.reason})`);
  }
  return claim.claim;
}

function countInvocations(db: MomentumDb, runId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM executor_invocations WHERE workflow_run_id = ?"
    )
    .get(runId) as { n: number };
  return row.n;
}

function stepState(db: MomentumDb, runId: string, stepId: string): string {
  const row = db
    .prepare(
      "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
    )
    .get(runId, stepId) as { state: string };
  return row.state;
}

describe("executeWorkflowStepDispatch — supported family", () => {
  it("creates the executor invocation + round scaffold and advances the step", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);

    // A durable invocation row proves the bounded unit started through the
    // production path (preflight resolves to the one-shot family).
    const invocation = db
      .prepare(
        `SELECT invocation_id, step_run_id, step_key, executor_family, state, attempt
           FROM executor_invocations WHERE workflow_run_id = ?`
      )
      .get(RUN_ID) as {
      invocation_id: string;
      step_run_id: string;
      step_key: string;
      executor_family: string;
      state: string;
      attempt: number;
    };
    expect(invocation).toMatchObject({
      step_run_id: "preflight",
      step_key: "preflight",
      executor_family: "one-shot",
      state: "running",
      attempt: 1
    });

    // The first round scaffold exists, created before external work runs.
    const round = db
      .prepare(
        `SELECT invocation_id, round_index, state, executor_family
           FROM executor_rounds WHERE workflow_run_id = ?`
      )
      .get(RUN_ID) as {
      invocation_id: string;
      round_index: number;
      state: string;
      executor_family: string;
    };
    expect(round.invocation_id).toBe(invocation.invocation_id);
    expect(round.executor_family).toBe("one-shot");
    expect(round.state).toBe("pending");

    // The step advanced approved -> running so the lane will not re-offer it.
    expect(stepState(db, RUN_ID, "preflight")).toBe("running");
  });

  it("holds the dispatch lease on a successful dispatch (owns the lifecycle)", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });

    const lease = getWorkflowLease(db, RUN_ID, "dispatch");
    expect(lease).toBeDefined();
    expect(lease?.releasedAt).toBeNull();
  });

  it("is idempotent: a second dispatch of the same claim creates no duplicate rows", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });
    const second = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 2
    });

    expect(second.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
    );
    expect(countInvocations(db, RUN_ID)).toBe(1);
    const rounds = db
      .prepare(
        "SELECT COUNT(*) AS n FROM executor_rounds WHERE workflow_run_id = ?"
      )
      .get(RUN_ID) as { n: number };
    expect(rounds.n).toBe(1);
  });
});

describe("executeWorkflowStepDispatch — fail closed", () => {
  it("routes an unsupported resolved family to a durable manual-recovery gate", () => {
    const db = openSeededDb();
    // Force preflight to resolve to a family with no landed daemon adapter.
    db.prepare(
      `UPDATE step_definitions SET executor = 'external-apply'
         WHERE definition_key = ? AND definition_version = ? AND step_key = ?`
    ).run(
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "preflight"
    );
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);

    // An open, operator-visible manual-recovery gate hangs from the step.
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      targetScope: "step",
      stepRunId: "preflight",
      resolvedAt: null
    });
    expect(gates[0]?.reason).toContain("external-apply");

    // The run is durably parked for manual recovery.
    const recovery = getWorkflowRunManualRecoveryState(db, RUN_ID);
    expect(recovery?.needsManualRecovery).toBe(true);

    // The dispatch lease is released, not stranded.
    const lease = getWorkflowLease(db, RUN_ID, "dispatch");
    expect(lease?.releasedAt).not.toBeNull();

    // No executor rows were created and the step was not advanced.
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "preflight")).toBe("approved");
  });

  it("routes a resolution failure (definition unlinked) to manual recovery", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // The run advanced past resolvable state between claim and dispatch.
    db.prepare(
      `UPDATE workflow_runs
         SET workflow_definition_key = NULL, workflow_definition_version = NULL
       WHERE id = ?`
    ).run(RUN_ID);

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.gateType).toBe("manual_recovery_required");
    expect(getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery).toBe(
      true
    );
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
  });
});

describe("executeWorkflowStepDispatch — safety", () => {
  it("does not strand a lease or create rows when the step cannot be started", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // Another worker advanced the step out of `approved` between claim and
    // dispatch: the dispatcher must not create a half scaffold.
    db.prepare(
      "UPDATE workflow_steps SET state = 'running' WHERE run_id = ? AND step_id = ?"
    ).run(RUN_ID, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1
    });

    expect(result.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable
    );
    expect(countInvocations(db, RUN_ID)).toBe(0);
    // The dispatch lease is released so the run is not held busy on a no-op.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });
});
