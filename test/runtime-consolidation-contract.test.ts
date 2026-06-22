import { describe, expect, it } from "vitest";

import { planWorkflowStepReconciliation } from "../src/core/workflow/dispatch-reconcile.js";
import {
  PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES,
  WORKFLOW_DISPATCH_FAIL_CLOSED_CODES,
  planWorkflowStepDispatch
} from "../src/core/workflow/dispatch.js";
import { expectSpecSection, readRepoFile } from "./helpers/repo-docs.js";

describe("runtime consolidation contract", () => {
  const spec = readRepoFile("SPEC.md");

  it("keeps a compact runtime consolidation anchor", () => {
    expectSpecSection(spec, "Runtime Consolidation");
    expect(spec).toContain("RC-2");
    expect(spec).toContain("RC-4b");
  });

  it("pins the phase-1 dispatchable families in code", () => {
    expect([...PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES]).toEqual([
      "goal-loop",
      "one-shot",
      "script",
      "no-mistakes",
      "external-apply",
      "subworkflow",
    ]);
    expect([...WORKFLOW_DISPATCH_FAIL_CLOSED_CODES]).toEqual([
      "workflow_run_not_found",
      "workflow_definition_unlinked",
      "step_definition_not_found",
      "unknown_executor_family",
      "unsupported_executor_family",
    ]);
  });

  it("keeps unsupported or unresolved dispatch fail-closed", () => {
    expect(
      planWorkflowStepDispatch({
        ok: false,
        failure: "definition_unlinked",
      })
    ).toMatchObject({
      action: "fail_closed",
      code: "workflow_definition_unlinked",
      gateType: "manual_recovery_required",
    });
    expect(planWorkflowStepDispatch({ ok: true, executorFamily: "subworkflow" })).toEqual({
      action: "dispatch",
      executorFamily: "subworkflow",
    });
  });

  it("keeps RC-2 reconciliation as the finalization decision seam", () => {
    expect(planWorkflowStepReconciliation("running")).toEqual({
      action: "not_terminal",
    });
    expect(planWorkflowStepReconciliation("succeeded")).toMatchObject({
      action: "finalize",
      stepState: "succeeded",
    });
    expect(planWorkflowStepReconciliation("manual_recovery_required")).toMatchObject({
      action: "manual_recovery",
      invocationState: "manual_recovery_required",
    });
  });

  it("keeps runtime-consolidation guidance out of the public docs front door", () => {
    expect(readRepoFile("README.md")).not.toMatch(/runtime-consolidation|RC-2|RC-4b/);
    expect(readRepoFile("docs/index.md")).not.toMatch(/runtime-consolidation|RC-2|RC-4b/);
  });
});
