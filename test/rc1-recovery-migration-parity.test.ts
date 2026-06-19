/**
 * RC-1 recovery-clear / recovery-status migration parity.
 *
 * Goal-first `recovery clear <goal-id>` is the legacy compatibility recovery
 * mutation; the workflow-first equivalent is `workflow run clear-recovery
 * <run-id>`. The recovery *status* read-back — "is this unit still flagged for
 * manual recovery?" — is observable goal-first through `status <goal-id>`
 * (`nextActionDetail.kind === "manual_recovery_required"`) and workflow-first
 * through `workflow status <run-id>` (`run.needsManualRecovery` +
 * `monitor.recovery`). Together these are the fourth and final RC-1
 * read-back/recovery flow.
 *
 * This is the one RC-1 flow that is a *mutation*, not a pure read-back, so its
 * distinctive parity category is the GUARDED clear: both surfaces refuse to
 * clear while a blocking condition persists and leave the durable flag set, so
 * an operator cannot silently unblock an unsafe goal/run.
 *
 * These are migration-parity proofs, not surface tests: each one runs *both*
 * commands and asserts the workflow-first surface drops nothing the goal-first
 * surface exposes. Because the two mutate/read different durable domains (goal
 * rows + jobs vs workflow run/step rows), the parity is contract-equivalent
 * (same observable categories / refusal contract / routing), not byte-equivalent.
 *
 * Asymmetry notes:
 * - Like `logs` / `handoff`, both clear surfaces *require* an id, so the refusal
 *   contract has a missing-id arm. The goal-first missing-id arm is a usage
 *   error (exit 2) while the workflow-first one is a typed `run_id_required`
 *   refusal (exit 1); both still refuse to stderr with a non-zero exit and no
 *   silent success.
 * - The guarded-refusal blocker differs by domain: goal-first refuses with
 *   `job_active` (an in-flight job still holds the goal) while workflow-first
 *   refuses with `recovery_clear_refused` (a blocking recovery condition such as
 *   a failed required step persists). Both refuse-and-preserve the durable flag,
 *   so the guarded-clear *contract* migrates even though the concrete blocker and
 *   code differ.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { initGoal } from "../src/core/goal/init.js";
import { markGoalNeedsManualRecovery } from "../src/core/goal/recovery.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-rc1-recovery-parity-"): string {
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

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-rc1-recovery-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function seedGoal(dataDir: string, title: string): string {
  const repo = initRepo();
  const specDir = makeTempDir("momentum-rc1-recovery-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    `---
title: ${title}
repo: ${repo}
runner: fake
verification:
  - true
---
Apply the fixture file deterministically.
`,
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode: "queued"
  });
  if (!init.ok) throw new Error(`initGoal failed: ${init.error}`);
  return init.goalId;
}

/**
 * Drive the goal's pending iteration job to a claimed (active) state so the
 * guarded clear sees an in-flight worker and must refuse with `job_active`,
 * mirroring how a daemon-claimed job blocks a goal-first recovery clear.
 */
function activatePendingGoalJob(db: MomentumDb, goalId: string): void {
  const info = db
    .prepare(
      `UPDATE jobs SET state = 'claimed', worker_id = 'worker-x' WHERE goal_id = ?`
    )
    .run(goalId);
  if (info.changes < 1) {
    throw new Error("expected a pending goal iteration job to activate");
  }
}

/**
 * Seed a workflow-first run flagged for manual recovery whose blocking step has
 * since been re-driven to a healthy terminal state, so the guarded clear has no
 * blocking recovery code remaining and succeeds.
 */
function seedClearableRecoveryRun(
  db: MomentumDb,
  runId: string,
  reason: string
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        created_at, updated_at)
       VALUES (?, 'running', 'agent-workflow', '{}', 'recovery read-back',
               '{}', '{}', 1, ?, ?, ?, ?)`
  ).run(runId, reason, now, now, now);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'succeeded', 1, 1,
               ?, ?, ?, ?)`
  ).run(runId, now, now, now, now);
}

/**
 * Seed a workflow-first run flagged for manual recovery with a still-failed
 * required step, so the guarded clear classifies a blocking recovery condition
 * and refuses with `recovery_clear_refused`.
 */
function seedBlockedRecoveryRun(
  db: MomentumDb,
  runId: string,
  reason: string
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        created_at, updated_at)
       VALUES (?, 'failed', 'agent-workflow', '{}', 'recovery read-back',
               '{}', '{}', 1, ?, 1, 1, 1)`
  ).run(runId, reason);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, error_code,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, 'no-mistakes', 'no-mistakes', 'failed', 1, 1,
               'executor_failed', 5, 6, 1, 1)`
  ).run(runId);
}

