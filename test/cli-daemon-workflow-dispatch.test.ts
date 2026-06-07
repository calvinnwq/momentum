import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";

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
