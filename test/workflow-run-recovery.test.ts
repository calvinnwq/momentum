import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  clearWorkflowRunManualRecovery,
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
  isBlockingWorkflowRecoveryCode,
  markWorkflowRunNeedsManualRecovery
} from "../src/core/workflow/run-recovery.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-run-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedRun(db: MomentumDb, id: string, updatedAt = 1_730_000_000_000): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "agent-workflow", updatedAt, updatedAt);
}

function seedRunWithState(
  db: MomentumDb,
  id: string,
  state: string,
  options: { updatedAt?: number; finishedAt?: number | null } = {}
): void {
  const updatedAt = options.updatedAt ?? 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs (
       id, source, state, finished_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "momentum-native-coding",
    state,
    options.finishedAt ?? null,
    updatedAt,
    updatedAt
  );
}

function seedStep(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: string,
  options: { kind?: string; order?: number; required?: number; at?: number } = {}
): void {
  const at = options.at ?? 1_730_000_000_000;
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
  updated_at: number;
} {
  return db
    .prepare(
      `SELECT needs_manual_recovery, manual_recovery_reason,
              manual_recovery_at, updated_at
         FROM workflow_runs WHERE id = ?`
    )
    .get(id) as {
    needs_manual_recovery: number;
    manual_recovery_reason: string | null;
    manual_recovery_at: number | null;
    updated_at: number;
  };
}

function readRunRuntimeRow(
  db: MomentumDb,
  id: string
): { state: string; finished_at: number | null } {
  return db
    .prepare("SELECT state, finished_at FROM workflow_runs WHERE id = ?")
    .get(id) as { state: string; finished_at: number | null };
}

describe("markWorkflowRunNeedsManualRecovery", () => {
  it("sets needs_manual_recovery, reason, at, and updated_at on the run row", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      const out = markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "manual_recovery_lease",
        now: 1_730_000_500_000
      });
      expect(out).toEqual({ ok: true, previouslyMarked: false });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 1,
        manual_recovery_reason: "manual_recovery_lease",
        manual_recovery_at: 1_730_000_500_000,
        updated_at: 1_730_000_500_000
      });
    } finally {
      db.close();
    }
  });

  it("is idempotent and reports previouslyMarked=true on the second call", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "manual_recovery_lease",
        now: 1_730_000_500_000
      });
      const second = markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "ghost_active_no_lease",
        now: 1_730_000_600_000
      });
      expect(second).toEqual({ ok: true, previouslyMarked: true });

      const row = readRunRow(db, "run-1");
      expect(row.manual_recovery_reason).toBe("ghost_active_no_lease");
      expect(row.manual_recovery_at).toBe(1_730_000_600_000);
    } finally {
      db.close();
    }
  });

  it("refuses with run_not_found when the run does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = markWorkflowRunNeedsManualRecovery(db, {
        runId: "missing",
        reason: "manual_recovery_lease",
        now: 1
      });
      expect(out).toEqual({ ok: false, reason: "run_not_found" });
    } finally {
      db.close();
    }
  });

  it("throws when runId is empty", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        markWorkflowRunNeedsManualRecovery(db, {
          runId: "",
          reason: "manual_recovery_lease"
        })
      ).toThrow(/runId is required/);
    } finally {
      db.close();
    }
  });

  it("throws when reason is empty", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      expect(() =>
        markWorkflowRunNeedsManualRecovery(db, {
          runId: "run-1",
          reason: ""
        })
      ).toThrow(/reason is required/);
    } finally {
      db.close();
    }
  });
});

describe("clearWorkflowRunManualRecovery", () => {
  it("clears the flag and nulls reason/at while bumping updated_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "manual_recovery_lease",
        now: 1_730_000_500_000
      });

      const out = clearWorkflowRunManualRecovery(db, {
        runId: "run-1",
        now: 1_730_000_900_000
      });
      expect(out).toEqual({ ok: true, wasMarked: true });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 0,
        manual_recovery_reason: null,
        manual_recovery_at: null,
        updated_at: 1_730_000_900_000
      });
    } finally {
      db.close();
    }
  });

  it("reports wasMarked=false when the run was not flagged", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      const out = clearWorkflowRunManualRecovery(db, {
        runId: "run-1",
        now: 1_730_000_900_000
      });
      expect(out).toEqual({ ok: true, wasMarked: false });
    } finally {
      db.close();
    }
  });

  it("refuses with run_not_found when the run does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = clearWorkflowRunManualRecovery(db, {
        runId: "missing",
        now: 1
      });
      expect(out).toEqual({ ok: false, reason: "run_not_found" });
    } finally {
      db.close();
    }
  });
});

