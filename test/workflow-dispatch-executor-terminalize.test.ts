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
  type ClaimedWorkflowStep
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  loadExecutorInvocation,
  listExecutorRoundsForInvocation
} from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch
} from "../src/core/workflow/dispatch/execute.js";
import {
  reconcileDispatchedWorkflowStep,
  WORKFLOW_RECONCILE_RESULT_STATUS
} from "../src/core/workflow/dispatch/reconcile-execute.js";
import type { WorkflowStepExecutorDispatchResult } from "../src/core/workflow/step/executor.js";
import {
  planDispatchedExecutorTerminalization,
  terminalizeDispatchedExecutorInvocation,
  WORKFLOW_EXECUTOR_TERMINALIZE_STATUS
} from "../src/core/workflow/dispatch/executor-terminalize.js";

/**
 * NGX-492 (RC-5b) — the production seam that drives a dispatched step's
 * executor scaffold (`<run>::<step>::dispatch` invocation `running` + round
 * `pending`) to a terminal executor state from a REAL
 * `WorkflowStepExecutorDispatchResult`, then hands that terminal evidence to the
 * RC-2 reconciliation seam to finalize the workflow step exactly once.
 *
 * Before this, the only code that terminalized a dispatch invocation was the
 * test helper `driveInvocationTerminal` (and the dogfood stand-in). These tests
 * prove the production mapping: a clean executor terminal lets RC-2 finalize the
 * step; an unconfigured / process-level executor failure parks the run for
 * manual recovery instead of fabricating a fake success.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-terminalize-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const TERMINALIZE_AT = NOW + 2;
const RECONCILE_AT = NOW + 3;

const EXECUTOR_LOG = "/tmp/run/executor.log";
const RESULT_JSON = "/tmp/run/result.json";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-terminalize-")
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
    objective: "Dogfood NGX-492",
    now: NOW
  });
  return db;
}

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
 * `<run>::<step>::dispatch` invocation (`running`) + scaffold round (`pending`)
 * and a held dispatch lease, exactly as the daemon workflow lane leaves it
 * before the executor terminates.
 */
function dispatchStep(db: MomentumDb, stepId: string): void {
  const claim = approveAndClaim(db, stepId);
  executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: DISPATCH_AT });
}

function successResult(
  summary = "preflight passed"
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "succeeded",
      summary,
      checkpoints: [],
      artifacts: [
        { kind: "executor-log", path: EXECUTOR_LOG },
        { kind: "runner-result", path: RESULT_JSON }
      ],
      resultDigest: "sha256:abc123",
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: EXECUTOR_LOG,
    resultJsonPath: RESULT_JSON
  };
}

function failedResult(): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "failed",
      summary: "preflight reported success=false",
      checkpoints: [],
      artifacts: [{ kind: "executor-log", path: EXECUTOR_LOG }],
      resultDigest: null,
      errorCode: "command_failed",
      errorMessage: "live step runner reported success=false",
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: EXECUTOR_LOG,
    resultJsonPath: RESULT_JSON
  };
}

function unconfiguredResult(): WorkflowStepExecutorDispatchResult {
  return {
    ok: false,
    code: "runtime_unavailable",
    error:
      'No live workflow-step wrapper is configured for step kind "preflight".',
    executorLogPath: EXECUTOR_LOG,
    resultJsonPath: RESULT_JSON
  };
}

function dispatchRound(db: MomentumDb, stepId: string) {
  const rounds = listExecutorRoundsForInvocation(
    db,
    deriveDispatchInvocationId(RUN_ID, stepId)
  );
  if (rounds.length !== 1) {
    throw new Error(`expected exactly one scaffold round, got ${rounds.length}`);
  }
  return rounds[0]!;
}

function stepState(db: MomentumDb, stepId: string): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

describe("planDispatchedExecutorTerminalization — pure mapping", () => {
  it("maps a succeeded executor result to a clean succeeded terminal", () => {
    expect(planDispatchedExecutorTerminalization(successResult())).toEqual({
      outcome: "clean_terminal",
      invocationState: "succeeded",
      roundState: "succeeded",
      classification: "complete"
    });
  });

  it("maps a failed (runner success=false) executor result to a clean failed terminal", () => {
    expect(planDispatchedExecutorTerminalization(failedResult())).toEqual({
      outcome: "clean_terminal",
      invocationState: "failed",
      roundState: "failed",
      classification: "failed"
    });
  });

  it("routes an unconfigured runtime_unavailable error to manual recovery, never a fake success", () => {
    expect(planDispatchedExecutorTerminalization(unconfiguredResult())).toEqual({
      outcome: "manual_recovery",
      invocationState: "manual_recovery_required",
      roundState: "manual_recovery_required",
      classification: "manual_recovery_required",
      recoveryCode: "runtime_unavailable"
    });
  });

  it("preserves the precise process-level error code on the manual-recovery plan", () => {
    const plan = planDispatchedExecutorTerminalization({
      ok: false,
      code: "command_timed_out",
      error: "preflight wrapper timed out",
      executorLogPath: EXECUTOR_LOG,
      resultJsonPath: RESULT_JSON
    });
    expect(plan).toMatchObject({
      outcome: "manual_recovery",
      recoveryCode: "command_timed_out"
    });
  });

  it("routes an unexpected skipped executor terminal to manual recovery rather than fabricating a clean terminal", () => {
    const plan = planDispatchedExecutorTerminalization({
      ok: true,
      result: {
        state: "skipped",
        summary: "executor skipped",
        checkpoints: [],
        artifacts: [],
        resultDigest: null,
        errorCode: null,
        errorMessage: null,
        retryHint: null,
        recoveryHint: null
      },
      executorLogPath: EXECUTOR_LOG,
      resultJsonPath: RESULT_JSON
    });
    expect(plan.outcome).toBe("manual_recovery");
    expect(plan.invocationState).toBe("manual_recovery_required");
  });
});

