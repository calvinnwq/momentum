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
const SQLITE_BUSY_TIMEOUT_MS = 5000;

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
  const db = new DatabaseSync(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  db.exec(SCHEMA);
  const executorClaims = configuredExecutorClaims(options.env ?? process.env);
  applyQueueMigrations(db, {
    claimedExecutorNames: executorClaims.names,
    executorClaimsKnown: executorClaims.known,
  });
  return db;
}

export function configuredExecutorNames(
  env: Record<string, string | undefined>,
): ReadonlySet<string> {
  return configuredExecutorClaims(env).names;
}

function configuredExecutorClaims(env: Record<string, string | undefined>): {
  names: ReadonlySet<string>;
  known: boolean;
} {
  // Migrations run before daemon module loading, so read only the configured
  // identity keys here. If the registry file cannot be read reliably, preserve
  // ambiguous legacy identities until ownership can be established.
  const source = (env[EXECUTOR_CONFIG_ENV_VAR] ?? "").trim();
  if (source.length === 0) return { names: new Set(), known: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(source, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { names: new Set(), known: false };
    }
    const executors = (parsed as Record<string, unknown>)["executors"];
    if (
      executors === null ||
      typeof executors !== "object" ||
      Array.isArray(executors)
    ) {
      return { names: new Set(), known: false };
    }
    return { names: new Set(Object.keys(executors)), known: true };
  } catch {
    return { names: new Set(), known: false };
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
  // SDK-05 databases need the full prerequisite migration chain before the
  // vocabulary pass. Near-current databases need only the vocabulary pass,
  // preserving compatibility with intentionally partial historical event
  // databases that do not carry executor runtime tables.
  const migrationDb = new DatabaseSync(dbPath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  let requiresFullMigration = false;
  try {
    requiresFullMigration = databaseTableExists(
      migrationDb,
      "executor_invocations",
    );
    if (!requiresFullMigration) {
      const executorClaims = configuredExecutorClaims(
        options.env ?? process.env,
      );
      applyWorkflowVocabularyMigration(migrationDb, {
        claimedExecutorNames: executorClaims.names,
        executorClaimsKnown: executorClaims.known,
      });
    }
  } finally {
    migrationDb.close();
  }
  if (requiresFullMigration) {
    const upgraded = openDb(dataDir, options);
    upgraded.close();
  }
  return new DatabaseSync(dbPath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
}

function databaseTableExists(db: MomentumDb, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table) !== undefined
  );
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
