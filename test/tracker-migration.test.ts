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
const LEGACY_SOURCE_SCHEMA = `
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
  source TEXT NOT NULL,
  source_artifact_path TEXT,
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
  db
    .prepare(
      `INSERT INTO workflow_runs
         (id, state, source, source_artifact_path, created_at, updated_at)
       VALUES (?, 'succeeded', 'workflow-definition', '/tmp/wf-artifact.json', 6000, 6001)`,
    )
    .run(workflowRunId);
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
      expect(columnNames(db, "update_intents")).toContain("tracker_item_id");
      expect(columnNames(db, "update_intents")).not.toContain("source_item_id");
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
        "idx_update_intents_tracker_item",
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
        .prepare("SELECT * FROM update_intents WHERE id = ?")
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
