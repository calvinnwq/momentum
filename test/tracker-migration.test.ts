import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, openExistingDbMigratedReadOnly } from "../src/adapters/db.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-tracker-migration-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
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

function indexNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

// The exact pre-rename (source-vocabulary) durable schema for the tracker
// graph, plus the unrelated-source tables the migration must not touch.
// Split in two: the core source graph existed before evidence_records and
// update_intents, so an older supported database can carry the core alone.
const LEGACY_SOURCE_CORE_SCHEMA = `
PRAGMA foreign_keys = ON;
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

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
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

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_key TEXT,
  url TEXT,
  title TEXT NOT NULL,
  status TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_observed_at INTEGER NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_source_items_adapter_external
  ON source_items(adapter_kind, external_id);

CREATE INDEX idx_source_items_goal_id
  ON source_items(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX idx_source_items_adapter_kind
  ON source_items(adapter_kind);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  adapter_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_source_snapshots_item_observed
  ON source_snapshots(source_item_id, observed_at);

CREATE TABLE source_reconciliation_runs (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_upserted INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_source_reconciliation_runs_adapter_started
  ON source_reconciliation_runs(adapter_kind, started_at);
`;

const LEGACY_SOURCE_DEPENDENTS_SCHEMA = `
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
  goal_id TEXT REFERENCES goals(id),
  source_item_id TEXT REFERENCES source_items(id),
  run_id TEXT,
  step_id TEXT,
  ingest_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_evidence_records_ingest_key
  ON evidence_records(ingest_key);

CREATE INDEX idx_evidence_records_goal
  ON evidence_records(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX idx_evidence_records_source_item
  ON evidence_records(source_item_id) WHERE source_item_id IS NOT NULL;

CREATE INDEX idx_evidence_records_source_type
  ON evidence_records(source, type);

CREATE INDEX idx_evidence_records_occurred_at
  ON evidence_records(occurred_at);

CREATE INDEX idx_evidence_records_run_step
  ON evidence_records(run_id, step_id) WHERE run_id IS NOT NULL;

CREATE TABLE update_intents (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  target_external_id TEXT,
  intent_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  source_item_id TEXT REFERENCES source_items(id),
  evidence_record_id TEXT REFERENCES evidence_records(id),
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  decision_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,
  skipped_at INTEGER,
  canceled_at INTEGER,
  apply_state TEXT NOT NULL DEFAULT 'idle'
) STRICT;

CREATE UNIQUE INDEX idx_update_intents_idempotency_key
  ON update_intents(idempotency_key);

CREATE INDEX idx_update_intents_status
  ON update_intents(status);

CREATE INDEX idx_update_intents_goal
  ON update_intents(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX idx_update_intents_source_item
  ON update_intents(source_item_id) WHERE source_item_id IS NOT NULL;

CREATE INDEX idx_update_intents_evidence
  ON update_intents(evidence_record_id) WHERE evidence_record_id IS NOT NULL;

CREATE INDEX idx_update_intents_adapter_target
  ON update_intents(adapter_kind, target_external_id);

CREATE INDEX idx_update_intents_created_at
  ON update_intents(created_at);
`;

const LEGACY_SOURCE_SCHEMA =
  LEGACY_SOURCE_CORE_SCHEMA + LEGACY_SOURCE_DEPENDENTS_SCHEMA;

type SeededGraph = {
  goalId: string;
  linkedItemId: string;
  unlinkedItemId: string;
  snapshotIds: string[];
  reconciliationRunId: string;
  evidenceId: string;
  intentId: string;
  workflowRunId: string;
};

