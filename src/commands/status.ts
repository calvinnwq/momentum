import { resolveDataDir, type DataDirOptions } from "../data-dir.js";
import { loadGoalLogs, type GoalLogsSuccess } from "../goal-logs.js";
import {
  loadGoalStatus,
  type GoalStatusExternalApply,
  type GoalStatusPendingIntentExternalApply,
  type GoalStatusPendingIntentSummary,
  type GoalStatusSuccess
} from "../goal-status.js";
import { writeHandoff, type HandoffSuccess } from "../handoff.js";
import type { UpdateIntentApplyPolicy } from "../momentum-policy.js";
import { intentApplyAuditToJsonShape } from "../renderers/intent.js";
import { usageError, write, writeJson, type CliIo } from "../renderers/cli-output.js";

type ParsedFlags = {
  args: string[];
  json: boolean;
  dataDir?: string;
  iteration?: number;
};

export function status(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (parsed.args.length > 2) {
    return usageError(`Unexpected argument for status: ${parsed.args[2]}`, parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: { goalId?: string; dataDirOptions: DataDirOptions } = {
    dataDirOptions
  };
  if (goalIdArg !== undefined) input.goalId = goalIdArg;

  const result = loadGoalStatus(input);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "status",
      code: result.code,
      message: result.error,
      goalId: goalIdArg ?? null
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  return emitStatus(parsed, io, result);
}

function emitStatus(
  parsed: ParsedFlags,
  io: CliIo,
  data: GoalStatusSuccess
): number {
  const payload = {
    ok: true,
    command: "status",
    goalId: data.goalId,
    title: data.title,
    state: data.state,
    goalState: data.goalState,
    repo: data.repo,
    branch: data.branch,
    runner: data.runner,
    runnerProfile: data.runnerProfile,
    maxIterations: data.maxIterations,
    currentIteration: data.currentIteration,
    completionReason: data.completionReason,
    verification: data.verification,
    verificationTimeoutSec: data.verificationTimeoutSec,
    dataDir: data.dataDir,
    artifactDir: data.artifactDir,
    artifactPaths: {
      goalMd: data.artifactPaths.goalMd,
      ledgerMd: data.artifactPaths.ledgerMd,
      handoffMd: data.artifactPaths.handoffMd,
      handoffJson: data.artifactPaths.handoffJson,
      recoveryMd: data.artifactPaths.recoveryMd,
      promptMd: data.artifactPaths.promptMd,
      runnerLog: data.artifactPaths.runnerLog,
      verificationLog: data.artifactPaths.verificationLog,
      resultJson: data.artifactPaths.resultJson
    },
    artifactFiles: data.artifactFiles,
    artifacts: data.artifacts,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    latestJob: data.latestJob,
    iteration: data.iteration,
    currentIterationDetail: data.currentIterationDetail,
    reducer: data.reducer,
    nextJob: data.nextJob,
    nextAction: data.nextAction,
    nextActionDetail: data.nextActionDetail,
    latestCommitSha: data.latestCommitSha,
    daemon: data.daemon,
    staleRecovery: data.staleRecovery,
    policy: data.policy,
    ...(data.sourceItems.length > 0 ? { sourceItems: data.sourceItems } : {}),
    ...(data.latestEvidence.length > 0
      ? { latestEvidence: data.latestEvidence }
      : {}),
    ...(data.pendingUpdateIntents.length > 0
      ? {
          totalPendingUpdateIntentCount: data.totalPendingUpdateIntentCount,
          truncatedPendingUpdateIntents: data.truncatedPendingUpdateIntents,
          pendingUpdateIntents: data.pendingUpdateIntents.map(
            (intent) => goalStatusPendingIntentToJsonShape(intent)
          ),
          intentStaleThresholdMs: data.intentStaleThresholdMs
        }
      : {}),
    externalApply: goalStatusExternalApplyToJsonShape(data.externalApply)
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Goal: ${data.goalId}`,
    `Title: ${data.title}`,
    `State: ${data.state}`,
    `Repo: ${data.repo ?? "(unset)"}`,
    `Branch: ${data.branch}`,
    `Runner: ${data.runner}`,
    ...(data.runnerProfile
      ? [
          `Runner profile: ${data.runnerProfile.name} (executes=${data.runnerProfile.executes ? "true" : "false"})`
        ]
      : []),
    `Artifact dir: ${data.artifactDir}`,
    `Recovery: ${data.artifactFiles.recoveryMd ? "present" : "missing"} (${data.artifactPaths.recoveryMd})`
  ];

  if (data.latestJob) {
    lines.push(
      `Job: ${data.latestJob.jobId} (${data.latestJob.state}, iteration ${data.latestJob.iteration})`
    );
  }

  if (data.iteration) {
    if (data.iteration.commitSha) {
      lines.push(`Commit: ${data.iteration.commitSha}`);
    }
    if (data.iteration.failure) {
      lines.push(
        `Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
      );
    }
  }

  if (data.reducer) {
    lines.push(
      `Reducer: ${data.reducer.decision} (iteration ${data.reducer.iteration})`
    );
    if (data.reducer.completionReason) {
      lines.push(`Completion reason: ${data.reducer.completionReason}`);
    }
  }

  if (data.nextAction) {
    lines.push(`Next: ${data.nextAction}`);
  }

  if (data.daemon) {
    const flags: string[] = [];
    if (data.daemon.isActive) flags.push("active");
    if (data.daemon.isTerminal) flags.push("terminal");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`Daemon: ${data.daemon.state}${flagStr} [${data.daemon.runId}]`);
    if (data.daemon.stopRequest) {
      lines.push(
        `Daemon stop requested: ${data.daemon.stopRequest.requestedAt} ` +
          `(${data.daemon.stopRequest.reason})`
      );
    }
    if (data.daemon.stopNowRequest) {
      lines.push(
        `Daemon stop-now requested: ${data.daemon.stopNowRequest.requestedAt} ` +
          `(${data.daemon.stopNowRequest.reason})`
      );
    }
    if (data.daemon.cancelOutcome) {
      lines.push(`Daemon cancel outcome: ${data.daemon.cancelOutcome.outcome}`);
    }
  }

  const sr = data.staleRecovery;
  if (
    sr.recoveredRepoLockCount > 0 ||
    sr.recoveredJobCount > 0 ||
    sr.staleRepoLockCount > 0 ||
    sr.staleClaimedJobCount > 0
  ) {
    lines.push(
      `Stale recovery: locks recovered=${sr.recoveredRepoLockCount} ` +
        `jobs recovered=${sr.recoveredJobCount} ` +
        `pending locks=${sr.staleRepoLockCount} ` +
        `pending jobs=${sr.staleClaimedJobCount}`
    );
  }

  const policy = data.policy;
  if (!policy.configured) {
    lines.push("Policy (MOMENTUM.md): repo path not set; discovery skipped");
  } else if (policy.error) {
    lines.push(
      `Policy (MOMENTUM.md): error ${policy.error.code} at ${policy.path ?? "(unresolved)"}`
    );
  } else if (policy.present) {
    const fields = describePolicyFields(policy);
    lines.push(
      `Policy (MOMENTUM.md): present at ${policy.path}${fields ? ` (${fields})` : ""}`
    );
  } else {
    lines.push(
      `Policy (MOMENTUM.md): not present (expected at ${policy.path ?? "(unresolved)"})`
    );
  }

  if (data.sourceItems.length > 0) {
    lines.push(`Source items: ${data.sourceItems.length}`);
    for (const item of data.sourceItems) {
      lines.push(
        `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""}`
      );
    }
  }

  if (data.latestEvidence.length > 0) {
    lines.push(`Latest evidence: ${data.latestEvidence.length}`);
    for (const record of data.latestEvidence) {
      lines.push(
        `- ${record.occurredAt} [${record.source}/${record.type}] ${record.summary}`
      );
    }
  }

  if (data.pendingUpdateIntents.length > 0) {
    const staleCount = data.pendingUpdateIntents.filter(
      (intent) => intent.stale
    ).length;
    const staleSuffix = staleCount > 0 ? ` (${staleCount} stale)` : "";
    const shownCount = data.pendingUpdateIntents.length;
    const totalCount = data.totalPendingUpdateIntentCount;
    const countLabel = data.truncatedPendingUpdateIntents
      ? `${shownCount}/${totalCount}`
      : `${shownCount}`;
    lines.push(
      `Pending update intents: ${countLabel}${staleSuffix}`
    );
    for (const intent of data.pendingUpdateIntents) {
      const staleFlag = intent.stale ? " STALE" : "";
      const latestText = intent.externalApply.latestAttempt
        ? ` latest=${intent.externalApply.latestAttempt.lifecycleState}`
        : "";
      lines.push(
        `- ${intent.intentId} [${intent.adapterKind}/${intent.intentType}] ` +
          `target=${intent.targetExternalId ?? "(none)"} ageMs=${intent.ageMs}${staleFlag}` +
          ` apply=${intent.externalApply.applyState}` +
          ` attempts=${intent.externalApply.totalAttempts}${latestText}: ${intent.reason}`
      );
    }
    if (data.truncatedPendingUpdateIntents) {
      lines.push(`... and ${totalCount - shownCount} more`);
    }
  }

  const externalApply = data.externalApply;
  const applyStateCounts = externalApply.pendingIntentApplyStateCounts;
  const auditCounts = externalApply.pendingAuditCounts;
  lines.push(
    `Pending external apply state: idle=${applyStateCounts.idle}, ` +
      `in_flight=${applyStateCounts.in_flight}, ` +
      `blocked=${applyStateCounts.blocked}`
  );
  lines.push(
    `Pending external apply audits: total=${externalApply.totalAttempts}, ` +
      `succeeded=${auditCounts.succeeded}, ` +
      `failed=${auditCounts.failed}, ` +
      `claimed=${auditCounts.claimed}, ` +
      `blocked=${auditCounts.blocked}, ` +
      `audit_incomplete=${auditCounts.audit_incomplete}`
  );
  const latestExternalApply = externalApply.latestAttempt;
  if (latestExternalApply) {
    lines.push(
      `Latest external apply: ${latestExternalApply.id} ${latestExternalApply.lifecycleState}` +
        ` intent=${latestExternalApply.intentId}` +
        ` (result=${latestExternalApply.resultStatus ?? "(none)"}` +
        ` code=${latestExternalApply.resultCode ?? "(none)"})`
    );
  } else {
    lines.push("Latest external apply: (none)");
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function goalStatusPendingIntentToJsonShape(
  intent: GoalStatusPendingIntentSummary
): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    adapterKind: intent.adapterKind,
    intentType: intent.intentType,
    targetExternalId: intent.targetExternalId,
    reason: intent.reason,
    goalId: intent.goalId,
    sourceItemId: intent.sourceItemId,
    evidenceRecordId: intent.evidenceRecordId,
    createdAt: intent.createdAt,
    ageMs: intent.ageMs,
    stale: intent.stale,
    externalApply: goalStatusPendingIntentExternalApplyToJsonShape(
      intent.externalApply
    )
  };
}

