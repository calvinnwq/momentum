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

const UPDATE_INTENT_M6_COLUMNS: ColumnSpec[] = [
  { name: "apply_state", type: "TEXT NOT NULL DEFAULT 'idle'" }
];

const EVIDENCE_RECORD_LINKAGE_COLUMNS: ColumnSpec[] = [
  { name: "run_id", type: "TEXT" },
  { name: "step_id", type: "TEXT" }
];

const GOAL_REDUCER_COLUMNS: ColumnSpec[] = [
  { name: "current_iteration", type: "INTEGER NOT NULL DEFAULT 0" },
  { name: "completion_reason", type: "TEXT" },
  { name: "needs_manual_recovery", type: "INTEGER NOT NULL DEFAULT 0" },
  { name: "manual_recovery_reason", type: "TEXT" },
  { name: "manual_recovery_at", type: "INTEGER" }
];

const DAEMON_RUN_COLUMNS: ColumnSpec[] = [
  { name: "stop_now_requested_at", type: "INTEGER" },
  { name: "cancel_outcome", type: "TEXT" },
  { name: "recovery_status", type: "TEXT" }
];

const WORKFLOW_RUN_IDENTITY_COLUMNS: ColumnSpec[] = [
  { name: "repo_path", type: "TEXT" },
  { name: "objective", type: "TEXT" },
  { name: "issue_scope_json", type: "TEXT NOT NULL DEFAULT '{}'" },
  { name: "route_json", type: "TEXT NOT NULL DEFAULT '{}'" },
  { name: "approval_boundary", type: "TEXT" },
  { name: "skill_revision", type: "TEXT" }
];

const WORKFLOW_RUN_MONITOR_ADVISORY_COLUMNS: ColumnSpec[] = [
  { name: "monitor_last_seen_state", type: "TEXT" },
  { name: "monitor_terminal", type: "INTEGER" },
  { name: "monitor_step", type: "TEXT" },
  { name: "monitor_last_seen_digest", type: "TEXT" },
  { name: "monitor_last_emitted_digest", type: "TEXT" }
];

// M10-02 (NGX-346): link a workflow run back to the WorkflowDefinition recipe it
// was started from, so a workflow-first run start records its (key, version)
// provenance. Nullable because pre-M10 runs (e.g. imported coding-workflow
// artifacts) have no persisted definition link.
const WORKFLOW_RUN_DEFINITION_COLUMNS: ColumnSpec[] = [
  { name: "workflow_definition_key", type: "TEXT" },
  { name: "workflow_definition_version", type: "INTEGER" }
];

