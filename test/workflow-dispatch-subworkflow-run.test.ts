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
  type ClaimedWorkflowStep,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  loadExecutorAttempt,
  listExecutorRoundsForAttempt,
} from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch,
} from "../src/core/workflow/dispatch/execute.js";
import { WORKFLOW_RECONCILE_RESULT_STATUS } from "../src/core/workflow/dispatch/reconcile-execute.js";
import { WORKFLOW_EXECUTE_RECONCILE_STATUS } from "../src/core/workflow/dispatch/executor-recovery.js";
import {
  executeAndReconcileDispatchedSubworkflowStep,
  type SubworkflowChildObservation,
} from "../src/core/workflow/dispatch/subworkflow-run.js";
import type { WorkflowRunState } from "../src/core/workflow/run/reducer.js";

/**
 * NGX-497 (RC-4) — the async run-path producer that makes the `subworkflow`
 * executor family daemon-dispatchable: it starts or attaches to a child workflow
 * run (through an injected runner, so the daemon lane owns the start/attach and
 * there is no ad hoc parallel runtime here), observes the child run's terminal
 * classification, maps it into executor evidence via the landed pure
 * {@link planSubworkflowChildMirror}, and — only for a terminal child — records
 * that evidence on the `<run>::<step>::dispatch` scaffold so the RC-2
 * reconciliation seam finalizes the owning parent step exactly once.
 *
 * These tests pin the producer's contract and the parent/child boundary:
 *   - a non-terminal child run defers: NO terminal evidence is produced and the
 *     parent step is left running for a later tick (never prematurely finalized);
 *   - a clean child terminal mirrors the child's classification — `succeeded`
 *     finalizes the parent succeeded, `failed` finalizes the parent failed (a
 *     child failure is a legitimate mirrored terminal, NOT manual recovery);
 *   - an ambiguous `canceled` / stuck `blocked` child parks the parent for manual
 *     recovery with operator-visible evidence (the fail-closed default for a
 *     recursive run);
 *   - re-entry over an already-terminal dispatch invocation NEVER re-runs the
 *     child runner (no duplicate child run, no second terminalization);
 *   - the defer→mirror progression across ticks finalizes only once the child is
 *     terminal;
 *   - a step with no dispatch scaffold (the M9 direct-finalize lane) is refused
 *     without ever starting a child run.
 *
 * The injected runner is the only child-run path, so no test here drives a real
 * child workflow runtime — the parent step owns dispatch evidence only.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-sub-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const EXECUTE_AT = NOW + 10;
const STEP_ID = "preflight";
const CHILD_RUN_ID = "child-run-xyz";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-sub-run-"): string {
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
  stepId: string,
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
 * Drive a (dispatchable) step through the production base dispatch so it lands
 * `running` with a `<run>::<step>::dispatch` invocation (`running`) + scaffold
 * round (`pending`) and a held dispatch lease — the exact substrate the
 * subworkflow producer runs against. The base dispatcher is still standing in for
 * the family flip, so tests re-stamp the scaffold to `subworkflow` unless they
 * are pinning the family guard.
 */
function dispatchStep(
  db: MomentumDb,
  stepId: string = STEP_ID,
  family: "subworkflow" | "one-shot" = "subworkflow",
): void {
  const claim = approveAndClaim(db, stepId);
  executeWorkflowStepDispatch(claim, {
    db,
    workerId: WORKER,
    now: DISPATCH_AT,
  });
  if (family === "subworkflow") {
    db.prepare(
      "UPDATE executor_attempts SET executor_family = 'subworkflow' WHERE attempt_id = ?",
    ).run(deriveDispatchInvocationId(RUN_ID, stepId));
  }
}

function stepState(db: MomentumDb, stepId: string = STEP_ID): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb, stepId: string = STEP_ID) {
  return listExecutorRoundsForAttempt(
    db,
    deriveDispatchInvocationId(RUN_ID, stepId),
  );
}

function makeWritableEvidence(root = makeTempDir("momentum-sub-evidence-")) {
  return {
    executorLogPath: path.join(root, "nested", "subworkflow.log"),
    resultJsonPath: path.join(root, "nested", "subworkflow.json"),
  };
}

const EVIDENCE = {
  executorLogPath:
    "/repos/momentum/.agent-workflows/run-sub-001/subworkflow.log",
  resultJsonPath:
    "/repos/momentum/.agent-workflows/run-sub-001/subworkflow.json",
} as const;

/**
 * A child runner whose call is counted so a test can prove the child run was
 * started/attached exactly once (or never), and never re-started after the
 * dispatch invocation is terminal. It returns a canned observation rather than
 * driving a real child workflow runtime.
 */
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