function goalStatusPendingIntentExternalApplyToJsonShape(
  external: GoalStatusPendingIntentExternalApply
): {
  applyState: GoalStatusPendingIntentExternalApply["applyState"];
  totalAttempts: number;
  counts: GoalStatusPendingIntentExternalApply["counts"];
  latestAttempt: Record<string, unknown> | null;
} {
  return {
    applyState: external.applyState,
    totalAttempts: external.totalAttempts,
    counts: external.counts,
    latestAttempt: external.latestAttempt
      ? intentApplyAuditToJsonShape(external.latestAttempt)
      : null
  };
}

function goalStatusExternalApplyToJsonShape(
  external: GoalStatusExternalApply
): {
  pendingIntentApplyStateCounts: GoalStatusExternalApply["pendingIntentApplyStateCounts"];
  pendingAuditCounts: GoalStatusExternalApply["pendingAuditCounts"];
  totalAttempts: number;
  latestAttempt:
    | ({ intentId: string } & ReturnType<typeof intentApplyAuditToJsonShape>)
    | null;
} {
  return {
    pendingIntentApplyStateCounts: external.pendingIntentApplyStateCounts,
    pendingAuditCounts: external.pendingAuditCounts,
    totalAttempts: external.totalAttempts,
    latestAttempt: external.latestAttempt
      ? {
          intentId: external.latestAttempt.intentId,
          ...intentApplyAuditToJsonShape(external.latestAttempt)
        }
      : null
  };
}

