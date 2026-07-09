/**
 * Targeted Linear issue refresh primitive.
 *
 * Fetches a single Linear issue plus all of its comments without leaning on the
 * project-/milestone-wide reconciliation pipeline. The result feeds the
 * post-apply reconcile orchestrator, which decides whether the external write
 * is reflected in Linear and persists a fresh SourceItem snapshot.
 *
 * The client is intentionally narrow:
 *
 *  - It accepts an explicit target keyed by issue id, identifier (e.g. ABC-1),
 *    or URL. The Linear GraphQL `issue(id: ...)` field accepts any of the
 *    three, so the caller does not have to know which form to pass.
 *  - It does not persist credentials. The caller supplies an `apiKey` it
 *    sourced from operator-controlled env/config.
 *  - It walks the comments connection so the marker scan can be exhaustive.
 *  - It maps HTTP, GraphQL, auth, timeout/network, malformed JSON, and missing
 *    target failures to a small stable code taxonomy.
 *
 * The orchestrator (`post-apply-reconcile.ts`) translates these into the
 * post-apply reconciliation outcome taxonomy. Tests inject a mock fetch and the
 * adapter tests forbid real `api.linear.app` calls from this boundary.
 */

export const DEFAULT_LINEAR_ISSUE_REFRESH_ENDPOINT =
  "https://api.linear.app/graphql";
export const DEFAULT_LINEAR_ISSUE_REFRESH_REQUEST_TIMEOUT_MS = 30_000;

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

export type LinearIssueRefreshClientOptions = {
  apiKey?: string | null;
  endpoint?: string;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
};

export type LinearIssueRefreshTarget =
  | { kind: "id"; value: string }
  | { kind: "key"; value: string }
  | { kind: "url"; value: string };

export const LINEAR_ISSUE_REFRESH_RESULT_CODES = Object.freeze([
  "auth_unavailable",
  "target_missing",
  "refresh_timeout",
  "malformed_response",
  "adapter_threw"
] as const);

export type LinearIssueRefreshResultCode =
  (typeof LINEAR_ISSUE_REFRESH_RESULT_CODES)[number];

export type LinearIssueRefreshComment = {
  id: string;
  body: string;
  url: string | null;
};

export type LinearIssueRefreshSuccess = {
  ok: true;
  /**
   * The raw Linear issue node returned by GraphQL. Callers normalize this via
   * `normalizeLinearIssue` rather than relying on a shape provided here so
   * future Linear payload additions automatically flow through.
   */
  issue: unknown;
  comments: ReadonlyArray<LinearIssueRefreshComment>;
};

export type LinearIssueRefreshError = {
  ok: false;
  code: LinearIssueRefreshResultCode;
  error: string;
};

export type LinearIssueRefreshResult =
  | LinearIssueRefreshSuccess
  | LinearIssueRefreshError;

export type LinearIssueRefreshClient = {
  refresh: (input: {
    target: LinearIssueRefreshTarget;
  }) => Promise<LinearIssueRefreshResult>;
};

