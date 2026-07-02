import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../adapters/db.js";
import type { LiveWrapperProfile } from "../../adapters/live-wrapper-registry.js";
import type { LinearExternalUpdateClient } from "../../adapters/linear-external-update-client.js";
import type { LinearIssueRefreshClient } from "../../adapters/linear-issue-refresh.js";
import {
  defaultBuildLinearRefreshClient,
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
  type ExecuteExternalApplySuccess,
  type ExecuteExternalApplyDeps
} from "../intent/apply-execute.js";
import { getLatestIntentApplyAudit } from "../intent/apply-audits.js";
import {
  loadMomentumPolicy,
  resolveIntentApplyPolicy,
  type UpdateIntentApplyPolicy
} from "../intent/policy.js";
import {
  listUpdateIntents,
  type UpdateIntent
} from "../intent/update-intents.js";
import { getSourceItemById, type SourceItem } from "../source/items.js";
import { DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS } from "./loop.js";
import {
  loadDispatchedStepRunProvenance,
  resolveDispatchedStepExecutorContext
} from "../workflow/live-wrapper/daemon-exec-context.js";
import {
  readDaemonLiveWrapperProfileSource,
  resolveDaemonLiveWrapperProfile,
  DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR
} from "../workflow/live-wrapper/daemon-profile.js";
import { resolveDaemonWorkflowDispatch as resolveDogfoodDaemonWorkflowDispatch } from "../workflow/dispatch/dogfood.js";
import {
  createExternalApplyWorkflowDispatch,
  type DispatchedExternalApplyContextResolution
} from "../workflow/dispatch/external-apply-dispatch.js";
import { createLiveWrapperWorkflowDispatch } from "../workflow/dispatch/live-wrapper.js";
import { createSubworkflowWorkflowDispatch } from "../workflow/dispatch/subworkflow-dispatch.js";
import { deriveDispatchedSubworkflowContext } from "../workflow/route/subworkflow-dispatch-context.js";
import { planLinearRefreshLifecycle } from "../workflow/dispatch/linear-refresh-lifecycle.js";
import { buildRealWorkflowStepExecutorRegistry } from "../workflow/step/executor-real-adapters.js";
import type {
  AsyncWorkflowStepDispatch,
  WorkflowStepDispatch
} from "../workflow/dispatch/scheduler.js";

export type LinearIssueRefreshClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type LinearExternalUpdateClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type DaemonWorkflowDispatchDeps = {
  buildLinearExternalUpdateClient?: (
    input: LinearExternalUpdateClientFactoryInput
  ) => LinearExternalUpdateClient;
  buildLinearIssueRefreshClient?: (
    input: LinearIssueRefreshClientFactoryInput
  ) => LinearIssueRefreshClient | null;
};

export type DaemonWorkflowDispatchResolution =
  | { ok: true; dispatch: AsyncWorkflowStepDispatch; leaseDurationMs?: number }
  | { ok: false; message: string };

export function resolveDaemonWorkflowStepDispatch(
  env: Record<string, string | undefined>,
  baseDispatch: WorkflowStepDispatch,
  deps: DaemonWorkflowDispatchDeps
): DaemonWorkflowDispatchResolution {
  const profile = resolveDaemonLiveWrapperProfile(env, {
    loadSource: readDaemonLiveWrapperProfileSource
  });

  if (profile.status === "invalid") {
    return {
      ok: false,
      message: `Invalid ${DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR} (${profile.source}): ${profile.code}: ${profile.error}`
    };
  }

  if (profile.status === "not_configured") {
    return {
      ok: true,
      dispatch: withSubworkflowDispatch(
        withExternalApplyDispatch(
          resolveDogfoodDaemonWorkflowDispatch(env, baseDispatch),
          env,
          deps
        )
      )
    };
  }

  const registry = buildRealWorkflowStepExecutorRegistry({
    profile: profile.profile
  });
  return {
    ok: true,
    dispatch: withSubworkflowDispatch(
      withExternalApplyDispatch(
        createLiveWrapperWorkflowDispatch(baseDispatch, {
          registry,
          deriveExec: (claim, context) => {
            const provenance = loadDispatchedStepRunProvenance(
              context.db,
              claim.runId
            );
            if (provenance === undefined) {
              return { ok: false, reason: "run_not_found" };
            }
            const resolved = resolveDispatchedStepExecutorContext(
              claim.runId,
              provenance
            );
            if (resolved.ok) {
              try {
                fs.mkdirSync(resolved.exec.runDir, { recursive: true });
              } catch (error) {
                return {
                  ok: false,
                  reason: `run_dir_unavailable: ${error instanceof Error ? error.message : String(error)}`
                };
              }
              return {
                ok: true,
                exec: {
                  ...resolved.exec,
                  env
                }
              };
            }
            return resolved;
          }
        }),
        env,
        deps
      )
    ),
    leaseDurationMs: maxDaemonLiveWrapperProfileTimeoutMs(profile.profile)
  };
}

function withExternalApplyDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
  env: Record<string, string | undefined>,
  deps: DaemonWorkflowDispatchDeps
): AsyncWorkflowStepDispatch {
  return createExternalApplyWorkflowDispatch(baseDispatch, {
    deriveExternalApply: (claim, context) =>
      resolveDaemonExternalApplyContext(
        claim.runId,
        claim.stepId,
        context,
        env,
        deps
      )
  });
}

function withSubworkflowDispatch(
  baseDispatch: AsyncWorkflowStepDispatch
): AsyncWorkflowStepDispatch {
  return createSubworkflowWorkflowDispatch(baseDispatch, {
    deriveSubworkflow: deriveDispatchedSubworkflowContext
  });
}

function resolveDaemonExternalApplyContext(
  runId: string,
  stepId: string,
  context: { db: MomentumDb },
  env: Record<string, string | undefined>,
  deps: DaemonWorkflowDispatchDeps
): DispatchedExternalApplyContextResolution {
  const provenance = loadDispatchedStepRunProvenance(context.db, runId);
  if (provenance === undefined) {
    return { ok: false, reason: "run_not_found" };
  }
  const resolved = resolveDispatchedStepExecutorContext(runId, provenance);
  if (!resolved.ok) return resolved;

  try {
    fs.mkdirSync(resolved.exec.runDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: `run_dir_unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const issueScopeIdentifier = loadWorkflowRunIssueScopeIdentifier(
    context.db,
    runId
  );
  const pending = findPendingLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? ""
  );
  const applied = findAppliedLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? ""
  );
  const sourceItemsById = loadLinearRefreshSourceItems(context.db, [
    ...pending,
    ...applied
  ]);
  const latestAuditsByIntentId = loadLatestLinearRefreshAudits(context.db, applied);
  const policy = resolveLinearRefreshPolicy(resolved.exec.repoPath);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `linear_refresh_policy_load_failed: ${policy.code}: ${policy.error}`
    };
  }
  const operatorReason = linearRefreshOperatorReason(runId, stepId);
  const lifecycle = planLinearRefreshLifecycle({
    env,
    intentApplyPolicy: policy.value,
    issueScopeIdentifier,
    pendingIntents: pending,
    appliedIntents: applied,
    sourceItemsById,
    latestAuditsByIntentId,
    expectedOperatorReason: operatorReason
  });
  if (lifecycle.status === "already_applied") {
    const intent = applied.find((candidate) => candidate.id === lifecycle.evidence.intentId);
    const source =
      lifecycle.evidence.sourceItemId === null
        ? null
        : sourceItemsById.get(lifecycle.evidence.sourceItemId) ?? null;
    const audit =
      lifecycle.evidence.intentId === null
        ? null
        : latestAuditsByIntentId.get(lifecycle.evidence.intentId) ?? null;
    if (intent === undefined || source === null || audit === null) {
      return { ok: false, reason: "linear_refresh_reconcile_evidence_missing" };
    }
    return {
      ok: true,
      evidence: {
        executorLogPath: path.join(resolved.exec.runDir, "external-apply.log"),
        resultJsonPath: path.join(resolved.exec.runDir, "external-apply.json")
      },
      runExternalApply: async () =>
        linearRefreshAlreadyAppliedSuccess(intent, source, audit)
    };
  }
  if (!lifecycle.safeToMutate) {
    return {
      ok: false,
      reason: linearRefreshRefusalReason(
        lifecycle.status,
        policy.value,
        lifecycle.message
      )
    };
  }

  const intentId = lifecycle.evidence.intentId;
  if (intentId === null) {
    return { ok: false, reason: "linear_refresh_intent_evidence_missing" };
  }
  const executeDeps: ExecuteExternalApplyDeps = {};
  const factory = deps.buildLinearExternalUpdateClient;
  if (factory) {
    executeDeps.buildLinearClient = (clientEnv) => {
      const apiKey = readLinearApiKey(clientEnv);
      return factory({ apiKey, env: env as NodeJS.ProcessEnv });
    };
  }
  const refreshFactory =
    deps.buildLinearIssueRefreshClient ??
    ((input: LinearIssueRefreshClientFactoryInput) =>
      defaultBuildLinearRefreshClient(input.env));
  executeDeps.buildLinearRefreshClient = (clientEnv) => {
    const apiKey = readLinearApiKey(clientEnv);
    return refreshFactory({ apiKey, env: env as NodeJS.ProcessEnv });
  };

  return {
    ok: true,
    evidence: {
      executorLogPath: path.join(resolved.exec.runDir, "external-apply.log"),
      resultJsonPath: path.join(resolved.exec.runDir, "external-apply.json")
    },
    runExternalApply: () =>
      executeExternalApply({
        db: context.db,
        intentId,
        operatorReason,
        repoPath: resolved.exec.repoPath,
        env,
        statusMutation: null,
        deps: executeDeps
      })
  };
}

function findPendingLinearExternalApplyIntents(
  db: MomentumDb,
  issueScopeIdentifier: string
): UpdateIntent[] {
  return listUpdateIntents(db, {
    status: "pending",
    adapterKind: "linear"
  }).filter((intent) =>
    pendingLinearIntentMatchesIssueScope(db, intent, issueScopeIdentifier)
  );
}

function findAppliedLinearExternalApplyIntents(
  db: MomentumDb,
  issueScopeIdentifier: string
): UpdateIntent[] {
  return listUpdateIntents(db, {
    status: "applied",
    adapterKind: "linear"
  }).filter((intent) =>
    pendingLinearIntentMatchesIssueScope(db, intent, issueScopeIdentifier)
  );
}

function pendingLinearIntentMatchesIssueScope(
  db: MomentumDb,
  intent: UpdateIntent,
  issueScopeIdentifier: string
): boolean {
  if (issueScopeIdentifier.trim().length === 0) return false;
  if (intent.targetExternalId === issueScopeIdentifier) return true;
  if (intent.sourceItemId === null) return false;

  const sourceItem = getSourceItemById(db, intent.sourceItemId);
  if (sourceItem === null || sourceItem.adapterKind !== "linear") return false;
  return (
    sourceItem.externalId === issueScopeIdentifier ||
    sourceItem.externalKey === issueScopeIdentifier
  );
}

function loadLinearRefreshSourceItems(
  db: MomentumDb,
  intents: readonly UpdateIntent[]
): ReadonlyMap<string, SourceItem> {
  const out = new Map<string, SourceItem>();
  for (const intent of intents) {
    if (intent.sourceItemId === null || out.has(intent.sourceItemId)) continue;
    const source = getSourceItemById(db, intent.sourceItemId);
    if (source !== null) out.set(source.id, source);
  }
  return out;
}

function loadLatestLinearRefreshAudits(
  db: MomentumDb,
  intents: readonly UpdateIntent[]
) {
  const out = new Map<string, NonNullable<ReturnType<typeof getLatestIntentApplyAudit>>>();
  for (const intent of intents) {
    const audit = getLatestIntentApplyAudit(db, intent.id);
    if (audit !== null) out.set(intent.id, audit);
  }
  return out;
}

type LinearRefreshPolicyResolution =
  | { ok: true; value: UpdateIntentApplyPolicy }
  | {
      ok: false;
      code: string;
      error: string;
    };

function resolveLinearRefreshPolicy(repoPath: string): LinearRefreshPolicyResolution {
  const loaded = loadMomentumPolicy(repoPath);
  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.code,
      error: loaded.error
    };
  }
  if (!loaded.present) {
    return { ok: true, value: resolveIntentApplyPolicy(undefined).value };
  }
  return {
    ok: true,
    value: resolveIntentApplyPolicy(loaded.policy.config).value
  };
}

function linearRefreshRefusalReason(
  status: string,
  policy: string,
  message: string
): string {
  switch (status) {
    case "auth_missing":
      return `linear_refresh_auth_missing: LINEAR_API_KEY is not set in the workflow process environment; ${message}`;
    case "policy_denied":
      return `linear_refresh_policy_denied: intent_apply_policy=${policy}; ${message}`;
    default:
      return `linear_refresh_${status}: ${message}`;
  }
}

function linearRefreshAlreadyAppliedSuccess(
  intent: UpdateIntent,
  source: SourceItem,
  audit: NonNullable<ReturnType<typeof getLatestIntentApplyAudit>>
): ExecuteExternalApplySuccess {
  return {
    ok: true,
    resultCode: "applied",
    context: {
      intentId: intent.id,
      intentStatus: intent.status,
      adapterKind: "linear",
      intentType: intent.intentType,
      target: {
        adapterKind: source.adapterKind,
        externalId: source.externalId,
        externalKey: source.externalKey,
        url: source.url,
        title: source.title
      },
      applyPolicy: {
        value: audit.intentApplyPolicy,
        source: "momentum_policy"
      },
      allowStatusMutation: audit.allowStatusMutation,
      mutationKind: audit.mutationKind,
      auditId: audit.id,
      reconcile: {
        status: "success",
        warning: null
      }
    },
    intent,
    audit,
    external: {
      alreadyApplied: true,
      issueId: source.externalId,
      issueKey: source.externalKey,
      issueUrl: source.url,
      commentId: audit.externalRefs.commentId,
      commentUrl: audit.externalRefs.commentUrl,
      statusTransitioned: audit.externalRefs.stateTransitionId !== null,
      nextStateId: null,
      nextStateName: null,
      idempotencyMarker: audit.idempotencyMarker
    }
  };
}

function linearRefreshOperatorReason(runId: string, stepId: string): string {
  return `daemon external-apply for workflow ${runId}/${stepId}`;
}

function readLinearApiKey(
  env: Record<string, string | undefined>
): string | null {
  const raw = env[LINEAR_API_KEY_ENV_VAR] ?? null;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function loadWorkflowRunIssueScopeIdentifier(
  db: MomentumDb,
  runId: string
): string | null {
  const row = db
    .prepare("SELECT issue_scope_json FROM workflow_runs WHERE id = ?")
    .get(runId) as { issue_scope_json: string | null } | undefined;
  if (row?.issue_scope_json === undefined || row.issue_scope_json === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.issue_scope_json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "identifier" in parsed &&
      typeof (parsed as { identifier?: unknown }).identifier === "string"
    ) {
      const value = (parsed as { identifier: string }).identifier.trim();
      return value.length > 0 ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

function maxDaemonLiveWrapperProfileTimeoutMs(profile: LiveWrapperProfile): number {
  let maxSeconds = 0;
  for (const wrapper of profile.wrappers.values()) {
    maxSeconds = Math.max(
      maxSeconds,
      wrapper.timeoutSec + (wrapper.probe?.timeoutSec ?? 0)
    );
  }
  return maxSeconds * 1000 + DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS;
}