const WORKFLOW_STEP_OPERATOR_COLUMNS: ColumnSpec[] = [
  { name: "operator_reason", type: "TEXT" },
  { name: "operator_actor", type: "TEXT" },
  { name: "operator_evidence_pointer", type: "TEXT" },
  { name: "operator_ledger_pointer", type: "TEXT" },
  { name: "operator_transition_at", type: "INTEGER" }
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
  recovery_status TEXT,
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


const EVIDENCE_RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS evidence_records (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_records_ingest_key
  ON evidence_records(ingest_key);

CREATE INDEX IF NOT EXISTS idx_evidence_records_goal
  ON evidence_records(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_records_source_item
  ON evidence_records(source_item_id) WHERE source_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_records_source_type
  ON evidence_records(source, type);

CREATE INDEX IF NOT EXISTS idx_evidence_records_occurred_at
  ON evidence_records(occurred_at);
`;

// Created after the additive linkage columns exist so the index works on both
// fresh and upgraded data dirs. The composite (run_id, step_id) index serves
// run-scoped and run+step-scoped evidence lookups via its leftmost prefix.
const EVIDENCE_RECORDS_LINKAGE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_evidence_records_run_step
  ON evidence_records(run_id, step_id) WHERE run_id IS NOT NULL;
`;

const SOURCE_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS source_items (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_items_adapter_external
  ON source_items(adapter_kind, external_id);

CREATE INDEX IF NOT EXISTS idx_source_items_goal_id
  ON source_items(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_items_adapter_kind
  ON source_items(adapter_kind);

CREATE TABLE IF NOT EXISTS source_snapshots (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  adapter_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_source_snapshots_item_observed
  ON source_snapshots(source_item_id, observed_at);

CREATE TABLE IF NOT EXISTS source_reconciliation_runs (
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

CREATE INDEX IF NOT EXISTS idx_source_reconciliation_runs_adapter_started
  ON source_reconciliation_runs(adapter_kind, started_at);
`;

const UPDATE_INTENTS_DDL = `
CREATE TABLE IF NOT EXISTS update_intents (
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
  canceled_at INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_update_intents_idempotency_key
  ON update_intents(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_update_intents_status
  ON update_intents(status);

CREATE INDEX IF NOT EXISTS idx_update_intents_goal
  ON update_intents(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_update_intents_source_item
  ON update_intents(source_item_id) WHERE source_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_update_intents_evidence
  ON update_intents(evidence_record_id) WHERE evidence_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_update_intents_adapter_target
  ON update_intents(adapter_kind, target_external_id);

CREATE INDEX IF NOT EXISTS idx_update_intents_created_at
  ON update_intents(created_at);
`;

const INTENT_APPLY_AUDITS_DDL = `
CREATE TABLE IF NOT EXISTS intent_apply_audits (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES update_intents(id),
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
) STRICT;

CREATE INDEX IF NOT EXISTS idx_intent_apply_audits_intent_id
  ON intent_apply_audits(intent_id);

CREATE INDEX IF NOT EXISTS idx_intent_apply_audits_lifecycle_state
  ON intent_apply_audits(lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_intent_apply_audits_finished_at
  ON intent_apply_audits(finished_at);

CREATE INDEX IF NOT EXISTS idx_intent_apply_audits_created_at
  ON intent_apply_audits(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_apply_audits_active
  ON intent_apply_audits(intent_id) WHERE lifecycle_state = 'claimed';
`;

const WORKFLOW_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  goal_id TEXT REFERENCES goals(id),
  source TEXT NOT NULL,
  source_artifact_path TEXT,
  plan_json TEXT NOT NULL DEFAULT '{}',
  repo_path TEXT,
  objective TEXT,
  issue_scope_json TEXT NOT NULL DEFAULT '{}',
  route_json TEXT NOT NULL DEFAULT '{}',
  approval_boundary TEXT,
  skill_revision TEXT,
  workflow_definition_key TEXT,
  workflow_definition_version INTEGER,
  monitor_last_seen_state TEXT,
  monitor_terminal INTEGER,
  monitor_step TEXT,
  monitor_last_seen_digest TEXT,
  monitor_last_emitted_digest TEXT,
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

CREATE INDEX IF NOT EXISTS idx_workflow_runs_state
  ON workflow_runs(state);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_goal
  ON workflow_runs(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_batch_group
  ON workflow_runs(batch_group) WHERE batch_group IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_needs_manual_recovery
  ON workflow_runs(needs_manual_recovery)
  WHERE needs_manual_recovery = 1;

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  step_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  ledger_offset INTEGER,
  result_digest TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  operator_reason TEXT,
  operator_actor TEXT,
  operator_evidence_pointer TEXT,
  operator_ledger_pointer TEXT,
  operator_transition_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_steps_run
  ON workflow_steps(run_id);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_state
  ON workflow_steps(state);

CREATE TABLE IF NOT EXISTS workflow_approvals (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  boundary TEXT NOT NULL,
  actor TEXT,
  phrase TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  discharged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, boundary)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_approvals_run
  ON workflow_approvals(run_id);

CREATE TABLE IF NOT EXISTS workflow_leases (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  lease_kind TEXT NOT NULL,
  holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  released_at INTEGER,
  stale_policy TEXT NOT NULL DEFAULT 'auto-release',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, lease_kind)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_leases_run
  ON workflow_leases(run_id);

CREATE INDEX IF NOT EXISTS idx_workflow_leases_expires_at
  ON workflow_leases(expires_at);
`;

const WORKFLOW_RUNS_IDENTITY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo_path
  ON workflow_runs(repo_path) WHERE repo_path IS NOT NULL;
`;

// M10-01 (NGX-345): durable WorkflowDefinition / StepDefinition primitives.
// A definition is identified by (key, version) so recipes can evolve without
// losing prior versions; its steps hang off that composite identity. Both
// tables mirror the pure `WorkflowDefinition` / `StepDefinition` domain shape in
// src/workflow-definition.ts (no rich ExecutorDefinition config beyond the
// executor-family field, no run state — those arrive in later M10 slices).
const WORKFLOW_DEFINITIONS_DDL = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, version)
) STRICT;

CREATE TABLE IF NOT EXISTS step_definitions (
  definition_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  executor TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (definition_key, definition_version, step_key),
  FOREIGN KEY (definition_key, definition_version)
    REFERENCES workflow_definitions(key, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_step_definitions_definition
  ON step_definitions(definition_key, definition_version);
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
    db.exec(SOURCE_ITEMS_DDL);
    db.exec(EVIDENCE_RECORDS_DDL);
    if (tableExists(db, "evidence_records")) {
      for (const column of EVIDENCE_RECORD_LINKAGE_COLUMNS) {
        ensureColumn(db, "evidence_records", column);
      }
    }
    db.exec(EVIDENCE_RECORDS_LINKAGE_INDEX_DDL);
    db.exec(UPDATE_INTENTS_DDL);
    if (tableExists(db, "update_intents")) {
      for (const column of UPDATE_INTENT_M6_COLUMNS) {
        ensureColumn(db, "update_intents", column);
      }
    }
    db.exec(INTENT_APPLY_AUDITS_DDL);
    if (tableExists(db, "daemon_runs")) {
      for (const column of DAEMON_RUN_COLUMNS) {
        ensureColumn(db, "daemon_runs", column);
      }
    }
    db.exec(WORKFLOW_RUNS_DDL);
    if (tableExists(db, "workflow_runs")) {
      for (const column of WORKFLOW_RUN_IDENTITY_COLUMNS) {
        ensureColumn(db, "workflow_runs", column);
      }
      for (const column of WORKFLOW_RUN_MONITOR_ADVISORY_COLUMNS) {
        ensureColumn(db, "workflow_runs", column);
      }
      for (const column of WORKFLOW_RUN_DEFINITION_COLUMNS) {
        ensureColumn(db, "workflow_runs", column);
      }
    }
    if (tableExists(db, "workflow_steps")) {
      for (const column of WORKFLOW_STEP_OPERATOR_COLUMNS) {
        ensureColumn(db, "workflow_steps", column);
      }
    }
    db.exec(WORKFLOW_RUNS_IDENTITY_INDEX_DDL);
    db.exec(WORKFLOW_DEFINITIONS_DDL);
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
