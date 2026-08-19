import { buildIdempotencyMarker } from "../../../adapters/external-update-adapter.js";
import type { IntentApplyAudit } from "../../intent/apply-audits.js";
import type { Intent } from "../../intent/intents.js";
import type { TrackerItem } from "../../tracker/items.js";
import type { IntentApplyPolicy } from "../../intent/policy.js";

export type TrackerRefreshLifecyclePhase = "preflight" | "apply" | "reconcile";

export type TrackerRefreshLifecycleStatus =
  | "auth_missing"
  | "policy_denied"
  | "issue_scope_missing"
  | "tracker_item_missing"
  | "intent_missing"
  | "intent_duplicate"
  | "intent_stale"
  | "payload_invalid"
  | "already_applied"
  | "ready";

export type TrackerRefreshLifecycleAction =
  | "fix_setup_config_then_retry"
  | "seed_pending_intent_then_retry"
  | "resolve_intent_evidence"
  | "reconcile_already_applied"
  | "apply_external_update";

export type TrackerRefreshLifecyclePlan = {
  phase: TrackerRefreshLifecyclePhase;
  status: TrackerRefreshLifecycleStatus;
  action: TrackerRefreshLifecycleAction;
  safeToMutate: boolean;
  message: string;
  evidence: {
    issueScopeIdentifier: string | null;
    intentId: string | null;
    trackerItemId: string | null;
    targetExternalId: string | null;
    idempotencyKey: string | null;
    idempotencyMarker: string | null;
    auditId: string | null;
  };
};

export type TrackerRefreshLifecycleInput = {
  env: Record<string, string | undefined>;
  intentApplyPolicy: IntentApplyPolicy;
  issueScopeIdentifier?: string | null;
  pendingIntents: readonly Intent[];
  appliedIntents?: readonly Intent[];
  trackerItemsById: ReadonlyMap<string, TrackerItem>;
  latestAuditsByIntentId?: ReadonlyMap<string, IntentApplyAudit>;
  expectedOperatorReason: string | null;
};

export type TrackerRefreshAlreadyAppliedReconciliationInput = Pick<
  TrackerRefreshLifecycleInput,
  | "issueScopeIdentifier"
  | "pendingIntents"
  | "appliedIntents"
  | "trackerItemsById"
  | "latestAuditsByIntentId"
  | "expectedOperatorReason"
>;

export function planTrackerRefreshLifecycle(
  input: TrackerRefreshLifecycleInput,
): TrackerRefreshLifecyclePlan {
  const issueScopeIdentifier = input.issueScopeIdentifier?.trim() || null;
  if (issueScopeIdentifier === null) {
    return plan(
      "preflight",
      "issue_scope_missing",
      "resolve_intent_evidence",
      false,
      evidence(null, null, null, null),
    );
  }

  const currentAppliedPlan = planCurrentAppliedEvidence(
    input,
    issueScopeIdentifier,
  );
  if (currentAppliedPlan !== null) return currentAppliedPlan;

  const pendingStatusIntents =
    input.pendingIntents.filter(isStatusUpdateIntent);

  if (input.intentApplyPolicy !== "external_apply_allowed") {
    return plan(
      "preflight",
      "policy_denied",
      "fix_setup_config_then_retry",
      false,
      evidence(issueScopeIdentifier, null, null, null),
    );
  }
  if (!hasLinearAuth(input.env)) {
    return plan(
      "preflight",
      "auth_missing",
      "fix_setup_config_then_retry",
      false,
      evidence(issueScopeIdentifier, null, null, null),
    );
  }
  if (pendingStatusIntents.length > 1) {
    return plan(
      "preflight",
      "intent_duplicate",
      "resolve_intent_evidence",
      false,
      evidence(
        issueScopeIdentifier,
        pendingStatusIntents[0] ?? null,
        null,
        null,
      ),
    );
  }
  if (pendingStatusIntents.length === 0) {
    return planAlreadyAppliedOrMissing(input, issueScopeIdentifier);
  }

  const intent = pendingStatusIntents[0]!;
  const source = sourceForIntent(input.trackerItemsById, intent);
  const validation = validateIntent(intent, source, issueScopeIdentifier);
  if (!validation.ok) {
    return plan(
      "preflight",
      validation.status,
      validation.action,
      false,
      evidence(issueScopeIdentifier, intent, source, null),
    );
  }

  return plan(
    "apply",
    "ready",
    "apply_external_update",
    true,
    evidence(issueScopeIdentifier, intent, source, idempotencyMarker(intent)),
  );
}

