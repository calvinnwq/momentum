import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { advanceLiveWorkflowStep } from "../src/core/executors/live-step/advance.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import { resolveWorkflowRecoveryArtifactPath } from "../src/core/workflow/recovery/artifact.js";
import { getRepoLock } from "../src/core/repo/locks.js";
import type { PersistLiveWorkflowFinalizeRecoveryResult } from "../src/core/executors/live-step/run-recovery.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorDispatchResult,
  WorkflowStepExecutorInput,
  WorkflowStepExecutorKind
} from "../src/core/workflow/step/executor.js";
import type { CommitIntent, RunnerResult } from "../src/core/executors/runner/types.js";
import type {
  WorkflowApprovalBoundary,
  WorkflowStepState
} from "../src/core/workflow/run/reducer.js";

const SEED_AT = 1_730_000_000_000;
const NOW = SEED_AT + 1_000;
const LEASE_EXPIRES_AT = SEED_AT + 60_000;
const RUN_ID = "run-1";
const STEP_ID = "step-impl";
const HOLDER = "worker-1";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-live-advance-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-live-advance-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitInitial(dir: string): string {
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

function headOf(repoPath: string): string {
  return runGit(repoPath, ["rev-parse", "HEAD"]).trim();
}

function baseIntent(overrides: Partial<CommitIntent> = {}): CommitIntent {
  return {
    type: "feat",
    scope: "live",
    subject: "advance live workflow step",
    body: "",
    breaking: false,
    ...overrides
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "live step finished",
    key_changes_made: ["wrote step-edit.txt"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: false,
    commit: baseIntent(),
    ...overrides
  };
}

/**
 * Seed a repo-backed, approved workflow run with one approved implementation
 * step, a matching active repo lock held by `HOLDER`, and approval coverage —
 * exactly the durable state the M9-02 orchestrator's start gate requires.
 */
function seedRepoBackedRun(
  db: MomentumDb,
  repoPath: string,
  opts: {
    runState?: "pending" | "approved" | "running";
    stepState?: WorkflowStepState;
    boundary?: WorkflowApprovalBoundary;
    goalId?: string;
  } = {}
): void {
  const runState = opts.runState ?? "approved";
  const stepState = opts.stepState ?? "approved";
  const boundary = opts.boundary ?? "implementation";
  const goalId = opts.goalId ?? "goal-1";

  db.prepare(
    `INSERT OR IGNORE INTO goals (
       id, title, repo, runner, branch, max_iterations, verification,
       verification_timeout_sec, state, artifact_dir, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    goalId,
    goalId,
    repoPath,
    "fake",
    "main",
    1,
    "[]",
    900,
    "initialized",
    `/tmp/${goalId}`,
    SEED_AT,
    SEED_AT
  );

  db.prepare(
    `INSERT INTO workflow_runs (
       id, source, state, repo_path, goal_id, approval_boundary, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    RUN_ID,
    "agent-workflow",
    runState,
    repoPath,
    goalId,
    boundary,
    SEED_AT,
    SEED_AT
  );

  db.prepare(
    `INSERT INTO workflow_approvals (
       run_id, boundary, actor, phrase, artifact_path, artifact_digest,
       recorded_at, discharged_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    RUN_ID,
    boundary,
    "operator",
    "APPROVE",
    `workflow-run-approve://${RUN_ID}/${boundary}`,
    `sha256:${RUN_ID}:${boundary}`,
    SEED_AT,
    null,
    SEED_AT,
    SEED_AT
  );

  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required,
       result_digest, error_code, error_message, started_at, finished_at,
       operator_transition_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    RUN_ID,
    STEP_ID,
    "implementation",
    stepState,
    1,
    1,
    null,
    null,
    null,
    null,
    null,
    null,
    SEED_AT,
    SEED_AT
  );

  db.prepare(
    `INSERT INTO repo_locks (
       id, repo_root, holder, goal_id, iteration, job_id, state,
       acquired_at, heartbeat_at, lease_expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `lock-${HOLDER}`,
    repoPath,
    HOLDER,
    goalId,
    1,
    "job-1",
    "active",
    SEED_AT,
    SEED_AT,
    LEASE_EXPIRES_AT,
    SEED_AT
  );
}

function buildExecutorInput(
  repoPath: string,
  runDir: string
): WorkflowStepExecutorInput {
  return {
    runId: RUN_ID,
    stepId: STEP_ID,
    kind: "implementation",
    attempt: 1,
    repoPath,
    runDir,
    resultJsonPath: path.join(runDir, "runner-result.json"),
    executorLogPath: path.join(runDir, "executor.log")
  };
}

function fakeExecutor(
  execute: (input: WorkflowStepExecutorInput) => WorkflowStepExecutorDispatchResult,
  kind: WorkflowStepExecutorKind = "implementation"
): WorkflowStepExecutor {
  return { kind, executes: true, execute };
}

function succeededDispatch(
  input: WorkflowStepExecutorInput,
  resultDigest: string | null = "sha256:ok"
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "succeeded",
      summary: "did the work",
      checkpoints: [],
      artifacts: [],
      resultDigest,
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath
  };
}

function runnerFailedDispatch(
  input: WorkflowStepExecutorInput
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "failed",
      summary: "runner reported success=false",
      checkpoints: [],
      artifacts: [],
      resultDigest: "sha256:failed",
      errorCode: "command_failed",
      errorMessage: "live step runner reported success=false",
      retryHint: null,
      recoveryHint: null
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath
  };
}

type AdvanceOverrides = {
  verificationCommands?: string[];
  agentWorkflowsDir?: string;
  leaseExpiresAt?: number;
  verificationTimeoutSec?: number;
  runState?: "pending" | "approved" | "running";
  stepState?: WorkflowStepState;
};

function runAdvance(
  db: MomentumDb,
  repoPath: string,
  baseHead: string,
  runDir: string,
  executor: WorkflowStepExecutor,
  overrides: AdvanceOverrides = {}
): ReturnType<typeof advanceLiveWorkflowStep> {
  const agentWorkflowsDir = overrides.agentWorkflowsDir ?? makeTempDir();
  return advanceLiveWorkflowStep({
    db,
    runId: RUN_ID,
    stepId: STEP_ID,
    holder: HOLDER,
    leaseExpiresAt: overrides.leaseExpiresAt ?? LEASE_EXPIRES_AT,
    executor,
    executorInput: buildExecutorInput(repoPath, runDir),
    baseHead,
    verificationCommands: overrides.verificationCommands ?? ["echo verify-ok"],
    verificationTimeoutSec: overrides.verificationTimeoutSec ?? 30,
    verificationLogPath: path.join(runDir, "verification.log"),
    agentWorkflowsDir,
    now: NOW
  });
}

function expectRecoveryOk(
  recovery: PersistLiveWorkflowFinalizeRecoveryResult | undefined
): Extract<PersistLiveWorkflowFinalizeRecoveryResult, { ok: true }> {
  expect(recovery).toBeDefined();
  if (!recovery || !recovery.ok) {
    throw new Error("expected an ok recovery result");
  }
  return recovery;
}

describe("advanceLiveWorkflowStep", () => {
  it("runs the step, verifies, and commits the diff when the step succeeds", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        })
      );

      expect(out.committed).toBe(true);
      expect(out.finalized).toBe(true);
      expect(out.run.ok).toBe(true);
      expect(out.finalize?.outcome).toBe("committed");
      expect(expectRecoveryOk(out.recovery).outcome).toBe(
        "no_recovery_required"
      );

      // The step's diff is committed on top of the base.
      const head = headOf(repoPath);
      expect(head).not.toBe(baseHead);
      if (out.finalize?.outcome === "committed") {
        expect(out.finalize.commit.parentSha).toBe(baseHead);
        expect(out.finalize.head).toBe(head);
        expect(out.finalize.commit.message).toBe(
          "feat(live): advance live workflow step"
        );
      }

      // Durable step state settled to succeeded and the run is not in recovery.
      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("succeeded");
      const workflowRun = db
        .prepare(
          `SELECT state, finished_at AS finishedAt
             FROM workflow_runs WHERE id = ?`
        )
        .get(RUN_ID) as { state: string; finishedAt: number | null };
      expect(workflowRun.state).toBe("succeeded");
      expect(workflowRun.finishedAt).toBe(NOW);
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("updates terminal run state and releases the step lease atomically", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      db.function("momentum_test_in_transaction", () =>
        db.isTransaction ? 1 : 0
      );
      db.exec(`
        CREATE TABLE terminal_state_atomicity_probe (
          event TEXT PRIMARY KEY,
          in_transaction INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER capture_terminal_release_transaction
          AFTER UPDATE OF released_at ON workflow_leases
          WHEN NEW.run_id = '${RUN_ID}'
            AND NEW.lease_kind = 'managed-step'
            AND NEW.released_at IS NOT NULL
        BEGIN
          INSERT INTO terminal_state_atomicity_probe (event, in_transaction)
          VALUES ('lease_release', momentum_test_in_transaction());
        END;
        CREATE TRIGGER capture_terminal_run_state_transaction
          AFTER UPDATE OF state ON workflow_runs
          WHEN NEW.id = '${RUN_ID}'
            AND NEW.state = 'succeeded'
        BEGIN
          INSERT INTO terminal_state_atomicity_probe (event, in_transaction)
          VALUES ('run_state', momentum_test_in_transaction());
        END;
      `);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        })
      );

      expect(out.committed).toBe(true);
      const probeRows = db
        .prepare(
          `SELECT event, in_transaction AS inTransaction
             FROM terminal_state_atomicity_probe
            ORDER BY event`
        )
        .all() as Array<{ event: string; inTransaction: number }>;
      expect(probeRows).toEqual([
        { event: "lease_release", inTransaction: 1 },
        { event: "run_state", inTransaction: 1 }
      ]);
    } finally {
      db.close();
    }
  });

  it("resets the worktree without recovery when verification fails", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        { verificationCommands: ["false"] }
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("reset_verification_failure");
      expect(expectRecoveryOk(out.recovery).outcome).toBe(
        "no_recovery_required"
      );

      // The worktree was reset back to base; the step edit is gone.
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("live_finalize_reset_verification_failure");
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("marks the durable step failed when commit finalization cannot produce a Momentum commit", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        })
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("commit_failed");
      if (out.finalize?.outcome === "commit_failed") {
        expect(out.finalize.commit.code).toBe("nothing_to_commit");
      }
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("live_finalize_commit_failed");
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps the repo lock fresh while verification runs during finalization", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    const probePath = path.join(runDir, "repo-lock-heartbeat.json");
    try {
      seedRepoBackedRun(db, repoPath);

      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for repo lock heartbeat test");
      }
      const probeScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const fs = require('node:fs');",
        `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
        `const row = () => db.prepare(${JSON.stringify("SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt FROM repo_locks WHERE id = ?")}).get(${JSON.stringify(`lock-${HOLDER}`)});`,
        "const before = row();",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);",
        "const after = row();",
        `fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ before, after }));`,
        "db.close();",
        "process.exit(after.leaseExpiresAt > before.leaseExpiresAt ? 0 : 2);"
      ].join(" ");

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        {
          leaseExpiresAt: NOW + 1_000,
          verificationCommands: [`node -e ${JSON.stringify(probeScript)}`],
          verificationTimeoutSec: 5
        }
      );

      expect(out.committed).toBe(true);
      const probe = JSON.parse(fs.readFileSync(probePath, "utf-8")) as {
        before: { heartbeatAt: number; leaseExpiresAt: number };
        after: { heartbeatAt: number; leaseExpiresAt: number };
      };
      expect(probe.after.leaseExpiresAt).toBeGreaterThan(
        probe.before.leaseExpiresAt
      );
      expect(getRepoLock(db, `lock-${HOLDER}`)?.lease_expires_at).toBeGreaterThan(
        probe.before.leaseExpiresAt
      );
    } finally {
      db.close();
    }
  });

  it("keeps the finalization heartbeat duration after execution passes the original lease deadline", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    const probePath = path.join(runDir, "finalize-lease-duration.json");
    try {
      seedRepoBackedRun(db, repoPath);
      const leaseExpiresAt = Date.now() + 500;
      db.prepare(
        `UPDATE repo_locks
            SET acquired_at = ?,
                heartbeat_at = ?,
                lease_expires_at = ?,
                updated_at = ?
          WHERE id = ?`
      ).run(
        Date.now(),
        Date.now(),
        leaseExpiresAt,
        Date.now(),
        `lock-${HOLDER}`
      );

      const probeScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const fs = require('node:fs');",
        `const db = new DatabaseSync(${JSON.stringify(db.location())});`,
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);",
        `const row = db.prepare(${JSON.stringify("SELECT lease_expires_at AS leaseExpiresAt FROM repo_locks WHERE id = ?")}).get(${JSON.stringify(`lock-${HOLDER}`)});`,
        "const remainingMs = row.leaseExpiresAt - Date.now();",
        `fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ remainingMs }));`,
        "db.close();",
        "process.exit(remainingMs > 20 ? 0 : 2);"
      ].join(" ");

      const out = advanceLiveWorkflowStep({
        db,
        runId: RUN_ID,
        stepId: STEP_ID,
        holder: HOLDER,
        leaseExpiresAt,
        executor: fakeExecutor((input) => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        executorInput: buildExecutorInput(repoPath, runDir),
        baseHead,
        verificationCommands: [`node -e ${JSON.stringify(probeScript)}`],
        verificationTimeoutSec: 5,
        verificationLogPath: path.join(runDir, "verification.log"),
        agentWorkflowsDir: makeTempDir()
      });

      expect(out.committed).toBe(true);
      expect(out.finalize?.outcome).toBe("committed");
      const probe = JSON.parse(fs.readFileSync(probePath, "utf-8")) as {
        remainingMs: number;
      };
      expect(probe.remainingMs).toBeGreaterThan(20);
    } finally {
      db.close();
    }
  });

  it("keeps a successful step running and leased until finalization completes", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    const probePath = path.join(runDir, "workflow-step-finalize-gate.json");
    try {
      seedRepoBackedRun(db, repoPath);

      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for step finalize gate test");
      }
      const probeScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const fs = require('node:fs');",
        `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
        `const step = db.prepare(${JSON.stringify("SELECT state, finished_at AS finishedAt FROM workflow_steps WHERE run_id = ? AND step_id = ?")}).get(${JSON.stringify(RUN_ID)}, ${JSON.stringify(STEP_ID)});`,
        `const lease = db.prepare(${JSON.stringify("SELECT released_at AS releasedAt FROM workflow_leases WHERE run_id = ? AND lease_kind = 'managed-step'")}).get(${JSON.stringify(RUN_ID)});`,
        `fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ step, lease }));`,
        "db.close();",
        "process.exit(step && step.state === 'running' && step.finishedAt === null && lease && lease.releasedAt === null ? 0 : 7);"
      ].join(" ");

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        { verificationCommands: [`node -e ${JSON.stringify(probeScript)}`] }
      );

      expect(out.committed).toBe(true);
      expect(out.finalize?.outcome).toBe("committed");
      const probe = JSON.parse(fs.readFileSync(probePath, "utf-8")) as {
        step: { state: string; finishedAt: number | null };
        lease: { releasedAt: number | null };
      };
      expect(probe.step.state).toBe("running");
      expect(probe.step.finishedAt).toBeNull();
      expect(probe.lease.releasedAt).toBeNull();
      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("succeeded");
    } finally {
      db.close();
    }
  });

  it("keeps a failed normalized step running and leased until reset finalization completes", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      db.exec(
        `CREATE TABLE reset_finalize_probe (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           step_state TEXT NOT NULL,
           lease_released_at INTEGER
         ) STRICT`
      );
      db.exec(
        `CREATE TRIGGER capture_reset_finalize_gate
           AFTER UPDATE OF heartbeat_at ON repo_locks
           WHEN NEW.id = 'lock-${HOLDER}'
         BEGIN
           DELETE FROM reset_finalize_probe;
           INSERT INTO reset_finalize_probe (id, step_state, lease_released_at)
           SELECT 1, workflow_steps.state, workflow_leases.released_at
             FROM workflow_steps
             LEFT JOIN workflow_leases
                    ON workflow_leases.run_id = workflow_steps.run_id
                   AND workflow_leases.lease_kind = 'managed-step'
            WHERE workflow_steps.run_id = '${RUN_ID}'
              AND workflow_steps.step_id = '${STEP_ID}';
         END`
      );

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult({ success: false })),
            "utf-8"
          );
          return runnerFailedDispatch(input);
        })
      );

      expect(out.finalize?.outcome).toBe("reset_step_failure");
      const probe = db
        .prepare(
          `SELECT step_state AS stepState, lease_released_at AS leaseReleasedAt
             FROM reset_finalize_probe WHERE id = 1`
        )
        .get() as { stepState: string; leaseReleasedAt: number | null };
      expect(probe.stepState).toBe("running");
      expect(probe.leaseReleasedAt).toBeNull();
      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("failed");
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps the managed-step lease fresh while verification runs during finalization", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    const probePath = path.join(runDir, "workflow-lease-heartbeat.json");
    try {
      seedRepoBackedRun(db, repoPath);

      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for workflow lease heartbeat test");
      }
      const probeScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const fs = require('node:fs');",
        `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
        `const row = () => db.prepare(${JSON.stringify("SELECT heartbeat_at AS heartbeatAt, expires_at AS expiresAt FROM workflow_leases WHERE run_id = ? AND lease_kind = 'managed-step'")}).get(${JSON.stringify(RUN_ID)});`,
        "const before = row();",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);",
        "const after = row();",
        `fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ before, after }));`,
        "db.close();",
        "process.exit(after.expiresAt > before.expiresAt ? 0 : 2);"
      ].join(" ");

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        {
          leaseExpiresAt: NOW + 1_000,
          verificationCommands: [`node -e ${JSON.stringify(probeScript)}`],
          verificationTimeoutSec: 5
        }
      );

      expect(out.committed).toBe(true);
      const probe = JSON.parse(fs.readFileSync(probePath, "utf-8")) as {
        before: { heartbeatAt: number; expiresAt: number };
        after: { heartbeatAt: number; expiresAt: number };
      };
      expect(probe.after.expiresAt).toBeGreaterThan(probe.before.expiresAt);
    } finally {
      db.close();
    }
  });

  it("refuses finalization when the active repo lock belongs to another goal", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      db.exec(
        `CREATE TABLE replace_repo_lock_after_final_heartbeat (
           enabled INTEGER NOT NULL
         ) STRICT`
      );
      db.exec(
        `CREATE TRIGGER replace_repo_lock_after_live_final_heartbeat
           AFTER UPDATE OF heartbeat_at ON workflow_leases
           WHEN NEW.run_id = '${RUN_ID}'
             AND NEW.lease_kind = 'managed-step'
             AND EXISTS (SELECT 1 FROM replace_repo_lock_after_final_heartbeat)
         BEGIN
           DELETE FROM replace_repo_lock_after_final_heartbeat;
           UPDATE repo_locks
              SET goal_id = 'goal-2',
                  job_id = 'job-2',
                  updated_at = NEW.updated_at
            WHERE id = 'lock-${HOLDER}';
         END`
      );

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          db.prepare(
            `INSERT INTO replace_repo_lock_after_final_heartbeat (enabled)
             VALUES (1)`
          ).run();
          return succeededDispatch(input);
        })
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(false);
      expect(expectRecoveryOk(out.recovery).outcome).toBe("recovered");
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("live_finalize_repo_lock_lost");
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("refuses to commit when the repo lock is lost during finalization", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for repo lock loss test");
      }
      const releaseLockScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
        `db.prepare(${JSON.stringify("UPDATE repo_locks SET state = 'released', updated_at = ? WHERE id = ?")}).run(${NOW + 5}, ${JSON.stringify(`lock-${HOLDER}`)});`,
        "db.close();",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);"
      ].join(" ");

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        {
          leaseExpiresAt: NOW + 50,
          verificationCommands: [`node -e ${JSON.stringify(releaseLockScript)}`]
        }
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("repo_lock_lost");
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("live_finalize_repo_lock_lost");
    } finally {
      db.close();
    }
  });

  it("rejects a committed finalize outcome when the repo lock is lost before git returns", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for repo lock loss test");
      }
      const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
      fs.writeFileSync(
        hookPath,
        [
          "#!/bin/sh",
          "node <<'NODE'",
          "const { DatabaseSync } = require('node:sqlite');",
          `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
          `db.prepare(${JSON.stringify("UPDATE repo_locks SET state = 'released', updated_at = ? WHERE id = ?")}).run(Date.now(), ${JSON.stringify(`lock-${HOLDER}`)});`,
          "db.close();",
          "NODE"
        ].join("\n"),
        { mode: 0o755 }
      );

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        })
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("repo_lock_lost");
      expect(headOf(repoPath)).not.toBe(baseHead);
      expect(expectRecoveryOk(out.recovery).outcome).toBe("recovered");
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("failed");
      expect(step?.errorCode).toBe("live_finalize_repo_lock_lost");
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("refuses to release a deferred lease after conflicting terminal metadata is written", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      const dbPath = db.location();
      if (typeof dbPath !== "string" || dbPath.length === 0) {
        throw new Error("expected file-backed db for terminal conflict test");
      }
      const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
      fs.writeFileSync(
        hookPath,
        [
          "#!/bin/sh",
          "node <<'NODE'",
          "const { DatabaseSync } = require('node:sqlite');",
          `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
          `db.prepare(${JSON.stringify("UPDATE workflow_steps SET state = 'succeeded', finished_at = ?, result_digest = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE run_id = ? AND step_id = ?")}).run(Date.now(), 'sha256:external', Date.now(), ${JSON.stringify(RUN_ID)}, ${JSON.stringify(STEP_ID)});`,
          "db.close();",
          "NODE"
        ].join("\n"),
        { mode: 0o755 }
      );

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input, "sha256:ok");
        })
      );

      expect(out.finalize?.outcome).toBe("committed");
      expect(out.run.ok).toBe(false);
      expect(out.run.finish?.ok).toBe(false);
      if (
        out.run.finish?.ok === false &&
        out.run.finish.reason === "invalid_transition"
      ) {
        expect(out.run.finish.reason).toBe("invalid_transition");
        expect(out.run.finish.errorCode).toBe("workflow_step_invalid_transition");
      }
      expect(out.run.lease.released).toBe(false);
      const step = getWorkflowStep(db, RUN_ID, STEP_ID);
      expect(step?.state).toBe("succeeded");
      expect(step?.resultDigest).toBe("sha256:external");
      const lease = db
        .prepare(
          `SELECT released_at AS releasedAt
             FROM workflow_leases
            WHERE run_id = ? AND lease_kind = 'managed-step'`
        )
        .get(RUN_ID) as { releasedAt: number | null };
      expect(lease.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("resets the worktree without recovery when the runner reports success=false", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult({ success: false })),
            "utf-8"
          );
          return runnerFailedDispatch(input);
        }),
        { verificationCommands: ["echo should-not-run"] }
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("reset_step_failure");
      expect(expectRecoveryOk(out.recovery).outcome).toBe(
        "no_recovery_required"
      );

      // The orchestrator persisted the failed terminal state; the diff is reset.
      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("failed");
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(false);

      const log = fs.readFileSync(path.join(runDir, "verification.log"), "utf-8");
      expect(log).not.toContain("should-not-run");
    } finally {
      db.close();
    }
  });

  it("enters durable recovery without a destructive reset when HEAD moved during the step", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          // Simulate a live step that itself committed: HEAD advances past base.
          fs.writeFileSync(
            path.join(input.repoPath, "rogue.txt"),
            "rogue\n",
            "utf-8"
          );
          runGit(input.repoPath, ["add", "rogue.txt"]);
          runGit(input.repoPath, ["commit", "-m", "rogue live-step commit", "--quiet"]);
          fs.writeFileSync(
            input.resultJsonPath,
            JSON.stringify(runnerResult()),
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        { agentWorkflowsDir, verificationCommands: ["echo should-not-run"] }
      );
      const movedHead = headOf(repoPath);

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("manual_recovery_required");
      if (out.finalize?.outcome === "manual_recovery_required") {
        expect(out.finalize.recoveryCode).toBe("head_mismatch");
      }
      const recovery = expectRecoveryOk(out.recovery);
      expect(recovery.outcome).toBe("recovered");
      if (recovery.outcome === "recovered") {
        expect(recovery.recoveryCode).toBe("head_mismatch");
      }

      // The rogue commit is preserved, not reset.
      expect(movedHead).not.toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "rogue.txt"))).toBe(true);

      // Durable recovery is entered and recovery.md is rendered for the operator.
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, RUN_ID),
        "utf-8"
      );
      expect(body).toContain("- Recovery classification: head_mismatch");
      expect(body).toContain(movedHead);
    } finally {
      db.close();
    }
  });

  it("enters durable recovery when the result document is missing after a clean dispatch", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          // The step edits the worktree and claims success, but the durable
          // result document is never written (e.g. truncated/lost after dispatch).
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        { agentWorkflowsDir }
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(true);
      expect(out.finalize?.outcome).toBe("result_missing");
      const recovery = expectRecoveryOk(out.recovery);
      expect(recovery.outcome).toBe("recovered");
      if (recovery.outcome === "recovered") {
        expect(recovery.recoveryCode).toBe("result_missing");
      }

      // An ambiguous outcome must not destroy the step's work.
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, RUN_ID),
        "utf-8"
      );
      expect(body).toContain("- Recovery classification: result_missing");
    } finally {
      db.close();
    }
  });

  it("sets manual recovery before releasing a deferred finalized lease", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      db.exec(
        `CREATE TABLE release_recovery_probe (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           needs_manual_recovery INTEGER NOT NULL
         ) STRICT`
      );
      db.exec(
        `CREATE TRIGGER capture_recovery_before_lease_release
           AFTER UPDATE OF released_at ON workflow_leases
           WHEN NEW.run_id = '${RUN_ID}'
             AND NEW.lease_kind = 'managed-step'
             AND NEW.released_at IS NOT NULL
         BEGIN
           DELETE FROM release_recovery_probe;
           INSERT INTO release_recovery_probe (id, needs_manual_recovery)
           SELECT 1, needs_manual_recovery
             FROM workflow_runs
            WHERE id = '${RUN_ID}';
         END`
      );

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          return succeededDispatch(input);
        }),
        { agentWorkflowsDir }
      );

      expect(out.finalize?.outcome).toBe("result_missing");
      expect(expectRecoveryOk(out.recovery).outcome).toBe("recovered");
      const probe = db
        .prepare(
          `SELECT needs_manual_recovery AS needsManualRecovery
             FROM release_recovery_probe WHERE id = 1`
        )
        .get() as { needsManualRecovery: number };
      expect(probe.needsManualRecovery).toBe(1);
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not run the git transaction when the orchestrator refuses to start the step", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const db = openDb(makeTempDir());
    try {
      // A pending run is not executable: the orchestrator refuses at the input stage.
      seedRepoBackedRun(db, repoPath, { runState: "pending" });

      let executed = false;
      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          executed = true;
          return succeededDispatch(input);
        })
      );

      expect(executed).toBe(false);
      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(false);
      expect(out.finalize).toBeUndefined();
      expect(out.recovery).toBeUndefined();
      expect(out.run.ok).toBe(false);
      expect(out.run.stage).toBe("input");

      // No git mutation and no durable recovery from a pure start refusal.
      expect(headOf(repoPath)).toBe(baseHead);
      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("approved");
      expect(
        (
          db
            .prepare("SELECT state FROM workflow_runs WHERE id = ?")
            .get(RUN_ID) as { state: string }
        ).state
      ).toBe("pending");
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("enters recovery on a process-level dispatch error after worktree edits", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          // A partial worktree edit followed by a process-level failure.
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          return {
            ok: false,
            code: "runtime_unavailable",
            error: "auth/credentials unavailable",
            executorLogPath: input.executorLogPath,
            resultJsonPath: input.resultJsonPath,
            liveRecoveryCode: "auth_unavailable"
          } as WorkflowStepExecutorDispatchResult;
        }),
        { agentWorkflowsDir }
      );

      expect(out.committed).toBe(false);
      expect(out.finalized).toBe(false);
      expect(out.finalize).toBeUndefined();
      const recovery = expectRecoveryOk(out.recovery);
      expect(recovery.outcome).toBe("recovered");
      if (recovery.outcome === "recovered") {
        expect(recovery.recoveryCode).toBe("auth_unavailable");
      }
      expect(out.run.ok).toBe(false);
      expect(out.run.liveRecoveryCode).toBe("auth_unavailable");

      expect(getWorkflowStep(db, RUN_ID, STEP_ID)?.state).toBe("failed");
      expect(headOf(repoPath)).toBe(baseHead);
      expect(fs.existsSync(path.join(repoPath, "step-edit.txt"))).toBe(true);
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
      const body = fs.readFileSync(
        resolveWorkflowRecoveryArtifactPath(agentWorkflowsDir, RUN_ID),
        "utf-8"
      );
      expect(body).toContain("- Recovery classification: auth_unavailable");
    } finally {
      db.close();
    }
  });

  it("sets dispatch recovery before releasing a failed dispatch lease", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    const runDir = makeTempDir("momentum-live-advance-run-");
    const agentWorkflowsDir = makeTempDir();
    const db = openDb(makeTempDir());
    try {
      seedRepoBackedRun(db, repoPath);
      db.exec(`
        CREATE TABLE dispatch_release_recovery_probe (
          id INTEGER PRIMARY KEY,
          needs_manual_recovery INTEGER NOT NULL
        );
        CREATE TRIGGER capture_dispatch_recovery_before_lease_release
          AFTER UPDATE OF released_at ON workflow_leases
          WHEN NEW.run_id = '${RUN_ID}'
            AND NEW.lease_kind = 'managed-step'
            AND NEW.released_at IS NOT NULL
        BEGIN
          DELETE FROM dispatch_release_recovery_probe;
          INSERT INTO dispatch_release_recovery_probe (id, needs_manual_recovery)
          SELECT 1, needs_manual_recovery
            FROM workflow_runs
           WHERE id = '${RUN_ID}';
        END;
      `);

      const out = runAdvance(
        db,
        repoPath,
        baseHead,
        runDir,
        fakeExecutor((input) => {
          fs.writeFileSync(
            path.join(input.repoPath, "step-edit.txt"),
            "from-live-step\n",
            "utf-8"
          );
          return {
            ok: false,
            code: "command_failed",
            error: "wrapper failed after editing",
            executorLogPath: input.executorLogPath,
            resultJsonPath: input.resultJsonPath
          };
        }),
        { agentWorkflowsDir }
      );

      expect(out.finalized).toBe(false);
      expect(expectRecoveryOk(out.recovery).outcome).toBe("recovered");
      const probe = db
        .prepare(
          `SELECT needs_manual_recovery AS needsManualRecovery
             FROM dispatch_release_recovery_probe WHERE id = 1`
        )
        .get() as { needsManualRecovery: number };
      expect(probe.needsManualRecovery).toBe(1);
      expect(
        getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
