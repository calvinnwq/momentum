/**
 * Workflow definition primitives for the workflow-first runtime.
 *
 * This module owns the *pure* `WorkflowDefinition` / `StepDefinition` shape,
 * a deterministic validator, and the built-in coding workflow definition. It
 * follows the same discipline as `run/reducer.ts`: no SQLite, no file
 * system, no executor invocation. Durable persistence (`workflow_definitions`
 * / `step_definitions`) is layered on top of these primitives in
 * `definition/persist.ts`; first-class workflow run start, executor
 * records, the opt-in daemon scheduler lane, the landed goal-loop / one-shot /
 * script / no-mistakes mirror adapters, gates, and production dispatch scaffolds
 * are layered on later modules. Closeout dogfood and deferred executor-family
 * adapters stay outside this primitive module.
 *
 * Scope decisions pinned here, grounded in the compact runtime anchors in
 * SPEC.md and the long-form planning contracts externalized to Obsidian:
 *
 *   - `StepDefinition.executor` names an executor *family* only. The rich
 *     per-step executor configuration (agent / model / effort / policy) is the
 *     `ExecutorDefinition` record owned by the executor-loop spine; naming the family
 *     keeps a step "configured" without pulling that schema forward.
 *   - `StepDefinition.kind` reuses the canonical M7 `WorkflowStepKind`
 *     vocabulary so the built-in coding workflow stays wire-compatible with the
 *     existing `workflow_steps.kind` column and M7/M8 operator controls.
 *     Broadening the kind vocabulary for genuinely arbitrary steps is a
 *     deliberate future concern, not part of this slice.
 *   - The built-in coding workflow definition is shipped as data/config, not a
 *     fixed product boundary: its per-step executor families are editable
 *     defaults chosen from the contract's `step -> executor` mapping.
 *   - Built-in definitions are registered by `(key, version)`: unversioned
 *     lookup selects the latest known version for new starts, while versioned
 *     lookup preserves dispatch against the version recorded on an existing
 *     run.
 */

import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind
} from "../run/reducer.js";

/**
 * Executor families pinned by SPEC.md's Runtime Model and Native Goal-Loop
 * Contract anchors. A `StepDefinition` selects one family; runner
 * compatibility shims such as GNHF belong below `goal-loop` rather than in this
 * family list.
 */
export const WORKFLOW_EXECUTOR_FAMILIES = [
  "goal-loop",
  "one-shot",
  "no-mistakes",
  "script",
  "external-apply",
  "subworkflow"
] as const;
export type WorkflowExecutorFamily =
  (typeof WORKFLOW_EXECUTOR_FAMILIES)[number];

const EXECUTOR_FAMILY_SET: ReadonlySet<string> = new Set(
  WORKFLOW_EXECUTOR_FAMILIES
);

export function isWorkflowExecutorFamily(
  value: string
): value is WorkflowExecutorFamily {
  return EXECUTOR_FAMILY_SET.has(value);
}

/**
 * One configured step inside a workflow recipe.
 *
 *   - `key` is the stable, unique-within-definition identifier (slug). It is
 *     persisted as `step_definitions.step_key` and can seed future run-level
 *     `workflow_steps.step_id` values, letting a recipe carry more than one step
 *     of the same `kind` (e.g. multiple postflight passes) without colliding.
 *   - `kind` is the canonical routing classification (`WorkflowStepKind`).
 *   - `executor` is the executor family that powers the step.
 *   - `order` is the step's position; orders must be unique within a
 *     definition.
 *   - `required` marks whether the step must reach terminal success for the run
 *     to succeed (mirrors `workflow_steps.required`).
 */
export type StepDefinition = {
  key: string;
  kind: WorkflowStepKind;
  executor: WorkflowExecutorFamily;
  order: number;
  required: boolean;
};

/**
 * A reusable workflow recipe: an ordered list of step definitions plus stable
 * identity and a version so definitions can evolve without losing history.
 */
export type WorkflowDefinition = {
  key: string;
  title: string;
  version: number;
  steps: StepDefinition[];
};

export const WORKFLOW_DEFINITION_VALIDATION_ERROR_CODES = [
  "definition_not_object",
  "definition_key_invalid",
  "definition_title_invalid",
  "definition_version_invalid",
  "definition_steps_empty",
  "step_not_object",
  "step_key_invalid",
  "step_key_duplicate",
  "step_kind_invalid",
  "step_executor_invalid",
  "step_order_invalid",
  "step_order_duplicate",
  "step_required_invalid"
] as const;
export type WorkflowDefinitionValidationErrorCode =
  (typeof WORKFLOW_DEFINITION_VALIDATION_ERROR_CODES)[number];

export type WorkflowDefinitionValidationError = {
  code: WorkflowDefinitionValidationErrorCode;
  message: string;
  path?: string;
};

export type WorkflowDefinitionValidationResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; errors: WorkflowDefinitionValidationError[] };

// Lowercase slug: alphanumeric segments joined by single hyphens. Keeps
// definition / step keys safe as durable identities and future artifact paths.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value as a {@link WorkflowDefinition}. Collects every
 * problem (definition-level first, then per-step in declared order) so callers
 * can surface a complete diagnostic rather than one error at a time.
 */
export function validateWorkflowDefinition(
  value: unknown
): WorkflowDefinitionValidationResult {
  const errors: WorkflowDefinitionValidationError[] = [];

  if (!isPlainObject(value)) {
    return {
      ok: false,
      errors: [
        {
          code: "definition_not_object",
          message: "Workflow definition must be a plain object."
        }
      ]
    };
  }

  if (!isSlug(value["key"])) {
    errors.push({
      code: "definition_key_invalid",
      message: "Workflow definition key must be a non-empty slug.",
      path: "key"
    });
  }

  if (typeof value["title"] !== "string" || value["title"].trim().length === 0) {
    errors.push({
      code: "definition_title_invalid",
      message: "Workflow definition title must be a non-empty string.",
      path: "title"
    });
  }

  if (!isPositiveInteger(value["version"])) {
    errors.push({
      code: "definition_version_invalid",
      message: "Workflow definition version must be a positive integer.",
      path: "version"
    });
  }

  const rawSteps = value["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push({
      code: "definition_steps_empty",
      message: "Workflow definition must declare at least one step.",
      path: "steps"
    });
  } else {
    validateSteps(rawSteps, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, definition: value as unknown as WorkflowDefinition };
}

