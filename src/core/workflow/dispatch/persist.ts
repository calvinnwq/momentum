/**
 * Durable resolution twin of the production workflow-lane dispatch brain
 *.
 *
 * `dispatch.ts` owns the *pure* dispatch decision: given a claimed
 * step's already-resolved executor identity (a {@link WorkflowStepDispatchResolution}),
 * {@link planWorkflowStepDispatch} routes it to a real dispatch or a fail-closed
 * manual-recovery outcome. This module owns the read-only half that produces that
 * resolution from durable SQLite state — the storage twin, exactly as
 * `gate/persist.ts` is the storage twin of `gate/gate.ts` and
 * `src/core/executors/loop/persist.ts` is the storage twin of the executor-loop reducer.
 *
 * Resolution walks the same chain the workflow-first runtime materializes a run
 * from, in reverse: a claimed step is identified by `(runId, stepId)`; the run
 * carries the `(workflow_definition_key, workflow_definition_version)` link
 * recorded at `workflow run start`; and the step's executor identity normally
 * lives on the matching `step_definitions` row (`stepId` is the definition
 * step's stable `step_key`). Momentum-native coding runs are the source-specific
 * exception: they resolve from the built-in registry by the recorded key/version
 * and never from persisted rows, so an old native run keeps using its recorded
 * built-in version after a later built-in recipe becomes current. Each
 * durable-state shortfall maps to one
 * {@link WorkflowStepResolutionFailure}:
 *
 *   - the `workflow_runs` row is gone               → `run_not_found`
 *   - the run has no (or a partial) definition link → `definition_unlinked`
 *   - no `step_definitions` row or built-in step matches the step → `step_definition_not_found`
 *   - the step's `executor` is not a valid identity → `unknown_executor_family`
 *
 * The reads are non-mutating: resolution never writes a row, opens a gate, or
 * touches a lease. The side-effecting half of the dispatcher lives in
 * `dispatch/execute.ts`: it creates the `executor_invocations` /
 * `executor_rounds` start scaffold for a `dispatch` plan, or records the
 * fail-closed manual-recovery effect and releases the dispatch lease for a
 * `fail_closed` plan. A vanished run cannot carry a `workflow_gates` FK, so the
 * effect layer releases that orphaned lease without inventing a gate.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION_KEY,
  getBuiltInWorkflowDefinition,
  isExecutorName,
} from "../definition/definition.js";
import {
  planWorkflowStepDispatch,
  type WorkflowStepDispatchPlan,
  type WorkflowStepDispatchResolution,
} from "./dispatch.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../run/start.js";

/**
 * The durable identity of a claimed workflow step the dispatcher must resolve.
 * Structurally a subset of the scheduler's `ClaimedWorkflowStep`, so the daemon
 * lane can hand a claim straight to {@link resolveClaimedWorkflowStepFamily}.
 */
export type WorkflowStepDispatchTarget = {
  runId: string;
  stepId: string;
};

type WorkflowRunDefinitionLinkRow = {
  source: string;
  workflow_definition_key: string | null;
  workflow_definition_version: number | null;
};

type StepDefinitionExecutorRow = {
  executor: string;
};

type StepDefinitionRuntimeRow = StepDefinitionExecutorRow & {
  config_json: string | null;
};

export type WorkflowStepExecutorRuntimeResolution =
  | {
      ok: true;
      executorName: string;
      config: Readonly<Record<string, unknown>>;
    }
  | { ok: false; reason: string };

