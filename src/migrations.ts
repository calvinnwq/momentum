import type { DatabaseSync } from "node:sqlite";

type MomentumDb = DatabaseSync;

type ColumnSpec = { name: string; type: string };

const JOB_QUEUE_COLUMNS: ColumnSpec[] = [
  { name: "idempotency_key", type: "TEXT" },
  { name: "worker_id", type: "TEXT" },
  { name: "lease_acquired_at", type: "INTEGER" },
  { name: "lease_expires_at", type: "INTEGER" },
  { name: "heartbeat_at", type: "INTEGER" },
  { name: "result_path", type: "TEXT" },
  { name: "error_path", type: "TEXT" }
];

const REPO_LOCKS_DDL = `
CREATE TABLE IF NOT EXISTS repo_locks (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  holder TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  recovery_status TEXT,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_locks_active_root
  ON repo_locks(repo_root) WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_repo_locks_job_id
  ON repo_locks(job_id);
`;

const JOB_IDEMPOTENCY_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
  ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_state_type
  ON jobs(state, type);
`;

export function applyQueueMigrations(db: MomentumDb): void {
  db.exec("BEGIN");
  try {
    for (const column of JOB_QUEUE_COLUMNS) {
      ensureColumn(db, "jobs", column);
    }
    db.exec(JOB_IDEMPOTENCY_INDEX_DDL);
    db.exec(REPO_LOCKS_DDL);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type PragmaColumnRow = { name: string };

function ensureColumn(db: MomentumDb, table: string, column: ColumnSpec): void {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as PragmaColumnRow[];
  if (rows.some((row) => row.name === column.name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}`);
}
