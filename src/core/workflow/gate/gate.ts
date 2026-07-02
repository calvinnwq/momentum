/**
 * Workflow gate decision domain for the workflow-first runtime (M10-08,
 * NGX-352).
 *
 * This module owns the *pure* half of workflow gates and operator decisions: the
 * durable gate-type and target-scope vocabularies plus the delegated-policy /
 * operator decision brain ({@link evaluateGateDecision}). It follows the same
 * discipline as `definition/definition.ts` and the executor-loop reducer: no
 * SQLite, no file system, no daemon. Durable gate persistence and the
 * `workflow run decide` CLI surface layer on top of these primitives, exactly
 * as `definition/persist.ts` is the storage twin of
 * `definition/definition.ts`.
 *
 * Scope decisions pinned here, grounded in the compact Workflow Safety anchor in
 * SPEC.md plus the long-form planning contracts externalized to Obsidian:
 *
 *   - Gate types are the contract's nine durable human-gate classes. They are
 *     re-exported from `src/core/executors/loop/reducer.ts` so a workflow gate and an
 *     executor gate can never drift into two vocabularies — there is one set,
 *     and the contract describes one set.
 *   - A gate's *target scope* (ticket "target scope") names which layer of the
 *     `WorkflowDefinition -> StepRun -> ExecutorInvocation -> ExecutorRound`
 *     tree the gate hangs from. The scope is independent of the decision brain:
 *     resolving a workflow-level approval and resolving a round-level operator
 *     decision run the same evaluation.
 *   - The delegated-policy rule is the contract's "Delegated policy may resolve
 *     a gate only when every requested action is inside the configured envelope.
 *     Otherwise the daemon pauses with the exact action set and evidence." An
 *     explicit operator may pick any allowed action; a delegated policy may only
 *     auto-apply an action inside the gate's policy envelope, and an
 *     out-of-envelope delegated action is refused so the gate pauses for an
 *     operator instead of being silently auto-applied.
 *
 * {@link evaluateGateDecision} is pure and total: it never throws and always
 * returns a {@link GateDecisionOutcome} discriminated union, mirroring the
 * `{ ok: true; ... } | { ok: false; ... }` convention used by the reducers.
 */

import {
  EXECUTOR_HUMAN_GATE_TYPES,
  type ExecutorHumanGateType
} from "../../executors/loop/reducer.js";

/**
 * Durable human-gate types (contract "Human Gates"). Re-exported from the
 * executor-loop reducer so workflow gates and executor gates share one source of
 * truth — the contract pins a single nine-member vocabulary.
 */
export const WORKFLOW_GATE_TYPES = EXECUTOR_HUMAN_GATE_TYPES;
export type WorkflowGateType = ExecutorHumanGateType;

const GATE_TYPE_SET: ReadonlySet<string> = new Set(WORKFLOW_GATE_TYPES);

export function isWorkflowGateType(value: string): value is WorkflowGateType {
  return GATE_TYPE_SET.has(value);
}

/**
 * Gate target scopes (ticket "target scope"). A gate hangs from exactly one
 * layer of the workflow-first tree; the scopes are ordered outermost-first so a
 * `workflow` gate pauses the whole run and a `round` gate pauses one executor
 * round.
 */
export const WORKFLOW_GATE_SCOPES = [
  "workflow",
  "step",
  "invocation",
  "round"
] as const;
export type WorkflowGateScope = (typeof WORKFLOW_GATE_SCOPES)[number];

const GATE_SCOPE_SET: ReadonlySet<string> = new Set(WORKFLOW_GATE_SCOPES);

export function isWorkflowGateScope(value: string): value is WorkflowGateScope {
  return GATE_SCOPE_SET.has(value);
}

/**
 * How a decision is being made:
 *   - `operator`: an explicit human decision. Any action in the gate's
 *     `allowedActions` resolves the gate.
 *   - `delegated`: an automated delegated-policy application. Resolves only when
 *     the action is also inside the gate's `policyEnvelope`; otherwise the gate
 *     pauses for an operator (contract "Delegated policy may resolve a gate only
 *     when every requested action is inside the configured envelope").
 */
