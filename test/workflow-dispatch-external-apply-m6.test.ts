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
  listExecutorRoundsForAttempt,
  loadExecutorAttempt,
} from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch,
} from "../src/core/workflow/dispatch/execute.js";
import { WORKFLOW_RECONCILE_RESULT_STATUS } from "../src/core/workflow/dispatch/reconcile-execute.js";
import { WORKFLOW_EXECUTE_RECONCILE_STATUS } from "../src/core/workflow/dispatch/executor-recovery.js";
import {
  executeAndReconcileDispatchedExternalApplyStep,
  type DispatchedExternalApplyRunner,
} from "../src/core/workflow/dispatch/external-apply-run.js";
import {
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
} from "../src/core/intent/apply-execute.js";
import { buildIdempotencyMarker } from "../src/adapters/external-update-adapter.js";
import type {
  LinearExternalUpdateClient,
  LinearExternalUpdateInput,
  LinearExternalUpdateResult,
  LinearExternalUpdateSuccess,
} from "../src/adapters/linear-external-update-client.js";
import type { LinearIssueRefreshClient } from "../src/adapters/linear-issue-refresh.js";
import { getUpdateIntentById } from "../src/core/intent/update-intents.js";

/**
 * NGX-496 (RC-3) — integration proof binding the daemon-dispatchable
 * external-apply producer to the *real* M6 `executeExternalApply` write path.
 *
 * Iterations 1 and 2 proved the pure mapping (against hand-built
 * `ExecuteExternalApplyResult` fixtures) and the async producer (against a
 * *canned* injected runner). Neither proved the producer composes with the
 * actual M6 implementation: that a real M6 `applied` / refused result flows
 * through the landed mapping into terminal executor evidence the RC-2 seam
 * finalizes. These tests close that gap by wiring the producer's
 * `runExternalApply` to the genuine `executeExternalApply`, with a **mock**
 * Linear write/refresh client injected through M6's own dependency seam.
 *
 * Acceptance criteria exercised here:
 *   - "The adapter invokes the existing M6 external-apply implementation and
 *     records durable executor terminal evidence" — the spy proves M6 reached
 *     the (mocked) Linear write; the dispatch scaffold carries succeeded
 *     evidence and the real intent transitions `pending -> applied`.
 *   - "Re-running the daemon path for an already-terminal dispatch invocation
 *     does not duplicate the external write" — re-entry never re-issues the
 *     real M6 write (the spy is called exactly once across two ticks).
 *   - "Missing/unsafe configuration still fails closed with operator-visible
 *     manual recovery" — a `create_intents_only` policy makes the real M6 path
 *     refuse `policy_denied` *before* any write, and the producer parks the run.
 *   - "no real `api.linear.app` calls in tests" — the only Linear client is the
 *     injected mock; M6's policy/audit/idempotency safety model runs verbatim.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-xa-m6-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const EXECUTE_AT = NOW + 10;
/** A dispatchable step provides a faithful `<run>::<step>::dispatch` scaffold;
 *  the producer is family-agnostic and runs the injected M6 thunk regardless. */
const STEP_ID = "preflight";
const OPERATOR_REASON = "RC-3 daemon external-apply";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-xa-m6-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeWritableEvidence(root = makeTempDir("momentum-xa-m6-evidence-")) {
  return {
    executorLogPath: path.join(root, "nested", "external-apply.log"),
    resultJsonPath: path.join(root, "nested", "external-apply.json"),
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
    objective: "Dogfood NGX-496 M6 integration",
    now: NOW,
  });
  return db;
}

/**
 * Drive a dispatchable step through the production base dispatch so it lands
 * `running` with a `<run>::<step>::dispatch` invocation (`running`) + scaffold
 * round (`pending`) and a held dispatch lease — the exact substrate the
 * external-apply producer runs against.
 */
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

function dispatchStep(db: MomentumDb): void {
  db.prepare(
    `UPDATE step_definitions
        SET executor = 'external-apply'
      WHERE definition_key = ? AND definition_version = ? AND step_key = ?`,
  ).run(
    CODING_WORKFLOW_DEFINITION.key,
    CODING_WORKFLOW_DEFINITION.version,
    STEP_ID,
  );
  const claim = approveAndClaim(db);
  executeWorkflowStepDispatch(claim, {
    db,
    workerId: WORKER,
    now: DISPATCH_AT,
  });
}

