/**
 * External update adapter boundary introduced by NGX-296 (M6-01).
 *
 * This module defines the write-side adapter boundary that the policy-gated
 * external apply path in M6 layers on top of the M5 read adapter. It is
 * intentionally narrow:
 *
 *  - Defines the durable input shape an external apply needs (a pending
 *    `UpdateIntent`, the resolved target, optional source/evidence context,
 *    operator metadata, and policy metadata).
 *  - Defines a stable error code taxonomy that covers both preview-time and
 *    write-time failures, so callers can branch deterministically.
 *  - Renders a deterministic dry-run preview with no side effects.
 *  - Computes a stable idempotency marker so dedupe / reconcile / replay paths
 *    in later slices can key off Linear-side artifacts alone.
 *
 * This boundary deliberately exposes only `preview`; no code path here can
 * perform an external mutation. The NGX-297 Linear write client consumes this
 * preview separately, audit/claim surfaces land in NGX-299 before CLI execution
 * in NGX-298, and reconciliation result codes are owned by NGX-300 and
 * intentionally absent from this taxonomy.
 */

import { createHash } from "node:crypto";

import type { EvidenceRecord } from "../core/evidence/records.js";
import type { SourceItem } from "../core/source/items.js";
import type { UpdateIntentApplyPolicy } from "../core/intent/policy.js";
import type { UpdateIntent } from "../core/intent/update-intents.js";

export const BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS = Object.freeze([
  "linear"
] as const);

export type BuiltinExternalUpdateAdapterKind =
  (typeof BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS)[number];

export const EXTERNAL_UPDATE_ADAPTER_ERROR_CODES = Object.freeze([
  "unsupported_adapter",
  "unsupported_intent_type",
  "target_missing",
  "auth_unavailable",
  "policy_denied",
  "external_conflict",
  "adapter_threw",
  "write_rejected",
  "write_timeout",
  "malformed_response",
  "validation_failed"
] as const);

export type ExternalUpdateAdapterErrorCode =
  (typeof EXTERNAL_UPDATE_ADAPTER_ERROR_CODES)[number];

export const EXTERNAL_UPDATE_MUTATION_KINDS = Object.freeze([
  "comment",
  "status_transition"
] as const);

export type ExternalUpdateMutationKind =
  (typeof EXTERNAL_UPDATE_MUTATION_KINDS)[number];

export type ExternalUpdateAdapterTarget = {
  adapterKind: string;
  externalId: string;
  externalKey: string | null;
  url: string | null;
  title: string | null;
};

export type ExternalUpdateAdapterOperator = {
  reason: string;
  actor?: string | null;
};

export type ExternalUpdateAdapterPolicy = {
  intentApplyPolicy: UpdateIntentApplyPolicy;
  allowStatusMutation: boolean;
};

export type ExternalUpdateAdapterInput = {
  intent: UpdateIntent;
  target: ExternalUpdateAdapterTarget;
  sourceItem?: SourceItem | null;
  evidenceRecord?: EvidenceRecord | null;
  operator: ExternalUpdateAdapterOperator;
  policy: ExternalUpdateAdapterPolicy;
};

export type ExternalUpdateAdapterPreview = {
  adapterKind: string;
  intentId: string;
  intentType: string;
  target: ExternalUpdateAdapterTarget;
  mutationKind: ExternalUpdateMutationKind;
  summary: string;
  commentBody: string;
  idempotencyMarker: string;
};

export type ExternalUpdateAdapterPreviewSuccess = {
  ok: true;
  preview: ExternalUpdateAdapterPreview;
};

export type ExternalUpdateAdapterError = {
  ok: false;
  code: ExternalUpdateAdapterErrorCode;
  error: string;
};

export type ExternalUpdateAdapterPreviewResult =
  | ExternalUpdateAdapterPreviewSuccess
  | ExternalUpdateAdapterError;

export type ExternalUpdateAdapter = {
  kind: BuiltinExternalUpdateAdapterKind;
  supportedIntentTypes: readonly string[];
  preview: (
    input: ExternalUpdateAdapterInput
  ) => ExternalUpdateAdapterPreviewResult;
};

export type ExternalUpdateAdapterSummary = {
  kind: BuiltinExternalUpdateAdapterKind;
  supportedIntentTypes: readonly string[];
};

export type ExternalUpdateAdapterDispatchOptions = {
  adapters?: ReadonlyMap<string, ExternalUpdateAdapter>;
};

const EXTERNAL_UPDATE_ADAPTERS: ReadonlyMap<
  BuiltinExternalUpdateAdapterKind,
  ExternalUpdateAdapter
> = new Map<BuiltinExternalUpdateAdapterKind, ExternalUpdateAdapter>([
  ["linear", buildLinearExternalUpdateAdapter()]
]);

export function listExternalUpdateAdapterKinds():
  readonly BuiltinExternalUpdateAdapterKind[] {
  return [...BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS];
}

