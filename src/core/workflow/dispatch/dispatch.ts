/**
 * Production workflow-lane dispatch decision domain for the workflow-first
 * runtime.
 *
 * This module owns the *pure* half of the production workflow-lane dispatcher:
 * the durable executor-identity resolution and the deterministic decision
 * ({@link planWorkflowStepDispatch}) that routes a claimed workflow step either
 * to a real executor dispatch or to a fail-closed, operator-visible
 * manual-recovery outcome. It follows the same discipline as `gate/gate.ts`
 * and the executor-loop reducer: no SQLite, no file system, no daemon, no
 * executor invocation. The durable twins resolve the claimed step against
 * `workflow_runs` / `step_definitions`, create the `executor_attempts` /
 * `executor_rounds` start scaffold, open a `workflow_gates` row when the run can
 * carry one, flag manual recovery for the fail-closed outcome when possible,
 * release the dispatch lease where appropriate, and wire the dispatcher into
 * bounded `daemon start`, exactly as
 * `gate/persist.ts` is the storage twin of `gate/gate.ts`.
 *
 * Scope decisions pinned here, grounded in the compact Runtime Model, Workflow
 * Safety, and Runtime Consolidation anchors in SPEC.md plus the long-form
 * planning contracts externalized to the personal wiki:
 *
 *   - Every syntactically valid executor identity reaches the common dispatch
 *     scaffold. Later registered-executor, built-in, external-apply, and
 *     subworkflow adapters either drive that identity or record honest durable
 *     unavailability instead of silently no-oping or stranding a lease.
 *   - Every non-dispatch outcome routes to the contract's
 *     `manual_recovery_required` human gate: "Momentum cannot safely proceed
 *     without operator inspection and recovery." The dispatcher fails *closed*,
 *     producing durable operator-visible state when the claimed run still
 *     exists. If the run row vanished, the effect twin cannot hang a gate from a
 *     missing parent and instead releases the dispatch lease without fabricating
 *     orphaned recovery state.
 *   - The decision is independent of *how* a claimed step resolves to its
 *     executor identity. The persistence twin performs the read-only resolution
 *     (run -> definition link -> step definition -> identity) and hands the
 *     {@link WorkflowStepDispatchResolution} to this brain, so the resolution
 *     failure taxonomy and the supportability decision share one pure entry
 *     point and one test surface.
 *
 * {@link planWorkflowStepDispatch} is pure and total: it never throws and always
 * returns a {@link WorkflowStepDispatchPlan} discriminated union, mirroring the
 * `{ action: ... }` convention used by the reducers and the gate brain.
 */

import type {
  ExecutorName,
  WorkflowExecutorFamily,
} from "../definition/definition.js";
import type { WorkflowGateType } from "../gate/gate.js";

/**
 * Legacy built-in executor-family set retained for callers that need to narrow a
 * built-in identity to its historical production-adapter type.
 * Arbitrary registered executor identities do not need membership in this set to
 * receive the common dispatch scaffold.
 */
export const PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES = [
  "goal-loop",
  "one-shot",
  "script",
  "no-mistakes",
  "delegate-supervisor",
  "external-apply",
  "subworkflow",
] as const;
export type Phase1DispatchableExecutorFamily =
  (typeof PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES)[number];

const PHASE1_DISPATCHABLE_FAMILY_SET: ReadonlySet<WorkflowExecutorFamily> =
  new Set(PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES);

/**
 * Whether `family` is one of the legacy built-in production-adapter identities.
 * Narrows to {@link Phase1DispatchableExecutorFamily} for callers that need that
 * built-in distinction; it is not the registered-executor dispatch gate.
 */
export function isPhase1DispatchableExecutorFamily(
  family: WorkflowExecutorFamily,
): family is Phase1DispatchableExecutorFamily {
  return PHASE1_DISPATCHABLE_FAMILY_SET.has(family);
}

/**
 * Why the read-only resolution of a claimed step to its executor identity failed.
 * The persistence twin maps each durable-state shortfall to one of these:
 *
 *   - `run_not_found`: the `workflow_runs` row vanished between claim and
 *     dispatch.
 *   - `definition_unlinked`: the run carries no
 *     `(workflow_definition_key, workflow_definition_version)` link, so its steps
 *     cannot be resolved to an executor identity (for example, an imported run).
 *   - `step_definition_not_found`: no `step_definitions` row matches the claimed
 *     step's `(definitionKey, definitionVersion, stepId)` identity.
 *   - `unknown_executor_family`: the step definition's `executor` column is not a
 *     syntactically valid durable executor identity (corrupt or legacy state).
 */
