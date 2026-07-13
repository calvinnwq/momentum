import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "../src/adapters/db.js";
import { resolveDaemonWorkflowStepDispatch } from "../src/core/daemon/workflow-dispatch.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR } from "../src/core/workflow/live-wrapper/daemon-profile.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";

const NOW = 1_700_000_000_000;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-delegate-recovery-"),
  );
  tempDirs.push(value);
  return value;
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): string {
  const repoPath = tempDir();
  runGit(repoPath, ["init", "--quiet"]);
  runGit(repoPath, ["config", "user.name", "Momentum Test"]);
  runGit(repoPath, ["config", "user.email", "momentum@example.test"]);
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".agent-workflows/\n");
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  runGit(repoPath, ["add", ".gitignore", "README.md"]);
  runGit(repoPath, ["commit", "--quiet", "-m", "test: initialize fixture"]);
  return repoPath;
}

function writeProfile(profileDir: string): string {
  const profilePath = path.join(profileDir, "profile.json");
  const script = `count_file="$MOMENTUM_REPO_PATH/.agent-workflows/$MOMENTUM_RUN_ID/gnhf-launch-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" > "$count_file"
printf '%s\n' "$MOMENTUM_STEP_ID" > "$MOMENTUM_REPO_PATH/$MOMENTUM_STEP_ID.txt"
cat > "$MOMENTUM_RESULT_PATH" <<JSON
{"success":true,"summary":"$MOMENTUM_STEP_ID completed","key_changes_made":[],"key_learnings":[],"remaining_work":[],"goal_complete":false,"commit":{"type":"test","subject":"complete $MOMENTUM_STEP_ID","body":"","breaking":false}}
JSON`;
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "delegate-recovery-test",
      wrappers: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", script],
          cwd: "iteration",
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return profilePath;
}

function definition(stepKeys: string[]): WorkflowDefinition {
  return {
    key: "delegate-recovery",
    title: "Delegate Recovery",
    version: 1,
    steps: stepKeys.map((key, order) => ({
      key,
      kind: "implementation",
      executor: "delegate-supervisor",
      config: { tool: "gnhf" },
      order,
      required: true,
    })),
  };
}

function prepareRun(input: {
  dataDir: string;
  repoPath: string;
  runId: string;
  stepKeys: string[];
}) {
  const db = openDb(input.dataDir);
  const workflow = definition(input.stepKeys);
  persistWorkflowDefinition(db, workflow, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: workflow,
    runId: input.runId,
    repoPath: input.repoPath,
    objective: "Prove delegated handoff recovery",
    now: NOW,
  });
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
  ).run(input.runId);
  return db;
}

function claimStep(
  db: ReturnType<typeof openDb>,
  runId: string,
  stepId: string,
  now: number,
) {
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
    holder: "delegate-test-worker",
    leaseExpiresAt: now + 30_000,
    now,
  });
  if (!claim.ok) throw new Error(claim.reason);
  return claim.claim;
}

function reopenInterruptedHandoff(
  db: ReturnType<typeof openDb>,
  runId: string,
  stepId: string,
): void {
  const round = db
    .prepare(
      "SELECT round_id FROM executor_rounds WHERE workflow_run_id = ? AND attempt = 1",
    )
    .get(runId) as { round_id: string };
  db.prepare(
    "DELETE FROM executor_checkpoints WHERE round_id = ? AND stage <> 'delegate_handoff_intent'",
  ).run(round.round_id);
  db.prepare(
    `UPDATE executor_invocations
        SET state = 'running', attempt = 2, finished_at = NULL
      WHERE workflow_run_id = ?`,
  ).run(runId);
  db.prepare(
    `UPDATE workflow_steps
        SET state = 'approved', finished_at = NULL
      WHERE run_id = ? AND step_id = ?`,
  ).run(runId, stepId);
  db.prepare(
    `UPDATE workflow_runs
        SET state = 'approved', finished_at = NULL
      WHERE id = ?`,
  ).run(runId);
}

