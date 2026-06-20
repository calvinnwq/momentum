import { describe, expect, it } from "vitest";

import {
  EXECUTE_EXTERNAL_APPLY_ERROR_CODES,
  type ExecuteExternalApplyContext,
  type ExecuteExternalApplyErrorCode,
  type ExecuteExternalApplyExternalResult,
  type ExecuteExternalApplyFailure,
  type ExecuteExternalApplySuccess
} from "../src/core/intent/apply-execute.js";
import type { IntentApplyAudit } from "../src/core/intent/apply-audits.js";
import type { UpdateIntent } from "../src/core/intent/update-intents.js";
import { planDispatchedExecutorTerminalization } from "../src/core/workflow/dispatch-executor-terminalize.js";
import { mapExternalApplyResultToExecutorResult } from "../src/core/workflow/dispatch-external-apply.js";

/**
 * NGX-496 (RC-3) — the pure half of the daemon-dispatchable external-apply
 * adapter: translate an M6 `executeExternalApply` outcome into the
 * `WorkflowStepExecutorDispatchResult` evidence the existing terminalize bridge
 * (`terminalizeDispatchedExecutorInvocation`) consumes, so a dispatched
 * external-apply step can record durable terminal executor evidence the RC-2
 * reconciliation seam finalizes exactly once — reusing the M6 write path rather
 * than inventing a second one.
 *
 * These tests pin the mapping contract: a clean `applied` outcome (including an
 * idempotent already-applied replay) becomes a clean `succeeded` executor result
 * the terminalize decider routes to a clean terminal; EVERY M6 failure code
 * becomes an `ok: false` executor result the decider routes to manual recovery,
 * never a fabricated clean terminal — the fail-closed guarantee for external
 * writes.
 */

const EVIDENCE = {
  executorLogPath: "/tmp/run/external-apply.log",
  resultJsonPath: "/tmp/run/external-apply.json"
} as const;

const IDEMPOTENCY_MARKER = "momentum-apply:intent-001:abc123";

function makeTarget(): ExecuteExternalApplyContext["target"] {
  return {
    adapterKind: "linear",
    externalId: "ext-1",
    externalKey: "NGX-1",
    url: "https://linear.app/ngxcalvin/issue/NGX-1",
    title: "Some issue"
  };
}

function makeContext(
  overrides: Partial<ExecuteExternalApplyContext> = {}
): ExecuteExternalApplyContext {
  return {
    intentId: "intent-001",
    intentStatus: "pending",
    adapterKind: "linear",
    intentType: "status_change",
    target: makeTarget(),
    applyPolicy: { value: "external_apply_allowed", source: "momentum_policy" },
    allowStatusMutation: false,
    mutationKind: "comment",
    auditId: "audit-001",
    reconcile: { status: "pending", warning: null },
    ...overrides
  };
}

function makeExternal(
  overrides: Partial<ExecuteExternalApplyExternalResult> = {}
): ExecuteExternalApplyExternalResult {
  return {
    alreadyApplied: false,
    issueId: "issue-1",
    issueKey: "NGX-1",
    issueUrl: "https://linear.app/ngxcalvin/issue/NGX-1",
    commentId: "comment-1",
    commentUrl: "https://linear.app/ngxcalvin/issue/NGX-1#comment-1",
    statusTransitioned: false,
    nextStateId: null,
    nextStateName: null,
    idempotencyMarker: IDEMPOTENCY_MARKER,
    ...overrides
  };
}

function makeIntent(): UpdateIntent {
  return {
    id: "intent-001",
    adapterKind: "linear",
    targetExternalId: "ext-1",
    intentType: "status_change",
    payload: { kind: "comment" },
    reason: "test intent",
    goalId: null,
    sourceItemId: null,
    evidenceRecordId: null,
    status: "applied",
    idempotencyKey: "idem-1",
    decisionReason: "external_apply: test",
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    appliedAt: 3,
    skippedAt: null,
    canceledAt: null
  };
}

function makeAudit(): IntentApplyAudit {
  return {
    id: "audit-001",
    intentId: "intent-001",
    adapterKind: "linear",
    provider: "linear",
    target: {
      externalId: "ext-1",
      externalKey: "NGX-1",
      url: "https://linear.app/ngxcalvin/issue/NGX-1",
      title: "Some issue"
    },
    requestedAt: 1,
    finishedAt: 2,
    operatorReason: "test intent",
    operatorActor: null,
    intentApplyPolicy: "external_apply_allowed",
    allowStatusMutation: false,
    mutationKind: "comment",
    previewSummary: "comment preview",
    idempotencyMarker: IDEMPOTENCY_MARKER,
    lifecycleState: "succeeded",
    resultStatus: "succeeded",
    resultCode: "applied",
    resultMessage: "External write succeeded.",
    externalRefs: {
      commentId: "comment-1",
      commentUrl: "https://linear.app/ngxcalvin/issue/NGX-1#comment-1",
      stateTransitionId: null
    },
    reconcile: { status: "pending", warning: null },
    createdAt: 1,
    updatedAt: 2
  };
}

