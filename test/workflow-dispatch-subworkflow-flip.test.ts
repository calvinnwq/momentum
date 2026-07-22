import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  deriveDispatchAttemptId,
  executeWorkflowStepDispatch,
} from "../src/core/workflow/dispatch/execute.js";
import { loadExecutorAttempt } from "../src/core/executors/loop/persist.js";
import { WORKFLOW_EXECUTE_RECONCILE_STATUS } from "../src/core/workflow/dispatch/executor-recovery.js";
import { WORKFLOW_RECONCILE_RESULT_STATUS } from "../src/core/workflow/dispatch/reconcile-execute.js";
import { executeAndReconcileDispatchedSubworkflowStep } from "../src/core/workflow/dispatch/subworkflow-run.js";
import { deriveDispatchedSubworkflowContext } from "../src/core/workflow/route/subworkflow-dispatch-context.js";
import { loadWorkflowRunDetail } from "../src/core/workflow/run/status.js";
import type { WorkflowRunState } from "../src/core/workflow/run/reducer.js";

/**
 * NGX-498 (RC-4b) — the production flip proof.
 *
 * RC-4 (NGX-497) landed the daemon-dispatchable `subworkflow` *mechanism* but kept
 * production fail-closed: `subworkflow` stayed out of
 * `PHASE1_DISPATCHABLE_EXECUTORS` and no daemon lane composed the child
 * runner. Iterations 1-4 of this ticket landed the keystone child-config /
 * recursion-safety deciders, the route-sourced launch plan, the key-resolved
 * start-or-attach child runner, and the daemon-lane context deriver — each behind
 * a fail-closed gate, referenced only by tests.
 *
 * This file is the flip's bounded dogfood/smoke proof: a *configured* `subworkflow`
 * step now dispatches through the genuine production base dispatch + the wired
 * daemon composition, starting (and observing) a real child workflow run — exactly
 * the "terminal child evidence mirrors back to the parent while non-terminal
 * children remain running/deferred" acceptance criterion. No re-stamp of the
 * scaffold family is needed any more (the step definition carries `subworkflow`
 * directly and the base dispatch no longer fails it closed).
 */

const NOW = 1_700_000_000_000;
const WORKER = "worker-flip";

const CHILD_DEFINITION: WorkflowDefinition = {
  key: "ngx498-child-flip",
  title: "NGX-498 subworkflow child",
  version: 1,
  steps: [
    {
      key: "preflight",
      kind: "preflight",
      executor: "agent-once",
      order: 1,
      required: true,
    },
  ],
};

const PARENT_DEFINITION: WorkflowDefinition = {
  key: "ngx498-parent-flip",
  title: "NGX-498 subworkflow parent",
  version: 1,
  steps: [
    {
      key: "implementation",
      kind: "implementation",
      executor: "subworkflow",
      order: 1,
      required: true,
    },
  ],
};

const PARENT_STEP_ID = "implementation";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-sub-flip-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/**
 * Seed a migrated DB with the parent + child definitions and an approved
 * top-level parent run whose single `subworkflow` step is ready to dispatch. The
 * authored child-launch config rides in the run's `route` JSON, exactly where the
 * production lane sources it.
 */