export const WORKFLOW_STEP_RESOLUTION_FAILURES = [
  "run_not_found",
  "definition_unlinked",
  "step_definition_not_found",
  "unknown_executor_family",
] as const;
export type WorkflowStepResolutionFailure =
  (typeof WORKFLOW_STEP_RESOLUTION_FAILURES)[number];

/**
 * The resolved facts about a claimed workflow step that the dispatch decision
 * needs: either the step's executor identity, or a typed resolution failure (with
 * an optional detail for the operator-facing reason, e.g. the offending raw
 * family string).
 */
export type WorkflowStepDispatchResolution =
  | { ok: true; executorFamily: ExecutorName }
  | { ok: false; failure: WorkflowStepResolutionFailure; detail?: string };

/**
 * Stable fail-closed codes the dispatcher stamps on a durable manual-recovery
 * outcome so daemon-lane telemetry, recovery artifacts, and status / monitor
 * surfaces can recognise the cause. One per resolution failure plus
 * the retained `unsupported_executor_family` compatibility code.
 */
export const WORKFLOW_DISPATCH_FAIL_CLOSED_CODES = [
  "workflow_run_not_found",
  "workflow_definition_unlinked",
  "step_definition_not_found",
  "unknown_executor_family",
  "unsupported_executor_family",
  "route_config_invalid",
] as const;
export type WorkflowDispatchFailClosedCode =
  (typeof WORKFLOW_DISPATCH_FAIL_CLOSED_CODES)[number];

/**
 * The dispatch decision for a claimed workflow step.
 *
 *   - `dispatch`: the step resolved to a valid executor identity; the
 *     persistence twin creates the executor invocation / round start scaffold.
 *   - `fail_closed`: the step is unresolvable, under-configured, or resolved to
 *     an invalid identity; the persistence twin records a durable
 *     operator-visible manual-recovery outcome and releases the dispatch lease.
 */
export type WorkflowStepDispatchPlan =
  | { action: "dispatch"; executorFamily: ExecutorName }
  | {
      action: "fail_closed";
      code: WorkflowDispatchFailClosedCode;
      /** Phase 1 routes every fail-closed outcome to `manual_recovery_required`. */
      gateType: WorkflowGateType;
      /** Operator-facing reason; names the offending family / detail when known. */
      reason: string;
    };

/** Phase 1 routes every fail-closed dispatch outcome to this human gate. */
const FAIL_CLOSED_GATE_TYPE: WorkflowGateType = "manual_recovery_required";

const RESOLUTION_FAILURE_PLANS: Record<
  WorkflowStepResolutionFailure,
  { code: WorkflowDispatchFailClosedCode; reason: (detail?: string) => string }
> = {
  run_not_found: {
    code: "workflow_run_not_found",
    reason: () =>
      "Claimed workflow run no longer exists; routing the dispatch to manual recovery.",
  },
  definition_unlinked: {
    code: "workflow_definition_unlinked",
    reason: () =>
      "Claimed workflow run has no workflow definition link, so its step cannot be resolved to an executor family; routing to manual recovery.",
  },
  step_definition_not_found: {
    code: "step_definition_not_found",
    reason: (detail) =>
      `No step definition matches the claimed step${detail ? ` (${detail})` : ""}; routing the dispatch to manual recovery.`,
  },
  unknown_executor_family: {
    code: "unknown_executor_family",
    reason: (detail) =>
      `Claimed step resolves to an unknown executor family${detail ? `: ${detail}` : ""}; routing the dispatch to manual recovery.`,
  },
};

/**
 * Decide what the production workflow lane should do with a claimed step, given
 * the resolution of that step to its executor identity.
 *
 * Pure and total: never throws, always returns a {@link WorkflowStepDispatchPlan}.
 * A resolution failure always fails *closed* to a durable manual-recovery
 * outcome. Every valid identity receives a dispatch scaffold so the selected
 * runtime adapter can execute it or record honest unavailability.
 */
export function planWorkflowStepDispatch(
  resolution: WorkflowStepDispatchResolution,
): WorkflowStepDispatchPlan {
  if (!resolution.ok) {
    const mapped = RESOLUTION_FAILURE_PLANS[resolution.failure];
    return {
      action: "fail_closed",
      code: mapped.code,
      gateType: FAIL_CLOSED_GATE_TYPE,
      reason: mapped.reason(resolution.detail),
    };
  }

  return { action: "dispatch", executorFamily: resolution.executorFamily };
}
