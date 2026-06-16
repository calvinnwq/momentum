import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { listWorkflowRunSummaries } from "../src/core/workflow/status.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-run-list-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

type SeedRunInput = {
  runId: string;
  state: string;
  source?: string;
  approvalBoundary?: string | null;
  repoPath?: string | null;
  issueScopeJson?: string;
  updatedAt?: number;
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
    input.repoPath ?? null,
    null,
    input.issueScopeJson ?? "{}",
    "{}",
    input.approvalBoundary ?? null,
    null,
    0,
    null,
    null,
    null,
    null,
    now,
    input.updatedAt ?? now
  );
}

describe("listWorkflowRunSummaries: M8 workflow run list extensions (NGX-324)", () => {
  it("filters by approval boundary", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-approve-impl",
        state: "running",
        approvalBoundary: "implementation",
        updatedAt: 1_000_000
      });
      seedRun(db, {
        runId: "run-approve-merge",
        state: "running",
        approvalBoundary: "through-merge-cleanup",
        updatedAt: 1_000_001
      });
      seedRun(db, {
        runId: "run-approve-null",
        state: "pending",
        approvalBoundary: null,
        updatedAt: 1_000_002
      });

      const result = listWorkflowRunSummaries(db, {
        approvalBoundary: "implementation"
      });
      expect(result.map((s) => s.run.runId)).toEqual(["run-approve-impl"]);
    } finally {
      db.close();
    }
  });

  it("filters by exact repo path", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-repo-alpha",
        state: "running",
        repoPath: "/repos/alpha",
        updatedAt: 1_000_000
      });
      seedRun(db, {
        runId: "run-repo-beta",
        state: "running",
        repoPath: "/repos/beta",
        updatedAt: 1_000_001
      });
      seedRun(db, {
        runId: "run-repo-null",
        state: "running",
        repoPath: null,
        updatedAt: 1_000_002
      });

      const result = listWorkflowRunSummaries(db, {
        repoPath: "/repos/alpha"
      });
      expect(result.map((s) => s.run.runId)).toEqual(["run-repo-alpha"]);
    } finally {
      db.close();
    }
  });

  it("filters by issue scope substring", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-scope-ngx-100",
        state: "running",
        issueScopeJson: JSON.stringify({ identifier: "NGX-100" }),
        updatedAt: 1_000_000
      });
      seedRun(db, {
        runId: "run-scope-ngx-200",
        state: "running",
        issueScopeJson: JSON.stringify({ identifier: "NGX-200" }),
        updatedAt: 1_000_001
      });
      seedRun(db, {
        runId: "run-scope-empty",
        state: "running",
        issueScopeJson: "{}",
        updatedAt: 1_000_002
      });

      const result = listWorkflowRunSummaries(db, {
        issueScope: "NGX-100"
      });
      expect(result.map((s) => s.run.runId)).toEqual(["run-scope-ngx-100"]);
    } finally {
      db.close();
    }
  });

  it("filters by updated-time window (since and until inclusive)", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-before",
        state: "running",
        updatedAt: 999
      });
      seedRun(db, {
        runId: "run-since",
        state: "running",
        updatedAt: 1_000
      });
      seedRun(db, {
        runId: "run-middle",
        state: "running",
        updatedAt: 1_500
      });
      seedRun(db, {
        runId: "run-until",
        state: "running",
        updatedAt: 2_000
      });
      seedRun(db, {
        runId: "run-after",
        state: "running",
        updatedAt: 2_001
      });

      const sinceOnly = listWorkflowRunSummaries(db, { updatedSince: 1_000 });
      expect(sinceOnly.map((s) => s.run.runId)).toEqual([
        "run-after",
        "run-until",
        "run-middle",
        "run-since"
      ]);

      const untilOnly = listWorkflowRunSummaries(db, { updatedUntil: 2_000 });
      expect(untilOnly.map((s) => s.run.runId)).toEqual([
        "run-until",
        "run-middle",
        "run-since",
        "run-before"
      ]);

      const both = listWorkflowRunSummaries(db, {
        updatedSince: 1_000,
        updatedUntil: 2_000
      });
      expect(both.map((s) => s.run.runId)).toEqual([
        "run-until",
        "run-middle",
        "run-since"
      ]);
    } finally {
      db.close();
    }
  });

  it("composes new filters with the existing active / blocked / completed buckets", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-active-alpha",
        state: "running",
        repoPath: "/repos/alpha",
        updatedAt: 1_000_000
      });
      seedRun(db, {
        runId: "run-blocked-alpha",
        state: "blocked",
        repoPath: "/repos/alpha",
        updatedAt: 1_000_001
      });
      seedRun(db, {
        runId: "run-active-beta",
        state: "running",
        repoPath: "/repos/beta",
        updatedAt: 1_000_002
      });

      const result = listWorkflowRunSummaries(db, {
        filter: "active",
        repoPath: "/repos/alpha"
      });
      expect(result.map((s) => s.run.runId)).toEqual(["run-active-alpha"]);
    } finally {
      db.close();
    }
  });

  it("returns an empty list when no run matches the supplied filters (not a refusal)", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "run-solo",
        state: "running",
        approvalBoundary: "implementation",
        updatedAt: 1_000_000
      });

      const result = listWorkflowRunSummaries(db, {
        approvalBoundary: "no-mistakes"
      });
      expect(result).toEqual([]);
    } finally {
      db.close();
    }
  });
});
