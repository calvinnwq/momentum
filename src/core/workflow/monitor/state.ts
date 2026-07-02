/**
 * Pure workflow monitor / recovery reducer introduced by NGX-316 (M7-04).
 *
 * Derives a normalized monitor / recovery view from the durable substrate
 * (steps, leases, advisory monitor snapshot, last checkpoint) without touching
 * SQLite, the file system, or executors. The reducer encodes the contract
 * invariant pinned in SPEC.md and the M7 milestone
 * doc: **terminal ledger / imported evidence beats stale monitor snapshots**,
 * and a workflow may not be reported as active without a live lease or
 * checkpoint.
 *
 * Recovery codes: `stale_running_step`, `ghost_active_no_lease`,
 * `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`,
 * `failed_external_side_effect_step`. The last splits off the subset of
 * `failed_required_step` where the failed required step is an external-side-
 * effect tail step (merge-cleanup / linear-refresh): its child may already have
 * pushed a branch, merged a PR, or written the tracker before exiting non-zero,
 * so the recovery steers operators to verify external state and reconcile via
 * `clear-recovery` rather than the `rerun_failed_step` that an ordinary failed
 * step gets - a naive re-run there could double-merge or re-write.
 * `ghost_active_no_lease` vs `stale_running_step` is discriminated on whether
 * any non-monitor (`managed-step` / `dispatch`) lease has ever been recorded
 * for the run — a workflow that only has a monitor lease has never dispatched
 * a managed child and is a ghost. `stale_running_step` is also emitted when
 * all steps have finalized but an outstanding non-monitor lease keeps the run
 * in `running` (the lease-aware demotion path); the nextAction in that case
 * is `investigate_stale` keyed off the orphan lease, not `await_approval`.
 * `monitor_drift_stale` is emitted when the monitor advisory disagrees with
 * the substrate state and no other primary recovery condition applies; it
 * surfaces through `needsRecoveryArtifact = true` without changing the
 * `nextAction` away from the step's natural progression. Terminal runs
 * (succeeded / canceled) never produce a recovery code even when monitor
 * drift is present — the drift is captured in `monitorDrift` instead.
 *
 * Recovery generation (rendering the per-run `recovery.md` artifact) lives in a
 * follow-up M7 slice. This module owns the classification only.
 */

