import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { ingestEvidenceRecord } from "../src/evidence-records.js";
import {
  insertWorkflowGate,
  resolveWorkflowGate
} from "../src/workflow-gate-persist.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-cli-workflow-status-"): string {
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

const NOW = Date.now();
const FUTURE = NOW + 10 * 60 * 1000;
const RECENT = NOW - 30 * 1000;

type SeedRunInput = {
  runId: string;
  state: string;
  source?: string;
  approvalBoundary?: string;
  objective?: string;
  needsManualRecovery?: boolean;
  startedAt?: number;
  finishedAt?: number;
  updatedAt?: number;
};

type SeedStepInput = {
  stepId: string;
  kind: string;
  state: string;
  order: number;
  required?: boolean;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
};

type SeedLeaseInput = {
  leaseKind: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
  heartbeatAt: number;
  releasedAt?: number | null;
  stalePolicy?: "auto-release" | "manual-recovery-required";
};

type SeedApprovalInput = {
  boundary: string;
  actor?: string;
  phrase?: string;
  artifactPath?: string;
  artifactDigest?: string;
  recordedAt?: number;
  dischargedAt?: number | null;
};

function seedRun(db: MomentumDb, input: SeedRunInput): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, source_artifact_path, plan_json,
        repo_path, objective, issue_scope_json, route_json,
        approval_boundary, skill_revision,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        started_at, finished_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.state,
    input.source ?? "agent-workflow",
    null,
    "{}",
    null,
    input.objective ?? null,
    "{}",
    "{}",
    input.approvalBoundary ?? null,
    null,
    input.needsManualRecovery ? 1 : 0,
    null,
    null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    now,
    input.updatedAt ?? now
  );
}

function seedStep(
  db: MomentumDb,
  runId: string,
  input: SeedStepInput
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    input.required === false ? 0 : 1,
    null,
    input.errorCode ?? null,
    null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    now,
    now
  );
}

function seedLease(
  db: MomentumDb,
  runId: string,
  input: SeedLeaseInput
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    input.leaseKind,
    input.holder,
    input.acquiredAt,
    input.expiresAt,
    input.heartbeatAt,
    input.releasedAt ?? null,
    input.stalePolicy ?? "auto-release",
    now,
    now
  );
}

function seedApproval(
  db: MomentumDb,
  runId: string,
  input: SeedApprovalInput
): void {
  const now = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_approvals
       (run_id, boundary, actor, phrase, artifact_path, artifact_digest,
        recorded_at, discharged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    input.boundary,
    input.actor ?? "calvinnwq",
    input.phrase ?? "approve",
    input.artifactPath ?? `/tmp/${runId}-${input.boundary}.json`,
    input.artifactDigest ?? "deadbeef",
    input.recordedAt ?? now,
    input.dischargedAt ?? null,
    now,
    now
  );
}

