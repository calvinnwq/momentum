import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  createUpdateIntent,
  listUpdateIntents,
  type UpdateIntent
} from "../intent/update-intents.js";
import {
  getSourceItemById,
  listSourceItems,
  type SourceItem
} from "../source/items.js";
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
import {
  planLinearRefreshAlreadyAppliedReconciliation,
  planLinearRefreshLifecycle,
  type LinearRefreshLifecyclePlan
} from "../workflow/dispatch/linear-refresh-lifecycle.js";
import { buildRealWorkflowStepExecutorRegistry } from "../workflow/step/executor-real-adapters.js";
import type {
  AsyncWorkflowStepDispatch,
  WorkflowStepDispatch
} from "../workflow/dispatch/scheduler.js";
import type { DispatchedStepRepoSafetyContext } from "../workflow/dispatch/executor-run.js";

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
              const repoSafety = resolveDaemonDispatchedRepoSafety(
                context.db,
                claim.runId,
                resolved.exec.repoPath,
                resolved.exec.runDir
              );
              if (!repoSafety.ok) return repoSafety;
              return {
                ok: true,
                exec: {
                  ...resolved.exec,
                  repoSafety: repoSafety.repoSafety,
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

function resolveDaemonDispatchedRepoSafety(
  db: MomentumDb,
  runId: string,
  repoPath: string,
  runDir: string
):
  | { ok: true; repoSafety: DispatchedStepRepoSafetyContext }
  | { ok: false; reason: string } {
  const head = readGitHead(repoPath);
  if (!head.ok) return { ok: false, reason: head.reason };
  const verification = loadWorkflowRunVerificationConfig(db, runId, repoPath);
  if (!verification.ok) return { ok: false, reason: verification.reason };
  return {
    ok: true,
    repoSafety: {
      baseHead: head.head,
      verificationCommands: verification.commands,
      verificationTimeoutSec: verification.timeoutSec,
      verificationLogPath: path.join(runDir, "verification.log")
    }
  };
}

function readGitHead(
  repoPath: string
): { ok: true; head: string } | { ok: false; reason: string } {
  try {
    const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, head };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `base_head_unavailable: ${detail}` };
  }
}

export const DEFAULT_DISPATCH_VERIFICATION_TIMEOUT_SEC = 900;

/**
 * Resolve the effective verification config for a dispatched run's git
 * finalization, per the repo policy precedence (goal frontmatter >
 * `MOMENTUM.md` > built-in default). Native workflow runs carry no `goal_id`,
 * so without the `MOMENTUM.md` fallback they would finalize wrapper edits with
 * zero verification commands and commit on a vacuously "skipped" verification.
 *
 * Fail-closed cases return `{ ok: false }` so the daemon parks the step for
 * manual recovery instead of committing unverified work: the run row vanished,
 * the goal's stored verification column is malformed, or a present
 * `MOMENTUM.md` cannot be trusted (mirroring how `workflow run start` refuses
 * a present-but-malformed policy rather than silently ignoring it).
 */
export function loadWorkflowRunVerificationConfig(
  db: MomentumDb,
  runId: string,
  repoPath: string
):
  | { ok: true; commands: string[]; timeoutSec: number }
  | { ok: false; reason: string } {
  const row = db
    .prepare(
      `SELECT goals.verification AS verification,
              goals.verification_timeout_sec AS verificationTimeoutSec
         FROM workflow_runs
         LEFT JOIN goals ON goals.id = workflow_runs.goal_id
        WHERE workflow_runs.id = ?`
    )
    .get(runId) as
    | { verification: string | null; verificationTimeoutSec: number | null }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      reason: `verification_config_unavailable: workflow run ${runId} not found`
    };
  }

  const goalCommands = parseVerificationCommands(row.verification);
  if (!goalCommands.ok) {
    return {
      ok: false,
      reason: `verification_config_invalid: goal verification for run ${runId} is not a JSON string array`
    };
  }
  const goalTimeoutSec =
    row.verificationTimeoutSec !== null &&
    Number.isInteger(row.verificationTimeoutSec) &&
    row.verificationTimeoutSec > 0
      ? row.verificationTimeoutSec
      : undefined;
  if (goalCommands.commands !== undefined) {
    return {
      ok: true,
      commands: goalCommands.commands,
      timeoutSec: goalTimeoutSec ?? DEFAULT_DISPATCH_VERIFICATION_TIMEOUT_SEC
    };
  }

  const policy = loadMomentumPolicy(repoPath);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `verification_policy_invalid: (${policy.code}) ${policy.error}`
    };
  }
  const config = policy.present ? policy.policy.config : undefined;
  return {
    ok: true,
    commands:
      config?.verification !== undefined ? [...config.verification] : [],
    timeoutSec:
      goalTimeoutSec ??
      config?.verificationTimeoutSec ??
      DEFAULT_DISPATCH_VERIFICATION_TIMEOUT_SEC
  };
}

