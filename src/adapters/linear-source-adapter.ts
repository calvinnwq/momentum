/**
 * Linear source adapter (NGX-289 / M5-02).
 *
 * This module owns the read-only normalization of Linear issue payloads into
 * Momentum's SourceAdapterItem vocabulary, plus the in-process list/get
 * surface used by tests and local callers that already have Linear issue
 * payloads. Normalization requires Linear's stable identity/title/url/update
 * fields, preserves the raw issue payload under metadata, and folds optional
 * project, milestone, label, assignee, state, and priority fields into
 * structured local metadata without treating those optional shapes as writes.
 *
 * The adapter never performs HTTP itself, never reads credentials, and never
 * writes back to Linear. The paginated reconciliation orchestrator lives in
 * `source-reconciliation.ts` and normalizes each fetched issue through
 * `normalizeLinearIssue`; the HTTP-backed Linear client lives in
 * `linear-http-client.ts` and handles GraphQL transport, pagination input,
 * and auth/transport error mapping before the orchestrator persists local
 * SourceItem rows and snapshots.
 */

import type {
  SourceAdapter,
  SourceAdapterError,
  SourceAdapterGetInput,
  SourceAdapterGetResult,
  SourceAdapterItem,
  SourceAdapterListInput,
  SourceAdapterListResult,
  SourceAdapterNormalizeInput,
  SourceAdapterNormalizeResult
} from "./source-adapter.js";

export const LINEAR_SOURCE_ADAPTER_KIND = "linear" as const;

export type LinearSourceAdapterFilters = {
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
};

export type LinearSourceAdapterClient = {
  issues?: readonly unknown[];
  filters?: LinearSourceAdapterFilters;
};

export function buildLinearSourceAdapter(): SourceAdapter {
  return {
    kind: LINEAR_SOURCE_ADAPTER_KIND,
    list: linearAdapterList,
    get: linearAdapterGet,
    normalize: linearAdapterNormalize
  };
}

export function normalizeLinearIssue(raw: unknown): SourceAdapterNormalizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("raw Linear issue must be an object");
  }
  const record = raw as Record<string, unknown>;

  const externalId = requireString(record["id"]);
  if (externalId === null) return invalid("id must be a non-empty string");

  const identifier = requireString(record["identifier"]);
  if (identifier === null) {
    return invalid("identifier must be a non-empty string");
  }

  const title = requireString(record["title"]);
  if (title === null) return invalid("title must be a non-empty string");

  const url = requireString(record["url"]);
  if (url === null) return invalid("url must be a non-empty string");

  const updatedAt = parseUpdatedAt(record["updatedAt"]);
  if (updatedAt === null) {
    return invalid("updatedAt must be a finite ISO-8601 timestamp");
  }

  const stateName = optionalNestedName(record["state"]);
  const projectInfo = optionalProjectInfo(record["project"]);
  const milestoneInfo = optionalMilestoneInfo(record["projectMilestone"]);
  const labelNames = optionalLabelNames(record["labels"]);
  const assigneeInfo = optionalAssigneeInfo(record["assignee"]);
  const priority = optionalNumber(record["priority"]);

  const metadata: Record<string, unknown> = { raw: record };
  if (projectInfo) metadata["project"] = projectInfo;
  if (milestoneInfo) metadata["milestone"] = milestoneInfo;
  if (labelNames !== undefined) metadata["labels"] = labelNames;
  if (assigneeInfo !== undefined) metadata["assignee"] = assigneeInfo;
  if (priority !== undefined) metadata["priority"] = priority;

  const item: SourceAdapterItem = {
    externalId,
    externalKey: identifier,
    url,
    title,
    status: stateName,
    metadata,
    observedAt: updatedAt
  };

  return { ok: true, item };
}

function linearAdapterNormalize(
  input: SourceAdapterNormalizeInput
): SourceAdapterNormalizeResult {
  return normalizeLinearIssue(input.raw);
}

