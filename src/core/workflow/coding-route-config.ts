/**
 * Native per-step coding route/config overrides for the Momentum-native coding
 * workflow (NGX-510).
 *
 * NGX-508 (`workflow run start-coding`) and NGX-509 (`workflow run
 * preview-coding`) gave operators an explicit native door and a read-only frozen
 * plan, but the planned harness/model/effort selections were not yet
 * reconfigurable: the run-level `route.profile` was the only operator route input,
 * and nothing per-step. CWFP already lets an operator inspect and adjust the
 * planned harness/model choices before approving execution; this module is the
 * keystone that lets the native door carry the same per-step control.
 *
 * This module owns ONLY the pure representation + validation half (no SQLite, no
 * file system, no clock, no network), the same discipline
 * `validateSubworkflowChildConfig` (`subworkflow-child-config.ts`) and
 * `readSubworkflowParentLineage` (`subworkflow-route.ts`) follow, so the
 * fail-closed contract is exhaustively testable on its own. Later slices wire it
 * into the CLI start/preview doors (build overrides from flags), the
 * status/handoff/logs surfaces (render the selected config), and the daemon
 * executor selection (feed the per-step config into the highest-precedence
 * `stepConfig` level of `resolveSingleShotRoundSelection` /
 * `resolveGoalLoopRoundSelection`, or fail closed when it cannot).
 *
 * Home and namespace. A {@link import("./definition.js").StepDefinition} carries
 * only an executor *family*, never per-step config, so - exactly as
 * `subworkflow-route.ts` reasoned for child config - the only in-scope durable
 * home without a schema change is the run's free-form `route` JSON. Per-step
 * overrides live under the single {@link CODING_ROUTE_STEPS_KEY} (`route.steps`)
 * namespace, parallel to `route.subworkflow` and the run-level `route.profile`.
 * `route.profile` (the recorded operator profile) stays distinct from these
 * per-step selections and from the daemon's `MOMENTUM_LIVE_WRAPPER_PROFILE`
 * execution profile; none of them are conflated here.
 *
 * Field mapping. Each per-step override carries the operator-facing
 * harness/model/effort vocabulary (the same `harness`/`model` keys the workflow
 * evidence metadata already uses). When the executor-selection wiring slice lands,
 * `harness` maps to the executor's `agentProvider` selection field and
 * `model`/`effort` map directly, feeding the highest-precedence layer of the
 * single-shot / goal-loop selection resolver. Momentum holds no built-in
 * harness/model/effort opinion (the selection floor is all-`null`), so this module
 * deliberately does not enum-constrain values - it validates structure (supported
 * step, known field, non-blank string) and leaves the concrete agent/model/effort
 * vocabulary to repo/run config, mirroring the executors' free-form `string | null`
 * treatment.
 */

/** The run-`route` namespace that carries per-step coding route/config overrides. */
export const CODING_ROUTE_STEPS_KEY = "steps";

/**
 * The coding-workflow steps that accept operator route/config overrides - the
 * steps that are currently operationally meaningful for harness/model/effort
 * selection (implementation, postflight, no-mistakes, merge-cleanup). `preflight`
 * (bounded prep) and `linear-refresh` (the safety-gated external-apply adapter)
 * are intentionally excluded; configuring them fails closed (`step_unsupported`).
 * Declared in canonical order so a normalized override map is byte-stable.
 */
export const CONFIGURABLE_CODING_STEP_KEYS = [
  "implementation",
  "postflight",
  "no-mistakes",
  "merge-cleanup"
] as const;

export type ConfigurableCodingStepKey =
  (typeof CONFIGURABLE_CODING_STEP_KEYS)[number];

/**
 * The per-step override fields, in canonical order. `harness` selects the agent
 * provider, `model` the model, `effort` the reasoning effort. Declared in
 * canonical order so a normalized override is byte-stable.
 */
export const CODING_STEP_ROUTE_FIELDS = ["harness", "model", "effort"] as const;

export type CodingStepRouteField = (typeof CODING_STEP_ROUTE_FIELDS)[number];

/**
 * A single step's operator override. Sparse: only the fields the operator set are
 * present, so an absent field defers to the lower-precedence selection layers at
 * execution time (an explicit value is a deliberate per-step choice).
 */
export type CodingStepRouteOverride = Partial<
  Record<CodingStepRouteField, string>
>;

/**
 * The durable per-step override map carried under `route.steps`. Only steps the
 * operator actually overrode (with at least one field) appear; a step with no
 * overrides is simply absent and resolves to the defaults.
 */
