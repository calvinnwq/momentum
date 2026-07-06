import type { IntentApplyAudit } from "../core/intent/apply-audits.js";
import type { IntentApplyAuditSummary } from "../core/intent/apply-audits.js";
import type { PolicyEffectiveFieldSource, UpdateIntentApplyPolicy } from "../core/intent/policy.js";
import type { UpdateIntent, UpdateIntentStatus } from "../core/intent/update-intents.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

export type IntentCommand =
  | "intent list"
  | "intent get"
  | "intent apply"
  | "intent skip"
  | "intent cancel";

export type IntentApplyPolicySummary = {
  effective: UpdateIntentApplyPolicy;
  source: PolicyEffectiveFieldSource;
  externalApplyRequested: boolean;
  externalApplyPerformed: boolean;
  note: string;
};

export type IntentExternalApplySummary = {
  adapterKind: string;
  intentType: string;
  target: {
    adapterKind: string;
    externalId: string | null;
    externalKey: string | null;
    url: string | null;
    title: string | null;
  };
  allowStatusMutation: boolean;
  mutationKind: string | null;
  auditId: string | null;
  reconcile: {
    status: string | null;
    warning: string | null;
  };
  external: {
    alreadyApplied: boolean;
    issueId: string | null;
    issueKey: string | null;
    issueUrl: string | null;
    commentId: string | null;
    commentUrl: string | null;
    statusTransitioned: boolean;
    nextStateId: string | null;
    nextStateName: string | null;
    idempotencyMarker: string;
  } | null;
};

export type IntentFailure = {
  command: IntentCommand;
  code: string;
  message: string;
  dataDir?: string;
  intentId?: string;
  goalId?: string;
  sourceItemId?: string;
  evidenceRecordId?: string;
  status?: string;
  currentStatus?: UpdateIntentStatus;
  applyPolicy?: IntentApplyPolicySummary;
  externalApply?: IntentExternalApplySummary;
};

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

export type IntentApplyAuditJsonShape = ReturnType<typeof intentApplyAuditToJsonShape>;

