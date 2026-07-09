/**
 * Source adapter boundary.
 *
 * Source adapters read external/source-system items and normalize them into
 * Momentum's SourceItem vocabulary. They do not create or complete Goals, do
 * not perform external writes, and do not own repo safety decisions.
 */

import { buildLinearSourceAdapter } from "./linear-source-adapter.js";

export const BUILTIN_SOURCE_ADAPTER_KINDS = [
  "local-fixture",
  "linear"
] as const;

export type BuiltinSourceAdapterKind =
  (typeof BUILTIN_SOURCE_ADAPTER_KINDS)[number];

export type SourceAdapterErrorCode =
  | "unsupported_source_adapter"
  | "source_adapter_threw"
  | "source_item_not_found"
  | "source_item_invalid"
  | "source_auth_unavailable"
  | "source_config_invalid";

export type SourceAdapterItem = {
  externalId: string;
  externalKey?: string | null;
  url?: string | null;
  title: string;
  status?: string | null;
  metadata?: Record<string, unknown>;
  observedAt: number;
};

export type SourceAdapterClient = {
  fixtures?: {
    items?: readonly SourceAdapterItem[];
  };
  [adapterKind: string]: unknown;
};

export type SourceAdapterListInput = {
  client?: SourceAdapterClient;
};

export type SourceAdapterGetInput = SourceAdapterListInput & {
  externalId: string;
};

export type SourceAdapterNormalizeInput = SourceAdapterListInput & {
  raw: unknown;
};

export type SourceAdapterListSuccess = {
  ok: true;
  items: SourceAdapterItem[];
};

export type SourceAdapterGetSuccess = {
  ok: true;
  item: SourceAdapterItem;
};

export type SourceAdapterError = {
  ok: false;
  code: SourceAdapterErrorCode;
  error: string;
};

export type SourceAdapterListResult =
  | SourceAdapterListSuccess
  | SourceAdapterError;

export type SourceAdapterGetResult = SourceAdapterGetSuccess | SourceAdapterError;

export type SourceAdapterNormalizeResult =
  | SourceAdapterGetSuccess
  | SourceAdapterError;

export type SourceAdapter = {
  kind: BuiltinSourceAdapterKind;
  list: (input: SourceAdapterListInput) => SourceAdapterListResult;
  get: (input: SourceAdapterGetInput) => SourceAdapterGetResult;
  normalize: (input: SourceAdapterNormalizeInput) => SourceAdapterNormalizeResult;
};

export type SourceAdapterDispatchOptions = {
  client?: SourceAdapterClient;
  adapters?: ReadonlyMap<string, SourceAdapter>;
};

const SOURCE_ADAPTERS: ReadonlyMap<BuiltinSourceAdapterKind, SourceAdapter> =
  new Map<BuiltinSourceAdapterKind, SourceAdapter>([
    ["local-fixture", buildLocalFixtureAdapter()],
    ["linear", buildLinearSourceAdapter()]
  ]);

export function listSourceAdapterKinds(): readonly BuiltinSourceAdapterKind[] {
  return BUILTIN_SOURCE_ADAPTER_KINDS;
}

export function getSourceAdapter(kind: string): SourceAdapter | undefined {
  if (!isBuiltinSourceAdapterKind(kind)) return undefined;
  return SOURCE_ADAPTERS.get(kind);
}

export function dispatchSourceAdapterList(
  kind: string,
  options: SourceAdapterDispatchOptions = {}
): SourceAdapterListResult {
  const adapter = resolveSourceAdapter(kind, options.adapters);
  if (!adapter) return unsupportedSourceAdapterError(kind);

  try {
    return adapter.list(buildListInput(options));
  } catch (error) {
    return sourceAdapterThrewError(kind, error);
  }
}

export function dispatchSourceAdapterGet(
  kind: string,
  externalId: string,
  options: SourceAdapterDispatchOptions = {}
): SourceAdapterGetResult {
  const adapter = resolveSourceAdapter(kind, options.adapters);
  if (!adapter) return unsupportedSourceAdapterError(kind);

  try {
    return adapter.get(buildGetInput(externalId, options));
  } catch (error) {
    return sourceAdapterThrewError(kind, error);
  }
}

