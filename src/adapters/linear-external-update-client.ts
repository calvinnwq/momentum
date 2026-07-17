/**
 * Linear external update client.
 *
 * Performs the credential-handling Linear GraphQL mutations that sit behind the
 * external update adapter boundary. The client is intentionally narrow:
 *
 *  - It does not read or persist credentials. The caller supplies an
 *    `apiKey` it sourced from operator-controlled env/config.
 *  - It does not own preview/comment-body rendering. The caller passes the
 *    deterministic preview produced by `previewExternalUpdate` so the same
 *    idempotency marker, comment body, and target reference flow through.
 *  - It exposes a single `apply` entry point. Comment-only is the default; the
 *    caller opts into a status transition by passing an explicit
 *    `statusMutation` config. The status mutation is guarded by deterministic
 *    target-state resolution — ambiguity never guesses.
 *  - It detects an already-applied write by grepping the issue's existing
 *    comments for the idempotency marker before any new mutation is issued.
 *  - It maps HTTP, GraphQL, auth, timeout/network, malformed JSON, missing
 *    target, ambiguous status, and validation failures to stable result codes.
 *
 * The CLI execution path (`intent apply --external-apply`) is wired
 * separately, together with the audit ledger.
 * Tests inject a mock fetch and the adapter-test contract prohibits real
 * `api.linear.app` calls from this slice's tests.
 */

import type { ExternalUpdateAdapterPreview } from "./external-update-adapter.js";
import {
  postLinearGraphql,
  type LinearGraphqlFetchLike,
} from "./linear-graphql-transport.js";

export const DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT =
  "https://api.linear.app/graphql";
export const DEFAULT_LINEAR_EXTERNAL_UPDATE_REQUEST_TIMEOUT_MS = 30_000;

export type FetchLike = LinearGraphqlFetchLike;

export type LinearExternalUpdateClientOptions = {
  apiKey?: string | null;
  endpoint?: string;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
};

export type LinearStatusMutationConfig =
  { kind: "by_id"; stateId: string } | { kind: "by_name"; stateName: string };

export type LinearExternalUpdateInput = {
  preview: ExternalUpdateAdapterPreview;
  statusMutation?: LinearStatusMutationConfig | null;
};

export const LINEAR_EXTERNAL_UPDATE_RESULT_CODES = Object.freeze([
  "auth_unavailable",
  "target_missing",
  "target_state_ambiguous",
  "external_conflict",
  "write_rejected",
  "write_timeout",
  "malformed_response",
  "validation_failed",
  "adapter_threw",
] as const);

export type LinearExternalUpdateResultCode =
  (typeof LINEAR_EXTERNAL_UPDATE_RESULT_CODES)[number];

export type LinearExternalUpdateIssueRef = {
  id: string;
  key: string | null;
  url: string | null;
};

export type LinearExternalUpdateCommentRef = {
  id: string;
  url: string | null;
};

export type LinearExternalUpdateStatusOutcome = {
  transitioned: boolean;
  previousStateId: string | null;
  previousStateName: string | null;
  nextStateId: string | null;
  nextStateName: string | null;
};

export type LinearExternalUpdateSuccess = {
  ok: true;
  alreadyApplied: boolean;
  issue: LinearExternalUpdateIssueRef;
  comment: LinearExternalUpdateCommentRef;
  status: LinearExternalUpdateStatusOutcome;
  idempotencyMarker: string;
};

export type LinearExternalUpdatePartial = {
  comment?: LinearExternalUpdateCommentRef;
  issue?: LinearExternalUpdateIssueRef;
};

export type LinearExternalUpdateError = {
  ok: false;
  code: LinearExternalUpdateResultCode;
  error: string;
  partial?: LinearExternalUpdatePartial;
};

export type LinearExternalUpdateResult =
  LinearExternalUpdateSuccess | LinearExternalUpdateError;

export type LinearExternalUpdateClient = {
  apply: (
    input: LinearExternalUpdateInput,
  ) => Promise<LinearExternalUpdateResult>;
};

