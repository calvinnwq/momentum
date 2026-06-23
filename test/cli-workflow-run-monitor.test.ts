import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertWorkflowGate,
  resolveWorkflowGate
} from "../src/core/workflow/gate-persist.js";
import { parseWorkflowRunImport } from "../src/core/workflow/run-import.js";
import { persistWorkflowRunImport } from "../src/core/workflow/run-import-persist.js";
import {
  MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
} from "../src/core/workflow/run-start.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-monitor-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeLedger(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
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
// Far-future expiry so classifyWorkflowLease treats the lease as fresh against
// the CLI's real Date.now(); a past expiry (5_000) is always stale.
const FRESH_EXPIRY = 9_999_999_999_999;
const STALE_EXPIRY = 5_000;

function seedRun(
  db: MomentumDb,
  input: {
    runId: string;
    state: string;
    source?: string;
    needsManualRecovery?: boolean;
    manualRecoveryReason?: string | null;
  }
): void {
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
    input.runId,
    input.state,
    input.source ?? "agent-workflow",
    null,
    "{}",
    null,
    null,
    "{}",
    "{}",
    null,
    null,
    input.needsManualRecovery ? 1 : 0,
    input.manualRecoveryReason ?? null,
    input.needsManualRecovery ? SEED_NOW : null,
    null,
    null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedStep(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    kind: string;
    state?: string;
    order: number;
    required?: boolean;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, result_digest, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state ?? "pending",
    input.order,
    input.required === false ? 0 : 1,
    null,
    null,
    null,
    null,
    null,
    null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedLease(
  db: MomentumDb,
  input: {
    runId: string;
    leaseKind: string;
    expiresAt: number;
    stalePolicy?: string;
    releasedAt?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.leaseKind,
    `holder:${input.runId}`,
    1_000,
    input.expiresAt,
    1_000,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    SEED_NOW,
    SEED_NOW
  );
}

function readStepState(
  dataDir: string,
  runId: string,
  stepId: string
): string | undefined {
  const db = openDb(dataDir);
  try {
    const row = db
      .prepare(
        "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
      )
      .get(runId, stepId) as { state: string } | undefined;
    return row?.state;
  } finally {
    db.close();
  }
}

function readMonitorDigests(
  dataDir: string,
  runId: string
): { seen: string | null; emitted: string | null } {
  const db = openDb(dataDir);
  try {
    const row = db
      .prepare(
        `SELECT monitor_last_seen_digest AS seen,
                monitor_last_emitted_digest AS emitted
           FROM workflow_runs WHERE id = ?`
      )
      .get(runId) as { seen: string | null; emitted: string | null } | undefined;
    return { seen: row?.seen ?? null, emitted: row?.emitted ?? null };
  } finally {
    db.close();
  }
}

function parseImportOrThrow(runDir: string) {
  const parsed = parseWorkflowRunImport(runDir);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.import;
}

describe("momentum workflow run monitor (NGX-328)", () => {
  it("requires a <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "monitor",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run monitor",
      code: "run_id_required"
    });
  });

  it("refuses an unknown run", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "monitor",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run monitor",
      code: "run_not_found",
      runId: "cwfp-missing"
    });
  });

  it("returns data_dir_failed when the database cannot be opened", async () => {
    const dataDir = path.join(makeTempDir(), "not-a-directory");
    fs.writeFileSync(dataDir, "not a directory");

    const result = await run([
      "workflow",
      "run",
      "monitor",
      "cwfp-db-failed",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run monitor",
      code: "data_dir_failed",
      dataDir,
      runId: "cwfp-db-failed"
    });
  });

  it("emits a stable JSON envelope for a healthy running step", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-running";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run monitor",
      schemaVersion: 1,
      runId,
      runState: "running",
      stepState: "running",
      terminal: false,
      blocked: false,
      needsManualRecovery: false,
      disposition: "wait",
      reportable: false,
      reportReason: "in_progress",
      recovery: null
    });
    expect((payload["nextAction"] as Record<string, unknown>)["code"]).toBe(
      "resume_running"
    );
    expect(typeof payload["generatedAt"]).toBe("number");
  });

  it("reports a terminally succeeded run", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-done";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "succeeded" });
      seedStep(db, {
        runId,
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runState: "succeeded",
      terminal: true,
      disposition: "report",
      reportable: true,
      reportReason: "terminal_succeeded"
    });
  });

  it("asks for operator recovery when a required step failed", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-failed";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "failed" });
      seedStep(db, {
        runId,
        stepId: "no-mistakes",
        kind: "no-mistakes",
        state: "failed",
        order: 1
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runState: "failed",
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required"
    });
    expect((payload["recovery"] as Record<string, unknown>)["code"]).toBe(
      "failed_required_step"
    );
  });

  it("escalates to recovery on a stale running step that lost its lease", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-stale";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: STALE_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      disposition: "recover",
      reportReason: "recovery_required"
    });
    expect((payload["recovery"] as Record<string, unknown>)["code"]).toBe(
      "stale_running_step"
    );
  });

  it("reports monitor drift from an imported advisory snapshot", async () => {
    const dataDir = makeTempDir();
    const artifactRoot = makeTempDir(
      "momentum-cli-workflow-run-monitor-artifacts-"
    );
    const runId = "cwfp-drift";
    const runDir = path.join(artifactRoot, runId);
    writeJsonFile(path.join(runDir, "plan.json"), {
      runId,
      schemaVersion: 1,
      taskFlow: { childTasks: [{ stepId: "implementation" }] }
    });
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-29T00:00:00Z"
      }
    ]);
    writeJsonFile(path.join(runDir, "monitor.json"), {
      lastSeenState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: "stale-digest",
      lastEmittedDigest: "stale-digest"
    });

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseImportOrThrow(runDir), {
        now: SEED_NOW
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runState: "running",
      disposition: "report",
      reportable: true,
      reportReason: "monitor_drift"
    });
    expect(payload["monitorDrift"]).toMatchObject({
      advisoryState: "succeeded",
      advisoryTerminal: true,
      actualState: "running",
      drifted: true,
      reason: "monitor_says_terminal_but_running"
    });
    expect((payload["recovery"] as Record<string, unknown>)["code"]).toBe(
      "monitor_drift_stale"
    );
  });

  it("reports monitor drift when an imported advisory points at an old step", async () => {
    const dataDir = makeTempDir();
    const artifactRoot = makeTempDir(
      "momentum-cli-workflow-run-monitor-artifacts-"
    );
    const runId = "cwfp-step-drift";
    const runDir = path.join(artifactRoot, runId);
    writeJsonFile(path.join(runDir, "plan.json"), {
      runId,
      schemaVersion: 1,
      taskFlow: {
        childTasks: [{ stepId: "preflight" }, { stepId: "implementation" }]
      }
    });
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "preflight",
        status: "complete",
        ts: "2026-05-29T00:00:00Z"
      },
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-29T00:01:00Z"
      }
    ]);
    writeJsonFile(path.join(runDir, "monitor.json"), {
      lastSeenState: "running",
      terminal: false,
      step: "preflight",
      lastSeenDigest: "stale-digest",
      lastEmittedDigest: "stale-digest"
    });

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseImportOrThrow(runDir), {
        now: SEED_NOW
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runState: "running",
      disposition: "report",
      reportable: true,
      reportReason: "monitor_drift"
    });
    expect(payload["activeStep"]).toMatchObject({
      stepId: "implementation"
    });
    expect(payload["monitorDrift"]).toMatchObject({
      advisoryState: "running",
      advisoryTerminal: false,
      actualState: "running",
      drifted: true,
      reason: "monitor_step_mismatch"
    });
    expect((payload["recovery"] as Record<string, unknown>)["code"]).toBe(
      "monitor_drift_stale"
    );
  });

  it("renders a text monitor summary", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-text";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Workflow run monitor: ${runId}`);
    expect(result.stdout).toContain("Disposition: wait");
    expect(result.stdout).toContain("Next action: resume_running");
  });

  it("surfaces open and resolved workflow gates in the monitor envelope (JSON and text)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-gates";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
      insertWorkflowGate(
        db,
        {
          gateId: "gate-open-1",
          workflowRunId: runId,
          targetScope: "workflow",
          gateType: "approval_required",
          reason: "operator must approve external apply",
          allowedActions: ["approve", "reject"],
          recommendedAction: "approve",
          policyEnvelope: []
        },
        { now: SEED_NOW }
      );
      insertWorkflowGate(
        db,
        {
          gateId: "gate-done-1",
          workflowRunId: runId,
          stepRunId: "implementation",
          targetScope: "step",
          gateType: "operator_decision_required",
          reason: "decide how to handle a verification failure",
          allowedActions: ["fix", "skip", "abort"],
          recommendedAction: "fix",
          policyEnvelope: ["fix"]
        },
        { now: SEED_NOW }
      );
      resolveWorkflowGate(
        db,
        "gate-done-1",
        { action: "fix", actor: "calvin", mode: "operator" },
        { now: SEED_NOW + 1 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { gates: number; gatesOpen: number };
      gates: Array<{
        gateId: string;
        targetScope: string;
        gateType: string;
        open: boolean;
        allowedActions: string[];
        resolvedBy: string | null;
        chosenAction: string | null;
      }>;
    };
    expect(payload.counts.gates).toBe(2);
    expect(payload.counts.gatesOpen).toBe(1);
    expect(payload.gates.map((g) => g.gateId).sort()).toEqual([
      "gate-done-1",
      "gate-open-1"
    ]);
    const open = payload.gates.find((g) => g.gateId === "gate-open-1");
    expect(open).toMatchObject({
      targetScope: "workflow",
      gateType: "approval_required",
      open: true,
      allowedActions: ["approve", "reject"]
    });
    const resolved = payload.gates.find((g) => g.gateId === "gate-done-1");
    expect(resolved).toMatchObject({
      open: false,
      resolvedBy: "calvin",
      chosenAction: "fix"
    });

    const textResult = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Gates: 2 (open: 1)");
    expect(textResult.stdout).toContain("gate-open-1");
  });

  it("never mutates durable state (read-only)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-readonly";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: STALE_EXPIRY
      });
    } finally {
      db.close();
    }

    const before = readStepState(dataDir, runId, "implementation");
    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    expect(readStepState(dataDir, runId, "implementation")).toBe(before);
  });

  it("includes a native progress digest tick that emits on first observation (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-progress";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      progress: {
        phase: string;
        changed: boolean;
        emit: boolean;
        terminal: boolean;
        cleanup: string;
        currentStep: string | null;
        lastEvent: string;
        nextAction: string;
        blockerReason: string | null;
        digest: string;
      };
    };
    expect(payload.progress).toMatchObject({
      phase: "advancing",
      changed: true,
      emit: true,
      terminal: false,
      cleanup: "none",
      currentStep: "implementation",
      lastEvent: "step:implementation:running",
      nextAction: "resume_running",
      blockerReason: null
    });
    expect(payload.progress.digest.startsWith("sha256:")).toBe(true);
  });

  it("suppresses an unchanged repeat progress tick against the persisted emitted digest (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-progress-suppress";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const first = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      progress: { digest: string; emit: boolean; changed: boolean };
    };
    expect(firstPayload.progress.emit).toBe(true);

    // Persist the emitted digest as the suppression baseline (the activation
    // writer is a follow-up slice; here we assert the read-side suppression).
    const persistDb = openDb(dataDir);
    try {
      persistDb
        .prepare(
          "UPDATE workflow_runs SET monitor_last_emitted_digest = ? WHERE id = ?"
        )
        .run(firstPayload.progress.digest, runId);
    } finally {
      persistDb.close();
    }

    const second = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      progress: { digest: string; emit: boolean; changed: boolean };
    };
    expect(secondPayload.progress.digest).toBe(firstPayload.progress.digest);
    expect(secondPayload.progress.changed).toBe(false);
    expect(secondPayload.progress.emit).toBe(false);
  });

  it("marks a terminally succeeded run with an explicit release cleanup (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-progress-terminal";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "succeeded" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      progress: { phase: string; terminal: boolean; cleanup: string };
    };
    expect(payload.progress).toMatchObject({
      phase: "terminal",
      terminal: true,
      cleanup: "release"
    });
  });

  it("renders the native progress phase and cleanup in the text monitor summary (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-progress-text";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Progress phase: advancing");
    expect(result.stdout).toContain("Progress changed: true (emit: true)");
    expect(result.stdout).toContain("Last event: step:implementation:running");
    expect(result.stdout).toContain("Cleanup: none");
  });

  it("persists the emitted digest as the suppression baseline under --advance (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-first";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    expect(readMonitorDigests(dataDir, runId).emitted).toBeNull();

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      progress: { emit: boolean; advanced: boolean; digest: string };
    };
    expect(payload.progress.emit).toBe(true);
    expect(payload.progress.advanced).toBe(true);

    const digests = readMonitorDigests(dataDir, runId);
    expect(digests.emitted).toBe(payload.progress.digest);
    expect(digests.seen).toBe(payload.progress.digest);
  });

  it("refuses --advance for non-native workflow runs without mutating digests (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-imported";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
      db.prepare(
        `UPDATE workflow_runs
            SET monitor_last_seen_digest = ?,
                monitor_last_emitted_digest = ?
          WHERE id = ?`
      ).run("sha256:seen-baseline", "sha256:emitted-baseline", runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run monitor",
      code: "advance_unsupported_source",
      runId
    });
    expect(readMonitorDigests(dataDir, runId)).toEqual({
      seen: "sha256:seen-baseline",
      emitted: "sha256:emitted-baseline"
    });
  });

  it("suppresses a second unchanged --advance tick end-to-end from durable state (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-suppress";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const first = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      progress: { emit: boolean; advanced: boolean; digest: string };
    };
    expect(firstPayload.progress.emit).toBe(true);
    expect(firstPayload.progress.advanced).toBe(true);

    // No manual SQL seeding here: the first --advance already persisted the
    // baseline, so a second identical tick must suppress purely from durable
    // state.
    const second = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      progress: { changed: boolean; emit: boolean; advanced: boolean; digest: string };
    };
    expect(secondPayload.progress.digest).toBe(firstPayload.progress.digest);
    expect(secondPayload.progress.changed).toBe(false);
    expect(secondPayload.progress.emit).toBe(false);
    expect(secondPayload.progress.advanced).toBe(false);
    expect(readMonitorDigests(dataDir, runId).emitted).toBe(
      firstPayload.progress.digest
    );
  });

  it("re-emits and re-advances the baseline after meaningful state changes (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-rearm";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const first = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const firstDigest = (
      JSON.parse(first.stdout) as { progress: { digest: string } }
    ).progress.digest;

    // Durable state advances: the running step completes.
    const mutateDb = openDb(dataDir);
    try {
      mutateDb
        .prepare(
          "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_id = ?"
        )
        .run(runId, "implementation");
    } finally {
      mutateDb.close();
    }

    const second = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      progress: { changed: boolean; emit: boolean; advanced: boolean; digest: string };
    };
    expect(secondPayload.progress.digest).not.toBe(firstDigest);
    expect(secondPayload.progress.changed).toBe(true);
    expect(secondPayload.progress.emit).toBe(true);
    expect(secondPayload.progress.advanced).toBe(true);
    expect(readMonitorDigests(dataDir, runId).emitted).toBe(
      secondPayload.progress.digest
    );
  });

  it("does not advance the baseline without --advance, staying read-only (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-readonly";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      progress: { advanced: boolean };
    };
    expect(payload.progress.advanced).toBe(false);
    expect(readMonitorDigests(dataDir, runId).emitted).toBeNull();
  });

  it("reports the advanced flag in the text monitor summary under --advance (NGX-511)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-advance-text";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--advance",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Progress advanced: true");
  });

  it("rejects --advance outside workflow run monitor (NGX-511)", async () => {
    const result = await run(["status", "--advance"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--advance is only supported by `momentum workflow run monitor`."
    );
  });

  it("rejects --advance on an unrelated workflow subcommand (NGX-511)", async () => {
    const result = await run(["workflow", "status", "--advance"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "--advance is only supported by `momentum workflow run monitor`."
    );
  });

  it("rejects an unexpected extra positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "monitor",
      "cwfp-extra",
      "surprise",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: false, code: "usage_error" });
    expect(String(payload["message"])).toContain("Unexpected argument");
  });
});