export function logs(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for logs.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for logs: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const input: {
    goalId: string;
    iteration?: number;
    dataDirOptions: DataDirOptions;
  } = { goalId: goalIdArg, dataDirOptions };
  if (parsed.iteration !== undefined) input.iteration = parsed.iteration;

  const result = loadGoalLogs(input);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "logs",
      code: result.code,
      message: result.error,
      goalId: goalIdArg
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  return emitLogs(parsed, io, result);
}

function emitLogs(
  parsed: ParsedFlags,
  io: CliIo,
  data: GoalLogsSuccess
): number {
  if (parsed.json) {
    const payload = {
      ok: true,
      command: "logs",
      goalId: data.goalId,
      iteration: data.iteration,
      availableIterations: data.availableIterations,
      dataDir: data.dataDir,
      artifactDir: data.artifactDir,
      iterationDir: data.iterationDir,
      runnerLog: {
        path: data.runnerLog.path,
        exists: data.runnerLog.exists,
        readable: data.runnerLog.readable,
        bytes: data.runnerLog.bytes,
        content: data.runnerLog.content,
        error: data.runnerLog.error
      },
      verificationLog: {
        path: data.verificationLog.path,
        exists: data.verificationLog.exists,
        readable: data.verificationLog.readable,
        bytes: data.verificationLog.bytes,
        content: data.verificationLog.content,
        error: data.verificationLog.error
      },
      resultJson: {
        path: data.resultJson.path,
        exists: data.resultJson.exists,
        readable: data.resultJson.readable,
        bytes: data.resultJson.bytes,
        content: data.resultJson.content,
        error: data.resultJson.error,
        parseError: data.resultJson.parseError
      },
      sourceItems: data.sourceItems,
      ...(data.latestEvidence.length > 0
        ? { latestEvidence: data.latestEvidence }
        : {})
    };
    writeJson(io.stdout, payload);
    return 0;
  }

  const sourceItemsLines: string[] = [];
  if (data.sourceItems.length > 0) {
    sourceItemsLines.push(`Source items: ${data.sourceItems.length}`);
    for (const item of data.sourceItems) {
      sourceItemsLines.push(
        `- ${item.id} [${item.adapterKind}] ${item.externalKey ?? item.externalId}: ` +
        `${item.title}${item.status ? ` (${item.status})` : ""}`
      );
    }
  }

  const evidenceLines: string[] = [];
  if (data.latestEvidence.length > 0) {
    evidenceLines.push(`Latest evidence: ${data.latestEvidence.length}`);
    for (const record of data.latestEvidence) {
      evidenceLines.push(
        `- ${record.occurredAt} [${record.source}/${record.type}] ${record.summary}`
      );
    }
  }

  const lines: string[] = [
    `Goal: ${data.goalId}`,
    `Iteration: ${data.iteration}`,
    `Available iterations: ${data.availableIterations.length === 0 ? "(none)" : data.availableIterations.join(", ")}`,
    `Iteration dir: ${data.iterationDir}`,
    ...sourceItemsLines,
    ...evidenceLines,
    "",
    `## runner.log (${data.runnerLog.exists ? `${data.runnerLog.bytes} bytes` : "missing"}): ${data.runnerLog.path}`
  ];
  if (data.runnerLog.error !== undefined) {
    lines.push(`(unreadable: ${data.runnerLog.error})`);
  } else if (data.runnerLog.exists && data.runnerLog.content.length > 0) {
    lines.push(data.runnerLog.content.endsWith("\n")
      ? data.runnerLog.content.slice(0, -1)
      : data.runnerLog.content);
  } else if (data.runnerLog.exists) {
    lines.push("(empty)");
  }
  lines.push("");
  lines.push(
    `## verification.log (${data.verificationLog.exists ? `${data.verificationLog.bytes} bytes` : "missing"}): ${data.verificationLog.path}`
  );
  if (data.verificationLog.error !== undefined) {
    lines.push(`(unreadable: ${data.verificationLog.error})`);
  } else if (data.verificationLog.exists && data.verificationLog.content.length > 0) {
    lines.push(data.verificationLog.content.endsWith("\n")
      ? data.verificationLog.content.slice(0, -1)
      : data.verificationLog.content);
  } else if (data.verificationLog.exists) {
    lines.push("(empty)");
  }
  lines.push("");
  lines.push(
    `## result.json (${data.resultJson.exists ? `${data.resultJson.bytes} bytes` : "missing"}): ${data.resultJson.path}`
  );
  if (data.resultJson.error !== undefined) {
    lines.push(`(unreadable: ${data.resultJson.error})`);
  } else if (data.resultJson.parseError !== undefined) {
    lines.push(`(parse error: ${data.resultJson.parseError})`);
  } else if (data.resultJson.exists && data.resultJson.content.length > 0) {
    lines.push(data.resultJson.content.endsWith("\n")
      ? data.resultJson.content.slice(0, -1)
      : data.resultJson.content);
  } else if (data.resultJson.exists) {
    lines.push("(empty)");
  }
  lines.push("");

  write(io.stdout, lines.join("\n"));
  return 0;
}

