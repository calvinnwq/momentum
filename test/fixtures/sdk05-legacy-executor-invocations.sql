-- Frozen SDK-05 pre-migration database snapshot for the attempt/round
-- migration. This file pins the legacy `executor_invocations` schema exactly as
-- it shipped: one deterministic invocation row per dispatched step whose
-- `attempt` column was incremented in place on retry, with rounds from every
-- retry attached to that single row.
--
-- The data deliberately includes the hardest legacy shape: a
-- delegate-supervisor step that ran, reached manual recovery, was reopened in
-- place, and wrote rounds under two attempt numbers on one invocation row --
-- plus round-scoped/invocation-scoped gates, all four evidence classes, a
-- delegate handoff-intent checkpoint carrying the legacy `invocationId`
-- external correlation, and a second invocation row for one step (an
-- adapter-minted mirror invocation) whose attempt number collides with the
-- dispatch scaffold's under the new unique step/attempt-number index.

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  goal_id TEXT,
  source TEXT NOT NULL,
  source_artifact_path TEXT,
  plan_json TEXT NOT NULL DEFAULT '{}',
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
) STRICT;

CREATE TABLE executor_invocations (
  invocation_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor_family TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_run_id, step_run_id)
    REFERENCES workflow_steps(run_id, step_id)
) STRICT;

CREATE INDEX idx_executor_invocations_run
  ON executor_invocations(workflow_run_id);
CREATE INDEX idx_executor_invocations_step
  ON executor_invocations(workflow_run_id, step_run_id);
CREATE INDEX idx_executor_invocations_state
  ON executor_invocations(state);

