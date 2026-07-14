import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { MomentumDb } from "../../adapters/db.js";
import {
  createPersistedProfileDelegateToolAdapter,
  createProfileBackedDelegateToolAdapter,
  resolveDelegateBranch,
} from "../../adapters/profile-backed-delegate-tool-adapter.js";
import type { LiveWrapperProfile } from "../../adapters/live-wrapper-registry.js";
import type { LinearExternalUpdateClient } from "../../adapters/linear-external-update-client.js";
import type { LinearIssueRefreshClient } from "../../adapters/linear-issue-refresh.js";
import { inspectRepo } from "../repo/guard.js";
import {
  acquireRepoLock,
  getActiveRepoLockForJob,
  markRepoLockNeedsManualRecovery,
  reclaimRepoLock,
  transferRepoLock,
  releaseRepoLock,
  updateRepoLockHeartbeat,
} from "../repo/locks.js";
import {
  defaultBuildLinearRefreshClient,
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
  type ExecuteExternalApplySuccess,
  type ExecuteExternalApplyDeps,
} from "../intent/apply-execute.js";
import { getLatestIntentApplyAudit } from "../intent/apply-audits.js";
import {
  loadMomentumPolicy,
  resolveIntentApplyPolicy,
  type UpdateIntentApplyPolicy,
} from "../intent/policy.js";
import {
  createUpdateIntent,
  listUpdateIntents,
  type UpdateIntent,
} from "../intent/update-intents.js";
import {
  getSourceItemById,
  listSourceItems,
  type SourceItem,
} from "../source/items.js";
import { DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS } from "./loop.js";
import {
  DAEMON_EXECUTOR_CONFIG_ENV_VAR,
  resolveDaemonExecutorRegistry,
} from "../executors/sdk/daemon-config.js";
import {
  LiveStepSdkExecutor,
  liveStepBuiltInConfigSchema,
  type LiveStepSdkHostBindings,
} from "../executors/live-step/sdk-executor.js";
import {
  DelegateSupervisorExecutor,
  DELEGATE_SUPERVISOR_EXECUTOR_NAME,
  DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
  DELEGATE_SUPERVISOR_HANDOFF_STAGE,
} from "../executors/delegate-supervisor/executor.js";
import type { DelegateSupervisorHostBindings } from "../executors/delegate-supervisor/types.js";
import type { Executor } from "../executors/sdk/types.js";
import type { ExecutorRegistryLoadResult } from "../executors/sdk/registry.js";
import {
  loadDispatchedStepRunProvenance,
  resolveDispatchedStepExecutorContext,
} from "../workflow/live-wrapper/daemon-exec-context.js";
import {
  readDaemonLiveWrapperProfileSource,
  resolveDaemonLiveWrapperProfile,
  DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR,
} from "../workflow/live-wrapper/daemon-profile.js";
import {
  buildCodingWorkflowChildEnv,
  loadCodingWorkflowWrapperConfig,
} from "../workflow/live-wrapper/coding-workflow.js";
import { resolveDaemonWorkflowDispatch as resolveDogfoodDaemonWorkflowDispatch } from "../workflow/dispatch/dogfood.js";
import {
  createExternalApplyWorkflowDispatch,
  type DispatchedExternalApplyContextResolution,
} from "../workflow/dispatch/external-apply-dispatch.js";
import {
  createRegisteredExecutorWorkflowDispatch,
  RegisteredExecutorHostBindingsError,
} from "../workflow/dispatch/registered-executor.js";
import { createSubworkflowWorkflowDispatch } from "../workflow/dispatch/subworkflow-dispatch.js";
import { deriveDispatchedSubworkflowContext } from "../workflow/route/subworkflow-dispatch-context.js";
import {
  planLinearRefreshAlreadyAppliedReconciliation,
  planLinearRefreshLifecycle,
  type LinearRefreshLifecyclePlan,
} from "../workflow/dispatch/linear-refresh-lifecycle.js";
import { buildRealWorkflowStepExecutorRegistry } from "../workflow/step/executor-real-adapters.js";
import {
  isWorkflowExecutorFamily,
  WORKFLOW_EXECUTOR_FAMILIES,
} from "../workflow/definition/definition.js";
import { resolveWorkflowStepExecutorRuntime } from "../workflow/dispatch/persist.js";
import {
  buildDispatchedStepExecutorInput,
  type DispatchedStepRepoSafetyContext,
} from "../workflow/dispatch/executor-context.js";
import {
  deriveDispatchInvocationId,
  resolveWorkflowStepDispatchRouteSelection,
} from "../workflow/dispatch/execute.js";
import { loadExecutorInvocation } from "../executors/loop/persist.js";
import { heartbeatWorkflowLease } from "../workflow/leases.js";
import { getWorkflowStep } from "../workflow/step/transitions.js";
import {
  dispatchWorkflowStepExecutor,
  type WorkflowStepExecutorKind,
} from "../workflow/step/executor.js";
import {
  WORKFLOW_RECOVERY_CLASSIFICATIONS,
  writeWorkflowRecoveryArtifactInRunDir,
  type WorkflowRecoveryClassification,
} from "../workflow/recovery/artifact.js";
import type {
  AsyncWorkflowStepDispatch,
  WorkflowStepDispatch,
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
    input: LinearExternalUpdateClientFactoryInput,
  ) => LinearExternalUpdateClient;
  buildLinearIssueRefreshClient?: (
    input: LinearIssueRefreshClientFactoryInput,
  ) => LinearIssueRefreshClient | null;
};

export type DaemonWorkflowDispatchResolution =
  | { ok: true; dispatch: AsyncWorkflowStepDispatch; leaseDurationMs?: number }
  | { ok: false; message: string };

