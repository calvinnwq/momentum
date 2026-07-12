/**
 * WorkflowStepExecutor boundary.
 *
 * The executor boundary is the seam Momentum exposes to the OpenClaw
 * `coding-workflow-pipeline` skill (and any future trusted runtime binding)
 * for driving a single `workflow_steps` row from `approved` → `running` →
 * terminal. Momentum core continues to own the durable run / step / approval /
 * lease rows pinned by SPEC.md; executors only
 * perform the step's work and report a normalized result. Executors do not
 * mutate the durable substrate, do not perform external apply, and do not
 * decide approval boundary advancement.
 *
 * The boundary keeps the compact registry style used by earlier execution
 * seams: a small registry keyed by step kind, a single dispatch entrypoint that
 * validates input and traps thrown executors, and stable error codes that
 * callers can map to the workflow-run state machine without leaking GNHF /
 * postflight / no-mistakes / merge-cleanup implementation details into Momentum
 * core.
 *
 * This workflow-run module owns the dispatch boundary (input validation, executor
 * resolution, thrown-executor trapping, stable error codes). Runtime
 * consolidation flipped the production default away from the deterministic
 * fake it had classified as deprecate-later: the default
 * registry is now built from real adapters (the honest unconfigured adapter
 * below, which refuses with `runtime_unavailable` rather than fabricating a
 * success), and `step/executor-real-adapters.ts` wires configured kinds to real
 * live wrappers. The deterministic fake moved behind an explicit test-only
 * seam (`test/helpers/fake-workflow-step-executor.ts`) that the workflow-run/operator-recovery/executor-loop
 * substrate smokes inject through the `registry` parameter of the three
 * entrypoints; no fake ships in `dist/`. live-wrapper owns the live-wrapper registry /
 * command configuration in `live-wrapper-registry.ts`; live local command
 * execution is layered around this boundary rather than owned by a fake
 * dispatcher.
 */

import { WORKFLOW_STEP_KINDS, type WorkflowStepKind } from "../run/reducer.js";

export type WorkflowStepExecutorKind = WorkflowStepKind;

export const WORKFLOW_STEP_EXECUTOR_KINDS: readonly WorkflowStepExecutorKind[] =
  WORKFLOW_STEP_KINDS;

export type WorkflowStepExecutorErrorCode =
  | "invalid_input"
  | "unsupported_step"
  | "executor_threw"
  | "result_invalid"
  | "result_missing"
  | "command_failed"
  | "command_timed_out"
  | "unsupported_platform"
  | "runtime_unavailable"
  | "dispatch_lease_unavailable"
  | "manual_recovery_required";

export const WORKFLOW_STEP_EXECUTOR_ERROR_CODES: readonly WorkflowStepExecutorErrorCode[] =
  [
    "invalid_input",
    "unsupported_step",
    "executor_threw",
    "result_invalid",
    "result_missing",
    "command_failed",
    "command_timed_out",
    "unsupported_platform",
    "runtime_unavailable",
    "dispatch_lease_unavailable",
    "manual_recovery_required",
  ];

export const WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "skipped",
] as const;

export type WorkflowStepExecutorTerminalState =
  (typeof WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES)[number];

export const WORKFLOW_STEP_EXECUTOR_RETRY_HINTS = [
  "retry_now",
  "retry_after_delay",
  "do_not_retry",
] as const;

export type WorkflowStepExecutorRetryHint =
  (typeof WORKFLOW_STEP_EXECUTOR_RETRY_HINTS)[number];

/**
 * Recovery hint vocabulary mirrors the skill's `failure_patterns.yaml`
 * classifier names so durable rows can carry the hint forward without
 * re-classifying. The skill remains the source of truth for which pattern
 * matches; executors only report which classification their result implies.
 */
export const WORKFLOW_STEP_EXECUTOR_RECOVERY_HINTS = [
  "resume",
  "skip_already_complete",
  "repair_required",
  "manual_recovery_required",
] as const;

export type WorkflowStepExecutorRecoveryHint =
  (typeof WORKFLOW_STEP_EXECUTOR_RECOVERY_HINTS)[number];

export type WorkflowStepExecutorCheckpoint = {
  at: number;
  message: string;
  digest?: string;
};

export type WorkflowStepExecutorArtifact = {
  kind: string;
  path: string;
  digest?: string;
};

