/**
 * WorkflowStepExecutor boundary introduced by NGX-315 (M7-03).
 *
 * The executor boundary is the seam Momentum exposes to the OpenClaw
 * `coding-workflow-pipeline` skill (and any future trusted runtime binding)
 * for driving a single `workflow_steps` row from `approved` → `running` →
 * terminal. Momentum core continues to own the durable run / step / approval /
 * lease rows pinned by internal/contracts/workflow-runs.md; executors only
 * perform the step's work and report a normalized result. Executors do not
 * mutate the durable substrate, do not perform external apply, and do not
 * decide approval boundary advancement.
 *
 * The boundary mirrors the M4 `RunnerAdapter` style: a small registry keyed by
 * step kind, a single dispatch entrypoint that validates input and traps
 * thrown executors, and stable error codes that callers can map to the M7
 * state machine without leaking GNHF / postflight / no-mistakes /
 * merge-cleanup implementation details into Momentum core.
 *
 * This slice intentionally ships only the contract and a deterministic fake
 * executor. Thin wrappers around live local command paths are deferred to a
 * later M7 slice that proves state recovery end-to-end.
 */

import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind
} from "./workflow-run-reducer.js";

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
    "runtime_unavailable",
    "dispatch_lease_unavailable",
    "manual_recovery_required"
  ];

export const WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "skipped"
] as const;

export type WorkflowStepExecutorTerminalState =
  (typeof WORKFLOW_STEP_EXECUTOR_TERMINAL_STATES)[number];

export const WORKFLOW_STEP_EXECUTOR_RETRY_HINTS = [
  "retry_now",
  "retry_after_delay",
  "do_not_retry"
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
  "manual_recovery_required"
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
  | WorkflowStepExecutorSuccess
  | WorkflowStepExecutorError;

export type WorkflowStepExecutor = {
  kind: WorkflowStepExecutorKind;
  executes: boolean;
  execute: (
    input: WorkflowStepExecutorInput
  ) => WorkflowStepExecutorDispatchResult;
};

const EXECUTOR_KIND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_EXECUTOR_KINDS
);

export function isWorkflowStepExecutorKind(
  value: string
): value is WorkflowStepExecutorKind {
  return EXECUTOR_KIND_SET.has(value);
}

export type FakeWorkflowStepExecutorOutcome =
  | "success"
  | "skip"
  | "fail_retry"
  | "fail_manual_recovery"
  | "throw"
  | "runtime_unavailable";

export type FakeWorkflowStepExecutorConfig = {
  outcome?: FakeWorkflowStepExecutorOutcome;
  errorCode?: WorkflowStepExecutorErrorCode;
  errorMessage?: string;
  resultDigest?: string;
  artifacts?: WorkflowStepExecutorArtifact[];
  checkpointMessages?: string[];
};

const FAKE_OUTCOMES: ReadonlySet<FakeWorkflowStepExecutorOutcome> = new Set([
  "success",
  "skip",
  "fail_retry",
  "fail_manual_recovery",
  "throw",
  "runtime_unavailable"
]);

const EXECUTOR_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_EXECUTOR_ERROR_CODES
);

const ADAPTERS: ReadonlyMap<WorkflowStepExecutorKind, WorkflowStepExecutor> =
  new Map(
    WORKFLOW_STEP_EXECUTOR_KINDS.map(
      (kind) => [kind, buildFakeExecutor(kind)] as const
    )
  );

export function getWorkflowStepExecutor(
  kind: string
): WorkflowStepExecutor | undefined {
  if (!isWorkflowStepExecutorKind(kind)) return undefined;
  return ADAPTERS.get(kind);
}

export function listWorkflowStepExecutorKinds(): readonly WorkflowStepExecutorKind[] {
  return WORKFLOW_STEP_EXECUTOR_KINDS;
}

export function listExecutingWorkflowStepExecutorKinds(): readonly WorkflowStepExecutorKind[] {
  return WORKFLOW_STEP_EXECUTOR_KINDS.filter((kind) => {
    const adapter = ADAPTERS.get(kind);
    return adapter?.executes === true;
  });
}

export function dispatchWorkflowStepExecutor(
  kind: string,
  input: WorkflowStepExecutorInput
): WorkflowStepExecutorDispatchResult {
  const invalid = validateInput(input, kind);
  if (invalid !== null) return invalid;

  const executor = getWorkflowStepExecutor(kind);
  if (!executor) {
    return unsupportedStepError(kind);
  }
  if (!executor.executes) {
    return unsupportedStepError(kind);
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
      resultJsonPath: input.resultJsonPath
    };
  }
}

function buildFakeExecutor(
  kind: WorkflowStepExecutorKind
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (input) => runFakeWorkflowStepExecutor(kind, input)
  };
}

