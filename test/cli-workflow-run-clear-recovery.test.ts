import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-clear-"): string {
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

type SeedRunInput = {
  runId: string;
  state: string;
  needsManualRecovery?: boolean;
  manualRecoveryReason?: string | null;
};

function seedRun(db: MomentumDb, input: SeedRunInput): void {
  const now = 1_730_000_000_000;
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
    "agent-workflow",
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
    input.needsManualRecovery ? now : null,
    null,
    null,
    now,
    now
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
  const now = 1_730_000_000_000;
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
    now,
    now
  );
}

function readRecoveryState(
  dataDir: string,
  runId: string
): {
  needs_manual_recovery: number;
  manual_recovery_reason: string | null;
  manual_recovery_at: number | null;
} {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        `SELECT needs_manual_recovery, manual_recovery_reason, manual_recovery_at
           FROM workflow_runs WHERE id = ?`
      )
      .get(runId) as {
      needs_manual_recovery: number;
      manual_recovery_reason: string | null;
      manual_recovery_at: number | null;
    };
  } finally {
    db.close();
  }
}

function readStepState(
  dataDir: string,
  runId: string,
  stepId: string
): {
  state: string;
  operator_reason: string | null;
  operator_actor: string | null;
  operator_transition_at: number | null;
  operator_evidence_pointer: string | null;
  operator_ledger_pointer: string | null;
  error_code: string | null;
  error_message: string | null;
} {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        `SELECT state, operator_reason, operator_actor, operator_transition_at,
                operator_evidence_pointer, operator_ledger_pointer,
                error_code, error_message
           FROM workflow_steps WHERE run_id = ? AND step_id = ?`
      )
      .get(runId, stepId) as {
      state: string;
      operator_reason: string | null;
      operator_actor: string | null;
      operator_transition_at: number | null;
      operator_evidence_pointer: string | null;
      operator_ledger_pointer: string | null;
      error_code: string | null;
      error_message: string | null;
    };
  } finally {
    db.close();
  }
}

function readRunMonitor(dataDir: string, runId: string): {
  monitor_last_seen_state: string | null;
  monitor_terminal: number | null;
  monitor_step: string | null;
  monitor_last_seen_digest: string | null;
  monitor_last_emitted_digest: string | null;
} {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        `SELECT monitor_last_seen_state, monitor_terminal, monitor_step,
                monitor_last_seen_digest, monitor_last_emitted_digest
           FROM workflow_runs WHERE id = ?`
      )
      .get(runId) as {
      monitor_last_seen_state: string | null;
      monitor_terminal: number | null;
      monitor_step: string | null;
      monitor_last_seen_digest: string | null;
      monitor_last_emitted_digest: string | null;
    };
  } finally {
    db.close();
  }
}

