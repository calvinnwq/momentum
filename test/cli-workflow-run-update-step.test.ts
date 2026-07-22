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

function makeTempDir(
  prefix = "momentum-cli-workflow-run-update-step-",
): string {
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
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
    env: {},
  });
  return { code, stdout, stderr };
}

type SeedRunInput = {
  runId: string;
  state: string;
  approvalBoundary?: string | null;
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.approvalBoundary ?? null,
    null,
    input.needsManualRecovery ? 1 : 0,
    input.manualRecoveryReason ?? null,
    input.needsManualRecovery ? now : null,
    null,
    now,
    now,
    now,
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
  },
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, result_digest, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now,
  );
}

function seedLease(
  db: MomentumDb,
  input: {
    runId: string;
    leaseKind: string;
    holder: string;
    acquiredAt: number;
    expiresAt: number;
    heartbeatAt?: number;
    releasedAt?: number | null;
    stalePolicy?: string;
  },
): void {
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.leaseKind,
    input.holder,
    input.acquiredAt,
    input.expiresAt,
    input.heartbeatAt ?? input.acquiredAt,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    input.acquiredAt,
    input.acquiredAt,
  );
}

function readStep(
  dataDir: string,
  runId: string,
  stepId: string,
): {
  state: string;
  operator_reason: string | null;
  operator_actor: string | null;
  operator_evidence_pointer: string | null;
  operator_ledger_pointer: string | null;
  operator_transition_at: number | null;
} {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        `SELECT state, operator_reason, operator_actor,
                operator_evidence_pointer, operator_ledger_pointer,
                operator_transition_at
           FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
      )
      .get(runId, stepId) as {
      state: string;
      operator_reason: string | null;
      operator_actor: string | null;
      operator_evidence_pointer: string | null;
      operator_ledger_pointer: string | null;
      operator_transition_at: number | null;
    };
  } finally {
    db.close();
  }
}

function readRunState(dataDir: string, runId: string): string {
  const db = openDb(dataDir);
  try {
    return (
      db.prepare("SELECT state FROM workflow_runs WHERE id = ?").get(runId) as {
        state: string;
      }
    ).state;
  } finally {
    db.close();
  }
}

function readRunFinishedAt(dataDir: string, runId: string): number | null {
  const db = openDb(dataDir);
  try {
    return (
      db
        .prepare("SELECT finished_at FROM workflow_runs WHERE id = ?")
        .get(runId) as { finished_at: number | null }
    ).finished_at;
  } finally {
    db.close();
  }
}

function setRunFinishedAt(
  dataDir: string,
  runId: string,
  finishedAt: number,
): void {
  const db = openDb(dataDir);
  try {
    db.prepare("UPDATE workflow_runs SET finished_at = ? WHERE id = ?").run(
      finishedAt,
      runId,
    );
  } finally {
    db.close();
  }
}

function readRunMonitor(
  dataDir: string,
  runId: string,
): {
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
           FROM workflow_runs WHERE id = ?`,
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

function readRunRecoveryState(
  dataDir: string,
  runId: string,
): {
  needs_manual_recovery: number;
  manual_recovery_reason: string | null;
} {
  const db = openDb(dataDir);
  try {
    return db
      .prepare(
        `SELECT needs_manual_recovery, manual_recovery_reason
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as {
      needs_manual_recovery: number;
      manual_recovery_reason: string | null;
    };
  } finally {
    db.close();
  }
}

describe("momentum workflow run update-step (NGX-326)", () => {
  it("requires a <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "update-step",
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "run_id_required",
    });
  });

  it("requires a --step", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "update-step",
      "cwfp-no-step",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "step_not_found",
    });
  });

  it("rejects an invalid --state target", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "update-step",
      "cwfp-bad-state",
      "--step",
      "implementation",
      "--state",
      "running",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_state",
    });
  });

  it("requires a --reason", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-no-reason";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition",
    });
    expect(readStep(dataDir, runId, "implementation").state).toBe("running");
  });

  it("refuses an unknown run", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "update-step",
      "cwfp-missing-run",
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "run_not_found",
    });
  });

  it("refuses an unknown step", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-missing-step";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "no-such-step",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "step_not_found",
    });
  });

  it("finalizes a running step as succeeded and persists audit context", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-succeed";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "managed child finished but durable terminal evidence never landed",
      "--actor",
      "calvinnwq",
      "--evidence-pointer",
      ".agent-workflows/cwfp-succeed/ledger.jsonl#offset=42",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      runId,
      stepId: "implementation",
      state: "succeeded",
      previousState: "running",
      runState: "succeeded",
      actor: "calvinnwq",
      evidencePointer: ".agent-workflows/cwfp-succeed/ledger.jsonl#offset=42",
    });

    const step = readStep(dataDir, runId, "implementation");
    expect(step.state).toBe("succeeded");
    expect(step.operator_reason).toBe(
      "managed child finished but durable terminal evidence never landed",
    );
    expect(step.operator_actor).toBe("calvinnwq");
    expect(step.operator_evidence_pointer).toBe(
      ".agent-workflows/cwfp-succeed/ledger.jsonl#offset=42",
    );
    expect(typeof step.operator_transition_at).toBe("number");
    expect(readRunState(dataDir, runId)).toBe("succeeded");
  });

  it("skips a pending step and reflects the change in status", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-skip";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1,
      });
      seedStep(db, {
        runId,
        stepId: "tracker-refresh",
        kind: "tracker-refresh",
        state: "pending",
        order: 2,
        required: false,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "tracker-refresh",
      "--state",
      "skipped",
      "--reason",
      "linear refresh handled out of band",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readStep(dataDir, runId, "tracker-refresh").state).toBe("skipped");

    const statusResult = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as {
      steps: Array<{ stepId: string; state: string }>;
    };
    expect(statusPayload.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "tracker-refresh",
          state: "skipped",
        }),
      ]),
    );
  });

  it("fails a running step and derives a failed run", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-fail";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "no-mistakes",
        kind: "no-mistakes",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "no-mistakes",
      "--state",
      "failed",
      "--reason",
      "review surfaced an unfixable regression",
      "--ledger-pointer",
      ".agent-workflows/cwfp-fail/ledger.jsonl#offset=7",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      state: "failed",
      runState: "failed",
      ledgerPointer: ".agent-workflows/cwfp-fail/ledger.jsonl#offset=7",
    });
    expect(readStep(dataDir, runId, "no-mistakes").state).toBe("failed");
    expect(readRunState(dataDir, runId)).toBe("failed");
  });

  it("refreshes monitor advisory state after an operator step update", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-refresh-monitor";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "preflight",
        kind: "preflight",
        state: "running",
        order: 0,
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });
      db.prepare(
        `UPDATE workflow_runs
            SET monitor_last_seen_state = 'approved',
                monitor_terminal = 0,
                monitor_step = 'preflight',
                monitor_last_seen_digest = 'stale-digest',
                monitor_last_emitted_digest = 'stale-digest'
          WHERE id = ?`,
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "preflight",
      "--state",
      "succeeded",
      "--reason",
      "operator advanced preflight",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readRunState(dataDir, runId)).toBe("approved");
    expect(readRunMonitor(dataDir, runId)).toMatchObject({
      monitor_last_seen_state: "approved",
      monitor_terminal: 0,
      monitor_step: "implementation",
      monitor_last_seen_digest: null,
      monitor_last_emitted_digest: null,
    });

    const monitorResult = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(monitorResult.code).toBe(0);
    const payload = JSON.parse(monitorResult.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      disposition: "wait",
      reportable: false,
      reportReason: "in_progress",
    });
    expect(payload["monitorDrift"]).toMatchObject({
      drifted: false,
      reason: null,
    });
  });

  it("blocks a running step and derives a blocked run", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-block";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "postflight",
      "--state",
      "blocked",
      "--reason",
      "operator holding for manual inspection",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readStep(dataDir, runId, "postflight").state).toBe("blocked");
    expect(readRunState(dataDir, runId)).toBe("blocked");
  });

  it("approves a blocked step to give operators an unblock path", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-unblock";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "blocked" });
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        state: "blocked",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "postflight",
      "--state",
      "approved",
      "--reason",
      "operator cleared the block",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readStep(dataDir, runId, "postflight").state).toBe("approved");
    expect(readRunState(dataDir, runId)).toBe("approved");
  });

  it("cancels a blocked step to give operators a terminal escape hatch", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-cancel-blocked";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "blocked" });
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        state: "blocked",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "postflight",
      "--state",
      "canceled",
      "--reason",
      "operator canceled the blocked step",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readStep(dataDir, runId, "postflight").state).toBe("canceled");
    expect(readRunState(dataDir, runId)).toBe("canceled");
  });

  it("refuses an illegal transition without durable mutation", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-illegal";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "pending" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "cannot succeed a step that never ran",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition",
    });
    const step = readStep(dataDir, runId, "implementation");
    expect(step.state).toBe("pending");
    expect(step.operator_reason).toBeNull();
    expect(readRunState(dataDir, runId)).toBe("pending");
  });

  it("returns idempotently for a byte-equal duplicate finalize", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-idempotent";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const args = [
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--actor",
      "calvinnwq",
      "--data-dir",
      dataDir,
      "--json",
    ];
    const first = await run(args);
    expect(first.code).toBe(0);
    const firstAt = readStep(
      dataDir,
      runId,
      "implementation",
    ).operator_transition_at;

    const second = await run(args);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      state: "succeeded",
      idempotent: true,
    });
    expect(
      readStep(dataDir, runId, "implementation").operator_transition_at,
    ).toBe(firstAt);
  });

  it("preserves the original run finished_at across an idempotent re-finalize", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-finished-at";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const args = [
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--actor",
      "calvinnwq",
      "--data-dir",
      dataDir,
      "--json",
    ];
    const first = await run(args);
    expect(first.code).toBe(0);
    expect(readRunState(dataDir, runId)).toBe("succeeded");

    const originalFinishedAt = 1_700_000_000_000;
    setRunFinishedAt(dataDir, runId, originalFinishedAt);

    const second = await run(args);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: true,
      idempotent: true,
      runState: "succeeded",
    });
    expect(readRunFinishedAt(dataDir, runId)).toBe(originalFinishedAt);
  });

  it("refuses a duplicate finalize that changes audit context", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-refinalize";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const first = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "first finalize",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(first.code).toBe(0);

    const second = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "second finalize with different reason",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(second.code).toBe(1);
    const payload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition",
    });
    expect(readStep(dataDir, runId, "implementation").operator_reason).toBe(
      "first finalize",
    );
  });

  it("derives a succeeded run after the required chain finalizes", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-required-chain";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 1,
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 2,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "finalize the last required step",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(readRunState(dataDir, runId)).toBe("succeeded");
  });

  it("keeps a run active when finalizing the last step under an outstanding lease", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-fresh-lease";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
      const now = Date.now();
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        holder: "child-executor",
        acquiredAt: now - 1_000,
        expiresAt: now + 60_000,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalized while child lease cleanup is still pending",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      runState: "running",
    });
    expect(readStep(dataDir, runId, "implementation").state).toBe("succeeded");
    expect(readRunState(dataDir, runId)).toBe("running");
  });

  it("refuses to mutate steps on terminal runs", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-terminal";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "succeeded" });
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "postflight",
      "--state",
      "blocked",
      "--reason",
      "stale operator action",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition",
      runId,
      stepId: "postflight",
    });
    expect(readStep(dataDir, runId, "postflight").state).toBe("running");
    expect(readRunState(dataDir, runId)).toBe("succeeded");
  });

  it("allows a flagged running step transition that resolves manual recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-recovery-resolve";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "ghost active step requires operator recovery",
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const update = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "canceled",
      "--reason",
      "operator canceled ghost step",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(update.code).toBe(0);
    const updatePayload = JSON.parse(update.stdout) as Record<string, unknown>;
    expect(updatePayload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      runId,
      stepId: "implementation",
      state: "canceled",
      previousState: "running",
      runState: "canceled",
    });
    expect(readStep(dataDir, runId, "implementation").state).toBe("canceled");
    expect(readRunState(dataDir, runId)).toBe("canceled");
    expect(readRunRecoveryState(dataDir, runId).needs_manual_recovery).toBe(1);

    const clear = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(clear.code).toBe(0);
    const clearPayload = JSON.parse(clear.stdout) as Record<string, unknown>;
    expect(clearPayload).toMatchObject({
      ok: true,
      command: "workflow run clear-recovery",
      runId,
    });
    expect(readRunRecoveryState(dataDir, runId).needs_manual_recovery).toBe(0);
  });

  it("refuses flagged transitions that leave manual recovery blocking", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-recovery";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "ghost active step requires operator recovery",
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "blocked",
      "--reason",
      "operator keeps step blocked",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "manual_recovery_required",
      runId,
    });
    expect(readStep(dataDir, runId, "implementation").state).toBe("running");
  });
});
