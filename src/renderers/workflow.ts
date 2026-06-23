import type { WorkflowGateRecord } from "../core/workflow/gate-persist.js";
import type { WorkflowHandoffEnvelope } from "../core/workflow/handoff.js";
import type {
  WorkflowRunLogRound,
  WorkflowRunLogsEnvelope
} from "../core/workflow/logs.js";
import type { WorkflowMonitorEnvelope } from "../core/workflow/monitor-envelope.js";
import type { WorkflowMonitorState } from "../core/workflow/monitor-state.js";
import type { WorkflowRunImport, WorkflowRunImportDiagnostic } from "../core/workflow/run-import.js";
import type { PersistWorkflowRunImportSummary } from "../core/workflow/run-import-persist.js";
import type { WorkflowRunManualRecoveryState } from "../core/workflow/run-recovery.js";
import type { PersistWorkflowRunStartSummary } from "../core/workflow/run-start-persist.js";
import type {
  WorkflowCodingPlanPreview,
  WorkflowRunStartError
} from "../core/workflow/run-start.js";
import type {
  WorkflowApprovalRow,
  WorkflowEvidenceLink,
  WorkflowLeaseRow,
  WorkflowRunDetail,
  WorkflowRunRow,
  WorkflowRunSummary,
  WorkflowStepRow
} from "../core/workflow/status.js";
import type { ClearWorkflowRunManualRecoveryGuardedResult } from "../core/workflow/run-recovery.js";
import type { ReconcileWorkflowRunManualRecoveryResult } from "../core/workflow/recovery-reconcile.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

type WorkflowRendererFailure = {
  command: string;
  code: string;
  message: string;
  dataDir?: string;
  runId?: string;
  path?: string;
  boundary?: string;
  stepId?: string;
  gateId?: string;
  diagnostics?: WorkflowRunImportDiagnostic[];
  errors?: readonly WorkflowRunStartError[];
};

export type WorkflowRunStartCommand =
  | "workflow run start"
  | "workflow run start-coding"
  | "workflow run preview-coding";