export function resolveDaemonWorkflowStepDispatch(
  env: Record<string, string | undefined>,
  baseDispatch: WorkflowStepDispatch,
  deps: DaemonWorkflowDispatchDeps,
): DaemonWorkflowDispatchResolution {
  const profile = resolveDaemonLiveWrapperProfile(env, {
    loadSource: readDaemonLiveWrapperProfileSource,
  });

  if (profile.status === "invalid") {
    return {
      ok: false,
      message: `Invalid ${DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR} (${profile.source}): ${profile.code}: ${profile.error}`,
    };
  }
  const builtIns =
    profile.status === "resolved" ? buildProfileBackedSdkExecutors() : [];
  const executorConfig = resolveDaemonExecutorRegistry(env, builtIns);
  if (executorConfig.status === "invalid") {
    return {
      ok: false,
      message: `Invalid ${DAEMON_EXECUTOR_CONFIG_ENV_VAR} (${executorConfig.source}): ${executorConfig.message}`,
    };
  }

  let legacy: DaemonWorkflowDispatchResolution;
  if (profile.status === "not_configured") {
    legacy = {
      ok: true,
      dispatch: withSubworkflowDispatch(
        withExternalApplyDispatch(
          resolveDogfoodDaemonWorkflowDispatch(env, baseDispatch),
          env,
          deps,
        ),
      ),
    };
  } else {
    const liveRegistry = buildRealWorkflowStepExecutorRegistry({
      profile: profile.profile,
    });
    const registry = new Map(
      builtIns.map((executor) => [executor.name, executor]),
    );
    const resolveHostBindings = createLiveStepHostBindingsResolver(
      env,
      liveRegistry,
      profile.profile,
    );
    legacy = {
      ok: true,
      dispatch: withSubworkflowDispatch(
        withExternalApplyDispatch(
          createRegisteredExecutorWorkflowDispatch(baseDispatch, {
            registry,
            resolveHostBindings,
            // A delegated handoff is one durable SDK round; allow only that
            // executor to perform its first bounded read under the same claim.
            resolveMaxTicks: ({ executorName, invocation, context }) =>
              executorName === DELEGATE_SUPERVISOR_EXECUTOR_NAME &&
              !hasAnyCompletedDelegateHandoff(
                context.db,
                invocation.invocationId,
              )
                ? 2
                : 1,
          }),
          env,
          deps,
        ),
      ),
      leaseDurationMs: maxDaemonLiveWrapperProfileTimeoutMs(profile.profile),
    };
  }
  if (!legacy.ok) return legacy;

  if (executorConfig.status === "not_configured") {
    const unavailableDispatch = createRegisteredExecutorWorkflowDispatch(
      baseDispatch,
      { registry: new Map() },
    );
    return {
      ok: true,
      dispatch: (claim, context) => {
        const runtime = resolveWorkflowStepExecutorRuntime(context.db, claim);
        return runtime.ok && !isWorkflowExecutorFamily(runtime.executorName)
          ? unavailableDispatch(claim, context)
          : legacy.dispatch(claim, context);
      },
      ...(legacy.leaseDurationMs !== undefined
        ? { leaseDurationMs: legacy.leaseDurationMs }
        : {}),
    };
  }

  let registeredDispatch: AsyncWorkflowStepDispatch | undefined;
  let registeredLoad: ExecutorRegistryLoadResult | undefined;
  const profileHostBindings =
    profile.status === "resolved"
      ? createLiveStepHostBindingsResolver(
          env,
          buildRealWorkflowStepExecutorRegistry({ profile: profile.profile }),
          profile.profile,
        )
      : undefined;
  return {
    ok: true,
    dispatch: async (claim, context) => {
      const loaded = await executorConfig.load();
      const unavailableReasons = new Map(
        loaded.ok
          ? []
          : loaded.diagnostics.map(
              (item) =>
                [item.executor, `${item.code}: ${item.message}`] as const,
            ),
      );
      const runtime = resolveWorkflowStepExecutorRuntime(context.db, claim);
      if (
        runtime.ok &&
        (loaded.registry.has(runtime.executorName) ||
          unavailableReasons.has(runtime.executorName) ||
          !isWorkflowExecutorFamily(runtime.executorName))
      ) {
        if (registeredDispatch === undefined || registeredLoad !== loaded) {
          registeredDispatch = createRegisteredExecutorWorkflowDispatch(
            baseDispatch,
            {
              registry: loaded.registry,
              unavailableReasons,
              ...(profileHostBindings !== undefined
                ? { resolveHostBindings: profileHostBindings }
                : {}),
            },
          );
          registeredLoad = loaded;
        }
        return registeredDispatch(claim, context);
      }
      return legacy.dispatch(claim, context);
    },
    ...(legacy.leaseDurationMs !== undefined
      ? { leaseDurationMs: legacy.leaseDurationMs }
      : {}),
  };
}

function buildProfileBackedSdkExecutors(): Executor[] {
  return WORKFLOW_EXECUTOR_FAMILIES.filter(
    (name) => name !== "external-apply" && name !== "subworkflow",
  ).map((name) =>
    name === "delegate-supervisor"
      ? new DelegateSupervisorExecutor()
      : new LiveStepSdkExecutor(name, liveStepBuiltInConfigSchema(name)),
  );
}

