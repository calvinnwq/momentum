/**
 * Route-encoded child config + durable recursion lineage for production
 * `subworkflow` steps.
 *
 * Iteration 1 (`route/subworkflow-child-config.ts`) landed the two pure deciders —
 * {@link validateSubworkflowChildConfig} and {@link planSubworkflowChildLaunch} —
 * but left two connective decisions to "the wiring slice":
 *
 *   1. *Where* a production `subworkflow` step's child config is sourced from. A
 *      {@link StepDefinition} carries only an executor *family*, never per-step
 *      config (rich per-step config is deliberately out of this module's
 *      scope), so the only in-scope home without a schema change is the run's
 *      existing free-form `route` JSON.
 *   2. *How* the parent run's recursion lineage is encoded durably. There is no
 *      first-class depth / lineage column on `workflow_runs`, so lineage rides in
 *      the same `route` JSON and is propagated one level down each time a parent
 *      launches a child.
 *
 * This module owns exactly those two decisions, purely. Both the authored child
 * config and the propagated lineage live under the single
 * {@link SUBWORKFLOW_ROUTE_KEY} (`route.subworkflow`) namespace:
 *
 *   - `route.subworkflow.child` — the authored child-launch config a top-level
 *     caller sets when starting the parent run (validated by iteration 1's
 *     {@link validateSubworkflowChildConfig});
 *   - `route.subworkflow.lineage` — the recursion lineage the daemon writes onto a
 *     *child* run's route when it launches that child, so the child's own
 *     `subworkflow` steps can detect a cycle / depth bound. Absent for a top-level
 *     run.
 *
 * Discipline (pure + total + fail-closed, mirroring `route/subworkflow-child-config.ts`
 * — no SQLite, no file system, no clock):
 *
 *   - {@link readSubworkflowParentLineage} treats an absent lineage as a legitimate
 *     top-level run, but a *present-but-corrupt* lineage fails closed
 *     (`lineage_invalid`): silently resetting a corrupt deep lineage to depth 0
 *     would defeat the recursion bound the production flip depends on.
 *   - {@link deriveChildSubworkflowRoute} appends the parent's own definition key
 *     onto the ancestry it propagates, so each nesting level sees every key above
 *     it (root-first) and the cycle / depth checks stay sound across levels.
 *   - {@link planSubworkflowChildLaunchFromRoute} composes config validation +
 *     lineage read + the recursion decider into the single decision the IO deriver
 *     (a later slice) forwards into the landed child-runner path, or routes to
 *     manual recovery on any refusal. Keeping it pure here means that wiring slice
 *     owns only IO, not policy.
 */

import {
  planSubworkflowChildLaunch,
  validateSubworkflowChildConfig,
  type SubworkflowChildConfigRefusal,
  type SubworkflowChildLaunchRefusal,
  type SubworkflowParentLineage
} from "./subworkflow-child-config.js";

/** The run-`route` namespace that carries all subworkflow config + lineage. */
export const SUBWORKFLOW_ROUTE_KEY = "subworkflow";

/**
 * The recursion lineage the daemon writes onto a *child* run's
 * `route.subworkflow.lineage` when it launches that child. Absent for a top-level
 * run.
 *
 *   - `parentRunId` / `parentStepId`: the parent run + dispatched step that
 *     launched this child (operator-visible provenance).
 *   - `depth`: this run's nesting depth (1 = first nested level). An audit aid; the
 *     read path derives the effective bound from `ancestorDefinitionKeys` only.
 *   - `ancestorDefinitionKeys`: every subworkflow ancestor's definition key above
 *     this run (root-first, excluding this run itself).
 */
export type SubworkflowRouteLineage = {
  parentRunId: string;
  parentStepId: string;
  depth: number;
  ancestorDefinitionKeys: readonly string[];
};

/**
 * Why reading a present `route.subworkflow.lineage` failed: the namespace carries a
 * lineage that is not a well-formed {@link SubworkflowRouteLineage}. A corrupt
 * lineage is treated as unsafe-recursion state and fails closed, never reset to
 * top-level.
 */
