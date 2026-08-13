/**
 * Tracker adapter boundary.
 *
 * Tracker adapters read external tracker-system items and normalize them into
 * Momentum's TrackerItem vocabulary. They do not create or complete Goals, do
 * not perform external writes, and do not own repo safety decisions.
 */

import { buildLinearTrackerAdapter } from "./linear-tracker-adapter.js";

export const BUILTIN_TRACKER_ADAPTER_KINDS = [
  "local-fixture",
  "linear",
] as const;

export type BuiltinTrackerAdapterKind =
  (typeof BUILTIN_TRACKER_ADAPTER_KINDS)[number];

export type TrackerAdapterErrorCode =
  | "unsupported_tracker_adapter"
  | "tracker_adapter_threw"
  | "tracker_item_not_found"
  | "tracker_item_invalid"
  | "tracker_auth_unavailable"
  | "tracker_config_invalid";

export type TrackerAdapterItem = {
  externalId: string;
  externalKey?: string | null;
  url?: string | null;
  title: string;
  status?: string | null;
  metadata?: Record<string, unknown>;
  observedAt: number;
};

export type TrackerAdapterClient = {
  fixtures?: {
    items?: readonly TrackerAdapterItem[];
  };
  [adapterKind: string]: unknown;
};

export type TrackerAdapterListInput = {
  client?: TrackerAdapterClient;
};

export type TrackerAdapterGetInput = TrackerAdapterListInput & {
  externalId: string;
};

export type TrackerAdapterNormalizeInput = TrackerAdapterListInput & {
  raw: unknown;
};

export type TrackerAdapterListSuccess = {
  ok: true;
  items: TrackerAdapterItem[];
};

export type TrackerAdapterGetSuccess = {
  ok: true;
  item: TrackerAdapterItem;
};

export type TrackerAdapterError = {
  ok: false;
  code: TrackerAdapterErrorCode;
  error: string;
};

export type TrackerAdapterListResult =
  TrackerAdapterListSuccess | TrackerAdapterError;

export type TrackerAdapterGetResult =
  TrackerAdapterGetSuccess | TrackerAdapterError;

export type TrackerAdapterNormalizeResult =
  TrackerAdapterGetSuccess | TrackerAdapterError;

export type TrackerAdapter = {
  kind: BuiltinTrackerAdapterKind;
  list: (input: TrackerAdapterListInput) => TrackerAdapterListResult;
  get: (input: TrackerAdapterGetInput) => TrackerAdapterGetResult;
  normalize: (
    input: TrackerAdapterNormalizeInput,
  ) => TrackerAdapterNormalizeResult;
};

export type TrackerAdapterDispatchOptions = {
  client?: TrackerAdapterClient;
  adapters?: ReadonlyMap<string, TrackerAdapter>;
};

const TRACKER_ADAPTERS: ReadonlyMap<BuiltinTrackerAdapterKind, TrackerAdapter> =
  new Map<BuiltinTrackerAdapterKind, TrackerAdapter>([
    ["local-fixture", buildLocalFixtureAdapter()],
    ["linear", buildLinearTrackerAdapter()],
  ]);

export function listTrackerAdapterKinds(): readonly BuiltinTrackerAdapterKind[] {
  return BUILTIN_TRACKER_ADAPTER_KINDS;
}

export function getTrackerAdapter(kind: string): TrackerAdapter | undefined {
  if (!isBuiltinTrackerAdapterKind(kind)) return undefined;
  return TRACKER_ADAPTERS.get(kind);
}

export function dispatchTrackerAdapterList(
  kind: string,
  options: TrackerAdapterDispatchOptions = {},
): TrackerAdapterListResult {
  const adapter = resolveTrackerAdapter(kind, options.adapters);
  if (!adapter) return unsupportedTrackerAdapterError(kind);

  try {
    return adapter.list(buildListInput(options));
  } catch (error) {
    return trackerAdapterThrewError(kind, error);
  }
}

export function dispatchTrackerAdapterGet(
  kind: string,
  externalId: string,
  options: TrackerAdapterDispatchOptions = {},
): TrackerAdapterGetResult {
  const adapter = resolveTrackerAdapter(kind, options.adapters);
  if (!adapter) return unsupportedTrackerAdapterError(kind);

  try {
    return adapter.get(buildGetInput(externalId, options));
  } catch (error) {
    return trackerAdapterThrewError(kind, error);
  }
}

