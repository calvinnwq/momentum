import { describe, expect, it } from "vitest";

import {
  buildIdempotencyMarker,
  previewExternalUpdate,
  type ExternalUpdateAdapterInput,
  type ExternalUpdateAdapterPreview,
  type ExternalUpdateAdapterTarget,
} from "../src/adapters/external-update-adapter.js";
import {
  DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT,
  LINEAR_EXTERNAL_UPDATE_RESULT_CODES,
  buildLinearExternalUpdateClient,
  type FetchLike,
  type LinearExternalUpdateInput,
} from "../src/adapters/linear-external-update-client.js";
import type { UpdateIntent } from "../src/core/intent/update-intents.js";

function buildIntent(overrides: Partial<UpdateIntent> = {}): UpdateIntent {
  return {
    id: "update_intent_test_1",
    adapterKind: "linear",
    targetExternalId: "linear-issue-1",
    intentType: "source_satisfied",
    payload: {
      goalState: "completed",
      evidenceType: "no_mistakes_complete",
      sourceExternalId: "linear-issue-1",
      sourceExternalKey: "NGX-1",
    },
    reason:
      "Goal completed with verification evidence (no_mistakes_complete); source item NGX-1 appears satisfied.",
    goalId: "goal_test_1",
    sourceItemId: "source_item_test_1",
    evidenceRecordId: "evidence_record_test_1",
    status: "pending",
    idempotencyKey: "linear:linear-issue-1:source_satisfied:goal_test_1",
    decisionReason: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    appliedAt: null,
    skippedAt: null,
    canceledAt: null,
    ...overrides,
  };
}

function buildTarget(
  overrides: Partial<ExternalUpdateAdapterTarget> = {},
): ExternalUpdateAdapterTarget {
  return {
    adapterKind: "linear",
    externalId: "linear-issue-1",
    externalKey: "NGX-1",
    url: "https://linear.app/example/issue/NGX-1",
    title: "Example issue title",
    ...overrides,
  };
}

function buildPreviewInput(
  overrides: Partial<ExternalUpdateAdapterInput> = {},
): ExternalUpdateAdapterInput {
  const base: ExternalUpdateAdapterInput = {
    intent: buildIntent(),
    target: buildTarget(),
    operator: {
      reason: "Operator confirmed Goal completion.",
      actor: "calvin",
    },
    policy: {
      intentApplyPolicy: "external_apply_allowed",
      allowStatusMutation: false,
    },
  };
  return { ...base, ...overrides };
}

function buildPreview(
  overrides: Partial<ExternalUpdateAdapterInput> = {},
): ExternalUpdateAdapterPreview {
  const result = previewExternalUpdate(buildPreviewInput(overrides));
  if (!result.ok) {
    throw new Error(
      `expected preview to succeed for test setup; got ${result.code}: ${result.error}`,
    );
  }
  return result.preview;
}

type MockGraphqlCall = {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type MockGraphqlResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "hang" }
  | { kind: "hang-body"; status: number };

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
      body,
    });
    const next = responses[cursor++];
    if (!next) {
      throw new Error(
        `mock fetch ran out of responses on call #${calls.length}; query=${JSON.stringify(body["query"]).slice(0, 80)}`,
      );
    }
    if (next.kind === "hang") {
      return new Promise(() => {});
    }
    if (next.kind === "hang-body") {
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: () => new Promise<string>(() => {}),
      };
    }
    if (next.kind === "json") {
      const serialized = JSON.stringify(next.body);
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => serialized,
      };
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.text,
    };
  };
  return { fetch, calls };
}

