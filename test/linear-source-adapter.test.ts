import { describe, expect, it } from "vitest";

import {
  dispatchSourceAdapterGet,
  dispatchSourceAdapterList,
  dispatchSourceAdapterNormalize,
  type SourceAdapterClient
} from "../src/source-adapter.js";
import {
  buildLinearSourceAdapter,
  normalizeLinearIssue,
  type LinearSourceAdapterClient
} from "../src/linear-source-adapter.js";

const ISSUE_ONE_RAW = {
  id: "d901abc0-b872-489c-a07c-aef4dd777c51",
  identifier: "NGX-289",
  title: "M5-02 Linear source adapter read and reconciliation",
  url: "https://linear.app/ngxcalvin/issue/NGX-289/m5-02-linear-source-adapter-read-and-reconciliation",
  updatedAt: "2026-05-15T10:30:00.000Z",
  state: {
    id: "0214717e-c671-4dd2-a960-1a8241f8ab93",
    name: "Todo",
    type: "unstarted"
  },
  project: {
    id: "b66052d1-7b17-4650-813c-802c264477b8",
    name: "Momentum",
    url: "https://linear.app/ngxcalvin/project/momentum-ebb2db7ec2b2"
  },
  projectMilestone: {
    id: "ce4a392a-150e-4bcc-bba4-a19795e27fa8",
    name: "Milestone 5: Source Adapters And Evidence Sync"
  },
  labels: {
    nodes: [
      { id: "label-1", name: "m5" },
      { id: "label-2", name: "source-adapter" }
    ]
  },
  assignee: null,
  priority: 0
} as const;

const ISSUE_TWO_RAW = {
  id: "issue-2-uuid",
  identifier: "NGX-290",
  title: "M5-03 Goal/source linkage and planning context",
  url: "https://linear.app/ngxcalvin/issue/NGX-290",
  updatedAt: "2026-05-16T08:00:00.000Z",
  state: { id: "state-2", name: "Backlog", type: "backlog" },
  project: {
    id: "b66052d1-7b17-4650-813c-802c264477b8",
    name: "Momentum"
  },
  projectMilestone: {
    id: "ce4a392a-150e-4bcc-bba4-a19795e27fa8",
    name: "Milestone 5: Source Adapters And Evidence Sync"
  },
  labels: { nodes: [] },
  assignee: null
} as const;

const OTHER_MILESTONE_ISSUE_RAW = {
  id: "issue-3-uuid",
  identifier: "NGX-200",
  title: "Unrelated milestone issue",
  url: "https://linear.app/ngxcalvin/issue/NGX-200",
  updatedAt: "2026-05-10T08:00:00.000Z",
  state: { id: "state-3", name: "Todo" },
  project: {
    id: "b66052d1-7b17-4650-813c-802c264477b8",
    name: "Momentum"
  },
  projectMilestone: {
    id: "different-milestone-uuid",
    name: "Earlier milestone"
  },
  labels: { nodes: [] },
  assignee: null
} as const;

const OTHER_PROJECT_ISSUE_RAW = {
  id: "issue-4-uuid",
  identifier: "OTHER-1",
  title: "Different project issue",
  url: "https://linear.app/ngxcalvin/issue/OTHER-1",
  updatedAt: "2026-05-11T08:00:00.000Z",
  state: { id: "state-4", name: "Todo" },
  project: { id: "other-project", name: "Other" },
  projectMilestone: { id: "x", name: "x" },
  labels: { nodes: [] },
  assignee: null
} as const;

function linearClient(
  client: LinearSourceAdapterClient
): SourceAdapterClient {
  return { linear: client };
}

