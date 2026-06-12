import { usageError, write, writeJson, type CliIo } from "../cli-io.js";
import { openDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS,
  PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT,
  buildProjectRollup,
  type ProjectRollup,
  type ProjectRollupExternalApply,
  type ProjectRollupFilters,
  type ProjectRollupOptions,
  type ProjectRollupPendingIntentExternalApply
} from "../../project-rollup.js";
import { intentApplyAuditToJsonShape } from "../intent/index.js";

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; source?: string; project?: string; staleThresholdHours?: number; intentStaleThresholdDays?: number; limit?: number; milestone?: string;
};

export function project(parsed: ParsedFlags, io: CliIo): number {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for project. Expected: status.",
      parsed,
      io
    );
  }
  if (subcommand === "status") {
    return projectStatus(parsed, io);
  }
  return usageError(`Unknown project subcommand: ${subcommand}`, parsed, io);
}

function projectStatus(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for project status: ${parsed.args[2]}`,
      parsed,
      io
    );
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitProjectStatusFailure(parsed, io, {
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const filters: ProjectRollupFilters = {};
  if (parsed.source !== undefined) filters.adapterKind = parsed.source;
  if (parsed.project !== undefined) {
    filters.projectId = parsed.project;
    filters.projectName = parsed.project;
  }
  if (parsed.milestone !== undefined) {
    filters.milestoneId = parsed.milestone;
    filters.milestoneName = parsed.milestone;
  }

  const options: ProjectRollupOptions = { filters };
  if (parsed.staleThresholdHours !== undefined) {
    options.reconciliationStaleThresholdMs = Math.round(
      parsed.staleThresholdHours * 60 * 60 * 1000
    );
  }
  if (parsed.intentStaleThresholdDays !== undefined) {
    options.intentStaleThresholdMs = Math.round(
      parsed.intentStaleThresholdDays * 24 * 60 * 60 * 1000
    );
  }

  const db = openDb(dataDir);
  let rollup: ProjectRollup;
  try {
    rollup = buildProjectRollup(db, options);
  } finally {
    db.close();
  }

  if (parsed.json) {
    const payload = {
      ok: true,
      command: "project status",
      dataDir,
      filters: {
        source: filters.adapterKind ?? null,
        projectId: filters.projectId ?? null,
        projectName: filters.projectName ?? null,
        milestoneId: filters.milestoneId ?? null,
        milestoneName: filters.milestoneName ?? null
      },
      staleThresholdMs: rollup.reconciliationStaleThresholdMs,
      intentStaleThresholdMs: rollup.intentStaleThresholdMs,
      generatedAt: rollup.generatedAt,
      counts: rollup.counts,
      sourceItems: rollup.sourceItems,
      totalSourceItemCount: rollup.totalSourceItemCount,
      truncatedSourceItems: rollup.truncatedSourceItems,
      mismatches: rollup.mismatches,
      totalMismatchCount: rollup.totalMismatchCount,
      truncatedMismatches: rollup.truncatedMismatches,
      reconciliationWarnings: rollup.reconciliationWarnings,
      pendingUpdateIntents: rollup.pendingUpdateIntents.map((intent) => ({
        ...intent,
        externalApply: projectRollupExternalApplyIntentToJsonShape(intent.externalApply)
      })),
      totalPendingUpdateIntentCount: rollup.totalPendingUpdateIntentCount,
      truncatedPendingUpdateIntents: rollup.truncatedPendingUpdateIntents,
      externalApply: projectRollupExternalApplyToJsonShape(rollup.externalApply),
      nextAction: rollup.nextAction
    };
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, renderProjectStatusText(rollup, filters, dataDir));
  return 0;
}

function projectRollupExternalApplyIntentToJsonShape(
  external: ProjectRollupPendingIntentExternalApply
): {
  applyState: ProjectRollupPendingIntentExternalApply["applyState"];
  totalAttempts: number;
  counts: ProjectRollupPendingIntentExternalApply["counts"];
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

function projectRollupExternalApplyToJsonShape(
  external: ProjectRollupExternalApply
): {
  pendingIntentApplyStateCounts: ProjectRollupExternalApply["pendingIntentApplyStateCounts"];
  pendingAuditCounts: ProjectRollupExternalApply["pendingAuditCounts"];
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

function renderProjectStatusText(
  rollup: ProjectRollup,
  filters: ProjectRollupFilters,
  dataDir: string
): string {
  const lines: string[] = ["Project status"];
  lines.push(
    `Filters: source=${filters.adapterKind ?? "(any)"} project=${
      filters.projectId ?? filters.projectName ?? "(any)"
    } milestone=${filters.milestoneId ?? filters.milestoneName ?? "(any)"}`
  );
  lines.push(`Data dir: ${dataDir}`);
  lines.push(
    `Source items: ${rollup.counts.sourceItems.total} ` +
      `(linked=${rollup.counts.sourceItems.linkedToGoal}, unlinked=${rollup.counts.sourceItems.unlinked})`
  );
  const statusSummary = Object.entries(rollup.counts.sourceItems.byStatus)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  if (statusSummary.length > 0) {
    lines.push(`Source status: ${statusSummary}`);
  }
  const goalSummary = Object.entries(rollup.counts.goals.byState)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([state, count]) => `${state}=${count}`)
    .join(", ");
  lines.push(
    `Goals: total=${rollup.counts.goals.total}` +
      (goalSummary.length > 0 ? ` (${goalSummary})` : "") +
      `, manual_recovery=${rollup.counts.goals.needingManualRecovery}`
  );
  lines.push(
    `Evidence: total=${rollup.counts.evidence.totalRecords}, ` +
      `goals_with_evidence=${rollup.counts.evidence.goalsWithEvidence}, ` +
      `goals_without_evidence=${rollup.counts.evidence.goalsWithoutEvidence}`
  );
  lines.push(
    `Mismatches: source_done_goal_not_terminal=${rollup.counts.mismatches.source_done_goal_not_terminal}, ` +
      `goal_done_source_not_done=${rollup.counts.mismatches.goal_done_source_not_done}, ` +
      `evidence_missing_after_completion=${rollup.counts.mismatches.evidence_missing_after_completion}, ` +
      `manual_recovery_required=${rollup.counts.mismatches.manual_recovery_required}`
  );
  lines.push(
    `Pending external update intents: ${rollup.counts.pendingUpdateIntents} ` +
      `(stale=${rollup.counts.staleUpdateIntents}, ` +
      `stale_threshold_ms=${rollup.intentStaleThresholdMs})`
  );
  const externalApplyStateCounts = rollup.externalApply.pendingIntentApplyStateCounts;
  const externalApplyAuditCounts = rollup.externalApply.pendingAuditCounts;
  lines.push(
    `Pending external apply state: idle=${externalApplyStateCounts.idle}, ` +
      `in_flight=${externalApplyStateCounts.in_flight}, ` +
      `blocked=${externalApplyStateCounts.blocked}`
  );
  lines.push(
    `Pending external apply audits: total=${rollup.externalApply.totalAttempts}, ` +
      `succeeded=${externalApplyAuditCounts.succeeded}, ` +
      `failed=${externalApplyAuditCounts.failed}, ` +
      `claimed=${externalApplyAuditCounts.claimed}, ` +
      `blocked=${externalApplyAuditCounts.blocked}, ` +
      `audit_incomplete=${externalApplyAuditCounts.audit_incomplete}`
  );
  const latestExternalApply = rollup.externalApply.latestAttempt;
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
  if (rollup.reconciliationWarnings.length === 0) {
    lines.push("Reconciliation: ok");
  } else {
    for (const warning of rollup.reconciliationWarnings) {
      const ageText =
        warning.ageMs === null ? "" : ` (age_ms=${warning.ageMs})`;
      const errorText = warning.error ? ` error=${warning.error}` : "";
      lines.push(
        `Reconciliation warning: ${warning.adapterKind} ${warning.reason}${ageText}${errorText}`
      );
    }
  }
  lines.push("");
  lines.push("Top source items:");
  if (rollup.sourceItems.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of rollup.sourceItems) {
      const goalText = item.goalId
        ? `goal=${item.goalId} (${item.goalState ?? "unknown"})`
        : "goal=(none)";
      lines.push(
        `  - [${item.adapterKind}] ${item.externalKey ?? item.externalId} ` +
          `${item.title}${item.status ? ` (${item.status})` : ""} ${goalText}`
      );
    }
    if (rollup.truncatedSourceItems) {
      lines.push(
        `  ... and ${rollup.totalSourceItemCount - rollup.sourceItems.length} more`
      );
    }
  }
  lines.push("");
  lines.push("Mismatches:");
  if (rollup.mismatches.length === 0) {
    lines.push("  (none)");
  } else {
    for (const mismatch of rollup.mismatches) {
      lines.push(
        `  - [${mismatch.kind}] ${mismatch.externalKey ?? mismatch.sourceItemId} ` +
          `source=${mismatch.sourceStatus ?? "(none)"} goal=${mismatch.goalId ?? "(none)"} (${mismatch.goalState ?? "unknown"})`
      );
    }
    if (rollup.truncatedMismatches) {
      lines.push(
        `  ... and ${rollup.totalMismatchCount - rollup.mismatches.length} more`
      );
    }
  }
  lines.push("");
  lines.push("Pending update intents:");
  if (rollup.pendingUpdateIntents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const intent of rollup.pendingUpdateIntents) {
      const staleText = intent.stale ? " STALE" : "";
      const targetText = intent.targetExternalId
        ? ` target=${intent.targetExternalId}`
        : "";
      const goalText = intent.goalId ? ` goal=${intent.goalId}` : "";
      const sourceText = intent.sourceItemId
        ? ` source=${intent.sourceItemId}`
        : "";
      const latestText = intent.externalApply.latestAttempt
        ? ` latest=${intent.externalApply.latestAttempt.lifecycleState}`
        : "";
      lines.push(
        `  - [${intent.adapterKind}/${intent.intentType}] ${intent.intentId}` +
          `${targetText}${goalText}${sourceText} age_ms=${intent.ageMs}${staleText}` +
          ` apply=${intent.externalApply.applyState}` +
          ` attempts=${intent.externalApply.totalAttempts}${latestText}`
      );
    }
    if (rollup.truncatedPendingUpdateIntents) {
      lines.push(
        `  ... and ${rollup.totalPendingUpdateIntentCount - rollup.pendingUpdateIntents.length} more`
      );
    }
  }
  lines.push("");
  lines.push(`Next action: ${rollup.nextAction.kind} — ${rollup.nextAction.message}`);
  lines.push("");
  return lines.join("\n");
}

function emitProjectStatusFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: { code: string; message: string }
): number {
  const payload = {
    ok: false,
    command: "project status",
    code: failure.code,
    message: failure.message
  };
  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}
