import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import { getWorkflowRunManualRecoveryState } from "../src/workflow-run-recovery.js";
import { resolveWorkflowRecoveryArtifactPath } from "../src/workflow-recovery-artifact.js";
import { persistLiveWorkflowFinalizeRecovery } from "../src/live-step-run-recovery.js";
import type {
  FinalizeLiveWorkflowStepFromResultFileResult,
  FinalizeLiveWorkflowStepResult
} from "../src/live-step-finalize.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-live-run-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedRun(db: MomentumDb, id: string): void {
  const at = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "agent-workflow", at, at);
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

const EXPECTED_HEAD = "a".repeat(40);
const MOVED_HEAD = "b".repeat(40);

function headMismatchResult(): FinalizeLiveWorkflowStepResult {
  return {
    outcome: "manual_recovery_required",
    recoveryCode: "head_mismatch",
    trigger: "pre_finalize",
    expectedHead: EXPECTED_HEAD,
    currentHead: MOVED_HEAD,
    reason: `live workflow step left HEAD at ${MOVED_HEAD} but expected base ${EXPECTED_HEAD}; entering manual recovery instead of a destructive reset`
  };
}

function resultMissingResult(
  resultFilePath: string
): FinalizeLiveWorkflowStepFromResultFileResult {
  return {
    outcome: "result_missing",
    resultFilePath,
    error: `live step result file was not written at ${resultFilePath}.`
  };
}

function resultInvalidResult(
  resultFilePath: string
): FinalizeLiveWorkflowStepFromResultFileResult {
  return {
    outcome: "result_invalid",
    resultFilePath,
    error: `live step result JSON is invalid: not a RunnerResult`
  };
}

