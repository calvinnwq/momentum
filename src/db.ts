import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { applyQueueMigrations } from "./migrations.js";

export type MomentumDb = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
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

CREATE TABLE IF NOT EXISTS jobs (
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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  job_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
`;

export function openDb(dataDir: string): MomentumDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "momentum.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  applyQueueMigrations(db);
  return db;
}
