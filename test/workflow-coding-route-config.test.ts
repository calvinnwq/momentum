import { describe, expect, it } from "vitest";

import {
  CONFIGURABLE_CODING_STEP_KEYS,
  CODING_ROUTE_STEPS_KEY,
  CODING_STEP_ROUTE_FIELDS,
  DEFAULT_CODING_STEP_ROUTE_SELECTION,
  formatCodingRouteStepSelectionLines,
  readCodingStepRouteOverrides,
  resolveCodingRouteStepSelections,
  validateCodingStepRouteOverrides,
  writeCodingStepRouteOverrides,
  type CodingStepRouteOverrides
} from "../src/core/workflow/coding-route-config.js";

/**
 * NGX-510 — native per-step coding route/config overrides. This is the pure
 * keystone decider (no SQLite, no file system, no clock), the same discipline
 * `validateSubworkflowChildConfig` / `readSubworkflowParentLineage` follow, so the
 * fail-closed contract for unsupported steps/fields and corrupt persisted route
 * config is exhaustively testable on its own. Later slices wire it into the CLI
 * start/preview doors, status/handoff/logs surfaces, and the daemon executor
 * selection.
 *
 * These tests pin:
 *   - validation: well-formed overrides normalize to a canonical (byte-stable)
 *     step+field order; absent overrides are legitimate (use defaults); an
 *     unsupported step, unknown field, or non-string/blank value fails closed
 *     with a typed refusal;
 *   - persistence: overrides round-trip through `route.steps` without disturbing
 *     other route namespaces (`profile`, `subworkflow`), and a present-but-corrupt
 *     `route.steps` fails closed on read-back;
 *   - resolution: every configurable step is projected with default (null)
 *     selections for the fields the operator did not override, so a preview can
 *     show defaults vs operator choices.
 */

describe("coding-route-config — configurable surface", () => {
  it("exposes exactly the four operationally meaningful steps in order", () => {
    expect([...CONFIGURABLE_CODING_STEP_KEYS]).toEqual([
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup"
    ]);
  });

  it("exposes exactly the harness/model/effort fields in order", () => {
    expect([...CODING_STEP_ROUTE_FIELDS]).toEqual(["harness", "model", "effort"]);
  });

  it("defaults every selection field to null (inherit at execution)", () => {
    expect(DEFAULT_CODING_STEP_ROUTE_SELECTION).toEqual({
      harness: null,
      model: null,
      effort: null
    });
  });
});