import {
  classifyWorkflowLease,
  deriveWorkflowRunState,
  isExternalSideEffectTailStepKind,
  isTerminalRunState,
  type WorkflowLeaseFreshnessClassification,
  type WorkflowLeaseKind,
  type WorkflowLeaseRecord,
  type WorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "../run/reducer.js";

export const WORKFLOW_MONITOR_NEXT_ACTION_CODES = [
  "no_action",
  "advance_to_step",
  "await_approval",
  "resume_running",
  "investigate_stale",
  "clear_recovery",
  "rerun_failed_step"
] as const;
export type WorkflowMonitorNextActionCode =
  (typeof WORKFLOW_MONITOR_NEXT_ACTION_CODES)[number];

export const WORKFLOW_MONITOR_RECOVERY_CODES = [
  "stale_running_step",
  "ghost_active_no_lease",
  "manual_recovery_lease",
  "monitor_drift_stale",
  "failed_required_step",
  "failed_external_side_effect_step"
] as const;
export type WorkflowMonitorRecoveryCode =
  (typeof WORKFLOW_MONITOR_RECOVERY_CODES)[number];

export type WorkflowMonitorAdvisory = {
  runState: string | null;
  terminal: boolean | null;
  step: string | null;
  lastSeenDigest: string | null;
  lastEmittedDigest: string | null;
};

export type WorkflowMonitorCheckpointSource =
  | "ledger"
  | "approval"
  | "lease-heartbeat";

export type WorkflowMonitorCheckpoint = {
  stepId: string;
  at: number;
  source: WorkflowMonitorCheckpointSource;
  digest: string | null;
};

export type WorkflowMonitorLeaseView = {
  leaseKind: WorkflowLeaseKind;
  holder: string;
  classification: WorkflowLeaseFreshnessClassification;
  expiresAt: number;
  heartbeatAt: number;
  releasedAt: number | null;
};

export type WorkflowMonitorActiveStep = {
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  order: number;
  required: boolean;
};

export type WorkflowMonitorNextAction = {
  code: WorkflowMonitorNextActionCode;
  stepId: string | null;
  leaseKind: WorkflowLeaseKind | null;
  detail: string;
};

export type WorkflowMonitorDriftReason =
  | "monitor_says_active_but_terminal"
  | "monitor_says_terminal_but_running"
  | "monitor_step_mismatch";

export type WorkflowMonitorDrift = {
  advisoryState: string | null;
  advisoryTerminal: boolean | null;
  actualState: WorkflowRunState;
  drifted: boolean;
  reason: WorkflowMonitorDriftReason | null;
};

export type WorkflowMonitorRecovery = {
  code: WorkflowMonitorRecoveryCode;
  message: string;
  stepId: string | null;
};

export type WorkflowMonitorState = {
  runId: string;
  runState: WorkflowRunState;
  terminal: boolean;
  blocked: boolean;
  activeStep: WorkflowMonitorActiveStep | null;
  leases: readonly WorkflowMonitorLeaseView[];
  lastCheckpoint: WorkflowMonitorCheckpoint | null;
  monitorDrift: WorkflowMonitorDrift | null;
  nextAction: WorkflowMonitorNextAction;
  needsRecoveryArtifact: boolean;
  recovery: WorkflowMonitorRecovery | null;
};

export type WorkflowMonitorInput = {
  runId: string;
  steps: readonly WorkflowStepRecord[];
  leases: readonly WorkflowLeaseRecord[];
  monitor?: WorkflowMonitorAdvisory | null;
  lastCheckpoint?: WorkflowMonitorCheckpoint | null;
  now: number;
  graceMs?: number;
  /**
   * Wall-clock window within which `lastCheckpoint.at` is considered live
   * evidence that a running step is still making progress. Past this window,
   * a running step with no fresh lease is classified `stale_running_step`.
   * Defaults to 30 minutes — chosen to comfortably exceed the longest known
   * `coding-workflow-monitor` cron interval without crossing into the territory
   * where a real GNHF iteration could plausibly still be working in silence.
   */
  checkpointStaleMs?: number;
};

const DEFAULT_CHECKPOINT_STALE_MS = 30 * 60 * 1000;

export function deriveWorkflowMonitorState(
  input: WorkflowMonitorInput
): WorkflowMonitorState {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("deriveWorkflowMonitorState: runId is required");
  }
  if (!Number.isFinite(input.now)) {
    throw new Error("deriveWorkflowMonitorState: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "deriveWorkflowMonitorState: graceMs must be a non-negative finite number"
    );
  }
  const checkpointStaleMs =
    input.checkpointStaleMs ?? DEFAULT_CHECKPOINT_STALE_MS;
  if (!Number.isFinite(checkpointStaleMs) || checkpointStaleMs < 0) {
    throw new Error(
      "deriveWorkflowMonitorState: checkpointStaleMs must be a non-negative finite number"
    );
  }

  const leaseViews: WorkflowMonitorLeaseView[] = input.leases.map((lease) => ({
    leaseKind: lease.leaseKind,
    holder: lease.holder,
    classification: classifyWorkflowLease(lease, {
      now: input.now,
      graceMs
    }),
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt,
    releasedAt: lease.releasedAt
  }));

  const runState = deriveWorkflowRunState(input.steps, {
    leases: input.leases,
    now: input.now,
    graceMs
  });
  const terminal = isTerminalRunState(runState);
  const blocked = runState === "blocked";

  const activeStep = pickActiveStep(input.steps);
  const monitorDrift = classifyMonitorDrift(
    input.monitor ?? null,
    runState,
    activeStep
  );
  const lastCheckpoint = input.lastCheckpoint ?? null;

  const checkpointFresh = isCheckpointFresh(
    lastCheckpoint,
    activeStep,
    input.now,
    checkpointStaleMs
  );
  const hasFreshDispatchLease = hasFreshDispatchEvidence(leaseViews);

  const recovery = classifyRecovery({
    runState,
    terminal,
    activeStep,
    leases: leaseViews,
    checkpointFresh,
    hasFreshDispatchLease,
    lastCheckpoint,
    monitorDrift,
    steps: input.steps
  });

  const nextAction = decideNextAction({
    runState,
    activeStep,
    recovery,
    checkpointFresh,
    hasFreshDispatchLease,
    steps: input.steps,
    leases: leaseViews
  });

  return {
    runId: input.runId,
    runState,
    terminal,
    blocked,
    activeStep,
    leases: leaseViews,
    lastCheckpoint,
    monitorDrift,
    nextAction,
    needsRecoveryArtifact: recovery !== null,
    recovery
  };
}

