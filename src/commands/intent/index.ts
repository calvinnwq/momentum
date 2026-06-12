import { COMMANDS } from "../help.js";
import { openDb } from "../../db.js";
import { resolveDataDir, type DataDirOptions } from "../../data-dir.js";
import {
  DEFAULT_INTENT_APPLY_POLICY,
  loadMomentumPolicy,
  resolveIntentApplyPolicy,
  type PolicyEffectiveFieldSource,
  type UpdateIntentApplyPolicy
} from "../../momentum-policy.js";
import {
  UPDATE_INTENT_STATUSES,
  cancelUpdateIntent,
  countUpdateIntents,
  getUpdateIntentById,
  listUpdateIntents,
  markUpdateIntentApplied,
  markUpdateIntentSkipped,
  type CountUpdateIntentsOptions,
  type ListUpdateIntentsOptions,
  type UpdateIntent,
  type UpdateIntentDecisionInput,
  type UpdateIntentDecisionResult,
  type UpdateIntentStatus
} from "../../update-intents.js";
import {
  countIntentApplyAuditsByLifecycleState,
  countIntentsByApplyState,
  listIntentApplyAudits,
  summarizeIntentApplyAuditsForIntent,
  type IntentApplyAudit,
  type IntentApplyAuditCounts,
  type IntentApplyAuditSummary,
  type IntentApplyStateCounts
} from "../../intent-apply-audits.js";
import {
  defaultBuildLinearRefreshClient,
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
  type ExecuteExternalApplyDeps,
  type ExecuteExternalApplyResult
} from "../../intent-apply-execute.js";
import { type LinearExternalUpdateClient } from "../../linear-external-update-client.js";
import { type LinearIssueRefreshClient } from "../../linear-issue-refresh.js";

export type LinearExternalUpdateClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type LinearIssueRefreshClientFactoryInput = {
  apiKey: string | null;
  env: NodeJS.ProcessEnv;
};

export type CliDeps = {
  buildLinearExternalUpdateClient?: (
    input: LinearExternalUpdateClientFactoryInput
  ) => LinearExternalUpdateClient;
  buildLinearIssueRefreshClient?: (
    input: LinearIssueRefreshClientFactoryInput
  ) => LinearIssueRefreshClient | null;
};

type ParsedFlags = {
  args: string[]; json: boolean; dataDir?: string; goal?: string; sourceItem?: string; status?: string; reason?: string; limit?: number; externalApply: boolean; repo?: string; adapter?: string; evidenceType?: string; evidenceRecord?: string;
};

type Writer = {
  write(chunk: string): boolean;
};

type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

type JsonPayload = Record<string, unknown>;

type IntentFailureCode =
  | "data_dir_failed"
  | "invalid_status"
  | "goal_not_found"
  | "source_item_not_found"
  | "evidence_record_not_found"
  | "intent_not_found"
  | "reason_required"
  | "intent_already_terminal"
  | "policy_load_failed"
  | "policy_denied"
  | "auth_unavailable"
  | "unsupported_adapter"
  | "unsupported_intent_type"
  | "target_missing"
  | "intent_apply_in_progress"
  | "intent_blocked"
  | "external_conflict"
  | "write_rejected"
  | "write_timeout"
  | "malformed_response"
  | "validation_failed"
  | "adapter_threw"
  | "preview_failed"
  | "audit_incomplete";

type IntentCommand =
  | "intent list"
  | "intent get"
  | "intent apply"
  | "intent skip"
  | "intent cancel";

type IntentExternalApplySummary = {
  adapterKind: string;
  intentType: string;
  target: {
    adapterKind: string;
    externalId: string | null;
    externalKey: string | null;
    url: string | null;
    title: string | null;
  };
  allowStatusMutation: boolean;
  mutationKind: string | null;
  auditId: string | null;
  reconcile: {
    status: string | null;
    warning: string | null;
  };
  external: {
    alreadyApplied: boolean;
    issueId: string | null;
    issueKey: string | null;
    issueUrl: string | null;
    commentId: string | null;
    commentUrl: string | null;
    statusTransitioned: boolean;
    nextStateId: string | null;
    nextStateName: string | null;
    idempotencyMarker: string;
  } | null;
};

