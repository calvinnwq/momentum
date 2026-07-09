/**
 * Live workflow-step executor bridge.
 *
 * `runLiveStepWrapper` (`live-step-wrapper.ts`) is the pure execution core that
 * runs a resolved `LiveWrapperConfig` as an
 * explicit local child process and classifies the outcome into the live-wrapper
 * execution recovery vocabulary (`LIVE_STEP_WRAPPER_RECOVERY_CODES`).
 * `live-wrapper-registry.ts` owns the typed config plus a
 * `WorkflowStepKind`-keyed profile/registry.
 *
 * This module is the seam that makes that execution core usable through the
 * existing `WorkflowStepExecutor` boundary (`src/core/workflow/step/executor.ts`)
 * without rewriting either side:
 *
 *   - `buildLiveStepWrapperInput` adapts a `WorkflowStepExecutorInput` into a
 *     `LiveStepWrapperInput`. The executor boundary's per-run `runDir` is the
 *     live wrapper's `iterationDir` (the base its relative `result_file`
 *     resolves against); the wrapper owns the result path via `config`, so the
 *     advisory `input.resultJsonPath` is not forwarded.
 *   - `mapLiveStepWrapperResult` translates a `LiveStepWrapperResult` into the
 *     normalized `WorkflowStepExecutorDispatchResult`. Runner-reported
 *     `success: false` is still a normalized `ok: true` step failure that later
 *     finalization handles with a reset; process-level wrapper failures become
 *     `ok: false` dispatch errors. Distinct live failure causes are never
 *     collapsed into generic failure text: the precise
 *     `LiveStepWrapperRecoveryCode` is preserved on `liveRecoveryCode` even when
 *     two live codes map onto one coarser dispatch `errorCode`.
 *   - `createLiveWorkflowStepExecutor` / `createLiveWorkflowStepExecutorsFromProfile`
 *     wrap the two functions plus `runLiveStepWrapper` into `WorkflowStepExecutor`
 *     values keyed by `WorkflowStepKind`, resolvable from a profile.
 *
 * This module deliberately stops at the executor adapter boundary: it does not
 * acquire/heartbeat/release durable `workflow_leases`, persist `workflow_steps`
 * start/terminal state, re-derive run state, render run-scoped recovery, or own
 * verification/commit transactions. `live-step/orchestrator.ts` composes this
 * adapter with the lease / step lifecycle; `live-step/advance.ts` composes that
 * orchestration with verification, commit / reset finalization, and live
 * run-scoped recovery so the workflow state machine can drive a live wrapper exactly
 * as it already drives the fake executor.
 */

import {
  runLiveStepWrapper,
  type LiveStepWrapperInput,
  type LiveStepWrapperRecoveryCode,
  type LiveStepWrapperResult
} from "../../../adapters/live-step-wrapper.js";
import {
  listConfiguredLiveWrapperKinds,
  resolveLiveWrapper,
  type LiveWrapperConfig,
  type LiveWrapperProfile
} from "../../../adapters/live-wrapper-registry.js";
import type { WorkflowStepKind } from "../../workflow/run/reducer.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorError,
  WorkflowStepExecutorErrorCode,
  WorkflowStepExecutorInput,
  WorkflowStepExecutorResult,
  WorkflowStepExecutorSuccess
} from "../../workflow/step/executor.js";

/**
 * Stable mapping from the live-wrapper execution recovery vocabulary onto the
 * `WorkflowStepExecutorErrorCode` dispatch taxonomy. Two live codes have no
 * direct equivalent and intentionally collapse onto the nearest coarser
 * dispatch code while the precise cause is retained separately on
 * `LiveStepExecutorError.liveRecoveryCode`:
 *
 *   - `auth_unavailable` → `runtime_unavailable` (a prerequisite-missing class).
 *   - `output_overflow`  → `command_failed` (the command ran but breached the
 *     output cap).
 */
export const LIVE_STEP_EXECUTOR_ERROR_CODE_BY_RECOVERY_CODE: Record<
  LiveStepWrapperRecoveryCode,
  WorkflowStepExecutorErrorCode
> = {
  runtime_unavailable: "runtime_unavailable",
  auth_unavailable: "runtime_unavailable",
  command_failed: "command_failed",
  command_timed_out: "command_timed_out",
  output_overflow: "command_failed",
  result_missing: "result_missing",
  result_invalid: "result_invalid"
};

/**
 * A dispatch error from a live wrapper. Assignable to the
 * `WorkflowStepExecutorError` so it satisfies the executor boundary, but carries
 * the precise `liveRecoveryCode` so the run-level lease/recovery layer can map
 * it without re-deriving live process semantics.
 */
export type LiveStepExecutorError = WorkflowStepExecutorError & {
  liveRecoveryCode: LiveStepWrapperRecoveryCode;
};