export function dispatchTrackerAdapterNormalize(
  kind: string,
  raw: unknown,
  options: TrackerAdapterDispatchOptions = {},
): TrackerAdapterNormalizeResult {
  const adapter = resolveTrackerAdapter(kind, options.adapters);
  if (!adapter) return unsupportedTrackerAdapterError(kind);

  try {
    return adapter.normalize(buildNormalizeInput(raw, options));
  } catch (error) {
    return trackerAdapterThrewError(kind, error);
  }
}

function buildListInput(
  options: TrackerAdapterDispatchOptions,
): TrackerAdapterListInput {
  return options.client === undefined ? {} : { client: options.client };
}

function buildGetInput(
  externalId: string,
  options: TrackerAdapterDispatchOptions,
): TrackerAdapterGetInput {
  return options.client === undefined
    ? { externalId }
    : { externalId, client: options.client };
}

function buildNormalizeInput(
  raw: unknown,
  options: TrackerAdapterDispatchOptions,
): TrackerAdapterNormalizeInput {
  return options.client === undefined
    ? { raw }
    : { raw, client: options.client };
}

function buildLocalFixtureAdapter(): TrackerAdapter {
  return {
    kind: "local-fixture",
    list: (input: TrackerAdapterListInput): TrackerAdapterListResult => ({
      ok: true,
      items: [...(input.client?.fixtures?.items ?? [])],
    }),
    get: (input: TrackerAdapterGetInput): TrackerAdapterGetResult => {
      const item = input.client?.fixtures?.items?.find(
        (candidate) => candidate.externalId === input.externalId,
      );
      if (!item) {
        return {
          ok: false,
          code: "tracker_item_not_found",
          error: `Tracker item "${input.externalId}" was not found by adapter "local-fixture".`,
        };
      }
      return { ok: true, item };
    },
    normalize: (
      input: TrackerAdapterNormalizeInput,
    ): TrackerAdapterNormalizeResult =>
      normalizeLocalFixtureTrackerItem(input.raw),
  };
}

function normalizeLocalFixtureTrackerItem(
  raw: unknown,
): TrackerAdapterNormalizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return trackerItemInvalidError(
      "local-fixture",
      "raw tracker item must be an object",
    );
  }

  const record = raw as Record<string, unknown>;
  const externalId = record["externalId"];
  const title = record["title"];
  const observedAt = record["observedAt"];

  if (typeof externalId !== "string" || externalId.length === 0) {
    return trackerItemInvalidError(
      "local-fixture",
      "externalId must be a non-empty string",
    );
  }
  if (typeof title !== "string" || title.length === 0) {
    return trackerItemInvalidError(
      "local-fixture",
      "title must be a non-empty string",
    );
  }
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return trackerItemInvalidError(
      "local-fixture",
      "observedAt must be a finite number",
    );
  }

  const item: TrackerAdapterItem = {
    externalId,
    title,
    observedAt,
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

function resolveTrackerAdapter(
  kind: string,
  adapters: ReadonlyMap<string, TrackerAdapter> | undefined,
): TrackerAdapter | undefined {
  if (adapters) return adapters.get(kind);
  return getTrackerAdapter(kind);
}

function isBuiltinTrackerAdapterKind(
  kind: string,
): kind is BuiltinTrackerAdapterKind {
  return (BUILTIN_TRACKER_ADAPTER_KINDS as readonly string[]).includes(kind);
}

function unsupportedTrackerAdapterError(kind: string): TrackerAdapterError {
  return {
    ok: false,
    code: "unsupported_tracker_adapter",
    error: `Tracker adapter "${kind}" is not supported; supported adapters: ${listTrackerAdapterKinds().join(", ") || "<none>"}.`,
  };
}

function trackerAdapterThrewError(
  kind: string,
  error: unknown,
): TrackerAdapterError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: "tracker_adapter_threw",
    error: `Tracker adapter "${kind}" threw: ${detail}`,
  };
}

function trackerItemInvalidError(
  kind: string,
  reason: string,
): TrackerAdapterError {
  return {
    ok: false,
    code: "tracker_item_invalid",
    error: `Tracker adapter "${kind}" could not normalize tracker item: ${reason}.`,
  };
}
