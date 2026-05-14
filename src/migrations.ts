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

const GOAL_REDUCER_COLUMNS: ColumnSpec[] = [
  { name: "current_iteration", type: "INTEGER NOT NULL DEFAULT 0" },
  { name: "completion_reason", type: "TEXT" }
];

const DAEMON_RUN_COLUMNS: ColumnSpec[] = [
  { name: "stop_now_requested_at", type: "INTEGER" },
  { name: "cancel_outcome", type: "TEXT" }
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

const DAEMON_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS daemon_runs (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  host TEXT,
  state TEXT NOT NULL DEFAULT 'starting',
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  last_state_change_at INTEGER NOT NULL,
  finished_at INTEGER,
  active_job_id TEXT,
  active_lock_id TEXT,
  stop_requested_at INTEGER,
  stop_reason TEXT,
  stop_now_requested_at INTEGER,
  cancel_outcome TEXT,
  reconcile_count INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at INTEGER,
  error TEXT,
  error_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_daemon_runs_state
  ON daemon_runs(state);

CREATE INDEX IF NOT EXISTS idx_daemon_runs_started_at
  ON daemon_runs(started_at);

CREATE INDEX IF NOT EXISTS idx_daemon_runs_heartbeat_at
  ON daemon_runs(heartbeat_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daemon_runs_one_active
  ON daemon_runs((state IN ('starting', 'running', 'stop_requested')))
  WHERE state IN ('starting', 'running', 'stop_requested');
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
    if (tableExists(db, "jobs")) {
      for (const column of JOB_QUEUE_COLUMNS) {
        ensureColumn(db, "jobs", column);
      }
    }
    if (tableExists(db, "goals")) {
      for (const column of GOAL_REDUCER_COLUMNS) {
        ensureColumn(db, "goals", column);
      }
    }
    db.exec(JOB_IDEMPOTENCY_INDEX_DDL);
    db.exec(REPO_LOCKS_DDL);
    db.exec(DAEMON_RUNS_DDL);
    if (tableExists(db, "daemon_runs")) {
      for (const column of DAEMON_RUN_COLUMNS) {
        ensureColumn(db, "daemon_runs", column);
      }
    }
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

function tableExists(db: MomentumDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
