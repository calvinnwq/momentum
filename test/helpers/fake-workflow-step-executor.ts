/**
 * Test-only deterministic fake `WorkflowStepExecutor` seam (RC-5, NGX-485).
 *
 * The M7 executor boundary (`src/core/workflow/step/executor.ts`) originally
 * shipped this fake as the production `ADAPTERS` map default: every
 * `WorkflowStepExecutorKind` resolved to a deterministic fake. The runtime
 * consolidation plan (`SPEC.md`, Path 6)
 * classified that as *deprecate-later* — valuable substrate coverage, but not
 * production executor support. RC-5 flipped the production default to real
 * adapters (`step-executor-real-adapters.ts`, honest `runtime_unavailable` when
 * unconfigured) and moved this deterministic fake behavior here, behind an
 * explicit test-only seam.
 *
 * Nothing under `src/` imports this module, so the fake never ships in `dist/`
 * (`tsconfig.json` builds `src/**` only). The M7/M8/M10 substrate smokes and the
 * executor-boundary contract test inject {@link buildFakeWorkflowStepExecutorRegistry}
 * into `dispatchWorkflowStepExecutor`'s `registry` parameter so they keep a
 * deterministic executor without depending on a shipped fake default.
 *
 * The fake mirrors the production dispatch surface exactly: it consumes the same
 * `WorkflowStepExecutorInput`, returns the same `WorkflowStepExecutorDispatchResult`
 * taxonomy, owns the `input.config` schema (outcome / artifacts / digest /
 * checkpoint messages), and throws on the `throw` outcome so the boundary's
 * `executor_threw` trap still applies. This file is a faithful move of the
 * previously shipped fake — its behavior is unchanged so the substrate smoke and
 * boundary contract stay byte-stable.
 */

import {
  WORKFLOW_STEP_EXECUTOR_ERROR_CODES,
  WORKFLOW_STEP_EXECUTOR_KINDS,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorArtifact,
  type WorkflowStepExecutorCheckpoint,
  type WorkflowStepExecutorDispatchResult,
  type WorkflowStepExecutorErrorCode,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
  type WorkflowStepExecutorRecoveryHint,
  type WorkflowStepExecutorResult,
  type WorkflowStepExecutorRetryHint,
  type WorkflowStepExecutorSuccess,
  type WorkflowStepExecutorTerminalState,
} from "../../src/core/workflow/step/executor.js";

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
  "runtime_unavailable",
]);

const EXECUTOR_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  WORKFLOW_STEP_EXECUTOR_ERROR_CODES,
);

/**
 * Build a deterministic fake `WorkflowStepExecutor` for one canonical step kind.
 * The returned executor mirrors the real executor surface (`executes: true`) and
 * resolves its outcome from `input.config` so tests can drive every terminal /
 * failure branch without a live command runner.
 */
export function createFakeWorkflowStepExecutor(
  kind: WorkflowStepExecutorKind,
): WorkflowStepExecutor {
  return {
    kind,
    executes: true,
    execute: (input) => runFakeWorkflowStepExecutor(kind, input),
  };
}

/**
 * Build the full deterministic fake registry, keyed by every canonical
 * `WorkflowStepExecutorKind`. Inject this into `dispatchWorkflowStepExecutor` /
 * `getWorkflowStepExecutor` / `listExecutingWorkflowStepExecutorKinds` via their
 * `registry` parameter to drive the M7/M8/M10 substrate smokes deterministically.
 */
export function buildFakeWorkflowStepExecutorRegistry(): ReadonlyMap<
  WorkflowStepExecutorKind,
  WorkflowStepExecutor
> {
  return new Map(
    WORKFLOW_STEP_EXECUTOR_KINDS.map(
      (kind) => [kind, createFakeWorkflowStepExecutor(kind)] as const,
    ),
  );
}

