import { describe, expect, it } from "vitest";

import {
  WORKFLOW_MONITOR_NEXT_ACTION_CODES,
  WORKFLOW_MONITOR_RECOVERY_CODES,
  deriveWorkflowMonitorState,
  type WorkflowMonitorAdvisory,
  type WorkflowMonitorCheckpoint,
  type WorkflowMonitorInput
} from "../src/workflow-monitor-state.js";
import {
  type WorkflowLeaseRecord,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "../src/workflow-run-reducer.js";

const RUN_ID = "cwfp-test01";

function step(
  stepId: string,
  kind: WorkflowStepKind,
  state: WorkflowStepState,
  order: number,
  required = true
): WorkflowStepRecord {
  return { stepId, kind, state, order, required };
}

function lease(overrides: Partial<WorkflowLeaseRecord> = {}): WorkflowLeaseRecord {
  return {
    runId: RUN_ID,
    leaseKind: "monitor",
    holder: `coding-workflow-monitor:${RUN_ID}`,
    acquiredAt: 1_000,
    expiresAt: 5_000,
    heartbeatAt: 1_000,
    releasedAt: null,
    stalePolicy: "auto-release",
    ...overrides
  };
}

function checkpoint(
  stepId: string,
  at: number,
  source: WorkflowMonitorCheckpoint["source"] = "ledger",
  digest: string | null = null
): WorkflowMonitorCheckpoint {
  return { stepId, at, source, digest };
}

function buildInput(overrides: Partial<WorkflowMonitorInput>): WorkflowMonitorInput {
  return {
    runId: RUN_ID,
    steps: [],
    leases: [],
    now: 100_000,
    ...overrides
  };
}

describe("workflow-monitor-state constants", () => {
  it("exposes a stable set of nextAction codes", () => {
    expect([...WORKFLOW_MONITOR_NEXT_ACTION_CODES].sort()).toEqual(
      [
        "advance_to_step",
        "await_approval",
        "clear_recovery",
        "investigate_stale",
        "no_action",
        "rerun_failed_step",
        "resume_running"
      ].sort()
    );
  });

  it("exposes a stable set of recovery codes", () => {
    expect([...WORKFLOW_MONITOR_RECOVERY_CODES].sort()).toEqual(
      [
        "failed_required_step",
        "ghost_active_no_lease",
        "manual_recovery_lease",
        "monitor_drift_stale",
        "stale_running_step"
      ].sort()
    );
  });
});

describe("deriveWorkflowMonitorState: SK-467 stale monitor JSON with terminal ledger evidence", () => {
  const steps: WorkflowStepRecord[] = [
    step("preflight", "preflight", "succeeded", 0),
    step("implementation", "implementation", "succeeded", 1),
    step("postflight", "postflight", "succeeded", 2)
  ];

  const advisory: WorkflowMonitorAdvisory = {
    runState: "running",
    terminal: false,
    step: "postflight",
    lastSeenDigest: "stale-digest",
    lastEmittedDigest: "stale-digest"
  };

  it("reports succeeded when ledger evidence is terminal, regardless of stale monitor advisory", () => {
    const monitorLease = lease({
      leaseKind: "monitor",
      releasedAt: 9_000,
      expiresAt: 4_000
    });
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases: [monitorLease],
        monitor: advisory,
        lastCheckpoint: checkpoint("postflight", 8_000),
        now: 10_000
      })
    );
    expect(result.runState).toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.needsRecoveryArtifact).toBe(false);
    expect(result.recovery).toBeNull();
    expect(result.nextAction.code).toBe("no_action");
    expect(result.activeStep).toBeNull();
  });

  it("flags monitor drift when monitor advisory claims active but ledger says terminal", () => {
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases: [lease({ releasedAt: 9_000, expiresAt: 4_000 })],
        monitor: advisory,
        now: 10_000
      })
    );
    expect(result.monitorDrift).not.toBeNull();
    expect(result.monitorDrift?.drifted).toBe(true);
    expect(result.monitorDrift?.reason).toBe("monitor_says_active_but_terminal");
    expect(result.monitorDrift?.actualState).toBe("succeeded");
  });
});

