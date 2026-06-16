import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  getWorkflowRunManualRecoveryState,
  markWorkflowRunNeedsManualRecovery
} from "../src/core/workflow/run-recovery.js";
import { reconcileWorkflowRunManualRecovery } from "../src/core/workflow/recovery-reconcile.js";
import {
  resolveWorkflowRecoveryArtifactPath,
  WORKFLOW_RECOVERY_SAFETY_NOTES
} from "../src/core/workflow/recovery-artifact.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-recovery-reconcile-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedRun(
  db: MomentumDb,
  id: string,
  options: { planJson?: string; updatedAt?: number } = {}
): void {
  const updatedAt = options.updatedAt ?? 1_730_000_000_000;
  if (options.planJson !== undefined) {
    db.prepare(
      `INSERT INTO workflow_runs (id, source, plan_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, "agent-workflow", options.planJson, updatedAt, updatedAt);
    return;
  }
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "agent-workflow", updatedAt, updatedAt);
}

function seedStep(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: string,
  options: { kind?: string; order?: number; required?: number } = {}
): void {
  const at = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    stepId,
    options.kind ?? "implementation",
    state,
    options.order ?? 0,
    options.required ?? 1,
    at,
    at
  );
}

function readRunRow(
  db: MomentumDb,
  id: string
): {
  needs_manual_recovery: number;
  manual_recovery_reason: string | null;
  manual_recovery_at: number | null;
} {
  return db
    .prepare(
      `SELECT needs_manual_recovery, manual_recovery_reason, manual_recovery_at
         FROM workflow_runs WHERE id = ?`
    )
    .get(id) as {
    needs_manual_recovery: number;
    manual_recovery_reason: string | null;
    manual_recovery_at: number | null;
  };
}

describe("reconcileWorkflowRunManualRecovery", () => {
  it("sets the durable flag and writes recovery.md for a failed required step", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      seedStep(db, "run-1", "implementation", "failed");

      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-1",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("marked");
      if (out.outcome !== "marked") throw new Error("expected marked outcome");
      expect(out.recoveryCode).toBe("failed_required_step");
      expect(out.stepId).toBe("implementation");
      expect(out.previouslyMarked).toBe(false);
      expect(out.markedAt).toBe(1_730_000_500_000);

      // Durable flag set, reason mirrors the monitor recovery message.
      const row = readRunRow(db, "run-1");
      expect(row.needs_manual_recovery).toBe(1);
      expect(row.manual_recovery_reason).toMatch(/required step/i);
      expect(row.manual_recovery_at).toBe(1_730_000_500_000);

      // recovery.md rendered at the run-scoped path with the required sections.
      const artifactPath = resolveWorkflowRecoveryArtifactPath(
        agentWorkflowsDir,
        "run-1"
      );
      expect(out.artifactPath).toBe(artifactPath);
      const body = fs.readFileSync(artifactPath, "utf8");
      expect(body).toContain("Run ID: run-1");
      expect(body).toContain("Step ID: implementation");
      expect(body).toContain("failed_required_step");
      expect(body).toContain("## Recommended next action");
      expect(body).toContain(WORKFLOW_RECOVERY_SAFETY_NOTES[0]);
    } finally {
      db.close();
    }
  });

  it("sets the flag and writes recovery.md for a ghost active running step (no lease)", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-ghost");
      // Running step with no dispatch lease and no checkpoint -> ghost.
      seedStep(db, "run-ghost", "impl", "running");

      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-ghost",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("marked");
      if (out.outcome !== "marked") throw new Error("expected marked outcome");
      expect(out.recoveryCode).toBe("ghost_active_no_lease");

      const row = readRunRow(db, "run-ghost");
      expect(row.needs_manual_recovery).toBe(1);

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-ghost"),
        "utf8"
      );
      expect(body).toContain("ghost_active_no_lease");
    } finally {
      db.close();
    }
  });

  it("returns artifact_write_failed after setting the durable flag when recovery.md cannot be written", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsFile = path.join(makeTempDir(), "agent-workflows");
    fs.writeFileSync(agentWorkflowsFile, "not a directory");
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-writefail");
      seedStep(db, "run-writefail", "implementation", "failed");

      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-writefail",
        agentWorkflowsDir: agentWorkflowsFile,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("artifact_write_failed");
      if (out.outcome !== "artifact_write_failed") {
        throw new Error("expected artifact_write_failed outcome");
      }
      expect(out.artifactWriteError.code).toBe(
        "recovery_artifact_write_failed"
      );
      expect(out.recoveryCode).toBe("failed_required_step");

      const row = readRunRow(db, "run-writefail");
      expect(row.needs_manual_recovery).toBe(1);
      expect(row.manual_recovery_reason).toMatch(/required step/i);
    } finally {
      db.close();
    }
  });

  it("does nothing for a clean run with no blocking recovery condition", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-clean");
      seedStep(db, "run-clean", "implementation", "succeeded");

      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-clean",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out).toEqual({
        ok: true,
        outcome: "no_recovery_required",
        runId: "run-clean"
      });

      const row = readRunRow(db, "run-clean");
      expect(row.needs_manual_recovery).toBe(0);
      // No artifact written for a clean run.
      expect(
        fs.existsSync(
          resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-clean")
        )
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses with run_not_found when the run does not exist", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "missing",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("run_not_found");
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second reconcile reports previouslyMarked and overwrites recovery.md", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      seedStep(db, "run-1", "implementation", "failed");

      reconcileWorkflowRunManualRecovery(db, {
        runId: "run-1",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });
      const second = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-1",
        agentWorkflowsDir,
        now: 1_730_000_900_000
      });

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected success");
      if (second.outcome !== "marked") throw new Error("expected marked outcome");
      expect(second.previouslyMarked).toBe(true);
      expect(second.markedAt).toBe(1_730_000_900_000);

      // Artifact reflects the most recent classification timestamp.
      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-1"),
        "utf8"
      );
      expect(body).toContain("Classified at (epoch ms): 1730000900000");
    } finally {
      db.close();
    }
  });

  it("never auto-clears an already-flagged run that no longer has a blocking condition", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      // Underlying step is resolved (succeeded), but the durable flag is still
      // set from an earlier failure. Reconcile is a setter, not a clearer, and
      // must never clear from substrate state alone.
      seedStep(db, "run-1", "implementation", "succeeded");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "failed_required_step",
        now: 1_730_000_400_000
      });

      const out = reconcileWorkflowRunManualRecovery(db, {
        runId: "run-1",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("no_recovery_required");

      // The durable flag is preserved; clearing stays explicit + operator-driven.
      const state = getWorkflowRunManualRecoveryState(db, "run-1");
      expect(state?.needsManualRecovery).toBe(true);
      expect(state?.markedAt).toBe(1_730_000_400_000);
    } finally {
      db.close();
    }
  });

  it("keeps run-row secrets out of the rendered recovery.md", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      // A secret hidden in the durable plan_json must never reach the artifact:
      // the renderer only consumes bounded structured fields.
      seedRun(db, "run-secret", {
        planJson: JSON.stringify({ token: "SECRET_TOKEN_abc123" })
      });
      seedStep(db, "run-secret", "implementation", "failed");

      reconcileWorkflowRunManualRecovery(db, {
        runId: "run-secret",
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-secret"),
        "utf8"
      );
      expect(body).not.toContain("SECRET_TOKEN_abc123");
    } finally {
      db.close();
    }
  });

  it("throws when runId is empty", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        reconcileWorkflowRunManualRecovery(db, {
          runId: "",
          agentWorkflowsDir,
          now: 1
        })
      ).toThrow(/runId is required/);
    } finally {
      db.close();
    }
  });

  it("throws when agentWorkflowsDir is empty", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        reconcileWorkflowRunManualRecovery(db, {
          runId: "run-1",
          agentWorkflowsDir: "",
          now: 1
        })
      ).toThrow(/agentWorkflowsDir is required/);
    } finally {
      db.close();
    }
  });

  it("throws when now is not finite", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      expect(() =>
        reconcileWorkflowRunManualRecovery(db, {
          runId: "run-1",
          agentWorkflowsDir,
          now: Number.POSITIVE_INFINITY
        })
      ).toThrow(/now must be finite/);
    } finally {
      db.close();
    }
  });
});
