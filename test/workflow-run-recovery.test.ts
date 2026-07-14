import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  acquireRepoLock,
  markRepoLockNeedsManualRecovery,
} from "../src/core/repo/locks.js";
import {
  clearWorkflowRunManualRecovery,
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
  isBlockingWorkflowRecoveryCode,
  markWorkflowRunNeedsManualRecovery,
} from "../src/core/workflow/run/recovery.js";
import { findRetryableDispatchedStepRecovery } from "../src/core/workflow/dispatch/retry.js";

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

function seedRun(
  db: MomentumDb,
  id: string,
  updatedAt = 1_730_000_000_000,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, "agent-workflow", updatedAt, updatedAt);
}

function seedRunWithState(
  db: MomentumDb,
  id: string,
  state: string,
  options: {
    updatedAt?: number;
    finishedAt?: number | null;
    issueScope?: unknown;
  } = {},
): void {
  const updatedAt = options.updatedAt ?? 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs (
       id, source, state, issue_scope_json, finished_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "momentum-native-coding",
    state,
    JSON.stringify(options.issueScope ?? {}),
    options.finishedAt ?? null,
    updatedAt,
    updatedAt,
  );
}

function seedStep(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: string,
  options: {
    kind?: string;
    order?: number;
    required?: number;
    at?: number;
  } = {},
): void {
  const at = options.at ?? 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    stepId,
    options.kind ?? "implementation",
    state,
    options.order ?? 0,
    options.required ?? 1,
    at,
    at,
  );
}

