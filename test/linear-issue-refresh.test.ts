import { describe, expect, it } from "vitest";

import {
  LINEAR_ISSUE_REFRESH_RESULT_CODES,
  buildLinearIssueRefreshClient,
  type FetchLike,
  type LinearIssueRefreshTarget
} from "../src/adapters/linear-issue-refresh.js";

type MockGraphqlCall = {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type MockGraphqlResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "hang" };

function buildMockFetch(responses: MockGraphqlResponse[]): {
  fetch: FetchLike;
  calls: MockGraphqlCall[];
} {
  const calls: MockGraphqlCall[] = [];
  let cursor = 0;
  const fetch: FetchLike = async (input, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({
      endpoint: input,
      method: init.method,
      headers: init.headers,
      body
    });
    const next = responses[cursor++];
    if (!next) {
      throw new Error(
        `mock fetch ran out of responses on call #${calls.length}`
      );
    }
    if (next.kind === "hang") {
      return new Promise(() => {});
    }
    if (next.kind === "json") {
      const serialized = JSON.stringify(next.body);
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => serialized
      };
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.text
    };
  };
  return { fetch, calls };
}

function issuePayload(options: {
  id?: string;
  identifier?: string;
  url?: string;
  title?: string;
  updatedAt?: string;
  state?: { id: string; name: string };
  comments?: Array<{ id: string; body: string; url?: string | null }>;
  commentsPageInfo?: { hasNextPage: boolean; endCursor: string | null };
}): unknown {
  return {
    data: {
      issue: {
        id: options.id ?? "linear-issue-1",
        identifier: options.identifier ?? "NGX-1",
        url: options.url ?? "https://linear.app/example/issue/NGX-1",
        title: options.title ?? "Example issue",
        updatedAt: options.updatedAt ?? "2025-06-01T12:00:00.000Z",
        state: options.state ?? { id: "state-done", name: "Done" },
        comments: {
          nodes: (options.comments ?? []).map((c) => ({
            id: c.id,
            body: c.body,
            url: c.url ?? null
          })),
          pageInfo: options.commentsPageInfo ?? {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    }
  };
}

function issueCommentsPagePayload(options: {
  comments?: Array<{ id: string; body: string; url?: string | null }>;
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}): unknown {
  return {
    data: {
      issue: {
        comments: {
          nodes: (options.comments ?? []).map((c) => ({
            id: c.id,
            body: c.body,
            url: c.url ?? null
          })),
          pageInfo: options.pageInfo ?? {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    }
  };
}

describe("LINEAR_ISSUE_REFRESH_RESULT_CODES", () => {
  it("pins the stable result-code taxonomy for the refresh client", () => {
    expect(LINEAR_ISSUE_REFRESH_RESULT_CODES).toEqual([
      "auth_unavailable",
      "target_missing",
      "refresh_timeout",
      "malformed_response",
      "adapter_threw"
    ]);
  });
});

describe("buildLinearIssueRefreshClient — credentials are never persisted", () => {
  it("refuses to call fetch when the apiKey is missing", async () => {
    const { fetch, calls } = buildMockFetch([]);
    const client = buildLinearIssueRefreshClient({ apiKey: "", fetch });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });
    expect(result).toMatchObject({ ok: false, code: "auth_unavailable" });
    expect(calls).toEqual([]);
  });

  it("forwards apiKey only through the Authorization header", async () => {
    const { fetch, calls } = buildMockFetch([
      { kind: "json", status: 200, body: issuePayload({}) }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    await client.refresh({ target: { kind: "id", value: "linear-issue-1" } });
    expect(calls[0]!.headers["Authorization"]).toBe("lin_api_secret");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  });
});

describe("buildLinearIssueRefreshClient — target keys", () => {
  it("returns the issue and its comments keyed by id", async () => {
    const { fetch, calls } = buildMockFetch([
      {
        kind: "json",
        status: 200,
        body: issuePayload({
          comments: [
            { id: "c-1", body: "hello world" },
            {
              id: "c-2",
              body: "Applied via momentum-intent:linear:intent-1:abcdef0123456789"
            }
          ]
        })
      }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });

    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.issue as Record<string, unknown>)["id"]).toBe(
      "linear-issue-1"
    );
    expect(result.comments).toHaveLength(2);
    expect(result.comments[1]!.body).toContain(
      "momentum-intent:linear:intent-1:abcdef0123456789"
    );
    expect(calls).toHaveLength(1);
    const variables = (calls[0]!.body["variables"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(variables["id"]).toBe("linear-issue-1");
  });

  it.each<{ name: string; target: LinearIssueRefreshTarget; expected: string }>([
    {
      name: "key",
      target: { kind: "key", value: "NGX-1" },
      expected: "NGX-1"
    },
    {
      name: "url",
      target: {
        kind: "url",
        value: "https://linear.app/example/issue/NGX-1"
      },
      expected: "https://linear.app/example/issue/NGX-1"
    }
  ])("queries by $name", async ({ target, expected }) => {
    const { fetch, calls } = buildMockFetch([
      { kind: "json", status: 200, body: issuePayload({}) }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    await client.refresh({ target });
    const variables = (calls[0]!.body["variables"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(variables["id"]).toBe(expected);
  });
});

describe("buildLinearIssueRefreshClient — comment pagination", () => {
  it("walks pages until hasNextPage is false and flattens the comments", async () => {
    const { fetch, calls } = buildMockFetch([
      {
        kind: "json",
        status: 200,
        body: issuePayload({
          comments: [{ id: "c-1", body: "first" }],
          commentsPageInfo: { hasNextPage: true, endCursor: "cursor-A" }
        })
      },
      {
        kind: "json",
        status: 200,
        body: issueCommentsPagePayload({
          comments: [
            {
              id: "c-2",
              body: "Applied via momentum-intent:linear:intent-1:abcdef0123456789"
            }
          ]
        })
      }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(calls).toHaveLength(2);
    const variables = (calls[1]!.body["variables"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(variables["after"]).toBe("cursor-A");
  });
});

describe("buildLinearIssueRefreshClient — failure mapping", () => {
  it("returns target_missing when GraphQL returns issue: null", async () => {
    const { fetch } = buildMockFetch([
      { kind: "json", status: 200, body: { data: { issue: null } } }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });
    expect(result).toMatchObject({ ok: false, code: "target_missing" });
  });

  it("returns auth_unavailable on HTTP 401", async () => {
    const { fetch } = buildMockFetch([
      { kind: "text", status: 401, text: "unauthorized" }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });
    expect(result).toMatchObject({ ok: false, code: "auth_unavailable" });
  });

  it("returns malformed_response on invalid JSON", async () => {
    const { fetch } = buildMockFetch([
      { kind: "text", status: 200, text: "not-json" }
    ]);
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });
    expect(result).toMatchObject({ ok: false, code: "malformed_response" });
  });

  it("returns adapter_threw when fetch rejects", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const client = buildLinearIssueRefreshClient({
      apiKey: "lin_api_secret",
      fetch
    });
    const result = await client.refresh({
      target: { kind: "id", value: "linear-issue-1" }
    });
    expect(result).toMatchObject({ ok: false, code: "adapter_threw" });
  });
});
