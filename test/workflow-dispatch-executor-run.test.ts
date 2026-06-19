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
import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorDispatchResult,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
  type WorkflowStepExecutorRegistry
} from "../src/core/workflow/step-executor.js";
import { buildRealWorkflowStepExecutorRegistry } from "../src/core/workflow/step-executor-real-adapters.js";
import {
  parseLiveWrapperProfile,
  type LiveWrapperProfile
} from "../src/adapters/live-wrapper-registry.js";
import {
  buildDispatchedStepExecutorInput,
  executeAndReconcileDispatchedWorkflowStep,
  WORKFLOW_EXECUTE_RECONCILE_STATUS
} from "../src/core/workflow/dispatch-executor-run.js";

/**
 * NGX-492 (RC-5b) — the production execution path that drives a dispatched step's
 * executor scaffold to terminal through a REAL `WorkflowStepExecutor` registry,
 * then hands the terminal evidence to the RC-2 reconciliation seam to finalize the
 * step exactly once.
 *
 * Iteration 1 landed `terminalizeDispatchedExecutorInvocation` (the "record the
 * result" half) but nothing produced the result by running the dispatched step's
 * executor. These tests pin that missing half:
 * `executeAndReconcileDispatchedWorkflowStep` composes "run executor (injected
 * registry) -> terminalize evidence -> reconcile". A configured profile finalizes
 * the step; an unconfigured profile parks the run for manual recovery instead of a
 * fake success; re-entry never re-runs the executor; a non-dispatched step (the M9
 * direct-finalize lane) is refused without touching the executor.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-execute-001";
const WORKER = "worker-1";
const DISPATCH_AT = NOW + 1;
const EXECUTE_AT = NOW + 10;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-execute-"): string {
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
 * and a held dispatch lease, exactly as the daemon workflow lane leaves it before
 * the executor runs.
 */
function dispatchStep(db: MomentumDb, stepId: string): void {
  const claim = approveAndClaim(db, stepId);
  executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: DISPATCH_AT });
}

function stepState(db: MomentumDb, stepId: string): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb, stepId: string) {
  return listExecutorRoundsForInvocation(
    db,
    deriveDispatchInvocationId(RUN_ID, stepId)
  );
}

const EXEC_CONTEXT = {
  repoPath: "/repos/momentum",
  runDir: "/repos/momentum/.agent-workflows/run-execute-001",
  resultJsonPath:
    "/repos/momentum/.agent-workflows/run-execute-001/result.json",
  executorLogPath:
    "/repos/momentum/.agent-workflows/run-execute-001/executor.log"
} as const;

/**
 * A registry whose every kind runs `result` and counts execute calls, so a test
 * can assert the executor ran exactly once (or never).
 */
function countingRegistry(
  result:
    | WorkflowStepExecutorDispatchResult
    | ((input: WorkflowStepExecutorInput) => WorkflowStepExecutorDispatchResult)
): { registry: WorkflowStepExecutorRegistry; calls: () => number } {
  let calls = 0;
  const registry = new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>(
    WORKFLOW_STEP_EXECUTOR_KINDS.map((kind) => [
      kind,
      {
        kind,
        executes: true,
        execute: (input: WorkflowStepExecutorInput) => {
          calls += 1;
          return typeof result === "function" ? result(input) : result;
        }
      }
    ])
  );
  return { registry, calls: () => calls };
}

function succeededResult(
  input: WorkflowStepExecutorInput
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "succeeded",
      summary: "preflight passed",
      checkpoints: [],
      artifacts: [{ kind: "executor-log", path: input.executorLogPath }],
      resultDigest: "sha256:live",
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath
  };
}

function failedResult(
  input: WorkflowStepExecutorInput
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "failed",
      summary: "preflight reported success=false",
      checkpoints: [],
      artifacts: [{ kind: "executor-log", path: input.executorLogPath }],
      resultDigest: null,
      errorCode: "command_failed",
      errorMessage: "live step runner reported success=false",
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath
  };
}