function runFakeWorkflowStepExecutor(
  kind: WorkflowStepExecutorKind,
  input: WorkflowStepExecutorInput,
): WorkflowStepExecutorDispatchResult {
  const config = readFakeConfig(input.config);
  if (!config.ok) {
    return {
      ok: false,
      code: "invalid_input",
      error: config.error,
      executorLogPath: input.executorLogPath,
      resultJsonPath: input.resultJsonPath,
    };
  }
  const outcome = config.value.outcome ?? "success";
  const checkpointMessages = config.value.checkpointMessages ?? [
    `${kind}:start`,
    `${kind}:work`,
  ];
  const baseAt = 1;
  const checkpoints: WorkflowStepExecutorCheckpoint[] = checkpointMessages.map(
    (message, index) => ({
      at: baseAt + index,
      message,
    }),
  );

  switch (outcome) {
    case "success":
      return success({
        kind,
        input,
        config: config.value,
        checkpoints,
        state: "succeeded",
      });
    case "skip":
      return success({
        kind,
        input,
        config: config.value,
        checkpoints,
        state: "skipped",
      });
    case "fail_retry":
      return failure({
        kind,
        input,
        config: config.value,
        checkpoints,
        errorCode: config.value.errorCode ?? "command_failed",
        retryHint: "retry_after_delay",
        recoveryHint: "resume",
      });
    case "fail_manual_recovery":
      return failure({
        kind,
        input,
        config: config.value,
        checkpoints,
        errorCode: config.value.errorCode ?? "manual_recovery_required",
        retryHint: "do_not_retry",
        recoveryHint: "manual_recovery_required",
      });
    case "throw":
      throw new Error(
        config.value.errorMessage ??
          `fake workflow step executor "${kind}" forced throw`,
      );
    case "runtime_unavailable":
      return {
        ok: false,
        code: "runtime_unavailable",
        error:
          config.value.errorMessage ??
          `fake workflow step executor "${kind}" simulated runtime_unavailable`,
        executorLogPath: input.executorLogPath,
        resultJsonPath: input.resultJsonPath,
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
      error: "WorkflowStepExecutorInput.config must be a plain object.",
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
        error: `WorkflowStepExecutorInput.config.outcome must be one of: ${[...FAKE_OUTCOMES].join(", ")}.`,
      };
    }
    value.outcome = rawOutcome as FakeWorkflowStepExecutorOutcome;
  }
  if (record["errorCode"] !== undefined) {
    if (typeof record["errorCode"] !== "string") {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.errorCode must be a string.",
      };
    }
    if (!EXECUTOR_ERROR_CODE_SET.has(record["errorCode"])) {
      return {
        ok: false,
        error: `WorkflowStepExecutorInput.config.errorCode must be one of: ${WORKFLOW_STEP_EXECUTOR_ERROR_CODES.join(", ")}.`,
      };
    }
    value.errorCode = record["errorCode"] as WorkflowStepExecutorErrorCode;
  }
  if (record["errorMessage"] !== undefined) {
    if (typeof record["errorMessage"] !== "string") {
      return {
        ok: false,
        error:
          "WorkflowStepExecutorInput.config.errorMessage must be a string.",
      };
    }
    value.errorMessage = record["errorMessage"];
  }
  if (record["resultDigest"] !== undefined) {
    if (typeof record["resultDigest"] !== "string") {
      return {
        ok: false,
        error:
          "WorkflowStepExecutorInput.config.resultDigest must be a string.",
      };
    }
    value.resultDigest = record["resultDigest"];
  }
  if (record["artifacts"] !== undefined) {
    if (!Array.isArray(record["artifacts"])) {
      return {
        ok: false,
        error: "WorkflowStepExecutorInput.config.artifacts must be an array.",
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
            "WorkflowStepExecutorInput.config.artifacts entries must have string `kind` and `path`.",
        };
      }
      const record2 = entry as Record<string, unknown>;
      const artifact: WorkflowStepExecutorArtifact = {
        kind: record2["kind"] as string,
        path: record2["path"] as string,
      };
      if (record2["digest"] !== undefined) {
        if (typeof record2["digest"] !== "string") {
          return {
            ok: false,
            error:
              "WorkflowStepExecutorInput.config.artifacts.digest must be a string.",
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
          "WorkflowStepExecutorInput.config.checkpointMessages must be an array of strings.",
      };
    }
    const messages: string[] = [];
    for (const entry of record["checkpointMessages"]) {
      if (typeof entry !== "string") {
        return {
          ok: false,
          error:
            "WorkflowStepExecutorInput.config.checkpointMessages entries must be strings.",
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
  },
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
    recoveryHint: state === "skipped" ? "skip_already_complete" : null,
  };
  return {
    ok: true,
    result,
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
    diagnostics: {
      executor: "fake",
      kind,
      attempt: input.attemptNumber,
    },
  };
}

function failure(
  args: FakeOutcomeInput & {
    errorCode: WorkflowStepExecutorErrorCode;
    retryHint: WorkflowStepExecutorRetryHint;
    recoveryHint: WorkflowStepExecutorRecoveryHint;
  },
): WorkflowStepExecutorSuccess {
  const {
    input,
    config,
    checkpoints,
    errorCode,
    retryHint,
    recoveryHint,
    kind,
  } = args;
  const result: WorkflowStepExecutorResult = {
    state: "failed",
    summary: `fake ${kind} executor reported failed (${errorCode})`,
    checkpoints,
    artifacts: config.artifacts ?? [],
    resultDigest: config.resultDigest ?? null,
    errorCode,
    errorMessage:
      config.errorMessage ?? `fake ${kind} executor injected ${errorCode}`,
    retryHint,
    recoveryHint,
  };
  return {
    ok: true,
    result,
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
    diagnostics: {
      executor: "fake",
      kind,
      attempt: input.attemptNumber,
      injected: errorCode,
    },
  };
}
