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
  type ExecuteExternalApplyDeps
} from "../intent/apply-execute.js";
import {
  listUpdateIntents,
  type UpdateIntent
} from "../intent/update-intents.js";
import { getSourceItemById } from "../source/items.js";
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
  if (issueScopeIdentifier === null) {
    return { ok: false, reason: "external_apply_issue_scope_missing" };
  }

  const pending = findPendingLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier
  );
  if (pending.length === 0) {
    return { ok: false, reason: "external_apply_intent_not_found" };
  }
  if (pending.length > 1) {
    return { ok: false, reason: "external_apply_intent_ambiguous" };
  }

  const intentId = pending[0]!.id;
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
        operatorReason: `daemon external-apply for workflow ${runId}/${stepId}`,
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

function pendingLinearIntentMatchesIssueScope(
  db: MomentumDb,
  intent: UpdateIntent,
  issueScopeIdentifier: string
): boolean {
  if (intent.targetExternalId === issueScopeIdentifier) return true;
  if (intent.sourceItemId === null) return false;

  const sourceItem = getSourceItemById(db, intent.sourceItemId);
  if (sourceItem === null || sourceItem.adapterKind !== "linear") return false;
  return (
    sourceItem.externalId === issueScopeIdentifier ||
    sourceItem.externalKey === issueScopeIdentifier
  );
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
