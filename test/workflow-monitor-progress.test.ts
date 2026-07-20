import { describe, expect, it } from "vitest";

import {
  deriveWorkflowMonitorProgress,
  WORKFLOW_MONITOR_PROGRESS_PHASES,
  type WorkflowMonitorProgressPhase
} from "../src/core/workflow/monitor/progress.js";
import type {
  WorkflowMonitorEnvelope,
  WorkflowMonitorEnvelopeCounts
} from "../src/core/workflow/monitor/envelope.js";
import { getWorkflowActionAuthorityPolicy } from "../src/core/workflow/monitor/action-authority.js";

/**
 * NGX-511: pure native progress-monitor digest reducer.
 *
 * The reducer projects a single `workflow run monitor` envelope into a concise
 * progress tick: a stable digest of the meaningful operator-facing state, a
 * coarse phase, a change/emit decision against the prior emitted digest, and an
 * explicit terminal cleanup signal. It is pure, deterministic, and never calls
 * an LLM or touches durable state.
 */

function makeCounts(
  overrides: Partial<WorkflowMonitorEnvelopeCounts> = {}
): WorkflowMonitorEnvelopeCounts {
  return {
    steps: 1,
    stepsByState: {
      pending: 0,
      approved: 0,
      running: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      blocked: 0,
      canceled: 0
    },
    approvals: 0,
    leases: 0,
    gates: 0,
    gatesOpen: 0,
    ...overrides
  };
}

function makeEnvelope(
  overrides: Partial<WorkflowMonitorEnvelope> = {}
): WorkflowMonitorEnvelope {
  return {
    schemaVersion: 1,
    generatedAt: 1_730_000_000_000,
    runId: "cwfp-run",
    source: "momentum-native-coding",
    runState: "running",
    stepState: "running",
    terminal: false,
    blocked: false,
    needsManualRecovery: false,
    manualRecoveryReason: null,
    disposition: "wait",
    reportable: false,
    reportReason: "in_progress",
    activeStep: {
      stepId: "implementation",
      kind: "implementation",
      state: "running",
      order: 1,
      required: true
    },
    leases: [],
    lastCheckpoint: null,
    monitorDrift: null,
    nextAction: {
      code: "resume_running",
      stepId: "implementation",
      leaseKind: "managed-step",
      detail: "Step is running with fresh evidence. Allow it to continue."
    },
    recovery: null,
    evidence: [],
    gates: [],
    counts: makeCounts(),
    monitorLastEmittedDigest: null,
    monitorLastSeenAt: null,
    monitorLastEmittedAt: null,
    ...overrides
  };
}