const ISSUE_QUERY = `
query MomentumIssueRefresh($id: String!) {
  issue(id: $id) {
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
    comments(first: 50) {
      nodes { id body url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

const ISSUE_COMMENTS_PAGE_QUERY = `
query MomentumIssueRefreshCommentsPage($id: String!, $after: String!) {
  issue(id: $id) {
    comments(first: 50, after: $after) {
      nodes { id body url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

class LinearIssueRefreshTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`linear issue refresh request timed out after ${timeoutMs}ms`);
    this.name = "LinearIssueRefreshTimeoutError";
  }
}

type GraphqlResponse = {
  status: number;
  body: unknown;
};

type GraphqlTransportResult =
  | { ok: true; response: GraphqlResponse }
  | { ok: false; failure: LinearIssueRefreshError };

export function buildLinearIssueRefreshClient(
  options: LinearIssueRefreshClientOptions
): LinearIssueRefreshClient {
  const apiKey = (options.apiKey ?? "").trim();
  const endpoint = options.endpoint ?? DEFAULT_LINEAR_ISSUE_REFRESH_ENDPOINT;
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const fetchImpl =
    options.fetch ?? (globalThis.fetch as FetchLike | undefined);

  return {
    async refresh({ target }) {
      if (apiKey.length === 0) {
        return authUnavailable(
          "LINEAR_API_KEY is unset; linear issue refresh needs a credential."
        );
      }
      if (!fetchImpl) {
        return {
          ok: false,
          code: "adapter_threw",
          error:
            "global fetch is unavailable; pass options.fetch to buildLinearIssueRefreshClient."
        };
      }
      const id = target.value;
      if (typeof id !== "string" || id.length === 0) {
        return {
          ok: false,
          code: "target_missing",
          error: "linear issue refresh requires a non-empty target value."
        };
      }

      const transport = await sendGraphql(
        fetchImpl,
        endpoint,
        apiKey,
        requestTimeoutMs,
        ISSUE_QUERY,
        { id }
      );
      if (!transport.ok) {
        return transport.failure;
      }

      const issueResult = readIssue(transport.response.body);
      if (!issueResult.ok) {
        return issueResult.error;
      }

      const collected: LinearIssueRefreshComment[] = [];
      collected.push(...issueResult.commentsPage.comments);
      let page = issueResult.commentsPage;
      while (page.hasNextPage) {
        if (!page.endCursor) {
          return {
            ok: false,
            code: "malformed_response",
            error:
              "Linear comments pageInfo indicated another page without endCursor."
          };
        }
        const nextTransport = await sendGraphql(
          fetchImpl,
          endpoint,
          apiKey,
          requestTimeoutMs,
          ISSUE_COMMENTS_PAGE_QUERY,
          { id, after: page.endCursor }
        );
        if (!nextTransport.ok) {
          return nextTransport.failure;
        }
        const nextPage = readCommentsPage(
          extractIssueField(nextTransport.response.body, "comments"),
          "Linear issue comments page lookup"
        );
        if (!nextPage.ok) return nextPage.error;
        collected.push(...nextPage.page.comments);
        page = nextPage.page;
      }

      return {
        ok: true,
        issue: issueResult.issue,
        comments: collected
      };
    }
  };
}

type ReadIssueResult =
  | {
      ok: true;
      issue: unknown;
      commentsPage: CommentsPage;
    }
  | {
      ok: false;
      error: LinearIssueRefreshError;
    };

function readIssue(body: unknown): ReadIssueResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear issue refresh response body was not a JSON object."
      }
    };
  }
  const errors = (body as Record<string, unknown>)["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    if (detectGraphqlAuthCode(errors)) {
      return {
        ok: false,
        error: {
          ok: false,
          code: "auth_unavailable",
          error: `Linear GraphQL auth rejected: ${describeGraphqlErrors(errors)}`
        }
      };
    }
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: `Linear GraphQL errors: ${describeGraphqlErrors(errors)}`
      }
    };
  }

  const data = (body as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear issue refresh response missing data.issue."
      }
    };
  }
  const issue = (data as Record<string, unknown>)["issue"];
  if (issue === null) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_missing",
        error: "Linear issue refresh returned no issue."
      }
    };
  }
  if (typeof issue !== "object" || Array.isArray(issue)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear issue refresh returned a non-object issue payload."
      }
    };
  }

  const commentsField = (issue as Record<string, unknown>)["comments"];
  const commentsPage = readCommentsPage(commentsField, "Linear issue refresh");
  if (!commentsPage.ok) return { ok: false, error: commentsPage.error };

  return { ok: true, issue, commentsPage: commentsPage.page };
}

function extractIssueField(body: unknown, field: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const issue = (data as Record<string, unknown>)["issue"];
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return undefined;
  return (issue as Record<string, unknown>)[field];
}

type CommentsPage = {
  comments: ReadonlyArray<LinearIssueRefreshComment>;
  hasNextPage: boolean;
  endCursor: string | null;
};

type CommentsPageReadResult =
  | { ok: true; page: CommentsPage }
  | { ok: false; error: LinearIssueRefreshError };

