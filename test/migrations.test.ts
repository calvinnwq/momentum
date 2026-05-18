import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { applyQueueMigrations } from "../src/migrations.js";

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
      expect(indexes).toContain("idx_update_intents_idempotency_key");
      expect(indexes).toContain("idx_update_intents_status");
      expect(indexes).toContain("idx_update_intents_goal");
      expect(indexes).toContain("idx_update_intents_source_item");
      expect(indexes).toContain("idx_update_intents_evidence");
      expect(indexes).toContain("idx_update_intents_adapter_target");
      expect(indexes).toContain("idx_update_intents_created_at");
    } finally {
      db.close();
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
});
