import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, openExistingDbMigratedReadOnly } from "../src/adapters/db.js";

// NAM-06 durable rename coverage: the `update_intents` -> `intents` table
// rename and the `mirroring_external_state` -> `supervising_delegate` round
// state, proven across fresh, pre-rename, upgraded, and second-open databases.

const tempDirs: string[] = [];

function makeTempDir(prefix = "momentum-intent-state-migration-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function indexNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const INTENT_INDEXES = [
  "idx_intents_idempotency_key",
  "idx_intents_status",
  "idx_intents_goal",
  "idx_intents_tracker_item",
  "idx_intents_evidence",
  "idx_intents_adapter_target",
  "idx_intents_created_at",
] as const;

const LEGACY_INTENT_INDEXES = [
  "idx_update_intents_idempotency_key",
  "idx_update_intents_status",
  "idx_update_intents_goal",
  "idx_update_intents_tracker_item",
  "idx_update_intents_evidence",
  "idx_update_intents_adapter_target",
  "idx_update_intents_created_at",
] as const;

/**
 * Rewind a freshly migrated data dir to the pre-NAM-06 intent shape: the
 * `intents` table renamed back to `update_intents` with the old-name indexes.
 * SQLite rewrites the `intent_apply_audits` foreign key alongside the rename,
 * so the result matches a real post-NAM-05, pre-NAM-06 database.
 */
function rewindIntentRename(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    db.exec("ALTER TABLE intents RENAME TO update_intents");
    for (const name of INTENT_INDEXES) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
    db.exec(`
CREATE UNIQUE INDEX idx_update_intents_idempotency_key
  ON update_intents(idempotency_key);
CREATE INDEX idx_update_intents_status ON update_intents(status);
CREATE INDEX idx_update_intents_goal
  ON update_intents(goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX idx_update_intents_tracker_item
  ON update_intents(tracker_item_id) WHERE tracker_item_id IS NOT NULL;
CREATE INDEX idx_update_intents_evidence
  ON update_intents(evidence_record_id) WHERE evidence_record_id IS NOT NULL;
CREATE INDEX idx_update_intents_adapter_target
  ON update_intents(adapter_kind, target_external_id);
CREATE INDEX idx_update_intents_created_at ON update_intents(created_at);
`);
  } finally {
    db.close();
  }
}

function seedIntentGraph(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      `INSERT INTO goals
         (id, title, branch, artifact_dir, state, created_at, updated_at)
       VALUES ('goal_mig_1', 'Goal', 'main', '/tmp/goal_mig_1', 'active', 10, 10)`,
    ).run();
    db.prepare(
      `INSERT INTO tracker_items
         (id, adapter_kind, external_id, title, last_observed_at,
          created_at, updated_at)
       VALUES ('tracker_item_mig_1', 'linear', 'ext-1', 'Item', 10, 10, 10)`,
    ).run();
    db.prepare(
      `INSERT INTO update_intents
         (id, adapter_kind, target_external_id, intent_type, payload_json,
          reason, goal_id, tracker_item_id, status, idempotency_key,
          decision_reason, error_code, error_message,
          created_at, updated_at, applied_at, apply_state)
       VALUES ('update_intent_mig_1', 'linear', 'ext-1', 'status_update', '{"state":"Done"}',
               'verified done', 'goal_mig_1', 'tracker_item_mig_1', 'applied',
               'linear:ext-1:status_update:goal_mig_1',
               'operator applied', NULL, NULL, 11, 12, 12, 'succeeded')`,
    ).run();
    db.prepare(
      `INSERT INTO intent_apply_audits
         (id, intent_id, adapter_kind, provider, requested_at, operator_reason,
          intent_apply_policy, mutation_kind, preview_summary,
          idempotency_marker, lifecycle_state, created_at, updated_at)
       VALUES ('audit_mig_1', 'update_intent_mig_1', 'linear', 'linear', 11,
               'apply it', 'workflow_verified', 'status_update', 'preview',
               'momentum-intent:linear:update_intent_mig_1:v1', 'succeeded',
               11, 12)`,
    ).run();
  } finally {
    db.close();
  }
}

