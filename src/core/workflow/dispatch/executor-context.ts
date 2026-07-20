import type {
  WorkflowStepExecutorInput,
  WorkflowStepExecutorKind,
} from "../step/executor.js";

export type DispatchedStepExecutorContext = {
  repoPath: string;
  runDir: string;
  resultJsonPath: string;
  executorLogPath: string;
  repoSafety?: DispatchedStepRepoSafetyContext;
  attemptNumber?: number;
  promptPath?: string;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
};

export type DispatchedStepRepoSafetyContext = {
  baseHead: string;
  repoRoot?: string;
  verificationCommands: string[];
  verificationTimeoutSec: number;
  verificationLogPath: string;
  beforeGitMutation?: () => { ok: true } | { ok: false; error: string };
};

export type DispatchedStepExecutorSelection = {
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
};

const DEFAULT_SELECTION: DispatchedStepExecutorSelection = {
  agentProvider: null,
  model: null,
  effort: null,
};

/** Build the legacy live-step adapter input from durable dispatch host bindings. */
export function buildDispatchedStepExecutorInput(
  kind: WorkflowStepExecutorKind,
  runId: string,
  stepId: string,
  exec: DispatchedStepExecutorContext,
  selection: DispatchedStepExecutorSelection = DEFAULT_SELECTION,
): WorkflowStepExecutorInput {
  return {
    runId,
    stepId,
    kind,
    attemptNumber: exec.attemptNumber ?? 1,
    agentProvider: selection.agentProvider,
    model: selection.model,
    effort: selection.effort,
    repoPath: exec.repoPath,
    runDir: exec.runDir,
    resultJsonPath: exec.resultJsonPath,
    executorLogPath: exec.executorLogPath,
    ...(exec.promptPath !== undefined ? { promptPath: exec.promptPath } : {}),
    ...(exec.ledgerPath !== undefined ? { ledgerPath: exec.ledgerPath } : {}),
    ...(exec.env !== undefined ? { env: exec.env } : {}),
    ...(exec.config !== undefined ? { config: exec.config } : {}),
  };
}
