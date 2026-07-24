import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-approve-"): string {
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

function seedApproval(
  db: MomentumDb,
  input: {
    runId: string;
    boundary: string;
    phrase?: string;
    artifactPath?: string;
    artifactDigest?: string;
  },
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_approvals
       (run_id, boundary, actor, phrase, artifact_path,
        artifact_digest, recorded_at, discharged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.boundary,
    null,
    input.phrase ?? "approve implementation",
    input.artifactPath ??
      `workflow-run-approve://${input.runId}/${input.boundary}`,
    input.artifactDigest ?? "existing-digest",
    now,
    null,
    now,
    now,
  );
}

describe("momentum workflow run approve (NGX-325)", () => {
  it("requires a <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "approve",
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "run_id_required",
    });
  });

  it("rejects an invalid --approval-boundary", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "approve",
      "cwfp-missing",
      "--approval-boundary",
      "bogus-boundary",
      "--phrase",
      "approve run boundary",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "invalid_boundary",
    });
  });

  it("rejects casual phrasing and creates no durable row", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-approve-casual",
        state: "running",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      "cwfp-approve-casual",
      "--approval-boundary",
      "implementation",
      "--phrase",
      "go ahead",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "invalid_boundary",
    });

    const dbCheck = openDb(dataDir);
    try {
      const row = dbCheck
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
        )
        .get("cwfp-approve-casual") as { count: number };
      expect(row.count).toBe(0);
    } finally {
      dbCheck.close();
    }
  });

  it.each([
    {
      runId: "cwfp-approve-negated-implementation",
      boundary: "implementation",
      phrase: "do not approve implementation",
    },
    {
      runId: "cwfp-approve-negated-full",
      boundary: "full",
      phrase: "not full",
    },
    {
      runId: "cwfp-approve-negated-no-prefix",
      boundary: "implementation",
      phrase: "no approve implementation",
    },
    {
      runId: "cwfp-approve-negated-no-target",
      boundary: "implementation",
      phrase: "approve no implementation",
    },
  ])(
    "rejects negated approval phrasing for $boundary and creates no durable row",
    async ({ runId, boundary, phrase }) => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedRun(db, {
          runId,
          state: "running",
        });
      } finally {
        db.close();
      }

      const result = await run([
        "workflow",
        "run",
        "approve",
        runId,
        "--approval-boundary",
        boundary,
        "--phrase",
        phrase,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "workflow run approve",
        code: "invalid_boundary",
      });

      const dbCheck = openDb(dataDir);
      try {
        const row = dbCheck
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
          )
          .get(runId) as { count: number };
        expect(row.count).toBe(0);
      } finally {
        dbCheck.close();
      }
    },
  );

  it.each(["no-mistakes", "through-no-mistakes"])(
    "refuses retired approval boundary input %s",
    async (boundary) => {
      const dataDir = makeTempDir();
      const result = await run([
        "workflow",
        "run",
        "approve",
        "cwfp-legacy-boundary",
        "--approval-boundary",
        boundary,
        "--phrase",
        `approve ${boundary}`,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "workflow run approve",
        code: "invalid_boundary",
      });
    },
  );

  it("persists durable approval rows and surfaces them in status and handoff", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-ok";
    const artifactPath = path.join(dataDir, "approval-artifact.json");
    fs.writeFileSync(artifactPath, "approved", "utf-8");
    const artifactDigest = crypto
      .createHash("sha256")
      .update("approved")
      .digest("hex");
    const phrase = `approve plan ${runId} through-implementation`;

    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "through-implementation",
      "--phrase",
      phrase,
      "--actor",
      "calvinnwq",
      "--artifact-path",
      artifactPath,
      "--artifact-digest",
      artifactDigest,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      runId: string;
      boundary: string;
      actor: string;
      phrase: string;
      artifactPath: string;
      artifactDigest: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow run approve");
    expect(payload.runId).toBe(runId);
    expect(payload.boundary).toBe("through-implementation");
    expect(payload.actor).toBe("calvinnwq");
    expect(payload.phrase).toBe(phrase);
    expect(payload.artifactPath).toBe(artifactPath);
    expect(payload.artifactDigest).toBe(artifactDigest);

    const checkDb = openDb(dataDir);
    try {
      const approval = checkDb
        .prepare(
          "SELECT boundary, actor, phrase, artifact_path, artifact_digest FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as {
        boundary: string;
        actor: string;
        phrase: string;
        artifact_path: string;
        artifact_digest: string;
      };
      expect(approval).toEqual({
        boundary: "through-implementation",
        actor: "calvinnwq",
        phrase,
        artifact_path: artifactPath,
        artifact_digest: artifactDigest,
      });
    } finally {
      checkDb.close();
    }

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
      command: string;
      approvals: Array<{ boundary: string; actor: string; phrase: string }>;
    };
    expect(statusPayload.command).toBe("workflow status");
    expect(statusPayload.approvals).toEqual([
      expect.objectContaining({
        boundary: "through-implementation",
        actor: "calvinnwq",
        phrase,
      }),
    ]);

    const handoffResult = await run([
      "workflow",
      "handoff",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(handoffResult.code).toBe(0);
    const handoffPayload = JSON.parse(handoffResult.stdout) as {
      command: string;
      approvals: Array<{ boundary: string; actor: string; phrase: string }>;
    };
    expect(handoffPayload.command).toBe("workflow handoff");
    expect(handoffPayload.approvals).toEqual([
      expect.objectContaining({
        boundary: "through-implementation",
        actor: "calvinnwq",
        phrase,
      }),
    ]);

    const listResult = await run([
      "workflow",
      "run",
      "list",
      "--approval-boundary",
      "through-implementation",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(listResult.code).toBe(0);
    const listPayload = JSON.parse(listResult.stdout) as {
      command: string;
      count: number;
      runs: Array<{
        run: { runId: string; approvalBoundary: string };
        counts: { approvals: number };
      }>;
    };
    expect(listPayload.command).toBe("workflow run list");
    expect(listPayload.count).toBe(1);
    expect(listPayload.runs).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({
          runId,
          approvalBoundary: "through-implementation",
        }),
        counts: expect.objectContaining({ approvals: 1 }),
      }),
    ]);
  });

  it("promotes pending run and boundary steps to approved", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-promotes";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "pending",
      });
      seedStep(db, { runId, stepId: "preflight", kind: "preflight", order: 1 });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        order: 2,
      });
      seedStep(db, {
        runId,
        stepId: "postflight",
        kind: "postflight",
        order: 3,
      });
      db.prepare(
        `UPDATE workflow_runs
            SET monitor_last_seen_state = 'pending',
                monitor_terminal = 0,
                monitor_step = 'postflight',
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
    expect(result.code).toBe(0);

    const dbCheck = openDb(dataDir);
    try {
      const runRow = dbCheck
        .prepare(
          "SELECT state, approval_boundary FROM workflow_runs WHERE id = ?",
        )
        .get(runId) as { state: string; approval_boundary: string };
      expect(runRow).toEqual({
        state: "approved",
        approval_boundary: "through-implementation",
      });
      const steps = dbCheck
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order",
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(steps).toEqual([
        { step_id: "preflight", state: "approved" },
        { step_id: "implementation", state: "approved" },
        { step_id: "postflight", state: "pending" },
      ]);
    } finally {
      dbCheck.close();
    }
    expect(readRunMonitor(dataDir, runId)).toMatchObject({
      monitor_last_seen_state: "approved",
      monitor_terminal: 0,
      monitor_step: "preflight",
      monitor_last_seen_digest: null,
      monitor_last_emitted_digest: null,
    });

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
      monitor: { nextAction: { code: string; stepId: string | null } };
    };
    expect(statusPayload.monitor.nextAction).toMatchObject({
      code: "advance_to_step",
      stepId: "preflight",
    });
  });

  it("refuses approvals while the run needs manual recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-recovery";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "blocked",
        needsManualRecovery: true,
        manualRecoveryReason: "dispatch lease requires operator recovery",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "manual_recovery_required",
      runId,
      boundary: "implementation",
    });

    const dbCheck = openDb(dataDir);
    try {
      const count = (
        dbCheck
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
          )
          .get(runId) as { count: number }
      ).count;
      expect(count).toBe(0);
      const runRow = dbCheck
        .prepare("SELECT approval_boundary FROM workflow_runs WHERE id = ?")
        .get(runId) as { approval_boundary: string | null };
      expect(runRow.approval_boundary).toBeNull();
    } finally {
      dbCheck.close();
    }
  });

  it.each(["succeeded", "failed", "canceled"])(
    "refuses approvals for terminal %s runs without durable mutations",
    async (state) => {
      const dataDir = makeTempDir();
      const runId = `cwfp-approve-terminal-${state}`;
      const db = openDb(dataDir);
      try {
        seedRun(db, {
          runId,
          state,
        });
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
        "approve",
        runId,
        "--approval-boundary",
        "implementation",
        "--phrase",
        "approve implementation",
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "workflow run approve",
        code: "invalid_state",
        runId,
        boundary: "implementation",
      });

      const dbCheck = openDb(dataDir);
      try {
        const approvalCount = (
          dbCheck
            .prepare(
              "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
            )
            .get(runId) as { count: number }
        ).count;
        expect(approvalCount).toBe(0);
        const runRow = dbCheck
          .prepare(
            "SELECT state, approval_boundary FROM workflow_runs WHERE id = ?",
          )
          .get(runId) as { state: string; approval_boundary: string | null };
        expect(runRow).toEqual({
          state,
          approval_boundary: null,
        });
        const stepRow = dbCheck
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, "implementation") as { state: string };
        expect(stepRow.state).toBe("pending");
      } finally {
        dbCheck.close();
      }
    },
  );

  it("preserves the semantically highest recorded approval boundary", async () => {
    const dataDir = makeTempDir();
    const lowerRunId = "cwfp-approve-preserve-boundary";
    const batchRunId = "cwfp-approve-plan-only-after-full";
    const mergeRunId = "cwfp-approve-merge-after-gates";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: lowerRunId,
        state: "running",
        approvalBoundary: "through-merge-cleanup",
      });
      seedRun(db, {
        runId: batchRunId,
        state: "running",
        approvalBoundary: "full",
      });
      seedRun(db, {
        runId: mergeRunId,
        state: "running",
        approvalBoundary: "through-merge-gates",
      });
    } finally {
      db.close();
    }

    const lowerResult = await run([
      "workflow",
      "run",
      "approve",
      lowerRunId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(lowerResult.code).toBe(0);

    const batchResult = await run([
      "workflow",
      "run",
      "approve",
      batchRunId,
      "--approval-boundary",
      "plan-only",
      "--phrase",
      "approve plan-only",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(batchResult.code).toBe(0);

    const mergeResult = await run([
      "workflow",
      "run",
      "approve",
      mergeRunId,
      "--approval-boundary",
      "merge-cleanup",
      "--phrase",
      "approve merge-cleanup",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(mergeResult.code).toBe(0);

    const dbCheck = openDb(dataDir);
    try {
      const runRows = dbCheck
        .prepare(
          "SELECT id, approval_boundary FROM workflow_runs WHERE id IN (?, ?, ?) ORDER BY id",
        )
        .all(lowerRunId, batchRunId, mergeRunId) as Array<{
        id: string;
        approval_boundary: string;
      }>;
      expect(runRows).toEqual([
        {
          id: mergeRunId,
          approval_boundary: "merge-cleanup",
        },
        {
          id: batchRunId,
          approval_boundary: "full",
        },
        {
          id: lowerRunId,
          approval_boundary: "through-merge-cleanup",
        },
      ]);
      const approvals = dbCheck
        .prepare(
          "SELECT run_id, boundary FROM workflow_approvals WHERE run_id IN (?, ?, ?) ORDER BY run_id, boundary",
        )
        .all(lowerRunId, batchRunId, mergeRunId) as Array<{
        run_id: string;
        boundary: string;
      }>;
      expect(approvals).toEqual([
        { run_id: mergeRunId, boundary: "merge-cleanup" },
        { run_id: batchRunId, boundary: "plan-only" },
        { run_id: lowerRunId, boundary: "implementation" },
      ]);
    } finally {
      dbCheck.close();
    }
  });

  it("accepts spaced boundary phrasing and records the approval", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-spaced";
    const phrase = `approve pipeline ${runId} through implementation`;

    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "through-implementation",
      "--phrase",
      phrase,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      boundary: string;
      phrase: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow run approve");
    expect(payload.boundary).toBe("through-implementation");
    expect(payload.phrase).toBe(phrase);

    const dbCheck = openDb(dataDir);
    try {
      const approval = dbCheck
        .prepare(
          "SELECT boundary, phrase FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as { boundary: string; phrase: string };
      expect(approval.boundary).toBe("through-implementation");
      expect(approval.phrase).toBe(phrase);
    } finally {
      dbCheck.close();
    }
  });

  it("rejects artifact digest mismatches without writing a row", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-mismatch";
    const artifactPath = path.join(dataDir, "approval-artifact.json");
    fs.writeFileSync(artifactPath, "approved", "utf-8");

    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--artifact-path",
      artifactPath,
      "--artifact-digest",
      "bad-digest",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "approval_digest_mismatch",
    });

    const dbCheck = openDb(dataDir);
    try {
      const row = dbCheck
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as { count: number };
      expect(row.count).toBe(0);
    } finally {
      dbCheck.close();
    }
  });

  it("rejects supplied digests that do not match the implicit approval provenance", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-implicit-digest-mismatch";

    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--artifact-digest",
      "bad-digest",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "approval_digest_mismatch",
    });

    const dbCheck = openDb(dataDir);
    try {
      const row = dbCheck
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as { count: number };
      expect(row.count).toBe(0);
    } finally {
      dbCheck.close();
    }
  });

  it("refuses duplicate approvals for the same (runId, boundary)", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-duplicate";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }

    const phrase = "approve implementation";
    const first = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      phrase,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(first.code).toBe(0);

    const second = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      phrase,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(second.code).toBe(1);
    const secondPayload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "duplicate_approval",
    });

    const checkDb = openDb(dataDir);
    try {
      const count = (
        checkDb
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ? AND boundary = ?",
          )
          .get(runId, "implementation") as { count: number }
      ).count;
      expect(count).toBe(1);
    } finally {
      checkDb.close();
    }
  });

  it("deduplicates through-validate against a frozen through-no-mistakes approval row", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-legacy-boundary-duplicate";
    const frozenPhrase = `approve plan ${runId} through-no-mistakes`;
    const frozenDigest = crypto
      .createHash("sha256")
      .update(`approve:${runId}:through-no-mistakes:${frozenPhrase}`)
      .digest("hex");
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedApproval(db, {
        runId,
        boundary: "through-no-mistakes",
        phrase: frozenPhrase,
        artifactDigest: frozenDigest,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "through-validate",
      "--phrase",
      `approve plan ${runId} through-validate`,
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "duplicate_approval",
      boundary: "through-validate",
    });
    const checkDb = openDb(dataDir);
    try {
      const rows = checkDb
        .prepare(
          "SELECT boundary, phrase, artifact_digest FROM workflow_approvals WHERE run_id = ?",
        )
        .all(runId);
      expect(rows).toEqual([
        {
          boundary: "through-no-mistakes",
          phrase: frozenPhrase,
          artifact_digest: frozenDigest,
        },
      ]);
    } finally {
      checkDb.close();
    }
  });

  it("returns duplicate approval before mutable approval validations", async () => {
    const cases: Array<{
      runId: string;
      state: string;
      needsManualRecovery?: boolean;
      args: string[];
    }> = [
      {
        runId: "cwfp-approve-duplicate-terminal",
        state: "failed",
        args: [],
      },
      {
        runId: "cwfp-approve-duplicate-recovery",
        state: "running",
        needsManualRecovery: true,
        args: [],
      },
      {
        runId: "cwfp-approve-duplicate-missing-artifact",
        state: "running",
        args: [
          "--artifact-path",
          path.join(os.tmpdir(), "missing-approval.json"),
        ],
      },
    ];

    for (const testCase of cases) {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedRun(db, {
          runId: testCase.runId,
          state: testCase.state,
          needsManualRecovery: testCase.needsManualRecovery ?? false,
        });
        seedApproval(db, {
          runId: testCase.runId,
          boundary: "implementation",
        });
      } finally {
        db.close();
      }

      const result = await run([
        "workflow",
        "run",
        "approve",
        testCase.runId,
        "--approval-boundary",
        "implementation",
        "--phrase",
        "approve implementation",
        ...testCase.args,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "workflow run approve",
        code: "duplicate_approval",
      });

      const checkDb = openDb(dataDir);
      try {
        const count = (
          checkDb
            .prepare(
              "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ? AND boundary = ?",
            )
            .get(testCase.runId, "implementation") as { count: number }
        ).count;
        expect(count).toBe(1);
      } finally {
        checkDb.close();
      }
    }
  });

  it("rechecks run state inside the approval write transaction", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-approve-state-race";
    const fifoPath = path.join(
      makeTempDir("momentum-approve-fifo-"),
      "approval",
    );

    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
      });
    } finally {
      db.close();
    }
    execFileSync("mkfifo", [fifoPath]);

    const worker = new Worker(
      `
        const { workerData } = require("node:worker_threads");
        const fs = require("node:fs");
        const path = require("node:path");
        const { DatabaseSync } = require("node:sqlite");

        const db = new DatabaseSync(path.join(workerData.dataDir, "momentum.db"));
        db.prepare("UPDATE workflow_runs SET state = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), workerData.runId);
        db.close();
        fs.writeFileSync(workerData.fifoPath, "approval artifact after terminal transition");
      `,
      {
        eval: true,
        workerData: { dataDir, fifoPath, runId },
      },
    );
    const workerDone = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`approval race worker exited with code ${code}`));
        }
      });
    });

    const result = await run([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "implementation",
      "--phrase",
      "approve implementation",
      "--artifact-path",
      fifoPath,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    await workerDone;

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run approve",
      code: "invalid_state",
      runId,
      boundary: "implementation",
    });

    const dbCheck = openDb(dataDir);
    try {
      const runRow = dbCheck
        .prepare(
          "SELECT state, approval_boundary FROM workflow_runs WHERE id = ?",
        )
        .get(runId) as { state: string; approval_boundary: string | null };
      expect(runRow).toEqual({
        state: "failed",
        approval_boundary: null,
      });
      const approvalCount = (
        dbCheck
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_approvals WHERE run_id = ?",
          )
          .get(runId) as { count: number }
      ).count;
      expect(approvalCount).toBe(0);
    } finally {
      dbCheck.close();
    }
  });
});
