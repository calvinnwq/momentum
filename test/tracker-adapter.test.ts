import { describe, expect, it } from "vitest";

import {
  BUILTIN_TRACKER_ADAPTER_KINDS,
  dispatchTrackerAdapterGet,
  dispatchTrackerAdapterList,
  dispatchTrackerAdapterNormalize,
  getTrackerAdapter,
  listTrackerAdapterKinds,
  type TrackerAdapter,
  type TrackerAdapterClient,
  type TrackerAdapterErrorCode,
  type TrackerAdapterItem,
} from "../src/adapters/tracker-adapter.js";

const fixtureItems: TrackerAdapterItem[] = [
  {
    externalId: "local-1",
    externalKey: "LOCAL-1",
    url: "file:///fixtures/LOCAL-1",
    title: "Fixture issue",
    status: "Todo",
    metadata: { labels: ["m5"] },
    observedAt: 1000,
  },
];

function fixtureClient(items = fixtureItems): TrackerAdapterClient {
  return { fixtures: { items } };
}

describe("source adapter registry", () => {
  it("lists the built-in source adapter kinds", () => {
    expect(listTrackerAdapterKinds()).toEqual(["local-fixture", "linear"]);
    expect([...BUILTIN_TRACKER_ADAPTER_KINDS]).toEqual([
      "local-fixture",
      "linear",
    ]);
  });

  it("keeps the source adapter error vocabulary stable", () => {
    const errorCodes: TrackerAdapterErrorCode[] = [
      "unsupported_tracker_adapter",
      "tracker_adapter_threw",
      "tracker_item_not_found",
      "tracker_item_invalid",
      "tracker_auth_unavailable",
      "tracker_config_invalid",
    ];
    expect(errorCodes).toContain("tracker_auth_unavailable");
  });

  it("returns the local-fixture adapter from getTrackerAdapter", () => {
    const adapter = getTrackerAdapter("local-fixture");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("local-fixture");
  });

  it("returns the linear adapter from getTrackerAdapter", () => {
    const adapter = getTrackerAdapter("linear");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("linear");
  });

  it("returns undefined for unknown source adapter kinds", () => {
    expect(getTrackerAdapter("github")).toBeUndefined();
  });
});

describe("dispatchTrackerAdapterList", () => {
  it("lists normalized source items through a client injection point", () => {
    const out = dispatchTrackerAdapterList("local-fixture", {
      client: fixtureClient(),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toEqual(fixtureItems);
  });

  it("rejects unsupported adapter kinds with a stable code", () => {
    const out = dispatchTrackerAdapterList("github", {
      client: fixtureClient(),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_tracker_adapter");
    expect(out.error).toContain("github");
  });

  it("wraps adapter exceptions instead of throwing raw errors", () => {
    const throwingAdapter: TrackerAdapter = {
      kind: "local-fixture",
      list: () => {
        throw new Error("transport exploded");
      },
      get: () => {
        throw new Error("not used");
      },
      normalize: () => {
        throw new Error("not used");
      },
    };

    const out = dispatchTrackerAdapterList("local-fixture", {
      client: fixtureClient(),
      adapters: new Map([["local-fixture", throwingAdapter]]),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("tracker_adapter_threw");
    expect(out.error).toContain("transport exploded");
  });
});

describe("dispatchTrackerAdapterGet", () => {
  it("gets one normalized source item by external id", () => {
    const out = dispatchTrackerAdapterGet("local-fixture", "local-1", {
      client: fixtureClient(),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item).toEqual(fixtureItems[0]);
  });

  it("returns tracker_item_not_found for a missing fixture item", () => {
    const out = dispatchTrackerAdapterGet("local-fixture", "missing", {
      client: fixtureClient(),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("tracker_item_not_found");
    expect(out.error).toContain("missing");
  });
});

describe("dispatchTrackerAdapterNormalize", () => {
  it("normalizes raw local-fixture source payloads into TrackerAdapterItem values", () => {
    const out = dispatchTrackerAdapterNormalize("local-fixture", {
      externalId: "local-2",
      externalKey: "LOCAL-2",
      url: "file:///fixtures/LOCAL-2",
      title: "Second fixture",
      status: "In Progress",
      metadata: { labels: ["m5"] },
      observedAt: 2000,
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
      observedAt: 2000,
    });
  });

  it("rejects malformed raw local-fixture payloads with a stable code", () => {
    const out = dispatchTrackerAdapterNormalize("local-fixture", {
      externalId: "local-3",
      observedAt: 3000,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("tracker_item_invalid");
    expect(out.error).toContain("title");
  });
});