function runFakeWorkflowStepExecutor(
  kind: WorkflowStepExecutorKind,
  input: WorkflowStepExecutorInput
): WorkflowStepExecutorDispatchResult {
  const config = readFakeConfig(input.config);
  if (!config.ok) {
    return {
      ok: false,
      code: "invalid_input",
      error: config.error,
      executorLogPath: input.executorLogPath,
      resultJsonPath: input.resultJsonPath
    };
  }
  const outcome = config.value.outcome ?? "success";
  const checkpointMessages = config.value.checkpointMessages ?? [
    `${kind}:start`,
    `${kind}:work`
  ];
  const baseAt = 1;
  const checkpoints: WorkflowStepExecutorCheckpoint[] = checkpointMessages.map(
    (message, index) => ({
      at: baseAt + index,
      message
    })
  );

  switch (outcome) {
    case "success":
      return success({
        kind,
        input,
        config: config.value,
        checkpoints,
        state: "succeeded"
      });
    case "skip":
      return success({
        kind,
        input,
        config: config.value,
        checkpoints,
        state: "skipped"
      });
    case "fail_retry":
      return failure({
        kind,
        input,
        config: config.value,
        checkpoints,
        errorCode: config.value.errorCode ?? "command_failed",
        retryHint: "retry_after_delay",
        recoveryHint: "resume"
      });
    case "fail_manual_recovery":
      return failure({
        kind,
        input,
        config: config.value,
        checkpoints,
        errorCode: config.value.errorCode ?? "manual_recovery_required",
        retryHint: "do_not_retry",
        recoveryHint: "manual_recovery_required"
      });
    case "throw":
      throw new Error(
        config.value.errorMessage ??
          `fake workflow step executor "${kind}" forced throw`
      );
    case "runtime_unavailable":
      return {
        ok: false,
        code: "runtime_unavailable",
        error:
          config.value.errorMessage ??
          `fake workflow step executor "${kind}" simulated runtime_unavailable`,
        executorLogPath: input.executorLogPath,
        resultJsonPath: input.resultJsonPath
      };
  }
}

type FakeConfigParse =
  | { ok: true; value: FakeWorkflowStepExecutorConfig }
  | { ok: false; error: string };

function readFakeConfig(raw: unknown): FakeConfigParse {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "WorkflowStepExecutorInput.config must be a plain object."
    };
  }
  const record = raw as Record<string, unknown>;
  const value: FakeWorkflowStepExecutorConfig = {};

  if (record["outcome"] !== undefined) {
    const rawOutcome = record["outcome"];
    if (
      typeof rawOutcome !== "string" ||
      !FAKE_OUTCOMES.has(rawOutcome as FakeWorkflowStepExecutorOutcome)
    ) {
      return {
        ok: false,
        error: `WorkflowStepExecutorInput.config.outcome must be one of: ${[...FAKE_OUTCOMES].join(", ")}.`
      };
    }
    value.outcome = rawOutcome as FakeWorkflowStepExecutorOutcome;
  }
  if (record["errorCode"] !== undefined) {
    if (typeof record["errorCode"] !== "string") {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.errorCode must be a string."
      };
    }
    if (!EXECUTOR_ERROR_CODE_SET.has(record["errorCode"])) {
      return {
        ok: false,
        error: `WorkflowStepExecutorInput.config.errorCode must be one of: ${WORKFLOW_STEP_EXECUTOR_ERROR_CODES.join(", ")}.`
      };
    }
    value.errorCode = record["errorCode"] as WorkflowStepExecutorErrorCode;
  }
  if (record["errorMessage"] !== undefined) {
    if (typeof record["errorMessage"] !== "string") {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.errorMessage must be a string."
      };
    }
    value.errorMessage = record["errorMessage"];
  }
  if (record["resultDigest"] !== undefined) {
    if (typeof record["resultDigest"] !== "string") {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.resultDigest must be a string."
      };
    }
    value.resultDigest = record["resultDigest"];
  }
  if (record["artifacts"] !== undefined) {
    if (!Array.isArray(record["artifacts"])) {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.artifacts must be an array."
      };
    }
    const artifacts: WorkflowStepExecutorArtifact[] = [];
    for (const entry of record["artifacts"]) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as Record<string, unknown>)["kind"] !== "string" ||
        typeof (entry as Record<string, unknown>)["path"] !== "string"
      ) {
        return {
          ok: false,
          error:
            "WorkflowStepExecutorInput.config.artifacts entries must have string `kind` and `path`."
        };
      }
      const record2 = entry as Record<string, unknown>;
      const artifact: WorkflowStepExecutorArtifact = {
        kind: record2["kind"] as string,
        path: record2["path"] as string
      };
      if (record2["digest"] !== undefined) {
        if (typeof record2["digest"] !== "string") {
          return {
            ok: false,
            error:
              "WorkflowStepExecutorInput.config.artifacts.digest must be a string."
          };
        }
        artifact.digest = record2["digest"];
      }
      artifacts.push(artifact);
    }
    value.artifacts = artifacts;
  }
  if (record["checkpointMessages"] !== undefined) {
    if (!Array.isArray(record["checkpointMessages"])) {
      return {
        ok: false,
        error:
          "WorkflowStepExecutorInput.config.checkpointMessages must be an array of strings."
      };
    }
    const messages: string[] = [];
    for (const entry of record["checkpointMessages"]) {
      if (typeof entry !== "string") {
        return {
          ok: false,
          error:
            "WorkflowStepExecutorInput.config.checkpointMessages entries must be strings."
        };
      }
      messages.push(entry);
    }
    value.checkpointMessages = messages;
  }
  return { ok: true, value };
}

