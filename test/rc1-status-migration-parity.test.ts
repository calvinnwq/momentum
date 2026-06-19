/**
 * RC-1 status read-back migration parity.
 *
 * Goal-first `status <goal-id>` is the legacy compatibility read-back surface;
 * the workflow-first equivalent is `workflow status <run-id>` (the per-run
 * detail reader). Before goal-first read-back can ever be narrowed, an operator
 * must be able to migrate to the workflow-first command without losing a
 * read-back category, a refusal code, or the success/failure text-routing
 * contract.
 *
 * These are migration-parity proofs, not surface tests: each one runs *both*
 * commands and asserts the workflow-first surface drops nothing the goal-first
 * surface exposes. Because the two read different durable domains (goal
 * iteration/job rows vs workflow run/step rows), the parity is
 * contract-equivalent (same observable categories / refusal contract /
 * routing), not byte-equivalent.
 *
 * Asymmetry note: unlike `logs`, neither status surface *requires* an id — a
 * bare `status` reads back the latest goal and a bare `workflow status` lists
 * all runs — so the relevant refusal contract here is the unknown-id case, not
 * a missing-id usage error.
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
import { ingestEvidenceRecord } from "../src/core/evidence/records.js";

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

function makeTempDir(prefix = "momentum-rc1-status-parity-"): string {
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
  const dir = makeTempDir("momentum-rc1-status-repo-");
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
  const specDir = makeTempDir("momentum-rc1-status-spec-");
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
 * Seed a workflow-first run with one active (running) step so the monitor
 * surfaces an active unit, a non-terminal run state, and a next-action.
 */
function seedWorkflowRun(
  db: MomentumDb,
  input: {
    runId: string;
    runState: string;
    stepState: string;
    needsManualRecovery?: boolean;
    stepErrorCode?: string;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
       VALUES (?, ?, 'agent-workflow', '{}', 'status read-back', '{}', '{}', ?, 1, 1)`
  ).run(input.runId, input.runState, input.needsManualRecovery ? 1 : 0);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, error_code,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', ?, 1, 1, ?, 5, ?, 1, 1)`
  ).run(
    input.runId,
    input.stepState,
    input.stepErrorCode ?? null,
    input.stepState === "running" ? null : 6
  );
}

/**
 * Seed, in one data dir, both a goal-first goal and a workflow-first run so an
 * operator could read either `status <goalId>` or `workflow status <runId>`.
 */
function seedGoalAndWorkflow(): {
  dataDir: string;
  goalId: string;
  runId: string;
} {
  const dataDir = makeTempDir("momentum-rc1-status-data-");
  const goalId = seedGoal(dataDir, "RC-1 status parity target");

  const runId = "cwfp-statusparity1";
  const db: MomentumDb = openDb(dataDir);
  try {
    // Goal-first read-back: one evidence record linked to the goal.
    ingestEvidenceRecord(
      db,
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1700000010000,
        summary: "plan for goal status read-back",
        ingestKey: `goal:${goalId}:plan`,
        goalId
      },
      { now: () => 1700000010500 }
    );

    // Workflow-first read-back: an active run with a running step and one
    // run-scoped evidence record.
    seedWorkflowRun(db, {
      runId,
      runState: "running",
      stepState: "running"
    });
    ingestEvidenceRecord(
      db,
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1700000020000,
        summary: "plan for run status read-back",
        ingestKey: `run:${runId}:plan`,
        runId
      },
      { now: () => 1700000020500 }
    );
  } finally {
    db.close();
  }

  return { dataDir, goalId, runId };
}

