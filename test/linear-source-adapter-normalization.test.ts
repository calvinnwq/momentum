import { describe, expect, it } from "vitest";

import { normalizeLinearIssue } from "../src/linear-source-adapter.js";
import type { SourceAdapterItem } from "../src/source-adapter.js";

/**
 * NGX-369 normalization-boundary coverage for the Linear source adapter.
 *
 * The happy-path normalization is pinned in `linear-source-adapter.test.ts`.
 * This file isolates the partial-data / rejection edges of
 * `normalizeLinearIssue` that the happy-path fixtures never exercise:
 * required-field rejection per field, the numeric `updatedAt` path, the
 * null-collapse behavior of the optional project/milestone/assignee shapes,
 * the tri-state assignee handling, the label-node filtering, and the
 * falsy-`0` priority retention. These stay isolated (no HTTP, no db, no git)
 * to preserve the M5/M6 read-only source-adapter invariants.
 */

const VALID_BASE = {
  id: "issue-uuid",
  identifier: "NGX-1",
  title: "A normalized title",
  url: "https://linear.app/ngxcalvin/issue/NGX-1",
  updatedAt: "2026-05-15T10:30:00.000Z"
} as const;

function withBase(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_BASE, ...overrides };
}

function normalizeOk(raw: unknown): SourceAdapterItem {
  const result = normalizeLinearIssue(raw);
  if (!result.ok) {
    throw new Error(
      `expected normalization to succeed, got ${result.code}: ${result.error}`
    );
  }
  return result.item;
}

function normalizeErr(raw: unknown): { code: string; error: string } {
  const result = normalizeLinearIssue(raw);
  if (result.ok) {
    throw new Error("expected normalization to fail, but it succeeded");
  }
  return { code: result.code, error: result.error };
}

function metaOf(item: SourceAdapterItem): Record<string, unknown> {
  expect(item.metadata).toBeDefined();
  return item.metadata ?? {};
}

