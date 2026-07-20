import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import {
  persistWorkflowRunStart,
  WorkflowRunStartConflictError,
} from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import {
  getWorkflowRunManualRecoveryState,
  markWorkflowRunNeedsManualRecovery,
} from "../src/core/workflow/run/recovery.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  listExecutorRoundsForAttempt,
  loadExecutorAttempt,
} from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchAttemptId,
  executeWorkflowStepDispatch,
} from "../src/core/workflow/dispatch/execute.js";
import { WORKFLOW_RECONCILE_RESULT_STATUS } from "../src/core/workflow/dispatch/reconcile-execute.js";
import { WORKFLOW_EXECUTE_RECONCILE_STATUS } from "../src/core/workflow/dispatch/executor-recovery.js";
import {
  executeAndReconcileDispatchedSubworkflowStep,
  type DispatchedSubworkflowChildRunner,
} from "../src/core/workflow/dispatch/subworkflow-run.js";
import { loadWorkflowRunDetail } from "../src/core/workflow/run/status.js";
import type { WorkflowRunState } from "../src/core/workflow/run/reducer.js";

/**
 * NGX-497 (RC-4) — integration proof binding the daemon-dispatchable
 * `subworkflow` producer to a *real* child workflow run started and observed
 * through the existing workflow-owned seams.
 *
 * Iterations 1-3 proved the pure mapping (against hand-built `WorkflowRunState`
 * inputs), the async producer (against a *canned* injected runner), and the
 * entry-point factory. None drove a real child workflow runtime — the producer
 * unit suite's own header notes "no test here drives a real child workflow
 * runtime." That is the same gap RC-3 closed for `external-apply` by binding its
 * producer to the genuine M6 write path (`workflow-dispatch-external-apply-m6`);
 * this file is the `subworkflow` analogue.
 *
 * Here the injected {@link DispatchedSubworkflowChildRunner} is a *real*
 * start-or-attach runner built from the run-start seam
 * ({@link persistWorkflowRunStart}) and the status read-back seam
 * ({@link loadWorkflowRunDetail}): it durably starts (or, on a re-check, attaches
 * to) the SAME child workflow run in the parent's database and observes that
 * child run's real {@link WorkflowRunState}. No ad hoc parallel runtime is
 * invented — the child is a first-class `workflow_runs` row distinct from the
 * parent, exactly as the ownership boundary requires.
 *
 * Acceptance criteria exercised here:
 *   - "The adapter starts or attaches to the intended child workflow run using
 *     existing workflow-owned seams, not a parallel ad hoc runtime" — the runner
 *     creates a real child `workflow_runs` row through `persistWorkflowRunStart`
 *     and reads its state through `loadWorkflowRunDetail`.
 *   - "Parent step finalization happens only from durable terminal child evidence
 *     via the RC-2 reconciliation path" — the parent finalizes only after the
 *     real child run reaches a terminal state, never while it is in flight.
 *   - "Re-running the daemon path ... is idempotent and does not duplicate child
 *     runs or double-finalize the parent step" — the deterministic child run id
 *     makes a re-check attach (via the run-start conflict guard) instead of
 *     starting a second child, and a terminal dispatch attempt is never
 *     re-run.
 *   - "Missing/unsafe/ambiguous configuration still fails closed" — a real child
 *     run reaching an ambiguous `canceled` terminal parks the parent for manual
 *     recovery rather than fabricating a clean terminal.
 *
 * The child run reaching its own terminal state is simulated by writing the
 * durable `workflow_runs.state` column (the child run owns its terminal state;
 * driving its full step/gate lifecycle is covered by the run-lifecycle suites).
 * What is under test is the producer's composition with the real start/observe
 * seams, not the child run's internal scheduler.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-sub-child-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const EXECUTE_AT = NOW + 10;
const STEP_ID = "preflight";
/**
 * The child run id the runner starts-or-attaches to. Deterministic from the
 * parent run + step so every re-check attaches to the SAME child run rather than
 * spawning a duplicate — the start-or-attach idempotency the producer's contract
 * places in the injected runner.
 */