function seedParentRun(dataDir: string, repoPath: string, runId: string): void {
  const db = openDb(dataDir);
  try {
    persistWorkflowDefinition(db, CHILD_DEFINITION, { now: NOW });
    persistWorkflowDefinition(db, PARENT_DEFINITION, { now: NOW });
    persistWorkflowRunStart(db, {
      definition: PARENT_DEFINITION,
      runId,
      repoPath,
      objective: "Dogfood NGX-498 production subworkflow flip",
      route: {
        subworkflow: {
          child: {
            childDefinitionKey: CHILD_DEFINITION.key,
            childDefinitionVersion: CHILD_DEFINITION.version,
          },
        },
      },
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run(runId, PARENT_STEP_ID);
    db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
      runId,
    );
  } finally {
    db.close();
  }
}

function childRunId(runId: string): string {
  return `${runId}::${PARENT_STEP_ID}::child`;
}

describe("subworkflow production flip — configured step dispatches through daemon start", () => {
  it("starts a real non-terminal child run through bounded daemon start and leaves the parent deferred", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-sub-flip-repo-");
    const runId = "ngx498-flip-daemon-start";
    seedParentRun(dataDir, repoDir, runId);

    let stdout = "";
    let stderr = "";
    const code = await runCli(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json",
      ],
      {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        },
        stderr: {
          write(chunk: string) {
            stderr += chunk;
            return true;
          },
        },
        env: {},
      },
      {},
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const loop = JSON.parse(stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);
    expect(loop["lastWorkflowCode"]).toBe("dispatched");

    const db = openDb(dataDir);
    try {
      // The parent subworkflow step dispatched through the production base lane and
      // is held running while its child run is in flight (deferred).
      const parentStep = getWorkflowStep(db, runId, PARENT_STEP_ID);
      expect(parentStep?.state).toBe("running");

      const attempt = loadExecutorAttempt(
        db,
        deriveDispatchAttemptId(runId, PARENT_STEP_ID, 1),
      );
      expect(attempt?.executor).toBe("subworkflow");
      expect(attempt?.state).toBe("running");

      // A REAL child workflow run now exists, started through the run-start seam.
      const child = loadWorkflowRunDetail(db, childRunId(runId));
      expect(child).not.toBeNull();
      expect(child?.run.state).toBe("pending");
      expect(child?.steps).toHaveLength(CHILD_DEFINITION.steps.length);

      // The child run carries the propagated recursion lineage so its own
      // subworkflow steps can detect a cycle / depth bound.
      const childRow = db
        .prepare("SELECT route_json FROM workflow_runs WHERE id = ?")
        .get(childRunId(runId)) as { route_json: string | null } | undefined;
      const childRoute = JSON.parse(childRow?.route_json ?? "{}") as {
        subworkflow?: { lineage?: Record<string, unknown> };
      };
      expect(childRoute.subworkflow?.lineage).toMatchObject({
        parentRunId: runId,
        parentStepId: PARENT_STEP_ID,
        ancestorDefinitionKeys: [PARENT_DEFINITION.key],
      });

      // The dispatch lease stays held so a later tick can re-check the child.
      expect(getWorkflowLease(db, runId, "dispatch")?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("subworkflow production flip — terminal child evidence mirrors back to the parent", () => {
  function approveAndClaim(db: MomentumDb, runId: string): ClaimedWorkflowStep {
    const claim = claimRunnableWorkflowStep(db, {
      runId,
      stepId: PARENT_STEP_ID,
      holder: WORKER,
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok)
      throw new Error(`test setup: claim failed (${claim.reason})`);
    return claim.claim;
  }

  function finalizeChildRun(
    db: MomentumDb,
    id: string,
    state: WorkflowRunState,
  ): void {
    db.prepare(
      "UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?",
    ).run(state, NOW + 5, id);
  }

  it("mirrors a real succeeded child terminal onto the parent step via the productionized deriver", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-sub-flip-repo-");
    const runId = "ngx498-flip-terminal-mirror";
    seedParentRun(dataDir, repoDir, runId);

    const db = openDb(dataDir);
    try {
      const claim = approveAndClaim(db, runId);

      // The production base dispatch now dispatches the subworkflow step directly —
      // no re-stamp — creating the subworkflow-family scaffold.
      executeWorkflowStepDispatch(claim, {
        db,
        workerId: WORKER,
        now: NOW + 1,
      });
      expect(
        loadExecutorAttempt(
          db,
          deriveDispatchAttemptId(runId, PARENT_STEP_ID, 1),
        )?.executor,
      ).toBe("subworkflow");

      // Tick 1: the real deriver reads the parent run row + route config, resolves
      // the child definition by key, and builds the start-or-attach runner.
      const resolved1 = deriveDispatchedSubworkflowContext(claim, {
        db,
        workerId: WORKER,
        now: NOW + 10,
      });
      expect(resolved1.ok).toBe(true);
      if (!resolved1.ok) throw new Error(resolved1.reason);

      const tick1 = await executeAndReconcileDispatchedSubworkflowStep({
        db,
        runId,
        stepId: PARENT_STEP_ID,
        runSubworkflowChild: resolved1.runSubworkflowChild,
        evidence: resolved1.evidence,
        now: NOW + 10,
      });
      expect(tick1.status).toBe(
        WORKFLOW_EXECUTE_RECONCILE_STATUS.childDeferred,
      );
      expect(getWorkflowStep(db, runId, PARENT_STEP_ID)?.state).toBe("running");

      // The child run reaches its own terminal success.
      finalizeChildRun(db, childRunId(runId), "succeeded");

      // Tick 2: re-derive (start-or-attach to the SAME child) and re-run the
      // producer; the real terminal mirrors onto the parent step via RC-2.
      const resolved2 = deriveDispatchedSubworkflowContext(claim, {
        db,
        workerId: WORKER,
        now: NOW + 50,
      });
      expect(resolved2.ok).toBe(true);
      if (!resolved2.ok) throw new Error(resolved2.reason);

      const tick2 = await executeAndReconcileDispatchedSubworkflowStep({
        db,
        runId,
        stepId: PARENT_STEP_ID,
        runSubworkflowChild: resolved2.runSubworkflowChild,
        evidence: resolved2.evidence,
        now: NOW + 50,
      });
      expect(tick2.status).toBe(
        WORKFLOW_EXECUTE_RECONCILE_STATUS.executedAndReconciled,
      );
      expect(tick2.reconcile?.status).toBe(
        WORKFLOW_RECONCILE_RESULT_STATUS.finalized,
      );

      expect(getWorkflowStep(db, runId, PARENT_STEP_ID)?.state).toBe(
        "succeeded",
      );
      expect(
        loadExecutorAttempt(
          db,
          deriveDispatchAttemptId(runId, PARENT_STEP_ID, 1),
        )?.state,
      ).toBe("succeeded");

      // Exactly one child run exists — start-or-attach never duplicated it.
      const childCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE id = ?")
          .get(childRunId(runId)) as { n: number }
      ).n;
      expect(childCount).toBe(1);

      // Terminal evidence was written under the parent run dir and is tied to the
      // child run id.
      expect(fs.existsSync(resolved2.evidence.executorLogPath)).toBe(true);
      expect(fs.existsSync(resolved2.evidence.resultJsonPath)).toBe(true);
      expect(resolved2.evidence.executorLogPath).toContain(repoDir);

      expect(
        getWorkflowLease(db, runId, "dispatch")?.releasedAt,
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
