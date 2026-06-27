/**
 * Pure native progress-monitor digest reducer (NGX-511).
 *
 * CWFP's cron monitor gives Calvin progressive updates without burning a large
 * agent turn per heartbeat. This module is the Momentum-native equivalent: it
 * projects one durable {@link WorkflowMonitorEnvelope} tick into a concise
 * progress snapshot so an operator (or a cheap cron loop) can tell whether a
 * native coding-workflow run is **advancing**, **idle**, **awaiting approval**,
 * **blocked / awaiting manual recovery**, or **terminal** — and, critically,
 * whether *anything meaningful changed since the last emitted tick* so repeated
 * unchanged heartbeats are suppressed instead of spamming the operator.
 *
 * Design constraints pinned by NGX-511 and SPEC.md "Workflow Safety":
 *
 * - **Durable state is the source of truth.** The reducer derives everything
 *   from the envelope, which is itself built from durable rows; it never reads
 *   on-disk monitor prose or CWFP ledger assumptions.
 * - **Cheap and deterministic.** No LLM call, no clock, no I/O. The same
 *   meaningful state always yields the same digest, so a cron tick is a pure
 *   string compare.
 * - **Unchanged ticks suppress.** The {@link WorkflowMonitorProgressTick.digest}
 *   intentionally excludes volatile fields (`generatedAt`, lease heartbeat /
 *   expiry timestamps, evidence ordering) so two ticks over identical
 *   operator-facing state compare equal and `emit` is `false`.
 * - **Terminal cleanup is explicit.** A terminally succeeded / canceled run
 *   reports `cleanup: "release"` so the caller knows to release the monitor
 *   lease and stop ticking; a failed run is `blocked` (needs recovery), not a
 *   clean terminal, so it reports `cleanup: "none"`.
 *
 * This module owns only the pure classification + digest projection. The
 * `workflow run monitor` CLI passes the durable emitted-digest baseline into
 * this reducer and, when `--advance` is used on a Momentum-native coding run,
 * persists the returned digest plus observation timestamps into advisory
 * columns outside this module.
 */

import crypto from "node:crypto";

import type {
  WorkflowMonitorDisposition,
  WorkflowMonitorEnvelope,
  WorkflowMonitorReportReason
} from "./monitor-envelope.js";

/**
 * Coarse progress phase for a native monitor tick. The four phases named in the
 * NGX-511 acceptance criteria — advancing, idle, blocked/manual-recovery, and
 * terminal — are all distinguishable here; `awaiting_approval` is split out of
 * the broad waiting family because a planned approval gate needs operator eyes
 * and is materially different from a run that is merely idle.
 */
export const WORKFLOW_MONITOR_PROGRESS_PHASES = [
  "advancing",
  "idle",
  "awaiting_approval",
  "blocked",
  "terminal"
] as const;
export type WorkflowMonitorProgressPhase =
  (typeof WORKFLOW_MONITOR_PROGRESS_PHASES)[number];

/**
 * Explicit terminal cleanup signal. `release` means the run reached a clean
 * terminal outcome (succeeded / canceled) and the caller should release the
 * monitor lease and stop ticking; `none` means keep monitoring (still running,
 * waiting, or blocked on recovery).
 */
export const WORKFLOW_MONITOR_CLEANUP_ACTIONS = ["none", "release"] as const;
export type WorkflowMonitorCleanupAction =
  (typeof WORKFLOW_MONITOR_CLEANUP_ACTIONS)[number];

export type WorkflowMonitorProgressTick = {
  runId: string;
  /**
   * Stable `sha256:`-prefixed digest of the meaningful operator-facing state.
   * Equal digests across ticks mean nothing actionable changed.
   */
  digest: string;
  phase: WorkflowMonitorProgressPhase;
  /** `true` when the digest differs from `priorDigest` (or none was supplied). */
  changed: boolean;
  /** Whether this tick should be surfaced. Currently equal to `changed`. */
  emit: boolean;
  /** Whether the run is in a clean terminal phase (succeeded / canceled). */
  terminal: boolean;
  cleanup: WorkflowMonitorCleanupAction;
  /** The active step id, or `null` when no step is in focus. */
  currentStep: string | null;
  /** Concise, deterministic description of the most recent durable event. */
  lastEvent: string;
  /** The monitor next-action code (e.g. `resume_running`, `clear_recovery`). */
  nextAction: string;
  /** Blocker / manual-recovery reason when blocked, else `null`. */
  blockerReason: string | null;
  disposition: WorkflowMonitorDisposition;
  reportReason: WorkflowMonitorReportReason;
};

export type DeriveWorkflowMonitorProgressOptions = {
  /**
   * The digest of the last emitted tick for this run (typically the durable
   * `monitor_last_emitted_digest` advisory). When omitted / null, this is
   * treated as a first observation and always emits.
   */
  priorDigest?: string | null;
};