export type SubworkflowLineageRefusal = "lineage_invalid";

export type SubworkflowParentLineageResolution =
  | { ok: true; lineage: SubworkflowParentLineage }
  | { ok: false; refusal: SubworkflowLineageRefusal; reason: string };

/**
 * Every reason a route-sourced child launch can fail closed: a config-shape refusal
 * (iteration 1), a corrupt lineage, or an unsafe-recursion refusal (iteration 1).
 */
export type SubworkflowRouteLaunchRefusal =
  | SubworkflowChildConfigRefusal
  | SubworkflowLineageRefusal
  | SubworkflowChildLaunchRefusal;

export type PlanSubworkflowChildLaunchFromRouteInput = {
  parentRunId: string;
  parentStepId: string;
  /** The parent run's durable `route` JSON. */
  parentRoute: Record<string, unknown>;
  /** The parent run's own workflow definition key. */
  parentDefinitionKey: string;
};

export type SubworkflowRouteChildLaunchPlan =
  | {
      ok: true;
      /** The workflow definition key the child run launches. */
      childDefinitionKey: string;
      /** The workflow definition version the child run launches. */
      childDefinitionVersion: number;
      /** The deterministic child run id (start-or-attach idempotency anchor). */
      childRunId: string;
      /** The nesting depth the child run will occupy (1 = first nested level). */
      childDepth: number;
      /** The resolved recursion bound carried by the child config. */
      maxDepth: number;
      /** The `route` JSON the child run should be started with (lineage propagated). */
      childRoute: Record<string, unknown>;
    }
  | { ok: false; refusal: SubworkflowRouteLaunchRefusal; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The `route.subworkflow` namespace object, or `undefined` when not a plain object. */
function subworkflowNamespace(
  route: Record<string, unknown>
): Record<string, unknown> | undefined {
  const namespace = route[SUBWORKFLOW_ROUTE_KEY];
  return isPlainObject(namespace) ? namespace : undefined;
}

/**
 * Read the parent run's subworkflow lineage from its `route`. Pure and total: an
 * absent namespace / lineage is a legitimate top-level run (no ancestors); a
 * present-but-corrupt lineage fails closed (`lineage_invalid`). `parentDefinitionKey`
 * is the parent run's own key (read from the run row by the IO deriver), so the
 * returned {@link SubworkflowParentLineage} is ready for
 * {@link planSubworkflowChildLaunch}.
 */
export function readSubworkflowParentLineage(
  parentRoute: Record<string, unknown>,
  parentDefinitionKey: string
): SubworkflowParentLineageResolution {
  const namespace = subworkflowNamespace(parentRoute);
  const rawLineage = namespace?.["lineage"];

  if (rawLineage === undefined) {
    // No lineage: a legitimate top-level (non-subworkflow-launched) run.
    return {
      ok: true,
      lineage: { definitionKey: parentDefinitionKey, ancestorDefinitionKeys: [] }
    };
  }

  if (!isPlainObject(rawLineage)) {
    return lineageInvalid("subworkflow lineage is present but is not an object");
  }
  if (!isNonBlankString(rawLineage["parentRunId"])) {
    return lineageInvalid("subworkflow lineage parentRunId must be a non-empty string");
  }
  if (!isNonBlankString(rawLineage["parentStepId"])) {
    return lineageInvalid("subworkflow lineage parentStepId must be a non-empty string");
  }
  const rawAncestors = rawLineage["ancestorDefinitionKeys"];
  if (!Array.isArray(rawAncestors)) {
    return lineageInvalid("subworkflow lineage ancestorDefinitionKeys must be an array");
  }
  if (!rawAncestors.every((key) => isNonBlankString(key))) {
    return lineageInvalid(
      "subworkflow lineage ancestorDefinitionKeys must be non-empty strings"
    );
  }

  return {
    ok: true,
    lineage: {
      definitionKey: parentDefinitionKey,
      ancestorDefinitionKeys: rawAncestors as string[]
    }
  };
}

function lineageInvalid(detail: string): SubworkflowParentLineageResolution {
  return {
    ok: false,
    refusal: "lineage_invalid",
    reason: `${detail}; routing to manual recovery.`
  };
}

/**
 * The deterministic child run id a dispatched `subworkflow` step starts-or-attaches
 * to. Deterministic from the parent run + step so every daemon re-check attaches to
 * the SAME child run rather than spawning a duplicate — the start-or-attach
 * idempotency the producer's contract places in the injected runner.
 */
export function deriveChildSubworkflowRunId(
  parentRunId: string,
  parentStepId: string
): string {
  return `${parentRunId}::${parentStepId}::child`;
}

export type DeriveChildSubworkflowRouteInput = {
  parentRunId: string;
  parentStepId: string;
  parentDefinitionKey: string;
  parentLineage: SubworkflowParentLineage;
  childDepth: number;
};

/**
 * Build the `route` JSON a child run should be started with. The child's ancestry
 * is the parent's ancestry plus the parent's own definition key (root-first), so a
 * grandchild launch sees every ancestor above it and the cycle / depth checks stay
 * sound across nesting levels. The child run gets a fresh route carrying only the
 * propagated lineage — any authored child-of-child config is set separately.
 */
export function deriveChildSubworkflowRoute(
  input: DeriveChildSubworkflowRouteInput
): Record<string, unknown> {
  const lineage: SubworkflowRouteLineage = {
    parentRunId: input.parentRunId,
    parentStepId: input.parentStepId,
    depth: input.childDepth,
    ancestorDefinitionKeys: [
      ...input.parentLineage.ancestorDefinitionKeys,
      input.parentDefinitionKey
    ]
  };
  return { [SUBWORKFLOW_ROUTE_KEY]: { lineage } };
}

/**
 * Compose route-sourced config validation + lineage read + the recursion decider
 * into the single decision the daemon-lane IO deriver forwards. Pure and total: any
 * refusal (missing / invalid child config, corrupt lineage, or unsafe recursion)
 * returns `{ ok: false }` with a typed refusal and an operator-facing reason the
 * caller routes to manual recovery; a launchable child returns its definition key,
 * deterministic child run id, resolved depth bound, and the propagated child route.
 */
export function planSubworkflowChildLaunchFromRoute(
  input: PlanSubworkflowChildLaunchFromRouteInput
): SubworkflowRouteChildLaunchPlan {
  const namespace = subworkflowNamespace(input.parentRoute);

  const configValidation = validateSubworkflowChildConfig(namespace?.["child"]);
  if (!configValidation.ok) {
    return {
      ok: false,
      refusal: configValidation.refusal,
      reason: configValidation.reason
    };
  }

  const lineageResolution = readSubworkflowParentLineage(
    input.parentRoute,
    input.parentDefinitionKey
  );
  if (!lineageResolution.ok) {
    return {
      ok: false,
      refusal: lineageResolution.refusal,
      reason: lineageResolution.reason
    };
  }

  const launchPlan = planSubworkflowChildLaunch(
    configValidation.config,
    lineageResolution.lineage
  );
  if (!launchPlan.ok) {
    return { ok: false, refusal: launchPlan.refusal, reason: launchPlan.reason };
  }

  return {
    ok: true,
    childDefinitionKey: launchPlan.childDefinitionKey,
    childDefinitionVersion: launchPlan.childDefinitionVersion,
    childRunId: deriveChildSubworkflowRunId(input.parentRunId, input.parentStepId),
    childDepth: launchPlan.childDepth,
    maxDepth: launchPlan.maxDepth,
    childRoute: deriveChildSubworkflowRoute({
      parentRunId: input.parentRunId,
      parentStepId: input.parentStepId,
      parentDefinitionKey: input.parentDefinitionKey,
      parentLineage: lineageResolution.lineage,
      childDepth: launchPlan.childDepth
    })
  };
}