function validateSteps(
  rawSteps: readonly unknown[],
  errors: WorkflowDefinitionValidationError[]
): void {
  const seenKeys = new Set<string>();
  const seenOrders = new Set<number>();

  rawSteps.forEach((rawStep, index) => {
    const at = `steps[${index}]`;
    if (!isPlainObject(rawStep)) {
      errors.push({
        code: "step_not_object",
        message: `Step ${index} must be a plain object.`,
        path: at
      });
      return;
    }

    const key = rawStep["key"];
    if (!isSlug(key)) {
      errors.push({
        code: "step_key_invalid",
        message: `Step ${index} key must be a non-empty slug.`,
        path: `${at}.key`
      });
    } else if (seenKeys.has(key)) {
      errors.push({
        code: "step_key_duplicate",
        message: `Duplicate step key "${key}".`,
        path: `${at}.key`
      });
    } else {
      seenKeys.add(key);
    }

    if (
      typeof rawStep["kind"] !== "string" ||
      !(WORKFLOW_STEP_KINDS as readonly string[]).includes(rawStep["kind"])
    ) {
      errors.push({
        code: "step_kind_invalid",
        message: `Step ${index} kind must be one of: ${WORKFLOW_STEP_KINDS.join(", ")}.`,
        path: `${at}.kind`
      });
    }

    if (
      typeof rawStep["executor"] !== "string" ||
      !isWorkflowExecutorFamily(rawStep["executor"])
    ) {
      errors.push({
        code: "step_executor_invalid",
        message: `Step ${index} executor must be one of: ${WORKFLOW_EXECUTOR_FAMILIES.join(", ")}.`,
        path: `${at}.executor`
      });
    }

    const order = rawStep["order"];
    if (!isNonNegativeInteger(order)) {
      errors.push({
        code: "step_order_invalid",
        message: `Step ${index} order must be a non-negative integer.`,
        path: `${at}.order`
      });
    } else if (seenOrders.has(order)) {
      errors.push({
        code: "step_order_duplicate",
        message: `Duplicate step order ${order}.`,
        path: `${at}.order`
      });
    } else {
      seenOrders.add(order);
    }

    if (typeof rawStep["required"] !== "boolean") {
      errors.push({
        code: "step_required_invalid",
        message: `Step ${index} required must be a boolean.`,
        path: `${at}.required`
      });
    }
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export const CODING_WORKFLOW_DEFINITION_KEY = "coding-workflow";

/**
 * The canonical OpenClaw coding workflow expressed as a built-in
 * {@link WorkflowDefinition}. Steps mirror the M7 `WorkflowStepKind` order;
 * executor families follow the `step -> executor` mapping in
 * SPEC.md, choosing one option where the
 * contract offers a pair:
 *
 *   - preflight      -> one-shot      (a single bounded prep invocation)
 *   - implementation -> goal-loop     (bounded autonomous implementation rounds)
 *   - postflight     -> one-shot      (a single bounded review pass)
 *   - no-mistakes    -> no-mistakes   (specialist review-gate mirror)
 *   - merge-cleanup  -> script        (deterministic local cleanup; remote git
 *                                       stays out of M10 scope)
 *   - linear-refresh -> external-apply (operator-mediated external write;
 *                                       daemon-dispatchable through the
 *                                       M6 safety-gated adapter)
 *
 * These families can evolve through explicit workflow-runtime design, but
 * compatibility runners such as GNHF must report through the native `goal-loop`
 * invocation / round contract rather than becoming first-class executor
 * families merely to reuse behavior.
 */
export const CODING_WORKFLOW_DEFINITION: WorkflowDefinition = {
  key: CODING_WORKFLOW_DEFINITION_KEY,
  title: "OpenClaw Coding Workflow",
  version: 1,
  steps: [
    {
      key: "preflight",
      kind: "preflight",
      executor: "one-shot",
      order: 0,
      required: true
    },
    {
      key: "implementation",
      kind: "implementation",
      executor: "goal-loop",
      order: 1,
      required: true
    },
    {
      key: "postflight",
      kind: "postflight",
      executor: "one-shot",
      order: 2,
      required: true
    },
    {
      key: "no-mistakes",
      kind: "no-mistakes",
      executor: "no-mistakes",
      order: 3,
      required: true
    },
    {
      key: "merge-cleanup",
      kind: "merge-cleanup",
      executor: "script",
      order: 4,
      required: true
    },
    {
      key: "linear-refresh",
      kind: "linear-refresh",
      executor: "external-apply",
      order: 5,
      required: true
    }
  ]
};

export const BUILT_IN_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  CODING_WORKFLOW_DEFINITION
];

const BUILT_IN_BY_KEY_AND_VERSION: ReadonlyMap<string, WorkflowDefinition> =
  new Map(
    BUILT_IN_WORKFLOW_DEFINITIONS.map((def) => [
      builtInDefinitionIdentity(def.key, def.version),
      def
    ])
  );

const BUILT_IN_LATEST_BY_KEY: ReadonlyMap<string, WorkflowDefinition> = new Map(
  uniqueBuiltInDefinitionKeys(BUILT_IN_WORKFLOW_DEFINITIONS).map((key) => [
    key,
    latestBuiltInWorkflowDefinitionForKey(key)
  ])
);

/**
 * Return a built-in workflow definition by key.
 *
 * When `version` is omitted, this selects the latest known built-in version for
 * the key. When `version` is supplied, this resolves only that exact key/version
 * pair so existing runs keep dispatching through the version they recorded at
 * start time.
 */
export function getBuiltInWorkflowDefinition(
  key: string,
  version?: number
): WorkflowDefinition | undefined {
  if (version !== undefined) {
    return BUILT_IN_BY_KEY_AND_VERSION.get(
      builtInDefinitionIdentity(key, version)
    );
  }
  return BUILT_IN_LATEST_BY_KEY.get(key);
}

/**
 * List the distinct built-in workflow definition keys currently shipped.
 */
export function listBuiltInWorkflowDefinitionKeys(): readonly string[] {
  return uniqueBuiltInDefinitionKeys(BUILT_IN_WORKFLOW_DEFINITIONS);
}

/**
 * Select a built-in workflow definition from an injected registry.
 *
 * This mirrors {@link getBuiltInWorkflowDefinition} for tests and future
 * registry callers: exact version when pinned, latest known version for the key
 * when unpinned.
 */
export function selectBuiltInWorkflowDefinition(
  definitions: readonly WorkflowDefinition[],
  key: string,
  version?: number
): WorkflowDefinition | undefined {
  if (version !== undefined) {
    return definitions.find((def) => def.key === key && def.version === version);
  }
  return selectLatestBuiltInWorkflowDefinition(
    definitions.filter((def) => def.key === key)
  );
}

function selectLatestBuiltInWorkflowDefinition(
  definitions: readonly WorkflowDefinition[]
): WorkflowDefinition | undefined {
  return definitions.reduce<WorkflowDefinition | undefined>((latest, def) => {
    if (latest === undefined || def.version > latest.version) {
      return def;
    }
    return latest;
  }, undefined);
}

function latestBuiltInWorkflowDefinitionForKey(key: string): WorkflowDefinition {
  const latest = selectLatestBuiltInWorkflowDefinition(
    BUILT_IN_WORKFLOW_DEFINITIONS.filter((def) => def.key === key)
  );
  if (latest === undefined) {
    throw new Error(`Missing built-in workflow definition for key: ${key}`);
  }
  return latest;
}

function uniqueBuiltInDefinitionKeys(
  definitions: readonly WorkflowDefinition[]
): readonly string[] {
  return [...new Set(definitions.map((def) => def.key))];
}

function builtInDefinitionIdentity(key: string, version: number): string {
  return `${key}@${version}`;
}
