/**
 * Read-only machine envelope for `workflow run monitor`.
 *
 * The OpenClaw `coding-workflow-pipeline` skill's `monitor_runner.py` consumes
 * one stable JSON shape per monitor tick instead of parsing prose or scraping
 * `.agent-workflows/<runId>/` artifacts. This module composes the durable
 * substrate detail loader ({@link loadWorkflowRunDetail}) with the pure M7
 * monitor reducer ({@link deriveWorkflowMonitorState}) and a small
 * reportability classifier so the runner can decide whether to **report**,
 * **wait**, or ask an operator to **recover** from a single envelope. The same
 * envelope also carries the durable emitted-digest advisory used by the native
 * progress reducer to suppress repeated unchanged ticks.
 *
 * The envelope is derived entirely from durable rows — never from the on-disk
 * `monitor.json` prose. It never mutates run / step / approval / lease state,
 * never schedules cron, never delivers to Discord, and never spawns a managed
 * child. Monitor recovery / next-action taxonomies are reused verbatim from the
 * M7 reducer; the `recovery` field stays monitor-derived. The durable
 * `needsManualRecovery` flag may also be set by M9 live dispatch / finalization
 * recovery, which can independently drive `disposition: "recover"` while
 * `recovery` remains null and the stored reason / `recovery.md` carries the
 * non-monitor classification. The M10 scheduler lane also sets the flag for
 * stale workflow-lease recovery, but stale `manual-recovery-required` leases
 * remain outstanding and can still be re-derived here as
 * `manual_recovery_lease`.
 */
import type { MomentumDb } from "../../../adapters/db.js";
import {
  type WorkflowMonitorActiveStep,
  type WorkflowMonitorCheckpoint,
  type WorkflowMonitorDrift,
  type WorkflowMonitorLeaseView,
  type WorkflowMonitorNextAction,
  type WorkflowMonitorRecovery,
  type WorkflowMonitorState
} from "./state.js";
import {
  loadWorkflowRunDetail,
  type LoadWorkflowRunDetailOptions,
  type WorkflowEvidenceLink,
  type WorkflowRunDetail,
  type WorkflowRunDetailGate
} from "../run/status.js";
import type {
  WorkflowRunState,
  WorkflowStepState
} from "../run/reducer.js";

export const WORKFLOW_MONITOR_SCHEMA_VERSION = 1;

/**
 * The three decisions the monitor runner makes from one envelope:
 *   - `wait`    — nothing actionable; the run is progressing or idle.
 *   - `report`  — surface the run to the operator (terminal outcome, awaiting
 *                 approval, or monitor drift) but no recovery action is needed.
 *   - `recover` — an operator must intervene (blocked, durable manual-recovery
 *                 flag, or a hard monitor recovery classification).
 */
export const WORKFLOW_MONITOR_DISPOSITIONS = [
  "wait",
  "report",
  "recover"
] as const;
export type WorkflowMonitorDisposition =
  (typeof WORKFLOW_MONITOR_DISPOSITIONS)[number];

export const WORKFLOW_MONITOR_REPORT_REASONS = [
  "terminal_succeeded",
  "terminal_canceled",
  "recovery_required",
  "monitor_drift",
  "awaiting_approval",
  "in_progress",
  "idle"
] as const;
export type WorkflowMonitorReportReason =
  (typeof WORKFLOW_MONITOR_REPORT_REASONS)[number];

export type WorkflowMonitorReport = {
  disposition: WorkflowMonitorDisposition;
  reportable: boolean;
  reportReason: WorkflowMonitorReportReason;
};

export type WorkflowMonitorEnvelopeCounts = {
  steps: number;
  stepsByState: Record<WorkflowStepState, number>;
  approvals: number;
  leases: number;
  /** Total durable workflow / step / executor gates recorded for the run. */
  gates: number;
  /** Gates still awaiting a decision (`resolvedAt === null`). */
  gatesOpen: number;
};

export type WorkflowMonitorEnvelopeGate = WorkflowRunDetailGate;

export type WorkflowMonitorEnvelope = {
  schemaVersion: number;
  generatedAt: number;
  runId: string;
  source: string;
  runState: WorkflowRunState;
  stepState: WorkflowStepState | null;
  terminal: boolean;
  blocked: boolean;
  needsManualRecovery: boolean;
  manualRecoveryReason: string | null;
  disposition: WorkflowMonitorDisposition;
  reportable: boolean;
  reportReason: WorkflowMonitorReportReason;
  activeStep: WorkflowMonitorActiveStep | null;
  leases: readonly WorkflowMonitorLeaseView[];
  lastCheckpoint: WorkflowMonitorCheckpoint | null;
  monitorDrift: WorkflowMonitorDrift | null;
  nextAction: WorkflowMonitorNextAction;
  recovery: WorkflowMonitorRecovery | null;
  evidence: readonly WorkflowEvidenceLink[];
  /**
   * Durable workflow / step / executor gates for the run,
   * oldest first, open and resolved alike. Surfacing them in the monitor
   * envelope makes the run's approval-required / operator-decision pauses
   * explicit and inspectable to the monitor runner alongside the derived
   * disposition, mirroring `workflow status` / `workflow handoff`.
   */
  gates: readonly WorkflowMonitorEnvelopeGate[];
  counts: WorkflowMonitorEnvelopeCounts;
  /**
   * The digest of the last *emitted* native progress tick for this run, read
   * verbatim from the durable `monitor_last_emitted_digest` advisory column
   *. It is the suppression baseline the {@link deriveWorkflowMonitorProgress}
   * reducer compares against: an equal digest means the operator-facing state
   * has not changed since the last surfaced tick. `null` means no tick has been
   * emitted yet (a first observation always emits).
   */
  monitorLastEmittedDigest: string | null;
  /**
   * Advisory timestamp for the last observed monitor/watch tick. This is not a
   * lifecycle state transition; it lets bounded pollers measure quiet duration
   * across separate `--once` invocations without mutating run / step state.
   */
  monitorLastSeenAt: number | null;
  /**
   * Advisory timestamp for the last surfaced monitor/watch tick. Quiet
   * heartbeat and stuck-risk throttling measure elapsed silence from this value.
   */
  monitorLastEmittedAt: number | null;
};