function createLiveStepHostBindingsResolver(
  env: Record<string, string | undefined>,
  liveRegistry: ReturnType<typeof buildRealWorkflowStepExecutorRegistry>,
  profile: LiveWrapperProfile,
) {
  return (input: {
    claim: Parameters<AsyncWorkflowStepDispatch>[0];
    context: Parameters<AsyncWorkflowStepDispatch>[1];
    executor: Executor;
    executorName: string;
    config: Readonly<Record<string, unknown>>;
  }):
    | LiveStepSdkHostBindings
    | DelegateSupervisorHostBindings
    | Record<string, never> => {
    const isLiveStep = input.executor instanceof LiveStepSdkExecutor;
    const isDelegate = input.executor instanceof DelegateSupervisorExecutor;
    if (!isLiveStep && !isDelegate) return {};
    const { claim, context } = input;
    const provenance = loadDispatchedStepRunProvenance(context.db, claim.runId);
    if (provenance === undefined) {
      throw new RegisteredExecutorHostBindingsError(
        "runtime_unavailable",
        "run_not_found",
      );
    }
    const resolved = resolveDispatchedStepExecutorContext(
      claim.runId,
      provenance,
    );
    if (!resolved.ok) {
      throw new RegisteredExecutorHostBindingsError(
        "runtime_unavailable",
        resolved.reason,
      );
    }
    const invocation = loadExecutorInvocation(
      context.db,
      deriveDispatchInvocationId(claim.runId, claim.stepId),
    );
    if (invocation === undefined)
      throw new Error("dispatch_invocation_not_found");
    const delegateTool = isDelegate
      ? resolveDelegateToolName(input.config)
      : undefined;
    const delegateStepKind = isDelegate
      ? resolveProfileBackedDelegateToolStepKind(delegateTool!)
      : null;
    if (isDelegate && delegateStepKind === null) {
      return { tools: new Map() };
    }
    if (
      isLiveStep &&
      hasCompletedLiveStepMechanism(
        context.db,
        invocation.invocationId,
        invocation.attempt,
      )
    ) {
      const settleRepoOwnership = recoverCompletedLiveStepRepoOwnership(
        context.db,
        claim.runId,
        claim.stepId,
        invocation.attempt,
        context.now,
      );
      return {
        repoPath: resolved.exec.repoPath,
        run: () => {
          throw new Error(
            "completed live-step replay attempted to rerun its mechanism",
          );
        },
        ...(settleRepoOwnership !== undefined ? { settleRepoOwnership } : {}),
      };
    }
    if (
      isDelegate &&
      hasCompletedLiveStepMechanism(
        context.db,
        invocation.invocationId,
        invocation.attempt,
      )
    ) {
      const settleHandoff = recoverCompletedLiveStepRepoOwnership(
        context.db,
        claim.runId,
        claim.stepId,
        invocation.attempt,
        context.now,
      );
      return {
        tools: new Map(),
        ...(settleHandoff !== undefined ? { settleHandoff } : {}),
      };
    }
    const noMistakesRuntime =
      delegateTool === "no-mistakes"
        ? resolveNoMistakesStatusRuntime(env, profile)
        : undefined;
    if (
      isDelegate &&
      hasCompletedDelegateHandoff(
        context.db,
        invocation.invocationId,
        invocation.attempt,
      )
    ) {
      const adapter = createPersistedProfileDelegateToolAdapter({
        tool: delegateTool!,
        repoPath: resolved.exec.repoPath,
        command: noMistakesRuntime?.command ?? "no-mistakes",
        argsPrefix: noMistakesRuntime?.argsPrefix ?? [],
        env: noMistakesRuntime?.env ?? {},
      });
      const settleHandoff = recoverCompletedLiveStepRepoOwnership(
        context.db,
        claim.runId,
        claim.stepId,
        invocation.attempt,
        context.now,
      );
      return {
        tools: new Map([[adapter.name, adapter]]),
        ...(settleHandoff !== undefined ? { settleHandoff } : {}),
      };
    }
    const safety = resolveDaemonDispatchedRepoSafety(
      context.db,
      claim.runId,
      resolved.exec.repoPath,
      resolved.exec.runDir,
    );
    if (!safety.ok) {
      if (safety.recoveryArtifact !== null) {
        writeLiveStepHostRecoveryArtifact({
          runId: claim.runId,
          stepId: claim.stepId,
          runDir: resolved.exec.runDir,
          repoPath: resolved.exec.repoPath,
          recoveryCode: safety.recoveryCode,
          reason: safety.reason,
          now: context.now,
        });
      }
      throw new RegisteredExecutorHostBindingsError(
        safety.recoveryCode,
        safety.reason,
      );
    }
    const attempt = invocation.attempt;
    const artifactRoot = isDelegate
      ? path.join(safety.runDir, "delegate", claim.stepId)
      : safety.runDir;
    const runDir =
      attempt <= 1
        ? artifactRoot
        : path.join(artifactRoot, `attempt-${attempt}`);
    try {
      fs.mkdirSync(runDir, { recursive: true });
    } catch (error) {
      throw new RegisteredExecutorHostBindingsError(
        "runtime_unavailable",
        `run_dir_unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const resultJsonPath = path.join(
      runDir,
      path.basename(resolved.exec.resultJsonPath),
    );
    const executorLogPath = path.join(
      runDir,
      path.basename(resolved.exec.executorLogPath),
    );
    const step = getWorkflowStep(context.db, claim.runId, claim.stepId);
    if (step === undefined) throw new Error("workflow_step_not_found");
    const selection = resolveWorkflowStepDispatchRouteSelection(
      context.db,
      claim,
    );
    if (!selection.ok) throw new Error(selection.reason);
    const repoOwnership = acquireLiveStepRepoOwnership({
      claim,
      context,
      repoPath: safety.repoPath,
      attempt,
      repoSafety: safety.repoSafety,
      runnerWindowMs: maxDaemonLiveWrapperProfileTimeoutMs(profile),
      reclaimHandoffAttempt: isDelegate
        ? findInterruptedDelegateHandoffAttempt(
            context.db,
            invocation.invocationId,
            attempt,
          )
        : undefined,
    });
    if (!repoOwnership.ok) {
      throw new RegisteredExecutorHostBindingsError(
        repoOwnership.recoveryCode,
        repoOwnership.error,
      );
    }
    const repoSafety = {
      ...safety.repoSafety,
      verificationLogPath: path.join(
        runDir,
        path.basename(safety.repoSafety.verificationLogPath),
      ),
      beforeGitMutation: repoOwnership.authorizeMutation,
    };
    const dispatchKind = isDelegate ? delegateStepKind! : step.kind;
    const executorInput = buildDispatchedStepExecutorInput(
      dispatchKind,
      claim.runId,
      claim.stepId,
      {
        repoPath: safety.repoPath,
        runDir,
        resultJsonPath,
        executorLogPath,
        attempt,
        env,
        config: { ...input.config },
      },
      selection.selection,
    );
    if (isDelegate) {
      const statePath = path.join(runDir, "delegate-external-state.json");
      const handoffReceiptPath = path.join(
        artifactRoot,
        "delegate-handoff.json",
      );
      const adapter = createProfileBackedDelegateToolAdapter({
        tool: delegateTool!,
        invocationId: invocation.invocationId,
        attempt,
        branch: resolveDelegateBranch(safety.repoPath),
        headSha: repoSafety.baseHead,
        statePath,
        handoffReceiptPath,
        resultJsonPath,
        executorLogPath,
        repoPath: safety.repoPath,
        repoSafety,
        statusCommand: noMistakesRuntime?.command ?? "no-mistakes",
        statusArgsPrefix: noMistakesRuntime?.argsPrefix ?? [],
        statusEnv: noMistakesRuntime?.env ?? {},
        legacyPaths: {
          rootDir: safety.runDir,
          handoffReceiptPath: path.join(safety.runDir, "delegate-handoff.json"),
        },
        run: () =>
          dispatchWorkflowStepExecutor(
            dispatchKind,
            executorInput,
            liveRegistry,
          ),
      });
      return {
        tools: new Map([[adapter.name, adapter]]),
        settleHandoff: repoOwnership.settle,
      };
    }
    return {
      repoPath: safety.repoPath,
      repoSafety,
      run: () =>
        dispatchWorkflowStepExecutor(step.kind, executorInput, liveRegistry),
      settleRepoOwnership: repoOwnership.settle,
    };
  };
}

function recoverCompletedLiveStepRepoOwnership(
  db: MomentumDb,
  runId: string,
  stepId: string,
  attempt: number,
  now: number,
): ((provenClean: boolean) => void) | undefined {
  const lock = getActiveRepoLockForJob(
    db,
    deriveDispatchInvocationId(runId, stepId),
  );
  if (
    lock === undefined ||
    lock.goal_id !== runId ||
    lock.iteration !== attempt
  ) {
    return undefined;
  }
  let settled = false;
  return (provenClean) => {
    if (settled) return;
    settled = true;
    if (provenClean) {
      releaseRepoLock(db, {
        lockId: lock.id,
        holder: lock.holder,
        iteration: lock.iteration,
        now,
      });
    } else {
      markRepoLockNeedsManualRecovery(db, {
        lockId: lock.id,
        holder: lock.holder,
        iteration: lock.iteration,
        now,
        recoveryStatus: `completed executor mechanism for ${runId}/${stepId} requires manual repository recovery`,
      });
    }
  };
}

function hasCompletedLiveStepMechanism(
  db: MomentumDb,
  invocationId: string,
  attempt: number,
): boolean {
  return hasExecutorCheckpoint(
    db,
    invocationId,
    "mechanism_completed",
    attempt,
  );
}

function hasCompletedDelegateHandoff(
  db: MomentumDb,
  invocationId: string,
  attempt: number,
): boolean {
  return hasExecutorCheckpoint(
    db,
    invocationId,
    DELEGATE_SUPERVISOR_HANDOFF_STAGE,
    attempt,
  );
}

function findInterruptedDelegateHandoffAttempt(
  db: MomentumDb,
  invocationId: string,
  attempt: number,
): number | undefined {
  const row = db
    .prepare(
      `SELECT intent_round.attempt AS attempt
         FROM executor_rounds AS intent_round
         JOIN executor_checkpoints AS intent
           ON intent.round_id = intent_round.round_id
        WHERE intent_round.invocation_id = ?
          AND intent_round.attempt <= ?
          AND intent.stage = ?
          AND NOT EXISTS (
            SELECT 1
              FROM executor_rounds AS completed_round
              JOIN executor_checkpoints AS completed
                ON completed.round_id = completed_round.round_id
             WHERE completed_round.invocation_id = intent_round.invocation_id
               AND completed_round.round_index >= intent_round.round_index
               AND completed.stage = ?
          )
        ORDER BY intent_round.round_index DESC
        LIMIT 1`,
    )
    .get(
      invocationId,
      attempt,
      DELEGATE_SUPERVISOR_HANDOFF_INTENT_STAGE,
      DELEGATE_SUPERVISOR_HANDOFF_STAGE,
    ) as { attempt: number } | undefined;
  return row?.attempt;
}

function hasAnyCompletedDelegateHandoff(
  db: MomentumDb,
  invocationId: string,
): boolean {
  return hasExecutorCheckpoint(
    db,
    invocationId,
    DELEGATE_SUPERVISOR_HANDOFF_STAGE,
  );
}

function hasExecutorCheckpoint(
  db: MomentumDb,
  invocationId: string,
  stage: string,
  attempt?: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM executor_rounds AS r
         JOIN executor_checkpoints AS c ON c.round_id = r.round_id
        WHERE r.invocation_id = ?
          AND c.stage = ?
          ${attempt === undefined ? "" : "AND r.attempt = ?"}
        LIMIT 1`,
    )
    .get(
      ...(attempt === undefined
        ? [invocationId, stage]
        : [invocationId, stage, attempt]),
    );
  return row !== undefined;
}

function resolveDelegateToolName(
  config: Readonly<Record<string, unknown>>,
): string {
  const tool = config["tool"];
  if (typeof tool !== "string" || tool.trim().length === 0) {
    throw new RegisteredExecutorHostBindingsError(
      "invalid_input",
      "delegate-supervisor config requires a non-empty tool name",
    );
  }
  return tool;
}

/** Map portable built-in tool config to the host's live-wrapper step kind. */
export function resolveProfileBackedDelegateToolStepKind(
  tool: string,
): WorkflowStepExecutorKind | null {
  switch (tool) {
    case "gnhf":
      return "implementation";
    case "no-mistakes":
      return "no-mistakes";
    default:
      return null;
  }
}

function resolveNoMistakesStatusRuntime(
  daemonEnv: Record<string, string | undefined>,
  profile: LiveWrapperProfile,
): {
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string | undefined>;
} {
  const outerWrapper = profile.wrappers.get("no-mistakes");
  if (outerWrapper === undefined) {
    throw new RegisteredExecutorHostBindingsError(
      "runtime_unavailable",
      "no-mistakes live-wrapper config is unavailable for status polling",
    );
  }
  const wrapperEnv: NodeJS.ProcessEnv = {};
  for (const key of outerWrapper.envAllow) {
    const value = daemonEnv[key];
    if (value !== undefined) wrapperEnv[key] = value;
  }
  const loaded = loadCodingWorkflowWrapperConfig({
    env: wrapperEnv,
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });
  if (!loaded.ok) {
    throw new RegisteredExecutorHostBindingsError(
      "runtime_unavailable",
      loaded.error,
    );
  }
  const stepConfig = loaded.config.steps["no-mistakes"];
  const argsPrefix =
    stepConfig?.command !== undefined &&
    path.basename(stepConfig.command) === "no-mistakes"
      ? []
      : stepConfig?.command !== undefined &&
          path.basename(stepConfig.command) === "env" &&
          stepConfig.args[0] !== undefined &&
          path.basename(stepConfig.args[0]) === "no-mistakes"
        ? [stepConfig.args[0]]
        : null;
  if (stepConfig?.command === undefined || argsPrefix === null) {
    throw new RegisteredExecutorHostBindingsError(
      "runtime_unavailable",
      "no-mistakes status polling requires the validated no-mistakes executable from the coding-wrapper config",
    );
  }
  return {
    command: stepConfig.command,
    argsPrefix,
    env: buildCodingWorkflowChildEnv(wrapperEnv, stepConfig.envAllow),
  };
}

function writeLiveStepHostRecoveryArtifact(input: {
  runId: string;
  stepId: string;
  runDir: string;
  repoPath: string;
  recoveryCode: string;
  reason: string;
  now: number;
}): void {
  if (
    !(WORKFLOW_RECOVERY_CLASSIFICATIONS as readonly string[]).includes(
      input.recoveryCode,
    )
  ) {
    return;
  }
  try {
    writeWorkflowRecoveryArtifactInRunDir({
      runDir: input.runDir,
      input: {
        runId: input.runId,
        stepId: input.stepId,
        classification: input.recoveryCode as WorkflowRecoveryClassification,
        reason: input.reason,
        recommendedNextAction: {
          code: `investigate_${input.recoveryCode}`,
          detail:
            "Inspect the recorded executor and repository evidence, repair the blocking condition, then clear recovery explicitly.",
          stepId: input.stepId,
        },
        evidencePointers: [],
        repoPath: input.repoPath,
        classifiedAt: input.now,
      },
    });
  } catch {
    // Durable recovery state remains authoritative if artifact rendering fails.
  }
}

type LiveStepRepoOwnership =
  | {
      ok: true;
      authorizeMutation: () => { ok: true } | { ok: false; error: string };
      settle: (provenClean: boolean) => void;
    }
  | { ok: false; error: string; recoveryCode: string };

function acquireLiveStepRepoOwnership(input: {
  claim: Parameters<AsyncWorkflowStepDispatch>[0];
  context: Parameters<AsyncWorkflowStepDispatch>[1];
  repoPath: string;
  attempt: number;
  repoSafety: DispatchedStepRepoSafetyContext;
  runnerWindowMs: number;
  reclaimHandoffAttempt: number | undefined;
}): LiveStepRepoOwnership {
  const { claim, context, repoPath, attempt, repoSafety } = input;
  const wallClockOffset = context.now - Date.now();
  const now = () => Date.now() + wallClockOffset;
  const extensionMs = liveStepOwnershipExtensionMs(
    claim,
    repoSafety,
    input.runnerWindowMs,
  );
  const acquiredAt = now();
  const repoRoot = repoSafety.repoRoot ?? repoPath;
  const jobId = deriveDispatchInvocationId(claim.runId, claim.stepId);
  const existing =
    input.reclaimHandoffAttempt !== undefined
      ? getActiveRepoLockForJob(context.db, jobId)
      : undefined;
  const reclaimed =
    existing !== undefined &&
    input.reclaimHandoffAttempt !== undefined &&
    existing.iteration >= input.reclaimHandoffAttempt &&
    existing.iteration <= attempt &&
    (existing.lease_expires_at < acquiredAt ||
      context.staleDispatchTakeover?.previousHolder === existing.holder) &&
    (existing.lease_expires_at < acquiredAt
      ? reclaimRepoLock
      : transferRepoLock)(context.db, {
      lockId: existing.id,
      repoRoot,
      previousHolder: existing.holder,
      holder: context.workerId,
      goalId: claim.runId,
      previousIteration: existing.iteration,
      previousLeaseExpiresAt: existing.lease_expires_at,
      iteration: attempt,
      jobId,
      heartbeatAt: acquiredAt,
      leaseExpiresAt: acquiredAt + extensionMs,
    }).ok;
  let lockId: string;
  if (reclaimed && existing !== undefined) {
    lockId = existing.id;
  } else {
    const acquired = acquireRepoLock(context.db, {
      repoRoot,
      holder: context.workerId,
      goalId: claim.runId,
      iteration: attempt,
      jobId,
      leaseExpiresAt: acquiredAt + extensionMs,
      now: acquiredAt,
    });
    if (!acquired.ok) {
      return {
        ok: false,
        error: `repository ${repoPath} is locked by ${acquired.existing.holder} (run ${acquired.existing.goal_id}, ${acquired.existing.job_id})`,
        recoveryCode:
          existing?.id === acquired.existing.id
            ? "delegate_handoff_recovery_required"
            : "repo_lock_lost",
      };
    }
    lockId = acquired.lockId;
  }
  let settled = false;
  return {
    ok: true,
    authorizeMutation: () => {
      const mutationAt = now();
      const heartbeat = heartbeatWorkflowLease(context.db, {
        runId: claim.lease.runId,
        leaseKind: claim.lease.leaseKind,
        holder: claim.lease.holder,
        acquiredAt: claim.lease.acquiredAt,
        heartbeatAt: mutationAt,
        expiresAt: mutationAt + extensionMs,
      });
      if (!heartbeat.ok) {
        return {
          ok: false,
          error: `dispatch lease for ${claim.runId}/${claim.stepId} is no longer held by ${claim.lease.holder}`,
        };
      }
      const lockBeat = updateRepoLockHeartbeat(context.db, {
        lockId,
        holder: context.workerId,
        iteration: attempt,
        heartbeatAt: mutationAt,
        leaseExpiresAt: mutationAt + extensionMs,
      });
      return lockBeat.ok
        ? { ok: true }
        : {
            ok: false,
            error: `repo lock for ${claim.runId}/${claim.stepId} is no longer active`,
          };
    },
    settle: (provenClean) => {
      if (settled) return;
      settled = true;
      const settledAt = now();
      if (provenClean) {
        releaseRepoLock(context.db, {
          lockId,
          holder: context.workerId,
          iteration: attempt,
          now: settledAt,
        });
      } else {
        markRepoLockNeedsManualRecovery(context.db, {
          lockId,
          holder: context.workerId,
          iteration: attempt,
          now: settledAt,
          recoveryStatus: `dispatched step ${claim.runId}/${claim.stepId} parked with an unproven worktree; inspect the repository before clearing`,
        });
      }
    },
  };
}

function liveStepOwnershipExtensionMs(
  claim: Parameters<AsyncWorkflowStepDispatch>[0],
  repoSafety: DispatchedStepRepoSafetyContext,
  runnerWindowMs: number,
): number {
  const leaseDurationMs = Math.max(
    1,
    claim.lease.expiresAt - claim.lease.acquiredAt,
  );
  const verificationWindowMs =
    Math.max(1, repoSafety.verificationCommands.length) *
    repoSafety.verificationTimeoutSec *
    1000;
  return Math.max(leaseDurationMs, runnerWindowMs) + verificationWindowMs;
}

function resolveDaemonDispatchedRepoSafety(
  db: MomentumDb,
  runId: string,
  repoPath: string,
  runDir: string,
):
  | {
      ok: true;
      repoPath: string;
      runDir: string;
      repoSafety: DispatchedStepRepoSafetyContext;
    }
  | {
      ok: false;
      reason: string;
      recoveryCode: string;
      recoveryArtifact?: { runDir: string; repoPath?: string | null } | null;
    } {
  const repo = inspectRepo(repoPath);
  if (!repo.ok) {
    const recoveryCode =
      repo.code === "dirty_worktree" || repo.code === "git_failed"
        ? "git_failed"
        : "invalid_input";
    return {
      ok: false,
      reason: `repo_safety_unavailable: ${repo.error}`,
      recoveryCode,
    };
  }
  const canonicalRunDir = canonicalizeRunDir(repoPath, repo.repoPath, runDir);
  const artifactSafety = verifyRepoLocalRunDirIgnored(
    repo.repoPath,
    canonicalRunDir,
  );
  if (!artifactSafety.ok) return artifactSafety;
  const verification = loadWorkflowRunVerificationConfig(
    db,
    runId,
    repo.repoPath,
  );
  if (!verification.ok) {
    // Missing run row / malformed goal verification / malformed MOMENTUM.md
    // are invalid setup inputs needing operator or config repair, never the
    // retryable `runtime_unavailable` class.
    return {
      ok: false,
      reason: verification.reason,
      recoveryCode: "invalid_input",
    };
  }
  return {
    ok: true,
    repoPath: repo.repoPath,
    runDir: canonicalRunDir,
    repoSafety: {
      repoRoot: repo.repoPath,
      baseHead: repo.head,
      verificationCommands: verification.commands,
      verificationTimeoutSec: verification.timeoutSec,
      verificationLogPath: path.join(canonicalRunDir, "verification.log"),
    },
  };
}

function canonicalizeRunDir(
  requestedRepoPath: string,
  canonicalRepoPath: string,
  runDir: string,
): string {
  const requestedRepo = path.resolve(requestedRepoPath);
  const resolvedRunDir = path.resolve(runDir);
  const relativeToRequestedRepo = path.relative(requestedRepo, resolvedRunDir);
  if (
    relativeToRequestedRepo.length > 0 &&
    !relativeToRequestedRepo.startsWith("..") &&
    !path.isAbsolute(relativeToRequestedRepo)
  ) {
    return path.join(canonicalRepoPath, relativeToRequestedRepo);
  }
  return resolvedRunDir;
}

function verifyRepoLocalRunDirIgnored(
  repoPath: string,
  runDir: string,
):
  | { ok: true }
  | {
      ok: false;
      reason: string;
      recoveryCode: string;
      recoveryArtifact?: null;
    } {
  const relativeRunDir = path.relative(repoPath, runDir);
  if (relativeRunDir.startsWith("..") || path.isAbsolute(relativeRunDir)) {
    return { ok: true };
  }
  if (relativeRunDir.length === 0) {
    return {
      ok: false,
      reason:
        "repo_safety_unavailable: run artifact directory resolves to the repository root",
      recoveryCode: "invalid_input",
      recoveryArtifact: null,
    };
  }
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "check-ignore", "-q", "--", relativeRunDir],
      { stdio: "ignore" },
    );
    return { ok: true };
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    if (status === 1) {
      return {
        ok: false,
        reason: `repo_safety_unavailable: run artifact directory ${relativeRunDir} is inside the repository but is not ignored by git`,
        recoveryCode: "invalid_input",
        recoveryArtifact: null,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `repo_safety_unavailable: git check-ignore failed for run artifact directory ${relativeRunDir}: ${detail}`,
      recoveryCode: "git_failed",
    };
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
  repoPath: string,
):
  | { ok: true; commands: string[]; timeoutSec: number }
  | { ok: false; reason: string } {
  const row = db
    .prepare(
      `SELECT goals.verification AS verification,
              goals.verification_timeout_sec AS verificationTimeoutSec
         FROM workflow_runs
         LEFT JOIN goals ON goals.id = workflow_runs.goal_id
        WHERE workflow_runs.id = ?`,
    )
    .get(runId) as
    | { verification: string | null; verificationTimeoutSec: number | null }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      reason: `verification_config_unavailable: workflow run ${runId} not found`,
    };
  }

  const goalCommands = parseVerificationCommands(row.verification);
  if (!goalCommands.ok) {
    return {
      ok: false,
      reason: `verification_config_invalid: goal verification for run ${runId} is not a JSON string array`,
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
      timeoutSec: goalTimeoutSec ?? DEFAULT_DISPATCH_VERIFICATION_TIMEOUT_SEC,
    };
  }

  const policy = loadMomentumPolicy(repoPath);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `verification_policy_invalid: (${policy.code}) ${policy.error}`,
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
      DEFAULT_DISPATCH_VERIFICATION_TIMEOUT_SEC,
  };
}

