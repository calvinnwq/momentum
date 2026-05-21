/**
 * Two-phase external apply orchestrator (NGX-298 / M6-04 + NGX-300 / M6-05).
 *
 * Glues the NGX-296 adapter, NGX-297 Linear write client, NGX-299 audit
 * ledger, and NGX-300 post-apply reconcile into a single CLI-callable entry point. The orchestrator is pure: it
 * accepts dependencies for the adapter registry, policy loader, Linear client
 * factory, and clock so tests can drive every branch without touching the
 * network. The CLI wires this into `intent apply --external-apply` separately.
 *
 * Flow:
 *   1. Validate input and load the pending intent.
 *   2. Refuse when no repo context, when MOMENTUM.md fails to load, or when
 *      the effective `intent_apply_policy` is not `external_apply_allowed`.
 *   3. Resolve adapter and intent-type support; resolve source/evidence context
 *      and the external target reference.
 *   4. Refuse when the adapter's credential env var is missing.
 *   5. Render the adapter preview (idempotency marker + comment body).
 *   6. Claim the per-intent audit row (CAS guard transitions apply_state
 *      idle → in_flight). Concurrent claims receive `intent_apply_in_progress`
 *      and never call the external write path.
 *   7. Apply through the adapter-specific external write client.
 *   8. Finalize the audit (`succeeded` releases the intent back to idle and
 *      then marks the intent applied; `failed` releases the intent and the
 *      caller surfaces the failure code).
 *   9. After a successful finalize, run the targeted single-issue reconcile and
 *      persist its outcome on the audit row.
 *  10. If audit finalize cannot complete, including after a refused write or
 *      thrown client error, the orchestrator finalizes as `audit_incomplete`
 *      so the intent moves to `blocked` apply_state and another mutation
 *      cannot run before operator recovery clears the block.
 */

import {
  claimIntentApply as claimIntentApplyFn,
  finalizeIntentApply as finalizeIntentApplyFn,
  markIntentApplyAuditIncomplete as markIntentApplyAuditIncompleteFn,
  updateIntentApplyAuditReconcile as updateIntentApplyAuditReconcileFn,
  type ClaimIntentApplyInput,
  type ClaimIntentApplyResult,
  type FinalizeIntentApplyInput,
  type FinalizeIntentApplyResult,
  type IntentApplyAudit,
  type IntentApplyAuditReconcile,
  type UpdateIntentApplyAuditReconcileInput,
  type UpdateIntentApplyAuditReconcileResult
} from "./intent-apply-audits.js";
import type { MomentumDb } from "./db.js";
import {
  getExternalUpdateAdapter,
  previewExternalUpdate as previewExternalUpdateFn,
  resolveExternalUpdateAdapterForIntent,
  type ExternalUpdateAdapter,
  type ExternalUpdateAdapterError,
  type ExternalUpdateAdapterInput,
  type ExternalUpdateAdapterPreview,
  type ExternalUpdateAdapterPreviewResult,
  type ExternalUpdateAdapterTarget,
  type ExternalUpdateMutationKind
} from "./external-update-adapter.js";
import { getEvidenceRecordById } from "./evidence-records.js";
import {
  buildLinearExternalUpdateClient,
  type LinearExternalUpdateClient,
  type LinearExternalUpdateError,
  type LinearExternalUpdateInput,
  type LinearExternalUpdateResult,
  type LinearExternalUpdateResultCode,
  type LinearStatusMutationConfig
} from "./linear-external-update-client.js";
import {
  buildLinearIssueRefreshClient,
  type LinearIssueRefreshClient
} from "./linear-issue-refresh.js";
import {
  DEFAULT_INTENT_APPLY_POLICY,
  loadMomentumPolicy as loadMomentumPolicyFn,
  resolveIntentApplyPolicy,
  type MomentumPolicyLoadResult,
  type PolicyEffectiveFieldSource,
  type UpdateIntentApplyPolicy
} from "./momentum-policy.js";
import { getSourceItemById } from "./source-items.js";
import {
  reconcileAfterExternalApply,
  type PostApplyReconcileOutcomeCode
} from "./post-apply-reconcile.js";
import {
  getUpdateIntentById,
  markUpdateIntentApplied as markUpdateIntentAppliedFn,
  type UpdateIntent,
  type UpdateIntentDecisionResult
} from "./update-intents.js";

export const LINEAR_API_KEY_ENV_VAR = "LINEAR_API_KEY";

/**
 * Optional test/dev escape hatch: when set, the default Linear external-update
 * client points at this endpoint instead of the production GraphQL host. The
 * built-CLI smoke tests use this to redirect external apply at a local mock
 * endpoint without weakening the production default. Operator workflows should
 * never set this in normal use.
 */
export const LINEAR_EXTERNAL_UPDATE_ENDPOINT_ENV_VAR =
  "MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT";

