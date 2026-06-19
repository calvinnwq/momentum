/**
 * RC-1 handoff / restart-context migration parity.
 *
 * Goal-first `handoff <goal-id>` is the legacy compatibility restart-context
 * surface; the workflow-first equivalent is `workflow handoff <run-id>`. Both
 * exist to hand a fresh operator or a resuming process a versioned point-in-time
 * snapshot — what the unit of work is, what state it is in, what to do next, and
 * what is in flight — so a goal-first operator can migrate to the workflow-first
 * command without losing a restart-context category, a refusal code, or the
 * success/failure text-routing contract.
 *
 * These are migration-parity proofs, not surface tests: each one runs *both*
 * commands and asserts the workflow-first surface drops nothing the goal-first
 * surface exposes. Because the two read different durable domains (goal
 * iteration/job rows vs workflow run/step/lease rows), the parity is
 * contract-equivalent (same observable categories / refusal contract / routing),
 * not byte-equivalent.
 *
 * Asymmetry note: like `logs` (and unlike `status`), both handoff surfaces
 * *require* an id at the CLI layer, so the refusal contract has two arms — a
 * missing-id refusal and an unknown-id refusal. The goal-first missing-id arm is
 * a usage error (exit 2) while the workflow-first one is a typed
 * `run_id_required` refusal (exit 1); both still refuse to stderr with a
 * non-zero exit and no silent success, so the refusal *contract* migrates even
 * though the exact code/exit differ.
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

function makeTempDir(prefix = "momentum-rc1-handoff-parity-"): string {
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
  const dir = makeTempDir("momentum-rc1-handoff-repo-");
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
  const specDir = makeTempDir("momentum-rc1-handoff-spec-");
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
 * Seed a workflow-first run mid-flight: one running step plus a held
 * `managed-step` lease, so the handoff snapshot has a non-terminal run state, an
 * in-flight step, a held lease to reconcile, and a `resume_running` next-action.
 */
