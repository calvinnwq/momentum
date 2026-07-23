import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, openExistingDbMigratedReadOnly } from "../src/adapters/db.js";
import { applyQueueMigrations } from "../src/adapters/db/migrations.js";
import { startRetryableDispatchAttempt } from "../src/core/workflow/dispatch/retry.js";
import { selectRunnableWorkflowWork } from "../src/core/workflow/dispatch/scheduler.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-migrations-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

type ColumnInfo = { name: string; type: string; notnull: number };

function getColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("applyQueueMigrations", () => {
  it("creates jobs queue columns, repo_locks, and indexes on a fresh data dir", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const jobColumns = getColumns(db, "jobs").map((row) => row.name);
      for (const col of [
        "id",
        "goal_id",
        "type",
        "iteration",
        "state",
        "attempt_count",
        "artifact_path",
        "idempotency_key",
        "worker_id",
        "lease_acquired_at",
        "lease_expires_at",
        "heartbeat_at",
        "result_path",
        "error_path",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
        "error",
      ]) {
        expect(jobColumns, `missing jobs column: ${col}`).toContain(col);
      }

      expect(tableNames(db)).toContain("repo_locks");
      const lockColumns = getColumns(db, "repo_locks").map((row) => row.name);
      for (const col of [
        "id",
        "repo_root",
        "holder",
        "goal_id",
        "iteration",
        "job_id",
        "state",
        "recovery_status",
        "acquired_at",
        "heartbeat_at",
        "lease_expires_at",
        "released_at",
        "updated_at",
      ]) {
        expect(lockColumns, `missing repo_locks column: ${col}`).toContain(col);
      }

      expect(tableNames(db)).toContain("daemon_runs");
      expect(tableNames(db)).toContain("source_items");
      expect(tableNames(db)).toContain("source_snapshots");
      expect(tableNames(db)).toContain("source_reconciliation_runs");
      expect(tableNames(db)).toContain("evidence_records");
      expect(tableNames(db)).toContain("update_intents");

      const updateIntentColumns = getColumns(db, "update_intents").map(
        (row) => row.name,
      );
      for (const col of [
        "id",
        "adapter_kind",
        "target_external_id",
        "intent_type",
        "payload_json",
        "reason",
        "goal_id",
        "source_item_id",
        "evidence_record_id",
        "status",
        "idempotency_key",
        "decision_reason",
        "error_code",
        "error_message",
        "created_at",
        "updated_at",
        "applied_at",
        "skipped_at",
        "canceled_at",
      ]) {
        expect(
          updateIntentColumns,
          `missing update_intents column: ${col}`,
        ).toContain(col);
      }

      const evidenceColumns = getColumns(db, "evidence_records").map(
        (row) => row.name,
      );
      for (const col of [
        "id",
        "source",
        "type",
        "format_version",
        "artifact_path",
        "external_id",
        "occurred_at",
        "summary",
        "metadata_json",
        "goal_id",
        "source_item_id",
        "run_id",
        "step_id",
        "ingest_key",
        "created_at",
        "updated_at",
      ]) {
        expect(
          evidenceColumns,
          `missing evidence_records column: ${col}`,
        ).toContain(col);
      }

      const sourceItemColumns = getColumns(db, "source_items").map(
        (row) => row.name,
      );
      for (const col of [
        "id",
        "adapter_kind",
        "external_id",
        "external_key",
        "url",
        "title",
        "status",
        "metadata_json",
        "last_observed_at",
        "goal_id",
        "created_at",
        "updated_at",
      ]) {
        expect(
          sourceItemColumns,
          `missing source_items column: ${col}`,
        ).toContain(col);
      }

      const daemonColumns = getColumns(db, "daemon_runs").map(
        (row) => row.name,
      );
      for (const col of [
        "id",
        "pid",
        "host",
        "state",
        "started_at",
        "heartbeat_at",
        "last_state_change_at",
        "finished_at",
        "active_job_id",
        "active_lock_id",
        "stop_requested_at",
        "stop_reason",
        "reconcile_count",
        "last_reconciled_at",
        "error",
        "error_at",
        "updated_at",
      ]) {
        expect(daemonColumns, `missing daemon_runs column: ${col}`).toContain(
          col,
        );
      }

      const indexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toContain("idx_jobs_idempotency_key");
      expect(indexes).toContain("idx_repo_locks_active_root");
      expect(indexes).toContain("idx_daemon_runs_state");
      expect(indexes).toContain("idx_daemon_runs_heartbeat_at");
      expect(indexes).toContain("idx_daemon_runs_one_active");
      expect(indexes).toContain("idx_evidence_records_ingest_key");
      expect(indexes).toContain("idx_evidence_records_goal");
      expect(indexes).toContain("idx_evidence_records_source_item");
      expect(indexes).toContain("idx_evidence_records_source_type");
      expect(indexes).toContain("idx_evidence_records_occurred_at");
      expect(indexes).toContain("idx_evidence_records_run_step");
      expect(indexes).toContain("idx_update_intents_idempotency_key");
      expect(indexes).toContain("idx_update_intents_status");
      expect(indexes).toContain("idx_update_intents_goal");
      expect(indexes).toContain("idx_update_intents_source_item");
      expect(indexes).toContain("idx_update_intents_evidence");
      expect(indexes).toContain("idx_update_intents_adapter_target");
      expect(indexes).toContain("idx_update_intents_created_at");
      expect(indexes).toContain("idx_workflow_events_run_cursor");

      expect(
        updateIntentColumns,
        "missing update_intents column: apply_state",
      ).toContain("apply_state");

      expect(tableNames(db)).toContain("intent_apply_audits");
      expect(tableNames(db)).toContain("workflow_events");
      const workflowEventColumns = getColumns(db, "workflow_events").map(
        (row) => row.name,
      );
      for (const col of [
        "event_id",
        "run_id",
        "step_id",
        "occurred_at",
        "type",
        "payload_json",
        "created_at",
      ]) {
        expect(
          workflowEventColumns,
          `missing workflow_events column: ${col}`,
        ).toContain(col);
      }
      const auditColumns = getColumns(db, "intent_apply_audits").map(
        (row) => row.name,
      );
      for (const col of [
        "id",
        "intent_id",
        "adapter_kind",
        "provider",
        "external_target_external_id",
        "external_target_external_key",
        "external_target_url",
        "external_target_title",
        "requested_at",
        "finished_at",
        "operator_reason",
        "operator_actor",
        "intent_apply_policy",
        "allow_status_mutation",
        "mutation_kind",
        "preview_summary",
        "idempotency_marker",
        "lifecycle_state",
        "result_status",
        "result_code",
        "result_message",
        "external_ref_comment_id",
        "external_ref_comment_url",
        "external_ref_state_transition_id",
        "reconcile_status",
        "reconcile_warning",
        "created_at",
        "updated_at",
      ]) {
        expect(
          auditColumns,
          `missing intent_apply_audits column: ${col}`,
        ).toContain(col);
      }
      expect(indexes).toContain("idx_intent_apply_audits_intent_id");
      expect(indexes).toContain("idx_intent_apply_audits_lifecycle_state");
      expect(indexes).toContain("idx_intent_apply_audits_finished_at");
      expect(indexes).toContain("idx_intent_apply_audits_created_at");
      expect(indexes).toContain("idx_intent_apply_audits_active");
    } finally {
      db.close();
    }
  });

  it("does not persist credentials or request headers on intent_apply_audits", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const auditColumns = getColumns(db, "intent_apply_audits").map((row) =>
        row.name.toLowerCase(),
      );
      const forbidden = [
        "credential",
        "credentials",
        "token",
        "secret",
        "api_key",
        "apikey",
        "authorization",
        "auth_header",
        "request_headers",
        "headers",
      ];
      for (const col of auditColumns) {
        for (const banned of forbidden) {
          expect(
            col,
            `intent_apply_audits should not include credential/header column "${col}"`,
          ).not.toContain(banned);
        }
      }
    } finally {
      db.close();
    }
  });

  it("migrates a pre-M6 update_intents schema by adding apply_state and the audit ledger", () => {
    const dataDir = makeTempDir();
    const dbPath = path.join(dataDir, "momentum.db");
    const pre = new DatabaseSync(dbPath);
    try {
      pre.exec(`
        CREATE TABLE goals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          repo TEXT,
          runner TEXT NOT NULL DEFAULT 'fake',
          branch TEXT NOT NULL,
          max_iterations INTEGER NOT NULL DEFAULT 1,
          verification TEXT NOT NULL DEFAULT '[]',
          verification_timeout_sec INTEGER NOT NULL DEFAULT 900,
          state TEXT NOT NULL DEFAULT 'initialized',
          artifact_dir TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'foreground_iteration',
          iteration INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          artifact_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error TEXT
        ) STRICT;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL,
          job_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE update_intents (
          id TEXT PRIMARY KEY,
          adapter_kind TEXT NOT NULL,
          target_external_id TEXT,
          intent_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          reason TEXT NOT NULL,
          goal_id TEXT,
          source_item_id TEXT,
          evidence_record_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          idempotency_key TEXT NOT NULL,
          decision_reason TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          applied_at INTEGER,
          skipped_at INTEGER,
          canceled_at INTEGER
        ) STRICT;
      `);
      pre
        .prepare(
          `INSERT INTO update_intents
           (id, adapter_kind, intent_type, payload_json, reason,
            status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          "intent_legacy_1",
          "linear",
          "source_satisfied",
          "{}",
          "preserved",
          "legacy-key-1",
          1,
          2,
        );
    } finally {
      pre.close();
    }

    const upgraded = openDb(dataDir);
    try {
      const updateIntentCols = getColumns(upgraded, "update_intents").map(
        (row) => row.name,
      );
      expect(updateIntentCols).toContain("apply_state");
      expect(tableNames(upgraded)).toContain("intent_apply_audits");
      const preserved = upgraded
        .prepare(
          `SELECT id, status, apply_state, reason
             FROM update_intents WHERE id = 'intent_legacy_1'`,
        )
        .get() as {
        id: string;
        status: string;
        apply_state: string;
        reason: string;
      };
      expect(preserved.id).toBe("intent_legacy_1");
      expect(preserved.status).toBe("pending");
      expect(preserved.apply_state).toBe("idle");
      expect(preserved.reason).toBe("preserved");
    } finally {
      upgraded.close();
    }
  });

  it("adds typed run/step linkage columns to a pre-NGX-329 evidence_records schema without dropping rows", () => {
    const dataDir = makeTempDir();
    const dbPath = path.join(dataDir, "momentum.db");
    const pre = new DatabaseSync(dbPath);
    try {
      // Mirror the M5 (pre-typed-linkage) evidence_records shape.
      pre.exec(`
        CREATE TABLE evidence_records (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          format_version INTEGER NOT NULL DEFAULT 1,
          artifact_path TEXT,
          external_id TEXT,
          occurred_at INTEGER NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          goal_id TEXT,
          source_item_id TEXT,
          ingest_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      pre
        .prepare(
          `INSERT INTO evidence_records
           (id, source, type, format_version, artifact_path, external_id,
            occurred_at, summary, metadata_json, ingest_key,
            created_at, updated_at)
         VALUES ('evidence_record_legacy', 'agent-workflow', 'plan_created', 1,
                 '/tmp/.agent-workflows/cwfp-legacy/plan.json', 'cwfp-legacy',
                 1000, 'Legacy plan', '{}',
                 'agent-workflow:cwfp-legacy:plan_created', 1, 2)`,
        )
        .run();
    } finally {
      pre.close();
    }

    const upgraded = openDb(dataDir);
    try {
      const cols = getColumns(upgraded, "evidence_records").map(
        (row) => row.name,
      );
      expect(cols).toContain("run_id");
      expect(cols).toContain("step_id");

      const byName = new Map(
        getColumns(upgraded, "evidence_records").map((row) => [row.name, row]),
      );
      // Typed linkage is additive and nullable.
      expect(byName.get("run_id")?.notnull).toBe(0);
      expect(byName.get("step_id")?.notnull).toBe(0);

      const preserved = upgraded
        .prepare(
          `SELECT id, source, type, external_id, run_id, step_id
             FROM evidence_records WHERE id = 'evidence_record_legacy'`,
        )
        .get() as Record<string, unknown>;
      expect(preserved["id"]).toBe("evidence_record_legacy");
      expect(preserved["source"]).toBe("agent-workflow");
      expect(preserved["type"]).toBe("plan_created");
      expect(preserved["external_id"]).toBe("cwfp-legacy");
      // Existing rows read with null typed linkage.
      expect(preserved["run_id"]).toBeNull();
      expect(preserved["step_id"]).toBeNull();

      const indexes = (
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toContain("idx_evidence_records_run_step");
    } finally {
      upgraded.close();
    }
  });

  it("typed-linkage column upgrade is idempotent across repeated openDb attempts", () => {
    const dataDir = makeTempDir();
    const a = openDb(dataDir);
    const beforeCols = getColumns(a, "evidence_records").length;
    a.close();

    const b = openDb(dataDir);
    try {
      expect(getColumns(b, "evidence_records")).toHaveLength(beforeCols);
    } finally {
      b.close();
    }
  });

  it("is idempotent across repeated openDb attempts", () => {
    const dataDir = makeTempDir();
    const a = openDb(dataDir);
    const beforeJobsCols = getColumns(a, "jobs").length;
    const beforeLockCols = getColumns(a, "repo_locks").length;
    const beforeDaemonCols = getColumns(a, "daemon_runs").length;
    a.close();

    const b = openDb(dataDir);
    try {
      expect(getColumns(b, "jobs")).toHaveLength(beforeJobsCols);
      expect(getColumns(b, "repo_locks")).toHaveLength(beforeLockCols);
      expect(getColumns(b, "daemon_runs")).toHaveLength(beforeDaemonCols);
    } finally {
      b.close();
    }
  });

  it("migrates an existing Milestone 1-style data dir without dropping rows", () => {
    const dataDir = makeTempDir();
    const dbPath = path.join(dataDir, "momentum.db");
    const m1 = new DatabaseSync(dbPath);
    try {
      // Mirror the Milestone 1 schema literally to simulate an upgraded data dir.
      m1.exec(`
        CREATE TABLE goals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          repo TEXT,
          runner TEXT NOT NULL DEFAULT 'fake',
          branch TEXT NOT NULL,
          max_iterations INTEGER NOT NULL DEFAULT 1,
          verification TEXT NOT NULL DEFAULT '[]',
          verification_timeout_sec INTEGER NOT NULL DEFAULT 900,
          state TEXT NOT NULL DEFAULT 'initialized',
          artifact_dir TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goals(id),
          type TEXT NOT NULL DEFAULT 'foreground_iteration',
          iteration INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          artifact_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error TEXT
        ) STRICT;

        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL,
          job_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      m1.prepare(
        `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("g1", "Legacy goal", "momentum/legacy", "/tmp/legacy", 1, 2);
      m1.prepare(
        `INSERT INTO jobs (id, goal_id, artifact_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("j1", "g1", "/tmp/legacy/iterations/1", 3, 4);
      m1.prepare(
        `INSERT INTO events (goal_id, type, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run("g1", "iteration_started", "{}", 5);
    } finally {
      m1.close();
    }

    const upgraded = openDb(dataDir);
    try {
      const goal = upgraded
        .prepare("SELECT id, title FROM goals WHERE id = 'g1'")
        .get() as { id: string; title: string };
      expect(goal.title).toBe("Legacy goal");

      const job = upgraded
        .prepare(
          "SELECT id, idempotency_key, worker_id FROM jobs WHERE id = 'j1'",
        )
        .get() as Record<string, unknown>;
      expect(job["id"]).toBe("j1");
      expect(job["idempotency_key"]).toBeNull();
      expect(job["worker_id"]).toBeNull();

      expect(tableNames(upgraded)).toContain("repo_locks");
      expect(tableNames(upgraded)).toContain("daemon_runs");

      const events = upgraded
        .prepare("SELECT count(*) AS c FROM events")
        .get() as { c: number };
      expect(events.c).toBe(1);
    } finally {
      upgraded.close();
    }
  });

  it("enforces the partial unique index on jobs.idempotency_key", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES ('g', 't', 'b', '/tmp/x', 1, 1)`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO jobs
           (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, idempotency_key, created_at, updated_at)
         VALUES (?, 'g', 'goal_iteration', 1, 'pending', 0,
                 '/tmp/x/it/1', ?, 1, 1)`,
      );
      insert.run("a", "key-1");
      insert.run("b", null);
      insert.run("c", null);
      expect(() => insert.run("d", "key-1")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("enforces the partial unique index on active repo_locks.repo_root", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const insert = db.prepare(
        `INSERT INTO repo_locks
           (id, repo_root, holder, goal_id, iteration, job_id,
            state, acquired_at, heartbeat_at, lease_expires_at, updated_at)
         VALUES (?, ?, 'h', 'g', 1, 'j', ?, 1, 1, 100, 1)`,
      );
      insert.run("l1", "/tmp/repo", "active");
      expect(() => insert.run("l2", "/tmp/repo", "active")).toThrow(/UNIQUE/);
      // released leases do not collide with active ones
      insert.run("l3", "/tmp/repo", "released");
    } finally {
      db.close();
    }
  });

  it("enforces the unique index on update_intents.idempotency_key", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const insert = db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, intent_type, payload_json, reason,
            status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, '{}', ?, 'pending', ?, 1, 1)`,
      );
      insert.run("i1", "linear", "source_satisfied", "first", "key-1");
      expect(() =>
        insert.run("i2", "linear", "source_satisfied", "duplicate", "key-1"),
      ).toThrow(/UNIQUE/);
      // distinct keys do not collide
      insert.run("i3", "linear", "source_satisfied", "second", "key-2");
    } finally {
      db.close();
    }
  });

  it("creates the update_intents table idempotently across openDb reopens", () => {
    const dataDir = makeTempDir();
    const a = openDb(dataDir);
    const intentColsBefore = getColumns(a, "update_intents").length;
    a.close();

    const b = openDb(dataDir);
    try {
      expect(getColumns(b, "update_intents")).toHaveLength(intentColsBefore);
    } finally {
      b.close();
    }
  });

  it("applyQueueMigrations is callable directly and tolerates empty Milestone 1 schemas", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'foreground_iteration',
          iteration INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          artifact_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error TEXT
        ) STRICT;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL,
          job_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      applyQueueMigrations(db);
      // calling twice should be a no-op
      applyQueueMigrations(db);
      expect(getColumns(db, "jobs").map((c) => c.name)).toContain(
        "idempotency_key",
      );
      expect(tableNames(db)).toContain("repo_locks");
      expect(tableNames(db)).toContain("daemon_runs");
    } finally {
      db.close();
    }
  });

  describe("M7 workflow run substrate (NGX-313)", () => {
    it("creates workflow_runs with the contract columns", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("workflow_runs");
        const cols = getColumns(db, "workflow_runs").map((row) => row.name);
        for (const col of [
          "id",
          "state",
          "goal_id",
          "source",
          "source_artifact_path",
          "plan_json",
          "monitor_last_seen_state",
          "monitor_terminal",
          "monitor_step",
          "monitor_last_seen_digest",
          "monitor_last_emitted_digest",
          "monitor_last_seen_at",
          "monitor_last_emitted_at",
          "batch_group",
          "batch_role",
          "needs_manual_recovery",
          "manual_recovery_reason",
          "manual_recovery_at",
          "started_at",
          "finished_at",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing workflow_runs column: ${col}`).toContain(col);
        }
      } finally {
        db.close();
      }
    });

    it("creates workflow_steps keyed on (run_id, step_id) with terminal-evidence columns", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("workflow_steps");
        const cols = getColumns(db, "workflow_steps").map((row) => row.name);
        for (const col of [
          "run_id",
          "step_id",
          "kind",
          "state",
          "step_order",
          "required",
          "ledger_offset",
          "result_digest",
          "error_code",
          "error_message",
          "started_at",
          "finished_at",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing workflow_steps column: ${col}`).toContain(col);
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r1', 'pending', 'agent-workflows', '{}', 0, 1, 1)`,
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_steps
             (run_id, step_id, kind, state, step_order, required,
              created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, 1, 1, 1)`,
        );
        insert.run("cwfp-r1", "s1", "preflight", 1);
        // composite primary key rejects duplicates on (run_id, step_id)
        expect(() => insert.run("cwfp-r1", "s1", "implementation", 2)).toThrow(
          /UNIQUE|PRIMARY KEY/i,
        );
        // distinct step_id under the same run is fine
        insert.run("cwfp-r1", "s2", "implementation", 2);
      } finally {
        db.close();
      }
    });

    it("creates workflow_approvals keyed on (run_id, boundary) with artifact digest", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("workflow_approvals");
        const cols = getColumns(db, "workflow_approvals").map(
          (row) => row.name,
        );
        for (const col of [
          "run_id",
          "boundary",
          "actor",
          "phrase",
          "artifact_path",
          "artifact_digest",
          "recorded_at",
          "discharged_at",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing workflow_approvals column: ${col}`).toContain(
            col,
          );
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r2', 'pending', 'agent-workflows', '{}', 0, 1, 1)`,
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_approvals
             (run_id, boundary, actor, phrase, artifact_path,
              artifact_digest, recorded_at, created_at, updated_at)
           VALUES (?, ?, 'op', ?, ?, ?, 1, 1, 1)`,
        );
        insert.run(
          "cwfp-r2",
          "implementation",
          "implementation",
          ".agent-workflows/cwfp-r2/approval-implementation.json",
          "sha256:abc",
        );
        expect(() =>
          insert.run(
            "cwfp-r2",
            "implementation",
            "implementation",
            ".agent-workflows/cwfp-r2/approval-implementation.json",
            "sha256:abc",
          ),
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
      } finally {
        db.close();
      }
    });

    it("creates workflow_leases keyed on (run_id, lease_kind) with stale_policy", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("workflow_leases");
        const cols = getColumns(db, "workflow_leases").map((row) => row.name);
        for (const col of [
          "run_id",
          "lease_kind",
          "holder",
          "acquired_at",
          "expires_at",
          "heartbeat_at",
          "released_at",
          "stale_policy",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing workflow_leases column: ${col}`).toContain(col);
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r3', 'pending', 'agent-workflows', '{}', 0, 1, 1)`,
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_leases
             (run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, stale_policy, created_at, updated_at)
           VALUES (?, ?, ?, 1, 100, 1, 'auto-release', 1, 1)`,
        );
        insert.run(
          "cwfp-r3",
          "monitor",
          "cron:coding-workflow-monitor:cwfp-r3",
        );
        // composite primary key rejects duplicates on (run_id, lease_kind)
        expect(() => insert.run("cwfp-r3", "monitor", "another")).toThrow(
          /UNIQUE|PRIMARY KEY/i,
        );
        // distinct lease kind for the same run is fine
        insert.run("cwfp-r3", "dispatch", "intent-apply");
      } finally {
        db.close();
      }
    });

    it("creates indexes on common workflow lookups", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const indexes = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        for (const idx of [
          "idx_workflow_runs_state",
          "idx_workflow_runs_goal",
          "idx_workflow_runs_batch_group",
          "idx_workflow_runs_needs_manual_recovery",
          "idx_workflow_steps_run",
          "idx_workflow_steps_state",
          "idx_workflow_approvals_run",
          "idx_workflow_leases_run",
          "idx_workflow_leases_expires_at",
        ]) {
          expect(indexes, `missing index: ${idx}`).toContain(idx);
        }
      } finally {
        db.close();
      }
    });

    it("rejects workflow_steps rows whose run_id has no matching workflow_runs row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          db
            .prepare(
              `INSERT INTO workflow_steps
                 (run_id, step_id, kind, state, step_order, required,
                  created_at, updated_at)
               VALUES ('cwfp-missing', 's1', 'preflight', 'pending', 1, 1, 1, 1)`,
            )
            .run(),
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb attempts for workflow tables", () => {
      const dataDir = makeTempDir();
      const a = openDb(dataDir);
      const runCols = getColumns(a, "workflow_runs").length;
      const stepCols = getColumns(a, "workflow_steps").length;
      const approvalCols = getColumns(a, "workflow_approvals").length;
      const leaseCols = getColumns(a, "workflow_leases").length;
      a.close();

      const b = openDb(dataDir);
      try {
        expect(getColumns(b, "workflow_runs")).toHaveLength(runCols);
        expect(getColumns(b, "workflow_steps")).toHaveLength(stepCols);
        expect(getColumns(b, "workflow_approvals")).toHaveLength(approvalCols);
        expect(getColumns(b, "workflow_leases")).toHaveLength(leaseCols);
      } finally {
        b.close();
      }
    });

    it("adds workflow tables to a pre-M7 data dir without dropping existing rows", () => {
      const dataDir = makeTempDir();
      const dbPath = path.join(dataDir, "momentum.db");
      const pre = new DatabaseSync(dbPath);
      try {
        pre.exec(`
          CREATE TABLE goals (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            repo TEXT,
            runner TEXT NOT NULL DEFAULT 'fake',
            branch TEXT NOT NULL,
            max_iterations INTEGER NOT NULL DEFAULT 1,
            verification TEXT NOT NULL DEFAULT '[]',
            verification_timeout_sec INTEGER NOT NULL DEFAULT 900,
            state TEXT NOT NULL DEFAULT 'initialized',
            artifact_dir TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'foreground_iteration',
            iteration INTEGER NOT NULL DEFAULT 1,
            state TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            artifact_path TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            error TEXT
          ) STRICT;
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id TEXT NOT NULL,
            job_id TEXT,
            type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
          ) STRICT;
        `);
        pre
          .prepare(
            `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("g-pre-m7", "pre-m7 goal", "main", "/tmp/pre-m7", 1, 2);
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        expect(tableNames(upgraded)).toContain("workflow_runs");
        expect(tableNames(upgraded)).toContain("workflow_steps");
        expect(tableNames(upgraded)).toContain("workflow_approvals");
        expect(tableNames(upgraded)).toContain("workflow_leases");

        const goal = upgraded
          .prepare("SELECT id, title FROM goals WHERE id = 'g-pre-m7'")
          .get() as { id: string; title: string };
        expect(goal.title).toBe("pre-m7 goal");
      } finally {
        upgraded.close();
      }
    });

    it("does not persist credentials, tokens, headers, or chat content on workflow tables", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const forbidden = [
          "credential",
          "credentials",
          "token",
          "secret",
          "api_key",
          "apikey",
          "authorization",
          "auth_header",
          "request_headers",
          "headers",
          "discord_payload",
          "discord_message",
          "chat_body",
        ];
        for (const table of [
          "workflow_runs",
          "workflow_steps",
          "workflow_approvals",
          "workflow_leases",
        ]) {
          const cols = getColumns(db, table).map((row) =>
            row.name.toLowerCase(),
          );
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/header/chat column "${col}"`,
              ).not.toContain(banned);
            }
          }
        }
      } finally {
        db.close();
      }
    });

    it("exposes WorkflowRun identity columns enumerated by the M7 milestone doc", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const cols = getColumns(db, "workflow_runs");
        const byName = new Map(cols.map((row) => [row.name, row]));
        for (const col of [
          "repo_path",
          "objective",
          "issue_scope_json",
          "route_json",
          "approval_boundary",
          "skill_revision",
        ]) {
          expect(byName.has(col), `missing workflow_runs column: ${col}`).toBe(
            true,
          );
        }
        expect(byName.get("issue_scope_json")?.notnull).toBe(1);
        expect(byName.get("route_json")?.notnull).toBe(1);
        expect(byName.get("repo_path")?.notnull).toBe(0);
        expect(byName.get("objective")?.notnull).toBe(0);
        expect(byName.get("approval_boundary")?.notnull).toBe(0);
        expect(byName.get("skill_revision")?.notnull).toBe(0);

        const indexes = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(indexes).toContain("idx_workflow_runs_repo_path");
      } finally {
        db.close();
      }
    });

    it("defaults issue_scope_json and route_json to empty objects on fresh inserts", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-defaults', 'pending', 'agent-workflows', '{}', 0, 1, 1)`,
        ).run();
        const row = db
          .prepare(
            `SELECT repo_path, objective, issue_scope_json, route_json,
                    approval_boundary, skill_revision,
                    monitor_last_seen_state, monitor_terminal, monitor_step,
                    monitor_last_seen_digest, monitor_last_emitted_digest,
                    monitor_last_seen_at, monitor_last_emitted_at
               FROM workflow_runs WHERE id = 'cwfp-defaults'`,
          )
          .get() as Record<string, unknown>;
        expect(row["repo_path"]).toBeNull();
        expect(row["objective"]).toBeNull();
        expect(row["issue_scope_json"]).toBe("{}");
        expect(row["route_json"]).toBe("{}");
        expect(row["approval_boundary"]).toBeNull();
        expect(row["skill_revision"]).toBeNull();
        expect(row["monitor_last_seen_state"]).toBeNull();
        expect(row["monitor_terminal"]).toBeNull();
        expect(row["monitor_step"]).toBeNull();
        expect(row["monitor_last_seen_digest"]).toBeNull();
        expect(row["monitor_last_emitted_digest"]).toBeNull();
        expect(row["monitor_last_seen_at"]).toBeNull();
        expect(row["monitor_last_emitted_at"]).toBeNull();
      } finally {
        db.close();
      }
    });

    it("upgrades a pre-identity workflow_runs schema additively and preserves rows", () => {
      const dataDir = makeTempDir();
      const dbPath = path.join(dataDir, "momentum.db");
      const pre = new DatabaseSync(dbPath);
      try {
        // Mirror the iteration-2 shape of workflow_runs (no identity columns).
        pre.exec(`
          CREATE TABLE goals (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            branch TEXT NOT NULL,
            artifact_dir TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE workflow_runs (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL DEFAULT 'pending',
            goal_id TEXT,
            source TEXT NOT NULL,
            source_artifact_path TEXT,
            plan_json TEXT NOT NULL DEFAULT '{}',
            batch_group TEXT,
            batch_role TEXT,
            needs_manual_recovery INTEGER NOT NULL DEFAULT 0,
            manual_recovery_reason TEXT,
            manual_recovery_at INTEGER,
            started_at INTEGER,
            finished_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
        `);
        pre
          .prepare(
            `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-legacy', 'pending', 'agent-workflows', '{"legacy":true}',
                   0, 7, 8)`,
          )
          .run();
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        const cols = getColumns(upgraded, "workflow_runs").map(
          (row) => row.name,
        );
        for (const col of [
          "repo_path",
          "objective",
          "issue_scope_json",
          "route_json",
          "approval_boundary",
          "skill_revision",
          "monitor_last_seen_state",
          "monitor_terminal",
          "monitor_step",
          "monitor_last_seen_digest",
          "monitor_last_emitted_digest",
          "monitor_last_seen_at",
          "monitor_last_emitted_at",
        ]) {
          expect(cols).toContain(col);
        }
        const preserved = upgraded
          .prepare(
            `SELECT id, state, plan_json, issue_scope_json, route_json,
                    repo_path, approval_boundary
               FROM workflow_runs WHERE id = 'cwfp-legacy'`,
          )
          .get() as Record<string, unknown>;
        expect(preserved["id"]).toBe("cwfp-legacy");
        expect(preserved["state"]).toBe("pending");
        expect(preserved["plan_json"]).toBe('{"legacy":true}');
        expect(preserved["issue_scope_json"]).toBe("{}");
        expect(preserved["route_json"]).toBe("{}");
        expect(preserved["repo_path"]).toBeNull();
        expect(preserved["approval_boundary"]).toBeNull();
      } finally {
        upgraded.close();
      }
    });

    it("identity-column upgrade is idempotent across repeated openDb attempts", () => {
      const dataDir = makeTempDir();
      const a = openDb(dataDir);
      const beforeCols = getColumns(a, "workflow_runs").length;
      a.close();

      const b = openDb(dataDir);
      try {
        expect(getColumns(b, "workflow_runs")).toHaveLength(beforeCols);
      } finally {
        b.close();
      }
    });
  });

  describe("M10 workflow definition schema (NGX-345)", () => {
    it("creates workflow_definitions keyed on (key, version)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("workflow_definitions");
        const cols = getColumns(db, "workflow_definitions").map(
          (row) => row.name,
        );
        for (const col of [
          "key",
          "version",
          "title",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing workflow_definitions column: ${col}`).toContain(
            col,
          );
        }

        const insert = db.prepare(
          `INSERT INTO workflow_definitions
             (key, version, title, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1)`,
        );
        insert.run("coding-workflow", 1, "OpenClaw Coding Workflow");
        // composite primary key rejects duplicates on (key, version)
        expect(() => insert.run("coding-workflow", 1, "duplicate")).toThrow(
          /UNIQUE|PRIMARY KEY/i,
        );
        // a distinct version of the same key is allowed
        insert.run("coding-workflow", 2, "OpenClaw Coding Workflow v2");
      } finally {
        db.close();
      }
    });

    it("creates step_definitions keyed on (definition_key, definition_version, step_key)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        expect(tableNames(db)).toContain("step_definitions");
        const cols = getColumns(db, "step_definitions").map((row) => row.name);
        for (const col of [
          "definition_key",
          "definition_version",
          "step_key",
          "kind",
          "executor",
          "config_json",
          "step_order",
          "required",
          "created_at",
          "updated_at",
        ]) {
          expect(cols, `missing step_definitions column: ${col}`).toContain(
            col,
          );
        }

        db.prepare(
          `INSERT INTO workflow_definitions
             (key, version, title, created_at, updated_at)
           VALUES ('coding-workflow', 1, 'OpenClaw Coding Workflow', 1, 1)`,
        ).run();
        const insert = db.prepare(
          `INSERT INTO step_definitions
             (definition_key, definition_version, step_key, kind, executor,
              step_order, required, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        );
        insert.run(
          "coding-workflow",
          1,
          "preflight",
          "preflight",
          "one-shot",
          0,
        );
        // composite primary key rejects duplicate step_key within a version
        expect(() =>
          insert.run(
            "coding-workflow",
            1,
            "preflight",
            "preflight",
            "goal-loop",
            9,
          ),
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
        // distinct step_key under the same definition version is fine
        insert.run(
          "coding-workflow",
          1,
          "implementation",
          "implementation",
          "goal-loop",
          1,
        );
      } finally {
        db.close();
      }
    });

    it("adds step definition config in place without dropping legacy rows", () => {
      const dataDir = makeTempDir();
      const dbPath = path.join(dataDir, "momentum.db");
      const legacy = new DatabaseSync(dbPath);
      try {
        legacy.exec(`
          CREATE TABLE workflow_definitions (
            key TEXT NOT NULL,
            version INTEGER NOT NULL,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (key, version)
          ) STRICT;
          CREATE TABLE step_definitions (
            definition_key TEXT NOT NULL,
            definition_version INTEGER NOT NULL,
            step_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            executor TEXT NOT NULL,
            step_order INTEGER NOT NULL,
            required INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (definition_key, definition_version, step_key)
          ) STRICT;
          INSERT INTO workflow_definitions VALUES
            ('coding-workflow', 1, 'Legacy', 1, 1);
          INSERT INTO step_definitions VALUES
            ('coding-workflow', 1, 'implementation', 'implementation',
             'goal-loop', 1, 1, 1, 1);
        `);
      } finally {
        legacy.close();
      }

      const upgraded = openDb(dataDir);
      try {
        expect(
          getColumns(upgraded, "step_definitions").map((row) => row.name),
        ).toContain("config_json");
        expect(
          upgraded
            .prepare(
              `SELECT executor, config_json FROM step_definitions
                WHERE definition_key = 'coding-workflow'
                  AND definition_version = 1
                  AND step_key = 'implementation'`,
            )
            .get(),
        ).toEqual({ executor: "goal-loop", config_json: null });
      } finally {
        upgraded.close();
      }
    });

    it("rejects step_definitions rows whose definition has no matching workflow_definitions row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          db
            .prepare(
              `INSERT INTO step_definitions
                 (definition_key, definition_version, step_key, kind, executor,
                  step_order, required, created_at, updated_at)
               VALUES ('missing-workflow', 1, 'preflight', 'preflight',
                       'one-shot', 0, 1, 1, 1)`,
            )
            .run(),
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("creates the step_definitions definition lookup index", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const indexes = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(indexes).toContain("idx_step_definitions_definition");
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb attempts for definition tables", () => {
      const dataDir = makeTempDir();
      const a = openDb(dataDir);
      const defCols = getColumns(a, "workflow_definitions").length;
      const stepCols = getColumns(a, "step_definitions").length;
      a.close();

      const b = openDb(dataDir);
      try {
        expect(getColumns(b, "workflow_definitions")).toHaveLength(defCols);
        expect(getColumns(b, "step_definitions")).toHaveLength(stepCols);
      } finally {
        b.close();
      }
    });

    it("adds definition tables to a pre-M10 data dir without dropping existing rows", () => {
      const dataDir = makeTempDir();
      const dbPath = path.join(dataDir, "momentum.db");
      const pre = new DatabaseSync(dbPath);
      try {
        pre.exec(`
          CREATE TABLE goals (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            branch TEXT NOT NULL,
            artifact_dir TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
        `);
        pre
          .prepare(
            `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("g-pre-m10", "pre-m10 goal", "main", "/tmp/pre-m10", 1, 2);
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        expect(tableNames(upgraded)).toContain("workflow_definitions");
        expect(tableNames(upgraded)).toContain("step_definitions");
        const goal = upgraded
          .prepare("SELECT id, title FROM goals WHERE id = 'g-pre-m10'")
          .get() as { id: string; title: string };
        expect(goal.title).toBe("pre-m10 goal");
      } finally {
        upgraded.close();
      }
    });

    it("does not persist credential or chat columns on definition tables", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const forbidden = [
          "credential",
          "credentials",
          "token",
          "secret",
          "api_key",
          "apikey",
          "authorization",
          "auth_header",
          "request_headers",
          "headers",
          "chat_body",
        ];
        for (const table of ["workflow_definitions", "step_definitions"]) {
          const cols = getColumns(db, table).map((row) =>
            row.name.toLowerCase(),
          );
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/chat column "${col}"`,
              ).not.toContain(banned);
            }
          }
        }
      } finally {
        db.close();
      }
    });
  });

  describe("M10 executor-loop schema (NGX-347)", () => {
    const EXECUTOR_TABLES = [
      "executor_definitions",
      "executor_attempts",
      "executor_rounds",
      "executor_artifacts",
      "executor_checkpoints",
      "executor_findings",
      "executor_decisions",
    ];

    // Seed the minimal workflow_runs / workflow_steps parents the executor
    // spine FKs hang below.
    function seedRunAndStep(
      db: DatabaseSync,
      runId = "run-x",
      stepId = "step-x",
    ): void {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, plan_json, needs_manual_recovery,
            created_at, updated_at)
         VALUES (?, 'pending', 'agent-workflows', '{}', 0, 1, 1)`,
      ).run(runId);
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, required,
            created_at, updated_at)
         VALUES (?, ?, 'implementation', 'pending', 0, 1, 1, 1)`,
      ).run(runId, stepId);
    }

    function seedAttempt(db: DatabaseSync): void {
      seedRunAndStep(db);
      db.prepare(
        `INSERT INTO executor_attempts
           (attempt_id, workflow_run_id, step_run_id, step_key,
            executor, state, attempt_number, created_at, updated_at)
         VALUES ('inv-x', 'run-x', 'step-x', 'implementation',
                 'agent-loop', 'pending', 1, 1, 1)`,
      ).run();
    }

    it("creates the seven executor-loop tables with the contract columns", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        for (const table of EXECUTOR_TABLES) {
          expect(tableNames(db), `missing table: ${table}`).toContain(table);
        }

        const roundCols = getColumns(db, "executor_rounds").map(
          (row) => row.name,
        );
        // The full contract "Round Schema" identity / execution / result fields.
        for (const col of [
          "round_id",
          "attempt_id",
          "workflow_run_id",
          "step_run_id",
          "step_key",
          "executor",
          "attempt_number",
          "round_index",
          "state",
          "classification",
          "started_at",
          "heartbeat_at",
          "finished_at",
          "agent_provider",
          "model",
          "effort",
          "input_digest",
          "result_digest",
          "artifact_root",
          "log_paths",
          "summary",
          "key_changes",
          "remaining_work",
          "changed_files",
          "verification_status",
          "commit_sha",
          "recovery_code",
          "human_gate",
          "created_at",
          "updated_at",
        ]) {
          expect(roundCols, `missing executor_rounds column: ${col}`).toContain(
            col,
          );
        }

        const attemptCols = getColumns(db, "executor_attempts").map(
          (row) => row.name,
        );
        for (const col of [
          "attempt_id",
          "workflow_run_id",
          "step_run_id",
          "step_key",
          "executor",
          "state",
          "attempt_number",
          "started_at",
          "heartbeat_at",
          "finished_at",
          "created_at",
          "updated_at",
        ]) {
          expect(
            attemptCols,
            `missing executor_attempts column: ${col}`,
          ).toContain(col);
        }

        const definitionCols = getColumns(db, "executor_definitions").map(
          (row) => row.name,
        );
        for (const col of [
          "executor_key",
          "executor",
          "agent_provider",
          "model",
          "effort",
          "timeout_ms",
          "max_rounds",
          "policy_envelope",
          "created_at",
          "updated_at",
        ]) {
          expect(
            definitionCols,
            `missing executor_definitions column: ${col}`,
          ).toContain(col);
        }

        const decisionCols = getColumns(db, "executor_decisions").map(
          (row) => row.name,
        );
        expect(decisionCols).toContain("external_ref");
      } finally {
        db.close();
      }
    });

    it("creates the executor-loop lookup and uniqueness indexes", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const indexes = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        for (const idx of [
          "idx_executor_attempts_run",
          "idx_executor_attempts_step",
          "idx_executor_attempts_state",
          "idx_executor_attempts_step_number",
          "idx_executor_rounds_attempt",
          "idx_executor_rounds_run",
          "idx_executor_rounds_step",
          "idx_executor_rounds_attempt_index",
          "idx_executor_artifacts_round",
          "idx_executor_checkpoints_round",
          "idx_executor_checkpoints_round_sequence",
          "idx_executor_findings_round",
          "idx_executor_decisions_round",
        ]) {
          expect(indexes, `missing index: ${idx}`).toContain(idx);
        }
      } finally {
        db.close();
      }
    });

    it("enforces the unique round ordering per (attempt_id, round_index)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        seedAttempt(db);
        const insertRound = db.prepare(
          `INSERT INTO executor_rounds
             (round_id, attempt_id, workflow_run_id, step_run_id, step_key,
              executor, attempt_number, round_index, state,
              created_at, updated_at)
           VALUES (?, 'inv-x', 'run-x', 'step-x', 'implementation',
                   'agent-loop', 1, ?, 'pending', 1, 1)`,
        );
        insertRound.run("round-a", 0);
        // the same round_index under one attempt collides
        expect(() => insertRound.run("round-b", 0)).toThrow(/UNIQUE/i);
        // a distinct index under the same attempt is fine
        insertRound.run("round-c", 1);
      } finally {
        db.close();
      }
    });

    it("enforces the unique checkpoint stream per (round_id, sequence)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        seedAttempt(db);
        db.prepare(
          `INSERT INTO executor_rounds
             (round_id, attempt_id, workflow_run_id, step_run_id, step_key,
              executor, attempt_number, round_index, state,
              created_at, updated_at)
           VALUES ('round-x', 'inv-x', 'run-x', 'step-x', 'implementation',
                   'agent-loop', 1, 0, 'pending', 1, 1)`,
        ).run();
        const insertCheckpoint = db.prepare(
          `INSERT INTO executor_checkpoints
             (checkpoint_id, round_id, sequence, stage, created_at)
           VALUES (?, 'round-x', ?, 'prepare', 1)`,
        );
        insertCheckpoint.run("c-a", 0);
        expect(() => insertCheckpoint.run("c-b", 0)).toThrow(/UNIQUE/i);
        insertCheckpoint.run("c-c", 1);
      } finally {
        db.close();
      }
    });

    it("rejects an attempt whose (workflow_run_id, step_run_id) has no workflow_steps row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          db
            .prepare(
              `INSERT INTO executor_attempts
                 (attempt_id, workflow_run_id, step_run_id, step_key,
                  executor, state, attempt_number, created_at, updated_at)
               VALUES ('inv-orphan', 'run-missing', 'step-missing',
                       'implementation', 'agent-loop', 'pending', 1, 1, 1)`,
            )
            .run(),
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("rejects a round whose attempt_id has no executor_attempts row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        seedRunAndStep(db);
        expect(() =>
          db
            .prepare(
              `INSERT INTO executor_rounds
                 (round_id, attempt_id, workflow_run_id, step_run_id,
                  step_key, executor, attempt_number, round_index, state,
                  created_at, updated_at)
               VALUES ('round-orphan', 'inv-missing', 'run-x', 'step-x',
                       'implementation', 'agent-loop', 1, 0, 'pending', 1, 1)`,
            )
            .run(),
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("rejects child evidence whose round_id has no executor_rounds row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          db
            .prepare(
              `INSERT INTO executor_artifacts
                 (artifact_id, round_id, artifact_class, path, created_at)
               VALUES ('a-orphan', 'round-missing', 'result_document',
                       '/runs/x/result.json', 1)`,
            )
            .run(),
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb attempts for executor tables", () => {
      const dataDir = makeTempDir();
      const a = openDb(dataDir);
      const before = new Map(
        EXECUTOR_TABLES.map((table) => [table, getColumns(a, table).length]),
      );
      a.close();

      const b = openDb(dataDir);
      try {
        for (const table of EXECUTOR_TABLES) {
          expect(
            getColumns(b, table),
            `column count drifted for ${table}`,
          ).toHaveLength(before.get(table) ?? -1);
        }
      } finally {
        b.close();
      }
    });

    it("adds executor tables to a pre-M10-03 data dir without dropping existing rows", () => {
      const dataDir = makeTempDir();
      const dbPath = path.join(dataDir, "momentum.db");
      const pre = new DatabaseSync(dbPath);
      try {
        pre.exec(`
          CREATE TABLE goals (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            branch TEXT NOT NULL,
            artifact_dir TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
        `);
        pre
          .prepare(
            `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "g-pre-executor",
            "pre-executor goal",
            "main",
            "/tmp/pre-exec",
            1,
            2,
          );
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        for (const table of EXECUTOR_TABLES) {
          expect(tableNames(upgraded), `missing table: ${table}`).toContain(
            table,
          );
        }
        const goal = upgraded
          .prepare("SELECT id, title FROM goals WHERE id = 'g-pre-executor'")
          .get() as { id: string; title: string };
        expect(goal.title).toBe("pre-executor goal");
      } finally {
        upgraded.close();
      }
    });

    it("does not persist credential, token, header, or chat columns on executor tables", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        const forbidden = [
          "credential",
          "credentials",
          "token",
          "secret",
          "api_key",
          "apikey",
          "authorization",
          "auth_header",
          "request_headers",
          "headers",
          "chat_body",
        ];
        for (const table of EXECUTOR_TABLES) {
          const cols = getColumns(db, table).map((row) =>
            row.name.toLowerCase(),
          );
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/header/chat column "${col}"`,
              ).not.toContain(banned);
            }
          }
        }
      } finally {
        db.close();
      }
    });
  });
});

