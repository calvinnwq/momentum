import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  runWorkflowSchedulerOnceAsync,
  type AsyncWorkflowStepDispatch,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatchContext,
  type WorkflowStepDispatchResult,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import { loadExecutorAttempt } from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchAttemptId,
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS,
} from "../src/core/workflow/dispatch/execute.js";
import {
  createSubworkflowWorkflowDispatch,
  type DispatchedSubworkflowContextResolution,
} from "../src/core/workflow/dispatch/subworkflow-dispatch.js";
import type { SubworkflowChildObservation } from "../src/core/workflow/dispatch/subworkflow-run.js";
import type { WorkflowRunState } from "../src/core/workflow/run/reducer.js";

/**
 * NGX-497 (RC-4) — the daemon-lane *entry point* that composes the landed
 * subworkflow producer ({@link executeAndReconcileDispatchedSubworkflowStep})
 * behind the production base dispatch, the async sibling of
 * `external-apply-dispatch.ts`'s `createExternalApplyWorkflowDispatch`.
 *
 * These tests pin the factory's composition contract — *not* the producer (that
 * is exhaustively covered in `workflow-dispatch-subworkflow-run.test.ts`):
 *   - it runs the subworkflow producer only for a `subworkflow`-family dispatch
 *     attempt; any other family (the live-wrapper / external-apply lanes own
 *     those) is echoed through untouched;
 *   - it only acts on a base dispatch that genuinely started a scaffold
 *     (the shared dispatch-status predicate); a fail-closed base result is echoed
 *     through without deriving a child runner;
 *   - a refused context derivation parks the parent for manual recovery (the
 *     fail-closed-on-missing-child-config path) instead of throwing and stranding
 *     the lease;
 *   - a thrown derivation is trapped into the same manual-recovery park;
 *   - it returns the base dispatch's result verbatim (finalization is a durable
 *     side effect layered after the dispatch).
 *
 * These factory tests drive a canned base dispatch that re-stamps the attempt
 * family to `subworkflow` to isolate the wrapper's branching from the base
 * dispatcher. RC-4b (NGX-498) has since flipped `subworkflow` into
 * `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES` so the real base dispatch creates that
 * same row directly; the end-to-end production-flip proof lives in
 * `test/workflow-dispatch-subworkflow-flip.test.ts`.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-subdisp-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const STEP_ID = "preflight";
const CHILD_RUN_ID = "child-run-abc";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-subdisp-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    objective: "Dogfood NGX-497",
    now: NOW,
  });
  return db;
}

function approveAndClaim(
  db: MomentumDb,
  stepId: string = STEP_ID,
  runId: string = RUN_ID,
): ClaimedWorkflowStep {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
  ).run(runId, stepId);
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
  return claim.claim;
}

/**
 * A base dispatch that creates the genuine production one-shot scaffold (running
 * attempt + pending round + held lease + running step) and then re-stamps the
 * attempt family to `subworkflow` — standing in for the PHASE1-wired base
 * dispatch that will create a `subworkflow` scaffold directly once the family
 * flip lands. The factory keys its gate on this family.
 */
function subworkflowScaffoldBaseDispatch(): AsyncWorkflowStepDispatch {
  return (claim, context) => {
    const result = executeWorkflowStepDispatch(claim, context);
    context.db
      .prepare(
        "UPDATE executor_attempts SET executor_family = 'subworkflow' WHERE attempt_id = ?",
      )
      .run(deriveDispatchAttemptId(claim.runId, claim.stepId, 1));
    return result;
  };
}

function stepState(db: MomentumDb, stepId: string = STEP_ID): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

function stepStateForRun(
  db: MomentumDb,
  runId: string,
  stepId: string = STEP_ID,
): string {
  const row = getWorkflowStep(db, runId, stepId);
  if (!row) throw new Error(`step ${runId}/${stepId} not found`);
  return row.state;
}

function attemptState(db: MomentumDb): string | undefined {
  return loadExecutorAttempt(db, deriveDispatchAttemptId(RUN_ID, STEP_ID, 1))
    ?.state;
}

function makeWritableEvidence(
  root = makeTempDir("momentum-subdisp-evidence-"),
) {
  return {
    executorLogPath: path.join(root, "nested", "subworkflow.log"),
    resultJsonPath: path.join(root, "nested", "subworkflow.json"),
  };
}

function observe(childState: WorkflowRunState): SubworkflowChildObservation {
  return { childRunId: CHILD_RUN_ID, childState };
}