describe("profile-backed delegate handoff artifacts", () => {
  it("namespaces attempt-one artifacts by step", async () => {
    const dataDir = tempDir();
    const repoPath = initRepo();
    const runId = "delegate-artifact-scope";
    const profilePath = writeProfile(tempDir());
    const db = prepareRun({
      dataDir,
      repoPath,
      runId,
      stepKeys: ["implementation-a", "implementation-b"],
    });
    const resolved = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!resolved.ok) throw new Error(resolved.message);

    await resolved.dispatch(claimStep(db, runId, "implementation-a", NOW), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 1,
    });
    await resolved.dispatch(claimStep(db, runId, "implementation-b", NOW + 2), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 3,
    });

    const artifactRoot = path.join(repoPath, ".agent-workflows", runId);
    for (const stepId of ["implementation-a", "implementation-b"]) {
      const stepRoot = path.join(artifactRoot, "delegate", stepId);
      expect(fs.existsSync(path.join(stepRoot, "executor.log"))).toBe(true);
      expect(fs.existsSync(path.join(stepRoot, "result.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(stepRoot, "delegate-external-state.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(stepRoot, "delegate-handoff.json"))).toBe(
        true,
      );
    }
    expect(fs.existsSync(path.join(artifactRoot, "executor.log"))).toBe(false);
    expect(
      fs.existsSync(path.join(artifactRoot, "delegate-external-state.json")),
    ).toBe(false);
    db.close();
  });

  it("recovers a committed handoff from its finalization receipt", async () => {
    const dataDir = tempDir();
    const repoPath = initRepo();
    const runId = "delegate-commit-recovery";
    const stepId = "implementation";
    const profilePath = writeProfile(tempDir());
    const db = prepareRun({
      dataDir,
      repoPath,
      runId,
      stepKeys: [stepId],
    });
    const resolved = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!resolved.ok) throw new Error(resolved.message);
    const receiptPath = path.join(
      repoPath,
      ".agent-workflows",
      runId,
      "delegate",
      stepId,
      "delegate-handoff.json",
    );
    await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 1,
    });

    expect(runGit(repoPath, ["log", "-1", "--format=%s"])).toBe(
      "test: complete implementation",
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({
      phase: "finalized",
      invocationId: `${runId}::${stepId}::dispatch`,
    });
    delete receipt["externalState"];
    receipt["phase"] = "finalizing";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    fs.rmSync(
      path.join(path.dirname(receiptPath), "delegate-external-state.json"),
    );
    reopenInterruptedHandoff(db, runId, stepId);

    await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 3,
    });

    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ state: "succeeded", attempt: 2 });
    expect(
      fs.readFileSync(
        path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
        "utf8",
      ),
    ).toBe("1\n");
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({
      phase: "finalized",
      externalState: { stepStatus: "completed" },
    });
    db.close();
  });

  it("migrates a correlated legacy run-root state artifact", async () => {
    const dataDir = tempDir();
    const repoPath = initRepo();
    const runId = "delegate-legacy-migration";
    const stepId = "implementation";
    const profilePath = writeProfile(tempDir());
    const db = prepareRun({
      dataDir,
      repoPath,
      runId,
      stepKeys: [stepId],
    });
    const resolved = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!resolved.ok) throw new Error(resolved.message);
    await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 1,
    });

    const runRoot = path.join(repoPath, ".agent-workflows", runId);
    const scopedRoot = path.join(runRoot, "delegate", stepId);
    fs.copyFileSync(
      path.join(scopedRoot, "delegate-external-state.json"),
      path.join(runRoot, "delegate-external-state.json"),
    );
    fs.copyFileSync(
      path.join(scopedRoot, "result.json"),
      path.join(runRoot, "result.json"),
    );
    fs.copyFileSync(
      path.join(scopedRoot, "executor.log"),
      path.join(runRoot, "executor.log"),
    );
    fs.rmSync(path.join(runRoot, "delegate"), {
      recursive: true,
      force: true,
    });
    reopenInterruptedHandoff(db, runId, stepId);

    await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 3,
    });

    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ state: "succeeded", attempt: 2 });
    expect(
      fs.readFileSync(path.join(runRoot, "gnhf-launch-count"), "utf8"),
    ).toBe("1\n");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(scopedRoot, "delegate-handoff.json"), "utf8"),
      ),
    ).toMatchObject({
      phase: "finalized",
      externalState: { externalRunId: `${runId}::${stepId}::dispatch` },
    });
    db.close();
  });

  it("preserves worktree changes that do not match a finalization receipt", async () => {
    const dataDir = tempDir();
    const repoPath = initRepo();
    const runId = "delegate-worktree-mismatch";
    const stepId = "implementation";
    const profilePath = writeProfile(tempDir());
    const db = prepareRun({
      dataDir,
      repoPath,
      runId,
      stepKeys: [stepId],
    });
    const resolved = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!resolved.ok) throw new Error(resolved.message);
    await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 1,
    });

    const stepRoot = path.join(
      repoPath,
      ".agent-workflows",
      runId,
      "delegate",
      stepId,
    );
    const receiptPath = path.join(stepRoot, "delegate-handoff.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    const baseHead = String(receipt["baseHead"]);
    runGit(repoPath, ["reset", "--hard", baseHead]);
    delete receipt["externalState"];
    receipt["phase"] = "finalizing";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
    const unrelatedPath = path.join(repoPath, "unrelated.txt");
    fs.writeFileSync(unrelatedPath, "preserve me\n");
    reopenInterruptedHandoff(db, runId, stepId);

    await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 3,
    });

    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ state: "manual_recovery_required", attempt: 2 });
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("preserve me\n");
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(
      fs.readFileSync(
        path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
        "utf8",
      ),
    ).toBe("1\n");
    db.close();
  });

  it("refuses to finalize from a launch-only receipt", async () => {
    const dataDir = tempDir();
    const repoPath = initRepo();
    const runId = "delegate-launch-only-recovery";
    const stepId = "implementation";
    const profilePath = writeProfile(tempDir());
    const db = prepareRun({
      dataDir,
      repoPath,
      runId,
      stepKeys: [stepId],
    });
    const resolved = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!resolved.ok) throw new Error(resolved.message);
    await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 1,
    });

    const stepRoot = path.join(
      repoPath,
      ".agent-workflows",
      runId,
      "delegate",
      stepId,
    );
    const receiptPath = path.join(stepRoot, "delegate-handoff.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const key of [
      "dispatchOutcome",
      "expectedMessage",
      "expectedTree",
      "externalState",
      "resultDigest",
    ]) {
      delete receipt[key];
    }
    receipt["phase"] = "launched";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
    reopenInterruptedHandoff(db, runId, stepId);

    await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
      db,
      workerId: "delegate-test-worker",
      now: NOW + 3,
    });

    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ state: "manual_recovery_required", attempt: 2 });
    expect(
      db
        .prepare(
          "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
        )
        .get(runId),
    ).toEqual({ recovery_code: "delegate_handoff_failed" });
    expect(
      fs.readFileSync(
        path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
        "utf8",
      ),
    ).toBe("1\n");
    db.close();
  });
});