function seedRunningWorkflowRun(db: MomentumDb, runId: string): void {
  const now = 1_700_000_100_000;
  const recent = now - 30_000;
  const future = now + 10 * 60 * 1000;
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        approval_boundary, needs_manual_recovery, started_at, created_at, updated_at)
       VALUES (?, 'running', 'agent-workflow', '{}', 'handoff read-back', '{}', '{}',
               'through-merge-cleanup', 0, ?, ?, ?)`
  ).run(runId, recent, now, now);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, started_at,
        created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'running', 1, 1, ?, ?, ?)`
  ).run(runId, recent, now, now);
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, 'managed-step', 'pipeline', ?, ?, ?, NULL, 'auto-release', ?, ?)`
  ).run(runId, recent, future, recent, now, now);
}

/**
 * Seed a workflow-first run flagged for manual recovery with a failed required
 * step, so the handoff snapshot surfaces a recovery signal to the resuming
 * operator.
 */
function seedRecoveryWorkflowRun(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
       VALUES (?, 'failed', 'agent-workflow', '{}', 'handoff recovery read-back',
               '{}', '{}', 1, 1, 1)`
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, error_code,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'failed', 1, 1,
               'executor_failed', 5, 6, 1, 1)`
  ).run(runId);
}

/**
 * Seed, in one data dir, both a goal-first goal and a mid-flight workflow-first
 * run so an operator could read either `handoff <goalId>` or
 * `workflow handoff <runId>`.
 */
function seedGoalAndWorkflow(): {
  dataDir: string;
  goalId: string;
  runId: string;
} {
  const dataDir = makeTempDir("momentum-rc1-handoff-data-");
  const goalId = seedGoal(dataDir, "RC-1 handoff parity target");

  const runId = "cwfp-handoffparity1";
  const db: MomentumDb = openDb(dataDir);
  try {
    seedRunningWorkflowRun(db, runId);
  } finally {
    db.close();
  }

  return { dataDir, goalId, runId };
}

describe("RC-1 handoff / restart-context migration parity", () => {
  it("workflow-first `handoff` exposes every restart-context category goal-first `handoff` does", async () => {
    const { dataDir, goalId, runId } = seedGoalAndWorkflow();

    const goal = await run(["handoff", goalId, "--data-dir", dataDir, "--json"]);
    expect(goal.code).toBe(0);
    const goalPayload = JSON.parse(goal.stdout) as {
      ok: boolean;
      command: string;
      goalId: string;
      state: string;
      goalState: string;
      schemaVersion: number;
      generatedAt: number;
      currentIterationDetail: { state: string } | null;
      nextAction: string | null;
      nextActionDetail: { kind: string } | null;
    };

    const wf = await run([
      "workflow",
      "handoff",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(0);
    const wfPayload = JSON.parse(wf.stdout) as {
      ok: boolean;
      command: string;
      schemaVersion: number;
      generatedAt: number;
      run: { runId: string; state: string };
      steps: Array<{ stepId: string; state: string }>;
      monitor: {
        runState: string;
        nextAction: { code: string };
      };
      nextAction: { code: string; detail: string };
    };

    // Both report success as a read-back command.
    expect(goalPayload.ok).toBe(true);
    expect(goalPayload.command).toBe("handoff");
    expect(wfPayload.ok).toBe(true);
    expect(wfPayload.command).toBe("workflow handoff");

    // Category 1 — "versioned restart snapshot": the defining handoff contract.
    // Both emit a numeric schema version and a generated-at timestamp so a fresh
    // process can interpret the snapshot it is resuming from.
    expect(typeof goalPayload.schemaVersion).toBe("number");
    expect(typeof goalPayload.generatedAt).toBe("number");
    expect(typeof wfPayload.schemaVersion).toBe("number");
    expect(typeof wfPayload.generatedAt).toBe("number");

    // Category 2 — "identity + lifecycle state": goal exposes its id and a
    // lifecycle state; the workflow-first run exposes its runId and a run state
    // (mirrored on the monitor).
    expect(goalPayload.goalId).toBe(goalId);
    expect(goalPayload.goalState.length).toBeGreaterThan(0);
    expect(wfPayload.run.runId).toBe(runId);
    expect(wfPayload.run.state).toBe("running");
    expect(wfPayload.monitor.runState).toBe("running");

    // Category 3 — "restart next-action guidance": goal exposes a human
    // next-action string plus a typed kind; the workflow-first run exposes a
    // typed next-action code with a non-empty detail (mirrored on the monitor).
    expect((goalPayload.nextAction ?? "").length).toBeGreaterThan(0);
    expect(goalPayload.nextActionDetail).not.toBeNull();
    expect((goalPayload.nextActionDetail?.kind ?? "").length).toBeGreaterThan(0);
    expect(wfPayload.nextAction.code.length).toBeGreaterThan(0);
    expect(wfPayload.nextAction.detail.length).toBeGreaterThan(0);
    expect(wfPayload.monitor.nextAction.code.length).toBeGreaterThan(0);

    // Category 4 — "in-flight execution unit to resume": goal exposes the
    // current iteration detail with a state; the workflow-first run exposes its
    // per-step records, including the active running step.
    expect(goalPayload.currentIterationDetail).not.toBeNull();
    expect(
      (goalPayload.currentIterationDetail?.state ?? "").length
    ).toBeGreaterThan(0);
    expect(wfPayload.steps.length).toBeGreaterThan(0);
    const activeStep = wfPayload.steps.find((s) => s.state === "running");
    expect(activeStep?.stepId).toBe("implementation");
  });

  it("both handoff surfaces expose the manual-recovery restart signal", async () => {
    const dataDir = makeTempDir("momentum-rc1-handoff-recovery-");
    const goalId = seedGoal(dataDir, "RC-1 handoff recovery parity target");

    const runId = "cwfp-handoffrecover1";
    const db: MomentumDb = openDb(dataDir);
    try {
      markGoalNeedsManualRecovery(db, {
        goalId,
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      seedRecoveryWorkflowRun(db, runId);
    } finally {
      db.close();
    }

    const goal = await run(["handoff", goalId, "--data-dir", dataDir, "--json"]);
    expect(goal.code).toBe(0);
    const goalPayload = JSON.parse(goal.stdout) as {
      nextActionDetail: { kind: string } | null;
    };
    // Goal-first surfaces the manual-recovery need through nextActionDetail.kind.
    expect(goalPayload.nextActionDetail?.kind).toBe("manual_recovery_required");

    const wf = await run([
      "workflow",
      "handoff",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(0);
    const wfPayload = JSON.parse(wf.stdout) as {
      run: { needsManualRecovery: boolean };
      monitor: { recovery: { code: string } | null };
    };
    // Workflow-first surfaces the same need through the durable run flag and a
    // typed monitor recovery code.
    expect(wfPayload.run.needsManualRecovery).toBe(true);
    expect(wfPayload.monitor.recovery).not.toBeNull();
    expect((wfPayload.monitor.recovery?.code ?? "").length).toBeGreaterThan(0);
  });

  it("both handoff surfaces refuse an unknown id with a typed code on stderr and a non-zero exit", async () => {
    const dataDir = makeTempDir();

    const goal = await run([
      "handoff",
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
      command: "handoff",
      code: "goal_not_found"
    });

    const wf = await run([
      "workflow",
      "handoff",
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
      command: "workflow handoff",
      code: "run_not_found"
    });
  });

  it("both handoff surfaces refuse a missing id on stderr with a non-zero exit (no silent success)", async () => {
    const dataDir = makeTempDir();

    const goal = await run(["handoff", "--data-dir", dataDir, "--json"]);
    expect(goal.code).not.toBe(0);
    expect(goal.stdout).toBe("");
    expect(goal.stderr.length).toBeGreaterThan(0);

    const wf = await run([
      "workflow",
      "handoff",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).not.toBe(0);
    expect(wf.stdout).toBe("");
    const wfErr = JSON.parse(wf.stderr) as Record<string, unknown>;
    expect(wfErr).toMatchObject({
      ok: false,
      command: "workflow handoff",
      code: "run_id_required"
    });
  });

  it("both handoff surfaces route successful text read-back to stdout", async () => {
    const { dataDir, goalId, runId } = seedGoalAndWorkflow();

    const goal = await run(["handoff", goalId, "--data-dir", dataDir]);
    expect(goal.code).toBe(0);
    expect(goal.stdout).toContain(`Handoff written for goal: ${goalId}`);
    expect(goal.stderr).toBe("");

    const wf = await run(["workflow", "handoff", runId, "--data-dir", dataDir]);
    expect(wf.code).toBe(0);
    expect(wf.stdout).toContain(`Workflow handoff: ${runId}`);
    expect(wf.stderr).toBe("");
  });
});
