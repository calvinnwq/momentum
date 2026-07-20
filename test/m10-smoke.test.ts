import { afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildCli,
  cleanupTempRoots,
  initDisposableRepo,
  makeTempDir,
  runCliBinary,
} from "./helpers/smoke-harness.js";
import {
  workflowHandoffJson,
  workflowRunMonitorJson,
  workflowStatusJson,
} from "./helpers/workflow-smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

describe("Milestone 10 production workflow-lane dispatch smoke (NGX-367)", () => {
  it("drives workflow run start -> approve -> daemon start --max-* -> durable executor rows -> status/handoff/monitor through the built CLI", () => {
    const dataDir = makeTempDir("momentum-smoke-m10-wfdispatch-");
    const repoDir = initDisposableRepo();
    const runId = "wf-smoke-ngx367";

    // workflow run start: materialize the built-in coding workflow run from the
    // first-class start surface (defaults to the coding-workflow definition).
    const start = runCliBinary([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Dogfood NGX-367 production dispatch through the shipped CLI",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(start.code, `workflow run start stderr: ${start.stderr}`).toBe(0);
    expect(JSON.parse(start.stdout)).toMatchObject({
      ok: true,
      runId,
      definitionKey: "coding-workflow",
      state: "pending",
    });

    // workflow run approve: promote preflight + implementation to approved so
    // the first step (preflight, executor family one-shot) is runnable.
    const approve = runCliBinary([
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
      "--json",
    ]);
    expect(approve.code, `workflow run approve stderr: ${approve.stderr}`).toBe(
      0,
    );
    expect(JSON.parse(approve.stdout)).toMatchObject({
      ok: true,
      runId,
      boundary: "through-implementation",
    });

    // daemon start --max-*: the shipped bounded managed loop claims and
    // dispatches the approved workflow step through the production workflowLane
    // with no test-only dependency injection. The lane is no longer inert.
    const daemon = runCliBinary([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(daemon.code, `daemon start stderr: ${daemon.stderr}`).toBe(0);
    expect(daemon.stderr).toBe("");
    const daemonPayload = JSON.parse(daemon.stdout) as {
      loop: Record<string, unknown>;
    };
    expect(daemonPayload.loop["workflowStepsDispatched"]).toBe(1);
    expect(daemonPayload.loop["lastWorkflowCode"]).toBe("dispatched");

    // Durable executor rows exist through the production path, observable from
    // SQLite after the daemon process has exited.
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const invocations = db
        .prepare(
          "SELECT step_key, executor_family, state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .all(runId) as Array<{
        step_key: string;
        executor_family: string;
        state: string;
      }>;
      expect(invocations).toEqual([
        {
          step_key: "preflight",
          executor_family: "one-shot",
          state: "manual_recovery_required",
        },
      ]);

      const rounds = db
        .prepare(
          "SELECT step_key, round_index, state FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .all(runId) as Array<{
        step_key: string;
        round_index: number;
        state: string;
      }>;
      expect(rounds).toEqual([
        {
          step_key: "preflight",
          round_index: 0,
          state: "manual_recovery_required",
        },
      ]);
    } finally {
      db.close();
    }

    // Process-loss observability: status, handoff, and monitor all report the
    // post-dispatch state from durable rows, with no in-memory daemon handle.
    const status = workflowStatusJson(dataDir, [runId]);
    const statusSteps = status["steps"] as Array<{
      stepId: string;
      state: string;
    }>;
    expect(statusSteps.find((step) => step.stepId === "preflight")?.state).toBe(
      "running",
    );

    const handoff = workflowHandoffJson(dataDir, runId);
    expect(handoff["ok"]).toBe(true);
    expect((handoff["run"] as { runId: string }).runId).toBe(runId);
    const handoffSteps = handoff["steps"] as Array<{
      stepId: string;
      state: string;
    }>;
    expect(
      handoffSteps.find((step) => step.stepId === "preflight")?.state,
    ).toBe("running");

    const monitor = workflowRunMonitorJson(dataDir, runId);
    expect(monitor).toMatchObject({ ok: true, runId });
  }, 120_000);
});
