/**
 * Canonical-state child-launch planning for production `subworkflow` steps.
 *
 * The owning step's `workflow_steps.executor_config_json` is the only active
 * source of subworkflow child intent, and the run's `workflow_run_lineage` row
 * is the only active source of parent run, parent step, depth, and ancestry
 * facts. This module owns the pure composition over those canonical facts; the
 * daemon-lane deriver (`route/subworkflow-dispatch-context.ts`) owns the IO
 * that reads them, and start persistence (`run/start-persist.ts`) receives the
 * explicit child lineage this planner derives. The retired `route.subworkflow`
 * namespace is no longer consulted anywhere on the active path; legacy
 * route_json carrying it is migrated into these canonical destinations by the
 * adapter migration and validated there.
 *
 * Discipline (pure + total + fail-closed, mirroring
 * `route/subworkflow-child-config.ts` — no SQLite, no file system, no clock):
 *
 *   - {@link readSubworkflowCanonicalLineage} validates a present canonical
 *     lineage row; a corrupt row fails closed (`lineage_invalid`) rather than
 *     resetting to top-level, which would defeat the recursion bound. An absent
 *     row is the caller's legitimate top-level case.
 *   - {@link planSubworkflowChildLaunchFromStep} composes the step-owned child
 *     config validation, the canonical ancestry, and the existing
 *     recursion-safety decider into the single decision the IO deriver
 *     forwards, deriving the deterministic child run id and the explicit child
 *     lineage (the parent's ancestry plus the parent's own definition key,
 *     root-first) that start persistence inserts atomically with the child run.
 */

import {
  planSubworkflowChildLaunch,
  validateSubworkflowChildConfig,
  type SubworkflowChildConfigRefusal,
  type SubworkflowChildLaunchRefusal,
} from "./subworkflow-child-config.js";

/**
 * Why reading a present canonical lineage row failed: the row is not a
 * well-formed lineage fact. A corrupt lineage is treated as unsafe-recursion
 * state and fails closed, never reset to top-level.
 */
export type SubworkflowLineageRefusal = "lineage_invalid";

/**
 * Every reason a canonical-state child launch can fail closed: a config-shape
 * refusal, a corrupt lineage, or an unsafe-recursion refusal.
 */
export type SubworkflowRouteLaunchRefusal =
  | SubworkflowChildConfigRefusal
  | SubworkflowLineageRefusal
  | SubworkflowChildLaunchRefusal;

/**
 * The canonical recursion lineage of one run, exactly as the durable
 * `workflow_run_lineage` row records it: the parent run + dispatched step that
 * launched the run, its nesting depth, and every subworkflow ancestor's
 * definition key above it (root-first, excluding the run itself). Absent for a
 * top-level run.
 */
export type SubworkflowCanonicalLineage = {
  parentRunId: string;
  parentStepId: string;
  depth: number;
  ancestorDefinitionKeys: readonly string[];
};

