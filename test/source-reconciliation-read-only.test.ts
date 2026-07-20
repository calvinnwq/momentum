import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFetchPageInput,
  type LinearReconciliationFetchPageResult
} from "../src/core/source/reconciliation.js";

/**
 * NGX-369 read-only invariant proof for the Linear source reconciliation adapter.
 *
 * The source-adapters contract (SPEC.md) requires
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

function tableRows(db: MomentumDb, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<
    Record<string, unknown>
  >;
}

function snapshotTables(
  db: MomentumDb,
  tables: readonly string[]
): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(tables.map((table) => [table, tableRows(db, table)]));
}

// Tables the source reconciliation adapter is the durable owner of (M5 contract).
const SOURCE_TABLES = [
  "source_items",
  "source_snapshots",
  "source_reconciliation_runs"
] as const;

// Execution-state and external-write tables a read-only source adapter must
// never write to. Reconciliation must leave preexisting rows unchanged.
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
  "executor_attempts",
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

function seedForbiddenTables(db: MomentumDb): void {
  db.exec(`
    INSERT INTO goals
      (id, title, repo, runner, branch, artifact_dir, created_at, updated_at)
      VALUES
      ('goal_existing', 'Existing goal', '/repo', 'fake', 'main', '/artifacts', 1000, 1000);

    INSERT INTO jobs
      (id, goal_id, type, iteration, state, artifact_path, created_at, updated_at)
      VALUES
      ('job_existing', 'goal_existing', 'foreground_iteration', 1, 'pending', '/artifacts/job', 1001, 1001);

    INSERT INTO events
      (goal_id, job_id, type, payload, created_at)
      VALUES
      ('goal_existing', 'job_existing', 'goal_created', '{}', 1002);

    INSERT INTO repo_locks
      (id, repo_root, holder, goal_id, iteration, job_id, state, acquired_at, heartbeat_at, lease_expires_at, updated_at)
      VALUES
      ('repo_lock_existing', '/repo', 'worker-1', 'goal_existing', 1, 'job_existing', 'active', 1003, 1003, 2003, 1003);

    INSERT INTO daemon_runs
      (id, pid, host, state, started_at, heartbeat_at, last_state_change_at, updated_at)
      VALUES
      ('daemon_existing', 12345, 'localhost', 'running', 1004, 1004, 1004, 1004);

    INSERT INTO workflow_definitions
      (key, version, title, created_at, updated_at)
      VALUES
      ('workflow_existing', 1, 'Existing workflow', 1005, 1005);

    INSERT INTO step_definitions
      (definition_key, definition_version, step_key, kind, executor, step_order, created_at, updated_at)
      VALUES
      ('workflow_existing', 1, 'step_existing', 'preflight', 'manual', 1, 1006, 1006);

    INSERT INTO workflow_runs
      (id, state, goal_id, source, workflow_definition_key, workflow_definition_version, created_at, updated_at)
      VALUES
      ('workflow_run_existing', 'running', 'goal_existing', 'imported', 'workflow_existing', 1, 1007, 1007);

    INSERT INTO workflow_steps
      (run_id, step_id, kind, state, step_order, created_at, updated_at)
      VALUES
      ('workflow_run_existing', 'step_existing', 'preflight', 'running', 1, 1008, 1008);

    INSERT INTO workflow_approvals
      (run_id, boundary, actor, phrase, artifact_path, artifact_digest, recorded_at, created_at, updated_at)
      VALUES
      ('workflow_run_existing', 'before_apply', 'operator', 'approve', '/artifact/approval', 'digest-approval', 1009, 1009, 1009);

    INSERT INTO workflow_leases
      (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at, created_at, updated_at)
      VALUES
      ('workflow_run_existing', 'execution', 'worker-1', 1010, 2010, 1010, 1010, 1010);

    INSERT INTO executor_definitions
      (executor_key, family, agent_provider, model, created_at, updated_at)
      VALUES
      ('executor_existing', 'manual', 'operator', 'none', 1011, 1011);

    INSERT INTO executor_attempts
      (attempt_id, workflow_run_id, step_run_id, step_key, executor_family, state, created_at, updated_at)
      VALUES
      ('invocation_existing', 'workflow_run_existing', 'step_existing', 'step_existing', 'manual', 'running', 1012, 1012);

    INSERT INTO executor_rounds
      (round_id, attempt_id, workflow_run_id, step_run_id, step_key, executor_family, round_index, state, created_at, updated_at)
      VALUES
      ('round_existing', 'invocation_existing', 'workflow_run_existing', 'step_existing', 'step_existing', 'manual', 0, 'running', 1013, 1013);

    INSERT INTO executor_artifacts
      (artifact_id, round_id, artifact_class, path, digest, created_at)
      VALUES
      ('artifact_existing', 'round_existing', 'log', '/artifact/log', 'digest-log', 1014);

    INSERT INTO executor_checkpoints
      (checkpoint_id, round_id, sequence, stage, detail, created_at)
      VALUES
      ('checkpoint_existing', 'round_existing', 1, 'started', 'checkpoint detail', 1015);

    INSERT INTO executor_findings
      (finding_id, round_id, severity, title, detail, selected, created_at)
      VALUES
      ('finding_existing', 'round_existing', 'warning', 'Existing finding', 'finding detail', 1, 1016);

    INSERT INTO executor_decisions
      (decision_id, round_id, summary, allowed_actions, recommended_action, created_at)
      VALUES
      ('decision_existing', 'round_existing', 'Existing decision', '["continue"]', 'continue', 1017);

    INSERT INTO workflow_gates
      (gate_id, workflow_run_id, step_run_id, attempt_id, round_id, target_scope, gate_type, reason, allowed_actions, policy_envelope, created_at, updated_at)
      VALUES
      ('gate_existing', 'workflow_run_existing', 'step_existing', 'invocation_existing', 'round_existing', 'round', 'operator', 'Existing gate', '["continue"]', '[]', 1018, 1018);

    INSERT INTO evidence_records
      (id, source, type, occurred_at, summary, goal_id, ingest_key, created_at, updated_at)
      VALUES
      ('evidence_existing', 'manual', 'note', 1019, 'Existing evidence', 'goal_existing', 'evidence-existing', 1019, 1019);

    INSERT INTO update_intents
      (id, adapter_kind, target_external_id, intent_type, reason, goal_id, evidence_record_id, idempotency_key, created_at, updated_at)
      VALUES
      ('intent_existing', 'linear', 'issue-existing', 'comment', 'Existing intent', 'goal_existing', 'evidence_existing', 'intent-existing', 1020, 1020);

    INSERT INTO intent_apply_audits
      (id, intent_id, adapter_kind, provider, requested_at, operator_reason, intent_apply_policy, mutation_kind, preview_summary, idempotency_marker, lifecycle_state, created_at, updated_at)
      VALUES
      ('audit_existing', 'intent_existing', 'linear', 'linear', 1021, 'Existing audit', 'manual', 'comment', 'Preview', 'audit-existing', 'claimed', 1021, 1021);
  `);
}

describe("reconcileLinearSource read-only invariants (NGX-369)", () => {
  it("writes only to the source_* tables and leaves every execution-state and external-write table unchanged", async () => {
    const db = openDb(makeTempDir());
    try {
      seedForbiddenTables(db);
      const forbiddenBefore = snapshotTables(db, FORBIDDEN_TABLES);

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

      for (const table of FORBIDDEN_TABLES) {
        expect(
          tableRows(db, table),
          `reconciliation must leave ${table} unchanged`
        ).toEqual(forbiddenBefore[table]);
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
