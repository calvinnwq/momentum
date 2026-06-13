import { write, writeJson, type CliIo } from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export type DoctorPayload = {
  ok: true;
  command: "doctor";
  version: string;
  node: string;
  platform: string;
  milestone: string;
  daemon:
    | {
        ok: true;
        dataDir: string;
        hasRun: boolean;
        state: string | null;
        isActive: boolean;
        stale: boolean;
        staleRunCount: number;
        staleRepoLockCount: number;
        staleClaimedJobCount: number;
        goalsNeedingRecoveryCount: number;
        runId: string | null;
      }
    | {
        ok: false;
        code: string;
        message: string;
      };
  runners: {
    supported: readonly string[];
    default: string;
    profiles: readonly unknown[];
  };
  policy: DoctorPolicyPayload;
  sources: DoctorSourcesPayload;
  evidence: DoctorEvidencePayload;
  externalApply: DoctorExternalApplyPayload;
};

export type DoctorEvidencePayload =
  | {
      ok: true;
      totalRecords: number;
      goalLinkedRecords: number;
      sourceItemLinkedRecords: number;
      lastRecord: {
        id: string;
        source: string;
        type: string;
        occurredAt: number;
        summary: string;
        goalId: string | null;
        sourceItemId: string | null;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type DoctorExternalApplyPayload =
  | {
      ok: true;
      intentApplyStateCounts: {
        idle: number;
        in_flight: number;
        blocked: number;
      };
      auditCounts: {
        claimed: number;
        succeeded: number;
        failed: number;
        blocked: number;
        audit_incomplete: number;
      };
      totalAttempts: number;
      latestAttempt: {
        id: string;
        intentId: string;
        lifecycleState: string;
        resultStatus: string | null;
        resultCode: string | null;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type DoctorSourcesPayload =
  | {
      ok: true;
      totalSourceItems: number;
      linkedSourceItems: number;
      unlinkedSourceItems: number;
      lastReconciliation: {
        id: string;
        adapterKind: string;
        state: string;
        startedAt: number;
        finishedAt: number | null;
        error: string | null;
        itemsSeen: number;
        itemsUpserted: number;
        paginationStopped: { reason: string } | null;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type DoctorPolicyPayload = {
  repoConfigured: boolean;
  repoPath: string | null;
  present: boolean;
  path: string | null;
  hasNotes: boolean;
  config: {
    runner: string | null;
    verification: readonly string[] | null;
    verificationTimeoutSec: number | null;
    intentApplyPolicy?: string | null;
  } | null;
  effectiveIntentApply: {
    value: string;
    source: string;
  };
  error: { code: string; message: string } | null;
};

export function emitDoctor(
  parsed: JsonFlags,
  io: CliIo,
  payload: DoctorPayload
): number {
  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const daemonPayload = payload.daemon;
  const policyPayload = payload.policy;
  const sourcesPayload = payload.sources;
  const evidencePayload = payload.evidence;
  const externalApplyPayload = payload.externalApply;
  const lines: string[] = [
    "Momentum doctor: ok",
    `version: ${payload.version}`,
    `node: ${payload.node}`,
    `platform: ${payload.platform}`,
    `scope: ${payload.milestone}`
  ];
  if (daemonPayload.ok) {
    if (!daemonPayload.hasRun) {
      lines.push("daemon: never started");
    } else {
      const flags: string[] = [];
      if (daemonPayload.isActive) flags.push("active");
      if (daemonPayload.stale) flags.push("stale");
      const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      lines.push(`daemon: ${daemonPayload.state}${flagStr}`);
    }
    if (daemonPayload.staleRunCount > 0) {
      lines.push(`daemon stale runs: ${daemonPayload.staleRunCount}`);
    }
    if (daemonPayload.staleRepoLockCount > 0) {
      lines.push(
        `daemon stale repo locks: ${daemonPayload.staleRepoLockCount}`
      );
    }
    if (daemonPayload.staleClaimedJobCount > 0) {
      lines.push(
        `daemon stale claimed jobs: ${daemonPayload.staleClaimedJobCount}`
      );
    }
    if (daemonPayload.goalsNeedingRecoveryCount > 0) {
      lines.push(
        `goals needing manual recovery: ${daemonPayload.goalsNeedingRecoveryCount}`
      );
    }
  } else {
    lines.push(`daemon: error (${daemonPayload.code})`);
  }
  lines.push(
    `runners: ${payload.runners.supported.join(", ")} (default ${payload.runners.default})`
  );
  if (policyPayload.repoConfigured) {
    if (policyPayload.error) {
      lines.push(
        `policy (MOMENTUM.md): error ${policyPayload.error.code} at ${policyPayload.path ?? "(unresolved)"}`
      );
    } else if (policyPayload.present) {
      const fields = describePolicyFields(policyPayload);
      lines.push(
        `policy (MOMENTUM.md): present at ${policyPayload.path}${fields ? ` (${fields})` : ""}`
      );
    } else {
      lines.push(
        `policy (MOMENTUM.md): not present (expected at ${policyPayload.path ?? "(unresolved)"})`
      );
    }
  } else {
    lines.push("policy (MOMENTUM.md): pass --repo <path> to inspect repo policy");
  }
  lines.push(
    `intent_apply_policy: ${policyPayload.effectiveIntentApply.value} (${policyPayload.effectiveIntentApply.source})`
  );
  if (sourcesPayload.ok) {
    lines.push(
      `sources: total=${sourcesPayload.totalSourceItems} linked=${sourcesPayload.linkedSourceItems} unlinked=${sourcesPayload.unlinkedSourceItems}`
    );
    const last = sourcesPayload.lastReconciliation;
    if (last) {
      const stoppedText = last.paginationStopped
        ? `, stopped=${last.paginationStopped.reason}`
        : "";
      lines.push(
        `sources: last ${last.adapterKind} reconciliation ${last.state} (` +
          `seen=${last.itemsSeen}, upserted=${last.itemsUpserted}${stoppedText}, finished_at=${last.finishedAt ?? "(running)"})`
      );
    } else {
      lines.push("sources: no reconciliation runs recorded yet");
    }
  } else {
    lines.push(`sources: error (${sourcesPayload.code})`);
  }
  if (evidencePayload.ok) {
    lines.push(
      `evidence: total=${evidencePayload.totalRecords} goal_linked=${evidencePayload.goalLinkedRecords} source_item_linked=${evidencePayload.sourceItemLinkedRecords}`
    );
    const last = evidencePayload.lastRecord;
    if (last) {
      lines.push(
        `evidence: last ${last.source}/${last.type} at ${last.occurredAt}` +
          ` (goal=${last.goalId ?? "(none)"}, source_item=${last.sourceItemId ?? "(none)"})`
      );
    } else {
      lines.push("evidence: no records ingested yet");
    }
  } else {
    lines.push(`evidence: error (${evidencePayload.code})`);
  }
  if (externalApplyPayload.ok) {
    const intentCounts = externalApplyPayload.intentApplyStateCounts;
    const auditCounts = externalApplyPayload.auditCounts;
    lines.push(
      `external apply: intents idle=${intentCounts.idle} in_flight=${intentCounts.in_flight} blocked=${intentCounts.blocked}`
    );
    lines.push(
      `external apply: attempts total=${externalApplyPayload.totalAttempts} ` +
        `succeeded=${auditCounts.succeeded} failed=${auditCounts.failed} ` +
        `claimed=${auditCounts.claimed} blocked=${auditCounts.blocked} ` +
        `audit_incomplete=${auditCounts.audit_incomplete}`
    );
    const latest = externalApplyPayload.latestAttempt;
    if (latest) {
      lines.push(
        `external apply: latest ${latest.id} intent=${latest.intentId} ${latest.lifecycleState}` +
          ` (result=${latest.resultStatus ?? "(none)"} code=${latest.resultCode ?? "(none)"})`
      );
    } else {
      lines.push("external apply: no attempts recorded yet");
    }
  } else {
    lines.push(`external apply: error (${externalApplyPayload.code})`);
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
    intentApplyPolicy?: string | null;
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
