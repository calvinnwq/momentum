import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  deriveWorkflowMonitorProgress,
  type WorkflowMonitorProgressTick
} from "../src/core/workflow/monitor-progress.js";
import type {
  WorkflowMonitorEnvelope,
  WorkflowMonitorEnvelopeCounts
} from "../src/core/workflow/monitor-envelope.js";
import {
  deriveWorkflowWatchAdvisory,
  WORKFLOW_WATCH_DEFAULT_QUIET_THRESHOLDS_SECONDS,
  WORKFLOW_WATCH_REASONS
} from "../src/core/workflow/watch-advisory.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run-start.js";

const NOW = 1_730_000_900_000;
const SEED_NOW = 1_730_000_000_000;
const FRESH_EXPIRY = 9_999_999_999_999;
const ADVISORY_DATA_DIR = "/tmp/momentum watch data";
const tempRoots: string[] = [];

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-watch-quiet-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
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
    env
  });
  return { code, stdout, stderr };
}

function makeCounts(
  overrides: Partial<WorkflowMonitorEnvelopeCounts> = {}
): WorkflowMonitorEnvelopeCounts {
  return {
    steps: 1,
    stepsByState: {
      pending: 0,
      approved: 0,
      running: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      blocked: 0,
      canceled: 0
    },
    approvals: 0,
    leases: 0,
    gates: 0,
    gatesOpen: 0,
    ...overrides
  };
}

function makeEnvelope(
  overrides: Partial<WorkflowMonitorEnvelope> = {}
): WorkflowMonitorEnvelope {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    runId: "mwf-watch-quiet",
    source: "momentum-native-coding",
    runState: "running",
    stepState: "running",
    terminal: false,
    blocked: false,
    needsManualRecovery: false,
    manualRecoveryReason: null,
    disposition: "wait",
    reportable: false,
    reportReason: "in_progress",
    activeStep: {
      stepId: "implementation",
      kind: "implementation",
      state: "running",
      order: 1,
      required: true
    },
    leases: [],
    lastCheckpoint: null,
    monitorDrift: null,
    nextAction: {
      code: "resume_running",
      stepId: "implementation",
      leaseKind: "managed-step",
      detail: "Step is running with fresh evidence. Allow it to continue."
    },
    recovery: null,
    evidence: [],
    gates: [],
    counts: makeCounts(),
    monitorLastEmittedDigest: null,
    monitorLastSeenAt: null,
    monitorLastEmittedAt: null,
    ...overrides
  };
}

function unchangedProgress(
  envelope: WorkflowMonitorEnvelope
): WorkflowMonitorProgressTick {
  const first = deriveWorkflowMonitorProgress(envelope);
  return deriveWorkflowMonitorProgress(envelope, { priorDigest: first.digest });
}

