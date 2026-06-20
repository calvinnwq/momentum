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
import { getWorkflowStep } from "../src/core/workflow/step-transitions.js";
import {
  loadExecutorInvocation,
  listExecutorRoundsForInvocation
} from "../src/core/executors/loop-persist.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch
} from "../src/core/workflow/dispatch-execute.js";
import { WORKFLOW_RECONCILE_RESULT_STATUS } from "../src/core/workflow/dispatch-reconcile-execute.js";
import { WORKFLOW_EXECUTE_RECONCILE_STATUS } from "../src/core/workflow/dispatch-executor-run.js";
import { createExternalApplyWorkflowDispatch } from "../src/core/workflow/external-apply-dispatch.js";
import { executeAndReconcileDispatchedExternalApplyStep } from "../src/core/workflow/dispatch-external-apply-run.js";
import type {
  ExecuteExternalApplyContext,
  ExecuteExternalApplyErrorCode,
  ExecuteExternalApplyExternalResult,
  ExecuteExternalApplyFailure,
  ExecuteExternalApplyResult,
  ExecuteExternalApplySuccess
} from "../src/core/intent/apply-execute.js";
import type { IntentApplyAudit } from "../src/core/intent/apply-audits.js";
import type { UpdateIntent } from "../src/core/intent/update-intents.js";

/**
 * NGX-496 (RC-3) — the async run-path producer that makes the `external-apply`
 * executor family daemon-dispatchable: it runs the existing M6
 * `executeExternalApply` write path (through an injected runner, so the daemon
 * lane owns building the apply input and there is no real `api.linear.app`
 * call), maps the M6 outcome into executor evidence via the landed pure mapping,
 * records that evidence on the `<run>::<step>::dispatch` scaffold, and lets the
 * RC-2 reconciliation seam finalize the owning step exactly once.
 *
 * These tests pin the producer's contract and its boundary discipline:
 *   - a clean applied outcome runs the write once, records succeeded terminal
 *     evidence, and RC-2 finalizes the step succeeded;
 *   - every M6 failure parks the run for manual recovery with operator-visible
 *     evidence (the fail-closed default for high-risk external writes);
 *   - re-entry over an already-terminal dispatch invocation NEVER re-runs the
 *     external write (no duplicate Linear mutation, no second terminalization);
 *   - a step with no dispatch scaffold (the M9 direct-finalize lane) is refused
 *     without ever running the write.
 *
 * The injected runner is the only apply path, so no test here touches a real
 * Linear endpoint — the M6 safety model (policy gating, audit-before-write,
 * idempotency) is preserved verbatim and exercised by the M6 suites.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-xa-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const EXECUTE_AT = NOW + 10;
const STEP_ID = "preflight";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-xa-run-"): string {
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
    objective: "Dogfood NGX-496",
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
 * Drive a (dispatchable) step through the production base dispatch so it lands
 * `running` with a `<run>::<step>::dispatch` invocation (`running`) + scaffold
 * round (`pending`) and a held dispatch lease — the exact substrate the
 * external-apply producer runs against. The producer is family-gated: it only runs the injected M6 write path when the
 * scaffold records `external-apply`, so tests set the definition executor before
 * dispatching the scaffold.
 */
function dispatchStep(
  db: MomentumDb,
  stepId: string = STEP_ID,
  executor: "external-apply" | "one-shot" = "external-apply"
): void {
  db.prepare(
    `UPDATE step_definitions
        SET executor = ?
      WHERE definition_key = ? AND definition_version = ? AND step_key = ?`
  ).run(
    executor,
    CODING_WORKFLOW_DEFINITION.key,
    CODING_WORKFLOW_DEFINITION.version,
    stepId
  );
  const claim = approveAndClaim(db, stepId);
  executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: DISPATCH_AT });
}