type IntentFailure = {
  command: IntentCommand;
  code: IntentFailureCode;
  message: string;
  dataDir?: string;
  intentId?: string;
  goalId?: string;
  sourceItemId?: string;
  evidenceRecordId?: string;
  status?: string;
  currentStatus?: UpdateIntentStatus;
  applyPolicy?: IntentApplyPolicySummary;
  externalApply?: IntentExternalApplySummary;
};

type IntentApplyPolicySummary = {
  effective: UpdateIntentApplyPolicy;
  source: PolicyEffectiveFieldSource;
  externalApplyRequested: boolean;
  externalApplyPerformed: boolean;
  note: string;
};

type IntentApplyPolicyResolution =
  | { ok: true; summary: IntentApplyPolicySummary }
  | { ok: false; code: string; message: string; path?: string | null };

const LINEAR_API_KEY_ENV = LINEAR_API_KEY_ENV_VAR;

function buildFallbackIntentApplyPolicySummary(
  externalApplyRequested: boolean
): IntentApplyPolicySummary {
  return {
    effective: DEFAULT_INTENT_APPLY_POLICY,
    source: "builtin_default",
    externalApplyRequested,
    externalApplyPerformed: false,
    note:
      "`intent apply` records the operator's manual mark only; " +
      "pass --external-apply with a repo whose MOMENTUM.md sets " +
      "intent_apply_policy: external_apply_allowed to perform an external tracker write."
  };
}

export function intent(
  parsed: ParsedFlags,
  io: CliIo,
  deps: CliDeps
): number | Promise<number> {
  const subcommand = parsed.args[1];
  if (!subcommand) {
    return usageError(
      "Missing required subcommand for intent. Expected: list, get, apply, skip, cancel.",
      parsed,
      io
    );
  }
  if (subcommand === "list") {
    return intentList(parsed, io);
  }
  if (subcommand === "get") {
    return intentGet(parsed, io);
  }
  if (subcommand === "apply") {
    return intentDecision(parsed, io, "apply", deps);
  }
  if (subcommand === "skip") {
    return intentDecision(parsed, io, "skip", deps);
  }
  if (subcommand === "cancel") {
    return intentDecision(parsed, io, "cancel", deps);
  }
  return usageError(`Unknown intent subcommand: ${subcommand}`, parsed, io);
}

