import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { parseWorkflowRunImport } from "../src/workflow-run-import.js";
import { persistWorkflowRunImport } from "../src/workflow-run-import-persist.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-import-persist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeLedger(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
}

function sha256OfFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function basePlan(
  runId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m7",
    objective: "NGX-314 import current agent-workflow plans",
    repo: "/Users/test/repos/momentum",
    resolvedScope: {
      issues: ["NGX-314"],
      source: "explicit",
      status: "resolved"
    },
    skillRevision: {
      contract: "coding-workflow-pipeline compact skill architecture",
      digest:
        "abc123def4560000000000000000000000000000000000000000000000000000",
      version: "2026.05.22.18",
      schemaVersion: 1
    },
    approvalsRequired: [
      "implementation",
      "postflight:1",
      "no-mistakes",
      "merge-cleanup"
    ],
    taskFlow: {
      childTasks: [
        { stepId: "preflight" },
        { stepId: "implementation" },
        { stepId: "postflight:1" },
        { stepId: "no-mistakes" },
        { stepId: "merge-cleanup" }
      ]
    },
    ...overrides
  };
}

function makeCompletedRunFixture(
  artifactRoot: string,
  runId = "cwfp-persist01"
): { runDir: string; approvalPath: string } {
  const runDir = path.join(artifactRoot, runId);
  const planPath = path.join(runDir, "plan.json");
  const ledgerPath = path.join(runDir, "ledger.jsonl");
  const approvalPath = path.join(
    runDir,
    "approval-through-merge-cleanup.json"
  );

  writeJsonFile(planPath, basePlan(runId));
  writeLedger(ledgerPath, [
    { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z"
    },
    {
      runId,
      step: "postflight:1",
      status: "complete",
      ts: "2026-05-17T10:35:00Z"
    },
    {
      runId,
      step: "no-mistakes",
      status: "complete",
      ts: "2026-05-17T10:40:00Z"
    },
    {
      runId,
      step: "merge-cleanup",
      status: "complete",
      ts: "2026-05-17T10:45:00Z"
    }
  ]);
  writeJsonFile(approvalPath, {
    runId,
    schemaVersion: 1,
    boundary: "through-merge-cleanup",
    actor: "calvin@example.com",
    phrase: "through-merge-cleanup",
    approvedAt: "2026-05-17T09:00:00Z"
  });

  return { runDir, approvalPath };
}

type WorkflowRunRow = {
  id: string;
  state: string;
  source: string;
  source_artifact_path: string | null;
  plan_json: string;
  repo_path: string | null;
  objective: string | null;
  issue_scope_json: string;
  route_json: string;
  approval_boundary: string | null;
  skill_revision: string | null;
  monitor_last_seen_state: string | null;
  monitor_terminal: number | null;
  monitor_step: string | null;
  monitor_last_seen_digest: string | null;
  monitor_last_emitted_digest: string | null;
  needs_manual_recovery: number;
  created_at: number;
  updated_at: number;
};