/**
 * A child runner that observes a different (start-or-attach idempotent) child
 * state on each tick, modelling a child run that progresses from in-flight to a
 * terminal classification while the parent step is re-checked across ticks.
 */
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

function observe(childState: WorkflowRunState): SubworkflowChildObservation {
  return { childRunId: CHILD_RUN_ID, childState };
}

describe("executeAndReconcileDispatchedSubworkflowStep — defer (child in flight)", () => {
  it.each<WorkflowRunState>(["pending", "approved", "running"])(
    "leaves the parent step running and produces no terminal evidence while the child is %s",
    async (childState) => {
      const db = openSeededDb();
      dispatchStep(db);
      const evidence = makeWritableEvidence();
      const runner = countingChildRunner(observe(childState));

      const out = await executeAndReconcileDispatchedSubworkflowStep({
        db,
        runId: RUN_ID,
        stepId: STEP_ID,
        runSubworkflowChild: runner.run,
        evidence,
        now: EXECUTE_AT,
      });

      expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred);
      expect(runner.calls()).toBe(1);
      // No terminal evidence: the dispatch invocation + step stay running and the
      // dispatch lease stays held for a later tick to re-check the child.
      expect(
        loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
          ?.state,
      ).toBe("running");
      expect(stepState(db)).toBe("running");
      expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
      // The scaffold round is untouched (still pending); nothing was terminalized.
      expect(dispatchRounds(db)[0]?.state).toBe("pending");
      expect(out.detail).toContain(CHILD_RUN_ID);
    },
  );
});

describe("executeAndReconcileDispatchedSubworkflowStep — clean terminal mirror", () => {
  it("mirrors a succeeded child into a clean succeeded parent terminal via RC-2", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner(observe("succeeded"));

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(runner.calls()).toBe(1);
    expect(out.executorResult?.ok).toBe(true);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized,
    );

    const invocation = loadExecutorAttempt(
      db,
      deriveDispatchInvocationId(RUN_ID, STEP_ID),
    );
    expect(invocation?.state).toBe("succeeded");
    const rounds = dispatchRounds(db);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.state).toBe("succeeded");
    expect(rounds[0]?.summary).toContain(CHILD_RUN_ID);
    expect(rounds[0]?.logPaths).toEqual([
      evidence.executorLogPath,
      evidence.resultJsonPath,
    ]);
    // The child run id is the durable digest tying the evidence to the child run.
    expect(rounds[0]?.resultDigest).toBe(CHILD_RUN_ID);

    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("mirrors a failed child into a clean failed parent terminal, not manual recovery", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner(observe("failed"));

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(out.executorResult?.ok).toBe(true);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized,
    );

    expect(
      loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state,
    ).toBe("failed");
    expect(dispatchRounds(db)[0]?.state).toBe("failed");
    // A child failure is a legitimate mirrored terminal — the run is NOT parked
    // for manual recovery.
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(false);
    expect(stepState(db)).toBe("failed");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("writes durable child-observation evidence files before recording their paths", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner(observe("succeeded"));

    await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(fs.existsSync(evidence.executorLogPath)).toBe(true);
    expect(fs.existsSync(evidence.resultJsonPath)).toBe(true);
    expect(fs.readFileSync(evidence.executorLogPath, "utf8")).toContain(
      CHILD_RUN_ID,
    );
    const snapshot = JSON.parse(
      fs.readFileSync(evidence.resultJsonPath, "utf8"),
    ) as SubworkflowChildObservation;
    expect(snapshot.childRunId).toBe(CHILD_RUN_ID);
    expect(snapshot.childState).toBe("succeeded");
  });
});