export function intentApplyAuditToJsonShape(
  audit: IntentApplyAudit
): {
  id: string;
  adapterKind: string;
  provider: string;
  target: IntentApplyAudit["target"];
  requestedAt: number;
  finishedAt: number | null;
  operatorReason: string;
  operatorActor: string | null;
  intentApplyPolicy: IntentApplyAudit["intentApplyPolicy"];
  allowStatusMutation: boolean;
  mutationKind: IntentApplyAudit["mutationKind"];
  previewSummary: string;
  idempotencyMarker: string;
  lifecycleState: IntentApplyAudit["lifecycleState"];
  resultStatus: IntentApplyAudit["resultStatus"];
  resultCode: string | null;
  resultMessage: string | null;
  externalRefs: IntentApplyAudit["externalRefs"];
  reconcile: IntentApplyAudit["reconcile"];
  createdAt: number;
  updatedAt: number;
} {
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

export type IntentApplyAuditSummaryJsonShape = {
  intentId: string;
  applyState: IntentApplyAuditSummary["applyState"];
  totalAttempts: number;
  counts: IntentApplyAuditSummary["counts"];
  latestAttempt: IntentApplyAuditJsonShape | null;
};

export function intentApplyAuditSummaryToJsonShape(
  summary: IntentApplyAuditSummary | null
): IntentApplyAuditSummaryJsonShape {
  if (!summary) {
    return {
      intentId: "",
      applyState: "idle",
      totalAttempts: 0,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      latestAttempt: null
    };
  }
  return {
    intentId: summary.intentId,
    applyState: summary.applyState,
    totalAttempts: summary.totalAttempts,
    counts: summary.counts,
    latestAttempt: summary.latestAttempt
      ? intentApplyAuditToJsonShape(summary.latestAttempt)
      : null
  };
}

export function renderExternalApplyTextLines(
  external: IntentApplyAuditSummaryJsonShape
): string[] {
  const counts = external.counts;
  const lines: string[] = [
    `External apply state: ${external.applyState}`,
    `External apply attempts: total=${external.totalAttempts} ` +
      `succeeded=${counts.succeeded} failed=${counts.failed} ` +
      `claimed=${counts.claimed} blocked=${counts.blocked} ` +
      `audit_incomplete=${counts.audit_incomplete}`
  ];
  const latest = external.latestAttempt;
  if (!latest) {
    lines.push("External apply latest attempt: (none)");
    return lines;
  }
  lines.push(
    `External apply latest attempt: ${latest.id} ${latest.lifecycleState}` +
      ` (result=${latest.resultStatus ?? "(none)"}` +
      ` code=${latest.resultCode ?? "(none)"})`
  );
  lines.push(
    `External apply latest target: ${latest.adapterKind}/` +
      `${latest.target.externalKey ?? "(none)"}` +
      ` (${latest.target.externalId ?? "(none)"})`
  );
  const refs = latest.externalRefs;
  if (refs.commentId || refs.commentUrl || refs.stateTransitionId) {
    lines.push(
      `External apply refs: comment=${refs.commentId ?? "(none)"}` +
        ` url=${refs.commentUrl ?? "(none)"}` +
        ` transition=${refs.stateTransitionId ?? "(none)"}`
    );
  }
  return lines;
}

export function emitIntentListSuccess(
  parsed: { json: boolean },
  io: CliIo,
  input: {
    dataDir: string;
    statusFilter: string | null;
    filters: {
      adapterKind?: string;
      intentType?: string;
      goalId?: string | null;
      sourceItemId?: string | null;
      evidenceRecordId?: string | null;
      limit?: number;
    };
    intents: readonly UpdateIntent[];
    auditSummaries: ReadonlyMap<string, IntentApplyAuditSummary | null>;
    totalAvailable: number;
    truncated: boolean;
  }
): number {
  const {
    dataDir,
    statusFilter,
    filters,
    intents,
    auditSummaries,
    totalAvailable,
    truncated
  } = input;
  const payload = {
    ok: true,
    command: "intent list",
    dataDir,
    status: statusFilter,
    adapter: filters.adapterKind ?? null,
    intentType: filters.intentType ?? null,
    goalId: filters.goalId ?? null,
    sourceItemId: filters.sourceItemId ?? null,
    evidenceRecordId: filters.evidenceRecordId ?? null,
    limit: filters.limit ?? null,
    count: intents.length,
    totalAvailable,
    truncated,
    intents: intents.map((record) => ({
      ...updateIntentToJsonShape(record),
      externalApply: intentApplyAuditSummaryToJsonShape(
        auditSummaries.get(record.id) ?? null
      )
    }))
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intents: ${intents.length}`,
    `Total available: ${totalAvailable}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    `Status: ${statusFilter ?? "(any)"}`,
    `Adapter: ${filters.adapterKind ?? "(any)"}`,
    `Intent type: ${filters.intentType ?? "(any)"}`,
    `Goal: ${filters.goalId ?? "(any)"}`,
    `Source item: ${filters.sourceItemId ?? "(any)"}`,
    `Evidence record: ${filters.evidenceRecordId ?? "(any)"}`,
    `Data dir: ${dataDir}`,
    ...intents.map((record) => {
      const summary = auditSummaries.get(record.id) ?? null;
      const applyState = summary?.applyState ?? "idle";
      const totalAttempts = summary?.totalAttempts ?? 0;
      const latest = summary?.latestAttempt;
      const latestLabel = latest
        ? `${latest.lifecycleState}${latest.resultCode ? `/${latest.resultCode}` : ""}`
        : "(none)";
      return (
        `- ${record.id} [${record.adapterKind}/${record.intentType}] ` +
        `${record.status} target=${record.targetExternalId ?? "(none)"} ` +
        `apply=${applyState} attempts=${totalAttempts} latest=${latestLabel}: ` +
        `${record.reason}`
      );
    }),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitIntentGetSuccess(
  parsed: { json: boolean },
  io: CliIo,
  input: {
    dataDir: string;
    record: UpdateIntent;
    auditSummary: IntentApplyAuditSummary | null;
  }
): number {
  const { dataDir, record } = input;
  const externalApply = intentApplyAuditSummaryToJsonShape(input.auditSummary);
  const payload = {
    ok: true,
    command: "intent get",
    dataDir,
    intent: updateIntentToJsonShape(record),
    externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intent: ${record.id}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Status: ${record.status}`,
    `Goal: ${record.goalId ?? "(unlinked)"}`,
    `Source item: ${record.sourceItemId ?? "(unlinked)"}`,
    `Evidence record: ${record.evidenceRecordId ?? "(unlinked)"}`,
    `Idempotency key: ${record.idempotencyKey}`,
    `Reason: ${record.reason}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Created at: ${record.createdAt}`,
    `Updated at: ${record.updatedAt}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    ...renderExternalApplyTextLines(externalApply),
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitIntentDecisionSuccess(
  parsed: { json: boolean },
  io: CliIo,
  input: {
    command: IntentCommand;
    dataDir: string;
    previousStatus: UpdateIntentStatus;
    record: UpdateIntent;
    applyPolicy?: IntentApplyPolicySummary;
  }
): number {
  const payload: Record<string, unknown> = {
    ok: true,
    command: input.command,
    dataDir: input.dataDir,
    previousStatus: input.previousStatus,
    intent: updateIntentToJsonShape(input.record)
  };
  if (input.applyPolicy !== undefined) {
    payload["applyPolicy"] = input.applyPolicy;
  }

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = input.record;
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Previous status: ${input.previousStatus}`,
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${input.dataDir}`
  ];
  if (input.applyPolicy !== undefined) {
    lines.push(
      `Apply policy: ${input.applyPolicy.effective} (${input.applyPolicy.source}); ${input.applyPolicy.note}`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitIntentExternalApplySuccess(
  parsed: { json: boolean },
  io: CliIo,
  input: {
    dataDir: string;
    record: UpdateIntent;
    applyPolicy: IntentApplyPolicySummary;
    externalApply: IntentExternalApplySummary;
  }
): number {
  const payload = {
    ok: true,
    command: "intent apply",
    dataDir: input.dataDir,
    previousStatus: "pending",
    intent: updateIntentToJsonShape(input.record),
    applyPolicy: input.applyPolicy,
    externalApply: input.externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = input.record;
  const target = input.externalApply.target;
  const externalApplyStatus = input.applyPolicy.externalApplyPerformed
    ? "performed"
    : "already present";
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    "Previous status: pending",
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${input.dataDir}`,
    `Apply policy: ${input.applyPolicy.effective} (${input.applyPolicy.source}); ${input.applyPolicy.note}`,
    `External apply: ${externalApplyStatus} (audit ${input.externalApply.auditId ?? "(none)"})`,
    `Target: ${target.adapterKind} ${target.externalKey ?? target.externalId ?? "(unknown)"}${target.url ? ` <${target.url}>` : ""}`
  ];
  if (input.externalApply.external) {
    const ext = input.externalApply.external;
    lines.push(
      `Comment: ${ext.commentId ?? "(none)"}${ext.commentUrl ? ` <${ext.commentUrl}>` : ""}${ext.alreadyApplied ? " (replay)" : ""}`
    );
    if (ext.statusTransitioned) {
      lines.push(
        `Status transition: ${ext.nextStateName ?? ext.nextStateId ?? "(unknown)"}`
      );
    }
    lines.push(`Idempotency marker: ${ext.idempotencyMarker}`);
  }
  if (input.externalApply.reconcile.status) {
    lines.push(
      `Reconcile: ${input.externalApply.reconcile.status}${
        input.externalApply.reconcile.warning
          ? ` (${input.externalApply.reconcile.warning})`
          : ""
      }`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitIntentFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: IntentFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.intentId !== undefined) payload["intentId"] = failure.intentId;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.evidenceRecordId !== undefined) {
    payload["evidenceRecordId"] = failure.evidenceRecordId;
  }
  if (failure.status !== undefined) payload["status"] = failure.status;
  if (failure.currentStatus !== undefined) {
    payload["currentStatus"] = failure.currentStatus;
  }
  if (failure.applyPolicy !== undefined) {
    payload["applyPolicy"] = failure.applyPolicy;
  }
  if (failure.externalApply !== undefined) {
    payload["externalApply"] = failure.externalApply;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}