function pickActiveStep(
  steps: readonly WorkflowStepRecord[]
): WorkflowMonitorActiveStep | null {
  if (steps.length === 0) return null;
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const running = sorted.find((s) => s.state === "running");
  if (running) return toActive(running);
  const blocked = sorted.find((s) => s.state === "blocked");
  if (blocked) return toActive(blocked);
  const failed = sorted.find((s) => s.state === "failed" && s.required);
  if (failed) return toActive(failed);
  const approved = sorted.find((s) => s.state === "approved");
  if (approved) return toActive(approved);
  const pending = sorted.find((s) => s.state === "pending");
  if (pending) return toActive(pending);
  return null;
}

function toActive(step: WorkflowStepRecord): WorkflowMonitorActiveStep {
  return {
    stepId: step.stepId,
    kind: step.kind,
    state: step.state,
    order: step.order,
    required: step.required
  };
}

function classifyMonitorDrift(
  monitor: WorkflowMonitorAdvisory | null,
  actualState: WorkflowRunState,
  activeStep: WorkflowMonitorActiveStep | null
): WorkflowMonitorDrift | null {
  if (monitor === null) return null;
  const advisoryTerminal = monitor.terminal;
  let reason: WorkflowMonitorDriftReason | null = null;
  const actualTerminal = isTerminalRunState(actualState);
  if (advisoryTerminal === false && actualTerminal) {
    reason = "monitor_says_active_but_terminal";
  } else if (advisoryTerminal === true && !actualTerminal) {
    reason = "monitor_says_terminal_but_running";
  } else if (
    monitor.runState !== null &&
    monitor.runState !== actualState &&
    !(monitor.runState === "running" && actualState === "blocked")
  ) {
    // Only flag a state-name drift when it is not redundant with the terminal-
    // booleans above. The blocked-during-running case is already handled by
    // lease classification (manual recovery), so do not double-report.
    reason = "monitor_step_mismatch";
  } else if (
    monitor.step !== null &&
    activeStep !== null &&
    monitor.step !== activeStep.stepId
  ) {
    reason = "monitor_step_mismatch";
  }
  return {
    advisoryState: monitor.runState,
    advisoryTerminal,
    actualState,
    drifted: reason !== null,
    reason
  };
}

function isCheckpointFresh(
  checkpoint: WorkflowMonitorCheckpoint | null,
  activeStep: WorkflowMonitorActiveStep | null,
  now: number,
  staleMs: number
): boolean {
  if (checkpoint === null) return false;
  if (activeStep === null) return false;
  if (checkpoint.stepId !== activeStep.stepId) return false;
  return now - checkpoint.at <= staleMs;
}

function hasFreshDispatchEvidence(
  leases: readonly WorkflowMonitorLeaseView[]
): boolean {
  for (const lease of leases) {
    if (lease.leaseKind === "monitor") continue;
    if (lease.classification === "fresh") return true;
  }
  return false;
}

type RecoveryInput = {
  runState: WorkflowRunState;
  terminal: boolean;
  activeStep: WorkflowMonitorActiveStep | null;
  leases: readonly WorkflowMonitorLeaseView[];
  checkpointFresh: boolean;
  hasFreshDispatchLease: boolean;
  lastCheckpoint: WorkflowMonitorCheckpoint | null;
  monitorDrift: WorkflowMonitorDrift | null;
  steps: readonly WorkflowStepRecord[];
};