const ISSUE_LOOKUP_QUERY = `
query MomentumExternalUpdateIssueLookup($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
    state { id name }
    team { id }
    comments(first: 50) {
      nodes { id body url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

const ISSUE_COMMENTS_PAGE_QUERY = `
query MomentumExternalUpdateIssueCommentsPage($id: String!, $after: String!) {
  issue(id: $id) {
    comments(first: 50, after: $after) {
      nodes { id body url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

const WORKFLOW_STATE_LOOKUP_QUERY = `
query MomentumExternalUpdateWorkflowStateLookup($teamId: ID!, $name: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
    nodes { id name }
  }
}`.trim();

const COMMENT_CREATE_MUTATION = `
mutation MomentumExternalUpdateCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`.trim();

const ISSUE_STATE_UPDATE_MUTATION = `
mutation MomentumExternalUpdateIssueStateUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id state { id name } }
  }
}`.trim();

type GraphqlResponse = {
  status: number;
  body: unknown;
};

type GraphqlTransportFailure = {
  code:
    | "auth_unavailable"
    | "write_rejected"
    | "write_timeout"
    | "malformed_response"
    | "adapter_threw";
  error: string;
};

type GraphqlTransportResult =
  | { ok: true; response: GraphqlResponse }
  | { ok: false; failure: GraphqlTransportFailure };

export function buildLinearExternalUpdateClient(
  options: LinearExternalUpdateClientOptions,
): LinearExternalUpdateClient {
  const apiKey = (options.apiKey ?? "").trim();
  const endpoint = options.endpoint ?? DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT;
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const fetchImpl =
    options.fetch ?? (globalThis.fetch as FetchLike | undefined);

  return {
    async apply(
      input: LinearExternalUpdateInput,
    ): Promise<LinearExternalUpdateResult> {
      const validation = validateApplyInput(input);
      if (validation) return validation;

      if (apiKey.length === 0) {
        return authUnavailable(
          "LINEAR_API_KEY is unset; linear external update needs a credential.",
        );
      }
      if (!fetchImpl) {
        return {
          ok: false,
          code: "validation_failed",
          error:
            "global fetch is unavailable; pass options.fetch to buildLinearExternalUpdateClient.",
        };
      }

      const { preview } = input;
      const issueId = preview.target.externalId;

      const issueLookup = await sendGraphql(
        fetchImpl,
        endpoint,
        apiKey,
        requestTimeoutMs,
        ISSUE_LOOKUP_QUERY,
        { id: issueId },
      );
      if (!issueLookup.ok) {
        return mapTransportFailure(issueLookup.failure);
      }

      const interpretedIssue = interpretIssueLookup(issueLookup.response);
      if (!interpretedIssue.ok) {
        return interpretedIssue.error;
      }
      const { issue, commentsPage, teamId } = interpretedIssue;

      let resolvedStateId: string | null = null;
      let resolvedStateName: string | null = null;
      if (input.statusMutation) {
        const resolution = await resolveTargetState(
          fetchImpl,
          endpoint,
          apiKey,
          requestTimeoutMs,
          teamId,
          input.statusMutation,
        );
        if (!resolution.ok) {
          return { ...resolution.error, partial: { issue } };
        }
        resolvedStateId = resolution.stateId;
        resolvedStateName = resolution.stateName;
      }

      const existingResult = await findExistingMarkerComment(
        fetchImpl,
        endpoint,
        apiKey,
        requestTimeoutMs,
        issueId,
        commentsPage,
        preview.idempotencyMarker,
      );
      if (!existingResult.ok) {
        return { ...existingResult.error, partial: { issue } };
      }
      const existing = existingResult.comment;
      if (existing) {
        let statusOutcome = buildUnchangedStatus(interpretedIssue.state);
        if (resolvedStateId && interpretedIssue.state.id !== resolvedStateId) {
          const updateResult = await postIssueStateUpdate(
            fetchImpl,
            endpoint,
            apiKey,
            requestTimeoutMs,
            issueId,
            resolvedStateId,
          );
          if (!updateResult.ok) {
            return {
              ...updateResult.error,
              partial: { issue, comment: existing },
            };
          }
          statusOutcome = {
            transitioned: true,
            previousStateId: interpretedIssue.state.id,
            previousStateName: interpretedIssue.state.name,
            nextStateId: updateResult.state.id ?? resolvedStateId,
            nextStateName: updateResult.state.name ?? resolvedStateName,
          };
        }
        return {
          ok: true,
          alreadyApplied: true,
          issue,
          comment: existing,
          status: statusOutcome,
          idempotencyMarker: preview.idempotencyMarker,
        };
      }

      const commentResult = await postComment(
        fetchImpl,
        endpoint,
        apiKey,
        requestTimeoutMs,
        issueId,
        preview.commentBody,
      );
      if (!commentResult.ok) {
        return { ...commentResult.error, partial: { issue } };
      }
      const comment = commentResult.comment;

      let statusOutcome = buildUnchangedStatus(interpretedIssue.state);

      if (resolvedStateId && interpretedIssue.state.id !== resolvedStateId) {
        const updateResult = await postIssueStateUpdate(
          fetchImpl,
          endpoint,
          apiKey,
          requestTimeoutMs,
          issueId,
          resolvedStateId,
        );
        if (!updateResult.ok) {
          return {
            ...updateResult.error,
            partial: { issue, comment },
          };
        }
        statusOutcome = {
          transitioned: true,
          previousStateId: interpretedIssue.state.id,
          previousStateName: interpretedIssue.state.name,
          nextStateId: updateResult.state.id ?? resolvedStateId,
          nextStateName: updateResult.state.name ?? resolvedStateName,
        };
      }

      return {
        ok: true,
        alreadyApplied: false,
        issue,
        comment,
        status: statusOutcome,
        idempotencyMarker: preview.idempotencyMarker,
      };
    },
  };
}

function validateApplyInput(
  input: LinearExternalUpdateInput,
): LinearExternalUpdateError | null {
  const { preview } = input;
  if (preview.adapterKind !== "linear") {
    return {
      ok: false,
      code: "validation_failed",
      error: `linear external update client requires preview.adapterKind="linear" (got "${preview.adapterKind}").`,
    };
  }
  if (
    typeof preview.target.externalId !== "string" ||
    preview.target.externalId.length === 0
  ) {
    return {
      ok: false,
      code: "target_missing",
      error:
        "linear external update client requires preview.target.externalId.",
    };
  }
  if (
    typeof preview.commentBody !== "string" ||
    preview.commentBody.trim().length === 0
  ) {
    return {
      ok: false,
      code: "validation_failed",
      error:
        "linear external update client requires a non-empty preview.commentBody.",
    };
  }
  if (
    typeof preview.idempotencyMarker !== "string" ||
    preview.idempotencyMarker.length === 0
  ) {
    return {
      ok: false,
      code: "validation_failed",
      error:
        "linear external update client requires a non-empty preview.idempotencyMarker.",
    };
  }
  if (!preview.commentBody.includes(preview.idempotencyMarker)) {
    return {
      ok: false,
      code: "validation_failed",
      error:
        "linear external update client requires preview.commentBody to embed preview.idempotencyMarker.",
    };
  }
  if (input.statusMutation) {
    const mut = input.statusMutation;
    if (mut.kind === "by_id") {
      if (typeof mut.stateId !== "string" || mut.stateId.length === 0) {
        return {
          ok: false,
          code: "validation_failed",
          error: "statusMutation.stateId must be a non-empty string.",
        };
      }
    } else if (mut.kind === "by_name") {
      if (typeof mut.stateName !== "string" || mut.stateName.length === 0) {
        return {
          ok: false,
          code: "validation_failed",
          error: "statusMutation.stateName must be a non-empty string.",
        };
      }
    } else {
      return {
        ok: false,
        code: "validation_failed",
        error: `statusMutation.kind must be "by_id" or "by_name" (got "${(mut as { kind: string }).kind}").`,
      };
    }
  }
  return null;
}

type IssueState = { id: string | null; name: string | null };

type InterpretedIssue =
  | {
      ok: true;
      issue: LinearExternalUpdateIssueRef;
      state: IssueState;
      teamId: string | null;
      commentsPage: CommentsPage;
    }
  | {
      ok: false;
      error: LinearExternalUpdateError;
    };

function interpretIssueLookup(response: GraphqlResponse): InterpretedIssue {
  const dataIssue = readGraphqlData(response.body, ["issue"]);
  if (dataIssue === null) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_missing",
        error: "Linear issue lookup returned no issue.",
      },
    };
  }
  if (typeof dataIssue !== "object" || Array.isArray(dataIssue)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear issue lookup returned a non-object issue payload.",
      },
    };
  }
  const record = dataIssue as Record<string, unknown>;
  const id = optionalString(record["id"]);
  if (!id) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear issue lookup is missing issue.id.",
      },
    };
  }
  const identifier = optionalString(record["identifier"]);
  const url = optionalString(record["url"]);
  const state = readState(record["state"]);
  const team = readTeam(record["team"]);
  const commentsPageResult = readCommentsPage(
    record["comments"],
    "Linear issue lookup",
  );
  if (!commentsPageResult.ok) {
    return { ok: false, error: commentsPageResult.error };
  }
  return {
    ok: true,
    issue: { id, key: identifier ?? null, url: url ?? null },
    state,
    teamId: team,
    commentsPage: commentsPageResult.page,
  };
}

