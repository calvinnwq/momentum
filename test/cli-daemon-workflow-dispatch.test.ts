import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR } from "../src/workflow-dogfood-dispatch.js";

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

function makeTempDir(prefix = "momentum-cli-daemon-wf-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
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
    env
  });
  return { code, stdout, stderr };
}

/**
 * Start the built-in coding workflow run and approve it through the
 * implementation boundary, leaving its first step (`preflight`, executor family
 * `one-shot`) `approved` and runnable — exactly the shipped operator path a
 * dogfood would drive, with no test-only dependency injection.
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
    "Dogfood NGX-367 production dispatch",
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

describe("daemon start production workflow lane (NGX-367)", () => {
  it("advances an approved workflow run through the shipped daemon start --max-* path and records durable executor rows", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx367-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const loop = payload["loop"] as Record<string, unknown>;
    // The shipped managed loop is no longer inert: it claimed and dispatched the
    // approved workflow step and surfaces that as stable loop-summary evidence.
    expect(loop["workflowStepsDispatched"]).toBe(1);
    expect(loop["lastWorkflowCode"]).toBe("dispatched");

    // The dispatched step created durable executor_invocations / executor_rounds
    // rows through the production path, observable after the daemon exits.
    const db = openDb(dataDir);
    try {
      const invocations = db
        .prepare(
          "SELECT step_key, executor_family, state FROM executor_invocations WHERE workflow_run_id = ?"
        )
        .all(runId) as Array<{
        step_key: string;
        executor_family: string;
        state: string;
      }>;
      expect(invocations).toEqual([
        { step_key: "preflight", executor_family: "one-shot", state: "running" }
      ]);

      const rounds = db
        .prepare(
          "SELECT step_key, round_index, state FROM executor_rounds WHERE workflow_run_id = ?"
        )
        .all(runId) as Array<{
        step_key: string;
        round_index: number;
        state: string;
      }>;
      expect(rounds).toEqual([
        { step_key: "preflight", round_index: 1, state: "pending" }
      ]);
    } finally {
      db.close();
    }

    // Process-loss observability: status and monitor report the post-dispatch
    // state from durable rows, without any in-memory daemon handle.
    const statusResult = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as {
      steps: Array<{ stepId: string; state: string }>;
    };
    const preflight = statusPayload.steps.find((s) => s.stepId === "preflight");
    expect(preflight?.state).toBe("running");

    const monitorResult = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(monitorResult.code).toBe(0);
  });

  it("dispatches the next approved step after the first dispatch is recovered and terminalized", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx390-second-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const firstDispatch = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(firstDispatch.code).toBe(0);
    expect(JSON.parse(firstDispatch.stdout).loop.workflowStepsDispatched).toBe(1);

    const db = openDb(dataDir);
    try {
      db.prepare(
        `UPDATE workflow_leases
            SET heartbeat_at = ?, expires_at = ?
          WHERE run_id = ? AND lease_kind = ?`
      ).run(1, 2, runId, "dispatch");
    } finally {
      db.close();
    }

    const recoverLease = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(recoverLease.code).toBe(0);
    expect(JSON.parse(recoverLease.stdout).loop.workflowStepsDispatched).toBe(0);

    const terminalizePreflight = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "preflight",
      "--state",
      "succeeded",
      "--reason",
      "test terminalizes preflight before second dispatch",
      "--actor",
      "vitest",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(terminalizePreflight.code).toBe(0);
    expect(JSON.parse(terminalizePreflight.stdout)).toMatchObject({
      ok: true,
      stepId: "preflight",
      state: "succeeded",
      runState: "approved"
    });

    const secondDispatch = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "3",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(secondDispatch.code).toBe(0);
    const loop = JSON.parse(secondDispatch.stdout).loop as Record<string, unknown>;
    expect(loop["exitReason"]).toBe("max_loop_iterations");
    expect(loop["iterations"]).toBe(3);
    expect(loop["workflowStepsDispatched"]).toBe(1);

    const finalDb = openDb(dataDir);
    try {
      const steps = finalDb
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(steps.slice(0, 2)).toEqual([
        { step_id: "preflight", state: "succeeded" },
        { step_id: "implementation", state: "running" }
      ]);

      const invocations = finalDb
        .prepare(
          "SELECT step_key, executor_family, state FROM executor_invocations WHERE workflow_run_id = ? ORDER BY created_at"
        )
        .all(runId) as Array<{
        step_key: string;
        executor_family: string;
        state: string;
      }>;
      expect(invocations).toEqual([
        { step_key: "preflight", executor_family: "one-shot", state: "running" },
        { step_key: "implementation", executor_family: "goal-loop", state: "running" }
      ]);
    } finally {
      finalDb.close();
    }
  });

  it("dispatches two approved steps in one dogfood-opted-in daemon start when each step terminalizes safely (NGX-391)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-cli-multi-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    // A SINGLE `daemon start` process, opted into the dogfood terminalize-and-
    // continue lane against this isolated data dir. Unlike the NGX-390 proof —
    // which needed three separate processes plus a manual update-step — this one
    // process dispatches preflight, terminalizes it safely, then dispatches
    // implementation.
    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "5",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR]: "1" }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    // The CLI dogfood receipt: loop iterations and the >= 2 dispatch count.
    expect(loop["workflowStepsDispatched"]).toBe(2);
    expect(loop["iterations"]).toBe(5);
    expect(loop["exitReason"]).toBe("max_loop_iterations");
    expect(loop["lastWorkflowCode"]).toBe("idle");

    const db = openDb(dataDir);
    try {
      const steps = db
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(steps.slice(0, 2)).toEqual([
        { step_id: "preflight", state: "succeeded" },
        { step_id: "implementation", state: "succeeded" }
      ]);

      // The dispatch lease taken for each step was released on terminal — no
      // lease corruption strands the run.
      const openLeases = db
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not terminalize or re-dispatch in a default daemon start without the dogfood opt-in (NGX-391 gate)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-default-single-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    // The same bounded loop, but with NO dogfood opt-in: the production dispatch
    // holds preflight `running` and never terminalizes it, so the run scans as
    // busy and no second step is ever dispatched — `>= 2` happens only when a
    // step terminalizes safely.
    const result = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "5",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);

    const db = openDb(dataDir);
    try {
      const preflight = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      // The dispatched step stays `running` (held by its dispatch lease); nothing
      // advanced it.
      expect(preflight?.state).toBe("running");
    } finally {
      db.close();
    }
  });

  it("leaves the workflow lane untouched for register-only daemon start", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx367-register-only";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run([
      "daemon",
      "start",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    // Register-only mode records a daemon run and exits: no managed loop ran, so
    // there is no loop summary and the workflow scheduler was never entered.
    expect(payload["loop"]).toBeUndefined();

    const db = openDb(dataDir);
    try {
      const invocationCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_invocations WHERE workflow_run_id = ?"
          )
          .get(runId) as { count: number }
      ).count;
      expect(invocationCount).toBe(0);

      const preflight = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      // The approved step stays approved; nothing claimed or advanced it.
      expect(preflight?.state).toBe("approved");
    } finally {
      db.close();
    }
  });
});