describe("deriveWorkflowMonitorState: SK-468 lost managed task with completed implementation ledger", () => {
  it("advances to the next approved step when the managed-step lease was cleanly released and implementation is complete", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "succeeded", 1),
      step("postflight", "postflight", "approved", 2)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      }),
      lease({
        leaseKind: "managed-step",
        holder: "node_managed_dispatch.py:pid=4711",
        acquiredAt: 50_000,
        expiresAt: 60_000,
        heartbeatAt: 60_000,
        releasedAt: 60_500
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: checkpoint("implementation", 60_000, "ledger"),
        now: 100_000
      })
    );
    // The lease-aware reducer surfaces "approved" (not "running") when the
    // step-derived state has an approved step queued next: the M7 contract
    // only demotes "succeeded" to "running" on outstanding leases. The
    // operator-facing surface is the next action, not the raw lifecycle state.
    expect(result.runState).toBe("approved");
    expect(result.terminal).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.activeStep?.stepId).toBe("postflight");
    expect(result.activeStep?.state).toBe("approved");
    expect(result.needsRecoveryArtifact).toBe(false);
    expect(result.nextAction.code).toBe("advance_to_step");
    expect(result.nextAction.stepId).toBe("postflight");
    expect(result.nextAction.leaseKind).toBe("managed-step");
  });

  it("reports await_approval when the next required step is still pending", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "succeeded", 1),
      step("postflight", "postflight", "pending", 2)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: checkpoint("implementation", 60_000, "ledger"),
        now: 100_000
      })
    );
    expect(result.activeStep?.stepId).toBe("postflight");
    expect(result.activeStep?.state).toBe("pending");
    expect(result.nextAction.code).toBe("await_approval");
    expect(result.nextAction.stepId).toBe("postflight");
    expect(result.needsRecoveryArtifact).toBe(false);
  });
});

describe("deriveWorkflowMonitorState: NGX-304 quiet monitor drift with stale running step", () => {
  it("flags stale_running_step recovery when a step is running, lease is stale, and no recent checkpoint exists", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1),
      step("postflight", "postflight", "pending", 2)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      }),
      lease({
        leaseKind: "managed-step",
        holder: "node_managed_dispatch.py:pid=9001",
        acquiredAt: 1_000,
        expiresAt: 5_000,
        heartbeatAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      })
    ];
    const advisory: WorkflowMonitorAdvisory = {
      runState: "running",
      terminal: false,
      step: "implementation",
      lastSeenDigest: "same-digest",
      lastEmittedDigest: "same-digest"
    };
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        monitor: advisory,
        lastCheckpoint: checkpoint("implementation", 5_000, "ledger"),
        now: 10_000_000,
        checkpointStaleMs: 60_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.terminal).toBe(false);
    expect(result.activeStep?.stepId).toBe("implementation");
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("stale_running_step");
    expect(result.recovery?.stepId).toBe("implementation");
    expect(result.nextAction.code).toBe("investigate_stale");
    expect(result.nextAction.stepId).toBe("implementation");
  });

  it("does not flag silent success: stale lease does not promote a running step to succeeded", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        expiresAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        now: 10_000_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.terminal).toBe(false);
    expect(result.needsRecoveryArtifact).toBe(true);
  });
});

describe("deriveWorkflowMonitorState: manual-recovery-required lease forces blocked + clear_recovery action", () => {
  it("returns blocked with manual_recovery_lease recovery when a manual-recovery lease is stale", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        expiresAt: 5_000,
        releasedAt: null,
        stalePolicy: "manual-recovery-required"
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        now: 100_000
      })
    );
    expect(result.runState).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("manual_recovery_lease");
    expect(result.nextAction.code).toBe("clear_recovery");
  });
});

describe("deriveWorkflowMonitorState: ghost-run guard (no lease, no checkpoint, but step is running)", () => {
  it("flags ghost_active_no_lease when a step is running with neither lease nor checkpoint", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases: [],
        lastCheckpoint: null,
        now: 100_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("ghost_active_no_lease");
    expect(result.nextAction.code).toBe("investigate_stale");
  });
});

