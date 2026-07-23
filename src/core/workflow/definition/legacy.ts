/**
 * Shared legacy-to-effective projection for retired workflow vocabulary.
 *
 * The pre-1.0 nomenclature sweep renamed the built-in executor values
 * (`goal-loop` -> `agent-loop`, `one-shot` -> `agent-once`) and the built-in
 * step kinds (`no-mistakes` -> `validate`, `linear-refresh` ->
 * `tracker-refresh`). Previously recorded workflow definitions remain
 * byte-for-byte immutable, so validation/preflight, preview/materialization,
 * and dispatch all read retained definitions through this one non-mutating
 * projection instead of rewriting stored rows.
 *
 * Projection rules pinned here:
 *
 *   - A legacy executor alias is applied only when the recorded name does not
 *     resolve to a currently registered executor under its own raw name. A
 *     user-defined executor identity that merely resembles an old built-in
 *     value is never rewritten.
 *   - The legacy `no-mistakes` executor identity is not an alias: it stays a
 *     dispatchable legacy identity (the profile-backed mirror executor) so
 *     recorded runs keep selecting the exact executor they recorded.
 *   - Approval boundaries stored on mutable run rows migrate in place;
 *     `workflow_approvals` rows are frozen approval evidence (their digest
 *     seed embeds the boundary spelling), so duplicate detection consults
 *     {@link legacyApprovalBoundarySynonyms} instead of a rewrite.
 */

import {
  isWorkflowApprovalBoundary,
  WORKFLOW_STEP_KINDS,
  type LegacyWorkflowStepKind,
  type WorkflowApprovalBoundary,
  type WorkflowStepKind,
} from "../run/reducer.js";
import type {
  ExecutorName,
  StepDefinition,
  WorkflowDefinition,
} from "./definition.js";

/** Retired built-in executor values and their canonical replacements. */
export const LEGACY_EXECUTOR_ALIASES: Readonly<Record<string, ExecutorName>> = {
  "goal-loop": "agent-loop",
  "one-shot": "agent-once",
};

/**
 * Retired built-in executor identities that stay dispatchable as-is for
 * recorded definitions instead of aliasing to a canonical value. Converting a
 * legacy `no-mistakes` identity to `delegate-supervisor` is a provenance-gated
 * runtime-row migration concern, never a projection concern.
 */
export const LEGACY_SUPPORTED_EXECUTORS: ReadonlySet<string> = new Set([
  "no-mistakes",
]);

/** Retired step-kind spellings and their canonical replacements. */
export const LEGACY_STEP_KIND_ALIASES: Readonly<
  Record<LegacyWorkflowStepKind, WorkflowStepKind>
> = {
  "no-mistakes": "validate",
  "linear-refresh": "tracker-refresh",
};

/** Retired approval-boundary spellings and their canonical replacements. */
export type LegacyWorkflowApprovalBoundary =
  "no-mistakes" | "through-no-mistakes";

export const LEGACY_APPROVAL_BOUNDARY_ALIASES: Readonly<
  Record<LegacyWorkflowApprovalBoundary, WorkflowApprovalBoundary>
> = {
  "no-mistakes": "validate",
  "through-no-mistakes": "through-validate",
};

const CANONICAL_STEP_KIND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_KINDS,
);

/**
 * Resolve a stored step-kind spelling to its canonical
 * {@link WorkflowStepKind}, accepting retired legacy spellings. Returns
 * `undefined` for values outside both vocabularies.
 */
export function canonicalWorkflowStepKind(
  kind: string,
): WorkflowStepKind | undefined {
  if (CANONICAL_STEP_KIND_SET.has(kind)) return kind as WorkflowStepKind;
  return (LEGACY_STEP_KIND_ALIASES as Record<string, WorkflowStepKind>)[kind];
}

/**
 * Map a recorded executor identity to its canonical spelling for membership
 * checks against canonical-valued gating sets. Unlike
 * {@link effectiveStepExecutor} this never consults a registry: use it only
 * where the value is being classified, not where an executor is selected.
 */
export function canonicalExecutorIdentity(name: ExecutorName): ExecutorName {
  return LEGACY_EXECUTOR_ALIASES[name] ?? name;
}

export function canonicalWorkflowApprovalBoundary(
  boundary: string,
): WorkflowApprovalBoundary | undefined {
  if (isWorkflowApprovalBoundary(boundary)) return boundary;
  return LEGACY_APPROVAL_BOUNDARY_ALIASES[
    boundary as LegacyWorkflowApprovalBoundary
  ];
}

export type EffectiveExecutorOptions = {
  /**
   * When provided, a recorded executor name that is currently registered under
   * its own raw name wins over any legacy alias, so user-defined identities
   * are never redirected.
   */
  isRegistered?: (name: ExecutorName) => boolean;
  /**
   * A durable third-party definition also owns its raw identity when its
   * runtime registration is temporarily unavailable.
   */
  isDurablyClaimed?: (name: ExecutorName) => boolean;
  /**
   * When provided, a legacy alias projects only to a canonical identity that
   * is known to be Momentum's built-in. This keeps a custom registration on a
   * canonical name from accidentally owning frozen legacy rows.
   */
  isCanonicalBuiltIn?: (name: ExecutorName) => boolean;
};

/**
 * Project a recorded step executor identity to its effective identity.
 */
export function effectiveStepExecutor(
  name: ExecutorName,
  options: EffectiveExecutorOptions = {},
): ExecutorName {
  if (options.isRegistered?.(name) || options.isDurablyClaimed?.(name)) {
    return name;
  }
  const alias = LEGACY_EXECUTOR_ALIASES[name];
  if (
    alias !== undefined &&
    options.isCanonicalBuiltIn !== undefined &&
    !options.isCanonicalBuiltIn(alias)
  ) {
    return name;
  }
  return alias ?? name;
}

/**
 * Project one recorded {@link StepDefinition} to its effective shape. Returns
 * the input object unchanged when no legacy vocabulary is present.
 */
export function effectiveStepDefinition(
  step: StepDefinition,
  options: EffectiveExecutorOptions = {},
): StepDefinition {
  const kind = canonicalWorkflowStepKind(step.kind) ?? step.kind;
  const executor = effectiveStepExecutor(step.executor, options);
  if (kind === step.kind && executor === step.executor) return step;
  return { ...step, kind, executor };
}

/**
 * Project a recorded {@link WorkflowDefinition} to its effective shape without
 * mutating the recorded definition. Returns the input object unchanged when no
 * step carries legacy vocabulary.
 */
export function effectiveWorkflowDefinition(
  definition: WorkflowDefinition,
  options: EffectiveExecutorOptions = {},
): WorkflowDefinition {
  let changed = false;
  const steps = definition.steps.map((step) => {
    const effective = effectiveStepDefinition(step, options);
    if (effective !== step) changed = true;
    return effective;
  });
  if (!changed) return definition;
  return { ...definition, steps };
}

/**
 * Every stored spelling (canonical first, then retired synonyms) that denotes
 * the same approval boundary. Frozen `workflow_approvals` rows keep their
 * recorded spelling, so duplicate checks must match the full synonym set.
 */
export function legacyApprovalBoundarySynonyms(
  boundary: string,
): readonly string[] {
  const canonicalBoundary = canonicalWorkflowApprovalBoundary(boundary);
  const synonyms = [canonicalBoundary ?? boundary];
  if (canonicalBoundary === undefined) return synonyms;
  for (const [legacy, replacement] of Object.entries(
    LEGACY_APPROVAL_BOUNDARY_ALIASES,
  )) {
    if (replacement === canonicalBoundary) synonyms.push(legacy);
  }
  return synonyms;
}
