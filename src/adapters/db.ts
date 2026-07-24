import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyQueueMigrations,
  applyWorkflowVocabularyMigration,
} from "./db/migrations.js";

export type MomentumDb = DatabaseSync;

export type OpenDbOptions = {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type ConfiguredExecutorClaims = {
  names: ReadonlySet<string>;
  known: boolean;
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
  const db = new DatabaseSync(dbPath, {
    timeout: options.timeoutMs ?? SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    db.exec(SCHEMA);
    const executorClaims = configuredExecutorClaims(options.env ?? process.env);
    applyQueueMigrations(db, {
      claimedExecutorNames: executorClaims.names,
      executorClaimsKnown: executorClaims.known,
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function configuredExecutorNames(
  env: Record<string, string | undefined>,
): ReadonlySet<string> {
  return configuredExecutorClaims(env).names;
}

export function configuredExecutorClaims(
  env: Record<string, string | undefined>,
): ConfiguredExecutorClaims {
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
  if (fs.existsSync(dataDir) && !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`Data directory is not a directory: ${dataDir}`);
  }
  const dbPath = path.join(dataDir, "momentum.db");
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }
  // SDK-05 databases need the full prerequisite migration chain before the
  // vocabulary pass. Near-current databases need only the vocabulary pass,
  // preserving compatibility with intentionally partial historical event
  // databases that do not carry executor runtime tables.
  const migrationDb = new DatabaseSync(dbPath, {
    // A read-only command must not wait behind an unrelated writer while
    // attempting an optional legacy vocabulary upgrade. If the upgrade cannot
    // acquire the lock immediately, the read path below serves a consistent
    // migrated snapshot instead.
    timeout: 0,
  });
  let requiresFullMigration = false;
  let migrationBusy = false;
  try {
    requiresFullMigration = databaseTableExists(
      migrationDb,
      "executor_invocations",
    );
    if (!requiresFullMigration) {
      const executorClaims = configuredExecutorClaims(
        options.env ?? process.env,
      );
      try {
        applyWorkflowVocabularyMigration(migrationDb, {
          claimedExecutorNames: executorClaims.names,
          executorClaimsKnown: executorClaims.known,
        });
      } catch (error) {
        if (!isSqliteBusyError(error)) throw error;
        migrationBusy = true;
      }
    }
  } finally {
    migrationDb.close();
  }
  if (migrationBusy) {
    return openMigratedReadOnlySnapshot(
      dataDir,
      options,
      requiresFullMigration,
    );
  }
  if (requiresFullMigration) {
    try {
      const upgraded = openDb(dataDir, { ...options, timeoutMs: 0 });
      upgraded.close();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      return openMigratedReadOnlySnapshot(dataDir, options, true);
    }
  }
  return new DatabaseSync(dbPath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
}

function openMigratedReadOnlySnapshot(
  dataDir: string,
  options: OpenDbOptions,
  requiresFullMigration: boolean,
): MomentumDb {
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-readonly-snapshot-"),
  );
  const snapshotPath = path.join(snapshotDir, "momentum.db");
  let snapshotDb: MomentumDb | undefined;
  let readOnlySnapshot: MomentumDb | undefined;
  try {
    const sourceDb = new DatabaseSync(path.join(dataDir, "momentum.db"), {
      readOnly: true,
      timeout: 0,
    });
    try {
      sourceDb.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    } finally {
      sourceDb.close();
    }

    snapshotDb = new DatabaseSync(snapshotPath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    const executorClaims = configuredExecutorClaims(options.env ?? process.env);
    if (requiresFullMigration) {
      snapshotDb.exec(SCHEMA);
      applyQueueMigrations(snapshotDb, {
        claimedExecutorNames: executorClaims.names,
        executorClaimsKnown: executorClaims.known,
      });
    } else {
      applyWorkflowVocabularyMigration(snapshotDb, {
        claimedExecutorNames: executorClaims.names,
        executorClaimsKnown: executorClaims.known,
      });
    }
    snapshotDb.close();
    snapshotDb = undefined;

    readOnlySnapshot = new DatabaseSync(snapshotPath, {
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    // The open handle keeps the unlinked snapshot alive for the caller while
    // avoiding stale files after a read-only command exits.
    fs.unlinkSync(snapshotPath);
    fs.rmdirSync(snapshotDir);
    return readOnlySnapshot;
  } catch (error) {
    snapshotDb?.close();
    readOnlySnapshot?.close();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

/** Whether a current-schema database durably claims an executor identity. */
export function hasDurableExecutorDefinition(
  db: MomentumDb,
  executorKey: string,
): boolean {
  if (!databaseTableExists(db, "executor_definitions")) return false;
  return (
    db
      .prepare(
        "SELECT 1 FROM executor_definitions WHERE executor_key = ? LIMIT 1",
      )
      .get(executorKey) !== undefined
  );
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

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as Error & { errcode?: number }).errcode;
  return (
    errcode === 5 ||
    errcode === 6 ||
    /database is locked|database table is locked|SQLITE_BUSY/i.test(
      error.message,
    )
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