/**
 * Optional test/dev escape hatch: when set, the default Linear single-issue
 * refresh client used by post-apply reconciliation points at this endpoint
 * instead of the production GraphQL host. The built-CLI smoke tests use this
 * to redirect the post-apply reconcile fetch at the same local mock endpoint.
 */
export const LINEAR_REFRESH_ENDPOINT_ENV_VAR =
  "MOMENTUM_LINEAR_REFRESH_ENDPOINT";

export const EXECUTE_EXTERNAL_APPLY_ERROR_CODES = Object.freeze([
  "intent_not_found",
  "intent_already_terminal",
  "intent_apply_in_progress",
  "intent_blocked",
  "policy_denied",
  "policy_load_failed",
  "unsupported_adapter",
  "unsupported_intent_type",
  "target_missing",
  "auth_unavailable",
  "preview_failed",
  "external_conflict",
  "write_rejected",
  "write_timeout",
  "malformed_response",
  "validation_failed",
  "adapter_threw",
  "audit_incomplete"
] as const);

export type ExecuteExternalApplyErrorCode =
  (typeof EXECUTE_EXTERNAL_APPLY_ERROR_CODES)[number];

export type ExecuteExternalApplyEnv = Record<string, string | undefined>;

export type ExecuteExternalApplyDeps = {
  adapters?: ReadonlyMap<string, ExternalUpdateAdapter>;
  loadPolicy?: (repoPath: string) => MomentumPolicyLoadResult;
  buildLinearClient?: (
    env: ExecuteExternalApplyEnv
  ) => LinearExternalUpdateClient;
  buildLinearRefreshClient?: (
    env: ExecuteExternalApplyEnv
  ) => LinearIssueRefreshClient | null;
  claimIntentApply?: (
    db: MomentumDb,
    input: ClaimIntentApplyInput
  ) => ClaimIntentApplyResult;
  finalizeIntentApply?: (
    db: MomentumDb,
    input: FinalizeIntentApplyInput
  ) => FinalizeIntentApplyResult;
  updateIntentApplyAuditReconcile?: (
    db: MomentumDb,
    input: UpdateIntentApplyAuditReconcileInput
  ) => UpdateIntentApplyAuditReconcileResult;
  previewExternalUpdate?: (
    input: ExternalUpdateAdapterInput,
    options: { adapters?: ReadonlyMap<string, ExternalUpdateAdapter> }
  ) => ExternalUpdateAdapterPreviewResult;
  markUpdateIntentApplied?: (
    db: MomentumDb,
    input: { intentId: string; decisionReason: string; now?: number }
  ) => UpdateIntentDecisionResult;
  now?: () => number;
};

export type ExecuteExternalApplyInput = {
  db: MomentumDb;
  intentId: string;
  operatorReason: string;
  operatorActor?: string | null;
  repoPath?: string | null;
  env?: ExecuteExternalApplyEnv;
  statusMutation?: LinearStatusMutationConfig | null;
  deps?: ExecuteExternalApplyDeps;
};

export type ExecuteExternalApplyResolvedPolicy = {
  value: UpdateIntentApplyPolicy;
  source: PolicyEffectiveFieldSource | "missing_repo";
};

export type ExecuteExternalApplyTarget = {
  adapterKind: string;
  externalId: string | null;
  externalKey: string | null;
  url: string | null;
  title: string | null;
};

export type ExecuteExternalApplyReconcile = {
  status: "pending" | "deferred" | PostApplyReconcileOutcomeCode | null;
  warning: string | null;
};

export type ExecuteExternalApplyContext = {
  intentId: string;
  intentStatus: UpdateIntent["status"];
  adapterKind: string;
  intentType: string;
  target: ExecuteExternalApplyTarget;
  applyPolicy: ExecuteExternalApplyResolvedPolicy;
  allowStatusMutation: boolean;
  mutationKind: ExternalUpdateMutationKind | null;
  auditId: string | null;
  reconcile: ExecuteExternalApplyReconcile;
};

export type ExecuteExternalApplyExternalResult = {
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
};

export type ExecuteExternalApplySuccess = {
  ok: true;
  resultCode: "applied";
  context: ExecuteExternalApplyContext;
  intent: UpdateIntent;
  audit: IntentApplyAudit;
  external: ExecuteExternalApplyExternalResult;
};

export type ExecuteExternalApplyFailure = {
  ok: false;
  code: ExecuteExternalApplyErrorCode;
  message: string;
  context: ExecuteExternalApplyContext;
  intent: UpdateIntent | null;
  audit: IntentApplyAudit | null;
  external: ExecuteExternalApplyExternalResult | null;
};

export type ExecuteExternalApplyResult =
  | ExecuteExternalApplySuccess
  | ExecuteExternalApplyFailure;

/**
 * Execute the two-phase external apply path for a single pending intent.
 * Returns a structured success or failure result; never throws for predictable
 * branches. The `context` block is always populated so CLI surfaces can render
 * apply policy, adapter, target reference, audit id, and reconcile status even
 * when the call refuses early.
 */