function intentList(parsed: ParsedFlags, io: CliIo): number {
  if (parsed.args.length > 2) {
    return usageError(
      `Unexpected argument for intent list: ${parsed.args[2]}`,
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
    return emitIntentFailure(parsed, io, {
      command: "intent list",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err)
    });
  }

  let statusFilter: UpdateIntentStatus | undefined;
  if (parsed.status !== undefined && parsed.status.length > 0) {
    if (!isUpdateIntentStatus(parsed.status)) {
      return emitIntentFailure(parsed, io, {
        command: "intent list",
        code: "invalid_status",
        message: `Invalid --status value: ${parsed.status}. Expected one of: ${UPDATE_INTENT_STATUSES.join(", ")}.`,
        dataDir,
        status: parsed.status
      });
    }
    statusFilter = parsed.status;
  }

  const filters: ListUpdateIntentsOptions = {};
  if (statusFilter !== undefined) filters.status = statusFilter;
  if (parsed.adapter !== undefined && parsed.adapter.length > 0) {
    filters.adapterKind = parsed.adapter;
  }
  if (parsed.evidenceType !== undefined && parsed.evidenceType.length > 0) {
    filters.intentType = parsed.evidenceType;
  }
  if (parsed.goal !== undefined && parsed.goal.length > 0) {
    filters.goalId = parsed.goal;
  }
  if (parsed.sourceItem !== undefined && parsed.sourceItem.length > 0) {
    filters.sourceItemId = parsed.sourceItem;
  }
  if (parsed.evidenceRecord !== undefined && parsed.evidenceRecord.length > 0) {
    filters.evidenceRecordId = parsed.evidenceRecord;
  }
  if (parsed.limit !== undefined) {
    filters.limit = parsed.limit;
  }

  const db = openDb(dataDir);
  let intents: UpdateIntent[];
  let totalAvailable: number;
  let auditSummaries: Map<string, IntentApplyAuditSummary | null>;
  try {
    if (filters.goalId !== undefined && filters.goalId !== null) {
      const row = db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(filters.goalId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "goal_not_found",
          message: `Goal not found: ${filters.goalId}`,
          dataDir,
          goalId: filters.goalId
        });
      }
    }
    if (filters.sourceItemId !== undefined && filters.sourceItemId !== null) {
      const row = db
        .prepare("SELECT id FROM source_items WHERE id = ?")
        .get(filters.sourceItemId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "source_item_not_found",
          message: `Source item not found: ${filters.sourceItemId}`,
          dataDir,
          sourceItemId: filters.sourceItemId
        });
      }
    }
    if (
      filters.evidenceRecordId !== undefined &&
      filters.evidenceRecordId !== null
    ) {
      const row = db
        .prepare("SELECT id FROM evidence_records WHERE id = ?")
        .get(filters.evidenceRecordId) as { id: string } | undefined;
      if (!row) {
        return emitIntentFailure(parsed, io, {
          command: "intent list",
          code: "evidence_record_not_found",
          message: `Evidence record not found: ${filters.evidenceRecordId}`,
          dataDir,
          evidenceRecordId: filters.evidenceRecordId
        });
      }
    }
    intents = listUpdateIntents(db, filters);
    const countOptions: CountUpdateIntentsOptions = {};
    if (filters.status !== undefined) countOptions.status = filters.status;
    if (filters.adapterKind !== undefined)
      countOptions.adapterKind = filters.adapterKind;
    if (filters.intentType !== undefined)
      countOptions.intentType = filters.intentType;
    if (filters.goalId !== undefined) countOptions.goalId = filters.goalId;
    if (filters.sourceItemId !== undefined)
      countOptions.sourceItemId = filters.sourceItemId;
    if (filters.evidenceRecordId !== undefined)
      countOptions.evidenceRecordId = filters.evidenceRecordId;
    totalAvailable =
      filters.limit !== undefined
        ? countUpdateIntents(db, countOptions)
        : intents.length;
    auditSummaries = new Map();
    for (const intent of intents) {
      auditSummaries.set(
        intent.id,
        summarizeIntentApplyAuditsForIntent(db, intent.id)
      );
    }
  } finally {
    db.close();
  }

  const truncated =
    filters.limit !== undefined && totalAvailable > intents.length;

  const payload = {
    ok: true,
    command: "intent list",
    dataDir,
    status: statusFilter ?? null,
    adapter: filters.adapterKind ?? null,
    intentType: filters.intentType ?? null,
    goalId: filters.goalId ?? null,
    sourceItemId: filters.sourceItemId ?? null,
    evidenceRecordId: filters.evidenceRecordId ?? null,
    limit: filters.limit ?? null,
    count: intents.length,
    totalAvailable,
    truncated,
    intents: intents.map((record) => ({
      ...updateIntentToJsonShape(record),
      externalApply: intentApplyAuditSummaryToJsonShape(
        auditSummaries.get(record.id) ?? null
      )
    }))
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intents: ${intents.length}`,
    `Total available: ${totalAvailable}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    `Status: ${statusFilter ?? "(any)"}`,
    `Adapter: ${filters.adapterKind ?? "(any)"}`,
    `Intent type: ${filters.intentType ?? "(any)"}`,
    `Goal: ${filters.goalId ?? "(any)"}`,
    `Source item: ${filters.sourceItemId ?? "(any)"}`,
    `Evidence record: ${filters.evidenceRecordId ?? "(any)"}`,
    `Data dir: ${dataDir}`,
    ...intents.map((record) => {
      const summary = auditSummaries.get(record.id) ?? null;
      const applyState = summary?.applyState ?? "idle";
      const totalAttempts = summary?.totalAttempts ?? 0;
      const latest = summary?.latestAttempt;
      const latestLabel = latest
        ? `${latest.lifecycleState}${latest.resultCode ? `/${latest.resultCode}` : ""}`
        : "(none)";
      return (
        `- ${record.id} [${record.adapterKind}/${record.intentType}] ` +
        `${record.status} target=${record.targetExternalId ?? "(none)"} ` +
        `apply=${applyState} attempts=${totalAttempts} latest=${latestLabel}: ` +
        `${record.reason}`
      );
    }),
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

function intentGet(parsed: ParsedFlags, io: CliIo): number {
  const intentId = parsed.args[2];
  if (!intentId) {
    return usageError(
      "Missing required <intent-id> for intent get.",
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for intent get: ${parsed.args[3]}`,
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
    return emitIntentFailure(parsed, io, {
      command: "intent get",
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const db = openDb(dataDir);
  let record: UpdateIntent | null;
  let auditSummary: IntentApplyAuditSummary | null;
  try {
    record = getUpdateIntentById(db, intentId);
    auditSummary = record
      ? summarizeIntentApplyAuditsForIntent(db, intentId)
      : null;
  } finally {
    db.close();
  }

  if (!record) {
    return emitIntentFailure(parsed, io, {
      command: "intent get",
      code: "intent_not_found",
      message: `Update intent not found: ${intentId}`,
      dataDir,
      intentId
    });
  }

  const externalApply = intentApplyAuditSummaryToJsonShape(auditSummary);
  const payload = {
    ok: true,
    command: "intent get",
    dataDir,
    intent: updateIntentToJsonShape(record),
    externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const lines: string[] = [
    `Update intent: ${record.id}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Status: ${record.status}`,
    `Goal: ${record.goalId ?? "(unlinked)"}`,
    `Source item: ${record.sourceItemId ?? "(unlinked)"}`,
    `Evidence record: ${record.evidenceRecordId ?? "(unlinked)"}`,
    `Idempotency key: ${record.idempotencyKey}`,
    `Reason: ${record.reason}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Created at: ${record.createdAt}`,
    `Updated at: ${record.updatedAt}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    ...renderExternalApplyTextLines(externalApply),
    `Data dir: ${dataDir}`,
    ""
  ];
  write(io.stdout, lines.join("\n"));
  return 0;
}

type IntentDecisionAction = "apply" | "skip" | "cancel";

function intentDecisionCommand(action: IntentDecisionAction): IntentCommand {
  if (action === "apply") return "intent apply";
  if (action === "skip") return "intent skip";
  return "intent cancel";
}

function intentDecision(
  parsed: ParsedFlags,
  io: CliIo,
  action: IntentDecisionAction,
  deps: CliDeps
): number | Promise<number> {
  const command = intentDecisionCommand(action);
  const intentId = parsed.args[2];
  if (!intentId) {
    return usageError(
      `Missing required <intent-id> for ${command}.`,
      parsed,
      io
    );
  }
  if (parsed.args.length > 3) {
    return usageError(
      `Unexpected argument for ${command}: ${parsed.args[3]}`,
      parsed,
      io
    );
  }

  const reason = parsed.reason?.trim() ?? "";
  if (reason.length === 0) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "reason_required",
      message: `Missing required --reason for ${command}.`,
      intentId
    });
  }

  if (action === "apply" && parsed.externalApply) {
    return intentExternalApply({
      parsed,
      io,
      deps,
      intentId,
      reason
    });
  }

  const applyPolicyResolution = buildIntentApplyPolicySummary(parsed.repo, false);

  if (!applyPolicyResolution.ok) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "policy_load_failed",
      message: applyPolicyResolution.message,
      intentId
    });
  }
  const applyPolicy = applyPolicyResolution.summary;

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const db = openDb(dataDir);
  let result: UpdateIntentDecisionResult;
  try {
    const input: UpdateIntentDecisionInput = {
      intentId,
      decisionReason: reason
    };
    if (action === "apply") {
      result = markUpdateIntentApplied(db, input);
    } else if (action === "skip") {
      result = markUpdateIntentSkipped(db, input);
    } else {
      result = cancelUpdateIntent(db, input);
    }
  } finally {
    db.close();
  }

  if (!result.ok) {
    const failure: IntentFailure = {
      command,
      code: result.code,
      message: result.message,
      dataDir,
      intentId
    };
    if (result.code === "intent_already_terminal" && result.currentStatus) {
      failure.currentStatus = result.currentStatus;
    }
    if (action === "apply") {
      failure.applyPolicy = applyPolicy;
    }
    return emitIntentFailure(parsed, io, failure);
  }

  const payload: JsonPayload = {
    ok: true,
    command,
    dataDir,
    previousStatus: result.previousStatus,
    intent: updateIntentToJsonShape(result.intent)
  };
  if (action === "apply") {
    payload["applyPolicy"] = applyPolicy;
  }

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = result.intent;
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Previous status: ${result.previousStatus}`,
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Skipped at: ${record.skippedAt ?? "(unset)"}`,
    `Canceled at: ${record.canceledAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${dataDir}`
  ];
  if (action === "apply") {
    lines.push(
      `Apply policy: ${applyPolicy.effective} (${applyPolicy.source}); ${applyPolicy.note}`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

async function intentExternalApply(args: {
  parsed: ParsedFlags;
  io: CliIo;
  deps: CliDeps;
  intentId: string;
  reason: string;
}): Promise<number> {
  const { parsed, io, deps, intentId, reason } = args;
  const command: IntentCommand = "intent apply";

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  let dataDir: string;
  try {
    dataDir = resolveDataDir(dataDirOptions);
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "data_dir_failed",
      message: err instanceof Error ? err.message : String(err),
      intentId
    });
  }

  const env = io.env ?? {};
  const db = openDb(dataDir);
  let result: ExecuteExternalApplyResult;
  try {
    const executeDeps: ExecuteExternalApplyDeps = {};
    const factory = deps.buildLinearExternalUpdateClient;
    if (factory) {
      executeDeps.buildLinearClient = (clientEnv) => {
        const apiKeyRaw = clientEnv[LINEAR_API_KEY_ENV] ?? null;
        const apiKey =
          typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0
            ? apiKeyRaw
            : null;
        return factory({ apiKey, env: env as NodeJS.ProcessEnv });
      };
    }
    const refreshFactory =
      deps.buildLinearIssueRefreshClient ??
      ((input: LinearIssueRefreshClientFactoryInput) =>
        defaultBuildLinearRefreshClient(input.env));
    executeDeps.buildLinearRefreshClient = (clientEnv) => {
      const apiKeyRaw = clientEnv[LINEAR_API_KEY_ENV] ?? null;
      const apiKey =
        typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0
          ? apiKeyRaw
          : null;
      return refreshFactory({ apiKey, env: env as NodeJS.ProcessEnv });
    };
    result = await executeExternalApply({
      db,
      intentId,
      operatorReason: reason,
      repoPath: parsed.repo ?? null,
      env,
      statusMutation: null,
      deps: executeDeps
    });
  } catch (err) {
    return emitIntentFailure(parsed, io, {
      command,
      code: "adapter_threw",
      message: `External apply orchestration failed unexpectedly: ${
        err instanceof Error ? err.message : String(err)
      }`,
      dataDir,
      intentId
    });
  } finally {
    db.close();
  }

  const applyPolicy = buildExternalApplyPolicySummary(result, true);
  const externalApply = buildIntentExternalApplySummary(result);

  if (!result.ok) {
    const failure: IntentFailure = {
      command,
      code: result.code,
      message: result.message,
      dataDir,
      intentId,
      applyPolicy,
      externalApply
    };
    if (
      result.code === "intent_already_terminal" &&
      result.intent &&
      isUpdateIntentStatus(result.intent.status)
    ) {
      failure.currentStatus = result.intent.status;
    }
    return emitIntentFailure(parsed, io, failure);
  }

  const payload: JsonPayload = {
    ok: true,
    command,
    dataDir,
    previousStatus: "pending",
    intent: updateIntentToJsonShape(result.intent),
    applyPolicy,
    externalApply
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  const record = result.intent;
  const target = externalApply.target;
  const lines: string[] = [
    `Update intent ${record.id} ${record.status}`,
    `Adapter: ${record.adapterKind}`,
    `Target external id: ${record.targetExternalId ?? "(none)"}`,
    `Intent type: ${record.intentType}`,
    `Previous status: pending`,
    `Status: ${record.status}`,
    `Decision reason: ${record.decisionReason ?? "(none)"}`,
    `Applied at: ${record.appliedAt ?? "(unset)"}`,
    `Updated at: ${record.updatedAt}`,
    `Data dir: ${dataDir}`,
    `Apply policy: ${applyPolicy.effective} (${applyPolicy.source}); ${applyPolicy.note}`,
    `External apply: performed (audit ${externalApply.auditId ?? "(none)"})`,
    `Target: ${target.adapterKind} ${target.externalKey ?? target.externalId ?? "(unknown)"}${target.url ? ` <${target.url}>` : ""}`
  ];
  if (externalApply.external) {
    const ext = externalApply.external;
    lines.push(
      `Comment: ${ext.commentId ?? "(none)"}${ext.commentUrl ? ` <${ext.commentUrl}>` : ""}${ext.alreadyApplied ? " (replay)" : ""}`
    );
    if (ext.statusTransitioned) {
      lines.push(
        `Status transition: ${ext.nextStateName ?? ext.nextStateId ?? "(unknown)"}`
      );
    }
    lines.push(`Idempotency marker: ${ext.idempotencyMarker}`);
  }
  if (externalApply.reconcile.status) {
    lines.push(
      `Reconcile: ${externalApply.reconcile.status}${
        externalApply.reconcile.warning
          ? ` (${externalApply.reconcile.warning})`
          : ""
      }`
    );
  }
  lines.push("");
  write(io.stdout, lines.join("\n"));
  return 0;
}

function buildExternalApplyPolicySummary(
  result: ExecuteExternalApplyResult,
  externalApplyRequested: boolean
): IntentApplyPolicySummary {
  const base = buildFallbackIntentApplyPolicySummary(externalApplyRequested);
  const resolved = result.context.applyPolicy;
  const source: PolicyEffectiveFieldSource =
    resolved.source === "missing_repo" ? "builtin_default" : resolved.source;
  const performed = externalApplyPerformed(result);
  let note: string;
  if (result.ok) {
    note = "External apply was performed through the configured tracker adapter.";
  } else if (performed) {
    note =
      "External write was performed, but post-write finalization did not complete; inspect externalApply and run operator recovery before retrying.";
  } else if (resolved.value !== "external_apply_allowed") {
    note = base.note;
  } else {
    note =
      "External apply was attempted and refused before marking the intent applied; inspect externalApply for audit and adapter details.";
  }
  return {
    ...base,
    effective: resolved.value,
    source,
    externalApplyPerformed: performed,
    note
  };
}

function externalApplyPerformed(result: ExecuteExternalApplyResult): boolean {
  if (result.ok) return true;
  return Boolean(
    result.external?.commentId ||
      result.external?.statusTransitioned ||
      result.external?.alreadyApplied
  );
}

function buildIntentExternalApplySummary(
  result: ExecuteExternalApplyResult
): IntentExternalApplySummary {
  const ctx = result.context;
  const external = result.external;
  return {
    adapterKind: ctx.adapterKind,
    intentType: ctx.intentType,
    target: {
      adapterKind: ctx.target.adapterKind,
      externalId: ctx.target.externalId,
      externalKey: ctx.target.externalKey,
      url: ctx.target.url,
      title: ctx.target.title
    },
    allowStatusMutation: ctx.allowStatusMutation,
    mutationKind: ctx.mutationKind,
    auditId: ctx.auditId,
    reconcile: {
      status: ctx.reconcile.status,
      warning: ctx.reconcile.warning
    },
    external: external
      ? {
          alreadyApplied: external.alreadyApplied,
          issueId: external.issueId,
          issueKey: external.issueKey,
          issueUrl: external.issueUrl,
          commentId: external.commentId,
          commentUrl: external.commentUrl,
          statusTransitioned: external.statusTransitioned,
          nextStateId: external.nextStateId,
          nextStateName: external.nextStateName,
          idempotencyMarker: external.idempotencyMarker
        }
      : null
  };
}

function buildIntentApplyPolicySummary(
  repoOverride: string | undefined,
  externalApplyRequested: boolean
): IntentApplyPolicyResolution {
  let effective: UpdateIntentApplyPolicy = DEFAULT_INTENT_APPLY_POLICY;
  let source: PolicyEffectiveFieldSource = "builtin_default";
  if (typeof repoOverride === "string" && repoOverride.trim().length > 0) {
    const load = loadMomentumPolicy(repoOverride);
    if (!load.ok) {
      return {
        ok: false,
        code: load.code,
        message: load.error,
        path: load.path
      };
    }
    if (load.ok && load.present) {
      const resolved = resolveIntentApplyPolicy(load.policy.config);
      effective = resolved.value;
      source = resolved.source;
    }
  }
  return {
    ok: true,
    summary: {
      ...buildFallbackIntentApplyPolicySummary(externalApplyRequested),
      effective,
      source
    }
  };
}

function emitIntentFailure(
  parsed: ParsedFlags,
  io: CliIo,
  failure: IntentFailure
): number {
  const payload: Record<string, unknown> = {
    ok: false,
    command: failure.command,
    code: failure.code,
    message: failure.message
  };
  if (failure.dataDir !== undefined) payload["dataDir"] = failure.dataDir;
  if (failure.intentId !== undefined) payload["intentId"] = failure.intentId;
  if (failure.goalId !== undefined) payload["goalId"] = failure.goalId;
  if (failure.sourceItemId !== undefined) {
    payload["sourceItemId"] = failure.sourceItemId;
  }
  if (failure.evidenceRecordId !== undefined) {
    payload["evidenceRecordId"] = failure.evidenceRecordId;
  }
  if (failure.status !== undefined) payload["status"] = failure.status;
  if (failure.currentStatus !== undefined) {
    payload["currentStatus"] = failure.currentStatus;
  }
  if (failure.applyPolicy !== undefined) {
    payload["applyPolicy"] = failure.applyPolicy;
  }
  if (failure.externalApply !== undefined) {
    payload["externalApply"] = failure.externalApply;
  }

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 1;
  }
  write(io.stderr, `${failure.message}\n`);
  return 1;
}

