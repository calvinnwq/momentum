/**
 * HTTP-backed `LinearReconciliationClient` (NGX-289 / M5-02 CLI slice).
 *
 * Drives a single Linear GraphQL `issues` query per page and adapts the
 * response into the orchestrator's `LinearReconciliationFetchPageResult`
 * vocabulary. Credentials never live in Momentum durable state; the caller
 * passes an `apiKey` it sourced from operator-controlled env or config.
 *
 * The client maps:
 *   - missing/empty apiKey → `source_auth_unavailable`
 *   - 401/403 / non-OK auth-shaped responses → `source_auth_unavailable`
 *   - other transport / parse failures → `source_adapter_threw`
 */

import type {
  LinearReconciliationClient,
  LinearReconciliationFetchPageInput,
  LinearReconciliationFetchPageResult,
  LinearReconciliationFilters
} from "./source-reconciliation.js";

export const DEFAULT_LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_LINEAR_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_HTTP_REQUEST_TIMEOUT_MS = 30_000;

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type LinearHttpClientOptions = {
  apiKey?: string | null;
  endpoint?: string;
  pageSize?: number;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
};

class LinearHttpRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`linear http request timed out after ${timeoutMs}ms`);
    this.name = "LinearHttpRequestTimeoutError";
  }
}

const LINEAR_ISSUES_QUERY = `
query MomentumLinearIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      description
      url
      updatedAt
      priority
      state { id name }
      project { id name url }
      projectMilestone { id name }
      labels(first: 25) { nodes { id name } }
      assignee { id name email }
    }
  }
}`.trim();

export function buildLinearHttpReconciliationClient(
  options: LinearHttpClientOptions
): LinearReconciliationClient {
  const apiKey = (options.apiKey ?? "").trim();
  const endpoint = options.endpoint ?? DEFAULT_LINEAR_GRAPHQL_ENDPOINT;
  const pageSize = resolvePageSize(options.pageSize);
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);

  return {
    async fetchPage(
      input: LinearReconciliationFetchPageInput
    ): Promise<LinearReconciliationFetchPageResult> {
      if (apiKey.length === 0) {
        return {
          ok: false,
          code: "source_auth_unavailable",
          error: "LINEAR_API_KEY is unset; linear reconciliation needs a credential."
        };
      }
      if (!fetchImpl) {
        return {
          ok: false,
          code: "source_config_invalid",
          error: "global fetch is unavailable; pass options.fetch to buildLinearHttpReconciliationClient."
        };
      }

      const variables = {
        filter: buildIssueFilter(input.filters),
        first: pageSize,
        after: input.cursor
      };

      let response: Awaited<ReturnType<FetchLike>>;
      let bodyText: string | null;
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      const requestState: { phase: "request" | "response_body" } = { phase: "request" };
      const controller = new AbortController();
      try {
        const requestResult = await Promise.race([
          (async () => {
            const fetched = await fetchImpl(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: apiKey
              },
              body: JSON.stringify({ query: LINEAR_ISSUES_QUERY, variables }),
              signal: controller.signal
            });
            if (fetched.status === 401 || fetched.status === 403 || !fetched.ok) {
              return { response: fetched, bodyText: null };
            }
            requestState.phase = "response_body";
            return { response: fetched, bodyText: await fetched.text() };
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new LinearHttpRequestTimeoutError(requestTimeoutMs));
            }, requestTimeoutMs);
          })
        ]);
        response = requestResult.response;
        bodyText = requestResult.bodyText;
      } catch (error) {
        if (
          error instanceof LinearHttpRequestTimeoutError ||
          (timedOut &&
            error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError"))
        ) {
          return {
            ok: false,
            code: "source_adapter_threw",
            error: `linear http request timed out after ${requestTimeoutMs}ms`
          };
        }
        if (requestState.phase === "response_body") {
          return {
            ok: false,
            code: "source_adapter_threw",
            error: `linear http response body read failed: ${describeError(error)}`
          };
        }
        return {
          ok: false,
          code: "source_adapter_threw",
          error: `linear http transport failed: ${describeError(error)}`
        };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: "source_auth_unavailable",
          error: `Linear API rejected credentials (HTTP ${response.status}).`
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "source_adapter_threw",
          error: `Linear API returned HTTP ${response.status}.`
        };
      }
      if (bodyText === null) {
        return {
          ok: false,
          code: "source_adapter_threw",
          error: "linear http response body was not read"
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        return {
          ok: false,
          code: "source_adapter_threw",
          error: `linear http response was not JSON: ${describeError(error)}`
        };
      }

      return interpretLinearIssuesResponse(parsed);
    }
  };
}

