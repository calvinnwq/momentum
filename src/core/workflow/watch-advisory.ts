import type { WorkflowMonitorEnvelope } from "./monitor-envelope.js";
import type {
  WorkflowMonitorProgressTick
} from "./monitor-progress.js";
import type { WorkflowStepKind } from "./run-reducer.js";

export const WORKFLOW_WATCH_REASONS = [
  "terminal_succeeded",
  "terminal_canceled",
  "recovery_required",
  "monitor_drift",
  "awaiting_approval",
  "in_progress",
  "idle",
  "quiet_heartbeat",
  "stuck_risk"
] as const;
export type WorkflowWatchReason = (typeof WORKFLOW_WATCH_REASONS)[number];

export const WORKFLOW_WATCH_DEFAULT_QUIET_THRESHOLDS_SECONDS = {
  implementation: 15 * 60,
  postflight: 10 * 60,
  "no-mistakes": 15 * 60,
  "merge-cleanup": 5 * 60,
  "linear-refresh": 5 * 60,
  approval: 30 * 60,
  recovery: 60 * 60,
  idle: 15 * 60
} as const;

export type WorkflowWatchQuietThresholdsSeconds =
  typeof WORKFLOW_WATCH_DEFAULT_QUIET_THRESHOLDS_SECONDS;

export type WorkflowWatchAdvisory = {
  emit: boolean;
  reason: WorkflowWatchReason;
  quietForSeconds: number;
  quietThresholdSeconds: number;
  stuckRisk: "low" | "medium" | "high";
  activeStepId: string | null;
  inspectionCommand: string | null;
};

export type DeriveWorkflowWatchAdvisoryOptions = {
  now?: number;
  lastEmittedAt?: number | null;
  thresholds?: WorkflowWatchQuietThresholdsSeconds;
};

export function deriveWorkflowWatchAdvisory(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick,
  options: DeriveWorkflowWatchAdvisoryOptions = {}
): WorkflowWatchAdvisory {
  const now = options.now ?? envelope.generatedAt;
  const thresholds =
    options.thresholds ?? WORKFLOW_WATCH_DEFAULT_QUIET_THRESHOLDS_SECONDS;
  const quietThresholdSeconds = selectQuietThresholdSeconds(
    envelope,
    progress,
    thresholds
  );
  const quietForSeconds = progress.emit
    ? 0
    : secondsSince(options.lastEmittedAt ?? envelope.monitorLastEmittedAt, now);
  const baseStuckRisk = classifyBaseStuckRisk(envelope, progress);

  if (progress.emit) {
    return {
      emit: true,
      reason: progress.reportReason,
      quietForSeconds: 0,
      quietThresholdSeconds,
      stuckRisk: baseStuckRisk,
      activeStepId: progress.currentStep,
      inspectionCommand: null
    };
  }

  const thresholdReached =
    quietThresholdSeconds > 0 && quietForSeconds >= quietThresholdSeconds;
  if (!thresholdReached) {
    return {
      emit: false,
      reason: progress.reportReason,
      quietForSeconds,
      quietThresholdSeconds,
      stuckRisk: baseStuckRisk,
      activeStepId: progress.currentStep,
      inspectionCommand: null
    };
  }

  if (isActiveExecution(envelope, progress)) {
    return {
      emit: true,
      reason: "stuck_risk",
      quietForSeconds,
      quietThresholdSeconds,
      stuckRisk: raiseStuckRisk(baseStuckRisk),
      activeStepId: progress.currentStep,
      inspectionCommand: buildInspectionCommand(envelope.runId)
    };
  }

  return {
    emit: true,
    reason: "quiet_heartbeat",
    quietForSeconds,
    quietThresholdSeconds,
    stuckRisk: baseStuckRisk,
    activeStepId: progress.currentStep,
    inspectionCommand: null
  };
}

function selectQuietThresholdSeconds(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick,
  thresholds: WorkflowWatchQuietThresholdsSeconds
): number {
  if (progress.cleanup === "release") return 0;
  if (progress.phase === "blocked" || hasHardRecovery(envelope)) {
    return thresholds.recovery;
  }
  if (progress.phase === "awaiting_approval") return thresholds.approval;
  if (progress.phase === "idle") return thresholds.idle;

  const activeKind = envelope.activeStep?.kind;
  if (activeKind !== undefined && isThresholdStepKind(activeKind)) {
    return thresholds[activeKind];
  }
  return thresholds.implementation;
}

function secondsSince(then: number | null, now: number): number {
  if (then === null) return 0;
  return Math.max(0, Math.floor((now - then) / 1000));
}

function isActiveExecution(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick
): boolean {
  return (
    progress.phase === "advancing" &&
    progress.currentStep !== null &&
    envelope.nextAction.code === "resume_running"
  );
}

function classifyBaseStuckRisk(
  envelope: WorkflowMonitorEnvelope,
  progress: WorkflowMonitorProgressTick
): WorkflowWatchAdvisory["stuckRisk"] {
  if (
    envelope.recovery?.code === "monitor_drift_stale" &&
    progress.phase === "advancing"
  ) {
    return "low";
  }
  if (progress.phase === "blocked" || envelope.recovery !== null) return "high";
  if (progress.phase === "idle" || progress.phase === "awaiting_approval") {
    return "medium";
  }
  return "low";
}

function hasHardRecovery(envelope: WorkflowMonitorEnvelope): boolean {
  if (envelope.recovery === null) return false;
  return (
    envelope.recovery.code !== "monitor_drift_stale" ||
    envelope.needsManualRecovery
  );
}

function raiseStuckRisk(
  stuckRisk: WorkflowWatchAdvisory["stuckRisk"]
): WorkflowWatchAdvisory["stuckRisk"] {
  return stuckRisk === "low" ? "medium" : stuckRisk;
}

function buildInspectionCommand(runId: string): string {
  return `momentum workflow run monitor ${shellQuote(runId)} --advance --json`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isThresholdStepKind(kind: WorkflowStepKind): kind is Extract<
  WorkflowStepKind,
  | "implementation"
  | "postflight"
  | "no-mistakes"
  | "merge-cleanup"
  | "linear-refresh"
> {
  return (
    kind === "implementation" ||
    kind === "postflight" ||
    kind === "no-mistakes" ||
    kind === "merge-cleanup" ||
    kind === "linear-refresh"
  );
}
