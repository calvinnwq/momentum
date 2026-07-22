import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildCli,
  cleanupTempRoots,
  makeTempDir,
  runCliBinary,
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

type M7WorkflowImportFixtureOptions = {
  runId: string;
  withMonitor?: "stale" | "terminal" | "none";
  withLostManagedMarkers?: boolean;
  withApproval?: "discharged" | "pending";
  withMalformedPlan?: boolean;
};

function writeM7WorkflowImportFixture(
  rootDir: string,
  options: M7WorkflowImportFixtureOptions,
): string {
  const { runId } = options;
  const runDir = path.join(rootDir, ".agent-workflows", runId);
  fs.mkdirSync(runDir, { recursive: true });

  if (options.withMalformedPlan) {
    fs.writeFileSync(path.join(runDir, "plan.json"), "{not valid json");
  } else {
    fs.writeFileSync(
      path.join(runDir, "plan.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          mode: "execute-ready",
          profile: "momentum-m7-smoke",
          objective: "NGX-314 smoke fixture for workflow import",
          repo: "/Users/test/repos/momentum",
          resolvedScope: {
            issues: ["NGX-314"],
            source: "explicit",
            status: "resolved",
          },
          skillRevision: {
            contract: "coding-workflow-pipeline compact skill architecture",
            digest:
              "abc123def4560000000000000000000000000000000000000000000000000000",
            version: "2026.05.22.18",
            schemaVersion: 1,
          },
          approvalsRequired: [
            "implementation",
            "postflight:1",
            "validate",
            "merge-cleanup",
          ],
          taskFlow: {
            childTasks: [
              { stepId: "preflight" },
              { stepId: "implementation" },
              { stepId: "postflight:1" },
              { stepId: "validate" },
              { stepId: "merge-cleanup" },
            ],
          },
        },
        null,
        2,
      ),
    );
  }

  const ledgerEvents = [
    {
      runId,
      step: "preflight",
      status: "complete",
      ts: "2026-05-17T10:00:00Z",
    },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z",
    },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z",
    },
    {
      runId,
      step: "postflight:1",
      status: "complete",
      ts: "2026-05-17T10:35:00Z",
    },
    {
      runId,
      step: "validate",
      status: "complete",
      ts: "2026-05-17T10:40:00Z",
    },
    {
      runId,
      step: "merge-cleanup",
      status: "complete",
      ts: "2026-05-17T10:45:00Z",
    },
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledgerEvents.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  if (options.withMonitor === "stale") {
    fs.writeFileSync(
      path.join(runDir, "monitor.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          active: true,
          terminal: false,
          lastSeenState: "running",
          step: "implementation",
        },
        null,
        2,
      ),
    );
  } else if (options.withMonitor === "terminal") {
    fs.writeFileSync(
      path.join(runDir, "monitor.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          active: false,
          terminal: true,
          lastSeenState: "complete",
        },
        null,
        2,
      ),
    );
  }

  if (options.withLostManagedMarkers) {
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.pid"),
      "99999\n",
    );
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.log"),
      "stale log content\n",
    );
    fs.mkdirSync(path.join(runDir, "locks"));
  }

  if (options.withApproval === "discharged") {
    fs.writeFileSync(
      path.join(runDir, "approval-through-merge-cleanup.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          boundary: "through-merge-cleanup",
          actor: "smoke-tester",
          approvedAt: "2026-05-17T09:00:00Z",
          approvalContract: "approve plan <run-id> <boundary>",
          allowedSteps: [
            "preflight",
            "implementation",
            "postflight:1",
            "validate",
            "merge-cleanup",
          ],
        },
        null,
        2,
      ),
    );
  } else if (options.withApproval === "pending") {
    fs.writeFileSync(
      path.join(runDir, "approval-through-implementation.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          boundary: "through-implementation",
          approvalContract: "approve plan <run-id> <boundary>",
          allowedSteps: ["preflight", "implementation"],
        },
        null,
        2,
      ),
    );
  }

  return runDir;
}

