import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-run-list-"): string {
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

type SeedRunInput = {
  runId: string;
  state: string;
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
    "agent-workflow",
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

function seedStep(
  db: MomentumDb,
  runId: string,
  input: {
    stepId: string;
    kind: string;
    state: string;
    order: number;
    finishedAt?: number;
  }
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
    1,
    null,
    null,
    null,
    null,
    input.finishedAt ?? null,
    now,
    now
  );
}

describe("momentum workflow run list (NGX-324)", () => {
  it("returns a successful empty list when no runs match", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "list",
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
    expect(payload.command).toBe("workflow run list");
    expect(payload.count).toBe(0);
    expect(payload.runs).toEqual([]);
  });

  it("refuses unknown workflow run subcommand with a stable code", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "bogus",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown workflow run subcommand: bogus");
  });

  it("refuses an invalid --filter with invalid_filter", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "list",
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
      command: "workflow run list",
      code: "invalid_filter"
    });
  });

  it("refuses an invalid --state with invalid_state", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "list",
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
      command: "workflow run list",
      code: "invalid_state"
    });
  });

  it("refuses a negative --limit at the flag-parsing layer", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "list",
      "--limit",
      "-2",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid value for --limit");
  });

  it("refuses a non-numeric --updated-since at the flag-parsing layer", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "list",
      "--updated-since",
      "yesterday",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid value for --updated-since");
  });

  it("filters by --filter, --approval-boundary, --repo, --issue-scope, and --updated-since", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "wrl-active001",
        state: "running",
        approvalBoundary: "implementation",
        repoPath: "/repos/alpha",
        issueScopeJson: JSON.stringify({ identifier: "NGX-101" }),
        updatedAt: 2_000
      });
      seedRun(db, {
        runId: "wrl-active002",
        state: "running",
        approvalBoundary: "through-merge-cleanup",
        repoPath: "/repos/beta",
        issueScopeJson: JSON.stringify({ identifier: "NGX-102" }),
        updatedAt: 1_500
      });
      seedRun(db, {
        runId: "wrl-blocked001",
        state: "blocked",
        approvalBoundary: null,
        repoPath: "/repos/alpha",
        issueScopeJson: JSON.stringify({ identifier: "NGX-103" }),
        updatedAt: 1_000
      });
      seedRun(db, {
        runId: "wrl-done001",
        state: "succeeded",
        approvalBoundary: null,
        repoPath: "/repos/alpha",
        issueScopeJson: JSON.stringify({ identifier: "NGX-104" }),
        updatedAt: 500
      });
    } finally {
      db.close();
    }

    const all = await run([
      "workflow",
      "run",
      "list",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(all.code).toBe(0);
    const allPayload = JSON.parse(all.stdout) as {
      count: number;
      runs: Array<{ run: { runId: string; state: string } }>;
    };
    expect(allPayload.count).toBe(4);
    expect(allPayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001",
      "wrl-active002",
      "wrl-blocked001",
      "wrl-done001"
    ]);

    const active = await run([
      "workflow",
      "run",
      "list",
      "--filter",
      "active",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(active.code).toBe(0);
    const activePayload = JSON.parse(active.stdout) as {
      runs: Array<{ run: { runId: string } }>;
    };
    expect(activePayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001",
      "wrl-active002"
    ]);

    const byBoundary = await run([
      "workflow",
      "run",
      "list",
      "--approval-boundary",
      "implementation",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byBoundary.code).toBe(0);
    const byBoundaryPayload = JSON.parse(byBoundary.stdout) as {
      runs: Array<{ run: { runId: string } }>;
    };
    expect(byBoundaryPayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001"
    ]);

    const byRepo = await run([
      "workflow",
      "run",
      "list",
      "--repo",
      "/repos/alpha",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byRepo.code).toBe(0);
    const byRepoPayload = JSON.parse(byRepo.stdout) as {
      runs: Array<{ run: { runId: string; repoPath: string | null } }>;
    };
    expect(byRepoPayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001",
      "wrl-blocked001",
      "wrl-done001"
    ]);
    for (const r of byRepoPayload.runs) {
      expect(r.run.repoPath).toBe("/repos/alpha");
    }

    const byIssueScope = await run([
      "workflow",
      "run",
      "list",
      "--issue-scope",
      "NGX-103",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byIssueScope.code).toBe(0);
    const byIssueScopePayload = JSON.parse(byIssueScope.stdout) as {
      runs: Array<{ run: { runId: string } }>;
    };
    expect(byIssueScopePayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-blocked001"
    ]);

    const sinceWindow = await run([
      "workflow",
      "run",
      "list",
      "--updated-since",
      "1500",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(sinceWindow.code).toBe(0);
    const sinceWindowPayload = JSON.parse(sinceWindow.stdout) as {
      runs: Array<{ run: { runId: string } }>;
    };
    expect(sinceWindowPayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001",
      "wrl-active002"
    ]);

    const combined = await run([
      "workflow",
      "run",
      "list",
      "--filter",
      "active",
      "--repo",
      "/repos/alpha",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(combined.code).toBe(0);
    const combinedPayload = JSON.parse(combined.stdout) as {
      runs: Array<{ run: { runId: string } }>;
    };
    expect(combinedPayload.runs.map((r) => r.run.runId)).toEqual([
      "wrl-active001"
    ]);
  });

  it("emits stable text output for workflow run list (bounded and predictable)", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId: "wrl-text001",
        state: "succeeded",
        repoPath: "/repos/alpha",
        updatedAt: 1_000
      });
      seedStep(db, "wrl-text001", {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        state: "succeeded",
        order: 0,
        finishedAt: 999
      });
    } finally {
      db.close();
    }

    const textResult = await run([
      "workflow",
      "run",
      "list",
      "--data-dir",
      dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Workflow runs: 1");
    expect(textResult.stdout).toContain(
      "wrl-text001 [succeeded] repo=/repos/alpha steps=1 approvals=0 leases=0 next=no_action"
    );
  });
});