function seedLegacySourceGraph(dataDir: string): SeededGraph {
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  db.exec(LEGACY_SOURCE_SCHEMA);
  const goalId = "goal_tracker_mig_1";
  db.prepare(
    `INSERT INTO goals (id, title, branch, artifact_dir, state, created_at, updated_at)
     VALUES (?, 'Tracker migration goal', 'main', '/tmp/goal-artifacts', 'completed', 1000, 1001)`,
  ).run(goalId);

  const linkedItemId = "source_item_linked-1";
  const unlinkedItemId = "source_item_unlinked-2";
  const insertItem = db.prepare(
    `INSERT INTO source_items
       (id, adapter_kind, external_id, external_key, url, title, status,
        metadata_json, last_observed_at, goal_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    linkedItemId,
    "linear",
    "ext-uuid-1",
    "NGX-1",
    "https://linear.app/x/NGX-1",
    "Linked item",
    "In Progress",
    '{"team":"NGX"}',
    2000,
    goalId,
    2001,
    2002,
  );
  insertItem.run(
    unlinkedItemId,
    "linear",
    "ext-uuid-2",
    "NGX-2",
    null,
    "Unlinked item",
    "Done",
    "{}",
    2100,
    null,
    2101,
    2102,
  );

  const snapshotIds = ["source_snapshot_a", "source_snapshot_b"];
  const insertSnapshot = db.prepare(
    `INSERT INTO source_snapshots
       (id, source_item_id, adapter_kind, external_id, observed_at, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSnapshot.run(
    snapshotIds[0]!,
    linkedItemId,
    "linear",
    "ext-uuid-1",
    2000,
    '{"status":"In Progress"}',
    2001,
  );
  insertSnapshot.run(
    snapshotIds[1]!,
    linkedItemId,
    "linear",
    "ext-uuid-1",
    2200,
    '{"status":"Done"}',
    2201,
  );

  const reconciliationRunId = "source_reconciliation_run_1";
  db.prepare(
    `INSERT INTO source_reconciliation_runs
       (id, adapter_kind, state, started_at, finished_at, error, items_seen,
        items_upserted, metadata_json, created_at, updated_at)
     VALUES (?, 'linear', 'succeeded', 3000, 3010, NULL, 2, 2,
             '{"paginationStopped":{"reason":"complete","pageIndex":1}}', 3000, 3010)`,
  ).run(reconciliationRunId);

  const evidenceId = "evidence_tracker_mig_1";
  db.prepare(
    `INSERT INTO evidence_records
       (id, source, type, format_version, artifact_path, external_id, occurred_at,
        summary, metadata_json, goal_id, source_item_id, run_id, step_id,
        ingest_key, created_at, updated_at)
     VALUES (?, 'workflow', 'validate_complete', 1, '/tmp/evidence.json', 'ext-uuid-1',
             4000, 'verification passed', '{}', ?, ?, NULL, NULL,
             'ingest-key-1', 4001, 4002)`,
  ).run(evidenceId, goalId, linkedItemId);

  const intentId = "update_intent_tracker_mig_1";
  db.prepare(
    `INSERT INTO update_intents
       (id, adapter_kind, target_external_id, intent_type, payload_json, reason,
        goal_id, source_item_id, evidence_record_id, status, idempotency_key,
        created_at, updated_at)
     VALUES (?, 'linear', 'ext-uuid-1', 'source_satisfied', '{"sourceItemId":"source_item_linked-1"}',
             'goal completed', ?, ?, ?, 'pending',
             'linear:ext-uuid-1:source_satisfied:goal_tracker_mig_1', 5000, 5001)`,
  ).run(intentId, goalId, linkedItemId, evidenceId);

  const workflowRunId = "wf_tracker_mig_1";
  db.prepare(
    `INSERT INTO workflow_runs
         (id, state, source, source_artifact_path, created_at, updated_at)
       VALUES (?, 'succeeded', 'workflow-definition', '/tmp/wf-artifact.json', 6000, 6001)`,
  ).run(workflowRunId);
  db.close();

  return {
    goalId,
    linkedItemId,
    unlinkedItemId,
    snapshotIds,
    reconciliationRunId,
    evidenceId,
    intentId,
    workflowRunId,
  };
}

describe("tracker schema rename migration", () => {
  it("creates tracker-named tables, columns, and indexes on a fresh data dir", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).toContain("tracker_snapshots");
      expect(tables).toContain("tracker_reconciliation_runs");
      expect(tables).not.toContain("source_items");
      expect(tables).not.toContain("source_snapshots");
      expect(tables).not.toContain("source_reconciliation_runs");

      expect(columnNames(db, "tracker_snapshots")).toContain("tracker_item_id");
      expect(columnNames(db, "evidence_records")).toContain("tracker_item_id");
      expect(columnNames(db, "evidence_records")).not.toContain(
        "source_item_id",
      );
      // The unrelated evidence source label column stays.
      expect(columnNames(db, "evidence_records")).toContain("source");
      expect(columnNames(db, "intents")).toContain("tracker_item_id");
      expect(columnNames(db, "intents")).not.toContain("source_item_id");
      // Unrelated workflow provenance columns stay.
      expect(columnNames(db, "workflow_runs")).toContain("source");
      expect(columnNames(db, "workflow_runs")).toContain(
        "source_artifact_path",
      );

      const indexes = indexNames(db);
      for (const name of [
        "idx_tracker_items_adapter_external",
        "idx_tracker_items_goal_id",
        "idx_tracker_items_adapter_kind",
        "idx_tracker_snapshots_item_observed",
        "idx_tracker_reconciliation_runs_adapter_started",
        "idx_evidence_records_tracker_item",
        "idx_intents_tracker_item",
        // Unrelated evidence-source index keeps its name.
        "idx_evidence_records_source_type",
      ]) {
        expect(indexes, `missing index: ${name}`).toContain(name);
      }
      expect(indexes).not.toContain("idx_source_items_adapter_external");
      expect(indexes).not.toContain("idx_evidence_records_source_item");
      expect(indexes).not.toContain("idx_update_intents_source_item");
    } finally {
      db.close();
    }
  });

  it("losslessly migrates a pre-rename database with the complete tracker graph", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      expect(tables).not.toContain("source_snapshots");
      expect(tables).not.toContain("source_reconciliation_runs");

      const items = db
        .prepare("SELECT * FROM tracker_items ORDER BY id")
        .all() as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const linked = items.find((row) => row.id === seededBefore.linkedItemId)!;
      expect(linked).toBeDefined();
      expect(linked.adapter_kind).toBe("linear");
      expect(linked.external_id).toBe("ext-uuid-1");
      expect(linked.external_key).toBe("NGX-1");
      expect(linked.goal_id).toBe(seededBefore.goalId);
      expect(linked.metadata_json).toBe('{"team":"NGX"}');
      expect(linked.last_observed_at).toBe(2000);
      expect(linked.created_at).toBe(2001);
      expect(linked.updated_at).toBe(2002);

      const snapshots = db
        .prepare("SELECT * FROM tracker_snapshots ORDER BY observed_at ASC")
        .all() as Array<Record<string, unknown>>;
      expect(snapshots.map((row) => row.id)).toEqual(seededBefore.snapshotIds);
      for (const snapshot of snapshots) {
        expect(snapshot.tracker_item_id).toBe(seededBefore.linkedItemId);
      }

      const reconciliation = db
        .prepare("SELECT * FROM tracker_reconciliation_runs")
        .all() as Array<Record<string, unknown>>;
      expect(reconciliation).toHaveLength(1);
      expect(reconciliation[0]!.id).toBe(seededBefore.reconciliationRunId);
      expect(reconciliation[0]!.items_seen).toBe(2);
      expect(reconciliation[0]!.metadata_json).toBe(
        '{"paginationStopped":{"reason":"complete","pageIndex":1}}',
      );

      const evidence = db
        .prepare("SELECT * FROM evidence_records WHERE id = ?")
        .get(seededBefore.evidenceId) as Record<string, unknown>;
      expect(evidence.tracker_item_id).toBe(seededBefore.linkedItemId);
      expect(evidence.source).toBe("workflow");
      expect(evidence.ingest_key).toBe("ingest-key-1");

      const intent = db
        .prepare("SELECT * FROM intents WHERE id = ?")
        .get(seededBefore.intentId) as Record<string, unknown>;
      expect(intent.tracker_item_id).toBe(seededBefore.linkedItemId);
      // Durable intent identity and payload bytes stay frozen.
      expect(intent.intent_type).toBe("source_satisfied");
      expect(intent.idempotency_key).toBe(
        "linear:ext-uuid-1:source_satisfied:goal_tracker_mig_1",
      );
      expect(intent.payload_json).toBe(
        '{"sourceItemId":"source_item_linked-1"}',
      );

      // Unrelated workflow provenance is untouched.
      const workflowRun = db
        .prepare(
          "SELECT source, source_artifact_path FROM workflow_runs WHERE id = ?",
        )
        .get(seededBefore.workflowRunId) as Record<string, unknown>;
      expect(workflowRun.source).toBe("workflow-definition");
      expect(workflowRun.source_artifact_path).toBe("/tmp/wf-artifact.json");

      // Uniqueness constraint survives under the tracker-named index.
      const indexes = indexNames(db);
      expect(indexes).toContain("idx_tracker_items_adapter_external");
      expect(indexes).not.toContain("idx_source_items_adapter_external");
      expect(() =>
        db
          .prepare(
            `INSERT INTO tracker_items
               (id, adapter_kind, external_id, title, metadata_json,
                last_observed_at, created_at, updated_at)
             VALUES ('dup', 'linear', 'ext-uuid-1', 'dup', '{}', 1, 1, 1)`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);

      // Foreign keys are enforced against the renamed parent table.
      expect(() =>
        db
          .prepare(
            `INSERT INTO tracker_snapshots
               (id, tracker_item_id, adapter_kind, external_id, observed_at,
                snapshot_json, created_at)
             VALUES ('orphan', 'missing-item', 'linear', 'x', 1, '{}', 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // The dependent tables' renamed columns point at the renamed parent:
      // SQLite's rename rewrote the foreign-key clauses to tracker_items.
      for (const table of ["evidence_records", "intents"]) {
        const foreignKeys = db
          .prepare(`PRAGMA foreign_key_list(${table})`)
          .all() as Array<{ table: string; from: string }>;
        const trackerFk = foreignKeys.find(
          (fk) => fk.from === "tracker_item_id",
        );
        expect(
          trackerFk,
          `missing tracker_item_id FK on ${table}`,
        ).toBeDefined();
        expect(trackerFk!.table).toBe("tracker_items");
      }

      // The rewritten foreign keys are live: dangling tracker-item references
      // are rejected while real ones insert cleanly.
      expect(() =>
        db
          .prepare(
            `INSERT INTO evidence_records
               (id, source, type, occurred_at, summary, tracker_item_id,
                ingest_key, created_at, updated_at)
             VALUES ('evidence_dangling', 'workflow', 'validate_complete', 1,
                     'dangling', 'missing-item', 'ingest-key-dangling', 1, 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO intents
               (id, adapter_kind, intent_type, reason, tracker_item_id,
                idempotency_key, created_at, updated_at)
             VALUES ('intent_dangling', 'linear', 'source_satisfied', 'dangling',
                     'missing-item', 'idem-dangling', 1, 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      db.prepare(
        `INSERT INTO evidence_records
           (id, source, type, occurred_at, summary, tracker_item_id,
            ingest_key, created_at, updated_at)
         VALUES ('evidence_linked', 'workflow', 'validate_complete', 1,
                 'linked', ?, 'ingest-key-linked', 1, 1)`,
      ).run(seededBefore.linkedItemId);

      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("migrates an older database that has the source graph but no evidence_records or update_intents", () => {
    const dataDir = makeTempDir();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(LEGACY_SOURCE_CORE_SCHEMA);
    raw
      .prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, title, metadata_json,
            last_observed_at, created_at, updated_at)
         VALUES ('source_item_old_1', 'linear', 'ext-old-1', 'Old item', '{}', 1, 1, 1)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO source_snapshots
           (id, source_item_id, adapter_kind, external_id, observed_at,
            snapshot_json, created_at)
         VALUES ('source_snapshot_old_1', 'source_item_old_1', 'linear',
                 'ext-old-1', 1, '{}', 1)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO source_reconciliation_runs
           (id, adapter_kind, state, started_at, created_at, updated_at)
         VALUES ('source_reconciliation_run_old_1', 'linear', 'succeeded', 1, 1, 1)`,
      )
      .run();
    raw.close();

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).toContain("tracker_snapshots");
      expect(tables).toContain("tracker_reconciliation_runs");
      expect(tables).not.toContain("source_items");
      // The dependent tables are created fresh by the additive pass, already
      // tracker-named, together with their tracker-item indexes.
      expect(tables).toContain("evidence_records");
      expect(tables).toContain("intents");
      expect(columnNames(db, "evidence_records")).toContain("tracker_item_id");
      expect(columnNames(db, "intents")).toContain("tracker_item_id");
      const indexes = indexNames(db);
      expect(indexes).toContain("idx_evidence_records_tracker_item");
      expect(indexes).toContain("idx_intents_tracker_item");

      const items = db
        .prepare("SELECT id, external_id FROM tracker_items")
        .all() as Array<Record<string, unknown>>;
      expect(items).toEqual([
        { id: "source_item_old_1", external_id: "ext-old-1" },
      ]);
      const snapshots = db
        .prepare("SELECT id, tracker_item_id FROM tracker_snapshots")
        .all() as Array<Record<string, unknown>>;
      expect(snapshots).toEqual([
        { id: "source_snapshot_old_1", tracker_item_id: "source_item_old_1" },
      ]);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM tracker_reconciliation_runs")
          .get(),
      ).toEqual({ n: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("is idempotent on a second open", () => {
    const dataDir = makeTempDir();
    seedLegacySourceGraph(dataDir);

    const first = openDb(dataDir);
    const firstItems = first
      .prepare("SELECT id FROM tracker_items ORDER BY id")
      .all();
    first.close();

    const second = openDb(dataDir);
    try {
      const secondItems = second
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all();
      expect(secondItems).toEqual(firstItems);
      expect(tableNames(second)).not.toContain("source_items");
    } finally {
      second.close();
    }
  });

  it("fails closed without mutating an ambiguous database that has both source and tracker tables", () => {
    const dataDir = makeTempDir();
    seedLegacySourceGraph(dataDir);

    // Manufacture the ambiguous partial state: a tracker_items table beside
    // the still-populated legacy source_items table.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    // Recreate the legacy state first: rename back is not possible here, so
    // instead build a second data dir where both tables exist pre-open.
    raw.close();

    const ambiguousDir = makeTempDir();
    const ambiguous = new DatabaseSync(path.join(ambiguousDir, "momentum.db"));
    ambiguous.exec(LEGACY_SOURCE_SCHEMA);
    ambiguous.exec(
      `CREATE TABLE tracker_items (
         id TEXT PRIMARY KEY,
         adapter_kind TEXT NOT NULL,
         external_id TEXT NOT NULL,
         external_key TEXT,
         url TEXT,
         title TEXT NOT NULL,
         status TEXT,
         metadata_json TEXT NOT NULL DEFAULT '{}',
         last_observed_at INTEGER NOT NULL,
         goal_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT;`,
    );
    ambiguous
      .prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, title, metadata_json,
            last_observed_at, created_at, updated_at)
         VALUES ('source_item_x', 'linear', 'ext-x', 'X', '{}', 1, 1, 1)`,
      )
      .run();
    ambiguous.close();

    expect(() => openDb(ambiguousDir)).toThrow(/tracker/i);

    // The refused database is unchanged: legacy rows are still in place.
    const inspect = new DatabaseSync(path.join(ambiguousDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).toContain("source_items");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 1 });
    } finally {
      inspect.close();
    }
  });

  it("fails closed without mutating a database whose legacy dependents reference a missing parent table", () => {
    const dataDir = makeTempDir();

    // Manufacture the tampered partial state: dependent tables still carry
    // source_item_id foreign keys, but the source_items parent is gone.
    // SQLite allows creating (and keeping) tables whose foreign-key parent is
    // absent; only inserts fail. Renaming the column cannot repair the
    // dangling reference, so the open must refuse before any mutation.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(LEGACY_SOURCE_SCHEMA);
    raw.exec(`
      DROP TABLE source_snapshots;
      DROP TABLE source_reconciliation_runs;
      DROP TABLE source_items;
    `);
    raw.close();

    expect(() => openDb(dataDir)).toThrow(/tracker/i);

    // The refused database is unchanged: the legacy column spelling is still
    // in place and no tracker-named tables were created.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).not.toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      expect(columnNames(inspect, "evidence_records")).toContain(
        "source_item_id",
      );
      expect(columnNames(inspect, "update_intents")).toContain(
        "source_item_id",
      );
    } finally {
      inspect.close();
    }
  });

  it("does not commit the rename when a later migration fails, and retries cleanly after repair", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    // Manufacture a legacy executor schema that deterministically fails the
    // executor invocation rebuild mid-migration: the guards pass (both legacy
    // tables exist and executor_rounds carries invocation_id), but the
    // invocation table is missing heartbeat_at, which the rebuild's SELECT
    // requires. The rename must not be stranded committed by that failure.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(`
      CREATE TABLE executor_invocations (
        invocation_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor_family TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE executor_rounds (
        round_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        round_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER,
        heartbeat_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    raw.close();

    expect(() => openDb(dataDir)).toThrow(/heartbeat_at/);

    // Fail-closed and retryable: the tracker rename was not committed, so the
    // source graph is still intact under its legacy names.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).toContain("source_items");
      expect(tables).toContain("source_snapshots");
      expect(tables).toContain("source_reconciliation_runs");
      expect(tables).not.toContain("tracker_items");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 2 });
    } finally {
      inspect.close();
    }

    // Operator repair: drop the malformed executor tables, then reopen. The
    // retried migration chain completes the rename losslessly.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    repair.exec("DROP TABLE executor_rounds; DROP TABLE executor_invocations;");
    repair.close();

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      const items = db
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(items.map((row) => row.id).sort()).toEqual(
        [seededBefore.linkedItemId, seededBefore.unlinkedItemId].sort(),
      );
      const snapshots = db
        .prepare("SELECT tracker_item_id FROM tracker_snapshots")
        .all() as Array<{ tracker_item_id: string }>;
      for (const snapshot of snapshots) {
        expect(snapshot.tracker_item_id).toBe(seededBefore.linkedItemId);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses before the rename when the partial invocation phase would fail after it, and retries cleanly after repair", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    // Manufacture the partial SDK-05 shape that deterministically fails the
    // late partial-invocation phase: an invocation table with no legacy round
    // source and missing required columns. The legacy rebuild skips it (no
    // executor_rounds), so without the up-front preflight the failure would
    // land only after the tracker rename committed.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(
      "CREATE TABLE executor_invocations (invocation_id TEXT PRIMARY KEY) STRICT;",
    );
    raw.close();

    expect(() => openDb(dataDir)).toThrow(/missing required column/);

    // Fail-closed and retryable: the tracker rename was not committed, so the
    // source graph is still intact under its legacy names.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).toContain("source_items");
      expect(tables).not.toContain("tracker_items");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 2 });
    } finally {
      inspect.close();
    }

    // Operator repair: drop the malformed invocation table, then reopen. The
    // retried migration chain completes the rename losslessly.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    repair.exec("DROP TABLE executor_invocations;");
    repair.close();

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      const items = db
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(items.map((row) => row.id).sort()).toEqual(
        [seededBefore.linkedItemId, seededBefore.unlinkedItemId].sort(),
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses before the rename when a partial invocation collides with a current attempt, and retries cleanly after repair", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    // Manufacture the collision the partial SDK-05 phase refuses late: a
    // current-shaped executor_attempts row whose attempt_id matches a valid
    // partial invocation but whose legacy_invocation_id does not record it.
    // The attempts table is declared without foreign-key clauses so the
    // fixture can hold the colliding row without the workflow_steps parent
    // the legacy source schema never had. Without the up-front preflight the
    // refusal would land only after the tracker rename committed.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(`
      CREATE TABLE executor_attempts (
        attempt_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_number INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,
        heartbeat_at INTEGER,
        finished_at INTEGER,
        legacy_invocation_id TEXT,
        legacy_provenance TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE executor_invocations (
        invocation_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor_family TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO executor_attempts
        (attempt_id, workflow_run_id, step_run_id, step_key, executor,
         state, attempt_number, legacy_invocation_id, created_at, updated_at)
      VALUES ('inv-collision', 'wf_tracker_mig_1', 'implementation',
              'implementation', 'agent-loop', 'running', 1, NULL, 1, 1);

      INSERT INTO executor_invocations
        (invocation_id, workflow_run_id, step_run_id, step_key,
         executor_family, state, attempt, created_at, updated_at)
      VALUES ('inv-collision', 'wf_tracker_mig_1', 'implementation',
              'implementation', 'agent-loop', 'running', 1, 1, 1);
    `);
    raw.close();

    expect(() => openDb(dataDir)).toThrow(
      /collides with current attempt inv-collision/,
    );

    // Fail-closed and retryable: the tracker rename was not committed, so the
    // source graph is still intact under its legacy names.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).toContain("source_items");
      expect(tables).not.toContain("tracker_items");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 2 });
    } finally {
      inspect.close();
    }

    // Operator repair: remove the colliding invocation row, then reopen. The
    // retried migration chain completes the rename losslessly.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    repair.exec(
      "DELETE FROM executor_invocations WHERE invocation_id = 'inv-collision';",
    );
    repair.close();

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      const items = db
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(items.map((row) => row.id).sort()).toEqual(
        [seededBefore.linkedItemId, seededBefore.unlinkedItemId].sort(),
      );
    } finally {
      db.close();
    }
  });

  it("refuses before the rename when a pre-existing executor_attempts table is missing an insert column, and retries cleanly after repair", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    // Manufacture the destination-schema failure the partial SDK-05 phase hits
    // late: a current-shaped executor_attempts table that omits only
    // legacy_provenance, beside a valid partial invocation. The additive pass
    // never repairs executor_attempts columns, so without the up-front
    // preflight the phase's INSERT would throw only after the tracker rename
    // committed.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(`
      CREATE TABLE executor_attempts (
        attempt_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_number INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,
        heartbeat_at INTEGER,
        finished_at INTEGER,
        legacy_invocation_id TEXT,
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id)
      ) STRICT;

      INSERT INTO workflow_steps
        (run_id, step_id, kind, state, step_order, required,
         created_at, updated_at)
      VALUES ('wf_tracker_mig_1', 'implementation', 'implementation',
              'succeeded', 1, 1, 1, 1);

      CREATE TABLE executor_invocations (
        invocation_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor_family TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO executor_invocations
        (invocation_id, workflow_run_id, step_run_id, step_key,
         executor_family, state, attempt, created_at, updated_at)
      VALUES ('inv-partial-1', 'wf_tracker_mig_1', 'implementation',
              'implementation', 'agent-loop', 'running', 1, 1, 1);
    `);
    raw.close();

    expect(() => openDb(dataDir)).toThrow(
      /target executor_attempts is missing required column legacy_provenance/,
    );

    // Fail-closed and retryable: the tracker rename was not committed, so the
    // source graph is still intact under its legacy names.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).toContain("source_items");
      expect(tables).not.toContain("tracker_items");
      expect(tables).toContain("executor_invocations");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 2 });
    } finally {
      inspect.close();
    }

    // Operator repair: add the missing destination column, then reopen. The
    // retried migration chain completes the rename losslessly.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    repair.exec(
      "ALTER TABLE executor_attempts ADD COLUMN legacy_provenance TEXT;",
    );
    repair.close();

    const db = openDb(dataDir);
    try {
      const tables = tableNames(db);
      expect(tables).toContain("tracker_items");
      expect(tables).not.toContain("source_items");
      expect(tables).not.toContain("executor_invocations");
      const items = db
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(items.map((row) => row.id).sort()).toEqual(
        [seededBefore.linkedItemId, seededBefore.unlinkedItemId].sort(),
      );
      const migrated = db
        .prepare(
          "SELECT attempt_id, legacy_invocation_id FROM executor_attempts WHERE attempt_id = 'inv-partial-1'",
        )
        .get() as { attempt_id: string; legacy_invocation_id: string | null };
      expect(migrated.legacy_invocation_id).toBe("inv-partial-1");
    } finally {
      db.close();
    }
  });

  it("refuses before the rename when a partial invocation references a missing foreign-key parent", () => {
    const dataDir = makeTempDir();
    seedLegacySourceGraph(dataDir);

    // Manufacture the orphaned partial SDK-05 shape: a valid invocation whose
    // workflow_runs parent row does not exist. The phase's own refusal is the
    // post-insert foreign_key_check, which fires only after the tracker
    // rename committed; the preflight must refuse the same state up front.
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    raw.exec(`
      CREATE TABLE executor_invocations (
        invocation_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        step_run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        executor_family TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO executor_invocations
        (invocation_id, workflow_run_id, step_run_id, step_key,
         executor_family, state, attempt, created_at, updated_at)
      VALUES ('inv-orphan', 'wf_missing_parent', 'implementation',
              'implementation', 'agent-loop', 'running', 1, 1, 1);
    `);
    raw.close();

    expect(() => openDb(dataDir)).toThrow(
      /missing workflow run wf_missing_parent/,
    );

    // Fail-closed: the tracker rename was not committed, so the source graph
    // is still intact under its legacy names.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      const tables = tableNames(inspect);
      expect(tables).toContain("source_items");
      expect(tables).not.toContain("tracker_items");
      expect(
        inspect.prepare("SELECT COUNT(*) AS n FROM source_items").get(),
      ).toEqual({ n: 2 });
    } finally {
      inspect.close();
    }
  });

  it("migrates a pre-rename database through the read-only open path", () => {
    const dataDir = makeTempDir();
    const seededBefore = seedLegacySourceGraph(dataDir);

    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      const items = db!
        .prepare("SELECT id FROM tracker_items ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(items.map((row) => row.id).sort()).toEqual(
        [seededBefore.linkedItemId, seededBefore.unlinkedItemId].sort(),
      );
    } finally {
      db!.close();
    }
  });
});
