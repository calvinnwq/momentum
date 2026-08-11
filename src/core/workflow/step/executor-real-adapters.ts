/**
 * Real `WorkflowStepExecutor` production adapter registry.
 *
 * The workflow-run executor boundary (`step/executor.ts`) shipped a fake `ADAPTERS` map:
 * `getWorkflowStepExecutor` / `dispatchWorkflowStepExecutor` resolved to a
 * deterministic fake for every `WorkflowStepExecutorKind`. The runtime
 * consolidation plan (`SPEC.md`, Path 6)
 * classifies that fake map as *deprecate-later*: useful substrate coverage, but
 * not production executor support. the real-adapter seam lands the real per-kind adapters so the
 * fakes can move behind a test-only seam.
 *
 * This module owns the real production registry builder. It reuses the existing
 * live-wrapper boundary (`createLiveWorkflowStepExecutorsFromBindings`) for the
 * canonical step kinds rather than inventing a second command runner: a kind that
 * the host bindings configure resolves to a real live executor that spawns
 * the configured local command, captures its result file, and maps the outcome
 * through the existing `WorkflowStepExecutorDispatchResult` taxonomy.
 *
 * A canonical kind with no configured live wrapper resolves to an honest
 * {@link createUnconfiguredWorkflowStepExecutor}: it reports `executes: true`
 * (a real adapter is wired for the kind) but refuses at execute time with
 * `runtime_unavailable` — the established prerequisite-missing class — instead of
 * fabricating a fake `succeeded`. That keeps production honest by default: with no
 * host bindings injected, dispatch never resolves to a fake success.
 *
 * Host bindings are supplied by dependency injection only. This module deliberately
 * does not read environment variables or the filesystem to discover host bindings.
 * Resolving a production config source is left to callers that own that decision,
 * including the daemon-default host-binding lane.
 */

import {
  createLiveWorkflowStepExecutorsFromBindings,
  type LiveStepExecutorOptions,
} from "../../executors/live-step/executor.js";
import type { HostBindings } from "../../../adapters/host-bindings-registry.js";
import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  createUnconfiguredWorkflowStepExecutor,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorKind,
} from "./executor.js";

/**
 * Re-exported from the base executor module (the real-adapter seam moved the honest "no live
 * wrapper configured" adapter to `step/executor.ts` so it can also back the
 * production default registry). Kept exported here for callers that resolve it
 * alongside {@link buildRealWorkflowStepExecutorRegistry}.
 */
export { createUnconfiguredWorkflowStepExecutor };

export type RealWorkflowStepExecutorRegistryOptions = {
  /**
   * Host bindings whose configured kinds resolve to real live executors.
   * Omitted (the production default) means every canonical kind resolves to the
   * honest `runtime_unavailable` adapter.
   */
  bindings?: HostBindings;
  /** Per-stream output cap forwarded to each configured live executor. */
  outputMaxBytes?: number;
};

/**
 * Build the real production `WorkflowStepExecutor` registry, keyed by every
 * canonical `WorkflowStepExecutorKind`. Kinds configured in the injected
 * host bindings resolve to real live executors; the rest resolve to the
 * honest `runtime_unavailable` adapter. The registry always covers the full
 * canonical kind set so lookups remain total.
 */
export function buildRealWorkflowStepExecutorRegistry(
  options?: RealWorkflowStepExecutorRegistryOptions,
): ReadonlyMap<WorkflowStepExecutorKind, WorkflowStepExecutor> {
  const liveOptions: LiveStepExecutorOptions | undefined =
    options?.outputMaxBytes !== undefined
      ? { outputMaxBytes: options.outputMaxBytes }
      : undefined;
  const configured = options?.bindings
    ? createLiveWorkflowStepExecutorsFromBindings(options.bindings, liveOptions)
    : new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>();

  const registry = new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>();
  for (const kind of WORKFLOW_STEP_EXECUTOR_KINDS) {
    registry.set(
      kind,
      configured.get(kind) ?? createUnconfiguredWorkflowStepExecutor(kind),
    );
  }
  return registry;
}