CREATE TABLE executor_rounds (
  round_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES executor_invocations(invocation_id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  executor_family TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
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

CREATE INDEX idx_executor_rounds_invocation
  ON executor_rounds(invocation_id);
CREATE INDEX idx_executor_rounds_run
  ON executor_rounds(workflow_run_id);
CREATE INDEX idx_executor_rounds_step
  ON executor_rounds(workflow_run_id, step_run_id);
CREATE UNIQUE INDEX idx_executor_rounds_invocation_index
  ON executor_rounds(invocation_id, round_index);

CREATE TABLE executor_artifacts (
  artifact_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  artifact_class TEXT NOT NULL,
  path TEXT NOT NULL,
  digest TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE executor_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES executor_rounds(round_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_executor_checkpoints_round_sequence
  ON executor_checkpoints(round_id, sequence);

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

CREATE TABLE workflow_gates (
  gate_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT,
  invocation_id TEXT,
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

INSERT INTO workflow_runs (id, state, source, plan_json, created_at, updated_at)
VALUES ('run-1', 'running', 'momentum-native-coding-workflow', '{}', 100, 2500);

INSERT INTO workflow_steps
  (run_id, step_id, kind, state, step_order, required, started_at, finished_at, created_at, updated_at)
VALUES
  ('run-1', 'preflight', 'preflight', 'succeeded', 0, 1, 100, 200, 100, 200),
  ('run-1', 'implementation', 'implementation', 'running', 1, 1, 1000, NULL, 100, 2500);

-- The reopened invocation: attempt 1 reached manual recovery, an operator
-- cleared it, and the dispatcher reopened the same row as attempt 2.
INSERT INTO executor_invocations
  (invocation_id, workflow_run_id, step_run_id, step_key, executor_family,
   state, attempt, started_at, heartbeat_at, finished_at, created_at, updated_at)
VALUES
  ('run-1::implementation::dispatch', 'run-1', 'implementation', 'implementation',
   'delegate-supervisor', 'running', 2, 2000, 2500, NULL, 1000, 2500),
  ('run-1::preflight::dispatch', 'run-1', 'preflight', 'preflight',
   'one-shot', 'succeeded', 1, 100, 150, 200, 100, 200),
  ('no-mistakes::run-1::preflight::mirror', 'run-1', 'preflight', 'preflight',
   'no-mistakes', 'succeeded', 1, 300, 350, 400, 300, 400);

INSERT INTO executor_rounds
  (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
   executor_family, attempt, round_index, state, classification,
   executor_recommendation, started_at, heartbeat_at, finished_at,
   agent_provider, model, effort, input_digest, result_digest, artifact_root,
   log_paths, summary, key_changes, key_learnings, remaining_work,
   changed_files, verification_status, verification_results, commit_sha,
   recovery_code, human_gate, created_at, updated_at)
VALUES
  ('run-1::preflight::dispatch::round-1', 'run-1::preflight::dispatch',
   'run-1', 'preflight', 'preflight', 'one-shot', 1, 1, 'succeeded', 'complete',
   'complete', 100, 150, 200, 'claude', 'model-a', 'medium', 'sha256:in-0',
   'sha256:out-0', '/tmp/run-1/preflight', '["/tmp/run-1/preflight/log"]',
   'preflight ok', '[]', '[]', '[]', '[]', 'passed', '[]', NULL, NULL, NULL,
   100, 200),
  ('no-mistakes::run-1::preflight::mirror::round::0',
   'no-mistakes::run-1::preflight::mirror', 'run-1', 'preflight', 'preflight',
   'no-mistakes', 1, 0, 'succeeded', 'complete', 'complete', 300, 350, 400,
   NULL, NULL, NULL, NULL, NULL, NULL, '[]', 'mirror settled', '[]', '[]',
   '[]', '[]', NULL, '[]', NULL, NULL, NULL, 300, 400),
  ('run-1::implementation::dispatch::round-1', 'run-1::implementation::dispatch',
   'run-1', 'implementation', 'implementation', 'delegate-supervisor', 1, 1,
   'succeeded', 'continue', 'continue', 1000, 1100, 1200, 'claude', 'model-a',
   'high', 'sha256:in-1', 'sha256:out-1', '/tmp/run-1/impl',
   '["/tmp/run-1/impl/log-1"]', 'first bounded round',
   '["change-1"]', '["learning-1"]', '["remaining-1"]', '["src/a.ts"]',
   'passed', '[{"command":"pnpm test","exitCode":0,"durationMs":10,"timedOut":false}]',
   NULL, NULL, NULL, 1000, 1200),
  ('run-1::implementation::dispatch::round-2', 'run-1::implementation::dispatch',
   'run-1', 'implementation', 'implementation', 'delegate-supervisor', 1, 2,
   'manual_recovery_required', 'manual_recovery_required', NULL, 1300, 1400,
   1500, 'claude', 'model-a', 'high', 'sha256:in-2', NULL, '/tmp/run-1/impl',
   '["/tmp/run-1/impl/log-2"]', 'executor threw mid-handoff', '[]', '[]',
   '[]', '[]', NULL, '[]', NULL, 'executor_threw', 'manual_recovery_required',
   1300, 1500),
  ('run-1::implementation::dispatch::round-3', 'run-1::implementation::dispatch',
   'run-1', 'implementation', 'implementation', 'delegate-supervisor', 2, 3,
   'running', NULL, NULL, 2000, 2500, NULL, 'claude', 'model-a', 'high',
   'sha256:in-3', NULL, '/tmp/run-1/impl/attempt-2',
   '["/tmp/run-1/impl/attempt-2/log-3"]', NULL, '[]', '[]', '[]', '[]', NULL,
   '[]', NULL, NULL, NULL, 2000, 2500);

INSERT INTO executor_artifacts
  (artifact_id, round_id, artifact_class, path, digest, description, created_at)
VALUES
  ('artifact-1', 'run-1::implementation::dispatch::round-1', 'logs',
   '/tmp/run-1/impl/log-1', 'sha256:log-1', 'round 1 logs', 1050),
  ('artifact-2', 'run-1::implementation::dispatch::round-2', 'recovery_note',
   '/tmp/run-1/impl/recovery-note.md', 'sha256:note', 'recovery note', 1450);

INSERT INTO executor_checkpoints
  (checkpoint_id, round_id, sequence, stage, detail, created_at)
VALUES
  ('checkpoint-1', 'run-1::implementation::dispatch::round-1', 0,
   'round_started', NULL, 1000),
  ('checkpoint-2', 'run-1::implementation::dispatch::round-2', 0,
   'delegate_handoff_intent',
   '{"tool":"gnhf","invocationId":"run-1::implementation::dispatch","attempt":1}',
   1310),
  ('checkpoint-3', 'run-1::implementation::dispatch::round-2', 1,
   'classified', 'classification: manual_recovery_required', 1500),
  ('checkpoint-4', 'run-1::implementation::dispatch::round-3', 0,
   'delegate_handoff_intent',
   '{"tool":"gnhf","invocationId":"run-1::implementation::dispatch","attempt":2}',
   2010);

INSERT INTO executor_findings
  (finding_id, round_id, severity, title, detail, selected, external_ref, created_at)
VALUES
  ('finding-1', 'run-1::implementation::dispatch::round-1', 'minor',
   'review finding', 'found something', 1, 'EXT-9', 1150);

INSERT INTO executor_decisions
  (decision_id, round_id, summary, allowed_actions, recommended_action,
   chosen_action, resolution, external_ref, created_at)
VALUES
  ('decision-1', 'run-1::implementation::dispatch::round-2',
   'retry or abort after executor failure', '["retry","abort"]', 'retry',
   'retry', 'operator chose retry', 'EXT-D-1', 1490);

INSERT INTO workflow_gates
  (gate_id, workflow_run_id, step_run_id, invocation_id, round_id,
   target_scope, gate_type, reason, evidence, allowed_actions,
   recommended_action, policy_envelope, resolved_at, resolved_by,
   resolution_mode, chosen_action, resolution, created_at, updated_at)
VALUES
  ('gate-round', 'run-1', 'implementation', 'run-1::implementation::dispatch',
   'run-1::implementation::dispatch::round-2', 'round',
   'manual_recovery_required', 'executor threw mid-handoff', 'executor_threw',
   '["clear_recovery","abort_run"]', 'clear_recovery', '[]', 1600, 'operator',
   'operator', 'clear_recovery', 'cleared after inspection', 1500, 1600),
  ('gate-invocation', 'run-1', 'implementation',
   'run-1::implementation::dispatch', NULL, 'invocation', 'approval_required',
   'delegate approval pending', NULL, '["approve","reject"]', 'approve', '[]',
   NULL, NULL, NULL, NULL, NULL, 2400, 2400),
  ('gate-step', 'run-1', 'implementation', NULL, NULL, 'step',
   'manual_recovery_required', 'dispatch lease requires operator recovery',
   'manual_recovery_required', '["clear_recovery","abort_run"]',
   'clear_recovery', '[]', 1700, 'operator', 'operator', 'clear_recovery',
   NULL, 1500, 1700);