type FakeOutcomeInput = {
  kind: WorkflowStepExecutorKind;
  input: WorkflowStepExecutorInput;
  config: FakeWorkflowStepExecutorConfig;
  checkpoints: WorkflowStepExecutorCheckpoint[];
};

function success(
  args: FakeOutcomeInput & {
    state: Extract<WorkflowStepExecutorTerminalState, "succeeded" | "skipped">;
  }
): WorkflowStepExecutorSuccess {
  const { input, config, checkpoints, state, kind } = args;
  const result: WorkflowStepExecutorResult = {
    state,
    summary: `fake ${kind} executor reported ${state}`,
    checkpoints,
    artifacts: config.artifacts ?? [],
    resultDigest: config.resultDigest ?? null,
    errorCode: null,
    errorMessage: null,
    retryHint: null,
    recoveryHint: state === "skipped" ? "skip_already_complete" : null
  };
  return {
    ok: true,
    result,
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
    diagnostics: {
      executor: "fake",
      kind,
      attempt: input.attempt
    }
  };
}

function failure(
  args: FakeOutcomeInput & {
    errorCode: WorkflowStepExecutorErrorCode;
    retryHint: WorkflowStepExecutorRetryHint;
    recoveryHint: WorkflowStepExecutorRecoveryHint;
  }
): WorkflowStepExecutorSuccess {
  const { input, config, checkpoints, errorCode, retryHint, recoveryHint, kind } =
    args;
  const result: WorkflowStepExecutorResult = {
    state: "failed",
    summary: `fake ${kind} executor reported failed (${errorCode})`,
    checkpoints,
    artifacts: config.artifacts ?? [],
    resultDigest: config.resultDigest ?? null,
    errorCode,
    errorMessage:
      config.errorMessage ??
      `fake ${kind} executor injected ${errorCode}`,
    retryHint,
    recoveryHint
  };
  return {
    ok: true,
    result,
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
    diagnostics: {
      executor: "fake",
      kind,
      attempt: input.attempt,
      injected: errorCode
    }
  };
}

function unsupportedStepError(kind: string): WorkflowStepExecutorError {
  const executing = listExecutingWorkflowStepExecutorKinds();
  return {
    ok: false,
    code: "unsupported_step",
    error: `Workflow step "${kind}" is not supported for execution; supported step kinds: ${executing.join(", ") || "<none>"}.`,
    executorLogPath: undefined,
    resultJsonPath: undefined
  };
}

function validateInput(
  input: WorkflowStepExecutorInput,
  kind: string
): WorkflowStepExecutorError | null {
  if (typeof kind !== "string" || kind.length === 0) {
    return invalidInputError("kind", undefined, undefined);
  }
  if (
    typeof input.runId !== "string" ||
    input.runId.trim().length === 0
  ) {
    return invalidInputError("runId", undefined, undefined);
  }
  if (
    typeof input.stepId !== "string" ||
    input.stepId.trim().length === 0
  ) {
    return invalidInputError("stepId", undefined, undefined);
  }
  if (!isWorkflowStepExecutorKind(input.kind)) {
    return invalidInputError(
      "kind",
      undefined,
      undefined,
      `WorkflowStepExecutorInput.kind must be one of: ${WORKFLOW_STEP_EXECUTOR_KINDS.join(", ")}.`
    );
  }
  if (input.kind !== kind) {
    return invalidInputError(
      "kind",
      undefined,
      undefined,
      `WorkflowStepExecutorInput.kind "${input.kind}" must match dispatch kind "${kind}".`
    );
  }
  if (
    typeof input.repoPath !== "string" ||
    input.repoPath.trim().length === 0
  ) {
    return invalidInputError(
      "repoPath",
      input.executorLogPath,
      input.resultJsonPath
    );
  }
  if (typeof input.runDir !== "string" || input.runDir.trim().length === 0) {
    return invalidInputError(
      "runDir",
      input.executorLogPath,
      input.resultJsonPath
    );
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return invalidInputError(
      "attempt",
      input.executorLogPath,
      input.resultJsonPath,
      "WorkflowStepExecutorInput.attempt must be a positive integer."
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
    return invalidInputError("resultJsonPath", input.executorLogPath, undefined);
  }
  return null;
}

function invalidInputError(
  field: string,
  executorLogPath: string | undefined,
  resultJsonPath: string | undefined,
  message?: string
): WorkflowStepExecutorError {
  return {
    ok: false,
    code: "invalid_input",
    error: message ?? `WorkflowStepExecutorInput.${field} is required.`,
    executorLogPath,
    resultJsonPath
  };
}
