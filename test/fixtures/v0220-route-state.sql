-- Momentum released route-state fixture
-- tag: v0.22.0
-- commit: ebde7a3fe14ab135375b7cf724f383a838949b1c
-- node: v24.11.1
-- pnpm: 10.33.3
-- reproducible-generation-date: 2026-07-25T17:34:56+10:00
-- body-sha256: 0b7d115ae12f8741955821ffb859dab5109d7213158616e1927b39d98655c3fe
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE daemon_runs (
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
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  job_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE evidence_records (
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
CREATE TABLE executor_artifacts (
  artifact_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  artifact_class TEXT NOT NULL,
  path TEXT NOT NULL,
  digest TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE executor_attempts (
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
CREATE TABLE executor_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE executor_decisions (
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
CREATE TABLE executor_definitions (
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
CREATE TABLE executor_findings (
  finding_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  severity TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  external_ref TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE executor_rounds (
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
CREATE TABLE goals (
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
, current_iteration INTEGER NOT NULL DEFAULT 0, completion_reason TEXT, needs_manual_recovery INTEGER NOT NULL DEFAULT 0, manual_recovery_reason TEXT, manual_recovery_at INTEGER) STRICT;
CREATE TABLE intent_apply_audits (
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
CREATE TABLE jobs (
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
, idempotency_key TEXT, worker_id TEXT, lease_acquired_at INTEGER, lease_expires_at INTEGER, heartbeat_at INTEGER, result_path TEXT, error_path TEXT) STRICT;
CREATE TABLE repo_locks (
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
CREATE TABLE source_items (
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
CREATE TABLE source_reconciliation_runs (
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
CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  adapter_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE step_definitions (
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
CREATE TABLE update_intents (
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
, apply_state TEXT NOT NULL DEFAULT 'idle') STRICT;
CREATE TABLE workflow_approvals (
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
CREATE TABLE workflow_definitions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, version)
) STRICT;
CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT,
  occurred_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE workflow_gates (
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
CREATE TABLE workflow_leases (
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
CREATE TABLE workflow_runs (
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
CREATE TABLE workflow_steps (
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
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'implementation', 'implementation', 'goal-loop', NULL, 1, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'linear-refresh', 'linear-refresh', 'external-apply', NULL, 5, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'merge-cleanup', 'merge-cleanup', 'script', NULL, 4, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'no-mistakes', 'no-mistakes', 'no-mistakes', NULL, 3, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'postflight', 'postflight', 'one-shot', NULL, 2, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'preflight', 'preflight', 'one-shot', NULL, 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'implementation', 'implementation', 'delegate-supervisor', '{"tool":"gnhf"}', 1, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'linear-refresh', 'linear-refresh', 'external-apply', NULL, 5, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'merge-cleanup', 'merge-cleanup', 'script', '{"command":"merge-cleanup"}', 4, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'no-mistakes', 'no-mistakes', 'delegate-supervisor', '{"tool":"no-mistakes"}', 3, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'postflight', 'postflight', 'one-shot', NULL, 2, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'preflight', 'preflight', 'one-shot', NULL, 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'implementation', 'implementation', 'delegate-supervisor', '{"tool":"gnhf"}', 1, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'merge-cleanup', 'merge-cleanup', 'script', '{"command":"merge-cleanup"}', 4, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'postflight', 'postflight', 'agent-once', NULL, 2, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'preflight', 'preflight', 'agent-once', NULL, 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'tracker-refresh', 'tracker-refresh', 'external-apply', NULL, 5, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'validate', 'validate', 'delegate-supervisor', '{"tool":"no-mistakes"}', 3, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('fixture-leaf', 1, 'work', 'implementation', 'script', '{"command":"true"}', 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('fixture-nested', 1, 'nested-child', 'implementation', 'subworkflow', NULL, 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('fixture-parent', 1, 'child-one', 'implementation', 'subworkflow', NULL, 0, 1, 1753430400000, 1753430400000);
INSERT INTO "step_definitions" ("definition_key", "definition_version", "step_key", "kind", "executor", "config_json", "step_order", "required", "created_at", "updated_at") VALUES ('fixture-parent', 1, 'child-two', 'postflight', 'subworkflow', NULL, 1, 1, 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('coding-workflow', 1, 'OpenClaw Coding Workflow', 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('coding-workflow', 2, 'OpenClaw Coding Workflow', 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('coding-workflow', 3, 'OpenClaw Coding Workflow', 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('fixture-leaf', 1, 'Fixture leaf', 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('fixture-nested', 1, 'Fixture nested', 1753430400000, 1753430400000);
INSERT INTO "workflow_definitions" ("key", "version", "title", "created_at", "updated_at") VALUES ('fixture-parent', 1, 'Fixture parent', 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('cwfp-imported', 'pending', NULL, 'agent-workflow', '/fixtures/cwfp-imported', '{"mode":"implementation"}', '/repos/fixture', 'Imported fixture', '{"id":"FIXTURE-2"}', '{"mode":"implementation","profile":"fixture-import","risk":"medium","quotaPolicy":{"maxTurns":12,"overflow":"refuse"}}', NULL, 'fixture', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('empty-route', 'pending', NULL, 'workflow-definition', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{}', NULL, NULL, 'coding-workflow', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('generic-profile', 'pending', NULL, 'workflow-definition', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"profile":"fixture-generic"}', NULL, NULL, 'coding-workflow', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'pending', NULL, 'momentum-native-coding', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"implementationEngine":"current-gnhf-cwfp"}', NULL, NULL, 'coding-workflow', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('native-full', 'pending', NULL, 'momentum-native-coding', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"implementationEngine":"native-goal-loop","profile":"fixture-native","steps":{"implementation":{"harness":"codex","model":"gpt-5.6","effort":"medium"},"postflight":{"harness":"claude","model":"opus","effort":"high"},"validate":{"harness":"codex"},"merge-cleanup":{"model":"cleanup-model"},"tracker-refresh":{"effort":"low"}}}', NULL, NULL, 'coding-workflow', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('native-simple', 'pending', NULL, 'momentum-native-coding', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"implementationEngine":"gnhf"}', NULL, NULL, 'coding-workflow', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('subworkflow-child', 'pending', NULL, 'workflow-definition', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"subworkflow":{"lineage":{"parentRunId":"subworkflow-parent","parentStepId":"child-one","depth":1,"ancestorDefinitionKeys":["fixture-parent"]}}}', NULL, NULL, 'fixture-nested', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('subworkflow-grandchild', 'pending', NULL, 'workflow-definition', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"subworkflow":{"lineage":{"parentRunId":"subworkflow-child","parentStepId":"nested-child","depth":2,"ancestorDefinitionKeys":["fixture-parent","fixture-nested"]}}}', NULL, NULL, 'fixture-leaf', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('subworkflow-parent', 'pending', NULL, 'workflow-definition', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"subworkflow":{"child":{"childDefinitionKey":"fixture-nested","childDefinitionVersion":1,"maxDepth":3}}}', NULL, NULL, 'fixture-parent', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_runs" ("id", "state", "goal_id", "source", "source_artifact_path", "plan_json", "repo_path", "objective", "issue_scope_json", "route_json", "approval_boundary", "skill_revision", "workflow_definition_key", "workflow_definition_version", "monitor_last_seen_state", "monitor_terminal", "monitor_step", "monitor_last_seen_digest", "monitor_last_emitted_digest", "monitor_last_seen_at", "monitor_last_emitted_at", "batch_group", "batch_role", "needs_manual_recovery", "manual_recovery_reason", "manual_recovery_at", "started_at", "finished_at", "created_at", "updated_at") VALUES ('v1-aliases', 'pending', NULL, 'momentum-native-coding', NULL, '{}', '/repos/fixture', 'Released v0.22.0 route fixture', '{"id":"FIXTURE-1"}', '{"steps":{"validate":{"harness":"codex","model":"gpt-5.6"},"tracker-refresh":{"effort":"medium"}}}', NULL, NULL, 'coding-workflow', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('cwfp-imported', 'implementation', 'implementation', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'tracker-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('empty-route', 'validate', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'tracker-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('generic-profile', 'validate', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'tracker-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-current-cwfp', 'validate', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'tracker-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-full', 'validate', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'tracker-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('native-simple', 'validate', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('subworkflow-child', 'nested-child', 'implementation', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('subworkflow-grandchild', 'work', 'implementation', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('subworkflow-parent', 'child-one', 'implementation', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('subworkflow-parent', 'child-two', 'postflight', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'implementation', 'implementation', 'pending', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'linear-refresh', 'tracker-refresh', 'pending', 5, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'merge-cleanup', 'merge-cleanup', 'pending', 4, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'no-mistakes', 'validate', 'pending', 3, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'postflight', 'postflight', 'pending', 2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
INSERT INTO "workflow_steps" ("run_id", "step_id", "kind", "state", "step_order", "required", "ledger_offset", "result_digest", "error_code", "error_message", "started_at", "finished_at", "operator_reason", "operator_actor", "operator_evidence_pointer", "operator_ledger_pointer", "operator_transition_at", "created_at", "updated_at") VALUES ('v1-aliases', 'preflight', 'preflight', 'pending', 0, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1753430400000, 1753430400000);
CREATE INDEX idx_daemon_runs_heartbeat_at
  ON daemon_runs(heartbeat_at);
CREATE UNIQUE INDEX idx_daemon_runs_one_active
  ON daemon_runs((state IN ('starting', 'running', 'stop_requested')))
  WHERE state IN ('starting', 'running', 'stop_requested');
CREATE INDEX idx_daemon_runs_started_at
  ON daemon_runs(started_at);
CREATE INDEX idx_daemon_runs_state
  ON daemon_runs(state);
CREATE INDEX idx_evidence_records_goal
  ON evidence_records(goal_id) WHERE goal_id IS NOT NULL;
CREATE UNIQUE INDEX idx_evidence_records_ingest_key
  ON evidence_records(ingest_key);
CREATE INDEX idx_evidence_records_occurred_at
  ON evidence_records(occurred_at);
CREATE INDEX idx_evidence_records_run_step
  ON evidence_records(run_id, step_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_evidence_records_source_item
  ON evidence_records(source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX idx_evidence_records_source_type
  ON evidence_records(source, type);
CREATE INDEX idx_executor_artifacts_round
  ON executor_artifacts(round_id);
CREATE INDEX idx_executor_attempts_legacy_invocation
  ON executor_attempts(legacy_invocation_id)
  WHERE legacy_invocation_id IS NOT NULL;
CREATE INDEX idx_executor_attempts_run
  ON executor_attempts(workflow_run_id);
CREATE INDEX idx_executor_attempts_state
  ON executor_attempts(state);
CREATE INDEX idx_executor_attempts_step
  ON executor_attempts(workflow_run_id, step_run_id);
CREATE UNIQUE INDEX idx_executor_attempts_step_number
  ON executor_attempts(workflow_run_id, step_run_id, attempt_number);
CREATE INDEX idx_executor_checkpoints_round
  ON executor_checkpoints(round_id);
CREATE UNIQUE INDEX idx_executor_checkpoints_round_sequence
  ON executor_checkpoints(round_id, sequence);
CREATE INDEX idx_executor_decisions_round
  ON executor_decisions(round_id);
CREATE INDEX idx_executor_findings_round
  ON executor_findings(round_id);
CREATE INDEX idx_executor_rounds_attempt
  ON executor_rounds(attempt_id);
CREATE UNIQUE INDEX idx_executor_rounds_attempt_index
  ON executor_rounds(attempt_id, round_index);
CREATE INDEX idx_executor_rounds_run
  ON executor_rounds(workflow_run_id);
CREATE INDEX idx_executor_rounds_step
  ON executor_rounds(workflow_run_id, step_run_id);
CREATE UNIQUE INDEX idx_intent_apply_audits_active
  ON intent_apply_audits(intent_id) WHERE lifecycle_state = 'claimed';
CREATE INDEX idx_intent_apply_audits_created_at
  ON intent_apply_audits(created_at);
CREATE INDEX idx_intent_apply_audits_finished_at
  ON intent_apply_audits(finished_at);
CREATE INDEX idx_intent_apply_audits_intent_id
  ON intent_apply_audits(intent_id);
CREATE INDEX idx_intent_apply_audits_lifecycle_state
  ON intent_apply_audits(lifecycle_state);
CREATE UNIQUE INDEX idx_jobs_idempotency_key
  ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_state_type
  ON jobs(state, type);
CREATE UNIQUE INDEX idx_repo_locks_active_root
  ON repo_locks(repo_root) WHERE state = 'active';
CREATE INDEX idx_repo_locks_job_id
  ON repo_locks(job_id);
CREATE UNIQUE INDEX idx_source_items_adapter_external
  ON source_items(adapter_kind, external_id);
CREATE INDEX idx_source_items_adapter_kind
  ON source_items(adapter_kind);
CREATE INDEX idx_source_items_goal_id
  ON source_items(goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX idx_source_reconciliation_runs_adapter_started
  ON source_reconciliation_runs(adapter_kind, started_at);
CREATE INDEX idx_source_snapshots_item_observed
  ON source_snapshots(source_item_id, observed_at);
CREATE INDEX idx_step_definitions_definition
  ON step_definitions(definition_key, definition_version);
CREATE INDEX idx_update_intents_adapter_target
  ON update_intents(adapter_kind, target_external_id);
CREATE INDEX idx_update_intents_created_at
  ON update_intents(created_at);
CREATE INDEX idx_update_intents_evidence
  ON update_intents(evidence_record_id) WHERE evidence_record_id IS NOT NULL;
CREATE INDEX idx_update_intents_goal
  ON update_intents(goal_id) WHERE goal_id IS NOT NULL;
CREATE UNIQUE INDEX idx_update_intents_idempotency_key
  ON update_intents(idempotency_key);
CREATE INDEX idx_update_intents_source_item
  ON update_intents(source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX idx_update_intents_status
  ON update_intents(status);
CREATE INDEX idx_workflow_approvals_run
  ON workflow_approvals(run_id);
CREATE INDEX idx_workflow_events_run_cursor
  ON workflow_events(run_id, occurred_at, event_id);
CREATE INDEX idx_workflow_gates_open
  ON workflow_gates(workflow_run_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_workflow_gates_run
  ON workflow_gates(workflow_run_id);
CREATE INDEX idx_workflow_leases_expires_at
  ON workflow_leases(expires_at);
CREATE INDEX idx_workflow_leases_run
  ON workflow_leases(run_id);
CREATE INDEX idx_workflow_runs_batch_group
  ON workflow_runs(batch_group) WHERE batch_group IS NOT NULL;
CREATE INDEX idx_workflow_runs_goal
  ON workflow_runs(goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX idx_workflow_runs_needs_manual_recovery
  ON workflow_runs(needs_manual_recovery)
  WHERE needs_manual_recovery = 1;
CREATE INDEX idx_workflow_runs_repo_path
  ON workflow_runs(repo_path) WHERE repo_path IS NOT NULL;
CREATE INDEX idx_workflow_runs_state
  ON workflow_runs(state);
CREATE INDEX idx_workflow_steps_run
  ON workflow_steps(run_id);
CREATE INDEX idx_workflow_steps_state
  ON workflow_steps(state);
COMMIT;
PRAGMA foreign_keys = ON;
