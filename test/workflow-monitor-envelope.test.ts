import { describe, expect, it } from "vitest";

import {
  WORKFLOW_MONITOR_DISPOSITIONS,
  WORKFLOW_MONITOR_REPORT_REASONS,
  WORKFLOW_MONITOR_SCHEMA_VERSION,
  buildWorkflowMonitorEnvelope,
  classifyWorkflowMonitorReport,
} from "../src/core/workflow/monitor/envelope.js";
import {
  deriveWorkflowMonitorState,
  type WorkflowMonitorAdvisory,
  type WorkflowMonitorInput,
} from "../src/core/workflow/monitor/state.js";
import type {
  WorkflowEvidenceLink,
  WorkflowRunDetail,
  WorkflowRunDetailGate,
  WorkflowRunRow,
} from "../src/core/workflow/run/status.js";
import type { WorkflowGateRecord } from "../src/core/workflow/gate/persist.js";
import { policyForWorkflowGateRecommendedAction } from "../src/core/workflow/monitor/action-authority.js";
import {
  type WorkflowLeaseRecord,
  type WorkflowStepKind,
  type WorkflowStepRecord,
  type WorkflowStepState,
} from "../src/core/workflow/run/reducer.js";

const RUN_ID = "cwfp-monitor01";

function step(
  stepId: string,
  kind: WorkflowStepKind,
  state: WorkflowStepState,
  order: number,
  required = true,
): WorkflowStepRecord {
  return { stepId, kind, state, order, required };
}

function lease(
  overrides: Partial<WorkflowLeaseRecord> = {},
): WorkflowLeaseRecord {
  return {
    runId: RUN_ID,
    leaseKind: "managed-step",
    holder: `coding-workflow:${RUN_ID}`,
    acquiredAt: 1_000,
    expiresAt: 5_000,
    heartbeatAt: 1_000,
    releasedAt: null,
    stalePolicy: "auto-release",
    ...overrides,
  };
}

function gate(
  overrides: Partial<WorkflowGateRecord> = {},
): WorkflowRunDetailGate {
  const record: WorkflowGateRecord = {
    gateId: "gate-1",
    workflowRunId: RUN_ID,
    stepRunId: null,
    attemptId: null,
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
    ...overrides,
  };
  return {
    ...record,
    recommendedActionPolicy: policyForWorkflowGateRecommendedAction({
      gateType: record.gateType,
      recommendedAction: record.recommendedAction,
    }),
  };
}

function monitorFrom(overrides: Partial<WorkflowMonitorInput>) {
  return deriveWorkflowMonitorState({
    runId: RUN_ID,
    steps: [],
    leases: [],
    now: 100_000,
    ...overrides,
  });
}

describe("workflow-monitor-envelope constants", () => {
  it("pins the schema version at 1 for M8", () => {
    expect(WORKFLOW_MONITOR_SCHEMA_VERSION).toBe(1);
  });

  it("exposes a stable set of dispositions", () => {
    expect([...WORKFLOW_MONITOR_DISPOSITIONS].sort()).toEqual(
      ["recover", "report", "wait"].sort(),
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
        "terminal_succeeded",
      ].sort(),
    );
  });
});

