import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS,
  preflightCodingWorkflowWrapperConfig,
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

  it("returns compact passed evidence for valid wrapper config", () => {
    const result = preflightCodingWorkflowWrapperConfig({
      steps: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", "true"],
          timeout_sec: 30,
          env_allow: ["PATH"],
          result_file: "result.json"
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passed preflight");
    expect(result.config.steps.preflight?.timeoutSec).toBe(30);
    expect(result.evidence).toEqual([
      {
        checkId: "wrapper.config",
        status: "passed",
        severity: "info",
        path: "wrapper.config",
        key: "steps",
        message: "Coding workflow wrapper config is structurally valid.",
        recommendedAction: "No action required."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses camelCase wrapper config drift with stable corrective evidence", () => {
    const result = preflightCodingWorkflowWrapperConfig({
      steps: {
        preflight: {
          command: "/bin/sh",
          envAllow: ["PATH"]
        }
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed preflight");
    expect(result.evidence).toEqual([
      {
        checkId: "wrapper.config",
        status: "failed",
        severity: "error",
        path: "wrapper.config.steps.preflight.envAllow",
        key: "envAllow",
        message:
          'Unknown key "envAllow" in steps.preflight; replace with "env_allow" to use the required snake_case schema at this config file.',
        recommendedAction: 'Replace "envAllow" with "env_allow".'
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });
});