export function emitWorkflowRunStartSuccess(
  parsed: { json: boolean },
  io: CliIo,
  result: {
    dataDir: string;
    repoPath: string;
    objective: string;
    summary: PersistWorkflowRunStartSummary;
    policyPresent: boolean;
    policyPath: string;
    command?: WorkflowRunStartCommand;
  }
): number {
  const { summary } = result;
  const payload = {
    ok: true,
    command: result.command ?? "workflow run start",
    dataDir: result.dataDir,
    runId: summary.runId,
    source: summary.source,
    state: summary.state,
    approvalBoundary: summary.approvalBoundary,
    definitionKey: summary.definitionKey,
    definitionVersion: summary.definitionVersion,
    repoPath: result.repoPath,
    objective: result.objective,
    counts: { steps: summary.stepCount },
    policy: { present: result.policyPresent, path: result.policyPath }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow run started: ${summary.runId}`,
    `Definition: ${summary.definitionKey} v${summary.definitionVersion}`,
    `State: ${summary.state}`,
    `Approval boundary: ${summary.approvalBoundary ?? "(none)"}`,
    `Steps: ${summary.stepCount}`,
    `Repo: ${result.repoPath}`,
    `Objective: ${result.objective}`,
    `Policy: ${result.policyPresent ? result.policyPath : "(none)"}`,
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunStartFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: Omit<WorkflowRendererFailure, "command"> & {
    command?: WorkflowRunStartCommand;
  }
): number {
  return emitWorkflowFailure(parsed, io, {
    ...failure,
    command: failure.command ?? "workflow run start"
  });
}

/**
 * Emit the frozen, pre-execution preview of a Momentum-native coding workflow
 * (`workflow run preview-coding`). The envelope mirrors the fields a
 * `workflow run start-coding` would durably persist - run id, repo, objective,
 * issue scope, route/profile, approval boundary, definition key/version, and the
 * ordered steps each with its executor family and on-start state - but carries an
 * explicit `preview: true` marker and writes nothing. It contains no wall-clock
 * fields, so repeated previews of the same inputs are byte-stable and safe to
 * show before approval.
 */
export function emitWorkflowRunPreviewCodingSuccess(
  parsed: { json: boolean },
  io: CliIo,
  result: {
    dataDir: string;
    preview: WorkflowCodingPlanPreview;
    policyPresent: boolean;
    policyPath: string;
  }
): number {
  const { preview } = result;
  const steps = preview.steps.map((step) => ({
    stepId: step.stepId,
    kind: step.kind,
    executor: step.executor,
    order: step.order,
    required: step.required,
    state: step.state
  }));
  const payload = {
    ok: true,
    command: "workflow run preview-coding" as const,
    preview: true,
    dataDir: result.dataDir,
    runId: preview.runId,
    source: preview.source,
    state: preview.state,
    approvalBoundary: preview.approvalBoundary,
    definitionKey: preview.definitionKey,
    definitionVersion: preview.definitionVersion,
    repoPath: preview.repoPath,
    objective: preview.objective,
    issueScope: preview.issueScope,
    route: preview.route,
    skillRevision: preview.skillRevision,
    steps,
    counts: { steps: steps.length },
    policy: { present: result.policyPresent, path: result.policyPath }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const profile =
    typeof preview.route["profile"] === "string"
      ? preview.route["profile"]
      : "(none)";
  const lines = [
    `Coding workflow plan preview (not started): ${preview.runId}`,
    `Definition: ${preview.definitionKey} v${preview.definitionVersion}`,
    `Source: ${preview.source}`,
    `State on start: ${preview.state}`,
    `Approval boundary: ${preview.approvalBoundary ?? "(none)"}`,
    `Profile: ${profile}`,
    `Repo: ${preview.repoPath}`,
    `Objective: ${preview.objective}`,
    `Policy: ${result.policyPresent ? result.policyPath : "(none)"}`,
    `Data dir: ${result.dataDir}`,
    `Steps (${steps.length}):`,
    ...steps.map(
      (step) =>
        `  ${step.order}. ${step.stepId} (${step.kind}) -> ${step.executor} [${
          step.required ? "required" : "optional"
        }, ${step.state}]`
    ),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowImportSuccess(
  parsed: { json: boolean },
  io: CliIo,
  result: {
    dataDir: string;
    artifactPath: string;
    summary: PersistWorkflowRunImportSummary;
    importResult: WorkflowRunImport;
    recovery: ReconcileWorkflowRunManualRecoveryResult;
    recoveryState: WorkflowRunManualRecoveryState | undefined;
  }
): number {
  const { summary, importResult } = result;
  const needsManualRecovery =
    result.recoveryState?.needsManualRecovery ?? false;
  const recoveryOutcome = result.recovery.ok ? result.recovery : null;
  const marked =
    recoveryOutcome !== null &&
    (recoveryOutcome.outcome === "marked" ||
      recoveryOutcome.outcome === "artifact_write_failed")
      ? recoveryOutcome
      : null;
  const payload = {
    ok: true,
    command: "workflow import",
    dataDir: result.dataDir,
    path: result.artifactPath,
    runId: summary.runId,
    source: summary.source,
    state: summary.state,
    inserted: summary.inserted,
    approvalBoundary: summary.approvalBoundary,
    counts: {
      steps: summary.stepCount,
      approvals: summary.approvalCount,
      diagnostics: importResult.diagnostics.length
    },
    diagnostics: importResult.diagnostics.map((diagnostic) => ({
      ...diagnostic
    })),
    monitor: importResult.monitor === null ? null : { ...importResult.monitor },
    needsManualRecovery,
    recovery:
      marked === null
        ? null
        : {
            code: marked.recoveryCode,
            stepId: marked.stepId,
            reason: marked.reason,
            artifactPath: marked.artifactPath,
            artifactWriteError:
              marked.outcome === "artifact_write_failed"
                ? { ...marked.artifactWriteError }
                : null
          }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow import: ${result.artifactPath}`,
    `Run: ${summary.runId} (${summary.source})`,
    `State: ${summary.state}`,
    `Inserted: ${summary.inserted ? "yes" : "no (upsert)"}`,
    `Steps: ${summary.stepCount}`,
    `Approvals: ${summary.approvalCount}`,
    `Diagnostics: ${importResult.diagnostics.length}`,
    marked !== null
      ? marked.outcome === "artifact_write_failed"
        ? `Manual recovery: required (${marked.recoveryCode}); recovery.md write failed: ${marked.artifactWriteError.message}`
        : `Manual recovery: required (${marked.recoveryCode}) -> ${marked.artifactPath}`
      : needsManualRecovery
        ? "Manual recovery: flagged (clear explicitly once resolved)"
        : "Manual recovery: not required",
    `Data dir: ${result.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowImportFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: Omit<WorkflowRendererFailure, "command"> & {
    command?: "workflow import";
  }
): number {
  return emitWorkflowFailure(parsed, io, {
    ...failure,
    command: "workflow import"
  });
}

export function emitWorkflowStatusList(
  parsed: {
    json: boolean;
    state?: string;
    filter?: string;
  },
  io: CliIo,
  dataDir: string,
  summaries: WorkflowRunSummary[]
): number {
  const payload = {
    ok: true,
    command: "workflow status",
    dataDir,
    state: parsed.state ?? null,
    filter: parsed.filter ?? null,
    count: summaries.length,
    runs: summaries.map(summaryToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Workflow runs: ${summaries.length}`);
  lines.push(`State: ${parsed.state ?? "(any)"}`);
  lines.push(`Filter: ${parsed.filter ?? "(none)"}`);
  lines.push(`Data dir: ${dataDir}`);
  if (summaries.length === 0) {
    lines.push("- (no matching runs)");
  } else {
    for (const summary of summaries) {
      lines.push(
        `- ${summary.run.runId} [${summary.run.state}] steps=${summary.counts.steps}` +
          ` approvals=${summary.counts.approvals} leases=${summary.counts.leases}` +
          ` next=${summary.monitor.nextAction.code}` +
          (summary.monitor.recovery
            ? ` recovery=${summary.monitor.recovery.code}`
            : "")
      );
    }
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowStatusDetail(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  detail: WorkflowRunDetail
): number {
  const payload = {
    ok: true,
    command: "workflow status",
    dataDir,
    run: workflowRunToJsonShape(detail.run),
    steps: detail.steps.map(workflowStepToJsonShape),
    approvals: detail.approvals.map(workflowApprovalToJsonShape),
    leases: detail.leases.map(workflowLeaseToJsonShape),
    monitor: workflowMonitorToJsonShape(detail.monitor),
    evidence: detail.evidence.map(workflowEvidenceToJsonShape),
    gates: detail.gates.map(workflowGateToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowDetailText(dataDir, detail));
  return 0;
}

export function emitWorkflowStatusFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunList(
  parsed: {
    json: boolean;
    state?: string;
    filter?: string;
    approvalBoundary?: string;
    repo?: string;
    issueScope?: string;
    updatedSince?: number;
    updatedUntil?: number;
  },
  io: CliIo,
  dataDir: string,
  summaries: WorkflowRunSummary[]
): number {
  const payload = {
    ok: true,
    command: "workflow run list",
    dataDir,
    state: parsed.state ?? null,
    filter: parsed.filter ?? null,
    approvalBoundary: parsed.approvalBoundary ?? null,
    repoPath: parsed.repo ?? null,
    issueScope: parsed.issueScope ?? null,
    updatedSince: parsed.updatedSince ?? null,
    updatedUntil: parsed.updatedUntil ?? null,
    count: summaries.length,
    runs: summaries.map(summaryToJsonShape)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Workflow runs: ${summaries.length}`);
  lines.push(`State: ${parsed.state ?? "(any)"}`);
  lines.push(`Filter: ${parsed.filter ?? "(any)"}`);
  lines.push(`Approval boundary: ${parsed.approvalBoundary ?? "(any)"}`);
  lines.push(`Repo: ${parsed.repo ?? "(any)"}`);
  lines.push(`Issue scope: ${parsed.issueScope ?? "(any)"}`);
  lines.push(
    `Updated since: ${parsed.updatedSince === undefined ? "(any)" : String(parsed.updatedSince)}`
  );
  lines.push(
    `Updated until: ${parsed.updatedUntil === undefined ? "(any)" : String(parsed.updatedUntil)}`
  );
  lines.push(`Data dir: ${dataDir}`);
  if (summaries.length === 0) {
    lines.push("- (no matching runs)");
  } else {
    for (const summary of summaries) {
      const repoSegment = `repo=${summary.run.repoPath ?? "(none)"}`;
      lines.push(
        `- ${summary.run.runId} [${summary.run.state}] ${repoSegment}` +
          ` steps=${summary.counts.steps}` +
          ` approvals=${summary.counts.approvals} leases=${summary.counts.leases}` +
          ` next=${summary.monitor.nextAction.code}` +
          (summary.monitor.recovery
            ? ` recovery=${summary.monitor.recovery.code}`
            : "")
      );
    }
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunListFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunApproveSuccess(
  parsed: { json: boolean },
  io: CliIo,
  payload: {
    ok: true;
    command: "workflow run approve";
    dataDir: string;
    runId: string;
    boundary: string;
    phrase: string;
    actor: string | null;
    artifactPath: string;
    artifactDigest: string;
    recordedAt: number;
  },
  artifactPath: string | undefined
): number {
  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines = [
    `Workflow run approval recorded for ${payload.runId}`,
    `Boundary: ${payload.boundary}`,
    `Phrase: ${payload.phrase}`,
    `Actor: ${payload.actor ?? "(unset)"}`,
    `Artifact: ${artifactPath ?? "(inline/implicit)"}`,
    `Data dir: ${payload.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunApproveFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunDecideSuccess(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  resolved: {
    gateId: string;
    workflowRunId: string;
    targetScope: string;
    gateType: string;
    chosenAction: string | null;
    resolvedBy: string | null;
    resolutionMode: string | null;
    resolution: string | null;
    resolvedAt: number | null;
    allowedActions: readonly string[];
  }
): number {
  const payload = {
    ok: true,
    command: "workflow run decide",
    dataDir,
    gateId: resolved.gateId,
    runId: resolved.workflowRunId,
    targetScope: resolved.targetScope,
    gateType: resolved.gateType,
    chosenAction: resolved.chosenAction,
    resolvedBy: resolved.resolvedBy,
    mode: resolved.resolutionMode,
    resolution: resolved.resolution,
    resolvedAt: resolved.resolvedAt,
    allowedActions: resolved.allowedActions
  };
  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }
  const lines = [
    `Workflow gate resolved: ${resolved.gateId}`,
    `Run: ${resolved.workflowRunId}`,
    `Scope: ${resolved.targetScope} (${resolved.gateType})`,
    `Action: ${resolved.chosenAction}`,
    `Resolved by: ${resolved.resolvedBy} (${resolved.resolutionMode})`,
    `Note: ${resolved.resolution ?? "(none)"}`,
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunDecideFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunUpdateStepSuccess(
  parsed: { json: boolean },
  io: CliIo,
  resultPayload: Record<string, unknown>,
  input: {
    runId: string;
    stepId: string;
    targetState: string;
    reason: string;
    actor: string | null;
    dataDir: string;
  }
): number {
  if (parsed.json) {
    writeJson(io.stdout, resultPayload);
    return 0;
  }

  const lines = [
    `Workflow step updated for ${input.runId}`,
    `Step: ${input.stepId}`,
    `State: ${String(resultPayload["previousState"])} -> ${input.targetState}`,
    `Run state: ${String(resultPayload["runState"])}`,
    `Reason: ${input.reason}`,
    `Actor: ${input.actor ?? "(unset)"}`,
    `Data dir: ${input.dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunUpdateStepFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunClearRecovery(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  runId: string,
  result: ClearWorkflowRunManualRecoveryGuardedResult
): number {
  if (!result.ok) {
    const payload: Record<string, unknown> = {
      ok: false,
      command: "workflow run clear-recovery",
      code: result.reason,
      message: result.message,
      runId,
      dataDir
    };
    if (result.recoveryCode !== undefined) {
      payload["recoveryCode"] = result.recoveryCode;
    }
    if (result.blockingStepId !== undefined && result.blockingStepId !== null) {
      payload["blockingStepId"] = result.blockingStepId;
    }
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.message}\n`);
    return 1;
  }

  const payload: Record<string, unknown> = {
    ok: true,
    command: "workflow run clear-recovery",
    runId: result.runId,
    dataDir,
    previousReason: result.previousReason,
    previousMarkedAt: result.previousMarkedAt,
    clearedAt: result.clearedAt
  };
  if (result.retryPrepared !== undefined) {
    payload["retryPrepared"] = result.retryPrepared;
  }

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Manual recovery cleared for run: ${result.runId}`,
    `Previous reason: ${result.previousReason ?? "(unset)"}`,
    `Previous marked at: ${result.previousMarkedAt ?? "(unset)"}`,
    `Cleared at: ${result.clearedAt}`,
    ...(result.retryPrepared !== undefined
      ? [
          `Retry prepared: ${result.retryPrepared.stepId} (${result.retryPrepared.recoveryCode})`
        ]
      : []),
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

export function emitWorkflowRunClearRecoveryFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: Omit<WorkflowRendererFailure, "command"> & {
    command?: "workflow run clear-recovery";
  }
): number {
  return emitWorkflowFailure(parsed, io, {
    ...failure,
    command: "workflow run clear-recovery"
  });
}

export function emitWorkflowRunMonitor(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  envelope: WorkflowMonitorEnvelope
): number {
  const payload = {
    ok: true,
    command: "workflow run monitor",
    dataDir,
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    runId: envelope.runId,
    runState: envelope.runState,
    stepState: envelope.stepState,
    terminal: envelope.terminal,
    blocked: envelope.blocked,
    needsManualRecovery: envelope.needsManualRecovery,
    disposition: envelope.disposition,
    reportable: envelope.reportable,
    reportReason: envelope.reportReason,
    activeStep: envelope.activeStep
      ? {
          stepId: envelope.activeStep.stepId,
          kind: envelope.activeStep.kind,
          state: envelope.activeStep.state,
          order: envelope.activeStep.order,
          required: envelope.activeStep.required
        }
      : null,
    leases: envelope.leases.map((lease) => ({
      leaseKind: lease.leaseKind,
      holder: lease.holder,
      classification: lease.classification,
      expiresAt: lease.expiresAt,
      heartbeatAt: lease.heartbeatAt,
      releasedAt: lease.releasedAt
    })),
    lastCheckpoint: envelope.lastCheckpoint
      ? {
          stepId: envelope.lastCheckpoint.stepId,
          at: envelope.lastCheckpoint.at,
          source: envelope.lastCheckpoint.source,
          digest: envelope.lastCheckpoint.digest
        }
      : null,
    monitorDrift: envelope.monitorDrift
      ? {
          advisoryState: envelope.monitorDrift.advisoryState,
          advisoryTerminal: envelope.monitorDrift.advisoryTerminal,
          actualState: envelope.monitorDrift.actualState,
          drifted: envelope.monitorDrift.drifted,
          reason: envelope.monitorDrift.reason
        }
      : null,
    nextAction: {
      code: envelope.nextAction.code,
      stepId: envelope.nextAction.stepId,
      leaseKind: envelope.nextAction.leaseKind,
      detail: envelope.nextAction.detail
    },
    recovery: envelope.recovery
      ? {
          code: envelope.recovery.code,
          message: envelope.recovery.message,
          stepId: envelope.recovery.stepId
        }
      : null,
    evidence: envelope.evidence.map(workflowEvidenceToJsonShape),
    gates: envelope.gates.map(workflowGateToJsonShape),
    counts: {
      steps: envelope.counts.steps,
      stepsByState: envelope.counts.stepsByState,
      approvals: envelope.counts.approvals,
      leases: envelope.counts.leases,
      gates: envelope.counts.gates,
      gatesOpen: envelope.counts.gatesOpen
    }
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowMonitorText(dataDir, envelope));
  return 0;
}

export function emitWorkflowRunMonitorFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: Omit<WorkflowRendererFailure, "command"> & {
    command?: "workflow run monitor";
  }
): number {
  return emitWorkflowFailure(parsed, io, {
    ...failure,
    command: "workflow run monitor"
  });
}

export function emitWorkflowHandoff(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  envelope: WorkflowHandoffEnvelope
): number {
  const payload = {
    ok: true,
    command: "workflow handoff",
    dataDir,
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    run: workflowRunToJsonShape(envelope.detail.run),
    steps: envelope.detail.steps.map(workflowStepToJsonShape),
    approvals: envelope.detail.approvals.map(workflowApprovalToJsonShape),
    leases: envelope.detail.leases.map(workflowLeaseToJsonShape),
    monitor: workflowMonitorToJsonShape(envelope.detail.monitor),
    evidence: envelope.detail.evidence.map(workflowEvidenceToJsonShape),
    gates: envelope.detail.gates.map(workflowGateToJsonShape),
    nextAction: nextActionToJsonShape(envelope.detail.monitor)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowHandoffText(dataDir, envelope));
  return 0;
}

export function emitWorkflowHandoffFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  return emitWorkflowFailure(parsed, io, failure);
}

export function emitWorkflowRunLogs(
  parsed: { json: boolean },
  io: CliIo,
  dataDir: string,
  envelope: WorkflowRunLogsEnvelope
): number {
  const payload = {
    ok: true,
    command: "workflow run logs",
    dataDir,
    schemaVersion: envelope.schemaVersion,
    generatedAt: envelope.generatedAt,
    run: workflowRunToJsonShape(envelope.detail.run),
    steps: envelope.detail.steps.map(workflowStepToJsonShape),
    approvals: envelope.detail.approvals.map(workflowApprovalToJsonShape),
    leases: envelope.detail.leases.map(workflowLeaseToJsonShape),
    monitor: workflowMonitorToJsonShape(envelope.detail.monitor),
    evidence: envelope.detail.evidence.map(workflowEvidenceToJsonShape),
    gates: envelope.detail.gates.map(workflowGateToJsonShape),
    rounds: envelope.rounds.map(workflowRoundToJsonShape),
    nextAction: nextActionToJsonShape(envelope.detail.monitor)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderWorkflowRunLogsText(dataDir, envelope));
  return 0;
}

export function emitWorkflowRunLogsFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: Omit<WorkflowRendererFailure, "command"> & {
    command?: "workflow run logs";
  }
): number {
  return emitWorkflowFailure(parsed, io, {
    ...failure,
    command: "workflow run logs"
  });
}

export function workflowRoundToJsonShape(
  round: WorkflowRunLogRound
): Record<string, unknown> {
  return {
    roundId: round.roundId,
    invocationId: round.invocationId,
    stepRunId: round.stepRunId,
    stepKey: round.stepKey,
    executorFamily: round.executorFamily,
    attempt: round.attempt,
    roundIndex: round.roundIndex,
    state: round.state,
    classification: round.classification,
    startedAt: round.startedAt,
    heartbeatAt: round.heartbeatAt,
    finishedAt: round.finishedAt,
    agentProvider: round.agentProvider,
    model: round.model,
    effort: round.effort,
    inputDigest: round.inputDigest,
    resultDigest: round.resultDigest,
    artifactRoot: round.artifactRoot,
    logPaths: round.logPaths,
    summary: round.summary,
    keyChanges: round.keyChanges,
    remainingWork: round.remainingWork,
    changedFiles: round.changedFiles,
    verificationStatus: round.verificationStatus,
    commitSha: round.commitSha,
    recoveryCode: round.recoveryCode,
    humanGate: round.humanGate,
    artifacts: round.artifacts.map((artifact) => ({ ...artifact })),
    checkpoints: round.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    findings: round.findings.map((finding) => ({ ...finding })),
    decisions: round.decisions.map((decision) => ({ ...decision }))
  };
}

export function renderWorkflowRunLogsText(
  dataDir: string,
  envelope: WorkflowRunLogsEnvelope
): string {
  const lines: string[] = [];
  lines.push(`Workflow run logs: ${envelope.detail.run.runId}`);
  lines.push(`Schema version: ${envelope.schemaVersion}`);
  lines.push(`Generated at (epoch ms): ${envelope.generatedAt}`);
  lines.push(`Run state: ${envelope.detail.run.state}`);
  lines.push(`Steps: ${envelope.detail.steps.length}`);
  lines.push(`Approvals: ${envelope.detail.approvals.length}`);
  lines.push(`Leases: ${envelope.detail.leases.length}`);
  const openGates = envelope.detail.gates.filter(
    (gate) => gate.resolvedAt === null
  );
  lines.push(
    `Gates: ${envelope.detail.gates.length} (open: ${openGates.length})`
  );
  for (const gate of openGates) {
    lines.push(
      `- ${gate.gateId} [${gate.targetScope}/${gate.gateType}] OPEN` +
        ` allowed=${gate.allowedActions.join(",")}` +
        (gate.recommendedAction !== null
          ? ` recommended=${gate.recommendedAction}`
          : "")
    );
  }
  lines.push(`Executor rounds: ${envelope.rounds.length}`);
  for (const round of envelope.rounds) {
    lines.push(
      `- ${round.roundId} [${round.stepKey}/${round.state}]` +
        (round.classification !== null ? ` ${round.classification}` : "")
    );
    if (round.summary !== null) {
      lines.push(`    summary: ${round.summary}`);
    }
    lines.push(
      `    verification: ${round.verificationStatus ?? "(none)"}` +
        ` commit: ${round.commitSha ?? "(none)"}` +
        (round.recoveryCode !== null
          ? ` recovery: ${round.recoveryCode}`
          : "")
    );
    if (round.logPaths.length > 0) {
      lines.push(`    logs: ${round.logPaths.join(", ")}`);
    }
    if (round.changedFiles.length > 0) {
      lines.push(`    changed files: ${round.changedFiles.join(", ")}`);
    }
    const childEvidenceCount =
      round.artifacts.length +
      round.checkpoints.length +
      round.findings.length +
      round.decisions.length;
    if (childEvidenceCount > 0) {
      lines.push(`    child evidence: ${childEvidenceCount}`);
    }
    if (round.artifacts.length > 0) {
      lines.push(
        `    artifacts: ${round.artifacts.map((artifact) => artifact.path).join(", ")}`
      );
    }
    if (round.checkpoints.length > 0) {
      lines.push(
        `    checkpoints: ${round.checkpoints
          .map((checkpoint) => `${checkpoint.sequence}:${checkpoint.stage}`)
          .join(", ")}`
      );
    }
    if (round.findings.length > 0) {
      lines.push(
        `    findings: ${round.findings.map((finding) => finding.title).join(", ")}`
      );
    }
    if (round.decisions.length > 0) {
      lines.push(
        `    decisions: ${round.decisions
          .map((decision) => decision.summary)
          .join(", ")}`
      );
    }
  }
  lines.push(`Evidence records: ${envelope.detail.evidence.length}`);
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");
  return lines.join("\n");
}

function emitWorkflowFailure(
  parsed: { json: boolean },
  io: CliIo,
  failure: WorkflowRendererFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.runId !== undefined) payload["runId"] = failure.runId;
  if (failure.path !== undefined) payload["path"] = failure.path;
  if (failure.boundary !== undefined) payload["boundary"] = failure.boundary;
  if (failure.stepId !== undefined) payload["stepId"] = failure.stepId;
  if (failure.gateId !== undefined) payload["gateId"] = failure.gateId;
  if (failure.errors !== undefined) {
    payload["errors"] = failure.errors.map((error) => ({ ...error }));
  }
  if (failure.diagnostics !== undefined) {
    payload["diagnostics"] = failure.diagnostics.map((diagnostic) => ({
      ...diagnostic
    }));
  } else if (failure.command === "workflow import") {
    payload["diagnostics"] = [];
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

export function summaryToJsonShape(
  summary: WorkflowRunSummary
): Record<string, unknown> {
  return {
    run: workflowRunToJsonShape(summary.run),
    counts: {
      steps: summary.counts.steps,
      stepsByState: summary.counts.stepsByState,
      approvals: summary.counts.approvals,
      leases: summary.counts.leases
    },
    monitor: workflowMonitorToJsonShape(summary.monitor)
  };
}

export function workflowRunToJsonShape(run: WorkflowRunRow): Record<string, unknown> {
  return {
    runId: run.runId,
    state: run.state,
    source: run.source,
    sourceArtifactPath: run.sourceArtifactPath,
    repoPath: run.repoPath,
    objective: run.objective,
    issueScope: run.issueScope,
    route: run.route,
    approvalBoundary: run.approvalBoundary,
    skillRevision: run.skillRevision,
    goalId: run.goalId,
    batchGroup: run.batchGroup,
    batchRole: run.batchRole,
    needsManualRecovery: run.needsManualRecovery,
    manualRecoveryReason: run.manualRecoveryReason,
    manualRecoveryAt: run.manualRecoveryAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

export function workflowStepToJsonShape(
  step: WorkflowStepRow
): Record<string, unknown> {
  return {
    runId: step.runId,
    stepId: step.stepId,
    kind: step.kind,
    state: step.state,
    order: step.order,
    required: step.required,
    ledgerOffset: step.ledgerOffset,
    resultDigest: step.resultDigest,
    errorCode: step.errorCode,
    errorMessage: step.errorMessage,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt
  };
}

export function workflowApprovalToJsonShape(
  approval: WorkflowApprovalRow
): Record<string, unknown> {
  return {
    runId: approval.runId,
    boundary: approval.boundary,
    actor: approval.actor,
    phrase: approval.phrase,
    artifactPath: approval.artifactPath,
    artifactDigest: approval.artifactDigest,
    recordedAt: approval.recordedAt,
    dischargedAt: approval.dischargedAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt
  };
}

export function workflowLeaseToJsonShape(
  lease: WorkflowLeaseRow
): Record<string, unknown> {
  return {
    runId: lease.runId,
    leaseKind: lease.leaseKind,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt,
    releasedAt: lease.releasedAt,
    stalePolicy: lease.stalePolicy,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt
  };
}

export function workflowMonitorToJsonShape(
  monitor: WorkflowMonitorState
): Record<string, unknown> {
  return {
    runId: monitor.runId,
    runState: monitor.runState,
    terminal: monitor.terminal,
    blocked: monitor.blocked,
    activeStep: monitor.activeStep
      ? {
          stepId: monitor.activeStep.stepId,
          kind: monitor.activeStep.kind,
          state: monitor.activeStep.state,
          order: monitor.activeStep.order,
          required: monitor.activeStep.required
        }
      : null,
    leases: monitor.leases.map((lease) => ({
      leaseKind: lease.leaseKind,
      holder: lease.holder,
      classification: lease.classification,
      expiresAt: lease.expiresAt,
      heartbeatAt: lease.heartbeatAt,
      releasedAt: lease.releasedAt
    })),
    lastCheckpoint: monitor.lastCheckpoint
      ? {
          stepId: monitor.lastCheckpoint.stepId,
          at: monitor.lastCheckpoint.at,
          source: monitor.lastCheckpoint.source,
          digest: monitor.lastCheckpoint.digest
        }
      : null,
    monitorDrift: monitor.monitorDrift
      ? {
          advisoryState: monitor.monitorDrift.advisoryState,
          advisoryTerminal: monitor.monitorDrift.advisoryTerminal,
          actualState: monitor.monitorDrift.actualState,
          drifted: monitor.monitorDrift.drifted,
          reason: monitor.monitorDrift.reason
        }
      : null,
    nextAction: nextActionToJsonShape(monitor),
    needsRecoveryArtifact: monitor.needsRecoveryArtifact,
    recovery: monitor.recovery
      ? {
          code: monitor.recovery.code,
          message: monitor.recovery.message,
          stepId: monitor.recovery.stepId
        }
      : null
  };
}

export function nextActionToJsonShape(
  monitor: WorkflowMonitorState
): Record<string, unknown> {
  return {
    code: monitor.nextAction.code,
    stepId: monitor.nextAction.stepId,
    leaseKind: monitor.nextAction.leaseKind,
    detail: monitor.nextAction.detail
  };
}

export function workflowEvidenceToJsonShape(
  evidence: WorkflowEvidenceLink
): Record<string, unknown> {
  return {
    evidenceRecordId: evidence.evidenceRecordId,
    source: evidence.source,
    type: evidence.type,
    artifactPath: evidence.artifactPath,
    occurredAt: evidence.occurredAt,
    summary: evidence.summary,
    runId: evidence.runId,
    stepId: evidence.stepId
  };
}

export function workflowGateToJsonShape(
  gate: WorkflowGateRecord
): Record<string, unknown> {
  return {
    gateId: gate.gateId,
    workflowRunId: gate.workflowRunId,
    stepRunId: gate.stepRunId,
    invocationId: gate.invocationId,
    roundId: gate.roundId,
    targetScope: gate.targetScope,
    gateType: gate.gateType,
    reason: gate.reason,
    evidence: gate.evidence,
    allowedActions: gate.allowedActions,
    recommendedAction: gate.recommendedAction,
    policyEnvelope: gate.policyEnvelope,
    open: gate.resolvedAt === null,
    resolvedAt: gate.resolvedAt,
    resolvedBy: gate.resolvedBy,
    resolutionMode: gate.resolutionMode,
    chosenAction: gate.chosenAction,
    resolution: gate.resolution
  };
}

export function renderWorkflowDetailText(
  dataDir: string,
  detail: WorkflowRunDetail
): string {
  const lines: string[] = [];
  lines.push(`Workflow run: ${detail.run.runId}`);
  lines.push(`State: ${detail.run.state}`);
  lines.push(`Source: ${detail.run.source}`);
  if (detail.run.objective !== null) {
    lines.push(`Objective: ${detail.run.objective}`);
  }
  if (detail.run.repoPath !== null) {
    lines.push(`Repo: ${detail.run.repoPath}`);
  }
  if (detail.run.approvalBoundary !== null) {
    lines.push(`Approval boundary: ${detail.run.approvalBoundary}`);
  }
  if (detail.run.sourceArtifactPath !== null) {
    lines.push(`Artifact dir: ${detail.run.sourceArtifactPath}`);
  }
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");

  lines.push(`Steps: ${detail.steps.length}`);
  for (const step of detail.steps) {
    lines.push(
      `- ${step.stepId} [${step.state}] kind=${step.kind} ` +
        `order=${step.order} required=${step.required ? "yes" : "no"}` +
        (step.errorCode ? ` error=${step.errorCode}` : "")
    );
  }
  lines.push("");

  lines.push(`Approvals: ${detail.approvals.length}`);
  for (const approval of detail.approvals) {
    lines.push(
      `- ${approval.boundary} actor=${approval.actor ?? "(unknown)"} ` +
        `recorded=${approval.recordedAt}` +
        (approval.dischargedAt !== null
          ? ` discharged=${approval.dischargedAt}`
          : "")
    );
  }
  lines.push("");

  lines.push(`Leases: ${detail.leases.length}`);
  for (const lease of detail.leases) {
    lines.push(
      `- ${lease.leaseKind} holder=${lease.holder} stale_policy=${lease.stalePolicy} ` +
        `expires=${lease.expiresAt} heartbeat=${lease.heartbeatAt}` +
        (lease.releasedAt !== null ? ` released=${lease.releasedAt}` : "")
    );
  }
  lines.push("");

  lines.push("Monitor");
  lines.push(`- Run state: ${detail.monitor.runState}`);
  lines.push(`- Terminal: ${detail.monitor.terminal ? "yes" : "no"}`);
  lines.push(`- Blocked: ${detail.monitor.blocked ? "yes" : "no"}`);
  if (detail.monitor.activeStep) {
    lines.push(
      `- Active step: ${detail.monitor.activeStep.stepId} (${detail.monitor.activeStep.state})`
    );
  } else {
    lines.push("- Active step: (none)");
  }
  if (detail.monitor.lastCheckpoint) {
    lines.push(
      `- Last checkpoint: ${detail.monitor.lastCheckpoint.stepId} ` +
        `at ${detail.monitor.lastCheckpoint.at} (source=${detail.monitor.lastCheckpoint.source})`
    );
  } else {
    lines.push("- Last checkpoint: (none)");
  }
  lines.push(
    `- Next action: ${detail.monitor.nextAction.code} - ${detail.monitor.nextAction.detail}`
  );
  if (detail.monitor.recovery) {
    lines.push(
      `- Recovery: ${detail.monitor.recovery.code} - ${detail.monitor.recovery.message}`
    );
  }
  if (detail.monitor.monitorDrift?.drifted) {
    lines.push(
      `- Monitor drift: ${detail.monitor.monitorDrift.reason ?? "(unspecified)"}`
    );
  }
  lines.push("");

  lines.push(`Evidence: ${detail.evidence.length}`);
  for (const record of detail.evidence) {
    lines.push(
      `- ${record.evidenceRecordId} [${record.source}/${record.type}] ${record.summary}` +
        (record.stepId !== null ? ` step=${record.stepId}` : "")
    );
  }
  lines.push("");

  const openGateCount = detail.gates.filter(
    (gate) => gate.resolvedAt === null
  ).length;
  lines.push(`Gates: ${detail.gates.length} (open: ${openGateCount})`);
  for (const gate of detail.gates) {
    const status =
      gate.resolvedAt === null
        ? `OPEN allowed=${gate.allowedActions.join(",") || "(none)"}` +
          (gate.recommendedAction !== null
            ? ` recommended=${gate.recommendedAction}`
            : "")
        : `resolved by ${gate.resolvedBy ?? "(unknown)"} ` +
          `action=${gate.chosenAction ?? "(none)"} ` +
          `(${gate.resolutionMode ?? "?"})`;
    lines.push(
      `- ${gate.gateId} [${gate.targetScope}/${gate.gateType}] ${status}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderWorkflowHandoffText(
  dataDir: string,
  envelope: WorkflowHandoffEnvelope
): string {
  const lines: string[] = [];
  lines.push(`Workflow handoff: ${envelope.detail.run.runId}`);
  lines.push(`Schema version: ${envelope.schemaVersion}`);
  lines.push(`Generated at (epoch ms): ${envelope.generatedAt}`);
  lines.push("");
  lines.push(renderWorkflowDetailText(dataDir, envelope.detail));
  return lines.join("\n");
}

export function renderWorkflowMonitorText(
  dataDir: string,
  envelope: WorkflowMonitorEnvelope
): string {
  const lines: string[] = [];
  lines.push(`Workflow run monitor: ${envelope.runId}`);
  lines.push(`Schema version: ${envelope.schemaVersion}`);
  lines.push(`Run state: ${envelope.runState}`);
  lines.push(`Step state: ${envelope.stepState ?? "(none)"}`);
  lines.push(`Terminal: ${envelope.terminal}`);
  lines.push(`Blocked: ${envelope.blocked}`);
  lines.push(`Needs manual recovery: ${envelope.needsManualRecovery}`);
  lines.push(`Disposition: ${envelope.disposition}`);
  lines.push(`Reportable: ${envelope.reportable}`);
  lines.push(`Report reason: ${envelope.reportReason}`);
  lines.push(`Next action: ${envelope.nextAction.code}`);
  if (envelope.recovery) {
    lines.push(`Recovery: ${envelope.recovery.code}`);
  }
  if (envelope.activeStep) {
    lines.push(
      `Active step: ${envelope.activeStep.stepId} [${envelope.activeStep.state}]`
    );
  }
  lines.push(
    `Steps: ${envelope.counts.steps}` +
      ` approvals=${envelope.counts.approvals} leases=${envelope.counts.leases}`
  );
  lines.push(
    `Gates: ${envelope.counts.gates} (open: ${envelope.counts.gatesOpen})`
  );
  for (const gate of envelope.gates) {
    if (gate.resolvedAt !== null) continue;
    lines.push(
      `- ${gate.gateId} [${gate.targetScope}/${gate.gateType}] OPEN ` +
        `allowed=${gate.allowedActions.join(",") || "(none)"}` +
        (gate.recommendedAction !== null
          ? ` recommended=${gate.recommendedAction}`
          : "")
    );
  }
  lines.push(`Data dir: ${dataDir}`);
  lines.push("");
  return lines.join("\n");
}
