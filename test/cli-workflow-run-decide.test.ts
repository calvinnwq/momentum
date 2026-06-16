import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertWorkflowGate,
  loadWorkflowGate,
  type NewWorkflowGate
} from "../src/core/workflow/gate-persist.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-decide-"): string {
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

const SEED_NOW = 1_730_000_000_000;

function seedRun(db: MomentumDb, runId: string): void {
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
    null,
    "{}",
    "{}",
    null,
    null,
    0,
    null,
    null,
    null,
    null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedGate(
  dataDir: string,
  overrides: Partial<NewWorkflowGate> & { gateId: string; workflowRunId: string }
): void {
  const db = openDb(dataDir);
  try {
    seedRun(db, overrides.workflowRunId);
    const gate: NewWorkflowGate = {
      gateId: overrides.gateId,
      workflowRunId: overrides.workflowRunId,
      stepRunId: overrides.stepRunId ?? "step-1",
      targetScope: overrides.targetScope ?? "step",
      gateType: overrides.gateType ?? "operator_decision_required",
      reason: overrides.reason ?? "no-mistakes review found an important finding",
      evidence: overrides.evidence ?? "finding://nm-1",
      allowedActions:
        overrides.allowedActions ?? ["fix", "skip", "approve_as_is"],
      recommendedAction: overrides.recommendedAction ?? "fix",
      policyEnvelope: overrides.policyEnvelope ?? ["fix"]
    };
    insertWorkflowGate(db, gate, { now: SEED_NOW });
  } finally {
    db.close();
  }
}

function loadGate(dataDir: string, gateId: string) {
  const db = openDb(dataDir);
  try {
    return loadWorkflowGate(db, gateId);
  } finally {
    db.close();
  }
}

describe("momentum workflow run decide (NGX-352)", () => {
  it("requires a <gate-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "decide",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "gate_id_required"
    });
  });

  it("requires a non-blank --action", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "action_required"
    });
  });

  it("requires a non-blank --actor", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "actor_required"
    });
  });

  it("rejects an invalid --mode", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--mode",
      "robot",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "invalid_mode"
    });
  });

  it("refuses an unknown gate", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-missing",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "gate_not_found",
      gateId: "gate-missing"
    });
  });

  it("resolves an open gate by an operator and persists the resolution", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "skip",
      "--actor",
      "calvin",
      "--note",
      "deferring to follow-up",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run decide",
      gateId: "gate-1",
      runId: "run-1",
      targetScope: "step",
      gateType: "operator_decision_required",
      chosenAction: "skip",
      resolvedBy: "calvin",
      mode: "operator",
      resolution: "deferring to follow-up"
    });
    expect(typeof payload["resolvedAt"]).toBe("number");

    const persisted = loadGate(dataDir, "gate-1");
    expect(persisted?.resolvedAt).not.toBeNull();
    expect(persisted?.chosenAction).toBe("skip");
    expect(persisted?.resolvedBy).toBe("calvin");
    expect(persisted?.resolutionMode).toBe("operator");
    expect(persisted?.resolution).toBe("deferring to follow-up");
  });

  it("defaults the decision mode to operator", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ mode: "operator", resolution: null });
  });

  it("refuses an action outside the gate's allowed actions", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "delete-everything",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "action_not_allowed",
      gateId: "gate-1"
    });
    expect(loadGate(dataDir, "gate-1")?.resolvedAt).toBeNull();
  });

  it("lets a delegated policy auto-apply an action inside the envelope", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--actor",
      "agent-recommended-important",
      "--mode",
      "delegated",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      chosenAction: "fix",
      mode: "delegated",
      resolvedBy: "agent-recommended-important"
    });
  });

  it("pauses a delegated action outside the envelope for an operator", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "skip",
      "--actor",
      "agent-recommended-important",
      "--mode",
      "delegated",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "delegated_action_outside_envelope",
      gateId: "gate-1"
    });
    expect(loadGate(dataDir, "gate-1")?.resolvedAt).toBeNull();
  });

  it("refuses to re-decide an already-resolved gate", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const first = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const second = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "skip",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(1);
    const payload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "gate_already_resolved"
    });
    // The first decision is preserved.
    expect(loadGate(dataDir, "gate-1")?.chosenAction).toBe("fix");
  });

  it("emits a human-readable text summary without --json", async () => {
    const dataDir = makeTempDir();
    seedGate(dataDir, { gateId: "gate-1", workflowRunId: "run-1" });
    const result = await run([
      "workflow",
      "run",
      "decide",
      "gate-1",
      "--action",
      "fix",
      "--actor",
      "calvin",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gate-1");
    expect(result.stdout).toContain("fix");
    expect(result.stdout).toContain("calvin");
  });
});
