/**
 * Production child-definition config + recursion-safety decider for the
 * `subworkflow` executor family (RC-4b, NGX-498).
 *
 * RC-4 (NGX-497) landed the daemon-dispatchable `subworkflow` *mechanism* — the
 * pure child-mirror mapping (`dispatch-subworkflow.ts`), the async producer
 * (`dispatch-subworkflow-run.ts`), and the daemon-lane entry-point factory
 * (`subworkflow-dispatch.ts`) — but production stayed fail-closed because the
 * "open decision" was unresolved: *what configures a production `subworkflow`
 * step's child run, and what keeps recursion bounded?* This module owns exactly
 * that keystone decision. It does not itself touch
 * `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES` or wire any daemon lane; RC-4b
 * (NGX-498) flipped `subworkflow` into that allowlist and wired the production
 * lane that composes this decision once the configured lane was proven.
 *
 * Two pure, total halves (no SQLite, no file system, no clock, no network — the
 * same discipline `planSubworkflowChildMirror` and `planWorkflowStepDispatch`
 * follow, so the fail-closed contract is exhaustively testable on its own):
 *
 *   - {@link validateSubworkflowChildConfig} validates the untrusted config a
 *     production `subworkflow` step carries into a resolved
 *     {@link SubworkflowChildDefinitionConfig} (with a concrete, conservative
 *     `maxDepth`), or fails closed with a typed refusal. Absent / malformed
 *     config is the contract's "missing child config" fail-closed case — a
 *     `subworkflow` step with no valid child config must route to manual recovery,
 *     never silently no-op.
 *   - {@link planSubworkflowChildLaunch} decides whether starting that child is
 *     *safe* given the parent run's subworkflow {@link SubworkflowParentLineage}.
 *     A child that is its parent's own definition (self-reference), reappears in
 *     the ancestor chain (cycle), or would nest past `maxDepth` fails closed —
 *     the contract's "unsafe recursion" fail-closed case. This is the bound that
 *     lets the production flip stay safe: a recursive run can never spiral.
 *
 * The daemon-lane deriver (a later RC-4b slice) composes these two with the
 * existing workflow-owned run-start / status seams to build the
 * `DeriveDispatchedSubworkflowContext` the landed entry-point factory injects; a
 * refusal from either half is routed to manual recovery there, exactly as the
 * factory already documents for a refused child-context derivation. Keeping the
 * decision pure here means the wiring slice owns only IO, not policy.
 */

/**
 * The default bounded subworkflow nesting depth when a config omits `maxDepth`.
 *
 * Conservative on purpose: `1` permits exactly one level of subworkflow nesting
 * (a top-level run may start a child run, but that child may not start a
 * grandchild). The production flip's safety posture is "the smallest production
 * flip that proves a configured `subworkflow` step can run" — a deeper bound is
 * an explicit, per-config opt-in, never the default.
 */
export const DEFAULT_SUBWORKFLOW_MAX_DEPTH = 1;

/**
 * The validated config a production `subworkflow` step carries to start its child
 * run. Intentionally minimal for the production flip: the child workflow
 * definition to launch, plus the resolved recursion bound. Richer per-child run
 * configuration (objective shaping, approval boundary inheritance, route
 * derivation) is the daemon-lane deriver's concern, layered on the existing
 * run-start seam — not pinned into this keystone shape.
 */
export type SubworkflowChildDefinitionConfig = {
  /** The workflow definition key the child run launches. */
  childDefinitionKey: string;
  /** The resolved bounded nesting depth (a positive integer). */
  maxDepth: number;
};

/**
 * Why an untrusted `subworkflow` child config failed validation:
 *
 *   - `missing_child_config`: the config is absent or not a plain object — a
 *     `subworkflow` step with no child config to start from.
 *   - `child_definition_key_invalid`: `childDefinitionKey` is missing, not a
 *     string, or blank.
 *   - `max_depth_invalid`: `maxDepth` is present but not a positive integer.
 */
export const SUBWORKFLOW_CHILD_CONFIG_REFUSALS = [
  "missing_child_config",
  "child_definition_key_invalid",
  "max_depth_invalid"
] as const;
export type SubworkflowChildConfigRefusal =
  (typeof SUBWORKFLOW_CHILD_CONFIG_REFUSALS)[number];

export type SubworkflowChildConfigValidation =
  | { ok: true; config: SubworkflowChildDefinitionConfig }
  | { ok: false; refusal: SubworkflowChildConfigRefusal; reason: string };

/**
 * The parent run's subworkflow lineage, the context
 * {@link planSubworkflowChildLaunch} needs to keep recursion bounded:
 *
 *   - `definitionKey`: the parent run's own workflow definition key.
 *   - `ancestorDefinitionKeys`: the definition keys of every subworkflow ancestor
 *     above the parent (root-first), excluding the parent itself. Empty for a
 *     top-level (non-subworkflow-launched) run. The daemon lane derives this from
 *     the durable run lineage when it builds the child-run context.
 */
