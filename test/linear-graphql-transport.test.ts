import { describe, expect, it } from "vitest";

import {
  postLinearGraphql,
  type LinearGraphqlFetchLike,
  type LinearGraphqlTransportResult,
} from "../src/adapters/linear-graphql-transport.js";

type CapturedCall = {
  endpoint: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
};

const ENDPOINT = "http://127.0.0.1:0/momentum-mock/graphql";
const QUERY = "query MomentumTransportProbe { viewer { id } }";
const VARIABLES = { id: "linear-issue-1", after: null };

function baseRequest(fetch: LinearGraphqlFetchLike) {
  return {
    fetch,
    endpoint: ENDPOINT,
    apiKey: "lin_api_secret",
    requestTimeoutMs: 30_000,
    query: QUERY,
    variables: VARIABLES,
  };
}

function recordingFetch(
  handler: (call: CapturedCall) => ReturnType<LinearGraphqlFetchLike>,
): { fetch: LinearGraphqlFetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: LinearGraphqlFetchLike = (endpoint, init) => {
    const call: CapturedCall = { endpoint, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

describe("postLinearGraphql — request construction", () => {
  it("POSTs the serialized query/variables with JSON content type, the credential, and an abort signal", async () => {
    const { fetch, calls } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: {} }),
    }));

    await postLinearGraphql(baseRequest(fetch));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.endpoint).toBe(ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "lin_api_secret",
    });
    expect(call.init.body).toBe(
      JSON.stringify({ query: QUERY, variables: VARIABLES }),
    );
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.signal?.aborted).toBe(false);
  });
});

describe("postLinearGraphql — success", () => {
  it("returns the parsed JSON body and HTTP status", async () => {
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { issue: { id: "i-1" } } }),
    }));

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toEqual({
      kind: "success",
      status: 200,
      body: { data: { issue: { id: "i-1" } } },
    });
  });
});

describe("postLinearGraphql — HTTP status capture", () => {
  it.each([401, 403, 500])(
    "returns http_error for HTTP %d without reading the response body",
    async (status) => {
      let bodyReads = 0;
      const { fetch } = recordingFetch(async () => ({
        ok: false,
        status,
        text: async () => {
          bodyReads += 1;
          return "should never be read";
        },
      }));

      const result = await postLinearGraphql(baseRequest(fetch));
      expect(result).toEqual({ kind: "http_error", status });
      expect(bodyReads).toBe(0);
    },
  );

  it("treats 401/403 as http_error even when the response claims ok", async () => {
    let bodyReads = 0;
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 401,
      text: async () => {
        bodyReads += 1;
        return "should never be read";
      },
    }));

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toEqual({ kind: "http_error", status: 401 });
    expect(bodyReads).toBe(0);
  });
});

describe("postLinearGraphql — timeout and abort race", () => {
  it("aborts and returns timeout when the request stalls past the timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch: LinearGraphqlFetchLike = (_endpoint, init) => {
      observedSignal = init.signal;
      return new Promise(() => {});
    };

    const result = await Promise.race([
      postLinearGraphql({ ...baseRequest(fetch), requestTimeoutMs: 10 }),
      new Promise<"unsettled">((resolve) =>
        setTimeout(() => resolve("unsettled"), 100),
      ),
    ]);

    expect(result).not.toBe("unsettled");
    expect(result).toEqual({ kind: "timeout", timeoutMs: 10 });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("returns timeout when the response body read stalls past the timeout", async () => {
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => {}),
    }));

    const result = await Promise.race([
      postLinearGraphql({ ...baseRequest(fetch), requestTimeoutMs: 10 }),
      new Promise<"unsettled">((resolve) =>
        setTimeout(() => resolve("unsettled"), 100),
      ),
    ]);

    expect(result).not.toBe("unsettled");
    expect(result).toEqual({ kind: "timeout", timeoutMs: 10 });
  });

  it("classifies a post-abort AbortError from fetch as timeout, not request failure", async () => {
    const fetch: LinearGraphqlFetchLike = (_endpoint, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("This operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });

    const result = await postLinearGraphql({
      ...baseRequest(fetch),
      requestTimeoutMs: 10,
    });
    expect(result).toEqual({ kind: "timeout", timeoutMs: 10 });
  });
});

describe("postLinearGraphql — failure phase distinction", () => {
  it("returns request_failed with the thrown error when fetch rejects", async () => {
    const networkError = new Error("ECONNREFUSED");
    const fetch: LinearGraphqlFetchLike = async () => {
      throw networkError;
    };

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toEqual({ kind: "request_failed", error: networkError });
  });

  it("returns body_read_failed with the thrown error when the body read rejects", async () => {
    const readError = new Error("stream interrupted");
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(readError),
    }));

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toEqual({ kind: "body_read_failed", error: readError });
  });
});

describe("postLinearGraphql — JSON parsing", () => {
  it("returns invalid_json with the parse error when the body is not JSON", async () => {
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    }));

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toMatchObject({ kind: "invalid_json" });
    const failure = result as Extract<
      LinearGraphqlTransportResult,
      { kind: "invalid_json" }
    >;
    expect(failure.error).toBeInstanceOf(SyntaxError);
  });

  it("parses non-object JSON bodies without imposing shape policy", async () => {
    const { fetch } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    }));

    const result = await postLinearGraphql(baseRequest(fetch));
    expect(result).toEqual({ kind: "success", status: 200, body: [] });
  });
});