describe("momentum workflow run clear-recovery (NGX-327)", () => {
  it("requires a <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "run_id_required"
    });
  });

  it("refuses an unknown run", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      "cwfp-missing-run",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "run_not_found",
      runId: "cwfp-missing-run"
    });
  });

  it("refuses when the run is not flagged for manual recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-not-flagged";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running", needsManualRecovery: false });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "not_flagged",
      runId
    });
  });

  it("refuses with recovery_clear_refused while a blocking condition persists", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-still-blocked";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "failed",
        needsManualRecovery: true,
        manualRecoveryReason: "required step failed; operator recovery needed"
      });
      // A failed required step keeps the monitor classifying a blocking
      // recovery condition, so the guarded clear must refuse.
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
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "recovery_clear_refused",
      runId,
      recoveryCode: "failed_required_step"
    });
    // The durable flag stays set so transitions remain blocked.
    expect(readRecoveryState(dataDir, runId).needs_manual_recovery).toBe(1);
  });


  it("refuses to reconcile an external-side-effect tail step without evidence", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-external-tail-no-evidence";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "failed",
        needsManualRecovery: true,
        manualRecoveryReason: "failed_external_side_effect_step"
      });
      seedStep(db, {
        runId,
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "failed",
        order: 0
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "recovery_clear_refused",
      runId,
      recoveryCode: "failed_external_side_effect_step"
    });
    expect(payload["message"]).toContain("--evidence-pointer");
    expect(readRecoveryState(dataDir, runId).needs_manual_recovery).toBe(1);
    expect(readStepState(dataDir, runId, "merge-cleanup")).toMatchObject({
      state: "failed",
      error_code: null,
      error_message: null
    });
  });

  it("reconciles a failed external-side-effect tail step from clear-recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-external-tail-clear";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "failed",
        needsManualRecovery: true,
        manualRecoveryReason: "failed_external_side_effect_step"
      });
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
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        state: "succeeded",
        order: 2
      });
      seedStep(db, {
        runId,
        stepId: "no-mistakes",
        kind: "no-mistakes",
        state: "succeeded",
        order: 3
      });
      seedStep(db, {
        runId,
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "failed",
        order: 4
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--evidence-pointer",
      "github://pulls/123#merged",
      "--ledger-pointer",
      ".agent-workflows/cwfp-external-tail-clear/ledger.jsonl#offset=42",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run clear-recovery",
      runId,
      previousReason: "failed_external_side_effect_step",
      reconciledStep: {
        stepId: "merge-cleanup",
        recoveryCode: "failed_external_side_effect_step",
        state: "succeeded",
        evidencePointer: "github://pulls/123#merged",
        ledgerPointer: ".agent-workflows/cwfp-external-tail-clear/ledger.jsonl#offset=42"
      }
    });
    expect(readRecoveryState(dataDir, runId).needs_manual_recovery).toBe(0);
    expect(readStepState(dataDir, runId, "merge-cleanup")).toMatchObject({
      state: "succeeded",
      operator_reason: "failed_external_side_effect_step",
      operator_actor: "workflow run clear-recovery",
      operator_evidence_pointer: "github://pulls/123#merged",
      operator_ledger_pointer:
        ".agent-workflows/cwfp-external-tail-clear/ledger.jsonl#offset=42",
      error_code: null,
      error_message: null
    });
    expect(readRunMonitor(dataDir, runId)).toMatchObject({
      monitor_last_seen_state: "succeeded",
      monitor_terminal: 1,
      monitor_step: null
    });
  });

  it("clears the durable flag once the blocking condition is resolved", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-cleared";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "ghost active step recovered by operator"
      });
      // The previously-failed required step has since been re-driven to a
      // healthy terminal state, so no blocking recovery code remains.
      seedStep(db, {
        runId,
        stepId: "no-mistakes",
        kind: "no-mistakes",
        state: "succeeded",
        order: 1
      });
      db.prepare(
        `UPDATE workflow_runs
            SET monitor_last_seen_state = 'running',
                monitor_terminal = 0,
                monitor_step = 'stale-step',
                monitor_last_seen_digest = 'stale-digest',
                monitor_last_emitted_digest = 'stale-digest'
          WHERE id = ?`
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run clear-recovery",
      runId,
      previousReason: "ghost active step recovered by operator"
    });
    expect(typeof payload["clearedAt"]).toBe("number");

    const state = readRecoveryState(dataDir, runId);
    expect(state.needs_manual_recovery).toBe(0);
    expect(state.manual_recovery_reason).toBeNull();
    expect(state.manual_recovery_at).toBeNull();
    expect(readRunMonitor(dataDir, runId)).toMatchObject({
      monitor_last_seen_state: "succeeded",
      monitor_terminal: 1,
      monitor_step: null,
      monitor_last_seen_digest: null,
      monitor_last_emitted_digest: null
    });

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
    const monitorPayload = JSON.parse(monitorResult.stdout) as Record<
      string,
      unknown
    >;
    expect(monitorPayload).toMatchObject({
      ok: true,
      disposition: "report",
      reportReason: "terminal_succeeded"
    });
  });

  it("clears in text mode and reports the previous reason", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-cleared-text";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "operator resolved the blocking lease"
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
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Manual recovery cleared for run: ${runId}`);
    expect(result.stdout).toContain("operator resolved the blocking lease");
    expect(readRecoveryState(dataDir, runId).needs_manual_recovery).toBe(0);
  });

  it("rejects an unexpected extra positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "clear-recovery",
      "cwfp-extra",
      "surprise",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    // Extra positionals are a usage error (exit code 2), mirroring the
    // sibling `workflow run update-step` unexpected-argument handling.
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: false, code: "usage_error" });
    expect(String(payload["message"])).toContain("Unexpected argument");
  });
});