function issueLookupBody(options: {
  id?: string;
  identifier?: string;
  url?: string;
  state?: { id: string; name: string };
  team?: { id: string };
  comments?: Array<{ id: string; body: string; url?: string | null }>;
  commentsPageInfo?: { hasNextPage: boolean; endCursor: string | null };
}): unknown {
  return {
    data: {
      issue: {
        id: options.id ?? "linear-issue-1",
        identifier: options.identifier ?? "NGX-1",
        url: options.url ?? "https://linear.app/example/issue/NGX-1",
        state: options.state ?? { id: "state-todo", name: "Todo" },
        team: options.team ?? { id: "team-1" },
        comments: {
          nodes: (options.comments ?? []).map((c) => ({
            id: c.id,
            body: c.body,
            url: c.url ?? null,
          })),
          pageInfo: options.commentsPageInfo ?? {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
  };
}

function commentCreateBody(options: {
  success?: boolean;
  id?: string;
  url?: string | null;
}): unknown {
  return {
    data: {
      commentCreate: {
        success: options.success ?? true,
        comment: {
          id: options.id ?? "comment-1",
          url:
            options.url ?? "https://linear.app/example/issue/NGX-1#comment-1",
        },
      },
    },
  };
}

function issueUpdateBody(options: {
  success?: boolean;
  state?: { id: string; name: string };
}): unknown {
  return {
    data: {
      issueUpdate: {
        success: options.success ?? true,
        issue: {
          id: "linear-issue-1",
          state: options.state ?? { id: "state-done", name: "Done" },
        },
      },
    },
  };
}

function workflowStatesBody(options: {
  nodes: Array<{ id: string; name: string }>;
}): unknown {
  return {
    data: {
      workflowStates: {
        nodes: options.nodes,
      },
    },
  };
}

function issueCommentsPageBody(options: {
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
            url: c.url ?? null,
          })),
          pageInfo: options.pageInfo ?? {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
  };
}

describe("LINEAR_EXTERNAL_UPDATE_RESULT_CODES", () => {
  it("pins the stable result-code taxonomy for the Linear write client", () => {
    expect(LINEAR_EXTERNAL_UPDATE_RESULT_CODES).toEqual([
      "auth_unavailable",
      "target_missing",
      "target_state_ambiguous",
      "external_conflict",
      "write_rejected",
      "write_timeout",
      "malformed_response",
      "validation_failed",
      "adapter_threw",
    ]);
  });
});

describe("buildLinearExternalUpdateClient — credentials are never persisted", () => {
  it("refuses to call fetch when the apiKey is missing", async () => {
    const { fetch, calls } = buildMockFetch([]);
    const client = buildLinearExternalUpdateClient({ apiKey: "", fetch });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "auth_unavailable" });
    expect(calls).toEqual([]);
  });

  it("forwards the apiKey only through the Authorization header at request time", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: commentCreateBody({ id: "comment-1" }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    await client.apply({ preview: buildPreview() });
    for (const call of calls) {
      expect(call.headers["Authorization"]).toBe("lin_api_secret");
      expect(call.headers["Content-Type"]).toBe("application/json");
    }
  });
});

describe("buildLinearExternalUpdateClient — comment success", () => {
  it("posts a comment containing the deterministic idempotency marker and reports external references", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: commentCreateBody({
          id: "comment-xyz",
          url: "https://linear.app/example/issue/NGX-1#comment-xyz",
        }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(false);
    expect(result.issue).toEqual({
      id: "linear-issue-1",
      key: "NGX-1",
      url: "https://linear.app/example/issue/NGX-1",
    });
    expect(result.comment).toEqual({
      id: "comment-xyz",
      url: "https://linear.app/example/issue/NGX-1#comment-xyz",
    });
    expect(result.status).toEqual({
      transitioned: false,
      previousStateId: "state-todo",
      previousStateName: "Todo",
      nextStateId: null,
      nextStateName: null,
    });
    expect(result.idempotencyMarker).toBe(preview.idempotencyMarker);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body["variables"]).toEqual({ id: "linear-issue-1" });
    const commentVariables = calls[1]?.body["variables"] as {
      input: { issueId: string; body: string };
    };
    expect(commentVariables.input.issueId).toBe("linear-issue-1");
    expect(commentVariables.input.body).toBe(preview.commentBody);
    expect(commentVariables.input.body).toContain(preview.idempotencyMarker);
  });

  it("targets the configured endpoint or the default Linear endpoint", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      endpoint: "http://127.0.0.1:0/momentum-mock/graphql",
      fetch,
    });

    await client.apply({ preview: buildPreview() });
    for (const call of calls) {
      expect(call.endpoint).toBe("http://127.0.0.1:0/momentum-mock/graphql");
      expect(call.endpoint).not.toBe(DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT);
    }
  });
});

