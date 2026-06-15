/**
 * Production workflow-lane dispatch decision domain for the workflow-first
 * runtime (M10-09a, NGX-367).
 *
 * This module owns the *pure* half of the production workflow-lane dispatcher:
 * the phase-1 executor-family allowlist and the deterministic decision
 * ({@link planWorkflowStepDispatch}) that routes a claimed workflow step either
 * to a real executor dispatch or to a fail-closed, operator-visible
 * manual-recovery outcome. It follows the same discipline as `workflow-gate.ts`
 * and the executor-loop reducer: no SQLite, no file system, no daemon, no
 * executor invocation. The durable twins resolve the claimed step against
 * `workflow_runs` / `step_definitions`, create the `executor_invocations` /
 * `executor_rounds` start scaffold, open a `workflow_gates` row when the run can
 * carry one, flag manual recovery for the fail-closed outcome when possible,
 * release the dispatch lease where appropriate, and wire the dispatcher into
 * bounded `daemon start`, exactly as
 * `workflow-gate-persist.ts` is the storage twin of `workflow-gate.ts`.
 *
 * Scope decisions pinned here, grounded in the accepted planning contracts
 * (internal/contracts/executor-loop.md "Executor Families" / "Completion
 * Classification", internal/contracts/workflow-first-gap-matrix.md, and
 * internal/contracts/runtime-consolidation-plan.md):
 *
 *   - The phase-1 dispatchable set is exactly the executor families that already
 *     have a landed bounded adapter (`goal-loop` M10-05, `one-shot` / `script`
 *     M10-06, `no-mistakes` M10-07). `external-apply` and `subworkflow` have no
 *     landed daemon-dispatchable adapter this phase — `external-apply` is
 *     operator-mediated external writes and `subworkflow` recurses into another
 *     run — so they fail closed rather than silently no-op or strand a lease.
 *     NGX-434 keeps those branches until RC-3 / RC-4 land replacement adapters.
 *   - Every non-dispatch outcome routes to the contract's
 *     `manual_recovery_required` human gate: "Momentum cannot safely proceed
 *     without operator inspection and recovery." The dispatcher fails *closed*,
 *     producing durable operator-visible state when the claimed run still
 *     exists. If the run row vanished, the effect twin cannot hang a gate from a
 *     missing parent and instead releases the dispatch lease without fabricating
 *     orphaned recovery state.
 *   - The decision is independent of *how* a claimed step resolves to its
 *     executor family. The persistence twin performs the read-only resolution
 *     (run -> definition link -> step definition -> family) and hands the
 *     {@link WorkflowStepDispatchResolution} to this brain, so the resolution
 *     failure taxonomy and the supportability decision share one pure entry
 *     point and one test surface.
 *
 * {@link planWorkflowStepDispatch} is pure and total: it never throws and always
 * returns a {@link WorkflowStepDispatchPlan} discriminated union, mirroring the
 * `{ action: ... }` convention used by the reducers and the gate brain.
 */

import type { WorkflowExecutorFamily } from "./workflow-definition.js";
import type { WorkflowGateType } from "./workflow-gate.js";

/**
 * Executor families the production workflow lane can genuinely dispatch this
 * phase: those with a landed bounded adapter. Anything outside this set fails
 * closed (see the module doc). The order mirrors the adapter landing order.
 */
export const PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES = [
  "goal-loop",
  "one-shot",
  "script",
  "no-mistakes"
] as const;
export type Phase1DispatchableExecutorFamily =
  (typeof PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES)[number];

const PHASE1_DISPATCHABLE_FAMILY_SET: ReadonlySet<WorkflowExecutorFamily> =
  new Set(PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES);

/**
 * Whether the production workflow lane can dispatch `family` this phase. Narrows
 * to {@link Phase1DispatchableExecutorFamily} so a caller that has checked
 * membership carries a compile-time guarantee the family has a landed adapter.
 */
export function isPhase1DispatchableExecutorFamily(
  family: WorkflowExecutorFamily
): family is Phase1DispatchableExecutorFamily {
  return PHASE1_DISPATCHABLE_FAMILY_SET.has(family);
}