export function dispatchSourceAdapterNormalize(
  kind: string,
  raw: unknown,
  options: SourceAdapterDispatchOptions = {}
): SourceAdapterNormalizeResult {
  const adapter = resolveSourceAdapter(kind, options.adapters);
  if (!adapter) return unsupportedSourceAdapterError(kind);

  try {
    return adapter.normalize(buildNormalizeInput(raw, options));
  } catch (error) {
    return sourceAdapterThrewError(kind, error);
  }
}

function buildListInput(
  options: SourceAdapterDispatchOptions
): SourceAdapterListInput {
  return options.client === undefined ? {} : { client: options.client };
}

function buildGetInput(
  externalId: string,
  options: SourceAdapterDispatchOptions
): SourceAdapterGetInput {
  return options.client === undefined
    ? { externalId }
    : { externalId, client: options.client };
}

function buildNormalizeInput(
  raw: unknown,
  options: SourceAdapterDispatchOptions
): SourceAdapterNormalizeInput {
  return options.client === undefined ? { raw } : { raw, client: options.client };
}

function buildLocalFixtureAdapter(): SourceAdapter {
  return {
    kind: "local-fixture",
    list: (input: SourceAdapterListInput): SourceAdapterListResult => ({
      ok: true,
      items: [...(input.client?.fixtures?.items ?? [])]
    }),
    get: (input: SourceAdapterGetInput): SourceAdapterGetResult => {
      const item = input.client?.fixtures?.items?.find(
        (candidate) => candidate.externalId === input.externalId
      );
      if (!item) {
        return {
          ok: false,
          code: "source_item_not_found",
          error: `Source item "${input.externalId}" was not found by adapter "local-fixture".`
        };
      }
      return { ok: true, item };
    },
    normalize: (input: SourceAdapterNormalizeInput): SourceAdapterNormalizeResult =>
      normalizeLocalFixtureSourceItem(input.raw)
  };
}

function normalizeLocalFixtureSourceItem(raw: unknown): SourceAdapterNormalizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return sourceItemInvalidError("local-fixture", "raw source item must be an object");
  }

  const record = raw as Record<string, unknown>;
  const externalId = record["externalId"];
  const title = record["title"];
  const observedAt = record["observedAt"];

  if (typeof externalId !== "string" || externalId.length === 0) {
    return sourceItemInvalidError("local-fixture", "externalId must be a non-empty string");
  }
  if (typeof title !== "string" || title.length === 0) {
    return sourceItemInvalidError("local-fixture", "title must be a non-empty string");
  }
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return sourceItemInvalidError("local-fixture", "observedAt must be a finite number");
  }

  const item: SourceAdapterItem = {
    externalId,
    title,
    observedAt
  };

  const externalKey = optionalStringOrNull(record["externalKey"]);
  if (externalKey !== undefined) item.externalKey = externalKey;
  const url = optionalStringOrNull(record["url"]);
  if (url !== undefined) item.url = url;
  const status = optionalStringOrNull(record["status"]);
  if (status !== undefined) item.status = status;
  const metadata = optionalRecord(record["metadata"]);
  if (metadata !== undefined) item.metadata = metadata;

  return { ok: true, item };
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  return undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function resolveSourceAdapter(
  kind: string,
  adapters: ReadonlyMap<string, SourceAdapter> | undefined
): SourceAdapter | undefined {
  if (adapters) return adapters.get(kind);
  return getSourceAdapter(kind);
}

function isBuiltinSourceAdapterKind(
  kind: string
): kind is BuiltinSourceAdapterKind {
  return (BUILTIN_SOURCE_ADAPTER_KINDS as readonly string[]).includes(kind);
}

function unsupportedSourceAdapterError(kind: string): SourceAdapterError {
  return {
    ok: false,
    code: "unsupported_source_adapter",
    error: `Source adapter "${kind}" is not supported; supported adapters: ${listSourceAdapterKinds().join(", ") || "<none>"}.`
  };
}

function sourceAdapterThrewError(
  kind: string,
  error: unknown
): SourceAdapterError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: "source_adapter_threw",
    error: `Source adapter "${kind}" threw: ${detail}`
  };
}

function sourceItemInvalidError(kind: string, reason: string): SourceAdapterError {
  return {
    ok: false,
    code: "source_item_invalid",
    error: `Source adapter "${kind}" could not normalize source item: ${reason}.`
  };
}