export function deriveWorkflowMonitorProgress(
  envelope: WorkflowMonitorEnvelope,
  options: DeriveWorkflowMonitorProgressOptions = {}
): WorkflowMonitorProgressTick {
  const phase = derivePhase(envelope);
  const digest = computeDigest(envelope, phase);
  const priorDigest = options.priorDigest ?? null;
  const changed = priorDigest === null || priorDigest !== digest;
  const terminal = phase === "terminal";

  return {
    runId: envelope.runId,
    digest,
    phase,
    changed,
    emit: changed,
    terminal,
    cleanup: terminal ? "release" : "none",
    currentStep: envelope.activeStep?.stepId ?? null,
    lastEvent: deriveLastEvent(envelope),
    nextAction: envelope.nextAction.code,
    blockerReason: deriveBlockerReason(envelope, phase),
    disposition: envelope.disposition,
    reportReason: envelope.reportReason
  };
}

/**
 * Phase precedence: clean terminal outcomes first, then recovery, then the
 * approval gate, then forward progress, then idle. The clean-terminal check is
 * deliberately narrow: failed terminal runs still surface as `blocked`, while
 * a run that was operator-reconciled to succeeded/no_action must not inherit a
 * stale manual-recovery round or sticky recovery flag as its progress phase.
 */
function derivePhase(
  envelope: WorkflowMonitorEnvelope
): WorkflowMonitorProgressPhase {
  if (
    envelope.terminal &&
    envelope.recovery === null &&
    envelope.nextAction.code === "no_action"
  ) {
    return "terminal";
  }
  if (envelope.disposition === "recover") return "blocked";
  if (envelope.terminal) return "terminal";
  if (envelope.reportReason === "awaiting_approval") return "awaiting_approval";
  if (
    envelope.reportReason === "in_progress" ||
    envelope.reportReason === "monitor_drift"
  ) {
    // monitor_drift means the substrate is still progressing on fresh evidence
    // while the advisory snapshot lags; treat the run as advancing.
    return "advancing";
  }
  return "idle";
}

function deriveBlockerReason(
  envelope: WorkflowMonitorEnvelope,
  phase: WorkflowMonitorProgressPhase
): string | null {
  if (phase !== "blocked") return null;
  if (envelope.recovery !== null) return envelope.recovery.message;
  if (envelope.needsManualRecovery) {
    if (envelope.manualRecoveryReason !== null) {
      return envelope.manualRecoveryReason;
    }
    return "Run is flagged for manual recovery.";
  }
  if (envelope.blocked) return "Run is blocked.";
  return "Run requires operator recovery.";
}

function deriveLastEvent(envelope: WorkflowMonitorEnvelope): string {
  const checkpoint = envelope.lastCheckpoint;
  if (checkpoint !== null) {
    return `checkpoint:${checkpoint.source}:${checkpoint.stepId}`;
  }
  if (envelope.activeStep !== null) {
    return `step:${envelope.activeStep.stepId}:${envelope.activeStep.state}`;
  }
  return `run:${envelope.runState}`;
}

/**
 * The meaningful-state projection. Deliberately excludes `generatedAt`, the
 * lease views (heartbeat / expiry churn every tick), the evidence list, and
 * resolved gates. Only the structural signals that an operator would act on are
 * folded into the digest, so steady-state heartbeats compare equal.
 */
function computeDigest(
  envelope: WorkflowMonitorEnvelope,
  phase: WorkflowMonitorProgressPhase
): string {
  const projection = {
    phase,
    runState: envelope.runState,
    stepState: envelope.stepState,
    terminal: envelope.terminal,
    blocked: envelope.blocked,
    needsManualRecovery: envelope.needsManualRecovery,
    manualRecoveryReason: envelope.manualRecoveryReason,
    disposition: envelope.disposition,
    reportReason: envelope.reportReason,
    activeStepId: envelope.activeStep?.stepId ?? null,
    activeStepState: envelope.activeStep?.state ?? null,
    nextActionCode: envelope.nextAction.code,
    nextActionStepId: envelope.nextAction.stepId,
    recoveryCode: envelope.recovery?.code ?? null,
    monitorDriftReason: envelope.monitorDrift?.reason ?? null,
    gatesOpen: envelope.counts.gatesOpen,
    openGates: envelope.gates
      .filter((gate) => gate.resolvedAt === null)
      .map((gate) => ({
        gateId: gate.gateId,
        stepRunId: gate.stepRunId,
        invocationId: gate.invocationId,
        roundId: gate.roundId,
        targetScope: gate.targetScope,
        gateType: gate.gateType,
        reason: gate.reason,
        evidence: gate.evidence,
        allowedActions: [...gate.allowedActions],
        recommendedAction: gate.recommendedAction,
        policyEnvelope: [...gate.policyEnvelope]
      }))
      .sort((a, b) => (a.gateId < b.gateId ? -1 : a.gateId > b.gateId ? 1 : 0)),
    stepsByState: envelope.counts.stepsByState,
    lastCheckpointStepId: envelope.lastCheckpoint?.stepId ?? null,
    lastCheckpointSource: envelope.lastCheckpoint?.source ?? null,
    lastCheckpointDigest: envelope.lastCheckpoint?.digest ?? null
  };
  const canonical = canonicalStringify(projection);
  const hex = crypto.createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Deterministic JSON with object keys sorted recursively, so digest stability
 * does not depend on property insertion order anywhere upstream.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`);
  return `{${entries.join(",")}}`;
}