function buildIssueFilter(
  filters: LinearReconciliationFilters
): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {};
  if (filters.projectId !== undefined) {
    filter["project"] = { id: { eq: filters.projectId } };
  } else if (filters.projectName !== undefined) {
    filter["project"] = { name: { eq: filters.projectName } };
  }
  if (filters.milestoneId !== undefined) {
    filter["projectMilestone"] = { id: { eq: filters.milestoneId } };
  } else if (filters.milestoneName !== undefined) {
    filter["projectMilestone"] = { name: { eq: filters.milestoneName } };
  }
  return Object.keys(filter).length === 0 ? null : filter;
}

function interpretLinearIssuesResponse(
  parsed: unknown
): LinearReconciliationFetchPageResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "source_adapter_threw",
      error: "linear http response body was not a JSON object"
    };
  }
  const body = parsed as Record<string, unknown>;
  if (Array.isArray(body["errors"]) && body["errors"].length > 0) {
    const code = detectErrorAuthCode(body["errors"]);
    const description = describeGraphqlErrors(body["errors"]);
    if (code === "source_auth_unavailable") {
      return {
        ok: false,
        code,
        error: `Linear API auth rejected: ${description}`
      };
    }
    return {
      ok: false,
      code: "source_adapter_threw",
      error: `Linear GraphQL errors: ${description}`
    };
  }

  const data = body["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      code: "source_adapter_threw",
      error: "linear http response missing data.issues"
    };
  }
  const issuesField = (data as Record<string, unknown>)["issues"];
  if (!issuesField || typeof issuesField !== "object" || Array.isArray(issuesField)) {
    return {
      ok: false,
      code: "source_adapter_threw",
      error: "linear http response data.issues was not an object"
    };
  }
  const issuesNode = issuesField as Record<string, unknown>;
  const nodes = issuesNode["nodes"];
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      code: "source_adapter_threw",
      error: "linear http response data.issues.nodes was not an array"
    };
  }
  const pageInfo = issuesNode["pageInfo"];
  const nextCursor =
    pageInfo && typeof pageInfo === "object" && !Array.isArray(pageInfo)
      ? extractNextCursor(pageInfo as Record<string, unknown>)
      : null;

  return {
    ok: true,
    page: {
      issues: nodes,
      nextCursor
    }
  };
}

function extractNextCursor(pageInfo: Record<string, unknown>): string | null {
  if (pageInfo["hasNextPage"] !== true) return null;
  const endCursor = pageInfo["endCursor"];
  return typeof endCursor === "string" && endCursor.length > 0 ? endCursor : null;
}

function detectErrorAuthCode(errors: unknown[]): "source_auth_unavailable" | null {
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const extensions = record["extensions"];
    const code =
      extensions && typeof extensions === "object" && !Array.isArray(extensions)
        ? (extensions as Record<string, unknown>)["code"]
        : undefined;
    if (typeof code === "string" && /AUTH/i.test(code)) {
      return "source_auth_unavailable";
    }
    const message = record["message"];
    if (typeof message === "string" && /authentic|unauthor|forbid/i.test(message)) {
      return "source_auth_unavailable";
    }
  }
  return null;
}

function describeGraphqlErrors(errors: unknown[]): string {
  const messages: string[] = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const message = (entry as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0) messages.push(message);
  }
  return messages.length > 0 ? messages.join("; ") : "<no message>";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_LINEAR_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 250) {
    throw new Error(
      `linear http page size must be an integer in [1, 250], got ${pageSize}`
    );
  }
  return pageSize;
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_LINEAR_HTTP_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `linear http request timeout must be a positive integer in milliseconds, got ${timeoutMs}`
    );
  }
  return timeoutMs;
}
