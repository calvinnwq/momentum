/**
 * Real `WorkflowStepExecutor` production adapter registry (RC-5, NGX-485).
 *
 * The M7 executor boundary (`step-executor.ts`) shipped a fake `ADAPTERS` map:
 * `getWorkflowStepExecutor` / `dispatchWorkflowStepExecutor` resolved to a
 * deterministic fake for every `WorkflowStepExecutorKind`. The runtime
 * consolidation plan (`internal/contracts/runtime-consolidation-plan.md`, Path 6)
 * classifies that fake map as *deprecate-later*: useful substrate coverage, but
 * not production executor support. RC-5 lands the real per-kind adapters so the
 * fakes can move behind a test-only seam.
 *
 * This module owns the real production registry builder. It reuses the existing
 * M9 live-wrapper boundary (`createLiveWorkflowStepExecutorsFromProfile`) for the
 * canonical step kinds rather than inventing a second command runner: a kind that
 * a live-wrapper profile configures resolves to a real live executor that spawns
 * the configured local command, captures its result file, and maps the outcome
 * through the existing `WorkflowStepExecutorDispatchResult` taxonomy.
 *
 * A canonical kind with no configured live wrapper resolves to an honest
 * {@link createUnconfiguredWorkflowStepExecutor}: it reports `executes: true`
 * (a real adapter is wired for the kind) but refuses at execute time with
 * `runtime_unavailable` — the established prerequisite-missing class — instead of
 * fabricating a fake `succeeded`. That keeps production honest by default: with no
 * profile injected, dispatch never resolves to a fake success.
 *
 * The profile is supplied by dependency injection only. This module deliberately
 * does not read environment variables or the filesystem to discover a profile:
 * wiring a daemon-default profile source is future work
 * (`runtime-consolidation-plan.md` Paths 3/4 — "wiring that seam as the daemon
 * default still needs real terminal executor evidence"), so resolving a
 * production config source is left to the caller that owns that decision.
 */

import {
  createLiveWorkflowStepExecutorsFromProfile,
  type LiveStepExecutorOptions
} from "../executors/live-step-executor.js";
import type { LiveWrapperProfile } from "../../adapters/live-wrapper-registry.js";
import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorKind
} from "./step-executor.js";

export type RealWorkflowStepExecutorRegistryOptions = {
  /**
   * Live-wrapper profile whose configured kinds resolve to real live executors.
   * Omitted (the production default) means every canonical kind resolves to the
   * honest `runtime_unavailable` adapter.
   */
  profile?: LiveWrapperProfile;
  /** Per-stream output cap forwarded to each configured live executor. */
  outputMaxBytes?: number;
};

/**
 * Build the honest "no live wrapper configured" adapter for a canonical step
 * kind. It is a real adapter (`executes: true`) that refuses with
 * `runtime_unavailable` rather than fabricating a terminal result — the daemon /
 * dispatcher then treats it as a missing prerequisite, never as a clean success.
 */
export function createUnconfiguredWorkflowStepExecutor(
  kind: WorkflowStepExecutorKind
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (input) => ({
      ok: false,
      code: "runtime_unavailable",
      error: `No live workflow-step wrapper is configured for step kind "${kind}"; configure a live-wrapper profile to execute it.`,
      executorLogPath: input.executorLogPath,
      resultJsonPath: input.resultJsonPath
    })
  };
}

/**
 * Build the real production `WorkflowStepExecutor` registry, keyed by every
 * canonical `WorkflowStepExecutorKind`. Kinds configured in the injected
 * live-wrapper profile resolve to real live executors; the rest resolve to the
 * honest `runtime_unavailable` adapter. The registry always covers the full
 * canonical kind set so lookups remain total.
 */
export function buildRealWorkflowStepExecutorRegistry(
  options?: RealWorkflowStepExecutorRegistryOptions
): ReadonlyMap<WorkflowStepExecutorKind, WorkflowStepExecutor> {
  const liveOptions: LiveStepExecutorOptions | undefined =
    options?.outputMaxBytes !== undefined
      ? { outputMaxBytes: options.outputMaxBytes }
      : undefined;
  const configured = options?.profile
    ? createLiveWorkflowStepExecutorsFromProfile(options.profile, liveOptions)
    : new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>();

  const registry = new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>();
  for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
    registry.set(
      kind,
      configured.get(kind) ?? createUnconfiguredWorkflowStepExecutor(kind)
    );
  }
  return registry;
}