describe("getWorkflowRunManualRecoveryState", () => {
  it("returns the durable recovery state for a flagged run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "failed_required_step",
        now: 1_730_000_500_000
      });
      const state = getWorkflowRunManualRecoveryState(db, "run-1");
      expect(state).toEqual({
        runId: "run-1",
        needsManualRecovery: true,
        reason: "failed_required_step",
        markedAt: 1_730_000_500_000
      });
    } finally {
      db.close();
    }
  });

  it("returns an unflagged state for a clean run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      const state = getWorkflowRunManualRecoveryState(db, "run-1");
      expect(state).toEqual({
        runId: "run-1",
        needsManualRecovery: false,
        reason: null,
        markedAt: null
      });
    } finally {
      db.close();
    }
  });

  it("returns undefined when the run does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(getWorkflowRunManualRecoveryState(db, "missing")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("isBlockingWorkflowRecoveryCode", () => {
  it("treats the hard recovery codes as blocking", () => {
    expect(isBlockingWorkflowRecoveryCode("manual_recovery_lease")).toBe(true);
    expect(isBlockingWorkflowRecoveryCode("ghost_active_no_lease")).toBe(true);
    expect(isBlockingWorkflowRecoveryCode("stale_running_step")).toBe(true);
    expect(isBlockingWorkflowRecoveryCode("failed_required_step")).toBe(true);
  });

  it("treats a failed external-side-effect tail step as blocking", () => {
    // The PR may have already merged before the tail step exited non-zero, so
    // the run must stay blocked for operator reconciliation rather than being
    // cleared as if nothing landed.
    expect(
      isBlockingWorkflowRecoveryCode("failed_external_side_effect_step")
    ).toBe(true);
  });

  it("treats the advisory monitor_drift_stale code as non-blocking", () => {
    expect(isBlockingWorkflowRecoveryCode("monitor_drift_stale")).toBe(false);
  });
});