describe("RC-1 status read-back migration parity", () => {
  it("workflow-first `status` exposes every read-back category goal-first `status` does", async () => {
    const { dataDir, goalId, runId } = seedGoalAndWorkflow();

    const goal = await run(["status", goalId, "--data-dir", dataDir, "--json"]);
    expect(goal.code).toBe(0);
    const goalPayload = JSON.parse(goal.stdout) as {
      ok: boolean;
      command: string;
      goalId: string;
      state: string;
      currentIterationDetail: { state: string } | null;
      nextAction: string | null;
      nextActionDetail: { kind: string } | null;
      latestEvidence?: Array<{ summary: string }>;
    };

    const wf = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(wf.code).toBe(0);
    const wfPayload = JSON.parse(wf.stdout) as {
      ok: boolean;
      command: string;
      run: { runId: string; state: string };
      monitor: {
        runState: string;
        activeStep: { stepId: string; state: string } | null;
        nextAction: { code: string };
      };
      evidence: Array<{ summary: string }>;
    };

    // Both report success as a read-back command.
    expect(goalPayload.ok).toBe(true);
    expect(goalPayload.command).toBe("status");
    expect(wfPayload.ok).toBe(true);
    expect(wfPayload.command).toBe("workflow status");

    // Category 1 — "identity + lifecycle state": goal exposes a goalId and a
    // run state; the workflow-first run exposes its runId and a run state
    // (mirrored on the monitor).
    expect(goalPayload.goalId).toBe(goalId);
    expect(goalPayload.state.length).toBeGreaterThan(0);
    expect(wfPayload.run.runId).toBe(runId);
    expect(wfPayload.run.state).toBe("running");
    expect(wfPayload.monitor.runState).toBe("running");

    // Category 2 — "current/active unit + its state": goal exposes the current
    // iteration detail with a state; the workflow-first run exposes its active
    // step with a state.
    expect(goalPayload.currentIterationDetail).not.toBeNull();
    expect(goalPayload.currentIterationDetail?.state.length).toBeGreaterThan(0);
    expect(wfPayload.monitor.activeStep?.stepId).toBe("implementation");
    expect(wfPayload.monitor.activeStep?.state).toBe("running");

    // Category 3 — "next-action guidance": goal exposes a human next-action
    // string plus a typed kind; the workflow-first run exposes a typed monitor
    // next-action code.
    expect((goalPayload.nextAction ?? "").length).toBeGreaterThan(0);
    expect(goalPayload.nextActionDetail).not.toBeNull();
    expect(wfPayload.monitor.nextAction.code.length).toBeGreaterThan(0);

    // Category 4 — "evidence trail": both surface their linked evidence records.
    expect((goalPayload.latestEvidence ?? []).length).toBeGreaterThan(0);
    expect(wfPayload.evidence.length).toBeGreaterThan(0);
  });

  it("both surfaces expose the manual-recovery signal in status read-back", async () => {
    const dataDir = makeTempDir("momentum-rc1-status-recovery-");
    const goalId = seedGoal(dataDir, "RC-1 status recovery parity target");

    const runId = "cwfp-statusrecover1";
    const db: MomentumDb = openDb(dataDir);
    try {
      markGoalNeedsManualRecovery(db, {
        goalId,
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
      // A workflow run flagged for manual recovery with a failed required step.
      seedWorkflowRun(db, {
        runId,
        runState: "failed",
        stepState: "failed",
        needsManualRecovery: true,
        stepErrorCode: "executor_failed"
      });
    } finally {
      db.close();
    }

    const goal = await run(["status", goalId, "--data-dir", dataDir, "--json"]);
    expect(goal.code).toBe(0);
    const goalPayload = JSON.parse(goal.stdout) as {
      nextActionDetail: { kind: string } | null;
    };
    // Goal-first surfaces the manual-recovery need through nextActionDetail.kind.
    expect(goalPayload.nextActionDetail?.kind).toBe("manual_recovery_required");

    const wf = await run([
      "workflow",
      "status",
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

  it("both surfaces refuse an unknown id with a typed code on stderr and a non-zero exit", async () => {
    const dataDir = makeTempDir();

    const goal = await run([
      "status",
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
      command: "status",
      code: "goal_not_found"
    });

    const wf = await run([
      "workflow",
      "status",
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
      command: "workflow status",
      code: "run_not_found"
    });
  });

  it("both surfaces route successful text read-back to stdout", async () => {
    const { dataDir, goalId, runId } = seedGoalAndWorkflow();

    const goal = await run(["status", goalId, "--data-dir", dataDir]);
    expect(goal.code).toBe(0);
    expect(goal.stdout.length).toBeGreaterThan(0);
    expect(goal.stderr).toBe("");

    const wf = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir
    ]);
    expect(wf.code).toBe(0);
    expect(wf.stdout).toContain(`Workflow run: ${runId}`);
    expect(wf.stderr).toBe("");
  });
});