export type WorkflowStepExecutorInput = {
  runId: string;
  stepId: string;
  kind: WorkflowStepExecutorKind;
  attempt: number;
  agentProvider?: string | null;
  model?: string | null;
  effort?: string | null;
  repoPath: string;
  runDir: string;
  promptPath?: string;
  resultJsonPath: string;
  executorLogPath: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
};

export type WorkflowStepExecutorResult = {
  state: WorkflowStepExecutorTerminalState;
  summary: string;
  checkpoints: WorkflowStepExecutorCheckpoint[];
  artifacts: WorkflowStepExecutorArtifact[];
  resultDigest: string | null;
  errorCode: WorkflowStepExecutorErrorCode | null;
  errorMessage: string | null;
  retryHint: WorkflowStepExecutorRetryHint | null;
  recoveryHint: WorkflowStepExecutorRecoveryHint | null;
};

export type WorkflowStepExecutorSuccess = {
  ok: true;
  result: WorkflowStepExecutorResult;
  executorLogPath: string;
  resultJsonPath: string;
  diagnostics?: Record<string, unknown>;
};

export type WorkflowStepExecutorError = {
  ok: false;
  code: WorkflowStepExecutorErrorCode;
  error: string;
  executorLogPath: string | undefined;
  resultJsonPath: string | undefined;
};

export type WorkflowStepExecutorDispatchResult =
  WorkflowStepExecutorSuccess | WorkflowStepExecutorError;

export type WorkflowStepExecutor = {
  kind: WorkflowStepExecutorKind;
  executes: boolean;
  execute: (
    input: WorkflowStepExecutorInput,
  ) => WorkflowStepExecutorDispatchResult;
};

const EXECUTOR_KIND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_EXECUTOR_KINDS,
);

export function isWorkflowStepExecutorKind(
  value: string,
): value is WorkflowStepExecutorKind {
  return EXECUTOR_KIND_SET.has(value);
}

/**
 * A resolvable `WorkflowStepExecutor` registry keyed by canonical step kind.
 * Production callers omit it and get the honest {@link DEFAULT_REGISTRY}; the
 * workflow-run/operator-recovery/executor-loop substrate tests inject the deterministic fake registry from
 * `test/helpers/fake-workflow-step-executor.ts` through the `registry` parameter
 * of the entrypoints below.
 */
export type WorkflowStepExecutorRegistry = ReadonlyMap<
  WorkflowStepExecutorKind,
  WorkflowStepExecutor
>;

/**
 * Build the honest "no live wrapper configured" adapter for a canonical step
 * kind. It is a real adapter (`executes: true`) that refuses at execute time
 * with `runtime_unavailable` — the established prerequisite-missing class —
 * rather than fabricating a terminal result. The dispatcher then treats it as a
 * missing prerequisite, never as a clean success. `step/executor-real-adapters.ts`
 * reuses this for canonical kinds a live-wrapper profile does not configure.
 */
export function createUnconfiguredWorkflowStepExecutor(
  kind: WorkflowStepExecutorKind,
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (input) => ({
      ok: false,
      code: "runtime_unavailable",
      error: `No live workflow-step wrapper is configured for step kind "${kind}"; configure a live-wrapper profile to execute it.`,
      executorLogPath: input.executorLogPath,
      resultJsonPath: input.resultJsonPath,
    }),
  };
}

/**
 * The production default registry (the real-adapter seam). With no live-wrapper profile supplied,
 * every canonical kind resolves to the honest unconfigured adapter: lookup/dispatch
 * never resolves to a fake success by default. Daemon callers that resolve a
 * configured live-wrapper profile pass an explicit registry instead.
 */
const DEFAULT_REGISTRY: WorkflowStepExecutorRegistry = new Map(
  WORKFLOW_STEP_EXECUTOR_KINDS.map(
    (kind) => [kind, createUnconfiguredWorkflowStepExecutor(kind)] as const,
  ),
);

export function getWorkflowStepExecutor(
  kind: string,
  registry: WorkflowStepExecutorRegistry = DEFAULT_REGISTRY,
): WorkflowStepExecutor | undefined {
  if (!isWorkflowStepExecutorKind(kind)) return undefined;
  return registry.get(kind);
}