type CommentRecord = { id: string; body: string; url: string | null };

type CommentsPage = {
  comments: ReadonlyArray<CommentRecord>;
  hasNextPage: boolean;
  endCursor: string | null;
};

type FindExistingMarkerCommentResult =
  | { ok: true; comment: LinearExternalUpdateCommentRef | null }
  | { ok: false; error: LinearExternalUpdateError };

async function findExistingMarkerComment(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  issueId: string,
  firstPage: CommentsPage,
  marker: string,
): Promise<FindExistingMarkerCommentResult> {
  let page = firstPage;
  for (;;) {
    const found = findMarkerInComments(page.comments, marker);
    if (found) return { ok: true, comment: found };
    if (!page.hasNextPage) return { ok: true, comment: null };
    if (!page.endCursor) {
      return {
        ok: false,
        error: {
          ok: false,
          code: "malformed_response",
          error:
            "Linear comments pageInfo indicated another page without endCursor.",
        },
      };
    }
    const nextPage = await fetchIssueCommentsPage(
      fetchImpl,
      endpoint,
      apiKey,
      requestTimeoutMs,
      issueId,
      page.endCursor,
    );
    if (!nextPage.ok) return nextPage;
    page = nextPage.page;
  }
}

function findMarkerInComments(
  comments: ReadonlyArray<CommentRecord>,
  marker: string,
): LinearExternalUpdateCommentRef | null {
  for (const comment of comments) {
    if (comment.body.includes(marker)) {
      return { id: comment.id, url: comment.url };
    }
  }
  return null;
}