describe("deriveWorkflowMonitorProgress (NGX-511)", () => {
  it("emits on first observation when no prior digest is supplied", () => {
    const tick = deriveWorkflowMonitorProgress(makeEnvelope());
    expect(tick.runId).toBe("cwfp-run");
    expect(tick.changed).toBe(true);
    expect(tick.emit).toBe(true);
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("advancing");
    expect(tick.digest.startsWith("sha256:")).toBe(true);
  });

  it("suppresses an unchanged repeat tick against the prior digest", () => {
    const env = makeEnvelope();
    const first = deriveWorkflowMonitorProgress(env);
    const second = deriveWorkflowMonitorProgress(env, {
      priorDigest: first.digest
    });
    expect(second.digest).toBe(first.digest);
    expect(second.changed).toBe(false);
    expect(second.emit).toBe(false);
  });

  it("emits when the open gate identity changes without changing the open count", () => {
    const first = deriveWorkflowMonitorProgress(
      makeEnvelope({
        gates: [
          {
            gateId: "gate-approval",
            workflowRunId: "cwfp-run",
            stepRunId: "implementation",
            attemptId: null,
            roundId: null,
            targetScope: "step",
            gateType: "approval_required",
            reason: "Review the implementation.",
            evidence: "goals/cwfp-run/gates/gate-approval.json",
            allowedActions: ["approve", "reject"],
            recommendedAction: "approve",
            recommendedActionPolicy: getWorkflowActionAuthorityPolicy(
              "approval_decision"
            ),
            policyEnvelope: ["approve"],
            resolvedAt: null,
            resolvedBy: null,
            resolutionMode: null,
            chosenAction: null,
            resolution: null
          }
        ],
        counts: makeCounts({ gates: 1, gatesOpen: 1 })
      })
    );
    const second = deriveWorkflowMonitorProgress(
      makeEnvelope({
        gates: [
          {
            gateId: "gate-recovery",
            workflowRunId: "cwfp-run",
            stepRunId: "implementation",
            attemptId: null,
            roundId: null,
            targetScope: "step",
            gateType: "manual_recovery_required",
            reason: "Resolve the failed verifier.",
            evidence: "goals/cwfp-run/gates/gate-recovery.json",
            allowedActions: ["retry", "skip"],
            recommendedAction: "retry",
            recommendedActionPolicy:
              getWorkflowActionAuthorityPolicy("clear_recovery"),
            policyEnvelope: ["retry"],
            resolvedAt: null,
            resolvedBy: null,
            resolutionMode: null,
            chosenAction: null,
            resolution: null
          }
        ],
        counts: makeCounts({ gates: 1, gatesOpen: 1 })
      }),
      { priorDigest: first.digest }
    );
    expect(second.digest).not.toBe(first.digest);
    expect(second.changed).toBe(true);
    expect(second.emit).toBe(true);
  });

  it("excludes volatile timestamps and lease heartbeats from the digest", () => {
    const lease = {
      leaseKind: "managed-step" as const,
      holder: "holder:cwfp-run",
      classification: "fresh" as const,
      expiresAt: 1_000,
      heartbeatAt: 100,
      releasedAt: null
    };
    const env1 = makeEnvelope({
      generatedAt: 1,
      leases: [lease],
      counts: makeCounts({ leases: 1 })
    });
    const env2 = makeEnvelope({
      generatedAt: 999_999,
      leases: [{ ...lease, expiresAt: 9_999_999, heartbeatAt: 9_000 }],
      counts: makeCounts({ leases: 1 })
    });
    const first = deriveWorkflowMonitorProgress(env1);
    const second = deriveWorkflowMonitorProgress(env2, {
      priorDigest: first.digest
    });
    expect(second.digest).toBe(first.digest);
    expect(second.emit).toBe(false);
  });

  it("emits when the active step advances to the next step", () => {
    const before = makeEnvelope();
    const after = makeEnvelope({
      activeStep: {
        stepId: "no-mistakes",
        kind: "no-mistakes",
        state: "approved",
        order: 2,
        required: true
      },
      stepState: "approved",
      nextAction: {
        code: "advance_to_step",
        stepId: "no-mistakes",
        leaseKind: "managed-step",
        detail: 'Approved step "no-mistakes" is the next step to dispatch.'
      },
      counts: makeCounts({
        steps: 2,
        stepsByState: {
          pending: 0,
          approved: 1,
          running: 0,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          blocked: 0,
          canceled: 0
        }
      })
    });
    const firstTick = deriveWorkflowMonitorProgress(before);
    const nextTick = deriveWorkflowMonitorProgress(after, {
      priorDigest: firstTick.digest
    });
    expect(nextTick.digest).not.toBe(firstTick.digest);
    expect(nextTick.changed).toBe(true);
    expect(nextTick.emit).toBe(true);
  });

  it("classifies a healthy running step as advancing", () => {
    const tick = deriveWorkflowMonitorProgress(makeEnvelope());
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("advancing");
    expect(tick.currentStep).toBe("implementation");
    expect(tick.nextAction).toBe("resume_running");
    expect(tick.blockerReason).toBeNull();
    expect(tick.cleanup).toBe("none");
    expect(tick.terminal).toBe(false);
  });

  it("classifies a run with no steps yet as idle", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        reportReason: "idle",
        activeStep: null,
        stepState: null,
        nextAction: {
          code: "await_approval",
          stepId: null,
          leaseKind: null,
          detail: "No steps recorded yet. Await plan import / approval."
        },
        counts: makeCounts({
          steps: 0,
          stepsByState: {
            pending: 0,
            approved: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            blocked: 0,
            canceled: 0
          }
        })
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("idle");
    expect(tick.currentStep).toBeNull();
    expect(tick.cleanup).toBe("none");
  });

  it("classifies an approval-gated step as awaiting_approval", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        disposition: "report",
        reportable: true,
        reportReason: "awaiting_approval",
        activeStep: {
          stepId: "no-mistakes",
          kind: "no-mistakes",
          state: "pending",
          order: 2,
          required: true
        },
        stepState: "pending",
        nextAction: {
          code: "await_approval",
          stepId: "no-mistakes",
          leaseKind: "managed-step",
          detail: 'Step "no-mistakes" is pending approval before it can advance.'
        }
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("awaiting_approval");
    expect(tick.currentStep).toBe("no-mistakes");
    expect(tick.cleanup).toBe("none");
  });

  it("classifies a failed required step as blocked with a blocker reason and no cleanup", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        runState: "failed",
        terminal: true,
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required",
        activeStep: {
          stepId: "no-mistakes",
          kind: "no-mistakes",
          state: "failed",
          order: 2,
          required: true
        },
        stepState: "failed",
        nextAction: {
          code: "rerun_failed_step",
          stepId: "no-mistakes",
          leaseKind: "managed-step",
          detail: "A required step failed. Decide whether to retry."
        },
        recovery: {
          code: "failed_required_step",
          message: "A required step finalized in failed state.",
          stepId: "no-mistakes"
        },
        counts: makeCounts({
          steps: 2,
          stepsByState: {
            pending: 0,
            approved: 0,
            running: 0,
            succeeded: 1,
            failed: 1,
            skipped: 0,
            blocked: 0,
            canceled: 0
          }
        })
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("blocked");
    expect(tick.blockerReason).toBe(
      "A required step finalized in failed state."
    );
    // Failed needs operator recovery, not terminal cleanup.
    expect(tick.cleanup).toBe("none");
  });

  it("classifies a manual-recovery flagged run as blocked", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        blocked: true,
        runState: "blocked",
        needsManualRecovery: true,
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required",
        nextAction: {
          code: "clear_recovery",
          stepId: "implementation",
          leaseKind: null,
          detail: "Run is blocked. Clear the manual recovery once resolved."
        },
        recovery: {
          code: "manual_recovery_lease",
          message: "An outstanding manual-recovery-required lease is blocking.",
          stepId: "implementation"
        }
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("blocked");
    expect(tick.blockerReason).toBe(
      "An outstanding manual-recovery-required lease is blocking."
    );
  });

  it("uses durable manual-recovery reason when no monitor recovery exists", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        runState: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "head mismatch requires operator recovery",
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required",
        recovery: null,
        nextAction: {
          code: "clear_recovery",
          stepId: "implementation",
          leaseKind: null,
          detail: "Run is blocked. Clear the manual recovery once resolved."
        }
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("blocked");
    expect(tick.blockerReason).toBe(
      "head mismatch requires operator recovery"
    );
  });

  it("emits when the durable manual-recovery reason changes", () => {
    const first = deriveWorkflowMonitorProgress(
      makeEnvelope({
        needsManualRecovery: true,
        manualRecoveryReason: "head mismatch requires operator recovery",
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required"
      })
    );
    const second = deriveWorkflowMonitorProgress(
      makeEnvelope({
        needsManualRecovery: true,
        manualRecoveryReason: "repo lock was lost",
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required"
      }),
      { priorDigest: first.digest }
    );
    expect(second.digest).not.toBe(first.digest);
    expect(second.changed).toBe(true);
    expect(second.emit).toBe(true);
  });

  it("classifies a succeeded run as terminal with explicit release cleanup", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        runState: "succeeded",
        terminal: true,
        disposition: "report",
        reportable: true,
        reportReason: "terminal_succeeded",
        activeStep: null,
        stepState: null,
        nextAction: {
          code: "no_action",
          stepId: null,
          leaseKind: null,
          detail: "Run is terminally succeeded. No further action required."
        },
        counts: makeCounts({
          steps: 2,
          stepsByState: {
            pending: 0,
            approved: 0,
            running: 0,
            succeeded: 2,
            failed: 0,
            skipped: 0,
            blocked: 0,
            canceled: 0
          }
        })
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("terminal");
    expect(tick.terminal).toBe(true);
    expect(tick.cleanup).toBe("release");
    expect(tick.lastEvent).toBe("run:succeeded");
  });

  it("classifies a canceled run as terminal with release cleanup", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        runState: "canceled",
        terminal: true,
        disposition: "report",
        reportable: true,
        reportReason: "terminal_canceled",
        activeStep: null,
        stepState: null,
        nextAction: {
          code: "no_action",
          stepId: null,
          leaseKind: null,
          detail: "Run is canceled. No further action required."
        }
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("terminal");
    expect(tick.cleanup).toBe("release");
  });

  it("keeps reporting terminal cleanup even when the tick is suppressed", () => {
    const env = makeEnvelope({
      runState: "succeeded",
      terminal: true,
      disposition: "report",
      reportable: true,
      reportReason: "terminal_succeeded",
      activeStep: null,
      stepState: null,
      nextAction: {
        code: "no_action",
        stepId: null,
        leaseKind: null,
        detail: "Run is terminally succeeded."
      }
    });
    const first = deriveWorkflowMonitorProgress(env);
    const second = deriveWorkflowMonitorProgress(env, {
      priorDigest: first.digest
    });
    expect(second.emit).toBe(false);
    expect(second.cleanup).toBe("release");
    expect(second.terminal).toBe(true);
  });

  it("keeps an operator-reconciled succeeded run terminal despite stale recovery disposition (NGX-543)", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        runState: "succeeded",
        terminal: true,
        disposition: "recover",
        reportable: true,
        reportReason: "recovery_required",
        needsManualRecovery: true,
        manualRecoveryReason:
          "Dispatch invocation ended `manual_recovery_required` before operator reconciliation.",
        activeStep: null,
        stepState: null,
        recovery: null,
        nextAction: {
          code: "no_action",
          stepId: null,
          leaseKind: null,
          detail: "Run is terminally succeeded. No further action required."
        },
        counts: makeCounts({
          steps: 6,
          stepsByState: {
            pending: 0,
            approved: 0,
            running: 0,
            succeeded: 6,
            failed: 0,
            skipped: 0,
            blocked: 0,
            canceled: 0
          }
        }),
        lastCheckpoint: {
          stepId: "linear-refresh",
          at: 1_730_000_000_000,
          source: "ledger",
          digest: "rc2-reconcile::linear-refresh::succeeded"
        }
      })
    );
    expect(tick.phase).toBe<WorkflowMonitorProgressPhase>("terminal");
    expect(tick.blockerReason).toBeNull();
    expect(tick.cleanup).toBe("release");
    expect(tick.terminal).toBe(true);
  });

  it("derives lastEvent from the durable checkpoint when present", () => {
    const tick = deriveWorkflowMonitorProgress(
      makeEnvelope({
        lastCheckpoint: {
          stepId: "implementation",
          at: 1_730_000_000_000,
          source: "ledger",
          digest: "sha256:abc"
        }
      })
    );
    expect(tick.lastEvent).toBe("checkpoint:ledger:implementation");
  });

  it("exposes the full phase vocabulary", () => {
    expect([...WORKFLOW_MONITOR_PROGRESS_PHASES].sort()).toEqual(
      ["advancing", "awaiting_approval", "blocked", "idle", "terminal"].sort()
    );
  });
});
