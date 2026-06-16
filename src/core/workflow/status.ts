/**
 * Read-only loaders for `workflow status`, `workflow handoff`, and
 * `workflow run monitor` (NGX-317 / NGX-328).
 *
 * Reads durable substrate rows from `workflow_runs` / `workflow_steps` /
 * `workflow_approvals` / `workflow_leases` and composes them with the pure
 * `deriveWorkflowMonitorState` reducer from `src/core/workflow/monitor-state.ts`,
 * including the durable `workflow_runs` monitor advisory snapshot, yielding a
 * normalized monitor view (active step pick, lease freshness, drift,
 * next-action code, recovery taxonomy) suitable for OpenClaw tooling to
 * consume.
 *
 * No SQLite mutation, no external writes. Evidence linkage prefers the durable
 * typed `evidence_records.run_id` / `step_id` columns (NGX-329); legacy rows
 * with null linkage still fall back to best-effort artifact-path matching
 * against `evidence_records.artifact_path` so pre-NGX-329 evidence keeps
 * surfacing.
 */
import type { MomentumDb } from "../../adapters/db.js";
import {
  listWorkflowGatesForRun,
  type WorkflowGateRecord
} from "./gate-persist.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorAdvisory,
  type WorkflowMonitorCheckpoint,
  type WorkflowMonitorState
} from "./monitor-state.js";
import type {
  WorkflowApprovalBoundary,
  WorkflowLeaseKind,
  WorkflowLeaseRecord,
  WorkflowLeaseStalePolicy,
  WorkflowRunState,
  WorkflowStepKind,
  WorkflowStepRecord,
  WorkflowStepState
} from "./run-reducer.js";