/**
 * Why the read-only resolution of a claimed step to its executor family failed.
 * The persistence twin maps each durable-state shortfall to one of these:
 *
 *   - `run_not_found`: the `workflow_runs` row vanished between claim and
 *     dispatch.
 *   - `definition_unlinked`: the run carries no
 *     `(workflow_definition_key, workflow_definition_version)` link, so its steps
 *     cannot be resolved to an executor family (e.g. an M7-imported run).
 *   - `step_definition_not_found`: no `step_definitions` row matches the claimed
 *     step's `(definitionKey, definitionVersion, stepId)` identity.
 *   - `unknown_executor_family`: the step definition's `executor` column is not a
 *     known {@link WorkflowExecutorFamily} (corrupt or legacy state).
 */
export const WORKFLOW_STEP_RESOLUTION_FAILURES = [
  "run_not_found",
  "definition_unlinked",
  "step_definition_not_found",
  "unknown_executor_family"
] as const;
export type WorkflowStepResolutionFailure =
  (typeof WORKFLOW_STEP_RESOLUTION_FAILURES)[number];

/**
 * The resolved facts about a claimed workflow step that the dispatch decision
 * needs: either the step's executor family, or a typed resolution failure (with
 * an optional detail for the operator-facing reason, e.g. the offending raw
 * family string).
 */
export type WorkflowStepDispatchResolution =
  | { ok: true; executorFamily: WorkflowExecutorFamily }
  | { ok: false; failure: WorkflowStepResolutionFailure; detail?: string };

/**
 * Stable fail-closed codes the dispatcher stamps on a durable manual-recovery
 * outcome so daemon-lane telemetry, recovery artifacts, and status / monitor
 * surfaces can recognise the cause. One per resolution failure plus
 * `unsupported_executor_family` for a resolved-but-unsupported family.
 */
export const WORKFLOW_DISPATCH_FAIL_CLOSED_CODES = [
  "workflow_run_not_found",
  "workflow_definition_unlinked",
  "step_definition_not_found",
  "unknown_executor_family",
  "unsupported_executor_family"
] as const;
export type WorkflowDispatchFailClosedCode =
  (typeof WORKFLOW_DISPATCH_FAIL_CLOSED_CODES)[number];

/**
 * The dispatch decision for a claimed workflow step.
 *
 *   - `dispatch`: the step resolved to a phase-1 dispatchable family; the
 *     persistence twin creates the executor invocation / round start scaffold.
 *   - `fail_closed`: the step is unresolvable, under-configured, or resolved to
 *     an unsupported family; the persistence twin records a durable
 *     operator-visible manual-recovery outcome and releases the dispatch lease.
 */
export type WorkflowStepDispatchPlan =
  | { action: "dispatch"; executorFamily: Phase1DispatchableExecutorFamily }
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
      "Claimed workflow run no longer exists; routing the dispatch to manual recovery."
  },
  definition_unlinked: {
    code: "workflow_definition_unlinked",
    reason: () =>
      "Claimed workflow run has no workflow definition link, so its step cannot be resolved to an executor family; routing to manual recovery."
  },
  step_definition_not_found: {
    code: "step_definition_not_found",
    reason: (detail) =>
      `No step definition matches the claimed step${detail ? ` (${detail})` : ""}; routing the dispatch to manual recovery.`
  },
  unknown_executor_family: {
    code: "unknown_executor_family",
    reason: (detail) =>
      `Claimed step resolves to an unknown executor family${detail ? `: ${detail}` : ""}; routing the dispatch to manual recovery.`
  }
};

/**
 * Decide what the production workflow lane should do with a claimed step, given
 * the resolution of that step to its executor family.
 *
 * Pure and total: never throws, always returns a {@link WorkflowStepDispatchPlan}.
 * A resolution failure or an unsupported family always fails *closed* to a
 * durable manual-recovery outcome — the dispatcher never silently no-ops a
 * claimed step.
 */
export function planWorkflowStepDispatch(
  resolution: WorkflowStepDispatchResolution
): WorkflowStepDispatchPlan {
  if (!resolution.ok) {
    const mapped = RESOLUTION_FAILURE_PLANS[resolution.failure];
    return {
      action: "fail_closed",
      code: mapped.code,
      gateType: FAIL_CLOSED_GATE_TYPE,
      reason: mapped.reason(resolution.detail)
    };
  }

  const family = resolution.executorFamily;
  if (isPhase1DispatchableExecutorFamily(family)) {
    return { action: "dispatch", executorFamily: family };
  }

  return {
    action: "fail_closed",
    code: "unsupported_executor_family",
    gateType: FAIL_CLOSED_GATE_TYPE,
    reason: `Executor family '${family}' has no landed daemon-dispatchable adapter this phase; routing the dispatch to manual recovery.`
  };
}
