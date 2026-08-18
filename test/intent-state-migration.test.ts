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
