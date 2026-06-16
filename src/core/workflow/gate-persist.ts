/**
 * Persistence layer for workflow gates and operator decisions (M10-08, NGX-352).
 *
 * Takes the pure gate-decision domain owned by `workflow-gate.ts` — the
 * gate-type / target-scope vocabularies and the {@link evaluateGateDecision}
 * delegated-policy / operator brain — and writes durable gate records into the
 * `workflow_gates` table added by `migrations.ts`. This is the storage twin of
 * the pure brain, exactly as `workflow-definition-persist.ts` is the storage twin
 * of `workflow-definition.ts` and `executor-loop-persist.ts` is the storage twin
 * of the executor-loop reducer: nothing here runs executors, schedules work, or
 * decides policy beyond what the pure brain already encodes. The `workflow run
 * decide` CLI surface layers on top of these primitives.
 *
 * Stable contracts this slice locks in:
 *   - A gate's durable identity is its `gateId`; inserting a duplicate refuses
 *     with {@link WorkflowGateConflictError} and leaves the existing row
 *     untouched — a durable gate row is the proof a pause exists, not an
 *     idempotent re-ingest.
 *   - Persistence is validation-gated: an unknown gate type / target scope, a
 *     blank reason, or a target-scope / id-ancestry mismatch is rejected with
 *     {@link InvalidWorkflowGateError} *before* any row is written, so a durable
 *     gate can never carry a vocabulary string outside the contract or an
 *     incoherent scope anchor. A gate hangs from exactly one layer of the
 *     `workflow -> step -> invocation -> round` tree: the scope's anchor id plus
 *     its ancestry must be present, and any id deeper than the scope must be
 *     null.
 *   - Resolution runs through the same pure {@link evaluateGateDecision} brain
 *     everywhere else uses: an operator may pick any allowed action, a delegated
 *     policy may only auto-apply an action inside the envelope, and an
 *     out-of-envelope delegated action, an unknown action, or a double-resolve is
 *     refused with {@link WorkflowGateDecisionError}. A resolution is written with
 *     a `resolved_at IS NULL` guard so a concurrent resolve can never double-apply
 *     a gate.
 */

import { isUniqueViolation, type MomentumDb } from "../../adapters/db.js";
import {
  WORKFLOW_GATE_SCOPES,
  evaluateGateDecision,
  isWorkflowGateScope,
  isWorkflowGateType,
  type GateDecisionMode,
  type GateDecisionRefusalCode,
  type GateDecisionRequest,
  type WorkflowGateScope,
  type WorkflowGateType
} from "./gate.js";

/** One typed validation problem with a field of a {@link NewWorkflowGate}. */
export type WorkflowGateValidationError = {
  code: string;
  message: string;
};

/**
 * Thrown by {@link insertWorkflowGate} when the supplied gate is not coherent
 * (unknown vocabulary, blank reason, or a scope / id-ancestry mismatch). Carries
 * the full typed error list so callers can surface a complete diagnostic. No rows
 * are written when this is thrown.
 */
export class InvalidWorkflowGateError extends Error {
  readonly errors: readonly WorkflowGateValidationError[];

  constructor(errors: readonly WorkflowGateValidationError[]) {
    super(`Invalid workflow gate: ${errors.map((e) => e.code).join(", ")}`);
    this.name = "InvalidWorkflowGateError";
    this.errors = errors;
  }
}

/** Thrown when inserting a gate whose `gateId` already exists. */
export class WorkflowGateConflictError extends Error {
  readonly gateId: string;

  constructor(gateId: string) {
    super(`Workflow gate already exists: ${gateId}`);
    this.name = "WorkflowGateConflictError";
    this.gateId = gateId;
  }
}

/** Thrown when resolving a gate that does not exist. */
export class WorkflowGateNotFoundError extends Error {
  readonly gateId: string;

