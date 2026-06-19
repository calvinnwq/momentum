import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition-persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run-start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep
} from "../src/core/workflow/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate-persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run-recovery.js";
import {
  finishWorkflowStep,
  getWorkflowStep,
  startWorkflowStep
} from "../src/core/workflow/step-transitions.js";
import {
  loadExecutorInvocation,
  updateExecutorInvocationState
} from "../src/core/executors/loop-persist.js";
import type { ExecutorInvocationState } from "../src/core/executors/loop-reducer.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch-execute.js";
import {
  reconcileDispatchedWorkflowStep,
  WORKFLOW_RECONCILE_RESULT_STATUS
} from "../src/core/workflow/dispatch-reconcile-execute.js";

/**
 * RC-2 (NGX-480) production reconciliation effect twin.
 *
 * `reconcileDispatchedWorkflowStep` is the single production seam that finalizes
 * an M10 dispatched workflow step from its `<run>::<step>::dispatch` invocation's
 * terminal executor evidence — the production replacement for the dogfood
 * terminalize stand-in. These tests drive a step through the REAL production
 * dispatch (`executeWorkflowStepDispatch`), drive the dispatch invocation to a
 * terminal executor state, and assert the reconciliation seam finalizes the step
 * exactly once, idempotently, releasing the dispatch lease and refreshing cached
 * run state — and that it never touches a step it does not own (the M9
 * direct-finalize lane, which writes no `::dispatch` invocation).
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-reconcile-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const TERMINAL_AT = NOW + 2;
const RECONCILE_AT = NOW + 3;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-reconcile-exec-")
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
    objective: "Dogfood NGX-480",
    now: NOW
  });
  return db;
}

/** Approve + claim a step through the real scheduler claim path. */
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
  if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
  return claim.claim;
}

/**
 * Drive a step through the production dispatch lane so it lands `running` with a
 * `<run>::<step>::dispatch` invocation (`running`) and a held dispatch lease,
 * exactly as the daemon workflow lane leaves it before the executor terminates.
 */
function dispatchStep(
  db: MomentumDb,
  stepId: string,
  runId: string = RUN_ID
): void {
  const claim = approveAndClaim(db, stepId, runId);
  executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: DISPATCH_AT });
}

function dispatchInvocationId(stepId: string, runId: string = RUN_ID): string {
  return `${runId}::${stepId}::dispatch`;
}

/** Drive the dispatch invocation to a terminal executor-invocation state. */
function driveInvocationTerminal(
  db: MomentumDb,
  stepId: string,
  state: ExecutorInvocationState,
  runId: string = RUN_ID
): void {
  updateExecutorInvocationState(db, dispatchInvocationId(stepId, runId), state, {
    now: TERMINAL_AT,
    finishedAt: TERMINAL_AT
  });
}

function stepRow(
  db: MomentumDb,
  stepId: string,
  runId: string = RUN_ID
): { state: string; finishedAt: number | null; resultDigest: string | null } {
  const row = getWorkflowStep(db, runId, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return {
    state: row.state,
    finishedAt: row.finishedAt,
    resultDigest: row.resultDigest
  };
}

function countInvocations(db: MomentumDb, runId: string = RUN_ID): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM executor_invocations WHERE workflow_run_id = ?"
    )
    .get(runId) as { n: number };
  return row.n;
}

function runUpdatedAt(db: MomentumDb, runId: string = RUN_ID): number {
  const row = db
    .prepare("SELECT updated_at FROM workflow_runs WHERE id = ?")
    .get(runId) as { updated_at: number };
  return row.updated_at;
}

describe("reconcileDispatchedWorkflowStep — finalizes from terminal evidence", () => {
  const CLEAN: ReadonlyArray<[ExecutorInvocationState, string]> = [
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "canceled"]
  ];

  for (const [invocationState, stepState] of CLEAN) {
    it(`finalizes the step ${stepState} from a terminal ${invocationState} invocation`, () => {
      const db = openSeededDb();
      dispatchStep(db, "preflight");
      driveInvocationTerminal(db, "preflight", invocationState);

      const result = reconcileDispatchedWorkflowStep({
        db,
        runId: RUN_ID,
        stepId: "preflight",
        now: RECONCILE_AT
      });

      expect(result.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.finalized);

      // The owning workflow step reached the matching terminal exactly once.
      const step = stepRow(db, "preflight");
      expect(step.state).toBe(stepState);
      expect(step.finishedAt).toBe(RECONCILE_AT);
      // A reconciliation marker records that the production seam closed the step.
      expect(step.resultDigest).toContain("rc2-reconcile");

      // The dispatch lease is released (the bounded session is terminal).
      expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();

      // Cached run state was refreshed through the ARCH-08 runtime-state seam.
      expect(runUpdatedAt(db)).toBe(RECONCILE_AT);

      // The seam reads executor evidence but never writes executor rows — the
      // dispatch invocation is left in its terminal state, unchanged.
      expect(countInvocations(db)).toBe(1);
      expect(loadExecutorInvocation(db, dispatchInvocationId("preflight"))?.state).toBe(
        invocationState
      );
    });
  }
});

