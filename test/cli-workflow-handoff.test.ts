import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/db.js";
import { insertWorkflowGate } from "../src/workflow-gate-persist.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-handoff-"): string {
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

function seedRunningRun(db: MomentumDb, runId: string): void {
  const now = Date.now();
  const recent = now - 30_000;
  const future = now + 10 * 60 * 1000;
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, source_artifact_path, plan_json,
        repo_path, objective, issue_scope_json, route_json,
        approval_boundary, skill_revision,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        started_at, finished_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "running",
    "agent-workflow",
    null,
    "{}",
    null,
    "exercise handoff envelope",
    "{}",
    "{}",
    "through-merge-cleanup",
    null,
    0,
    null,
    null,
    recent,
    null,
    now,
    now
  );
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "implementation",
    "implementation",
    "running",
    1,
    1,
    null,
    null,
    null,
    recent,
    null,
    now,
    now
  );
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "managed-step",
    "pipeline",
    recent,
    future,
    recent,
    null,
    "auto-release",
    now,
    now
  );
}

describe("momentum workflow handoff", () => {
  it("requires <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "handoff",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow handoff",
      code: "run_id_required"
    });
  });

  it("returns run_not_found for an unknown run-id", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "handoff",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow handoff",
      code: "run_not_found",
      runId: "cwfp-missing"
    });
  });

  it("rejects an unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "handoff",
      "cwfp-x",
      "extra",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for workflow handoff: extra"
    );
  });

  it("emits a machine-readable envelope with schema/nextAction/monitor", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunningRun(db, "cwfp-handoff01");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "handoff",
      "cwfp-handoff01",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      schemaVersion: number;
      generatedAt: number;
      run: { runId: string; state: string };
      steps: Array<{ stepId: string }>;
      leases: Array<{ leaseKind: string }>;
      monitor: {
        runState: string;
        nextAction: { code: string; stepId: string | null };
      };
      nextAction: {
        code: string;
        stepId: string | null;
        leaseKind: string | null;
        detail: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow handoff");
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.generatedAt).toBe("number");
    expect(payload.run.runId).toBe("cwfp-handoff01");
    expect(payload.run.state).toBe("running");
    expect(payload.steps.map((s) => s.stepId)).toEqual(["implementation"]);
    expect(payload.leases.map((l) => l.leaseKind)).toEqual(["managed-step"]);
    expect(payload.monitor.runState).toBe("running");
    expect(payload.nextAction.code).toBe("resume_running");
    expect(payload.nextAction.stepId).toBe("implementation");
    expect(payload.nextAction.leaseKind).toBe("managed-step");
    expect(payload.nextAction.detail.length).toBeGreaterThan(0);
  });

  it("renders text output with schema-version and next-action lines", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunningRun(db, "cwfp-text-handoff");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "handoff",
      "cwfp-text-handoff",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workflow handoff: cwfp-text-handoff");
    expect(result.stdout).toContain("Schema version: 1");
    expect(result.stdout).toContain("Workflow run: cwfp-text-handoff");
    expect(result.stdout).toContain("- Next action: resume_running");
  });

  it("surfaces open workflow gates in the handoff envelope (JSON and text)", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunningRun(db, "cwfp-handoffgate");
      insertWorkflowGate(
        db,
        {
          gateId: "handoff-gate-1",
          workflowRunId: "cwfp-handoffgate",
          targetScope: "workflow",
          gateType: "approval_required",
          reason: "approve before external apply",
          allowedActions: ["approve", "reject"],
          recommendedAction: "approve",
          policyEnvelope: []
        },
        { now: Date.now() }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "handoff",
      "cwfp-handoffgate",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      gates: Array<{
        gateId: string;
        targetScope: string;
        gateType: string;
        open: boolean;
        allowedActions: string[];
      }>;
    };
    expect(payload.gates.map((g) => g.gateId)).toEqual(["handoff-gate-1"]);
    expect(payload.gates[0]).toMatchObject({
      targetScope: "workflow",
      gateType: "approval_required",
      open: true,
      allowedActions: ["approve", "reject"]
    });

    const textResult = await run([
      "workflow",
      "handoff",
      "cwfp-handoffgate",
      "--data-dir",
      dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Gates: 1 (open: 1)");
    expect(textResult.stdout).toContain("handoff-gate-1");
    expect(textResult.stdout).toContain("OPEN");
  });
});