/** A child runner whose call count proves whether the producer ran. */
function countingChildRunner(observation: SubworkflowChildObservation): {
  run: () => Promise<SubworkflowChildObservation>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return observation;
    },
    calls: () => calls,
  };
}

function sequencedChildRunner(
  states: readonly WorkflowRunState[],
  childRunId = CHILD_RUN_ID,
): {
  run: () => Promise<SubworkflowChildObservation>;
  calls: () => number;
} {
  let index = 0;
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      const childState = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return { childRunId, childState };
    },
    calls: () => calls,
  };
}

const context = (db: MomentumDb): WorkflowStepDispatchContext => ({
  db,
  workerId: WORKER,
  now: DISPATCH_AT,
});

describe("createSubworkflowWorkflowDispatch — family gate", () => {
  it("echoes a non-subworkflow (one-shot) attempt through without running the producer", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const runner = countingChildRunner(observe("succeeded"));
    let derives = 0;
    const dispatch = createSubworkflowWorkflowDispatch(
      // The real base dispatch leaves a genuine `one-shot` scaffold.
      executeWorkflowStepDispatch,
      {
        deriveSubworkflow: () => {
          derives += 1;
          return {
            ok: true,
            runSubworkflowChild: runner.run,
            evidence: makeWritableEvidence(),
          };
        },
      },
    );

    const result = await dispatch(claim, context(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    // The subworkflow lane is not this step's owner: neither the child runner nor
    // even the context deriver is consulted.
    expect(derives).toBe(0);
    expect(runner.calls()).toBe(0);
    expect(
      loadExecutorAttempt(db, deriveDispatchAttemptId(RUN_ID, STEP_ID, 1))
        ?.executorFamily,
    ).toBe("one-shot");
  });
});

describe("createSubworkflowWorkflowDispatch — runs the producer for subworkflow", () => {
  it("mirrors a succeeded child into a clean succeeded parent terminal", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const runner = countingChildRunner(observe("succeeded"));
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => ({
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        }),
      },
    );

    const result = await dispatch(claim, context(db));

    // The factory returns the base dispatch result verbatim; finalization is a
    // durable side effect layered after it.
    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(runner.calls()).toBe(1);
    expect(attemptState(db)).toBe("succeeded");
    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("defers an in-flight child: no terminal evidence, lease held, parent running", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const runner = countingChildRunner(observe("running"));
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => ({
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        }),
      },
    );

    await dispatch(claim, context(db));

    expect(runner.calls()).toBe(1);
    expect(attemptState(db)).toBe("running");
    expect(stepState(db)).toBe("running");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
  });

  it("scheduler rechecks a deferred subworkflow dispatch and heartbeats its lease", async () => {
    const db = openSeededDb();
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run(RUN_ID, STEP_ID);
    const runner = sequencedChildRunner(["running", "running", "succeeded"]);
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => ({
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        }),
      },
    );
    const leaseDurationMs = 5_000;

    const tick1 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: WORKER,
      dispatch,
      leaseDurationMs,
      now: () => NOW,
    });
    expect(tick1.code).toBe("dispatched");
    expect(runner.calls()).toBe(1);
    expect(stepState(db)).toBe("running");

    const tick2Now = NOW + 3_000;
    const tick2 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: WORKER,
      dispatch,
      leaseDurationMs,
      now: () => tick2Now,
    });
    expect(tick2.code).toBe("dispatched");
    if (tick2.code === "dispatched") {
      expect(tick2.dispatch.status).toBe(
        WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
      );
    }
    expect(runner.calls()).toBe(2);
    const refreshedLease = getWorkflowLease(db, RUN_ID, "dispatch");
    expect(refreshedLease?.expiresAt).toBe(tick2Now + leaseDurationMs);
    expect(refreshedLease?.releasedAt).toBeNull();
    expect(stepState(db)).toBe("running");

    const tick3 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: WORKER,
      dispatch,
      leaseDurationMs,
      now: () => tick2Now + 3_000,
    });
    expect(tick3.code).toBe("dispatched");
    expect(runner.calls()).toBe(3);
    expect(attemptState(db)).toBe("succeeded");
    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("does not recheck a fresh deferred subworkflow before the heartbeat cadence when other work is runnable", async () => {
    const db = openSeededDb();
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run(RUN_ID, STEP_ID);
    const runner = sequencedChildRunner(["running", "succeeded"]);
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => ({
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        }),
      },
    );
    const leaseDurationMs = 5_000;

    const tick1 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: WORKER,
      dispatch,
      leaseDurationMs,
      now: () => NOW,
    });
    expect(tick1.code).toBe("dispatched");
    expect(runner.calls()).toBe(1);

    const otherRunId = "run-subdisp-other";
    persistWorkflowRunStart(db, {
      definition: CODING_WORKFLOW_DEFINITION,
      runId: otherRunId,
      repoPath: "/repos/momentum",
      objective: "Other runnable workflow",
      now: NOW + 10,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run(otherRunId, STEP_ID);

    const otherDispatchCalls: ClaimedWorkflowStep[] = [];
    const tick2 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: WORKER,
      dispatch: (claim) => {
        otherDispatchCalls.push(claim);
        return { status: "other_dispatched" };
      },
      leaseDurationMs,
      now: () => NOW + 1_000,
    });

    expect(tick2.code).toBe("dispatched");
    if (tick2.code !== "dispatched") throw new Error("expected dispatch");
    expect(tick2.claim.runId).toBe(otherRunId);
    expect(otherDispatchCalls.map((claim) => claim.runId)).toEqual([
      otherRunId,
    ]);
    expect(runner.calls()).toBe(1);
    expect(stepState(db)).toBe("running");
    expect(stepStateForRun(db, otherRunId)).toBe("approved");
  });

  it("reattaches a deferred subworkflow after a daemon restart instead of parking the parent", async () => {
    const db = openSeededDb();
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run(RUN_ID, STEP_ID);
    const runner = sequencedChildRunner(["running", "running"]);
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => ({
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        }),
      },
    );
    const leaseDurationMs = 5_000;

    const tick1 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "daemon-old",
      dispatch,
      leaseDurationMs,
      now: () => NOW,
    });
    expect(tick1.code).toBe("dispatched");
    expect(runner.calls()).toBe(1);

    const tick2 = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "daemon-new",
      dispatch,
      leaseDurationMs,
      now: () => NOW + leaseDurationMs + 1,
    });

    expect(tick2.code).toBe("dispatched");
    if (tick2.code !== "dispatched") throw new Error("expected dispatch");
    expect(tick2.claim.runId).toBe(RUN_ID);
    expect(tick2.claim.lease.holder).toBe("daemon-new");
    expect(tick2.claim.lease.expiresAt).toBe(
      NOW + leaseDurationMs + 1 + leaseDurationMs,
    );
    expect(runner.calls()).toBe(2);
    expect(stepState(db)).toBe("running");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(false);
  });
});