type FetchIssueCommentsPageResult =
  | { ok: true; page: CommentsPage }
  | { ok: false; error: LinearExternalUpdateError };

async function fetchIssueCommentsPage(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  issueId: string,
  after: string,
): Promise<FetchIssueCommentsPageResult> {
  const transport = await sendGraphql(
    fetchImpl,
    endpoint,
    apiKey,
    requestTimeoutMs,
    ISSUE_COMMENTS_PAGE_QUERY,
    { id: issueId, after },
  );
  if (!transport.ok) {
    return { ok: false, error: mapTransportFailure(transport.failure) };
  }
  const rawIssue = readGraphqlData(transport.response.body, ["issue"]);
  if (rawIssue === null) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_missing",
        error: "Linear issue comments page lookup returned no issue.",
      },
    };
  }
  if (!rawIssue || typeof rawIssue !== "object" || Array.isArray(rawIssue)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error:
          "Linear issue comments page lookup returned a non-object issue payload.",
      },
    };
  }
  const commentsPageResult = readCommentsPage(
    (rawIssue as Record<string, unknown>)["comments"],
    "Linear issue comments page lookup",
  );
  if (!commentsPageResult.ok) {
    return { ok: false, error: commentsPageResult.error };
  }
  return { ok: true, page: commentsPageResult.page };
}