describe("persistLiveWorkflowFinalizeRecovery", () => {
  it("sets the durable flag and writes recovery.md for a head_mismatch finalize outcome", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-head");

      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-head",
        stepId: "implementation",
        finalize: headMismatchResult(),
        agentWorkflowsDir,
        repoPath: "/tmp/repo",
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("recovered");
      if (out.outcome !== "recovered") throw new Error("expected recovered");
      expect(out.recoveryCode).toBe("head_mismatch");
      expect(out.stepId).toBe("implementation");
      expect(out.previouslyMarked).toBe(false);
      expect(out.markedAt).toBe(1_730_000_500_000);

      // Durable flag set with the finalize reason as the authority.
      const row = readRunRow(db, "run-head");
      expect(row.needs_manual_recovery).toBe(1);
      expect(row.manual_recovery_reason).toContain("HEAD");
      expect(row.manual_recovery_at).toBe(1_730_000_500_000);

      // recovery.md rendered at the run-scoped path with the live classification.
      const artifactPath = resolveWorkflowRecoveryArtifactPath(
        agentWorkflowsDir,
        "run-head"
      );
      expect(out.artifactPath).toBe(artifactPath);
      const body = fs.readFileSync(artifactPath, "utf8");
      expect(body).toContain("Run ID: run-head");
      expect(body).toContain("Step ID: implementation");
      expect(body).toContain("- Recovery classification: head_mismatch");
      expect(body).toContain(MOVED_HEAD);
      expect(body).toContain("## Safe next steps");
    } finally {
      db.close();
    }
  });

  it("sets the durable flag and writes recovery.md for a result_missing finalize outcome", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-missing");
      const resultFilePath = "/tmp/iter/runner-result.json";

      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-missing",
        stepId: "implementation",
        finalize: resultMissingResult(resultFilePath),
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      if (out.outcome !== "recovered") throw new Error("expected recovered");
      expect(out.recoveryCode).toBe("result_missing");

      const row = readRunRow(db, "run-missing");
      expect(row.needs_manual_recovery).toBe(1);

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-missing"),
        "utf8"
      );
      expect(body).toContain("- Recovery classification: result_missing");
      expect(body).toContain(resultFilePath);
    } finally {
      db.close();
    }
  });

  it("sets the durable flag and writes recovery.md for a result_invalid finalize outcome", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-invalid");

      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-invalid",
        stepId: "implementation",
        finalize: resultInvalidResult("/tmp/iter/runner-result.json"),
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      if (out.outcome !== "recovered") throw new Error("expected recovered");
      expect(out.recoveryCode).toBe("result_invalid");

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-invalid"),
        "utf8"
      );
      expect(body).toContain("- Recovery classification: result_invalid");
    } finally {
      db.close();
    }
  });

  it("does nothing for a committed finalize outcome", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-ok");

      const committed = {
        outcome: "committed"
      } as FinalizeLiveWorkflowStepFromResultFileResult;
      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-ok",
        stepId: "implementation",
        finalize: committed,
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out).toEqual({
        ok: true,
        outcome: "no_recovery_required",
        runId: "run-ok"
      });

      const row = readRunRow(db, "run-ok");
      expect(row.needs_manual_recovery).toBe(0);
      expect(
        fs.existsSync(
          resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-ok")
        )
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does nothing for a clean reset (step or verification failure handled by reset)", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-reset");

      for (const outcome of [
        "reset_step_failure",
        "reset_verification_failure"
      ] as const) {
        const out = persistLiveWorkflowFinalizeRecovery(db, {
          runId: "run-reset",
          stepId: "implementation",
          finalize: {
            outcome
          } as FinalizeLiveWorkflowStepFromResultFileResult,
          agentWorkflowsDir,
          now: 1_730_000_500_000
        });
        expect(out.ok).toBe(true);
        if (!out.ok) throw new Error("expected success");
        expect(out.outcome).toBe("no_recovery_required");
      }

      const row = readRunRow(db, "run-reset");
      expect(row.needs_manual_recovery).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses with run_not_found when the run does not exist", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "missing",
        stepId: "implementation",
        finalize: headMismatchResult(),
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("run_not_found");

      // No artifact written when the run cannot be flagged.
      expect(
        fs.existsSync(
          resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "missing")
        )
      ).toBe(false);
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

      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-writefail",
        stepId: "implementation",
        finalize: headMismatchResult(),
        agentWorkflowsDir: agentWorkflowsFile,
        now: 1_730_000_500_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected success");
      expect(out.outcome).toBe("artifact_write_failed");
      if (out.outcome !== "artifact_write_failed") {
        throw new Error("expected artifact_write_failed outcome");
      }
      expect(out.recoveryCode).toBe("head_mismatch");
      expect(out.artifactWriteError.code).toBe("recovery_artifact_write_failed");

      // The durable flag is the authority and must land even when the
      // best-effort artifact write fails.
      const row = readRunRow(db, "run-writefail");
      expect(row.needs_manual_recovery).toBe(1);
      expect(row.manual_recovery_reason).toContain("HEAD");
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second persist reports previouslyMarked and overwrites recovery.md", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-twice");

      const first = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-twice",
        stepId: "implementation",
        finalize: headMismatchResult(),
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });
      expect(first.ok).toBe(true);
      if (!first.ok || first.outcome !== "recovered") {
        throw new Error("expected first recovered");
      }
      expect(first.previouslyMarked).toBe(false);

      const second = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-twice",
        stepId: "implementation",
        finalize: headMismatchResult(),
        agentWorkflowsDir,
        now: 1_730_000_900_000
      });
      expect(second.ok).toBe(true);
      if (!second.ok || second.outcome !== "recovered") {
        throw new Error("expected second recovered");
      }
      expect(second.previouslyMarked).toBe(true);
      expect(second.markedAt).toBe(1_730_000_900_000);

      const state = getWorkflowRunManualRecoveryState(db, "run-twice");
      expect(state?.needsManualRecovery).toBe(true);

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-twice"),
        "utf8"
      );
      expect(body).toContain("Classified at (epoch ms): 1730000900000");
    } finally {
      db.close();
    }
  });

  it("renders the live step id as (none) when no step id is provided", () => {
    const dataDir = makeTempDir();
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-nostep");

      const out = persistLiveWorkflowFinalizeRecovery(db, {
        runId: "run-nostep",
        stepId: null,
        finalize: headMismatchResult(),
        agentWorkflowsDir,
        now: 1_730_000_500_000
      });
      expect(out.ok).toBe(true);

      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, "run-nostep"),
        "utf8"
      );
      expect(body).toContain("- Step ID: (none)");
    } finally {
      db.close();
    }
  });
});
