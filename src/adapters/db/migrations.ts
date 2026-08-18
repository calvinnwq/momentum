import type { DatabaseSync } from "node:sqlite";

import {
  applyWorkflowRouteStateMigrationInTransaction,
  assertWorkflowRouteStatePlanCurrent,
  preScanRouteState,
  refreshWorkflowRouteStatePlan,
  routeStateMigrationNeeded,
  upgradeWorkflowRunImportMetadataSchemaInTransaction,
  workflowRunImportMetadataSchemaMigrationNeeded,
  type WorkflowRouteStatePlan,
} from "./route-state.js";
import { RouteStateMigrationError } from "./route-state-errors.js";

type MomentumDb = DatabaseSync;

export type QueueMigrationOptions = {
  claimedExecutorNames?: ReadonlySet<string>;
  executorClaimsKnown?: boolean;
};

type ColumnSpec = { name: string; type: string };

const JOB_QUEUE_COLUMNS: ColumnSpec[] = [
  { name: "idempotency_key", type: "TEXT" },
  { name: "worker_id", type: "TEXT" },
  { name: "lease_acquired_at", type: "INTEGER" },
  { name: "lease_expires_at", type: "INTEGER" },
  { name: "heartbeat_at", type: "INTEGER" },
  { name: "result_path", type: "TEXT" },
  { name: "error_path", type: "TEXT" },
];

const INTENT_M6_COLUMNS: ColumnSpec[] = [
  { name: "apply_state", type: "TEXT NOT NULL DEFAULT 'idle'" },
];

const EVIDENCE_RECORD_LINKAGE_COLUMNS: ColumnSpec[] = [
  { name: "run_id", type: "TEXT" },
  { name: "step_id", type: "TEXT" },
];

const GOAL_REDUCER_COLUMNS: ColumnSpec[] = [
  { name: "current_iteration", type: "INTEGER NOT NULL DEFAULT 0" },
  { name: "completion_reason", type: "TEXT" },
  { name: "needs_manual_recovery", type: "INTEGER NOT NULL DEFAULT 0" },
  { name: "manual_recovery_reason", type: "TEXT" },
  { name: "manual_recovery_at", type: "INTEGER" },
];

const DAEMON_RUN_COLUMNS: ColumnSpec[] = [
  { name: "stop_now_requested_at", type: "INTEGER" },
  { name: "cancel_outcome", type: "TEXT" },
  { name: "recovery_status", type: "TEXT" },
];

const WORKFLOW_RUN_IDENTITY_COLUMNS: ColumnSpec[] = [
  { name: "repo_path", type: "TEXT" },
  { name: "objective", type: "TEXT" },
  { name: "issue_scope_json", type: "TEXT NOT NULL DEFAULT '{}'" },
  { name: "approval_boundary", type: "TEXT" },
  { name: "skill_revision", type: "TEXT" },
];

const WORKFLOW_RUN_MONITOR_ADVISORY_COLUMNS: ColumnSpec[] = [
  { name: "monitor_last_seen_state", type: "TEXT" },
  { name: "monitor_terminal", type: "INTEGER" },
  { name: "monitor_step", type: "TEXT" },
  { name: "monitor_last_seen_digest", type: "TEXT" },
  { name: "monitor_last_emitted_digest", type: "TEXT" },
  { name: "monitor_last_seen_at", type: "INTEGER" },
  { name: "monitor_last_emitted_at", type: "INTEGER" },
];

// Link a workflow run back to the WorkflowDefinition recipe it
// was started from, so a workflow-first run start records its (key, version)
// provenance. Nullable because older runs (e.g. imported coding-workflow
// artifacts) have no persisted definition link.
const WORKFLOW_RUN_DEFINITION_COLUMNS: ColumnSpec[] = [
  { name: "workflow_definition_key", type: "TEXT" },
  { name: "workflow_definition_version", type: "INTEGER" },
];

const STEP_DEFINITION_CONFIG_COLUMNS: ColumnSpec[] = [
  { name: "config_json", type: "TEXT" },
];

const WORKFLOW_STEP_OPERATOR_COLUMNS: ColumnSpec[] = [
  { name: "operator_reason", type: "TEXT" },
  { name: "operator_actor", type: "TEXT" },
  { name: "operator_evidence_pointer", type: "TEXT" },
  { name: "operator_ledger_pointer", type: "TEXT" },
  { name: "operator_transition_at", type: "INTEGER" },
];

const EXECUTOR_DECISION_EXTERNAL_REF_COLUMNS: ColumnSpec[] = [
  { name: "external_ref", type: "TEXT" },
];