function seedRetryableDelegateRecovery(
  db: MomentumDb,
  options: {
    executorFamily?: string;
    recoveryCode?: string;
  } = {},
): {
  runId: string;
  stepId: string;
  invocationId: string;
  at: number;
  lockId: string;
} {
  const runId = "run-delegate-retry";
  const stepId = "implementation";
  const invocationId = `${runId}::${stepId}::dispatch`;
  const at = 1_730_000_500_000;
  const executorFamily = options.executorFamily ?? "delegate-supervisor";
  const recoveryCode = options.recoveryCode ?? "delegate_handoff_failed";
  seedRun(db, runId);
  seedStep(db, runId, stepId, "running", { at });
  db.prepare(
    `INSERT INTO executor_invocations (
       invocation_id, workflow_run_id, step_run_id, step_key,
       executor_family, state, attempt, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invocationId,
    runId,
    stepId,
    stepId,
    executorFamily,
    "manual_recovery_required",
    2,
    at,
    at,
    at,
  );
  db.prepare(
    `INSERT INTO executor_rounds (
       round_id, invocation_id, workflow_run_id, step_run_id, step_key,
       executor_family, attempt, round_index, state, recovery_code,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${invocationId}::round-2`,
    invocationId,
    runId,
    stepId,
    stepId,
    executorFamily,
    2,
    1,
    "manual_recovery_required",
    recoveryCode,
    at,
    at,
  );
  markWorkflowRunNeedsManualRecovery(db, {
    runId,
    reason: recoveryCode,
    now: at,
  });
  const acquired = acquireRepoLock(db, {
    repoRoot: "/repos/delegate-retry",
    holder: "delegate-worker",
    goalId: runId,
    iteration: 2,
    jobId: invocationId,
    leaseExpiresAt: at + 30_000,
    now: at,
  });
  if (!acquired.ok) throw new Error(acquired.reason);
  const parked = markRepoLockNeedsManualRecovery(db, {
    lockId: acquired.lockId,
    now: at + 1,
    recoveryStatus: "unproven delegated handoff",
  });
  if (!parked.ok) throw new Error("failed to park delegate repo lock");
  return { runId, stepId, invocationId, at, lockId: acquired.lockId };
}

function seedNoMistakesCheckpoint(
  db: MomentumDb,
  runId: string,
  stepId: string,
  options: {
    executorFamily?: "no-mistakes" | "delegate-supervisor";
    delegateCheckpoint?: "mirrored" | "handoff" | "handoff-terminal";
    delegateTool?: string;
    noMistakesRunId?: string;
    branch?: string;
    headSha?: string;
    prUrl?: string | null;
    at?: number;
  } = {},
): void {
  const at = options.at ?? 1_730_000_000_000;
  const executorFamily = options.executorFamily ?? "no-mistakes";
  const invocationId = `${runId}::${stepId}::dispatch`;
  const roundId = `${invocationId}::round-0`;
  const externalState = {
    externalRunId: options.noMistakesRunId ?? "01KWHNGX561PASS000000000000",
    branch: options.branch ?? "feat/ngx-561-deterministic-no-mistakes-evidence",
    headSha: options.headSha ?? "1111111111111111111111111111111111111111",
    activeStep: null,
    stepStatus: "completed",
    prUrl:
      options.prUrl === undefined
        ? "https://github.com/acme/momentum/pull/193"
        : options.prUrl,
    ciState: "passed",
  };
  const delegateCheckpoint = options.delegateCheckpoint ?? "mirrored";
  const checkpointStage =
    executorFamily === "no-mistakes"
      ? "external_state_mirrored"
      : delegateCheckpoint === "mirrored"
        ? "delegate_external_state_mirrored"
        : "delegate_handoff_completed";
  const externalIdentity = {
    externalRunId: externalState.externalRunId,
    branch: externalState.branch,
    headSha: externalState.headSha,
  };
  const checkpointDetail =
    executorFamily === "no-mistakes"
      ? externalState
      : delegateCheckpoint === "mirrored"
        ? {
            state: externalState,
            progressDigest: "sha256:delegate-progress",
            progressAt: at,
            observedAt: at,
          }
        : {
            externalIdentity,
            summary: "Delegated handoff completed.",
            ...(delegateCheckpoint === "handoff-terminal"
              ? {
                  terminalState: {
                    value: externalState,
                    digest: "sha256:delegate-terminal",
                  },
                }
              : {}),
          };
  db.prepare(
    `INSERT INTO executor_invocations (
       invocation_id, workflow_run_id, step_run_id, step_key, executor_family,
       state, attempt, started_at, heartbeat_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invocationId,
    runId,
    stepId,
    stepId,
    executorFamily,
    "running",
    1,
    at,
    at,
    at,
    at,
  );
  db.prepare(
    `INSERT INTO executor_rounds (
       round_id, invocation_id, workflow_run_id, step_run_id, step_key,
       executor_family, attempt, round_index, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    roundId,
    invocationId,
    runId,
    stepId,
    stepId,
    executorFamily,
    1,
    0,
    "mirroring_external_state",
    at,
    at,
  );
  db.prepare(
    `INSERT INTO executor_checkpoints (
       checkpoint_id, round_id, sequence, stage, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `${roundId}::checkpoint-0`,
    roundId,
    0,
    executorFamily === "delegate-supervisor"
      ? "delegate_handoff_intent"
      : checkpointStage,
    JSON.stringify(
      executorFamily === "delegate-supervisor"
        ? {
            tool: options.delegateTool ?? "no-mistakes",
            invocationId,
            attempt: 1,
          }
        : checkpointDetail,
    ),
    at,
  );
  if (executorFamily !== "delegate-supervisor") return;
  db.prepare(
    `INSERT INTO executor_checkpoints (
       checkpoint_id, round_id, sequence, stage, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `${roundId}::checkpoint-1`,
    roundId,
    1,
    checkpointStage,
    JSON.stringify(checkpointDetail),
    at,
  );
}

function seedNoMistakesExternalStateCheckpoint(
  db: MomentumDb,
  runId: string,
  stepId: string,
  sequence: number,
  detail: Record<string, unknown>,
  at = 1_730_000_000_000,
): void {
  const roundId = `${runId}::${stepId}::dispatch::round-0`;
  db.prepare(
    `INSERT INTO executor_checkpoints (
       checkpoint_id, round_id, sequence, stage, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `${roundId}::checkpoint-${sequence}`,
    roundId,
    sequence,
    "external_state_mirrored",
    JSON.stringify(detail),
    at,
  );
}

function readRunRow(
  db: MomentumDb,
  id: string,
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
         FROM workflow_runs WHERE id = ?`,
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
  id: string,
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
        now: 1_730_000_500_000,
      });
      expect(out).toEqual({ ok: true, previouslyMarked: false });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 1,
        manual_recovery_reason: "manual_recovery_lease",
        manual_recovery_at: 1_730_000_500_000,
        updated_at: 1_730_000_500_000,
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
        now: 1_730_000_500_000,
      });
      const second = markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-1",
        reason: "ghost_active_no_lease",
        now: 1_730_000_600_000,
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
        now: 1,
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
          reason: "manual_recovery_lease",
        }),
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
          reason: "",
        }),
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
        now: 1_730_000_500_000,
      });

      const out = clearWorkflowRunManualRecovery(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
      });
      expect(out).toEqual({ ok: true, wasMarked: true });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 0,
        manual_recovery_reason: null,
        manual_recovery_at: null,
        updated_at: 1_730_000_900_000,
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
        now: 1_730_000_900_000,
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
        now: 1,
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
        now: 1_730_000_500_000,
      });
      const state = getWorkflowRunManualRecoveryState(db, "run-1");
      expect(state).toEqual({
        runId: "run-1",
        needsManualRecovery: true,
        reason: "failed_required_step",
        markedAt: 1_730_000_500_000,
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
        markedAt: null,
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
      isBlockingWorkflowRecoveryCode("failed_external_side_effect_step"),
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
        now: 1_730_000_500_000,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
      });
      expect(out).toEqual({
        ok: true,
        runId: "run-1",
        previousReason: "failed_required_step",
        previousMarkedAt: 1_730_000_500_000,
        clearedAt: 1_730_000_900_000,
      });

      const row = readRunRow(db, "run-1");
      expect(row).toEqual({
        needs_manual_recovery: 0,
        manual_recovery_reason: null,
        manual_recovery_at: null,
        updated_at: 1_730_000_900_000,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    "tool_adapter_unavailable",
    "delegate_handoff_failed",
    "delegate_handoff_recovery_required",
    "external_state_unreadable",
    "external_state_inconsistent",
    "external_state_blocked",
  ])(
    "does not apply delegate recovery code %s to an unrelated executor",
    (recoveryCode) => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const { runId } = seedRetryableDelegateRecovery(db, {
          executorFamily: "fixture-executor",
          recoveryCode,
        });
        expect(
          findRetryableDispatchedStepRecovery(db, {
            runId,
            stepState: "running",
          }),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );

  it("retains delegate recovery semantics for the legacy no-mistakes executor", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = seedRetryableDelegateRecovery(db, {
        executorFamily: "no-mistakes",
        recoveryCode: "external_state_unreadable",
      });
      expect(
        findRetryableDispatchedStepRecovery(db, {
          runId,
          stepState: "running",
        }),
      ).toMatchObject({
        executorFamily: "no-mistakes",
        recoveryCode: "external_state_unreadable",
      });
    } finally {
      db.close();
    }
  });

  it("releases the retryable dispatch repo lock owned by the cleared attempt", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId, stepId, invocationId, at, lockId } =
        seedRetryableDelegateRecovery(db);
      const priorAttempt = acquireRepoLock(db, {
        repoRoot: "/repos/prior-attempt-recovery",
        holder: "other-worker",
        goalId: runId,
        iteration: 1,
        jobId: invocationId,
        leaseExpiresAt: at + 30_000,
        now: at,
      });
      if (!priorAttempt.ok) throw new Error(priorAttempt.reason);
      if (
        !markRepoLockNeedsManualRecovery(db, {
          lockId: priorAttempt.lockId,
          now: at + 1,
        }).ok
      ) {
        throw new Error("failed to park prior-attempt repo lock");
      }
      const otherInvocation = acquireRepoLock(db, {
        repoRoot: "/repos/other-invocation-recovery",
        holder: "other-worker",
        goalId: runId,
        iteration: 2,
        jobId: `${runId}::other-step::dispatch`,
        leaseExpiresAt: at + 30_000,
        now: at,
      });
      if (!otherInvocation.ok) throw new Error(otherInvocation.reason);
      if (
        !markRepoLockNeedsManualRecovery(db, {
          lockId: otherInvocation.lockId,
          now: at + 1,
        }).ok
      ) {
        throw new Error("failed to park other-invocation repo lock");
      }

      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: at + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId,
          recoveryCode: "delegate_handoff_failed",
        },
      });
      expect(
        db.prepare("SELECT state FROM repo_locks WHERE id = ?").get(lockId),
      ).toEqual({ state: "released" });
      expect(
        db
          .prepare("SELECT state FROM repo_locks WHERE id = ?")
          .get(priorAttempt.lockId),
      ).toEqual({ state: "needs_manual_recovery" });
      expect(
        db
          .prepare("SELECT state FROM repo_locks WHERE id = ?")
          .get(otherInvocation.lockId),
      ).toEqual({ state: "needs_manual_recovery" });
      expect(
        acquireRepoLock(db, {
          repoRoot: "/repos/delegate-retry",
          holder: "retry-worker",
          goalId: runId,
          iteration: 3,
          jobId: invocationId,
          leaseExpiresAt: at + 60_000,
          now: at + 3,
        }).ok,
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rolls back retry preparation and lock release when recovery clear fails", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId, stepId, at, lockId } = seedRetryableDelegateRecovery(db);
      db.exec(
        `CREATE TRIGGER fail_workflow_recovery_clear
         BEFORE UPDATE OF needs_manual_recovery ON workflow_runs
         WHEN OLD.id = '${runId}' AND NEW.needs_manual_recovery = 0
         BEGIN
           SELECT RAISE(ABORT, 'forced workflow recovery clear failure');
         END`,
      );

      expect(() =>
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: at + 2,
        }),
      ).toThrow("forced workflow recovery clear failure");
      expect(
        db.prepare("SELECT state FROM repo_locks WHERE id = ?").get(lockId),
      ).toEqual({ state: "needs_manual_recovery" });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, stepId),
      ).toEqual({ state: "running" });
      expect(getWorkflowRunManualRecoveryState(db, runId)).toMatchObject({
        needsManualRecovery: true,
        reason: "delegate_handoff_failed",
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
        now: 1_730_000_500_000,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
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
        order: 0,
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1,
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2,
      });
      seedStep(db, "run-1", "no-mistakes", "succeeded", {
        kind: "no-mistakes",
        order: 3,
      });
      seedStep(db, "run-1", "merge-cleanup", "failed", {
        kind: "merge-cleanup",
        order: 4,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        externalSideEffectEvidencePointer: "github://pulls/123#merged",
        externalSideEffectLedgerPointer: "ledger://merge-cleanup#42",
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
          ledgerPointer: "ledger://merge-cleanup#42",
        },
      });
      expect(getWorkflowRunManualRecoveryState(db, "run-1")).toMatchObject({
        needsManualRecovery: false,
        reason: null,
        markedAt: null,
      });
      const step = db
        .prepare(
          `SELECT state, operator_reason, operator_evidence_pointer, operator_ledger_pointer
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
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
        operator_ledger_pointer: "ledger://merge-cleanup#42",
      });
    } finally {
      db.close();
    }
  });

  it("replaces a stale failure finished_at when external reconciliation terminally succeeds the run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0,
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1,
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2,
      });
      seedStep(db, "run-1", "no-mistakes", "succeeded", {
        kind: "no-mistakes",
        order: 3,
      });
      seedStep(db, "run-1", "merge-cleanup", "failed", {
        kind: "merge-cleanup",
        order: 4,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        externalSideEffectEvidencePointer: "github://pulls/123#merged",
      });

      expect(out.ok).toBe(true);
      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "succeeded",
        finished_at: 1_730_000_900_000,
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
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0,
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1,
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2,
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedStep(db, "run-1", "merge-cleanup", "approved", {
        kind: "merge-cleanup",
        order: 4,
      });
      seedStep(db, "run-1", "linear-refresh", "approved", {
        kind: "linear-refresh",
        order: 5,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
        successfulNoMistakesLedgerPointer:
          ".agent-workflows/run-1/daemon-no-mistakes.json#interrupted-wrapper",
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
            ".agent-workflows/run-1/daemon-no-mistakes.json#interrupted-wrapper",
        },
      });

      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "approved",
        finished_at: null,
      });
      const step = db
        .prepare(
          `SELECT state, operator_reason, operator_evidence_pointer,
                  operator_ledger_pointer, finished_at
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
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
        finished_at: 1_730_000_900_000,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      label: "legacy mirrored",
      executorFamily: "no-mistakes" as const,
      delegateCheckpoint: undefined,
    },
    {
      label: "delegate mirrored",
      executorFamily: "delegate-supervisor" as const,
      delegateCheckpoint: "mirrored" as const,
    },
    {
      label: "delegate handoff identity",
      executorFamily: "delegate-supervisor" as const,
      delegateCheckpoint: "handoff" as const,
    },
    {
      label: "delegate terminal handoff",
      executorFamily: "delegate-supervisor" as const,
      delegateCheckpoint: "handoff-terminal" as const,
    },
  ])(
    "reconciles $label no-mistakes checkpoint evidence without a new no-mistakes run",
    ({ executorFamily, delegateCheckpoint }) => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedRunWithState(db, "run-ngx-561", "failed", {
          finishedAt: 1_730_000_800_000,
          issueScope: { identifiers: ["NGX-561"] },
        });
        seedStep(db, "run-ngx-561", "preflight", "succeeded", {
          kind: "preflight",
          order: 0,
        });
        seedStep(db, "run-ngx-561", "implementation", "succeeded", {
          kind: "implementation",
          order: 1,
        });
        seedStep(db, "run-ngx-561", "postflight", "succeeded", {
          kind: "postflight",
          order: 2,
        });
        seedStep(db, "run-ngx-561", "no-mistakes", "failed", {
          kind: "no-mistakes",
          order: 3,
        });
        seedNoMistakesCheckpoint(db, "run-ngx-561", "no-mistakes", {
          executorFamily,
          ...(delegateCheckpoint !== undefined ? { delegateCheckpoint } : {}),
        });

        const evidence = JSON.parse(
          fs.readFileSync(
            path.join(
              process.cwd(),
              "test/fixtures/no-mistakes-evidence-clean-success.json",
            ),
            "utf8",
          ),
        ) as unknown;
        const out = clearWorkflowRunManualRecoveryGuarded(db, {
          runId: "run-ngx-561",
          now: 1_730_000_900_000,
          successfulNoMistakesEvidencePointer:
            ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
          successfulNoMistakesEvidence: evidence,
          successfulNoMistakesLedgerPointer:
            ".agent-workflows/run-ngx-561/no-mistakes-evidence.json#sha256=test",
        });

        expect(out).toEqual({
          ok: true,
          runId: "run-ngx-561",
          previousReason: null,
          previousMarkedAt: null,
          clearedAt: 1_730_000_900_000,
          reconciledStep: {
            stepId: "no-mistakes",
            recoveryCode: "interrupted_no_mistakes_checks_passed",
            state: "succeeded",
            evidencePointer:
              ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
            ledgerPointer:
              ".agent-workflows/run-ngx-561/no-mistakes-evidence.json#sha256=test",
          },
        });
        const step = db
          .prepare(
            `SELECT state, operator_reason, operator_actor, operator_evidence_pointer,
                  operator_ledger_pointer
             FROM workflow_steps WHERE run_id = ? AND step_id = ?`,
          )
          .get("run-ngx-561", "no-mistakes") as {
          state: string;
          operator_reason: string | null;
          operator_actor: string | null;
          operator_evidence_pointer: string | null;
          operator_ledger_pointer: string | null;
        };
        expect(step).toEqual({
          state: "succeeded",
          operator_reason: "interrupted_no_mistakes_checks_passed",
          operator_actor: "workflow run clear-recovery",
          operator_evidence_pointer:
            ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
          operator_ledger_pointer:
            ".agent-workflows/run-ngx-561/no-mistakes-evidence.json#sha256=test",
        });
      } finally {
        db.close();
      }
    },
  );

  it("refuses delegate checkpoint evidence owned by another tool", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-ngx-561", "failed", {
        finishedAt: 1_730_000_800_000,
        issueScope: { identifiers: ["NGX-561"] },
      });
      seedStep(db, "run-ngx-561", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedNoMistakesCheckpoint(db, "run-ngx-561", "no-mistakes", {
        executorFamily: "delegate-supervisor",
        delegateCheckpoint: "mirrored",
        delegateTool: "other-tool",
      });
      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "test/fixtures/no-mistakes-evidence-clean-success.json",
          ),
          "utf8",
        ),
      ) as unknown;

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-ngx-561",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
        successfulNoMistakesEvidence: evidence,
      });

      expect(out).toMatchObject({
        ok: false,
        reason: "recovery_clear_refused",
      });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get("run-ngx-561", "no-mistakes"),
      ).toEqual({ state: "failed" });
    } finally {
      db.close();
    }
  });

  it("refuses no-mistakes evidence when only a prior attempt has identity", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const runId = "run-ngx-561";
      const stepId = "no-mistakes";
      const invocationId = `${runId}::${stepId}::dispatch`;
      const roundId = `${invocationId}::round-1`;
      seedRunWithState(db, runId, "failed", {
        finishedAt: 1_730_000_800_000,
        issueScope: { identifiers: ["NGX-561"] },
      });
      seedStep(db, runId, stepId, "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedNoMistakesCheckpoint(db, runId, stepId, {
        executorFamily: "delegate-supervisor",
        delegateCheckpoint: "mirrored",
      });
      db.prepare(
        `UPDATE executor_invocations
            SET attempt = 2, updated_at = ?
          WHERE invocation_id = ?`,
      ).run(1_730_000_100_000, invocationId);
      db.prepare(
        `INSERT INTO executor_rounds (
           round_id, invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, attempt, round_index, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        roundId,
        invocationId,
        runId,
        stepId,
        stepId,
        "delegate-supervisor",
        2,
        1,
        "running",
        1_730_000_100_000,
        1_730_000_100_000,
      );
      db.prepare(
        `INSERT INTO executor_checkpoints (
           checkpoint_id, round_id, sequence, stage, detail, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `${roundId}::checkpoint-0`,
        roundId,
        0,
        "delegate_handoff_intent",
        JSON.stringify({ tool: "no-mistakes", invocationId, attempt: 2 }),
        1_730_000_100_000,
      );
      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "test/fixtures/no-mistakes-evidence-clean-success.json",
          ),
          "utf8",
        ),
      ) as unknown;

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId,
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
        successfulNoMistakesEvidence: evidence,
      });

      expect(out).toMatchObject({
        ok: false,
        reason: "recovery_clear_refused",
      });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, stepId),
      ).toEqual({ state: "failed" });
    } finally {
      db.close();
    }
  });

  it("keeps no-mistakes blocked when deterministic evidence is stale", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-ngx-561", "failed", {
        finishedAt: 1_730_000_800_000,
        issueScope: { identifiers: ["NGX-561"] },
      });
      seedStep(db, "run-ngx-561", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedNoMistakesCheckpoint(db, "run-ngx-561", "no-mistakes");

      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "test/fixtures/no-mistakes-evidence-missing-test-phase.json",
          ),
          "utf8",
        ),
      ) as unknown;
      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-ngx-561",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
        successfulNoMistakesEvidence: evidence,
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      const step = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("run-ngx-561", "no-mistakes") as { state: string };
      expect(step.state).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("keeps no-mistakes blocked when deterministic evidence mismatches the durable no-mistakes checkpoint", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-ngx-561", "failed", {
        finishedAt: 1_730_000_800_000,
        issueScope: { identifiers: ["NGX-561"] },
      });
      seedStep(db, "run-ngx-561", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedNoMistakesCheckpoint(db, "run-ngx-561", "no-mistakes");

      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "test/fixtures/no-mistakes-evidence-stale-head.json",
          ),
          "utf8",
        ),
      ) as unknown;
      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-ngx-561",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
        successfulNoMistakesEvidence: evidence,
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      const step = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("run-ngx-561", "no-mistakes") as { state: string };
      expect(step.state).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("keeps no-mistakes blocked when latest checkpoint PR identity mismatches deterministic evidence", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-ngx-561", "failed", {
        finishedAt: 1_730_000_800_000,
        issueScope: { identifiers: ["NGX-561"] },
      });
      seedStep(db, "run-ngx-561", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });
      seedNoMistakesCheckpoint(db, "run-ngx-561", "no-mistakes", {
        prUrl: null,
      });
      seedNoMistakesExternalStateCheckpoint(
        db,
        "run-ngx-561",
        "no-mistakes",
        1,
        {
          externalRunId: "01KWHNGX561PASS000000000000",
          branch: "feat/ngx-561-deterministic-no-mistakes-evidence",
          headSha: "1111111111111111111111111111111111111111",
          activeStep: null,
          stepStatus: "completed",
          prUrl: "https://github.com/acme/momentum/pull/193",
          ciState: "passed",
        },
      );

      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "test/fixtures/no-mistakes-evidence-pr-mismatch.json",
          ),
          "utf8",
        ),
      ) as unknown;
      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-ngx-561",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          ".agent-workflows/run-ngx-561/no-mistakes-evidence.json",
        successfulNoMistakesEvidence: evidence,
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      const step = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("run-ngx-561", "no-mistakes") as { state: string };
      expect(step.state).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("refuses no-mistakes reconciliation for non-checks-passed evidence", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithState(db, "run-1", "failed", {
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#failed",
      });

      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("expected refusal");
      expect(out.reason).toBe("recovery_clear_refused");
      expect(out.recoveryCode).toBe("failed_required_step");
      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "failed",
        finished_at: 1_730_000_800_000,
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
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer: "no-mistakes:#checks-passed",
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
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "preflight", "succeeded", {
        kind: "preflight",
        order: 0,
      });
      seedStep(db, "run-1", "implementation", "succeeded", {
        kind: "implementation",
        order: 1,
      });
      seedStep(db, "run-1", "postflight", "succeeded", {
        kind: "postflight",
        order: 2,
      });
      seedStep(db, "run-1", "no-mistakes", "failed", {
        kind: "no-mistakes",
        order: 3,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
      });

      expect(out.ok).toBe(true);
      expect(readRunRuntimeRow(db, "run-1")).toEqual({
        state: "succeeded",
        finished_at: 1_730_000_900_000,
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
        finishedAt: 1_730_000_800_000,
      });
      seedStep(db, "run-1", "implementation", "failed", {
        kind: "implementation",
        order: 1,
      });

      const out = clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "run-1",
        now: 1_730_000_900_000,
        successfulNoMistakesEvidencePointer:
          "no-mistakes:01KW18T2ZP97FGGYTX7MSWV573#checks-passed",
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
        now: 1_730_000_900_000,
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
        now: 1_730_000_900_000,
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
        clearWorkflowRunManualRecoveryGuarded(db, { runId: "" }),
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
          now: Number.POSITIVE_INFINITY,
        }),
      ).toThrow(/now must be finite/);
    } finally {
      db.close();
    }
  });
});