describe("createSubworkflowWorkflowDispatch — fail-closed context", () => {
  it("parks the parent for manual recovery when the child context cannot be derived", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const resolution: DispatchedSubworkflowContextResolution = {
      ok: false,
      reason: "child_definition_missing",
    };
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      { deriveSubworkflow: () => resolution },
    );

    await dispatch(claim, context(db));

    expect(attemptState(db)).toBe("manual_recovery_required");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    // The parent step is parked (still running) with an operator-visible gate,
    // not fabricated terminal.
    expect(stepState(db)).toBe("running");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: STEP_ID,
    });
  });

  it("traps a thrown derivation into the same manual-recovery park", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const dispatch = createSubworkflowWorkflowDispatch(
      subworkflowScaffoldBaseDispatch(),
      {
        deriveSubworkflow: () => {
          throw new Error("boom resolving child run");
        },
      },
    );

    await dispatch(claim, context(db));

    expect(attemptState(db)).toBe("manual_recovery_required");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db)).toBe("running");
  });
});

describe("createSubworkflowWorkflowDispatch — not-startable base dispatch", () => {
  it("echoes a fail-closed base result without deriving a child runner", async () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db);
    const runner = countingChildRunner(observe("succeeded"));
    let derives = 0;
    const failClosedBase: AsyncWorkflowStepDispatch =
      (): WorkflowStepDispatchResult => ({
        status: WORKFLOW_DISPATCH_RESULT_STATUS.failClosed,
      });
    const dispatch = createSubworkflowWorkflowDispatch(failClosedBase, {
      deriveSubworkflow: () => {
        derives += 1;
        return {
          ok: true,
          runSubworkflowChild: runner.run,
          evidence: makeWritableEvidence(),
        };
      },
    });

    const result = await dispatch(claim, context(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    // A fail-closed base dispatch already parked/released the claim; the factory
    // never derives a child runner or touches the run.
    expect(derives).toBe(0);
    expect(runner.calls()).toBe(0);
  });
});
