import { describe, expect, it } from "vitest";

import {
  dispatchSourceAdapterGet,
  dispatchSourceAdapterList,
  dispatchSourceAdapterNormalize,
  getSourceAdapter,
  listSourceAdapterKinds,
  type SourceAdapter,
  type SourceAdapterClient,
  type SourceAdapterItem
} from "../src/source-adapter.js";

const fixtureItems: SourceAdapterItem[] = [
  {
    externalId: "local-1",
    externalKey: "LOCAL-1",
    url: "file:///fixtures/LOCAL-1",
    title: "Fixture issue",
    status: "Todo",
    metadata: { labels: ["m5"] },
    observedAt: 1000
  }
];

function fixtureClient(items = fixtureItems): SourceAdapterClient {
  return { fixtures: { items } };
}

describe("source adapter registry", () => {
  it("lists the built-in local-fixture adapter", () => {
    expect(listSourceAdapterKinds()).toEqual(["local-fixture"]);
  });

  it("returns the local-fixture adapter from getSourceAdapter", () => {
    const adapter = getSourceAdapter("local-fixture");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("local-fixture");
  });

  it("returns undefined for unknown source adapter kinds", () => {
    expect(getSourceAdapter("linear")).toBeUndefined();
  });
});

describe("dispatchSourceAdapterList", () => {
  it("lists normalized source items through a client injection point", () => {
    const out = dispatchSourceAdapterList("local-fixture", {
      client: fixtureClient()
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toEqual(fixtureItems);
  });

  it("rejects unsupported adapter kinds with a stable code", () => {
    const out = dispatchSourceAdapterList("linear", { client: fixtureClient() });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_source_adapter");
    expect(out.error).toContain("linear");
  });

  it("wraps adapter exceptions instead of throwing raw errors", () => {
    const throwingAdapter: SourceAdapter = {
      kind: "local-fixture",
      list: () => {
        throw new Error("transport exploded");
      },
      get: () => {
        throw new Error("not used");
      },
      normalize: () => {
        throw new Error("not used");
      }
    };

    const out = dispatchSourceAdapterList("local-fixture", {
      client: fixtureClient(),
      adapters: new Map([["local-fixture", throwingAdapter]])
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("source_adapter_threw");
    expect(out.error).toContain("transport exploded");
  });
});

describe("dispatchSourceAdapterGet", () => {
  it("gets one normalized source item by external id", () => {
    const out = dispatchSourceAdapterGet("local-fixture", "local-1", {
      client: fixtureClient()
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item).toEqual(fixtureItems[0]);
  });

  it("returns source_item_not_found for a missing fixture item", () => {
    const out = dispatchSourceAdapterGet("local-fixture", "missing", {
      client: fixtureClient()
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("source_item_not_found");
    expect(out.error).toContain("missing");
  });
});


describe("dispatchSourceAdapterNormalize", () => {
  it("normalizes raw local-fixture source payloads into SourceAdapterItem values", () => {
    const out = dispatchSourceAdapterNormalize("local-fixture", {
      externalId: "local-2",
      externalKey: "LOCAL-2",
      url: "file:///fixtures/LOCAL-2",
      title: "Second fixture",
      status: "In Progress",
      metadata: { labels: ["m5"] },
      observedAt: 2000
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item).toEqual({
      externalId: "local-2",
      externalKey: "LOCAL-2",
      url: "file:///fixtures/LOCAL-2",
      title: "Second fixture",
      status: "In Progress",
      metadata: { labels: ["m5"] },
      observedAt: 2000
    });
  });

  it("rejects malformed raw local-fixture payloads with a stable code", () => {
    const out = dispatchSourceAdapterNormalize("local-fixture", {
      externalId: "local-3",
      observedAt: 3000
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("source_item_invalid");
    expect(out.error).toContain("title");
  });
});