export const GATE_DECISION_MODES = ["operator", "delegated"] as const;
export type GateDecisionMode = (typeof GATE_DECISION_MODES)[number];

/**
 * The decision-relevant projection of a durable gate. The brain reads only these
 * fields; the full persisted gate record (ids, timestamps, evidence links) is
 * owned by the M10-08 persistence slice.
 */
export type GateDecisionInput = {
  /** Whether the gate is already settled (double-resolve / idempotency guard). */
  resolved: boolean;
  /** The action set the gate offers (contract gate record `allowed_actions`). */
  allowedActions: readonly string[];
  /**
   * The actions a delegated policy may auto-apply without an operator (contract
   * gate record `policy_envelope`). Treated as a subset of `allowedActions`: an
   * envelope entry that is not also an allowed action can never be applied.
   */
  policyEnvelope: readonly string[];
};

/** A requested decision against a gate. */
export type GateDecisionRequest = {
  /** The action to apply; must be one of the gate's `allowedActions`. */
  action: string;
  /** Who is deciding: an operator name, or the delegated-policy identifier. */
  actor: string;
  /** Whether this is an explicit operator decision or a delegated application. */
  mode: GateDecisionMode;
  /** Optional free-text note recorded with the resolution. */
  resolutionNote?: string | null;
};

/** Why a requested decision was refused. */
export const GATE_DECISION_REFUSAL_CODES = [
  "action_required",
  "actor_required",
  "gate_already_resolved",
  "action_not_allowed",
  "delegated_action_outside_envelope"
] as const;
export type GateDecisionRefusalCode =
  (typeof GATE_DECISION_REFUSAL_CODES)[number];

/** The settled outcome when a decision resolves a gate. */
export type GateDecisionResolution = {
  /** The applied action (a member of the gate's `allowedActions`). */
  chosenAction: string;
  /** Who resolved the gate (the trimmed request actor). */
  resolvedBy: string;
  /** How it was resolved. */
  mode: GateDecisionMode;
  /** The free-text resolution note, or `null` when none was supplied. */
  resolution: string | null;
};

/** Discriminated outcome of {@link evaluateGateDecision}. */
export type GateDecisionOutcome =
  | { ok: true; resolution: GateDecisionResolution }
  | { ok: false; code: GateDecisionRefusalCode; message: string };

/**
 * Evaluate a requested decision against a gate's decision-relevant fields.
 *
 * Pure and total: never throws, always returns a {@link GateDecisionOutcome}.
 * The precedence is request shape (blank action / actor) before gate state
 * (already resolved) before authorization (allowed action, then the delegated
 * envelope), so a malformed request is always refused as a caller bug rather
 * than masquerading as an authorization decision.
 */
export function evaluateGateDecision(
  gate: GateDecisionInput,
  request: GateDecisionRequest
): GateDecisionOutcome {
  const action = request.action.trim();
  if (action.length === 0) {
    return {
      ok: false,
      code: "action_required",
      message: "A gate decision requires a non-blank action."
    };
  }
  const actor = request.actor.trim();
  if (actor.length === 0) {
    return {
      ok: false,
      code: "actor_required",
      message: "A gate decision requires a non-blank actor."
    };
  }
  if (gate.resolved) {
    return {
      ok: false,
      code: "gate_already_resolved",
      message: "The gate is already resolved; refusing to re-decide it."
    };
  }
  if (!gate.allowedActions.includes(action)) {
    return {
      ok: false,
      code: "action_not_allowed",
      message: `Action '${action}' is not allowed by this gate. Allowed actions: ${gate.allowedActions.join(", ") || "(none)"}.`
    };
  }
  if (request.mode === "delegated" && !gate.policyEnvelope.includes(action)) {
    return {
      ok: false,
      code: "delegated_action_outside_envelope",
      message: `Delegated policy cannot auto-apply '${action}'; it is outside the gate's policy envelope (${gate.policyEnvelope.join(", ") || "empty"}). An operator decision is required.`
    };
  }
  return {
    ok: true,
    resolution: {
      chosenAction: action,
      resolvedBy: actor,
      mode: request.mode,
      resolution: request.resolutionNote ?? null
    }
  };
}
