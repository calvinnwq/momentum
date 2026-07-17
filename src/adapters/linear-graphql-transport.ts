/**
 * Shared Linear GraphQL network transport.
 *
 * Owns exactly the HTTP POST mechanics common to Momentum's three Linear
 * GraphQL clients (`linear-http-client`, `linear-issue-refresh`,
 * `linear-external-update-client`): request construction, the bounded
 * timeout/abort race, request-vs-body-read failure distinction, HTTP
 * status/`ok` capture, and JSON parsing of successful response bodies.
 *
 * The result is policy-neutral. Everything else stays client-owned:
 * credential/fetch-presence validation, endpoint resolution, GraphQL `errors`
 * interpretation, auth-code detection, pagination, refusal codes, and error
 * wording. Callers translate each result kind into their own public envelope
 * so exported refusal codes and error strings never move here.
 *
 * Error response bodies are deliberately never read: any 401/403 or non-OK
 * status short-circuits to `http_error` before the body read, matching the
 * pre-extraction behavior of all three clients.
 */

export type LinearGraphqlFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type LinearGraphqlTransportRequest = {
  fetch: LinearGraphqlFetchLike;
  endpoint: string;
  apiKey: string;
  requestTimeoutMs: number;
  query: string;
  variables: Record<string, unknown>;
};

export type LinearGraphqlTransportResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "request_failed"; error: unknown }
  | { kind: "body_read_failed"; error: unknown }
  | { kind: "invalid_json"; error: unknown };

class LinearGraphqlTransportTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`linear graphql request timed out after ${timeoutMs}ms`);
    this.name = "LinearGraphqlTransportTimeoutError";
  }
}

export async function postLinearGraphql(
  request: LinearGraphqlTransportRequest,
): Promise<LinearGraphqlTransportResult> {
  const { fetch: fetchImpl, endpoint, apiKey, requestTimeoutMs } = request;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const requestState: { phase: "request" | "response_body" } = {
    phase: "request",
  };

  let status: number;
  let bodyText: string | null;
  try {
    const requestPromise = (async () => {
      const fetched = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({
          query: request.query,
          variables: request.variables,
        }),
        signal: controller.signal,
      });
      if (fetched.status === 401 || fetched.status === 403 || !fetched.ok) {
        return { status: fetched.status, bodyText: null as string | null };
      }
      requestState.phase = "response_body";
      return { status: fetched.status, bodyText: await fetched.text() };
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new LinearGraphqlTransportTimeoutError(requestTimeoutMs));
      }, requestTimeoutMs);
    });

    const settled = await Promise.race([requestPromise, timeoutPromise]);
    status = settled.status;
    bodyText = settled.bodyText;
  } catch (error) {
    if (
      error instanceof LinearGraphqlTransportTimeoutError ||
      (timedOut &&
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return { kind: "timeout", timeoutMs: requestTimeoutMs };
    }
    if (requestState.phase === "response_body") {
      return { kind: "body_read_failed", error };
    }
    return { kind: "request_failed", error };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  if (bodyText === null) {
    return { kind: "http_error", status };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    return { kind: "invalid_json", error };
  }

  return { kind: "success", status, body: parsed };
}