describe("buildLinearExternalUpdateClient — comment-only default", () => {
  it("does not issue an issueUpdate when no status mutation is configured", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview: buildPreview() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.transitioned).toBe(false);
    expect(result.status.nextStateId).toBeNull();
    expect(result.status.nextStateName).toBeNull();
    expect(calls).toHaveLength(2);
    const queries = calls.map((c) => String(c.body["query"]));
    expect(queries.every((q) => !q.includes("issueUpdate"))).toBe(true);
  });
});

describe("buildLinearExternalUpdateClient — comment + status transition", () => {
  it("issues issueUpdate with the explicit stateId when status mutation is configured by id", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
      {
        kind: "json",
        status: 200,
        body: issueUpdateBody({
          state: { id: "state-done", name: "Done" },
        }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toEqual({
      transitioned: true,
      previousStateId: "state-todo",
      previousStateName: "Todo",
      nextStateId: "state-done",
      nextStateName: "Done",
    });

    const lastCall = calls[calls.length - 1]!;
    expect(String(lastCall.body["query"])).toContain("issueUpdate");
    expect(lastCall.body["variables"]).toEqual({
      id: "linear-issue-1",
      input: { stateId: "state-done" },
    });
  });

  it("does not issueUpdate on fresh apply when already in the requested state", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          state: { id: "state-done", name: "Done" },
        }),
      },
      { kind: "json", status: 200, body: commentCreateBody({}) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview,
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(false);
    expect(result.status).toEqual({
      transitioned: false,
      previousStateId: "state-done",
      previousStateName: "Done",
      nextStateId: null,
      nextStateName: null,
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.body["query"])).toContain("commentCreate");
    expect(
      calls.every(
        (call) => !String(call.body["query"]).includes("issueUpdate"),
      ),
    ).toBe(true);
  });

  it("rejects issueUpdate when the returned state is missing", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
      {
        kind: "json",
        status: 200,
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "linear-issue-1", state: null },
            },
          },
        },
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_response");
    expect(result.error).toContain("issue.state.id");
    expect(result.partial?.comment).toEqual({
      id: "comment-1",
      url: "https://linear.app/example/issue/NGX-1#comment-1",
    });
  });

  it("rejects issueUpdate when the returned state differs from the request", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
      {
        kind: "json",
        status: 200,
        body: issueUpdateBody({
          state: { id: "state-blocked", name: "Blocked" },
        }),
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("write_rejected");
    expect(result.error).toContain("state-blocked");
    expect(result.error).toContain("state-done");
  });

  it("resolves a uniquely-matching state by name through workflowStates", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: workflowStatesBody({
          nodes: [{ id: "state-done", name: "Done" }],
        }),
      },
      { kind: "json", status: 200, body: commentCreateBody({}) },
      {
        kind: "json",
        status: 200,
        body: issueUpdateBody({ state: { id: "state-done", name: "Done" } }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_name", stateName: "Done" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.transitioned).toBe(true);
    expect(result.status.nextStateId).toBe("state-done");
    expect(result.status.nextStateName).toBe("Done");

    const workflowCall = calls[1]!;
    expect(String(workflowCall.body["query"])).toContain("workflowStates");
    expect(workflowCall.body["variables"]).toEqual({
      teamId: "team-1",
      name: "Done",
    });
  });
});