function linearAdapterList(
  input: SourceAdapterListInput
): SourceAdapterListResult {
  const client = (input.client?.["linear"] ?? undefined) as
    | LinearSourceAdapterClient
    | undefined;
  const issues = client?.issues ?? [];
  const filters = client?.filters ?? {};

  const items: SourceAdapterItem[] = [];
  for (const raw of issues) {
    if (!matchesLinearFilters(raw, filters)) continue;
    const normalized = normalizeLinearIssue(raw);
    if (!normalized.ok) return normalized;
    items.push(normalized.item);
  }
  return { ok: true, items };
}

function linearAdapterGet(
  input: SourceAdapterGetInput
): SourceAdapterGetResult {
  const client = (input.client?.["linear"] ?? undefined) as
    | LinearSourceAdapterClient
    | undefined;
  const issues = client?.issues ?? [];

  for (const raw of issues) {
    const candidateId = readStringField(raw, "id");
    const candidateKey = readStringField(raw, "identifier");
    if (candidateId !== input.externalId && candidateKey !== input.externalId) {
      continue;
    }
    const normalized = normalizeLinearIssue(raw);
    if (!normalized.ok) return normalized;
    return normalized;
  }

  return {
    ok: false,
    code: "source_item_not_found",
    error: `Source item "${input.externalId}" was not found by adapter "${LINEAR_SOURCE_ADAPTER_KIND}".`
  };
}

function matchesLinearFilters(
  raw: unknown,
  filters: LinearSourceAdapterFilters
): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;

  if (filters.projectId !== undefined) {
    const id = readNestedField(record["project"], "id");
    if (id !== filters.projectId) return false;
  }
  if (filters.projectName !== undefined) {
    const name = readNestedField(record["project"], "name");
    if (name !== filters.projectName) return false;
  }
  if (filters.milestoneId !== undefined) {
    const id = readNestedField(record["projectMilestone"], "id");
    if (id !== filters.milestoneId) return false;
  }
  if (filters.milestoneName !== undefined) {
    const name = readNestedField(record["projectMilestone"], "name");
    if (name !== filters.milestoneName) return false;
  }
  return true;
}

function parseUpdatedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringField(raw: unknown, field: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNestedField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inner = (value as Record<string, unknown>)[field];
  return typeof inner === "string" && inner.length > 0 ? inner : null;
}

function optionalNestedName(value: unknown): string | null {
  return readNestedField(value, "name");
}

type LinearProjectInfo = {
  id: string | null;
  key: string | null;
  name: string | null;
  url: string | null;
};

function optionalProjectInfo(value: unknown): LinearProjectInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info: LinearProjectInfo = {
    id: readNestedField(value, "id"),
    key: readNestedField(value, "key"),
    name: readNestedField(value, "name"),
    url: readNestedField(value, "url")
  };
  if (info.id === null && info.key === null && info.name === null && info.url === null) {
    return null;
  }
  return info;
}

type LinearMilestoneInfo = {
  id: string | null;
  name: string | null;
};

function optionalMilestoneInfo(value: unknown): LinearMilestoneInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info: LinearMilestoneInfo = {
    id: readNestedField(value, "id"),
    name: readNestedField(value, "name")
  };
  if (info.id === null && info.name === null) return null;
  return info;
}

function optionalLabelNames(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nodes = (value as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return undefined;
  const names: string[] = [];
  for (const node of nodes) {
    const name = readStringField(node, "name");
    if (name !== null) names.push(name);
  }
  return names;
}

type LinearAssigneeInfo = {
  id: string | null;
  name: string | null;
  email: string | null;
};

function optionalAssigneeInfo(value: unknown): LinearAssigneeInfo | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const info: LinearAssigneeInfo = {
    id: readNestedField(value, "id"),
    name: readNestedField(value, "name"),
    email: readNestedField(value, "email")
  };
  if (info.id === null && info.name === null && info.email === null) {
    return null;
  }
  return info;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalid(reason: string): SourceAdapterError {
  return {
    ok: false,
    code: "source_item_invalid",
    error: `Source adapter "${LINEAR_SOURCE_ADAPTER_KIND}" could not normalize source item: ${reason}.`
  };
}