describe("momentum workflow status", () => {
  it("rejects unknown workflow subcommand", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "stats",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown workflow subcommand: stats");
  });

  it("returns empty list when no runs exist", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "status",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      count: number;
      runs: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow status");
    expect(payload.count).toBe(0);
    expect(payload.runs).toEqual([]);
  });

  it("rejects an invalid --state with a stable error code", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "status",
      "--state",
      "bogus",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow status",
      code: "invalid_state"
    });
  });

  it("rejects an invalid --filter with a stable error code", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "status",
      "--filter",
      "weird",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow status",
      code: "invalid_filter"
    });
  });

  it("rejects a negative --limit at the flag-parsing layer", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "status",
      "--limit",
      "-1",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid value for --limit");
  });

  it("lists runs and filters active vs blocked vs completed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-active001",
        state: "running",
        updatedAt: NOW + 3
      });
      seedStep(db, "cwfp-active001", {
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
        startedAt: RECENT
      });
      seedLease(db, "cwfp-active001", {
        leaseKind: "managed-step",
        holder: "pipeline",
        acquiredAt: RECENT,
        expiresAt: FUTURE,
        heartbeatAt: RECENT
      });

      seedRun(db, {
        runId: "cwfp-blocked01",
        state: "blocked",
        updatedAt: NOW + 2
      });
      seedStep(db, "cwfp-blocked01", {
        stepId: "implementation",
        kind: "implementation",
        state: "blocked",
        order: 1
      });

      seedRun(db, {
        runId: "cwfp-done001",
        state: "succeeded",
        updatedAt: NOW + 1,
        finishedAt: RECENT
      });
      seedStep(db, "cwfp-done001", {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "succeeded",
        order: 1,
        finishedAt: RECENT
      });
    } finally {
      db.close();
    }

    const all = await run([
      "workflow",
      "status",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(all.code).toBe(0);
    const allPayload = JSON.parse(all.stdout) as {
      count: number;
      runs: Array<{
        run: { runId: string; state: string };
        counts: { steps: number; leases: number; approvals: number };
        monitor: { nextAction: { code: string }; recovery: { code: string } | null };
      }>;
    };
    expect(allPayload.count).toBe(3);
    expect(allPayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-active001",
      "cwfp-blocked01",
      "cwfp-done001"
    ]);

    const active = await run([
      "workflow",
      "status",
      "--filter",
      "active",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(active.code).toBe(0);
    const activePayload = JSON.parse(active.stdout) as {
      runs: Array<{ run: { runId: string; state: string } }>;
    };
    expect(activePayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-active001"
    ]);

    const blocked = await run([
      "workflow",
      "status",
      "--filter",
      "blocked",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(blocked.code).toBe(0);
    const blockedPayload = JSON.parse(blocked.stdout) as {
      runs: Array<{
        run: { runId: string; state: string };
        monitor: { recovery: { code: string } | null };
      }>;
    };
    expect(blockedPayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-blocked01"
    ]);
    expect(blockedPayload.runs[0]?.monitor.recovery?.code).toBe(
      "manual_recovery_lease"
    );

    const completed = await run([
      "workflow",
      "status",
      "--filter",
      "completed",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(completed.code).toBe(0);
    const completedPayload = JSON.parse(completed.stdout) as {
      runs: Array<{
        run: { runId: string; state: string };
        monitor: { nextAction: { code: string } };
      }>;
    };
    expect(completedPayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-done001"
    ]);
    expect(completedPayload.runs[0]?.monitor.nextAction.code).toBe(
      "no_action"
    );

    const byState = await run([
      "workflow",
      "status",
      "--state",
      "running",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byState.code).toBe(0);
    const byStatePayload = JSON.parse(byState.stdout) as {
      runs: Array<{ run: { runId: string; state: string } }>;
    };
    expect(byStatePayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-active001"
    ]);

    const limited = await run([
      "workflow",
      "status",
      "--limit",
      "1",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(limited.code).toBe(0);
    const limitedPayload = JSON.parse(limited.stdout) as { count: number };
    expect(limitedPayload.count).toBe(1);

    const stateInsideFilter = await run([
      "workflow",
      "status",
      "--state",
      "running",
      "--filter",
      "active",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(stateInsideFilter.code).toBe(0);
    const insidePayload = JSON.parse(stateInsideFilter.stdout) as {
      count: number;
      runs: Array<{ run: { runId: string } }>;
    };
    expect(insidePayload.count).toBe(1);
    expect(insidePayload.runs.map((r) => r.run.runId)).toEqual([
      "cwfp-active001"
    ]);

    const stateOutsideFilter = await run([
      "workflow",
      "status",
      "--state",
      "succeeded",
      "--filter",
      "active",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(stateOutsideFilter.code).toBe(0);
    const outsidePayload = JSON.parse(stateOutsideFilter.stdout) as {
      count: number;
      runs: unknown[];
    };
    expect(outsidePayload.count).toBe(0);
    expect(outsidePayload.runs).toEqual([]);
  });

  it("returns run_not_found for an unknown run-id in detail mode", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "status",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow status",
      code: "run_not_found",
      runId: "cwfp-missing"
    });
  });

  it("returns detail with steps, approvals, leases, and monitor next-action", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-detail001",
        state: "running",
        approvalBoundary: "through-merge-cleanup",
        objective: "land workflow status CLI",
        startedAt: RECENT
      });
      seedStep(db, "cwfp-detail001", {
        stepId: "preflight",
        kind: "preflight",
        state: "succeeded",
        order: 0,
        finishedAt: RECENT
      });
      seedStep(db, "cwfp-detail001", {
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1,
        startedAt: RECENT
      });
      seedStep(db, "cwfp-detail001", {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "pending",
        order: 2
      });
      seedApproval(db, "cwfp-detail001", {
        boundary: "through-merge-cleanup",
        recordedAt: RECENT
      });
      seedLease(db, "cwfp-detail001", {
        leaseKind: "managed-step",
        holder: "pipeline",
        acquiredAt: RECENT,
        expiresAt: FUTURE,
        heartbeatAt: RECENT
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "status",
      "cwfp-detail001",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      run: { runId: string; state: string; approvalBoundary: string };
      steps: Array<{ stepId: string; state: string; order: number }>;
      approvals: Array<{ boundary: string }>;
      leases: Array<{ leaseKind: string; holder: string }>;
      monitor: {
        runState: string;
        terminal: boolean;
        activeStep: { stepId: string; state: string } | null;
        nextAction: { code: string; stepId: string | null };
        recovery: { code: string } | null;
      };
      evidence: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow status");
    expect(payload.run.runId).toBe("cwfp-detail001");
    expect(payload.steps.map((s) => s.stepId)).toEqual([
      "preflight",
      "implementation",
      "merge-cleanup"
    ]);
    expect(payload.approvals.length).toBe(1);
    expect(payload.approvals[0]?.boundary).toBe("through-merge-cleanup");
    expect(payload.leases.length).toBe(1);
    expect(payload.leases[0]?.leaseKind).toBe("managed-step");
    expect(payload.monitor.runState).toBe("running");
    expect(payload.monitor.terminal).toBe(false);
    expect(payload.monitor.activeStep?.stepId).toBe("implementation");
    expect(payload.monitor.nextAction.code).toBe("resume_running");
    expect(payload.monitor.recovery).toBeNull();
  });

  it("surfaces open and resolved workflow gates in run detail (JSON and text)", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-gates001",
        state: "running",
        startedAt: RECENT
      });
      seedStep(db, "cwfp-gates001", {
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 0,
        startedAt: RECENT
      });
      insertWorkflowGate(
        db,
        {
          gateId: "gate-open-1",
          workflowRunId: "cwfp-gates001",
          targetScope: "workflow",
          gateType: "approval_required",
          reason: "operator must approve external apply",
          allowedActions: ["approve", "reject"],
          recommendedAction: "approve",
          policyEnvelope: []
        },
        { now: RECENT }
      );
      insertWorkflowGate(
        db,
        {
          gateId: "gate-done-1",
          workflowRunId: "cwfp-gates001",
          stepRunId: "implementation",
          targetScope: "step",
          gateType: "operator_decision_required",
          reason: "decide how to handle a verification failure",
          allowedActions: ["fix", "skip", "abort"],
          recommendedAction: "fix",
          policyEnvelope: ["fix"]
        },
        { now: RECENT }
      );
      resolveWorkflowGate(
        db,
        "gate-done-1",
        { action: "fix", actor: "calvin", mode: "operator" },
        { now: NOW }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "status",
      "cwfp-gates001",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      gates: Array<{
        gateId: string;
        workflowRunId: string;
        stepRunId: string | null;
        targetScope: string;
        gateType: string;
        reason: string;
        allowedActions: string[];
        recommendedAction: string | null;
        policyEnvelope: string[];
        open: boolean;
        resolvedAt: number | null;
        resolvedBy: string | null;
        resolutionMode: string | null;
        chosenAction: string | null;
      }>;
    };
    expect(payload.gates.map((g) => g.gateId).sort()).toEqual([
      "gate-done-1",
      "gate-open-1"
    ]);
    const open = payload.gates.find((g) => g.gateId === "gate-open-1");
    expect(open).toMatchObject({
      workflowRunId: "cwfp-gates001",
      stepRunId: null,
      targetScope: "workflow",
      gateType: "approval_required",
      allowedActions: ["approve", "reject"],
      recommendedAction: "approve",
      policyEnvelope: [],
      open: true,
      resolvedAt: null,
      resolvedBy: null,
      resolutionMode: null,
      chosenAction: null
    });
    const resolved = payload.gates.find((g) => g.gateId === "gate-done-1");
    expect(resolved).toMatchObject({
      stepRunId: "implementation",
      targetScope: "step",
      gateType: "operator_decision_required",
      open: false,
      resolvedBy: "calvin",
      chosenAction: "fix",
      resolutionMode: "operator"
    });
    expect(resolved?.resolvedAt).toBe(NOW);

    const textResult = await run([
      "workflow",
      "status",
      "cwfp-gates001",
      "--data-dir",
      dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Gates: 2 (open: 1)");
    expect(textResult.stdout).toContain("gate-open-1");
    expect(textResult.stdout).toContain("OPEN");
    expect(textResult.stdout).toContain("gate-done-1");
  });

  it("surfaces typed runId/stepId evidence pointers without path inference", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-evidence01",
        state: "running",
        startedAt: RECENT
      });
      seedStep(db, "cwfp-evidence01", {
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1,
        finishedAt: RECENT
      });
      // Evidence linked to this run/step purely by durable typed columns.
      // The run has no source_artifact_path, so path-only inference cannot
      // surface this record — only the typed run_id linkage can.
      ingestEvidenceRecord(db, {
        source: "agent-workflow",
        type: "implementation_complete",
        occurredAt: RECENT,
        summary: "implementation finished",
        runId: "cwfp-evidence01",
        stepId: "implementation",
        ingestKey: "cwfp-evidence01/implementation"
      });
      // Evidence for a different run must not leak into this run's view.
      ingestEvidenceRecord(db, {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: RECENT,
        summary: "other run plan",
        runId: "cwfp-other99",
        stepId: null,
        ingestKey: "cwfp-other99/plan"
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "status",
      "cwfp-evidence01",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      evidence: Array<{
        evidenceRecordId: string;
        source: string;
        type: string;
        runId: string | null;
        stepId: string | null;
        summary: string;
      }>;
    };
    expect(payload.evidence.length).toBe(1);
    expect(payload.evidence[0]?.type).toBe("implementation_complete");
    expect(payload.evidence[0]?.runId).toBe("cwfp-evidence01");
    expect(payload.evidence[0]?.stepId).toBe("implementation");
  });

  it("surfaces rerun_failed_step recovery code when a required step failed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-failed01",
        state: "failed",
        finishedAt: RECENT
      });
      seedStep(db, "cwfp-failed01", {
        stepId: "implementation",
        kind: "implementation",
        state: "failed",
        order: 1,
        finishedAt: RECENT,
        errorCode: "executor_failed"
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "status",
      "cwfp-failed01",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      monitor: {
        nextAction: { code: string; stepId: string | null };
        recovery: { code: string; stepId: string | null } | null;
      };
    };
    expect(payload.monitor.nextAction.code).toBe("rerun_failed_step");
    expect(payload.monitor.recovery?.code).toBe("failed_required_step");
    expect(payload.monitor.recovery?.stepId).toBe("implementation");
  });

  it("renders text output for list and detail modes", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "cwfp-text001",
        state: "succeeded",
        finishedAt: RECENT
      });
      seedStep(db, "cwfp-text001", {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "succeeded",
        order: 0,
        finishedAt: RECENT
      });
    } finally {
      db.close();
    }

    const listResult = await run([
      "workflow",
      "status",
      "--data-dir",
      dataDir
    ]);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("Workflow runs: 1");
    expect(listResult.stdout).toContain(
      "cwfp-text001 [succeeded] steps=1 approvals=0 leases=0 next=no_action"
    );

    const detailResult = await run([
      "workflow",
      "status",
      "cwfp-text001",
      "--data-dir",
      dataDir
    ]);
    expect(detailResult.code).toBe(0);
    expect(detailResult.stdout).toContain("Workflow run: cwfp-text001");
    expect(detailResult.stdout).toContain("Steps: 1");
    expect(detailResult.stdout).toContain("- Next action: no_action");
  });
});