const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "live preflight succeeded",
  key_changes_made: ["did the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: { type: "chore", subject: "do the thing", body: "", breaking: false }
});
const WRITE_VALID_RESULT = `printf '%s' '${VALID_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

function profileWith(
  kind: WorkflowStepExecutorKind,
  args: string[]
): LiveWrapperProfile {
  const parsed = parseLiveWrapperProfile({
    name: "rc5b-execute-test",
    wrappers: {
      [kind]: {
        command: "/bin/sh",
        args,
        cwd: "iteration",
        timeout_sec: 30,
        env_allow: [],
        result_file: "result.json"
      }
    }
  });
  if (!parsed.ok) throw new Error(`test setup: bad profile: ${parsed.error}`);
  return parsed.profile;
}

describe("buildDispatchedStepExecutorInput", () => {
  it("builds a valid executor input from the step kind, defaulting attempt to 1", () => {
    const input = buildDispatchedStepExecutorInput(
      "preflight",
      RUN_ID,
      "preflight",
      EXEC_CONTEXT
    );
    expect(input).toMatchObject({
      runId: RUN_ID,
      stepId: "preflight",
      kind: "preflight",
      attempt: 1,
      repoPath: EXEC_CONTEXT.repoPath,
      runDir: EXEC_CONTEXT.runDir,
      resultJsonPath: EXEC_CONTEXT.resultJsonPath,
      executorLogPath: EXEC_CONTEXT.executorLogPath
    });
    // Optional fields are omitted (not present) when not supplied.
    expect(input.promptPath).toBeUndefined();
    expect(input.config).toBeUndefined();
  });

  it("forwards the configured attempt and optional fields when supplied", () => {
    const input = buildDispatchedStepExecutorInput(
      "implementation",
      RUN_ID,
      "implementation",
      {
        ...EXEC_CONTEXT,
        attempt: 3,
        promptPath: "/tmp/prompt.md",
        config: { outcome: "success" }
      }
    );
    expect(input.attempt).toBe(3);
    expect(input.promptPath).toBe("/tmp/prompt.md");
    expect(input.config).toEqual({ outcome: "success" });
  });
});

describe("executeAndReconcileDispatchedWorkflowStep — configured success", () => {
  it("runs the executor, records terminal evidence, and RC-2 finalizes the step succeeded", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);

    const out = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(calls()).toBe(1);
    expect(out.executorResult?.ok).toBe(true);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized
    );

    // The dispatch invocation + round carry the captured terminal evidence.
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight")
    );
    expect(invocation?.state).toBe("succeeded");
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.state).toBe("succeeded");
    expect(rounds[0]?.summary).toBe("preflight passed");

    // The step is finalized exactly once and the dispatch lease released.
    expect(stepState(db, "preflight")).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("finalizes the step failed when the executor reports a clean failed terminal", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    const { registry } = countingRegistry(failedResult);

    const out = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.finalized
    );
    expect(stepState(db, "preflight")).toBe("failed");
  });

  it("drives a real configured live-wrapper command end to end to succeeded", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    const repoPath = makeTempDir("momentum-execute-repo-");
    const runDir = makeTempDir("momentum-execute-run-");
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("preflight", ["-c", WRITE_VALID_RESULT])
    });

    const out = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: {
        repoPath,
        runDir,
        resultJsonPath: path.join(runDir, "result.json"),
        executorLogPath: path.join(runDir, "executor.log")
      },
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(out.executorResult?.ok).toBe(true);
    expect(stepState(db, "preflight")).toBe("succeeded");
  });
});

describe("executeAndReconcileDispatchedWorkflowStep — unconfigured fails honestly", () => {
  it("parks the run for manual recovery on runtime_unavailable instead of a fake success", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    // The real registry with NO profile resolves every kind to the honest
    // unconfigured adapter that refuses with runtime_unavailable.
    const registry = buildRealWorkflowStepExecutorRegistry();

    const out = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(out.executorResult?.ok).toBe(false);
    expect(out.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.manualRecovery
    );

    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight")
    );
    expect(invocation?.state).toBe("manual_recovery_required");
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

describe("executeAndReconcileDispatchedWorkflowStep — idempotent re-entry", () => {
  it("never re-runs the executor once the dispatch invocation is terminal", () => {
    const db = openSeededDb();
    dispatchStep(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);

    const first = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT
    });
    expect(first.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled
    );
    expect(calls()).toBe(1);

    // A re-entered dispatch tick recognises the already-terminal invocation,
    // never re-runs the executor (no second process / duplicate evidence), and
    // converges the finalization idempotently.
    const second = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT + 100
    });
    expect(second.status).toBe(
      WORKFLOW_EXECUTE_RECONCILE_STATUS.alreadyExecuted
    );
    expect(calls()).toBe(1);
    expect(second.reconcile?.status).toBe(
      WORKFLOW_RECONCILE_RESULT_STATUS.alreadyFinalized
    );

    // No duplicate scaffold round, step still terminal exactly once.
    expect(dispatchRounds(db, "preflight")).toHaveLength(1);
    expect(stepState(db, "preflight")).toBe("succeeded");
  });
});

describe("executeAndReconcileDispatchedWorkflowStep — M9 lane boundary", () => {
  it("refuses a step with no dispatch invocation and never runs the executor", () => {
    const db = openSeededDb();
    // No dispatch: an M9 direct-finalize / never-dispatched step writes no
    // executor invocation, so the execute seam must refuse it untouched.
    const { registry, calls } = countingRegistry(succeededResult);

    const out = executeAndReconcileDispatchedWorkflowStep({
      db,
      runId: RUN_ID,
      stepId: "preflight",
      registry,
      exec: EXEC_CONTEXT,
      now: EXECUTE_AT
    });

    expect(out.status).toBe(WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched);
    expect(calls()).toBe(0);
    expect(
      loadExecutorInvocation(db, deriveDispatchInvocationId(RUN_ID, "preflight"))
    ).toBeUndefined();
    // The step is left exactly as it was; nothing was finalized.
    expect(stepState(db, "preflight")).toBe("pending");
  });
});