describe("clearWorkflowRunManualRecoveryGuarded", () => {
  it("clears the flag when the run is flagged but no blocking recovery condition persists", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      // Required step has been re-run to succeeded: the underlying problem is
      // resolved, so the monitor reducer no longer classifies a recovery.
      seedStep(db, "run-1", "implementation", "succeeded");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "failed_required_step",
        now: 1_730_000_500_000
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000
      });
      expect(out).toEqual({
        ok: true,
        runId: "run-1",
        previousReason: "failed_required_step",
        previousMarkedAt: 1_730_000_500_000,
        clearedAt: 1_730_000_900_000
      });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 0,
        manual_recovery_reason: null,
        manual_recovery_at: null,
        updated_at: 1_730_000_900_000
      });
    } finally {
      db.close();
    }
  });

  it("refuses with recovery_clear_refused when the blocking recovery state still exists", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      // Required step is still failed -> monitor reducer still classifies
      // failed_required_step, so the clear must refuse.
      seedStep(db, "run-1", "implementation", "failed");
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "failed_required_step",
        now: 1_730_000_500_000
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      expect(out.recoveryCode).toBe("failed_required_step");
      expect(out.blockingStepId).toBe("implementation");

      // The durable flag must remain set after a refused clear.
      const row = readRunRow(db, "run-1");
      expect(row.needs_manual_recovery).toBe(1);
      expect(row.manual_recovery_reason).toBe("failed_required_step");
      expect(row.manual_recovery_at).toBe(1_730_000_500_000);
    } finally {
      db.close();
    }
  });

  it("reconciles an unflagged failed external-side-effect tail step with evidence", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2
      });
      seedStep(db, "run-1", "no-mistakes", "succeeded", {
        kind: "no-mistakes",
        order: 3
      });
      seedStep(db, "run-1", "merge-cleanup", "failed", {
        kind: "merge-cleanup",
        order: 4
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        externalSideEffectEvidencePointer: "github://pulls/123#merged",
        externalSideEffectLedgerPointer: "ledger://merge-cleanup#42"
      });

      expect(out).toEqual({
        ok: true,
        runId: "run-1",
        previousReason: null,
        previousMarkedAt: null,
        clearedAt: 1_730_000_900_000,
        reconciledStep: {
          stepId: "merge-cleanup",
          recoveryCode: "failed_external_side_effect_step",
          state: "succeeded",
          evidencePointer: "github://pulls/123#merged",
          ledgerPointer: "ledger://merge-cleanup#42"
        }
      });
      expect(getWorkflowRunManualRecoveryState(db, "run-1")).toMatchObject({
        needsManualRecovery: false,
        reason: null,
        markedAt: null
      });
      const step = db
        .prepare(
          `SELECT state, operator_reason, operator_evidence_pointer, operator_ledger_pointer
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`
        )
        .get("run-1", "merge-cleanup") as {
        state: string;
        operator_reason: string | null;
        operator_evidence_pointer: string | null;
        operator_ledger_pointer: string | null;
      };
      expect(step).toEqual({
        state: "succeeded",
        operator_reason: "failed_external_side_effect_step",
        operator_evidence_pointer: "github://pulls/123#merged",
        operator_ledger_pointer: "ledger://merge-cleanup#42"
      });
    } finally {
      db.close();
    }
  });

  it("reconciles an interrupted no-mistakes terminal failure from checks-passed evidence", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000
      });
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3
      });
      seedStep(db, "run-1", "merge-cleanup", "approved", {
        kind: "merge-cleanup",
        order: 4
      });
      seedStep(db, "run-1", "linear-refresh", "approved", {
        kind: "linear-refresh",
        order: 5
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
        successfulNoMistakesLedgerPointer:
          ".agent-workflows/run-1/daemon-no-mistakes.json#interrupted-wrapper"
      });

      expect(out).toEqual({
        ok: true,
        runId: "run-1",
        previousReason: null,
        previousMarkedAt: null,
        clearedAt: 1_730_000_900_000,
        reconciledStep: {
          stepId: "no-mistakes",
          recoveryCode: "interrupted_no_mistakes_checks_passed",
          state: "succeeded",
          evidencePointer:
            "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
          ledgerPointer:
            ".agent-workflows/run-1/daemon-no-mistakes.json#interrupted-wrapper"
        }
      });

      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "approved",
        finished_at: null
      });
      const step = db
        .prepare(
          `SELECT state, operator_reason, operator_evidence_pointer,
                  operator_ledger_pointer, finished_at
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`
        )
        .get("run-1", "no-mistakes") as {
        state: string;
        operator_reason: string | null;
        operator_evidence_pointer: string | null;
        operator_ledger_pointer: string | null;
        finished_at: number | null;
      };
      expect(step).toEqual({
        state: "succeeded",
        operator_reason: "interrupted_no_mistakes_checks_passed",
        operator_evidence_pointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
        operator_ledger_pointer:
          ".agent-workflows/run-1/daemon-no-mistakes.json#interrupted-wrapper",
        finished_at: 1_730_000_900_000
      });
    } finally {
      db.close();
    }
  });

  it("refuses no-mistakes reconciliation for non-checks-passed evidence", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#failed"
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      expect(out.recoveryCode).toBe("failed_required_step");
      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "failed",
        finished_at: 1_730_000_800_000
      });
    } finally {
      db.close();
    }
  });

  it("refuses malformed no-mistakes checks-passed evidence without a run id", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer: "no-mistakes:#checks-passed"
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      expect(out.recoveryCode).toBe("failed_required_step");
    } finally {
      db.close();
    }
  });

  it("replaces the stale failure finished_at when no-mistakes reconciliation terminally succeeds the run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000
      });
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed"
      });

      expect(out.ok).toBe(true);
      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "succeeded",
        finished_at: 1_730_000_900_000
      });
    } finally {
      db.close();
    }
  });

  it("refuses no-mistakes evidence for ordinary failed required steps", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000
      });
      seedStep(db, "run-1", "implementation", "failed", {
        kind: "implementation",
        order: 1
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed"
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      expect(out.blockingStepId).toBe("implementation");
    } finally {
      db.close();
    }
  });

  it("refuses with not_flagged when the run exists but is not flagged", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("not_flagged");
    } finally {
      db.close();
    }
  });

  it("refuses with run_not_found when the run does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "missing",
        now: 1_730_000_900_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("run_not_found");
    } finally {
      db.close();
    }
  });

  it("throws when runId is empty", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        clearWorkflowRunManualRecoveryGuarded(db, { runId: "" })
      ).toThrow(/runId is required/);
    } finally {
      db.close();
    }
  });

  it("throws when now is not finite", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, "run-1");
      expect(() =>
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId: "run-1",
          now: Number.POSITIVE_INFINITY
        })
      ).toThrow(/now must be finite/);
    } finally {
      db.close();
    }
  });
});