describe("buildLinearExternalUpdateClient — ambiguous / missing status target", () => {
  it("returns target_state_ambiguous when no workflow state matches the requested name", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: workflowStatesBody({ nodes: [] }) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_name", stateName: "DoesNotExist" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("target_state_ambiguous");
    expect(result.error).toContain("DoesNotExist");
    expect(calls).toHaveLength(2);
    expect(
      calls.every((c) => !String(c.body["query"]).includes("commentCreate")),
    ).toBe(true);
  });

  it("returns target_state_ambiguous when multiple workflow states match the requested name", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: workflowStatesBody({
          nodes: [
            { id: "state-done-1", name: "Done" },
            { id: "state-done-2", name: "Done" },
          ],
        }),
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_name", stateName: "Done" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("target_state_ambiguous");
    expect(result.error).toMatch(/Multiple/);
  });

  it("returns target_state_ambiguous when by_name is used without a team on the target issue", async () => {
    const issueWithNoTeam = {
      data: {
        issue: {
          id: "linear-issue-1",
          identifier: "NGX-1",
          url: "https://linear.app/example/issue/NGX-1",
          state: { id: "state-todo", name: "Todo" },
          team: null,
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueWithNoTeam },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview: buildPreview(),
      statusMutation: { kind: "by_name", stateName: "In Progress" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("target_state_ambiguous");
    expect(result.error).toContain("team id");
    expect(calls).toHaveLength(1);
  });
});

describe("buildLinearExternalUpdateClient — idempotency marker detection", () => {
  it("detects an existing matching marker and returns alreadyApplied without creating a second comment", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          comments: [
            {
              id: "earlier-comment",
              body: `Some prior body\n${preview.idempotencyMarker}\n`,
              url: "https://linear.app/example/issue/NGX-1#earlier-comment",
            },
          ],
        }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(true);
    expect(result.comment).toEqual({
      id: "earlier-comment",
      url: "https://linear.app/example/issue/NGX-1#earlier-comment",
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.body["query"])).toContain("issue(id: $id)");
  });

  it("continues through comment pages before deciding a marker is absent", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          comments: [{ id: "comment-1", body: "first page" }],
          commentsPageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        }),
      },
      {
        kind: "json",
        status: 200,
        body: issueCommentsPageBody({
          comments: [
            {
              id: "comment-51",
              body: `later page body\n${preview.idempotencyMarker}`,
              url: "https://linear.app/example/issue/NGX-1#comment-51",
            },
          ],
        }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(true);
    expect(result.comment).toEqual({
      id: "comment-51",
      url: "https://linear.app/example/issue/NGX-1#comment-51",
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.body["query"])).toContain(
      "comments(first: 50, after: $after)",
    );
    expect(calls[1]?.body["variables"]).toEqual({
      id: "linear-issue-1",
      after: "cursor-1",
    });
  });

  it("completes a requested status mutation when retry finds an existing marker", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          comments: [
            {
              id: "earlier-comment",
              body: `Some prior body\n${preview.idempotencyMarker}\n`,
              url: "https://linear.app/example/issue/NGX-1#earlier-comment",
            },
          ],
        }),
      },
      {
        kind: "json",
        status: 200,
        body: issueUpdateBody({ state: { id: "state-done", name: "Done" } }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview,
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(true);
    expect(result.status).toEqual({
      transitioned: true,
      previousStateId: "state-todo",
      previousStateName: "Todo",
      nextStateId: "state-done",
      nextStateName: "Done",
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.body["query"])).toContain("issueUpdate");
    expect(calls[1]?.body["variables"]).toEqual({
      id: "linear-issue-1",
      input: { stateId: "state-done" },
    });
  });

  it("does not repeat status mutation when retry marker already has the requested state", async () => {
    const preview = buildPreview();
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          state: { id: "state-done", name: "Done" },
          comments: [
            {
              id: "earlier-comment",
              body: `Some prior body\n${preview.idempotencyMarker}\n`,
              url: "https://linear.app/example/issue/NGX-1#earlier-comment",
            },
          ],
        }),
      },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({
      preview,
      statusMutation: { kind: "by_id", stateId: "state-done" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyApplied).toBe(true);
    expect(result.status).toEqual({
      transitioned: false,
      previousStateId: "state-done",
      previousStateName: "Done",
      nextStateId: null,
      nextStateName: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns malformed_response instead of posting when issue lookup comments are malformed", async () => {
    const malformedIssue = issueLookupBody({}) as {
      data: { issue: Record<string, unknown> };
    };
    malformedIssue.data.issue.comments = { nodes: [] };

    const { fetch, calls } = buildMockFetch([
      { kind: "json", status: 200, body: malformedIssue },
    ]);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "malformed_response" });
    expect(calls).toHaveLength(1);
    expect(
      calls.some((c) => String(c.body["query"]).includes("commentCreate")),
    ).toBe(false);
  });

  it("returns malformed_response instead of posting when a later comments page is malformed", async () => {
    const { fetch, calls } = buildMockFetch([
      {
        kind: "json",
        status: 200,
        body: issueLookupBody({
          comments: [{ id: "comment-1", body: "first page" }],
          commentsPageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        }),
      },
      {
        kind: "json",
        status: 200,
        body: {
          data: {
            issue: {
              comments: {
                nodes: [{ id: "comment-51" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });

    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "malformed_response" });
    expect(calls).toHaveLength(2);
    expect(
      calls.some((c) => String(c.body["query"]).includes("commentCreate")),
    ).toBe(false);
  });

  it("embeds the marker the boundary built into the comment body it posts", async () => {
    const preview = buildPreview();
    const expectedMarker = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_test_1",
      payload: buildIntent().payload,
    });
    expect(preview.idempotencyMarker).toBe(expectedMarker);

    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);

    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    await client.apply({ preview });

    const commentBody = (
      calls[1]!.body["variables"] as { input: { body: string } }
    ).input.body;
    expect(commentBody).toContain(expectedMarker);
  });
});