describe("Milestone 7 workflow import end-to-end smoke (NGX-314)", () => {
  it("imports a completed workflow run via the built CLI and persists rows", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-import-completed-");
    const fixtureRoot = makeTempDir("momentum-smoke-m7-import-fixture-");
    const runId = "cwfp-smoke7completed";
    const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
      runId,
      withMonitor: "terminal",
      withApproval: "discharged",
    });

    const result = runCliBinary([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow import",
      dataDir,
      path: runDir,
      runId,
      source: "agent-workflow",
      state: "succeeded",
      inserted: true,
      approvalBoundary: "through-merge-cleanup",
    });
    const counts = payload["counts"] as Record<string, number>;
    expect(counts).toMatchObject({
      steps: 5,
      approvals: 1,
      diagnostics: 0,
    });

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const runRow = db
        .prepare(
          "SELECT id, state, source, approval_boundary FROM workflow_runs WHERE id = ?",
        )
        .get(runId) as {
        id: string;
        state: string;
        source: string;
        approval_boundary: string | null;
      };
      expect(runRow).toMatchObject({
        id: runId,
        state: "succeeded",
        source: "agent-workflow",
        approval_boundary: "through-merge-cleanup",
      });

      const stepRows = db
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order",
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(stepRows.map((row) => row.step_id)).toEqual([
        "preflight",
        "implementation",
        "postflight:1",
        "validate",
        "merge-cleanup",
      ]);
      for (const row of stepRows) {
        expect(row.state).toBe("succeeded");
      }

      const approvalRow = db
        .prepare(
          "SELECT boundary, actor FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as { boundary: string; actor: string | null };
      expect(approvalRow).toMatchObject({
        boundary: "through-merge-cleanup",
        actor: "smoke-tester",
      });
    } finally {
      db.close();
    }
  }, 60_000);

  it("treats a stale monitor as advisory: terminal ledger wins through the built CLI", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-import-stale-monitor-");
    const fixtureRoot = makeTempDir("momentum-smoke-m7-import-stale-fixture-");
    const runId = "cwfp-smoke7staleobs";
    const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
      runId,
      withMonitor: "stale",
    });

    const result = runCliBinary([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow import",
      runId,
      state: "succeeded",
    });
    const monitor = payload["monitor"] as Record<string, unknown>;
    expect(monitor).toMatchObject({
      advisory: true,
      runState: "running",
      terminal: false,
    });

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const runRow = db
        .prepare("SELECT state FROM workflow_runs WHERE id = ?")
        .get(runId) as { state: string };
      expect(runRow.state).toBe("succeeded");

      const stepRow = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get(runId, "implementation") as { state: string };
      expect(stepRow.state).toBe("succeeded");

      const leaseCount = db
        .prepare("SELECT count(*) AS c FROM workflow_leases WHERE run_id = ?")
        .get(runId) as { c: number };
      expect(leaseCount.c).toBe(0);
    } finally {
      db.close();
    }
  }, 60_000);

  it("imports a run with lost managed-task markers and a completed ledger without diagnostics", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-import-lost-managed-");
    const fixtureRoot = makeTempDir("momentum-smoke-m7-import-lost-fixture-");
    const runId = "cwfp-smoke7lostmgd";
    const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
      runId,
      withLostManagedMarkers: true,
    });

    const result = runCliBinary([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow import",
      runId,
      state: "succeeded",
    });
    expect((payload["counts"] as Record<string, number>).diagnostics).toBe(0);
    expect(payload["diagnostics"]).toEqual([]);

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const stepRow = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get(runId, "implementation") as { state: string };
      expect(stepRow.state).toBe("succeeded");
    } finally {
      db.close();
    }
  }, 60_000);

  it("imports an approval file with no approvedAt as a pending-style record (recordedAt=0)", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-import-pending-approval-");
    const fixtureRoot = makeTempDir(
      "momentum-smoke-m7-import-pending-fixture-",
    );
    const runId = "cwfp-smoke7pendapv";
    const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
      runId,
      withApproval: "pending",
    });

    const result = runCliBinary([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow import",
      runId,
      approvalBoundary: "through-implementation",
    });
    const counts = payload["counts"] as Record<string, number>;
    expect(counts.approvals).toBe(1);
    expect(counts.diagnostics).toBe(0);

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const approvalRow = db
        .prepare(
          "SELECT boundary, recorded_at, discharged_at FROM workflow_approvals WHERE run_id = ?",
        )
        .get(runId) as {
        boundary: string;
        recorded_at: number;
        discharged_at: number | null;
      };
      expect(approvalRow.boundary).toBe("through-implementation");
      expect(approvalRow.recorded_at).toBe(0);
      expect(approvalRow.discharged_at).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it("reports diagnostics for a malformed plan but still imports valid ledger evidence", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-import-malformed-");
    const fixtureRoot = makeTempDir(
      "momentum-smoke-m7-import-malformed-fixture-",
    );
    const runId = "cwfp-smoke7badplan";
    const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
      runId,
      withMalformedPlan: true,
    });

    const result = runCliBinary([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow import",
      runId,
      source: "agent-workflow",
    });
    const counts = payload["counts"] as Record<string, number>;
    expect(counts.diagnostics).toBeGreaterThan(0);
    const diagnostics = payload["diagnostics"] as Array<
      Record<string, unknown>
    >;
    const reasons = diagnostics.map((d) => d["reason"]);
    expect(reasons).toContain("file_not_json");

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      const runRow = db
        .prepare("SELECT id, source FROM workflow_runs WHERE id = ?")
        .get(runId) as { id: string; source: string };
      expect(runRow.id).toBe(runId);
      expect(runRow.source).toBe("agent-workflow");

      const stepRow = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get(runId, "preflight") as { state: string };
      expect(stepRow.state).toBe("succeeded");
    } finally {
      db.close();
    }
  }, 60_000);
});
