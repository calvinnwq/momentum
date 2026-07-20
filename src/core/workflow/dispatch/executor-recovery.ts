import type { MomentumDb } from "../../../adapters/db.js";
import type { WorkflowStepExecutorDispatchResult } from "../step/executor.js";
import {
  WORKFLOW_RECOVERY_CLASSIFICATIONS,
  writeWorkflowRecoveryArtifactInRunDir,
  type WorkflowRecoveryClassification,
} from "../recovery/artifact.js";
import {
  terminalizeDispatchedExecutorAttempt,
  type TerminalizeDispatchedExecutorResult,
} from "./executor-evidence.js";
import {
  reconcileDispatchedWorkflowStep,
  type WorkflowStepReconciliationResult,
} from "./reconcile-execute.js";

export const WORKFLOW_EXECUTE_RECONCILE_STATUS = {
  notDispatched: "execute_not_dispatched",
  stepNotFound: "execute_step_not_found",
  stepNotRunning: "execute_step_not_running",
  executedAndReconciled: "execute_reconciled",
  alreadyExecuted: "execute_already_executed",
  reconcileDeferred: "execute_reconcile_deferred",
  childDeferred: "execute_child_deferred",
  contextUnresolved: "execute_context_unresolved",
  executionRejected: "execute_rejected",
} as const;

export type WorkflowExecuteReconcileStatus =
  (typeof WORKFLOW_EXECUTE_RECONCILE_STATUS)[keyof typeof WORKFLOW_EXECUTE_RECONCILE_STATUS];

export type ExecuteAndReconcileDispatchedStepResult = {
  status: WorkflowExecuteReconcileStatus;
  executorResult?: WorkflowStepExecutorDispatchResult;
  finalizedResult?: WorkflowStepExecutorDispatchResult;
  terminalize?: TerminalizeDispatchedExecutorResult;
  reconcile?: WorkflowStepReconciliationResult;
  detail?: string;
};

export type RecordDispatchedStepManualRecoveryInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  error: string;
  now: number;
  status?: WorkflowExecuteReconcileStatus;
  detail?: string;
  recoveryArtifact?: { runDir: string; repoPath?: string | null };
  recoveryCode?: string;
  leaseIdentity?: { holder: string; acquiredAt: number };
};

export type RecordUnresolvedDispatchedStepContextInput = {
  db: MomentumDb;
  runId: string;
  stepId: string;
  reason: string;
  now: number;
  recoveryCode?: string;
  recoveryArtifact?: RecordDispatchedStepManualRecoveryInput["recoveryArtifact"];
};

/** Park a dispatched scaffold from durable error evidence and reconcile it. */
export function recordDispatchedStepManualRecovery(
  input: RecordDispatchedStepManualRecoveryInput,
): ExecuteAndReconcileDispatchedStepResult {
  const executorResult = {
    ok: false as const,
    code: "runtime_unavailable" as const,
    error: input.error,
    executorLogPath: undefined,
    resultJsonPath: undefined,
    ...(input.recoveryCode !== undefined
      ? { liveRecoveryCode: input.recoveryCode }
      : {}),
  };
  const terminalize = terminalizeDispatchedExecutorAttempt({
    db: input.db,
    runId: input.runId,
    stepId: input.stepId,
    result: executorResult,
    now: input.now,
  });
  writeRecoveryArtifact(input);
  try {
    const reconcile = reconcileDispatchedWorkflowStep({
      db: input.db,
      runId: input.runId,
      stepId: input.stepId,
      ...(input.leaseIdentity !== undefined
        ? { leaseIdentity: input.leaseIdentity }
        : {}),
      now: input.now,
    });
    return {
      status:
        input.status ?? WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
      executorResult,
      terminalize,
      reconcile,
      detail: input.detail ?? input.error,
    };
  } catch (error) {
    return {
      status: WORKFLOW_EXECUTE_RECONCILE_STATUS.reconcileDeferred,
      executorResult,
      terminalize,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordUnresolvedDispatchedStepContext(
  input: RecordUnresolvedDispatchedStepContextInput,
): ExecuteAndReconcileDispatchedStepResult {
  return recordDispatchedStepManualRecovery({
    db: input.db,
    runId: input.runId,
    stepId: input.stepId,
    now: input.now,
    error: `cannot derive execution context for dispatched step ${input.runId}/${input.stepId}: ${input.reason}`,
    status: WORKFLOW_EXECUTE_RECONCILE_STATUS.contextUnresolved,
    detail: input.reason,
    ...(input.recoveryCode !== undefined
      ? { recoveryCode: input.recoveryCode }
      : {}),
    ...(input.recoveryArtifact !== undefined
      ? { recoveryArtifact: input.recoveryArtifact }
      : {}),
  });
}

function writeRecoveryArtifact(
  input: RecordDispatchedStepManualRecoveryInput,
): void {
  if (input.recoveryArtifact === undefined) return;
  const code = input.recoveryCode ?? "runtime_unavailable";
  if (
    !(WORKFLOW_RECOVERY_CLASSIFICATIONS as readonly string[]).includes(code)
  ) {
    return;
  }
  try {
    writeWorkflowRecoveryArtifactInRunDir({
      runDir: input.recoveryArtifact.runDir,
      input: {
        runId: input.runId,
        stepId: input.stepId,
        classification: code as WorkflowRecoveryClassification,
        reason: input.error,
        recommendedNextAction: {
          code: `investigate_${code}`,
          detail:
            "Inspect the recorded evidence, repair the blocking condition, then clear recovery explicitly.",
          stepId: input.stepId,
        },
        evidencePointers: [],
        repoPath: input.recoveryArtifact.repoPath ?? null,
        classifiedAt: input.now,
      },
    });
  } catch {
    // Durable recovery state remains authoritative.
  }
}
