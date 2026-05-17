import { describe, expect, it } from "vitest";

import { buildLinearHttpReconciliationClient } from "../src/linear-http-client.js";

describe("buildLinearHttpReconciliationClient", () => {
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
});