export function planTrackerRefreshAlreadyAppliedReconciliation(
  input: TrackerRefreshAlreadyAppliedReconciliationInput,
): TrackerRefreshLifecyclePlan | null {
  const issueScopeIdentifier = input.issueScopeIdentifier?.trim() || null;
  if (issueScopeIdentifier === null) return null;

  return planCurrentAppliedEvidence(input, issueScopeIdentifier);
}

function planAlreadyAppliedOrMissing(
  input: TrackerRefreshLifecycleInput,
  issueScopeIdentifier: string,
): TrackerRefreshLifecyclePlan {
  const currentAppliedPlan = planCurrentAppliedEvidence(
    input,
    issueScopeIdentifier,
  );
  if (currentAppliedPlan !== null) return currentAppliedPlan;

  const applied = (input.appliedIntents ?? []).filter(isStatusUpdateIntent);
  if (applied.length === 1) {
    const intent = applied[0]!;
    const source = sourceForIntent(input.trackerItemsById, intent);
    const audit = input.latestAuditsByIntentId?.get(intent.id) ?? null;
    const marker = idempotencyMarker(intent);
    const validation = validateAppliedIntent(
      intent,
      source,
      issueScopeIdentifier,
    );
    if (!validation.ok) {
      return plan(
        "preflight",
        validation.status,
        validation.action,
        false,
        evidence(issueScopeIdentifier, intent, source, marker, audit),
      );
    }
    return plan(
      "preflight",
      "intent_stale",
      "resolve_intent_evidence",
      false,
      evidence(issueScopeIdentifier, intent, source, marker, audit),
    );
  }
  if (applied.length > 1) {
    const intent = applied[0]!;
    return plan(
      "preflight",
      "intent_stale",
      "resolve_intent_evidence",
      false,
      evidence(
        issueScopeIdentifier,
        intent,
        sourceForIntent(input.trackerItemsById, intent),
        null,
      ),
    );
  }
  return plan(
    "preflight",
    "intent_missing",
    "seed_pending_intent_then_retry",
    false,
    evidence(issueScopeIdentifier, null, null, null),
  );
}

function planCurrentAppliedEvidence(
  input: TrackerRefreshAlreadyAppliedReconciliationInput,
  issueScopeIdentifier: string,
): TrackerRefreshLifecyclePlan | null {
  const applied = (input.appliedIntents ?? []).filter(isStatusUpdateIntent);
  const currentApplied = applied.flatMap((intent) => {
    const source = sourceForIntent(input.trackerItemsById, intent);
    const audit = input.latestAuditsByIntentId?.get(intent.id) ?? null;
    const marker = idempotencyMarker(intent);
    const validation = validateAppliedIntent(
      intent,
      source,
      issueScopeIdentifier,
    );
    if (
      validation.ok &&
      auditMatchesCurrentRun(audit, marker, input.expectedOperatorReason)
    ) {
      return [{ intent, source, marker, audit }];
    }
    return [];
  });

  if (currentApplied.length === 1) {
    const appliedIntent = currentApplied[0]!;
    return plan(
      "reconcile",
      "already_applied",
      "reconcile_already_applied",
      false,
      evidence(
        issueScopeIdentifier,
        appliedIntent.intent,
        appliedIntent.source,
        appliedIntent.marker,
        appliedIntent.audit,
      ),
    );
  }
  if (currentApplied.length > 1) {
    const appliedIntent = currentApplied[0]!;
    return plan(
      "preflight",
      "intent_duplicate",
      "resolve_intent_evidence",
      false,
      evidence(
        issueScopeIdentifier,
        appliedIntent.intent,
        appliedIntent.source,
        appliedIntent.marker,
        appliedIntent.audit,
      ),
    );
  }
  return null;
}

function validateIntent(
  intent: Intent,
  source: TrackerItem | null,
  issueScopeIdentifier: string,
):
  | { ok: true }
  | {
      ok: false;
      status: "tracker_item_missing" | "intent_stale" | "payload_invalid";
      action: TrackerRefreshLifecycleAction;
    } {
  if (source === null || source.adapterKind !== "linear") {
    return {
      ok: false,
      status: "tracker_item_missing",
      action: "resolve_intent_evidence",
    };
  }
  if (
    intent.adapterKind !== "linear" ||
    intent.status !== "pending" ||
    !sourceMatchesIssueScope(source, issueScopeIdentifier) ||
    !intentTargetMatchesSource(intent, source)
  ) {
    return {
      ok: false,
      status: "intent_stale",
      action: "resolve_intent_evidence",
    };
  }
  if (!statusUpdatePayloadValid(intent.payload)) {
    return {
      ok: false,
      status: "payload_invalid",
      action: "resolve_intent_evidence",
    };
  }
  return { ok: true };
}