  constructor(gateId: string) {
    super(`Workflow gate not found: ${gateId}`);
    this.name = "WorkflowGateNotFoundError";
    this.gateId = gateId;
  }
}

/**
 * Thrown when {@link evaluateGateDecision} refuses a requested resolution. Carries
 * the typed refusal {@link GateDecisionRefusalCode} so callers can branch on the
 * exact reason (e.g. surface a pause-for-operator vs a malformed-request error).
 * The durable gate row is left unchanged.
 */
export class WorkflowGateDecisionError extends Error {
  readonly code: GateDecisionRefusalCode;

  constructor(code: GateDecisionRefusalCode, message: string) {
    super(message);
    this.name = "WorkflowGateDecisionError";
    this.code = code;
  }
}

/**
 * The create shape for an open (unresolved) gate. The resolution fields
 * (`resolvedAt` / `resolvedBy` / ...) are owned by {@link resolveWorkflowGate} and
 * are intentionally absent here so a gate can never be inserted pre-resolved.
 */
export type NewWorkflowGate = {
  gateId: string;
  workflowRunId: string;
  stepRunId?: string | null;
  invocationId?: string | null;
  roundId?: string | null;
  targetScope: WorkflowGateScope;
  gateType: WorkflowGateType;
  reason: string;
  evidence?: string | null;
  allowedActions: readonly string[];
  recommendedAction?: string | null;
  policyEnvelope?: readonly string[];
};

/** A durable gate record loaded from `workflow_gates`. */
export type WorkflowGateRecord = {
  gateId: string;
  workflowRunId: string;
  stepRunId: string | null;
  invocationId: string | null;
  roundId: string | null;
  targetScope: WorkflowGateScope;
  gateType: WorkflowGateType;
  reason: string;
  evidence: string | null;
  allowedActions: string[];
  recommendedAction: string | null;
  policyEnvelope: string[];
  /** `null` while the gate is open; stamped when a decision resolves it. */
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolutionMode: GateDecisionMode | null;
  chosenAction: string | null;
  resolution: string | null;
};

export type InsertWorkflowGateOptions = {
  now?: number;
};

/**
 * Validate and durably insert a new open {@link NewWorkflowGate}.
 *
 * @throws {InvalidWorkflowGateError} if the gate carries an unknown vocabulary,
 * a blank reason, or a scope / id-ancestry mismatch; no row is written.
 * @throws {WorkflowGateConflictError} if `gateId` already exists; the existing row
 * is left untouched.
 */