export async function executeExternalApply(
  input: ExecuteExternalApplyInput
): Promise<ExecuteExternalApplyResult> {
  const deps = input.deps ?? {};
  const env = input.env ?? {};
  const now = deps.now ?? (() => Date.now());
  const claimFn = deps.claimIntentApply ?? claimIntentApplyFn;
  const finalizeFn = deps.finalizeIntentApply ?? finalizeIntentApplyFn;
  const previewFn = deps.previewExternalUpdate ?? previewExternalUpdateFn;
  const markAppliedFn =
    deps.markUpdateIntentApplied ?? markUpdateIntentAppliedFn;
  const loadPolicyFn = deps.loadPolicy ?? loadMomentumPolicyFn;
  const buildLinearClient =
    deps.buildLinearClient ?? defaultBuildLinearClient;
  const buildLinearRefreshClient =
    deps.buildLinearRefreshClient ?? defaultBuildLinearRefreshClient;
  const updateReconcileFn =
    deps.updateIntentApplyAuditReconcile ?? updateIntentApplyAuditReconcileFn;

  if (
    typeof input.intentId !== "string" ||
    input.intentId.trim().length === 0
  ) {
    throw new Error("executeExternalApply requires a non-empty intentId.");
  }
  if (
    typeof input.operatorReason !== "string" ||
    input.operatorReason.trim().length === 0
  ) {
    throw new Error("executeExternalApply requires a non-empty operatorReason.");
  }

  const intent = getUpdateIntentById(input.db, input.intentId);
  if (!intent) {
    return earlyFailure({
      code: "intent_not_found",
      message: `Update intent not found: ${input.intentId}`,
      contextBase: {
        intentId: input.intentId,
        intentStatus: "pending",
        adapterKind: "",
        intentType: "",
        target: emptyTarget(),
        applyPolicy: {
          value: DEFAULT_INTENT_APPLY_POLICY,
          source: "builtin_default"
        }
      }
    });
  }

  const intentBaseContext = {
    intentId: intent.id,
    intentStatus: intent.status,
    adapterKind: intent.adapterKind,
    intentType: intent.intentType,
    target: {
      adapterKind: intent.adapterKind,
      externalId: intent.targetExternalId,
      externalKey: null as string | null,
      url: null as string | null,
      title: null as string | null
    }
  };

  if (intent.status !== "pending") {
    return earlyFailure({
      code: "intent_already_terminal",
      message: `Update intent ${intent.id} is already ${intent.status}; refusing to re-apply.`,
      intent,
      contextBase: {
        ...intentBaseContext,
        applyPolicy: {
          value: DEFAULT_INTENT_APPLY_POLICY,
          source: "builtin_default"
        }
      }
    });
  }

  const policyResolution = resolvePolicy({
    repoPath: input.repoPath,
    loadPolicyFn
  });
  if (!policyResolution.ok) {
    return earlyFailure({
      code: policyResolution.code,
      message: policyResolution.message,
      intent,
      contextBase: {
        ...intentBaseContext,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }

  if (policyResolution.applyPolicy.value !== "external_apply_allowed") {
    return earlyFailure({
      code: "policy_denied",
      message: `Repo policy intent_apply_policy is "${policyResolution.applyPolicy.value}" (source: ${policyResolution.applyPolicy.source}); external apply requires "external_apply_allowed".`,
      intent,
      contextBase: {
        ...intentBaseContext,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }

  const adapter = resolveExternalUpdateAdapterForIntent(intent, deps.adapters);
  if (!adapter) {
    const reason = identifyUnsupportedReason(intent, deps.adapters);
    return earlyFailure({
      code: reason.code,
      message: reason.message,
      intent,
      contextBase: {
        ...intentBaseContext,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }

  const sourceItem = intent.sourceItemId
    ? getSourceItemById(input.db, intent.sourceItemId)
    : null;
  const evidenceRecord = intent.evidenceRecordId
    ? getEvidenceRecordById(input.db, intent.evidenceRecordId)
    : null;

  const targetExternalId = intent.targetExternalId ?? sourceItem?.externalId ?? null;
  if (typeof targetExternalId !== "string" || targetExternalId.length === 0) {
    return earlyFailure({
      code: "target_missing",
      message: `Update intent ${intent.id} has no resolved external target id.`,
      intent,
      contextBase: {
        ...intentBaseContext,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }

  const target: ExternalUpdateAdapterTarget = {
    adapterKind: intent.adapterKind,
    externalId: targetExternalId,
    externalKey: sourceItem?.externalKey ?? null,
    url: sourceItem?.url ?? null,
    title: sourceItem?.title ?? null
  };

  const enrichedContextBase = {
    ...intentBaseContext,
    target: {
      adapterKind: target.adapterKind,
      externalId: target.externalId,
      externalKey: target.externalKey,
      url: target.url,
      title: target.title
    }
  };

  const authResult = checkAdapterAuth(adapter.kind, env);
  if (!authResult.ok) {
    return earlyFailure({
      code: "auth_unavailable",
      message: authResult.message,
      intent,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }

  const allowStatusMutation = input.statusMutation != null;
  const adapterInput: ExternalUpdateAdapterInput = {
    intent,
    target,
    sourceItem: sourceItem ?? null,
    evidenceRecord: evidenceRecord ?? null,
    operator: {
      reason: input.operatorReason,
      actor: input.operatorActor ?? null
    },
    policy: {
      intentApplyPolicy: policyResolution.applyPolicy.value,
      allowStatusMutation
    }
  };

  const previewOptions: { adapters?: ReadonlyMap<string, ExternalUpdateAdapter> } =
    deps.adapters ? { adapters: deps.adapters } : {};
  const previewResult = previewFn(adapterInput, previewOptions);
  if (!previewResult.ok) {
    return earlyFailure({
      code: mapAdapterErrorCode(previewResult),
      message: previewResult.error,
      intent,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy
      }
    });
  }
  const preview = previewResult.preview;

  const claim = claimFn(input.db, {
    intentId: intent.id,
    adapterKind: adapter.kind,
    provider: adapter.kind,
    target: {
      externalId: target.externalId,
      externalKey: target.externalKey,
      url: target.url,
      title: target.title
    },
    operatorReason: input.operatorReason,
    operatorActor: input.operatorActor ?? null,
    intentApplyPolicy: policyResolution.applyPolicy.value,
    allowStatusMutation,
    mutationKind: preview.mutationKind,
    previewSummary: preview.summary,
    idempotencyMarker: preview.idempotencyMarker,
    now: now()
  });

  if (!claim.ok) {
    const code: ExecuteExternalApplyErrorCode =
      claim.code === "intent_not_found"
        ? "intent_not_found"
        : claim.code === "intent_blocked"
          ? "intent_blocked"
          : "intent_apply_in_progress";
    return earlyFailure({
      code,
      message: claim.message,
      intent,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy,
        mutationKind: preview.mutationKind,
        allowStatusMutation
      }
    });
  }

  const audit = claim.audit;

  const client = buildLinearClient(env);
  const refreshClient = buildLinearRefreshClient
    ? buildLinearRefreshClient(env)
    : null;
  const applyInput: LinearExternalUpdateInput = {
    preview,
    statusMutation: input.statusMutation ?? null
  };

  let externalResult: LinearExternalUpdateResult;
  try {
    externalResult = await client.apply(applyInput);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    let finalize = finalizeFn(input.db, {
      auditId: audit.id,
      lifecycleState: "failed",
      resultStatus: "failed",
      resultCode: "adapter_threw",
      resultMessage: message,
      now: now()
    });
    if (!finalize.ok) {
      finalize = markIntentApplyAuditIncompleteFn(input.db, {
        auditId: audit.id,
        resultCode: "failed_finalize_failed",
        resultMessage: `External apply client threw, then audit finalize failed: ${finalize.message}`,
        reconcile: {
          status: "deferred",
          warning: "external write failed; audit finalize failed"
        },
        now: now()
      });
    }
    return buildExternalFailure({
      code: finalize.ok && finalize.audit.lifecycleState === "audit_incomplete"
        ? "audit_incomplete"
        : "adapter_threw",
      message:
        finalize.ok && finalize.audit.lifecycleState === "audit_incomplete"
          ? `External apply client threw and audit finalize failed for intent ${intent.id}; intent is blocked from further apply.`
          : `External apply client threw: ${message}`,
      intent,
      audit,
      finalize,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy,
        mutationKind: preview.mutationKind,
        allowStatusMutation,
        idempotencyMarker: preview.idempotencyMarker
      }
    });
  }

  if (!externalResult.ok) {
    let finalize = finalizeFn(input.db, {
      auditId: audit.id,
      lifecycleState: "failed",
      resultStatus: "failed",
      resultCode: externalResult.code,
      resultMessage: externalResult.error,
      externalRefs: {
        commentId: externalResult.partial?.comment?.id ?? null,
        commentUrl: externalResult.partial?.comment?.url ?? null
      },
      now: now()
    });
    if (!finalize.ok) {
      finalize = markIntentApplyAuditIncompleteFn(input.db, {
        auditId: audit.id,
        resultCode: "failed_finalize_failed",
        resultMessage: `External write failed, then audit finalize failed: ${finalize.message}`,
        externalRefs: {
          commentId: externalResult.partial?.comment?.id ?? null,
          commentUrl: externalResult.partial?.comment?.url ?? null,
          stateTransitionId: null
        },
        reconcile: {
          status: "deferred",
          warning: "external write failed; audit finalize failed"
        },
        now: now()
      });
    }
    return buildExternalFailure({
      code: finalize.ok && finalize.audit.lifecycleState === "audit_incomplete"
        ? "audit_incomplete"
        : mapLinearErrorCode(externalResult.code),
      message:
        finalize.ok && finalize.audit.lifecycleState === "audit_incomplete"
          ? `External write failed and audit finalize failed for intent ${intent.id}; intent is blocked from further apply.`
          : externalResult.error,
      intent,
      audit: finalize.ok ? finalize.audit : audit,
      finalize,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy,
        mutationKind: preview.mutationKind,
        allowStatusMutation,
        idempotencyMarker: preview.idempotencyMarker
      },
      external: externalRefsFromError(externalResult, preview.idempotencyMarker)
    });
  }

  // External write succeeded — finalize audit before transitioning the intent.
  const finalizeSucceeded = finalizeFn(input.db, {
    auditId: audit.id,
    lifecycleState: "succeeded",
    resultStatus: "succeeded",
    resultCode: externalResult.alreadyApplied ? "already_applied" : "applied",
    resultMessage: externalResult.alreadyApplied
      ? "External write already present; replay no-op."
      : "External write succeeded.",
    externalRefs: {
      commentId: externalResult.comment.id,
      commentUrl: externalResult.comment.url,
      stateTransitionId: externalResult.status.transitioned
        ? externalResult.status.nextStateId
        : null
    },
    reconcile: pendingReconcile(),
    now: now()
  });

  if (!finalizeSucceeded.ok) {
    // External write succeeded but the audit row could not be marked succeeded.
    // Force `audit_incomplete` so the intent moves to `blocked` and a future
    // apply cannot replay the mutation before operator recovery clears the
    // block.
    const incomplete = markIntentApplyAuditIncompleteFn(input.db, {
      auditId: audit.id,
      resultCode: "audit_finalize_failed",
      resultMessage: `Audit finalize failed after external write: ${finalizeSucceeded.message}`,
      externalRefs: {
        commentId: externalResult.comment.id,
        commentUrl: externalResult.comment.url,
        stateTransitionId: externalResult.status.transitioned
          ? externalResult.status.nextStateId
          : null
      },
      reconcile: {
        status: "deferred",
        warning: "external write applied; audit finalize failed"
      },
      now: now()
    });

    return buildExternalFailure({
      code: "audit_incomplete",
      message: incomplete.ok
        ? `External write succeeded but audit finalize failed for intent ${intent.id}; intent is blocked from further apply.`
        : `External write succeeded but audit finalize recovery failed for intent ${intent.id}: ${incomplete.message}`,
      intent,
      audit: incomplete.ok ? incomplete.audit : audit,
      finalize: incomplete,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy,
        mutationKind: preview.mutationKind,
        allowStatusMutation,
        idempotencyMarker: preview.idempotencyMarker,
        reconcileOverride: {
          status: "deferred",
          warning: "external write applied; audit finalize failed"
        }
      },
      external: externalSummary(externalResult)
    });
  }

  // Intent transitions to applied with the operator reason that drove the
  // write. This is intentionally separate from the M5 manual mark-applied
  // path so the audit ledger is the durable record of the external write.
  const decisionReason = `external_apply: ${input.operatorReason}`;
  const markApplied = markAppliedFn(input.db, {
    intentId: intent.id,
    decisionReason,
    now: now()
  });

  if (!markApplied.ok) {
    const currentIntent = getUpdateIntentById(input.db, intent.id);
    if (
      markApplied.code === "intent_already_terminal" &&
      markApplied.currentStatus === "applied" &&
      currentIntent?.status === "applied"
    ) {
      const reconciled = await reconcileSuccessfulExternalApply({
        db: input.db,
        audit: finalizeSucceeded.audit,
        adapter,
        target,
        idempotencyMarker: preview.idempotencyMarker,
        refreshClient,
        updateReconcileFn,
        now
      });
      return buildExternalSuccess({
        intent: currentIntent,
        adapter,
        target,
        policyResolution,
        allowStatusMutation,
        preview,
        audit: reconciled.audit,
        externalResult,
        reconcile: reconciled.reconcile
      });
    }
    const incomplete = markIntentApplyAuditIncompleteFn(input.db, {
      auditId: finalizeSucceeded.audit.id,
      resultCode: "mark_applied_failed",
      resultMessage: `External write succeeded but mark-applied failed: ${markApplied.message}`,
      externalRefs: {
        commentId: externalResult.comment.id,
        commentUrl: externalResult.comment.url,
        stateTransitionId: externalResult.status.transitioned
          ? externalResult.status.nextStateId
          : null
      },
      reconcile: {
        status: "deferred",
        warning: "external write applied; intent transition failed"
      },
      now: now()
    });
    return buildExternalFailure({
      code: "audit_incomplete",
      message: `External write succeeded but mark-applied failed for intent ${intent.id}: ${markApplied.message}`,
      intent,
      audit: incomplete.ok ? incomplete.audit : finalizeSucceeded.audit,
      finalize: incomplete,
      contextBase: {
        ...enrichedContextBase,
        applyPolicy: policyResolution.applyPolicy,
        mutationKind: preview.mutationKind,
        allowStatusMutation,
        idempotencyMarker: preview.idempotencyMarker,
        reconcileOverride: {
          status: "deferred",
          warning: "external write applied; intent transition failed"
        }
      },
      external: externalSummary(externalResult)
    });
  }

  const reconciled = await reconcileSuccessfulExternalApply({
    db: input.db,
    audit: finalizeSucceeded.audit,
    adapter,
    target,
    idempotencyMarker: preview.idempotencyMarker,
    refreshClient,
    updateReconcileFn,
    now
  });

  const successContext: ExecuteExternalApplyContext = {
    intentId: intent.id,
    intentStatus: markApplied.intent.status,
    adapterKind: adapter.kind,
    intentType: intent.intentType,
    target: {
      adapterKind: target.adapterKind,
      externalId: target.externalId,
      externalKey: target.externalKey,
      url: target.url,
      title: target.title
    },
    applyPolicy: policyResolution.applyPolicy,
    allowStatusMutation,
    mutationKind: preview.mutationKind,
    auditId: reconciled.audit.id,
    reconcile: reconciled.reconcile
  };

  return {
    ok: true,
    resultCode: "applied",
    context: successContext,
    intent: markApplied.intent,
    audit: reconciled.audit,
    external: externalSummary(externalResult)
  };
}

function buildExternalSuccess(args: {
  intent: UpdateIntent;
  adapter: ExternalUpdateAdapter;
  target: ExternalUpdateAdapterTarget;
  policyResolution: { applyPolicy: ExecuteExternalApplyResolvedPolicy };
  allowStatusMutation: boolean;
  preview: ExternalUpdateAdapterPreview;
  audit: IntentApplyAudit;
  externalResult: LinearExternalUpdateResult & { ok: true };
  reconcile?: ExecuteExternalApplyReconcile;
}): ExecuteExternalApplySuccess {
  const successContext: ExecuteExternalApplyContext = {
    intentId: args.intent.id,
    intentStatus: args.intent.status,
    adapterKind: args.adapter.kind,
    intentType: args.intent.intentType,
    target: {
      adapterKind: args.target.adapterKind,
      externalId: args.target.externalId,
      externalKey: args.target.externalKey,
      url: args.target.url,
      title: args.target.title
    },
    applyPolicy: args.policyResolution.applyPolicy,
    allowStatusMutation: args.allowStatusMutation,
    mutationKind: args.preview.mutationKind,
    auditId: args.audit.id,
    reconcile: args.reconcile ?? pendingReconcile()
  };

  return {
    ok: true,
    resultCode: "applied",
    context: successContext,
    intent: args.intent,
    audit: args.audit,
    external: externalSummary(args.externalResult)
  };
}

async function reconcileSuccessfulExternalApply(args: {
  db: MomentumDb;
  audit: IntentApplyAudit;
  adapter: ExternalUpdateAdapter;
  target: ExternalUpdateAdapterTarget;
  idempotencyMarker: string;
  refreshClient: LinearIssueRefreshClient | null;
  updateReconcileFn: (
    db: MomentumDb,
    input: UpdateIntentApplyAuditReconcileInput
  ) => UpdateIntentApplyAuditReconcileResult;
  now: () => number;
}): Promise<{ audit: IntentApplyAudit; reconcile: ExecuteExternalApplyReconcile }> {
  const outcome = await reconcileAfterExternalApply({
    db: args.db,
    adapterKind: args.adapter.kind,
    externalId: args.target.externalId,
    externalKey: args.target.externalKey,
    url: args.target.url,
    idempotencyMarker: args.idempotencyMarker,
    client: args.refreshClient,
    now: args.now
  });
  const reconcile: IntentApplyAuditReconcile = {
    status: outcome.code,
    warning: outcome.code === "success" ? null : outcome.detail
  };
  let updated: UpdateIntentApplyAuditReconcileResult;
  try {
    updated = args.updateReconcileFn(args.db, {
      auditId: args.audit.id,
      reconcile,
      now: args.now()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      audit: args.audit,
      reconcile: {
        status: "post_apply_reconcile_failed",
        warning: `Post-apply reconcile completed with ${outcome.code}, but audit reconcile update threw: ${message}`
      }
    };
  }
  if (!updated.ok) {
    return {
      audit: args.audit,
      reconcile: {
        status: "post_apply_reconcile_failed",
        warning: `Post-apply reconcile completed with ${outcome.code}, but audit reconcile update failed: ${updated.message}`
      }
    };
  }
  return {
    audit: updated.audit,
    reconcile: {
      status: reconcile.status as ExecuteExternalApplyReconcile["status"],
      warning: reconcile.warning
    }
  };
}

function pendingReconcile(): ExecuteExternalApplyReconcile {
  return { status: "pending", warning: null };
}

export function defaultBuildLinearClient(
  env: ExecuteExternalApplyEnv
): LinearExternalUpdateClient {
  const endpointOverride = readEndpointOverride(
    env,
    LINEAR_EXTERNAL_UPDATE_ENDPOINT_ENV_VAR
  );
  const options: {
    apiKey: string | null;
    endpoint?: string;
  } = {
    apiKey: env[LINEAR_API_KEY_ENV_VAR] ?? null
  };
  if (endpointOverride !== null) options.endpoint = endpointOverride;
  return buildLinearExternalUpdateClient(options);
}

export function defaultBuildLinearRefreshClient(
  env: ExecuteExternalApplyEnv
): LinearIssueRefreshClient {
  const endpointOverride = readEndpointOverride(
    env,
    LINEAR_REFRESH_ENDPOINT_ENV_VAR
  );
  const options: {
    apiKey: string | null;
    endpoint?: string;
  } = {
    apiKey: env[LINEAR_API_KEY_ENV_VAR] ?? null
  };
  if (endpointOverride !== null) options.endpoint = endpointOverride;
  return buildLinearIssueRefreshClient(options);
}

function readEndpointOverride(
  env: ExecuteExternalApplyEnv,
  name: string
): string | null {
  const raw = env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkAdapterAuth(
  adapterKind: string,
  env: ExecuteExternalApplyEnv
): { ok: true } | { ok: false; message: string } {
  if (adapterKind === "linear") {
    const key = env[LINEAR_API_KEY_ENV_VAR];
    if (typeof key !== "string" || key.trim().length === 0) {
      return {
        ok: false,
        message: `${LINEAR_API_KEY_ENV_VAR} is not set; the linear external update path requires an operator-provided credential.`
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

type PolicyResolution =
  | {
      ok: true;
      applyPolicy: ExecuteExternalApplyResolvedPolicy;
    }
  | {
      ok: false;
      code: "policy_denied" | "policy_load_failed";
      message: string;
      applyPolicy: ExecuteExternalApplyResolvedPolicy;
    };

function resolvePolicy(args: {
  repoPath: string | null | undefined;
  loadPolicyFn: (repoPath: string) => MomentumPolicyLoadResult;
}): PolicyResolution {
  const { repoPath, loadPolicyFn } = args;
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "policy_denied",
      message:
        "External apply requires a repo context with MOMENTUM.md; pass --repo or run inside a configured repo.",
      applyPolicy: {
        value: DEFAULT_INTENT_APPLY_POLICY,
        source: "missing_repo"
      }
    };
  }
  const loadResult = loadPolicyFn(repoPath);
  if (!loadResult.ok) {
    return {
      ok: false,
      code: "policy_load_failed",
      message: `Failed to load MOMENTUM.md: ${loadResult.error}`,
      applyPolicy: {
        value: DEFAULT_INTENT_APPLY_POLICY,
        source: "builtin_default"
      }
    };
  }
  if (loadResult.present === false) {
    return {
      ok: true,
      applyPolicy: {
        value: DEFAULT_INTENT_APPLY_POLICY,
        source: "builtin_default"
      }
    };
  }
  const resolved = resolveIntentApplyPolicy(loadResult.policy.config);
  return {
    ok: true,
    applyPolicy: {
      value: resolved.value,
      source: resolved.source
    }
  };
}

function identifyUnsupportedReason(
  intent: UpdateIntent,
  adapters: ReadonlyMap<string, ExternalUpdateAdapter> | undefined
): { code: "unsupported_adapter" | "unsupported_intent_type"; message: string } {
  const adapter = getExternalUpdateAdapter(intent.adapterKind, adapters);
  if (!adapter) {
    return {
      code: "unsupported_adapter",
      message: `External update adapter "${intent.adapterKind}" is not supported for external apply.`
    };
  }
  return {
    code: "unsupported_intent_type",
    message: `External update adapter "${intent.adapterKind}" does not support intent type "${intent.intentType}".`
  };
}

function mapAdapterErrorCode(
  error: ExternalUpdateAdapterError
): ExecuteExternalApplyErrorCode {
  switch (error.code) {
    case "unsupported_adapter":
      return "unsupported_adapter";
    case "unsupported_intent_type":
      return "unsupported_intent_type";
    case "target_missing":
      return "target_missing";
    case "auth_unavailable":
      return "auth_unavailable";
    case "policy_denied":
      return "policy_denied";
    case "external_conflict":
      return "external_conflict";
    case "adapter_threw":
      return "adapter_threw";
    case "write_rejected":
      return "write_rejected";
    case "write_timeout":
      return "write_timeout";
    case "malformed_response":
      return "malformed_response";
    case "validation_failed":
      return "validation_failed";
    default:
      return "preview_failed";
  }
}

function mapLinearErrorCode(
  code: LinearExternalUpdateResultCode
): ExecuteExternalApplyErrorCode {
  switch (code) {
    case "auth_unavailable":
      return "auth_unavailable";
    case "target_missing":
      return "target_missing";
    case "target_state_ambiguous":
      return "validation_failed";
    case "external_conflict":
      return "external_conflict";
    case "write_rejected":
      return "write_rejected";
    case "write_timeout":
      return "write_timeout";
    case "malformed_response":
      return "malformed_response";
    case "validation_failed":
      return "validation_failed";
    case "adapter_threw":
      return "adapter_threw";
    default:
      return "adapter_threw";
  }
}

function emptyTarget(): ExecuteExternalApplyTarget {
  return {
    adapterKind: "",
    externalId: null,
    externalKey: null,
    url: null,
    title: null
  };
}

type EarlyFailureContextBase = {
  intentId: string;
  intentStatus: UpdateIntent["status"];
  adapterKind: string;
  intentType: string;
  target: ExecuteExternalApplyTarget;
  applyPolicy: ExecuteExternalApplyResolvedPolicy;
  allowStatusMutation?: boolean;
  mutationKind?: ExternalUpdateMutationKind;
  idempotencyMarker?: string;
  reconcileOverride?: ExecuteExternalApplyReconcile;
};

function earlyFailure(args: {
  code: ExecuteExternalApplyErrorCode;
  message: string;
  intent?: UpdateIntent | null;
  contextBase: EarlyFailureContextBase;
}): ExecuteExternalApplyFailure {
  const context: ExecuteExternalApplyContext = {
    intentId: args.contextBase.intentId,
    intentStatus: args.contextBase.intentStatus,
    adapterKind: args.contextBase.adapterKind,
    intentType: args.contextBase.intentType,
    target: args.contextBase.target,
    applyPolicy: args.contextBase.applyPolicy,
    allowStatusMutation: args.contextBase.allowStatusMutation ?? false,
    mutationKind: args.contextBase.mutationKind ?? null,
    auditId: null,
    reconcile: args.contextBase.reconcileOverride ?? {
      status: null,
      warning: null
    }
  };
  return {
    ok: false,
    code: args.code,
    message: args.message,
    context,
    intent: args.intent ?? null,
    audit: null,
    external: null
  };
}

function buildExternalFailure(args: {
  code: ExecuteExternalApplyErrorCode;
  message: string;
  intent: UpdateIntent;
  audit: IntentApplyAudit;
  finalize: FinalizeIntentApplyResult;
  contextBase: EarlyFailureContextBase;
  external?: ExecuteExternalApplyExternalResult | null;
}): ExecuteExternalApplyFailure {
  const resolvedAudit = args.finalize.ok ? args.finalize.audit : args.audit;
  const context: ExecuteExternalApplyContext = {
    intentId: args.contextBase.intentId,
    intentStatus: args.intent.status,
    adapterKind: args.contextBase.adapterKind,
    intentType: args.contextBase.intentType,
    target: args.contextBase.target,
    applyPolicy: args.contextBase.applyPolicy,
    allowStatusMutation: args.contextBase.allowStatusMutation ?? false,
    mutationKind: args.contextBase.mutationKind ?? null,
    auditId: resolvedAudit.id,
    reconcile: args.contextBase.reconcileOverride ?? {
      status: null,
      warning: null
    }
  };
  return {
    ok: false,
    code: args.code,
    message: args.message,
    context,
    intent: args.intent,
    audit: resolvedAudit,
    external: args.external ?? null
  };
}

function externalSummary(
  result: LinearExternalUpdateResult & { ok: true }
): ExecuteExternalApplyExternalResult {
  return {
    alreadyApplied: result.alreadyApplied,
    issueId: result.issue.id,
    issueKey: result.issue.key,
    issueUrl: result.issue.url,
    commentId: result.comment.id,
    commentUrl: result.comment.url,
    statusTransitioned: result.status.transitioned,
    nextStateId: result.status.nextStateId,
    nextStateName: result.status.nextStateName,
    idempotencyMarker: result.idempotencyMarker
  };
}

function externalRefsFromError(
  error: LinearExternalUpdateError,
  idempotencyMarker: string
): ExecuteExternalApplyExternalResult | null {
  if (!error.partial) return null;
  return {
    alreadyApplied: false,
    issueId: error.partial.issue?.id ?? null,
    issueKey: error.partial.issue?.key ?? null,
    issueUrl: error.partial.issue?.url ?? null,
    commentId: error.partial.comment?.id ?? null,
    commentUrl: error.partial.comment?.url ?? null,
    statusTransitioned: false,
    nextStateId: null,
    nextStateName: null,
    idempotencyMarker
  };
}
