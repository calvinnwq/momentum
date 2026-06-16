import { describe, expect, it } from "vitest";

import {
  WORKFLOW_MONITOR_DISPOSITIONS,
  WORKFLOW_MONITOR_REPORT_REASONS,
  WORKFLOW_MONITOR_SCHEMA_VERSION,
  buildWorkflowMonitorEnvelope,
  classifyWorkflowMonitorReport
} from "../src/core/workflow/monitor-envelope.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorAdvisory,
  type WorkflowMonitorInput
} from "../src/core/workflow/monitor-state.js";
import type {
  WorkflowEvidenceLink,
  WorkflowRunDetail,
  WorkflowRunRow
} from "../src/core/workflow/status.js";
import type { WorkflowGateRecord } from "../src/core/workflow/gate-persist.js";
import {
  type WorkflowLeaseRecord,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState
} from "../src/core/workflow/run-reducer.js";

const RUN_ID = "cwfp-monitor01";

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
    leaseKind: "managed-step",
    holder: `coding-workflow:${RUN_ID}`,
    acquiredAt: 1_000,
    expiresAt: 5_000,
    heartbeatAt: 1_000,
    releasedAt: null,
    stalePolicy: "auto-release",
    ...overrides
  };
}

function gate(overrides: Partial<WorkflowGateRecord> = {}): WorkflowGateRecord {
  return {
    gateId: "gate-1",
    workflowRunId: RUN_ID,
    stepRunId: null,
    invocationId: null,
    roundId: null,
    targetScope: "workflow",
    gateType: "approval_required",
    reason: "operator must approve external apply",
    evidence: null,
    allowedActions: ["approve", "reject"],
    recommendedAction: "approve",
    policyEnvelope: [],
    resolvedAt: null,
    resolvedBy: null,
    resolutionMode: null,
    chosenAction: null,
    resolution: null,
    ...overrides
  };
}

function monitorFrom(overrides: Partial<WorkflowMonitorInput>) {
  return deriveWorkflowMonitorState({
    runId: RUN_ID,
    steps: [],
    leases: [],
    now: 100_000,
    ...overrides
  });
}

describe("workflow-monitor-envelope constants", () => {
  it("pins the schema version at 1 for M8", () => {
    expect(WORKFLOW_MONITOR_SCHEMA_VERSION).toBe(1);
  });

  it("exposes a stable set of dispositions", () => {
    expect([...WORKFLOW_MONITOR_DISPOSITIONS].sort()).toEqual(
      ["recover", "report", "wait"].sort()
    );
  });

  it("exposes a stable set of report reasons", () => {
    expect([...WORKFLOW_MONITOR_REPORT_REASONS].sort()).toEqual(
      [
        "awaiting_approval",
        "idle",
        "in_progress",
        "monitor_drift",
        "recovery_required",
        "terminal_canceled",
        "terminal_succeeded"
      ].sort()
    );
  });
});

describe("classifyWorkflowMonitorReport", () => {
  it("reports a terminally succeeded run", () => {
    const monitor = monitorFrom({
      steps: [
        step("preflight", "preflight", "succeeded", 0),
        step("implementation", "implementation", "succeeded", 1)
      ]
    });
    expect(monitor.runState).toBe("succeeded");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "terminal_succeeded"
    });
  });

  it("reports a canceled run", () => {
    const monitor = monitorFrom({
      steps: [step("preflight", "preflight", "canceled", 0)]
    });
    expect(monitor.runState).toBe("canceled");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "terminal_canceled"
    });
  });

  it("asks for operator recovery when a required step failed", () => {
    const monitor = monitorFrom({
      steps: [step("no-mistakes", "no-mistakes", "failed", 0)]
    });
    expect(monitor.runState).toBe("failed");
    expect(monitor.recovery?.code).toBe("failed_required_step");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required"
    });
  });

  it("asks for operator recovery on a stale running step", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 5_000 })],
      now: 100_000
    });
    expect(monitor.recovery?.code).toBe("stale_running_step");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report.disposition).toBe("recover");
    expect(report.reportReason).toBe("recovery_required");
  });

  it("asks for operator recovery on a blocked run", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [
        lease({
          leaseKind: "managed-step",
          expiresAt: 5_000,
          stalePolicy: "manual-recovery-required"
        })
      ],
      now: 100_000
    });
    expect(monitor.blocked).toBe(true);
    expect(monitor.recovery?.code).toBe("manual_recovery_lease");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report.disposition).toBe("recover");
    expect(report.reportReason).toBe("recovery_required");
  });

  it("reports monitor drift while the run keeps progressing", () => {
    const advisory: WorkflowMonitorAdvisory = {
      runState: "succeeded",
      terminal: true,
      step: "implementation",
      lastSeenDigest: "stale",
      lastEmittedDigest: "stale"
    };
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      monitor: advisory,
      now: 100_000
    });
    expect(monitor.recovery?.code).toBe("monitor_drift_stale");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "monitor_drift"
    });
  });

  it("reports a step awaiting an approval boundary", () => {
    const monitor = monitorFrom({
      steps: [step("preflight", "preflight", "pending", 0)]
    });
    expect(monitor.nextAction.code).toBe("await_approval");
    expect(monitor.activeStep).not.toBeNull();
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "awaiting_approval"
    });
  });

  it("waits while a running step has fresh evidence", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      now: 100_000
    });
    expect(monitor.recovery).toBeNull();
    expect(monitor.nextAction.code).toBe("resume_running");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "wait",
      reportable: false,
      reportReason: "in_progress"
    });
  });

  it("waits while an approved step is ready to dispatch", () => {
    const monitor = monitorFrom({
      steps: [
        step("preflight", "preflight", "succeeded", 0),
        step("implementation", "implementation", "approved", 1)
      ]
    });
    expect(monitor.nextAction.code).toBe("advance_to_step");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report.disposition).toBe("wait");
    expect(report.reportReason).toBe("in_progress");
  });

  it("treats an empty plan as an idle no-op", () => {
    const monitor = monitorFrom({ steps: [] });
    expect(monitor.activeStep).toBeNull();
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "wait",
      reportable: false,
      reportReason: "idle"
    });
  });

  it("escalates to recovery when the durable manual-recovery flag is set", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      now: 100_000
    });
    // Healthy substrate, but the durable run-scoped flag forces recovery.
    expect(monitor.recovery).toBeNull();
    const report = classifyWorkflowMonitorReport(monitor, true);
    expect(report.disposition).toBe("recover");
    expect(report.reportReason).toBe("recovery_required");
  });
});

function runRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    runId: RUN_ID,
    state: "running",
    source: "agent-workflow",
    sourceArtifactPath: null,
    planJson: null,
    repoPath: null,
    objective: null,
    issueScope: {},
    route: {},
    approvalBoundary: null,
    skillRevision: null,
    monitorLastSeenState: null,
    monitorTerminal: null,
    monitorStep: null,
    monitorLastSeenDigest: null,
    monitorLastEmittedDigest: null,
    goalId: null,
    batchGroup: null,
    batchRole: null,
    needsManualRecovery: false,
    manualRecoveryReason: null,
    manualRecoveryAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function detailFrom(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  const monitor = monitorFrom({
    steps: [step("implementation", "implementation", "running", 0)],
    leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
    now: 100_000
  });
  return {
    run: runRow(),
    steps: [],
    approvals: [],
    leases: [],
    monitor,
    evidence: [],
    gates: [],
    ...overrides
  };
}

describe("buildWorkflowMonitorEnvelope", () => {
  it("stamps the schema version and generated-at and mirrors monitor state", () => {
    const envelope = buildWorkflowMonitorEnvelope(detailFrom(), {
      generatedAt: 4_242
    });
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.generatedAt).toBe(4_242);
    expect(envelope.runId).toBe(RUN_ID);
    expect(envelope.runState).toBe("running");
    expect(envelope.stepState).toBe("running");
    expect(envelope.terminal).toBe(false);
    expect(envelope.blocked).toBe(false);
    expect(envelope.needsManualRecovery).toBe(false);
    expect(envelope.disposition).toBe("wait");
    expect(envelope.reportReason).toBe("in_progress");
    expect(envelope.nextAction.code).toBe("resume_running");
  });

  it("threads the durable manual-recovery flag into the report classification", () => {
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({ run: runRow({ needsManualRecovery: true }) }),
      { generatedAt: 7 }
    );
    expect(envelope.needsManualRecovery).toBe(true);
    expect(envelope.disposition).toBe("recover");
    expect(envelope.reportReason).toBe("recovery_required");
    expect(envelope.reportable).toBe(true);
  });

  it("summarizes counts and passes through typed evidence pointers", () => {
    const evidence: WorkflowEvidenceLink[] = [
      {
        evidenceRecordId: "ev-1",
        source: "agent-workflow",
        type: "ledger",
        artifactPath: ".agent-workflows/cwfp-monitor01/ledger.jsonl",
        occurredAt: 50,
        summary: "implementation step finished",
        runId: RUN_ID,
        stepId: "implementation"
      }
    ];
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({
        steps: [
          {
            runId: RUN_ID,
            stepId: "preflight",
            kind: "preflight",
            state: "succeeded",
            order: 0,
            required: true,
            ledgerOffset: null,
            resultDigest: null,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            finishedAt: null,
            createdAt: 1,
            updatedAt: 1
          },
          {
            runId: RUN_ID,
            stepId: "implementation",
            kind: "implementation",
            state: "running",
            order: 1,
            required: true,
            ledgerOffset: null,
            resultDigest: null,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            finishedAt: null,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        evidence
      }),
      { generatedAt: 9 }
    );
    expect(envelope.counts.steps).toBe(2);
    expect(envelope.counts.stepsByState.succeeded).toBe(1);
    expect(envelope.counts.stepsByState.running).toBe(1);
    expect(envelope.evidence).toEqual(evidence);
  });

  it("surfaces durable gates and an open-vs-total gate count", () => {
    const gates: WorkflowGateRecord[] = [
      gate({ gateId: "gate-open-1" }),
      gate({
        gateId: "gate-done-1",
        targetScope: "step",
        stepRunId: "implementation",
        gateType: "operator_decision_required",
        resolvedAt: 999,
        resolvedBy: "calvin",
        resolutionMode: "operator",
        chosenAction: "fix",
        resolution: "applied"
      })
    ];
    const envelope = buildWorkflowMonitorEnvelope(detailFrom({ gates }), {
      generatedAt: 11
    });
    expect(envelope.gates).toEqual(gates);
    expect(envelope.counts.gates).toBe(2);
    expect(envelope.counts.gatesOpen).toBe(1);
  });

  it("defaults the gate count to zero when a run has no gates", () => {
    const envelope = buildWorkflowMonitorEnvelope(detailFrom(), {
      generatedAt: 12
    });
    expect(envelope.gates).toEqual([]);
    expect(envelope.counts.gates).toBe(0);
    expect(envelope.counts.gatesOpen).toBe(0);
  });
});