function buildUnchangedStatus(
  state: IssueState,
): LinearExternalUpdateStatusOutcome {
  return {
    transitioned: false,
    previousStateId: state.id,
    previousStateName: state.name,
    nextStateId: null,
    nextStateName: null,
  };
}

type ResolveTargetStateResult =
  | { ok: true; stateId: string; stateName: string | null }
  | { ok: false; error: LinearExternalUpdateError };

async function resolveTargetState(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  teamId: string | null,
  config: LinearStatusMutationConfig,
): Promise<ResolveTargetStateResult> {
  if (config.kind === "by_id") {
    return { ok: true, stateId: config.stateId, stateName: null };
  }

  if (!teamId) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_state_ambiguous",
        error: `Cannot resolve Linear workflow state "${config.stateName}" without a team id on the target issue.`,
      },
    };
  }

  const transport = await sendGraphql(
    fetchImpl,
    endpoint,
    apiKey,
    requestTimeoutMs,
    WORKFLOW_STATE_LOOKUP_QUERY,
    { teamId, name: config.stateName },
  );
  if (!transport.ok) {
    return { ok: false, error: mapTransportFailure(transport.failure) };
  }

  const nodes = readGraphqlData(transport.response.body, [
    "workflowStates",
    "nodes",
  ]);
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "Linear workflow state lookup is missing workflowStates.nodes.",
      },
    };
  }
  const matches: Array<{ id: string; name: string | null }> = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const id = optionalString(record["id"]);
    if (!id) continue;
    matches.push({ id, name: optionalString(record["name"]) ?? null });
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_state_ambiguous",
        error: `No Linear workflow state matched name "${config.stateName}" for team ${teamId}.`,
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "target_state_ambiguous",
        error: `Multiple (${matches.length}) Linear workflow states matched name "${config.stateName}" for team ${teamId}; refusing to guess.`,
      },
    };
  }
  const match = matches[0]!;
  return { ok: true, stateId: match.id, stateName: match.name };
}

type PostCommentResult =
  | {
      ok: true;
      comment: LinearExternalUpdateCommentRef;
    }
  | {
      ok: false;
      error: LinearExternalUpdateError;
    };

async function postComment(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  issueId: string,
  body: string,
): Promise<PostCommentResult> {
  const transport = await sendGraphql(
    fetchImpl,
    endpoint,
    apiKey,
    requestTimeoutMs,
    COMMENT_CREATE_MUTATION,
    { input: { issueId, body } },
  );
  if (!transport.ok) {
    return { ok: false, error: mapTransportFailure(transport.failure) };
  }
  const payload = readGraphqlData(transport.response.body, ["commentCreate"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "commentCreate response was not a JSON object.",
      },
    };
  }
  const record = payload as Record<string, unknown>;
  if (record["success"] !== true) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "write_rejected",
        error: "commentCreate.success was not true.",
      },
    };
  }
  const commentRecord = record["comment"];
  if (
    !commentRecord ||
    typeof commentRecord !== "object" ||
    Array.isArray(commentRecord)
  ) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "commentCreate response was missing comment payload.",
      },
    };
  }
  const commentObject = commentRecord as Record<string, unknown>;
  const id = optionalString(commentObject["id"]);
  if (!id) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "commentCreate response was missing comment.id.",
      },
    };
  }
  return {
    ok: true,
    comment: { id, url: optionalString(commentObject["url"]) ?? null },
  };
}