function stepState(db: MomentumDb): string {
  const row = getWorkflowStep(db, RUN_ID, STEP_ID);
  if (!row) throw new Error(`step ${STEP_ID} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb) {
  return listExecutorRoundsForAttempt(
    db,
    deriveDispatchInvocationId(RUN_ID, STEP_ID),
  );
}

// --- M6 intent / policy / mock-Linear seeding (mirrors test/intent-apply-execute.test.ts) ---

function externalApplyAllowedPolicy(): string {
  return ["---", "intent_apply_policy: external_apply_allowed", "---", ""].join(
    "\n",
  );
}

function createIntentsOnlyPolicy(): string {
  return ["---", "intent_apply_policy: create_intents_only", "---", ""].join(
    "\n",
  );
}

function makeRepo(policy: string): string {
  const repoPath = makeTempDir("momentum-xa-m6-repo-");
  fs.writeFileSync(path.join(repoPath, "MOMENTUM.md"), policy);
  return repoPath;
}

const SOURCE_ITEM_ID = "source_item_xa";
const EXTERNAL_ID = "linear_issue_id_xa";
const INTENT_ID = "intent_xa";
const INTENT_PAYLOAD = { kind: "comment" } as const;

function seedPendingIntent(db: MomentumDb): { idempotencyMarker: string } {
  db.prepare(
    `INSERT INTO source_items
       (id, adapter_kind, external_id, external_key, url, title, status,
        metadata_json, last_observed_at, goal_id, created_at, updated_at)
     VALUES (?, 'linear', ?, 'NGX-1001', ?, 'Happy issue', NULL, '{}', 1, NULL, 1, 1)`,
  ).run(
    SOURCE_ITEM_ID,
    EXTERNAL_ID,
    "https://linear.app/example/issue/NGX-1001",
  );
  db.prepare(
    `INSERT INTO update_intents
       (id, adapter_kind, target_external_id, intent_type, payload_json,
        reason, source_item_id, status, idempotency_key, created_at, updated_at,
        applied_at, skipped_at, canceled_at, decision_reason)
     VALUES (?, 'linear', ?, 'source_satisfied', ?, 'evidence shows goal complete',
             ?, 'pending', ?, 1, 1, NULL, NULL, NULL, NULL)`,
  ).run(
    INTENT_ID,
    EXTERNAL_ID,
    JSON.stringify(INTENT_PAYLOAD),
    SOURCE_ITEM_ID,
    `idemp:${INTENT_ID}`,
  );
  return {
    idempotencyMarker: buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: INTENT_ID,
      payload: INTENT_PAYLOAD,
    }),
  };
}

type ApplySpy = {
  client: LinearExternalUpdateClient;
  calls: LinearExternalUpdateInput[];
};

function makeApplySpy(outcome: LinearExternalUpdateResult): ApplySpy {
  const calls: LinearExternalUpdateInput[] = [];
  return {
    calls,
    client: {
      async apply(input) {
        calls.push(input);
        return outcome;
      },
    },
  };
}

function makeSuccessOutcome(args: {
  idempotencyMarker: string;
  alreadyApplied?: boolean;
}): LinearExternalUpdateSuccess {
  return {
    ok: true,
    alreadyApplied: args.alreadyApplied ?? false,
    issue: {
      id: EXTERNAL_ID,
      key: "NGX-1001",
      url: "https://linear.app/example/issue/NGX-1001",
    },
    comment: {
      id: "comment_1",
      url: "https://linear.app/example/comment/1",
    },
    status: {
      transitioned: false,
      previousStateId: "state_started",
      previousStateName: "In Progress",
      nextStateId: null,
      nextStateName: null,
    },
    idempotencyMarker: args.idempotencyMarker,
  };
}

function makeRefreshClient(marker: string): LinearIssueRefreshClient {
  return {
    async refresh() {
      return {
        ok: true,
        issue: {
          id: EXTERNAL_ID,
          identifier: "NGX-1001",
          title: "Happy issue",
          url: "https://linear.app/example/issue/NGX-1001",
          updatedAt: "2026-05-21T00:00:00.000Z",
          state: { id: "state-done", name: "Done" },
        },
        comments: [
          {
            id: "comment_1",
            body: `Momentum applied ${marker}`,
            url: "https://linear.app/example/comment/1",
          },
        ],
      };
    },
  };
}

/**
 * Build the producer's `runExternalApply` thunk wired to the genuine M6
 * `executeExternalApply`, with a mock Linear write/refresh client injected
 * through M6's own dependency seam (no real `api.linear.app` is reachable).
 */
function realM6Runner(
  db: MomentumDb,
  repoPath: string,
  spy: ApplySpy,
  marker: string,
): DispatchedExternalApplyRunner {
  return () =>
    executeExternalApply({
      db,
      intentId: INTENT_ID,
      operatorReason: OPERATOR_REASON,
      repoPath,
      env: { [LINEAR_API_KEY_ENV_VAR]: "test-key" },
      deps: {
        buildLinearClient: () => spy.client,
        buildLinearRefreshClient: () => makeRefreshClient(marker),
        now: () => 1000,
      },
    });
}

describe("external-apply producer × real M6 — applied through a mock Linear client", () => {
  it("invokes the real M6 write path, records succeeded evidence, and RC-2 finalizes the step", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const repoPath = makeRepo(externalApplyAllowedPolicy());
    const { idempotencyMarker } = seedPendingIntent(db);
    const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));
    const evidence = makeWritableEvidence();

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: realM6Runner(db, repoPath, spy, idempotencyMarker),
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

    // The real M6 path reached the (mock) Linear write exactly once — proof the
    // adapter invokes the existing implementation, with no real network call.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.preview.idempotencyMarker).toBe(idempotencyMarker);

    // M6's real two-phase apply transitioned the durable intent to applied.
    expect(getUpdateIntentById(db, INTENT_ID)?.status).toBe("applied");

    // The dispatch scaffold carries the real M6 outcome as terminal evidence.
    const invocation = loadExecutorAttempt(
      db,
      deriveDispatchInvocationId(RUN_ID, STEP_ID),
    );
    expect(invocation?.state).toBe("succeeded");
    const round = dispatchRounds(db)[0];
    expect(round?.state).toBe("succeeded");
    expect(round?.summary).toContain(INTENT_ID);
    expect(round?.logPaths).toEqual([
      evidence.executorLogPath,
      evidence.resultJsonPath,
    ]);
    expect(fs.existsSync(evidence.executorLogPath)).toBe(true);
    expect(fs.existsSync(evidence.resultJsonPath)).toBe(true);
    // The idempotency marker is the durable digest tying evidence to the write.
    expect(round?.resultDigest).toBe(idempotencyMarker);

    expect(stepState(db)).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("never re-issues the real external write once the dispatch invocation is terminal", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    const repoPath = makeRepo(externalApplyAllowedPolicy());
    const { idempotencyMarker } = seedPendingIntent(db);
    const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));
    const runExternalApply = realM6Runner(db, repoPath, spy, idempotencyMarker);
    const evidence = makeWritableEvidence();

    const first = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply,
      evidence,
      now: EXECUTE_AT,
    });
    expect(first.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
    );
    expect(spy.calls).toHaveLength(1);

    // A re-entered tick recognises the already-terminal invocation and NEVER
    // re-runs the real M6 write (no second mock-Linear mutation).
    const second = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply,
      evidence,
      now: EXECUTE_AT + 100,
    });
    expect(second.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted,
    );
    expect(spy.calls).toHaveLength(1);
    expect(second.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized,
    );
    expect(dispatchRounds(db)).toHaveLength(1);
    expect(stepState(db)).toBe("succeeded");
  });
});

describe("external-apply producer × real M6 — fail-closed on a real policy refusal", () => {
  it("parks the run for manual recovery without attempting any external write", async () => {
    const db = openSeededDb();
    dispatchStep(db);
    // A create_intents_only policy makes the real M6 path refuse before writing.
    const repoPath = makeRepo(createIntentsOnlyPolicy());
    const { idempotencyMarker } = seedPendingIntent(db);
    const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));
    const evidence = makeWritableEvidence();

    const out = await executeAndReconcileDispatchedExternalApplyStep({
      db,
      runId: RUN_ID,
      stepId: STEP_ID,
      runExternalApply: realM6Runner(db, repoPath, spy, idempotencyMarker),
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

    // M6's policy gate refused before the write: the mock Linear client was
    // never called, and the durable intent stays pending (no apply happened).
    expect(spy.calls).toHaveLength(0);
    expect(getUpdateIntentById(db, INTENT_ID)?.status).toBe("pending");

    // The scaffold carries terminal manual-recovery evidence with the precise
    // M6 cause preserved for the operator — not a fabricated clean terminal.
    const invocation = loadExecutorAttempt(
      db,
      deriveDispatchInvocationId(RUN_ID, STEP_ID),
    );
    expect(invocation?.state).toBe("manual_recovery_required");
    const round = dispatchRounds(db)[0];
    expect(round?.state).toBe("manual_recovery_required");
    expect(round?.summary).toContain("policy_denied");

    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db)).toBe("running");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: STEP_ID,
    });
  });
});
