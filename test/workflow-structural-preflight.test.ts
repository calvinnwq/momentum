import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS,
  preflightCodingWorkflowBuiltInDefinition,
  preflightCodingWorkflowRouteProfile,
  preflightCodingWorkflowRunStartInput,
  preflightCodingWorkflowWrapperConfig,
  preflightCodingWorkflowRouteSteps
} from "../src/core/workflow/preflight/structural.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";

describe("coding workflow structural preflight", () => {
  it("resolves the built-in coding workflow definition with compact passed evidence", () => {
    const result = preflightCodingWorkflowBuiltInDefinition(
      "coding-workflow",
      1
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passed preflight");
    expect(result.definition).toBe(CODING_WORKFLOW_DEFINITION);
    expect(result.evidence).toEqual([
      {
        checkId: "workflow.definition",
        status: "passed",
        severity: "info",
        path: "workflow.definition",
        key: "definition",
        message: "Built-in coding workflow definition resolved.",
        recommendedAction: "No action required."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses missing built-in coding workflow versions with compact evidence", () => {
    const result = preflightCodingWorkflowBuiltInDefinition(
      "coding-workflow",
      99
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed preflight");
    expect(result.evidence).toEqual([
      {
        checkId: "workflow.definition",
        status: "failed",
        severity: "error",
        path: "workflow.definition.version",
        key: "definitionVersion",
        message: "Built-in coding workflow definition version was not found.",
        recommendedAction:
          "Use the supported built-in coding workflow definition key and version."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

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

  it("returns compact passed evidence for valid route profiles", () => {
    const result = preflightCodingWorkflowRouteProfile(" live-wrapper ");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passed preflight");
    expect(result.profile).toBe("live-wrapper");
    expect(result.evidence).toEqual([
      {
        checkId: "route.profile",
        status: "passed",
        severity: "info",
        path: "route.profile",
        key: "profile",
        message: "Coding route profile is structurally valid.",
        recommendedAction: "No action required."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses blank route profiles with stable compact evidence fields", () => {
    const result = preflightCodingWorkflowRouteProfile("   ");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed preflight");
    expect(result.evidence).toEqual([
      {
        checkId: "route.profile",
        status: "failed",
        severity: "error",
        path: "route.profile",
        key: "profile",
        message: "Coding route profile must be a non-empty string when provided.",
        recommendedAction:
          "Set route.profile to a non-empty runtime/profile name, or remove --profile to use the default route."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses invalid approval boundaries with compact run-shape evidence", () => {
    const result = preflightCodingWorkflowRunStartInput({
      definition: CODING_WORKFLOW_DEFINITION,
      runId: "run-shape-invalid-approval",
      repoPath: "/tmp/momentum-repo",
      objective: "Validate the structural run shape",
      now: 123,
      approvalBoundary: "through-linear-refresh"
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed preflight");
    expect(result.evidence).toEqual([
      {
        checkId: "workflow.run_shape",
        status: "failed",
        severity: "error",
        path: "approvalBoundary",
        key: "approvalBoundary",
        message: "Approval boundary is not a known workflow approval boundary.",
        recommendedAction:
          "Set approvalBoundary to a supported workflow approval boundary or omit it for manual approval."
      }
    ]);
    const evidence = result.evidence[0];
    if (evidence === undefined) throw new Error("expected preflight evidence");
    expect(Object.keys(evidence)).toEqual(STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS);
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

  it("refuses malformed env allowlists with field-level corrective evidence", () => {
    const result = preflightCodingWorkflowWrapperConfig({
      steps: {
        preflight: {
          command: "/bin/sh",
          env_allow: "PATH"
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
        path: "wrapper.config.steps.preflight.env_allow",
        key: "env_allow",
        message: "Wrapper config `env_allow` must be an array of strings.",
        recommendedAction:
          "Set wrapper.config.steps.preflight.env_allow to an array of environment variable names."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses unsafe result files with field-level corrective evidence", () => {
    const result = preflightCodingWorkflowWrapperConfig({
      steps: {
        preflight: {
          command: "/bin/sh",
          result_file: "../result.json"
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
        path: "wrapper.config.steps.preflight.result_file",
        key: "result_file",
        message:
          "Wrapper config `result_file` must be a relative path inside the iteration artifact directory.",
        recommendedAction:
          "Set wrapper.config.steps.preflight.result_file to a safe relative path inside the iteration artifact directory."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });

  it("refuses invalid timeout fields with field-level corrective evidence", () => {
    const result = preflightCodingWorkflowWrapperConfig({
      steps: {
        preflight: {
          command: "/bin/sh",
          timeout_sec: 0
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
        path: "wrapper.config.steps.preflight.timeout_sec",
        key: "timeout_sec",
        message: "Wrapper config `timeout_sec` must be a positive integer.",
        recommendedAction:
          "Set wrapper.config.steps.preflight.timeout_sec to a positive integer number of seconds."
      }
    ]);
    expect(Object.keys(result.evidence[0])).toEqual(
      STRUCTURAL_PREFLIGHT_EVIDENCE_FIELDS
    );
  });
});