describe("executeAndReconcileDispatchedSubworkflowStep — fail-closed child terminal", () => {
  it("parks the parent for manual recovery when an in-flight child is already marked for manual recovery", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner({
      ...observe("running"),
      childNeedsManualRecovery: true,
      childManualRecoveryReason: "child run blocked on recovery gate",
    });

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(out.executorResult?.ok).toBe(false);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery,
    );
    expect(
      loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state,
    ).toBe("manual_recovery_required");
    expect(dispatchRounds(db)[0]?.summary).toContain(
      "child run blocked on recovery gate",
    );
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db)).toBe("running");
  });

  it.each<{ childState: WorkflowRunState; marker: string }>([
    { childState: "canceled", marker: "canceled" },
    { childState: "blocked", marker: "blocked" },
  ])(
    "parks the parent for manual recovery when the child is $childState",
    async ({ childState, marker }) => {
      const db = openSeededDb();
      dispatchStep(db);
      const evidence = makeWritableEvidence();
      const runner = countingChildRunner(observe(childState));

      const out = await executeAndReconcileDispatchedSubworkflowStep({
        db,
        runId: RUN_ID,
        stepId: STEP_ID,
        runSubworkflowChild: runner.run,
        evidence,
        now: EXECUTE_AT,
      });

      expect(out.status).toBe(
        WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
      );
      expect(out.executorResult?.ok).toBe(false);
      expect(out.reconcile?.status).toBe(
        WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery,
      );

      const invocation = loadExecutorAttempt(
        db,
        deriveDispatchInvocationId(RUN_ID, STEP_ID),
      );
      expect(invocation?.state).toBe("manual_recovery_required");
      const round = dispatchRounds(db)[0];
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.summary).toContain(marker);

      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
      ).toBe(true);
      // The parent step is parked, not fabricated terminal: it stays running with
      // an operator-visible recovery gate.
      expect(stepState(db)).toBe("running");
      const gates = listWorkflowGatesForRun(db, RUN_ID);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        gateType: "manual_recovery_required",
        stepRunId: STEP_ID,
      });
    },
  );
});

describe("executeAndReconcileDispatchedSubworkflowStep — idempotent re-entry", () => {
  it("never re-starts the child run once the dispatch invocation is terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner(observe("succeeded"));

    const first = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    expect(first.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(runner.calls()).toBe(1);

    const second = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 100,
    });
    expect(second.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
    );
    // The child run is never re-started; the finalization converges idempotently.
    expect(runner.calls()).toBe(1);
    expect(second.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
    );
    expect(dispatchRounds(db)).toHaveLength(1);
    expect(stepState(db)).toBe("succeeded");
  });

  it("defers across ticks while the child is in flight, then mirrors its terminal exactly once", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    // The child is observed `running` on the first two ticks, then `succeeded`.
    const runner = sequencedChildRunner(["running", "running", "succeeded"]);

    const tick1 = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    expect(tick1.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred);
    expect(stepState(db)).toBe("running");

    const tick2 = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 50,
    });
    expect(tick2.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred);
    expect(stepState(db)).toBe("running");

    const tick3 = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 100,
    });
    expect(tick3.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );

    // The child runner was consulted on every non-terminal tick (start-or-attach
    // idempotency lives in the runner), but the parent finalized exactly once.
    expect(runner.calls()).toBe(3);
    expect(dispatchRounds(db)).toHaveLength(1);
    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });
});

describe("executeAndReconcileDispatchedSubworkflowStep — reconcile deferral", () => {
  it("keeps the dispatch lease held when reconciliation throws after evidence is recorded", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingChildRunner(observe("succeeded"));
    db.exec(`
      CREATE TRIGGER test_block_reconcile_sub
      BEFORE UPDATE OF state ON workflow_steps
      WHEN NEW.run_id = '${RUN_ID}' AND NEW.step_id = '${STEP_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'reconcile blocked');
      END;
    `);

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
    );
    expect(out.reconcile).toBeUndefined();
    expect(out.terminalize?.status).toBe("terminalize_recorded");
    // The child terminal is recorded as evidence; the step stays running with the
    // lease held so a later tick re-drives only the reconciliation.
    expect(
      loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state,
    ).toBe("succeeded");
    expect(stepState(db)).toBe("running");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
  });
});

describe("executeAndReconcileDispatchedSubworkflowStep — M9 lane boundary", () => {
  it("refuses a step with no dispatch invocation and never starts a child run", async () => {
    const db = openSeededDb();
    // No dispatch: an M9 direct-finalize / never-dispatched step writes no
    // executor invocation, so the producer must refuse it untouched.
    const runner = countingChildRunner(observe("succeeded"));

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence: EVIDENCE,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched);
    expect(runner.calls()).toBe(0);
    expect(
      loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID)),
    ).toBeUndefined();
    expect(stepState(db)).toBe("pending");
  });

  it("refuses a non-subworkflow dispatch scaffold and never starts a child run", async () => {
    const db = openSeededDb();
    dispatchStep(db, STEP_ID, "one-shot");
    const runner = countingChildRunner(observe("succeeded"));

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence: makeWritableEvidence(),
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched);
    expect(out.detail).toContain("one-shot");
    expect(runner.calls()).toBe(0);
    expect(
      loadExecutorAttempt(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state,
    ).toBe("running");
    expect(stepState(db)).toBe("running");
  });
});