function parseVerificationCommands(
  raw: string | null
):
  | { ok: true; commands: string[] | undefined }
  | { ok: false } {
  // A null column means "no goal-backed verification configured" (no goal, or
  // a goal without commands) and defers to the MOMENTUM.md fallback; a
  // present-but-malformed column is untrusted state and fails closed instead
  // of silently skipping verification.
  if (raw === null) return { ok: true, commands: undefined };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return { ok: true, commands: parsed as string[] };
    }
  } catch {
  }
  return { ok: false };
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
  context: { db: MomentumDb; now: number },
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
  let pending = findPendingLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? ""
  );
  const applied = findAppliedLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? ""
  );
  let sourceItemsById = loadLinearRefreshSourceItems(context.db, [
    ...pending,
    ...applied
  ]);
  const latestAuditsByIntentId = loadLatestLinearRefreshAudits(context.db, applied);
  const operatorReason = linearRefreshOperatorReason(runId, stepId);
  const alreadyAppliedLifecycle = planLinearRefreshAlreadyAppliedReconciliation({
    issueScopeIdentifier,
    pendingIntents: pending,
    appliedIntents: applied,
    sourceItemsById,
    latestAuditsByIntentId,
    expectedOperatorReason: operatorReason
  });
  const alreadyAppliedContext = resolveLinearRefreshAlreadyAppliedContext(
    alreadyAppliedLifecycle,
    applied,
    sourceItemsById,
    latestAuditsByIntentId,
    resolved.exec.runDir
  );
  if (alreadyAppliedContext !== null) return alreadyAppliedContext;
  const policy = resolveLinearRefreshPolicy(resolved.exec.repoPath);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `linear_refresh_policy_load_failed: ${policy.code}: ${policy.error}`
    };
  }
  let lifecycle = planLinearRefreshLifecycle({
    env,
    intentApplyPolicy: policy.value,
    issueScopeIdentifier,
    pendingIntents: pending,
    appliedIntents: applied,
    sourceItemsById,
    latestAuditsByIntentId,
    expectedOperatorReason: operatorReason
  });
  if (lifecycle.status === "intent_missing") {
    const seeded = seedLinearRefreshStatusUpdateIntent({
      db: context.db,
      runId,
      issueScopeIdentifier,
      now: context.now
    });
    if (!seeded.ok) {
      return { ok: false, reason: seeded.reason };
    }
    pending = appendIntentIfMissing(pending, seeded.intent);
    sourceItemsById = new Map(sourceItemsById).set(
      seeded.sourceItem.id,
      seeded.sourceItem
    );
    lifecycle = planLinearRefreshLifecycle({
      env,
      intentApplyPolicy: policy.value,
      issueScopeIdentifier,
      pendingIntents: pending,
      appliedIntents: applied,
      sourceItemsById,
      latestAuditsByIntentId,
      expectedOperatorReason: operatorReason
    });
  }
  const lifecycleAlreadyAppliedContext = resolveLinearRefreshAlreadyAppliedContext(
    lifecycle,
    applied,
    sourceItemsById,
    latestAuditsByIntentId,
    resolved.exec.runDir
  );
  if (lifecycleAlreadyAppliedContext !== null) return lifecycleAlreadyAppliedContext;
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

function resolveLinearRefreshAlreadyAppliedContext(
  lifecycle: LinearRefreshLifecyclePlan | null,
  applied: readonly UpdateIntent[],
  sourceItemsById: ReadonlyMap<string, SourceItem>,
  latestAuditsByIntentId: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof getLatestIntentApplyAudit>>
  >,
  runDir: string
): DispatchedExternalApplyContextResolution | null {
  if (lifecycle?.status !== "already_applied") return null;

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
      executorLogPath: path.join(runDir, "external-apply.log"),
      resultJsonPath: path.join(runDir, "external-apply.json")
    },
    runExternalApply: async () =>
      linearRefreshAlreadyAppliedSuccess(intent, source, audit)
  };
}

function seedLinearRefreshStatusUpdateIntent(input: {
  db: MomentumDb;
  runId: string;
  issueScopeIdentifier: string | null;
  now: number;
}):
  | { ok: true; intent: UpdateIntent; sourceItem: SourceItem }
  | { ok: false; reason: string } {
  const issueScopeIdentifier = input.issueScopeIdentifier?.trim() || null;
  if (issueScopeIdentifier === null) {
    return {
      ok: false,
      reason: "linear_refresh_issue_scope_missing: cannot seed status_update intent without workflow issue scope"
    };
  }

  const matches = listSourceItems(input.db, { adapterKind: "linear" }).filter(
    (sourceItem) =>
      sourceItem.externalId === issueScopeIdentifier ||
      sourceItem.externalKey === issueScopeIdentifier
  );
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `linear_refresh_source_missing: no Linear source item matches workflow issue scope ${issueScopeIdentifier}`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `linear_refresh_source_ambiguous: ${matches.length} Linear source items match workflow issue scope ${issueScopeIdentifier}`
    };
  }

  const sourceItem = matches[0]!;
  const intent = createUpdateIntent(
    input.db,
    {
      adapterKind: "linear",
      targetExternalId: sourceItem.externalId,
      intentType: "status_update",
      payload: { state: "Done" },
      reason: `Workflow ${input.runId} reached linear-refresh for ${issueScopeIdentifier}; update Linear issue to Done.`,
      sourceItemId: sourceItem.id,
      idempotencyKey: `linear:${sourceItem.externalId}:status_update:done`
    },
    { now: () => input.now }
  ).intent;

  if (intent.status !== "pending") {
    return {
      ok: false,
      reason: `linear_refresh_intent_${intent.status}: seeded status_update intent ${intent.id} is ${intent.status}, not pending`
    };
  }
  return { ok: true, intent, sourceItem };
}

function appendIntentIfMissing(
  intents: readonly UpdateIntent[],
  intent: UpdateIntent
): UpdateIntent[] {
  if (intents.some((candidate) => candidate.id === intent.id)) {
    return [...intents];
  }
  return [...intents, intent];
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
    resultCode: "already_applied",
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