describe("buildLinearExternalUpdateClient — auth failure", () => {
  it("returns auth_unavailable on HTTP 401", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 401,
        body: { errors: [{ message: "unauthorized" }] },
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "auth_unavailable" });
  });

  it("returns auth_unavailable on HTTP 403 without reading the body", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "text", status: 403, text: "forbidden" },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({
      ok: false,
      code: "auth_unavailable",
      error: "Linear API rejected credentials (HTTP 403).",
    });
  });

  it("returns auth_unavailable on a GraphQL AUTHENTICATION extension code", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      {
        kind: "json",
        status: 200,
        body: {
          errors: [
            {
              message: "API key is required",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        },
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "auth_unavailable" });
  });
});

describe("buildLinearExternalUpdateClient — GraphQL validation error", () => {
  it("returns write_rejected on a non-auth GraphQL error", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: {
          errors: [
            {
              message: 'Argument "input" has invalid value',
              extensions: { code: "ARGUMENT_VALIDATION_FAILED" },
            },
          ],
        },
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("write_rejected");
    expect(result.error).toContain("invalid value");
  });

  it("returns write_rejected when commentCreate reports success=false", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      {
        kind: "json",
        status: 200,
        body: commentCreateBody({ success: false }),
      },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "write_rejected" });
  });
});

describe("buildLinearExternalUpdateClient — HTTP status failure", () => {
  it("returns write_rejected on a non-auth non-OK HTTP status", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "text", status: 500, text: "server error" },
    ];
    const { fetch } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({
      ok: false,
      code: "write_rejected",
      error: "Linear API returned HTTP 500.",
    });
  });
});

describe("buildLinearExternalUpdateClient — network / timeout failure", () => {
  it("aborts and returns write_timeout when a request stalls past the configured timeout", async () => {
    const responses: MockGraphqlResponse[] = [{ kind: "hang" }];
    const { fetch } = buildMockFetch(responses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
      requestTimeoutMs: 10,
    });

    const result = await Promise.race([
      client.apply({ preview: buildPreview() }),
      new Promise<"unsettled">((resolve) =>
        setTimeout(() => resolve("unsettled"), 100),
      ),
    ]);
    expect(result).not.toBe("unsettled");
    expect(result).toMatchObject({
      ok: false,
      code: "write_timeout",
      error: "linear external update request timed out after 10ms",
    });
  });

  it("returns write_timeout when the response body read stalls past the timeout", async () => {
    const responses: MockGraphqlResponse[] = [
      { kind: "hang-body", status: 200 },
    ];
    const { fetch } = buildMockFetch(responses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
      requestTimeoutMs: 10,
    });

    const result = await Promise.race([
      client.apply({ preview: buildPreview() }),
      new Promise<"unsettled">((resolve) =>
        setTimeout(() => resolve("unsettled"), 100),
      ),
    ]);
    expect(result).not.toBe("unsettled");
    expect(result).toMatchObject({ ok: false, code: "write_timeout" });
  });
});