function classifyRecovery(input: RecoveryInput): WorkflowMonitorRecovery | null {
  if (input.runState === "blocked") {
    const stepId =
      input.activeStep?.stepId ?? findStepIdForManualRecoveryLease(input.steps);
    return {
      code: "manual_recovery_lease",
      message:
        "An outstanding manual-recovery-required lease is blocking this run. Inspect leases and clear recovery before allowing new claims.",
      stepId
    };
  }
  if (input.runState === "failed") {
    const failed = input.steps.find(
      (s) => s.state === "failed" && s.required
    );
    if (failed && isExternalSideEffectTailStepKind(failed.kind)) {
      return {
        code: "failed_external_side_effect_step",
        message:
          "A required external-side-effect tail step finalized in failed state after it may have already pushed a branch, merged a pull request, or written the tracker. Verify the remote, pull request, and tracker state, then reconcile via `momentum workflow run clear-recovery <run-id> --evidence-pointer <ref>` - do not blindly re-run the step, which could double-merge or re-write.",
        stepId: failed.stepId
      };
    }
    return {
      code: "failed_required_step",
      message:
        "A required step finalized in failed state. Inspect the executor log / artifact tree and decide whether to retry or mark for manual recovery.",
      stepId: failed?.stepId ?? null
    };
  }
  if (input.activeStep?.state === "running") {
    if (input.checkpointFresh || input.hasFreshDispatchLease) {
      if (input.monitorDrift?.drifted) {
        return {
          code: "monitor_drift_stale",
          message: "Step is running with fresh evidence, but the monitor advisory disagrees with the substrate state. The monitor snapshot may be stale.",
          stepId: input.activeStep.stepId
        };
      }
      return null;
    }
    const hasDispatchLeaseRecorded = input.leases.some(
      (l) => l.leaseKind !== "monitor"
    );
    return {
      code: hasDispatchLeaseRecorded
        ? "stale_running_step"
        : "ghost_active_no_lease",
      message: hasDispatchLeaseRecorded
        ? "Step is running but the dispatch lease is stale and no recent checkpoint has been observed. The managed child may have died silently."
        : "Step is running but no dispatch lease has ever been recorded and no recent checkpoint exists. The step may be a ghost: a managed child died before any durable progress was recorded.",
      stepId: input.activeStep.stepId
    };
  }
  if (input.runState === "running" && input.activeStep === null) {
    const orphan = input.leases.find(
      (l) => l.classification !== "released" && l.leaseKind !== "monitor"
    );
    if (orphan) {
      return {
        code: "stale_running_step",
        message:
          "All steps have finalized, but a non-monitor lease is still outstanding and is holding the run in running. Investigate the orphaned lease before clearing recovery.",
        stepId: null
      };
    }
  }
  if (!input.terminal && input.monitorDrift?.drifted) {
    return {
      code: "monitor_drift_stale",
      message: "Monitor advisory disagrees with the substrate state. No other recovery condition applies, but the monitor snapshot may be stale.",
      stepId: input.activeStep?.stepId ?? null
    };
  }
  return null;
}

function findStepIdForManualRecoveryLease(
  steps: readonly WorkflowStepRecord[]
): string | null {
  const running = steps.find((s) => s.state === "running");
  if (running) return running.stepId;
  const blocked = steps.find((s) => s.state === "blocked");
  if (blocked) return blocked.stepId;
  return null;
}

type NextActionInput = {
  runState: WorkflowRunState;
  activeStep: WorkflowMonitorActiveStep | null;
  recovery: WorkflowMonitorRecovery | null;
  checkpointFresh: boolean;
  hasFreshDispatchLease: boolean;
  steps: readonly WorkflowStepRecord[];
  leases: readonly WorkflowMonitorLeaseView[];
};