function isUpdateIntentStatus(value: string): value is UpdateIntentStatus {
  return (UPDATE_INTENT_STATUSES as readonly string[]).includes(value);
}

export function updateIntentToJsonShape(record: UpdateIntent): Record<string, unknown> {
  return {
    id: record.id,
    adapterKind: record.adapterKind,
    targetExternalId: record.targetExternalId,
    intentType: record.intentType,
    payload: record.payload,
    reason: record.reason,
    goalId: record.goalId,
    sourceItemId: record.sourceItemId,
    evidenceRecordId: record.evidenceRecordId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    decisionReason: record.decisionReason,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt,
    skippedAt: record.skippedAt,
    canceledAt: record.canceledAt
  };
}

type IntentApplyAuditJsonShape = {
  intentId: string;
  applyState: IntentApplyAuditSummary["applyState"];
  totalAttempts: number;
  counts: IntentApplyAuditSummary["counts"];
  latestAttempt: ReturnType<typeof intentApplyAuditToJsonShape> | null;
};

function intentApplyAuditSummaryToJsonShape(
  summary: IntentApplyAuditSummary | null
): IntentApplyAuditJsonShape {
  if (!summary) {
    return {
      intentId: "",
      applyState: "idle",
      totalAttempts: 0,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      latestAttempt: null
    };
  }
  return {
    intentId: summary.intentId,
    applyState: summary.applyState,
    totalAttempts: summary.totalAttempts,
    counts: summary.counts,
    latestAttempt: summary.latestAttempt
      ? intentApplyAuditToJsonShape(summary.latestAttempt)
      : null
  };
}