export function listExternalUpdateAdapters(
  adapters?: ReadonlyMap<string, ExternalUpdateAdapter>
): readonly ExternalUpdateAdapterSummary[] {
  const source = adapters ?? EXTERNAL_UPDATE_ADAPTERS;
  const out: ExternalUpdateAdapterSummary[] = [];
  for (const adapter of source.values()) {
    out.push({
      kind: adapter.kind,
      supportedIntentTypes: adapter.supportedIntentTypes
    });
  }
  return out;
}

export function getExternalUpdateAdapter(
  kind: string,
  adapters?: ReadonlyMap<string, ExternalUpdateAdapter>
): ExternalUpdateAdapter | undefined {
  if (adapters) return adapters.get(kind);
  if (!isBuiltinExternalUpdateAdapterKind(kind)) return undefined;
  return EXTERNAL_UPDATE_ADAPTERS.get(kind);
}

/**
 * Resolve the adapter that would handle the given intent, or undefined if the
 * intent's adapter kind is not registered or the intent type is not supported
 * by that adapter. The first eligible adapter wins; in M6 the only registered
 * external update adapter is Linear with `source_satisfied` and `status_update`
 * support.
 */
export function resolveExternalUpdateAdapterForIntent(
  intent: Pick<UpdateIntent, "adapterKind" | "intentType">,
  adapters?: ReadonlyMap<string, ExternalUpdateAdapter>
): ExternalUpdateAdapter | undefined {
  const adapter = getExternalUpdateAdapter(intent.adapterKind, adapters);
  if (!adapter) return undefined;
  if (!adapter.supportedIntentTypes.includes(intent.intentType)) return undefined;
  return adapter;
}

/**
 * Compute the stable idempotency marker the adapter would write so that
 * dedupe, post-apply reconcile, and recovery paths can key off Linear-side
 * artifacts alone. Composed from `(adapter_kind, intent_id, intent_payload)`
 * to survive crashes, replays, and process restarts without coordination.
 */
export function buildIdempotencyMarker(input: {
  adapterKind: string;
  intentId: string;
  payload: Record<string, unknown>;
}): string {
  const hash = createHash("sha256");
  hash.update(input.adapterKind);
  hash.update("\0");
  hash.update(input.intentId);
  hash.update("\0");
  hash.update(canonicalJson(input.payload));
  const digest = hash.digest("hex").slice(0, 16);
  return `momentum-intent:${input.adapterKind}:${input.intentId}:${digest}`;
}

/**
 * Dispatch a dry-run preview through the registry. Returns a stable structured
 * result on every code path; never throws. Adapter exceptions are wrapped as
 * `adapter_threw` so callers can branch deterministically.
 *
 * No code path here performs an external mutation. This boundary deliberately
 * exposes only `preview`; the Linear write client consumes the preview through
 * its own apply entry point.
 */
export function previewExternalUpdate(
  input: ExternalUpdateAdapterInput,
  options: ExternalUpdateAdapterDispatchOptions = {}
): ExternalUpdateAdapterPreviewResult {
  const adapter = getExternalUpdateAdapter(
    input.intent.adapterKind,
    options.adapters
  );
  if (!adapter) {
    return unsupportedAdapterError(input.intent.adapterKind);
  }
  if (!adapter.supportedIntentTypes.includes(input.intent.intentType)) {
    return unsupportedIntentTypeError(adapter.kind, input.intent.intentType);
  }
  const policyError = validateExternalUpdatePolicy(input);
  if (policyError) return policyError;
  try {
    return adapter.preview(input);
  } catch (error) {
    return adapterThrewError(adapter.kind, error);
  }
}

function buildLinearExternalUpdateAdapter(): ExternalUpdateAdapter {
  return {
    kind: "linear",
    supportedIntentTypes: Object.freeze(["source_satisfied", "status_update"]),
    preview: linearPreview
  };
}