/** Resolve the permanent executor name and portable config for one claimed step. */
export function resolveWorkflowStepExecutorRuntime(
  db: MomentumDb,
  target: WorkflowStepDispatchTarget,
): WorkflowStepExecutorRuntimeResolution {
  const run = db
    .prepare(
      `SELECT source, workflow_definition_key, workflow_definition_version
         FROM workflow_runs
        WHERE id = ?`,
    )
    .get(target.runId) as WorkflowRunDefinitionLinkRow | undefined;
  if (run === undefined) return { ok: false, reason: "workflow_run_not_found" };
  const key = run.workflow_definition_key;
  const version = run.workflow_definition_version;
  if (key === null || key === "" || version === null) {
    return { ok: false, reason: "workflow_definition_unlinked" };
  }
  if (
    run.source === MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE &&
    key === CODING_WORKFLOW_DEFINITION_KEY
  ) {
    const step = getBuiltInWorkflowDefinition(key, version)?.steps.find(
      (item) => item.key === target.stepId,
    );
    return step === undefined
      ? { ok: false, reason: "step_definition_not_found" }
      : { ok: true, executorName: step.executor, config: step.config ?? {} };
  }
  const row = db
    .prepare(
      `SELECT executor, config_json
         FROM step_definitions
        WHERE definition_key = ?
          AND definition_version = ?
          AND step_key = ?`,
    )
    .get(key, version, target.stepId) as StepDefinitionRuntimeRow | undefined;
  if (row === undefined)
    return { ok: false, reason: "step_definition_not_found" };
  if (!isExecutorName(row.executor)) {
    return { ok: false, reason: `executor_name_invalid: ${row.executor}` };
  }
  if (row.config_json === null) {
    return { ok: true, executorName: row.executor, config: {} };
  }
  try {
    const config = JSON.parse(row.config_json) as unknown;
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      return { ok: false, reason: "executor_config_not_object" };
    }
    return {
      ok: true,
      executorName: row.executor,
      config: config as Record<string, unknown>,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `executor_config_invalid_json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Resolve a claimed step's executor identity from durable run / definition / step
 * state, or a typed {@link WorkflowStepResolutionFailure} when the durable state
 * cannot answer. Read-only and total with respect to the database: it never
 * mutates a row and always returns a {@link WorkflowStepDispatchResolution},
 * which {@link planWorkflowStepDispatch} turns into the dispatch decision.
 */
export function resolveClaimedWorkflowStepFamily(
  db: MomentumDb,
  target: WorkflowStepDispatchTarget,
): WorkflowStepDispatchResolution {
  const run = db
    .prepare(
      `SELECT source, workflow_definition_key, workflow_definition_version
         FROM workflow_runs
        WHERE id = ?`,
    )
    .get(target.runId) as WorkflowRunDefinitionLinkRow | undefined;

  if (run === undefined) {
    return { ok: false, failure: "run_not_found" };
  }

  const definitionKey = run.workflow_definition_key;
  const definitionVersion = run.workflow_definition_version;
  // Either half of the link missing means the run cannot be resolved to a
  // definition (for example, an imported run), so its step has no executor identity.
  if (
    definitionKey === null ||
    definitionKey === "" ||
    definitionVersion === null
  ) {
    return { ok: false, failure: "definition_unlinked" };
  }

  if (
    run.source === MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE &&
    definitionKey === CODING_WORKFLOW_DEFINITION_KEY
  ) {
    const builtIn = getBuiltInWorkflowDefinition(
      definitionKey,
      definitionVersion,
    );
    if (builtIn !== undefined) {
      const builtInStep = builtIn.steps.find(
        (step) => step.key === target.stepId,
      );
      if (builtInStep === undefined) {
        return {
          ok: false,
          failure: "step_definition_not_found",
          detail: `${definitionKey}@${definitionVersion} step '${target.stepId}'`,
        };
      }
      return { ok: true, executorFamily: builtInStep.executor };
    }
    return {
      ok: false,
      failure: "step_definition_not_found",
      detail: `${definitionKey}@${definitionVersion} step '${target.stepId}'`,
    };
  }

  const stepDefinition = db
    .prepare(
      `SELECT executor
         FROM step_definitions
        WHERE definition_key = ?
          AND definition_version = ?
          AND step_key = ?`,
    )
    .get(definitionKey, definitionVersion, target.stepId) as
    StepDefinitionExecutorRow | undefined;

  if (stepDefinition === undefined) {
    return {
      ok: false,
      failure: "step_definition_not_found",
      detail: `${definitionKey}@${definitionVersion} step '${target.stepId}'`,
    };
  }

  const executor = stepDefinition.executor;
  if (!isExecutorName(executor)) {
    return { ok: false, failure: "unknown_executor_family", detail: executor };
  }

  // The type guard has narrowed `executor` to a durable executor identity.
  return { ok: true, executorFamily: executor };
}

/**
 * Resolve a claimed step against durable state and decide what the production
 * workflow lane should do with it, composing {@link resolveClaimedWorkflowStepFamily}
 * with the pure {@link planWorkflowStepDispatch} brain. Read-only and total: the
 * returned {@link WorkflowStepDispatchPlan} is the decision only; the durable
 * dispatch / fail-closed effects are applied by a later slice.
 */
export function resolveWorkflowStepDispatchPlan(
  db: MomentumDb,
  target: WorkflowStepDispatchTarget,
): WorkflowStepDispatchPlan {
  return planWorkflowStepDispatch(resolveClaimedWorkflowStepFamily(db, target));
}