export function intentApplyAuditToJsonShape(
  audit: IntentApplyAudit
): Record<string, unknown> {
  return {
    id: audit.id,
    adapterKind: audit.adapterKind,
    provider: audit.provider,
    target: audit.target,
    requestedAt: audit.requestedAt,
    finishedAt: audit.finishedAt,
    operatorReason: audit.operatorReason,
    operatorActor: audit.operatorActor,
    intentApplyPolicy: audit.intentApplyPolicy,
    allowStatusMutation: audit.allowStatusMutation,
    mutationKind: audit.mutationKind,
    previewSummary: audit.previewSummary,
    idempotencyMarker: audit.idempotencyMarker,
    lifecycleState: audit.lifecycleState,
    resultStatus: audit.resultStatus,
    resultCode: audit.resultCode,
    resultMessage: audit.resultMessage,
    externalRefs: audit.externalRefs,
    reconcile: audit.reconcile,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt
  };
}

function renderExternalApplyTextLines(
  external: IntentApplyAuditJsonShape
): string[] {
  const counts = external.counts;
  const lines: string[] = [
    `External apply state: ${external.applyState}`,
    `External apply attempts: total=${external.totalAttempts} ` +
      `succeeded=${counts.succeeded} failed=${counts.failed} ` +
      `claimed=${counts.claimed} blocked=${counts.blocked} ` +
      `audit_incomplete=${counts.audit_incomplete}`
  ];
  const latest = external.latestAttempt;
  if (!latest) {
    lines.push("External apply latest attempt: (none)");
    return lines;
  }
  lines.push(
    `External apply latest attempt: ${latest.id} ${latest.lifecycleState}` +
      ` (result=${latest.resultStatus ?? "(none)"}` +
      ` code=${latest.resultCode ?? "(none)"})`
  );
  lines.push(
    `External apply latest target: ${latest.adapterKind}/` +
      `${(latest.target as { externalKey: string | null }).externalKey ?? "(none)"}` +
      ` (${(latest.target as { externalId: string | null }).externalId ?? "(none)"})`
  );
  const refs = latest.externalRefs as {
    commentId: string | null;
    commentUrl: string | null;
    stateTransitionId: string | null;
  };
  if (refs.commentId || refs.commentUrl || refs.stateTransitionId) {
    lines.push(
      `External apply refs: comment=${refs.commentId ?? "(none)"}` +
        ` url=${refs.commentUrl ?? "(none)"}` +
        ` transition=${refs.stateTransitionId ?? "(none)"}`
    );
  }
  return lines;
}

function usageError(message: string, parsed: ParsedFlags, io: CliIo): number {
  if (parsed.json) {
    writeJson(io.stderr, {
      ok: false,
      code: "usage_error",
      message,
      commands: COMMANDS
    });
  } else {
    write(io.stderr, `${message}\n\n${COMMANDS.join("\n")}\n`);
  }
  return 2;
}

function writeJson(writer: Writer, payload: JsonPayload): void {
  writer.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}