type PostIssueStateUpdateResult =
  | {
      ok: true;
      state: { id: string | null; name: string | null };
    }
  | {
      ok: false;
      error: LinearExternalUpdateError;
    };

async function postIssueStateUpdate(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  issueId: string,
  stateId: string,
): Promise<PostIssueStateUpdateResult> {
  const transport = await sendGraphql(
    fetchImpl,
    endpoint,
    apiKey,
    requestTimeoutMs,
    ISSUE_STATE_UPDATE_MUTATION,
    { id: issueId, input: { stateId } },
  );
  if (!transport.ok) {
    return { ok: false, error: mapTransportFailure(transport.failure) };
  }
  const payload = readGraphqlData(transport.response.body, ["issueUpdate"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "issueUpdate response was not a JSON object.",
      },
    };
  }
  const record = payload as Record<string, unknown>;
  if (record["success"] !== true) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "write_rejected",
        error: "issueUpdate.success was not true.",
      },
    };
  }
  const issueRecord = record["issue"];
  if (
    !issueRecord ||
    typeof issueRecord !== "object" ||
    Array.isArray(issueRecord)
  ) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "issueUpdate response was missing issue payload.",
      },
    };
  }
  const stateRecord = (issueRecord as Record<string, unknown>)["state"];
  const state = readState(stateRecord);
  if (!state.id) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "malformed_response",
        error: "issueUpdate response was missing issue.state.id.",
      },
    };
  }
  if (state.id !== stateId) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "write_rejected",
        error: `issueUpdate returned state "${state.id}" instead of requested state "${stateId}".`,
      },
    };
  }
  return { ok: true, state };
}

async function sendGraphql(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string,
  requestTimeoutMs: number,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlTransportResult> {
  const transport = await postLinearGraphql({
    fetch: fetchImpl,
    endpoint,
    apiKey,
    requestTimeoutMs,
    query,
    variables,
  });

  switch (transport.kind) {
    case "timeout":
      return {
        ok: false,
        failure: {
          code: "write_timeout",
          error: `linear external update request timed out after ${transport.timeoutMs}ms`,
        },
      };
    case "body_read_failed":
      return {
        ok: false,
        failure: {
          code: "adapter_threw",
          error: `linear external update response body read failed: ${describeError(transport.error)}`,
        },
      };
    case "request_failed":
      return {
        ok: false,
        failure: {
          code: "adapter_threw",
          error: `linear external update transport failed: ${describeError(transport.error)}`,
        },
      };
    case "http_error":
      if (transport.status === 401 || transport.status === 403) {
        return {
          ok: false,
          failure: {
            code: "auth_unavailable",
            error: `Linear API rejected credentials (HTTP ${transport.status}).`,
          },
        };
      }
      return {
        ok: false,
        failure: {
          code: "write_rejected",
          error: `Linear API returned HTTP ${transport.status}.`,
        },
      };
    case "invalid_json":
      return {
        ok: false,
        failure: {
          code: "malformed_response",
          error: `linear external update response was not JSON: ${describeError(transport.error)}`,
        },
      };
    case "success":
      break;
  }

  const graphqlErrors = readGraphqlErrors(transport.body);
  if (graphqlErrors) {
    const authCode = detectGraphqlAuthCode(graphqlErrors);
    if (authCode) {
      return {
        ok: false,
        failure: {
          code: "auth_unavailable",
          error: `Linear GraphQL auth rejected: ${describeGraphqlErrors(graphqlErrors)}`,
        },
      };
    }
    return {
      ok: false,
      failure: {
        code: "write_rejected",
        error: `Linear GraphQL errors: ${describeGraphqlErrors(graphqlErrors)}`,
      },
    };
  }
  return {
    ok: true,
    response: { status: transport.status, body: transport.body },
  };
}

function mapTransportFailure(
  failure: GraphqlTransportFailure,
): LinearExternalUpdateError {
  return {
    ok: false,
    code: failure.code,
    error: failure.error,
  };
}

function readGraphqlData(body: unknown, path: readonly string[]): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  let cursor: unknown = data;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function readGraphqlErrors(body: unknown): unknown[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const errors = (body as Record<string, unknown>)["errors"];
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors;
}

function detectGraphqlAuthCode(errors: unknown[]): "auth_unavailable" | null {
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const extensions = record["extensions"];
    const extCode =
      extensions && typeof extensions === "object" && !Array.isArray(extensions)
        ? (extensions as Record<string, unknown>)["code"]
        : undefined;
    if (typeof extCode === "string" && /AUTH/i.test(extCode)) {
      return "auth_unavailable";
    }
    const message = record["message"];
    if (
      typeof message === "string" &&
      /authentic|unauthor|forbid|not[\s_-]?authorized/i.test(message)
    ) {
      return "auth_unavailable";
    }
  }
  return null;
}