/** Seed a workflow-first run that exists but is not flagged for recovery. */
function seedUnflaggedRun(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
       VALUES (?, 'running', 'agent-workflow', '{}', 'recovery read-back',
               '{}', '{}', 0, 1, 1)`
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        started_at, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'running', 1, 1, 1, 1, 1)`
  ).run(runId);
}

describe("RC-1 recovery-clear / recovery-status migration parity", () => {
  it("both clear surfaces expose the same successful-clear categories and clear the recovery-status read-back", async () => {
    const dataDir = makeTempDir("momentum-rc1-recovery-clear-");
    const goalId = seedGoal(dataDir, "RC-1 recovery clear parity target");
    const goalReason = "repo_dirty";
    const runId = "cwfp-recoveryclear1";
    const runReason = "ghost active step recovered by operator";

    const db: MomentumDb = openDb(dataDir);
    try {
      markGoalNeedsManualRecovery(db, {
        goalId,
        reason: goalReason,
        now: 1_700_000_000_000
      });
      seedClearableRecoveryRun(db, runId, runReason);
    } finally {
      db.close();
    }

    // --- recovery STATUS read-back BEFORE clear: both report the need ---
    const goalStatusBefore = await run([
      "status",
      goalId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goalStatusBefore.code).toBe(0);
    const goalStatusBeforePayload = JSON.parse(goalStatusBefore.stdout) as {
      nextActionDetail: { kind: string } | null;
    };
    expect(goalStatusBeforePayload.nextActionDetail?.kind).toBe(
      "manual_recovery_required"
    );

    const wfStatusBefore = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wfStatusBefore.code).toBe(0);
    const wfStatusBeforePayload = JSON.parse(wfStatusBefore.stdout) as {
      run: { needsManualRecovery: boolean };
    };
    expect(wfStatusBeforePayload.run.needsManualRecovery).toBe(true);

    // --- the CLEAR mutation: same observable success categories on both ---
    const goalClear = await run([
      "recovery",
      "clear",
      goalId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goalClear.code).toBe(0);
    const goalClearPayload = JSON.parse(goalClear.stdout) as {
      ok: boolean;
      command: string;
      goalId: string;
      previousReason: string | null;
      clearedAt: number;
    };
    expect(goalClearPayload.ok).toBe(true);
    expect(goalClearPayload.command).toBe("recovery clear");
    expect(goalClearPayload.goalId).toBe(goalId);
    // Category 1 — "previous reason": the surface reports what the unit was
    // flagged for so the operator has an audit trail of the cleared condition.
    expect(goalClearPayload.previousReason).toBe(goalReason);
    // Category 2 — "cleared-at timestamp": a point-in-time stamp of the clear.
    expect(typeof goalClearPayload.clearedAt).toBe("number");

    const wfClear = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wfClear.code).toBe(0);
    const wfClearPayload = JSON.parse(wfClear.stdout) as {
      ok: boolean;
      command: string;
      runId: string;
      previousReason: string | null;
      clearedAt: number;
    };
    expect(wfClearPayload.ok).toBe(true);
    expect(wfClearPayload.command).toBe("workflow run clear-recovery");
    expect(wfClearPayload.runId).toBe(runId);
    expect(wfClearPayload.previousReason).toBe(runReason);
    expect(typeof wfClearPayload.clearedAt).toBe("number");

    // --- recovery STATUS read-back AFTER clear: neither reports the need ---
    // Category 3 — "durable flag cleared": the recovery-status read-back that
    // surfaced the need before the clear no longer surfaces it after.
    const goalStatusAfter = await run([
      "status",
      goalId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goalStatusAfter.code).toBe(0);
    const goalStatusAfterPayload = JSON.parse(goalStatusAfter.stdout) as {
      nextActionDetail: { kind: string } | null;
    };
    expect(goalStatusAfterPayload.nextActionDetail?.kind).not.toBe(
      "manual_recovery_required"
    );

    const wfStatusAfter = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wfStatusAfter.code).toBe(0);
    const wfStatusAfterPayload = JSON.parse(wfStatusAfter.stdout) as {
      run: { needsManualRecovery: boolean };
      monitor: { recovery: { code: string } | null };
    };
    expect(wfStatusAfterPayload.run.needsManualRecovery).toBe(false);
    expect(wfStatusAfterPayload.monitor.recovery).toBeNull();
  });

  it("both clear surfaces refuse to clear while a blocking condition persists and preserve the durable flag", async () => {
    const dataDir = makeTempDir("momentum-rc1-recovery-guarded-");
    const goalId = seedGoal(dataDir, "RC-1 recovery guarded parity target");
    const runId = "cwfp-recoveryblocked1";

    const db: MomentumDb = openDb(dataDir);
    try {
      // Goal-first blocker: an in-flight (claimed) iteration job still holds
      // the goal, so the guarded clear must refuse.
      activatePendingGoalJob(db, goalId);
      markGoalNeedsManualRecovery(db, {
        goalId,
        reason: "job_running",
        now: 1_700_000_000_000
      });
      // Workflow-first blocker: a still-failed required step keeps a blocking
      // recovery condition, so the guarded clear must refuse.
      seedBlockedRecoveryRun(db, runId, "required step failed");
    } finally {
      db.close();
    }

    const goal = await run([
      "recovery",
      "clear",
      goalId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goal.code).toBe(1);
    expect(goal.stdout).toBe("");
    const goalErr = JSON.parse(goal.stderr) as Record<string, unknown>;
    expect(goalErr).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "job_active",
      goalId
    });

    const wf = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(1);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "recovery_clear_refused",
      runId
    });

    // Both leave the durable manual-recovery flag set so transitions stay
    // blocked: the recovery-status read-back still reports the need.
    const verify: MomentumDb = openDb(dataDir);
    try {
      const goalRow = verify
        .prepare(`SELECT needs_manual_recovery FROM goals WHERE id = ?`)
        .get(goalId) as { needs_manual_recovery: number };
      expect(goalRow.needs_manual_recovery).toBe(1);
      const runRow = verify
        .prepare(`SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?`)
        .get(runId) as { needs_manual_recovery: number };
      expect(runRow.needs_manual_recovery).toBe(1);
    } finally {
      verify.close();
    }
  });

  it("both clear surfaces refuse an unknown id with a typed code on stderr and a non-zero exit", async () => {
    const dataDir = makeTempDir();

    const goal = await run([
      "recovery",
      "clear",
      "missing-goal",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goal.code).toBe(1);
    expect(goal.stdout).toBe("");
    const goalErr = JSON.parse(goal.stderr) as Record<string, unknown>;
    expect(goalErr).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "goal_not_found"
    });

    const wf = await run([
      "workflow",
      "run",
      "clear-recovery",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(1);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "run_not_found"
    });
  });

  it("both clear surfaces refuse a not-flagged id with a typed code on stderr", async () => {
    const dataDir = makeTempDir("momentum-rc1-recovery-notflagged-");
    const goalId = seedGoal(dataDir, "RC-1 recovery not-flagged parity target");
    const runId = "cwfp-recoverynotflagged1";

    const db: MomentumDb = openDb(dataDir);
    try {
      seedUnflaggedRun(db, runId);
    } finally {
      db.close();
    }

    // The goal exists (just initialized) but was never flagged for recovery.
    const goal = await run([
      "recovery",
      "clear",
      goalId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(goal.code).toBe(1);
    expect(goal.stdout).toBe("");
    const goalErr = JSON.parse(goal.stderr) as Record<string, unknown>;
    expect(goalErr).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "not_flagged",
      goalId
    });

    const wf = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(1);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "not_flagged",
      runId
    });
  });

  it("both clear surfaces refuse a missing id on stderr with a non-zero exit (no silent success)", async () => {
    const dataDir = makeTempDir();

    const goal = await run(["recovery", "clear", "--data-dir", dataDir, "--json"]);
    expect(goal.code).not.toBe(0);
    expect(goal.stdout).toBe("");
    expect(goal.stderr.length).toBeGreaterThan(0);

    const wf = await run([
      "workflow",
      "run",
      "clear-recovery",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).not.toBe(0);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "run_id_required"
    });
  });

  it("both clear surfaces route successful text read-back to stdout", async () => {
    const dataDir = makeTempDir("momentum-rc1-recovery-text-");
    const goalId = seedGoal(dataDir, "RC-1 recovery text parity target");
    const runId = "cwfp-recoverytext1";

    const db: MomentumDb = openDb(dataDir);
    try {
      markGoalNeedsManualRecovery(db, {
        goalId,
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      seedClearableRecoveryRun(
        db,
        runId,
        "operator resolved the blocking lease"
      );
    } finally {
      db.close();
    }

    const goal = await run(["recovery", "clear", goalId, "--data-dir", dataDir]);
    expect(goal.code).toBe(0);
    expect(goal.stdout).toContain(`Manual recovery cleared for goal: ${goalId}`);
    expect(goal.stderr).toBe("");

    const wf = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(wf.code).toBe(0);
    expect(wf.stdout).toContain(`Manual recovery cleared for run: ${runId}`);
    expect(wf.stderr).toBe("");
  });
});