export function handoff(parsed: ParsedFlags, io: CliIo): number {
  const goalIdArg = parsed.args[1];
  if (!goalIdArg) {
    return usageError("Missing required <goal-id> for handoff.", parsed, io);
  }
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for handoff: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const result = writeHandoff({ goalId: goalIdArg, dataDirOptions });

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "handoff",
      code: result.code,
      message: result.error,
      goalId: goalIdArg
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  return emitHandoff(parsed, io, result);
}

function emitHandoff(
  parsed: ParsedFlags,
  io: CliIo,
  result: HandoffSuccess
): number {
  const { data } = result;
  const payload: Record<string, unknown> = {
    ok: true,
    command: "handoff",
    goalId: data.goal.id,
    title: data.goal.title,
    state: data.goal.state,
    currentIteration: data.goal.currentIteration,
    completionReason: data.goal.completionReason,
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    handoffMdPath: result.handoffMdPath,
    handoffJsonPath: result.handoffJsonPath,
    dataDir: data.goal.dataDir,
    artifactDir: data.goal.artifactDir,
    iteration: data.iteration,
    runnerResult: data.runnerResult,
    latestJob: data.latestJob,
    reducer: data.reducer,
    nextJob: data.nextJob,
    nextAction: data.nextAction,
    goalState: data.goalState,
    currentIterationDetail: data.currentIterationDetail,
    nextActionDetail: data.nextActionDetail,
    latestCommitSha: data.latestCommitSha,
    daemon: data.daemon,
    staleRecovery: data.staleRecovery,
    policy: data.policy
  };
  if (data.sourceItems.length > 0) {
    payload["sourceItems"] = data.sourceItems;
  }

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Handoff written for goal: ${data.goal.id}`,
    `Title: ${data.goal.title}`,
    `State: ${data.goal.state}`,
    `handoff.md: ${result.handoffMdPath}`,
    `handoff.json: ${result.handoffJsonPath}`
  ];

  if (data.iteration?.commitSha) {
    lines.push(`Commit: ${data.iteration.commitSha}`);
  }
  if (data.iteration?.failure) {
    lines.push(
      `Failure: ${data.iteration.failure.code} - ${data.iteration.failure.error}`
    );
  }

  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function describePolicyFields(payload: {
  config: {
    runner: string | null;
    verification: readonly string[] | null;
    verificationTimeoutSec: number | null;
    intentApplyPolicy?: UpdateIntentApplyPolicy | null;
  } | null;
  hasNotes: boolean;
}): string {
  if (!payload.config) return "";
  const parts: string[] = [];
  if (payload.config.runner) parts.push(`runner=${payload.config.runner}`);
  if (payload.config.verification) {
    parts.push(`verification=${payload.config.verification.length} cmd(s)`);
  }
  if (payload.config.verificationTimeoutSec !== null) {
    parts.push(`timeout_sec=${payload.config.verificationTimeoutSec}`);
  }
  if (payload.config.intentApplyPolicy) {
    parts.push(`intent_apply=${payload.config.intentApplyPolicy}`);
  }
  if (payload.hasNotes) parts.push("notes");
  return parts.join(", ");
}