export type CodingStepRouteOverrides = Partial<
  Record<ConfigurableCodingStepKey, CodingStepRouteOverride>
>;

/**
 * The effective selection for one step as a preview/status surface should show it:
 * every field present, `null` where the operator did not override it (the
 * "default / inherit at execution" sentinel).
 */
export type CodingStepRouteSelection = Record<
  CodingStepRouteField,
  string | null
>;

/** The effective per-step selections for every configurable step. */
export type CodingRouteStepSelections = Record<
  ConfigurableCodingStepKey,
  CodingStepRouteSelection
>;

/**
 * The default selection for a step the operator did not reconfigure: every field
 * `null`, meaning "inherit from repo/run/global config at execution time".
 */
export const DEFAULT_CODING_STEP_ROUTE_SELECTION: CodingStepRouteSelection = {
  harness: null,
  model: null,
  effort: null
};

/**
 * Why an untrusted per-step coding route config failed validation:
 *
 *   - `overrides_invalid`: the overrides value is present but not a plain object.
 *   - `step_unsupported`: a step key is not one of
 *     {@link CONFIGURABLE_CODING_STEP_KEYS}.
 *   - `step_config_invalid`: a step's value is not a plain object.
 *   - `field_unsupported`: a step carries a field outside
 *     {@link CODING_STEP_ROUTE_FIELDS}.
 *   - `value_invalid`: a field value is not a non-blank string.
 */
export const CODING_ROUTE_CONFIG_REFUSALS = [
  "overrides_invalid",
  "step_unsupported",
  "step_config_invalid",
  "field_unsupported",
  "value_invalid"
] as const;

export type CodingRouteConfigRefusal =
  (typeof CODING_ROUTE_CONFIG_REFUSALS)[number];

export type CodingStepRouteOverridesResult =
  | { ok: true; overrides: CodingStepRouteOverrides }
  | { ok: false; refusal: CodingRouteConfigRefusal; reason: string; path?: string };

const CONFIGURABLE_STEP_KEY_SET: ReadonlySet<string> = new Set(
  CONFIGURABLE_CODING_STEP_KEYS
);

