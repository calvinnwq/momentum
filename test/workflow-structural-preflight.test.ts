import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS,
  preflightCodingWorkflowRouteSteps
} from "../src/core/workflow/preflight/structural.js";

describe("coding workflow structural preflight", () => {
  it("returns normalized route step overrides with compact passed evidence", () => {
    const result = preflightCodingWorkflowRouteSteps({
      implementation: { model: " opus " }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passed preflight");
    expect(result.overrides).toEqual({
      implementation: { model: "opus" }
    });
    expect(result.evidence).toEqual([
      {
        checkId: "route.steps",
        status: "passed",
        severity: "info",
        path: "route.steps",
        key: "steps",
        message: "Coding route steps are structurally valid.",
        recommendedAction: "No action required."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses unsupported route steps with stable compact evidence fields", () => {
    const result = preflightCodingWorkflowRouteSteps({
      "linear-refresh": { model: "opus" }
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed preflight");
    expect(result.evidence).toEqual([
      {
        checkId: "route.steps",
        status: "failed",
        severity: "error",
        path: "route.steps.linear-refresh",
        key: "linear-refresh",
        message:
          'Coding route step "linear-refresh" is not configurable; supported steps: implementation, postflight, no-mistakes, merge-cleanup.',
        recommendedAction:
          "Use route.steps only for implementation, postflight, no-mistakes, or merge-cleanup, or remove the unsupported step key."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });
});
