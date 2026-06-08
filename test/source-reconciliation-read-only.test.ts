import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFetchPageInput,
  type LinearReconciliationFetchPageResult
} from "../src/source-reconciliation.js";

/**
 * NGX-369 read-only invariant proof for the Linear source reconciliation adapter.
 *
 * The source-adapters contract (internal/contracts/source-adapters.md) requires
 * that source adapters write ONLY to Momentum's local durable source tables and
 * never own Goal / Iteration / Job state, never touch git, and never perform or
 * queue automatic external writes. The existing source-reconciliation tests
 * assert the positive durable writes (source_items / source_snapshots /
 * source_reconciliation_runs) and the dry-run no-write path, but nothing pins the
 * negative side: that an actual reconciliation leaves every execution-state and
 * external-write table untouched. These tests close that gap.
 */

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-source-read-only-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeLinearIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides["id"] ?? "issue-uuid-1",
    identifier: overrides["identifier"] ?? "NGX-1",
    title: overrides["title"] ?? "Example issue",
    url: overrides["url"] ?? "https://linear.app/team/issue/NGX-1",
    state: overrides["state"] ?? { id: "state-1", name: "In Progress" },
    project: overrides["project"] ?? {
      id: "project-uuid-1",
      key: "PROJ",
      name: "Project One"
    },
    projectMilestone: overrides["projectMilestone"] ?? {
      id: "milestone-uuid-1",
      name: "Milestone One"
    },
    labels: overrides["labels"] ?? { nodes: [] },
    assignee: overrides["assignee"] ?? null,
    priority: overrides["priority"] ?? 0,
    updatedAt: overrides["updatedAt"] ?? "2026-04-01T00:00:00.000Z",
    ...overrides
  };
}

function singlePageClient(issues: readonly unknown[]): LinearReconciliationClient {
  let served = false;
  return {
    fetchPage(_input: LinearReconciliationFetchPageInput): LinearReconciliationFetchPageResult {
      if (served) return { ok: true, page: { issues: [], nextCursor: null } };
      served = true;
      return { ok: true, page: { issues, nextCursor: null } };
    }
  };
}

function countRows(db: MomentumDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number | bigint;
  };
  return Number(row.count);
}

// Tables the source reconciliation adapter is the durable owner of (M5 contract).
const SOURCE_TABLES = [
  "source_items",
  "source_snapshots",
  "source_reconciliation_runs"
] as const;

// Execution-state and external-write tables a read-only source adapter must
// never write to. Reconciliation must leave every one of these empty.
const FORBIDDEN_TABLES = [
  // Goal / Iteration / Job execution state.
  "goals",
  "jobs",
  "events",
  // Workflow-first execution state.
  "workflow_runs",
  "workflow_steps",
  "workflow_approvals",
  "workflow_leases",
  "workflow_definitions",
  "step_definitions",
  "workflow_gates",
  // Executor-loop state.
  "executor_definitions",
  "executor_invocations",
  "executor_rounds",
  "executor_artifacts",
  "executor_checkpoints",
  "executor_findings",
  "executor_decisions",
  // External-write surfaces. The M6 write path is a separate adapter; M5
  // reconciliation must never queue an update intent or an apply audit.
  "update_intents",
  "intent_apply_audits",
  // Other runtime substrate the adapter has no business touching.
  "repo_locks",
  "daemon_runs",
  "evidence_records"
] as const;

describe("reconcileLinearSource read-only invariants (NGX-369)", () => {
  it("writes only to the source_* tables and leaves every execution-state and external-write table empty", async () => {
    const db = openDb(makeTempDir());
    try {
      // Exercise the busiest durable-write paths against a single db: create,
      // then update, then skip + per-item error, then dry-run.
      await reconcileLinearSource(db, {
        client: singlePageClient([
          makeLinearIssue({ id: "issue-a", identifier: "NGX-1", updatedAt: 1_000 }),
          makeLinearIssue({ id: "issue-b", identifier: "NGX-2", updatedAt: 1_000 })
        ])
      });
      // Update pass: newer observedAt -> upsert + a fresh snapshot for issue-a.
      await reconcileLinearSource(db, {
        client: singlePageClient([
          makeLinearIssue({ id: "issue-a", identifier: "NGX-1", updatedAt: 2_000 })
        ])
      });
      // Stale issue-a (skipped, no write) alongside a malformed issue (per-item error, no write).
      await reconcileLinearSource(db, {
        client: singlePageClient([
          makeLinearIssue({ id: "issue-a", identifier: "NGX-1", updatedAt: 500 }),
          { id: "broken-missing-required-fields" }
        ])
      });
      // Dry-run never persists items or snapshots, but still records the run.
      await reconcileLinearSource(db, {
        client: singlePageClient([makeLinearIssue({ id: "issue-c", identifier: "NGX-3" })]),
        dryRun: true
      });

      // The adapter IS the durable owner of these: they must be populated.
      expect(countRows(db, "source_items")).toBe(2); // issue-a, issue-b (issue-c was dry-run only)
      expect(countRows(db, "source_snapshots")).toBe(3); // 2 creates + 1 update
      expect(countRows(db, "source_reconciliation_runs")).toBe(4); // one row per invocation, incl. dry-run

      // Read-only invariant: no Goal/Workflow/executor execution rows were
      // created, and no external write was queued.
      for (const table of FORBIDDEN_TABLES) {
        expect(
          countRows(db, table),
          `reconciliation must not write to ${table}`
        ).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("performs no git operations and writes no artifact files outside the SQLite database", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      await reconcileLinearSource(db, {
        client: singlePageClient([
          makeLinearIssue({ id: "issue-a", identifier: "NGX-1" }),
          makeLinearIssue({ id: "issue-b", identifier: "NGX-2" })
        ])
      });

      // The adapter must not initialize or mutate a git repository.
      expect(fs.existsSync(path.join(dataDir, ".git"))).toBe(false);

      // The only durable footprint is the SQLite database (and its own sidecar
      // files such as -wal / -shm / -journal); no stray adapter artifacts.
      for (const entry of fs.readdirSync(dataDir)) {
        expect(
          entry.startsWith("momentum.db"),
          `reconciliation wrote an unexpected file outside the SQLite database: ${entry}`
        ).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("hands the external client only a read-shaped page request (cursor + filters, no write surface)", async () => {
    const db = openDb(makeTempDir());
    try {
      const inputs: LinearReconciliationFetchPageInput[] = [];
      const client: LinearReconciliationClient = {
        fetchPage(input) {
          inputs.push(input);
          return { ok: true, page: { issues: [], nextCursor: null } };
        }
      };

      await reconcileLinearSource(db, { client, filters: { projectId: "p1" } });

      expect(inputs).toHaveLength(1);
      // The adapter's sole outward surface is a read request: exactly a pagination
      // cursor plus read filters, with no db handle or mutation callback that
      // could drive an external or execution-state write.
      expect(Object.keys(inputs[0] ?? {}).sort()).toEqual(["cursor", "filters"]);
      expect(inputs[0]?.cursor).toBeNull();
    } finally {
      db.close();
    }
  });

  it("keeps the durable source table set disjoint from the forbidden execution/write table set", () => {
    // Guards the test fixture itself: a table can never be asserted both written
    // and forbidden, so the invariant above cannot be silently weakened.
    for (const sourceTable of SOURCE_TABLES) {
      expect(FORBIDDEN_TABLES).not.toContain(sourceTable);
    }
  });
});