function linearPreview(
  input: ExternalUpdateAdapterInput
): ExternalUpdateAdapterPreviewResult {
  const policyError = validateExternalUpdatePolicy(input);
  if (policyError) return policyError;

  const targetExternalId =
    input.intent.targetExternalId ?? input.target.externalId;
  if (typeof targetExternalId !== "string" || targetExternalId.length === 0) {
    return {
      ok: false,
      code: "target_missing",
      error: `Linear external update adapter requires a resolved targetExternalId for intent ${input.intent.id}.`
    };
  }
  if (input.target.adapterKind !== "linear") {
    return {
      ok: false,
      code: "validation_failed",
      error: `Linear external update adapter requires target.adapterKind="linear" (got "${input.target.adapterKind}").`
    };
  }
  if (input.target.externalId !== targetExternalId) {
    return {
      ok: false,
      code: "validation_failed",
      error: `Linear external update adapter requires target.externalId to match intent.targetExternalId ("${input.target.externalId}" vs "${targetExternalId}").`
    };
  }
  if (
    typeof input.operator.reason !== "string" ||
    input.operator.reason.trim().length === 0
  ) {
    return {
      ok: false,
      code: "validation_failed",
      error: "External update preview requires a non-empty operator reason."
    };
  }
  const statusPayload =
    input.intent.intentType === "status_update"
      ? parseLinearStatusUpdatePayload(input.intent.payload)
      : null;
  if (statusPayload?.ok === false) return statusPayload.error;

  const idempotencyMarker = buildIdempotencyMarker({
    adapterKind: "linear",
    intentId: input.intent.id,
    payload: input.intent.payload
  });

  const target: ExternalUpdateAdapterTarget = {
    adapterKind: "linear",
    externalId: targetExternalId,
    externalKey: input.target.externalKey,
    url: input.target.url,
    title: input.target.title
  };

  return {
    ok: true,
    preview: {
      adapterKind: "linear",
      intentId: input.intent.id,
      intentType: input.intent.intentType,
      target,
      mutationKind:
        input.intent.intentType === "status_update"
          ? "status_transition"
          : "comment",
      summary: renderLinearSummary(input, target),
      commentBody: renderLinearCommentBody(
        input,
        target,
        idempotencyMarker,
        statusPayload?.ok === true ? statusPayload.comment : null
      ),
      idempotencyMarker
    }
  };
}

function renderLinearSummary(
  input: ExternalUpdateAdapterInput,
  target: ExternalUpdateAdapterTarget
): string {
  const label = target.externalKey ?? target.externalId;
  if (input.intent.intentType === "status_update") {
    const statusPayload = parseLinearStatusUpdatePayload(input.intent.payload);
    const destination =
      statusPayload?.ok === true
        ? (statusPayload.stateName ?? statusPayload.stateId)
        : "unknown";
    return `Linear status update on ${label}: ${destination}`;
  }
  return `Linear comment on ${label}: ${input.intent.intentType}`;
}

function renderLinearCommentBody(
  input: ExternalUpdateAdapterInput,
  target: ExternalUpdateAdapterTarget,
  idempotencyMarker: string,
  payloadComment: string | null = null
): string {
  const actor = (input.operator.actor ?? "").trim();
  const actorLine = actor.length > 0 ? actor : "operator";
  const label = target.externalKey ?? target.externalId;
  const bodyReason = payloadComment ?? input.intent.reason;
  const lines = [
    `Momentum: ${input.intent.intentType} for ${label}`,
    "",
    bodyReason,
    "",
    `Operator (${actorLine}): ${input.operator.reason.trim()}`,
    "",
    `idempotency: ${idempotencyMarker}`
  ];
  return lines.join("\n");
}

type LinearStatusUpdatePayload =
  | { ok: true; stateName: string | null; stateId: string | null; comment: string | null }
  | { ok: false; error: ExternalUpdateAdapterError };

function parseLinearStatusUpdatePayload(
  payload: Record<string, unknown>
): LinearStatusUpdatePayload {
  const stateName = optionalNonEmptyString(payload["state"]);
  const stateId = optionalNonEmptyString(payload["stateId"]);
  if (stateName === null && stateId === null) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "validation_failed",
        error:
          'Linear status_update payload requires a non-empty "state" or "stateId".'
      }
    };
  }
  if (stateName !== null && stateId !== null) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "validation_failed",
        error:
          'Linear status_update payload must not include both "state" and "stateId".'
      }
    };
  }
  return {
    ok: true,
    stateName,
    stateId,
    comment: optionalNonEmptyString(payload["comment"])
  };
}

function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBuiltinExternalUpdateAdapterKind(
  kind: string
): kind is BuiltinExternalUpdateAdapterKind {
  return (BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS as readonly string[]).includes(
    kind
  );
}

function validateExternalUpdatePolicy(
  input: ExternalUpdateAdapterInput
): ExternalUpdateAdapterError | null {
  if (input.policy.intentApplyPolicy === "external_apply_allowed") {
    return null;
  }
  return {
    ok: false,
    code: "policy_denied",
    error: `External update preview for intent ${input.intent.id} requires intent_apply_policy=external_apply_allowed (got ${input.policy.intentApplyPolicy}).`
  };
}

function unsupportedAdapterError(kind: string): ExternalUpdateAdapterError {
  const supported = listExternalUpdateAdapterKinds().join(", ") || "<none>";
  return {
    ok: false,
    code: "unsupported_adapter",
    error: `External update adapter "${kind}" is not supported; supported adapters: ${supported}.`
  };
}

function unsupportedIntentTypeError(
  kind: string,
  intentType: string
): ExternalUpdateAdapterError {
  return {
    ok: false,
    code: "unsupported_intent_type",
    error: `External update adapter "${kind}" does not support intent type "${intentType}".`
  };
}

function adapterThrewError(
  kind: string,
  error: unknown
): ExternalUpdateAdapterError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: "adapter_threw",
    error: `External update adapter "${kind}" threw: ${detail}`
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = record[key];
  }
  return sorted;
}
