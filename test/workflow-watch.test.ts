import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import {
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_V1,
} from "../src/core/workflow/definition/definition.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { insertWorkflowGate } from "../src/core/workflow/gate/persist.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

const SEED_NOW = 1_730_000_000_000;
const FRESH_EXPIRY = 9_999_999_999_999;

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-watch-"),
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(repoPath: string): void {
  runGit(repoPath, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "init\n", "utf-8");
  fs.writeFileSync(
    path.join(repoPath, ".gitignore"),
    ".agent-workflows/\n",
    "utf-8",
  );
  runGit(repoPath, ["add", "README.md", ".gitignore"]);
  runGit(repoPath, ["commit", "-m", "init", "--quiet"]);
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
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
    env,
  });
  return { code, stdout, stderr };
}

const VALID_WRAPPER_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "watch live-wrapper step succeeded",
  key_changes_made: ["ran the configured wrapper"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "chore",
    subject: "run watch wrapper",
    body: "",
    breaking: false,
  },
});

const WRITE_VALID_WRAPPER_RESULT = `printf 'watch wrapper ran\\n' > "$MOMENTUM_REPO_PATH/watch-wrapper.txt" && printf '%s' '${VALID_WRAPPER_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

function writeLiveWrapperProfile(root: string, stepKind: string): string {
  const profilePath = path.join(root, "watch-live-wrapper-profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "watch-live-wrapper",
      wrappers: {
        [stepKind]: {
          command: "/bin/sh",
          args: ["-c", WRITE_VALID_WRAPPER_RESULT],
          cwd: "iteration",
          timeout_sec: 30,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return profilePath;
}

function seedRun(
  db: MomentumDb,
  input: {
    runId: string;
    state: string;
    source?: string;
    needsManualRecovery?: boolean;
    manualRecoveryReason?: string | null;
  },
): void {
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
    input.source ?? MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    null,
    "{}",
    null,
    null,
    "{}",
    "{}",
    null,
    null,
    input.needsManualRecovery ? 1 : 0,
    input.manualRecoveryReason ?? null,
    input.needsManualRecovery ? SEED_NOW : null,
    null,
    null,
    SEED_NOW,
    SEED_NOW,
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
    SEED_NOW,
    SEED_NOW,
  );
}

function seedLease(
  db: MomentumDb,
  input: { runId: string; leaseKind: string; expiresAt: number },
): void {
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.leaseKind,
    `holder:${input.runId}`,
    1_000,
    input.expiresAt,
    1_000,
    null,
    "auto-release",
    SEED_NOW,
    SEED_NOW,
  );
}

describe("momentum workflow run watch", () => {
  it("returns a agent-once JSON supervisor envelope for a running native workflow", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-running";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      command: string;
      runId: string;
      emit: boolean;
      reason: string;
      disposition: string;
      phase: string;
      activeStep: { stepId: string; state: string } | null;
      nextAction: { code: string; stepId?: string | null };
      humanAction: unknown;
      recommendedAction: string;
      nextPollSeconds: number;
      quietForSeconds: number;
      stuckRisk: string;
      cleanup: string;
      digest: string;
    };
    expect(payload).toMatchObject({
      command: "workflow run watch",
      runId,
      emit: true,
      reason: "in_progress",
      disposition: "wait",
      phase: "advancing",
      activeStep: { stepId: "implementation", state: "running" },
      nextAction: { code: "resume_running", stepId: "implementation" },
      humanAction: null,
      recommendedAction: "poll",
      nextPollSeconds: 15,
      quietForSeconds: 0,
      stuckRisk: "low",
      cleanup: "none",
    });
    expect(payload.digest.startsWith("sha256:")).toBe(true);
  });

  it("keeps healthy external-tail progress pollable instead of human-required", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-merge-cleanup-progress";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "running",
        order: 4,
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      recommendedAction: string;
      recommendedActionPolicy: {
        action: string;
        authority: string;
        risk: string;
      };
    };
    expect(payload).toMatchObject({
      recommendedAction: "poll",
      recommendedActionPolicy: {
        action: "watch_recheck",
        authority: "auto_allowed",
        risk: "low",
      },
    });
  });

  it("returns a pollable idle supervisor envelope when no step is active yet", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-idle";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      emit: boolean;
      reason: string;
      disposition: string;
      phase: string;
      activeStep: unknown;
      nextAction: { code: string; stepId?: string | null };
      humanAction: unknown;
      recommendedAction: string;
      nextPollSeconds: number;
      quietForSeconds: number;
      stuckRisk: string;
      cleanup: string;
      digest: string;
    };
    expect(payload).toMatchObject({
      emit: true,
      reason: "idle",
      disposition: "wait",
      phase: "idle",
      activeStep: null,
      nextAction: { code: "await_approval", stepId: null },
      humanAction: null,
      recommendedAction: "poll",
      nextPollSeconds: 15,
      quietForSeconds: 0,
      stuckRisk: "medium",
      cleanup: "none",
    });
    expect(payload.digest.startsWith("sha256:")).toBe(true);
  });

  it("persists the digest baseline and suppresses an unchanged repeat watch tick", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-repeat-unchanged";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY,
      });
    } finally {
      db.close();
    }

    const args = [
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ];

    const first = await run(args);
    const second = await run(args);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      emit: boolean;
      quietForSeconds: number;
      digest: string;
    };
    const secondPayload = JSON.parse(second.stdout) as {
      emit: boolean;
      quietForSeconds: number;
      digest: string;
    };
    expect(firstPayload).toMatchObject({
      emit: true,
      quietForSeconds: 0,
    });
    expect(secondPayload).toMatchObject({
      emit: false,
      quietForSeconds: 0,
    });
    expect(secondPayload.digest).toBe(firstPayload.digest);

    const after = openDb(dataDir);
    try {
      const baseline = after
        .prepare(
          `SELECT monitor_last_seen_digest AS lastSeen,
                  monitor_last_emitted_digest AS lastEmitted
             FROM workflow_runs
            WHERE id = ?`,
        )
        .get(runId) as { lastSeen: string | null; lastEmitted: string | null };
      expect(baseline).toEqual({
        lastSeen: firstPayload.digest,
        lastEmitted: firstPayload.digest,
      });
    } finally {
      after.close();
    }
  });

  it("dispatches at most one approved step before returning the supervisor envelope", async () => {
    const dataDir = makeTempDir();
    const repoPath = path.join(dataDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    initRepo(repoPath);
    const profilePath = writeLiveWrapperProfile(dataDir, "implementation");
    const runId = "mwf-watch-dispatch-approved";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION_V1,
        runId,
        repoPath,
        objective: "Exercise one watch dispatcher tick",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 1",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run(
      [
        "workflow",
        "run",
        "watch",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json",
      ],
      { MOMENTUM_LIVE_WRAPPER_PROFILE: profilePath },
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      emit: boolean;
      phase: string;
      activeStep: { stepId: string; state: string } | null;
      nextAction: { code: string; stepId?: string | null };
      humanAction: unknown;
      recommendedAction: string;
      cleanup: string;
    };
    expect(payload).toMatchObject({
      emit: true,
      phase: "advancing",
      activeStep: { stepId: "implementation", state: "running" },
      nextAction: { code: "resume_running", stepId: "implementation" },
      humanAction: null,
      recommendedAction: "poll",
      cleanup: "none",
    });

    const after = openDb(dataDir);
    try {
      const steps = after
        .prepare(
          "SELECT step_id AS stepId, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order",
        )
        .all(runId) as Array<{ stepId: string; state: string }>;
      expect(steps).toEqual([
        { stepId: "preflight", state: "succeeded" },
        { stepId: "implementation", state: "running" },
        { stepId: "postflight", state: "pending" },
        { stepId: "no-mistakes", state: "pending" },
        { stepId: "merge-cleanup", state: "pending" },
        { stepId: "linear-refresh", state: "pending" },
      ]);
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(1);
    } finally {
      after.close();
    }
  });

  it("refuses to start preflight from watch without live-wrapper terminal evidence", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-preflight-profile-required";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise watch preflight profile guard",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'preflight'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    const failure = JSON.parse(result.stderr) as {
      code: string;
      message: string;
    };
    expect(failure).toMatchObject({
      code: "daemon_live_wrapper_profile_required",
    });
    expect(failure.message).toContain("MOMENTUM_LIVE_WRAPPER_PROFILE");
    expect(failure.message).toContain("preflight");

    const after = openDb(dataDir);
    try {
      const step = after
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'preflight'",
        )
        .get(runId) as { state: string };
      expect(step.state).toBe("approved");
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(0);
      const leaseCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
        )
        .get(runId) as { count: number };
      expect(leaseCount.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("refuses to start delegate-supervisor steps without a live-wrapper profile", async () => {
    for (const target of [
      { stepId: "implementation", order: 1 },
      { stepId: "validate", order: 3 },
    ]) {
      const dataDir = makeTempDir();
      const runId = `mwf-watch-${target.stepId}-profile-required`;
      const db = openDb(dataDir);
      try {
        persistWorkflowRunStart(db, {
          definition: CODING_WORKFLOW_DEFINITION,
          runId,
          repoPath: "/repos/momentum",
          objective: `Exercise ${target.stepId} profile guard`,
          now: SEED_NOW,
          source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
        });
        db.prepare(
          "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < ?",
        ).run(runId, target.order);
        db.prepare(
          "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
        ).run(runId, target.stepId);
      } finally {
        db.close();
      }

      const result = await run([
        "workflow",
        "run",
        "watch",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json",
      ]);

      expect(result.code).toBe(1);
      const failure = JSON.parse(result.stderr) as {
        code: string;
        message: string;
      };
      expect(failure).toMatchObject({
        code: "daemon_live_wrapper_profile_required",
      });
      expect(failure.message).toContain(target.stepId);

      const after = openDb(dataDir);
      try {
        const step = after
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, target.stepId) as { state: string };
        expect(step.state).toBe("approved");
        const attemptCount = after
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
          )
          .get(runId) as { count: number };
        expect(attemptCount.count).toBe(0);
        const leaseCount = after
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
          )
          .get(runId) as { count: number };
        expect(leaseCount.count).toBe(0);
      } finally {
        after.close();
      }
    }
  });

  it("validates the implementation route before requiring a live-wrapper profile", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-invalid-route-precedence";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise watch route validation precedence",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
        route: { implementationEngine: "current-gnhf-cwfp" },
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 1",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const after = openDb(dataDir);
    try {
      const gate = after
        .prepare(
          `SELECT evidence, reason
             FROM workflow_gates
            WHERE workflow_run_id = ? AND resolved_at IS NULL`,
        )
        .get(runId) as { evidence: string; reason: string };
      expect(gate.evidence).toBe("route_config_invalid");
      expect(gate.reason).toContain("current-gnhf-cwfp");
      const recovery = after
        .prepare(
          `SELECT needs_manual_recovery AS needsManualRecovery
             FROM workflow_runs
            WHERE id = ?`,
        )
        .get(runId) as { needsManualRecovery: number };
      expect(recovery.needsManualRecovery).toBe(1);
    } finally {
      after.close();
    }
  });

  it("does not start an approved merge-cleanup tail step from a watch tick", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-merge-cleanup-approved";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise watch tail-step dispatch guard",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
        approvalBoundary: "through-merge-cleanup",
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 4",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'merge-cleanup'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      nextAction: {
        actionClass: string;
        code: string;
        stepId?: string | null;
      };
      humanAction: unknown;
      recommendedAction: string;
      recommendedActionPolicy: {
        action: string;
        authority: string;
        risk: string;
      };
    };
    expect(payload).toMatchObject({
      nextAction: {
        actionClass: "operator_decision",
        code: "advance_to_step",
        stepId: "merge-cleanup",
      },
      humanAction: null,
      recommendedAction: "operator_decision",
      recommendedActionPolicy: {
        action: "merge_cleanup",
        authority: "human_required",
        risk: "high",
      },
    });

    const after = openDb(dataDir);
    try {
      const steps = after
        .prepare(
          "SELECT step_id AS stepId, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order",
        )
        .all(runId) as Array<{ stepId: string; state: string }>;
      expect(steps).toEqual([
        { stepId: "preflight", state: "succeeded" },
        { stepId: "implementation", state: "succeeded" },
        { stepId: "postflight", state: "succeeded" },
        { stepId: "validate", state: "succeeded" },
        { stepId: "merge-cleanup", state: "approved" },
        { stepId: "tracker-refresh", state: "pending" },
      ]);
      const leaseCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
        )
        .get(runId) as { count: number };
      expect(leaseCount.count).toBe(0);
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("does not expose an approved tracker-refresh tail step as pollable", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-tail-linear-class";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise watch tracker-refresh action class",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
        approvalBoundary: "full",
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'tracker-refresh'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      nextAction: {
        actionClass: string;
        code: string;
        stepId?: string | null;
      };
      recommendedAction: string;
      recommendedActionPolicy: {
        action: string;
        authority: string;
        risk: string;
      };
    };
    expect(payload).toMatchObject({
      nextAction: {
        actionClass: "operator_decision",
        code: "advance_to_step",
        stepId: "tracker-refresh",
      },
      recommendedAction: "operator_decision",
      recommendedActionPolicy: {
        action: "linear_refresh",
        authority: "human_required",
        risk: "high",
      },
    });

    const after = openDb(dataDir);
    try {
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("uses open gate policy before tail-step policy on watch ticks", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-tail-open-gate";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise gated watch tail-step policy precedence",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
        approvalBoundary: "through-merge-cleanup",
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 4",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'merge-cleanup'",
      ).run(runId);
      insertWorkflowGate(
        db,
        {
          gateId: "gate-watch-tail-decision",
          workflowRunId: runId,
          stepRunId: "merge-cleanup",
          targetScope: "step",
          gateType: "operator_decision_required",
          reason: "Merge cleanup needs operator direction before dispatch.",
          evidence:
            "goals/mwf-watch-tail-open-gate/gates/gate-watch-tail-decision.json",
          allowedActions: ["fix", "skip", "approve_as_is"],
          recommendedAction: "fix",
          policyEnvelope: ["fix"],
        },
        { now: SEED_NOW },
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      nextAction: { code: string; stepId?: string | null };
      humanAction: {
        code: string;
        command: string;
        detail: string | null;
      } | null;
      recommendedAction: string;
      recommendedActionPolicy: {
        action: string;
        authority: string;
        risk: string;
      };
    };
    expect(payload).toMatchObject({
      nextAction: { code: "advance_to_step", stepId: "merge-cleanup" },
      humanAction: {
        code: "resolve_gate",
        command:
          "momentum workflow run decide gate-watch-tail-decision --action <action> --actor <name>",
        detail: "Merge cleanup needs operator direction before dispatch.",
      },
      recommendedAction: "operator_decision",
      recommendedActionPolicy: {
        action: "operator_decision",
        authority: "human_required",
        risk: "medium",
      },
    });

    const after = openDb(dataDir);
    try {
      const step = after
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'merge-cleanup'",
        )
        .get(runId) as { state: string };
      expect(step.state).toBe("approved");
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("uses the daemon live-wrapper dispatch chain for a watch tick", async () => {
    const dataDir = makeTempDir();
    const repoPath = path.join(dataDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    initRepo(repoPath);
    const profilePath = writeLiveWrapperProfile(dataDir, "implementation");
    const runId = "mwf-watch-live-wrapper";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath,
        objective: "Exercise watch production dispatcher tick",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 1",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run(
      [
        "workflow",
        "run",
        "watch",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json",
      ],
      { MOMENTUM_LIVE_WRAPPER_PROFILE: profilePath },
    );

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);

    const after = openDb(dataDir);
    try {
      const step = after
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'implementation'",
        )
        .get(runId) as { state: string };
      expect(step.state).toBe("succeeded");
      const attempt = after
        .prepare(
          `SELECT state
           FROM executor_attempts
            WHERE workflow_run_id = ?
              AND step_run_id = 'implementation'`,
        )
        .get(runId) as { state: string } | undefined;
      expect(attempt?.state).toBe("succeeded");
      const lease = after
        .prepare(
          "SELECT released_at AS releasedAt FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
        )
        .get(runId) as { releasedAt: number | null };
      expect(lease.releasedAt).not.toBeNull();
    } finally {
      after.close();
    }
  });

  it("releases the dispatch lease when the watch dispatcher tick throws", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-dispatch-throws";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION_V1,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise watch dispatcher throw cleanup",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 1",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
      ).run(runId);
      db.exec(
        `CREATE TRIGGER fail_watch_attempt_insert
           BEFORE INSERT ON executor_attempts
           BEGIN
             SELECT RAISE(ABORT, 'watch attempt insert failed');
           END`,
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      code: string;
      message: string;
    };
    expect(payload).toMatchObject({
      code: "data_dir_failed",
      message: "watch attempt insert failed",
    });

    const after = openDb(dataDir);
    try {
      const lease = after
        .prepare(
          "SELECT released_at AS releasedAt FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
        )
        .get(runId) as { releasedAt: number | null };
      expect(lease.releasedAt).not.toBeNull();
      const step = after
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'implementation'",
        )
        .get(runId) as { state: string };
      expect(step.state).toBe("approved");
    } finally {
      after.close();
    }
  });

  it("does not dispatch an approved step while an operator gate is open", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-open-gate";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise gated watch supervisor tick",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 1",
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
      ).run(runId);
      insertWorkflowGate(
        db,
        {
          gateId: "gate-watch-decision",
          workflowRunId: runId,
          stepRunId: "implementation",
          targetScope: "step",
          gateType: "operator_decision_required",
          reason: "Implementation needs operator direction before dispatch.",
          evidence: "goals/mwf-watch-open-gate/gates/gate-watch-decision.json",
          allowedActions: ["fix", "skip", "approve_as_is"],
          recommendedAction: "fix",
          policyEnvelope: ["fix"],
        },
        { now: SEED_NOW },
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      humanAction: {
        code: string;
        command: string;
        detail: string | null;
      } | null;
      recommendedAction: string;
      nextPollSeconds: number;
      cleanup: string;
    };
    expect(payload).toMatchObject({
      humanAction: {
        code: "resolve_gate",
        command:
          "momentum workflow run decide gate-watch-decision --action <action> --actor <name>",
        detail: "Implementation needs operator direction before dispatch.",
      },
      recommendedAction: "operator_decision",
      nextPollSeconds: 15,
      cleanup: "none",
    });

    const after = openDb(dataDir);
    try {
      const step = after
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'implementation'",
        )
        .get(runId) as { state: string };
      expect(step.state).toBe("approved");
      const attemptCount = after
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId) as { count: number };
      expect(attemptCount.count).toBe(0);
    } finally {
      after.close();
    }
  });

  it("returns a recovery command for a durable manual-recovery watch tick", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-manual-recovery";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "dispatch lease requires operator recovery",
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      emit: boolean;
      reason: string;
      disposition: string;
      phase: string;
      nextAction: { code: string; stepId?: string | null };
      humanAction: {
        code: string;
        command: string;
        detail: string | null;
      } | null;
      recommendedAction: string;
      nextPollSeconds: number;
      quietForSeconds: number;
      stuckRisk: string;
      cleanup: string;
    };
    expect(payload).toMatchObject({
      emit: true,
      reason: "recovery_required",
      disposition: "recover",
      phase: "blocked",
      nextAction: { code: "clear_recovery", stepId: "implementation" },
      humanAction: {
        code: "clear_recovery",
        command: `momentum workflow run clear-recovery ${runId}`,
        detail: "dispatch lease requires operator recovery",
      },
      recommendedAction: "recover",
      nextPollSeconds: 30,
      quietForSeconds: 0,
      stuckRisk: "high",
      cleanup: "none",
    });
  });

  it("does not emit a recovery command for soft monitor drift", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-monitor-drift";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
      });
      seedLease(db, {
        runId,
        leaseKind: "managed-step",
        expiresAt: FRESH_EXPIRY,
      });
      db.prepare(
        `UPDATE workflow_runs
            SET monitor_last_seen_state = 'succeeded',
                monitor_terminal = 1,
                monitor_step = 'implementation'
          WHERE id = ?`,
      ).run(runId);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      disposition: string;
      phase: string;
      nextAction: { code: string };
      humanAction: unknown;
      recommendedAction: string;
      stuckRisk: string;
    };
    expect(payload).toMatchObject({
      disposition: "report",
      phase: "advancing",
      nextAction: { code: "resume_running" },
      humanAction: null,
      recommendedAction: "poll",
      stuckRisk: "low",
    });
  });

  it("does not emit a clear-recovery command for an ordinary failed step", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-failed-required-step";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "failed" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "failed",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      disposition: string;
      phase: string;
      nextAction: { code: string; stepId?: string | null };
      humanAction: unknown;
      recommendedAction: string;
      stuckRisk: string;
    };
    expect(payload).toMatchObject({
      disposition: "recover",
      phase: "blocked",
      nextAction: { code: "rerun_failed_step", stepId: "implementation" },
      humanAction: null,
      recommendedAction: "operator_decision",
      stuckRisk: "high",
    });
  });

  it.each([
    {
      stepId: "merge-cleanup",
      kind: "merge-cleanup",
      policyAction: "merge_cleanup",
    },
    {
      stepId: "tracker-refresh",
      kind: "tracker-refresh",
      policyAction: "linear_refresh",
    },
  ])(
    "marks failed external tail recovery as human-required for $stepId",
    async ({ stepId, kind, policyAction }) => {
      const dataDir = makeTempDir();
      const runId = `cwfp-watch-failed-${stepId}`;
      const db = openDb(dataDir);
      try {
        seedRun(db, { runId, state: "failed" });
        seedStep(db, {
          runId,
          stepId,
          kind,
          state: "failed",
          order: 4,
        });
      } finally {
        db.close();
      }

      const result = await run([
        "workflow",
        "run",
        "watch",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json",
      ]);

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        nextAction: { code: string; stepId?: string | null };
        humanAction: { command: string; detail: string | null } | null;
        recommendedAction: string;
        recommendedActionPolicy: {
          action: string;
          authority: string;
          risk: string;
        };
      };
      expect(payload).toMatchObject({
        nextAction: { code: "clear_recovery", stepId },
        recommendedAction: "recover",
        recommendedActionPolicy: {
          action: policyAction,
          authority: "human_required",
          risk: "high",
        },
      });
      expect(payload.humanAction?.command).toContain(
        "--evidence-pointer <ref>",
      );
    },
  );

  it.each([
    {
      label: "stale running step",
      runId: "cwfp-watch-stale-running-step",
      runState: "running",
      leaseKind: "managed-step",
    },
    {
      label: "ghost active step",
      runId: "cwfp-watch-ghost-active-step",
      runState: "running",
      leaseKind: null,
    },
    {
      label: "manual recovery lease blocker",
      runId: "cwfp-watch-manual-recovery-lease",
      runState: "blocked",
      leaseKind: "managed-step",
      needsManualRecovery: true,
    },
  ])(
    "does not emit a clear-recovery command for a $label",
    async ({ runId, runState, leaseKind, needsManualRecovery }) => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        seedRun(db, {
          runId,
          state: runState,
          needsManualRecovery: needsManualRecovery ?? false,
          manualRecoveryReason: needsManualRecovery
            ? "lease blocker requires investigation"
            : null,
        });
        seedStep(db, {
          runId,
          stepId: "implementation",
          kind: "implementation",
          state: "running",
          order: 1,
        });
        if (leaseKind !== null) {
          seedLease(db, {
            runId,
            leaseKind,
            expiresAt: 1_000,
          });
        }
      } finally {
        db.close();
      }

      const result = await run([
        "workflow",
        "run",
        "watch",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json",
      ]);

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        humanAction: unknown;
        reason: string;
        disposition: string;
        nextAction: { code: string };
        recommendedAction: string;
        stuckRisk: string;
      };
      expect(payload.reason).toBe("recovery_required");
      expect(payload.disposition).toBe("recover");
      expect(payload.nextAction.code).not.toBe("clear_recovery");
      expect(payload.humanAction).toBeNull();
      expect(payload.recommendedAction).toBe("recover");
      expect(payload.stuckRisk).toBe("high");
    },
  );

  it("prints the supervisor recovery command in text mode for a durable manual-recovery watch tick", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-manual-recovery-text";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "dispatch lease requires operator recovery",
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1,
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Workflow run watch: ${runId}`);
    expect(result.stdout).toContain("Reason: recovery_required");
    expect(result.stdout).toContain("Disposition: recover");
    expect(result.stdout).toContain("Phase: blocked");
    expect(result.stdout).toContain("Next action: clear_recovery");
    expect(result.stdout).toContain("Recommended action: recover");
    expect(result.stdout).toContain(
      `Human action: momentum workflow run clear-recovery ${runId}`,
    );
    expect(result.stdout).toContain(
      "Human action detail: dispatch lease requires operator recovery",
    );
  });

  it("returns release cleanup for a terminal run with a stale manual-recovery flag", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-terminal-stale-recovery";
    const db = openDb(dataDir);
    try {
      persistWorkflowRunStart(db, {
        definition: CODING_WORKFLOW_DEFINITION,
        runId,
        repoPath: "/repos/momentum",
        objective: "Exercise terminal watch cleanup",
        now: SEED_NOW,
        source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded', started_at = ?, finished_at = ? WHERE run_id = ?",
      ).run(SEED_NOW, SEED_NOW + 1, runId);
      db.prepare(
        `UPDATE workflow_runs
            SET state = 'succeeded',
                needs_manual_recovery = 1,
                manual_recovery_reason = ?,
                manual_recovery_at = ?,
                finished_at = ?
          WHERE id = ?`,
      ).run(
        "Stale manual-recovery flag after operator reconciliation.",
        SEED_NOW,
        SEED_NOW + 1,
        runId,
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      emit: boolean;
      reason: string;
      disposition: string;
      phase: string;
      activeStep: unknown;
      nextAction: { code: string; stepId?: string | null };
      humanAction: unknown;
      recommendedAction: string;
      nextPollSeconds: number;
      quietForSeconds: number;
      stuckRisk: string;
      cleanup: string;
    };
    expect(payload).toMatchObject({
      emit: true,
      reason: "terminal_succeeded",
      disposition: "report",
      phase: "terminal",
      activeStep: null,
      nextAction: { code: "no_action", stepId: null },
      humanAction: null,
      recommendedAction: "release",
      nextPollSeconds: 0,
      quietForSeconds: 0,
      stuckRisk: "low",
      cleanup: "release",
    });
  });

  it("returns an approval command for an approval-gated watch tick", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-watch-awaiting-approval";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "pending" });
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
      "watch",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      emit: boolean;
      reason: string;
      disposition: string;
      phase: string;
      nextAction: { code: string; stepId?: string | null };
      humanAction: {
        code: string;
        command: string;
        detail: string | null;
      } | null;
      recommendedAction: string;
      nextPollSeconds: number;
      quietForSeconds: number;
      stuckRisk: string;
      cleanup: string;
    };
    expect(payload).toMatchObject({
      emit: true,
      reason: "awaiting_approval",
      disposition: "report",
      phase: "awaiting_approval",
      nextAction: { code: "await_approval", stepId: "implementation" },
      humanAction: {
        code: "approve",
        command: `momentum workflow run approve ${runId} --approval-boundary through-implementation --phrase "approve plan ${runId} through-implementation"`,
        detail:
          'Step "implementation" is pending approval before it can advance.',
      },
      recommendedAction: "approve",
      nextPollSeconds: 30,
      quietForSeconds: 0,
      stuckRisk: "medium",
      cleanup: "none",
    });
  });
});
