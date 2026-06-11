import { describe, expect, it } from "vitest";

import { WORKFLOW_DISPATCH_RESULT_STATUS } from "../src/workflow-dispatch-execute.js";
import {
  DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR,
  isDogfoodTerminalizeDispatchEnabled,
  resolveDaemonWorkflowDispatch,
  shouldTerminalizeAfterDispatch
} from "../src/workflow-dogfood-dispatch.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatch,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult
} from "../src/workflow-scheduler.js";

describe("shouldTerminalizeAfterDispatch (NGX-391 dogfood safety gate)", () => {
  it("terminalizes a step whose executor scaffold was freshly started", () => {
    expect(
      shouldTerminalizeAfterDispatch(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched)
    ).toBe(true);
  });

  it("terminalizes a re-entered step whose scaffold already existed", () => {
    expect(
      shouldTerminalizeAfterDispatch(
        WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
      )
    ).toBe(true);
  });

  it("never terminalizes a fail-closed step the dispatcher already parked", () => {
    // A fail-closed dispatch flags manual recovery and releases the lease itself;
    // terminalizing it to `succeeded` would mask a parked run — the unsafe move
    // this gate exists to prevent.
    expect(
      shouldTerminalizeAfterDispatch(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed)
    ).toBe(false);
  });

  it("never terminalizes a step that was not startable", () => {
    // The dispatcher already released the lease and wrote nothing durable; there
    // is no running step to terminalize.
    expect(
      shouldTerminalizeAfterDispatch(
        WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable
      )
    ).toBe(false);
  });

  it("never terminalizes an unrecognized dispatch status", () => {
    expect(shouldTerminalizeAfterDispatch("something_unexpected")).toBe(false);
  });
});

describe("isDogfoodTerminalizeDispatchEnabled (NGX-391 opt-in gate)", () => {
  it("is off when the dogfood env var is unset", () => {
    expect(isDogfoodTerminalizeDispatchEnabled({})).toBe(false);
  });

  it.each(["1", "true", "yes", "on", "ON", " True "])(
    "is on for the truthy opt-in value %j",
    (value) => {
      expect(
        isDogfoodTerminalizeDispatchEnabled({
          [DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR]: value
        })
      ).toBe(true);
    }
  );

  it.each(["0", "false", "no", "off", ""])(
    "stays off for the non-truthy value %j",
    (value) => {
      expect(
        isDogfoodTerminalizeDispatchEnabled({
          [DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR]: value
        })
      ).toBe(false);
    }
  );
});

describe("resolveDaemonWorkflowDispatch (NGX-391 daemon-start seam)", () => {
  const baseDispatch: WorkflowStepDispatch = (
    _claim: ClaimedWorkflowStep,
    _context: WorkflowStepDispatchContext
  ): WorkflowStepDispatchResult => ({ status: "base" });

  it("returns the production dispatch unchanged when the dogfood flag is unset", () => {
    // Identity passthrough: an un-opted-in `daemon start` keeps the exact
    // production dispatch reference, so default behavior is provably unchanged.
    expect(resolveDaemonWorkflowDispatch({}, baseDispatch)).toBe(baseDispatch);
  });

  it("wraps the production dispatch when the dogfood flag is set", () => {
    const resolved = resolveDaemonWorkflowDispatch(
      { [DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR]: "1" },
      baseDispatch
    );
    expect(resolved).not.toBe(baseDispatch);
    expect(typeof resolved).toBe("function");
  });
});