const ROUTE_FIELD_SET: ReadonlySet<string> = new Set(CODING_STEP_ROUTE_FIELDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigurableCodingStepKey(
  value: string
): value is ConfigurableCodingStepKey {
  return CONFIGURABLE_STEP_KEY_SET.has(value);
}

function isCodingStepRouteField(value: string): value is CodingStepRouteField {
  return ROUTE_FIELD_SET.has(value);
}

function refuse(
  refusal: CodingRouteConfigRefusal,
  reason: string,
  path?: string
): CodingStepRouteOverridesResult {
  return path === undefined
    ? { ok: false, refusal, reason }
    : { ok: false, refusal, reason, path };
}

/**
 * Validate and normalize untrusted per-step coding route overrides into a
 * {@link CodingStepRouteOverrides} map. Pure and total: never throws, always
 * returns a result. Absent overrides (`undefined` / `null`) are a legitimate
 * "use defaults" case (unlike subworkflow child config, an operator who sets no
 * per-step config is not misconfigured); a present-but-non-object value, an
 * unsupported step, an unknown field, or a non-string/blank value all fail closed
 * with a typed refusal so a misconfigured selection can never silently execute.
 *
 * Normalization makes the output byte-stable: steps are emitted in
 * {@link CONFIGURABLE_CODING_STEP_KEYS} order, fields in
 * {@link CODING_STEP_ROUTE_FIELDS} order, values trimmed, and a step whose
 * override object resolves to no recognized fields is dropped entirely.
 */
export function validateCodingStepRouteOverrides(
  value: unknown
): CodingStepRouteOverridesResult {
  if (value === undefined || value === null) {
    return { ok: true, overrides: {} };
  }
  if (!isPlainObject(value)) {
    return refuse(
      "overrides_invalid",
      "Coding route step overrides must be a plain object keyed by step.",
      CODING_ROUTE_STEPS_KEY
    );
  }

  // Validate each provided step in input order so the first refusal is reported
  // against the offending key; build the normalized output in canonical order.
  const normalizedByStep = new Map<
    ConfigurableCodingStepKey,
    CodingStepRouteOverride
  >();
  for (const [stepKey, rawStepConfig] of Object.entries(value)) {
    if (!isConfigurableCodingStepKey(stepKey)) {
      return refuse(
        "step_unsupported",
        `Coding route step "${stepKey}" is not configurable; supported steps: ${CONFIGURABLE_CODING_STEP_KEYS.join(", ")}.`,
        `${CODING_ROUTE_STEPS_KEY}.${stepKey}`
      );
    }
    if (!isPlainObject(rawStepConfig)) {
      return refuse(
        "step_config_invalid",
        `Coding route config for step "${stepKey}" must be a plain object of harness/model/effort fields.`,
        `${CODING_ROUTE_STEPS_KEY}.${stepKey}`
      );
    }

    const normalizedFields: CodingStepRouteOverride = {};
    for (const [fieldKey, rawFieldValue] of Object.entries(rawStepConfig)) {
      if (!isCodingStepRouteField(fieldKey)) {
        return refuse(
          "field_unsupported",
          `Coding route config for step "${stepKey}" has unknown field "${fieldKey}"; supported fields: ${CODING_STEP_ROUTE_FIELDS.join(", ")}.`,
          `${CODING_ROUTE_STEPS_KEY}.${stepKey}.${fieldKey}`
        );
      }
      if (typeof rawFieldValue !== "string" || rawFieldValue.trim().length === 0) {
        return refuse(
          "value_invalid",
          `Coding route config ${stepKey}.${fieldKey} must be a non-empty string.`,
          `${CODING_ROUTE_STEPS_KEY}.${stepKey}.${fieldKey}`
        );
      }
      normalizedFields[fieldKey] = rawFieldValue.trim();
    }

    // A step whose override resolves to no recognized fields contributes nothing.
    if (Object.keys(normalizedFields).length > 0) {
      normalizedByStep.set(stepKey, normalizedFields);
    }
  }

  const overrides: CodingStepRouteOverrides = {};
  for (const stepKey of CONFIGURABLE_CODING_STEP_KEYS) {
    const fields = normalizedByStep.get(stepKey);
    if (fields === undefined) {
      continue;
    }
    const orderedFields: CodingStepRouteOverride = {};
    for (const fieldKey of CODING_STEP_ROUTE_FIELDS) {
      const fieldValue = fields[fieldKey];
      if (fieldValue !== undefined) {
        orderedFields[fieldKey] = fieldValue;
      }
    }
    overrides[stepKey] = orderedFields;
  }

  return { ok: true, overrides };
}

/**
 * Read back per-step coding route overrides from a persisted run `route`. Pure and
 * total: an absent `route.steps` namespace is a legitimate run with no per-step
 * overrides; a present-but-corrupt namespace fails closed with the same refusal
 * taxonomy as {@link validateCodingStepRouteOverrides} so a hand-edited or
 * stale-shape route can never silently drop or misread an operator's selection.
 */
export function readCodingStepRouteOverrides(
  route: Record<string, unknown>
): CodingStepRouteOverridesResult {
  const raw = route[CODING_ROUTE_STEPS_KEY];
  if (raw === undefined) {
    return { ok: true, overrides: {} };
  }
  return validateCodingStepRouteOverrides(raw);
}

/**
 * Embed per-step coding route overrides into a run `route`, returning a new route
 * object (the input is never mutated). When there are no overrides the
 * `route.steps` namespace is omitted entirely so the durable route stays minimal;
 * all other namespaces (`route.profile`, `route.subworkflow`, ...) are preserved.
 */
export function writeCodingStepRouteOverrides(
  route: Record<string, unknown>,
  overrides: CodingStepRouteOverrides
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...route };
  if (Object.keys(overrides).length === 0) {
    delete next[CODING_ROUTE_STEPS_KEY];
    return next;
  }
  next[CODING_ROUTE_STEPS_KEY] = overrides;
  return next;
}

/**
 * Project per-step overrides into the effective per-step selections a
 * preview/status surface shows: every configurable step in canonical order, every
 * field present, `null` where the operator did not override it. This is the
 * "preview default route selections, then the changed ones" view - a step with no
 * override reads as all-default, an overridden field reads as the operator's choice.
 */
export function resolveCodingRouteStepSelections(
  overrides: CodingStepRouteOverrides
): CodingRouteStepSelections {
  const selections = {} as CodingRouteStepSelections;
  for (const stepKey of CONFIGURABLE_CODING_STEP_KEYS) {
    const override = overrides[stepKey];
    selections[stepKey] = {
      harness: override?.harness ?? null,
      model: override?.model ?? null,
      effort: override?.effort ?? null
    };
  }
  return selections;
}