const CHILD_RUN_ID = `${RUN_ID}::${STEP_ID}::child`;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-sub-child-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeWritableEvidence(
  root = makeTempDir("momentum-sub-child-evidence-"),
) {
  return {
    executorLogPath: path.join(root, "nested", "subworkflow.log"),
    resultJsonPath: path.join(root, "nested", "subworkflow.json"),
  };
}

/** Open a migrated DB seeded exactly as the CLI `workflow run start` leaves it. */
function openSeededDb(): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: RUN_ID,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-497 child-run integration",
    now: NOW,
  });
  return db;
}

function approveAndClaim(db: MomentumDb): ClaimedWorkflowStep {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
  ).run(RUN_ID, STEP_ID);
  const claim = claimRunnableWorkflowStep(db, {
    runId: RUN_ID,
    stepId: STEP_ID,
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
  return claim.claim;
}

/**
 * Drive the parent step through the production base dispatch, then re-stamp the
 * scaffold family to `subworkflow`. This proof reuses CODING_WORKFLOW_DEFINITION
 * (whose `preflight` step is `one-shot`), so the re-stamp stands in for a real
 * `subworkflow`-family step; the end-to-end flip on a genuinely `subworkflow`
 * step definition is proven in `test/workflow-dispatch-subworkflow-flip.test.ts`.
 */
function dispatchStep(db: MomentumDb): void {
  const claim = approveAndClaim(db);
  executeWorkflowStepDispatch(claim, {
    db,
    workerId: WORKER,
    now: DISPATCH_AT,
  });
  db.prepare(
    "UPDATE executor_attempts SET executor_family = 'subworkflow' WHERE attempt_id = ?",
  ).run(deriveDispatchAttemptId(RUN_ID, STEP_ID, 1));
}

function stepState(db: MomentumDb): string {
  const row = getWorkflowStep(db, RUN_ID, STEP_ID);
  if (!row) throw new Error(`step ${STEP_ID} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb) {
  return listExecutorRoundsForAttempt(
    db,
    deriveDispatchAttemptId(RUN_ID, STEP_ID, 1),
  );
}

function countRuns(db: MomentumDb): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }
  ).n;
}

/**
 * Simulate the child workflow run reaching its own terminal state. The child run
 * owns its terminal state per the parent/child ownership boundary; here we write
 * the durable `workflow_runs.state` column the child's own finalization would
 * write, so the producer observes it through the real status seam.
 */
function finalizeChildRun(
  db: MomentumDb,
  childRunId: string,
  state: WorkflowRunState,
): void {
  db.prepare(
    "UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?",
  ).run(state, NOW + 5, childRunId);
}

/**
 * A *real* start-or-attach child runner built from the existing workflow-owned
 * seams. Instead of returning a hand-built observation (as the producer unit
 * suite's canned runners do), it durably starts (or, on a re-check, attaches to)
 * the SAME child workflow run in the parent's database via `persistWorkflowRunStart`
 * and observes that child run's real {@link WorkflowRunState} via
 * `loadWorkflowRunDetail`. start-or-attach idempotency is structural: the
 * deterministic child run id makes the second start hit the run-start conflict
 * guard, so the runner attaches rather than creating a duplicate child run —
 * exactly where the producer's contract places that idempotency.
 */
function realChildRunner(
  db: MomentumDb,
  childRunId: string,
  childRepoPath: string,
): {
  run: DispatchedSubworkflowChildRunner;
  starts: () => number;
  attaches: () => number;
} {
  let starts = 0;
  let attaches = 0;
  return {
    run: async () => {
      try {
        persistWorkflowRunStart(db, {
          definition: CODING_WORKFLOW_DEFINITION,
          runId: childRunId,
          repoPath: childRepoPath,
          objective: "RC-4 child workflow run",
          now: NOW,
        });
        starts += 1;
      } catch (error) {
        if (!(error instanceof WorkflowRunStartConflictError)) throw error;
        // The child run already exists: attach to it rather than starting a
        // second one (start-or-attach idempotency through the real run-start
        // conflict guard).
        attaches += 1;
      }
      const detail = loadWorkflowRunDetail(db, childRunId);
      if (detail === null) {
        throw new Error(`child run ${childRunId} not found after start/attach`);
      }
      return {
        childRunId,
        childState: detail.run.state,
        childNeedsManualRecovery: detail.run.needsManualRecovery,
        childManualRecoveryReason: detail.run.manualRecoveryReason,
      };
    },
    starts: () => starts,
    attaches: () => attaches,
  };
}

describe("subworkflow producer × real child run — start-or-attach + defer", () => {
  it("starts a real child workflow run through the run-start seam and defers while it is in flight", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const childRepo = makeTempDir("momentum-sub-child-repo-");
    const runner = realChildRunner(db, CHILD_RUN_ID, childRepo);

    // Before the tick only the parent run exists.
    expect(countRuns(db)).toBe(1);

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred);

    // A REAL child workflow run now exists, started through the run-start seam,
    // and is observable through the status read-back seam as non-terminal.
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(0);
    expect(countRuns(db)).toBe(2);
    const child = loadWorkflowRunDetail(db, CHILD_RUN_ID);
    expect(child?.run.state).toBe("pending");
    expect(child?.steps).toHaveLength(CODING_WORKFLOW_DEFINITION.steps.length);

    // No terminal evidence: the parent dispatch attempt + step stay running and
    // the dispatch lease stays held for a later tick to re-check the child.
    expect(
      loadExecutorAttempt(db, deriveDispatchAttemptId(RUN_ID, STEP_ID, 1))
        ?.state,
    ).toBe("running");
    expect(stepState(db)).toBe("running");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
    expect(dispatchRounds(db)[0]?.state).toBe("pending");
    expect(out.detail).toContain(CHILD_RUN_ID);
  });
});

describe("subworkflow producer × real child run — clean terminal mirror", () => {
  it("attaches to the same child run and mirrors its real succeeded terminal into a clean parent terminal via RC-2", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const childRepo = makeTempDir("momentum-sub-child-repo-");
    const runner = realChildRunner(db, CHILD_RUN_ID, childRepo);

    // Tick 1: the child run is started and is still in flight -> defer.
    const tick1 = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    expect(tick1.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred);
    expect(runner.starts()).toBe(1);

    // The child run reaches its own terminal success.
    finalizeChildRun(db, CHILD_RUN_ID, "succeeded");

    // Tick 2: the producer re-checks the SAME child run through the status seam,
    // observes the real terminal, and mirrors it onto the parent step via RC-2.
    const tick2 = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 50,
    });

    expect(tick2.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(tick2.executorResult?.ok).toBe(true);
    expect(tick2.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized,
    );

    // The child run was started once and attached to once — never duplicated.
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(1);
    expect(countRuns(db)).toBe(2);

    const attempt = loadExecutorAttempt(
      db,
      deriveDispatchAttemptId(RUN_ID, STEP_ID, 1),
    );
    expect(attempt?.state).toBe("succeeded");
    const round = dispatchRounds(db)[0];
    expect(round?.state).toBe("succeeded");
    expect(round?.summary).toContain(CHILD_RUN_ID);
    // The child run id is the durable digest tying the evidence to the child run.
    expect(round?.resultDigest).toBe(CHILD_RUN_ID);
    expect(round?.logPaths).toEqual([
      evidence.executorLogPath,
      evidence.resultJsonPath,
    ]);
    expect(fs.existsSync(evidence.executorLogPath)).toBe(true);
    expect(fs.existsSync(evidence.resultJsonPath)).toBe(true);

    expect(stepState(db)).toBe("succeeded");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(false);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    // Finalizing the parent does not disturb the child run's own terminal state.
    expect(loadWorkflowRunDetail(db, CHILD_RUN_ID)?.run.state).toBe(
      "succeeded",
    );
  });
});

describe("subworkflow producer × real child run — idempotent re-entry", () => {
  it("never re-starts the child run or double-finalizes once the dispatch attempt is terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const childRepo = makeTempDir("momentum-sub-child-repo-");
    const runner = realChildRunner(db, CHILD_RUN_ID, childRepo);

    await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    finalizeChildRun(db, CHILD_RUN_ID, "succeeded");
    const mirrored = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 50,
    });
    expect(mirrored.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(1);

    // Re-entry over the already-terminal dispatch attempt: the runner is NOT
    // consulted again (no duplicate child run), and the step is not re-finalized.
    const reentry = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 100,
    });
    expect(reentry.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
    );
    expect(reentry.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
    );
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(1);
    expect(countRuns(db)).toBe(2);
    expect(dispatchRounds(db)).toHaveLength(1);
    expect(stepState(db)).toBe("succeeded");
  });
});

describe("subworkflow producer × real child run — fail-closed ambiguous terminal", () => {
  it("parks the parent when the real child run is in flight but flagged for manual recovery", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const childRepo = makeTempDir("momentum-sub-child-repo-");
    const runner = realChildRunner(db, CHILD_RUN_ID, childRepo);

    await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    const childRecoveryReason =
      "child run entered recovery while still running";
    const marked = markWorkflowRunNeedsManualRecovery(db, {
      runId: CHILD_RUN_ID,
      reason: childRecoveryReason,
      now: EXECUTE_AT + 25,
    });
    expect(marked.ok).toBe(true);
    db.prepare("UPDATE workflow_runs SET state = 'running' WHERE id = ?").run(
      CHILD_RUN_ID,
    );

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 50,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(out.executorResult?.ok).toBe(false);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery,
    );
    expect(
      loadExecutorAttempt(db, deriveDispatchAttemptId(RUN_ID, STEP_ID, 1))
        ?.state,
    ).toBe("manual_recovery_required");
    expect(dispatchRounds(db)[0]?.summary).toContain(childRecoveryReason);
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db)).toBe("running");
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(1);
    expect(countRuns(db)).toBe(2);
  });

  it("parks the parent for manual recovery when the real child run reaches an ambiguous canceled terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const childRepo = makeTempDir("momentum-sub-child-repo-");
    const runner = realChildRunner(db, CHILD_RUN_ID, childRepo);

    // Tick 1: child started, in flight -> defer.
    await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT,
    });
    // The child run reaches an ambiguous terminal it cannot self-resolve.
    finalizeChildRun(db, CHILD_RUN_ID, "canceled");

    const out = await executeAndReconcileDispatchedSubworkflowStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runSubworkflowChild: runner.run,
      evidence,
      now: EXECUTE_AT + 50,
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(out.executorResult?.ok).toBe(false);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery,
    );

    const attempt = loadExecutorAttempt(
      db,
      deriveDispatchAttemptId(RUN_ID, STEP_ID, 1),
    );
    expect(attempt?.state).toBe("manual_recovery_required");
    const round = dispatchRounds(db)[0];
    expect(round?.state).toBe("manual_recovery_required");
    expect(round?.summary).toContain("canceled");

    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    // The parent step is parked, not fabricated terminal: it stays running with an
    // operator-visible recovery gate.
    expect(stepState(db)).toBe("running");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: STEP_ID,
    });

    // The child run is started once, attached once — never duplicated even on the
    // fail-closed path.
    expect(runner.starts()).toBe(1);
    expect(runner.attaches()).toBe(1);
    expect(countRuns(db)).toBe(2);
  });
});
