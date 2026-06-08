import { describe, expect, it } from "vitest";

import {
  buildLinearHttpReconciliationClient,
  DEFAULT_LINEAR_GRAPHQL_ENDPOINT,
  DEFAULT_LINEAR_PAGE_SIZE,
  type FetchLike
} from "../src/linear-http-client.js";
import type {
  LinearReconciliationFetchPageResult,
  LinearReconciliationFilters
} from "../src/source-reconciliation.js";

type CapturedFetchCall = {
  endpoint: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
};

type FetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

/**
 * Builds a mock `FetchLike` that records every call and delegates the response
 * to `handler`. Every read-side test injects one of these so the client never
 * touches the network (see the "no real api.linear.app calls" guard below).
 */
function recordingFetch(
  handler: (call: CapturedFetchCall) => FetchResponse | Promise<FetchResponse>
): { fetch: FetchLike; calls: CapturedFetchCall[] } {
  const calls: CapturedFetchCall[] = [];
  const fetch: FetchLike = async (endpoint, init) => {
    const call: CapturedFetchCall = { endpoint, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

function jsonOk(body: unknown): FetchResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function statusResponse(status: number, bodyText = ""): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText
  };
}

function issuesPageBody(opts: {
  nodes?: readonly unknown[];
  pageInfo?: unknown;
}): { data: { issues: Record<string, unknown> } } {
  const issues: Record<string, unknown> = { nodes: opts.nodes ?? [] };
  if (opts.pageInfo !== undefined) issues["pageInfo"] = opts.pageInfo;
  return { data: { issues } };
}

function requireFirstCall(calls: CapturedFetchCall[]): CapturedFetchCall {
  const call = calls[0];
  if (!call) throw new Error("expected the client to issue a fetch call");
  return call;
}

function parseRequestBody(call: CapturedFetchCall): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(call.init.body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

describe("buildLinearHttpReconciliationClient", () => {
  it("maps project name filters to Linear project name variables", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (
      _input: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
      }
    ) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: []
              }
            }
          })
      };
    };

    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      fetch
    });

    const result = await client.fetchPage({
      cursor: null,
      filters: { projectName: "Momentum", milestoneName: "Milestone 5" }
    });

    expect(result).toEqual({
      ok: true,
      page: { issues: [], nextCursor: null }
    });
    expect(bodies[0]?.["variables"]).toEqual({
      filter: {
        project: { name: { eq: "Momentum" } },
        projectMilestone: { name: { eq: "Milestone 5" } }
      },
      first: 50,
      after: null
    });
  });

  it("requests and preserves Linear issue descriptions for source context snapshots", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (
      _input: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
      }
    ) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "issue-with-body",
                    identifier: "NGX-290",
                    title: "Goal/source linkage",
                    description: "Use this Linear issue body in planning context.",
                    url: "https://linear.app/ngxcalvin/issue/NGX-290",
                    updatedAt: "2026-05-17T00:00:00.000Z"
                  }
                ]
              }
            }
          })
      };
    };

    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      fetch
    });

    const result = await client.fetchPage({ cursor: null, filters: {} });

    const query = String(bodies[0]?.["query"] ?? "");
    expect(query).toContain("description");
    expect(result).toEqual({
      ok: true,
      page: {
        issues: [
          {
            id: "issue-with-body",
            identifier: "NGX-290",
            title: "Goal/source linkage",
            description: "Use this Linear issue body in planning context.",
            url: "https://linear.app/ngxcalvin/issue/NGX-290",
            updatedAt: "2026-05-17T00:00:00.000Z"
          }
        ],
        nextCursor: null
      }
    });
  });

  it("returns a transport failure and aborts when a Linear request exceeds the timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = async (
      _input: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
      }
    ) => {
      observedSignal = init.signal;
      return new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
        () => {}
      );
    };

    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      fetch,
      requestTimeoutMs: 10
    });

    const result = await Promise.race([
      client.fetchPage({ cursor: null, filters: {} }),
      new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 100))
    ]);

    expect(result).not.toBe("unsettled");
    expect(result).toMatchObject({
      ok: false,
      code: "source_adapter_threw",
      error: "linear http request timed out after 10ms"
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("returns a timeout when the Linear response body read stalls", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = async (
      _input: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
      }
    ) => {
      observedSignal = init.signal;
      return {
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {})
      };
    };

    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      fetch,
      requestTimeoutMs: 10
    });

    const result = await Promise.race([
      client.fetchPage({ cursor: null, filters: {} }),
      new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 100))
    ]);

    expect(result).not.toBe("unsettled");
    expect(result).toMatchObject({
      ok: false,
      code: "source_adapter_threw",
      error: "linear http request timed out after 10ms"
    });
    expect(observedSignal?.aborted).toBe(true);
  });

});