describe("validateCodingStepRouteOverrides — shape and normalization", () => {
  it("accepts undefined as no overrides", () => {
    const result = validateCodingStepRouteOverrides(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({});
  });

  it("accepts null as no overrides", () => {
    const result = validateCodingStepRouteOverrides(null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({});
  });

  it("accepts an empty object as no overrides", () => {
    const result = validateCodingStepRouteOverrides({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({});
  });

  it("accepts a single-step single-field override", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { model: "claude-opus-4-8" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({
      implementation: { model: "claude-opus-4-8" }
    });
  });

  it("accepts all configurable steps with all fields", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { harness: "gnhf", model: "opus", effort: "high" },
      postflight: { harness: "claude", model: "sonnet", effort: "medium" },
      "no-mistakes": { harness: "codex", model: "gpt", effort: "low" },
      "merge-cleanup": { harness: "script", model: "none", effort: "low" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(Object.keys(result.overrides)).toEqual([
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup"
    ]);
  });

  it("normalizes to canonical step and field order (byte-stable)", () => {
    const result = validateCodingStepRouteOverrides({
      postflight: { effort: "high", harness: "claude" },
      implementation: { model: "opus" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(JSON.stringify(result.overrides)).toBe(
      JSON.stringify({
        implementation: { model: "opus" },
        postflight: { harness: "claude", effort: "high" }
      })
    );
  });

  it("trims field values", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { model: "  opus  " }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides.implementation).toEqual({ model: "opus" });
  });

  it("drops a step whose override object has no recognized fields", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: {},
      postflight: { model: "opus" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({ postflight: { model: "opus" } });
  });

  it("fails closed overrides_invalid when not a plain object", () => {
    for (const bad of [[], "x", 3, true]) {
      const result = validateCodingStepRouteOverrides(bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.refusal).toBe("overrides_invalid");
    }
  });

  it("fails closed step_unsupported for steps outside the configurable set", () => {
    for (const step of ["preflight", "linear-refresh", "bogus"]) {
      const result = validateCodingStepRouteOverrides({
        [step]: { model: "opus" }
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.refusal).toBe("step_unsupported");
    }
  });

  it("fails closed step_config_invalid when a step value is not an object", () => {
    const result = validateCodingStepRouteOverrides({ implementation: "opus" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("step_config_invalid");
  });

  it("fails closed field_unsupported for an unknown field", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { temperature: "hot" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("field_unsupported");
  });

  it("fails closed value_invalid for a non-string field value", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { model: 7 }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("value_invalid");
  });

  it("fails closed value_invalid for a blank field value", () => {
    const result = validateCodingStepRouteOverrides({
      implementation: { model: "   " }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("value_invalid");
  });
});

describe("readCodingStepRouteOverrides — persisted read-back", () => {
  it("treats an absent steps namespace as no overrides", () => {
    const result = readCodingStepRouteOverrides({ profile: "fast" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({});
  });

  it("reads back a valid steps namespace", () => {
    const result = readCodingStepRouteOverrides({
      profile: "fast",
      [CODING_ROUTE_STEPS_KEY]: {
        implementation: { model: "opus" }
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.overrides).toEqual({ implementation: { model: "opus" } });
  });

  it("fails closed when the persisted steps namespace is corrupt", () => {
    const result = readCodingStepRouteOverrides({
      [CODING_ROUTE_STEPS_KEY]: { preflight: { model: "opus" } }
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toBe("step_unsupported");
  });
});

describe("writeCodingStepRouteOverrides — durable embedding", () => {
  it("omits the steps namespace when there are no overrides", () => {
    const route = writeCodingStepRouteOverrides({ profile: "fast" }, {});
    expect(route).toEqual({ profile: "fast" });
    expect(CODING_ROUTE_STEPS_KEY in route).toBe(false);
  });

  it("embeds overrides under the steps namespace, preserving other keys", () => {
    const overrides: CodingStepRouteOverrides = {
      implementation: { model: "opus" }
    };
    const route = writeCodingStepRouteOverrides(
      { profile: "fast", subworkflow: { lineage: {} } },
      overrides
    );
    expect(route.profile).toBe("fast");
    expect(route.subworkflow).toEqual({ lineage: {} });
    expect(route[CODING_ROUTE_STEPS_KEY]).toEqual({
      implementation: { model: "opus" }
    });
  });

  it("does not mutate the input route", () => {
    const input = { profile: "fast" };
    writeCodingStepRouteOverrides(input, {
      implementation: { model: "opus" }
    });
    expect(input).toEqual({ profile: "fast" });
  });

  it("round-trips write -> read", () => {
    const built = validateCodingStepRouteOverrides({
      implementation: { harness: "gnhf", model: "opus" },
      "merge-cleanup": { effort: "low" }
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("expected ok");
    const route = writeCodingStepRouteOverrides({}, built.overrides);
    const read = readCodingStepRouteOverrides(route);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.overrides).toEqual(built.overrides);
  });
});

describe("resolveCodingRouteStepSelections — effective preview projection", () => {
  it("projects every configurable step with default null selections when empty", () => {
    const selections = resolveCodingRouteStepSelections({});
    expect(Object.keys(selections)).toEqual([
      "implementation",
      "postflight",
      "no-mistakes",
      "merge-cleanup"
    ]);
    for (const key of CONFIGURABLE_CODING_STEP_KEYS) {
      expect(selections[key]).toEqual({
        harness: null,
        model: null,
        effort: null
      });
    }
  });

  it("fills overridden fields and defaults the rest to null", () => {
    const selections = resolveCodingRouteStepSelections({
      implementation: { harness: "gnhf", model: "opus" },
      "merge-cleanup": { effort: "low" }
    });
    expect(selections.implementation).toEqual({
      harness: "gnhf",
      model: "opus",
      effort: null
    });
    expect(selections.postflight).toEqual({
      harness: null,
      model: null,
      effort: null
    });
    expect(selections["merge-cleanup"]).toEqual({
      harness: null,
      model: null,
      effort: "low"
    });
  });
});

describe("formatCodingRouteStepSelectionLines - human audit surface", () => {
  it("renders a header and every configurable step with the (default) sentinel when empty", () => {
    const lines = formatCodingRouteStepSelectionLines(
      resolveCodingRouteStepSelections({})
    );
    expect(lines).toEqual([
      "Per-step route:",
      "  implementation: harness=(default), model=(default), effort=(default)",
      "  postflight: harness=(default), model=(default), effort=(default)",
      "  no-mistakes: harness=(default), model=(default), effort=(default)",
      "  merge-cleanup: harness=(default), model=(default), effort=(default)"
    ]);
  });

  it("shows operator values where overridden and (default) elsewhere, in canonical order", () => {
    const lines = formatCodingRouteStepSelectionLines(
      resolveCodingRouteStepSelections({
        "merge-cleanup": { effort: "low" },
        implementation: { harness: "gnhf", model: "opus" }
      })
    );
    expect(lines).toEqual([
      "Per-step route:",
      "  implementation: harness=gnhf, model=opus, effort=(default)",
      "  postflight: harness=(default), model=(default), effort=(default)",
      "  no-mistakes: harness=(default), model=(default), effort=(default)",
      "  merge-cleanup: harness=(default), model=(default), effort=low"
    ]);
  });

  it("is byte-stable across repeated calls for the same selections", () => {
    const overrides: CodingStepRouteOverrides = {
      postflight: { harness: "claude", effort: "high" }
    };
    const first = formatCodingRouteStepSelectionLines(
      resolveCodingRouteStepSelections(overrides)
    );
    const second = formatCodingRouteStepSelectionLines(
      resolveCodingRouteStepSelections(overrides)
    );
    expect(first).toEqual(second);
    expect(first).toContain(
      "  postflight: harness=claude, model=(default), effort=high"
    );
  });
});