describe("normalizeLinearIssue", () => {
  it("maps Linear issue fields onto a normalized SourceAdapterItem", () => {
    const result = normalizeLinearIssue(ISSUE_ONE_RAW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.item.externalId).toBe(ISSUE_ONE_RAW.id);
    expect(result.item.externalKey).toBe(ISSUE_ONE_RAW.identifier);
    expect(result.item.title).toBe(ISSUE_ONE_RAW.title);
    expect(result.item.url).toBe(ISSUE_ONE_RAW.url);
    expect(result.item.status).toBe(ISSUE_ONE_RAW.state.name);
    expect(result.item.observedAt).toBe(
      Date.parse(ISSUE_ONE_RAW.updatedAt)
    );
  });

  it("preserves the raw Linear payload under metadata.raw for snapshot fidelity", () => {
    const result = normalizeLinearIssue(ISSUE_ONE_RAW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.metadata?.["raw"]).toEqual(ISSUE_ONE_RAW);
  });

  it("normalizes project, milestone, labels, and assignee into structured metadata", () => {
    const result = normalizeLinearIssue(ISSUE_ONE_RAW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.item.metadata?.["project"]).toEqual({
      id: ISSUE_ONE_RAW.project.id,
      key: null,
      name: ISSUE_ONE_RAW.project.name,
      url: ISSUE_ONE_RAW.project.url
    });
    expect(result.item.metadata?.["milestone"]).toEqual({
      id: ISSUE_ONE_RAW.projectMilestone.id,
      name: ISSUE_ONE_RAW.projectMilestone.name
    });
    expect(result.item.metadata?.["labels"]).toEqual(["m5", "source-adapter"]);
    expect(result.item.metadata?.["assignee"]).toBeNull();
    expect(result.item.metadata?.["priority"]).toBe(0);
  });

  it("rejects raw payloads missing required Linear fields with a stable code", () => {
    const result = normalizeLinearIssue({
      id: "x",
      identifier: "NGX-1",
      title: "missing url",
      updatedAt: "2026-05-15T10:30:00.000Z"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("source_item_invalid");
    expect(result.error).toContain("url");
  });

  it("rejects raw payloads with an invalid updatedAt with a stable code", () => {
    const result = normalizeLinearIssue({
      id: "x",
      identifier: "NGX-1",
      title: "bad timestamp",
      url: "https://example.com",
      updatedAt: "not-a-real-date"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("source_item_invalid");
    expect(result.error).toContain("updatedAt");
  });

  it("rejects non-object raw payloads", () => {
    const result = normalizeLinearIssue([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("source_item_invalid");
  });
});

describe("linear adapter list/get via dispatchSourceAdapter*", () => {
  it("lists all normalized Linear issues injected through the client", () => {
    const out = dispatchSourceAdapterList(
      "linear",
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW, ISSUE_TWO_RAW]
        })
      }
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items).toHaveLength(2);
    expect(out.items[0]?.externalKey).toBe("NGX-289");
    expect(out.items[1]?.externalKey).toBe("NGX-290");
  });

  it("scopes list to a milestone filter without ingesting unrelated milestone issues", () => {
    const out = dispatchSourceAdapterList(
      "linear",
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW, OTHER_MILESTONE_ISSUE_RAW, ISSUE_TWO_RAW],
          filters: {
            milestoneId: "ce4a392a-150e-4bcc-bba4-a19795e27fa8"
          }
        })
      }
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items.map((item) => item.externalKey)).toEqual([
      "NGX-289",
      "NGX-290"
    ]);
  });

  it("scopes list to a projectId filter and rejects other-project issues", () => {
    const out = dispatchSourceAdapterList(
      "linear",
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW, OTHER_PROJECT_ISSUE_RAW],
          filters: {
            projectId: "b66052d1-7b17-4650-813c-802c264477b8"
          }
        })
      }
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items.map((item) => item.externalKey)).toEqual(["NGX-289"]);
  });

  it("returns source_item_invalid if any injected raw issue cannot be normalized", () => {
    const out = dispatchSourceAdapterList(
      "linear",
      {
        client: linearClient({
          issues: [
            ISSUE_ONE_RAW,
            { id: "broken", identifier: "NGX-999", title: "no url", updatedAt: "2026-05-15T10:30:00.000Z" }
          ]
        })
      }
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("source_item_invalid");
  });

  it("gets a single Linear issue by external id (Linear UUID)", () => {
    const out = dispatchSourceAdapterGet(
      "linear",
      ISSUE_ONE_RAW.id,
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW, ISSUE_TWO_RAW]
        })
      }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.externalKey).toBe("NGX-289");
  });

  it("gets a single Linear issue by external key (identifier)", () => {
    const out = dispatchSourceAdapterGet(
      "linear",
      "NGX-290",
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW, ISSUE_TWO_RAW]
        })
      }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.externalId).toBe(ISSUE_TWO_RAW.id);
  });

  it("returns source_item_not_found when no injected issue matches", () => {
    const out = dispatchSourceAdapterGet(
      "linear",
      "missing",
      {
        client: linearClient({
          issues: [ISSUE_ONE_RAW]
        })
      }
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("source_item_not_found");
  });
});

describe("dispatchSourceAdapterNormalize for linear", () => {
  it("normalizes a raw Linear payload through the dispatch boundary", () => {
    const out = dispatchSourceAdapterNormalize("linear", ISSUE_ONE_RAW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.externalKey).toBe("NGX-289");
  });
});

describe("buildLinearSourceAdapter", () => {
  it("exposes the linear kind label", () => {
    const adapter = buildLinearSourceAdapter();
    expect(adapter.kind).toBe("linear");
  });
});