export type BuildWorkflowMonitorEnvelopeOptions = {
  generatedAt?: number;
};

export type LoadWorkflowMonitorEnvelopeOptions =
  LoadWorkflowRunDetailOptions & BuildWorkflowMonitorEnvelopeOptions;

/**
 * Classify whether a monitor tick should report, wait, or recover. Precedence
 * keeps operator-recovery first so a healthy-looking next action never masks a
 * blocking condition, then terminal outcomes, then the soft "needs eyes" cases.
 */
export function classifyWorkflowMonitorReport(
  monitor: WorkflowMonitorState,
  needsManualRecovery: boolean
): WorkflowMonitorReport {
  // Clean terminal substrate evidence wins over stale durable recovery flags.
  // `clear-recovery` is not actionable once the reducer has no recovery object
  // and the durable next action is already `no_action`.
  if (
    monitor.terminal &&
    monitor.recovery === null &&
    monitor.nextAction.code === "no_action"
  ) {
    return monitor.runState === "canceled"
      ? reportOf("report", "terminal_canceled")
      : reportOf("report", "terminal_succeeded");
  }

  // 1. Hard operator-recovery conditions take precedence over everything else.
  if (needsManualRecovery || monitor.blocked) {
    return reportOf("recover", "recovery_required");
  }
  if (monitor.recovery !== null) {
    // Monitor drift is soft: the substrate keeps progressing while the advisory
    // snapshot is stale, so surface it as a report rather than a recovery ask.
    if (monitor.recovery.code === "monitor_drift_stale") {
      return reportOf("report", "monitor_drift");
    }
    return reportOf("recover", "recovery_required");
  }
  // 2. Terminal, healthy runs are reportable outcomes (failed runs always carry
  //    a recovery classification and are handled above).
  if (monitor.terminal) {
    return monitor.runState === "canceled"
      ? reportOf("report", "terminal_canceled")
      : reportOf("report", "terminal_succeeded");
  }
  // 3. A concrete step waiting on an approval boundary needs operator eyes.
  if (
    monitor.nextAction.code === "await_approval" &&
    monitor.activeStep !== null
  ) {
    return reportOf("report", "awaiting_approval");
  }
  // 4. Running with fresh evidence / an approved step ready to dispatch: wait.
  if (
    monitor.nextAction.code === "resume_running" ||
    monitor.nextAction.code === "advance_to_step"
  ) {
    return reportOf("wait", "in_progress");
  }
  // 5. Nothing actionable yet (no steps / awaiting plan import): idle no-op.
  return reportOf("wait", "idle");
}

function reportOf(
  disposition: WorkflowMonitorDisposition,
  reportReason: WorkflowMonitorReportReason
): WorkflowMonitorReport {
  return { disposition, reportable: disposition !== "wait", reportReason };
}

export function buildWorkflowMonitorEnvelope(
  detail: WorkflowRunDetail,
  options: BuildWorkflowMonitorEnvelopeOptions = {}
): WorkflowMonitorEnvelope {
  const monitor = detail.monitor;
  const report = classifyWorkflowMonitorReport(
    monitor,
    detail.run.needsManualRecovery
  );
  return {
    schemaVersion: WORKFLOW_MONITOR_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? Date.now(),
    runId: monitor.runId,
    source: detail.run.source,
    runState: monitor.runState,
    stepState: monitor.activeStep?.state ?? null,
    terminal: monitor.terminal,
    blocked: monitor.blocked,
    needsManualRecovery: detail.run.needsManualRecovery,
    manualRecoveryReason: detail.run.manualRecoveryReason,
    disposition: report.disposition,
    reportable: report.reportable,
    reportReason: report.reportReason,
    activeStep: monitor.activeStep,
    leases: monitor.leases,
    lastCheckpoint: monitor.lastCheckpoint,
    monitorDrift: monitor.monitorDrift,
    nextAction: monitor.nextAction,
    recovery: monitor.recovery,
    evidence: detail.evidence,
    gates: detail.gates,
    counts: countsFromDetail(detail),
    monitorLastEmittedDigest: detail.run.monitorLastEmittedDigest,
    monitorLastSeenAt: detail.run.monitorLastSeenAt,
    monitorLastEmittedAt: detail.run.monitorLastEmittedAt
  };
}

export function loadWorkflowMonitorEnvelope(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowMonitorEnvelopeOptions = {}
): WorkflowMonitorEnvelope | null {
  const detail = loadWorkflowRunDetail(db, runId, options);
  if (detail === null) return null;
  return buildWorkflowMonitorEnvelope(detail, options);
}

function countsFromDetail(
  detail: WorkflowRunDetail
): WorkflowMonitorEnvelopeCounts {
  const stepsByState: Record<WorkflowStepState, number> = {
    pending: 0,
    approved: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    canceled: 0
  };
  for (const step of detail.steps) {
    stepsByState[step.state] += 1;
  }
  return {
    steps: detail.steps.length,
    stepsByState,
    approvals: detail.approvals.length,
    leases: detail.leases.length,
    gates: detail.gates.length,
    gatesOpen: detail.gates.filter((gate) => gate.resolvedAt === null).length
  };
}