describe("normalizeLinearIssue required-field rejection", () => {
  it("rejects a non-string/empty id with a field-specific message", () => {
    for (const id of [undefined, "", 42, null]) {
      const result = normalizeErr(withBase({ id }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("id must be a non-empty string");
    }
  });

  it("rejects a non-string/empty identifier with a field-specific message", () => {
    for (const identifier of [undefined, "", 7, null]) {
      const result = normalizeErr(withBase({ identifier }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("identifier must be a non-empty string");
    }
  });

  it("rejects a non-string/empty title with a field-specific message", () => {
    for (const title of [undefined, "", 0, null]) {
      const result = normalizeErr(withBase({ title }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("title must be a non-empty string");
    }
  });

  it("rejects a non-string/empty url with a field-specific message", () => {
    for (const url of [undefined, "", 1, null]) {
      const result = normalizeErr(withBase({ url }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("url must be a non-empty string");
    }
  });

  it("rejects non-object raw payloads regardless of primitive shape", () => {
    for (const raw of [null, undefined, "issue", 42, true, []]) {
      const result = normalizeErr(raw);
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("must be an object");
    }
  });
});

describe("normalizeLinearIssue updatedAt parsing", () => {
  it("accepts a numeric epoch updatedAt verbatim as observedAt", () => {
    const item = normalizeOk(withBase({ updatedAt: 1_747_305_000_000 }));
    expect(item.observedAt).toBe(1_747_305_000_000);
  });

  it("parses an ISO-8601 string updatedAt into an epoch observedAt", () => {
    const item = normalizeOk(withBase({ updatedAt: "2026-05-15T10:30:00.000Z" }));
    expect(item.observedAt).toBe(Date.parse("2026-05-15T10:30:00.000Z"));
  });

  it("rejects a non-finite numeric updatedAt", () => {
    for (const updatedAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = normalizeErr(withBase({ updatedAt }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("updatedAt");
    }
  });

  it("rejects an empty-string and unparseable updatedAt", () => {
    for (const updatedAt of ["", "not-a-real-date"]) {
      const result = normalizeErr(withBase({ updatedAt }));
      expect(result.code).toBe("source_item_invalid");
      expect(result.error).toContain("updatedAt");
    }
  });
});

describe("normalizeLinearIssue state -> status", () => {
  it("maps a named state onto status", () => {
    const item = normalizeOk(withBase({ state: { id: "s1", name: "In Progress" } }));
    expect(item.status).toBe("In Progress");
  });

  it("yields a null status when state is absent, nameless, or non-object", () => {
    expect(normalizeOk(withBase({})).status).toBeNull();
    expect(normalizeOk(withBase({ state: { id: "s1" } })).status).toBeNull();
    expect(normalizeOk(withBase({ state: "In Progress" })).status).toBeNull();
  });
});

describe("normalizeLinearIssue project metadata", () => {
  it("captures the full project shape including the key field", () => {
    const item = normalizeOk(
      withBase({
        project: {
          id: "p1",
          key: "MOM",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        }
      })
    );
    expect(metaOf(item)["project"]).toEqual({
      id: "p1",
      key: "MOM",
      name: "Momentum",
      url: "https://linear.app/ngxcalvin/project/momentum"
    });
  });

  it("omits project metadata when the project collapses to all-null, is missing, or is non-object", () => {
    expect("project" in metaOf(normalizeOk(withBase({ project: {} })))).toBe(false);
    expect("project" in metaOf(normalizeOk(withBase({})))).toBe(false);
    expect("project" in metaOf(normalizeOk(withBase({ project: "Momentum" })))).toBe(
      false
    );
  });
});

describe("normalizeLinearIssue milestone metadata", () => {
  it("captures a populated milestone", () => {
    const item = normalizeOk(
      withBase({ projectMilestone: { id: "m1", name: "Adapter Test Coverage" } })
    );
    expect(metaOf(item)["milestone"]).toEqual({
      id: "m1",
      name: "Adapter Test Coverage"
    });
  });

  it("omits milestone metadata when it collapses to all-null or is missing", () => {
    expect(
      "milestone" in metaOf(normalizeOk(withBase({ projectMilestone: {} })))
    ).toBe(false);
    expect("milestone" in metaOf(normalizeOk(withBase({})))).toBe(false);
  });
});

describe("normalizeLinearIssue label metadata", () => {
  it("collects label node names in order", () => {
    const item = normalizeOk(
      withBase({ labels: { nodes: [{ name: "m5" }, { name: "source-adapter" }] } })
    );
    expect(metaOf(item)["labels"]).toEqual(["m5", "source-adapter"]);
  });

  it("skips label nodes that lack a usable name", () => {
    const item = normalizeOk(
      withBase({
        labels: { nodes: [{ id: "l1" }, { name: "" }, { name: "keep" }, 7] }
      })
    );
    expect(metaOf(item)["labels"]).toEqual(["keep"]);
  });

  it("records an empty label list when nodes is an empty array", () => {
    const item = normalizeOk(withBase({ labels: { nodes: [] } }));
    expect(metaOf(item)["labels"]).toEqual([]);
  });

  it("omits label metadata when nodes is missing, non-array, or labels is non-object", () => {
    expect("labels" in metaOf(normalizeOk(withBase({})))).toBe(false);
    expect("labels" in metaOf(normalizeOk(withBase({ labels: { nodes: "x" } })))).toBe(
      false
    );
    expect("labels" in metaOf(normalizeOk(withBase({ labels: "x" })))).toBe(false);
  });
});

describe("normalizeLinearIssue assignee tri-state metadata", () => {
  it("captures a fully populated assignee", () => {
    const item = normalizeOk(
      withBase({ assignee: { id: "u1", name: "Calvin", email: "c@example.com" } })
    );
    expect(metaOf(item)["assignee"]).toEqual({
      id: "u1",
      name: "Calvin",
      email: "c@example.com"
    });
  });

  it("captures a partially populated assignee with null gaps", () => {
    const item = normalizeOk(withBase({ assignee: { name: "Calvin" } }));
    expect(metaOf(item)["assignee"]).toEqual({
      id: null,
      name: "Calvin",
      email: null
    });
  });

  it("records an explicit null assignee as null (key present)", () => {
    const meta = metaOf(normalizeOk(withBase({ assignee: null })));
    expect("assignee" in meta).toBe(true);
    expect(meta["assignee"]).toBeNull();
  });

  it("collapses an all-null assignee object to null (key present)", () => {
    const meta = metaOf(
      normalizeOk(withBase({ assignee: { id: null, name: null, email: null } }))
    );
    expect("assignee" in meta).toBe(true);
    expect(meta["assignee"]).toBeNull();
  });

  it("omits assignee metadata when the field is absent or non-object", () => {
    expect("assignee" in metaOf(normalizeOk(withBase({})))).toBe(false);
    expect("assignee" in metaOf(normalizeOk(withBase({ assignee: "someone" })))).toBe(
      false
    );
  });
});

describe("normalizeLinearIssue priority metadata", () => {
  it("retains a zero priority rather than dropping the falsy value", () => {
    const meta = metaOf(normalizeOk(withBase({ priority: 0 })));
    expect("priority" in meta).toBe(true);
    expect(meta["priority"]).toBe(0);
  });

  it("retains a positive numeric priority", () => {
    expect(metaOf(normalizeOk(withBase({ priority: 3 })))["priority"]).toBe(3);
  });

  it("omits priority when it is absent, non-finite, or non-numeric", () => {
    expect("priority" in metaOf(normalizeOk(withBase({})))).toBe(false);
    expect("priority" in metaOf(normalizeOk(withBase({ priority: Number.NaN })))).toBe(
      false
    );
    expect("priority" in metaOf(normalizeOk(withBase({ priority: "3" })))).toBe(false);
  });
});

describe("normalizeLinearIssue snapshot fidelity", () => {
  it("preserves the exact raw payload under metadata.raw", () => {
    const raw = withBase({ project: { id: "p1", name: "Momentum" } });
    expect(metaOf(normalizeOk(raw))["raw"]).toEqual(raw);
  });
});