describe("classifyWorkflowMonitorReport", () => {
  it("reports a terminally succeeded run", () => {
    const monitor = monitorFrom({
      steps: [
        step("preflight", "preflight", "succeeded", 0),
        step("implementation", "implementation", "succeeded", 1),
      ],
    });
    expect(monitor.runState).toBe("succeeded");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "terminal_succeeded",
    });
  });

  it("reports a canceled run", () => {
    const monitor = monitorFrom({
      steps: [step("preflight", "preflight", "canceled", 0)],
    });
    expect(monitor.runState).toBe("canceled");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "terminal_canceled",
    });
  });

  it("asks for operator recovery when a required step failed", () => {
    const monitor = monitorFrom({
      steps: [step("no-mistakes", "no-mistakes", "failed", 0)],
    });
    expect(monitor.runState).toBe("failed");
    expect(monitor.recovery?.code).toBe("failed_required_step");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required",
    });
  });

  // A failed external-side-effect tail step (merge-cleanup / linear-refresh) may
  // have already pushed a branch or merged a PR before failing. The operator-
  // facing report must surface it as a recoverable ask - not mask it behind the
  // generic failed-required-step rerun guidance and not present it as a clean
  // terminal failure - even before the durable manual-recovery flag is set.
  it("asks for operator recovery when an external-side-effect tail step failed", () => {
    const monitor = monitorFrom({
      steps: [step("merge-cleanup", "merge-cleanup", "failed", 0)],
    });
    expect(monitor.runState).toBe("failed");
    expect(monitor.recovery?.code).toBe("failed_external_side_effect_step");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required",
    });
  });

  it("asks for operator recovery on a stale running step", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 5_000 })],
      now: 100_000,
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
          stalePolicy: "manual-recovery-required",
        }),
      ],
      now: 100_000,
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
      lastEmittedDigest: "stale",
    };
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      monitor: advisory,
      now: 100_000,
    });
    expect(monitor.recovery?.code).toBe("monitor_drift_stale");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "monitor_drift",
    });
  });

  it("reports a step awaiting an approval boundary", () => {
    const monitor = monitorFrom({
      steps: [step("preflight", "preflight", "pending", 0)],
    });
    expect(monitor.nextAction.code).toBe("await_approval");
    expect(monitor.activeStep).not.toBeNull();
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "report",
      reportable: true,
      reportReason: "awaiting_approval",
    });
  });

  it("waits while a running step has fresh evidence", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      now: 100_000,
    });
    expect(monitor.recovery).toBeNull();
    expect(monitor.nextAction.code).toBe("resume_running");
    const report = classifyWorkflowMonitorReport(monitor, false);
    expect(report).toEqual({
      disposition: "wait",
      reportable: false,
      reportReason: "in_progress",
    });
  });

  it("waits while an approved step is ready to dispatch", () => {
    const monitor = monitorFrom({
      steps: [
        step("preflight", "preflight", "succeeded", 0),
        step("implementation", "implementation", "approved", 1),
      ],
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
      reportReason: "idle",
    });
  });

  it("escalates to recovery when the durable manual-recovery flag is set", () => {
    const monitor = monitorFrom({
      steps: [step("implementation", "implementation", "running", 0)],
      leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
      now: 100_000,
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
    monitorLastSeenAt: null,
    monitorLastEmittedAt: null,
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
    ...overrides,
  };
}

function detailFrom(
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail {
  const monitor = monitorFrom({
    steps: [step("implementation", "implementation", "running", 0)],
    leases: [lease({ leaseKind: "managed-step", expiresAt: 200_000 })],
    now: 100_000,
  });
  return {
    run: runRow(),
    steps: [],
    approvals: [],
    leases: [],
    monitor,
    evidence: [],
    gates: [],
    ...overrides,
  };
}

describe("buildWorkflowMonitorEnvelope", () => {
  it("stamps the schema version and generated-at and mirrors monitor state", () => {
    const envelope = buildWorkflowMonitorEnvelope(detailFrom(), {
      generatedAt: 4_242,
    });
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.generatedAt).toBe(4_242);
    expect(envelope.runId).toBe(RUN_ID);
    expect(envelope.runState).toBe("running");
    expect(envelope.stepState).toBe("running");
    expect(envelope.terminal).toBe(false);
    expect(envelope.blocked).toBe(false);
    expect(envelope.needsManualRecovery).toBe(false);
    expect(envelope.manualRecoveryReason).toBeNull();
    expect(envelope.disposition).toBe("wait");
    expect(envelope.reportReason).toBe("in_progress");
    expect(envelope.nextAction.code).toBe("resume_running");
  });

  it("threads the durable manual-recovery flag into the report classification", () => {
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({ run: runRow({ needsManualRecovery: true }) }),
      { generatedAt: 7 },
    );
    expect(envelope.needsManualRecovery).toBe(true);
    expect(envelope.disposition).toBe("recover");
    expect(envelope.reportReason).toBe("recovery_required");
    expect(envelope.reportable).toBe(true);
  });

  it("threads the durable manual-recovery reason into the monitor envelope", () => {
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({
        run: runRow({
          needsManualRecovery: true,
          manualRecoveryReason: "repo lock was lost",
        }),
      }),
      { generatedAt: 7 },
    );
    expect(envelope.needsManualRecovery).toBe(true);
    expect(envelope.manualRecoveryReason).toBe("repo lock was lost");
  });

  it("surfaces a failed external-side-effect tail step as a recoverable envelope, not a clean terminal failure", () => {
    const monitor = monitorFrom({
      steps: [step("linear-refresh", "linear-refresh", "failed", 0)],
    });
    expect(monitor.recovery?.code).toBe("failed_external_side_effect_step");
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({ run: runRow({ state: "failed" }), monitor }),
      { generatedAt: 11 },
    );
    // The substrate is terminally failed, yet the operator-facing envelope must
    // present a recoverable ask (reconcile from external success evidence), not a
    // misleading clean terminal failure after a PR may already have merged.
    expect(envelope.runState).toBe("failed");
    expect(envelope.terminal).toBe(true);
    expect(envelope.disposition).toBe("recover");
    expect(envelope.reportReason).toBe("recovery_required");
    expect(envelope.reportable).toBe(true);
    expect(envelope.recovery?.code).toBe("failed_external_side_effect_step");
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
        stepId: "implementation",
      },
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
            updatedAt: 1,
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
            updatedAt: 1,
          },
        ],
        evidence,
      }),
      { generatedAt: 9 },
    );
    expect(envelope.counts.steps).toBe(2);
    expect(envelope.counts.stepsByState.succeeded).toBe(1);
    expect(envelope.counts.stepsByState.running).toBe(1);
    expect(envelope.evidence).toEqual(evidence);
  });

  it("surfaces durable gates and an open-vs-total gate count", () => {
    const gates: WorkflowRunDetailGate[] = [
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
        resolution: "applied",
      }),
    ];
    const envelope = buildWorkflowMonitorEnvelope(detailFrom({ gates }), {
      generatedAt: 11,
    });
    expect(
      envelope.gates.map((gate) => ({
        gateId: gate.gateId,
        recommendedAction: gate.recommendedAction,
        recommendedActionPolicy: {
          action: gate.recommendedActionPolicy.action,
          authority: gate.recommendedActionPolicy.authority,
          risk: gate.recommendedActionPolicy.risk,
        },
      })),
    ).toEqual([
      {
        gateId: "gate-open-1",
        recommendedAction: "approve",
        recommendedActionPolicy: {
          action: "approval_decision",
          authority: "human_required",
          risk: "medium",
        },
      },
      {
        gateId: "gate-done-1",
        recommendedAction: "approve",
        recommendedActionPolicy: {
          action: "operator_decision",
          authority: "human_required",
          risk: "medium",
        },
      },
    ]);
    expect(envelope.counts.gates).toBe(2);
    expect(envelope.counts.gatesOpen).toBe(1);
  });

  it("defaults the gate count to zero when a run has no gates", () => {
    const envelope = buildWorkflowMonitorEnvelope(detailFrom(), {
      generatedAt: 12,
    });
    expect(envelope.gates).toEqual([]);
    expect(envelope.counts.gates).toBe(0);
    expect(envelope.counts.gatesOpen).toBe(0);
  });

  it("surfaces the durable last-emitted digest as the progress suppression baseline (NGX-511)", () => {
    const envelope = buildWorkflowMonitorEnvelope(
      detailFrom({
        run: runRow({ monitorLastEmittedDigest: "sha256:prior-baseline" }),
      }),
      { generatedAt: 13 },
    );
    expect(envelope.monitorLastEmittedDigest).toBe("sha256:prior-baseline");
  });

  it("defaults the last-emitted digest to null when never persisted (NGX-511)", () => {
    const envelope = buildWorkflowMonitorEnvelope(detailFrom(), {
      generatedAt: 14,
    });
    expect(envelope.monitorLastEmittedDigest).toBeNull();
  });
});