export type LiveStepExecutorDispatchResult =
  | WorkflowStepExecutorSuccess
  | LiveStepExecutorError;

export type LiveStepExecutorOptions = {
  /** Per-stream output cap forwarded to the live wrapper. */
  outputMaxBytes?: number;
};

/**
 * Adapt a `WorkflowStepExecutorInput` into a `LiveStepWrapperInput`. The
 * executor boundary's `runDir` becomes the wrapper's `iterationDir`; optional
 * `promptPath` / `env` are forwarded only when present so that
 * `exactOptionalPropertyTypes` stays honest.
 */
export function buildLiveStepWrapperInput(
  input: WorkflowStepExecutorInput,
  config: LiveWrapperConfig,
  options?: LiveStepExecutorOptions
): LiveStepWrapperInput {
  return {
    kind: input.kind,
    config,
    runId: input.runId,
    stepId: input.stepId,
    attempt: input.attempt,
    repoPath: input.repoPath,
    iterationDir: input.runDir,
    executorLogPath: input.executorLogPath,
    ...(input.agentProvider !== undefined
      ? { agentProvider: input.agentProvider }
      : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.promptPath !== undefined ? { promptPath: input.promptPath } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(options?.outputMaxBytes !== undefined
      ? { outputMaxBytes: options.outputMaxBytes }
      : {})
  };
}

/**
 * Translate a `LiveStepWrapperResult` into the normalized dispatch result.
 * A successful wrapper process always becomes an `ok: true` executor result: a
 * runner document with `success: true` maps to `succeeded`, while `success:
 * false` maps to a normalized `failed` step with `command_failed` so finalization
 * can reset the worktree. Only process-level wrapper failures become `ok: false`
 * dispatch errors carrying the mapped code plus the precise
 * `liveRecoveryCode`.
 */
export function mapLiveStepWrapperResult(
  result: LiveStepWrapperResult
): LiveStepExecutorDispatchResult {
  if (result.ok) {
    const runnerSucceeded = result.result.success;
    const executorResult: WorkflowStepExecutorResult = {
      state: runnerSucceeded ? "succeeded" : "failed",
      summary: result.result.summary,
      checkpoints: [],
      artifacts: [
        { kind: "executor-log", path: result.executorLogPath },
        { kind: "runner-result", path: result.resultJsonPath }
      ],
      resultDigest: null,
      errorCode: runnerSucceeded ? null : "command_failed",
      errorMessage: runnerSucceeded
        ? null
        : `live step runner reported success=false: ${result.result.summary}`,
      retryHint: null,
      recoveryHint: null
    };
    return {
      ok: true,
      result: executorResult,
      executorLogPath: result.executorLogPath,
      resultJsonPath: result.resultJsonPath,
      diagnostics: {
        executor: "live",
        command: result.diagnostics.command,
        args: result.diagnostics.args,
        cwd: result.diagnostics.cwd,
        exitCode: result.diagnostics.exitCode,
        signal: result.diagnostics.signal,
        durationMs: result.diagnostics.durationMs,
        probed: result.diagnostics.probed,
        runnerSuccess: result.result.success,
        goalComplete: result.result.goal_complete
      }
    };
  }

  return {
    ok: false,
    code: LIVE_STEP_EXECUTOR_ERROR_CODE_BY_RECOVERY_CODE[result.code],
    error: result.error,
    executorLogPath: result.executorLogPath,
    resultJsonPath: result.resultJsonPath,
    liveRecoveryCode: result.code
  };
}

/**
 * Build a `WorkflowStepExecutor` that runs a resolved live wrapper for one step
 * kind. The returned executor mirrors the fake executor's surface so existing
 * dispatch / state-machine callers can drive it unchanged.
 */
export function createLiveWorkflowStepExecutor(
  kind: WorkflowStepKind,
  config: LiveWrapperConfig,
  options?: LiveStepExecutorOptions
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (input) =>
      mapLiveStepWrapperResult(
        runLiveStepWrapper(buildLiveStepWrapperInput(input, config, options))
      )
  };
}

/**
 * Build live executors for every step kind a profile configures, keyed by
 * kind. Unconfigured kinds are simply absent from the map; resolution refusals
 * (which `listConfiguredLiveWrapperKinds` already filters out) are skipped.
 */
export function createLiveWorkflowStepExecutorsFromProfile(
  profile: LiveWrapperProfile,
  options?: LiveStepExecutorOptions
): Map<WorkflowStepKind, WorkflowStepExecutor> {
  const executors = new Map<WorkflowStepKind, WorkflowStepExecutor>();
  for (const kind of listConfiguredLiveWrapperKinds(profile)) {
    const resolved = resolveLiveWrapper(profile, kind);
    if (!resolved.ok) continue;
    executors.set(
      kind,
      createLiveWorkflowStepExecutor(kind, resolved.config, options)
    );
  }
  return executors;
}
