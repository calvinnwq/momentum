import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import {
  applyQueueMigrations,
  applyWorkflowVocabularyMigration,
} from "./db/migrations.js";

export type MomentumDb = DatabaseSync;

export type OpenDbOptions = {
  env?: Record<string, string | undefined>;
};

const EXECUTOR_CONFIG_ENV_VAR = "MOMENTUM_EXECUTOR_CONFIG";

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

export function openDb(
  dataDir: string,
  options: OpenDbOptions = {},
): MomentumDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "momentum.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  applyQueueMigrations(db, {
    claimedExecutorNames: configuredExecutorNames(options.env ?? process.env),
  });
  return db;
}

export function configuredExecutorNames(
  env: Record<string, string | undefined>,
): ReadonlySet<string> {
  // Migrations run before daemon module loading, so read only the configured
  // identity keys here. A missing or invalid module still owns its explicit
  // name and must fail as unavailable later instead of losing historical data.
  const source = (env[EXECUTOR_CONFIG_ENV_VAR] ?? "").trim();
  if (source.length === 0) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(source, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return new Set();
    }
    const executors = (parsed as Record<string, unknown>)["executors"];
    if (
      executors === null ||
      typeof executors !== "object" ||
      Array.isArray(executors)
    ) {
      return new Set();
    }
    return new Set(Object.keys(executors));
  } catch {
    return new Set();
  }
}

export function openExistingDbReadOnly(
  dataDir: string,
): MomentumDb | undefined {
  const dbPath = path.join(dataDir, "momentum.db");
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function openExistingDbMigratedReadOnly(
  dataDir: string,
  options: OpenDbOptions = {},
): MomentumDb | undefined {
  const dbPath = path.join(dataDir, "momentum.db");
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }
  // Current executor readers query the renamed columns. Apply only the
  // vocabulary migration when those legacy columns are present, preserving
  // compatibility with intentionally partial historical event databases.
  const migrationDb = new DatabaseSync(dbPath);
  try {
    if (
      databaseColumnExists(
        migrationDb,
        "executor_attempts",
        "executor_family",
      ) ||
      databaseColumnExists(migrationDb, "executor_rounds", "executor_family")
    ) {
      applyWorkflowVocabularyMigration(migrationDb, {
        claimedExecutorNames: configuredExecutorNames(
          options.env ?? process.env,
        ),
      });
    }
  } finally {
    migrationDb.close();
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function databaseColumnExists(
  db: MomentumDb,
  table: string,
  column: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((row) => row.name === column);
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

type SqliteError = Error & { errcode?: number };

/**
 * True when `error` is a node:sqlite UNIQUE constraint violation. Prefers the
 * extended SQLite error code (2067) and falls back to the message string for
 * older runtimes that don't surface `errcode`.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as SqliteError).errcode;
  if (typeof errcode === "number" && errcode === SQLITE_CONSTRAINT_UNIQUE) {
    return true;
  }
  return /UNIQUE constraint failed/.test(error.message);
}
