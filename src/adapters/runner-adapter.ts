/**
 * Runner adapter boundary introduced by NGX-281 (M4-02).
 *
 * `RunnerAdapter` is the single dispatch seam shared by foreground and queued
 * execution. Momentum core continues to own Goal/Iteration/Job state, the
 * git transaction, verification, and the artifact layout. Adapters only
 * execute the iteration prompt and report a normalized result; they do not
 * touch git, do not run verification, and do not perform external tracker
 * writes.
 */

import { runAcpRunner } from "../acp-runner.js";
import type { GoalSpec } from "../goal-spec.js";
import { runFakeRunner } from "../fake-runner.js";
import {
  BUILTIN_RUNNER_KINDS,
  type BuiltinRunnerKind,
  isBuiltinRunnerKind
} from "../runner-profile.js";
import type { RunnerResult } from "../runner-result.js";
import { runTrustedShellRunner } from "./trusted-shell-runner.js";

export type RunnerAdapterErrorCode =
  | "invalid_input"
  | "unsupported_runner"
  | "runner_threw"
  | "result_invalid"
  | "result_missing"
  | "command_failed"
  | "command_timed_out"
  | "spawn_failed"
  | "output_overflow"
  | "runtime_unavailable"
  | "startup_failed";

export type RunnerAdapterError = {
  ok: false;
  code: RunnerAdapterErrorCode;
  error: string;
  runnerLogPath: string | undefined;
  resultJsonPath: string | undefined;
};

export type RunnerAdapterSuccess = {
  ok: true;
  result: RunnerResult;
  runnerLogPath: string;
  resultJsonPath: string;
  diagnostics: Record<string, unknown> | undefined;
};

export type RunnerAdapterResult = RunnerAdapterSuccess | RunnerAdapterError;

export type RunnerAdapterInput = {
  goalId: string;
  iteration: number;
  repoPath: string;
  baseHead: string;
  branch: string;
  promptPath: string;
  iterationDir: string;
  resultJsonPath: string;
  runnerLogPath: string;
  spec: GoalSpec;
  env?: NodeJS.ProcessEnv;
};

export type RunnerAdapter = {
  kind: BuiltinRunnerKind;
  executes: boolean;
  execute: (input: RunnerAdapterInput) => RunnerAdapterResult;
};

const ADAPTERS: ReadonlyMap<BuiltinRunnerKind, RunnerAdapter> = new Map([
  ["fake", buildFakeAdapter()],
  ["trusted-shell", buildTrustedShellAdapter()],
  ["acp", buildAcpAdapter()]
]);

export function getRunnerAdapter(kind: string): RunnerAdapter | undefined {
  if (!isBuiltinRunnerKind(kind)) return undefined;
  return ADAPTERS.get(kind);
}

export function listRunnerAdapterKinds(): readonly BuiltinRunnerKind[] {
  return BUILTIN_RUNNER_KINDS;
}

export function listExecutingRunnerAdapterKinds(): readonly BuiltinRunnerKind[] {
  return BUILTIN_RUNNER_KINDS.filter((kind) => {
    const adapter = ADAPTERS.get(kind);
    return adapter?.executes === true;
  });
}

export function dispatchRunnerAdapter(
  kind: string,
  input: RunnerAdapterInput
): RunnerAdapterResult {
  const invalid = validateInput(input);
  if (invalid !== null) return invalid;

  const adapter = getRunnerAdapter(kind);
  if (!adapter) {
    return unsupportedRunnerError(kind);
  }
  if (!adapter.executes) {
    return unsupportedRunnerError(kind);
  }

  try {
    return adapter.execute(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "runner_threw",
      error: `Runner "${kind}" threw: ${detail}`,
      runnerLogPath: input.runnerLogPath,
      resultJsonPath: input.resultJsonPath
    };
  }
}

function buildFakeAdapter(): RunnerAdapter {
  return {
    kind: "fake",
    executes: true,
    execute: (input: RunnerAdapterInput): RunnerAdapterResult => {
      const out = runFakeRunner({
        repoPath: input.repoPath,
        iterationDir: input.iterationDir,
        iteration: input.iteration,
        ...(input.env !== undefined ? { env: input.env } : {})
      });
      return {
        ok: true,
        result: out.result,
        runnerLogPath: out.runnerLogPath,
        resultJsonPath: out.resultJsonPath,
        diagnostics: {
          outcome: out.outcome,
          fixturePath: out.fixturePath,
          fixtureExisted: out.fixtureExisted
        }
      };
    }
  };
}

function buildTrustedShellAdapter(): RunnerAdapter {
  return {
    kind: "trusted-shell",
    executes: true,
    execute: (input: RunnerAdapterInput): RunnerAdapterResult =>
      runTrustedShellRunner(input)
  };
}

function buildAcpAdapter(): RunnerAdapter {
  return {
    kind: "acp",
    executes: true,
    execute: (input: RunnerAdapterInput): RunnerAdapterResult =>
      runAcpRunner(input)
  };
}

function unsupportedRunnerError(kind: string): RunnerAdapterError {
  const executing = listExecutingRunnerAdapterKinds();
  return {
    ok: false,
    code: "unsupported_runner",
    error: `Runner "${kind}" is not supported for execution; supported executing runners: ${executing.join(", ") || "<none>"}.`,
    runnerLogPath: undefined,
    resultJsonPath: undefined
  };
}

function validateInput(input: RunnerAdapterInput): RunnerAdapterError | null {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return invalidInputError("repoPath");
  }
  if (
    typeof input.iterationDir !== "string" ||
    input.iterationDir.trim().length === 0
  ) {
    return invalidInputError("iterationDir");
  }
  if (!Number.isInteger(input.iteration) || input.iteration < 1) {
    return {
      ok: false,
      code: "invalid_input",
      error: "RunnerAdapterInput.iteration must be a positive integer.",
      runnerLogPath: undefined,
      resultJsonPath: undefined
    };
  }
  if (
    typeof input.runnerLogPath !== "string" ||
    input.runnerLogPath.trim().length === 0
  ) {
    return invalidInputError("runnerLogPath");
  }
  if (
    typeof input.resultJsonPath !== "string" ||
    input.resultJsonPath.trim().length === 0
  ) {
    return invalidInputError("resultJsonPath");
  }
  return null;
}

function invalidInputError(field: string): RunnerAdapterError {
  return {
    ok: false,
    code: "invalid_input",
    error: `RunnerAdapterInput.${field} is required.`,
    runnerLogPath: undefined,
    resultJsonPath: undefined
  };
}