type WorkflowStepRow = {
  run_id: string;
  step_id: string;
  kind: string;
  state: string;
  step_order: number;
  required: number;
  ledger_offset: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

type WorkflowApprovalRow = {
  run_id: string;
  boundary: string;
  actor: string | null;
  phrase: string;
  artifact_path: string;
  artifact_digest: string;
  recorded_at: number;
  discharged_at: number | null;
  created_at: number;
  updated_at: number;
};

function readWorkflowRun(db: MomentumDb, runId: string): WorkflowRunRow {
  const row = db
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(runId) as WorkflowRunRow | undefined;
  if (!row) throw new Error(`workflow_runs row ${runId} not found`);
  return row;
}

function readWorkflowSteps(
  db: MomentumDb,
  runId: string
): WorkflowStepRow[] {
  return db
    .prepare(
      "SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_order ASC"
    )
    .all(runId) as WorkflowStepRow[];
}

function readWorkflowApprovals(
  db: MomentumDb,
  runId: string
): WorkflowApprovalRow[] {
  return db
    .prepare(
      "SELECT * FROM workflow_approvals WHERE run_id = ? ORDER BY boundary ASC"
    )
    .all(runId) as WorkflowApprovalRow[];
}

function parseOrThrow(runDir: string) {
  const parsed = parseWorkflowRunImport(runDir);
  if (!parsed.ok) {
    throw new Error(
      `expected parseWorkflowRunImport to succeed, got errorCode=${parsed.errorCode}: ${parsed.message}`
    );
  }
  return parsed.import;
}

describe("persistWorkflowRunImport", () => {
  it("inserts workflow_runs, workflow_steps, and workflow_approvals rows from a parsed import", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const { runDir, approvalPath } = makeCompletedRunFixture(artifactRoot);
    const expectedDigest = sha256OfFile(approvalPath);

    const db = openDb(dataDir);
    try {
      const parsed = parseOrThrow(runDir);
      const summary = persistWorkflowRunImport(db, parsed, { now: 1_700_000_000 });

      expect(summary).toEqual({
        runId: "cwfp-persist01",
        source: "agent-workflow",
        state: "succeeded",
        approvalBoundary: "through-merge-cleanup",
        inserted: true,
        stepCount: 5,
        approvalCount: 1
      });

      const runRow = readWorkflowRun(db, "cwfp-persist01");
      expect(runRow.state).toBe("succeeded");
      expect(runRow.source).toBe("agent-workflow");
      expect(runRow.source_artifact_path).toBe(path.join(runDir, "plan.json"));
      expect(runRow.repo_path).toBe("/Users/test/repos/momentum");
      expect(runRow.objective).toBe(
        "NGX-314 import current agent-workflow plans"
      );
      expect(runRow.approval_boundary).toBe("through-merge-cleanup");
      expect(runRow.skill_revision).toBe(
        "abc123def4560000000000000000000000000000000000000000000000000000"
      );
      expect(runRow.monitor_last_seen_state).toBeNull();
      expect(runRow.monitor_terminal).toBeNull();
      expect(runRow.monitor_step).toBeNull();
      expect(runRow.monitor_last_seen_digest).toBeNull();
      expect(runRow.monitor_last_emitted_digest).toBeNull();
      expect(runRow.needs_manual_recovery).toBe(0);
      expect(runRow.created_at).toBe(1_700_000_000);
      expect(runRow.updated_at).toBe(1_700_000_000);
      expect(JSON.parse(runRow.issue_scope_json)).toEqual({
        issues: ["NGX-314"],
        source: "explicit",
        status: "resolved"
      });
      expect(JSON.parse(runRow.route_json)).toEqual({
        mode: "execute-ready",
        profile: "momentum-m7"
      });
      expect(JSON.parse(runRow.plan_json)).toMatchObject({
        runId: "cwfp-persist01"
      });

      const stepRows = readWorkflowSteps(db, "cwfp-persist01");
      expect(stepRows.map((r) => r.step_id)).toEqual([
        "preflight",
        "implementation",
        "postflight:1",
        "no-mistakes",
        "merge-cleanup"
      ]);
      expect(stepRows.map((r) => r.kind)).toEqual([
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup"
      ]);
      expect(stepRows.map((r) => r.state)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded"
      ]);
      expect(stepRows.map((r) => r.required)).toEqual([0, 1, 1, 1, 1]);
      const impl = stepRows.find((r) => r.step_id === "implementation");
      expect(impl?.started_at).toBe(Date.parse("2026-05-17T10:01:00Z"));
      expect(impl?.finished_at).toBe(Date.parse("2026-05-17T10:30:00Z"));

      const approvalRows = readWorkflowApprovals(db, "cwfp-persist01");
      expect(approvalRows).toHaveLength(1);
      const approval = approvalRows[0]!;
      expect(approval.boundary).toBe("through-merge-cleanup");
      expect(approval.actor).toBe("calvin@example.com");
      expect(approval.phrase).toBe("through-merge-cleanup");
      expect(approval.artifact_path).toBe(approvalPath);
      expect(approval.artifact_digest).toBe(expectedDigest);
      expect(approval.recorded_at).toBe(Date.parse("2026-05-17T09:00:00Z"));
      expect(approval.discharged_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("persists monitor advisory fields for durable status loaders", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-monitor-advisory";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-29T00:00:00Z"
      }
    ]);
    writeJsonFile(path.join(runDir, "monitor.json"), {
      lastSeenState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: "stale-digest",
      lastEmittedDigest: "emitted-digest"
    });

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });

      const runRow = readWorkflowRun(db, runId);
      expect(runRow.monitor_last_seen_state).toBe("succeeded");
      expect(runRow.monitor_terminal).toBe(1);
      expect(runRow.monitor_step).toBe("implementation");
      expect(runRow.monitor_last_seen_digest).toBe("stale-digest");
      expect(runRow.monitor_last_emitted_digest).toBe("emitted-digest");
    } finally {
      db.close();
    }
  });

  it("is idempotent on re-import: row counts unchanged and created_at preserved", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const { runDir } = makeCompletedRunFixture(artifactRoot);

    const db = openDb(dataDir);
    try {
      const first = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      expect(first.inserted).toBe(true);

      const runAfterFirst = readWorkflowRun(db, "cwfp-persist01");

      const second = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });
      expect(second.inserted).toBe(false);
      expect(second.stepCount).toBe(5);
      expect(second.approvalCount).toBe(1);

      const runRowsCount = (
        db
          .prepare("SELECT COUNT(*) AS c FROM workflow_runs")
          .get() as { c: number }
      ).c;
      const stepRowsCount = (
        db
          .prepare("SELECT COUNT(*) AS c FROM workflow_steps")
          .get() as { c: number }
      ).c;
      const approvalRowsCount = (
        db
          .prepare("SELECT COUNT(*) AS c FROM workflow_approvals")
          .get() as { c: number }
      ).c;
      expect(runRowsCount).toBe(1);
      expect(stepRowsCount).toBe(5);
      expect(approvalRowsCount).toBe(1);

      const runAfterSecond = readWorkflowRun(db, "cwfp-persist01");
      expect(runAfterSecond.created_at).toBe(runAfterFirst.created_at);
      expect(runAfterSecond.updated_at).toBe(1_700_000_500);
      expect(runAfterSecond.state).toBe("succeeded");
    } finally {
      db.close();
    }
  });

  it("upserts step state when the ledger advances between imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-advance01";
    const runDir = path.join(artifactRoot, runId);
    const ledgerPath = path.join(runDir, "ledger.jsonl");

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(ledgerPath, [
      { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z"
      }
    ]);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });

      const beforeAdvance = readWorkflowSteps(db, runId);
      const beforeImpl = beforeAdvance.find(
        (r) => r.step_id === "implementation"
      );
      expect(beforeImpl?.state).toBe("running");
      expect(beforeImpl?.finished_at).toBeNull();

      writeLedger(ledgerPath, [
        { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
        {
          runId,
          step: "implementation",
          status: "started",
          ts: "2026-05-17T10:01:00Z"
        },
        {
          runId,
          step: "implementation",
          status: "complete",
          ts: "2026-05-17T10:30:00Z"
        }
      ]);

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const afterAdvance = readWorkflowSteps(db, runId);
      const afterImpl = afterAdvance.find(
        (r) => r.step_id === "implementation"
      );
      expect(afterImpl?.state).toBe("succeeded");
      expect(afterImpl?.started_at).toBe(Date.parse("2026-05-17T10:01:00Z"));
      expect(afterImpl?.finished_at).toBe(Date.parse("2026-05-17T10:30:00Z"));

      const runRow = readWorkflowRun(db, runId);
      expect(runRow.updated_at).toBe(1_700_000_500);
    } finally {
      db.close();
    }
  });

  it("upserts an approval row when the approval artifact changes between imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-approval01";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(
      runDir,
      "approval-through-merge-cleanup.json"
    );

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" }
    ]);
    writeJsonFile(approvalPath, {
      runId,
      schemaVersion: 1,
      boundary: "through-merge-cleanup",
      actor: "calvin@example.com",
      phrase: "through-merge-cleanup",
      approvedAt: "2026-05-17T09:00:00Z"
    });

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      const firstDigest = sha256OfFile(approvalPath);
      const firstApproval = readWorkflowApprovals(db, runId)[0]!;
      expect(firstApproval.artifact_digest).toBe(firstDigest);
      expect(firstApproval.actor).toBe("calvin@example.com");

      writeJsonFile(approvalPath, {
        runId,
        schemaVersion: 1,
        boundary: "through-merge-cleanup",
        actor: "ops@example.com",
        phrase: "through-merge-cleanup",
        approvedAt: "2026-05-17T09:30:00Z"
      });
      const secondDigest = sha256OfFile(approvalPath);

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const approvalRows = readWorkflowApprovals(db, runId);
      expect(approvalRows).toHaveLength(1);
      const secondApproval = approvalRows[0]!;
      expect(secondApproval.artifact_digest).toBe(secondDigest);
      expect(secondApproval.actor).toBe("ops@example.com");
      expect(secondApproval.recorded_at).toBe(
        Date.parse("2026-05-17T09:30:00Z")
      );
      expect(secondApproval.created_at).toBe(firstApproval.created_at);
      expect(secondApproval.updated_at).toBe(1_700_000_500);
    } finally {
      db.close();
    }
  });

  it("preserves the highest durable approval boundary across re-imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-preserve-import-boundary";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" }
    ]);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("through-merge-cleanup", 1_700_000_100, runId);
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "through-merge-cleanup",
        "operator@example.com",
        "approve through merge cleanup",
        `workflow-run-approve://${runId}/through-merge-cleanup`,
        "durable-digest",
        1_700_000_050,
        null,
        1_700_000_050,
        1_700_000_050
      );

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(runRow.approval_boundary).toBe("through-merge-cleanup");
      const approvalRows = readWorkflowApprovals(db, runId);
      expect(approvalRows.map((row) => row.boundary)).toEqual([
        "through-merge-cleanup"
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves durable approval-unblocked pending steps across re-imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-preserve-approved-steps";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "through-implementation",
        "operator@example.com",
        "approve through implementation",
        `workflow-run-approve://${runId}/through-implementation`,
        "durable-digest",
        1_700_000_050,
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved', updated_at = ? WHERE run_id = ? AND kind IN ('preflight', 'implementation')"
      ).run(1_700_000_050, runId);

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const stepRows = readWorkflowSteps(db, runId);
      expect(
        stepRows.map((row) => [row.kind, row.state])
      ).toEqual([
        ["preflight", "approved"],
        ["implementation", "approved"],
        ["postflight", "pending"],
        ["no-mistakes", "pending"],
        ["merge-cleanup", "pending"]
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves durable approval-unblocked run state across re-imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-preserve-approved-run";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "through-implementation",
        "operator@example.com",
        "approve through implementation",
        `workflow-run-approve://${runId}/through-implementation`,
        "durable-digest",
        1_700_000_050,
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_runs SET state = 'approved', approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("through-implementation", 1_700_000_050, runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved', updated_at = ? WHERE run_id = ? AND kind IN ('preflight', 'implementation')"
      ).run(1_700_000_050, runId);

      const summary = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(summary.state).toBe("approved");
      expect(runRow.state).toBe("approved");
      expect(runRow.approval_boundary).toBe("through-implementation");
    } finally {
      db.close();
    }
  });

  it("persists approval-unblocked run state on fresh imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-fresh-approved-run";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(
      runDir,
      "approval-through-implementation.json"
    );

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);
    writeJsonFile(approvalPath, {
      runId,
      schemaVersion: 1,
      boundary: "through-implementation",
      actor: "ops@example.com",
      phrase: "approve through implementation",
      approvedAt: "2026-05-17T10:05:00Z"
    });

    const db = openDb(dataDir);
    try {
      const summary = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(summary.state).toBe("approved");
      expect(runRow.state).toBe("approved");
      expect(runRow.approval_boundary).toBe("through-implementation");
      expect(
        readWorkflowSteps(db, runId).map((row) => [row.kind, row.state])
      ).toEqual([
        ["preflight", "approved"],
        ["implementation", "approved"],
        ["postflight", "pending"],
        ["no-mistakes", "pending"],
        ["merge-cleanup", "pending"]
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves approval-only run state across re-imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-preserve-plan-only-approval";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "plan-only",
        "operator@example.com",
        "approve plan only",
        `workflow-run-approve://${runId}/plan-only`,
        "durable-digest",
        1_700_000_050,
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_runs SET state = 'approved', approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("plan-only", 1_700_000_050, runId);

      const summary = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(summary.state).toBe("approved");
      expect(runRow.state).toBe("approved");
      expect(runRow.approval_boundary).toBe("plan-only");
      expect(readWorkflowSteps(db, runId).map((row) => row.state)).toEqual([
        "pending",
        "pending",
        "pending",
        "pending",
        "pending"
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves terminal success for approved imports without required steps", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-approved-complete-no-required";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(
      runDir,
      "approval-through-merge-cleanup.json"
    );

    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, { approvalsRequired: [] })
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
      {
        runId,
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z"
      },
      {
        runId,
        step: "postflight:1",
        status: "complete",
        ts: "2026-05-17T10:35:00Z"
      },
      {
        runId,
        step: "no-mistakes",
        status: "complete",
        ts: "2026-05-17T10:40:00Z"
      },
      {
        runId,
        step: "merge-cleanup",
        status: "complete",
        ts: "2026-05-17T10:45:00Z"
      }
    ]);
    writeJsonFile(approvalPath, {
      runId,
      schemaVersion: 1,
      boundary: "through-merge-cleanup",
      actor: "ops@example.com",
      phrase: "approve through merge cleanup",
      approvedAt: "2026-05-17T09:00:00Z"
    });

    const db = openDb(dataDir);
    try {
      const parsed = parseOrThrow(runDir);
      expect(parsed.run.state).toBe("succeeded");

      const summary = persistWorkflowRunImport(db, parsed, {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(summary.state).toBe("succeeded");
      expect(runRow.state).toBe("succeeded");
      expect(runRow.approval_boundary).toBe("through-merge-cleanup");
    } finally {
      db.close();
    }
  });

  it("surfaces current import approval when equal-rank durable approvals exist", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-equal-rank-import-boundary";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(runDir, "approval-through-implementation.json");

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "implementation",
        "operator@example.com",
        "approve implementation",
        `workflow-run-approve://${runId}/implementation`,
        "durable-digest",
        1_700_000_050,
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("implementation", 1_700_000_050, runId);

      writeJsonFile(approvalPath, {
        runId,
        schemaVersion: 1,
        boundary: "through-implementation",
        actor: "ops@example.com",
        phrase: "approve through implementation",
        approvedAt: "2026-05-17T10:05:00Z"
      });

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(runRow.approval_boundary).toBe("through-implementation");
      expect(readWorkflowApprovals(db, runId).map((row) => row.boundary)).toEqual([
        "implementation",
        "through-implementation"
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves newer equal-rank durable approval boundary across older imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-newer-durable-equal-rank";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(runDir, "approval-implementation.json");

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "through-implementation",
        "operator@example.com",
        "approve through implementation",
        `workflow-run-approve://${runId}/through-implementation`,
        "durable-digest",
        Date.parse("2026-05-17T10:05:00Z"),
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("through-implementation", 1_700_000_050, runId);

      writeJsonFile(approvalPath, {
        runId,
        schemaVersion: 1,
        boundary: "implementation",
        actor: "ops@example.com",
        phrase: "approve implementation",
        approvedAt: "2026-05-17T09:00:00Z"
      });

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const runRow = readWorkflowRun(db, runId);
      expect(runRow.approval_boundary).toBe("through-implementation");
      expect(readWorkflowApprovals(db, runId).map((row) => row.boundary)).toEqual([
        "implementation",
        "through-implementation"
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves newer durable approval rows across stale same-boundary imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-newer-durable-same-boundary";
    const runDir = path.join(artifactRoot, runId);
    const approvalPath = path.join(runDir, "approval-implementation.json");

    writeJsonFile(path.join(runDir, "plan.json"), basePlan(runId));
    writeLedger(path.join(runDir, "ledger.jsonl"), []);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `INSERT INTO workflow_approvals (
           run_id, boundary, actor, phrase, artifact_path, artifact_digest,
           recorded_at, discharged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "implementation",
        "operator@example.com",
        "approve implementation",
        `workflow-run-approve://${runId}/implementation`,
        "durable-digest",
        Date.parse("2026-05-17T10:05:00Z"),
        null,
        1_700_000_050,
        1_700_000_050
      );
      db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ?, updated_at = ? WHERE id = ?"
      ).run("implementation", 1_700_000_050, runId);

      writeJsonFile(approvalPath, {
        runId,
        schemaVersion: 1,
        boundary: "implementation",
        actor: "stale@example.com",
        phrase: "stale approve implementation",
        approvedAt: "2026-05-17T09:00:00Z"
      });

      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const approvalRows = readWorkflowApprovals(db, runId);
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0]).toMatchObject({
        actor: "operator@example.com",
        phrase: "approve implementation",
        artifact_path: `workflow-run-approve://${runId}/implementation`,
        artifact_digest: "durable-digest",
        recorded_at: Date.parse("2026-05-17T10:05:00Z"),
        updated_at: 1_700_000_050
      });
    } finally {
      db.close();
    }
  });

  it("preserves operator-transitioned step state across stale re-imports", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-operator-import";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["implementation"],
        taskFlow: {
          childTasks: [{ stepId: "implementation" }]
        }
      })
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z"
      }
    ]);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      expect(readWorkflowRun(db, runId).state).toBe("running");
      expect(readWorkflowSteps(db, runId)[0]?.state).toBe("running");

      db.prepare(
        `UPDATE workflow_steps
            SET state = ?,
                operator_reason = ?,
                operator_actor = ?,
                operator_transition_at = ?,
                finished_at = ?,
                updated_at = ?
          WHERE run_id = ? AND step_id = ?`
      ).run(
        "succeeded",
        "operator verified child completion",
        "calvinnwq",
        1_700_000_250,
        1_700_000_250,
        1_700_000_250,
        runId,
        "implementation"
      );
      db.prepare("UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?")
        .run("succeeded", 1_700_000_250, runId);

      const summary = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      const stepRows = readWorkflowSteps(db, runId);
      expect(summary.state).toBe("succeeded");
      expect(readWorkflowRun(db, runId).state).toBe("succeeded");
      expect(stepRows[0]).toMatchObject({
        step_id: "implementation",
        state: "succeeded",
        finished_at: 1_700_000_250
      });
    } finally {
      db.close();
    }
  });

  it("keeps operator-transitioned imports active while a lease remains outstanding", () => {
    const dataDir = makeTempDir("momentum-data-");
    const artifactRoot = makeTempDir();
    const runId = "cwfp-operator-import-lease";
    const runDir = path.join(artifactRoot, runId);

    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["implementation"],
        taskFlow: {
          childTasks: [{ stepId: "implementation" }]
        }
      })
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z"
      }
    ]);

    const db = openDb(dataDir);
    try {
      persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_000
      });
      db.prepare(
        `UPDATE workflow_steps
            SET state = ?,
                operator_reason = ?,
                operator_transition_at = ?,
                finished_at = ?,
                updated_at = ?
          WHERE run_id = ? AND step_id = ?`
      ).run(
        "succeeded",
        "operator verified child completion",
        1_700_000_250,
        1_700_000_250,
        1_700_000_250,
        runId,
        "implementation"
      );
      db.prepare("UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?")
        .run("running", 1_700_000_250, runId);
      db.prepare(
        `INSERT INTO workflow_leases
           (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
            released_at, stale_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        "managed-step",
        "child-executor",
        1_700_000_200,
        1_700_100_000,
        1_700_000_200,
        null,
        "auto-release",
        1_700_000_200,
        1_700_000_200
      );

      const summary = persistWorkflowRunImport(db, parseOrThrow(runDir), {
        now: 1_700_000_500
      });

      expect(summary.state).toBe("running");
      expect(readWorkflowRun(db, runId).state).toBe("running");
      expect(readWorkflowSteps(db, runId)[0]).toMatchObject({
        step_id: "implementation",
        state: "succeeded"
      });
    } finally {
      db.close();
    }
  });
});