describe("SDK-05 legacy executor-invocation to attempt/round migration", () => {
  const fixturePath = path.join(
    __dirname,
    "fixtures",
    "sdk05-legacy-executor-invocations.sql",
  );

  function seedLegacyDataDir(): string {
    const dataDir = makeTempDir("momentum-sdk05-migration-");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.exec(fs.readFileSync(fixturePath, "utf8"));
    } finally {
      db.close();
    }
    return dataDir;
  }

  it("opens a two-attempt recovered SDK-05 database and splits the legacy invocation into immutable attempts", () => {
    const dataDir = seedLegacyDataDir();
    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).not.toContain("executor_invocations");

      const attempts = db
        .prepare(
          `SELECT attempt_id, workflow_run_id, step_run_id, executor,
                  state, attempt_number, started_at, heartbeat_at, finished_at,
                  legacy_invocation_id, legacy_provenance
             FROM executor_attempts
            WHERE workflow_run_id = 'run-1'
            ORDER BY step_run_id, attempt_number`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(attempts).toHaveLength(4);

      // The legacy fixture lands directly on the renamed executor vocabulary:
      // `one-shot` becomes `agent-once`, while the mirror attempt keeps its
      // legacy `no-mistakes` identity (no durable mirror checkpoint proves the
      // external tool, so it is not converted to delegate-supervisor).
      expect(attempts.map((attempt) => attempt.executor)).toEqual([
        "delegate-supervisor",
        "delegate-supervisor",
        "agent-once",
        "no-mistakes",
      ]);

      const [implFirst, implLatest, preflight, preflightMirror] = attempts as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      // Earlier retry group: derived id, state and timestamps reconstructed
      // from its own terminal rounds, provenance recorded.
      expect(implFirst.attempt_id).toBe(
        "run-1::implementation::dispatch::attempt-1",
      );
      expect(implFirst.attempt_number).toBe(1);
      expect(implFirst.state).toBe("manual_recovery_required");
      expect(implFirst.started_at).toBe(1000);
      expect(implFirst.heartbeat_at).toBe(1400);
      expect(implFirst.finished_at).toBe(1500);
      expect(implFirst.legacy_invocation_id).toBe(
        "run-1::implementation::dispatch",
      );
      expect(JSON.parse(String(implFirst.legacy_provenance))).toMatchObject({
        legacyInvocationId: "run-1::implementation::dispatch",
        source: "reconstructed_from_round_evidence",
      });

      // Latest group inherits the legacy attempt id and its live
      // state/timestamps unchanged.
      expect(implLatest.attempt_id).toBe("run-1::implementation::dispatch");
      expect(implLatest.attempt_number).toBe(2);
      expect(implLatest.state).toBe("running");
      expect(implLatest.started_at).toBe(2000);
      expect(implLatest.heartbeat_at).toBe(2500);
      expect(implLatest.finished_at).toBeNull();
      expect(JSON.parse(String(implLatest.legacy_provenance))).toMatchObject({
        source: "legacy_invocation_row",
      });

      expect(preflight.attempt_id).toBe("run-1::preflight::dispatch");
      expect(preflight.attempt_number).toBe(1);
      expect(preflight.state).toBe("succeeded");

      // The legacy schema allowed a second invocation row for the same step
      // and attempt number (here an adapter-minted mirror invocation); it is
      // deterministically renumbered past the dispatch scaffold instead of
      // colliding with the new unique step/attempt-number index.
      expect(preflightMirror.attempt_id).toBe(
        "no-mistakes::run-1::preflight::mirror",
      );
      expect(preflightMirror.attempt_number).toBe(2);
      expect(preflightMirror.state).toBe("succeeded");
      expect(
        JSON.parse(String(preflightMirror.legacy_provenance)),
      ).toMatchObject({
        legacyInvocationId: "no-mistakes::run-1::preflight::mirror",
        legacyAttemptNumber: 1,
      });
      expect(
        db
          .prepare(
            `SELECT attempt_id, attempt_number, round_index
               FROM executor_rounds WHERE round_id = ?`,
          )
          .get("no-mistakes::run-1::preflight::mirror::round::0"),
      ).toEqual({
        attempt_id: "no-mistakes::run-1::preflight::mirror",
        attempt_number: 2,
        round_index: 0,
      });
    } finally {
      db.close();
    }
  });

  it("orders colliding groups by lifecycle while preserving invocation order", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy
        .prepare(
          `UPDATE executor_invocations
              SET state = 'running', attempt = 2, started_at = 500,
                  heartbeat_at = 550, finished_at = NULL, updated_at = 550
            WHERE invocation_id = 'run-1::preflight::dispatch'`,
        )
        .run();
    } finally {
      legacy.close();
    }

    const db = openDb(dataDir);
    try {
      const attempts = db
        .prepare(
          `SELECT attempt_id, attempt_number, state, legacy_provenance
             FROM executor_attempts
            WHERE workflow_run_id = 'run-1' AND step_run_id = 'preflight'
            ORDER BY attempt_number`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(
        attempts.map(({ attempt_id, attempt_number, state }) => ({
          attempt_id,
          attempt_number,
          state,
        })),
      ).toEqual([
        {
          attempt_id: "run-1::preflight::dispatch::attempt-1",
          attempt_number: 1,
          state: "succeeded",
        },
        {
          attempt_id: "no-mistakes::run-1::preflight::mirror",
          attempt_number: 2,
          state: "succeeded",
        },
        {
          attempt_id: "run-1::preflight::dispatch",
          attempt_number: 3,
          state: "running",
        },
      ]);
      expect(JSON.parse(String(attempts[2]?.legacy_provenance))).toMatchObject({
        legacyAttemptNumber: 2,
      });
    } finally {
      db.close();
    }
  });

  it("allocates collision-safe historical attempt ids and remains idempotent", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy
        .prepare(
          `INSERT INTO executor_invocations (
             invocation_id, workflow_run_id, step_run_id, step_key,
             executor_family, state, attempt, started_at, heartbeat_at,
             finished_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-1::implementation::dispatch::attempt-1",
          "run-1",
          "implementation",
          "implementation",
          "no-mistakes",
          "succeeded",
          1,
          1600,
          1650,
          1700,
          1600,
          1700,
        );
      legacy
        .prepare(
          `INSERT INTO executor_rounds (
             round_id, invocation_id, workflow_run_id, step_run_id, step_key,
             executor_family, attempt, round_index, state, classification,
             executor_recommendation, started_at, heartbeat_at, finished_at,
             log_paths, key_changes, key_learnings, remaining_work,
             changed_files, verification_results, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "collision-lineage-round",
          "run-1::implementation::dispatch::attempt-1",
          "run-1",
          "implementation",
          "implementation",
          "no-mistakes",
          1,
          0,
          "succeeded",
          "complete",
          "complete",
          1600,
          1650,
          1700,
          "[]",
          "[]",
          "[]",
          "[]",
          "[]",
          "[]",
          1600,
          1700,
        );
      legacy
        .prepare(
          `INSERT INTO executor_artifacts (
             artifact_id, round_id, artifact_class, path, digest, description,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "collision-lineage-artifact",
          "collision-lineage-round",
          "logs",
          "/tmp/run-1/collision-lineage.log",
          "sha256:collision-lineage",
          "independent lineage evidence",
          1650,
        );
    } finally {
      legacy.close();
    }

    const first = openDb(dataDir);
    const snapshot = (db: DatabaseSync) => ({
      attempts: db
        .prepare(
          `SELECT attempt_id, legacy_invocation_id, attempt_number
             FROM executor_attempts
            WHERE workflow_run_id = 'run-1'
              AND step_run_id = 'implementation'
            ORDER BY attempt_number`,
        )
        .all(),
      rounds: db
        .prepare(
          `SELECT round_id, attempt_id, attempt_number
             FROM executor_rounds
            WHERE workflow_run_id = 'run-1'
              AND step_run_id = 'implementation'
            ORDER BY attempt_number, round_index`,
        )
        .all(),
      artifacts: db
        .prepare(
          `SELECT artifact_id, round_id, digest
             FROM executor_artifacts
            WHERE artifact_id IN ('artifact-1', 'collision-lineage-artifact')
            ORDER BY artifact_id`,
        )
        .all(),
    });
    const before = snapshot(first);
    expect(before.attempts).toHaveLength(3);
    const attemptIds = before.attempts.map((attempt) =>
      String((attempt as Record<string, unknown>).attempt_id),
    );
    expect(attemptIds).toEqual([
      expect.not.stringMatching(/^run-1::implementation::dispatch::attempt-1$/),
      "run-1::implementation::dispatch::attempt-1",
      "run-1::implementation::dispatch",
    ]);
    expect(before.rounds).toContainEqual({
      round_id: "run-1::implementation::dispatch::round-1",
      attempt_id: attemptIds[0],
      attempt_number: 1,
    });
    expect(before.rounds).toContainEqual({
      round_id: "collision-lineage-round",
      attempt_id: "run-1::implementation::dispatch::attempt-1",
      attempt_number: 2,
    });
    expect(before.artifacts).toEqual([
      {
        artifact_id: "artifact-1",
        round_id: "run-1::implementation::dispatch::round-1",
        digest: "sha256:log-1",
      },
      {
        artifact_id: "collision-lineage-artifact",
        round_id: "collision-lineage-round",
        digest: "sha256:collision-lineage",
      },
    ]);
    first.close();

    const second = openDb(dataDir);
    try {
      expect(snapshot(second)).toEqual(before);
    } finally {
      second.close();
    }
  });

  it("preserves every round id, ordering, and evidence link across the split", () => {
    const dataDir = seedLegacyDataDir();
    const db = openDb(dataDir);
    try {
      const rounds = db
        .prepare(
          `SELECT round_id, attempt_id, attempt_number, round_index, state,
                  classification, recovery_code, summary, key_learnings,
                  verification_results
             FROM executor_rounds
            WHERE workflow_run_id = 'run-1' AND step_run_id = 'implementation'
            ORDER BY attempt_number, round_index`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(rounds.map((round) => round.round_id)).toEqual([
        "run-1::implementation::dispatch::round-1",
        "run-1::implementation::dispatch::round-2",
        "run-1::implementation::dispatch::round-3",
      ]);
      expect(rounds.map((round) => round.attempt_id)).toEqual([
        "run-1::implementation::dispatch::attempt-1",
        "run-1::implementation::dispatch::attempt-1",
        "run-1::implementation::dispatch",
      ]);
      expect(rounds.map((round) => round.round_index)).toEqual([1, 2, 3]);
      expect(rounds[1]?.recovery_code).toBe("executor_threw");
      expect(rounds[0]?.key_learnings).toBe('["learning-1"]');
      expect(rounds[0]?.verification_results).toBe(
        '[{"command":"pnpm test","exitCode":0,"durationMs":10,"timedOut":false}]',
      );

      const evidence = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM executor_artifacts) AS artifacts,
             (SELECT COUNT(*) FROM executor_checkpoints) AS checkpoints,
             (SELECT COUNT(*) FROM executor_findings) AS findings,
             (SELECT COUNT(*) FROM executor_decisions) AS decisions`,
        )
        .get() as Record<string, number>;
      expect(evidence).toEqual({
        artifacts: 2,
        checkpoints: 5,
        findings: 1,
        decisions: 1,
      });
      expect(
        db.prepare("PRAGMA foreign_key_check(executor_rounds)").all(),
      ).toEqual([]);
      expect(
        db.prepare("PRAGMA foreign_key_check(executor_artifacts)").all(),
      ).toEqual([]);
      expect(
        db.prepare("PRAGMA foreign_key_check(executor_checkpoints)").all(),
      ).toEqual([]);

      // External handoff correlation survives untouched as frozen evidence.
      const intent = db
        .prepare(
          "SELECT detail FROM executor_checkpoints WHERE checkpoint_id = 'checkpoint-2'",
        )
        .get() as { detail: string };
      expect(JSON.parse(intent.detail)).toEqual({
        tool: "gnhf",
        invocationId: "run-1::implementation::dispatch",
        attempt: 1,
      });

      // A renumbered lineage's handoff-intent payload has its `attempt` field
      // translated to the assigned number so the migrated round still fences.
      const renumberedIntent = db
        .prepare(
          "SELECT detail FROM executor_checkpoints WHERE checkpoint_id = 'checkpoint-5'",
        )
        .get() as { detail: string };
      expect(JSON.parse(renumberedIntent.detail)).toEqual({
        tool: "no-mistakes",
        invocationId: "no-mistakes::run-1::preflight::mirror",
        attempt: 2,
      });
    } finally {
      db.close();
    }
  });

  it("renames the gate attempt column, re-anchors round-scoped gates, and preserves historical scopes", () => {
    const dataDir = seedLegacyDataDir();
    const db = openDb(dataDir);
    try {
      const columns = getColumns(db, "workflow_gates").map((row) => row.name);
      expect(columns).toContain("attempt_id");
      expect(columns).not.toContain("invocation_id");

      const gates = db
        .prepare(
          `SELECT gate_id, attempt_id, round_id, target_scope
             FROM workflow_gates ORDER BY gate_id`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(gates).toEqual([
        {
          gate_id: "gate-invocation",
          attempt_id: "run-1::implementation::dispatch",
          round_id: null,
          // Historical scope values are preserved so re-projected gate event
          // ids stay stable for replay cursors issued before the migration.
          target_scope: "invocation",
        },
        {
          gate_id: "gate-round",
          attempt_id: "run-1::implementation::dispatch::attempt-1",
          round_id: "run-1::implementation::dispatch::round-2",
          target_scope: "round",
        },
        {
          gate_id: "gate-step",
          attempt_id: null,
          round_id: null,
          target_scope: "step",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("parks a run whose step carries ambiguous live legacy lineages", () => {
    // run-2's implementation step has a live dispatch lineage plus a
    // later-created terminal adapter lineage. Lifecycle ordering makes the
    // terminal lineage the highest attempt, so resuming the live lineage (or
    // trusting the stale terminal one as newest) would misrepresent state;
    // the migration opens the database but fails closed into manual recovery.
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy
        .prepare(
          `UPDATE workflow_runs
              SET manual_recovery_reason = 'previously cleared recovery'
            WHERE id = 'run-2'`,
        )
        .run();
    } finally {
      legacy.close();
    }
    const db = openDb(dataDir);
    try {
      const attempts = db
        .prepare(
          `SELECT attempt_id, state, attempt_number, legacy_provenance
             FROM executor_attempts
            WHERE workflow_run_id = 'run-2'
            ORDER BY attempt_number`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(attempts).toMatchObject([
        {
          attempt_id: "run-2::implementation::dispatch",
          state: "running",
          attempt_number: 1,
        },
        {
          attempt_id: "no-mistakes::run-2::implementation::mirror",
          state: "failed",
          attempt_number: 2,
        },
      ]);
      expect(JSON.parse(String(attempts[1]?.legacy_provenance))).toMatchObject({
        legacyAttemptNumber: 1,
      });

      const run = db
        .prepare(
          `SELECT needs_manual_recovery, manual_recovery_reason
             FROM workflow_runs WHERE id = 'run-2'`,
        )
        .get() as {
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
      };
      expect(run.needs_manual_recovery).toBe(1);
      expect(run.manual_recovery_reason).toContain(
        "previously cleared recovery",
      );
      expect(run.manual_recovery_reason).toContain(
        "multiple legacy executor lineages with live work",
      );

      // run-1's terminal-only collision renumbers without parking.
      const runOne = db
        .prepare(
          "SELECT needs_manual_recovery FROM workflow_runs WHERE id = 'run-1'",
        )
        .get() as { needs_manual_recovery: number };
      expect(runOne.needs_manual_recovery).toBe(0);
    } finally {
      db.close();
    }
  });

  it("parks recovery-bearing terminal lineages instead of treating their synthetic order as authoritative", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy.exec(`
        UPDATE executor_invocations
           SET state = 'succeeded', finished_at = 400, updated_at = 400
         WHERE invocation_id = 'run-2::implementation::dispatch';
        UPDATE executor_rounds
           SET state = 'succeeded', classification = 'complete',
               executor_recommendation = 'complete', finished_at = 400,
               updated_at = 400
         WHERE round_id = 'run-2::implementation::dispatch::round-1';
        UPDATE executor_invocations
           SET state = 'manual_recovery_required', finished_at = 600,
               updated_at = 600
         WHERE invocation_id = 'no-mistakes::run-2::implementation::mirror';
        UPDATE executor_rounds
           SET state = 'manual_recovery_required',
               classification = 'manual_recovery_required',
               executor_recommendation = NULL,
               recovery_code = 'external_state_blocked', finished_at = 600,
               updated_at = 600
         WHERE round_id = 'no-mistakes::run-2::implementation::mirror::round::0';
      `);
    } finally {
      legacy.close();
    }

    const db = openDb(dataDir);
    try {
      const run = db
        .prepare(
          `SELECT needs_manual_recovery, manual_recovery_reason
             FROM workflow_runs WHERE id = 'run-2'`,
        )
        .get() as {
        needs_manual_recovery: number;
        manual_recovery_reason: string | null;
      };
      expect(run.needs_manual_recovery).toBe(1);
      expect(run.manual_recovery_reason).toContain(
        "multiple legacy executor lineages with recovery-bearing work",
      );
      expect(
        selectRunnableWorkflowWork(db, { runId: "run-2", now: 700 }),
      ).toEqual({ runnable: [], staleLeases: [] });
    } finally {
      db.close();
    }
  });

  it("is a no-op when the migrated database is opened again", () => {
    const dataDir = seedLegacyDataDir();
    const first = openDb(dataDir);
    const snapshot = (db: DatabaseSync) => ({
      attempts: db
        .prepare("SELECT * FROM executor_attempts ORDER BY attempt_id")
        .all(),
      rounds: db
        .prepare("SELECT * FROM executor_rounds ORDER BY round_id")
        .all(),
      gates: db.prepare("SELECT * FROM workflow_gates ORDER BY gate_id").all(),
    });
    const before = snapshot(first);
    first.close();
    const second = openDb(dataDir);
    try {
      expect(snapshot(second)).toEqual(before);
      expect(tableNames(second)).not.toContain("executor_invocations");
    } finally {
      second.close();
    }
  });

  it("retries insert a fresh immutable attempt on a migrated database and leave history unchanged", () => {
    const dataDir = seedLegacyDataDir();
    // Park the migrated latest attempt in a retryable terminal first.
    const db = openDb(dataDir);
    try {
      db.exec(`
        UPDATE executor_rounds
           SET round_index = 8
         WHERE round_id = 'run-1::implementation::dispatch::round-1';
        UPDATE executor_attempts
           SET state = 'manual_recovery_required', finished_at = 2600
         WHERE attempt_id = 'run-1::implementation::dispatch';
        UPDATE executor_rounds
           SET state = 'manual_recovery_required',
               classification = 'manual_recovery_required',
               recovery_code = 'executor_threw', finished_at = 2600
         WHERE round_id = 'run-1::implementation::dispatch::round-3';
      `);
      const started = startRetryableDispatchAttempt(db, {
        runId: "run-1",
        stepId: "implementation",
        now: 3000,
        stepState: "running",
      });
      expect(started).toMatchObject({
        started: true,
        attemptId: "run-1::implementation::attempt-3",
        attemptNumber: 3,
        roundIndex: 9,
      });
      const attempts = db
        .prepare(
          `SELECT attempt_id, state, attempt_number FROM executor_attempts
            WHERE workflow_run_id = 'run-1' AND step_run_id = 'implementation'
            ORDER BY attempt_number`,
        )
        .all();
      expect(attempts).toEqual([
        {
          attempt_id: "run-1::implementation::dispatch::attempt-1",
          state: "manual_recovery_required",
          attempt_number: 1,
        },
        {
          attempt_id: "run-1::implementation::dispatch",
          state: "manual_recovery_required",
          attempt_number: 2,
        },
        {
          attempt_id: "run-1::implementation::attempt-3",
          state: "running",
          attempt_number: 3,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("allocates a collision-safe retry id after preserving an unrestricted legacy id", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy.exec(`
        INSERT INTO workflow_runs
          (id, state, source, plan_json, created_at, updated_at)
        VALUES
          ('run-3', 'running', 'momentum-native-coding-workflow', '{}', 100, 600);
        INSERT INTO workflow_steps
          (run_id, step_id, kind, state, step_order, required, started_at,
           finished_at, created_at, updated_at)
        VALUES
          ('run-3', 'implementation', 'implementation', 'running', 0, 1,
           100, NULL, 100, 600);
        INSERT INTO executor_invocations
          (invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, state, attempt, started_at, heartbeat_at,
           finished_at, created_at, updated_at)
        VALUES
          ('run-3::implementation::attempt-2', 'run-3', 'implementation',
           'implementation', 'no-mistakes', 'manual_recovery_required', 1,
           100, 500, 600, 100, 600);
        INSERT INTO executor_rounds
          (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, attempt, round_index, state, classification,
           started_at, heartbeat_at, finished_at, recovery_code, created_at,
           updated_at)
        VALUES
          ('run-3::implementation::legacy-round',
           'run-3::implementation::attempt-2', 'run-3', 'implementation',
           'implementation', 'no-mistakes', 1, 0,
           'manual_recovery_required', 'manual_recovery_required', 100, 500,
           600, 'external_state_blocked', 100, 600);
      `);
    } finally {
      legacy.close();
    }

    const db = openDb(dataDir);
    try {
      const first = startRetryableDispatchAttempt(db, {
        runId: "run-3",
        stepId: "implementation",
        now: 700,
        stepState: "running",
      });
      expect(first).toEqual({
        started: true,
        attemptId: "run-3::implementation::attempt-2::allocated-1",
        attemptNumber: 2,
        roundIndex: 1,
      });
      expect(
        startRetryableDispatchAttempt(db, {
          runId: "run-3",
          stepId: "implementation",
          now: 800,
          stepState: "running",
        }),
      ).toEqual({ started: false });
      expect(
        db
          .prepare(
            `SELECT attempt_id, attempt_number
               FROM executor_attempts
              WHERE workflow_run_id = 'run-3'
              ORDER BY attempt_number`,
          )
          .all(),
      ).toEqual([
        {
          attempt_id: "run-3::implementation::attempt-2",
          attempt_number: 1,
        },
        {
          attempt_id: "run-3::implementation::attempt-2::allocated-1",
          attempt_number: 2,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("creates a retry attempt and initial round atomically when a legacy round owns the canonical id", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy.exec(`
        INSERT INTO workflow_runs
          (id, state, source, plan_json, created_at, updated_at)
        VALUES
          ('round-id-owner', 'succeeded',
           'momentum-native-coding-workflow', '{}', 100, 600);
        INSERT INTO workflow_steps
          (run_id, step_id, kind, state, step_order, required, started_at,
           finished_at, created_at, updated_at)
        VALUES
          ('round-id-owner', 'implementation', 'implementation', 'succeeded',
           0, 1, 100, 600, 100, 600);
        INSERT INTO executor_invocations
          (invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, state, attempt, started_at, heartbeat_at,
           finished_at, created_at, updated_at)
        VALUES
          ('round-id-owner::implementation::dispatch', 'round-id-owner',
           'implementation', 'implementation', 'one-shot', 'succeeded', 1,
           100, 500, 600, 100, 600);
        INSERT INTO executor_rounds
          (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, attempt, round_index, state, classification,
           executor_recommendation, started_at, heartbeat_at, finished_at,
           created_at, updated_at)
        VALUES
          ('run-1::implementation::attempt-3::round-5',
           'round-id-owner::implementation::dispatch', 'round-id-owner',
           'implementation', 'implementation', 'one-shot', 1, 0, 'succeeded',
           'complete', 'complete', 100, 500, 600, 100, 600);
      `);
    } finally {
      legacy.close();
    }

    const db = openDb(dataDir);
    try {
      db.exec(`
        UPDATE executor_attempts
           SET state = 'manual_recovery_required', finished_at = 2600
         WHERE attempt_id = 'run-1::implementation::dispatch';
        UPDATE executor_rounds
           SET round_index = 4,
               state = 'manual_recovery_required',
               classification = 'manual_recovery_required',
               recovery_code = 'executor_threw', finished_at = 2600
         WHERE round_id = 'run-1::implementation::dispatch::round-3';
      `);

      const started = startRetryableDispatchAttempt(db, {
        runId: "run-1",
        stepId: "implementation",
        now: 3000,
        stepState: "running",
      });
      expect(started).toEqual({
        started: true,
        attemptId: "run-1::implementation::attempt-3",
        attemptNumber: 3,
        roundIndex: 5,
      });
      expect(
        db
          .prepare(
            `SELECT round_id, attempt_id, attempt_number, round_index
               FROM executor_rounds
              WHERE attempt_id = 'run-1::implementation::attempt-3'`,
          )
          .all(),
      ).toEqual([
        {
          round_id: "run-1::implementation::attempt-3::round-5::allocated-1",
          attempt_id: "run-1::implementation::attempt-3",
          attempt_number: 3,
          round_index: 5,
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM executor_attempts
              WHERE workflow_run_id = 'run-1'
                AND step_run_id = 'implementation'
                AND attempt_number = 3`,
          )
          .get(),
      ).toEqual({ count: 1 });

      db.exec(`
        UPDATE executor_attempts
           SET state = 'manual_recovery_required', finished_at = 3100
         WHERE attempt_id = 'run-1::implementation::attempt-3';
        UPDATE executor_rounds
           SET state = 'manual_recovery_required',
               classification = 'manual_recovery_required',
               recovery_code = 'executor_threw', finished_at = 3100
         WHERE attempt_id = 'run-1::implementation::attempt-3';
        INSERT INTO executor_rounds
          (round_id, attempt_id, workflow_run_id, step_run_id, step_key,
           executor, attempt_number, round_index, state, created_at,
           updated_at)
        VALUES
          ('run-1::implementation::attempt-4::round-6',
           'round-id-owner::implementation::dispatch', 'round-id-owner',
           'implementation', 'implementation', 'agent-once', 1, 1,
           'succeeded', 3100, 3100);
        CREATE TRIGGER reject_allocated_retry_round
        BEFORE INSERT ON executor_rounds
        WHEN NEW.round_id LIKE
          'run-1::implementation::attempt-4::round-6::allocated-%'
        BEGIN
          SELECT RAISE(ABORT, 'reject allocated retry round');
        END;
      `);
      expect(() =>
        startRetryableDispatchAttempt(db, {
          runId: "run-1",
          stepId: "implementation",
          now: 3200,
          stepState: "running",
        }),
      ).toThrow("reject allocated retry round");
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM executor_attempts
              WHERE workflow_run_id = 'run-1'
                AND step_run_id = 'implementation'
                AND attempt_number = 4`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("keeps delimiter-bearing run and step ids in separate migration groups", () => {
    const dataDir = seedLegacyDataDir();
    const legacy = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      legacy.exec(`
        INSERT INTO workflow_runs
          (id, state, source, plan_json, created_at, updated_at)
        VALUES
          ('r::s', 'running', 'momentum-native-coding-workflow', '{}', 100, 500),
          ('r', 'running', 'momentum-native-coding-workflow', '{}', 100, 500);
        INSERT INTO workflow_steps
          (run_id, step_id, kind, state, step_order, required, started_at,
           finished_at, created_at, updated_at)
        VALUES
          ('r::s', 't', 'implementation', 'running', 0, 1, 100, NULL, 100, 500),
          ('r', 's::t', 'implementation', 'running', 0, 1, 100, NULL, 100, 500);
        INSERT INTO executor_invocations
          (invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, state, attempt, started_at, heartbeat_at,
           finished_at, created_at, updated_at)
        VALUES
          ('tuple-a-dispatch', 'r::s', 't', 't', 'delegate-supervisor',
           'running', 1, 100, 500, NULL, 100, 500),
          ('tuple-a-mirror', 'r::s', 't', 't', 'no-mistakes',
           'running', 1, 200, 500, NULL, 200, 500),
          ('tuple-b-dispatch', 'r', 's::t', 's::t', 'delegate-supervisor',
           'running', 1, 110, 500, NULL, 110, 500),
          ('tuple-b-mirror', 'r', 's::t', 's::t', 'no-mistakes',
           'running', 1, 210, 500, NULL, 210, 500);
        INSERT INTO executor_rounds
          (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
           executor_family, attempt, round_index, state, started_at,
           heartbeat_at, created_at, updated_at)
        VALUES
          ('tuple-a-dispatch-round', 'tuple-a-dispatch', 'r::s', 't', 't',
           'delegate-supervisor', 1, 0, 'running', 100, 500, 100, 500),
          ('tuple-a-mirror-round', 'tuple-a-mirror', 'r::s', 't', 't',
           'no-mistakes', 1, 0, 'running', 200, 500, 200, 500),
          ('tuple-b-dispatch-round', 'tuple-b-dispatch', 'r', 's::t', 's::t',
           'delegate-supervisor', 1, 0, 'running', 110, 500, 110, 500),
          ('tuple-b-mirror-round', 'tuple-b-mirror', 'r', 's::t', 's::t',
           'no-mistakes', 1, 0, 'running', 210, 500, 210, 500);
      `);
    } finally {
      legacy.close();
    }

    const db = openDb(dataDir);
    try {
      const attemptsFor = (runId: string, stepId: string) =>
        db
          .prepare(
            `SELECT workflow_run_id, step_run_id, attempt_number
               FROM executor_attempts
              WHERE workflow_run_id = ? AND step_run_id = ?
              ORDER BY attempt_number`,
          )
          .all(runId, stepId);
      expect(attemptsFor("r::s", "t")).toEqual([
        { workflow_run_id: "r::s", step_run_id: "t", attempt_number: 1 },
        { workflow_run_id: "r::s", step_run_id: "t", attempt_number: 2 },
      ]);
      expect(attemptsFor("r", "s::t")).toEqual([
        { workflow_run_id: "r", step_run_id: "s::t", attempt_number: 1 },
        { workflow_run_id: "r", step_run_id: "s::t", attempt_number: 2 },
      ]);
      expect(
        db
          .prepare(
            `SELECT id, needs_manual_recovery
               FROM workflow_runs
              WHERE id IN ('r::s', 'r')
              ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "r", needs_manual_recovery: 1 },
        { id: "r::s", needs_manual_recovery: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("NAM-02 workflow vocabulary migration (NGX-653)", () => {
  // Post-SDK05, pre-rename schema: the attempt/round spine is already split,
  // but the executor columns still carry the Family-era names and rows still
  // use the pre-rename vocabulary.
  const PRE_RENAME_SCHEMA_AND_ROWS = `
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  goal_id TEXT,
  source TEXT NOT NULL,
  source_artifact_path TEXT,
  plan_json TEXT NOT NULL DEFAULT '{}',
  route_json TEXT NOT NULL DEFAULT '{}',
  approval_boundary TEXT,
  batch_group TEXT,
  batch_role TEXT,
  needs_manual_recovery INTEGER NOT NULL DEFAULT 0,
  manual_recovery_reason TEXT,
  manual_recovery_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  step_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  ledger_offset INTEGER,
  result_digest TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
) STRICT;

CREATE TABLE workflow_approvals (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  boundary TEXT NOT NULL,
  actor TEXT,
  phrase TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  discharged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, boundary)
) STRICT;

CREATE TABLE workflow_gates (
  gate_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT,
  attempt_id TEXT,
  round_id TEXT,
  target_scope TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT,
  policy_envelope TEXT NOT NULL DEFAULT '[]',
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution_mode TEXT,
  chosen_action TEXT,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workflow_definitions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, version)
) STRICT;

CREATE TABLE step_definitions (
  definition_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  executor TEXT NOT NULL,
  config_json TEXT,
  step_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (definition_key, definition_version, step_key),
  FOREIGN KEY (definition_key, definition_version)
    REFERENCES workflow_definitions(key, version)
) STRICT;

CREATE TABLE executor_definitions (
  executor_key TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  agent_provider TEXT,
  model TEXT,
  effort TEXT,
  timeout_ms INTEGER,
  max_rounds INTEGER,
  policy_envelope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE executor_attempts (
  attempt_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor_family TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  legacy_invocation_id TEXT,
  legacy_provenance TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id, step_run_id)
    REFERENCES workflow_steps(run_id, step_id)
) STRICT;

CREATE TABLE executor_rounds (
  round_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES executor_attempts(attempt_id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor_family TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  round_index INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  classification TEXT,
  executor_recommendation TEXT,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  agent_provider TEXT,
  model TEXT,
  effort TEXT,
  input_digest TEXT,
  result_digest TEXT,
  artifact_root TEXT,
  log_paths TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  key_changes TEXT NOT NULL DEFAULT '[]',
  key_learnings TEXT NOT NULL DEFAULT '[]',
  remaining_work TEXT NOT NULL DEFAULT '[]',
  changed_files TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT,
  verification_results TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT,
  recovery_code TEXT,
  human_gate TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id, step_run_id)
    REFERENCES workflow_steps(run_id, step_id)
) STRICT;

CREATE TABLE executor_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO workflow_runs
  (id, state, source, plan_json, route_json, approval_boundary,
   created_at, updated_at)
VALUES
  ('vocab-run-1', 'running', 'momentum-native-coding-workflow', '{}',
   '{"steps":{"no-mistakes":{"runner_profile":"careful"}}}', 'no-mistakes',
   100, 900),
  ('vocab-run-2', 'running', 'momentum-native-coding-workflow', '{}', '{}',
   'through-no-mistakes', 100, 900);

INSERT INTO workflow_steps
  (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
VALUES
  ('vocab-run-1', 'implementation', 'implementation', 'succeeded', 0, 1,
   100, 200),
  ('vocab-run-1', 'no-mistakes', 'no-mistakes', 'succeeded', 1, 1, 200, 300),
  ('vocab-run-1', 'linear-refresh', 'linear-refresh', 'succeeded', 2, 1,
   300, 400),
  ('vocab-run-2', 'implementation', 'implementation', 'running', 0, 1,
   100, 900);

INSERT INTO workflow_approvals
  (run_id, boundary, actor, phrase, artifact_path, artifact_digest,
   recorded_at, created_at, updated_at)
VALUES
  ('vocab-run-1', 'no-mistakes', 'operator', 'no-mistakes',
   '.agent-workflows/vocab-run-1/approval-no-mistakes.json',
   'sha256:approval', 150, 150, 150);

INSERT INTO workflow_gates
  (gate_id, workflow_run_id, step_run_id, target_scope, gate_type, reason,
   evidence, allowed_actions, recommended_action, created_at, updated_at)
VALUES
  ('vocab-gate-1', 'vocab-run-1', 'no-mistakes', 'step',
   'manual_recovery_required', 'no-mistakes step parked',
   'external_state_blocked', '["clear_recovery"]', 'clear_recovery', 250, 250);

INSERT INTO workflow_definitions (key, version, title, created_at, updated_at)
VALUES ('coding-workflow', 2, 'Recorded V2', 1, 1);

INSERT INTO step_definitions
  (definition_key, definition_version, step_key, kind, executor, step_order,
   required, created_at, updated_at)
VALUES
  ('coding-workflow', 2, 'implementation', 'implementation', 'goal-loop', 1,
   1, 1, 1),
  ('coding-workflow', 2, 'no-mistakes', 'no-mistakes', 'no-mistakes', 5,
   1, 1, 1);

INSERT INTO executor_definitions (executor_key, family, created_at, updated_at)
VALUES ('custom-loop', 'goal-loop', 1, 1);

INSERT INTO executor_attempts
  (attempt_id, workflow_run_id, step_run_id, step_key, executor_family,
   state, attempt_number, started_at, finished_at, legacy_provenance,
   created_at, updated_at)
VALUES
  ('vocab-impl', 'vocab-run-1', 'implementation', 'implementation',
   'goal-loop', 'succeeded', 1, 100, 200, NULL, 100, 200),
  ('vocab-nm-provable', 'vocab-run-1', 'no-mistakes', 'no-mistakes',
   'no-mistakes', 'succeeded', 1, 200, 300,
   '{"source":"legacy_invocation_row","legacyExecutor":"recorded-value"}', 200, 300),
  ('vocab-refresh', 'vocab-run-1', 'linear-refresh', 'linear-refresh',
   'one-shot', 'succeeded', 1, 300, 400, NULL, 300, 400),
  ('vocab-nm-unprovable', 'vocab-run-2', 'implementation', 'implementation',
   'no-mistakes', 'failed', 1, 400, 500, NULL, 400, 500),
  ('vocab-nm-live', 'vocab-run-2', 'implementation', 'implementation',
   'no-mistakes', 'running', 2, 600, NULL, NULL, 600, 900);

INSERT INTO executor_rounds
  (round_id, attempt_id, workflow_run_id, step_run_id, step_key,
   executor_family, attempt_number, round_index, state, created_at,
   updated_at)
VALUES
  ('vocab-impl-r0', 'vocab-impl', 'vocab-run-1', 'implementation',
   'implementation', 'goal-loop', 1, 0, 'succeeded', 100, 200),
  ('vocab-nm-provable-r0', 'vocab-nm-provable', 'vocab-run-1', 'no-mistakes',
   'no-mistakes', 'no-mistakes', 1, 0, 'succeeded', 200, 300),
  ('vocab-refresh-r0', 'vocab-refresh', 'vocab-run-1', 'linear-refresh',
   'linear-refresh', 'one-shot', 1, 0, 'succeeded', 300, 400),
  ('vocab-nm-unprovable-r0', 'vocab-nm-unprovable', 'vocab-run-2',
   'implementation', 'implementation', 'no-mistakes', 1, 0, 'failed',
   400, 500),
  ('vocab-nm-live-r0', 'vocab-nm-live', 'vocab-run-2', 'implementation',
   'implementation', 'no-mistakes', 2, 0, 'running', 600, 900);

INSERT INTO executor_checkpoints
  (checkpoint_id, round_id, sequence, stage, detail, created_at)
VALUES
  ('vocab-cp-provable', 'vocab-nm-provable-r0', 0,
   'expected_external_identity',
   '{"externalRunId":"nm-run-77","branch":"feature/vocab","headSha":"abc123"}',
   210),
  ('vocab-cp-unprovable', 'vocab-nm-unprovable-r0', 0,
   'expected_external_identity', '{"externalRunId":"nm-run-78"}', 410),
  ('vocab-cp-live', 'vocab-nm-live-r0', 0, 'external_state_mirrored',
   '{"externalRunId":"nm-run-79","branch":"feature/vocab","headSha":"fed321"}',
   610);
`;

  function seedPreRenameDataDir(
    options: {
      claimOneShotDefinition?: boolean;
      claimNoMistakesDefinition?: boolean;
    } = {},
  ): string {
    const dataDir = makeTempDir("momentum-nam02-migration-");
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.exec(PRE_RENAME_SCHEMA_AND_ROWS);
      if (options.claimOneShotDefinition) {
        // A third-party registration that claims the old built-in spelling as
        // its own identity; the value rename must then leave `one-shot`
        // untouched everywhere.
        db.prepare(
          `INSERT INTO executor_definitions
             (executor_key, family, created_at, updated_at)
           VALUES ('one-shot', 'one-shot', 1, 1)`,
        ).run();
      }
      if (options.claimNoMistakesDefinition) {
        db.prepare(
          `INSERT INTO executor_definitions
             (executor_key, family, created_at, updated_at)
           VALUES ('no-mistakes', 'no-mistakes', 1, 1)`,
        ).run();
      }
    } finally {
      db.close();
    }
    return dataDir;
  }

  it("creates fresh data dirs with the renamed executor columns and no legacy vocabulary", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      for (const table of ["executor_attempts", "executor_rounds"]) {
        const cols = getColumns(db, table).map((row) => row.name);
        expect(cols, table).toContain("executor");
        expect(cols, table).not.toContain("executor_family");
      }
      const definitionCols = getColumns(db, "executor_definitions").map(
        (row) => row.name,
      );
      expect(definitionCols).toContain("executor");
      expect(definitionCols).not.toContain("family");

      const legacyValues = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM executor_attempts
               WHERE executor IN ('goal-loop', 'one-shot')) +
             (SELECT COUNT(*) FROM executor_rounds
               WHERE executor IN ('goal-loop', 'one-shot')) +
             (SELECT COUNT(*) FROM workflow_steps
               WHERE kind IN ('no-mistakes', 'linear-refresh')) AS count`,
        )
        .get() as { count: number };
      expect(legacyValues.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("renames executor columns and upgrades runtime vocabulary on a pre-rename data dir", () => {
    const dataDir = seedPreRenameDataDir();
    const db = openDb(dataDir);
    try {
      for (const table of ["executor_attempts", "executor_rounds"]) {
        const cols = getColumns(db, table).map((row) => row.name);
        expect(cols, table).toContain("executor");
        expect(cols, table).not.toContain("executor_family");
      }
      const definitionCols = getColumns(db, "executor_definitions").map(
        (row) => row.name,
      );
      expect(definitionCols).toContain("executor");
      expect(definitionCols).not.toContain("family");

      // Step kinds move to the renamed vocabulary; step ids never change
      // (event ids and artifact trees anchor on them).
      expect(
        db
          .prepare(
            `SELECT step_id, kind FROM workflow_steps
              WHERE run_id = 'vocab-run-1' ORDER BY step_order`,
          )
          .all(),
      ).toEqual([
        { step_id: "implementation", kind: "implementation" },
        { step_id: "no-mistakes", kind: "validate" },
        { step_id: "linear-refresh", kind: "tracker-refresh" },
      ]);

      // Approval boundaries and route step overrides re-spell.
      const runs = db
        .prepare(
          `SELECT id, approval_boundary, route_json
             FROM workflow_runs ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "vocab-run-1",
        approval_boundary: "validate",
      });
      expect(JSON.parse(String(runs[0]?.route_json))).toEqual({
        steps: { validate: { runner_profile: "careful" } },
      });
      expect(runs[1]).toMatchObject({
        id: "vocab-run-2",
        approval_boundary: "through-validate",
      });

      // Executor values upgrade in attempts, rounds, and the definitions
      // identity column. The provable terminal no-mistakes attempt converts;
      // the rest of the no-mistakes rows keep their legacy identity.
      expect(
        db
          .prepare(
            `SELECT attempt_id, executor FROM executor_attempts
              ORDER BY attempt_id`,
          )
          .all(),
      ).toEqual([
        { attempt_id: "vocab-impl", executor: "agent-loop" },
        { attempt_id: "vocab-nm-live", executor: "no-mistakes" },
        { attempt_id: "vocab-nm-provable", executor: "delegate-supervisor" },
        { attempt_id: "vocab-nm-unprovable", executor: "no-mistakes" },
        { attempt_id: "vocab-refresh", executor: "agent-once" },
      ]);
      expect(
        db
          .prepare(
            `SELECT round_id, executor FROM executor_rounds
              ORDER BY round_id`,
          )
          .all(),
      ).toEqual([
        { round_id: "vocab-impl-r0", executor: "agent-loop" },
        { round_id: "vocab-nm-live-r0", executor: "no-mistakes" },
        { round_id: "vocab-nm-provable-r0", executor: "delegate-supervisor" },
        { round_id: "vocab-nm-unprovable-r0", executor: "no-mistakes" },
        { round_id: "vocab-refresh-r0", executor: "agent-once" },
      ]);
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_definitions
              WHERE executor_key = 'custom-loop'`,
          )
          .get(),
      ).toEqual({ executor: "agent-loop" });

      // Digest-anchored surfaces keep their recorded spellings: recorded
      // step definitions, approvals, and gates never change.
      expect(
        db
          .prepare(
            `SELECT step_key, kind, executor FROM step_definitions
              WHERE definition_key = 'coding-workflow'
                AND definition_version = 2
              ORDER BY step_order`,
          )
          .all(),
      ).toEqual([
        {
          step_key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
        },
        {
          step_key: "no-mistakes",
          kind: "no-mistakes",
          executor: "no-mistakes",
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT boundary, phrase, artifact_digest FROM workflow_approvals
              WHERE run_id = 'vocab-run-1'`,
          )
          .get(),
      ).toEqual({
        boundary: "no-mistakes",
        phrase: "no-mistakes",
        artifact_digest: "sha256:approval",
      });
      expect(
        db
          .prepare(
            `SELECT step_run_id, target_scope, reason, evidence
               FROM workflow_gates WHERE gate_id = 'vocab-gate-1'`,
          )
          .get(),
      ).toEqual({
        step_run_id: "no-mistakes",
        target_scope: "step",
        reason: "no-mistakes step parked",
        evidence: "external_state_blocked",
      });
    } finally {
      db.close();
    }
  });

  it("migrates a pre-rename database before returning a read-only handle", () => {
    const dataDir = seedPreRenameDataDir();
    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      expect(
        getColumns(db!, "executor_attempts").map((row) => row.name),
      ).toContain("executor");
      expect(
        db!
          .prepare(
            "SELECT executor FROM executor_attempts WHERE attempt_id = 'vocab-impl'",
          )
          .get(),
      ).toEqual({ executor: "agent-loop" });
    } finally {
      db?.close();
    }
  });

  it("does not convert a provable no-mistakes row when durable configuration claims that identity", () => {
    const dataDir = seedPreRenameDataDir({
      claimNoMistakesDefinition: true,
    });
    const db = openDb(dataDir);
    try {
      expect(
        db
          .prepare(
            `SELECT executor, legacy_provenance
               FROM executor_attempts
              WHERE attempt_id = 'vocab-nm-provable'`,
          )
          .get(),
      ).toEqual({
        executor: "no-mistakes",
        legacy_provenance:
          '{"source":"legacy_invocation_row","legacyExecutor":"recorded-value"}',
      });
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_rounds
              WHERE round_id = 'vocab-nm-provable-r0'`,
          )
          .get(),
      ).toEqual({ executor: "no-mistakes" });
    } finally {
      db.close();
    }
  });

  it("preserves legacy executor identities claimed only by daemon config", () => {
    const dataDir = seedPreRenameDataDir();
    const configPath = path.join(dataDir, "executors.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        executors: {
          "goal-loop": "./goal-loop.mjs",
          "one-shot": "./one-shot.mjs",
          "no-mistakes": "./no-mistakes.mjs",
        },
      }),
    );
    const previousConfig = process.env.MOMENTUM_EXECUTOR_CONFIG;
    process.env.MOMENTUM_EXECUTOR_CONFIG = configPath;
    let db: DatabaseSync | undefined;
    try {
      db = openDb(dataDir);
      expect(
        db
          .prepare(
            `SELECT attempt_id, executor FROM executor_attempts
              WHERE attempt_id IN ('vocab-impl', 'vocab-refresh', 'vocab-nm-provable')
              ORDER BY attempt_id`,
          )
          .all(),
      ).toEqual([
        { attempt_id: "vocab-impl", executor: "goal-loop" },
        { attempt_id: "vocab-nm-provable", executor: "no-mistakes" },
        { attempt_id: "vocab-refresh", executor: "one-shot" },
      ]);
      expect(
        db
          .prepare(
            `SELECT round_id, executor FROM executor_rounds
              WHERE round_id IN ('vocab-impl-r0', 'vocab-refresh-r0', 'vocab-nm-provable-r0')
              ORDER BY round_id`,
          )
          .all(),
      ).toEqual([
        { round_id: "vocab-impl-r0", executor: "goal-loop" },
        { round_id: "vocab-nm-provable-r0", executor: "no-mistakes" },
        { round_id: "vocab-refresh-r0", executor: "one-shot" },
      ]);
    } finally {
      db?.close();
      if (previousConfig === undefined) {
        delete process.env.MOMENTUM_EXECUTOR_CONFIG;
      } else {
        process.env.MOMENTUM_EXECUTOR_CONFIG = previousConfig;
      }
    }
  });

  it("converts only provably mirrored terminal no-mistakes attempts to delegate-supervisor", () => {
    const dataDir = seedPreRenameDataDir();
    const db = openDb(dataDir);
    try {
      const converted = db
        .prepare(
          `SELECT executor, legacy_provenance FROM executor_attempts
            WHERE attempt_id = 'vocab-nm-provable'`,
        )
        .get() as Record<string, unknown>;
      expect(converted.executor).toBe("delegate-supervisor");
      // The conversion records its authoritative origin while preserving a
      // conflicting recorded value under a migration-specific key.
      expect(JSON.parse(String(converted.legacy_provenance))).toEqual({
        source: "legacy_invocation_row",
        legacyExecutor: "no-mistakes",
        legacyExecutorBeforeNam02VocabularyMigration: "recorded-value",
      });
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_rounds
              WHERE attempt_id = 'vocab-nm-provable'`,
          )
          .get(),
      ).toEqual({ executor: "delegate-supervisor" });

      // A live attempt stays no-mistakes even with a provable mirror
      // checkpoint; a terminal attempt whose checkpoint payload lacks the
      // external run identity fields stays too, with provenance untouched.
      expect(
        db
          .prepare(
            `SELECT attempt_id, executor, legacy_provenance
               FROM executor_attempts
              WHERE attempt_id IN ('vocab-nm-live', 'vocab-nm-unprovable')
              ORDER BY attempt_id`,
          )
          .all(),
      ).toEqual([
        {
          attempt_id: "vocab-nm-live",
          executor: "no-mistakes",
          legacy_provenance: null,
        },
        {
          attempt_id: "vocab-nm-unprovable",
          executor: "no-mistakes",
          legacy_provenance: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("changes zero rows when the migrated database is opened again", () => {
    const dataDir = seedPreRenameDataDir();
    const first = openDb(dataDir);
    const snapshot = (db: DatabaseSync) => ({
      runs: db.prepare("SELECT * FROM workflow_runs ORDER BY id").all(),
      steps: db
        .prepare("SELECT * FROM workflow_steps ORDER BY run_id, step_id")
        .all(),
      approvals: db
        .prepare("SELECT * FROM workflow_approvals ORDER BY run_id, boundary")
        .all(),
      gates: db.prepare("SELECT * FROM workflow_gates ORDER BY gate_id").all(),
      stepDefinitions: db
        .prepare(
          `SELECT * FROM step_definitions
            ORDER BY definition_key, definition_version, step_key`,
        )
        .all(),
      executorDefinitions: db
        .prepare("SELECT * FROM executor_definitions ORDER BY executor_key")
        .all(),
      attempts: db
        .prepare("SELECT * FROM executor_attempts ORDER BY attempt_id")
        .all(),
      rounds: db
        .prepare("SELECT * FROM executor_rounds ORDER BY round_id")
        .all(),
      checkpoints: db
        .prepare("SELECT * FROM executor_checkpoints ORDER BY checkpoint_id")
        .all(),
    });
    const before = snapshot(first);
    first.close();

    const second = openDb(dataDir);
    try {
      expect(snapshot(second)).toEqual(before);
    } finally {
      second.close();
    }
  });

  it("keeps a third-party one-shot identity untouched everywhere while goal-loop still renames", () => {
    const dataDir = seedPreRenameDataDir({ claimOneShotDefinition: true });
    const db = openDb(dataDir);
    try {
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_attempts
              WHERE attempt_id = 'vocab-refresh'`,
          )
          .get(),
      ).toEqual({ executor: "one-shot" });
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_rounds
              WHERE round_id = 'vocab-refresh-r0'`,
          )
          .get(),
      ).toEqual({ executor: "one-shot" });
      expect(
        db
          .prepare(
            `SELECT executor_key, executor FROM executor_definitions
              ORDER BY executor_key`,
          )
          .all(),
      ).toEqual([
        { executor_key: "custom-loop", executor: "agent-loop" },
        { executor_key: "one-shot", executor: "one-shot" },
      ]);
      // The unclaimed rename is unaffected by the guard.
      expect(
        db
          .prepare(
            `SELECT executor FROM executor_attempts
              WHERE attempt_id = 'vocab-impl'`,
          )
          .get(),
      ).toEqual({ executor: "agent-loop" });
    } finally {
      db.close();
    }
  });
});