describe("buildLinearHttpReconciliationClient — input validation", () => {
  it("rejects a non-positive page size at build time", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", pageSize: 0 })
    ).toThrow(/page size/);
  });

  it("rejects a page size above the Linear maximum at build time", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", pageSize: 251 })
    ).toThrow(/page size/);
  });

  it("rejects a non-integer page size at build time", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", pageSize: 2.5 })
    ).toThrow(/page size/);
  });

  it("accepts the boundary page sizes 1 and 250", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", pageSize: 1 })
    ).not.toThrow();
    expect(() =>
      buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", pageSize: 250 })
    ).not.toThrow();
  });

  it("rejects a non-positive request timeout at build time", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({
        apiKey: "lin_api_key",
        requestTimeoutMs: 0
      })
    ).toThrow(/timeout/);
  });

  it("rejects a non-integer request timeout at build time", () => {
    expect(() =>
      buildLinearHttpReconciliationClient({
        apiKey: "lin_api_key",
        requestTimeoutMs: 1.5
      })
    ).toThrow(/timeout/);
  });

  it("sends the configured page size as the GraphQL first variable", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      pageSize: 200,
      fetch
    });
    await client.fetchPage({ cursor: null, filters: {} });
    expect(parseRequestBody(requireFirstCall(calls)).variables["first"]).toBe(200);
  });

  it("defaults to the documented Linear page size", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    await client.fetchPage({ cursor: null, filters: {} });
    expect(parseRequestBody(requireFirstCall(calls)).variables["first"]).toBe(
      DEFAULT_LINEAR_PAGE_SIZE
    );
  });
});

describe("buildLinearHttpReconciliationClient — request shape and read-only contract", () => {
  it("POSTs a read-only GraphQL query and never a mutation", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    await client.fetchPage({ cursor: null, filters: {} });

    const call = requireFirstCall(calls);
    expect(call.init.method).toBe("POST");
    const body = parseRequestBody(call);
    expect(body.query).toContain("query MomentumLinearIssues");
    expect(body.query).not.toMatch(/\bmutation\b/);
  });

  it("sends the operator credential as the Authorization header with JSON content type", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    await client.fetchPage({ cursor: null, filters: {} });

    const headers = requireFirstCall(calls).init.headers;
    expect(headers["Authorization"]).toBe("lin_api_key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("trims surrounding whitespace from the credential before sending it", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({
      apiKey: "  lin_padded_key  ",
      fetch
    });
    await client.fetchPage({ cursor: null, filters: {} });
    expect(requireFirstCall(calls).init.headers["Authorization"]).toBe("lin_padded_key");
  });
});

describe("buildLinearHttpReconciliationClient — filter mapping", () => {
  async function capturedFilter(filters: LinearReconciliationFilters): Promise<unknown> {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    await client.fetchPage({ cursor: null, filters });
    return parseRequestBody(requireFirstCall(calls)).variables["filter"];
  }

  it("maps a project id filter to a Linear project id variable", async () => {
    expect(await capturedFilter({ projectId: "project-123" })).toEqual({
      project: { id: { eq: "project-123" } }
    });
  });

  it("maps a milestone id filter to a Linear projectMilestone id variable", async () => {
    expect(await capturedFilter({ milestoneId: "milestone-123" })).toEqual({
      projectMilestone: { id: { eq: "milestone-123" } }
    });
  });

  it("prefers id filters over name filters when both are supplied", async () => {
    expect(
      await capturedFilter({
        projectId: "project-123",
        projectName: "Momentum",
        milestoneId: "milestone-123",
        milestoneName: "Milestone 5"
      })
    ).toEqual({
      project: { id: { eq: "project-123" } },
      projectMilestone: { id: { eq: "milestone-123" } }
    });
  });

  it("sends a null filter when no scope is supplied", async () => {
    expect(await capturedFilter({})).toBeNull();
  });
});

