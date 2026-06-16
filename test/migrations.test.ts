import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import { applyQueueMigrations } from "../src/adapters/db/migrations.js";

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
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
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
        "error"
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
        "updated_at"
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
        (row) => row.name
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
        "canceled_at"
      ]) {
        expect(
          updateIntentColumns,
          `missing update_intents column: ${col}`
        ).toContain(col);
      }

      const evidenceColumns = getColumns(db, "evidence_records").map(
        (row) => row.name
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
        "updated_at"
      ]) {
        expect(
          evidenceColumns,
          `missing evidence_records column: ${col}`
        ).toContain(col);
      }

      const sourceItemColumns = getColumns(db, "source_items").map((row) => row.name);
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
        "updated_at"
      ]) {
        expect(sourceItemColumns, `missing source_items column: ${col}`).toContain(col);
      }

      const daemonColumns = getColumns(db, "daemon_runs").map(
        (row) => row.name
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
        "updated_at"
      ]) {
        expect(daemonColumns, `missing daemon_runs column: ${col}`).toContain(
          col
        );
      }

      const indexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
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

      expect(updateIntentColumns, "missing update_intents column: apply_state")
        .toContain("apply_state");

      expect(tableNames(db)).toContain("intent_apply_audits");
      const auditColumns = getColumns(db, "intent_apply_audits").map(
        (row) => row.name
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
        "updated_at"
      ]) {
        expect(
          auditColumns,
          `missing intent_apply_audits column: ${col}`
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
      const auditColumns = getColumns(db, "intent_apply_audits").map(
        (row) => row.name.toLowerCase()
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
        "headers"
      ];
      for (const col of auditColumns) {
        for (const banned of forbidden) {
          expect(
            col,
            `intent_apply_audits should not include credential/header column "${col}"`
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
      pre.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, intent_type, payload_json, reason,
            status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(
        "intent_legacy_1",
        "linear",
        "source_satisfied",
        "{}",
        "preserved",
        "legacy-key-1",
        1,
        2
      );
    } finally {
      pre.close();
    }

    const upgraded = openDb(dataDir);
    try {
      const updateIntentCols = getColumns(upgraded, "update_intents").map(
        (row) => row.name
      );
      expect(updateIntentCols).toContain("apply_state");
      expect(tableNames(upgraded)).toContain("intent_apply_audits");
      const preserved = upgraded
        .prepare(
          `SELECT id, status, apply_state, reason
             FROM update_intents WHERE id = 'intent_legacy_1'`
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
      pre.prepare(
        `INSERT INTO evidence_records
           (id, source, type, format_version, artifact_path, external_id,
            occurred_at, summary, metadata_json, ingest_key,
            created_at, updated_at)
         VALUES ('evidence_record_legacy', 'agent-workflow', 'plan_created', 1,
                 '/tmp/.agent-workflows/cwfp-legacy/plan.json', 'cwfp-legacy',
                 1000, 'Legacy plan', '{}',
                 'agent-workflow:cwfp-legacy:plan_created', 1, 2)`
      ).run();
    } finally {
      pre.close();
    }

    const upgraded = openDb(dataDir);
    try {
      const cols = getColumns(upgraded, "evidence_records").map(
        (row) => row.name
      );
      expect(cols).toContain("run_id");
      expect(cols).toContain("step_id");

      const byName = new Map(
        getColumns(upgraded, "evidence_records").map((row) => [row.name, row])
      );
      // Typed linkage is additive and nullable.
      expect(byName.get("run_id")?.notnull).toBe(0);
      expect(byName.get("step_id")?.notnull).toBe(0);

      const preserved = upgraded
        .prepare(
          `SELECT id, source, type, external_id, run_id, step_id
             FROM evidence_records WHERE id = 'evidence_record_legacy'`
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
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toContain("idx_evidence_records_run_step");
    } finally {
      upgraded.close();
    }
  });

  it("typed-linkage column upgrade is idempotent across repeated openDb invocations", () => {
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

  it("is idempotent across repeated openDb invocations", () => {
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
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g1", "Legacy goal", "momentum/legacy", "/tmp/legacy", 1, 2);
      m1.prepare(
        `INSERT INTO jobs (id, goal_id, artifact_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("j1", "g1", "/tmp/legacy/iterations/1", 3, 4);
      m1.prepare(
        `INSERT INTO events (goal_id, type, payload, created_at)
         VALUES (?, ?, ?, ?)`
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
          "SELECT id, idempotency_key, worker_id FROM jobs WHERE id = 'j1'"
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
         VALUES ('g', 't', 'b', '/tmp/x', 1, 1)`
      ).run();
      const insert = db.prepare(
        `INSERT INTO jobs
           (id, goal_id, type, iteration, state, attempt_count,
            artifact_path, idempotency_key, created_at, updated_at)
         VALUES (?, 'g', 'goal_iteration', 1, 'pending', 0,
                 '/tmp/x/it/1', ?, 1, 1)`
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
         VALUES (?, ?, 'h', 'g', 1, 'j', ?, 1, 1, 100, 1)`
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
         VALUES (?, ?, ?, '{}', ?, 'pending', ?, 1, 1)`
      );
      insert.run("i1", "linear", "source_satisfied", "first", "key-1");
      expect(() =>
        insert.run("i2", "linear", "source_satisfied", "duplicate", "key-1")
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
        "idempotency_key"
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
          "batch_group",
          "batch_role",
          "needs_manual_recovery",
          "manual_recovery_reason",
          "manual_recovery_at",
          "started_at",
          "finished_at",
          "created_at",
          "updated_at"
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
          "updated_at"
        ]) {
          expect(cols, `missing workflow_steps column: ${col}`).toContain(col);
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r1', 'pending', 'agent-workflows', '{}', 0, 1, 1)`
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_steps
             (run_id, step_id, kind, state, step_order, required,
              created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, 1, 1, 1)`
        );
        insert.run("cwfp-r1", "s1", "preflight", 1);
        // composite primary key rejects duplicates on (run_id, step_id)
        expect(() =>
          insert.run("cwfp-r1", "s1", "implementation", 2)
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
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
        const cols = getColumns(db, "workflow_approvals").map((row) => row.name);
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
          "updated_at"
        ]) {
          expect(cols, `missing workflow_approvals column: ${col}`).toContain(
            col
          );
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r2', 'pending', 'agent-workflows', '{}', 0, 1, 1)`
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_approvals
             (run_id, boundary, actor, phrase, artifact_path,
              artifact_digest, recorded_at, created_at, updated_at)
           VALUES (?, ?, 'op', ?, ?, ?, 1, 1, 1)`
        );
        insert.run(
          "cwfp-r2",
          "implementation",
          "implementation",
          ".agent-workflows/cwfp-r2/approval-implementation.json",
          "sha256:abc"
        );
        expect(() =>
          insert.run(
            "cwfp-r2",
            "implementation",
            "implementation",
            ".agent-workflows/cwfp-r2/approval-implementation.json",
            "sha256:abc"
          )
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
          "updated_at"
        ]) {
          expect(cols, `missing workflow_leases column: ${col}`).toContain(col);
        }

        db.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-r3', 'pending', 'agent-workflows', '{}', 0, 1, 1)`
        ).run();
        const insert = db.prepare(
          `INSERT INTO workflow_leases
             (run_id, lease_kind, holder, acquired_at, expires_at,
              heartbeat_at, stale_policy, created_at, updated_at)
           VALUES (?, ?, ?, 1, 100, 1, 'auto-release', 1, 1)`
        );
        insert.run("cwfp-r3", "monitor", "cron:coding-workflow-monitor:cwfp-r3");
        // composite primary key rejects duplicates on (run_id, lease_kind)
        expect(() =>
          insert.run("cwfp-r3", "monitor", "another")
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
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
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
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
          "idx_workflow_leases_expires_at"
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
               VALUES ('cwfp-missing', 's1', 'preflight', 'pending', 1, 1, 1, 1)`
            )
            .run()
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb invocations for workflow tables", () => {
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
        pre.prepare(
          `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run("g-pre-m7", "pre-m7 goal", "main", "/tmp/pre-m7", 1, 2);
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
          "chat_body"
        ];
        for (const table of [
          "workflow_runs",
          "workflow_steps",
          "workflow_approvals",
          "workflow_leases"
        ]) {
          const cols = getColumns(db, table).map((row) => row.name.toLowerCase());
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/header/chat column "${col}"`
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
          "skill_revision"
        ]) {
          expect(byName.has(col), `missing workflow_runs column: ${col}`).toBe(
            true
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
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
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
           VALUES ('cwfp-defaults', 'pending', 'agent-workflows', '{}', 0, 1, 1)`
        ).run();
        const row = db
          .prepare(
            `SELECT repo_path, objective, issue_scope_json, route_json,
                    approval_boundary, skill_revision,
                    monitor_last_seen_state, monitor_terminal, monitor_step,
                    monitor_last_seen_digest, monitor_last_emitted_digest
               FROM workflow_runs WHERE id = 'cwfp-defaults'`
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
        pre.prepare(
          `INSERT INTO workflow_runs
             (id, state, source, plan_json, needs_manual_recovery,
              created_at, updated_at)
           VALUES ('cwfp-legacy', 'pending', 'agent-workflows', '{"legacy":true}',
                   0, 7, 8)`
        ).run();
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        const cols = getColumns(upgraded, "workflow_runs").map(
          (row) => row.name
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
          "monitor_last_emitted_digest"
        ]) {
          expect(cols).toContain(col);
        }
        const preserved = upgraded
          .prepare(
            `SELECT id, state, plan_json, issue_scope_json, route_json,
                    repo_path, approval_boundary
               FROM workflow_runs WHERE id = 'cwfp-legacy'`
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

    it("identity-column upgrade is idempotent across repeated openDb invocations", () => {
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
          (row) => row.name
        );
        for (const col of [
          "key",
          "version",
          "title",
          "created_at",
          "updated_at"
        ]) {
          expect(
            cols,
            `missing workflow_definitions column: ${col}`
          ).toContain(col);
        }

        const insert = db.prepare(
          `INSERT INTO workflow_definitions
             (key, version, title, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1)`
        );
        insert.run("coding-workflow", 1, "OpenClaw Coding Workflow");
        // composite primary key rejects duplicates on (key, version)
        expect(() =>
          insert.run("coding-workflow", 1, "duplicate")
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
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
          "step_order",
          "required",
          "created_at",
          "updated_at"
        ]) {
          expect(cols, `missing step_definitions column: ${col}`).toContain(
            col
          );
        }

        db.prepare(
          `INSERT INTO workflow_definitions
             (key, version, title, created_at, updated_at)
           VALUES ('coding-workflow', 1, 'OpenClaw Coding Workflow', 1, 1)`
        ).run();
        const insert = db.prepare(
          `INSERT INTO step_definitions
             (definition_key, definition_version, step_key, kind, executor,
              step_order, required, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`
        );
        insert.run(
          "coding-workflow",
          1,
          "preflight",
          "preflight",
          "one-shot",
          0
        );
        // composite primary key rejects duplicate step_key within a version
        expect(() =>
          insert.run(
            "coding-workflow",
            1,
            "preflight",
            "preflight",
            "goal-loop",
            9
          )
        ).toThrow(/UNIQUE|PRIMARY KEY/i);
        // distinct step_key under the same definition version is fine
        insert.run(
          "coding-workflow",
          1,
          "implementation",
          "implementation",
          "goal-loop",
          1
        );
      } finally {
        db.close();
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
                       'one-shot', 0, 1, 1, 1)`
            )
            .run()
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
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(indexes).toContain("idx_step_definitions_definition");
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb invocations for definition tables", () => {
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
        pre.prepare(
          `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run("g-pre-m10", "pre-m10 goal", "main", "/tmp/pre-m10", 1, 2);
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
          "chat_body"
        ];
        for (const table of ["workflow_definitions", "step_definitions"]) {
          const cols = getColumns(db, table).map((row) =>
            row.name.toLowerCase()
          );
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/chat column "${col}"`
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
      "executor_invocations",
      "executor_rounds",
      "executor_artifacts",
      "executor_checkpoints",
      "executor_findings",
      "executor_decisions"
    ];

    // Seed the minimal workflow_runs / workflow_steps parents the executor
    // spine FKs hang below.
    function seedRunAndStep(
      db: DatabaseSync,
      runId = "run-x",
      stepId = "step-x"
    ): void {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, plan_json, needs_manual_recovery,
            created_at, updated_at)
         VALUES (?, 'pending', 'agent-workflows', '{}', 0, 1, 1)`
      ).run(runId);
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, required,
            created_at, updated_at)
         VALUES (?, ?, 'implementation', 'pending', 0, 1, 1, 1)`
      ).run(runId, stepId);
    }

    function seedInvocation(db: DatabaseSync): void {
      seedRunAndStep(db);
      db.prepare(
        `INSERT INTO executor_invocations
           (invocation_id, workflow_run_id, step_run_id, step_key,
            executor_family, state, attempt, created_at, updated_at)
         VALUES ('inv-x', 'run-x', 'step-x', 'implementation',
                 'goal-loop', 'pending', 1, 1, 1)`
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
          (row) => row.name
        );
        // The full contract "Round Schema" identity / execution / result fields.
        for (const col of [
          "round_id",
          "invocation_id",
          "workflow_run_id",
          "step_run_id",
          "step_key",
          "executor_family",
          "attempt",
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
          "updated_at"
        ]) {
          expect(roundCols, `missing executor_rounds column: ${col}`).toContain(
            col
          );
        }

        const invocationCols = getColumns(db, "executor_invocations").map(
          (row) => row.name
        );
        for (const col of [
          "invocation_id",
          "workflow_run_id",
          "step_run_id",
          "step_key",
          "executor_family",
          "state",
          "attempt",
          "started_at",
          "heartbeat_at",
          "finished_at",
          "created_at",
          "updated_at"
        ]) {
          expect(
            invocationCols,
            `missing executor_invocations column: ${col}`
          ).toContain(col);
        }

        const definitionCols = getColumns(db, "executor_definitions").map(
          (row) => row.name
        );
        for (const col of [
          "executor_key",
          "family",
          "agent_provider",
          "model",
          "effort",
          "timeout_ms",
          "max_rounds",
          "policy_envelope",
          "created_at",
          "updated_at"
        ]) {
          expect(
            definitionCols,
            `missing executor_definitions column: ${col}`
          ).toContain(col);
        }

        const decisionCols = getColumns(db, "executor_decisions").map(
          (row) => row.name
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
              "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        for (const idx of [
          "idx_executor_invocations_run",
          "idx_executor_invocations_step",
          "idx_executor_invocations_state",
          "idx_executor_rounds_invocation",
          "idx_executor_rounds_run",
          "idx_executor_rounds_step",
          "idx_executor_rounds_invocation_index",
          "idx_executor_artifacts_round",
          "idx_executor_checkpoints_round",
          "idx_executor_checkpoints_round_sequence",
          "idx_executor_findings_round",
          "idx_executor_decisions_round"
        ]) {
          expect(indexes, `missing index: ${idx}`).toContain(idx);
        }
      } finally {
        db.close();
      }
    });

    it("enforces the unique round ordering per (invocation_id, round_index)", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        seedInvocation(db);
        const insertRound = db.prepare(
          `INSERT INTO executor_rounds
             (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
              executor_family, attempt, round_index, state,
              created_at, updated_at)
           VALUES (?, 'inv-x', 'run-x', 'step-x', 'implementation',
                   'goal-loop', 1, ?, 'pending', 1, 1)`
        );
        insertRound.run("round-a", 0);
        // the same round_index under one invocation collides
        expect(() => insertRound.run("round-b", 0)).toThrow(/UNIQUE/i);
        // a distinct index under the same invocation is fine
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
        seedInvocation(db);
        db.prepare(
          `INSERT INTO executor_rounds
             (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
              executor_family, attempt, round_index, state,
              created_at, updated_at)
           VALUES ('round-x', 'inv-x', 'run-x', 'step-x', 'implementation',
                   'goal-loop', 1, 0, 'pending', 1, 1)`
        ).run();
        const insertCheckpoint = db.prepare(
          `INSERT INTO executor_checkpoints
             (checkpoint_id, round_id, sequence, stage, created_at)
           VALUES (?, 'round-x', ?, 'prepare', 1)`
        );
        insertCheckpoint.run("c-a", 0);
        expect(() => insertCheckpoint.run("c-b", 0)).toThrow(/UNIQUE/i);
        insertCheckpoint.run("c-c", 1);
      } finally {
        db.close();
      }
    });

    it("rejects an invocation whose (workflow_run_id, step_run_id) has no workflow_steps row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        expect(() =>
          db
            .prepare(
              `INSERT INTO executor_invocations
                 (invocation_id, workflow_run_id, step_run_id, step_key,
                  executor_family, state, attempt, created_at, updated_at)
               VALUES ('inv-orphan', 'run-missing', 'step-missing',
                       'implementation', 'goal-loop', 'pending', 1, 1, 1)`
            )
            .run()
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("rejects a round whose invocation_id has no executor_invocations row", () => {
      const dataDir = makeTempDir();
      const db = openDb(dataDir);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        seedRunAndStep(db);
        expect(() =>
          db
            .prepare(
              `INSERT INTO executor_rounds
                 (round_id, invocation_id, workflow_run_id, step_run_id,
                  step_key, executor_family, attempt, round_index, state,
                  created_at, updated_at)
               VALUES ('round-orphan', 'inv-missing', 'run-x', 'step-x',
                       'implementation', 'goal-loop', 1, 0, 'pending', 1, 1)`
            )
            .run()
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
                       '/runs/x/result.json', 1)`
            )
            .run()
        ).toThrow(/FOREIGN KEY/i);
      } finally {
        db.close();
      }
    });

    it("is idempotent across repeated openDb invocations for executor tables", () => {
      const dataDir = makeTempDir();
      const a = openDb(dataDir);
      const before = new Map(
        EXECUTOR_TABLES.map((table) => [table, getColumns(a, table).length])
      );
      a.close();

      const b = openDb(dataDir);
      try {
        for (const table of EXECUTOR_TABLES) {
          expect(
            getColumns(b, table),
            `column count drifted for ${table}`
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
        pre.prepare(
          `INSERT INTO goals (id, title, branch, artifact_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          "g-pre-executor",
          "pre-executor goal",
          "main",
          "/tmp/pre-exec",
          1,
          2
        );
      } finally {
        pre.close();
      }

      const upgraded = openDb(dataDir);
      try {
        for (const table of EXECUTOR_TABLES) {
          expect(tableNames(upgraded), `missing table: ${table}`).toContain(
            table
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
          "chat_body"
        ];
        for (const table of EXECUTOR_TABLES) {
          const cols = getColumns(db, table).map((row) =>
            row.name.toLowerCase()
          );
          for (const col of cols) {
            for (const banned of forbidden) {
              expect(
                col,
                `${table} should not include credential/header/chat column "${col}"`
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