function parseVerificationCommands(
  raw: string | null,
): { ok: true; commands: string[] | undefined } | { ok: false } {
  // A null column means "no goal-backed verification configured" (no goal, or
  // a goal without commands) and defers to the MOMENTUM.md fallback; a
  // present-but-malformed column is untrusted state and fails closed instead
  // of silently skipping verification.
  if (raw === null) return { ok: true, commands: undefined };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return { ok: true, commands: parsed as string[] };
    }
  } catch {}
  return { ok: false };
}

function withExternalApplyDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
  env: Record<string, string | undefined>,
  deps: DaemonWorkflowDispatchDeps,
): AsyncWorkflowStepDispatch {
  return createExternalApplyWorkflowDispatch(baseDispatch, {
    deriveExternalApply: (claim, context) =>
      resolveDaemonExternalApplyContext(
        claim.runId,
        claim.stepId,
        context,
        env,
        deps,
      ),
  });
}

function withSubworkflowDispatch(
  baseDispatch: AsyncWorkflowStepDispatch,
): AsyncWorkflowStepDispatch {
  return createSubworkflowWorkflowDispatch(baseDispatch, {
    deriveSubworkflow: deriveDispatchedSubworkflowContext,
  });
}

function resolveDaemonExternalApplyContext(
  runId: string,
  stepId: string,
  context: { db: MomentumDb; now: number },
  env: Record<string, string | undefined>,
  deps: DaemonWorkflowDispatchDeps,
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
      reason: `run_dir_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const issueScopeIdentifier = loadWorkflowRunIssueScopeIdentifier(
    context.db,
    runId,
  );
  let pending = findPendingLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? "",
  );
  const applied = findAppliedLinearExternalApplyIntents(
    context.db,
    issueScopeIdentifier ?? "",
  );
  let sourceItemsById = loadLinearRefreshSourceItems(context.db, [
    ...pending,
    ...applied,
  ]);
  const latestAuditsByIntentId = loadLatestLinearRefreshAudits(
    context.db,
    applied,
  );
  const operatorReason = linearRefreshOperatorReason(runId, stepId);
  const alreadyAppliedLifecycle = planLinearRefreshAlreadyAppliedReconciliation(
    {
      issueScopeIdentifier,
      pendingIntents: pending,
      appliedIntents: applied,
      sourceItemsById,
      latestAuditsByIntentId,
      expectedOperatorReason: operatorReason,
    },
  );
  const alreadyAppliedContext = resolveLinearRefreshAlreadyAppliedContext(
    alreadyAppliedLifecycle,
    applied,
    sourceItemsById,
    latestAuditsByIntentId,
    resolved.exec.runDir,
  );
  if (alreadyAppliedContext !== null) return alreadyAppliedContext;
  const policy = resolveLinearRefreshPolicy(resolved.exec.repoPath);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `linear_refresh_policy_load_failed: ${policy.code}: ${policy.error}`,
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
    expectedOperatorReason: operatorReason,
  });
  if (lifecycle.status === "intent_missing") {
    const seeded = seedLinearRefreshStatusUpdateIntent({
      db: context.db,
      runId,
      issueScopeIdentifier,
      now: context.now,
    });
    if (!seeded.ok) {
      return { ok: false, reason: seeded.reason };
    }
    pending = appendIntentIfMissing(pending, seeded.intent);
    sourceItemsById = new Map(sourceItemsById).set(
      seeded.sourceItem.id,
      seeded.sourceItem,
    );
    lifecycle = planLinearRefreshLifecycle({
      env,
      intentApplyPolicy: policy.value,
      issueScopeIdentifier,
      pendingIntents: pending,
      appliedIntents: applied,
      sourceItemsById,
      latestAuditsByIntentId,
      expectedOperatorReason: operatorReason,
    });
  }
  const lifecycleAlreadyAppliedContext =
    resolveLinearRefreshAlreadyAppliedContext(
      lifecycle,
      applied,
      sourceItemsById,
      latestAuditsByIntentId,
      resolved.exec.runDir,
    );
  if (lifecycleAlreadyAppliedContext !== null)
    return lifecycleAlreadyAppliedContext;
  if (!lifecycle.safeToMutate) {
    return {
      ok: false,
      reason: linearRefreshRefusalReason(
        lifecycle.status,
        policy.value,
        lifecycle.message,
      ),
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
      resultJsonPath: path.join(resolved.exec.runDir, "external-apply.json"),
    },
    runExternalApply: () =>
      executeExternalApply({
        db: context.db,
        intentId,
        operatorReason,
        repoPath: resolved.exec.repoPath,
        env,
        statusMutation: null,
        deps: executeDeps,
      }),
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
  runDir: string,
): DispatchedExternalApplyContextResolution | null {
  if (lifecycle?.status !== "already_applied") return null;

  const intent = applied.find(
    (candidate) => candidate.id === lifecycle.evidence.intentId,
  );
  const source =
    lifecycle.evidence.sourceItemId === null
      ? null
      : (sourceItemsById.get(lifecycle.evidence.sourceItemId) ?? null);
  const audit =
    lifecycle.evidence.intentId === null
      ? null
      : (latestAuditsByIntentId.get(lifecycle.evidence.intentId) ?? null);
  if (intent === undefined || source === null || audit === null) {
    return { ok: false, reason: "linear_refresh_reconcile_evidence_missing" };
  }
  return {
    ok: true,
    evidence: {
      executorLogPath: path.join(runDir, "external-apply.log"),
      resultJsonPath: path.join(runDir, "external-apply.json"),
    },
    runExternalApply: async () =>
      linearRefreshAlreadyAppliedSuccess(intent, source, audit),
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
      reason:
        "linear_refresh_issue_scope_missing: cannot seed status_update intent without workflow issue scope",
    };
  }

  const matches = listSourceItems(input.db, { adapterKind: "linear" }).filter(
    (sourceItem) =>
      sourceItem.externalId === issueScopeIdentifier ||
      sourceItem.externalKey === issueScopeIdentifier,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `linear_refresh_source_missing: no Linear source item matches workflow issue scope ${issueScopeIdentifier}`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `linear_refresh_source_ambiguous: ${matches.length} Linear source items match workflow issue scope ${issueScopeIdentifier}`,
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
      idempotencyKey: `linear:${sourceItem.externalId}:status_update:done`,
    },
    { now: () => input.now },
  ).intent;

  if (intent.status !== "pending") {
    return {
      ok: false,
      reason: `linear_refresh_intent_${intent.status}: seeded status_update intent ${intent.id} is ${intent.status}, not pending`,
    };
  }
  return { ok: true, intent, sourceItem };
}

function appendIntentIfMissing(
  intents: readonly UpdateIntent[],
  intent: UpdateIntent,
): UpdateIntent[] {
  if (intents.some((candidate) => candidate.id === intent.id)) {
    return [...intents];
  }
  return [...intents, intent];
}

function findPendingLinearExternalApplyIntents(
  db: MomentumDb,
  issueScopeIdentifier: string,
): UpdateIntent[] {
  return listUpdateIntents(db, {
    status: "pending",
    adapterKind: "linear",
  }).filter((intent) =>
    pendingLinearIntentMatchesIssueScope(db, intent, issueScopeIdentifier),
  );
}

function findAppliedLinearExternalApplyIntents(
  db: MomentumDb,
  issueScopeIdentifier: string,
): UpdateIntent[] {
  return listUpdateIntents(db, {
    status: "applied",
    adapterKind: "linear",
  }).filter((intent) =>
    pendingLinearIntentMatchesIssueScope(db, intent, issueScopeIdentifier),
  );
}

function pendingLinearIntentMatchesIssueScope(
  db: MomentumDb,
  intent: UpdateIntent,
  issueScopeIdentifier: string,
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
  intents: readonly UpdateIntent[],
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
  intents: readonly UpdateIntent[],
) {
  const out = new Map<
    string,
    NonNullable<ReturnType<typeof getLatestIntentApplyAudit>>
  >();
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

function resolveLinearRefreshPolicy(
  repoPath: string,
): LinearRefreshPolicyResolution {
  const loaded = loadMomentumPolicy(repoPath);
  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.code,
      error: loaded.error,
    };
  }
  if (!loaded.present) {
    return { ok: true, value: resolveIntentApplyPolicy(undefined).value };
  }
  return {
    ok: true,
    value: resolveIntentApplyPolicy(loaded.policy.config).value,
  };
}

function linearRefreshRefusalReason(
  status: string,
  policy: string,
  message: string,
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
  audit: NonNullable<ReturnType<typeof getLatestIntentApplyAudit>>,
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
        title: source.title,
      },
      applyPolicy: {
        value: audit.intentApplyPolicy,
        source: "momentum_policy",
      },
      allowStatusMutation: audit.allowStatusMutation,
      mutationKind: audit.mutationKind,
      auditId: audit.id,
      reconcile: {
        status: "success",
        warning: null,
      },
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
      idempotencyMarker: audit.idempotencyMarker,
    },
  };
}

function linearRefreshOperatorReason(runId: string, stepId: string): string {
  return `daemon external-apply for workflow ${runId}/${stepId}`;
}

function readLinearApiKey(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env[LINEAR_API_KEY_ENV_VAR] ?? null;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function loadWorkflowRunIssueScopeIdentifier(
  db: MomentumDb,
  runId: string,
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

function maxDaemonLiveWrapperProfileTimeoutMs(
  profile: LiveWrapperProfile,
): number {
  let maxSeconds = 0;
  for (const wrapper of profile.wrappers.values()) {
    maxSeconds = Math.max(
      maxSeconds,
      wrapper.timeoutSec + (wrapper.probe?.timeoutSec ?? 0),
    );
  }
  return maxSeconds * 1000 + DEFAULT_DAEMON_STARTUP_RECOVERY_GRACE_MS;
}
