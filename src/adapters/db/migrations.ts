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
  { name: "error_path", type: "TEXT" },
];

const UPDATE_INTENT_M6_COLUMNS: ColumnSpec[] = [
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
  { name: "route_json", type: "TEXT NOT NULL DEFAULT '{}'" },
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
// lives in config_json; machine-local resolution and run state stay elsewhere.
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
  executor_family TEXT NOT NULL,
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
  executor_family TEXT NOT NULL,
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
  family TEXT NOT NULL,
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

const LEGACY_TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "manual_recovery_required",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

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
function migrateLegacyExecutorInvocationSchema(db: MomentumDb): void {
  if (!tableExists(db, "executor_invocations")) return;
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
           attempt_id, workflow_run_id, step_run_id, step_key, executor_family,
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
              invocation.executor_family,
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
            invocation.executor_family,
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
           executor_family, attempt_number, round_index, state, classification,
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
          round.executor_family as string,
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

function columnExists(db: MomentumDb, table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as PragmaColumnRow[];
  return rows.some((row) => row.name === column);
}

export function applyQueueMigrations(db: MomentumDb): void {
  // Runs before the main additive pass because it must rebuild tables with
  // foreign keys disabled, which SQLite only allows outside a transaction.
  migrateLegacyExecutorInvocationSchema(db);
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