describe("buildLinearHttpReconciliationClient — auth and transport failure taxonomy", () => {
  it("returns source_auth_unavailable without calling fetch when the api key is empty", async () => {
    const { fetch, calls } = recordingFetch(() => {
      throw new Error("fetch must not be called when the credential is missing");
    });
    const client = buildLinearHttpReconciliationClient({ apiKey: "", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("treats a whitespace-only api key as missing", async () => {
    const { fetch, calls } = recordingFetch(() => {
      throw new Error("fetch must not be called when the credential is missing");
    });
    const client = buildLinearHttpReconciliationClient({ apiKey: "   ", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("returns source_config_invalid when no fetch implementation is available", async () => {
    const globalRef = globalThis as { fetch?: unknown };
    const originalFetch = globalRef.fetch;
    try {
      globalRef.fetch = undefined;
      const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key" });
      const result = await client.fetchPage({ cursor: null, filters: {} });
      expect(result).toMatchObject({ ok: false, code: "source_config_invalid" });
    } finally {
      globalRef.fetch = originalFetch;
    }
  });

  it("maps HTTP 401 to source_auth_unavailable", async () => {
    const { fetch } = recordingFetch(() => statusResponse(401));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
    if (result.ok) return;
    expect(result.error).toContain("401");
  });

  it("maps HTTP 403 to source_auth_unavailable", async () => {
    const { fetch } = recordingFetch(() => statusResponse(403));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
  });

  it("maps a non-auth non-OK status to source_adapter_threw", async () => {
    const { fetch } = recordingFetch(() => statusResponse(500));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("500");
  });

  it("maps a thrown transport error to source_adapter_threw", async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("transport failed");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("maps a failed response body read to source_adapter_threw", async () => {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("stream interrupted"))
    }));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("response body read failed");
  });

  it("maps GraphQL auth errors flagged by extension code to source_auth_unavailable", async () => {
    const { fetch } = recordingFetch(() =>
      jsonOk({
        errors: [{ message: "denied", extensions: { code: "AUTHENTICATION_ERROR" } }]
      })
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
  });

  it("maps GraphQL auth errors detected by message to source_auth_unavailable", async () => {
    const { fetch } = recordingFetch(() =>
      jsonOk({ errors: [{ message: "User is not authenticated" }] })
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_auth_unavailable" });
  });

  it("maps non-auth GraphQL errors to source_adapter_threw with the message", async () => {
    const { fetch } = recordingFetch(() =>
      jsonOk({ errors: [{ message: "Internal server error" }] })
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("Internal server error");
  });
});

describe("buildLinearHttpReconciliationClient — response shape failure taxonomy", () => {
  async function fetchPageWith(
    bodyText: string
  ): Promise<LinearReconciliationFetchPageResult> {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      text: async () => bodyText
    }));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    return client.fetchPage({ cursor: null, filters: {} });
  }

  it("rejects a non-JSON response body", async () => {
    const result = await fetchPageWith("<html>not json</html>");
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("not JSON");
  });

  it("rejects a JSON array response body", async () => {
    const result = await fetchPageWith("[]");
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
  });

  it("rejects a response missing the data envelope", async () => {
    const result = await fetchPageWith(JSON.stringify({}));
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("data.issues");
  });

  it("rejects a response whose data.issues is not an object", async () => {
    const result = await fetchPageWith(JSON.stringify({ data: { issues: [] } }));
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
  });

  it("rejects a response whose data.issues.nodes is not an array", async () => {
    const result = await fetchPageWith(
      JSON.stringify({
        data: { issues: { nodes: "nope", pageInfo: { hasNextPage: false } } }
      })
    );
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("nodes");
  });
});

describe("buildLinearHttpReconciliationClient — pagination cursor handling", () => {
  async function fetchPageInfo(
    pageInfo: unknown
  ): Promise<LinearReconciliationFetchPageResult> {
    const { fetch } = recordingFetch(() => jsonOk(issuesPageBody({ nodes: [], pageInfo })));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    return client.fetchPage({ cursor: null, filters: {} });
  }

  it("returns the end cursor when another page is available", async () => {
    const result = await fetchPageInfo({ hasNextPage: true, endCursor: "cursor-2" });
    expect(result).toMatchObject({ ok: true, page: { nextCursor: "cursor-2" } });
  });

  it("returns a null cursor when no further page is available", async () => {
    const result = await fetchPageInfo({ hasNextPage: false, endCursor: "cursor-2" });
    expect(result).toMatchObject({ ok: true, page: { nextCursor: null } });
  });

  it("returns a null cursor when hasNextPage is true but the end cursor is empty", async () => {
    const result = await fetchPageInfo({ hasNextPage: true, endCursor: "" });
    expect(result).toMatchObject({ ok: true, page: { nextCursor: null } });
  });

  it("returns a null cursor when hasNextPage is true but the end cursor is missing", async () => {
    const result = await fetchPageInfo({ hasNextPage: true });
    expect(result).toMatchObject({ ok: true, page: { nextCursor: null } });
  });

  it("returns a null cursor when pageInfo is absent", async () => {
    const { fetch } = recordingFetch(() => jsonOk(issuesPageBody({ nodes: [] })));
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: true, page: { nextCursor: null } });
  });

  it("forwards the supplied cursor as the GraphQL after variable", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    await client.fetchPage({ cursor: "page-2-cursor", filters: {} });
    expect(parseRequestBody(requireFirstCall(calls)).variables["after"]).toBe("page-2-cursor");
  });

  it("preserves the raw issue nodes returned by Linear", async () => {
    const node = {
      id: "issue-1",
      identifier: "NGX-1",
      title: "raw passthrough",
      url: "https://linear.app/ngxcalvin/issue/NGX-1",
      updatedAt: "2026-05-15T10:30:00.000Z"
    };
    const { fetch } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({ apiKey: "lin_api_key", fetch });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: true, page: { issues: [node] } });
  });
});