function makeSuccess(
  externalOverrides: Partial<ExecuteExternalApplyExternalResult> = {}
): ExecuteExternalApplySuccess {
  return {
    ok: true,
    resultCode: "applied",
    context: makeContext({ intentStatus: "applied" }),
    intent: makeIntent(),
    audit: makeAudit(),
    external: makeExternal(externalOverrides)
  };
}

function makeFailure(
  code: ExecuteExternalApplyErrorCode,
  message = `simulated ${code}`
): ExecuteExternalApplyFailure {
  return {
    ok: false,
    code,
    message,
    context: makeContext(),
    intent: null,
    audit: null,
    external: null
  };
}

describe("mapExternalApplyResultToExecutorResult — pure mapping", () => {
  it("maps a fresh applied outcome to a clean succeeded executor result", () => {
    const mapped = mapExternalApplyResultToExecutorResult(
      makeSuccess(),
      EVIDENCE
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error("expected ok result");
    expect(mapped.result.state).toBe("succeeded");
    expect(mapped.result.errorCode).toBeNull();
    expect(mapped.result.errorMessage).toBeNull();
    expect(mapped.result.retryHint).toBeNull();
    expect(mapped.result.recoveryHint).toBeNull();
    expect(mapped.result.checkpoints).toEqual([]);
    expect(mapped.result.artifacts).toEqual([]);
    // The idempotency marker is the stable digest tying the evidence to the
    // external write.
    expect(mapped.result.resultDigest).toBe(IDEMPOTENCY_MARKER);
    expect(mapped.result.summary).toContain("intent-001");
    expect(mapped.result.summary).toContain("applied");
    expect(mapped.result.summary).not.toContain("already applied");
    expect(mapped.executorLogPath).toBe(EVIDENCE.executorLogPath);
    expect(mapped.resultJsonPath).toBe(EVIDENCE.resultJsonPath);
  });

  it("maps an idempotent already-applied replay to a clean succeeded executor result", () => {
    const mapped = mapExternalApplyResultToExecutorResult(
      makeSuccess({ alreadyApplied: true }),
      EVIDENCE
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error("expected ok result");
    expect(mapped.result.state).toBe("succeeded");
    expect(mapped.result.summary).toContain("already applied");
  });

  it("routes EVERY M6 external-apply failure code to a fail-closed manual-recovery executor result", () => {
    for (const code of EXECUTE_EXTERNAL_APPLY_ERROR_CODES) {
      const mapped = mapExternalApplyResultToExecutorResult(
        makeFailure(code),
        EVIDENCE
      );
      expect(mapped.ok, `failure code ${code} must not map to ok`).toBe(false);
      if (mapped.ok) throw new Error("expected error result");
      // The dispatched-step executor-evidence vocabulary has no per-M6-cause
      // code, so the result carries the manual-recovery executor code; the
      // precise M6 cause is preserved in the operator-facing error text.
      expect(mapped.code).toBe("manual_recovery_required");
      expect(mapped.error).toContain(code);
      expect(mapped.executorLogPath).toBe(EVIDENCE.executorLogPath);
      expect(mapped.resultJsonPath).toBe(EVIDENCE.resultJsonPath);
    }
  });

  it("preserves the operator-facing M6 message on the manual-recovery result", () => {
    const mapped = mapExternalApplyResultToExecutorResult(
      makeFailure("policy_denied", "intent_apply_policy is create_intents_only"),
      EVIDENCE
    );
    if (mapped.ok) throw new Error("expected error result");
    expect(mapped.error).toContain("policy_denied");
    expect(mapped.error).toContain("intent_apply_policy is create_intents_only");
  });
});

describe("mapExternalApplyResultToExecutorResult — composes with the terminalize bridge", () => {
  it("produces evidence the terminalize decider routes to a clean succeeded terminal", () => {
    const mapped = mapExternalApplyResultToExecutorResult(
      makeSuccess(),
      EVIDENCE
    );
    expect(planDispatchedExecutorTerminalization(mapped)).toEqual({
      outcome: "clean_terminal",
      invocationState: "succeeded",
      roundState: "succeeded",
      classification: "complete"
    });
  });

  it("produces evidence the terminalize decider routes to manual recovery for a refused apply", () => {
    const mapped = mapExternalApplyResultToExecutorResult(
      makeFailure("auth_unavailable"),
      EVIDENCE
    );
    const plan = planDispatchedExecutorTerminalization(mapped);
    expect(plan.outcome).toBe("manual_recovery");
    expect(plan.invocationState).toBe("manual_recovery_required");
  });
});