async function dispatchStepThroughExternalApplyWrapper(
  db: MomentumDb,
  runner: ReturnType<typeof countingRunner>
): Promise<void> {
  db.prepare(
    `UPDATE step_definitions
        SET executor = 'external-apply'
      WHERE definition_key = ? AND definition_version = ? AND step_key = ?`
  ).run(CODING_WORKFLOW_DEFINITION.key, CODING_WORKFLOW_DEFINITION.version, STEP_ID);
  const claim = approveAndClaim(db, STEP_ID);
  const dispatch = createExternalApplyWorkflowDispatch(executeWorkflowStepDispatch, {
    deriveExternalApply: () => ({
      ok: true,
      runExternalApply: runner.run,
      evidence: makeWritableEvidence()
    })
  });
  await dispatch(claim, { db, workerId: WORKER, now: DISPATCH_AT });
}

function stepState(db: MomentumDb, stepId: string = STEP_ID): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb, stepId: string = STEP_ID) {
  return listExecutorRoundsForInvocation(
    db,
    deriveDispatchInvocationId(RUN_ID, stepId)
  );
}

const EVIDENCE = {
  executorLogPath: "/repos/momentum/.agent-workflows/run-xa-001/external-apply.log",
  resultJsonPath: "/repos/momentum/.agent-workflows/run-xa-001/external-apply.json"
} as const;

function makeWritableEvidence(root = makeTempDir("momentum-xa-evidence-")) {
  return {
    executorLogPath: path.join(root, "nested", "external-apply.log"),
    resultJsonPath: path.join(root, "nested", "external-apply.json")
  };
}

const IDEMPOTENCY_MARKER = "momentum-apply:intent-001:abc123";

/**
 * A runner whose call is counted so a test can prove the external write ran
 * exactly once (or never). It returns a canned M6 result rather than touching a
 * real Linear endpoint — the structural guarantee against real network calls.
 */
function countingRunner(result: ExecuteExternalApplyResult): {
  run: () => Promise<ExecuteExternalApplyResult>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return result;
    },
    calls: () => calls
  };
}

function makeTarget(): ExecuteExternalApplyContext["target"] {
  return {
    adapterKind: "linear",
    externalId: "ext-1",
    externalKey: "NGX-1",
    url: "https://linear.app/ngxcalvin/issue/NGX-1",
    title: "Some issue"
  };
}

function makeContext(
  overrides: Partial<ExecuteExternalApplyContext> = {}
): ExecuteExternalApplyContext {
  return {
    intentId: "intent-001",
    intentStatus: "pending",
    adapterKind: "linear",
    intentType: "status_change",
    target: makeTarget(),
    applyPolicy: { value: "external_apply_allowed", source: "momentum_policy" },
    allowStatusMutation: false,
    mutationKind: "comment",
    auditId: "audit-001",
    reconcile: { status: "pending", warning: null },
    ...overrides
  };
}

function makeExternal(
  overrides: Partial<ExecuteExternalApplyExternalResult> = {}
): ExecuteExternalApplyExternalResult {
  return {
    alreadyApplied: false,
    issueId: "issue-1",
    issueKey: "NGX-1",
    issueUrl: "https://linear.app/ngxcalvin/issue/NGX-1",
    commentId: "comment-1",
    commentUrl: "https://linear.app/ngxcalvin/issue/NGX-1#comment-1",
    statusTransitioned: false,
    nextStateId: null,
    nextStateName: null,
    idempotencyMarker: IDEMPOTENCY_MARKER,
    ...overrides
  };
}

function makeIntent(): UpdateIntent {
  return {
    id: "intent-001",
    adapterKind: "linear",
    targetExternalId: "ext-1",
    intentType: "status_change",
    payload: { kind: "comment" },
    reason: "test intent",
    goalId: null,
    sourceItemId: null,
    evidenceRecordId: null,
    status: "applied",
    idempotencyKey: "idem-1",
    decisionReason: "external_apply: test",
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    appliedAt: 3,
    skippedAt: null,
    canceledAt: null
  };
}