export function listWorkflowStepExecutorKinds(): readonly WorkflowStepExecutorKind[] {
  return WORKFLOW_STEP_EXECUTOR_KINDS;
}

export function listExecutingWorkflowStepExecutorKinds(
  registry: WorkflowStepExecutorRegistry = DEFAULT_REGISTRY,
): readonly WorkflowStepExecutorKind[] {
  return WORKFLOW_STEP_EXECUTOR_KINDS.filter((kind) => {
    const adapter = registry.get(kind);
    return adapter?.executes === true;
  });
}

export function dispatchWorkflowStepExecutor(
  kind: string,
  input: WorkflowStepExecutorInput,
  registry: WorkflowStepExecutorRegistry = DEFAULT_REGISTRY,
): WorkflowStepExecutorDispatchResult {
  const invalid = validateInput(input, kind);
  if (invalid !== null) return invalid;

  const executor = getWorkflowStepExecutor(kind, registry);
  if (!executor) {
    return unsupportedStepError(kind, registry);
  }
  if (!executor.executes) {
    return unsupportedStepError(kind, registry);
  }

  try {
    return executor.execute(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "executor_threw",
      error: `Executor "${kind}" threw: ${detail}`,
      executorLogPath: input.executorLogPath,
      resultJsonPath: input.resultJsonPath,
    };
  }
}

function unsupportedStepError(
  kind: string,
  registry: WorkflowStepExecutorRegistry,
): WorkflowStepExecutorError {
  const executing = listExecutingWorkflowStepExecutorKinds(registry);
  return {
    ok: false,
    code: "unsupported_step",
    error: `Workflow step "${kind}" is not supported for execution; supported step kinds: ${executing.join(", ") || "<none>"}.`,
    executorLogPath: undefined,
    resultJsonPath: undefined,
  };
}

function validateInput(
  input: WorkflowStepExecutorInput,
  kind: string,
): WorkflowStepExecutorError | null {
  if (typeof kind !== "string" || kind.length === 0) {
    return invalidInputError("kind", undefined, undefined);
  }
  if (typeof input.runId !== "string" || input.runId.trim().length === 0) {
    return invalidInputError("runId", undefined, undefined);
  }
  if (typeof input.stepId !== "string" || input.stepId.trim().length === 0) {
    return invalidInputError("stepId", undefined, undefined);
  }
  if (!isWorkflowStepExecutorKind(input.kind)) {
    return invalidInputError(
      "kind",
      undefined,
      undefined,
      `WorkflowStepExecutorInput.kind must be one of: ${WORKFLOW_STEP_EXECUTOR_KINDS.join(", ")}.`,
    );
  }
  if (input.kind !== kind) {
    return invalidInputError(
      "kind",
      undefined,
      undefined,
      `WorkflowStepExecutorInput.kind "${input.kind}" must match dispatch kind "${kind}".`,
    );
  }
  if (
    typeof input.repoPath !== "string" ||
    input.repoPath.trim().length === 0
  ) {
    return invalidInputError(
      "repoPath",
      input.executorLogPath,
      input.resultJsonPath,
    );
  }
  if (typeof input.runDir !== "string" || input.runDir.trim().length === 0) {
    return invalidInputError(
      "runDir",
      input.executorLogPath,
      input.resultJsonPath,
    );
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return invalidInputError(
      "attempt",
      input.executorLogPath,
      input.resultJsonPath,
      "WorkflowStepExecutorInput.attempt must be a positive integer.",
    );
  }
  if (
    typeof input.executorLogPath !== "string" ||
    input.executorLogPath.trim().length === 0
  ) {
    return invalidInputError("executorLogPath", undefined, undefined);
  }
  if (
    typeof input.resultJsonPath !== "string" ||
    input.resultJsonPath.trim().length === 0
  ) {
    return invalidInputError(
      "resultJsonPath",
      input.executorLogPath,
      undefined,
    );
  }
  return null;
}

function invalidInputError(
  field: string,
  executorLogPath: string | undefined,
  resultJsonPath: string | undefined,
  message?: string,
): WorkflowStepExecutorError {
  return {
    ok: false,
    code: "invalid_input",
    error: message ?? `WorkflowStepExecutorInput.${field} is required.`,
    executorLogPath,
    resultJsonPath,
  };
}