const EXECUTOR_ROUND_LEARNING_COLUMNS: ColumnSpec[] = [
  { name: "key_learnings", type: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "verification_results", type: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "executor_recommendation", type: "TEXT" },
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
  tracker_item_id TEXT REFERENCES tracker_items(id),
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

CREATE INDEX IF NOT EXISTS idx_evidence_records_tracker_item
  ON evidence_records(tracker_item_id) WHERE tracker_item_id IS NOT NULL;

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

const TRACKER_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS tracker_items (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_items_adapter_external
  ON tracker_items(adapter_kind, external_id);

CREATE INDEX IF NOT EXISTS idx_tracker_items_goal_id
  ON tracker_items(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracker_items_adapter_kind
  ON tracker_items(adapter_kind);

CREATE TABLE IF NOT EXISTS tracker_snapshots (
  id TEXT PRIMARY KEY,
  tracker_item_id TEXT NOT NULL REFERENCES tracker_items(id),
  adapter_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tracker_snapshots_item_observed
  ON tracker_snapshots(tracker_item_id, observed_at);

CREATE TABLE IF NOT EXISTS tracker_reconciliation_runs (
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

CREATE INDEX IF NOT EXISTS idx_tracker_reconciliation_runs_adapter_started
  ON tracker_reconciliation_runs(adapter_kind, started_at);
`;

const INTENTS_DDL = `
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  target_external_id TEXT,
  intent_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  tracker_item_id TEXT REFERENCES tracker_items(id),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idempotency_key
  ON intents(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_intents_status
  ON intents(status);

CREATE INDEX IF NOT EXISTS idx_intents_goal
  ON intents(goal_id) WHERE goal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intents_tracker_item
  ON intents(tracker_item_id) WHERE tracker_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intents_evidence
  ON intents(evidence_record_id) WHERE evidence_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intents_adapter_target
  ON intents(adapter_kind, target_external_id);

CREATE INDEX IF NOT EXISTS idx_intents_created_at
  ON intents(created_at);
`;

const INTENT_APPLY_AUDITS_DDL = `
CREATE TABLE IF NOT EXISTS intent_apply_audits (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
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
  approval_boundary TEXT,
  skill_revision TEXT,
  workflow_definition_key TEXT,
  workflow_definition_version INTEGER,
  monitor_last_seen_state TEXT,
  monitor_terminal INTEGER,
  monitor_step TEXT,
  monitor_last_seen_digest TEXT,
  monitor_last_emitted_digest TEXT,
  monitor_last_seen_at INTEGER,
  monitor_last_emitted_at INTEGER,
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

// Durable WorkflowDefinition / StepDefinition primitives.
// A definition is identified by (key, version) so recipes can evolve without
// losing prior versions; its steps hang off that composite identity. Both
// tables mirror the pure `WorkflowDefinition` / `StepDefinition` domain shape in
// src/core/workflow/definition/definition.ts. Portable per-step executor intent
// lives in config_json, optional portable agent selection metadata lives in
// agent_config_json, and machine-local resolution plus run state stay elsewhere.
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
  config_json TEXT,
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

// Durable executor-loop spine nested below a `StepRun` so
// bounded autonomy never flattens into top-level workflow steps:
//
//   StepRun -> ExecutorAttempt -> ExecutorRound[]
//                                       -> ExecutorArtifact[]
//                                       -> ExecutorCheckpoint[]
//                                       -> ExecutorFinding[]
//                                       -> ExecutorDecision[]
//
// The spine tables mirror the pure `ExecutorDefinitionRecord` /
// `ExecutorAttemptRecord` / `ExecutorRoundRecord` shapes in
// src/core/executors/loop/reducer.ts (the round columns are exactly the contract
// "Round Schema" identity / execution / result fields). The four child evidence
// tables the contract names — `executor_artifacts` / `executor_findings` /
// `executor_decisions` / `executor_checkpoints` — hang below a round by
// `round_id`: artifacts pin the contract "Required Artifacts" classes as
// evidence pointers, checkpoints stream major executor stages (ordered + unique
// per round by `sequence`), findings carry review findings and their selected
// flag, and decisions carry durable decision points with their allowed actions
// and resolution. `string[]` fields (`log_paths`, `key_changes`,
// `remaining_work`, `changed_files`, `allowed_actions`) are stored as JSON TEXT.
// The FK references are *enforced* (node:sqlite defaults `PRAGMA foreign_keys =
// ON`), so an attempt requires a real `(workflow_run_id, step_run_id)`, a
// round requires a real attempt, and each evidence row requires a real
// round — bounded autonomy can never orphan itself above its owning StepRun.
const EXECUTOR_ATTEMPTS_DDL = `
CREATE TABLE IF NOT EXISTS executor_attempts (
  attempt_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  legacy_invocation_id TEXT,
  legacy_provenance TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id, step_run_id)
    REFERENCES workflow_steps(run_id, step_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_executor_attempts_run
  ON executor_attempts(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_executor_attempts_step
  ON executor_attempts(workflow_run_id, step_run_id);

CREATE INDEX IF NOT EXISTS idx_executor_attempts_state
  ON executor_attempts(state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_attempts_step_number
  ON executor_attempts(workflow_run_id, step_run_id, attempt_number);

CREATE INDEX IF NOT EXISTS idx_executor_attempts_legacy_invocation
  ON executor_attempts(legacy_invocation_id)
  WHERE legacy_invocation_id IS NOT NULL;
`;

// The executor_rounds column set, parameterized so the legacy attempt/round
// migration can rebuild the table under a scratch name before swapping it in.
function executorRoundsTableDdl(tableName: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (
  round_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES executor_attempts(attempt_id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  round_index INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  classification TEXT,
  executor_recommendation TEXT,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  agent_provider TEXT,
  model TEXT,
  effort TEXT,
  input_digest TEXT,
  result_digest TEXT,
  artifact_root TEXT,
  log_paths TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  key_changes TEXT NOT NULL DEFAULT '[]',
  key_learnings TEXT NOT NULL DEFAULT '[]',
  remaining_work TEXT NOT NULL DEFAULT '[]',
  changed_files TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT,
  verification_results TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT,
  recovery_code TEXT,
  human_gate TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id, step_run_id)
    REFERENCES workflow_steps(run_id, step_id)
) STRICT;
`;
}

const EXECUTOR_ROUNDS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_executor_rounds_attempt
  ON executor_rounds(attempt_id);

CREATE INDEX IF NOT EXISTS idx_executor_rounds_run
  ON executor_rounds(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_executor_rounds_step
  ON executor_rounds(workflow_run_id, step_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_rounds_attempt_index
  ON executor_rounds(attempt_id, round_index);
`;

const EXECUTOR_LOOP_DDL = `
CREATE TABLE IF NOT EXISTS executor_definitions (
  executor_key TEXT PRIMARY KEY,
  executor TEXT NOT NULL,
  agent_provider TEXT,
  model TEXT,
  effort TEXT,
  timeout_ms INTEGER,
  max_rounds INTEGER,
  policy_envelope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

${EXECUTOR_ATTEMPTS_DDL}

${executorRoundsTableDdl("executor_rounds")}

${EXECUTOR_ROUNDS_INDEX_DDL}

CREATE TABLE IF NOT EXISTS executor_artifacts (
  artifact_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  artifact_class TEXT NOT NULL,
  path TEXT NOT NULL,
  digest TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_executor_artifacts_round
  ON executor_artifacts(round_id);

CREATE TABLE IF NOT EXISTS executor_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_executor_checkpoints_round
  ON executor_checkpoints(round_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_checkpoints_round_sequence
  ON executor_checkpoints(round_id, sequence);

CREATE TABLE IF NOT EXISTS executor_findings (
  finding_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  severity TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  external_ref TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_executor_findings_round
  ON executor_findings(round_id);

CREATE TABLE IF NOT EXISTS executor_decisions (
  decision_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  summary TEXT NOT NULL,
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT,
  chosen_action TEXT,
  resolution TEXT,
  external_ref TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_executor_decisions_round
  ON executor_decisions(round_id);
`;

// Durable workflow gates and operator decisions. A gate is the
// contract "Human Gates" record — a durable pause record, not a prompt hidden
// inside an executor. Each gate hangs from exactly one layer of the workflow-first
// tree named by `target_scope` (workflow -> step -> attempt -> round), so the
// scope's anchor id plus its ancestry are stored and ids deeper than the scope
// stay null (enforced in src/core/workflow/gate/persist.ts). `workflow_run_id` is a
// NOT NULL FK to `workflow_runs(id)` because every gate belongs to a run; the
// deeper `step_run_id` / `attempt_id` / `round_id` are nullable evidence
// linkage. `allowed_actions` and `policy_envelope` are JSON TEXT arrays mirroring
// the pure `GateDecisionInput` shape. Openness is `resolved_at IS NULL`; a
// resolution stamps `resolved_at` / `resolved_by` / `resolution_mode` (operator |
// delegated) / `chosen_action` / `resolution` from the pure `evaluateGateDecision`
// brain in src/core/workflow/gate/gate.ts.
const WORKFLOW_GATES_DDL = `
CREATE TABLE IF NOT EXISTS workflow_gates (
  gate_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT,
  attempt_id TEXT,
  round_id TEXT,
  target_scope TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT,
  policy_envelope TEXT NOT NULL DEFAULT '[]',
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution_mode TEXT,
  chosen_action TEXT,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_gates_run
  ON workflow_gates(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_workflow_gates_open
  ON workflow_gates(workflow_run_id) WHERE resolved_at IS NULL;
`;

const WORKFLOW_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT,
  occurred_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_cursor
  ON workflow_events(run_id, occurred_at, event_id);
`;

// Legacy (SDK-05 era) invocation rows before the attempt/round migration.
type LegacyExecutorInvocationRow = {
  invocation_id: string;
  workflow_run_id: string;
  step_run_id: string;
  step_key: string;
  executor_family: string;
  state: string;
  attempt: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

type LegacyExecutorRoundGroupRow = {
  round_id: string;
  invocation_id: string;
  attempt: number;
  round_index: number;
  state: string;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

type LegacyExecutorAttemptGroup = {
  invocation: LegacyExecutorInvocationRow;
  legacyAttemptNumber: number;
  rounds: LegacyExecutorRoundGroupRow[];
  isLatest: boolean;
  lifecycleAt: number;
};

// Mirrors `EXECUTOR_ATTEMPT_TERMINAL_STATES` / `isTerminalExecutorAttemptState`
// in src/core/executors/loop/reducer.ts.
const LEGACY_TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

// Canonical spellings for renamed built-in executor values. An old spelling is
// only rewritten when durable definitions and the configured executor registry
// are known to claim neither spelling. Before the rename the registry refused
// duplicate built-in names, so an explicit registration under the old spelling
// can only be a third-party identity that must keep its recorded value
// everywhere. A claim on the replacement spelling also reserves that identity
// against receiving historical rows from a different owner.
const LEGACY_EXECUTOR_VALUE_RENAMES: ReadonlyArray<[string, string]> = [
  ["goal-loop", "agent-loop"],
  ["one-shot", "agent-once"],
];

function executorDefinitionClaimsKey(db: MomentumDb, key: string): boolean {
  if (!tableExists(db, "executor_definitions")) return false;
  return (
    db
      .prepare("SELECT 1 FROM executor_definitions WHERE executor_key = ?")
      .get(key) !== undefined
  );
}

function executorIdentityIsClaimed(
  db: MomentumDb,
  key: string,
  options: QueueMigrationOptions,
): boolean {
  return (
    options.executorClaimsKnown === false ||
    executorDefinitionClaimsKey(db, key) ||
    options.claimedExecutorNames?.has(key) === true
  );
}

function renameableLegacyExecutorValues(
  db: MomentumDb,
  options: QueueMigrationOptions,
): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  for (const [oldValue, newValue] of LEGACY_EXECUTOR_VALUE_RENAMES) {
    if (
      executorIdentityIsClaimed(db, oldValue, options) ||
      executorIdentityIsClaimed(db, newValue, options)
    ) {
      continue;
    }
    renames.set(oldValue, newValue);
  }
  return renames;
}

const LEGACY_RECOVERY_BEARING_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "manual_recovery_required",
  "blocked",
]);

function legacyAttemptGroupLifecycleAt(
  invocation: LegacyExecutorInvocationRow,
  rounds: readonly LegacyExecutorRoundGroupRow[],
  isLatest: boolean,
): number {
  const lifecycleStarts = rounds.map(
    (round) => round.started_at ?? round.created_at,
  );
  if (isLatest) {
    lifecycleStarts.push(invocation.started_at ?? invocation.updated_at);
  }
  return Math.min(...lifecycleStarts);
}

function compareLegacyAttemptGroups(
  left: LegacyExecutorAttemptGroup,
  right: LegacyExecutorAttemptGroup,
): number {
  return (
    left.lifecycleAt - right.lifecycleAt ||
    left.invocation.created_at - right.invocation.created_at ||
    left.invocation.invocation_id.localeCompare(
      right.invocation.invocation_id,
    ) ||
    left.legacyAttemptNumber - right.legacyAttemptNumber
  );
}

/**
 * Migrate the legacy SDK-05 `executor_invocations` schema into the immutable
 * `executor_attempts` model, in place and exactly once.
 *
 * The legacy model reopened one deterministic invocation row per step: a retry
 * incremented `attempt` on that row, its state/timestamps described only the
 * latest reopened lifecycle, and rounds from every retry shared the row via
 * `invocation_id` while each round carried its own `attempt` number.
 *
 * Mapping, per legacy invocation:
 *   - Attempt groups are the distinct round `attempt` numbers plus the
 *     invocation's own current `attempt` (a reopened row may not have written a
 *     round yet).
 *   - The highest-numbered group is the only lifecycle the invocation row still
 *     describes, so that attempt inherits the row's id, state, and timestamps
 *     unchanged. Preserving the id also preserves every external reference to
 *     it (gates, receipts, checkpoint details).
 *   - Earlier groups become immutable historical attempts with deterministic,
 *     collision-checked derived ids (`<invocationId>::attempt-<n>` when that
 *     id is free). Their state and timestamps are reconstructed from their own
 *     terminal rounds; a group whose last round is somehow non-terminal
 *     (impossible through the SDK-05 write path) is conservatively recorded as
 *     `manual_recovery_required` and flagged in provenance rather than
 *     inventing a clean terminal.
 *   - Every migrated attempt keeps `legacy_invocation_id` plus a compact
 *     `legacy_provenance` JSON describing how its facts were derived.
 *   - Rounds keep their ids, indices, and evidence links. Their parent key moves
 *     from the shared invocation to their own attempt row. When attempt numbers
 *     collide across legacy invocation rows for one step, groups are ordered by
 *     lifecycle and receive monotone step-wide numbers; provenance preserves a
 *     changed legacy number.
 *   - `workflow_gates.invocation_id` becomes `attempt_id` and round-scoped
 *     gates are re-anchored to the round's attempt. Historical rows keep the
 *     recorded `invocation` target scope so re-projected gate event ids (and
 *     the replay cursors holding them) stay stable; new gates write `attempt`.
 *
 * Idempotent: the legacy table is dropped inside the same transaction, so a
 * second open finds nothing to migrate. Runs outside the main migration
 * transaction because the table rebuild requires `PRAGMA foreign_keys = OFF`,
 * which SQLite ignores inside a transaction; a `foreign_key_check` over the
 * rebuilt tables guards the swap before commit.
 */
function migrateLegacyExecutorInvocationSchema(
  db: MomentumDb,
  options: QueueMigrationOptions,
): void {
  if (!tableExists(db, "executor_invocations")) return;
  // A partially upgraded SDK-05 database may have persisted invocations before
  // the legacy round table was created. The additive migration below creates
  // the current attempt/round tables; do not run the legacy rebuild against
  // a missing source table.
  if (!tableExists(db, "executor_rounds")) return;
  // A subsequent open of that partial database sees the additive current-shaped
  // round table. It is not a legacy source merely because the table exists;
  // the legacy rebuild requires its `invocation_id` parent column.
  if (!columnExists(db, "executor_rounds", "invocation_id")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Very old data dirs may predate the late round column backfills; align
      // the legacy table first so the rebuild below can copy every column.
      for (const column of EXECUTOR_ROUND_LEARNING_COLUMNS) {
        ensureColumn(db, "executor_rounds", column);
      }
      db.exec(EXECUTOR_ATTEMPTS_DDL);

      // The legacy source tables keep their recorded `executor_family` column
      // when read; the rebuilt tables write the renamed `executor` column, and
      // renamed built-in executor values are mapped in the same pass so one
      // upgrade from the oldest schema lands directly on the new vocabulary.
      const executorRenames = renameableLegacyExecutorValues(db, options);
      const canonicalExecutorValue = (value: string): string =>
        executorRenames.get(value) ?? value;

      const invocations = db
        .prepare(
          `SELECT invocation_id, workflow_run_id, step_run_id, step_key,
                  executor_family, state, attempt, started_at, heartbeat_at,
                  finished_at, created_at, updated_at
             FROM executor_invocations
            ORDER BY workflow_run_id, step_run_id, created_at, invocation_id`,
        )
        .all() as unknown as LegacyExecutorInvocationRow[];
      const insertAttempt = db.prepare(
        `INSERT INTO executor_attempts (
           attempt_id, workflow_run_id, step_run_id, step_key, executor,
           state, attempt_number, started_at, heartbeat_at, finished_at,
           legacy_invocation_id, legacy_provenance, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const attemptIdByLegacyGroup = new Map<string, string>();
      const reservedAttemptIds = new Set(
        invocations.map((invocation) => invocation.invocation_id),
      );
      const allocatedAttemptIds = new Set<string>();
      const allocateHistoricalAttemptId = (
        invocationId: string,
        attemptNumber: number,
      ): string => {
        const base = `${invocationId}::attempt-${attemptNumber}`;
        if (!reservedAttemptIds.has(base) && !allocatedAttemptIds.has(base)) {
          allocatedAttemptIds.add(base);
          return base;
        }
        let suffix = 1;
        while (true) {
          const candidate = `${base}::migrated-${suffix}`;
          if (
            !reservedAttemptIds.has(candidate) &&
            !allocatedAttemptIds.has(candidate)
          ) {
            allocatedAttemptIds.add(candidate);
            return candidate;
          }
          suffix += 1;
        }
      };
      // The legacy schema only made `invocation_id` unique, so one step can
      // carry several invocation rows (for example a dispatcher scaffold plus
      // an adapter-minted invocation) whose attempt numbers collide under the
      // new unique `(workflow_run_id, step_run_id, attempt_number)` index.
      // Colliding groups are renumbered deterministically by lifecycle time
      // while each invocation keeps its internal group order, and the original
      // number is preserved in provenance. If a multi-lineage step has live or
      // recovery-bearing work that would be renumbered or demoted, the run is
      // parked instead of guessing which lineage is authoritative.
      const attemptNumberByLegacyGroup = new Map<string, number>();
      const highestAssignedByStep = new Map<string, number>();
      const groupsByStep = new Map<
        string,
        {
          runId: string;
          stepId: string;
          groupsByInvocation: Map<string, LegacyExecutorAttemptGroup[]>;
        }
      >();
      const ambiguousRunReasons = new Map<string, string>();

      for (const invocation of invocations) {
        const rounds = db
          .prepare(
            `SELECT round_id, invocation_id, attempt, round_index, state,
                    started_at, heartbeat_at, finished_at, created_at, updated_at
               FROM executor_rounds
              WHERE invocation_id = ?
              ORDER BY attempt, round_index, round_id`,
          )
          .all(
            invocation.invocation_id,
          ) as unknown as LegacyExecutorRoundGroupRow[];
        const groups = new Map<number, LegacyExecutorRoundGroupRow[]>();
        for (const round of rounds) {
          const group = groups.get(round.attempt) ?? [];
          group.push(round);
          groups.set(round.attempt, group);
        }
        if (!groups.has(invocation.attempt)) {
          groups.set(invocation.attempt, []);
        }
        const attemptNumbers = [...groups.keys()].sort((a, b) => a - b);
        const latestAttemptNumber = attemptNumbers.at(-1)!;
        const stepKey = JSON.stringify([
          invocation.workflow_run_id,
          invocation.step_run_id,
        ]);
        const stepGroups = groupsByStep.get(stepKey) ?? {
          runId: invocation.workflow_run_id,
          stepId: invocation.step_run_id,
          groupsByInvocation: new Map<string, LegacyExecutorAttemptGroup[]>(),
        };
        stepGroups.groupsByInvocation.set(
          invocation.invocation_id,
          attemptNumbers.map((attemptNumber) => {
            const groupRounds = groups.get(attemptNumber)!;
            const isLatest = attemptNumber === latestAttemptNumber;
            return {
              invocation,
              legacyAttemptNumber: attemptNumber,
              rounds: groupRounds,
              isLatest,
              lifecycleAt: legacyAttemptGroupLifecycleAt(
                invocation,
                groupRounds,
                isLatest,
              ),
            };
          }),
        );
        groupsByStep.set(stepKey, stepGroups);
      }

      for (const [
        stepKey,
        { runId, stepId, groupsByInvocation },
      ] of groupsByStep) {
        const invocationQueues = [...groupsByInvocation.values()].map(
          (groups) => [...groups],
        );
        const assignedGroups: Array<{
          group: LegacyExecutorAttemptGroup;
          assignedAttemptNumber: number;
        }> = [];
        while (invocationQueues.some((groups) => groups.length > 0)) {
          const group = invocationQueues
            .filter((groups) => groups.length > 0)
            .sort((left, right) =>
              compareLegacyAttemptGroups(left[0]!, right[0]!),
            )[0]!
            .shift()!;
          const { invocation } = group;
          const attemptNumber = group.legacyAttemptNumber;
          const groupRounds = group.rounds;
          const attemptId = group.isLatest
            ? invocation.invocation_id
            : allocateHistoricalAttemptId(
                invocation.invocation_id,
                attemptNumber,
              );
          if (group.isLatest) allocatedAttemptIds.add(attemptId);
          const assignedAttemptNumber = Math.max(
            attemptNumber,
            (highestAssignedByStep.get(stepKey) ?? 0) + 1,
          );
          highestAssignedByStep.set(stepKey, assignedAttemptNumber);
          assignedGroups.push({ group, assignedAttemptNumber });
          attemptIdByLegacyGroup.set(
            `${invocation.invocation_id}::${attemptNumber}`,
            attemptId,
          );
          attemptNumberByLegacyGroup.set(
            `${invocation.invocation_id}::${attemptNumber}`,
            assignedAttemptNumber,
          );
          const renumbered = assignedAttemptNumber !== attemptNumber;
          if (group.isLatest) {
            insertAttempt.run(
              attemptId,
              invocation.workflow_run_id,
              invocation.step_run_id,
              invocation.step_key,
              canonicalExecutorValue(invocation.executor_family),
              invocation.state,
              assignedAttemptNumber,
              invocation.started_at,
              invocation.heartbeat_at,
              invocation.finished_at,
              invocation.invocation_id,
              JSON.stringify({
                legacyInvocationId: invocation.invocation_id,
                source: "legacy_invocation_row",
                ...(renumbered ? { legacyAttemptNumber: attemptNumber } : {}),
              }),
              invocation.created_at,
              invocation.updated_at,
            );
            continue;
          }
          const lastRound = groupRounds.at(-1);
          const lastRoundState = lastRound?.state;
          const stateReconstructed =
            lastRoundState === undefined ||
            !LEGACY_TERMINAL_ATTEMPT_STATES.has(lastRoundState);
          const state = stateReconstructed
            ? "manual_recovery_required"
            : lastRoundState;
          const startedAts = groupRounds
            .map((round) => round.started_at)
            .filter((value): value is number => value !== null);
          const heartbeatAts = groupRounds
            .map((round) => round.heartbeat_at)
            .filter((value): value is number => value !== null);
          const finishedAts = groupRounds
            .map((round) => round.finished_at)
            .filter((value): value is number => value !== null);
          insertAttempt.run(
            attemptId,
            invocation.workflow_run_id,
            invocation.step_run_id,
            invocation.step_key,
            canonicalExecutorValue(invocation.executor_family),
            state,
            assignedAttemptNumber,
            startedAts.length > 0 ? Math.min(...startedAts) : null,
            heartbeatAts.length > 0 ? Math.max(...heartbeatAts) : null,
            finishedAts.length > 0 ? Math.max(...finishedAts) : null,
            invocation.invocation_id,
            JSON.stringify({
              legacyInvocationId: invocation.invocation_id,
              source: "reconstructed_from_round_evidence",
              ...(renumbered ? { legacyAttemptNumber: attemptNumber } : {}),
              ...(stateReconstructed
                ? {
                    stateReconstructed: true,
                    lastRoundState: lastRoundState ?? null,
                  }
                : {}),
            }),
            groupRounds.length > 0
              ? Math.min(...groupRounds.map((round) => round.created_at))
              : invocation.created_at,
            groupRounds.length > 0
              ? Math.max(...groupRounds.map((round) => round.updated_at))
              : invocation.updated_at,
          );
        }

        if (groupsByInvocation.size > 1) {
          const highestAssigned = highestAssignedByStep.get(stepKey) ?? 0;
          const authorityBearingGroups = assignedGroups.filter(
            ({ group }) =>
              group.isLatest &&
              (!LEGACY_TERMINAL_ATTEMPT_STATES.has(group.invocation.state) ||
                LEGACY_RECOVERY_BEARING_ATTEMPT_STATES.has(
                  group.invocation.state,
                )),
          );
          const ambiguousAuthority = authorityBearingGroups.filter(
            ({ group, assignedAttemptNumber }) =>
              assignedAttemptNumber !== group.legacyAttemptNumber ||
              assignedAttemptNumber !== highestAssigned,
          );
          if (
            authorityBearingGroups.length > 1 ||
            ambiguousAuthority.length > 0
          ) {
            const carriesRecovery = authorityBearingGroups.some(({ group }) =>
              LEGACY_RECOVERY_BEARING_ATTEMPT_STATES.has(
                group.invocation.state,
              ),
            );
            if (!ambiguousRunReasons.has(runId)) {
              ambiguousRunReasons.set(
                runId,
                `attempt migration found multiple legacy executor lineages with ${carriesRecovery ? "recovery-bearing" : "live"} work for step ${stepId}; inspect the migrated attempts and clear recovery explicitly`,
              );
            }
          }
        }
      }

      // Fail closed on ambiguous authority-bearing lineages: the run opens with
      // every row and all evidence preserved, but is parked for operator
      // recovery instead of letting a renumbered or demoted live attempt resume
      // (its durable fences still encode the original attempt number) or
      // letting synthetic retry ancestry drive recovery or finalization.
      const parkRun = db.prepare(
        `UPDATE workflow_runs
            SET needs_manual_recovery = 1,
                manual_recovery_reason = CASE
                  WHEN manual_recovery_reason IS NULL
                    OR trim(manual_recovery_reason) = '' THEN ?
                  WHEN instr(manual_recovery_reason, ?) > 0
                    THEN manual_recovery_reason
                  ELSE manual_recovery_reason || char(10) || ?
                END,
                manual_recovery_at = COALESCE(manual_recovery_at, updated_at)
          WHERE id = ?`,
      );
      for (const [runId, reason] of ambiguousRunReasons) {
        parkRun.run(reason, reason, reason, runId);
      }

      // Rebuild executor_rounds under the attempt hierarchy. Round ids,
      // indices, evidence FKs, and every result column are preserved verbatim;
      // only the parent key changes.
      db.exec(executorRoundsTableDdl("executor_rounds_next"));
      const legacyRounds = db
        .prepare(
          `SELECT * FROM executor_rounds
            ORDER BY invocation_id, attempt, round_index, round_id`,
        )
        .all() as unknown as Array<Record<string, unknown>>;
      const insertRound = db.prepare(
        `INSERT INTO executor_rounds_next (
           round_id, attempt_id, workflow_run_id, step_run_id, step_key,
           executor, attempt_number, round_index, state, classification,
           executor_recommendation, started_at, heartbeat_at, finished_at,
           agent_provider, model, effort, input_digest, result_digest,
           artifact_root, log_paths, summary, key_changes, key_learnings,
           remaining_work, changed_files, verification_status,
           verification_results, commit_sha, recovery_code, human_gate,
           created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      );
      for (const round of legacyRounds) {
        const legacyGroupKey = `${String(round.invocation_id)}::${Number(round.attempt)}`;
        const attemptId = attemptIdByLegacyGroup.get(legacyGroupKey);
        const assignedAttemptNumber =
          attemptNumberByLegacyGroup.get(legacyGroupKey);
        if (attemptId === undefined || assignedAttemptNumber === undefined) {
          throw new Error(
            `executor attempt migration cannot re-anchor round ${String(round.round_id)}: no attempt group for invocation ${String(round.invocation_id)} attempt ${String(round.attempt)}`,
          );
        }
        insertRound.run(
          round.round_id as string,
          attemptId,
          round.workflow_run_id as string,
          round.step_run_id as string,
          round.step_key as string,
          canonicalExecutorValue(round.executor_family as string),
          assignedAttemptNumber,
          round.round_index as number,
          round.state as string,
          round.classification as string | null,
          round.executor_recommendation as string | null,
          round.started_at as number | null,
          round.heartbeat_at as number | null,
          round.finished_at as number | null,
          round.agent_provider as string | null,
          round.model as string | null,
          round.effort as string | null,
          round.input_digest as string | null,
          round.result_digest as string | null,
          round.artifact_root as string | null,
          round.log_paths as string,
          round.summary as string | null,
          round.key_changes as string,
          round.key_learnings as string,
          round.remaining_work as string,
          round.changed_files as string,
          round.verification_status as string | null,
          round.verification_results as string,
          round.commit_sha as string | null,
          round.recovery_code as string | null,
          round.human_gate as string | null,
          round.created_at as number,
          round.updated_at as number,
        );
      }
      db.exec("DROP TABLE executor_rounds");
      db.exec("ALTER TABLE executor_rounds_next RENAME TO executor_rounds");
      db.exec(EXECUTOR_ROUNDS_INDEX_DDL);

      // Delegate handoff-intent checkpoints fence their payload's `attempt`
      // against the owning round's attempt number. For groups the collision
      // renumbering moved, translate that one field so an in-flight renumbered
      // lineage stays resumable; every other checkpoint payload is
      // attempt-number-free and stays frozen verbatim.
      const renumberedGroups = [...attemptNumberByLegacyGroup.entries()].filter(
        ([key, assigned]) =>
          Number(key.slice(key.lastIndexOf("::") + 2)) !== assigned,
      );
      if (renumberedGroups.length > 0) {
        const selectIntentCheckpoints = db.prepare(
          `SELECT c.checkpoint_id, c.detail
             FROM executor_checkpoints AS c
             JOIN executor_rounds AS r ON r.round_id = c.round_id
            WHERE r.attempt_id = ?
              AND c.stage = 'delegate_handoff_intent'
              AND c.detail IS NOT NULL`,
        );
        const updateIntentDetail = db.prepare(
          "UPDATE executor_checkpoints SET detail = ? WHERE checkpoint_id = ?",
        );
        for (const [key, assigned] of renumberedGroups) {
          const attemptId = attemptIdByLegacyGroup.get(key);
          if (attemptId === undefined) continue;
          const originalNumber = Number(key.slice(key.lastIndexOf("::") + 2));
          const checkpoints = selectIntentCheckpoints.all(attemptId) as Array<{
            checkpoint_id: string;
            detail: string;
          }>;
          for (const checkpoint of checkpoints) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(checkpoint.detail);
            } catch {
              continue;
            }
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed) ||
              (parsed as { attempt?: unknown }).attempt !== originalNumber
            ) {
              continue;
            }
            updateIntentDetail.run(
              JSON.stringify({
                ...(parsed as Record<string, unknown>),
                attempt: assigned,
              }),
              checkpoint.checkpoint_id,
            );
          }
        }
      }

      if (
        tableExists(db, "workflow_gates") &&
        columnExists(db, "workflow_gates", "invocation_id")
      ) {
        db.exec(
          "ALTER TABLE workflow_gates RENAME COLUMN invocation_id TO attempt_id",
        );
        // Historical gate rows keep their recorded `invocation` target scope:
        // `workflow run events` re-projects gate events from these rows and
        // hashes `targetScope` into each event id, so rewriting the value
        // would re-issue already-consumed events to replay cursors. The legacy
        // scope value is read-only provenance; new gates write `attempt`.
        // A round-scoped gate identifies its attempt through its round; the
        // remaining attempt references are the latest lifecycle the legacy
        // invocation row described, and that attempt kept the legacy id.
        db.exec(
          `UPDATE workflow_gates
              SET attempt_id = (
                SELECT executor_rounds.attempt_id
                  FROM executor_rounds
                 WHERE executor_rounds.round_id = workflow_gates.round_id
              )
            WHERE round_id IS NOT NULL
              AND attempt_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM executor_rounds
                 WHERE executor_rounds.round_id = workflow_gates.round_id
              )`,
        );
      }

      db.exec("DROP TABLE executor_invocations");

      const violations = db
        .prepare("PRAGMA foreign_key_check(executor_rounds)")
        .all();
      const attemptViolations = db
        .prepare("PRAGMA foreign_key_check(executor_attempts)")
        .all();
      if (violations.length > 0 || attemptViolations.length > 0) {
        throw new Error(
          "executor attempt migration produced foreign-key violations; rolling back",
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const PARTIAL_LEGACY_INVOCATION_REQUIRED_COLUMNS: readonly string[] = [
  "invocation_id",
  "workflow_run_id",
  "step_run_id",
  "step_key",
  "executor_family",
  "state",
  "attempt",
  "created_at",
  "updated_at",
];

// Every `executor_attempts` column the partial SDK-05 phase writes. The phase
// builds its INSERT from this list and the preflight requires each column on a
// pre-existing destination table, so the two can never drift. The list also
// covers every column the phase reads back (`attempt_id`,
// `legacy_invocation_id`, `attempt_number`).
const PARTIAL_LEGACY_INVOCATION_ATTEMPT_COLUMNS: readonly string[] = [
  "attempt_id",
  "workflow_run_id",
  "step_run_id",
  "step_key",
  "executor",
  "state",
  "attempt_number",
  "started_at",
  "heartbeat_at",
  "finished_at",
  "legacy_invocation_id",
  "legacy_provenance",
  "created_at",
  "updated_at",
];

/**
 * Read-only preconditions of `migratePartialLegacyExecutorInvocationSchema`:
 * when that phase would run (a legacy invocation table with no legacy round
 * source), every deterministic refusal the phase can raise is replicated here
 * without mutating anything - the required-column contract of the legacy
 * source table, the destination-table contract (every `executor_attempts`
 * column the phase's INSERT names, when that table pre-exists), the collision
 * with an unrelated current attempt, and the foreign-key parents of every
 * row the phase would insert. Shared with the migration itself so the
 * up-front refusal and the phase's own refusals can never drift, and hoisted
 * into the fail-closed block at the top of `applyQueueMigrations` because the
 * phase runs after the tracker rename and the additive pass; without the
 * preflight its refusal would strand a committed rename beside the
 * unmigrated legacy executor table.
 */
function assertPartialLegacyInvocationMigrationPreconditions(
  db: MomentumDb,
): void {
  if (!tableExists(db, "executor_invocations")) return;
  if (
    tableExists(db, "executor_rounds") &&
    columnExists(db, "executor_rounds", "invocation_id")
  ) {
    return;
  }
  const missingColumn = PARTIAL_LEGACY_INVOCATION_REQUIRED_COLUMNS.find(
    (column) => !columnExists(db, "executor_invocations", column),
  );
  if (missingColumn !== undefined) {
    throw new Error(
      `partial SDK-05 invocation migration is missing required column ${missingColumn}`,
    );
  }

  // A pre-existing destination table must already carry every column the
  // phase's INSERT names; the additive pass never repairs `executor_attempts`
  // columns, and preparing any statement against a partial table would throw
  // an unhelpful error here or - worse - only inside the phase, after the
  // tracker rename committed. An absent table needs no check: the additive
  // DDL pass creates it in full current shape before the phase runs.
  if (tableExists(db, "executor_attempts")) {
    const missingAttemptColumn = PARTIAL_LEGACY_INVOCATION_ATTEMPT_COLUMNS.find(
      (column) => !columnExists(db, "executor_attempts", column),
    );
    if (missingAttemptColumn !== undefined) {
      throw new Error(
        `partial SDK-05 invocation migration target executor_attempts is missing required column ${missingAttemptColumn}`,
      );
    }
  }

  // Replicate the phase's remaining deterministic refusals read-only, in the
  // phase's own iteration order. A row whose existing attempt already records
  // this invocation is the phase's idempotent skip; it is neither refused nor
  // FK-checked. An absent parent table counts as a missing parent row: the
  // additive pass creates the table empty, so the phase's post-insert
  // foreign_key_check would still refuse. Both foreign-key columns of
  // `executor_attempts` are NOT NULL, so every inserted row is FK-enforced.
  const existingAttempt = tableExists(db, "executor_attempts")
    ? db.prepare(
        `SELECT attempt_id, legacy_invocation_id
           FROM executor_attempts
          WHERE attempt_id = ?`,
      )
    : undefined;
  const workflowRunById = tableExists(db, "workflow_runs")
    ? db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?")
    : undefined;
  const workflowStepByIdentity = tableExists(db, "workflow_steps")
    ? db.prepare(
        "SELECT 1 FROM workflow_steps WHERE run_id = ? AND step_id = ?",
      )
    : undefined;
  const invocations = db
    .prepare(
      `SELECT invocation_id, workflow_run_id, step_run_id
         FROM executor_invocations
        ORDER BY workflow_run_id, step_run_id, created_at, invocation_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const invocation of invocations) {
    const invocationId = String(invocation.invocation_id);
    const existing = existingAttempt?.get(invocationId) as
      { attempt_id: string; legacy_invocation_id: string | null } | undefined;
    if (existing !== undefined) {
      if (existing.legacy_invocation_id === invocationId) continue;
      throw new Error(
        `partial SDK-05 invocation migration collides with current attempt ${invocationId}`,
      );
    }
    const workflowRunId = String(invocation.workflow_run_id);
    const stepRunId = String(invocation.step_run_id);
    if (workflowRunById?.get(workflowRunId) === undefined) {
      throw new Error(
        `partial SDK-05 invocation migration would produce foreign-key violations: ` +
          `invocation ${invocationId} references missing workflow run ${workflowRunId}; ` +
          "repair the parent row or remove the invocation before reopening this database",
      );
    }
    if (workflowStepByIdentity?.get(workflowRunId, stepRunId) === undefined) {
      throw new Error(
        `partial SDK-05 invocation migration would produce foreign-key violations: ` +
          `invocation ${invocationId} references missing workflow step ${stepRunId} in run ${workflowRunId}; ` +
          "repair the parent row or remove the invocation before reopening this database",
      );
    }
  }
}

/**
 * Complete the interrupted SDK-05 migration shape where invocations were
 * persisted but no legacy rounds were ever written. The normal rebuild cannot
 * reconstruct round evidence in this case, but the invocation itself still
 * represents a durable executor attempt and must not be hidden or discarded.
 *
 * This runs after the additive current-schema pass, so the invocation becomes a
 * current attempt with no fabricated round. The legacy table is dropped only in
 * the same transaction that inserts every source row, making repeated opens
 * idempotent and preventing the next open from mistaking a current round table
 * for a legacy source.
 */
function migratePartialLegacyExecutorInvocationSchema(
  db: MomentumDb,
  options: QueueMigrationOptions,
): void {
  if (!tableExists(db, "executor_invocations")) return;
  if (
    tableExists(db, "executor_rounds") &&
    columnExists(db, "executor_rounds", "invocation_id")
  ) {
    return;
  }

  assertPartialLegacyInvocationMigrationPreconditions(db);
  const requiredColumns = PARTIAL_LEGACY_INVOCATION_REQUIRED_COLUMNS;

  const optionalColumns = ["started_at", "heartbeat_at", "finished_at"].filter(
    (column) => columnExists(db, "executor_invocations", column),
  );
  const selectedColumns = [...requiredColumns, ...optionalColumns];
  const invocations = db
    .prepare(
      `SELECT ${selectedColumns.join(", ")}
         FROM executor_invocations
        ORDER BY workflow_run_id, step_run_id, created_at, invocation_id`,
    )
    .all() as Array<Record<string, unknown>>;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const executorRenames = renameableLegacyExecutorValues(db, options);
      const canonicalExecutorValue = (value: string): string =>
        executorRenames.get(value) ?? value;
      const existingAttempt = db.prepare(
        `SELECT attempt_id, legacy_invocation_id
           FROM executor_attempts
          WHERE attempt_id = ?`,
      );
      // Column order matches the `insertAttempt.run(...)` argument order
      // below; the preflight requires each of these on a pre-existing table.
      const insertAttempt = db.prepare(
        `INSERT INTO executor_attempts (
           ${PARTIAL_LEGACY_INVOCATION_ATTEMPT_COLUMNS.join(", ")}
         ) VALUES (${PARTIAL_LEGACY_INVOCATION_ATTEMPT_COLUMNS.map(() => "?").join(", ")})`,
      );
      const attemptNumbersByStep = new Map<string, Set<number>>();

      for (const invocation of invocations) {
        const invocationId = String(invocation.invocation_id);
        const existing = existingAttempt.get(invocationId) as
          | { attempt_id: string; legacy_invocation_id: string | null }
          | undefined;
        if (existing !== undefined) {
          if (existing.legacy_invocation_id === invocationId) continue;
          throw new Error(
            `partial SDK-05 invocation migration collides with current attempt ${invocationId}`,
          );
        }

        const workflowRunId = String(invocation.workflow_run_id);
        const stepRunId = String(invocation.step_run_id);
        const stepIdentity = JSON.stringify([workflowRunId, stepRunId]);
        const usedAttemptNumbers =
          attemptNumbersByStep.get(stepIdentity) ?? new Set<number>();
        if (!attemptNumbersByStep.has(stepIdentity)) {
          const existingNumbers = db
            .prepare(
              `SELECT attempt_number
                 FROM executor_attempts
                WHERE workflow_run_id = ? AND step_run_id = ?`,
            )
            .all(workflowRunId, stepRunId) as Array<{
            attempt_number: number;
          }>;
          for (const row of existingNumbers) {
            usedAttemptNumbers.add(row.attempt_number);
          }
          attemptNumbersByStep.set(stepIdentity, usedAttemptNumbers);
        }

        const originalAttemptNumber = Math.max(1, Number(invocation.attempt));
        let attemptNumber = originalAttemptNumber;
        while (usedAttemptNumbers.has(attemptNumber)) attemptNumber += 1;
        usedAttemptNumbers.add(attemptNumber);

        const provenance: Record<string, unknown> = {
          legacyInvocationId: invocationId,
          source: "reconstructed_without_round_evidence",
        };
        if (attemptNumber !== originalAttemptNumber) {
          provenance.legacyAttemptNumber = originalAttemptNumber;
        }

        const nullableNumber = (column: string): number | null => {
          const value = invocation[column];
          return value === undefined || value === null ? null : Number(value);
        };
        insertAttempt.run(
          invocationId,
          workflowRunId,
          stepRunId,
          String(invocation.step_key),
          canonicalExecutorValue(String(invocation.executor_family)),
          String(invocation.state),
          attemptNumber,
          nullableNumber("started_at"),
          nullableNumber("heartbeat_at"),
          nullableNumber("finished_at"),
          invocationId,
          JSON.stringify(provenance),
          Number(invocation.created_at),
          Number(invocation.updated_at),
        );
      }

      if (
        tableExists(db, "workflow_gates") &&
        columnExists(db, "workflow_gates", "invocation_id")
      ) {
        if (!columnExists(db, "workflow_gates", "attempt_id")) {
          db.exec(
            "ALTER TABLE workflow_gates RENAME COLUMN invocation_id TO attempt_id",
          );
        } else {
          db.exec(
            `UPDATE workflow_gates
                SET attempt_id = COALESCE(attempt_id, invocation_id)
              WHERE invocation_id IS NOT NULL`,
          );
        }
      }

      db.exec("DROP TABLE executor_invocations");
      const violations = db
        .prepare("PRAGMA foreign_key_check(executor_attempts)")
        .all();
      if (violations.length > 0) {
        throw new Error(
          "partial SDK-05 invocation migration produced foreign-key violations; rolling back",
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// Runtime workflow rows renamed by the pre-1.0 vocabulary sweep. Only
// deterministic, unambiguous values are rewritten; digest-anchored surfaces
// (workflow_approvals, workflow_gates.target_scope, step_definitions,
// evidence_records, workflow_steps.step_id, artifact paths) keep their
// recorded spellings.
const WORKFLOW_STEP_KIND_RENAMES: ReadonlyArray<[string, string]> = [
  ["no-mistakes", "validate"],
  ["linear-refresh", "tracker-refresh"],
];

const WORKFLOW_APPROVAL_BOUNDARY_RENAMES: ReadonlyArray<[string, string]> = [
  ["no-mistakes", "validate"],
  ["through-no-mistakes", "through-validate"],
];

// The exact durable markers the legacy no-mistakes mirror persists
// (src/adapters/no-mistakes-orchestrator.ts): the expected external identity
// checkpoint written at mirror start and the corroborated external-state
// checkpoints written per poll. No other writer uses these stages, and both
// carry the external no-mistakes run identity payload, so an attempt whose
// rounds hold one provably mirrored the external no-mistakes tool.
const NO_MISTAKES_MIRROR_CHECKPOINT_STAGES = [
  "expected_external_identity",
  "external_state_mirrored",
] as const;

// Matches `externalIdentityFromCheckpointDetail` in
// src/adapters/no-mistakes-orchestrator.ts: the payload must carry the string
// external no-mistakes run identity fields.
function isNoMistakesExternalIdentityDetail(detail: string | null): boolean {
  if (detail === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const identity = parsed as Record<string, unknown>;
  return (
    typeof identity.externalRunId === "string" &&
    typeof identity.branch === "string" &&
    typeof identity.headSha === "string"
  );
}

function withNoMistakesMigrationProvenance(
  provenance: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = { ...provenance };
  if (
    Object.hasOwn(provenance, "legacyExecutor") &&
    provenance["legacyExecutor"] !== "no-mistakes"
  ) {
    const keyRoot = "legacyExecutorBeforeNam02VocabularyMigration";
    let key = keyRoot;
    let suffix = 2;
    while (Object.hasOwn(merged, key)) {
      key = `${keyRoot}${suffix}`;
      suffix += 1;
    }
    merged[key] = provenance["legacyExecutor"];
  }
  merged["legacyExecutor"] = "no-mistakes";
  return merged;
}

/**
 * Migrate durable rows onto the renamed executor and step-kind vocabulary, in
 * place and idempotently.
 *
 * Runs after `migrateLegacyExecutorInvocationSchema` and the additive pass, so
 * every table exists in its current shape on fresh, upgraded, and
 * already-current data dirs alike. Every step is a no-op when nothing matches:
 *
 *   - Pre-rename data dirs get their columns renamed
 *     (`executor_attempts.executor_family` / `executor_rounds.executor_family`
 *     -> `executor`, `executor_definitions.family` -> `executor`); fresh DDL
 *     already uses the new names.
 *   - `workflow_steps.kind` and `workflow_runs.approval_boundary` move to the
 *     renamed spellings. `workflow_steps.step_id` never changes: event ids and
 *     artifact trees anchor on it.
 *   - When route-state migration is selected, the complete legacy `route_json`
 *     inventory is pre-scanned before any migration mutation, then moved into
 *     the explicit route-state destinations by the adapter-owned migration.
 *     Malformed, unknown, conflicting, ambiguous, or unmappable route state
 *     aborts the transaction instead of leaving a partial route rewrite.
 *   - Renamed built-in executor values are rewritten in `executor_attempts`,
 *     `executor_rounds`, and the `executor_definitions.executor` identity
 *     column, skipped entirely when a registration claims the old spelling as
 *     its own `executor_key` or the daemon config explicitly owns the old name
 *     (a third-party identity keeps its value everywhere, including its own
 *     row).
 *   - A legacy `no-mistakes` executor attempt converts to
 *     `delegate-supervisor` only when it is terminal *and* its rounds hold a
 *     durable no-mistakes mirror checkpoint proving the external tool; the
 *     conversion records `{"legacyExecutor":"no-mistakes"}` in the attempt's
 *     `legacy_provenance`, preserving any conflicting prior value under a
 *     collision-free migration key. Anything short of that proof stays
 *     `no-mistakes` for the classified legacy reader.
 */
function migrateWorkflowVocabulary(
  db: MomentumDb,
  options: QueueMigrationOptions,
  routeStatePlan?: WorkflowRouteStatePlan,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    upgradeWorkflowRunImportMetadataSchemaInTransaction(db);
    if (
      routeStatePlan !== undefined &&
      routeStatePlan.deferredUntilBaseComplete !== true
    ) {
      assertWorkflowRouteStatePlanCurrent(db, routeStatePlan);
    }
    mergeOrRenameExecutorColumn(db, "executor_attempts", "executor_family");
    mergeOrRenameExecutorColumn(db, "executor_rounds", "executor_family");
    mergeOrRenameExecutorColumn(db, "executor_definitions", "family");

    if (columnExists(db, "workflow_steps", "kind")) {
      const updateStepKind = db.prepare(
        "UPDATE workflow_steps SET kind = ? WHERE kind = ?",
      );
      for (const [oldValue, newValue] of WORKFLOW_STEP_KIND_RENAMES) {
        updateStepKind.run(newValue, oldValue);
      }
    }

    if (columnExists(db, "workflow_runs", "approval_boundary")) {
      const updateBoundary = db.prepare(
        "UPDATE workflow_runs SET approval_boundary = ? WHERE approval_boundary = ?",
      );
      for (const [oldValue, newValue] of WORKFLOW_APPROVAL_BOUNDARY_RENAMES) {
        updateBoundary.run(newValue, oldValue);
      }
    }

    // NAM-06 delegate-supervision round-state rename: the long-lived external
    // mirror lane state moves from `mirroring_external_state` to
    // `supervising_delegate`. Only the round-state value changes; the
    // transition graph, classification, and recovery semantics are identical.
    if (columnExists(db, "executor_rounds", "state")) {
      db.prepare(
        "UPDATE executor_rounds SET state = 'supervising_delegate' WHERE state = 'mirroring_external_state'",
      ).run();
    }

    if (
      columnExists(db, "workflow_runs", "id") &&
      columnExists(db, "workflow_runs", "route_json")
    ) {
      const routeRows = db
        .prepare(
          `SELECT id, route_json FROM workflow_runs
            WHERE route_json LIKE '%"no-mistakes"%'
               OR route_json LIKE '%"linear-refresh"%'`,
        )
        .all() as Array<{ id: string; route_json: string }>;
      const updateRoute = db.prepare(
        "UPDATE workflow_runs SET route_json = ? WHERE id = ?",
      );
      for (const row of routeRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.route_json);
        } catch {
          continue;
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          continue;
        }
        const route = parsed as Record<string, unknown>;
        const steps = route.steps;
        if (
          steps === null ||
          typeof steps !== "object" ||
          Array.isArray(steps)
        ) {
          continue;
        }
        const stepOverrides = steps as Record<string, unknown>;
        if (
          !Object.hasOwn(stepOverrides, "no-mistakes") &&
          !Object.hasOwn(stepOverrides, "linear-refresh")
        ) {
          continue;
        }
        const rekeyed = new Map<
          string,
          { value: unknown; canonical: boolean }
        >();
        for (const [key, value] of Object.entries(stepOverrides)) {
          const canonicalKey =
            key === "no-mistakes"
              ? "validate"
              : key === "linear-refresh"
                ? "tracker-refresh"
                : key;
          const canonical = canonicalKey === key;
          const existing = rekeyed.get(canonicalKey);
          if (existing === undefined) {
            rekeyed.set(canonicalKey, { value, canonical });
            continue;
          }
          if (canonical && !existing.canonical) {
            rekeyed.set(canonicalKey, {
              value: mergeRouteOverrideValues(existing.value, value),
              canonical: true,
            });
          }
        }
        updateRoute.run(
          JSON.stringify({
            ...route,
            steps: Object.fromEntries(
              [...rekeyed.entries()].map(([key, entry]) => [key, entry.value]),
            ),
          }),
          row.id,
        );
      }
    }

    for (const [oldValue, newValue] of renameableLegacyExecutorValues(
      db,
      options,
    )) {
      if (columnExists(db, "executor_attempts", "executor")) {
        db.prepare(
          "UPDATE executor_attempts SET executor = ? WHERE executor = ?",
        ).run(newValue, oldValue);
      }
      if (columnExists(db, "executor_rounds", "executor")) {
        db.prepare(
          "UPDATE executor_rounds SET executor = ? WHERE executor = ?",
        ).run(newValue, oldValue);
      }
      if (
        columnExists(db, "executor_definitions", "executor") &&
        columnExists(db, "executor_definitions", "executor_key")
      ) {
        db.prepare(
          `UPDATE executor_definitions SET executor = ?
            WHERE executor = ? AND executor_key <> ?`,
        ).run(newValue, oldValue, oldValue);
      }
    }

    const terminalStates = [...LEGACY_TERMINAL_ATTEMPT_STATES];
    const canClassifyNoMistakes =
      columnExists(db, "executor_attempts", "attempt_id") &&
      columnExists(db, "executor_attempts", "executor") &&
      columnExists(db, "executor_attempts", "state") &&
      columnExists(db, "executor_attempts", "legacy_provenance") &&
      columnExists(db, "executor_rounds", "round_id") &&
      columnExists(db, "executor_rounds", "attempt_id") &&
      columnExists(db, "executor_rounds", "executor") &&
      columnExists(db, "executor_definitions", "executor_key") &&
      columnExists(db, "executor_checkpoints", "round_id") &&
      columnExists(db, "executor_checkpoints", "stage") &&
      columnExists(db, "executor_checkpoints", "detail");
    const candidates =
      !canClassifyNoMistakes ||
      executorIdentityIsClaimed(db, "no-mistakes", options) ||
      executorIdentityIsClaimed(db, "delegate-supervisor", options)
        ? []
        : (db
            .prepare(
              `SELECT attempt_id, legacy_provenance FROM executor_attempts
          WHERE executor = 'no-mistakes'
            AND NOT EXISTS (
              SELECT 1 FROM executor_definitions
               WHERE executor_key = 'no-mistakes'
            )
            AND state IN (${terminalStates.map(() => "?").join(", ")})`,
            )
            .all(...terminalStates) as Array<{
            attempt_id: string;
            legacy_provenance: string | null;
          }>);
    const selectMirrorMarkers = canClassifyNoMistakes
      ? db.prepare(
          `SELECT c.detail
         FROM executor_checkpoints AS c
         JOIN executor_rounds AS r ON r.round_id = c.round_id
        WHERE r.attempt_id = ?
          AND c.stage IN (${NO_MISTAKES_MIRROR_CHECKPOINT_STAGES.map(
            (stage) => `'${stage}'`,
          ).join(", ")})`,
        )
      : undefined;
    const convertAttempt = canClassifyNoMistakes
      ? db.prepare(
          `UPDATE executor_attempts
          SET executor = 'delegate-supervisor', legacy_provenance = ?
        WHERE attempt_id = ?`,
        )
      : undefined;
    const convertRounds = canClassifyNoMistakes
      ? db.prepare(
          `UPDATE executor_rounds SET executor = 'delegate-supervisor'
        WHERE attempt_id = ? AND executor = 'no-mistakes'`,
        )
      : undefined;
    for (const candidate of candidates) {
      const markers = selectMirrorMarkers!.all(candidate.attempt_id) as Array<{
        detail: string | null;
      }>;
      if (
        !markers.some((marker) =>
          isNoMistakesExternalIdentityDetail(marker.detail),
        )
      ) {
        continue;
      }
      let provenance: Record<string, unknown> = {};
      if (candidate.legacy_provenance !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate.legacy_provenance);
        } catch {
          continue;
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          continue;
        }
        provenance = parsed as Record<string, unknown>;
      }
      convertAttempt!.run(
        JSON.stringify(withNoMistakesMigrationProvenance(provenance)),
        candidate.attempt_id,
      );
      convertRounds!.run(candidate.attempt_id);
    }

    if (routeStatePlan?.deferredUntilBaseComplete === true) {
      routeStatePlan = preScanRouteState(db);
    }
    if (routeStatePlan !== undefined && routeStateMigrationNeeded(db)) {
      refreshWorkflowRouteStatePlan(db, routeStatePlan);
      applyWorkflowRouteStateMigrationInTransaction(db, routeStatePlan);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function applyWorkflowVocabularyMigration(
  db: MomentumDb,
  options: QueueMigrationOptions = {},
): void {
  if (!workflowVocabularyMigrationNeeded(db, options)) return;
  migrateWorkflowVocabulary(db, options);
}

/**
 * Avoid taking a write lock for current-schema read-only database opens.
 * Legacy rows still opt into the existing in-place migration, while a current
 * database with no mutable legacy vocabulary can be opened without a
 * `BEGIN IMMEDIATE` side effect.
 */
function workflowVocabularyMigrationNeeded(
  db: MomentumDb,
  options: QueueMigrationOptions,
): boolean {
  if (workflowRunImportMetadataSchemaMigrationNeeded(db)) return true;

  for (const [table, column] of [
    ["executor_attempts", "executor_family"],
    ["executor_rounds", "executor_family"],
    ["executor_definitions", "family"],
  ] as const) {
    if (columnExists(db, table, column)) return true;
  }

  if (
    columnHasValue(db, "workflow_steps", "kind", "no-mistakes") ||
    columnHasValue(db, "workflow_steps", "kind", "linear-refresh") ||
    columnHasValue(db, "workflow_runs", "approval_boundary", "no-mistakes") ||
    columnHasValue(
      db,
      "workflow_runs",
      "approval_boundary",
      "through-no-mistakes",
    )
  ) {
    return true;
  }

  if (
    columnHasSubstring(db, "workflow_runs", "route_json", '"no-mistakes"') ||
    columnHasSubstring(db, "workflow_runs", "route_json", '"linear-refresh"')
  ) {
    return true;
  }

  if (
    columnHasValue(db, "executor_rounds", "state", "mirroring_external_state")
  ) {
    return true;
  }

  for (const oldValue of renameableLegacyExecutorValues(db, options).keys()) {
    if (
      columnHasValue(db, "executor_attempts", "executor", oldValue) ||
      columnHasValue(db, "executor_rounds", "executor", oldValue) ||
      executorDefinitionHasValue(db, oldValue)
    ) {
      return true;
    }
  }

  return hasProvableNoMistakesMigrationCandidate(db, options);
}

function columnHasValue(
  db: MomentumDb,
  table: string,
  column: string,
  value: string,
): boolean {
  if (!columnExists(db, table, column)) return false;
  return (
    db
      .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`)
      .get(value) !== undefined
  );
}

function columnHasSubstring(
  db: MomentumDb,
  table: string,
  column: string,
  value: string,
): boolean {
  if (!columnExists(db, table, column)) return false;
  return (
    db
      .prepare(`SELECT 1 FROM ${table} WHERE ${column} LIKE ? LIMIT 1`)
      .get(`%${value}%`) !== undefined
  );
}

function mergeRouteOverrideValues(
  legacyValue: unknown,
  canonicalValue: unknown,
): unknown {
  if (
    legacyValue !== null &&
    typeof legacyValue === "object" &&
    !Array.isArray(legacyValue) &&
    canonicalValue !== null &&
    typeof canonicalValue === "object" &&
    !Array.isArray(canonicalValue)
  ) {
    return {
      ...(legacyValue as Record<string, unknown>),
      ...(canonicalValue as Record<string, unknown>),
    };
  }
  return canonicalValue;
}

function executorDefinitionHasValue(db: MomentumDb, oldValue: string): boolean {
  if (
    !columnExists(db, "executor_definitions", "executor") ||
    !columnExists(db, "executor_definitions", "executor_key")
  ) {
    return false;
  }
  return (
    db
      .prepare(
        `SELECT 1 FROM executor_definitions
          WHERE executor = ? AND executor_key <> ? LIMIT 1`,
      )
      .get(oldValue, oldValue) !== undefined
  );
}

function hasProvableNoMistakesMigrationCandidate(
  db: MomentumDb,
  options: QueueMigrationOptions,
): boolean {
  if (
    !columnExists(db, "executor_attempts", "attempt_id") ||
    !columnExists(db, "executor_attempts", "executor") ||
    !columnExists(db, "executor_attempts", "state") ||
    !columnExists(db, "executor_attempts", "legacy_provenance") ||
    !columnExists(db, "executor_rounds", "round_id") ||
    !columnExists(db, "executor_rounds", "attempt_id") ||
    !columnExists(db, "executor_rounds", "executor") ||
    !columnExists(db, "executor_checkpoints", "round_id") ||
    !columnExists(db, "executor_checkpoints", "stage") ||
    !columnExists(db, "executor_checkpoints", "detail") ||
    !tableExists(db, "executor_definitions") ||
    executorIdentityIsClaimed(db, "no-mistakes", options) ||
    executorIdentityIsClaimed(db, "delegate-supervisor", options)
  ) {
    return false;
  }

  const terminalStates = [...LEGACY_TERMINAL_ATTEMPT_STATES];
  const candidates = db
    .prepare(
      `SELECT attempt_id FROM executor_attempts
        WHERE executor = 'no-mistakes'
          AND NOT EXISTS (
            SELECT 1 FROM executor_definitions
             WHERE executor_key = 'no-mistakes'
          )
          AND state IN (${terminalStates.map(() => "?").join(", ")})`,
    )
    .all(...terminalStates) as Array<{ attempt_id: string }>;
  const stageList = NO_MISTAKES_MIRROR_CHECKPOINT_STAGES.map(
    (stage) => `'${stage}'`,
  ).join(", ");
  const markers = db.prepare(
    `SELECT c.detail
       FROM executor_checkpoints AS c
       JOIN executor_rounds AS r ON r.round_id = c.round_id
      WHERE r.attempt_id = ?
        AND c.stage IN (${stageList})`,
  );
  return candidates.some((candidate) =>
    (
      markers.all(candidate.attempt_id) as Array<{ detail: string | null }>
    ).some((marker) => isNoMistakesExternalIdentityDetail(marker.detail)),
  );
}

function columnExists(db: MomentumDb, table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as PragmaColumnRow[];
  return rows.some((row) => row.name === column);
}

function mergeOrRenameExecutorColumn(
  db: MomentumDb,
  table: string,
  legacyColumn: string,
): void {
  const hasLegacyColumn = columnExists(db, table, legacyColumn);
  if (!hasLegacyColumn) return;
  if (!columnExists(db, table, "executor")) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${legacyColumn} TO executor`);
    return;
  }

  // Mixed-version schemas already have the canonical column. Preserve its
  // non-empty value and only recover an empty canonical cell from the legacy
  // column; leave the legacy column in place as compatibility provenance.
  db.exec(
    `UPDATE ${table}
        SET executor = ${legacyColumn}
      WHERE (executor IS NULL OR trim(executor) = '')
        AND ${legacyColumn} IS NOT NULL
        AND trim(${legacyColumn}) <> ''`,
  );
}

// The NAM-05 source -> tracker durable rename set. Each entry pairs the legacy
// object with its tracker-named replacement so the rename migration and its
// needed-check stay in lockstep. `workflow_runs.source`, `source_artifact_path`,
// and the evidence-record `source` label are deliberately absent: they are not
// tracker vocabulary.
const TRACKER_TABLE_RENAMES: ReadonlyArray<[string, string]> = [
  ["source_items", "tracker_items"],
  ["source_snapshots", "tracker_snapshots"],
  ["source_reconciliation_runs", "tracker_reconciliation_runs"],
];

const TRACKER_ITEM_COLUMN_RENAMES: ReadonlyArray<[string, string, string]> = [
  ["tracker_snapshots", "source_item_id", "tracker_item_id"],
  ["evidence_records", "source_item_id", "tracker_item_id"],
  ["update_intents", "source_item_id", "tracker_item_id"],
];

// Old-name indexes dropped by the rename; the tracker-named replacements are
// recreated from the fresh DDL inside the same transaction. RENAME TO/RENAME
// COLUMN rewrite index definitions but keep index names, so the names are
// migrated explicitly.
const TRACKER_INDEX_RENAME_DROPS: readonly string[] = [
  "idx_source_items_adapter_external",
  "idx_source_items_goal_id",
  "idx_source_items_adapter_kind",
  "idx_source_snapshots_item_observed",
  "idx_source_reconciliation_runs_adapter_started",
  "idx_evidence_records_source_item",
  "idx_update_intents_source_item",
];

// Recreated per table and guarded by table/column existence: a supported older
// database can carry the source-named tracker tables without evidence_records
// or update_intents yet. Those dependent tables (and these same tracker-item
// indexes, via EVIDENCE_RECORDS_DDL / UPDATE_INTENTS_DDL) are created by the
// later additive DDL pass, so a skipped index here is still created.
const TRACKER_INDEX_RECREATES: ReadonlyArray<[string, string]> = [
  [
    "evidence_records",
    `CREATE INDEX IF NOT EXISTS idx_evidence_records_tracker_item
  ON evidence_records(tracker_item_id) WHERE tracker_item_id IS NOT NULL`,
  ],
  [
    "update_intents",
    `CREATE INDEX IF NOT EXISTS idx_update_intents_tracker_item
  ON update_intents(tracker_item_id) WHERE tracker_item_id IS NOT NULL`,
  ],
];

/**
 * Whether the durable tracker graph still carries pre-rename source-vocabulary
 * schema. Exported so read-only opens route a pre-rename database through the
 * full migration chain.
 */
export function trackerSchemaMigrationNeeded(db: MomentumDb): boolean {
  for (const [legacyTable] of TRACKER_TABLE_RENAMES) {
    if (tableExists(db, legacyTable)) return true;
  }
  for (const [table, legacyColumn] of TRACKER_ITEM_COLUMN_RENAMES) {
    if (tableExists(db, table) && columnExists(db, table, legacyColumn)) {
      return true;
    }
  }
  return false;
}

/**
 * Refuse an ambiguous partially renamed tracker graph without mutating
 * anything: a tracker-named table beside its still-present source-named table
 * (or a table carrying both column spellings) cannot be renamed losslessly
 * and parks the open for operator inspection. A legacy tracker-item column
 * whose declared foreign-key parent table is absent is refused the same way:
 * `RENAME COLUMN` cannot repair the dangling reference, so the renamed column
 * would still point at the missing parent and every later insert would fail.
 * Hoisted into the fail-closed
 * block at the top of `applyQueueMigrations` so the refusal lands before any
 * earlier migration commits and the refused database stays byte-identical to
 * its pre-open state; `migrateTrackerSchemaRename` re-checks as defense.
 */
function assertTrackerSchemaRenameUnambiguous(db: MomentumDb): void {
  for (const [legacyTable, trackerTable] of TRACKER_TABLE_RENAMES) {
    if (tableExists(db, legacyTable) && tableExists(db, trackerTable)) {
      throw new Error(
        `tracker schema migration refused: both ${legacyTable} and ${trackerTable} exist; ` +
          "resolve the ambiguous partial state before reopening this database",
      );
    }
  }
  for (const [
    table,
    legacyColumn,
    trackerColumn,
  ] of TRACKER_ITEM_COLUMN_RENAMES) {
    if (!tableExists(db, table)) continue;
    if (
      columnExists(db, table, legacyColumn) &&
      columnExists(db, table, trackerColumn)
    ) {
      throw new Error(
        `tracker schema migration refused: ${table} carries both ${legacyColumn} and ${trackerColumn}`,
      );
    }
    if (!columnExists(db, table, legacyColumn)) continue;
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all() as Array<{ table: string; from: string }>;
    const legacyFk = foreignKeys.find((fk) => fk.from === legacyColumn);
    if (legacyFk !== undefined && !tableExists(db, legacyFk.table)) {
      throw new Error(
        `tracker schema migration refused: ${table}.${legacyColumn} references missing table ${legacyFk.table}; ` +
          "resolve the dangling foreign-key parent before reopening this database",
      );
    }
  }
}

/**
 * Rename the durable tracker graph from source vocabulary to tracker
 * vocabulary, in place, losslessly, and exactly once.
 *
 * Runs after the legacy executor rebuild (whose tables are disjoint from the
 * tracker graph) so an executor-rebuild failure leaves a pre-rename database
 * untouched and retryable, and before the additive DDL pass so a legacy
 * database is renamed rather than gaining empty tracker-named tables beside
 * populated source-named ones.
 * `ALTER TABLE ... RENAME TO` / `RENAME COLUMN` rewrite the referencing
 * foreign-key clauses in dependent tables (SQLite non-legacy alter semantics),
 * so row bytes, ids, timestamps, links, and uniqueness constraints are
 * untouched; only names change. Old-name indexes are dropped and their
 * tracker-named equivalents recreated in the same transaction.
 *
 * Fails closed without mutating anything when the database is ambiguous; see
 * `assertTrackerSchemaRenameUnambiguous`.
 */
function migrateTrackerSchemaRename(db: MomentumDb): void {
  if (!trackerSchemaMigrationNeeded(db)) return;

  assertTrackerSchemaRenameUnambiguous(db);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [legacyTable, trackerTable] of TRACKER_TABLE_RENAMES) {
      if (!tableExists(db, legacyTable)) continue;
      db.exec(`ALTER TABLE ${legacyTable} RENAME TO ${trackerTable}`);
    }
    for (const [
      table,
      legacyColumn,
      trackerColumn,
    ] of TRACKER_ITEM_COLUMN_RENAMES) {
      if (!tableExists(db, table)) continue;
      if (!columnExists(db, table, legacyColumn)) continue;
      if (columnExists(db, table, trackerColumn)) {
        throw new Error(
          `tracker schema migration refused: ${table} carries both ${legacyColumn} and ${trackerColumn}`,
        );
      }
      db.exec(
        `ALTER TABLE ${table} RENAME COLUMN ${legacyColumn} TO ${trackerColumn}`,
      );
    }
    for (const indexName of TRACKER_INDEX_RENAME_DROPS) {
      db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
    db.exec(TRACKER_ITEMS_DDL);
    for (const [table, indexDdl] of TRACKER_INDEX_RECREATES) {
      if (!tableExists(db, table)) continue;
      if (!columnExists(db, table, "tracker_item_id")) continue;
      db.exec(indexDdl);
    }

    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        "tracker schema migration produced foreign-key violations; rolling back",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// The NAM-06 update-intent -> intent durable rename. Old-name indexes are
// dropped by the rename; the intent-named replacements are recreated from the
// fresh DDL inside the same transaction. RENAME TO rewrites referencing
// foreign-key clauses (intent_apply_audits.intent_id) but keeps index names,
// so the names are migrated explicitly.
const INTENT_TABLE_RENAME: readonly [string, string] = [
  "update_intents",
  "intents",
];

const INTENT_INDEX_RENAME_DROPS: readonly string[] = [
  "idx_update_intents_idempotency_key",
  "idx_update_intents_status",
  "idx_update_intents_goal",
  "idx_update_intents_tracker_item",
  "idx_update_intents_evidence",
  "idx_update_intents_adapter_target",
  "idx_update_intents_created_at",
];

/**
 * Whether the durable intent graph still carries the pre-rename
 * `update_intents` table name. Exported so read-only opens route a pre-rename
 * database through the full migration chain.
 */
export function intentSchemaMigrationNeeded(db: MomentumDb): boolean {
  return tableExists(db, INTENT_TABLE_RENAME[0]);
}

/**
 * Refuse an ambiguous partially renamed intent graph without mutating
 * anything: an `intents` table beside a still-present `update_intents` table
 * cannot be renamed losslessly and parks the open for operator inspection.
 * Hoisted into the fail-closed block at the top of `applyQueueMigrations` so
 * the refusal lands before any earlier migration commits;
 * `migrateIntentSchemaRename` re-checks as defense.
 */
function assertIntentSchemaRenameUnambiguous(db: MomentumDb): void {
  const [legacyTable, intentTable] = INTENT_TABLE_RENAME;
  if (tableExists(db, legacyTable) && tableExists(db, intentTable)) {
    throw new Error(
      `intent schema migration refused: both ${legacyTable} and ${intentTable} exist; ` +
        "resolve the ambiguous partial state before reopening this database",
    );
  }
}

/**
 * Rename the durable intent table from `update_intents` to `intents`, in
 * place, losslessly, and exactly once.
 *
 * Runs after the tracker rename (which renames `update_intents.source_item_id`
 * to `tracker_item_id` while the legacy table name is still in place) and
 * before the additive DDL pass so a legacy database is renamed rather than
 * gaining an empty `intents` table beside a populated `update_intents` one.
 * `ALTER TABLE ... RENAME TO` rewrites the referencing foreign-key clause in
 * `intent_apply_audits` (SQLite non-legacy alter semantics), so row bytes,
 * ids, idempotency keys, decisions, errors, timestamps, and links are
 * untouched; only names change. Old-name indexes are dropped and their
 * intent-named equivalents recreated in the same transaction.
 */
function migrateIntentSchemaRename(db: MomentumDb): void {
  if (!intentSchemaMigrationNeeded(db)) return;

  assertIntentSchemaRenameUnambiguous(db);

  const [legacyTable, intentTable] = INTENT_TABLE_RENAME;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE ${legacyTable} RENAME TO ${intentTable}`);
    for (const indexName of INTENT_INDEX_RENAME_DROPS) {
      db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
    db.exec(INTENTS_DDL);

    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        "intent schema migration produced foreign-key violations; rolling back",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function applyQueueMigrations(
  db: MomentumDb,
  options: QueueMigrationOptions = {},
  validatedRouteStatePlan?: WorkflowRouteStatePlan,
): void {
  const routeStatePlan = validatedRouteStatePlan ?? preScanRouteState(db);
  // Fail closed before any mutation: the final route_json rebuild refuses
  // unexpected workflow_runs columns, so its column contract is checked up
  // front. Otherwise the vocabulary/route-state migration would commit its
  // canonical writes and the later rebuild refusal would leave a mixed state.
  assertWorkflowRunsRebuildColumnContract(db);
  // Fail closed before any mutation, part two: a stale route-state plan must
  // refuse the whole migration chain before the tracker rename commits, so the
  // refused database stays byte-identical to its pre-open state.
  if (
    routeStatePlan.deferredUntilBaseComplete !== true &&
    (trackerSchemaMigrationNeeded(db) || intentSchemaMigrationNeeded(db))
  ) {
    assertWorkflowRouteStatePlanCurrent(db, routeStatePlan);
  }
  // Fail closed before any mutation, part three: an ambiguous partially
  // renamed tracker or intent graph must refuse the whole migration chain up
  // front, so the refused database stays byte-identical to its pre-open state.
  if (trackerSchemaMigrationNeeded(db)) {
    assertTrackerSchemaRenameUnambiguous(db);
  }
  if (intentSchemaMigrationNeeded(db)) {
    assertIntentSchemaRenameUnambiguous(db);
  }
  // Fail closed before any mutation, part four: the partial SDK-05 invocation
  // phase runs after the tracker rename and the additive pass, so its full
  // deterministic refusal set - required columns, current-attempt collisions,
  // and missing foreign-key parents of the rows it would insert - is checked
  // up front when a rename is pending. The state it reads is not changed by
  // the earlier phases: the legacy rebuild only runs when executor_rounds
  // carries invocation_id, in which case the check short-circuits, and no
  // phase before the partial migration inserts parent or attempt rows.
  // Otherwise the late refusal would strand a committed rename beside the
  // unmigrated legacy executor table.
  if (trackerSchemaMigrationNeeded(db) || intentSchemaMigrationNeeded(db)) {
    assertPartialLegacyInvocationMigrationPreconditions(db);
  }
  // Runs before the tracker rename and the main additive pass because it must
  // rebuild tables with foreign keys disabled, which SQLite only allows
  // outside a transaction. Its tables are disjoint from the tracker graph, so
  // running it first means a mid-rebuild failure leaves a pre-rename database
  // untouched and retryable instead of stranding a committed rename.
  migrateLegacyExecutorInvocationSchema(db, options);
  // Runs after the executor legacy rebuild (see above) and before the
  // additive pass so legacy source-named tracker tables are renamed instead
  // of coexisting with freshly created tracker-named tables.
  migrateTrackerSchemaRename(db);
  // Runs after the tracker rename (which retargets the legacy
  // `update_intents.source_item_id` column while the old table name is still
  // in place) and before the additive pass so a legacy database is renamed
  // instead of coexisting with a freshly created `intents` table.
  migrateIntentSchemaRename(db);
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
    db.exec(TRACKER_ITEMS_DDL);
    db.exec(EVIDENCE_RECORDS_DDL);
    if (tableExists(db, "evidence_records")) {
      for (const column of EVIDENCE_RECORD_LINKAGE_COLUMNS) {
        ensureColumn(db, "evidence_records", column);
      }
    }
    db.exec(EVIDENCE_RECORDS_LINKAGE_INDEX_DDL);
    db.exec(INTENTS_DDL);
    if (tableExists(db, "intents")) {
      for (const column of INTENT_M6_COLUMNS) {
        ensureColumn(db, "intents", column);
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
    if (tableExists(db, "step_definitions")) {
      for (const column of STEP_DEFINITION_CONFIG_COLUMNS) {
        ensureColumn(db, "step_definitions", column);
      }
    }
    db.exec(EXECUTOR_LOOP_DDL);
    if (tableExists(db, "executor_rounds")) {
      for (const column of EXECUTOR_ROUND_LEARNING_COLUMNS) {
        ensureColumn(db, "executor_rounds", column);
      }
    }
    if (tableExists(db, "executor_decisions")) {
      for (const column of EXECUTOR_DECISION_EXTERNAL_REF_COLUMNS) {
        ensureColumn(db, "executor_decisions", column);
      }
    }
    db.exec(WORKFLOW_GATES_DDL);
    db.exec(WORKFLOW_EVENTS_DDL);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Runs after the additive pass so every table exists in its current shape
  // before the vocabulary rename inspects and rewrites rows.
  migratePartialLegacyExecutorInvocationSchema(db, options);
  migrateWorkflowVocabulary(db, options, routeStatePlan);
  // Final NAM-03 closeout: once every durable route value lives in its explicit
  // canonical destination, the emptied compatibility column is removed by a
  // transactional table rebuild.
  rebuildWorkflowRunsDropRouteJson(db);
}

/**
 * Whether the durable `workflow_runs` table still carries the retired
 * `route_json` compatibility column. Exported so read-only opens can route a
 * pre-rebuild database through the full migration chain. Intentionally
 * partial historical databases (missing the workflow base tables the
 * route-state migration requires) are excluded: they cannot complete the
 * NAM-03 sequence, so a read-only open must keep serving them unchanged
 * rather than forcing a full migration that their partial schema cannot
 * satisfy.
 */
export function workflowRunsRouteColumnRebuildNeeded(db: MomentumDb): boolean {
  return (
    columnExists(db, "workflow_runs", "route_json") &&
    tableExists(db, "workflow_steps") &&
    tableExists(db, "step_definitions")
  );
}

/**
 * The full current `workflow_runs` column set, in fresh-DDL order. The rebuild
 * fails closed if the live table diverges from this contract (beyond the
 * retired `route_json` column) so an unexpected schema is never silently
 * truncated.
 */
const WORKFLOW_RUNS_REBUILD_COLUMNS = [
  "id",
  "state",
  "goal_id",
  "source",
  "source_artifact_path",
  "plan_json",
  "repo_path",
  "objective",
  "issue_scope_json",
  "approval_boundary",
  "skill_revision",
  "workflow_definition_key",
  "workflow_definition_version",
  "monitor_last_seen_state",
  "monitor_terminal",
  "monitor_step",
  "monitor_last_seen_digest",
  "monitor_last_emitted_digest",
  "monitor_last_seen_at",
  "monitor_last_emitted_at",
  "batch_group",
  "batch_role",
  "needs_manual_recovery",
  "manual_recovery_reason",
  "manual_recovery_at",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at",
] as const;

/**
 * Fail-closed column-contract preflight for the `route_json` rebuild. Columns
 * outside the fresh contract would be silently truncated by the rebuild, so an
 * unknown column refuses the migration. Missing optional columns are
 * legitimate for old partial databases: the rebuild copies the intersection
 * and the fresh DDL's defaults fill the rest (the base-schema contract already
 * guarantees the NOT NULL columns without defaults exist). Called at the top
 * of the migration chain - before any mutation commits - so the refusal leaves
 * the original database unchanged, and again inside the rebuild as defense in
 * depth. No-op once `route_json` is gone, so migrated and partial/historical
 * databases behave exactly as before.
 */
function assertWorkflowRunsRebuildColumnContract(db: MomentumDb): void {
  if (!tableExists(db, "workflow_runs")) return;
  if (!columnExists(db, "workflow_runs", "route_json")) return;
  const liveColumns = (
    db.prepare("PRAGMA table_info(workflow_runs)").all() as PragmaColumnRow[]
  ).map((row) => row.name);
  const expected = new Set<string>(WORKFLOW_RUNS_REBUILD_COLUMNS);
  const unexpected = liveColumns.filter(
    (name) => name !== "route_json" && !expected.has(name),
  );
  if (unexpected.length > 0) {
    throw new RouteStateMigrationError({
      runId: "<schema>",
      jsonPath: "$schema.workflow_runs",
      code: "route_state_schema_partial",
      detail: `workflow_runs rebuild refused: unexpected columns [${unexpected.join(", ")}]`,
    });
  }
}

/**
 * Transactionally rebuild `workflow_runs` without the retired `route_json`
 * column. Runs only after the route-state migration has moved every legacy
 * value to its canonical destination and cleared the column to `'{}'`; a
 * non-empty leftover value, an unexpected column set, a row-count mismatch, or
 * a foreign-key violation rolls the rebuild back and leaves the pre-rebuild
 * database intact. Follows the executor-rebuild precedent: foreign keys are
 * disabled outside the transaction (SQLite requires that), the copy/drop/rename
 * happens inside `BEGIN IMMEDIATE`, and a full `PRAGMA foreign_key_check` must
 * be empty before commit.
 */
function rebuildWorkflowRunsDropRouteJson(db: MomentumDb): void {
  if (!tableExists(db, "workflow_runs")) return;
  if (!columnExists(db, "workflow_runs", "route_json")) return;

  // Defense in depth: the migration chain already asserted this before any
  // mutation, but the rebuild is cheap to re-guard against direct callers.
  assertWorkflowRunsRebuildColumnContract(db);
  const liveColumns = (
    db.prepare("PRAGMA table_info(workflow_runs)").all() as PragmaColumnRow[]
  ).map((row) => row.name);
  const copyColumns = WORKFLOW_RUNS_REBUILD_COLUMNS.filter((name) =>
    liveColumns.includes(name),
  );

  const leftover = db
    .prepare(
      `SELECT id FROM workflow_runs
        WHERE route_json IS NOT NULL AND route_json <> '{}'
        ORDER BY id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (leftover !== undefined) {
    throw new RouteStateMigrationError({
      runId: leftover.id,
      jsonPath: "$.route_json",
      code: "route_state_canonical_conflict",
      detail:
        "workflow_runs rebuild refused: legacy route state was not cleared by the canonical migration",
    });
  }

  const columnList = copyColumns.join(", ");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        WORKFLOW_RUNS_DDL.replace(
          "CREATE TABLE IF NOT EXISTS workflow_runs (",
          "CREATE TABLE workflow_runs_next (",
        )
          // Only the table itself is rebuilt here; its indexes are recreated
          // against the renamed table below.
          .split("CREATE INDEX")[0]!,
      );
      db.exec(
        `INSERT INTO workflow_runs_next (${columnList})
           SELECT ${columnList} FROM workflow_runs`,
      );
      const sourceCount = (
        db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as {
          n: number;
        }
      ).n;
      const copiedCount = (
        db.prepare("SELECT COUNT(*) AS n FROM workflow_runs_next").get() as {
          n: number;
        }
      ).n;
      if (sourceCount !== copiedCount) {
        throw new RouteStateMigrationError({
          runId: "<schema>",
          jsonPath: "$schema.workflow_runs",
          code: "route_state_canonical_conflict",
          detail: `workflow_runs rebuild copied ${copiedCount} of ${sourceCount} rows`,
        });
      }
      db.exec("DROP TABLE workflow_runs");
      db.exec("ALTER TABLE workflow_runs_next RENAME TO workflow_runs");
      db.exec(WORKFLOW_RUNS_DDL);
      db.exec(WORKFLOW_RUNS_IDENTITY_INDEX_DDL);
      const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
      if (fkViolations.length > 0) {
        throw new RouteStateMigrationError({
          runId: "<schema>",
          jsonPath: "$schema.workflow_runs",
          code: "route_state_foreign_key_invalid",
          detail: `workflow_runs rebuild left ${fkViolations.length} foreign-key violations`,
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Not in a transaction; nothing to roll back.
      }
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

type PragmaColumnRow = { name: string };

function ensureColumn(db: MomentumDb, table: string, column: ColumnSpec): void {
  if (columnExists(db, table, column.name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}`);
}

function tableExists(db: MomentumDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