export type SubworkflowParentLineage = {
  definitionKey: string;
  ancestorDefinitionKeys: readonly string[];
};

/**
 * Why launching the configured child run would be unsafe given the parent's
 * lineage:
 *
 *   - `self_reference`: the child is the parent run's own definition (immediate
 *     infinite nesting).
 *   - `ancestry_cycle`: the child reappears among the parent's ancestors
 *     (A -> B -> A).
 *   - `max_depth_exceeded`: starting the child would nest past `maxDepth`.
 */
export const SUBWORKFLOW_CHILD_LAUNCH_REFUSALS = [
  "self_reference",
  "ancestry_cycle",
  "max_depth_exceeded"
] as const;
export type SubworkflowChildLaunchRefusal =
  (typeof SUBWORKFLOW_CHILD_LAUNCH_REFUSALS)[number];

export type SubworkflowChildLaunchPlan =
  | {
      ok: true;
      childDefinitionKey: string;
      /** The nesting depth the child run will occupy (1 = first nested level). */
      childDepth: number;
      maxDepth: number;
    }
  | { ok: false; refusal: SubworkflowChildLaunchRefusal; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Validate an untrusted `subworkflow` child config. Pure and total: never throws,
 * always returns a {@link SubworkflowChildConfigValidation}. Absent / malformed
 * config fails closed (the "missing child config" contract case) so a
 * `subworkflow` step can never silently dispatch without a child to run.
 */
export function validateSubworkflowChildConfig(
  value: unknown
): SubworkflowChildConfigValidation {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      refusal: "missing_child_config",
      reason:
        "Subworkflow step has no child-definition config; routing to manual recovery."
    };
  }

  const childDefinitionKey = value["childDefinitionKey"];
  if (
    typeof childDefinitionKey !== "string" ||
    childDefinitionKey.trim().length === 0
  ) {
    return {
      ok: false,
      refusal: "child_definition_key_invalid",
      reason:
        "Subworkflow child config childDefinitionKey must be a non-empty string; routing to manual recovery."
    };
  }

  const rawMaxDepth = value["maxDepth"];
  if (rawMaxDepth !== undefined && !isPositiveInteger(rawMaxDepth)) {
    return {
      ok: false,
      refusal: "max_depth_invalid",
      reason:
        "Subworkflow child config maxDepth must be a positive integer; routing to manual recovery."
    };
  }

  return {
    ok: true,
    config: {
      childDefinitionKey: childDefinitionKey.trim(),
      maxDepth: rawMaxDepth ?? DEFAULT_SUBWORKFLOW_MAX_DEPTH
    }
  };
}

/**
 * Decide whether launching the configured child run is safe given the parent
 * run's subworkflow lineage. Pure and total: never throws, always returns a
 * {@link SubworkflowChildLaunchPlan}. Self-reference, an ancestry cycle, or
 * exceeding `maxDepth` all fail closed (the "unsafe recursion" contract case);
 * otherwise the child is launchable at depth `ancestorDefinitionKeys.length + 1`.
 */
export function planSubworkflowChildLaunch(
  config: SubworkflowChildDefinitionConfig,
  parentLineage: SubworkflowParentLineage
): SubworkflowChildLaunchPlan {
  const { childDefinitionKey, maxDepth } = config;

  if (childDefinitionKey === parentLineage.definitionKey) {
    return {
      ok: false,
      refusal: "self_reference",
      reason:
        `Subworkflow child definition '${childDefinitionKey}' is the parent run's own ` +
        "definition (self-reference); routing to manual recovery."
    };
  }

  if (parentLineage.ancestorDefinitionKeys.includes(childDefinitionKey)) {
    return {
      ok: false,
      refusal: "ancestry_cycle",
      reason:
        `Subworkflow child definition '${childDefinitionKey}' already appears in the parent's ` +
        "subworkflow ancestry (recursion cycle); routing to manual recovery."
    };
  }

  // The child occupies one level below the parent: the parent has
  // `ancestorDefinitionKeys.length` subworkflow ancestors, so the child is the
  // next nesting level down.
  const childDepth = parentLineage.ancestorDefinitionKeys.length + 1;
  if (childDepth > maxDepth) {
    return {
      ok: false,
      refusal: "max_depth_exceeded",
      reason:
        `Subworkflow child '${childDefinitionKey}' would nest to depth ${childDepth}, ` +
        `past the configured maxDepth ${maxDepth}; routing to manual recovery.`
    };
  }

  return { ok: true, childDefinitionKey, childDepth, maxDepth };
}