function seedSupervisingRound(
  dataDir: string,
  state: string,
  roundId: string,
): void {
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const runId = `run-${roundId}`;
    db.prepare(
      `INSERT INTO workflow_runs
         (id, state, source, plan_json, needs_manual_recovery,
          created_at, updated_at)
       VALUES (?, 'running', 'agent-workflows', '{}', 0, 1, 1)`,
    ).run(runId);
    db.prepare(
      `INSERT INTO workflow_steps
         (run_id, step_id, kind, state, step_order, required,
          created_at, updated_at)
       VALUES (?, 'step-x', 'validate', 'running', 0, 1, 1, 1)`,
    ).run(runId);
    db.prepare(
      `INSERT INTO executor_attempts
         (attempt_id, workflow_run_id, step_run_id, step_key,
          executor, state, attempt_number, created_at, updated_at)
       VALUES (?, ?, 'step-x', 'validate',
               'delegate-supervisor', 'running', 1, 1, 1)`,
    ).run(`attempt-${roundId}`, runId);
    db.prepare(
      `INSERT INTO executor_rounds
         (round_id, attempt_id, workflow_run_id, step_run_id, step_key,
          executor, attempt_number, round_index, state, created_at, updated_at)
       VALUES (?, ?, ?, 'step-x', 'validate',
               'delegate-supervisor', 1, 0, ?, 1, 1)`,
    ).run(roundId, `attempt-${roundId}`, runId, state);
  } finally {
    db.close();
  }
}

