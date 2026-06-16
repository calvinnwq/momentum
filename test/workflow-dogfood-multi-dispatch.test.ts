import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { runDaemonLoop } from "../src/core/daemon/loop.js";
import { startDaemonRun } from "../src/core/daemon/runs.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS
} from "../src/core/workflow/dispatch-execute.js";
import { createTerminalizingWorkflowDispatch } from "../src/core/workflow/dogfood-dispatch.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/scheduler.js";
import type { WorkflowStepDispatch } from "../src/core/workflow/scheduler.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-dogfood-multidispatch-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });
  return { code, stdout, stderr };
}

/**
 * Start the built-in coding-workflow run and approve it through the
 * implementation boundary, leaving `preflight` (one-shot) and `implementation`
 * (goal-loop) both `approved` and runnable in order — the shipped operator path
 * a dogfood drives, with no test-only dependency injection.
 */
async function startApprovedCodingRun(
  dataDir: string,
  repoDir: string,
  runId: string
): Promise<void> {
  const startResult = await run([
    "workflow",
    "run",
    "start",
    "--run-id",
    runId,
    "--repo",
    repoDir,
    "--objective",
    "Dogfood NGX-391 multi-dispatch terminalization proof",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(startResult.code).toBe(0);

  const approveResult = await run([
    "workflow",
    "run",
    "approve",
    runId,
    "--approval-boundary",
    "through-implementation",
    "--phrase",
    `approve plan ${runId} through-implementation`,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(approveResult.code).toBe(0);
}

describe("dogfood single-process multi-dispatch terminalization (NGX-391)", () => {
  it("dispatches two coding-workflow steps in one daemon loop when each terminalizes safely", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-multi-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const db = openDb(dataDir);
    let loopResult: Awaited<ReturnType<typeof runDaemonLoop>>;
    try {
      const { runId: daemonRunId } = startDaemonRun(db, {
        pid: process.pid,
        host: os.hostname() || null
      });
      // A SINGLE managed daemon loop — exactly what `daemon start --max-loop-*`
      // runs — driving the terminalize-and-continue fixture over the production
      // dispatch seam.
      loopResult = await runDaemonLoop({
        db,
        dataDir,
        runId: daemonRunId,
        workerId: "dogfood-ngx391",
        maxLoopIterations: 5,
        pollIntervalMs: 0,
        workflowLane: {
          dispatch: createTerminalizingWorkflowDispatch(executeWorkflowStepDispatch)
        }
      });
    } finally {
      db.close();
    }

    // CORE PROOF: one daemon process dispatched two distinct local steps because
    // the earlier step terminalized safely between them.
    expect(loopResult.workflowStepsDispatched).toBe(2);
    expect(loopResult.exitReason).toBe("max_loop_iterations");
    expect(loopResult.iterations).toBe(5);
    // After both dispatches the third+ ticks find no runnable step and idle —
    // proof the loop stops dispatching rather than over-dispatching.
    expect(loopResult.lastWorkflowCode).toBe("idle");

    // Durable proof read back from SQLite (no in-memory daemon handle, no
    // Discord-derived reconstruction).
    const verifyDb = openDb(dataDir);
    try {
      const steps = verifyDb
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      // Both approved local steps terminalized to `succeeded`; every step past
      // the implementation approval boundary stays `pending`.
      expect(steps).toEqual([
        { step_id: "preflight", state: "succeeded" },
        { step_id: "implementation", state: "succeeded" },
        { step_id: "postflight", state: "pending" },
        { step_id: "no-mistakes", state: "pending" },
        { step_id: "merge-cleanup", state: "pending" },
        { step_id: "linear-refresh", state: "pending" }
      ]);

      // Exactly one executor invocation per dispatched step — no duplicate
      // dispatch — created through the production dispatch path.
      const invocations = verifyDb
        .prepare(
          "SELECT step_key, executor_family FROM executor_invocations WHERE workflow_run_id = ? ORDER BY created_at"
        )
        .all(runId) as Array<{ step_key: string; executor_family: string }>;
      expect(invocations).toEqual([
        { step_key: "preflight", executor_family: "one-shot" },
        { step_key: "implementation", executor_family: "goal-loop" }
      ]);

      // No dispatch lease left outstanding — no lease corruption.
      const openLeases = verifyDb
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([]);

      // The terminalized steps carry the dogfood marker, not a real executor
      // result.
      const digests = verifyDb
        .prepare(
          "SELECT result_digest FROM workflow_steps WHERE run_id = ? AND state = 'succeeded' ORDER BY step_order"
        )
        .all(runId) as Array<{ result_digest: string | null }>;
      for (const row of digests) {
        expect(row.result_digest).toContain("dogfood-terminalize");
      }
    } finally {
      verifyDb.close();
    }

    // `workflow status` explains the post-run state from durable rows.
    const status = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      run: { state: string; needsManualRecovery: boolean };
      steps: Array<{ stepId: string; state: string }>;
    };
    expect(statusPayload.run.needsManualRecovery).toBe(false);
    const statusStepStates = Object.fromEntries(
      statusPayload.steps.map((s) => [s.stepId, s.state])
    );
    expect(statusStepStates["preflight"]).toBe("succeeded");
    expect(statusStepStates["implementation"]).toBe("succeeded");
    expect(statusStepStates["postflight"]).toBe("pending");

    // `workflow run monitor` explains the post-run state and the next action.
    const monitor = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(monitor.code).toBe(0);
    const monitorPayload = JSON.parse(monitor.stdout) as {
      ok: boolean;
      terminal: boolean;
      blocked: boolean;
      needsManualRecovery: boolean;
      nextAction: { code: string };
    };
    expect(monitorPayload.ok).toBe(true);
    expect(monitorPayload.terminal).toBe(false);
    expect(monitorPayload.blocked).toBe(false);
    expect(monitorPayload.needsManualRecovery).toBe(false);
    // The run is parked awaiting the postflight approval the boundary withheld.
    expect(monitorPayload.nextAction.code).toBe("await_approval");

    // `workflow handoff` explains the same post-run state for continuity.
    const handoff = await run([
      "workflow",
      "handoff",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(handoff.code).toBe(0);
    const handoffPayload = JSON.parse(handoff.stdout) as {
      ok: boolean;
      steps: Array<{ stepId: string; state: string }>;
      nextAction: { code: string };
    };
    expect(handoffPayload.ok).toBe(true);
    expect(handoffPayload.nextAction.code).toBe("await_approval");
    const handoffStepStates = Object.fromEntries(
      handoffPayload.steps.map((s) => [s.stepId, s.state])
    );
    expect(handoffStepStates["preflight"]).toBe("succeeded");
    expect(handoffStepStates["implementation"]).toBe("succeeded");
  });
});

describe("dogfood terminalize fails closed when the step cannot be finished (NGX-391)", () => {
  it("throws and leaves the dispatch lease held when finishWorkflowStep refuses the terminal transition", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-terminalize-guard";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const db = openDb(dataDir);
    try {
      const now = Date.now();
      const claimResult = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "preflight",
        holder: "dogfood-guard",
        leaseExpiresAt: now + 60_000,
        now
      });
      expect(claimResult.ok).toBe(true);
      if (!claimResult.ok) return;

      // A base dispatch that reports `dispatched` WITHOUT moving the step to
      // `running`, so the terminalize's `approved -> succeeded` finish is an
      // invalid transition — the off-nominal outcome the guard must fail closed
      // on instead of releasing the lease over a step it never terminalized.
      const baseDispatchThatNeverStarts: WorkflowStepDispatch = () => ({
        status: WORKFLOW_DISPATCH_RESULT_STATUS.dispatched
      });
      const wrapped = createTerminalizingWorkflowDispatch(
        baseDispatchThatNeverStarts
      );

      expect(() =>
        wrapped(claimResult.claim, { db, workerId: "dogfood-guard", now })
      ).toThrow(/could not be finished succeeded/);

      // The dispatch lease the claim acquired is still held: the failed
      // terminalize rolled back rather than committing a released lease over a
      // non-terminalized step.
      const openLeases = db
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([{ lease_kind: "dispatch" }]);

      // The step was never silently marked succeeded.
      const step = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string };
      expect(step.state).toBe("approved");
    } finally {
      db.close();
    }
  });
});