function readCommentsPage(
  raw: unknown,
  context: string
): CommentsPageReadResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return malformed(context, "is missing a comments connection");
  }
  const record = raw as Record<string, unknown>;
  const nodes = record["nodes"];
  if (!Array.isArray(nodes)) {
    return malformed(context, "comments.nodes is not an array");
  }
  const out: LinearIssueRefreshComment[] = [];
  for (const entry of nodes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return malformed(context, "comments.nodes contains a non-object node");
    }
    const commentRecord = entry as Record<string, unknown>;
    const id = optionalString(commentRecord["id"]);
    const body = commentRecord["body"];
    if (!id || typeof body !== "string") {
      return malformed(
        context,
        "comments.nodes contains a node without a string id and body"
      );
    }
    out.push({
      id,
      body,
      url: optionalString(commentRecord["url"]) ?? null
    });
  }
  const pageInfo = record["pageInfo"];
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) {
    return malformed(context, "comments.pageInfo is missing or invalid");
  }
  const pageInfoRecord = pageInfo as Record<string, unknown>;
  const hasNextPage = pageInfoRecord["hasNextPage"];
  if (typeof hasNextPage !== "boolean") {
    return malformed(context, "comments.pageInfo.hasNextPage is not a boolean");
  }
  const rawEndCursor = pageInfoRecord["endCursor"];
  if (
    rawEndCursor !== null &&
    rawEndCursor !== undefined &&
    typeof rawEndCursor !== "string"
  ) {
    return malformed(
      context,
      "comments.pageInfo.endCursor is not a string or null"
    );
  }
  return {
    ok: true,
    page: {
      comments: out,
      hasNextPage,
      endCursor:
        typeof rawEndCursor === "string" && rawEndCursor.length > 0
          ? rawEndCursor
          : null
    }
  };
}

function malformed(context: string, detail: string): CommentsPageReadResult {
  return {
    ok: false,
    error: {
      ok: false,
      code: "malformed_response",
      error: `${context} returned a malformed comments page: ${detail}.`
    }
  };
}

async function sendGraphql(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  query: string,
  variables: Record<string, unknown>
): Promise<GraphqlTransportResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const requestState: { phase: "request" | "response_body" } = {
    phase: "request"
  };

  try {
    const requestPromise = (async () => {
      const fetched = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      if (fetched.status === 401 || fetched.status === 403 || !fetched.ok) {
        return { response: fetched, bodyText: null as string | null };
      }
      requestState.phase = "response_body";
      return { response: fetched, bodyText: await fetched.text() };
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new LinearIssueRefreshTimeoutError(requestTimeoutMs));
      }, requestTimeoutMs);
    });

    const settled = await Promise.race([requestPromise, timeoutPromise]);
    const response = settled.response;
    const bodyText = settled.bodyText;

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "auth_unavailable",
          error: `Linear API rejected credentials (HTTP ${response.status}).`
        }
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "adapter_threw",
          error: `Linear API returned HTTP ${response.status}.`
        }
      };
    }
    if (bodyText === null) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "adapter_threw",
          error: "linear issue refresh response body was not read"
        }
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "malformed_response",
          error: `linear issue refresh response was not JSON: ${describeError(error)}`
        }
      };
    }

    return { ok: true, response: { status: response.status, body: parsed } };
  } catch (error) {
    if (
      error instanceof LinearIssueRefreshTimeoutError ||
      (timedOut &&
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "refresh_timeout",
          error: `linear issue refresh request timed out after ${requestTimeoutMs}ms`
        }
      };
    }
    if (requestState.phase === "response_body") {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "adapter_threw",
          error: `linear issue refresh response body read failed: ${describeError(error)}`
        }
      };
    }
    return {
      ok: false,
      failure: {
        ok: false,
        code: "adapter_threw",
        error: `linear issue refresh transport failed: ${describeError(error)}`
      }
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function detectGraphqlAuthCode(errors: unknown[]): "auth_unavailable" | null {
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const extensions = record["extensions"];
    const extCode =
      extensions && typeof extensions === "object" && !Array.isArray(extensions)
        ? (extensions as Record<string, unknown>)["code"]
        : undefined;
    if (typeof extCode === "string" && /AUTH/i.test(extCode)) {
      return "auth_unavailable";
    }
    const message = record["message"];
    if (
      typeof message === "string" &&
      /authentic|unauthor|forbid|not[\s_-]?authorized/i.test(message)
    ) {
      return "auth_unavailable";
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function authUnavailable(message: string): LinearIssueRefreshError {
  return { ok: false, code: "auth_unavailable", error: message };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_LINEAR_ISSUE_REFRESH_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `linear issue refresh request timeout must be a positive integer in milliseconds, got ${timeoutMs}`
    );
  }
  return timeoutMs;
}