function decideNextAction(input: NextActionInput): WorkflowMonitorNextAction {
  if (input.runState === "blocked") {
    return {
      code: "clear_recovery",
      stepId: input.recovery?.stepId ?? input.activeStep?.stepId ?? null,
      leaseKind: null,
      detail:
        "Run is blocked. Clear the manual recovery once the underlying cause has been resolved."
    };
  }
  if (input.runState === "failed") {
    const failedStep =
      input.steps.find((s) => s.state === "failed" && s.required) ?? null;
    if (failedStep && isExternalSideEffectTailStepKind(failedStep.kind)) {
      return {
        code: "clear_recovery",
        stepId: failedStep.stepId,
        leaseKind: null,
        detail:
          "An external-side-effect tail step failed after it may have already merged the pull request or written the tracker. Verify the remote, pull request, and tracker state, then clear recovery to reconcile - do not re-run the step blindly."
      };
    }
    return {
      code: "rerun_failed_step",
      stepId: failedStep?.stepId ?? null,
      leaseKind: failedStep ? leaseKindForStep(failedStep) : null,
      detail:
        "A required step failed. Decide whether to retry the step or mark the run for manual recovery."
    };
  }
  if (input.runState === "succeeded" || input.runState === "canceled") {
    return {
      code: "no_action",
      stepId: null,
      leaseKind: null,
      detail:
        input.runState === "succeeded"
          ? "Run is terminally succeeded. No further action required."
          : "Run is canceled. No further action required."
    };
  }
  const active = input.activeStep;
  if (active === null) {
    if (input.runState === "running") {
      const orphan = input.leases.find(
        (l) => l.classification !== "released" && l.leaseKind !== "monitor"
      );
      if (orphan) {
        return {
          code: "investigate_stale",
          stepId: null,
          leaseKind: orphan.leaseKind,
          detail: `All steps have finalized but a ${orphan.leaseKind} lease held by ${orphan.holder} is still outstanding. Investigate the orphaned lease before clearing recovery.`
        };
      }
    }
    return {
      code: "await_approval",
      stepId: null,
      leaseKind: null,
      detail:
        "No steps recorded yet. Await plan import / approval to populate the run."
    };
  }
  if (active.state === "running") {
    if (input.recovery !== null && input.recovery.code !== "monitor_drift_stale") {
      return {
        code: "investigate_stale",
        stepId: active.stepId,
        leaseKind: leaseKindForStep(active),
        detail:
          input.recovery.code === "ghost_active_no_lease"
            ? "Running step has no dispatch lease and no recent checkpoint. Inspect the run directory and decide whether to recover or cancel."
            : "Running step's dispatch lease is stale and no recent checkpoint has been observed. Inspect the run directory before forcing progress."
      };
    }
    return {
      code: "resume_running",
      stepId: active.stepId,
      leaseKind: leaseKindForStep(active),
      detail: describeRunningStepResume(input)
    };
  }
  if (active.state === "approved") {
    return {
      code: "advance_to_step",
      stepId: active.stepId,
      leaseKind: leaseKindForStep(active),
      detail: `Approved step "${active.stepId}" is the next step to dispatch.`
    };
  }
  if (active.state === "blocked") {
    return {
      code: "clear_recovery",
      stepId: active.stepId,
      leaseKind: null,
      detail: `Step "${active.stepId}" is blocked. Clear the manual recovery once the underlying cause is resolved.`
    };
  }
  return {
    code: "await_approval",
    stepId: active.stepId,
    leaseKind: leaseKindForStep(active),
    detail: `Step "${active.stepId}" is pending approval before it can advance.`
  };
}

function leaseKindForStep(
  _step: { kind: WorkflowStepKind } | WorkflowStepRecord
): WorkflowLeaseKind {
  // Every coding-workflow step dispatches through the managed-step lease in
  // the M7 contract; monitor / dispatch leases live around the step boundary,
  // not on the step itself.
  return "managed-step";
}

function describeRunningStepResume(
  input: Pick<
    NextActionInput,
    "checkpointFresh" | "hasFreshDispatchLease" | "recovery"
  >
): string {
  if (input.recovery?.code === "monitor_drift_stale") {
    return "Step is running with fresh evidence, but monitor advisory disagrees with substrate state. Allow it to continue while flagging the drift.";
  }
  if (input.hasFreshDispatchLease && input.checkpointFresh) {
    return "Step is running with a fresh dispatch lease and recent checkpoint evidence. Allow it to continue.";
  }
  if (input.hasFreshDispatchLease) {
    return "Step is running with a fresh dispatch lease. Allow it to continue.";
  }
  if (input.checkpointFresh) {
    return "Step is running with recent checkpoint evidence but no fresh active dispatch lease. Allow the existing work to continue, but do not report the lease as fresh.";
  }
  return "Step is running with fresh evidence. Allow it to continue.";
}