export type SubworkflowCanonicalLineageResolution =
  | { ok: true; lineage: SubworkflowCanonicalLineage }
  | { ok: false; refusal: SubworkflowLineageRefusal; reason: string };

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function lineageInvalid(detail: string): {
  ok: false;
  refusal: SubworkflowLineageRefusal;
  reason: string;
} {
  return {
    ok: false,
    refusal: "lineage_invalid",
    reason: `${detail}; routing to manual recovery.`,
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
  parentStepId: string,
): string {
  return `${parentRunId}::${parentStepId}::child`;
}

/**
 * Validate a raw canonical `workflow_run_lineage` row into a
 * {@link SubworkflowCanonicalLineage}. Pure and total: a present-but-corrupt row
 * (blank ids, non-positive depth, malformed / duplicated ancestry, or a
 * depth / ancestry mismatch) fails closed (`lineage_invalid`) — silently
 * resetting corrupt lineage to top-level would defeat the recursion bound. An
 * absent row is the caller's legitimate top-level case and never reaches here.
 */
export function readSubworkflowCanonicalLineage(
  runId: string,
  row: {
    parentRunId: string;
    parentStepId: string;
    depth: number;
    ancestorDefinitionKeysJson: string;
  },
): SubworkflowCanonicalLineageResolution {
  if (!isNonBlankString(row.parentRunId)) {
    return lineageInvalid(
      `run ${runId} canonical lineage parentRunId must be a non-blank string`,
    );
  }
  if (!isNonBlankString(row.parentStepId)) {
    return lineageInvalid(
      `run ${runId} canonical lineage parentStepId must be a non-blank string`,
    );
  }
  if (
    typeof row.depth !== "number" ||
    !Number.isInteger(row.depth) ||
    row.depth <= 0
  ) {
    return lineageInvalid(
      `run ${runId} canonical lineage depth must be a positive integer`,
    );
  }
  let ancestors: unknown;
  try {
    ancestors = JSON.parse(row.ancestorDefinitionKeysJson);
  } catch {
    return lineageInvalid(
      `run ${runId} canonical lineage ancestorDefinitionKeys is not valid JSON`,
    );
  }
  if (
    !Array.isArray(ancestors) ||
    !ancestors.every((key) => isNonBlankString(key))
  ) {
    return lineageInvalid(
      `run ${runId} canonical lineage ancestorDefinitionKeys must be an array of non-blank strings`,
    );
  }
  if (row.depth !== ancestors.length) {
    return lineageInvalid(
      `run ${runId} canonical lineage depth must equal ancestorDefinitionKeys.length`,
    );
  }
  if (new Set(ancestors).size !== ancestors.length) {
    return lineageInvalid(
      `run ${runId} canonical lineage ancestorDefinitionKeys must not repeat a definition`,
    );
  }
  return {
    ok: true,
    lineage: {
      parentRunId: row.parentRunId,
      parentStepId: row.parentStepId,
      depth: row.depth,
      ancestorDefinitionKeys: ancestors as string[],
    },
  };
}

export type PlanSubworkflowChildLaunchFromStepInput = {
  parentRunId: string;
  parentStepId: string;
  /** The parent run's own workflow definition key. */
  parentDefinitionKey: string;
  /** The claimed step's parsed `workflow_steps.executor_config_json` object. */
  stepExecutorConfig: Record<string, unknown>;
  /** The parent run's canonical lineage row, or `null` for a top-level run. */
  parentLineage: SubworkflowCanonicalLineage | null;
};

export type SubworkflowStepChildLaunchPlan =
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
      /** The explicit canonical lineage the child run is persisted with. */
      childLineage: SubworkflowCanonicalLineage;
    }
  | { ok: false; refusal: SubworkflowRouteLaunchRefusal; reason: string };

/**
 * Compose the canonical-state child-launch decision the daemon-lane IO deriver
 * forwards: validate the step-owned `child` intent from the claimed step's
 * `executor_config_json`, treat the canonical lineage row (or its absence) as the
 * only ancestry authority, and apply the existing recursion-safety planner. Pure
 * and total: any refusal returns `{ ok: false }` with a typed refusal the caller
 * routes to manual recovery; a launchable child returns its definition ref, the
 * deterministic child run id, and the explicit child lineage the
 * start-persistence seam inserts atomically with the child run.
 */
export function planSubworkflowChildLaunchFromStep(
  input: PlanSubworkflowChildLaunchFromStepInput,
): SubworkflowStepChildLaunchPlan {
  const configValidation = validateSubworkflowChildConfig(
    input.stepExecutorConfig["child"],
  );
  if (!configValidation.ok) {
    return {
      ok: false,
      refusal: configValidation.refusal,
      reason: configValidation.reason,
    };
  }

  const parentAncestors = input.parentLineage?.ancestorDefinitionKeys ?? [];
  const launchPlan = planSubworkflowChildLaunch(configValidation.config, {
    definitionKey: input.parentDefinitionKey,
    ancestorDefinitionKeys: parentAncestors,
  });
  if (!launchPlan.ok) {
    return {
      ok: false,
      refusal: launchPlan.refusal,
      reason: launchPlan.reason,
    };
  }

  return {
    ok: true,
    childDefinitionKey: launchPlan.childDefinitionKey,
    childDefinitionVersion: launchPlan.childDefinitionVersion,
    childRunId: deriveChildSubworkflowRunId(
      input.parentRunId,
      input.parentStepId,
    ),
    childDepth: launchPlan.childDepth,
    maxDepth: launchPlan.maxDepth,
    childLineage: {
      parentRunId: input.parentRunId,
      parentStepId: input.parentStepId,
      depth: launchPlan.childDepth,
      ancestorDefinitionKeys: [...parentAncestors, input.parentDefinitionKey],
    },
  };
}