export function insertWorkflowGate(
  db: MomentumDb,
  gate: NewWorkflowGate,
  options: InsertWorkflowGateOptions = {}
): WorkflowGateRecord {
  const errors = validateNewGate(gate);
  if (errors.length > 0) {
    throw new InvalidWorkflowGateError(errors);
  }
  const now = options.now ?? Date.now();
  const record: WorkflowGateRecord = {
    gateId: gate.gateId,
    workflowRunId: gate.workflowRunId,
    stepRunId: gate.stepRunId ?? null,
    invocationId: gate.invocationId ?? null,
    roundId: gate.roundId ?? null,
    targetScope: gate.targetScope,
    gateType: gate.gateType,
    reason: gate.reason,
    evidence: gate.evidence ?? null,
    allowedActions: [...gate.allowedActions],
    recommendedAction: gate.recommendedAction ?? null,
    policyEnvelope: gate.policyEnvelope ? [...gate.policyEnvelope] : [],
    resolvedAt: null,
    resolvedBy: null,
    resolutionMode: null,
    chosenAction: null,
    resolution: null
  };
  try {
    db.prepare(
      `INSERT INTO workflow_gates (
         gate_id, workflow_run_id, step_run_id, invocation_id, round_id,
         target_scope, gate_type, reason, evidence, allowed_actions,
         recommended_action, policy_envelope, resolved_at, resolved_by,
         resolution_mode, chosen_action, resolution, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.gateId,
      record.workflowRunId,
      record.stepRunId,
      record.invocationId,
      record.roundId,
      record.targetScope,
      record.gateType,
      record.reason,
      record.evidence,
      JSON.stringify(record.allowedActions),
      record.recommendedAction,
      JSON.stringify(record.policyEnvelope),
      record.resolvedAt,
      record.resolvedBy,
      record.resolutionMode,
      record.chosenAction,
      record.resolution,
      now,
      now
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowGateConflictError(gate.gateId);
    }
    throw error;
  }
  return record;
}

/** Load a persisted gate; `undefined` when none matches. */
export function loadWorkflowGate(
  db: MomentumDb,
  gateId: string
): WorkflowGateRecord | undefined {
  const row = db
    .prepare(`${GATE_SELECT} WHERE gate_id = ?`)
    .get(gateId) as WorkflowGateRow | undefined;
  return row === undefined ? undefined : rowToGate(row);
}

/** List every gate for a run, oldest first. */
export function listWorkflowGatesForRun(
  db: MomentumDb,
  workflowRunId: string
): WorkflowGateRecord[] {
  const rows = db
    .prepare(
      `${GATE_SELECT} WHERE workflow_run_id = ? ORDER BY created_at, gate_id`
    )
    .all(workflowRunId) as WorkflowGateRow[];
  return rows.map(rowToGate);
}

/**
 * List a run's unresolved (open) gates, oldest first — the gates still blocking
 * the run, so status / handoff / recovery surfaces can show what an operator must
 * decide.
 */
export function listOpenWorkflowGatesForRun(
  db: MomentumDb,
  workflowRunId: string
): WorkflowGateRecord[] {
  const rows = db
    .prepare(
      `${GATE_SELECT}
         WHERE workflow_run_id = ? AND resolved_at IS NULL
         ORDER BY created_at, gate_id`
    )
    .all(workflowRunId) as WorkflowGateRow[];
  return rows.map(rowToGate);
}

export type ResolveWorkflowGateOptions = {
  now?: number;
};

/**
 * Resolve an open gate by running `request` through the pure
 * {@link evaluateGateDecision} brain and durably stamping the resolution. The
 * `resolved_at IS NULL` write guard makes the resolution race-safe: a concurrent
 * resolve that closed the gate between load and write is refused as
 * `gate_already_resolved` rather than overwriting the prior decision.
 *
 * @throws {WorkflowGateNotFoundError} if no gate has `gateId`.
 * @throws {WorkflowGateDecisionError} if the brain refuses the request (blank
 * action / actor, already resolved, action not allowed, or an out-of-envelope
 * delegated action); the durable row is left unchanged.
 */
export function resolveWorkflowGate(
  db: MomentumDb,
  gateId: string,
  request: GateDecisionRequest,
  options: ResolveWorkflowGateOptions = {}
): WorkflowGateRecord {
  const current = loadWorkflowGate(db, gateId);
  if (current === undefined) {
    throw new WorkflowGateNotFoundError(gateId);
  }
  const outcome = evaluateGateDecision(
    {
      resolved: current.resolvedAt !== null,
      allowedActions: current.allowedActions,
      policyEnvelope: current.policyEnvelope
    },
    request
  );
  if (!outcome.ok) {
    throw new WorkflowGateDecisionError(outcome.code, outcome.message);
  }
  const now = options.now ?? Date.now();
  const { chosenAction, resolvedBy, mode, resolution } = outcome.resolution;
  const updateResult = db
    .prepare(
      `UPDATE workflow_gates
         SET resolved_at = ?, resolved_by = ?, resolution_mode = ?,
             chosen_action = ?, resolution = ?, updated_at = ?
       WHERE gate_id = ? AND resolved_at IS NULL`
    )
    .run(now, resolvedBy, mode, chosenAction, resolution, now, gateId);
  if (Number(updateResult.changes) === 0) {
    // Lost the race: the gate was resolved (or removed) between load and write.
    if (loadWorkflowGate(db, gateId) === undefined) {
      throw new WorkflowGateNotFoundError(gateId);
    }
    throw new WorkflowGateDecisionError(
      "gate_already_resolved",
      "The gate is already resolved; refusing to re-decide it."
    );
  }
  return {
    ...current,
    resolvedAt: now,
    resolvedBy,
    resolutionMode: mode,
    chosenAction,
    resolution
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type WorkflowGateRow = {
  gate_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  invocation_id: string | null;
  round_id: string | null;
  target_scope: string;
  gate_type: string;
  reason: string;
  evidence: string | null;
  allowed_actions: string;
  recommended_action: string | null;
  policy_envelope: string;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_mode: string | null;
  chosen_action: string | null;
  resolution: string | null;
};

const GATE_SELECT = `
  SELECT gate_id, workflow_run_id, step_run_id, invocation_id, round_id,
         target_scope, gate_type, reason, evidence, allowed_actions,
         recommended_action, policy_envelope, resolved_at, resolved_by,
         resolution_mode, chosen_action, resolution
    FROM workflow_gates`;

function rowToGate(row: WorkflowGateRow): WorkflowGateRecord {
  return {
    gateId: row.gate_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    invocationId: row.invocation_id,
    roundId: row.round_id,
    targetScope: row.target_scope as WorkflowGateScope,
    gateType: row.gate_type as WorkflowGateType,
    reason: row.reason,
    evidence: row.evidence,
    allowedActions: parseStringArray(row.allowed_actions),
    recommendedAction: row.recommended_action,
    policyEnvelope: parseStringArray(row.policy_envelope),
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionMode: row.resolution_mode as GateDecisionMode | null,
    chosenAction: row.chosen_action,
    resolution: row.resolution
  };
}

/**
 * The four gate target scopes name a layer of the `workflow -> step ->
 * invocation -> round` tree. A gate must carry the scope's anchor id and every
 * ancestor id, and must not carry an id deeper than the scope.
 */
const GATE_ANCESTRY_LAYERS = [
  "workflow",
  "step",
  "invocation",
  "round"
] as const;

function validateNewGate(
  gate: NewWorkflowGate
): WorkflowGateValidationError[] {
  const errors: WorkflowGateValidationError[] = [];
  if (!isWorkflowGateType(gate.gateType)) {
    errors.push({
      code: "workflow_gate_unknown_type",
      message: `unknown gate type: ${String(gate.gateType)}`
    });
  }
  if (gate.reason.trim().length === 0) {
    errors.push({
      code: "workflow_gate_blank_reason",
      message: "a gate requires a non-blank reason"
    });
  }
  if (!isWorkflowGateScope(gate.targetScope)) {
    errors.push({
      code: "workflow_gate_unknown_scope",
      message: `unknown gate target scope: ${String(gate.targetScope)}`
    });
    // Without a valid scope the ancestry check has no anchor index to apply.
    return errors;
  }
  const scopeIndex = WORKFLOW_GATE_SCOPES.indexOf(gate.targetScope);
  const ids = [
    gate.workflowRunId,
    gate.stepRunId,
    gate.invocationId,
    gate.roundId
  ];
  ids.forEach((id, index) => {
    const present = id !== null && id !== undefined && id !== "";
    if (index <= scopeIndex && !present) {
      errors.push({
        code: "workflow_gate_missing_scope_anchor",
        message: `a ${gate.targetScope}-scoped gate requires the ${GATE_ANCESTRY_LAYERS[index]} id`
      });
    }
    if (index > scopeIndex && present) {
      errors.push({
        code: "workflow_gate_scope_id_overflow",
        message: `a ${gate.targetScope}-scoped gate must not carry a ${GATE_ANCESTRY_LAYERS[index]} id`
      });
    }
  });
  return errors;
}

function parseStringArray(text: string): string[] {
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
}
