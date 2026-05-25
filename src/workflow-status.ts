/**
 * Read-only loaders for `workflow status` and `workflow handoff` (NGX-317).
 *
 * Reads durable substrate rows from `workflow_runs` / `workflow_steps` /
 * `workflow_approvals` / `workflow_leases` and composes them with the pure
 * `deriveWorkflowMonitorState` reducer from `src/workflow-monitor-state.ts`,
 * yielding a normalized monitor view (active step pick, lease freshness,
 * next-action code, recovery taxonomy) suitable for OpenClaw tooling to
 * consume.
 *
 * No SQLite mutation, no external writes. Evidence linkage is best-effort
 * artifact-path matching against `evidence_records.artifact_path`; the durable
 * `evidence_records.run_id` / `step_id` extension stays deferred per
 * internal/contracts/workflow-runs.md.
 */
import type { MomentumDb } from "./db.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorAdvisory,
  type WorkflowMonitorCheckpoint,
  type WorkflowMonitorState
} from "./workflow-monitor-state.js";
import type {
  WorkflowApprovalBoundary,
  WorkflowLeaseKind,
  WorkflowLeaseRecord,
  WorkflowLeaseStalePolicy,
  WorkflowRunState,
  WorkflowStepKind,
  WorkflowStepRecord,
  WorkflowStepState
} from "./workflow-run-reducer.js";

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
  const params: string[] = [];
  let query =
    "SELECT * FROM workflow_runs" +
    (states === null ? "" : ` WHERE state IN (${states.map(() => "?").join(", ")})`);
  if (states !== null) params.push(...states);
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
  const leases = listLeasesByRunId(db, runId).map(toLeaseRowWithTimestamps);
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
  return { run, steps, approvals, leases, monitor, evidence };
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
  // Until the M7 evidence_records run_id / step_id linkage ships, best-effort
  // match on artifact path: ingested artifacts under the run dir resolve to
  // the same prefix as sourceArtifactPath.
  if (!run.sourceArtifactPath) return [];
  const runDir = artifactRunDir(run.sourceArtifactPath);
  if (!runDir) return [];
  const rows = db
    .prepare(
      "SELECT id, source, type, artifact_path, occurred_at, summary FROM evidence_records WHERE artifact_path LIKE ? ORDER BY occurred_at DESC, id ASC"
    )
    .all(`${runDir}%`) as Array<{
    id: string;
    source: string;
    type: string;
    artifact_path: string | null;
    occurred_at: number;
    summary: string;
  }>;
  return rows.map((row) => ({
    evidenceRecordId: row.id,
    source: row.source,
    type: row.type,
    artifactPath: row.artifact_path,
    occurredAt: row.occurred_at,
    summary: row.summary
  }));
}

function artifactRunDir(artifactPath: string): string | null {
  const idx = artifactPath.lastIndexOf("/");
  if (idx <= 0) return null;
  return `${artifactPath.slice(0, idx)}/`;
}

function resolveStateFilter(
  options: LoadWorkflowRunSummariesOptions
): WorkflowRunState[] | null {
  if (options.state !== undefined) return [options.state];
  switch (options.filter) {
    case "active":
      return [...ACTIVE_RUN_STATES];
    case "blocked":
      return ["blocked"];
    case "completed":
      return [...COMPLETED_RUN_STATES];
    case "imported":
      return null;
    case undefined:
      return null;
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

function toLeaseRowWithTimestamps(row: WorkflowLeaseRow): WorkflowLeaseRow {
  return row;
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
  // Until durable monitor advisory persistence ships, the monitor snapshot
  // lives in `.agent-workflows/<runId>/monitor.json` and is not duplicated
  // into SQLite. The CLI surface omits monitor drift comparison here; the
  // import path still surfaces monitor advisories during ingest. Returning
  // null keeps the reducer focused on substrate state.
  void run;
  return null;
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