describe("NAM-06 intent table rename", () => {
  it("creates a fresh database with the intents table and no legacy names", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("intents");
      expect(tableNames(db)).not.toContain("update_intents");
      const indexes = indexNames(db);
      for (const name of INTENT_INDEXES) {
        expect(indexes, `missing index: ${name}`).toContain(name);
      }
      for (const name of LEGACY_INTENT_INDEXES) {
        expect(indexes, `stale legacy index: ${name}`).not.toContain(name);
      }
    } finally {
      db.close();
    }
  });

  it("losslessly renames a pre-rename update_intents database in place", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    rewindIntentRename(dataDir);
    seedIntentGraph(dataDir);

    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("intents");
      expect(tableNames(db)).not.toContain("update_intents");
      const indexes = indexNames(db);
      for (const name of INTENT_INDEXES) {
        expect(indexes, `missing index: ${name}`).toContain(name);
      }
      for (const name of LEGACY_INTENT_INDEXES) {
        expect(indexes, `stale legacy index: ${name}`).not.toContain(name);
      }

      // Row bytes, ids, links, idempotency keys, decisions, and timestamps
      // are untouched; only the table name changed.
      const intent = db
        .prepare("SELECT * FROM intents WHERE id = 'update_intent_mig_1'")
        .get() as Record<string, unknown>;
      expect(intent.status).toBe("applied");
      expect(intent.idempotency_key).toBe(
        "linear:ext-1:status_update:goal_mig_1",
      );
      expect(intent.decision_reason).toBe("operator applied");
      expect(intent.goal_id).toBe("goal_mig_1");
      expect(intent.tracker_item_id).toBe("tracker_item_mig_1");
      expect(intent.created_at).toBe(11);
      expect(intent.updated_at).toBe(12);
      expect(intent.applied_at).toBe(12);
      expect(intent.apply_state).toBe("succeeded");

      // The audit ledger's foreign key was rewritten to the renamed parent
      // and stays live.
      const auditFks = db
        .prepare("PRAGMA foreign_key_list(intent_apply_audits)")
        .all() as Array<{ table: string; from: string }>;
      const intentFk = auditFks.find((fk) => fk.from === "intent_id");
      expect(intentFk?.table).toBe("intents");
      expect(() =>
        db
          .prepare(
            `INSERT INTO intent_apply_audits
               (id, intent_id, adapter_kind, provider, requested_at,
                operator_reason, intent_apply_policy, mutation_kind,
                preview_summary, idempotency_marker, lifecycle_state,
                created_at, updated_at)
             VALUES ('audit_dangling', 'intent_missing', 'linear', 'linear', 1,
                     'x', 'workflow_verified', 'status_update', 'p', 'm', 'claimed',
                     1, 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

      // The renamed unique index still enforces idempotency.
      expect(() =>
        db
          .prepare(
            `INSERT INTO intents
               (id, adapter_kind, intent_type, payload_json, reason, status,
                idempotency_key, created_at, updated_at)
             VALUES ('intent_dup', 'linear', 'status_update', '{}', 'dup',
                     'pending', 'linear:ext-1:status_update:goal_mig_1', 1, 1)`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second open of an upgraded database is a no-op", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    rewindIntentRename(dataDir);
    seedIntentGraph(dataDir);
    openDb(dataDir).close();

    const before = fs.readFileSync(path.join(dataDir, "momentum.db"));
    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("intents");
    } finally {
      db.close();
    }
    const after = fs.readFileSync(path.join(dataDir, "momentum.db"));
    expect(after.equals(before)).toBe(true);
  });

  it("refuses an ambiguous database carrying both intents and update_intents", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec(
        "CREATE TABLE update_intents (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL) STRICT",
      );
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(/intent schema migration refused/);

    // The refused database is unchanged: both tables are still present.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).toContain("intents");
      expect(tableNames(inspect)).toContain("update_intents");
    } finally {
      inspect.close();
    }
  });

  it("routes a pre-rename database through the full migration on read-only open", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    rewindIntentRename(dataDir);
    seedIntentGraph(dataDir);

    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      expect(tableNames(db!)).toContain("intents");
      expect(tableNames(db!)).not.toContain("update_intents");
      const intent = db!
        .prepare(
          "SELECT id, status FROM intents WHERE id = 'update_intent_mig_1'",
        )
        .get() as Record<string, unknown>;
      expect(intent.status).toBe("applied");
    } finally {
      db!.close();
    }
  });
});

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** The canonical intents table DDL with a configurable tracker-link line. */
function intentsTableDdl(trackerLinkLine: string): string {
  return `
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  target_external_id TEXT,
  intent_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  ${trackerLinkLine},
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
) STRICT`;
}

/** The canonical intent_apply_audits DDL with a configurable intent_id line. */
function auditsTableDdl(intentIdLine: string): string {
  return `
CREATE TABLE intent_apply_audits (
  id TEXT PRIMARY KEY,
  ${intentIdLine},
  adapter_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_target_external_id TEXT,
  external_target_external_key TEXT,
  external_target_url TEXT,
  external_target_title TEXT,
  requested_at INTEGER NOT NULL,
  finished_at INTEGER,
  operator_reason TEXT NOT NULL,
  operator_actor TEXT,
  intent_apply_policy TEXT NOT NULL,
  allow_status_mutation INTEGER NOT NULL DEFAULT 0,
  mutation_kind TEXT NOT NULL,
  preview_summary TEXT NOT NULL,
  idempotency_marker TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  result_status TEXT,
  result_code TEXT,
  result_message TEXT,
  external_ref_comment_id TEXT,
  external_ref_comment_url TEXT,
  external_ref_state_transition_id TEXT,
  reconcile_status TEXT,
  reconcile_warning TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT`;
}

describe("NAM-06 intent graph preflight", () => {
  it("completes the tracker-link column rename on a canonical intents table, idempotently", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // A partial state where the table rename landed without the
      // tracker-link column rename.
      raw.exec(
        "ALTER TABLE intents RENAME COLUMN tracker_item_id TO source_item_id",
      );
    } finally {
      raw.close();
    }

    const db = openDb(dataDir);
    try {
      const columns = columnNames(db, "intents");
      expect(columns).toContain("tracker_item_id");
      expect(columns).not.toContain("source_item_id");
      db.prepare(
        `INSERT INTO intents
           (id, adapter_kind, intent_type, payload_json, reason, status,
            idempotency_key, created_at, updated_at)
         VALUES ('intent_link_1', 'linear', 'status_update', '{}', 'r',
                 'pending', 'link-key-1', 1, 1)`,
      ).run();
    } finally {
      db.close();
    }

    // A second open of the completed database is a no-op.
    const before = fs.readFileSync(path.join(dataDir, "momentum.db"));
    openDb(dataDir).close();
    const after = fs.readFileSync(path.join(dataDir, "momentum.db"));
    expect(after.equals(before)).toBe(true);
  });

  it("refuses a canonical intents table missing a required column before the tracker rename commits, then retries after repair", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("ALTER TABLE intents DROP COLUMN skipped_at");
      // A pending NAM-05 tracker rename that must not commit beside the
      // refused intent graph.
      raw.exec("ALTER TABLE tracker_items RENAME TO source_items");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intents is missing required column skipped_at/,
    );

    // Fail closed: the pending tracker rename did not commit either.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).toContain("source_items");
      expect(tableNames(inspect)).not.toContain("tracker_items");
      expect(columnNames(inspect, "intents")).not.toContain("skipped_at");
    } finally {
      inspect.close();
    }

    // Repairing the unsupported column makes the next open complete the
    // pending migration chain.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      repair.exec("ALTER TABLE intents ADD COLUMN skipped_at INTEGER");
    } finally {
      repair.close();
    }
    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("tracker_items");
      expect(tableNames(db)).not.toContain("source_items");
    } finally {
      db.close();
    }
  });

  it("refuses a stale intent_apply_audits foreign key stranded on update_intents", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // Retarget the audit ledger at the retired table name: the rename
      // rewrites the foreign key, the fresh canonical table does not.
      raw.exec("ALTER TABLE intents RENAME TO update_intents");
      raw.exec(
        intentsTableDdl("tracker_item_id TEXT REFERENCES tracker_items(id)"),
      );
      raw.exec("DROP TABLE update_intents");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intent_apply_audits\.intent_id references update_intents instead of intents/,
    );
  });

  it("completes the canonical column rename on migrated read-only open", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec(
        "ALTER TABLE intents RENAME COLUMN tracker_item_id TO source_item_id",
      );
    } finally {
      raw.close();
    }

    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      const columns = columnNames(db!, "intents");
      expect(columns).toContain("tracker_item_id");
      expect(columns).not.toContain("source_item_id");
    } finally {
      db!.close();
    }
  });

  it("refuses an unsupported canonical intent graph on migrated read-only open", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("ALTER TABLE intents DROP COLUMN skipped_at");
    } finally {
      raw.close();
    }

    expect(() => openExistingDbMigratedReadOnly(dataDir)).toThrow(
      /intent schema migration refused: intents is missing required column skipped_at/,
    );
  });

  it("refuses an intent_apply_audits table without its intent_id foreign key", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("DROP TABLE intent_apply_audits");
      raw.exec(auditsTableDdl("intent_id TEXT NOT NULL"));
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intent_apply_audits\.intent_id carries no foreign key/,
    );
    expect(() => openExistingDbMigratedReadOnly(dataDir)).toThrow(
      /intent_apply_audits\.intent_id carries no foreign key/,
    );
  });

  it("refuses a tracker-link foreign key targeting the wrong parent column", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("DROP TABLE intents");
      raw.exec(
        intentsTableDdl(
          "tracker_item_id TEXT REFERENCES tracker_items(status)",
        ),
      );
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intents\.tracker_item_id references tracker_items\(status\) instead of tracker_items\(id\)/,
    );
  });

  it("refuses a same-name index that does not match the canonical definition, then retries after repair", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // CREATE INDEX IF NOT EXISTS would silently preserve this non-unique
      // impostor and idempotency-key uniqueness would be lost.
      raw.exec("DROP INDEX idx_intents_idempotency_key");
      raw.exec("CREATE INDEX idx_intents_idempotency_key ON intents(status)");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: index idx_intents_idempotency_key does not match its canonical definition/,
    );

    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      repair.exec("DROP INDEX idx_intents_idempotency_key");
      repair.exec(
        "CREATE UNIQUE INDEX idx_intents_idempotency_key ON intents(idempotency_key)",
      );
    } finally {
      repair.close();
    }

    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO intents
           (id, adapter_kind, intent_type, payload_json, reason, status,
            idempotency_key, created_at, updated_at)
         VALUES ('intent_idem_1', 'linear', 'status_update', '{}', 'r',
                 'pending', 'idem-key-1', 1, 1)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO intents
               (id, adapter_kind, intent_type, payload_json, reason, status,
                idempotency_key, created_at, updated_at)
             VALUES ('intent_idem_2', 'linear', 'status_update', '{}', 'r',
                     'pending', 'idem-key-1', 1, 1)`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }

    const before = fs.readFileSync(path.join(dataDir, "momentum.db"));
    openDb(dataDir).close();
    const after = fs.readFileSync(path.join(dataDir, "momentum.db"));
    expect(after.equals(before)).toBe(true);
  });

  it("refuses a missing audit column before the intent rename commits, then retries after repair", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    rewindIntentRename(dataDir);
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("DROP INDEX idx_intent_apply_audits_lifecycle_state");
      raw.exec("DROP INDEX idx_intent_apply_audits_active");
      raw.exec("ALTER TABLE intent_apply_audits DROP COLUMN lifecycle_state");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intent_apply_audits is missing required column lifecycle_state/,
    );

    // Fail closed: the intent rename did not commit, so the legacy graph is
    // unchanged and the failed open retries from its original state.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).toContain("update_intents");
      expect(tableNames(inspect)).not.toContain("intents");
      expect(indexNames(inspect)).toContain(
        "idx_update_intents_idempotency_key",
      );
    } finally {
      inspect.close();
    }

    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      repair.exec(
        "ALTER TABLE intent_apply_audits ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'succeeded'",
      );
    } finally {
      repair.close();
    }

    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("intents");
      expect(tableNames(db)).not.toContain("update_intents");
      const indexes = indexNames(db);
      expect(indexes).toContain("idx_intent_apply_audits_lifecycle_state");
      expect(indexes).toContain("idx_intent_apply_audits_active");
    } finally {
      db.close();
    }
  });

  it("refuses an audit ledger whose intents parent table is absent", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // With enforcement off, seeding the audit row and then dropping its
      // parent is accepted, mirroring an externally damaged database.
      // Recreating an empty intents table here would strand this row, so
      // the open must refuse instead.
      raw.exec("PRAGMA foreign_keys = OFF");
      raw
        .prepare(
          `INSERT INTO intent_apply_audits
           (id, intent_id, adapter_kind, provider, requested_at,
            operator_reason, intent_apply_policy, mutation_kind,
            preview_summary, idempotency_marker, lifecycle_state,
            created_at, updated_at)
         VALUES ('audit_orphan_1', 'intent-existing', 'linear', 'linear', 1,
                 'x', 'workflow_verified', 'status_update', 'p', 'm',
                 'succeeded', 1, 1)`,
        )
        .run();
      raw.exec("DROP TABLE intents");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intent_apply_audits exists without its intents parent table/,
    );
    expect(() => openExistingDbMigratedReadOnly(dataDir)).toThrow(
      /intent_apply_audits exists without its intents parent table/,
    );

    // The refused database is unchanged: no empty parent was created and the
    // audit row survives.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).not.toContain("intents");
      const audit = inspect
        .prepare(
          "SELECT intent_id FROM intent_apply_audits WHERE id = 'audit_orphan_1'",
        )
        .get() as { intent_id: string };
      expect(audit.intent_id).toBe("intent-existing");
    } finally {
      inspect.close();
    }
  });

  it("refuses a same-name partial index with the wrong predicate, then retries after repair", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // A wrong predicate on the same unique partial index vacates the
      // at-most-one-claimed-audit invariant while owner, uniqueness, and
      // columns all still match.
      raw.exec("DROP INDEX idx_intent_apply_audits_active");
      raw.exec(
        `CREATE UNIQUE INDEX idx_intent_apply_audits_active
           ON intent_apply_audits(intent_id) WHERE lifecycle_state = 'succeeded'`,
      );
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: index idx_intent_apply_audits_active does not match its canonical definition/,
    );
    expect(() => openExistingDbMigratedReadOnly(dataDir)).toThrow(
      /idx_intent_apply_audits_active does not match its canonical definition/,
    );

    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      repair.exec("DROP INDEX idx_intent_apply_audits_active");
      repair.exec(
        `CREATE UNIQUE INDEX idx_intent_apply_audits_active
           ON intent_apply_audits(intent_id) WHERE lifecycle_state = 'claimed'`,
      );
    } finally {
      repair.close();
    }
    openDb(dataDir).close();
  });

  it("refuses a declared intent link whose parent table is missing while rows reference it", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw.exec("PRAGMA foreign_keys = OFF");
      raw
        .prepare(
          `INSERT INTO intents
           (id, adapter_kind, intent_type, payload_json, reason, status,
            idempotency_key, goal_id, created_at, updated_at)
         VALUES ('intent_orphan_goal', 'linear', 'status_update', '{}', 'r',
                 'pending', 'orphan-goal-key', 'goal-existing', 1, 1)`,
        )
        .run();
      raw.exec("DROP TABLE goals");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intents\.goal_id references missing table goals while existing rows reference it/,
    );
    expect(() => openExistingDbMigratedReadOnly(dataDir)).toThrow(
      /intents\.goal_id references missing table goals while existing rows reference it/,
    );

    // The refusal is row-gated: with no referencing rows a missing parent is
    // recreated losslessly.
    const emptyDir = makeTempDir();
    openDb(emptyDir).close();
    const emptyRaw = new DatabaseSync(path.join(emptyDir, "momentum.db"));
    try {
      emptyRaw.exec("PRAGMA foreign_keys = OFF");
      emptyRaw.exec("DROP TABLE goals");
    } finally {
      emptyRaw.close();
    }
    const db = openDb(emptyDir);
    try {
      expect(tableNames(db)).toContain("goals");
    } finally {
      db.close();
    }
  });

  it("rolls back the intent rename when later additive DDL fails, keeping the legacy graph retryable", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    rewindIntentRename(dataDir);
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // An unmigratable parent schema the preflight does not inventory: the
      // additive tracker index DDL fails after the intent rename steps ran,
      // and the shared transaction must roll the rename back.
      raw.exec("PRAGMA foreign_keys = OFF");
      raw.exec("DROP TABLE tracker_items");
      raw.exec("CREATE TABLE tracker_items (id TEXT PRIMARY KEY) STRICT");
    } finally {
      raw.close();
    }

    expect(() => openDb(dataDir)).toThrow(/adapter_kind/);

    // The failed open left the legacy intent graph unchanged and retryable.
    const inspect = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
    });
    try {
      expect(tableNames(inspect)).toContain("update_intents");
      expect(tableNames(inspect)).not.toContain("intents");
      expect(indexNames(inspect)).toContain(
        "idx_update_intents_idempotency_key",
      );
    } finally {
      inspect.close();
    }

    // Repairing the parent lets the retry complete the rename.
    const repair = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      repair.exec("PRAGMA foreign_keys = OFF");
      repair.exec("DROP TABLE tracker_items");
    } finally {
      repair.close();
    }
    const db = openDb(dataDir);
    try {
      expect(tableNames(db)).toContain("intents");
      expect(tableNames(db)).not.toContain("update_intents");
      expect(columnNames(db, "tracker_items")).toContain("adapter_kind");
    } finally {
      db.close();
    }
  });

  it("keeps a refused sparse database byte-identical: no base schema lands before the refusal", () => {
    const dataDir = makeTempDir();
    const dbPath = path.join(dataDir, "momentum.db");
    const raw = new DatabaseSync(dbPath);
    try {
      // A sparse malformed database: only a canonical intents table missing
      // a required column, with none of the base tables present. The
      // refusal must land before openDb's base-schema DDL executes.
      raw.exec(
        intentsTableDdl("tracker_item_id TEXT REFERENCES tracker_items(id)"),
      );
      raw.exec("ALTER TABLE intents DROP COLUMN skipped_at");
    } finally {
      raw.close();
    }

    const before = fs.readFileSync(dbPath);
    expect(() => openDb(dataDir)).toThrow(
      /intent schema migration refused: intents is missing required column skipped_at/,
    );
    const after = fs.readFileSync(dbPath);
    expect(after.equals(before)).toBe(true);

    const inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = tableNames(inspect);
      expect(tables).not.toContain("goals");
      expect(tables).not.toContain("jobs");
      expect(tables).not.toContain("events");
    } finally {
      inspect.close();
    }
  });

  it("drops the legacy tracker-link index during safe canonical completion, idempotently", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      // A realistic partial state: the table rename landed without the
      // column rename, still carrying the pre-NAM-05 tracker-link index
      // name on the legacy column spelling.
      raw.exec(
        "ALTER TABLE intents RENAME COLUMN tracker_item_id TO source_item_id",
      );
      raw.exec("DROP INDEX idx_intents_tracker_item");
      raw.exec(
        `CREATE INDEX idx_update_intents_source_item
           ON intents(source_item_id) WHERE source_item_id IS NOT NULL`,
      );
    } finally {
      raw.close();
    }

    const db = openDb(dataDir);
    try {
      expect(columnNames(db, "intents")).toContain("tracker_item_id");
      const indexes = indexNames(db);
      expect(indexes).toContain("idx_intents_tracker_item");
      expect(indexes).not.toContain("idx_update_intents_source_item");
    } finally {
      db.close();
    }

    const before = fs.readFileSync(path.join(dataDir, "momentum.db"));
    openDb(dataDir).close();
    const after = fs.readFileSync(path.join(dataDir, "momentum.db"));
    expect(after.equals(before)).toBe(true);
  });
});

