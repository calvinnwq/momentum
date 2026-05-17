import { describe, expect, it } from "vitest";

import { buildLinearHttpReconciliationClient } from "../src/linear-http-client.js";

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