describe("terminalizeDispatchedExecutorInvocation — succeeded", () => {
  it("drives the dispatch invocation + round to succeeded so RC-2 finalizes the step once", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");

    const terminalize = terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: successResult(),
      now: TERMINALIZE_AT
    });
    expect(terminalize.status).toBe(
      WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.terminalized
    );

    // The dispatch invocation is now a clean terminal the RC-2 decider maps.
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight")
    );
    expect(invocation?.state).toBe("succeeded");
    expect(invocation?.finishedAt).toBe(TERMINALIZE_AT);

    // The scaffold round terminalized with captured evidence (no fabrication
    // before execution; the round only now carries the summary/log evidence).
    const round = dispatchRound(db, "preflight");
    expect(round.state).toBe("succeeded");
    expect(round.classification).toBe("complete");
    expect(round.summary).toBe("preflight passed");
    expect(round.logPaths).toContain(EXECUTOR_LOG);
    expect(round.finishedAt).toBe(TERMINALIZE_AT);

    // The step is still `running` — terminalization records evidence only; the
    // RC-2 seam remains the single owner of the workflow-step finalization.
    expect(stepState(db, "preflight")).toBe("running");

    const reconciled = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    expect(reconciled.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.finalized);
    expect(stepState(db, "preflight")).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });
});

describe("terminalizeDispatchedExecutorInvocation — failed", () => {
  it("drives the invocation + round to failed so RC-2 finalizes the step failed", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");

    terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: failedResult(),
      now: TERMINALIZE_AT
    });

    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, "preflight"))
        ?.state
    ).toBe("failed");
    const round = dispatchRound(db, "preflight");
    expect(round.state).toBe("failed");
    expect(round.classification).toBe("failed");

    const reconciled = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    expect(reconciled.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.finalized);
    expect(stepState(db, "preflight")).toBe("failed");
  });
});

describe("terminalizeDispatchedExecutorInvocation — unconfigured fails honestly", () => {
  it("parks the run for manual recovery on a runtime_unavailable result instead of a fake success", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");

    terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: unconfiguredResult(),
      now: TERMINALIZE_AT
    });

    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight")
    );
    expect(invocation?.state).toBe("manual_recovery_required");
    const round = dispatchRound(db, "preflight");
    expect(round.state).toBe("manual_recovery_required");
    expect(round.recoveryCode).toBe("runtime_unavailable");

    const reconciled = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    expect(reconciled.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery
    );
    // Honest failure: the run is parked, NOT fabricated to a clean terminal.
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
    ).toBe(true);
    expect(stepState(db, "preflight")).toBe("running");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: "preflight"
    });
  });
});

describe("terminalizeDispatchedExecutorInvocation — idempotency", () => {
  it("is a no-op on re-entry over an already-terminal invocation", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");

    const first = terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: successResult(),
      now: TERMINALIZE_AT
    });
    expect(first.status).toBe(
      WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.terminalized
    );

    // A second terminalize (e.g. a re-entered dispatch tick) recognises the
    // already-terminal invocation, changes nothing, and never duplicates a round.
    const second = terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: successResult("a different summary that must not overwrite"),
      now: TERMINALIZE_AT + 100
    });
    expect(second.status).toBe(
      WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.alreadyTerminal
    );

    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight")
    );
    expect(invocation?.state).toBe("succeeded");
    expect(invocation?.finishedAt).toBe(TERMINALIZE_AT);
    const round = dispatchRound(db, "preflight");
    expect(round.summary).toBe("preflight passed");

    // RC-2 still finalizes the step exactly once from the unchanged evidence.
    const reconciled = reconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      now: RECONCILE_AT
    });
    expect(reconciled.status).toBe(WORKFLOW_RECONCILE_RESULT_STATUS.finalized);
    expect(stepState(db, "preflight")).toBe("succeeded");
  });
});

describe("terminalizeDispatchedExecutorInvocation — boundary", () => {
  it("refuses a step with no dispatch invocation and writes nothing", () => {
    const db = openSeededDb();
    // No dispatch: the step was never driven through the M10 lane.
    const result = terminalizeDispatchedExecutorInvocation({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      result: successResult(),
      now: TERMINALIZE_AT
    });
    expect(result.status).toBe(
      WORKFLOW_EXECUTOR_TERMINALIZE_STATUS.notDispatched
    );
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, "preflight"))
    ).toBeUndefined();
  });
});