function seedRun(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, source_artifact_path, plan_json,
        repo_path, objective, issue_scope_json, route_json,
        approval_boundary, skill_revision,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "running",
    MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    null,
    "{}",
    null,
    null,
    "{}",
    "{}",
    null,
    null,
    0,
    null,
    null,
    SEED_NOW,
    null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedRunningStep(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, result_digest, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "implementation",
    "implementation",
    "running",
    1,
    1,
    null,
    null,
    null,
    null,
    SEED_NOW,
    null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedFreshLease(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "managed-step",
    `holder:${runId}`,
    1_000,
    FRESH_EXPIRY,
    1_000,
    null,
    "auto-release",
    SEED_NOW,
    SEED_NOW
  );
}

async function watchOnce(
  dataDir: string,
  runId: string
): Promise<Record<string, unknown>> {
  const result = await run([
    "workflow",
    "run",
    "watch",
    runId,
    "--once",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("workflow watch quiet heartbeat and stuck-risk advisory", () => {
  it("centralizes default quiet thresholds by phase family", () => {
    expect(WORKFLOW_WATCH_DEFAULT_QUIET_THRESHOLDS_SECONDS).toEqual({
      implementation: 15 * 60,
      postflight: 10 * 60,
      "no-mistakes": 15 * 60,
      "merge-cleanup": 5 * 60,
      "linear-refresh": 5 * 60,
      approval: 30 * 60,
      recovery: 60 * 60,
      idle: 15 * 60
    });
    expect([...WORKFLOW_WATCH_REASONS]).toContain("quiet_heartbeat");
    expect([...WORKFLOW_WATCH_REASONS]).toContain("stuck_risk");
  });

  it("keeps repeated unchanged active execution silent until the step threshold", () => {
    const envelope = makeEnvelope();
    const progress = unchangedProgress(envelope);

    const advisory = deriveWorkflowWatchAdvisory(envelope, progress, {
      dataDir: ADVISORY_DATA_DIR,
      now: NOW,
      lastEmittedAt: NOW - 14 * 60 * 1000
    });

    expect(advisory).toMatchObject({
      emit: false,
      reason: "in_progress",
      quietForSeconds: 14 * 60,
      quietThresholdSeconds: 15 * 60,
      stuckRisk: "low",
      inspectionCommand: null
    });
  });

  it("emits stuck-risk once per active execution threshold window", () => {
    const envelope = makeEnvelope();
    const progress = unchangedProgress(envelope);

    const due = deriveWorkflowWatchAdvisory(envelope, progress, {
      dataDir: ADVISORY_DATA_DIR,
      now: NOW,
      lastEmittedAt: NOW - 15 * 60 * 1000
    });
    const throttledAgain = deriveWorkflowWatchAdvisory(envelope, progress, {
      dataDir: ADVISORY_DATA_DIR,
      now: NOW + 30 * 1000,
      lastEmittedAt: NOW
    });

    expect(due).toMatchObject({
      emit: true,
      reason: "stuck_risk",
      quietForSeconds: 15 * 60,
      quietThresholdSeconds: 15 * 60,
      stuckRisk: "medium",
      activeStepId: "implementation",
      inspectionCommand:
        "momentum workflow run monitor 'mwf-watch-quiet' --data-dir '/tmp/momentum watch data' --advance --json"
    });
    expect(throttledAgain).toMatchObject({
      emit: false,
      reason: "in_progress",
      quietForSeconds: 30
    });
  });

  it("shell-quotes the stuck-risk inspection command run id", () => {
    const envelope = makeEnvelope({
      runId: "mwf-watch quiet;'$(touch nope)'"
    });
    const advisory = deriveWorkflowWatchAdvisory(
      envelope,
      unchangedProgress(envelope),
      {
        dataDir: "/tmp/momentum data;'$(touch nope)'",
        now: NOW,
        lastEmittedAt: NOW - 15 * 60 * 1000
      }
    );

    expect(advisory.inspectionCommand).toBe(
      "momentum workflow run monitor 'mwf-watch quiet;'\\''$(touch nope)'\\''' --data-dir '/tmp/momentum data;'\\''$(touch nope)'\\''' --advance --json"
    );
  });

  it.each([
    ["implementation", 15 * 60],
    ["postflight", 10 * 60],
    ["no-mistakes", 15 * 60],
    ["merge-cleanup", 5 * 60],
    ["linear-refresh", 5 * 60]
  ] as const)(
    "uses the %s quiet threshold for active execution stuck risk",
    (kind, thresholdSeconds) => {
      const envelope = makeEnvelope({
        activeStep: {
          stepId: kind,
          kind,
          state: "running",
          order: 1,
          required: true
        },
        nextAction: {
          code: "resume_running",
          stepId: kind,
          leaseKind: "managed-step",
          detail: "Step is running with fresh evidence. Allow it to continue."
        }
      });
      const advisory = deriveWorkflowWatchAdvisory(
        envelope,
        unchangedProgress(envelope),
        {
          dataDir: ADVISORY_DATA_DIR,
          now: NOW,
          lastEmittedAt: NOW - thresholdSeconds * 1000
        }
      );

      expect(advisory.reason).toBe("stuck_risk");
      expect(advisory.emit).toBe(true);
      expect(advisory.quietThresholdSeconds).toBe(thresholdSeconds);
      expect(advisory.activeStepId).toBe(kind);
    }
  );

  it("uses active step thresholds for soft monitor drift that is still advancing", () => {
    const envelope = makeEnvelope({
      reportReason: "monitor_drift",
      disposition: "report",
      reportable: true,
      recovery: {
        code: "monitor_drift_stale",
        message: "Advisory monitor snapshot is stale.",
        stepId: "implementation"
      },
      monitorDrift: {
        advisoryState: "running",
        advisoryTerminal: false,
        actualState: "running",
        drifted: true,
        reason: "monitor_step_mismatch",
      }
    });
    const advisory = deriveWorkflowWatchAdvisory(
      envelope,
      unchangedProgress(envelope),
      {
        dataDir: ADVISORY_DATA_DIR,
        now: NOW,
        lastEmittedAt: NOW - 15 * 60 * 1000
      }
    );

    expect(advisory).toMatchObject({
      emit: true,
      reason: "stuck_risk",
      quietThresholdSeconds: 15 * 60,
      stuckRisk: "medium"
    });
  });

  it("throttles approval reminders separately from active execution", () => {
    const envelope = makeEnvelope({
      disposition: "report",
      reportable: true,
      reportReason: "awaiting_approval",
      activeStep: {
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1,
        required: true
      },
      stepState: "pending",
      nextAction: {
        code: "await_approval",
        stepId: "implementation",
        leaseKind: "managed-step",
        detail: 'Step "implementation" is pending approval.'
      }
    });
    const progress = unchangedProgress(envelope);

    expect(
      deriveWorkflowWatchAdvisory(envelope, progress, {
        dataDir: ADVISORY_DATA_DIR,
        now: NOW,
        lastEmittedAt: NOW - 29 * 60 * 1000
      })
    ).toMatchObject({
      emit: false,
      reason: "awaiting_approval",
      quietThresholdSeconds: 30 * 60
    });
    expect(
      deriveWorkflowWatchAdvisory(envelope, progress, {
        dataDir: ADVISORY_DATA_DIR,
        now: NOW,
        lastEmittedAt: NOW - 30 * 60 * 1000
      })
    ).toMatchObject({
      emit: true,
      reason: "quiet_heartbeat",
      quietForSeconds: 30 * 60,
      quietThresholdSeconds: 30 * 60,
      stuckRisk: "medium"
    });
  });

  it("throttles recovery reminders separately from approval reminders", () => {
    const envelope = makeEnvelope({
      runState: "blocked",
      blocked: true,
      needsManualRecovery: true,
      manualRecoveryReason: "operator needs to verify external state",
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required",
      recovery: {
        code: "manual_recovery_lease",
        message: "Manual recovery is required.",
        stepId: "merge-cleanup"
      },
      nextAction: {
        code: "clear_recovery",
        stepId: "merge-cleanup",
        leaseKind: null,
        detail: "Clear recovery after resolving the underlying cause."
      }
    });
    const progress = unchangedProgress(envelope);

    expect(
      deriveWorkflowWatchAdvisory(envelope, progress, {
        dataDir: ADVISORY_DATA_DIR,
        now: NOW,
        lastEmittedAt: NOW - 59 * 60 * 1000
      })
    ).toMatchObject({
      emit: false,
      reason: "recovery_required",
      quietThresholdSeconds: 60 * 60
    });
    expect(
      deriveWorkflowWatchAdvisory(envelope, progress, {
        dataDir: ADVISORY_DATA_DIR,
        now: NOW,
        lastEmittedAt: NOW - 60 * 60 * 1000
      })
    ).toMatchObject({
      emit: true,
      reason: "quiet_heartbeat",
      quietForSeconds: 60 * 60,
      quietThresholdSeconds: 60 * 60,
      stuckRisk: "high"
    });
  });

  it("persists quiet baselines and emits advisory-only stuck risk once per window", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-persisted-quiet";
    const db = openDb(dataDir);
    try {
      seedRun(db, runId);
      seedRunningStep(db, runId);
      seedFreshLease(db, runId);
    } finally {
      db.close();
    }

    const first = await watchOnce(dataDir, runId);
    expect(first).toMatchObject({
      emit: true,
      reason: "in_progress",
      quietForSeconds: 0,
      inspectionCommand: null
    });

    const firstGeneratedAt = first["generatedAt"] as number;
    const staleBaselineAt = firstGeneratedAt - 15 * 60 * 1000;
    const beforeSecond = openDb(dataDir);
    try {
      beforeSecond
        .prepare(
          `UPDATE workflow_runs
              SET monitor_last_emitted_at = ?,
                  monitor_last_seen_at = ?
            WHERE id = ?`
        )
        .run(staleBaselineAt, staleBaselineAt, runId);
    } finally {
      beforeSecond.close();
    }

    const second = await watchOnce(dataDir, runId);
    expect(second).toMatchObject({
      emit: true,
      reason: "stuck_risk",
      quietForSeconds: expect.any(Number),
      quietThresholdSeconds: 15 * 60,
      stuckRisk: "medium",
      activeStep: { stepId: "implementation", state: "running" },
      inspectionCommand:
        `momentum workflow run monitor 'mwf-watch-persisted-quiet' --data-dir '${dataDir}' --advance --json`
    });
    expect(second["quietForSeconds"] as number).toBeGreaterThanOrEqual(15 * 60);

    const afterSecond = openDb(dataDir);
    try {
      const state = afterSecond
        .prepare(
          `SELECT r.state AS runState,
                  s.state AS stepState,
                  r.monitor_last_emitted_at AS emittedAt
             FROM workflow_runs r
             JOIN workflow_steps s ON s.run_id = r.id
            WHERE r.id = ? AND s.step_id = 'implementation'`
        )
        .get(runId) as {
        runState: string;
        stepState: string;
        emittedAt: number | null;
      };
      expect(state.runState).toBe("running");
      expect(state.stepState).toBe("running");
      expect(state.emittedAt).toBe(second["generatedAt"]);
    } finally {
      afterSecond.close();
    }

    const third = await watchOnce(dataDir, runId);
    expect(third).toMatchObject({
      emit: false,
      reason: "in_progress",
      quietThresholdSeconds: 15 * 60,
      inspectionCommand: null
    });
    expect(third["quietForSeconds"] as number).toBeLessThan(15 * 60);
  });

  it("seeds a missing emitted timestamp for migrated digest-only baselines", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-watch-migrated-baseline";
    const db = openDb(dataDir);
    try {
      seedRun(db, runId);
      seedRunningStep(db, runId);
      seedFreshLease(db, runId);
    } finally {
      db.close();
    }

    const first = await watchOnce(dataDir, runId);
    expect(first).toMatchObject({ emit: true, reason: "in_progress" });

    const migrated = openDb(dataDir);
    try {
      migrated
        .prepare(
          `UPDATE workflow_runs
              SET monitor_last_emitted_at = NULL,
                  monitor_last_seen_at = NULL
            WHERE id = ?`
        )
        .run(runId);
    } finally {
      migrated.close();
    }

    const second = await watchOnce(dataDir, runId);
    expect(second).toMatchObject({
      emit: false,
      reason: "in_progress",
      quietForSeconds: 0
    });

    const afterSecond = openDb(dataDir);
    try {
      const row = afterSecond
        .prepare(
          `SELECT monitor_last_emitted_at AS emittedAt,
                  monitor_last_seen_at AS seenAt
             FROM workflow_runs
            WHERE id = ?`
        )
        .get(runId) as { emittedAt: number | null; seenAt: number | null };
      expect(row.emittedAt).toBe(second["generatedAt"]);
      expect(row.seenAt).toBe(second["generatedAt"]);
    } finally {
      afterSecond.close();
    }
  });
});