describe("reconcileDispatchedWorkflowStep — defers while non-terminal", () => {
  it("leaves a running step running and holds the dispatch lease", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    // Invocation left `running` (the bounded executor session is still active).

    const result = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });

    expect(result.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.deferred);
    expect(stepRow(db, "preflight").state).toBe("running");
    // The dispatch lease is still held: nothing terminalized, nothing released.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
    ).toBe(false);
  });
});

describe("reconcileDispatchedWorkflowStep — routes unclean terminals to manual recovery", () => {
  const UNCLEAN: ReadonlyArray<ExecutorInvocationState> = [
    "blocked",
    "manual_recovery_required"
  ];

  for (const invocationState of UNCLEAN) {
    it(`parks the run for manual recovery on a terminal ${invocationState} invocation`, () => {
      const db = openSeededDb();
      dispatchStep(db, "preflight");
      driveInvocationTerminal(db, "preflight", invocationState);

      const result = reconcileDispatchedWorkflowStep({
        db,
        runId: RUN_ID,
        stepId: "preflight",
        now: RECONCILE_AT
      });

      expect(result.status).toBe(
        WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery
      );

      // The run is durably parked, not finalized to a clean step terminal.
      const recovery = getWorkflowRunManualRecoveryState(db, RUN_ID);
      expect(recovery?.needsManualRecovery).toBe(true);
      // The step is NOT moved to a clean terminal — it stays running for the
      // operator to inspect; the seam never fabricates succeeded/failed.
      expect(stepRow(db, "preflight").state).toBe("running");

      // An operator-visible manual-recovery gate hangs from the step.
      const gates = listWorkflowGatesForRun(db, RUN_ID);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        gateType: "manual_recovery_required",
        targetScope: "step",
        stepRunId: "preflight",
        evidence: invocationState,
        resolvedAt: null
      });

      // The dispatch lease is released so the run is not held busy.
      expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    });
  }
});

describe("reconcileDispatchedWorkflowStep — idempotency", () => {
  it("does not double-finalize or duplicate writes on re-entry", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    driveInvocationTerminal(db, "preflight", "succeeded");

    const first = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    expect(first.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.finalized);
    const afterFirst = stepRow(db, "preflight");

    const second = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT + 100
    });
    // A re-entry recognises the already-terminal step and makes no second
    // finalization — the immutable terminal record (state + finished_at + digest)
    // is preserved byte-for-byte.
    expect(second.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized
    );
    const afterSecond = stepRow(db, "preflight");
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.finishedAt).toBe(RECONCILE_AT);
  });

  it("does not open a duplicate manual-recovery gate on re-entry", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    driveInvocationTerminal(db, "preflight", "blocked");

    reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    const second = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT + 100
    });

    expect(second.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery);
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(1);
  });
});

describe("reconcileDispatchedWorkflowStep — M9 / M10 boundary", () => {
  it("refuses a step with no dispatch invocation (the M9 direct-finalize lane)", () => {
    const db = openSeededDb();
    // M9 live wrappers own the full lifecycle directly: startWorkflowStep ->
    // finishWorkflowStep, writing ZERO executor invocation/round rows.
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?"
    ).run(RUN_ID, "preflight");
    startWorkflowStep(db, { runId: RUN_ID, stepId: "preflight", now: NOW + 1 });
    finishWorkflowStep(db, {
      runId: RUN_ID,
      stepId: "preflight",
      state: "succeeded",
      now: NOW + 2
    });
    expect(countInvocations(db)).toBe(0);

    const result = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });

    // The reconciliation seam owns ONLY dispatched steps, keyed on the
    // deterministic `::dispatch` id. With no such invocation it refuses and
    // writes nothing — so M9 direct-finalize and M10 reconciliation can never
    // both finalize the same step.
    expect(result.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.notDispatched);
    expect(stepRow(db, "preflight").state).toBe("succeeded");
    expect(countInvocations(db)).toBe(0);
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
    ).toBe(false);
  });

  it("never overrides an existing terminal result (terminal immutability)", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    // The dispatch invocation reports a clean `succeeded`...
    driveInvocationTerminal(db, "preflight", "succeeded");
    // ...but the step was already moved to a DIFFERENT terminal (e.g. an operator
    // cancel) out of band before reconciliation runs.
    finishWorkflowStep(db, {
      runId: RUN_ID,
      stepId: "preflight",
      state: "canceled",
      now: NOW + 2
    });

    const result = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });

    // The immutable terminal result is preserved; reconciliation does not
    // re-finalize a canceled step to succeeded.
    expect(result.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized
    );
    expect(stepRow(db, "preflight").state).toBe("canceled");
    // The held dispatch lease is still converged to released so the run is not
    // stranded busy on an already-terminal step.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });
});
