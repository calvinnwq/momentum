import type { IntentApplyAudit } from "../intent-apply-audits.js";
import type { UpdateIntent } from "../update-intents.js";

export function updateIntentToJsonShape(record: UpdateIntent): Record<string, unknown> {
  return {
    id: record.id,
    adapterKind: record.adapterKind,
    targetExternalId: record.targetExternalId,
    intentType: record.intentType,
    payload: record.payload,
    reason: record.reason,
    goalId: record.goalId,
    sourceItemId: record.sourceItemId,
    evidenceRecordId: record.evidenceRecordId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    decisionReason: record.decisionReason,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt,
    skippedAt: record.skippedAt,
    canceledAt: record.canceledAt
  };
}

export function intentApplyAuditToJsonShape(
  audit: IntentApplyAudit
): Record<string, unknown> {
  return {
    id: audit.id,
    adapterKind: audit.adapterKind,
    provider: audit.provider,
    target: audit.target,
    requestedAt: audit.requestedAt,
    finishedAt: audit.finishedAt,
    operatorReason: audit.operatorReason,
    operatorActor: audit.operatorActor,
    intentApplyPolicy: audit.intentApplyPolicy,
    allowStatusMutation: audit.allowStatusMutation,
    mutationKind: audit.mutationKind,
    previewSummary: audit.previewSummary,
    idempotencyMarker: audit.idempotencyMarker,
    lifecycleState: audit.lifecycleState,
    resultStatus: audit.resultStatus,
    resultCode: audit.resultCode,
    resultMessage: audit.resultMessage,
    externalRefs: audit.externalRefs,
    reconcile: audit.reconcile,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt
  };
}
