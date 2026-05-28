import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/db.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-update-step-"): string {
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
    input.approvalBoundary ?? null,
    null,
    input.needsManualRecovery ? 1 : 0,
    input.manualRecoveryReason ?? null,
    input.needsManualRecovery ? now : null,
    null,
    now,
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
    input.holder,
    input.acquiredAt,
    input.expiresAt,
    input.heartbeatAt ?? input.acquiredAt,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    input.acquiredAt,
    input.acquiredAt
  );
}

function readStep(
  dataDir: string,
  runId: string,
  stepId: string
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
           FROM workflow_steps WHERE run_id = ? AND step_id = ?`
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
      db
        .prepare("SELECT state FROM workflow_runs WHERE id = ?")
        .get(runId) as { state: string }
    ).state;
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "run_id_required"
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "step_not_found"
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_state"
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
        order: 1
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition"
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "run_not_found"
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
        order: 1
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "step_not_found"
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
        order: 1
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
      "--json"
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
      evidencePointer:
        ".agent-workflows/cwfp-succeed/ledger.jsonl#offset=42"
    });

    const step = readStep(dataDir, runId, "implementation");
    expect(step.state).toBe("succeeded");
    expect(step.operator_reason).toBe(
      "managed child finished but durable terminal evidence never landed"
    );
    expect(step.operator_actor).toBe("calvinnwq");
    expect(step.operator_evidence_pointer).toBe(
      ".agent-workflows/cwfp-succeed/ledger.jsonl#offset=42"
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
        order: 1
      });
      seedStep(db, {
        runId,
        stepId: "linear-refresh",
        kind: "linear-refresh",
        state: "pending",
        order: 2,
        required: false
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
      "linear-refresh",
      "--state",
      "skipped",
      "--reason",
      "linear refresh handled out of band",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    expect(readStep(dataDir, runId, "linear-refresh").state).toBe("skipped");

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
    expect(statusPayload.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "linear-refresh", state: "skipped" })
      ])
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
        order: 1
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
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      state: "failed",
      runState: "failed",
      ledgerPointer: ".agent-workflows/cwfp-fail/ledger.jsonl#offset=7"
    });
    expect(readStep(dataDir, runId, "no-mistakes").state).toBe("failed");
    expect(readRunState(dataDir, runId)).toBe("failed");
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
        order: 1
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
      "--json"
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
        order: 1
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
      "--json"
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
        order: 1
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
      "--json"
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
        order: 1
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition"
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
        order: 1
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
      "--json"
    ];
    const first = await run(args);
    expect(first.code).toBe(0);
    const firstAt = readStep(dataDir, runId, "implementation")
      .operator_transition_at;

    const second = await run(args);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      state: "succeeded",
      idempotent: true
    });
    expect(
      readStep(dataDir, runId, "implementation").operator_transition_at
    ).toBe(firstAt);
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
        order: 1
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
      "--json"
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
      "--json"
    ]);
    expect(second.code).toBe(1);
    const payload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition"
    });
    expect(readStep(dataDir, runId, "implementation").operator_reason).toBe(
      "first finalize"
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
        order: 1
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 2
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
      "--json"
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
        order: 1
      });
      const now = Date.now();
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        holder: "child-executor",
        acquiredAt: now - 1_000,
        expiresAt: now + 60_000
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
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      runState: "running"
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
        order: 1
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
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "invalid_transition",
      runId,
      stepId: "postflight"
    });
    expect(readStep(dataDir, runId, "postflight").state).toBe("running");
    expect(readRunState(dataDir, runId)).toBe("succeeded");
  });

  it("refuses transitions while the run needs manual recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-recovery";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "blocked",
        needsManualRecovery: true,
        manualRecoveryReason: "dispatch lease requires operator recovery"
      });
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
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "operator finalize",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run update-step",
      code: "manual_recovery_required",
      runId
    });
    expect(readStep(dataDir, runId, "implementation").state).toBe("running");
  });
});
