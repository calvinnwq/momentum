import { describe, expect, it } from "vitest";

import { buildIdempotencyMarker } from "../src/adapters/external-update-adapter.js";
import type { IntentApplyAudit } from "../src/core/intent/apply-audits.js";
import type { UpdateIntent } from "../src/core/intent/update-intents.js";
import type { SourceItem } from "../src/core/source/items.js";
import {
  planTrackerRefreshAlreadyAppliedReconciliation,
  planTrackerRefreshLifecycle,
} from "../src/core/workflow/dispatch/tracker-refresh-lifecycle.js";

const ISSUE_SCOPE = "NGX-565";
const SOURCE_ID = "source_565";
const INTENT_ID = "intent_565";
const EXPECTED_OPERATOR_REASON =
  "daemon external-apply for workflow current-run/tracker-refresh";

function source(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: SOURCE_ID,
    adapterKind: "linear",
    externalId: "linear-issue-565",
    externalKey: ISSUE_SCOPE,
    url: "https://linear.app/ngxcalvin/issue/NGX-565",
    title: "Make linear refresh resumable",
    status: "In Progress",
    metadata: {},
    lastObservedAt: 1,
    goalId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function intent(overrides: Partial<UpdateIntent> = {}): UpdateIntent {
  return {
    id: INTENT_ID,
    adapterKind: "linear",
    targetExternalId: "linear-issue-565",
    intentType: "status_update",
    payload: { state: "Done" },
    reason: "workflow complete",
    goalId: null,
    sourceItemId: SOURCE_ID,
    evidenceRecordId: null,
    status: "pending",
    idempotencyKey: "linear:NGX-565:status_update:done",
    decisionReason: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    appliedAt: null,
    skippedAt: null,
    canceledAt: null,
    ...overrides,
  };
}

function audit(
  appliedIntent: UpdateIntent,
  overrides: Partial<IntentApplyAudit> = {},
): IntentApplyAudit {
  return {
    id: "audit_565",
    intentId: appliedIntent.id,
    adapterKind: "linear",
    provider: "linear",
    target: {
      externalId: appliedIntent.targetExternalId,
      externalKey: ISSUE_SCOPE,
      url: "https://linear.app/ngxcalvin/issue/NGX-565",
      title: "Make linear refresh resumable",
    },
    requestedAt: 1,
    finishedAt: 2,
    operatorReason: EXPECTED_OPERATOR_REASON,
    operatorActor: null,
    intentApplyPolicy: "external_apply_allowed",
    allowStatusMutation: true,
    mutationKind: "status_transition",
    previewSummary: "Move NGX-565 to Done",
    idempotencyMarker: buildIdempotencyMarker({
      adapterKind: appliedIntent.adapterKind,
      intentId: appliedIntent.id,
      payload: appliedIntent.payload,
    }),
    lifecycleState: "succeeded",
    resultStatus: "succeeded",
    resultCode: "applied",
    resultMessage: "External write succeeded.",
    externalRefs: {
      commentId: "comment_565",
      commentUrl: "https://linear.app/ngxcalvin/issue/NGX-565#comment",
      stateTransitionId: "transition_565",
    },
    reconcile: { status: "success", warning: null },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function sources(...items: SourceItem[]): ReadonlyMap<string, SourceItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function baseInput(
  overrides: Partial<Parameters<typeof planTrackerRefreshLifecycle>[0]> = {},
) {
  return {
    env: { LINEAR_API_KEY: "lin_secret" },
    intentApplyPolicy: "external_apply_allowed" as const,
    issueScopeIdentifier: ISSUE_SCOPE,
    pendingIntents: [intent()],
    sourceItemsById: sources(source()),
    expectedOperatorReason: EXPECTED_OPERATOR_REASON,
    ...overrides,
  };
}

describe("tracker-refresh lifecycle planner", () => {
  it("fails before mutation when Linear auth is missing", () => {
    expect(planTrackerRefreshLifecycle(baseInput({ env: {} }))).toMatchObject({
      phase: "preflight",
      status: "auth_missing",
      action: "fix_setup_config_then_retry",
      safeToMutate: false,
    });
  });

  it("requires external apply policy before mutation", () => {
    expect(
      planTrackerRefreshLifecycle(
        baseInput({ intentApplyPolicy: "create_intents_only" }),
      ),
    ).toMatchObject({
      phase: "preflight",
      status: "policy_denied",
      safeToMutate: false,
    });
  });

  it("requires exactly one pending intent", () => {
    expect(
      planTrackerRefreshLifecycle(baseInput({ pendingIntents: [] })),
    ).toMatchObject({
      phase: "preflight",
      status: "intent_missing",
      action: "seed_pending_intent_then_retry",
      safeToMutate: false,
    });
    expect(
      planTrackerRefreshLifecycle(
        baseInput({ pendingIntents: [intent(), intent({ id: "intent_2" })] }),
      ),
    ).toMatchObject({
      phase: "preflight",
      status: "intent_duplicate",
      action: "resolve_intent_evidence",
      safeToMutate: false,
    });
  });

  it("ignores pending non-status intents when selecting the refresh status update", () => {
    const plan = planTrackerRefreshLifecycle(
      baseInput({
        pendingIntents: [
          intent({
            id: "intent_source_satisfied",
            intentType: "source_satisfied",
            payload: { kind: "comment" },
          }),
          intent(),
        ],
      }),
    );

    expect(plan).toMatchObject({
      phase: "apply",
      status: "ready",
      action: "apply_external_update",
      safeToMutate: true,
    });
    expect(plan.evidence.intentId).toBe(INTENT_ID);
  });

  it("requires a matching Linear source item", () => {
    expect(
      planTrackerRefreshLifecycle(baseInput({ sourceItemsById: sources() })),
    ).toMatchObject({
      phase: "preflight",
      status: "source_missing",
      action: "resolve_intent_evidence",
      safeToMutate: false,
    });
  });

  it("requires a pending status_update payload with exactly one target state field", () => {
    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          pendingIntents: [intent({ intentType: "source_satisfied" })],
        }),
      ),
    ).toMatchObject({ status: "intent_missing", safeToMutate: false });
    expect(
      planTrackerRefreshLifecycle(
        baseInput({ pendingIntents: [intent({ payload: {} })] }),
      ),
    ).toMatchObject({ status: "payload_invalid", safeToMutate: false });
    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          pendingIntents: [
            intent({ payload: { state: "Done", stateId: "done-id" } }),
          ],
        }),
      ),
    ).toMatchObject({ status: "payload_invalid", safeToMutate: false });
  });

  it("enters apply only when auth, policy, source, intent, marker, and payload are valid", () => {
    const plan = planTrackerRefreshLifecycle(baseInput());

    expect(plan).toMatchObject({
      phase: "apply",
      status: "ready",
      action: "apply_external_update",
      safeToMutate: true,
    });
    expect(plan.evidence).toMatchObject({
      issueScopeIdentifier: ISSUE_SCOPE,
      intentId: INTENT_ID,
      sourceItemId: SOURCE_ID,
      idempotencyKey: "linear:NGX-565:status_update:done",
    });
    expect(plan.evidence.idempotencyMarker).toContain(INTENT_ID);
  });

  it("reconciles already-applied durable audit evidence without mutation", () => {
    const applied = intent({ status: "applied", appliedAt: 2 });
    const plan = planTrackerRefreshLifecycle(
      baseInput({
        pendingIntents: [],
        appliedIntents: [applied],
        latestAuditsByIntentId: new Map([[applied.id, audit(applied)]]),
      }),
    );

    expect(plan).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });
    expect(plan.evidence.auditId).toBe("audit_565");
  });

  it("reconciles matching already-applied audit evidence without current mutation gates", () => {
    const applied = intent({ status: "applied", appliedAt: 2 });
    const appliedEvidence = {
      pendingIntents: [],
      appliedIntents: [applied],
      latestAuditsByIntentId: new Map([[applied.id, audit(applied)]]),
    };

    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          ...appliedEvidence,
          env: {},
        }),
      ),
    ).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });

    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          ...appliedEvidence,
          intentApplyPolicy: "create_intents_only",
        }),
      ),
    ).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });
  });

  it("refuses already-applied evidence from another workflow run", () => {
    const applied = intent({ status: "applied", appliedAt: 2 });
    const input = {
      ...baseInput({
        pendingIntents: [],
        appliedIntents: [applied],
        latestAuditsByIntentId: new Map([
          [
            applied.id,
            audit(applied, {
              // Deliberate legacy seed: an older run's frozen audit reason
              // keeps its pre-rename step id spelling.
              operatorReason:
                "daemon external-apply for workflow old-run/tracker-refresh",
            }),
          ],
        ]),
      }),
      expectedOperatorReason: EXPECTED_OPERATOR_REASON,
    };

    expect(planTrackerRefreshLifecycle(input)).toMatchObject({
      phase: "preflight",
      status: "intent_stale",
      action: "resolve_intent_evidence",
      safeToMutate: false,
    });
  });

  it("refuses stale or mismatched already-applied evidence", () => {
    const applied = intent({ status: "applied", appliedAt: 2 });

    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          pendingIntents: [],
          appliedIntents: [applied],
          latestAuditsByIntentId: new Map([
            [applied.id, audit(applied, { idempotencyMarker: "stale" })],
          ]),
        }),
      ),
    ).toMatchObject({
      phase: "preflight",
      status: "intent_stale",
      action: "resolve_intent_evidence",
      safeToMutate: false,
    });
  });

  it("reconciles the current already-applied status update when older applied history exists", () => {
    const oldApplied = intent({
      id: "intent_old",
      status: "applied",
      appliedAt: 1,
      idempotencyKey: "linear:NGX-565:status_update:old",
      payload: { state: "In Review" },
    });
    const currentApplied = intent({ status: "applied", appliedAt: 2 });
    const plan = planTrackerRefreshLifecycle(
      baseInput({
        pendingIntents: [],
        appliedIntents: [oldApplied, currentApplied],
        latestAuditsByIntentId: new Map([
          [
            oldApplied.id,
            audit(oldApplied, {
              id: "audit_old",
              // Deliberate legacy seed: an older run's frozen audit reason
              // keeps its pre-rename step id spelling.
              operatorReason:
                "daemon external-apply for workflow old-run/tracker-refresh",
            }),
          ],
          [currentApplied.id, audit(currentApplied)],
        ]),
      }),
    );

    expect(plan).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });
    expect(plan.evidence).toMatchObject({
      intentId: INTENT_ID,
      auditId: "audit_565",
    });
  });

  it("reconciles current already-applied audit evidence before stale pending intents", () => {
    const stalePending = intent({
      id: "intent_stale_pending",
      idempotencyKey: "linear:NGX-565:status_update:stale",
      payload: { state: "In Review" },
    });
    const currentApplied = intent({ status: "applied", appliedAt: 2 });
    const appliedEvidence = {
      issueScopeIdentifier: ISSUE_SCOPE,
      pendingIntents: [stalePending],
      appliedIntents: [currentApplied],
      sourceItemsById: sources(source()),
      latestAuditsByIntentId: new Map([
        [currentApplied.id, audit(currentApplied)],
      ]),
      expectedOperatorReason: EXPECTED_OPERATOR_REASON,
    };

    expect(
      planTrackerRefreshAlreadyAppliedReconciliation(appliedEvidence),
    ).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });

    const plan = planTrackerRefreshLifecycle(
      baseInput({
        pendingIntents: [stalePending],
        appliedIntents: [currentApplied],
        latestAuditsByIntentId: new Map([
          [currentApplied.id, audit(currentApplied)],
        ]),
      }),
    );

    expect(plan).toMatchObject({
      phase: "reconcile",
      status: "already_applied",
      action: "reconcile_already_applied",
      safeToMutate: false,
    });
    expect(plan.evidence).toMatchObject({
      intentId: INTENT_ID,
      auditId: "audit_565",
    });
  });

  it("does not reconcile already-applied evidence from non-status intents", () => {
    const applied = intent({
      status: "applied",
      appliedAt: 2,
      intentType: "source_satisfied",
      payload: { kind: "comment" },
    });

    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          pendingIntents: [],
          appliedIntents: [applied],
          latestAuditsByIntentId: new Map([[applied.id, audit(applied)]]),
        }),
      ),
    ).toMatchObject({
      phase: "preflight",
      status: "intent_missing",
      action: "seed_pending_intent_then_retry",
      safeToMutate: false,
    });
  });

  it("refuses status updates whose source item does not match issue scope", () => {
    expect(
      planTrackerRefreshLifecycle(
        baseInput({
          pendingIntents: [intent({ targetExternalId: ISSUE_SCOPE })],
          sourceItemsById: sources(
            source({
              externalId: "linear-issue-other",
              externalKey: "NGX-999",
            }),
          ),
        }),
      ),
    ).toMatchObject({
      phase: "preflight",
      status: "intent_stale",
      action: "resolve_intent_evidence",
      safeToMutate: false,
    });
  });
});