describe("deriveWorkflowMonitorState: ghost-run guard treats monitor-only leases as no dispatch evidence", () => {
  it("flags ghost_active_no_lease when only a monitor lease has been recorded (no managed-step / dispatch lease ever)", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: null,
        now: 100_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("ghost_active_no_lease");
    expect(result.nextAction.code).toBe("investigate_stale");
  });
});

describe("deriveWorkflowMonitorState: orphan non-monitor lease after every step terminal", () => {
  it("flags stale_running_step + investigate_stale when all steps succeeded but a non-monitor lease still holds the run in running", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "succeeded", 1),
      step("postflight", "postflight", "succeeded", 2)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        holder: "node_managed_dispatch.py:pid=9001",
        acquiredAt: 1_000,
        expiresAt: 5_000,
        heartbeatAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        now: 100_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.activeStep).toBeNull();
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("stale_running_step");
    expect(result.recovery?.stepId).toBeNull();
    expect(result.nextAction.code).toBe("investigate_stale");
    expect(result.nextAction.leaseKind).toBe("managed-step");
    expect(result.nextAction.stepId).toBeNull();
  });

  it("does not flag recovery when the only outstanding lease is a fresh monitor lease (transient pre-tick state)", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "succeeded", 1),
      step("postflight", "postflight", "succeeded", 2)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        now: 100_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.activeStep).toBeNull();
    expect(result.needsRecoveryArtifact).toBe(false);
    expect(result.recovery).toBeNull();
    expect(result.nextAction.code).toBe("await_approval");
  });
});

describe("deriveWorkflowMonitorState: failed required step suggests rerun_failed_step", () => {
  it("returns failed with rerun_failed_step nextAction and a failed_required_step recovery code", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "failed", 1)
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases: [
          lease({ leaseKind: "managed-step", releasedAt: 9_500, expiresAt: 5_000 })
        ],
        now: 100_000
      })
    );
    expect(result.runState).toBe("failed");
    expect(result.terminal).toBe(true);
    expect(result.recovery?.code).toBe("failed_required_step");
    expect(result.nextAction.code).toBe("rerun_failed_step");
    expect(result.nextAction.stepId).toBe("implementation");
  });
});

describe("deriveWorkflowMonitorState: live evidence wins over stale lease for resume_running", () => {
  it("returns resume_running when a running step has a fresh checkpoint even if the lease is stale-auto-release", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        expiresAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      })
    ];
    const now = 10_000;
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: checkpoint("implementation", now - 30_000, "ledger"),
        now,
        checkpointStaleMs: 60_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.nextAction.code).toBe("resume_running");
    expect(result.needsRecoveryArtifact).toBe(false);
  });
});

describe("deriveWorkflowMonitorState: lease views are exposed with classifications", () => {
  it("classifies each lease with its freshness and preserves the holder", () => {
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        holder: "coding-workflow-monitor:cwfp-x",
        expiresAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      }),
      lease({
        leaseKind: "managed-step",
        holder: "dispatch:pid=1",
        expiresAt: 10_000,
        releasedAt: 11_000
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps: [step("preflight", "preflight", "succeeded", 0)],
        leases,
        now: 7_000
      })
    );
    expect(result.leases).toHaveLength(2);
    const monitorView = result.leases.find((l) => l.leaseKind === "monitor");
    const managedView = result.leases.find((l) => l.leaseKind === "managed-step");
    expect(monitorView?.classification).toBe("stale-auto-release");
    expect(monitorView?.holder).toBe("coding-workflow-monitor:cwfp-x");
    expect(managedView?.classification).toBe("released");
  });
});

describe("deriveWorkflowMonitorState: empty / pending runs", () => {
  it("returns pending with await_approval when there are no steps yet", () => {
    const result = deriveWorkflowMonitorState(
      buildInput({ steps: [], leases: [], now: 100 })
    );
    expect(result.runState).toBe("pending");
    expect(result.activeStep).toBeNull();
    expect(result.nextAction.code).toBe("await_approval");
    expect(result.needsRecoveryArtifact).toBe(false);
  });
});