describe("buildLinearHttpReconciliationClient — no real api.linear.app calls", () => {
  it("defaults to the documented real Linear GraphQL endpoint constant", () => {
    expect(DEFAULT_LINEAR_GRAPHQL_ENDPOINT).toBe("https://api.linear.app/graphql");
  });

  it("would target the real Linear host without an endpoint override, so the test guard intercepts it", async () => {
    const guard: FetchLike = async (input) => {
      if (/api\.linear\.app/.test(input)) {
        throw new Error(
          `test guard tripped: real api.linear.app calls are forbidden (target was ${input})`
        );
      }
      throw new Error("test guard tripped: unexpected fetch target");
    };
    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      fetch: guard
    });
    const result = await client.fetchPage({ cursor: null, filters: {} });
    expect(result).toMatchObject({ ok: false, code: "source_adapter_threw" });
    if (result.ok) return;
    expect(result.error).toContain("api.linear.app calls are forbidden");
    expect(result.error).toContain(DEFAULT_LINEAR_GRAPHQL_ENDPOINT);
  });

  it("honours an injected mock endpoint and never contacts the real host", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonOk(issuesPageBody({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }))
    );
    const client = buildLinearHttpReconciliationClient({
      apiKey: "lin_api_key",
      endpoint: "http://127.0.0.1:0/momentum-mock/graphql",
      fetch
    });
    await client.fetchPage({ cursor: null, filters: {} });
    const call = requireFirstCall(calls);
    expect(call.endpoint).toBe("http://127.0.0.1:0/momentum-mock/graphql");
    expect(call.endpoint).not.toMatch(/api\.linear\.app/);
  });
});