function validateAppliedIntent(
  intent: Intent,
  source: TrackerItem | null,
  issueScopeIdentifier: string,
):
  | { ok: true }
  | {
      ok: false;
      status: "tracker_item_missing" | "intent_stale" | "payload_invalid";
      action: TrackerRefreshLifecycleAction;
    } {
  if (source === null || source.adapterKind !== "linear") {
    return {
      ok: false,
      status: "tracker_item_missing",
      action: "resolve_intent_evidence",
    };
  }
  if (
    intent.adapterKind !== "linear" ||
    intent.status !== "applied" ||
    !sourceMatchesIssueScope(source, issueScopeIdentifier) ||
    !intentTargetMatchesSource(intent, source)
  ) {
    return {
      ok: false,
      status: "intent_stale",
      action: "resolve_intent_evidence",
    };
  }
  if (!statusUpdatePayloadValid(intent.payload)) {
    return {
      ok: false,
      status: "payload_invalid",
      action: "resolve_intent_evidence",
    };
  }
  return { ok: true };
}

function isStatusUpdateIntent(intent: Intent): boolean {
  return intent.intentType === "status_update";
}

function sourceMatchesIssueScope(
  source: TrackerItem,
  issueScopeIdentifier: string,
): boolean {
  return (
    source.externalId === issueScopeIdentifier ||
    source.externalKey === issueScopeIdentifier
  );
}

function intentTargetMatchesSource(
  intent: Intent,
  source: TrackerItem,
): boolean {
  return (
    intent.targetExternalId === null ||
    intent.targetExternalId === source.externalId
  );
}

function statusUpdatePayloadValid(payload: Record<string, unknown>): boolean {
  const state = optionalNonEmptyString(payload["state"]);
  const stateId = optionalNonEmptyString(payload["stateId"]);
  return (state === null) !== (stateId === null);
}

function sourceForIntent(
  trackerItemsById: ReadonlyMap<string, TrackerItem>,
  intent: Intent,
): TrackerItem | null {
  if (intent.trackerItemId === null) return null;
  return trackerItemsById.get(intent.trackerItemId) ?? null;
}

function idempotencyMarker(intent: Intent): string {
  return buildIdempotencyMarker({
    adapterKind: intent.adapterKind,
    intentId: intent.id,
    payload: intent.payload,
  });
}

function auditMatchesCurrentRun(
  audit: IntentApplyAudit | null,
  marker: string,
  expectedOperatorReason: string | null,
): audit is IntentApplyAudit {
  return (
    audit !== null &&
    audit.lifecycleState === "succeeded" &&
    audit.idempotencyMarker === marker &&
    audit.operatorReason === expectedOperatorReason &&
    audit.reconcile.status === "success"
  );
}

function hasLinearAuth(env: Record<string, string | undefined>): boolean {
  return (
    typeof env["LINEAR_API_KEY"] === "string" &&
    env["LINEAR_API_KEY"]!.trim().length > 0
  );
}

function evidence(
  issueScopeIdentifier: string | null,
  intent: Intent | null,
  source: TrackerItem | null,
  marker: string | null,
  audit: IntentApplyAudit | null = null,
): TrackerRefreshLifecyclePlan["evidence"] {
  return {
    issueScopeIdentifier,
    intentId: intent?.id ?? null,
    trackerItemId: source?.id ?? intent?.trackerItemId ?? null,
    targetExternalId: intent?.targetExternalId ?? source?.externalId ?? null,
    idempotencyKey: intent?.idempotencyKey ?? null,
    idempotencyMarker: marker,
    auditId: audit?.id ?? null,
  };
}

function plan(
  phase: TrackerRefreshLifecyclePhase,
  status: TrackerRefreshLifecycleStatus,
  action: TrackerRefreshLifecycleAction,
  safeToMutate: boolean,
  evidenceValue: TrackerRefreshLifecyclePlan["evidence"],
): TrackerRefreshLifecyclePlan {
  return {
    phase,
    status,
    action,
    safeToMutate,
    message: `tracker-refresh ${phase} classified ${status}; action=${action}`,
    evidence: evidenceValue,
  };
}

function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