describe("deriveWorkflowMonitorState: monitor advisory says terminal but ledger still has work", () => {
  it("flags monitor_says_terminal_but_running drift", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "approved", 1)
    ];
    const advisory: WorkflowMonitorAdvisory = {
      runState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: null,
      lastEmittedDigest: null
    };
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        monitor: advisory,
        lastCheckpoint: checkpoint("preflight", 5_000, "ledger"),
        now: 10_000
      })
    );
    expect(result.runState).not.toBe("succeeded");
    expect(result.monitorDrift?.drifted).toBe(true);
    expect(result.monitorDrift?.reason).toBe("monitor_says_terminal_but_running");
  });
});

describe("deriveWorkflowMonitorState: monitor_step_mismatch drift", () => {
  it("flags monitor_step_mismatch when advisory runState differs from actual but terminal flags agree", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "approved", 1)
    ];
    const advisory: WorkflowMonitorAdvisory = {
      runState: "pending",
      terminal: null,
      step: "implementation",
      lastSeenDigest: null,
      lastEmittedDigest: null
    };
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "monitor",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        monitor: advisory,
        lastCheckpoint: checkpoint("preflight", 5_000, "ledger"),
        now: 10_000
      })
    );
    expect(result.runState).toBe("approved");
    expect(result.monitorDrift).not.toBeNull();
    expect(result.monitorDrift?.drifted).toBe(true);
    expect(result.monitorDrift?.reason).toBe("monitor_step_mismatch");
    expect(result.monitorDrift?.advisoryState).toBe("pending");
    expect(result.monitorDrift?.actualState).toBe("approved");
  });
});

describe("deriveWorkflowMonitorState: monitor_drift_stale recovery", () => {
  it("emits monitor_drift_stale when a running step has fresh evidence but monitor advisory drifts", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        expiresAt: 200_000,
        releasedAt: null
      })
    ];
    const advisory: WorkflowMonitorAdvisory = {
      runState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: null,
      lastEmittedDigest: null
    };
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        monitor: advisory,
        lastCheckpoint: checkpoint("implementation", 9_000, "ledger"),
        now: 10_000
      })
    );
    expect(result.runState).toBe("running");
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("monitor_drift_stale");
    expect(result.nextAction.code).toBe("resume_running");
    expect(result.monitorDrift?.drifted).toBe(true);
  });

  it("emits monitor_drift_stale when no running step and monitor drifts", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "approved", 1)
    ];
    const advisory: WorkflowMonitorAdvisory = {
      runState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: null,
      lastEmittedDigest: null
    };
    const result = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases: [
          lease({ leaseKind: "monitor", expiresAt: 200_000, releasedAt: null })
        ],
        monitor: advisory,
        lastCheckpoint: checkpoint("preflight", 5_000, "ledger"),
        now: 10_000
      })
    );
    expect(result.needsRecoveryArtifact).toBe(true);
    expect(result.recovery?.code).toBe("monitor_drift_stale");
    expect(result.nextAction.code).toBe("advance_to_step");
    expect(result.nextAction.stepId).toBe("implementation");
  });
});

describe("deriveWorkflowMonitorState: checkpointStaleMs default", () => {
  it("uses the default 30-minute window when checkpointStaleMs is not specified", () => {
    const steps: WorkflowStepRecord[] = [
      step("preflight", "preflight", "succeeded", 0),
      step("implementation", "implementation", "running", 1)
    ];
    const leases: WorkflowLeaseRecord[] = [
      lease({
        leaseKind: "managed-step",
        expiresAt: 5_000,
        releasedAt: null,
        stalePolicy: "auto-release"
      })
    ];
    const now = 10_000;
    const resultFresh = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: checkpoint("implementation", now - 29 * 60 * 1000, "ledger"),
        now
      })
    );
    expect(resultFresh.nextAction.code).toBe("resume_running");
    expect(resultFresh.needsRecoveryArtifact).toBe(false);

    const resultStale = deriveWorkflowMonitorState(
      buildInput({
        steps,
        leases,
        lastCheckpoint: checkpoint("implementation", now - 31 * 60 * 1000, "ledger"),
        now
      })
    );
    expect(resultStale.needsRecoveryArtifact).toBe(true);
    expect(resultStale.recovery?.code).toBe("stale_running_step");
  });
});
