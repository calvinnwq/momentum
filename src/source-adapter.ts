/**
 * Source adapter boundary introduced by NGX-288 (M5-01).
 *
 * Source adapters read external/source-system items and normalize them into
 * Momentum's SourceItem vocabulary. They do not create or complete Goals, do
 * not perform external writes, and do not own repo safety decisions.
 */

export const BUILTIN_SOURCE_ADAPTER_KINDS = ["local-fixture"] as const;

export type BuiltinSourceAdapterKind =
  (typeof BUILTIN_SOURCE_ADAPTER_KINDS)[number];

export type SourceAdapterErrorCode =
  | "unsupported_source_adapter"
  | "source_adapter_threw"
  | "source_item_not_found";

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
};

export type SourceAdapterListInput = {
  client?: SourceAdapterClient;
};

export type SourceAdapterGetInput = SourceAdapterListInput & {
  externalId: string;
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

export type SourceAdapter = {
  kind: BuiltinSourceAdapterKind;
  list: (input: SourceAdapterListInput) => SourceAdapterListResult;
  get: (input: SourceAdapterGetInput) => SourceAdapterGetResult;
};

export type SourceAdapterDispatchOptions = {
  client?: SourceAdapterClient;
  adapters?: ReadonlyMap<string, SourceAdapter>;
};

const SOURCE_ADAPTERS: ReadonlyMap<BuiltinSourceAdapterKind, SourceAdapter> =
  new Map([["local-fixture", buildLocalFixtureAdapter()]]);

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
    }
  };
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