export type WorkflowRunRow = {
  runId: string;
  state: WorkflowRunState;
  source: string;
  sourceArtifactPath: string | null;
  planJson: Record<string, unknown> | null;
  repoPath: string | null;
  objective: string | null;
  issueScope: Record<string, unknown>;
  route: Record<string, unknown>;
  approvalBoundary: WorkflowApprovalBoundary | null;
  skillRevision: string | null;
  monitorLastSeenState: string | null;
  monitorTerminal: boolean | null;
  monitorStep: string | null;
  monitorLastSeenDigest: string | null;
  monitorLastEmittedDigest: string | null;
  goalId: string | null;
  batchGroup: string | null;
  batchRole: string | null;
  needsManualRecovery: boolean;
  manualRecoveryReason: string | null;
  manualRecoveryAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowStepRow = {
  runId: string;
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  order: number;
  required: boolean;
  ledgerOffset: number | null;
  resultDigest: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowApprovalRow = {
  runId: string;
  boundary: WorkflowApprovalBoundary;
  actor: string | null;
  phrase: string;
  artifactPath: string;
  artifactDigest: string;
  recordedAt: number;
  dischargedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowLeaseRow = WorkflowLeaseRecord & {
  createdAt: number;
  updatedAt: number;
};

export type WorkflowEvidenceLink = {
  evidenceRecordId: string;
  source: string;
  type: string;
  artifactPath: string | null;
  occurredAt: number;
  summary: string;
  runId: string | null;
  stepId: string | null;
};

export const WORKFLOW_STATUS_FILTER_KEYS = [
  "active",
  "blocked",
  "completed",
  "imported"
] as const;
export type WorkflowStatusFilterKey =
  (typeof WORKFLOW_STATUS_FILTER_KEYS)[number];

export type LoadWorkflowRunSummariesOptions = {
  filter?: WorkflowStatusFilterKey;
  state?: WorkflowRunState;
  limit?: number;
  approvalBoundary?: string;
  repoPath?: string;
  issueScope?: string;
  updatedSince?: number;
  updatedUntil?: number;
  now?: number;
  graceMs?: number;
  checkpointStaleMs?: number;
};

export type LoadWorkflowRunDetailOptions = {
  now?: number;
  graceMs?: number;
  checkpointStaleMs?: number;
};

export type WorkflowRunSummary = {
  run: WorkflowRunRow;
  counts: {
    steps: number;
    stepsByState: Record<WorkflowStepState, number>;
    approvals: number;
    leases: number;
  };
  monitor: WorkflowMonitorState;
};

export type WorkflowRunDetail = {
  run: WorkflowRunRow;
  steps: WorkflowStepRow[];
  approvals: WorkflowApprovalRow[];
  leases: WorkflowLeaseRow[];
  monitor: WorkflowMonitorState;
  evidence: WorkflowEvidenceLink[];
  /**
   * Durable workflow / step / executor gates for this run (M10-08, NGX-352),
   * oldest first, open and resolved alike. Surfacing them here makes the run's
   * approval-required / operator-decision / manual-recovery pauses explicit and
   * inspectable in `workflow status`, `workflow handoff`, and every other
   * consumer of the shared run-detail loader.
   */
  gates: WorkflowGateRecord[];
};

const STEP_STATE_BUCKETS: readonly WorkflowStepState[] = [
  "pending",
  "approved",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "canceled"
];

const ACTIVE_RUN_STATES: readonly WorkflowRunState[] = [
  "pending",
  "approved",
  "running"
];
const COMPLETED_RUN_STATES: readonly WorkflowRunState[] = [
  "succeeded",
  "failed",
  "canceled"
];

export function listWorkflowRunSummaries(
  db: MomentumDb,
  options: LoadWorkflowRunSummariesOptions = {}
): WorkflowRunSummary[] {
  const states = resolveStateFilter(options);
  if (states !== null && states.length === 0) return [];
  const whereClauses: string[] = [];
  const params: Array<string | number> = [];
  if (states !== null) {
    whereClauses.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  if (options.approvalBoundary !== undefined) {
    whereClauses.push("approval_boundary = ?");
    params.push(options.approvalBoundary);
  }
  if (options.repoPath !== undefined) {
    whereClauses.push("repo_path = ?");
    params.push(options.repoPath);
  }
  if (options.issueScope !== undefined) {
    whereClauses.push("issue_scope_json LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(options.issueScope)}%`);
  }
  if (options.updatedSince !== undefined) {
    whereClauses.push("updated_at >= ?");
    params.push(options.updatedSince);
  }
  if (options.updatedUntil !== undefined) {
    whereClauses.push("updated_at <= ?");
    params.push(options.updatedUntil);
  }
  let query = "SELECT * FROM workflow_runs";
  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(" AND ")}`;
  }
  query += " ORDER BY updated_at DESC, id ASC";
  if (options.limit !== undefined && options.limit >= 0) {
    query += ` LIMIT ${Math.floor(options.limit)}`;
  }
  const runs = (db.prepare(query).all(...params) as RunRow[]).map(parseRunRow);
  if (runs.length === 0) return [];

  const now = options.now ?? Date.now();
  const summaries: WorkflowRunSummary[] = [];
  for (const run of runs) {
    const steps = listStepsByRunId(db, run.runId);
    const leases = listLeasesByRunId(db, run.runId);
    const approvals = listApprovalsByRunId(db, run.runId);
    const monitor = deriveWorkflowMonitorState({
      runId: run.runId,
      steps: toStepRecords(steps),
      leases,
      monitor: monitorAdvisoryFromRun(run),
      lastCheckpoint: lastCheckpointFromSteps(steps),
      now,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.checkpointStaleMs !== undefined
        ? { checkpointStaleMs: options.checkpointStaleMs }
        : {})
    });
    summaries.push({
      run,
      counts: {
        steps: steps.length,
        stepsByState: countStepsByState(steps),
        approvals: approvals.length,
        leases: leases.length
      },
      monitor
    });
  }

  if (options.filter === "imported") {
    return summaries.filter(
      (entry) => entry.run.source === "agent-workflow"
    );
  }
  return summaries;
}

export function loadWorkflowRunDetail(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowRunDetailOptions = {}
): WorkflowRunDetail | null {
  const runRow = db
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(runId) as RunRow | undefined;
  if (!runRow) return null;
  const run = parseRunRow(runRow);
  const steps = listStepsByRunId(db, runId);
  const approvals = listApprovalsByRunId(db, runId);
  const leases = listLeasesByRunId(db, runId);
  const now = options.now ?? Date.now();
  const monitor = deriveWorkflowMonitorState({
    runId,
    steps: toStepRecords(steps),
    leases: leases.map(stripTimestamps),
    monitor: monitorAdvisoryFromRun(run),
    lastCheckpoint: lastCheckpointFromSteps(steps),
    now,
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    ...(options.checkpointStaleMs !== undefined
      ? { checkpointStaleMs: options.checkpointStaleMs }
      : {})
  });
  const evidence = listEvidenceLinksForRun(db, run);
  const gates = listWorkflowGatesForRun(db, runId);
  return { run, steps, approvals, leases, monitor, evidence, gates };
}

function listStepsByRunId(db: MomentumDb, runId: string): WorkflowStepRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_order, step_id"
      )
      .all(runId) as StepRow[]
  ).map(parseStepRow);
}

function listApprovalsByRunId(
  db: MomentumDb,
  runId: string
): WorkflowApprovalRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM workflow_approvals WHERE run_id = ? ORDER BY recorded_at, boundary"
      )
      .all(runId) as ApprovalRow[]
  ).map(parseApprovalRow);
}

function listLeasesByRunId(
  db: MomentumDb,
  runId: string
): WorkflowLeaseRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM workflow_leases WHERE run_id = ? ORDER BY lease_kind"
      )
      .all(runId) as LeaseRow[]
  ).map(parseLeaseRow);
}

function listEvidenceLinksForRun(
  db: MomentumDb,
  run: WorkflowRunRow
): WorkflowEvidenceLink[] {
  // Prefer the durable typed run_id linkage (NGX-329). Legacy rows ingested
  // before the parser populated run_id keep their null linkage, so fall back
  // to best-effort artifact-path matching under the run dir for those rows
  // only when sourceArtifactPath is known.
  const runDir = run.sourceArtifactPath
    ? artifactRunDir(run.sourceArtifactPath)
    : null;
  const rows = (
    runDir
      ? db
          .prepare(
            "SELECT id, source, type, artifact_path, occurred_at, summary, run_id, step_id FROM evidence_records WHERE run_id = ? OR (run_id IS NULL AND artifact_path LIKE ?) ORDER BY occurred_at DESC, id ASC"
          )
          .all(run.runId, `${runDir}%`)
      : db
          .prepare(
            "SELECT id, source, type, artifact_path, occurred_at, summary, run_id, step_id FROM evidence_records WHERE run_id = ? ORDER BY occurred_at DESC, id ASC"
          )
          .all(run.runId)
  ) as Array<{
    id: string;
    source: string;
    type: string;
    artifact_path: string | null;
    occurred_at: number;
    summary: string;
    run_id: string | null;
    step_id: string | null;
  }>;
  return rows.map((row) => ({
    evidenceRecordId: row.id,
    source: row.source,
    type: row.type,
    artifactPath: row.artifact_path,
    occurredAt: row.occurred_at,
    summary: row.summary,
    runId: row.run_id,
    stepId: row.step_id
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function artifactRunDir(artifactPath: string): string | null {
  const idx = artifactPath.lastIndexOf("/");
  if (idx <= 0) return null;
  return `${artifactPath.slice(0, idx)}/`;
}

function resolveStateFilter(
  options: LoadWorkflowRunSummariesOptions
): WorkflowRunState[] | null {
  const stateStates =
    options.state !== undefined ? [options.state] : null;
  const filterStates = filterToStates(options.filter);
  if (stateStates !== null && filterStates !== null) {
    return stateStates.filter((state) => filterStates.includes(state));
  }
  return stateStates ?? filterStates;
}

function filterToStates(
  filter: WorkflowStatusFilterKey | undefined
): WorkflowRunState[] | null {
  switch (filter) {
    case "active":
      return [...ACTIVE_RUN_STATES];
    case "blocked":
      return ["blocked"];
    case "completed":
      return [...COMPLETED_RUN_STATES];
    case "imported":
    case undefined:
    default:
      return null;
  }
}

type RunRow = {
  id: string;
  state: string;
  source: string;
  source_artifact_path: string | null;
  plan_json: string;
  repo_path: string | null;
  objective: string | null;
  issue_scope_json: string;
  route_json: string;
  approval_boundary: string | null;
  skill_revision: string | null;
  monitor_last_seen_state: string | null;
  monitor_terminal: number | null;
  monitor_step: string | null;
  monitor_last_seen_digest: string | null;
  monitor_last_emitted_digest: string | null;
  goal_id: string | null;
  batch_group: string | null;
  batch_role: string | null;
  needs_manual_recovery: number;
  manual_recovery_reason: string | null;
  manual_recovery_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

type StepRow = {
  run_id: string;
  step_id: string;
  kind: string;
  state: string;
  step_order: number;
  required: number;
  ledger_offset: number | null;
  result_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

type ApprovalRow = {
  run_id: string;
  boundary: string;
  actor: string | null;
  phrase: string;
  artifact_path: string;
  artifact_digest: string;
  recorded_at: number;
  discharged_at: number | null;
  created_at: number;
  updated_at: number;
};

type LeaseRow = {
  run_id: string;
  lease_kind: string;
  holder: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
  released_at: number | null;
  stale_policy: string;
  created_at: number;
  updated_at: number;
};

function parseRunRow(row: RunRow): WorkflowRunRow {
  return {
    runId: row.id,
    state: row.state as WorkflowRunState,
    source: row.source,
    sourceArtifactPath: row.source_artifact_path,
    planJson: parseJsonRecord(row.plan_json),
    repoPath: row.repo_path,
    objective: row.objective,
    issueScope: parseJsonRecord(row.issue_scope_json) ?? {},
    route: parseJsonRecord(row.route_json) ?? {},
    approvalBoundary: row.approval_boundary as WorkflowApprovalBoundary | null,
    skillRevision: row.skill_revision,
    monitorLastSeenState: row.monitor_last_seen_state,
    monitorTerminal:
      row.monitor_terminal === null ? null : row.monitor_terminal === 1,
    monitorStep: row.monitor_step,
    monitorLastSeenDigest: row.monitor_last_seen_digest,
    monitorLastEmittedDigest: row.monitor_last_emitted_digest,
    goalId: row.goal_id,
    batchGroup: row.batch_group,
    batchRole: row.batch_role,
    needsManualRecovery: row.needs_manual_recovery === 1,
    manualRecoveryReason: row.manual_recovery_reason,
    manualRecoveryAt: row.manual_recovery_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseStepRow(row: StepRow): WorkflowStepRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind as WorkflowStepKind,
    state: row.state as WorkflowStepState,
    order: row.step_order,
    required: row.required === 1,
    ledgerOffset: row.ledger_offset,
    resultDigest: row.result_digest,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseApprovalRow(row: ApprovalRow): WorkflowApprovalRow {
  return {
    runId: row.run_id,
    boundary: row.boundary as WorkflowApprovalBoundary,
    actor: row.actor,
    phrase: row.phrase,
    artifactPath: row.artifact_path,
    artifactDigest: row.artifact_digest,
    recordedAt: row.recorded_at,
    dischargedAt: row.discharged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseLeaseRow(row: LeaseRow): WorkflowLeaseRow {
  return {
    runId: row.run_id,
    leaseKind: row.lease_kind as WorkflowLeaseKind,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    stalePolicy: row.stale_policy as WorkflowLeaseStalePolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function stripTimestamps(row: WorkflowLeaseRow): WorkflowLeaseRecord {
  return {
    runId: row.runId,
    leaseKind: row.leaseKind,
    holder: row.holder,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    heartbeatAt: row.heartbeatAt,
    releasedAt: row.releasedAt,
    stalePolicy: row.stalePolicy
  };
}

function toStepRecords(rows: WorkflowStepRow[]): WorkflowStepRecord[] {
  return rows.map((row) => ({
    stepId: row.stepId,
    kind: row.kind,
    state: row.state,
    order: row.order,
    required: row.required
  }));
}

function countStepsByState(
  rows: WorkflowStepRow[]
): Record<WorkflowStepState, number> {
  const counts: Record<WorkflowStepState, number> = {
    pending: 0,
    approved: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    canceled: 0
  };
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return counts;
}

function monitorAdvisoryFromRun(run: WorkflowRunRow): WorkflowMonitorAdvisory | null {
  if (
    run.monitorLastSeenState === null &&
    run.monitorTerminal === null &&
    run.monitorStep === null &&
    run.monitorLastSeenDigest === null &&
    run.monitorLastEmittedDigest === null
  ) {
    return null;
  }
  return {
    runState: run.monitorLastSeenState,
    terminal: run.monitorTerminal,
    step: run.monitorStep,
    lastSeenDigest: run.monitorLastSeenDigest,
    lastEmittedDigest: run.monitorLastEmittedDigest
  };
}

function lastCheckpointFromSteps(
  rows: WorkflowStepRow[]
): WorkflowMonitorCheckpoint | null {
  let best: { row: WorkflowStepRow; at: number } | null = null;
  for (const row of rows) {
    const at = row.finishedAt ?? row.startedAt;
    if (at === null) continue;
    if (best === null || at > best.at) {
      best = { row, at };
    }
  }
  if (best === null) return null;
  return {
    stepId: best.row.stepId,
    at: best.at,
    source: "ledger",
    digest: best.row.resultDigest
  };
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function workflowStepBucketKeys(): readonly WorkflowStepState[] {
  return STEP_STATE_BUCKETS;
}