function makeAudit(): IntentApplyAudit {
  return {
    id: "audit-001",
    intentId: "intent-001",
    adapterKind: "linear",
    provider: "linear",
    target: {
      externalId: "ext-1",
      externalKey: "NGX-1",
      url: "https://linear.app/ngxcalvin/issue/NGX-1",
      title: "Some issue"
    },
    requestedAt: 1,
    finishedAt: 2,
    operatorReason: "test intent",
    operatorActor: null,
    intentApplyPolicy: "external_apply_allowed",
    allowStatusMutation: false,
    mutationKind: "comment",
    previewSummary: "comment preview",
    idempotencyMarker: IDEMPOTENCY_MARKER,
    lifecycleState: "succeeded",
    resultStatus: "succeeded",
    resultCode: "applied",
    resultMessage: "External write succeeded.",
    externalRefs: {
      commentId: "comment-1",
      commentUrl: "https://linear.app/ngxcalvin/issue/NGX-1#comment-1",
      stateTransitionId: null
    },
    reconcile: { status: "pending", warning: null },
    createdAt: 1,
    updatedAt: 2
  };
}

function makeSuccess(
  externalOverrides: Partial<ExecuteExternalApplyExternalResult> = {}
): ExecuteExternalApplySuccess {
  return {
    ok: true,
    resultCode: "applied",
    context: makeContext({ intentStatus: "applied" }),
    intent: makeIntent(),
    audit: makeAudit(),
    external: makeExternal(externalOverrides)
  };
}

function makeFailure(
  code: ExecuteExternalApplyErrorCode,
  message = `simulated ${code}`
): ExecuteExternalApplyFailure {
  return {
    ok: false,
    code,
    message,
    context: makeContext(),
    intent: null,
    audit: null,
    external: null
  };
}

describe("executeAndReconcileDispatchedExternalApplyStep — clean applied", () => {
  it("is reachable through the daemon dispatch wrapper for an external-apply scaffold", async () => {
    const db = openSeededDb();
    const runner = countingRunner(makeSuccess());

    await dispatchStepThroughExternalApplyWrapper(db, runner);

    expect(runner.calls()).toBe(1);
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.executorFamily
    ).toBe("external-apply");
    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("runs the M6 write once, records succeeded evidence, and RC-2 finalizes the step", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(makeSuccess());

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(runner.calls()).toBe(1);
    expect(out.executorResult?.ok).toBe(true);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized
    );

    // The dispatch invocation + round carry the captured terminal evidence.
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, STEP_ID)
    );
    expect(invocation?.state).toBe("succeeded");
    const rounds = dispatchRounds(db);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.state).toBe("succeeded");
    expect(rounds[0]?.summary).toContain("intent-001");
    expect(rounds[0]?.logPaths).toEqual([
      evidence.executorLogPath,
      evidence.resultJsonPath
    ]);
    // The idempotency marker is the durable digest tying evidence to the write.
    expect(rounds[0]?.resultDigest).toBe(IDEMPOTENCY_MARKER);

    // The step is finalized exactly once and the dispatch lease released.
    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("writes durable success evidence files before recording their paths", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(makeSuccess());

    await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(fs.existsSync(evidence.executorLogPath)).toBe(true);
    expect(fs.existsSync(evidence.resultJsonPath)).toBe(true);
    expect(fs.readFileSync(evidence.executorLogPath, "utf8")).toContain(
      "external-apply applied"
    );
    const snapshot = JSON.parse(
      fs.readFileSync(evidence.resultJsonPath, "utf8")
    ) as ExecuteExternalApplyResult;
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected success snapshot");
    expect(snapshot.context.intentId).toBe("intent-001");
  });

  it("preserves an idempotent already-applied replay as a clean succeeded terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(makeSuccess({ alreadyApplied: true }));

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(stepState(db)).toBe("succeeded");
    expect(dispatchRounds(db)[0]?.summary).toContain("already applied");
  });
});