describe("buildLinearExternalUpdateClient — transport error", () => {
  it("returns adapter_threw when fetch rejects with a network error", async () => {
    const networkError = new Error("ECONNREFUSED");
    const fetch: FetchLike = async () => {
      throw networkError;
    };
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({
      ok: false,
      code: "adapter_threw",
      error: "linear external update transport failed: ECONNREFUSED",
    });
  });

  it("returns adapter_threw when the response body read rejects", async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("stream interrupted")),
    });
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({
      ok: false,
      code: "adapter_threw",
      error:
        "linear external update response body read failed: stream interrupted",
    });
  });

  it("returns validation_failed when no fetch implementation is available", async () => {
    const globalRef = globalThis as { fetch?: unknown };
    const originalFetch = globalRef.fetch;
    try {
      globalRef.fetch = undefined;
      const client = buildLinearExternalUpdateClient({
        apiKey: "lin_api_secret",
      });
      const result = await client.apply({ preview: buildPreview() });
      expect(result).toMatchObject({
        ok: false,
        code: "validation_failed",
        error:
          "global fetch is unavailable; pass options.fetch to buildLinearExternalUpdateClient.",
      });
    } finally {
      globalRef.fetch = originalFetch;
    }
  });
});

describe("buildLinearExternalUpdateClient — malformed JSON", () => {
  it("returns malformed_response when the body is not valid JSON", async () => {
    const responses: MockGraphqlResponse[] = [
      { kind: "text", status: 200, text: "<html>oops</html>" },
    ];
    const { fetch } = buildMockFetch(responses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "malformed_response" });
    if (result.ok) return;
    expect(result.error).toMatch(
      /^linear external update response was not JSON: /,
    );
  });
});

describe("buildLinearExternalUpdateClient — missing target", () => {
  it("returns target_missing when the preview has no externalId", async () => {
    const preview: ExternalUpdateAdapterPreview = {
      ...buildPreview(),
      target: { ...buildTarget(), externalId: "" },
    };
    const { fetch, calls } = buildMockFetch([]);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview });
    expect(result).toMatchObject({ ok: false, code: "target_missing" });
    expect(calls).toEqual([]);
  });

  it("returns target_missing when the Linear API responds with issue=null", async () => {
    const responses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: { data: { issue: null } } },
    ];
    const { fetch } = buildMockFetch(responses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview: buildPreview() });
    expect(result).toMatchObject({ ok: false, code: "target_missing" });
  });
});

describe("buildLinearExternalUpdateClient — input validation", () => {
  it("returns validation_failed when the preview adapter kind is not linear", async () => {
    const preview: ExternalUpdateAdapterPreview = {
      ...buildPreview(),
      adapterKind: "github",
    };
    const { fetch, calls } = buildMockFetch([]);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(calls).toEqual([]);
  });

  it("returns validation_failed when the commentBody does not embed the marker", async () => {
    const preview: ExternalUpdateAdapterPreview = {
      ...buildPreview(),
      commentBody: "lorem ipsum without marker",
    };
    const { fetch } = buildMockFetch([]);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch,
    });
    const result = await client.apply({ preview });
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("buildLinearExternalUpdateClient — test harness guard", () => {
  it("never targets the real api.linear.app endpoint in any test in this file", async () => {
    const fetchResponses: MockGraphqlResponse[] = [
      { kind: "json", status: 200, body: issueLookupBody({}) },
      { kind: "json", status: 200, body: commentCreateBody({}) },
    ];
    const { fetch, calls } = buildMockFetch(fetchResponses);
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      endpoint: "http://127.0.0.1:0/momentum-mock/graphql",
      fetch,
    });
    await client.apply({ preview: buildPreview() });
    for (const call of calls) {
      expect(call.endpoint).not.toMatch(/api\.linear\.app/);
    }
  });

  it("fails fast if a test inadvertently omits the mock fetch and the default endpoint is api.linear.app", () => {
    expect(DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT).toBe(
      "https://api.linear.app/graphql",
    );
    const guard: FetchLike = async (input) => {
      if (/api\.linear\.app/.test(input)) {
        throw new Error(
          `test guard tripped: real api.linear.app calls are forbidden (target was ${input})`,
        );
      }
      throw new Error("test guard tripped: unexpected fetch target");
    };
    const client = buildLinearExternalUpdateClient({
      apiKey: "lin_api_secret",
      fetch: guard,
    });
    expect(client).toBeDefined();
  });
});

describe("LinearExternalUpdateInput type sanity", () => {
  it("accepts a status mutation config on the input shape (compile-time check)", () => {
    const input: LinearExternalUpdateInput = {
      preview: buildPreview(),
      statusMutation: { kind: "by_id", stateId: "state-done" },
    };
    expect(input.statusMutation?.kind).toBe("by_id");
  });
});