describe("NAM-06 supervising_delegate round-state rename", () => {
  it("migrates persisted mirroring_external_state rounds and leaves other states alone", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    seedSupervisingRound(dataDir, "mirroring_external_state", "round-legacy");
    seedSupervisingRound(dataDir, "succeeded", "round-terminal");

    const db = openDb(dataDir);
    try {
      const states = db
        .prepare(
          "SELECT round_id, state FROM executor_rounds ORDER BY round_id",
        )
        .all() as Array<{ round_id: string; state: string }>;
      expect(states).toEqual([
        { round_id: "round-legacy", state: "supervising_delegate" },
        { round_id: "round-terminal", state: "succeeded" },
      ]);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second open after the state rename is a no-op", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    seedSupervisingRound(dataDir, "mirroring_external_state", "round-legacy");
    openDb(dataDir).close();

    const before = fs.readFileSync(path.join(dataDir, "momentum.db"));
    openDb(dataDir).close();
    const after = fs.readFileSync(path.join(dataDir, "momentum.db"));
    expect(after.equals(before)).toBe(true);
  });

  it("upgrades the persisted round state on read-only open", () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();
    seedSupervisingRound(dataDir, "mirroring_external_state", "round-legacy");

    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      const round = db!
        .prepare(
          "SELECT state FROM executor_rounds WHERE round_id = 'round-legacy'",
        )
        .get() as { state: string };
      expect(round.state).toBe("supervising_delegate");
    } finally {
      db!.close();
    }
  });
});