describe("executeAndReconcileDispatchedExternalApplyStep — fail-closed on M6 refusal", () => {
  it("parks the run for manual recovery with operator-visible evidence", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(
      makeFailure("policy_denied", "intent_apply_policy is create_intents_only")
    );

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(runner.calls()).toBe(1);
    expect(out.executorResult?.ok).toBe(false);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery
    );

    // The invocation carries terminal manual-recovery evidence — not a fake clean
    // terminal — and the precise M6 cause is preserved for the operator.
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, STEP_ID)
    );
    expect(invocation?.state).toBe("manual_recovery_required");
    const round = dispatchRounds(db)[0];
    expect(round?.state).toBe("manual_recovery_required");
    expect(round?.summary).toContain("policy_denied");
    expect(round?.summary).toContain("create_intents_only");

    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
    ).toBe(true);
    expect(stepState(db)).toBe("running");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: STEP_ID
    });
  });

  it("writes durable refusal evidence files before recording their paths", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(
      makeFailure("policy_denied", "intent_apply_policy is create_intents_only")
    );

    await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(fs.existsSync(evidence.executorLogPath)).toBe(true);
    expect(fs.existsSync(evidence.resultJsonPath)).toBe(true);
    expect(fs.readFileSync(evidence.executorLogPath, "utf8")).toContain(
      "external-apply refused"
    );
    const snapshot = JSON.parse(
      fs.readFileSync(evidence.resultJsonPath, "utf8")
    ) as ExecuteExternalApplyResult;
    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) throw new Error("expected refusal snapshot");
    expect(snapshot.code).toBe("policy_denied");
  });
});

describe("executeAndReconcileDispatchedExternalApplyStep — idempotent re-entry", () => {
  it("never re-runs the external write once the dispatch invocation is terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(makeSuccess());

    const first = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });
    expect(first.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(runner.calls()).toBe(1);

    // A re-entered tick recognises the already-terminal invocation, NEVER
    // re-issues the external write, and converges the finalization idempotently.
    const second = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT + 100
    });
    expect(second.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted
    );
    expect(runner.calls()).toBe(1);
    expect(second.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized
    );

    // No duplicate scaffold round; the step is terminal exactly once.
    expect(dispatchRounds(db)).toHaveLength(1);
    expect(stepState(db)).toBe("succeeded");
  });
});

describe("executeAndReconcileDispatchedExternalApplyStep — reconcile deferral", () => {
  it("keeps the dispatch lease held when reconciliation throws after evidence is recorded", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const evidence = makeWritableEvidence();
    const runner = countingRunner(makeSuccess());
    db.exec(`
      CREATE TRIGGER test_block_reconcile_xa
      BEFORE UPDATE OF state ON workflow_steps
      WHEN NEW.run_id = '${RUN_ID}' AND NEW.step_id = '${STEP_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'reconcile blocked');
      END;
    `);

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred);
    expect(out.reconcile).toBeUndefined();
    expect(out.terminalize?.status).toBe("terminalize_recorded");
    // The external write is recorded as terminal evidence; the step stays running
    // with the lease held so a later tick re-drives only the reconciliation.
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state
    ).toBe("succeeded");
    expect(stepState(db)).toBe("running");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
  });
});

describe("executeAndReconcileDispatchedExternalApplyStep — M9 lane boundary", () => {
  it("refuses a non-external-apply dispatch scaffold and never runs the external write", async () => {
    const db = openSeededDb();
    dispatchStep(db, STEP_ID, "one-shot");
    const runner = countingRunner(makeSuccess());

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence: EVIDENCE,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched);
    expect(runner.calls()).toBe(0);
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
        ?.state
    ).toBe("running");
    expect(stepState(db)).toBe("running");
  });

  it("refuses a step with no dispatch invocation and never runs the external write", async () => {
    const db = openSeededDb();
    // No dispatch: an M9 direct-finalize / never-dispatched step writes no
    // executor invocation, so the producer must refuse it untouched.
    const runner = countingRunner(makeSuccess());

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: runner.run,
      evidence: EVIDENCE,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched);
    expect(runner.calls()).toBe(0);
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, STEP_ID))
    ).toBeUndefined();
    // The step is left exactly as it was; nothing was finalized.
    expect(stepState(db)).toBe("pending");
  });
});