function describeGraphqlErrors(errors: unknown[]): string {
  const messages: string[] = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const message = (entry as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0)
      messages.push(message);
  }
  return messages.length > 0 ? messages.join("; ") : "<no message>";
}

function readState(raw: unknown): IssueState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { id: null, name: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    id: optionalString(record["id"]) ?? null,
    name: optionalString(record["name"]) ?? null,
  };
}

function readTeam(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return optionalString((raw as Record<string, unknown>)["id"]) ?? null;
}

type CommentsPageReadResult =
  | { ok: true; page: CommentsPage }
  | { ok: false; error: LinearExternalUpdateError };

function readCommentsPage(
  raw: unknown,
  context: string,
): CommentsPageReadResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return malformedCommentsPage(context, "is missing a comments connection");
  }
  const record = raw as Record<string, unknown>;
  const nodes = record["nodes"];
  if (!Array.isArray(nodes)) {
    return malformedCommentsPage(context, "comments.nodes is not an array");
  }

  const out: CommentRecord[] = [];
  for (const entry of nodes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return malformedCommentsPage(
        context,
        "comments.nodes contains a non-object node",
      );
    }
    const commentRecord = entry as Record<string, unknown>;
    const id = optionalString(commentRecord["id"]);
    const body = commentRecord["body"];
    if (!id || typeof body !== "string") {
      return malformedCommentsPage(
        context,
        "comments.nodes contains a node without a string id and body",
      );
    }
    out.push({
      id,
      body,
      url: optionalString(commentRecord["url"]) ?? null,
    });
  }

  const pageInfo = record["pageInfo"];
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) {
    return malformedCommentsPage(
      context,
      "comments.pageInfo is missing or invalid",
    );
  }
  const pageInfoRecord = pageInfo as Record<string, unknown>;
  const hasNextPage = pageInfoRecord["hasNextPage"];
  if (typeof hasNextPage !== "boolean") {
    return malformedCommentsPage(
      context,
      "comments.pageInfo.hasNextPage is not a boolean",
    );
  }
  const rawEndCursor = pageInfoRecord["endCursor"];
  if (
    rawEndCursor !== null &&
    rawEndCursor !== undefined &&
    typeof rawEndCursor !== "string"
  ) {
    return malformedCommentsPage(
      context,
      "comments.pageInfo.endCursor is not a string or null",
    );
  }

  return {
    ok: true,
    page: {
      comments: out,
      hasNextPage,
      endCursor:
        typeof rawEndCursor === "string" && rawEndCursor.length > 0
          ? rawEndCursor
          : null,
    },
  };
}

function malformedCommentsPage(
  context: string,
  detail: string,
): CommentsPageReadResult {
  return {
    ok: false,
    error: {
      ok: false,
      code: "malformed_response",
      error: `${context} returned a malformed comments page: ${detail}.`,
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function authUnavailable(message: string): LinearExternalUpdateError {
  return { ok: false, code: "auth_unavailable", error: message };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_LINEAR_EXTERNAL_UPDATE_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `linear external update request timeout must be a positive integer in milliseconds, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}
